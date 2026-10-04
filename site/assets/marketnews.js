/* 시장 뉴스 — 국내·해외 증시 뉴스를 모아 '영향받을 코스피·코스닥 종목'과 함께 보여줍니다.
   데이터: data/news.json (pipeline/market_news.py 가 하루 여러 번 생성) */
'use strict';

const MN = { d: null, reg: 'all', theme: '', tone: 'all', mkt: 'all', q: '', code: '', shown: 40, err: '' };

function mnStock(c) { return S.data && S.data.stocks ? S.data.stocks.find(x => x.code === c) : null; }
function mnMap() {
  if (!MN._map && S.data) { MN._map = {}; S.data.stocks.forEach(s => { MN._map[s.code] = s; }); }
  return MN._map || {};
}
function mnTime(ts) {
  if (!ts) return '';
  const d = new Date(ts + ':00+09:00'), m = Math.round((Date.now() - d) / 60000);
  const rel = m < 60 ? `${Math.max(m, 1)}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
  return `${ts.slice(5, 10).replace('-', '.')} ${ts.slice(11, 16)} · ${rel}`;
}
const mnToneTag = t => `<span class="tag ${t > 0 ? 'good' : t < 0 ? 'bad' : ''}">${t > 0 ? '호재' : t < 0 ? '악재' : '중립'}</span>`;
const mnMk = s => s.market === 'KOSPI' ? '코스피' : '코스닥';

/* 기사 하나에 연결된 종목 [{c, why, e}] — 직접 언급 + 테마 대표 종목 */
function mnLinked(it, perTheme = 5) {
  const M = mnMap(), out = [], seen = new Set();
  it.st.forEach(c => { if (M[c] && !seen.has(c)) { seen.add(c); out.push({ c, why: '직접', e: it.tone }); } });
  it.th.forEach(([n, e]) => {
    const th = MN.d.themes[n]; if (!th) return;
    let k = 0;
    th.stocks.forEach(c => {
      if (k >= perTheme || seen.has(c) || !M[c]) return;
      if (MN.mkt !== 'all' && M[c].market !== MN.mkt) return;
      seen.add(c); out.push({ c, why: n, e }); k++;
    });
  });
  return out;
}

function mnChip(c, e, direct) {
  const s = mnMap()[c]; if (!s) return '';
  return `<button class="mn-chip ${e > 0 ? 'good' : e < 0 ? 'bad' : ''} ${direct ? 'direct' : ''}" data-mnan="${esc(c)}" title="${esc(s.name)} 종합 분석 보기">
    ${direct ? '<b>직접</b> ' : ''}${esc(s.name)} <small>${mnMk(s)}</small> <small class="${cls(s.chg)} mono">${pct(s.chg, 1)}</small></button>`;
}

function mnItemHtml(it) {
  const M = mnMap();
  const direct = it.st.filter(c => M[c]);
  const groups = it.th.map(([n, e]) => {
    const th = MN.d.themes[n]; if (!th) return '';
    const cs = th.stocks.filter(c => M[c] && !direct.includes(c) && (MN.mkt === 'all' || M[c].market === MN.mkt)).slice(0, 5);
    if (!cs.length) return '';
    return `<div class="mn-grp"><span class="mn-gl ${e > 0 ? 'good' : e < 0 ? 'bad' : ''}">${esc(n)} ${e > 0 ? '▲ 유리' : e < 0 ? '▼ 부담' : '· 관련'}</span>${cs.map(c => mnChip(c, e, false)).join('')}</div>`;
  }).join('');
  const dirHtml = direct.filter(c => MN.mkt === 'all' || M[c].market === MN.mkt).map(c => mnChip(c, it.tone, true)).join('');
  return `<article class="mn-item ${MN.newIds && MN.newIds.has(it.id) ? 'gov-new' : ''}">
    <div class="mn-top">${MN.newIds && MN.newIds.has(it.id) ? '<span class="tag gov-newtag">NEW</span>' : ''}<span class="tag ${it.reg === '해외' ? 'os' : 'kr'}">${it.reg}</span>${mnToneTag(it.tone)}${it.lang === 'en' ? '<span class="tag">영문 원문</span>' : ''}
      <span class="mn-cat">${esc(it.cats.slice(0, 2).join(' · '))}</span><span class="ns">${esc(it.s || '')} · ${mnTime(it.ts)}</span></div>
    <a class="mn-t" href="${esc(it.u)}" target="_blank" rel="noopener">${esc(it.t)}</a>
    ${it.desc ? `<div class="mn-desc">${esc(it.desc)}</div>` : ''}
    <div class="mn-note">👉 ${esc(it.note)}</div>
    ${dirHtml || groups ? `<div class="mn-stocks">${dirHtml ? `<div class="mn-grp"><span class="mn-gl">기사에 나온 종목</span>${dirHtml}</div>` : ''}${groups}</div>` : ''}
  </article>`;
}

function mnFilter() {
  const d = MN.d, M = mnMap();
  let rows = d.items;
  if (MN.reg !== 'all') rows = rows.filter(i => i.reg === MN.reg);
  if (MN.theme === '__none') rows = rows.filter(i => !i.st.length && !i.th.length);
  else if (MN.theme) rows = rows.filter(i => i.th.some(x => x[0] === MN.theme));
  if (MN.tone === 'pos') rows = rows.filter(i => i.tone > 0 || i.th.some(x => x[1] > 0));
  if (MN.tone === 'neg') rows = rows.filter(i => i.tone < 0 || i.th.some(x => x[1] < 0));
  if (MN.tone === 'direct') rows = rows.filter(i => i.st.length);
  if (MN.tone === 'new') rows = rows.filter(i => MN.newIds && MN.newIds.has(i.id));
  if (MN.mkt !== 'all') rows = rows.filter(i => mnLinked(i).some(x => M[x.c] && M[x.c].market === MN.mkt));
  if (MN.code) {
    const a = d.stocks[MN.code]; const set = new Set(a ? a.it : []);
    rows = rows.filter(i => set.has(i.i) || i.st.includes(MN.code));
  } else if (MN.q) {
    const q = MN.q.toLowerCase();
    rows = rows.filter(i => i.t.toLowerCase().includes(q) || i.note.toLowerCase().includes(q) || i.cats.join(' ').includes(MN.q));
  }
  return rows;
}

function mnRenderList() {
  const box = $('#mnList'); if (!box || !MN.d) return;
  const rows = mnFilter();
  const s = MN.code ? mnMap()[MN.code] : null;
  $('#mnCount').innerHTML = `${s ? `<b>${esc(s.name)}</b> 관련 ` : ''}기사 <b>${rows.length}</b>건` +
    (s ? ` · <a href="#" id="mnToAn">${esc(s.name)} 종합 분석 보기 →</a> · <a href="#" id="mnClear">필터 해제</a>` : '');
  box.innerHTML = rows.length ? rows.slice(0, MN.shown).map(mnItemHtml).join('') : '<div class="empty">조건에 맞는 뉴스가 없어요. 필터를 바꿔 보세요.</div>';
  $('#mnMore').classList.toggle('hidden', rows.length <= MN.shown);
  $('#mnMore').textContent = `더 보기 (${rows.length - MN.shown}건 남음)`;
  $$('#mnList [data-mnan]').forEach(el => el.onclick = () => showAnalysis(el.dataset.mnan));
  if ($('#mnToAn')) $('#mnToAn').onclick = e => { e.preventDefault(); showAnalysis(MN.code); };
  if ($('#mnClear')) $('#mnClear').onclick = e => { e.preventDefault(); MN.code = ''; MN.q = ''; $('#mnQ').value = ''; MN.shown = 40; mnRenderList(); };
}

function mnRankRow(c, kind) {
  const s = mnMap()[c], a = MN.d.stocks[c]; if (!s || !a) return '';
  return `<div class="mn-rank" data-mncode="${esc(c)}" title="이 종목 관련 뉴스만 보기">
    <span class="mn-rn">${esc(s.name)} <small>${mnMk(s)}</small></span>
    <span class="hint">${a.n1 ? `직접 ${a.n1}` : ''}${a.n1 && a.n2 ? ' · ' : ''}${a.n2 ? `테마 ${a.n2}` : ''}</span>
    <span class="mono ${kind === 'neg' ? 'down' : 'up'}">${a.sc > 0 ? '+' : ''}${a.sc}</span></div>`;
}

function mnRenderSummary() {
  const d = MN.d, m = d.meta;
  $('#mnMeta').textContent = `${m.generated} 업데이트 · 최근 ${m.window_h}시간 기사 ${m.n}건 (국내 ${m.n_kr} · 해외 ${m.n_os}, 영문 원문 ${m.n_en}) · 종목과 연결된 기사 ${m.n_linked}건`;
  const ths = Object.entries(d.themes).filter(([, t]) => t.n).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  const mx = Math.max(1, ...ths.map(([, t]) => t.n));
  const thHtml = ths.map(([n, t]) => `<div class="mn-th" data-mntheme="${esc(n)}" title="이 테마 뉴스만 보기">
      <span class="mn-thn">${esc(n)}</span>
      <span class="mn-bar"><i class="g" style="width:${t.pos / mx * 100}%"></i><i class="b" style="width:${t.neg / mx * 100}%"></i><i class="n" style="width:${Math.max(0, t.n - t.pos - t.neg) / mx * 100}%"></i></span>
      <span class="hint mono">${t.n}건</span></div>`).join('') || '<div class="hint">테마 뉴스가 없어요.</div>';
  const filt = list => list.filter(c => MN.mkt === 'all' || (mnMap()[c] || {}).market === MN.mkt);
  $('#mnSum').innerHTML = `
    <div class="mn-col"><h4>오늘 뉴스가 많은 테마</h4>${thHtml}<div class="hint">초록 = 유리한 소식, 빨강 = 부담되는 소식, 회색 = 방향 불분명</div></div>
    <div class="mn-col"><h4>좋은 소식이 많은 종목</h4>${filt(d.top.pos).slice(0, 10).map(c => mnRankRow(c, 'pos')).join('') || '<div class="hint">없음</div>'}</div>
    <div class="mn-col"><h4>부담되는 소식이 많은 종목</h4>${filt(d.top.neg).slice(0, 10).map(c => mnRankRow(c, 'neg')).join('') || '<div class="hint">없음</div>'}</div>`;
  $$('#mnSum [data-mntheme]').forEach(el => el.onclick = () => { MN.theme = el.dataset.mntheme; $('#mnTheme').value = MN.theme; MN.code = ''; MN.shown = 40; mnRenderList(); $('#mnList').scrollIntoView({ behavior: 'smooth' }); });
  $$('#mnSum [data-mncode]').forEach(el => el.onclick = () => mnShowStock(el.dataset.mncode));
}

function mnShowStock(code) {
  MN.code = code; MN.theme = ''; MN.tone = 'all'; MN.reg = 'all'; MN.shown = 40;
  const s = mnMap()[code];
  if ($('#mnQ')) { $('#mnQ').value = s ? s.name : ''; $('#mnTheme').value = ''; $('#mnTone').value = 'all'; $$('#mnReg input').forEach(r => { r.checked = r.value === 'all'; }); }
  if (typeof switchTab === 'function') switchTab('mnews');
  mnRenderList();
  $('#mnList').scrollIntoView({ behavior: 'smooth' });
}

/* 종목 분석 화면용 카드 */
function mnStockCard(s) {
  if (!MN.d) return `<div class="hint">${MN.err ? '시장 뉴스 파일이 아직 없어요. (다음 자동 수집 후 표시)' : '시장 뉴스를 불러오는 중…'}</div>`;
  const a = MN.d.stocks[s.code];
  if (!a) return '<div class="hint">최근 시장 뉴스에서 이 종목이나 관련 테마가 언급되지 않았어요.</div>';
  const items = MN.d.items.filter(i => a.it.includes(i.i)).slice(0, 5);
  const tone = a.sc > 0 ? '좋은 쪽' : a.sc < 0 ? '부담되는 쪽' : '중립';
  return `<p class="an-p">최근 ${MN.d.meta.window_h}시간 시장 뉴스에서 <b>직접 ${a.n1}건</b>, 관련 테마로 <b>${a.n2}건</b> 언급됐어요. 좋은 소식 ${a.pos}건 · 부담되는 소식 ${a.neg}건 → 전체적으로 <b>${tone}</b>이에요.</p>
    ${items.map(i => `<a class="news-item" href="${esc(i.u)}" target="_blank" rel="noopener">${mnToneTag(i.st.includes(s.code) ? i.tone : ((i.th.find(x => (MN.d.themes[x[0]] || { stocks: [] }).stocks.includes(s.code)) || [0, i.tone])[1]))}<span class="nt">${esc(i.t)}</span><span class="ns">${esc(i.reg)} ${esc((i.ts || '').slice(5, 10))}</span></a>`).join('')}
    <button class="btn ghost small mt-s" data-mnstock="${esc(s.code)}">시장 뉴스에서 모두 보기 →</button>`;
}
function mnFillAnalysis() {
  const box = $('#mnAnMount'); if (!box) return;
  const code = box.dataset.code, s = mnMap()[code]; if (!s) return;
  box.innerHTML = mnStockCard(s);
  const b = box.querySelector('[data-mnstock]'); if (b) b.onclick = () => mnShowStock(b.dataset.mnstock);
}

function mnInitUI() {
  const th = $('#mnTheme');
  th.innerHTML = '<option value="">전체 테마</option>' + Object.entries(MN.d.themes).sort((a, b) => b[1].n - a[1].n)
    .map(([n, t]) => `<option value="${esc(n)}">${esc(n)} (${t.n})</option>`).join('') + '<option value="__none">시장 전체(종목 연결 없음)</option>';
  $$('#mnReg input').forEach(r => r.onchange = () => { MN.reg = r.value; MN.shown = 40; mnRenderList(); });
  th.onchange = () => { MN.theme = th.value; MN.shown = 40; mnRenderList(); };
  $('#mnTone').onchange = () => { MN.tone = $('#mnTone').value; MN.shown = 40; mnRenderList(); };
  $('#mnMkt').onchange = () => { MN.mkt = $('#mnMkt').value; MN.shown = 40; mnRenderSummary(); mnRenderList(); };
  let tm;
  $('#mnQ').oninput = () => {
    clearTimeout(tm);
    tm = setTimeout(() => {
      const q = $('#mnQ').value.trim();
      const hit = q && S.data.stocks.find(s => s.name === q || s.code === q);
      MN.code = hit ? hit.code : ''; MN.q = hit ? '' : q; MN.shown = 40; mnRenderList();
    }, 250);
  };
  $('#mnMore').onclick = () => { MN.shown += 40; mnRenderList(); };
}

const MN_RAW = 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-news/news.json';
MN.newIds = new Set(); MN.first = true; MN.next = 0;

async function mnLoad(manual) {
  let d = null;
  try { const r = await fetch(MN_RAW + '?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) { /* GitHub 직접 읽기 실패 → 사이트 사본 */ }
  if (!d) { try { d = await getJSON('data/news.json'); } catch (e) { d = null; } }
  MN.next = Date.now() + 180e3;
  if (!d) {
    MN.err = 'no data';
    if ($('#mnSum')) $('#mnSum').innerHTML = '<div class="empty">시장 뉴스 파일(news.json)이 아직 없어요. GitHub Actions에서 수집이 한 번 돌면 자동으로 채워집니다.</div>';
    mnFillAnalysis();
    return;
  }
  (d.items || []).forEach(i => { if (!i.id) i.id = i.t; });
  const seen = new Set(store.get('mnSeen', []));
  const fresh = d.items.filter(i => !seen.has(i.id));
  if (MN.first) MN.newIds = new Set(seen.size ? fresh.map(i => i.id) : []);
  else fresh.forEach(i => MN.newIds.add(i.id));
  const changed = !MN.d || MN.d.meta.generated !== d.meta.generated;
  MN.d = d; MN._map = null;
  store.set('mnSeen', d.items.map(i => i.id).concat([...seen]).slice(0, 4000));
  if (!MN.first && fresh.length) mnNotify(fresh);
  if (changed || manual || MN.first) { mnInitUI(); mnRenderSummary(); mnRenderList(); mnFillAnalysis(); }
  MN.first = false;
  if ((changed || manual) && typeof fuOnUpdate === 'function') { try { fuOnUpdate('news', fresh); } catch (e) { console.error(e); } }
  mnStatus();
  const tab = $('button[data-tab="mnews"]');
  if (tab) tab.dataset.badge = MN.newIds.size ? MN.newIds.size : '';
}

function mnNotify(fresh) {
  // 종목 이름이 직접 나온 호재·악재 기사, 또는 원인(유가·금리·환율·전쟁) 뉴스만 알림
  const imp = fresh.filter(i => (i.st.length && i.tone !== 0) || (i.dr && i.dr.length));
  if (!imp.length) return;
  const M = mnMap(), nm = i => i.st.map(c => (M[c] || {}).name).filter(Boolean).slice(0, 2).join('·');
  const t = $('#govToast');
  if (t) { t.innerHTML = `📰 새 시장 뉴스 ${fresh.length}건 (주요 ${imp.length}건): ${esc(imp[0].t)}`; t.classList.remove('hidden'); t.onclick = () => { switchTab('mnews'); t.classList.add('hidden'); }; setTimeout(() => t.classList.add('hidden'), 15000); }
  if (store.get('mnNoti', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('시장 뉴스 ' + imp.length + '건', { body: imp.slice(0, 3).map(i => `${i.tone > 0 ? '▲' : i.tone < 0 ? '▼' : '•'} ${nm(i) ? '[' + nm(i) + '] ' : ''}${i.t}`).join('\n') }); } catch (e) {}
  }
}

function mnStatus() {
  if (!MN.d || !$('#mnStatus')) return;
  const sec = Math.max(0, Math.round((MN.next - Date.now()) / 1000)), m = MN.d.meta;
  const mins = Math.round((Date.now() - new Date(m.generated.replace(' ', 'T') + ':00+09:00')) / 60000);
  $('#mnStatus').innerHTML = `<span class="gov-live"></span> 마지막 수집 <b>${esc(m.generated.slice(11))}</b> (${mins < 1 ? '방금' : mins < 60 ? mins + '분 전' : Math.round(mins / 60) + '시간 전'}) · 이번에 새로 잡힌 기사 ${m.new ?? '–'}건 · 다음 확인 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function initMarketNews() {
  if ($('#mnRefresh')) $('#mnRefresh').onclick = () => mnLoad(true);
  if ($('#mnReadAll')) $('#mnReadAll').onclick = () => { MN.newIds.clear(); mnRenderList(); const tab = $('button[data-tab="mnews"]'); if (tab) tab.dataset.badge = ''; };
  const nb = $('#mnNoti');
  if (nb) {
    const draw = () => { nb.textContent = store.get('mnNoti', false) ? '🔔 바탕화면 알림 켜짐' : '🔕 바탕화면 알림 켜기'; };
    nb.onclick = async () => {
      if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않아요.'); return; }
      if (store.get('mnNoti', false)) { store.set('mnNoti', false); draw(); return; }
      const p = await Notification.requestPermission(); store.set('mnNoti', p === 'granted'); draw();
    };
    draw();
  }
  mnLoad();
  setInterval(() => mnLoad(), 180e3);  // 3분마다 새 뉴스 확인
  setInterval(mnStatus, 1000);
}

(function waitBoot() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof getJSON === 'function') initMarketNews();
  else setTimeout(waitBoot, 300);
})();
