import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attestConverterBundleHost, validateProductionConfig } from "./production-compose-config.mjs";
import * as productionConfig from "./production-compose-config.mjs";

const root = path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(root, "docker-compose.production.yml"), "utf8");
const runbook = readFileSync(path.join(root, "docs/runbooks/production-api-web-deployment.md"), "utf8");
const required = ["API_IMAGE", "WEB_IMAGE", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "DATABASE_URL", "REDIS_PASSWORD", "REDIS_URL", "MQTT_URL", "MQTT_PUBLIC_URL", "MQTT_API_INSTANCE_ID", "MQTT_TLS_CERT_DIR", "API_TLS_CERT_DIR", "WEB_TLS_CERT_DIR", "VAULT_ADDR", "VAULT_TOKEN_FILE", "VAULT_CA_CERT_PATH", "VAULT_PKI_DEVICE_MOUNT", "VAULT_PKI_DEVICE_ROLE", "VAULT_PKI_MQTT_MOUNT", "VAULT_PKI_MQTT_ROLE", "OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_REPORT_BUCKET", "OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_PUBLIC_URL", "OBJECT_STORAGE_REGION", "WEB_PUBLIC_URL", "WEB_HTTPS_ORIGIN", "WEB_HTTP_PORT", "WEB_HTTPS_PORT", "CAD_IMPORT_CONVERTER_BUNDLE_PATH", "CAD_IMPORT_CONVERTER_ARGV_JSON", "CAD_IMPORT_CONVERTER_SHA256"];
required.push("PRODUCTION_COMPOSE_PROJECT", "DEVICE_API_HTTPS_PORT");
// Config output is never logged; fixtures cannot inherit shell credentials or .env.
function render(omit, project = "led-production-contract", overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "led-production-contract-"));
  const env = Object.fromEntries(required.map(key => [key, `fixture-${randomBytes(16).toString("hex")}`]));
  Object.assign(env, { API_IMAGE: `led-api@sha256:${'a'.repeat(64)}`, WEB_IMAGE: `led-web@sha256:${'b'.repeat(64)}`, WEB_HTTP_PORT: "18080", WEB_HTTPS_PORT: "18443" });
  Object.assign(env, { PRODUCTION_COMPOSE_PROJECT: project, DEVICE_API_HTTPS_PORT: "19443" });
  Object.assign(env, {VAULT_ADDR:'https://vault.invalid',WEB_PUBLIC_URL:'https://web.invalid',WEB_HTTPS_ORIGIN:'https://web.invalid',MQTT_URL:'mqtts://mqtt-tls:8883'});
  Object.assign(env, overrides);
  env.CAD_IMPORT_CONVERTER_ARGV_JSON = '["--input","{input}","--output","{output}"]';
  for (const key of required.filter(key => /_DIR$|_FILE$|_PATH$/.test(key))) env[key] = dir;
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin/converter"), "approved-converter");
  chmodSync(path.join(dir, "bin/converter"), 0o555);
  env.CAD_IMPORT_CONVERTER_SHA256 = createHash("sha256").update("approved-converter").digest("hex");
  if (omit) delete env[omit];
  const envPath = path.join(dir, "fixture.env");
  writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
  const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  try {
    const result = spawnSync("docker", ["compose", "--project-name", project, "--env-file", envPath, "-f", "docker-compose.production.yml", "config", "--format", "json"], { cwd: root, env: cleanEnv, encoding: "utf8" });
    const preflight = result.status === 0 ? spawnSync(process.execPath, ["--", path.join(root, "scripts/production-compose-config.mjs"), "check", "--project", project, "--env-file", envPath], {env: cleanEnv, encoding: "utf8"}) : undefined;
    return { status: result.status, config: result.status === 0 ? JSON.parse(result.stdout) : undefined, preflight };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("Set egress cutover defaults OFF and production rejects premature activation", () => {
  const baseline = render();
  assert.equal(baseline.status, 0);
  assert.equal(baseline.config.services.api.environment.COMMAND_SET_EGRESS_ENABLED, '0');
  assert.equal(baseline.preflight.status, 0);
  const premature = render(undefined, 'led-production-contract', { COMMAND_SET_EGRESS_ENABLED: '1', MQTT_SET_GENERATION: '7' });
  assert.equal(premature.status, 0);
  assert.equal(premature.config.services.api.environment.COMMAND_SET_EGRESS_ENABLED, '1');
  assert.notEqual(premature.preflight.status, 0);
  assert.match(premature.preflight.stderr, /Set egress cutover remains disabled/);
});

test("command history read activation defaults OFF and requires DB readiness evidence", () => {
  const baseline = render();
  assert.equal(baseline.config.services.api.environment.COMMAND_HISTORY_RETENTION_ENABLED, "0");
  assert.equal(baseline.preflight.status, 0);
  const premature = render(undefined, "led-production-contract", { COMMAND_HISTORY_RETENTION_ENABLED: "1" });
  assert.equal(premature.status, 0);
  assert.equal(premature.preflight.status, 1);
  assert.match(premature.preflight.stderr, /command history read activation requires DB readiness evidence/);
});

test("stock broker cannot authorize purge using a supplied disposable evidence claim", () => {
  const baseline = render();
  assert.equal(baseline.status, 0);
  const config = baseline.config;
  config.services.api.environment.DATABASE_URL = "postgresql://runtime:test-only@postgres:5432/led_control";
  config.services["api-migrate"].environment.DATABASE_URL = "postgresql://migrator:test-only@postgres:5432/led_control";
  config.services.api.environment.COMMAND_RETENTION_PURGE_ENABLED = "1";
  // Even a falsely labeled environment claim is not an immutable admission
  // adapter. The base stock deployment must reject this configuration outright.
  config.services.api.environment.BROKER_FENCE_EVIDENCE = JSON.stringify({ status: "verified", scope: "disposable", productionPurgeAllowed: false });
  assert.throws(() => validateProductionConfig(config), /retention purge remains disabled/);
});


test("standalone config renders all services and migration → API → Web gates", () => {
  const result = render();
  assert.equal(result.status, 0, "standalone config must render without development Compose");
  const s = result.config.services;
  assert.deepEqual(Object.keys(s).sort(), ["api", "api-migrate", "cad-converter", "crl-init", "mqtt-tls", "object-storage", "object-storage-init", "postgres", "redis", "web"]);
  assert.equal(s.api.image, s["api-migrate"].image);
  assert.equal(s.api.depends_on["api-migrate"].condition, "service_completed_successfully");
  assert.equal(s.web.depends_on.api.condition, "service_healthy");
  assert.match(s["api-migrate"].command.join(" "), /node .*prisma.* migrate deploy/);
  assert.equal(s.api.environment.NODE_ENV, "production");
  assert.equal(s.api.environment.PKI_PROVIDER, "vault");
  assert.equal(s.api.mem_limit, "1476395008");
  assert.equal(s.api.environment.NODE_OPTIONS, "--max-old-space-size=256");
  assert.equal(s.api.environment.CAD_CORE_MAX_OLD_SPACE_MB, "384");
  assert.equal(s.api.environment.CAD_IMPORT_MAX_CONCURRENT_JOBS, "1");
  assert.equal(s.api.environment.CAD_CGROUP_REQUIRED, "1");
  assert.equal(s.api.environment.CAD_IMPORT_CONVERTER_MODE, "sidecar");
  assert.equal(s.api.environment.CAD_IMPORT_CONVERTER_EXECUTABLE, undefined);
  assert.equal(s.api.environment.CAD_IMPORT_CONVERTER_ARGV_JSON, undefined);
  assert.equal(s.api.environment.CAD_IMPORT_TEMP_ROOT, "/tmp/cad-import");
  assert.equal(s.api.environment.CAD_IMPORT_TEMP_VOLUME_BYTES, "536870912");
  const cadTemp=s.api.tmpfs.find(mount=>mount.startsWith("/tmp/cad-import:"));
  for(const option of ["uid=1000","gid=2000","mode=0700","size=536870912"]) assert.ok(cadTemp.split(/[:,]/).includes(option));
  assert.equal(s.api.volumes.find(mount => mount.target === "/opt/cad-converter"), undefined);
  assert.equal(s["cad-converter"].network_mode, "none");
  assert.equal(s["cad-converter"].user, "2000:2000");
  assert.equal(s["cad-converter"].mem_limit, "1073741824");
  assert.equal(s["cad-converter"].environment.NODE_OPTIONS, "--max-old-space-size=64");
  assert.equal(s["cad-converter"].environment.CAD_IMPORT_CONVERTER_ARGV_JSON, '["--input","{input}","--output","{output}"]');
  assert.deepEqual(s["cad-converter"].volumes.find(mount => mount.target === "/opt/cad-converter"), {
    type: "bind",
    source: path.resolve(s["cad-converter"].volumes.find(mount => mount.target === "/opt/cad-converter").source),
    target: "/opt/cad-converter",
    read_only: true,
    bind: { create_host_path: false }
  });
});

test("every credential, URL, PKI path and image fails render when omitted", () => {
  assert.equal(render().status, 0, "missing-variable cases require a valid positive control");
  for (const key of required) assert.notEqual(render(key).status, 0, `${key} must be required without defaults`);
});

test("Web receives only the upstream CA, never API or MQTT private keys", () => {
  const {config} = render();
  assert.ok(config);
  const targets=config.services.web.volumes.map(m=>m.target);
  assert.deepEqual(targets.sort(), ['/run/api-tls/api-ca.crt','/run/web-tls'].sort());
  assert.ok(config.services.api.volumes.every(m=>m.target !== '/run/mqtt-tls'));
});

test("rendered services confine ports to Web and harden filesystem, privileges and health", () => {
  const { config } = render();
  assert.ok(config, "standalone production definition is missing");
  for (const [name, service] of Object.entries(config.services)) {
    if (name !== "web") assert.equal(service.ports?.length ?? 0, 0, `${name} exposes a host port`);
    assert.doesNotMatch(service.image, /:latest$|:(?:\d+|\d+-alpine|\d+\.\d+-alpine)$/);
    assert.match(service.image, /(?:@sha256:|:(?:\d+\.\d+\.\d+|16\.\d+-alpine\d+\.\d+|RELEASE\.))/);
    assert.equal(service.read_only, true, `${name} must have a read-only root`);
    assert.ok(service.cap_drop.includes("ALL"));
    assert.ok(service.security_opt.includes("no-new-privileges:true"));
    assert.ok(service.mem_limit && service.pids_limit && service.stop_grace_period);
    assert.ok(service.restart);
    for (const mount of service.tmpfs ?? []) assert.ok(mount.startsWith('/'), `${name} tmpfs must remain one absolute mount after YAML parsing`);
    for (const mount of service.volumes ?? []) if (mount.type === "bind") assert.equal(mount.read_only, true, `${name} writable host mount`);
    if (!["api-migrate", "object-storage-init", "crl-init"].includes(name)) {
      assert.ok(service.healthcheck?.test?.length, `${name} healthcheck missing`);
      assert.doesNotMatch(service.healthcheck.test.join(" "), /\|\| true|exit 0|CMD true/);
    }
  }
  for (const name of ["api", "api-migrate", "cad-converter", "web"]) assert.match(config.services[name].user, /^(?:1000|2000|101)(?::\d+)?$/);
  assert.match(config.services.api.healthcheck.test.join(" "), /health\/ready/);
  assert.match(config.services.web.healthcheck.test.join(" "), /api\/health\/ready/);
  assert.match(config.services.web.healthcheck.test.join(" "), /WEB_HTTPS_ORIGIN/, 'health must verify the public certificate hostname, not require a private web SAN');
  assert.deepEqual(config.services.web.ports.map(port => port.target).sort(), [8080, 8443, 9443]);
});

test("production project is explicit, validated and separates every volume from development", () => {
  assert.equal(typeof productionConfig.productionComposeArguments, "function", "production up must bind render and start to one explicit project");
  for (const project of [undefined, "", "default", "led-control-service", path.basename(root), "led-production-default", "led-production-dev", "led-production-", "led-production-UPPER", "led-production-main;echo-secret"]) {
    assert.throws(() => productionConfig.productionComposeArguments(project, "/fixture.env"), /production project identifier/);
  }
  const args = productionConfig.productionComposeArguments("led-production-contract", "/fixture.env");
  assert.deepEqual(args.slice(0, 3), ["compose", "-p", "led-production-contract"]);
  const rendered = render();
  assert.equal(rendered.preflight.status, 0);
  assert.equal(rendered.preflight.stdout.trim(), "Production configuration validated; values withheld.");
  assert.equal(rendered.preflight.stderr, "");
  const first = rendered.config;
  const second = render(undefined, "led-production-other").config;
  const dev = JSON.parse(execFileSync("docker", ["compose", "--env-file", "/dev/null", "-f", "docker-compose.yml", "config", "--format", "json"], {cwd: root, encoding: "utf8", env: {PATH: process.env.PATH, HOME: process.env.HOME}}));
  assert.notEqual(first.name, dev.name);
  for (const [key, volume] of Object.entries(first.volumes)) {
    assert.ok(volume.name.startsWith("led-production-contract_"));
    assert.notEqual(volume.name, dev.volumes[key]?.name);
    assert.notEqual(volume.name, second.volumes[key].name);
  }
});

test("production CLI rejects absent or unsafe projects before render/up without echoing inputs", () => {
  const cli = path.join(root, "scripts/production-compose-config.mjs");
  for (const action of ["check", "up"]) {
    for (const project of ["", path.basename(root), "led-production-invalid;SENSITIVE_INPUT"]) {
      const result = spawnSync(process.execPath, ["--", cli, action, "--project", project, "--env-file", "/nonexistent-private.env"], {encoding: "utf8"});
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), "Production configuration rejected: production project identifier");
    }
    const missing = spawnSync(process.execPath, ["--", cli, action, "--env-file", "/nonexistent-private.env"], {encoding: "utf8"});
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), "Production configuration rejected: explicit action, project and env-file");
  }
});

