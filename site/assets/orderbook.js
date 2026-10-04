/* 실시간 호가창 분석 — 사이트 서버(/api/hoga)를 통해 네이버 호가·시세를 3초마다 받아
   잔량 불균형 · 매수/매도 벽 · 체결강도(추정) · 허수 호가(벽 취소) · 스프레드를 해석합니다. */
'use strict';

const OB = { API: '/api/hoga', code: null, mount: null, timer: null, busy: false, s: null };
const obKst = () => new Date(Date.now() + 9 * 3600e3);
function obMarketOpen() {  // 평일 08:30~15:40 (동시호가 포함)
  const d = obKst(), w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return w >= 1 && w <= 5 && m >= 510 && m <= 940;
}
function obTick(p) {  // 2023년 이후 코스피·코스닥 공통 호가 단위
  return p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
}
const obEok = v => v == null ? '–' : v >= 1e8 ? fmt(v / 1e8, v >= 1e10 ? 0 : 1) + '억' : fmt(v / 1e4, 0) + '만';

function obReset(code) {
  OB.s = { code, n: 0, prev: null, buyV: 0, sellV: 0, imb: [], cs: [], ev: [], walls: {}, first: null, last: null, err: 0 };
}

/* ── 한 번 받은 자료 해석 ── */
function obAnalyze(r) {
  const S0 = OB.s, q = r.quote || {}, b = r.book || { asks: [], bids: [], totA: 0, totB: 0 };
  const asks = b.asks.slice(0, 10), bids = b.bids.slice(0, 10);
  const a1 = asks[0] ? asks[0].p : null, b1 = bids[0] ? bids[0].p : null;
  const price = q.price || (a1 && b1 ? Math.round((a1 + b1) / 2) : a1 || b1);
  const totA = b.totA || 0, totB = b.totB || 0;
  const imb = totA + totB ? totB / (totA + totB) : null;              // 0.5 = 균형, 높을수록 매수 잔량 많음
  const tick = obTick(price || 1), spreadT = a1 && b1 ? Math.round((a1 - b1) / tick) : null;
  // 벽: 같은 쪽 평균의 2.5배 이상 + 1억원 이상
  const wallOf = (side, nm) => {
    const avg = side.reduce((s, x) => s + x.q, 0) / (side.length || 1);
    return side.filter(x => x.q >= avg * 2.5 && x.q * x.p >= 1e8).map(x => ({ side: nm, p: x.p, q: x.q, amt: x.p * x.q, dist: price ? (x.p / price - 1) * 100 : 0 }));
  };
  const walls = [...wallOf(asks, 'ask'), ...wallOf(bids, 'bid')];
  // 체결 방향 추정: 직전 조회 대비 늘어난 거래량을, 체결가가 직전 매도1호가 이상이면 매수, 매수1호가 이하면 매도로 분류
  const P = S0.prev, now = obKst().toISOString().slice(11, 19);
  let dv = 0, dir = 0;
  if (P && q.vol != null && P.vol != null && q.vol > P.vol) {
    dv = q.vol - P.vol;
    if (P.a1 && price >= P.a1) dir = 1; else if (P.b1 && price <= P.b1) dir = -1;
    else dir = price > P.price ? 1 : price < P.price ? -1 : 0;
    if (dir > 0) S0.buyV += dv; else if (dir < 0) S0.sellV += dv; else { S0.buyV += dv / 2; S0.sellV += dv / 2; }
  }
  const cs = S0.sellV > 0 ? S0.buyV / S0.sellV * 100 : (S0.buyV > 0 ? 300 : null);   // 체결강도(추정)
  // 벽 변화: 직전에 있던 벽이 사라졌는데 가격이 그 가격에 닿지 않았으면 = 취소(허수 의심), 닿았으면 = 소화
  if (P) {
    Object.values(S0.walls).forEach(w => {
      const still = walls.find(x => x.side === w.side && x.p === w.p);
      const lvl = (w.side === 'ask' ? asks : bids).find(x => x.p === w.p);
      const qNow = lvl ? lvl.q : 0;
      if (!still && qNow < w.q * 0.4) {
        const reached = w.side === 'ask' ? price >= w.p : price <= w.p;
        S0.ev.unshift({ t: now, k: reached ? (w.side === 'ask' ? 'eat' : 'break') : 'cancel', w, txt: reached
          ? (w.side === 'ask' ? `매도벽 ${fmt(w.p)}원(${obEok(w.amt)}) 소화 — 매수세가 위 물량을 먹음` : `매수벽 ${fmt(w.p)}원(${obEok(w.amt)}) 무너짐 — 받치던 물량이 체결로 소진`)
          : `${w.side === 'ask' ? '매도' : '매수'}벽 ${fmt(w.p)}원(${obEok(w.amt)})이 체결 없이 사라짐 — ${w.side === 'bid' ? '허매수(받치는 척) 의심' : '허매도(누르는 척) 의심'}` });
      }
    });
    walls.forEach(w => { if (!S0.walls[w.side + w.p]) S0.ev.unshift({ t: now, k: 'new', w, txt: `${w.side === 'ask' ? '매도' : '매수'}벽 등장 ${fmt(w.p)}원 · ${obEok(w.amt)} (현재가 ${w.dist >= 0 ? '+' : ''}${fmt(w.dist, 1)}%)` }); });
  }
  S0.walls = Object.fromEntries(walls.map(w => [w.side + w.p, w]));
  S0.ev = S0.ev.slice(0, 40);
  if (imb != null) { S0.imb.push(imb); if (S0.imb.length > 100) S0.imb.shift(); }
  if (cs != null) { S0.cs.push(cs); if (S0.cs.length > 100) S0.cs.shift(); }
  S0.prev = { price, vol: q.vol, a1, b1 };
  S0.n++; S0.last = r.at; S0.first = S0.first || r.at;
  return { r, q, asks, bids, a1, b1, price, totA, totB, imb, tick, spreadT, walls, cs, dv, dir };
}

