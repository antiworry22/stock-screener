/* 차트 종합 판정 — CHARTLAB 6축 엔진 결과 화면
   근거: 「차트 하나로 전부 판단하는 실전 주식 분석 시스템」 가이드 + chartlab_engine (수집 단계에서 매일 전 종목 계산)
   데이터: latest.json의 s.cl(요약) + 보관 칸 live-cl/{code}.json(일봉 약 380개 + 전체 분석 결과) */
'use strict';

const CLX = { RAW: 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-cl/', cache: new Map(), charts: [], range: 120 };
const CLX_AX = [['trend', '추세', 26], ['momentum', '모멘텀', 20], ['volume', '거래량·수급', 16], ['structure', '구조·지지저항', 20], ['patterns', '패턴', 12], ['mtf', '주봉 정합', 6]];
const CLX_VERD = [[55, '강력 매수', 'g3'], [28, '매수 우위', 'g2'], [8, '약한 매수', 'g1'], [-8, '중립·관망', 'n'], [-28, '약한 매도', 'r1'], [-55, '매도 우위', 'r2'], [-999, '강력 매도', 'r3']];
const clxVcls = sc => (CLX_VERD.find(v => sc >= v[0]) || CLX_VERD[6])[2];
const CLX_PAT = {
  double_bottom: ['이중바닥(W자)', '저점 두 번 지지 → 넥라인 돌파 시 상승. 목표 = 넥라인 + (넥라인 − 바닥)'],
  double_top: ['이중천장(M자)', '고점 두 번 막힘 → 넥라인 이탈 시 하락. 목표 = 넥라인 − (천장 − 넥라인)'],
  head_shoulders: ['헤드앤숄더', '머리>양어깨 천장형 → 목선 이탈 시 하락. 목표 = 목선 − (머리 − 목선)'],
  inverse_head_shoulders: ['역헤드앤숄더', '거꾸로 된 바닥형 → 목선 돌파 시 상승. 목표 = 목선 + (목선 − 머리)'],
  asc_triangle: ['상승 삼각형', '수평 저항 + 올라오는 지지 → 위로 돌파 우세. 목표 = 삼각형 최대 폭'],
  desc_triangle: ['하락 삼각형', '수평 지지 + 내려오는 저항 → 아래로 이탈 우세'],
  sym_triangle: ['대칭 삼각형', '수렴 후 터지는 방향을 따라감. 거래량 급증 동반 시 확정'],
  rising_wedge: ['상승 쐐기', '오르지만 폭이 좁아짐 = 힘 소진 → 하락 반전 경계'],
  falling_wedge: ['하락 쐐기', '내리지만 폭이 좁아짐 = 매도 소진 → 상승 반전 경계'],
  rectangle: ['박스권', '고점·저점 3번 이상 반복. 돌파 방향으로 박스 높이만큼'],
  bull_flag: ['강세 깃발', '급등(깃대) 후 좁은 쉬기 → 재돌파 시 깃대 길이만큼 추가'],
  bear_flag: ['약세 깃발', '급락 후 좁은 쉬기 → 재이탈 시 추가 하락'],
  cup_handle: ['컵앤핸들', 'U자 컵 + 짧은 손잡이 → 테두리 돌파 시 컵 깊이만큼 상승'],
  breakout_high: ['신고가 돌파', '직전 60봉 고점 돌파. 거래량 1.5배 이상이어야 진짜'],
  breakdown_low: ['신저가 이탈', '직전 60봉 저점 이탈 — 하락 추세'],
};
const CLX_CND = {
  bullish_engulfing: '앞 음봉을 통째로 감싼 양봉 — 강한 반전', bearish_engulfing: '앞 양봉을 통째로 감싼 음봉 — 강한 하락 반전',
  morning_star: '긴 음봉 → 작은 봉 → 긴 양봉, 바닥 반전 완성형', evening_star: '긴 양봉 → 작은 봉 → 긴 음봉, 천장 반전 완성형',
  three_white_soldiers: '양봉 3연속(몸통 큼) — 매수세 장악', three_black_crows: '음봉 3연속(몸통 큼) — 매도세 장악',
  hammer: '하락 끝 긴 아래꼬리 — 바닥에서 사는 힘', hanging_man: '상승 끝 긴 아래꼬리 — 하락 경고', shooting_star: '긴 위꼬리 음봉 — 위에서 파는 힘',
  inverted_hammer: '긴 위꼬리 — 단독으론 약함', piercing: '전 음봉 절반 이상을 되돌린 양봉', dark_cloud: '전 양봉 절반 이상을 깎은 음봉',
  bullish_harami: '큰 음봉 안에 갇힌 양봉 — 하락 멈춤', bearish_harami: '큰 양봉 안에 갇힌 음봉 — 상승 멈춤',
  tweezer_bottom: '같은 저가 두 번 + 양봉 전환', tweezer_top: '같은 고가 두 번 + 음봉 전환', three_line_strike: '음봉 3개를 한 번에 되돌린 양봉',
  gap_up: '갭 상승 — 강한 수요', gap_down: '갭 하락 — 강한 매도', doji: '도지 — 망설임, 다음 봉 확인', spinning_top: '팽이형 — 방향 중립', marubozu: '꼬리 없는 장대봉 — 한쪽 압도',
};
const CLX_CNAME = { doji: '도지', hammer: '망치형', inverted_hammer: '역망치형', shooting_star: '유성형', hanging_man: '교수형', marubozu: '마루보주', spinning_top: '팽이형',
  bullish_engulfing: '상승장악형', bearish_engulfing: '하락장악형', bullish_harami: '상승잉태형', bearish_harami: '하락잉태형', piercing: '관통형', dark_cloud: '흑운형',
  tweezer_bottom: '쌍바닥(집게)', tweezer_top: '쌍봉(집게)', morning_star: '샛별형', evening_star: '석별형', three_white_soldiers: '적삼병', three_black_crows: '흑삼병',
  three_line_strike: '삼선반격형', gap_up: '갭상승', gap_down: '갭하락' };
const clxWon = v => v == null ? '–' : fmt(Math.round(v)) + '원';
const clxPct = (a, b) => b ? pct((a / b - 1) * 100, 1) : '';

async function clxLoad(code) {
  const ck = code + '@' + ((CLX.live && CLX.live.meta.time) || '');
  if (CLX.cache.has(ck)) return CLX.cache.get(ck);
  let f = null;
  for (const u of [CLX.RAW + code + '.json?t=' + encodeURIComponent((CLX.live && CLX.live.meta.time) || S.data.meta.generated || ''), 'data/cl/' + code + '.json']) {
    try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) { f = await r.json(); break; } } catch (e) { /* 다음 경로 */ }
  }
  CLX.cache.set(ck, f);
  return f;
}

/* ── 지표 선(그림용) ── */
const X = {
  sma(a, n) { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; },
  ema(a, n) { const o = []; const k = 2 / (n + 1); a.forEach((x, i) => o.push(i ? x * k + o[i - 1] * (1 - k) : x)); return o; },
  bb(a, n = 20) { const m = X.sma(a, n); return a.map((_, i) => { if (m[i] == null) return null; const w = a.slice(i - n + 1, i + 1); const sd = Math.sqrt(w.reduce((p, x) => p + (x - m[i]) ** 2, 0) / (n - 1)); return { up: m[i] + 2 * sd, lo: m[i] - 2 * sd }; }); },
  rsi(a, n = 14) { const o = [50]; let u = 0, d = 0; for (let i = 1; i < a.length; i++) { const c = a[i] - a[i - 1]; u = (u * (n - 1) + Math.max(c, 0)) / n; d = (d * (n - 1) + Math.max(-c, 0)) / n; o.push(d === 0 ? 100 : 100 - 100 / (1 + u / d)); } return o; },
  macd(a) { const f = X.ema(a, 12), s = X.ema(a, 26), m = f.map((x, i) => x - s[i]), g = X.ema(m, 9); return { m, g, h: m.map((x, i) => x - g[i]) }; },
  stoch(h, l, c, k = 14) { const raw = c.map((x, i) => { if (i < k - 1) return null; const hh = Math.max(...h.slice(i - k + 1, i + 1)), ll = Math.min(...l.slice(i - k + 1, i + 1)); return hh > ll ? (x - ll) / (hh - ll) * 100 : 50; }); const sm = (a, n) => a.map((_, i) => { const w = a.slice(Math.max(0, i - n + 1), i + 1).filter(x => x != null); return w.length === n ? w.reduce((p, q) => p + q, 0) / n : null; }); const K = sm(raw, 3); return { k: K, d: sm(K, 3) }; },
};

