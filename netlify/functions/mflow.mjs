// 시장 전체 투자자별 순매수(억원) 실시간 — 코스피·코스닥 · 시간대별 누적(개인·외국인·기관·연기금 등)
// 주소: /api/mflow   (진단: ?diag=1)   — 1분 동안 서버에 저장된 답을 다시 씀
const UA_PC = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://finance.naver.com/sise/sise_trans_style.naver' };
const UA_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://m.stock.naver.com/' };

async function get(url, headers, ms = 7000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    const b = new Uint8Array(await r.arrayBuffer());
    let txt; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { txt = new TextDecoder('euc-kr').decode(b); }
    return { status: r.status, txt };
  } finally { clearTimeout(t); }
}
const strip = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const num = s => { const v = parseFloat(String(s).replace(/[,+\s]/g, '')); return Number.isFinite(v) ? v : null; };
const NAME = [[/기타금융/, '기타금융'], [/금융투자/, '금융투자'], [/기타법인/, '기타법인'], [/연기금/, '연기금'], [/보험/, '보험'], [/투신/, '투신'], [/은행/, '은행'], [/개인/, '개인'], [/외국인/, '외국인'], [/기관/, '기관']];
const norm = h => { for (const [re, n] of NAME) if (re.test(h)) return n; return null; };

// 네이버 PC 「투자자별 매매동향」 표: 첫 칸이 시각(시간별) 또는 날짜(일별), 나머지는 억원
function parseTable(html) {
  // 머리글(2줄): 첫 줄의 colspan 칸 자리에 둘째 줄 이름들을 차례로 끼워 넣어 실제 열 순서를 만듦
  const hrows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => [...m[1].matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/gi)].map(x => ({ span: +((x[1].match(/colspan\s*=\s*"?(\d+)/i) || [])[1] || 1), name: strip(x[2]) }))).filter(r => r.length);
  let heads = [];
  if (hrows.length) {
    const sub = (hrows[1] || []).map(x => x.name);
    hrows[0].forEach(h => { if (h.span > 1) heads.push(...sub.splice(0, h.span)); else heads.push(h.name); });
  }
  const cols = heads.slice(1).map(norm);
  const rows = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => strip(x[1]));
    if (tds.length < 4) continue;
    const k = tds[0];
    if (!/^\d{1,2}:\d{2}$|^\d{2}\.\d{2}\.\d{2}$/.test(k)) continue;
    const o = { t: k };
    tds.slice(1).forEach((v, i) => { const n = cols[i]; if (n && o[n] === undefined) o[n] = num(v); });
    rows.push(o);
  }
  return { cols, rows };
}

export default async (req) => {
  const u = new URL(req.url), diag = u.searchParams.get('diag') === '1';
  const k = new Date(Date.now() + 9 * 3600e3), day = k.toISOString().slice(0, 10).replace(/-/g, '');
  const D = {}, out = { ok: false, at: k.toISOString().slice(0, 19).replace('T', ' '), day, mkt: {} };
  await Promise.all([['KOSPI', '01'], ['KOSDAQ', '02']].map(async ([m, so]) => {
    const o = {};
    try {
      const r = await get(`https://finance.naver.com/sise/investorDealTrendTime.naver?bizdate=${day}&sosok=${so}`, UA_PC);
      if (r.status === 200) { const p = parseTable(r.txt); D[m + '_time'] = `ok 열 ${p.cols.filter(Boolean).join(',')} · ${p.rows.length}행`; if (diag) D[m + '_time_head'] = strip(r.txt).slice(0, 600); if (p.rows.length) o.time = p.rows; }
      else D[m + '_time'] = `HTTP ${r.status}`;
    } catch (e) { D[m + '_time'] = '실패 ' + String(e).slice(0, 80); }
    try {
      const r = await get(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${day}&sosok=${so}`, UA_PC);
      if (r.status === 200) { const p = parseTable(r.txt); D[m + '_day'] = `ok 열 ${p.cols.filter(Boolean).join(',')} · ${p.rows.length}행`; if (p.rows.length) o.day = p.rows; }
      else D[m + '_day'] = `HTTP ${r.status}`;
    } catch (e) { D[m + '_day'] = '실패 ' + String(e).slice(0, 80); }
    if (!o.time && !o.day) {  // 모바일 지수 종합(예비)
      try {
        const r = await get(`https://m.stock.naver.com/api/index/${m}/integration`, UA_M);
        if (r.status === 200) { const j = JSON.parse(r.txt); const t = j.dealTrendInfos || j.investorTrendInfos || j.investorInfos || null; D[m + '_m'] = `ok keys ${Object.keys(j).slice(0, 15).join(',')}`; if (t) o.m = t; if (diag) D[m + '_m_head'] = r.txt.slice(0, 1200); }
        else D[m + '_m'] = `HTTP ${r.status}`;
      } catch (e) { D[m + '_m'] = '실패 ' + String(e).slice(0, 80); }
    }
    out.mkt[m] = o;
  }));
  out.ok = Object.values(out.mkt).some(o => o.time || o.day || o.m);
  if (diag) out.diag = D;
  return Response.json(out, { headers: { 'cache-control': diag ? 'no-store' : 'public, max-age=30', 'netlify-cdn-cache-control': diag ? 'no-store' : 'public, s-maxage=60', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/mflow' };
