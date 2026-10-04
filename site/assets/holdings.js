/* 내 보유 종목 관리 — 매수 기록 → 실시간 손익 · 손절/목표/수익보호선 · 차트·거래대금·뉴스 신호로 "지금 할 일" 판정 · 상태 변화 알림
   기록은 이 브라우저(기기)에만 저장됩니다. 다른 기기로 옮길 때는 '백업 파일 저장 → 불러오기'를 씁니다. */
'use strict';

const HOLD = { open: null, form: null };
const H_ACT = {
  alert: ['즉시 점검', 'bad', 1],
  stop: ['손절선 이탈', 'bad', 2],
  protect: ['수익보호선 이탈', 'warn', 3],
  near: ['손절선 근접', 'warn', 4],
  t2: ['2차 목표 도달', 'good', 5],
  t1: ['1차 목표 도달', 'good', 6],
  weak: ['약세 신호', 'warn', 7],
  hold: ['보유 유지', 'ok', 9],
  na: ['시세 없음', 'low', 10],
};

function hLoad() { const d = store.get('holdings', null); return d && Array.isArray(d.items) ? d : { items: [] }; }
function hSave(d) { store.set('holdings', d); }
function hToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function hBizDays(from, to) {  // 매수일~오늘 사이 거래일 수(주말 제외, 공휴일 무시)
  const a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z'); if (!(a < b)) return 0;
  let n = 0; for (let d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6) n++; }
  return n;
}
const hMoney = v => v == null ? '–' : (v < 0 ? '−' : '') + won(Math.abs(Math.round(v)));
const hSigned = v => v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + won(Math.abs(Math.round(v)));

