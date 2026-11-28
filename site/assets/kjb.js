/* 주도주 찾기(김종봉식) — 김작가TV 「월 1억 버는 투자자의 주식투자 매수 타이밍」(김종봉) 영상의 핵심 원칙을 화면으로 옮김
   ① 지수 먼저: 코스피·코스닥 흐름 + 삼성전자가 지수보다 먼저 고점을 넘는지(시장 방향 선행) + 위기(반토막) 시나리오
   ② 지수보다 강한 종목: 최근 20일·5일 지수 대비 초과 수익 · 지수가 빠진 날 오른 횟수 · 지수가 못 넘은 고점을 먼저 돌파
   ③ 주도 섹터 기록 · 순환: 강한 종목이 몰린 업종, 10거래일 전과 비교해 새로 강해진/식은 업종
   ④ 대장주 후보: 거래대금 1,000억~2,000억 이상 터짐 · 의미 있는 양봉 · 재무가 좋은 종목
   ⑤ 매수 타이밍: 고점 돌파 뒤 20일선 눌림에서 매수(돌파 당일 추격 금지) · 박스권은 분할 · 손절 기준을 먼저 정함
   ⑥ 매도: 단타 +5% · 스윙 +10~20% · 손절 −5% · 시간 손절(1주 안에 안 가면 재검토, 물리면 최대 1개월)
   ⑦ 확률 검증: 규칙을 과거 차트에 돌려 승률 60% 이상만 실전 · 시가총액 구간별로 따로 확인
   ⑧ 자금 관리·투자 노트: 소액·분산(10종목 중 3개는 손실 가정) · 지수 대비 성과 기록 · 연속 손실이면 쉬기 */
'use strict';

