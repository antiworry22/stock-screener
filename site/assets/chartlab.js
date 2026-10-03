/* 차트 정밀 분석 — 추세·지지/저항·모멘텀·변동성·거래량을 계산하고 쉬운 말로 해석 + 최종 평가·추천 */
'use strict';

const CL = {};  // 계산 함수 모음

CL.sma = (a, n) => a.map((_, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; });
CL.ema = (a, n) => { const k = 2 / (n + 1); const o = []; a.forEach((v, i) => o.push(i ? v * k + o[i - 1] * (1 - k) : v)); return o; };
CL.rsi = (a, n = 14) => {
  const o = Array(a.length).fill(null); let up = 0, dn = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= n) { up += u / n; dn += w / n; if (i === n) o[i] = dn ? 100 - 100 / (1 + up / dn) : 100; continue; }
    up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + w) / n; o[i] = dn ? 100 - 100 / (1 + up / dn) : 100;
  }
  return o;
};
CL.macd = a => { const f = CL.ema(a, 12), s = CL.ema(a, 26); const m = a.map((_, i) => f[i] - s[i]); const sig = CL.ema(m, 9); return { m, sig, h: m.map((v, i) => v - sig[i]) }; };
CL.bb = (a, n = 20) => { const mid = CL.sma(a, n); return a.map((_, i) => { if (mid[i] == null) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += (a[k] - mid[i]) ** 2; const sd = Math.sqrt(s / n); return { mid: mid[i], up: mid[i] + 2 * sd, lo: mid[i] - 2 * sd }; }); };
CL.linreg = a => { const n = a.length, xs = a.map((_, i) => i); const mx = (n - 1) / 2, my = a.reduce((p, q) => p + q, 0) / n; let num = 0, den = 0; xs.forEach(x => { num += (x - mx) * (a[x] - my); den += (x - mx) ** 2; }); const b = num / den; return { b, a: my - b * mx }; };

// 지지·저항: 최근 고점·저점(앞뒤 5일 중 최고/최저)을 2% 범위로 묶어 여러 번 닿은 가격대를 찾음
CL.levels = (h, l, cur) => {
  const pts = [], N = h.length, w = 5;
  for (let i = w; i < N - 2; i++) {
    const win = (arr, fn) => { let r = arr[i]; for (let k = Math.max(0, i - w); k <= Math.min(N - 1, i + w); k++) r = fn(r, arr[k]); return r; };
    if (h[i] === win(h, Math.max)) pts.push({ p: h[i], i, t: 'H' });
    if (l[i] === win(l, Math.min)) pts.push({ p: l[i], i, t: 'L' });
  }
  pts.sort((a, b) => a.p - b.p);
  const cl = [];
  pts.forEach(pt => { const c = cl.find(x => Math.abs(x.p / pt.p - 1) < 0.02); if (c) { c.n++; c.p = (c.p * (c.n - 1) + pt.p) / c.n; c.last = Math.max(c.last, pt.i); } else cl.push({ p: pt.p, n: 1, last: pt.i }); });
  const sup = cl.filter(x => x.p < cur * 0.995).sort((a, b) => b.p - a.p);
  const res = cl.filter(x => x.p > cur * 1.005).sort((a, b) => a.p - b.p);
  return { sup, res };
};

