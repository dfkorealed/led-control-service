import { store, icon, esc, button, filterPopover, badge, mountCommon, cleanupCommon, toast, closeDialog } from './atlas-ui.js';
import { renderOperations, bindOperations } from './atlas-operations.js';
import { renderInsights, bindInsights } from './atlas-insights.js';

const operations = ['monitoring','logs','manual','schedules','events','zones'];
const insights = ['overview','analysis','reports','settings','site','users','registration','maps','security','editor','login','setup','operator'];
const navigation = [{route:'monitoring',label:'모니터링',icon:'monitor',routes:['monitoring','logs']},{route:'manual',label:'제어',icon:'sliders',routes:['manual','schedules','events','zones']},{route:'overview',label:'통계',icon:'chart',routes:['overview','analysis','reports']},{route:'settings',label:'설정',icon:'settings',routes:['settings','site','users','registration','maps','security','editor']}];
const initial = JSON.parse(JSON.stringify(store));
let alarmsRead = false, alarmsCleared = false;
let sidebarCollapsed=false;
try { store.theme = localStorage.getItem('kinda-atlas-visual-review-theme') === 'dark' ? 'dark' : 'light'; } catch { /* 저장소 접근 불가 시 메모리 테마로 유지한다. 제품 인증 저장소와 무관하다. */ }

