/* 매매 타이밍 — 「매수·매도 타이밍 시그널 스펙」 규칙 엔진
   ① 추세 필터(최상위 관문) → ② 매수 신호 BUY-01~04 / 매도 신호 SELL-01~05 → ③ 손절가 먼저 → 수량(계좌 2% 손실·종목 30% 상한, 2회 분할)
   ④ 보유 중이면 「손절 > 매도 신호 > 관망 > 매수」 순서로 평가 ⑤ 최신 공시·뉴스·수급·공매도·일정까지 넣어 최종 결론(매수가·매도가·타이밍)
   시세: 일봉(보관 칸 live-cl/{code}.json, 장중 15분마다 오늘 봉 포함) + 실시간 현재가(/api/hoga, 장중 10초마다)로 오늘 봉을 바로 고쳐 다시 계산 */
'use strict';

const TM = { pane: null, sel: null, st: new Map(), ev: new Map(), co: new Map(), chart: null, busy: false, lastQ: 0, rot: 0 };
const TM_DEF = {
  trendMa: 20, slopeDays: 5,
  pbLo: 0.38, pbHi: 0.50, pbSurge: 12, supTol: 2.5,
  boVol: 3, boBody: 3, boLook: 60,
  swDry: 0.7, swRise: 1.3,
  osLo: 30, osHi: 40,
  spikeVol: 3, wickX: 2, rsiOB: 70,
  stop: 7, target: 14, trail: 10, trailTight: 5, maxPos: 30, maxLoss: 2, splits: 2,
  account: null,
};
const tmCfg = () => ({ ...TM_DEF, ...(store.get('tmCfg', {}) || {}) });
const tmAcct = () => { const c = tmCfg(); return c.account || (typeof S !== 'undefined' && S.capital) || 30000000; };

/* ── 호가 단위(2023년 이후 코스피·코스닥 공통) ── */
function tmTick(p) { return p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000; }
const tmDn = p => p == null ? null : Math.floor(p / tmTick(p)) * tmTick(p);           // 아래 호가로 (매수 지정가·손절가)
const tmUp = p => p == null ? null : Math.ceil(p / tmTick(p)) * tmTick(p);             // 위 호가로 (돌파 확인가)
const tmW = v => v == null ? '–' : fmt(Math.round(v)) + '원';
const tmP = (a, b) => a && b ? pct((a / b - 1) * 100, 1) : '';

/* ── 한국 시각 · 장 상태 · 휴장일 ── */
const TM_HOL = new Set(['2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31', '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-05', '2027-05-13', '2027-06-03', '2027-08-16', '2027-09-14', '2027-09-15', '2027-09-16', '2027-10-04', '2027-10-11', '2027-12-27', '2027-12-31']);
function tmNow() { const k = new Date(Date.now() + 9 * 3600e3); return { date: k.toISOString().slice(0, 10), wd: k.getUTCDay(), m: k.getUTCHours() * 60 + k.getUTCMinutes() }; }
const tmBiz = d => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w > 0 && w < 6 && !TM_HOL.has(d); };
const tmAdd = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function tmBizBetween(a, b) { let n = 0; for (let d = tmAdd(a, 1); d <= b; d = tmAdd(d, 1)) if (tmBiz(d)) n++; return n; }
function tmMarket() {
  const k = tmNow(), biz = tmBiz(k.date);
  const st = !biz ? 'closed' : k.m < 9 * 60 ? 'pre' : k.m < 15 * 60 + 30 ? 'open' : 'after';
  return { ...k, biz, st, frac: st === 'open' ? (k.m - 540) / 390 : st === 'pre' ? 0 : 1 };
}

/* ── 실시간 현재가를 오늘 봉에 반영 ── */
function tmMerge(f, q) {
  const B = { d: [...f.d], o: [...f.o], h: [...f.h], l: [...f.l], c: [...f.c], v: [...f.v] };
  const mk = tmMarket();
  if (!q || !q.price) return { B, live: false, partial: B.d[B.d.length - 1] === mk.date && mk.st === 'open' };
  const qd = q.t ? String(q.t).slice(0, 10) : (mk.biz && mk.st !== 'pre' ? mk.date : null);
  const n = B.d.length - 1, p = q.price;
  if (qd && qd === B.d[n]) {
    B.c[n] = p; B.h[n] = Math.max(B.h[n], q.high || p, p); B.l[n] = Math.min(B.l[n], q.low || p, p); if (q.vol) B.v[n] = Math.max(B.v[n], q.vol);
  } else if (qd && qd > B.d[n]) {
    B.d.push(qd); B.o.push(q.open || p); B.h.push(Math.max(q.high || p, p)); B.l.push(Math.min(q.low || p, p)); B.c.push(p); B.v.push(q.vol || 0);
  }
  return { B, live: true, partial: B.d[B.d.length - 1] === mk.date && mk.st === 'open' };
}

/* ── 지표 ── */
function tmInd(B, partial) {
  const n = B.c.length - 1;
  const ma5 = X.sma(B.c, 5), ma20 = X.sma(B.c, 20), ma60 = X.sma(B.c, 60), rsi = X.rsi(B.c, 14), st = X.stoch(B.h, B.l, B.c, 5);
  const vma = i => { const a = B.v.slice(Math.max(0, i - 20), i); return a.length ? a.reduce((p, x) => p + x, 0) / a.length : null; };
  // 장중이면 오늘 거래량을 하루치로 늘려서 비교 (오전에 거래가 몰리는 걸 감안해 0.8제곱)
  const mk = tmMarket(), fr = partial ? Math.max(0.08, Math.pow(Math.max(0.02, mk.frac), 0.8)) : 1;
  const vProj = i => i === n ? B.v[i] / fr : B.v[i];
  const vr = i => { const m = vma(i); return m ? vProj(i) / m : null; };
  return { n, ma5, ma20, ma60, rsi, k: st.k, d: st.d, vma, vr, vProj, fr };
}

