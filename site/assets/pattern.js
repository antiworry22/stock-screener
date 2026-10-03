/* 차트 패턴 분석 — 최근 120거래일 종가·거래량으로 모양을 찾아냅니다 (브라우저 계산) */
'use strict';

const PAT = {
  pullback: { label: '눌림목 반등 시작', desc: '한 번 크게 오른 뒤 → 적당히 쉬어 가며(조정) → 좁은 범위에서 버티다가(눌림목) → 오늘 다시 꿈틀대는 종목' },
  box: { label: '박스권 돌파', desc: '한 달 넘게 일정한 범위에서 오르내리다가 거래량을 싣고 위쪽 벽을 뚫은 종목' },
  bottom: { label: '바닥 다지고 반등', desc: '1년 고점보다 많이 싼 상태에서 바닥을 여러 번 확인하고 1달 평균선 위로 올라선 종목' },
  high: { label: '상승 추세 신고가 근접', desc: '평균선이 모두 오르는 상승 추세에서 1년 최고가 근처까지 온 종목' },
};

function _ma(a, n, i) { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; }
function _range(a, i0, i1) { let mx = -Infinity, mn = Infinity, sum = 0; for (let k = i0; k <= i1; k++) { mx = Math.max(mx, a[k]); mn = Math.min(mn, a[k]); sum += a[k]; } return { mx, mn, avg: sum / (i1 - i0 + 1), r: (mx - mn) / (sum / (i1 - i0 + 1)) }; }
function _avg(a, i0, i1) { let s = 0, n = 0; for (let k = Math.max(0, i0); k <= i1; k++) if (a[k] != null) { s += a[k]; n++; } return n ? s / n : null; }

function patternPullback(s) {
  const c = (s.spark || []).filter(x => x != null), v = s.spark_vol || [];
  const N = c.length; if (N < 80) return null;
  // ① 고점: 8~100일 전 사이 최고가
  let pk = N - 100 < 0 ? 0 : N - 100;
  for (let i = pk; i <= N - 9; i++) if (c[i] > c[pk]) pk = i;
  const peak = c[pk];
  let lo = Math.max(0, pk - 60); for (let i = lo; i <= pk; i++) if (c[i] < c[lo]) lo = i;
  const rally = peak / c[lo] - 1;
  if (rally < 0.2) return null;  // 고점 전에 20% 이상 올랐어야 함
  // ② 조정: 고점 이후 최저가
  let tr = pk; for (let i = pk; i < N; i++) if (c[i] < c[tr]) tr = i;
  const draw = 1 - c[tr] / peak;
  if (draw < 0.07 || draw > 0.38) return null;
  const retr = (peak - c[tr]) / (peak - c[lo]);  // 오른 폭 중 얼마나 되돌렸나
  if (retr > 0.7) return null;
  // ③ 눌림목: 어제부터 거꾸로 좁은 범위(±6%)가 유지된 기간
  let cs = N - 2;
  while (cs - 1 > pk && _range(c, cs - 1, N - 2).r <= 0.12) cs--;
  const consLen = N - 1 - cs;
  if (consLen < 7) return null;
  const box = _range(c, cs, N - 2);
  const volCons = _avg(v, cs, N - 2), volRally = _avg(v, lo, pk);
  const volDry = volCons != null && volRally != null && volCons < volRally * 0.85;
  // ④ 꿈틀: 오늘 상승 + 5일선 위 + 거래량 증가
  const cur = c[N - 1], ma5 = _ma(c, 5, N - 1), ma5p = _ma(c, 5, N - 4);
  const volToday = v[N - 1], volUp = volCons ? volToday / volCons : null;
  const chg = (cur / c[N - 2] - 1) * 100;
  const wiggle = chg > 0 && cur > ma5 && ma5 >= ma5p && (volUp ?? 0) >= 1.2;
  const breakout = cur > box.mx;
  let score = Math.min(rally, 0.6) / 0.6 * 20 + (retr <= 0.5 ? 20 : 12) + Math.min(consLen, 25) / 25 * 20 + (volDry ? 10 : 0) + (wiggle ? 20 : 0) + (breakout ? 10 : 0);
  return {
    key: 'pullback', ok: wiggle, score: Math.round(Math.min(100, score)),
    marks: { lo, pk, tr, cs, ce: N - 2 },
    steps: [
      `① 상승: ${N - 1 - lo}일 전부터 ${N - 1 - pk}일 전까지 <b>+${Math.round(rally * 100)}%</b> 올랐어요`,
      `② 조정: 고점에서 최대 <b>-${Math.round(draw * 100)}%</b> 쉬었고, 오른 폭의 ${Math.round(retr * 100)}%만 되돌려 ${retr <= 0.5 ? '건강한 조정' : '적당한 조정'}이에요`,
      `③ 눌림목: 최근 <b>${consLen}일</b> 동안 ±${Math.round(box.r * 50)}% 좁은 범위에서 버텼고${volDry ? ', 거래량도 줄며 매도세가 잦아들었어요' : ''}`,
      wiggle ? `④ 꿈틀: 오늘 <b>${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</b>, 거래량 버틴 기간 평균의 ${volUp.toFixed(1)}배, 1주 평균선 위로 올라섰어요${breakout ? ' — <b>버틴 범위 위쪽을 뚫었어요</b>' : ''}` : `④ 아직 꿈틀 신호 전: 오늘 ${chg.toFixed(1)}%, 거래량 ${volUp ? volUp.toFixed(1) + '배' : '-'}`,
    ],
  };
}

