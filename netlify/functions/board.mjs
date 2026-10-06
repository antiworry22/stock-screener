// 실시간 현황판 중계
//  · /api/board?q=005930,000660,...   여러 종목 현재가 한꺼번에(최대 30) — 현재가·등락·시가/고가/저가·거래량·거래대금
//  · /api/board?c=005930              한 종목 차트·체결 — 오늘 분봉, 일봉(약 1년), 시간대별 체결(최근)
//  진단: &diag=1
const UA_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://m.stock.naver.com/' };
const UA_PC = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://finance.naver.com/' };

async function get(url, headers, ms = 5000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    const b = new Uint8Array(await r.arrayBuffer());
    let txt; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { txt = new TextDecoder('euc-kr').decode(b); }
    return { status: r.status, txt };
  } finally { clearTimeout(t); }
}
const num = x => { if (x == null) return null; const v = parseFloat(String(x).replace(/[,+%\s원주]/g, '')); return Number.isFinite(v) ? v : null; };
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
// '3조 1,401억' 같은 금액 → 억원
function eok(s) {
  if (s == null) return null; const t = String(s).replace(/[,\s원]/g, '');
  if (/[조억만]/.test(t)) { const m = t.match(/(?:([\d.]+)조)?(?:([\d.]+)억)?(?:([\d.]+)만)?/); return m ? (+m[1] || 0) * 1e4 + (+m[2] || 0) + (+m[3] || 0) / 1e4 : null; }
  const v = parseFloat(t); return Number.isFinite(v) ? v : null;
}
function quote(o) {
  if (!o || typeof o !== 'object') return null;
  const price = num(o.closePrice ?? o.nv); if (!price) return null;
  const dir = o.compareToPreviousPrice ? String(o.compareToPreviousPrice.name || o.compareToPreviousPrice.code || '') : String(o.rf || '');
  const neg = /FALL|LOWER|^5$|^4$/i.test(dir);
  let pct = num(o.fluctuationsRatio ?? o.cr), chg = num(o.compareToPreviousClosePrice ?? o.cv);
  if (neg) { if (pct > 0) pct = -pct; if (chg > 0) chg = -chg; }
  // 거래대금: 한글 표기(예 '1조 2,345억')가 있으면 그것, 없으면 백만원 단위 숫자로 보고 억원으로
  let tv = o.accumulatedTradingValueKrwHangeul ? eok(o.accumulatedTradingValueKrwHangeul) : null;
  if (tv == null && o.accumulatedTradingValue != null) { const v = num(o.accumulatedTradingValue); tv = v == null ? null : /[조억]/.test(String(o.accumulatedTradingValue)) ? eok(o.accumulatedTradingValue) : Math.round(v / 100 * 10) / 10; }
  return { code: o.itemCode || o.cd || null, name: o.stockName || o.nm || null, price, chg, pct, open: num(o.openPrice ?? o.ov), high: num(o.highPrice ?? o.hv), low: num(o.lowPrice ?? o.lv),
    vol: num(o.accumulatedTradingVolume ?? o.aq), tv, st: o.marketStatus || o.ms || null, t: o.localTradedAt || null };
}
// fchart XML  <item data="yyyyMMdd(HHmm)|o|h|l|c|v" />
function fchart(txt) {
  const out = [];
  for (const m of txt.matchAll(/data="(\d{8,12})\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^"]*)"/g)) {
    const c = num(m[5]); if (!c) continue;
    const o = num(m[2]) || c, h = num(m[3]) || c, l = num(m[4]) || c;
    out.push([m[1], o, h, l, c, num(m[6]) || 0]);
  }
  return out;
}
// 시간대별 체결: 체결시각 · 체결가 · 전일비 · 매도 · 매수 · 거래량(누적) · 변동량
function ticks(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => strip(x[1]));
    if (tds.length < 6 || !/^\d{1,2}:\d{2}$/.test(tds[0])) continue;
    const n = tds.slice(1).map(num);
    out.push({ t: tds[0], p: n[0], ask: n[2], bid: n[3], cum: n[4], dv: n[5] });
  }
  return out;
}

