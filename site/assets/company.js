/* 회사 알아보기 — 무슨 사업을 하는 회사인지 · 주요 제품 · 기본 정보 · 증권사 전망 · 실적 흐름 · 종합 전망
   자료: 사이트 서버(/api/company)가 네이버 금융·와이즈리포트에서 받아 정리 + 이 사이트가 모은 실적·수급·뉴스·차트 판정 */
'use strict';

const CO = { API: '/api/company', mem: {} };

async function coFetch(code) {
  if (CO.mem[code]) return CO.mem[code];
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  try { const c = store.get('co_' + code, null); if (c && c.day === day && c.d && c.d.ok) return (CO.mem[code] = c.d); } catch (e) {}
  const r = await fetch(`${CO.API}?code=${code}`);
  const d = r.ok ? await r.json() : null;
  if (d && d.ok) { CO.mem[code] = d; try { store.set('co_' + code, { day, d }); } catch (e) {} }
  return d;
}

function coOpinion(v) {
  const n = parseFloat(v); if (!Number.isFinite(n)) return v ? String(v) : null;
  return n >= 4.5 ? '강력 매수' : n >= 3.5 ? '매수' : n >= 2.5 ? '중립' : n >= 1.5 ? '매도' : '강력 매도';
}
function coThemes(code) {
  if (typeof MN === 'undefined' || !MN.d || !MN.d.themes) return [];
  return Object.entries(MN.d.themes).filter(([, t]) => (t.stocks || []).includes(code)).map(([k, t]) => t.name || k).slice(0, 8);
}

// 종합 전망 — 회사 자료 + 이 사이트가 모은 실적·수급·뉴스·차트를 규칙으로 엮은 문장
function coOutlook(s, d) {
  const good = [], risk = [], watch = [];
  const T = S.th;
  const tgt = d && d.consensus && parseFloat(String(d.consensus.target || '').replace(/,/g, ''));
  const up = tgt && s.close ? (tgt / s.close - 1) * 100 : (s.upside ?? null);
  if (up != null) (up >= 20 ? good : up < 0 ? risk : watch).push(up >= 20 ? `증권사 평균 목표가가 지금보다 ${fmt(up, 0)}% 높아요 — 전문가들은 더 오를 여지를 보고 있어요.` : up < 0 ? `지금 가격이 증권사 평균 목표가보다 ${fmt(-up, 0)}% 높아요 — 기대가 이미 가격에 많이 반영됐을 수 있어요.` : `증권사 평균 목표가까지 ${fmt(up, 0)}% 남았어요.`);
  if (s.op_turn) good.push('작년 같은 분기엔 적자였는데 올해 흑자로 돌아섰어요(흑자 전환) — 시장이 가장 좋아하는 변화 중 하나예요.');
  else if (s.op_yoy != null) (s.op_yoy >= T.yoy_growth ? good : s.op_yoy < 0 ? risk : watch).push(s.op_yoy >= T.yoy_growth ? `본업 이익(영업이익)이 작년보다 ${fmt(s.op_yoy, 0)}% 늘었어요 — 실적이 좋아지는 중이에요.` : s.op_yoy < 0 ? `본업 이익이 작년보다 ${fmt(-s.op_yoy, 0)}% 줄었어요 — 실적 회복 시점을 확인해야 해요.` : `본업 이익이 작년보다 ${fmt(s.op_yoy, 0)}% 늘었어요(완만한 성장).`);
  if (s.sales_yoy != null && s.sales_yoy >= T.yoy_growth) good.push(`매출이 작년보다 ${fmt(s.sales_yoy, 0)}% 늘어 회사 덩치가 커지는 중이에요.`);
  if ((s.roe3 || []).length >= 3 && s.roe3.every(r => (r || 0) >= T.roe_min)) good.push(`3년 연속 자기자본이익률(ROE) ${T.roe_min}% 이상 — 꾸준히 돈을 잘 버는 회사예요.`);
  if (!s.is_fin && s.debt_ratio != null) (s.debt_ratio > 200 ? risk : s.debt_ratio <= 100 ? good : watch).push(s.debt_ratio > 200 ? `빚이 자기 돈의 ${fmt(s.debt_ratio / 100, 1)}배 — 금리·경기에 민감할 수 있어요.` : s.debt_ratio <= 100 ? '빚이 자기 돈보다 적어 재무가 튼튼해요.' : `빚이 자기 돈의 ${fmt(s.debt_ratio / 100, 1)}배로 보통 수준이에요.`);
  if (s.ocf != null && s.ocf < 0) risk.push('장사로 들어온 현금(영업현금흐름)이 마이너스예요 — 이익이 실제 현금으로 들어오는지 확인이 필요해요.');
  if ((s.foreign_streak || 0) >= 3 || (s.inst_streak || 0) >= 3) good.push(`큰손이 사는 중 — 외국인 ${s.foreign_streak > 0 ? s.foreign_streak + '일 연속 매수' : '매수 아님'}, 기관 ${s.inst_streak > 0 ? s.inst_streak + '일 연속 매수' : '매수 아님'}.`);
  if ((s.foreign_streak || 0) <= -3 && (s.inst_streak || 0) <= -3) risk.push('외국인·기관이 함께 며칠째 팔고 있어요.');
  if (s.sector_rel5 != null) (s.sector_rel5 > 1 ? good : s.sector_rel5 < -1 ? risk : watch).push(s.sector_rel5 > 1 ? `속한 업종이 최근 시장보다 강해요(+${fmt(s.sector_rel5, 1)}%p) — 업종 전체에 돈이 들어오는 중.` : s.sector_rel5 < -1 ? `속한 업종이 최근 시장보다 약해요(${fmt(s.sector_rel5, 1)}%p).` : '업종 흐름은 시장과 비슷해요.');
  if (s._newsLive != null && s._nw && s._nw.nDir) (s._newsLive >= 20 ? good : s._newsLive <= -20 ? risk : watch).push(`최근 뉴스 분위기 ${s._newsLive > 0 ? '+' : ''}${s._newsLive} — ${s._newsLive >= 20 ? '좋은 소식이 많아요' : s._newsLive <= -20 ? '나쁜 소식이 많아요' : '뚜렷하지 않아요'}${s._nw.heads[0] ? ` (최근: "${s._nw.heads[0].t.slice(0, 40)}")` : ''}.`);
  if (s._alert) risk.unshift(`거래소 시장경보(${s._alert})가 걸려 있어요 — 투자에 각별히 주의.`);
  if (s.cl) (s.cl.s >= 28 ? good : s.cl.s <= -28 ? risk : watch).push(`차트 종합판정은 '${s.cl.v}'(${s.cl.s > 0 ? '+' : ''}${fmt(s.cl.s, 1)}) — ${s.cl.s >= 28 ? '가격 흐름도 회사 이야기를 뒷받침해요.' : s.cl.s <= -28 ? '좋은 이야기가 있어도 가격 흐름은 아직 약해요.' : '가격 흐름은 아직 방향을 정하는 중이에요.'}`);
  if (d && d.reports && d.reports.length) watch.push(`최근 증권사 리포트 ${d.reports.length}건 — 제목에서 회사가 주목받는 이유를 확인해 보세요.`);
  watch.push('다음 실적 발표(분기마다)에서 이익이 계속 늘어나는지, 주요 제품의 매출 비중이 바뀌는지 확인하세요.');
  const score = good.length - risk.length;
  const head = s._alert ? '주의가 필요한 종목' : score >= 3 ? '좋은 점이 뚜렷한 회사' : score >= 1 ? '좋은 점이 조금 더 많은 회사' : score <= -2 ? '조심해서 볼 회사' : '좋은 점과 걱정이 섞인 회사';
  return { good, risk, watch, head, cls: s._alert || score <= -2 ? 'bad' : score >= 1 ? 'good' : 'mid' };
}

