/* 지수 온도 — 코스피·코스닥 흐름(온도 0~100도 · 분위기)
   6가지를 합쳐 온도를 매김: ① 오늘 지수 등락 ② 추세(이동평균·RSI·고점 대비) ③ 시장의 폭(오른 종목·20일선 위 종목·신고가/신저가)
   ④ 외국인·기관 수급 ⑤ 거래대금 열기 ⑥ 해외(미국 선물·반도체·VIX·환율)
   자료: /api/idx(지수 현재가·분봉·상승/하락 종목 수, 20초) · live-cl KOSPI.json/KOSDAQ.json(일봉, 15분) · market.json(해외, 15분) · /api/mflow(수급, 1분) */
'use strict';

const MOOD = { q: null, qt: 0, bars: {}, bt: 0, busy: false, sel: 'KOSPI' };
const MD_NM = { KOSPI: '코스피', KOSDAQ: '코스닥' };
const MD_W = [['day', '오늘 등락', 20], ['trend', '추세', 20], ['breadth', '시장의 폭', 20], ['flow', '외국인·기관 수급', 15], ['heat', '거래대금 열기', 10], ['global', '해외·환율', 15]];
const mdClamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const mdKst = () => new Date(Date.now() + 9 * 3600e3);
const mdToday = () => mdKst().toISOString().slice(0, 10);
function mdOpen() { const k = mdKst(), m = k.getUTCHours() * 60 + k.getUTCMinutes(), wd = k.getUTCDay(); return wd >= 1 && wd <= 5 && m >= 540 && m <= 930; }
function mdLabel(t) {
  return t >= 80 ? ['hot', '과열', '탐욕 구간 — 다들 사고 싶어 하는 장'] : t >= 65 ? ['warm', '따뜻함', '상승 흐름이 살아 있는 장'] : t >= 52 ? ['mild', '온화', '약하게 오름 쪽으로 기운 장'] :
    t >= 40 ? ['cool', '서늘함', '방향을 못 정한 눈치보기 장'] : t >= 25 ? ['cold', '차가움', '팔자가 우세한 약세장'] : ['ice', '얼어붙음', '공포 구간 — 다들 던지는 장'];
}

/* ── 자료 받기 ── */
async function mdLoadQuote(force) {
  const gap = mdOpen() ? (typeof svGap === 'function' ? svGap(18e3, 60e3) : 18e3) : 300e3;
  if (!force && Date.now() - MOOD.qt < gap) return;
  MOOD.qt = Date.now();
  try { const r = await fetch('/api/idx', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j && j.ok) MOOD.q = j; } } catch (e) {}
}
async function mdLoadBars(force) {
  if (!force && Date.now() - MOOD.bt < 15 * 60e3) return;
  MOOD.bt = Date.now();
  const raw = (typeof CLX !== 'undefined' && CLX.RAW) || 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-cl/';
  await Promise.all(['KOSPI', 'KOSDAQ'].map(async m => {
    try { const r = await fetch(raw + m + '.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) { const f = await r.json(); if (f && f.c && f.c.length >= 60) MOOD.bars[m] = f; } } catch (e) {}
  }));
}

/* ── 지수 현재 값 (실시간 → 15분 자료 → 아침 자료 순) ── */
function mdQuote(m) {
  const L = MOOD.q && MOOD.q.mkt && MOOD.q.mkt[m];
  if (L && L.q && L.q.price) return { ...L.q, src: '실시간', at: MOOD.q.at, min: L.min || null, br: L.br || null };
  const U = typeof MKT !== 'undefined' && MKT.d && MKT.d.us && MKT.d.us[m];
  const ci = S.data && S.data.cl_index && S.data.cl_index[MD_NM[m]];
  if (U && U.v) return { price: U.v, pct: U.chg, chg: U.prev ? U.v - U.prev : null, src: '15분 자료', at: U.t };
  if (ci && ci.c) return { price: ci.c, pct: ci.chg, src: '차트 자료', at: typeof CLX !== 'undefined' && CLX.live ? CLX.live.meta.time : '' };
  const M = S.data && S.data.macro && S.data.macro[m.toLowerCase()];
  return M ? { price: M.v, pct: M.chg, src: '아침 자료', at: M.date } : null;
}

/* ── 일봉 지표 ── */
function mdSma(a, n, i) { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; }
function mdRsi(c, n = 14) { if (c.length < n + 1) return null; let g = 0, l = 0; for (let i = c.length - n; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
function mdDaily(m, q) {
  const f = MOOD.bars[m]; if (!f) return null;
  const d = [...f.d], c = [...f.c], h = [...f.h], l = [...f.l];
  // 오늘 실시간 값을 마지막 봉으로 (일봉 파일은 15분마다라 실시간 지수로 덮음)
  if (q && q.price && q.src === '실시간') {
    const t = mdToday();
    if (d[d.length - 1] === t) { c[c.length - 1] = q.price; if (q.high) h[h.length - 1] = Math.max(h[h.length - 1], q.high); if (q.low) l[l.length - 1] = Math.min(l[l.length - 1], q.low); }
    else if (d[d.length - 1] < t && mdKst().getUTCDay() >= 1 && mdKst().getUTCDay() <= 5 && mdKst().getUTCHours() * 60 + mdKst().getUTCMinutes() >= 540) { d.push(t); c.push(q.price); h.push(q.high || q.price); l.push(q.low || q.price); }
  }
  const n = c.length, i = n - 1, P = c[i];
  const ma5 = mdSma(c, 5, i), ma20 = mdSma(c, 20, i), ma60 = mdSma(c, 60, i), ma120 = mdSma(c, 120, i), ma20p = mdSma(c, 20, i - 5);
  const hi60 = Math.max(...c.slice(-60)), lo60 = Math.min(...c.slice(-60)), hi250 = Math.max(...c.slice(-250));
  const tr = []; for (let k = n - 14; k < n; k++) tr.push(Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1])));
  const atrp = tr.reduce((a, x) => a + x, 0) / tr.length / P * 100;
  const tr20 = []; for (let k = n - 34; k < n - 14; k++) tr20.push(Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1])));
  const atrp0 = tr20.length ? tr20.reduce((a, x) => a + x, 0) / tr20.length / c[n - 15] * 100 : atrp;
  let up = 0; for (let k = n - 1; k > 0 && c[k] > c[k - 1]; k--) up++;
  let dn = 0; for (let k = n - 1; k > 0 && c[k] < c[k - 1]; k--) dn++;
  return { d, c, P, ma5, ma20, ma60, ma120, ma20s: ma20p ? (ma20 / ma20p - 1) * 100 : 0, rsi: mdRsi(c), ret5: (P / c[i - 5] - 1) * 100, ret20: (P / c[i - 20] - 1) * 100,
    dd60: (P / hi60 - 1) * 100, up60: (P / lo60 - 1) * 100, dd250: (P / hi250 - 1) * 100, hi60, lo60, atrp, atrp0, streak: up ? up : -dn };
}

