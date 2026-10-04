/* 거래량·거래대금 정밀 해석
   근거: 「거래량·거래대금 해석 관점 총정리」(2026.10.4) — 8개 관점 · 정규화 지표 4종 · 구현 규칙표
   설계 3원칙: ① 절대값 대신 배수·비율로 비교  ② 급증은 '매수 근거'가 아니라 '확인 도구'  ③ 하락 구간은 거래대금으로 본다
   데이터: 일봉 120일(종가·거래량, 다음 수집부터 시가·고가·저가) + 수급·현금흐름·공시 */
'use strict';

const VOL = { mkt: null, gen: null, all: null, charts: [] };
const vN = a => (a || []).map(x => (x == null || Number.isNaN(+x)) ? null : +x);
const vMean = a => { const b = a.filter(x => x != null && !Number.isNaN(x)); return b.length ? b.reduce((p, q) => p + q, 0) / b.length : null; };
const vPct = (a, p) => { const b = a.filter(x => x != null).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))] : null; };
const vAgo = d => d <= 0 ? '오늘' : d === 1 ? '어제' : `${d}거래일 전`;
const vX = (x, d = 1) => x == null ? '–' : fmt(x, d) + '배';
const vEok = x => x == null ? '–' : x >= 10000 ? fmt(x / 10000, 2) + '조원' : fmt(x, x >= 100 ? 0 : 1) + '억원';

/* ───── 시계열 준비 ───── */
function volSeries(s) {
  const c = vN(s.spark), v = vN(s.spark_vol), n = Math.min(c.length, v.length);
  if (n < 40) return null;
  const C = c.slice(-n), V = v.slice(-n);
  const has = !!(s.spark_o && s.spark_h && s.spark_l && s.spark_o.length >= n);
  const O = has ? vN(s.spark_o).slice(-n) : null, H = has ? vN(s.spark_h).slice(-n) : null, L = has ? vN(s.spark_l).slice(-n) : null;
  const TV = C.map((x, i) => x != null && V[i] != null ? x * V[i] / 1e8 : null);  // 거래대금(억) ≈ 종가×거래량
  const A20 = V.map((_, i) => i >= 10 ? vMean(V.slice(Math.max(0, i - 20), i)) : null);
  const RV = V.map((x, i) => A20[i] ? x / A20[i] : null);                       // 상대거래량
  const TA20 = TV.map((_, i) => i >= 10 ? vMean(TV.slice(Math.max(0, i - 20), i)) : null);
  const D = C.map((x, i) => i && C[i - 1] ? (x / C[i - 1] - 1) * 100 : null);     // 일간 등락률
  const OBV = [0];
  for (let i = 1; i < n; i++) OBV.push(OBV[i - 1] + (C[i] > C[i - 1] ? V[i] : C[i] < C[i - 1] ? -V[i] : 0));
  return { n, C, V, O, H, L, TV, A20, RV, TA20, D, OBV, has };
}

/* ───── 시장 전체 온도계 (관점 5) ───── */
function volMarket() {
  if (VOL.mkt && VOL.gen === S.data) return VOL.mkt;
  const st = S.data.stocks, N = 120, tot = Array(N).fill(0), cap = Array(N).fill(0);
  let cnt = 0;
  st.forEach(s => {
    const c = vN(s.spark), v = vN(s.spark_vol);
    if (c.length < N || v.length < N || !s.mcap) return;
    const last = c[c.length - 1]; if (!last) return;
    cnt++;
    for (let k = 0; k < N; k++) {
      const ci = c[c.length - N + k], vi = v[v.length - N + k];
      if (ci == null || vi == null) continue;
      tot[k] += ci * vi / 1e8; cap[k] += s.mcap * ci / last;
    }
  });
  const today = tot[N - 1], a20 = vMean(tot.slice(N - 21, N - 1)), a5 = vMean(tot.slice(N - 5));
  const turn = tot.map((t, k) => cap[k] ? t / cap[k] * 100 : null);
  const tvs = st.filter(s => s.tvalue > 0).sort((a, b) => b.tvalue - a.tvalue);
  const sum = tvs.reduce((p, s) => p + s.tvalue, 0);
  const ratio = a20 ? today / a20 : null, r5 = a20 ? a5 / a20 : null;
  const med = vPct(st.map(s => s.tvalue && s.mcap ? s.tvalue / s.mcap * 100 : null), 0.5);
  const temp = ratio == null ? '–' : ratio >= 1.3 ? '뜨거움' : ratio >= 0.9 ? '보통' : ratio >= 0.7 ? '식는 중' : '얼어붙음';
  const top1 = tvs[0] ? tvs[0].tvalue / sum : 0;
  VOL.mkt = { cnt, tot, turn, today, a20, ratio, r5, turnToday: turn[N - 1], turnA20: vMean(turn.slice(N - 21, N - 1)), sum, top1, top1s: tvs[0],
    top10: tvs.slice(0, 10).reduce((p, s) => p + s.tvalue, 0) / (sum || 1), med, temp,
    rank: Object.fromEntries(tvs.map((s, i) => [s.code, i + 1])),
    score: ratio == null ? 50 : Math.max(0, Math.min(100, Math.round(50 + (ratio - 1) * 70))) };
  VOL.gen = S.data;
  return VOL.mkt;
}

/* ───── 스윙 저점·고점 (직전 10일 창 기준 극값) ───── */
function vSwings(C, kind, w = 5) {
  const out = [], n = C.length;
  for (let i = w; i < n - 2; i++) {
    const win = C.slice(i - w, Math.min(n, i + w + 1)).filter(x => x != null);
    if (C[i] == null) continue;
    if (kind === 'low' ? C[i] === Math.min(...win) : C[i] === Math.max(...win)) {
      if (!out.length || i - out[out.length - 1] >= 5) out.push(i);
    }
  }
  return out;
}

