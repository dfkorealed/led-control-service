import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseEnvFile,
  resolveDevAppFilters,
  resolveDevEnvironment,
  renderMosquittoAcl,
  renderMosquittoConfig
} from "./dev-runtime.mjs";

test("루트 env 파일의 주석, 따옴표, 빈 값을 안전하게 읽는다", () => {
  assert.deepEqual(parseEnvFile('# comment\nAPI_PORT=4000\nDATABASE_URL="postgres://local/db"\nEMPTY=\n'), {
    API_PORT: "4000",
    DATABASE_URL: "postgres://local/db",
    EMPTY: ""
  });
});

test("개발 환경은 명시한 실제 gateway identity와 절대 경로의 mTLS 인증서를 사용한다", () => {
  const root = "/workspace/led-control";
  const env = resolveDevEnvironment(root, {
    MQTT_URL: "mqtt://localhost:1883",
    DEV_GATEWAY_ID: "11111111-1111-4111-8111-111111111111"
  });

  assert.equal(env.MQTT_URL, "mqtts://localhost:8883");
  assert.equal(env.MQTT_CA_PATH, "/workspace/led-control/.local/pki/ca.crt");
  assert.equal(env.MQTT_CLIENT_CERT_PATH, "/workspace/led-control/.local/pki/api.crt");
  assert.equal(env.DEV_GATEWAY_ID, "11111111-1111-4111-8111-111111111111");
});

test("DEV_GATEWAY_ID가 없으면 mock identity 없이 온보딩 모드로 시작한다", () => {
  const env = resolveDevEnvironment("/workspace/led-control", {});
  assert.equal(env.DEV_GATEWAY_ID, "");
  assert.doesNotMatch(renderMosquittoAcl(env.DEV_GATEWAY_ID), /user undefined|user mock|user demo/i);
});

test("host Mosquitto 설정은 mTLS와 gateway-scoped ACL을 강제한다", () => {
  const config = renderMosquittoConfig("/workspace/led-control");
  const acl = renderMosquittoAcl("00000000-0000-4000-8000-000000000004");

  assert.match(config, /listener 8883/);
  assert.match(config, /require_certificate true/);
  assert.match(config, /cafile \/workspace\/led-control\/.local\/pki\/ca\.crt/);
  assert.match(acl, /user api-service\ntopic readwrite sites\/#/);
  assert.match(acl, /user 00000000-0000-4000-8000-000000000004/);
  assert.match(acl, /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/commands\/#/);
});

test("기본 pnpm dev는 실제 장비 시험을 위해 mock gateway를 실행하지 않는다", () => {
  assert.deepEqual(resolveDevAppFilters([]), ["@led-control/api", "@led-control/web"]);
});

test("추가 인자가 있어도 제품 개발 프로세스만 실행한다", () => {
  assert.deepEqual(resolveDevAppFilters(["--with-mock-gateway"]), ["@led-control/api", "@led-control/web"]);
});
