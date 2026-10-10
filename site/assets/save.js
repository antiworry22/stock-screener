/* 절약 모드 — 사이트 서버(Netlify) 호출을 줄이려고 실시간 갱신 간격을 늘림. 기본 켜짐, 화면 위 띠에서 끄고 켬(이 기기에 저장)
   켜짐: 현황판 시세 15초 · 호가 10초 · 차트 2분 · 매매 타이밍 15초 · 호가 분석 10초 · 지수 1분 · 섹터 3분 · 시장 수급 2분 · 검색 종목·공매도 1분
   꺼짐: 시세 5초 · 호가 3초 · 차트 30초 · 매매 타이밍 5초 · 호가 분석 3초 · 지수 20초 · 섹터 1분 · 시장 수급 1분 · 20초
   (다른 탭을 보고 있거나 창이 가려져 있으면 원래부터 받지 않음) */
'use strict';
function svOn() { try { const v = localStorage.getItem('scr_saveMode'); return v == null ? true : JSON.parse(v) !== false; } catch (e) { return true; } }
function svGap(normal, saver) { return svOn() ? saver : normal; }
function svSet(on) {
  try { localStorage.setItem('scr_saveMode', JSON.stringify(!!on)); } catch (e) {}
  if (typeof OB !== 'undefined' && OB.timer && typeof obPoll === 'function') { clearInterval(OB.timer); OB.timer = setInterval(obPoll, svGap(3000, 10000)); }
  if (typeof renderMktState === 'function') renderMktState();
}
function svChipHtml() {
  const on = svOn();
  return ` <button class="sv-chip ${on ? 'on' : ''}" data-svtoggle="1" title="누르면 ${on ? '끄기(빠른 갱신 — 서버 사용량 약 3배)' : '켜기(갱신 간격을 늘려 서버 사용량 약 1/3)'}">절약 모드 ${on ? '켜짐 · 호가 10초 · 시세 15초' : '꺼짐 · 호가 3초 · 시세 5초'}</button>`;
}
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-svtoggle]'); if (b) { e.preventDefault(); svSet(!svOn()); } });
