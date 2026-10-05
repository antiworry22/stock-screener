/* 내일 매수 계획 — 전날 밤에 「내일 살 후보」를 정하고, 종목마다 종합평가(점수·등급)·실전 의견·시초가 시나리오를 만들고,
   지금 보유 종목과 합친 「종합 포트폴리오」(비중·업종·현금·손절 위험)로 예산 안에서 살 순서를 정해요.
   계산은 매매 타이밍 규칙 엔진(tmDecide)과 같은 자료를 써요. 목록은 이 기기에 저장돼요. */
'use strict';

const PL = { busy: false, last: null };
const plList = () => (store.get('plList', []) || []).filter(Boolean);
const plSave = a => store.set('plList', [...new Set(a)].slice(0, 15));
function plNextBiz() { let d = tmNow().date; const mk = tmMarket(); if (mk.biz && mk.st === 'pre') return d; do { d = tmAdd(d, 1); } while (!tmBiz(d)); return d; }

/* ── 종합평가: 0~100점 ── */
function plScore(D) {
  const s = D.s, R = D.R, parts = [];
  const add = (k, v, why) => { if (v) parts.push({ k, v, why }); };
  add('규칙', { BUY: 30, WAIT: 18, WATCH: 4, NO: 0 }[D.act] ?? 0, { BUY: '매수 신호 발생', WAIT: '조건부 매수(지정가 대기)', WATCH: '매수 신호 없음', NO: '매수 금지 사유 있음' }[D.act]);
  if (R.trend.ok) add('추세', 10, '20일선 위·상승 중');
  if (s && s.cl) add('차트', Math.round(Math.max(0, Math.min(20, (s.cl.s + 20) / 80 * 20))), `차트 종합판정 ${s.cl.v}`);
  if (D.plan && Math.abs(D.plan.stopPct) <= 4.5) add('손절폭', 5, `손절폭 ${fmt(Math.abs(D.plan.stopPct), 1)}%로 짧음`);
  if (s) {
    if (s.foreign_streak >= 3) add('수급', 5, `외국인 ${s.foreign_streak}일 순매수`); else if (s.foreign_streak <= -3) add('수급', -5, `외국인 ${-s.foreign_streak}일 순매도`);
    if (s.inst_streak >= 3) add('수급', 5, `기관 ${s.inst_streak}일 순매수`); else if (s.inst_streak <= -3) add('수급', -5, `기관 ${-s.inst_streak}일 순매도`);
    if (s.short_chg != null && s.short_chg >= 0.3) add('공매도', -5, '공매도 잔고 증가'); else if (s.short_chg != null && s.short_chg <= -0.3) add('공매도', 3, '공매도 잔고 감소');
    if (s._newsLive != null && s._newsLive >= 20) add('뉴스', 5, '호재 뉴스 우세'); else if (s._newsLive != null && s._newsLive <= -20) add('뉴스', -5, '악재 뉴스 우세');
    const rk = typeof SR !== 'undefined' && SR.cur && SR.cur.ALL ? SR.cur.ALL[s.sector] : null, nSec = rk != null ? Object.keys(SR.cur.ALL).length : 0;
    if (rk != null && rk <= 10) add('업종', 5, `${s.sector} 업종 강도 ${rk}위`); else if (rk != null && nSec && rk > nSec - 10) add('업종', -5, `${s.sector} 업종 강도 하위(${rk}위)`);
  }
  const tvf = s && (s._tvf || (typeof volAll === 'function' && volAll().get(s.code) ? volAll().get(s.code).tvf : null));
  if (tvf && tvf.k !== 'quiet' && tvf.k !== 'mixed') add('거래대금', Math.round(tvf.s * 0.25), `거래대금 ${tvf.name}${tvf.streak > 1 ? ` ${tvf.streak}일 연속` : ''}`);
  if (D.ctx.risk.length) add('공시', -10, '최근 악재·물량 공시');
  if (D.ctx.good.length) add('공시', 5, '최근 호재 공시');
  if (D.ctx.cal.some(x => !x.past && x.kind === 'earn' && x.url && tmBizBetween(tmNow().date, x.d) <= 3)) add('일정', -5, '3거래일 안 실적 발표');
  const g = S.data.gate; if (g && g.level === 'red') add('시장', -10, '시장 게이트 빨강'); else if (g && g.level === 'yellow') add('시장', -5, '시장 게이트 노랑');
  if (D.bans && D.bans.length) add('금지', -15, D.bans[0].split(' — ')[0]);
  const score = Math.max(0, Math.min(100, 20 + parts.reduce((a, p) => a + p.v, 0)));
  const grade = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : 'D';
  return { score, grade, parts };
}

