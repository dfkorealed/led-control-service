import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const gatewayDir = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

test("Raspberry Pi compose는 host network와 read-only runtime을 사용한다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");

  assert.match(compose, /network_mode:\s*host/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /init:\s*true/);
  assert.match(compose, /restart:\s*unless-stopped/);
  assert.match(compose, /tmpfs:/);
  assert.match(compose, /seccomp=\.\/docker\/seccomp-bluez-mesh\.json/);
  assert.doesNotMatch(compose, /seccomp=unconfined/);
});

test("BIO overlay는 계산된 raw USB node 하나와 숫자 supplemental group만 추가한다", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "gateway-bio-compose-"));
  try {
    await writeFile(path.join(fixture, "compose.yml"), await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml")));
    await writeFile(path.join(fixture, "compose.bio-usb.yml"), await readFile(path.join(gatewayDir, "compose.bio-usb.yml")));
    await writeFile(path.join(fixture, ".env.appliance"), "");
    const { stdout } = await execFileAsync("docker", [
      "compose", "-f", "compose.yml", "-f", "compose.bio-usb.yml", "config", "--format", "json"
    ], {
      cwd: fixture,
      env: {
        ...process.env,
        GATEWAY_BIO_USB_DEVICE: "/dev/bus/usb/002/007",
        GATEWAY_BIO_USB_GID: "812"
      }
    });
    const service = JSON.parse(stdout).services["gateway-appliance"];

    assert.equal(service.privileged ?? false, false);
    assert.notEqual(service.user, "root");
    assert.deepEqual(service.group_add, ["812"]);
    assert.deepEqual(service.devices, [{ source: "/dev/bus/usb/002/007", target: "/dev/bus/usb/002/007", permissions: "rwm" }]);
    assert.equal(service.environment.GATEWAY_ADAPTER, "bio-usb");
    assert.equal(service.environment.GATEWAY_BIO_USB_DEVICE, "/dev/bus/usb/002/007");
    assert.equal(service.environment.GATEWAY_BIO_USB_GID, "812");
    assert.ok(service.cap_add.includes("SETPCAP"));
    assert.equal(service.volumes.some((volume) => volume.source === "/dev" || volume.source === "/dev/bus/usb"), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("BIO 전용 SETPCAP bootstrap은 기본 BlueZ compose capability를 바꾸지 않는다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");
  assert.doesNotMatch(compose, /- SETPCAP\b/);
});

test("BlueZ Mesh seccomp profile은 Docker 기본 차단을 유지하고 AF_ALG만 추가 허용한다", async () => {
  const profile = JSON.parse(await readFile(path.join(gatewayDir, "docker/seccomp-bluez-mesh.json"), "utf8"));
  const socketRules = profile.syscalls.filter((rule) => rule.names.includes("socket") && rule.action === "SCMP_ACT_ALLOW");

  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert.equal(matchesSocketDomain(socketRules, 38), true, "BlueZ ELL crypto에 필요한 AF_ALG가 허용되어야 한다");
  assert.equal(matchesSocketDomain(socketRules, 40), false, "AF_VSOCK은 Docker 기본 프로필처럼 차단되어야 한다");
});

test("Raspberry Pi compose는 최소 capability와 명시적 영속 mount만 사용한다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");

  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /cap_add:\s*\n\s*- NET_ADMIN\s*\n\s*- NET_RAW/);
  assert.match(compose, /- FOWNER\b/, "bind mount 권한 정규화를 위한 FOWNER capability가 필요하다");
  assert.match(compose, /\/var\/lib\/led-control/);
  assert.match(compose, /\/var\/lib\/bluetooth\/mesh/);
  assert.doesNotMatch(compose, /privileged:\s*true/);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(compose, /-\s*\/dev(?::|\/)/);
});

test("automation state는 persistent volume에 두고 systemd timesync directory만 read-only로 bind한다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");

  assert.match(compose, /GATEWAY_AUTOMATION_STATE_PATH:\s*\/var\/lib\/led-control\/automation-state\.json/);
  assert.match(
    compose,
    /-\s*\/run\/systemd\/timesync:\/run\/systemd\/timesync:ro/
  );
  assert.doesNotMatch(compose, /\/run\/systemd\/timesync\/synchronized:/);
  assert.doesNotMatch(compose, /\/run\/systemd:\/run\/systemd(?:\s|:)/);
});

