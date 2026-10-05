/* 종목 비교 — 관심 종목 2~6개를 같은 잣대로 나란히 놓고, 항목별로 누가 나은지 표시한 뒤 종합 점수로 「픽」을 골라요.
   잣대: 매수 타이밍(규칙 엔진) · 차트 힘 · 위험 대비 보상 · 수급 · 흐름(모멘텀) · 실적·재무 · 재료·일정 */
'use strict';

const CMP = { busy: false, last: null };
const cmpList = () => (store.get('cmpList', []) || []).filter(Boolean);
const cmpSave = a => store.set('cmpList', [...new Set(a)].slice(0, 6));
const josa = (w, a, b) => { const c = String(w).charCodeAt(String(w).length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? a : b; };
const cl100 = v => Math.max(0, Math.min(100, Math.round(v)));
const CMP_CAT = [
  ['tv', '거래대금 흐름', 25, '거래가 많은 날 돈이 시가 위로 밀었나(유입)·시가를 지켰나(지지)·시가 아래로 빠졌나(이탈)'],
  ['tm', '매수 타이밍', 20, '규칙 엔진이 지금 사라고 하는지'],
  ['ch', '차트 힘', 12, '6축 차트 종합 점수'],
  ['rr', '위험 대비 보상', 12, '손절까지 거리가 짧고 위로 갈 여유가 큰지'],
  ['fl', '수급', 12, '외국인·기관이 사는지, 공매도가 줄어드는지'],
  ['mo', '흐름', 7, '최근 1주·1달 상승과 업종 강도'],
  ['fu', '실적·재무', 6, '영업이익·매출 증가, ROE, 부채'],
  ['ev', '재료·일정', 6, '뉴스·공시, 다가오는 실적 발표'],
];

function cmpEval(code) {
  const D = tmDecide(code); if (!D) return null;
  const s = D.s || {}, R = D.R, p = D.plan, c = {}, why = {};
  // 매수 타이밍
  c.tm = cl100(({ BUY: 90, WAIT: 62, WATCH: 30, NO: 5 }[D.act] ?? (D.mode === 'hold' ? ({ HOLD: 60, TAKE: 45, PART: 35, HALF: 20, EXIT: 5 }[D.act] ?? 40) : 30)) + (R.trend.ok ? 10 : -10));
  why.tm = D.mode === 'hold' ? `보유 중 — ${(TM_ACT[D.act] || [''])[0]}` : `${(TM_ACT[D.act] || [''])[0]}${R.trend.ok ? ' · 추세 통과' : ' · 추세 실패'}`;
  // 차트 힘
  c.ch = s.cl ? cl100((s.cl.s + 100) / 2) : 50; why.ch = s.cl ? `${s.cl.v} ${s.cl.s > 0 ? '+' : ''}${fmt(s.cl.s, 1)}` : '판정 없음';
  // 위험 대비 보상: 손절폭(짧을수록) + 위 저항까지 여유
  const E = p ? p.E : R.P, stop = p ? p.stop : tmDn(R.P * 0.93), risk = (E - stop) / E * 100;
  const up = (R.hi60 > E * 1.01 ? (R.hi60 / E - 1) * 100 : 15);
  c.rr = cl100(100 - risk * 9 + Math.min(up, 20) * 1.5 - (s.atr_pct > 6 ? 10 : 0)); why.rr = `손절 ${fmt(risk, 1)}% · 위 여유 ${fmt(up, 1)}%${s.atr_pct ? ` · 하루 흔들림 ${fmt(s.atr_pct, 1)}%` : ''}`;
  // 수급
  const fs = s.foreign_streak || 0, is = s.inst_streak || 0;
  c.fl = cl100(50 + Math.max(-5, Math.min(5, fs)) * 6 + Math.max(-5, Math.min(5, is)) * 5 - (s.short_chg >= 0.3 ? 12 : s.short_chg <= -0.3 ? -6 : 0) + (s.pension_5pct ? 5 : 0));
  why.fl = `외국인 ${fs > 0 ? fs + '일 매수' : fs < 0 ? -fs + '일 매도' : '–'} · 기관 ${is > 0 ? is + '일 매수' : is < 0 ? -is + '일 매도' : '–'}${s.short_chg != null ? ` · 공매도 ${s.short_chg > 0 ? '+' : ''}${fmt(s.short_chg, 2)}%p` : ''}`;
  // 흐름
  const rk = typeof SR !== 'undefined' && SR.cur && SR.cur.ALL ? SR.cur.ALL[s.sector] : null, nSec = rk != null ? Object.keys(SR.cur.ALL).length : 0;
  c.mo = cl100(50 + Math.max(-25, Math.min(25, (s.ret20 || 0) * 1.2)) + Math.max(-10, Math.min(10, (s.ret5 || 0))) + (rk != null && nSec ? (0.5 - rk / nSec) * 20 : 0) - (R.rsi >= 75 ? 10 : 0));
  why.mo = `1주 ${pct(s.ret5, 1)} · 1달 ${pct(s.ret20, 1)}${rk != null ? ` · 업종 ${rk}위` : ''}${R.rsi >= 75 ? ' · 과열' : ''}`;
  // 실적·재무
  let fu = 50, fw = [];
  if (typeof s.op_yoy === 'number') { fu += Math.max(-20, Math.min(20, s.op_yoy / 3)); fw.push(`영업이익 ${pct(s.op_yoy, 0)}`); }
  if (typeof s.sales_yoy === 'number') { fu += Math.max(-8, Math.min(8, s.sales_yoy / 4)); }
  const roe = Array.isArray(s.roe3) ? (s.roe3.filter(x => x != null).length ? s.roe3.filter(x => x != null).reduce((p, x) => p + x, 0) / s.roe3.filter(x => x != null).length : null) : (typeof s.roe3 === 'number' ? s.roe3 : null);
  if (roe != null) { fu += Math.max(-10, Math.min(12, roe - 8)); fw.push(`ROE 3년 평균 ${fmt(roe, 1)}%`); }
  if (s.profit_q != null && s.profit_q <= 1) { fu -= 8; fw.push(`최근 4분기 중 흑자 ${s.profit_q}번`); }
  if (typeof s.debt_ratio === 'number' && !s.is_fin) { if (s.debt_ratio > 200) { fu -= 12; fw.push(`부채 ${fmt(s.debt_ratio, 0)}%`); } else if (s.debt_ratio < 80) fu += 4; }
  if (s.op_turn) { fu += 8; fw.push('흑자 전환'); }
  c.fu = cl100(Number.isFinite(fu) ? fu : 50); why.fu = fw.join(' · ') || '자료 없음';
  // 재료·일정
  let ev = 50, ew = [];
  if (s._newsLive != null) { ev += Math.max(-20, Math.min(20, s._newsLive / 2)); if (Math.abs(s._newsLive) >= 20) ew.push(s._newsLive > 0 ? '호재 뉴스 우세' : '악재 뉴스 우세'); }
  if (D.ctx.risk.length) { ev -= 20; ew.push('악재·물량 공시'); }
  if (D.ctx.good.length) { ev += 12; ew.push('호재 공시'); }
  const earn = D.ctx.cal.find(x => !x.past && x.kind === 'earn' && x.url && tmBizBetween(tmNow().date, x.d) <= 3);
  if (earn) { ev -= 8; ew.push(`실적 발표 ${earn.d.slice(5).replace('-', '/')}`); }
  if (s._alert) { ev -= 30; ew.push('시장경보'); }
  c.ev = cl100(ev); why.ev = ew.join(' · ') || '특이 사항 없음';
  const tvf = s._tvf || (typeof volAll === 'function' && volAll().get(code) ? volAll().get(code).tvf : null);
  c.tv = tvf ? cl100(50 + tvf.s / 2) : 50; why.tv = tvf ? `${tvf.name} ${tvf.s > 0 ? '+' : ''}${tvf.s} · 거래량 ${fmt(tvf.vr, 1)}배 · 대금 전날의 ${fmt(tvf.d1, 2)}배 · 시가 대비 ${tvf.oc > 0 ? '+' : ''}${fmt(tvf.oc, 1)}%` : '자료 없음';
  const total = Math.round(CMP_CAT.reduce((a, [k, , w]) => a + c[k] * w, 0) / CMP_CAT.reduce((a, x) => a + x[2], 0));
  return { code, name: s.name || code, D, c, why, total, risk, up, held: D.mode === 'hold' };
}

async function cmpCollect() {
  const codes = cmpList();
  await Promise.all(codes.map(async c => { try { await tmLoadBars(c); const st = TM.st.get(c); if (!st.qt || Date.now() - st.qt > 120e3) await tmQuote(c); await tmEvents(c); } catch (e) {} }));
  const L = []; for (const c of codes) { try { const x = TM.st.get(c) && TM.st.get(c).f ? cmpEval(c) : null; L.push(x || { code: c, name: (S.data.stocks.find(s => s.code === c) || {}).name || c, err: true }); } catch (e) { console.error(e); L.push({ code: c, err: true }); } }
  const ok = L.filter(x => !x.err).sort((a, b) => b.total - a.total);
  ok.forEach((x, i) => { x.rank = i + 1; });
  return { list: ok, bad: L.filter(x => x.err), at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16) };
}

