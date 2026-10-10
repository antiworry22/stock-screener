/* 공매도 — 보관 칸 live-short 의 shorts.json(거래소 공매도 거래 20일·잔고 20일)을 받아
   ① 종목별 자세한 수치(거래 비중·잔고·추세·공매도 평균 단가·되사기 소요일) ② 지금 가격으로 다시 계산하는 공매도 손익·숏커버 압력
   ③ 점수(−100~+100, 사는 사람 입장)와 해석 문장을 만들고, 종목 분석·「공매도」 탭·점수·매수금지에 반영합니다.
   공개 시각: 공매도 거래 = 당일 장 마감 뒤(오후~저녁), 잔고 = 2거래일 뒤 — 거래소가 장중 실시간으로 공개하지 않아요.
   그래서 「실시간」은 ⑴ 공개되는 즉시 받아오기(5분마다 확인) ⑵ 지금 가격으로 공매도 손익·스퀴즈 압력을 계속 다시 계산하는 방식이에요. */
'use strict';

const SHORT = { RAW: 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-short/', d: null, st: null, n: 0, sel: null, q: new Map(), list: 'squeeze' };
const shDay = d => d ? `${+d.slice(4, 6)}/${+d.slice(6, 8)}` : '';
const shIso = d => d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
const shMean = a => { const b = (a || []).filter(x => x != null && Number.isFinite(x)); return b.length ? b.reduce((p, x) => p + x, 0) / b.length : null; };
const shEok = v => v == null ? '–' : v >= 1e12 ? fmt(v / 1e12, 2) + '조' : v >= 1e8 ? fmt(v / 1e8, v >= 1e10 ? 0 : 1) + '억' : fmt(v / 1e4, 0) + '만';

async function shortLoad() {
  let d = null, st = null;
  try { const r = await fetch(SHORT.RAW + 'shorts.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) {}
  try { const r = await fetch(SHORT.RAW + 'status.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) st = await r.json(); } catch (e) {}
  SHORT.st = st;
  if (!d || !d.s || !S.data) return;
  if (SHORT.d && SHORT.d.meta.time === d.meta.time) return;
  const fresh = !!SHORT.d;
  SHORT.d = d;
  let n = 0;
  S.data.stocks.forEach(s => {
    const x = d.s[s.code]; if (!x) return;
    if (x.br != null) s.short_ratio = x.br;          // 공매도 잔고 비율(상장주식 대비 %)
    if (x.br_chg != null) s.short_chg = x.br_chg;    // 약 1주 동안 잔고 비율 변화(%p)
    if (x.w != null) s.short_w = x.w;                // 그날 거래 중 공매도 비중(%)
    s._short = x; n++;
  });
  SHORT.n = n;
  if (n && typeof liveRefresh === 'function') liveRefresh('short');
  if (fresh && typeof govToastMsg === 'function') govToastMsg(`🩳 공매도 자료 새로 들어옴 — 거래 ${shDay(d.meta.trade_day)} · 잔고 ${shDay(d.meta.bal_day)}`);
  renderShortTab();
}

/* 지금 가격: 공매도 탭·종목 분석에서 받은 실시간 시세 > 장중 15분 시세 > 종가 */
function shPrice(s) {
  const q = SHORT.q.get(s.code);
  if (q && q.price && Date.now() - q.t < 5 * 60e3) return { p: q.price, chg: q.chgPct, live: true, at: q.at };
  if (s._live && s._live.c) return { p: s._live.c, chg: s._live.chg, live: false };
  return { p: s.close, chg: s.chg, live: false };
}
/* 공매도 거래일의 종가(가격 기록 spark 에서 찾음) */
function shCloseAt(s, d) {
  const sp = s.spark; if (!sp || !sp.length) return null;
  const last = (s._vlive && s._vlive.d) || S.data.meta.asof, iso = shIso(d);
  if (iso > last) return null;
  let k = 0;
  if (typeof tmBizBetween === 'function') k = tmBizBetween(iso, last);
  else { const a = new Date(iso + 'T00:00:00Z'), b = new Date(last + 'T00:00:00Z'); for (let x = new Date(a); x < b; x.setUTCDate(x.getUTCDate() + 1)) { const w = x.getUTCDay(); if (w && w < 6 && x > a) k++; } k = Math.max(0, k); }
  const v = sp[sp.length - 1 - k];
  return v != null ? v : null;
}

/* ── 한 종목 분석 ── */
function shAnalyze(s) {
  const x = s && s._short; if (!x) return null;
  const P = shPrice(s), p = P.p;
  const dh = x.d_h || [], sv = x.sv_h || [], wh = x.w_h || [];
  // 공매도 평균 단가(최근 공매도 거래량으로 가중한 그날 종가) — 이 가격보다 지금 가격이 높으면 공매도 쪽이 손해
  let num = 0, den = 0;
  dh.forEach((d, i) => { const c = shCloseAt(s, d); if (c && sv[i]) { num += c * sv[i]; den += sv[i]; } });
  const avgPx = den ? num / den : null, pl = avgPx && p ? (p / avgPx - 1) * 100 : null;
  // 되사기 소요일(Days to cover) = 잔고 수량 ÷ 하루 평균 거래량(20일)
  const vols = (s.spark_vol || []).slice(-21, -1), av = shMean(vols);
  const dtc = x.bq && av ? x.bq / av : null;
  const w20 = x.w20 != null ? x.w20 : shMean(wh), wz = x.w != null && w20 ? x.w / w20 : null;
  const sv20 = shMean(sv), svz = x.sv != null && sv20 ? x.sv / sv20 : null;
  const tdClose = shCloseAt(s, x.td), sAmt = x.sa || (x.sv && tdClose ? x.sv * tdClose : null);
  const tdChg = (() => { const i = dh.length - 1; if (i < 1) return null; const a = shCloseAt(s, dh[i]), b = shCloseAt(s, dh[i - 1]); return a && b ? (a / b - 1) * 100 : null; })();
  const br = x.br, brc = x.br_chg, brc20 = x.br_chg20, bqc = x.bq_chg, bqc20 = x.bq_chg20;
  const ret5 = s.ret5 || 0, ret20 = s.ret20 || 0;
  // 과열종목 지정 수준(추정): 공매도 비중이 높고 + 그날 주가 급락 + 공매도 거래 급증
  const hot = x.w != null && x.w >= (s.market === 'KOSDAQ' ? 15 : 20) && tdChg != null && tdChg <= -5 && svz != null && svz >= 3;
  // 점수(사는 사람 입장, −100~+100)
  let sc = 0; const parts = [];
  const add = (v, t) => { if (v) { sc += v; parts.push([v, t]); } };
  if (br != null) add(br >= 5 ? -20 : br >= 3 ? -12 : br >= 1 ? -4 : 0, `잔고 비율 ${fmt(br, 2)}%`);
  if (brc != null) add(brc >= 0.3 ? -25 : brc >= 0.1 ? -10 : brc <= -0.3 ? 20 : brc <= -0.1 ? 10 : 0, `1주 잔고 비율 ${brc > 0 ? '+' : ''}${fmt(brc, 2)}%p`);
  if (bqc20 != null) add(bqc20 >= 50 ? -15 : bqc20 >= 20 ? -8 : bqc20 <= -30 ? 12 : bqc20 <= -15 ? 6 : 0, `20일 잔고 수량 ${bqc20 > 0 ? '+' : ''}${fmt(bqc20, 0)}%`);
  if (wz != null && x.w != null) add(wz >= 2 && x.w >= 8 ? -20 : wz >= 1.5 && x.w >= 5 ? -8 : wz <= 0.5 ? 5 : 0, `오늘 비중 ${fmt(x.w, 1)}%(평소의 ${fmt(wz, 1)}배)`);
  if (pl != null && (br || 0) >= 0.5) add(pl >= 8 ? 15 : pl >= 3 ? 8 : pl <= -10 ? -10 : pl <= -4 ? -5 : 0, `공매도 평균 단가 대비 ${pl > 0 ? '+' : ''}${fmt(pl, 1)}%`);
  if (dtc != null && dtc >= 5 && (P.chg || 0) > 2) add(10, `되사기 ${fmt(dtc, 1)}일치 + 오늘 상승`);
  if (hot) add(-20, '과열 지정 수준(추정)');
  sc = Math.max(-100, Math.min(100, Math.round(sc * 1.4)));
  // 국면
  const up = brc != null ? brc >= 0.05 || (bqc || 0) >= 10 : (bqc || 0) >= 10, dn = brc != null ? brc <= -0.05 || (bqc || 0) <= -10 : (bqc || 0) <= -10;
  let regime;
  if ((br || 0) < 0.3 && !(x.w >= 10)) regime = ['low', '공매도 영향 작음', `잔고가 상장주식의 ${fmt(br || 0, 2)}%뿐이라 공매도가 주가를 크게 흔들 수준이 아니에요. 이 종목은 공매도보다 실적·수급·차트를 보세요.`];
  else if (up && ret5 < 0) regime = ['bear', '하락 베팅 강화', `주가가 1주 ${pct(ret5, 1)} 빠지는 동안 공매도 잔고는 늘었어요. 빌려 판 쪽이 하락을 확신하고 더 쌓는 중이라, 반등이 나와도 위에서 다시 공매도가 나오기 쉬워요.`];
  else if (up && ret5 >= 0) regime = ['fuel', '오르는 주가에 맞서는 공매도(연료 축적)', `주가는 1주 ${pct(ret5, 1)} 올랐는데 잔고는 오히려 늘었어요. 공매도 쪽이 「곧 꺾인다」에 걸고 있다는 뜻이에요. 주가가 더 오르면 손실을 막으려는 되사기(숏커버)가 한꺼번에 나와 급등(숏 스퀴즈)의 연료가 될 수 있어요.`];
  else if (dn && ret5 >= 0) regime = ['cover', '숏커버 랠리', `잔고가 줄면서 주가가 1주 ${pct(ret5, 1)} 올랐어요. 빌려 판 주식을 되사는 매수가 상승을 밀어주는 중이에요. 다만 되사기가 끝나면 이 매수도 끝나니, 잔고 감소가 멈추는 시점을 확인하세요.`];
  else if (dn && ret5 < 0) regime = ['exit', '공매도도 빠지는 하락', `잔고는 줄고 있는데 주가는 1주 ${pct(ret5, 1)} 빠졌어요. 하락 원인이 공매도가 아니라 일반 매도라는 뜻이에요. 공매도 탓으로 돌리지 말고 실적·수급을 확인하세요.`];
  else regime = ['flat', '공매도 변화 작음', '최근 1주 잔고 변화가 크지 않아요. 공매도는 지금 주가 방향을 바꾸는 요인이 아니에요.'];
  const label = sc >= 25 ? ['good', '숏커버 우호'] : sc >= 8 ? ['good', '약한 우호'] : sc <= -40 ? ['bad', '강한 매도 압력'] : sc <= -15 ? ['bad', '매도 압력'] : ['', '중립'];
  const squeeze = (br || 0) >= 2 && pl != null && pl >= 5 && (dtc || 0) >= 3;
  return { x, P, p, avgPx, pl, dtc, av, w20, wz, sv20, svz, sAmt, tdChg, hot, sc, parts, regime, label, squeeze, br, brc, brc20, bqc, bqc20 };
}

/* 해석 문장 */
function shExplain(a, s) {
  const x = a.x, L = [];
  const push = (c, h, b) => L.push({ c, h, b });
  if (x.w != null) push(x.w >= 20 ? 'bad' : x.w >= 10 ? 'warn' : '', `거래 중 공매도 비중 ${fmt(x.w, 1)}% (${shDay(x.td)})`,
    `그날 거래된 주식 ${x.w >= 10 ? '10주 중 ' + fmt(x.w / 10, 1) + '주' : '100주 중 ' + fmt(x.w, 1) + '주'}가 빌려서 판 물량이에요. ${a.w20 != null ? `최근 20일 평균은 ${fmt(a.w20, 1)}%라 ${a.wz >= 1.5 ? `평소의 ${fmt(a.wz, 1)}배 — 하락 쪽에 거는 거래가 갑자기 몰렸어요` : a.wz <= 0.6 ? '평소보다 훨씬 적어요 — 공매도 공세가 쉬는 중' : '평소 수준이에요'}. ` : ''}${x.w >= 20 ? '20%가 넘으면 단기 주가를 직접 누를 수 있는 수준이에요.' : ''}`);
  if (a.sAmt) push('', `공매도 거래 금액 약 ${shEok(a.sAmt)}원`, `${a.svz != null ? `20일 평균 공매도 거래량의 ${fmt(a.svz, 1)}배예요. ` : ''}${a.svz >= 3 ? '하루에 평소 세 배 넘게 빌려 판 날은 다음 날 시초가 약세가 자주 나와요.' : ''}`);
  if (a.br != null) push(a.br >= 5 ? 'bad' : a.br >= 3 ? 'warn' : '', `공매도 잔고 비율 ${fmt(a.br, 2)}% · ${fmt(x.bq)}주(${shEok(x.ba)}원) (${shDay(x.bd)} 기준)`,
    `빌려 판 뒤 아직 갚지 않은 주식이 상장주식의 ${fmt(a.br, 2)}%예요. ${a.br >= 5 ? '아주 높아요 — 악재엔 더 밀리고, 호재엔 되사기로 급등하는 「양날의 칼」 상태예요.' : a.br >= 3 ? '높은 편이라 공매도가 주가에 영향을 주는 종목이에요.' : a.br >= 1 ? '보통 수준이에요.' : '낮아요 — 공매도 영향은 작아요.'}`);
  if (a.brc != null || a.bqc != null) push(a.brc > 0.1 || a.bqc > 15 ? 'bad' : a.brc < -0.1 || a.bqc < -15 ? 'good' : '', `잔고 추세 — 1주 ${a.bqc != null ? (a.bqc > 0 ? '+' : '') + fmt(a.bqc, 1) + '%' : '–'}${a.bqc20 != null ? ` · 20일 ${a.bqc20 > 0 ? '+' : ''}${fmt(a.bqc20, 1)}%` : ''}`,
    a.bqc > 0 ? `빌려 판 물량이 늘고 있어요. ${a.bqc20 > 30 ? '한 달 새 크게 쌓였어요 — 큰손이 하락에 베팅을 키우는 중.' : '하락 쪽 베팅이 조금씩 늘어나는 중이에요.'}` : a.bqc < 0 ? `빌려 판 주식을 되사서 갚는 중이에요(숏커버링). 되사는 것도 「매수」라 주가를 받쳐줘요.${a.bqc20 < -30 ? ' 한 달 새 크게 줄었어요 — 공매도 쪽이 물러나는 중.' : ''}` : '잔고가 거의 그대로예요.');
  if (a.avgPx) push(a.pl >= 3 ? 'good' : a.pl <= -4 ? 'bad' : '', `공매도 평균 단가 약 ${fmt(Math.round(a.avgPx))}원 → 지금 ${fmt(a.p)}원 (${a.pl > 0 ? '+' : ''}${fmt(a.pl, 1)}%)`,
    a.pl >= 3 ? `최근 20일 공매도 물량은 평균적으로 손해를 보고 있어요. 주가가 더 오르면 손실을 막으려는 되사기가 나오기 쉬워요${a.pl >= 8 ? ' — 이미 손실이 커서 압박이 강해요' : ''}.${(a.br || 0) < 0.5 ? ' 다만 잔고 자체가 적어서 되사기 매수의 크기는 작아요.' : ''}` : a.pl <= -4 ? `공매도 쪽이 이익을 보고 있어요(주가가 그들이 판 값보다 낮음). 서두를 이유가 없어서 되사기 매수는 당분간 기대하기 어려워요.` : '공매도 쪽 손익이 본전 근처라, 다음 방향에 따라 되사기·추가 공매도가 갈려요.');
  if (a.dtc != null) push(a.dtc >= 5 ? 'warn' : '', `되사기에 걸리는 날 ${fmt(a.dtc, 1)}일`, `잔고 전부를 되사려면 하루 평균 거래량(${fmt(Math.round(a.av))}주)으로 ${fmt(a.dtc, 1)}일이 걸려요. ${a.dtc >= 5 ? '5일이 넘으면 되사기가 몰릴 때 물량을 구하기 어려워 급등(스퀴즈)이 커질 수 있어요.' : '짧은 편이라 되사기가 나와도 금방 소화돼요.'}`);
  if (a.hot) push('bad', '공매도 과열 지정 수준(추정)', `공매도 비중이 높고 그날 주가가 ${fmt(a.tdChg, 1)}% 급락했으며 공매도가 평소의 ${fmt(a.svz, 1)}배였어요. 거래소가 과열종목으로 지정하면 다음 날 하루 공매도가 금지돼요(지정 여부는 거래소 공시로 확인).`);
  return L;
}
function shTodo(a) {
  const T = [];
  if (a.regime[0] === 'bear') T.push('신규 매수는 잔고 증가가 멈출 때까지 미루기 — 반등마다 공매도가 다시 나와요');
  if (a.regime[0] === 'fuel') T.push(`보유 중이면 들고 가되 손절선 유지 · 신규라면 직전 고점 돌파(거래량 동반) 때 따라붙기 — 스퀴즈는 돌파에서 시작돼요`);
  if (a.regime[0] === 'cover') T.push('숏커버 랠리는 잔고가 바닥나면 끝나요 — 이익 중이면 목표가에서 일부 정리, 신규 추격은 신중히');
  if (a.regime[0] === 'exit') T.push('공매도 탓이 아닌 하락 — 실적·외국인·기관 매도 이유를 먼저 확인');
  if (a.squeeze) T.push('숏 스퀴즈 후보: 잔고 많음 + 공매도 손실 + 되사기 오래 걸림 — 거래량 터지며 고점 돌파하면 급등 가능, 실패하면 공매도 재개로 빠르게 되밀림');
  if (a.hot) T.push('과열 지정되면 다음 날 공매도가 막혀 단기 반등이 자주 나와요 — 지정 공시 확인');
  if (a.x.w >= 20) T.push('공매도 비중 20% 넘는 날 다음 날 시초가 추격 매수는 피하기');
  if (!T.length) T.push('공매도는 지금 큰 변수가 아니에요 — 다른 신호(차트·수급·거래대금) 위주로 판단');
  return T;
}

/* 작은 막대 그래프(SVG): 비중·잔고 20일 */
function shSpark(vals, dates, color, unit, d0) {
  const v = (vals || []).map(x => x == null ? null : +x); if (!v.filter(x => x != null).length) return '';
  const W = 300, H = 70, n = v.length, mx = Math.max(...v.filter(x => x != null), 0.0001), bw = W / n;
  const bars = v.map((x, i) => x == null ? '' : `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - x / mx * (H - 4)).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(x / mx * (H - 4)).toFixed(1)}" fill="${color}" opacity="${i === n - 1 ? 1 : 0.55}"><title>${shDay(dates[i])} ${fmt(x, unit === '%' ? 2 : 0)}${unit}</title></rect>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="sh-svg" role="img" aria-label="최근 ${n}일 추이" preserveAspectRatio="none">${bars}</svg><div class="sh-ax"><span>${shDay(dates[0])}</span><span>${shDay(dates[n - 1])}</span></div>`;
}

/* 종목 분석 카드 · 공매도 탭 상세 */
function shortHtml(s) {
  const x = s._short;
  if (!x) return `<div class="hint">${SHORT.d ? '이 종목은 공매도 자료가 없어요(공매도 대상이 아니거나 거래가 없음).' : SHORT.st ? `공매도 자료 수집 중 문제가 있었어요: ${esc(SHORT.st.msg || '')}` : '공매도 자료를 불러오는 중이에요.'}</div>`;
  const a = shAnalyze(s), E = shExplain(a, s), T = shTodo(a);
  const has20 = (x.w_h || []).length > 5;
  return `<div class="sh-wrap" data-shcode="${esc(s.code)}">
    <div class="sh-top">
      <div class="sh-score ${a.label[0]}"><small>공매도 점수</small><b>${a.sc > 0 ? '+' : ''}${a.sc}</b><span>${a.label[1]}</span></div>
      <div class="sh-reg r-${a.regime[0]}"><small>지금 국면</small><b>${esc(a.regime[1])}</b><p>${esc(a.regime[2])}</p></div>
    </div>
    <dl class="sh-kpi">
      <div><dt>오늘 공매도 비중</dt><dd>${x.w != null ? fmt(x.w, 1) + '%' : '–'}</dd><em>20일 평균 ${a.w20 != null ? fmt(a.w20, 1) + '%' : '–'}</em></div>
      <div><dt>잔고 비율</dt><dd>${a.br != null ? fmt(a.br, 2) + '%' : '–'}</dd><em>1주 ${a.brc != null ? (a.brc > 0 ? '+' : '') + fmt(a.brc, 2) + '%p' : '–'}</em></div>
      <div><dt>잔고 수량</dt><dd>${x.bq != null ? fmt(x.bq) + '주' : '–'}</dd><em>1주 ${a.bqc != null ? (a.bqc > 0 ? '+' : '') + fmt(a.bqc, 1) + '%' : '–'}${a.bqc20 != null ? ` · 20일 ${a.bqc20 > 0 ? '+' : ''}${fmt(a.bqc20, 0)}%` : ''}</em></div>
      <div><dt>공매도 평균 단가</dt><dd>${a.avgPx ? fmt(Math.round(a.avgPx)) + '원' : '–'}</dd><em class="${a.pl > 0 ? 'up' : a.pl < 0 ? 'down' : ''}">${a.pl != null ? `지금가 대비 ${a.pl > 0 ? '+' : ''}${fmt(a.pl, 1)}%` : ''}</em></div>
      <div><dt>되사기 소요</dt><dd>${a.dtc != null ? fmt(a.dtc, 1) + '일' : '–'}</dd><em>잔고 ÷ 하루 평균 거래량</em></div>
    </dl>
    <p class="sh-live">${a.P.live ? `<span class="gov-live"></span> ${esc(String(a.P.at || '').slice(11, 19))} 실시간 가격 ${fmt(a.p)}원으로 공매도 손익을 다시 계산했어요` : `가격 ${fmt(a.p)}원 기준`} · 공매도 거래 ${shDay(x.td)} · 잔고 ${shDay(x.bd)} 공개분</p>
    ${has20 ? `<div class="sh-charts"><div><h5>공매도 거래 비중(%) · 최근 ${(x.w_h || []).length}일</h5>${shSpark(x.w_h, x.d_h, 'var(--down)', '%')}</div>${(x.br_h || []).length > 2 ? `<div><h5>공매도 잔고 비율(%) · 최근 ${x.br_h.length}일</h5>${shSpark(x.br_h, x.bd_h, 'var(--warn)', '%')}</div>` : ''}</div>`
      : `<div class="sh-bars" title="최근 5일 공매도 거래 비중">${(x.w_h || []).map((w, i) => `<span title="${shDay(x.d_h[i])} ${fmt(w, 1)}%"><i style="height:${Math.min(100, (w || 0) * 3)}%"></i><small>${shDay(x.d_h[i])}</small></span>`).join('')}</div>`}
    <h5 class="sh-h">숫자 풀이</h5>
    <ul class="sh-ex">${E.map(e => `<li class="${e.c}"><b>${esc(e.h)}</b><p>${esc(e.b)}</p></li>`).join('')}</ul>
    <h5 class="sh-h">실전에서는</h5>
    <ul class="sh-todo">${T.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    ${a.parts.length ? `<details class="sh-det"><summary>점수 근거</summary><ul>${a.parts.map(([v, t]) => `<li><span>${esc(t)}</span><b class="${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : ''}${v}</b></li>`).join('')}</ul><p class="hint">합계 × 1.4, −100~+100. +는 사는 사람에게 유리(되사기 매수 기대), −는 불리(하락 베팅 강화).</p></details>` : ''}
    <details class="hint"><summary>공매도가 뭐예요?</summary>주식을 빌려서 먼저 팔고, 나중에 싸게 되사서 갚는 거래예요. 주가가 내려야 이익이라 '하락에 거는 돈'이에요. <b>거래 비중</b>은 그날 거래 중 공매도 비율, <b>잔고</b>는 빌려 판 뒤 아직 갚지 않은 주식이에요. 잔고가 줄면 되사는 매수(숏커버링)가 들어오는 중이에요. 거래소는 공매도 거래를 당일 장 마감 뒤에, 잔고를 2거래일 뒤에 공개해요(장중 실시간 공개는 없어요). 이 화면은 공개되는 즉시 받아오고, 공매도 손익은 지금 가격으로 계속 다시 계산해요.</details>
  </div>`;
}

/* 실시간 가격으로 손익 다시 계산 (종목 분석·공매도 탭에 보이는 종목만, 장중 20초마다) */
async function shLiveTick() {
  const wraps = $$('.sh-wrap[data-shcode]').filter(el => el.offsetParent);
  if (!wraps.length || document.hidden) return;
  const k = new Date(Date.now() + 9 * 3600e3), m = k.getUTCHours() * 60 + k.getUTCMinutes(), wd = k.getUTCDay();
  const open = wd >= 1 && wd <= 5 && m >= 540 && m <= 935;
  for (const el of wraps) {
    const code = el.dataset.shcode, q0 = SHORT.q.get(code);
    if (q0 && Date.now() - q0.t < (open ? 18e3 : 600e3)) continue;
    try { const r = await fetch('/api/hoga?code=' + code, { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j.quote && j.quote.price) SHORT.q.set(code, { price: j.quote.price, chgPct: j.quote.chgPct, at: j.at, t: Date.now() }); } } catch (e) {}
    const s = S.data.stocks.find(x => x.code === code); if (s && el.isConnected) el.outerHTML = shortHtml(s);
  }
}

/* ── 공매도 탭: 목록 ── */
const SH_LISTS = [
  ['squeeze', '숏 스퀴즈 후보', '잔고 2%↑ + 공매도 손실(지금가 > 평균 단가 +5%) + 되사기 3일↑', a => a.squeeze, (a, b) => b.pl - a.pl],
  ['cover', '숏커버 진행', '잔고가 줄면서 주가가 오르는 중', a => a.regime[0] === 'cover', (a, b) => (a.bqc || 0) - (b.bqc || 0)],
  ['bear', '하락 베팅 강화', '잔고가 늘면서 주가가 빠지는 중', a => a.regime[0] === 'bear', (a, b) => (b.bqc || 0) - (a.bqc || 0)],
  ['fuel', '오르는데 공매도 증가', '주가 상승에 맞서 잔고 증가 — 스퀴즈 연료', a => a.regime[0] === 'fuel', (a, b) => (b.bqc || 0) - (a.bqc || 0)],
  ['spike', '오늘 공매도 급증', '오늘 공매도 비중이 평소의 2배↑ (8%↑)', a => a.wz >= 2 && a.x.w >= 8, (a, b) => b.wz - a.wz],
  ['hot', '과열 지정 수준(추정)', '비중 높음 + 급락 + 공매도 3배↑', a => a.hot, (a, b) => b.x.w - a.x.w],
  ['top', '잔고 비율 상위', '상장주식 대비 잔고가 많은 순', a => (a.br || 0) >= 1, (a, b) => b.br - a.br],
];
function shAll() {
  if (SHORT.allT === SHORT.d && SHORT.all) return SHORT.all;
  SHORT.all = S.data.stocks.filter(s => s._short).map(s => { try { return { s, a: shAnalyze(s) }; } catch (e) { return null; } }).filter(Boolean);
  SHORT.allT = SHORT.d;
  return SHORT.all;
}
function renderShortTab() {
  const box = $('#shList'); if (!box || !S.data) return;
  const m = SHORT.d && SHORT.d.meta;
  $('#shMeta').innerHTML = m ? `<span class="gov-live"></span> ${esc(m.time.slice(5))} 받음 · 공매도 거래 <b>${shDay(m.trade_day)}</b> · 잔고 <b>${shDay(m.bal_day)}</b> 공개분 · ${SHORT.n}종목 · 평일 16:35·17:30·18:45·20:10·07:30에 새로 받아요(5분마다 확인)`
    : SHORT.st ? `공매도 자료 문제: ${esc(SHORT.st.msg || '')}` : '공매도 자료를 불러오는 중이에요…';
  if (!SHORT.d) { box.innerHTML = ''; return; }
  SHORT.all = null;
  const all = shAll();
  const L = SH_LISTS.find(x => x[0] === SHORT.list) || SH_LISTS[0];
  $('#shChips').innerHTML = SH_LISTS.map(([k, n, d, f]) => `<button class="chip ${k === L[0] ? 'on' : ''}" data-shl="${k}" title="${esc(d)}">${n} <b>${all.filter(r => { try { return f(r.a); } catch (e) { return false; } }).length}</b></button>`).join('');
  $$('#shChips [data-shl]').forEach(b => b.onclick = () => { SHORT.list = b.dataset.shl; renderShortTab(); });
  const rows = all.filter(r => { try { return L[3](r.a); } catch (e) { return false; } }).sort((p, q) => { try { return L[4](p.a, q.a); } catch (e) { return 0; } }).slice(0, 60);
  box.innerHTML = `<p class="hint">${esc(L[2])} · ${rows.length}종목</p>` + (rows.length ? `<div class="table-wrap"><table class="tbl sh-tb"><thead><tr><th class="l">종목</th><th>현재가</th><th>공매도 점수</th><th class="l">국면</th><th>오늘 비중</th><th>잔고 비율</th><th>잔고 1주</th><th>잔고 20일</th><th>평균 단가 대비</th><th>되사기</th></tr></thead><tbody>${rows.map(({ s, a }) => `<tr data-shs="${esc(s.code)}">
    <td class="l"><b>${esc(s.name)}</b> <small class="muted">${s.market === 'KOSPI' ? '코스피' : '코스닥'}</small></td>
    <td class="mono">${fmt(a.p)} <small class="${cls(a.P.chg)}">${pct(a.P.chg, 1)}</small></td>
    <td class="mono"><b class="${a.sc > 0 ? 'up' : a.sc < 0 ? 'down' : ''}">${a.sc > 0 ? '+' : ''}${a.sc}</b></td>
    <td class="l"><span class="sh-rg r-${a.regime[0]}">${esc(a.regime[1])}</span></td>
    <td class="mono">${a.x.w != null ? fmt(a.x.w, 1) + '%' : '–'}${a.wz >= 1.5 ? ` <small class="down">×${fmt(a.wz, 1)}</small>` : ''}</td>
    <td class="mono">${a.br != null ? fmt(a.br, 2) + '%' : '–'}</td>
    <td class="mono ${a.bqc > 0 ? 'down' : a.bqc < 0 ? 'up' : ''}">${a.bqc != null ? (a.bqc > 0 ? '+' : '') + fmt(a.bqc, 0) + '%' : '–'}</td>
    <td class="mono ${a.bqc20 > 0 ? 'down' : a.bqc20 < 0 ? 'up' : ''}">${a.bqc20 != null ? (a.bqc20 > 0 ? '+' : '') + fmt(a.bqc20, 0) + '%' : '–'}</td>
    <td class="mono ${a.pl > 0 ? 'up' : a.pl < 0 ? 'down' : ''}">${a.pl != null ? (a.pl > 0 ? '+' : '') + fmt(a.pl, 1) + '%' : '–'}</td>
    <td class="mono">${a.dtc != null ? fmt(a.dtc, 1) + '일' : '–'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">지금 이 조건에 맞는 종목이 없어요.</div>');
  $$('#shList [data-shs]').forEach(tr => tr.onclick = () => shSelect(tr.dataset.shs));
  if (SHORT.sel) shSelect(SHORT.sel, true);
}
function shSelect(code, quiet) {
  const s = S.data.stocks.find(x => x.code === code); const box = $('#shOne'); if (!s || !box) return;
  SHORT.sel = code;
  box.innerHTML = `<div class="an-card an-wide"><h4>${esc(s.name)} <span class="muted mono">${esc(s.code)}</span> 공매도 자세히 <button class="btn ghost small" id="shAn">종목 분석</button> <button class="btn ghost small" id="shX">닫기</button></h4>${shortHtml(s)}</div>`;
  $('#shAn').onclick = () => showAnalysis(code);
  $('#shX').onclick = () => { SHORT.sel = null; box.innerHTML = ''; };
  if (!quiet) { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); shLiveTick(); }
}
function shortChip() {
  const m = SHORT.d && SHORT.d.meta;
  if (m) return `공매도 <b>${esc(m.time.slice(11))}</b> <small>${SHORT.n}종목 · 거래 ${shDay(m.trade_day)} · 잔고 ${shDay(m.bal_day)}</small>`;
  return `공매도 <b>${SHORT.st ? '수집 오류' : '대기'}</b> <small>${SHORT.st ? esc(SHORT.st.msg || '') : '평일 저녁 수집'}</small>`;
}
function initShort() {
  shortLoad(); setInterval(shortLoad, 300e3);
  setInterval(() => { if (document.hidden) return; window.SH_TK = (window.SH_TK || 0) + 1; if (!(typeof svOn === 'function' && svOn()) || window.SH_TK % 3 === 0) shLiveTick(); }, 20e3);   // 절약 모드: 1분마다
  const go = () => { const q = ($('#shQ').value || '').trim(); if (!q) return; const h = findStocks(q); if (!h.length) { alert(`"${q}"과(와) 맞는 종목이 없어요`); return; } shSelect(h[0].code); };
  if ($('#shQ')) { $('#shGo').onclick = go; $('#shQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }; }
  const tb = $('button[data-tab="short"]'); if (tb) tb.addEventListener('click', () => { renderShortTab(); setTimeout(shLiveTick, 300); });
  const g = '공매도';
  if (typeof FM !== 'undefined') {
    FM.sh_score = { key: 'sh_score', label: '공매도 점수(−100~+100, +는 숏커버 우호)', group: g, type: 'num', unit: '점', get: s => { const a = s._short ? shAnalyze(s) : null; return a ? a.sc : null; } };
    FM.sh_dtc = { key: 'sh_dtc', label: '공매도 되사기 소요일', group: g, type: 'num', unit: '일', get: s => { const a = s._short ? shAnalyze(s) : null; return a ? a.dtc : null; } };
    FM.sh_pl = { key: 'sh_pl', label: '공매도 평균 단가 대비 지금가(%)', group: g, type: 'num', unit: '%', get: s => { const a = s._short ? shAnalyze(s) : null; return a ? a.pl : null; } };
    FM.sh_reg = { key: 'sh_reg', label: '공매도 국면', group: g, type: 'enum', unit: '', opts: ['공매도 영향 작음', '하락 베팅 강화', '오르는 주가에 맞서는 공매도(연료 축적)', '숏커버 랠리', '공매도도 빠지는 하락', '공매도 변화 작음'], get: s => { const a = s._short ? shAnalyze(s) : null; return a ? a.regime[1] : null; } };
  }
}
(function waitBootShort() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initShort();
  else setTimeout(waitBootShort, 600);
})();
