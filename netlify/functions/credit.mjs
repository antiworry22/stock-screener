// 종목별 신용잔고율 — 어느 공개 경로에서 받을 수 있는지 찾는 중계(1단계: 진단)
// 주소: /api/credit?code=005930&diag=1   → 여러 경로를 열어 「신용」 관련 값이 있는지 보여줌
const UA_PC = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9' };
const UA_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://m.stock.naver.com/' };

async function get(url, headers, ms = 7000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    const b = new Uint8Array(await r.arrayBuffer());
    let txt; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { txt = new TextDecoder('euc-kr').decode(b); }
    return { status: r.status, txt };
  } finally { clearTimeout(t); }
}
const strip = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
// 글자 안에서 「신용」·credit 주변 문장 뽑기
function snippets(txt, isJson) {
  const s = isJson ? txt : strip(txt), out = [];
  const re = /신용|credit|Credit|CREDIT|loan|Loan|융자/g; let m;
  while ((m = re.exec(s)) && out.length < 8) out.push(s.slice(Math.max(0, m.index - 80), m.index + 140));
  return out;
}
// JSON 에서 credit 이 들어간 키와 값
function creditKeys(j, path = '', out = []) {
  if (!j || typeof j !== 'object' || out.length > 20) return out;
  for (const [k, v] of Object.entries(j)) {
    const p = path ? path + '.' + k : k;
    if (/credit|loan|신용/i.test(k) || (typeof v === 'string' && /신용/.test(v))) out.push([p, typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : v]);
    if (v && typeof v === 'object') creditKeys(v, p, out);
  }
  return out;
}

export default async (req) => {
  const u = new URL(req.url);
  const code = (u.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) return Response.json({ ok: false, err: '6자리 종목코드가 필요해요' }, { status: 400 });
  const src = {
    naver_integration: [`https://m.stock.naver.com/api/stock/${code}/integration`, UA_M, true],
    naver_basic: [`https://m.stock.naver.com/api/stock/${code}/basic`, UA_M, true],
    naver_trend: [`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=5`, UA_M, true],
    naver_pc_main: [`https://finance.naver.com/item/main.naver?code=${code}`, { ...UA_PC, Referer: 'https://finance.naver.com/' }, false],
    naver_pc_sise: [`https://finance.naver.com/item/sise.naver?code=${code}`, { ...UA_PC, Referer: `https://finance.naver.com/item/main.naver?code=${code}` }, false],
    daum_quote: [`https://finance.daum.net/api/quotes/A${code}?summary=false&changeStatistics=true`, { ...UA_PC, Accept: 'application/json', Referer: `https://finance.daum.net/quotes/A${code}` }, true],
    daum_credit: [`https://finance.daum.net/api/quote/A${code}/credits?page=1&perPage=10`, { ...UA_PC, Accept: 'application/json', Referer: `https://finance.daum.net/quotes/A${code}` }, true],
    wise_main: [`https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=${code}`, { ...UA_PC, Referer: `https://finance.naver.com/item/coinfo.naver?code=${code}` }, false],
    fnguide: [`https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?pGB=1&gicode=A${code}`, UA_PC, false],
  };
  const out = { code, at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), src: {} };
  await Promise.all(Object.entries(src).map(async ([k, [url, h, isJson]]) => {
    try {
      const r = await get(url, h);
      const o = { status: r.status, len: r.txt.length };
      if (r.status === 200) {
        if (isJson) { try { o.keys = creditKeys(JSON.parse(r.txt)); } catch (e) { o.parse = '해석 실패'; } }
        o.snip = snippets(r.txt, isJson);
        if (!o.snip.length) o.head = (isJson ? r.txt : strip(r.txt)).slice(0, 300);
      } else o.head = r.txt.slice(0, 200);
      out.src[k] = o;
    } catch (e) { out.src[k] = { err: String(e).slice(0, 120) }; }
  }));
  return Response.json(out, { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/credit' };
