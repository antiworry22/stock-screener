/* 공매도 — 보관 칸 live-short 의 shorts.json(거래소 공매도 거래·잔고)을 받아 점수·매수금지·종목 분석에 반영 */
'use strict';

const SHORT = { RAW: 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-short/', d: null, st: null, n: 0 };
const shDay = d => d ? `${d.slice(4, 6)}/${d.slice(6, 8)}` : '';

async function shortLoad() {
  let d = null, st = null;
  try { const r = await fetch(SHORT.RAW + 'shorts.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) {}
  try { const r = await fetch(SHORT.RAW + 'status.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) st = await r.json(); } catch (e) {}
  SHORT.st = st;
  if (!d || !d.s || !S.data) return;
  if (SHORT.d && SHORT.d.meta.time === d.meta.time) return;
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
}

function shortRead(x) {
  const r = [];
  if (x.w != null) r.push({ c: x.w >= 20 ? 'bad' : x.w >= 10 ? 'warn' : '', t: `${shDay(x.td)} 거래 중 공매도 비중 ${fmt(x.w, 1)}% — ${x.w >= 20 ? '아주 많아요. 하락에 거는 거래가 몰렸어요.' : x.w >= 10 ? '많은 편이에요(10% 이상).' : x.w >= 5 ? '보통이에요.' : '적어요.'}${x.w5 != null ? ` (5일 평균 ${fmt(x.w5, 1)}%${x.w > x.w5 * 1.5 && x.w >= 5 ? ' — 평소보다 급증' : ''})` : ''}` });
  if (x.br != null) r.push({ c: x.br >= 5 ? 'bad' : x.br >= 3 ? 'warn' : '', t: `공매도 잔고 비율 ${fmt(x.br, 2)}% (${shDay(x.bd)} 기준) — ${x.br >= 5 ? '아주 높아요. 하락 베팅이 쌓여 있어 반등 땐 되사기(숏커버링)로 급등할 수도, 악재엔 더 밀릴 수도 있어요.' : x.br >= 3 ? '높은 편이에요.' : x.br >= 1 ? '보통이에요.' : '낮아요.'}` });
  if (x.br_chg != null && Math.abs(x.br_chg) >= 0.05) r.push({ c: x.br_chg > 0.3 ? 'bad' : x.br_chg < -0.3 ? 'good' : '', t: x.br_chg > 0 ? `최근 약 1주 동안 잔고 비율이 ${fmt(x.br_chg, 2)}%p 늘었어요 — 하락에 거는 물량이 늘어나는 중.` : `최근 약 1주 동안 잔고 비율이 ${fmt(-x.br_chg, 2)}%p 줄었어요 — 빌려 판 주식을 되사는 중(숏커버링 = 매수 압력).` });
  return r;
}
function shortHtml(s) {
  const x = s._short;
  if (!x) return `<div class="hint">${SHORT.d ? '이 종목은 공매도 자료가 없어요(공매도 대상이 아니거나 거래가 없음).' : SHORT.st ? `공매도 자료 수집 중 문제가 있었어요: ${esc(SHORT.st.msg || '')}` : '공매도 자료를 불러오는 중이에요(평일 저녁 수집).'}</div>`;
  const rows = shortRead(x);
  const bars = (x.w_h || []).map((w, i) => `<span title="${shDay(x.d_h[i])} ${fmt(w, 1)}%"><i style="height:${Math.min(100, (w || 0) * 3)}%"></i><small>${shDay(x.d_h[i]).slice(3)}</small></span>`).join('');
  return `${rows.map(r => `<div class="sh-row ${r.c}">${esc(r.t)}</div>`).join('')}
    ${bars ? `<div class="sh-bars" title="최근 5일 공매도 거래 비중">${bars}</div>` : ''}
    <details class="hint"><summary>공매도가 뭐예요?</summary>주식을 빌려서 먼저 팔고, 나중에 싸게 되사서 갚는 거래예요. 주가가 내려야 이익이라 '하락에 거는 돈'으로 봐요. <b>거래 비중</b>은 그날 거래 중 공매도 비율, <b>잔고 비율</b>은 빌려 판 뒤 아직 갚지 않은 주식이 전체 주식의 몇 %인지예요. 잔고가 줄면 되사는 매수(숏커버링)가 들어오는 중이에요. 자료는 거래소 공개 기준(거래는 당일 저녁, 잔고는 2거래일 뒤)이라 실시간이 아니에요.</details>`;
}
function shortChip() {
  const m = SHORT.d && SHORT.d.meta;
  if (m) return `공매도 <b>${esc(m.time.slice(11))}</b> <small>${SHORT.n}종목 · 거래 ${shDay(m.trade_day)} · 잔고 ${shDay(m.bal_day)}</small>`;
  return `공매도 <b>${SHORT.st ? '수집 오류' : '대기'}</b> <small>${SHORT.st ? esc(SHORT.st.msg || '') : '평일 저녁 수집'}</small>`;
}
function initShort() { shortLoad(); setInterval(shortLoad, 600e3); }
(function waitBootShort() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initShort();
  else setTimeout(waitBootShort, 600);
})();
