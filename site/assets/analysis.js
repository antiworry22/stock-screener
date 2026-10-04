/* 종목 검색 → 한눈에 보는 종목 분석 보고서 */
'use strict';

function normName(x) { return String(x || '').replace(/\s/g, '').toLowerCase(); }
function findStocks(q) {
  const n = normName(q); if (!n) return [];
  const st = S.data.stocks;
  const exact = st.filter(s => s.code === n || normName(s.name) === n);
  if (exact.length) return exact;
  return st.filter(s => normName(s.name).includes(n) || s.code.includes(n)).sort((a, b) => a.name.length - b.name.length);
}

function verdictOf(s) {
  if (s._ban && s._ban.length) return { cls: 'bad', t: '매수 주의', d: `지금은 사지 않는 게 좋은 신호가 있어요: ${s._ban.join(', ')}.` };
  const r = s._rec, t = s._sc.total;
  if (r != null && r >= 65) return { cls: 'good', t: '관심 종목', d: '좋은 신호가 많고 큰 위험 신호가 적어요. 아래 손절가를 정해 두고 접근해 볼 만해요.' };
  if (r != null && r >= 50) return { cls: 'mid', t: '지켜볼 만함', d: '괜찮은 점이 있지만 아쉬운 점도 있어요. 신호가 더 좋아지는지 지켜보세요.' };
  if (t >= 50) return { cls: 'mid', t: '보통', d: '뚜렷하게 좋거나 나쁜 신호가 적어요.' };
  return { cls: 'low', t: '신호 약함', d: '지금은 좋은 신호가 적어요. 서두르지 않고 기다리는 편이 나아 보여요.' };
}

function rankPct(s, list, key) {
  const vals = list.map(x => key === 'total' ? x._sc.total : x._sc[key]).filter(v => v != null).sort((a, b) => b - a);
  const v = key === 'total' ? s._sc.total : s._sc[key];
  if (v == null || !vals.length) return null;
  const rank = vals.findIndex(x => x <= v) + 1;
  return { rank, n: vals.length, pct: Math.max(1, Math.round(rank / vals.length * 100)) };
}

