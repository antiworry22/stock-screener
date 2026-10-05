// 코스피·코스닥 지수 실시간 — 현재가·등락·시가/고가/저가 + 오늘 분봉(가능하면) + 오른/내린 종목 수(가능하면)
// 주소: /api/idx   (진단: ?diag=1)   — 20초 동안 서버에 저장된 답을 다시 씀
const UA_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://m.stock.naver.com/' };
const UA_PC = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://finance.naver.com/' };

async function get(url, headers, ms = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    const b = new Uint8Array(await r.arrayBuffer());
    let txt; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { txt = new TextDecoder('euc-kr').decode(b); }
    return { status: r.status, txt };
  } finally { clearTimeout(t); }
}
const num = v => { if (v == null) return null; const x = parseFloat(String(v).replace(/[,+\s%]/g, '')); return Number.isFinite(x) ? x : null; };
const strip = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

// 실시간 시세 JSON → 현재가 등
function quote(j) {
  const o = (j && j.datas && j.datas[0]) || j || {};
  const price = num(o.closePrice ?? o.nv ?? o.now);
  if (!price) return null;
  let chg = num(o.compareToPreviousClosePrice ?? o.cv), pct = num(o.fluctuationsRatio ?? o.cr);
  const sgn = String((o.compareToPreviousPrice && (o.compareToPreviousPrice.name || o.compareToPreviousPrice.code)) || o.rf || '');
  if (/FALLING|LOWER_LIMIT|^5$|^4$/.test(sgn)) { if (chg > 0) chg = -chg; if (pct > 0) pct = -pct; }
  if (pct == null && chg != null) pct = Math.round(chg / (price - chg) * 10000) / 100;
  return { price, chg, pct, open: num(o.openPrice ?? o.ov), high: num(o.highPrice ?? o.hv), low: num(o.lowPrice ?? o.lv),
    value: num(o.accumulatedTradingValue ?? o.aa), vol: num(o.accumulatedTradingVolume ?? o.aq), status: o.marketStatus || o.ms || null, t: o.localTradedAt || null };
}
// 분봉: fchart XML  <item data="202610061001|o|h|l|c|v" />
function minFchart(txt, day) {
  const out = [];
  for (const m of txt.matchAll(/data="(\d{12})\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^"]*)"/g)) {
    if (m[1].slice(0, 8) !== day) continue;
    const c = num(m[5]); if (!c) continue;
    out.push([m[1].slice(8, 10) + ':' + m[1].slice(10, 12), c]);
  }
  return out;
}
function minApi(txt, day) {
  let j; try { j = JSON.parse(txt); } catch (e) { return []; }
  const rows = Array.isArray(j) ? j : (j.priceInfos || j.result || []);
  const out = [];
  rows.forEach(x => { const t = String(x.localDateTime || x.localDate || '').replace(/\D/g, ''); const c = num(x.currentPrice ?? x.closePrice); if (t.slice(0, 8) === day && c) out.push([t.slice(8, 10) + ':' + t.slice(10, 12), c]); });
  return out;
}
// 오른/내린 종목 수 (PC 지수 화면 글자에서)
function breadth(txt) {
  const s = strip(txt), g = re => { const m = s.match(re); return m ? num(m[1] || m[2]) : null; };
  const o = { up: g(/상승\s*종목수?\s*([\d,]+)|상승\s*([\d,]+)\s*종목/), down: g(/하락\s*종목수?\s*([\d,]+)|하락\s*([\d,]+)\s*종목/), flat: g(/보합\s*종목수?\s*([\d,]+)|보합\s*([\d,]+)\s*종목/), upl: g(/상한\s*종목수?\s*([\d,]+)|상한가\s*([\d,]+)/), dnl: g(/하한\s*종목수?\s*([\d,]+)|하한가\s*([\d,]+)/) };
  return o.up != null && o.down != null && o.up + o.down >= 200 ? o : null;
}

function upDown(x) {
  if (!x) return null; const o = {};
  const put = (k, v) => { const n = num(v); if (n == null) return; if (/upper|상한/i.test(k)) o.upl = n; else if (/lower|하한/i.test(k)) o.dnl = n; else if (/rise|up|상승/i.test(k)) o.up = n; else if (/fall|down|하락/i.test(k)) o.down = n; else if (/steady|flat|unchanged|보합/i.test(k)) o.flat = n; };
  const walk = y => { if (!y || typeof y !== 'object') return; if (Array.isArray(y)) { y.forEach(z => { if (z && typeof z === 'object' && (z.key || z.code) && z.value != null) put(String(z.code || '') + String(z.key || ''), z.value); else walk(z); }); return; } Object.entries(y).forEach(([k, v]) => { if (v != null && typeof v !== 'object') put(k, v); else walk(v); }); };
  walk(x);
  return o.up != null && o.down != null ? o : null;
}