export default async (req) => {
  const u = new URL(req.url), diag = u.searchParams.get('diag') === '1', D = {};
  const k = new Date(Date.now() + 9 * 3600e3), day = k.toISOString().slice(0, 10).replace(/-/g, '');
  const at = k.toISOString().slice(0, 19).replace('T', ' ');
  const hdr = s => ({ headers: { 'cache-control': diag ? 'no-store' : `public, max-age=${s}`, 'netlify-cdn-cache-control': diag ? 'no-store' : `public, s-maxage=${s}`, 'access-control-allow-origin': '*' } });
  const qs = (u.searchParams.get('q') || '').split(',').map(x => x.replace(/\W/g, '').slice(0, 6)).filter(x => x.length === 6).slice(0, 30);
  if (qs.length) {
    const Q = {};
    try {
      const r = await get(`https://polling.finance.naver.com/api/realtime/domestic/stock/${qs.join(',')}`, UA_M);
      if (r.status === 200) { const j = JSON.parse(r.txt); (j.datas || []).forEach(o => { const q = quote(o); if (q && q.code) Q[q.code] = q; }); D.multi = `ok ${Object.keys(Q).length}/${qs.length}`; if (diag) D.multi_head = r.txt.slice(0, 900); }
      else D.multi = `HTTP ${r.status}`;
    } catch (e) { D.multi = '실패 ' + String(e).slice(0, 80); }
    const miss = qs.filter(c => !Q[c]);
    if (miss.length) {   // 한꺼번에 안 되면 하나씩
      await Promise.all(miss.map(async c => { try { const r = await get(`https://polling.finance.naver.com/api/realtime/domestic/stock/${c}`, UA_M, 4000); if (r.status === 200) { const j = JSON.parse(r.txt); const q = quote((j.datas || [])[0]); if (q) Q[c] = { ...q, code: c }; } } catch (e) {} }));
      D.single = `${miss.filter(c => Q[c]).length}/${miss.length}`;
    }
    return Response.json({ ok: Object.keys(Q).length > 0, at, q: Q, ...(diag ? { diag: D } : {}) }, hdr(2));
  }
  const c = (u.searchParams.get('c') || '').replace(/\W/g, '').slice(0, 6);
  if (c.length !== 6) return Response.json({ ok: false, err: 'q=코드,코드 또는 c=코드가 필요해요' }, { status: 400 });
  const out = { ok: false, at, code: c };
  await Promise.all([
    (async () => { try { const r = await get(`https://fchart.stock.naver.com/sise.nhn?symbol=${c}&timeframe=minute&count=420&requestType=0`, UA_PC); if (r.status === 200) { const a = fchart(r.txt).filter(x => x[0].slice(0, 8) === day || true); const last = a.length ? a[a.length - 1][0].slice(0, 8) : null; out.min = a.filter(x => x[0].slice(0, 8) === last).map(x => [x[0].slice(8, 10) + ':' + x[0].slice(10, 12), ...x.slice(1)]); out.minDay = last; D.min = `ok ${out.min.length}개(${last})`; if (diag && !a.length) D.min_head = r.txt.slice(0, 300); } else D.min = `HTTP ${r.status}`; } catch (e) { D.min = '실패 ' + String(e).slice(0, 80); } })(),
    (async () => { try { const r = await get(`https://fchart.stock.naver.com/sise.nhn?symbol=${c}&timeframe=day&count=250&requestType=0`, UA_PC); if (r.status === 200) { out.day = fchart(r.txt); D.day = `ok ${out.day.length}개`; } else D.day = `HTTP ${r.status}`; } catch (e) { D.day = '실패 ' + String(e).slice(0, 80); } })(),
    (async () => {
      const all = [];
      for (const pg of []) {   // 네이버 PC 「시간대별 체결」 화면이 없어짐(HTTP 410) — 체결은 화면이 호가를 받을 때마다 직접 기록
        try { const r = await get(`https://finance.naver.com/item/sise_time.naver?code=${c}&thistime=${day}235959&page=${pg}`, { ...UA_PC, Referer: `https://finance.naver.com/item/sise.naver?code=${c}` }); if (r.status === 200) all.push(...ticks(r.txt)); else D['tick' + pg] = `HTTP ${r.status}`; } catch (e) { D['tick' + pg] = '실패'; }
      }
      out.ticks = all; D.ticks = `${all.length}행`;
    })(),
  ]);
  if (out.min && !out.min.length) {   // 예비: 신규 차트 API
    try { const r = await get(`https://api.stock.naver.com/chart/domestic/item/${c}/minute?startDateTime=${day}0900&endDateTime=${day}1600`, UA_M); if (r.status === 200) { const j = JSON.parse(r.txt); const rows = Array.isArray(j) ? j : (j.priceInfos || []); out.min = rows.map(x => { const t = String(x.localDateTime || '').replace(/\D/g, ''); const cp = num(x.currentPrice ?? x.closePrice); return t && cp ? [t.slice(8, 10) + ':' + t.slice(10, 12), num(x.openPrice) || cp, num(x.highPrice) || cp, num(x.lowPrice) || cp, cp, num(x.accumulatedTradingVolume) || 0] : null; }).filter(Boolean); D.napi = `ok ${out.min.length}`; } } catch (e) { D.napi = '실패'; }
  }
  out.ok = !!((out.min && out.min.length) || (out.day && out.day.length) || (out.ticks && out.ticks.length));
  if (diag) out.diag = D;
  return Response.json(out, hdr(10));
};
export const config = { path: '/api/board' };