/* ── 시장의 폭 (분석 대상 종목 · 실시간 상승/하락 종목 수) ── */
function mdBreadth(m, q) {
  const st = (S.data ? S.data.stocks : []).filter(s => s.market === m);
  let n = 0, up = 0, dn = 0, a20 = 0, n20 = 0, nh = 0, nl = 0, big = 0, bigUp = 0;
  const day = S.data && S.data.meta ? S.data.meta.asof : '';
  st.forEach(s => {
    const L = s._live && s._live.d && s._live.d >= day ? s._live : null;
    const chg = L ? L.chg : s.chg, px = L ? L.c : s.close;
    if (chg == null) return;
    n++; if (chg > 0) up++; else if (chg < 0) dn++;
    if (s.ma20) { n20++; if (px > s.ma20) a20++; }
    if (s.pos52 != null) { if (s.pos52 >= 0.97) nh++; else if (s.pos52 <= 0.03) nl++; }
    if (s.mcap && s.mcap >= 50000) { big++; if (chg > 0) bigUp++; }
  });
  const r = { n, up, dn, upPct: n ? up / n * 100 : null, a20Pct: n20 ? a20 / n20 * 100 : null, nh, nl, big, bigUp, src: '분석 대상 ' + n + '종목' };
  if (q && q.br && q.br.up != null) { const b = q.br, tot = b.up + b.down + (b.flat || 0); r.upPct = b.up / (b.up + b.down) * 100; r.up = b.up; r.dn = b.down; r.n = tot; r.src = `${MD_NM[m]} 전체 ${tot}종목(실시간)`; r.upl = b.upl; r.dnl = b.dnl; }
  return r;
}

/* ── 수급(시장 전체 투자자별 순매수 억원) ── */
function mdFlow(m) {
  let last = null, live = false, at = '';
  if (typeof ivMktRows === 'function' && typeof INV !== 'undefined') { try { const R = ivMktRows(m); if (R && R.rows && R.rows.length) { last = R.rows[R.rows.length - 1]; live = !!R.live; at = R.at || ''; if (R.krx || R.day) last = R.rows[0]; } } catch (e) {} }
  const K = typeof INV !== 'undefined' && INV.d && INV.d.mkt && INV.d.mkt[m];
  const s20 = k => K && K[k] ? K[k].slice(-20).reduce((a, x) => a + (x || 0), 0) : null;
  const s5 = k => K && K[k] ? K[k].slice(-5).reduce((a, x) => a + (x || 0), 0) : null;
  if (!last && !K) return null;
  return { f: last ? last['외국인'] : null, i: last ? (last['기관'] ?? last['기관합계']) : null, r: last ? last['개인'] : null, p: last ? last['연기금'] : null, t: last ? last.t : '', live, at,
    f20: s20('외국인'), i20: s20('기관합계'), r20: s20('개인'), p20: s20('연기금'), f5: s5('외국인') };
}

/* ── 거래대금 열기 (시장별, 오늘 ÷ 20일 평균) ── */
function mdHeat(m) {
  const st = (S.data ? S.data.stocks : []).filter(s => s.market === m), N = 21, tot = Array(N).fill(0);
  let cnt = 0;
  st.forEach(s => {
    const c = s.spark || [], v = s.spark_vol || []; if (c.length < N || v.length < N) return;
    cnt++;
    for (let k = 0; k < N; k++) { const ci = c[c.length - N + k], vi = v[v.length - N + k]; if (ci != null && vi != null) tot[k] += ci * vi / 1e8; }
  });
  if (!cnt) return null;
  const today = tot[N - 1], a20 = tot.slice(0, N - 1).reduce((a, x) => a + x, 0) / (N - 1);
  const proj = typeof LIVE !== 'undefined' && LIVE.proj != null && LIVE.proj < 1 && mdOpen() ? LIVE.proj : null;
  return { ratio: a20 ? today / a20 : null, today, a20, proj };
}