test("only CRL initialization and the API can write dynamic CRL volumes; secrets stay read-only", () => {
  const {config}=render();
  const s=config.services;
  assert.ok(s['crl-init']);
  assert.equal(s.api.depends_on['crl-init'].condition,'service_completed_successfully');
  assert.equal(s['mqtt-tls'].depends_on['crl-init'].condition,'service_completed_successfully');
  const names=['device-crl','mqtt-crl'];
  for(const name of names) {
    const writers=Object.entries(s).filter(([,service])=>(service.volumes??[]).some(m=>m.source===name&&!m.read_only)).map(([name])=>name).sort();
    assert.deepEqual(writers,['api','crl-init']);
  }
  assert.ok(s['mqtt-tls'].volumes.some(m=>m.source==='mqtt-crl'&&m.read_only));
  assert.equal(s.api.environment.API_DEVICE_CRL_PATH,'/run/device-crl/device.crl');
  assert.equal(s.api.environment.MQTT_CLIENT_CRL_PATH,'/run/mqtt-crl/mqtt-client.crl');
  assert.equal(s.api.environment.PKI_ROOT_CRL_PATH,'/run/api-tls/device.crl');
  assert.equal(s.api.environment.API_MANUFACTURING_CRL_PATH,'/run/api-tls/manufacturing.crl');
});

