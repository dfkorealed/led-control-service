import {store,esc,icon,badge,button,field,dataGrid,activityLog,filterPopover,mapWorkspace,mountMap,openDialog,closeDialog,toast} from './atlas-ui.js';

export const clampBrightness = value => Math.min(100, Math.max(0, Number(value) || 0));
export const canApply = ({selected=[],pending=false,offline=false,readonly=false}={}) => selected.length > 0 && !pending && !offline && !readonly;
export const liveOperationsRoot=root=>root.ownerDocument?.getElementById('page-content') || root;
export function formatUpdatedAt(date) {
  const pad=value=>String(value).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function commandActivity(result,{site,floor}) {
  return {date:result.date,time:result.time,status:result.status,target:`${site} · ${floor}`,brightness:result.brightness,success:result.success,failed:result.failed,excluded:result.excluded,label:`수동 제어 · ${floor} · 밝기 ${result.brightness}% · 성공 ${result.success} / 실패 ${result.failed} · 제외 ${result.excluded}`};
}
export function partitionTargets(ids,lights) {
  const selected=lights.filter(light=>ids.includes(light.id));
  return {eligible:selected.filter(light=>light.status!=='offline').map(light=>light.id),excluded:selected.filter(light=>light.status==='offline').map(light=>light.id)};
}
export function commandSummary(scenario, count) {
  const failed = scenario === 'failure' ? count : scenario === 'partial' ? Math.ceil(count / 3) : 0;
  return {success:count-failed,failed,status:failed === 0 ? 'success' : failed === count ? 'failure' : 'partial'};
}
export function validateRule(rule) {
  const errors = [];
  if (!rule.name?.trim()) errors.push('이름을 입력해 주세요.');
  if (!Number.isFinite(Number(rule.brightness)) || Number(rule.brightness) < 0 || Number(rule.brightness) > 100) errors.push('밝기는 0~100%로 입력해 주세요.');
  return {ok:errors.length === 0,errors};
}

// All dates, rules and command acknowledgements are fictional design fixtures.
// State lives only in this document; no device, server or browser storage is used.
const state = {
  route:'monitoring',target:'individual',pending:false,readonly:false,results:[],updatedAt:formatUpdatedAt(new Date()),
  logSearch:'',logStatus:'all',logDate:'2026-10-06',logCount:10,logPage:1,sortDesc:true,
  ruleSearch:'',ruleEnabled:'all',ruleSync:'all',ruleLimit:10,
  rules:[
    {id:'s-1',kind:'schedules',name:'업무 시작',when:'평일 08:30',enabled:true,sync:'synced',brightness:80,target:['B1-001','B1-002'],start:'2026-10-01',end:'2026-12-31',time:'08:30',repeat:'평일'},
    {id:'s-2',kind:'schedules',name:'야간 절전',when:'매일 22:00',enabled:true,sync:'pending',brightness:20,target:['B1-003'],start:'2026-10-01',end:'2026-12-31',time:'22:00',repeat:'매일'},
    {id:'s-3',kind:'schedules',name:'주말 점검',when:'주말 10:00',enabled:false,sync:'synced',brightness:70,target:['B1-001'],start:'2026-10-01',end:'2026-12-31',time:'10:00',repeat:'주말'},
    {id:'e-1',kind:'events',name:'복도 움직임 감지',when:'움직임 감지 · 60초 유지',enabled:true,sync:'synced',brightness:90,target:['B1-001'],sensor:'움직임 센서 A',hold:60},
    {id:'e-2',kind:'events',name:'주차장 조도 보완',when:'조도 100lx 미만 · 120초 유지',enabled:true,sync:'failed',brightness:75,target:['B1-002'],sensor:'조도 센서 B',hold:120},
  ],
  zones:[{id:'z-1',name:'주차 구역 A',floor:'B1',targets:['B1-001','B1-002'],sync:'synced'},{id:'z-2',name:'공용 복도',floor:'1F',targets:['1F-001','1F-002'],sync:'pending'}],
};
// Older fixture rows make pagination reviewable while compact shared logs keep three rows.
store.activity.push(...[
  ['20:40:02','B1 서쪽 주차구역 · 수동 밝기 30%','success'],
  ['20:10:38','1F 조명 03 · 연결 상태 확인','success'],
  ['19:25:15','복도 움직임 감지 · 가상 규칙 실행','success'],
  ['18:33:04','B1 동쪽 주차구역 · 수동 밝기 70%','partial'],
  ['18:20:41','공용 복도 · 가상 그룹 동기화','success'],
  ['17:45:20','야간 절전 · 스케줄 변경','pending'],
  ['16:38:07','주차장 조도 보완 · 가상 규칙 실행','failure'],
  ['15:02:11','1F 전체 조명 · 수동 밝기 80%','success'],
  ['14:15:30','주차 구역 A · 가상 그룹 생성','success'],
].map(([time,label,status])=>({date:'2026-10-06',time,label,status})));
const labels={normal:'정상',warning:'주의',offline:'오프라인',success:'완료',partial:'부분 완료',failure:'실패',pending:'대기',synced:'동기화 완료',failed:'동기화 실패'};
const tone = status => ({normal:'success',warning:'warning',offline:'neutral',success:'success',partial:'warning',failure:'danger',pending:'warning',synced:'success',failed:'danger'}[status] || 'neutral');
const b=(text,action,options={})=>button(text,{...options,attrs:`data-ops="${action}" ${options.attrs || ''}`});
const input=(name,value='',extra='')=>`<input class="input" name="${name}" value="${esc(value)}" ${extra}>`;
const select=(name,options,current,extra='')=>`<select class="input" name="${name}" ${extra}>${options.map(([value,label])=>`<option value="${value}" ${String(current) === String(value) ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
const floorLights=()=>store.lights.filter(light=>light.floor===store.floor);
const selectedLights=()=>store.lights.filter(light=>store.selected.includes(light.id));
const commandTargets=()=>partitionTargets(store.selected,store.lights);
const tabs=(route)=>`<nav class="tabs ops-tabs" aria-label="제어 방식">${[['manual','수동 제어'],['schedules','스케줄'],['events','이벤트'],['zones','그룹·구역']].map(([id,label])=>b(label,`navigate:${id}`,{variant:route===id?'primary':'ghost'})).join('')}</nav>`;
const header=(title,description,action='')=>`<div class="page-head"><div><div class="caption ops-eyebrow">ATLAS / OPERATIONS</div><h1>${title}</h1>${description?`<p class="muted">${description}</p>`:''}</div>${action}</div>`;
const demoNote=()=>`<div class="ops-demo-note">${icon('alert',16)}<span>디자인 검토용 가상 데이터 · 실제 조명에 명령을 보내지 않습니다.</span></div>`;
const floors=()=>select('floor',[['B1','B1 · 지하 주차장'],['1F','1F · 업무 공간']],store.floor,'data-ops-change="floor" aria-label="도면 선택"');
const namedPopover=(title,content)=>filterPopover(title,content).replace('<span>필터</span>',`<span>${esc(title)}</span>`);
function statusLegend() {
  const lights=floorLights();
  const counts=[{key:'total',label:'전체',count:lights.length},...['normal','warning','offline'].map(key=>({key,label:labels[key],count:lights.filter(light=>light.status===key).length}))];
  return `<div class="ops-map-status" aria-label="현재 도면 상태">${counts.map(item=>`<div class="ops-status-item"><span class="ops-status-label"><i class="ops-dot ops-dot-${item.key}"></i>${item.label}</span><strong>${item.count}</strong></div>`).join('')}</div>`;
}
function mapPanel(interactive=false) {
  return `<section class="panel ops-map-panel"><div class="ops-map-head">${interactive?tools():`<span class="section-title">${store.floor} 도면</span>`}${statusLegend()}</div>${mapWorkspace({interactive})}</section>`;
}
function lightList() {
  return `<div class="ops-light-list">${floorLights().map(light=>`<button type="button" class="ops-light-row" data-ops="select-light:${esc(light.id)}"><span>${esc(light.name)}<small>${esc(light.id)} · ${esc(light.group)}</small></span>${badge(labels[light.status],tone(light.status))}</button>`).join('')}</div>`;
}
function selectedDetails() {
  const lights=selectedLights();
  return `<div class="ops-selection-details"><p class="section-title">선택 조명 ${lights.length}개</p>${lights.length?lights.map(light=>`<div class="ops-detail-row"><strong>${esc(light.name)}</strong>${badge(labels[light.status],tone(light.status))}<span class="caption">${esc(light.id)} · ${esc(light.group)} · 최근 응답 ${esc(light.lastSeen || '10:42')}</span></div>`).join(''):`<p class="muted">도면에서 조명을 선택하면 상태와 최근 응답을 보여줍니다.</p>`}</div>`;
}
function renderMonitoring() {
  const details=`${field('조명 검색',input('map-query',store.query,'placeholder="이름 또는 ID 검색" data-ops-input="map-query"'))}${field('조명 상태',select('map-status',[['all','전체'],['normal','정상'],['warning','주의'],['offline','오프라인']],store.statusFilter,'data-ops-change="map-status"'))}${selectedDetails()}`;
  return `${header('모니터링','',`<div class="ops-refresh"><span class="ops-updated">마지막 갱신 <time datetime="${state.updatedAt.replace(' ','T')}">${state.updatedAt}</time></span>${b('새로고침','refresh',{icon:'refresh'})}</div>`)}<div class="toolbar ops-map-toolbar">${floors()}${namedPopover('조명 검색·상세',details)}<div class="ops-toolbar-end">${namedPopover('조명 목록',lightList())}</div></div>${mapPanel(false)}${activityLog(store.activity,{title:'최근 활동',max:3,allAction:'logs'})}${demoNote()}`;
}
function renderLogs() {
  const filters=`${field('조회 날짜',input('log-date',state.logDate,'type="date" data-ops-change="log-date"'))}${field('결과 상태',select('log-status',[['all','전체'],['success','완료'],['partial','부분 완료'],['failure','실패'],['pending','대기']],state.logStatus,'data-ops-change="log-status"'))}${field('페이지당 개수',select('log-count',[[10,'10개'],[20,'20개'],[50,'50개']],state.logCount,'data-ops-change="log-count"'))}`;
  const filtered=store.activity.filter(entry=>(!state.logDate||(entry.date || '2026-10-06')===state.logDate)&&(state.logStatus==='all'||entry.status===state.logStatus)&&entry.label.toLowerCase().includes(state.logSearch.toLowerCase()));
  const rows=(state.sortDesc?filtered:[...filtered].reverse()).slice((state.logPage-1)*state.logCount,state.logPage*state.logCount).map((entry,index)=>({time:esc(entry.time),label:esc(entry.label),target:esc(entry.target || `${store.site} · ${index%2?'1F':'B1'}`),actor:esc(entry.actor || '김운영'),status:badge(labels[entry.status] || entry.status,tone(entry.status))}));
  return `${header('활동 로그','조회와 제어 이력을 같은 형식으로 확인합니다.')}<div class="toolbar">${input('log-search',state.logSearch,'data-ops-input="log-search" placeholder="활동 내용 검색" aria-label="활동 검색"')}${filterPopover('조회 조건',filters)}${b(`시간순 ${state.sortDesc?'↓':'↑'}`,'sort-log',{variant:'ghost'})}</div><section class="panel ops-log-panel">${dataGrid({columns:[{key:'time',label:'시간'},{key:'label',label:'활동'},{key:'target',label:'대상'},{key:'actor',label:'운영자'},{key:'status',label:'결과'}],rows,id:'ops-log-grid'})}${rows.length?'':`<div class="empty-state">조건에 맞는 활동이 없습니다.</div>`}<div class="ops-pagination"><span class="caption">${filtered.length}건 · ${state.logPage}페이지</span><div>${b('이전','log-prev',{disabled:state.logPage===1})}${b('다음','log-next',{disabled:state.logPage*state.logCount>=filtered.length})}</div></div></section>${demoNote()}`;
}
function tools() {
  return `<div class="ops-tools" role="group" aria-label="지도 선택 도구">${[['move','이동','move'],['select','개별 선택','select'],['area','영역 선택','area']].map(([id,label,ico])=>b(label,`tool:${id}`,{icon:ico,variant:store.tool===id?'primary':'secondary',attrs:`aria-pressed="${store.tool===id}"`})).join('')}</div>`;
}
function recentResult() {
  const result=state.results[0];
  if (!result) return '';
  return `<section class="panel ops-recent-result"><div class="ops-result-summary"><div><span class="section-title">최근 제어 결과</span><span class="caption">${result.time} · 밝기 ${result.brightness}% · ${result.count}개 명령 · 제외 ${result.excluded || 0}개</span></div>${badge(({success:'성공',partial:'일부 성공',failure:'실패'})[result.status],tone(result.status))}<strong>성공 ${result.success} · 실패 ${result.failed}</strong></div><details class="inline-details ops-result-details"><summary>조명별 결과 보기 ${icon('chevron',16)}</summary><div class="ops-result-scroll">${result.items.map(item=>`<div class="ops-result-line"><strong>${esc(item.name)}</strong><span>${esc(item.id)}</span>${badge(item.excluded?'오프라인 제외':item.ok?'응답 확인':'응답 실패',item.ok?'success':'danger')}<span class="caption">${item.excluded?'명령을 보내지 않은 가상 대상':item.ok?`가상 응답 밝기 ${result.brightness}%`:'가상 통신 시간 초과 · 재시도 필요'}</span></div>`).join('')}</div></details></section>`;
}
function renderManual() {
  const selected=selectedLights();
  const disabled=!canApply({selected:commandTargets().eligible,pending:state.pending,offline:store.scenario==='offline',readonly:state.readonly});
  const groupOptions=[...new Set(floorLights().map(light=>light.group))].map(group=>[group,group]);
  return `${header('조명 제어','')}${tabs('manual')}<div class="toolbar ops-map-toolbar">${floors()}<div class="ops-target-mode">${[['individual','개별'],['floor','현재 도면 전체'],['group','그룹']].map(([id,label])=>b(label,`target:${id}`,{variant:state.target===id?'primary':'secondary'})).join('')}</div>${state.target==='group'?select('control-group',groupOptions,'','data-ops-change="control-group" aria-label="제어 그룹"'):''}</div><div class="operation-layout ops-manual-layout"><div class="ops-map-column">${mapPanel(true)}</div><aside class="panel inspector ops-command-panel"><div class="ops-command-title"><span class="section-title">제어 대상</span>${b('선택 해제','clear-selection',{variant:'ghost'})}</div><div class="ops-selection-count"><strong>${store.selected.length}</strong><span>개 조명 선택</span></div><p class="caption ops-target-partition">제어 가능 ${commandTargets().eligible.length}개 · 오프라인 제외 ${commandTargets().excluded.length}개</p><div class="ops-selected-tags">${selected.length?selected.map(light=>`<span class="chip">${esc(light.name)}</span>`).join(''):'<span class="muted">도면에서 조명을 선택하세요.</span>'}</div><div class="ops-brightness"><label for="ops-brightness-range">밝기 <small class="muted">초안</small></label><div class="ops-brightness-number">${input('brightness-number',store.brightness,'id="ops-brightness-number" type="number" min="0" max="100" data-ops-input="brightness" aria-label="밝기 값"')}<span>%</span></div><input id="ops-brightness-range" type="range" min="0" max="100" value="${store.brightness}" data-ops-input="brightness" aria-label="밝기 조절"><div class="ops-brightness-presets">${[0,30,70,100].map(value=>b(`${value}%`,`brightness:${value}`,{variant:'ghost'})).join('')}</div></div>${b(state.pending?'적용 중…':`밝기 ${store.brightness}% 적용`,'apply',{variant:'primary',disabled,attrs:'id="ops-apply"'})}<details class="ops-demo-options"><summary>결과 시나리오</summary>${field('가상 명령 결과',select('scenario',[['success','성공'],['partial','부분 성공'],['failure','실패'],['offline','연결 안 됨']],store.scenario,'data-ops-change="scenario"'))}<label class="ops-check"><input type="checkbox" data-ops-change="readonly" ${state.readonly?'checked':''}> 읽기 전용으로 보기</label></details></aside></div>${recentResult()}${activityLog(store.activity,{title:'제어 이력',max:3,allAction:'logs'})}${demoNote()}`;
}
function rowActions(rule) {
  return `<div class="ops-rule-actions"><label class="ops-toggle"><input type="checkbox" aria-label="${esc(rule.name)} 활성" data-ops-toggle="${rule.id}" ${rule.enabled?'checked':''}><span></span></label><details class="ops-more"><summary aria-label="${esc(rule.name)} 더보기">${icon('more',20)}</summary><div class="ops-more-menu">${b('편집',`edit-rule:${rule.id}`,{icon:'edit',variant:'ghost'})}${b('삭제',`delete-rule:${rule.id}`,{icon:'trash',variant:'ghost'})}</div></details></div>`;
}
function renderRules(kind) {
  const schedule=kind==='schedules';
  const filters=`${field('활성 상태',select('rule-enabled',[['all','전체'],['true','활성'],['false','비활성']],state.ruleEnabled,'data-ops-change="rule-enabled"'))}${field('동기화 상태',select('rule-sync',[['all','전체'],['synced','동기화 완료'],['pending','대기'],['failed','실패']],state.ruleSync,'data-ops-change="rule-sync"'))}${field('표시 개수',select('rule-limit',[[10,'10개'],[20,'20개'],[50,'50개']],state.ruleLimit,'data-ops-change="rule-limit"'))}`;
  const rules=state.rules.filter(rule=>rule.kind===kind&&rule.name.includes(state.ruleSearch)&&(state.ruleEnabled==='all'||String(rule.enabled)===state.ruleEnabled)&&(state.ruleSync==='all'||rule.sync===state.ruleSync)).slice(0,state.ruleLimit);
  const rows=rules.map(rule=>({name:`<strong>${esc(rule.name)}</strong>`,when:esc(rule.when),target:`${rule.target.length}개 조명`,sync:badge(labels[rule.sync],tone(rule.sync)),actions:rowActions(rule)}));
  return `${header(schedule?'스케줄 제어':'이벤트 제어',schedule?'정해진 시간에 실행할 규칙을 관리합니다.':'센서 조건에 반응할 조명 규칙을 관리합니다.',b(schedule?'스케줄 만들기':'이벤트 만들기',`create-rule:${kind}`,{icon:'plus',variant:'primary'}))}${tabs(kind)}<div class="toolbar">${input('rule-search',state.ruleSearch,'data-ops-input="rule-search" placeholder="규칙 이름 검색" aria-label="규칙 검색"')}${filterPopover('조회 조건',filters)}</div><section class="panel ops-rules-panel">${dataGrid({columns:[{key:'name',label:'이름'},{key:'when',label:schedule?'실행 시간':'감지 조건'},{key:'target',label:'대상'},{key:'sync',label:'동기화'},{key:'actions',label:'활성 · 더보기'}],rows,id:`ops-${kind}-grid`})}${rows.length?'':`<div class="empty-state">조건에 맞는 규칙이 없습니다.</div>`}</section>${demoNote()}`;
}
function renderZones() {
  const rows=state.zones.map(zone=>({name:`<strong>${esc(zone.name)}</strong>`,floor:esc(zone.floor),target:`${zone.targets.length}개 조명`,sync:badge(labels[zone.sync],tone(zone.sync)),actions:`<div class="ops-zone-actions">${b('편집',`edit-zone:${zone.id}`,{variant:'ghost'})}${b('동기화',`sync-zone:${zone.id}`,{variant:'ghost'})}${b('삭제',`delete-zone:${zone.id}`,{variant:'ghost'})}</div>`}));
  return `${header('그룹·구역','반복 제어할 조명을 공간별로 묶어 관리합니다.',b('그룹 만들기','create-zone',{icon:'plus',variant:'primary'}))}${tabs('zones')}<section class="panel">${dataGrid({columns:[{key:'name',label:'이름'},{key:'floor',label:'도면'},{key:'target',label:'대상'},{key:'sync',label:'동기화'},{key:'actions',label:'작업'}],rows,id:'ops-zone-grid'})}</section>${demoNote()}`;
}
export function renderOperations(route) {
  state.route=route;
  if(route==='monitoring') return renderMonitoring();
  if(route==='logs') return renderLogs();
  if(route==='manual') return renderManual();
  if(route==='schedules'||route==='events') return renderRules(route);
  if(route==='zones') return renderZones();
  return '';
}

function ruleDialog(kind,existing,ctx) {
  const draft=existing || {name:'',brightness:70,start:'2026-10-06',end:'2026-12-31',time:'08:30',repeat:'평일',sensor:'움직임 센서 A',hold:60,target:[...store.selected]};
  const schedule=kind==='schedules';
  const candidates=store.lights;
  openDialog({title:`${schedule?'스케줄':'이벤트'} ${existing?'편집':'만들기'}`,submitLabel:existing?'변경 저장':'만들기',content:`<p class="caption">가상 규칙을 이 화면에만 저장합니다.</p><div class="ops-form-error" role="alert"></div>${field('이름',input('name',draft.name,'required maxlength="40" placeholder="규칙 이름"'))}${schedule?`<div class="grid-2">${field('시작 날짜',input('start',draft.start,'type="date" required'))}${field('종료 날짜',input('end',draft.end,'type="date" required'))}</div><div class="grid-2">${field('실행 시간',input('time',draft.time,'type="time" required'))}${field('반복',select('repeat',[['매일','매일'],['평일','평일'],['주말','주말']],draft.repeat))}</div>`:`${field('센서',select('sensor',[['움직임 센서 A','움직임 센서 A'],['조도 센서 B','조도 센서 B']],draft.sensor))}${field('유지 시간 (초)',input('hold',draft.hold,'type="number" min="1" max="3600" required'))}`}${field('적용 밝기 (%)',input('brightness',draft.brightness,'type="number" min="0" max="100" required'))}<fieldset class="ops-target-fieldset"><legend>대상 조명</legend><p class="caption">현재 도면 선택을 가져오거나 아래에서 조명을 고르세요.</p><div class="ops-target-checks">${candidates.map(light=>`<label class="ops-check"><input type="checkbox" name="target" value="${esc(light.id)}" ${draft.target.includes(light.id)?'checked':''}><span>${esc(light.name)}<small>${esc(light.floor)} · ${esc(light.id)}</small></span></label>`).join('')}</div></fieldset>`,onSubmit:(form,dialog)=>{
    const rule={...draft,name:String(form.get('name')||'').trim(),brightness:Number(form.get('brightness')),target:form.getAll('target'),start:form.get('start'),end:form.get('end'),time:form.get('time'),repeat:form.get('repeat'),sensor:form.get('sensor'),hold:Number(form.get('hold'))};
    const validation=validateRule(rule);
    if(!rule.target.length) validation.errors.push('대상 조명을 하나 이상 선택해 주세요.');
    if(schedule&&rule.start>rule.end) validation.errors.push('종료 날짜는 시작 날짜 이후여야 합니다.');
    if(!schedule&&(rule.hold<1||rule.hold>3600)) validation.errors.push('유지 시간은 1~3600초로 입력해 주세요.');
    if(validation.errors.length){dialog.querySelector('.ops-form-error').textContent=validation.errors.join(' ');return false;}
    rule.when=schedule?`${rule.repeat} ${rule.time}`:`${rule.sensor==='움직임 센서 A'?'움직임 감지':'조도 100lx 미만'} · ${rule.hold}초 유지`;
    if(existing) Object.assign(existing,rule,{sync:'pending'});
    else state.rules.push({...rule,id:`${schedule?'s':'e'}-${Date.now()}`,kind,enabled:true,sync:'pending'});
    closeDialog();ctx.render();toast('가상 규칙을 저장했습니다.');return true;
  }});
}
function deleteDialog(title,onDelete,ctx) {
  openDialog({title:'삭제 확인',content:`<p><strong>${esc(title)}</strong>을 삭제할까요?</p><p class="caption">이 검토 화면의 가상 항목만 삭제합니다.</p>`,submitLabel:'삭제',onSubmit:()=>{onDelete();closeDialog();ctx.render();toast('가상 항목을 삭제했습니다.');return true;}});
}
function zoneDialog(existing,ctx) {
  const draft=existing || {name:'',floor:store.floor,targets:[...store.selected]};
  openDialog({title:`그룹 ${existing?'편집':'만들기'}`,content:`<div class="ops-form-error" role="alert"></div>${field('그룹 이름',input('name',draft.name,'required maxlength="40"'))}${field('도면',select('floor',[['B1','B1'],['1F','1F']],draft.floor))}<fieldset class="ops-target-fieldset"><legend>대상 조명</legend><div class="ops-target-checks">${store.lights.map(light=>`<label class="ops-check"><input name="target" type="checkbox" value="${esc(light.id)}" ${draft.targets.includes(light.id)?'checked':''}>${esc(light.name)} · ${esc(light.floor)}</label>`).join('')}</div></fieldset>`,onSubmit:(form,dialog)=>{
    const name=String(form.get('name')||'').trim();const targets=form.getAll('target');
    if(!name||!targets.length){dialog.querySelector('.ops-form-error').textContent='이름과 대상 조명을 입력해 주세요.';return false;}
    const zone={name,floor:form.get('floor'),targets,sync:'pending'};
    if(existing)Object.assign(existing,zone);else state.zones.push({...zone,id:`z-${Date.now()}`});
    closeDialog();ctx.render();toast('가상 그룹을 저장했습니다.');return true;
  }});
}
function applyCommand(ctx) {
  if(!canApply({selected:commandTargets().eligible,pending:state.pending,offline:store.scenario==='offline',readonly:state.readonly}))return;
  const targets=commandTargets();const lights=selectedLights().filter(light=>targets.eligible.includes(light.id)).map(light=>({...light}));const excluded=selectedLights().filter(light=>targets.excluded.includes(light.id));const brightness=store.brightness;const scenario=store.scenario;const commandLocation={site:store.site,floor:store.floor};
  state.pending=true;ctx.render();
  // Delay represents a fixture acknowledgement, never a network request.
  setTimeout(()=>{
    const summary=commandSummary(scenario,lights.length);
    const [date,time]=formatUpdatedAt(new Date()).split(' ');
    const result={...summary,date,time,brightness,count:lights.length,excluded:excluded.length,items:[...lights.map((light,index)=>({...light,ok:index<summary.success})),...excluded.map(light=>({...light,ok:false,excluded:true}))]};
    state.results.unshift(result);
    result.items.filter(item=>item.ok).forEach(item=>{const light=store.lights.find(light=>light.id===item.id);if(light)light.brightness=brightness;});
    store.activity.unshift(commandActivity(result,commandLocation));
    state.pending=false;ctx.render();toast(`가상 제어 ${labels[summary.status]} · 성공 ${summary.success} / 실패 ${summary.failed}`,tone(summary.status));
  },650);
}
export function bindOperations(root,ctx) {
  const render=ctx.render;
  // Shell rendering replaces #page-content; resolve its live node after each render.
  ctx={...ctx,render:()=>{
    const open=[...liveOperationsRoot(root).querySelectorAll('.filter-popover')].map(popover=>popover.open);
    render();
    liveOperationsRoot(root).querySelectorAll('.filter-popover').forEach((popover,index)=>{popover.open=Boolean(open[index]);});
  }};
  if(['monitoring','manual'].includes(state.route))mountMap(root,{onSelectionChange:()=>{
    ctx.render();
    if(state.route==='monitoring')liveOperationsRoot(root).querySelector('.filter-popover').open=true;
  }});
  root.querySelectorAll('[data-ops]').forEach(node=>node.addEventListener('click',()=>{
    const [action,value]=node.dataset.ops.split(':');
    if(action==='navigate'){ctx.navigate(value);return;}
    if(action==='refresh'){state.updatedAt=formatUpdatedAt(new Date());ctx.render();return;}
    if(action==='tool'){store.tool=value;ctx.render();return;}
    if(action==='target'){
      state.target=value;store.selected=value==='floor'?floorLights().map(light=>light.id):value==='group'?floorLights().filter(light=>light.group===floorLights()[0]?.group).map(light=>light.id):store.selected;
      ctx.render();return;
    }
    if(action==='select-light'){store.selected=[value];ctx.render();if(state.route==='monitoring')liveOperationsRoot(root).querySelector('.filter-popover').open=true;return;}
    if(action==='clear-selection'){store.selected=[];ctx.render();return;}
    if(action==='brightness'){store.brightness=clampBrightness(value);ctx.render();return;}
    if(action==='apply'){applyCommand(ctx);return;}
    if(action==='sort-log'){state.sortDesc=!state.sortDesc;ctx.render();return;}
    if(action==='log-prev'||action==='log-next'){state.logPage+=action==='log-prev'?-1:1;ctx.render();return;}
    if(action==='create-rule'){ruleDialog(value,null,ctx);return;}
    if(action==='edit-rule'){const rule=state.rules.find(rule=>rule.id===value);ruleDialog(rule.kind,rule,ctx);return;}
    if(action==='delete-rule'){const rule=state.rules.find(rule=>rule.id===value);deleteDialog(rule.name,()=>{state.rules=state.rules.filter(rule=>rule.id!==value);},ctx);return;}
    if(action==='create-zone'){zoneDialog(null,ctx);return;}
    if(action==='edit-zone'){zoneDialog(state.zones.find(zone=>zone.id===value),ctx);return;}
    if(action==='delete-zone'){const zone=state.zones.find(zone=>zone.id===value);deleteDialog(zone.name,()=>{state.zones=state.zones.filter(zone=>zone.id!==value);},ctx);return;}
    if(action==='sync-zone'){state.zones.find(zone=>zone.id===value).sync='synced';ctx.render();toast('가상 그룹 동기화를 완료했습니다.');}
  }));
  root.querySelectorAll('[data-ops-input]').forEach(node=>node.addEventListener('input',()=>{
    const key=node.dataset.opsInput;
    if(key==='brightness'){
      store.brightness=clampBrightness(node.value);
      root.querySelectorAll('[data-ops-input="brightness"]').forEach(input=>{if(input!==node)input.value=store.brightness;});
      const apply=root.querySelector('#ops-apply');if(apply&&!state.pending)apply.textContent=`밝기 ${store.brightness}% 적용`;return;
    }
    const position=node.selectionStart;
    if(key==='map-query')store.query=node.value;
    if(key==='log-search'){state.logSearch=node.value;state.logPage=1;}
    if(key==='rule-search')state.ruleSearch=node.value;
    ctx.render();
    const replacement=liveOperationsRoot(root).querySelector(`[data-ops-input="${key}"]`);replacement?.focus();replacement?.setSelectionRange(position,position);
  }));
  root.querySelector('#ops-brightness-number')?.addEventListener('blur',event=>{event.target.value=store.brightness;});
  root.querySelectorAll('[data-ops-change]').forEach(node=>node.addEventListener('change',()=>{
    const key=node.dataset.opsChange;
    if(key==='floor'){store.floor=node.value;store.selected=[];store.panX=0;store.panY=0;store.zoom=1;}
    if(key==='map-status')store.statusFilter=node.value;
    if(key==='control-group')store.selected=floorLights().filter(light=>light.group===node.value).map(light=>light.id);
    if(key==='scenario')store.scenario=node.value;
    if(key==='readonly')state.readonly=node.checked;
    if(key==='log-date'){state.logDate=node.value;state.logPage=1;}
    if(key==='log-status'){state.logStatus=node.value;state.logPage=1;}
    if(key==='log-count'){state.logCount=Number(node.value);state.logPage=1;}
    if(key==='rule-enabled')state.ruleEnabled=node.value;
    if(key==='rule-sync')state.ruleSync=node.value;
    if(key==='rule-limit')state.ruleLimit=Number(node.value);
    ctx.render();
  }));
  root.querySelectorAll('[data-ops-toggle]').forEach(node=>node.addEventListener('change',()=>{
    const rule=state.rules.find(rule=>rule.id===node.dataset.opsToggle);rule.enabled=node.checked;rule.sync='pending';ctx.render();toast(`가상 규칙을 ${rule.enabled?'활성화':'비활성화'}했습니다.`);
  }));
}