function clxDraw(f, range) {
  CLX.charts.forEach(c => c.destroy()); CLX.charts.length = 0;
  if (!window.Chart || !$('#clxPrice')) return;
  const css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
  const up = col('--up'), dn = col('--down'), grid = col('--line'), txt = col('--muted');
  const N = f.c.length, n = Math.min(range, N), from = N - n, cut = a => a.slice(from);
  const labels = f.d.slice(from).map(x => x.slice(5).replace('-', '/'));
  const r = f.r, C = cut(f.c), O = cut(f.o), H = cut(f.h), L = cut(f.l), V = cut(f.v);
  const colr = C.map((x, i) => x >= O[i] ? up : dn);
  const ma = p => cut(X.sma(f.c, p)), bb = cut(X.bb(f.c));
  const line = (label, d, color, dash, w = 1.2) => ({ type: 'line', label, data: d, borderColor: color, borderWidth: w, pointRadius: 0, borderDash: dash || [], spanGaps: true, order: 1 });
  const flat = (label, y, color, dash, w = 1.3) => line(label, Array(n).fill(y), color, dash, w);
  const ds = [
    { type: 'bar', label: '고저', data: H.map((x, i) => [L[i], x]), backgroundColor: colr, barPercentage: 0.15, categoryPercentage: 1, order: 3 },
    { type: 'bar', label: '시가·종가', data: O.map((x, i) => [Math.min(x, C[i]), Math.max(x, C[i]) + (x === C[i] ? C[i] * 0.0015 : 0)]), backgroundColor: colr, barPercentage: 0.75, categoryPercentage: 1, order: 2 },
    line('5일', ma(5), '#e0a100'), line('20일', ma(20), up), line('60일', ma(60), '#16a34a'), line('120일', ma(120), '#8b5cf6'), line('200일', ma(200), '#0f172a', null, 1.6),
    line('밴드 위', bb.map(x => x && x.up), txt, [3, 3], 0.9), line('밴드 아래', bb.map(x => x && x.lo), txt, [3, 3], 0.9),
  ];
  (r.resistance || []).slice(0, 3).forEach((x, i) => ds.push(flat(`저항${i + 1}`, x.price, '#dc2626', [6, 4], Math.min(2.6, 0.8 + x.strength / 2))));
  (r.support || []).slice(0, 3).forEach((x, i) => ds.push(flat(`지지${i + 1}`, x.price, '#16a34a', [6, 4], Math.min(2.6, 0.8 + x.strength / 2))));
  (r.chart_patterns || []).forEach(p => {
    if (p.neckline) ds.push(flat(`${(CLX_PAT[p.key] || [p.name])[0]} 넥라인`, p.neckline, '#d97706', [2, 2], 1.6));
    if (p.target) ds.push(flat(`${(CLX_PAT[p.key] || [p.name])[0]} 목표`, p.target, '#7c3aed', [1, 3], 1.4));
  });
  ds.push(flat('손절가', r.plan.stop, dn, [8, 3], 1.8), flat('목표1', r.plan.target1, '#059669', [8, 3], 1.4));
  // 캔들 패턴 표시
  const mk = Array(n).fill(null), mkc = Array(n).fill(null), mkl = Array(n).fill('');
  (r.candle_patterns || []).forEach(h => { const k = n - 1 - h.bars_ago; if (k < 0 || !h.direction) return; mk[k] = h.direction > 0 ? L[k] * 0.985 : H[k] * 1.015; mkc[k] = h.direction > 0 ? col('--ok') : col('--bad'); mkl[k] = (mkl[k] ? mkl[k] + ', ' : '') + h.name; });
  ds.push({ type: 'line', label: '캔들신호', data: mk, showLine: false, pointStyle: 'triangle', rotation: mk.map((_, i) => mkc[i] === col('--bad') ? 180 : 0), pointRadius: 7, pointBackgroundColor: mkc, pointBorderColor: mkc, order: 0 });
  const vis = [...L, ...H].filter(x => x != null);
  const lo = Math.min(...vis), hi = Math.max(...vis);
  const yMin = Math.min(lo, r.plan.stop) * 0.98, yMax = Math.max(hi, r.plan.target1) * 1.02;
  const base = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { filter: it => !['고저'].includes(it.dataset.label) && it.raw != null, callbacks: {} } },
    scales: { x: { ticks: { color: txt, maxTicksLimit: 8 }, grid: { color: grid } }, y: { position: 'right', ticks: { color: txt }, grid: { color: grid } } } };
  CLX.charts.push(new Chart($('#clxPrice'), { data: { labels, datasets: ds }, options: { ...base,
    plugins: { ...base.plugins, legend: { display: true, labels: { color: txt, boxWidth: 10, font: { size: 10.5 }, filter: it => !['고저', '시가·종가', '캔들신호'].includes(it.text) } },
      tooltip: { ...base.plugins.tooltip, callbacks: { label: c => c.dataset.label === '캔들신호' ? (mkl[c.dataIndex] ? '캔들: ' + mkl[c.dataIndex] : null) : c.dataset.label === '시가·종가' ? `시가 ${fmt(O[c.dataIndex])} · 종가 ${fmt(C[c.dataIndex])} · 고가 ${fmt(H[c.dataIndex])} · 저가 ${fmt(L[c.dataIndex])}` : `${c.dataset.label} ${fmt(Array.isArray(c.raw) ? c.raw[1] : c.raw)}` } } },
    scales: { ...base.scales, y: { ...base.scales.y, min: Math.round(yMin), max: Math.round(yMax), ticks: { color: txt, callback: v => fmt(v) } } } } }));
  const vma = cut(X.sma(f.v, 20));
  CLX.charts.push(new Chart($('#clxVol'), { data: { labels, datasets: [{ type: 'bar', label: '거래량', data: V, backgroundColor: C.map((x, i) => (i ? x < C[i - 1] : x < O[i]) ? dn : up), order: 2 }, line('20일 평균', vma, txt, [4, 3])] },
    options: { ...base, scales: { x: { display: false }, y: { ...base.scales.y, ticks: { color: txt, maxTicksLimit: 3, callback: v => v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v } } } } }));
  const rs = cut(X.rsi(f.c));
  CLX.charts.push(new Chart($('#clxRsi'), { data: { labels, datasets: [line('RSI(14)', rs, '#7c3aed', null, 1.5), flat('70', 70, dn, [3, 3], 1), flat('30', 30, up, [3, 3], 1)] }, options: { ...base, scales: { x: { display: false }, y: { ...base.scales.y, min: 0, max: 100, ticks: { color: txt, stepSize: 30 } } } } }));
  const mc = X.macd(f.c), Hh = cut(mc.h);
  CLX.charts.push(new Chart($('#clxMacd'), { data: { labels, datasets: [{ type: 'bar', label: '히스토그램', data: Hh, backgroundColor: Hh.map(x => x >= 0 ? up : dn), order: 2 }, line('MACD', cut(mc.m), col('--text')), line('시그널', cut(mc.g), '#e0a100')] }, options: { ...base, scales: { x: { display: false }, y: { ...base.scales.y, ticks: { color: txt, maxTicksLimit: 3 } } } } }));
  const st = X.stoch(f.h, f.l, f.c);
  CLX.charts.push(new Chart($('#clxSto'), { data: { labels, datasets: [line('%K', cut(st.k), '#0ea5e9', null, 1.4), line('%D', cut(st.d), '#f97316', null, 1.2), flat('80', 80, dn, [3, 3], 1), flat('20', 20, up, [3, 3], 1)] }, options: { ...base, scales: { x: { display: false }, y: { ...base.scales.y, min: 0, max: 100, ticks: { color: txt, stepSize: 40 } } } } }));
}