/* ── 규칙 엔진 ── */
function tmEngine(B, partial, C) {
  const I = tmInd(B, partial), n = I.n, { o, h, l, c, v } = B, P = c[n];
  const max = (a, i, j) => Math.max(...a.slice(Math.max(0, i), j + 1)), min = (a, i, j) => Math.min(...a.slice(Math.max(0, i), j + 1));
  const ma20 = I.ma20[n], ma20p = I.ma20[n - C.slopeDays], slope20 = ma20 && ma20p ? (ma20 / ma20p - 1) * 100 : 0;
  const ma60 = I.ma60[n], ma60p = I.ma60[n - 10], slope60 = ma60 && ma60p ? (ma60 / ma60p - 1) * 100 : 0;
  const R = { n, P, I, B, partial, ma5: I.ma5[n], ma20, ma60, slope20, slope60, rsi: I.rsi[n], k: I.k[n], dd: I.d[n], vr: I.vr(n), buys: [], sells: [], bans: [] };

  // ① 추세 필터 — 종가 > MA20 AND MA20이 최근 5일간 우상향
  const above = P > ma20, up = ma20 > ma20p;
  R.trend = { ok: above && up, above, up, why: `${above ? '✓' : '✗'} 현재가 ${tmW(P)} ${above ? '>' : '<'} 20일선 ${tmW(ma20)} · ${up ? '✓' : '✗'} 20일선 ${C.slopeDays}일 기울기 ${pct(slope20, 2)}` };
  const flat = Math.abs(slope20) < 0.5 && Math.abs(slope60) < 1.0;   // 횡장(20일선 평편)
  const red = i => c[i] < o[i], body = i => Math.abs(c[i] - o[i]) / o[i] * 100;

  // ② 매수 신호
  // BUY-01 눌림목 되돌림: 급등(최근 30봉 고점, 그 전 40봉 저점 대비 +12% 이상) 후 38~50% 되돌림 구간에서 20일선·갭 지지
  {
    const b = { id: 'BUY-01', name: '눌림목 되돌림', state: 'off', why: '' };
    let ip = n - 1; for (let i = Math.max(1, n - 30); i < n; i++) if (h[i] >= h[ip]) ip = i;
    let il = Math.max(0, ip - 40); for (let i = Math.max(0, ip - 40); i < ip; i++) if (l[i] <= l[il]) il = i;
    const H = h[ip], L = l[il], surge = (H / L - 1) * 100, rng = H - L;
    if (ip < n && ip > il && surge >= C.pbSurge) {
      const retr = (H - P) / rng, zLo = H - C.pbHi * rng, zHi = H - C.pbLo * rng, pl = min(l, ip + 1, n);
      let gapTop = null; for (let i = il + 1; i <= ip; i++) if (l[i] > h[i - 1]) { const g = h[i - 1]; if (g >= zLo * 0.97 && g <= zHi * 1.03) gapTop = g; }
      const near = x => x && Math.abs(l[n] - x) / x * 100 <= C.supTol || (x && l[n] <= x && P >= x);
      const sup = near(ma20) ? `20일선 ${tmW(ma20)}` : near(gapTop) ? `전 갭 상단 ${tmW(gapTop)}` : null;
      const conf = P > o[n] || P > c[n - 1];
      Object.assign(b, { H, L, surge, retr, zLo, zHi, gapTop, pl, ip });
      const ref = [ma20, gapTop].filter(x => x && x >= zLo * 0.97 && x <= zHi * 1.03);
      const tgt = ref.length ? Math.max(...ref) : (zLo + zHi) / 2;
      const base = `${B.d[il].slice(5)} 저점 ${tmW(L)} → ${B.d[ip].slice(5)} 고점 ${tmW(H)} (+${fmt(surge, 1)}%) 후 ${fmt(retr * 100, 0)}% 되돌림`;
      if (retr >= C.pbLo - 0.03 && retr <= C.pbHi + 0.05) {
        if (sup && conf) Object.assign(b, { state: 'on', why: `${base} · ${sup} 부근 지지 확인(${P > o[n] ? '양봉' : '전일 종가 위'})`, entry: P, stop: tmDn(pl) - tmTick(pl), stopWhy: `눌림 저점 ${tmW(pl)} 아래` });
        else Object.assign(b, { state: 'near', why: `${base} — 되돌림 구간 안. ${sup ? sup + ' 근처지만 지지 확인(양봉) 전' : '20일선·갭 지지선과 아직 떨어져 있음'}`, entry: tmDn(tgt), stop: tmDn(Math.min(pl, tgt) * 0.97), stopWhy: '지지선 3% 아래(눌림 저점 확정 전 추정)', trigger: `${tmW(tmDn(tgt))} 부근에서 아래꼬리·양봉으로 버티면` });
      } else if (retr < C.pbLo - 0.03 && retr >= 0 && zHi < P * 0.9) b.why = `${base} — 매수 구간 ${tmW(tmDn(zLo))}~${tmW(tmDn(zHi))}까지 ${pct((zHi / P - 1) * 100, 1)} 남음(멀어요)`;
      else if (retr < C.pbLo - 0.03 && retr >= 0) Object.assign(b, { state: 'near', why: `${base} — 아직 덜 내려옴. 매수 구간 ${tmW(tmDn(zLo))}~${tmW(tmDn(zHi))}`, entry: tmDn(tgt), stop: tmDn(Math.min(zLo, tgt) * 0.97), stopWhy: '매수 구간 아래 3%(추정)', trigger: `${tmW(tmDn(zHi))} 아래로 눌렸다가 ${tmW(tmDn(tgt))} 부근 지지 시` });
      else if (retr > C.pbHi + 0.05) b.why = `${base} — 50%보다 깊게 빠져 눌림목이 아닌 하락 전환 가능성`;
    } else b.why = `최근 30봉 안에 +${C.pbSurge}% 이상 급등 구간이 없음`;
    R.buys.push(b);
  }
  // BUY-02 매물대 돌파: 오래 막힌 저항(최근 ${C.boLook}봉, 2번 이상 막힘)을 본문 3%↑ 장대양봉 + 거래량 3배로 돌파
  {
    const b = { id: 'BUY-02', name: '매물대 돌파', state: 'off', why: '' };
    const a = n - C.boLook, z = n - 6, Rz = max(h, a, z);
    let touch = 0; for (let i = Math.max(0, a); i <= z; i++) if (h[i] >= Rz * 0.97) touch++;
    b.res = Rz; b.touch = touch;
    const isBO = i => c[i] > Rz && !red(i) && body(i) >= C.boBody && (I.vr(i) || 0) >= C.boVol;
    let j = -1; for (let i = n; i >= n - 3; i--) if (isBO(i)) { j = i; break; }
    if (touch >= 2 && j >= 0) {
      const half = (o[j] + c[j]) / 2;
      if (min(c, j, n) >= half) Object.assign(b, { state: 'on', why: `${B.d[j].slice(5)} 저항 ${tmW(Rz)}(${touch}번 막힘)을 본문 ${fmt(body(j), 1)}% 장대양봉·거래량 ${fmt(I.vr(j), 1)}배로 돌파${j < n ? ` → 돌파 캔들 절반가 ${tmW(half)} 지지 중` : ''}`, entry: P, stop: tmDn(half) - tmTick(half), stopWhy: `돌파 캔들 절반가 ${tmW(half)} 아래`, half });
      else b.why = `${B.d[j].slice(5)} 돌파했지만 절반가 ${tmW(half)} 아래로 밀림 — 돌파 실패`;
    } else if (touch >= 2 && P > Rz) {
      b.state = 'void'; b.why = `저항 ${tmW(Rz)} 위지만 ${body(n) < C.boBody ? `몸통 ${fmt(body(n), 1)}%` : ''}${(I.vr(n) || 0) < C.boVol ? ` 거래량 ${fmt(I.vr(n) || 0, 1)}배` : ''} — 거래량·장대양봉 없는 돌파는 무시(금지 규칙 2)`;
      R.bans.push('거래량 없는 돌파 — 추격 매수 금지');
    } else if (touch >= 2 && P >= Rz * 0.95) {
      const tg = tmUp(Rz + tmTick(Rz));
      Object.assign(b, { state: 'near', why: `저항 ${tmW(Rz)}(${touch}번 막힘)까지 ${pct((Rz / P - 1) * 100, 1)} — 돌파 대기`, entry: tg, stop: tmDn(Rz * 0.985), stopWhy: '돌파 캔들 절반가 예상(저항 −1.5%)', trigger: `${tmW(tg)} 위에서 본문 ${C.boBody}%↑ 양봉 + 거래량 평소 ${C.boVol}배 이상이면` });
    } else b.why = touch >= 2 ? `저항 ${tmW(Rz)}까지 ${pct((Rz / P - 1) * 100, 1)} — 아직 멀어요` : `최근 ${C.boLook}봉 안에 여러 번 막힌 저항선이 없음`;
    R.buys.push(b);
  }
  // BUY-03 거래량 쉼(변림) 후 재상승: 오르는 날 거래량↑ 쉬는 날↓ → 거래량 마른 쉼 → 거래량 실린 양봉
  {
    const b = { id: 'BUY-03', name: '쉼(변림) 후 재상승', state: 'off', why: '' };
    let uv = 0, un = 0, dv = 0, dn = 0; for (let i = n - 15; i < n - 3; i++) { if (c[i] > c[i - 1]) { uv += v[i]; un++; } else { dv += v[i]; dn++; } }
    const healthy = un && dn && (uv / un) > (dv / dn) * 1.2;
    const vm = I.vma(n - 3) || 1, rest = (v[n - 1] + v[n - 2] + v[n - 3]) / 3 / vm, dry = rest <= C.swDry;
    const rise = P > c[n - 1] && P > o[n] && (I.vr(n) || 0) >= C.swRise;
    const sl = min(l, n - 5, n), tg = tmUp(max(h, n - 3, n - 1) + tmTick(P));
    b.detail = `오른 날 평균 거래량이 내린 날의 ${dn && un ? fmt((uv / un) / (dv / dn || 1), 1) : '–'}배 · 최근 3일 거래량 평소의 ${fmt(rest * 100, 0)}%`;
    if (healthy && dry && rise) Object.assign(b, { state: 'on', why: `${b.detail} → 오늘 거래량 ${fmt(I.vr(n), 1)}배 실린 양봉으로 재상승 시작`, entry: P, stop: tmDn(sl) - tmTick(sl), stopWhy: `쉼 구간 저점(재하락 시작점) ${tmW(sl)} 아래` });
    else if (healthy && dry) Object.assign(b, { state: 'near', why: `${b.detail} — 쉬는 중(거래량 마름). 거래량 실린 양봉 대기`, entry: tg, stop: tmDn(sl) - tmTick(sl), stopWhy: `쉼 구간 저점 ${tmW(sl)} 아래`, trigger: `${tmW(tg)}(최근 3일 고가) 위로 거래량 ${C.swRise}배 이상 양봉이면` });
    else b.why = `${b.detail} — ${!healthy ? '오르는 날 거래량이 더 많은 패턴이 아님' : '아직 거래량이 마르지 않음(쉼 확인 전)'}`;
    R.buys.push(b);
  }
  // BUY-04 과매도 되돌림: 상승 추세 유지(20일선 우상향·60일선 위) 중 RSI 30~40 + 스토캐스틱(5,3,3) 골든크로스
  {
    const b = { id: 'BUY-04', name: '과매도 되돌림', state: 'off', why: '' };
    const r3 = Math.min(I.rsi[n], I.rsi[n - 1], I.rsi[n - 2]);
    const gc = (I.k[n] > I.d[n] && I.k[n - 1] <= I.d[n - 1]) || (I.k[n - 1] > I.d[n - 1] && I.k[n - 2] <= I.d[n - 2] && I.k[n] > I.d[n]);
    const upT = up && P > (ma60 || 0) * 0.97 && slope60 > 0;
    const sl = min(l, n - 5, n);
    const txt = `RSI ${fmt(I.rsi[n], 0)}(최근 3일 최저 ${fmt(r3, 0)}) · 스토캐스틱 K ${fmt(I.k[n], 0)} / D ${fmt(I.d[n], 0)}`;
    if (flat) { b.state = 'void'; b.why = `${txt} — 횡장(20일선 평편)에서는 과매도 매수 금지(금지 규칙 3)`; }
    else if (!upT) b.why = `${txt} — 상승 추세가 아님(20일선 하락 또는 60일선 아래) → 과매도는 신호가 아님`;
    else if (r3 >= C.osLo && r3 <= C.osHi && gc) Object.assign(b, { state: 'on', why: `${txt} — 상승 추세 속 과매도에서 골든크로스`, entry: P, stop: tmDn(sl) - tmTick(sl), stopWhy: `직전 저점 ${tmW(sl)} 아래` });
    else if (r3 <= C.osHi + 5 && I.k[n] < I.d[n]) Object.assign(b, { state: 'near', why: `${txt} — 과매도 근처, 골든크로스(K가 D 위로) 대기`, entry: tmDn(P), stop: tmDn(sl) - tmTick(sl), stopWhy: `직전 저점 ${tmW(sl)} 아래`, trigger: '스토캐스틱 K가 D를 위로 뚫는 날 종가에' });
    else b.why = `${txt} — 과매도 구간(RSI ${C.osLo}~${C.osHi}) 아님`;
    R.buys.push(b);
  }

  // ③ 매도 신호
  // SELL-01 20일선 이탈 + 무릎수성 실패
  {
    const s = { id: 'SELL-01', name: '20일선 이탈·무릎수성 실패', state: 'off', act: '청산' };
    let j = -1; for (let i = n; i >= n - 7; i--) if (c[i] < I.ma20[i] && c[i - 1] >= I.ma20[i - 1]) { j = i; break; }
    if (j >= 0) {
      let fail = -1; for (let i = j + 1; i <= n; i++) if (h[i] >= I.ma20[i] * 0.99 && c[i] < I.ma20[i]) fail = i;
      if (fail >= 0 && P < ma20) Object.assign(s, { state: 'on', why: `${B.d[j].slice(5)} 20일선 이탈 → ${B.d[fail].slice(5)} 20일선(${tmW(I.ma20[fail])})까지 반등했다 다시 막힘` });
      else if (P < ma20) Object.assign(s, { state: 'warn', why: `${B.d[j].slice(5)} 20일선 ${tmW(ma20)} 아래로 이탈 — 다시 올라서지 못하고 막히면 청산` });
      else s.why = `${B.d[j].slice(5)} 이탈했다가 20일선 위로 회복(수성 성공)`;
    } else if (P < ma20) Object.assign(s, { state: 'warn', why: `20일선 ${tmW(ma20)} 아래에 머무는 중` });
    else s.why = `20일선 ${tmW(ma20)} 위 (여유 ${pct((P / ma20 - 1) * 100, 1)})`;
    R.sells.push(s);
  }
  // SELL-02 데드크로스 (5일선이 20일선 아래로)
  {
    const s = { id: 'SELL-02', name: '데드크로스(5일선↓20일선)', state: 'off', act: '잔고 정리' };
    let j = -1; for (let i = n; i >= n - 2; i--) if (I.ma5[i] < I.ma20[i] && I.ma5[i - 1] >= I.ma20[i - 1]) { j = i; break; }
    const gap = (I.ma5[n] / ma20 - 1) * 100;
    if (j >= 0) Object.assign(s, { state: 'on', why: `${B.d[j].slice(5)} 5일선이 20일선을 아래로 뚫음` });
    else if (gap < 0) Object.assign(s, { state: 'warn', why: `5일선이 20일선 아래(${pct(gap, 1)}) — 데드크로스 상태 지속` });
    else if (gap < 1 && I.ma5[n] < I.ma5[n - 1]) Object.assign(s, { state: 'warn', why: `5일선이 20일선에 ${pct(gap, 1)}까지 내려옴 — 데드크로스 임박` });
    else s.why = `5일선이 20일선 위 ${pct(gap, 1)}`;
    R.sells.push(s);
  }
  // SELL-03 고점권 거래량 폭발 + 장대음봉
  {
    const s = { id: 'SELL-03', name: '고점 거래량 폭발+장대음봉', state: 'off', act: '당일 최소 절반 매도' };
    const hi60 = max(h, n - 60, n);
    let j = -1; for (let i = n; i >= n - 1; i--) if (h[i] >= hi60 * 0.93 && (I.vr(i) || 0) >= C.spikeVol && red(i) && body(i) >= 3) { j = i; break; }
    if (j >= 0) Object.assign(s, { state: 'on', why: `${B.d[j].slice(5)} 60일 고점권에서 거래량 ${fmt(I.vr(j), 1)}배 + 몸통 ${fmt(body(j), 1)}% 장대음봉 — 큰손 물량 넘기기 의심` });
    else if (h[n] >= hi60 * 0.93 && (I.vr(n) || 0) >= C.spikeVol) Object.assign(s, { state: 'warn', why: `고점권 거래량 ${fmt(I.vr(n), 1)}배 — 오늘 장대음봉으로 끝나면 절반 매도` });
    else s.why = `고점권 거래량 폭발 없음 (오늘 거래량 ${fmt(I.vr(n) || 0, 1)}배${partial ? ', 하루치 추정' : ''})`;
    R.sells.push(s);
  }
  // SELL-04 긴 위꼬리 2일 연속 (꼬리 ≥ 몸통×2)
  {
    const s = { id: 'SELL-04', name: '긴 위꼬리 반복', state: 'off', act: '분할 매도 시작' };
    const wk = i => { const w = h[i] - Math.max(o[i], c[i]), bd = Math.max(Math.abs(c[i] - o[i]), c[i] * 0.002); return w >= bd * C.wickX && w / c[i] * 100 >= 1 ? w / bd : 0; };
    const a1 = wk(n), a0 = wk(n - 1);
    if (a1 && a0) Object.assign(s, { state: 'on', why: `어제·오늘 위꼬리가 몸통의 ${fmt(a0, 1)}배·${fmt(a1, 1)}배 — 위에서 파는 힘(세력 이탈 의심)` });
    else if (a1 || a0) Object.assign(s, { state: 'warn', why: `${a1 ? '오늘' : '어제'} 긴 위꼬리(몸통의 ${fmt(a1 || a0, 1)}배) — ${a1 ? '내일' : '오늘'}도 나오면 분할 매도` });
    else s.why = '긴 위꼬리 없음';
    R.sells.push(s);
  }
  // SELL-05 과열 + 하락 다이버전스 (RSI 70↑, 주가 신고가인데 RSI 고점은 낮아짐)
  {
    const s = { id: 'SELL-05', name: '과열·다이버전스', state: 'off', act: `트레일링 −${C.trail}% → −${C.trailTight}%로 당김` };
    const r = I.rsi, rNow = Math.max(r[n], r[n - 1], r[n - 2]);
    const newHi = max(h, n - 2, n) >= max(h, n - 20, n);
    let pr = -1; for (let i = n - 30; i <= n - 5; i++) if (pr < 0 || r[i] > r[pr]) pr = i;
    const div = newHi && pr >= 0 && r[pr] > rNow + 2 && h[pr] < max(h, n - 2, n);
    if (rNow >= C.rsiOB && div) Object.assign(s, { state: 'on', why: `RSI ${fmt(rNow, 0)} 과열 + 주가는 신고가인데 RSI 고점은 ${B.d[pr].slice(5)}(${fmt(r[pr], 0)})보다 낮음` });
    else if (rNow >= C.rsiOB) Object.assign(s, { state: 'warn', why: `RSI ${fmt(rNow, 0)} 과열 — 다이버전스는 아직 없음` });
    else if (div) Object.assign(s, { state: 'warn', why: `하락 다이버전스(신고가인데 RSI 고점 낮아짐) — RSI ${fmt(rNow, 0)}` });
    else s.why = `RSI ${fmt(I.rsi[n], 0)} — 과열 아님`;
    R.sells.push(s);
  }
  R.sellOn = R.sells.filter(x => x.state === 'on'); R.sellWarn = R.sells.filter(x => x.state === 'warn');
  R.tight = R.sells[4].state === 'on';
  R.flat = flat;
  R.hi60 = max(h, n - 60, n); R.hi120 = max(h, n - 120, n);
  return R;
}

/* ── 손절가 먼저 → 목표가 → 수량 ── */
function tmPlan(b, R, C, adj) {
  if (!b || !b.entry) return null;
  const E = b.entry, ruleStop = tmDn(E * (1 - C.stop / 100));
  let stop = b.stop && b.stop < E ? b.stop : ruleStop, note = '';
  if (stop < ruleStop) { note = `구조 손절(${tmW(stop)})이 −${C.stop}%보다 멀어 −${C.stop}% 규칙 손절 사용`; stop = ruleStop; }
  const r = E - stop; if (r <= 0) return null;
  const t1 = tmDn(E + 2 * r), t2 = tmDn(E + 3 * r);
  const A = tmAcct(), lossCap = A * C.maxLoss / 100, posCap = A * C.maxPos / 100;
  let qty = Math.floor(Math.min(lossCap / r, posCap / E));
  const mult = adj && adj.mult != null ? adj.mult : 1;
  qty = Math.floor(qty * mult);
  const q1 = Math.ceil(qty / C.splits), q2 = Math.max(0, qty - q1);
  const res = [R.hi60, R.hi120].filter(x => x > E * 1.01).sort((a, b) => a - b)[0] || null;
  return { E, stop, stopPct: (stop / E - 1) * 100, note, r, t1, t2, rr: (t1 - E) / r, qty, q1, q2, amt: qty * E, amt1: q1 * E, loss: qty * r, lossPctA: qty * r / A * 100, A, mult, res, add2: tmUp(R.B.h[R.n] + tmTick(R.B.h[R.n])) };
}

/* ── 최신 공시 분류 ── */
const TM_RISK = /자기주식\s*처분|유상증자|전환사채|신주인수권부사채|교환사채|전환청구권|신주인수권\s*행사|추가상장|보호예수|의무보유|블록딜|시간외\s*대량|최대주주.*(처분|매도|변경)|관리종목|불성실공시|거래\s*정지|매매거래정지|감사의견|횡령|배임|소송|상장적격성|투자주의|투자경고|투자위험|감자|영업정지|회생/;
const TM_GOOD = /자기주식\s*취득|자사주.*(취득|소각)|주식\s*소각|무상증자|현금.*배당|배당\s*결정|단일판매|공급계약|수주|특허|장내\s*매수|최대주주.*(취득|매수)|흑자전환/;
const TM_SCHED = /주주총회|기업설명회|\bIR\b|잠정\s*실적|영업\(잠정\)|실적\s*발표|기준일|상장\s*예정|액면\s*분할|합병|분할|공개매수|배당/;
function tmClassDis(t) { if (/자기주식\s*취득|자사주\s*취득/.test(t)) return 'good'; if (/만기\s*전.*취득|사채\s*취득/.test(t)) return 'info'; if (TM_RISK.test(t)) return 'risk'; if (TM_GOOD.test(t)) return 'good'; if (TM_SCHED.test(t)) return 'sched'; return 'info'; }
const TM_NPOS = /급등|상승|신고가|강세|수주|계약|호실적|최대\s*실적|흑자|돌파|기대|수혜|상향|러브콜|매수/, TM_NNEG = /급락|하락|약세|적자|감소|우려|소송|유상증자|매도|하향|쇼크|부진|리스크|경고/;

