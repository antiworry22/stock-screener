/* 섹터 흐름 — 오늘 업종별로 「주도 · 상승 · 반등 · 혼조 · 하락 · 하향 전환 · 약세 심화」를 실시간으로 가르고
   왜 그런지(이유) · 해석 · 평가(내일까지 이어질 가능성) · 대응 · 업종별 주도주를 붙임.
   자료: /api/sectors(네이버 업종 전체 + 구성 종목 실시간, 1분) → 안 되면 분석 대상 종목(15분 시세)을 업종별로 묶어 계산.
   이유 계산에는 종목 자료(5일 등락 · 20일 평균 거래대금 · 거래대금 흐름 · 외국인/기관 · 뉴스 · 미국장 영향 · 차트 판정)를 함께 씀 */
'use strict';

const SF = { net: null, nt: 0, busy: false, filter: 'all', sort: 'chg', open: new Set(), sel: null };
const SF_ST = {
  lead: ['주도', 'up', '업종 전체에 돈이 몰리며 시장을 끌고 가는 섹터'],
  up: ['상승', 'up', '오르는 쪽으로 기운 섹터'],
  rebound: ['반등', 'up', '며칠 빠진 뒤 되오르는 섹터'],
  mixed: ['혼조', '', '오르는 종목과 내리는 종목이 섞인 섹터'],
  down: ['하락', 'down', '내리는 쪽으로 기운 섹터'],
  turn: ['하향 전환', 'down', '오르던 흐름이 꺾이기 시작한 섹터'],
  weak: ['약세 심화', 'down', '종목을 가리지 않고 빠지며 약세가 깊어지는 섹터'],
};
const sfKst = () => new Date(Date.now() + 9 * 3600e3);
const sfToday = () => sfKst().toISOString().slice(0, 10);
const sfMin = () => { const k = sfKst(); return k.getUTCHours() * 60 + k.getUTCMinutes(); };
const sfOpen = () => { const k = sfKst(), m = sfMin(), wd = k.getUTCDay(); return wd >= 1 && wd <= 5 && m >= 540 && m <= 930; };
const sfEok = v => v == null ? '–' : `${v < 0 ? '−' : ''}${Math.abs(v) >= 10000 ? fmt(Math.abs(v) / 10000, 2) + '조' : fmt(Math.abs(v), Math.abs(v) < 10 ? 1 : 0) + '억'}`;
const sfP = v => v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, Math.abs(v) < 10 ? 2 : 1)}%`;
const sfC = (v, a, b) => Math.max(a, Math.min(b, v));

async function sfLoad(force) {
  const gap = sfOpen() ? (typeof svGap === 'function' ? svGap(55e3, 180e3) : 55e3) : 600e3;
  if (!force && Date.now() - SF.nt < gap) return;
  SF.nt = Date.now();
  try { const r = await fetch('/api/sectors', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j && j.ok && j.list && j.list.length) SF.net = j; } } catch (e) {}
}

/* 장중이면 오늘 거래대금을 하루치로 환산하는 비율 */
function sfFrac() {
  if (!sfOpen()) return 1;
  const m = sfMin() - 540; return sfC(m / 390, 0.08, 1);
}
/* 종목 하나의 보조 자료 (분석 대상 종목일 때만) */
function sfAux(s) {
  if (!s) return {};
  const c = s.spark || [], v = s.spark_vol || [];
  let a20 = null;
  if (c.length >= 21 && v.length >= 21) { let t = 0, n = 0; for (let k = c.length - 21; k < c.length - 1; k++) if (c[k] != null && v[k] != null) { t += c[k] * v[k] / 1e8; n++; } a20 = n ? t / n : null; }
  const x = s._inv, days = (typeof INV !== 'undefined' && INV.d && INV.d.meta.days) || [];
  const sum5 = a => a ? a.slice(-5).reduce((p, q) => p + (q || 0), 0) : null;
  const tdy = days.length && days[days.length - 1] === sfToday().replace(/-/g, '');
  return { a20, f5: x ? sum5(x.f) : null, i5: x ? sum5(x.i) : null, fT: x && tdy ? x.f[x.f.length - 1] : null, iT: x && tdy && x.i ? x.i[x.i.length - 1] : null,
    tvf: s._tvf || null, news: s._newsLive ?? null, nw: s._nw || null, us: s.us_impact ?? null, ret5: s.ret5 ?? null, cl: s.cl ? s.cl.s : null, mcap: s.mcap || null };
}

/* 섹터 목록 만들기 */
function sfBuild() {
  if (!S.data) return [];
  const by = new Map(S.data.stocks.map(s => [s.code, s]));
  const day = S.data.meta ? S.data.meta.asof : '';
  let secs = [];
  if (SF.net && SF.net.list.length) {
    secs = SF.net.list.map(x => ({ key: 'n' + x.no, name: x.name, chg: x.pct, n: x.n, up: x.up, dn: x.dn, flat: x.flat, src: 'live',
      mem: (SF.net.det[x.no] || []).map(m => { const s = by.get(m.c); return { code: m.c, name: m.n, p: m.p, r: m.r, tv: m.tv, s, ...sfAux(s) }; }) }));
  } else {
    const g = {};
    S.data.stocks.forEach(s => { if (!s.sector || s.sector === '기타') return; (g[s.sector] = g[s.sector] || []).push(s); });
    secs = Object.entries(g).filter(([, L]) => L.length >= 2).map(([name, L]) => {
      const mem = L.map(s => { const lv = s._live && s._live.d && s._live.d >= day ? s._live : null; return { code: s.code, name: s.name, p: lv ? lv.c : s.close, r: lv ? lv.chg : s.chg, tv: s.tvalue ?? null, s, ...sfAux(s) }; });
      const W = mem.reduce((a, m) => a + (m.mcap || 1), 0);
      const chg = mem.filter(m => m.r != null).reduce((a, m) => a + m.r * (m.mcap || 1), 0) / (W || 1);
      return { key: 'o' + name, name, chg: Math.round(chg * 100) / 100, n: mem.length, up: mem.filter(m => m.r > 0).length, dn: mem.filter(m => m.r < 0).length, flat: mem.filter(m => m.r === 0).length, src: 'own', mem };
    });
  }
  secs = secs.filter(x => x.chg != null && (x.n || x.mem.length));
  // 순위·스냅숏 비교
  const snaps = sfSnaps(), ts = Object.keys(snaps).sort(), now = sfMin();
  const past = (mins) => { for (let i = ts.length - 1; i >= 0; i--) { const t = ts[i], tm = +t.slice(0, 2) * 60 + +t.slice(3, 5); if (now - tm >= mins) return snaps[t]; } return null; };
  const s0 = ts.length ? snaps[ts[0]] : null, s60 = past(55);
  secs.sort((a, b) => b.chg - a.chg).forEach((x, i) => { x.rank = i + 1; });
  const N = secs.length, frac = sfFrac();
  secs.forEach(x => sfAnalyze(x, N, frac, s0 && s0[x.key], s60 && s60[x.key], s0 ? ts[0] : null));
  return secs;
}

/* 한 섹터 분석: 상태 · 이유 · 해석 · 평가 · 대응 · 주도주 */
function sfAnalyze(x, N, frac, c0, c60, t0) {
  const M = x.mem.filter(m => m.r != null);
  const br = x.up != null && x.up + x.dn ? x.up / (x.up + x.dn) * 100 : null;
  // 거래대금: 오늘(하루치 환산) ÷ 20일 평균 — 분석 대상 종목만
  const H = M.filter(m => m.a20 && m.tv != null);
  const today = sfToday(), fr = m => x.src === 'live' || (m.s && m.s._live && m.s._live.d === today) ? frac : 1;   // 오늘 장중 누적값만 하루치로 환산
  const heat = H.length >= 2 ? H.reduce((a, m) => a + m.tv / fr(m), 0) / H.reduce((a, m) => a + m.a20, 0) : null;
  const tvSum = M.reduce((a, m) => a + (m.tv || 0), 0);
  // 업종 등락에 대한 기여(시가총액 또는 거래대금 가중)
  const wOf = m => m.mcap || (m.tv ? m.tv * 30 : 1);
  const W = M.reduce((a, m) => a + wOf(m), 0) || 1;
  M.forEach(m => { m.ctb = wOf(m) * m.r / W; m.tvSh = tvSum ? (m.tv || 0) / tvSum : 0; });
  const pos = M.filter(m => m.ctb > 0).reduce((a, m) => a + m.ctb, 0), neg = M.filter(m => m.ctb < 0).reduce((a, m) => a + m.ctb, 0);
  const sideMem = x.chg >= 0 ? M.filter(m => m.ctb > 0).sort((a, b) => b.ctb - a.ctb) : M.filter(m => m.ctb < 0).sort((a, b) => a.ctb - b.ctb);
  const top = sideMem[0], topShare = top ? Math.abs(top.ctb) / Math.abs(x.chg >= 0 ? pos : neg || 1) : 0;
  // 5일 흐름 · 수급 · 뉴스 · 거래대금 흐름 · 미국장 · 차트
  const avg = (k, L = M) => { const v = L.map(m => m[k]).filter(z => z != null); return v.length ? v.reduce((a, z) => a + z, 0) / v.length : null; };
  const ret5 = avg('ret5'), us = avg('us'), cl = avg('cl'), news = avg('news');
  const sumK = k => { const v = M.map(m => m[k]).filter(z => z != null); return v.length ? v.reduce((a, z) => a + z, 0) : null; };
  const fT = sumK('fT'), iT = sumK('iT'), f5 = sumK('f5'), i5 = sumK('i5');
  const tvfUp = M.filter(m => m.tvf && (m.tvf.k === 'up' || m.tvf.k === 'hold')).length, tvfDn = M.filter(m => m.tvf && (m.tvf.k === 'down' || m.tvf.k === 'dump')).length;
  const nPos = M.filter(m => m.nw && m.nw.nPos >= 1).length, nNeg = M.filter(m => m.nw && m.nw.nNeg >= 1).length;
  const dIn = c0 != null ? x.chg - c0 : null, d60 = c60 != null ? x.chg - c60 : null;
  // 상태
  let st;
  const big = (x.n || M.length) >= 4;
  if (x.chg >= 1.5 && (br == null || br >= 60) && (x.rank <= Math.max(3, Math.round(N * 0.08)) || (heat != null && heat >= 1.3)) && big) st = 'lead';
  else if (x.chg <= -1.5 && (br == null || br <= 35) && (ret5 == null || ret5 <= -2)) st = 'weak';
  else if (x.chg <= -0.5 && ret5 != null && ret5 >= 3) st = 'turn';
  else if (x.chg >= 0.7 && ret5 != null && ret5 <= -3) st = 'rebound';
  else if (x.chg >= 0.5) st = 'up';
  else if (x.chg <= -0.5) st = 'down';
  else st = 'mixed';
  // 이유(왜)
  const why = [];
  if (br != null) why.push(br >= 70 ? `${x.up + x.dn}종목 중 ${x.up}종목 상승(${fmt(br, 0)}%) — 업종 전체가 함께 움직여요` : br <= 30 ? `${x.up + x.dn}종목 중 ${x.dn}종목 하락(${fmt(100 - br, 0)}%) — 업종 전체가 밀려요` : `오른 ${x.up} · 내린 ${x.dn}종목 — 종목별로 엇갈려요`);
  if (top && Math.abs(x.chg) >= 0.3 && M.length >= 3) why.push(topShare >= 0.55 ? `${top.name}${sfJosa(top.name)} 업종 ${x.chg >= 0 ? '상승' : '하락'}의 약 ${fmt(topShare * 100, 0)}%를 혼자 만들었어요(${sfP(top.r)})` : `${sideMem.slice(0, 3).map(m => `${m.name}(${sfP(m.r)})`).join(', ')} 등이 함께 ${x.chg >= 0 ? '끌어올려요' : '끌어내려요'}`);
  if (heat != null) why.push(heat >= 1.4 ? `거래대금이 평소(20일 평균)의 ${fmt(heat, 1)}배 — 돈이 몰리고 있어요${x.chg < 0 ? '(팔자 물량)' : ''}` : heat <= 0.75 ? `거래대금이 평소의 ${fmt(heat, 2)}배 — 거래가 한산해요` : `거래대금은 평소 수준(${fmt(heat, 2)}배)`);
  if (fT != null && Math.abs(fT) >= 20) why.push(`오늘 외국인 ${sfEok(fT)}${iT != null ? ` · 기관 ${sfEok(iT)}` : ''}(장중 잠정, 분석 대상 종목 합)`);
  else if (f5 != null && Math.abs(f5) >= 50) why.push(`최근 5일 외국인 ${sfEok(f5)}${i5 != null ? ` · 기관 ${sfEok(i5)}` : ''} ${f5 > 0 ? '순매수' : '순매도'}`);
  if (nPos + nNeg >= 1) why.push(nPos > nNeg ? `구성 종목 ${nPos}곳에 호재 뉴스·공시` : nNeg > nPos ? `구성 종목 ${nNeg}곳에 악재 뉴스·공시` : `호재·악재 뉴스가 섞여 있어요(${nPos}/${nNeg})`);
  if (us != null && Math.abs(us) >= 0.4) why.push(`연결된 미국 지표 영향 ${sfP(us)} — 전날 밤 미국장${us > 0 ? '이 우호적' : '이 부담'}`);
  if (tvfUp + tvfDn >= 2) why.push(tvfUp > tvfDn ? `거래대금 상승 유입·시가 지지형 ${tvfUp}종목` : `거래대금 하락 이탈·대량 매도형 ${tvfDn}종목`);
  if (ret5 != null) why.push(`최근 1주 업종 평균 ${sfP(ret5)}`);
  if (dIn != null && Math.abs(dIn) >= 0.5 && t0) why.push(`${t0} 대비 ${dIn > 0 ? '+' : ''}${fmt(dIn, 2)}%p ${dIn > 0 ? '강해짐' : '약해짐'}`);
  // 해석
  const read = [];
  if (st === 'lead') read.push(topShare >= 0.55 ? `${top.name} 중심의 주도 — 대장주 한 종목이 강하게 끌고 나머지가 따라붙는 모습이에요. 대장주가 꺾이면 업종도 같이 식어요.` : '여러 종목이 고르게 오르며 돈이 몰리는 진짜 주도 흐름이에요. 이런 날은 업종 안 2·3등주까지 함께 움직여요.');
  if (st === 'up') read.push(heat != null && heat <= 0.85 ? '오르긴 하지만 거래가 적어요 — 매물이 없어서 오르는 것이라 힘은 약한 편이에요.' : topShare >= 0.6 ? `${top.name} 한 종목 효과가 커요 — 업종 전체 흐름이라기보다 개별 종목 이슈에 가까워요.` : '업종이 무난하게 오르는 중이에요. 주도로 올라서려면 거래대금이 더 붙어야 해요.');
  if (st === 'rebound') read.push(`1주 ${sfP(ret5)} 빠진 뒤의 되오름이에요.${fT != null && fT > 0 ? ' 외국인이 함께 사서 반등의 질이 좋아요.' : ' 수급이 붙지 않으면 하루짜리 반등으로 끝나기 쉬워요.'}`);
  if (st === 'mixed') read.push('업종 방향이 없어요 — 업종보다 종목별 재료·차트가 중요한 날이에요.');
  if (st === 'down') read.push(heat != null && heat >= 1.3 ? '거래가 실린 하락이에요 — 차익 실현이나 악재로 물량이 나오는 중이에요.' : '거래가 많지 않은 하락이라 공포성 매도보다는 쉬어 가는 흐름에 가까워요.');
  if (st === 'turn') read.push(`최근 1주 ${sfP(ret5)} 오른 업종이 오늘 꺾였어요 — 차익 실현이 시작됐을 수 있어요.${heat != null && heat >= 1.2 ? ' 거래가 실려 있어 하루로 끝나지 않을 수 있어요.' : ''}`);
  if (st === 'weak') read.push(`종목을 가리지 않고 빠지며 1주 ${sfP(ret5)}까지 밀렸어요 — 업종 전체에서 돈이 빠져나가는 중이에요.`);
  if (us != null && Math.abs(us) >= 0.8 && Math.sign(us) === Math.sign(x.chg)) read.push(`미국 관련 업종 흐름(${sfP(us)})이 그대로 이어진 움직임이에요.`);
  if (nPos >= 2 && x.chg > 0) read.push('뉴스·공시 호재가 여러 종목에 걸쳐 있어 테마성 매수가 붙었을 수 있어요.');
  if (dIn != null && dIn <= -0.8 && x.chg > 0) read.push('장 초반보다 상승 폭이 크게 줄었어요 — 위에서 매물이 나오고 있어요.');
  if (dIn != null && dIn >= 0.8 && x.chg > 0) read.push('장 초반보다 더 강해지고 있어요 — 시간이 갈수록 매수가 붙는 좋은 모양이에요.');
  // 평가(내일까지 이어질 가능성)
  let sc = 50 + sfC(x.chg * 6, -18, 18);
  if (br != null) sc += (br - 50) * 0.25;
  if (heat != null) sc += sfC((heat - 1) * 20, -8, 12) * (x.chg >= 0 ? 1 : -1);
  if (fT != null) sc += sfC(fT / 100 * 4, -8, 8); else if (f5 != null) sc += sfC(f5 / 300 * 4, -6, 6);
  if (tvfUp + tvfDn) sc += sfC((tvfUp - tvfDn) * 2, -6, 6);
  if (news != null) sc += sfC(news / 10, -4, 4);
  if (cl != null) sc += sfC(cl / 10, -5, 5);
  if (topShare >= 0.6 && x.chg > 0) sc -= 8;
  if (dIn != null) sc += sfC(dIn * 3, -6, 6);
  sc = Math.round(sfC(sc, 0, 100));
  const g = sc >= 72 ? ['A', x.chg >= 0 ? '내일도 이어질 가능성 높음' : '반등 가능성 높음'] : sc >= 60 ? ['B', '이어질 가능성 있음'] : sc >= 45 ? ['C', '하루 흐름 — 내일 확인 필요'] : sc >= 33 ? ['D', '약세가 이어질 수 있음'] : ['E', '피하는 편이 좋은 섹터'];
  // 대응
  const todo = {
    lead: ['대장주는 오늘 추격보다 5일선·전일 고가 근처 눌림에서', '후발주는 대장주가 꺾이지 않는 동안만 — 대장주 −3% 이탈 시 같이 정리', '보유 중이면 트레일링 손절로 수익 지키며 보유'],
    up: ['거래대금이 더 붙는지(평소의 1.3배↑) 확인 뒤 비중 늘리기', '업종 안에서도 수급(외국인·기관) 붙은 종목 위주'],
    rebound: ['반등 첫날 추격 말고 이틀째 지지 확인 뒤', '외국인 매수가 이어지면 반등 신뢰도 상승'],
    mixed: ['업종 이유로 사지 말고 종목별 신호(매매 타이밍)로 판단'],
    down: ['신규 매수는 하락이 멈추는 날(아래꼬리·거래 감소)까지 대기', '보유 종목은 손절선만 점검'],
    turn: ['보유 중이면 일부 이익 실현 · 트레일링 당기기', '오늘 새로 사지 않기 — 이틀 연속 하락이면 추세 전환 가능성'],
    weak: ['신규 매수 금지 — 바닥은 투매(거래 폭증) 뒤에 나와요', '보유 종목 손절선 이탈 시 미루지 말기'],
  }[st];
  // 주도주 (오르는 섹터: 오른 종목 중 / 내리는 섹터: 하락을 이끈 종목)
  const leaders = (x.chg >= 0 ? M.filter(m => m.r > 0) : M.filter(m => m.r < 0)).map(m => {
    const rk = x.chg >= 0 ? m.r : -m.r;
    let ls = sfC(rk, 0, 10) / 10 * 45 + sfC(m.tvSh, 0, 0.4) / 0.4 * 35;
    if (m.tvf && (m.tvf.k === 'up' || m.tvf.k === 'hold')) ls += x.chg >= 0 ? 8 : 0;
    if (m.fT != null) ls += sfC(m.fT / 50 * 5, -8, 8) * (x.chg >= 0 ? 1 : -1);
    if (m.nw && m.nw.nPos && x.chg >= 0) ls += 4;
    return { ...m, ls };
  }).sort((a, b) => b.ls - a.ls).slice(0, 5);
  if (leaders.length) {
    const strong = leaders.filter(m => Math.abs(m.r) >= Math.max(0.5, Math.abs(x.chg) * 0.7));
    const tvTop = (strong.length ? strong : leaders).slice().sort((a, b) => (b.tv || 0) - (a.tv || 0))[0], rTop = leaders.slice().sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0], fTop = leaders.filter(m => m.fT != null).sort((a, b) => (x.chg >= 0 ? b.fT - a.fT : a.fT - b.fT))[0];
    leaders.forEach(m => {
      m.role = []; if (m === tvTop) m.role.push(x.chg >= 0 ? '대장주' : '하락 주도');
      if (m === rTop && m !== tvTop) m.role.push(x.chg >= 0 ? '탄력 1위' : '낙폭 1위');
      if (fTop && m === fTop && Math.abs(m.fT) >= 5) m.role.push(x.chg >= 0 ? '외국인 매수 1위' : '외국인 매도 1위');
      m.note = [`${sfP(m.r)}`, m.tv != null ? `거래대금 ${sfEok(m.tv)}${m.tvSh >= 0.05 ? `(업종의 ${fmt(m.tvSh * 100, 0)}%)` : ''}` : '', m.fT != null && Math.abs(m.fT) >= 3 ? `외국인 ${sfEok(m.fT)}` : '', m.tvf && m.tvf.name ? m.tvf.name : ''].filter(Boolean);
    });
  }
  Object.assign(x, { st, br, heat, tvSum, topShare, top, ret5, us, cl, news, fT, iT, f5, i5, tvfUp, tvfDn, nPos, nNeg, dIn, d60, why, read, sc, g, todo, leaders });
}
function sfJosa(w) { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '이' : '가'; }

/* ── 오늘 섹터 등락 기록 (이 기기 · 3분 간격) ── */
function sfSnapKey() { return 'sfSnap_' + sfToday(); }
function sfSnaps() { return store.get(sfSnapKey(), {}) || {}; }
function sfSnapSave(secs) {
  if (!sfOpen() || !secs.length) return;
  const o = sfSnaps(), ts = Object.keys(o).sort(), now = sfKst().toISOString().slice(11, 16);
  if (ts.length) { const l = ts[ts.length - 1], lm = +l.slice(0, 2) * 60 + +l.slice(3, 5); if (sfMin() - lm < 3) return; }
  o[now] = Object.fromEntries(secs.map(x => [x.key, x.chg]));
  const k = Object.keys(o).sort(); while (k.length > 130) delete o[k.shift()];
  try { store.set(sfSnapKey(), o); Object.keys(localStorage).filter(x => x.startsWith('scr_sfSnap_') && x !== 'scr_' + sfSnapKey()).forEach(x => localStorage.removeItem(x)); } catch (e) {}
}
function sfSpark(key) {
  const o = sfSnaps(), ts = Object.keys(o).sort(), v = ts.map(t => o[t][key]).filter(z => z != null);
  if (v.length < 3) return '';
  const W = 90, H = 24, mn = Math.min(0, ...v), mx = Math.max(0, ...v), sp = mx - mn || 1;
  const X = i => i / (v.length - 1) * W, Y = z => 2 + (mx - z) / sp * (H - 4);
  return `<svg viewBox="0 0 ${W} ${H}" class="sf-spark" aria-label="오늘 등락 흐름"><line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line)"/><polyline fill="none" stroke="${v[v.length - 1] >= 0 ? 'var(--up)' : 'var(--down)'}" stroke-width="1.6" points="${v.map((z, i) => `${X(i).toFixed(1)},${Y(z).toFixed(1)}`).join(' ')}"/></svg>`;
}