/* 1위가 2위보다 나은 점 / 못한 점 */
function cmpVs(a, b) {
  const diffs = CMP_CAT.map(([k, n, w]) => ({ k, n, d: a.c[k] - b.c[k], w })).sort((x, y) => y.d * y.w - x.d * x.w);
  return { win: diffs.filter(x => x.d >= 8).slice(0, 3), lose: diffs.filter(x => x.d <= -8).sort((x, y) => x.d * x.w - y.d * y.w).slice(0, 2) };
}
function cmpPickWhy(P) {
  const [a, b] = P.list; if (!a) return null;
  const out = { lines: [], warn: [] };
  if (!b) { out.lines.push('비교할 종목이 하나뿐이에요. 2개 이상 넣으면 누가 더 나은지 비교해요.'); return out; }
  const v = cmpVs(a, b);
  v.win.forEach(x => out.lines.push(`${x.n}: ${a.name} ${a.c[x.k]}점 vs ${b.name} ${b.c[x.k]}점 — ${a.why[x.k]}`));
  v.lose.forEach(x => out.warn.push(`${x.n}${josa(x.n, '은', '는')} ${b.name}${josa(b.name, '이', '가')} 나아요(${b.c[x.k]} vs ${a.c[x.k]}) — ${a.name}: ${a.why[x.k]}`));
  if (a.total - b.total < 4) out.warn.push(`두 종목 점수 차이가 ${a.total - b.total}점뿐이에요. 사실상 비슷하니 손절폭이 짧은 쪽(${a.risk <= b.risk ? a.name : b.name}, ${fmt(Math.min(a.risk, b.risk), 1)}%)부터 사는 게 실전적이에요.`);
  if (a.D.act === 'WATCH' || a.D.act === 'NO') out.warn.push(`1위지만 지금은 규칙상 매수 신호가 없어요(${(TM_ACT[a.D.act] || [''])[0]}). 「상대적으로 낫다」일 뿐 「지금 사라」는 아니에요.`);
  const weak = CMP_CAT.map(([k, n]) => ({ k, n, v: a.c[k] })).sort((x, y) => x.v - y.v)[0];
  if (weak.v < 40) out.warn.push(`${a.name}의 약점은 「${weak.n}」(${weak.v}점) — ${a.why[weak.k]}`);
  return out;
}
function cmpOneLine(x) {
  const best = CMP_CAT.map(([k, n]) => ({ n, v: x.c[k] })).sort((a, b) => b.v - a.v)[0], worst = CMP_CAT.map(([k, n]) => ({ n, v: x.c[k] })).sort((a, b) => a.v - b.v)[0];
  return `강점 ${best.n}(${best.v}) · 약점 ${worst.n}(${worst.v})`;
}