/* ── 추후 일정: 시장 공통 + 종목 공시에서 나온 일정 ── */
const TM_FOMC = [['2026-10-28', '2026-10-29'], ['2026-12-09', '2026-12-10']];
function tmCalendar(today, dis, news) {
  const out = [], end = tmAdd(today, 45);
  const push = (d, t, kind, w) => { if (d >= today && d <= end) out.push({ d, t, kind, w }); };
  // 선물·옵션 만기일: 매월 둘째 목요일(휴장이면 앞 거래일), 3·6·9·12월은 동시만기
  for (let k = 0; k < 3; k++) {
    const base = new Date(today.slice(0, 7) + '-01T00:00:00Z'); base.setUTCMonth(base.getUTCMonth() + k);
    let d = new Date(base), cnt = 0; while (true) { if (d.getUTCDay() === 4 && ++cnt === 2) break; d.setUTCDate(d.getUTCDate() + 1); }
    let ds = d.toISOString().slice(0, 10); while (!tmBiz(ds)) ds = tmAdd(ds, -1);
    const mo = +ds.slice(5, 7), quad = [3, 6, 9, 12].includes(mo);
    push(ds, quad ? '선물·옵션 동시만기 — 오후 2시 이후 프로그램 매물로 변동성 확대' : '옵션 만기일 — 장 막판 변동성 주의', 'mkt', quad ? 2 : 1);
  }
  TM_FOMC.forEach(([us, kr]) => push(kr, `미국 FOMC 금리 결정(한국 시각 ${kr.slice(5)} 새벽 발표) — 발표 전후 관망세·발표 뒤 방향성`, 'mkt', 2));
  TM_HOL.forEach(d => { if (d > today) push(d, '휴장일 — 연휴 전날은 보유 위험(해외 변수) 때문에 매물이 나오기 쉬움', 'hol', 1); });
  // 실적 시즌: 분기 끝 + 45일까지 분기보고서 (대형주는 잠정실적이 먼저)
  const qEnds = ['03-31', '06-30', '09-30', '12-31'];
  const y = +today.slice(0, 4);
  [y - 1, y].forEach(yy => qEnds.forEach((qe, qi) => {
    const qd = `${yy}-${qe}`; let dl = tmAdd(qd, qi === 3 ? 90 : 45); while (!tmBiz(dl)) dl = tmAdd(dl, 1);
    if (today > qd && today <= dl) {
      const done = (dis || []).find(x => /잠정\s*실적|영업\(잠정\)|분기보고서|반기보고서|사업보고서/.test(x.t) && x.d.slice(0, 10) > qd);
      const lbl = `${qi === 3 ? yy + '년 연간' : (qi + 1) + '분기'} 실적`;
      if (done) out.push({ d: done.d.slice(0, 10), t: `${lbl} 이미 공시됨 — 「${done.t}」`, kind: 'stock', w: 0, past: true });
      else push(dl > today ? dl : today, `${lbl} 발표 시즌 — 늦어도 ${dl.slice(5)}까지 공개(잠정실적이 먼저 나올 수 있음). 발표 전 신규 매수는 비중 절반`, 'earn', 2);
    }
  }));
  // 뉴스 제목에서 실적 발표일 찾기: 「실적 D-3」, 「8일 실적 발표」
  const seen = new Set();
  (news || []).forEach(x => {
    if (!/실적|어닝/.test(x.t)) return;
    let d = null; const m1 = x.t.match(/D\s*-\s*(\d{1,2})/), m2 = x.t.match(/(\d{1,2})일\s*(잠정\s*)?실적\s*(발표|공개)/);
    if (m1) d = tmAdd(x.d.slice(0, 10), +m1[1]);
    else if (m2) { const dd = +m2[1], base = x.d.slice(0, 8); d = base + String(dd).padStart(2, '0'); if (d < x.d.slice(0, 10)) { const nx = new Date(x.d.slice(0, 7) + '-01T00:00:00Z'); nx.setUTCMonth(nx.getUTCMonth() + 1); d = nx.toISOString().slice(0, 8) + String(dd).padStart(2, '0'); } }
    if (d && d >= today && !seen.has(d)) { seen.add(d); out.push({ d, t: `실적 발표 예정(뉴스: 「${x.t.slice(0, 40)}」) — 발표 전 신규 매수는 비중 절반, 발표 뒤 반응 확인`, kind: 'earn', w: 2, url: x.url }); }
  });
  if (seen.size) { for (let i = out.length - 1; i >= 0; i--) if (out[i].kind === 'earn' && !out[i].url) out.splice(i, 1); }
  // MSCI 분기 리뷰 반영(2·5·8·11월 마지막 거래일)
  [2, 5, 8, 11].forEach(mo => { [y, y + 1].forEach(yy => { const last = new Date(Date.UTC(yy, mo, 0)).toISOString().slice(0, 10); let d = last; while (!tmBiz(d)) d = tmAdd(d, -1); push(d, 'MSCI 지수 정기변경 반영일 — 편입·편출 종목 장 마감 동시호가에 대량 거래', 'mkt', 1); }); });
  if (today.slice(5) >= '11-15') { const ye = `${y}-12-15`; push(ye > today ? ye : today, '연말 대주주 양도세 회피 매물(12월 중순~말) — 개인 비중 높은 코스닥 종목 주의', 'mkt', 1); }
  // 종목 공시 중 일정성 내용
  (dis || []).filter(x => tmClassDis(x.t) === 'sched' && x.d >= tmAdd(today, -20)).slice(0, 5).forEach(x => out.push({ d: x.d.slice(0, 10), t: `공시: ${x.t} — 날짜는 공시 원문에서 확인`, kind: 'stock', w: 1, past: x.d.slice(0, 10) < today, url: x.url }));
  return out.sort((a, b) => a.d.localeCompare(b.d));
}

/* ── 보유 정보(내 보유 종목 탭 기록) ── */
function tmHold(code) {
  if (typeof hLoad !== 'function') return null;
  const items = hLoad().items.filter(h => h.code === code); if (!items.length) return null;
  const h = items[0], buyQ = h.lots.reduce((a, l) => a + l.q, 0), sellQ = (h.sells || []).reduce((a, l) => a + l.q, 0), qty = buyQ - sellQ;
  if (qty <= 0) return null;
  const avg = h.lots.reduce((a, l) => a + l.p * l.q, 0) / buyQ;
  return { h, qty, avg, first: h.lots.map(l => l.d).sort()[0], sold: sellQ };
}
const tmNotes = () => store.get('tmNotes', {}) || {};

/* ── 최신 상황 · 일정을 점수로 ── */
function tmContext(s, R, ev, C) {
  const plus = [], minus = [], bans = [], timing = [];
  let mult = 1;
  const today = tmNow().date;
  const tvf = s && (s._tvf || (typeof volAll === 'function' && volAll().get(s.code) ? volAll().get(s.code).tvf : null));
  if (tvf && tvf.k === 'up') plus.push(`거래대금 상승 유입형(${tvf.s > 0 ? '+' : ''}${tvf.s}) — 대금이 늘며 시가 위 마감`);
  else if (tvf && tvf.k === 'hold') plus.push(`거래대금 시가 지지형(+${tvf.s}) — 거래 많은 날 시가를 지켜냄`);
  else if (tvf && (tvf.k === 'down' || tvf.k === 'dump')) { minus.push(`거래대금 ${tvf.name}(${tvf.s}) — 거래가 많은데 시가 아래로 빠짐`); bans.push(`오늘 거래대금이 시가 아래로 빠져나간 날(${tvf.name}) — 하루 이틀 물량 소화를 보고 매수`); }
  if (s && s.cl) { const t = `차트 종합판정 ${s.cl.v}(${s.cl.s > 0 ? '+' : ''}${fmt(s.cl.s, 1)})`; if (s.cl.s >= 28) plus.push(t); else if (s.cl.s <= -28) minus.push(t); }
  // 투자자 흐름(외국인·연기금·기관·개인) — 등급·국면·오늘 장중 방향을 매수 판단과 수량에 반영
  const flow = tmFlow(s, R);
  if (flow) {
    plus.push(...flow.plus); minus.push(...flow.minus); bans.push(...flow.bans); timing.push(...flow.timing); mult *= flow.mult;
  }
  // 지수 온도(코스피·코스닥 분위기)
  const md = s && typeof moodGet === 'function' ? moodGet(s.market) : null, mdA = [];
  if (md) {
    const t = `${md.nm} 지수 온도 ${md.temp}도(${md.L[1]})`;
    if (md.temp < 25) { bans.push(`${t} — 시장 전체가 던지는 중이라 신규 매수 보류`); mdA.push(['b', `${t} → 신규 매수 보류`]); }
    else if (md.temp < 40) { mult *= 0.75; minus.push(t); timing.push(`${t} — 1차 매수 수량을 3/4로 줄여 계산`); mdA.push(['m', `${t} → 1차 수량 ×0.75`]); }
    else if (md.temp >= 80) { timing.push(`${t} — 과열 장, 추격하지 말고 계획 가격에서만`); mdA.push(['b', `${t} → 추격 금지`]); }
    else if (md.temp >= 65) { plus.push(`${t} — 매수 신호를 믿기 좋은 장`); mdA.push(['p', `${t} → 가산`]); }
    else mdA.push(['', `${t} → 영향 없음`]);
  }
  if (s) {
    if (!flow) {
      if (s.foreign_streak >= 3) plus.push(`외국인 ${s.foreign_streak}일 연속 순매수`); else if (s.foreign_streak <= -3) minus.push(`외국인 ${-s.foreign_streak}일 연속 순매도`);
      if (s.inst_streak >= 3) plus.push(`기관 ${s.inst_streak}일 연속 순매수`); else if (s.inst_streak <= -3) minus.push(`기관 ${-s.inst_streak}일 연속 순매도`);
    }
    if (s.short_chg != null && s.short_chg >= 0.3) minus.push(`공매도 잔고 1주 새 +${fmt(s.short_chg, 2)}%p 증가`);
    else if (s.short_chg != null && s.short_chg <= -0.3) plus.push(`공매도 잔고 감소(${fmt(s.short_chg, 2)}%p) — 숏커버 가능`);
    if (s._newsLive != null && s._newsLive >= 20) plus.push('실시간 뉴스 호재 우세'); else if (s._newsLive != null && s._newsLive <= -20) minus.push('실시간 뉴스 악재 우세');
    if (s._alert) bans.push(`거래소 시장경보(${s._alert}) — 신규 매수 금지`);
  }
  const g = S.data && S.data.gate;
  if (g && g.level === 'red') { minus.push('시장 게이트 빨강: ' + g.reasons.join(', ')); mult *= 0.5; }
  else if (g && g.level === 'yellow') { minus.push('시장 게이트 노랑: ' + g.reasons.join(', ')); mult *= 0.75; }
  // 공시 · 뉴스
  const dis = (ev && ev.dis) || [], news = (ev && ev.news) || [];
  const recent = d => d >= tmAdd(today, -14);
  const risk = dis.filter(x => recent(x.d) && tmClassDis(x.t) === 'risk'), good = dis.filter(x => recent(x.d) && tmClassDis(x.t) === 'good');
  risk.slice(0, 3).forEach(x => minus.push(`최근 공시(악재·물량): ${x.t} (${x.d.slice(5, 10)})`));
  good.slice(0, 3).forEach(x => plus.push(`최근 공시(호재): ${x.t} (${x.d.slice(5, 10)})`));
  if (risk.some(x => /유상증자|전환|신주인수권|추가상장|교환사채|자기주식\s*처분|블록딜|시간외/.test(x.t) && x.d >= tmAdd(today, -7))) { mult *= 0.5; timing.push('최근 물량 공시(증자·CB·추가상장 등) — 물량이 풀리는 날 전후는 피하고 비중 절반'); }
  const nm = s ? s.name.replace(/\(.*\)|우$/g, '') : '', own = news.filter(x => nm && x.t.includes(nm));
  const n24 = (own.length ? own : news.filter(() => !s)).filter(x => x.d >= tmAdd(today, -1)), pos24 = n24.filter(x => TM_NPOS.test(x.t)).length, neg24 = n24.filter(x => TM_NNEG.test(x.t)).length;
  const chg = R ? (R.P / R.B.c[R.n - 1] - 1) * 100 : 0;
  if ((n24.length >= 6 && pos24 > neg24) || (s && s._nw && s._nw.nPos >= 3)) {
    if (chg >= 5) bans.push(`호재 뉴스가 쏟아지는 날(24시간 ${n24.length}건) +${fmt(chg, 1)}% 급등 — 추격 매수 금지(금지 규칙 4). 뉴스는 분배(매도) 신호인 경우가 많아요`);
    else timing.push(`호재 뉴스가 몰리는 중${n24.length >= 6 ? `(24시간 ${n24.length}건)` : ''} — 뉴스 따라 추격하지 말고 계획한 가격에서만`);
  }
  // 일정
  const cal = tmCalendar(today, dis, own);
  const soon = cal.filter(x => !x.past && x.w >= 2 && tmBizBetween(today, x.d) <= 3);
  if (soon.length) { mult *= 0.5; soon.forEach(x => timing.push(`${x.d.slice(5)} ${x.t.split(' — ')[0]} 앞둠 → 1차 비중을 절반으로, 또는 발표 뒤 반응 보고 진입`)); }
  const hol = cal.find(x => x.kind === 'hol' && tmBizBetween(today, x.d) <= 1 && x.d > today);
  if (hol) timing.push(`${hol.d.slice(5)} 휴장 전날 — 신규 매수는 휴장 뒤로 미루는 편이 안전`);
  return { plus, minus, bans, timing, mult, cal, risk, good, n24: n24.length, chg, flow, md, mdA };
}

/* 투자자 흐름 → 타이밍 규칙
   · 수급 A·B / 동반 매집·외국인 주도·매수 전환 → 가산
   · 수급 D → 1차 수량 ×0.75 · 개인만 사는 중 → ×0.5 · 수급 E 또는 큰손 동반 매도(점수 −30↓) → 신규 매수 보류
   · 오늘 장중 외국인·기관이 함께 크게 팔면 → 종가 확인 뒤 주문 (보유 중이면 경고) */
