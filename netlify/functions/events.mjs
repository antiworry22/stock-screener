// 종목 최신 상황 중계 — 최근 공시 목록 · 종목 뉴스 제목 (매매 타이밍 화면에서 사용)
// 주소: /api/events?code=005930   (진단: &diag=1)   — 같은 종목은 5분 동안 서버에 저장된 답을 다시 씀
const UA_PC = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' };
const UA_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://m.stock.naver.com/' };

async function get(url, headers, enc, ms = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    const b = new Uint8Array(await r.arrayBuffer());
    let txt;
    if (enc) txt = new TextDecoder(enc).decode(b);
    else { try { txt = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { txt = new TextDecoder('euc-kr').decode(b); } }
    return { status: r.status, txt };
  } finally { clearTimeout(t); }
}
const strip = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// 날짜 모양을 'YYYY-MM-DD HH:MM' 로
function normDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
  if (m && !/[-.\/]/.test(s.slice(0, 8))) return `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5] || '00'}` : ''}`;
  m = s.match(/(\d{4})[-.\/]\s?(\d{1,2})[-.\/]\s?(\d{1,2})[T\s]*(\d{1,2})?:?(\d{2})?/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}${m[4] ? ` ${m[4].padStart(2, '0')}:${m[5] || '00'}` : ''}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{2})\s*(\d{2})?:?(\d{2})?/);  // 26.10.02 18:03
  if (m) return `20${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5] || '00'}` : ''}`;
  return null;
}
// JSON 어디에 있든 '제목 + 날짜'를 가진 항목을 모음
function walk(j, out, depth = 0) {
  if (!j || depth > 6) return;
  if (Array.isArray(j)) { j.forEach(x => walk(x, out, depth + 1)); return; }
  if (typeof j !== 'object') return;
  const tk = Object.keys(j).find(k => /^(title|tit|subject|reportNm|disclosureTitle|titleFull)$/i.test(k));
  const dk = Object.keys(j).find(k => /^(datetime|dateTime|date|dt|wdt|rceptDt|receiptDate|createdAt|publishedAt|registerDate|writeDate|ymdt|disclosureDate)$/i.test(k));
  if (tk && dk && typeof j[tk] === 'string') {
    const d = normDate(j[dk]);
    if (d) out.push({ t: strip(j[tk]), d, by: strip(j.officeName || j.office || j.press || j.submitter || j.flrNm || j.corpName || ''), id: j.disclosureId || j.rceptNo || j.rcept_no || j.articleId || j.aid || j.id || null, oid: j.officeId || j.oid || null });
  }
  Object.values(j).forEach(v => { if (v && typeof v === 'object') walk(v, out, depth + 1); });
}
// PC 표 (공시 / 뉴스 목록): <td class="title"><a href=...>제목</a></td> ... <td class="info">..</td><td class="date">..</td>
function fromPcTable(h) {
  const out = [];
  for (const r of h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = r[1];
    const a = row.match(/<td[^>]*class="?title"?[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i); if (!a) continue;
    const dt = row.match(/<td[^>]*class="?date"?[^>]*>([\s\S]*?)<\/td>/i);
    const inf = row.match(/<td[^>]*class="?info"?[^>]*>([\s\S]*?)<\/td>/i);
    const d = dt ? normDate(strip(dt[1])) : null; if (!d) continue;
    out.push({ t: strip(a[2]), d, by: inf ? strip(inf[1]) : '', url: a[1].startsWith('http') ? a[1] : 'https://finance.naver.com' + a[1].replace(/&amp;/g, '&') });
  }
  return out;
}
const uniq = a => { const seen = new Set(); return a.filter(x => { const k = x.t.replace(/\s/g, '').slice(0, 40) + x.d.slice(0, 10); if (!x.t || seen.has(k)) return false; seen.add(k); return true; }); };

export default async (req) => {
  const u = new URL(req.url);
  const code = (u.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
  const diag = u.searchParams.get('diag') === '1';
  if (code.length !== 6) return Response.json({ ok: false, err: '6자리 종목코드가 필요해요' }, { status: 400 });
  const ref = { ...UA_PC, Referer: `https://finance.naver.com/item/main.naver?code=${code}` };
  const jobs = {
    mdis: get(`https://m.stock.naver.com/api/stock/${code}/disclosure?pageSize=20&page=1`, UA_M),
    pdis: get(`https://finance.naver.com/item/news_notice.naver?code=${code}&page=1`, ref),
    mnews: get(`https://m.stock.naver.com/api/news/stock/${code}?pageSize=20&page=1`, UA_M),
    pnews: get(`https://finance.naver.com/item/news_news.naver?code=${code}&page=1&clusterId=`, { ...UA_PC, Referer: `https://finance.naver.com/item/news.naver?code=${code}` }),
  };
  const R = {}, D = {};
  await Promise.all(Object.entries(jobs).map(async ([k, p]) => { try { R[k] = await p; } catch (e) { R[k] = { err: String(e).slice(0, 100) }; } }));
  const take = (k, json) => {
    const r = R[k];
    if (!r || r.err || r.status !== 200) { D[k] = r ? (r.err || `HTTP ${r.status}`) : '없음'; return []; }
    try {
      let a = [];
      if (json) walk(JSON.parse(r.txt), a); else a = fromPcTable(r.txt);
      D[k] = `ok ${a.length}`; if (diag) D[k + '_head'] = r.txt.slice(0, 1500);
      return a;
    } catch (e) { D[k] = '해석 실패 ' + String(e).slice(0, 80); if (diag) D[k + '_head'] = r.txt.slice(0, 800); return []; }
  };
  const dis = uniq([...take('mdis', true).map(x => ({ ...x, url: x.id ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.id}` : `https://finance.naver.com/item/news_notice.naver?code=${code}` })), ...take('pdis', false)])
    .sort((a, b) => b.d.localeCompare(a.d)).slice(0, 25);
  const news = uniq([...take('mnews', true).map(x => ({ ...x, url: x.oid && x.id ? `https://n.news.naver.com/mnews/article/${x.oid}/${x.id}` : `https://finance.naver.com/item/news.naver?code=${code}` })), ...take('pnews', false)])
    .sort((a, b) => b.d.localeCompare(a.d)).slice(0, 25);
  const out = { ok: !!(dis.length || news.length), code, at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), dis, news };
  if (diag) out.diag = D;
  return Response.json(out, { headers: { 'cache-control': diag ? 'no-store' : 'public, max-age=120', 'netlify-cdn-cache-control': diag ? 'no-store' : 'public, s-maxage=300', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/events' };