/* ───── 종목 하나 정밀 해석 ───── */
function volAnalyze(s) {
  const z = volSeries(s); if (!z) return null;
  const M = volMarket();
  const { n, C, V, O, H, L, TV, A20, RV, TA20, D, OBV, has } = z, e = n - 1;
  const chk = [], ev = [], flags = {};
  const add = (p, k, stt, title, text, rule, pts) => chk.push({ p, k, st: stt, title, text, rule, pts: pts || 0 });
  const isBull = i => has && O[i] != null ? (C[i] > O[i] && H[i] > L[i] && (C[i] - O[i]) / (H[i] - L[i]) >= 0.6 && D[i] >= 3) : D[i] >= 4;
  const isBear = i => has && O[i] != null ? (C[i] < O[i] && H[i] > L[i] && (O[i] - C[i]) / (H[i] - L[i]) >= 0.6 && (O[i] - C[i]) / O[i] * 100 >= 3) : D[i] <= -4;
  const lo120 = Math.min(...C.filter(x => x != null)), hi120 = Math.max(...C.filter(x => x != null));
  const posAt = i => hi120 > lo120 ? (C[i] - lo120) / (hi120 - lo120) : 0.5;
  const rv = RV[e], tvToday = s.tvalue ?? TV[e];
  const tvMcap = s.tvalue && s.mcap ? s.tvalue / s.mcap * 100 : null;      // 시총 대비 일 거래대금(%) = 상장주식 회전율
  const turnRel = tvMcap != null && M.med ? tvMcap / M.med : null;
  const share = M.sum && s.tvalue ? s.tvalue / M.sum * 100 : null;
  const tv90 = vPct(TV, 0.9);

  /* ── 전제 · 정규화 4종 ── */
  const P0 = '전제 · 정규화';
  add(P0, 'rvol', rv == null ? 'na' : rv >= 10 ? 'bad' : rv >= 2 ? 'good' : rv >= 0.7 ? 'info' : 'warn', '상대거래량',
    rv == null ? '계산할 자료가 부족해요.' : `오늘 거래량은 최근 20일 평균의 <b>${vX(rv)}</b>예요. ${rv >= 10 ? '평소의 10배가 넘는 비정상적인 폭증 — 과열이나 이상 거래를 의심해야 해요.' : rv >= 3 ? '평소보다 3배 이상 — 강한 관심(강신호)이 몰렸어요.' : rv >= 2 ? '평소의 2배 이상 — 돌파가 진짜인지 확인해 줄 만큼의 거래예요.' : rv >= 0.7 ? '평소 수준이에요.' : '평소보다 한산해요 — 관심이 식은 상태예요.'}`,
    '당일 거래량 ÷ 직전 20일 평균 · 2배↑ 돌파 유효, 3배↑ 강신호, 10배↑ 과열·의심', 0);
  add(P0, 'turn', tvMcap == null ? 'na' : tvMcap >= 100 ? 'bad' : turnRel >= 5 ? 'warn' : turnRel >= 0.3 ? 'info' : 'warn', '회전율 (시총 대비 거래대금)',
    tvMcap == null ? '자료 없음' : `하루 거래대금이 회사 크기(시가총액)의 <b>${fmt(tvMcap, 2)}%</b> — 시장 중간값(${fmt(M.med, 2)}%)의 <b>${vX(turnRel)}</b>예요. ${turnRel >= 5 ? '주식이 평소보다 훨씬 빠르게 손바뀜되고 있어요(단타 과열 주의).' : turnRel >= 0.3 ? '보통 범위의 손바뀜이에요.' : '손바뀜이 매우 적어요 — 시장에서 소외된 종목일 수 있어요.'}`,
    '일 거래대금 ÷ 시가총액 (유통주식 자료가 없어 상장주식 기준) · 시장 평균 대비로 판정', 0);
  add(P0, 'share', share == null ? 'na' : 'info', '시장 집중도',
    share == null ? '자료 없음' : `분석 대상 ${M.cnt}종목 전체 거래대금 중 <b>${fmt(share, 2)}%</b>가 이 종목에 몰렸어요 (거래대금 순위 <b>${M.rank[s.code] || '–'}위</b>, 오늘 ${vEok(tvToday)}).`,
    '종목 거래대금 ÷ 시장 총 거래대금', 0);
  // 함정: 거래량 숫자는 큰데 실제 손바뀜은 적은 저가주 (에어부산 사례)
  const volRank = S.data.stocks.filter(x => (x.volume || 0) > (s.volume || 0)).length / S.data.stocks.length;
  if (volRank < 0.3 && turnRel != null && turnRel < 0.4 && (s.close || 0) < 10000) {
    add(P0, 'trap', 'warn', '함정 — 거래량만 큰 소외주', `거래 주식 수(${fmt(s.volume)}주)는 상위 30% 안에 들지만, 회사 크기 대비 실제 손바뀜은 시장 평균의 ${vX(turnRel)}에 그쳐요. 주가가 낮아서 숫자만 커 보이는 경우예요.`,
      '저가주(1만원 미만) · 거래량 상위 30% AND 회전율 < 시장 중간값의 0.4배', -4);
    flags.trap = true;
  }

  /* ── 관점 1 · 추세 확인 ── */
  const P1 = '관점 1 · 추세 확인';
  const pr20 = C[e - 20] ? (C[e] / C[e - 20] - 1) * 100 : null;
  const vt = vMean(V.slice(e - 9)) / (vMean(V.slice(e - 19, e - 9)) || 1);
  if (pr20 != null) {
    let stt, t, pts;
    if (pr20 >= 3 && vt >= 1.15) { stt = 'good'; pts = 10; t = '주가가 오르면서 거래량도 늘고 있어요 — 사는 힘이 강한 <b>건강한 상승</b>이에요.'; flags.healthy = true; }
    else if (pr20 >= 3 && vt <= 0.85) { stt = 'warn'; pts = -8; t = '주가는 올랐는데 거래량은 줄고 있어요 — 사려는 힘이 <b>소진</b>되는 중일 수 있어요(추세 반전 의심).'; flags.fade = true; }
    else if (pr20 <= -3 && vt >= 1.15) { stt = 'bad'; pts = -8; t = '주가가 내리면서 거래량이 늘고 있어요 — 파는 힘이 강해지는 중이에요.'; }
    else if (pr20 <= -3 && vt <= 0.85) { stt = 'info'; pts = 2; t = '주가가 내리지만 거래량은 줄고 있어요 — 파는 물량이 말라가는 중일 수 있어요.'; }
    else { stt = 'info'; pts = 0; t = '주가·거래량 모두 뚜렷한 방향이 없어요.'; }
    add(P1, 'trend', stt, '가격과 거래량의 방향', `최근 20일 주가 ${pct(pr20, 1)}, 최근 10일 거래량은 그 전 10일의 ${vX(vt, 2)}. ${t}`, '상승+거래량 증가 = 건강 / 상승+감소 = 소진', pts);
  }
  // 돌파 판정 (60일 종가 최고 돌파)
  const prevHi60 = Math.max(...C.slice(Math.max(0, e - 60), e).filter(x => x != null));
  const brkIdx = [];
  for (let i = Math.max(1, e - 4); i <= e; i++) { const ph = Math.max(...C.slice(Math.max(0, i - 60), i).filter(x => x != null)); if (C[i] > ph) brkIdx.push(i); }
  if (brkIdx.length) {
    const i = brkIdx[brkIdx.length - 1], ok = RV[i] >= 2 && isBull(i), strong = RV[i] >= 2.5 && isBull(i);
    add(P1, 'brk', ok ? 'good' : 'warn', '박스권·고점 돌파의 진위',
      `${vAgo(e - i)} 최근 3개월 최고가를 넘었어요. 그날 거래량은 평소의 <b>${vX(RV[i])}</b>${has ? '' : `, 등락률 ${pct(D[i], 1)}`}. ${ok ? (strong ? '대량 거래 + 장대양봉을 동반한 <b>강한 진짜 돌파</b>예요.' : '대량 거래를 동반한 <b>유효한 돌파</b>예요.') : '거래량이 부족하거나 양봉이 약해 <b>속임수 돌파</b>일 수 있어요. 대량 거래가 다시 붙는지 확인하세요.'}`,
      '돌파일 상대거래량 ≥ 2~2.5배 AND 장대양봉 → 유효 돌파', ok ? (strong ? 14 : 10) : -4);
    ev.push({ i, t: ok ? '유효 돌파' : '약한 돌파', k: ok ? 'good' : 'warn' });
    flags.brk = ok;
  } else if (C[e] >= prevHi60 * 0.97) {
    add(P1, 'brk', 'info', '돌파 대기', `최근 3개월 최고가(${fmt(prevHi60)}원)의 3% 안까지 왔어요. 넘을 때 거래량이 평소의 2배 이상 붙는지 지켜보세요.`, '돌파 시 상대거래량 ≥ 2배 필요', 0);
  }
  // 전고점 거래대금 비교
  const hiWin = C.slice(0, Math.max(1, e - 10));
  if (hiWin.length > 20) {
    const ph = hiWin.indexOf(Math.max(...hiWin.filter(x => x != null)));
    const near = C[e] >= C[ph] * 0.97;
    if (near && ph < e - 10) {
      const hiTv = Math.max(...TV.slice(Math.max(0, ph - 2), ph + 3).filter(x => x != null));
      const nowTv = Math.max(...TV.slice(e - 2).filter(x => x != null));
      const ok = nowTv >= hiTv;
      add(P1, 'prevhi', ok ? 'good' : 'warn', '전고점 거래대금과 비교',
        `${vAgo(e - ph)} 만든 고점 근처예요. 그때 거래대금 최대 ${vEok(hiTv)} vs 최근 3일 최대 ${vEok(nowTv)} → ${ok ? '<b>그때 이상의 돈이 들어와</b> 고점 돌파 힘이 충분해요.' : '<b>그때보다 돈이 덜 들어와서</b> 고점을 넘기 힘들 수 있어요.'}`,
        '전고점 구간 거래대금 이상이 다시 나와야 돌파 가능', ok ? 6 : -5);
      ev.push({ i: ph, t: '전고점', k: 'info' });
    }
  }
  // 바닥권 거래량 폭증
  for (let j = e; j >= e - 9 && j > 30; j--) {
    const quiet = vMean(V.slice(j - 10, j)) <= vPct(V.slice(0, j), 0.3);
    if (RV[j] >= 3 && posAt(j) < 0.3 && quiet && D[j] >= 2 && V[j] >= Math.max(...V.slice(Math.max(0, j - 60), j).filter(x => x != null))) {
      add(P1, 'bottom', 'good', '바닥권 거래량 폭증', `${vAgo(e - j)} 거래가 말라 있던 바닥권에서 거래량이 평소의 <b>${vX(RV[j])}</b>로 터졌어요(주가 ${pct(D[j], 1)}) — <b>매수세가 다시 나타난 신호</b>예요.`,
        '거래량 최저 구간 이후 평균의 3배 이상 + 60일 최대 거래량 + 양봉 (바닥권 하위 30%)', 8);
      ev.push({ i: j, t: '바닥 폭증', k: 'good' }); flags.bottom = true; break;
    }
  }
  // 정찰병 패턴 (본격 상승 전 소규모 폭증)
  if (!brkIdx.length) {
    const box = C.slice(e - 30), bh = Math.max(...box), bl = Math.min(...box);
    const spikes = []; for (let j = e - 29; j <= e; j++) if (RV[j] >= 3 && Math.abs(D[j]) < 6) spikes.push(j);
    if (bh / bl - 1 < 0.25 && spikes.length >= 1 && spikes.length <= 3 && C[e] < bh) {
      add(P1, 'scout', 'info', '정찰병 패턴 (간보기)', `최근 30일 좁은 범위(폭 ${fmt((bh / bl - 1) * 100, 0)}%)에서 주가는 크게 안 움직였는데 거래량만 ${spikes.length}번 튀었어요(${spikes.map(j => vAgo(e - j)).join(', ')}). 큰손이 반응을 떠보는 단계일 수 있어요 — <b>상승 시작 전조</b>로 보는 시각이 있어요.`,
        '박스권 안에서 상대거래량 3배↑ 하루~사흘 (돌파 전)', 4);
      spikes.forEach(j => ev.push({ i: j, t: '정찰병', k: 'info' })); flags.scout = true;
    }
  }

  /* ── 관점 2 · 거래대금의 질 ── */
  const P2 = '관점 2 · 거래대금의 질';
  const pk = (() => { let b = e - 30, m = -1; for (let i = Math.max(0, e - 30); i <= e; i++) if (C[i] != null && C[i] > m) { m = C[i]; b = i; } return b; })();
  if (C[e] < C[pk] * 0.95 && pk < e - 2 && pk > 20) {
    const upTv = vMean(TV.slice(pk - 20, pk + 1).filter((_, k) => D[pk - 20 + k] > 0));
    const dnTv = vMean(TV.slice(pk + 1).filter((_, k) => D[pk + 1 + k] < 0));
    if (upTv && dnTv) {
      const r = dnTv / upTv;
      const stt = r >= 1 ? 'bad' : r >= 0.5 ? 'info' : (C[e] >= C[pk] * 0.8 ? 'good' : 'info');
      add(P2, 'hold', stt, '하락할 때 거래대금 유지율',
        `${vAgo(e - pk)} 고점 뒤 ${pct((C[e] / C[pk] - 1) * 100, 1)} 내려온 중이에요. 내린 날 평균 거래대금(${vEok(dnTv)})이 오를 때(${vEok(upTv)})의 <b>${fmt(r * 100, 0)}%</b> — ${r >= 1 ? '<b>높은 가격에서 큰돈이 계속 빠져나가는 중</b>이라 반등 없이 하락 추세로 바뀔 위험이 커요.' : r >= 0.5 ? '파는 돈이 어느 정도 남아 있어요. 더 줄어드는지 지켜보세요.' : '<b>파는 돈이 말라가는 건강한 쉬어가기(눌림)</b>예요.'}`,
        '하락일 거래대금 ÷ 직전 상승 구간 평균 거래대금 — 100%↑ 추세 전환 경고, 50%↓ 건강한 눌림', r >= 1 ? -12 : r >= 0.5 ? -2 : (stt === 'good' ? 8 : 0));
      flags.holdTv = r >= 1; flags.healthyPull = stt === 'good';
    }
  }
  // 장대음봉 + 대량 거래대금 (큰손 이탈)
  for (let j = e; j >= e - 9; j--) {
    if (isBear(j) && TV[j] >= tv90) {
      add(P2, 'whale', 'bad', '장대음봉 + 대량 거래대금', `${vAgo(e - j)} 크게 내린 음봉(${pct(D[j], 1)})에 거래대금이 최근 6개월 상위 10%(${vEok(TV[j])})였어요 — <b>큰손이 빠져나갔을 가능성이 높은 최우선 경고</b>예요.`,
        '음봉 몸통 상위 + 거래대금 상위 10% 동시 충족', -15);
      ev.push({ i: j, t: '큰손 이탈?', k: 'bad' }); flags.whale = true; break;
    }
  }
  // 주가 제자리 + 거래량 폭증
  for (let j = e; j >= e - 4; j--) {
    if (RV[j] >= 5 && Math.abs(D[j] ?? 9) < 1) {
      const high = posAt(j) >= 0.8;
      add(P2, 'flat', 'bad', '주가는 제자리인데 거래량만 폭증', `${vAgo(e - j)} 주가는 ${pct(D[j], 1)}로 거의 그대로인데 거래량은 평소의 <b>${vX(RV[j])}</b>였어요 — 누군가 대량으로 던지고 누군가 받아낸 날이에요.${high ? ' <b>고점 근처라 세력 이탈로 해석되며, 이후 급락이 잦은 모양</b>이에요.' : ''}`,
        '등락률 < 1% AND 상대거래량 ≥ 5배', high ? -18 : -10);
      ev.push({ i: j, t: '제자리 폭증', k: 'bad' }); flags.flat = true; break;
    }
  }

  /* ── 관점 3 · 이상징후 5대 경보 ── */
  const P3 = '관점 3 · 이상징후 경보';
  const rvMax5 = Math.max(...RV.slice(e - 4).filter(x => x != null));
  if (s.ocf != null && s.ocf < 0 && rvMax5 >= 3) {
    add(P3, 'burn', 'bad', '① 돈 못 버는 회사에 과도한 거래', `영업으로 현금이 빠져나가는 회사(영업현금흐름 ${fmt(s.ocf, 0)}억)인데 최근 5일 거래량이 평소의 ${vX(rvMax5)}까지 터졌어요 — <b>설거지(고점 떠넘기기) 의심</b> 경보예요.`,
      '영업활동현금흐름 < 0 AND 상대거래량 급증(3배↑)', -12);
    flags.burn = true;
  }
  const cbDisc = (s.disclosures || []).filter(d => /전환사채|신주인수권|교환사채|CB|BW|유상증자|추가상장/.test(d.title));
  for (let j = e; j >= e - 9; j--) {
    if (RV[j] >= 10 && posAt(j) < 0.35) {
      add(P3, 'cb', cbDisc.length ? 'bad' : 'warn', '② 바닥권 이유 없는 10배+ 폭증', `${vAgo(e - j)} 바닥권에서 거래량이 평소의 <b>${vX(RV[j])}</b>로 폭증했어요. 매집일 수도 있지만 전환사채(CB)·신주인수권(BW) 물량이 풀리기 직전의 정리일 수도 있어요. ${cbDisc.length ? `최근 공시에 <b>${esc(cbDisc[0].title)}</b>가 있어 주의가 필요해요.` : 'DART에서 CB·BW 상장 일정을 꼭 확인하세요.'}`,
        '저가 구간 상대거래량 10배↑ → CB/BW 일정 교차 확인', cbDisc.length ? -10 : -5);
      ev.push({ i: j, t: '10배 폭증', k: 'bad' }); flags.cb = true; break;
    }
  }
  if (flags.flat) add(P3, 'flat3', 'bad', '③ 주가 제자리 + 거래량 대거 발생', '위 「거래대금의 질」에서 잡힌 경보와 같은 내용이에요 — 세력 이탈 가능성.', '등락률 < 1% AND 상대거래량 ≥ 5배', 0);
  if (tvMcap != null && tvMcap >= 100) {
    add(P3, 'extreme', 'bad', '④ 시가총액보다 큰 하루 거래대금', `오늘 거래대금이 회사 크기의 <b>${fmt(tvMcap, 0)}%</b> — 하루에 주인이 한 번 이상 통째로 바뀐 극단적 단타 과열('폭탄 돌리기' 정점)이에요. <b>매수 금지</b> 필터에 걸려요.`,
      '일 거래대금 ÷ 시가총액 ≥ 1.0 → 매수 금지', -25);
    flags.extreme = true;
  }
  // ⑤ 공시와 거래량의 시간차
  const asof = S.data.meta && S.data.meta.asof ? new Date(S.data.meta.asof) : new Date();
  const bdays = (d1, d2) => { let k = 0; const d = new Date(d1); while (d < d2) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) k++; } return k; };
  for (const d of (s.disclosures || [])) {
    if (!/^\d{8}$/.test(d.date || '')) continue;
    const dd = new Date(`${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`);
    const k = e - bdays(dd, asof);
    if (k < 30 || k > e) continue;
    const pre = vMean(V.slice(k - 5, k)), base = vMean(V.slice(k - 25, k - 5));
    const prePx = C[k - 5] ? (C[k - 1] / C[k - 5] - 1) * 100 : 0;
    if (pre && base && pre / base >= 1.5 && ((d.tag === '호재' && prePx > 0) || (d.tag === '악재' && prePx < 0))) {
      add(P3, 'lead', 'warn', '⑤ 공시 전에 거래량이 먼저 늘었음', `${esc(d.title)}(${d.date.slice(4, 6)}/${d.date.slice(6)}) 공시 전 5일 거래량이 그 전 평소의 <b>${vX(pre / base)}</b>였고 주가도 ${pct(prePx, 1)} 움직였어요 — <b>정보가 미리 새어 나간(선취매) 흔적</b>일 수 있어요. 공시 뒤엔 재료 소멸로 오히려 빠지는 경우가 많아요.`,
        '공시 전 5일 거래량 ÷ 그 전 20일 ≥ 1.5배 + 같은 방향 주가', -5);
      ev.push({ i: k, t: '공시', k: 'warn' }); flags.lead = true; break;
    }
  }
  if (!chk.some(c => c.p === P3)) add(P3, 'none', 'good', '이상징후 없음', '5대 이상징후(적자 기업 대금 폭증 · 바닥 10배 폭증 · 제자리 폭증 · 시총 초과 대금 · 공시 선행 거래)에 하나도 걸리지 않았어요.', '5대 경보 규칙 모두 통과', 4);

  /* ── 관점 4 · 세력 수급 결합 ── */
  const P4 = '관점 4 · 수급 결합';
  const fs = s.foreign_streak, is = s.inst_streak, flowOk = fs != null || is != null;
  if (!flowOk) add(P4, 'flow', 'na', '누가 샀나 (외국인·기관)', '외국인·기관 매매 자료가 아직 없어요(거래소 수집 대기 중). 다음 수집 후 자동으로 판정돼요.', '대금 급증 AND 기관+외인 순매수 = 진성 상승', 0);
  else {
    const big = (fs || 0) > 0 || (is || 0) > 0, both = (fs || 0) > 0 && (is || 0) > 0, sell = (fs || 0) < 0 && (is || 0) < 0;
    const who = `외국인 ${fs > 0 ? fs + '일 연속 매수' : fs < 0 ? -fs + '일 연속 매도' : '보합'} · 기관 ${is > 0 ? is + '일 연속 매수' : is < 0 ? -is + '일 연속 매도' : '보합'}`;
    if (rv >= 2 && D[e] > 0) {
      add(P4, 'flow', big ? 'good' : 'warn', big ? '진성 상승 (큰손이 산 거래 급증)' : '개인 주도 급증', `오늘 거래량 ${vX(rv)} + 주가 상승. ${who}. ${big ? (both ? '<b>외국인·기관이 함께 산 진짜 상승</b>이에요.' : '<b>큰손이 사들인 거래 급증</b>이에요.') : '큰손은 팔고 <b>개인만 산 급증</b>이라 믿음이 낮아요(국내 연구상 개인 순매수 종목은 이후 수익률이 낮은 경향).'}`,
        '상대거래량 ≥ 2배 AND (기관+외인) 당일 순매수', big ? (both ? 12 : 8) : -6);
      flags.trueUp = big;
    } else add(P4, 'flow', sell ? 'warn' : big ? 'good' : 'info', '누가 사고 파나', `${who}. ${sell ? '큰손이 함께 파는 중이에요.' : big ? '큰손이 사는 쪽이에요.' : '뚜렷한 방향이 없어요.'} (오늘은 거래 급증일이 아니라 진성 상승 판정 대상은 아니에요)`, '대금 급증일에 기관·외인 순매수 동반 여부', sell ? -4 : big ? 3 : 0);
  }

  /* ── 관점 5 · 장세 ── */
  const P5 = '관점 5 · 장세 온도';
  add(P5, 'mkt', M.ratio >= 1.3 ? 'good' : M.ratio >= 0.9 ? 'info' : 'warn', `시장 온도: ${M.temp}`,
    `분석 대상 전체 거래대금이 20일 평균의 <b>${vX(M.ratio, 2)}</b>(최근 5일 ${vX(M.r5, 2)}), 시장 회전율 ${fmt(M.turnToday, 2)}%(20일 평균 ${fmt(M.turnA20, 2)}%). 거래대금 1위 ${esc(M.top1s ? M.top1s.name : '')} 비중 ${fmt(M.top1 * 100, 1)}%${M.top1 >= 0.3 ? ' — <b>한 종목에 돈이 쏠린 국면</b>이라 나머지 종목엔 돈이 덜 돌아요.' : ', 상위 10종목 ' + fmt(M.top10 * 100, 0) + '%.'}`,
    '시장 총 거래대금 ÷ 20일 평균 · 1위 종목 비중 30%↑ = 자금 쏠림 국면', M.ratio >= 1.3 ? 3 : M.ratio < 0.8 ? -3 : 0);

  /* ── 관점 6 · OBV·자금흐름 다이버전스 ── */
  const P6 = '관점 6 · OBV 다이버전스';
  const lows = vSwings(C, 'low'), highs = vSwings(C, 'high');
  let div = null;
  if (lows.length >= 2) { const [a, b] = lows.slice(-2); if (b >= e - 25 && C[b] < C[a] * 0.98 && OBV[b] - OBV[a] > (A20[b] || 0) * 0.5) div = { k: 'bull', a, b }; }
  if (!div && highs.length >= 2) { const [a, b] = highs.slice(-2); if (b >= e - 25 && C[b] > C[a] * 1.02 && OBV[a] - OBV[b] > (A20[b] || 0) * 0.5) div = { k: 'bear', a, b }; }
  if (div) {
    const bull = div.k === 'bull';
    add(P6, 'obv', bull ? 'good' : 'bad', bull ? '상승 다이버전스 (매수 신호)' : '하락 다이버전스 (매도 신호)',
      bull ? `주가 저점은 ${vAgo(e - div.a)} ${fmt(C[div.a])}원 → ${vAgo(e - div.b)} ${fmt(C[div.b])}원으로 <b>낮아졌는데</b>, OBV(거래량 누적) 저점은 <b>높아졌어요</b> — 아래에서 사는 힘이 쌓이는 중, <b>하락 추세 마무리</b> 신호예요.`
        : `주가 고점은 ${fmt(C[div.a])}원 → ${fmt(C[div.b])}원으로 <b>높아졌는데</b>, OBV 고점은 <b>낮아졌어요</b> — 오르는 힘이 소진되는 중, <b>반전</b>을 암시해요.`,
      '스윙 저점·고점(10일 창) 비교 — 주가와 OBV 방향이 엇갈림', bull ? 10 : -10);
    ev.push({ i: div.a, t: 'OBV 비교점', k: 'info' }, { i: div.b, t: bull ? '상승 다이버전스' : '하락 다이버전스', k: bull ? 'good' : 'bad' });
    flags.obvBull = bull; flags.obvBear = !bull;
  } else {
    const oHi = Math.max(...OBV), pHi = Math.max(...C.filter(x => x != null));
    if (OBV[e] >= oHi && C[e] < pHi * 0.93) {
      add(P6, 'obv', 'good', 'OBV가 주가보다 먼저 신고점', '거래량 누적(OBV)은 최근 6개월 최고인데 주가는 아직 고점 아래예요 — <b>거래량이 주가를 앞서가는</b> 매수 압력 축적 모양이에요.', 'OBV 6개월 신고점 & 주가는 6개월 고점 −7% 아래', 6);
      flags.obvLead = true;
    } else add(P6, 'obv', 'info', '다이버전스 없음', '최근 주가와 OBV(거래량 누적)가 같은 방향으로 움직이고 있어요.', '스윙 저점·고점 비교', 0);
  }
  if (has) {
    let num = 0, den = 0;
    for (let i = e - 19; i <= e; i++) { if (H[i] > L[i] && V[i]) { num += ((C[i] - L[i]) - (H[i] - C[i])) / (H[i] - L[i]) * V[i]; den += V[i]; } }
    const cmf = den ? num / den : null;
    if (cmf != null) add(P6, 'cmf', cmf >= 0.05 ? 'good' : cmf <= -0.05 ? 'warn' : 'info', `자금흐름(CMF) ${fmt(cmf, 2)}`,
      cmf >= 0.05 ? '최근 20일 동안 대체로 <b>그날 높은 가격 쪽에서 마감</b> — 돈이 들어오는(매집) 흐름이에요.' : cmf <= -0.05 ? '최근 20일 동안 대체로 <b>낮은 가격 쪽에서 마감</b> — 돈이 빠지는(분산) 흐름이에요.' : '들어오는 돈과 나가는 돈이 비슷해요.',
      'Chaikin Money Flow(20일) — +0.05↑ 매집, −0.05↓ 분산', cmf >= 0.05 ? 4 : cmf <= -0.05 ? -4 : 0);
  }

  /* ── 관점 7 · 학술(한국 시장 특수성): 추격 경고 ── */
  const P7 = '관점 7 · 한국 시장 특수성';
  if (rv >= 3 && D[e] >= 8) {
    add(P7, 'chase', 'warn', '급증 직후 추격 매수 주의', `오늘 거래량 ${vX(rv)} + 주가 ${pct(D[e], 1)}. 한국 증시 연구에서는 '거래량이 많으니 오른다'는 프리미엄이 확인되지 않았고, 소형주에서는 오히려 이후 수익률이 낮아지는 경우가 보고돼요. <b>급증 당일 추격보다 눌림 확인 후</b>가 안전해요.`,
      '거래량 급증은 매수 근거가 아니라 확인 도구', -5);
    flags.chase = true;
  }

  /* ── 점수·결론 ── */
  const raw = 50 + chk.reduce((p, c) => p + c.pts, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const bads = chk.filter(c => c.st === 'bad'), goods = chk.filter(c => c.st === 'good' && c.pts > 0);
  const verdict = flags.extreme ? { t: '매수 금지 (극단 과열)', c: 'bad' } : score >= 68 ? { t: '거래가 상승을 받쳐 줘요', c: 'good' } : score >= 55 ? { t: '거래 흐름 양호', c: 'good' } : score >= 42 ? { t: '중립 — 확인 필요', c: 'mid' } : score >= 30 ? { t: '거래 흐름에 경고', c: 'bad' } : { t: '위험 신호 다수', c: 'bad' };
  const horizon = {
    short: flags.extreme ? '하지 마세요 — 시총 초과 거래대금(폭탄 돌리기).' : flags.chase ? '급증 당일 추격은 피하고 다음 날 눌림을 기다리세요.' : flags.brk ? `유효 돌파 — 돌파일 저가(${fmt(Math.min(C[e], C[e - 1]))}원 근처) 이탈 시 정리 기준.` : rv >= 2 ? '거래가 붙었어요 — 방향(양봉/음봉)을 확인하세요.' : '거래가 평소 수준이라 단타 재료는 약해요.',
    swing: flags.whale || flags.holdTv || flags.obvBear ? '큰돈이 빠지는 신호가 있어 보수적으로 보세요.' : flags.obvBull || flags.healthyPull || flags.trueUp || flags.bottom ? '매집·건전한 눌림 신호가 있어 1~4주 관점에서 유리해요.' : '뚜렷한 매집·분산 신호가 없어요.',
    long: flags.burn ? '돈 못 버는 회사에 거래만 몰려요 — 장기 보유 근거로 약해요.' : (turnRel != null && turnRel < 0.3) ? '거래가 너무 적어 사고팔기 어려울 수 있어요(유동성 부족).' : (s.ocf != null && s.ocf > 0) ? '현금을 버는 회사 + 정상 범위의 거래 — 거래 측면 문제 없음.' : '거래 측면 큰 문제 없음 — 실적·재무로 판단하세요.',
  };
  const plan = volPlan(s, z, { flags, score, prevHi60, tv90, brkIdx, lows, rv });
  return { z, M, chk, ev, flags, score, verdict, bads, goods, rv, tvToday, tvMcap, turnRel, share, horizon, plan };
}