function chartLab(s) {
  const c = (s.spark || []).filter(x => x != null);
  const N = c.length; if (N < 40) return null;
  const v = (s.spark_vol || []).slice(-N);
  const o = (s.spark_o && s.spark_o.length === N) ? s.spark_o : null;
  const h = (s.spark_h && s.spark_h.length === N) ? s.spark_h : c;
  const l = (s.spark_l && s.spark_l.length === N) ? s.spark_l : c;
  const cur = c[N - 1];
  const ma5 = CL.sma(c, 5), ma20 = CL.sma(c, 20), ma60 = CL.sma(c, 60);
  const ma120 = (s.spark_ma120 || []).slice(-N);
  const rsi = CL.rsi(c), mac = CL.macd(c), bb = CL.bb(c);
  const slope = (ma, k = 5) => ma[N - 1] != null && ma[N - 1 - k] != null ? (ma[N - 1] / ma[N - 1 - k] - 1) * 100 : null;
  const tS = slope(ma5, 3), tM = slope(ma20, 5), tL = ma60[N - 1] != null ? slope(ma60, 10) : null;
  const dir = x => x == null ? '자료 부족' : x > 0.5 ? '오름' : x < -0.5 ? '내림' : '옆으로';
  const lr = CL.linreg(c.slice(-Math.min(60, N)));
  const lrDay = lr.b / (c.slice(-Math.min(60, N)).reduce((p, q) => p + q, 0) / Math.min(60, N)) * 100;
  const lv = CL.levels(h, l, cur);
  const ma20v = ma20[N - 1], ma60v = ma60[N - 1];
  const sup1 = lv.sup[0] ? lv.sup[0].p : Math.min(...l.slice(-20));
  const sup2 = lv.sup[1] ? lv.sup[1].p : Math.min(...l);
  const res1 = lv.res[0] ? lv.res[0].p : Math.max(...h.slice(-60));
  const res2 = lv.res[1] ? lv.res[1].p : Math.max(...h) * (lv.res[0] ? 1 : 1.05);
  const hi = Math.max(...h), lo = Math.min(...l);
  const fibPos = (cur - lo) / (hi - lo || 1);
  const r = rsi[N - 1], r5 = rsi[N - 6];
  const macAbove = mac.m[N - 1] > mac.sig[N - 1];
  let crossDays = null; for (let i = N - 1; i > N - 30 && i > 0; i--) { if ((mac.m[i] > mac.sig[i]) !== (mac.m[i - 1] > mac.sig[i - 1])) { crossDays = N - 1 - i; break; } }
  const bw = bb.map(x => x ? (x.up - x.lo) / x.mid : null).filter(x => x != null);
  const bwNow = bw[bw.length - 1], bwRank = bw.filter(x => x < bwNow).length / bw.length;
  const pb = bb[N - 1] ? (cur - bb[N - 1].lo) / (bb[N - 1].up - bb[N - 1].lo) : null;
  let upV = 0, upN = 0, dnV = 0, dnN = 0;
  for (let i = N - 20; i < N; i++) { if (i < 1 || v[i] == null) continue; if (c[i] >= c[i - 1]) { upV += v[i]; upN++; } else { dnV += v[i]; dnN++; } }
  const accum = (upN ? upV / upN : 0) / ((dnN ? dnV / dnN : 0) || 1);
  const vRatio = v[N - 1] / ((v.slice(-21, -1).reduce((p, q) => p + q, 0) / 20) || 1);

  // ── 차트 점수(0~100) ──
  let sc = 0; const part = {};
  part.trend = (tS > 0.5 ? 10 : tS > -0.5 ? 5 : 0) + (tM > 0.5 ? 10 : tM > -0.5 ? 5 : 0) + (tL == null ? 5 : tL > 0.5 ? 10 : tL > -0.5 ? 5 : 0);
  part.pos = (cur > ma20v ? 5 : 0) + (ma60v == null || cur > ma60v ? 5 : 0);
  part.mom = (r >= 45 && r <= 65 && r > r5 ? 15 : r > 30 && r < 45 && r > r5 ? 12 : r > 70 ? 5 : r <= 30 ? 8 : 7) + (macAbove ? 5 : 0);
  part.vol = accum >= 1.3 ? 15 : accum >= 1.05 ? 10 : accum >= 0.8 ? 5 : 0;
  const dSup = (cur / sup1 - 1) * 100, dRes = (res1 / cur - 1) * 100;
  part.room = (dSup <= 5 ? 10 : dSup <= 10 ? 6 : 2) + (dRes >= 8 ? 5 : dRes >= 4 ? 3 : 0);
  const pats = typeof PAT_FN !== 'undefined' ? Object.entries(PAT_FN).map(([k, fn]) => ({ k, p: fn(s) })).filter(x => x.p && x.p.ok) : [];
  part.pat = pats.length ? 10 : 0;
  sc = Object.values(part).reduce((p, q) => p + q, 0);
  const label = sc >= 75 ? '강한 상승 흐름' : sc >= 60 ? '상승 우위' : sc >= 45 ? '방향 탐색 중(중립)' : sc >= 30 ? '약세' : '하락 흐름';

  // ── 쉬운 말 해석 ──
  const won = x => fmt(Math.round(x)) + '원';
  const T = [];
  T.push({ h: '추세(방향)', t: `단기(1주 평균선) <b>${dir(tS)}</b> · 중기(1달) <b>${dir(tM)}</b> · 장기(3달) <b>${dir(tL)}</b>. 최근 3개월 추세선은 하루 평균 ${lrDay >= 0 ? '+' : ''}${lrDay.toFixed(2)}%씩 ${lrDay > 0.05 ? '오르는' : lrDay < -0.05 ? '내리는' : '옆으로 가는'} 모양이에요. ` +
    (cur > ma20v && (ma60v == null || cur > ma60v) ? '주가가 1달·3달 평균선 위에 있어 흐름이 좋은 편이에요.' : cur < ma20v && ma60v != null && cur < ma60v ? '주가가 1달·3달 평균선 아래에 있어 아직 힘이 약해요.' : '평균선 사이에서 방향을 고르는 중이에요.') });
  T.push({ h: '지지·저항(바닥과 천장)', t: `아래 받쳐 주는 가격(지지선) <b>${won(sup1)}</b>(지금보다 ${dSup.toFixed(1)}% 아래)${lv.sup[0] ? `, 이 가격대에서 ${lv.sup[0].n}번 버텼어요` : ''}. 위에서 막는 가격(저항선) <b>${won(res1)}</b>(지금보다 ${dRes.toFixed(1)}% 위)${lv.res[0] ? `, ${lv.res[0].n}번 막혔어요` : ''}. ` +
    (dSup <= 4 ? '지지선 바로 위라 손실 폭을 짧게 잡기 좋은 자리예요.' : dRes <= 3 ? '저항선 바로 아래라 뚫는지 확인하고 들어가는 게 안전해요.' : '지지선과 저항선 사이 중간쯤이에요.') });
  T.push({ h: '6개월 가격대 위치', t: `최근 6개월 최저 ${won(lo)} ~ 최고 ${won(hi)} 사이에서 <b>${Math.round(fibPos * 100)}%</b> 높이에 있어요. ${fibPos >= 0.8 ? '고점 근처라 추가 상승 시 신고가 돌파 여부가 중요해요.' : fibPos >= 0.5 ? '중간보다 위로, 상승 쪽 힘이 남아 있어요.' : fibPos >= 0.382 ? '조정 구간(38~50%)으로, 흔히 다시 반등을 노리는 자리예요.' : '바닥권에 가까워 반등 신호 확인이 먼저예요.'}` });
  T.push({ h: '힘(모멘텀)', t: `과열 정도(RSI) <b>${Math.round(r)}</b>${r > r5 ? '(올라가는 중)' : '(내려가는 중)'} — ${r >= 70 ? '과열이라 쉬어 갈 수 있어요' : r <= 30 ? '많이 빠진 상태라 반등 가능성을 살필 때예요' : r >= 50 ? '사는 힘이 조금 더 세요' : '파는 힘이 조금 더 세요'}. 단기 흐름 지표(MACD)는 ${macAbove ? '위쪽(상승 신호)' : '아래쪽(약세 신호)'}${crossDays != null ? `이고 ${crossDays}일 전에 방향이 바뀌었어요` : ''}.` });
  T.push({ h: '흔들림(변동성)', t: `하루 평균 약 ${fmt(s.atr_pct, 1)}% 오르내려요. 가격 띠(볼린저밴드) 폭은 최근 6개월 중 ${bwRank < 0.2 ? '<b>가장 좁은 편</b> — 조용히 힘을 모으는 중이라 곧 크게 움직일 수 있어요' : bwRank > 0.8 ? '가장 넓은 편 — 크게 흔들리는 중이에요' : '보통 수준이에요'}. 띠 안에서 ${pb == null ? '-' : Math.round(Math.max(0, Math.min(1, pb)) * 100) + '%'} 높이에 있어요.` });
  T.push({ h: '거래량(사는 쪽 vs 파는 쪽)', t: `최근 20일 동안 오른 날 거래량이 내린 날의 <b>${accum.toFixed(2)}배</b> — ${accum >= 1.3 ? '사는 쪽이 꾸준히 모으는(매집) 모습이에요' : accum >= 1.05 ? '사는 쪽이 조금 우세해요' : accum >= 0.8 ? '비슷해요' : '파는 쪽이 우세해요(물량이 나오는 중)'}. 오늘 거래량은 평소의 ${vRatio.toFixed(1)}배예요.` });
  if (pats.length) T.push({ h: '차트 패턴', t: pats.map(x => `<b>${PAT[x.k].label}</b>: ${x.p.steps.join(' ')}`).join('<br>') });

  // ── 최종 평가·추천 ──
  const ban = s._ban && s._ban.length;
  const fin = Math.round((sc * 0.5 + (s._sc.total || 0) * 0.5) * 10) / 10;
  const stop = Math.min(sup1 * 0.97, riskCalc(s).stop);
  const t1 = res1, t2 = Math.max(res2, t1 * 1.05);
  const rr = (t1 - cur) / ((cur - stop) || 1);
  let rec, rcls, how;
  if (ban) { rec = '매수 비추천'; rcls = 'bad'; how = `위험 신호(${s._ban.join(', ')})가 있어 지금은 피하는 게 좋아요.`; }
  else if (fin >= 65 && sc >= 60 && rr >= 1.5) { rec = '매수 고려'; rcls = 'good'; how = `차트와 회사 점수가 모두 좋아요. ${dSup <= 5 ? `지금 가격 근처에서 2~3번 나눠 사고` : `${won(sup1)}~${won(cur)} 사이 눌릴 때 나눠 사고`}, ${won(stop)} 아래로 내려가면 정리하는 계획을 권해요.`; }
  else if (fin >= 55) { rec = '관심 종목'; rcls = 'mid'; how = dRes <= 6 ? `저항선 ${won(res1)}을 거래량과 함께 뚫으면 매수를 고려해 보세요.` : `지지선 ${won(sup1)} 근처까지 내려와 버티는지 확인한 뒤 접근해 보세요.`; }
  else if (fin >= 45) { rec = '관망'; rcls = 'low'; how = '뚜렷한 방향이 없어요. 추세가 위로 돌아서는지(1달 평균선 위 안착) 지켜보세요.'; }
  else { rec = '매수 비추천'; rcls = 'bad'; how = '차트 흐름과 점수가 약해요. 반등 신호가 나올 때까지 기다리는 편이 좋아요.'; }
  if (!ban && rr < 1.2 && rec !== '매수 비추천') how += ` 다만 지금 가격에선 기대 이익(목표 ${won(t1)})이 위험(손절 ${won(stop)})보다 크지 않아요(손익비 ${rr.toFixed(1)}).`;

  return { N, c, o, h, l, v, ma5, ma20, ma60, ma120, rsi, mac, bb, sup: lv.sup.slice(0, 3), res: lv.res.slice(0, 3), sup1, res1, t1, t2, stop, hi, lo,
    score: sc, part, label, texts: T, fin, rec, rcls, how, rr, pats };
}