export default async (req) => {
  const u = new URL(req.url), diag = u.searchParams.get('diag') === '1';
  const k = new Date(Date.now() + 9 * 3600e3), day = k.toISOString().slice(0, 10).replace(/-/g, '');
  const D = {}, out = { ok: false, at: k.toISOString().slice(0, 19).replace('T', ' '), day, mkt: {} };
  await Promise.all(['KOSPI', 'KOSDAQ'].map(async m => {
    const o = {};
    const J = {
      poll: get(`https://polling.finance.naver.com/api/realtime/domestic/index/${m}`, UA_M),
      basic: get(`https://m.stock.naver.com/api/index/${m}/basic`, UA_M),
      fch: get(`https://fchart.stock.naver.com/sise.nhn?symbol=${m}&timeframe=minute&count=420&requestType=0`, UA_PC),
      int: get(`https://m.stock.naver.com/api/index/${m}/integration`, UA_M),
    };
    const R = {};
    await Promise.all(Object.entries(J).map(async ([key, p]) => { try { R[key] = await p; } catch (e) { R[key] = { err: String(e).slice(0, 100) }; } }));
    for (const key of ['poll', 'basic']) {
      const r = R[key];
      if (r && r.status === 200) { try { const q = quote(JSON.parse(r.txt)); D[m + '_' + key] = q ? `ok ${q.price} ${q.pct}%` : 'ok 값 없음 ' + r.txt.slice(0, 200); if (q && !o.q) o.q = q; } catch (e) { D[m + '_' + key] = '해석 실패 ' + r.txt.slice(0, 150); } }
      else D[m + '_' + key] = r ? (r.err || `HTTP ${r.status}`) : '없음';
    }
    if (R.fch && R.fch.status === 200) { const a = minFchart(R.fch.txt, day); D[m + '_fchart'] = `ok ${a.length}개`; if (a.length) o.min = a; if (diag && !a.length) D[m + '_fchart_head'] = R.fch.txt.slice(0, 400); }
    else D[m + '_fchart'] = R.fch ? (R.fch.err || `HTTP ${R.fch.status}`) : '없음';
    if (!o.min) {  // 예비: 신규 차트 API
      try {
        const r = await get(`https://api.stock.naver.com/chart/domestic/index/${m}/minute?startDateTime=${day}0900&endDateTime=${day}1600`, UA_M);
        if (r.status === 200) { const a = minApi(r.txt, day); D[m + '_napi'] = `ok ${a.length}개`; if (a.length) o.min = a; if (diag && !a.length) D[m + '_napi_head'] = r.txt.slice(0, 400); }
        else D[m + '_napi'] = `HTTP ${r.status}`;
      } catch (e) { D[m + '_napi'] = '실패 ' + String(e).slice(0, 80); }
    }
    if (R.int && R.int.status === 200) {   // 오른/내린 종목 수: 모바일 지수 종합의 upDownStockInfo
      try { const j = JSON.parse(R.int.txt), b = upDown(j.upDownStockInfo); D[m + '_updown'] = b ? `ok 상승 ${b.up} 하락 ${b.down}` : '못 찾음 ' + JSON.stringify(j.upDownStockInfo).slice(0, 300); if (b) o.br = b; } catch (e) { D[m + '_updown'] = '해석 실패'; }
    } else D[m + '_updown'] = R.int ? (R.int.err || `HTTP ${R.int.status}`) : '없음';
    if (false) { const b = breadth(R.pc.txt); D[m + '_pc'] = b ? `ok 상승 ${b.up} 하락 ${b.down}` : 'ok 종목수 못 찾음'; if (b) o.br = b; if (diag && !b) { const s = strip(R.pc.txt), i = s.indexOf('상승'); D[m + '_pc_head'] = s.slice(Math.max(0, i - 150), i + 350); } }
    else D[m + '_pc'] = R.pc ? (R.pc.err || `HTTP ${R.pc.status}`) : '없음';
    if (o.min && o.min.length > 400) o.min = o.min.filter((x, i) => i % 2 === 0 || i === o.min.length - 1);
    out.mkt[m] = o;
  }));
  out.ok = Object.values(out.mkt).some(o => o.q);
  if (diag) out.diag = D;
  return Response.json(out, { headers: { 'cache-control': diag ? 'no-store' : 'public, max-age=15', 'netlify-cdn-cache-control': diag ? 'no-store' : 'public, s-maxage=20', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/idx' };