function coHtml(s, d) {
  const themes = coThemes(s.code);
  const sum = (d && (d.summary || []).length ? d.summary : null);
  const biz = d && (d.biz || []).length ? d.biz : null;
  const pr = d && (d.products || []).length ? d.products : null;
  const info = d && d.info ? Object.entries(d.info) : [];
  const c = d && d.consensus;
  const tgt = c && parseFloat(String(c.target || '').replace(/,/g, ''));
  const op = c && coOpinion(c.opinion);
  const O = coOutlook(s, d);
  const statPick = d && d.stats ? d.stats.filter(x => /PER|PBR|배당|EPS|BPS|시가총액|외국인|52주/i.test(x.k)).slice(0, 10) : [];
  const mx = pr ? Math.max(...pr.map(p => p.pct)) : 1;
  const q = encodeURIComponent(s.name);
  return `
  <div class="co-grid">
    <div class="co-box co-wide"><h5>무슨 회사인가요?</h5>
      ${sum ? sum.map(p => `<p>${esc(p)}</p>`).join('') : ''}
      ${biz ? `<ul class="co-biz">${biz.slice(0, 6).map(b => `<li>${esc(b)}</li>`).join('')}</ul>${d.bizDate ? `<div class="hint">${esc(d.bizDate)}</div>` : ''}` : ''}
      ${!sum && !biz ? `<p class="muted">${d ? '회사 설명을 받지 못했어요.' : '불러오는 중…'}</p>` : ''}
      <div class="co-tags"><span class="tag">${s.market === 'KOSPI' ? '코스피' : '코스닥'}</span>${s.sector && s.sector !== '기타' ? `<span class="tag">${esc(s.sector)}</span>` : ''}${d && d.industry ? `<span class="tag">업종: ${esc(d.industry)}</span>` : ''}${d && d.wics && d.wics !== d.industry ? `<span class="tag">${esc(d.wics)}</span>` : ''}${themes.map(t => `<span class="tag good">테마: ${esc(t)}</span>`).join('')}</div>
    </div>
    ${pr ? `<div class="co-box"><h5>무엇을 팔아 돈을 버나요? <small class="muted">주요 제품 매출 비중</small></h5>${pr.map(p => `<div class="co-bar"><span>${esc(p.name)}</span><i style="width:${Math.max(2, p.pct / mx * 100)}%"></i><b class="mono">${fmt(p.pct, 1)}%</b></div>`).join('')}</div>` : ''}
    ${info.length ? `<div class="co-box"><h5>기본 정보</h5>${info.map(([k, v]) => `<div class="an-kv"><span>${esc(k)}</span><b>${/^https?:|^www\./.test(v) ? `<a href="${esc(/^http/.test(v) ? v : 'http://' + v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}</b></div>`).join('')}</div>` : ''}
    <div class="co-box"><h5>증권사 전망</h5>
      ${tgt ? `<div class="an-kv"><span>평균 목표주가</span><b>${fmt(tgt)}원 <span class="${cls(tgt - s.close)}">(${pct((tgt / s.close - 1) * 100, 1)})</span></b></div>` : s.target ? `<div class="an-kv"><span>평균 목표주가</span><b>${fmt(s.target)}원 (${pct(s.upside, 1)})</b></div>` : '<div class="hint">목표주가 정보가 없어요(증권사가 분석하지 않는 종목일 수 있어요).</div>'}
      ${op ? `<div class="an-kv"><span>투자의견 평균</span><b>${esc(op)}${c && c.opinion && Number.isFinite(parseFloat(c.opinion)) ? ` <small class="muted">(${fmt(parseFloat(c.opinion), 2)}/5)</small>` : ''}</b></div>` : ''}
      ${d && d.reports && d.reports.length ? `<div class="co-rep">${d.reports.map(r => `<a class="news-item" href="${r.id ? `https://finance.naver.com/research/company_read.naver?nid=${esc(r.id)}` : `https://finance.naver.com/research/company_list.naver?searchType=itemCode&itemCode=${esc(s.code)}`}" target="_blank" rel="noopener"><span class="tag">${esc(r.by || '리포트')}</span><span class="nt">${esc(r.t)}</span><span class="ns">${esc(String(r.d || '').slice(0, 10))}</span></a>`).join('')}</div>` : ''}
      ${statPick.length ? `<div class="co-stats">${statPick.map(x => `<span><small>${esc(x.k)}</small><b>${esc(x.v)}</b></span>`).join('')}</div>` : ''}
    </div>
    <div class="co-box co-wide co-out ${O.cls}"><h5>종합 전망 — ${esc(O.head)}</h5>
      <div class="co-3">
        <div><b class="good-t">좋은 점</b>${O.good.length ? O.good.map(x => `<p>✓ ${esc(x)}</p>`).join('') : '<p class="muted">뚜렷한 강점 신호가 아직 없어요.</p>'}</div>
        <div><b class="bad-t">걱정되는 점</b>${O.risk.length ? O.risk.map(x => `<p>• ${esc(x)}</p>`).join('') : '<p class="muted">큰 걱정 신호는 없어요.</p>'}</div>
        <div><b>앞으로 확인할 것</b>${O.watch.map(x => `<p>→ ${esc(x)}</p>`).join('')}</div>
      </div>
      <div class="hint">회사 설명·제품 비중·목표가는 네이버 금융·와이즈리포트(FnGuide) 자료이고, 종합 전망은 이 사이트가 모은 실적·수급·뉴스·차트 자료를 정해진 규칙으로 엮은 참고 의견이에요(투자 권유 아님). 더 보기: <a href="https://finance.naver.com/item/coinfo.naver?code=${esc(s.code)}" target="_blank" rel="noopener">네이버 기업정보</a> · <a href="https://dart.fss.or.kr/dsab007/main.do?textCrpNm=${q}" target="_blank" rel="noopener">DART 사업보고서</a></div>
    </div>
  </div>`;
}

async function coRender(s, mountId) {
  const box = document.getElementById(mountId); if (!box) return;
  box.dataset.code = s.code;
  box.innerHTML = coHtml(s, null);
  let d = null;
  try { d = await coFetch(s.code); } catch (e) { d = null; }
  if (box.dataset.code !== s.code || !document.getElementById(mountId)) return;
  box.innerHTML = coHtml(s, d && d.ok ? d : { _fail: true });
}