/* ── 온도 계산 ── */
function moodCalc(m) {
  if (!S.data) return null;
  const q = mdQuote(m), D = mdDaily(m, q), B = mdBreadth(m, q), F = mdFlow(m), H = mdHeat(m);
  const U = (typeof MKT !== 'undefined' && MKT.d && MKT.d.us) || {}, ci = S.data.cl_index && S.data.cl_index[MD_NM[m]];
  const nm = MD_NM[m], th = m === 'KOSPI' ? 3000 : 1000;
  const C = {}, why = {};
  const pct = q && q.pct != null ? q.pct : null;
  // ① 오늘 등락 + 장중 위치(고가 근처 마감 = 힘이 남음)
  if (pct != null) {
    let sc = 50 + pct * 16, pos = null;
    if (q.high && q.low && q.high > q.low) { pos = (q.price - q.low) / (q.high - q.low); sc = sc * 0.75 + pos * 100 * 0.25; }
    C.day = mdClamp(sc);
    why.day = `${nm} ${q.price ? fmt(q.price, 2) : ''} ${pct >= 0 ? '+' : ''}${fmt(pct, 2)}%${pos != null ? ` · 오늘 고가~저가 중 ${pos >= 0.7 ? '고가 근처(매수 힘 유지)' : pos <= 0.3 ? '저가 근처(매도 압력)' : '중간'}` : ''}`;
  }
  // ② 추세
  if (D) {
    let sc = 50;
    sc += D.P > D.ma20 ? 12 : -12; sc += D.ma20 > D.ma60 ? 10 : -10; sc += D.ma20s > 0 ? 8 : -8;
    if (D.ma120) sc += D.P > D.ma120 ? 5 : -5;
    sc += mdClamp(D.ret20 * 1.5, -15, 15);
    if (D.rsi != null && D.rsi >= 75) sc += 3; else if (D.rsi != null && D.rsi <= 30) sc -= 3;
    C.trend = mdClamp(sc);
    why.trend = `20일선 ${D.P > D.ma20 ? '위' : '아래'}(${D.P >= D.ma20 ? '+' : ''}${fmt((D.P / D.ma20 - 1) * 100, 1)}%) · 20일선이 60일선 ${D.ma20 > D.ma60 ? '위(정배열)' : '아래(역배열)'} · 20일선 ${D.ma20s > 0 ? '오르는 중' : '내리는 중'} · 한 달 ${pct2(D.ret20)} · RSI ${fmt(D.rsi, 0)}`;
  } else if (ci) {
    C.trend = mdClamp(50 + ci.s / 2 + (U[m] && U[m].chg20 != null ? mdClamp(U[m].chg20 * 1.5, -15, 15) : 0));
    why.trend = `차트 종합판정 ${ci.v}(${ci.s > 0 ? '+' : ''}${fmt(ci.s, 1)})${U[m] && U[m].chg20 != null ? ` · 한 달 ${pct2(U[m].chg20)}` : ''}`;
  }
  // ③ 시장의 폭
  if (B && B.upPct != null) {
    const hl = B.nh + B.nl ? B.nh / (B.nh + B.nl) * 100 : 50;
    C.breadth = mdClamp(B.a20Pct != null ? B.upPct * 0.45 + B.a20Pct * 0.4 + hl * 0.15 : B.upPct * 0.8 + hl * 0.2);
    why.breadth = `오른 종목 ${fmt(B.upPct, 0)}%(${fmt(B.up)}↑ ${fmt(B.dn)}↓)${B.a20Pct != null ? ` · 20일선 위 종목 ${fmt(B.a20Pct, 0)}%` : ''} · 1년 신고가 근처 ${B.nh} / 신저가 근처 ${B.nl}`;
  }
  // ④ 수급
  if (F && (F.f != null || F.f20 != null)) {
    let sc = 50;
    if (F.f != null) sc += mdClamp(((F.f || 0) + 0.6 * (F.i || 0)) / th * 40, -40, 40);
    if (F.f20 != null) sc += mdClamp(F.f20 / (th * 5) * 10, -10, 10);
    C.flow = mdClamp(sc);
    why.flow = `${F.live ? `오늘 ${F.t || ''} 누적` : '최근 거래일'} 외국인 ${ivEok2(F.f)} · 기관 ${ivEok2(F.i)} · 개인 ${ivEok2(F.r)}${F.f20 != null ? ` · 20일 외국인 ${ivEok2(F.f20)}` : ''}`;
  }
  // ⑤ 거래대금 열기 — 오를 때 뜨거우면 +, 내릴 때 뜨거우면(투매) −
  if (H && H.ratio != null) {
    const dir = pct == null ? 0 : Math.abs(pct) < 0.3 ? Math.sign(pct) * 0.3 : Math.sign(pct);
    C.heat = mdClamp(50 + mdClamp((H.ratio - 1) * 60, -30, 30) * (dir || 0.3) + (H.ratio < 0.75 ? -5 : 0));
    why.heat = `거래대금 20일 평균의 ${fmt(H.ratio, 2)}배${H.proj ? '(장중 하루 예상치 환산)' : ''} — ${H.ratio >= 1.3 ? (pct >= 0 ? '돈이 몰리며 오름(위험 선호)' : '거래 실린 하락(투매)') : H.ratio >= 0.9 ? '평소 수준' : '거래가 말라붙음(관망)'}`;
  }
  // ⑥ 해외·환율
  {
    let sc = 50, parts = [], has = false;
    const fut = m === 'KOSPI' ? U.ES : U.NQ, fn = m === 'KOSPI' ? 'S&P 선물' : '나스닥 선물';
    if (fut && fut.chg != null) { sc += mdClamp(fut.chg * (m === 'KOSPI' ? 9 : 8), -18, 18); parts.push(`${fn} ${pct2(fut.chg)}`); has = true; }
    if (m === 'KOSPI' && U.SOX && U.SOX.chg != null) { sc += mdClamp(U.SOX.chg * 2.5, -8, 8); parts.push(`필라델피아 반도체 ${pct2(U.SOX.chg)}`); has = true; }
    if (m === 'KOSDAQ' && U.NASDAQ && U.NASDAQ.chg != null) { sc += mdClamp(U.NASDAQ.chg * 3, -8, 8); parts.push(`나스닥 ${pct2(U.NASDAQ.chg)}`); has = true; }
    if (U.VIX && U.VIX.v) { const v = U.VIX.v; sc += v < 14 ? 8 : v < 20 ? 2 : v < 28 ? -10 : -20; parts.push(`VIX ${fmt(v, 1)}(${v < 14 ? '안심' : v < 20 ? '보통' : v < 28 ? '불안' : '공포'})`); has = true; }
    if (U.USDKRW && U.USDKRW.chg != null) { sc += mdClamp(-U.USDKRW.chg * 12, -10, 10); parts.push(`원/달러 ${pct2(U.USDKRW.chg)}${U.USDKRW.chg >= 0.5 ? '(원화 약세 — 외국인 매도 압력)' : U.USDKRW.chg <= -0.5 ? '(원화 강세 — 외국인 유입 우호)' : ''}`); has = true; }
    const g = S.data.gate; if (g && g.level === 'red') { sc -= 10; parts.push('매크로 게이트 경고'); } else if (g && g.level === 'yellow') { sc -= 5; parts.push('매크로 게이트 주의'); }
    if (has) { C.global = mdClamp(sc); why.global = parts.join(' · '); }
  }
  let sw = 0, sv = 0; MD_W.forEach(([k, , w]) => { if (C[k] != null) { sw += w; sv += C[k] * w; } });
  if (!sw) return null;
  const temp = Math.round(sv / sw), L = mdLabel(temp);
  // 분위기(장의 성격) 태그
  const tags = [];
  const f = F && F.f, i = F && F.i, r = F && F.r;
  if (pct != null && B && B.upPct != null) {
    if (pct >= 0.3 && B.upPct < 42) tags.push(['bad', '지수만 오르는 쏠림 장', `${nm}는 ${pct2(pct)} 올랐지만 오른 종목은 ${fmt(B.upPct, 0)}%뿐 — 대형주 몇 개가 지수를 끌어올리는 중이라 내 종목은 체감이 다를 수 있어요.`]);
    else if (pct <= -0.3 && B.upPct > 55) tags.push(['good', '지수는 약해도 종목은 버팀', `지수는 ${pct2(pct)}지만 오른 종목이 ${fmt(B.upPct, 0)}% — 대형주만 빠지고 중소형주는 버티는 장이에요.`]);
    else if (pct >= 0.5 && B.upPct >= 60) tags.push(['good', '고르게 오르는 장', `오른 종목이 ${fmt(B.upPct, 0)}% — 지수와 종목이 함께 오르는 건강한 상승이에요.`]);
    else if (pct <= -0.5 && B.upPct <= 35) tags.push(['bad', '전면 약세', `내린 종목이 ${fmt(100 - B.upPct, 0)}% 가까이 — 종목을 가리지 않고 빠지는 장이에요.`]);
  }
  if (f != null && r != null && pct != null) {
    if (f > th * 0.1 && r < 0 && pct > 0) tags.push(['good', '외국인이 끄는 상승', `외국인 ${ivEok2(f)} 순매수가 지수를 끌고, 개인은 ${ivEok2(r)} 차익 실현 중이에요.`]);
    else if (f < -th * 0.1 && (i || 0) < 0 && r > 0 && pct < 0) tags.push(['bad', '개인 혼자 받는 하락', `외국인 ${ivEok2(f)}·기관 ${ivEok2(i)} 매도를 개인이 ${ivEok2(r)} 받아내는 중 — 이런 날 저점 매수는 서두르지 마세요.`]);
    else if (f < 0 && (i || 0) > th * 0.1) tags.push(['', '기관 방어', `외국인 매도(${ivEok2(f)})를 기관이 ${ivEok2(i)} 받아 지수를 지키는 중이에요.`]);
  }
  if (H && H.ratio != null && pct != null) {
    if (H.ratio >= 1.3 && pct >= 1) tags.push(['good', '거래 터진 강한 상승', '거래대금이 평소보다 크게 늘며 올라요 — 새 돈이 들어오는 위험 선호 국면이에요.']);
    else if (H.ratio >= 1.3 && pct <= -1) tags.push(['bad', '거래 실린 투매', '거래대금이 터지며 빠져요 — 공포성 매도. 바닥은 투매가 잦아든 뒤(거래 감소+하락 멈춤) 나와요.']);
    else if (H.ratio < 0.75 && Math.abs(pct) < 0.5) tags.push(['', '거래 없는 눈치보기', '거래가 말라 방향이 없어요 — 큰 일정(FOMC·실적) 앞이면 결과 확인 뒤 움직이는 편이 안전해요.']);
  }
  if (D && D.rsi != null) {
    if (D.rsi >= 72 && D.dd60 > -1) tags.push(['warn', '단기 과열', `RSI ${fmt(D.rsi, 0)} · 60일 고점 부근 — 오르는 힘은 강하지만 추격 매수는 손익비가 나빠요.`]);
    else if (D.rsi <= 30) tags.push(['warn', '단기 과매도', `RSI ${fmt(D.rsi, 0)} · 60일 고점 대비 ${pct2(D.dd60)} — 기술적 반등이 나올 수 있는 자리지만 추세 전환 확인 전엔 소량만.`]);
    if (D.atrp > D.atrp0 * 1.35 && D.atrp > 1.5) tags.push(['warn', '변동성 확대', `하루 평균 흔들림 ${fmt(D.atrp, 2)}% (한 달 전 ${fmt(D.atrp0, 2)}%) — 손절 폭을 넓히거나 비중을 줄이세요.`]);
  }
  // 해설(문장)
  const lines = [];
  lines.push(`${nm} 온도 ${temp}도 — ${L[1]}. ${L[2]}.`);
  const parts = MD_W.filter(([k]) => C[k] != null).map(([k, n]) => [k, n, C[k]]).sort((a, b) => b[2] - a[2]);
  const hiP = parts.filter(x => x[2] >= 60), loP = parts.filter(x => x[2] <= 40);
  if (hiP.length) lines.push(`온도를 올리는 쪽: ${hiP.map(x => `${x[1]}(${Math.round(x[2])})`).join(', ')}.`);
  if (loP.length) lines.push(`온도를 내리는 쪽: ${loP.map(x => `${x[1]}(${Math.round(x[2])})`).join(', ')}.`);
  if (D) {
    if (D.P > D.ma20 && D.ma20 > D.ma60) lines.push(`일봉은 정배열 상승 추세예요. 20일선(${fmt(D.ma20, 2)})이 눌림 때 1차 지지선이에요.`);
    else if (D.P < D.ma20 && D.ma20 < D.ma60) lines.push(`일봉은 역배열 하락 추세예요. 20일선(${fmt(D.ma20, 2)})을 되찾기 전까지는 반등이 나와도 저항을 받기 쉬워요.`);
    else if (D.P < D.ma20 && D.ma20 > D.ma60) lines.push(`상승 추세 속 조정이에요. 60일선(${fmt(D.ma60, 2)})을 지키는지가 관건이에요.`);
    else lines.push(`하락 뒤 반등 시도 중이에요. 20일선 위에 안착했지만 20일선이 아직 60일선 아래라 추세 전환은 확인 전이에요.`);
    if (D.streak >= 4) lines.push(`${D.streak}거래일 연속 상승 — 연속 상승 뒤엔 하루 이틀 쉬어 가는 경우가 많아요.`);
    else if (D.streak <= -4) lines.push(`${-D.streak}거래일 연속 하락 — 매도가 지쳐 가는 구간일 수 있어요.`);
  }
  // 실전 대응
  const todo = temp >= 80 ? ['추격 매수 자제 — 신규는 눌림(20일선 근처)을 기다리기', '보유 종목은 트레일링 손절을 당겨 이익 지키기', '급등 종목 일부 이익 실현 고려']
    : temp >= 65 ? ['추세 추종이 유리한 장 — 매수 신호 나온 종목은 계획 비중대로', '외국인 매수가 이어지는 업종·종목 우선', '손절선은 그대로 두고 수익은 길게']
    : temp >= 52 ? ['선별 매수 — 수급(외국인·연기금) 좋은 종목 위주', '1차 매수 후 지수 흐름 확인하며 2차', '지수가 20일선 아래로 내려가면 신규 매수 멈춤']
    : temp >= 40 ? ['관망 위주 — 신규 매수는 1차 비중을 절반으로', '이미 산 종목은 손절선 다시 확인', '방향이 나올 때(온도 55↑ 또는 40↓)까지 기다리기']
    : temp >= 25 ? ['신규 매수 최소화 — 현금 비중 늘리기', '손절선 이탈 종목은 미루지 말고 정리', '반등 때 약한 종목부터 비중 줄이기']
    : ['현금 지키기가 먼저 — 바닥 예측 금지', '투매가 잦아들고(거래 감소+하락 멈춤) 외국인 매수 전환을 확인한 뒤 소량 분할', '과매도 반등은 짧게 — 목표가를 낮게 잡기'];
  return { m, nm, temp, L, C, why, tags, lines, todo, q, D, B, F, H, ci };
}
function ivEok2(v) { return typeof ivEok === 'function' ? ivEok(v) : v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, 0)}억`; }
function pct2(v) { return v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, Math.abs(v) < 10 ? 2 : 1)}%`; }