function patternBox(s) {
  const c = (s.spark || []).filter(x => x != null), v = s.spark_vol || [];
  const N = c.length; if (N < 60) return null;
  let cs = N - 2;
  while (cs - 1 > 0 && _range(c, cs - 1, N - 2).r <= 0.15) cs--;
  const len = N - 1 - cs; if (len < 20) return null;
  const box = _range(c, cs, N - 2), cur = c[N - 1];
  const volUp = v[N - 1] / (_avg(v, cs, N - 2) || 1);
  const ok = cur > box.mx && volUp >= 1.8;
  return { key: 'box', ok, score: Math.round(Math.min(100, Math.min(len, 60) / 60 * 40 + (ok ? 40 : 0) + Math.min(volUp, 4) / 4 * 20)), marks: { cs, ce: N - 2 },
    steps: [`① ${len}일 동안 ${fmt(box.mn)}~${fmt(box.mx)}원 사이(폭 ${Math.round(box.r * 100)}%)에서 오르내렸어요`,
      ok ? `② 오늘 위쪽 벽(${fmt(box.mx)}원)을 <b>거래량 ${volUp.toFixed(1)}배</b>로 뚫었어요` : `② 아직 돌파 전 (위쪽 벽 ${fmt(box.mx)}원, 지금 ${fmt(cur)}원)`] };
}

function patternBottom(s) {
  const c = (s.spark || []).filter(x => x != null); const N = c.length; if (N < 40) return null;
  const ma20 = _ma(c, 20, N - 1), ma20p = _ma(c, 20, N - 4);
  const crossed = c[N - 1] > ma20 && c.slice(N - 6, N - 1).some((x, i) => x < _ma(c, 20, N - 6 + i));
  const ok = s.pos52 != null && s.pos52 < S.th.pos52_undervalued && (s.low_tests || 0) >= 2 && crossed;
  return { key: 'bottom', ok, score: Math.round((ok ? 60 : 0) + Math.min(s.low_tests || 0, 5) * 6 + (ma20 >= ma20p ? 10 : 0)), marks: {},
    steps: [`① 1년 최고가보다 ${s.pos52 != null ? Math.round((1 - s.pos52) * 100) : '-'}% 싼 상태`, `② 바닥 근처를 ${s.low_tests || 0}번 확인`, crossed ? '③ 최근 1달 평균선을 위로 뚫고 올라섰어요' : '③ 아직 1달 평균선 아래']};
}

function patternHigh(s) {
  const ok = !!s.ma_align && (s.pos52 ?? 0) >= 0.95 && (s.vol_ratio ?? 0) >= 1.3;
  return { key: 'high', ok, score: Math.round((ok ? 60 : 0) + (s.pos52 ?? 0) * 20 + Math.min(s.vol_ratio ?? 0, 3) / 3 * 20), marks: {},
    steps: [s.ma_align ? '① 1주·1달·6개월 평균선이 모두 오르는 상승 추세' : '① 상승 추세 아님', `② 1년 최고가의 ${Math.round((s.pos52 ?? 0) * 100)}% 위치`, `③ 거래량 평소의 ${fmt(s.vol_ratio, 1)}배`] };
}

const PAT_FN = { pullback: patternPullback, box: patternBox, bottom: patternBottom, high: patternHigh };

function fundOk(s) {
  // 실적 좋은 회사: 영업이익 증가(또는 흑자전환) + 실적 점수 55↑ + 최근 3분기 이상 흑자
  return (s.op_turn || (s.op_yoy ?? -1) > 0) && (s._sc.earnings ?? 0) >= 55 && (s.profit_q ?? 0) >= 3;
}

// 미니 차트(SVG): 종가 + 1달 평균선 + 구간 표시
function patSvg(s, p) {
  const c = (s.spark || []).filter(x => x != null); const N = c.length; if (!N) return '';
  const W = 320, H = 96, pad = 4;
  const mx = Math.max(...c), mn = Math.min(...c);
  const X = i => pad + i / (N - 1) * (W - pad * 2), Y = v => pad + (1 - (v - mn) / (mx - mn || 1)) * (H - pad * 2);
  const line = c.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const ma = c.map((_, i) => _ma(c, 20, i)).map((v, i) => v == null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).filter(Boolean).join(' ');
  const m = p.marks || {};
  let extra = '';
  if (m.cs != null) extra += `<rect x="${X(m.cs)}" y="${pad}" width="${X(m.ce) - X(m.cs)}" height="${H - pad * 2}" class="pz"/>`;
  if (m.lo != null) extra += `<circle cx="${X(m.lo)}" cy="${Y(c[m.lo])}" r="3" class="pl"/>`;
  if (m.pk != null) extra += `<circle cx="${X(m.pk)}" cy="${Y(c[m.pk])}" r="3.5" class="pp"/>`;
  if (m.tr != null) extra += `<circle cx="${X(m.tr)}" cy="${Y(c[m.tr])}" r="3" class="pl"/>`;
  extra += `<circle cx="${X(N - 1)}" cy="${Y(c[N - 1])}" r="4" class="${p.ok ? 'pt' : 'pn'}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="patsvg" role="img" aria-label="${esc(s.name)} 최근 120일 주가">${extra}<polyline points="${ma}" class="pm"/><polyline points="${line}" class="pc"/></svg>`;
}

