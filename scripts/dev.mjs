import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  parseEnvFile,
  publishMosquittoAcl,
  resolveDevAppFilters,
  resolveMosquittoTlsPaths,
  renderMosquittoConfig,
  resolveDevEnvironment,
  startMosquittoCrlReload
} from "./dev-runtime.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
let stopping = false;
let broker = null;
let brokerCrlWatcher = null;
let apps = null;
if (!existsSync(envFile)) fail(".env 파일이 없습니다. cp .env.example .env를 먼저 실행하세요.");

const fileEnv = parseEnvFile(readFileSync(envFile, "utf8"));
const sourceEnv = { ...fileEnv, ...process.env };
if (sourceEnv.AUTOMATION_E2E_SIMULATOR === "1") {
  fail("AUTOMATION_E2E_SIMULATOR는 private child IPC를 제공하는 Chromium RealBackendLab에서만 실행할 수 있습니다.");
}
const env = resolveDevEnvironment(root, sourceEnv);
const gatewayIds = env.DEV_GATEWAY_IDS ? env.DEV_GATEWAY_IDS.split(",") : [];
const appFilters = resolveDevAppFilters(process.argv.slice(2));
const apiPort = Number(env.API_PORT || 4000);
const webPort = Number(env.WEB_PORT || 5173);

await requireService("PostgreSQL", 5432, "brew services start postgresql@16 또는 pnpm docker:up을 실행하세요.");
await requireService("Redis", 6379, "brew services start redis 또는 pnpm docker:up을 실행하세요.");
await requireFreePort(apiPort, "API_PORT");
await requireFreePort(webPort, "WEB_PORT");

ensureDevelopmentPki(gatewayIds, usesExternalMqttPki(sourceEnv));
const localDir = join(root, ".local");
mkdirSync(localDir, { recursive: true });
// A product Gateway claim changes database ownership, not this file-backed Lab
// broker ACL. Each permitted certificate CN therefore remains an explicit UUID
// in DEV_GATEWAY_IDS and is republished only when the developer restarts dev.
publishMosquittoAcl(join(localDir, "mosquitto.acl"), gatewayIds);
writeFileSync(join(localDir, "mosquitto.host.conf"), renderMosquittoConfig(root, env), { mode: 0o600 });

if (!(await isPortOpen(8883))) {
  const mosquitto = findMosquitto();
  broker = spawn(mosquitto, ["-c", join(localDir, "mosquitto.host.conf")], {
    cwd: root,
    env,
    stdio: "inherit"
  });
  broker.once("exit", (code) => {
    if (!stopping) {
      console.error(`[dev] 로컬 mTLS Mosquitto가 예기치 않게 종료되었습니다 (exit ${code ?? "unknown"}).`);
      process.exitCode = code || 1;
      stop();
    }
  });
  brokerCrlWatcher = startMosquittoCrlReload({ crlPath: resolveMosquittoTlsPaths(root, env).crl, broker });
}
await waitForMqttTls(env, 5000);

runChecked("pnpm", ["--filter", "@led-control/api", "exec", "prisma", "migrate", "deploy"], env);

apps = spawn(
  "pnpm",
  ["--parallel", ...appFilters.flatMap((filter) => ["--filter", filter]), "dev"],
  { cwd: root, env, stdio: "inherit" }
);

console.log(gatewayIds.length
  ? `[dev] 실제 장비 모드입니다. 명시된 ${gatewayIds.length}개 Raspberry Pi gateway의 MQTT 연결만 허용합니다.`
  : "[dev] 게이트웨이 미할당 온보딩 모드입니다. 현장과 gateway claim 후 DEV_GATEWAY_IDS를 설정하고 재시작하세요.");

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  apps?.kill(signal);
  brokerCrlWatcher?.close();
  broker?.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
apps.once("exit", (code, signal) => {
  stop();
  process.exitCode = signal ? 130 : code ?? 1;
});

function ensureDevelopmentPki(gatewayIds, externalPki) {
  const pki = join(root, ".local", "pki");
  if (externalPki) {
    const required = [
      env.MQTT_CA_PATH,
      env.MQTT_CLIENT_CERT_PATH,
      env.MQTT_CLIENT_KEY_PATH,
      ...Object.values(resolveMosquittoTlsPaths(root, env))
    ];
    const missing = [...new Set(required)].filter((path) => !existsSync(path));
    if (missing.length) fail(`명시한 Vault TLS bundle 파일을 찾지 못했습니다: ${missing.join(", ")}`);
    return;
  }
  if (!existsSync(join(pki, "ca.crt")) || !existsSync(join(pki, "api.crt")) || !existsSync(join(pki, "broker.crt"))) {
    runChecked(join(root, "scripts", "dev-pki", "create-ca.sh"), [], env);
  }
  for (const gatewayId of gatewayIds) {
    const certificateName = `gateway-${gatewayId}`;
    if (!existsSync(join(pki, `${certificateName}.crt`)) || !existsSync(join(pki, `${certificateName}.key`))) {
      runChecked(join(root, "scripts", "dev-pki", "issue-gateway-cert.sh"), [gatewayId], env);
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

function findMosquitto() {
  const candidates = [
    env.MOSQUITTO_BIN,
    "/opt/homebrew/sbin/mosquitto",
    "/opt/homebrew/opt/mosquitto/sbin/mosquitto",
    "/usr/local/sbin/mosquitto",
    "/usr/sbin/mosquitto"
  ].filter(Boolean);
  const command = spawnSync("sh", ["-c", "command -v mosquitto"], { encoding: "utf8" }).stdout.trim();
  if (command) candidates.push(command);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) fail("Mosquitto 실행 파일을 찾지 못했습니다. macOS에서는 brew install mosquitto를 실행하세요.");
  return found;
}

function runChecked(command, args, childEnv) {
  const result = spawnSync(command, args, { cwd: root, env: childEnv, stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} 실행에 실패했습니다.`);
}

async function requireService(name, port, hint) {
  if (!(await isPortOpen(port))) fail(`${name}가 localhost:${port}에서 응답하지 않습니다. ${hint}`);
}

async function requireFreePort(port, name) {
  if (await isPortOpen(port)) fail(`${name} ${port} 포트가 이미 사용 중입니다. 기존 개발 서버를 종료한 뒤 다시 실행하세요.`);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const close = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", close);
    socket.once("timeout", close);
  });
}

async function waitForMqttTls(mqttEnv, timeoutMs) {
  const mqttUrl = new URL(mqttEnv.MQTT_URL);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectMqttTls(mqttEnv, mqttUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`API 개발 인증서로 ${mqttUrl.host} mTLS handshake를 ${timeoutMs}ms 안에 완료하지 못했습니다.`);
}

function canConnectMqttTls(mqttEnv, mqttUrl) {
  return new Promise((resolve) => {
    const socket = connectTls({
      host: mqttUrl.hostname,
      port: Number(mqttUrl.port || 8883),
      servername: mqttUrl.hostname,
      ca: readFileSync(mqttEnv.MQTT_CA_PATH),
      cert: readFileSync(mqttEnv.MQTT_CLIENT_CERT_PATH),
      key: readFileSync(mqttEnv.MQTT_CLIENT_KEY_PATH),
      rejectUnauthorized: true
    });
    socket.setTimeout(500);
    socket.once("secureConnect", () => {
      socket.end();
      resolve(true);
    });
    const close = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", close);
    socket.once("timeout", close);
  });
}

function fail(message) {
  console.error(`[dev] ${message}`);
  stop();
  process.exit(1);
}
