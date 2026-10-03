/* 쉬운 용어 설명 + 종합 추천 종목 */
'use strict';

// 항목키 → [쉬운 이름, 쉬운 설명]
const GLOSS = {
  name: ['종목', '회사 이름과 종목코드입니다.'],
  sector: ['업종', '회사가 속한 산업 분야입니다. 예) 전기전자, 제약, 금융'],
  market: ['시장', '코스피(큰 회사 위주) 또는 코스닥(중소·성장 기업 위주)'],
  close: ['현재가', '기준일 마지막 거래 가격(종가)입니다.'],
  chg: ['오늘 변화', '전날보다 몇 % 오르거나(+) 내렸는지(−)입니다. (등락률)'],
  ret5: ['1주 수익률', '최근 5거래일(약 1주) 동안 몇 % 올랐는지입니다.'],
  ret20: ['1달 수익률', '최근 20거래일(약 1달) 동안 몇 % 올랐는지입니다.'],
  mcap: ['회사 크기', '시가총액(억원) — 주가 × 주식 수, 회사 전체의 시장 가격입니다.'],
  total: ['종합 점수', '아래 5가지 점수를 설정한 비중대로 합친 100점 만점 점수입니다. 높을수록 여러 조건이 고르게 좋습니다.'],
  technical: ['차트 신호', '거래량·RSI·이동평균선 등 그래프 모양이 매수에 유리한 정도입니다. (지표 점수)'],
  supply: ['큰손 매수', '외국인·기관·연기금 같은 큰 투자자들이 이 주식을 사고 있는 정도입니다. (수급 점수)'],
  earnings: ['돈 버는 힘', '매출·영업이익 증가, 증권사 목표주가, 좋은 공시 등 실적 전망입니다. (실적 점수)'],
  sector_sc: ['업종 분위기', '같은 업종 주식들의 흐름과 전날 미국 증시 영향이 좋은 정도입니다. (섹터 점수)'],
  stability: ['재무 튼튼함', '빚이 적고, 현금이 들어오고, 꾸준히 이익을 내는 정도입니다. (안정성 점수)'],
  vol_ratio: ['평소 대비 거래량', '오늘 거래량이 최근 20일 평균의 몇 배인지입니다. 2배 이상이면 관심이 몰린 것입니다.'],
  tv_ratio: ['평소 대비 거래금액', '오늘 거래금액이 최근 20일 평균의 몇 배인지입니다.'],
  tvalue: ['거래 금액', '하루 동안 거래된 금액(억원)입니다.'],
  rsi: ['과열 정도(RSI)', '0~100 사이 숫자. 30 이하면 많이 떨어져 싸 보이는 상태, 70 이상이면 많이 올라 과열된 상태입니다.'],
  tech3: ['반등 신호 수', 'RSI·MACD·볼린저밴드 3가지 매수 신호 중 몇 개가 켜졌는지(0~3)입니다.'],
  bb_pb: ['밴드 내 위치', '최근 가격 범위(볼린저밴드)에서 아래(0)~위(1) 중 어디쯤인지입니다.'],
  pos52: ['1년 고점 대비', '현재가 ÷ 최근 1년 최고가. 0.7이면 고점보다 30% 싸게 거래되는 상태입니다.'],
  low_tests: ['바닥 확인 횟수', '최근 6개월 최저가 근처까지 내려왔다가 반등한 횟수입니다. 많을수록 바닥이 단단합니다.'],
  ma_align: ['상승 추세', '5일·20일·120일 평균 가격선이 모두 위를 향하고 순서대로 놓인 상태(정배열)입니다.'],
  sr20: ['20일선 위치', '주가가 최근 20일 평균 가격보다 위(지지)인지 아래(저항·이탈)인지입니다.'],
  foreign_streak: ['외국인 연속 매수일', '외국인이 며칠 연속 샀는지(+) 팔았는지(−)입니다.'],
  foreign_net5: ['외국인 5일 매수액', '최근 5일 동안 외국인이 산 금액에서 판 금액을 뺀 값(억원)입니다.'],
  inst_streak: ['기관 연속 매수일', '기관(증권사·자산운용사 등)이 며칠 연속 샀는지(+) 팔았는지(−)입니다.'],
  inst_net5: ['기관 5일 매수액', '최근 5일 동안 기관이 순수하게 산 금액(억원)입니다.'],
  pension_streak: ['연기금 연속 매수일', '국민연금 등 연기금이 며칠 연속 샀는지입니다.'],
  pension_net5: ['연기금 5일 매수액', '최근 5일 동안 연기금이 순수하게 산 금액(억원)입니다.'],
  pension_5pct: ['연기금 5% 보유 공시', '국민연금이 이 회사 주식을 5% 넘게 보유했다고 공시한 경우입니다.'],
  foreign_hold: ['외국인 보유 비율', '전체 주식 중 외국인이 가진 비율(%)입니다.'],
  exhaustion: ['외국인 한도 사용률', '외국인이 살 수 있는 한도 중 이미 산 비율. 높으면 더 사기 어렵습니다.'],
  debt_ratio: ['부채비율', '자기 돈 대비 빚의 비율(%). 100% 이하면 빚이 자기 돈보다 적다는 뜻입니다. (금융회사는 제외)'],
  current_ratio: ['단기 지급 능력', '1년 안에 갚을 빚 대비 1년 안에 현금화할 자산 비율(유동비율). 100% 이상이 안정적입니다.'],
  ocf: ['본업 현금 유입', '장사를 해서 실제로 들어온 현금(영업현금흐름, 억원). 플러스면 좋습니다.'],
  profit_q: ['흑자 분기 수', '최근 4개 분기 중 영업이익이 흑자였던 분기 수입니다.'],
  op_yoy: ['영업이익 증가율', '작년 같은 분기보다 본업 이익(영업이익)이 몇 % 늘었는지입니다.'],
  sales_yoy: ['매출 증가율', '작년 같은 분기보다 매출이 몇 % 늘었는지입니다.'],
  op_turn: ['흑자 전환', '작년엔 적자였는데 올해 흑자로 돌아선 경우입니다.'],
  upside: ['목표가까지 여유', '증권사 평균 목표주가가 현재가보다 몇 % 높은지입니다. (1년 기준 전망)'],
  news_score: ['뉴스 분위기', '최근 뉴스 제목이 긍정적(+1)인지 부정적(−1)인지입니다.'],
  sector_rel5: ['업종 강도', '이 업종이 최근 5일 동안 시장 전체보다 몇 %p 더 올랐는지입니다.'],
  us_impact: ['미국장 영향', '전날 밤 미국 증시(특히 관련 업종)가 이 업종에 줄 것으로 예상되는 영향(%)입니다.'],
  short_ratio: ['공매도 비중', '하락에 베팅한 물량(공매도 잔고)이 전체 주식에서 차지하는 비율(%)입니다.'],
  short_chg: ['공매도 증가', '최근 5일 동안 공매도 비중이 얼마나 늘었는지(%p)입니다. 늘면 주의.'],
  atr_pct: ['하루 흔들림', '하루에 평균 몇 % 정도 오르내리는지(변동성)입니다.'],
  stop: ['손절가', '이 가격 아래로 내려가면 손실을 줄이기 위해 파는 기준 가격입니다. (매수가 − 평소 흔들림 폭 × 2)'],
  qty: ['권장 수량', '설정한 운용 자본에서 손절 시 1%만 잃도록 계산한 매수 주식 수입니다.'],
};

