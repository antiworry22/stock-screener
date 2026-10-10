/* 장 상태 띠 — 모든 화면 위에 「지금 장이 열렸는지 · 화면 시세가 언제 값인지 · 언제부터 실시간인지」를 보여줌 */
'use strict';
function msState() {
  const k = new Date(Date.now() + 9 * 3600e3), d = k.toISOString().slice(0, 10), wd = k.getUTCDay(), m = k.getUTCHours() * 60 + k.getUTCMinutes();
  const hol = typeof TM_HOL !== 'undefined' && TM_HOL.has(d), biz = wd >= 1 && wd <= 5 && !hol;
  const st = !biz ? 'closed' : m < 480 ? 'night' : m < 540 ? 'pre' : m < 930 ? 'open' : m < 1200 ? 'after' : 'night';
  return { d, m, st, hol, wd };
}
function msLastDay() {
  const q = typeof BD !== 'undefined' && BD.q ? Object.values(BD.q).find(x => x && x.t) : null;
  const t = q && q.t ? String(q.t).slice(0, 10) : (typeof S !== 'undefined' && S.data && S.data.meta ? S.data.meta.asof : '');
  if (!t) return '';
  const dt = new Date(t + 'T00:00:00Z'); return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}(${'일월화수목금토'[dt.getUTCDay()]})`;
}
function renderMktState() {
  const el = $('#mktState'); if (!el) return;
  const s = msState(), last = msLastDay(), left = (to) => { const r = to - s.m; return r >= 60 ? `${Math.floor(r / 60)}시간 ${r % 60}분` : `${r}분`; };
  let cls = 'ms-off', txt;
  if (s.st === 'open') { cls = 'ms-on'; txt = `<b><span class="gov-live"></span>장중</b> 정규장 09:00~15:30 · ${typeof svOn === 'function' && svOn() ? '시세 15초 · 호가 10초 · 수급 2분' : '시세 5초 · 호가 3초 · 수급 1분'}마다 실시간 갱신 중`; }
  else if (s.st === 'pre') txt = `<b>장 시작 전</b> 정규장은 09:00에 열려요(${left(540)} 남음). 지금 화면의 시세·호가·차트는 마지막 거래일 ${last} 값이라 바뀌지 않아요 — 9시부터 자동으로 실시간 갱신돼요.`;
  else if (s.st === 'after') { cls = 'ms-after'; txt = `<b>정규장 마감</b> 15:30에 끝났어요. 지금 움직이는 값은 대체거래소(NXT) 시간외 거래(~20:00)라 거래가 적어요. 판정은 오늘 종가 기준이에요.`; }
  else if (s.st === 'closed') txt = `<b>${s.hol ? '휴장일' : '주말'}</b> 오늘은 장이 열리지 않아요. 화면 값은 마지막 거래일 ${last} 기준이에요.`;
  else txt = `<b>장 마감</b> 화면 값은 마지막 거래일 ${last} 기준이에요. 다음 정규장은 09:00에 열려요.`;
  el.className = 'ms-bar ' + cls; el.innerHTML = txt + (typeof svChipHtml === 'function' ? svChipHtml() : '');
}
(function waitMs() {
  if (typeof $ === 'function' && document.readyState !== 'loading') { renderMktState(); setInterval(renderMktState, 30e3); }
  else setTimeout(waitMs, 500);
})();
