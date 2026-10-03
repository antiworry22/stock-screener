/* 매매 참고 스크리너 — 화면 로직
   점수 계산 scoreStock() 은 pipeline/scoring.py 와 같은 규칙입니다. */
'use strict';

const S = {
  data: null, cfg: null, usmap: null, bt: null,
  mode: 'balanced', weights: null, th: null, capital: 30000000,
  conds: [], logic: 'AND', sortKey: 'total', limit: 50, lastResult: [],
  allSort: { key: 'total', asc: false }, resSort: null,
};
const GROUPS = { technical: '지표', supply: '수급', earnings: '실적·호재', sector: '섹터·미국장', stability: '안정성' };
const store = {
  get(k, d) { try { const v = localStorage.getItem('scr_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('scr_' + k, JSON.stringify(v)); } catch (e) {} },
};
const $ = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => [...el.querySelectorAll(q)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (v, d = 2) => v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, d)}%`;
const cls = v => v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';
const sCls = v => v == null ? 's-lo' : v >= 65 ? 's-hi' : v >= 45 ? 's-mid' : 's-lo';
const won = v => v == null ? '–' : Math.abs(v) >= 1e8 ? fmt(v / 1e8, 1) + '억' : fmt(v) + '원';

/* ═════════════ 로드 ═════════════ */
async function getJSON(url) {
  const r = await fetch(url + '?v=' + Date.now());
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}
async function boot() {
  try {
    const [cfg, usmap, data] = await Promise.all([getJSON('config/weights.json'), getJSON('config/us_sector_map.json'), getJSON('data/latest.json')]);
    S.cfg = cfg; S.usmap = usmap; S.data = data;
  } catch (e) {
    $('#asofLine').textContent = '데이터를 불러오지 못했습니다: ' + e.message;
    return;
  }
  try { S.bt = await getJSON('data/backtest.json'); } catch (e) { S.bt = null; }
  const saved = store.get('settings', {});
  const custom = store.get('customMode', null);
  if (custom) S.cfg.modes.custom = custom;
  S.mode = saved.mode && S.cfg.modes[saved.mode] ? saved.mode : S.cfg.default_mode;
  S.weights = { ...S.cfg.modes[S.mode].weights };
  S.th = { ...S.cfg.thresholds, ...(saved.th || {}) };
  S.capital = saved.capital || 30000000;
  S.conds = store.get('conds', []);
  S.logic = store.get('logic', 'AND');
  initTheme(); initTabs(); initModeSel(); initSearch(); initSettings(); initAllTable(); initExtra();
  refresh();
  if (S.conds.length) runSearch();
}
function persist() { store.set('settings', { mode: S.mode, th: S.th, capital: S.capital }); }

/* ═════════════ 점수 ═════════════ */
function scoreStock(s) {
  const T = S.th, P = {};
  const add = (g, p, m) => { P[g] = P[g] || [0, 0]; P[g][0] += p; P[g][1] += m; };
  const dartOn = !!S.data.meta.dart;
  const n = v => v != null;
  // 지표
  if (n(s.vol_ratio)) { const vr = s.vol_ratio, ch = s.chg || 0; add('technical', vr >= T.volume_ratio && ch > 0 ? 20 : vr >= 1.5 && ch > 0 ? 12 : vr < 0.7 && ch > 0 ? 8 : 0, 20); }
  if (n(s.tech3)) add('technical', s.tech3 * 10, 30);
  if (n(s.sr20)) add('technical', s.ma_align ? 25 : s.sr20 === '지지' && (s.ma20_slope || 0) > 0 ? 15 : s.sr20 === '지지' ? 8 : s.sr20 === '저항' ? 0 : 3, 25);
  if (n(s.pos52)) { const lt = s.low_tests || 0; add('technical', s.pos52 < T.pos52_undervalued && lt >= T.low_tests ? 25 : s.pos52 < T.pos52_undervalued ? 12 : s.pos52 >= 0.95 && s.ma_align ? 18 : 6, 25); }
  if (n(s.rsi) && s.rsi > T.rsi_overbought + 5 && P.technical) P.technical[0] = Math.max(0, P.technical[0] - 10);
  // 수급
  const sp = (v, full) => { if (!n(v)) return null; const d = T.streak_days; return v >= d ? full : v >= 3 ? Math.round(full * .66) : v >= 1 ? Math.round(full * .33) : v <= -d ? 0 : Math.round(full * .15); };
  [['foreign_streak', 30], ['inst_streak', 25]].forEach(([k, f]) => { const p = sp(s[k], f); if (p != null) add('supply', p, f); });
  if (n(s.pension_net5) || s.pension_5pct) add('supply', s.pension_5pct ? 20 : ((s.pension_streak || 0) >= 3 || (s.pension_net5 || 0) > 0) ? 12 : (s.pension_net5 || 0) < 0 ? 0 : 4, 20);
  if (n(s.exhaustion)) add('supply', s.exhaustion >= T.exhaustion_limit ? 0 : 10, 10);
  if (n(s.short_ratio)) add('supply', (s.short_chg || 0) > .3 ? 0 : s.short_ratio > 5 ? 4 : 15, 15);
  // 실적·호재
  if (n(s.op_yoy) || s.op_turn) add('earnings', s.op_turn || (s.op_yoy || 0) >= T.yoy_growth ? 30 : (s.op_yoy || 0) > 0 ? 15 : 0, 30);
  if (n(s.sales_yoy)) add('earnings', s.sales_yoy >= T.yoy_growth ? 20 : s.sales_yoy > 0 ? 10 : 0, 20);
  if (n(s.upside)) add('earnings', s.upside >= T.upside_min ? 20 : s.upside >= 15 ? 10 : 3, 20);
  if (n(s.news_score)) add('earnings', Math.round((s.news_score + 1) / 2 * 15), 15);
  if (dartOn) add('earnings', (s.disc_neg || 0) > 0 ? 0 : (s.disc_pos || 0) > 0 ? 15 : 8, 15);
  if ((s.roe3 || []).length >= 3) add('earnings', s.roe3.every(r => (r || 0) >= T.roe_min) ? 10 : 3, 10);
  // 섹터·미국장
  if (n(s.sector_rel5)) add('sector', Math.max(0, Math.min(50, 25 + s.sector_rel5 * 5)), 50);
  if (n(s.us_impact)) add('sector', 25 + Math.max(-25, Math.min(25, s.us_impact * 10)), 50);
  // 안정성
  if (n(s.debt_ratio)) add('stability', s.debt_ratio <= T.debt_ratio_max ? 25 : s.debt_ratio <= 200 ? 10 : 0, 25);
  if (n(s.current_ratio)) add('stability', s.current_ratio >= T.current_ratio_min ? 25 : s.current_ratio >= 70 ? 10 : 0, 25);
  if (n(s.ocf)) add('stability', s.ocf > 0 ? 25 : 0, 25);
  if (n(s.profit_q) && dartOn) add('stability', s.profit_q >= 4 ? 25 : s.profit_q === 3 ? 15 : s.profit_q >= 1 ? 5 : 0, 25);

  const sub = {};
  Object.keys(GROUPS).forEach(k => { sub[k] = P[k] && P[k][1] ? Math.round(P[k][0] / P[k][1] * 100) : null; });
  const W = S.weights, wsum = Object.values(W).reduce((a, b) => a + b, 0) || 1;
  const gm = gateMult();
  sub.total = Math.round(Object.keys(W).reduce((a, k) => a + W[k] * (sub[k] ?? 50), 0) / wsum * gm * 10) / 10;
  return sub;
}
function gateMult() {
  const g = S.data.gate || {}, mg = S.cfg.macro_gate;
  return g.level === 'red' ? mg.multiplier_red : g.level === 'yellow' ? mg.multiplier_yellow : 1;
}
function banReasons(s) {
  const r = [];
  if ((s.foreign_streak || 0) <= -3 && (s.inst_streak || 0) <= -3) r.push('외국인·기관 동반 3일+ 순매도');
  if (s.sr20 === '저항' && (s.foreign_net5 || 0) < 0 && (s.inst_net5 || 0) < 0) r.push('20일선 저항 + 수급 이탈');
  if ((s.short_chg || 0) > .5) r.push('공매도 잔고 급증');
  if ((s.disc_neg || 0) > 0) r.push('악재 공시');
  if ((s.debt_ratio || 0) > 300) r.push('부채비율 300%↑');
  if (s.sr120 === '저항' && s.sr20 === '저항') r.push('20·120일선 동시 저항');
  return r;
}
function riskCalc(s, entry) {
  entry = entry || s.close;
  const atr = s.atr || entry * .03;
  const stop = Math.max(1, Math.round(entry - atr * S.th.atr_mult));
  const per = entry - stop;
  const riskWon = S.capital * S.th.risk_pct / 100;
  const qty = per > 0 ? Math.floor(riskWon / per) : 0;
  const cap = Math.min(qty, Math.floor(S.capital / entry));
  return { entry, stop, per, qty: cap, amount: cap * entry, riskWon, stopPct: -per / entry * 100, t2r: Math.round(entry + per * 2) };
}
function refresh() {
  S.data.stocks.forEach(s => { s._sc = scoreStock(s); s._ban = banReasons(s); });
  const wl = new Set(whitelist()); S.data.stocks.forEach(s => { s._white = wl.has(s); });
  renderHeader(); renderDash(); renderAll(); renderSector(); renderBT(); renderGuide(); renderRecs(); renderNews();
  if (S.lastResult.length || S.conds.length) runSearch(true);
}

/* ═════════════ 헤더·대시보드 ═════════════ */
function renderHeader() {
  const m = S.data.meta;
  $('#asofLine').textContent = `기준일 ${m.asof} · 생성 ${m.generated} · ${fmt(m.universe)}종목 · 모드 ${S.cfg.modes[S.mode].label}`;
  $('#sampleBanner').classList.toggle('hidden', !m.sample);
  const g = S.data.gate || { level: 'green', reasons: [] };
  const gb = $('#gateBanner');
  gb.className = 'banner ' + g.level;
  const lab = { green: '매크로 게이트 정상', yellow: '매크로 게이트 주의 (점수 ×' + S.cfg.macro_gate.multiplier_yellow + ')', red: '매크로 게이트 경고 — 신규 매수 보수적 (점수 ×' + S.cfg.macro_gate.multiplier_red + ')' }[g.level];
  gb.innerHTML = `<b>${lab}</b> · ${esc(g.reasons.join(' / '))}`;
  $$('.topN').forEach(e => e.textContent = S.cfg.outputs.top_n);
}
function macroCard(k, o, kind) {
  if (!o) return `<div class="card"><div class="k">${k}</div><div class="v muted">–</div></div>`;
  const d = kind === 'bp' ? `<span class="${cls(o.chgbp)}">${o.chgbp > 0 ? '+' : ''}${fmt(o.chgbp, 1)}bp</span>` : `<span class="${cls(o.chg)}">${pct(o.chg)}</span>`;
  return `<div class="card"><div class="k">${k}</div><div class="v">${fmt(o.v, kind === 'bp' ? 2 : o.v > 100 ? 1 : 2)}</div><div class="d">${d}${o.chg20 != null ? ` <span class="muted">20일 ${pct(o.chg20, 1)}</span>` : ''}</div></div>`;
}
function renderDash() {
  const M = S.data.macro, g = S.data.gate || {};
  $('#macroCards').innerHTML =
    `<div class="card gate-${g.level}"><div class="k">매크로 게이트</div><div class="v">${{ green: '정상', yellow: '주의', red: '경고' }[g.level] || '–'}</div><div class="d muted">×${gateMult()}</div></div>` +
    macroCard('원/달러', M.usdkrw) + macroCard('미 10년물', M.us10y, 'bp') + macroCard('S&P500', M.sp500) + macroCard('나스닥', M.nasdaq) +
    macroCard('SOX(반도체)', M.sox) + macroCard('코스피', M.kospi) + macroCard('코스닥', M.kosdaq);

  const st = S.data.stocks, N = S.cfg.outputs.top_n;
  const supply = st.filter(s => !s._ban.length && (s._sc.supply ?? 0) >= 50 && ((s.foreign_streak || 0) > 0 || (s.inst_streak || 0) > 0 || s.pension_5pct))
    .sort((a, b) => (b._sc.supply - a._sc.supply) || (b._sc.total - a._sc.total)).slice(0, N);
  $('#listSupply').innerHTML = supply.length ? supply.map((s, i) => item(s, i, `
      ${s.foreign_streak > 0 ? `<span class="tag good">외 +${s.foreign_streak}일</span>` : ''}${s.inst_streak > 0 ? `<span class="tag good">기 +${s.inst_streak}일</span>` : ''}${s.pension_5pct ? '<span class="tag good">연기금5%</span>' : (s.pension_net5 > 0 ? '<span class="tag">연기금↑</span>' : '')}`,
    `<span class="score ${sCls(s._sc.supply)}">${s._sc.supply}</span>`)).join('') : '<div class="empty">조건을 만족하는 종목이 없습니다.</div>';

  const wl = whitelist();
  $('#wlHint').textContent = `종합 ${S.th.whitelist_min_score}+ · 20일선 지지 · 손절 ATR×${S.th.atr_mult}`;
  $('#listWhite').innerHTML = wl.length ? wl.slice(0, N).map((s, i) => { const r = riskCalc(s); return item(s, i,
    `<span class="tag">손절 ${fmt(r.stop)} (${fmt(r.stopPct, 1)}%)</span><span class="tag">${fmt(r.qty)}주</span>`,
    `<span class="score ${sCls(s._sc.total)}">${s._sc.total}</span>`); }).join('') : '<div class="empty">진입 기준을 만족하는 종목이 없습니다. (매크로 경고 시 점수가 낮아집니다)</div>';

  const ban = st.filter(s => s._ban.length).sort((a, b) => b._ban.length - a._ban.length || a._sc.total - b._sc.total).slice(0, N + 5);
  $('#listBan').innerHTML = ban.length ? ban.map((s, i) => item(s, i, s._ban.map(r => `<span class="tag bad">${r}</span>`).join(''), `<span class="${cls(s.chg)}">${pct(s.chg)}</span>`)).join('') : '<div class="empty">해당 없음</div>';

  const secs = (S.data.sectors || []).slice();
  const mx = Math.max(1, ...secs.map(s => Math.abs(s.rel5 || 0)));
  $('#sectorBars').innerHTML = secs.map(s => {
    const w = Math.abs(s.rel5 || 0) / mx * 50, pos = (s.rel5 || 0) >= 0;
    return `<div class="sb"><span>${esc(s.name)}</span><div class="bar"><span class="mid"></span><i style="${pos ? `left:50%;width:${w}%;background:var(--up)` : `right:50%;width:${w}%;background:var(--down)`}"></i></div><span class="num ${cls(s.rel5)}">${pct(s.rel5, 1)}</span></div>`;
  }).join('');
  bindItems();
}
function whitelist() {
  return S.data.stocks.filter(s => !s._ban.length && s._sc.total >= S.th.whitelist_min_score && s.sr20 === '지지' && (s._sc.stability == null || s._sc.stability >= 40))
    .sort((a, b) => b._sc.total - a._sc.total);
}
function item(s, i, tags, right) {
  return `<div class="item" data-code="${esc(s.code)}"><span class="rank">${i + 1}</span>
    <div class="nm"><b>${esc(s.name)}</b><small>${esc(s.sector)} · ${fmt(s.close)} <span class="${cls(s.chg)}">${pct(s.chg)}</span></small><div>${tags}</div></div>
    <div class="rt">${right}</div></div>`;
}
function bindItems(root = document) { $$('[data-code]', root).forEach(el => el.onclick = () => openDetail(el.dataset.code)); }

/* ═════════════ 조건검색 ═════════════ */
const F = [
  // [key, label, group, type, unit, getter?]
  ['total', '종합점수', '점수', 'num', '점', s => s._sc.total],
  ['technical', '지표 점수', '점수', 'num', '점', s => s._sc.technical],
  ['supply', '수급 점수', '점수', 'num', '점', s => s._sc.supply],
  ['earnings', '실적·호재 점수', '점수', 'num', '점', s => s._sc.earnings],
  ['sector_sc', '섹터·미국장 점수', '점수', 'num', '점', s => s._sc.sector],
  ['stability', '안정성 점수', '점수', 'num', '점', s => s._sc.stability],
  ['market', '시장', '기본', 'enum', '', null, ['KOSPI', 'KOSDAQ']],
  ['sector', '업종', '기본', 'enum', '', null, 'SECTORS'],
  ['mcap', '시가총액', '기본', 'num', '억원'],
  ['close', '종가', '기본', 'num', '원'],
  ['chg', '당일 등락률', '기본', 'num', '%'],
  ['ret5', '5일 수익률', '기본', 'num', '%'],
  ['ret20', '20일 수익률', '기본', 'num', '%'],
  ['vol_ratio', '① 거래량 ÷ 20일 평균', '① 거래량', 'num', '배'],
  ['tv_ratio', '① 거래대금 ÷ 20일 평균', '① 거래량', 'num', '배'],
  ['tvalue', '① 거래대금', '① 거래량', 'num', '억원'],
  ['rsi', '② RSI(14)', '② 기술분석', 'num', ''],
  ['tech3', '② 기술 3종 겹침 수', '② 기술분석', 'num', '개'],
  ['sig_rsi', '② RSI 과매도/반등', '② 기술분석', 'bool'],
  ['sig_macd', '② MACD 시그널 상향(5일 내)', '② 기술분석', 'bool'],
  ['sig_bb', '② 볼린저 하단 접근 후 회복', '② 기술분석', 'bool'],
  ['bb_pb', '② 볼린저 %b', '② 기술분석', 'num', ''],
  ['op_yoy', '③ 영업이익 YoY', '③ 실적', 'num', '%'],
  ['sales_yoy', '③ 매출 YoY', '③ 실적', 'num', '%'],
  ['op_turn', '③ 흑자전환', '③ 실적', 'bool'],
  ['earn_recent', '③ 30일 내 실적발표', '③ 실적', 'bool', '', s => s.earn_date ? daysAgo(s.earn_date) <= 30 : null],
  ['news_score', '④ 뉴스 감정점수(-1~1)', '④ 뉴스·공시', 'num', ''],
  ['disc_pos', '④ 호재 공시(30일)', '④ 뉴스·공시', 'bool', '', s => s.disc_pos == null ? null : s.disc_pos > 0],
  ['disc_neg', '④ 악재 공시(30일)', '④ 뉴스·공시', 'bool', '', s => s.disc_neg == null ? null : s.disc_neg > 0],
  ['pos52', '⑤ 52주 고점 대비 위치', '⑤ 차트', 'num', '배'],
  ['low_tests', '⑤ 6개월 저점 터치 횟수', '⑤ 차트', 'num', '회'],
  ['pension_5pct', '⑥ 국민연금 5% 대량보유 공시', '⑥ 연기금', 'bool'],
  ['pension_streak', '⑥ 연기금 연속 순매수일', '⑥ 연기금', 'num', '일'],
  ['pension_net5', '⑥ 연기금 5일 순매수', '⑥ 연기금', 'num', '억원'],
  ['foreign_streak', '⑦ 외국인 연속 순매수일(−는 매도)', '⑦ 외국인·기관', 'num', '일'],
  ['foreign_net5', '⑦ 외국인 5일 순매수', '⑦ 외국인·기관', 'num', '억원'],
  ['inst_streak', '⑦ 기관 연속 순매수일', '⑦ 외국인·기관', 'num', '일'],
  ['inst_net5', '⑦ 기관 5일 순매수', '⑦ 외국인·기관', 'num', '억원'],
  ['foreign_hold', '⑦ 외국인 지분율', '⑦ 외국인·기관', 'num', '%'],
  ['exhaustion', '⑦ 외국인 한도소진율', '⑦ 외국인·기관', 'num', '%'],
  ['debt_ratio', '⑧ 부채비율', '⑧ 재무안정성', 'num', '%'],
  ['current_ratio', '⑧ 유동비율', '⑧ 재무안정성', 'num', '%'],
  ['ocf', '⑧ 영업현금흐름', '⑧ 재무안정성', 'num', '억원'],
  ['profit_q', '⑧ 최근 4분기 흑자 수', '⑧ 재무안정성', 'num', '분기'],
  ['ma_align', '⑨ 5·20·120일 정배열 상향', '⑨ 지지선', 'bool'],
  ['sr5', '⑨ 5일선', '⑨ 지지선', 'enum', '', null, ['지지', '저항', '이탈']],
  ['sr20', '⑨ 20일선', '⑨ 지지선', 'enum', '', null, ['지지', '저항', '이탈']],
  ['sr120', '⑨ 120일선', '⑨ 지지선', 'enum', '', null, ['지지', '저항', '이탈']],
  ['roe_ok', '⑩ ROE 3년 연속 기준 이상', '⑩ 장기전망', 'bool', '', s => (s.roe3 || []).length >= 3 ? s.roe3.every(r => (r || 0) >= S.th.roe_min) : null],
  ['sector_rel5', '⑪ 업종 5일 상대강도(코스피 대비)', '⑪ 섹터', 'num', '%p'],
  ['m60_up', '⑫ 60분봉 상승', '⑫ 타임프레임', 'bool', '', s => s.m60_trend == null ? null : s.m60_trend === '상승'],
  ['absorb', '⑫ 분봉 매도 흡수', '⑫ 타임프레임', 'bool'],
  ['upside', '⑬ 목표주가 상승여력', '⑬ 상승여력', 'num', '%'],
  ['has_target', '⑬ 컨센서스 존재', '⑬ 상승여력', 'bool', '', s => s.upside != null],
  ['us_impact', '⑭ 미국장 영향(섹터 매핑)', '⑭ 미국장', 'num', '%'],
  ['short_ratio', '+ 공매도 잔고 비중', '+ 보완', 'num', '%'],
  ['short_chg', '+ 공매도 잔고 5일 변화', '+ 보완', 'num', '%p'],
  ['atr_pct', '+ ATR(변동성)/주가', '+ 보완', 'num', '%'],
  ['banned', '+ 매수 금지 해당', '+ 보완', 'bool', '', s => s._ban.length > 0],
  ['white', '+ 화이트리스트 해당', '+ 보완', 'bool', '', s => !!s._white],
];
const FM = Object.fromEntries(F.map(f => [f[0], { key: f[0], label: f[1], group: f[2], type: f[3], unit: f[4] || '', get: f[5] || (s => s[f[0]]), opts: f[6] }]));
function daysAgo(ymd) { const d = new Date(ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8)); return (new Date(S.data.meta.asof) - d) / 864e5; }

const PRESETS = () => {
  const T = S.th;
  return [
    ['① 거래량 급증+상승', [['vol_ratio', '>=', T.volume_ratio], ['chg', '>', 0]]],
    ['② 기술 3종 겹침', [['tech3', '>=', 2]]],
    ['③ 실적 서프라이즈', [['op_yoy', '>=', T.yoy_growth], ['sales_yoy', '>=', T.yoy_growth]]],
    ['④ 호재 공시·뉴스', [['disc_pos', 'is', true], ['disc_neg', 'is', false]]],
    ['⑤ 저평가 매물대', [['pos52', '<', T.pos52_undervalued], ['low_tests', '>=', T.low_tests]]],
    ['⑥ 연기금 매집', [['pension_net5', '>', 0], ['pension_streak', '>=', 2]]],
    ['⑦ 외국인 5일 연속', [['foreign_streak', '>=', T.streak_days], ['exhaustion', '<', T.exhaustion_limit]]],
    ['⑧ 재무 우량', [['debt_ratio', '<=', T.debt_ratio_max], ['current_ratio', '>=', T.current_ratio_min], ['ocf', '>', 0]]],
    ['⑨ 정배열 강세', [['ma_align', 'is', true]]],
    ['⑩ ROE 장기우량', [['roe_ok', 'is', true]]],
    ['⑪ 주도 섹터', [['sector_rel5', '>', 0], ['total', '>=', 55]]],
    ['⑬ 상승여력 30%+', [['upside', '>=', T.upside_min]]],
    ['⑭ 반도체·미장 강결합', [['us_impact', '>=', 1]]],
    ['수급+기술 스윙', [['foreign_streak', '>=', 3], ['inst_streak', '>=', 1], ['tech3', '>=', 1], ['sr20', 'is', '지지'], ['banned', 'is', false]]],
    ['눌림목 매수', [['ma_align', 'is', true], ['rsi', 'between', 40, 60], ['ret5', '<', 0]]],
  ];
};

function initSearch() {
  const box = $('#presetBox');
  drawPresets();
  box.onclick = e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const i = +b.dataset.p, tag = 'p' + i;
    if (S.conds.some(c => c.src === tag)) {
      S.conds = S.conds.filter(c => c.src !== tag);  // 다시 누르면 해제
    } else {
      PRESETS()[i][1].forEach(c => S.conds.push({ f: c[0], op: c[1], v: c[2], v2: c[3], src: tag }));  // 누를 때마다 추가(중복 선택)
    }
    drawConds(); runSearch();
  };
  $('#addCond').onclick = () => { S.conds.push({ f: 'total', op: '>=', v: 60 }); drawConds(); };
  $('#clearCond').onclick = () => { S.conds = []; $('#nlqResult').innerHTML = ''; drawConds(); runSearch(); };
  initNlq();
  $('#runSearch').onclick = () => runSearch();
  $$('input[name=logic]').forEach(r => { r.checked = r.value === S.logic; r.onchange = () => { S.logic = r.value; store.set('logic', S.logic); }; });
  const sortOpts = F.filter(f => f[3] === 'num');
  $('#sortSel').innerHTML = sortOpts.map(f => `<option value="${f[0]}">${f[1]}</option>`).join('');
  $('#sortSel').value = 'total';
  $('#sortSel').onchange = e => { S.sortKey = e.target.value; S.resSort = null; runSearch(true); };
  $('#limitSel').onchange = e => { S.limit = +e.target.value; runSearch(true); };
  $('#csvBtn').onclick = () => exportCSV(S.lastResult, '조건검색');
  $('#printBtn').onclick = () => { $('#printHead').innerHTML = `<h2>조건검색 리포트</h2><div>기준일 ${S.data.meta.asof} · 모드 ${esc(S.cfg.modes[S.mode].label)} · ${S.lastResult.length}종목</div>`; window.print(); };
  $('#saveCond').onclick = () => {
    if (!S.conds.length) return;
    const name = prompt('조건 이름을 입력하세요', '내 조건 ' + (store.get('saved', []).length + 1));
    if (!name) return;
    const sv = store.get('saved', []); sv.push({ name, conds: S.conds, logic: S.logic }); store.set('saved', sv); drawSaved();
  };
  drawSaved(); drawConds();
}
function drawPresets() {
  const on = new Set(S.conds.map(c => c.src).filter(Boolean));
  $('#presetBox').innerHTML = PRESETS().map((p, i) => `<button class="chip ${on.has('p' + i) ? 'on' : ''}" data-p="${i}">${on.has('p' + i) ? '✓ ' : ''}${p[0]}</button>`).join('');
  const n = on.size;
  $('#presetCount').textContent = n ? `${n}개 선택됨 · 다시 누르면 해제` : '여러 개 눌러 겹쳐 쓸 수 있어요';
}
function drawSaved() {
  const sv = store.get('saved', []);
  $('#savedBox').innerHTML = sv.length ? sv.map((x, i) => `<button class="chip" data-s="${i}">${esc(x.name)}<span class="del" data-d="${i}">×</span></button>`).join('') : '<span class="hint">없음</span>';
  $('#savedBox').onclick = e => {
    const d = e.target.closest('[data-d]');
    if (d) { e.stopPropagation(); const sv = store.get('saved', []); sv.splice(+d.dataset.d, 1); store.set('saved', sv); drawSaved(); return; }
    const b = e.target.closest('[data-s]'); if (!b) return;
    const x = store.get('saved', [])[+b.dataset.s]; S.conds = x.conds; S.logic = x.logic;
    $$('input[name=logic]').forEach(r => r.checked = r.value === S.logic); drawConds(); runSearch();
  };
}
function fieldOptions(sel) {
  const groups = [...new Set(F.map(f => f[2]))];
  return groups.map(g => `<optgroup label="${g}">${F.filter(f => f[2] === g).map(f => `<option value="${f[0]}" ${f[0] === sel ? 'selected' : ''}>${f[1]}</option>`).join('')}</optgroup>`).join('');
}
function enumOpts(fd) {
  if (fd.opts === 'SECTORS') return [...new Set(S.data.stocks.map(s => s.sector))].sort();
  return fd.opts || [];
}
function drawConds() {
  store.set('conds', S.conds);
  if ($('#presetBox')) drawPresets();
  const wrap = $('#condRows');
  if (!S.conds.length) { wrap.innerHTML = '<div class="empty">빠른 조건을 누르거나 “+ 조건 추가”로 직접 조건을 만드세요. 예) 외국인 연속 순매수일 ≥ 3 그리고 RSI ≤ 40</div>'; return; }
  wrap.innerHTML = S.conds.map((c, i) => {
    const fd = FM[c.f] || FM.total;
    let ops, val;
    if (fd.type === 'num') {
      ops = [['>=', '이상 ≥'], ['<=', '이하 ≤'], ['>', '초과 >'], ['<', '미만 <'], ['=', '같음 ='], ['between', '사이']];
      val = `<input class="inp v" type="number" step="any" value="${c.v ?? ''}" placeholder="값 ${fd.unit}">` +
        (c.op === 'between' ? `<input class="inp v2" type="number" step="any" value="${c.v2 ?? ''}" placeholder="~ 값">` : `<span class="unit">${fd.unit}</span>`);
    } else if (fd.type === 'bool') {
      ops = [['is', '해당']];
      val = `<select class="v"><option value="true" ${c.v !== false && c.v !== 'false' ? 'selected' : ''}>예</option><option value="false" ${c.v === false || c.v === 'false' ? 'selected' : ''}>아니오</option></select><span></span>`;
    } else {
      ops = [['is', '같음'], ['not', '제외'], ['has', '포함']];
      val = c.op === 'has'
        ? `<input class="inp v" type="text" value="${esc(c.v ?? '')}" placeholder="예) 전기|제약"><span class="unit">글자 포함</span>`
        : `<select class="v">${enumOpts(fd).map(o => `<option ${o === c.v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select><span></span>`;
    }
    return `<div class="cond" data-i="${i}"><span class="no">${i + 1}</span>
      <select class="f">${fieldOptions(c.f)}</select>
      <select class="op">${ops.map(o => `<option value="${o[0]}" ${o[0] === c.op ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>
      ${val}<button class="rm" title="삭제">×</button></div>`;
  }).join('');
  $$('.cond', wrap).forEach(row => {
    const i = +row.dataset.i, c = S.conds[i];
    $('.f', row).onchange = e => { const fd = FM[e.target.value]; c.f = e.target.value; c.op = fd.type === 'num' ? '>=' : 'is'; c.v = fd.type === 'bool' ? true : fd.type === 'enum' ? enumOpts(fd)[0] : ''; c.v2 = undefined; drawConds(); };
    $('.op', row).onchange = e => { c.op = e.target.value; drawConds(); };
    const v = $('.v', row); if (v) v.oninput = v.onchange = e => { const fd = FM[c.f]; c.v = fd.type === 'num' ? (e.target.value === '' ? '' : +e.target.value) : fd.type === 'bool' ? e.target.value === 'true' : e.target.value; store.set('conds', S.conds); };
    const v2 = $('.v2', row); if (v2) v2.oninput = e => { c.v2 = e.target.value === '' ? '' : +e.target.value; store.set('conds', S.conds); };
    $('.rm', row).onclick = () => { S.conds.splice(i, 1); drawConds(); };
  });
}
function test(s, c) {
  const fd = FM[c.f]; if (!fd) return true;
  const x = fd.get(s);
  if (x == null) return false;  // 데이터 없는 종목(예: 컨센서스 부재)은 제외
  if (fd.type === 'bool') return !!x === (c.v === true || c.v === 'true');
  if (fd.type === 'enum') {
    if (c.op === 'has') return String(c.v || '').split('|').filter(Boolean).some(t => String(x).includes(t));
    return c.op === 'not' ? x !== c.v : x === c.v;
  }
  if (c.v === '' || c.v == null) return true;
  switch (c.op) {
    case '>=': return x >= c.v; case '<=': return x <= c.v; case '>': return x > c.v; case '<': return x < c.v;
    case '=': return Math.abs(x - c.v) < 1e-9;
    case 'between': return c.v2 === '' || c.v2 == null ? x >= c.v : x >= Math.min(c.v, c.v2) && x <= Math.max(c.v, c.v2);
  }
  return true;
}
function condText(c) {
  const fd = FM[c.f]; if (!fd) return '';
  const opT = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '=': '=', is: '=', not: '≠', has: '포함' }[c.op];
  if (c.op === 'has') return `${fd.label}: ${String(c.v).split('|').join(' 또는 ')} 포함`;
  if (fd.type === 'bool') return `${fd.label} ${c.v === true || c.v === 'true' ? '예' : '아니오'}`;
  if (c.op === 'between') return `${fd.label} ${c.v}~${c.v2}${fd.unit}`;
  return `${fd.label} ${opT} ${c.v}${fd.type === 'num' ? fd.unit : ''}`;
}
function runSearch(silent) {
  const st = S.data.stocks;
  const active = S.conds.filter(c => FM[c.f]);
  let res = active.length ? st.filter(s => S.logic === 'AND' ? active.every(c => test(s, c)) : active.some(c => test(s, c))) : [];
  const key = S.resSort?.key || S.sortKey, asc = S.resSort?.asc || false;
  const g = FM[key]?.get || (s => s[key]);
  res.sort((a, b) => { const x = g(a), y = g(b); if (x == null) return 1; if (y == null) return -1; return asc ? x - y : y - x; });
  const total = res.length;
  S.lastTotal = total;
  res = res.slice(0, S.limit);
  S.lastResult = res;
  $('#resCount').textContent = active.length ? `${total}종목${total > res.length ? ` 중 ${res.length}` : ''}` : '';
  $('#condSummary').innerHTML = active.length ? `조건(${S.logic === 'AND' ? '모두 만족' : '하나라도'}): ` + active.map(c => `<span class="tag">${esc(condText(c))}</span>`).join('') : '';
  const extra = [...new Set(active.map(c => c.f))].filter(k => !['total', 'technical', 'supply', 'earnings', 'sector_sc', 'stability'].includes(k));
  if (extra.includes('rec')) extra.push('rec_why');
  drawResultTable(res, extra, active.length);
  if (!silent && active.length) $('#resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function drawResultTable(res, extra, hasCond) {
  const t = $('#resTable');
  if (!hasCond) { t.innerHTML = '<tbody><tr><td class="l empty">조건을 입력하고 검색을 실행하세요.</td></tr></tbody>'; return; }
  if (!res.length) { t.innerHTML = '<tbody><tr><td class="l empty">조건에 부합하는 종목이 없습니다. 기준을 조금 완화해 보세요.</td></tr></tbody>'; return; }
  const base = ['name', 'sector', 'close', 'chg', 'total', 'technical', 'supply', 'earnings', 'sector_sc', 'stability'];
  const recCols = extra.includes('rec') ? [['rec', '추천점수'], ['rec_why', '추천 이유', 'l']] : [];
  const ex = extra.filter(k => !base.includes(k) && k !== 'rec' && k !== 'rec_why');
  const cols = [['name', '종목', 'l'], ...recCols, ['sector', '업종', 'l'], ['close', '종가'], ['chg', '등락'], ['total', '종합'], ['technical', '지표'], ['supply', '수급'], ['earnings', '실적'], ['sector_sc', '섹터'], ['stability', '안정'],
    ...ex.map(k => [k, FM[k].label.replace(/^[①-⑭+] /, '')]), ['stop', '손절가'], ['qty', '수량']];
  t.innerHTML = `<thead><tr>${cols.map(c => thHtml(c, S.resSort)).join('')}</tr></thead>
  <tbody>${res.map(s => { const r = riskCalc(s); return `<tr data-code="${esc(s.code)}">${cols.map(c => `<td class="${c[2] || ''}">${cellVal(s, c[0], r)}</td>`).join('')}</tr>`; }).join('')}</tbody>`;
  $$('th', t).forEach(th => th.onclick = () => { const k = th.dataset.k; if (['name', 'sector', 'stop', 'qty', 'rec_why'].includes(k)) return;
    S.resSort = { key: k, asc: S.resSort?.key === k ? !S.resSort.asc : false }; runSearch(true); });
  bindItems(t);
}
function cellVal(s, k, r) {
  const sc = s._sc;
  switch (k) {
    case 'name': return `<b>${esc(s.name)}</b> <span class="muted mono">${esc(s.code)}</span>${s._ban.length ? ' <span class="tag bad">금지</span>' : ''}`;
    case 'sector': return esc(s.sector);
    case 'close': return `<span class="mono">${fmt(s.close)}</span>`;
    case 'chg': return `<span class="mono ${cls(s.chg)}">${pct(s.chg)}</span>`;
    case 'total': return `<span class="score ${sCls(sc.total)}">${fmt(sc.total, 1)}</span>`;
    case 'technical': case 'supply': case 'earnings': case 'stability': return `<span class="mono">${sc[k] ?? '–'}</span>`;
    case 'sector_sc': return `<span class="mono">${sc.sector ?? '–'}</span>`;
    case 'stop': return `<span class="mono">${fmt(r.stop)}</span>`;
    case 'qty': return `<span class="mono">${fmt(r.qty)}</span>`;
  }
  const fd = FM[k]; const v = fd ? fd.get(s) : s[k];
  if (v == null) return '<span class="muted">–</span>';
  if (fd?.type === 'bool') return v ? '<span class="ok">✓</span>' : '<span class="muted">·</span>';
  if (fd?.type === 'text') return `<span class="why">${esc(v)}</span>`;
  if (typeof v === 'number') return `<span class="mono ${['chg', 'ret5', 'ret20', 'op_yoy', 'sales_yoy', 'foreign_streak', 'inst_streak', 'pension_streak', 'foreign_net5', 'inst_net5', 'pension_net5', 'us_impact', 'sector_rel5'].includes(k) ? cls(v) : ''}">${fmt(v, Math.abs(v) < 10 && !Number.isInteger(v) ? 2 : Number.isInteger(v) ? 0 : 1)}</span>`;
  return esc(v);
}
function exportCSV(rows, name) {
  if (!rows.length) return;
  const keys = ['code', 'name', 'market', 'sector', 'close', 'chg', 'total', 'technical', 'supply', 'earnings', 'sector_sc', 'stability', 'banned', 'stop', 'qty',
    'vol_ratio', 'tvalue', 'rsi', 'tech3', 'macd_above', 'bb_pb', 'sr5', 'sr20', 'sr120', 'ma_align', 'pos52', 'low_tests', 'foreign_streak', 'foreign_net5', 'inst_streak', 'inst_net5',
    'pension_streak', 'pension_net5', 'pension_5pct', 'foreign_hold', 'exhaustion', 'short_ratio', 'short_chg', 'sales_yoy', 'op_yoy', 'debt_ratio', 'current_ratio', 'ocf', 'profit_q',
    'upside', 'news_score', 'sector_rel5', 'us_impact', 'atr'];
  const lab = k => ({ code: '코드', name: '종목명', market: '시장', stop: '손절가', qty: '권장수량', banned: '매수금지사유', atr: 'ATR', macd_above: 'MACD>시그널' }[k] || FM[k]?.label || k);
  const val = (s, k) => {
    if (['total', 'technical', 'supply', 'earnings', 'stability'].includes(k)) return s._sc[k];
    if (k === 'sector_sc') return s._sc.sector;
    if (k === 'banned') return s._ban.join(' / ');
    if (k === 'stop' || k === 'qty') return riskCalc(s)[k];
    return s[k];
  };
  const q = v => { if (v == null) return ''; const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = '﻿' + [keys.map(lab).map(q).join(','), ...rows.map(s => keys.map(k => q(val(s, k))).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}_${S.data.meta.asof}.csv`; a.click();
}

/* ═════════════ 전체 종목 ═════════════ */
function initAllTable() { $('#allQ').oninput = renderAll; $('#allCsv').onclick = () => exportCSV(allRows(), '전체종목'); }
function allRows() {
  const q = ($('#allQ').value || '').trim();
  let rows = S.data.stocks.filter(s => !q || s.name.includes(q) || s.code.includes(q) || (s.sector || '').includes(q));
  const k = S.allSort.key, g = FM[k]?.get || (s => s[k]);
  return rows.sort((a, b) => { const x = g(a), y = g(b); if (x == null) return 1; if (y == null) return -1; return S.allSort.asc ? x - y : y - x; });
}
function renderAll() {
  const rows = allRows();
  const cols = [['name', '종목', 'l'], ['sector', '업종', 'l'], ['close', '종가'], ['chg', '등락'], ['total', '종합'], ['technical', '지표'], ['supply', '수급'], ['earnings', '실적'], ['sector_sc', '섹터'], ['stability', '안정'],
    ['vol_ratio', '거래량배수'], ['rsi', 'RSI'], ['tech3', '3종'], ['pos52', '52주위치'], ['foreign_streak', '외국인'], ['inst_streak', '기관'], ['op_yoy', '영업익YoY'], ['upside', '상승여력']];
  const t = $('#allTable');
  t.innerHTML = `<thead><tr>${cols.map(c => thHtml(c, S.allSort)).join('')}</tr></thead>
    <tbody>${rows.map(s => { const r = riskCalc(s); return `<tr data-code="${esc(s.code)}">${cols.map(c => `<td class="${c[2] || ''}">${cellVal(s, c[0], r)}</td>`).join('')}</tr>`; }).join('')}</tbody>`;
  $$('th', t).forEach(th => th.onclick = () => { const k = th.dataset.k; if (k === 'name' || k === 'sector') return; S.allSort = { key: k, asc: S.allSort.key === k ? !S.allSort.asc : false }; renderAll(); });
  bindItems(t);
}

/* ═════════════ 섹터 ═════════════ */
function renderSector() {
  const secs = S.data.sectors || [];
  $('#secTable').innerHTML = `<thead><tr><th class="l">업종</th><th>5일</th><th>코스피 대비</th><th>미국장 영향</th><th class="l">결합도</th><th>종목수</th><th>평균 종합</th></tr></thead><tbody>${secs.map(s => {
    const m = S.data.stocks.filter(x => x.sector === s.name); const avg = m.length ? m.reduce((a, x) => a + x._sc.total, 0) / m.length : null;
    return `<tr data-sec="${esc(s.name)}"><td class="l"><b>${esc(s.name)}</b></td><td class="mono ${cls(s.ret5)}">${pct(s.ret5, 1)}</td><td class="mono ${cls(s.rel5)}">${pct(s.rel5, 1)}</td><td class="mono ${cls(s.us_impact)}">${pct(s.us_impact)}</td><td class="l">${esc(s.coupling || '')} <span class="muted">${(s.us_syms || []).join('+')}</span></td><td class="mono">${s.count}</td><td class="mono">${fmt(avg, 1)}</td></tr>`; }).join('')}</tbody>`;
  $$('#secTable tr[data-sec]').forEach(tr => tr.onclick = () => { S.conds = [{ f: 'sector', op: 'is', v: tr.dataset.sec }]; drawConds(); switchTab('search'); runSearch(); });
  const ur = S.data.us_rets || {}, names = S.usmap.us_symbols;
  $('#mapTable').innerHTML = `<thead><tr><th class="l">국내 섹터</th><th class="l">US 지표 × beta</th><th class="l">결합도</th><th>전일 영향</th></tr></thead><tbody>${S.usmap.map.map(m => {
    const v = m.us.reduce((a, u) => a + (ur[u.sym] ?? 0) * u.beta, 0);
    return `<tr><td class="l">${esc(m.sector)}</td><td class="l">${m.us.map(u => `${esc(names[u.sym] || u.sym)} <span class="mono">×${u.beta}</span> <span class="mono ${cls(ur[u.sym])}">(${pct(ur[u.sym])})</span>`).join('<br>')}</td><td class="l">${esc(m.coupling)}</td><td class="mono ${cls(v)}">${pct(v)}</td></tr>`; }).join('')}</tbody>`;
}

/* ═════════════ 백테스트 ═════════════ */
let btChart;
function renderBT() {
  const b = S.bt;
  if (!b) { $('#btCards').innerHTML = '<div class="empty">backtest.json 이 없습니다. <code>python pipeline/backtest.py</code> 실행 후 생성됩니다.</div>'; return; }
  const m = b.metrics, mt = b.meta;
  $('#btMeta').textContent = `${mt.from} ~ ${mt.to} · ${mt.mode_label} · ${mt.universe}종목 · ${mt.rebalance_days}일마다 상위 ${mt.top_n} · 최대 ${mt.hold_days}일 보유 · 손절 ATR×${mt.atr_mult}${mt.sample ? ' · 샘플' : ''}`;
  const c = (k, v, s) => `<div class="card"><div class="k">${k}</div><div class="v ${s || ''}">${v}</div></div>`;
  $('#btCards').innerHTML = c('누적 수익률', pct(m.total_ret, 1), cls(m.total_ret)) + c('연환산(CAGR)', pct(m.cagr, 1), cls(m.cagr)) + c('최대낙폭(MDD)', pct(m.mdd, 1), 'down') +
    c('코스피 수익률', pct(m.bench_ret, 1), cls(m.bench_ret)) + c('승률', fmt(m.win_rate, 1) + '%') + c('거래 수', fmt(m.trades)) + c('평균 수익/손실', `${pct(m.avg_win, 1)} / ${pct(m.avg_loss, 1)}`) + c('손절 비율', fmt(m.stop_rate, 1) + '%');
  const css = getComputedStyle(document.documentElement);
  if (window.Chart) {
    btChart && btChart.destroy();
    btChart = new Chart($('#btChart'), { type: 'line', data: { labels: b.curve.dates, datasets: [
      { label: '전략', data: b.curve.strategy, borderColor: css.getPropertyValue('--up').trim(), borderWidth: 2, pointRadius: 0, tension: .15 },
      { label: '코스피', data: b.curve.bench, borderColor: css.getPropertyValue('--muted').trim(), borderWidth: 1.5, pointRadius: 0, borderDash: [4, 3] }] },
      options: chartOpts(css, v => v) });
  }
  $('#btMonthly').innerHTML = b.monthly.map(x => `<div style="background:${x.r >= 0 ? 'var(--bad-soft)' : 'var(--accent-soft)'}">${x.m}<b class="${cls(x.r)}">${pct(x.r, 1)}</b></div>`).join('');
  $('#btTrades').innerHTML = `<thead><tr><th class="l">코드</th><th class="l">진입</th><th class="l">청산</th><th>수익률</th><th class="l">사유</th></tr></thead><tbody>${b.trades.slice().reverse().map(t => {
    const s = S.data.stocks.find(x => x.code === t.code); return `<tr ${s ? `data-code="${esc(t.code)}"` : ''}><td class="l">${esc(s ? s.name : t.code)}</td><td class="l mono">${t.in}</td><td class="l mono">${t.out}</td><td class="mono ${cls(t.ret)}">${pct(t.ret, 1)}</td><td class="l">${esc(t.why)}</td></tr>`; }).join('')}</tbody>`;
  bindItems($('#btTrades'));
}
function chartOpts(css, yfmt) {
  const grid = css.getPropertyValue('--line').trim(), txt = css.getPropertyValue('--muted').trim();
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: txt, boxWidth: 12 } } },
    scales: { x: { ticks: { color: txt, maxTicksLimit: 8 }, grid: { color: grid } }, y: { ticks: { color: txt, callback: yfmt }, grid: { color: grid } } } };
}