/* ── 해석 문장 ── */
function obRead(x, s) {
  const out = [], ratioA = x.totB ? x.totA / x.totB : null, cs = x.cs, n = OB.s.n;
  const tone = (t, c) => out.push({ t, c });
  if (cs != null && n >= 5) {
    if (cs >= 120) tone(`체결강도 ${Math.round(cs)} — 매도 호가를 사들이는 체결이 더 많아요(매수 우위).`, 'good');
    else if (cs <= 80) tone(`체결강도 ${Math.round(cs)} — 매수 호가로 던지는 체결이 더 많아요(매도 우위).`, 'bad');
    else tone(`체결강도 ${Math.round(cs)} — 사고파는 체결이 비슷해요.`, '');
  }
  if (ratioA != null) {
    if (ratioA >= 1.5 && cs != null && cs >= 110 && n >= 5) tone(`매도 잔량이 매수의 ${fmt(ratioA, 1)}배인데도 매수 체결이 우위 — '호가창 역설': 위에 쌓인 물량을 소화하는 중이라 상승 쪽으로 보는 경우가 많아요.`, 'good');
    else if (ratioA <= 0.67 && cs != null && cs <= 90 && n >= 5) tone(`매수 잔량이 매도의 ${fmt(1 / ratioA, 1)}배로 두꺼운데 실제 체결은 매도 우위 — 아래를 받치는 척하는 '허매수'일 수 있어요. 매수 잔량만 보고 들어가지 마세요.`, 'bad');
    else if (ratioA >= 1.5) tone(`매도 잔량이 매수의 ${fmt(ratioA, 1)}배 — 위에 팔 물량이 많아요. 이 물량을 체결로 소화하는지(체결강도 상승) 확인하세요.`, '');
    else if (ratioA <= 0.67) tone(`매수 잔량이 매도의 ${fmt(1 / ratioA, 1)}배 — 아래에서 사려는 대기 물량이 많아요. 단, 잔량은 언제든 취소될 수 있어요.`, '');
  }
  const aw = x.walls.filter(w => w.side === 'ask').sort((a, b) => a.p - b.p)[0], bw = x.walls.filter(w => w.side === 'bid').sort((a, b) => b.p - a.p)[0];
  if (aw) tone(`가까운 매도벽 ${fmt(aw.p)}원(+${fmt(aw.dist, 1)}%, ${obEok(aw.amt)}) — 단기 저항. 거래량을 싣고 뚫으면 돌파 신호.`, '');
  if (bw) tone(`가까운 매수벽 ${fmt(bw.p)}원(${fmt(bw.dist, 1)}%, ${obEok(bw.amt)}) — 단기 지지 후보. 가격이 다가갈 때 사라지면 허수.`, '');
  if (x.spreadT != null && x.spreadT >= 3) tone(`매수·매도 1호가 차이가 ${x.spreadT}호가 — 거래가 얇아 시장가 주문 시 불리하게 체결될 수 있어요(지정가 권장).`, 'bad');
  const cancels = OB.s.ev.filter(e => e.k === 'cancel').length;
  if (cancels >= 2) tone(`최근 체결 없이 사라진 벽 ${cancels}번 — 호가로 분위기를 만드는 움직임이 있어요. 잔량보다 실제 체결을 믿으세요.`, 'bad');
  if (s && s.cl) tone(`차트 종합판정 ${s.cl.v}(${s.cl.s > 0 ? '+' : ''}${fmt(s.cl.s, 1)}) · 손절 기준 ${fmt(s.cl.stop)}원 — 호가는 몇 분~몇 시간 짜리 신호라, 방향은 차트·거래대금과 같이 보세요.`, '');
  return out;
}

