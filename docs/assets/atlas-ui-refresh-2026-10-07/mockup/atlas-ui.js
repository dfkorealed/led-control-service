// 독립 시각 검토 목업: 모든 데이터·명령·파일은 브라우저 메모리에서만 처리한다.
export const store = {
  site: '서울 본사', floor: 'B1', theme: 'light', tool: 'select', selected: [], brightness: 70,
  query: '', statusFilter: 'all', zoom: 1, panX: 0, panY: 0, scenario: 'success',
  lights: ['B1', '1F'].flatMap((floor, fi) => Array.from({ length: fi ? 12 : 24 }, (_, i) => ({
    id: `${floor}-${String(i + 1).padStart(3, '0')}`, name: `${floor} 조명 ${String(i + 1).padStart(2, '0')}`,
    floor, status: i === 5 || i === 17 ? 'offline' : i === 9 || i === 20 ? 'warning' : 'normal',
    brightness: i === 5 || i === 17 ? 40 : 70, watt: 30, group: i < 12 ? '서쪽 주차구역' : '동쪽 주차구역',
    x: 125 + (i % 6) * 150, y: 130 + Math.floor(i / 6) * 125, lastSeen: '2026-10-06 21:30:00'
  }))),
  activity: [
    { time: '21:30:00', label: 'B1 조명 12대 · 밝기 70% 적용', status: 'success' },
    { time: '21:28:42', label: 'B1 조명 06 · 연결 확인 필요', status: 'failure' },
    { time: '21:25:10', label: '야간 스케줄 · 적용 대기', status: 'pending' },
    ...Array.from({length:9},(_,i)=>({date:'2026-10-06',time:`20:${String(54-i*3).padStart(2,'0')}:00`,label:`${i%2?'1F':'B1'} 조명 ${i+1}대 · 밝기 ${i%2?30:70}% · 가상 실행 ${i+1}`,status:i%4===0?'partial':'success',target:{site:'서울 본사',floor:i%2?'1F':'B1'},brightness:i%2?30:70,success:i+1,failed:i%4===0?1:0,excluded:0}))
  ]
};
export const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const paths = {
  lightbulb: '<path d="M9 18h6M9 21h6M8 14c-4-4-2-11 4-11s8 7 4 11l-1 2H9z"/>',
  map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16"/>',
  monitor: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', sliders: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
  chart: '<path d="M4 3v18h17M8 16v-5M13 16V7M18 16V4"/>', settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 1 3h4l1-3 3-1 2-3-2-2 1-3-3-2-1-3z"/><circle cx="11" cy="12" r="3"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>', filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', expand: '<path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6"/>',
  chevron: '<path d="m8 5 7 7-7 7"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  edit: '<path d="m4 15 11-11 5 5L9 20H4zM13 6l5 5"/>', trash: '<path d="M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  check: '<path d="m4 12 5 5L20 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', alert: '<path d="m12 3 10 18H2zM12 9v5M12 17v1"/>',
  bell: '<path d="M5 17h14l-2-4V9a5 5 0 0 0-10 0v4zM10 21h4"/>', moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M20 4l-2 2M6 18l-2 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15c3 0 3 3 3 6"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/>', logout: '<path d="M10 3H3v18h7M9 12h12m-5-5 5 5-5 5"/>',
  move: '<path d="M12 2v20M2 12h20m-13-7 3-3 3 3m-6 14 3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3"/>', select: '<path d="m5 3 14 10-7 1-4 7z"/>', area: '<path stroke-dasharray="3 3" d="M3 3h18v18H3z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-1l1 6M4 12l1 6a8 8 0 0 0 14-1"/>', building: '<path d="M5 21V3h14v18M3 21h18M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-5h4v5"/>', link: '<path d="m9 15 6-6M8 17l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 7l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'
};
export const icon = (name, size = 20) => `<svg class="icon" width="${Number(size) || 20}" height="${Number(size) || 20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.more}</svg>`;
export const badge = (text, tone = 'neutral') => `<span class="chip tone-${esc(tone)}">${esc(text)}</span>`;
export const button = (text, { action = '', icon: name = '', variant = 'secondary', disabled = false, attrs = '' } = {}) => `<button type="button" class="btn btn-${esc(variant)}" ${action ? `data-action="${esc(action)}"` : ''} ${disabled ? 'disabled' : ''} ${attrs}>${name ? icon(name) : ''}${esc(text)}</button>`;
export const field = (label, control, hint = '') => `<label class="field"><span>${esc(label)}</span>${control}${hint ? `<small class="muted">${esc(hint)}</small>` : ''}</label>`;
export const kpi = (label, value, { unit = '', trend = '', tone = 'neutral' } = {}) => `<div class="card metric"><span class="muted">${esc(label)}</span><div class="metric-value tone-${esc(tone)}">${esc(value)}<small>${esc(unit)}</small></div>${trend ? `<span class="caption">${esc(trend)}</span>` : ''}</div>`;
export function dataGrid({ columns, rows, id = '' }) {
  const headings = columns.map((c, i) => `<th scope="col"><button type="button" data-grid-sort="${i}" aria-label="${esc(c.label)} 정렬">${esc(c.label)} ↕</button></th>`).join('');
  const body = rows.map(r => `<tr>${columns.map(c => `<td>${r[c.key] ?? '—'}</td>`).join('')}</tr>`).join('');
  return `<div class="grid-host" id="${esc(id)}"><div class="table-wrap"><table class="data-grid"><thead><tr>${headings}</tr></thead><tbody>${body || `<tr><td colspan="${columns.length}">조건에 맞는 항목이 없습니다.</td></tr>`}</tbody></table></div><div class="mobile-grid"><div class="mobile-sort"><label>정렬 <select class="input" data-mobile-sort>${columns.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')}</select></label><button type="button" class="btn" data-mobile-sort-direction aria-label="정렬 방향 전환">오름차순 ↑</button><button type="button" class="btn" data-mobile-sort-apply>정렬 적용</button></div>${rows.map(r => `<article class="mobile-row">${columns.map(c => `<div><span class="caption">${esc(c.label)}</span><div>${r[c.key] ?? '—'}</div></div>`).join('')}</article>`).join('') || '<p class="empty-state">조건에 맞는 항목이 없습니다.</p>'}</div></div>`;
}
export function activityLog(entries, { title = '최근 활동', max = 3, allAction = 'logs' } = {}) {
  // 기존 호출 옵션은 받되 v2에서는 max·route 이동 대신 한 줄 순환과 전체 스냅샷 팝업을 사용한다.
  const snapshot = normalizeActivity(entries);
  return `<section class="panel activity-log activity-ticker" data-activity-snapshot="${esc(JSON.stringify(snapshot))}"><h3 class="section-title">${esc(title)}</h3><div class="activity-row" data-ticker-row>${activityRowContent(snapshot[0])}</div>${button('전체 보기', { action: 'activity-all', variant: 'ghost', icon: 'arrow' })}</section>`;
}
const activityStatuses = { success: ['완료','success'], partial: ['일부 완료','warning'], failure: ['실패','danger'], pending: ['진행 중','neutral'] };
function normalizeActivity(entries) {
  return (Array.isArray(entries)?entries:[]).filter(e=>e&&typeof e==='object').map(e=>({
    // 날짜가 없는 기존 seed 활동만 시안의 고정 기준일을 사용한다. 새 실행의 별도 date는 반드시 보존한다.
    date:String(e.date??(/^\d{4}-\d{2}-\d{2}/.test(e.time)?String(e.time).slice(0,10):'2026-10-06')),
    time:String(e.time??'—'),label:String(e.label??''),status:Object.hasOwn(activityStatuses,e.status)?e.status:'pending',
    target:e.target&&typeof e.target==='object'?JSON.parse(JSON.stringify(e.target)):String(e.target??''),
    actor:String(e.actor??''),brightness:e.brightness??null,success:e.success??null,failed:e.failed??null,excluded:e.excluded??null
  }));
}
function activityTarget(entry) { const target=entry.target;return Array.isArray(target)?target.join(', '):target&&typeof target==='object'?[target.site,target.floor].filter(Boolean).join(' / '):String(target||''); }
export function filterActivityEntries(entries,{query='',status='all',from='',to=''}={}) {
  return normalizeActivity(entries).filter(e=>(!query||`${e.label} ${activityTarget(e)} ${e.actor}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))&&(status==='all'||status===e.status)&&(!from||e.date>=from)&&(!to||e.date<=to));
}
function activityRowContent(entry) { return entry ? `<time>${esc(entry.time)}</time><span class="activity-message" title="${esc(entry.label)}">${esc(entry.label)}</span>${badge(...activityStatuses[entry.status])}` : '<span class="muted activity-empty">표시할 기록이 없습니다.</span>'; }
export function createActivityTicker(entries,onChange,{schedule=setInterval,cancel=clearInterval,connected=()=>true}={}) {
  const snapshot=normalizeActivity(entries); let index=0, timer=null, disposed=false;
  const emit=()=>onChange(snapshot[index] ? normalizeActivity([snapshot[index]])[0] : null);
  const dispose=()=>{if(disposed)return;disposed=true;if(timer!==null)cancel(timer);timer=null;};
  emit();
  if(snapshot.length>1)timer=schedule(()=>{if(disposed)return;if(!connected()){dispose();return;}index=(index+1)%snapshot.length;emit();},5000);
  return {dispose, getEntries:()=>normalizeActivity(snapshot)};
}
const mountedTickers=new Map(); let tickerObserver;
export function cleanupCommon(root) { for(const [element,ticker] of mountedTickers)if(!element.isConnected || root===element || root?.contains(element)){ticker.dispose();mountedTickers.delete(element);} }
function mountActivity(root) {
  if(!tickerObserver && typeof MutationObserver!=='undefined') { tickerObserver=new MutationObserver(()=>cleanupCommon());tickerObserver.observe(document.body,{childList:true,subtree:true}); }
  root.querySelectorAll('.activity-ticker').forEach(element=>{
    if(mountedTickers.has(element))return;
    const snapshot=normalizeActivity(JSON.parse(element.dataset.activitySnapshot||'[]'));
    const row=element.querySelector('[data-ticker-row]');
    const ticker=createActivityTicker(snapshot,entry=>{row.innerHTML=activityRowContent(entry);},{connected:()=>element.isConnected});
    mountedTickers.set(element,ticker);
    element.querySelector('[data-action="activity-all"]').onclick=()=>{
      const entries=ticker.getEntries();
      const columns=[{key:'time',label:'시간'},{key:'status',label:'상태'},{key:'label',label:'내용 · 대상 · 밝기'}];
      const grid=items=>dataGrid({columns,rows:items.map(e=>({time:`${esc(e.date)}<br>${esc(e.time)}`,status:badge(...activityStatuses[e.status]),label:`<div>${esc(e.label)}</div><div class="caption">${esc(activityTarget(e))}${e.brightness!==null?` · 밝기 ${esc(e.brightness)}%`:''}${e.actor?` · ${esc(e.actor)}`:''}</div>${e.success!==null?`<div class="caption">성공 ${esc(e.success)} / 실패 ${esc(e.failed??0)} / 제외 ${esc(e.excluded??0)}</div>`:''}`}))});
      const filters=field('상태',`<select class="input" name="activity-status"><option value="all">전체</option>${Object.entries(activityStatuses).map(([key,[label]])=>`<option value="${key}">${label}</option>`).join('')}</select>`)+field('시작일','<input class="input" type="date" name="activity-from">')+field('종료일','<input class="input" type="date" name="activity-to">');
      const dialog=openDialog({title:element.querySelector('h3').textContent+' · 전체 이력',content:`<div class="toolbar activity-dialog-toolbar"><input class="input" type="search" name="activity-search" placeholder="내용·대상 검색" aria-label="전체 이력 검색">${filterPopover('이력 조회 조건',filters)}</div><p class="caption">가상 데이터 · 대상과 밝기는 각 활동 내용에 표시됩니다.</p><div class="activity-dialog-grid">${grid(entries)}</div>`});
      const update=()=>{const items=filterActivityEntries(entries,{query:dialog.querySelector('[name="activity-search"]').value,status:dialog.querySelector('[name="activity-status"]').value,from:dialog.querySelector('[name="activity-from"]').value,to:dialog.querySelector('[name="activity-to"]').value});const host=dialog.querySelector('.activity-dialog-grid');host.innerHTML=grid(items);mountCommon(host);};
      dialog.querySelectorAll('[name^="activity-"]').forEach(input=>input.addEventListener('input',update));
    };
  });
}
export const filterPopover = (title, content) => `<details class="filter-popover"><summary class="btn" aria-label="${esc(title)}">${icon('filter')}<span>필터</span></summary><div class="popover-content"><div class="row"><h3 class="section-title">${esc(title)}</h3><button type="button" class="btn btn-ghost" data-popover-close aria-label="${esc(title)} 닫기">닫기</button></div>${content}</div></details>`;
export const validBrightness = value => String(value).trim() !== '' && /^\d+$/.test(String(value)) && Number(value) >= 0 && Number(value) <= 100;
export function selectLights(ids, { interactive = false } = {}) { return [...new Set(ids)].filter(id => store.lights.some(l => l.id === id && l.floor === store.floor && (!interactive || l.status !== 'offline'))); }
export function screenToSvg(x, y, rect) {
  const scale = Math.min(rect.width / 1000, rect.height / 620);
  const offsetX = (rect.width - 1000 * scale) / 2, offsetY = (rect.height - 620 * scale) / 2;
  return { x: (x - rect.left - offsetX) / scale, y: (y - rect.top - offsetY) / scale };
}
export function screenToMap(x, y, rect, camera = store) { const point = screenToSvg(x, y, rect); return { x: (point.x - camera.panX) / camera.zoom, y: (point.y - camera.panY) / camera.zoom }; }
function parkingPlan() {
  const bays = Array.from({ length: 12 }, (_, i) => `<path d="M${75 + i * 72} 70v115M${75 + i * 72} 435v115"/><text x="${105 + i * 72}" y="100">${String(i + 1).padStart(2, '0')}</text><text x="${105 + i * 72}" y="530">${String(i + 13).padStart(2, '0')}</text>`).join('');
  return `<rect class="map-floor" x="30" y="30" width="940" height="560" rx="6"/><g class="plan-lines"><path d="M55 55h890v510H55zM55 185h890M55 435h890M55 285h350v50H55M595 285h350v50H595"/>${bays}<rect x="425" y="245" width="150" height="130" rx="6"/><path d="M425 280h150M500 245v130M442 299h40m-40 10h40m-40 10h40m-40 10h40m-40 10h40"/></g><g class="plan-labels"><text x="500" y="65" text-anchor="middle">${esc(store.floor)} · 주차장 / PARKING</text><text x="535" y="320" text-anchor="middle">EV</text><text x="463" y="365" text-anchor="middle">계단</text><text x="180" y="260">서쪽 주차구역</text><text x="725" y="260">동쪽 주차구역</text><path d="M145 365h180m-15-10 15 10-15 10M850 220H670m15-10-15 10 15 10"/></g><g class="map-pillars">${[95,315,685,905].map(x => [200,415].map(y => `<rect x="${x}" y="${y}" width="14" height="14" rx="2"/>`).join('')).join('')}</g>`;
}
export function mapWorkspace({ interactive = false, editable = false } = {}) {
  const lights = store.lights.filter(l => !l.unplaced && l.floor === store.floor && (!store.query || `${l.name} ${l.id}`.toLocaleLowerCase().includes(store.query.toLocaleLowerCase())) && (store.statusFilter === 'all' || l.status === store.statusFilter));
  return `<div class="map-workspace" data-map-interactive="${interactive}" data-map-editable="${editable}"><div class="map-canvas"><svg class="floor-svg" viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet" role="group" aria-label="${esc(store.floor)} 조명 도면"><g class="camera-layer" transform="translate(${store.panX} ${store.panY}) scale(${store.zoom})">${parkingPlan()}${lights.map(l => `<g class="light-marker ${l.status} ${store.selected.includes(l.id) ? 'is-selected' : ''}" data-light="${esc(l.id)}" transform="translate(${l.x} ${l.y})" tabindex="${interactive && l.status === 'offline' ? '-1' : '0'}" role="button" aria-label="${esc(l.name)} ${l.status === 'offline' ? '오프라인' : l.status === 'warning' ? '점검 필요' : '정상'}${store.selected.includes(l.id) ? ' 선택됨' : ''}"><circle class="marker-hit" r="24"/><circle class="marker-glow" r="19"/><circle class="marker-dot" r="9"/><path class="marker-check" d="m-4 0 3 3 6-6"/><text y="35" text-anchor="middle">${esc(l.id.split('-')[1])}</text></g>`).join('')}</g><rect class="area-selection" x="0" y="0" width="0" height="0" visibility="hidden"/></svg></div><div class="map-footer"><div class="map-legend"><span><i class="dot normal"></i>정상</span><span><i class="dot warning"></i>점검 필요</span><span><i class="dot offline"></i>오프라인</span></div><div class="toolbar">${button('', { action: 'map-minus', icon: 'minus', attrs: 'aria-label="지도 축소"' })}<span class="zoom-value">${Math.round(store.zoom * 100)}%</span>${button('', { action: 'map-plus', icon: 'plus', attrs: 'aria-label="지도 확대"' })}${button('맞춤', { action: 'map-fit', icon: 'expand' })}</div></div></div>`;
}
export function mountMap(root, { onSelectionChange = () => {}, editable = false } = {}) {
  root.querySelectorAll('.map-workspace').forEach(workspace => {
    const svg = workspace.querySelector('svg.floor-svg'); const layer = workspace.querySelector('.camera-layer');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.querySelectorAll('.light-marker.warning, .light-marker.offline').forEach(marker => { const symbol = document.createElementNS('http://www.w3.org/2000/svg','text'); symbol.setAttribute('class','marker-symbol'); symbol.setAttribute('text-anchor','middle'); symbol.setAttribute('y','4'); symbol.textContent = marker.classList.contains('offline') ? '×' : '!'; marker.append(symbol); });
    const interactive = workspace.dataset.mapInteractive === 'true'; let drag = null;
    const camera = () => { layer.setAttribute('transform', `translate(${store.panX} ${store.panY}) scale(${store.zoom})`); workspace.querySelector('.zoom-value').textContent = `${Math.round(store.zoom * 100)}%`; };
    const change = ids => { store.selected = selectLights(ids, { interactive }); onSelectionChange(store.selected); };
    const zoom = (factor, clientX, clientY) => {
      const rect = svg.getBoundingClientRect(); const px = clientX ?? rect.left + rect.width / 2, py = clientY ?? rect.top + rect.height / 2;
      const point = screenToMap(px, py, rect); const next = Math.min(3.5, Math.max(.65, store.zoom * factor));
      const viewportPoint = screenToSvg(px, py, rect);
      store.panX = viewportPoint.x - point.x * next; store.panY = viewportPoint.y - point.y * next; store.zoom = next; camera();
    };
    svg.addEventListener('wheel', e => { if (!e.ctrlKey && Math.abs(e.deltaY) < 2) return; e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY); }, { passive: false });
    workspace.querySelector('[data-action="map-plus"]').onclick = () => zoom(1.2);
    workspace.querySelector('[data-action="map-minus"]').onclick = () => zoom(1 / 1.2);
    workspace.querySelector('[data-action="map-fit"]').onclick = () => { store.zoom = 1; store.panX = 0; store.panY = 0; camera(); };
    svg.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch' && store.tool === 'select') return; // 선택 도구에서는 페이지 스크롤을 유지하고 명시적 이동·영역 도구만 터치를 capture한다.
      const rect = svg.getBoundingClientRect(); drag = { x: e.clientX, y: e.clientY, point: screenToMap(e.clientX, e.clientY, rect), panX: store.panX, panY: store.panY, moved: false, marker: e.target.closest('[data-light]')?.dataset.light };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', e => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 7) drag.moved = true;
      if (!drag.moved) return;
      const rect = svg.getBoundingClientRect();
      if (store.tool === 'move') { const scale = Math.min(rect.width / 1000, rect.height / 620); store.panX = drag.panX + dx / scale; store.panY = drag.panY + dy / scale; camera(); }
      else if (store.tool === 'area') { const selection = workspace.querySelector('.area-selection'); const start = screenToSvg(drag.x, drag.y, rect), end = screenToSvg(e.clientX, e.clientY, rect); for (const [key, value] of Object.entries({ x: Math.min(start.x,end.x), y: Math.min(start.y,end.y), width: Math.abs(end.x-start.x), height: Math.abs(end.y-start.y), visibility: 'visible' })) selection.setAttribute(key, value); }
    });
    svg.addEventListener('pointerup', e => {
      const current = drag; drag = null; workspace.querySelector('.area-selection').setAttribute('visibility', 'hidden');
      if (!current || !current.moved) return;
      if (store.tool === 'area') { const point = screenToMap(e.clientX, e.clientY, svg.getBoundingClientRect()); const ids = store.lights.filter(l => l.floor === store.floor && l.x >= Math.min(point.x, current.point.x) && l.x <= Math.max(point.x, current.point.x) && l.y >= Math.min(point.y, current.point.y) && l.y <= Math.max(point.y, current.point.y)).map(l => l.id); change([...store.selected, ...ids]); }
      else if (editable && current.marker && store.tool === 'select') { const point = screenToMap(e.clientX, e.clientY, svg.getBoundingClientRect()); const light = store.lights.find(l => l.id === current.marker); light.x = Math.max(55, Math.min(945, point.x)); light.y = Math.max(55, Math.min(565, point.y)); onSelectionChange(store.selected); }
      svg.dataset.ignoreClick = 'true'; setTimeout(() => { delete svg.dataset.ignoreClick; }, 0);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) svg.addEventListener(type, () => { drag = null; workspace.querySelector('.area-selection').setAttribute('visibility', 'hidden'); });
    const toggle = id => { if (interactive && store.lights.find(l => l.id === id)?.status === 'offline') return toast('오프라인 조명은 선택할 수 없습니다.', 'warning'); change(interactive ? store.selected.includes(id) ? store.selected.filter(x => x !== id) : [...store.selected, id] : [id]); };
    svg.addEventListener('click', e => {
      if (svg.dataset.ignoreClick || store.tool === 'move') return;
      // SVG 좌표 반경은 축소 시 CSS 터치 영역을 보장하지 않으므로 현재 화면의 중심에서 24px까지 별도로 선택한다. 장애 중심을 정상 이웃으로 우회하지 않는다.
      const candidates = [...svg.querySelectorAll('[data-light]')].map(marker => { const r = marker.querySelector('.marker-dot').getBoundingClientRect(); return { marker, distance: Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) }; }).filter(x => x.distance <= 24).sort((a,b) => a.distance - b.distance || a.marker.dataset.light.localeCompare(b.marker.dataset.light));
      const marker = candidates[0]?.marker || e.target.closest('[data-light]'); if (marker) toggle(marker.dataset.light);
    });
    svg.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.light) { e.preventDefault(); toggle(e.target.dataset.light); } if (e.key === 'Escape') { drag = null; workspace.querySelector('.area-selection').setAttribute('visibility', 'hidden'); } });
    svg.style.touchAction = store.tool === 'select' ? 'pan-y' : 'none';
  });
}
let dialogReturnFocus;
export function openDialog({ title, content, onSubmit, submitLabel = '저장' }) {
  closeDialog(); dialogReturnFocus = document.activeElement;
  const dialog = document.createElement('dialog'); dialog.className = 'atlas-dialog'; dialog.innerHTML = `<form><div class="row"><h2>${esc(title)}</h2>${button('닫기', { action: 'dialog-close', variant: 'ghost', attrs: 'aria-label="대화상자 닫기"' })}</div><div class="dialog-body">${content}</div><div class="dialog-footer">${button('취소', { action: 'dialog-close' })}${onSubmit ? `<button class="btn btn-primary" type="submit">${esc(submitLabel)}</button>` : ''}</div></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelectorAll('[data-action="dialog-close"]').forEach(b => b.onclick = closeDialog);
  dialog.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); });
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(); } });
  dialog.querySelector('form').addEventListener('submit', e => { e.preventDefault(); onSubmit?.(new FormData(e.target), dialog); });
  mountCommon(dialog); return dialog;
}
export function closeDialog() { const existing = typeof document !== 'undefined' && document.querySelector('.atlas-dialog'); if (existing) { existing.close(); existing.remove(); dialogReturnFocus?.isConnected && dialogReturnFocus.focus({ preventScroll: true }); } }
export function toast(message, tone = 'success') { if (typeof document === 'undefined') return; document.querySelector('.atlas-toast')?.remove(); const item = document.createElement('div'); item.className = `atlas-toast tone-${tone}`; item.setAttribute('role', 'status'); item.textContent = message; document.body.append(item); setTimeout(() => item.remove(), 4000); }
export function mountCommon(root) {
  cleanupCommon(); mountActivity(root);
  root.querySelectorAll('.filter-popover').forEach(d => { const close = () => { d.open = false; d.querySelector('summary').focus({preventScroll:true}); }; d.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }); d.querySelector('[data-popover-close]').onclick = close; });
  root.querySelectorAll('.grid-host').forEach(host => {
    let direction = 1, last = -1;
    const sort = (index, explicitDirection) => { direction = explicitDirection ?? (last === index ? -direction : 1); last = index; const tbody = host.querySelector('tbody'); const rows = [...tbody.rows]; rows.sort((a,b) => a.cells[index]?.textContent.localeCompare(b.cells[index]?.textContent, 'ko', { numeric: true }) * direction); rows.forEach(r => tbody.append(r)); const cards = [...host.querySelectorAll('.mobile-row')]; cards.sort((a,b) => a.children[index]?.textContent.localeCompare(b.children[index]?.textContent, 'ko', { numeric: true }) * direction); cards.forEach(c => host.querySelector('.mobile-grid').append(c)); host.querySelectorAll('th').forEach((th,i) => { if(i === index) th.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort'); }); host.querySelector('[data-mobile-sort]').value = String(index); host.querySelector('[data-mobile-sort-direction]').textContent = direction === 1 ? '오름차순 ↑' : '내림차순 ↓'; };
    host.querySelectorAll('[data-grid-sort]').forEach(b => b.onclick = () => sort(Number(b.dataset.gridSort)));
    const select = host.querySelector('[data-mobile-sort]'); if (select) select.onchange = () => sort(Number(select.value), direction);
    host.querySelector('[data-mobile-sort-apply]').onclick = () => sort(Number(select.value), direction);
    host.querySelector('[data-mobile-sort-direction]').onclick = () => sort(Number(select.value), -direction);
  });
}
export function downloadText(filename, text, mime = 'text/csv') { const blob = new Blob([text], { type: mime }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
