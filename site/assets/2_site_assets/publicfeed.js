/* 공공기관 자료 — 정부 부처·기관 발표 + 거래소 시장경보 → 영향받을 코스피·코스닥 종목
   데이터: data/public.json (GitHub Actions가 15분마다 갱신). 화면은 3분마다 GitHub에서 최신 파일을 직접 확인합니다. */
'use strict';

const GOV = { d: null, org: '', kind: '', imp: '0', tone: 'all', mkt: 'all', q: '', code: '', shown: 40, timer: null, next: 0, newIds: new Set(), first: true,
  RAW: 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-public/public.json' };

const govMap = () => { if (!GOV._m && S.data) { GOV._m = {}; S.data.stocks.forEach(s => { GOV._m[s.code] = s; }); } return GOV._m || {}; };
const govStars = n => '★'.repeat(n || 1) + '☆'.repeat(3 - (n || 1));
function govAgo(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - new Date(ts + ':00+09:00')) / 60000);
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
}
function govChip(c, e, direct) {
  const s = govMap()[c]; if (!s) return '';
  return `<button class="mn-chip ${e > 0 ? 'good' : e < 0 ? 'bad' : ''} ${direct ? 'direct' : ''}" data-govan="${esc(c)}">${direct ? '<b>직접</b> ' : ''}${esc(s.name)} <small>${s.market === 'KOSPI' ? '코스피' : '코스닥'}</small> <small class="${cls(s.chg)} mono">${pct(s.chg, 1)}</small></button>`;
}
function govLinked(it) {
  const M = govMap(), out = new Set(it.st);
  it.th.forEach(([n]) => ((GOV.d.themes[n] || {}).stocks || []).slice(0, 6).forEach(c => out.add(c)));
  return [...out].filter(c => M[c]);
}

function govItemHtml(it) {
  const M = govMap(), mk = c => GOV.mkt === 'all' || (M[c] && M[c].market === GOV.mkt);
  const direct = it.st.filter(c => M[c] && mk(c));
  const groups = it.th.map(([n, e]) => {
    const cs = ((GOV.d.themes[n] || {}).stocks || []).filter(c => M[c] && !direct.includes(c) && mk(c)).slice(0, 5);
    return cs.length ? `<div class="mn-grp"><span class="mn-gl ${e > 0 ? 'good' : e < 0 ? 'bad' : ''}">${esc(n)} ${e > 0 ? '▲ 유리' : e < 0 ? '▼ 부담' : '· 관련'}</span>${cs.map(c => govChip(c, e, false)).join('')}</div>` : '';
  }).join('');
  const isNew = GOV.newIds.has(it.id);
  const when = it.ts ? `${it.ts.slice(5, 10).replace('-', '.')} ${it.ts.slice(11)}` : `${(it.date || '').slice(5).replace('-', '.')} 발표`;
  return `<article class="mn-item gov-item ${it.kind === '시장경보' ? 'gov-alert' : ''} ${isNew ? 'gov-new' : ''}">
    <div class="mn-top">${isNew ? '<span class="tag gov-newtag">NEW</span>' : ''}<span class="tag gov-org">${esc(it.org)}</span><span class="tag ${it.kind === '시장경보' ? 'bad' : ''}">${esc(it.kind)}</span>${it.tone > 0 ? '<span class="tag good">호재</span>' : it.tone < 0 ? '<span class="tag bad">악재</span>' : ''}
      <span class="gov-imp" title="중요도">${govStars(it.imp)}</span><span class="ns">${esc(it.src)} · ${when} · 수집 ${govAgo(it.seen)}</span></div>
    <a class="mn-t" href="${esc(it.u)}" target="_blank" rel="noopener">${esc(it.t)}</a>
    ${it.sum ? `<div class="mn-desc">${esc(it.sum)}</div>` : ''}
    <div class="mn-note">👉 ${esc(it.note)}</div>
    ${direct.length || groups ? `<div class="mn-stocks">${direct.length ? `<div class="mn-grp"><span class="mn-gl">${it.kind === '시장경보' ? '대상 종목' : '자료에 나온 종목'}</span>${direct.map(c => govChip(c, it.tone, true)).join('')}</div>` : ''}${groups}</div>` : ''}
  </article>`;
}