function easyOn() { return store.get('easy', true); }
function glossLabel(k, fallback) { return easyOn() && GLOSS[k] ? GLOSS[k][0] : fallback; }
function glossDesc(k) { return GLOSS[k] ? GLOSS[k][1] : (FM[k] ? FM[k].label : ''); }
function thHtml(c, sortState) {
  const [k, label, cls] = c;
  const sorted = sortState && sortState.key === k ? 'sorted' + (sortState.asc ? ' asc' : '') : '';
  return `<th class="${cls || ''} ${sorted}" data-k="${k}" title="${esc(glossDesc(k))}">${esc(glossLabel(k, label))}${GLOSS[k] ? '<span class="qm">?</span>' : ''}</th>`;
}
function glossaryHtml(keys) {
  return `<div class="gloss">${keys.filter(k => GLOSS[k]).map(k =>
    `<div><b>${GLOSS[k][0]}</b>${FM[k] && FM[k].label.replace(/^[①-⑭+] /, '') !== GLOSS[k][0] ? ` <span class="muted">(${esc(FM[k].label.replace(/^[①-⑭+] /, ''))})</span>` : ''}<p>${GLOSS[k][1]}</p></div>`).join('')}</div>`;
}

/* ═════════ 종합 추천 ═════════ */
function recReasons(s) {
  const T = S.th, r = [];
  if (s.foreign_streak >= 3) r.push(`외국인 ${s.foreign_streak}일 연속 매수`);
  if (s.inst_streak >= 3) r.push(`기관 ${s.inst_streak}일 연속 매수`);
  if (s.pension_5pct) r.push('국민연금 5% 보유 공시');
  else if ((s.pension_net5 || 0) > 0 && (s.pension_streak || 0) >= 2) r.push('연기금 매수 중');
  if (s.ma_align) r.push('상승 추세(평균선 정배열)');
  if ((s.tech3 || 0) >= 2) r.push(`반등 신호 ${s.tech3}개 켜짐`);
  if (s.vol_ratio >= T.volume_ratio && s.chg > 0) r.push(`평소 ${s.vol_ratio}배 거래량과 상승`);
  if (s.pos52 != null && s.pos52 < T.pos52_undervalued && (s.low_tests || 0) >= T.low_tests) r.push(`1년 고점보다 ${Math.round((1 - s.pos52) * 100)}% 싼 바닥권`);
  if (s.op_turn) r.push('흑자 전환');
  else if (s.op_yoy >= T.yoy_growth) r.push(`영업이익 +${Math.round(s.op_yoy)}%`);
  if (s.sales_yoy >= T.yoy_growth) r.push(`매출 +${Math.round(s.sales_yoy)}%`);
  if (s.upside >= T.upside_min) r.push(`목표가까지 +${Math.round(s.upside)}%`);
  if ((s.disc_pos || 0) > 0 && !(s.disc_neg > 0)) r.push('좋은 공시');
  if (s.news_sum && s.news_sum.pos >= 2 && s.news_sum.pos > s.news_sum.neg) r.push(`긍정 뉴스 ${s.news_sum.pos}건`);
  if ((s.roe3 || []).length >= 3 && s.roe3.every(x => (x || 0) >= T.roe_min)) r.push(`3년 연속 ROE ${T.roe_min}%↑`);
  if (s.sector_rel5 > 1) r.push(`${s.sector} 업종 강세`);
  if (s.us_impact > 0.5) r.push('미국장 수혜 업종');
  if (!s.is_fin && s.debt_ratio != null && s.debt_ratio <= T.debt_ratio_max && (s.ocf ?? 1) > 0) r.push('빚 적고 현금 잘 버는 회사');
  return r;
}
function recCautions(s) {
  const T = S.th, c = [];
  if (s.rsi > T.rsi_overbought) c.push(`단기 과열(RSI ${Math.round(s.rsi)})`);
  if (s.chg >= 10) c.push(`오늘 +${s.chg}% 급등 — 추격 주의`);
  if (!s.is_fin && s.debt_ratio > 200) c.push(`부채비율 ${Math.round(s.debt_ratio)}%`);
  if ((s.disc_neg || 0) > 0) c.push('악재 공시 있음');
  if (s.news_sum && s.news_sum.neg >= 2 && s.news_sum.neg > s.news_sum.pos) c.push(`부정 뉴스 ${s.news_sum.neg}건`);
  if (s.ocf != null && s.ocf < 0) c.push('본업 현금 유출');
  if ((s.foreign_streak || 0) <= -3) c.push(`외국인 ${-s.foreign_streak}일 연속 매도`);
  if (s.sr20 === '저항' || s.sr20 === '이탈') c.push('20일 평균선 아래');
  return c;
}
function recommend() {
  const out = [];
  S.data.stocks.forEach(s => {
    if (s._ban.length) return;
    const ck = checklist(s);
    const avail = ck.filter(c => c.ok != null), pass = avail.filter(c => c.ok);
    if (avail.length < 6 || s._sc.total < 50) return;
    const rate = pass.length / avail.length;
    let score = 0.55 * s._sc.total + 0.45 * rate * 100;
    if ((s._sc.supply ?? 0) >= 70 && (s._sc.technical ?? 0) >= 60) score += 4;  // 큰손 매수 + 차트 동시 양호
    if (s.rsi > S.th.rsi_overbought + 5) score -= 8;  // 과열 감점
    if (s.chg >= 15) score -= 6;  // 급등 추격 감점
    const reasons = recReasons(s), cautions = recCautions(s);
    score -= cautions.length * 2;
    out.push({ s, score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10, pass: pass.length, avail: avail.length, reasons, cautions });
  });
  return out.sort((a, b) => b.score - a.score);
}
function recCard(x, i, compact) {
  const s = x.s;
  return `<div class="rec" data-code="${esc(s.code)}">
    <div class="rec-h"><span class="rank">${i + 1}</span>
      <div class="nm"><b>${esc(s.name)}</b><small>${esc(s.sector)} · ${fmt(s.close)}원 <span class="${cls(s.chg)}">${pct(s.chg)}</span></small></div>
      <div class="rec-sc"><span class="score ${sCls(x.score)}">${fmt(x.score, 1)}</span><small>추천점수</small></div></div>
    <div class="rec-b">
      <span class="tag">종합 ${fmt(s._sc.total, 1)}</span><span class="tag">좋은 항목 ${x.pass}/${x.avail}</span>
      ${x.reasons.slice(0, compact ? 3 : 8).map(r => `<span class="tag good">${esc(r)}</span>`).join('')}
      ${x.cautions.slice(0, compact ? 1 : 4).map(r => `<span class="tag warn">⚠ ${esc(r)}</span>`).join('')}
    </div>
    ${compact ? '' : (() => { const r = riskCalc(s); return `<div class="rec-f hint">손절가 ${fmt(r.stop)}원(${fmt(r.stopPct, 1)}%) · 권장 ${fmt(r.qty)}주 · 2배 목표 ${fmt(r.t2r)}원</div>`; })()}
  </div>`;
}
function renderRecs() {
  const all = recommend();
  const mk = $('#recMarket') ? $('#recMarket').value : 'all';
  const n = $('#recN') ? +$('#recN').value : 20;
  const list = all.filter(x => mk === 'all' || x.s.market === mk).slice(0, n);
  if ($('#recList')) {
    $('#recList').innerHTML = list.length ? list.map((x, i) => recCard(x, i, false)).join('') : '<div class="empty">조건을 만족하는 종목이 없습니다.</div>';
    $('#recMeta').textContent = `분석 ${S.data.stocks.length}종목 → 매수금지 제외·데이터 충분·종합 50점↑ 후보 ${all.length}종목 중 상위 ${list.length}`;
    bindItems($('#recList'));
  }
  if ($('#recDash')) {
    $('#recDash').innerHTML = all.slice(0, 5).map((x, i) => recCard(x, i, true)).join('') || '<div class="empty">추천 후보가 없습니다.</div>';
    bindItems($('#recDash'));
  }
}
function initExtra() {
  const b = $('#easyBtn');
  const label = () => { b.textContent = easyOn() ? '쉬운 말 켜짐' : '쉬운 말 꺼짐'; b.classList.toggle('on', easyOn()); };
  label();
  b.onclick = () => { store.set('easy', !easyOn()); label(); renderAll(); runSearch(true); renderGlossary(); };
  ['recMarket', 'recN'].forEach(id => { const el = $('#' + id); if (el) el.onchange = renderRecs; });
  if ($('#newsMode')) $('#newsMode').onchange = renderNews;
  const go = $('#recGo'); if (go) go.onclick = () => switchTab('rec');
  renderGlossary();
}
function renderGlossary() {
  const keys = ['total', 'technical', 'supply', 'earnings', 'sector_sc', 'stability', 'close', 'chg', 'vol_ratio', 'rsi', 'tech3', 'pos52', 'low_tests', 'ma_align',
    'foreign_streak', 'inst_streak', 'pension_net5', 'exhaustion', 'op_yoy', 'sales_yoy', 'debt_ratio', 'current_ratio', 'ocf', 'upside', 'sector_rel5', 'us_impact', 'short_ratio', 'stop', 'qty'];
  ['#glossSearch', '#glossAll', '#glossGuide'].forEach(id => { const el = $(id); if (el) el.innerHTML = glossaryHtml(keys); });
}

