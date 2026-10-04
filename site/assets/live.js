/* 실시간 연결 — 장중 15분마다 들어오는 차트 종합판정·거래대금·뉴스(시장뉴스·공공기관)를
   대시보드·종목 분석·추천 종목·차트 패턴·종목별 뉴스 점수에 그대로 다시 반영합니다. */
'use strict';

const LIVE = { tfTime: null, tfN: 0, proj: null, timer: null, n: 0, last: null };
const LIVE_SKIP = new Set(['volume', 'tvalue']);  // 거래량·거래대금은 volume.js(volApplyLive)가 같은 값으로 넣음

/* ① 차트 실시간 요약의 기술지표(tf)를 종목 자료에 덮어씀 — RSI·MACD·볼린저·이평·52주 위치·거래량 배율 등 */
function liveApplyTf(d) {
  if (!d || !d.s || !S.data) return 0;
  const asof = S.data.meta.asof;
  let n = 0, proj = null;
  S.data.stocks.forEach(s => {
    const x = d.s[s.code]; if (!x || !x.tf || !x.d || x.d < asof) return;  // 아침 수집보다 오래된 값은 쓰지 않음
    if (!s._tf0) { s._tf0 = {}; Object.keys(x.tf).forEach(k => { s._tf0[k] = s[k]; }); }  // 아침 값(비교용)
    Object.entries(x.tf).forEach(([k, v]) => { if (!LIVE_SKIP.has(k) && k !== 'proj' && v !== undefined) s[k] = v; });
    s._tfD = x.d;
    if (x.tf.proj != null) proj = x.tf.proj;
    n++;
  });
  if (n) { LIVE.tfTime = d.meta.time; LIVE.tfN = n; LIVE.proj = proj; }
  return n;
}

/* ② 실시간 종합(fusion) 결과 → 점수에 쓰는 값으로 옮김 */
function liveSetFusion(cur) {
  if (!cur || !S.data) return;
  S.data.stocks.forEach(s => {
    const f = cur.get(s.code);
    if (!f) { s._fu = null; s._newsLive = null; s._alert = null; s._nw = null; return; }
    s._fu = { kind: f.kind, tone: f.tone, text: f.text, total: f.total, chart: f.chart, vol: f.vol, news: f.news };
    s._newsLive = f.news;       // −100~+100 (뉴스·공공기관·시장경보, 시간이 지날수록 약해짐)
    s._alert = f.nw ? f.nw.alert : null;
    s._nw = f.nw && f.nw.n ? f.nw : null;
    s._vsc = f.va ? f.va.score : null;  // 거래대금 해석 점수 0~100
  });
}

/* ③ 모든 화면 다시 계산 (여러 자료가 한꺼번에 와도 한 번만) */
function liveRefresh(src) {
  clearTimeout(LIVE.timer);
  LIVE.src = src;
  LIVE.timer = setTimeout(() => {
    if (!S.data || !S.data.stocks[0] || !S.data.stocks[0]._sc) return;  // 첫 화면 그리기 전
    const y = window.scrollY;
    LIVE.n++; LIVE.last = typeof fuNowKst === 'function' ? fuNowKst() : '';
    try { refresh(); } catch (e) { console.error(e); }
    const box = $('#anOut [id="clxMount"]'), code = box && box.dataset.code;
    if (code && $('#tab-analysis') && $('#tab-analysis').classList.contains('on') && typeof showAnalysis === 'function') {
      try { showAnalysis(code, true); } catch (e) { console.error(e); }
    }
    window.scrollTo(0, y);
  }, 700);
}