function govFilter() {
  const M = govMap();
  let rows = GOV.d.items;
  if (GOV.org) rows = rows.filter(i => i.org === GOV.org);
  if (GOV.kind) rows = rows.filter(i => i.kind === GOV.kind);
  if (GOV.imp !== '0') rows = rows.filter(i => (i.imp || 1) >= +GOV.imp);
  if (GOV.tone === 'pos') rows = rows.filter(i => i.tone > 0 || i.th.some(x => x[1] > 0));
  if (GOV.tone === 'neg') rows = rows.filter(i => i.tone < 0 || i.th.some(x => x[1] < 0));
  if (GOV.tone === 'new') rows = rows.filter(i => GOV.newIds.has(i.id));
  if (GOV.mkt !== 'all') rows = rows.filter(i => govLinked(i).some(c => M[c].market === GOV.mkt));
  if (GOV.code) { const a = GOV.d.stocks[GOV.code]; const set = new Set(a ? a.it : []); rows = rows.filter(i => set.has(i.id) || i.st.includes(GOV.code)); }
  else if (GOV.q) { const q = GOV.q.toLowerCase(); rows = rows.filter(i => (i.t + ' ' + (i.sum || '') + ' ' + i.note + ' ' + i.org).toLowerCase().includes(q)); }
  return rows;
}

function govRenderList() {
  const box = $('#govList'); if (!box || !GOV.d) return;
  const rows = govFilter(), s = GOV.code ? govMap()[GOV.code] : null;
  $('#govCount').innerHTML = `${s ? `<b>${esc(s.name)}</b> 관련 ` : ''}자료 <b>${rows.length}</b>건${s ? ` · <a href="#" id="govToAn">${esc(s.name)} 종합 분석 →</a> · <a href="#" id="govClr">필터 해제</a>` : ''}`;
  box.innerHTML = rows.length ? rows.slice(0, GOV.shown).map(govItemHtml).join('') : '<div class="empty">조건에 맞는 공공기관 자료가 없어요.</div>';
  $('#govMore').classList.toggle('hidden', rows.length <= GOV.shown);
  $('#govMore').textContent = `더 보기 (${rows.length - GOV.shown}건 남음)`;
  $$('#govList [data-govan]').forEach(el => el.onclick = () => showAnalysis(el.dataset.govan));
  if ($('#govToAn')) $('#govToAn').onclick = e => { e.preventDefault(); showAnalysis(GOV.code); };
  if ($('#govClr')) $('#govClr').onclick = e => { e.preventDefault(); GOV.code = ''; GOV.q = ''; $('#govQ').value = ''; govRenderList(); };
}

function govRenderTop() {
  const d = GOV.d, m = d.meta, M = govMap();
  const alerts = d.items.filter(i => i.kind === '시장경보' && i.date >= new Date(Date.now() + 9 * 3600e3 - 3 * 864e5).toISOString().slice(0, 10))
    .filter(i => GOV.mkt === 'all' || i.st.some(c => M[c] && M[c].market === GOV.mkt));
  const big = d.items.filter(i => i.kind !== '시장경보' && (i.imp || 1) >= 3).slice(0, 8);
  $('#govSum').innerHTML = `
    <div class="mn-col"><h4>🚨 거래소 시장경보 (최근 3일)</h4>${alerts.length ? alerts.slice(0, 12).map(i => {
      const c = i.st[0], s = M[c];
      return `<div class="gov-al ${i.tone < 0 ? 'bad' : i.tone > 0 ? 'good' : ''}" ${c ? `data-govan="${esc(c)}"` : ''}><b>${esc(s ? s.name : i.t.split(' — ')[0])}</b><span>${esc(i.label || i.t)}</span><small>${esc((i.date || '').slice(5).replace('-', '.'))}</small></div>`;
    }).join('') : `<div class="hint">${m.dart ? '최근 3일 시장경보가 없어요.' : 'DART 키가 없어 시장경보를 못 가져왔어요.'}</div>`}</div>
    <div class="mn-col gov-big"><h4>⭐ 중요 발표 (★★★)</h4>${big.length ? big.map(i => `<div class="gov-bg" data-govid="${esc(i.id)}"><span class="tag gov-org">${esc(i.org)}</span> ${i.tone > 0 ? '<span class="up">▲</span>' : i.tone < 0 ? '<span class="down">▼</span>' : ''} ${esc(i.t)} <small class="muted">${esc((i.date || '').slice(5).replace('-', '.'))}</small></div>`).join('') : '<div class="hint">중요 발표가 아직 없어요.</div>'}</div>
    <div class="mn-col"><h4>기관별 자료 수</h4>${Object.entries(d.orgs).slice(0, 14).map(([o, n]) => `<button class="chip ${GOV.org === o ? 'on' : ''}" data-govorg="${esc(o)}">${esc(o)} <b>${n}</b></button>`).join(' ')}</div>`;
  $$('#govSum [data-govan]').forEach(el => el.onclick = () => showAnalysis(el.dataset.govan));
  $$('#govSum [data-govorg]').forEach(el => el.onclick = () => { GOV.org = GOV.org === el.dataset.govorg ? '' : el.dataset.govorg; $('#govOrg').value = GOV.org; govRenderTop(); govRenderList(); });
  $$('#govSum [data-govid]').forEach(el => el.onclick = () => { const it = d.items.find(x => x.id === el.dataset.govid); if (it) window.open(it.u, '_blank', 'noopener'); });
}