/* 다른 화면(매매 타이밍 등)에서 쓰는 요약 — 30초 동안 같은 결과를 다시 씀 */
function moodGet(m) {
  if (!m || !MD_NM[m]) return null;
  MOOD.cache = MOOD.cache || {};
  const c = MOOD.cache[m]; if (c && Date.now() - c.t < 30e3) return c.v;
  let v = null; try { v = moodCalc(m); } catch (e) { console.error(e); }
  MOOD.cache[m] = { t: Date.now(), v };
  return v;
}

/* ── 오늘 온도 기록 (이 기기 · 2분 간격) ── */
function mdLogKey() { return 'mdLog_' + mdToday(); }
function mdLogSave(A, Q) {
  if (!mdOpen() || !A || !Q) return;
  const k = mdLogKey(), L = store.get(k, []) || [], t = mdKst().toISOString().slice(11, 16);
  const last = L[L.length - 1];
  if (last && (last[0] === t || (Date.now() - (last[5] || 0)) < 110e3)) return;
  L.push([t, A.temp, Q.temp, A.q ? A.q.price : null, Q.q ? Q.q.price : null, Date.now()]);
  while (L.length > 220) L.shift();
  try { store.set(k, L); Object.keys(localStorage).filter(x => x.startsWith('scr_mdLog_') && x !== 'scr_' + k).forEach(x => localStorage.removeItem(x)); } catch (e) {}
}
function mdLog() { return store.get(mdLogKey(), []) || []; }

