/* 투자자 흐름 — 실시간 해설 · 종합평가
   ① 시장 해설: /api/mflow 의 시간대별 누적(1분마다)을 훑어 매수·매도 전환, 매수 가속, 장중 최고치 같은 「변곡점」을 시각과 함께 문장으로
   ② 종목 해설: 장중 잠정 수급(하루 4번)이 들어올 때마다 이 기기에 그 시각 값을 저장해 두고, 직전 대비 늘고 준 것을 문장으로
   ③ 종합평가: 수급 점수 · 국면 · 주가와의 일치/괴리 · 거래대금 흐름 · 공매도 · 외국인 평균 매수가 · 오늘 장중 방향을 묶어 A~E 등급과 결론 */
'use strict';

const IVL = { filter: 'all', seen: new Set(), lastFlow: null };
const ivlTH = { KOSPI: 300, KOSDAQ: 100 };   // 시장 해설 기준(억원): 30분 남짓 사이 이만큼 움직이면 「눈에 띄는 변화」
const ivGa = w => { const c = w.charCodeAt(w.length - 1); return w + (c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '이' : '가'); };

/* ── ① 시장: 시간대별 누적에서 변곡점 찾기 ── */
function ivMarketEvents() {
  const out = [];
  ['KOSPI', 'KOSDAQ'].forEach(m => {
    const L = INV.m && INV.m.mkt && INV.m.mkt[m]; if (!L || !L.time || L.time.length < 2) return;
    const rows = L.time.slice().reverse(), nm = m === 'KOSPI' ? '코스피' : '코스닥', th = ivlTH[m];
    ['외국인', '기관', '개인', '연기금'].forEach(k => {
      let hi = -Infinity, lo = Infinity;
      rows.forEach((r, i) => {
        const v = r[k]; if (v == null) return;
        const p = i ? rows[i - 1][k] : null;
        if (p != null) {
          const d = v - p, t = r.t;
          if (Math.sign(v) !== Math.sign(p) && Math.abs(v) >= th * 0.3) out.push({ t, m, k, lvl: 2, tone: v > 0 ? 'up' : 'down', txt: `${nm} ${ivGa(k)} 누적 ${v > 0 ? '순매수로 돌아섰어요' : '순매도로 돌아섰어요'} (${ivEok(p)} → ${ivEok(v)})` });
          else if (Math.abs(d) >= (k === '연기금' ? th * 0.25 : th)) out.push({ t, m, k, lvl: 1, tone: d > 0 ? 'up' : 'down', txt: `${nm} ${k} ${p ? `직전(${rows[i - 1].t}) 대비 ` : ''}${d > 0 ? '매수' : '매도'} ${ivEok(Math.abs(d)).replace(/^[+−]/, '')} 늘어 누적 ${ivEok(v)}${(d > 0) === (v > 0) ? ' — 같은 방향으로 가속' : ' — 방향을 되돌리는 중'}` });
        }
        if (i >= 2 && v > hi && v > 0 && v - Math.max(hi, 0) >= th * 0.5 && hi > -Infinity) out.push({ t: r.t, m, k, lvl: 0, tone: 'up', txt: `${nm} ${k} 순매수 오늘 최고치 경신 ${ivEok(v)}` });
        if (i >= 2 && v < lo && v < 0 && Math.min(lo, 0) - v >= th * 0.5 && lo < Infinity) out.push({ t: r.t, m, k, lvl: 0, tone: 'down', txt: `${nm} ${k} 순매도 오늘 최대치 ${ivEok(v)}` });
        hi = Math.max(hi, v); lo = Math.min(lo, v);
      });
    });
  });
  // 같은 시각·같은 주체에 더 중요한 해설이 있으면 「최고치」 문장은 뺌
  return out.filter(e => e.lvl > 0 || !out.some(x => x !== e && x.lvl > 0 && x.t === e.t && x.m === e.m && x.k === e.k));
}

