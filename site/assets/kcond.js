/* 조건검색 추천 — 사용자가 올린 키움 조건식(A and B and C and D and E and F and G and H)을 일봉에 그대로 적용
   A [일]0봉전 (종가 5)이평 > 시가            → 오늘 5일선이 시가보다 위(5일선 아래에서 출발)
   B [일]0봉전 (종가 5)이평 <= 종가           → 오늘 종가가 5일선 위(5일선 돌파 마감)
   C [일]0봉전 (종가 20)이평 <= 종가          → 오늘 종가가 20일선 위
   D 거래량비율: 1봉전 대비 0봉전 거래량 100% 이상 → 어제보다 거래량이 같거나 많음
   E 주가등락률: 1봉전 종가 대비 0봉전 종가 5% 이상
   F [일]거래량 300,000 이상 999,999,999 이하
   G 주가범위: 0일전 종가 1,000 이상 50,000 이하
   H [일]20봉전 (종가 5)이평 >= 저가          → 20거래일 전 그날 저가가 5일선 이하
   + 「가능성」 점수: 조건 충족도(35) + 같은 신호의 과거 성적(25, 최근 약 95거래일 전 종목 되돌려 보기) + 신호의 질(40: 거래대금 배수·종가 위치·이격·20일선 기울기·고점 돌파·수급·업종)
   장중에는 오늘 봉을 실시간 값(업종 시세 1분 · 일봉 15분)으로 바꿔 다시 계산 */
'use strict';

const KC = { busy: false, last: null, lt: 0, bt: null, open: new Set(), n: 40,
  def: { e: 5, vMin: 300000, vMax: 999999999, pMin: 1000, pMax: 50000, d: 100, on: { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1, H: 1 } } };