function govStatus() {
  if (!GOV.d || !$('#govStatus')) return;
  const sec = Math.max(0, Math.round((GOV.next - Date.now()) / 1000));
  const m = GOV.d.meta;
  $('#govStatus').innerHTML = `<span class="gov-live"></span> 마지막 수집 <b>${esc(m.generated.slice(11))}</b> (${govAgo(m.generated.replace(' ', 'T'))}) · 자료 ${m.n}건 (정책브리핑 ${m.by_src['정책브리핑'] || 0} · 시장경보 ${m.by_src['거래소 시장경보'] || 0} · 기관 발표 보도 ${m.by_src['기관 발표 보도'] || 0}) · 다음 확인 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

async function govLoad(manual) {
  let d = null;
  try { const r = await fetch(GOV.RAW + '?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) { /* GitHub 직접 읽기 실패 → 사이트 사본 */ }
  if (!d) { try { d = await getJSON('data/public.json'); } catch (e) { d = null; } }
  GOV.next = Date.now() + 180e3;
  if (!d) {
    if ($('#govSum')) $('#govSum').innerHTML = '<div class="empty">공공기관 자료(public.json)가 아직 없어요. GitHub Actions의 public-feed가 한 번 돌면 채워집니다.</div>';
    if (typeof govFillAnalysis === 'function') govFillAnalysis();
    return;
  }
  const seen = new Set(store.get('govSeen', []));
  const fresh = d.items.filter(i => !seen.has(i.id));
  if (GOV.first) { GOV.newIds = new Set(seen.size ? fresh.map(i => i.id) : []); }
  else fresh.forEach(i => GOV.newIds.add(i.id));
  const changed = !GOV.d || GOV.d.meta.generated !== d.meta.generated;
  GOV.d = d; GOV._m = null;
  store.set('govSeen', d.items.map(i => i.id).concat([...seen]).slice(0, 3000));
  if (!GOV.first && fresh.length) govNotify(fresh);
  GOV.first = false;
  if (changed || manual) { govInitUI(); govRenderTop(); govRenderList(); govFillAnalysis(); }
  govStatus();
  const tab = $('button[data-tab="gov"]');
  if (tab) tab.dataset.badge = GOV.newIds.size ? GOV.newIds.size : '';
}

function govNotify(fresh) {
  const imp = fresh.filter(i => (i.imp || 1) >= 3);
  if (!imp.length) return;
  const t = $('#govToast');
  if (t) { t.innerHTML = `🔔 새 공공기관 자료 ${fresh.length}건 (중요 ${imp.length}건): ${esc(imp[0].t)}`; t.classList.remove('hidden'); setTimeout(() => t.classList.add('hidden'), 15000); }
  if (store.get('govNoti', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('공공기관 자료 ' + imp.length + '건', { body: imp.slice(0, 3).map(i => `[${i.org}] ${i.t}`).join('\n') }); } catch (e) {}
  }
}

function govInitUI() {
  const o = $('#govOrg'); if (!o || !GOV.d) return;
  o.innerHTML = '<option value="">모든 기관</option>' + Object.entries(GOV.d.orgs).map(([k, n]) => `<option value="${esc(k)}" ${GOV.org === k ? 'selected' : ''}>${esc(k)} (${n})</option>`).join('');
  const kinds = {}; GOV.d.items.forEach(i => { kinds[i.kind] = (kinds[i.kind] || 0) + 1; });
  $('#govKind').innerHTML = '<option value="">모든 종류</option>' + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<option value="${esc(k)}" ${GOV.kind === k ? 'selected' : ''}>${esc(k)} (${n})</option>`).join('');
}