function tmFlow(s, R) {
  if (!s || typeof ivAnalyze !== 'function' || !(s._inv || s._flow)) return null;
  let a = null, V = null;
  try { a = ivAnalyze(s); V = a && typeof ivVerdict === 'function' ? ivVerdict(s, a) : null; } catch (e) { console.error(e); return null; }
  if (!a) return null;
  const plus = [], minus = [], bans = [], timing = [], hold = [], applied = [];
  let mult = 1;
  const rg = a.rg[0], g = V ? V.g[0] : null, gT = V ? `수급 ${g}등급(${V.sc}점)` : '수급';
  const big = v => v != null && (a.tvAvg ? Math.abs(v) >= a.tvAvg * 0.05 : Math.abs(v) >= 5);
  if (g === 'A' || g === 'B') { plus.push(`${gT} — ${a.rg[1]}`); applied.push(['p', `${gT} · ${a.rg[1]} → 가산`]); }
  else if (g === 'D') { minus.push(`${gT} — ${a.rg[1]}`); mult *= 0.75; timing.push(`${gT} — 큰손 매도 우위라 1차 매수 수량을 3/4로`); applied.push(['m', `${gT} → 1차 수량 ×0.75`]); }
  if (g === 'E' || (rg === 'exit' && a.sc <= -30)) { bans.push(`큰손 이탈 중(${gT}, ${a.rg[1]}) — 외국인·기관이 다시 살 때까지 신규 매수 보류`); applied.push(['b', `${gT} · ${a.rg[1]} → 신규 매수 보류`]); hold.push(`큰손 이탈(${a.rg[1]}) — 반등 때 비중 줄이기, 새로 더 사지 않기`); }
  else if (rg === 'exit') { minus.push(`큰손 동반 매도 — ${a.rg[2]}`); mult *= 0.75; applied.push(['m', '큰손 동반 매도 → 1차 수량 ×0.75']); hold.push('외국인·기관 동반 매도 중 — 손절선 이탈 시 미루지 말기'); }
  if (rg === 'retail') { minus.push('개인만 사는 중 — 외국인·기관 물량을 개인이 받는 모습'); mult *= 0.5; timing.push('개인만 사는 종목 — 1차 비중 절반, 외국인·기관 매수 전환을 확인한 뒤 2차'); applied.push(['m', '개인만 사는 중 → 1차 수량 ×0.5']); hold.push('개인만 사는 중 — 반등 때 일부 비중 줄이기'); }
  if (rg === 'turn') { timing.push('외국인 매도→매수 전환 첫날 — 2~3일 이어지는지 확인 뒤 2차(첫날 추격 금지)'); applied.push(['', '외국인 매수 전환 → 2차는 확인 뒤']); }
  if (rg === 'dip') { plus.push(`연기금 저가 매수(5일 ${ivEok(a.sum.p5)}) — 하락을 받쳐주는 버팀목`); applied.push(['p', '연기금 저가 매수 → 가산']); }
  // 오늘 장중(잠정) 방향
  const tf = a.today.f, ti = a.today.i;
  if (a.Z.partial && tf != null) {
    if (tf < 0 && (ti || 0) < 0 && big(tf) && big(ti || 0)) { minus.push(`오늘 장중 외국인 ${ivEok(tf)} · 기관 ${ivEok(ti)} 동반 순매도(잠정)`); timing.push('오늘 외국인·기관이 함께 파는 중 — 매수는 종가(15:10~15:20) 확인 뒤, 아니면 내일로'); applied.push(['m', '오늘 외국인·기관 동반 매도 → 종가 확인 뒤 주문']); hold.push(`오늘 외국인 ${ivEok(tf)} · 기관 ${ivEok(ti)} 동반 매도 — 손절·트레일링 가격을 다시 확인`); }
    else if (tf < 0 && (a.sum.f5 || 0) > 0 && big(tf)) { timing.push(`오늘 외국인 ${ivEok(tf)} 순매도(잠정) — 5일 매수 흐름이 꺾이는지 종가로 확인`); applied.push(['', '오늘 외국인 매도 전환 → 종가 확인']); if (rg === 'fdrive') hold.push('외국인 주도 상승 종목인데 오늘 외국인이 팔아요 — 이틀 연속이면 일부 이익 실현'); }
    else if (tf > 0 && (ti || 0) > 0 && big(tf)) { plus.push(`오늘 장중 외국인 ${ivEok(tf)} · 기관 ${ivEok(ti)} 동반 순매수(잠정)`); applied.push(['p', '오늘 외국인·기관 동반 매수 → 가산']); }
  }
  if (!applied.length) applied.push(['', `${gT} · ${a.rg[1]} → 영향 없음(중립)`]);
  return { a, V, plus, minus, bans, timing, hold, mult, applied };
}

/* ── 최종 결론 ── */
function tmDecide0(code) {
  const st = TM.st.get(code); if (!st || !st.f) return null;
  const C = tmCfg(), s = S.data.stocks.find(x => x.code === code);
  const M = tmMerge(st.f, st.q), R = tmEngine(M.B, M.partial, C);
  const ctx = tmContext(s, R, TM.ev.get(code), C);
  const hold = tmHold(code), mk = tmMarket(), notes = tmNotes()[code];
  const D = { code, s, R, ctx, hold, live: M.live, partial: M.partial, mk, C, note: notes };
  const confirmTxt = M.partial ? '장중 잠정 신호예요 — 오후 3시 10~20분 종가 근처에서 신호가 유지되는지 확인한 뒤 주문하세요(일봉 규칙은 종가로 확정)' :
    mk.st === 'pre' ? '오늘 장 시작 후 — 시초가가 손절가 아래로 갭하락하면 주문 취소' : '다음 거래일 장 초반(9:00~10:00) — 시초가가 손절가 아래로 갭하락하면 주문 취소';

  if (hold) {
    const { qty, avg } = hold, h = hold.h;
    const ruleStop = h.stop || tmDn(avg * (1 - C.stop / 100));
    let i0 = R.B.d.findIndex(d => d >= hold.first); if (i0 < 0) i0 = R.n;
    const hiC = Math.max(...R.B.c.slice(i0)), trailPct = R.tight ? C.trailTight : C.trail;
    const trail = tmDn(hiC * (1 - trailPct / 100));
    const eff = Math.max(ruleStop, trail), effWhy = trail > ruleStop ? `트레일링(최고 종가 ${tmW(hiC)} −${trailPct}%)` : `손절선(평단 −${C.stop}%${h.stop ? ', 직접 입력' : ''})`;
    const t1 = h.t1 || tmDn(avg * (1 + C.target / 100)), t2 = h.t2 || tmDn(avg * (1 + C.target * 1.5 / 100));
    const P = R.P, pnl = (P / avg - 1) * 100, half = Math.ceil(qty / 2);
    const s3 = R.sells[2].state === 'on', s4 = R.sells[3].state === 'on', s5 = R.tight, s1 = R.sells[0].state === 'on', s2 = R.sells[1].state === 'on';
    let act, tone, head, orders = [], why = [];
    const basisGone = notes && notes.stop && P < notes.stop;
    if (P <= eff) { act = 'EXIT'; tone = 'bad'; head = `전량 매도 — ${effWhy} ${tmW(eff)} 아래`; orders.push(['매도', qty, P, '지금 시장가/현재가 근처']); why.push('손절·트레일링은 다른 모든 신호보다 먼저(평가 순서 1위). 손절은 협상 대상이 아니에요'); }
    else if (s3) { act = 'HALF'; tone = 'bad'; head = '절반 매도 — 고점 거래량 폭발 + 장대음봉'; orders.push(['매도', half, P, '오늘 안에 최소 절반']); orders.push(['남은 물량 손절/트레일링', qty - half, eff, effWhy]); why.push(R.sells[2].why); }
    else if (s4) { act = 'PART'; tone = 'warn'; head = '분할 매도 시작 — 긴 위꼬리 2일 연속'; const q3 = Math.max(1, Math.round(qty / 3)); orders.push(['매도', q3, P, '1/3 먼저(수익률과 무관)']); orders.push(['나머지 손절/트레일링', qty - q3, eff, effWhy]); why.push(R.sells[3].why); }
    else if (s1 || s2) { act = 'EXIT'; tone = 'bad'; head = `잔량 청산 — ${s1 ? '20일선 이탈 후 무릎수성 실패' : '데드크로스'}`; orders.push(['매도', qty, P, '추세가 꺾이면 목표가 전이라도 나감']); why.push((s1 ? R.sells[0] : R.sells[1]).why); }
    else if (basisGone) { act = 'EXIT'; tone = 'bad'; head = `매수 근거 소멸 — 기록한 근거(${notes.id || '직접 기록'})의 기준선 ${tmW(notes.stop)} 아래`; orders.push(['매도', qty, P, '근거가 사라지면 나감']); why.push(`기록: ${notes.txt || ''}`); }
    else if (P >= t1) { act = 'TAKE'; tone = 'good'; head = `목표가 도달 — 절반 이익 실현, 남은 물량은 트레일링 ${tmW(eff)}`; orders.push(['매도', half, P, `1차 목표 ${tmW(t1)} 도달`]); orders.push(['남은 물량', qty - half, Math.max(eff, tmDn(avg)), P >= t2 ? '2차 목표도 넘음 — 트레일링으로 끝까지' : `2차 ${tmW(t2)} 또는 트레일링 이탈 시`]); }
    else { act = 'HOLD'; tone = 'ok'; head = s5 ? `보유 — 과열·다이버전스로 트레일링을 −${C.trailTight}%로 당김(${tmW(eff)})` : `보유 유지 — ${tmW(eff)} 아래로 내려가면 매도`;
      orders.push(['손절/트레일링(미리 걸어두기)', qty, eff, effWhy]); orders.push(['1차 목표 절반 매도', half, t1, `평단 +${C.target}%`]); orders.push(['2차 목표 나머지', qty - half, t2, `평단 +${fmt(C.target * 1.5, 0)}% 또는 트레일링`]);
      if (R.sellWarn.length) why.push('주의 신호: ' + R.sellWarn.map(x => x.name).join(', ')); }
    // 추가 매수(2차) 판단
    const on = R.buys.filter(b => b.state === 'on');
    let add = null;
    if (act === 'HOLD') {
      if (P < avg && !R.trend.ok) add = { ok: false, t: '추가 매수 금지 — 하락 추세에서 물타기(금지 규칙 1)' };
      else if (R.trend.ok && on.length) { const pl = tmPlan(on[0], R, C, { mult: ctx.mult }); add = { ok: !ctx.bans.length, t: ctx.bans.length ? `추세 유지 중 ${on[0].name} 신호지만 ${ctx.bans[0]}` : `추세 유지 중 ${on[0].name} → 2차(추가) 매수 가능: ${pl ? `${tmW(pl.E)} · 손절 ${tmW(pl.stop)}` : ''}`, pl }; }
      else if (!R.trend.ok) add = { ok: false, t: '추세 필터 실패 — 추가 매수 하지 않음(매도 신호만 감시)' };
    }
    if (ctx.flow && ctx.flow.hold.length) why.push(...ctx.flow.hold.map(t => '수급: ' + t));
    if (ctx.md && ctx.md.temp < 25) why.push(`${ctx.md.nm} 지수 온도 ${ctx.md.temp}도(얼어붙음) — 손절선은 미루지 말고 지키기`);
    Object.assign(D, { mode: 'hold', act, tone, head, orders, why, add, eff, effWhy, ruleStop, trail, hiC, t1, t2, pnl, P, avg, qty, timing: act === 'HOLD' ? '지금은 매도 주문만 미리 걸어두기(손절/트레일링). 신호는 매일 종가 기준으로 다시 확인' : (M.partial && act !== 'EXIT' ? confirmTxt : act === 'EXIT' ? (M.partial ? '지금 — 손절·청산 신호는 기다리지 않아요(장 마감 직전까지 회복 못 하면 반드시)' : '다음 거래일 장 초반') : confirmTxt) });
    return D;
  }

  // 보유 안 함 → 관찰/매수
  const on = R.buys.filter(b => b.state === 'on' && (R.trend.ok || (b.id === 'BUY-04')));
  const near = R.buys.filter(b => b.state === 'near');
  const bans = [...ctx.bans, ...R.bans];
  let act, tone, head, plan = null, why = [], wait = [];
  if (R.sellOn.length) { act = 'NO'; tone = 'bad'; head = `매수 금지 — 매도 신호 발생 중(${R.sellOn.map(x => x.name).join(', ')})`; why.push('손절·매도 신호는 항상 매수보다 먼저 평가해요'); }
  else if (!R.trend.ok && !on.length) { act = 'WATCH'; tone = 'low'; head = '관찰만 — 추세 필터 실패, 매수 신호 전부 무시'; why.push(R.trend.why); wait.push(`종가가 20일선(${tmW(R.ma20)}) 위 + 20일선이 5일 전보다 올라서면 다시 검토`); }
  else if (on.length && bans.length) { act = 'NO'; tone = 'warn'; head = `신호는 있지만 매수 보류 — ${bans[0]}`; plan = tmPlan(on[0], R, C, { mult: ctx.mult }); }
  else if (on.length) {
    const plans = on.map(b => ({ b, p: tmPlan(b, R, C, { mult: ctx.mult }) })).filter(x => x.p).sort((a, b) => a.p.r / a.p.E - b.p.r / b.p.E);
    if (plans.length) { act = 'BUY'; tone = 'good'; plan = plans[0].p; plan.sig = plans[0].b; head = `1차 매수 — ${plans[0].b.id} ${plans[0].b.name}`; why.push(plans[0].b.why); if (plans.length > 1) why.push('함께 나온 신호: ' + plans.slice(1).map(x => x.b.name).join(', ')); }
    else { act = 'WATCH'; tone = 'low'; head = '신호는 있지만 손절가를 정할 수 없음 — 매수 안 함'; }
  } else if (near.length) {
    const cand = near.map(b => ({ b, p: tmPlan(b, R, C, { mult: ctx.mult }) })).filter(x => x.p).sort((a, b) => Math.abs(a.p.E / R.P - 1) - Math.abs(b.p.E / R.P - 1));
    if (cand.length) { act = 'WAIT'; tone = 'mid'; plan = cand[0].p; plan.sig = cand[0].b; head = `대기 — ${cand[0].b.trigger || tmW(plan.E) + ' 부근'} 1차 매수`; why.push(cand[0].b.why); if (cand.length > 1) wait.push(...cand.slice(1).map(x => `${x.b.id} ${x.b.name}: ${x.b.trigger || tmW(x.p.E)} → ${tmW(x.p.E)} 매수`)); }
    else { act = 'WATCH'; tone = 'low'; head = '관찰 — 가까운 매수 신호 없음'; }
  } else { act = 'WATCH'; tone = 'low'; head = '관찰 — 추세는 살아 있지만 매수 신호(눌림·돌파·쉼 후 재상승·과매도) 없음'; wait.push(`눌림목 대기: 20일선 ${tmW(R.ma20)} 부근까지 내려와 지지하면 눌림목 매수 검토`); }
  // 외국인 평균 매수가가 매수가~손절가 사이(또는 바로 아래)면 받쳐줄 가격대
  if (plan && ctx.flow && ctx.flow.a && ctx.flow.a.fAvg) {
    const fa = ctx.flow.a.fAvg;
    if (fa <= plan.E && fa >= plan.stop) why.push(`외국인 평균 매수가(약 ${tmW(Math.round(fa))})가 매수가와 손절가 사이 — 외국인이 지킬 가능성이 있는 가격대라 손절 전 버팀목`);
    else if (fa < plan.stop && fa >= plan.stop * 0.97) why.push(`외국인 평균 매수가(약 ${tmW(Math.round(fa))})가 손절가 바로 아래 — 손절가를 그 아래로 둘지 검토`);
    else if (fa > plan.E * 1.02 && fa <= plan.t1) why.push(`외국인 평균 매수가(약 ${tmW(Math.round(fa))})가 매수가 위 — 그 근처에서 외국인 본전 매도가 나올 수 있어요`);
  }
  // 기다리는 신호가 있어도 금지 사유(수급 이탈·시장 경보·지수 얼어붙음 등)가 있으면 지정가도 걸지 않음
  if (act === 'WAIT' && bans.length) { act = 'NO'; tone = 'warn'; head = `조건이 와도 매수 보류 — ${bans[0]}`; }
  let timing = '';
  if (act === 'BUY') timing = confirmTxt;
  else if (act === 'WAIT') timing = `지정가 대기 — ${plan.sig.trigger || '조건 충족 시'} ${tmW(plan.E)}에 1차(${plan.q1}주). 체결 후 바로 손절 ${tmW(plan.stop)} 주문 함께`;
  else if (act === 'NO') timing = '지금은 사지 않음 — 금지 사유가 풀릴 때까지 기다림';
  else timing = '매수 신호가 나올 때까지 관찰 — 이 화면이 실시간으로 다시 판정해요';
  Object.assign(D, { mode: 'new', act, tone, head, plan, why, wait, bans, timing, P: R.P });
  return D;
}