/* ── 시장 전체 한 줄 ── */
function sfSummary(secs) {
  const big = secs.filter(x => (x.n || x.mem.length) >= 4);
  const lead = big.filter(x => x.st === 'lead'), weak = big.filter(x => x.chg < 0).sort((p, q) => q.chg - p.chg);
  const upN = secs.filter(x => x.chg > 0).length, N = secs.length;
  const DEF = /은행|보험|통신|전기|가스|음식료|식품|담배|유틸|필수/, RISK = /반도체|2차|전지|소프트|인터넷|게임|바이오|제약|IT|전자|장비|기계|조선|방산|우주/;
  const avg = re => { const L = secs.filter(x => re.test(x.name)); return L.length ? L.reduce((a, x) => a + x.chg, 0) / L.length : null; };
  const d = avg(DEF), r = avg(RISK);
  let tone = '';
  if (d != null && r != null) tone = r - d >= 1 ? '성장·경기 민감 업종이 방어 업종보다 강해요 — 위험을 감수하는(위험 선호) 장이에요.' : d - r >= 1 ? '은행·통신·음식료 같은 방어 업종이 더 강해요 — 몸을 사리는(위험 회피) 장이에요.' : '성장 업종과 방어 업종 차이가 크지 않아요.';
  return `${N}개 업종 중 ${upN}개 상승(${fmt(upN / (N || 1) * 100, 0)}%). ${lead.length ? `주도: ${lead.slice(0, 4).map(x => `${x.name} ${sfP(x.chg)}`).join(', ')}. ` : '뚜렷한 주도 업종은 없어요. '}${weak.length ? `약한 쪽: ${weak.slice(-3).reverse().map(x => `${x.name} ${sfP(x.chg)}`).join(', ')}. ` : ''}${tone}`;
}

