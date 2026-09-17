import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  const dockerCertDirectory = resolve(root, env.MQTT_TLS_CERT_DIR?.trim() || join(".local", "pki"));
  ensurePrivateLocalDirectory(root, localDirectory);
  ensureMosquittoRuntimeDirectory(mqttRuntimeDirectory);
  // Claims update product state only. Both supported dev launch paths call this
  // before broker startup so the file-backed ACL is never a stale wildcard or
  // a previous Gateway allowlist, including when the new list is empty.
  publishMosquittoAcl(aclPath, gatewayIds);
  publishPrivateConfig(root, nativeConfigPath, renderMosquittoConfig(root, env));
  publishPrivateConfig(root, dockerConfigPath, renderDockerMosquittoConfig(env));
  return { env, gatewayIds, aclPath, nativeConfigPath, dockerConfigPath, dockerCertDirectory };
}

function ensurePrivateLocalDirectory(root, directory) {
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created) chmodSync(directory, 0o700);
  let status;
  try {
    status = lstatSync(directory);
  } catch {
    throw new Error(".local must be a regular directory, not a symlink");
  }
  const expected = join(realpathSync(root), ".local");
  if (!status.isDirectory() || status.isSymbolicLink() || realpathSync(directory) !== expected) {
    throw new Error(".local must be a regular directory, not a symlink");
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(".local must be owned by the invoking user");
  }
}

function publishPrivateConfig(root, destination, content) {
  const localDirectory = join(root, ".local");
  ensurePrivateLocalDirectory(root, localDirectory);
  const pathWithinLocal = relative(localDirectory, destination);
  if (!pathWithinLocal || isAbsolute(pathWithinLocal) || pathWithinLocal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Mosquitto config destination must remain inside .local");
  }
  if (dirname(destination) !== localDirectory) {
    throw new Error("Mosquitto config destination parent must be the validated .local directory");
  }
  try {
    const status = lstatSync(destination);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error("Mosquitto config destination must be a regular file, not a symlink");
    }
    if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
      throw new Error("Mosquitto config destination must be owned by the invoking user");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = join(
    localDirectory,
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  let directoryDescriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    chmodSync(temporaryPath, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, destination);
    directoryDescriptor = openSync(localDirectory, "r");
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    directoryDescriptor = undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    rmSync(temporaryPath, { force: true });
  }
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