/* ── 한 종목 계산 ── */
function hInfo(h) {
  const s = S.data.stocks.find(x => x.code === h.code) || null;
  const buyQ = h.lots.reduce((a, l) => a + l.q, 0), sellQ = (h.sells || []).reduce((a, l) => a + l.q, 0);
  const qty = buyQ - sellQ;
  const avg = buyQ ? h.lots.reduce((a, l) => a + l.p * l.q, 0) / buyQ : 0;
  const realized = (h.sells || []).reduce((a, l) => a + (l.p - avg) * l.q, 0);
  const price = s ? s.close : (h.mp || null);
  const first = h.lots.map(l => l.d).sort()[0] || hToday();
  const o = { h, s, qty, avg, realized, price, first, name: s ? s.name : h.name };
  if (!price || qty <= 0) { o.act = qty <= 0 ? 'hold' : 'na'; o.reasons = []; o.goods = []; return o; }
  o.invested = avg * qty; o.value = price * qty; o.pnl = o.value - o.invested; o.pnlPct = (price / avg - 1) * 100;
  o.day = s && s.chg != null ? o.value - o.value / (1 + s.chg / 100) : null;
  const atr = (s && s.atr) || price * 0.03, mult = S.th.atr_mult || 2;
  o.atr = atr;
  o.stop0 = h.stop || Math.max(1, Math.round(avg - atr * mult));           // 처음 손절선 (직접 입력 우선)
  const R = Math.max(avg - o.stop0, avg * 0.01);
  o.R = R;
  // 매수 후 최고 종가(최근 120거래일 범위) → 수익보호선(최고가 − ATR×배수), 1.5R 넘게 오른 적 있으면 최소 본전
  const days = hBizDays(first, hToday());
  const sp = s && s.spark ? s.spark.filter(x => x != null) : [];
  const since = sp.slice(-Math.max(1, Math.min(sp.length, days + 1)));
  o.high = Math.max(price, ...(since.length ? since : [price]));
  let eff = o.stop0, protect = false;
  if (o.high >= avg + R) { const tr = Math.round(o.high - atr * mult); if (tr > eff) { eff = tr; protect = true; } }
  if (o.high >= avg + 1.5 * R && eff < avg) { eff = Math.round(avg); protect = true; }
  o.stop = eff; o.protect = protect;
  o.t1 = h.t1 || Math.round(avg + 2 * R);
  const clt2 = s && s.cl && s.cl.t2 && s.cl.t2 > o.t1 ? s.cl.t2 : null;
  o.t2 = h.t2 || Math.round(clt2 || avg + 3 * R);
  o.lossAtStop = Math.max(0, (price - o.stop) * qty);                       // 지금 손절선까지 내려가면 줄어드는 금액
  o.days = days;

  // 신호 모으기
  const reasons = [], goods = [];
  const cl = s && s.cl, fu = s && s._fu;
  const va = s && typeof volAll === 'function' ? volAll().get(s.code) : null;
  if (cl) {
    const t = `차트 판정 ${cl.v} (${cl.s > 0 ? '+' : ''}${fmt(cl.s, 1)})`;
    if (cl.s <= -28) reasons.push(t); else if (cl.s >= 28) goods.push(t);
    if (cl.nw >= 2) reasons.push(`차트 10계명 경고 ${cl.nw}개`);
  }
  if (fu) {
    if (['호재 속 이탈', '3박자 하락', '악재+이탈', '수급+추세 약세'].includes(fu.kind)) reasons.push(`실시간 ${fu.kind} — ${fu.text}`);
    else if (['3박자 정렬', '재료+돈 초기', '수급 선행', '수급+추세'].includes(fu.kind)) goods.push(`실시간 ${fu.kind}`);
  }
  if (va && typeof VSIG !== 'undefined') VSIG.forEach(([k, nm, tone, , fn]) => { try { if (fn(va)) (tone === 'bad' ? reasons : tone === 'good' ? goods : []).push('거래대금: ' + nm); } catch (e) {} });
  if (s && s._nw && s._newsLive != null) {
    if (s._newsLive <= -20) reasons.push(`악재 뉴스 우세(${s._newsLive}) — ${s._nw.heads[0] ? s._nw.heads[0].t : ''}`);
    else if (s._newsLive >= 20) goods.push(`호재 뉴스 우세(+${s._newsLive})`);
  }
  if (s && s._ban) s._ban.filter(b => !/시장경보/.test(b)).forEach(b => reasons.push('매수금지 신호: ' + b));
  if (s && s.rsi >= 75) reasons.push(`단기 과열 RSI ${Math.round(s.rsi)}`);
  if (s && s.sr20 === '이탈') reasons.push('20일 평균선 아래로 이탈');
  o.reasons = [...new Set(reasons)]; o.goods = [...new Set(goods)];

  // 지금 할 일 판정 (위에서부터 우선)
  const bad = o.reasons.length;
  if (s && s._alert) { o.act = 'alert'; o.todo = `거래소 시장경보(${s._alert}) — 추가 매수 금지, 보유 이유를 다시 확인하고 비중 축소를 우선 검토`; }
  else if (price <= o.stop && protect) { o.act = 'protect'; o.todo = `수익보호선 ${fmt(o.stop)}원 아래 — 남은 이익을 지키기 위해 매도(이익 확정) 원칙`; }
  else if (price <= o.stop) { o.act = 'stop'; o.todo = `손절선 ${fmt(o.stop)}원 아래 — 원칙대로 매도해 손실을 ${fmt(Math.abs(o.pnlPct), 1)}%에서 끊기 (손절은 협상 대상 아님)`; }
  else if (price <= o.stop * 1.03) { o.act = 'near'; o.todo = `손절선까지 ${fmt((price / o.stop - 1) * 100, 1)}% — 손절 주문을 미리 걸어 두고, 새로 사지 않기`; }
  else if (price >= o.t2) { o.act = 't2'; o.todo = `2차 목표 ${fmt(o.t2)}원 도달 — 대부분 이익 실현, 남은 물량은 수익보호선(${fmt(o.stop)}원)으로 관리`; }
  else if (price >= o.t1) { o.act = 't1'; o.todo = `1차 목표 ${fmt(o.t1)}원 도달 — 절반 정도 이익 실현하고 손절선을 본전(${fmt(Math.round(avg))}원) 이상으로 올리기`; }
  else if (bad >= 2 || (cl && cl.s <= -28)) { o.act = 'weak'; o.todo = '약세 신호가 겹침 — 추가 매수는 멈추고 비중 축소·손절선 점검'; }
  else { o.act = 'hold'; o.todo = o.goods.length ? '신호 양호 — 손절선만 지키며 보유' : '뚜렷한 신호 없음 — 손절선·목표가 기준으로 보유'; }
  return o;
}

