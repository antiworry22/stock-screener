/* 매매 타이밍 — 「매수·매도 타이밍 시그널 스펙」 규칙 엔진
   ① 추세 필터(최상위 관문) → ② 매수 신호 BUY-01~04 / 매도 신호 SELL-01~05 → ③ 손절가 먼저 → 수량(계좌 2% 손실·종목 30% 상한, 2회 분할)
   ④ 보유 중이면 「손절 > 매도 신호 > 관망 > 매수」 순서로 평가 ⑤ 최신 공시·뉴스·수급·공매도·일정까지 넣어 최종 결론(매수가·매도가·타이밍)
   시세: 일봉(보관 칸 live-cl/{code}.json, 장중 15분마다 오늘 봉 포함) + 실시간 현재가(/api/hoga, 장중 10초마다)로 오늘 봉을 바로 고쳐 다시 계산 */
'use strict';

const TM = { sel: null, st: new Map(), ev: new Map(), co: new Map(), chart: null, busy: false, lastQ: 0, rot: 0 };
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
function tmCalendar(today, dis) {
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
  if (s && s.cl) { const t = `차트 종합판정 ${s.cl.v}(${s.cl.s > 0 ? '+' : ''}${fmt(s.cl.s, 1)})`; if (s.cl.s >= 28) plus.push(t); else if (s.cl.s <= -28) minus.push(t); }
  if (s) {
    if (s.foreign_streak >= 3) plus.push(`외국인 ${s.foreign_streak}일 연속 순매수`); else if (s.foreign_streak <= -3) minus.push(`외국인 ${-s.foreign_streak}일 연속 순매도`);
    if (s.inst_streak >= 3) plus.push(`기관 ${s.inst_streak}일 연속 순매수`); else if (s.inst_streak <= -3) minus.push(`기관 ${-s.inst_streak}일 연속 순매도`);
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
  const n24 = news.filter(x => x.d >= tmAdd(today, -1)), pos24 = n24.filter(x => TM_NPOS.test(x.t)).length, neg24 = n24.filter(x => TM_NNEG.test(x.t)).length;
  const chg = R ? (R.P / R.B.c[R.n - 1] - 1) * 100 : 0;
  if ((n24.length >= 6 && pos24 > neg24) || (s && s._nw && s._nw.nPos >= 3)) {
    if (chg >= 5) bans.push(`호재 뉴스가 쏟아지는 날(24시간 ${n24.length}건) +${fmt(chg, 1)}% 급등 — 추격 매수 금지(금지 규칙 4). 뉴스는 분배(매도) 신호인 경우가 많아요`);
    else timing.push(`호재 뉴스가 몰리는 중${n24.length >= 6 ? `(24시간 ${n24.length}건)` : ''} — 뉴스 따라 추격하지 말고 계획한 가격에서만`);
  }
  // 일정
  const cal = tmCalendar(today, dis);
  const soon = cal.filter(x => !x.past && x.w >= 2 && tmBizBetween(today, x.d) <= 3);
  if (soon.length) { mult *= 0.5; soon.forEach(x => timing.push(`${x.d.slice(5)} ${x.t.split(' — ')[0]} 앞둠 → 1차 비중을 절반으로, 또는 발표 뒤 반응 보고 진입`)); }
  const hol = cal.find(x => x.kind === 'hol' && tmBizBetween(today, x.d) <= 1 && x.d > today);
  if (hol) timing.push(`${hol.d.slice(5)} 휴장 전날 — 신규 매수는 휴장 뒤로 미루는 편이 안전`);
  return { plus, minus, bans, timing, mult, cal, risk, good, n24: n24.length, chg };
}

/* ── 최종 결론 ── */
function tmDecide(code) {
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
  } else { act = 'WATCH'; tone = 'low'; head = '관찰 — 추세는 살아 있지만 매수 신호(눌림·돌파·쉼 후 재상승·과매도) 없음'; wait.push(`눌림목 대기: 20일선 ${tmW(R.ma20)} 부근까지 내려와 지지하면 BUY-01 검토`); }
  let timing = '';
  if (act === 'BUY') timing = confirmTxt;
  else if (act === 'WAIT') timing = `지정가 대기 — ${plan.sig.trigger || '조건 충족 시'} ${tmW(plan.E)}에 1차(${plan.q1}주). 체결 후 바로 손절 ${tmW(plan.stop)} 주문 함께`;
  else if (act === 'NO') timing = '지금은 사지 않음 — 금지 사유가 풀릴 때까지 기다림';
  else timing = '매수 신호가 나올 때까지 관찰 — 이 화면이 실시간으로 다시 판정해요';
  Object.assign(D, { mode: 'new', act, tone, head, plan, why, wait, bans, timing, P: R.P });
  return D;
}