/* ═════════ 관련 뉴스·호재 ═════════ */
const DISC_EASY = [
  [/공급계약|판매ㆍ공급|단일판매/, '공급 계약 체결 — 매출 증가 기대'],
  [/자기주식취득|자기주식 취득/, '자사주 매입 — 주가 방어·주주환원'],
  [/주식소각/, '주식 소각 — 1주당 가치 상승'],
  [/현금ㆍ현물배당|배당/, '배당 결정'],
  [/무상증자/, '무상증자 — 주식 수 증가(단기 호재로 인식되는 편)'],
  [/유상증자/, '유상증자 — 새 주식 발행, 지분 희석 우려'],
  [/전환사채|신주인수권/, '전환사채 등 발행 — 나중에 주식이 늘 수 있음'],
  [/감자/, '감자 — 자본금 축소, 보통 악재'],
  [/영업\(잠정\)실적|손익구조/, '실적 발표'],
  [/대량보유/, '대량 보유(5%↑) 신고'],
  [/횡령|배임/, '횡령·배임 — 심각한 악재'],
  [/불성실공시|관리종목|상장적격성/, '거래소 제재·상장 관련 위험'],
];
function discEasy(title) { const m = DISC_EASY.find(([re]) => re.test(title)); return m ? m[1] : title; }

