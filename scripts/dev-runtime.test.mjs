import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  parseEnvFile,
  publishMosquittoAcl,
  resolveDevAppFilters,
  resolveDevEnvironment,
  renderMosquittoAcl,
  renderDockerMosquittoConfig,
  renderMosquittoConfig,
  startMosquittoCrlReload,
  validateLabNetworkConfiguration
} from "./dev-runtime.mjs";
import {
  publishNativeBrokerIdentity,
  reloadExistingDevelopmentBroker
} from "./dev-broker.mjs";
import { prepareDevelopmentRuntime, resolveDevelopmentCadEnvironment } from "./dev-prepare.mjs";

test("루트 env 파일의 주석, 따옴표, 빈 값을 안전하게 읽는다", () => {
  assert.deepEqual(parseEnvFile('# comment\nAPI_PORT=4000\nDATABASE_URL="postgres://local/db"\nEMPTY=\n'), {
    API_PORT: "4000",
    DATABASE_URL: "postgres://local/db",
    EMPTY: ""
  });
});

test("개발 CAD 설정은 설치된 dwgread를 자동 감지해 DWG worker를 활성화한다", () => {
  const env = resolveDevelopmentCadEnvironment({}, {
    findExecutable: (name) => name === "dwgread" ? "/opt/homebrew/bin/dwgread" : undefined
  });

  assert.equal(env.CAD_IMPORT_CONVERTER_MODE, "development-argv");
  assert.equal(env.CAD_IMPORT_CONVERTER_EXECUTABLE, "/opt/homebrew/bin/dwgread");
  assert.equal(env.CAD_IMPORT_CONVERTER_ARGV_JSON, '["-O","DXF","-o","{output}","{input}"]');
});