/* ── 그림 ── */
function mdGauge(t, small) {
  const L = mdLabel(t);
  return `<div class="md-g ${small ? 'sm' : ''}"><div class="md-gbar"><i style="left:${t}%"></i></div><div class="md-gl"><span>얼어붙음</span><span>서늘</span><span>따뜻</span><span>과열</span></div></div>`;
}
function mdSvgLine(series, opt = {}) {
  const W = opt.w || 560, H = opt.h || 140, all = series.flatMap(s => s.v.filter(x => x != null)).concat(opt.ref != null ? [opt.ref] : []);
  if (all.length < 2) return '';
  const n = Math.max(...series.map(s => s.v.length)), mn = Math.min(...all), mx = Math.max(...all), sp = mx - mn || 1;
  const X = i => 34 + i / Math.max(1, n - 1) * (W - 44), Y = v => 8 + (mx - v) / sp * (H - 26);
  const pl = s => { let d = '', pen = false; s.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }); return `<path d="${d}" fill="none" stroke="${s.c}" stroke-width="${s.wd || 1.8}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`; };
  const ref = opt.ref != null ? `<line x1="34" x2="${W - 10}" y1="${Y(opt.ref)}" y2="${Y(opt.ref)}" stroke="var(--muted)" stroke-dasharray="3 3"/><text x="${W - 10}" y="${Y(opt.ref) - 3}" font-size="10" fill="var(--muted)" text-anchor="end">${esc(opt.refL || '')}</text>` : '';
  const lab = opt.labels || [];
  return `<svg viewBox="0 0 ${W} ${H}" class="md-svg" role="img" aria-label="${esc(opt.aria || '')}">${ref}${series.map(pl).join('')}
    <text x="2" y="12" font-size="10" fill="var(--muted)">${fmt(mx, opt.dg ?? 0)}</text><text x="2" y="${H - 18}" font-size="10" fill="var(--muted)">${fmt(mn, opt.dg ?? 0)}</text>
    ${lab[0] ? `<text x="34" y="${H - 2}" font-size="10" fill="var(--muted)">${esc(lab[0])}</text>` : ''}${lab[1] ? `<text x="${W - 10}" y="${H - 2}" font-size="10" fill="var(--muted)" text-anchor="end">${esc(lab[1])}</text>` : ''}</svg>
    ${opt.leg ? `<div class="iv-leg">${series.filter(s => s.n).map(s => `<span><i style="background:${s.c}"></i>${esc(s.n)}</span>`).join('')}</div>` : ''}`;
}
function mdCard(A, big) {
  if (!A) return '';
  const q = A.q, t = A.temp;
  const L = mdLog(), k = A.m === 'KOSPI' ? 1 : 2, first = L.find(x => x[k] != null), dT = first && L.length > 1 ? t - first[k] : null;
  return `<div class="md-card md-${A.L[0]}${big ? ' big' : ''}" data-md="${A.m}">
    <div class="md-top"><div><b class="md-nm">${A.nm}</b>${q ? `<span class="md-px ${cls(q.pct)}">${fmt(q.price, 2)} <em>${pct2(q.pct)}</em></span>` : ''}</div>
      <div class="md-t"><b>${t}<small>도</small></b><span>${A.L[1]}</span></div></div>
    ${mdGauge(t, !big)}
    <p class="md-h">${esc(A.L[2])}${dT != null && Math.abs(dT) >= 3 ? ` <span class="md-d ${dT > 0 ? 'up' : 'down'}">오늘 ${first[0]} 대비 ${dT > 0 ? '+' : ''}${dT}도</span>` : ''}</p>
    ${A.tags.length ? `<div class="md-tags">${A.tags.slice(0, big ? 6 : 2).map(([c, n]) => `<span class="md-tag ${c}">${esc(n)}</span>`).join('')}</div>` : ''}
    ${q ? `<small class="md-src">${q.src === '실시간' ? '<span class="gov-live"></span>' : ''}${esc(q.src)} ${esc(String(q.at || '').slice(0, 10) === mdToday() ? String(q.at).slice(11, 16) : String(q.at || '').slice(5, 16))}</small>` : ''}
  </div>`;
}