/* ═════════════ 종목 상세 ═════════════ */
function checklist(s) {
  const T = S.th, ok = b => b == null ? null : !!b;
  const yes = v => v == null ? null : v;
  return [
    [1, '거래량', `${fmt(s.vol_ratio, 2)}배 · 거래대금 ${fmt(s.tvalue, 1)}억`, `20일 평균 ${T.volume_ratio}배↑ + 상승`, s.vol_ratio == null ? null : s.vol_ratio >= T.volume_ratio && s.chg > 0],
    [2, '기술분석', `RSI ${fmt(s.rsi, 1)} · MACD ${s.macd_above ? '시그널 위' : '시그널 아래'}${s.macd_cross_days != null ? `(${s.macd_cross_days}일 전 상향)` : ''} · %b ${fmt(s.bb_pb, 2)}`, `3종 중 2개↑ (현재 ${s.tech3 ?? '–'}개)`, s.tech3 == null ? null : s.tech3 >= 2],
    [3, '실적', `영업익 ${pct(s.op_yoy, 1)} · 매출 ${pct(s.sales_yoy, 1)}${s.op_turn ? ' · 흑자전환' : ''}`, `전년동기 +${T.yoy_growth}%↑`, s.op_yoy == null && !s.op_turn ? null : s.op_turn || s.op_yoy >= T.yoy_growth],
    [4, '뉴스+호재', `뉴스 ${s.news_score != null ? fmt(s.news_score, 2) : '–'} · 호재공시 ${s.disc_pos ?? '–'} · 악재공시 ${s.disc_neg ?? '–'}`, '악재 공시 없음 + 감정 양(+)', s.disc_neg == null && s.news_score == null ? null : !(s.disc_neg > 0) && (s.news_score ?? 0) >= 0],
    [5, '차트(52주·매물대)', `52주 고점 대비 ${fmt(s.pos52, 2)} · 저점 터치 ${s.low_tests ?? '–'}회`, `${T.pos52_undervalued} 미만 + ${T.low_tests}회↑`, s.pos52 == null ? null : s.pos52 < T.pos52_undervalued && s.low_tests >= T.low_tests],
    [6, '국민연금·연기금', `5일 ${s.pension_net5 != null ? fmt(s.pension_net5, 1) + '억' : '–'} · 연속 ${s.pension_streak ?? '–'}일${s.pension_5pct ? ' · 5% 대량보유 공시' : ''}`, '순매수 또는 5% 공시', s.pension_net5 == null && !s.pension_5pct ? null : s.pension_5pct || s.pension_net5 > 0],
    [7, '외국인 비율·방향', `연속 ${s.foreign_streak ?? '–'}일 · 지분 ${fmt(s.foreign_hold, 1)}% · 한도소진 ${fmt(s.exhaustion, 1)}%`, `${T.streak_days}일 연속 순매수 · 소진율 ${T.exhaustion_limit}% 미만`, s.foreign_streak == null ? null : s.foreign_streak >= T.streak_days && !((s.exhaustion ?? 0) >= T.exhaustion_limit)],
    [8, '재무안정성', s.is_fin ? `금융업 — 부채·유동비율 판정 제외 · 영업CF ${s.ocf != null ? fmt(s.ocf, 0) + '억' : '–'} · 흑자 ${s.profit_q ?? '–'}/4분기` : `부채 ${fmt(s.debt_ratio, 0)}% · 유동 ${fmt(s.current_ratio, 0)}% · 영업CF ${s.ocf != null ? fmt(s.ocf, 0) + '억' : '–'} · 흑자 ${s.profit_q ?? '–'}/4분기`, `부채≤${T.debt_ratio_max}% · 유동≥${T.current_ratio_min}% · CF+ · 흑자지속`, s.debt_ratio == null ? null : s.debt_ratio <= T.debt_ratio_max && (s.current_ratio ?? 0) >= T.current_ratio_min && (s.ocf ?? 1) > 0 && (s.profit_q ?? 4) >= 4],
    [9, '5·20·120일 지지선', `5일 ${s.sr5 || '–'} · 20일 ${s.sr20 || '–'} · 120일 ${s.sr120 || '–'}`, '3선 모두 상향 + 주가가 위(정배열)', s.sr20 == null ? null : s.ma_align],
    [10, '장기전망', `ROE ${(s.roe3 || []).map(r => fmt(r, 1)).join(' / ') || '–'}% · 시총 ${fmt(s.mcap)}억`, `ROE 3년 연속 ${T.roe_min}%↑`, (s.roe3 || []).length < 3 ? null : s.roe3.every(r => (r || 0) >= T.roe_min)],
    [11, '섹터별', `${s.sector} 5일 코스피 대비 ${pct(s.sector_rel5, 1)}`, '코스피보다 강함', s.sector_rel5 == null ? null : s.sector_rel5 > 0],
    [12, '10분·1시간·일·월', s.m60_trend ? `10분 ${s.m10_trend} · 60분 ${s.m60_trend} · ${s.absorb ? '매도 흡수' : '흡수 미약'}` : 'KIS 분봉 미연동', '일봉 확정 + 분봉 흡수', s.m60_trend ? s.m60_trend === '상승' && s.absorb : null],
    [13, '상승여력', s.upside != null ? `목표가 ${fmt(s.target)} · ${pct(s.upside, 1)}` : '컨센서스 없음', `+${T.upside_min}%↑ (1년 뷰, 단타엔 부적합)`, s.upside == null ? null : s.upside >= T.upside_min],
    [14, '미국장 영향', `${s.us_coupling || ''} · 전일 영향 ${pct(s.us_impact)}`, '매핑 지표 상승', s.us_impact == null ? null : s.us_impact > 0],
    ['+', '공매도 잔고', s.short_ratio != null ? `비중 ${fmt(s.short_ratio, 2)}% · 5일 ${s.short_chg > 0 ? '+' : ''}${fmt(s.short_chg, 2)}%p` : '–', '잔고 증가 없음', s.short_ratio == null ? null : !((s.short_chg || 0) > .3)],
  ].map(r => ({ no: r[0], item: r[1], val: r[2], crit: r[3], ok: ok(yes(r[4])) }));
}
let pxChart;
function openDetail(code) {
  const s = S.data.stocks.find(x => x.code === code); if (!s) return;
  const sc = s._sc, r = riskCalc(s), ck = (typeof easyOn === 'function' && easyOn()) ? easyCheck(s) : checklist(s);
  const pass = ck.filter(c => c.ok === true).length, avail = ck.filter(c => c.ok != null).length;
  $('#modalBody').innerHTML = `
    <div class="mh"><h3>${esc(s.name)}</h3><span class="muted mono">${esc(s.code)} · ${esc(s.market)} · ${esc(s.sector)}</span>
      <span class="px">${fmt(s.close)}</span><span class="mono ${cls(s.chg)}">${pct(s.chg)}</span>
      <span class="muted">시총 ${fmt(s.mcap)}억 · 충족 ${pass}/${avail}</span></div>
    ${s._ban.length ? `<div>${s._ban.map(b => `<span class="tag bad">매수 금지: ${b}</span>`).join('')}</div>` : ''}
    <div class="subs"><div><small>종합</small><b>${fmt(sc.total, 1)}</b></div>${Object.entries(GROUPS).map(([k, l]) => `<div><small>${l} ×${S.weights[k]}</small><b>${sc[k] ?? '–'}</b></div>`).join('')}</div>
    <div class="mgrid">
      <div>
        <div class="chart-box" style="height:280px"><canvas id="pxCanvas"></canvas></div>
        <h4>리스크 관리 (자본 ${won(S.capital)} · 1회 ${S.th.risk_pct}%)</h4>
        <div class="calc">
          <div><small>진입가</small><input class="inp" id="entryIn" type="number" value="${r.entry}" style="width:100%"></div>
          <div><small>손절가 (ATR×${S.th.atr_mult})</small><b id="cStop">${fmt(r.stop)}</b> <span class="down" id="cStopP">${fmt(r.stopPct, 1)}%</span></div>
          <div><small>권장 수량 / 금액</small><b id="cQty">${fmt(r.qty)}주</b><br><span class="muted" id="cAmt">${won(r.amount)}</span></div>
          <div><small>2R 목표가</small><b id="cT2">${fmt(r.t2r)}</b></div>
        </div>
        ${newsBlock(s)}
      </div>
      <div>${(typeof easyOn === 'function' && easyOn()) ? `<div class="ck-sum">${ck.length}개 항목 중 <b class="ok">좋음 ${ck.filter(c => c.ok === true).length}</b> · <b class="no">아쉬움 ${ck.filter(c => c.ok === false).length}</b> · <span class="na">정보 없음 ${ck.filter(c => c.ok == null).length}</span></div>` : ''}
      <table class="tbl ck"><thead><tr><th class="l">#</th><th class="l">항목</th><th class="l">${(typeof easyOn === 'function' && easyOn()) ? '지금 상태 / 좋은 신호' : '현재값 / 기준'}</th><th>판정</th></tr></thead><tbody>
        ${ck.map(c => `<tr><td class="l mono">${c.no}</td><td class="l"><b>${c.item}</b>${c.sub ? `<br><span class="muted small-t">${esc(c.sub)}</span>` : ''}</td><td class="l">${esc(c.val)}<br><span class="muted">${esc(c.crit)}</span></td><td class="${c.ok == null ? 'na' : c.ok ? 'ok' : 'no'} judge">${c.ok == null ? '–<small>정보 없음</small>' : c.ok ? '✓<small>좋음</small>' : '✗<small>아쉬움</small>'}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  $('#modal').classList.remove('hidden');
  $('#entryIn').oninput = e => { const x = riskCalc(s, +e.target.value || s.close); $('#cStop').textContent = fmt(x.stop); $('#cStopP').textContent = fmt(x.stopPct, 1) + '%'; $('#cQty').textContent = fmt(x.qty) + '주'; $('#cAmt').textContent = won(x.amount); $('#cT2').textContent = fmt(x.t2r); };
  drawPx(s, r);
}
function sma(a, n) { return a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n); }
function drawPx(s, r) {
  if (!window.Chart || !(s.spark || []).length) return;
  const c = s.spark, n = c.length, m20 = sma(c, 20);
  const sd = c.map((_, i) => { if (i < 19) return null; const w = c.slice(i - 19, i + 1), mu = m20[i]; return Math.sqrt(w.reduce((a, x) => a + (x - mu) ** 2, 0) / 20); });
  const css = getComputedStyle(document.documentElement), show = Math.min(100, n), cut = a => a.slice(n - show);
  const labels = Array.from({ length: show }, (_, i) => i - show + 1 === 0 ? '오늘' : `${i - show + 1}`);
  pxChart && pxChart.destroy();
  pxChart = new Chart($('#pxCanvas'), { type: 'line', data: { labels, datasets: [
    { label: '종가', data: cut(c), borderColor: css.getPropertyValue('--text').trim(), borderWidth: 1.8, pointRadius: 0 },
    { label: 'MA5', data: cut(sma(c, 5)), borderColor: '#e0a100', borderWidth: 1, pointRadius: 0 },
    { label: 'MA20', data: cut(m20), borderColor: css.getPropertyValue('--up').trim(), borderWidth: 1.2, pointRadius: 0 },
    { label: 'MA120', data: cut(s.spark_ma120 || []), borderColor: '#8b5cf6', borderWidth: 1.2, pointRadius: 0 },
    { label: 'BB상단', data: cut(m20.map((m, i) => m == null ? null : m + 2 * sd[i])), borderColor: css.getPropertyValue('--muted').trim(), borderDash: [3, 3], borderWidth: 1, pointRadius: 0 },
    { label: 'BB하단', data: cut(m20.map((m, i) => m == null ? null : m - 2 * sd[i])), borderColor: css.getPropertyValue('--muted').trim(), borderDash: [3, 3], borderWidth: 1, pointRadius: 0 },
    { label: '손절가', data: Array(show).fill(r.stop), borderColor: css.getPropertyValue('--down').trim(), borderWidth: 1, borderDash: [6, 4], pointRadius: 0 },
  ] }, options: chartOpts(css, v => fmt(v)) });
}