/* ───── 실전 행동 가이드: 다음 거래일에 무엇을 보고, 어디서 사고, 어디서 끊을지 숫자로 ───── */
function volPlan(s, z, x) {
  const { C, V, L, A20, TV, has } = z, e = z.n - 1, f = x.flags;
  const avgV = A20[e] || vMean(V.slice(e - 20, e)), px = C[e];
  const need2 = Math.round(avgV * 2), need3 = Math.round(avgV * 3);
  const won = v => fmt(Math.round(v)) + '원';
  const sh = v => v >= 1e6 ? fmt(v / 1e4, 0) + '만 주' : fmt(v) + '주';
  const swingLow = (() => { const l = x.lows.filter(i => i >= e - 40 && i < e); return l.length ? C[l[l.length - 1]] : Math.min(...C.slice(e - 20, e)); })();
  const bi = x.brkIdx.length ? x.brkIdx[x.brkIdx.length - 1] : null;
  const brkLow = bi != null ? (has && L[bi] ? L[bi] : C[bi - 1]) : null;
  const stop = Math.round((f.brk && brkLow ? brkLow : swingLow) * 0.98);
  const stopPct = (stop / px - 1) * 100;
  let act, cls;
  if (f.extreme) { act = '매수 금지 — 시가총액보다 큰 거래대금(폭탄 돌리기). 보유 중이면 정리 우선.'; cls = 'bad'; }
  else if (f.whale || f.flat || f.holdTv || f.obvBear || f.burn) { act = '신규 매수 보류 · 보유자는 비중 줄이기 — 큰돈이 빠져나가는 신호가 있어요.'; cls = 'bad'; }
  else if (f.brk && !f.chase) { act = `매수 검토 — 거래량을 동반한 진짜 돌파. 손절 ${won(stop)}(${pct(stopPct, 1)}) 이탈 시 정리.`; cls = 'good'; }
  else if (f.brk && f.chase) { act = '돌파는 유효하지만 오늘 급등 — 추격 대신 다음 1~3일 눌림(거래 감소하며 쉬기)에서 분할 매수.'; cls = 'mid'; }
  else if (f.healthyPull || f.obvBull || f.obvLead || f.bottom || f.trueUp) { act = '관심 종목 등록 — 매집·건전한 눌림 신호. 아래 "매수 신호 조건"이 켜질 때 분할 매수.'; cls = 'mid'; }
  else { act = '관망 — 거래량이 아직 방향을 확인해 주지 않아요.'; cls = 'low'; }
  const todo = [];
  if (px < x.prevHi60) todo.push({ k: '매수 신호 조건', t: `종가가 <b>${won(x.prevHi60)}를 넘어서</b> 마감(3개월 최고가 돌파) + 거래량 <b>${sh(need2)} 이상</b>(평소 2배, 강하면 ${sh(need3)}) + 양봉 마감` });
  else todo.push({ k: '돌파 유지 확인', t: `내일부터 종가가 <b>${won(x.prevHi60)}</b> 위에서 버티는지 — 다시 아래로 내려오면 속임수 돌파` });
  todo.push({ k: '손절(정리) 기준', t: `<b>${won(stop)}</b> (${pct(stopPct, 1)}) — ${f.brk && brkLow ? '돌파한 날의 저가' : '최근 바닥(스윙 저점)'}보다 2% 아래. 특히 거래량이 늘면서 깨지면 바로 정리` });
  todo.push({ k: '큰손 이탈 경보선', t: `하루 거래대금 <b>${vEok(x.tv90)} 이상</b>(6개월 상위 10%)이면서 −4% 이상 큰 음봉이 나오면 경고` });
  todo.push({ k: '건강한 눌림 조건', t: `내리는 날 거래량이 <b>${sh(Math.round(avgV * 0.6))} 아래</b>(평소의 60%)로 줄면 파는 물량이 마르는 중 — 분할 매수 자리` });
  if (f.chase) todo.push({ k: '추격 금지', t: '오늘처럼 거래량 3배↑·주가 +8%↑ 날은 다음 날 시가 추격을 피하세요' });
  if (s.foreign_streak == null && s.inst_streak == null) todo.push({ k: '수급 확인', t: '외국인·기관 자료 수집 후 "진성 상승" 판정이 추가돼요' });
  else todo.push({ k: '수급 확인', t: '거래 급증일에 외국인·기관이 함께 사는지 — 개인만 사면 신뢰도 낮음' });
  return { act, cls, todo, stop, stopPct, need2, need3, avgV };
}