/* ── 그리기 ── */
const _clCharts = [];
function clDraw(s, lab, range) {
  _clCharts.forEach(ch => ch.destroy()); _clCharts.length = 0;
  if (!window.Chart) return;
  const css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
  const n = Math.min(range, lab.N), from = lab.N - n;
  const cut = a => (a || []).slice(from);
  const labels = Array.from({ length: n }, (_, i) => { const d = n - 1 - i; return d === 0 ? '오늘' : d + '일 전'; });
  const up = col('--up'), dn = col('--down'), grid = col('--line'), txt = col('--muted');
  const base = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: {} } },
    scales: { x: { ticks: { color: txt, maxTicksLimit: 6, autoSkip: true }, grid: { color: grid } }, y: { position: 'right', ticks: { color: txt }, grid: { color: grid } } } };
  // 가격
  const ds = [];
  if (lab.o) {
    const O = cut(lab.o), H = cut(lab.h), L = cut(lab.l), C = cut(lab.c);
    const colr = C.map((x, i) => x >= O[i] ? up : dn);
    ds.push({ type: 'bar', label: '고저', data: H.map((x, i) => [L[i], x]), backgroundColor: colr, barPercentage: 0.12, categoryPercentage: 1, order: 3 });
    ds.push({ type: 'bar', label: '시가·종가', data: O.map((x, i) => [Math.min(x, C[i]), Math.max(x, C[i]) + (x === C[i] ? C[i] * 0.001 : 0)]), backgroundColor: colr, barPercentage: 0.7, categoryPercentage: 1, order: 2 });
  } else ds.push({ type: 'line', label: '종가', data: cut(lab.c), borderColor: col('--text'), borderWidth: 1.8, pointRadius: 0, order: 1 });
  const ln = (label, d, color, dash, w = 1.2) => ({ type: 'line', label, data: d, borderColor: color, borderWidth: w, pointRadius: 0, borderDash: dash || [], order: 1, spanGaps: true });
  ds.push(ln('1주 평균', cut(lab.ma5), '#e0a100'), ln('1달 평균', cut(lab.ma20), up), ln('3달 평균', cut(lab.ma60), '#16a34a'), ln('6달 평균', cut(lab.ma120), '#8b5cf6'));
  ds.push(ln('밴드 위', cut(lab.bb.map(x => x && x.up)), txt, [3, 3], 1), ln('밴드 아래', cut(lab.bb.map(x => x && x.lo)), txt, [3, 3], 1));
  const flat = (label, y, color, dash) => ln(label, Array(n).fill(y), color, dash, 1.4);
  ds.push(flat('지지선', lab.sup1, '#16a34a', [6, 4]), flat('저항선', lab.res1, '#dc2626', [6, 4]), flat('손절가', lab.stop, dn, [2, 3]));
  const win = [...cut(lab.l), ...cut(lab.h), lab.stop].filter(x => x != null);
  const yMin = Math.min(...win) * 0.97, yMax = Math.max(...win, lab.res1) * 1.02;
  _clCharts.push(new Chart($('#clPrice'), { data: { labels, datasets: ds }, options: { ...base, scales: { ...base.scales, y: { ...base.scales.y, beginAtZero: false, min: Math.round(yMin), max: Math.round(yMax), ticks: { color: txt, callback: v => fmt(v) } } }, plugins: { ...base.plugins, legend: { display: true, labels: { color: txt, boxWidth: 10, font: { size: 11 }, filter: it => !['고저', '시가·종가'].includes(it.text) } } } } }));
  // 거래량
  const C = cut(lab.c), V = cut(lab.v);
  _clCharts.push(new Chart($('#clVol'), { type: 'bar', data: { labels, datasets: [{ label: '거래량', data: V, backgroundColor: C.map((x, i) => i && x < C[i - 1] ? dn : up) }] }, options: { ...base, scales: { ...base.scales, x: { ...base.scales.x, display: false }, y: { ...base.scales.y, ticks: { color: txt, maxTicksLimit: 3, callback: v => v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v } } } } }));
  // RSI
  _clCharts.push(new Chart($('#clRsi'), { type: 'line', data: { labels, datasets: [ln('과열 정도(RSI)', cut(lab.rsi), '#7c3aed', null, 1.5), flat('70', 70, dn, [3, 3]), flat('30', 30, up, [3, 3])] }, options: { ...base, scales: { ...base.scales, x: { ...base.scales.x, display: false }, y: { ...base.scales.y, min: 0, max: 100, ticks: { color: txt, stepSize: 30 } } } } }));
  // MACD
  const Hh = cut(lab.mac.h);
  _clCharts.push(new Chart($('#clMacd'), { data: { labels, datasets: [{ type: 'bar', label: '차이', data: Hh, backgroundColor: Hh.map(x => x >= 0 ? up : dn), order: 2 }, ln('MACD', cut(lab.mac.m), col('--text'), null, 1.2), ln('시그널', cut(lab.mac.sig), '#e0a100', null, 1.2)] }, options: { ...base, scales: { ...base.scales, y: { ...base.scales.y, ticks: { color: txt, maxTicksLimit: 3 } } } } }));
}

