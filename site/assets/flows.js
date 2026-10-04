/* 외국인·기관 수급 실시간 반영 — 보관 칸 live-flow 의 flows.json 을 3분마다 확인해
   종목별 외국인·기관 연속 매수일·5일 순매수액·보유율을 바꾸고, 모든 점수·추천·신호를 다시 계산합니다. */
'use strict';

const FLOW = { RAW: 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-flow/', d: null, st: null, n: 0 };

async function flowLoad() {
  let d = null, st = null;
  try { const r = await fetch(FLOW.RAW + 'flows.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) { /* 아직 없음 */ }
  try { const r = await fetch(FLOW.RAW + 'status.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) st = await r.json(); } catch (e) {}
  FLOW.st = st;
  if (!d || !d.s || !S.data) return;
  if (FLOW.d && FLOW.d.meta.time === d.meta.time) return;
  FLOW.d = d;
  let n = 0;
  S.data.stocks.forEach(s => {
    const x = d.s[s.code]; if (!x) return;
    s.foreign_streak = x.fs; s.inst_streak = x.is;
    s.foreign_net5 = x.fn5; s.inst_net5 = x.in5;
    if (x.fh != null) s.foreign_hold = x.fh;
    s._flow = { d: x.d, f1: x.f1, i1: x.i1, ff: x.ff, ii: x.ii, dd: x.dd, time: d.meta.time };
    n++;
  });
  FLOW.n = n;
  if (!n) return;
  if (typeof VOL !== 'undefined') { VOL.all = null; VOL.mkt = null; }   // '진성 상승'처럼 수급을 쓰는 거래대금 신호도 다시 계산
  if (typeof S.data.meta === 'object') S.data.meta.flow_live = d.meta.time;
  if (typeof fuOnUpdate === 'function') { try { fuOnUpdate('flow'); } catch (e) { console.error(e); } }
  else if (typeof liveRefresh === 'function') liveRefresh('flow');
}
function flowChip() {
  const m = FLOW.d && FLOW.d.meta;
  if (m) return `외국인·기관 수급 <b>${esc(m.time.slice(11))}</b> <small>${FLOW.n}종목 · ${esc((m.asof || '').slice(5))}${m.intraday ? ' 장중 잠정' : ''}</small>`;
  const st = FLOW.st;
  return `외국인·기관 수급 <b>${st ? '수집 오류' : '대기'}</b> <small>${st ? esc(st.msg || '') : '장중 4번·마감 후 3번'}</small>`;
}
function initFlow() { flowLoad(); setInterval(flowLoad, 180e3); }
(function waitBootFlow() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initFlow();
  else setTimeout(waitBootFlow, 500);
})();