/* ═════════════ 실시간 호가 반영 ═════════════
   규칙(차트)이 정한 가격을 기준으로, 호가창의 매수벽·매도벽·체결강도·잔량비를 보고 실제 주문 가격을 다듬어요.
   원칙: 손절가는 규칙 그대로(호가로 느슨하게 하지 않음) · 매수가는 규칙 기준가보다 1% 넘게 비싸게 사지 않음 */
function tmBookUpdate(st, j) {
  const b = j.book, q = j.quote || {};
  if (!b || !(b.asks || []).length || !(b.bids || []).length) return;
  const K = st.bk = st.bk || { n: 0, prev: null, buyV: 0, sellV: 0, walls: {}, ev: [] };
  const asks = b.asks.slice(0, 10), bids = b.bids.slice(0, 10);
  const a1 = asks[0].p, b1 = bids[0].p, price = q.price || Math.round((a1 + b1) / 2);
  const wallOf = (side, nm) => { const avg = side.reduce((s, x) => s + x.q, 0) / (side.length || 1); return side.filter(x => x.q >= avg * 2.5 && x.q * x.p >= 5e7).map(x => ({ side: nm, p: x.p, q: x.q, amt: x.p * x.q, dist: (x.p / price - 1) * 100 })); };
  const walls = [...wallOf(asks, 'ask'), ...wallOf(bids, 'bid')];
  const P = K.prev;
  if (P && q.vol != null && P.vol != null && q.vol > P.vol) {
    const dv = q.vol - P.vol; let dir = 0;
    if (price >= P.a1) dir = 1; else if (price <= P.b1) dir = -1; else dir = price > P.price ? 1 : price < P.price ? -1 : 0;
    if (dir > 0) K.buyV += dv; else if (dir < 0) K.sellV += dv; else { K.buyV += dv / 2; K.sellV += dv / 2; }
  }
  if (P) Object.values(K.walls).forEach(w => {
    if (walls.find(x => x.side === w.side && x.p === w.p)) return;
    const lvl = (w.side === 'ask' ? asks : bids).find(x => x.p === w.p);
    if (lvl && lvl.q >= w.q * 0.4) return;
    const reached = w.side === 'ask' ? price >= w.p : price <= w.p;
    K.ev.unshift({ t: String(j.at || '').slice(11, 19), k: reached ? (w.side === 'ask' ? 'eat' : 'break') : 'cancel', w });
  });
  K.walls = Object.fromEntries(walls.map(w => [w.side + w.p, w])); K.ev = K.ev.slice(0, 20);
  K.prev = { price, vol: q.vol, a1, b1 }; K.n++;
  const totA = b.totA || asks.reduce((s, x) => s + x.q, 0), totB = b.totB || bids.reduce((s, x) => s + x.q, 0);
  K.x = { at: j.at, asks, bids, a1, b1, price, totA, totB, imb: totA + totB ? totB / (totA + totB) : null, spreadT: Math.round((a1 - b1) / tmTick(price)), walls,
    cs: K.sellV > 0 ? K.buyV / K.sellV * 100 : (K.buyV > 0 ? 300 : null), ready: K.n >= 4, cancels: K.ev.filter(e => e.k === 'cancel').length, ev: K.ev };
}

function tmApplyBook(D) {
  const st = TM.st.get(D.code), x = st && st.bk && st.bk.x, mk = tmMarket();
  if (!x || mk.st !== 'open' || Date.now() - new Date(String(x.at).replace(' ', 'T') + '+09:00') > 120e3) { D.ob = null; return; }
  const T = tmTick(x.price), notes = [];
  const bw = x.walls.filter(w => w.side === 'bid').sort((a, b) => b.p - a.p)[0], aw = x.walls.filter(w => w.side === 'ask').sort((a, b) => a.p - b.p)[0];
  // 호가 분위기
  let mood = 'mid';
  const strong = x.ready && x.cs != null && x.cs >= 115 && x.cancels < 2, weak = (x.ready && x.cs != null && x.cs <= 85) || x.cancels >= 2;
  if (strong) mood = 'buy'; else if (weak) mood = 'sell';
  const csTxt = x.cs != null && x.ready ? `체결강도 ${Math.round(x.cs)}` : '체결강도 측정 중';
  const imbTxt = x.imb != null ? `매수 잔량 ${Math.round(x.imb * 100)}% : 매도 잔량 ${Math.round((1 - x.imb) * 100)}%` : '';
  const ob = { x, mood, bw, aw, notes, csTxt, imbTxt, adj: {} };
  if (x.spreadT >= 3) notes.push(`1호가 차이가 ${x.spreadT}호가로 벌어져 있어요 — 시장가 대신 지정가로`);
  if (x.cancels >= 2) notes.push(`최근 체결 없이 사라진 호가 벽 ${x.cancels}번 — 잔량보다 실제 체결을 믿으세요`);

  if (D.mode === 'new' && D.plan) {
    const p = D.plan, cap = tmDn(p.E * 1.01), floor = p.stop + 2 * T;
    let bp = null, how = '';
    if (D.act === 'BUY') {
      if (mood === 'buy' && x.a1 <= cap) { bp = x.a1; how = `매도 1호가에 바로 — ${csTxt}로 사는 힘이 강해요`; }
      else if (bw && bw.p + T <= cap && bw.p + T >= floor && bw.p >= x.price * 0.97) { bp = bw.p + T; how = `매수벽 ${fmt(bw.p)}원(${tmEok(bw.amt)}) 바로 위 — 벽 앞에서 먼저 체결`; }
      else if (mood === 'sell') { bp = Math.max(floor, x.bids[1] ? x.bids[1].p : x.b1 - T); how = `매수 2호가에 걸어두기 — ${csTxt}, 파는 힘이 더 세요`; notes.push('호가가 매도 우위라 1차 수량의 절반만 먼저 걸고, 체결강도가 100을 넘으면 나머지를 넣어요'); }
      else { bp = Math.min(x.b1, cap); how = `매수 1호가에 걸어두기 — ${csTxt}`; }
    } else if (D.act === 'WAIT') {
      if (bw && Math.abs(bw.p / p.E - 1) <= 0.015 && bw.p + T >= floor) { bp = bw.p + T; how = `기준가 근처 매수벽 ${fmt(bw.p)}원 바로 위로 조정`; }
      else notes.push(`지정가 ${tmW(p.E)}는 지금 호가창(10단계) 밖이에요 — 가격이 다가오면 다시 다듬어요`);
    }
    if (bp != null && bp !== p.E) ob.adj.buy = { p: bp, from: p.E, how };
    else if (bp != null) ob.adj.buy = { p: bp, from: p.E, how };
    // 1차 목표 근처(호가창 안)에 매도벽이 있으면 그 바로 아래로
    if (aw && aw.p > (bp || p.E) && aw.p <= p.t1) ob.adj.part = { p: aw.p - T, how: `매도벽 ${fmt(aw.p)}원(${tmEok(aw.amt)}) 바로 아래 — 벽에 막히기 전에 1/3 먼저 이익 실현` };
    if (aw && Math.abs(aw.p / p.t1 - 1) <= 0.01) ob.adj.t1 = { p: aw.p - T, from: p.t1, how: `1차 목표 바로 위 매도벽 ${fmt(aw.p)}원 — 1호가 아래로` };
    if (bw && bw.p > p.stop && (bw.p / p.stop - 1) <= 0.02) notes.push(`손절선 바로 위에 매수벽 ${fmt(bw.p)}원(${tmEok(bw.amt)}) — 이 벽이 체결 없이 사라지면 손절 대비`);
  }
  if (D.mode === 'hold') {
    const o = D.orders[0];
    if (['EXIT', 'HALF', 'PART', 'TAKE'].includes(D.act) && o) {
      const urgent = D.act === 'EXIT' || D.act === 'HALF' || mood === 'sell';
      ob.adj.sell = urgent ? { p: x.b1, how: `매수 1호가에 바로 팔기 — ${D.act === 'EXIT' ? '손절·청산은 기다리지 않아요' : csTxt}` }
        : { p: x.a1, how: `매도 1호가에 걸어두기 — ${csTxt}로 사는 힘이 남아 있어 조금 더 받기` };
    }
    if (D.act === 'HOLD' && aw && aw.p > D.P && aw.p < D.t1) ob.adj.part = { p: aw.p - T, how: `위 매도벽 ${fmt(aw.p)}원(${tmEok(aw.amt)}) 바로 아래 — 벽에 막히기 전에 일부(1/3) 정리하는 것도 방법` };
    if (bw && bw.p > D.eff && (bw.p / D.eff - 1) <= 0.02) notes.push(`손절선 바로 위 매수벽 ${fmt(bw.p)}원 — 이 벽이 무너지면 손절선 도달이 빨라질 수 있어요`);
  }
  D.ob = ob;
}
const tmEok = v => v >= 1e8 ? fmt(v / 1e8, v >= 1e10 ? 0 : 1) + '억' : fmt(v / 1e4, 0) + '만';
function tmDecide(code) { const D = tmDecide0(code); if (D) { try { tmApplyBook(D); } catch (e) { console.error(e); D.ob = null; } } return D; }

/* 호가 패널 (가격 위치 아래) */
function tmBookHtml(D) {
  const st = TM.st.get(D.code), x = st && st.bk && st.bk.x, mk = tmMarket();
  if (mk.st !== 'open') return `<div class="tk-book off"><h4>실시간 호가</h4><p>장중(9:00~15:30)에만 호가를 반영해요. 지금은 규칙 가격 그대로예요.</p></div>`;
  if (!x) return `<div class="tk-book off"><h4>실시간 호가</h4><p>호가를 받는 중이에요.</p></div>`;
  const ob = D.ob, mx = Math.max(...x.asks.slice(0, 5).map(a => a.q), ...x.bids.slice(0, 5).map(b => b.q), 1);
  const isW = (side, p) => x.walls.some(w => w.side === side && w.p === p);
  const row = (l, side) => `<div class="bk ${side}${isW(side, l.p) ? ' wall' : ''}${l.p === x.price ? ' cur' : ''}"><i style="width:${Math.round(l.q / mx * 100)}%"></i><span class="bk-p">${fmt(l.p)}</span><span class="bk-q">${fmt(l.q)}</span></div>`;
  const moodTxt = { buy: ['사는 힘 우세', 'buy'], sell: ['파는 힘 우세', 'sell'], mid: ['팽팽함', 'mid'] }[ob ? ob.mood : 'mid'];
  return `<div class="tk-book"><h4>실시간 호가 <span class="bk-mood ${moodTxt[1]}">${x.ready ? moodTxt[0] : '분석 중'}</span></h4>
    <div class="bk-lad">${x.asks.slice(0, 5).reverse().map(a => row(a, 'ask')).join('')}${x.bids.slice(0, 5).map(b => row(b, 'bid')).join('')}</div>
    <dl class="bk-st"><dt>체결강도</dt><dd>${x.cs != null && x.ready ? Math.round(x.cs) : '측정 중'}</dd><dt>잔량</dt><dd>매수 ${x.imb != null ? Math.round(x.imb * 100) : '–'}% · 매도 ${x.imb != null ? Math.round((1 - x.imb) * 100) : '–'}%</dd><dt>1호가 차이</dt><dd>${x.spreadT}호가</dd></dl>
    <p class="bk-at">${esc(String(x.at).slice(11, 19))} 기준 · 5초마다</p></div>`;
}

/* ═════════════ 화면 ═════════════
   주문표(티켓) 형태: 결론 띠 → 매수/매도 주문표 + 세로 가격 사다리(호가창처럼) → 차트 → 탭(규칙 판정·최신 상황·일정·근거)
   색 규칙: 증권사 주문창처럼 매수 = 빨강, 매도 = 파랑. 관망은 회색, 매수 금지는 주황 */