function matchesSocketDomain(rules, domain) {
  return rules.some((rule) => rule.args?.every(({ index, value, op }) => {
    if (index !== 0) return true;
    if (op === "SCMP_CMP_LT") return domain < value;
    if (op === "SCMP_CMP_EQ") return domain === value;
    if (op === "SCMP_CMP_GT") return domain > value;
    return false;
  }) ?? true);
}

test("device identity와 Task 27 MQTT identity 경로를 분리하고 factory trust는 read-only로 둔다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");
  const envExample = await readFile(path.join(gatewayDir, ".env.appliance.example"), "utf8");
  const readme = await readFile(path.join(gatewayDir, "README.md"), "utf8");

  assert.match(compose, /\/identity:\/var\/lib\/led-control\/identity(?!:ro)/);
  assert.match(compose, /\/factory-trust:\/etc\/led-control\/factory-trust:ro/);
  assert.doesNotMatch(compose, /\/etc\/led-control\/certs:ro/);
  assert.match(compose, /GATEWAY_IDENTITY_ROOT:\s*\/var\/lib\/led-control\/identity\/device/);
  assert.match(compose, /GATEWAY_DEVICE_CERT_PATH:\s*\/var\/lib\/led-control\/identity\/device\/current\/device\.crt/);
  assert.match(compose, /GATEWAY_DEVICE_KEY_PATH:\s*\/var\/lib\/led-control\/identity\/device\/current\/device\.key/);
  assert.match(compose, /GATEWAY_BOOTSTRAP_CA_PATH:\s*\/var\/lib\/led-control\/identity\/device\/current\/api-ca\.crt/);
  assert.match(compose, /MQTT_CA_PATH:\s*\/var\/lib\/led-control\/identity\/mqtt\/current\/mqtt-ca\.crt/);
  assert.match(compose, /MQTT_CLIENT_CERT_PATH:\s*\/var\/lib\/led-control\/identity\/mqtt\/current\/gateway\.crt/);
  assert.match(compose, /MQTT_CLIENT_KEY_PATH:\s*\/var\/lib\/led-control\/identity\/mqtt\/current\/gateway\.key/);
  assert.doesNotMatch(compose, /identity\/device\/current\/gateway\.(?:crt|key)/);
  assert.match(compose, /GATEWAY_FACTORY_API_CA_PATH:\s*\/etc\/led-control\/factory-trust\/api-ca\.crt/);
  assert.match(envExample, /^MQTT_URL=mqtts:\/\//m);
  assert.match(envExample, /^GATEWAY_BLUEZ_IO=generic:hci0$/m);
  assert.match(envExample, /^GATEWAY_PROVISIONING_DEVICE_JOURNAL_PATH=\/var\/lib\/led-control\/provisioning-device-journal\.json$/m);
  assert.match(compose, /GATEWAY_PROVISIONING_DEVICE_JOURNAL_PATH:\s*\/var\/lib\/led-control\/provisioning-device-journal\.json/);
  assert.doesNotMatch(envExample, /^MQTT_URL=mqtt:\/\//m);
  assert.doesNotMatch(envExample, /PRIVATE KEY|BEGIN CERTIFICATE/);
  assert.match(readme, /Task 27[^\n]*MQTT 연결 전에[^\n]*identity\/mqtt\/current/);
});

test("encrypted state tooling and Compose share exactly four persistent roots", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");
  const rootPackage = JSON.parse(await readFile(path.resolve(gatewayDir, "../../package.json"), "utf8"));
  const mounts = [...compose.matchAll(/- "\$\{GATEWAY_DATA_DIR:-\/opt\/led-control\/data\}\/([^:]+):([^"\s]+)"/g)]
    .map(([, root, target]) => [root, target]).sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(mounts, [
    ["factory-trust", "/etc/led-control/factory-trust:ro"],
    ["gateway", "/var/lib/led-control"],
    ["identity", "/var/lib/led-control/identity"],
    ["mesh", "/var/lib/bluetooth/mesh"],
  ]);
  assert.equal(rootPackage.scripts["gateway:state:test"], "node --test scripts/gateway-appliance-state.test.mjs");
  assert.equal(rootPackage.scripts["gateway:state"], "scripts/gateway-appliance-state.sh");
});