/* ── 대시보드 요약 ── */
function renderMoodDash() {
  const box = $('#moodDash'); if (!box || !S.data) return;
  const A = moodGet('KOSPI'), Q = moodGet('KOSDAQ');
  if (!A && !Q) { box.innerHTML = '<div class="hint">지수 온도 자료를 불러오는 중이에요.</div>'; return; }
  const gap = A && Q ? A.temp - Q.temp : null;
  box.innerHTML = `<div class="ph"><h2>지수 온도 <small class="muted">코스피·코스닥 흐름과 분위기</small></h2><button class="btn ghost small" id="mdGo">자세히 보기 →</button></div>
    <div class="md-cards">${mdCard(A)}${mdCard(Q)}</div>
    <p class="md-one">${esc(mdOneLine(A, Q, gap))}</p>`;
  const b = $('#mdGo'); if (b) b.onclick = () => { switchTab('mood'); renderMoodTab(); };
  $$('#moodDash [data-md]').forEach(el => el.onclick = () => { MOOD.sel = el.dataset.md; switchTab('mood'); renderMoodTab(); });
}
function mdOneLine(A, Q, gap) {
  const t = A && Q ? Math.round((A.temp * 0.6 + Q.temp * 0.4)) : (A || Q).temp, L = mdLabel(t);
  let s = `시장 전체 체감 ${t}도(${L[1]}). `;
  if (gap != null && gap >= 12) s += `코스닥이 코스피보다 ${gap}도 차가워요 — 중소형·성장주보다 대형주가 유리한 장이에요. `;
  else if (gap != null && gap <= -12) s += `코스닥이 코스피보다 ${-gap}도 뜨거워요 — 중소형·테마주로 돈이 도는 장이에요. `;
  s += t >= 65 ? '매수 신호를 믿어도 되는 환경이에요.' : t >= 52 ? '선별 매수 환경이에요.' : t >= 40 ? '신규 매수는 줄이고 지켜보는 환경이에요.' : '현금 비중을 지키는 환경이에요.';
  return s;
}

