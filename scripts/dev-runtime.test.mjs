import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseEnvFile,
  resolveDevAppFilters,
  resolveDevEnvironment,
  renderMosquittoAcl,
  renderMosquittoConfig,
  startMosquittoCrlReload
} from "./dev-runtime.mjs";

test("루트 env 파일의 주석, 따옴표, 빈 값을 안전하게 읽는다", () => {
  assert.deepEqual(parseEnvFile('# comment\nAPI_PORT=4000\nDATABASE_URL="postgres://local/db"\nEMPTY=\n'), {
    API_PORT: "4000",
    DATABASE_URL: "postgres://local/db",
    EMPTY: ""
  });
});

test("개발 환경은 명시한 LAN MQTT URL과 mTLS 경로를 보존한다", () => {
  const root = "/workspace/led-control";
  const env = resolveDevEnvironment(root, {
    MQTT_URL: "mqtts://mqtt.lan:8883",
    MQTT_PUBLIC_URL: "mqtts://192.168.1.11:8883",
    MQTT_CA_PATH: "/vault/current/mqtt-ca.crt",
    MQTT_CLIENT_CERT_PATH: "/vault/current/api-mqtt-client.crt",
    MQTT_CLIENT_KEY_PATH: "/vault/current/api-mqtt-client.key",
    DEV_GATEWAY_ID: "11111111-1111-4111-8111-111111111111"
  });

  assert.equal(env.MQTT_URL, "mqtts://mqtt.lan:8883");
  assert.equal(env.MQTT_PUBLIC_URL, "mqtts://192.168.1.11:8883");
  assert.equal(env.MQTT_CA_PATH, "/vault/current/mqtt-ca.crt");
  assert.equal(env.MQTT_CLIENT_CERT_PATH, "/vault/current/api-mqtt-client.crt");
  assert.equal(env.MQTT_CLIENT_KEY_PATH, "/vault/current/api-mqtt-client.key");
  assert.equal(env.MQTT_API_INSTANCE_ID, "development");
  assert.equal(env.DEV_GATEWAY_ID, "11111111-1111-4111-8111-111111111111");
});

test("개발 환경은 미설정 mTLS 값에만 기존 로컬 PKI 기본값을 사용한다", () => {
  const env = resolveDevEnvironment("/workspace/led-control", {});

  assert.equal(env.MQTT_URL, "mqtts://localhost:8883");
  assert.equal(env.MQTT_PUBLIC_URL, "mqtts://localhost:8883");
  assert.equal(env.MQTT_CA_PATH, "/workspace/led-control/.local/pki/ca.crt");
  assert.equal(env.MQTT_CLIENT_CERT_PATH, "/workspace/led-control/.local/pki/api.crt");
  assert.equal(env.MQTT_CLIENT_KEY_PATH, "/workspace/led-control/.local/pki/api.key");
  assert.equal(env.MQTT_API_INSTANCE_ID, "development");
});

test("개발 환경은 평문 MQTT URL을 거부한다", () => {
  assert.throws(
    () => resolveDevEnvironment("/workspace/led-control", { MQTT_URL: "mqtt://mqtt.lan:1883" }),
    /MQTT_URL must use mqtts:\/\//
  );
  assert.throws(
    () => resolveDevEnvironment("/workspace/led-control", { MQTT_PUBLIC_URL: "mqtt://mqtt.lan:1883" }),
    /MQTT_PUBLIC_URL must use mqtts:\/\//
  );
});

test("Vault 현재 bundle을 사용하면 API client와 Mosquitto server 경로를 함께 선택한다", () => {
  const root = "/workspace/led-control";
  const env = resolveDevEnvironment(root, { PKI_LAB_CURRENT_DIR: "/vault/pki/current" });
  const config = renderMosquittoConfig(root, env);

  assert.equal(env.MQTT_CA_PATH, "/vault/pki/current/mqtt-ca.crt");
  assert.equal(env.MQTT_CLIENT_CERT_PATH, "/vault/pki/current/api-mqtt-client.crt");
  assert.equal(env.MQTT_CLIENT_KEY_PATH, "/vault/pki/current/api-mqtt-client.key");
  assert.match(config, /cafile \/vault\/pki\/current\/mqtt-ca\.crt/);
  assert.match(config, /certfile \/vault\/pki\/current\/mqtt-server\.crt/);
  assert.match(config, /keyfile \/vault\/pki\/current\/mqtt-server\.key/);
  assert.match(config, /crlfile \/vault\/pki\/current\/mqtt-client\.crl/);
});