/* ═════════════ 설정 ═════════════ */
const TH_LABEL = {
  volume_ratio: '① 거래량 배수', rsi_oversold: '② RSI 과매도', rsi_overbought: '② RSI 과매수', pos52_undervalued: '⑤ 52주 위치(저평가 미만)', low_tests: '⑤ 저점 터치 횟수',
  streak_days: '⑥⑦ 연속 순매수일', exhaustion_limit: '⑦ 한도소진율 제약(%)', upside_min: '⑬ 상승여력(%)', yoy_growth: '③ 실적 YoY(%)', debt_ratio_max: '⑧ 부채비율 상한(%)',
  current_ratio_min: '⑧ 유동비율 하한(%)', roe_min: '⑩ ROE 하한(%)', pension_stake_min: '⑥ 연기금 지분 공시(%)',
};
function initSettings() {
  const wb = $('#weightBox');
  const drawW = () => {
    wb.innerHTML = Object.entries(GROUPS).map(([k, l]) => `<div class="wrow"><span>${l}</span><input type="range" min="0" max="60" step="5" value="${S.weights[k]}" data-w="${k}"><span class="val">${S.weights[k]}</span></div>`).join('');
    $('#wSum').textContent = Object.values(S.weights).reduce((a, b) => a + b, 0);
    $$('[data-w]', wb).forEach(inp => inp.oninput = e => { S.weights[e.target.dataset.w] = +e.target.value; e.target.nextElementSibling.textContent = e.target.value; $('#wSum').textContent = Object.values(S.weights).reduce((a, b) => a + b, 0); });
    $$('[data-w]', wb).forEach(inp => inp.onchange = refresh);
  };
  S._drawW = drawW; drawW();
  $('#saveMode').onclick = () => { S.cfg.modes.custom = { label: '사용자', weights: { ...S.weights } }; store.set('customMode', S.cfg.modes.custom); S.mode = 'custom'; persist(); initModeSel(); refresh(); };
  $('#dlCfg').onclick = () => {
    const out = JSON.parse(JSON.stringify(S.cfg)); out.thresholds = { ...S.th }; if (!out.modes.custom) out.modes.custom = { label: '사용자', weights: { ...S.weights } };
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })); a.download = 'weights.json'; a.click();
  };
  const bind = (id, get, set) => { const el = $(id); el.value = get(); el.onchange = () => { set(+el.value); persist(); refresh(); }; };
  bind('#capital', () => S.capital, v => S.capital = v || 30000000);
  bind('#riskPct', () => S.th.risk_pct, v => S.th.risk_pct = v);
  bind('#atrMult', () => S.th.atr_mult, v => S.th.atr_mult = v);
  bind('#wlMin', () => S.th.whitelist_min_score, v => S.th.whitelist_min_score = v);
  $('#thBox').innerHTML = Object.entries(TH_LABEL).map(([k, l]) => `<label>${l}<input class="inp" type="number" step="any" data-th="${k}" value="${S.th[k]}"></label>`).join('') +
    `<div class="row"><button class="btn ghost small" id="thReset">기본값으로</button></div>`;
  $$('[data-th]').forEach(el => el.onchange = () => { S.th[el.dataset.th] = +el.value; persist(); refresh(); drawPresets(); });
  $('#thReset').onclick = () => { S.th = { ...S.cfg.thresholds }; persist(); location.reload(); };
  $('#dataFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!d.stocks) throw new Error('stocks 항목이 없습니다'); S.data = d; refresh(); $('#dataInfo').textContent = `불러옴: ${f.name} · 기준일 ${d.meta?.asof} · ${d.stocks.length}종목`; }
    catch (err) { $('#dataInfo').textContent = '파일 오류: ' + err.message; }
  };
  $('#reloadData').onclick = async () => { S.data = await getJSON('data/latest.json'); refresh(); $('#dataInfo').textContent = '배포된 데이터로 되돌렸습니다.'; };
}
function initModeSel() {
  const sel = $('#modeSel');
  sel.innerHTML = Object.entries(S.cfg.modes).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('');
  sel.value = S.mode;
  sel.onchange = () => { S.mode = sel.value; S.weights = { ...S.cfg.modes[S.mode].weights }; persist(); S._drawW && S._drawW(); refresh(); };
}