/* 지표 전체 — 쉬운 말 버전: 무엇을 재는지 · 지금 숫자가 무슨 뜻인지 · 네 묶음(방향·과열·돈 흐름·흔들림)으로 정리 */
function clxIndEasy(ind, price) {
  if (!ind) return '';
  const G = { dir: [], heat: [], money: [], move: [] };
  // tone: good(좋음) / bad(나쁨) / warn(주의) / ''(보통)
  const add = (g, name, term, val, now, what, tone = '') => G[g].push({ name, term, val, now, what, tone });
  const won0 = v => fmt(v) + '원';
  // ── 방향(추세) ──
  const mas = [5, 10, 20, 60, 120, 200].map(n => [n, ind['ma' + n]]).filter(x => x[1] != null);
  const vals = mas.map(x => x[1]);
  const full = vals.length >= 4 && vals.every((v, i) => !i || vals[i - 1] > v), rev = vals.length >= 4 && vals.every((v, i) => !i || vals[i - 1] < v);
  add('dir', '평균선 줄서기', '이동평균 배열', full ? '가지런함' : rev ? '거꾸로' : '뒤엉킴',
    full ? '짧은 기간 평균이 위, 긴 기간 평균이 아래로 차례대로 — 꾸준히 오르는 종목의 전형적인 모습이에요.' : rev ? '긴 기간 평균이 위에 있어요 — 꾸준히 내려온 종목의 모습이에요.' : '평균선들이 서로 엉켜 있어요 — 오를지 내릴지 아직 방향을 정하는 중이에요.',
    '여러 기간의 평균 가격을 위아래로 비교한 것. 짧은 것부터 위로 줄서 있으면 오름세예요.', full ? 'good' : rev ? 'bad' : '');
  if (mas.length) {
    const above = mas.filter(([, v]) => price >= v).length;
    const nm = { 5: '1주', 10: '2주', 20: '1달', 60: '3달', 120: '6달', 200: '10달' };
    add('dir', '평균 가격선 위·아래', '5·10·20·60·120·200일선', `${mas.length}개 중 ${above}개 위`,
      (above === mas.length ? '지금 가격이 모든 평균선 위 — 최근 1주부터 10달 사이에 산 사람 대부분이 이익인 상태라 분위기가 좋아요.' : above === 0 ? '지금 가격이 모든 평균선 아래 — 최근에 산 사람 대부분이 손해라 반등 때마다 팔려는 물량이 나와요.' : `짧은 기간 선 ${mas.filter(([n, v]) => n <= 20 && price >= v).length}개 · 긴 기간 선 ${mas.filter(([n, v]) => n > 20 && price >= v).length}개 위에 있어요.`)
      + '<span class="ez-ma">' + mas.map(([n, v]) => `<i class="${price >= v ? 'up' : 'down'}">${nm[n]} ${fmt(v)} (${clxPct(price, v)})</i>`).join('') + '</span>',
      'N일선 = 최근 N일 동안의 평균 가격. 가격이 선 위에 있으면 그 기간에 산 사람들이 대체로 이익이에요. 20일선(1달)은 단기 분위기, 120·200일선은 장기 흐름의 기준선이에요.', above >= mas.length - 1 ? 'good' : above <= 1 ? 'bad' : '');
  }
  if (ind.ema9 != null) { const up = ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50, dn = ind.ema9 < ind.ema21;
    add('dir', '최근 가격에 무게 둔 평균선', 'EMA 9·21·50', up ? '오름 순서' : dn ? '내림 순서' : '섞임', up ? '가장 빠른 선이 맨 위 — 최근 며칠 흐름이 오름세예요.' : dn ? '빠른 선이 아래로 내려왔어요 — 최근 며칠 흐름이 약해졌어요.' : '선들이 섞여 있어요 — 단기 방향이 애매해요.', '최근 날짜의 가격을 더 중요하게 계산한 평균선이라 보통 평균선보다 빨리 반응해요.', up ? 'good' : dn ? 'bad' : ''); }
  if (ind.hull21 != null) add('dir', '가장 빨리 반응하는 평균선', 'Hull 이동평균(21)', price > ind.hull21 ? '가격이 위' : '가격이 아래', price > ind.hull21 ? `가격(${won0(price)})이 이 선(${won0(ind.hull21)}) 위 — 방향 전환을 가장 먼저 잡는 선 기준으로 상승 쪽이에요.` : `가격이 이 선(${won0(ind.hull21)}) 아래로 내려갔어요 — 단기 약세로 바뀌는 첫 신호일 수 있어요.`, '흔들림을 줄이면서도 늦지 않게 만든 평균선. 방향이 바뀌는 순간을 빨리 보여 줘요.', price > ind.hull21 ? 'good' : 'bad');
  if (ind.adx14 != null) { const trend = ind.adx14 > 25, flat = ind.adx14 < 20, upw = ind.pdi > ind.mdi;
    add('dir', '추세의 세기 · 오르는 힘 vs 내리는 힘', 'ADX(14) · DMI', `세기 ${fmt(ind.adx14, 0)} · ${fmt(ind.pdi, 0)} 대 ${fmt(ind.mdi, 0)}`,
      `${trend ? '뚜렷한 추세가 있어요(25 이상) — 가는 방향을 따라가는 매매가 잘 맞는 때예요.' : flat ? '추세가 약해요(20 미만) — 일정 범위에서 오르내리는 박스권일 가능성이 커요. 바닥에서 사고 위에서 파는 방식이 맞는 때예요.' : '추세가 막 생기는 중이에요(20~25).'} 오르려는 힘 ${fmt(ind.pdi, 0)} 대 내리려는 힘 ${fmt(ind.mdi, 0)}으로 ${upw ? '오르는 쪽이 우세' : '내리는 쪽이 우세'}해요.`,
      'ADX는 방향과 상관없이 "추세가 얼마나 강한지"(0~100), +DI·−DI는 각각 오르려는 힘과 내리려는 힘이에요.', trend && upw ? 'good' : trend ? 'bad' : ''); }
  // ── 과열·침체 ──
  if (ind.rsi14 != null) { const r = ind.rsi14;
    add('heat', '과열 온도계', 'RSI(14)', `${fmt(r, 0)}도`, r >= 70 ? `70을 넘어 과열 구간이에요 — 최근 2~3주 동안 오른 날이 내린 날보다 훨씬 많았다는 뜻. 쉬어 갈 수 있지만, 아주 강한 종목은 80 근처까지 버티기도 해요.` : r <= 30 ? '30 아래 침체 구간 — 많이 떨어져 반등이 나올 수 있는 자리예요.' : r >= 50 ? '50~70 — 오르는 힘이 조금 더 센 건강한 구간이에요.' : '30~50 — 내리는 힘이 조금 더 센 구간이에요.',
      '최근 14일 동안 오른 폭과 내린 폭을 비교해 0~100으로 만든 숫자. 70 이상은 과열, 30 이하는 침체.', r >= 70 ? 'warn' : r <= 30 ? 'good' : r >= 50 ? 'good' : 'bad'); }
  if (ind.rsi2 != null) add('heat', '초단기 과열 온도계', 'RSI(2)', `${fmt(ind.rsi2, 0)}도`, ind.rsi2 >= 90 ? '최근 2~3일 동안 거의 쉬지 않고 올랐어요 — 하루 이틀 숨 고르기가 나오기 쉬워요.' : ind.rsi2 <= 10 ? '최근 2~3일 급하게 떨어졌어요 — 짧은 반등이 나오기 쉬운 자리예요.' : '보통이에요.', '위 온도계를 2일짜리로 만든 것. 며칠 단위 단타 타이밍을 볼 때 써요.', ind.rsi2 >= 90 ? 'warn' : ind.rsi2 <= 10 ? 'good' : '');
  if (ind.stoch_k != null) add('heat', '최근 2주 가격 범위 중 위치', '스토캐스틱 14·3·3', `위에서 ${fmt(100 - ind.stoch_k, 0)}% 아래`,
    `최근 2주 최저가를 0, 최고가를 100으로 봤을 때 지금 가격은 ${fmt(ind.stoch_k, 0)} 지점이에요(3일 평균 ${fmt(ind.stoch_d, 0)}). ` + (ind.stoch_k < 20 && ind.stoch_k > ind.stoch_d ? '바닥 근처에서 고개를 드는 중 — 매수 타이밍 신호예요.' : ind.stoch_k > 80 && ind.stoch_k < ind.stoch_d ? '꼭대기 근처에서 꺾이는 중 — 매도 타이밍 신호예요.' : ind.stoch_k > 80 ? '꼭대기 근처예요.' : ind.stoch_k < 20 ? '바닥 근처예요.' : '중간쯤이에요.'),
    '최근 14일 가격 범위 안에서 지금 가격이 어디쯤인지(0~100). 20 아래에서 오르면 매수, 80 위에서 꺾이면 매도 신호로 봐요.', ind.stoch_k < 20 && ind.stoch_k > ind.stoch_d ? 'good' : ind.stoch_k > 80 && ind.stoch_k < ind.stoch_d ? 'bad' : '');
  if (ind.bb_pctb != null) { const b = ind.bb_pctb;
    add('heat', '평소 움직임 범위를 벗어났나', '볼린저밴드 %B · 폭', b > 1 ? '범위 위로 넘음' : b < 0 ? '범위 아래로 이탈' : `범위 안 ${fmt(b * 100, 0)}% 높이`,
      (b > 1 ? `평소 움직이는 범위의 위쪽 끝을 넘어섰어요(${fmt(b * 100, 0)}%) — 힘이 강하다는 뜻이지만 단기 과열이기도 해요. 다시 범위 안으로 들어오면 쉬어 가는 신호.` : b < 0 ? '평소 범위 아래로 떨어졌어요 — 많이 밀린 상태예요.' : `평소 범위 안에서 ${b >= 0.8 ? '위쪽' : b <= 0.2 ? '아래쪽' : '가운데쯤'}에 있어요.`)
      + ` 범위의 폭은 ${fmt(ind.bb_bw, 1)}%로 최근 6개월 중 ${ind.bb_bw_rank <= 15 ? '가장 좁은 편 — 크게 움직이기 직전의 응축 상태일 수 있어요.' : `하위 ${fmt(ind.bb_bw_rank, 0)}% 수준이에요.`}`,
      '최근 20일 평균 ± 흔들림의 2배로 "보통 움직이는 범위"를 그린 것. 0%=아래 끝, 100%=위 끝.', b > 1 ? 'warn' : b < 0 ? 'bad' : ind.bb_bw_rank <= 15 ? 'good' : ''); }
  if (ind.squeeze != null) add('heat', '폭발 전 응축 상태', '스퀴즈', ind.squeeze ? '응축 중' : '아님', ind.squeeze ? `최근 20일 중 ${ind.squeeze_days}일 동안 가격 움직임이 유난히 좁아요 — 곧 한쪽으로 크게 움직일 수 있으니 터지는 방향을 지켜보세요.` : '지금은 에너지를 모으는 상태가 아니에요(이미 움직이고 있거나 평범한 상태).', '움직임이 아주 좁아지는 구간. 이런 구간 뒤에는 큰 움직임이 나오는 경우가 많아요.', ind.squeeze ? 'good' : '');
  if (ind.cci20 != null) add('heat', '평균에서 얼마나 멀리 갔나', 'CCI(20) · Williams %R', `${fmt(ind.cci20, 0)} · ${fmt(ind.willr14, 0)}`,
    (ind.cci20 > 200 ? '평균보다 아주 멀리 위로 올라갔어요 — 상승 힘은 강하지만 되돌림도 클 수 있어요.' : ind.cci20 > 100 ? '평균보다 꽤 위 — 오르는 탄력이 붙어 있어요.' : ind.cci20 < -100 ? '평균보다 꽤 아래 — 내리는 탄력이 붙어 있어요.' : '평균 근처예요.') + ` 최근 2주 최고가 대비로는 ${ind.willr14 >= -20 ? '꼭대기 근처' : ind.willr14 <= -80 ? '바닥 근처' : '중간쯤'}이에요.`,
    'CCI: 20일 평균 가격에서 얼마나 떨어졌는지(±100 넘으면 강함). Williams %R: 최근 2주 최고가 0, 최저가 −100.', ind.cci20 > 200 ? 'warn' : ind.cci20 > 100 ? 'good' : ind.cci20 < -100 ? 'bad' : '');
  // ── 돈의 흐름 ──
  if (ind.macd_hist != null) add('money', '오르는 힘 측정기', 'MACD', ind.macd_hist > 0 ? '오르는 힘 우세' : '내리는 힘 우세', `${ind.macd_hist > 0 ? '짧은 평균이 긴 평균보다 빠르게 벌어지는 중 — 오르는 힘이 더 커요.' : '짧은 평균이 긴 평균 아래로 — 내리는 힘이 더 커요.'} ${ind.macd > 0 ? '큰 흐름도 상승 쪽으로 넘어와 있어요.' : '큰 흐름은 아직 하락 쪽이에요.'}`, '짧은 평균선과 긴 평균선의 차이. 0 위면 오름세의 힘이 살아 있다는 뜻이에요.', ind.macd_hist > 0 ? 'good' : 'bad');
  if (ind.cmf20 != null) add('money', '돈이 들어오나 나가나', 'CMF(20)', ind.cmf20 > 0.05 ? '들어옴' : ind.cmf20 < -0.05 ? '나감' : '비슷', ind.cmf20 > 0.05 ? `최근 20일 동안 그날 높은 가격 쪽에서 끝나는 날이 많았어요(${fmt(ind.cmf20, 2)}) — 사려는 돈이 들어오는 중이에요.` : ind.cmf20 < -0.05 ? '최근 20일 동안 낮은 가격 쪽에서 끝나는 날이 많았어요 — 돈이 빠져나가는 중이에요.' : '들어오고 나가는 돈이 비슷해요.', '하루 중 어디서 끝났는지(고가 쪽/저가 쪽)에 거래량을 곱해 20일간 더한 것. 0보다 크면 매수세.', ind.cmf20 > 0.05 ? 'good' : ind.cmf20 < -0.05 ? 'bad' : '');
  if (ind.mfi14 != null) add('money', '거래량 실은 과열 온도계', 'MFI(14)', `${fmt(ind.mfi14, 0)}도`, ind.mfi14 >= 80 ? '돈이 몰리며 과열됐어요 — 추격 매수 조심.' : ind.mfi14 <= 20 ? '돈이 빠지며 침체됐어요 — 반등 후보.' : ind.mfi14 >= 60 ? '돈이 꽤 들어와 있지만 과열은 아니에요.' : '보통이에요.', '과열 온도계(RSI)에 거래량을 더한 것. 80 이상 과열, 20 이하 침체.', ind.mfi14 >= 80 ? 'warn' : ind.mfi14 <= 20 ? 'good' : '');
  if (ind.obv_up20 != null) add('money', '거래량 누적 방향', 'OBV(20일)', ind.obv_up20 ? '늘어남' : '줄어듦', ind.obv_up20 ? '최근 20일 동안 오른 날 거래가 내린 날보다 많았어요 — 누군가 사 모으는 쪽이에요.' : '최근 20일 동안 내린 날 거래가 더 많았어요 — 팔고 나가는 쪽이에요.', '오른 날 거래량은 더하고 내린 날 거래량은 빼서 쌓은 값. 늘어나면 매집, 줄어들면 이탈.', ind.obv_up20 ? 'good' : 'bad');
  if (ind.vol_ratio != null) add('money', '오늘 거래량 / 평소', '거래량 배수', fmt(ind.vol_ratio, 1) + '배', ind.vol_ratio >= 3 ? `평소의 ${fmt(ind.vol_ratio, 1)}배 — 큰 관심이 몰렸어요. 오르면서 터진 거래량이면 진짜 힘, 제자리에서 터지면 누군가 넘기는 중일 수 있어요.` : ind.vol_ratio >= 1.5 ? '평소보다 많아요 — 지금 움직임(오름/내림)이 진짜인지 확인해 주는 신호예요.' : ind.vol_ratio <= 0.6 ? '평소보다 한산해요 — 관심이 줄었거나 큰 움직임 전 조용한 상태.' : '평소 수준이에요.', '오늘 거래량을 최근 20일 평균과 비교한 배수.', ind.vol_ratio >= 1.5 ? 'good' : '');
  // ── 흔들림·속도 ──
  if (ind.atr_pct != null) add('move', '하루 평균 흔들림 폭', 'ATR(14)', `약 ${fmt(ind.atr14)}원 (${fmt(ind.atr_pct, 1)}%)`, `이 종목은 하루에 보통 ${fmt(ind.atr14)}원(${fmt(ind.atr_pct, 1)}%) 정도 오르내려요. 손절선은 이 폭의 1.5~2.5배(${fmt(ind.atr14 * 1.5)}~${fmt(ind.atr14 * 2.5)}원) 아래에 두면 평범한 흔들림에 털리지 않아요.`, '최근 14일 동안 하루 고가~저가 폭의 평균. 손절 폭과 매수 수량을 정할 때 써요.', ind.atr_pct >= 6 ? 'warn' : '');
  if (ind.roc10 != null) add('move', '최근 2주 상승률 · 1년 기준 흔들림', 'ROC(10) · 역사적 변동성', `${pct(ind.roc10, 1)} · ${fmt(ind.hv20, 0)}%`, `최근 10거래일 동안 ${ind.roc10 >= 0 ? fmt(ind.roc10, 1) + '% 올랐어요' : fmt(-ind.roc10, 1) + '% 내렸어요'}. 최근 흔들림을 1년으로 환산하면 ${fmt(ind.hv20, 0)}% — ${ind.hv20 >= 50 ? '아주 크게 흔들리는 종목이라 비중을 작게.' : ind.hv20 >= 30 ? '꽤 흔들리는 편이에요.' : '비교적 차분한 편이에요.'}`, 'ROC: 10일 전 대비 몇 % 변했나. 변동성: 최근 20일 흔들림을 1년 기준으로 바꾼 값(대형주 20~30%가 보통).', ind.hv20 >= 50 ? 'warn' : '');

  // ── 한눈에 요약 ──
  const score = arr => arr.reduce((a, x) => a + (x.tone === 'good' ? 1 : x.tone === 'bad' ? -1 : 0), 0);
  const warnN = G.heat.filter(x => x.tone === 'warn').length + G.money.filter(x => x.tone === 'warn').length;
  const dS = score(G.dir), mS = score(G.money);
  const dirT = dS >= 2 ? '오름세' : dS <= -2 ? '내림세' : '방향 탐색 중';
  const monT = mS >= 2 ? '돈이 들어오는 중' : mS <= -2 ? '돈이 빠지는 중' : '돈 흐름은 엇갈림';
  const heatT = warnN >= 2 ? '단기 과열 신호 여러 개' : warnN === 1 ? '과열 신호 하나' : G.heat.some(x => x.tone === 'good' && /침체|바닥|응축/.test(x.now)) ? '쉬어 간 자리·응축' : '과열 아님';
  let say;
  if (dS >= 2 && mS >= 1 && warnN >= 2) say = '가격은 평균선 위에서 오르고 돈도 들어오고 있지만, 짧은 기간에 많이 올라 과열 신호가 여러 개 켜져 있어요. 새로 산다면 하루 이틀 쉬어 갈 때(눌림)를 기다리는 편이 안전하고, 이미 가지고 있다면 손절선을 올려 이익을 지키며 보유하는 자리예요.';
  else if (dS >= 2 && mS >= 1) say = '오름세이고 돈도 들어오는, 차트상 건강한 상태예요. 과열 신호도 크지 않아요. 손절선을 정해 두고 접근할 만한 자리예요.';
  else if (dS <= -2 && mS <= -1) say = '내림세이고 돈도 빠져나가는 중이에요. 반등을 기대하고 사기보다는 평균선 위로 다시 올라서는지 먼저 확인하세요.';
  else if (dS <= -2) say = '아직 내림세지만 돈 흐름은 나쁘지 않아요. 바닥을 다지는 중일 수 있으니 20일선(1달 평균) 위로 올라서는지 지켜보세요.';
  else if (dS >= 2) say = '방향은 오름세지만 돈 흐름이 약해요. 거래량이 붙는지 확인하고 들어가는 편이 좋아요.';
  else say = '평균선들이 엉켜 방향을 정하는 중이에요. 위나 아래로 거래량을 실어 벗어나는 쪽을 따라가는 게 무난해요.';
  const groups = [['dir', '① 방향 — 어느 쪽으로 가고 있나', dirT], ['heat', '② 과열·침체 — 너무 많이 오르거나 떨어졌나', heatT], ['money', '③ 돈의 흐름 — 사는 돈이 들어오나', monT], ['move', '④ 흔들림 — 하루에 얼마나 움직이나', '']];
  const card = x => `<div class="ez ${x.tone}"><div class="ez-h"><b>${x.name}</b><span class="mono">${x.val}</span></div><small class="ez-t">${x.term}</small><p>${x.now}</p><details><summary>이게 뭐예요?</summary>${x.what}</details></div>`;
  return `<div class="ez-sum"><b>한눈에 보기</b> <span class="tag ${dS >= 2 ? 'good' : dS <= -2 ? 'bad' : ''}">방향: ${dirT}</span><span class="tag ${warnN >= 2 ? 'warn' : ''}">과열: ${heatT}</span><span class="tag ${mS >= 2 ? 'good' : mS <= -2 ? 'bad' : ''}">돈: ${monT}</span><p>${say}</p></div>`
    + groups.filter(([g]) => G[g].length).map(([g, t, st]) => `<h5 class="ez-g">${t}${st ? ` <small>→ ${st}</small>` : ''}</h5><div class="clx-inds ez-grid">${G[g].map(card).join('')}</div>`).join('')
    + '<div class="hint mt-s">색 띠: 초록 = 좋은 신호 · 빨강 = 나쁜 신호 · 주황 = 주의(과열) · 회색 = 보통. 위쪽 "쉬운 말" 버튼을 끄면 전문가용 원래 표로 바뀌어요.</div>';
}

