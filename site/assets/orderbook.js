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
  OB.s = { code, n: 0, prev: null, buyV: 0, sellV: 0, imb: [], cs: [], ev: [], walls: {}, first: null, last: null, err: 0, feed: [], hist: [], lastX: null, lastSum: 0, evSeen: 0, said: {} };
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

/* ── 실시간 해설: 3초마다 바뀐 점을 문장으로 ── */
const OB_SAY_KEY = 'obSpeak';
function obSay(lvl, txt, speak) {
  const t = obKst().toISOString().slice(11, 19);
  const F = OB.s.feed;
  if (F[0] && F[0].txt === txt) return;           // 같은 말 반복 안 함
  F.unshift({ t, lvl, txt }); if (F.length > 80) F.pop();
  if (speak && store.get(OB_SAY_KEY, false) && 'speechSynthesis' in window && !document.hidden) {
    try { const u = new SpeechSynthesisUtterance(txt.replace(/[()·—]/g, ' ').replace(/(\d),(\d)/g, '$1$2')); u.lang = 'ko-KR'; u.rate = 1.1; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
  }
}
function obNarrate(x, s) {
  const st = OB.s, p = st.lastX, T = x.tick;
  st.hist.push({ price: x.price, cs: x.cs, imb: x.imb, dv: x.dv, t: Date.now() }); if (st.hist.length > 200) st.hist.shift();
  const live = obMarketOpen();
  if (!p) {
    const ra = x.totB ? x.totA / x.totB : null;
    obSay('key', `해설 시작 — 현재가 ${fmt(x.price)}원${x.q.chgPct != null ? `(${x.q.chgPct > 0 ? '+' : ''}${fmt(x.q.chgPct, 2)}%)` : ''}. ${ra == null ? '' : ra >= 1.3 ? `위에 팔려는 물량이 아래 사려는 물량의 ${fmt(ra, 1)}배로 더 많아요.` : ra <= 0.77 ? `아래 사려는 물량이 위 팔 물량의 ${fmt(1 / ra, 1)}배로 더 많아요.` : '사려는 물량과 팔려는 물량이 비슷해요.'}${live ? '' : ' 지금은 장이 끝난 상태라 마지막 호가 기준 해설이에요.'}`, true);
    if (!live) {
      const aw = x.walls.find(w => w.side === 'ask'), bw = x.walls.find(w => w.side === 'bid');
      if (aw) obSay('info', `마감 호가에 ${fmt(aw.p)}원 매도 대기 ${obEok(aw.amt)} — 다음 장 초반 저항으로 볼 자리예요.`);
      if (bw) obSay('info', `마감 호가에 ${fmt(bw.p)}원 매수 대기 ${obEok(bw.amt)} — 다음 장 초반 지지 후보예요.`);
    }
    st.lastX = x; return;
  }
  // ① 가격 변화
  if (x.price !== p.price) {
    const up = x.price > p.price, ticks = Math.round(Math.abs(x.price - p.price) / T);
    const lvl1 = up ? p.asks[0] : p.bids[0];
    obSay(up ? 'good' : 'bad', `${up ? '▲' : '▼'} ${fmt(p.price)} → ${fmt(x.price)}원 (${up ? '+' : '-'}${ticks}호가). ${up ? `매수세가 매도 1호가${lvl1 ? ` ${fmt(lvl1.q)}주` : ''}를 사들이며 올렸어요.` : `매도세가 매수 1호가${lvl1 ? ` ${fmt(lvl1.q)}주` : ''}에 던지며 내렸어요.`}`, ticks >= 2);
  }
  // ② 대량 체결
  const dvs = st.hist.slice(-21, -1).map(h => h.dv || 0).filter(v => v > 0);
  const avgDv = dvs.length ? dvs.reduce((a, b) => a + b, 0) / dvs.length : 0;
  if (x.dv > 0 && avgDv > 0 && x.dv >= avgDv * 3 && x.dv * x.price >= 3e8) {
    obSay(x.dir > 0 ? 'good' : x.dir < 0 ? 'bad' : 'key', `대량 체결 ${fmt(x.dv)}주(약 ${obEok(x.dv * x.price)}) — 평소 3초 거래의 ${fmt(x.dv / avgDv, 1)}배, ${x.dir > 0 ? '사는 쪽이 매도 호가를 한꺼번에 가져갔어요(큰손 매수 의심).' : x.dir < 0 ? '파는 쪽이 매수 호가에 한꺼번에 던졌어요(큰손 매도 의심).' : '방향은 중립이에요.'}`, true);
  }
  // ③ 1호가 잔량 소진(가격은 그대로)
  if (x.price === p.price && p.asks[0] && x.asks[0] && x.asks[0].p === p.asks[0].p && p.asks[0].q > 0 && x.asks[0].q < p.asks[0].q * 0.5 && (p.asks[0].q - x.asks[0].q) * x.asks[0].p >= 1e8)
    obSay('good', `매도 1호가 ${fmt(x.asks[0].p)}원 잔량이 ${fmt(p.asks[0].q)} → ${fmt(x.asks[0].q)}주로 빠르게 줄어요 — 한 호가 위로 올라서려는 시도예요.`);
  if (x.price === p.price && p.bids[0] && x.bids[0] && x.bids[0].p === p.bids[0].p && p.bids[0].q > 0 && x.bids[0].q < p.bids[0].q * 0.5 && (p.bids[0].q - x.bids[0].q) * x.bids[0].p >= 1e8)
    obSay('bad', `매수 1호가 ${fmt(x.bids[0].p)}원 잔량이 ${fmt(p.bids[0].q)} → ${fmt(x.bids[0].q)}주로 줄어요 — 체결이나 취소로 받침이 얇아지는 중.`);
  // ④ 체결강도 기준선 통과
  if (st.n >= 6 && p.cs != null && x.cs != null) {
    const cross = (lv) => (p.cs < lv && x.cs >= lv) ? 1 : (p.cs >= lv && x.cs < lv) ? -1 : 0;
    if (cross(120) === 1) obSay('good', `체결강도 ${Math.round(x.cs)} — 120을 넘었어요. 사는 체결이 확실히 우세해졌어요.`, true);
    else if (cross(100) === 1) obSay('info', `체결강도 ${Math.round(x.cs)} — 100 위로 올라와 사는 쪽이 조금 앞서기 시작했어요.`);
    else if (cross(100) === -1) obSay('info', `체결강도 ${Math.round(x.cs)} — 100 아래로 내려와 파는 쪽이 앞서기 시작했어요.`);
    if (cross(80) === -1) obSay('bad', `체결강도 ${Math.round(x.cs)} — 80 아래, 파는 체결이 확실히 우세해요.`, true);
  }
  // ⑤ 잔량 균형 변화
  if (p.imb != null && x.imb != null) {
    if (p.imb < 0.6 && x.imb >= 0.6) obSay('info', `매수 잔량 비중 ${Math.round(x.imb * 100)}% — 아래에서 사려는 대기 주문이 두꺼워졌어요(취소될 수 있으니 체결과 함께 보기).`);
    if (p.imb > 0.4 && x.imb <= 0.4) obSay('info', `매도 잔량 비중 ${Math.round((1 - x.imb) * 100)}% — 위에 팔 물량이 쌓였어요. 이 물량을 체결로 먹어 치우면 오히려 상승 신호예요.`);
  }
  // ⑥ 벽 접근
  x.walls.forEach(w => {
    const k = 'near' + w.side + w.p;
    if (Math.abs(w.p - x.price) <= T && !st.said[k]) { st.said[k] = 1; obSay('key', w.side === 'ask' ? `${fmt(w.p)}원 매도벽(${obEok(w.amt)}) 바로 앞 — 여기서 거래량 실어 뚫으면 돌파, 막히면 되밀림 주의.` : `${fmt(w.p)}원 매수벽(${obEok(w.amt)}) 바로 위 — 여기서 버티면 지지 확인, 벽이 사라지면 허수.`, true); }
  });
  // ⑦ 벽 생김·사라짐(분석 단계에서 잡은 것)
  st.ev.slice(0, Math.max(0, st.ev.length - st.evSeen)).reverse().forEach(e => obSay(e.k === 'cancel' || e.k === 'break' ? 'bad' : e.k === 'eat' ? 'good' : 'info', e.txt, e.k !== 'new'));
  st.evSeen = st.ev.length;
  // ⑧ 1분 요약 (조용할 때도 흐름을 알 수 있게)
  if (Date.now() - st.lastSum >= 60e3 && st.hist.length >= 10) {
    st.lastSum = Date.now();
    const h0 = st.hist.find(h => Date.now() - h.t <= 65e3) || st.hist[0], d = x.price - h0.price;
    obSay('sum', `1분 요약 — 가격 ${d === 0 ? '제자리' : (d > 0 ? '+' : '') + fmt(d) + '원'}, 체결강도 ${x.cs == null ? '-' : Math.round(x.cs)}, 매수 잔량 비중 ${x.imb == null ? '-' : Math.round(x.imb * 100) + '%'}. ${obHeadline(x, s).t}`);
  }
  st.lastX = x;
}
// 지금 상황 한 줄 + 다음에 볼 자리
function obHeadline(x, s) {
  const st = OB.s, H = st.hist, cs = x.cs, ready = st.n >= 5;
  const old = H.length > 20 ? H[H.length - 21] : H[0], mv = old ? x.price - old.price : 0;
  const aw = x.walls.filter(w => w.side === 'ask' && w.p >= x.price).sort((a, b) => a.p - b.p)[0];
  const bw = x.walls.filter(w => w.side === 'bid' && w.p <= x.price).sort((a, b) => b.p - a.p)[0];
  const up = x.asks[0] ? x.asks[0].p : x.price, dn = x.bids[0] ? x.bids[0].p : x.price;
  let t, c;
  if (!ready) { t = '흐름을 읽는 중이에요 — 15초쯤 지나면 매수·매도 우위를 판단해요.'; c = ''; }
  else if (cs >= 120 && mv >= 0) { t = `매수 우위 — 사는 체결이 강하고(체결강도 ${Math.round(cs)}) 가격도 ${mv > 0 ? '오르는' : '버티는'} 중이에요.`; c = 'good'; }
  else if (cs <= 80 && mv <= 0) { t = `매도 우위 — 파는 체결이 강하고(체결강도 ${Math.round(cs)}) 가격도 ${mv < 0 ? '밀리는' : '눌린'} 중이에요.`; c = 'bad'; }
  else if (cs >= 110 && x.imb != null && x.imb < 0.4) { t = '위 매도 물량을 매수세가 소화 중 — 물량을 다 먹으면 한 단계 올라설 수 있어요.'; c = 'good'; }
  else if (cs <= 90 && x.imb != null && x.imb > 0.6) { t = '아래 매수 잔량은 두꺼운데 체결은 매도 — 받치는 척하는 물량일 수 있어요.'; c = 'bad'; }
  else { t = `팽팽한 줄다리기 — 체결강도 ${cs == null ? '-' : Math.round(cs)}, 뚜렷한 방향이 아직 없어요.`; c = ''; }
  const watch = `다음에 볼 자리: 위 ${fmt(aw ? aw.p : up)}원${aw ? `(매도벽 ${obEok(aw.amt)})` : ''} 돌파 여부 · 아래 ${fmt(bw ? bw.p : dn)}원${bw ? `(매수벽 ${obEok(bw.amt)})` : ''} 지지 여부`;
  return { t, c, watch };
}
function obLiveHtml(x, s) {
  const h = obHeadline(x, s), F = OB.s.feed, on = store.get(OB_SAY_KEY, false);
  return `<div class="ob-live ${h.c}">
    <div class="ob-live-h"><b>🎙 실시간 해설</b><span class="ob-hl">${esc(h.t)}</span>
      <button class="btn ghost small" data-obspeak>${on ? '🔊 음성 해설 켜짐' : '🔈 음성 해설 켜기'}</button></div>
    <div class="hint">${esc(h.watch)}</div>
    <div class="ob-feed">${F.length ? F.slice(0, OB.more ? 60 : 7).map(f => `<div class="${f.lvl}"><span class="mono muted">${esc(f.t)}</span> ${esc(f.txt)}</div>`).join('') : '<div class="hint">변화가 생기면 여기에 바로 문장으로 알려 드려요.</div>'}</div>
    ${F.length > 7 ? `<button class="btn ghost small" data-obmore>${OB.more ? '접기' : `해설 ${F.length}개 모두 보기`}</button>` : ''}
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
    ${obLiveHtml(x, s)}
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
          <div><small>누적 거래</small><b>${q.vol != null ? fmt(q.vol) + '주' : '–'}</b><em>${q.value != null ? obEok(q.value) : ''}</em></div>
        </div>
        ${obPlanHtml(obPlan(x, s))}
        <h4>지금 호가창 해석</h4>
        ${reads.length ? reads.map(r => `<div class="ob-read ${r.c}">${esc(r.t)}</div>`).join('') : '<div class="hint">아직 해석할 자료가 부족해요.</div>'}
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
    // 장 마감 뒤 네이버 시세가 등락률을 0으로 돌려줄 때가 있어, 그때는 수집된 당일 등락률로 보정
    if (j.quote && !obMarketOpen() && !j.quote.chgPct && s && s.chg && j.quote.price === s.close) j.quote.chgPct = s.chg;
    const x = obAnalyze(j);
    obNarrate(x, s);
    box.innerHTML = obHtml(x, s);
    obBindLive(box, x, s);
    OB.s.err = 0;
  } catch (e) {
    OB.s.err++;
    if (OB.s.n === 0) box.innerHTML = `<div class="empty">호가를 받지 못했어요 (${esc(String(e.message || e))}). 잠시 뒤 다시 시도해요.</div>`;
  } finally { OB.busy = false; }
  if (!obMarketOpen() && OB.s.n > 0) obStop();  // 장 마감 뒤에는 한 번만
  if (OB.s.err >= 5) obStop();
}
function obBindLive(box, x, s) {
  const sp = box.querySelector('[data-obspeak]');
  if (sp) sp.onclick = () => { const v = !store.get(OB_SAY_KEY, false); store.set(OB_SAY_KEY, v); if (!v && 'speechSynthesis' in window) speechSynthesis.cancel(); else obSay('key', '음성 해설을 시작합니다.', true); box.innerHTML = obHtml(x, s); obBindLive(box, x, s); };
  const mb = box.querySelector('[data-obmore]');
  if (mb) mb.onclick = () => { OB.more = !OB.more; box.innerHTML = obHtml(x, s); obBindLive(box, x, s); };
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
function obStop() { clearInterval(OB.timer); clearTimeout(OB.idle); OB.timer = null; try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {} }

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