/* ── 화면 ── */
function hActTag(o) { const a = H_ACT[o.act] || H_ACT.hold; return `<span class="h-act ${a[1]}">${a[0]}</span>`; }
function hBar(o) {
  // 손절선 ~ 2차 목표 사이에서 평균단가·현재가 위치
  const lo = Math.min(o.stop, o.price) * 0.99, hi = Math.max(o.t2, o.price) * 1.01, X = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  return `<div class="h-bar"><i class="h-zone" style="left:${X(o.stop)}%;width:${X(o.avg) - X(o.stop)}%"></i><i class="h-zone g" style="left:${X(o.avg)}%;width:${X(o.t2) - X(o.avg)}%"></i>
    <b class="h-mk st" style="left:${X(o.stop)}%" title="${o.protect ? '수익보호선' : '손절선'} ${fmt(o.stop)}"></b><b class="h-mk av" style="left:${X(o.avg)}%" title="평균단가 ${fmt(Math.round(o.avg))}"></b>
    <b class="h-mk t" style="left:${X(o.t1)}%" title="1차 목표 ${fmt(o.t1)}"></b><b class="h-mk t" style="left:${X(o.t2)}%" title="2차 목표 ${fmt(o.t2)}"></b>
    <b class="h-mk px ${o.pnl >= 0 ? 'up' : 'down'}" style="left:${X(o.price)}%" title="현재가 ${fmt(o.price)}"></b></div>
    <div class="h-bar-l"><span>${o.protect ? '보호선' : '손절'} ${fmt(o.stop)}</span><span>평단 ${fmt(Math.round(o.avg))}</span><span>1차 ${fmt(o.t1)}</span><span>2차 ${fmt(o.t2)}</span></div>`;
}
function hCard(o) {
  const h = o.h, s = o.s;
  if (o.qty <= 0) return `<div class="h-card closed" data-id="${h.id}"><div class="h-top"><div><b>${esc(o.name)}</b> <small class="muted">${esc(h.code)} · 전량 매도</small></div><div class="mono ${cls(o.realized)}">실현 ${hSigned(o.realized)}</div></div>
    <div class="row gap mt-s"><button class="btn ghost small" data-h="del" data-id="${h.id}">기록 삭제</button></div></div>`;
  if (!o.price) return `<div class="h-card" data-id="${h.id}"><div class="h-top"><div><b>${esc(o.name)}</b> <small class="muted">${esc(h.code)}</small> ${hActTag(o)}</div></div>
    <div class="hint">분석 대상(시가총액 1,000억·거래대금 5억 이상)이 아니라 시세가 없어요. 현재가를 직접 넣으면 손익을 계산해요.</div>
    <div class="row gap mt-s"><input class="inp small" type="number" placeholder="현재가" data-mp="${h.id}" style="width:120px"><button class="btn small" data-h="mp" data-id="${h.id}">적용</button><button class="btn ghost small" data-h="del" data-id="${h.id}">삭제</button></div></div>`;
  const open = HOLD.open === h.id;
  return `<div class="h-card act-${o.act}" data-id="${h.id}">
    <div class="h-top">
      <div><b class="h-nm" data-an="${esc(h.code)}">${esc(o.name)}</b> <small class="muted">${esc(h.code)} · ${s ? esc(s.sector) : ''} · ${o.days}거래일 보유</small> ${hActTag(o)}</div>
      <div class="h-pnl"><b class="mono ${cls(o.pnl)}">${pct(o.pnlPct, 2)}</b><small class="mono ${cls(o.pnl)}">${hSigned(o.pnl)}</small></div>
    </div>
    <div class="h-grid">
      <div><small>현재가</small><b class="mono">${fmt(o.price)}</b><em class="${cls(s && s.chg)}">${s ? pct(s.chg) : ''}</em></div>
      <div><small>평균단가 × 수량</small><b class="mono">${fmt(Math.round(o.avg))} × ${fmt(o.qty)}</b><em>${hMoney(o.invested)}</em></div>
      <div><small>평가금액</small><b class="mono">${hMoney(o.value)}</b><em class="${cls(o.day)}">오늘 ${hSigned(o.day)}</em></div>
      <div><small>${o.protect ? '수익보호선' : '손절선'}</small><b class="mono">${fmt(o.stop)}</b><em>${pct((o.stop / o.price - 1) * 100, 1)} · 도달 시 ${hSigned(-o.lossAtStop)}</em></div>
    </div>
    ${hBar(o)}
    <div class="h-todo ${H_ACT[o.act][1]}"><b>지금 할 일</b> ${esc(o.todo)}</div>
    ${o.reasons.length || o.goods.length ? `<div class="h-sig">${o.reasons.slice(0, 5).map(r => `<span class="tag bad">⚠ ${esc(r.length > 70 ? r.slice(0, 70) + '…' : r)}</span>`).join('')}${o.goods.slice(0, 4).map(g => `<span class="tag good">✓ ${esc(g)}</span>`).join('')}</div>` : ''}
    ${s && typeof liveNewsHtml === 'function' && s._nw && s._nw.nDir ? liveNewsHtml(s, 2) : ''}
    <div class="row gap wrap mt-s">
      <button class="btn small" data-h="buy" data-id="${h.id}">추가 매수</button><button class="btn small" data-h="sell" data-id="${h.id}">매도 기록</button>
      <button class="btn ghost small" data-h="edit" data-id="${h.id}">손절·목표 수정</button><button class="btn ghost small" data-h="log" data-id="${h.id}">${open ? '거래 내역 닫기' : '거래 내역'}</button>
      <button class="btn ghost small" data-an="${esc(h.code)}">종목 분석 →</button>
    </div>
    ${HOLD.form && HOLD.form.id === h.id ? hFormHtml(o) : ''}
    ${open ? hLogHtml(o) : ''}
  </div>`;
}
function hFormHtml(o) {
  const f = HOLD.form, h = o.h;
  if (f.kind === 'edit') return `<div class="h-form"><b>손절·목표 직접 정하기</b> <small class="muted">비워 두면 자동 계산(손절 = 평단 − ATR×${S.th.atr_mult}, 1차 = 2R, 2차 = 3R 또는 차트 엔진 목표)</small>
    <div class="row gap wrap mt-s"><label class="small">손절가 <input class="inp" type="number" id="hfStop" value="${h.stop || ''}" placeholder="${fmt(o.stop0)}"></label>
    <label class="small">1차 목표 <input class="inp" type="number" id="hfT1" value="${h.t1 || ''}" placeholder="${o.t1}"></label>
    <label class="small">2차 목표 <input class="inp" type="number" id="hfT2" value="${h.t2 || ''}" placeholder="${o.t2}"></label>
    <label class="small grow">메모 <input class="inp" id="hfMemo" value="${esc(h.memo || '')}" placeholder="매수 이유 등"></label></div>
    <div class="row gap mt-s"><button class="btn primary small" data-h="saveEdit" data-id="${h.id}">저장</button><button class="btn ghost small" data-h="cancel">취소</button><button class="btn ghost small danger" data-h="del" data-id="${h.id}">이 종목 삭제</button></div></div>`;
  const sell = f.kind === 'sell';
  return `<div class="h-form"><b>${sell ? '매도 기록' : '추가 매수'}</b>
    <div class="row gap wrap mt-s"><label class="small">${sell ? '매도가' : '매수가'} <input class="inp" type="number" id="hfP" value="${o.price || ''}"></label>
    <label class="small">수량 <input class="inp" type="number" id="hfQ" value="${sell ? o.qty : ''}" ${sell ? `max="${o.qty}"` : ''}></label>
    <label class="small">날짜 <input class="inp" type="date" id="hfD" value="${hToday()}"></label></div>
    <div class="row gap mt-s"><button class="btn primary small" data-h="${sell ? 'saveSell' : 'saveBuy'}" data-id="${h.id}">기록</button><button class="btn ghost small" data-h="cancel">취소</button></div></div>`;
}
function hLogHtml(o) {
  const h = o.h;
  const rows = [...h.lots.map((l, i) => ({ ...l, t: '매수', i, k: 'lots' })), ...(h.sells || []).map((l, i) => ({ ...l, t: '매도', i, k: 'sells' }))].sort((a, b) => a.d.localeCompare(b.d));
  return `<div class="h-log"><table class="clx-tb"><thead><tr><th>날짜</th><th>구분</th><th>가격</th><th>수량</th><th>금액</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.d)}</td><td class="${r.t === '매수' ? 'up' : 'down'}">${r.t}</td><td class="mono">${fmt(r.p)}</td><td class="mono">${fmt(r.q)}</td><td class="mono">${hMoney(r.p * r.q)}</td><td><button class="btn ghost small" data-h="rmrow" data-id="${h.id}" data-k="${r.k}" data-i="${r.i}">지우기</button></td></tr>`).join('')}
    </tbody></table>${o.realized ? `<div class="hint">실현 손익 ${hSigned(o.realized)} (평균단가 기준)</div>` : ''}${h.memo ? `<div class="hint">메모: ${esc(h.memo)}</div>` : ''}</div>`;
}

function hAll() { return hLoad().items.map(h => { try { return hInfo(h); } catch (e) { console.error(e); return null; } }).filter(Boolean); }
function hSummary(list) {
  const act = list.filter(o => o.qty > 0 && o.price);
  const sum = k => act.reduce((a, o) => a + (o[k] || 0), 0);
  const inv = sum('invested'), val = sum('value');
  const sec = {}; act.forEach(o => { const k = o.s ? o.s.sector : '기타'; sec[k] = (sec[k] || 0) + o.value; });
  return { n: act.length, inv, val, pnl: val - inv, pnlPct: inv ? (val / inv - 1) * 100 : 0, day: sum('day'), risk: sum('lossAtStop'),
    realized: list.reduce((a, o) => a + (o.realized || 0), 0), sec: Object.entries(sec).sort((a, b) => b[1] - a[1]),
    need: act.filter(o => ['alert', 'stop', 'protect', 'near', 't2', 't1', 'weak'].includes(o.act)).sort((a, b) => H_ACT[a.act][2] - H_ACT[b.act][2]) };
}
function hSumHtml(sm, compact) {
  const secTop = sm.sec.slice(0, 4).map(([k, v]) => `${esc(k)} ${Math.round(v / sm.val * 100)}%`).join(' · ');
  const conc = sm.sec.length && sm.sec[0][0] !== '기타' && sm.sec[0][1] / sm.val >= 0.5 && sm.n >= 2;
  return `<div class="cards h-sum">
    <div class="card"><div class="k">평가금액</div><div class="v mono">${hMoney(sm.val)}</div><div class="d muted">투자 ${hMoney(sm.inv)} · ${sm.n}종목</div></div>
    <div class="card"><div class="k">평가 손익</div><div class="v mono ${cls(sm.pnl)}">${hSigned(sm.pnl)}</div><div class="d ${cls(sm.pnl)}">${pct(sm.pnlPct, 2)}</div></div>
    <div class="card"><div class="k">오늘 변동</div><div class="v mono ${cls(sm.day)}">${hSigned(sm.day)}</div><div class="d muted">실현 손익 ${hSigned(sm.realized)}</div></div>
    <div class="card"><div class="k">손절선 도달 시</div><div class="v mono down">${hSigned(-sm.risk)}</div><div class="d muted">평가금액의 ${sm.val ? fmt(sm.risk / sm.val * 100, 1) : 0}% · 자본의 ${fmt(sm.risk / S.capital * 100, 1)}%</div></div>
    ${compact ? '' : `<div class="card"><div class="k">업종 비중</div><div class="v small">${secTop || '–'}</div><div class="d ${conc ? 'down' : 'muted'}">${conc ? '한 업종 50%↑ — 분산 부족' : sm.sec.length && sm.sec[0][0] === '기타' ? '업종 정보가 없는 종목 포함' : '분산 양호'}</div></div>`}
  </div>`;
}

function renderHold() {
  const box = $('#holdList'); if (!S.data) return;
  const list = hAll(), sm = hSummary(list);
  hCheckAlerts(list);
  const tab = $('button[data-tab="hold"]'); if (tab) tab.dataset.badge = sm.need.filter(o => ['alert', 'stop', 'protect', 'near', 't1', 't2'].includes(o.act)).length || '';
  renderHoldDash(list, sm);
  if (!box) return;
  $('#holdSum').innerHTML = sm.n ? hSumHtml(sm) : '';
  const order = list.slice().sort((a, b) => (a.qty <= 0) - (b.qty <= 0) || (H_ACT[a.act] || H_ACT.hold)[2] - (H_ACT[b.act] || H_ACT.hold)[2] || (b.value || 0) - (a.value || 0));
  box.innerHTML = order.length ? order.map(hCard).join('') : '<div class="empty">아직 등록한 종목이 없어요. 위에서 산 종목·가격·수량을 넣으면 실시간으로 관리해 드려요.</div>';
  const t = typeof LIVE !== 'undefined' && LIVE.tfTime;
  $('#holdMeta').innerHTML = `${t ? `<span class="gov-live"></span> 시세·신호 ${esc(String(t).slice(11))} 기준 (장중 15분마다 갱신)` : `시세 ${esc(S.data.meta.asof)} 종가 기준 — 장중엔 15분마다 자동 갱신`} · 기록은 이 기기 브라우저에 저장`;
  hBind(box);
}
function renderHoldDash(list, sm) {
  const el = $('#holdDash'); if (!el) return;
  if (!sm.n) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="ph"><h2>내 보유 종목</h2><button class="btn ghost small" id="hdGo">보유 종목 관리 →</button></div>${hSumHtml(sm, true)}
    ${sm.need.length ? `<div class="h-need">${sm.need.slice(0, 6).map(o => `<div class="item" data-an="${esc(o.h.code)}"><div class="nm"><b>${esc(o.name)}</b> ${hActTag(o)}<small>${esc(o.todo)}</small></div><div class="rt"><b class="mono ${cls(o.pnl)}">${pct(o.pnlPct, 1)}</b></div></div>`).join('')}</div>` : '<div class="hint">지금 바로 손볼 종목은 없어요 — 모두 손절선 위, 목표 미도달, 큰 경고 없음.</div>'}`;
  $$('#holdDash [data-an]').forEach(x => x.onclick = () => showAnalysis(x.dataset.an));
  $('#hdGo').onclick = () => switchTab('hold');
}