function clxIndHtml(ind, price) {
  if (!ind) return '';
  if (typeof easyOn === 'function' && easyOn()) return clxIndEasy(ind, price);
  const rows = [];
  const add = (k, v, t, cls = '') => rows.push(`<div class="clx-ind ${cls}"><span>${k}</span><b class="mono">${v}</b><em>${t}</em></div>`);
  const mas = [5, 10, 20, 60, 120, 200].map(n => [n, ind['ma' + n]]).filter(x => x[1] != null);
  const vals = mas.map(x => x[1]);
  const full = vals.length >= 4 && vals.every((v, i) => !i || vals[i - 1] > v), rev = vals.length >= 4 && vals.every((v, i) => !i || vals[i - 1] < v);
  add('이동평균 배열', full ? '정배열' : rev ? '역배열' : '혼조', full ? '5>10>20>60>120>200 — 강세장의 정의' : rev ? '모든 선이 거꾸로 — 약세장' : '선들이 엉켜 방향 탐색 중', full ? 'good' : rev ? 'bad' : '');
  mas.forEach(([n, v]) => add(`${n}일선`, fmt(v), `${price >= v ? '위' : '아래'} (${clxPct(price, v)}) · ${{ 5: '초단기', 10: '단기', 20: '단기 심리선', 60: '수급선', 120: '장기 생명선', 200: '장기 생명선' }[n]}`, price >= v ? 'good' : 'bad'));
  if (ind.ema9 != null) add('EMA 9·21·50', `${fmt(ind.ema9)} / ${fmt(ind.ema21)} / ${fmt(ind.ema50)}`, ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50 ? '빠른 선이 위 — 단기 상승 흐름' : ind.ema9 < ind.ema21 ? '빠른 선이 아래 — 단기 약세' : '혼조');
  if (ind.hull21 != null) add('Hull 이동평균(21)', fmt(ind.hull21), price > ind.hull21 ? '가격이 위 — 추세 전환을 가장 먼저 알려주는 선 기준 상승' : '가격이 아래 — 단기 약세 전환 신호', price > ind.hull21 ? 'good' : 'bad');
  if (ind.rsi14 != null) add('RSI(14)', fmt(ind.rsi14, 1), ind.rsi14 >= 70 ? '과열 — 강세장에선 80까지 버티기도 함' : ind.rsi14 <= 30 ? '과매도 — 반등 후보' : ind.rsi14 >= 50 ? '강세권(50~70)' : '약세권(30~50)', ind.rsi14 >= 70 || ind.rsi14 < 50 ? 'bad' : 'good');
  if (ind.rsi2 != null) add('RSI(2) 보조', fmt(ind.rsi2, 0), ind.rsi2 <= 10 ? '초단기 과매도 — 단타 반등 자리' : ind.rsi2 >= 90 ? '초단기 과열' : '보통');
  if (ind.macd_hist != null) add('MACD 히스토그램', fmt(ind.macd_hist, 1), `${ind.macd_hist > 0 ? '0 위(상승 쪽 힘)' : '0 아래(하락 쪽 힘)'} · MACD선 ${ind.macd > 0 ? '0선 위 = 추세 전환 확정' : '0선 아래'}`, ind.macd_hist > 0 ? 'good' : 'bad');
  if (ind.stoch_k != null) add('스토캐스틱 14·3·3', `${fmt(ind.stoch_k, 0)} / ${fmt(ind.stoch_d, 0)}`, ind.stoch_k < 20 && ind.stoch_k > ind.stoch_d ? '20 아래에서 %K가 %D 위로 — 매수 타이밍' : ind.stoch_k > 80 && ind.stoch_k < ind.stoch_d ? '80 위에서 꺾임 — 매도 타이밍' : ind.stoch_k > 80 ? '과열권' : ind.stoch_k < 20 ? '과매도권' : '중간', ind.stoch_k < 20 && ind.stoch_k > ind.stoch_d ? 'good' : ind.stoch_k > 80 && ind.stoch_k < ind.stoch_d ? 'bad' : '');
  if (ind.bb_pctb != null) add('볼린저 %B · 폭', `${fmt(ind.bb_pctb * 100, 0)}% · ${fmt(ind.bb_bw, 1)}%`, `${ind.bb_pctb > 1 ? '밴드 위로 뚫음(강한 힘/과열)' : ind.bb_pctb < 0 ? '밴드 아래로 이탈' : '밴드 안 ' + fmt(ind.bb_pctb * 100, 0) + '% 높이'} · 폭은 최근 6개월 하위 ${fmt(ind.bb_bw_rank, 0)}%${ind.bb_bw_rank != null && ind.bb_bw_rank <= 15 ? ' — 수축(스퀴즈) 후 확장 = 폭발 시작 대기' : ''}`, ind.bb_bw_rank != null && ind.bb_bw_rank <= 15 ? 'good' : '');
  if (ind.squeeze != null) add('스퀴즈(볼린저⊂켈트너)', ind.squeeze ? '켜짐' : '꺼짐', ind.squeeze ? `에너지 응축 중(최근 20일 중 ${ind.squeeze_days}일) — 터지는 방향 주목` : '응축 상태 아님');
  if (ind.adx14 != null) add('ADX(14) · DMI', `${fmt(ind.adx14, 0)} · +DI ${fmt(ind.pdi, 0)} / −DI ${fmt(ind.mdi, 0)}`, `${ind.adx14 > 25 ? '추세 존재 — 추세 추종 유효' : ind.adx14 < 20 ? '횡보 — 역추세(박스 매매) 유효' : '추세 형성 중'} · ${ind.pdi > ind.mdi ? '상승 쪽 우세' : '하락 쪽 우세'}`, ind.adx14 > 25 && ind.pdi > ind.mdi ? 'good' : ind.adx14 > 25 ? 'bad' : '');
  if (ind.cmf20 != null) add('CMF(20) 자금흐름', fmt(ind.cmf20, 3), ind.cmf20 > 0.05 ? '자금 유입 — 고가 쪽 마감' : ind.cmf20 < -0.05 ? '자금 유출 — 저가 쪽 마감' : '중립', ind.cmf20 > 0.05 ? 'good' : ind.cmf20 < -0.05 ? 'bad' : '');
  if (ind.mfi14 != null) add('MFI(14)', fmt(ind.mfi14, 0), ind.mfi14 >= 80 ? '거래량 실린 과열' : ind.mfi14 <= 20 ? '거래량 실린 과매도' : '보통');
  if (ind.obv_up20 != null) add('OBV 20일', ind.obv_up20 ? '상승' : '하락', ind.obv_up20 ? '거래량 누적이 늘어남 — 매집 쪽' : '거래량 누적이 줄어듦 — 분산 쪽', ind.obv_up20 ? 'good' : 'bad');
  if (ind.vol_ratio != null) add('거래량 배수', fmt(ind.vol_ratio, 2) + '배', ind.vol_ratio >= 1.5 ? '20일 평균의 1.5배↑ — 방향 확인 신호' : ind.vol_ratio <= 0.6 ? '거래 위축 — 관심 감소·에너지 응축' : '보통');
  if (ind.atr_pct != null) add('ATR(14) 변동성', `${fmt(ind.atr14)} (${fmt(ind.atr_pct, 2)}%)`, `하루 평균 흔들림. 손절은 ATR의 1.5~2.5배(${fmt(ind.atr14 * 1.5)}~${fmt(ind.atr14 * 2.5)}원)`);
  if (ind.cci20 != null) add('CCI(20) · Williams %R', `${fmt(ind.cci20, 0)} · ${fmt(ind.willr14, 0)}`, ind.cci20 > 100 ? '강한 상승 탄력' : ind.cci20 < -100 ? '강한 하락 탄력' : '보통');
  if (ind.roc10 != null) add('ROC(10) · 연 변동성', `${pct(ind.roc10, 1)} · ${fmt(ind.hv20, 0)}%`, '10일 수익률 · 20일 역사적 변동성(연율)');
  return `<div class="clx-inds">${rows.join('')}</div>`;
}