test("floor assets and generated reports remain private in object storage", () => {
  const { config } = render();
  const command = config.services["object-storage-init"].command.join(" ");
  assert.equal((command.match(/mc anonymous set none/g) ?? []).length, 2);
  assert.doesNotMatch(command, /mc anonymous set download/);
  assert.equal(config.services["object-storage"].environment.MINIO_API_CORS_ALLOW_ORIGIN, "https://web.invalid");
  assert.doesNotMatch(runbook, /도면 bucket은 공개 download/);
});

test("production source and commands exclude dev credentials, PEM and merged defaults", () => {
  assert.doesNotMatch(source, /\$\{[^}]+:-|change-this-local-secret|POSTGRES_PASSWORD:\s*led|BEGIN (?:RSA |EC )?PRIVATE KEY/);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  assert.doesNotMatch(pkg.scripts["docker:up:production"], /-f docker-compose\.yml/);
  assert.match(pkg.scripts["docker:up:production"], /PRODUCTION_ENV_FILE:\?/);
  assert.match(pkg.scripts["docker:up:production"], /--project.*PRODUCTION_COMPOSE_PROJECT:\?/);
  assert.ok(pkg.scripts["production:contract"]);
  assert.ok(pkg.scripts["production:smoke"]);
});

test("production audit requires Docker, Compose, contracts and actual smoke", () => {
  execFileSync("docker", ["version"], { stdio: "pipe" });
  execFileSync("docker", ["compose", "version"], { stdio: "pipe" });
  const script = readFileSync(path.join(root, "scripts/ci-production-audit.sh"), "utf8");
  assert.match(script, /pnpm production:contract/);
  assert.match(script, /pnpm production:smoke/);
  assert.doesNotMatch(script, /t\.skip|Docker unavailable|\|\| true/);
  const smoke = readFileSync(path.join(root, "scripts/production-compose-smoke.sh"), "utf8");
  assert.match(smoke, /docker container ls -aq --filter/, "cleanup proof must include stopped containers");
});

