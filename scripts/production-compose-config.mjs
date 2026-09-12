import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requireRule = (condition, rule) => { if (!condition) throw new Error(`Production configuration rejected: ${rule}`); };
export function validateProductionConfig(config, {smokeProject}={}) {
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
  requireRule(s['crl-init']?.image===s.api.image && s.api.depends_on?.['crl-init']?.condition==='service_completed_successfully' && s['mqtt-tls'].depends_on?.['crl-init']?.condition==='service_completed_successfully','CRL initialization before consumers');
  for(const source of ['device-crl','mqtt-crl']) {
    const writers=Object.entries(s).filter(([,service])=>(service.volumes??[]).some(m=>m.source===source&&!m.read_only)).map(([name])=>name).sort();
    requireRule(writers.join(',')==='api,crl-init','only API and initializer may write dynamic CRLs');
  }
  requireRule(s.api.environment.NODE_ENV==='production' && s.api.environment.PKI_PROVIDER==='vault','production TLS and Vault');
  for(const key of ['VAULT_ADDR','WEB_PUBLIC_URL']) requireRule(/^https:\/\//.test(s.api.environment[key]??''), `${key} HTTPS scheme`);
  requireRule(/^mqtts:\/\//.test(s.api.environment.MQTT_URL??''),'MQTT_URL mTLS scheme');
  requireRule(/^https:\/\//.test(s.web.environment.WEB_HTTPS_ORIGIN??''),'WEB_HTTPS_ORIGIN HTTPS scheme');
}

// Explicit env-file values take precedence over a developer shell. Never print
// docker config output/errors: URL/password values may occur in either stream.
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action, flag, envFile]=process.argv.slice(2);
    requireRule(['up','check'].includes(action)&&flag==='--env-file'&&envFile,'explicit action and env-file');
    const env={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT};
    const args=['compose','--env-file',path.resolve(envFile),'-f',path.resolve(import.meta.dirname,'../docker-compose.production.yml')];
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