/* ── ② 종목: 장중 잠정 수급 스냅숏 저장(이 기기 · 하루치) ── */
function ivSnapKey() { return 'ivSnap_' + new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function ivSnapSave() {
  if (typeof FLOW === 'undefined' || !FLOW.d || !FLOW.d.meta || !FLOW.d.meta.intraday) return;
  const t = FLOW.d.meta.time; if (IVL.lastFlow === t) return; IVL.lastFlow = t;
  if (String(t).slice(0, 10) !== new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)) return;   // 오늘 장중 자료만
  const k = ivSnapKey(), o = store.get(k, {}) || {};
  if (o[t]) return;
  const snap = {};
  S.data.stocks.forEach(s => { const f = s._flow; if (f && f.f1 != null) snap[s.code] = [f.f1, f.i1, f.p1 != null ? f.p1 : null]; });
  o[t] = snap;
  const keys = Object.keys(o).sort(); while (keys.length > 8) delete o[keys.shift()];
  try { store.set(k, o); } catch (e) {}
  // 지난 날짜 기록 지우기
  try { Object.keys(localStorage).filter(x => x.startsWith('scr_ivSnap_') && x !== 'scr_' + k).forEach(x => localStorage.removeItem(x)); } catch (e) {}
}
function ivStockEvents(code) {
  const o = store.get(ivSnapKey(), {}) || {}, ts = Object.keys(o).sort(), out = [];
  const nm = ['외국인', '기관', '개인'];
  for (let j = 0; j < ts.length; j++) {
    const cur = o[ts[j]][code], prev = j ? o[ts[j - 1]][code] : null; if (!cur) continue;
    const t = ts[j].slice(11);
    cur.forEach((v, i) => {
      if (v == null) return;
      const p = prev ? prev[i] : null;
      if (p == null) { if (Math.abs(v) >= 5) out.push({ t, k: nm[i], tone: v > 0 ? 'up' : 'down', txt: `${t} 잠정 ${nm[i]} ${ivEok(v)}` }); return; }
      const d = v - p;
      if (Math.sign(v) !== Math.sign(p) && Math.abs(v) >= 3) out.push({ t, k: nm[i], tone: v > 0 ? 'up' : 'down', txt: `${t} ${ivGa(nm[i])} ${v > 0 ? '순매수로 전환' : '순매도로 전환'} (${ivEok(p)} → ${ivEok(v)})` });
      else if (Math.abs(d) >= Math.max(3, Math.abs(p) * 0.4)) out.push({ t, k: nm[i], tone: d > 0 ? 'up' : 'down', txt: `${t} ${nm[i]} ${d > 0 ? '매수' : '매도'} 강화 — 직전 ${ts[j - 1].slice(11)} ${ivEok(p)} → ${ivEok(v)}` });
    });
  }
  return out;
}
/* 장중 수급이 크게 바뀐 종목(직전 스냅숏 대비) */
function ivMovers() {
  const o = store.get(ivSnapKey(), {}) || {}, ts = Object.keys(o).sort(); if (ts.length < 2) return [];
  const a = o[ts[ts.length - 1]], b = o[ts[ts.length - 2]], M = [];
  Object.entries(a).forEach(([c, v]) => { const p = b[c]; if (!p) return; const d = (v[0] || 0) - (p[0] || 0); if (Math.abs(d) >= 10) M.push({ c, d, v: v[0] }); });
  return M.sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 12).map(x => ({ ...x, t: ts[ts.length - 1].slice(11), t0: ts[ts.length - 2].slice(11) }));
}