test("production smoke traverses the real CAD Nest worker path and adversarial converter cases", () => {
  const smoke = readFileSync(path.join(root, "scripts/production-compose-smoke.sh"), "utf8");
  for (const contract of [
    "CAD_IMPORT_CONVERTER_BUNDLE_PATH",
    "CAD_IMPORT_CONVERTER_ARGV_JSON",
    "CAD_IMPORT_CONVERTER_SHA256",
    "cad-converter",
    "/import-jobs",
    "/candidates",
    "/content",
    "content-encoding",
    "MEMORY_BOMB",
    "OUTPUT_BOMB",
    "TIMEOUT",
    "malformed",
    "statfsSync",
    "536870912",
    "api-parent-survived"
  ]) assert.match(smoke, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("deployment preflight rejects mutable app images and every unsafe rendered mutation", () => {
  const {config} = render();
  assert.doesNotThrow(()=>validateProductionConfig(config));
  const mutations = [
    c=>{c.name=path.basename(root)},
    c=>{c.volumes['postgres-data'].name='led-control-service_postgres-data'},
    c=>{c.volumes['postgres-data'].external=true},
    c=>{c.services.api.image='api:latest'},
    c=>{c.services.api.image=c.services['api-migrate'].image='api:sha-0123456789abcdef'},
    c=>{c.services.web.image='web:development'},
    c=>{c.services.web.ports=c.services.web.ports.filter(port=>port.target!==9443)},
    c=>{c.services.api.ports=[{target:4000,published:'4000'}]},
    c=>{c.services.api.volumes[0].read_only=false},
    c=>{delete c.services.redis.healthcheck},
    c=>{c.services.redis.healthcheck.test=['CMD','true']},
    c=>{c.services.api.depends_on['api-migrate'].condition='service_started'},
    c=>{c.services.web.depends_on.api.condition='service_started'},
    c=>{c.services.web.user='0'},
    c=>{c.services.api.environment.NODE_ENV='development'},
    c=>{c.services.api.environment.CAD_IMPORT_CONVERTER_EXECUTABLE='/tmp/converter'},
    c=>{c.services['cad-converter'].environment.CAD_IMPORT_CONVERTER_ARGV_JSON='not-json'},
    c=>{c.services['cad-converter'].environment.CAD_IMPORT_CONVERTER_ARGV_JSON='["{input}"]'},
    c=>{c.services['cad-converter'].environment.DATABASE_URL='postgresql://secret'},
    c=>{c.services['cad-converter'].network_mode=undefined},
    c=>{c.services['cad-converter'].user=c.services.api.user},
    c=>{c.services['cad-converter'].mem_limit='805306368'},
    c=>{c.services.api.tmpfs=c.services.api.tmpfs.filter(mount=>!mount.startsWith('/tmp/cad-import:'))},
    c=>{c.services.api.tmpfs=c.services.api.tmpfs.map(mount=>mount.replace('size=536870912','size=402653184'))},
    c=>{c.services.api.environment.CAD_IMPORT_TEMP_VOLUME_BYTES='402653184'},
    c=>{c.services['cad-converter'].volumes=c.services['cad-converter'].volumes.filter(m=>m.target!=='/opt/cad-converter')},
    c=>{c.services['cad-converter'].volumes.find(m=>m.target==='/opt/cad-converter').read_only=false},
    c=>{c.services.api.environment.VAULT_ADDR='http://vault:8200'},
  ];
  for(const mutate of mutations){const bad=structuredClone(config);mutate(bad);assert.throws(()=>validateProductionConfig(bad));}
});

test("host converter attestation rejects missing, writable and digest-mismatched executables", () => {
  const dir=mkdtempSync(path.join(tmpdir(),"cad-host-attestation-"));
  try {
    mkdirSync(path.join(dir,"bin"));
    const executable=path.join(dir,"bin/converter");
    writeFileSync(executable,"approved"); chmodSync(executable,0o555);
    const digest=createHash("sha256").update("approved").digest("hex");
    assert.equal(attestConverterBundleHost(dir,digest).digest,digest);
    chmodSync(executable,0o775);
    assert.throws(()=>attestConverterBundleHost(dir,digest),/owner and mode|rejected/i);
    chmodSync(executable,0o755); writeFileSync(executable,"replacement"); chmodSync(executable,0o555);
    assert.throws(()=>attestConverterBundleHost(dir,digest),/digest|rejected/i);
    rmSync(executable);
    assert.throws(()=>attestConverterBundleHost(dir,digest),/attestation|rejected/i);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