/* ── 지수 온도 탭 ── */
function renderMoodTab() {
  const box = $('#mdBody'); if (!box || !S.data) return;
  const A = moodGet('KOSPI'), Q = moodGet('KOSDAQ');
  $('#mdCards').innerHTML = A || Q ? `${mdCard(A, true)}${mdCard(Q, true)}<p class="md-one">${esc(mdOneLine(A, Q, A && Q ? A.temp - Q.temp : null))}</p>` : '<div class="hint">자료를 불러오는 중이에요.</div>';
  const meta = $('#mdMeta'); if (meta) meta.innerHTML = `${mdOpen() ? '<span class="gov-live"></span> 장중 — 20초마다 갱신' : '장 마감 — 마지막 값 기준'}${MOOD.q ? ` · 지수 ${esc(String(MOOD.q.at).slice(11, 19))}` : ' · 지수 실시간 연결 대기(15분 자료 사용)'}`;
  $$('#mdCards [data-md]').forEach(el => el.onclick = () => { MOOD.sel = el.dataset.md; renderMoodTab(); });
  const X = MOOD.sel === 'KOSDAQ' ? Q : A; if (!X) { box.innerHTML = ''; return; }
  const D = X.D, q = X.q;
  // 장중 흐름(분봉 → 없으면 이 기기 기록)
  let intra = '';
  if (q && q.min && q.min.length >= 5) {
    const prev = q.chg != null ? q.price - q.chg : null;
    intra = mdSvgLine([{ v: q.min.map(x => x[1]), c: 'var(--text)' }], { ref: prev, refL: '전일 종가', labels: [q.min[0][0], q.min[q.min.length - 1][0]], dg: 0, aria: X.nm + ' 오늘 분봉' });
  } else {
    const L = mdLog(), k = X.m === 'KOSPI' ? 3 : 4, pts = L.filter(x => x[k] != null);
    if (pts.length >= 3) intra = mdSvgLine([{ v: pts.map(x => x[k]), c: 'var(--text)' }], { labels: [pts[0][0], pts[pts.length - 1][0]], aria: X.nm + ' 오늘 흐름' });
  }
  const L = mdLog(), k = X.m === 'KOSPI' ? 1 : 2, tp = L.filter(x => x[k] != null);
  const tline = tp.length >= 3 ? mdSvgLine([{ v: tp.map(x => x[k]), c: 'var(--up)' }], { ref: 50, refL: '50도', labels: [tp[0][0], tp[tp.length - 1][0]], h: 110, aria: '오늘 온도 변화' }) : '';
  let daily = '';
  if (D) {
    const n = Math.min(90, D.c.length), sl = a => a.slice(-n), ma = p => D.c.map((_, i) => mdSma(D.c, p, i));
    daily = mdSvgLine([{ v: sl(D.c), c: 'var(--text)', n: '종가' }, { v: sl(ma(20)), c: 'var(--warn)', n: '20일선', wd: 1.4 }, { v: sl(ma(60)), c: 'var(--muted)', n: '60일선', wd: 1.2, dash: '4 3' }],
      { labels: [sl(D.d)[0].slice(5), sl(D.d)[n - 1].slice(5)], leg: true, h: 160, aria: X.nm + ' 최근 90일' });
  }
  const lv = D ? [['20일선', D.ma20], ['60일선', D.ma60], ['120일선', D.ma120], ['60일 고점', D.hi60], ['60일 저점', D.lo60]].filter(x => x[1]).sort((a, b) => b[1] - a[1]) : [];
  box.innerHTML = `<div class="md-detail">
    <h3>${X.nm} 온도 ${X.temp}도 <small class="muted">${esc(X.L[1])}</small></h3>
    <div class="md-comps">${MD_W.map(([kk, n, w]) => { const v = X.C[kk]; return `<div class="md-comp"><span class="l">${n} <small>${w}%</small></span><div class="md-cbar">${v != null ? `<i class="${v >= 55 ? 'p' : v <= 45 ? 'm' : ''}" style="width:${v}%"></i>` : ''}<em></em></div><b class="mono">${v != null ? Math.round(v) : '–'}</b><p>${esc(X.why[kk] || '자료 없음')}</p></div>`; }).join('')}</div>
    ${X.tags.length ? `<h4 class="mt">지금 장의 성격</h4><div class="md-tagl">${X.tags.map(([c, n, t]) => `<div class="md-tg ${c}"><b>${esc(n)}</b><p>${esc(t)}</p></div>`).join('')}</div>` : ''}
    <div class="md-2">
      <div><h4>해설</h4><ul class="md-lines">${X.lines.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>
      <div><h4>실전 대응</h4><ul class="sh-todo">${X.todo.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        ${lv.length ? `<h4 class="mt-s">주요 가격대</h4><div class="md-lv">${lv.map(([n, v]) => `<div class="${v > (q ? q.price : D.P) ? 'r' : 's'}"><span>${n}</span><b class="mono">${fmt(v, 2)}</b><small>${pct2((v / (q ? q.price : D.P) - 1) * 100)}</small></div>`).join('')}</div>` : ''}</div>
    </div>
    <div class="md-2 mt">
      <div><h4>오늘 장중 흐름</h4>${intra || '<p class="hint">장중에 지수 분봉이 들어오거나 이 화면을 열어 두면 흐름을 그려요.</p>'}${tline ? `<h5 class="sh-h">오늘 온도 변화</h5>${tline}` : ''}</div>
      <div><h4>최근 90일 일봉</h4>${daily || `<p class="hint">일봉 파일을 기다리는 중이에요(15분마다 갱신).${X.ci ? ` 차트 종합판정: ${esc(X.ci.v)} ${X.ci.s > 0 ? '+' : ''}${fmt(X.ci.s, 1)}` : ''}</p>`}
        ${D ? `<p class="hint">RSI ${fmt(D.rsi, 0)} · 하루 평균 흔들림 ${fmt(D.atrp, 2)}% · 60일 고점 대비 ${pct2(D.dd60)} · 1년 고점 대비 ${pct2(D.dd250)}</p>` : ''}</div>
    </div>
    <details class="hint mt"><summary>온도 계산 방법</summary>여섯 항목을 각각 0~100점으로 매긴 뒤 비중(오늘 등락 20 · 추세 20 · 시장의 폭 20 · 수급 15 · 거래대금 열기 10 · 해외 15)으로 평균해요. 자료가 없는 항목은 빼고 나머지로 다시 나눠요. 거래대금 열기는 오르는 날 늘면 +, 내리는 날 늘면(투매) − 로 봐요. 80도↑ 과열 · 65↑ 따뜻함 · 52↑ 온화 · 40↑ 서늘함 · 25↑ 차가움 · 그 아래 얼어붙음. 매매 타이밍 화면은 이 온도를 받아 40도 아래면 1차 매수 수량을 줄이고, 25도 아래면 신규 매수를 보류해요.</details>
  </div>`;
}