/* ───── 화면: 종목 분석 카드 ───── */
function volCardHtml(s, a) {
  if (!a) return '<div class="hint">거래량 자료가 부족해 해석할 수 없어요.</div>';
  const stIcon = { good: '●', warn: '●', bad: '●', info: '○', na: '–' };
  const groups = [];
  a.chk.forEach(c => { let g = groups.find(x => x.p === c.p); if (!g) groups.push(g = { p: c.p, items: [] }); g.items.push(c); });
  const tiles = [
    ['상대거래량', vX(a.rv), s._vlive && s._vlive.intr ? `장중 ${esc((s._vlive.time || '').slice(11))} 하루 환산 (실제 ${fmt(s._vlive.raw)}주)` : '20일 평균 대비'],
    [s._vlive && s._vlive.intr ? '지금까지 거래대금' : '오늘 거래대금', vEok(a.tvToday), `시장 ${a.M.rank[s.code] || '–'}위`],
    ['회전율', a.tvMcap != null ? fmt(a.tvMcap, 2) + '%' : '–', `시장 중간값의 ${vX(a.turnRel)}`],
    ['시장 비중', a.share != null ? fmt(a.share, 2) + '%' : '–', '전체 거래대금 중'],
    ['시장 온도', a.M.temp, `20일 평균의 ${vX(a.M.ratio, 2)}`],
  ];
  return `
  <div class="va-top">
    <div class="va-score ${a.verdict.c}"><small>거래 에너지·질 점수</small><b>${a.score}</b><span>${a.verdict.t}</span>
      <em>좋은 신호 ${a.goods.length} · 경고 ${a.bads.length}</em></div>
    <div class="va-tiles">${tiles.map(t => `<div><small>${t[0]}</small><b>${t[1]}</b><span class="hint">${t[2]}</span></div>`).join('')}</div>
  </div>
  <div class="va-plan ${a.plan.cls}"><small>실전 행동 가이드</small><b>${a.plan.act}</b>
    <div class="va-todo">${a.plan.todo.map(t => `<div><span>${t.k}</span><p>${t.t}</p></div>`).join('')}</div>
    <div class="hint">평소 하루 거래량 ${fmt(Math.round(a.plan.avgV))}주(20일 평균) 기준 · 장중에는 같은 시각 누적 거래량으로 비교하세요(예: 오전 10시 거래량 vs 평소 오전 10시까지)</div></div>
  <div class="row gap wrap cl-rng"><span class="lbl">기간</span>${[[60, '3개월'], [120, '6개월']].map(([d, t]) => `<button class="chip ${d === 120 ? 'on' : ''}" data-vrng="${d}">${t}</button>`).join('')}
    <span class="hint">막대 = 하루 거래대금(빨강 오른 날·파랑 내린 날) · 점선 = 20일 평균 · 보라선 = OBV(거래량 누적) · ▲ = 신호가 난 날</span></div>
  <div class="cl-box" style="height:230px"><canvas id="vaChart"></canvas></div>
  <div class="va-hz">
    <div><small>단타 (1~3일)</small><p>${a.horizon.short}</p></div>
    <div><small>스윙 (1~4주)</small><p>${a.horizon.swing}</p></div>
    <div><small>중장기</small><p>${a.horizon.long}</p></div>
  </div>
  ${groups.map(g => `<div class="va-grp"><h5>${g.p}</h5>${g.items.map(c => `
    <div class="va-row ${c.st}"><span class="va-dot">${stIcon[c.st]}</span><div><b>${c.title}</b>${c.pts ? ` <small class="mono ${c.pts > 0 ? 'up' : 'down'}">${c.pts > 0 ? '+' : ''}${c.pts}</small>` : ''}<p>${c.text}</p><div class="va-rule">판정 규칙: ${c.rule}</div></div></div>`).join('')}</div>`).join('')}
  <div class="hint mt">※ 설계 3원칙: ① 거래량·거래대금은 절대값이 아니라 평소 대비 배수·비율로 본다 ② 거래량 급증은 매수 근거가 아니라 돌파·추세가 진짜인지 확인하는 도구다(한국 증시엔 '고거래량 프리미엄'이 없다는 연구) ③ 하락의 강도는 거래량보다 거래대금으로 본다. 임계값(2배·3배·5배·10배 등)은 경험칙이므로 백테스트로 보정이 필요해요. 장 마감 뒤 일봉 기준이며, 거래대금 그래프는 종가×거래량으로 계산한 근사값이에요.</div>`;
}