/* ④ 대시보드 맨 위: 실시간 종합 하이라이트 */
const LIVE_GOOD = ['3박자 정렬', '재료+돈 초기', '수급 선행', '수급+추세'];
const LIVE_BAD = ['시장경보', '호재 속 이탈', '3박자 하락', '악재+이탈'];
function liveTimeChip(label, t, extra) {
  return `<span class="lv-chip ${t ? 'on' : ''}">${t ? '<span class="gov-live"></span>' : '○'} ${label} <b>${t ? esc(String(t).slice(11, 16) || t) : '대기'}</b>${extra ? ` <small>${extra}</small>` : ''}</span>`;
}
function liveRow(s, right, sub) {
  return `<div class="item" data-an="${esc(s.code)}"><div class="nm"><b>${esc(s.name)}</b><small>${fmt(s.close)} <span class="${cls(s.chg)}">${pct(s.chg)}</span>${sub ? ' · ' + sub : ''}</small></div><div class="rt">${right}</div></div>`;
}
function renderLiveDash() {
  const el = $('#liveDash'); if (!el || !S.data) return;
  const cl = typeof CLX !== 'undefined' && CLX.live ? CLX.live.meta : null;
  const mn = typeof MN !== 'undefined' && MN.d ? MN.d.meta : null;
  const gv = typeof GOV !== 'undefined' && GOV.d ? GOV.d.meta : null;
  const st = S.data.stocks.filter(s => s._fu && s._fu.total != null);
  const kindTag = s => `<span class="tag ${s._fu.tone === 'good' ? 'good' : s._fu.tone === 'bad' ? 'bad' : ''}">${esc(s._fu.kind)}</span>`;
  const good = st.filter(s => LIVE_GOOD.includes(s._fu.kind) && !s._ban.length)
    .sort((a, b) => (LIVE_GOOD.indexOf(a._fu.kind) - LIVE_GOOD.indexOf(b._fu.kind)) || (b._fu.total - a._fu.total)).slice(0, 8);
  const bad = st.filter(s => LIVE_BAD.includes(s._fu.kind)).sort((a, b) => (LIVE_BAD.indexOf(a._fu.kind) - LIVE_BAD.indexOf(b._fu.kind)) || (a._fu.total - b._fu.total)).slice(0, 8);
  const feed = (typeof FU !== 'undefined' ? FU.feed : []).slice(0, 8);
  const M = Object.fromEntries(S.data.stocks.map(s => [s.code, s]));
  const proj = LIVE.proj != null && LIVE.proj < 1 ? `장중 ${Math.round(LIVE.proj * 100)}% 시점 · 거래량 하루 예상치 환산` : '';
  const chgN = cl ? ((CLX.live.changes || []).length) : 0;
  el.innerHTML = `<div class="ph"><h2>실시간 종합 하이라이트</h2><span class="row gap"><span class="hint">차트 판정 × 거래대금 × 뉴스·공공기관이 바뀌면 아래 모든 점수·추천·패턴이 자동으로 다시 계산돼요</span><button class="btn ghost small" id="lvGo">실시간 종합 전체 →</button></span></div>
    <div class="lv-status">${liveTimeChip('차트·거래대금', cl && cl.time, cl ? `${LIVE.tfN || cl.n}종목${proj ? ' · ' + proj : ''}${chgN ? ` · 판정 변화 ${chgN}` : ''}` : '장중 15분마다')}
      ${liveTimeChip('시장 뉴스', mn && mn.generated, mn ? `${(MN.d.items || []).length}건` : '')}
      ${liveTimeChip('공공기관', gv && gv.generated, gv ? `${(GOV.d.items || []).length}건` : '')}
      ${typeof flowChip === 'function' ? `<span class="lv-chip ${FLOW.d ? 'on' : ''}">${FLOW.d ? '<span class="gov-live"></span>' : '○'} ${flowChip()}</span>` : ''}
      ${LIVE.n ? `<span class="hint">점수 재계산 ${LIVE.n}회 · 마지막 ${esc((LIVE.last || '').slice(11))}</span>` : ''}</div>
    <div class="grid3 lv-grid">
      <div><h4 class="good-t">지금 힘이 붙는 종목 <small class="muted">재료·돈·추세 같은 방향</small></h4>${good.length ? good.map(s => liveRow(s, `<b class="mono ${cls(s._fu.total)}">${s._fu.total > 0 ? '+' : ''}${s._fu.total}</b>`, kindTag(s))).join('') : '<div class="empty">해당 종목 없음</div>'}</div>
      <div><h4 class="bad-t">위험 신호 <small class="muted">시장경보·설거지 의심·동반 하락</small></h4>${bad.length ? bad.map(s => liveRow(s, `<b class="mono ${cls(s._fu.total)}">${s._fu.total}</b>`, kindTag(s))).join('') : '<div class="empty">해당 종목 없음</div>'}</div>
      <div><h4>방금 바뀐 종목 <small class="muted">이 화면을 연 뒤의 변화</small></h4>${feed.length ? feed.map(e => { const s = M[e.code]; if (!s) return ''; return liveRow(s, `<small class="muted">${esc(e.t.slice(11))}</small>`, `${e.from !== e.to ? `${esc(e.from)} → <span class="lv-to">${esc(e.to)}</span>` : esc(e.to)} · ${esc(e.why.map(w => w.k).filter(Boolean).join('+') || '종합')}`); }).join('') : '<div class="empty">아직 변화 없음 — 새 자료가 들어오면 여기에 쌓여요</div>'}</div>
    </div>`;
  $$('#liveDash [data-an]').forEach(x => x.onclick = () => showAnalysis(x.dataset.an));
  const g = $('#lvGo'); if (g) g.onclick = () => switchTab('fuse');
}