function clxCardHtml(s, f) {
  const cl = s.cl;
  if (!cl) return '<div class="hint">아직 차트 종합 판정 자료가 없어요. (다음 자동 수집부터 계산돼요)</div>';
  const r = f ? f.r : null;
  const sc = cl.s, vc = clxVcls(sc), pos = (sc + 100) / 2;
  const ax = r ? CLX_AX.map(([k, l, w]) => [k, l, w, r.axes[k], (r.axis_notes[k] || [])]) : CLX_AX.map(([k, l, w], i) => [k, l, w, cl.ax[i], []]);
  const idx = S.data.cl_index || {};
  const plan = r ? r.plan : { entry: s.close, stop: cl.stop, target1: cl.t1, target2: cl.t2, risk_reward: cl.rr, position_size_pct: cl.pos };
  const amt = S.capital * (plan.position_size_pct || 0) / 100, qty = plan.entry ? Math.floor(amt / plan.entry) : 0;
  const ckl = r ? r.checklist : null;
  return `
  <div class="clx-top">
    <div class="clx-score ${vc}"><small>종합 점수 (−100 ~ +100)</small><b>${sc > 0 ? '+' : ''}${fmt(sc, 1)}</b><span>${esc(cl.v)}</span>
      <div class="clx-gauge"><i style="left:${pos}%"></i></div><div class="clx-gl"><span>강력 매도</span><span>중립</span><span>강력 매수</span></div></div>
    <div class="clx-act">
      <small>행동 지침</small><b>${esc(r ? r.action2 : '')}</b>
      <div class="clx-meta">주봉 점수 <b class="${cls(cl.w)}">${cl.w != null ? (cl.w > 0 ? '+' : '') + fmt(cl.w, 1) : '–'}</b> · 변동성(ATR) ${fmt(cl.atrp, 2)}% ${Object.entries(idx).map(([k, v]) => ` · ${k} 지수 <b class="${cls(v.s)}">${v.s > 0 ? '+' : ''}${fmt(v.s, 1)}</b>(${esc(v.v)})`).join('')}</div>
      ${Object.values(idx).some(v => v.s <= -28) ? '<div class="clx-warn">⚠ 시장 지수가 약세 판정 — 개별 종목 매수 신호의 신뢰도가 떨어져요 (가이드 11-③)</div>' : ''}
    </div>
  </div>
  <h4 class="mt">6축 점수 <small class="muted">각 축 −1 ~ +1 × 가중치 = 종합 점수</small></h4>
  <div class="clx-axes">${ax.map(([k, l, w, v, notes]) => `<div class="clx-ax"><span class="l">${l} <small>${w}%</small></span>
    <div class="clx-bar"><i class="${v >= 0 ? 'p' : 'm'}" style="${v >= 0 ? `left:50%;width:${v * 50}%` : `right:50%;width:${-v * 50}%`}"></i><em></em></div>
    <b class="mono ${cls(v)}">${v > 0 ? '+' : ''}${fmt(v, 2)}</b><p>${notes.map(esc).join(' · ')}</p></div>`).join('')}</div>
  <h4 class="mt">매매 계획 ${plan.risk_reward < 1.5 ? '<span class="tag bad">손익비 1.5 미만 — 진입 보류</span>' : '<span class="tag good">손익비 충족</span>'}</h4>
  <div class="cl-plan clx-plan">
    <div><small>진입가</small><b>${clxWon(plan.entry)}</b><span class="hint">분할: 현재가~지지</span></div>
    <div><small>손절가</small><b class="down">${clxWon(plan.stop)}</b><span class="hint">${clxPct(plan.stop, plan.entry)}</span></div>
    <div><small>목표가 1</small><b class="up">${clxWon(plan.target1)}</b><span class="hint">${clxPct(plan.target1, plan.entry)}</span></div>
    <div><small>목표가 2</small><b class="up">${clxWon(plan.target2)}</b><span class="hint">${clxPct(plan.target2, plan.entry)}</span></div>
    <div><small>손익비</small><b>${fmt(plan.risk_reward, 2)} : 1</b><span class="hint">1.5 이상만 진입</span></div>
    <div><small>권장 비중 (계좌 1% 위험)</small><b>${fmt(plan.position_size_pct, 1)}%</b><span class="hint">${won(amt)} · 약 ${fmt(qty)}주</span></div>
  </div>
  ${r && r.invalidation ? `<div class="clx-inv">${r.invalidation.map(x => `<div>✕ ${esc(x)}</div>`).join('')}</div>` : ''}
  ${ckl ? `<h4 class="mt">진입 전 5초 체크리스트 <span class="tag ${r.check_pass ? 'good' : 'bad'}">${r.check_pass ? '통과' : '미통과'} · ${r.check_yes}/6</span></h4>
  <div class="clx-ck">${ckl.map(c => `<div class="${c.ok ? 'ok' : 'no'}"><span>${c.ok ? '✓' : '✗'}</span>${esc(c.q)} ${c.req ? '<small class="tag">필수</small>' : ''}</div>`).join('')}</div>
  <div class="hint">통과 조건: 필수 3개 모두 YES + 전체 6개 중 4개 이상 YES</div>` : ''}
  ${r && r.warnings && r.warnings.length ? `<h4 class="mt">실전 10계명 경고</h4><div class="clx-warns">${r.warnings.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
  ${f ? `<div class="row gap wrap cl-rng"><span class="lbl">기간</span>${[[60, '3개월'], [120, '6개월'], [250, '1년'], [400, '전체']].map(([d, t]) => `<button class="chip ${d === CLX.range ? 'on' : ''}" data-clxr="${d}">${t}</button>`).join('')}
    <span class="hint">봉(빨강 오름·파랑 내림) · 5/20/60/120/200일선 · 볼린저밴드 · 빨강 점선=저항 · 초록 점선=지지(굵을수록 강함) · 주황=넥라인 · 보라=패턴 목표가 · 파랑 굵은 점선=손절가 · ▲▼=캔들 패턴</span></div>
  <div class="cl-box" style="height:380px"><canvas id="clxPrice"></canvas></div>
  <div class="cl-sub">거래량 (점선 = 20일 평균)</div><div class="cl-box" style="height:80px"><canvas id="clxVol"></canvas></div>
  <div class="cl-sub">RSI(14) — 강세장 40~80, 약세장 20~60이 실제 작동 구간</div><div class="cl-box" style="height:80px"><canvas id="clxRsi"></canvas></div>
  <div class="cl-sub">MACD 12·26·9 — 히스토그램 확대·축소가 핵심, 0선 돌파 = 추세 전환</div><div class="cl-box" style="height:85px"><canvas id="clxMacd"></canvas></div>
  <div class="cl-sub">스토캐스틱 14·3·3 — 20 아래 %K>%D = 매수 타이밍</div><div class="cl-box" style="height:75px"><canvas id="clxSto"></canvas></div>` : '<div class="hint mt">차트 파일을 불러오는 중이거나 아직 없어요.</div>'}
  ${r ? `<div class="clx-grid mt">
    <div><h4>구조(차트) 패턴</h4>${(r.chart_patterns || []).length ? r.chart_patterns.map(p => `<div class="clx-pat ${p.direction > 0 ? 'good' : p.direction < 0 ? 'bad' : ''}">
      <b>${p.direction > 0 ? '▲' : p.direction < 0 ? '▼' : '◆'} ${esc((CLX_PAT[p.key] || [p.name])[0])}</b> ${p.confirmed === true ? '<span class="tag good">돌파 확인</span>' : p.confirmed === false ? '<span class="tag">확인 전(반영 절반)</span>' : ''}
      <p>${esc(p.desc)}</p>${p.target ? `<p class="mono">${p.neckline ? `넥라인 ${clxWon(p.neckline)} · ` : ''}측정 목표가 <b>${clxWon(p.target)}</b> (${clxPct(p.target, r.price)})</p>` : ''}
      <small class="muted">${esc((CLX_PAT[p.key] || ['', ''])[1])}</small></div>`).join('') : '<div class="hint">탐지된 구조 패턴이 없어요.</div>'}</div>
    <div><h4>캔들 패턴 (최근 5봉)</h4>${(r.candle_patterns || []).length ? r.candle_patterns.map(h => `<div class="clx-cnd ${h.direction > 0 ? 'good' : h.direction < 0 ? 'bad' : ''}"><b>${h.direction > 0 ? '▲' : h.direction < 0 ? '▼' : '◆'} ${esc(h.name)}</b> <span class="gov-imp">${'★'.repeat(h.weight)}${'☆'.repeat(3 - h.weight)}</span> <small>${h.bars_ago ? h.bars_ago + '봉 전' : '오늘'} · 반영 ${fmt(Math.pow(0.6, h.bars_ago) * 100, 0)}%</small><p>${esc(CLX_CND[h.key] || '')}</p></div>`).join('') : '<div class="hint">최근 5봉에 캔들 패턴이 없어요.</div>'}
      <div class="hint">캔들 패턴은 신뢰도(★) × 시간 감쇠(0.6^경과봉)로 반영 — 추세 끝·지지/저항·거래량과 겹칠 때만 강해요.</div></div>
    <div><h4>지지·저항 (터치 수 × 최근성)</h4>
      ${(r.resistance || []).slice(0, 4).reverse().map(x => `<div class="clx-lv r"><span>저항</span><b class="mono">${clxWon(x.price)}</b><small>${clxPct(x.price, r.price)} · ${x.touches}번 터치</small><i style="width:${Math.min(100, x.strength * 25)}%"></i></div>`).join('')}
      <div class="clx-lv now"><span>현재가</span><b class="mono">${clxWon(r.price)}</b></div>
      ${(r.support || []).slice(0, 4).map(x => `<div class="clx-lv s"><span>지지</span><b class="mono">${clxWon(x.price)}</b><small>${clxPct(x.price, r.price)} · ${x.touches}번 터치</small><i style="width:${Math.min(100, x.strength * 25)}%"></i></div>`).join('')}
      <div class="hint">현재가가 저항 2% 이내면 구조 점수 감점 — "좋은 종목도 벽 앞에선 쉬어간다"</div></div>
  </div>
  <h4 class="mt">${typeof easyOn === 'function' && easyOn() ? '지표 전체 — 쉬운 설명' : '지표 전체 (전문가 표준 설정)'}</h4>${clxIndHtml(r.ind, r.price)}` : ''}
  <div class="hint mt">※ 6축 엔진은 현재 상태의 확률적 우위를 숫자로 바꾼 것이며 미래를 맞히지 않아요. 공시·유상증자 같은 돌발 악재는 차트에 미리 반영되지 않아요. 계산 기준일 ${esc(r ? r.last_date : S.data.meta.asof)} · 일봉 ${r ? r.bars : '–'}개.</div>`;
}

async function renderClx(s, mountId) {
  const box = $('#' + mountId); if (!box) return;
  box.innerHTML = clxCardHtml(s, null) ;
  if (!s.cl) return;
  const f = await clxLoad(s.code);
  if ($('#' + mountId) !== box || box.dataset.code !== s.code) return;  // 그 사이 다른 종목으로 바뀜
  box.innerHTML = clxCardHtml(s, f);
  if (f) {
    clxDraw(f, CLX.range);
    $$('[data-clxr]', box).forEach(b => b.onclick = () => { CLX.range = +b.dataset.clxr; $$('[data-clxr]', box).forEach(x => x.classList.toggle('on', x === b)); clxDraw(f, CLX.range); });
  }
}

/* ── 차트 종합판정 탭 (전 종목) ── */
function renderClxTab() {
  const box = $('#clxList'); if (!box || !S.data) return;
  const idx = S.data.cl_index || {};
  $('#clxIdx').innerHTML = Object.keys(idx).length ? Object.entries(idx).map(([k, v]) => `<div class="clx-idx ${clxVcls(v.s)}"><small>${k} 지수</small><b>${v.s > 0 ? '+' : ''}${fmt(v.s, 1)}</b><span>${esc(v.v)}</span><em>${esc(v.verdict_action || '')}</em></div>`).join('') + '<div class="hint">지수가 장기선 위 정배열이면 개별 종목 매수 신호의 신뢰도가 올라가고, 지수가 무너지면 개별 신호는 힘을 잃어요.</div>' : '<div class="hint">지수 판정은 다음 수집부터 표시돼요.</div>';
  const vf = $('#clxV').value, pf = $('#clxP').value, mk = $('#clxM').value, sort = $('#clxSort').value;
  const ck = $('#clxCk').checked, rr = $('#clxRR').checked, wk = $('#clxW').checked, nw = $('#clxNW').checked, td = $('#clxTd') && $('#clxTd').checked;
  const B = CLX.base || {}, dlt = s => B[s.code] ? s.cl.s - B[s.code].s : 0;
  let rows = S.data.stocks.filter(s => s.cl);
  const total = rows.length;
  // 종목 검색: 검색어가 있으면 아래 필터와 관계없이 이름·코드로 찾음
  const q = $('#clxQ') ? $('#clxQ').value.trim() : '';
  if (q) {
    const hits = typeof findStocks === 'function' ? findStocks(q).filter(s => s.cl) : rows.filter(s => s.name.includes(q) || s.code.includes(q));
    clxRenderOne(hits.length === 1 ? hits[0] : null, q, hits.length);
    rows = hits;
  } else clxRenderOne(null, '', 0);
  if (!q && mk !== 'all') rows = rows.filter(s => s.market === mk);
  if (!q) {
  if (vf === 'buy') rows = rows.filter(s => s.cl.s >= 8); else if (vf === 'sell') rows = rows.filter(s => s.cl.s <= -8); else if (vf) rows = rows.filter(s => s.cl.v === vf);
  if (pf) rows = rows.filter(s => (s.cl.pat || []).some(p => p.replace(/[+\-=!]/g, '') === pf) || (s.cl.cnd || []).some(c => c.slice(1) === pf));
  if (ck) rows = rows.filter(s => s.cl.ckp);
  if (rr) rows = rows.filter(s => s.cl.rr >= 1.5);
  if (wk) rows = rows.filter(s => (s.cl.w || 0) > 0 && s.cl.ax[0] > 0);
  if (nw) rows = rows.filter(s => !s.cl.nw);
  if (td) rows = rows.filter(s => B[s.code] && B[s.code].v !== s.cl.v);
  }
  const key = { score: s => s.cl.s, rr: s => s.cl.rr, ck: s => s.cl.ck * 100 + s.cl.s, week: s => s.cl.w || -999, low: s => -s.cl.s, up: s => dlt(s), dn: s => -dlt(s) }[sort] || (s => s.cl.s);
  rows.sort((a, b) => key(b) - key(a));
  const nf = Object.keys(CLX.flash || {}).length;
  $('#clxMeta').textContent = (q ? `"${q}" 검색 결과 ${rows.length}종목 (검색 중에는 아래 필터를 적용하지 않아요)` : `조건에 맞는 ${rows.length}종목 / 판정 완료 ${total}종목`) +
    (CLX.live ? ` · 「오늘 변화」는 ${CLX.baseAsof || ''} 종가 판정 대비 점수 변화` + (nf ? ` · 노란 줄 = 방금(${CLX.live.meta.time.slice(11)}) 점수가 바뀐 ${nf}종목` : '') : '');
  const patName = p => { const k = p.replace(/[+\-=!]/g, ''); return `<span class="tag ${p[0] === '+' ? 'good' : p[0] === '-' ? 'bad' : ''}">${esc((CLX_PAT[k] || [k])[0])}${p.endsWith('!') ? ' ✓' : ''}</span>`; };
  box.innerHTML = rows.length ? `<table class="clx-tb"><thead><tr><th>종목</th><th>현재가</th><th>종합 점수</th><th title="${esc(CLX.baseAsof || '')} 종가 기준 판정과 비교">오늘 변화</th><th>판정</th><th title="추세·모멘텀·거래량·구조·패턴·주봉">6축</th><th>패턴</th><th>손익비</th><th>체크</th><th>권장 비중</th></tr></thead><tbody>${rows.slice(0, 150).map(s => {
    const c = s.cl;
    const chx = CLX.chg && CLX.chg[s.code];
    const b0 = B[s.code], d0 = b0 ? c.s - b0.s : null, fl = CLX.flash && CLX.flash[s.code];
    const dCell = d0 == null || !CLX.live ? '<span class="muted">-</span>' : `<b class="mono ${Math.abs(d0) < 0.05 ? 'muted' : cls(d0)}">${Math.abs(d0) < 0.05 ? '0' : (d0 > 0 ? '▲' : '▼') + fmt(Math.abs(d0), 1)}</b>${b0.v !== c.v ? `<br><small class="muted">아침 ${esc(b0.v)}</small>` : ''}`;
    return `<tr data-an="${esc(s.code)}" class="${chx ? 'clx-chg' : ''}${fl ? ' clx-flash' : ''}"><td>${chx ? `<span class="tag ${chx.up ? 'good' : 'bad'}" title="${esc(chx.from)} → ${esc(chx.to)}">${chx.up ? '▲' : '▼'} 변화</span> ` : ''}<b>${esc(s.name)}</b> <small class="muted">${s.market === 'KOSPI' ? '코스피' : '코스닥'}</small></td>
      <td class="mono">${s._live ? `${fmt(s._live.c)} <small class="${cls(s._live.chg)}">${pct(s._live.chg, 1)}</small>` : `${fmt(s.close)} <small class="${cls(s.chg)}">${pct(s.chg, 1)}</small>`}</td>
      <td><div class="clx-mini"><i class="${c.s >= 0 ? 'p' : 'm'}" style="${c.s >= 0 ? `left:50%;width:${c.s / 2}%` : `right:50%;width:${-c.s / 2}%`}"></i></div><b class="mono ${cls(c.s)}">${c.s > 0 ? '+' : ''}${fmt(c.s, 1)}</b>${fl ? ` <small class="${cls(fl)}">(${fl > 0 ? '+' : ''}${fmt(fl, 1)})</small>` : ''}</td>
      <td>${dCell}</td>
      <td><span class="clx-v ${clxVcls(c.s)}">${esc(c.v)}</span></td>
      <td class="clx-6">${c.ax.map(v => `<i class="${v >= 0 ? 'p' : 'm'}" style="height:${Math.max(2, Math.abs(v) * 18)}px" title="${fmt(v, 2)}"></i>`).join('')}</td>
      <td>${(c.pat || []).map(patName).join('')}${(c.cnd || []).map(k => `<span class="tag ${k[0] === '+' ? 'good' : 'bad'}">${esc(CLX_CNAME[k.slice(1)] || k)}</span>`).join('')}</td>
      <td class="mono ${c.rr >= 1.5 ? 'up' : ''}">${fmt(c.rr, 2)}</td><td class="mono">${c.ckp ? '✓' : ''}${c.ck}/6</td><td class="mono">${fmt(c.pos, 1)}%</td></tr>`;
  }).join('')}</tbody></table>${rows.length > 150 ? `<div class="hint">상위 150종목만 표시</div>` : ''}` : '<div class="empty">조건에 맞는 종목이 없어요.</div>';
  $$('#clxList [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
}

function clxRenderOne(s, q, n) {
  const box = $('#clxOne'); if (!box) return;
  if (!q) { box.innerHTML = ''; box.dataset.code = ''; return; }
  if (!s) { box.innerHTML = n ? `<div class="hint">여러 종목이 검색됐어요 — 아래 표에서 고르거나 이름을 더 정확히 입력하세요.</div>` : `<div class="empty">"${esc(q)}"과(와) 맞는 종목이 없어요.</div>`; box.dataset.code = ''; return; }
  if (box.dataset.code === s.code && box.dataset.t === (CLX.live ? CLX.live.meta.time : '')) return;  // 같은 종목·같은 자료면 다시 그리지 않음
  box.dataset.code = s.code; box.dataset.t = CLX.live ? CLX.live.meta.time : '';
  box.innerHTML = `<div class="an-card an-wide"><h4>${esc(s.name)} <span class="muted mono">${esc(s.code)}</span> 차트 종합 판정 <button class="btn ghost small" id="clxOneAn">종목 분석 전체 보기 →</button></h4><div id="clxOneQ" class="clx-q"></div><div id="clxOneMount" data-code="${esc(s.code)}"></div></div>`;
  if (typeof renderClx === 'function') renderClx(s, 'clxOneMount');
  clxQuote(true);
  const b = $('#clxOneAn'); if (b) b.onclick = () => showAnalysis(s.code);
}
function initClx() {
  if ($('#clxQ')) {
    const go = () => renderClxTab();
    $('#clxQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    $('#clxQ').onchange = go;
    $('#clxQGo').onclick = go;
    $('#clxQClear').onclick = () => { $('#clxQ').value = ''; go(); };
  }
  if ($('#clxV')) {
    $('#clxP').innerHTML = '<option value="">모든 패턴</option><optgroup label="구조 패턴">' + Object.entries(CLX_PAT).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('') + '</optgroup><optgroup label="캔들 패턴(오늘·어제)">' +
      ['bullish_engulfing', 'morning_star', 'three_white_soldiers', 'hammer', 'piercing', 'bullish_harami', 'bearish_engulfing', 'evening_star', 'three_black_crows', 'shooting_star', 'dark_cloud'].map(k => `<option value="${k}">${CLX_CNAME[k] || k}</option>`).join('') + '</optgroup>';
    ['clxV', 'clxP', 'clxM', 'clxSort', 'clxCk', 'clxRR', 'clxW', 'clxNW', 'clxTd'].forEach(id => { if ($('#' + id)) $('#' + id).onchange = renderClxTab; });
  }
  const g = '차트 종합판정';
  FM.cl_score = { key: 'cl_score', label: '차트 종합 점수(−100~+100)', group: g, type: 'num', unit: '점', get: s => s.cl ? s.cl.s : null };
  FM.cl_verdict = { key: 'cl_verdict', label: '차트 판정(7단계)', group: g, type: 'enum', unit: '', opts: CLX_VERD.map(v => v[1]), get: s => s.cl ? s.cl.v : null };
  FM.cl_rr = { key: 'cl_rr', label: '손익비(목표1 기준)', group: g, type: 'num', unit: ': 1', get: s => s.cl ? s.cl.rr : null };
  FM.cl_ckp = { key: 'cl_ckp', label: '5초 체크리스트 통과', group: g, type: 'bool', unit: '', get: s => s.cl ? !!s.cl.ckp : null };
  FM.cl_week = { key: 'cl_week', label: '주봉 점수', group: g, type: 'num', unit: '점', get: s => s.cl ? s.cl.w : null };
  FM.cl_pat = { key: 'cl_pat', label: '차트·캔들 패턴', group: g, type: 'enum', unit: '', opts: [...Object.values(CLX_PAT).map(v => v[0]), ...Object.values(CLX_CNAME)],
    get: s => s.cl ? [...(s.cl.pat || []).map(p => (CLX_PAT[p.replace(/[+\-=!]/g, '')] || [p])[0]), ...(s.cl.cnd || []).map(c => CLX_CNAME[c.slice(1)] || '')].join(' ') : null };
}
function renderClxAll() { renderClxTab(); clxRenderLive(); }

/* ── 실시간: live-cl/summary.json (장중 15분마다 전 종목 재계산) 을 3분마다 확인 ── */
CLX.next = 0; CLX.first = true;
async function clxLive(manual) {
  let d = null;
  try { const r = await fetch(CLX.RAW + 'summary.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) { /* 아직 없음 */ }
  CLX.next = Date.now() + 60e3;
  if (!d || !d.s) { clxStatus(); return; }
  const changed = !CLX.live || CLX.live.meta.time !== d.meta.time;
  CLX.live = d;
  if (!changed && !manual) { clxStatus(); return; }
  clxBase();
  const prev = {}; S.data.stocks.forEach(s => { if (s.cl) prev[s.code] = s.cl.s; });
  S.data.stocks.forEach(s => { const x = d.s[s.code]; if (x) { s.cl = x; s._live = { c: x.c, chg: x.chg, d: x.d }; } });
  // 이번 계산에서 점수가 움직인 종목(첫 확인 때는 아침 기준과 같으니 표시하지 않음)
  if (changed) CLX.flash = {};
  if (!CLX.first && changed) S.data.stocks.forEach(s => { const x = d.s[s.code]; if (x && prev[s.code] != null && Math.abs(x.s - prev[s.code]) >= 0.5) CLX.flash[s.code] = x.s - prev[s.code]; });
  clxLogAdd(d);
  if (d.idx && Object.keys(d.idx).length) S.data.cl_index = d.idx;
  if (typeof liveApplyTf === 'function') { try { liveApplyTf(d); } catch (e) { console.error(e); } }
  if (typeof volApplyLive === 'function') { try { volApplyLive(d); } catch (e) { console.error(e); } }
  CLX.chg = Object.fromEntries((d.changes || []).map(c => [c.code, c]));
  if (!CLX.first) clxNotify(d.changes || []);
  CLX.first = false;
  renderClxTab(); clxRenderLive();
  const box = $('#clxMount');
  if (box && box.dataset.code && $('#tab-analysis') && $('#tab-analysis').classList.contains('on')) {
    const st = S.data.stocks.find(x => x.code === box.dataset.code); if (st) renderClx(st, 'clxMount');
  }
  const tab = $('button[data-tab="clx"]'); if (tab) tab.dataset.badge = (d.changes || []).filter(c => c.up).length || '';
  if (typeof fuOnUpdate === 'function') { try { fuOnUpdate('chart'); } catch (e) { console.error(e); } }
  clxStatus();
}
/* 한국 시각 기준 장 상태 — 서버 재계산은 평일 9:00~15:45 매 15분(+수집 2~4분) */
function clxKst() { const k = new Date(Date.now() + 9 * 3600e3); return { wd: k.getUTCDay(), m: k.getUTCHours() * 60 + k.getUTCMinutes(), date: k.toISOString().slice(0, 10) }; }
function clxSession() {
  const k = clxKst(), open = k.wd >= 1 && k.wd <= 5 && k.m >= 8 * 60 + 40 && k.m <= 16 * 60 + 15;
  let nx = null;
  if (open) { for (let m = 9 * 60; m <= 15 * 60 + 45; m += 15) if (m + 4 > k.m) { nx = m + 4; break; } if (nx == null && k.m < 16 * 60 + 14) nx = 16 * 60 + 14; }
  return { ...k, open, nx: nx == null ? null : `${String(Math.floor(nx / 60)).padStart(2, '0')}:${String(nx % 60).padStart(2, '0')}` };
}
function clxStatus() {
  const el = $('#clxStatus'); if (!el) return;
  const sec = Math.max(0, Math.round((CLX.next - Date.now()) / 1000)), cd = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const ss = clxSession();
  const sess = ss.open ? `<span class="tag good">장중 자동 갱신</span> 다음 재계산 약 <b>${ss.nx || '-'}</b>` : `<span class="tag">장 마감·휴일</span> 다음 재계산은 평일 오전 9:00`;
  if (!CLX.live) { el.innerHTML = `${sess} · 실시간 판정 대기 중 — 첫 계산 전에는 아침 수집 결과(${esc(S.data.meta.asof || '')} 종가 기준)를 보여줘요 · 새 결과 확인 ${cd} 후`; return; }
  const m = CLX.live.meta, mins = Math.round((Date.now() - new Date(m.time.replace(' ', 'T') + ':00+09:00')) / 60000);
  const late = ss.open && ss.m >= 9 * 60 + 25 && mins > 40 ? ` · <b class="down">마지막 계산이 ${mins}분 전이에요 — 오늘이 휴장일이거나 계산이 늦어지고 있어요</b>` : '';
  el.innerHTML = `<span class="gov-live"></span> 실시간 판정 <b>${esc(m.time.slice(11))}</b> 기준 (${mins < 1 ? '방금' : mins < 60 ? mins + '분 전' : mins < 1440 ? Math.round(mins / 60) + '시간 전' : esc(m.time.slice(5, 10)) + ' 계산'}) · ${m.n}종목 재계산 · ${sess} · 새 결과 확인 ${cd} 후${late}`;
}
function clxRenderLive() {
  const box = $('#clxChanges'); if (!box) return;
  const ch = (CLX.live && CLX.live.changes) || [];
  const M = Object.fromEntries(S.data.stocks.map(s => [s.code, s]));
  const chip = c => { const s = M[c.code]; return s ? `<button class="mn-chip ${c.up ? 'good' : 'bad'}" data-an="${esc(c.code)}">${c.up ? '▲' : '▼'} ${esc(s.name)} <small>${esc(c.from)} → <b>${esc(c.to)}</b></small></button>` : ''; };
  const up = ch.filter(c => c.up), dn = ch.filter(c => !c.up);
  let h = !ch.length ? (CLX.live ? `<div class="hint">직전 계산(${esc(CLX.live.meta.prev_time || '-')}) 대비 판정이 바뀐 종목이 없어요.</div>` : '') :
    `<h4>방금 판정이 바뀐 종목 <small class="muted">${esc(CLX.live.meta.prev_time || '')} → ${esc(CLX.live.meta.time)}</small></h4>
    ${up.length ? `<div class="mn-grp"><span class="mn-gl good">좋아짐 ${up.length}</span>${up.slice(0, 30).map(chip).join('')}</div>` : ''}
    ${dn.length ? `<div class="mn-grp mt-s"><span class="mn-gl bad">나빠짐 ${dn.length}</span>${dn.slice(0, 30).map(chip).join('')}</div>` : ''}`;
  // 오늘 하루 판정 변화 기록(이 기기에 쌓임)
  const lg = clxLogGet();
  if (lg.items.length) {
    const byT = {}; lg.items.forEach(x => (byT[x.t] = byT[x.t] || []).push(x));
    const ts = Object.keys(byT).sort().reverse();
    h += `<details class="clx-log mt-s"${CLX.logOpen ? ' open' : ''}><summary>📜 ${esc(lg.date.slice(5))} 판정 변화 기록 — ${ts.length}번 계산 · ${lg.items.length}건 <small class="muted">(누르면 펼쳐요)</small></summary>
      ${ts.map(tm => `<div class="clx-log-row"><b class="mono">${esc(tm.slice(11))}</b> ${byT[tm].slice(0, 40).map(chip).join('')}${byT[tm].length > 40 ? `<small class="muted"> 외 ${byT[tm].length - 40}건</small>` : ''}</div>`).join('')}</details>`;
  }
  box.innerHTML = h;
  const det = box.querySelector('details.clx-log'); if (det) det.ontoggle = () => { CLX.logOpen = det.open; };
  $$('#clxChanges [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
}
function clxLogGet() { const lg = store.get('clxLog', null); return lg && lg.date && Array.isArray(lg.items) ? lg : { date: '', items: [] }; }
function clxLogAdd(d) {
  if (!d || !d.meta || !d.meta.time) return;
  const date = d.meta.time.slice(0, 10);
  let lg = clxLogGet(); if (lg.date !== date) lg = { date, items: [] };
  if (lg.items.some(x => x.t === d.meta.time)) return;
  (d.changes || []).forEach(c => lg.items.push({ t: d.meta.time, code: c.code, from: c.from, to: c.to, up: c.up }));
  if (lg.items.length > 600) lg.items = lg.items.slice(-600);
  try { store.set('clxLog', lg); } catch (e) {}
}
/* 기준(오늘 아침 = 직전 거래일 종가 판정) 기억 — 「오늘 변화」 열의 비교 대상 */
function clxBase() {
  if (CLX.base) return;
  CLX.base = {}; CLX.baseAsof = S.data.meta.asof || '';
  S.data.stocks.forEach(s => { if (s.cl) CLX.base[s.code] = { s: s.cl.s, v: s.cl.v }; });
}
/* 검색한 한 종목: 지금 가격을 20초마다 받아 손절선·목표가와 비교 */
async function clxQuote(force) {
  const el = $('#clxOneQ'), box = $('#clxOne'); if (!el || !box || !box.dataset.code) return;
  const tabOn = $('#tab-clx') && $('#tab-clx').classList.contains('on');
  if (!force && (!tabOn || document.hidden || !clxSession().open)) return;
  const code = box.dataset.code, s = S.data.stocks.find(x => x.code === code); if (!s || !s.cl) return;
  let q = null;
  try { const r = await fetch('/api/hoga?code=' + code, { cache: 'no-store' }); if (r.ok) { const j = await r.json(); q = j.quote; q && (q.at = j.at); } } catch (e) {}
  if (box.dataset.code !== code || !$('#clxOneQ')) return;
  const c = s.cl, ref = c.c || s.close;
  const p = q && q.price ? q.price : null;
  if (!p) { el.innerHTML = `<div class="hint">지금 가격을 받지 못했어요 — 판정 계산 때 가격 ${fmt(ref)}원 기준으로 보여줘요.</div>`; return; }
  const chg = q.chgPct != null && q.chgPct !== 0 ? q.chgPct : (s._live ? s._live.chg : s.chg);
  const d = x => x ? (x / p - 1) * 100 : null;
  const st = d(c.stop), t1 = d(c.t1), t2 = d(c.t2);
  let warn = '';
  if (c.stop && p <= c.stop) warn = '<b class="down">⚠ 지금 가격이 손절선 아래예요 — 판정과 상관없이 위험 관리 먼저</b>';
  else if (c.t2 && p >= c.t2) warn = '<b class="up">🎯 2차 목표가 도달</b>';
  else if (c.t1 && p >= c.t1) warn = '<b class="up">🎯 1차 목표가 도달 — 일부 차익 실현 구간</b>';
  else if (st != null && st > -2) warn = '<b class="down">손절선까지 2% 안쪽 — 주의</b>';
  const mv = ref ? (p / ref - 1) * 100 : 0;
  el.innerHTML = `<div class="clx-qbar"><span><span class="gov-live"></span> 지금 <b class="mono">${fmt(p)}원</b> <small class="${cls(chg)}">${pct(chg, 2)}</small></span>
    <span class="muted">판정 계산 때 ${fmt(ref)}원${Math.abs(mv) >= 0.05 ? ` → 그 뒤 <b class="${cls(mv)}">${pct(mv, 2)}</b>` : ''}</span>
    ${c.stop ? `<span>손절선 ${fmt(c.stop)} <small class="down">(${pct(st, 1)})</small></span>` : ''}
    ${c.t1 ? `<span>1차 목표 ${fmt(c.t1)} <small class="${cls(t1)}">(${pct(t1, 1)})</small></span>` : ''}
    ${c.t2 ? `<span>2차 목표 ${fmt(c.t2)} <small class="${cls(t2)}">(${pct(t2, 1)})</small></span>` : ''}
    <small class="muted">${esc((q.at || '').slice(11, 19))} 시세 · 장중 20초마다</small></div>${warn ? `<div class="mt-s">${warn}</div>` : ''}`;
}
function clxNotify(ch) {
  const M = Object.fromEntries(S.data.stocks.map(s => [s.code, s]));
  const hot = ch.filter(c => (c.up && /매수 우위|강력 매수|체크리스트 통과/.test(c.to)) || (!c.up && /매도 우위|강력 매도/.test(c.to)));
  if (!hot.length) return;
  const txt = hot.slice(0, 3).map(c => `${c.up ? '▲' : '▼'} ${(M[c.code] || {}).name || c.code}: ${c.from} → ${c.to}`);
  const t = $('#govToast');
  if (t) { t.innerHTML = `📈 차트 판정 변화 ${hot.length}건 — ${esc(txt[0])}`; t.classList.remove('hidden'); t.onclick = () => { switchTab('clx'); t.classList.add('hidden'); }; setTimeout(() => t.classList.add('hidden'), 15000); }
  if (store.get('clxNoti', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('차트 판정 변화 ' + hot.length + '건', { body: txt.join('\n') }); } catch (e) {}
  }
}
function initClxLive() {
  if ($('#clxRefresh')) $('#clxRefresh').onclick = () => clxLive(true);
  const nb = $('#clxNoti');
  if (nb) {
    const draw = () => { nb.textContent = store.get('clxNoti', false) ? '🔔 판정 변화 알림 켜짐' : '🔕 판정 변화 알림 켜기'; };
    nb.onclick = async () => {
      if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않아요.'); return; }
      if (store.get('clxNoti', false)) { store.set('clxNoti', false); draw(); return; }
      const p = await Notification.requestPermission(); store.set('clxNoti', p === 'granted'); draw();
    };
    draw();
  }
  clxBase();
  clxLive();
  setInterval(() => clxLive(), 60e3);
  setInterval(clxStatus, 1000);
  setInterval(() => clxQuote(false), 20e3);
  // 다른 창에 있다가 돌아오면 바로 새 결과 확인
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() > CLX.next - 45e3) clxLive(); });
}
(function waitBootClx() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && typeof getJSON === 'function' && typeof FM !== 'undefined' && FM.cl_score) initClxLive();
  else setTimeout(waitBootClx, 400);
})();
