/* 문장으로 조건검색 — 한국어 문장을 규칙으로 해석해 조건 목록으로 바꿉니다 (외부 서버 없이 브라우저에서 처리)
   예) "외국인 5일 연속 순매수, RSI 40 이하, 시총 1조 이상 반도체, 상위 20개" */
'use strict';

const NLQ_EXAMPLES = [
  '외국인 기관 동시 순매수, 정배열, 매수금지 제외',
  '코스닥 반도체 RSI 35 이하 거래량 급증',
  '시총 1조 이상, 부채비율 100% 이하, 영업이익 20% 이상 증가',
  '52주 저평가 매물대, 연기금 순매수, 상위 20개',
  '상승여력 30% 이상 또는 국민연금 5% 공시',
  '바이오나 제약, 5일 수익률 10% 이상, 종합점수 높은 순',
];

// 업종 키워드 → 업종명에 포함된 글자(여러 개면 | 로 연결)
const NLQ_SECTORS = [
  [/반도체|전자|디스플레이|it\s*하드웨어/i, '전기|반도체'],
  [/바이오|제약|의약|헬스케어/, '제약|의약|바이오'],
  [/의료|정밀/, '의료|정밀'],
  [/은행|금융|증권|보험|지주/, '금융|은행|증권|보험'],
  [/자동차|운송\s*장비|부품/, '운송장비|자동차'],
  [/조선|기계|방산|로봇/, '기계|조선'],
  [/화학|정유|2차\s*전지|이차\s*전지|배터리/, '화학'],
  [/철강|금속|소재/, '금속|철강'],
  [/건설/, '건설'],
  [/통신/, '통신'],
  [/유통|소매|백화점/, '유통'],
  [/음식|식품|음료|담배/, '음식료'],
  [/게임|소프트웨어|인터넷|플랫폼|it\s*서비스/i, 'IT 서비스|서비스|소프트웨어'],
  [/엔터|미디어|오락|문화/, '오락|문화|미디어'],
  [/운수|해운|항공|물류|창고/, '운수|운송|창고'],
  [/섬유|의류|의복/, '섬유|의복|의류'],
  [/전기\s*가스|유틸리티|전력/, '전기가스|전기·가스'],
  [/종이|목재/, '종이|목재'],
];

// 숫자 필드: [정규식, 필드키, 단위종류, 기본연산]
const NLQ_FIELDS = [
  [/종합\s*점수|종합/, 'total', '', '>='],
  [/지표\s*점수|기술\s*점수/, 'technical', '', '>='],
  [/수급\s*점수/, 'supply', '', '>='],
  [/실적\s*점수/, 'earnings', '', '>='],
  [/섹터\s*점수|업종\s*점수/, 'sector_sc', '', '>='],
  [/안정(성)?\s*점수/, 'stability', '', '>='],
  [/시가\s*총액|시총/, 'mcap', 'eok', '>='],
  [/거래\s*대금\s*(배|증가|급증)/, 'tv_ratio', '', '>='],
  [/거래\s*대금/, 'tvalue', 'eok', '>='],
  [/거래량/, 'vol_ratio', '', '>='],
  [/rsi/i, 'rsi', '', '<='],
  [/(기술|보조)\s*(지표)?\s*3\s*종|3\s*종\s*겹/, 'tech3', '', '>='],
  [/52\s*주/, 'pos52', 'ratio', '<='],
  [/저점\s*(터치|테스트)/, 'low_tests', '', '>='],
  [/한도\s*소진/, 'exhaustion', '', '<='],
  [/부채\s*비율|부채/, 'debt_ratio', '', '<='],
  [/유동\s*비율/, 'current_ratio', '', '>='],
  [/(영업\s*)?현금\s*흐름/, 'ocf', 'eok', '>='],
  [/흑자\s*분기|분기\s*연속\s*흑자|흑자\s*지속/, 'profit_q', '', '>='],
  [/영업\s*이익|영익/, 'op_yoy', '', '>='],
  [/매출/, 'sales_yoy', '', '>='],
  [/상승\s*여력|목표\s*주가|목표가/, 'upside', '', '>='],
  [/뉴스|감정/, 'news_score', '', '>='],
  [/(업종|섹터)\s*(강도|상대|수익)/, 'sector_rel5', '', '>='],
  [/미국|미장|나스닥|sox/i, 'us_impact', '', '>='],
  [/공매도.*(증가|변화|늘)/, 'short_chg', '', '>='],
  [/공매도/, 'short_ratio', '', '<='],
  [/변동성|atr/i, 'atr_pct', '', '<='],
  [/(20|이십)\s*일\s*(수익률|상승률|등락)|한\s*달|1\s*개월/, 'ret20', '', '>='],
  [/(5|오)\s*일\s*(수익률|상승률|등락)|일주일|1\s*주(일)?\s*(수익률|상승)/, 'ret5', '', '>='],
  [/등락률|오늘|당일/, 'chg', '', '>='],
  [/주가|가격|종가/, 'close', 'won', '>='],
  [/점수/, 'total', '', '>='],
];

