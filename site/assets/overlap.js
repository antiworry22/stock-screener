/* 공통 종목 — 조건검색 추천 · 실시간 순위 · 실시간 종합 · 차트 종합판정 · 전체 종목(종합점수) 다섯 곳에서 동시에 뽑힌 종목
   각 화면의 「뽑힘」 기준(바꿀 수 있음)
   ① 조건검색 추천: 조건식 8개 모두 충족(선택: 1개 부족까지)
   ② 실시간 순위: 시장별 상위 N위(기본 30)
   ③ 실시간 종합: 좋은 신호 유형(3박자 정렬 · 재료+돈 초기 · 수급 선행 · 수급+추세)
   ④ 차트 종합판정: 종합 점수 기준 이상(기본 +28 = 「매수 우위」 이상)
   ⑤ 전체 종목: 종합점수 상위 N위(기본 100)
   겹친 곳이 많을수록 위로, 같으면 각 화면 순위를 합친 「합의 점수」 순 */
'use strict';

const OV = { busy: false, lt: 0, last: null, open: new Set(),
  def: { on: { kc: 1, r4: 1, fu: 1, clx: 1, all: 1 }, kcNear: 0, r4N: 30, clxMin: 28, allN: 100, min: 3, mkt: 'all' } };
const OV_SRC = [['kc', '조건검색', 'kc'], ['r4', '실시간 순위', 'rank4'], ['fu', '실시간 종합', 'fuse'], ['clx', '차트 판정', 'clx'], ['all', '전체 종목', 'all']];
const OV_GOOD = new Set(['3박자 정렬', '재료+돈 초기', '수급 선행', '수급+추세']);
const ovCfg = () => { const c = store.get('ovCfg', null); return c ? { ...OV.def, ...c, on: { ...OV.def.on, ...(c.on || {}) } } : JSON.parse(JSON.stringify(OV.def)); };
const ovP = v => v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, Math.abs(v) < 10 ? 2 : 1)}%`;

/* 다섯 곳의 뽑힌 목록 만들기 → code → {kc, r4, fu, clx, all} (각각 표시값과 0~1 강도) */
function ovCompute() {
  if (!S.data) return null;
  const cfg = ovCfg(), M = new Map(), add = (code, k, v) => { const o = M.get(code) || {}; o[k] = v; M.set(code, o); };
  const by = new Map(S.data.stocks.map(s => [s.code, s]));
  const cnt = { kc: 0, r4: 0, fu: 0, clx: 0, all: 0 }, ready = {};
  // ① 조건검색
  try {
    const D = typeof KC !== 'undefined' ? (KC.last && Date.now() - KC.lt < 60e3 ? KC.last : (typeof kcCompute === 'function' ? kcCompute() : null)) : null;
    if (D) { ready.kc = true; D.rows.filter(r => r.E.all || (cfg.kcNear && r.E.pass >= r.E.need - 1)).forEach(r => { const g = typeof kcGrade === 'function' ? kcGrade(r.total, r.E.all)[0] : ''; add(r.s.code, 'kc', { t: `${fmt(r.total, 0)}점${g ? ' ' + g : ''}${r.E.all ? '' : ' (1개 부족)'}`, w: Math.min(1, r.total / 95), full: r.E.all }); cnt.kc++; }); }
  } catch (e) { console.error(e); }
  // ② 실시간 순위
  try {
    const D = typeof R4 !== 'undefined' ? (R4.last && Date.now() - R4.lt < 60e3 ? R4.last : (typeof r4Compute === 'function' ? r4Compute() : null)) : null;
    if (D) { ready.r4 = true; ['KOSPI', 'KOSDAQ'].forEach(m => (D[m] || []).slice(0, cfg.r4N).forEach(r => { add(r.s.code, 'r4', { t: `${m === 'KOSPI' ? '코스피' : '코스닥'} ${r.rank}위 · ${fmt(r.total, 0)}점`, w: 1 - (r.rank - 1) / cfg.r4N }); cnt.r4++; })); }
  } catch (e) { console.error(e); }
  // ③ 실시간 종합
  try {
    let cur = typeof FU !== 'undefined' ? FU.cur : null; if ((!cur || !cur.size) && typeof fuAll === 'function') { cur = fuAll(); if (typeof FU !== 'undefined') FU.cur = cur; }
    if (cur && cur.size) { ready.fu = true; cur.forEach((f, code) => { if (OV_GOOD.has(f.kind)) { add(code, 'fu', { t: `${f.kind}${f.total != null ? ' · ' + fmt(f.total, 0) : ''}`, w: f.kind === '3박자 정렬' ? 1 : f.kind === '재료+돈 초기' || f.kind === '수급 선행' ? 0.8 : 0.6 }); cnt.fu++; } }); }
  } catch (e) { console.error(e); }
  // ④ 차트 종합판정
  S.data.stocks.forEach(s => { if (s.cl && s.cl.s >= cfg.clxMin) { ready.clx = true; add(s.code, 'clx', { t: `${s.cl.v} ${s.cl.s > 0 ? '+' : ''}${fmt(s.cl.s, 0)}`, w: Math.min(1, s.cl.s / 70) }); cnt.clx++; } else if (s.cl) ready.clx = true; });
  // ⑤ 전체 종목(종합점수)
  const ranked = S.data.stocks.filter(s => s._sc && s._sc.total != null).sort((a, b) => b._sc.total - a._sc.total);
  if (ranked.length) ready.all = true;
  ranked.slice(0, cfg.allN).forEach((s, i) => { add(s.code, 'all', { t: `${i + 1}위 · ${fmt(s._sc.total, 1)}점`, w: 1 - i / cfg.allN }); cnt.all++; });
  // 합치기
  const on = OV_SRC.map(x => x[0]).filter(k => cfg.on[k]);
  const rows = [];
  M.forEach((o, code) => {
    const s = by.get(code); if (!s) return;
    if (cfg.mkt !== 'all' && s.market !== cfg.mkt) return;
    const hit = on.filter(k => o[k]); if (!hit.length) return;
    const cons = Math.round(hit.reduce((a, k) => a + o[k].w, 0) / on.length * 100);
    rows.push({ s, o, hit, n: hit.length, cons });
  });
  rows.sort((a, b) => b.n - a.n || b.cons - a.cons);
  const dist = {}; rows.forEach(r => { dist[r.n] = (dist[r.n] || 0) + 1; });
  OV.last = { rows, cnt, ready, on, cfg, dist, at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16) };
  OV.lt = Date.now();
  return OV.last;
}

function ovWhy(r) {
  const s = r.s, P = [];
  if (r.o.kc) P.push(r.o.kc.full ? '오늘 5일선 돌파 +5% 조건식 충족' : '조건식 1개 차이');
  if (r.o.fu) P.push(r.o.fu.t.split(' · ')[0]);
  if (r.o.clx) P.push(`차트 ${s.cl.v}`);
  if (r.o.r4) P.push(`4요소 ${r.o.r4.t.split(' · ')[0]}`);
  if (r.o.all) P.push(`종합점수 ${r.o.all.t.split(' · ')[0]}`);
  const miss = r.missing = OV.last.on.filter(k => !r.o[k]).map(k => OV_SRC.find(x => x[0] === k)[1]);
  return P.join(' · ') + (miss.length ? ` — 빠진 곳: ${miss.join(', ')}` : ' — 다섯 곳 모두 선택');
}
function ovRowHtml(r, i) {
  const s = r.s, D = OV.last, chg = s._live && s._live.chg != null ? s._live.chg : s.chg, px = (s._live && s._live.c) || s.close;
  const dots = D.on.map(k => `<i class="ov-d ${r.o[k] ? 'on' : ''}" title="${esc(OV_SRC.find(x => x[0] === k)[1])}"></i>`).join('');
  return `<tr class="ov-r n${r.n}" data-ov="${esc(s.code)}"><td class="mono"><b>${i + 1}</b></td>
    <td class="l"><b class="ov-nm" data-ovan="${esc(s.code)}">${esc(s.name)}</b><small>${s.market === 'KOSPI' ? '코스피' : '코스닥'} · ${esc(s.sector || '')}</small></td>
    <td class="mono ${cls(chg)}">${fmt(px)}<small>${ovP(chg)}</small></td>
    <td class="ov-n"><span class="ov-dots">${dots}</span><b>${r.n}/${D.on.length}</b></td>
    <td class="mono"><span class="ov-c">${r.cons}</span></td>
    ${OV_SRC.filter(([k]) => D.cfg.on[k]).map(([k]) => `<td class="ov-s ${r.o[k] ? 'on' : ''}">${r.o[k] ? esc(r.o[k].t) : '<span class="muted">–</span>'}</td>`).join('')}
    <td class="l ov-why">${esc(ovWhy(r))}</td></tr>`;
}
function renderOverlap() {
  const box = $('#ovBody'); if (!box || !S.data) return;
  const D = OV.last && Date.now() - OV.lt < 30e3 ? OV.last : ovCompute(); if (!D) return;
  const cfg = D.cfg, L = D.rows.filter(r => r.n >= cfg.min), q = ($('#ovQ') && $('#ovQ').value || '').trim();
  const rows = q ? D.rows.filter(r => r.s.name.includes(q) || r.s.code.includes(q)) : L;
  const meta = $('#ovMeta'); if (meta) meta.innerHTML = `${typeof kcOpenMkt === 'function' && kcOpenMkt() ? '<span class="gov-live"></span> ' : ''}${D.at} 계산 · 1분마다 다시 계산`;
  $('#ovSum').innerHTML = `<div class="ov-src">${OV_SRC.map(([k, n, tab]) => `<button class="ov-sc ${cfg.on[k] ? 'on' : ''}" data-ovtab="${tab}" title="${esc(n)} 탭 열기"><small>${esc(n)}</small><b>${D.ready[k] ? fmt(D.cnt[k]) : '…'}</b><span>${cfg.on[k] ? '종목 뽑힘' : '비교에서 뺌'}</span></button>`).join('')}</div>
    <div class="ov-dist">${[5, 4, 3, 2].filter(n => n <= D.on.length).map(n => `<button class="chip ${cfg.min === n ? 'on' : ''}" data-ovmin="${n}">${n === D.on.length ? `${n}곳 모두` : `${n}곳 이상`} <b>${D.rows.filter(r => r.n >= n).length}</b></button>`).join('')}</div>`;
  box.innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl ov-tb"><thead><tr><th>순위</th><th class="l">종목</th><th>현재가</th><th>겹침</th><th>합의 점수</th>${OV_SRC.filter(([k]) => cfg.on[k]).map(([, n]) => `<th>${esc(n)}</th>`).join('')}<th class="l">한 줄 정리</th></tr></thead><tbody>${rows.slice(0, 100).map(ovRowHtml).join('')}</tbody></table></div>`
    : `<p class="hint">${cfg.min}곳 이상 겹치는 종목이 지금은 없어요. 위에서 「${Math.max(2, cfg.min - 1)}곳 이상」으로 낮추거나, 아래 기준을 넓혀 보세요.</p>`;
  $$('#tab-ov [data-ovan]').forEach(el => el.onclick = e => { e.stopPropagation(); showAnalysis(el.dataset.ovan); });
  $$('#ovBody tr[data-ov]').forEach(tr => tr.onclick = () => showAnalysis(tr.dataset.ov));
  $$('#ovSum [data-ovmin]').forEach(b => b.onclick = () => { const c = ovCfg(); c.min = +b.dataset.ovmin; store.set('ovCfg', c); OV.lt = 0; renderOverlap(); });
  $$('#ovSum [data-ovtab]').forEach(b => b.onclick = () => switchTab(b.dataset.ovtab));
}
function ovCfgHtml(c) {
  return `<div class="ov-cfg">${OV_SRC.map(([k, n]) => `<label><input type="checkbox" data-ovon="${k}" ${c.on[k] ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
    <div class="ov-cfg2"><label>조건검색 <select data-ovv="kcNear"><option value="0" ${!c.kcNear ? 'selected' : ''}>8개 모두 충족만</option><option value="1" ${c.kcNear ? 'selected' : ''}>1개 부족까지</option></select></label>
      <label>실시간 순위 시장별 상위 <input class="inp" type="number" min="5" max="200" step="5" data-ovv="r4N" value="${c.r4N}">위</label>
      <label>차트 판정 점수 <input class="inp" type="number" min="-100" max="100" step="2" data-ovv="clxMin" value="${c.clxMin}"> 이상</label>
      <label>전체 종목 종합점수 상위 <input class="inp" type="number" min="10" max="500" step="10" data-ovv="allN" value="${c.allN}">위</label>
      <label>시장 <select data-ovv="mkt"><option value="all" ${c.mkt === 'all' ? 'selected' : ''}>코스피+코스닥</option><option value="KOSPI" ${c.mkt === 'KOSPI' ? 'selected' : ''}>코스피</option><option value="KOSDAQ" ${c.mkt === 'KOSDAQ' ? 'selected' : ''}>코스닥</option></select></label>
      <button class="btn ghost small" id="ovReset">기본 기준으로</button></div>`;
}
function ovBindCfg() {
  const box = $('#ovCfg'); if (!box) return;
  box.innerHTML = ovCfgHtml(ovCfg());
  const save = () => { const c = ovCfg(); $$('#ovCfg [data-ovon]').forEach(x => { c.on[x.dataset.ovon] = x.checked ? 1 : 0; }); $$('#ovCfg [data-ovv]').forEach(x => { const k = x.dataset.ovv; c[k] = k === 'mkt' ? x.value : +x.value; }); store.set('ovCfg', c); OV.lt = 0; renderOverlap(); };
  $$('#ovCfg input, #ovCfg select').forEach(x => x.onchange = save);
  $('#ovReset').onclick = () => { store.set('ovCfg', null); ovBindCfg(); OV.lt = 0; renderOverlap(); };
}
async function ovLoop(force) {
  if (OV.busy || !S.data) return;
  const on = $('#tab-ov') && $('#tab-ov').classList.contains('on');
  if (!force && (document.hidden || !on)) return;
  OV.busy = true;
  try { if (typeof kcOpenMkt === 'function' && kcOpenMkt() && typeof sfLoad === 'function') await sfLoad(); OV.lt = 0; renderOverlap(); } catch (e) { console.error(e); }
  OV.busy = false;
}
function initOverlap() {
  ovBindCfg();
  const q = $('#ovQ'); if (q) q.oninput = () => renderOverlap();
  setInterval(() => ovLoop(false), 60e3);
  const tb = $('button[data-tab="ov"]'); if (tb) tb.addEventListener('click', () => { if (!OV.last) { const b = $('#ovBody'); if (b) b.innerHTML = '<p class="hint">다섯 화면의 결과를 모으는 중이에요…</p>'; } setTimeout(() => ovLoop(true), 30); });
  if ($('#tab-ov') && $('#tab-ov').classList.contains('on')) setTimeout(() => ovLoop(true), 1500);
  if (typeof FM !== 'undefined') FM.ov_n = { key: 'ov_n', label: '공통 종목: 겹친 화면 수(조건검색·순위·종합·차트·전체)', group: '종합', type: 'num', unit: '곳', get: s => { const D = OV.last; if (!D) return null; const r = D.rows.find(x => x.s === s); return r ? r.n : 0; } };
}
(function waitBootOv() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) setTimeout(initOverlap, 500);
  else setTimeout(waitBootOv, 900);
})();