/* ── 상태가 바뀌면 알림 (손절선 이탈·근접, 목표 도달, 시장경보, 약세 전환) ── */
function hCheckAlerts(list) {
  const prev = store.get('holdPrevAct', {}), now = {}, hot = [];
  list.forEach(o => {
    if (o.qty <= 0 || !o.price) return;
    now[o.h.id] = o.act;
    const p = prev[o.h.id];
    if (p && p !== o.act && o.act !== 'hold') hot.push(o);
  });
  store.set('holdPrevAct', now);
  if (!hot.length) return;
  hot.sort((a, b) => H_ACT[a.act][2] - H_ACT[b.act][2]);
  const txt = hot.map(o => `${o.name}: ${H_ACT[o.act][0]}`);
  const t = $('#govToast');
  if (t) { t.innerHTML = `💼 보유 종목 ${hot.length}건 — ${esc(txt[0])}`; t.classList.remove('hidden'); t.onclick = () => { switchTab('hold'); t.classList.add('hidden'); }; setTimeout(() => t.classList.add('hidden'), 20000); }
  if (store.get('holdNoti', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('보유 종목 알림 ' + hot.length + '건', { body: hot.map(o => `${o.name}: ${H_ACT[o.act][0]} — ${o.todo}`).join('\n').slice(0, 300) }); } catch (e) {}
  }
}