const NLQ_INVESTORS = [
  [/외국인|외인/, 'foreign'],
  [/기관/, 'inst'],
  [/연기금|국민\s*연금|연금/, 'pension'],
];

function nlqNumbers(text, unit) {
  const out = [];
  const re = /(-?\d+(?:\.\d+)?)\s*(조|천억|억|만\s*원|만|천\s*원|원|%|퍼센트|프로|배|일|개|회|분기|점|bp)?/g;
  let m;
  while ((m = re.exec(text))) {
    let v = parseFloat(m[1]);
    const u = (m[2] || '').replace(/\s/g, '');
    if (unit === 'eok') v *= u === '조' ? 10000 : u === '천억' ? 1000 : 1;
    else if (unit === 'won') v *= u === '만원' || u === '만' ? 10000 : u === '천원' ? 1000 : 1;
    else if (unit === 'ratio' && (u === '%' || v > 1.5)) v = v / 100;
    out.push({ v: Math.round(v * 1000) / 1000, u });
  }
  return out;
}

function nlqOp(text, defOp) {
  if (/초과|넘는|넘게|보다\s*(크|높|많)/.test(text)) return '>';
  if (/미만|보다\s*(작|낮|적)|안\s*되는|못\s*미치/.test(text)) return '<';
  if (/이상|넘|위|↑|>=|부터|최소/.test(text)) return '>=';
  if (/이하|아래|↓|<=|까지|최대|이내/.test(text)) return '<=';
  return defOp;
}

// 숫자 없이 말로만 한 경우의 기본 기준값
function nlqDefault(key, text) {
  const T = S.th;
  const up = /상승|오른|플러스|양수|증가|성장|높|많|강|좋|긍정|수혜|급증|터진|개선/.test(text);
  const down = /하락|내린|마이너스|음수|감소|낮|적|약|나쁜|부정|줄/.test(text);
  switch (key) {
    case 'total': case 'technical': case 'supply': case 'earnings': case 'sector_sc': case 'stability':
      return { op: '>=', v: /매우|아주|최상/.test(text) ? 80 : up ? 70 : 60 };
    case 'vol_ratio': case 'tv_ratio': return { op: '>=', v: T.volume_ratio };
    case 'rsi': return down || /과매도/.test(text) ? { op: '<=', v: T.rsi_oversold } : up || /과매수/.test(text) ? { op: '>=', v: T.rsi_overbought } : null;
    case 'tech3': return { op: '>=', v: 2 };
    case 'pos52': return /신고가|고점\s*근처/.test(text) ? { op: '>=', v: 0.95 } : { op: '<', v: T.pos52_undervalued };
    case 'low_tests': return { op: '>=', v: T.low_tests };
    case 'exhaustion': return { op: '<', v: T.exhaustion_limit };
    case 'debt_ratio': return { op: '<=', v: T.debt_ratio_max };
    case 'current_ratio': return { op: '>=', v: T.current_ratio_min };
    case 'ocf': return down ? { op: '<', v: 0 } : { op: '>', v: 0 };
    case 'profit_q': return { op: '>=', v: 4 };
    case 'op_yoy': case 'sales_yoy': return down ? { op: '<', v: 0 } : { op: '>=', v: T.yoy_growth };
    case 'upside': return { op: '>=', v: T.upside_min };
    case 'news_score': return down ? { op: '<', v: 0 } : { op: '>', v: 0 };
    case 'sector_rel5': return down ? { op: '<', v: 0 } : { op: '>', v: 0 };
    case 'us_impact': return down ? { op: '<', v: 0 } : { op: '>', v: 0 };
    case 'short_chg': return { op: '>', v: 0.3 };
    case 'short_ratio': return up ? { op: '>=', v: 5 } : { op: '<', v: 2 };
    case 'atr_pct': return up ? { op: '>=', v: 4 } : { op: '<=', v: 3 };
    case 'chg': case 'ret5': case 'ret20': return down ? { op: '<', v: 0 } : { op: '>', v: 0 };
  }
  return null;
}

