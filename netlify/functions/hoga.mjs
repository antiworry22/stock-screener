// 실시간 호가 중계 — 브라우저가 네이버에 직접 물을 수 없어(보안 정책) 사이트 서버가 대신 받아 정리해 줍니다.
// 주소: /api/hoga?code=005930   (진단: &diag=1 → 각 경로의 원본 앞부분까지 보여 줌)
const UA_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://m.stock.naver.com/' };
const UA_PC = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://finance.naver.com/' };
const num = x => { if (x == null) return null; const v = parseFloat(String(x).replace(/[,+%\s원주]/g, '')); return Number.isFinite(v) ? v : null; };
const keyOf = (o, re) => Object.keys(o || {}).find(k => re.test(k));

async function get(url, headers, ms = 4500) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers, signal: ac.signal }); const buf = new Uint8Array(await r.arrayBuffer()); return { status: r.status, ct: r.headers.get('content-type') || '', buf }; }
  finally { clearTimeout(t); }
}
const text = (b, enc) => { try { return new TextDecoder(enc || 'utf-8', { fatal: !enc }).decode(b); } catch (e) { return new TextDecoder('euc-kr').decode(b); } };

// JSON 어디에 있든 '매도/매수 호가 목록'을 찾아냄
function levelsFromJson(j) {
  const asks = [], bids = []; let totA = null, totB = null;
  const walk = (o, path) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      const side = /sell|ask|offer|매도/i.test(path) ? asks : /buy|bid|매수/i.test(path) ? bids : null;
      if (side && o.length && typeof o[0] === 'object') {
        o.forEach(it => {
          const pk = keyOf(it, /price/i), qk = keyOf(it, /count|quant|volume|remain|qty|amount|잔량/i);
          const p = num(it[pk]), q = num(it[qk]);
          if (p) side.push({ p, q: q || 0 });
        });
        return;
      }
      o.forEach((x, i) => walk(x, path + '.' + i));
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== 'object' && /total/i.test(k)) {
        if (/sell|ask|offer/i.test(k)) totA = num(v); else if (/buy|bid/i.test(k)) totB = num(v);
      }
      walk(v, path + '.' + k);
    }
  };
  walk(j, '');
  return { asks, bids, totA, totB };
}

// PC 시세 페이지의 호가표(매도잔량 | 호가 | 매수잔량)
function levelsFromPc(html) {
  const i = html.indexOf('매도잔량'); if (i < 0) return null;
  const tb = html.slice(i, html.indexOf('</table>', i));
  const asks = [], bids = [];
  for (const tr of tb.split(/<tr[\s>]/i).slice(1)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (tds.length < 3) continue;
    const [a, p, b] = [num(tds[0]), num(tds[1]), num(tds[2])];
    if (!p) continue;
    if (a && !b) asks.push({ p, q: a }); else if (b && !a) bids.push({ p, q: b });
  }
  return asks.length || bids.length ? { asks, bids, totA: null, totB: null } : null;
}

function quoteFromJson(j) {
  const d = (j && (j.datas || j.result || j.data)) ? (j.datas || j.result || j.data) : j;
  const o = Array.isArray(d) ? d[0] : d; if (!o || typeof o !== 'object') return null;
  const g = re => { const k = keyOf(o, re); return k ? o[k] : null; };
  const price = num(g(/^closePrice$|^nowVal$|^now$|currentPrice|tradePrice/i));
  if (!price) return null;
  return { price, chgPct: num(g(/fluctuationsRatio|ratio|rate/i)), chg: num(g(/compareToPreviousClosePrice|change$/i)), vol: num(g(/accumulatedTradingVolume|^aq$|volume/i)),
    value: num(g(/accumulatedTradingValue|^aa$/i)), status: g(/marketStatus|status/i), t: g(/localTradedAt|tradedAt|time/i), name: g(/stockName|^nm$|name/i),
    high: num(g(/highPrice|^hv$/i)), low: num(g(/lowPrice|^lv$/i)), open: num(g(/openPrice|^ov$/i)) };
}

export default async (req) => {
  const u = new URL(req.url);
  const code = (u.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
  const diag = u.searchParams.get('diag') === '1';
  if (code.length !== 6) return Response.json({ ok: false, err: '6자리 종목코드가 필요해요' }, { status: 400 });
  const D = {};
  const jobs = {
    ask: get(`https://m.stock.naver.com/api/stock/${code}/askingPrice`, UA_M),
    poll: get(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, UA_M),
    pc: get(`https://finance.naver.com/item/sise.naver?code=${code}`, { ...UA_PC, Referer: `https://finance.naver.com/item/main.naver?code=${code}` }),
  };
  const R = {};
  await Promise.all(Object.entries(jobs).map(async ([k, p]) => { try { R[k] = await p; } catch (e) { R[k] = { err: String(e).slice(0, 120) }; } }));
  let book = null, quote = null, src = [];
  // ① 모바일 호가 API
  try {
    if (R.ask && R.ask.status === 200) { const j = JSON.parse(text(R.ask.buf)); D.ask = diag ? JSON.stringify(j).slice(0, 1500) : 'ok'; const b = levelsFromJson(j); if (b.asks.length || b.bids.length) { book = b; src.push('모바일 호가'); } if (!quote) quote = quoteFromJson(j); }
    else D.ask = R.ask && (R.ask.err || `HTTP ${R.ask.status} ${text(R.ask.buf || new Uint8Array()).slice(0, 200)}`);
  } catch (e) { D.ask = '해석 실패 ' + String(e).slice(0, 100) + (diag && R.ask && R.ask.buf ? ' ' + text(R.ask.buf).slice(0, 300) : ''); }
  // ② 실시간 시세(현재가·거래량)
  try {
    if (R.poll && R.poll.status === 200) { const j = JSON.parse(text(R.poll.buf)); D.poll = diag ? JSON.stringify(j).slice(0, 1200) : 'ok'; const q = quoteFromJson(j); if (q) { quote = q; src.push('실시간 시세'); } }
    else D.poll = R.poll && (R.poll.err || `HTTP ${R.poll.status}`);
  } catch (e) { D.poll = '해석 실패 ' + String(e).slice(0, 100); }
  // ③ PC 시세 페이지(호가표) — ①이 안 될 때
  try {
    if (R.pc && R.pc.status === 200) { const h = text(R.pc.buf, 'euc-kr'); if (!book) { const b = levelsFromPc(h); if (b) { book = b; src.push('PC 호가표'); } } D.pc = diag ? h.slice(Math.max(0, h.indexOf('매도잔량') - 200), h.indexOf('매도잔량') + 1500) : 'ok'; }
    else D.pc = R.pc && (R.pc.err || `HTTP ${R.pc.status}`);
  } catch (e) { D.pc = '해석 실패 ' + String(e).slice(0, 100); }
  if (book) {
    book.asks = book.asks.filter(x => x.p > 0).sort((a, b) => a.p - b.p);   // 낮은 매도호가(1호가)부터
    book.bids = book.bids.filter(x => x.p > 0).sort((a, b) => b.p - a.p);   // 높은 매수호가(1호가)부터
    if (book.totA == null) book.totA = book.asks.reduce((s, x) => s + x.q, 0);
    if (book.totB == null) book.totB = book.bids.reduce((s, x) => s + x.q, 0);
  }
  const body = { ok: !!(book || quote), code, at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' '), src, quote, book, ...(diag ? { diag: D } : {}) };
  return Response.json(body, { headers: { 'cache-control': 'public, max-age=2', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/hoga' };