function renderPatterns() {
  const box = $('#patList'); if (!box || !S.data) return;
  const key = $('#patType').value, mk = $('#patMarket').value, needFund = $('#patFund').checked, showAll = $('#patNear').checked;
  $('#patDesc').textContent = PAT[key].desc;
  const rows = [];
  S.data.stocks.forEach(s => {
    if (mk !== 'all' && s.market !== mk) return;
    if (s._ban && s._ban.length) return;
    const p = PAT_FN[key](s); if (!p) return;
    if (!p.ok && !showAll) return;
    if (needFund && !fundOk(s)) return;
    rows.push({ s, p, rank: p.score * 0.6 + (s._sc.total || 0) * 0.4 });
  });
  rows.sort((a, b) => (b.p.ok - a.p.ok) || (b.rank - a.rank));
  $('#patMeta').textContent = `${S.data.stocks.length}종목 중 ${rows.filter(r => r.p.ok).length}종목이 조건 충족${showAll ? ` (+ 거의 다 온 종목 ${rows.filter(r => !r.p.ok).length}개)` : ''}`;
  box.innerHTML = rows.slice(0, 40).map((r, i) => {
    const s = r.s;
    const fund = [s.op_turn ? '흑자 전환' : s.op_yoy != null ? `영업이익 ${pct(s.op_yoy, 0)}` : null, s.sales_yoy != null ? `매출 ${pct(s.sales_yoy, 0)}` : null,
      (s.roe3 || []).length ? `ROE ${fmt(s.roe3[0], 1)}%` : null, `실적점수 ${s._sc.earnings ?? '-'}`].filter(Boolean);
    return `<div class="rec pat" data-code="${esc(s.code)}">
      <div class="rec-h"><span class="rank">${i + 1}</span>
        <div class="nm"><b>${esc(s.name)}</b> ${r.p.ok ? '<span class="tag good">패턴 충족</span>' : '<span class="tag">거의 다 옴</span>'}<small>${esc(s.market === 'KOSPI' ? '코스피' : '코스닥')} · ${esc(s.sector)} · ${fmt(s.close)}원 <span class="${cls(s.chg)}">${pct(s.chg)}</span></small></div>
        <div class="rec-sc"><span class="score ${sCls(r.p.score)}">${r.p.score}</span><small>패턴점수</small></div></div>
      ${patSvg(s, r.p)}
      <div class="pat-steps">${r.p.steps.map(t => `<div>${t}</div>`).join('')}</div>
      <div class="rec-b">${fund.map(f => `<span class="tag">${esc(f)}</span>`).join('')}<span class="tag">종합 ${fmt(s._sc.total, 1)}</span></div>
    </div>`;
  }).join('') || '<div class="empty">지금 조건에 맞는 종목이 없습니다. "거의 다 온 종목도 보기"를 켜거나 실적 조건을 꺼 보세요.</div>';
  bindItems(box);
}

function initPattern() {
  const sel = $('#patType'); if (!sel) return;
  sel.innerHTML = Object.entries(PAT).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  ['patType', 'patMarket', 'patFund', 'patNear'].forEach(id => $('#' + id).onchange = renderPatterns);
  // 조건검색·문장검색에서도 쓸 수 있게 항목 등록
  FM.pat_pullback = { key: 'pat_pullback', label: '눌림목 반등 시작 패턴', group: '차트 패턴', type: 'bool', unit: '', get: s => { const p = patternPullback(s); return p ? p.ok : false; } };
  FM.pat_box = { key: 'pat_box', label: '박스권 돌파 패턴', group: '차트 패턴', type: 'bool', unit: '', get: s => { const p = patternBox(s); return p ? p.ok : false; } };
  FM.fund_ok = { key: 'fund_ok', label: '실적 좋은 회사(이익 증가·흑자 지속)', group: '차트 패턴', type: 'bool', unit: '', get: s => fundOk(s) };
  if (typeof GLOSS !== 'undefined') {
    GLOSS.pat_pullback = ['눌림목 반등', PAT.pullback.desc];
    GLOSS.pat_box = ['박스권 돌파', PAT.box.desc];
    GLOSS.fund_ok = ['실적 좋은 회사', '영업이익이 늘었고(또는 흑자 전환), 실적 점수 55점 이상, 최근 4분기 중 3분기 이상 이익을 낸 회사'];
  }
}