/* ⑤ 점수·추천에 쓰는 실시간 보조 정보 */
function liveRecAdj(s) {
  // 추천점수 가감: 실시간 종합 조합 + 차트 판정
  let a = 0; const r = [], c = [];
  const f = s._fu;
  if (f) {
    if (f.kind === '3박자 정렬') { a += 6; r.push('실시간 3박자 정렬(재료·돈·추세)'); }
    else if (['재료+돈 초기', '수급 선행', '수급+추세'].includes(f.kind)) { a += 3; r.push('실시간 ' + f.kind); }
    else if (LIVE_BAD.includes(f.kind)) { a -= 10; c.push('실시간 ' + f.kind); }
    else if (f.kind === '추세 약세' || f.kind === '수급+추세 약세') { a -= 3; c.push('실시간 ' + f.kind); }
  }
  if (s.cl && s.cl.s != null) {
    a += Math.max(-5, Math.min(5, s.cl.s / 12));
    if (s.cl.s >= 28) r.push(`차트 판정 ${s.cl.v}`);
    if (s.cl.s <= -28) c.push(`차트 판정 ${s.cl.v}`);
  }
  if (s._nw && s._nw.nDir && s._newsLive != null) {
    if (s._newsLive >= 20) r.push(`실시간 호재 뉴스 ${s._nw.nPos}건`);
    if (s._newsLive <= -20) c.push(`실시간 악재 뉴스 ${s._nw.nNeg}건`);
  }
  return { a, r, c };
}

function liveHeaderText() {
  const t = LIVE.tfTime || (typeof CLX !== 'undefined' && CLX.live && CLX.live.meta.time);
  const bits = [];
  if (t) bits.push(`차트·거래대금 ${String(t).slice(11)}`);
  if (typeof MN !== 'undefined' && MN.d) bits.push(`뉴스 ${String(MN.d.meta.generated || '').slice(11, 16)}`);
  if (typeof GOV !== 'undefined' && GOV.d) bits.push(`공공기관 ${String(GOV.d.meta.generated || '').slice(11, 16)}`);
  if (typeof FLOW !== 'undefined' && FLOW.d) bits.push(`수급 ${String(FLOW.d.meta.time || '').slice(11, 16)}`);
  return bits.length ? ` · 실시간 반영(${bits.join(' · ')})` : '';
}

/* ⑥ 종목별 실시간 뉴스(시장뉴스·공공기관·시장경보) 묶음 */
function liveNewsHtml(s, max) {
  const nw = s._nw; if (!nw || !nw.heads || !nw.heads.length) return '';
  const tone = e => e > 0 ? '<span class="tag good">호재</span>' : e < 0 ? '<span class="tag bad">악재</span>' : '<span class="tag">중립</span>';
  const sc = s._newsLive;
  return `<div class="lv-news"><div class="hint"><span class="gov-live"></span> 실시간 뉴스 ${nw.n}건(직접 언급 ${nw.nDir}) · 분위기 <b class="${cls(sc)}">${sc == null ? '–' : (sc > 0 ? '+' : '') + sc}</b>${s._alert ? ` · <b class="down">시장경보 ${esc(s._alert)}</b>` : ''}</div>
    ${nw.heads.slice(0, max || 4).map(h => `<a class="news-item" ${h.u ? `href="${esc(h.u)}" target="_blank" rel="noopener"` : ''}>${tone(h.e)}<span class="nt">${h.dir ? '' : '<small class="muted">[테마] </small>'}${esc(h.t)}</span><span class="ns">${esc(h.src)} ${esc(String(h.ts || '').slice(5, 16))}</span></a>`).join('')}</div>`;
}