const TM_ACT = { BUY: ['지금 1차 매수', 'buy'], WAIT: ['지정가 대기', 'buyw'], WATCH: ['관찰', 'idle'], NO: ['매수 금지', 'no'], HOLD: ['보유 유지', 'hold'], TAKE: ['이익 실현', 'sellw'], HALF: ['절반 매도', 'sell'], PART: ['분할 매도', 'sellw'], EXIT: ['전량 매도', 'sell'] };
const tmTone = a => (TM_ACT[a] || ['', 'idle'])[1];
const tmTag = a => { const x = TM_ACT[a] || ['–', 'idle']; return `<span class="tm-act ${x[1]}">${x[0]}</span>`; };
const TM_ST = { on: ['발생', 'on'], near: ['대기', 'near'], warn: ['주의', 'warn'], void: ['무효', 'void'], off: ['없음', 'off'] };
const tmStTag = st => { const x = TM_ST[st] || TM_ST.off; return `<span class="tm-st ${x[1]}">${x[0]}</span>`; };
function tmCodes() {
  const hs = typeof hLoad === 'function' ? [...new Set(hLoad().items.filter(h => tmHold(h.code)).map(h => h.code))] : [];
  const ws = (store.get('tmWatch', []) || []).filter(c => !hs.includes(c));
  return { hs, ws, all: [...hs, ...ws] };
}

/* 한 문장 결론 (이름 없이) */
function tmOneLine(D) {
  if (D.mode === 'hold') {
    const o = D.orders[0];
    if (D.act === 'HOLD') return `지금은 그대로 보유하세요. ${tmW(D.eff)} 아래로 내려가면 전량 매도, ${tmW(D.t1)}에 오면 ${fmt(Math.ceil(D.qty / 2))}주 이익 실현, 나머지는 ${tmW(D.t2)} 또는 트레일링 이탈 때 매도해요.`;
    const sp = o && D.ob && D.ob.adj.sell ? D.ob.adj.sell.p : o && o[2];
    return `${o ? `${fmt(o[1])}주를 ${tmW(sp)}${D.ob && D.ob.adj.sell ? '(호가 반영)' : ' 근처'}에서 매도(약 ${hMoney(o[1] * sp)})` : ''}${D.orders[1] && D.orders[1][1] > 0 ? `하고, 남은 ${fmt(D.orders[1][1])}주는 ${tmW(D.orders[1][2])} 기준으로 관리` : ''}하세요.`;
  }
  const p = D.plan, bp = D.ob && D.ob.adj.buy ? D.ob.adj.buy.p : null;
  if (D.act === 'BUY' && p && bp) return `${tmW(bp)}에 ${fmt(p.q1)}주(약 ${hMoney(bp * p.q1)})를 1차로 사고, 손절은 ${tmW(p.stop)}에 바로 걸어두세요. ${tmW(D.ob.adj.t1 ? D.ob.adj.t1.p : p.t1)}에서 절반, ${tmW(p.t2)} 또는 고점 대비 −${D.C.trail}%에서 나머지를 팔아요.`;
  if (D.act === 'BUY' && p) return `지금 ${fmt(p.q1)}주(약 ${hMoney(p.amt1)})를 1차로 사고, 손절은 ${tmW(p.stop)}에 바로 걸어두세요. ${tmW(p.t1)}에서 절반, ${tmW(p.t2)} 또는 고점 대비 −${D.C.trail}%에서 나머지를 팔아요.`;
  if (D.act === 'WAIT' && p) return `지금은 사지 말고 ${tmW(bp || p.E)}에 ${fmt(p.q1)}주 지정가를 걸어두세요. 체결되면 손절 ${tmW(p.stop)}, 목표 ${tmW(p.t1)}·${tmW(p.t2)}.`;
  if (D.act === 'NO') return `지금은 사지 않아요.${p ? ` 금지 사유가 풀리면 ${tmW(p.E)} 매수 · ${tmW(p.stop)} 손절 기준으로 다시 봐요.` : ''}`;
  return D.wait && D.wait[0] ? `매수하지 않고 지켜봐요. ${D.wait[0]}.` : '매수하지 않고 지켜봐요.';
}