/* ── 실전 의견: 이 종목에 맞는 것만 ── */
function plOpinion(D, sc) {
  const s = D.s, R = D.R, p = D.plan, O = [];
  const sig = p && p.sig ? p.sig.id : null;
  if (D.act === 'BUY' && sig === 'BUY-02') O.push('돌파 매수는 「돌파 캔들 절반가」가 생명선이에요. 내일 그 아래로 밀리면 돌파 실패라 미련 없이 정리해요.');
  if (D.act === 'BUY' && sig === 'BUY-01') O.push('눌림목은 「지지 확인」이 핵심이에요. 시초가부터 20일선을 깨고 시작하면 지지가 아니라 이탈이니 사지 않아요.');
  if (sig === 'BUY-03') O.push('쉼 뒤 재상승은 거래량이 증거예요. 내일 오전 거래량이 평소보다 적으면 가짜 재상승일 수 있어요.');
  if (sig === 'BUY-04') O.push('과매도 되돌림은 반등폭이 작은 편이에요. 1차 목표에서 절반을 꼭 챙기세요.');
  if (D.act === 'WAIT' && p) O.push(`지금 가격(${tmW(D.P)})에서 사면 손절까지 ${fmt((D.P / p.stop - 1) * 100, 1)}%예요. 기다려서 ${tmW(p.E)}에 사면 같은 손절에 위험이 ${fmt((p.E / p.stop - 1) * 100, 1)}%로 줄어요 — 기다리는 값이에요.`);
  if (D.act === 'WATCH' && !R.trend.ok) O.push(`추세가 꺾인 종목은 「싸 보여서」 사는 게 가장 위험해요. 20일선(${tmW(R.ma20)}) 위로 돌아오는 걸 먼저 확인하세요.`);
  if (D.act === 'NO') O.push(`${D.bans && D.bans[0] ? D.bans[0].split(' — ')[0] : '금지 사유'} — 이 사유가 사라질 때까지 목록에만 두세요.`);
  const tf = s && s._tvf;
  if (tf && tf.k === 'up') O.push(`오늘 거래대금이 전날의 ${fmt(tf.d1, 1)}배로 늘며 시가 위에서 끝났어요. 내일 시가가 오늘 시가(돈이 들어온 출발점) 아래로 밀리면 유입이 끝난 신호예요.`);
  if (tf && tf.k === 'hold') O.push('거래가 많은데 시가를 지켜냈어요. 내일도 오늘 시가 근처에서 버티면 매집 흔적이 굳어지는 거라, 그 가격 근처가 좋은 매수 자리예요.');
  if (tf && (tf.k === 'down' || tf.k === 'dump')) O.push(`거래는 많은데 돈이 시가 아래로 빠져나갔어요(${tf.name}). 차트 신호가 좋아도 하루 이틀은 물량 소화를 지켜보세요.`);
  if (R.rsi >= 70) O.push(`RSI ${fmt(R.rsi, 0)} — 단기 과열이에요. 좋은 종목이어도 과열 구간에서 산 물량은 흔들리기 쉬워요. 1차를 평소의 절반으로.`);
  if (s && s.foreign_streak >= 3 && s.inst_streak >= 3) O.push('외국인·기관이 같이 사고 있어요. 큰손이 받치는 종목은 눌림이 얕은 편이라 지정가를 너무 낮게 걸면 못 살 수 있어요.');
  if (s && s.foreign_streak <= -3 && s.inst_streak <= -3) O.push('외국인·기관이 같이 팔고 있어요. 차트 신호가 좋아도 위로 갈 때마다 물량이 나와요. 목표가를 짧게 잡으세요.');
  if (D.ctx.cal.some(x => !x.past && x.kind === 'earn' && x.url && tmBizBetween(tmNow().date, x.d) <= 3)) O.push('실적 발표가 코앞이에요. 발표 전엔 1차만, 발표 뒤 반응(갭·거래량)을 보고 2차를 결정하세요.');
  if (D.ctx.risk.length) O.push(`최근 「${D.ctx.risk[0].t.slice(0, 30)}」 공시가 있었어요. 물량이 풀리는 날짜를 공시 원문에서 꼭 확인하세요.`);
  if (s && s.mcap && s.mcap < 3000) O.push(`시가총액 ${fmt(s.mcap)}억 소형주예요. 호가가 얇아 시장가로 사면 2~3호가 비싸게 체결돼요. 지정가만 쓰세요.`);
  if (sc.grade === 'A' && D.act === 'BUY') O.push('점수와 매수 신호가 모두 좋은 편이에요. 계획한 수량을 지키되, 1차 체결 뒤 손절 주문을 바로 거는 것까지가 매수예요.');
  if (!O.length) O.push('특별한 위험 신호는 없어요. 계획한 가격·수량·손절가 세 가지만 지키면 돼요.');
  return O.slice(0, 4);
}

