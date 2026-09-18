#!/usr/bin/env bash
set -euo pipefail

for tool in docker node openssl; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }; done
docker version >/dev/null
docker compose version >/dev/null
smoke_id="$(openssl rand -hex 16)"
smoke_project="led-production-smoke-${smoke_id}"
smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/${smoke_project}.XXXXXX")"
smoke_root="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  local result=$? cleanup_result=0 remaining
  trap - EXIT INT TERM
  # Only the generated, rendered file can identify cleanup targets; never use a
  # developer .env/default project or caller-provided compose arguments.
  if [[ -f "$smoke_dir/rendered.json" ]]; then
    docker compose -p "$smoke_project" -f "$smoke_dir/rendered.json" down --volumes --remove-orphans >"$smoke_dir/cleanup.log" 2>&1 || cleanup_result=1
  fi
  for image in "${smoke_project}-api:sha-${smoke_id}" "${smoke_project}-web:sha-${smoke_id}"; do
    if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" >/dev/null 2>&1 || cleanup_result=1; fi
  done
  # Include exited one-shots and fail closed if the daemon cannot prove absence.
  remaining="$(docker container ls -aq --filter "label=com.docker.compose.project=$smoke_project")" || cleanup_result=1
  if [[ -n "$remaining" ]]; then cleanup_result=1; fi
  for kind in volume network; do
    remaining="$(docker "$kind" ls -q --filter "label=com.docker.compose.project=$smoke_project")" || cleanup_result=1
    if [[ -n "$remaining" ]]; then cleanup_result=1; fi
  done
  if [[ "$cleanup_result" == 0 ]]; then
    echo "CLEANUP project=$smoke_project containers=0 volumes=0 networks=0 owned-images=0"
    # mktemp's exact path must include this run's unpredictable identifier.
    case "$smoke_dir" in *"/$smoke_project."*) rm -rf -- "$smoke_dir" ;; *) cleanup_result=1 ;; esac
  else
    echo "Exact cleanup failed; inspect project $smoke_project and private directory $smoke_dir" >&2
  fi
  if [[ "$result" != 0 || "$cleanup_result" != 0 ]]; then exit 1; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node --input-type=module - "$smoke_root" "$smoke_dir" "$smoke_project" "$smoke_id" <<'NODE'
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {writeFileSync, readFileSync, mkdirSync, copyFileSync, chmodSync, readdirSync} from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
const [root, dir, project, id] = process.argv.slice(2);
const log = message => console.log(message);
const write = (name, content) => writeFileSync(path.join(dir, name), content, {mode:0o600});
const run = (file, args, options={}) => execFileSync(file, args, {cwd:root, encoding:'utf8', stdio:['ignore','pipe','pipe'], ...options});
const openssl = (...args) => run('openssl', args, {cwd:dir});
const secret = () => randomBytes(32).toString('hex');
// All PKI is disposable. No production CA, token, endpoint or database is read.
for (const name of ['api-tls','mqtt-tls','web-tls','vault','cad-converter','cad-converter/bin']) mkdirSync(path.join(dir,name), {mode:0o755});
openssl('req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=Disposable smoke CA','-keyout','ca.key','-out','ca.crt');
write('index',''); write('serial','1000\n'); write('crlnumber','1000\n');
write('ca.cnf', `[ca]\ndefault_ca=CA\n[CA]\ndatabase=${dir}/index\nserial=${dir}/serial\ncrlnumber=${dir}/crlnumber\nprivate_key=${dir}/ca.key\ncertificate=${dir}/ca.crt\ndefault_md=sha256\ndefault_crl_days=2\n`);
openssl('ca','-gencrl','-config','ca.cnf','-out','ca.crl');
openssl('req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=Disposable smoke Root','-keyout','root.key','-out','root.crt');
write('root-index',''); write('root-serial','1000\n'); write('root-crlnumber','1000\n');
write('root.cnf', `[ca]\ndefault_ca=CA\n[CA]\ndatabase=${dir}/root-index\nserial=${dir}/root-serial\ncrlnumber=${dir}/root-crlnumber\nprivate_key=${dir}/root.key\ncertificate=${dir}/root.crt\ndefault_md=sha256\ndefault_crl_days=2\n`);
openssl('ca','-gencrl','-config','root.cnf','-out','root.crl');
write('crl.bundle', `${readFileSync(path.join(dir,'ca.crl'),'utf8').trim()}\n${readFileSync(path.join(dir,'root.crl'),'utf8').trim()}\n`);
function cert(name, cn, usage, san='') {
  openssl('req','-new','-newkey','rsa:2048','-nodes','-subj',`/CN=${cn}`,'-keyout',`${name}.key`,'-out',`${name}.csr`);
  write(`${name}.ext`, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n${san ? `subjectAltName=${san}\n` : ''}`);
  openssl('x509','-req','-in',`${name}.csr`,'-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-days','2','-extfile',`${name}.ext`,'-out',`${name}.crt`);
}
cert('server','api','serverAuth','DNS:api,DNS:web,DNS:mqtt-tls,DNS:vault-smoke,DNS:localhost,IP:127.0.0.1');
cert('client','api-service','clientAuth');
cert('manufacturing','smoke-manufacturing-station','clientAuth');
for (const [source, targets] of Object.entries({
  'ca.crt':['api-tls/api-ca.crt','api-tls/device-ca.crt','api-tls/manufacturing-ca.crt','mqtt-tls/mqtt-ca.crt','web-tls/web-ca.crt','vault/ca.crt'],
  'crl.bundle':['api-tls/device.crl','mqtt-tls/mqtt-client.crl'],
  'ca.crl':['api-tls/manufacturing.crl'],
  'server.crt':['api-tls/api.crt','mqtt-tls/mqtt-server.crt','web-tls/web.crt','vault/server.crt'],
  'server.key':['api-tls/api.key','mqtt-tls/mqtt-server.key','web-tls/web.key','vault/server.key'],
  'client.crt':['mqtt-tls/api-client.crt'], 'client.key':['mqtt-tls/api-client.key']
})) for (const target of targets) { copyFileSync(path.join(dir,source),path.join(dir,target)); chmodSync(path.join(dir,target),0o444); }
const token=secret(); write('vault/token',token); chmodSync(path.join(dir,'vault/token'),0o444);
// The only Vault endpoint accepted is lookup-self with this run's token. The
// deliberately long disposable lease avoids implementing issuance/renewal APIs.
write('vault/server.cjs', `const fs=require('fs');require('https').createServer({cert:fs.readFileSync('/fixture/server.crt'),key:fs.readFileSync('/fixture/server.key')},(q,r)=>{if(q.method!=='GET'||q.url!=='/v1/auth/token/lookup-self'||q.headers['x-vault-token']!==fs.readFileSync('/fixture/token','utf8')){r.writeHead(403);r.end();return;}r.setHeader('Content-Type','application/json');r.end(JSON.stringify({data:{renewable:true,ttl:3600,policies:['gateway-pki']}}));}).listen(8200);`);
chmodSync(path.join(dir,'vault/server.cjs'),0o444);
// This disposable external bundle exercises the production mount contract. It
// is not copied into the image and fails if the converter inherits API secrets.
write('cad-converter/bin/converter', `#!/bin/sh
set -eu
if env | grep -Eq '^(DATABASE_URL|REDIS_URL|MQTT_URL|VAULT_ADDR|OBJECT_STORAGE_ACCESS_KEY|OBJECT_STORAGE_SECRET_KEY)='; then
  echo 'credential leaked to converter' >&2
  exit 90
fi
if grep -q '^MEMORY_BOMB$' "$1"; then
  exec node -e 'const held=[]; for (;;) held.push(Buffer.alloc(16*1024*1024, 1))'
fi
if grep -q '^OUTPUT_BOMB$' "$1"; then
  exec dd if=/dev/zero of="$2" bs=1048576 count=300
fi
if grep -q '^TIMEOUT$' "$1"; then
  exec sleep 120
fi
cp "$1" "$2"
`);
chmodSync(path.join(dir,'cad-converter/bin/converter'),0o555);
const converterDigest=createHash('sha256').update(readFileSync(path.join(dir,'cad-converter/bin/converter'))).digest('hex');
const password=secret(), redisPassword=secret();
const env={PRODUCTION_COMPOSE_PROJECT:project,API_IMAGE:`${project}-api:sha-${id}`,WEB_IMAGE:`${project}-web:sha-${id}`,
 POSTGRES_USER:'smoke',POSTGRES_PASSWORD:password,POSTGRES_DB:'smoke',DATABASE_URL:`postgresql://smoke:${password}@postgres:5432/smoke`,
 REDIS_PASSWORD:redisPassword,REDIS_URL:`redis://:${redisPassword}@redis:6379`,MQTT_URL:'mqtts://mqtt-tls:8883',MQTT_PUBLIC_URL:'mqtts://mqtt-tls:8883',MQTT_API_INSTANCE_ID:project,
 MQTT_TLS_CERT_DIR:path.join(dir,'mqtt-tls'),API_TLS_CERT_DIR:path.join(dir,'api-tls'),WEB_TLS_CERT_DIR:path.join(dir,'web-tls'),
 VAULT_ADDR:'https://vault-smoke:8200',VAULT_TOKEN_FILE:path.join(dir,'vault/token'),VAULT_CA_CERT_PATH:path.join(dir,'vault/ca.crt'),
 VAULT_PKI_DEVICE_MOUNT:'device',VAULT_PKI_DEVICE_ROLE:'gateway',VAULT_PKI_MQTT_MOUNT:'mqtt',VAULT_PKI_MQTT_ROLE:'gateway',
 OBJECT_STORAGE_ACCESS_KEY:secret(),OBJECT_STORAGE_SECRET_KEY:secret(),OBJECT_STORAGE_BUCKET:'floor-assets',OBJECT_STORAGE_REPORT_BUCKET:'energy-reports',OBJECT_STORAGE_ENDPOINT:'http://object-storage:9000',OBJECT_STORAGE_PUBLIC_URL:'http://object-storage:9000/floor-assets',OBJECT_STORAGE_REGION:'us-east-1',
 CAD_IMPORT_CONVERTER_BUNDLE_PATH:path.join(dir,'cad-converter'),CAD_IMPORT_CONVERTER_ARGV_JSON:'["{input}","{output}"]',CAD_IMPORT_CONVERTER_SHA256:converterDigest,
 WEB_PUBLIC_URL:'https://localhost',WEB_HTTPS_ORIGIN:'https://localhost',WEB_HTTP_PORT:'127.0.0.1::8080',WEB_HTTPS_PORT:'127.0.0.1::8443'};
// Production uses fixed target ports in its short syntax; zero asks Docker for
// private loopback ephemeral host ports, avoiding every existing stack's ports.
env.WEB_HTTP_PORT='127.0.0.1:0'; env.WEB_HTTPS_PORT='127.0.0.1:0'; env.DEVICE_API_HTTPS_PORT='127.0.0.1:0';
write('smoke.env',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n'));
// Docker internal networks do not publish host ports. Keep dependencies/Vault
// internal; only Web joins the ordinary edge bridge for loopback TLS assertions.
write('override.json',JSON.stringify({services:{'vault-smoke':{image:'node:22.20.0-alpine3.22',user:'1000:1000',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],networks:['backend'],volumes:[`${dir}/vault:/fixture:ro`],command:['node','/fixture/server.cjs']},api:{depends_on:{'vault-smoke':{condition:'service_started'}},environment:{CAD_IMPORT_CONVERTER_CLIENT_TIMEOUT_MS:'3000'}},'cad-converter':{environment:{CAD_IMPORT_CONVERTER_TIMEOUT_MS:'1000'}}},networks:{backend:{internal:true}}}));
const cleanEnv={...process.env}; for(const key of Object.keys(env)) delete cleanEnv[key];
const composeArgs=['compose','-p',project,'--env-file',path.join(dir,'smoke.env'),'-f',path.join(root,'docker-compose.production.yml'),'-f',path.join(dir,'override.json')];
const {attestConverterBundleHost,validateProductionConfig,productionComposeArguments}=await import(path.join(root,'scripts/production-compose-config.mjs'));
assert.deepEqual(composeArgs.slice(0,-2),productionComposeArguments(project,path.join(dir,'smoke.env')));
const production=JSON.parse(run('docker',composeArgs.slice(0,-2).concat(['config','--format','json']),{env:cleanEnv}));
validateProductionConfig(production,{smokeProject:project});
assert.equal(attestConverterBundleHost(env.CAD_IMPORT_CONVERTER_BUNDLE_PATH,env.CAD_IMPORT_CONVERTER_SHA256).digest,converterDigest);
assert.equal(production.name,project);
for(const volume of Object.values(production.volumes)) assert.ok(volume.name.startsWith(`${project}_`));
const rendered=JSON.parse(run('docker',[...composeArgs,'config','--format','json'],{env:cleanEnv}));
assert.equal(String(rendered.services.api.environment.CAD_IMPORT_CONVERTER_CLIENT_TIMEOUT_MS),'3000');
assert.equal(String(rendered.services['cad-converter'].environment.CAD_IMPORT_CONVERTER_TIMEOUT_MS),'1000');
write('rendered.json',JSON.stringify(rendered));
const compose=(...args)=>run('docker',['compose','-p',project,'-f',path.join(dir,'rendered.json'),...args]);
async function stream(file,args,filename) {
  const chunks=[];
  const child=spawn(file,args,{cwd:root,env:cleanEnv,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',v=>chunks.push(v)); child.stderr.on('data',v=>chunks.push(v));
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  write(filename,Buffer.concat(chunks));
  if(code!==0) {
    let safe=Buffer.concat(chunks).toString();
    for(const value of [token,password,redisPassword,env.OBJECT_STORAGE_ACCESS_KEY,env.OBJECT_STORAGE_SECRET_KEY]) safe=safe.replaceAll(value,'[REDACTED]');
    log(safe.slice(-2000));
    throw new Error(`${filename} failed`);
  }
}
log(`SMOKE project=${project} blank-db=required dependency-network=internal Web-ports=loopback`);
for(const [app,image] of [['api',env.API_IMAGE],['web',env.WEB_IMAGE]]) {
  log(`BUILD ${app}`);
  await stream('docker',['build','--label',`com.docker.compose.project=${project}`,'-f',`apps/${app}/Dockerfile`,'-t',image,'.'],`${app}-build.log`);
  const config=JSON.parse(run('docker',['image','inspect',image]))[0];
  assert.ok(config.Config.User && !['root','0'].includes(config.Config.User));
  log(`IMAGE ${image} id=${config.Id} user=${config.Config.User}`);
}
try {
  assert.throws(()=>compose('run','--rm','--no-deps','-e','DEVICE_CRL_SEED_PATH=/seed/missing.crl','crl-init'));
  log('VERIFY CRL missing-seed=nonzero');
  // The first query proves no previous schema/data is being reused.
  compose('up','-d','postgres');
  const wait=async(check,label,ms=90000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,500));}throw new Error(`${label} deadline exceeded`);};
  // pg_isready also observes the disposable init server. Require the final
  // entrypoint exec (postgres as PID 1) before issuing the blank-database query.
  await wait(()=>{try{return compose('exec','-T','postgres','sh','-ec','test "$(cat /proc/1/comm)" = postgres && pg_isready -U smoke -d smoke').includes('accepting connections')}catch{return false}},'postgres');
  const sql=q=>compose('exec','-T','postgres','psql','-U','smoke','-d','smoke','-Atc',q).trim();
  assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"),'0');
  log('DATABASE initial-public-tables=0');
  await stream('docker',['compose','-p',project,'-f',path.join(dir,'rendered.json'),'up','-d'], 'startup.log');
  const ca=readFileSync(path.join(dir,'ca.crt'));
  let port;
  await wait(()=>{try{port=Number(compose('port','web','8443').trim().split(':').at(-1));return Boolean(port)}catch{return false}},'web startup');
  function request(url,options={},body) {return new Promise((resolve,reject)=>{const req=(url.startsWith('https')?https:http).request(url,{ca,...options},res=>{let responseBody='';res.on('data',c=>responseBody+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:responseBody,tls:res.socket?.getProtocol?.()}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('request timeout')));req.end(body);});}
  const origin=`https://localhost:${port}`;
  await wait(async()=>{try{return (await request(`${origin}/api/health/ready`)).status===200}catch{return false}},'readiness');
  const migrations=Number(sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'));
  const expected=readdirSync(path.join(root,'apps/api/prisma/migrations'),{withFileTypes:true}).filter(v=>v.isDirectory()).length;
  assert.equal(migrations,expected);
  const migrateId=compose('ps','-aq','api-migrate').trim(), apiId=compose('ps','-q','api').trim();
  assert.equal(run('docker',['inspect','--format','{{.Image}}',migrateId]).trim(),run('docker',['inspect','--format','{{.Image}}',apiId]).trim());
  const migrationState=JSON.parse(run('docker',['inspect',migrateId]))[0].State;
  const apiContainer=JSON.parse(run('docker',['inspect',apiId]))[0];
  assert.equal(migrationState.ExitCode,0);
  assert.ok(Date.parse(migrationState.FinishedAt)<=Date.parse(apiContainer.State.StartedAt));
  assert.equal(apiContainer.HostConfig.ReadonlyRootfs,true);
  assert.equal(apiContainer.HostConfig.Memory,1476395008);
  const cadCgroupMemory=compose('exec','-T','api','sh','-ec','cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes').trim();
  assert.equal(cadCgroupMemory,'1476395008');
  const cadTempCapacity=compose('exec','-T','api','node','-e',"const {statfsSync}=require('node:fs');const s=statfsSync('/tmp/cad-import',{bigint:true});process.stdout.write(String(s.bsize*s.blocks))").trim();
  assert.equal(cadTempCapacity,'536870912');
  assert.ok(apiContainer.Config.Env.includes('CAD_IMPORT_TEMP_VOLUME_BYTES=536870912'));
  const sidecarId=compose('ps','-q','cad-converter').trim();
  const sidecarContainer=JSON.parse(run('docker',['inspect',sidecarId]))[0];
  assert.equal(sidecarContainer.HostConfig.Memory,1073741824);
  assert.equal(sidecarContainer.HostConfig.NetworkMode,'none');
  assert.notEqual(sidecarContainer.Config.User,apiContainer.Config.User);
  assert.deepEqual(Object.keys(Object.fromEntries(sidecarContainer.Config.Env.map(value=>value.split('=',1).concat(value.slice(value.indexOf('=')+1))))).filter(key=>/DATABASE|REDIS|MQTT|VAULT|OBJECT_STORAGE|TLS|SECRET/.test(key)),[]);
  const sidecarCgroupMemory=compose('exec','-T','cad-converter','sh','-ec','cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes').trim();
  assert.equal(sidecarCgroupMemory,'1073741824');
  compose('exec','-T','cad-converter','sh','-ec','test ! -e /run/vault && test ! -e /run/api-tls && test ! -e /run/mqtt-tls && test ! -L /usr/bin/prlimit && test -f /usr/bin/prlimit && test -x /usr/bin/prlimit && test "$(readlink -f /usr/bin/prlimit)" = /usr/bin/prlimit && test "$(stat -c %u:%a /usr/bin/prlimit)" = 0:755');
  compose('exec','-T','api','sh','-ec','test ! -e /opt/cad-converter');
  assert.deepEqual(apiContainer.Config.Entrypoint,['/sbin/tini','--']);
  const live=await request(`${origin}/api/health/live`,{headers:{'X-Request-Id':'smoke-correlation','X-Forwarded-For':'untrusted'}});
  assert.equal(live.status,200); assert.equal(live.headers['x-request-id'],'smoke-correlation');
  const ready=JSON.parse((await request(`${origin}/api/health/ready`)).body);
  assert.deepEqual(ready.checks,{postgres:'up',redis:'up',mqtt:'up',objectStorage:'up',cadConverter:'up'});
  const shell=await request(`${origin}/index.html`); assert.equal(shell.status,200); assert.match(shell.body,/<html/); assert.match(shell.headers['cache-control'],/no-cache/);
  const asset=shell.body.match(/(?:src|href)="(\/assets\/[^" ]+\.js)"/)[1];
  const assetResponse=await request(`${origin}${asset}`); assert.equal(assetResponse.status,200); assert.match(assetResponse.headers['cache-control'],/immutable/);
  for(const response of [shell,assetResponse,live]) for(const header of ['strict-transport-security','x-content-type-options','x-frame-options','referrer-policy']) assert.ok(response.headers[header],header);
  for(const version of ['TLSv1.2','TLSv1.3']) assert.equal((await request(`${origin}/`,{minVersion:version,maxVersion:version})).status,200);
  const httpPort=Number(compose('port','web','8080').trim().split(':').at(-1));
  const redirect=await request(`http://localhost:${httpPort}/route?q=1`); assert.equal(redirect.status,308); assert.equal(redirect.headers.location,'https://localhost/route?q=1');
  // An untrusted client must not be able to verify the generated TLS endpoint.
  await assert.rejects(request(`${origin}/`,{ca:undefined}));
  const devicePort=Number(compose('port','web','9443').trim().split(':').at(-1));
  const deviceUrl=`https://localhost:${devicePort}/manufacturing/gateway-enrollments`;
  const invalidBody=JSON.stringify({serialNumber:''});
  const manufacturingOptions={method:'POST',servername:'api',headers:{'Content-Type':'application/json'}};
  // An invalid serial is rejected before UUID/token generation or database I/O.
  // Assert exact 400 validation text, not a generic non-401 that could hide 500.
  assert.equal((await request(deviceUrl,manufacturingOptions,invalidBody)).status,401);
  const clientIdentity={cert:readFileSync(path.join(dir,'manufacturing.crt')),key:readFileSync(path.join(dir,'manufacturing.key'))};
  const authorized=await request(deviceUrl,{...manufacturingOptions,...clientIdentity},invalidBody);
  assert.equal(authorized.status,400);
  assert.equal(JSON.parse(authorized.body).message,'serialNumber is required');
  assert.equal(sql('SELECT count(*) FROM "GatewayInventory"'),'0');
  assert.equal(sql('SELECT count(*) FROM "GatewayEnrollment"'),'0');
  await assert.rejects(request(deviceUrl,{...manufacturingOptions,...clientIdentity,servername:'wrong.invalid'},invalidBody));
  assert.equal((await request(`${origin}/api/health/ready`)).status,200);
  log('VERIFY TLS-passthrough no-client=401 valid-client=400 invalid-serial=true server-identity=verified inventory/enrollment=0 browser-proxy=200');
  log(`VERIFY migrations=${migrations}/${expected} same-api-image=true api-cgroup=${cadCgroupMemory} sidecar-cgroup=${sidecarCgroupMemory} sidecar-network=none uid-separated=true secret-mounts=absent prlimit=root:755:canonical live=200 ready=200 TLS=1.2,1.3 proxy=200 request-id=preserved cache/security=pass HTTP=308`);
  const digest=content=>createHash('sha256').update(content).digest('hex');
  const sqlLiteral=value=>`'${String(value).replaceAll("'", "''")}'`;
  const sessionToken=secret();
  const seeded={organizationId:randomUUID(),userId:randomUUID(),siteId:randomUUID(),floorId:randomUUID(),sessionId:randomUUID()};
  sql(`INSERT INTO "Organization" ("id","name","type","createdAt","updatedAt") VALUES (${sqlLiteral(seeded.organizationId)},'CAD smoke','customer',now(),now());
    INSERT INTO "User" ("id","organizationId","loginId","name","passwordHash","role","status","mustChangePassword","createdAt","updatedAt")
      VALUES (${sqlLiteral(seeded.userId)},${sqlLiteral(seeded.organizationId)},${sqlLiteral(`cad-smoke-${id}`)},'CAD Smoke Admin','unused','admin','active',false,now(),now());
    INSERT INTO "Site" ("id","organizationId","adminUserId","name","timeZone","createdAt","updatedAt")
      VALUES (${sqlLiteral(seeded.siteId)},${sqlLiteral(seeded.organizationId)},${sqlLiteral(seeded.userId)},'CAD Smoke Site','Asia/Seoul',now(),now());
    INSERT INTO "Floor" ("id","siteId","name","level","createdAt","updatedAt")
      VALUES (${sqlLiteral(seeded.floorId)},${sqlLiteral(seeded.siteId)},'CAD Smoke Floor',1,now(),now());
    INSERT INTO "Session" ("id","userId","familyId","tokenHash","expiresAt","createdAt","updatedAt")
      VALUES (${sqlLiteral(seeded.sessionId)},${sqlLiteral(seeded.userId)},${sqlLiteral(randomUUID())},${sqlLiteral(digest(sessionToken))},now()+interval '1 hour',now(),now());`);
  const authHeaders={'Content-Type':'application/json','Cookie':`led_session=${sessionToken}`};
  const jsonRequest=async(method,url,body)=>{
    const response=await request(url,{method,headers:authHeaders},body===undefined?undefined:JSON.stringify(body));
    let parsed; try { parsed=response.body?JSON.parse(response.body):undefined; } catch { parsed=response.body; }
    return {...response,json:parsed};
  };
  const composeInput=(input,...args)=>run('docker',['compose','-p',project,'-f',path.join(dir,'rendered.json'),...args],{input,stdio:['pipe','pipe','pipe']});
  const putSource=content=>{
    const bytes=Buffer.from(content); const assetId=randomUUID(); const objectKey=`floors/${seeded.floorId}/${assetId}.dxf`; const sha256=digest(bytes);
    composeInput(bytes,'exec','-T','api','node','-e',`const fs=require('fs');const crypto=require('crypto');const {S3Client,PutObjectCommand}=require('@aws-sdk/client-s3');const body=fs.readFileSync(0);const client=new S3Client({endpoint:process.env.OBJECT_STORAGE_ENDPOINT,region:process.env.OBJECT_STORAGE_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.OBJECT_STORAGE_ACCESS_KEY,secretAccessKey:process.env.OBJECT_STORAGE_SECRET_KEY}});client.send(new PutObjectCommand({Bucket:process.env.OBJECT_STORAGE_BUCKET,Key:process.argv[1],Body:body,ContentType:'application/dxf',ContentLength:body.length,ChecksumSHA256:crypto.createHash('sha256').update(body).digest('base64')})).catch(error=>{console.error(error);process.exit(1)});`,objectKey);
    sql(`INSERT INTO "FloorAsset" ("id","floorId","kind","status","objectKey","mimeType","sizeBytes","sha256","readyAt","createdAt","updatedAt")
      VALUES (${sqlLiteral(assetId)},${sqlLiteral(seeded.floorId)},'original','ready',${sqlLiteral(objectKey)},'application/dxf',${bytes.length},${sqlLiteral(sha256)},now(),now(),now());`);
    return {assetId,objectKey,sha256};
  };
  const createJob=async content=>{
    const source=putSource(content);
    const response=await jsonRequest('POST',`${origin}/api/floors/${seeded.floorId}/import-jobs`,{sourceAssetId:source.assetId,sourceFormat:'dxf'});
    assert.equal(response.status,201,JSON.stringify(response.json));
    return {...source,jobId:response.json.jobId};
  };
  const waitForJob=async(jobId,statuses,timeoutMs=30000)=>{
    let latest;
    await wait(async()=>{
      const response=await jsonRequest('GET',`${origin}/api/floors/${seeded.floorId}/import-jobs/${jobId}`);
      assert.equal(response.status,200,JSON.stringify(response.json)); latest=response.json;
      return statuses.includes(latest.status);
    },`CAD job ${jobId} ${statuses.join('/')}`,timeoutMs);
    return latest;
  };
  const fetchSignedContent=async assetId=>{
    const redirect=await jsonRequest('GET',`${origin}/api/floors/${seeded.floorId}/assets/${assetId}/content`);
    assert.equal(redirect.status,302,JSON.stringify(redirect.json)); assert.ok(redirect.headers.location);
    return JSON.parse(compose('exec','-T','api','node','-e',`fetch(process.argv[1]).then(async response=>{const body=Buffer.from(await response.arrayBuffer());console.log(JSON.stringify({status:response.status,encoding:response.headers.get('content-encoding'),contentType:response.headers.get('content-type'),bytes:body.length}))}).catch(error=>{console.error(error);process.exit(1)})`,redirect.headers.location));
  };
  const normalDxf=`0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nLED_FIXTURE\n10\n0\n20\n0\n0\nCIRCLE\n5\nB1\n8\nSYMBOL\n10\n0\n20\n0\n40\n1\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nW1\n8\nWALL\n10\n0\n20\n0\n11\n20\n21\n20\n0\nINSERT\n5\nI1\n8\nLIGHTING\n2\nLED_FIXTURE\n10\n10\n20\n10\n0\nINSERT\n5\nI2\n8\nLIGHTING\n2\nLED_FIXTURE\n10\n15\n20\n10\n0\nENDSEC\n0\nEOF\n`;
  const memoryBefore=compose('exec','-T','api','sh','-ec','cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes').trim();
  const sidecarMemoryBefore=compose('exec','-T','cad-converter','sh','-ec','cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes').trim();
  const normal=await createJob(normalDxf);
  const review=await waitForJob(normal.jobId,['review_required','failed']);
  assert.equal(review.status,'review_required',JSON.stringify(review));
  assert.equal(review.detectorProfileId,'generic-lighting-v1'); assert.equal(review.sourceAssetId,normal.assetId);
  const candidates=await jsonRequest('GET',`${origin}/api/floors/${seeded.floorId}/import-jobs/${normal.jobId}/candidates`);
  assert.equal(candidates.status,200,JSON.stringify(candidates.json)); assert.ok(candidates.json.candidates.length>=1);
  assert.equal(sql('SELECT count(*) FROM "Fixture"'),'0');
  const content=await fetchSignedContent(review.renderedAssetId);
  assert.equal(content.status,200); assert.equal(content.encoding,'gzip'); assert.match(content.contentType,/image\/svg\+xml/); assert.ok(content.bytes>0);
  const lease=await jsonRequest('POST',`${origin}/api/floors/${seeded.floorId}/editor-lease`,{});
  assert.equal(lease.status,201,JSON.stringify(lease.json)); assert.equal(lease.json.editable,true);
  const applied=await jsonRequest('POST',`${origin}/api/floors/${seeded.floorId}/import-jobs/${normal.jobId}/apply`,{
    expectedRevision:0,leaseToken:lease.json.token,leaseFence:lease.json.fence,candidateIds:candidates.json.candidates.map(candidate=>candidate.id)
  });
  assert.equal(applied.status,200,JSON.stringify(applied.json)); assert.equal(applied.json.status,'completed'); assert.equal(applied.json.revision,1);
  assert.equal(sql('SELECT count(*) FROM "Fixture"'),'0'); assert.equal(sql('SELECT count(*) FROM "MeshNode"'),'0');
  const appliedContent=await fetchSignedContent(review.renderedAssetId); assert.equal(appliedContent.encoding,'gzip');
  const malformed=await createJob('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\nbad\n0\nENDSEC\n0\nEOF\n');
  assert.equal((await waitForJob(malformed.jobId,['failed'],45000)).failureCode,'CAD_IMPORT_PARSE_FAILED');
  assert.equal((await request(`${origin}/api/health/live`)).status,200);
  const memoryBomb=await createJob('MEMORY_BOMB\n');
  assert.equal((await waitForJob(memoryBomb.jobId,['failed'],45000)).failureCode,'CAD_IMPORT_CONVERSION_FAILED');
  const outputBomb=await createJob('OUTPUT_BOMB\n');
  assert.equal((await waitForJob(outputBomb.jobId,['failed'],45000)).failureCode,'CAD_IMPORT_CONVERSION_FAILED');
  const timeoutBomb=await createJob('TIMEOUT\n');
  assert.equal((await waitForJob(timeoutBomb.jobId,['failed'],45000)).failureCode,'CAD_IMPORT_CONVERSION_FAILED');
  assert.equal((await request(`${origin}/api/health/live`)).status,200);
  assert.equal((await request(`${origin}/api/health/ready`)).status,200);
  assert.equal(compose('ps','-q','api').trim(),apiId);
  assert.equal(compose('ps','-q','cad-converter').trim(),sidecarId);
  const retried=await createJob(normalDxf);
  assert.equal((await waitForJob(retried.jobId,['review_required','failed'],45000)).status,'review_required');
  const memoryAfter=compose('exec','-T','api','sh','-ec','cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes').trim();
  const sidecarMemoryAfter=compose('exec','-T','cad-converter','sh','-ec','cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes').trim();
  log(`VERIFY CAD production-path=Nest-provider+worker+sidecar+converter+core+PG+MinIO HTTP=create/status/candidates/content/apply candidate-auto-register=false content-encoding=gzip api-memory=${memoryBefore}->${memoryAfter}/${cadCgroupMemory} sidecar-memory=${sidecarMemoryBefore}->${sidecarMemoryAfter}/${sidecarCgroupMemory} malformed=failed MEMORY_BOMB=bounded OUTPUT_BOMB=bounded TIMEOUT=bounded api-parent-survived=true sidecar-ready=true reprocessing=review_required`);
  const originalDevice=readFileSync(path.join(dir,'api-tls/device.crl'));
  const originalMqtt=readFileSync(path.join(dir,'mqtt-tls/mqtt-client.crl'));
  openssl('ca','-gencrl','-config','ca.cnf','-out','next.crl');
  const nextCrl=readFileSync(path.join(dir,'next.crl'));
  assert.notEqual(digest(nextCrl),digest(originalDevice));
  // Invoke the existing production writer inside the real non-root API image.
  // Its fsync + same-directory atomic rename must succeed on both volumes.
  run('docker',['compose','-p',project,'-f',path.join(dir,'rendered.json'),'exec','-T','api','node','-e',"const fs=require('fs');const {publishCrlAtomically,trustedRootCrlFromBundle}=require('./dist/src/pki/crl-publisher');const pem=fs.readFileSync(0,'utf8');const root=trustedRootCrlFromBundle(fs.readFileSync(process.env.PKI_ROOT_CRL_PATH,'utf8'));Promise.all([publishCrlAtomically(process.env.API_DEVICE_CRL_PATH,pem,root),publishCrlAtomically(process.env.MQTT_CLIENT_CRL_PATH,pem,root)]).then(r=>{if(!r.every(v=>v.changed))process.exit(1)}).catch(()=>process.exit(1));"],{input:nextCrl,stdio:['pipe','pipe','pipe']});
  const publishedBundle=Buffer.from(`${nextCrl.toString().trim()}\n${readFileSync(path.join(dir,'root.crl'),'utf8').trim()}\n`);
  const publishedHash=compose('exec','-T','mqtt-tls','sha256sum','/mosquitto/crls/mqtt-client.crl').trim().split(/\s/)[0];
  assert.equal(publishedHash,digest(publishedBundle));
  assert.equal(compose('exec','-T','api','node','-e',"console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.env.API_DEVICE_CRL_PATH)).digest('hex'))").trim(),digest(publishedBundle));
  compose('exec','-T','mqtt-tls','sh','-c','test ! -w /mosquitto/crls/mqtt-client.crl');
  compose('run','--rm','--no-deps','crl-init');
  assert.equal(compose('exec','-T','mqtt-tls','sha256sum','/mosquitto/crls/mqtt-client.crl').trim().split(/\s/)[0],digest(publishedBundle));
  assert.equal(digest(readFileSync(path.join(dir,'api-tls/device.crl'))),digest(originalDevice));
  assert.equal(digest(readFileSync(path.join(dir,'mqtt-tls/mqtt-client.crl'))),digest(originalMqtt));
  compose('kill','--signal','SIGHUP','mqtt-tls');
  assert.equal((await request(`${origin}/api/health/ready`)).status,200);
  log('VERIFY CRL atomic-publish=2 consumers=matching broker=read-only seed=unchanged init-rerun=no-rollback reload=200');
  // Change only this disposable nginx's writable tmpfs config. A wrong upstream
  // certificate identity must fail closed; restore it before dependency testing.
  try {
    compose('exec','-T','web','sh','-ec',"sed -i 's/proxy_ssl_name api;/proxy_ssl_name wrong.invalid;/' /etc/nginx/conf.d/default.conf; nginx -s reload");
    await wait(async()=>{try{return (await request(`${origin}/api/health/ready`)).status===502}catch{return false}},'upstream identity rejection');
  } finally {
    compose('exec','-T','web','sh','-ec',"sed -i 's/proxy_ssl_name wrong.invalid;/proxy_ssl_name api;/' /etc/nginx/conf.d/default.conf; nginx -s reload");
  }
  await wait(async()=>{try{return (await request(`${origin}/api/health/ready`)).status===200}catch{return false}},'upstream identity recovery');
  log('VERIFY upstream-certificate wrong-identity=502 restored-identity=200');
  compose('stop','redis');
  await wait(async()=>{const r=await request(`${origin}/api/health/ready`);return r.status===503&&JSON.parse(r.body).checks.redis==='down'},'dependency failure');
  assert.equal((await request(`${origin}/api/health/live`)).status,200);
  const webId=compose('ps','-q','web').trim();
  const health=JSON.parse(run('docker',['inspect',webId]))[0].Config.Healthcheck.Test;
  const healthCommand=health[0]==='CMD-SHELL'?['sh','-c',health[1]]:health.slice(1);
  assert.throws(()=>run('docker',['exec',webId,...healthCommand]));
  compose('start','redis');
  await wait(async()=>{try{return (await request(`${origin}/api/health/ready`)).status===200}catch{return false}},'dependency recovery');
  log('VERIFY redis-stop ready=503 live=200 web-healthcheck=nonzero redis-start ready=200');
} catch(error) {
  let diagnostic=compose('logs','--no-color','api-migrate','cad-converter','api','web');
  write('containers.log',diagnostic);
  for(const value of [token,password,redisPassword,env.OBJECT_STORAGE_ACCESS_KEY,env.OBJECT_STORAGE_SECRET_KEY]) diagnostic=diagnostic.replaceAll(value,'[REDACTED]');
  log(diagnostic.slice(-5000));
  throw error;
}
NODE
