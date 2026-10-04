/* 거래대금 순위 — 오늘(장중엔 지금까지) 거래대금이 많은 순서로 종목을 세움. 실시간 갱신마다 순위 변화(▲▼) 표시 */
'use strict';

const TVR = { prev: null, prevKey: null, cur: null, curKey: null, mkt: 'all', dir: 'all', n: 30 };

function tvrRows() {
  const all = typeof volAll === 'function' ? volAll() : new Map();
  const rows = S.data.stocks.filter(s => s.tvalue > 0).map(s => {
    const L = s._vlive, a = all.get(s.code);
    return { s, tv: s.tvalue, chg: L && L.chg != null ? L.chg : s.chg, px: L ? L.c : s.close, a, rv: a ? a.rv : s.tv_ratio, turn: s.mcap ? s.tvalue / s.mcap * 100 : null };
  }).sort((x, y) => y.tv - x.tv);
  const sum = rows.reduce((p, r) => p + r.tv, 0);
  rows.forEach((r, i) => { r.rank = i + 1; r.share = sum ? r.tv / sum * 100 : null; });
  // 직전 갱신 대비 순위 변화
  const key = (typeof VOL !== 'undefined' && VOL.liveTime) || S.data.meta.asof;
  if (TVR.curKey !== key) { TVR.prev = TVR.cur; TVR.prevKey = TVR.curKey; TVR.cur = Object.fromEntries(rows.map(r => [r.s.code, r.rank])); TVR.curKey = key; }
  rows.forEach(r => { const p = TVR.prev && TVR.prev[r.s.code]; r.mv = !TVR.prev ? null : p ? p - r.rank : 'new'; });
  return { rows, sum };
}
function tvrRead(r) {
  const up = (r.chg || 0) > 0.5, dn = (r.chg || 0) < -0.5, f = r.a ? r.a.flags : {};
  if (r.turn != null && r.turn >= 100) return ['bad', '거래대금 ≥ 시가총액 — 극단 과열(매수 금지)'];
  if (f.whale) return ['bad', '장대음봉 + 대량 거래 — 큰손 이탈 경보'];
  if (f.flat) return ['bad', '주가 제자리 + 거래 폭증 — 물량 넘기기 의심'];
  if (f.brk) return ['good', '대량 거래로 3개월 고점 돌파'];
  if (f.trueUp) return ['good', '거래 급증 + 외국인·기관 매수'];
  if (up && (r.rv || 0) >= 2) return ['good', '상승 + 거래 급증(매수세 유입)'];
  if (dn && (r.rv || 0) >= 2) return ['bad', '하락 + 거래 급증(매도세)'];
  if ((r.rv || 0) < 0.7) return ['', '평소보다 거래 적음 — 관심 식는 중'];
  return [up ? 'good' : dn ? 'bad' : '', up ? '상승 중 · 평소 수준 거래' : dn ? '하락 중 · 평소 수준 거래' : '보합 · 평소 수준 거래'];
}
function tvrTable(rows, compact) {
  const mv = r => r.mv == null ? '' : r.mv === 'new' ? '<span class="rec-mv up">NEW</span>' : r.mv > 0 ? `<span class="rec-mv up">▲${r.mv}</span>` : r.mv < 0 ? `<span class="rec-mv down">▼${-r.mv}</span>` : '';
  const live = typeof VOL !== 'undefined' && VOL.liveTime;
  return `<table class="clx-tb tvr-tb"><thead><tr><th>순위</th><th>종목</th><th>현재가</th><th>${live ? '지금까지 거래대금' : '거래대금'}</th>${compact ? '' : '<th>평소 대비</th><th>시장 비중</th><th>회전율</th>'}<th>해석</th></tr></thead><tbody>
    ${rows.map(r => { const [c, t] = tvrRead(r); return `<tr data-an="${esc(r.s.code)}"><td class="mono"><b>${r.rank}</b>${mv(r)}</td>
      <td><b>${esc(r.s.name)}</b> <small class="muted">${r.s.market === 'KOSPI' ? '코스피' : '코스닥'}${compact || !r.s.sector || r.s.sector === '기타' ? '' : ' · ' + esc(r.s.sector)}</small></td>
      <td class="mono">${fmt(r.px)} <small class="${cls(r.chg)}">${pct(r.chg, 1)}</small></td>
      <td class="mono"><b>${typeof vEok === 'function' ? vEok(r.tv) : fmt(r.tv, 0) + '억'}</b></td>
      ${compact ? '' : `<td class="mono ${(r.rv || 0) >= 2 ? 'up' : ''}">${r.rv != null ? fmt(r.rv, 1) + '배' : '–'}</td><td class="mono">${r.share != null ? fmt(r.share, 1) + '%' : '–'}</td><td class="mono">${r.turn != null ? fmt(r.turn, 2) + '%' : '–'}</td>`}
      <td><span class="tvr-t ${c}">${esc(t)}</span></td></tr>`; }).join('')}</tbody></table>`;
}
function renderTvRank() {
  const box = $('#vsRank');
  if (box && S.data) {
    const { rows, sum } = tvrRows();
    const f = rows.filter(r => (TVR.mkt === 'all' || r.s.market === TVR.mkt) && (TVR.dir === 'all' || (TVR.dir === 'up' ? (r.chg || 0) > 0 : (r.chg || 0) < 0)));
    const top10 = rows.slice(0, 10).reduce((p, r) => p + r.tv, 0);
    const live = typeof VOL !== 'undefined' && VOL.liveTime;
    box.innerHTML = `<div class="ph"><h4>거래대금 순위 <small class="muted">${live ? `실시간 ${esc(VOL.liveTime.slice(11))} 기준 · 장중엔 지금까지 쌓인 금액` : `${esc(S.data.meta.asof)} 종가 기준`}</small></h4>
      <div class="row gap wrap">
        <select class="inp small" id="tvrM"><option value="all">코스피+코스닥</option><option value="KOSPI">코스피</option><option value="KOSDAQ">코스닥</option></select>
        <select class="inp small" id="tvrD"><option value="all">상승·하락 모두</option><option value="up">오른 종목만</option><option value="down">내린 종목만</option></select>
        <select class="inp small" id="tvrN"><option>20</option><option selected>30</option><option>50</option><option>100</option></select></div></div>
      <div class="hint">분석 대상 ${rows.length}종목 거래대금 합계 ${typeof vEok === 'function' ? vEok(sum) : fmt(sum, 0) + '억'} · 상위 10종목이 ${sum ? fmt(top10 / sum * 100, 0) : '-'}% 차지${TVR.prevKey ? ` · ▲▼ = ${esc(String(TVR.prevKey).slice(11) || TVR.prevKey)} 대비 순위 변화` : ''}. 거래대금이 많다는 건 '지금 시장의 돈이 몰리는 곳'이라는 뜻이고, 오르면서 몰리면 매수세, 내리면서 몰리면 매도세예요.</div>
      ${tvrTable(f.slice(0, TVR.n), false)}`;
    $('#tvrM').value = TVR.mkt; $('#tvrD').value = TVR.dir; $('#tvrN').value = String(TVR.n);
    $('#tvrM').onchange = e => { TVR.mkt = e.target.value; renderTvRank(); };
    $('#tvrD').onchange = e => { TVR.dir = e.target.value; renderTvRank(); };
    $('#tvrN').onchange = e => { TVR.n = +e.target.value; renderTvRank(); };
    $$('#vsRank [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
  }
  const dash = $('#tvDash');
  if (dash && S.data) {
    const { rows } = tvrRows();
    dash.innerHTML = `<div class="ph"><h2>거래대금 TOP 10</h2><button class="btn ghost small" id="tvGo">전체 순위 →</button></div>${tvrTable(rows.slice(0, 10), true)}`;
    $$('#tvDash [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
    $('#tvGo').onclick = () => { switchTab('vol'); setTimeout(() => { const b = $('#vsRank'); if (b) b.scrollIntoView({ behavior: 'smooth' }); }, 50); };
  }
}