/* ═════════════ 화면 ═════════════ */
const TM_ACT = { BUY: ['지금 1차 매수', 'good'], WAIT: ['지정가 대기', 'mid'], WATCH: ['관찰', 'low'], NO: ['매수 금지', 'bad'], HOLD: ['보유 유지', 'ok'], TAKE: ['이익 실현', 'good'], HALF: ['절반 매도', 'bad'], PART: ['분할 매도', 'warn'], EXIT: ['전량 매도', 'bad'] };
const tmTag = a => { const x = TM_ACT[a] || ['–', 'low']; return `<span class="tm-act ${x[1]}">${x[0]}</span>`; };
const tmStTag = st => ({ on: '<span class="tm-st on">발생</span>', near: '<span class="tm-st near">대기·근접</span>', warn: '<span class="tm-st warn">주의</span>', void: '<span class="tm-st void">무효</span>' }[st] || '<span class="tm-st off">없음</span>');
function tmCodes() {
  const hs = typeof hLoad === 'function' ? [...new Set(hLoad().items.filter(h => tmHold(h.code)).map(h => h.code))] : [];
  const ws = (store.get('tmWatch', []) || []).filter(c => !hs.includes(c));
  return { hs, ws, all: [...hs, ...ws] };
}

function tmOneLine(D) {
  const nm = D.s ? D.s.name : D.code;
  if (D.mode === 'hold') {
    const o = D.orders[0];
    if (D.act === 'HOLD') return `${nm} ${D.qty}주 보유(평단 ${tmW(D.avg)}, ${pct(D.pnl, 1)}) — 지금은 보유. ${tmW(D.eff)} 아래로 내려가면 전량 매도(${D.effWhy}), ${tmW(D.t1)}에서 ${Math.ceil(D.qty / 2)}주 이익 실현, 나머지는 ${tmW(D.t2)} 또는 트레일링 이탈 때 매도.${D.add ? ' ' + D.add.t + '.' : ''}`;
    return `${nm} ${D.qty}주 보유(평단 ${tmW(D.avg)}, ${pct(D.pnl, 1)}) — ${D.head}. ${o ? `${o[1]}주를 ${tmW(o[2])} 근처에서 매도(약 ${hMoney ? hMoney(o[1] * o[2]) : tmW(o[1] * o[2])})` : ''}${D.orders[1] ? `, 남은 ${D.orders[1][1]}주는 ${tmW(D.orders[1][2])} 기준으로 관리` : ''}.`;
  }
  const p = D.plan;
  if (D.act === 'BUY' && p) return `${nm} — 지금 ${p.q1}주(약 ${hMoney(p.amt1)}) 1차 매수, 손절 ${tmW(p.stop)}(${pct(p.stopPct, 1)}), ${tmW(p.t1)}에서 절반 매도, 나머지는 ${tmW(p.t2)} 또는 고점 대비 −${D.C.trail}% 트레일링. 2차 ${p.q2}주는 다음 날 ${tmW(p.add2)}(오늘 고가) 위로 다시 올라설 때.`;
  if (D.act === 'WAIT' && p) return `${nm} — 지금은 사지 않고 ${p.sig.trigger || ''} ${tmW(p.E)}에 ${p.q1}주 지정가. 체결되면 손절 ${tmW(p.stop)}, 목표 ${tmW(p.t1)}(절반)·${tmW(p.t2)}.`;
  if (D.act === 'NO') return `${nm} — 지금은 사지 않아요(위 금지 사유).${p ? ` 금지 사유가 풀리면 기준가 ${tmW(p.E)} · 손절 ${tmW(p.stop)}.` : ''}`;
  return `${nm} — ${D.head}. ${D.wait && D.wait[0] ? D.wait[0] : ''}`;
}