function newsSummary(s) {
  const parts = [];
  const ns = s.news_sum;
  if (ns) {
    const tone = ns.pos > ns.neg ? '전반적으로 긍정적' : ns.neg > ns.pos ? '부정적 기사가 많음' : '중립적';
    parts.push(`최근 7일 관련 기사 ${ns.n}건 — 긍정 ${ns.pos}건, 부정 ${ns.neg}건으로 <b>${tone}</b>입니다.` + (ns.kw && ns.kw.length ? ` 자주 나온 표현: ${ns.kw.map(esc).join(', ')}.` : ''));
  }
  const ds = s.disclosures || [];
  const good = ds.filter(d => d.tag === '호재'), bad = ds.filter(d => d.tag === '악재'), earn = ds.filter(d => d.tag === '실적');
  if (good.length) parts.push(`호재 공시 ${good.length}건: ${[...new Set(good.map(d => discEasy(d.title)))].map(esc).join(' / ')}.`);
  if (bad.length) parts.push(`<span class="down">주의 공시 ${bad.length}건: ${[...new Set(bad.map(d => discEasy(d.title)))].map(esc).join(' / ')}.</span>`);
  if (earn.length) parts.push(`최근 실적 발표 공시가 있습니다(${earn[0].date}).`);
  if (s.pension_5pct) parts.push('국민연금의 5% 이상 보유 공시가 있습니다.');
  if (s.upside != null) parts.push(`증권사 평균 목표주가는 ${fmt(s.target)}원으로 현재가보다 ${pct(s.upside, 1)} 차이입니다.`);
  return parts;
}

