/* 투자자 흐름 — 외국인 · 연기금(국민연금 등) · 기관 · 개인이 시장과 종목을 어떻게 사고팔고 있는지
   ① 시장 전체: /api/mflow (네이버 투자자별 매매동향 · 장중 시간대별 누적, 1분마다) — 안 되면 거래소 일별 자료
   ② 종목별: 보관 칸 live-inv 의 investors.json(거래소 · 최근 20거래일 외국인·연기금·기관합계·개인, 장중 잠정 → 18시 확정)
            + live-flow(장중 잠정 외국인·기관·개인, 하루 4번)로 오늘 값을 덧붙임
   ③ 누가 주가를 움직이는지(순매수와 등락의 상관), 외국인 평균 매수 단가, 국면·점수·해석·실전 조언 */
'use strict';

const INV = { RAW: 'https://raw.githubusercontent.com/antiworry22/stock-screener/live-inv/', d: null, st: null, m: null, mt: 0, list: 'accum', sel: null };
const IV_K = [['f', '외국인', 'var(--down)'], ['p', '연기금', 'var(--ok)'], ['i', '기관', '#8e44ad'], ['r', '개인', 'var(--warn)']];
const ivEok = v => v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) >= 10000 ? fmt(Math.abs(v) / 10000, 2) + '조' : fmt(Math.abs(v), Math.abs(v) < 10 ? 1 : 0) + '억'}`;
const ivDay = d => d ? `${+d.slice(4, 6)}/${+d.slice(6, 8)}` : '';
const ivSum = (a, n) => { const b = (a || []).slice(-n).filter(x => x != null); return b.length ? Math.round(b.reduce((p, x) => p + x, 0) * 10) / 10 : null; };
const ivStreak = a => { const v = (a || []).filter(x => x != null); if (!v.length || !v[v.length - 1]) return 0; const sg = Math.sign(v[v.length - 1]); let n = 0; for (let i = v.length - 1; i >= 0 && Math.sign(v[i]) === sg; i--) n++; return n * sg; };

async function invLoad() {
  let d = null, st = null;
  try { const r = await fetch(INV.RAW + 'investors.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) d = await r.json(); } catch (e) {}
  try { const r = await fetch(INV.RAW + 'status.json?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) st = await r.json(); } catch (e) {}
  INV.st = st;
  if (!d || !d.s || !S.data) return;
  if (INV.d && INV.d.meta.time === d.meta.time) return;
  INV.d = d; INV.all = null;
  S.data.stocks.forEach(s => {
    const x = d.s[s.code]; if (!x) return;
    s._inv = x;
    const p = x.p || [];
    s.pension_net5 = ivSum(p, 5); s.pension_streak = ivStreak(p);
  });
  if (typeof liveRefresh === 'function') liveRefresh('inv');
  renderInvTab();
}
async function invMarketLive(force) {
  const k = new Date(Date.now() + 9 * 3600e3), m = k.getUTCHours() * 60 + k.getUTCMinutes(), wd = k.getUTCDay();
  const open = wd >= 1 && wd <= 5 && m >= 535 && m <= 960;
  if (!force && Date.now() - INV.mt < (open ? 55e3 : 600e3)) return;
  INV.mt = Date.now();
  try { const r = await fetch('/api/mflow', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j.ok) INV.m = j; } } catch (e) {}
  renderInvMarket();
}

/* 종목별 시계열(억원): 거래소 20일 + 오늘 장중 잠정(외국인·기관·개인) */
function ivSeries(s) {
  const x = s && s._inv, days = (INV.d && INV.d.meta.days) || [];
  const o = { d: [...days], f: [...((x && x.f) || days.map(() => null))], p: [...((x && x.p) || days.map(() => null))], i: [...((x && x.i) || days.map(() => null))], r: [...((x && x.r) || days.map(() => null))], partial: INV.d && INV.d.meta.partial };
  const fl = s && s._flow;
  if (!x && fl && fl.ff && fl.dd) {   // 거래소 투자자별 자료가 아직 없으면 네이버 잠정 수급(외국인·기관·개인, 최근 10일)으로
    const dd = fl.dd.map(d => String(d).replace(/-/g, '')), cc = dd.map((d, i) => (fl.cc && fl.cc[i]) || (typeof shCloseAt === 'function' ? shCloseAt(s, d) : null) || s.close);
    const eok = (q, i) => q == null || !cc[i] ? null : Math.round(q * cc[i] / 1e7) / 10;
    return { d: dd, f: fl.ff.map(eok), i: (fl.ii || []).map(eok), r: (fl.pp || dd.map(() => null)).map(eok), p: dd.map(() => null), partial: !!(FLOW && FLOW.d && FLOW.d.meta.intraday), naverOnly: true };
  }
  if (fl && fl.d) {
    const fd = fl.d.replace(/-/g, '');
    if (!o.d.length || fd > o.d[o.d.length - 1]) { o.d.push(fd); o.f.push(fl.f1); o.i.push(fl.i1); o.r.push(fl.p1 != null ? fl.p1 : null); o.p.push(null); o.partial = true; o.flowAdd = true; }
  }
  return o;
}
function ivCorr(a, b) {
  const P = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x != null && y != null); if (P.length < 6) return null;
  const mx = P.reduce((s, p) => s + p[0], 0) / P.length, my = P.reduce((s, p) => s + p[1], 0) / P.length;
  let sxy = 0, sxx = 0, syy = 0; P.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function ivAnalyze(s) {
  if (!s) return null;
  const Z = ivSeries(s); if (!Z.d.length) return null;
  const C = Z.d.map(d => typeof shCloseAt === 'function' ? shCloseAt(s, d) : null);
  const R = C.map((c, i) => i && c && C[i - 1] ? (c / C[i - 1] - 1) * 100 : null);
  const sum = {}, st = {}, co = {}, today = {};
  IV_K.forEach(([k]) => { sum[k + 5] = ivSum(Z[k], 5); sum[k + 20] = ivSum(Z[k], 20); st[k] = ivStreak(Z[k]); co[k] = ivCorr(Z[k], R); today[k] = Z[k][Z[k].length - 1]; });
  // 외국인 평균 매수 단가(순매수한 날의 종가를 순매수 금액으로 가중)
  let a1 = 0, a2 = 0; Z.f.forEach((v, i) => { if (v > 0 && C[i]) { a1 += v; a2 += v / C[i]; } });
  const fAvg = a2 ? a1 / a2 : null, px = (s._live && s._live.c) || s.close, fPl = fAvg ? (px / fAvg - 1) * 100 : null;
  const tvAvg = (() => { const v = (s.spark_vol || []).slice(-20), c = (s.spark || []).slice(-20); const t = v.map((x, i) => x && c[i] ? x * c[i] / 1e8 : null).filter(x => x); return t.length ? t.reduce((p, x) => p + x, 0) / t.length : s.tvalue || null; })();
  const nz = v => v == null || !tvAvg ? 0 : v / (tvAvg * 5);
  const ret5 = s.ret5 || 0;
  // 점수(−100~+100): 외국인·연기금·기관 5일 순매수(하루 평균 거래대금 대비) − 개인이 혼자 사는 경우 감점
  let sc = 400 * (0.45 * nz(sum.f5) + 0.3 * nz(sum.p5) + 0.2 * nz((sum.i5 || 0) - (sum.p5 || 0)));
  if ((sum.r5 || 0) > 0 && (sum.f5 || 0) < 0 && (sum.i5 || 0) < 0) sc -= 20;
  if ((sum.f20 || 0) > 0 && (sum.p20 || 0) > 0) sc += 10;
  sc = Math.round(Math.max(-100, Math.min(100, sc)));
  // 누가 주가를 움직이나: 등락과 순매수 상관이 가장 높은 주체
  const drv = IV_K.map(([k, n]) => ({ k, n, c: co[k] })).filter(x => x.c != null).sort((a, b) => b.c - a.c)[0];
  // 국면
  const f5 = sum.f5 || 0, p5 = sum.p5 || 0, i5 = sum.i5 || 0, r5 = sum.r5 || 0, f20 = sum.f20 || 0, p20 = sum.p20 || 0;
  const big = v => tvAvg ? Math.abs(v) >= tvAvg * 0.05 : Math.abs(v) >= 5;
  const fPrev = Z.f.slice(-4, -1).filter(x => x != null);
  let rg;
  if (today.f > 0 && fPrev.length >= 2 && fPrev.every(x => x < 0) && big(today.f)) rg = ['turn', '외국인 매수 전환', `외국인이 ${fPrev.length}일 연속 팔다가 오늘 ${ivEok(today.f)} 순매수로 돌아섰어요. 전환 첫날은 하루 반짝일 수 있으니 2~3일 이어지는지 확인하세요.`];
  else if (f20 > 0 && p20 > 0 && (f5 > 0 || p5 > 0) && big(f20 + p20)) rg = ['accum', '외국인·연기금 동반 매집', `20일 동안 외국인 ${ivEok(f20)}, 연기금 ${ivEok(p20)}을 함께 샀어요. 긴 호흡의 큰돈 두 곳이 같은 방향이라, 눌림이 와도 받쳐줄 가능성이 높은 종목이에요.`];
  else if (r5 > 0 && f5 < 0 && i5 < 0 && big(r5)) rg = ['retail', '개인만 사는 중', `최근 5일 개인이 ${ivEok(r5)} 사는 동안 외국인(${ivEok(f5)})·기관(${ivEok(i5)})은 팔았어요. 큰손 물량을 개인이 받아주는 모습이라, 오르더라도 오래가기 어렵고 내리면 크게 빠지기 쉬워요.`];
  else if (ret5 < -2 && p5 > 0 && big(p5)) rg = ['dip', '연기금 저가 매수', `주가가 1주 ${pct(ret5, 1)} 빠지는 동안 연기금은 ${ivEok(p5)} 샀어요. 연기금은 길게 보고 싼 값에 모으는 편이라 하락 속도를 늦추는 버팀목이 되기도 해요.`];
  else if (f5 > 0 && ret5 > 0 && big(f5)) rg = ['fdrive', '외국인 주도 상승', `최근 5일 외국인이 ${ivEok(f5)} 사면서 주가가 ${pct(ret5, 1)} 올랐어요.${r5 < 0 ? ` 개인은 ${ivEok(r5)} 팔아 차익을 챙기는 중이에요.` : ''} 외국인 매수가 멈추는 날이 첫 경고 신호예요.`];
  else if (f5 < 0 && i5 < 0 && big(f5 + i5)) rg = ['exit', '큰손 동반 매도', `최근 5일 외국인 ${ivEok(f5)}, 기관 ${ivEok(i5)} — 큰손이 함께 빠지는 중이에요. 반등이 나와도 위에서 물량이 나오기 쉬워요.`];
  else rg = ['mixed', '뚜렷한 주체 없음', '주체별 순매수가 작거나 엇갈려요. 수급보다는 차트·실적 신호를 보세요.'];
  return { Z, C, R, sum, st, co, today, fAvg, fPl, px, tvAvg, sc, drv, rg };
}
function ivTodo(a) {
  const T = [];
  const m = { turn: '외국인 전환 2~3일째 확인 뒤 분할 매수 — 첫날 추격은 피하기', accum: '눌림(20일선 근처)에서 분할 매수 후보 — 외국인·연기금이 동시에 팔기 시작하면 정리', retail: '신규 매수 보류, 보유 중이면 반등 때 비중 줄이기 — 외국인·기관이 다시 살 때까지', dip: '연기금이 받치는 가격대를 지지선으로 보고 손절선은 그 아래로', fdrive: '외국인 순매수가 이어지는 동안 보유, 외국인 순매도 2일 연속이면 일부 이익 실현', exit: '반등 때 정리 우선, 새로 사지 않기', mixed: '수급 신호보다 차트·거래대금·실적 위주로 판단' };
  T.push(m[a.rg[0]]);
  if (a.fPl != null && a.fAvg) T.push(a.fPl < -3 ? `지금 가격이 외국인 평균 매수 단가(약 ${fmt(Math.round(a.fAvg))}원)보다 ${fmt(-a.fPl, 1)}% 낮아요 — 외국인도 손해 구간이라 이 가격대에서 버티거나 더 살 가능성` : a.fPl > 10 ? `외국인 평균 매수 단가보다 ${fmt(a.fPl, 1)}% 높아요 — 외국인이 이익을 챙기는 매도가 나올 수 있는 구간` : `외국인 평균 매수 단가(약 ${fmt(Math.round(a.fAvg))}원) 근처 — 이 가격이 단기 지지선 역할`);
  return T;
}

/* 누적 순매수 선 그래프(SVG) */
function ivLines(Z, ks) {
  const W = 560, H = 150, n = Z.d.length; if (n < 2) return '';
  const cum = ks.map(([k]) => { let a = 0; return Z[k].map(v => (a += v || 0, Math.round(a * 10) / 10)); });
  const all = cum.flat(), mn = Math.min(0, ...all), mx = Math.max(0, ...all), sp = mx - mn || 1;
  const X = i => 30 + i / (n - 1) * (W - 40), Y = v => 8 + (mx - v) / sp * (H - 24);
  const lines = cum.map((c, j) => `<polyline fill="none" stroke="${ks[j][2]}" stroke-width="2" points="${c.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"><title>${ks[j][1]} 누적 ${ivEok(c[c.length - 1])}</title></polyline><circle cx="${X(n - 1)}" cy="${Y(c[n - 1])}" r="3" fill="${ks[j][2]}"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="iv-svg" role="img" aria-label="주체별 누적 순매수"><line x1="30" x2="${W - 10}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--line)" stroke-dasharray="3 3"/>${lines}<text x="2" y="${Y(0) + 4}" font-size="10" fill="var(--muted)">0</text><text x="30" y="${H - 2}" font-size="10" fill="var(--muted)">${ivDay(Z.d[0])}</text><text x="${W - 10}" y="${H - 2}" font-size="10" fill="var(--muted)" text-anchor="end">${ivDay(Z.d[n - 1])}${Z.partial ? '(잠정)' : ''}</text></svg>
    <div class="iv-leg">${ks.map(([k, n2, c], j) => `<span><i style="background:${c}"></i>${n2} ${ivEok(cum[j][cum[j].length - 1])}</span>`).join('')}</div>`;
}

/* 종목 카드 (종목 분석 · 투자자 흐름 탭) */
function invHtml(s) {
  if (!INV.d && !(s && s._flow)) return `<div class="hint">${INV.st ? `투자자별 자료 문제: ${esc(INV.st.msg || '')}` : '투자자별 자료를 불러오는 중이에요(장중 4번 잠정 · 장 마감 뒤 확정).'}</div>`;
  const a = ivAnalyze(s); if (!a) return '<div class="hint">이 종목은 투자자별 자료가 없어요.</div>';
  const Z = a.Z, last10 = Z.d.slice(-10).map((d, j) => Z.d.length - 10 + j).filter(i => i >= 0);
  const cell = v => `<td class="mono ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v == null ? '–' : ivEok(v)}</td>`;
  return `<div class="iv-wrap">
    ${typeof ivVerdictHtml === 'function' ? ivVerdictHtml(s, a) : ''}
    <div class="sh-top">
      <div class="sh-score ${a.sc >= 15 ? 'good' : a.sc <= -15 ? 'bad' : ''}"><small>수급 점수</small><b>${a.sc > 0 ? '+' : ''}${a.sc}</b><span>${a.sc >= 40 ? '큰손 강한 매수' : a.sc >= 15 ? '큰손 매수 우위' : a.sc <= -40 ? '큰손 강한 매도' : a.sc <= -15 ? '큰손 매도 우위' : '중립'}</span></div>
      <div class="sh-reg iv-r-${a.rg[0]}"><small>지금 국면</small><b>${esc(a.rg[1])}</b><p>${esc(a.rg[2])}</p></div>
    </div>
    <dl class="sh-kpi iv-kpi">${IV_K.map(([k, n]) => `<div><dt>${n}</dt><dd class="${(a.sum[k + 5] || 0) > 0 ? 'up' : (a.sum[k + 5] || 0) < 0 ? 'down' : ''}">${ivEok(a.sum[k + 5])}</dd><em>5일 · 20일 ${ivEok(a.sum[k + 20])} · ${a.st[k] > 0 ? a.st[k] + '일 연속 매수' : a.st[k] < 0 ? -a.st[k] + '일 연속 매도' : '–'}</em></div>`).join('')}
      <div><dt>외국인 평균 매수가</dt><dd>${a.fAvg ? fmt(Math.round(a.fAvg)) + '원' : '–'}</dd><em class="${a.fPl > 0 ? 'up' : a.fPl < 0 ? 'down' : ''}">${a.fPl != null ? `지금가 대비 ${a.fPl > 0 ? '+' : ''}${fmt(a.fPl, 1)}%` : ''}</em></div></dl>
    <p class="sh-live">${Z.partial ? '<span class="gov-live"></span> 오늘 값은 거래소 장중 잠정치(외국인·기관·개인 · 하루 4번) — 연기금은 장 마감 뒤 확정' : '장 마감 확정치'} · ${ivDay(Z.d[0])}~${ivDay(Z.d[Z.d.length - 1])} ${Z.d.length}거래일</p>
    <h5 class="sh-h">주체별 누적 순매수 (${Z.d.length}거래일)</h5>
    ${ivLines(Z, IV_K)}
    ${a.drv ? `<p class="iv-drv"><b>주가를 움직이는 주체: ${a.drv.n}</b> — 날마다 ${a.drv.n} 순매수와 주가 등락이 같은 방향으로 움직인 정도(상관 ${fmt(a.drv.c, 2)})가 가장 높아요. ${a.drv.c >= 0.5 ? `${a.drv.n}이 사면 오르고 팔면 내리는 종목이라, ${a.drv.n} 흐름을 가장 먼저 보세요.` : '다만 상관이 강하지 않아 한 주체가 주가를 좌우한다고 보긴 어려워요.'}</p>` : ''}
    <div class="table-wrap"><table class="tbl iv-tb"><thead><tr><th class="l">날짜</th><th>종가</th>${IV_K.map(([, n]) => `<th>${n}</th>`).join('')}</tr></thead><tbody>
      ${last10.slice().reverse().map(i => `<tr><td class="l mono">${ivDay(Z.d[i])}${i === Z.d.length - 1 && Z.partial ? ' <small class="muted">잠정</small>' : ''}</td><td class="mono">${a.C[i] ? fmt(a.C[i]) : '–'} <small class="${cls(a.R[i])}">${a.R[i] != null ? pct(a.R[i], 1) : ''}</small></td>${IV_K.map(([k]) => cell(Z[k][i])).join('')}</tr>`).join('')}
    </tbody></table></div>
    <h5 class="sh-h">실전에서는</h5>
    <ul class="sh-todo">${ivTodo(a).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    <details class="hint"><summary>용어 · 자료</summary><b>연기금</b>은 국민연금 등 연금·기금(거래소 분류 「연기금등」), <b>기관</b>은 연기금을 포함한 기관 합계(증권사·보험·투신·사모·은행 등), <b>순매수</b>는 산 금액 − 판 금액이에요. 거래소는 외국인·기관을 장중 4번(9:30·11:00·13:20·14:30 무렵) 잠정 공개하고, 연기금 같은 세부 기관과 확정치는 장 마감 뒤 공개해요. <b>외국인 평균 매수가</b>는 외국인이 순매수한 날의 종가를 금액으로 가중한 추정치예요.</details>
  </div>`;
}

