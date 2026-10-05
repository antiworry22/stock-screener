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
  const gap = bdOpen() ? 4500 : 60e3;
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
  if (st.bt && Date.now() - st.bt < (bdOpen() ? 2800 : 60e3)) return;
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
      if (b && (b.asks || []).length) st.book = b;
    }
  } catch (e) {}
  BD.hbusy = false;
}
async function bdLoadChart(force) {
  const c = BD.sel; if (!c || BD.cbusy) return;
  const st = BD.st[c] = BD.st[c] || { ticks: [], buyV: 0, sellV: 0, book: null };
  if (!force && st.ct && Date.now() - st.ct < (bdOpen() ? 30e3 : 300e3)) return;
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
  if (v.length > 10 && inc / (v.length - 1) > 0.97) return rows.map((r, i) => [r[0], r[1], r[2], r[3], r[4], i ? Math.max(0, v[i] - v[i - 1]) : v[0]]);
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
  if (o.ref != null) g += `<line x1="0" x2="${W - 46}" y1="${Y(o.ref)}" y2="${Y(o.ref)}" stroke="var(--muted)" stroke-dasharray="3 3"/><text x="${W - 44}" y="${Y(o.ref) + 3}" font-size="10" fill="var(--muted)">전일</text>`;
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
    return `<tr data-bd="${esc(code)}" class="${BD.sel === code ? 'on' : ''}"><td class="l"><b>${esc(nm)}</b>${hold ? ' <small class="bd-own">보유</small>' : ''}${pl != null ? `<small class="bd-pl ${cls(pl)}">${pl > 0 ? '+' : ''}${fmt(Math.round(pl))}원 ${bdP(plp)}</small>` : ''}</td>
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
    <p class="tk-basis">${tB > tA * 1.5 ? '매수 잔량이 매도의 1.5배↑ — 아래 받쳐주는 힘이 커요(다만 허수 주문일 수 있어요).' : tA > tB * 1.5 ? '매도 잔량이 매수의 1.5배↑ — 위에 쌓인 매물을 소화해야 올라요.' : '매도·매수 잔량이 비슷해요.'}</p>`;
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
    return bdCandles(R, { lines: [{ v: vwap, c: 'var(--warn)' }], ref: prev, labels: labs, aria: '분봉', leg: [['VWAP(평균 체결가)', 'var(--warn)']], fmtT: t => `${day} ${t}` }) + (day && st.minDay !== bdToday().replace(/-/g, '') ? `<p class="hint">${day} 분봉이에요(오늘 장이 열리면 오늘 분봉으로 바뀌어요).</p>` : '');
  }
  const D = (st.day || []).slice(-(BD.tf === 'day3' ? 66 : 130));
  if (D.length < 5) return '<p class="hint">일봉을 불러오는 중이에요.</p>';
  const all = st.day, cl = all.map(r => r[4]), off = all.length - D.length;
  const ma = n => bdSma(cl, n).slice(off);
  const labs = D.map((r, i) => [i, r[0]]).filter(([i, d], j, a) => j === 0 || d.slice(4, 6) !== a[j - 1][1].slice(4, 6)).map(([i, d]) => [i, `${+d.slice(4, 6)}월`]);
  return bdCandles(D, { lines: [{ v: ma(5), c: '#e67e22' }, { v: ma(20), c: '#8e44ad' }, { v: ma(60), c: 'var(--muted)', dash: '3 2' }], labels: labs, aria: '일봉', leg: [['5일선', '#e67e22'], ['20일선', '#8e44ad'], ['60일선', 'var(--muted)']], fmtT: d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
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
    return `<tr data-bd="${esc(H.code)}"><td class="l"><b>${esc(H.name || (s && s.name) || H.code)}</b></td><td class="mono">${fmt(H.qty)}</td><td class="mono">${fmt(Math.round(H.avg))}</td><td class="mono ${q ? cls(q.pct) : ''}">${fmt(p)}</td><td class="mono ${cls(dp)}">${dp != null ? `${dp > 0 ? '+' : ''}${fmt(Math.round(dp))}` : '–'}</td><td class="mono ${cls(pl)}">${pl > 0 ? '+' : ''}${fmt(Math.round(pl))}</td><td class="mono ${cls(pl)}">${bdP((p / H.avg - 1) * 100)}</td><td class="mono">${fmt(Math.round(v))}</td>
      <td class="l">${nearStop ? `<span class="tag bad">손절선 ${fmt(H.stop)} 근접</span>` : ''}${hitT ? `<span class="tag good">1차 목표 ${fmt(H.t1)} 도달</span>` : ''}${!nearStop && !hitT && H.stop ? `<small class="muted">손절 ${fmt(H.stop)} · 목표 ${fmt(H.t1)}</small>` : ''}</td></tr>`;
  }).join('');
  const pl = val - inv;
  return `<div class="bd-sum"><div><small>평가금액</small><b>${fmt(Math.round(val))}원</b></div><div><small>평가손익</small><b class="${cls(pl)}">${pl > 0 ? '+' : ''}${fmt(Math.round(pl))}원 <em>${bdP(inv ? pl / inv * 100 : null)}</em></b></div><div><small>오늘 손익</small><b class="${cls(day)}">${day > 0 ? '+' : ''}${fmt(Math.round(day))}원</b></div><div><small>매입금액</small><b>${fmt(Math.round(inv))}원</b></div></div>
    <div class="table-wrap"><table class="tbl bd-hold"><thead><tr><th class="l">종목</th><th>수량</th><th>평단</th><th>현재가</th><th>오늘 손익</th><th>평가손익</th><th>수익률</th><th>평가금액</th><th class="l">손절·목표</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
        <div class="bd-p2 mt-s"><div class="row gap wrap bd-tfs">${[['min', '분봉(오늘)'], ['day3', '일봉 3개월'], ['day6', '일봉 6개월']].map(([k, n]) => `<button class="chip ${BD.tf === k ? 'on' : ''}" data-bdtf="${k}">${n}</button>`).join('')}</div><div id="bdChart"></div></div></section>
      <section class="bd-p bd-holdp"><h4>내 보유 현황 <small class="muted">「내 보유 종목」에 기록한 평단·수량 × 실시간 현재가</small></h4><div id="bdHold"></div></section>
    </div>`;
    const go = () => { const v = ($('#bdQ').value || '').trim(); if (!v) return; const h = typeof findStocks === 'function' ? findStocks(v) : []; const code = h.length ? h[0].code : (/^\d{6}$/.test(v) ? v : null); if (!code) { alert(`"${v}"과(와) 맞는 종목이 없어요`); return; } bdAdd(code); $('#bdQ').value = ''; bdSelect(code); };
    $('#bdGo').onclick = go; $('#bdQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    $$('#bdRoot [data-bdtf]').forEach(b => b.onclick = () => { BD.tf = b.dataset.bdtf; $$('#bdRoot [data-bdtf]').forEach(x => x.classList.toggle('on', x === b)); set('bdChart', bdChartHtml(BD.st[BD.sel], BD.q[BD.sel])); });
  }
  set('bdWl', bdQuoteRows());
  const wt = $('#bdWlT'); if (wt) wt.innerHTML = `${bdOpen() ? '<span class="gov-live"></span> 5초마다' : '장 마감 — 마지막 값'}${Object.values(BD.q)[0] ? ` · ${esc(String(Object.values(BD.q)[0].at || '').slice(11, 19))}` : ''}`;
  set('bdHead', c ? bdHeadHtml(c, q) : '<p class="hint">왼쪽 목록에서 종목을 고르세요.</p>');
  set('bdBook', c ? bdBookHtml(st, q) : '');
  set('bdTicks', c ? bdTicksHtml(st) : '');
  if (part !== 'fast') set('bdChart', c ? bdChartHtml(st, q) : '');
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
    await Promise.all([bdLoadQuotes(), bdLoadBook(), bdLoadChart()]);
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
