/* 실시간 종합 — 뉴스(시장·공공기관) × 거래대금 × 차트 종합판정의 '유기적 관계'를 종목마다 하나로 읽고, 바뀌는 순간을 알려줌
   · 재료(뉴스) = 왜 움직이나  · 돈(거래대금) = 정말 큰돈이 들어오나  · 추세(차트) = 가격이 그 방향으로 가고 있나
   세 가지가 같은 방향이면 신뢰도가 높고, 엇갈리면 그 '엇갈림'이 곧 경고 신호입니다. */
'use strict';

const FU = { snap: null, feed: [], ready: {}, sort: 'total', kind: '', mkt: 'all', shown: 60 };
const FU_W = { chart: 0.45, vol: 0.30, news: 0.25 };
const fuClamp = (x, a = -100, b = 100) => Math.max(a, Math.min(b, x));
const fuNowKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const fuAgeH = ts => ts ? Math.max(0, (Date.now() - new Date(ts + ':00+09:00')) / 3.6e6) : 48;

/* ── 뉴스 점수: 시장 뉴스 + 공공기관 (직접 언급 가중 2~2.5배, 최근일수록 크게: 24시간 반감) ── */
function fuNews(code) {
  let sum = 0, nPos = 0, nNeg = 0, nDir = 0, alert = null;
  const heads = [];
  const add = (it, e, w, src) => {
    const k = Math.exp(-fuAgeH(it.ts || it.seen) / 24);
    sum += e * w * k;
    if (e > 0) nPos++; if (e < 0) nNeg++;
    heads.push({ t: it.t, u: it.u, e, src, ts: it.ts || it.seen || '', dir: w >= 2, id: it.id });
  };
  if (typeof MN !== 'undefined' && MN.d && MN.d.stocks[code]) {
    MN.d.stocks[code].it.forEach(i => {
      const it = MN.d.items[i]; if (!it) return;
      if (it.st.includes(code)) { nDir++; add(it, it.tone, 2, '뉴스'); }
      else { const th = it.th.find(x => ((MN.d.themes[x[0]] || {}).stocks || []).includes(code)); if (th) add(it, th[1], 1, '뉴스'); }
    });
  }
  if (typeof GOV !== 'undefined' && GOV.d && GOV.d.stocks[code]) {
    if (!FU.govMap || FU.govMapGen !== GOV.d) { FU.govMap = Object.fromEntries(GOV.d.items.map(x => [x.id, x])); FU.govMapGen = GOV.d; }
    GOV.d.stocks[code].it.forEach(id => {
      const it = FU.govMap[id]; if (!it) return;
      if (it.kind === '시장경보' && it.st.includes(code)) {
        if (it.tone < 0 && fuAgeH(it.ts || it.seen) < 96) alert = alert || it.label || '시장경보';
        add(it, it.tone * 2, 2.5, '시장경보'); nDir++;
      } else if (it.st.includes(code)) { nDir++; add(it, it.tone, 2.5, '공공기관'); }
      else { const th = it.th.find(x => ((GOV.d.themes[x[0]] || {}).stocks || []).includes(code)); if (th) add(it, th[1], 1, '공공기관'); }
    });
  }
  heads.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const n = heads.length;
  return { score: n ? fuClamp(Math.round(sum * 14)) : null, n, nPos, nNeg, nDir, alert, heads: heads.slice(0, 6) };
}