export function navigate(route) { if (location.hash === `#${route}`) render(); else location.hash = route; }
function links(route, mobile = false) { return navigation.map(n => `<a class="${mobile ? '' : 'nav-link'} ${n.routes.includes(route) ? 'active' : ''}" href="#${n.route}" aria-label="${n.label}" title="${n.label}" ${n.routes.includes(route) ? 'aria-current="page"' : ''}>${icon(n.icon)}<span>${n.label}</span></a>`).join(''); }
export function sidebarMarkup(route,collapsed=sidebarCollapsed) {
  const label=collapsed?'메뉴 펼치기':'메뉴 접기';
  return `<aside class="sidebar ${collapsed?'is-collapsed':''}"><div class="sidebar-heading"><a href="#monitoring" class="brand" aria-label="킨다 모니터링" title="킨다"><img src="/files/kinda-mark${store.theme==='dark'?'-reversed':''}.svg" alt="" width="32" height="32"><span>킨다</span></a>${button('',{action:'sidebar-toggle',icon:'chevron',variant:'ghost',attrs:`aria-label="${label}" title="${label}" aria-expanded="${!collapsed}"`})}</div><nav aria-label="주 메뉴">${links(route)}</nav><div class="sidebar-footer">${button('예시 초기화',{action:'reset',icon:'refresh',variant:'ghost',attrs:'aria-label="예시 초기화" title="예시 초기화"'})}<span class="caption">ATLAS · 디자인 목업</span></div></aside>`;
}
function summary() { const items = store.lights; return `<div class="site-summary" aria-label="현장 전체 조명 집계"><div class="summary-item"><strong>${items.length}<small> 대</small></strong><span>현장 전체</span></div><div class="summary-item tone-success"><strong>${items.filter(x=>x.status==='normal').length}</strong><span>정상</span></div><div class="summary-item tone-warning"><strong>${items.filter(x=>x.status==='warning').length}</strong><span>점검 필요</span></div><div class="summary-item"><strong>${items.filter(x=>x.status==='offline').length}</strong><span>오프라인</span></div></div>`; }
function alarms() { return filterPopover('현장 알람 · 가상 알림', `<div class="alarm-list">${alarmsCleared ? '<p class="muted">표시할 알림이 없습니다.</p>' : `<div class="alarm-item">${badge(alarmsRead ? '읽음' : '미읽음','warning')}<p>B1 조명 06 · 연결 확인 필요</p><small class="muted">읽음 처리는 장애 해결과 별개입니다.</small></div><div class="alarm-item">${badge('점검 필요','warning')}<p>B1 조명 10 · 상태 점검 권장</p></div>`}${button('모두 읽음', { action:'alarm-read',icon:'check' })}${button('내 목록에서 지우기', { action:'alarm-clear',icon:'trash' })}</div>`).replace('aria-label="현장 알람 · 가상 알림"','aria-label="알람 센터"').replace(`${icon('filter')}<span>필터</span>`,`${icon('bell')}<span>${alarmsRead || alarmsCleared ? '알람' : '알람 2'}</span>`); }
export function render() {
  const route = location.hash.slice(1).split('?')[0] || 'monitoring'; document.documentElement.dataset.theme = store.theme;
  const root = document.getElementById('atlas-app'); if (!root) return;
  document.documentElement.dataset.sidebar=sidebarCollapsed?'collapsed':'expanded';
  cleanupCommon(root);
  const content = operations.includes(route) ? renderOperations(route) : insights.includes(route) ? renderInsights(route) : '';
  root.innerHTML = `${sidebarMarkup(route)}<div class="shell-main"><header class="shell-header"><div class="toolbar"><select class="input" id="shell-site" aria-label="현장 선택"><option>${esc(store.site)}</option></select>${badge('예시 현장','neutral')}</div>${summary()}<div class="toolbar">${alarms()}${button('',{action:'theme',icon:store.theme==='light'?'moon':'sun',attrs:'aria-label="테마 전환"'})}${button('내 계정',{action:'security',icon:'users',variant:'ghost'})}</div></header><div class="prototype-strip"><span><strong>UI 목업</strong> · 가상 데이터 · 실제 장비 미연동 · 제품 변경 없음</span><div class="scenario-toolbar"><label for="shell-scenario">결과 시나리오</label><select id="shell-scenario" class="input"><option value="success" ${store.scenario==='success'?'selected':''}>성공</option><option value="partial" ${store.scenario==='partial'?'selected':''}>일부 성공</option><option value="failure" ${store.scenario==='failure'?'selected':''}>실패</option><option value="offline" ${store.scenario==='offline'?'selected':''}>오프라인</option></select><select id="example-flow" class="input" aria-label="예시 흐름"><option value="">예시 흐름</option><option value="login">로그인</option><option value="setup">초기 설치</option><option value="operator">운영자</option></select>${button('초기화',{action:'reset',icon:'refresh',variant:'ghost',attrs:'aria-label="예시 초기화" title="예시 초기화"'})}</div></div><main class="shell-content" id="page-content">${content || '<section class="panel empty-state"><h1>화면을 찾지 못했습니다.</h1><a class="btn" href="#monitoring">모니터링으로 이동</a></section>'}</main></div><nav class="bottom-nav" aria-label="모바일 주 메뉴">${links(route,true)}</nav>`;
  mountCommon(root);
  root.querySelector('[data-action="sidebar-toggle"]').onclick=()=>{sidebarCollapsed=!sidebarCollapsed;render();root.querySelector('[data-action="sidebar-toggle"]').focus({preventScroll:true});};
  root.querySelector('[data-action="theme"]').onclick = () => { store.theme = store.theme==='light'?'dark':'light'; try { localStorage.setItem('kinda-atlas-visual-review-theme',store.theme); } catch { /* 비공개 모드에서도 목업 사용을 계속한다. */ } render(); };
  root.querySelectorAll('[data-action="security"]').forEach(x => x.onclick=()=>navigate('security'));
  root.querySelectorAll('[data-action="reset"]').forEach(x => x.onclick=()=>{ const theme = store.theme; Object.assign(store,JSON.parse(JSON.stringify(initial)),{theme}); alarmsRead=false;alarmsCleared=false;closeDialog();navigate('monitoring');toast('가상 예시를 초기화했습니다.'); });
  root.querySelector('[data-action="alarm-read"]').onclick=()=>{alarmsRead=true;render();toast('가상 알림을 읽음으로 표시했습니다.');};
  root.querySelector('[data-action="alarm-clear"]').onclick=()=>{alarmsCleared=true;render();toast('가상 알림을 내 목록에서 지웠습니다. 장애 상태는 유지됩니다.');};
  root.querySelector('#shell-scenario').onchange=e=>{store.scenario=e.target.value;render();toast('다음 명시적 실행에 적용할 가상 시나리오입니다.','neutral');};
  root.querySelector('#example-flow').onchange=e=>{if(e.target.value)navigate(e.target.value);};
  const page = root.querySelector('#page-content');
  page.querySelectorAll('[data-action="logs"]').forEach(x => x.onclick=()=>navigate('logs'));
  if (operations.includes(route)) bindOperations(page,{render,navigate}); else if (insights.includes(route)) bindInsights(page,{render,navigate});
}
if(typeof window!=='undefined') {
  window.addEventListener('hashchange',()=>{store.query='';store.statusFilter='all';render();});
  window.addEventListener('click',e=>{
    // 선택 callback이 화면을 교체한 경우 이전 DOM의 클릭은 새 상세 창의 바깥 클릭이 아니다.
    if (!e.target?.isConnected) return;
    document.querySelectorAll('.filter-popover[open]').forEach(d=>{if(!d.contains(e.target))d.open=false;});
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const popovers = [...document.querySelectorAll('.filter-popover[open]')];
    popovers.forEach(d=>{d.open=false;});
    if (popovers.length) popovers.at(-1).querySelector('summary')?.focus({preventScroll:true});
  });
  render();
}