function tmLadder(D) {
  const pts = [];
  if (D.mode === 'hold') { pts.push(['손절/트레일링', D.eff, 'st'], ['평단', D.avg, 'av'], ['1차 목표', D.t1, 't'], ['2차 목표', D.t2, 't']); }
  else if (D.plan) { const p = D.plan; pts.push(['손절', p.stop, 'st'], [D.act === 'BUY' ? '1차 매수' : '매수 지정가', p.E, 'av'], ['1차 목표', p.t1, 't'], ['2차 목표', p.t2, 't']); }
  else pts.push(['20일선', D.R.ma20, 'av']);
  pts.push(['현재가', D.P, 'px']);
  const vals = pts.map(x => x[1]).filter(Boolean), lo = Math.min(...vals) * 0.985, hi = Math.max(...vals) * 1.015, Xp = v => (v - lo) / (hi - lo) * 100;
  return `<div class="tm-lad">${pts.map(([n, v, k]) => `<b class="tm-mk ${k}" style="left:${Xp(v)}%"><span>${n}<br>${fmt(Math.round(v))}</span></b>`).join('')}</div>`;
}

function tmOrdersHtml(D) {
  if (D.mode === 'hold') return `<table class="tm-ord"><thead><tr><th>할 일</th><th>수량</th><th>가격</th><th>금액</th><th>설명</th></tr></thead><tbody>${D.orders.filter(o => o[1] > 0).map(o => `<tr><td><b>${esc(o[0])}</b></td><td class="mono">${fmt(o[1])}주</td><td class="mono">${tmW(o[2])} <small class="${cls(o[2] - D.P)}">${tmP(o[2], D.P)}</small></td><td class="mono">${hMoney(o[1] * o[2])}</td><td class="muted small">${esc(o[3])}</td></tr>`).join('')}</tbody></table>`;
  const p = D.plan; if (!p) return '';
  const lossPct = (p.loss / p.A * 100);
  return `${D.act === 'NO' ? '<div class="hint"><b>⛔ 지금은 주문하지 않아요.</b> 아래는 금지 사유가 풀렸을 때 쓸 참고 계획이에요.</div>' : ''}<table class="tm-ord${D.act === 'NO' ? ' dim' : ''}"><thead><tr><th>할 일</th><th>수량</th><th>가격</th><th>금액</th><th>설명</th></tr></thead><tbody>
    <tr class="buy"><td><b>${D.act === 'BUY' ? '1차 매수(지금)' : '1차 매수(지정가)'}</b></td><td class="mono">${fmt(p.q1)}주</td><td class="mono">${tmW(p.E)} <small class="${cls(p.E - D.P)}">${p.E !== D.P ? tmP(p.E, D.P) : '현재가'}</small></td><td class="mono">${hMoney(p.amt1)}</td><td class="muted small">자금의 1/${D.C.splits} · ${esc(p.sig ? p.sig.id + ' ' + p.sig.name : '')}</td></tr>
    <tr class="buy"><td><b>2차 매수</b></td><td class="mono">${fmt(p.q2)}주</td><td class="mono">${tmW(p.add2)} 위</td><td class="mono">${hMoney(p.q2 * p.add2)}</td><td class="muted small">1차 뒤 재반등 확인(전일 고가 회복) 때만</td></tr>
    <tr class="sell"><td><b>손절(매수와 동시에 등록)</b></td><td class="mono">전량</td><td class="mono">${tmW(p.stop)} <small class="down">${pct(p.stopPct, 1)}</small></td><td class="mono down">−${hMoney(p.loss)}</td><td class="muted small">${esc(p.sig && p.sig.stopWhy || '')}${p.note ? ' · ' + esc(p.note) : ''} · 계좌의 ${fmt(lossPct, 1)}%</td></tr>
    <tr class="sell"><td><b>1차 목표 — 절반 매도</b></td><td class="mono">${fmt(Math.ceil(p.qty / 2))}주</td><td class="mono">${tmW(p.t1)} <small class="up">${tmP(p.t1, p.E)}</small></td><td class="mono up">+${hMoney((p.t1 - p.E) * Math.ceil(p.qty / 2))}</td><td class="muted small">손익비 1:2 (위험의 2배)${p.res ? ` · 위 저항 ${tmW(p.res)}` : ''}</td></tr>
    <tr class="sell"><td><b>2차 목표 / 트레일링</b></td><td class="mono">${fmt(Math.floor(p.qty / 2))}주</td><td class="mono">${tmW(p.t2)} <small class="up">${tmP(p.t2, p.E)}</small></td><td class="mono up">+${hMoney((p.t2 - p.E) * Math.floor(p.qty / 2))}</td><td class="muted small">또는 매수 후 최고가 대비 −${D.C.trail}% 이탈 시(과열이면 −${D.C.trailTight}%)</td></tr>
  </tbody></table>
  <div class="hint">수량 = 계좌 ${hMoney(p.A)} 기준 「한 번 손절에 계좌 −${D.C.maxLoss}% 이내」와 「종목당 ${D.C.maxPos}% 이내」 중 작은 쪽${p.mult < 1 ? ` × ${fmt(p.mult, 2)}(시장·일정·물량 위험으로 줄임)` : ''} = 총 ${fmt(p.qty)}주(${hMoney(p.amt)}).</div>`;
}

