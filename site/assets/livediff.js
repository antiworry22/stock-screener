/* 실시간 변화 표시 — 새 자료가 들어와 다시 계산될 때마다 목록에 '새로 들어온 종목(NEW)'·'빠진 종목'을 표시하고
   각 칸에 몇 시 자료 기준인지 보여 줌 (차트 패턴·대시보드 목록) */
'use strict';

const LDIFF = { key: null, prev: {}, cur: {} };
function ldKey() { return typeof LIVE !== 'undefined' ? LIVE.n : 0; }
function ldMark(name, codes) {
  const k = ldKey();
  if (LDIFF.keyOf !== undefined && LDIFF.keyOf[name] !== k) { LDIFF.prev[name] = LDIFF.cur[name]; }
  LDIFF.keyOf = LDIFF.keyOf || {}; LDIFF.keyOf[name] = k;
  LDIFF.cur[name] = new Set(codes);
  const p = LDIFF.prev[name];
  if (!p) return { fresh: new Set(), gone: [] };
  return { fresh: new Set(codes.filter(c => !p.has(c))), gone: [...p].filter(c => !LDIFF.cur[name].has(c)) };
}
function ldStamp() {
  const t = typeof LIVE !== 'undefined' && LIVE.tfTime ? String(LIVE.tfTime).slice(11) : null;
  const last = typeof LIVE !== 'undefined' && LIVE.last ? String(LIVE.last).slice(11) : null;
  return t ? `<span class="gov-live"></span> 시세 ${esc(t)} · 다시 계산 ${esc(last || '-')}` : `${esc(S.data.meta.asof)} 종가 기준 · 장중 15분마다 자동 갱신`;
}
const ldName = c => { const s = S.data.stocks.find(x => x.code === c); return s ? s.name : c; };
// 목록 DOM 에 NEW 표시 + 빠진 종목 한 줄
function ldDecorate(boxSel, name, codes) {
  const box = $(boxSel); if (!box) return;
  const d = ldMark(name, codes);
  $$('[data-code]', box).forEach(el => { if (d.fresh.has(el.dataset.code) && !el.querySelector('.ld-new')) { const b = el.querySelector('b'); if (b) b.insertAdjacentHTML('afterend', ' <span class="ld-new">NEW</span>'); } });
  let foot = box.parentElement.querySelector('.ld-foot');
  if (!foot) { foot = document.createElement('div'); foot.className = 'ld-foot hint'; box.after(foot); }
  foot.innerHTML = ldStamp() + (d.gone.length ? ` · 빠짐: ${d.gone.slice(0, 5).map(c => esc(ldName(c))).join(', ')}${d.gone.length > 5 ? ` 외 ${d.gone.length - 5}` : ''}` : '') + (d.fresh.size ? ` · 새로 들어옴 ${d.fresh.size}` : '');
}
function ldDash() {
  const codes = sel => $$(sel + ' [data-code]').map(e => e.dataset.code);
  ldDecorate('#listSupply', 'supply', codes('#listSupply'));
  ldDecorate('#listWhite', 'white', codes('#listWhite'));
  ldDecorate('#listBan', 'ban', codes('#listBan'));
  ldDecorate('#recDash', 'recdash', codes('#recDash'));
}
function ldPatterns(key, rows) {
  const ok = rows.filter(r => r.p.ok).map(r => r.s.code);
  const d = ldMark('pat_' + key, ok);
  const box = $('#patList');
  if (box) $$('.rec.pat', box).forEach(el => { if (d.fresh.has(el.dataset.code)) { const b = el.querySelector('.nm b'); if (b && !el.querySelector('.ld-new')) b.insertAdjacentHTML('afterend', ' <span class="ld-new">방금 충족</span>'); el.classList.add('ld-hl'); } });
  const meta = $('#patMeta');
  if (meta) meta.innerHTML = esc(meta.textContent) + ` · ${ldStamp()}`
    + (d.fresh.size ? ` · <b class="up">새로 충족 ${d.fresh.size}</b>: ${[...d.fresh].slice(0, 6).map(c => esc(ldName(c))).join(', ')}` : '')
    + (d.gone.length ? ` · <span class="down">조건에서 빠짐 ${d.gone.length}</span>: ${d.gone.slice(0, 6).map(c => esc(ldName(c))).join(', ')}` : '');
}