/* ── ③ 종합평가(종목) ── */
function ivVerdict(s, a) {
  if (!a) a = ivAnalyze(s); if (!a) return null;
  const P = [], M = [], cond = [];
  let sc = 50 + a.sc * 0.35;
  const ret5 = s.ret5 || 0, big5 = (a.sum.f5 || 0) + (a.sum.p5 || 0) + ((a.sum.i5 || 0) - (a.sum.p5 || 0)) * 0.5;
  const rgPts = { accum: 10, turn: 6, fdrive: 6, dip: 4, mixed: 0, exit: -10, retail: -12 }[a.rg[0]] || 0;
  sc += rgPts; (rgPts >= 0 ? P : M).push(`국면: ${a.rg[1]}`);
  // 주가와 수급의 일치/괴리
  if (big5 > 0 && ret5 > 1) { sc += 6; P.push(`주가(1주 ${pct(ret5, 1)})와 큰손 매수가 같은 방향 — 수급이 확인해 주는 상승`); }
  else if (big5 < 0 && ret5 > 2) { sc -= 10; M.push(`주가는 1주 ${pct(ret5, 1)} 올랐는데 큰손은 팔고 있어요 — 개인이 끌어올린 상승은 오래가기 어려워요`); }
  else if (big5 > 0 && ret5 < -2) { sc += 4; P.push(`주가는 1주 ${pct(ret5, 1)} 빠졌는데 큰손은 사고 있어요 — 하락 속 매집(기회일 수 있음)`); }
  else if (big5 < 0 && ret5 < -1) { sc -= 6; M.push(`주가 하락(1주 ${pct(ret5, 1)})과 큰손 매도가 같은 방향 — 하락을 수급이 확인`); }
  // 오늘 장중 방향
  const tf = a.today.f;
  if (a.Z.partial && tf != null) { if (tf > 0 && (a.sum.f5 || 0) > 0) { sc += 4; P.push(`오늘도 외국인 ${ivEok(tf)} 순매수(장중 잠정) — 흐름 유지`); } else if (tf < 0 && (a.sum.f5 || 0) > 0) { sc -= 5; M.push(`오늘 외국인 ${ivEok(tf)} 순매도(장중 잠정) — 5일 매수 흐름이 꺾이는지 확인`); } else if (tf > 0 && (a.sum.f5 || 0) < 0) { sc += 3; P.push(`오늘 외국인 ${ivEok(tf)} 순매수 — 매도 흐름 속 전환 시도`); } }
  // 외국인 평균 매수가
  if (a.fPl != null) { if (a.fPl < -3) { sc += 3; P.push(`지금 가격이 외국인 평균 매수가(약 ${fmt(Math.round(a.fAvg))}원)보다 ${fmt(-a.fPl, 1)}% 낮아요 — 외국인이 버틸 가격대`); } else if (a.fPl > 12) { sc -= 4; M.push(`외국인 평균 매수가보다 ${fmt(a.fPl, 1)}% 높아요 — 외국인 차익 매도가 나올 수 있는 구간`); } }
  // 연기금 꾸준함
  if (a.st.p >= 3) { sc += 4; P.push(`연기금 ${a.st.p}일 연속 순매수`); } else if (a.st.p <= -3) { sc -= 4; M.push(`연기금 ${-a.st.p}일 연속 순매도`); }
  // 개인 쏠림
  if ((a.sum.r5 || 0) > 0 && a.tvAvg && a.sum.r5 >= a.tvAvg * 1.5) { sc -= 5; M.push(`개인 5일 순매수 ${ivEok(a.sum.r5)} — 하루 평균 거래대금의 ${fmt(a.sum.r5 / a.tvAvg, 1)}배가 개인에게 쏠림`); }
  // 거래대금 흐름 · 공매도
  const tvf = s._tvf; if (tvf) { if (tvf.k === 'up' || tvf.k === 'hold') { sc += 4; P.push(`거래대금 ${tvf.name}`); } else if (tvf.k === 'down' || tvf.k === 'dump') { sc -= 5; M.push(`거래대금 ${tvf.name}`); } }
  if (s._short && typeof shAnalyze === 'function') { try { const sh = shAnalyze(s); if (sh.regime[0] === 'cover') { sc += 3; P.push('공매도 되사기(숏커버) 진행'); } else if (sh.regime[0] === 'bear') { sc -= 4; M.push('공매도 잔고 증가 + 주가 하락'); } } catch (e) {} }
  sc = Math.round(Math.max(0, Math.min(100, sc)));
  const g = sc >= 75 ? ['A', '수급 매우 좋음'] : sc >= 62 ? ['B', '수급 좋음'] : sc >= 45 ? ['C', '중립'] : sc >= 32 ? ['D', '수급 나쁨'] : ['E', '수급 매우 나쁨'];
  // 판단이 바뀌는 조건
  if ((a.sum.f5 || 0) > 0) cond.push('외국인이 이틀 연속 순매도로 돌아서면 판단을 한 단계 낮춰요');
  else cond.push('외국인이 이틀 연속 순매수로 돌아서면 판단을 한 단계 올려요');
  if (a.fAvg) cond.push(`주가가 외국인 평균 매수가 ${fmt(Math.round(a.fAvg))}원 ${a.px >= a.fAvg ? '아래로 내려가면 외국인 손절 매물 주의' : '위로 올라서면 외국인 손익이 플러스로 바뀌어 매도 부담이 줄어요'}`);
  if (a.rg[0] === 'retail') cond.push('외국인·기관 중 한쪽이라도 순매수로 돌아서야 주의 해제');
  const head = sc >= 62 ? `큰손이 사고 있고 주가도 이를 따라가는 종목이에요` : sc >= 45 ? `수급만으로는 방향을 정하기 어려워요 — 다른 신호를 함께 보세요` : `큰손이 빠지고 있어 수급상 불리한 종목이에요`;
  return { sc, g, head, P, M, cond };
}
function ivVerdictHtml(s, a) {
  const V = ivVerdict(s, a); if (!V) return '';
  const ev = ivStockEvents(s.code).slice(-8).reverse();
  return `<div class="ivv g${V.g[0]}"><div class="ivv-h"><b class="ivv-g">${V.g[0]}</b><div><small>수급 종합평가 ${V.sc}점 · ${V.g[1]}</small><p>${esc(V.head)}</p></div></div>
    <div class="ivv-cols">${V.P.length ? `<ul class="ivv-p">${V.P.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${V.M.length ? `<ul class="ivv-m">${V.M.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>
    <p class="ivv-c"><b>판단이 바뀌는 조건</b> ${V.cond.map(esc).join(' · ')}</p>
    ${ev.length ? `<div class="ivv-ev"><b>오늘 장중 해설</b>${ev.map(e => `<p class="${e.tone}">${esc(e.txt)}</p>`).join('')}</div>` : (a && a.Z.partial ? '<p class="hint">오늘 장중 잠정 수급이 두 번 이상 들어오면 그 사이 변화를 해설해요(이 화면을 열어 둔 기기에 기록).</p>' : '')}
  </div>`;
}

/* ── 시장 종합평가 ── */
function ivMarketVerdict() {
  const R = [];
  ['KOSPI', 'KOSDAQ'].forEach(m => {
    const nm = m === 'KOSPI' ? '코스피' : '코스닥';
    const L = INV.m && INV.m.mkt && INV.m.mkt[m], last = L && L.time && L.time[0] ? L.time[0] : L && L.day && L.day[0] ? L.day[0] : null;
    const K = INV.d && INV.d.mkt && INV.d.mkt[m];
    const f20 = K && K['외국인'] ? K['외국인'].slice(-20).reduce((a, x) => a + (x || 0), 0) : null, p20 = K && K['연기금'] ? K['연기금'].slice(-20).reduce((a, x) => a + (x || 0), 0) : null, r20 = K && K['개인'] ? K['개인'].slice(-20).reduce((a, x) => a + (x || 0), 0) : null;
    const f = last ? last['외국인'] : null, r = last ? last['개인'] : null, i = last ? last['기관'] : null, p = last ? last['연기금'] : null;
    let head, tone;
    if (f != null && r != null) {
      if (f > 0 && r < 0) { head = '외국인 주도 — 외국인이 사고 개인이 파는 날'; tone = 'up'; }
      else if (f < 0 && r > 0 && (i || 0) < 0) { head = '개인 혼자 받는 날 — 외국인·기관이 함께 판다'; tone = 'down'; }
      else if (f < 0 && (i || 0) > 0) { head = '기관 방어 — 외국인 매도를 기관이 받는 중'; tone = ''; }
      else if (f > 0 && (i || 0) > 0) { head = '큰손 동반 매수 — 외국인·기관이 함께 산다'; tone = 'up'; }
      else { head = '주체 엇갈림'; tone = ''; }
    } else head = '오늘 장중 자료 대기';
    const trend = f20 != null ? `20일 누적 외국인 ${ivEok(f20)}${p20 != null ? ` · 연기금 ${ivEok(p20)}` : ''}${r20 != null ? ` · 개인 ${ivEok(r20)}` : ''}` : '';
    const tip = f != null && f20 != null ? (f > 0 && f20 > 0 ? '오늘도 외국인 순매수 — 한 달 매수 흐름이 이어지는 중이라 지수 우호적이에요.' : f > 0 && f20 < 0 ? '한 달간 팔던 외국인이 오늘은 사요 — 하루로 끝나는지 이어지는지가 관건이에요.' : f < 0 && f20 > 0 ? '한 달간 사던 외국인이 오늘은 팔아요 — 차익 실현인지 방향 전환인지 내일까지 확인하세요.' : '외국인 매도가 한 달째 이어져요 — 반등이 나와도 위에서 막히기 쉬운 시장이에요.') : '';
    R.push({ nm, head, tone, trend, tip, p });
  });
  return R;
}

/* ── 화면 ── */
function renderIvLive() {
  const box = $('#ivLive'); if (!box) return;
  ivSnapSave();
  const MV = ivMarketVerdict();
  const mine = new Set([...(typeof hLoad === 'function' ? hLoad().items.map(h => h.code) : []), ...(store.get('tmWatch', []) || [])]);
  let ev = ivMarketEvents().map(e => ({ ...e, src: 'mkt' }));
  const codes = IVL.filter === 'mine' ? [...mine] : [...mine, INV.sel].filter(Boolean);
  codes.forEach(c => { const s = S.data.stocks.find(x => x.code === c); if (!s) return; ivStockEvents(c).forEach(e => ev.push({ ...e, txt: `${s.name}: ${e.txt.replace(/^\d{2}:\d{2} /, '')}`, src: 'stk', code: c })); });
  if (IVL.filter === 'mine') ev = ev.filter(e => e.src === 'stk');
  ev.sort((a, b) => (b.t || '').localeCompare(a.t || '') || (b.lvl || 0) - (a.lvl || 0));
  const mv = ivMovers();
  box.innerHTML = `<div class="ivl-grid">
    <section class="ivl-mv"><h4>시장 종합평가</h4>${MV.map(v => `<div class="ivl-mvc ${v.tone}"><b>${v.nm}</b><p class="ivl-h">${esc(v.head)}</p>${v.trend ? `<p class="hint">${esc(v.trend)}</p>` : ''}${v.tip ? `<p>${esc(v.tip)}</p>` : ''}</div>`).join('')}</section>
    <section class="ivl-feed"><h4>실시간 해설 <span class="row gap"><button class="chip ${IVL.filter === 'all' ? 'on' : ''}" data-ivlf="all">시장+내 종목</button><button class="chip ${IVL.filter === 'mine' ? 'on' : ''}" data-ivlf="mine">내 종목만</button></span></h4>
      ${ev.length ? `<ul>${ev.slice(0, 40).map(e => `<li class="${e.tone} lv${e.lvl || 0}"${e.code ? ` data-ivs="${esc(e.code)}"` : ''}><time>${esc(e.t || '')}</time><span>${esc(e.txt)}</span></li>`).join('')}</ul>` : `<p class="hint">${INV.m ? '아직 눈에 띄는 변화가 없어요. 장중에는 1분마다 다시 확인해요.' : '장중(9:00~15:30)에 시장 투자자별 흐름이 들어오면 변화를 문장으로 알려드려요.'}</p>`}
      ${mv.length ? `<h5 class="sh-h">장중 외국인 수급이 크게 바뀐 종목 <small class="muted">${esc(mv[0].t0)} → ${esc(mv[0].t)} 잠정</small></h5><div class="ivl-mvs">${mv.map(x => { const s = S.data.stocks.find(y => y.code === x.c); return s ? `<button class="mn-chip ${x.d > 0 ? 'good' : 'bad'}" data-ivs="${esc(x.c)}">${esc(s.name)} <small>${x.d > 0 ? '+' : '−'}${fmt(Math.abs(x.d), 0)}억 → ${ivEok(x.v)}</small></button>` : ''; }).join('')}</div>` : ''}
    </section></div>`;
  $$('#ivLive [data-ivlf]').forEach(b => b.onclick = () => { IVL.filter = b.dataset.ivlf; renderIvLive(); });
  $$('#ivLive [data-ivs]').forEach(b => b.onclick = () => ivSelect(b.dataset.ivs));
}
(function waitIvl() {
  if (typeof INV !== 'undefined' && typeof S !== 'undefined' && S.data && S.data.stocks) {
    setInterval(() => { ivSnapSave(); const on = $('#tab-inv') && $('#tab-inv').classList.contains('on'); if (on && !document.hidden) renderIvLive(); }, 30e3);
  } else setTimeout(waitIvl, 800);
})();