const KC_NAMES = { A: '5일선 > 시가', B: '종가 ≥ 5일선', C: '종가 ≥ 20일선', D: '거래량 전일 대비 100%↑', E: '등락률 5%↑', F: '거래량 30만~', G: '주가 1천~5만원', H: '20일 전 저가 ≤ 5일선' };
const kcCfg = () => { const c = store.get('kcCfg', null); return c ? { ...KC.def, ...c, on: { ...KC.def.on, ...(c.on || {}) } } : JSON.parse(JSON.stringify(KC.def)); };
const kcClamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const kcP = v => v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, Math.abs(v) < 10 ? 2 : 1)}%`;
const kcVol = v => v == null ? '–' : v >= 1e8 ? fmt(v / 1e8, 2) + '억주' : v >= 1e4 ? fmt(v / 1e4, 0) + '만주' : fmt(v) + '주';
const kcEok = v => v == null ? '–' : Math.abs(v) >= 10000 ? fmt(v / 10000, 2) + '조' : fmt(v, v < 10 ? 1 : 0) + '억';
function kcToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function kcOpenMkt() { const k = new Date(Date.now() + 9 * 3600e3), m = k.getUTCHours() * 60 + k.getUTCMinutes(), wd = k.getUTCDay(); return wd >= 1 && wd <= 5 && m >= 540 && m <= 930; }

/* 종목 일봉 배열 (오늘 봉 = 실시간 값, 거래량은 「지금까지 누적」 그대로 — 키움 조건검색과 같게) */
function kcSeries(s, live) {
  const C = s.spark, O = s.spark_o, H = s.spark_h, L = s.spark_l; if (!C || !O || !H || !L || C.length < 30) return null;
  const V = [...(s.spark_vol || [])]; const c = [...C], o = [...O], h = [...H], l = [...L];
  const vl = s._vlive, today = kcToday(), n = c.length - 1;
  if (vl && vl.intr) V[n] = vl.raw;                         // 장중: 하루치 환산 말고 실제 누적 거래량
  const lv = live && live.get(s.code);
  if (lv && lv.p && vl && vl.d === today) {                 // 오늘 봉이 있으면 1분 실시간 값으로 덮음
    c[n] = lv.p; h[n] = Math.max(h[n], lv.p); l[n] = Math.min(l[n], lv.p); if (lv.v) V[n] = Math.max(V[n] || 0, lv.v);
  }
  return { c, o, h, l, v: V, d: vl ? vl.d : (S.data.meta && S.data.meta.asof) };
}
const kcMa = (a, n, i) => { if (i - n + 1 < 0) return null; let t = 0; for (let k = i - n + 1; k <= i; k++) { if (a[k] == null) return null; t += a[k]; } return t / n; };

/* 조건 8개 판정 (i = 판정할 날) */
function kcEval(Z, i, cfg) {
  const { c, o, h, l, v } = Z; if (i < 25 || c[i] == null || c[i - 1] == null) return null;
  const m5 = kcMa(c, 5, i), m20 = kcMa(c, 20, i), m5b = kcMa(c, 5, i - 20), chg = (c[i] / c[i - 1] - 1) * 100, vr = v[i - 1] ? v[i] / v[i - 1] * 100 : null;
  const R = {
    A: { ok: m5 != null && o[i] != null && m5 > o[i], v: m5 && o[i] ? (m5 / o[i] - 1) * 100 : null, t: m5 && o[i] ? `5일선 ${fmt(Math.round(m5))} vs 시가 ${fmt(o[i])}` : '' },
    B: { ok: m5 != null && m5 <= c[i], v: m5 ? (c[i] / m5 - 1) * 100 : null, t: m5 ? `종가 ${fmt(c[i])} · 5일선 ${fmt(Math.round(m5))} (${kcP((c[i] / m5 - 1) * 100)})` : '' },
    C: { ok: m20 != null && m20 <= c[i], v: m20 ? (c[i] / m20 - 1) * 100 : null, t: m20 ? `20일선 ${fmt(Math.round(m20))} 대비 ${kcP((c[i] / m20 - 1) * 100)}` : '' },
    D: { ok: vr != null && vr >= cfg.d, v: vr, t: vr != null ? `전일 대비 ${fmt(vr, 0)}% (${kcVol(v[i])})` : '' },
    E: { ok: chg >= cfg.e, v: chg, t: `등락률 ${kcP(chg)}` },
    F: { ok: v[i] != null && v[i] >= cfg.vMin && v[i] <= cfg.vMax, v: v[i], t: `거래량 ${kcVol(v[i])}` },
    G: { ok: c[i] >= cfg.pMin && c[i] <= cfg.pMax, v: c[i], t: `종가 ${fmt(c[i])}원` },
    H: { ok: m5b != null && l[i - 20] != null && m5b >= l[i - 20], v: m5b && l[i - 20] ? (m5b / l[i - 20] - 1) * 100 : null, t: m5b ? `20일 전 저가 ${fmt(l[i - 20])} · 그날 5일선 ${fmt(Math.round(m5b))}` : '' },
  };
  const keys = Object.keys(R).filter(k => cfg.on[k]);
  const pass = keys.filter(k => R[k].ok).length;
  return { R, pass, need: keys.length, all: pass === keys.length, m5, m20, chg, vr };
}
/* 못 미친 조건이 얼마나 가까운지(0~1) */
function kcNear(k, r, cfg) {
  if (r.ok) return 1; const v = r.v; if (v == null) return 0;
  if (k === 'E') return kcClamp(v / cfg.e, 0, 1) * (v > 0 ? 1 : 0);
  if (k === 'D') return kcClamp(v / cfg.d, 0, 1);
  if (k === 'B' || k === 'C') return kcClamp(1 + v / 3, 0, 1);
  if (k === 'A') return kcClamp(1 + v / 2, 0, 1);
  if (k === 'F') return kcClamp(v / cfg.vMin, 0, 1);
  return 0;
}

/* 과거 성적: 최근 약 95거래일 동안 이 조건이 모두 맞은 날 → 다음 날들 성과 (전 종목) */
function kcBacktest(cfg) {
  const key = JSON.stringify(cfg) + '|' + (S.data.meta && S.data.meta.asof);
  if (KC.bt && KC.bt.key === key) return KC.bt;
  const ev = [], per = {};
  S.data.stocks.forEach(s => {
    const C = s.spark, O = s.spark_o, H = s.spark_h, L = s.spark_l, V = s._base ? s._base.v : s.spark_vol;
    if (!C || !O || !H || !L || !V || C.length < 40) return;
    const Z = { c: s._base ? s._base.c : C, o: s._base && s._base.o ? s._base.o : O, h: s._base && s._base.h ? s._base.h : H, l: s._base && s._base.l ? s._base.l : L, v: V };
    const n = Z.c.length;
    for (let t = 25; t <= n - 2; t++) {
      const E = kcEval(Z, t, cfg); if (!E || !E.all) continue;
      const c0 = Z.c[t], k3 = Math.min(n - 1, t + 3), k5 = Math.min(n - 1, t + 5);
      let mx3 = -1e9, mn3 = 1e9; for (let j = t + 1; j <= k3; j++) { mx3 = Math.max(mx3, Z.h[j] / c0 - 1); mn3 = Math.min(mn3, Z.l[j] / c0 - 1); }
      const r1 = Z.c[t + 1] / c0 - 1, r3 = Z.c[k3] / c0 - 1, r5 = Z.c[k5] / c0 - 1, gap = Z.o[t + 1] / c0 - 1;
      const e = { code: s.code, t, r1, r3, r5, mx3, mn3, gap, hit: mx3 >= 0.03, full: t + 3 <= n - 1 };
      ev.push(e); (per[s.code] = per[s.code] || []).push(e);
    }
  });
  const F = ev.filter(e => e.full), avg = (A, k) => A.length ? A.reduce((a, e) => a + e[k], 0) / A.length : null;
  const bt = { key, n: ev.length, nFull: F.length, hit: F.length ? F.filter(e => e.hit).length / F.length : null, up3: F.length ? F.filter(e => e.r3 > 0).length / F.length : null,
    r1: avg(ev, 'r1'), r3: avg(F, 'r3'), mx3: avg(F, 'mx3'), mn3: avg(F, 'mn3'), gap: avg(ev, 'gap'), per, ev };
  KC.bt = bt; return bt;
}
/* 실시간 1분 시세(섹터 흐름이 받은 업종 구성 종목) */
function kcLive() { const M = new Map(); if (typeof SF !== 'undefined' && SF.net && SF.net.det) Object.values(SF.net.det).forEach(a => a.forEach(m => { if (m.c && m.p) M.set(m.c, m); })); return M; }

/* 가능성 점수 */
function kcScore(s, Z, E, bt, cfg, sec) {
  const n = Z.c.length - 1, P = [], M = [];
  // ① 조건 충족도 35
  const keys = Object.keys(E.R).filter(k => cfg.on[k]);
  const near = keys.reduce((a, k) => a + kcNear(k, E.R[k], cfg), 0) / keys.length;
  const s1 = E.all ? 35 : 35 * near * 0.8;
  // ② 과거 성적 25 (전체 기준 + 이 종목 이력, 표본이 적으면 전체 쪽으로 당김)
  let s2 = 12.5;
  const own = (bt.per[s.code] || []).filter(e => e.full);
  if (bt.hit != null) {
    const base = bt.hit, oh = own.length ? own.filter(e => e.hit).length / own.length : base, w = own.length / (own.length + 3);
    const p = base * (1 - w) + oh * w; s2 = kcClamp(p * 25 / 0.7, 0, 25);
    if (own.length) (oh >= base ? P : M).push(`이 종목은 최근 ${own.length}번 같은 신호 중 ${own.filter(e => e.hit).length}번 3일 안 +3% 도달`);
  }
  // ③ 신호의 질 40
  let s3 = 0;
  const c = Z.c[n], h = Z.h[n], l = Z.l[n], o = Z.o[n];
  // 거래대금 배수(오늘 ÷ 20일 평균, 장중은 하루치 환산)
  let a20 = 0, k20 = 0; for (let k = n - 20; k < n; k++) if (Z.c[k] && Z.v[k] != null) { a20 += Z.c[k] * Z.v[k]; k20++; }
  const vl = s._vlive, frac = vl && vl.intr ? vl.f : 1, tvr = k20 ? (c * Z.v[n] / frac) / (a20 / k20) : null;
  if (tvr != null) { const x = tvr >= 3 ? 9 : tvr >= 2 ? 7 : tvr >= 1.5 ? 5 : tvr >= 1 ? 3 : 0; s3 += x; if (tvr >= 2) P.push(`거래대금 평소의 ${fmt(tvr, 1)}배`); else if (tvr < 1) M.push(`거래대금 평소의 ${fmt(tvr, 2)}배(약함)`); }
  // 종가 위치(고가 근처 마감) · 윗꼬리
  const pos = h > l ? (c - l) / (h - l) : 1, wick = h > Math.max(o, c) ? (h - Math.max(o, c)) / Math.max(1, h - l) : 0;
  s3 += pos >= 0.85 ? 8 : pos >= 0.7 ? 6 : pos >= 0.5 ? 3 : 0;
  if (pos >= 0.85) P.push('고가 근처에서 마감(매수세 끝까지 유지)'); else if (wick >= 0.4) M.push(`긴 윗꼬리(고가 대비 ${kcP((c / h - 1) * 100)}) — 위에서 매물`);
  // 20일선 이격
  const gap20 = E.m20 ? (c / E.m20 - 1) * 100 : null;
  if (gap20 != null) { s3 += gap20 <= 12 ? 6 : gap20 <= 20 ? 4 : gap20 <= 30 ? 0 : -6; if (gap20 > 25) M.push(`20일선보다 ${fmt(gap20, 0)}% 위 — 단기 과열(추격 주의)`); }
  if (E.chg >= 20) { s3 -= 4; M.push(`하루 ${kcP(E.chg)} 급등 — 다음 날 차익 매물 주의`); }
  // 20일선 기울기
  const m20p = kcMa(Z.c, 20, n - 5); if (E.m20 && m20p) { const sl = (E.m20 / m20p - 1) * 100; s3 += sl > 1 ? 5 : sl > 0 ? 3 : 0; if (sl > 1) P.push('20일선이 오르는 중(상승 추세 속 돌파)'); else if (sl < -1) M.push('20일선이 내리는 중(하락 추세 속 반등)'); }
  // 고점 돌파
  const hi60 = Math.max(...Z.h.slice(Math.max(0, n - 60), n)); if (c >= hi60) { s3 += 5; P.push('60일 최고가 돌파'); } else if (c >= hi60 * 0.95) s3 += 3;
  // 수급
  let fl = null; try { if (typeof ivAnalyze === 'function' && (s._inv || s._flow)) fl = ivAnalyze(s); } catch (e) {}
  if (fl) { const f5 = (fl.sum.f5 || 0) + (fl.sum.i5 || 0); s3 += f5 > 0 ? 4 : 0; if (fl.today.f > 0 && fl.Z.partial) P.push(`오늘 외국인 순매수(잠정 ${typeof ivEok === 'function' ? ivEok(fl.today.f) : fl.today.f})`); if (fl.rg[0] === 'retail') { s3 -= 3; M.push('개인만 사는 중'); } }
  // 업종
  if (sec) { const st = sec.x.st; s3 += st === 'lead' ? 3 : st === 'up' || st === 'rebound' ? 2 : st === 'weak' || st === 'turn' ? -2 : 0; if (st === 'lead') P.push(`주도 업종(${sec.x.name})`); }
  if (s._alert) { s3 -= 10; M.unshift(`시장경보(${s._alert})`); }
  s3 = kcClamp(s3, 0, 40);
  const total = Math.round((s1 + s2 + s3) * 10) / 10;
  return { total, s1, s2, s3, P, M, tvr, pos, gap20, own };
}
function kcGrade(t, all) { return !all ? (t >= 55 ? ['근접', '조건 임박'] : ['', '']) : t >= 86 ? ['S', '가능성 매우 높음'] : t >= 78 ? ['A', '가능성 높음'] : t >= 70 ? ['B', '보통 이상'] : ['C', '신호는 맞지만 질이 약함']; }

/* 전체 계산 */
function kcCompute() {
  if (!S.data) return null;
  const cfg = kcCfg(), bt = kcBacktest(cfg), live = kcLive(), sec = typeof r4SecMap === 'function' ? (() => { try { return r4SecMap(); } catch (e) { return new Map(); } })() : new Map();
  const rows = [], yest = [];
  S.data.stocks.forEach(s => {
    if (s.market !== 'KOSPI' && s.market !== 'KOSDAQ') return;
    const Z = kcSeries(s, live); if (!Z) return;
    const n = Z.c.length - 1, E = kcEval(Z, n, cfg); if (!E) return;
    if (E.pass >= E.need - 2) { const sc = kcScore(s, Z, E, bt, cfg, sec.get(s.code)); rows.push({ s, Z, E, ...sc }); }
    const Ey = kcEval({ c: Z.c, o: Z.o, h: Z.h, l: Z.l, v: Z.v }, n - 1, cfg); if (Ey && Ey.all) yest.push({ s, c0: Z.c[n - 1], c1: Z.c[n], hi: Z.h[n], r: (Z.c[n] / Z.c[n - 1] - 1) * 100, mx: (Z.h[n] / Z.c[n - 1] - 1) * 100 });
  });
  rows.sort((a, b) => (b.E.all - a.E.all) || (b.total - a.total));
  KC.last = { rows, yest, bt, cfg, at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16), live: live.size > 0 };
  KC.lt = Date.now();
  return KC.last;
}

/* 화면 */
function kcPlan(r) {
  const c = r.Z.c[r.Z.c.length - 1], l = r.Z.l[r.Z.l.length - 1], m5 = r.E.m5;
  const stop = Math.max(l, m5 ? Math.round(m5 * 0.99) : l, Math.round(c * 0.92)), risk = (c / stop - 1) * 100;
  return `종가(${fmt(c)}원) 근처 또는 다음 날 5일선(${m5 ? fmt(Math.round(m5)) : '–'}원) 근처 눌림에서 분할 매수 · 손절 ${fmt(Math.round(stop))}원(오늘 저가·5일선 이탈, 최대 −8% · 지금가 대비 −${fmt(risk, 1)}%) · 1차 목표 +5%(${fmt(Math.round(c * 1.05))}원) 절반, 나머지 +10% 또는 5일선 이탈 시`;
}
function kcRowHtml(r, i) {
  const s = r.s, G = kcGrade(r.total, r.E.all), op = KC.open.has(s.code), cfg = KC.last.cfg;
  const chips = Object.keys(KC_NAMES).filter(k => cfg.on[k]).map(k => `<i class="kc-ck ${r.E.R[k].ok ? 'ok' : 'no'}" title="${esc(KC_NAMES[k] + ' — ' + r.E.R[k].t)}">${k}</i>`).join('');
  const miss = Object.keys(KC_NAMES).filter(k => cfg.on[k] && !r.E.R[k].ok);
  return `<tr class="kc-r ${op ? 'open' : ''} ${r.E.all ? 'all' : ''}" data-kc="${esc(s.code)}"><td class="mono"><b>${i + 1}</b></td>
    <td class="l"><b class="kc-nm" data-kcan="${esc(s.code)}">${esc(s.name)}</b><small>${s.market === 'KOSPI' ? '코스피' : '코스닥'} · ${esc((r4SecName(s)) || '')}</small></td>
    <td class="mono ${cls(r.E.chg)}">${fmt(r.Z.c[r.Z.c.length - 1])}<small>${kcP(r.E.chg)}</small></td>
    <td><span class="kc-tot kc-g${G[0] || 'x'}">${fmt(r.total, 1)}</span><small class="kc-gl">${esc(G[0])}</small></td>
    <td class="kc-cks">${chips}<small>${r.E.pass}/${r.E.need}</small></td>
    <td class="mono">${r.tvr != null ? fmt(r.tvr, 1) + '배' : '–'}</td>
    <td class="l kc-why">${r.E.all ? esc(r.P.slice(0, 2).join(' · ') || '조건 모두 충족') : `<span class="kc-miss">부족: ${miss.map(k => esc(KC_NAMES[k] + '(' + r.E.R[k].t + ')')).join(', ')}</span>`}</td></tr>
    ${op ? `<tr class="kc-open"><td colspan="7">${kcDetail(r)}</td></tr>` : ''}`;
}
function r4SecName(s) { try { const m = typeof r4SecMap === 'function' ? (KC.secMap = KC.secMap && Date.now() - KC.secT < 60e3 ? KC.secMap : (KC.secT = Date.now(), r4SecMap())) : null; const x = m && m.get(s.code); return x ? x.x.name : s.sector; } catch (e) { return s.sector; } }
function kcDetail(r) {
  const cfg = KC.last.cfg, bt = KC.last.bt;
  return `<div class="kc-det">
    <div><h5>조건 8개</h5><ul class="kc-cl">${Object.keys(KC_NAMES).filter(k => cfg.on[k]).map(k => `<li class="${r.E.R[k].ok ? 'ok' : 'no'}"><b>${k}</b> ${esc(KC_NAMES[k])} <small>${esc(r.E.R[k].t)}</small></li>`).join('')}</ul></div>
    <div><h5>가능성 ${fmt(r.total, 1)}점 <small>충족도 ${fmt(r.s1, 0)}/35 · 과거 성적 ${fmt(r.s2, 0)}/25 · 신호의 질 ${fmt(r.s3, 0)}/40</small></h5>
      ${r.P.length ? `<ul class="r4-y">${r.P.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${r.M.length ? `<ul class="r4-n">${r.M.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${r.E.all ? `<p class="kc-plan"><b>참고 매매 계획</b> ${esc(kcPlan(r))}</p>` : ''}
      <p class="hint">같은 신호의 전체 과거 성적(최근 약 ${S.data.stocks[0].spark.length}거래일): ${bt.nFull}번 중 3일 안 +3% 도달 ${bt.hit != null ? fmt(bt.hit * 100, 0) + '%' : '–'} · 3일 뒤 평균 ${kcP(bt.r3 * 100)} · 3일 안 평균 최대 상승 ${kcP(bt.mx3 * 100)} / 최대 하락 ${kcP(bt.mn3 * 100)}</p>
      <div class="row gap wrap"><button class="btn ghost small" data-kcgo="an" data-c="${esc(r.s.code)}">종목 분석</button><button class="btn ghost small" data-kcgo="tm" data-c="${esc(r.s.code)}">매매 타이밍</button><button class="btn ghost small" data-kcgo="bd" data-c="${esc(r.s.code)}">실시간 현황판에 추가</button></div></div></div>`;
}
function kcCfgHtml(cfg) {
  return `<div class="kc-cfg">${Object.keys(KC_NAMES).map(k => `<label class="kc-on"><input type="checkbox" data-kcon="${k}" ${cfg.on[k] ? 'checked' : ''}> <b>${k}</b> ${esc(KC_NAMES[k])}</label>`).join('')}</div>
    <div class="kc-cfg2"><label>등락률(E) <input class="inp" type="number" step="0.5" data-kcv="e" value="${cfg.e}">% 이상</label><label>거래량 비율(D) <input class="inp" type="number" step="10" data-kcv="d" value="${cfg.d}">% 이상</label><label>거래량(F) <input class="inp" type="number" step="50000" data-kcv="vMin" value="${cfg.vMin}">주 이상</label><label>주가(G) <input class="inp" type="number" step="500" data-kcv="pMin" value="${cfg.pMin}"> ~ <input class="inp" type="number" step="1000" data-kcv="pMax" value="${cfg.pMax}">원</label><button class="btn ghost small" id="kcReset">원래 조건식으로</button></div>`;
}
function renderKc() {
  const box = $('#kcBody'); if (!box || !S.data) return;
  const D = KC.last && Date.now() - KC.lt < 30e3 ? KC.last : kcCompute(); if (!D) return;
  const f = { mkt: $('#kcMkt') ? $('#kcMkt').value : 'all', lvl: $('#kcLvl') ? $('#kcLvl').value : 'all', sort: $('#kcSort') ? $('#kcSort').value : 'score', q: ($('#kcQ') && $('#kcQ').value || '').trim(), tv: +($('#kcTv') && $('#kcTv').value || 0) };
  let L = D.rows.filter(r => (f.mkt === 'all' || r.s.market === f.mkt) && (f.lvl === 'all' ? r.E.all : f.lvl === 'n1' ? r.E.pass >= r.E.need - 1 : r.E.pass >= r.E.need - 2) && (!f.q || r.s.name.includes(f.q) || r.s.code.includes(f.q) || String(r4SecName(r.s)).includes(f.q)) && (!f.tv || (r.tvr || 0) >= f.tv));
  const cmp = { score: (a, b) => (b.E.all - a.E.all) || b.total - a.total, chg: (a, b) => b.E.chg - a.E.chg, tvr: (a, b) => (b.tvr || 0) - (a.tvr || 0), hist: (a, b) => b.s2 - a.s2 || b.total - a.total }[f.sort];
  L = L.slice().sort(cmp);
  const all = D.rows.filter(r => r.E.all), bt = D.bt;
  $('#kcMeta').innerHTML = `${kcOpenMkt() ? '<span class="gov-live"></span> 장중 실시간 — ' : ''}${D.at} 계산 · 조건 모두 충족 <b>${all.length}</b>종목(코스피 ${all.filter(r => r.s.market === 'KOSPI').length} · 코스닥 ${all.filter(r => r.s.market === 'KOSDAQ').length}) · 1개 부족 ${D.rows.filter(r => !r.E.all && r.E.pass === r.E.need - 1).length}종목 · 분석 대상 ${S.data.stocks.length}종목`;
  const top = all.slice(0, 5);
  $('#kcTop').innerHTML = `<div class="kc-bt"><b>이 조건식의 과거 성적</b> 최근 약 ${S.data.stocks[0].spark.length}거래일 동안 분석 대상 전 종목에서 ${fmt(bt.n)}번 나왔고, 그중 ${bt.nFull ? `<b>${fmt(bt.hit * 100, 0)}%</b>가 3일 안에 +3% 이상 올랐어요(3일 뒤 종가 상승 ${fmt(bt.up3 * 100, 0)}% · 평균 ${kcP(bt.r3 * 100)} · 다음 날 시가 평균 ${kcP(bt.gap * 100)} · 3일 안 평균 최대 하락 ${kcP(bt.mn3 * 100)})` : '아직 평가할 수 있는 신호가 없어요'}.</div>
    ${top.length ? `<h4 class="mt-s">오늘의 추천 TOP ${top.length} <small class="muted">조건 8개 모두 충족 + 가능성 높은 순</small></h4><div class="kc-top">${top.map((r, i) => { const G = kcGrade(r.total, true); return `<div class="kc-tc" data-kcan="${esc(r.s.code)}"><span class="kc-tr">${i + 1}위 · ${esc(G[1])}</span><div><b>${esc(r.s.name)}</b><span class="kc-tot kc-g${G[0]}">${fmt(r.total, 1)}</span></div><small class="${cls(r.E.chg)}">${fmt(r.Z.c[r.Z.c.length - 1])}원 ${kcP(r.E.chg)} · 거래대금 ${r.tvr ? fmt(r.tvr, 1) + '배' : '–'}</small><p>${esc(r.P.slice(0, 2).join(' · ') || '조건 모두 충족')}</p>${r.M.length ? `<p class="kc-m">주의: ${esc(r.M[0])}</p>` : ''}</div>`; }).join('')}</div>` : `<p class="hint mt-s">${kcOpenMkt() ? '지금은 8개 조건을 모두 만족하는 종목이 없어요. 아래 「1개 부족」을 보면 곧 들어올 종목을 볼 수 있어요.' : '마지막 거래일 기준으로 8개 조건을 모두 만족한 종목이 없어요.'}</p>`}
    ${D.yest.length ? `<details class="kc-y"><summary>직전 거래일에 조건을 충족한 ${D.yest.length}종목의 다음 날(${kcOpenMkt() ? '오늘 지금까지' : '마지막 거래일'}) 성과 — 평균 ${kcP(D.yest.reduce((a, x) => a + x.r, 0) / D.yest.length)} · 장중 최고 평균 ${kcP(D.yest.reduce((a, x) => a + x.mx, 0) / D.yest.length)}</summary><div class="kc-ys">${D.yest.sort((a, b) => b.r - a.r).map(x => `<span class="mn-chip ${x.r > 0 ? 'good' : 'bad'}" data-kcan="${esc(x.s.code)}">${esc(x.s.name)} <small class="${cls(x.r)}">${kcP(x.r)}</small></span>`).join('')}</div></details>` : ''}`;
  box.innerHTML = `<div class="table-wrap"><table class="tbl kc-tb"><thead><tr><th>순위</th><th class="l">종목</th><th>현재가</th><th>가능성</th><th>조건 A~H</th><th>거래대금 배수</th><th class="l">근거 · 부족한 조건</th></tr></thead><tbody>${L.slice(0, KC.n).map(kcRowHtml).join('') || `<tr><td colspan="7" class="l hint">조건에 맞는 종목이 없어요. 위에서 「1개 부족」·「2개 부족」으로 넓혀 보세요.</td></tr>`}</tbody></table></div>
    ${L.length > KC.n ? `<button class="btn ghost small mt-s" id="kcMore">더 보기 (${L.length}종목 중 ${KC.n})</button>` : ''}`;
  $$('#kcBody tr[data-kc]').forEach(tr => tr.onclick = e => { if (e.target.closest('[data-kcan],[data-kcgo]')) return; const c = tr.dataset.kc; KC.open.has(c) ? KC.open.delete(c) : KC.open.add(c); renderKc(); });
  $$('#tab-kc [data-kcan]').forEach(el => el.onclick = e => { e.stopPropagation(); showAnalysis(el.dataset.kcan); });
  $$('#kcBody [data-kcgo]').forEach(b => b.onclick = e => { e.stopPropagation(); const c = b.dataset.c, g = b.dataset.kcgo; if (g === 'an') showAnalysis(c); else if (g === 'tm' && typeof openTiming === 'function') openTiming(c); else if (g === 'bd' && typeof bdAdd === 'function') { bdAdd(c); switchTab('board'); if (typeof renderBoard === 'function') { renderBoard(); bdSelect(c); } } });
  const mo = $('#kcMore'); if (mo) mo.onclick = () => { KC.n += 40; renderKc(); };
}
function renderKcDash() {
  const box = $('#kcDash'); if (!box || !S.data) return;
  const D = KC.last && Date.now() - KC.lt < 60e3 ? KC.last : kcCompute(); if (!D) return;
  const all = D.rows.filter(r => r.E.all);
  box.innerHTML = `<div class="ph"><h2>조건검색 추천 <small class="muted">5일선 돌파 +5% 거래 증가 조건식 · 오늘 ${all.length}종목 충족</small></h2><button class="btn ghost small" id="kcGo">전체 보기 →</button></div>
    ${all.length ? `<ol class="r4-dl">${all.slice(0, 5).map(r => { const G = kcGrade(r.total, true); return `<li data-kcan="${esc(r.s.code)}"><b>${esc(r.s.name)}</b><span class="kc-tot kc-g${G[0]}">${fmt(r.total, 1)}</span><small class="${cls(r.E.chg)}">${kcP(r.E.chg)}</small></li>`; }).join('')}</ol>` : `<p class="hint">지금은 조건을 모두 만족하는 종목이 없어요. 1개 부족 ${D.rows.filter(r => !r.E.all && r.E.pass === r.E.need - 1).length}종목.</p>`}`;
  const b = $('#kcGo'); if (b) b.onclick = () => { switchTab('kc'); renderKc(); };
  $$('#kcDash [data-kcan]').forEach(el => el.onclick = () => showAnalysis(el.dataset.kcan));
}
async function kcLoop(force) {
  if (KC.busy || !S.data) return;
  const onTab = $('#tab-kc') && $('#tab-kc').classList.contains('on'), onDash = $('#tab-dash') && $('#tab-dash').classList.contains('on');
  if (!force && (document.hidden || (!onTab && !onDash))) return;
  KC.busy = true;
  try { if (kcOpenMkt() && typeof sfLoad === 'function') await sfLoad(); KC.lt = 0; if (onTab) renderKc(); if (onDash) renderKcDash(); } catch (e) { console.error(e); }
  KC.busy = false;
}
function initKc() {
  const cf = $('#kcCfg'); if (cf) cf.innerHTML = kcCfgHtml(kcCfg());
  const save = () => { const c = kcCfg(); $$('#kcCfg [data-kcon]').forEach(x => { c.on[x.dataset.kcon] = x.checked ? 1 : 0; }); $$('#kcCfg [data-kcv]').forEach(x => { const v = parseFloat(x.value); if (Number.isFinite(v)) c[x.dataset.kcv] = v; }); store.set('kcCfg', c); KC.bt = null; KC.lt = 0; renderKc(); };
  $$('#kcCfg input').forEach(x => x.onchange = save);
  const rs = $('#kcReset'); if (rs) rs.onclick = () => { store.set('kcCfg', null); $('#kcCfg').innerHTML = kcCfgHtml(kcCfg()); initKcBind(save); KC.bt = null; KC.lt = 0; renderKc(); };
  ['kcMkt', 'kcLvl', 'kcSort', 'kcTv'].forEach(id => { const el = $('#' + id); if (el) el.onchange = () => { KC.n = 40; renderKc(); }; });
  const q = $('#kcQ'); if (q) q.oninput = () => renderKc();
  kcLoop(true); setInterval(() => kcLoop(false), 60e3);
  const tb = $('button[data-tab="kc"]'); if (tb) tb.addEventListener('click', () => { renderKc(); kcLoop(true); });
  if (typeof FM !== 'undefined') FM.kc_score = { key: 'kc_score', label: '조건검색식 가능성 점수(5일선 돌파 +5%)', group: '종합', type: 'num', unit: '점', get: s => { const D = KC.last; if (!D) return null; const r = D.rows.find(x => x.s === s); return r ? r.total : null; } };
}
function initKcBind(save) { $$('#kcCfg input').forEach(x => x.onchange = save); const rs = $('#kcReset'); if (rs) rs.onclick = () => { store.set('kcCfg', null); $('#kcCfg').innerHTML = kcCfgHtml(kcCfg()); initKcBind(save); KC.bt = null; KC.lt = 0; renderKc(); }; }
(function waitBootKc() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initKc();
  else setTimeout(waitBootKc, 900);
})();
