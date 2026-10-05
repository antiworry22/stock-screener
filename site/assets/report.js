/* 보유 종목 일일 리포트 — 오늘 계좌 성적 · 오늘 한 매매 채점 · 종목별 성적표 · 전문가 피드백 · 내일 할 일 · 최근 기록
   자료: 「내 보유 종목」 기록(이 기기) + 실시간 시세(/api/hoga) + 매매 타이밍 규칙 엔진(tmDecide) + 지수 */
'use strict';

const RP = { busy: false, last: null };
const rpWon = v => v == null ? '–' : (v < 0 ? '−' : v > 0 ? '+' : '') + hWon(v);
const rpWonAbs = v => v == null ? '–' : hWon(v);
const rpPct = (v, d = 1) => v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), d)}%`;
const rpDow = d => '일월화수목금토'[new Date(d + 'T00:00:00Z').getUTCDay()];
const rpDate = d => `${+d.slice(5, 7)}월 ${+d.slice(8, 10)}일(${rpDow(d)})`;

/* ── 자료 모으기 ── */
async function rpCollect() {
  const today = tmNow().date, items = hLoad().items;
  const codes = [...new Set(items.map(h => h.code))];
  // 일봉 + 현재가 (매매 타이밍 엔진과 같은 자료)
  await Promise.all(codes.map(async c => { try { await tmLoadBars(c); const st = TM.st.get(c); if (!st.qt || Date.now() - st.qt > 60e3) await tmQuote(c); } catch (e) {} }));
  const rows = [], trades = [];
  for (const h of items) {
    const s = S.data.stocks.find(x => x.code === h.code), st = TM.st.get(h.code) || {};
    const buyQ = h.lots.reduce((a, l) => a + l.q, 0), sellQ = (h.sells || []).reduce((a, l) => a + l.q, 0), qty = buyQ - sellQ;
    const avg = buyQ ? h.lots.reduce((a, l) => a + l.p * l.q, 0) / buyQ : 0;
    const q = st.q, price = (q && q.price) || (s && s._live && s._live.c) || (s && s.close) || h.mp || null;
    const chg = q && q.chgPct != null && q.chgPct !== 0 ? q.chgPct : s && s._live ? s._live.chg : s ? s.chg : null;
    let D = null; try { if (st.f) D = tmDecide(h.code); } catch (e) {}
    const bar = D ? (() => { const B = D.R.B, n = B.c.length - 1; return B.d[n] === today ? { o: B.o[n], h: B.h[n], l: B.l[n], c: B.c[n] } : null; })() : null;
    const name = s ? s.name : h.name;
    // 오늘 한 매매
    h.lots.filter(l => l.d === today).forEach(l => trades.push({ kind: 'buy', code: h.code, name, p: l.p, q: l.q, bar, D, avg, s, h, price }));
    (h.sells || []).filter(l => l.d === today).forEach(l => trades.push({ kind: 'sell', code: h.code, name, p: l.p, q: l.q, bar, D, avg, s, h, price, real: (l.p - avg) * l.q }));
    if (qty <= 0 || !price) { if (qty <= 0 && (h.sells || []).some(l => l.d === today)) rows.push({ closed: true, h, name, code: h.code, realToday: (h.sells || []).filter(l => l.d === today).reduce((a, l) => a + (l.p - avg) * l.q, 0) }); continue; }
    const value = price * qty, inv = avg * qty, pnl = value - inv;
    const boughtToday = h.lots.filter(l => l.d === today).reduce((a, l) => a + l.q, 0);
    const prevQ = qty - boughtToday + (h.sells || []).filter(l => l.d === today).reduce((a, l) => a + l.q, 0);
    const prevClose = chg != null ? price / (1 + chg / 100) : null;
    // 오늘 손익 = 어제부터 들고 있던 수량의 하루 변동 + 오늘 산 수량의 (현재가 − 매수가)
    const dayOld = prevClose != null ? Math.max(0, qty - boughtToday) * (price - prevClose) : 0;
    const dayNew = h.lots.filter(l => l.d === today).reduce((a, l) => a + (price - l.p) * l.q, 0);
    rows.push({ h, s, D, code: h.code, name, qty, avg, price, chg, value, inv, pnl, pnlPct: (price / avg - 1) * 100, day: dayOld + dayNew, prevQ, first: h.lots.map(l => l.d).sort()[0], lots: h.lots, sector: s ? s.sector : '' });
  }
  const live = rows.filter(r => !r.closed);
  const tot = { value: live.reduce((a, r) => a + r.value, 0), inv: live.reduce((a, r) => a + r.inv, 0), day: live.reduce((a, r) => a + r.day, 0) };
  tot.pnl = tot.value - tot.inv; tot.pnlPct = tot.inv ? tot.pnl / tot.inv * 100 : 0;
  tot.realToday = trades.filter(t => t.kind === 'sell').reduce((a, t) => a + t.real, 0);
  tot.dayPct = tot.value - tot.day > 0 ? tot.day / (tot.value - tot.day) * 100 : 0;
  tot.atStop = live.reduce((a, r) => a + (r.D && r.D.mode === 'hold' ? Math.max(0, (r.price - r.D.eff) * r.qty) : r.price * r.qty * 0.07), 0);
  const M = (S.data && S.data.macro) || {};
  const idx = { kospi: M.kospi && M.kospi.chg, kosdaq: M.kosdaq && M.kosdaq.chg };
  return { today, rows: live, closed: rows.filter(r => r.closed), trades, tot, idx, acct: tmAcct(), at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16) };
}

/* ── 오늘 한 매매 채점 ── */
function rpGrade(t) {
  const b = t.bar, out = { grade: 'mid', head: '', tips: [] };
  const pos = b && b.h > b.l ? (t.p - b.l) / (b.h - b.l) : null;   // 0 = 저가, 1 = 고가
  const R = t.D && t.D.R;
  if (t.kind === 'buy') {
    const vsNow = t.price ? (t.price / t.p - 1) * 100 : null;
    if (pos != null && pos >= 0.8 && b && (b.c / b.o - 1) * 100 >= 3) { out.grade = 'bad'; out.head = `오늘 고가 근처(하루 범위의 상위 ${Math.round((1 - pos) * 100)}%)에서 샀어요 — 추격 매수`; out.tips.push(`같은 돈으로 저가(${fmt(b.l)}원)에 샀다면 ${hWon((t.p - b.l) * t.q)} 더 싸게 살 수 있었어요. 급등한 날은 다음 날 눌림을 기다리는 습관이 수익을 지켜줘요`); }
    else if (pos != null && pos >= 0.8) { out.head = `오늘 고가권(하루 범위의 ${Math.round(pos * 100)}% 지점)에서 샀어요`; out.tips.push(`저가(${fmt(b.l)}원)와 ${hWon((t.p - b.l) * t.q)} 차이예요. 시장가 대신 매수 1~2호가 지정가로 걸어두는 습관만으로도 매수 단가가 내려가요`); }
    else if (pos != null && pos <= 0.3) { out.grade = 'good'; out.head = `오늘 저가권(하루 범위의 하위 ${Math.round(pos * 100)}%)에서 잘 샀어요`; }
    else if (pos != null) out.head = `오늘 범위의 중간쯤(${Math.round(pos * 100)}% 지점)에서 샀어요`;
    else out.head = '오늘 매수';
    if (R && !R.trend.ok) { out.grade = 'bad'; out.tips.push(`매수 규칙의 첫 관문(20일선 위 + 20일선 상승)을 통과하지 못한 상태에서 샀어요. 이런 매수는 반등을 「기대」하는 것이지 「확인」한 게 아니에요`); }
    if (t.h.lots.length > 1 && t.p < t.avg * 0.98 && R && !R.trend.ok) out.tips.push('평단보다 낮은 가격에 추가로 샀어요. 하락 추세 속 추가 매수(물타기)는 손실을 키우는 가장 흔한 길이에요');
    if (R && R.buys.some(x => x.state === 'on') && R.trend.ok) { if (out.grade !== 'bad') out.grade = 'good'; out.tips.push(`매수 신호(${R.buys.filter(x => x.state === 'on').map(x => x.name).join(', ')})가 나온 날 샀어요 — 규칙대로예요`); }
    if (!t.h.stop && !(tmNotes()[t.code])) out.tips.push(`손절가를 아직 적지 않았어요. 「내 보유 종목」에서 손절가를 넣거나 매매 타이밍 화면에 매수 근거를 남겨두세요`);
    if (vsNow != null) out.now = `지금 ${rpPct(vsNow, 1)} (${rpWon((t.price - t.p) * t.q)})`;
  } else {
    const pnlP = (t.p / t.avg - 1) * 100;
    if (pnlP < 0 && t.D && t.D.mode === 'hold' && t.p <= t.D.eff * 1.01) { out.grade = 'good'; out.head = `손절선에서 정리했어요(${rpPct(pnlP, 1)}) — 손실을 작게 끊는 게 실력이에요`; }
    else if (pnlP < -7) { out.grade = 'mid'; out.head = `${rpPct(pnlP, 1)}에서 정리 — 정한 손절(−7%)보다 늦었어요`; out.tips.push(`다음엔 매수와 동시에 손절 주문을 걸어두면 이만큼(${hWon((t.avg * 0.93 - t.p) * t.q)}) 덜 잃을 수 있어요`); }
    else if (pnlP > 0 && pos != null && pos >= 0.7) { out.grade = 'good'; out.head = `오늘 고가권에서 이익 실현(${rpPct(pnlP, 1)})`; }
    else if (pnlP > 0 && pos != null && pos <= 0.3) { out.grade = 'mid'; out.head = `이익은 났지만 오늘 저가권에서 팔았어요(${rpPct(pnlP, 1)})`; out.tips.push('급하게 던질 이유가 없었다면, 매도 1호가에 걸어두는 것만으로도 몇 호가 더 받을 수 있어요'); }
    else out.head = `${pnlP >= 0 ? '이익' : '손실'} 실현 ${rpPct(pnlP, 1)}`;
    if (t.price && t.price > t.p * 1.03 && pnlP > 0) out.tips.push(`판 뒤 ${rpPct((t.price / t.p - 1) * 100, 1)} 더 올랐어요. 전량 대신 절반만 팔고 나머지는 트레일링으로 두는 방법도 있어요`);
    out.now = `실현 ${rpWon(t.real)}`;
  }
  return out;
}

/* ── 전문가 피드백 (데이터에서 나온 것만, 금액으로) ── */
function rpAdvice(R) {
  const A = [], { rows, tot, acct, idx, trades } = R;
  const add = (lvl, head, body, todo) => A.push({ lvl, head, body, todo });
  const val = tot.value || 1;
  // 1. 쏠림
  rows.forEach(r => { const w = r.value / val * 100; if (rows.length > 1 && w >= 35) add(2, `${r.name}에 계좌의 ${fmt(w, 0)}%가 몰려 있어요`, `이 종목이 하루 −5%만 빠져도 계좌 전체가 ${rpPct(-w * 0.05, 1)}(${hWon(r.value * 0.05)}) 줄어요. 한 종목이 계좌를 흔드는 구조예요.`, `${hWon(r.value - val * 0.3)}어치를 줄이면 30% 아래로 내려와요`); });
  const sec = {}; rows.forEach(r => { if (r.sector) sec[r.sector] = (sec[r.sector] || 0) + r.value; });
  Object.entries(sec).forEach(([k, v]) => { const n = rows.filter(r => r.sector === k).length; if (n >= 2 && v / val >= 0.5) add(1, `${k} 업종에 ${fmt(v / val * 100, 0)}% — 사실상 한 종목이에요`, `${n}종목을 갖고 있어도 같은 업종은 같은 날 같이 움직여요. 분산 효과가 거의 없어요.`, '다음 매수는 다른 업종에서 고르기'); });
  // 2. 손절 규칙 넘긴 종목
  rows.filter(r => r.pnlPct <= -7).forEach(r => add(3, `${r.name} ${rpPct(r.pnlPct, 1)} — 손절 기준(−7%)을 이미 넘었어요`, `지금 들고 있는 이유가 「다시 오를 것 같아서」라면 그건 계획이 아니라 희망이에요. 본전까지 가려면 ${rpPct((r.avg / r.price - 1) * 100, 1)}가 올라야 해요.`, r.D && r.D.mode === 'hold' ? `매매 타이밍 결론: ${(TM_ACT[r.D.act] || [''])[0]} — ${r.D.head.replace(/^[^—]{1,14}\s—\s/, '')}` : '내일 장 초반 비중 절반이라도 정리'));
  // 3. 목표 도달
  rows.filter(r => r.pnlPct >= 14).forEach(r => add(1, `${r.name} ${rpPct(r.pnlPct, 1)} — 목표 수익(+14%)에 왔어요`, `지금 절반만 팔아도 ${hWon(r.pnl / 2)}이 확정돼요. 나머지는 고점 대비 −10% 트레일링으로 두면 더 올라도 놓치지 않아요.`, `${fmt(Math.ceil(r.qty / 2))}주 이익 실현 주문`));
  // 4. 물타기
  rows.forEach(r => { const ls = r.lots.slice().sort((a, b) => a.d.localeCompare(b.d)); if (ls.length >= 2 && ls[ls.length - 1].p < ls[0].p * 0.95 && r.D && !r.D.R.trend.ok) add(2, `${r.name}: 내려갈 때마다 더 사고 있어요(물타기)`, `첫 매수 ${fmt(ls[0].p)}원 → 마지막 매수 ${fmt(ls[ls.length - 1].p)}원. 추세가 꺾인 상태라 평단을 낮추는 게 아니라 손실 금액을 키우고 있어요.`, '추세가 20일선 위로 돌아오기 전까지 추가 매수 멈추기'); });
  // 5. 전체 손절 위험
  if (tot.atStop > 0) add(tot.atStop / acct * 100 > 6 ? 2 : 0, `모든 종목이 손절선에 닿으면 ${hWon(tot.atStop)} 손실`, `계좌(${hWon(acct)})의 ${fmt(tot.atStop / acct * 100, 1)}%예요. ${tot.atStop / acct * 100 > 6 ? '한 번에 잃기엔 큰 금액이에요. 종목 수나 비중을 줄여 6% 아래로 맞추는 걸 권해요.' : '감당 가능한 범위예요. 손절선만 지키면 큰 사고는 없어요.'}`, '');
  // 6. 현금
  const cashPct = (1 - tot.inv / acct) * 100;
  if (cashPct < 10) add(1, `현금이 ${cashPct <= 0 ? '없어요' : fmt(cashPct, 0) + '%뿐이에요'}`, '좋은 매수 신호가 와도 살 돈이 없으면 결국 있는 종목을 손해 보고 팔게 돼요. 계좌의 20~30%는 비워두는 게 기회비용이에요.', '');
  // 7. 오래 안 움직이는 종목
  rows.forEach(r => { const days = tmBizBetween(r.first, R.today); if (days >= 20 && Math.abs(r.pnlPct) < 3) add(0, `${r.name}: ${days}거래일째 제자리(${rpPct(r.pnlPct, 1)})`, `${hWon(r.value)}가 한 달 넘게 일을 안 하고 있어요. 신호가 없다면 더 강한 종목으로 바꾸는 게 나을 수 있어요.`, r.D ? `매매 타이밍: ${(TM_ACT[r.D.act] || [''])[0]}` : ''); });
  // 8. 종목 수
  if (rows.length >= 9) add(1, `보유 ${rows.length}종목 — 매일 손절선을 챙기기 어려운 개수예요`, '종목이 많으면 각각에 신경을 덜 쓰게 되고, 결국 수익은 지수 수준으로 수렴해요. 5~7개가 관리하기 좋아요.', '가장 약한 종목부터 정리');
  // 9. 오늘 지수 대비
  const bench = idx.kospi != null ? idx.kospi : idx.kosdaq;
  if (bench != null && rows.length) {
    const diff = tot.dayPct - bench;
    const drag = rows.slice().sort((a, b) => a.day - b.day)[0], lift = rows.slice().sort((a, b) => b.day - a.day)[0];
    if (diff <= -1 && drag && drag.day < 0) add(1, `오늘 코스피보다 ${fmt(-diff, 1)}%p 못했어요`, `가장 크게 끌어내린 건 ${drag.name}(${rpWon(drag.day)})이에요. 시장이 오르는데 내 종목만 빠지면 그 종목에 문제가 있다는 신호예요.`, `${drag.name} 뉴스·공시 확인`);
    else if (diff >= 1 && lift && lift.day > 0) add(0, `오늘 코스피보다 ${fmt(diff, 1)}%p 잘했어요`, `${lift.name}(${rpWon(lift.day)})이 계좌를 끌어올렸어요. 잘 되는 종목은 손절선을 올려서(트레일링) 지키는 게 다음 단계예요.`, '');
  }
  // 10. 오늘 매매 습관
  const chase = trades.filter(t => t.kind === 'buy' && t.grade && t.grade.grade === 'bad').length;
  if (chase >= 2) add(2, `오늘 산 ${chase}건이 규칙 밖 매수예요`, '급등 추격이나 추세가 꺾인 종목 매수가 반복되면 승률이 아무리 좋아도 계좌는 줄어요. 매수 전에 「손절가가 얼마인가」 한 줄만 먼저 적어보세요.', '');
  if (!trades.length && rows.length) add(0, '오늘은 매매 없음', '사고팔 이유가 없는 날 아무것도 안 하는 것도 실력이에요. 손절선·목표가만 확인하고 넘어가세요.', '');
  // 11. 다가오는 큰 일정
  rows.forEach(r => { const ev = r.D && r.D.ctx && r.D.ctx.cal.find(x => !x.past && x.kind === 'earn' && x.url && tmBizBetween(R.today, x.d) <= 3); if (ev) add(2, `${r.name} 실적 발표 ${ev.d.slice(5).replace('-', '/')} — 3거래일 안이에요`, `발표 날은 ±10%도 흔해요. 지금 비중이면 하루에 ${hWon(r.value * 0.1)}까지 움직일 수 있어요.`, '손절선 다시 확인, 비중이 크면 일부 줄이기'); });
  return A.sort((a, b) => b.lvl - a.lvl);
}

/* ── 기록(하루 한 줄) ── */
function rpSaveHist(R) {
  const H = store.get('rpHist', {}) || {};
  H[R.today] = { v: Math.round(R.tot.value), i: Math.round(R.tot.inv), d: Math.round(R.tot.day), r: Math.round(R.tot.realToday), n: R.rows.length };
  const keys = Object.keys(H).sort(); while (keys.length > 120) delete H[keys.shift()];
  store.set('rpHist', H);
  return H;
}

/* ── 화면 ── */
function rpHtml(R) {
  const { tot, rows, trades, idx } = R;
  const H = rpSaveHist(R), hk = Object.keys(H).sort();
  const streak = (() => { let n = 0, sgn = 0; for (let i = hk.length - 1; i >= 0; i--) { const s = Math.sign(H[hk[i]].d); if (!s) break; if (!sgn) sgn = s; if (s !== sgn) break; n++; } return { n, sgn }; })();
  trades.forEach(t => { t.grade = rpGrade(t); });
  const adv = rpAdvice(R);
  const bench = idx.kospi != null ? ['코스피', idx.kospi] : idx.kosdaq != null ? ['코스닥', idx.kosdaq] : null;
  const dayTone = tot.day > 0 ? 't-up' : tot.day < 0 ? 't-down' : '';
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.day)));
  const todo = rows.filter(r => r.D).map(r => ({ r, D: r.D, pri: { EXIT: 0, HALF: 1, PART: 2, TAKE: 3, HOLD: 9 }[r.D.act] ?? 5 })).sort((a, b) => a.pri - b.pri);
  const ck = store.get('rpCk_' + R.today, {}) || {};
  const gName = { good: '잘함', mid: '보통', bad: '아쉬움' };
  return `<article class="rp">
    <header class="rp-top">
      <div><h3>${rpDate(R.today)} 보유 종목 리포트</h3><p>${esc(R.at)} 기준 · ${rows.length}종목${R.closed.length ? ` · 오늘 전량 매도 ${R.closed.length}종목` : ''}</p></div>
      <div class="rp-btns"><button class="btn ghost small" id="rpReload">다시 계산</button><button class="btn ghost small" id="rpCopy">텍스트로 복사</button><button class="btn ghost small" id="rpPrint">인쇄·PDF</button></div>
    </header>
    <section class="rp-hero ${dayTone}">
      <p class="rp-l">오늘 내 계좌</p>
      <p class="rp-big">${rpWon(tot.day)}</p>
      <p class="rp-sub">${rpPct(tot.dayPct, 2)}${bench ? ` · ${bench[0]} ${rpPct(bench[1], 2)} → <b>${tot.dayPct - bench[1] >= 0 ? `${fmt(tot.dayPct - bench[1], 2)}%p 앞섰어요` : `${fmt(bench[1] - tot.dayPct, 2)}%p 뒤졌어요`}</b>` : ''}${streak.n >= 2 ? ` · ${streak.n}일 연속 ${streak.sgn > 0 ? '수익' : '손실'}` : ''}</p>
      <dl class="rp-kpi">
        <div><dt>평가금액</dt><dd>${rpWonAbs(tot.value)}</dd></div>
        <div><dt>누적 손익</dt><dd class="${cls(tot.pnl)}">${rpWon(tot.pnl)} <small>${rpPct(tot.pnlPct, 1)}</small></dd></div>
        <div><dt>오늘 실현 손익</dt><dd class="${cls(tot.realToday)}">${trades.some(t => t.kind === 'sell') ? rpWon(tot.realToday) : '없음'}</dd></div>
        <div><dt>전부 손절선에 닿으면</dt><dd class="down">−${hWon(tot.atStop)} <small>계좌의 ${fmt(tot.atStop / R.acct * 100, 1)}%</small></dd></div>
      </dl>
    </section>

    <section class="rp-sec"><h4>오늘 한 매매 <small>${trades.length ? trades.length + '건' : ''}</small></h4>
      ${trades.length ? `<ul class="rp-trades">${trades.map(t => `<li class="g-${t.grade.grade}"><div class="rp-tr-h"><span class="rp-side ${t.kind}">${t.kind === 'buy' ? '매수' : '매도'}</span><b>${esc(t.name)}</b><span class="mono">${fmt(t.p)}원 × ${fmt(t.q)}주</span><span class="rp-grade ${t.grade.grade}">${gName[t.grade.grade]}</span>${t.grade.now ? `<span class="rp-now">${esc(t.grade.now)}</span>` : ''}</div>
        <p class="rp-tr-b">${esc(t.grade.head)}</p>${t.grade.tips.map(x => `<p class="rp-tip">${esc(x)}</p>`).join('')}</li>`).join('')}</ul>`
        : '<p class="rp-none">오늘 기록한 매수·매도가 없어요. 사고팔았다면 「내 보유 종목」에서 「추가 매수」·「매도 기록」을 눌러 오늘 날짜로 적어주세요.</p>'}
    </section>

    <section class="rp-sec"><h4>종목별 성적</h4>
      <div class="rp-rows">${rows.slice().sort((a, b) => b.day - a.day).map(r => `<div class="rp-row">
        <div class="rp-nm"><b>${esc(r.name)}</b><small>${fmt(r.qty)}주 · 평단 ${fmt(Math.round(r.avg))} · 비중 ${fmt(r.value / (tot.value || 1) * 100, 0)}%</small></div>
        <div class="rp-bar"><i class="${r.day >= 0 ? 'p' : 'm'}" style="${r.day >= 0 ? 'left:50%' : `right:50%`};width:${Math.abs(r.day) / maxAbs * 50}%"></i></div>
        <div class="rp-day ${cls(r.day)}"><b>${rpWon(r.day)}</b><small>오늘 ${rpPct(r.chg, 2)}</small></div>
        <div class="rp-tot ${cls(r.pnl)}"><b>${rpPct(r.pnlPct, 1)}</b><small>${rpWon(r.pnl)}</small></div>
        <div class="rp-act">${r.D ? tmTag(r.D.act) : ''}</div>
      </div>`).join('')}</div>
    </section>

    <section class="rp-sec"><h4>전문가 피드백</h4>
      ${adv.length ? `<ol class="rp-adv">${adv.slice(0, 7).map(a => `<li class="lv${a.lvl}"><b>${esc(a.head)}</b><p>${esc(a.body)}</p>${a.todo ? `<p class="rp-todo">→ ${esc(a.todo)}</p>` : ''}</li>`).join('')}</ol>` : '<p class="rp-none">특별히 손볼 곳이 없어요. 손절선만 지키세요.</p>'}
    </section>

    <section class="rp-sec"><h4>내일 할 일</h4>
      ${todo.length ? `<ul class="rp-ck">${todo.map(({ r, D }) => { const k = r.code; const o = D.orders && D.orders[0]; const line = D.act === 'HOLD' ? `${tmW(D.eff)}에 손절(트레일링) 주문 걸어두기 · ${tmW(D.t1)} 오면 ${fmt(Math.ceil(r.qty / 2))}주 이익 실현` : `${o ? `${fmt(o[1])}주 ${tmW(D.ob && D.ob.adj.sell ? D.ob.adj.sell.p : o[2])} 매도` : ''} — ${D.head.replace(/^[^—]{1,14}\s—\s/, '')}`; return `<li><label><input type="checkbox" data-rpck="${esc(k)}"${ck[k] ? ' checked' : ''}><span>${tmTag(D.act)} <b>${esc(r.name)}</b> ${esc(line)}</span></label></li>`; }).join('')}</ul>` : '<p class="rp-none">보유 종목이 없어요.</p>'}
    </section>

    ${hk.length >= 2 ? `<section class="rp-sec"><h4>최근 ${Math.min(hk.length, 20)}일</h4><div class="rp-hist">${hk.slice(-20).map(d => { const x = H[d], mx = Math.max(1, ...hk.slice(-20).map(k => Math.abs(H[k].d))); const hh = Math.max(2, Math.abs(x.d) / mx * 44); return `<div class="rp-h" title="${d} ${rpWon(x.d)}"><div class="hp">${x.d > 0 ? `<i style="height:${hh}px"></i>` : ''}</div><div class="hm">${x.d < 0 ? `<i style="height:${hh}px"></i>` : ''}</div><span>${+d.slice(8, 10)}</span></div>`; }).join('')}</div>
      <p class="rp-none">이 기기에서 리포트를 연 날만 기록돼요. 날마다 장 마감 뒤 한 번씩 열어두면 기록이 쌓여요.</p></section>` : ''}
    <p class="rp-foot">규칙과 숫자로 만든 참고 의견이에요. 매매 판단과 책임은 본인에게 있어요.</p>
  </article>`;
}

function rpText(R) {
  const { tot, rows, trades } = R, adv = rpAdvice(R);
  const L = [`[${rpDate(R.today)} 보유 종목 리포트]`, `오늘 ${rpWon(tot.day)} (${rpPct(tot.dayPct, 2)}) · 누적 ${rpWon(tot.pnl)} (${rpPct(tot.pnlPct, 1)})`, `평가금액 ${hWon(tot.value)}`, ''];
  if (trades.length) { L.push('■ 오늘 매매'); trades.forEach(t => L.push(`- ${t.kind === 'buy' ? '매수' : '매도'} ${t.name} ${fmt(t.p)}원×${fmt(t.q)}주: ${t.grade ? t.grade.head : ''}`)); L.push(''); }
  L.push('■ 종목별'); rows.forEach(r => L.push(`- ${r.name} 오늘 ${rpWon(r.day)} / 누적 ${rpPct(r.pnlPct, 1)}${r.D ? ' → ' + (TM_ACT[r.D.act] || [''])[0] : ''}`));
  if (adv.length) { L.push('', '■ 피드백'); adv.slice(0, 5).forEach(a => L.push(`- ${a.head}${a.todo ? ' → ' + a.todo : ''}`)); }
  return L.join('\n');
}

async function renderReport(force) {
  const box = $('#rpMount'); if (!box || !S.data || RP.busy) return;
  if (typeof hLoad !== 'function' || typeof tmDecide !== 'function') return;
  if (!hLoad().items.length) { box.innerHTML = '<p class="rp-none">「내 보유 종목」에 산 종목을 먼저 기록하면 매일 리포트를 만들어 드려요.</p>'; return; }
  RP.busy = true;
  if (!RP.last || force) box.innerHTML = '<p class="rp-none">시세를 받아 리포트를 만드는 중이에요…</p>';
  try {
    if (typeof tmEvents === 'function') await Promise.all([...new Set(hLoad().items.map(h => h.code))].map(c => tmEvents(c).catch(() => {})));
    const R = await rpCollect(); RP.last = R;
    box.innerHTML = rpHtml(R);
    $('#rpReload').onclick = () => renderReport(true);
    $('#rpPrint').onclick = () => { document.body.classList.add('rp-printing'); window.print(); setTimeout(() => document.body.classList.remove('rp-printing'), 500); };
    $('#rpCopy').onclick = async () => { const t = rpText(R); try { await navigator.clipboard.writeText(t); $('#rpCopy').textContent = '복사했어요'; } catch (e) { prompt('아래 내용을 복사하세요', t); } setTimeout(() => { const b = $('#rpCopy'); if (b) b.textContent = '텍스트로 복사'; }, 2000); };
    $$('#rpMount [data-rpck]').forEach(c => c.onchange = () => { const k = 'rpCk_' + R.today, o = store.get(k, {}) || {}; o[c.dataset.rpck] = c.checked; store.set(k, o); });
  } catch (e) { console.error(e); box.innerHTML = `<p class="rp-none">리포트를 만들지 못했어요: ${esc(e.message)}</p>`; }
  RP.busy = false;
}
function initReport() {
  const tb = $('button[data-tab="hrep"]'); if (tb) tb.addEventListener('click', () => renderReport());
  const hb = $('#hReport'); if (hb) hb.onclick = () => { switchTab('hrep'); renderReport(); };
  if ($('#tab-hrep') && $('#tab-hrep').classList.contains('on')) renderReport();
  // 열려 있는 동안 장중엔 5분마다 새로 계산
  setInterval(() => { const on = $('#tab-hrep') && $('#tab-hrep').classList.contains('on'); if (on && !document.hidden && tmMarket().st === 'open') renderReport(); }, 300e3);
}
(function waitBootRp() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof tmDecide === 'function' && typeof hLoad === 'function' && $('#tab-hrep')) initReport();
  else setTimeout(waitBootRp, 600);
})();