function analysisHtml(s) {
  const v = verdictOf(s), st = S.data.stocks;
  const peers = st.filter(x => x.sector === s.sector && s.sector !== '기타');
  const rAll = rankPct(s, st, 'total'), rSec = peers.length > 2 ? rankPct(s, peers, 'total') : null;
  const r = riskCalc(s);
  const goods = (typeof recReasons === 'function' ? recReasons(s) : []);
  const bads = (typeof recCautions === 'function' ? recCautions(s) : []);
  const ck = (typeof easyCheck === 'function') ? easyCheck(s) : checklist(s);
  const weak = ck.filter(c => c.ok === false).map(c => /[까나가]$/.test(c.item) ? `${c.item.replace(/(인가|은가|는가|나|가)$/, '')} — 아직 부족` : c.item);
  const avg = k => { const a = peers.map(x => x._sc[k]).filter(x => x != null); return a.length ? Math.round(a.reduce((p, q) => p + q, 0) / a.length) : null; };
  const bars = [['technical', '차트 신호'], ['supply', '큰손 매수'], ['earnings', '돈 버는 힘'], ['sector', '업종 분위기'], ['stability', '재무 튼튼함']].map(([k, l]) => {
    const val = s._sc[k], a = avg(k);
    return `<div class="abar"><span class="al">${l}</span><div class="ab"><i style="width:${val ?? 0}%" class="${sCls(val)}"></i>${a != null ? `<b style="left:${a}%" title="업종 평균 ${a}"></b>` : ''}</div><span class="av mono">${val ?? '–'}</span></div>`;
  }).join('');
  const pats = (typeof PAT_FN !== 'undefined') ? Object.entries(PAT_FN).map(([k, fn]) => ({ k, p: fn(s) })) : [];
  const patHit = pats.filter(x => x.p && x.p.ok);
  const top = peers.filter(x => x !== s).sort((a, b) => b._sc.total - a._sc.total).slice(0, 5);
  const ns = typeof newsSummary === 'function' ? newsSummary(s) : [];
  return `
  <div class="an-head">
    <div><h2>${esc(s.name)} <span class="muted mono">${esc(s.code)}</span></h2>
      <div class="muted">${s.market === 'KOSPI' ? '코스피' : '코스닥'} · ${esc(s.sector)} · 회사 크기 ${s.mcap >= 10000 ? fmt(s.mcap / 10000, 1) + '조원' : fmt(s.mcap) + '억원'}</div></div>
    <div class="an-px"><b class="mono">${fmt(s.close)}원</b> <span class="${cls(s.chg)} mono">${pct(s.chg)}</span><div class="hint">1주 ${pct(s.ret5, 1)} · 1달 ${pct(s.ret20, 1)}</div>${s._tfD && typeof LIVE !== 'undefined' && LIVE.tfTime ? `<div class="hint"><span class="gov-live"></span> 실시간 ${esc(LIVE.tfTime.slice(11))} 기준 점수</div>` : ''}</div>
  </div>
  <div class="an-card an-wide"><h4>회사 알아보기 <small class="muted">— 무슨 사업을 하는지 · 주요 제품 · 증권사 전망 · 종합 전망</small></h4><div id="coMount"></div></div>
  <div class="an-card an-wide"><h4>실시간 종합 <small class="muted">— 재료(뉴스·공공기관) × 돈(거래대금) × 추세(차트)가 이 종목에 어떻게 맞물리는지</small></h4><div id="fuMount" data-code="${esc(s.code)}"></div></div>
  <div class="an-card an-wide"><h4>차트 종합 판정 <small class="muted">— 6축 점수 엔진(추세·모멘텀·거래량·구조·패턴·주봉) · 진입·손절·목표·손익비·체크리스트</small></h4><div id="clxMount" data-code="${esc(s.code)}"></div></div>
  <div class="an-card an-wide"><h4>차트 정밀 분석 · 평가 점수 · 추천 여부</h4><div id="clMount"></div></div>
  <div class="an-card an-wide"><h4>실시간 호가창 <small class="muted">— 잔량 불균형·매수/매도 벽·체결강도·허수 호가</small></h4><div id="obAnMount" data-code=""><button class="btn small" id="obAnGo">실시간 호가 열기</button> <span class="hint">누르면 3초마다 갱신돼요(30분 뒤 자동 멈춤)</span></div></div>
  <div class="an-card an-wide"><h4>거래량·거래대금 정밀 해석 <small class="muted">— 지금 이 종목에 돈이 어떻게 들어오고 나가나</small></h4><div id="vaMount"></div></div>
  <div class="an-grid">
    <div class="an-card"><h4>점수 한눈에 보기</h4>
      <div class="an-total">종합 점수 <b>${fmt(s._sc.total, 1)}</b>${s._rec != null ? ` · 추천점수 <b>${fmt(s._rec, 1)}</b>` : ''}</div>
      <div class="hint">${rAll ? `전체 ${rAll.n}종목 중 <b>${rAll.rank}위</b>(상위 ${rAll.pct}%)` : ''}${rSec ? ` · ${esc(s.sector)} ${rSec.n}종목 중 <b>${rSec.rank}위</b>` : ''}</div>
      ${bars}
      <div class="hint">막대 = 이 종목 점수, 세로선 = 같은 업종 평균</div>
    </div>
    <div class="an-card"><h4>좋은 점 ${goods.length}가지</h4>${goods.length ? goods.map(g => `<div class="an-li good">✓ ${esc(g)}</div>`).join('') : '<div class="hint">눈에 띄는 좋은 점이 아직 없어요.</div>'}
      <h4 class="mt">아쉬운 점·주의</h4>${[...bads, ...weak].slice(0, 7).map(b => `<div class="an-li bad">• ${esc(b)}</div>`).join('') || '<div class="hint">큰 주의 사항이 없어요.</div>'}
    </div>
    <div class="an-card"><h4>그 밖의 숫자</h4><div class="hint">손절가·목표가는 위 차트 정밀 분석을 참고하세요</div>
      <div class="an-kv"><span>지금 가격</span><b>${fmt(s.close)}원</b></div>
      <div class="an-kv"><span>증권사 목표가</span><b>${s.target ? fmt(s.target) + '원 (' + pct(s.upside, 1) + ')' : '없음'}</b></div>
      <div class="an-kv"><span>권장 수량 <small class="muted">자본 ${won(S.capital)}·1회 ${S.th.risk_pct}% 위험</small></span><b>${fmt(r.qty)}주</b></div>
      <div class="an-kv"><span>하루 흔들림</span><b>약 ${fmt(s.atr_pct, 1)}%</b></div>
    </div>
    <div class="an-card"><h4>차트 패턴</h4>
      ${pats.map(({ k, p }) => `<div class="an-li"><span class="tag ${p && p.ok ? 'good' : ''}">${p && p.ok ? '충족' : p ? '진행 중' : '해당 없음'}</span> ${PAT[k].label}</div>`).join('')}
      ${patHit.length ? patSvg(s, patHit[0].p) + `<div class="pat-steps">${patHit[0].p.steps.map(t => `<div>${t}</div>`).join('')}</div>` : (pats.find(x => x.p && x.k === 'pullback') ? patSvg(s, pats.find(x => x.k === 'pullback').p) : '')}
    </div>
    <div class="an-card"><h4>뉴스·공시</h4>${typeof liveNewsHtml === 'function' ? liveNewsHtml(s, 4) : ''}${ns.length ? ns.map(p => `<p class="an-p">${p}</p>`).join('') : '<div class="hint">최근 수집된 뉴스·공시가 없어요.</div>'}
      ${(s.news || []).slice(0, 4).map(n => `<a class="news-item" href="${esc(n.u)}" target="_blank" rel="noopener"><span class="tag ${n.tone > 0 ? 'good' : n.tone < 0 ? 'bad' : ''}">${n.tone > 0 ? '긍정' : n.tone < 0 ? '부정' : '중립'}</span><span class="nt">${esc(n.t)}</span><span class="ns">${esc(n.d || '')}</span></a>`).join('')}
    </div>
    <div class="an-card"><h4>시장 뉴스 속 이 종목 (국내·해외)</h4><div id="mnAnMount" data-code="${esc(s.code)}"></div></div>
    <div class="an-card"><h4>공공기관 자료·시장경보</h4><div id="govAnMount" data-code="${esc(s.code)}"></div></div>
    <div class="an-card"><h4>같은 업종 비교</h4>${top.length ? top.map(x => `<div class="an-peer" data-an="${esc(x.code)}"><span>${esc(x.name)}</span><span class="mono ${cls(x.chg)}">${pct(x.chg)}</span><span class="score ${sCls(x._sc.total)}">${fmt(x._sc.total, 1)}</span></div>`).join('') + '<div class="hint">누르면 그 종목을 분석합니다</div>' : '<div class="hint">같은 업종 정보가 없어요.</div>'}</div>
  </div>
  <div class="row gap wrap mt"><button class="btn primary" id="anDetail">차트·15개 항목 자세히 보기</button><a class="btn ghost" href="https://finance.naver.com/item/main.naver?code=${esc(s.code)}" target="_blank" rel="noopener">네이버 증권에서 보기</a></div>`;
}