function tmSigHtml(R) {
  const card = (x, extra) => `<div class="tm-sig ${x.state}"><div class="tm-sig-h"><b>${x.id}</b> ${esc(x.name)} ${tmStTag(x.state)}</div><div class="small">${esc(x.why || '')}</div>${extra || ''}</div>`;
  return `<div class="tm-trend ${R.trend.ok ? 'ok' : 'bad'}"><b>추세 필터(최상위 관문) ${R.trend.ok ? '통과 ✓' : '실패 ✗'}</b> <span class="small">${esc(R.trend.why)}</span>${R.trend.ok ? '' : '<div class="small">→ 매수 신호는 전부 무시하고 매도 신호만 감시해요. (과매도 되돌림만 「20일선 우상향 + 60일선 위」로 따로 확인)</div>'}</div>
    <h4 class="mt">매수 신호</h4><div class="tm-sigs">${R.buys.map(b => card(b, b.entry && b.state !== 'off' && b.state !== 'void' ? `<div class="small mono mt-s">매수 ${tmW(b.entry)} · 손절 ${tmW(b.stop)}${b.trigger ? `<br><span class="muted">조건: ${esc(b.trigger)}</span>` : ''}</div>` : '')).join('')}</div>
    <h4 class="mt">매도 신호</h4><div class="tm-sigs sells">${R.sells.map(s => card(s, s.state === 'on' || s.state === 'warn' ? `<div class="small mt-s">대응: <b>${esc(s.act)}</b></div>` : '')).join('')}</div>
    <div class="hint mt-s">지표: 5일선 ${tmW(R.ma5)} · 20일선 ${tmW(R.ma20)} · 60일선 ${tmW(R.ma60)} · RSI ${fmt(R.rsi, 0)} · 스토캐스틱 ${fmt(R.k, 0)}/${fmt(R.dd, 0)} · 거래량 평소의 ${fmt(R.vr || 0, 1)}배${R.partial ? '(장중 → 하루치로 추정)' : ''}</div>`;
}