/* ── 호가 기반 추천 매수가·매도가 ── */
function obRound(p, dir) { const t = obTick(p); return dir > 0 ? Math.ceil(p / t) * t : dir < 0 ? Math.floor(p / t) * t : Math.round(p / t) * t; }
function obPlan(x, s) {
  if (!x.price || !x.a1 || !x.b1) return null;
  const st = OB.s, cs = x.cs, ready = st.n >= 5;
  const T = x.tick, atr = (s && s.atr) || x.price * 0.03;
  const bw = x.walls.filter(w => w.side === 'bid' && w.dist > -5).sort((a, b) => b.p - a.p)[0];   // 가까운 매수벽(지지)
  const aw = x.walls.filter(w => w.side === 'ask' && w.dist < 8).sort((a, b) => a.p - b.p)[0];    // 가까운 매도벽(저항)
  const cancels = st.ev.filter(e => e.k === 'cancel').length;
  const cl = s && s.cl;
  // 매수 가능 여부
  const why = [];
  let mood = 'ok';
  if (cl && cl.s <= -28) { mood = 'no'; why.push(`차트 판정 ${cl.v}`); }
  if (s && s._ban && s._ban.length) { mood = 'no'; why.push('매수 금지 신호: ' + s._ban[0]); }
  if (ready && cs != null && cs <= 80) { mood = mood === 'no' ? 'no' : 'wait'; why.push(`체결강도 ${Math.round(cs)} (매도 우위)`); }
  if (cancels >= 2) { mood = mood === 'no' ? 'no' : 'wait'; why.push(`허수 호가 ${cancels}번`); }
  if (x.spreadT != null && x.spreadT >= 3) why.push(`1호가 차이 ${x.spreadT}호가 — 지정가만`);
  // ① 바로 사기(시장 추격): 매도 1호가 — 매수세가 강할 때만
  const buyNow = x.a1;
  const nowOk = ready && cs != null && cs >= 115 && mood === 'ok';
  // ② 기본 지정가: 매수벽 바로 위 1호가(벽 앞에서 먼저 체결) / 벽이 없으면 매수 1~2호가
  const bid2 = x.bids[1] ? x.bids[1].p : x.b1 - T;
  const buyBase = bw && bw.p >= x.price * 0.97 ? bw.p + T : (cs != null && cs >= 100 ? x.b1 : bid2);
  // ③ 눌림 대기: 하루 흔들림(ATR)의 절반 아래, 단 매수벽이 있으면 그 위
  let buyDip = obRound(x.price - atr * 0.5, -1);
  if (bw && bw.p < x.price && bw.p + T > buyDip) buyDip = bw.p + T;
  if (buyDip >= buyBase) buyDip = obRound(Math.min(buyBase - 2 * T, x.price - atr * 0.8), -1);  // 기본가와 겹치면 한 단계 더 아래
  // 손절: 차트 손절선과 '매수벽 아래 1호가' 중 가까운 쪽(벽이 무너지면 지지가 깨진 것) — 단 최소 1 ATR×0.5 거리
  const entry = buyBase;
  let stop = cl && cl.stop && cl.stop < entry ? cl.stop : obRound(entry - atr * (S.th.atr_mult || 2), -1);
  if (bw && bw.p < entry && bw.p - T > stop && entry - (bw.p - T) >= atr * 0.5) stop = bw.p - T;
  stop = obRound(stop, -1);
  const R = Math.max(entry - stop, T);
  // 매도(익절): 매도벽 바로 아래 1호가(벽에 막히기 전에) · 2R · 차트 1차 목표
  const tgts = [];
  if (aw && aw.p > entry) tgts.push({ p: aw.p - T, why: `매도벽 ${fmt(aw.p)}원(${obEok(aw.amt)}) 바로 아래 — 벽에 막히기 전에 일부 정리` });
  tgts.push({ p: obRound(entry + 2 * R, 1), why: '손절폭의 2배(손익비 2:1)' });
  if (cl && cl.t1 && cl.t1 > entry) tgts.push({ p: obRound(cl.t1, 1), why: '차트 엔진 1차 목표(저항·측정 목표)' });
  tgts.sort((a, b) => a.p - b.p);
  const uniq = tgts.filter((t, i) => !i || t.p - tgts[i - 1].p >= T * 2).slice(0, 3);
  // 수량: 설정 자본 × 1회 위험%
  const riskWon = S.capital * S.th.risk_pct / 100;
  const qty = Math.max(0, Math.min(Math.floor(riskWon / R), Math.floor(S.capital / entry)));
  // 보유 중이면 내 평균단가 기준 매도 안내
  let mine = null;
  if (typeof hAll === 'function') { const h = hAll().find(o => o.h.code === OB.code && o.qty > 0 && o.price); if (h) mine = h; }
  return { mood, why, buyNow, nowOk, buyBase, buyDip, stop, R, tgts: uniq, qty, amt: qty * entry, riskWon, entry, mine, aw, bw };
}
function obPlanHtml(p) {
  if (!p) return '';
  const head = p.mood === 'no' ? ['bad', '지금은 매수 보류', '아래 이유가 풀릴 때까지 새로 사지 않는 편이 좋아요'] : p.mood === 'wait' ? ['warn', '서두르지 말고 지정가 대기', '호가·체결이 매수 쪽으로 돌아설 때까지 낮은 가격에 걸어 두기'] : ['good', '매수 검토 가능', p.nowOk ? '매수 체결이 강해 1호가 추격도 가능' : '지정가로 나눠 사기'];
  const pctOf = v => pct((v / p.entry - 1) * 100, 1);
  return `<div class="ob-plan ${head[0]}"><h4>호가 기준 추천 가격 <span class="h-act ${head[0]}">${head[1]}</span></h4><div class="hint">${head[2]}${p.why.length ? ' · ' + p.why.map(esc).join(' · ') : ''}</div>
    <div class="ob-pl">
      <div class="b"><small>매수 ① 기본 지정가</small><b class="mono">${fmt(p.buyBase)}원</b><em>${p.bw && p.buyBase === p.bw.p + obTick(p.bw.p) ? `매수벽 ${fmt(p.bw.p)}원 바로 위 — 벽 앞에서 먼저 체결` : '매수 1~2호가 대기'}</em></div>
      <div class="b"><small>매수 ② 눌림 대기</small><b class="mono">${fmt(p.buyDip)}원</b><em>${pctOf(p.buyDip)} · 하루 흔들림 절반 아래${p.bw ? '(매수벽 위)' : ''}</em></div>
      <div class="b ${p.nowOk ? '' : 'off'}"><small>매수 ③ 바로 사기</small><b class="mono">${fmt(p.buyNow)}원</b><em>${p.nowOk ? '매도 1호가 — 체결강도가 강할 때만' : '지금은 추격 비추천'}</em></div>
      <div class="s"><small>손절가</small><b class="mono">${fmt(p.stop)}원</b><em>${pctOf(p.stop)} · ${p.bw && p.stop === p.bw.p - obTick(p.bw.p) ? '매수벽이 깨지면' : '차트·변동성 기준'}</em></div>
      ${p.tgts.map((t, i) => `<div class="t"><small>매도 ${i + 1}차(익절)</small><b class="mono">${fmt(t.p)}원</b><em>${pctOf(t.p)} · ${esc(t.why)}</em></div>`).join('')}
    </div>
    <div class="hint mt-s">기본 지정가 ${fmt(p.entry)}원 기준 · 손절폭 ${fmt(p.R)}원 · 1회 위험 ${won(p.riskWon)}(자본 ${won(S.capital)}의 ${S.th.risk_pct}%) → <b>권장 ${fmt(p.qty)}주 · 약 ${won(p.amt)}</b> <span class="muted">(설정 탭에서 자본·위험% 변경)</span></div>
    ${p.mine ? `<div class="ob-mine">내 보유: 평균 ${fmt(Math.round(p.mine.avg))}원 × ${fmt(p.mine.qty)}주 (${pct(p.mine.pnlPct, 1)}) — ${esc(p.mine.todo)}${p.aw ? ` · 위 매도벽 ${fmt(p.aw.p)}원 바로 아래(${fmt(p.aw.p - obTick(p.aw.p))}원)에 일부 매도 주문을 걸어 두는 것도 방법` : ''}</div>` : ''}
  </div>`;
}