test("개발 CAD 설정은 명시적인 converter 설정을 자동 감지 값으로 덮어쓰지 않는다", () => {
  const env = resolveDevelopmentCadEnvironment({
    CAD_IMPORT_CONVERTER_MODE: "local-dxf-copy",
    CAD_IMPORT_CONVERTER_EXECUTABLE: "/custom/converter"
  }, { findExecutable: () => "/opt/homebrew/bin/dwgread" });

  assert.equal(env.CAD_IMPORT_CONVERTER_MODE, "local-dxf-copy");
  assert.equal(env.CAD_IMPORT_CONVERTER_EXECUTABLE, "/custom/converter");
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

test("Lab 개발 시작은 현재 host에 없는 stale service IP를 거부한다", async () => {
  await assert.rejects(
    () => validateLabNetworkConfiguration({
      PKI_ENV: "lab",
      LAB_API_IP: "172.30.1.2",
      LAB_MQTT_IP: "172.30.1.2",
      VITE_API_PROXY_TARGET: "https://172.30.1.2:4000",
      MQTT_URL: "mqtts://172.30.1.2:8883"
    }, {
      localAddresses: ["127.0.0.1", "172.30.1.13"],
      resolveHostname: async () => []
    }),
    /LAB_API_IP 172\.30\.1\.2.*current host/i
  );
});

test("Lab 개발 시작은 service IP와 다른 Vite proxy target을 거부한다", async () => {
  await assert.rejects(
    () => validateLabNetworkConfiguration({
      PKI_ENV: "lab",
      LAB_API_IP: "172.30.1.13",
      LAB_MQTT_IP: "172.30.1.13",
      VITE_API_PROXY_TARGET: "https://172.30.1.2:4000",
      MQTT_URL: "mqtts://172.30.1.13:8883"
    }, {
      localAddresses: ["127.0.0.1", "172.30.1.13"],
      resolveHostname: async (hostname) => [hostname]
    }),
    /VITE_API_PROXY_TARGET.*172\.30\.1\.13/i
  );
});

test("Lab 개발 시작은 current service IP와 일치하는 IP endpoints를 허용한다", async () => {
  await assert.doesNotReject(() => validateLabNetworkConfiguration({
    PKI_ENV: "lab",
    LAB_API_IP: "172.30.1.13",
    LAB_MQTT_IP: "172.30.1.13",
    VITE_API_PROXY_TARGET: "https://172.30.1.13:4000",
    MQTT_URL: "mqtts://172.30.1.13:8883"
  }, {
    localAddresses: ["127.0.0.1", "172.30.1.13"],
    resolveHostname: async (hostname) => [hostname]
  }));
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

test("Docker Mosquitto renderer는 개발 PKI와 Lab PKI의 실제 bundle 파일명을 구분한다", () => {
  const development = renderDockerMosquittoConfig({});
  assert.match(development, /^cafile \/mosquitto\/certs\/ca\.crt$/m);
  assert.match(development, /^certfile \/mosquitto\/certs\/broker\.crt$/m);
  assert.match(development, /^keyfile \/mosquitto\/certs\/broker\.key$/m);
  assert.match(development, /^crlfile \/mosquitto\/certs\/ca\.crl$/m);
  const lab = renderDockerMosquittoConfig({ PKI_LAB_CURRENT_DIR: "/vault/pki/current" });
  assert.match(
    lab,
    /^cafile \/mosquitto\/certs\/mqtt-ca\.crt$/m
  );
  assert.match(lab, /^keyfile \/mosquitto\/certs\/mqtt-server\.key$/m);
  assert.match(lab, /^crlfile \/mosquitto\/certs\/mqtt-client\.crl$/m);
  assert.match(
    renderDockerMosquittoConfig({ MQTT_CA_PATH: "/vault/pki/current/mqtt-ca.crt" }),
    /^certfile \/mosquitto\/certs\/mqtt-server\.crt$/m
  );
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
  assert.equal(env.DEV_GATEWAY_IDS, "");
  assert.equal(renderMosquittoAcl([]), "user api-service\ntopic readwrite sites/#\n\n");
});

test("DEV_GATEWAY_IDS는 복수 UUID를 trim, 소문자화, 중복 제거하고 안정적으로 정렬한다", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const env = resolveDevEnvironment("/workspace/led-control", {
    DEV_GATEWAY_IDS: ` ${second.toUpperCase()}, ${first}, ${second} `
  });

  assert.equal(env.DEV_GATEWAY_IDS, `${first},${second}`);
  const acl = renderMosquittoAcl(env.DEV_GATEWAY_IDS.split(","));
  assert.equal((acl.match(/^user api-service$/gm) ?? []).length, 1);
  assert.equal((acl.match(new RegExp(`^user ${first}$`, "gm")) ?? []).length, 1);
  assert.equal((acl.match(new RegExp(`^user ${second}$`, "gm")) ?? []).length, 1);
  assert.ok(acl.indexOf(`user ${first}`) < acl.indexOf(`user ${second}`));
});

test("legacy DEV_GATEWAY_ID는 기존 단일 장비 동작을 유지하며 복수 allowlist로 승격된다", () => {
  const gatewayId = "11111111-1111-4111-8111-111111111111";
  const env = resolveDevEnvironment("/workspace/led-control", { DEV_GATEWAY_ID: gatewayId.toUpperCase() });

  assert.equal(env.DEV_GATEWAY_ID, gatewayId);
  assert.equal(env.DEV_GATEWAY_IDS, gatewayId);
  assert.match(renderMosquittoAcl(env.DEV_GATEWAY_IDS.split(",")), new RegExp(`^user ${gatewayId}$`, "m"));
});

test("legacy와 복수 설정을 함께 쓰면 legacy가 allowlist에 포함될 때만 허용한다", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  assert.equal(
    resolveDevEnvironment("/workspace/led-control", {
      DEV_GATEWAY_ID: first,
      DEV_GATEWAY_IDS: `${second},${first}`
    }).DEV_GATEWAY_IDS,
    `${first},${second}`
  );
  assert.throws(
    () =>
      resolveDevEnvironment("/workspace/led-control", {
        DEV_GATEWAY_ID: first,
        DEV_GATEWAY_IDS: second
      }),
    /DEV_GATEWAY_ID conflicts with DEV_GATEWAY_IDS/
  );
});

test("Gateway allowlist는 malformed, 빈 token, topic injection, 허용량 초과를 fail closed 한다", () => {
  const valid = "11111111-1111-4111-8111-111111111111";
  for (const value of ["not-a-uuid", `${valid},`, `${valid},,${valid}`, `${valid}\nuser attacker`]) {
    assert.throws(() => resolveDevEnvironment("/workspace/led-control", { DEV_GATEWAY_IDS: value }), /DEV_GATEWAY_IDS/);
  }
  assert.throws(() => renderMosquittoAcl([`${valid}\ntopic readwrite #`]), /gateway ID/i);
  const tooMany = Array.from(
    { length: 65 },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
  ).join(",");
  assert.throws(
    () => resolveDevEnvironment("/workspace/led-control", { DEV_GATEWAY_IDS: tooMany }),
    /at most 64/
  );
});

test("Mosquitto ACL은 전용 0755 디렉터리에 원자 게시되고 container-readable 0644 권한을 갖는다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-acl-"));
  const runtime = join(directory, "runtime");
  const destination = join(runtime, "mosquitto.acl");
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  try {
    mkdirSync(runtime, { mode: 0o755 });
    chmodSync(runtime, 0o755);
    publishMosquittoAcl(destination, [second, first, second]);

    assert.equal(readFileSync(destination, "utf8"), renderMosquittoAcl([first, second]));
    assert.equal(statSync(runtime).mode & 0o777, 0o755);
    assert.equal(statSync(destination).mode & 0o777, 0o644);
    assert.deepEqual(readdirSync(runtime), ["mosquitto.acl"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mosquitto ACL 게시기는 기존 runtime 디렉터리의 안전하지 않은 권한을 고치지 않고 거부한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-acl-mode-"));
  const runtime = join(directory, "runtime");
  try {
    mkdirSync(runtime, { mode: 0o700 });
    chmodSync(runtime, 0o700);

    assert.throws(() => publishMosquittoAcl(join(runtime, "mosquitto.acl"), []), /mode 0755/i);
    assert.equal(statSync(runtime).mode & 0o777, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Mosquitto ACL 게시기는 symlink parent와 symlink destination을 거부한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-acl-path-"));
  const real = join(directory, "real");
  const linked = join(directory, "linked");
  mkdirSync(real);
  chmodSync(real, 0o755);
  symlinkSync(real, linked);
  try {
    assert.throws(() => publishMosquittoAcl(join(linked, "mosquitto.acl"), []), /regular directory.*symlink/i);
    const destination = join(real, "mosquitto.acl");
    const target = join(directory, "target");
    writeFileSync(target, "old");
    symlinkSync(target, destination);
    assert.throws(() => publishMosquittoAcl(destination, []), /regular file.*symlink/i);
    const directoryDestination = join(real, "directory-target");
    mkdirSync(directoryDestination);
    assert.throws(() => publishMosquittoAcl(directoryDestination, []), /regular file.*symlink/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare-only 실행은 연속 두 번에도 ACL을 원자 재게시하고 앱이나 broker를 시작하지 않는다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-prepare-"));
  const bundle = join(directory, "bundle");
  const started = [];
  mkdirSync(bundle, { recursive: true });
  for (const filename of [
    "mqtt-ca.crt",
    "api-mqtt-client.crt",
    "api-mqtt-client.key",
    "mqtt-server.crt",
    "mqtt-server.key",
    "mqtt-client.crl"
  ]) writeFileSync(join(bundle, filename), "fixture");
  try {
    const source = {
      PKI_LAB_CURRENT_DIR: bundle,
      DEV_GATEWAY_IDS: "22222222-2222-4222-8222-222222222222,11111111-1111-4111-8111-111111111111"
    };
    const firstPrepared = prepareDevelopmentRuntime(directory, source, { run: (...args) => started.push(args) });
    const firstAcl = readFileSync(firstPrepared.aclPath, "utf8");
    const firstInode = statSync(firstPrepared.aclPath).ino;
    const firstNativeConfigInode = statSync(firstPrepared.nativeConfigPath).ino;
    const firstDockerConfigInode = statSync(firstPrepared.dockerConfigPath).ino;
    const prepared = prepareDevelopmentRuntime(directory, source, { run: (...args) => started.push(args) });

    assert.deepEqual(prepared.gatewayIds, [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
    assert.equal(prepared.aclPath, firstPrepared.aclPath);
    assert.equal(readFileSync(prepared.aclPath, "utf8"), firstAcl);
    assert.notEqual(statSync(prepared.aclPath).ino, firstInode);
    assert.equal(statSync(prepared.nativeConfigPath).ino, firstNativeConfigInode);
    assert.equal(statSync(prepared.dockerConfigPath).ino, firstDockerConfigInode);
    assert.match(readFileSync(join(directory, ".local", "mosquitto-runtime", "mosquitto.acl"), "utf8"), /^user api-service$/m);
    assert.match(readFileSync(join(directory, ".local", "mosquitto.host.conf"), "utf8"), /acl_file .*\.local\/mosquitto-runtime\/mosquitto\.acl/);
    assert.equal(
      readFileSync(join(directory, ".local", "mosquitto.docker.conf"), "utf8"),
      [
        "listener 8883",
        "allow_anonymous false",
        "cafile /mosquitto/certs/mqtt-ca.crt",
        "certfile /mosquitto/certs/mqtt-server.crt",
        "keyfile /mosquitto/certs/mqtt-server.key",
        "crlfile /mosquitto/certs/mqtt-client.crl",
        "require_certificate true",
        "use_identity_as_username true",
        "tls_version tlsv1.2",
        "acl_file /mosquitto/runtime/mosquitto.acl",
        "persistence false",
        "log_dest stdout",
        ""
      ].join("\n")
    );
    assert.equal(statSync(join(directory, ".local", "mosquitto-runtime")).mode & 0o777, 0o755);
    if (typeof process.getuid === "function") {
      assert.equal(statSync(join(directory, ".local", "mosquitto-runtime")).uid, process.getuid());
    }
    assert.equal(statSync(join(directory, ".local", "mosquitto-runtime", "mosquitto.acl")).mode & 0o777, 0o644);
    assert.deepEqual(started, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare는 unsafe .local과 default PKI 경계를 첫 PKI script 부작용 전에 거부한다", () => {
  const cases = [
    {
      name: "wide local",
      arrange(root) {
        mkdirSync(join(root, ".local"), { mode: 0o755 });
        chmodSync(join(root, ".local"), 0o755);
      },
      error: /\.local.*mode 0700/i
    },
    {
      name: "symlink pki",
      arrange(root) {
        mkdirSync(join(root, ".local"), { mode: 0o700 });
        chmodSync(join(root, ".local"), 0o700);
        mkdirSync(join(root, "outside"));
        symlinkSync(join(root, "outside"), join(root, ".local", "pki"));
      },
      error: /PKI directory.*symlink/i
    },
    {
      name: "wide pki",
      arrange(root) {
        mkdirSync(join(root, ".local"), { mode: 0o700 });
        chmodSync(join(root, ".local"), 0o700);
        mkdirSync(join(root, ".local", "pki"), { mode: 0o755 });
        chmodSync(join(root, ".local", "pki"), 0o755);
      },
      error: /PKI directory.*mode 0700/i
    }
  ];

  for (const fixture of cases) {
    const directory = mkdtempSync(join(tmpdir(), `led-control-pki-boundary-${fixture.name}-`));
    const started = [];
    try {
      fixture.arrange(directory);
      assert.throws(
        () => prepareDevelopmentRuntime(directory, {}, { run: (...args) => { started.push(args); return ok(); } }),
        fixture.error
      );
      assert.deepEqual(started, []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("prepare는 default PKI directory를 0700으로 안전하게 만든 뒤에만 PKI script를 호출한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-pki-create-"));
  let observed;
  try {
    assert.throws(
      () => prepareDevelopmentRuntime(directory, {}, {
        run: () => {
          const pki = join(directory, ".local", "pki");
          observed = {
            localMode: statSync(join(directory, ".local")).mode & 0o777,
            pkiMode: statSync(pki).mode & 0o777,
            pkiRealpath: realpathSync(pki)
          };
          return failed("fixture stops before certificate generation");
        }
      }),
      /실행에 실패했습니다/
    );
    assert.deepEqual(observed, {
      localMode: 0o700,
      pkiMode: 0o700,
      pkiRealpath: realpathSync(join(directory, ".local", "pki"))
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default PKI child scripts는 inherited PKI_DIR 대신 검증된 .local/pki만 쓴다", () => {
  const gatewayId = "11111111-1111-4111-8111-111111111111";
  const fixtures = [
    { expectedScript: "create-ca.sh", source: {} },
    {
      expectedScript: "issue-gateway-cert.sh",
      source: { DEV_GATEWAY_ID: gatewayId },
      seed(pki) {
        for (const filename of ["ca.crt", "api.crt", "broker.crt"]) writeFileSync(join(pki, filename), "fixture");
      }
    }
  ];

  for (const fixture of fixtures) {
    const directory = mkdtempSync(join(tmpdir(), `led-control-pki-env-${fixture.expectedScript}-`));
    const local = join(directory, ".local");
    const pki = join(local, "pki");
    const outside = join(directory, "outside-pki");
    const calls = [];
    try {
      if (fixture.seed) {
        mkdirSync(local, { mode: 0o700 });
        chmodSync(local, 0o700);
        mkdirSync(pki, { mode: 0o700 });
        chmodSync(pki, 0o700);
        fixture.seed(pki);
      }
      assert.throws(
        () => prepareDevelopmentRuntime(directory, { ...fixture.source, PKI_DIR: outside }, {
          run: (command, args, options) => {
            calls.push({ command, args, pkiDirectory: options.env.PKI_DIR });
            mkdirSync(options.env.PKI_DIR, { recursive: true });
            writeFileSync(join(options.env.PKI_DIR, "child-write-marker"), "fixture");
            return failed("fixture stops child after simulated write");
          }
        }),
        /실행에 실패했습니다/
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command.endsWith(`/scripts/dev-pki/${fixture.expectedScript}`), true);
      assert.equal(calls[0].pkiDirectory, realpathSync(pki));
      assert.equal(readFileSync(join(pki, "child-write-marker"), "utf8"), "fixture");
      assert.equal(existsSync(outside), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Lab external PKI는 inherited PKI_DIR과 무관하게 child script 없이 기존 bundle을 사용한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-pki-env-lab-"));
  const bundle = join(directory, "bundle");
  const outside = join(directory, "outside-pki");
  const calls = [];
  mkdirSync(bundle);
  for (const filename of [
    "mqtt-ca.crt", "api-mqtt-client.crt", "api-mqtt-client.key",
    "mqtt-server.crt", "mqtt-server.key", "mqtt-client.crl"
  ]) writeFileSync(join(bundle, filename), "lab");
  try {
    const prepared = prepareDevelopmentRuntime(directory, {
      PKI_LAB_CURRENT_DIR: bundle,
      MQTT_TLS_CERT_DIR: bundle,
      PKI_DIR: outside
    }, { run: (...args) => { calls.push(args); return ok(); } });
    assert.equal(prepared.dockerCertDirectory, realpathSync(bundle));
    assert.deepEqual(calls, []);
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare는 config 내용 변경에만 새 inode를 게시하고 unsafe config mode는 거부한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-config-change-"));
  const local = join(directory, ".local");
  const pki = join(local, "pki");
  const lab = join(directory, "lab");
  mkdirSync(local, { mode: 0o700 });
  chmodSync(local, 0o700);
  mkdirSync(pki, { mode: 0o700 });
  chmodSync(pki, 0o700);
  for (const filename of ["ca.crt", "api.crt", "api.key", "broker.crt", "broker.key", "ca.crl"]) {
    writeFileSync(join(pki, filename), "development");
  }
  mkdirSync(lab);
  for (const filename of [
    "mqtt-ca.crt", "api-mqtt-client.crt", "api-mqtt-client.key",
    "mqtt-server.crt", "mqtt-server.key", "mqtt-client.crl"
  ]) writeFileSync(join(lab, filename), "lab");
  try {
    const development = prepareDevelopmentRuntime(directory, {});
    const nativeInode = statSync(development.nativeConfigPath).ino;
    const dockerInode = statSync(development.dockerConfigPath).ino;
    const changed = prepareDevelopmentRuntime(directory, { PKI_LAB_CURRENT_DIR: lab, MQTT_TLS_CERT_DIR: lab });
    assert.notEqual(statSync(changed.nativeConfigPath).ino, nativeInode);
    assert.notEqual(statSync(changed.dockerConfigPath).ino, dockerInode);

    chmodSync(changed.dockerConfigPath, 0o644);
    assert.throws(
      () => prepareDevelopmentRuntime(directory, { PKI_LAB_CURRENT_DIR: lab, MQTT_TLS_CERT_DIR: lab }),
      /config destination.*mode 0600/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare는 Lab current symlink의 generation realpath를 immutable Docker source로 캡처한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-cert-generation-"));
  const generations = join(directory, "generations");
  const first = join(generations, "first");
  const second = join(generations, "second");
  const current = join(directory, "current");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  for (const bundle of [first, second]) {
    for (const filename of [
      "mqtt-ca.crt", "api-mqtt-client.crt", "api-mqtt-client.key",
      "mqtt-server.crt", "mqtt-server.key", "mqtt-client.crl"
    ]) writeFileSync(join(bundle, filename), bundle);
  }
  symlinkSync(first, current);
  try {
    const prepared = prepareDevelopmentRuntime(directory, {
      PKI_LAB_CURRENT_DIR: current,
      MQTT_TLS_CERT_DIR: current
    });
    assert.equal(prepared.dockerCertDirectory, realpathSync(first));
    rmSync(current);
    symlinkSync(second, current);

    const signals = [];
    const inspection = [{
      Config: { Labels: { "com.docker.compose.project.working_dir": directory, "com.docker.compose.service": "mqtt-tls" } },
      State: { Running: true },
      NetworkSettings: { Ports: { "8883/tcp": [{ HostPort: "8883" }] } },
      Mounts: [
        { Type: "bind", Source: dirname(prepared.aclPath), Destination: "/mosquitto/runtime", RW: false },
        { Type: "bind", Source: prepared.dockerConfigPath, Destination: "/mosquitto/config/mosquitto.conf", RW: false },
        { Type: "bind", Source: second, Destination: "/mosquitto/certs", RW: false }
      ]
    }];
    const run = (command, args) => {
      if (command === "docker" && args.join(" ") === "compose ps -q mqtt-tls") return ok("repo-mqtt-container\n");
      if (command === "docker" && args[0] === "inspect") return ok(JSON.stringify(inspection));
      if (command === "docker" && args[0] === "kill") { signals.push(args); return ok(); }
      return failed(`unexpected ${command} ${args.join(" ")}`);
    };
    assert.throws(
      () => reloadExistingDevelopmentBroker({ root: directory, ...prepared, platform: "linux", run }),
      /unmanaged process owns port 8883/i
    );
    assert.deepEqual(signals, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepare는 symlink local/config와 잘못된 local 타입을 따라가지 않고 거부한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-prepare-path-"));
  const bundle = join(directory, "bundle");
  const outside = join(directory, "outside");
  const source = { PKI_LAB_CURRENT_DIR: bundle };
  mkdirSync(bundle);
  mkdirSync(outside);
  for (const filename of [
    "mqtt-ca.crt", "api-mqtt-client.crt", "api-mqtt-client.key",
    "mqtt-server.crt", "mqtt-server.key", "mqtt-client.crl"
  ]) writeFileSync(join(bundle, filename), "fixture");
  try {
    symlinkSync(outside, join(directory, ".local"));
    assert.throws(() => prepareDevelopmentRuntime(directory, source), /\.local.*directory.*symlink/i);
    assert.deepEqual(readdirSync(outside), []);

    rmSync(join(directory, ".local"));
    prepareDevelopmentRuntime(directory, source);
    const target = join(outside, "target");
    writeFileSync(target, "unchanged");
    rmSync(join(directory, ".local", "mosquitto.docker.conf"));
    symlinkSync(target, join(directory, ".local", "mosquitto.docker.conf"));
    assert.throws(() => prepareDevelopmentRuntime(directory, source), /destination.*regular file.*symlink/i);
    assert.equal(readFileSync(target, "utf8"), "unchanged");
    assert.doesNotMatch(readdirSync(join(directory, ".local")).join("\n"), /\.tmp$/);

    rmSync(join(directory, ".local"), { recursive: true, force: true });
    writeFileSync(join(directory, ".local"), "not a directory");
    assert.throws(() => prepareDevelopmentRuntime(directory, source), /\.local.*directory.*symlink/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("개발 시작 스크립트는 prepare 결과만 사용하고 기존 8883 broker를 검증·reload한다", () => {
  const source = readFileSync(new URL("./dev.mjs", import.meta.url), "utf8");

  assert.match(source, /prepareDevelopmentRuntime\(root, sourceEnv\)/);
  assert.match(
    source,
    /reloadExistingDevelopmentBroker\(\{\s*root,\s*aclPath,\s*dockerConfigPath,\s*dockerCertDirectory/
  );
  assert.match(source, /publishNativeBrokerIdentity\(nativeIdentityPath,/);
  assert.match(source, /removeNativeBrokerIdentity\(nativeIdentityPath, broker\.pid\)/);
  assert.doesNotMatch(source, /if \(!\(await isPortOpen\(8883\)\)\) \{/);
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
  assert.match(
    acl,
    /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/provisioning\/device-terminal-ingested/
  );
  assert.match(acl, /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/state-ingested/);
  assert.match(
    acl,
    /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/automation\/config-applied-ingested/
  );
  assert.match(
    acl,
    /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/automation\/execution-ingested/
  );
  assert.match(
    acl,
    /topic read sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/automation\/vehicle-sensor-capability-ingested/
  );
  assert.match(acl, /topic write sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/acceptance/);
  assert.match(acl, /topic write sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/device-status/);
  assert.doesNotMatch(acl, /topic write sites\/\+\/gateways\/00000000-0000-4000-8000-000000000004\/acks\/#/);
  assert.doesNotMatch(acl, /topic write .*\/acks\/(?:state-ingested|provisioning\/scan-terminal-ingested)/);
});

test("기본 pnpm dev는 실제 장비 시험을 위해 mock gateway를 실행하지 않는다", () => {
  assert.deepEqual(resolveDevAppFilters([]), ["@led-control/api", "@led-control/web"]);
});

test("통합 로컬 개발 명령은 ACL prepare를 Docker 시작보다 먼저 완료한다", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const developmentSource = readFileSync(new URL("./dev.mjs", import.meta.url), "utf8");

  assert.equal(packageJson.scripts["dev:local"], "pnpm dev:prepare && pnpm docker:up && pnpm dev");
  assert.equal(packageJson.scripts["dev:prepare"], "node scripts/dev-prepare.mjs");
  assert.match(packageJson.scripts.dev, /node scripts\/dev\.mjs/);
  assert.match(developmentSource, /prepareDevelopmentRuntime\(root, sourceEnv\)/);
});

test("루트 전체 테스트는 workspace gate와 fail-closed UI 정책 검사를 모두 실행한다", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.scripts.test, "node scripts/workspace-gate.mjs test");
  assert.match(
    packageJson.scripts["test:unit"],
    /&& pnpm -r test && pnpm --filter @led-control\/web test:ui-policy && pnpm --filter @led-control\/web ui:check$/
  );
});

test("MinIO 초기화는 전체 버킷 생성 절차를 하나의 셸 스크립트 인자로 전달한다", () => {
  const compose = renderCompose();
  const command = compose.services["object-storage-init"].command;
  assert.equal(command.length, 1);
  assert.match(command[0], /until mc alias set[\s\S]+do sleep 2; done/);
  assert.match(command[0], /mc mb --ignore-existing[\s\S]+energy-reports/);
  assert.match(command[0], /mc anonymous set none/);
});

test("MinIO 초기화는 floor-assets bucket 생성 실패를 종료 코드로 전파한다", () => {
  const result = runObjectStorageInitWithMcFailure("mb --ignore-existing local/floor-assets");

  assert.notEqual(result.status, 0, result.stderr);
});

test("MinIO 초기화는 floor-assets private policy 적용 실패를 종료 코드로 전파한다", () => {
  const result = runObjectStorageInitWithMcFailure("anonymous set none local/floor-assets");

  assert.notEqual(result.status, 0, result.stderr);
});

test("고정 MinIO 서버는 미설정 WEB_PUBLIC_URL에 개발 CORS origin을 사용한다", () => {
  const compose = renderCompose({ WEB_PUBLIC_URL: "" });
  const objectStorage = compose.services["object-storage"];

  assert.equal(objectStorage.image, "minio/minio:RELEASE.2025-04-22T22-12-26Z");
  assert.equal(objectStorage.environment.MINIO_API_CORS_ALLOW_ORIGIN, "http://localhost:5173");
});

test("고정 MinIO 서버는 사용자 지정 WEB_PUBLIC_URL을 CORS origin으로 정확히 전달한다", () => {
  const compose = renderCompose({ WEB_PUBLIC_URL: "http://127.0.0.1:4173" });

  assert.equal(
    compose.services["object-storage"].environment.MINIO_API_CORS_ALLOW_ORIGIN,
    "http://127.0.0.1:4173"
  );
});

test("MinIO 초기화는 private bucket 정책만 적용하고 지원되지 않는 bucket CORS 설정을 사용하지 않는다", () => {
  const compose = renderCompose();
  const objectStorageInit = compose.services["object-storage-init"];
  const command = objectStorageInit.command[0];

  assert.doesNotMatch(command, /mc cors/);
  assert.equal((command.match(/mc anonymous set none/g) ?? []).length, 2);
  assert.equal(objectStorageInit.volumes, undefined);
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
  assert.match(config, /^crlfile \/mosquitto\/crls\/mqtt-client\.crl$/m);
  assert.match(config, /^require_certificate true$/m);
  assert.match(config, /^use_identity_as_username true$/m);
  assert.match(config, /^tls_version tlsv1\.2$/m);
  assert.match(config, /^acl_file \/mosquitto\/config\/mosquitto\.acl$/m);
  assert.doesNotMatch(config, /allow_anonymous true|require_certificate false|use_identity_as_username false/i);
  assert.match(acl, /^pattern read sites\/\+\/gateways\/%u\/acks\/state-ingested$/m);
  assert.match(acl, /^pattern read sites\/\+\/gateways\/%u\/acks\/provisioning\/scan-terminal-ingested$/m);
  assert.match(acl, /^pattern read sites\/\+\/gateways\/%u\/acks\/provisioning\/device-terminal-ingested$/m);
  assert.match(acl, /^pattern write sites\/\+\/gateways\/%u\/acks\/acceptance$/m);
  assert.match(acl, /^pattern write sites\/\+\/gateways\/%u\/acks\/device-status$/m);
  assert.doesNotMatch(acl, /^pattern write .*\/acks\/#$/m);
  assert.doesNotMatch(acl, /^pattern write .*\/acks\/(?:state-ingested|provisioning\/scan-terminal-ingested)$/m);
  assert.doesNotMatch(acl, /^pattern write .*\/acks\/provisioning\/device-terminal-ingested$/m);
});

test("Compose 개발 broker는 override를 무시하고 exact host path 3개를 missing-path fail-closed로 mount한다", () => {
  const mqtt = renderCompose({
    MOSQUITTO_TLS_CONFIG_PATH: "/tmp/attacker.conf",
    MQTT_TLS_CERT_DIR: "./.local/lab-pki/services/current"
  }).services["mqtt-tls"];
  const aclMount = mqtt.volumes.find((volume) => volume.target === "/mosquitto/runtime");
  const configMount = mqtt.volumes.find((volume) => volume.target === "/mosquitto/config/mosquitto.conf");
  const certMount = mqtt.volumes.find((volume) => volume.target === "/mosquitto/certs");

  assert.equal(configMount.type, "bind");
  assert.equal(aclMount.source, new URL("../.local/mosquitto-runtime", import.meta.url).pathname);
  assert.equal(aclMount.read_only, true);
  assert.equal(configMount.source, new URL("../.local/mosquitto.docker.conf", import.meta.url).pathname);
  assert.equal(configMount.read_only, true);
  assert.equal(certMount.source, new URL("../.local/lab-pki/services/current", import.meta.url).pathname);
  for (const mount of [configMount, aclMount, certMount]) {
    assert.equal(mount.type, "bind");
    assert.equal(mount.read_only, true);
    assert.equal(mount.bind.create_host_path, false);
  }
  assert.doesNotMatch(aclMount.source, /infra\/mosquitto\.acl\.example$/);
});

test("repo-owned Docker broker만 exact container SIGHUP 후 mounted ACL 일치를 검증한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-docker-owner-"));
  const runtimePath = join(directory, ".local", "mosquitto-runtime");
  const aclPath = join(runtimePath, "mosquitto.acl");
  const dockerConfigPath = join(directory, ".local", "mosquitto.docker.conf");
  const dockerCertDirectory = join(directory, "bundle");
  const dockerCertGeneration = join(directory, "bundle-generation");
  const signals = [];
  mkdirSync(runtimePath, { recursive: true });
  mkdirSync(dockerCertGeneration);
  symlinkSync(dockerCertGeneration, dockerCertDirectory);
  const capturedDockerCertSource = realpathSync(dockerCertDirectory);
  writeFileSync(aclPath, "user api-service\ntopic readwrite sites/#\n\n", { mode: 0o644 });
  writeFileSync(dockerConfigPath, "listener 8883\n", { mode: 0o600 });
  const inspection = [{
    Config: { Labels: { "com.docker.compose.project.working_dir": directory, "com.docker.compose.service": "mqtt-tls" } },
    State: { Running: true },
    NetworkSettings: { Ports: { "8883/tcp": [{ HostIp: "0.0.0.0", HostPort: "8883" }] } },
    Mounts: [
      { Type: "bind", Source: `/host_mnt${runtimePath}`, Destination: "/mosquitto/runtime", RW: false },
      { Type: "bind", Source: `/host_mnt${dockerConfigPath}`, Destination: "/mosquitto/config/mosquitto.conf", RW: false },
      { Type: "bind", Source: `/host_mnt${capturedDockerCertSource}`, Destination: "/mosquitto/certs", RW: false }
    ]
  }];
  const run = (command, args) => {
    if (command === "docker" && args.join(" ") === "compose ps -q mqtt-tls") return ok("repo-mqtt-container\n");
    if (command === "docker" && args[0] === "inspect") return ok(JSON.stringify(inspection));
    if (command === "docker" && args[0] === "kill") {
      signals.push(args.slice(1));
      return ok("repo-mqtt-container\n");
    }
    if (command === "docker" && args.join(" ") === "exec repo-mqtt-container cat /mosquitto/config/mosquitto.conf") {
      return ok(readFileSync(dockerConfigPath, "utf8"));
    }
    if (command === "docker" && args.join(" ") === "exec -u 1883:1883 repo-mqtt-container cat /mosquitto/runtime/mosquitto.acl") {
      return ok(readFileSync(aclPath, "utf8"));
    }
    return failed(`unexpected ${command} ${args.join(" ")}`);
  };
  try {
    assert.deepEqual(
      reloadExistingDevelopmentBroker({
        root: directory,
        aclPath,
        dockerConfigPath,
        dockerCertDirectory: capturedDockerCertSource,
        platform: "darwin",
        run
      }),
      { kind: "docker", id: "repo-mqtt-container" }
    );
    assert.deepEqual(signals, [["--signal=SIGHUP", "repo-mqtt-container"]]);
    assert.throws(
      () => reloadExistingDevelopmentBroker({
        root: directory,
        aclPath,
        dockerConfigPath,
        dockerCertDirectory: capturedDockerCertSource,
        platform: "linux",
        run
      }),
      /unmanaged process owns port 8883/i
    );
    assert.deepEqual(signals, [["--signal=SIGHUP", "repo-mqtt-container"]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker broker는 inspect mount가 맞아도 container config inode가 stale이면 recreate 지시 후 signal하지 않는다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-docker-stale-config-"));
  const runtimePath = join(directory, ".local", "mosquitto-runtime");
  const aclPath = join(runtimePath, "mosquitto.acl");
  const dockerConfigPath = join(directory, ".local", "mosquitto.docker.conf");
  const dockerCertDirectory = join(directory, "bundle");
  const signals = [];
  mkdirSync(runtimePath, { recursive: true });
  mkdirSync(dockerCertDirectory);
  writeFileSync(aclPath, "user api-service\ntopic readwrite sites/#\n\n");
  writeFileSync(dockerConfigPath, "listener 8883\nallow_anonymous false\n");
  const inspection = [{
    Config: { Labels: { "com.docker.compose.project.working_dir": directory, "com.docker.compose.service": "mqtt-tls" } },
    State: { Running: true },
    NetworkSettings: { Ports: { "8883/tcp": [{ HostPort: "8883" }] } },
    Mounts: [
      { Type: "bind", Source: runtimePath, Destination: "/mosquitto/runtime", RW: false },
      { Type: "bind", Source: dockerConfigPath, Destination: "/mosquitto/config/mosquitto.conf", RW: false },
      { Type: "bind", Source: dockerCertDirectory, Destination: "/mosquitto/certs", RW: false }
    ]
  }];
  const run = (command, args) => {
    if (command === "docker" && args.join(" ") === "compose ps -q mqtt-tls") return ok("repo-mqtt-container\n");
    if (command === "docker" && args[0] === "inspect") return ok(JSON.stringify(inspection));
    if (command === "docker" && args.join(" ") === "exec repo-mqtt-container cat /mosquitto/config/mosquitto.conf") {
      return ok("listener 8883\nallow_anonymous true\n");
    }
    if (command === "docker" && args[0] === "kill") { signals.push(args); return ok(); }
    return failed(`unexpected ${command} ${args.join(" ")}`);
  };
  try {
    assert.throws(
      () => reloadExistingDevelopmentBroker({
        root: directory, aclPath, dockerConfigPath, dockerCertDirectory, platform: "linux", run
      }),
      /docker compose up -d --force-recreate mqtt-tls/i
    );
    assert.deepEqual(signals, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker broker owner 검증은 config/cert/ACL mount 하나라도 바뀌면 signal 전에 거부한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-docker-mount-owner-"));
  const runtimePath = join(directory, ".local", "mosquitto-runtime");
  const aclPath = join(runtimePath, "mosquitto.acl");
  const dockerConfigPath = join(directory, ".local", "mosquitto.docker.conf");
  const dockerCertDirectory = join(directory, "bundle");
  mkdirSync(runtimePath, { recursive: true });
  mkdirSync(dockerCertDirectory);
  writeFileSync(aclPath, "user api-service\ntopic readwrite sites/#\n\n");
  writeFileSync(dockerConfigPath, "listener 8883\n");
  const baseMounts = [
    { Type: "bind", Source: runtimePath, Destination: "/mosquitto/runtime", RW: false },
    { Type: "bind", Source: dockerConfigPath, Destination: "/mosquitto/config/mosquitto.conf", RW: false },
    { Type: "bind", Source: dockerCertDirectory, Destination: "/mosquitto/certs", RW: false }
  ];
  const mutations = [
    (mounts) => mounts.filter((mount) => mount.Destination !== "/mosquitto/config/mosquitto.conf"),
    (mounts) => mounts.map((mount) => mount.Destination === "/mosquitto/config/mosquitto.conf" ? { ...mount, Source: join(directory, "wrong.conf") } : mount),
    (mounts) => mounts.map((mount) => mount.Destination === "/mosquitto/certs" ? { ...mount, RW: true } : mount),
    (mounts) => [...mounts, { ...mounts[2] }],
    (mounts) => mounts.map((mount) => mount.Destination === "/mosquitto/runtime" ? { ...mount, Type: "volume" } : mount)
  ];
  try {
    for (const mutate of mutations) {
      const signals = [];
      const inspection = [{
        Config: { Labels: { "com.docker.compose.project.working_dir": directory, "com.docker.compose.service": "mqtt-tls" } },
        State: { Running: true },
        NetworkSettings: { Ports: { "8883/tcp": [{ HostPort: "8883" }] } },
        Mounts: mutate(baseMounts.map((mount) => ({ ...mount })))
      }];
      const run = (command, args) => {
        if (command === "docker" && args.join(" ") === "compose ps -q mqtt-tls") return ok("repo-mqtt-container\n");
        if (command === "docker" && args[0] === "inspect") return ok(JSON.stringify(inspection));
        if (command === "docker" && args[0] === "kill") { signals.push(args); return ok(); }
        if (command === "docker" && args[0] === "exec") return ok(readFileSync(aclPath, "utf8"));
        return failed(`unexpected ${command} ${args.join(" ")}`);
      };
      assert.throws(
        () => reloadExistingDevelopmentBroker({ root: directory, aclPath, dockerConfigPath, dockerCertDirectory, run }),
        /unmanaged process owns port 8883/i
      );
      assert.deepEqual(signals, []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact pid/config/listener가 일치하는 managed native broker만 SIGHUP한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-native-owner-"));
  const local = join(directory, ".local");
  const runtime = join(local, "mosquitto-runtime");
  const aclPath = join(runtime, "mosquitto.acl");
  const config = join(local, "mosquitto.host.conf");
  const binary = join(directory, "mosquitto");
  const identityPath = join(local, "mosquitto.host.pid.json");
  const signals = [];
  mkdirSync(local, { recursive: true });
  mkdirSync(runtime, { mode: 0o755 });
  writeFileSync(aclPath, "user api-service\ntopic readwrite sites/#\n\n", { mode: 0o644 });
  writeFileSync(config, `acl_file ${aclPath}\n`);
  writeFileSync(binary, "native broker fixture");
  chmodSync(binary, 0o755);
  publishNativeBrokerIdentity(identityPath, { pid: 4321, root: directory, binary, config });
  const run = (command, args) => {
    if (command === "docker") return ok("");
    if (command === "lsof") return ok("4321\n4321\n");
    if (command === "ps") return ok(`${binary} -c ${config}\n`);
    return failed(`unexpected ${command} ${args.join(" ")}`);
  };
  try {
    assert.deepEqual(
      reloadExistingDevelopmentBroker({
        root: directory,
        aclPath,
        nativeIdentityPath: identityPath,
        run,
        signalProcess: (pid, signal) => signals.push([pid, signal])
      }),
      { kind: "native", pid: 4321 }
    );
    assert.deepEqual(signals, [[4321, "SIGHUP"]]);
    assert.equal(statSync(identityPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("8883 owner가 repo Docker 또는 managed native와 exact 일치하지 않으면 fail closed 한다", () => {
  const directory = mkdtempSync(join(tmpdir(), "led-control-unknown-owner-"));
  const aclPath = join(directory, "mosquitto.acl");
  writeFileSync(aclPath, "user api-service\ntopic readwrite sites/#\n\n", { mode: 0o600 });
  const signals = [];
  const run = (command) => command === "docker" ? ok("") : command === "lsof" ? ok("9999\n") : failed("unexpected");
  try {
    assert.throws(
      () => reloadExistingDevelopmentBroker({ root: directory, aclPath, run, signalProcess: (...args) => signals.push(args) }),
      /unmanaged process owns port 8883/i
    );
    assert.deepEqual(signals, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

function renderCompose(environment = {}) {
  const result = spawnSync("docker", ["compose", "--env-file", "/dev/null", "config", "--format", "json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment }
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function failed(stderr) {
  return { status: 1, stdout: "", stderr };
}

function runObjectStorageInitWithMcFailure(failingArguments) {
  const directory = mkdtempSync(join(tmpdir(), "led-control-mc-"));
  const fakeMcPath = join(directory, "mc");
  writeFileSync(fakeMcPath, `#!/bin/sh\nif [ "$*" = "${failingArguments}" ]; then exit 42; fi\nexit 0\n`);
  chmodSync(fakeMcPath, 0o755);

  try {
    const command = renderCompose().services["object-storage-init"].command[0].replaceAll("$${", "${");
    return spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
