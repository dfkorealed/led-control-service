import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
const require = createRequire(import.meta.url);
const { temporaryControlCreateSchema, temporaryControlEndSchema, temporaryControlViewSchema } = require(fileURLToPath(new URL('../../../../packages/shared/dist/temporary-control-contracts.js', import.meta.url)));
const port = 15396, apiPort = 15397;
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const site = id(1), floor = id(2), gateway = id(3), group = id(4), fixtures = [id(10),id(11),id(12),id(13)];
const user = { id: id(20), organizationId: id(21), organizationType: 'customer', loginId: 'fixture-admin', name: '테스트 관리자', role: 'admin', status: 'active', mustChangePassword: false };
const fixture = (fixtureId, index) => ({ id: fixtureId, name: `B1-L00${index+1}`, x: 250 + index * 200, y: 300, placementStatus: 'placed', positionVerifiedAt: null,
  ratedWatt: 40, brightness: 50, bioControlMode: 'sensor', bioConfiguredBrightness: 70, bioRawHighBrightness: 212,
  status: 'online', statusReason: 'reported', health: { faultCodes: [], observedAt: new Date().toISOString() }, rssi: -50, hopCount: 1, commandSuccessRate: 1,
  lastSeenAt: new Date().toISOString(), gateway: { id: gateway, name: 'GW-B1', connectionStatus: 'online', assignmentVersion: 1 }, controllable: true, controlBlockReason: null });
const dashboard = () => ({ generatedAt: new Date().toISOString(), capabilities: { read: true, control: true, manage: true, commission: true },
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 }, site: { id: site, name: 'BIO 테스트 현장', customerName: '테스트 고객', installationStatus: 'installed', address: null, tariffKwhRate: 160, timeZone: 'Asia/Seoul' },
  summary: { totalFixtures: 4, onlineFixtures: 4, offlineFixtures: 0, faultFixtures: 0, averageBrightness: 50 },
  floors: [{ id: floor, name: 'B1', level: -1, floorPlan: null, summary: { totalFixtures: 4, onlineFixtures: 4, offlineFixtures: 0, faultFixtures: 0 },
    meshControlGroups: [{ gatewayId: gateway, status: 'ready', version: 1, error: null }], fixtures: fixtures.map(fixture) }],
  groups: [{ id: group, name: '입구 구역', floorId: floor, gatewayId: gateway, lifecycleStatus: 'active', fixtureCount: 2, fixtureIds: fixtures.slice(0,2), meshControlGroup: { status: 'ready', version: 1, error: null } }],
  gateways: [{ id: gateway, name: 'GW-B1', serialNumber: 'fixture-gateway', firmwareVersion: 'fixture-v3', lastHeartbeatAt: new Date().toISOString(), connectionStatus: 'online' }] });
function schedule() { return { id: id(30), name: 'BIO 야간', status: 'enabled', activeFrom: '2026-09-01T03:00:00.000Z', activeUntil: '2026-10-31T03:00:00.000Z', localStartTime: '22:00', localEndTime: '06:00',
  recurrence: { kind: 'daily', weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null }, action: { dimmingEnabled: true, brightnessPercent: 70 },
  fixtureIds: fixtures.slice(0,2), excludeWeekends: false, excludeHolidays: false, gatewayId: gateway, targets: fixtures.slice(0,2).map(fixtureId => ({ fixtureId })), targetCount: 2,
  desiredRevision: 3, appliedRevision: 3, syncStatus: 'APPLIED', nextOccurrence: null, lastExecution: null, createdById: user.id, updatedById: user.id, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }; }
