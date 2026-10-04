/* 섹터 종합 순위 — 코스피·코스닥을 각각 업종별로 묶어, 실시간 등락·상승 종목 비율·5일 강도·종합점수·차트 판정·수급·뉴스(실시간 종합)·미국장 영향을
   하나의 점수(0~100)로 합쳐 좋은 순서로 세움. 15분마다(종목 실시간 시세·뉴스·수급이 바뀔 때마다) 다시 계산 */
'use strict';

const SR = { mkt: 'KOSPI', open: new Set(), prev: {} };
const SR_W = [['today', '오늘 등락', 25], ['breadth', '오른 종목 비율', 10], ['rel5', '5일 강도', 15], ['score', '종목 종합점수', 15], ['chart', '차트 판정', 10], ['flow', '외국인·기관', 10], ['fuse', '뉴스·실시간 종합', 10], ['us', '미국장 영향', 5]];
const srC = (v, lo, hi) => v == null || Number.isNaN(v) ? null : Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
const srAvg = a => { const b = a.filter(v => v != null && !Number.isNaN(v)); return b.length ? b.reduce((p, q) => p + q, 0) / b.length : null; };

function srCompute(mkt) {
  const by = {};
  S.data.stocks.forEach(s => { if (mkt !== 'ALL' && s.market !== mkt) return; if (!s.sector || s.sector === '기타') return; (by[s.sector] = by[s.sector] || []).push(s); });
  const secInfo = Object.fromEntries((S.data.sectors || []).map(x => [x.name, x]));
  const rows = Object.entries(by).filter(([, L]) => L.length >= 2).map(([name, L]) => {
    const W = L.reduce((a, s) => a + (s.mcap || 1), 0);
    const chg = L.filter(s => s.chg != null).reduce((a, s) => a + s.chg * (s.mcap || 1), 0) / (W || 1);
    const up = L.filter(s => (s.chg || 0) > 0).length, dn = L.filter(s => (s.chg || 0) < 0).length;
    const r5 = L.filter(s => s.ret5 != null).reduce((a, s) => a + s.ret5 * (s.mcap || 1), 0) / (W || 1);
    const tv = L.reduce((a, s) => a + (s.tvalue || 0), 0);
    const sec = secInfo[name] || {};
    const p = {
      today: srC(chg, -3, 3), breadth: up + dn ? up / (up + dn) * 100 : null,
      rel5: null, score: srAvg(L.map(s => s._sc && s._sc.total)),
      chart: srC(srAvg(L.map(s => s.cl ? s.cl.s : null)), -60, 60),
      flow: srC(srAvg(L.map(s => (s.foreign_streak ?? null) == null && s.inst_streak == null ? null : (s.foreign_streak || 0) + (s.inst_streak || 0))), -6, 6),
      fuse: srC(srAvg(L.map(s => s._fu ? s._fu.total : (s._newsLive ?? null))), -60, 60),
      us: srC(sec.us_impact ?? null, -2, 2),
    };
    return { name, L, chg, up, dn, r5, tv, p, us_impact: sec.us_impact, coupling: sec.coupling };
  });
  // 5일 강도: 같은 시장 평균 대비
  const mk5 = srAvg(rows.map(r => r.r5));
  rows.forEach(r => { r.rel5 = mk5 != null ? r.r5 - mk5 : null; r.p.rel5 = srC(r.rel5, -6, 6); });
  rows.forEach(r => {
    let num = 0, den = 0;
    SR_W.forEach(([k, , w]) => { if (r.p[k] != null) { num += r.p[k] * w; den += w; } });
    const raw = den ? num / den : null;
    // 종목 수가 아주 적은 업종(2~3종목)이 한두 종목 움직임만으로 1위가 되지 않게 50점 쪽으로 살짝 당김
    r.total = raw == null ? null : Math.round(((raw * r.L.length + 50 * 3) / (r.L.length + 3)) * 10) / 10;
  });
  rows.sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
function srReason(r) {
  const g = [], b = [];
  if (r.chg >= 1) g.push(`오늘 ${pct(r.chg, 1)}`); else if (r.chg <= -1) b.push(`오늘 ${pct(r.chg, 1)}`);
  if (r.p.breadth != null) (r.p.breadth >= 65 ? g : r.p.breadth <= 35 ? b : []).push(`오른 종목 ${Math.round(r.p.breadth)}%`);
  if (r.rel5 != null) (r.rel5 >= 2 ? g : r.rel5 <= -2 ? b : []).push(`5일 시장 대비 ${r.rel5 > 0 ? '+' : ''}${fmt(r.rel5, 1)}%p`);
  if (r.p.flow != null) (r.p.flow >= 65 ? g : r.p.flow <= 35 ? b : []).push(r.p.flow >= 65 ? '외국인·기관 매수' : '외국인·기관 매도');
  if (r.p.chart != null) (r.p.chart >= 62 ? g : r.p.chart <= 38 ? b : []).push(r.p.chart >= 62 ? '차트 판정 양호' : '차트 판정 약세');
  if (r.p.fuse != null) (r.p.fuse >= 62 ? g : r.p.fuse <= 38 ? b : []).push(r.p.fuse >= 62 ? '뉴스·실시간 흐름 좋음' : '뉴스·실시간 흐름 나쁨');
  if (r.us_impact != null && Math.abs(r.us_impact) >= 0.5) (r.us_impact > 0 ? g : b).push(`미국장 ${pct(r.us_impact, 1)}`);
  return { g, b };
}
function srTable(rows, compact, key) {
  const mv = r => { const p = SR.prev[key] && SR.prev[key][r.name]; if (!p) return ''; const d = p - r.rank; return d > 0 ? `<span class="rec-mv up">▲${d}</span>` : d < 0 ? `<span class="rec-mv down">▼${-d}</span>` : ''; };
  return `<table class="tbl sr-tb"><thead><tr><th>순위</th><th class="l">업종</th><th>종합 점수</th><th>오늘</th><th>오른·내린</th><th>5일 강도</th>${compact ? '' : '<th>종목 종합</th><th>차트</th><th>수급</th><th>뉴스·종합</th><th>미국장</th><th>거래대금</th>'}<th class="l">좋은 점 · 약한 점</th></tr></thead><tbody>
    ${rows.map(r => { const R = srReason(r), op = !compact && SR.open.has(key + r.name);
      const bar = v => v == null ? '<span class="muted">–</span>' : `<span class="sr-mini"><i style="width:${v}%" class="${v >= 60 ? 'g' : v <= 40 ? 'b' : ''}"></i></span>`;
      return `<tr class="sr-row ${op ? 'open' : ''}" data-sr="${esc(r.name)}"><td class="mono"><b>${r.rank}</b>${mv(r)}</td><td class="l"><b>${compact ? '' : (op ? '▾ ' : '▸ ')}${esc(r.name)}</b> <small class="muted">${r.L.length}종목</small></td>
        <td><span class="score ${sCls(r.total)}">${r.total != null ? fmt(r.total, 1) : '–'}</span></td>
        <td class="mono ${cls(r.chg)}">${pct(r.chg, 2)}</td><td class="mono"><span class="up">${r.up}</span>/<span class="down">${r.dn}</span></td><td class="mono ${cls(r.rel5)}">${r.rel5 != null ? (r.rel5 > 0 ? '+' : '') + fmt(r.rel5, 1) + '%p' : '–'}</td>
        ${compact ? '' : `<td class="mono">${r.p.score != null ? fmt(r.p.score, 0) : '–'}</td><td>${bar(r.p.chart)}</td><td>${bar(r.p.flow)}</td><td>${bar(r.p.fuse)}</td><td class="mono ${cls(r.us_impact)}">${r.us_impact != null ? pct(r.us_impact, 1) : '–'}</td><td class="mono">${typeof vEok === 'function' ? vEok(r.tv) : fmt(r.tv, 0) + '억'}</td>`}
        <td class="l sr-why">${R.g.slice(0, 3).map(x => `<span class="tag good">${esc(x)}</span>`).join('')}${R.b.slice(0, compact ? 1 : 3).map(x => `<span class="tag bad">${esc(x)}</span>`).join('')}</td></tr>`
        + (op ? `<tr class="sec-open"><td colspan="13">${srMembers(r)}</td></tr>` : ''); }).join('')}</tbody></table>`;
}
function srMembers(r) {
  const L = r.L.slice().sort((a, b) => ((b._sc && b._sc.total) || 0) - ((a._sc && a._sc.total) || 0));
  return `<div class="hint">이 업종 종목 — 종합점수 높은 순 (종목을 누르면 분석)</div><div class="usi-chips">${L.slice(0, 30).map(s => `<button class="mn-chip ${s.chg > 0 ? 'good' : s.chg < 0 ? 'bad' : ''}" data-an="${esc(s.code)}">${esc(s.name)} <small class="mono">${s._sc ? fmt(s._sc.total, 0) : '–'}점</small> <small class="mono ${cls(s.chg)}">${pct(s.chg, 1)}</small>${s._fu && ['3박자 정렬', '재료+돈 초기', '수급 선행'].includes(s._fu.kind) ? ' <small>★</small>' : ''}</button>`).join('')}</div>`;
}
function renderSectorRank() {
  if (!S.data || !S.data.stocks.some(s => s.sector && s.sector !== '기타')) {
    ['#srBox', '#srDash'].forEach(id => { const el = $(id); if (el) el.innerHTML = '<div class="hint">업종 분류를 불러오는 중이에요(섹터·미국장 자료 수집 후 표시).</div>'; });
    return;
  }
  const t = (typeof LIVE !== 'undefined' && LIVE.tfTime) || S.data.meta.asof;
  const box = $('#srBox');
  if (box) {
    const rows = srCompute(SR.mkt), key = SR.mkt;
    box.innerHTML = `<div class="row gap wrap sr-tabs">${[['KOSPI', '코스피'], ['KOSDAQ', '코스닥'], ['ALL', '전체']].map(([k, n]) => `<button class="btn small ${SR.mkt === k ? 'primary' : 'ghost'}" data-srm="${k}">${n}</button>`).join('')}
      <span class="hint">${esc(String(t).length > 10 ? '실시간 ' + String(t).slice(11) : String(t) + ' 종가')} 기준 · 업종 ${rows.length}개 · 줄을 누르면 종목이 펼쳐져요</span></div>
      <div class="table-wrap">${srTable(rows, false, key)}</div>
      <div class="hint mt-s">종합 점수 = ${SR_W.map(([, n, w]) => `${n} ${w}%`).join(' · ')} (자료가 없는 항목은 빼고 나머지 비중으로 계산 · 종목 수가 적은 업종은 50점 쪽으로 보정). 오늘 등락·5일 강도는 시가총액 가중, 나머지는 업종 안 종목 평균이에요. ▲▼는 직전 계산 대비 순위 변화.</div>`;
    $$('#srBox [data-srm]').forEach(b => b.onclick = () => { SR.mkt = b.dataset.srm; renderSectorRank(); });
    $$('#srBox tr[data-sr]').forEach(tr => tr.onclick = () => { const k = SR.mkt + tr.dataset.sr; SR.open.has(k) ? SR.open.delete(k) : SR.open.add(k); renderSectorRank(); });
    $$('#srBox [data-an]').forEach(el => el.onclick = e => { e.stopPropagation(); showAnalysis(el.dataset.an); });
  }
  const dash = $('#srDash');
  if (dash) {
    const a = srCompute('KOSPI').slice(0, 5), b = srCompute('KOSDAQ').slice(0, 5);
    dash.innerHTML = `<div class="ph"><h2>강한 섹터 TOP 5</h2><button class="btn ghost small" id="srGo">섹터 종합 순위 전체 →</button></div>
      <div class="grid2 sr-dash"><div><h4>코스피</h4>${srTable(a, true, 'KOSPI')}</div><div><h4>코스닥</h4>${srTable(b, true, 'KOSDAQ')}</div></div>`;
    $('#srGo').onclick = () => { switchTab('sector'); setTimeout(() => { const x = $('#srBox'); if (x) x.scrollIntoView({ behavior: 'smooth' }); }, 50); };
    $$('#srDash tr[data-sr]').forEach(tr => tr.onclick = () => { switchTab('sector'); SR.mkt = tr.closest('div').querySelector('h4').textContent === '코스닥' ? 'KOSDAQ' : 'KOSPI'; SR.open.add(SR.mkt + tr.dataset.sr); renderSectorRank(); setTimeout(() => { const x = $('#srBox'); if (x) x.scrollIntoView({ behavior: 'smooth' }); }, 50); });
  }
  // 순위 변화 기준점: 실시간 시각이 바뀔 때만 옮김
  if (SR.t !== t) { ['KOSPI', 'KOSDAQ', 'ALL'].forEach(k => { SR.prev[k] = SR.cur && SR.cur[k]; }); SR.cur = Object.fromEntries(['KOSPI', 'KOSDAQ', 'ALL'].map(k => [k, Object.fromEntries(srCompute(k).map(r => [r.name, r.rank]))])); SR.t = t; }
}