function chartLabHtml(s, lab) {
  if (!lab) return '<div class="hint">차트 자료가 부족해 정밀 분석을 할 수 없어요.</div>';
  const part = lab.part, won = x => fmt(Math.round(x)) + '원';
  const pbar = (l, v, m) => `<div class="abar"><span class="al">${l}</span><div class="ab"><i style="width:${v / m * 100}%" class="${sCls(v / m * 100)}"></i></div><span class="av mono">${v}/${m}</span></div>`;
  return `
  <div class="cl-top">
    <div class="cl-rec ${lab.rcls}"><small>최종 추천</small><b>${lab.rec}</b><span>${lab.how}</span></div>
    <div class="cl-scores">
      <div><small>최종 평가</small><b>${fmt(lab.fin, 1)}</b><span class="hint">차트 50% + 종합 50%</span></div>
      <div><small>차트 점수</small><b>${lab.score}</b><span class="hint">${lab.label}</span></div>
      <div><small>종합 점수</small><b>${fmt(s._sc.total, 1)}</b><span class="hint">회사·수급 포함</span></div>
      <div><small>추천 점수</small><b>${s._rec != null ? fmt(s._rec, 1) : '–'}</b><span class="hint">추천 순위용</span></div>
    </div>
  </div>
  <div class="cl-plan">
    <div><small>손절가</small><b class="down">${won(lab.stop)}</b></div>
    <div><small>지지선</small><b>${won(lab.sup1)}</b></div>
    <div><small>현재가</small><b>${won(s.close)}</b></div>
    <div><small>1차 목표(저항)</small><b class="up">${won(lab.t1)}</b></div>
    <div><small>2차 목표</small><b class="up">${won(lab.t2)}</b></div>
    <div><small>손익비</small><b>${lab.rr.toFixed(1)}</b><span class="hint">1.5 이상이 좋음</span></div>
  </div>
  <div class="row gap wrap cl-rng"><span class="lbl">기간</span>${[[20, '1개월'], [60, '3개월'], [120, '6개월']].map(([d, t]) => `<button class="chip ${d === 120 ? 'on' : ''}" data-rng="${d}">${t}</button>`).join('')}
    <span class="hint">${lab.o ? '봉 차트(빨강=오른 날, 파랑=내린 날)' : '종가 선 차트 — 봉 차트는 다음 수집부터'} · 초록 점선=지지선, 빨강 점선=저항선</span></div>
  <div class="cl-box" style="height:320px"><canvas id="clPrice"></canvas></div>
  <div class="cl-sub"><span>거래량</span></div><div class="cl-box" style="height:80px"><canvas id="clVol"></canvas></div>
  <div class="cl-sub"><span>과열 정도(RSI) — 70 위 과열, 30 아래 많이 빠짐</span></div><div class="cl-box" style="height:90px"><canvas id="clRsi"></canvas></div>
  <div class="cl-sub"><span>단기 흐름(MACD) — 막대가 0 위면 상승 쪽 힘</span></div><div class="cl-box" style="height:90px"><canvas id="clMacd"></canvas></div>
  <h4 class="mt">차트 해석</h4>
  <div class="cl-texts">${lab.texts.map(x => `<div class="cl-t"><b>${x.h}</b><p>${x.t}</p></div>`).join('')}</div>
  <h4 class="mt">차트 점수 구성 (${lab.score}점)</h4>
  ${pbar('추세 방향', part.trend, 30)}${pbar('평균선 위치', part.pos, 10)}${pbar('힘(모멘텀)', part.mom, 20)}${pbar('거래량 흐름', part.vol, 15)}${pbar('자리(지지·저항)', part.room, 15)}${pbar('차트 패턴', part.pat, 10)}
  ${lab.sup.length || lab.res.length ? `<div class="hint mt">찾은 가격대 — 지지: ${lab.sup.map(x => `${won(x.p)}(${x.n}번)`).join(', ') || '-'} · 저항: ${lab.res.map(x => `${won(x.p)}(${x.n}번)`).join(', ') || '-'}</div>` : ''}`;
}

function renderChartLab(s, mountId) {
  const box = $('#' + mountId); if (!box) return null;
  const lab = chartLab(s);
  box.innerHTML = chartLabHtml(s, lab);
  if (lab) {
    clDraw(s, lab, 120);
    $$('[data-rng]', box).forEach(b => b.onclick = () => { $$('[data-rng]', box).forEach(x => x.classList.toggle('on', x === b)); clDraw(s, lab, +b.dataset.rng); });
  }
  return lab;
}