/* ── 시장 전체(실시간) ── */
function ivMktRows(m) {
  const L = INV.m && INV.m.mkt && INV.m.mkt[m];
  if (L && L.time && L.time.length) return { live: true, rows: L.time.slice().reverse(), at: INV.m.at };
  if (L && L.day && L.day.length) return { live: false, rows: [L.day[0]], at: INV.m.at, day: true };
  const K = INV.d && INV.d.mkt && INV.d.mkt[m];
  if (K && K.d) { const i = K.d.length - 1; const o = { t: ivDay(K.d[i]) }; ['개인', '외국인', '연기금', '기관합계'].forEach(c => { if (K[c]) o[c === '기관합계' ? '기관' : c] = K[c][i]; });
    if (o['기관'] == null) { const sub = ['금융투자', '보험', '투신', '사모', '은행', '기타금융', '연기금'].filter(c => K[c]); if (sub.length) o['기관'] = sub.reduce((a, c) => a + (K[c][i] || 0), 0); }
    return { live: false, rows: [o], krx: true }; }
  return null;
}
function ivMktCard(m) {
  const X = ivMktRows(m); const nm = m === 'KOSPI' ? '코스피' : '코스닥';
  if (!X) return `<div class="iv-mkt"><h4>${nm}</h4><p class="hint">시장 투자자별 자료를 받는 중이에요.</p></div>`;
  const last = X.rows[X.rows.length - 1], ks = [['개인', 'var(--warn)'], ['외국인', 'var(--down)'], ['기관', '#8e44ad'], ['연기금', 'var(--ok)']];
  const big = ks.map(([k]) => last[k]).filter(v => v != null);
  const lead = ks.filter(([k]) => last[k] != null).sort((a, b) => (last[b[0]] || 0) - (last[a[0]] || 0));
  const buyer = lead[0], seller = lead[lead.length - 1];
  let line = '';
  const ga = w => { const c = w.charCodeAt(w.length - 1); return w + (c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '이' : '가'); };
  if (buyer && seller && buyer !== seller) line = `${ga(buyer[0])} ${ivEok(last[buyer[0]])} 사고 ${ga(seller[0])} ${ivEok(last[seller[0]])} 팔고 있어요.${last['외국인'] > 0 && last['개인'] < 0 ? ' 외국인이 사고 개인이 파는 날은 지수가 오르는 경우가 많아요.' : last['외국인'] < 0 && last['개인'] > 0 ? ' 개인이 외국인 물량을 받는 날은 지수 상승이 약하거나 밀리는 경우가 많아요.' : ''}`;
  // 시간대별 누적 선
  let chart = '';
  if (X.live && X.rows.length >= 2) {
    const W = 300, H = 90, n = X.rows.length, vals = ks.flatMap(([k]) => X.rows.map(r => r[k]).filter(v => v != null)), mn = Math.min(0, ...vals), mx = Math.max(0, ...vals), sp = mx - mn || 1;
    const xx = i => 4 + i / (n - 1) * (W - 8), yy = v => 4 + (mx - v) / sp * (H - 14);
    chart = `<svg viewBox="0 0 ${W} ${H}" class="iv-msvg" role="img" aria-label="${nm} 시간대별 누적 순매수"><line x1="0" x2="${W}" y1="${yy(0)}" y2="${yy(0)}" stroke="var(--line)" stroke-dasharray="3 3"/>${ks.map(([k, c]) => { const p = X.rows.map((r, i) => r[k] == null ? null : `${xx(i).toFixed(1)},${yy(r[k]).toFixed(1)}`).filter(Boolean); return p.length ? `<polyline fill="none" stroke="${c}" stroke-width="1.8" points="${p.join(' ')}"/>` : ''; }).join('')}<text x="2" y="${H - 1}" font-size="9" fill="var(--muted)">${esc(X.rows[0].t)}</text><text x="${W - 2}" y="${H - 1}" font-size="9" fill="var(--muted)" text-anchor="end">${esc(last.t)}</text></svg>`;
  }
  return `<div class="iv-mkt"><h4>${nm} <small>${X.live ? `<span class="gov-live"></span> ${esc(last.t)} 누적` : X.krx ? `${esc(last.t)} 거래소 확정` : '오늘'}</small></h4>
    <dl>${ks.map(([k, c]) => last[k] == null ? '' : `<div><dt><i style="background:${c}"></i>${k}</dt><dd class="${last[k] > 0 ? 'up' : last[k] < 0 ? 'down' : ''}">${ivEok(last[k])}</dd></div>`).join('')}</dl>
    ${chart}${line ? `<p>${esc(line)}</p>` : ''}</div>`;
}
function renderInvMarket() {
  const box = $('#ivMkt'); if (!box) return;
  box.innerHTML = ivMktCard('KOSPI') + ivMktCard('KOSDAQ');
  if (typeof renderIvLive === 'function') { try { renderIvLive(); } catch (e) { console.error(e); } }
  const K = INV.d && INV.d.mkt && INV.d.mkt.KOSPI;
  const h = $('#ivMktHist');
  if (h && K && K.d && K.d.length > 1) {
    const ks = [['외국인', 'var(--down)'], ['연기금', 'var(--ok)'], ['개인', 'var(--warn)']].filter(([k]) => K[k]);
    const n = K.d.length;
    h.innerHTML = `<h5 class="sh-h">코스피 주체별 일별 순매수 (최근 ${n}거래일)</h5><div class="iv-days">${K.d.map((d, i) => `<div class="iv-dcol" title="${ivDay(d)}${ks.map(([k]) => ` · ${k} ${ivEok(K[k][i])}`).join('')}">${ks.map(([k, c]) => { const v = K[k][i] || 0, mx = Math.max(...ks.flatMap(([kk]) => K[kk].map(x => Math.abs(x || 0)))) || 1; return `<i style="height:${Math.abs(v) / mx * 40}px;background:${c};${v < 0 ? 'opacity:.45' : ''}"></i>`; }).join('')}<span>${+d.slice(6, 8)}</span></div>`).join('')}</div><p class="hint">진한 막대는 순매수, 옅은 막대는 순매도예요. ${ks.map(([k, c]) => `<b style="color:${c}">■</b> ${k}`).join(' ')}</p>`;
  }
}