let state;
function reset() { state = { rows: [schedule()], session: null, phase: 'holding', requests: [], revision: 0, posts: [], ends: [] }; }
reset();
function projectedCalendar(from,to) {
  return { from,to,timeZone:'Asia/Seoul',complete:true,revisionKey:`sha256:${String(state.revision % 10).repeat(64)}`,holidayCoverage:[],
    schedules: state.rows.map(({ id,name,status,activeFrom,activeUntil,localStartTime,localEndTime,recurrence,action,fixtureIds,excludeWeekends,excludeHolidays }) => ({ id,name,status,activeFrom,activeUntil,localStartTime,localEndTime,recurrence,action,fixtureIds,excludeWeekends,excludeHolidays })),
    occurrences: state.rows.flatMap(row => row.status === 'disabled' ? [] : ['2026-09-21','2026-09-22','2026-09-23','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02']
      .filter(date => date >= from && date <= to).map(date => ({ scheduleId:row.id,key:date,localDate:date,startsAt:`${date}T13:00:00.000Z`,endsAt:`${date}T21:00:00.000Z` }))) };
}
function evidence(target,index,phase) {
  const confirmed = phase !== 'unknown' && (phase !== 'partial' || index === 0);
  return { schemaVersion:1,sessionId:state.session.id,siteId:site,gatewayId:gateway,assignmentVersion:1,admissionRevision:3,originCommandHash:`sha256:${'a'.repeat(64)}`,originSequence:1,
    fixtureId:target.fixtureId,eventId:id(70+index),sessionRevision:1,kind:'apply',targetGeneration:target.applyGeneration,restorationRevision:null,restorationPayloadHash:null,
    applyConfirmed:confirmed,releaseConfirmed:false,configurationMayHaveChanged:true,partialMutation:confirmed ? 'none' : phase === 'partial' ? 'high_brightness':'unverified',
    configurationReadback:confirmed ? {configuredHighBrightnessPercent:state.session.brightness,bioMode:state.session.brightness === 0 ? 'force-off':'force-on'}:null,
    rfWriteEvidence:confirmed ? 'observed':'may_have_written',reason:confirmed ? null:'fixture partial/unknown',observedAt:state.session.startedAt,resultHash:`sha256:${'b'.repeat(64)}` };
}
function sessionView() {
  if (!state.session) return null;
  const result = { ...state.session, state:state.phase, now:state.phase === 'restored' ? new Date(Date.parse(state.session.endsAt)+1000).toISOString():new Date().toISOString() };
  result.results = state.phase === 'pending' ? [] : result.targets.map((target,index) => evidence(target,index,state.phase));
  if (['releasing','restored'].includes(state.phase)) result.sessionRevision=2;
  if (state.phase === 'restored') result.results.push(...result.targets.map((target,index) => ({ ...evidence(target,index,'holding'),eventId:id(90+index),sessionRevision:2,kind:'release',targetGeneration:target.releaseGeneration,
    releaseConfirmed:true,restorationRevision:4,restorationPayloadHash:`sha256:${'c'.repeat(64)}`,configurationReadback:{configuredHighBrightnessPercent:50,bioMode:'sensor'},observedAt:result.now })));
  return temporaryControlViewSchema.parse(result);
}
async function body(request) { let text=''; for await (const chunk of request) { text += chunk; if(text.length>100000) throw new Error('body limit'); } return text ? JSON.parse(text):{}; }
function reply(response, data, status=200) { response.writeHead(status, {'Content-Type':'application/json','Cache-Control':'private, no-store'});response.end(JSON.stringify(data)); }
const api = createServer(async (request,response) => {
  try {
    const url=new URL(request.url,`http://127.0.0.1:${apiPort}`),path=url.pathname,method=request.method;
    if(path==='/__fixture/reset' && method==='POST') { reset();return reply(response,{ok:true}); }
    if(path==='/__fixture/phase' && method==='POST') { const input=await body(request); if(!['holding','partial','unknown','releasing','restored'].includes(input.phase)) return reply(response,{message:'phase'},400);state.phase=input.phase;return reply(response,{ok:true}); }
    if(path==='/__fixture/state') return reply(response,{requests:state.requests,posts:state.posts,ends:state.ends});
    state.requests.push(`${method} ${path}`);
    if(path==='/auth/me') return reply(response,{user});
    if(path==='/sites') return reply(response,[{id:site,name:'BIO 테스트 현장',customerName:'테스트 고객'}]);
    if(path===`/sites/${site}/dashboard` || path==='/sites/default/dashboard') return reply(response,dashboard());
    if(path===`/sites/${site}/floors/${floor}/map-snapshot`) return reply(response,{floorId:floor,revision:1,width:1200,height:800,floorPlan:null,objects:[]});
    if(path==='/registration-sessions/active') return reply(response,[]);
    if(path==='/commands' || path==='/commands/verification-cases') return reply(response,{items:[],nextCursor:null,generatedAt:new Date().toISOString(),retainedFrom:'2026-07-15T00:00:00Z',retentionEnabled:false});
    if(path===`/sites/${site}/temporary-controls` && method==='POST') {
      const input=temporaryControlCreateSchema.parse(await body(request));state.posts.push(input);
      if(state.session && state.posts[0].clientRequestId!==input.clientRequestId && !['restored','rejected','cancelled'].includes(state.phase)) return reply(response,{code:'temporary_control_conflict'},409);
      if(!state.session) { const startedAt=new Date().toISOString(); const targetIds=input.target.type==='fixtures' ? input.target.fixtureIds : input.target.type==='fixture' ? [input.target.fixtureId]:fixtures.slice(0,2);
        state.session={id:id(50),siteId:site,gatewayId:gateway,state:'pending',sessionRevision:1,now:startedAt,startedAt,endsAt:new Date(Date.parse(startedAt)+input.durationMinutes*60000).toISOString(),brightness:input.brightness,
          targets:targetIds.map((fixtureId,index)=>({fixtureId,meshNodeId:id(60+index),nativeUuid:`abcdef${String(index).padStart(6,'0')}`,logicalAddress:`0x${(4097+index).toString(16)}`,applyGeneration:'1',releaseGeneration:'2'})),results:[],reason:null,detailsRedacted:false}; }
      // HTTP acceptance remains pending; the next GET supplies the scenario's verified result.
      return reply(response,temporaryControlViewSchema.parse(state.session),202);
    }
    if(path===`/sites/${site}/temporary-controls/${id(50)}/end` && method==='POST') { const input=temporaryControlEndSchema.parse(await body(request));state.ends.push(input);state.phase='releasing';return reply(response,sessionView(),202); }
    if(path===`/sites/${site}/temporary-controls/${id(50)}`) return state.session ? reply(response,sessionView()):reply(response,{message:'not found'},404);
    if(path===`/sites/${site}/temporary-controls`) return reply(response,{items:state.session ? [sessionView()]:[],nextCursor:null});
    if(path===`/sites/${site}/automation/schedules/calendar`) return reply(response,projectedCalendar(url.searchParams.get('from'),url.searchParams.get('to')));
    if(path===`/sites/${site}/automation/schedules` && method==='GET') return reply(response,{items:state.rows,total:state.rows.length,filteredTotal:state.rows.length,siteSummary:{ruleCount:state.rows.length,syncRuleCounts:{APPLIED:state.rows.length,PENDING:0,REJECTED:0}},nextCursor:null});
    if(path.startsWith(`/sites/${site}/automation/schedules`) && ['PATCH','POST'].includes(method)) { const input=await body(request); const row=state.rows[0];Object.assign(row,input);state.revision++;return reply(response,row); }
    if(path===`/sites/${site}/automation/vehicle-event-rules`) return reply(response,{items:[],total:0,filteredTotal:0,siteSummary:{ruleCount:0,syncRuleCounts:{APPLIED:0,PENDING:0,REJECTED:0}},nextCursor:null});
    if(path==='/bio-sensor-profiles') return reply(response,[]);
    if(path.includes('bio-sensor-policy')) return reply(response,{enabled:false,revision:0,ownerUserId:null,maximumResponseSeconds:null,escalationAction:null});
    return reply(response,{message:`Unconfigured isolated fixture: ${method} ${path}`},501);
  } catch(error) { return reply(response,{message:String(error)},400); }
});
await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(apiPort,'127.0.0.1',resolve);});
// Prevent the imported product Vite config from resolving an inherited live API/TLS target.
process.env.VITE_TEST_DATA_TOOLS_ENABLED='false'; process.env.DEV_LOCAL_APP_ONLY='0'; process.env.VITE_API_PROXY_TARGET=`http://127.0.0.1:${apiPort}`;process.env.WEB_PORT=String(port);
const web=await createViteServer({root:fileURLToPath(new URL('../..',import.meta.url)),envDir:false,configFile:fileURLToPath(new URL('../../vite.config.ts',import.meta.url)),
  cacheDir:fileURLToPath(new URL('../../node_modules/.vite-bio-control-operations',import.meta.url)),
  server:{host:'127.0.0.1',port,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${apiPort}`,rewrite:path=>path.replace(/^\/api/,'')}}}});
await web.listen();
let closing=false;
async function close(){if(closing)return;closing=true;await web.close();await new Promise(resolve=>api.close(resolve));process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