/* ═════════════ 판정 기준 ═════════════ */
function renderGuide() {
  const T = S.th, m = S.data.meta;
  const st = (on, txt) => on ? `<span class="tag good">${txt || '반영'}</span>` : `<span class="tag">${txt || '키 필요'}</span>`;
  const rows = [
    ['1', '거래량', `일별 거래량 ÷ 20일 평균 ${T.volume_ratio}배↑ + 주가 상승 = 수급 진입. 거래 감소 속 상승 = 추세 유지. 거래대금 배수 병행`, 'pykrx get_market_ohlcv', '지표', st(true)],
    ['2', '기술분석', `RSI(≤${T.rsi_oversold} 과매도/반등) · MACD 시그널 상향(5일 내) · 볼린저 하단 접근 후 회복 — 겹친 수(0~3)로 가점`, 'pykrx 일봉 → 직접 계산', '지표', st(true)],
    ['3', '실적', `분기 영업이익·매출 전년동기 +${T.yoy_growth}%↑, 흑자전환. 30일 내 실적발표 공시일 표시`, 'OpenDART fnlttMultiAcnt / list', '실적·호재', st(m.dart, m.dart ? '반영' : 'DART 키 필요')],
    ['4', '뉴스+호재', '공시 분류(호재: 공급계약·자사주·무상증자 / 악재: 유상증자·감자·CB) + 뉴스 키워드 감정점수', '네이버 검색 API · DART', '실적·호재 / 매수금지', st(m.news, m.news ? '반영' : '네이버 키 필요')],
    ['5', '차트', `52주 고점 대비 ${T.pos52_undervalued} 미만 = 저평가 + 6개월 저점 ${T.low_tests}회 터치 = 매물대(지지) 확인`, 'pykrx 일봉(52주)', '지표', st(true)],
    ['6', '국민연금·연기금', `연기금 일별 순매수(연속일·5일합) + DART 대량보유(5%) 보고서 중 제출인 '국민연금'`, 'pykrx 투자자별 순매수 / DART', '수급', st(true)],
    ['7', '외국인 비율·방향', `순매수 ${T.streak_days}일 연속 · 지분율 · 한도소진율 ${T.exhaustion_limit}%↑면 상승여력 제약(가점 제외)`, 'pykrx get_exhaustion_rates_of_foreign_investment', '수급', st(true)],
    ['8', '재무안정성', `부채비율 ≤${T.debt_ratio_max}% · 유동비율 ≥${T.current_ratio_min}% · 영업현금흐름 양수 · 최근 4분기 흑자`, 'OpenDART (BS·CF·IS)', '안정성', st(m.dart, m.dart ? '반영' : 'DART 키 필요')],
    ['9', '5·20·120일 지지선', '종가가 MA 위 = 지지, 아래 + MA 하락 = 저항. 3선 정배열 + 모두 상향 = 강세', 'pykrx 일봉 → SMA', '지표 / 화이트리스트', st(true)],
    ['10', '장기전망', `ROE 3년 연속 ${T.roe_min}%↑, 목표주가, 시가총액 추세`, 'DART 사업보고서 / 네이버 금융', '실적·호재', st(m.dart)],
    ['11', '섹터별', '업종지수 5일 수익률 − 코스피 5일 수익률 > 0 = 섹터 우위', 'pykrx get_index_ohlcv', '섹터·미국장', st(true)],
    ['12', '10분·1시간·일·월', '일봉으로 후보 확정 → 분봉(10분·60분) 추세와 매도 흡수 여부 확인', 'KIS Developers API(호출 제한)', '상세 화면·조건검색', st(m.kis, m.kis ? '반영' : 'KIS 키 필요')],
    ['13', '상승여력', `(목표주가 − 현재가) ÷ 현재가 ≥ ${T.upside_min}%. 1년 뷰라 단타엔 부적합, 컨센서스 없는 종목은 점수에서 제외(NaN 처리)`, '네이버 금융(컨센서스)', '실적·호재', st(true)],
    ['14', '미국장 영향', '전일 미국 지표 수익률 × 섹터별 beta (반도체·IT는 SOX 강결합, 생필품은 독립) — 매핑표 상수 보유', 'FinanceDataReader', '섹터·미국장', st(true)],
    ['+1', '환율·금리(매크로 게이트)', '원/달러 급등·미 10년물 급등·나스닥 급락 시 전 종목 점수 감산 (섹터 반영보다 우선)', 'FinanceDataReader', '전체 점수 배수', st(true)],
    ['+2', '공매도 잔고', '잔고 비중과 5일 증감 — 급증 시 매수 금지', 'pykrx 공매도 잔고', '수급 / 매수금지', st(true)],
    ['+3', '기업행사 관리', '배당락·액면변경·유상증자·합병 → 수정주가(adjusted=True)로 지표 왜곡 방지', 'pykrx adjusted=True', '전체', st(true)],
    ['+4', '리스크 관리', `손절가 = 진입가 − ATR×${T.atr_mult}, 수량 = 자본의 ${T.risk_pct}% 손실 기준`, '계산', '화이트리스트·상세', st(true)],
    ['+5', '백테스트', '과거 3년 시점화 적용(t일 데이터로 점수 → t+1 시가 진입) 후 수익률·MDD·승률 검증', 'pipeline/backtest.py', '백테스트 탭', st(!!S.bt, S.bt ? '반영' : '실행 필요')],
  ];
  $('#guideTable').innerHTML = `<thead><tr><th class="l">#</th><th class="l">항목</th><th class="l">판정 기준</th><th class="l">데이터 소스</th><th class="l">반영 위치</th><th class="l">상태</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td><b>${r[1]}</b></td><td>${r[2]}</td><td>${esc(r[3])}</td><td>${r[4]}</td><td>${r[5]}</td></tr>`).join('')}</tbody>`;
}

/* ═════════════ 공통 UI ═════════════ */
function switchTab(t) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $$('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + t));
  if (t === 'bt' && btChart) btChart.resize();
}
function initTabs() {
  $$('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('#modalX').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
}
function initTheme() {
  const t = store.get('theme', null); if (t) document.documentElement.dataset.theme = t;
  $('#themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; store.set('theme', nx); renderBT();
  };
}
boot();