function newsBlock(s) {
  const sum = newsSummary(s);
  const items = s.news || [];
  const ds = s.disclosures || [];
  const q = encodeURIComponent(s.name);
  const toneTag = t => t > 0 ? '<span class="tag good">긍정</span>' : t < 0 ? '<span class="tag bad">부정</span>' : '<span class="tag">중립</span>';
  return `<h4>관련 뉴스·호재 요약</h4>
    <div class="news-sum">${sum.length ? sum.map(p => `<p>${p}</p>`).join('') : '<p class="muted">수집된 최근 뉴스·공시가 없습니다. (뉴스는 후보·거래 상위 종목만 수집)</p>'}</div>
    ${items.length ? `<div class="news-list">${items.map(n => `<a class="news-item" href="${esc(n.u)}" target="_blank" rel="noopener">${toneTag(n.tone)}<span class="nt">${esc(n.t)}</span><span class="ns">${esc(n.s || '')} ${esc(n.d || '')}</span></a>`).join('')}</div>` : ''}
    ${ds.length ? `<div class="news-list">${ds.map(d => `<a class="news-item" ${d.url ? `href="${esc(d.url)}" target="_blank" rel="noopener"` : ''}><span class="tag ${d.tag === '악재' ? 'bad' : d.tag === '호재' ? 'good' : ''}">공시·${esc(d.tag)}</span><span class="nt">${esc(discEasy(d.title))}</span><span class="ns">${esc(d.date)}</span></a>`).join('')}</div>` : ''}
    <div class="hint mt-s">더 보기: <a href="https://finance.naver.com/item/news.naver?code=${esc(s.code)}" target="_blank" rel="noopener">네이버 증권 뉴스</a> · <a href="https://news.google.com/search?q=${q}&hl=ko&gl=KR&ceid=KR%3Ako" target="_blank" rel="noopener">구글 뉴스</a> · 요약은 기사 제목과 공시 이름을 규칙으로 분류한 것입니다.</div>`;
}