function tmNewsHtml(D) {
  const ev = TM.ev.get(D.code), cx = D.ctx;
  const li = (x, k) => `<li class="tm-ev ${k}"><span class="mono muted">${esc(x.d.slice(5, 16))}</span> ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.t)}</a>` : esc(x.t)}${x.by ? ` <small class="muted">${esc(x.by)}</small>` : ''}</li>`;
  const dis = ev ? ev.dis.slice(0, 10) : [], news = ev ? ev.news.slice(0, 8) : [];
  const kName = { risk: '악재·물량', good: '호재', sched: '일정', info: '' };
  const co = TM.co.get(D.code), tgt = co && co.consensus && co.consensus.target ? Number(String(co.consensus.target).replace(/[^\d.]/g, '')) : null;
  return `<div class="tm-grid2">
    <div><h4>판정에 넣은 최신 상황</h4>
      ${cx.plus.length ? `<ul class="tm-ul good">${cx.plus.map(t => `<li>＋ ${esc(t)}</li>`).join('')}</ul>` : ''}
      ${cx.minus.length ? `<ul class="tm-ul bad">${cx.minus.map(t => `<li>－ ${esc(t)}</li>`).join('')}</ul>` : ''}
      ${!cx.plus.length && !cx.minus.length ? '<div class="hint">눈에 띄는 수급·뉴스·공시 변화 없음</div>' : ''}
      ${tgt ? `<div class="small mt-s">증권사 평균 목표가 <b>${tmW(tgt)}</b> (현재가 대비 ${tmP(tgt, D.P)}) — 참고만</div>` : ''}
      ${D.s && D.s.short_ratio != null ? `<div class="small muted">공매도 잔고 ${fmt(D.s.short_ratio, 2)}% · 외국인 ${D.s.foreign_streak > 0 ? D.s.foreign_streak + '일 순매수' : D.s.foreign_streak < 0 ? -D.s.foreign_streak + '일 순매도' : '–'} · 기관 ${D.s.inst_streak > 0 ? D.s.inst_streak + '일 순매수' : D.s.inst_streak < 0 ? -D.s.inst_streak + '일 순매도' : '–'}</div>` : ''}
    </div>
    <div><h4>최근 공시 <small class="muted">${ev ? esc(ev.at.slice(11)) + ' 확인' : '불러오는 중…'}</small></h4>
      ${dis.length ? `<ul class="tm-evs">${dis.map(x => li(x, tmClassDis(x.t)) .replace('</li>', tmClassDis(x.t) !== 'info' ? ` <span class="tag ${tmClassDis(x.t) === 'risk' ? 'bad' : tmClassDis(x.t) === 'good' ? 'good' : ''}">${kName[tmClassDis(x.t)]}</span></li>` : '</li>')).join('')}</ul>` : `<div class="hint">${ev ? '최근 공시를 받지 못했어요' : ''}</div>`}
      <h4 class="mt-s">종목 뉴스</h4>
      ${news.length ? `<ul class="tm-evs">${news.map(x => li(x, TM_NNEG.test(x.t) ? 'neg' : TM_NPOS.test(x.t) ? 'pos' : '')).join('')}</ul>` : `<div class="hint">${ev ? '뉴스 없음' : ''}</div>`}
    </div></div>`;
}

function tmCalHtml(D) {
  const cal = D.ctx.cal; if (!cal.length) return '<div class="hint">45일 안에 눈에 띄는 일정이 없어요.</div>';
  const today = tmNow().date;
  return `<ul class="tm-cal">${cal.map(x => { const cd = Math.round((new Date(x.d) - new Date(today)) / 864e5); return `<li class="${x.w >= 2 ? 'hot' : ''} ${x.past ? 'past' : ''}"><b class="mono">${esc(x.d.slice(5))}</b> <small class="muted">${x.past || cd < 0 ? '지난 일' : cd === 0 ? '오늘' : cd + '일 뒤'}</small> ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.t)}</a>` : esc(x.t)}</li>`; }).join('')}</ul>
    <div class="hint">FOMC·실적 시즌·동시만기처럼 크게 흔들 수 있는 일정이 3거래일 안에 있으면 1차 매수 비중을 절반으로 줄여 계산해요.</div>`;
}

function tmNoteHtml(D) {
  const n = D.note;
  const best = D.mode === 'new' && D.plan ? D.plan : null;
  return `<div class="tm-note">${n ? `<div>📝 <b>${esc(n.t)}</b> 기록: ${esc(n.txt)}${n.stop ? ` <small class="muted">(근거 기준선 ${tmW(n.stop)} — 이 아래로 내려가면 「근거 소멸」로 매도 판단)</small>` : ''} <button class="btn ghost small" id="tmNoteDel">지우기</button></div>` : '<div class="hint">매수할 때 「왜 샀는지」 한 줄을 남겨두면, 그 근거가 사라졌을 때 매도 판단에 써요.</div>'}
    <div class="row gap wrap mt-s"><input id="tmNoteTxt" class="inp" style="flex:1;min-width:220px" placeholder="예) 20일선 눌림목 지지 확인 후 1차 매수" value="${best && best.sig ? esc(`${best.sig.id} ${best.sig.name} — ${tmW(best.E)} 매수, 손절 ${tmW(best.stop)}`) : ''}"><button class="btn ghost small" id="tmNoteSave">근거 기록</button></div></div>`;
}

function tmRenderOne() {
  const box = $('#tmOne'); if (!box) return;
  const code = TM.sel; if (!code) { box.innerHTML = ''; return; }
  const ae = document.activeElement; if (ae && box.contains(ae) && /INPUT|TEXTAREA/.test(ae.tagName)) return;  // 입력 중이면 다시 그리지 않음
  const st = TM.st.get(code), s = S.data.stocks.find(x => x.code === code);
  if (!st || !st.f) { box.innerHTML = `<div class="empty">${esc(s ? s.name : code)} ${st && st.err ? '— 일봉 자료가 없어 규칙을 계산할 수 없어요(분석 대상 892종목만 가능).' : '일봉 자료를 불러오는 중이에요…'}</div>`; return; }
  let D; try { D = tmDecide(code); } catch (e) { console.error(e); box.innerHTML = `<div class="empty">계산 중 문제가 생겼어요: ${esc(e.message)}</div>`; return; }
  if (!D) return;
  TM.lastD = D;
  const q = st.q, R = D.R;
  const px = `<span class="mono"><b>${tmW(D.P)}</b> <small class="${cls(D.ctx.chg)}">${pct(D.ctx.chg, 2)}</small></span>`;
  box.innerHTML = `<div class="an-card an-wide tm-main">
    <h3>${esc(s ? s.name : code)} <span class="muted mono">${esc(code)}</span> ${px} ${D.hold ? `<span class="tag good">보유 ${fmt(D.hold.qty)}주 · 평단 ${tmW(D.hold.avg)} · ${pct((D.P / D.hold.avg - 1) * 100, 1)}</span>` : '<span class="tag">보유 안 함</span>'}
      <span class="tm-live">${q && q.price ? `<span class="gov-live"></span> ${esc(String(q.at || '').slice(11, 19))} 시세` : '종가 기준'}${D.partial ? ' · 장중(잠정)' : ''}</span>
      <span class="row gap" style="margin-left:auto"><button class="btn ghost small" id="tmAn">종목 분석</button>${D.hold ? '' : `<button class="btn ghost small" id="tmW">${(store.get('tmWatch', []) || []).includes(code) ? '★ 관심 해제' : '☆ 관심 추가'}</button>`}</span></h3>
    <div class="tm-concl ${D.tone}">
      <div class="tm-concl-h">최종 결론 ${tmTag(D.act)} <b>${esc(D.head)}</b></div>
      <p class="tm-one">${esc(tmOneLine(D))}</p>
      ${tmOrdersHtml(D)}
      <div class="tm-when"><b>⏰ 타이밍</b> ${esc(D.timing)}</div>
      ${D.ctx.timing.length ? `<ul class="tm-ul warn">${D.ctx.timing.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${D.bans && D.bans.length ? `<ul class="tm-ul bad">${D.bans.map(t => `<li>⛔ ${esc(t)}</li>`).join('')}</ul>` : ''}
      ${D.add ? `<div class="small mt-s">${D.add.ok ? '➕' : '🚫'} ${esc(D.add.t)}</div>` : ''}
      ${D.why.length ? `<div class="small muted mt-s">근거: ${D.why.map(esc).join(' · ')}</div>` : ''}
      ${D.wait && D.wait.length ? `<ul class="tm-ul">${D.wait.map(t => `<li>⏳ ${esc(t)}</li>`).join('')}</ul>` : ''}
    </div>
    ${tmLadder(D)}
    <div class="tm-chart"><canvas id="tmCv"></canvas></div>
    <details class="mt" open><summary><b>규칙 판정 — 추세 필터 · 매수 신호 4개 · 매도 신호 5개</b></summary>${tmSigHtml(R)}</details>
    <details class="mt" open><summary><b>최신 상황 — 공시 · 뉴스 · 수급 · 공매도</b></summary>${tmNewsHtml(D)}</details>
    <details class="mt" open><summary><b>추후 일정</b></summary>${tmCalHtml(D)}</details>
    <details class="mt"><summary><b>매수 근거 기록</b></summary>${tmNoteHtml(D)}</details>
    <div class="hint mt">※ 기술적 분석은 확률 게임이에요. 이 화면은 정해진 규칙을 그대로 계산한 참고 자료이고, 매매 판단과 책임은 본인에게 있어요. 손절가를 답할 수 없으면 사지 않는다 — 이것이 첫 번째 규칙이에요.</div>
  </div>`;
  const b = $('#tmAn'); if (b) b.onclick = () => showAnalysis(code);
  const w = $('#tmW'); if (w) w.onclick = () => { tmToggleWatch(code); };
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
  const hl = (lbl, v, c, dash) => v && lines.push({ label: lbl, data: Array(k).fill(v), borderColor: c, borderWidth: 1.2, borderDash: dash || [5, 4], pointRadius: 0, fill: false });
  if (D.mode === 'hold') { hl('손절/트레일링', D.eff, col('--down')); hl('평단', D.avg, '#888', [2, 3]); hl('1차 목표', D.t1, col('--up')); }
  else if (D.plan) { hl('손절', D.plan.stop, col('--down')); hl('매수', D.plan.E, '#e0a800', [2, 3]); hl('1차 목표', D.plan.t1, col('--up')); }
  TM.chart = new Chart(cv, {
    type: 'line',
    data: { labels: sl(B.d).map(d => d.slice(5)), datasets: [
      { label: '종가', data: sl(B.c), borderColor: col('--fg') || '#333', borderWidth: 1.6, pointRadius: 0, fill: false },
      { label: '5일선', data: sl(R.I.ma5), borderColor: '#f39c12', borderWidth: 1, pointRadius: 0, fill: false },
      { label: '20일선', data: sl(R.I.ma20), borderColor: '#2e86de', borderWidth: 1.4, pointRadius: 0, fill: false },
      { label: '60일선', data: sl(R.I.ma60), borderColor: '#8e44ad', borderWidth: 1, pointRadius: 0, fill: false },
      ...lines] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: c => `${c.dataset.label} ${fmt(Math.round(c.raw))}` } } },
      scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } }, y: { ticks: { font: { size: 10 }, callback: v => fmt(v) } } } },
  });
}

function tmRenderList() {
  const box = $('#tmList'); if (!box) return;
  const { hs, all } = tmCodes();
  if (!all.length) { box.innerHTML = '<div class="hint">「내 보유 종목」에 기록한 종목과 ☆ 관심 종목이 여기에 모여 실시간으로 판정돼요. 위에서 종목을 검색해 보세요.</div>'; return; }
  const rows = all.map(code => {
    const s = S.data.stocks.find(x => x.code === code); let D = null;
    try { D = TM.st.get(code) && TM.st.get(code).f ? tmDecide(code) : null; } catch (e) { console.error(e); }
    const key = D ? (D.mode === 'hold' ? `손절 ${tmW(D.eff)} · 목표 ${tmW(D.t1)}` : D.plan ? `매수 ${tmW(D.plan.E)} · 손절 ${tmW(D.plan.stop)} · 목표 ${tmW(D.plan.t1)}` : `20일선 ${tmW(D.R.ma20)}`) : '계산 중…';
    return `<tr data-tm="${esc(code)}" class="${TM.sel === code ? 'on' : ''}"><td><b>${esc(s ? s.name : code)}</b> <small class="muted">${hs.includes(code) ? '보유' : '관심'}</small></td>
      <td class="mono">${D ? `${tmW(D.P)} <small class="${cls(D.ctx.chg)}">${pct(D.ctx.chg, 1)}</small>` : '–'}</td><td>${D ? tmTag(D.act) : ''}</td>
      <td class="small">${D ? esc(D.head) : ''}</td><td class="mono small">${key}</td><td>${D ? (D.R.trend.ok ? '<span class="tag good">추세 ✓</span>' : '<span class="tag bad">추세 ✗</span>') : ''}</td>
      <td>${hs.includes(code) ? '' : `<button class="btn ghost small" data-tmx="${esc(code)}" title="관심 해제">✕</button>`}</td></tr>`;
  });
  box.innerHTML = `<table class="clx-tb tm-tb"><thead><tr><th>종목</th><th>현재가</th><th>결론</th><th>내용</th><th>핵심 가격</th><th>추세</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  $$('#tmList [data-tm]').forEach(el => el.onclick = e => { if (e.target.closest('[data-tmx]')) return; tmSelect(el.dataset.tm); });
  $$('#tmList [data-tmx]').forEach(el => el.onclick = () => tmToggleWatch(el.dataset.tmx));
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
  try { const r = await fetch('/api/hoga?code=' + code, { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j.quote && j.quote.price) st.q = { ...j.quote, at: j.at }; } } catch (e) {}
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
  const lbl = { open: '<span class="tag good">장중 — 현재가 10초마다 · 일봉 15분마다 다시 계산</span>', pre: '<span class="tag">장 시작 전</span>', after: '<span class="tag">장 마감 — 오늘 종가로 신호 확정</span>', closed: '<span class="tag">휴장일 — 마지막 거래일 종가 기준</span>' }[mk.st];
  el.innerHTML = `${lbl} ${q && q.at ? `· 마지막 시세 ${esc(String(q.at).slice(11, 19))}` : ''} ${typeof CLX !== 'undefined' && CLX.live ? `· 일봉 계산 ${esc(CLX.live.meta.time.slice(5))}` : ''}`;
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
    if (TM.sel) { const st = TM.st.get(TM.sel); if (!st || !st.qt || now - st.qt >= (live ? 10e3 : 180e3)) { await tmQuote(TM.sel); tmRenderOne(); } tmEvents(TM.sel).then(() => {}); }
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