function nlqClause(raw, ctx) {
  let t = ' ' + raw.trim() + ' ';
  const conds = [];
  const push = (f, op, v, v2) => conds.push(v2 == null ? { f, op, v } : { f, op, v, v2 });

  // 개수·정렬
  let m = t.match(/(상위|top|탑)\s*(\d+)|(\d+)\s*(개|종목)\s*(만|까지)?/i);
  if (m) { ctx.limit = +(m[2] || m[3]); t = t.replace(m[0], ' '); }
  if (/순으로|순\s*정렬|순서로|\s순\s|순$/.test(t.trim() + ' ')) {
    const f = NLQ_FIELDS.find(r => r[0].test(t));
    const inv = NLQ_INVESTORS.find(r => r[0].test(t));
    ctx.sort = f ? f[1] : inv ? inv[1] + (/연속/.test(t) ? '_streak' : '_net5') : 'total';
    ctx.sortAsc = /낮은|작은|적은|오름/.test(t);
    return conds;
  }

  // 참/거짓 항목
  const flag = (re, f, v) => { if (re.test(t)) { push(f, 'is', v); t = t.replace(re, ' '); } };
  flag(/정배열|강세\s*배열/, 'ma_align', true);
  flag(/흑자\s*전환/, 'op_turn', true);
  flag(/(국민\s*)?연금.*(5\s*%|5\s*프로|대량\s*보유|공시)|대량\s*보유/, 'pension_5pct', true);
  if (/악재.*(없|제외|빼|아닌)/.test(t)) { push('disc_neg', 'is', false); t = t.replace(/악재\S*\s*(없\S*|제외\S*|빼\S*|아닌\S*)/, ' '); }
  else flag(/악재/, 'disc_neg', true);
  flag(/호재/, 'disc_pos', true);
  if (/(매수\s*)?금지.*(제외|빼|없|아닌)/.test(t)) { push('banned', 'is', false); t = t.replace(/(매수\s*)?금지\S*\s*\S*/, ' '); }
  flag(/화이트\s*리스트|진입\s*후보/, 'white', true);
  flag(/골든\s*크로스|macd/i, 'sig_macd', true);
  flag(/볼린저/, 'sig_bb', true);
  flag(/(컨센서스|목표\s*주가|목표가)\s*(있|존재)/, 'has_target', true);
  flag(/실적\s*발표/, 'earn_recent', true);
  flag(/roe/i, 'roe_ok', true);
  flag(/장기\s*우량/, 'roe_ok', true);
  flag(/흡수/, 'absorb', true);
  flag(/매물대|바닥\s*(다지|확인)/, 'low_tests', null);  // 아래에서 숫자 처리
  if (conds.length && conds[conds.length - 1].f === 'low_tests') { conds.pop(); push('low_tests', '>=', S.th.low_tests); }

  // 시장
  if (/코스피|유가\s*증권/.test(t)) { push('market', 'is', 'KOSPI'); t = t.replace(/코스피|유가\s*증권/, ' '); }
  if (/코스닥/.test(t)) { push('market', 'is', 'KOSDAQ'); t = t.replace(/코스닥/, ' '); }
  if (conds.filter(c => c.f === 'market').length === 2) {  // 둘 다 말하면 시장 조건 무시
    for (let i = conds.length - 1; i >= 0; i--) if (conds[i].f === 'market') conds.splice(i, 1);
  }

  // 업종
  const secs = [];
  NLQ_SECTORS.forEach(([re, v]) => { if (re.test(t)) { secs.push(v); t = t.replace(re, ' '); } });
  if (secs.length) push('sector', 'has', [...new Set(secs.join('|').split('|'))].join('|'));

  // 항목 위치(앵커)를 찾아 구간별로 해석 — 한 문장에 여러 항목이 있어도 각각 조건으로
  const anchors = [];
  const overlaps = (i, j) => anchors.some(x => i < x.end && j > x.idx);
  NLQ_INVESTORS.forEach(([re, key]) => {
    const g = new RegExp(re.source, 'g' + re.flags.replace('g', ''));
    let mm;
    while ((mm = g.exec(t))) {
      if (overlaps(mm.index, mm.index + mm[0].length)) continue;
      const after = t.slice(mm.index + mm[0].length, mm.index + mm[0].length + 6);
      if (key === 'foreign' && /^\s*(지분|보유)/.test(after)) {
        anchors.push({ idx: mm.index, end: mm.index + mm[0].length, type: 'field', key: 'foreign_hold', unit: '', defOp: '>=' });
      } else anchors.push({ idx: mm.index, end: mm.index + mm[0].length, type: 'inv', key });
    }
  });
  NLQ_FIELDS.forEach(([re, key, unit, defOp]) => {
    const mm = re.exec(t);
    if (!mm || overlaps(mm.index, mm.index + mm[0].length)) return;
    if (key === 'pension_5pct') return;
    anchors.push({ idx: mm.index, end: mm.index + mm[0].length, type: 'field', key, unit, defOp });
  });
  anchors.sort((x, y) => x.idx - y.idx);

  // 연속된 투자자(예: "외국인과 기관") 묶기
  const groups = [];
  anchors.forEach(an => {
    const last = groups[groups.length - 1];
    if (an.type === 'inv' && last && last.type === 'inv' && /^\s*(과|와|및|,|\/|랑|이랑|하고)?\s*$/.test(t.slice(last.end, an.idx))) {
      last.keys.push(an.key); last.end = an.end;
    } else groups.push(an.type === 'inv' ? { ...an, keys: [an.key] } : { ...an });
  });

  groups.forEach((g, gi) => {
    const seg = t.slice(g.end, gi + 1 < groups.length ? groups[gi + 1].idx : t.length);
    if (g.type === 'inv') {
      const nums = nlqNumbers(seg, 'eok');
      const sell = /순매도|매도|팔/.test(seg);
      const streak = /연속|일\s*째|\d+\s*일/.test(seg);
      g.keys.forEach(k => {
        if (streak) {
          const d = nums.find(n => n.u === '일') || nums[0];
          const days = d ? Math.abs(d.v) : (sell ? 3 : S.th.streak_days);
          sell ? push(k + '_streak', '<=', -days) : push(k + '_streak', '>=', days);
        } else {
          const n = nums.find(x => x.u !== '일');
          if (n) push(k + '_net5', sell ? '<=' : nlqOp(seg, '>='), sell ? -Math.abs(n.v) : n.v);
          else sell ? push(k + '_net5', '<', 0) : push(k + '_net5', '>', 0);
        }
      });
      return;
    }
    const key = g.key;
    const nums = nlqNumbers(seg, key === 'foreign_hold' ? '' : g.unit);
    if (key === 'foreign_hold') { push(key, nlqOp(seg, '>='), nums.length ? nums[0].v : 30); return; }
    if (nums.length >= 2 && /사이|~|∼|부터|에서/.test(seg)) {
      push(key, 'between', Math.min(nums[0].v, nums[1].v), Math.max(nums[0].v, nums[1].v));
    } else if (nums.length) {
      let v = nums[0].v;
      const neg = /하락|감소|마이너스|떨어/.test(seg) && ['chg', 'ret5', 'ret20', 'op_yoy', 'sales_yoy'].includes(key);
      if (neg) v = -Math.abs(v);
      let op = nlqOp(seg, g.defOp);
      if (neg && op === '>=') op = '<=';
      push(key, op, v);
    } else {
      const d = nlqDefault(key, seg + ' ' + (key === 'rsi' ? t : ''));
      if (d) push(key, d.op, d.v);
    }
  });

  if (!groups.length) {
    if (/과매도/.test(t)) push('rsi', '<=', S.th.rsi_oversold);
    else if (/과매수/.test(t)) push('rsi', '>=', S.th.rsi_overbought);
    else if (/저평가/.test(t)) push('pos52', '<', S.th.pos52_undervalued);
    else if (/급등|급상승/.test(t)) push('chg', '>=', 5);
    else if (/급락/.test(t)) push('chg', '<=', -5);
    else if (/상승|오른/.test(t) && !conds.length) push('chg', '>', 0);
    else if (/하락|내린/.test(t) && !conds.length) push('chg', '<', 0);
  }
  return conds;
}