/* ── 입력·버튼 ── */
function hFind(id) { const d = hLoad(); return { d, h: d.items.find(x => x.id === id) }; }
function hNum(id) { const v = $(id) && $(id).value; return v === '' || v == null ? null : Number(v); }
function hBind(root) {
  $$('[data-an]', root).forEach(x => x.onclick = () => showAnalysis(x.dataset.an));
  $$('[data-h]', root).forEach(b => b.onclick = e => {
    e.stopPropagation();
    const k = b.dataset.h, id = b.dataset.id;
    if (k === 'cancel') { HOLD.form = null; return renderHold(); }
    if (k === 'buy' || k === 'sell' || k === 'edit') { HOLD.form = { id, kind: k }; return renderHold(); }
    if (k === 'log') { HOLD.open = HOLD.open === id ? null : id; return renderHold(); }
    const { d, h } = hFind(id); if (!h) return;
    if (k === 'del') { if (!confirm(`${h.name} 기록을 모두 지울까요?`)) return; d.items = d.items.filter(x => x.id !== id); }
    else if (k === 'mp') { const v = Number(($(`[data-mp="${id}"]`) || {}).value); if (!(v > 0)) return; h.mp = v; }
    else if (k === 'rmrow') { const arr = h[b.dataset.k]; if (!arr || !confirm('이 거래를 지울까요?')) return; arr.splice(+b.dataset.i, 1); if (!h.lots.length) d.items = d.items.filter(x => x.id !== id); }
    else if (k === 'saveEdit') { h.stop = hNum('#hfStop'); h.t1 = hNum('#hfT1'); h.t2 = hNum('#hfT2'); h.memo = $('#hfMemo').value.trim(); HOLD.form = null; }
    else if (k === 'saveBuy' || k === 'saveSell') {
      const p = hNum('#hfP'), q = hNum('#hfQ'), dd = $('#hfD').value || hToday();
      if (!(p > 0) || !(q > 0)) { alert('가격과 수량을 넣어 주세요.'); return; }
      if (k === 'saveSell') { const o = hInfo(h); if (q > o.qty) { alert(`보유 수량(${o.qty}주)보다 많이 팔 수 없어요.`); return; } (h.sells = h.sells || []).push({ d: dd, p, q }); }
      else h.lots.push({ d: dd, p, q });
      HOLD.form = null;
    }
    hSave(d); renderHold();
  });
}
function hAdd() {
  const q = $('#hAddName').value.trim();
  const hits = typeof findStocks === 'function' ? findStocks(q) : [];
  let code, name;
  if (hits.length === 1 || (hits[0] && (hits[0].name === q || hits[0].code === q))) { code = hits[0].code; name = hits[0].name; }
  else if (/^\d{6}$/.test(q)) { code = q; name = q; }
  else { alert(hits.length ? `"${q}" 검색 결과가 ${hits.length}개예요. 목록에서 정확한 이름을 골라 주세요.` : `"${q}" 종목을 찾지 못했어요. 분석 대상이 아닌 종목은 6자리 코드로 넣어 주세요.`); return; }
  const p = hNum('#hAddP'), qty = hNum('#hAddQ'), dd = $('#hAddD').value || hToday();
  if (!(p > 0) || !(qty > 0)) { alert('매수가와 수량을 넣어 주세요.'); return; }
  const d = hLoad();
  let h = d.items.find(x => x.code === code && hInfo(x).qty > 0);
  if (h) h.lots.push({ d: dd, p, q: qty });
  else { h = { id: 'h' + Date.now().toString(36), code, name, lots: [{ d: dd, p, q: qty }], sells: [], stop: hNum('#hAddStop'), t1: null, t2: null, memo: $('#hAddMemo').value.trim() }; d.items.push(h); }
  hSave(d);
  ['#hAddName', '#hAddP', '#hAddQ', '#hAddStop', '#hAddMemo'].forEach(x => { if ($(x)) $(x).value = ''; });
  renderHold();
}
function hExport() {
  const blob = new Blob([JSON.stringify({ app: 'kmy-stock', v: 1, saved: hToday(), ...hLoad() }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `보유종목_백업_${hToday()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function hImport(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const j = JSON.parse(r.result); if (!Array.isArray(j.items)) throw new Error('형식');
      const d = hLoad(), ids = new Set(d.items.map(x => x.id));
      const mode = d.items.length ? confirm('지금 기록을 백업 파일 내용으로 바꿀까요?\n[확인] 바꾸기 · [취소] 합치기') : true;
      d.items = mode ? j.items : [...d.items, ...j.items.filter(x => !ids.has(x.id))];
      hSave(d); renderHold(); alert(`보유 종목 ${j.items.length}개를 불러왔어요.`);
    } catch (e) { alert('백업 파일을 읽지 못했어요.'); }
  };
  r.readAsText(file);
}
function initHold() {
  if (!$('#hAddGo')) return;
  $('#hAddD').value = hToday();
  $('#hAddName').onchange = () => { const h = typeof findStocks === 'function' ? findStocks($('#hAddName').value) : []; if (h.length === 1 && !$('#hAddP').value) $('#hAddP').value = h[0].close; };
  $('#hAddGo').onclick = hAdd;
  ['#hAddP', '#hAddQ'].forEach(x => $(x).onkeydown = e => { if (e.key === 'Enter') hAdd(); });
  $('#hExport').onclick = hExport;
  $('#hImport').onclick = () => $('#hImportFile').click();
  $('#hImportFile').onchange = e => { if (e.target.files[0]) hImport(e.target.files[0]); e.target.value = ''; };
  const nb = $('#hNoti');
  const draw = () => { nb.textContent = store.get('holdNoti', false) ? '🔔 보유 종목 알림 켜짐' : '🔕 보유 종목 알림 켜기'; };
  nb.onclick = async () => {
    if (!('Notification' in window)) { alert('이 브라우저는 알림을 지원하지 않아요.'); return; }
    if (store.get('holdNoti', false)) { store.set('holdNoti', false); draw(); return; }
    const p = await Notification.requestPermission(); store.set('holdNoti', p === 'granted'); draw();
  };
  draw();
}