const KJB = { busy: false, last: null, lt: 0, open: new Set(), n: 40, bt: null };
const kjbC = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const kjbP = v => v == null || !isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${fmt(v, Math.abs(v) < 10 ? 1 : 0)}%`;
const kjbEok = v => v == null ? '–' : Math.abs(v) >= 10000 ? fmt(v / 10000, 1) + '조' : fmt(v, 0) + '억';
const KJB_RULES = [
  ['지수부터 본다', '매일 코스피·코스닥 차트를 먼저 보고 시장의 온도를 잰다. 삼성전자가 지수보다 먼저 직전 고점을 넘으면 지수 상승의 신호로 보고 매수 여력을 늘린다.'],
  ['지수보다 강한 종목만', '시장의 돈은 한정돼 있다. 지수가 빠지는 날에도 버티거나 오르는 종목, 지수가 못 넘은 고점을 먼저 넘는 종목이 며칠~몇 달 뒤 대장주가 된다. 남이 추천하는 종목은 이미 오른 경우가 많다.'],
  ['섹터를 기록하고 넓힌다', '시가총액 상위부터 지수를 이기는 종목을 찾아 그 업종을 노트에 적고, 같은 시기 지수보다 강한 같은 업종 종목으로 넓힌다. 주도주는 돌아가며 바뀐다(순환).'],
  ['대장주 조건', '초기에 거래대금이 1,000억~2,000억 원 이상 터지고, 의미 있는 양봉이 나오고, 그중 재무가 가장 좋은 종목.'],
  ['돌파 뒤 눌림에서 산다', '지수를 이기며 직전 고점을 돌파한 종목은 쫓아가지 말고 20일선 근처로 눌릴 때 산다. 박스권에서는 나눠서 산다.'],
  ['손절을 먼저 정한다', '사기 전에 손절 가격·매수 규모를 정한다. 떨어지는 이유를 찾지 말고 기준대로 짧게 자른다(예: 손절 −5%).'],
  ['익절·보유 기간', '빠른 매매는 +5% 안팎, 길게 가져가면 +10~20%. 1주 안에 안 가면 다시 보고, 물렸을 때는 최대 1개월을 기준으로 정리한다.'],
  ['확률로 검증한다', '규칙을 과거 차트에 대 보고 승률이 60% 이상일 때만 실전에 쓴다. 시가총액 구간마다 따로 확인하고, 지키기 어려운 규칙은 고치거나 버린다.'],
  ['소액·분산·노트', '감당할 수 있는 작은 돈으로 여러 번 나눠 시작한다. 10종목 중 3개는 손실이 난다고 가정하고 분산한다. 투자 노트로 수익이 실력인지 지수 덕인지 구분하고, 손실 스트레스가 크면 쉰다.'],
];

/* 지수 일봉(실시간 끝값 반영) */
async function kjbLoadIdx() {
  if (typeof mdLoadBars === 'function') { try { await mdLoadBars(); } catch (e) {} }
  if (typeof MOOD !== 'undefined' && (!MOOD.bars.KOSPI || !MOOD.bars.KOSDAQ)) {   // 다른 화면이 아직 받는 중이면 직접 받음
    const raw = (typeof CLX !== 'undefined' && CLX.RAW) || 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-cl/';
    await Promise.all(['KOSPI', 'KOSDAQ'].filter(m => !MOOD.bars[m]).map(async m => { try { const r = await fetch(raw + m + '.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) { const f = await r.json(); if (f && f.c && f.c.length >= 60) MOOD.bars[m] = f; } } catch (e) {} }));
  }
}
function kjbIdx(m) {
  const f = typeof MOOD !== 'undefined' && MOOD.bars ? MOOD.bars[m] : null; if (!f || !f.c) return null;
  const d = [...f.d], c = [...f.c], h = [...f.h], l = [...f.l];
  const q = typeof mdQuote === 'function' ? mdQuote(m) : null, today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (q && q.src === '실시간' && q.price) { if (d[d.length - 1] === today) c[c.length - 1] = q.price; else if (d[d.length - 1] < today) { d.push(today); c.push(q.price); h.push(q.high || q.price); l.push(q.low || q.price); } }
  return { d, c, h, l };
}
/* 종목 120봉을 지수 날짜에 맞춤 → 지수 종가 배열(같은 길이) */
function kjbAlignIdx(I, n, lastDate) {
  if (!I) return null; let e = I.d.lastIndexOf(lastDate); if (e < 0) e = I.d.length - 1;
  const s = e - n + 1; if (s < 0) return null; return { c: I.c.slice(s, e + 1), h: I.h.slice(s, e + 1), d: I.d.slice(s, e + 1) };
}
const kjbMa = (a, n, i) => { if (i - n + 1 < 0) return null; let t = 0; for (let k = i - n + 1; k <= i; k++) t += a[k]; return t / n; };

/* 종목 하나 분석 */
function kjbStock(s, IX, asof) {
  const C = s.spark, O = s.spark_o, H = s.spark_h, L = s.spark_l, V = s.spark_vol; if (!C || !O || !H || !L || !V || C.length < 80) return null;
  const n = C.length, c = [...C], h = [...H], l = [...L], o = [...O], v = [...V];
  const lv = s._live && s._live.d && s._live.d >= asof ? s._live : null;
  if (lv && lv.c && lv.d > asof) { /* 15분 일봉이 이미 오늘 봉으로 바뀌어 있으면 그대로 */ }
  if (lv && lv.c) { c[n - 1] = lv.c; h[n - 1] = Math.max(h[n - 1], lv.c); l[n - 1] = Math.min(l[n - 1], lv.c); }
  const I = kjbAlignIdx(IX, n, (s._vlive && s._vlive.d) || asof); if (!I) return null;
  const i = n - 1, ret = (a, k) => (a[i] / a[i - k] - 1) * 100;
  const rs20 = ret(c, 20) - ret(I.c, 20), rs5 = ret(c, 5) - ret(I.c, 5);
  let dn = 0, dnUp = 0; for (let k = i - 19; k <= i; k++) { const ic = I.c[k] / I.c[k - 1] - 1, sc = c[k] / c[k - 1] - 1; if (ic <= -0.003) { dn++; if (sc > 0) dnUp++; } }
  // 지수보다 먼저 고점 돌파: 최근 10일 안에 60일 고점을 새로 넘었는데 지수는 같은 기간 60일 고점을 못 넘음
  let brk = -1; for (let k = i; k >= i - 9; k--) { const hi = Math.max(...h.slice(k - 60, k)); if (c[k] > hi) { brk = k; break; } }
  let idxBrk = false; if (brk >= 0) { for (let k = brk - 2; k <= i; k++) { const ihi = Math.max(...I.c.slice(Math.max(0, k - 60), k)); if (I.c[k] > ihi) idxBrk = true; } }
  const lead = brk >= 0 && !idxBrk;
  const m20 = kjbMa(c, 20, i), m20p = kjbMa(c, 20, i - 5), m5 = kjbMa(c, 5, i);
  // 강도 점수
  let st = 50 + kjbC(rs20 * 1.2, -30, 30) + kjbC(rs5 * 1.5, -10, 10) + (dn ? (dnUp / dn - 0.4) * 25 : 0) + (lead ? 12 : brk >= 0 ? 5 : 0) + (m20 && c[i] > m20 ? 4 : -6);
  st = Math.round(kjbC(st));
  // 대장주 조건: 거래대금 터짐 · 의미 있는 양봉 · 재무
  let tvMax = 0, tvAt = -1, a20 = 0; for (let k = i - 30; k < i - 10; k++) a20 += c[k] * v[k] / 1e8; a20 /= 20;
  for (let k = i - 9; k <= i; k++) { const t = c[k] * v[k] / 1e8 * (k === i && s._vlive && s._vlive.intr ? s._vlive.f || 1 : 1); if (t > tvMax) { tvMax = t; tvAt = k; } }
  const tvBig = tvMax >= 2000 ? 2 : tvMax >= 1000 ? 1 : 0, tvRel = a20 ? tvMax / a20 : null;
  let bull = null; for (let k = i; k >= i - 9; k--) { const body = (c[k] / o[k] - 1) * 100, pos = h[k] > l[k] ? (c[k] - l[k]) / (h[k] - l[k]) : 1, vr = v[k] / (v.slice(k - 20, k).reduce((p, q) => p + q, 0) / 20 || 1); if (body >= 5 && pos >= 0.7 && vr >= 2) { bull = { k, body, vr }; break; } }
  const roe = s.roe3 && s.roe3.length ? s.roe3.filter(x => x != null).reduce((p, q) => p + q, 0) / s.roe3.filter(x => x != null).length : null;
  let fin = 50; const fz = [];
  if (s.op_yoy != null) { fin += kjbC(s.op_yoy / 4, -15, 15); if (s.op_yoy >= 30) fz.push(`영업이익 ${kjbP(s.op_yoy)}`); }
  if (s.sales_yoy != null) fin += kjbC(s.sales_yoy / 5, -8, 8);
  if (roe != null && isFinite(roe)) { fin += kjbC((roe - 8) * 1.2, -12, 15); if (roe >= 15) fz.push(`ROE ${fmt(roe, 0)}%`); }
  if (s.debt_ratio != null && !s.is_fin) { fin += s.debt_ratio <= 100 ? 6 : s.debt_ratio >= 250 ? -10 : 0; if (s.debt_ratio >= 250) fz.push(`부채비율 ${fmt(s.debt_ratio, 0)}%`); }
  if (s.op_turn === 1 || s.op_turn === true) { fin += 6; fz.push('흑자 전환'); }
  fin = Math.round(kjbC(fin));
  const leadOk = (tvBig ? 1 : 0) + (bull ? 1 : 0) + (fin >= 60 ? 1 : 0);
  const capt = Math.round(kjbC(st * 0.5 + (tvBig === 2 ? 25 : tvBig ? 18 : tvRel >= 3 ? 8 : 0) + (bull ? 12 : 0) + (fin - 50) * 0.4 + (lead ? 5 : 0)));
  // 매수 타이밍 상태
  const hi20 = Math.max(...h.slice(i - 19, i + 1)), lo20 = Math.min(...l.slice(i - 19, i + 1)), box = (hi20 / lo20 - 1) * 100, gapM = m20 ? (c[i] / m20 - 1) * 100 : null;
  let state, stTxt;
  if (brk >= 0 && brk === i && gapM != null && gapM > 6) { state = 'chase'; stTxt = '오늘 돌파 — 추격 금지, 눌림 대기'; }
  else if (brk >= 0 || (st >= 60 && gapM != null && gapM > 0)) {
    if (gapM != null && gapM >= -3 && gapM <= 3) { state = 'pull'; stTxt = '20일선 눌림 — 매수 구간'; }
    else if (gapM != null && gapM > 8) { state = 'chase'; stTxt = `20일선보다 ${fmt(gapM, 0)}% 위 — 추격 금지`; }
    else if (gapM != null && gapM < -3) { state = 'weak'; stTxt = '20일선 아래 — 강세 이탈 확인'; }
    else { state = 'near'; stTxt = '눌림 진행 중 — 20일선 접근 대기'; }
  } else if (box <= 12) { state = 'box'; stTxt = `박스권(${fmt(box, 0)}%) — 하단 분할 매수`; }
  else { state = 'wait'; stTxt = '관찰'; }
  const entry = state === 'pull' ? c[i] : m20 ? Math.round(m20) : c[i];
  const plan = { entry, stop: Math.round(Math.min(entry * 0.95, m20 ? m20 * 0.97 : entry * 0.95)), t1: Math.round(entry * 1.05), t2: Math.round(entry * 1.10), t3: Math.round(entry * 1.20) };
  const r20 = ret(c, 20), strong = rs20 >= 5 && st >= 65 && (r20 >= 0 || (dn && dnUp / dn >= 0.5));   // 지수보다 강하면서, 실제로 오르거나 하락일에도 버틴 종목
  return { s, c: c[i], chg: lv ? lv.chg : s.chg, rs20, rs5, dn, dnUp, brk: brk >= 0 ? i - brk : null, lead, st, tvMax, tvBig, tvRel, bull, fin, fz, roe, leadOk, capt, state, stTxt, gapM, box, plan, strong, rs20p: n > 40 ? (c[i - 10] / c[i - 30] - 1) * 100 - (I.c[i - 10] / I.c[i - 30] - 1) * 100 : null };
}

/* ① 지수 확인 */
function kjbMarket() {
  const out = {};
  ['KOSPI', 'KOSDAQ'].forEach(m => {
    const I = kjbIdx(m); if (!I) return;
    const c = I.c, n = c.length, i = n - 1, m20 = kjbMa(c, 20, i), m60 = kjbMa(c, 60, i), m20p = kjbMa(c, 20, i - 5);
    const hi250 = Math.max(...c.slice(-250)), dd = (c[i] / hi250 - 1) * 100, hi60 = Math.max(...c.slice(i - 60, i));
    const st = c[i] > m20 && m20 > m60 && m20 > m20p ? ['up', '상승 추세 — 매수 여력 유지'] : c[i] < m20 && m20 < m60 ? ['down', '하락 추세 — 비중 줄이고 강한 종목만'] : ['mid', '방향 탐색 — 지수보다 강한 종목만 소액'];
    const crisis = dd <= -45 ? ['crisis', `1년 고점 대비 ${kjbP(dd)} — 「반토막」 위기 시나리오 구간: 역사적으로 큰 반등이 시작된 자리(분할 집중 매수 검토)`] : dd <= -25 ? ['warn', `1년 고점 대비 ${kjbP(dd)} — 공포 구간, 분할 매수 준비`] : null;
    out[m] = { I, c: c[i], chg: (c[i] / c[i - 1] - 1) * 100, r20: (c[i] / c[i - 20] - 1) * 100, m20, m60, dd, hi60, brk: c[i] > hi60, st, crisis };
  });
  // 삼성전자 선행
  const ss = S.data.stocks.find(x => x.code === '005930');
  if (ss && out.KOSPI) {
    const r = kjbStock(ss, out.KOSPI.I, S.data.meta.asof);
    if (r) { const hi60 = Math.max(...ss.spark_h.slice(-61, -1)); out.ss = { r, brk: r.c > hi60, idxBrk: out.KOSPI.brk,
      txt: r.c > hi60 && !out.KOSPI.brk ? '삼성전자가 지수보다 먼저 60일 고점을 넘었어요 — 지수 상승을 앞서 알려주는 신호, 매수 여력을 늘려도 되는 환경이에요.' : r.rs20 >= 3 ? `삼성전자가 최근 20일 지수보다 ${fmt(r.rs20, 1)}%p 강해요 — 시장을 끌고 가는 중이에요.` : r.rs20 <= -3 ? `삼성전자가 최근 20일 지수보다 ${fmt(-r.rs20, 1)}%p 약해요 — 지수 상승을 기대하기 어려운 환경이에요.` : '삼성전자는 지수와 비슷하게 움직여요 — 뚜렷한 선행 신호 없음.' }; }
  }
  return out;
}

/* ③ 섹터 */
function kjbSectors(rows) {
  const g = {};
  rows.forEach(r => { const k = r.s.sector || '기타'; if (k === '기타') return; const o = g[k] = g[k] || { name: k, n: 0, strong: 0, rs: 0, rsP: 0, top: null, list: [] }; o.n++; o.rs += r.rs20; o.rsP += r.rs20p || 0; if (r.strong) { o.strong++; o.list.push(r); } if (!o.top || r.capt > o.top.capt) o.top = r; });
  return Object.values(g).filter(o => o.n >= 3).map(o => ({ ...o, rs: o.rs / o.n, rsP: o.rsP / o.n, share: o.strong / o.n, d: o.rs / o.n - o.rsP / o.n })).sort((a, b) => b.strong - a.strong || b.rs - a.rs);
}

/* ⑦ 확률 검증: 「지수보다 강함(20일 +3%p↑) + 최근 20일 안 60일 고점 돌파 + 20일선 눌림(±3%)」에 사서 익절/손절 중 먼저 닿은 것 */
function kjbBacktest(tp, sl, H) {
  const key = [tp, sl, H, S.data.meta.asof].join('|'); if (KJB.bt && KJB.bt.key === key) return KJB.bt;
  const buckets = [['1천억~5천억', 1000, 5000], ['5천억~1조', 5000, 10000], ['1조~10조', 10000, 100000], ['10조 이상', 100000, 1e12]], R = buckets.map(b => ({ name: b[0], n: 0, w: 0, ret: 0 })), all = { n: 0, w: 0, ret: 0 };
  ['KOSPI', 'KOSDAQ'].forEach(m => {
    const IX = typeof MOOD !== 'undefined' && MOOD.bars ? MOOD.bars[m] : null; if (!IX) return;
    S.data.stocks.filter(s => s.market === m).forEach(s => {
      const C = s._base ? s._base.c : s.spark, H_ = s._base && s._base.h ? s._base.h : s.spark_h, L_ = s._base && s._base.l ? s._base.l : s.spark_l; if (!C || !H_ || !L_ || C.length < 90) return;
      const n = C.length, I = kjbAlignIdx({ d: IX.d, c: IX.c, h: IX.h }, n, S.data.meta.asof); if (!I) return;
      const bi = buckets.findIndex(b => (s.mcap || 0) >= b[1] && (s.mcap || 0) < b[2]); if (bi < 0) return;
      let skip = -1;
      for (let t = 80; t < n - 1; t++) {
        if (t <= skip) continue;
        const rs = (C[t] / C[t - 20] - 1) * 100 - (I.c[t] / I.c[t - 20] - 1) * 100; if (rs < 3) continue;
        const m20 = kjbMa(C, 20, t), gap = (C[t] / m20 - 1) * 100; if (gap < -3 || gap > 3) continue;
        let brk = false; for (let k = t - 20; k < t; k++) { if (C[k] > Math.max(...H_.slice(k - 60, k))) { brk = true; break; } } if (!brk) continue;
        const e = C[t]; let res = null;
        for (let k = t + 1; k <= Math.min(n - 1, t + H); k++) { if (L_[k] <= e * (1 - sl / 100)) { res = -sl; break; } if (H_[k] >= e * (1 + tp / 100)) { res = tp; break; } }
        if (res == null) { if (t + H > n - 1) continue; res = (C[t + H] / e - 1) * 100; }
        const win = res > 0; R[bi].n++; R[bi].w += win; R[bi].ret += res; all.n++; all.w += win; all.ret += res; skip = t + H;
      }
    });
  });
  KJB.bt = { key, R, all, tp, sl, H }; return KJB.bt;
}

/* 투자 노트 */
const kjbNotes = () => store.get('kjbNote', []) || [];
function kjbIdxRet(m, d0, d1) { const f = typeof MOOD !== 'undefined' && MOOD.bars ? MOOD.bars[m] : null; if (!f) return null; const a = f.d.findIndex(x => x >= d0), b = d1 ? f.d.findIndex(x => x >= d1) : f.d.length - 1; if (a < 0 || b < 0) return null; return (f.c[b] / f.c[a] - 1) * 100; }

/* 전체 계산 */
function kjbCompute() {
  if (!S.data) return null;
  const mk = kjbMarket(), asof = S.data.meta.asof, rows = [];
  S.data.stocks.forEach(s => { const M = mk[s.market]; if (!M) return; try { const r = kjbStock(s, M.I, asof); if (r) rows.push(r); } catch (e) {} });
  KJB.last = { mk, rows, secs: kjbSectors(rows), at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16) }; KJB.lt = Date.now();
  return KJB.last;
}

/* ── 화면 ── */
function kjbMktHtml(mk) {
  const card = m => { const x = mk[m]; if (!x) return `<div class="kj-mc"><b>${m === 'KOSPI' ? '코스피' : '코스닥'}</b><p class="hint">지수 일봉을 불러오는 중이에요.</p></div>`;
    return `<div class="kj-mc ${x.st[0]}"><div class="kj-mh"><b>${m === 'KOSPI' ? '코스피' : '코스닥'}</b><span class="${cls(x.chg)}">${fmt(x.c, 2)} ${kjbP(x.chg)}</span></div>
      <p class="kj-mv">${esc(x.st[1])}</p><small>20일선 ${x.c > x.m20 ? '위' : '아래'} · 20일 ${kjbP(x.r20)} · 60일 고점 ${x.brk ? '돌파' : '아래'} · 1년 고점 대비 ${kjbP(x.dd)}</small>
      ${x.crisis ? `<p class="kj-cr ${x.crisis[0]}">${esc(x.crisis[1])}</p>` : ''}</div>`; };
  return `<div class="kj-mk">${card('KOSPI')}${card('KOSDAQ')}</div>${mk.ss ? `<p class="md-one"><b>삼성전자 선행 체크</b> ${esc(mk.ss.txt)}</p>` : ''}`;
}
function kjbSecHtml(secs) {
  const top = secs.filter(o => o.strong > 0).slice(0, 10), hot = secs.filter(o => o.d >= 3 && o.rs > 0).sort((a, b) => b.d - a.d).slice(0, 5), cold = secs.filter(o => o.d <= -3 && o.rsP > 0).sort((a, b) => a.d - b.d).slice(0, 5);
  return `<div class="kj-secs">${top.map(o => `<div class="kj-sc"><b>${esc(o.name)}</b><span>지수보다 강한 종목 ${o.strong}/${o.n}</span><small>업종 평균 지수 대비 ${kjbP(o.rs)}${o.top ? ` · 대장 후보 ${esc(o.top.s.name)}` : ''}</small></div>`).join('') || '<p class="hint">지수보다 강한 종목이 몰린 업종이 아직 없어요.</p>'}</div>
    <p class="hint kj-rot"><b>주도주 순환</b> ${hot.length ? `새로 강해진 업종: ${hot.map(o => `${esc(o.name)}(${kjbP(o.d)}p)`).join(', ')}` : '새로 강해진 업종 없음'} · ${cold.length ? `식어 가는 업종: ${cold.map(o => `${esc(o.name)}(${kjbP(o.d)}p)`).join(', ')}` : '식어 가는 업종 없음'} <small>(10거래일 전의 20일 지수 대비 성과와 비교)</small></p>`;
}
function kjbRow(r, i) {
  const s = r.s, op = KJB.open.has(s.code), stc = { pull: 'good', box: 'mid', near: 'mid', chase: 'warn', weak: 'bad', wait: '' }[r.state];
  return `<tr class="kj-r ${op ? 'open' : ''}" data-kj="${esc(s.code)}"><td class="mono">${i + 1}</td>
    <td class="l"><b class="kj-nm" data-kjan="${esc(s.code)}">${esc(s.name)}</b><small>${s.market === 'KOSPI' ? '코스피' : '코스닥'} · ${esc(s.sector || '')}</small></td>
    <td class="mono ${cls(r.chg)}">${fmt(r.c)}<small>${kjbP(r.chg)}</small></td>
    <td><span class="kj-sc2 ${r.capt >= 70 ? 'hi' : r.capt >= 55 ? 'md' : ''}">${r.capt}</span></td>
    <td class="mono ${cls(r.rs20)}">${kjbP(r.rs20)}p<small>5일 ${kjbP(r.rs5)}p</small></td>
    <td class="mono">${r.dn ? `${r.dnUp}/${r.dn}일` : '–'}</td>
    <td>${r.brk != null ? `<span class="kj-tg ${r.lead ? 'good' : ''}">${r.brk === 0 ? '오늘' : r.brk + '일 전'} 돌파${r.lead ? ' · 지수보다 먼저' : ''}</span>` : '<span class="muted">–</span>'}</td>
    <td class="mono">${kjbEok(r.tvMax)}${r.tvBig ? `<small class="good-t">${r.tvBig === 2 ? '2천억↑' : '1천억↑'}</small>` : r.tvRel >= 3 ? `<small>평소 ${fmt(r.tvRel, 1)}배</small>` : ''}</td>
    <td>${r.bull ? `<span class="kj-tg good">+${fmt(r.bull.body, 0)}% 양봉</span>` : '<span class="muted">–</span>'}</td>
    <td class="mono">${r.fin}</td>
    <td class="l"><span class="kj-st ${stc}">${esc(r.stTxt)}</span></td></tr>
    ${op ? `<tr class="kj-open"><td colspan="11">${kjbDetail(r)}</td></tr>` : ''}`;
}
function kjbDetail(r) {
  const p = r.plan, s = r.s, bt = KJB.bt;
  const cap = (s.mcap || 0) >= 100000 ? '10조 이상' : (s.mcap || 0) >= 10000 ? '1조~10조' : (s.mcap || 0) >= 5000 ? '5천억~1조' : '1천억~5천억', B = bt ? bt.R.find(x => x.name === cap) : null;
  return `<div class="kj-det"><div><h5>왜 「지수보다 강한 종목」인가</h5><ul>
      <li>최근 20일 지수보다 ${kjbP(r.rs20)}p, 최근 5일 ${kjbP(r.rs5)}p</li>
      <li>지수가 빠진 ${r.dn}일 중 ${r.dnUp}일 올랐어요${r.dn && r.dnUp / r.dn >= 0.5 ? ' — 하락장에서도 버티는 종목' : ''}</li>
      ${r.brk != null ? `<li>${r.brk === 0 ? '오늘' : r.brk + '거래일 전'} 60일 고점 돌파${r.lead ? ' — 지수는 아직 못 넘은 고점을 먼저 넘었어요' : ''}</li>` : ''}
      <li>최근 10일 최대 거래대금 ${kjbEok(r.tvMax)}${r.tvBig ? ' — 대장주 조건(1,000억↑) 충족' : ''}${r.bull ? ` · ${r.bull.k === r.s.spark.length - 1 ? '오늘' : ''} +${fmt(r.bull.body, 0)}% 의미 있는 양봉(거래량 ${fmt(r.bull.vr, 1)}배)` : ''}</li>
      <li>재무 ${r.fin}점${r.fz.length ? ' — ' + r.fz.join(', ') : ''}</li></ul></div>
    <div><h5>매매 계획 (사기 전에 먼저 정하기)</h5><div class="kj-plan">
      <div><span>매수</span><b>${fmt(p.entry)}원</b><small>${r.state === 'pull' ? '지금 20일선 눌림 구간' : '20일선 부근까지 기다리기'}${r.state === 'box' ? ' · 박스 하단 분할' : ''}</small></div>
      <div class="bad"><span>손절</span><b>${fmt(p.stop)}원</b><small>−5% 또는 20일선 −3% 이탈 · 이유 찾지 말고 실행</small></div>
      <div class="good"><span>익절</span><b>${fmt(p.t1)} / ${fmt(p.t2)} / ${fmt(p.t3)}</b><small>단타 +5% · 스윙 +10% · 길게 +20%</small></div>
      <div><span>보유 기간</span><b>1주 · 최대 1개월</b><small>1주 안에 +5% 못 가면 다시 판단, 물리면 1개월 안 정리</small></div>
      <div><span>비중</span><b>계좌의 10% 안팎</b><small>10종목 분산 — 3개는 손실 가정</small></div></div>
      ${B && B.n ? `<p class="hint">이 시가총액 구간(${cap})의 같은 규칙 과거 승률: ${fmt(B.w / B.n * 100, 0)}% (${B.n}번) — ${B.n < 10 ? '표본이 적어 판단 보류' : B.w / B.n >= 0.6 ? '60% 이상, 실전 기준 통과' : '60% 미만, 소액으로만'}</p>` : ''}
      <div class="row gap wrap mt-s"><button class="btn ghost small" data-kjgo="an" data-c="${esc(s.code)}">종목 분석</button><button class="btn ghost small" data-kjgo="tm" data-c="${esc(s.code)}">매매 타이밍</button><button class="btn ghost small" data-kjgo="note" data-c="${esc(s.code)}">투자 노트에 매수 기록</button></div></div></div>`;
}
function kjbBtHtml() {
  const sel = store.get('kjbBt', '5|5|5'), [tp, sl, H] = sel.split('|').map(Number), B = kjbBacktest(tp, sl, H);
  const rate = x => x.n ? x.w / x.n * 100 : null;
  return `<div class="row gap wrap"><label class="small">규칙 <select id="kjBt">${[['5|5|5', '익절 +5% · 손절 −5% · 5일'], ['8|5|10', '익절 +8% · 손절 −5% · 10일'], ['10|5|20', '익절 +10% · 손절 −5% · 20일'], ['20|7|25', '익절 +20% · 손절 −7% · 25일']].map(([k, n]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <span class="hint">「지수보다 20일 +3%p↑ 강함 + 최근 20일 안 60일 고점 돌파 + 20일선 ±3% 눌림」 날 종가에 샀다고 가정 · 최근 약 ${S.data.stocks[0].spark.length}거래일 · 익절과 손절 중 먼저 닿은 쪽(같은 날이면 손절로 계산)</span></div>
    <div class="kj-bt"><div class="kj-btc all ${rate(B.all) >= 60 ? 'ok' : 'no'}"><small>전체</small><b>${B.all.n ? fmt(rate(B.all), 0) + '%' : '–'}</b><span>${B.all.n}번 · 평균 ${kjbP(B.all.n ? B.all.ret / B.all.n : null)}</span></div>
      ${B.R.map(x => `<div class="kj-btc ${x.n >= 10 ? (rate(x) >= 60 ? 'ok' : 'no') : ''}"><small>${x.name}</small><b>${x.n ? fmt(rate(x), 0) + '%' : '–'}</b><span>${x.n}번${x.n ? ' · 평균 ' + kjbP(x.ret / x.n) : ''}${x.n && x.n < 10 ? ' · 표본 적음' : ''}</span></div>`).join('')}</div>
    <p class="hint">초록 = 승률 60% 이상(실전에 써도 되는 구간) · 빨강 = 60% 미만(소액 연습만). 시장 국면이 바뀌면 결과도 바뀌니 주기적으로 다시 확인하세요.</p>`;
}
function kjbNoteHtml() {
  const N = kjbNotes(), done = N.filter(x => x.sell), wins = done.filter(x => x.sell > x.buy);
  let streak = 0; for (let k = done.length - 1; k >= 0 && done[k].sell < done[k].buy; k--) streak++;
  const avg = done.length ? done.reduce((a, x) => a + (x.sell / x.buy - 1) * 100, 0) / done.length : null;
  const alpha = done.map(x => { const ir = kjbIdxRet(x.mkt || 'KOSPI', x.d, x.sd); return ir == null ? null : (x.sell / x.buy - 1) * 100 - ir; }).filter(v => v != null), al = alpha.length ? alpha.reduce((a, b) => a + b, 0) / alpha.length : null;
  return `<div class="kj-ns"><div><small>기록</small><b>${N.length}</b></div><div><small>청산</small><b>${done.length}</b></div><div><small>승률</small><b class="${done.length && wins.length / done.length >= 0.6 ? 'up' : ''}">${done.length ? fmt(wins.length / done.length * 100, 0) + '%' : '–'}</b></div><div><small>평균 수익</small><b class="${cls(avg)}">${kjbP(avg)}</b></div><div><small>지수 대비(실력)</small><b class="${cls(al)}">${al == null ? '–' : kjbP(al) + 'p'}</b></div></div>
    ${streak >= 3 ? `<p class="kj-cr warn">${streak}번 연속 손실이에요 — 원칙대로라면 며칠 매매를 쉬고 노트를 다시 보는 게 좋아요.</p>` : ''}
    <div class="row gap wrap kj-nf"><input id="kjnS" class="inp" list="stockNames" placeholder="종목" style="max-width:140px"><input id="kjnB" class="inp" type="number" placeholder="매수가" style="max-width:100px"><input id="kjnX" class="inp" type="number" placeholder="매도가(청산 시)" style="max-width:120px">
      <select id="kjnR"><option>지수보다 강함 + 20일선 눌림</option><option>고점 돌파 뒤 눌림</option><option>박스권 분할</option><option>위기 구간 분할</option><option>기타</option></select><input id="kjnM" class="inp" placeholder="메모(근거·실수)" style="flex:1;min-width:160px"><button class="btn primary small" id="kjnAdd">기록</button></div>
    ${N.length ? `<div class="table-wrap"><table class="tbl kj-nt"><thead><tr><th>매수일</th><th class="l">종목</th><th>매수</th><th>매도</th><th>수익</th><th>지수 대비</th><th class="l">근거 · 메모</th><th></th></tr></thead><tbody>${N.slice().reverse().map((x, j) => { const k = N.length - 1 - j, s = S.data.stocks.find(z => z.code === x.code), cur = s ? ((s._live && s._live.c) || s.close) : null, px = x.sell || cur, r = px ? (px / x.buy - 1) * 100 : null, ir = kjbIdxRet(x.mkt || 'KOSPI', x.d, x.sd), a = r != null && ir != null ? r - ir : null;
        return `<tr><td>${esc(x.d)}</td><td class="l"><b>${esc(x.name)}</b></td><td class="mono">${fmt(x.buy)}</td><td class="mono">${x.sell ? fmt(x.sell) : `<button class="btn ghost small" data-kjsell="${k}">청산</button>`}</td><td class="mono ${cls(r)}">${kjbP(r)}${x.sell ? '' : '<small>보유 중</small>'}</td><td class="mono ${cls(a)}">${a == null ? '–' : kjbP(a) + 'p'}</td><td class="l">${esc(x.why || '')}${x.memo ? ' · ' + esc(x.memo) : ''}</td><td><span class="bd-x" data-kjdel="${k}" role="button" title="삭제">×</span></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="hint">매수할 때 근거와 함께 적어 두면 승률·평균 수익·지수 대비 성과(지수가 오른 덕인지, 실력인지)를 계산해 줘요. 이 기기에 저장돼요.</p>'}`;
}
function kjbBindNote() {
  const add = $('#kjnAdd'); if (add) add.onclick = () => { const q = ($('#kjnS').value || '').trim(), h = typeof findStocks === 'function' ? findStocks(q) : [], s = h[0] || S.data.stocks.find(x => x.code === q); const b = +$('#kjnB').value, x = +$('#kjnX').value; if (!s || !b) { alert('종목과 매수가를 입력하세요'); return; }
    const N = kjbNotes(), d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); N.push({ code: s.code, name: s.name, mkt: s.market, d, buy: b, sell: x || null, sd: x ? d : null, why: $('#kjnR').value, memo: ($('#kjnM').value || '').trim() }); store.set('kjbNote', N.slice(-300)); kjbRenderNote(); };
  $$('#kjNote [data-kjsell]').forEach(b => b.onclick = () => { const N = kjbNotes(), k = +b.dataset.kjsell, v = prompt('매도가를 입력하세요', ''); if (v && +v > 0) { N[k].sell = +v; N[k].sd = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); store.set('kjbNote', N); kjbRenderNote(); } });
  $$('#kjNote [data-kjdel]').forEach(b => b.onclick = () => { const N = kjbNotes(); N.splice(+b.dataset.kjdel, 1); store.set('kjbNote', N); kjbRenderNote(); });
}
function kjbRenderNote() { const el = $('#kjNote'); if (el) { el.innerHTML = kjbNoteHtml(); kjbBindNote(); } }

function renderKjb() {
  const box = $('#kjBody'); if (!box || !S.data) return;
  const D = KJB.last && Date.now() - KJB.lt < 30e3 ? KJB.last : kjbCompute(); if (!D) return;
  $('#kjMeta').innerHTML = `${typeof kcOpenMkt === 'function' && kcOpenMkt() ? '<span class="gov-live"></span> 장중 — ' : ''}${D.at} 계산 · 분석 대상 ${D.rows.length}종목`;
  $('#kjMkt').innerHTML = kjbMktHtml(D.mk);
  $('#kjSec').innerHTML = kjbSecHtml(D.secs);
  const f = { mkt: $('#kjFm').value, st: $('#kjFs').value, cap: $('#kjFc').value, sort: $('#kjFo').value, q: ($('#kjQ').value || '').trim() };
  let L = D.rows.filter(r => (f.mkt === 'all' || r.s.market === f.mkt) && (f.q ? (r.s.name.includes(f.q) || r.s.code.includes(f.q) || String(r.s.sector).includes(f.q)) : r.strong) && (f.st === 'all' || r.state === f.st || (f.st === 'buy' && (r.state === 'pull' || r.state === 'box'))) && (f.cap === 'all' || (f.cap === 'lead' ? r.leadOk >= 2 : f.cap === 'tv' ? r.tvBig >= 1 : true)));
  const cmp = { capt: (a, b) => b.capt - a.capt, st: (a, b) => b.st - a.st, rs: (a, b) => b.rs20 - a.rs20, tv: (a, b) => b.tvMax - a.tvMax, fin: (a, b) => b.fin - a.fin }[f.sort];
  L = L.sort(cmp);
  const nStrong = D.rows.filter(r => r.strong).length, nPull = D.rows.filter(r => r.strong && r.state === 'pull').length, nLead = D.rows.filter(r => r.strong && r.leadOk >= 2).length;
  $('#kjCnt').innerHTML = `지수보다 강한 종목 <b>${nStrong}</b> · 그중 대장주 조건 2개 이상 <b>${nLead}</b> · 지금 20일선 눌림 매수 구간 <b>${nPull}</b>`;
  box.innerHTML = L.length ? `<div class="table-wrap"><table class="tbl kj-tb"><thead><tr><th>#</th><th class="l">종목</th><th>현재가</th><th>대장주 점수</th><th>지수 대비(20일)</th><th>지수 하락일 상승</th><th>고점 돌파</th><th>최대 거래대금(10일)</th><th>의미 있는 양봉</th><th>재무</th><th class="l">매수 타이밍</th></tr></thead><tbody>${L.slice(0, KJB.n).map(kjbRow).join('')}</tbody></table></div>${L.length > KJB.n ? `<button class="btn ghost small mt-s" id="kjMore">더 보기 (${L.length}종목 중 ${KJB.n})</button>` : ''}` : '<p class="hint">조건에 맞는 종목이 없어요. 필터를 넓혀 보세요.</p>';
  $$('#kjBody tr[data-kj]').forEach(tr => tr.onclick = e => { if (e.target.closest('[data-kjan],[data-kjgo]')) return; const c = tr.dataset.kj; KJB.open.has(c) ? KJB.open.delete(c) : KJB.open.add(c); renderKjb(); });
  $$('#tab-kjb [data-kjan]').forEach(el => el.onclick = e => { e.stopPropagation(); showAnalysis(el.dataset.kjan); });
  $$('#kjBody [data-kjgo]').forEach(b => b.onclick = e => { e.stopPropagation(); const c = b.dataset.c, g = b.dataset.kjgo; if (g === 'an') showAnalysis(c); else if (g === 'tm' && typeof openTiming === 'function') openTiming(c); else if (g === 'note') { const r = D.rows.find(x => x.s.code === c); $('#kjnS').value = r.s.name; $('#kjnB').value = r.plan.entry; $('#kjNote').scrollIntoView({ behavior: 'smooth' }); } });
  const mo = $('#kjMore'); if (mo) mo.onclick = () => { KJB.n += 40; renderKjb(); };
  const bt = $('#kjBtBox'); if (bt) { bt.innerHTML = kjbBtHtml(); const s = $('#kjBt'); if (s) s.onchange = () => { store.set('kjbBt', s.value); bt.innerHTML = kjbBtHtml(); const s2 = $('#kjBt'); if (s2) s2.onchange = s.onchange; }; }
  if (!$('#kjNote').dataset.init) { $('#kjNote').dataset.init = 1; kjbRenderNote(); }
}
async function kjbLoop(force) {
  if (KJB.busy || !S.data) return;
  const on = $('#tab-kjb') && $('#tab-kjb').classList.contains('on'); if (!force && (document.hidden || !on)) return;
  KJB.busy = true;
  try { await kjbLoadIdx(); KJB.lt = 0; renderKjb(); } catch (e) { console.error(e); }
  KJB.busy = false;
}
function initKjb() {
  $('#kjRules').innerHTML = KJB_RULES.map(([t, d], i) => `<div class="kj-rule"><b>${i + 1}. ${esc(t)}</b><p>${esc(d)}</p></div>`).join('');
  ['kjFm', 'kjFs', 'kjFc', 'kjFo'].forEach(id => { const el = $('#' + id); if (el) el.onchange = () => { KJB.n = 40; renderKjb(); }; });
  const q = $('#kjQ'); if (q) q.oninput = () => renderKjb();
  setInterval(() => kjbLoop(false), 60e3);
  const tb = $('button[data-tab="kjb"]'); if (tb) tb.addEventListener('click', () => { if (!KJB.last) $('#kjBody').innerHTML = '<p class="hint">지수와 종목을 비교하는 중이에요…</p>'; setTimeout(() => kjbLoop(true), 30); });
  if ($('#tab-kjb') && $('#tab-kjb').classList.contains('on')) setTimeout(() => kjbLoop(true), 1500);
  if (typeof FM !== 'undefined') {
    FM.kjb_rs20 = { key: 'kjb_rs20', label: '지수 대비 20일 초과수익(김종봉식)', group: '종합', type: 'num', unit: '%p', get: s => { const r = KJB.last && KJB.last.rows.find(x => x.s === s); return r ? Math.round(r.rs20 * 10) / 10 : null; } };
    FM.kjb_capt = { key: 'kjb_capt', label: '대장주 점수(김종봉식)', group: '종합', type: 'num', unit: '점', get: s => { const r = KJB.last && KJB.last.rows.find(x => x.s === s); return r ? r.capt : null; } };
  }
}
(function waitBootKjb() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) setTimeout(initKjb, 600);
  else setTimeout(waitBootKjb, 900);
})();