/* ── 한 종목 종합 ── */
function fuStock(s) {
  const c = s.cl ? s.cl.s : null;
  const va = typeof volAll === 'function' ? volAll().get(s.code) : null;
  const v = va ? fuClamp((va.score - 50) * 2) : null;
  const nw = fuNews(s.code);
  const parts = [[c, FU_W.chart], [v, FU_W.vol], [nw.score, FU_W.news]].filter(x => x[0] != null);
  const wsum = parts.reduce((p, x) => p + x[1], 0);
  let total = wsum ? Math.round(parts.reduce((p, x) => p + x[0] * x[1], 0) / wsum) : null;
  const f = va ? va.flags : {};
  const money = va ? (va.rv >= 2 ? (((s._vlive || {}).chg ?? s.chg) >= 0 ? 1 : -1) : 0) : 0;      // 돈이 몰리나(방향)
  const volStrong = !!(f.brk || f.bottom || f.trueUp) || money > 0;          // 지금 실제로 큰돈이 들어오는 신호
  const volGood = volStrong || !!(f.healthyPull || f.obvBull || f.obvLead);   // 조용한 매집·건전한 눌림까지 포함
  const volBad = !!(f.whale || f.flat || f.holdTv || f.extreme || f.burn || f.obvBear);
  const C = c == null ? 0 : c >= 15 ? 1 : c <= -15 ? -1 : 0;
  const N = nw.score == null ? 0 : nw.score >= 15 ? 1 : nw.score <= -15 ? -1 : 0;
  const V = volBad ? -1 : volStrong ? 1 : money < 0 ? -1 : 0;   // 강한 돈 신호만 '들어옴'
  const Vq = !volBad && !volStrong && volGood;                 // 조용한 매집(보조)
  let kind, text, tone;
  if (nw.alert) { kind = '시장경보'; tone = 'bad'; text = `거래소 ${nw.alert} — 다른 신호가 좋아도 신규 매수 금지`; total = Math.min(total ?? 0, -40); }
  else if (N > 0 && volBad) { kind = '호재 속 이탈'; tone = 'bad'; text = '좋은 뉴스가 나오는데 큰손 이탈·제자리 폭증 신호 — 호재를 이용한 물량 넘기기(설거지) 의심'; }
  else if (N > 0 && V > 0 && C > 0) { kind = '3박자 정렬'; tone = 'good'; text = '재료(호재) + 돈(거래대금) + 추세(차트)가 모두 같은 방향 — 가장 강한 신호'; }
  else if (N < 0 && V < 0 && C < 0) { kind = '3박자 하락'; tone = 'bad'; text = '악재 + 큰돈 이탈 + 하락 추세 — 피하거나 정리할 자리'; }
  else if (N > 0 && V > 0 && C <= 0) { kind = '재료+돈 초기'; tone = 'good'; text = '호재에 돈이 몰리기 시작 — 차트는 아직 확인 전(돌파·추세 전환 확인 후 진입)'; }
  else if (N <= 0 && V > 0 && C > 0) { kind = '수급 선행'; tone = 'good'; text = (N < 0 ? '나쁜 뉴스에도 ' : '뚜렷한 재료 없이 ') + '돈과 차트가 먼저 움직임 — "수급이 재료에 앞선다", 공시·뉴스가 뒤따를 수 있음'; }
  else if (N > 0 && V <= 0 && C <= 0) { kind = '재료 미반응'; tone = 'mid'; text = '좋은 뉴스에도 거래대금·차트 반응 없음 — 이미 반영됐거나 시장 관심 부족'; }
  else if (N > 0 && V <= 0 && C > 0) { kind = '재료+추세'; tone = 'mid'; text = '호재와 상승 추세는 있지만 거래대금이 받쳐주지 않음 — 거래량 동반 확인 필요'; }
  else if (N < 0 && V < 0) { kind = '악재+이탈'; tone = 'bad'; text = '악재에 큰돈이 빠져나가는 중 — 반등을 기다리기보다 위험 관리'; }
  else if (N < 0 && C > 0) { kind = '악재 버팀'; tone = 'mid'; text = '나쁜 뉴스에도 추세는 유지 — 악재가 이미 반영됐거나 매수세가 강함, 거래대금 방향 확인'; }
  else if ((V > 0 || Vq) && C > 0) { kind = '수급+추세'; tone = 'good'; text = (Vq ? '조용한 매집·건전한 눌림 + 상승 추세' : '거래대금과 차트가 같은 방향') + ' — 뉴스 없이 움직이는 기술적 흐름'; }
  else if (V < 0 && C < 0) { kind = '수급+추세 약세'; tone = 'bad'; text = '돈이 빠지고 추세도 하락 — 약세 흐름'; }
  else if (C > 0) { kind = '추세만'; tone = 'mid'; text = '차트 추세만 좋음 — 거래대금·재료 확인 필요'; }
  else if (C < 0) { kind = '추세 약세'; tone = 'mid'; text = '차트 추세가 약함 — 거래대금이 붙는 반전 신호를 기다림'; }
  else { kind = '중립'; tone = 'low'; text = '세 가지 모두 뚜렷한 방향 없음'; }
  return { code: s.code, total, chart: c, vol: v, news: nw.score, nw, va, kind, tone, text, C, V, N, Vq };
}