function volDraw(a, range, root) {
  const cv = $('#vaChart', root || document);
  if (!window.Chart || !cv) return;
  if (cv._vchart) { try { cv._vchart.destroy(); } catch (e) {} VOL.charts = VOL.charts.filter(c => c !== cv._vchart); }
  const css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
  const { n, C, TV, TA20, OBV } = a.z, m = Math.min(range, n), from = n - m;
  const labels = Array.from({ length: m }, (_, i) => { const d = m - 1 - i; return d === 0 ? '오늘' : d + '일 전'; });
  const up = col('--up'), dn = col('--down'), grid = col('--line'), txt = col('--muted');
  const tv = TV.slice(from), cc = C.slice(from);
  const mk = Array(m).fill(null), mkc = Array(m).fill(null), mkt = Array(m).fill('');
  a.ev.forEach(x => { const k = x.i - from; if (k >= 0 && k < m) { mk[k] = tv[k] * 1.08; mkc[k] = x.k === 'good' ? col('--ok') : x.k === 'bad' ? col('--bad') : x.k === 'warn' ? col('--warn') : txt; mkt[k] = (mkt[k] ? mkt[k] + ', ' : '') + x.t; } });
  VOL.charts.push(cv._vchart = new Chart(cv, {
    data: { labels, datasets: [
      { type: 'line', label: '신호', data: mk, showLine: false, pointStyle: 'triangle', pointRadius: 7, pointBackgroundColor: mkc, pointBorderColor: mkc, order: 0, yAxisID: 'y' },
      { type: 'bar', label: '거래대금(억)', data: tv, backgroundColor: cc.map((x, i) => (i ? x < cc[i - 1] : (C[from - 1] || x) > x) ? dn : up), order: 3, yAxisID: 'y' },
      { type: 'line', label: '20일 평균', data: TA20.slice(from), borderColor: txt, borderDash: [4, 3], borderWidth: 1.3, pointRadius: 0, order: 1, yAxisID: 'y' },
      { type: 'line', label: 'OBV', data: OBV.slice(from), borderColor: '#8b5cf6', borderWidth: 1.6, pointRadius: 0, order: 1, yAxisID: 'y2' },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: c => c.dataset.label === '신호' ? (mkt[c.dataIndex] ? '신호: ' + mkt[c.dataIndex] : null) : c.dataset.label === 'OBV' ? 'OBV ' + fmt(c.raw) : `${c.dataset.label} ${fmt(c.raw, 1)}억` } } },
      scales: { x: { ticks: { color: txt, maxTicksLimit: 6 }, grid: { color: grid } },
        y: { position: 'right', ticks: { color: txt, maxTicksLimit: 4, callback: v => fmt(v) + '억' }, grid: { color: grid }, beginAtZero: true },
        y2: { position: 'left', display: false } } },
  }));
}

