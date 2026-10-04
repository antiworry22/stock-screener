// 회사 정보 중계 — 기업개요(무슨 사업을 하는지) · 주요 제품 매출 구성 · 기본 정보 · 증권사 목표가·의견 · 최근 리포트 제목
// 주소: /api/company?code=005930   (진단: &diag=1)   — 같은 종목은 6시간 동안 서버에 저장된 답을 다시 씀
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
const strip = h => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();

// ① 네이버 금융 종목 메인: 기업개요 문단 · 업종
function fromNaverMain(h) {
  const o = {};
  const m = h.match(/<div[^>]+class="summary_info"[^>]*>([\s\S]*?)<\/div>/i);
  if (m) o.summary = [...m[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x => strip(x[1])).filter(Boolean);
  const ind = h.match(/업종명\s*[:：]\s*<a[^>]*>([^<]+)<\/a>/) || h.match(/sise_group_detail[^>]*>([^<]+)<\/a>/);
  if (ind) o.industry = strip(ind[1]);
  return o;
}
// ② 와이즈리포트 기업현황: 비즈니스 요약(날짜 붙은 문장들)
function fromWiseMain(h) {
  const o = {};
  const ul = h.match(/<ul[^>]+class="dot_cmp"[^>]*>([\s\S]*?)<\/ul>/i) || h.match(/class="cmp_comment"[^>]*>([\s\S]*?)<\/td>/i);
  if (ul) o.biz = [...ul[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => strip(x[1])).filter(Boolean);
  const hd = h.match(/<h4[^>]*>\s*Business Summary\s*<\/h4>[\s\S]*?<\/span>\s*([^<]*)/i);
  if (hd) o.bizDate = strip(hd[1]);
  // 시장 분류·WICS 업종
  const wics = h.match(/WICS\s*:\s*([^<\n]+)/); if (wics) o.wics = strip(wics[1]);
  const ksic = h.match(/KSE\s*:\s*([^<\n]+)|KOSDAQ\s*:\s*([^<\n]+)/); if (ksic) o.ksic = strip(ksic[1] || ksic[2]);
  return o;
}
// ③ 와이즈리포트 기업개요: 설립·상장·대표·직원·홈페이지·주요제품 매출구성
function fromWiseOverview(h) {
  const o = {};
  const cell = label => { const m = h.match(new RegExp(label + '\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>', 'i')); return m ? strip(m[1]) : null; };
  o.info = {};
  [['설립일', '설립일'], ['상장일', '상장일'], ['대표이사', '대표'], ['종업원수', '직원 수'], ['홈페이지', '홈페이지'], ['본사주소', '본사'], ['계열사', '계열사'], ['결산월', '결산월']].forEach(([k, nm]) => { const v = cell(k); if (v) o.info[nm] = v.slice(0, 200); });
  const i = h.indexOf('주요제품');
  if (i >= 0) {
    const tb = h.slice(i, h.indexOf('</table>', i));
    o.products = [...tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => strip(c[1])))
      .filter(c => c.length >= 2 && /\d/.test(c[c.length - 1]) && !/주요제품|구성비|기준/.test(c[0]))
      .map(c => ({ name: c[0], pct: parseFloat(String(c[c.length - 1]).replace(/[^\d.\-]/g, '')) }))
      .filter(x => x.name && Number.isFinite(x.pct)).slice(0, 12);
  }
  return o;
}
// ④ 네이버 증권 모바일 종합: 지표(PER·PBR·배당 등) · 증권사 목표가·의견 · 최근 리포트
function fromMobile(j) {
  const o = {};
  const ti = j.totalInfos || j.totalInfo || [];
  if (Array.isArray(ti)) o.stats = ti.map(x => ({ k: x.key || x.name || x.code, v: x.value })).filter(x => x.k && x.v != null).slice(0, 24);
  const c = j.consensusInfo || j.consensus;
  if (c) o.consensus = { target: c.priceTargetMean ?? c.targetPrice ?? null, opinion: c.recommMean ?? c.recommend ?? null, date: c.createDate ?? c.date ?? null, raw: Object.fromEntries(Object.entries(c).slice(0, 12)) };
  const rs = j.researches || j.research || [];
  if (Array.isArray(rs)) o.reports = rs.slice(0, 8).map(r => ({ t: r.tit || r.title, by: r.bnm || r.brokerName || r.office, d: r.wdt || r.writeDate || r.date, id: r.id || r.nid })).filter(r => r.t);
  if (j.industryCode) o.industryCode = j.industryCode;
  if (j.stockName) o.name = j.stockName;
  if (j.description) o.desc = strip(j.description);
  return o;
}

export default async (req) => {
  const u = new URL(req.url);
  const code = (u.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
  const diag = u.searchParams.get('diag') === '1';
  if (code.length !== 6) return Response.json({ ok: false, err: '6자리 종목코드가 필요해요' }, { status: 400 });
  const jobs = {
    main: get(`https://finance.naver.com/item/main.naver?code=${code}`, { ...UA_PC, Referer: 'https://finance.naver.com/' }, 'euc-kr'),
    wise1: get(`https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=${code}`, { ...UA_PC, Referer: `https://finance.naver.com/item/coinfo.naver?code=${code}` }),
    wise2: get(`https://navercomp.wisereport.co.kr/v2/company/c1020001.aspx?cmp_cd=${code}`, { ...UA_PC, Referer: `https://finance.naver.com/item/coinfo.naver?code=${code}` }),
    mob: get(`https://m.stock.naver.com/api/stock/${code}/integration`, UA_M),
  };
  const R = {}, D = {};
  await Promise.all(Object.entries(jobs).map(async ([k, p]) => { try { R[k] = await p; } catch (e) { R[k] = { err: String(e).slice(0, 100) }; } }));
  const out = { ok: false, code, at: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') };
  const run = (k, fn, isJson) => {
    const r = R[k];
    if (!r || r.err || r.status !== 200) { D[k] = r ? (r.err || `HTTP ${r.status}`) : '없음'; return; }
    try { const v = fn(isJson ? JSON.parse(r.txt) : r.txt); Object.assign(out, Object.fromEntries(Object.entries(v).filter(([, x]) => x != null && !(Array.isArray(x) && !x.length) && !(typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length)))); D[k] = 'ok ' + Object.keys(v).join(','); }
    catch (e) { D[k] = '해석 실패 ' + String(e).slice(0, 80); }
    if (diag) D[k + '_head'] = r.txt.slice(0, k === 'mob' ? 2500 : 600);
  };
  run('main', fromNaverMain); run('wise1', fromWiseMain); run('wise2', fromWiseOverview); run('mob', fromMobile, true);
  out.ok = !!(out.summary || out.biz || out.products || out.consensus || out.stats);
  if (diag) out.diag = D;
  return Response.json(out, { headers: { 'cache-control': diag ? 'no-store' : 'public, max-age=3600', 'netlify-cdn-cache-control': diag ? 'no-store' : 'public, s-maxage=21600', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/company' };