/* ── 화면 조각 ── */
function sfLeaderChips(x, n) {
  return x.leaders.slice(0, n).map(m => `<button class="sf-ld ${m.r > 0 ? 'up' : 'down'}" data-sfc="${esc(m.code)}"${m.s ? '' : ' data-ext="1"'}><b>${esc(m.name)}</b>${m.role && m.role.length ? `<em>${esc(m.role.join('·'))}</em>` : ''}<small>${esc(m.note.join(' · '))}</small></button>`).join('');
}
function sfCard(x) {
  const S0 = SF_ST[x.st], op = SF.open.has(x.key);
  return `<article class="sf-card sf-${x.st}${op ? ' open' : ''}" data-sfk="${esc(x.key)}">
    <header class="sf-h"><div><b class="sf-nm">${esc(x.name)}</b><span class="sf-st ${S0[1]}">${S0[0]}</span>${x.dIn != null && Math.abs(x.dIn) >= 0.5 ? `<span class="sf-mv ${x.dIn > 0 ? 'up' : 'down'}">${x.dIn > 0 ? '▲ 강해지는 중' : '▼ 약해지는 중'}</span>` : ''}</div>
      <div class="sf-px"><b class="${cls(x.chg)}">${sfP(x.chg)}</b>${sfSpark(x.key)}</div></header>
    <div class="sf-meta"><span class="sf-br"><i style="width:${x.br != null ? x.br : 50}%"></i></span><small>오른 ${x.up ?? '–'} · 내린 ${x.dn ?? '–'}${x.heat != null ? ` · 거래대금 ${fmt(x.heat, 1)}배` : ''}${x.tvSum ? ` · ${sfEok(x.tvSum)}` : ''} · ${x.rank}위</small></div>
    <ul class="sf-why">${x.why.slice(0, op ? 9 : 3).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="sf-read">${esc(x.read[0] || S0[2])}</p>
    <div class="sf-ev sg${x.g[0]}"><b>${x.g[0]}</b><span>${esc(x.g[1])} <small>${x.sc}점</small></span></div>
    ${x.leaders.length ? `<div class="sf-lds"><small class="sf-lt">${x.chg >= 0 ? '주도주' : '하락을 이끈 종목'}</small>${sfLeaderChips(x, op ? 5 : 3)}</div>` : `<p class="hint">${x.src === 'live' ? '구성 종목을 불러오는 중이에요.' : ''}</p>`}
    ${op ? `<div class="sf-more">${x.read.slice(1).map(t => `<p class="sf-read">${esc(t)}</p>`).join('')}<h5>대응</h5><ul class="sh-todo">${x.todo.map(t => `<li>${esc(t)}</li>`).join('')}</ul>${sfMemTable(x)}</div>` : ''}
    <button class="sf-tg" data-sfo="${esc(x.key)}">${op ? '접기 ▴' : '이유·대응·전체 종목 ▾'}</button>
  </article>`;
}
function sfMemTable(x) {
  const L = x.mem.filter(m => m.r != null).slice().sort((a, b) => (b.tv || 0) - (a.tv || 0)).slice(0, 30);
  if (!L.length) return '';
  return `<div class="table-wrap"><table class="tbl sf-tb"><thead><tr><th class="l">종목</th><th>현재가</th><th>등락</th><th>거래대금</th><th>업종 내 비중</th><th>외국인(오늘)</th><th class="l">거래대금 흐름</th></tr></thead><tbody>
    ${L.map(m => `<tr data-sfc="${esc(m.code)}"${m.s ? '' : ' data-ext="1"'}><td class="l"><b>${esc(m.name)}</b>${m.s ? '' : ' <small class="muted">분석 밖</small>'}</td><td class="mono">${m.p != null ? fmt(m.p) : '–'}</td><td class="mono ${cls(m.r)}">${sfP(m.r)}</td><td class="mono">${sfEok(m.tv)}</td><td class="mono">${fmt(m.tvSh * 100, 1)}%</td><td class="mono ${cls(m.fT)}">${m.fT != null ? sfEok(m.fT) : '–'}</td><td class="l">${m.tvf ? esc(m.tvf.name) : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderSecFlow() {
  const box = $('#sfBody'); if (!box || !S.data) return;
  const secs = sfBuild(); SF.last = secs;
  sfSnapSave(secs);
  const meta = $('#sfMeta');
  if (meta) meta.innerHTML = SF.net ? `${sfOpen() ? '<span class="gov-live"></span> ' : ''}네이버 업종 ${SF.net.list.length}개 · 구성 종목 실시간 ${esc(String(SF.net.at).slice(11, 16))} 기준${sfOpen() ? ' · 1분마다 갱신' : ''}` : `분석 대상 종목을 업종별로 묶어 계산(15분 시세)${typeof CLX !== 'undefined' && CLX.live ? ' · ' + esc(String(CLX.live.meta.time).slice(11)) + ' 기준' : ''} — 실시간 업종 연결 대기 중`;
  if (!secs.length) { box.innerHTML = '<div class="hint">업종 자료를 불러오는 중이에요.</div>'; return; }
  const F = SF.filter, groups = { all: () => true, lead: x => x.st === 'lead' || x.st === 'up', turn: x => x.st === 'rebound' || x.st === 'turn', weak: x => x.st === 'down' || x.st === 'weak' };
  let L = secs.filter(groups[F] || groups.all);
  const small = x => (x.n || x.mem.length) < 4 ? 1 : 0;   // 3종목 이하 업종은 뒤로
  const cmp = SF.sort === 'sc' ? (a, b) => b.sc - a.sc : SF.sort === 'tv' ? (a, b) => (b.tvSum || 0) - (a.tvSum || 0) : SF.sort === 'low' ? (a, b) => a.chg - b.chg : (a, b) => b.chg - a.chg;
  L = L.slice().sort((a, b) => small(a) - small(b) || cmp(a, b));
  const cnt = k => secs.filter(x => x.st === k).length;
  $('#sfSum').innerHTML = `<p class="md-one">${esc(sfSummary(secs))}</p>
    <div class="sf-stc">${Object.entries(SF_ST).map(([k, v]) => `<span class="sf-st ${v[1]}">${v[0]} ${cnt(k)}</span>`).join('')}</div>`;
  box.innerHTML = `<div class="row gap wrap sf-ctl">${[['all', '전체'], ['lead', '주도·상승'], ['turn', '반등·하향 전환'], ['weak', '하락·약세']].map(([k, n]) => `<button class="chip ${F === k ? 'on' : ''}" data-sff="${k}">${n}</button>`).join('')}
      <label class="small">정렬 <select id="sfSort">${[['chg', '오늘 등락 높은 순'], ['low', '오늘 등락 낮은 순'], ['sc', '평가 점수 순'], ['tv', '거래대금 많은 순']].map(([k, n]) => `<option value="${k}" ${SF.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
    <div class="sf-grid">${L.slice(0, 80).map(sfCard).join('')}</div>
    <details class="hint mt"><summary>판정 기준</summary><b>주도</b> 업종 +1.5%↑ · 오른 종목 60%↑ · 상위권 순위 또는 거래대금 평소 1.3배↑ · <b>상승</b> +0.5%↑ · <b>반등</b> 1주 −3%↓ 뒤 +0.7%↑ · <b>하향 전환</b> 1주 +3%↑ 뒤 −0.5%↓ · <b>약세 심화</b> −1.5%↓ · 내린 종목 65%↑ · 1주 −2%↓ · <b>하락</b> −0.5%↓ · 나머지 <b>혼조</b>. 평가 점수는 등락·오른 종목 비율·거래대금 배수·외국인·거래대금 흐름·뉴스·차트 판정·장중 강약을 합친 「내일까지 이어질 가능성」(0~100)이에요. 한 종목이 업종 상승의 60% 이상을 만들면 감점해요. 거래대금 배수·외국인·뉴스는 분석 대상 892종목 기준이에요.</details>`;
  $$('#sfBody [data-sff]').forEach(b => b.onclick = () => { SF.filter = b.dataset.sff; renderSecFlow(); });
  const so = $('#sfSort'); if (so) so.onchange = () => { SF.sort = so.value; renderSecFlow(); };
  $$('#sfBody [data-sfo]').forEach(b => b.onclick = () => { const k = b.dataset.sfo; SF.open.has(k) ? SF.open.delete(k) : SF.open.add(k); renderSecFlow(); });
  sfBindStocks('#sfBody');
}
function sfBindStocks(root) {
  $$(root + ' [data-sfc]').forEach(el => el.onclick = e => { e.stopPropagation(); const c = el.dataset.sfc; if (el.dataset.ext) { window.open('https://finance.naver.com/item/main.naver?code=' + c, '_blank', 'noopener'); return; } showAnalysis(c); });
}

/* ── 대시보드 요약 ── */
function renderSecDash() {
  const box = $('#sfDash'); if (!box || !S.data) return;
  const secs = SF.last && Date.now() - (SF.lastT || 0) < 60e3 ? SF.last : sfBuild(); SF.last = secs; SF.lastT = Date.now();
  if (!secs.length) { box.innerHTML = ''; return; }
  const big = secs.filter(x => (x.n || x.mem.length) >= 4), hi = big.slice(0, 3), lo = big.slice(-3).reverse();
  const row = x => `<div class="sf-dr"><div class="sf-dh"><b>${esc(x.name)}</b><span class="sf-st ${SF_ST[x.st][1]}">${SF_ST[x.st][0]}</span><b class="${cls(x.chg)}">${sfP(x.chg)}</b></div><p>${esc(x.why[1] || x.why[0] || '')}</p><div class="sf-lds">${sfLeaderChips(x, 2)}</div></div>`;
  box.innerHTML = `<div class="ph"><h2>오늘의 섹터 흐름</h2><button class="btn ghost small" id="sfGo">모든 섹터 보기 →</button></div>
    <p class="md-one">${esc(sfSummary(secs))}</p>
    <div class="sf-dg"><div><h4 class="good-t">가장 강한 섹터</h4>${hi.map(row).join('')}</div><div><h4 class="bad-t">가장 약한 섹터</h4>${lo.map(row).join('')}</div></div>`;
  const b = $('#sfGo'); if (b) b.onclick = () => { switchTab('secflow'); renderSecFlow(); };
  sfBindStocks('#sfDash');
}

async function sfLoop(force) {
  if (SF.busy || !S.data) return;
  const onTab = $('#tab-secflow') && $('#tab-secflow').classList.contains('on'), onDash = $('#tab-dash') && $('#tab-dash').classList.contains('on');
  if (!force && (document.hidden || (!onTab && !onDash))) { if (sfOpen()) { try { sfSnapSave(sfBuild()); } catch (e) {} } return; }
  SF.busy = true;
  try { await sfLoad(force); SF.lastT = 0; if (onTab) renderSecFlow(); if (onDash) renderSecDash(); } catch (e) { console.error(e); }
  SF.busy = false;
}
function initSecFlow() {
  sfLoop(true);
  setInterval(() => sfLoop(false), 30e3);
  const tb = $('button[data-tab="secflow"]'); if (tb) tb.addEventListener('click', () => { renderSecFlow(); sfLoop(true); });
}
(function waitBootSf() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initSecFlow();
  else setTimeout(waitBootSf, 800);
})();