/* ── 화면 ── */
function obSpark(arr, lo, hi, mid) {
  if (!arr || arr.length < 2) return '';
  const W = 220, H = 40, X = i => i / (arr.length - 1) * W, Y = v => H - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * H;
  return `<svg viewBox="0 0 ${W} ${H}" class="ob-spark"><line x1="0" x2="${W}" y1="${Y(mid)}" y2="${Y(mid)}" class="m"/><polyline points="${arr.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ')}"/></svg>`;
}
function obHtml(x, s) {
  const mx = Math.max(1, ...x.asks.map(a => a.q), ...x.bids.map(b => b.q));
  const pc = x.q.chgPct != null && x.price ? x.price / (1 + x.q.chgPct / 100) : null;  // 전일 종가
  const wallP = new Set(x.walls.map(w => w.side + w.p));
  const row = (lv, side) => `<div class="ob-row ${side} ${wallP.has(side + lv.p) ? 'wall' : ''} ${lv.p === x.price ? 'cur' : ''}">
      ${side === 'ask' ? `<span class="ob-q"><i style="width:${lv.q / mx * 100}%"></i><b>${fmt(lv.q)}</b></span>` : '<span></span>'}
      <span class="ob-p mono">${fmt(lv.p)}<small class="${cls(pc ? lv.p - pc : 0)}">${pc ? pct((lv.p / pc - 1) * 100, 1) : ''}</small></span>
      ${side === 'bid' ? `<span class="ob-q"><i style="width:${lv.q / mx * 100}%"></i><b>${fmt(lv.q)}</b></span>` : '<span></span>'}</div>`;
  const q = x.q, st = OB.s;
  const csTxt = x.cs == null ? '–' : Math.round(x.cs);
  const reads = obRead(x, s);
  const live = obMarketOpen();
  return `<div class="ob-head">
      <div><b>${esc((s && s.name) || q.name || OB.code)}</b> <span class="muted mono">${esc(OB.code)}</span>
        <span class="mono big ${cls(q.chgPct)}">${fmt(x.price)}원</span> <span class="mono ${cls(q.chgPct)}">${q.chgPct != null ? pct(q.chgPct) : ''}</span></div>
      <div class="hint">${live ? '<span class="gov-live"></span> 3초마다 갱신' : '장 마감 — 마지막 호가'} · ${esc(x.r.at.slice(11))} · ${esc((x.r.src || []).join('·'))} · 조회 ${st.n}회</div>
    </div>
    <div class="ob-wrap">
      <div class="ob-book">
        <div class="ob-row hd"><span>매도 잔량</span><span>호가</span><span>매수 잔량</span></div>
        ${x.asks.slice().reverse().map(a => row(a, 'ask')).join('')}
        ${x.bids.map(b => row(b, 'bid')).join('')}
        <div class="ob-row tot"><span class="mono">${fmt(x.totA)}</span><span>총 잔량</span><span class="mono">${fmt(x.totB)}</span></div>
        ${x.asks.length || x.bids.length ? '' : '<div class="empty">호가 자료를 받지 못했어요.</div>'}
      </div>
      <div class="ob-side">
        <div class="ob-tiles">
          <div><small>매수 잔량 비중</small><b class="${x.imb >= .6 ? 'up' : x.imb <= .4 ? 'down' : ''}">${x.imb == null ? '–' : Math.round(x.imb * 100) + '%'}</b>${obSpark(st.imb, 0, 1, .5)}</div>
          <div><small>체결강도(추정)</small><b class="${x.cs >= 120 ? 'up' : x.cs <= 80 ? 'down' : ''}">${csTxt}</b>${obSpark(st.cs, 50, 200, 100)}<em>${st.n < 5 ? '몇 번 더 조회하면 정확해져요' : `매수 ${fmt(st.buyV)} · 매도 ${fmt(st.sellV)}주`}</em></div>
          <div><small>1호가 차이</small><b>${x.spreadT == null ? '–' : x.spreadT + '호가'}</b><em>호가 단위 ${fmt(x.tick)}원</em></div>
          <div><small>누적 거래</small><b>${q.vol != null ? fmt(q.vol) + '주' : '–'}</b><em>${q.value != null ? obEok(q.value * (q.value < 1e7 ? 1e6 : 1)) : ''}</em></div>
        </div>
        ${obPlanHtml(obPlan(x, s))}
        <h4>지금 호가창 해석</h4>
        ${reads.length ? reads.map(r => `<div class="ob-read ${r.c}">${esc(r.t)}</div>`).join('') : '<div class="hint">아직 해석할 자료가 부족해요.</div>'}
        <h4>호가 변화 기록 <small class="muted">(이 화면을 연 뒤)</small></h4>
        <div class="ob-ev">${st.ev.length ? st.ev.slice(0, 12).map(e => `<div class="${e.k === 'cancel' || e.k === 'break' ? 'bad' : e.k === 'eat' ? 'good' : ''}"><span class="mono muted">${esc(e.t)}</span> ${esc(e.txt)}</div>`).join('') : '<div class="hint">큰 벽이 생기거나 사라지면 여기에 기록돼요.</div>'}</div>
      </div>
    </div>
    <div class="hint mt-s">체결강도는 3초 간격으로 늘어난 거래량을 '직전 매도1호가 이상 체결 = 매수, 매수1호가 이하 = 매도'로 나눈 <b>추정치</b>예요(증권사 체결강도와 다를 수 있음). 잔량은 언제든 취소될 수 있어 실제 체결보다 약한 신호예요. 시세는 네이버 증권 기준이며 몇 초 늦을 수 있어요.</div>`;
}