/* 주문표 행 모으기 */
function tmRows(D) {
  const buy = [], sell = [];
  if (D.mode === 'hold') {
    const A = D.ob ? D.ob.adj : {};
    D.orders.filter(o => o[1] > 0).forEach((o, i) => sell.push(i === 0 && A.sell && !/손절|트레일링|목표/.test(o[0]) ? { lbl: o[0] + ' · 호가 반영', p: A.sell.p, q: o[1], note: A.sell.how, ob: true } : { lbl: o[0], p: o[2], q: o[1], note: o[3], stop: /손절|트레일링/.test(o[0]) }));
    if (A.part && D.act === 'HOLD' && D.qty >= 3) {
      const qp = Math.round(D.qty / 3), q1 = Math.round((D.qty - qp) / 2);
      sell.forEach(r => { if (/1차 목표/.test(r.lbl)) r.q = q1; else if (/2차 목표/.test(r.lbl)) r.q = D.qty - qp - q1; });
      sell.splice(1, 0, { lbl: '일부 정리 · 호가', p: A.part.p, q: qp, note: A.part.how, ob: true });
    }
    if (D.add && D.add.ok && D.add.pl) buy.push({ lbl: '추가(2차) 매수', p: D.add.pl.E, q: D.add.pl.q1, note: '추세 유지 중 매수 신호' });
  } else if (D.plan) {
    const p = D.plan, A = D.ob ? D.ob.adj : {};
    if (A.buy) buy.push({ lbl: D.act === 'BUY' ? '1차 매수 · 호가 반영' : '1차 매수 · 지정가(호가 반영)', p: A.buy.p, q: p.q1, note: `${A.buy.how} · 규칙 기준가 ${tmW(p.E)}`, ob: true });
    else buy.push({ lbl: D.act === 'BUY' ? '1차 매수 · 지금' : '1차 매수 · 지정가', p: p.E, q: p.q1, note: `자금의 1/${D.C.splits}${p.sig ? ' · ' + p.sig.name : ''}` });
    buy.push({ lbl: '2차 매수', p: p.add2, q: p.q2, note: '1차 뒤 전일 고가를 다시 넘을 때만', above: true });
    sell.push({ lbl: '손절 · 매수와 함께 등록', p: p.stop, q: p.qty, note: `${p.sig && p.sig.stopWhy || ''}${p.note ? ' (' + p.note + ')' : ''}`, stop: true, loss: p.loss });
    const qp = A.part && p.qty >= 3 ? Math.round(p.qty / 3) : 0, qt1 = qp ? Math.round((p.qty - qp) / 2) : Math.ceil(p.qty / 2), qt2 = p.qty - qp - qt1;
    if (qp) sell.push({ lbl: '일부 익절 · 호가', p: A.part.p, q: qp, note: A.part.how, ob: true });
    sell.push(A.t1 ? { lbl: `1차 목표 · ${qp ? '1/3' : '절반'}(호가 반영)`, p: A.t1.p, q: qt1, note: A.t1.how, ob: true } : { lbl: `1차 목표 · ${qp ? '1/3' : '절반'}`, p: p.t1, q: qt1, note: `손익비 1:2${p.res ? ` · 위 저항 ${tmW(p.res)}` : ''}` });
    sell.push({ lbl: '2차 목표 · 나머지', p: p.t2, q: qt2, note: `또는 고점 대비 −${D.C.trail}% 트레일링` });
  }
  return { buy, sell };
}
function tmRowHtml(r, D, side) {
  const d = (r.p / D.P - 1) * 100;
  return `<div class="tk-row ${side}${r.stop ? ' stop' : ''}">
    <div class="tk-lbl">${esc(r.lbl.replace(/ · 호가 반영|\(호가 반영\)| · 호가$/, ''))}${r.ob ? '<em class="tk-ob">호가</em>' : ''}<small>${esc(r.note || '')}</small></div>
    <div class="tk-num"><b>${fmt(Math.round(r.p))}</b><span>${r.above ? '이상' : Math.abs(d) < 0.05 ? '현재가' : pct(d, 1)}</span></div>
    <div class="tk-qty"><b>${r.q === D.plan?.qty && r.stop ? '전량' : fmt(r.q) + '주'}</b><span>${r.loss ? '−' + hMoney(r.loss) : hMoney(r.q * r.p)}</span></div>
  </div>`;
}
/* 주문할 게 없을 때: 무엇을 기다리는지 */
function tmWaitHtml(D) {
  const R = D.R, near = R.buys.filter(b => b.state === 'near' && b.entry);
  const items = [...(D.wait || []), ...near.map(b => `${b.name}: ${b.trigger || ''} ${tmW(b.entry)} 매수 · 손절 ${tmW(b.stop)}`)];
  if (!R.trend.ok) items.unshift(`추세 회복: 종가가 20일선 ${tmW(R.ma20)} 위에 있고 20일선이 오르기 시작할 때`);
  return `<div class="tk-orders"><h4 class="tk-side idle">기다릴 조건</h4>${items.length ? `<ul class="tk-wait">${[...new Set(items)].map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="tk-basis">매수 신호가 나오면 이 자리에 주문표가 나와요.</p>'}${D.why.length ? `<p class="tk-basis">${D.why.map(esc).join(' / ')}</p>` : ''}</div>`;
}
function tmTicketHtml(D) {
  const { buy, sell } = tmRows(D);
  if (!buy.length && !sell.length) return '';
  const p = D.plan, dim = D.act === 'NO' || D.act === 'WATCH';
  return `<div class="tk-orders${dim ? ' dim' : ''}">
    ${dim && p ? '<p class="tk-note">금지 사유가 풀렸을 때 쓸 참고 계획이에요. 지금은 주문하지 않아요.</p>' : ''}
    ${buy.length ? `<h4 class="tk-side buy">매수</h4>${buy.map(r => tmRowHtml(r, D, 'buy')).join('')}` : ''}
    ${sell.length ? `<h4 class="tk-side sell">매도</h4>${sell.map(r => tmRowHtml(r, D, 'sell')).join('')}` : ''}
    ${p ? `<p class="tk-basis">수량은 계좌 ${hMoney(p.A)} 기준으로 「손절 한 번에 계좌의 ${D.C.maxLoss}% 이내」와 「한 종목 ${D.C.maxPos}% 이내」 중 작은 쪽이에요${p.mult < 1 ? `. 시장·일정·물량 위험 때문에 ×${fmt(p.mult, 2)}로 줄였어요` : ''}. 총 ${fmt(p.qty)}주, ${hMoney(p.amt)}.</p>` : ''}
  </div>`;
}

/* 세로 가격 사다리 — 위는 목표, 아래는 손절, 가운데 지금 가격 */
function tmLadder(D) {
  const L = [];
  if (D.mode === 'hold') L.push(['2차 목표', D.t2, 'sell'], ['1차 목표', D.t1, 'sell'], ['평단', D.avg, 'avg'], [D.effWhy.startsWith('트레일링') ? '트레일링' : '손절', D.eff, 'stop']);
  else if (D.plan) { const p = D.plan; L.push(['2차 목표', p.t2, 'sell'], ['1차 목표', p.t1, 'sell'], [D.act === 'BUY' ? '매수' : '지정가', p.E, 'buy'], ['손절', p.stop, 'stop']); if (p.add2 > p.E * 1.002) L.push(['2차 매수', p.add2, 'buy']); }
  else L.push(['60일 고점', D.R.hi60, 'ref'], ['20일선', D.R.ma20, 'ref'], ['60일선', D.R.ma60, 'ref']);
  if (D.ob && D.ob.adj.buy && D.plan && D.ob.adj.buy.p !== D.plan.E) L.push(['호가 매수', D.ob.adj.buy.p, 'buy']);
  if (D.ob && D.ob.adj.part) L.push(['일부 익절', D.ob.adj.part.p, 'sell']);
  L.push(['지금', D.P, 'now']);
  L.sort((a, b) => b[1] - a[1]);
  return `<aside class="tk-ladder" aria-label="가격 위치"><h4>가격 위치</h4>${L.map(([n, v, k]) => `<div class="ld ${k}"><span class="ld-n">${n}</span><b class="ld-p">${fmt(Math.round(v))}</b><span class="ld-d">${k === 'now' ? `<em class="${cls(D.ctx.chg)}">${pct(D.ctx.chg, 1)}</em>` : pct((v / D.P - 1) * 100, 1)}</span></div>`).join('')}</aside>`;
}

function tmSigHtml(R) {
  const row = x => `<li class="sg ${x.state}"><i></i><div><b>${esc(x.name)}</b> ${tmStTag(x.state)}<small class="sg-id">${x.id}</small><p>${esc(x.why || '')}</p>${x.entry && (x.state === 'on' || x.state === 'near') ? `<p class="sg-px">매수 ${tmW(x.entry)} · 손절 ${tmW(x.stop)}${x.trigger ? ` · ${esc(x.trigger)}` : ''}</p>` : ''}${x.act && (x.state === 'on' || x.state === 'warn') ? `<p class="sg-px">대응: ${esc(x.act)}</p>` : ''}</div></li>`;
  return `<div class="sg-trend ${R.trend.ok ? 'ok' : 'bad'}"><b>${R.trend.ok ? '추세 필터 통과' : '추세 필터 실패'}</b><span>${esc(R.trend.why)}</span>${R.trend.ok ? '' : '<span>매수 신호는 모두 무시하고 매도 신호만 봐요. 과매도 되돌림만 「20일선 우상향 + 60일선 위」로 따로 확인해요.</span>'}</div>
    <div class="sg-cols"><div><h4 class="tk-side buy">매수 신호</h4><ul class="sg-list">${R.buys.map(row).join('')}</ul></div>
    <div><h4 class="tk-side sell">매도 신호</h4><ul class="sg-list sells">${R.sells.map(row).join('')}</ul></div></div>
    <p class="tk-basis">5일선 ${tmW(R.ma5)}, 20일선 ${tmW(R.ma20)}, 60일선 ${tmW(R.ma60)}, RSI ${fmt(R.rsi, 0)}, 스토캐스틱 ${fmt(R.k, 0)}/${fmt(R.dd, 0)}, 거래량은 평소의 ${fmt(R.vr || 0, 1)}배${R.partial ? '(장중이라 하루치로 추정)' : ''}.</p>`;
}

function tmNewsHtml(D) {
  const ev = TM.ev.get(D.code), cx = D.ctx;
  const kName = { risk: '악재·물량', good: '호재', sched: '일정' };
  const co = TM.co.get(D.code), tgt = co && co.consensus && co.consensus.target ? Number(String(co.consensus.target).replace(/[^\d.]/g, '')) : null;
  const item = (x, k, tag) => `<li class="nw ${k}"><time>${esc(x.d.slice(5, 10).replace('-', '.'))} ${esc(x.d.slice(11, 16))}</time>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.t)}</a>` : `<span>${esc(x.t)}</span>`}${tag ? `<em class="${k}">${tag}</em>` : ''}${x.by ? `<small>${esc(x.by)}</small>` : ''}</li>`;
  const dis = ev ? ev.dis.slice(0, 8) : [], news = ev ? ev.news.slice(0, 8) : [];
  const s = D.s;
  const facts = [];
  if (tgt) facts.push(['증권사 평균 목표가', `${tmW(tgt)} (${tmP(tgt, D.P)})`]);
  if (s && s.foreign_streak != null) facts.push(['외국인', s.foreign_streak > 0 ? `${s.foreign_streak}일 연속 순매수` : s.foreign_streak < 0 ? `${-s.foreign_streak}일 연속 순매도` : '방향 없음']);
  if (s && s.inst_streak != null) facts.push(['기관', s.inst_streak > 0 ? `${s.inst_streak}일 연속 순매수` : s.inst_streak < 0 ? `${-s.inst_streak}일 연속 순매도` : '방향 없음']);
  if (s && s.short_ratio != null) facts.push(['공매도 잔고', `${fmt(s.short_ratio, 2)}%${s.short_chg != null ? ` (1주 ${s.short_chg > 0 ? '+' : ''}${fmt(s.short_chg, 2)}%p)` : ''}`]);
  if (s && s.cl) facts.push(['차트 종합판정', `${s.cl.v} ${s.cl.s > 0 ? '+' : ''}${fmt(s.cl.s, 1)}`]);
  return `<div class="nw-grid">
    <div><h4>결론에 넣은 것</h4>
      ${cx.plus.length || cx.minus.length ? `<ul class="pm">${cx.plus.map(t => `<li class="p">${esc(t)}</li>`).join('')}${cx.minus.map(t => `<li class="m">${esc(t)}</li>`).join('')}</ul>` : '<p class="tk-basis">눈에 띄는 수급·뉴스·공시 변화가 없어요.</p>'}
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    </div>
    <div><h4>최근 공시 <small>${ev ? esc(ev.at.slice(11)) + ' 확인' : '불러오는 중'}</small></h4>
      ${dis.length ? `<ul class="nw-list">${dis.map(x => { const k = tmClassDis(x.t); return item(x, k, kName[k]); }).join('')}</ul>` : `<p class="tk-basis">${ev ? '최근 공시가 없어요.' : ''}</p>`}
      <h4>종목 뉴스</h4>
      ${news.length ? `<ul class="nw-list">${news.map(x => item(x, TM_NNEG.test(x.t) ? 'risk' : TM_NPOS.test(x.t) ? 'good' : '', '')).join('')}</ul>` : `<p class="tk-basis">${ev ? '최근 뉴스가 없어요.' : ''}</p>`}
    </div></div>`;
}

function tmCalHtml(D) {
  const cal = D.ctx.cal, today = tmNow().date;
  if (!cal.length) return '<p class="tk-basis">45일 안에 눈에 띄는 일정이 없어요.</p>';
  return `<ol class="cal">${cal.map(x => { const cd = Math.round((new Date(x.d) - new Date(today)) / 864e5); const [t, sub] = x.t.split(' — '); return `<li class="${x.w >= 2 ? 'hot' : ''}${x.past || cd < 0 ? ' past' : ''}"><div class="cal-d"><b>${+x.d.slice(5, 7)}.${+x.d.slice(8, 10)}</b><span>${x.past || cd < 0 ? '지남' : cd === 0 ? '오늘' : 'D-' + cd}</span></div><div class="cal-t">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(t)}</a>` : esc(t)}${sub ? `<small>${esc(sub)}</small>` : ''}</div></li>`; }).join('')}</ol>
    <p class="tk-basis">실적 발표·FOMC·동시만기처럼 크게 흔들 수 있는 일정이 3거래일 안에 있으면 1차 매수 수량을 절반으로 줄여 계산해요.</p>`;
}

/* 판정 아래 한 줄: 수급 등급 · 지수 온도 */
function tmChipsHtml(D) {
  const F = D.ctx.flow, md = D.ctx.md, out = [];
  if (F && F.V) out.push(`<span class="md-tag ${'AB'.includes(F.V.g[0]) ? 'good' : 'DE'.includes(F.V.g[0]) ? 'bad' : ''}" data-tmgo="flow" role="button">수급 ${F.V.g[0]} · ${esc(F.a.rg[1])}</span>`);
  if (F && F.mult < 1) out.push(`<span class="md-tag warn" data-tmgo="flow" role="button">수급 반영 수량 ×${fmt(F.mult, 2)}</span>`);
  if (md) out.push(`<span class="md-tag ${md.temp >= 65 ? 'good' : md.temp < 40 ? 'bad' : ''}" data-tmgo="mood" role="button">${md.nm} ${md.temp}도 ${esc(md.L[1])}</span>`);
  return out.length ? `<div class="tk-mood">${out.join('')}</div>` : '';
}
/* 투자자 흐름 칸: 타이밍에 어떻게 반영했는지 + 종목 수급 카드 */
function tmFlowHtml(D) {
  const F = D.ctx.flow, md = D.ctx.md, s = D.s;
  const ap = [...(F ? F.applied : []), ...(D.ctx.mdA || [])];
  const box = ap.length ? `<div class="tm-flow"><h5>이 화면의 매수가·수량·타이밍에 반영한 내용</h5><ul>${ap.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>
    ${D.mode === 'hold' && F && F.hold.length ? `<h5 class="mt-s">보유 관리</h5><ul>${F.hold.map(t => `<li class="m">${esc(t)}</li>`).join('')}</ul>` : ''}
    <p class="tk-basis">수급 A·B는 가산, D는 1차 수량 ×0.75, 개인만 사는 종목은 ×0.5, E 또는 큰손 동반 이탈은 신규 매수 보류. 지수 온도 40도 아래면 ×0.75, 25도 아래면 보류. 손절가는 수급으로 바꾸지 않아요.</p></div>` : '';
  const mdc = md && typeof mdCard === 'function' ? `<div class="md-cards" style="grid-template-columns:1fr">${mdCard(md)}</div>` : '';
  const card = s && typeof invHtml === 'function' ? invHtml(s) : '<p class="tk-basis">투자자별 자료를 불러오는 중이에요.</p>';
  return `${box}${mdc}<div class="mt-s">${card}</div><p class="tk-basis"><button class="btn ghost small" data-tmgo="inv">투자자 흐름 탭에서 크게 보기 →</button></p>`;
}

function tmNoteHtml(D) {
  const n = D.note, best = D.mode === 'new' && D.plan ? D.plan : null;
  return `<div class="tm-note">${n ? `<p><b>${esc(n.t)}에 기록한 근거</b> ${esc(n.txt)}${n.stop ? `<br><small class="muted">기준선 ${tmW(n.stop)} 아래로 내려가면 「근거가 사라졌다」고 보고 매도를 권해요.</small>` : ''} <button class="btn ghost small" id="tmNoteDel">기록 지우기</button></p>` : '<p class="tk-basis">살 때 「왜 샀는지」 한 줄을 남겨두면, 그 근거가 깨질 때 매도 신호로 써요.</p>'}
    <div class="row gap wrap"><input id="tmNoteTxt" class="inp" style="flex:1;min-width:220px" placeholder="예) 20일선 눌림목 지지를 보고 1차 매수" value="${best && best.sig ? esc(`${best.sig.name} — ${tmW(best.E)} 매수, 손절 ${tmW(best.stop)}`) : ''}"><button class="btn small" id="tmNoteSave">근거 저장</button></div></div>`;
}

function tmRenderOne() {
  const box = $('#tmOne'); if (!box) return;
  const code = TM.sel; if (!code) { box.innerHTML = '<p class="tk-empty">위에서 종목을 검색하면 매수가·매도가와 타이밍을 계산해요.</p>'; return; }
  const ae = document.activeElement; if (ae && box.contains(ae) && /INPUT|TEXTAREA/.test(ae.tagName)) return;  // 입력 중이면 다시 그리지 않음
  const st = TM.st.get(code), s = S.data.stocks.find(x => x.code === code);
  if (!st || !st.f) { box.innerHTML = `<p class="tk-empty">${esc(s ? s.name : code)} ${st && st.err ? '— 일봉 자료가 없어 계산할 수 없어요. 분석 대상 892종목만 볼 수 있어요.' : '일봉 자료를 불러오는 중이에요.'}</p>`; return; }
  let D; try { D = tmDecide(code); } catch (e) { console.error(e); box.innerHTML = `<p class="tk-empty">계산하지 못했어요: ${esc(e.message)}</p>`; return; }
  if (!D) return;
  TM.lastD = D;
  const q = st.q, R = D.R, tone = tmTone(D.act);
  const watching = (store.get('tmWatch', []) || []).includes(code);
  const tm = D.mode === 'hold' ? D.ctx.timing.filter(t => !/^호재 뉴스가 몰리는|휴장 전날|^최근 물량 공시|지수 온도/.test(t) && !(D.ctx.flow && D.ctx.flow.timing.includes(t))).map(t => t.replace(/→ 1차 비중을 절반으로, 또는 발표 뒤 반응 보고 진입/, '→ 발표 전후로 크게 흔들릴 수 있어요. 손절선을 다시 확인하세요')) : D.ctx.timing;
  const warns = [...(D.bans || []).map(t => ['no', t]), ...tm.map(t => ['warn', t]), ...(D.ob ? D.ob.notes.map(t => ['ob', '호가: ' + t]) : [])];
  const nOn = R.buys.filter(b => b.state === 'on').length + R.sells.filter(b => b.state === 'on').length;
  const nCal = D.ctx.cal.filter(x => !x.past && x.d >= tmNow().date).length;
  const pane = TM.pane || 'sig';
  const FV = D.ctx.flow && D.ctx.flow.V;
  const panes = [['sig', '규칙 판정', nOn ? `발생 ${nOn}` : ''], ['flow', '투자자 흐름', FV ? FV.g[0] : ''], ['news', '최신 상황', ''], ['cal', '일정', nCal ? String(nCal) : ''], ['note', '매수 근거', D.note ? '기록됨' : '']];
  box.innerHTML = `<article class="tk">
    <header class="tk-head">
      <div class="tk-id"><h3>${esc(s ? s.name : code)}</h3><p>${esc(code)} · ${s ? (s.market === 'KOSPI' ? '코스피' : '코스닥') : ''}${s && s.sector ? ' · ' + esc(s.sector) : ''}</p>
        <p>${D.hold ? `<span class="own">보유 ${fmt(D.hold.qty)}주 · 평단 ${tmW(D.hold.avg)} · <b class="${cls(D.P - D.hold.avg)}">${pct((D.P / D.hold.avg - 1) * 100, 1)}</b></span>` : '<span class="own none">보유하지 않음</span>'}</p></div>
      <div class="tk-px"><b class="${cls(D.ctx.chg)}">${fmt(D.P)}</b><span class="${cls(D.ctx.chg)}">${pct(D.ctx.chg, 2)}</span>
        <small>${q && q.price ? `<span class="gov-live"></span>${esc(String(q.at || '').slice(11, 19))} 시세` : '종가 기준'}${D.partial ? ' · 장중 잠정' : ''}</small></div>
      <div class="tk-btns"><button class="btn ghost small" id="tmAn">종목 분석</button>${D.hold ? '' : `<button class="btn ghost small" id="tmW">${watching ? '★ 관심 종목' : '☆ 관심 추가'}</button>`}</div>
    </header>
    <section class="tk-verdict v-${tone}">
      <div class="tk-act">${esc((TM_ACT[D.act] || [''])[0])}</div>
      <p class="tk-head2">${esc(D.head.replace(/^[^—]{1,14}\s—\s/, ''))}</p>
      <p class="tk-sum">${esc(tmOneLine(D))}</p>
      <p class="tk-when"><b>언제</b>${esc(D.timing)}</p>
      ${D.add ? `<p class="tk-add ${D.add.ok ? 'ok' : 'no'}">${esc(D.add.t)}</p>` : ''}
      ${tmChipsHtml(D)}
      ${warns.length ? `<ul class="tk-warn">${warns.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>` : ''}
    </section>
    <section class="tk-body">${tmTicketHtml(D) || tmWaitHtml(D)}<div class="tk-col">${tmLadder(D)}${tmBookHtml(D)}</div></section>
    ${tmTicketHtml(D) && (D.why.length || (D.wait && D.wait.length)) ? `<div class="tk-reason">${D.why.length ? `<p><b>판단 근거</b> ${D.why.map(esc).join(' / ')}</p>` : ''}${D.wait && D.wait.length ? `<p><b>기다릴 조건</b> ${D.wait.map(esc).join(' / ')}</p>` : ''}</div>` : ''}
    <div class="tk-chart"><canvas id="tmCv" aria-label="최근 90일 종가와 이동평균선, 매수·손절·목표 가격"></canvas></div>
    <nav class="tk-tabs" role="tablist">${panes.map(([k, n, b]) => `<button role="tab" aria-selected="${k === pane}" data-pane="${k}">${n}${b ? `<span>${b}</span>` : ''}</button>`).join('')}</nav>
    <div class="tk-pane">${pane === 'sig' ? tmSigHtml(R) : pane === 'flow' ? tmFlowHtml(D) : pane === 'news' ? tmNewsHtml(D) : pane === 'cal' ? tmCalHtml(D) : tmNoteHtml(D)}</div>
    <p class="tk-foot">정해진 규칙을 그대로 계산한 참고 자료예요. 기술적 분석은 확률이라 틀릴 수 있고, 매매 판단과 책임은 본인에게 있어요.</p>
  </article>`;
  const b = $('#tmAn'); if (b) b.onclick = () => showAnalysis(code);
  const w = $('#tmW'); if (w) w.onclick = () => tmToggleWatch(code);
  $$('#tmOne [data-pane]').forEach(x => x.onclick = () => { TM.pane = x.dataset.pane; store.set('tmPane', TM.pane); tmRenderOne(); });
  $$('#tmOne [data-md]').forEach(x => x.onclick = () => { if (typeof MOOD !== 'undefined') MOOD.sel = x.dataset.md; switchTab('mood'); if (typeof renderMoodTab === 'function') renderMoodTab(); });
  $$('#tmOne [data-tmgo]').forEach(x => x.onclick = () => { const g = x.dataset.tmgo; if (g === 'flow') { TM.pane = 'flow'; store.set('tmPane', 'flow'); tmRenderOne(); const t = $('#tmOne .tk-tabs'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } else if (g === 'mood') switchTab('mood'); else if (g === 'inv') { switchTab('inv'); if (typeof ivSelect === 'function') ivSelect(code); } });
  const ns = $('#tmNoteSave'); if (ns) ns.onclick = () => {
    const txt = $('#tmNoteTxt').value.trim(); if (!txt) return;
    const all = tmNotes(), best = D.plan && D.plan.sig ? D.plan : null;
    all[code] = { t: tmNow().date, txt, id: best ? best.sig.id : null, stop: best ? best.stop : (D.mode === 'hold' ? D.eff : null), entry: best ? best.E : null };
    store.set('tmNotes', all); $('#tmNoteTxt').blur(); tmRenderOne();
  };
  const nd = $('#tmNoteDel'); if (nd) nd.onclick = () => { const all = tmNotes(); delete all[code]; store.set('tmNotes', all); tmRenderOne(); };
  tmDraw(D);
}

function tmDraw(D) {
  if (TM.chart) { try { TM.chart.destroy(); } catch (e) {} TM.chart = null; }
  const cv = $('#tmCv'); if (!cv || !window.Chart) return;
  const R = D.R, B = R.B, N = B.c.length, k = Math.min(90, N), sl = a => a.slice(N - k);
  const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim() || '#888';
  const lines = [];
  const hl = (lbl, v, c, dash) => v && lines.push({ label: lbl, data: Array(k).fill(v), borderColor: c, borderWidth: 1.4, borderDash: dash || [6, 4], pointRadius: 0, fill: false });
  if (D.mode === 'hold') { hl('손절·트레일링', D.eff, col('--down')); hl('평단', D.avg, col('--muted'), [2, 3]); hl('1차 목표', D.t1, col('--down'), [2, 2]); }
  else if (D.plan) { hl('손절', D.plan.stop, col('--down')); hl('매수', D.plan.E, col('--up'), [2, 3]); hl('1차 목표', D.plan.t1, col('--down'), [2, 2]); }
  TM.chart = new Chart(cv, {
    type: 'line',
    data: { labels: sl(B.d).map(d => `${+d.slice(5, 7)}.${+d.slice(8, 10)}`), datasets: [
      { label: '종가', data: sl(B.c), borderColor: col('--text'), borderWidth: 1.8, pointRadius: 0, fill: false },
      { label: '20일선', data: sl(R.I.ma20), borderColor: col('--warn'), borderWidth: 1.4, pointRadius: 0, fill: false },
      { label: '60일선', data: sl(R.I.ma60), borderColor: col('--muted'), borderWidth: 1, pointRadius: 0, fill: false },
      ...lines] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 2, color: col('--muted'), font: { size: 11 } } }, tooltip: { callbacks: { label: c => `${c.dataset.label} ${fmt(Math.round(c.raw))}` } } },
      scales: { x: { grid: { display: false }, ticks: { color: col('--muted'), maxTicksLimit: 7, font: { size: 10 } } }, y: { position: 'right', grid: { color: col('--line') }, ticks: { color: col('--muted'), font: { size: 10 }, callback: v => fmt(v) } } } },
  });
}

/* 보유·관심 종목 줄 (주문창의 관심종목 목록처럼 가로로) */
function tmRenderList() {
  const box = $('#tmList'); if (!box) return;
  const { hs, all } = tmCodes();
  if (!all.length) { box.innerHTML = '<p class="tk-basis">「내 보유 종목」에 기록한 종목과 ☆ 관심 종목이 여기에 모여요.</p>'; return; }
  box.innerHTML = all.map(code => {
    const s = S.data.stocks.find(x => x.code === code); let D = null;
    try { D = TM.st.get(code) && TM.st.get(code).f ? tmDecide(code) : null; } catch (e) { console.error(e); }
    const key = D ? (D.mode === 'hold' ? `손절 ${fmt(D.eff)} · 목표 ${fmt(D.t1)}` : D.plan ? `매수 ${fmt(D.plan.E)} · 손절 ${fmt(D.plan.stop)}` : `20일선 ${fmt(Math.round(D.R.ma20))}`) : '계산 중';
    return `<button class="wl ${TM.sel === code ? 'on' : ''} t-${D ? tmTone(D.act) : 'idle'}" data-tm="${esc(code)}">
      <span class="wl-top"><b>${esc(s ? s.name : code)}</b><small>${hs.includes(code) ? '보유' : '관심'}</small></span>
      <span class="wl-px">${D ? `${fmt(D.P)} <em class="${cls(D.ctx.chg)}">${pct(D.ctx.chg, 1)}</em>` : '–'}</span>
      <span class="wl-act">${D ? (TM_ACT[D.act] || [''])[0] : ''}</span>
      <span class="wl-key">${key}</span>
      ${hs.includes(code) ? '' : `<span class="wl-x" data-tmx="${esc(code)}" role="button" aria-label="관심 종목에서 빼기" title="관심 종목에서 빼기">×</span>`}
    </button>`;
  }).join('');
  $$('#tmList [data-tm]').forEach(el => el.onclick = e => { if (e.target.closest('[data-tmx]')) return; tmSelect(el.dataset.tm); });
  $$('#tmList [data-tmx]').forEach(el => el.onclick = e => { e.stopPropagation(); tmToggleWatch(el.dataset.tmx); });
}

/* ── 자료 받기 ── */
async function tmLoadBars(code) {
  const st = TM.st.get(code) || {}; TM.st.set(code, st);
  const t = (typeof CLX !== 'undefined' && CLX.live && CLX.live.meta.time) || '';
  if (st.f && st.ft === t) return st;
  const f = typeof clxLoad === 'function' ? await clxLoad(code) : null;
  if (f && f.c && f.c.length >= 70) { st.f = f; st.ft = t; }
  else if (!st.f) st.err = '일봉 자료 없음';
  return st;
}
async function tmQuote(code) {
  const st = TM.st.get(code) || {}; TM.st.set(code, st);
  try { const r = await fetch('/api/hoga?code=' + code, { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j.quote && j.quote.price) st.q = { ...j.quote, at: j.at }; if (j.book) tmBookUpdate(st, j); } } catch (e) {}
  st.qt = Date.now();
  return st;
}
async function tmEvents(code, force) {
  const e = TM.ev.get(code);
  if (!force && e && Date.now() - e._t < 5 * 60e3) return;
  try { const r = await fetch('/api/events?code=' + code); if (r.ok) { const j = await r.json(); j._t = Date.now(); j.dis = j.dis || []; j.news = j.news || []; TM.ev.set(code, j); } } catch (err) {}
  if (!TM.co.has(code)) { try { const r = await fetch('/api/company?code=' + code); if (r.ok) TM.co.set(code, await r.json()); } catch (err) {} }
}

async function tmSelect(code, quiet) {
  TM.sel = code; store.set('tmSel', code); tmStatus();
  if (!quiet) { try { history.replaceState({ tab: 'timing' }, '', '#timing/' + code); } catch (e) {} }
  tmRenderList(); tmRenderOne();
  await tmLoadBars(code); tmRenderOne();
  await tmQuote(code); tmRenderOne(); tmRenderList(); tmStatus();
  await tmEvents(code); if (TM.sel === code) { tmRenderOne(); tmRenderList(); }
}
function tmToggleWatch(code) {
  let w = store.get('tmWatch', []) || [];
  w = w.includes(code) ? w.filter(c => c !== code) : [...w, code].slice(-30);
  store.set('tmWatch', w);
  tmLoadBars(code).then(() => { tmRenderList(); });
  tmRenderList(); if (TM.sel === code) tmRenderOne();
}
function tmFind() {
  const q = ($('#tmQ').value || '').trim(); if (!q) return;
  const hits = typeof findStocks === 'function' ? findStocks(q) : [];
  if (!hits.length) { $('#tmOne').innerHTML = `<div class="empty">"${esc(q)}"과(와) 맞는 종목이 없어요.</div>`; return; }
  tmSelect(hits[0].code);
}
/* 다른 화면에서 바로 열기 (보유 종목 카드 · 종목 분석) */
function openTiming(code) { switchTab('timing'); tmSelect(code); }

function tmStatus() {
  const el = $('#tmStatus'); if (!el) return;
  const mk = tmMarket(), st = TM.sel && TM.st.get(TM.sel), q = st && st.q;
  const lbl = { open: '<span class="gov-live"></span> 장중이에요. 현재가는 10초마다, 일봉은 15분마다 다시 계산해요.', pre: '장 시작 전이에요. 마지막 거래일 종가로 계산했어요.', after: '장이 끝났어요. 오늘 종가로 신호가 확정됐어요.', closed: '오늘은 휴장일이에요. 마지막 거래일 종가로 계산했어요.' }[mk.st];
  el.innerHTML = `${lbl}${q && q.at ? ` 마지막 시세 ${esc(String(q.at).slice(11, 19))}.` : ''}`;
}

/* ── 실시간 루프 ── */
async function tmLoop() {
  tmStatus();
  const on = $('#tab-timing') && $('#tab-timing').classList.contains('on');
  if (!on || document.hidden || TM.busy || !S.data) return;
  TM.busy = true;
  try {
    const mk = tmMarket(), live = mk.st === 'open', now = Date.now();
    const { all } = tmCodes();
    // 15분마다 새 일봉
    for (const c of [TM.sel, ...all].filter(Boolean)) { const st = TM.st.get(c); const t = (typeof CLX !== 'undefined' && CLX.live && CLX.live.meta.time) || ''; if (!st || !st.f || st.ft !== t) { await tmLoadBars(c); } }
    // 선택 종목: 장중 10초, 그 밖엔 3분
    if (TM.sel) { const st = TM.st.get(TM.sel); if (!st || !st.qt || now - st.qt >= (live ? 5e3 : 180e3)) { await tmQuote(TM.sel); tmRenderOne(); } tmEvents(TM.sel).then(() => {}); }
    // 목록: 한 번에 한 종목씩 돌아가며 (장중 1종목/5초)
    const others = all.filter(c => c !== TM.sel);
    if (others.length) { const c = others[TM.rot++ % others.length], st = TM.st.get(c); if (!st || !st.qt || now - st.qt >= (live ? 30e3 : 600e3)) await tmQuote(c); }
    tmRenderList();
  } catch (e) { console.error(e); }
  TM.busy = false;
}

function tmCfgHtml() {
  const C = tmCfg();
  const F = [['stop', '손절 %', 1], ['target', '목표 %', 1], ['trail', '트레일링 %', 1], ['trailTight', '과열 시 트레일링 %', 1], ['maxPos', '종목당 최대 비중 %', 1], ['maxLoss', '1회 최대 손실(계좌 %)', 0.5], ['splits', '분할 횟수', 1],
    ['pbSurge', '눌림목: 급등 기준 %', 1], ['boVol', '돌파: 거래량 배수', 0.5], ['boBody', '돌파: 몸통 %', 0.5], ['spikeVol', '고점 거래량 배수', 0.5], ['rsiOB', '과열 RSI', 1], ['osLo', '과매도 RSI 하한', 1], ['osHi', '과매도 RSI 상한', 1]];
  return `<div class="tm-cfg">${F.map(([k, n, s]) => `<label class="small">${n}<input class="inp" type="number" step="${s}" data-tmc="${k}" value="${C[k]}"></label>`).join('')}</div><div class="row gap mt-s"><button class="btn ghost small" id="tmCfgReset">기본값으로</button><span class="hint">바꾸면 바로 다시 계산해요 (이 기기에 저장)</span></div>`;
}
function initTiming() {
  if (!$('#tab-timing')) return;
  TM.pane = store.get('tmPane', 'sig');
  $('#tmGo').onclick = tmFind;
  $('#tmQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); tmFind(); } };
  $('#tmAddW').onclick = () => { const q = ($('#tmQ').value || '').trim(); const h = q ? findStocks(q) : []; const c = h.length ? h[0].code : TM.sel; if (c) { const w = store.get('tmWatch', []) || []; if (!w.includes(c)) tmToggleWatch(c); tmSelect(c); } };
  $('#tmRefresh').onclick = async () => { if (!TM.sel) return; await tmQuote(TM.sel); await tmEvents(TM.sel, true); tmRenderOne(); tmRenderList(); };
  const ac = $('#tmAcct'); ac.value = tmAcct();
  ac.onchange = () => { const v = Number(ac.value); const c = store.get('tmCfg', {}) || {}; c.account = v > 0 ? v : null; store.set('tmCfg', c); tmRenderOne(); tmRenderList(); };
  $('#tmCfgF').innerHTML = tmCfgHtml();
  $$('#tmCfgF [data-tmc]').forEach(el => el.onchange = () => { const c = store.get('tmCfg', {}) || {}; const v = Number(el.value); if (Number.isFinite(v)) c[el.dataset.tmc] = v; store.set('tmCfg', c); tmRenderOne(); tmRenderList(); });
  $('#tmCfgReset').onclick = () => { const c = store.get('tmCfg', {}) || {}; store.set('tmCfg', { account: c.account || null }); $('#tmCfgF').innerHTML = tmCfgHtml(); initTimingCfgBind(); tmRenderOne(); tmRenderList(); };
  const h = decodeURIComponent((location.hash || '').slice(1));
  const start = h.startsWith('timing/') ? h.split('/')[1] : store.get('tmSel', null) || tmCodes().all[0];
  if (h.startsWith('timing/')) switchTab('timing', true);
  tmCodes().all.forEach(c => tmLoadBars(c).then(() => tmRenderList()));
  if (start) tmSelect(start, true); else tmRenderList();
  setInterval(tmLoop, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tmLoop(); });
  const tb = $('button[data-tab="timing"]'); if (tb) tb.addEventListener('click', () => setTimeout(tmLoop, 50));
}
function initTimingCfgBind() { $$('#tmCfgF [data-tmc]').forEach(el => el.onchange = () => { const c = store.get('tmCfg', {}) || {}; const v = Number(el.value); if (Number.isFinite(v)) c[el.dataset.tmc] = v; store.set('tmCfg', c); tmRenderOne(); tmRenderList(); }); $('#tmCfgReset').onclick = () => { const c = store.get('tmCfg', {}) || {}; store.set('tmCfg', { account: c.account || null }); $('#tmCfgF').innerHTML = tmCfgHtml(); initTimingCfgBind(); tmRenderOne(); tmRenderList(); }; }
(function waitBootTm() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof clxLoad === 'function' && typeof switchTab === 'function' && $('#tab-timing')) initTiming();
  else setTimeout(waitBootTm, 500);
})();