function fuAll() {
  if (!S.data) return new Map();
  const m = new Map();
  S.data.stocks.forEach(s => { try { m.set(s.code, fuStock(s)); } catch (e) { /* 자료 없는 종목 */ } });
  return m;
}

/* ── 변화 감지 → 실시간 피드 ── */
function fuOnUpdate(src, fresh) {
  if (!S.data) return;
  const first = !FU.ready[src];  // 이 자료가 이번 화면에서 처음 들어온 것 → 기준점만 잡고 알림 없음
  FU.ready[src] = true;
  const cur = fuAll();
  const prev = first ? null : FU.snap;
  FU.cur = cur;
  if (prev) {
    const t = fuNowKst(), M = Object.fromEntries(S.data.stocks.map(s => [s.code, s]));
    const freshBy = {};
    (fresh || []).forEach(it => (it.st || []).forEach(c => { (freshBy[c] = freshBy[c] || []).push(it); }));
    const volFresh = {}; ((typeof VOL !== 'undefined' && src === 'chart' && VOL.fresh) || []).forEach(x => { (volFresh[x.code] = volFresh[x.code] || []).push(x.k); });
    const clChg = (typeof CLX !== 'undefined' && src === 'chart' && CLX.chg) || {};
    cur.forEach((f, code) => {
      const p = prev.get(code); if (!p || !M[code]) return;
      const why = [];
      if (freshBy[code]) why.push({ k: src === 'gov' ? '공공기관' : '뉴스', t: freshBy[code].slice(0, 2).map(x => (x.tone > 0 ? '▲ ' : x.tone < 0 ? '▼ ' : '') + x.t).join(' / ') });
      if (volFresh[code]) why.push({ k: '거래대금', t: volFresh[code].map(k => (VSIG.find(v => v[0] === k) || [k, k])[1]).join(', ') });
      if (clChg[code]) why.push({ k: '차트', t: `${clChg[code].from} → ${clChg[code].to}` });
      const d = (f.total ?? 0) - (p.total ?? 0);
      const kindChg = f.kind !== p.kind && (f.tone === 'good' || f.tone === 'bad');
      if (!why.length && !kindChg && Math.abs(d) < 15) return;
      if (!why.length && !kindChg) why.push({ k: '종합', t: `종합 점수 ${d > 0 ? '+' : ''}${d}` });
      FU.feed.unshift({ t, code, name: M[code].name, src, d, from: p.kind, to: f.kind, tone: f.tone, total: f.total, why, text: f.text });
    });
    FU.feed = FU.feed.slice(0, 300);
    try { store.set('fuFeed', { day: t.slice(0, 10), feed: FU.feed.slice(0, 150) }); } catch (e) {}
    fuNotify(FU.feed.filter(e => e.t === t));
  }
  FU.snap = cur;
  renderFuse();
  fuFillAnalysis();
}
function fuNotify(evts) {
  // 알림: 3박자 정렬·위험 조합으로 바뀐 종목, 또는 뉴스와 거래대금/차트가 30분 안에 함께 변한 종목('동시 변화')
  const now = Date.now(), hot = [];
  evts.forEach(e => {
    const near = FU.feed.filter(x => x.code === e.code && (now - new Date(x.t.replace(' ', 'T') + ':00+09:00')) < 30 * 60e3);
    const kinds = new Set(near.flatMap(x => x.why.map(w => w.k === '공공기관' ? '뉴스' : w.k)));
    e.combo = (kinds.has('뉴스') && (kinds.has('거래대금') || kinds.has('차트')));
    if (e.combo || (e.from !== e.to && ['3박자 정렬', '재료+돈 초기', '수급 선행', '호재 속 이탈', '시장경보', '3박자 하락', '악재+이탈'].includes(e.to))) hot.push(e);
  });
  if (!hot.length) return;
  const txt = hot.slice(0, 3).map(e => `${e.name}: ${e.to}${e.combo ? '(뉴스·거래·차트 동시 변화)' : ''}`);
  const t = $('#govToast');
  if (t) { t.innerHTML = `🧩 실시간 종합 변화 ${hot.length}건 — ${esc(txt[0])}`; t.classList.remove('hidden'); t.onclick = () => { switchTab('fuse'); t.classList.add('hidden'); }; setTimeout(() => t.classList.add('hidden'), 15000); }
  if (store.get('fuNoti', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('실시간 종합 변화 ' + hot.length + '건', { body: txt.join('\n') }); } catch (e) {}
  }
  const tab = $('button[data-tab="fuse"]'); if (tab) tab.dataset.badge = (+tab.dataset.badge || 0) + hot.length;
}