function govFillAnalysis() {
  const box = $('#govAnMount'); if (!box) return;
  const code = box.dataset.code, s = govMap()[code];
  if (!GOV.d) { box.innerHTML = '<div class="hint">공공기관 자료를 불러오는 중이거나 아직 수집 전이에요.</div>'; return; }
  const a = GOV.d.stocks[code];
  if (!a) { box.innerHTML = '<div class="hint">최근 7일 공공기관 자료·시장경보에서 이 종목이나 관련 업종이 언급되지 않았어요.</div>'; return; }
  const items = GOV.d.items.filter(i => a.it.includes(i.id)).slice(0, 5);
  box.innerHTML = `${a.warn ? `<p class="an-p bad"><b>⚠ 거래소 시장경보 ${a.warn}건</b> — 신규 매수에 주의하세요.</p>` : ''}
    <p class="an-p">최근 7일 공공기관 자료에서 <b>직접 ${a.n1}건</b>, 관련 업종으로 <b>${a.n2}건</b> · 유리한 자료 ${a.pos}건 / 부담되는 자료 ${a.neg}건</p>
    ${items.map(i => `<a class="news-item" href="${esc(i.u)}" target="_blank" rel="noopener"><span class="tag ${i.tone > 0 ? 'good' : i.tone < 0 ? 'bad' : ''}">${esc(i.org)}</span><span class="nt">${esc(i.t)}</span><span class="ns">${esc((i.date || '').slice(5))}</span></a>`).join('')}
    <button class="btn ghost small mt-s" data-govstock="${esc(code)}">공공기관 자료에서 모두 보기 →</button>`;
  const b = box.querySelector('[data-govstock]');
  if (b) b.onclick = () => { GOV.code = code; GOV.org = ''; GOV.kind = ''; GOV.imp = '0'; GOV.tone = 'all'; $('#govQ').value = s ? s.name : ''; switchTab('gov'); govInitUI(); govRenderList(); };
}

function initPublicFeed() {
  if (!$('#govList')) return;
  $('#govOrg').onchange = () => { GOV.org = $('#govOrg').value; govRenderTop(); govRenderList(); };
  $('#govKind').onchange = () => { GOV.kind = $('#govKind').value; govRenderList(); };
  $('#govImp').onchange = () => { GOV.imp = $('#govImp').value; govRenderList(); };
  $('#govTone').onchange = () => { GOV.tone = $('#govTone').value; govRenderList(); };
  $('#govMkt').onchange = () => { GOV.mkt = $('#govMkt').value; govRenderTop(); govRenderList(); };
  let tm; $('#govQ').oninput = () => { clearTimeout(tm); tm = setTimeout(() => { const q = $('#govQ').value.trim(); const hit = q && S.data.stocks.find(s => s.name === q || s.code === q); GOV.code = hit ? hit.code : ''; GOV.q = hit ? '' : q; GOV.shown = 40; govRenderList(); }, 250); };
  $('#govMore').onclick = () => { GOV.shown += 40; govRenderList(); };
  $('#govRefresh').onclick = () => govLoad(true);
  $('#govReadAll').onclick = () => { GOV.newIds.clear(); govRenderList(); const tab = $('button[data-tab="gov"]'); if (tab) tab.dataset.badge = ''; };
  const nb = $('#govNoti');
  const drawNb = () => { nb.textContent = store.get('govNoti', false) ? '🔔 바탕화면 알림 켜짐' : '🔕 바탕화면 알림 켜기'; };
  nb.onclick = async () => {
    if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않아요.'); return; }
    if (store.get('govNoti', false)) { store.set('govNoti', false); drawNb(); return; }
    const p = await Notification.requestPermission();
    store.set('govNoti', p === 'granted'); drawNb();
  };
  drawNb();
  govLoad();
  setInterval(() => govLoad(), 180e3);   // 3분마다 새 자료 확인
  setInterval(govStatus, 1000);
}

(function waitBootGov() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof getJSON === 'function') initPublicFeed();
  else setTimeout(waitBootGov, 300);
})();