function renderVolCard(s, mountId) {
  const box = $('#' + mountId); if (!box) return null;
  const a = volAnalyze(s);
  box.innerHTML = volCardHtml(s, a);
  if (a) {
    volDraw(a, 120, box);
    $$('[data-vrng]', box).forEach(b => b.onclick = () => { $$('[data-vrng]', box).forEach(x => x.classList.toggle('on', x === b)); volDraw(a, +b.dataset.vrng, box); });
  }
  return a;
}

/* ───── 화면: 거래대금 신호 탭 ───── */
const VSIG = [
  ['brk', '유효 돌파', 'good', '대량 거래(평소 2배↑) + 장대양봉으로 3개월 고점을 넘은 종목', a => a.flags.brk],
  ['trueUp', '진성 상승', 'good', '거래 급증 + 외국인·기관이 산 상승', a => a.flags.trueUp],
  ['bottom', '바닥권 매수세 재등장', 'good', '거래가 말랐던 바닥에서 60일 최대 거래량(평소 3배↑) + 양봉', a => a.flags.bottom],
  ['obvBull', 'OBV 상승 다이버전스', 'good', '주가 저점은 낮아졌는데 거래량 누적(OBV) 저점은 높아짐', a => a.flags.obvBull || a.flags.obvLead],
  ['healthyPull', '건강한 눌림', 'good', '내릴 때 거래대금이 오를 때의 절반 아래로 말라감', a => a.flags.healthyPull],
  ['scout', '정찰병(간보기)', 'info', '좁은 박스 안에서 거래량만 몇 번 튐 — 상승 전조 시각', a => a.flags.scout],
  ['whale', '큰손 이탈 경보', 'bad', '장대음봉 + 6개월 상위 10% 거래대금', a => a.flags.whale],
  ['flat', '제자리 폭증 경보', 'bad', '주가 ±1% 안인데 거래량 5배↑', a => a.flags.flat],
  ['holdTv', '하락 중 대금 유지', 'bad', '내린 날 거래대금이 오를 때 이상 — 추세 전환 위험', a => a.flags.holdTv],
  ['extreme', '극단 과열(매수 금지)', 'bad', '하루 거래대금 ≥ 시가총액', a => a.flags.extreme],
  ['burn', '적자 기업 거래 폭증', 'bad', '영업현금흐름 마이너스 + 거래량 3배↑', a => a.flags.burn],
  ['obvBear', 'OBV 하락 다이버전스', 'bad', '주가 고점은 높아졌는데 OBV 고점은 낮아짐', a => a.flags.obvBear],
];

function volAll() {
  if (VOL.all && VOL.allGen === S.data) return VOL.all;
  VOL.all = new Map();
  S.data.stocks.forEach(s => { try { const a = volAnalyze(s); if (a) VOL.all.set(s.code, a); } catch (e) { /* 자료 이상 종목은 건너뜀 */ } });
  VOL.allGen = S.data;
  return VOL.all;
}