/* ── 종목 목록 ── */
const IV_LISTS = [
  ['accum', '외국인·연기금 동반 매집', a => a.rg[0] === 'accum', (a, b) => (b.sum.f20 + b.sum.p20) - (a.sum.f20 + a.sum.p20)],
  ['turn', '외국인 매수 전환', a => a.rg[0] === 'turn', (a, b) => b.today.f - a.today.f],
  ['fbuy', '오늘 외국인 순매수 상위', a => (a.today.f || 0) > 0, (a, b) => b.today.f - a.today.f],
  ['pbuy', '연기금 5일 순매수 상위', a => (a.sum.p5 || 0) > 0, (a, b) => b.sum.p5 - a.sum.p5],
  ['dip', '연기금 저가 매수', a => a.rg[0] === 'dip', (a, b) => b.sum.p5 - a.sum.p5],
  ['fdrive', '외국인 주도 상승', a => a.rg[0] === 'fdrive', (a, b) => b.sum.f5 - a.sum.f5],
  ['retail', '개인만 사는 중(주의)', a => a.rg[0] === 'retail', (a, b) => b.sum.r5 - a.sum.r5],
  ['exit', '큰손 동반 매도(주의)', a => a.rg[0] === 'exit', (a, b) => (a.sum.f5 + a.sum.i5) - (b.sum.f5 + b.sum.i5)],
];
function ivAll() {
  if (INV.all && INV.allT === (INV.d && INV.d.meta.time) + (typeof FLOW !== 'undefined' && FLOW.d ? FLOW.d.meta.time : '')) return INV.all;
  INV.all = S.data.stocks.filter(s => s._inv || s._flow).map(s => { try { return { s, a: ivAnalyze(s) }; } catch (e) { return null; } }).filter(x => x && x.a);
  INV.allT = (INV.d && INV.d.meta.time) + (typeof FLOW !== 'undefined' && FLOW.d ? FLOW.d.meta.time : '');
  return INV.all;
}
function renderInvTab() {
  const box = $('#ivList'); if (!box || !S.data) return;
  const m = INV.d && INV.d.meta;
  $('#ivMeta').innerHTML = m ? `<span class="gov-live"></span> 종목별 ${esc(m.time.slice(5))} 받음 · ${ivDay(m.days[0])}~${ivDay(m.days[m.days.length - 1])}${m.partial ? '(오늘 잠정)' : ''} · ${m.n}종목 · 시장 전체는 장중 1분마다`
    : INV.st ? `종목별 투자자 자료 문제: ${esc(INV.st.msg || '')} — 외국인·기관·개인 잠정치만 보여줘요` : '종목별 투자자 자료를 불러오는 중이에요(첫 수집 전이면 외국인·기관·개인 잠정치만 보여줘요).';
  renderInvMarket();
  const all = ivAll(), L = IV_LISTS.find(x => x[0] === INV.list) || IV_LISTS[0];
  $('#ivChips').innerHTML = IV_LISTS.map(([k, n, f]) => `<button class="chip ${k === L[0] ? 'on' : ''}" data-ivl="${k}">${n} <b>${all.filter(r => { try { return f(r.a); } catch (e) { return false; } }).length}</b></button>`).join('');
  $$('#ivChips [data-ivl]').forEach(b => b.onclick = () => { INV.list = b.dataset.ivl; renderInvTab(); });
  const rows = all.filter(r => { try { return L[2](r.a); } catch (e) { return false; } }).sort((p, q) => { try { return L[3](p.a, q.a); } catch (e) { return 0; } }).slice(0, 60);
  box.innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl iv-tb"><thead><tr><th class="l">종목</th><th>현재가</th><th>수급 점수</th><th class="l">국면</th><th>외국인 오늘</th><th>외국인 5일</th><th>연기금 5일</th><th>기관 5일</th><th>개인 5일</th><th>외국인 연속</th></tr></thead><tbody>${rows.map(({ s, a }) => `<tr data-ivs="${esc(s.code)}">
    <td class="l"><b>${esc(s.name)}</b> <small class="muted">${s.market === 'KOSPI' ? '코스피' : '코스닥'}</small></td>
    <td class="mono">${fmt(a.px)} <small class="${cls(s._live ? s._live.chg : s.chg)}">${pct(s._live ? s._live.chg : s.chg, 1)}</small></td>
    <td class="mono"><b class="${a.sc > 0 ? 'up' : a.sc < 0 ? 'down' : ''}">${a.sc > 0 ? '+' : ''}${a.sc}</b></td>
    <td class="l"><span class="sh-rg iv-r-${a.rg[0]}">${esc(a.rg[1])}</span></td>
    ${['today.f', 'sum.f5', 'sum.p5', 'sum.i5', 'sum.r5'].map(p => { const [o, k] = p.split('.'), v = a[o][k]; return `<td class="mono ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${ivEok(v)}</td>`; }).join('')}
    <td class="mono">${a.st.f > 0 ? a.st.f + '일 매수' : a.st.f < 0 ? -a.st.f + '일 매도' : '–'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">지금 이 조건에 맞는 종목이 없어요.</div>';
  $$('#ivList [data-ivs]').forEach(tr => tr.onclick = () => ivSelect(tr.dataset.ivs));
  if (INV.sel) ivSelect(INV.sel, true);
}
function ivSelect(code, quiet) {
  const s = S.data.stocks.find(x => x.code === code), box = $('#ivOne'); if (!s || !box) return;
  INV.sel = code;
  box.innerHTML = `<div class="an-card an-wide"><h4>${esc(s.name)} <span class="muted mono">${esc(s.code)}</span> 투자자별 흐름 <button class="btn ghost small" id="ivAn">종목 분석</button> <button class="btn ghost small" id="ivX">닫기</button></h4>${invHtml(s)}</div>`;
  $('#ivAn').onclick = () => showAnalysis(code);
  $('#ivX').onclick = () => { INV.sel = null; box.innerHTML = ''; };
  if (!quiet) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function invChip() {
  const m = INV.d && INV.d.meta;
  return m ? `투자자별(연기금·개인) <b>${esc(m.time.slice(11))}</b> <small>${m.n}종목${m.partial ? ' · 오늘 잠정' : ''}</small>` : `투자자별 <b>${INV.st ? '수집 오류' : '대기'}</b>`;
}
function initInv() {
  invLoad(); setInterval(invLoad, 300e3);
  setInterval(() => { const on = $('#tab-inv') && $('#tab-inv').classList.contains('on'); if (on && !document.hidden) invMarketLive(); }, 15e3);
  const go = () => { const q = ($('#ivQ').value || '').trim(); if (!q) return; const h = findStocks(q); if (!h.length) { alert(`"${q}"과(와) 맞는 종목이 없어요`); return; } ivSelect(h[0].code); };
  if ($('#ivQ')) { $('#ivGo').onclick = go; $('#ivQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }; }
  const tb = $('button[data-tab="inv"]'); if (tb) tb.addEventListener('click', () => { renderInvTab(); invMarketLive(true); });
  if ($('#tab-inv') && $('#tab-inv').classList.contains('on')) { renderInvTab(); invMarketLive(true); }
  if (typeof FM !== 'undefined') {
    const g = '투자자 흐름', A = s => { try { return ivAnalyze(s); } catch (e) { return null; } };
    FM.iv_score = { key: 'iv_score', label: '수급 점수(외국인·연기금·기관, −100~+100)', group: g, type: 'num', unit: '점', get: s => { const a = (s._inv || s._flow) && A(s); return a ? a.sc : null; } };
    FM.iv_reg = { key: 'iv_reg', label: '투자자 흐름 국면', group: g, type: 'enum', unit: '', opts: IV_LISTS.map(x => x[1].replace(/\(.*\)/, '')).concat(['뚜렷한 주체 없음']), get: s => { const a = (s._inv || s._flow) && A(s); return a ? a.rg[1] : null; } };
    FM.iv_p20 = { key: 'iv_p20', label: '연기금 20일 순매수(억원)', group: g, type: 'num', unit: '억', get: s => s._inv && s._inv.p ? ivSum(s._inv.p, 20) : null };
    FM.iv_r5 = { key: 'iv_r5', label: '개인 5일 순매수(억원)', group: g, type: 'num', unit: '억', get: s => { const a = (s._inv || s._flow) && A(s); return a ? a.sum.r5 : null; } };
  }
}
(function waitBootInv() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc && typeof findStocks === 'function') initInv();
  else setTimeout(waitBootInv, 600);
})();
