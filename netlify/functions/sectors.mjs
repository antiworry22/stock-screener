// 업종(섹터) 실시간 — 네이버 금융 「업종별 시세」 전체 목록 + 업종별 구성 종목(현재가·등락률·거래량·거래대금)
// 주소: /api/sectors   (진단: ?diag=1)   — 60초 동안 서버에 저장된 답을 다시 씀
const UA_PC = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'ko-KR,ko;q=0.9', Referer: 'https://finance.naver.com/sise/sise_group.naver?type=upjong' };

async function get(url, ms = 7000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA_PC, signal: ac.signal });
    const b = new Uint8Array(await r.arrayBuffer());
    let txt; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { txt = new TextDecoder('euc-kr').decode(b); }
    return { status: r.status, txt };
  } finally { clearTimeout(t); }
}
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const num = s => { const v = parseFloat(String(s).replace(/[,+%\s]/g, '')); return Number.isFinite(v) ? v : null; };
const sgn = (html, v) => v == null ? null : (/down|nv01|하락|blue/i.test(html) && v > 0 ? -v : v);

// 업종 목록: 이름 · 번호 · 등락률 · 전체/상승/보합/하락 종목 수
function parseList(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const a = m[1].match(/sise_group_detail\.naver\?type=upjong&(?:amp;)?no=(\d+)"[^>]*>([\s\S]*?)<\/a>/i); if (!a) continue;
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => x[1]);
    const pi = tds.findIndex(t => /%/.test(strip(t))); if (pi < 0) continue;
    const pct = sgn(tds[pi], num(strip(tds[pi])));
    const ns = tds.slice(pi + 1).map(t => num(strip(t))).filter(v => v != null);
    out.push({ no: a[1], name: strip(a[2]), pct: pct != null && /-/.test(strip(tds[pi])) ? -Math.abs(pct) : pct, n: ns[0] ?? null, up: ns[1] ?? null, flat: ns[2] ?? null, dn: ns[3] ?? null });
  }
  return out;
}
// 업종 구성 종목: 코드 · 이름 · 현재가 · 등락률 · 거래량 · 거래대금(백만원 → 억원)
function parseDetail(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const a = m[1].match(/code=(\w{6})"[^>]*>([\s\S]*?)<\/a>/i); if (!a) continue;
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => x[1]);
    const pi = tds.findIndex(t => /%/.test(strip(t))); if (pi < 1) continue;
    const t0 = strip(tds[pi]);
    let pct = num(t0); if (pct != null && /-/.test(t0)) pct = -Math.abs(pct);
    const before = tds.slice(1, pi).map(t => num(strip(t))).filter(v => v != null);
    const after = tds.slice(pi + 1).map(t => num(strip(t))).filter(v => v != null);
    // 등락률 뒤: 매수호가 · 매도호가 · 거래량 · 거래대금(백만) · 전일거래량
    const vol = after.length >= 4 ? after[2] : null, tvM = after.length >= 4 ? after[3] : null;
    out.push({ c: a[1], n: strip(a[2]), p: before[0] ?? null, r: pct, v: vol, tv: tvM != null ? Math.round(tvM / 100 * 10) / 10 : null });
  }
  return out;
}

export default async (req) => {
  const u = new URL(req.url), diag = u.searchParams.get('diag') === '1';
  const k = new Date(Date.now() + 9 * 3600e3);
  const out = { ok: false, at: k.toISOString().slice(0, 19).replace('T', ' '), list: [], det: {} }, D = {};
  try {
    const r = await get('https://finance.naver.com/sise/sise_group.naver?type=upjong');
    if (r.status === 200) { out.list = parseList(r.txt); D.list = `ok ${out.list.length}업종`; if (diag && !out.list.length) D.list_head = strip(r.txt).slice(0, 600); }
    else D.list = `HTTP ${r.status}`;
  } catch (e) { D.list = '실패 ' + String(e).slice(0, 80); }
  // 구성 종목: 한 번에 12곳씩 나눠 받음
  const nos = out.list.map(x => x.no);
  let okN = 0, fail = 0;
  for (let i = 0; i < nos.length; i += 12) {
    await Promise.all(nos.slice(i, i + 12).map(async no => {
      try {
        const r = await get(`https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no=${no}`, 6000);
        if (r.status === 200) { const L = parseDetail(r.txt); if (L.length) { out.det[no] = L; okN++; } else if (diag && !D.det_head) D.det_head = strip(r.txt).slice(0, 800); }
        else fail++;
      } catch (e) { fail++; }
    }));
  }
  D.det = `종목표 ${okN}/${nos.length}업종 · 실패 ${fail}`;
  if (diag) { const f = Object.values(out.det)[0]; D.det_sample = f ? f.slice(0, 3) : null; }
  out.ok = out.list.length > 0;
  if (diag) out.diag = D;
  return Response.json(out, { headers: { 'cache-control': diag ? 'no-store' : 'public, max-age=30', 'netlify-cdn-cache-control': diag ? 'no-store' : 'public, s-maxage=60', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/sectors' };