test("명시한 Vault client 경로는 PKI_LAB_CURRENT_DIR 없이도 Mosquitto bundle 경로를 선택한다", () => {
  const root = "/workspace/led-control";
  const env = resolveDevEnvironment(root, {
    MQTT_CA_PATH: "/vault/pki/current/mqtt-ca.crt",
    MQTT_CLIENT_CERT_PATH: "/vault/pki/current/api-mqtt-client.crt",
    MQTT_CLIENT_KEY_PATH: "/vault/pki/current/api-mqtt-client.key"
  });
  const config = renderMosquittoConfig(root, env);

  assert.match(config, /cafile \/vault\/pki\/current\/mqtt-ca\.crt/);
  assert.match(config, /certfile \/vault\/pki\/current\/mqtt-server\.crt/);
  assert.match(config, /keyfile \/vault\/pki\/current\/mqtt-server\.key/);
  assert.match(config, /crlfile \/vault\/pki\/current\/mqtt-client\.crl/);
});

test("DEV_GATEWAY_ID가 없으면 mock identity 없이 온보딩 모드로 시작한다", () => {
  const env = resolveDevEnvironment("/workspace/led-control", {});
  assert.equal(env.DEV_GATEWAY_ID, "");
  assert.doesNotMatch(renderMosquittoAcl(env.DEV_GATEWAY_ID), /user undefined|user mock|user demo/i);
});