function renderVolTab() {
  const box = $('#vsList'); if (!box || !S.data) return;
  const all = volAll(), M = volMarket();
  const mkt = $('#vsMarket').value, key = $('#vsType').value;
  $('#vsMkt').innerHTML = `<div class="va-tiles va-mkt">
    <div><small>시장 온도</small><b>${M.temp}</b><span class="hint">총 거래대금 20일 평균의 ${vX(M.ratio, 2)}</span></div>
    <div><small>오늘 총 거래대금</small><b>${vEok(M.sum)}</b><span class="hint">분석 대상 ${M.cnt}종목 합계</span></div>
    <div><small>시장 회전율</small><b>${fmt(M.turnToday, 2)}%</b><span class="hint">20일 평균 ${fmt(M.turnA20, 2)}%</span></div>
    <div><small>1위 쏠림</small><b>${fmt(M.top1 * 100, 1)}%</b><span class="hint">${esc(M.top1s ? M.top1s.name : '')}${M.top1 >= 0.3 ? ' — 자금 쏠림 국면' : ''}</span></div>
    <div><small>상위 10종목</small><b>${fmt(M.top10 * 100, 0)}%</b><span class="hint">전체 거래대금 중</span></div></div>`;
  const pool = S.data.stocks.filter(s => all.has(s.code) && (mkt === 'all' || s.market === mkt));
  const counts = VSIG.map(([k, t, c, d, fn]) => [k, pool.filter(s => fn(all.get(s.code))).length]);
  $('#vsChips').innerHTML = VSIG.map(([k, t, c], i) => `<button class="chip vs-chip ${c} ${k === key ? 'on' : ''}" data-vs="${k}">${t} <b>${counts[i][1]}</b></button>`).join('');
  $$('#vsChips [data-vs]').forEach(b => b.onclick = () => { $('#vsType').value = b.dataset.vs; if ($('#vsQ')) $('#vsQ').value = ''; renderVolTab(); });
  const sig = VSIG.find(x => x[0] === key) || VSIG[0];
  // 종목 검색: 검색어가 있으면 신호·시장 필터와 관계없이 이름·코드로 찾음
  const q = $('#vsQ') ? $('#vsQ').value.trim() : '';
  let rows;
  ['#vsMkt', '#vsFresh', '#vsSurge', '#vsChips'].forEach(id => { const el = $(id); if (el) el.classList.toggle('hidden', !!q); });  // 검색 중에는 결과를 검색창 바로 아래에
  if (q) {
    const hits = (typeof findStocks === 'function' ? findStocks(q) : S.data.stocks.filter(s => s.name.includes(q) || s.code.includes(q))).filter(s => all.has(s.code));
    rows = hits.map(s => ({ s, a: all.get(s.code) }));
    volRenderOne(hits.length === 1 ? hits[0] : null, q, hits.length);
    $('#vsDesc').innerHTML = `<b>"${esc(q)}" 검색 결과</b> ${rows.length}종목 — 검색 중에는 신호·시장 필터를 적용하지 않아요. 카드의 초록/빨강 표시가 그 종목에 지금 켜진 신호예요.`;
  } else {
    volRenderOne(null, '', 0);
    rows = pool.filter(s => sig[4](all.get(s.code))).map(s => ({ s, a: all.get(s.code) }))
      .sort((x, y) => sig[2] === 'bad' ? x.a.score - y.a.score : y.a.score - x.a.score);
    $('#vsDesc').innerHTML = `<b>${sig[1]}</b> — ${sig[3]} · ${rows.length}종목`;
  }
  box.innerHTML = rows.length ? rows.slice(0, 60).map(({ s, a }) => {
    const ck = { brk: 'brk', trueUp: 'flow', bottom: 'bottom', obvBull: 'obv', healthyPull: 'hold', scout: 'scout', whale: 'whale', flat: 'flat', holdTv: 'hold', extreme: 'extreme', burn: 'burn', obvBear: 'obv' }[sig[0]];
    const hit = q ? null : (a.chk.find(c => c.k === ck) || a.chk.find(c => c.st === sig[2]));
    const on = q ? VSIG.filter(v => { try { return v[4](a); } catch (e) { return false; } }) : [];
    return `<div class="vs-card" data-an="${esc(s.code)}">
      <div class="vs-h"><b>${esc(s.name)}</b> <small class="muted">${s.market === 'KOSPI' ? '코스피' : '코스닥'} · ${esc(s.sector || '')}</small>
        <span class="mono ${cls(s.chg)}">${pct(s.chg, 1)}</span><span class="va-pill ${a.verdict.c}">${a.score}</span></div>
      <div class="vs-m mono">거래량 ${vX(a.rv)} · 대금 ${vEok(a.tvToday)} · 회전율 ${a.tvMcap != null ? fmt(a.tvMcap, 2) + '%' : '–'}</div>
      ${hit ? `<div class="vs-t">${hit.text}</div>` : ''}
      ${q ? `<div class="vs-f">${on.length ? on.map(v => `<span class="tag ${v[2] === 'bad' ? 'bad' : v[2] === 'good' ? 'good' : ''}">${v[1]}</span>`).join('') : '<span class="tag">켜진 신호 없음</span>'}</div>` : ''}
      <div class="vs-act ${a.plan.cls}">👉 ${a.plan.act}</div>
      <div class="vs-f">${a.goods.slice(0, 3).map(c => `<span class="tag good">${c.title}</span>`).join('')}${a.bads.slice(0, 3).map(c => `<span class="tag bad">${c.title}</span>`).join('')}</div>
    </div>`;
  }).join('') : '<div class="empty">지금 이 신호에 해당하는 종목이 없어요.</div>';
  $$('#vsList [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
  if (typeof renderVolLive === 'function') renderVolLive();
}

function volRenderOne(s, q, n) {
  const box = $('#vsOne'); if (!box) return;
  if (!q) { box.innerHTML = ''; box.dataset.k = ''; return; }
  if (!s) { box.dataset.k = ''; box.innerHTML = n ? '<div class="hint">여러 종목이 검색됐어요 — 아래 카드에서 고르거나 이름을 더 정확히 입력하세요.</div>' : `<div class="empty">"${esc(q)}"과(와) 맞는 종목이 없어요.</div>`; return; }
  const k = s.code + '|' + (VOL.liveTime || '');
  if (box.dataset.k === k) return;
  box.dataset.k = k;
  box.innerHTML = `<div class="an-card an-wide"><h4>${esc(s.name)} <span class="muted mono">${esc(s.code)}</span> 거래량·거래대금 정밀 해석 <button class="btn ghost small" id="vsOneAn">종목 분석 전체 보기 →</button></h4><div id="vsOneMount"></div></div>`;
  renderVolCard(s, 'vsOneMount');
  $('#vsOneAn').onclick = () => showAnalysis(s.code);
}
function initVolume() {
  if ($('#vsQ')) {
    const go = () => renderVolTab();
    $('#vsQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    $('#vsQ').onchange = go; $('#vsQGo').onclick = go;
    $('#vsQClear').onclick = () => { $('#vsQ').value = ''; go(); };
  }
  if (typeof initVolLive === 'function') setTimeout(initVolLive, 0);
  if ($('#vsType')) {
    $('#vsType').innerHTML = VSIG.map(([k, t]) => `<option value="${k}">${t}</option>`).join('');
    $('#vsType').onchange = renderVolTab; $('#vsMarket').onchange = renderVolTab;
  }
  // 조건검색·문장검색에서 쓸 수 있게 등록
  const g = '거래량 해석', get = (s, f) => { const a = volAll().get(s.code); return a ? f(a) : null; };
  FM.vol_score = { key: 'vol_score', label: '거래 에너지·질 점수', group: g, type: 'num', unit: '점', get: s => get(s, a => a.score) };
  FM.vs_brk = { key: 'vs_brk', label: '대량 거래 유효 돌파', group: g, type: 'bool', unit: '', get: s => !!get(s, a => a.flags.brk) };
  FM.vs_true = { key: 'vs_true', label: '진성 상승(거래 급증+큰손 매수)', group: g, type: 'bool', unit: '', get: s => !!get(s, a => a.flags.trueUp) };
  FM.vs_bottom = { key: 'vs_bottom', label: '바닥권 거래량 폭증', group: g, type: 'bool', unit: '', get: s => !!get(s, a => a.flags.bottom) };
  FM.vs_obv = { key: 'vs_obv', label: 'OBV 상승 다이버전스·선행', group: g, type: 'bool', unit: '', get: s => !!get(s, a => a.flags.obvBull || a.flags.obvLead) };
  FM.vs_pull = { key: 'vs_pull', label: '거래대금 마르는 건강한 눌림', group: g, type: 'bool', unit: '', get: s => !!get(s, a => a.flags.healthyPull) };
  FM.vs_warn = { key: 'vs_warn', label: '거래량 경보(큰손 이탈·제자리 폭증·과열 등)', group: g, type: 'bool', unit: '', get: s => !!get(s, a => a.bads.length) };
}

function renderVolume() { renderVolTab(); }

/* ───── 실시간: 장중 15분마다 받는 오늘 봉으로 거래량·거래대금 다시 해석 ─────
   보고서 11장 '장중 데이터 보정': 장중 누적 거래량은 시간대별 평균 진행률로 나눠 '하루 예상 거래량'으로 환산해 비교 */
const VOL_CURVE = [[0, 0], [30, 0.20], [60, 0.30], [120, 0.44], [180, 0.54], [240, 0.63], [300, 0.73], [360, 0.88], [390, 1]];
function volKst() { return new Date(Date.now() + 9 * 3600e3); }
function volFrac() {  // 09:00~15:30 중 지금까지 하루 거래량의 몇 %가 보통 체결되는지 (시작·마감에 몰리는 U자형)
  const k = volKst(), m = k.getUTCHours() * 60 + k.getUTCMinutes() - 540;
  if (m <= 0) return null;
  if (m >= 390) return 1;
  for (let i = 1; i < VOL_CURVE.length; i++) {
    const [m0, f0] = VOL_CURVE[i - 1], [m1, f1] = VOL_CURVE[i];
    if (m <= m1) return Math.max(0.08, f0 + (f1 - f0) * (m - m0) / (m1 - m0));
  }
  return 1;
}
function volSigMap(all) {
  const out = {};
  all.forEach((a, code) => { out[code] = VSIG.filter(sg => sg[4](a)).map(sg => sg[0]); });
  return out;
}
function volApplyLive(d) {
  if (!d || !d.s || !S.data) return;
  const asof = S.data.meta.asof, today = volKst().toISOString().slice(0, 10), f = volFrac();
  if (!VOL.prevSig) VOL.prevSig = volSigMap(volAll());  // 첫 적용 전 = 어제 종가 기준 신호
  let n = 0;
  S.data.stocks.forEach(s => {
    const x = d.s[s.code]; if (!x || !x.bars || !s.spark) return;
    if (!s._base) s._base = { c: s.spark, v: s.spark_vol, o: s.spark_o, h: s.spark_h, l: s.spark_l, tvalue: s.tvalue, volume: s.volume };
    const B = s._base, has = !!(B.o && B.h && B.l);
    const C = [...B.c], V = [...B.v], O = has ? [...B.o] : null, H = has ? [...B.h] : null, L = has ? [...B.l] : null;
    let last = null;
    x.bars.forEach(([dd, o, h, l, c, v]) => {
      if (dd < asof) return;
      const intr = dd === today && f != null && f < 1;
      const vv = intr ? Math.round(v / f) : v;
      const put = (A, val) => { if (!A) return; if (dd === asof) A[A.length - 1] = val; else { A.push(val); A.shift(); } };
      put(C, c); put(V, vv); put(O, o); put(H, h); put(L, l);
      last = { d: dd, raw: v, proj: vv, f: intr ? f : 1, intr, c, tv: c * v / 1e8 };
    });
    if (!last) return;
    s.spark = C; s.spark_vol = V; if (has) { s.spark_o = O; s.spark_h = H; s.spark_l = L; }
    s.tvalue = last.tv; s.volume = last.raw; s._vlive = { ...last, chg: x.chg, time: d.meta.time };
    n++;
  });
  if (!n) return;  // 오늘 봉 정보가 아직 없는 요약(이전 버전) → 기존 종가 기준 유지
  const nIntr = S.data.stocks.filter(s => s._vlive && s._vlive.intr).length;
  VOL.all = null; VOL.mkt = null; VOL.liveTime = d.meta.time; VOL.liveN = n; VOL.liveF = nIntr ? f : 1;
  const now = volSigMap(volAll()), prev = VOL.prevSig || {}, fresh = [];
  Object.entries(now).forEach(([code, ks]) => ks.forEach(k => { if (!(prev[code] || []).includes(k)) fresh.push({ code, k }); }));
  VOL.fresh = fresh; VOL.freshFrom = VOL.prevTime || `${asof} 종가`; VOL.prevTime = d.meta.time; VOL.prevSig = now;
  volNotify(fresh);
  renderVolTab();
  const mount = $('#vaMount'), code = $('#clxMount') && $('#clxMount').dataset.code;
  if (mount && code && $('#tab-analysis') && $('#tab-analysis').classList.contains('on')) {
    const st = S.data.stocks.find(x => x.code === code); if (st) renderVolCard(st, 'vaMount');
  }
  const tab = $('button[data-tab="vol"]'); if (tab) tab.dataset.badge = fresh.filter(x => ['brk', 'bottom', 'trueUp', 'whale', 'flat', 'extreme'].includes(x.k)).length || '';
}
function volNotify(fresh) {
  const KEY = ['brk', 'bottom', 'trueUp', 'whale', 'flat', 'extreme', 'burn'];
  const hot = fresh.filter(x => KEY.includes(x.k));
  if (!hot.length) return;
  const M = Object.fromEntries(S.data.stocks.map(s => [s.code, s])), nm = k => (VSIG.find(v => v[0] === k) || [k, k])[1];
  const txt = hot.slice(0, 4).map(x => `${(M[x.code] || {}).name || x.code}: ${nm(x.k)}`);
  const t = $('#govToast');
  if (t) { t.innerHTML = `📊 거래대금 신호 새로 켜짐 ${hot.length}건 — ${esc(txt[0])}`; t.classList.remove('hidden'); t.onclick = () => { switchTab('vol'); t.classList.add('hidden'); }; setTimeout(() => t.classList.add('hidden'), 15000); }
  if (store.get('volNoti', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('거래대금 신호 ' + hot.length + '건', { body: txt.join('\n') }); } catch (e) {}
  }
}
function renderVolLive() {
  const st = $('#vsLiveStatus'); if (!st) return;
  if (!VOL.liveTime) { st.innerHTML = `실시간 대기 중 — 장중(평일 9:00~15:30)에는 15분마다 오늘 거래량으로 다시 계산돼요. 지금은 ${esc(S.data.meta.asof || '')} 종가 기준이에요.`; }
  else {
    const f = VOL.liveF;
    st.innerHTML = `<span class="gov-live"></span> 실시간 <b>${esc(VOL.liveTime.slice(11))}</b> 기준 · ${VOL.liveN}종목 · ${f != null && f < 1 ? `장중 진행 약 ${Math.round(f * 100)}% 시점 — 거래량은 <b>하루 예상치로 환산</b>해 비교(실제 누적 ÷ ${f.toFixed(2)})` : '오늘 장 마감 기준'}`;
  }
  const M = Object.fromEntries(S.data.stocks.map(s => [s.code, s]));
  const box = $('#vsFresh');
  if (box) {
    const fr = VOL.fresh || [];
    const by = {}; fr.forEach(x => { (by[x.k] = by[x.k] || []).push(x.code); });
    box.innerHTML = VOL.liveTime ? (fr.length ? `<h4>새로 켜진 신호 <small class="muted">${esc(VOL.freshFrom)} → ${esc(VOL.liveTime.slice(11))}</small></h4>` + VSIG.filter(v => by[v[0]]).map(v => `<div class="mn-grp"><span class="mn-gl ${v[2] === 'bad' ? 'bad' : v[2] === 'good' ? 'good' : ''}">${v[1]} ${by[v[0]].length}</span>${by[v[0]].slice(0, 15).map(c => M[c] ? `<button class="mn-chip ${v[2]}" data-an="${esc(c)}">${esc(M[c].name)} <small class="${cls((M[c]._vlive || {}).chg)} mono">${pct((M[c]._vlive || {}).chg, 1)}</small></button>` : '').join('')}</div>`).join('') : `<div class="hint">${esc(VOL.freshFrom)} 이후 새로 켜진 신호가 없어요.</div>`) : '';
  }
  const sb = $('#vsSurge');
  if (sb && VOL.liveTime) {
    const all = volAll();
    const rows = S.data.stocks.filter(s => s._vlive && all.get(s.code)).map(s => ({ s, a: all.get(s.code) })).filter(x => x.a.rv >= 2).sort((a, b) => b.a.rv - a.a.rv).slice(0, 20);
    sb.innerHTML = `<h4>실시간 거래량 급증 순위 <small class="muted">하루 예상 거래량 ÷ 20일 평균 · 2배 이상</small></h4>` + (rows.length ? `<table class="clx-tb"><thead><tr><th>종목</th><th>현재가</th><th>예상 거래량 배수</th><th>지금까지 거래대금</th><th>해석</th></tr></thead><tbody>${rows.map(({ s, a }) => {
      const L = s._vlive, up = (L.chg || 0) > 0, flat = Math.abs(L.chg || 0) < 1;
      const t = a.rv >= 10 ? '과열·이상 거래 의심' : flat && a.rv >= 5 ? '주가 제자리 + 폭증 — 세력 이탈 경계' : up ? (a.flags.brk ? '대량 거래 돌파' : '상승 + 거래 급증(매수세)') : '하락 + 거래 급증(매도세)';
      return `<tr data-an="${esc(s.code)}"><td><b>${esc(s.name)}</b> <small class="muted">${s.market === 'KOSPI' ? '코스피' : '코스닥'}</small></td><td class="mono">${fmt(L.c)} <small class="${cls(L.chg)}">${pct(L.chg, 1)}</small></td><td class="mono"><b>${vX(a.rv)}</b></td><td class="mono">${vEok(L.tv)}</td><td>${t}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="hint">지금 평소의 2배 이상 거래되는 종목이 없어요.</div>');
  } else if (sb) sb.innerHTML = '';
  $$('#vsFresh [data-an], #vsSurge [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
}
function initVolLive() {
  const nb = $('#volNoti'); if (!nb) return;
  const draw = () => { nb.textContent = store.get('volNoti', false) ? '🔔 신호 알림 켜짐' : '🔕 신호 알림 켜기'; };
  nb.onclick = async () => {
    if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않아요.'); return; }
    if (store.get('volNoti', false)) { store.set('volNoti', false); draw(); return; }
    const p = await Notification.requestPermission(); store.set('volNoti', p === 'granted'); draw();
  };
  draw();
}
