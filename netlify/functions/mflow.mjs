// 시장 전체 투자자별 순매수(억원) 실시간 — 코스피·코스닥 (개인·외국인·기관 등)
// 네이버 PC 「투자자별 매매동향」 화면이 없어져(HTTP 410) 모바일 지수 종합(integration)의 투자자 동향을 씀.
// 시간대별 흐름은 화면(브라우저)이 1분마다 받은 값을 쌓아서 만듦.
// 주소: /api/mflow   (진단: ?diag=1)
const UA_M = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://m.stock.naver.com/' };

async function get(url, ms = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers: UA_M, signal: ac.signal }); return { status: r.status, txt: await r.text() }; }
  finally { clearTimeout(t); }
}
const num = s => { if (s == null) return null; const v = parseFloat(String(s).replace(/[,+\s억원]/g, '')); return Number.isFinite(v) ? v : null; };
const NAME = [[/personal|individual|개인/i, '개인'], [/foreign|외국인/i, '외국인'], [/institution|organ|기관/i, '기관'], [/pension|연기금/i, '연기금'], [/financ.*invest|금융투자/i, '금융투자'], [/insur|보험/i, '보험'], [/trust|투신/i, '투신'], [/etc.*corp|기타법인/i, '기타법인']];
const who = k => { for (const [re, n] of NAME) if (re.test(k)) return n; return null; };
// 투자자 동향 객체(모양이 바뀌어도 되도록 키 이름으로 찾음) → {개인, 외국인, 기관, …} 억원
function parseDeal(o) {
  const out = {};
  const put = (n, v, unit) => { if (n && v != null && out[n] === undefined) out[n] = unit === 'm' ? Math.round(v / 100) : v; };
  const walk = (x, path) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((y, i) => { if (y && typeof y === 'object' && (y.key || y.name || y.code) && (y.value != null)) { put(who(String(y.code || '') + ' ' + String(y.key || y.name || '')), num(y.value), /백만/.test(String(y.value)) ? 'm' : ''); } else walk(y, path + '.' + i); }); return; }
    for (const [k, v] of Object.entries(x)) {
      if (v != null && typeof v !== 'object') { const n = who(k); if (n && /value|amount|net|순매수|price/i.test(k) || (n && /^[-+\d,.\s]+(억|백만)?$/.test(String(v)))) put(n, num(v), /백만/.test(String(v)) ? 'm' : ''); }
      else walk(v, path + '.' + k);
    }
  };
  walk(o, '');
  return out;
}

export default async (req) => {
  const u = new URL(req.url), diag = u.searchParams.get('diag') === '1';
  const k = new Date(Date.now() + 9 * 3600e3), day = k.toISOString().slice(0, 10).replace(/-/g, ''), hm = k.toISOString().slice(11, 16);
  const D = {}, out = { ok: false, at: k.toISOString().slice(0, 19).replace('T', ' '), day, mkt: {} };
  await Promise.all(['KOSPI', 'KOSDAQ'].map(async m => {
    const o = {};
    try {
      const r = await get(`https://m.stock.naver.com/api/index/${m}/integration`);
      if (r.status === 200) {
        const j = JSON.parse(r.txt), dt = j.dealTrendInfo || j.dealTrendInfos || j.investorTrendInfo || null;
        if (diag) { D[m + '_deal'] = JSON.stringify(dt).slice(0, 900); D[m + '_updown'] = JSON.stringify(j.upDownStockInfo).slice(0, 500); D[m + '_program'] = JSON.stringify(j.programTrendInfo).slice(0, 500); }
        const v = dt ? parseDeal(dt) : {};
        const bd = dt && (dt.bizdate || dt.bizDate || dt.localDate || dt.date) ? String(dt.bizdate || dt.bizDate || dt.localDate || dt.date).replace(/\D/g, '').slice(0, 8) : null;
        D[m] = `ok 투자자 ${Object.keys(v).join(',') || '없음'}${bd ? ' · 기준일 ' + bd : ''}`;
        if (Object.keys(v).length) { o.now = { t: hm, ...v }; o.bizdate = bd; o.day = [{ t: bd ? `${bd.slice(4, 6)}.${bd.slice(6, 8)}` : hm, ...v }]; }
      } else D[m] = `HTTP ${r.status}`;
    } catch (e) { D[m] = '실패 ' + String(e).slice(0, 80); }
    // 시간대별 표를 주는 새 주소가 있는지 시험(진단 때만)
    if (diag) {
      for (const p of [`https://m.stock.naver.com/api/index/${m}/investor`, `https://m.stock.naver.com/api/index/${m}/dealTrend`, `https://m.stock.naver.com/api/index/${m}/trend/investor`, `https://api.stock.naver.com/index/${m}/investor/trend?bizdate=${day}`]) {
        try { const r = await get(p, 4000); D['try ' + p.replace(/^https:\/\//, '')] = `HTTP ${r.status} ${r.txt.slice(0, 250)}`; } catch (e) { D['try ' + p] = '실패'; }
      }
    }
    out.mkt[m] = o;
  }));
  out.ok = Object.values(out.mkt).some(o => o.now);
  if (diag) out.diag = D;
  return Response.json(out, { headers: { 'cache-control': diag ? 'no-store' : 'public, max-age=30', 'netlify-cdn-cache-control': diag ? 'no-store' : 'public, s-maxage=50', 'access-control-allow-origin': '*' } });
};
export const config = { path: '/api/mflow' };