function cmpHtml(P) {
  const L = P.list;
  if (!L.length) return `<p class="rp-none">${P.bad.length ? '넣은 종목의 일봉 자료를 받지 못했어요.' : '비교할 종목을 2개 이상 넣어주세요. 관심 종목·보유 종목·매수 계획 후보를 버튼 하나로 가져올 수 있어요.'}</p>`;
  const a = L[0], why = cmpPickWhy(P), p = a.D.plan;
  const best = k => Math.max(...L.map(x => x.c[k]));
  const cols = L.map(x => `<th class="${x.rank === 1 ? 'pick' : ''}"><span class="cmp-rk">${x.rank}위</span><b>${esc(x.name)}</b><small>${x.held ? '보유 중' : esc(x.D.s ? x.D.s.sector : '')}</small><button class="pl-x" data-cmpx="${esc(x.code)}" aria-label="비교에서 빼기" title="비교에서 빼기">×</button></th>`).join('');
  const cell = (x, k) => `<td class="${x.c[k] === best(k) && L.length > 1 && Math.min(...L.map(y => y.c[k])) < best(k) ? 'best' : ''}${x.rank === 1 ? ' pick' : ''}"><div class="cmp-cell"><b>${x.c[k]}</b><span class="cmp-bar"><i style="width:${x.c[k]}%"></i></span></div><small>${esc(x.why[k])}</small></td>`;
  return `<article class="cmp">
    <section class="cmp-hero">
      <p class="rp-l">${L.length}종목 비교 결과 · ${esc(P.at)} 기준</p>
      <div class="cmp-pick"><div><h3>${esc(a.name)}</h3><p>${tmTag(a.D.act)} 종합 <b>${a.total}점</b>${L[1] ? ` · 2위 ${esc(L[1].name)} ${L[1].total}점` : ''}</p></div>
        <div class="cmp-total"><b>${a.total}</b><span>/100</span></div></div>
      ${why && why.lines.length ? `<h5>왜 ${esc(a.name)}인가</h5><ul class="cmp-why">${why.lines.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${why && why.warn.length ? `<h5>그래도 알아둘 점</h5><ul class="cmp-warn">${why.warn.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${p && (a.D.act === 'BUY' || a.D.act === 'WAIT') ? `<p class="cmp-plan">${a.D.act === 'BUY' ? '지금' : '지정가'} <b>${tmW(p.E)}</b>에 1차 <b>${fmt(p.q1)}주</b>(${hWon(p.amt1)}) · 손절 <b class="down">${tmW(p.stop)}</b> · 목표 <b class="down">${tmW(p.t1)}</b> / ${tmW(p.t2)}</p>` : a.D.mode === 'hold' ? `<p class="cmp-plan">보유 중 — ${esc(a.D.head)}</p>` : ''}
      <div class="row gap wrap mt-s"><button class="btn small primary" data-cmpt="${esc(a.code)}">${esc(a.name)} 매매 타이밍 보기</button><button class="btn ghost small" data-cmpp="${esc(a.code)}">내일 매수 계획에 넣기</button></div>
    </section>
    <div class="cmp-wrap"><table class="cmp-tb" style="--n:${L.length}">
      <colgroup><col class="c-lbl">${L.map(() => '<col class="c-stk">').join('')}</colgroup><thead><tr><th class="lbl">항목 <small>(가중치)</small></th>${cols}</tr></thead>
      <tbody>
        <tr class="tot"><th class="lbl">종합 점수</th>${L.map(x => `<td class="${x.rank === 1 ? 'pick' : ''}"><b class="cmp-big">${x.total}</b><small>${esc(cmpOneLine(x))}</small></td>`).join('')}</tr>
        ${CMP_CAT.map(([k, n, w, d]) => `<tr><th class="lbl">${n} <small>${w}%</small><span>${d}</span></th>${L.map(x => cell(x, k)).join('')}</tr>`).join('')}
        <tr class="raw"><th class="lbl">현재가</th>${L.map(x => `<td class="mono${x.rank === 1 ? ' pick' : ''}">${tmW(x.D.P)} <small class="${cls(x.D.ctx.chg)}">${pct(x.D.ctx.chg, 1)}</small></td>`).join('')}</tr>
        <tr class="raw"><th class="lbl">매수 / 손절 / 목표</th>${L.map(x => { const q = x.D.plan; return `<td class="mono${x.rank === 1 ? ' pick' : ''}">${q ? `${fmt(q.E)}<br><span class="down">${fmt(q.stop)}</span> / <span class="down">${fmt(q.t1)}</span>` : x.D.mode === 'hold' ? `손절 ${fmt(x.D.eff)}` : '–'}</td>`; }).join('')}</tr>
        <tr class="raw"><th class="lbl">바로 보기</th>${L.map(x => `<td class="${x.rank === 1 ? 'pick' : ''}"><button class="btn ghost small" data-cmpt="${esc(x.code)}">매매 타이밍</button></td>`).join('')}</tr>
      </tbody></table></div>
    ${L.length >= 3 ? `<section class="rp-sec"><h4>한 줄씩</h4><ul class="cmp-lines">${L.map(x => `<li><b>${x.rank}위 ${esc(x.name)}</b> ${x.total}점 — ${esc(x.D.head.replace(/^[^—]{1,14}\s—\s/, ''))}. ${esc(cmpOneLine(x))}</li>`).join('')}</ul></section>` : ''}
    ${P.bad.length ? `<p class="rp-none">일봉 자료가 없어 뺀 종목: ${P.bad.map(x => esc(x.name || x.code)).join(', ')}</p>` : ''}
    <p class="rp-foot">점수는 정해진 잣대로 계산한 상대 비교예요. 1위가 「지금 사도 된다」는 뜻은 아니니 매수 타이밍 칸과 매매 타이밍 화면을 함께 보세요. 매매 판단과 책임은 본인에게 있어요.</p>
  </article>`;
}

function cmpChips() {
  const box = $('#cmpChips'); if (!box) return;
  const L = cmpList();
  box.innerHTML = L.map(c => { const s = S.data.stocks.find(x => x.code === c); return `<span class="cmp-chip">${esc(s ? s.name : c)}<button data-cmpx="${esc(c)}" aria-label="빼기">×</button></span>`; }).join('') + (L.length < 6 ? `<span class="muted small">${6 - L.length}개 더 넣을 수 있어요</span>` : '');
  $$('#cmpChips [data-cmpx]').forEach(b => b.onclick = () => { cmpSave(cmpList().filter(c => c !== b.dataset.cmpx)); renderCompare(true); });
}
async function renderCompare(force) {
  const box = $('#cmpMount'); if (!box || !S.data || CMP.busy || typeof tmDecide !== 'function') return;
  cmpChips();
  CMP.busy = true;
  if (!CMP.last || force) box.innerHTML = cmpList().length ? '<p class="rp-none">종목을 같은 잣대로 계산하는 중이에요…</p>' : '';
  try {
    const P = await cmpCollect(); CMP.last = P;
    box.innerHTML = cmpHtml(P);
    $$('#cmpMount [data-cmpx]').forEach(b => b.onclick = () => { cmpSave(cmpList().filter(c => c !== b.dataset.cmpx)); renderCompare(true); });
    $$('#cmpMount [data-cmpt]').forEach(b => b.onclick = () => openTiming(b.dataset.cmpt));
    $$('#cmpMount [data-cmpp]').forEach(b => b.onclick = () => { if (typeof plSave === 'function') { plSave([...plList(), b.dataset.cmpp]); b.textContent = '계획에 넣었어요'; } });
  } catch (e) { console.error(e); box.innerHTML = `<p class="rp-none">비교하지 못했어요: ${esc(e.message)}</p>`; }
  CMP.busy = false;
}
function cmpAdd(codes) { cmpSave([...cmpList(), ...codes]); renderCompare(true); }
function initCompare() {
  const go = () => { const q = ($('#cmpQ').value || '').trim(); if (!q) return; const h = findStocks(q); if (!h.length) { alert(`"${q}"과(와) 맞는 종목이 없어요`); return; } $('#cmpQ').value = ''; cmpAdd([h[0].code]); };
  $('#cmpGo').onclick = go;
  $('#cmpQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  $('#cmpW').onclick = () => cmpAdd(store.get('tmWatch', []) || []);
  $('#cmpH').onclick = () => cmpAdd([...new Set(hLoad().items.map(h => h.code))]);
  $('#cmpP').onclick = () => cmpAdd(typeof plList === 'function' ? plList() : []);
  $('#cmpClr').onclick = () => { cmpSave([]); renderCompare(true); };
  const tb = $('button[data-tab="cmp"]'); if (tb) tb.addEventListener('click', () => renderCompare());
  if ($('#tab-cmp') && $('#tab-cmp').classList.contains('on')) renderCompare();
  else cmpChips();
}
(function waitBootCmp() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof tmDecide === 'function' && typeof hLoad === 'function' && $('#tab-cmp')) initCompare();
  else setTimeout(waitBootCmp, 600);
})();