/* ── 시초가 시나리오 ── */
function plScenario(D) {
  const p = D.plan; if (!p || !(D.act === 'BUY' || D.act === 'WAIT')) return null;
  const C = D.P, up3 = tmUp(C * 1.03), cap = tmDn(p.E * 1.01);
  if (D.act === 'BUY') return [
    ['go', `${tmW(p.stop + tmTick(p.stop))} ~ ${tmW(cap)}에서 시작`, `계획대로 ${tmW(p.E)} 근처 지정가로 1차 ${fmt(p.q1)}주. 체결되면 바로 손절 ${tmW(p.stop)} 주문`],
    ['wait', `${tmW(Math.max(cap + tmTick(cap), up3))} 이상(갭 상승)`, `추격하지 않아요. 첫 30분 고점이 꺾이고 ${tmW(p.E)} 쪽으로 내려오면 그때 1차, 안 내려오면 오늘은 패스`],
    ['stop', `${tmW(p.stop)} 이하에서 시작`, '신호가 무효예요. 계획 취소하고 다시 계산될 때까지 관찰'],
  ];
  return [
    ['go', `장중 ${tmW(p.E)}까지 내려옴`, `지정가 ${tmW(p.E)}에 1차 ${fmt(p.q1)}주 체결 → 손절 ${tmW(p.stop)} 바로 등록`],
    ['wait', `${tmW(p.E)} 위에서 계속 머묾`, '미체결이어도 괜찮아요. 쫓아가서 사지 않아요. 저녁에 다시 계산'],
    ['stop', `${tmW(p.stop)} 아래로 급락`, '지지가 깨진 거예요. 지정가 주문 취소'],
  ];
}

/* ── 자료 모으기 ── */
async function plCollect() {
  const codes = plList(), out = [];
  await Promise.all(codes.map(async c => { try { await tmLoadBars(c); const st = TM.st.get(c); if (!st.qt || Date.now() - st.qt > 120e3) await tmQuote(c); await tmEvents(c); } catch (e) {} }));
  for (const c of codes) {
    let D = null; try { if (TM.st.get(c) && TM.st.get(c).f) D = tmDecide(c); } catch (e) { console.error(e); }
    const s = S.data.stocks.find(x => x.code === c);
    if (!D) { out.push({ code: c, name: s ? s.name : c, err: true }); continue; }
    const sc = plScore(D);
    out.push({ code: c, name: s ? s.name : c, D, sc, op: plOpinion(D, sc), scen: plScenario(D), held: !!tmHold(c) });
  }
  out.sort((a, b) => (b.sc ? b.sc.score : -1) - (a.sc ? a.sc.score : -1));
  // 보유 종목
  const hold = [];
  for (const h of hLoad().items) {
    const r = tmHold(h.code); if (!r) continue;
    const s = S.data.stocks.find(x => x.code === h.code), st = TM.st.get(h.code) || {};
    const price = (st.q && st.q.price) || (s && (s._live ? s._live.c : s.close)) || h.mp; if (!price) continue;
    let D = null; try { if (!st.f) await tmLoadBars(h.code); D = tmDecide(h.code); } catch (e) {}
    const sellFrac = D && D.mode === 'hold' ? ({ EXIT: 1, HALF: 0.5, TAKE: 0.5, PART: 1 / 3 }[D.act] || 0) : 0;
    hold.push({ code: h.code, name: s ? s.name : h.name, sector: s ? s.sector : '기타', value: price * r.qty, sell: price * r.qty * sellFrac, act: D ? D.act : null, risk: (D && D.mode === 'hold' ? Math.max(0, (price - D.eff) * r.qty) : price * r.qty * 0.07) * (1 - sellFrac) });
  }
  // 예산 안에서 살 순서: 현금 20%는 남기고, 점수 높은 순
  const A = tmAcct(), invested = hold.reduce((a, x) => a + x.value, 0);
  const freed = hold.reduce((a, x) => a + x.sell, 0);
  let cash = A - invested + freed; const floor = A * 0.2;
  out.forEach(x => {
    if (!x.D || !x.D.plan || !(x.D.act === 'BUY' || x.D.act === 'WAIT')) { x.buy = null; return; }
    const p = x.D.plan, amt = p.amt1;   // 내일은 1차만
    if (x.sc.grade === 'D') { x.buy = { ok: false, why: '종합평가 D — 이번엔 패스' }; return; }
    if (cash - amt < floor) { const q = Math.floor(Math.max(0, cash - floor) / p.E); x.buy = q >= 1 ? { ok: true, q, amt: q * p.E, part: true, why: `예산이 모자라 ${fmt(q)}주만` } : { ok: false, why: '예산 초과 — 현금 20% 지키기' }; cash -= q * p.E; return; }
    x.buy = { ok: true, q: p.q1, amt }; cash -= amt;
  });
  return { day: plNextBiz(), list: out, hold, A, invested, freed, cashAfter: cash, at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 16) };
}

