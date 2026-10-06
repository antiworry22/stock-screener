/* 4요소 실시간 순위 — 거래대금 30% · 차트 패턴 30% · 주도주 25% · 관련 뉴스 15%
   코스피·코스닥 종목을 각각 0~100점으로 매겨 순위를 세우고, 1분마다(실시간 업종 시세가 들어올 때마다) 다시 계산.
   ① 거래대금: 평소(20일 평균) 대비 배수(장중은 하루치로 환산) · 거래대금 흐름(TVF: 시가 위 유입/지지 vs 이탈/대량 매도) · 시장 내 거래대금 순위
   ② 차트 패턴: 차트 종합판정(6축) · 눌림목/박스 돌파/바닥/신고가 패턴 · 구조·캔들 패턴 방향 · 체크리스트 통과
   ③ 주도주: 소속 업종이 오늘 얼마나 강한지(업종 순위·상태) × 업종 안에서 이 종목의 위치(대장주·거래대금 비중·업종 대비 초과 상승)
   ④ 관련 뉴스: 실시간 뉴스·공시 점수(최근일수록 크게) · 호재/악재 건수 · 직접 언급 · 시장경보 */
'use strict';

const R4 = { W: [['tv', '거래대금', 30], ['chart', '차트 패턴', 30], ['lead', '주도주', 25], ['news', '관련 뉴스', 15]], mkt: 'KOSPI', open: new Set(), last: null, lt: 0, prev: {}, hist: [], busy: false };
const r4C = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const r4P = v => v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, Math.abs(v) < 10 ? 2 : 1)}%`;
const r4Eok = v => v == null ? '–' : Math.abs(v) >= 10000 ? fmt(v / 10000, 2) + '조' : fmt(v, v < 10 ? 1 : 0) + '억';
function r4Open() { const k = new Date(Date.now() + 9 * 3600e3), m = k.getUTCHours() * 60 + k.getUTCMinutes(), wd = k.getUTCDay(); return wd >= 1 && wd <= 5 && m >= 540 && m <= 930; }
function r4Frac() { if (!r4Open()) return 1; const k = new Date(Date.now() + 9 * 3600e3), m = k.getUTCHours() * 60 + k.getUTCMinutes() - 540; return r4C(m / 390, 0.08, 1); }

/* 실시간 값: 섹터 흐름이 받은 업종 구성 종목 시세(1분) → 없으면 차트 실시간(15분) → 아침 값 */
function r4Live() {
  const L = new Map();
  if (typeof SF !== 'undefined' && SF.net && SF.net.det) Object.values(SF.net.det).forEach(arr => arr.forEach(m => { if (m.c && m.p) L.set(m.c, { p: m.p, r: m.r, tv: m.tv, src: 'live' }); }));
  return L;
}
/* 업종 정보(섹터 흐름 계산 결과): 종목코드 → {업종, 그 안의 위치} */
function r4SecMap() {
  const M = new Map(); const secs = typeof SF !== 'undefined' && SF.last && SF.last.length ? SF.last : (typeof sfBuild === 'function' ? (() => { try { const x = sfBuild(); SF.last = x; return x; } catch (e) { return []; } })() : []);
  const N = secs.length;
  secs.forEach(x => {
    const big = (x.n || x.mem.length) >= 4;
    x.mem.forEach(m => {
      if (!m.code) return;
      const li = x.leaders ? x.leaders.findIndex(l => l.code === m.code) : -1;
      M.set(m.code, { x, N, big, li, role: li >= 0 ? x.leaders[li].role || [] : [], tvSh: m.tvSh || 0, rel: m.r != null && x.chg != null ? m.r - x.chg : null });
    });
  });
  return M;
}

/* 한 종목 점수 */
function r4Score(s, live, sec, frac) {
  const lv = live.get(s.code), chg = lv && lv.r != null ? lv.r : (s._live && s._live.chg != null ? s._live.chg : s.chg), px = lv ? lv.p : (s._live && s._live.c) || s.close;
  const tv = lv && lv.tv != null ? lv.tv : s.tvalue;
  const P = {}, Y = { tv: [], chart: [], lead: [], news: [] }, N = { tv: [], chart: [], lead: [], news: [] };
  // ① 거래대금
  {
    const c = s.spark || [], v = s.spark_vol || []; let a20 = null;
    if (c.length >= 21 && v.length >= 21) { let t = 0, n = 0; for (let k = c.length - 21; k < c.length - 1; k++) if (c[k] != null && v[k] != null) { t += c[k] * v[k] / 1e8; n++; } a20 = n ? t / n : null; }
    const isLive = lv && lv.src === 'live';
    const ratio = a20 && tv != null ? (tv / (isLive ? frac : 1)) / a20 : (s.tv_ratio || null);
    let sc = 50;
    if (ratio != null) { const d = r4C((ratio - 1) * 35, -25, 40); sc += chg != null && chg < -1 ? (d > 0 ? -d * 0.6 : d) : d; }
    const tvf = s._tvf; if (tvf && tvf.s != null) { sc += r4C(tvf.s * 0.2, -20, 20); if (tvf.k === 'up' || tvf.k === 'hold') Y.tv.push(`거래대금 ${tvf.name}`); else if (tvf.k === 'down' || tvf.k === 'dump') N.tv.push(`거래대금 ${tvf.name}`); }
    if (tv != null) { const big = tv >= 1000 ? 8 : tv >= 300 ? 5 : tv >= 100 ? 2 : tv < 10 ? -8 : 0; sc += big; if (tv >= 1000) Y.tv.push(`거래대금 ${r4Eok(tv)}(시장 상위)`); }
    if (ratio != null && ratio >= 1.5) (chg != null && chg < -1 ? N.tv : Y.tv).unshift(`평소의 ${fmt(ratio, 1)}배 거래${chg != null && chg < -1 ? '(하락 동반)' : ''}`);
    else if (ratio != null && ratio <= 0.6) N.tv.unshift(`거래 한산(평소의 ${fmt(ratio, 2)}배)`);
    P.tv = r4C(sc); P.tvRatio = ratio;
  }
  // ② 차트 패턴
  {
    let sc = 50;
    const cl = s.cl;
    if (cl) { sc += r4C(cl.s * 0.45, -35, 35); (cl.s >= 20 ? Y : cl.s <= -20 ? N : { chart: [] }).chart.push(`차트 종합 ${cl.v}(${cl.s > 0 ? '+' : ''}${fmt(cl.s, 0)})`);
      const pats = (cl.pat || []).map(p => [p[0], p.replace(/[+\-=!]/g, '')]), names = typeof CLX_PAT !== 'undefined' ? CLX_PAT : {};
      pats.forEach(([sg, k]) => { const nm = (names[k] || [k])[0]; if (sg === '+') { sc += 5; Y.chart.push(`${nm}`); } else if (sg === '-') { sc -= 5; N.chart.push(`${nm}`); } });
      if (cl.ckp) { sc += 5; Y.chart.push('진입 체크리스트 통과'); }
    }
    if (typeof PAT_FN !== 'undefined') { const PN = { pullback: '눌림목 반등', box: '박스권 돌파', bottom: '바닥 탈출', high: '신고가 돌파' }; Object.entries(PAT_FN).forEach(([k, fn]) => { try { const p = fn(s); if (p && p.ok) { sc += 7; Y.chart.unshift(`${PN[k] || k} 패턴 충족`); } } catch (e) {} }); }
    if (s.ma_align === 1 || s.ma_align === true) { sc += 3; }
    if (s.rsi != null && s.rsi >= 80) { sc -= 4; N.chart.push(`RSI ${fmt(s.rsi, 0)} 과열`); }
    P.chart = r4C(sc);
  }
  // ③ 주도주
  {
    let sc = 50;
    if (sec) {
      const x = sec.x, secPct = sec.N ? (1 - (x.rank - 1) / Math.max(1, sec.N - 1)) * 100 : 50;
      const stB = { lead: 18, up: 8, rebound: 6, mixed: 0, down: -8, turn: -10, weak: -16 }[x.st] || 0;
      sc = 50 + (secPct - 50) * 0.3 + stB;
      if (sec.li === 0) { sc += 14; Y.lead.push(`${x.name} ${sec.role.includes('대장주') ? '대장주' : '주도주 1위'}`); }
      else if (sec.li > 0 && sec.li < 3) { sc += 9; Y.lead.push(`${x.name} 주도주 ${sec.li + 1}위${sec.role.length ? '(' + sec.role.join('·') + ')' : ''}`); }
      else if (sec.li >= 3) sc += 4;
      if (sec.tvSh >= 0.15) { sc += 6; Y.lead.push(`업종 거래대금의 ${fmt(sec.tvSh * 100, 0)}%`); }
      if (sec.rel != null) { sc += r4C(sec.rel * 2, -10, 10); if (sec.rel >= 2) Y.lead.push(`업종보다 ${fmt(sec.rel, 1)}%p 더 강함`); else if (sec.rel <= -2) N.lead.push(`업종보다 ${fmt(-sec.rel, 1)}%p 약함`); }
      if (x.st === 'lead') Y.lead.unshift(`주도 업종(${x.name} ${r4P(x.chg)})`); else if (x.st === 'weak' || x.st === 'turn') N.lead.unshift(`약한 업종(${x.name} ${SF_ST[x.st][0]})`);
      if (!sec.big) sc = 50 + (sc - 50) * 0.6;
    } else if (s.sector_rel5 != null) { sc += r4C(s.sector_rel5 * 2, -15, 15); }
    if (chg != null) sc += r4C(chg * 1.5, -10, 10);
    P.lead = r4C(sc); P.sec = sec ? sec.x : null;
  }
  // ④ 관련 뉴스
  {
    let sc = 50; const nw = s._nw, nl = s._newsLive;
    if (nl != null) sc += r4C(nl * 0.4, -30, 30);
    if (nw) { sc += r4C(nw.nPos * 4 - nw.nNeg * 6, -20, 20); if (nw.nDir) sc += Math.min(6, nw.nDir * 2);
      const h = (nw.heads || [])[0]; if (h) (h.e > 0 ? Y : h.e < 0 ? N : { news: [] }).news.push(`「${String(h.t).slice(0, 40)}」`);
      if (nw.nPos) Y.news.push(`호재 ${nw.nPos}건`); if (nw.nNeg) N.news.push(`악재 ${nw.nNeg}건`); }
    if (s.disc_pos) { sc += Math.min(6, s.disc_pos * 3); Y.news.push(`호재 공시 ${s.disc_pos}건`); }
    if (s.disc_neg) { sc -= Math.min(8, s.disc_neg * 4); N.news.push(`악재 공시 ${s.disc_neg}건`); }
    if (s._alert) { sc -= 25; N.news.unshift(`시장경보(${s._alert})`); }
    if (!nw && nl == null && !s.disc_pos && !s.disc_neg) sc = 45;   // 뉴스가 없으면 살짝 낮게
    P.news = r4C(sc); P.nw = nw;
  }
  let t = 0; R4.W.forEach(([k, , w]) => { t += P[k] * w / 100; });
  return { s, total: Math.round(t * 10) / 10, P, Y, N, chg, px, tv };
}
function r4Grade(t) { return t >= 80 ? ['S', '4요소가 모두 강한 최상위'] : t >= 70 ? ['A', '강함 — 매수 후보'] : t >= 58 ? ['B', '양호 — 관심'] : t >= 45 ? ['C', '보통'] : ['D', '약함']; }
function r4Line(r) {
  const best = R4.W.map(([k, n]) => [k, n, r.P[k]]).sort((a, b) => b[2] - a[2]), top = best[0], low = best[best.length - 1];
  const why = (r.Y[top[0]] || [])[0];
  return `${top[1]} ${Math.round(top[2])}점이 가장 강해요${why ? ` — ${why}` : ''}.${low[2] < 45 ? ` 약점은 ${low[1]}(${Math.round(low[2])}점)${(r.N[low[0]] || [])[0] ? ` — ${r.N[low[0]][0]}` : ''}.` : ''}`;
}

/* 전체 계산 */
function r4Compute() {
  if (!S.data) return null;
  const live = r4Live(), sec = r4SecMap(), frac = r4Frac();
  const rows = S.data.stocks.filter(s => s.market === 'KOSPI' || s.market === 'KOSDAQ').map(s => { try { return r4Score(s, live, sec.get(s.code), frac); } catch (e) { return null; } }).filter(Boolean);
  const out = { at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16), live: live.size > 0, KOSPI: [], KOSDAQ: [] };
  ['KOSPI', 'KOSDAQ'].forEach(m => { out[m] = rows.filter(r => r.s.market === m).sort((a, b) => b.total - a.total); out[m].forEach((r, i) => { r.rank = i + 1; }); });
  // 순위 변화: 10분 전 기록과 비교 (이 기기)
  const key = 'r4Hist_' + new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), H = store.get(key, []) || [];
  const now = Date.now(), old = H.find(h => now - h.t >= 9 * 60e3 && now - h.t <= 40 * 60e3) || H[0];
  ['KOSPI', 'KOSDAQ'].forEach(m => out[m].forEach(r => { const p = old && old[m] ? old[m][r.s.code] : null; r.mv = p ? p - r.rank : null; r.new = old && old[m] && !p && r.rank <= 30; }));
  if (!H.length || now - H[H.length - 1].t >= 3 * 60e3) {
    H.push({ t: now, KOSPI: Object.fromEntries(out.KOSPI.slice(0, 60).map(r => [r.s.code, r.rank])), KOSDAQ: Object.fromEntries(out.KOSDAQ.slice(0, 60).map(r => [r.s.code, r.rank])) });
    while (H.length > 40) H.shift();
    try { store.set(key, H); Object.keys(localStorage).filter(x => x.startsWith('scr_r4Hist_') && x !== 'scr_' + key).forEach(x => localStorage.removeItem(x)); } catch (e) {}
  }
  out.oldT = old ? new Date(old.t + 9 * 3600e3).toISOString().slice(11, 16) : null;
  R4.last = out; R4.lt = Date.now();
  return out;
}

/* 화면 */
function r4Bar(v) { return `<span class="r4-bar"><i class="${v >= 60 ? 'p' : v <= 40 ? 'm' : ''}" style="width:${v}%"></i></span><b class="mono">${Math.round(v)}</b>`; }
function r4Row(r) {
  const s = r.s, G = r4Grade(r.total), op = R4.open.has(s.code);
  const mv = r.mv == null ? (r.new ? '<span class="r4-mv new">NEW</span>' : '') : r.mv > 0 ? `<span class="r4-mv up">▲${r.mv}</span>` : r.mv < 0 ? `<span class="r4-mv down">▼${-r.mv}</span>` : '<span class="r4-mv">–</span>';
  return `<tr class="r4-r ${op ? 'open' : ''}" data-r4="${esc(s.code)}"><td class="mono r4-rk"><b>${r.rank}</b>${mv}</td>
    <td class="l"><b class="r4-nm" data-r4an="${esc(s.code)}">${esc(s.name)}</b><small>${esc(r.P.sec ? r.P.sec.name : s.sector || '')}</small></td>
    <td class="mono ${cls(r.chg)}">${fmt(r.px)}<small>${r4P(r.chg)}</small></td>
    <td><span class="r4-tot r4g${G[0]}">${fmt(r.total, 1)}</span><small class="r4-g">${G[0]}</small></td>
    ${R4.W.map(([k]) => `<td class="r4-c">${r4Bar(r.P[k])}</td>`).join('')}
    <td class="l r4-why">${esc(r4Line(r))}</td></tr>
    ${op ? `<tr class="r4-open"><td colspan="${5 + R4.W.length}">${r4Detail(r)}</td></tr>` : ''}`;
}
function r4Detail(r) {
  const s = r.s;
  return `<div class="r4-det">${R4.W.map(([k, n, w]) => `<div class="r4-dc"><h5>${n} <small>${w}% · ${Math.round(r.P[k])}점</small></h5>
      ${(r.Y[k] || []).length ? `<ul class="r4-y">${r.Y[k].slice(0, 4).map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${(r.N[k] || []).length ? `<ul class="r4-n">${r.N[k].slice(0, 3).map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${!(r.Y[k] || []).length && !(r.N[k] || []).length ? '<p class="hint">특이 사항 없음(중립)</p>' : ''}</div>`).join('')}</div>
    <div class="row gap wrap mt-s"><button class="btn ghost small" data-r4go="an" data-c="${esc(s.code)}">종목 분석</button><button class="btn ghost small" data-r4go="tm" data-c="${esc(s.code)}">매매 타이밍</button><button class="btn ghost small" data-r4go="bd" data-c="${esc(s.code)}">실시간 현황판에 추가</button></div>`;
}
function renderRank4() {
  const box = $('#r4Body'); if (!box || !S.data) return;
  const D = R4.last && Date.now() - R4.lt < 20e3 ? R4.last : r4Compute(); if (!D) return;
  const L = D[R4.mkt] || [], q = ($('#r4Q') && $('#r4Q').value || '').trim();
  const rows = q ? L.filter(r => r.s.name.includes(q) || r.s.code.includes(q)) : L.slice(0, R4.n || 50);
  const meta = $('#r4Meta'); if (meta) meta.innerHTML = `${r4Open() ? '<span class="gov-live"></span> ' : ''}${D.at} 계산 · ${D.live ? '업종 실시간 시세(1분) 반영' : '15분 시세 기준'}${D.oldT ? ` · 순위 변화는 ${D.oldT} 대비` : ''}`;
  const top = L.slice(0, 3);
  $('#r4Sum').innerHTML = `<div class="r4-top">${top.map(r => { const G = r4Grade(r.total); return `<div class="r4-tc" data-r4an="${esc(r.s.code)}"><span class="r4-tr">${r.rank}위</span><b>${esc(r.s.name)}</b><span class="r4-tot r4g${G[0]}">${fmt(r.total, 1)}</span><small class="${cls(r.chg)}">${r4P(r.chg)}</small><p>${esc(r4Line(r))}</p></div>`; }).join('')}</div>`;
  box.innerHTML = `<div class="table-wrap"><table class="tbl r4-tb"><thead><tr><th>순위</th><th class="l">종목</th><th>현재가</th><th>종합</th>${R4.W.map(([, n, w]) => `<th>${n}<small>${w}%</small></th>`).join('')}<th class="l">한 줄 평가</th></tr></thead><tbody>${rows.map(r4Row).join('')}</tbody></table></div>
    ${!q && L.length > (R4.n || 50) ? `<div class="row gap mt-s"><button class="btn ghost small" id="r4More">${Math.min(L.length, (R4.n || 50) + 50)}위까지 보기</button><span class="hint">${L.length}종목 중</span></div>` : ''}`;
  $$('#r4Body tr[data-r4]').forEach(tr => tr.onclick = e => { if (e.target.closest('[data-r4an]')) return; const c = tr.dataset.r4; R4.open.has(c) ? R4.open.delete(c) : R4.open.add(c); renderRank4(); });
  $$('#tab-rank4 [data-r4an]').forEach(el => el.onclick = e => { e.stopPropagation(); showAnalysis(el.dataset.r4an); });
  $$('#r4Body [data-r4go]').forEach(b => b.onclick = e => { e.stopPropagation(); const c = b.dataset.c, g = b.dataset.r4go; if (g === 'an') showAnalysis(c); else if (g === 'tm' && typeof openTiming === 'function') openTiming(c); else if (g === 'bd' && typeof bdAdd === 'function') { bdAdd(c); switchTab('board'); if (typeof renderBoard === 'function') { renderBoard(); bdSelect(c); } } });
  const mo = $('#r4More'); if (mo) mo.onclick = () => { R4.n = (R4.n || 50) + 50; renderRank4(); };
  $$('#tab-rank4 [data-r4m]').forEach(b => b.classList.toggle('on', b.dataset.r4m === R4.mkt));
}
function renderRank4Dash() {
  const box = $('#r4Dash'); if (!box || !S.data) return;
  const D = R4.last && Date.now() - R4.lt < 60e3 ? R4.last : r4Compute(); if (!D) return;
  const col = m => `<div><h4>${m === 'KOSPI' ? '코스피' : '코스닥'} TOP 5</h4><ol class="r4-dl">${D[m].slice(0, 5).map(r => { const G = r4Grade(r.total); return `<li data-r4an="${esc(r.s.code)}"><b>${esc(r.s.name)}</b><span class="r4-tot r4g${G[0]}">${fmt(r.total, 1)}</span><small class="${cls(r.chg)}">${r4P(r.chg)}</small>${r.mv > 0 ? `<em class="up">▲${r.mv}</em>` : r.mv < 0 ? `<em class="down">▼${-r.mv}</em>` : ''}</li>`; }).join('')}</ol></div>`;
  box.innerHTML = `<div class="ph"><h2>실시간 종목 순위 <small class="muted">거래대금 30 · 차트 패턴 30 · 주도주 25 · 뉴스 15</small></h2><button class="btn ghost small" id="r4Go">전체 순위 →</button></div><div class="r4-dg">${col('KOSPI')}${col('KOSDAQ')}</div>`;
  const b = $('#r4Go'); if (b) b.onclick = () => { switchTab('rank4'); renderRank4(); };
  $$('#r4Dash [data-r4an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.r4an));
}
async function r4Loop(force) {
  if (R4.busy || !S.data) return;
  const onTab = $('#tab-rank4') && $('#tab-rank4').classList.contains('on'), onDash = $('#tab-dash') && $('#tab-dash').classList.contains('on');
  if (!force && (document.hidden || (!onTab && !onDash))) return;
  R4.busy = true;
  try { if (typeof sfLoad === 'function') await sfLoad(); if (typeof SF !== 'undefined' && typeof sfBuild === 'function' && SF.net) { try { SF.last = sfBuild(); } catch (e) {} } R4.lt = 0; if (onTab) renderRank4(); if (onDash) renderRank4Dash(); } catch (e) { console.error(e); }
  R4.busy = false;
}
function initRank4() {
  r4Loop(true); setInterval(() => r4Loop(false), 60e3);
  const tb = $('button[data-tab="rank4"]'); if (tb) tb.addEventListener('click', () => { renderRank4(); r4Loop(true); });
  $$('#tab-rank4 [data-r4m]').forEach(b => b.onclick = () => { R4.mkt = b.dataset.r4m; R4.n = 50; renderRank4(); });
  const q = $('#r4Q'); if (q) q.oninput = () => renderRank4();
  if (typeof FM !== 'undefined') FM.r4_total = { key: 'r4_total', label: '4요소 실시간 점수(거래대금·차트 패턴·주도주·뉴스)', group: '종합', type: 'num', unit: '점', get: s => { const D = R4.last; if (!D) return null; const r = (D[s.market] || []).find(x => x.s === s); return r ? r.total : null; } };
}
(function waitBootR4() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initRank4();
  else setTimeout(waitBootR4, 900);
})();
