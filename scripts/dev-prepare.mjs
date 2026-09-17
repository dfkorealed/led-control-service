import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEnvFile,
  publishMosquittoAcl,
  renderDockerMosquittoConfig,
  renderMosquittoConfig,
  resolveDevEnvironment,
  resolveMosquittoTlsPaths
} from "./dev-runtime.mjs";

export function prepareDevelopmentRuntime(root, sourceEnv, { run = defaultRun } = {}) {
  const env = resolveDevEnvironment(root, sourceEnv);
  const gatewayIds = env.DEV_GATEWAY_IDS ? env.DEV_GATEWAY_IDS.split(",") : [];
  ensureDevelopmentPki(root, env, gatewayIds, usesExternalMqttPki(sourceEnv), run);

  const localDirectory = join(root, ".local");
  const mqttRuntimeDirectory = join(localDirectory, "mosquitto-runtime");
  const aclPath = join(mqttRuntimeDirectory, "mosquitto.acl");
  const nativeConfigPath = join(localDirectory, "mosquitto.host.conf");
  const dockerConfigPath = join(localDirectory, "mosquitto.docker.conf");
  mkdirSync(localDirectory, { recursive: true });
  ensureMosquittoRuntimeDirectory(mqttRuntimeDirectory);
  // Claims update product state only. Both supported dev launch paths call this
  // before broker startup so the file-backed ACL is never a stale wildcard or
  // a previous Gateway allowlist, including when the new list is empty.
  publishMosquittoAcl(aclPath, gatewayIds);
  writeFileSync(nativeConfigPath, renderMosquittoConfig(root, env), { mode: 0o600 });
  writeFileSync(dockerConfigPath, renderDockerMosquittoConfig(env), { mode: 0o600 });
  chmodSync(nativeConfigPath, 0o600);
  chmodSync(dockerConfigPath, 0o600);
  return { env, gatewayIds, aclPath, nativeConfigPath, dockerConfigPath };
}

function ensureMosquittoRuntimeDirectory(directory) {
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o755 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // dev:local prepares before docker:up, and dev.mjs deliberately prepares
  // again before it reloads an already-running broker. Only normalize a
  // directory created by this call (the umask may narrow its mode); the ACL
  // publisher strictly validates every pre-existing path instead of silently
  // repairing a symlink, foreign owner, or unsafe mode.
  if (created) chmodSync(directory, 0o755);
}

function ensureDevelopmentPki(root, env, gatewayIds, externalPki, run) {
  const pki = join(root, ".local", "pki");
  if (externalPki) {
    const required = [
      env.MQTT_CA_PATH,
      env.MQTT_CLIENT_CERT_PATH,
      env.MQTT_CLIENT_KEY_PATH,
      ...Object.values(resolveMosquittoTlsPaths(root, env))
    ];
    const missing = [...new Set(required)].filter((path) => !existsSync(path));
    if (missing.length) throw new Error(`명시한 Vault TLS bundle 파일을 찾지 못했습니다: ${missing.join(", ")}`);
    return;
  }
  if (!existsSync(join(pki, "ca.crt")) || !existsSync(join(pki, "api.crt")) || !existsSync(join(pki, "broker.crt"))) {
    runChecked(run, root, join(root, "scripts", "dev-pki", "create-ca.sh"), [], env);
  }
  for (const gatewayId of gatewayIds) {
    const certificateName = `gateway-${gatewayId}`;
    if (!existsSync(join(pki, `${certificateName}.crt`)) || !existsSync(join(pki, `${certificateName}.key`))) {
      runChecked(run, root, join(root, "scripts", "dev-pki", "issue-gateway-cert.sh"), [gatewayId], env);
    }
  }
}

function usesExternalMqttPki(source) {
  return Boolean(
    source.PKI_LAB_CURRENT_DIR?.trim() ||
      source.MQTT_CA_PATH?.trim() ||
      source.MQTT_CLIENT_CERT_PATH?.trim() ||
      source.MQTT_CLIENT_KEY_PATH?.trim() ||
      source.MQTT_SERVER_CLIENT_CA_PATH?.trim() ||
      source.MQTT_SERVER_CERT_PATH?.trim() ||
      source.MQTT_SERVER_KEY_PATH?.trim() ||
      source.MQTT_CLIENT_CRL_PATH?.trim()
  );
}

function runChecked(run, root, command, args, env) {
  const result = run(command, args, { cwd: root, env, stdio: "inherit" });
  if (result?.status !== 0) throw new Error(`${command} ${args.join(" ")} 실행에 실패했습니다.`);
}

function defaultRun(command, args, options) {
  return spawnSync(command, args, options);
}

function loadSourceEnvironment(root) {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) throw new Error(".env 파일이 없습니다. cp .env.example .env를 먼저 실행하세요.");
  return { ...parseEnvFile(readFileSync(envFile, "utf8")), ...process.env };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    prepareDevelopmentRuntime(root, loadSourceEnvironment(root));
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
