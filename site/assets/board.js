/* 실시간 현황판 — 증권사 화면처럼 한 화면에서
   ① 관심·보유 종목 시세표(5초) ② 호가창(3초) ③ 체결(호가를 받을 때마다 거래량 변화로 기록 + 시간대별 체결) ④ 분봉·일봉 차트
   ⑤ 내 보유 현황(실시간 평가손익) ⑥ 실시간 알림(급등락·큰 체결·손절선/목표가 도달)
   자료: /api/board(여러 종목 현재가 · 분봉/일봉/체결) · /api/hoga(호가). 몇 초마다 다시 받는 방식이라 순간순간의 모든 체결이 보이지는 않아요. */
'use strict';

const BD = { q: {}, prevQ: {}, qt: 0, sel: null, st: {}, busy: false, hbusy: false, cbusy: false, alerts: [], flash: {}, tf: 'min' };
const bdKst = () => new Date(Date.now() + 9 * 3600e3);
const bdNowT = () => bdKst().toISOString().slice(11, 19);
const bdToday = () => bdKst().toISOString().slice(0, 10);
function bdOpen() { const k = bdKst(), m = k.getUTCHours() * 60 + k.getUTCMinutes(), wd = k.getUTCDay(); return wd >= 1 && wd <= 5 && m >= 520 && m <= 940; }
const bdEok = v => v == null ? '–' : Math.abs(v) >= 10000 ? fmt(v / 10000, 2) + '조' : fmt(v, v < 10 ? 1 : 0) + '억';
const bdVol = v => v == null ? '–' : v >= 1e8 ? fmt(v / 1e8, 2) + '억' : v >= 1e4 ? fmt(v / 1e4, v >= 1e6 ? 0 : 1) + '만' : fmt(v);
const bdP = v => v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, 2)}%`;
const bdStock = c => S.data.stocks.find(x => x.code === c);

/* ── 종목 목록: 보유 + 매매 타이밍 관심 + 이 화면에서 추가한 종목 ── */
function bdList() {
  const hs = typeof hLoad === 'function' ? hLoad().items.filter(h => { const b = h.lots.reduce((a, l) => a + l.q, 0), s = (h.sells || []).reduce((a, l) => a + l.q, 0); return b - s > 0; }).map(h => h.code) : [];
  const tw = store.get('tmWatch', []) || [], own = store.get('bdList', []) || [];
  return [...new Set([...hs, ...own, ...tw])].slice(0, 30).map(c => ({ code: c, hold: hs.includes(c) }));
}
function bdAdd(code) { const L = store.get('bdList', []) || []; if (!L.includes(code)) { L.unshift(code); store.set('bdList', L.slice(0, 30)); } }
function bdRemove(code) { store.set('bdList', (store.get('bdList', []) || []).filter(c => c !== code)); }

/* ── 보유 정보 ── */
function bdHold(code) {
  if (typeof hLoad !== 'function') return null;
  const h = hLoad().items.find(x => x.code === code); if (!h) return null;
  const buyQ = h.lots.reduce((a, l) => a + l.q, 0), sellQ = (h.sells || []).reduce((a, l) => a + l.q, 0), qty = buyQ - sellQ;
  if (qty <= 0) return null;
  const avg = h.lots.reduce((a, l) => a + l.p * l.q, 0) / buyQ;
  let info = null; try { info = typeof hInfo === 'function' ? hInfo(h) : null; } catch (e) {}
  return { h, qty, avg, stop: info && info.stop, t1: info && info.t1, name: info ? info.name : h.name };
}

/* ── 자료 받기 ── */
async function bdLoadQuotes(force) {
  const L = bdList().map(x => x.code); if (BD.sel && !L.includes(BD.sel)) L.unshift(BD.sel);
  if (!L.length) return;
  const gap = bdOpen() ? (typeof svGap === 'function' ? svGap(4500, 15000) : 4500) : 60e3;
  if (!force && Date.now() - BD.qt < gap) return;
  BD.qt = Date.now();
  try {
    const r = await fetch('/api/board?q=' + L.slice(0, 30).join(','), { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (j && j.q) { Object.entries(j.q).forEach(([c, q]) => { const p = BD.q[c]; if (p && p.price !== q.price) BD.flash[c] = q.price > p.price ? 'up' : 'down'; BD.prevQ[c] = p; BD.q[c] = { ...q, at: j.at }; bdQuoteAlerts(c, q, p); }); } }
  } catch (e) {}
}
async function bdLoadBook() {
  const c = BD.sel; if (!c || BD.hbusy) return;
  const st = BD.st[c] = BD.st[c] || { ticks: [], buyV: 0, sellV: 0, book: null };
  if (st.bt && Date.now() - st.bt < (bdOpen() ? (typeof svGap === 'function' ? svGap(2800, 10000) : 2800) : 60e3)) return;
  BD.hbusy = true; st.bt = Date.now();
  try {
    const r = await fetch('/api/hoga?code=' + c, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json(), q = j.quote, b = j.book;
      if (q && q.price) {
        // 직전 값과 비교해 「체결」 한 줄을 만듦: 늘어난 거래량 · 매수/매도 방향(매도1호가 이상 체결=매수, 매수1호가 이하=매도)
        const pv = st.lastVol, pp = st.lastPrice, pb = st.book;
        if (pv != null && q.vol != null && q.vol > pv) {
          const dv = q.vol - pv, a1 = pb && pb.asks[0] ? pb.asks[0].p : null, b1 = pb && pb.bids[0] ? pb.bids[0].p : null;
          const side = a1 && q.price >= a1 ? 'buy' : b1 && q.price <= b1 ? 'sell' : pp != null ? (q.price > pp ? 'buy' : q.price < pp ? 'sell' : 'mid') : 'mid';
          st.ticks.unshift({ t: bdNowT().slice(0, 8), p: q.price, dv, side, live: true });
          if (side === 'buy') st.buyV += dv; else if (side === 'sell') st.sellV += dv;
          if (st.ticks.length > 200) st.ticks.length = 200;
          bdTickAlert(c, q.price, dv, side);
        }
        st.lastVol = q.vol; st.lastPrice = q.price;
        const prev = BD.q[c];
        BD.q[c] = { ...(prev || {}), code: c, price: q.price, pct: q.chgPct ?? (prev && prev.pct), chg: q.chg ?? (prev && prev.chg), vol: q.vol ?? (prev && prev.vol), tv: q.value != null ? q.value / 1e8 : prev && prev.tv, high: q.high ?? (prev && prev.high), low: q.low ?? (prev && prev.low), open: q.open ?? (prev && prev.open), at: j.at };
        if (prev && prev.price !== q.price) BD.flash[c] = q.price > prev.price ? 'up' : 'down';
      }
      if (b && (b.asks || []).length) { const pb = st.book; st.book = b; try { bdBookEvents(c, st, pb, b, BD.q[c]); } catch (e) { console.error(e); } }
    }
  } catch (e) {}
  BD.hbusy = false;
}
async function bdLoadChart(force) {
  const c = BD.sel; if (!c || BD.cbusy) return;
  const st = BD.st[c] = BD.st[c] || { ticks: [], buyV: 0, sellV: 0, book: null };
  if (!force && st.ct && Date.now() - st.ct < (bdOpen() ? (typeof svGap === 'function' ? svGap(30e3, 120e3) : 30e3) : 300e3)) return;
  BD.cbusy = true; st.ct = Date.now();
  try {
    const r = await fetch('/api/board?c=' + c, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j.min && j.min.length) { st.min = bdMinFix(j.min); st.minDay = j.minDay; }
      if (j.day && j.day.length) st.day = j.day;
      if (j.ticks && j.ticks.length) st.hist = j.ticks;
    }
  } catch (e) {}
  if (!st.day && typeof clxLoad === 'function') { try { const f = await clxLoad(c); if (f && f.c) st.day = f.d.map((d, i) => [d.replace(/-/g, ''), f.o[i], f.h[i], f.l[i], f.c[i], f.v[i]]); } catch (e) {} }
  BD.cbusy = false;
}
/* 분봉 거래량이 누적값으로 오면 1분 거래량으로 바꿈 */
function bdMinFix(rows) {
  const v = rows.map(r => r[5]); let inc = 0; for (let i = 1; i < v.length; i++) if (v[i] >= v[i - 1]) inc++;
  if (v.length > 10 && inc / (v.length - 1) > 0.97) rows = rows.map((r, i) => [r[0], r[1], r[2], r[3], r[4], i ? Math.max(0, v[i] - v[i - 1]) : v[0]]);
  // 분봉이 종가만 올 때(시가=고가=저가=종가): 직전 분 종가를 시가로 삼아 몸통이 보이는 캔들로
  const flat = rows.filter(r => r[1] === r[4] && r[2] === r[4] && r[3] === r[4]).length;
  if (rows.length > 10 && flat / rows.length > 0.8) rows = rows.map((r, i) => { const o = i ? rows[i - 1][4] : r[4]; return [r[0], o, Math.max(o, r[4]), Math.min(o, r[4]), r[4], r[5]]; });
  return rows;
}

/* ── 실시간 알림 ── */
function bdPush(code, kind, txt, tone) {
  const k = code + kind + txt; if (BD.alerts.some(a => a.k === k)) return;
  BD.alerts.unshift({ k, t: bdNowT().slice(0, 5), code, kind, txt, tone });
  if (BD.alerts.length > 60) BD.alerts.length = 60;
}
function bdQuoteAlerts(c, q, p) {
  if (!p || !bdOpen()) return;
  const nm = q.name || (bdStock(c) || {}).name || c;
  // 5분 안 급등락
  const st = BD.st[c] = BD.st[c] || { ticks: [], buyV: 0, sellV: 0, book: null };
  st.ph = (st.ph || []).filter(x => Date.now() - x[0] <= 300e3); st.ph.push([Date.now(), q.price]);
  const p0 = st.ph[0][1], d = (q.price / p0 - 1) * 100;
  if (Math.abs(d) >= 2 && !(st.lastJump && Date.now() - st.lastJump < 300e3)) { st.lastJump = Date.now(); bdPush(c, 'jump', `${nm} 5분 사이 ${d > 0 ? '급등' : '급락'} ${bdP(d)} (${fmt(p0)} → ${fmt(q.price)})`, d > 0 ? 'up' : 'down'); }
  // 보유 종목: 손절선 · 목표가
  const H = bdHold(c);
  if (H) {
    if (H.stop && q.price <= H.stop && p.price > H.stop) bdPush(c, 'stop', `${nm} 손절선 ${fmt(H.stop)}원 이탈 — 현재 ${fmt(q.price)}원`, 'down');
    if (H.t1 && q.price >= H.t1 && p.price < H.t1) bdPush(c, 't1', `${nm} 1차 목표가 ${fmt(H.t1)}원 도달 — 절반 이익 실현 검토`, 'up');
  }
  // 신고가·신저가(오늘)
  if (q.high && p.high && q.high > p.high && q.price >= q.high && q.pct >= 3) bdPush(c, 'hi' + Math.round(q.high), `${nm} 오늘 최고가 경신 ${fmt(q.high)}원 (${bdP(q.pct)})`, 'up');
}
function bdTickAlert(c, price, dv, side) {
  const amt = price * dv / 1e8, nm = (bdStock(c) || {}).name || (BD.q[c] && BD.q[c].name) || c;
  const s = bdStock(c), base = s && s.tvalue ? Math.max(1, s.tvalue / 390 * 3) : 3;   // 평소 1분 거래대금의 3배를 「큰 체결」로
  if (amt >= base && amt >= 1) bdPush(c, 'big' + bdNowT(), `${nm} 큰 체결 ${side === 'buy' ? '매수' : side === 'sell' ? '매도' : ''} ${bdEok(amt)} (${fmt(dv)}주 @ ${fmt(price)})`, side === 'buy' ? 'up' : side === 'sell' ? 'down' : '');
}

/* ── 그림: 캔들 + 거래량 (SVG) ── */
function bdCandles(rows, o) {
  const n = rows.length; if (n < 2) return '';
  const W = o.w || 640, H = o.h || 260, VH = 54, top = 8, ph = H - VH - 24;
  const hi = Math.max(...rows.map(r => r[2]), ...(o.lines || []).flatMap(l => l.v.filter(x => x != null)), o.ref || -Infinity);
  const lo = Math.min(...rows.map(r => r[3]), ...(o.lines || []).flatMap(l => l.v.filter(x => x != null)), o.ref != null ? o.ref : Infinity);
  const sp = hi - lo || 1, vmax = Math.max(1, ...rows.map(r => r[5] || 0));
  const bw = (W - 50) / n, X = i => 4 + i * bw + bw / 2, Y = v => top + (hi - v) / sp * ph, VY = v => H - 18 - (v / vmax) * VH;
  let g = '';
  rows.forEach((r, i) => {
    const up = r[4] >= r[1], c = up ? 'var(--up)' : 'var(--down)', x = X(i), w = Math.max(1, bw * 0.7);
    g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${Y(r[2]).toFixed(1)}" y2="${Y(r[3]).toFixed(1)}" stroke="${c}" stroke-width="1"/>`;
    const y1 = Y(Math.max(r[1], r[4])), y2 = Y(Math.min(r[1], r[4]));
    g += `<rect x="${(x - w / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, y2 - y1).toFixed(1)}" fill="${up ? c : c}" ${up && bw > 4 ? `fill-opacity="0.15" stroke="${c}"` : ''}><title>${esc(o.fmtT ? o.fmtT(r[0]) : r[0])} 시 ${fmt(r[1])} 고 ${fmt(r[2])} 저 ${fmt(r[3])} 종 ${fmt(r[4])} · 거래량 ${bdVol(r[5])}</title></rect>`;
    g += `<rect x="${(x - w / 2).toFixed(1)}" y="${VY(r[5] || 0).toFixed(1)}" width="${w.toFixed(1)}" height="${(H - 18 - VY(r[5] || 0)).toFixed(1)}" fill="${c}" opacity=".45"/>`;
  });
  (o.lines || []).forEach(l => { let d = '', pen = false; l.v.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }); g += `<path d="${d}" fill="none" stroke="${l.c}" stroke-width="1.3"${l.dash ? ` stroke-dasharray="${l.dash}"` : ''}/>`; });
  if (o.split != null) { const sx = X(o.split) - bw / 2; g += `<line x1="${sx}" x2="${sx}" y1="${top}" y2="${H - 18}" stroke="var(--muted)" stroke-dasharray="4 3"/><text x="${sx + 3}" y="${top + ph - 4}" font-size="10" fill="var(--muted)">시간외</text>`; }
  if (o.ref != null) g += `<line x1="0" x2="${W - 46}" y1="${Y(o.ref)}" y2="${Y(o.ref)}" stroke="var(--muted)" stroke-dasharray="3 3"/><text x="6" y="${Y(o.ref) - 3}" font-size="10" fill="var(--muted)">전일 종가 ${fmt(o.ref)}</text>`;
  const last = rows[n - 1][4];
  g += `<line x1="0" x2="${W - 46}" y1="${Y(last)}" y2="${Y(last)}" stroke="var(--text)" stroke-width=".6" stroke-dasharray="1 2"/><rect x="${W - 46}" y="${Y(last) - 8}" width="46" height="16" rx="3" fill="var(--text)"/><text x="${W - 23}" y="${Y(last) + 4}" font-size="10" fill="var(--panel)" text-anchor="middle">${fmt(last)}</text>`;
  g += `<text x="${W - 44}" y="${top + 8}" font-size="10" fill="var(--muted)">${fmt(hi)}</text>${Math.abs(Y(lo) - Y(last)) > 14 ? `<text x="${W - 44}" y="${top + ph}" font-size="10" fill="var(--muted)">${fmt(lo)}</text>` : ''}`;
  const lab = (o.labels || []).filter(([i]) => i >= 2 || (o.labels || []).length < 3); lab.forEach(([i, t]) => { g += `<text x="${X(i)}" y="${H - 4}" font-size="10" fill="var(--muted)" text-anchor="middle">${esc(t)}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" class="bd-svg" role="img" aria-label="${esc(o.aria || '차트')}">${g}</svg>${o.leg ? `<div class="iv-leg">${o.leg.map(([n2, c]) => `<span><i style="background:${c}"></i>${esc(n2)}</span>`).join('')}</div>` : ''}`;
}
function bdSma(c, n) { return c.map((_, i) => i < n - 1 ? null : c.slice(i - n + 1, i + 1).reduce((a, x) => a + x, 0) / n); }

/* ── 화면 조각 ── */
function bdQuoteRows() {
  const L = bdList();
  if (!L.length) return '<p class="hint">위 검색 칸에서 종목을 추가하세요. 「내 보유 종목」과 매매 타이밍 ☆ 관심 종목도 자동으로 들어와요.</p>';
  return `<table class="tbl bd-wl"><thead><tr><th class="l">종목</th><th>현재가</th><th>등락률</th><th>거래대금</th><th></th></tr></thead><tbody>${L.map(({ code, hold }) => {
    const q = BD.q[code], s = bdStock(code), H = hold ? bdHold(code) : null, nm = (s && s.name) || (q && q.name) || code;
    const pl = H && q ? (q.price - H.avg) * H.qty : null, plp = H && q ? (q.price / H.avg - 1) * 100 : null;
    const fl = BD.flash[code]; delete BD.flash[code];
    return `<tr data-bd="${esc(code)}" class="${BD.sel === code ? 'on' : ''}"><td class="l"><b>${esc(nm)}</b>${hold ? ' <small class="bd-own">보유</small>' : ''}${bdGradeChip(s)}${pl != null ? `<small class="bd-pl ${cls(pl)}">${pl > 0 ? '+' : ''}${fmt(Math.round(pl))}원 ${bdP(plp)}</small>` : ''}</td>
      <td class="mono ${q ? cls(q.pct) : ''}"><span class="${fl ? 'bd-fl-' + fl : ''}">${q ? fmt(q.price) : (s ? fmt(s.close) : '–')}</span></td>
      <td class="mono ${q ? cls(q.pct) : ''}">${q ? bdP(q.pct) : s ? bdP(s.chg) : '–'}</td><td class="mono">${q ? bdEok(q.tv) : '–'}</td>
      <td>${hold ? '' : `<span class="bd-x" data-bdx="${esc(code)}" role="button" title="목록에서 빼기">×</span>`}</td></tr>`; }).join('')}</tbody></table>`;
}
function bdBookHtml(st, q) {
  const b = st && st.book; if (!b) return '<p class="hint">호가를 받는 중이에요.</p>';
  const A = b.asks.slice(0, 10).reverse(), B = b.bids.slice(0, 10), mx = Math.max(1, ...A.map(x => x.q), ...B.map(x => x.q));
  const prev = q && q.chg != null ? q.price - q.chg : null, rp = p => prev ? bdP((p / prev - 1) * 100) : '';
  const tA = b.totA ?? A.reduce((a, x) => a + x.q, 0), tB = b.totB ?? B.reduce((a, x) => a + x.q, 0);
  const row = (x, side) => `<tr class="${side}${q && x.p === q.price ? ' now' : ''}"><td class="bd-qa">${side === 'a' ? `<i style="width:${x.q / mx * 100}%"></i><span>${fmt(x.q)}</span>` : ''}</td><td class="bd-pr ${prev ? cls(x.p - prev) : ''}"><b>${fmt(x.p)}</b><small>${rp(x.p)}</small></td><td class="bd-qb">${side === 'b' ? `<i style="width:${x.q / mx * 100}%"></i><span>${fmt(x.q)}</span>` : ''}</td></tr>`;
  return `<table class="bd-book"><thead><tr><th>매도 잔량</th><th>호가</th><th>매수 잔량</th></tr></thead><tbody>${A.map(x => row(x, 'a')).join('')}${B.map(x => row(x, 'b')).join('')}</tbody>
    <tfoot><tr><td class="mono">${fmt(tA)}</td><td class="bd-ratio">${tA + tB ? `매수 ${fmt(tB / (tA + tB) * 100, 0)}%` : ''}</td><td class="mono">${fmt(tB)}</td></tr></tfoot></table>
    ${bdBookTalkHtml(st, q)}`;
}
function bdTicksHtml(st) {
  const L = (st && st.ticks) || [], H = (st && st.hist) || [];
  const pw = st && st.buyV > 0 && st.sellV > 0 ? Math.min(999, st.buyV / st.sellV * 100) : null;
  return `<div class="bd-pw"><span>체결강도(이 화면을 연 뒤)</span><b class="${pw == null ? '' : pw >= 100 ? 'up' : 'down'}">${pw == null ? (st && st.buyV > 0 ? '매수만' : st && st.sellV > 0 ? '매도만' : '–') : fmt(pw, 0) + '%' + (pw >= 999 ? '↑' : '')}</b><small>매수 ${bdVol(st ? st.buyV : 0)} · 매도 ${bdVol(st ? st.sellV : 0)}</small></div>
    <div class="bd-ticks"><table><thead><tr><th>시각</th><th>체결가</th><th>체결량</th></tr></thead><tbody>
    ${L.slice(0, 40).map(t => `<tr class="${t.side}"><td>${esc(t.t)}</td><td class="mono">${fmt(t.p)}</td><td class="mono">${t.side === 'buy' ? '▲' : t.side === 'sell' ? '▼' : ''}${fmt(t.dv)}</td></tr>`).join('')}
    ${H.slice(0, L.length ? 15 : 40).map(t => `<tr class="h"><td>${esc(t.t)}</td><td class="mono">${t.p != null ? fmt(t.p) : '–'}</td><td class="mono">${t.dv != null ? fmt(t.dv) : '–'}</td></tr>`).join('')}
    </tbody></table>${!L.length && !H.length ? '<p class="hint">체결을 기다리는 중이에요(장중에만 쌓여요).</p>' : ''}</div>
    <p class="tk-basis">▲ 매수 체결(매도 호가에 삼) · ▼ 매도 체결(매수 호가에 팜). 3초마다 늘어난 거래량을 한 줄로 묶어 보여줘요. 흐린 줄은 네이버 시간대별 체결(분 단위)이에요.</p>`;
}
function bdChartHtml(st, q) {
  if (!st) return '';
  if (BD.tf === 'min') {
    let R = (st.min || []).slice();
    // 마지막 분봉을 실시간 현재가로 이어 붙임
    if (q && q.price && R.length && bdOpen() && st.minDay === bdToday().replace(/-/g, '')) { const t = bdNowT().slice(0, 5), L = R[R.length - 1]; if (L[0] === t) { L[4] = q.price; L[2] = Math.max(L[2], q.price); L[3] = Math.min(L[3], q.price); } else if (t > L[0]) R.push([t, q.price, q.price, q.price, q.price, 0]); }
    if (R.length < 2) return '<p class="hint">분봉을 불러오는 중이에요.</p>';
    if (R.length > 200) { const k = Math.ceil(R.length / 200), A = []; for (let i = 0; i < R.length; i += k) { const g = R.slice(i, i + k); A.push([g[0][0], g[0][1], Math.max(...g.map(x => x[2])), Math.min(...g.map(x => x[3])), g[g.length - 1][4], g.reduce((a, x) => a + (x[5] || 0), 0)]); } R = A; }
    let cv = 0, cpv = 0; const vwap = R.map(r => { cv += r[5] || 0; cpv += (r[5] || 0) * (r[2] + r[3] + r[4]) / 3; return cv ? cpv / cv : null; });
    const prev = q && q.chg != null ? q.price - q.chg : null;
    const labs = R.map((r, i) => [i, r[0]]).filter(([i, t]) => /:00$/.test(t) || i === 0).slice(0, 9);
    const day = st.minDay ? `${+st.minDay.slice(4, 6)}/${+st.minDay.slice(6, 8)}` : '';
    const split = R.findIndex(r => r[0] > '15:30');
    return bdCandles(R, { lines: [{ v: vwap, c: 'var(--warn)' }], ref: prev, labels: labs, aria: '분봉', split: split > 0 ? split : null, leg: [['VWAP(오늘 평균 체결가)', 'var(--warn)']], fmtT: t => `${day} ${t}` }) + bdChartTalkHtml(R, vwap, prev, q, st) + (day && st.minDay !== bdToday().replace(/-/g, '') ? `<p class="hint">${day} 분봉이에요(오늘 장이 열리면 오늘 분봉으로 바뀌어요).</p>` : '');
  }
  const D = (st.day || []).slice(-(BD.tf === 'day3' ? 66 : 130));
  if (D.length < 5) return '<p class="hint">일봉을 불러오는 중이에요.</p>';
  const all = st.day, cl = all.map(r => r[4]), off = all.length - D.length;
  const ma = n => bdSma(cl, n).slice(off);
  const labs = D.map((r, i) => [i, r[0]]).filter(([i, d], j, a) => j === 0 || d.slice(4, 6) !== a[j - 1][1].slice(4, 6)).map(([i, d]) => [i, `${+d.slice(4, 6)}월`]);
  return bdCandles(D, { lines: [{ v: ma(5), c: '#e67e22' }, { v: ma(20), c: '#8e44ad' }, { v: ma(60), c: 'var(--muted)', dash: '3 2' }], labels: labs, aria: '일봉', leg: [['5일선', '#e67e22'], ['20일선', '#8e44ad'], ['60일선', 'var(--muted)']], fmtT: d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` }) + bdDayTalkHtml(all, q);
}
function bdHeadHtml(c, q) {
  const s = bdStock(c), nm = (s && s.name) || (q && q.name) || c, H = bdHold(c);
  const chips = [];
  try { if (typeof tmDecide === 'function' && TM.st.get(c) && TM.st.get(c).f) { const D = tmDecide(c); if (D) chips.push(`<span class="md-tag ${/BUY|TAKE/.test(D.act) ? 'good' : /EXIT|NO|HALF/.test(D.act) ? 'bad' : ''}" data-bdgo="timing">타이밍: ${esc((TM_ACT[D.act] || [D.act])[0])}</span>`); } } catch (e) {}
  try { if (s && typeof ivVerdict === 'function' && (s._inv || s._flow)) { const V = ivVerdict(s); if (V) chips.push(`<span class="md-tag ${'AB'.includes(V.g[0]) ? 'good' : 'DE'.includes(V.g[0]) ? 'bad' : ''}" data-bdgo="inv">수급 ${V.g[0]}</span>`); } } catch (e) {}
  try { if (s && typeof SF !== 'undefined' && SF.last) { const x = SF.last.find(z => z.mem.some(m => m.code === c)); if (x) chips.push(`<span class="md-tag ${SF_ST[x.st][1] === 'up' ? 'good' : SF_ST[x.st][1] === 'down' ? 'bad' : ''}" data-bdgo="secflow">${esc(x.name)} ${SF_ST[x.st][0]} ${bdP(x.chg)}</span>`); } } catch (e) {}
  if (s && s._tvf) chips.push(`<span class="md-tag ${s._tvf.k === 'up' || s._tvf.k === 'hold' ? 'good' : s._tvf.k === 'down' || s._tvf.k === 'dump' ? 'bad' : ''}">${esc(s._tvf.name)}</span>`);
  return `<div class="bd-head"><div><h3>${esc(nm)} <small class="muted">${esc(c)}${s ? ' · ' + (s.market === 'KOSPI' ? '코스피' : '코스닥') : ''}</small></h3>
      <div class="bd-px ${q ? cls(q.pct) : ''}"><b>${q ? fmt(q.price) : '–'}</b><span>${q && q.chg != null ? `${q.chg > 0 ? '▲' : q.chg < 0 ? '▼' : ''}${fmt(Math.abs(q.chg))}` : ''} ${q ? bdP(q.pct) : ''}</span></div></div>
    <dl class="bd-ohlc"><div><dt>시가</dt><dd>${q && q.open ? fmt(q.open) : '–'}</dd></div><div><dt>고가</dt><dd class="up">${q && q.high ? fmt(q.high) : '–'}</dd></div><div><dt>저가</dt><dd class="down">${q && q.low ? fmt(q.low) : '–'}</dd></div><div><dt>거래량</dt><dd>${q ? bdVol(q.vol) : '–'}</dd></div><div><dt>거래대금</dt><dd>${q ? bdEok(q.tv) : '–'}</dd></div>
      ${H ? `<div><dt>내 평단 · ${fmt(H.qty)}주</dt><dd>${fmt(Math.round(H.avg))}</dd></div><div><dt>평가손익</dt><dd class="${q ? cls(q.price - H.avg) : ''}">${q ? `${fmt(Math.round((q.price - H.avg) * H.qty))} (${bdP((q.price / H.avg - 1) * 100)})` : '–'}</dd></div>` : ''}</dl>
    <div class="bd-btns">${chips.join('')}<button class="btn ghost small" data-bdgo="an">종목 분석</button><button class="btn ghost small" data-bdgo="timing">매매 타이밍</button></div></div>`;
}
function bdHoldHtml() {
  const L = typeof hLoad === 'function' ? hLoad().items.map(h => bdHold(h.code) && { ...bdHold(h.code), code: h.code }).filter(Boolean) : [];
  if (!L.length) return '<p class="hint">「내 보유 종목」에 기록하면 여기서 실시간 평가손익을 보여줘요.</p>';
  let inv = 0, val = 0, day = 0;
  const rows = L.map(H => {
    const q = BD.q[H.code], s = bdStock(H.code), p = q ? q.price : s ? s.close : null; if (!p) return '';
    const v = p * H.qty, pl = v - H.avg * H.qty, dp = q && q.chg != null ? q.chg * H.qty : null;
    inv += H.avg * H.qty; val += v; if (dp != null) day += dp;
    const nearStop = H.stop && p <= H.stop * 1.02, hitT = H.t1 && p >= H.t1;
    return `<tr data-bd="${esc(H.code)}"><td class="l"><b>${esc(H.name || (s && s.name) || H.code)}</b></td><td class="mono">${fmt(H.qty)}</td><td class="mono">${fmt(Math.round(H.avg))}</td><td class="mono ${q ? cls(q.pct) : ''}">${fmt(p)}</td><td class="mono ${cls(dp)}">${dp != null ? `${dp > 0 ? '+' : ''}${fmt(Math.round(dp))}` : '–'}</td><td class="mono ${cls(pl)}">${pl > 0 ? '+' : ''}${fmt(Math.round(pl))}</td><td class="mono ${cls(pl)}">${bdP((p / H.avg - 1) * 100)}</td><td class="mono">${fmt(Math.round(v))}</td><td>${bdGradeChip(s, true)}</td>
      <td class="l">${nearStop ? `<span class="tag bad">손절선 ${fmt(H.stop)} 근접</span>` : ''}${hitT ? `<span class="tag good">1차 목표 ${fmt(H.t1)} 도달</span>` : ''}${!nearStop && !hitT && H.stop ? `<small class="muted">손절 ${fmt(H.stop)} · 목표 ${fmt(H.t1)}</small>` : ''}</td></tr>`;
  }).join('');
  const pl = val - inv;
  return `<div class="bd-sum"><div><small>평가금액</small><b>${fmt(Math.round(val))}원</b></div><div><small>평가손익</small><b class="${cls(pl)}">${pl > 0 ? '+' : ''}${fmt(Math.round(pl))}원 <em>${bdP(inv ? pl / inv * 100 : null)}</em></b></div><div><small>오늘 손익</small><b class="${cls(day)}">${day > 0 ? '+' : ''}${fmt(Math.round(day))}원</b></div><div><small>매입금액</small><b>${fmt(Math.round(inv))}원</b></div></div>
    <div class="table-wrap"><table class="tbl bd-hold"><thead><tr><th class="l">종목</th><th>수량</th><th>평단</th><th>현재가</th><th>오늘 손익</th><th>평가손익</th><th>수익률</th><th>평가금액</th><th>수급</th><th class="l">손절·목표</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function bdAlertsHtml() {
  if (!BD.alerts.length) return `<p class="hint">${bdOpen() ? '장중 급등락(5분 ±2%), 큰 체결, 손절선 이탈, 목표가 도달, 오늘 최고가 경신을 여기에 알려드려요.' : '장이 열리면 급등락·큰 체결·손절선/목표가 알림이 여기에 쌓여요.'}</p>`;
  return `<ul class="bd-al">${BD.alerts.slice(0, 30).map(a => `<li class="${a.tone}" data-bd="${esc(a.code)}"><time>${esc(a.t)}</time><span>${esc(a.txt)}</span></li>`).join('')}</ul>`;
}

/* ── 그리기 ── */
function renderBoard(part) {
  const root = $('#bdRoot'); if (!root || !S.data) return;
  if (!BD.sel) { const L = bdList(); BD.sel = store.get('bdSel', null) || (L[0] && L[0].code) || null; }
  const c = BD.sel, q = c ? BD.q[c] : null, st = c ? BD.st[c] : null;
  const set = (id, h) => { const el = $('#' + id); if (el) el.innerHTML = h; };
  if (part && !$('#bdWl')) part = undefined;   // 아직 틀이 없으면 처음부터 그림
  const ae = document.activeElement; if (ae && ae.id === 'bdQ') part = part || 'data';
  if (!part) {
    root.innerHTML = `<div class="bd-grid">
      <section class="bd-p bd-wlp"><h4>관심·보유 종목 <small class="muted" id="bdWlT"></small></h4>
        <div class="row gap bd-add"><input id="bdQ" class="inp" list="stockNames" placeholder="종목 이름 또는 코드 추가" autocomplete="off" aria-label="현황판에 종목 추가"><button class="btn primary small" id="bdGo">추가</button></div>
        <div id="bdWl"></div>
        <h4 class="mt">실시간 알림</h4><div id="bdAl"></div></section>
      <section class="bd-p bd-main"><div id="bdHead"></div>
        <div class="bd-row2"><div class="bd-p2"><h5>호가</h5><div id="bdBook"></div></div><div class="bd-p2"><h5>체결</h5><div id="bdTicks"></div></div></div>
        <div class="bd-p2 mt-s"><div class="row gap wrap bd-tfs">${[['min', '분봉(오늘)'], ['day3', '일봉 3개월'], ['day6', '일봉 6개월']].map(([k, n]) => `<button class="chip ${BD.tf === k ? 'on' : ''}" data-bdtf="${k}">${n}</button>`).join('')}</div><div id="bdChart"></div></div>
        <div class="bd-p2 mt-s"><h5>투자자 흐름 <small class="muted">외국인·연기금·기관·개인 — 종목 · 시장</small></h5><div id="bdFlow"></div></div></section>
      <section class="bd-p bd-holdp"><h4>내 보유 현황 <small class="muted">「내 보유 종목」에 기록한 평단·수량 × 실시간 현재가</small></h4><div id="bdHold"></div></section>
    </div>`;
    const go = () => { const v = ($('#bdQ').value || '').trim(); if (!v) return; const h = typeof findStocks === 'function' ? findStocks(v) : []; const code = h.length ? h[0].code : (/^\d{6}$/.test(v) ? v : null); if (!code) { alert(`"${v}"과(와) 맞는 종목이 없어요`); return; } bdAdd(code); $('#bdQ').value = ''; bdSelect(code); };
    $('#bdGo').onclick = go; $('#bdQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    $$('#bdRoot [data-bdtf]').forEach(b => b.onclick = () => { BD.tf = b.dataset.bdtf; $$('#bdRoot [data-bdtf]').forEach(x => x.classList.toggle('on', x === b)); set('bdChart', bdChartHtml(BD.st[BD.sel], BD.q[BD.sel])); });
  }
  set('bdWl', bdQuoteRows());
  const wt = $('#bdWlT'); if (wt) wt.innerHTML = `${bdOpen() ? `<span class="gov-live"></span> ${typeof svOn === 'function' && svOn() ? '15초' : '5초'}마다` : typeof msState === 'function' && msState().st === 'pre' ? '장 시작 전 — 09:00부터 실시간' : '장 마감 — 마지막 값'}${Object.values(BD.q)[0] ? ` · ${esc(String(Object.values(BD.q)[0].at || '').slice(11, 19))}` : ''}`;
  set('bdHead', c ? bdHeadHtml(c, q) : '<p class="hint">왼쪽 목록에서 종목을 고르세요.</p>');
  set('bdBook', c ? bdBookHtml(st, q) : '');
  set('bdTicks', c ? bdTicksHtml(st) : '');
  if (part !== 'fast') set('bdChart', c ? bdChartHtml(st, q) : '');
  if (part !== 'fast' || !BD.flowT || Date.now() - BD.flowT > 15e3) { set('bdFlow', c ? bdFlowHtml(c, q) : ''); BD.flowT = Date.now(); }
  set('bdHold', bdHoldHtml());
  set('bdAl', bdAlertsHtml());
  $$('#bdRoot [data-bd]').forEach(el => el.onclick = e => { if (e.target.closest('[data-bdx]')) return; bdSelect(el.dataset.bd); });
  $$('#bdRoot [data-bdx]').forEach(el => el.onclick = e => { e.stopPropagation(); bdRemove(el.dataset.bdx); renderBoard('data'); });
  $$('#bdRoot [data-bdgo]').forEach(el => el.onclick = () => { const g = el.dataset.bdgo; if (g === 'an') showAnalysis(c); else if (g === 'timing' && typeof openTiming === 'function') openTiming(c); else if (g === 'inv') { switchTab('inv'); if (typeof ivSelect === 'function') ivSelect(c); } else if (g === 'secflow') { switchTab('secflow'); if (typeof renderSecFlow === 'function') renderSecFlow(); } });
}
async function bdSelect(code) {
  BD.sel = code; store.set('bdSel', code);
  renderBoard('data');
  await Promise.all([bdLoadBook(), bdLoadChart(true), bdLoadQuotes(true)]);
  if (typeof tmLoadBars === 'function') { try { await tmLoadBars(code); } catch (e) {} }
  renderBoard('data');
}

/* ── 실시간 루프 (1초마다 확인 · 화면이 열려 있을 때만 받음) ── */
async function bdLoop() {
  const on = $('#tab-board') && $('#tab-board').classList.contains('on');
  if (!on || document.hidden || BD.busy || !S.data) return;
  BD.busy = true;
  try {
    const t0 = BD.qt, b0 = BD.sel && BD.st[BD.sel] ? BD.st[BD.sel].bt : 0, c0 = BD.sel && BD.st[BD.sel] ? BD.st[BD.sel].ct : 0;
    await Promise.all([bdLoadQuotes(), bdLoadBook(), bdLoadChart(), typeof invMarketLive === 'function' ? invMarketLive() : null]);
    bdFlowAlerts();
    const st = BD.sel && BD.st[BD.sel];
    const changed = BD.qt !== t0 || (st && st.bt !== b0), chartNew = st && st.ct !== c0;
    if (changed || chartNew) renderBoard(chartNew ? 'data' : (BD.tf === 'min' ? 'data' : 'fast'));
  } catch (e) { console.error(e); }
  BD.busy = false;
}
function initBoard() {
  setInterval(bdLoop, 1000);
  const tb = $('button[data-tab="board"]'); if (tb) tb.addEventListener('click', () => { renderBoard(); if (BD.sel) bdSelect(BD.sel); else { bdLoadQuotes(true).then(() => renderBoard('data')); } });
  if ($('#tab-board') && $('#tab-board').classList.contains('on')) { renderBoard(); if (BD.sel) bdSelect(BD.sel); }
}
(function waitBootBd() {
  if (typeof S !== 'undefined' && S.data && S.data.stocks && S.data.stocks[0] && S.data.stocks[0]._sc) initBoard();
  else setTimeout(waitBootBd, 800);
})();

/* ═════════════ 쉬운 실시간 해설 ═════════════ */
const bdTk = p => typeof obTick === 'function' ? obTick(p) : p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
const bdW = v => fmt(v) + '원';
/* 호가 벽: 한쪽 평균 잔량의 3배 이상이고 그쪽 최대인 자리 */
function bdWall(L) {
  if (!L || L.length < 4) return null;
  const avg = L.reduce((a, x) => a + x.q, 0) / L.length, m = L.reduce((a, x) => x.q > a.q ? x : a, L[0]);
  return m.q >= avg * 3 && m.q > 0 ? { p: m.p, q: m.q, x: m.q / avg } : null;
}
/* 호가가 바뀔 때마다 「변화」를 한 줄씩 기록 */
function bdBookEvents(c, st, pb, b, q) {
  st.bev = st.bev || []; st.bh = st.bh || [];
  const tA = b.totA ?? b.asks.reduce((a, x) => a + x.q, 0), tB = b.totB ?? b.bids.reduce((a, x) => a + x.q, 0), r = tA + tB ? tB / (tA + tB) * 100 : 50;
  st.bh.push({ t: Date.now(), r, p: q ? q.price : null }); while (st.bh.length > 60) st.bh.shift();
  if (!pb) return;
  const T = bdNowT().slice(0, 8), push = (tone, txt) => { if (st.bev[0] && st.bev[0].txt === txt) return; st.bev.unshift({ t: T, tone, txt }); if (st.bev.length > 30) st.bev.length = 30; };
  const wa0 = bdWall(pb.asks.slice(0, 10)), wa1 = bdWall(b.asks.slice(0, 10)), wb0 = bdWall(pb.bids.slice(0, 10)), wb1 = bdWall(b.bids.slice(0, 10));
  const P = q && q.price;
  if (wa0 && P && P >= wa0.p) push('up', `매도벽 ${bdW(wa0.p)}(${fmt(wa0.q)}주)을 사들여 뚫었어요 — 위로 길이 열렸어요`);
  else if (wa0 && (!wa1 || wa1.p !== wa0.p)) { const now = b.asks.find(x => x.p === wa0.p); if (now && now.q < wa0.q * 0.4) push('up', `${bdW(wa0.p)} 매도벽이 ${fmt(wa0.q)}→${fmt(now.q)}주로 줄었어요(체결 또는 취소) — 위 부담이 가벼워짐`); }
  if (wb0 && P && P < wb0.p) push('down', `매수벽 ${bdW(wb0.p)}(${fmt(wb0.q)}주)이 무너졌어요 — 받쳐주던 가격이 깨져 하락이 빨라질 수 있어요`);
  else if (wb0 && (!wb1 || wb1.p !== wb0.p)) { const now = b.bids.find(x => x.p === wb0.p); if (now && now.q < wb0.q * 0.4) push('down', `${bdW(wb0.p)} 매수벽이 ${fmt(wb0.q)}→${fmt(now.q)}주로 줄었어요 — 받침이 약해짐`); }
  if (wa1 && (!wa0 || wa0.p !== wa1.p)) push('down', `${bdW(wa1.p)}에 매도 ${fmt(wa1.q)}주가 새로 쌓였어요(평균의 ${fmt(wa1.x, 1)}배) — 이 가격에서 막힐 수 있어요`);
  if (wb1 && (!wb0 || wb0.p !== wb1.p)) push('up', `${bdW(wb1.p)}에 매수 ${fmt(wb1.q)}주가 새로 쌓였어요(평균의 ${fmt(wb1.x, 1)}배) — 이 가격을 받쳐줄 수 있어요`);
  const old = st.bh.find(x => Date.now() - x.t <= 65e3 && Date.now() - x.t >= 25e3);
  if (old && Math.abs(r - old.r) >= 12 && !(st.lastRatioEv && Date.now() - st.lastRatioEv < 60e3)) { st.lastRatioEv = Date.now(); push(r > old.r ? 'up' : 'down', `1분 사이 매수 잔량 비율 ${fmt(old.r, 0)}% → ${fmt(r, 0)}% — ${r > old.r ? '사려는 쪽이 늘었어요' : '팔려는 쪽이 늘었어요'}`); }
  if (pb.asks[0] && b.asks[0] && P) {
    if (b.bids[0] && b.bids[0].p > pb.bids[0].p && P > (st.evP || 0)) push('up', `호가가 한 칸 위로 올라섰어요(현재 ${bdW(P)})`);
    else if (b.asks[0].p < pb.asks[0].p && P < (st.evP || Infinity)) push('down', `호가가 한 칸 아래로 밀렸어요(현재 ${bdW(P)})`);
  }
  st.evP = P;
}
/* 호가 해설 */
function bdBookTalkHtml(st, q) {
  const b = st && st.book; if (!b || !q) return '';
  const A = b.asks.slice(0, 10), B = b.bids.slice(0, 10);
  const tA = b.totA ?? A.reduce((a, x) => a + x.q, 0), tB = b.totB ?? B.reduce((a, x) => a + x.q, 0), r = tA + tB ? tB / (tA + tB) * 100 : 50;
  const L = [], P = q.price, prev = q.chg != null ? P - q.chg : null;
  const wa = bdWall(A), wb = bdWall(B);
  // 1) 전체 잔량
  L.push(r >= 60 ? `사려는 주문(매수 잔량)이 ${fmt(r, 0)}%로 많아요 — 아래에서 받쳐주는 힘이 있어요. 다만 걸어두기만 하고 취소하는 「허수」일 수 있어 체결이 따라오는지 함께 보세요.` : r <= 40 ? `팔려는 주문(매도 잔량)이 ${fmt(100 - r, 0)}%로 많아요 — 위에 쌓인 매물을 소화해야 올라갈 수 있어요.` : `사려는 주문과 팔려는 주문이 비슷해요(매수 ${fmt(r, 0)}%) — 어느 쪽도 힘이 세지 않은 균형 상태예요.`);
  // 2) 벽
  if (wa) L.push(`${bdW(wa.p)}에 매도 ${fmt(wa.q)}주가 몰려 있어요(평균의 ${fmt(wa.x, 1)}배) — 「매도벽」이에요. 이 가격을 사들여 넘으면 강한 신호, 못 넘으면 이 근처가 오늘의 천장이 될 수 있어요.`);
  if (wb) L.push(`${bdW(wb.p)}에 매수 ${fmt(wb.q)}주가 몰려 있어요(평균의 ${fmt(wb.x, 1)}배) — 「매수벽(받침)」이에요. 이 가격이 지켜지면 버팀목, 깨지면 하락이 빨라질 수 있어요.`);
  // 3) 1호가 두께
  const a1 = A[0], b1 = B[0], avgA = A.length ? tA / A.length : 0, avgB = B.length ? tB / B.length : 0;
  if (a1 && avgA && a1.q <= avgA * 0.3) L.push(`바로 위 매도 1호가(${bdW(a1.p)})에 ${fmt(a1.q)}주뿐이에요 — 조금만 사도 한 칸 올라갈 수 있는 얇은 상태예요.`);
  if (b1 && avgB && b1.q <= avgB * 0.3) L.push(`바로 아래 매수 1호가(${bdW(b1.p)})가 ${fmt(b1.q)}주로 얇아요 — 매도가 조금만 나와도 한 칸 밀릴 수 있어요.`);
  if (a1 && b1 && a1.p - b1.p > bdTk(P) * 1.5) L.push(`매도·매수 1호가 사이가 ${fmt(Math.round((a1.p - b1.p) / bdTk(P)))}칸 벌어졌어요 — 거래가 한산해 시장가 주문은 불리하게 체결될 수 있어요.`);
  // 4) 위치
  if (prev && q.open) L.push(`지금 ${bdW(P)}은 전일 종가(${bdW(prev)})보다 ${bdP((P / prev - 1) * 100)}, 오늘 시가(${bdW(q.open)})보다 ${bdP((P / q.open - 1) * 100)}예요.${P < q.open ? ' 아침에 산 사람들이 손실이라 반등 때 팔고 나오려는 물량이 있을 수 있어요.' : ' 아침에 산 사람들이 이익이라 버티는 힘이 있어요.'}`);
  // 5) 체결 흐름(최근 1분)
  const rec = (st.ticks || []).filter(t => t.live).slice(0, 20), bv = rec.filter(t => t.side === 'buy').reduce((a, t) => a + t.dv, 0), sv = rec.filter(t => t.side === 'sell').reduce((a, t) => a + t.dv, 0);
  if (bv + sv > 0) L.push(bv > sv * 1.5 ? `최근 체결은 매수가 우세해요(사는 체결 ${bdVol(bv)} vs 파는 체결 ${bdVol(sv)}) — 매도 호가를 직접 사들이는 적극적인 매수가 들어와요.` : sv > bv * 1.5 ? `최근 체결은 매도가 우세해요(파는 체결 ${bdVol(sv)} vs 사는 체결 ${bdVol(bv)}) — 매수 호가에 던지는 매도가 많아요.` : `최근 체결은 사고파는 양이 비슷해요(매수 ${bdVol(bv)} · 매도 ${bdVol(sv)}).`);
  // 결론
  let sc = (r - 50) / 2 + (bv + sv ? (bv - sv) / (bv + sv) * 25 : 0) + (wb ? 6 : 0) - (wa ? 6 : 0);
  const head = sc >= 12 ? ['up', '매수 우위 — 사려는 힘이 더 세요'] : sc <= -12 ? ['down', '매도 우위 — 팔려는 힘이 더 세요'] : ['', '균형 — 방향을 탐색하는 중이에요'];
  const tip = sc >= 12 ? (wa ? `${bdW(wa.p)} 매도벽을 넘는지가 다음 관문이에요.` : '위쪽 매물이 가벼워 오름세가 이어지기 쉬워요. 추격보다는 눌릴 때 분할로.') : sc <= -12 ? (wb ? `${bdW(wb.p)} 받침이 버티는지 지켜보세요. 깨지면 기다렸다가 사는 편이 안전해요.` : '받쳐줄 큰 매수 주문이 안 보여요. 서둘러 사지 마세요.') : '큰 체결이나 벽의 변화가 나올 때까지 기다려도 늦지 않아요.';
  const ev = (st.bev || []).slice(0, 6);
  return `<div class="bd-talk"><p class="bd-th ${head[0]}"><b>지금 호가</b> ${esc(head[1])}</p><ul>${L.slice(0, 6).map(t => `<li>${esc(t)}</li>`).join('')}</ul><p class="bd-tip"><span>지금은</span> ${esc(tip)}</p>
    ${ev.length ? `<div class="bd-ev"><b>방금 바뀐 것</b>${ev.map(e => `<p class="${e.tone}"><time>${esc(e.t)}</time>${esc(e.txt)}</p>`).join('')}</div>` : `<p class="hint">${bdOpen() ? '호가가 바뀌면 무엇이 달라졌는지 여기에 바로 적어드려요.' : '장이 열리면 호가가 바뀔 때마다 무엇이 달라졌는지 여기에 적어드려요.'}</p>`}</div>`;
}
/* 분봉 해설 */
function bdChartTalkHtml(R, vwap, prev, q, st) {
  if (!R || R.length < 10) return '';
  const reg = R.filter(r => r[0] <= '15:30'), D = reg.length >= 10 ? reg : R;
  const last = R[R.length - 1], P = q && q.price ? q.price : last[4], vw = vwap[vwap.length - 1];
  let hi = D[0], lo = D[0]; D.forEach(r => { if (r[2] > hi[2]) hi = r; if (r[3] < lo[3]) lo = r; });
  const open = D[0][1], L = [];
  // 하루 모양
  const hiFirst = hi[0] < lo[0];
  L.push(`${D[0][0]} ${bdW(open)}에 시작해 ${hiFirst ? `${hi[0]} 고가 ${bdW(hi[2])}까지 오른 뒤 밀려 ${lo[0]} 저가 ${bdW(lo[3])}` : `${lo[0]} 저가 ${bdW(lo[3])}까지 빠진 뒤 올라 ${hi[0]} 고가 ${bdW(hi[2])}`}을 찍었고, 지금은 ${bdW(P)}이에요(저가보다 ${bdP((P / lo[3] - 1) * 100)}, 고가보다 ${bdP((P / hi[2] - 1) * 100)}).`);
  // VWAP
  if (vw) L.push(P < vw ? `주황선(VWAP ${bdW(Math.round(vw))})은 오늘 거래된 평균 가격이에요. 지금 가격이 그 아래라 오늘 산 사람 대부분이 손실이에요 — 반등해도 이 가격 근처에서 「본전 매도」가 나오기 쉬워요.` : `지금 가격이 오늘 평균 가격(VWAP ${bdW(Math.round(vw))}) 위에 있어요 — 오늘 산 사람 대부분이 이익이라 눌려도 이 선 근처에서 받쳐주기 쉬워요.`);
  // 전일 종가
  if (prev) L.push(P >= prev ? `점선(전일 종가 ${bdW(prev)}) 위에서 거래 중 — 어제보다 강한 하루예요.` : `점선(전일 종가 ${bdW(prev)}) 아래에서 거래 중 — 이 선을 다시 넘으면 분위기가 바뀌는 신호예요.`);
  // 최근 30분 흐름과 거래량
  const vAvg = D.reduce((a, r) => a + (r[5] || 0), 0) / D.length, k = Math.min(30, D.length - 1), r30 = D.slice(-k), ch30 = (D[D.length - 1][4] / D[D.length - 1 - k][4] - 1) * 100;
  const v30 = r30.reduce((a, r) => a + (r[5] || 0), 0) / r30.length;
  L.push(`최근 ${k}분은 ${ch30 > 0.3 ? `${bdP(ch30)} 오르는 중` : ch30 < -0.3 ? `${bdP(ch30)} 내리는 중` : '옆으로 횡보 중'}이고, 거래량은 하루 평균의 ${fmt(vAvg ? v30 / vAvg : 0, 1)}배예요 — ${v30 > vAvg * 1.3 ? (ch30 >= 0 ? '거래가 붙은 상승이라 힘이 있어요.' : '거래가 붙은 하락이라 매도세가 강해요.') : v30 < vAvg * 0.6 ? (ch30 >= 0 ? '거래 없이 오르는 반등이라 힘은 약한 편이에요.' : '거래 없이 밀리는 중이라 투매보다는 관망세예요.') : '거래량은 보통 수준이에요.'}`);
  // 큰 거래
  const bigV = D.map((r, i) => ({ r, i })).filter(x => vAvg && x.r[5] >= vAvg * 3).sort((a, b) => b.r[5] - a.r[5])[0];
  if (bigV) { const r = bigV.r, up = r[4] >= r[1]; L.push(`${r[0]}에 평소의 ${fmt(r[5] / vAvg, 1)}배 큰 거래가 ${up ? '오르면서' : '내리면서'} 나왔어요 — ${up ? '그때 들어온 매수세가 지지선 역할을 할 수 있어요' : bigV.r === lo || Math.abs(r[3] - lo[3]) / lo[3] < 0.003 ? '던지는 물량(투매)이 쏟아진 뒤 저점이 만들어진 모습이에요' : '대량 매도가 나온 자리라 다시 그 가격에 오면 매물이 나올 수 있어요'}.`); }
  // 투자자 흐름(오늘 잠정)과 차트 방향
  const fl = bdFlowLine(BD.sel, P, prev); if (fl) L.push(fl);
  // 시간외
  const after = R.filter(r => r[0] > '15:30');
  if (after.length) L.push(`15:30 이후(점선 오른쪽)는 정규장이 끝난 뒤 대체거래소(NXT) 시간외 거래예요. 거래량이 적어 가격 움직임의 신뢰도는 낮아요.`);
  // 결론
  let sc = 0; if (vw) sc += P >= vw ? 1 : -1; if (prev) sc += P >= prev ? 1 : -1; sc += ch30 > 0.3 ? 1 : ch30 < -0.3 ? -1 : 0; if (!hiFirst) sc += 1; else sc -= 1;
  const head = sc >= 2 ? ['up', '오늘 흐름 강함 — 사는 쪽이 주도'] : sc <= -2 ? ['down', '오늘 흐름 약함 — 파는 쪽이 주도'] : ['', '오늘 흐름 엇갈림 — 방향 탐색 중'];
  const tip = sc <= -2 ? `${vw ? `VWAP(${bdW(Math.round(vw))})을 되찾기 전까지는 반등이 약해요. ` : ''}저가 ${bdW(lo[3])}이 깨지면 추가 하락을 조심하세요.` : sc >= 2 ? `${vw ? `VWAP(${bdW(Math.round(vw))}) 위를 지키는 동안은 흐름이 좋아요. ` : ''}고가 ${bdW(hi[2])}을 거래량과 함께 넘으면 한 번 더 힘을 받아요.` : `${bdW(lo[3])}(오늘 저가)~${bdW(hi[2])}(오늘 고가) 사이에서 어느 쪽으로 벗어나는지 보세요${vw ? ` — 평균 가격 ${bdW(Math.round(vw))}이 기준선이에요` : ''}.`;
  return `<div class="bd-talk"><p class="bd-th ${head[0]}"><b>차트 해설</b> ${esc(head[1])}</p><ul>${L.map(t => `<li>${esc(t)}</li>`).join('')}</ul><p class="bd-tip"><span>지금은</span> ${esc(tip)}</p></div>`;
}
/* 일봉 해설 */
function bdDayTalkHtml(all, q) {
  if (!all || all.length < 60) return '';
  const c = all.map(r => r[4]); if (q && q.price) c[c.length - 1] = q.price;
  const n = c.length, P = c[n - 1], m = k => c.slice(-k).reduce((a, x) => a + x, 0) / k;
  const m5 = m(5), m20 = m(20), m60 = m(60), hi = Math.max(...c.slice(-60)), lo = Math.min(...c.slice(-60)), r20 = (P / c[n - 21] - 1) * 100;
  const L = [];
  L.push(P > m20 && m20 > m60 ? `주가가 20일선(${bdW(Math.round(m20))}) 위, 20일선이 60일선 위 — 오르는 추세(정배열)예요.` : P < m20 && m20 < m60 ? `주가가 20일선(${bdW(Math.round(m20))}) 아래, 20일선이 60일선 아래 — 내리는 추세(역배열)예요.` : P < m20 ? `오르던 흐름 속에서 20일선(${bdW(Math.round(m20))}) 아래로 내려온 조정 구간이에요.` : `내리던 흐름에서 20일선 위로 올라선 반등 구간이에요 — 추세가 바뀌는지 확인이 필요해요.`);
  L.push(`최근 한 달 ${bdP(r20)} · 3개월 고점 ${bdW(hi)} 대비 ${bdP((P / hi - 1) * 100)} · 3개월 저점 ${bdW(lo)} 대비 ${bdP((P / lo - 1) * 100)}.`);
  L.push(P > m5 ? `5일선(${bdW(Math.round(m5))}) 위 — 단기 흐름은 살아 있어요.` : `5일선(${bdW(Math.round(m5))}) 아래 — 단기 힘이 빠졌어요. 5일선을 다시 넘는 날이 단기 반등 신호예요.`);
  return `<div class="bd-talk"><p class="bd-th ${P > m20 ? 'up' : 'down'}"><b>일봉 해설</b> ${P > m20 && m20 > m60 ? '상승 추세' : P < m20 && m20 < m60 ? '하락 추세' : '추세 전환 구간'}</p><ul>${L.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
}

/* ═════════════ 투자자 흐름 연결 ═════════════
   종목: 거래소 20일 + 오늘 장중 잠정(외국인·기관·개인, 하루 4번) · 연기금(장 마감 뒤) · 외국인 평균 매수가(지금 실시간 가격과 비교)
   시장: 코스피·코스닥 투자자별 누적 순매수(장중 1분) */
function bdIv(c) {
  const s = bdStock(c); if (!s || typeof ivAnalyze !== 'function' || !(s._inv || s._flow)) return null;
  const k = c + '|' + ((typeof INV !== 'undefined' && INV.d && INV.d.meta.time) || '') + '|' + ((typeof FLOW !== 'undefined' && FLOW.d && FLOW.d.meta && FLOW.d.meta.time) || '');
  BD.ivc = BD.ivc || {};
  if (BD.ivc[c] && BD.ivc[c].k === k) return BD.ivc[c].v;
  let v = null; try { const a = ivAnalyze(s); v = a ? { s, a, V: typeof ivVerdict === 'function' ? ivVerdict(s, a) : null } : null; } catch (e) { console.error(e); }
  BD.ivc[c] = { k, v }; return v;
}
function bdGradeChip(s, wide) {
  if (!s) return ''; const x = bdIv(s.code); if (!x || !x.V) return wide ? '<small class="muted">–</small>' : '';
  const g = x.V.g[0];
  return `<small class="bd-g g${g}" title="수급 종합평가 ${x.V.sc}점 · ${esc(x.a.rg[1])}">수급 ${g}${wide ? ' · ' + esc(x.a.rg[1]) : ''}</small>`;
}
const bdEk = v => typeof ivEok === 'function' ? ivEok(v) : v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, 0)}억`;
const bdDay8 = d => d ? `${+String(d).slice(4, 6)}/${+String(d).slice(6, 8)}` : '';
/* 차트 해설에 넣을 한 줄 */
function bdFlowLine(c, P, prev) {
  const x = bdIv(c); if (!x) return '';
  const a = x.a, f = a.today.f, i = a.today.i, live = a.Z.partial, chg = prev ? (P / prev - 1) * 100 : 0;
  if (f == null) return '';
  const who = `${live ? '오늘 장중(잠정)' : bdDay8(a.Z.d[a.Z.d.length - 1]) + ' 확정'} 외국인 ${bdEk(f)}${i != null ? ` · 기관 ${bdEk(i)}` : ''}`;
  if (f > 0 && chg < -0.5) return `${who} — 주가가 빠지는데 외국인은 사고 있어요. 하락 속 저가 매수(매집)일 수 있어요.`;
  if (f < 0 && chg > 0.5) return `${who} — 주가는 오르는데 외국인은 팔고 있어요. 개인이 끌어올린 상승이면 오래가기 어려워요.`;
  if (f > 0 && (i || 0) > 0 && chg >= 0) return `${who} — 큰손 둘이 함께 사며 주가도 올라요. 수급이 확인해 주는 상승이에요.`;
  if (f < 0 && (i || 0) < 0 && chg <= 0) return `${who} — 큰손 둘이 함께 팔며 주가도 내려요. 반등이 나와도 위에서 물량이 나오기 쉬워요.`;
  return `${who}.`;
}
/* 투자자 흐름 칸 */
function bdFlowHtml(c, q) {
  const x = bdIv(c), s = bdStock(c);
  const mk = s ? s.market : 'KOSPI', mR = typeof ivMktRows === 'function' && typeof INV !== 'undefined' ? (() => { try { return ivMktRows(mk); } catch (e) { return null; } })() : null;
  const mLast = mR && mR.rows && mR.rows.length ? (mR.krx || mR.day ? mR.rows[0] : mR.rows[mR.rows.length - 1]) : null;
  const mkt = mLast ? `<div class="bd-fm"><b>${mk === 'KOSPI' ? '코스피' : '코스닥'} 시장 전체 ${mR.live ? `<span class="gov-live"></span>${esc(mLast.t || '')} 누적` : esc(mLast.t || '') + ' 확정'}</b>${['외국인', '기관', '개인', '연기금'].filter(k => mLast[k] != null).map(k => `<span>${k} <em class="${cls(mLast[k])}">${bdEk(mLast[k])}</em></span>`).join('')}</div>` : '';
  if (!x) return `${mkt}<p class="hint">${s ? '이 종목은 투자자별 자료가 아직 없어요(분석 대상 892종목만 · 장중 4번 잠정, 장 마감 뒤 확정).' : '분석 대상 밖 종목이라 투자자별 자료가 없어요.'}</p>`;
  const a = x.a, V = x.V, P = q && q.price ? q.price : a.px, live = a.Z.partial, lastD = a.Z.d[a.Z.d.length - 1];
  const fPl = a.fAvg ? (P / a.fAvg - 1) * 100 : null;
  const K = [['f', '외국인'], ['i', '기관'], ['p', '연기금'], ['r', '개인']];
  const mx = Math.max(1, ...K.map(([k]) => Math.abs(a.sum[k + 5] || 0)));
  const bars = K.map(([k, n]) => { const v = a.sum[k + 5]; return `<div class="bd-fb"><span>${n}</span><div class="bd-fbar"><i class="${(v || 0) >= 0 ? 'p' : 'm'}" style="${(v || 0) >= 0 ? 'left:50%' : 'right:50%'};width:${Math.abs(v || 0) / mx * 50}%"></i><em></em></div><b class="${cls(v)}">${bdEk(v)}</b><small>${a.st[k] > 1 ? a.st[k] + '일 연속 매수' : a.st[k] === 1 ? '마지막 날 매수' : a.st[k] < -1 ? -a.st[k] + '일 연속 매도' : a.st[k] === -1 ? '마지막 날 매도' : ''}</small></div>`; }).join('');
  const today = K.filter(([k]) => a.today[k] != null).map(([k, n]) => `<span>${n} <em class="${cls(a.today[k])}">${bdEk(a.today[k])}</em></span>`).join('');
  // 쉬운 해설
  const T = [];
  T.push(`${esc(a.rg[1])} — ${esc(a.rg[2])}`);
  if (fPl != null) T.push(fPl < -3 ? `외국인이 그동안 산 평균 가격은 약 ${bdW(Math.round(a.fAvg))}이에요. 지금 ${bdW(P)}은 그보다 ${fmt(-fPl, 1)}% 낮아 외국인도 손실 구간이에요 — 이 근처에서 버티거나 더 사서 평단을 낮추려 할 수 있어요.` : fPl > 10 ? `외국인 평균 매수가(약 ${bdW(Math.round(a.fAvg))})보다 ${fmt(fPl, 1)}% 높아요 — 외국인이 이익을 챙기려는 매도가 나올 수 있는 자리예요.` : `외국인 평균 매수가(약 ${bdW(Math.round(a.fAvg))}) 근처(${bdP(fPl)})예요 — 이 가격이 단기 지지선 역할을 할 수 있어요.`);
  const fl = bdFlowLine(c, P, q && q.chg != null ? P - q.chg : null); if (fl) T.push(fl);
  if (a.drv && a.drv.c >= 0.5) T.push(`이 종목은 ${a.drv.n} 매매와 주가가 같이 움직여요(상관 ${fmt(a.drv.c, 2)}) — ${a.drv.n} 흐름을 가장 먼저 보세요.`);
  if (mLast && mLast['외국인'] != null && a.today.f != null) { const mf = mLast['외국인']; if (mf < 0 && a.today.f > 0) T.push(`시장 전체로는 외국인이 팔지만(${bdEk(mf)}) 이 종목은 사고 있어요 — 외국인이 골라 담는 종목이에요.`); else if (mf > 0 && a.today.f < 0) T.push(`시장 전체로는 외국인이 사는데(${bdEk(mf)}) 이 종목은 팔아요 — 외국인 관심에서 밀려난 모습이에요.`); }
  const ev = typeof ivStockEvents === 'function' ? ivStockEvents(c).slice(-5).reverse() : [];
  return `${mkt}
    <div class="bd-fl">
      <div class="bd-fv">${V ? `<b class="bd-g g${V.g[0]} big">${V.g[0]}</b><div><small>수급 종합 ${V.sc}점 · ${esc(V.g[1])}</small><p>${esc(V.head)}</p></div>` : ''}</div>
      <div class="bd-ft"><b>${live ? '<span class="gov-live"></span>오늘 장중 잠정' : bdDay8(lastD) + ' 확정'}</b>${today || '<span class="muted">–</span>'}</div>
      <div class="bd-fbs"><small class="muted">최근 5일 순매수 (막대) · 연속 매수·매도일</small>${bars}</div>
      <ul class="bd-fx">${T.map(t => `<li>${t}</li>`).join('')}</ul>
      ${ev.length ? `<div class="bd-ev"><b>오늘 수급 변화</b>${ev.map(e => `<p class="${e.tone}">${esc(e.txt)}</p>`).join('')}</div>` : ''}
      <p class="tk-basis">종목별 외국인·기관·개인은 거래소가 장중 4번(9:30·11:00·13:20·14:30 무렵) 잠정 공개하고, 연기금과 확정치는 장 마감 뒤 공개돼요. 시장 전체는 1분마다 갱신돼요. <button class="btn ghost small" data-bdgo="inv">투자자 흐름 탭에서 자세히 →</button></p>
    </div>`;
}
/* 관심·보유 종목의 수급 변화 → 실시간 알림 */
function bdFlowAlerts() {
  if (typeof ivStockEvents !== 'function') return;
  BD.fseen = BD.fseen || new Set();
  const first = !BD.fInit; BD.fInit = true;
  BD.fcodes = BD.fcodes || new Set();
  bdList().forEach(({ code }) => {
    const nm = (bdStock(code) || {}).name || code, fresh = !BD.fcodes.has(code); BD.fcodes.add(code);   // 목록에 처음 들어온 종목은 지난 기록을 알림으로 쏟지 않음
    ivStockEvents(code).forEach(e => { const k = code + e.txt; if (BD.fseen.has(k)) return; BD.fseen.add(k); if (!first && !fresh) bdPush(code, 'flow', `${nm} 수급: ${e.txt.replace(/^\d{2}:\d{2} /, '')}`, e.tone); });
  });
  // 시장 외국인 전환
  ['KOSPI', 'KOSDAQ'].forEach(m => {
    let R = null; try { R = typeof ivMktRows === 'function' ? ivMktRows(m) : null; } catch (e) {}
    if (!R || !R.live || !R.rows || R.rows.length < 2) return;
    const a = R.rows[R.rows.length - 2], b = R.rows[R.rows.length - 1], k = m + b.t;
    if (BD.fseen.has(k)) return; BD.fseen.add(k);
    if (a['외국인'] != null && b['외국인'] != null && Math.sign(a['외국인']) !== Math.sign(b['외국인']) && !first) bdPush(m, 'mflow', `${m === 'KOSPI' ? '코스피' : '코스닥'} 외국인 ${b['외국인'] > 0 ? '순매수로 전환' : '순매도로 전환'} (${bdEk(a['외국인'])} → ${bdEk(b['외국인'])})`, b['외국인'] > 0 ? 'up' : 'down');
  });
}