function renderNews() {
  const box = $('#newsList'); if (!box) return;
  const mode = $('#newsMode') ? $('#newsMode').value : 'good';
  let rows = S.data.stocks.filter(s => (s.news || []).length || (s.disclosures || []).length);
  const goodScore = s => (s.news_sum ? s.news_sum.pos - s.news_sum.neg : 0) + (s.disc_pos || 0) * 2 - (s.disc_neg || 0) * 3 + (s.pension_5pct ? 2 : 0);
  if (mode === 'good') rows = rows.filter(s => goodScore(s) > 0 && !(s.disc_neg > 0));
  if (mode === 'bad') rows = rows.filter(s => goodScore(s) < 0 || s.disc_neg > 0);
  rows.sort((a, b) => mode === 'bad' ? goodScore(a) - goodScore(b) : goodScore(b) - goodScore(a));
  $('#newsMeta').textContent = `뉴스·공시가 있는 ${rows.length}종목`;
  box.innerHTML = rows.slice(0, 60).map(s => {
    const sum = newsSummary(s);
    return `<div class="rec" data-code="${esc(s.code)}">
      <div class="rec-h"><div class="nm"><b>${esc(s.name)}${s._ban.length ? ' <span class="tag bad">매수 금지</span>' : ''}</b><small>${esc(s.sector)} · ${fmt(s.close)}원 <span class="${cls(s.chg)}">${pct(s.chg)}</span></small></div>
        <span class="score ${sCls(s._sc.total)}">${fmt(s._sc.total, 1)}</span></div>
      <div class="news-sum">${sum.slice(0, 2).map(p => `<p>${p}</p>`).join('')}</div>
      ${(s.news || []).slice(0, 2).map(n => `<div class="hint">· ${esc(n.t)}</div>`).join('')}
    </div>`;
  }).join('') || '<div class="empty">해당 종목이 없습니다. (뉴스는 다음 자동 수집부터 채워집니다)</div>';
  bindItems(box);
}