function showAnalysis(code, quiet) {
  const s = S.data.stocks.find(x => x.code === code); if (!s) return;
  if (!quiet && typeof switchTab === 'function') switchTab('analysis');
  $('#anInput').value = s.name;
  $('#anOut').innerHTML = analysisHtml(s);
  $('#anDetail').onclick = () => openDetail(s.code);
  if ($('#obAnGo')) $('#obAnGo').onclick = () => obStart(s.code, 'obAnMount');
  if (quiet && typeof OB !== 'undefined' && OB.mount === 'obAnMount' && OB.code === s.code && OB.timer) { const m = $('#obAnMount'); if (m) { m.dataset.code = s.code; obPoll(); } }
  if (typeof coRender === 'function') coRender(s, 'coMount');
  if (typeof fuFillAnalysis === 'function') fuFillAnalysis();
  if (typeof renderClx === 'function') renderClx(s, 'clxMount');
  if (typeof renderChartLab === 'function') renderChartLab(s, 'clMount');
  if (typeof renderVolCard === 'function') renderVolCard(s, 'vaMount');
  if (typeof mnFillAnalysis === 'function') mnFillAnalysis();
  if (typeof govFillAnalysis === 'function') govFillAnalysis();
  $$('#anOut [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
  if (quiet) return;  // 실시간 갱신으로 다시 그릴 때는 기록·스크롤 그대로
  try { const h = store.get('anHist', []).filter(c => c !== code); h.unshift(code); store.set('anHist', h.slice(0, 8)); } catch (e) {}
  drawAnHist();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function anSearch(q) {
  const out = $('#anOut');
  const hits = findStocks(q);
  if (!q.trim()) { out.innerHTML = '<div class="empty">종목 이름이나 6자리 코드를 입력하세요. 예) 삼성전자, 005930</div>'; return; }
  if (!hits.length) { out.innerHTML = `<div class="empty">"${esc(q)}"과(와) 맞는 종목이 없어요. 분석 대상은 시가총액 1,000억원·거래대금 5억원 이상 ${S.data.stocks.length}종목입니다.</div>`; return; }
  if (hits.length === 1 || normName(hits[0].name) === normName(q) || hits[0].code === q.trim()) { showAnalysis(hits[0].code); return; }
  out.innerHTML = `<div class="hint">"${esc(q)}" 검색 결과 ${hits.length}종목 — 하나를 고르세요</div><div class="chips mt">${hits.slice(0, 30).map(s => `<button class="chip" data-an="${esc(s.code)}">${esc(s.name)} <span class="muted">${esc(s.code)}</span></button>`).join('')}</div>`;
  $$('#anOut [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
}

function drawAnHist() {
  const h = store.get('anHist', []).map(c => S.data.stocks.find(s => s.code === c)).filter(Boolean);
  $('#anHist').innerHTML = h.length ? '<span class="lbl">최근 본 종목</span>' + h.map(s => `<button class="chip" data-an="${esc(s.code)}">${esc(s.name)}</button>`).join('') : '';
  $$('#anHist [data-an]').forEach(el => el.onclick = () => showAnalysis(el.dataset.an));
}

function initAnalysis() {
  const dl = $('#stockNames');
  if (dl) dl.innerHTML = S.data.stocks.map(s => `<option value="${esc(s.name)}">${esc(s.code)}</option>`).join('');
  const go = (inp) => { anSearch(inp.value); if (typeof switchTab === 'function') switchTab('analysis'); };
  $('#anGo').onclick = () => go($('#anInput'));
  $('#anInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go($('#anInput')); } };
  const top = $('#topSearch');
  if (top) top.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#anInput').value = top.value; go(top); top.value = ''; top.blur(); } };
  if (top) top.onchange = () => { if (findStocks(top.value).length === 1 || S.data.stocks.some(s => s.name === top.value)) { $('#anInput').value = top.value; go(top); top.value = ''; } };
  drawAnHist();
}
