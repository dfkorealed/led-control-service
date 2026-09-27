import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requireRule = (condition, rule) => { if (!condition) throw new Error(`Production configuration rejected: ${rule}`); };
const repositoryRoot = path.resolve(import.meta.dirname, '..');

function validConverterArgv(value) {
  try {
    const argv=JSON.parse(value);
    if(!Array.isArray(argv) || argv.length===0 || argv.some(argument=>typeof argument!=='string' || !argument || /[;|&`<>\r\n]|\$\(/.test(argument))) return false;
    const template=argv.join('\0');
    return (template.match(/\{input\}/g)??[]).length===1 && (template.match(/\{output\}/g)??[]).length===1;
  } catch { return false; }
}

function validateProductionProject(project) {
  const defaultProject = path.basename(repositoryRoot).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  requireRule(typeof project === 'string' && /^led-production-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project) && project.length <= 63 && project !== defaultProject && !['led-production-default', 'led-production-dev', 'led-production-development'].includes(project), 'production project identifier');
}

// Render and up share this exact argument prefix: no default checkout project
// or developer COMPOSE_PROJECT_NAME may select existing containers or volumes.
export function productionComposeArguments(project, envFile) {
  validateProductionProject(project);
  requireRule(typeof envFile === 'string' && envFile.length > 0, 'explicit env-file');
  return ['compose', '-p', project, '--env-file', path.resolve(envFile), '-f', path.join(repositoryRoot, 'docker-compose.production.yml')];
}

export function validateProductionConfig(config, {smokeProject}={}) {
  validateProductionProject(config.name);
  for (const volume of Object.values(config.volumes ?? {})) {
    requireRule(!volume.external && volume.name?.startsWith(`${config.name}_`), 'project-scoped named volumes');
  }
  const s=config.services;
  requireRule(s?.api && s?.web && s?.['api-migrate'] && s?.['cad-converter'], 'required app services');
  for(const [name, service] of Object.entries(s)) {
    const smokeId=/^led-production-smoke-([a-f0-9]{32})$/.exec(smokeProject??'')?.[1];
    const localSmoke=smokeId && service.image===`${smokeProject}-${name==='web'?'web':'api'}:sha-${smokeId}`;
    requireRule(localSmoke || (typeof service.image==='string' && /(?:@sha256:[a-f0-9]{64}$|:\d+\.\d+\.\d+(?:-alpine(?:\d+\.\d+)?)?$|:16\.\d+-alpine\d+\.\d+$|:RELEASE\.\d{4}-\d{2}-\d{2}T[\d-]+Z$)/.test(service.image)), 'versioned image reference');
    // Only the disposable harness may use its unique local build tags. Deployed
    // API/Web references require content digests; even commit tags can be moved.
    if(['api','api-migrate','crl-init','cad-converter','web'].includes(name)) requireRule(localSmoke || /@sha256:[a-f0-9]{64}$/.test(service.image),'immutable application image reference');
    requireRule(name==='web' || !service.ports?.length, 'only Web may publish ports');
    requireRule(service.read_only===true && service.cap_drop?.includes('ALL') && service.security_opt?.includes('no-new-privileges:true'), 'container privilege boundary');
    requireRule((service.volumes??[]).every(m=>m.type!=='bind'||m.read_only===true),'read-only host mounts');
    if(!['api-migrate','object-storage-init','crl-init'].includes(name)) requireRule(service.healthcheck?.test?.length && !service.healthcheck.disable && !/(?:^|\s)true(?:$|\s)|\|\||exit 0/.test(service.healthcheck.test.join(' ')), 'required failing healthcheck');
  }
  for(const name of ['api','api-migrate','cad-converter','web']) requireRule(/^(1000|2000|101)(:\d+)?$/.test(s[name].user),'non-root application runtime');
  const ingressSecret = s.api.environment.LANDING_INGRESS_SECRET;
  requireRule(typeof ingressSecret === 'string' && /^[a-f0-9]{64}$/.test(ingressSecret) &&
    s.web.environment.LANDING_INGRESS_SECRET === ingressSecret, 'landing ingress shared secret');
  requireRule(!s.api.environment.API_TRUST_PROXY, 'landing ingress excludes global proxy trust');
  requireRule(s.api.environment.WEB_PUBLIC_URL === s.web.environment.WEB_HTTPS_ORIGIN, 'landing ingress canonical Web origin');
  requireRule(s.api.image===s['api-migrate'].image,'identical migration and API image');
  requireRule(s.api.depends_on?.['api-migrate']?.condition==='service_completed_successfully','migration before API');
  // The base deployment has no reviewed generation-specific mounts or all-node
  // admission/census proof. Variables are preparation, never activation evidence.
  requireRule(s.api.environment.COMMAND_SET_EGRESS_ENABLED==='0','Set egress cutover remains disabled');
  // The stock Compose path has no live DB readiness proof attached to this
  // immutable release. Keep the read flag OFF until that deploy gate is wired.
  requireRule(s.api.environment.COMMAND_HISTORY_RETENTION_ENABLED==='0','command history read activation requires DB readiness evidence');
  // Stock Mosquitto has no immutable generation admission/CA ledger. Neither
  // restored ACL/CRL files nor disposable evidence can authorize production.
  requireRule(s.api.environment.COMMAND_RETENTION_PURGE_ENABLED===undefined || s.api.environment.COMMAND_RETENTION_PURGE_ENABLED==='0','stock broker immutable admission unavailable; retention purge remains disabled');
  requireRule(s.api.depends_on?.['cad-converter']?.condition==='service_healthy','ready converter sidecar before API');
  requireRule(s.web.depends_on?.api?.condition==='service_healthy','ready API before Web');
  requireRule((s.web.ports ?? []).map(port => port.target).sort().join(',') === '8080,8443,9443', 'Web browser and raw device TLS listeners');
  requireRule(s['crl-init']?.image===s.api.image && s.api.depends_on?.['crl-init']?.condition==='service_completed_successfully' && s['mqtt-tls'].depends_on?.['crl-init']?.condition==='service_completed_successfully','CRL initialization before consumers');
  for(const source of ['device-crl','mqtt-crl']) {
    const writers=Object.entries(s).filter(([,service])=>(service.volumes??[]).some(m=>m.source===source&&!m.read_only)).map(([name])=>name).sort();
    requireRule(writers.join(',')==='api,crl-init','only API and initializer may write dynamic CRLs');
  }
  requireRule(s.api.environment.NODE_ENV==='production' && s.api.environment.PKI_PROVIDER==='vault','production TLS and Vault');
  requireRule(String(s.api.mem_limit)==='1476395008' && s.api.environment.NODE_OPTIONS==='--max-old-space-size=256' && s.api.environment.CAD_CORE_MAX_OLD_SPACE_MB==='384' && s.api.environment.CAD_IMPORT_MAX_CONCURRENT_JOBS==='1' && s.api.environment.CAD_CGROUP_REQUIRED==='1','bounded CAD API/core resources');
  const converter=s['cad-converter'];
  requireRule(String(converter.mem_limit)==='1073741824' && converter.environment.NODE_OPTIONS==='--max-old-space-size=64' && String(converter.pids_limit)==='64','bounded CAD sidecar resources');
  requireRule(converter.network_mode==='none' && !converter.networks && converter.user==='2000:2000' && s.api.user==='1000:2000' && !converter.pid && !s.api.pid,'isolated CAD sidecar process and network namespaces');
  requireRule(s.api.environment.CAD_IMPORT_CONVERTER_MODE==='sidecar' && s.api.environment.CAD_IMPORT_CONVERTER_SPOOL_ROOT==='/run/cad-converter-spool' && /^[a-f0-9]{64}$/.test(s.api.environment.CAD_IMPORT_CONVERTER_SHA256??'') && s.api.environment.CAD_IMPORT_TEMP_ROOT==='/tmp/cad-import','approved CAD sidecar API environment');
  requireRule(!('CAD_IMPORT_CONVERTER_EXECUTABLE' in s.api.environment) && !('CAD_IMPORT_CONVERTER_ARGV_JSON' in s.api.environment),'API excludes converter executable configuration');
  requireRule(converter.environment.CAD_IMPORT_CONVERTER_EXECUTABLE==='/opt/cad-converter/bin/converter' && validConverterArgv(converter.environment.CAD_IMPORT_CONVERTER_ARGV_JSON) && converter.environment.CAD_IMPORT_CONVERTER_SHA256===s.api.environment.CAD_IMPORT_CONVERTER_SHA256 && converter.environment.CAD_IMPORT_CONVERTER_SPOOL_ROOT==='/run/cad-converter-spool','approved CAD converter sidecar environment');
  requireRule(String(converter.environment.CAD_IMPORT_MAX_DXF_BYTES)==='268435456' && String(converter.environment.CAD_IMPORT_CONVERTER_TIMEOUT_MS)==='60000' && String(s.api.environment.CAD_IMPORT_CONVERTER_CLIENT_TIMEOUT_MS)==='65000','exact CAD converter size and timeout contract');
  const allowedConverterEnvironment=new Set(['NODE_ENV','NODE_OPTIONS','CAD_IMPORT_CONVERTER_EXECUTABLE','CAD_IMPORT_CONVERTER_ARGV_JSON','CAD_IMPORT_CONVERTER_SHA256','CAD_IMPORT_CONVERTER_SPOOL_ROOT','CAD_IMPORT_CONVERTER_TIMEOUT_MS','CAD_IMPORT_MAX_DXF_BYTES']);
  requireRule(Object.keys(converter.environment).every(key=>allowedConverterEnvironment.has(key)),'credential-free CAD sidecar environment');
  const converterMount=(converter.volumes??[]).find(m=>m.target==='/opt/cad-converter');
  const cadTempMount=(s.api.tmpfs??[]).find(m=>m.split(':')[0]==='/tmp/cad-import');
  const cadTempOptions=new Set(cadTempMount?.split(':').slice(1).join(':').split(',')??[]);
  requireRule(s.api.environment.CAD_IMPORT_TEMP_VOLUME_BYTES==='536870912' && cadTempOptions.has('uid=1000') && cadTempOptions.has('gid=2000') && cadTempOptions.has('mode=0700') && cadTempOptions.has('size=536870912'),'bounded writable CAD temporary storage');
  requireRule(converterMount?.type==='bind' && path.isAbsolute(converterMount.source) && converterMount.read_only===true && converterMount.bind?.create_host_path===false,'approved CAD converter read-only bundle');
  requireRule(!(s.api.volumes??[]).some(m=>m.target==='/opt/cad-converter'),'converter bundle absent from API');
  const apiSpool=(s.api.volumes??[]).find(m=>m.target==='/run/cad-converter-spool');
  const sidecarSpool=(converter.volumes??[]).find(m=>m.target==='/run/cad-converter-spool');
  requireRule(apiSpool?.type==='volume' && sidecarSpool?.type==='volume' && apiSpool.source===sidecarSpool.source,'single shared CAD job spool');
  const spoolVolume=(config.volumes??{})[apiSpool?.source]??Object.values(config.volumes??{}).find(volume=>volume.name===apiSpool?.source);
  const spoolOptions=new Set(String(spoolVolume?.driver_opts?.o??'').split(','));
  requireRule(spoolVolume?.driver==='local'&&spoolVolume?.driver_opts?.type==='tmpfs'&&spoolVolume?.driver_opts?.device==='tmpfs'&&['uid=1000','gid=2000','mode=0770','size=402653184'].every(option=>spoolOptions.has(option)),'bounded shared CAD spool');
  requireRule((converter.volumes??[]).every(m=>['/opt/cad-converter','/run/cad-converter-spool'].includes(m.target)),'sidecar mounts only bundle and job spool');
  const sidecarTmpfs=(converter.tmpfs??[]).find(m=>m.startsWith('/tmp:'));
  requireRule(['uid=2000','gid=2000','mode=0700','size=67108864'].every(option=>sidecarTmpfs?.split(/[:,]/).includes(option)),'bounded sidecar temporary storage');
  for(const key of ['VAULT_ADDR','WEB_PUBLIC_URL']) requireRule(/^https:\/\//.test(s.api.environment[key]??''), `${key} HTTPS scheme`);
  requireRule(/^mqtts:\/\//.test(s.api.environment.MQTT_URL??''),'MQTT_URL mTLS scheme');
  requireRule(/^https:\/\//.test(s.web.environment.WEB_HTTPS_ORIGIN??''),'WEB_HTTPS_ORIGIN HTTPS scheme');
}

export function attestConverterBundleHost(bundlePath, approvedDigest) {
  requireRule(typeof bundlePath==='string' && path.isAbsolute(bundlePath),'absolute converter bundle path');
  requireRule(typeof approvedDigest==='string' && /^[a-f0-9]{64}$/.test(approvedDigest),'approved converter SHA-256');
  const binPath=path.join(bundlePath,'bin');
  const executable=path.join(binPath,'converter');
  let bundle; let bin; let file;
  try { bundle=lstatSync(bundlePath); bin=lstatSync(binPath); file=lstatSync(executable); }
  catch { throw new Error('Production configuration rejected: converter host executable attestation'); }
  requireRule(bundle.isDirectory()&&!bundle.isSymbolicLink()&&bin.isDirectory()&&!bin.isSymbolicLink()&&file.isFile()&&!file.isSymbolicLink(),'converter host regular executable');
  requireRule(bundle.uid===bin.uid&&bin.uid===file.uid&&(bundle.mode&0o022)===0&&(bin.mode&0o022)===0&&(file.mode&0o022)===0&&(file.mode&0o100)!==0&&(file.mode&0o111)!==0,'converter host owner and mode policy');
  const actual=createHash('sha256').update(readFileSync(executable)).digest('hex');
  requireRule(actual===approvedDigest,'converter host approved digest');
  return {executable,digest:actual,uid:file.uid,mode:file.mode&0o777};
}

// Explicit env-file values take precedence over a developer shell. Never print
// docker config output/errors: URL/password values may occur in either stream.
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action, projectFlag, project, envFlag, envFile, ...extra]=process.argv.slice(2);
    requireRule(['up','check'].includes(action)&&projectFlag==='--project'&&envFlag==='--env-file'&&!extra.length,'explicit action, project and env-file');
    const args=productionComposeArguments(project, envFile);
    const env={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT,PRODUCTION_COMPOSE_PROJECT:project};
    const rendered=spawnSync('docker',[...args,'config','--format','json'],{env,encoding:'utf8'});
    requireRule(rendered.status===0,'Compose render and required inputs');
    const config=JSON.parse(rendered.stdout);
    validateProductionConfig(config);
    const converter=config.services['cad-converter'];
    const bundle=(converter.volumes??[]).find(m=>m.target==='/opt/cad-converter');
    attestConverterBundleHost(bundle?.source,converter.environment.CAD_IMPORT_CONVERTER_SHA256);
    console.log('Production configuration validated; values withheld.');
    if(action==='up') {
      const result=spawnSync('docker',[...args,'up','-d'],{env,stdio:'inherit'});
      process.exitCode=result.status??1;
    }
  } catch(error) { console.error(error.message.startsWith('Production configuration rejected:')?error.message:'Production configuration rejected: invalid configuration'); process.exitCode=1; }
}