/* ═════════ 종목 상세 14개 항목 — 쉬운 말 버전 ═════════ */
function easyCheck(s) {
  const T = S.th, base = checklist(s);
  const n = (v, d = 0) => v == null ? null : fmt(v, d);
  const none = '오늘은 이 정보를 받지 못했어요';
  const srWord = v => v === '지지' ? '평균선 위(받쳐 줌)' : v === '저항' ? '평균선 아래(위로 막힘)' : v === '이탈' ? '평균선 아래로 내려감' : '정보 없음';
  const E = [];
  // 1 거래량
  E.push({ item: '거래가 활발한가', sub: '거래량',
    val: s.vol_ratio == null ? none : `오늘 거래량이 평소(최근 20일 평균)의 ${n(s.vol_ratio, 1)}배 — ${s.vol_ratio < 1 ? '평소보다 한산해요' : s.vol_ratio >= T.volume_ratio ? '사람들이 크게 몰렸어요' : '평소 수준이에요'}. 하루 거래금액 ${n(s.tvalue, 0)}억원.`,
    crit: `좋은 신호: 평소의 ${T.volume_ratio}배 이상 거래되면서 주가도 오를 때` });
  // 2 기술분석
  E.push({ item: '반등 신호가 켜졌나', sub: '기술분석(RSI·MACD·볼린저)',
    val: s.tech3 == null ? none : `매수 신호 3개 중 ${s.tech3}개 켜짐. ` +
      `과열 정도 ${n(s.rsi)}점(30 이하는 많이 빠진 상태, 70 이상은 과열) · ` +
      `${s.macd_above ? '단기 흐름이 위로 돌아섰어요' : '단기 흐름이 아직 아래쪽이에요'} · ` +
      `최근 가격 범위의 ${s.bb_pb == null ? '-' : Math.round(Math.max(0, Math.min(1, s.bb_pb)) * 100) + '%'} 높이(0%=바닥, 100%=꼭대기)`,
    crit: '좋은 신호: 3개 중 2개 이상 켜짐' });
  // 3 실적
  E.push({ item: '돈을 더 벌고 있나', sub: '실적(작년 같은 분기와 비교)',
    val: s.op_yoy == null && s.sales_yoy == null && !s.op_turn ? none :
      (s.op_turn ? '작년엔 손해였는데 올해 이익으로 돌아섰어요(흑자 전환). ' : `본업 이익 ${pct(s.op_yoy, 1)}, 매출 ${pct(s.sales_yoy, 1)} — ${(s.op_yoy ?? 0) >= T.yoy_growth ? '이익이 크게 늘었어요' : (s.op_yoy ?? 0) > 0 ? '이익이 조금 늘었어요' : '이익이 줄었어요'}.`),
    crit: `좋은 신호: 작년보다 이익이 ${T.yoy_growth}% 이상 늘었을 때` });
  // 4 뉴스·공시
  const ns = s.news_sum;
  E.push({ item: '좋은 소식이 있나', sub: '뉴스·공시',
    val: `최근 30일 회사 발표(공시): 좋은 소식 ${s.disc_pos ?? 0}건, 나쁜 소식 ${s.disc_neg ?? 0}건. ` +
      (ns ? `최근 7일 기사 ${ns.n}건 중 긍정 ${ns.pos} · 부정 ${ns.neg}.` : '기사 분위기는 아직 수집 전이에요.'),
    crit: '좋은 신호: 나쁜 소식 없이 좋은 소식이 있을 때' });
  // 5 차트(52주)
  E.push({ item: '지금 싼 편인가', sub: '1년 최고가 대비 위치·바닥 확인',
    val: s.pos52 == null ? none : `지금 가격은 1년 최고가의 ${Math.round(s.pos52 * 100)}% — 최고가보다 ${Math.max(0, Math.round((1 - s.pos52) * 100))}% 싸요. 최근 6개월 바닥 근처까지 내려왔다가 버틴 횟수 ${s.low_tests ?? 0}번.`,
    crit: `좋은 신호: 최고가보다 ${Math.round((1 - T.pos52_undervalued) * 100)}% 이상 싸고, 바닥에서 ${T.low_tests}번 이상 버텨 낸 경우` });
  // 6 연기금
  E.push({ item: '국민연금 등이 사고 있나', sub: '연기금',
    val: s.pension_net5 == null && !s.pension_5pct ? none :
      (s.pension_net5 != null ? `최근 5일 연기금이 ${s.pension_net5 >= 0 ? '산' : '판'} 금액 ${n(Math.abs(s.pension_net5), 1)}억원${s.pension_streak ? (Math.abs(s.pension_streak) === 1 ? `, 마지막 날은 ${s.pension_streak > 0 ? '매수' : '매도'}` : `, 최근 ${Math.abs(s.pension_streak)}일 연속 ${s.pension_streak > 0 ? '매수' : '매도'}`) : ''}. ` : '') +
      (s.pension_5pct ? '국민연금이 이 회사 주식을 5% 넘게 가지고 있다고 신고했어요.' : ''),
    crit: '좋은 신호: 연기금이 사고 있거나 5% 이상 보유를 신고한 경우' });
  // 7 외국인
  E.push({ item: '외국인이 사고 있나', sub: '외국인 매매·보유',
    val: s.foreign_streak == null ? none :
      (s.foreign_streak === 0 ? '외국인은 최근 사고팔기가 비슷해요. ' : Math.abs(s.foreign_streak) === 1 ? `외국인이 마지막 날 ${s.foreign_streak > 0 ? '샀어요' : '팔았어요'}. ` : `외국인이 ${Math.abs(s.foreign_streak)}일 연속 ${s.foreign_streak > 0 ? '사는' : '파는'} 중. `) +
      (s.foreign_hold != null ? `전체 주식의 ${n(s.foreign_hold, 1)}%를 외국인이 가지고 있어요. ` : '') +
      (s.exhaustion != null ? `외국인이 더 살 수 있는 여유는 한도의 ${n(100 - s.exhaustion, 0)}% 남았어요.` : ''),
    crit: `좋은 신호: ${T.streak_days}일 이상 연속으로 사고, 더 살 여유도 충분할 때` });
  // 8 재무
  E.push({ item: '회사 살림이 튼튼한가', sub: '재무안정성(빚·현금·이익)',
    val: s.is_fin ? `은행·보험·증권 같은 금융회사는 빚이 원래 많아서 빚 기준은 보지 않아요. 최근 4분기 중 ${s.profit_q ?? '-'}분기 이익.` :
      s.debt_ratio == null ? none :
      `빚이 자기 돈의 ${n(s.debt_ratio / 100, 1)}배(부채비율 ${n(s.debt_ratio)}%) — ${s.debt_ratio <= T.debt_ratio_max ? '빚이 적은 편' : s.debt_ratio <= 200 ? '빚이 조금 많은 편' : '빚이 많은 편'}. ` +
      `1년 안에 갚을 돈 대비 바로 쓸 수 있는 자산 ${n(s.current_ratio)}%. ` +
      (s.ocf != null ? `장사로 실제 들어온 현금 ${n(s.ocf)}억원. ` : '') + `최근 4분기 중 ${s.profit_q ?? '-'}분기 이익.`,
    crit: '좋은 신호: 빚이 자기 돈보다 적고, 현금이 들어오고, 4분기 내내 이익' });
  // 9 추세
  E.push({ item: '오르는 흐름인가', sub: '5·20·120일 평균선(약 1주·1달·6개월)',
    val: s.sr20 == null ? none : `1주 평균: ${srWord(s.sr5)} · 1달 평균: ${srWord(s.sr20)} · 6개월 평균: ${srWord(s.sr120)}. ${s.ma_align ? '세 평균선이 모두 오르는 상승 추세예요.' : '아직 뚜렷한 상승 추세는 아니에요.'}`,
    crit: '좋은 신호: 주가가 세 평균선 위에 있고, 평균선들이 모두 위로 향할 때' });
  // 10 장기
  const roe = (s.roe3 || []).filter(x => x != null);
  E.push({ item: '꾸준히 잘 버는 회사인가', sub: '장기전망(ROE)',
    val: roe.length < 3 ? none : `자기 돈 100원으로 1년에 번 이익(ROE): 최근 3년 ${roe.map(x => fmt(x, 1) + '원').join(' → ')}. 회사 크기 ${s.mcap >= 10000 ? fmt(s.mcap / 10000, 1) + '조원' : fmt(s.mcap) + '억원'}.`,
    crit: `좋은 신호: 3년 연속 ${T.roe_min}원(=${T.roe_min}%) 이상 — 은행 이자보다 훨씬 잘 버는 회사` });
  // 11 업종
  E.push({ item: '같은 업종 분위기가 좋은가', sub: '섹터(업종) 강도',
    val: s.sector_rel5 == null || s.sector === '기타' ? '오늘은 업종 정보를 받지 못했어요' : `${s.sector} 업종이 최근 5일 동안 시장 전체보다 ${n(Math.abs(s.sector_rel5), 1)}%p ${s.sector_rel5 >= 0 ? '더 올랐어요' : '덜 올랐어요'}.`,
    crit: '좋은 신호: 같은 업종이 시장보다 더 많이 오를 때' });
  // 12 장중
  E.push({ item: '오늘 장중 흐름', sub: '10분·1시간 단위 흐름',
    val: s.m60_trend ? `1시간 흐름 ${s.m60_trend}, 10분 흐름 ${s.m10_trend}. ${s.absorb ? '파는 물량을 사는 쪽이 잘 받아냈어요.' : '사는 힘이 약했어요.'}` : '장중 데이터는 아직 연결 안 됨(한국투자증권 키 필요) — 판정에서 제외',
    crit: '좋은 신호: 하루 중 파는 물량을 사는 쪽이 받아낼 때' });
  // 13 목표가
  E.push({ item: '전문가 목표가까지 여유', sub: '상승여력(증권사 목표주가)',
    val: s.upside == null ? '증권사 목표가가 없는 종목이에요(작은 회사는 흔해요)' : `증권사 평균 목표가 ${fmt(s.target)}원 — 지금보다 ${pct(s.upside, 1)} ${s.upside >= 0 ? '높아요' : '낮아요'}.`,
    crit: `좋은 신호: 목표가가 ${T.upside_min}% 이상 높을 때(1년 전망이라 단기 매매엔 참고만)` });
  // 14 미국장
  E.push({ item: '어젯밤 미국 증시 영향', sub: '관련 미국 업종 지수',
    val: s.us_impact == null ? none : `어젯밤 관련 미국 지수를 보면 오늘 이 업종에 ${pct(s.us_impact)} 정도 ${s.us_impact >= 0 ? '도움' : '부담'}이 예상돼요.`,
    crit: '좋은 신호: 관련 미국 업종이 어젯밤 올랐을 때' });
  // + 공매도
  E.push({ item: '하락에 거는 물량(공매도)', sub: '공매도 잔고',
    val: s.short_ratio == null ? none : `전체 주식의 ${n(s.short_ratio, 2)}%가 하락에 걸려 있고, 최근 5일 ${(s.short_chg || 0) > 0 ? '늘었어요' : '줄었거나 그대로예요'}.`,
    crit: '좋은 신호: 공매도가 늘지 않을 때' });
  return base.map((b, i) => ({ ...b, ...(E[i] || {}) }));
}