/* ── 화면 ── */
const fuBar = (v, w = 64) => v == null ? '<span class="muted">–</span>' : `<span class="fu-bar" style="width:${w}px"><i class="${v >= 0 ? 'p' : 'm'}" style="${v >= 0 ? `left:50%;width:${v / 2}%` : `right:50%;width:${-v / 2}%`}"></i></span><b class="mono ${cls(v)}">${v > 0 ? '+' : ''}${v}</b>`;
const FU_KINDS = ['3박자 정렬', '재료+돈 초기', '수급 선행', '수급+추세', '재료+추세', '재료 미반응', '악재 버팀', '추세만', '추세 약세', '중립', '수급+추세 약세', '악재+이탈', '호재 속 이탈', '3박자 하락', '시장경보'];

function fuStatusHtml() {
  const t = x => x ? esc(String(x).slice(11, 16)) : '–';
  const cl = typeof CLX !== 'undefined' && CLX.live ? CLX.live.meta.time : null;
  const vl = typeof VOL !== 'undefined' ? VOL.liveTime : null;
  const mn = typeof MN !== 'undefined' && MN.d ? MN.d.meta.generated : null;
  const gv = typeof GOV !== 'undefined' && GOV.d ? GOV.d.meta.generated : null;
  return `<span class="gov-live"></span> 차트 ${t(cl) === '–' ? esc(S.data.meta.asof) + ' 종가' : t(cl)} · 거래대금 ${vl ? t(vl) : esc(S.data.meta.asof) + ' 종가'} · 시장 뉴스 ${t(mn)} · 공공기관 ${t(gv)} 기준 — 각 자료가 새로 들어올 때마다 자동으로 다시 계산해요(3분마다 확인)`;
}