test("host Mosquitto 설정은 mTLS와 gateway-scoped ACL을 강제한다", () => {
  const config = renderMosquittoConfig("/workspace/led-control", {});
  const acl = renderMosquittoAcl("00000000-0000-4000-8000-000000000004");

  assert.match(config, /listener 8883/);
  assert.match(config, /require_certificate true/);
  assert.match(config, /tls_version tlsv1\.2/);
  assert.match(config, /cafile \/workspace\/led-control\/.local\/pki\/ca\.crt/);
  assert.match(acl, /user api-service\ntopic readwrite sites\/#/);
  assert.match(acl, /user 00000000-0000-4000-8000-000000000004/);
  assert.match(acl, /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/commands\/#/);
  assert.match(
    acl,
    /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/provisioning\/scan-terminal-ingested/
  );
  assert.match(acl, /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/state-ingested/);
  assert.match(acl, /topic write sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/acceptance/);
  assert.match(acl, /topic write sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/device-status/);
  assert.doesNotMatch(acl, /topic write sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/#/);
  assert.doesNotMatch(acl, /topic write .*\/acks\/(?:state-ingested|provisioning\/scan-terminal-ingested)/);
});

test("기본 pnpm dev는 실제 장비 시험을 위해 mock gateway를 실행하지 않는다", () => {
  assert.deepEqual(resolveDevAppFilters([]), ["@led-control/api", "@led-control/web"]);
});

test("추가 인자가 있어도 제품 개발 프로세스만 실행한다", () => {
  assert.deepEqual(resolveDevAppFilters(["--with-mock-gateway"]), ["@led-control/api", "@led-control/web"]);
});

test("production Mosquitto 설정은 mTLS, CRL, TLS 1.2와 최소권한 ACL을 강제한다", () => {
  const config = readFileSync(new URL("../infra/mosquitto.production-tls.conf", import.meta.url), "utf8");
  const acl = readFileSync(new URL("../infra/mosquitto.acl.example", import.meta.url), "utf8");

  assert.match(config, /^allow_anonymous false$/m);
  assert.match(config, /^cafile \/mosquitto\/certs\/mqtt-ca\.crt$/m);
  assert.match(config, /^certfile \/mosquitto\/certs\/mqtt-server\.crt$/m);
  assert.match(config, /^keyfile \/mosquitto\/certs\/mqtt-server\.key$/m);
  assert.match(config, /^crlfile \/mosquitto\/certs\/mqtt-client\.crl$/m);
  assert.match(config, /^require_certificate true$/m);
  assert.match(config, /^use_identity_as_username true$/m);
  assert.match(config, /^tls_version tlsv1\.2$/m);
  assert.match(config, /^acl_file \/mosquitto\/config\/mosquitto\.acl$/m);
  assert.doesNotMatch(config, /allow_anonymous true|require_certificate false|use_identity_as_username false/i);
  assert.match(acl, /^pattern read sites\/\+\/gateways\/%u\/acks\/state-ingested$/m);
  assert.match(acl, /^pattern read sites\/\+\/gateways\/%u\/acks\/provisioning\/scan-terminal-ingested$/m);
  assert.match(acl, /^pattern write sites\/\+\/gateways\/%u\/acks\/acceptance$/m);
  assert.match(acl, /^pattern write sites\/\+\/gateways\/%u\/acks\/device-status$/m);
  assert.doesNotMatch(acl, /^pattern write .*\/acks\/#$/m);
  assert.doesNotMatch(acl, /^pattern write .*\/acks\/(?:state-ingested|provisioning\/scan-terminal-ingested)$/m);
});

test("Compose는 선택 가능한 Mosquitto config와 certificate directory를 read-only로 mount한다", () => {
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");

  assert.match(compose, /\$\{MOSQUITTO_TLS_CONFIG_PATH:-\.\/infra\/mosquitto\.dev-tls\.conf\}:\/mosquitto\/config\/mosquitto\.conf:ro/);
  assert.match(compose, /\$\{MQTT_TLS_CERT_DIR:-\.\/\.local\/pki\}:\/mosquitto\/certs:ro/);
});

test("host Mosquitto는 변경된 CRL에만 SIGHUP하고 임시 파일과 동일 checksum은 무시한다", () => {
  const harness = createCrlWatcherHarness();
  const broker = { kill: (signal) => signals.push(signal) };
  const signals = [];
  let crl = "old";

  startMosquittoCrlReload({ crlPath: "/tls/mqtt-client.crl", broker, readFile: () => Buffer.from(crl), ...harness });
  harness.trigger("change", "mqtt-client.crl.tmp");
  harness.runPending();
  harness.trigger("change", "mqtt-client.crl");
  harness.runPending();
  crl = "new";
  harness.trigger("rename", "mqtt-client.crl");
  harness.runPending();

  assert.deepEqual(signals, ["SIGHUP"]);
});

test("host Mosquitto는 symlink target만 교체되어도 polling으로 CRL 변경을 반영하고 종료 시 polling을 중지한다", () => {
  const harness = createCrlWatcherHarness();
  const signals = [];
  let crl = "old";
  const watcher = startMosquittoCrlReload({
    crlPath: "/tls/current/mqtt-client.crl",
    broker: { kill: (signal) => signals.push(signal) },
    readFile: () => Buffer.from(crl),
    ...harness
  });

  crl = "revoked";
  harness.runPoll();
  assert.deepEqual(signals, ["SIGHUP"]);
  watcher.close();
  assert.equal(harness.pollCancelled(), true);
});

function createCrlWatcherHarness() {
  let callback;
  let pending;
  let poll;
  let cancelled = false;
  return {
    watch: (_path, listener) => {
      callback = listener;
      return { close() {} };
    },
    schedule: (listener) => {
      pending = listener;
      return 1;
    },
    cancel() {},
    repeat(listener) {
      poll = listener;
      return 2;
    },
    cancelRepeat() {
      cancelled = true;
    },
    trigger(event, filename) {
      callback(event, filename);
    },
    runPending() {
      const listener = pending;
      pending = undefined;
      listener?.();
    },
    runPoll() {
      poll?.();
    },
    pollCancelled() {
      return cancelled;
    }
  };
}