/* ── 실시간 루프 ── */
async function moodLoop(force) {
  if (MOOD.busy || !S.data) return;
  const onDash = $('#tab-dash') && $('#tab-dash').classList.contains('on'), onTab = $('#tab-mood') && $('#tab-mood').classList.contains('on');
  const onTm = $('#tab-timing') && $('#tab-timing').classList.contains('on');
  if (!force && document.hidden) return;
  MOOD.busy = true;
  try {
    if (onDash || onTab || onTm || force) {
      await Promise.all([mdLoadBars(force), mdLoadQuote(force), typeof invMarketLive === 'function' && !(typeof INV !== 'undefined' && INV.m && Date.now() - INV.mt < 50e3) ? invMarketLive() : null]);
    }
    MOOD.cache = {};
    const A = moodGet('KOSPI'), Q = moodGet('KOSDAQ');
    mdLogSave(A, Q);
    if (onDash) renderMoodDash();
    if (onTab) renderMoodTab();
  } catch (e) { console.error(e); }
  MOOD.busy = false;
}
function initMood() {
  moodLoop(true);
  setInterval(() => moodLoop(false), 20e3);
  const tb = $('button[data-tab="mood"]'); if (tb) tb.addEventListener('click', () => { renderMoodTab(); moodLoop(true); });
  const db = $('button[data-tab="dash"]'); if (db) db.addEventListener('click', () => renderMoodDash());
  if (typeof FM !== 'undefined') {
    FM.mkt_temp = { key: 'mkt_temp', label: '소속 시장 지수 온도(0~100도)', group: '시장', type: 'num', unit: '도', get: s => { const v = moodGet(s.market); return v ? v.temp : null; } };
  }
}
(function waitBootMood() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initMood();
  else setTimeout(waitBootMood, 700);
})();
