import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requireRule = (condition, rule) => { if (!condition) throw new Error(`Production configuration rejected: ${rule}`); };
const repositoryRoot = path.resolve(import.meta.dirname, '..');

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
  requireRule(s?.api && s?.web && s?.['api-migrate'], 'required app services');
  for(const [name, service] of Object.entries(s)) {
    const smokeId=/^led-production-smoke-([a-f0-9]{32})$/.exec(smokeProject??'')?.[1];
    const localSmoke=smokeId && service.image===`${smokeProject}-${name==='web'?'web':'api'}:sha-${smokeId}`;
    requireRule(localSmoke || (typeof service.image==='string' && /(?:@sha256:[a-f0-9]{64}$|:\d+\.\d+\.\d+(?:-alpine(?:\d+\.\d+)?)?$|:16\.\d+-alpine\d+\.\d+$|:RELEASE\.\d{4}-\d{2}-\d{2}T[\d-]+Z$)/.test(service.image)), 'versioned image reference');
    // Only the disposable harness may use its unique local build tags. Deployed
    // API/Web references require content digests; even commit tags can be moved.
    if(['api','api-migrate','crl-init','web'].includes(name)) requireRule(localSmoke || /@sha256:[a-f0-9]{64}$/.test(service.image),'immutable application image reference');
    requireRule(name==='web' || !service.ports?.length, 'only Web may publish ports');
    requireRule(service.read_only===true && service.cap_drop?.includes('ALL') && service.security_opt?.includes('no-new-privileges:true'), 'container privilege boundary');
    requireRule((service.volumes??[]).every(m=>m.type!=='bind'||m.read_only===true),'read-only host mounts');
    if(!['api-migrate','object-storage-init','crl-init'].includes(name)) requireRule(service.healthcheck?.test?.length && !service.healthcheck.disable && !/(?:^|\s)true(?:$|\s)|\|\||exit 0/.test(service.healthcheck.test.join(' ')), 'required failing healthcheck');
  }
  for(const name of ['api','api-migrate','web']) requireRule(/^(1000|101)(:\d+)?$/.test(s[name].user),'non-root application runtime');
  requireRule(s.api.image===s['api-migrate'].image,'identical migration and API image');
  requireRule(s.api.depends_on?.['api-migrate']?.condition==='service_completed_successfully','migration before API');
  requireRule(s.web.depends_on?.api?.condition==='service_healthy','ready API before Web');
  requireRule((s.web.ports ?? []).map(port => port.target).sort().join(',') === '8080,8443,9443', 'Web browser and raw device TLS listeners');
  requireRule(s['crl-init']?.image===s.api.image && s.api.depends_on?.['crl-init']?.condition==='service_completed_successfully' && s['mqtt-tls'].depends_on?.['crl-init']?.condition==='service_completed_successfully','CRL initialization before consumers');
  for(const source of ['device-crl','mqtt-crl']) {
    const writers=Object.entries(s).filter(([,service])=>(service.volumes??[]).some(m=>m.source===source&&!m.read_only)).map(([name])=>name).sort();
    requireRule(writers.join(',')==='api,crl-init','only API and initializer may write dynamic CRLs');
  }
  requireRule(s.api.environment.NODE_ENV==='production' && s.api.environment.PKI_PROVIDER==='vault','production TLS and Vault');
  requireRule(String(s.api.mem_limit)==='805306368' && s.api.environment.NODE_OPTIONS==='--max-old-space-size=256' && s.api.environment.CAD_CORE_MAX_OLD_SPACE_MB==='384' && s.api.environment.CAD_IMPORT_MAX_CONCURRENT_JOBS==='1' && s.api.environment.CAD_CGROUP_REQUIRED==='1','bounded CAD process resources');
  for(const key of ['VAULT_ADDR','WEB_PUBLIC_URL']) requireRule(/^https:\/\//.test(s.api.environment[key]??''), `${key} HTTPS scheme`);
  requireRule(/^mqtts:\/\//.test(s.api.environment.MQTT_URL??''),'MQTT_URL mTLS scheme');
  requireRule(/^https:\/\//.test(s.web.environment.WEB_HTTPS_ORIGIN??''),'WEB_HTTPS_ORIGIN HTTPS scheme');
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
    validateProductionConfig(JSON.parse(rendered.stdout));
    console.log('Production configuration validated; values withheld.');
    if(action==='up') {
      const result=spawnSync('docker',[...args,'up','-d'],{env,stdio:'inherit'});
      process.exitCode=result.status??1;
    }
  } catch(error) { console.error(error.message.startsWith('Production configuration rejected:')?error.message:'Production configuration rejected: invalid configuration'); process.exitCode=1; }
}