function nlqParse(text) {
  const ctx = { limit: null, sort: null, sortAsc: false, logic: /또는|이거나|혹은|\bor\b/i.test(text) ? 'OR' : 'AND' };
  const clauses = text
    .replace(/[“”"']/g, ' ')
    .split(/[,，\n;]|\s그리고\s|이면서|이며|이고\s|하고\s|면서\s|\s및\s|\sand\s|이거나|또는|혹은|\sor\s/i)
    .map(x => x.trim()).filter(Boolean);
  const conds = [], miss = [];
  clauses.forEach(c => {
    const r = nlqClause(c, ctx);
    if (r.length) conds.push(...r);
    else if (!/^(종목|주식|찾아|보여|알려|검색|골라|추천|조건)/.test(c) && !(ctx.sort && /순/.test(c)) && !(ctx.limit && /(개|종목|상위)/.test(c))) miss.push(c);
  });
  // 같은 항목·같은 연산자 중복 제거(마지막 값 우선)
  const seen = new Map();
  conds.forEach(c => seen.set(c.f + c.op + (c.f === 'market' || c.f === 'sector' ? c.v : ''), c));
  return { conds: [...seen.values()], miss, ...ctx };
}

function nlqApply(text) {
  const out = $('#nlqResult');
  if (!text.trim()) { out.innerHTML = '<span class="hint">찾고 싶은 조건을 문장으로 적어 주세요.</span>'; return; }
  const r = nlqParse(text);
  if (!r.conds.length && !r.sort && !r.limit) {
    out.innerHTML = `<span class="miss">이해한 조건이 없습니다.</span> <span class="hint">예시를 눌러 형식을 참고해 보세요. (항목 이름 + 숫자 + 이상/이하)</span>`;
    return;
  }
  S.conds = r.conds.map(c => ({ ...c, src: 'nlq' }));
  S.logic = r.logic; store.set('logic', S.logic);
  $$('input[name=logic]').forEach(x => x.checked = x.value === S.logic);
  if (!r.limit) { S.limit = 50; $('#limitSel').value = '50'; }
  if (r.limit) { S.limit = r.limit; const sel = $('#limitSel'); if (![...sel.options].some(o => +o.value === r.limit)) sel.add(new Option(String(r.limit), String(r.limit))); sel.value = String(r.limit); }
  if (r.sort && FM[r.sort]) { S.sortKey = r.sort; S.resSort = { key: r.sort, asc: r.sortAsc }; $('#sortSel').value = r.sort; }
  else S.resSort = null;
  drawConds();
  runSearch(true);
  const n = S.lastResult.length;
  out.innerHTML =
    `<div><span class="ok">✓ 이해한 조건 ${r.conds.length}개</span> (${r.logic === 'AND' ? '모두 만족' : '하나라도 만족'})${r.sort ? ` · 정렬: ${esc(FM[r.sort]?.label || r.sort)} ${r.sortAsc ? '낮은' : '높은'} 순` : ''}${r.limit ? ` · 최대 ${r.limit}개` : ''} → <b>${n}종목</b></div>` +
    `<div class="mt-s">${r.conds.map(c => `<span class="tag">${esc(condText(c))}</span>`).join('')}</div>` +
    (r.miss.length ? `<div class="mt-s"><span class="miss">이해하지 못한 부분:</span> ${r.miss.map(m => `<span class="tag bad">${esc(m)}</span>`).join('')} <span class="hint">— 아래 조건 목록에서 직접 추가할 수 있어요</span></div>` : '') +
    `<div class="hint mt-s">아래 조건 목록에서 숫자를 고치거나 빠른 조건을 더 눌러 조정할 수 있습니다.</div>`;
  $('#resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function initNlq() {
  const inp = $('#nlqInput');
  $('#nlqEx').innerHTML = '<span class="lbl">예시</span>' + NLQ_EXAMPLES.map((e, i) => `<button class="chip" data-e="${i}">${esc(e)}</button>`).join('');
  $('#nlqEx').onclick = e => { const b = e.target.closest('[data-e]'); if (!b) return; inp.value = NLQ_EXAMPLES[+b.dataset.e]; nlqApply(inp.value); };
  $('#nlqRun').onclick = () => nlqApply(inp.value);
  inp.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); nlqApply(inp.value); } };
  inp.value = store.get('nlq', '');
  inp.oninput = () => store.set('nlq', inp.value);
}
