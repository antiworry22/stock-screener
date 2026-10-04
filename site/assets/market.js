/* 섹터·미국장 실시간 — 보관 칸 live-market 의 market.json(15분마다)을 받아
   미국 지수·업종 ETF·금리·환율·선물, 국내 업종 등락을 화면·점수(업종 강도·미국장 영향·매크로 게이트)에 반영 */
'use strict';

const MKT = { RAW: 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-market/', d: null, st: null };
// 네이버 업종 이름 → 미국 지표 연결 (config 표의 업종 묶음 이름으로 바꿔 줌)
const MKT_RULES = [
  [/전기·가스|전기가스|수도|유틸리티|전력/, '통신/유틸리티'],
  [/반도체|전기전자|전기·전자|일반전기전자|전자장비|전자제품|디스플레이|핸드셋|컴퓨터 ?하드|IT H\/W|정보기기|통신장비|전기제품/, '전기·전자/반도체'],
  [/소프트웨어|IT S\/W|IT ?서비스|컴퓨터서비스|서비스업|양방향|인터넷|게임|디지털컨텐츠|오락|미디어|방송|출판|광고/, 'IT서비스/인터넷'],
  [/의약품|제약|생물|생명과학|건강관리|의료|바이오/, '제약/바이오'],
  [/은행|증권|보험|카드|금융|창업투자/, '금융'],
  [/화학|석유|에너지|정유/, '에너지/화학'],
  [/자동차|운수장비|운송장비|운수창고|운송|해운|항공화물/, '자동차/운송장비'],
  [/조선|기계|우주항공|국방|건축제품|전기장비/, '기계/조선/방산'],
  [/철강|비철|금속|종이|목재|포장/, '철강/소재'],
  [/건설|건축자재/, '건설'],
  [/음식료|식품|음료|담배/, '생필품/음식료'],
  [/유통|백화점|상점|판매|소매|호텔|레저|화장품|섬유|의류|의복|가구|교육/, '유통/소비재'],
  [/통신/, '통신/유틸리티'],
];
function mktGroup(name) { const r = MKT_RULES.find(([re]) => re.test(name || '')); return r ? r[1] : null; }
function mktImpact(name, ur) {
  const g = mktGroup(name), m = g && (S.usmap.map || []).find(x => x.sector === g);
  const e = m || S.usmap.default || { us: [{ sym: 'SP500', beta: 0.3 }], coupling: '기본' };
  const v = e.us.reduce((a, u) => a + (ur[u.sym] ?? 0) * u.beta, 0);
  return { v: Math.round(v * 100) / 100, coupling: e.coupling, syms: e.us.map(u => u.sym), group: g };
}
function mktGate(M) {
  const g = S.cfg.macro_gate || {}, reasons = []; let level = 'green';
  const fx = M.usdkrw || {}, rt = M.us10y || {}, nq = M.nasdaq || {};
  if (fx.chg1 != null && fx.chg1 >= g.usdkrw_chg1_red) { level = 'red'; reasons.push(`원/달러 전일 대비 +${fx.chg1}% 급등`); }
  else if (fx.chg20 != null && fx.chg20 >= g.usdkrw_chg20_yellow) { level = 'yellow'; reasons.push(`원/달러 20일 +${fx.chg20}% 상승 추세`); }
  if (rt.chgbp != null && rt.chgbp >= g.us10y_chgbp_red) { level = 'red'; reasons.push(`미 10년물 +${rt.chgbp}bp 급등`); }
  if (nq.chg != null && nq.chg <= g.nasdaq_chg_red) { level = 'red'; reasons.push(`나스닥 ${nq.chg}% 급락`); }
  if (!reasons.length) reasons.push('환율·금리 안정 — 정상 매매');
  return { level, multiplier: { green: 1, yellow: g.multiplier_yellow || 0.95, red: g.multiplier_red || 0.85 }[level], reasons };
}

async function mktLoad() {
  let d = null, st = null;
  try { const r = await fetch(MKT.RAW + 'market.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) {}
  try { const r = await fetch(MKT.RAW + 'status.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) st = await r.json(); } catch (e) {}
  MKT.st = st;
  if (!d || !S.data) { if (typeof renderSectorLive === 'function') renderSectorLive(); return; }
  const tf = typeof LIVE !== 'undefined' ? LIVE.tfTime : null;  // 종목 실시간 시세가 바뀌어도 업종 등락을 다시 계산
  if (MKT.d && MKT.d.meta.time === d.meta.time && MKT.tf === tf) return;
  MKT.d = d; MKT.tf = tf;
  const U = d.us || {}, M = S.data.macro = S.data.macro || {};
  const pk = (o, extra) => o ? { v: o.v, date: (o.t || '').slice(0, 10), chg: o.chg, chg1: o.chg, chg20: o.chg20, t: o.t, state: o.state, ...(extra || {}) } : undefined;
  if (U.SP500) M.sp500 = pk(U.SP500); if (U.NASDAQ) M.nasdaq = pk(U.NASDAQ); if (U.SOX) M.sox = pk(U.SOX);
  if (U.USDKRW) M.usdkrw = pk(U.USDKRW);
  if (U.US10Y) M.us10y = { v: U.US10Y.v, date: (U.US10Y.t || '').slice(0, 10), chgbp: U.US10Y.prev != null ? Math.round((U.US10Y.v - U.US10Y.prev) * 100) : null, t: U.US10Y.t };
  if (U.KOSPI) M.kospi = pk(U.KOSPI); if (U.KOSDAQ) M.kosdaq = pk(U.KOSDAQ);
  if (U.ES) M.es = pk(U.ES); if (U.NQ) M.nq = pk(U.NQ); if (U.VIX) M.vix = pk(U.VIX);
  const ur = {}; ['SP500', 'NASDAQ', 'SOX', 'XLF', 'XLE', 'XBI', 'XLY'].forEach(k => { if (U[k] && U[k].chg != null) ur[k] = U[k].chg; });
  S.data.us_rets = { ...(S.data.us_rets || {}), ...ur };
  S.data.gate = mktGate(M);
  // 종목 → 업종 연결, 업종 5일 강도, 미국장 영향
  const map = d.map || {};
  S.data.stocks.forEach(s => { if (map[s.code]) s.sector = map[s.code]; });
  const by = {};
  S.data.stocks.forEach(s => { (by[s.sector] = by[s.sector] || []).push(s); });
  const wavg = arr => { const w = arr.filter(s => s.ret5 != null); const W = w.reduce((a, s) => a + (s.mcap || 1), 0); return W ? w.reduce((a, s) => a + s.ret5 * (s.mcap || 1), 0) / W : null; };
  const mkt5 = wavg(S.data.stocks);
  // 업종 목록: 네이버 업종 등락이 있으면 그것을, 없으면 거래소 업종 분류로 묶어 이 사이트의 실시간 시세로 직접 계산(시가총액 가중)
  const wchg = arr => { const w = arr.filter(s => s.chg != null); const W = w.reduce((a, s) => a + (s.mcap || 1), 0); return W ? Math.round(w.reduce((a, s) => a + s.chg * (s.mcap || 1), 0) / W * 100) / 100 : null; };
  const base = (d.sectors && d.sectors.length) ? d.sectors : Object.keys(by).filter(k => k && k !== '기타').map(k => ({ name: k, chg: wchg(by[k]), n: by[k].length, up: by[k].filter(s => (s.chg || 0) > 0).length, down: by[k].filter(s => (s.chg || 0) < 0).length, own: true }));
  const secs = base.map(x => {
    const mem = by[x.name] || [], r5 = wavg(mem), im = mktImpact(x.name, S.data.us_rets);
    return { name: x.name, no: x.no, chg: x.chg, up: x.up, down: x.down, flat: x.flat, n: x.n, ret5: r5 != null ? Math.round(r5 * 10) / 10 : null,
      rel5: r5 != null && mkt5 != null ? Math.round((r5 - mkt5) * 10) / 10 : null, us_impact: im.v, coupling: im.coupling, us_syms: im.syms, group: im.group, count: mem.length, own: !!x.own };
  }).sort((a, b) => (b.chg ?? -99) - (a.chg ?? -99));
  S.data.sectors = secs;
  const SM = Object.fromEntries(secs.map(x => [x.name, x]));
  S.data.stocks.forEach(s => { const x = SM[s.sector]; if (!x) return; s.sector_rel5 = x.rel5; s.us_impact = x.us_impact; s.sector_chg = x.chg; s.us_coupling = x.coupling; });
  if (typeof liveRefresh === 'function') liveRefresh('market'); else if (typeof refresh === 'function') refresh();
}

function mktState(o) {
  if (!o) return '';
  // 마지막 체결 시각이 30분 안이면 '거래 중', 아니면 '마감'
  const age = o.t ? (Date.now() - new Date(o.t.replace(' ', 'T') + ':00+09:00')) / 60000 : 1e9;
  return age <= 30 ? '<span class="tag good">거래 중</span>' : '<span class="tag">마감</span>';
}
function renderSectorLive() {
  if (typeof renderSectorRank === 'function') renderSectorRank();
  const U = (MKT.d && MKT.d.us) || {};
  const card = (k, nm, unit) => { const o = U[k]; if (!o) return '';
    const v = k === 'US10Y' ? fmt(o.v, 3) + '%' : k === 'USDKRW' ? fmt(o.v, 1) + '원' : fmt(o.v, 2);
    const ch = k === 'US10Y' && o.prev != null ? `${o.v - o.prev >= 0 ? '+' : ''}${Math.round((o.v - o.prev) * 100)}bp` : pct(o.chg);
    return `<div class="card"><div class="k">${nm} ${mktState(o)}</div><div class="v mono">${v}</div><div class="d ${cls(k === 'US10Y' || k === 'USDKRW' || k === 'VIX' ? -(o.chg || 0) : o.chg)}">${ch} <small class="muted">${esc((o.t || '').slice(5))}</small></div></div>`; };
  if ($('#usCards')) $('#usCards').innerHTML = MKT.d ? [['SP500', 'S&P500'], ['NASDAQ', '나스닥'], ['SOX', '반도체(SOX)'], ['DOW', '다우'], ['ES', 'S&P 선물'], ['NQ', '나스닥 선물'], ['VIX', '공포지수 VIX'], ['US10Y', '미 10년물'], ['USDKRW', '원/달러'], ['XLK', '기술 ETF'], ['XLF', '금융 ETF'], ['XLE', '에너지 ETF'], ['XBI', '바이오 ETF'], ['XLY', '소비재 ETF']].map(([k, n]) => card(k, n)).join('') : `<div class="hint">${MKT.st ? '미국장 자료 수집 오류: ' + esc(MKT.st.msg || '') : '미국장 실시간 자료를 불러오는 중…(15분마다 갱신)'}</div>`;
  if ($('#usStatus')) $('#usStatus').innerHTML = MKT.d ? `<span class="gov-live"></span> ${esc(MKT.d.meta.time.slice(11))} 기준` : '';
  if ($('#usNote')) $('#usNote').innerHTML = MKT.d ? `한국 낮 시간엔 미국 본장이 닫혀 있어 지수는 전날 밤 종가예요 — 그때는 <b>S&P·나스닥 선물</b>이 오늘 밤 미국장 분위기를 미리 보여줘요. 미 10년물 금리·원/달러·VIX는 오르면(빨강 아님) 주식에 부담이라 색을 반대로 표시했어요.${S.data.gate ? ` · 매크로 게이트: <b>${{ green: '정상', yellow: '주의', red: '경고' }[S.data.gate.level]}</b> — ${esc(S.data.gate.reasons.join(' / '))}` : ''}` : '';
  const secs = S.data.sectors || [];
  const mem = name => S.data.stocks.filter(x => x.sector === name).sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  const react = (x, sec) => { const c = x.chg; if (c == null || sec.us_impact == null || Math.abs(sec.us_impact) < 0.1) return ''; const same = Math.sign(c) === Math.sign(sec.us_impact);
    return same ? `<span class="tag ${c > 0 ? 'good' : 'bad'}">미국장 따라 ${c > 0 ? '상승' : '하락'}</span>` : `<span class="tag">미국장과 반대</span>`; };
  const memTable = sec => { const L = mem(sec.name); if (!L.length) return '<div class="hint">분석 대상 종목이 없어요.</div>';
    return `<table class="tbl sec-mem"><thead><tr><th class="l">종목</th><th>현재가</th><th>오늘</th><th>업종 대비</th><th>5일</th><th>시가총액</th><th>미국장 예상 영향</th><th class="l">반응</th><th>종합</th></tr></thead><tbody>${L.slice(0, MKT.all === sec.name ? 200 : 15).map(x => {
      const rel = x.chg != null && sec.chg != null ? x.chg - sec.chg : null;
      return `<tr data-an="${esc(x.code)}"><td class="l"><b>${esc(x.name)}</b> <small class="muted">${x.market === 'KOSPI' ? '코스피' : '코스닥'}</small></td><td class="mono">${fmt(x.close)}</td><td class="mono ${cls(x.chg)}">${pct(x.chg, 2)}</td><td class="mono ${cls(rel)}">${rel == null ? '–' : (rel > 0 ? '+' : '') + fmt(rel, 2) + '%p'}</td><td class="mono ${cls(x.ret5)}">${pct(x.ret5, 1)}</td><td class="mono">${x.mcap >= 10000 ? fmt(x.mcap / 10000, 1) + '조' : fmt(x.mcap) + '억'}</td><td class="mono ${cls(sec.us_impact)}">${pct(sec.us_impact)}</td><td class="l">${react(x, sec)}</td><td class="mono">${x._sc ? fmt(x._sc.total, 1) : '–'}</td></tr>`; }).join('')}</tbody></table>
      <div class="row gap mt-s">${L.length > 15 && MKT.all !== sec.name ? `<button class="btn ghost small" data-secall="${esc(sec.name)}">${L.length}종목 모두 보기</button>` : ''}<button class="btn ghost small" data-secsearch="${esc(sec.name)}">조건검색으로 보기 →</button></div>`; };
  if ($('#secTable')) {
    MKT.open = MKT.open || new Set();
    $('#secTable').innerHTML = secs.length ? `<thead><tr><th class="l">업종</th><th>오늘</th><th>오른·내린 종목</th><th>5일</th><th>시장 대비</th><th>미국장 영향</th><th class="l">연결된 미국 지표</th><th>분석 종목</th><th>평균 종합</th></tr></thead><tbody>${secs.map(s => {
      const m = S.data.stocks.filter(x => x.sector === s.name && x._sc); const avg = m.length ? m.reduce((a, x) => a + x._sc.total, 0) / m.length : null;
      const op = MKT.open.has(s.name);
      return `<tr data-sec="${esc(s.name)}" class="sec-row ${op ? 'open' : ''}"><td class="l"><b>${op ? '▾' : '▸'} ${esc(s.name)}</b></td><td class="mono ${cls(s.chg)}"><b>${pct(s.chg, 2)}</b></td><td class="mono"><span class="up">${s.up ?? '–'}</span> / <span class="down">${s.down ?? '–'}</span></td><td class="mono ${cls(s.ret5)}">${pct(s.ret5, 1)}</td><td class="mono ${cls(s.rel5)}">${pct(s.rel5, 1)}</td><td class="mono ${cls(s.us_impact)}">${pct(s.us_impact)}</td><td class="l">${esc(s.coupling || '')} <span class="muted">${(s.us_syms || []).join('+')}</span></td><td class="mono">${s.count}</td><td class="mono">${avg != null ? fmt(avg, 1) : '–'}</td></tr>`
        + (op ? `<tr class="sec-open"><td colspan="9">${memTable(s)}</td></tr>` : ''); }).join('')}</tbody>`
      : `<tbody><tr><td class="l">${MKT.st ? '업종 자료 수집 오류: ' + esc(MKT.st.msg || '') : '업종 실시간 자료를 불러오는 중…'}</td></tr></tbody>`;
    $$('#secTable tr[data-sec]').forEach(tr => tr.onclick = () => { const n = tr.dataset.sec; MKT.open.has(n) ? MKT.open.delete(n) : MKT.open.add(n); renderSectorLive(); });
    $$('#secTable [data-an]').forEach(el => el.onclick = e => { e.stopPropagation(); showAnalysis(el.dataset.an); });
    $$('#secTable [data-secall]').forEach(b => b.onclick = e => { e.stopPropagation(); MKT.all = b.dataset.secall; renderSectorLive(); });
    $$('#secTable [data-secsearch]').forEach(b => b.onclick = e => { e.stopPropagation(); S.conds = [{ f: 'sector', op: 'is', v: b.dataset.secsearch }]; drawConds(); switchTab('search'); runSearch(); });
  }
  // 미국장 영향이 큰 업종(+/−)과 대표 종목
  if ($('#usImpact')) {
    const ok = secs.filter(s => s.us_impact != null && s.count);
    const pos = ok.filter(s => s.us_impact > 0.05).sort((a, b) => b.us_impact - a.us_impact).slice(0, 4);
    const neg = ok.filter(s => s.us_impact < -0.05).sort((a, b) => a.us_impact - b.us_impact).slice(0, 4);
    const U = (MKT.d && MKT.d.us) || {};
    const drv = s => (s.us_syms || []).map(k => `${esc((S.usmap.us_symbols || {})[k] || k)} <b class="${cls((S.data.us_rets || {})[k])}">${pct((S.data.us_rets || {})[k])}</b>`).join(' · ');
    const chip = x => `<button class="mn-chip ${x.chg > 0 ? 'good' : x.chg < 0 ? 'bad' : ''}" data-an="${esc(x.code)}">${esc(x.name)} <small class="mono ${cls(x.chg)}">${pct(x.chg, 1)}</small></button>`;
    const box = (s, tone) => `<div class="usi-box ${tone}"><div class="usi-h"><b>${esc(s.name)}</b><span class="mono ${cls(s.us_impact)}">예상 ${pct(s.us_impact)}</span></div><div class="hint">${drv(s)} · ${esc(s.coupling || '')} · 오늘 업종 <b class="${cls(s.chg)}">${pct(s.chg, 2)}</b></div><div class="usi-chips">${mem(s.name).slice(0, 8).map(chip).join('')}</div></div>`;
    const fut = U.NQ ? `<div class="hint">오늘 밤 미국장 미리보기: 나스닥 선물 <b class="${cls(U.NQ.chg)}">${pct(U.NQ.chg)}</b>${U.ES ? ` · S&P 선물 <b class="${cls(U.ES.chg)}">${pct(U.ES.chg)}</b>` : ''} — 선물이 크게 움직이면 아래 업종들이 다음 날 같은 방향으로 반응하기 쉬워요.</div>` : '';
    $('#usImpact').innerHTML = ok.length ? `${fut}<div class="usi-grid">${pos.length ? `<div><h4 class="good-t">미국장 덕에 오를 쪽</h4>${pos.map(s => box(s, 'good')).join('')}</div>` : ''}${neg.length ? `<div><h4 class="bad-t">미국장 탓에 내릴 쪽</h4>${neg.map(s => box(s, 'bad')).join('')}</div>` : ''}${!pos.length && !neg.length ? '<div class="hint">지금은 미국장 영향이 뚜렷한 업종이 없어요(미국 지표 변동이 작음).</div>' : ''}</div>
      <div class="hint mt-s">'예상 영향' = 연결된 미국 지표의 전날(마지막 거래일) 등락 × 민감도. 표의 업종 줄을 누르면 그 업종 모든 종목의 오늘 반응(업종 대비 강·약, 미국장과 같은 방향인지)을 볼 수 있어요.</div>`
      : '<div class="hint">업종·미국장 자료를 불러오는 중…</div>';
    $$('#usImpact [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
  }
  if ($('#secStatus')) $('#secStatus').innerHTML = MKT.d ? `<span class="gov-live"></span> 업종 등락 ${esc(MKT.d.meta.time.slice(11))} · ${secs.length && secs[0].own ? `거래소 업종 ${secs.length}개 — 등락은 분석 종목 실시간 시세의 시가총액 가중 평균` : `네이버 금융 업종 ${secs.length}개`} · 업종 줄을 누르면 종목 목록이 펼쳐져요` : '';
  const ur = S.data.us_rets || {}, names = { ...(S.usmap.us_symbols || {}) };
  if ($('#mapTable')) $('#mapTable').innerHTML = `<thead><tr><th class="l">국내 업종 묶음</th><th class="l">미국 지표 × 민감도</th><th class="l">결합도</th><th>지금 영향</th></tr></thead><tbody>${S.usmap.map.map(m => {
    const v = m.us.reduce((a, u) => a + (ur[u.sym] ?? 0) * u.beta, 0);
    return `<tr><td class="l">${esc(m.sector)}</td><td class="l">${m.us.map(u => `${esc(names[u.sym] || u.sym)} <span class="mono">×${u.beta}</span> <span class="mono ${cls(ur[u.sym])}">(${pct(ur[u.sym])})</span>`).join('<br>')}</td><td class="l">${esc(m.coupling)}</td><td class="mono ${cls(v)}">${pct(v)}</td></tr>`; }).join('')}</tbody>`;
}
function initMarket() { mktLoad(); setInterval(mktLoad, 180e3); }
(function waitBootMkt() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc && S.usmap) initMarket();
  else setTimeout(waitBootMkt, 500);
})();