function renderFuse() {
  const box = $('#fuList'); if (!box || !S.data) return;
  const cur = FU.cur || fuAll(); FU.cur = cur;
  $('#fuStatus').innerHTML = fuStatusHtml();
  const M = Object.fromEntries(S.data.stocks.map(s => [s.code, s]));
  const rows0 = [...cur.values()].filter(f => f.total != null && M[f.code] && (FU.mkt === 'all' || M[f.code].market === FU.mkt));
  const cnt = {}; rows0.forEach(f => { cnt[f.kind] = (cnt[f.kind] || 0) + 1; });
  $('#fuKinds').innerHTML = FU_KINDS.filter(k => cnt[k]).map(k => { const tone = (rows0.find(f => f.kind === k) || {}).tone; return `<button class="chip fu-k ${tone} ${FU.kind === k ? 'on' : ''}" data-fk="${esc(k)}">${esc(k)} <b>${cnt[k]}</b></button>`; }).join('');
  $$('#fuKinds [data-fk]').forEach(b => b.onclick = () => { FU.kind = FU.kind === b.dataset.fk ? '' : b.dataset.fk; FU.shown = 60; renderFuse(); });
  // 피드
  const fd = FU.feed.filter(e => FU.mkt === 'all' || (M[e.code] || {}).market === FU.mkt).slice(0, 40);
  $('#fuFeed').innerHTML = fd.length ? fd.map(e => `<div class="fu-ev ${e.tone} ${e.combo ? 'combo' : ''}" data-an="${esc(e.code)}">
      <span class="fu-t mono">${esc(e.t.slice(11))}</span><b>${esc(e.name)}</b>${e.combo ? '<span class="tag gov-newtag">동시 변화</span>' : ''}
      ${e.from !== e.to ? `<span class="fu-k2">${esc(e.from)} → <b>${esc(e.to)}</b></span>` : `<span class="fu-k2">${esc(e.to)}</span>`}
      <span class="mono ${cls(e.d)}">${e.d > 0 ? '+' : ''}${e.d}</span>
      <div class="fu-why">${e.why.map(w => `<span class="tag ${w.k === '차트' ? 'kr' : w.k === '거래대금' ? 'os' : 'gov-org'}">${esc(w.k)}</span> ${esc(w.t)}`).join(' · ')}</div></div>`).join('')
    : `<div class="hint">아직 변화가 없어요. 뉴스(15분), 공공기관(15분), 차트·거래대금(장중 15분)이 새로 들어올 때마다 바뀐 종목이 여기에 쌓여요.</div>`;
  // 표
  let rows = rows0;
  if (FU.kind) rows = rows.filter(f => f.kind === FU.kind);
  const key = { total: f => f.total, news: f => f.news ?? -999, vol: f => f.vol ?? -999, chart: f => f.chart ?? -999, low: f => -f.total }[FU.sort];
  rows.sort((a, b) => key(b) - key(a));
  $('#fuMeta').textContent = `${rows.length}종목`;
  box.innerHTML = `<table class="clx-tb fu-tb"><thead><tr><th>종목</th><th>현재가</th><th>종합</th><th>차트</th><th>거래대금</th><th>뉴스·공공</th><th>세 가지의 관계</th></tr></thead><tbody>${rows.slice(0, FU.shown).map(f => {
    const s = M[f.code], L = s._vlive || s._live, h = f.nw.heads[0];
    return `<tr data-an="${esc(f.code)}"><td><b>${esc(s.name)}</b> <small class="muted">${s.market === 'KOSPI' ? '코스피' : '코스닥'}</small></td>
      <td class="mono">${fmt(L ? L.c : s.close)} <small class="${cls(L ? L.chg : s.chg)}">${pct(L ? L.chg : s.chg, 1)}</small></td>
      <td>${fuBar(f.total, 70)}</td><td>${fuBar(f.chart, 50)}</td><td>${fuBar(f.vol, 50)}</td><td>${fuBar(f.news, 50)}${f.nw.n ? `<small class="muted"> ${f.nw.n}건</small>` : ''}</td>
      <td><span class="fu-kind ${f.tone}">${esc(f.kind)}</span> <small>${esc(f.text)}</small>${h ? `<div class="fu-h">${h.e > 0 ? '▲' : h.e < 0 ? '▼' : '•'} ${esc(h.t.slice(0, 60))}</div>` : ''}</td></tr>`;
  }).join('')}</tbody></table>${rows.length > FU.shown ? `<button class="btn ghost mt" id="fuMore">더 보기 (${rows.length - FU.shown})</button>` : ''}`;
  if ($('#fuMore')) $('#fuMore').onclick = () => { FU.shown += 60; renderFuse(); };
  $$('#fuList [data-an], #fuFeed [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
}

/* ── 종목 분석 화면 카드 ── */
function fuCardHtml(s) {
  const f = (FU.cur && FU.cur.get(s.code)) || fuStock(s);
  const ev = FU.feed.filter(e => e.code === s.code).slice(0, 6);
  const comp = [['차트 종합판정', f.chart, '추세·모멘텀·구조·패턴', 'chart'], ['거래대금', f.vol, f.va ? `거래 에너지 ${f.va.score}점 · 거래량 ${vX(f.va.rv)}` : '', 'vol'], ['뉴스·공공기관', f.news, f.nw.n ? `${f.nw.n}건 (직접 ${f.nw.nDir}) · 호재 ${f.nw.nPos} / 악재 ${f.nw.nNeg}` : '최근 관련 자료 없음', 'news']];
  return `<div class="fu-top">
    <div class="fu-sum ${f.tone}"><small>실시간 종합 (차트 45% · 거래대금 30% · 뉴스 25%)</small><b>${f.total == null ? '–' : (f.total > 0 ? '+' : '') + f.total}</b><span>${esc(f.kind)}</span><p>${esc(f.text)}</p></div>
    <div class="fu-comp">${comp.map(([l, v, sub]) => `<div><small>${l}</small><div>${fuBar(v, 120)}</div><span class="hint">${esc(sub)}</span></div>`).join('')}</div>
  </div>
  <div class="fu-tri">
    <div class="${f.N > 0 ? 'good' : f.N < 0 ? 'bad' : ''}"><small>재료 — 왜 움직이나</small><b>${f.N > 0 ? '호재' : f.N < 0 ? '악재' : '뚜렷한 재료 없음'}</b></div><span>×</span>
    <div class="${f.V > 0 ? 'good' : f.V < 0 ? 'bad' : ''}"><small>돈 — 큰돈이 들어오나</small><b>${f.V > 0 ? '들어옴' : f.V < 0 ? '빠짐·경보' : f.Vq ? '조용한 매집' : '평소 수준'}</b></div><span>×</span>
    <div class="${f.C > 0 ? 'good' : f.C < 0 ? 'bad' : ''}"><small>추세 — 가격이 따라가나</small><b>${f.C > 0 ? '상승 쪽' : f.C < 0 ? '하락 쪽' : '중립'}</b></div><span>=</span>
    <div class="${f.tone}"><small>관계</small><b>${esc(f.kind)}</b></div>
  </div>
  ${f.nw.heads.length ? `<h4 class="mt">반영된 최근 뉴스·공공기관 자료</h4>${f.nw.heads.slice(0, 5).map(h => `<a class="news-item" href="${esc(h.u)}" target="_blank" rel="noopener"><span class="tag ${h.e > 0 ? 'good' : h.e < 0 ? 'bad' : ''}">${esc(h.src)}${h.dir ? '·직접' : ''}</span><span class="nt">${esc(h.t)}</span><span class="ns">${esc((h.ts || '').slice(5, 16).replace('T', ' '))}</span></a>`).join('')}` : ''}
  <h4 class="mt">오늘의 변화 기록</h4>${ev.length ? ev.map(e => `<div class="fu-ev ${e.tone}"><span class="fu-t mono">${esc(e.t.slice(11))}</span>${e.from !== e.to ? `${esc(e.from)} → <b>${esc(e.to)}</b>` : esc(e.to)} <span class="mono ${cls(e.d)}">${e.d > 0 ? '+' : ''}${e.d}</span><div class="fu-why">${e.why.map(w => `<span class="tag">${esc(w.k)}</span> ${esc(w.t)}`).join(' · ')}</div></div>`).join('') : '<div class="hint">이 화면을 열어 둔 뒤로 아직 변화가 없어요. 새 자료가 들어오면 여기에 시간순으로 쌓여요.</div>'}
  <div class="hint mt">재료(뉴스)는 이유, 돈(거래대금)은 진정성, 추세(차트)는 결과입니다. 셋이 같은 방향이면 신뢰도가 높고, 호재인데 큰돈이 빠지는 식으로 엇갈리면 그 엇갈림이 경고예요.</div>`;
}
function fuFillAnalysis() {
  const box = $('#fuMount'); if (!box || !box.dataset.code || !S.data) return;
  const s = S.data.stocks.find(x => x.code === box.dataset.code); if (!s) return;
  box.innerHTML = fuCardHtml(s);
}

function initFuse() {
  try { const sv = store.get('fuFeed', null); if (sv && sv.day === fuNowKst().slice(0, 10)) FU.feed = sv.feed || []; } catch (e) {}
  if ($('#fuSort')) $('#fuSort').onchange = () => { FU.sort = $('#fuSort').value; renderFuse(); };
  if ($('#fuMkt')) $('#fuMkt').onchange = () => { FU.mkt = $('#fuMkt').value; renderFuse(); };
  const nb = $('#fuNoti');
  if (nb) {
    const draw = () => { nb.textContent = store.get('fuNoti', false) ? '🔔 종합 변화 알림 켜짐' : '🔕 종합 변화 알림 켜기'; };
    nb.onclick = async () => {
      if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않아요.'); return; }
      if (store.get('fuNoti', false)) { store.set('fuNoti', false); draw(); return; }
      const p = await Notification.requestPermission(); store.set('fuNoti', p === 'granted'); draw();
    };
    draw();
  }
  FU.snap = fuAll(); FU.cur = FU.snap;
  renderFuse();
  setInterval(() => { if ($('#fuStatus')) $('#fuStatus').innerHTML = fuStatusHtml(); }, 30e3);
}
(function waitFuse() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof FM !== 'undefined' && FM.cl_score && typeof volAll === 'function') initFuse();
  else setTimeout(waitFuse, 500);
})();