/* ── 종합 포트폴리오 평가 ── */
function plPortfolio(P) {
  const A = P.A, pos = {};
  P.hold.forEach(h => { pos[h.code] = { name: h.name, sector: h.sector, cur: h.value, sell: h.sell, add: 0, risk: h.risk }; });
  P.list.forEach(x => { if (x.buy && x.buy.ok) { const s = x.D.s; const o = pos[x.code] = pos[x.code] || { name: x.name, sector: s ? s.sector : '기타', cur: 0, sell: 0, add: 0, risk: 0 }; o.add += x.buy.amt; o.risk += x.buy.q * (x.D.plan.E - x.D.plan.stop); o.isNew = !o.cur; } });
  const rows = Object.entries(pos).map(([code, o]) => ({ code, ...o, tot: o.cur - o.sell + o.add })).sort((a, b) => b.tot - a.tot);
  const total = rows.reduce((a, r) => a + r.tot, 0), cash = Math.max(0, A - total);
  const sec = {}; rows.forEach(r => { sec[r.sector] = (sec[r.sector] || 0) + r.tot; });
  const secs = Object.entries(sec).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const risk = rows.reduce((a, r) => a + r.risk, 0);
  const F = [];
  const top = rows[0];
  if (top && top.tot / A > 0.3) F.push(['warn', `${top.name} 비중 ${fmt(top.tot / A * 100, 0)}% — 한 종목 30% 한도를 넘어요`, `${hWon(top.tot - A * 0.3)}만큼 덜어내면 하루 −10% 급락에도 계좌 −3% 안쪽이에요.`]);
  if (secs[0] && secs[0][1] / (total || 1) > 0.5 && rows.length >= 3) F.push(['warn', `${secs[0][0]} 업종이 주식의 ${fmt(secs[0][1] / total * 100, 0)}%`, '업종이 쏠리면 종목 수와 상관없이 한 종목처럼 움직여요. 새 후보는 다른 업종에서 고르는 게 좋아요.']);
  if (risk / A > 0.06) F.push(['bad', `계획대로 다 사면 손절 위험 ${hWon(risk)} (계좌 ${fmt(risk / A * 100, 1)}%)`, '한 번에 계좌의 6% 넘게 잃을 수 있는 구조예요. 점수 낮은 후보를 빼거나 1차 수량을 줄이세요.']);
  else F.push(['ok', `손절 위험 합계 ${hWon(risk)} (계좌 ${fmt(risk / A * 100, 1)}%)`, '모든 종목이 손절선에 닿아도 감당 가능한 범위예요.']);
  if (cash / A < 0.15) F.push(['warn', `매수 뒤 현금 ${fmt(cash / A * 100, 0)}%`, '다음 기회나 급락 때 쓸 돈이 거의 없어요. 20%는 남겨두는 걸 권해요.']);
  else F.push(['ok', `매수 뒤 현금 ${fmt(cash / A * 100, 0)}% (${hWon(cash)})`, '다음 기회를 위한 여유가 있어요.']);
  if (rows.length > 8) F.push(['warn', `보유 ${rows.length}종목이 돼요`, '매일 손절선을 챙길 수 있는 개수인지 생각해보세요. 5~7개가 관리하기 좋아요.']);
  if (P.freed > 0) F.push(['info', `내일 매도 계획으로 ${hWon(P.freed)}이 현금이 돼요`, `${P.hold.filter(h => h.sell > 0).map(h => `${h.name}(${(TM_ACT[h.act] || [''])[0]})`).join(', ')} — 이 돈까지 넣어 예산을 계산했어요. 매도가 먼저 체결된 뒤에 사세요.`]);
  const skipped = P.list.filter(x => x.buy && !x.buy.ok);
  if (skipped.length) F.push(['info', `${skipped.length}종목은 이번 계획에서 빠졌어요`, skipped.map(x => `${x.name}(${x.buy.why})`).join(', ')]);
  return { rows, total, cash, secs, risk, F, A };
}