async function obPoll() {
  if (!OB.code || OB.busy) return;
  const box = OB.mount && document.getElementById(OB.mount);
  if (!box || box.dataset.code !== OB.code) { obStop(); return; }
  if (document.hidden) return;
  OB.busy = true;
  try {
    const r = await fetch(`${OB.API}?code=${OB.code}&t=${Date.now()}`, { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    if (!j || !j.ok) throw new Error(j && j.err || ('HTTP ' + r.status));
    const s = S.data.stocks.find(x => x.code === OB.code);
    const x = obAnalyze(j);
    box.innerHTML = obHtml(x, s);
    OB.s.err = 0;
  } catch (e) {
    OB.s.err++;
    if (OB.s.n === 0) box.innerHTML = `<div class="empty">호가를 받지 못했어요 (${esc(String(e.message || e))}). 잠시 뒤 다시 시도해요.</div>`;
  } finally { OB.busy = false; }
  if (!obMarketOpen() && OB.s.n > 0) obStop();  // 장 마감 뒤에는 한 번만
  if (OB.s.err >= 5) obStop();
}
function obStart(code, mount) {
  obStop();
  OB.code = code; OB.mount = mount; obReset(code);
  const box = document.getElementById(mount); if (!box) return;
  box.dataset.code = code;
  box.innerHTML = '<div class="hint">호가 불러오는 중…</div>';
  obPoll();
  OB.timer = setInterval(obPoll, 3000);
  OB.idle = setTimeout(obStop, 30 * 60e3);  // 30분 지나면 자동 멈춤(서버 사용량 절약)
}
function obStop() { clearInterval(OB.timer); clearTimeout(OB.idle); OB.timer = null; }

/* 호가 분석 탭 */
function obSearch() {
  const q = $('#obQ').value.trim(); if (!q) return;
  const hits = typeof findStocks === 'function' ? findStocks(q) : [];
  const s = hits.length === 1 || (hits[0] && (hits[0].name === q || hits[0].code === q)) ? hits[0] : null;
  if (!s && /^\d{6}$/.test(q)) { obStart(q, 'obMount'); return; }
  if (!s) {
    $('#obMount').dataset.code = '';
    $('#obMount').innerHTML = hits.length ? `<div class="hint">여러 종목이 검색됐어요 — 하나를 고르세요</div><div class="chips mt-s">${hits.slice(0, 20).map(h => `<button class="chip" data-ob="${esc(h.code)}">${esc(h.name)}</button>`).join('')}</div>` : `<div class="empty">"${esc(q)}" 종목을 찾지 못했어요.</div>`;
    $$('#obMount [data-ob]').forEach(b => b.onclick = () => { $('#obQ').value = b.textContent; obStart(b.dataset.ob, 'obMount'); });
    return;
  }
  obStart(s.code, 'obMount');
}
function initOrderbook() {
  if ($('#obGo')) {
    $('#obGo').onclick = obSearch;
    $('#obQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); obSearch(); } };
    $('#obQ').onchange = () => { if (findStocks($('#obQ').value).length === 1) obSearch(); };
    $('#obStop').onclick = () => { obStop(); const h = $('#obMount .ob-head .hint'); if (h) h.textContent = '멈춤 — 검색을 다시 누르면 이어서 갱신해요'; };
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && OB.timer) obPoll(); });
  // 다른 탭으로 가면 자동 멈춤
  $$('#tabs button').forEach(b => b.addEventListener('click', () => { if (OB.mount === 'obMount' && b.dataset.tab !== 'ob') obStop(); if (OB.mount === 'obAnMount' && b.dataset.tab !== 'analysis') obStop(); }));
}
(function waitBootOb() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof findStocks === 'function' && $('#tabs')) initOrderbook();
  else setTimeout(waitBootOb, 400);
})();
