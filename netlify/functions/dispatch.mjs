// 자동 실행 도우미 — GitHub의 '정해진 시각 자동 실행'이 자주 밀리거나 빠져서,
// Netlify가 5분마다 깨어나 정해진 시각이면 GitHub에 수집 작업을 '지금 실행'하라고 직접 요청합니다.
// 필요한 것: Netlify 환경변수 GH_TOKEN (GitHub 토큰 — 이 저장소의 Actions 읽기·쓰기 권한)
const REPO = 'antiworry22/stock-screener';

function plan(now) {
  const k = new Date(now.getTime() + 9 * 3600e3);            // 한국 시간
  const w = k.getUTCDay(), h = k.getUTCHours(), m = Math.floor(k.getUTCMinutes() / 5) * 5;
  const wd = w >= 1 && w <= 5, t = h * 60 + m, at = (hh, mm) => t === hh * 60 + mm;
  const jobs = [];
  // 장중 차트·거래대금 실시간: 평일 08:40, 09:00~15:45 15분마다, 16:10
  if (wd && (at(8, 40) || (t >= 540 && t <= 945 && m % 15 === 0) || at(16, 10))) jobs.push('live-chart.yml');
  // 섹터·미국장: 매일 15분마다(:05 :20 :35 :50)
  if (m % 15 === 5) jobs.push('market.yml');
  // 시장 뉴스·공공기관: 매일 06:00~22:59 15분마다
  if (t >= 360 && t < 1380 && m % 15 === 10) jobs.push('news.yml');
  if (t >= 360 && t < 1380 && m % 15 === 0) jobs.push('public.yml');
  // 외국인·기관 수급(거래소 잠정치 시각)
  if (wd && [[9, 35], [11, 5], [13, 25], [14, 35], [15, 50], [16, 40], [18, 20]].some(([a, b]) => at(a, b))) jobs.push('flows.yml');
  // 투자자별 흐름(외국인·연기금·기관·개인): 장중 잠정 4번 + 마감 뒤 확정
  if (wd && [[9, 40], [11, 10], [13, 30], [14, 40], [15, 45], [16, 45], [18, 25], [20, 15], [7, 40]].some(([a, b]) => at(a, b))) jobs.push('investors.yml');
  // 공매도: 거래소 공개 시각에 맞춰 여러 번(장 마감 뒤 당일 거래 · 다음 날 아침 잔고)
  if (wd && [[16, 35], [17, 30], [18, 45], [20, 10], [7, 30]].some(([a, b]) => at(a, b))) jobs.push('shorts.yml');
  // 아침·장마감 정기 수집
  if (wd && (at(6, 40) || at(16, 50))) jobs.push('daily.yml');
  return { jobs, kst: `${k.toISOString().slice(0, 10)} ${String(h).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}` };
}

export default async () => {
  const token = (globalThis.Netlify && Netlify.env.get('GH_TOKEN')) || process.env.GH_TOKEN;
  const { jobs, kst } = plan(new Date());
  if (!token) { console.log(`[${kst}] GH_TOKEN 없음 — 실행 요청 안 함 (예정: ${jobs.join(', ') || '없음'})`); return new Response('no token'); }
  const res = [];
  for (const wf of jobs) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${wf}/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'kmy-stock-dispatch', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main' }),
      });
      res.push(`${wf} ${r.status === 204 ? '요청 완료' : 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120)}`);
    } catch (e) { res.push(`${wf} 실패 ${e}`); }
  }
  console.log(`[${kst}] ${res.join(' · ') || '이번 시각엔 할 일 없음'}`);
  return new Response(res.join('\n') || 'idle');
};
export const config = { schedule: '*/5 * * * *' };