/* ── 화면 ── */
function plHtml(P) {
  const PF = plPortfolio(P), gN = { A: '적극', B: '양호', C: '보통', D: '보류' };
  const colors = ['var(--up)', 'var(--down)', 'var(--ok)', 'var(--warn)', '#8e44ad', '#16a085', '#7f8c8d', '#d35400', '#2c3e50', '#c0392b'];
  const buys = P.list.filter(x => x.buy && x.buy.ok);
  return `<article class="pl">
    <header class="rp-top"><div><h3>${rpDate(P.day)} 매수 계획</h3><p>${esc(P.at)} 계산 · 후보 ${P.list.length}종목 · 내일 살 종목 ${buys.length}개 · 1차 매수 합계 ${hWon(buys.reduce((a, x) => a + x.buy.amt, 0))}</p></div>
      <div class="rp-btns"><button class="btn ghost small" id="plReload">다시 계산</button><button class="btn ghost small" id="plCopy">텍스트로 복사</button><button class="btn ghost small" id="plPrint">인쇄·PDF</button></div></header>

    <section class="rp-sec"><h4>내일 살 순서 <small>점수 높은 순 · 현금 20%는 남겨요</small></h4>
      ${P.list.length ? `<ol class="pl-order">${P.list.map(x => x.err ? `<li class="off"><b>${esc(x.name)}</b> <span class="muted">일봉 자료가 없어 계산할 수 없어요</span> <button class="pl-x" data-plx="${esc(x.code)}" aria-label="후보에서 빼기">×</button></li>` : `<li class="${x.buy && x.buy.ok ? '' : 'off'}">
        <span class="pl-grade g${x.sc.grade}">${x.sc.grade}<small>${x.sc.score}</small></span>
        <div class="pl-o-main"><b>${esc(x.name)}</b>${x.held ? '<small class="pl-held">보유 중</small>' : ''} ${tmTag(x.D.act)}<p>${x.buy && x.buy.ok ? `${tmW(x.D.plan.E)}에 ${fmt(x.buy.q)}주 (${hWon(x.buy.amt)})${x.buy.part ? ` · ${esc(x.buy.why)}` : ''} · 손절 ${tmW(x.D.plan.stop)} · 목표 ${tmW(x.D.plan.t1)}` : esc(x.buy ? x.buy.why : x.D.head.replace(/^[^—]{1,14}\s—\s/, ''))}</p></div>
        <button class="pl-x" data-plx="${esc(x.code)}" aria-label="후보에서 빼기" title="후보에서 빼기">×</button></li>`).join('')}</ol>` : '<p class="rp-none">아직 후보가 없어요. 위에서 종목을 넣거나 「자동으로 후보 찾기」를 눌러보세요.</p>'}
    </section>

    ${P.list.filter(x => !x.err).map(x => { const D = x.D, p = D.plan; return `<section class="pl-card">
      <header><div><h4>${esc(x.name)} <small>${esc(x.code)}${D.s ? ' · ' + esc(D.s.sector) : ''}</small></h4><p>${tmW(D.P)} <span class="${cls(D.ctx.chg)}">${pct(D.ctx.chg, 2)}</span></p></div>
        <div class="pl-score g${x.sc.grade}"><b>${x.sc.grade}</b><span>${x.sc.score}점 · ${gN[x.sc.grade]}</span></div></header>
      <div class="pl-verdict">${tmTag(D.act)} ${esc(D.head.replace(/^[^—]{1,14}\s—\s/, ''))}</div>
      ${p ? `<dl class="pl-nums"><div><dt>매수</dt><dd class="up">${tmW(p.E)}</dd></div><div><dt>손절</dt><dd class="down">${tmW(p.stop)} <small>${pct(p.stopPct, 1)}</small></dd></div><div><dt>1차 목표</dt><dd class="down">${tmW(p.t1)} <small>${tmP(p.t1, p.E)}</small></dd></div><div><dt>1차 수량</dt><dd>${fmt(p.q1)}주 <small>${hWon(p.amt1)}</small></dd></div></dl>` : ''}
      <div class="pl-cols">
        <div><h5>점수 근거</h5><ul class="pl-parts">${x.sc.parts.map(t => `<li class="${t.v > 0 ? 'p' : 'm'}"><span>${esc(t.why)}</span><b>${t.v > 0 ? '+' : ''}${t.v}</b></li>`).join('')}</ul></div>
        <div><h5>전문가 한마디</h5><ul class="pl-op">${x.op.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>
      </div>
      ${x.scen ? `<h5>내일 시초가 시나리오</h5><ul class="pl-scen">${x.scen.map(([k, a, b]) => `<li class="${k}"><b>${esc(a)}</b><span>${esc(b)}</span></li>`).join('')}</ul>` : ''}
      <button class="btn ghost small" data-plt="${esc(x.code)}">매매 타이밍에서 자세히 보기</button>
    </section>`; }).join('')}

    <section class="rp-sec"><h4>종합 포트폴리오 <small>지금 보유 + 내일 계획 · 계좌 ${hWon(PF.A)}</small></h4>
      <div class="pl-stack" role="img" aria-label="계좌 구성">${PF.rows.map((r, i) => `<i style="width:${r.tot / PF.A * 100}%;background:${colors[i % colors.length]}" title="${esc(r.name)} ${fmt(r.tot / PF.A * 100, 1)}%"></i>`).join('')}<i class="cash" style="width:${PF.cash / PF.A * 100}%" title="현금"></i></div>
      <table class="pl-tb"><thead><tr><th>종목</th><th>업종</th><th>지금</th><th>내일 매도</th><th>내일 매수</th><th>비중</th><th>손절 시 손실</th></tr></thead><tbody>
        ${PF.rows.map((r, i) => `<tr><td><i class="dot" style="background:${colors[i % colors.length]}"></i>${esc(r.name)}${r.isNew ? ' <small class="pl-new">새로</small>' : ''}</td><td class="muted">${esc(r.sector || '')}</td><td class="mono">${r.cur ? hWon(r.cur) : '–'}</td><td class="mono down">${r.sell ? '−' + hWon(r.sell) : '–'}</td><td class="mono up">${r.add ? '+' + hWon(r.add) : '–'}</td><td class="mono"><b>${fmt(r.tot / PF.A * 100, 1)}%</b></td><td class="mono down">${hWon(r.risk)}</td></tr>`).join('')}
        <tr class="cash"><td><i class="dot cash"></i>현금</td><td></td><td></td><td></td><td></td><td class="mono"><b>${fmt(PF.cash / PF.A * 100, 1)}%</b></td><td class="mono">${hWon(PF.cash)}</td></tr>
      </tbody></table>
      <div class="pl-secs">${PF.secs.map(([k, v]) => `<span>${esc(k)} <b>${fmt(v / PF.A * 100, 0)}%</b></span>`).join('')}</div>
      <ul class="pl-f">${PF.F.map(([k, a, b]) => `<li class="${k}"><b>${esc(a)}</b><p>${esc(b)}</p></li>`).join('')}</ul>
    </section>
    <p class="rp-foot">규칙과 숫자로 만든 계획이에요. 내일 장중에는 「매매 타이밍」이 실시간 호가로 가격을 다시 다듬어요. 매매 판단과 책임은 본인에게 있어요.</p>
  </article>`;
}

function plText(P) {
  const PF = plPortfolio(P), L = [`[${rpDate(P.day)} 매수 계획]`];
  P.list.filter(x => !x.err).forEach((x, i) => { const p = x.D.plan; L.push(`${i + 1}. ${x.name} ${x.sc.grade}(${x.sc.score}) ${(TM_ACT[x.D.act] || [''])[0]}${x.buy && x.buy.ok ? ` — ${fmt(p.E)}원 ${fmt(x.buy.q)}주, 손절 ${fmt(p.stop)}, 목표 ${fmt(p.t1)}` : ` — ${x.buy ? x.buy.why : '매수 안 함'}`}`); });
  L.push('', `포트폴리오: 현금 ${fmt(PF.cash / PF.A * 100, 0)}% · 손절 위험 ${hWon(PF.risk)}`);
  PF.F.forEach(([, a]) => L.push(`- ${a}`));
  return L.join('\n');
}

async function renderPlan(force) {
  const box = $('#plMount'); if (!box || !S.data || PL.busy) return;
  if (typeof tmDecide !== 'function') return;
  PL.busy = true;
  if (!PL.last || force) box.innerHTML = '<p class="rp-none">후보 종목을 계산하는 중이에요…</p>';
  try {
    const P = await plCollect(); PL.last = P;
    box.innerHTML = plHtml(P);
    $('#plReload').onclick = () => renderPlan(true);
    $('#plPrint').onclick = () => { document.body.classList.add('pl-printing'); window.print(); setTimeout(() => document.body.classList.remove('pl-printing'), 500); };
    $('#plCopy').onclick = async () => { const t = plText(P); try { await navigator.clipboard.writeText(t); $('#plCopy').textContent = '복사했어요'; } catch (e) { prompt('아래 내용을 복사하세요', t); } setTimeout(() => { const b = $('#plCopy'); if (b) b.textContent = '텍스트로 복사'; }, 2000); };
    $$('#plMount [data-plx]').forEach(b => b.onclick = () => { plSave(plList().filter(c => c !== b.dataset.plx)); renderPlan(true); });
    $$('#plMount [data-plt]').forEach(b => b.onclick = () => openTiming(b.dataset.plt));
  } catch (e) { console.error(e); box.innerHTML = `<p class="rp-none">계획을 만들지 못했어요: ${esc(e.message)}</p>`; }
  PL.busy = false;
}

/* 자동 후보: 차트 점수·추천 점수 상위에서 규칙 엔진으로 BUY/WAIT만 */
async function plAuto() {
  const btn = $('#plAuto'); if (btn) { btn.disabled = true; btn.textContent = '찾는 중…'; }
  const have = new Set([...plList(), ...hLoad().items.map(h => h.code)]);
  const pool = S.data.stocks.filter(s => s.cl && s.cl.s >= 20 && !have.has(s.code) && !(s._ban && s._ban.length))
    .sort((a, b) => ((b.cl.ckp ? 15 : 0) + b.cl.s + (b._rec || 0) / 2) - ((a.cl.ckp ? 15 : 0) + a.cl.s + (a._rec || 0) / 2)).slice(0, 18);
  const hits = [];
  for (const s of pool) {
    try { await tmLoadBars(s.code); const D = tmDecide(s.code); if (D && (D.act === 'BUY' || D.act === 'WAIT')) hits.push({ code: s.code, sc: plScore(D).score }); } catch (e) {}
    if (hits.length >= 6) break;
  }
  hits.sort((a, b) => b.sc - a.sc);
  plSave([...plList(), ...hits.slice(0, 5).map(h => h.code)]);
  if (btn) { btn.disabled = false; btn.textContent = '자동으로 후보 찾기'; }
  if (!hits.length) alert('지금 규칙상 매수·대기 신호가 있는 후보를 찾지 못했어요. 시장 전체가 약할 때는 쉬는 것도 계획이에요.');
  renderPlan(true);
}
function plAdd() {
  const q = ($('#plQ').value || '').trim(); if (!q) return;
  const h = findStocks(q); if (!h.length) { alert(`"${q}"과(와) 맞는 종목이 없어요`); return; }
  plSave([...plList(), h[0].code]); $('#plQ').value = ''; renderPlan(true);
}
function initPlan() {
  $('#plGo').onclick = plAdd;
  $('#plQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); plAdd(); } };
  $('#plAuto').onclick = plAuto;
  $('#plFromW').onclick = () => { plSave([...plList(), ...(store.get('tmWatch', []) || [])]); renderPlan(true); };
  const tb = $('button[data-tab="plan"]'); if (tb) tb.addEventListener('click', () => renderPlan());
  if ($('#tab-plan') && $('#tab-plan').classList.contains('on')) renderPlan();
}
(function waitBootPl() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof tmDecide === 'function' && typeof rpDate === 'function' && $('#tab-plan')) initPlan();
  else setTimeout(waitBootPl, 600);
})();
