import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
});

test("Raspberry Pi compose는 최소 capability와 명시적 영속 mount만 사용한다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");

  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /cap_add:\s*\n\s*- NET_ADMIN\s*\n\s*- NET_RAW/);
  assert.match(compose, /\/var\/lib\/led-control/);
  assert.match(compose, /\/var\/lib\/bluetooth\/mesh/);
  assert.doesNotMatch(compose, /privileged:\s*true/);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(compose, /-\s*\/dev(?::|\/)/);
});

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
  assert.doesNotMatch(envExample, /^MQTT_URL=mqtt:\/\//m);
  assert.doesNotMatch(envExample, /PRIVATE KEY|BEGIN CERTIFICATE/);
  assert.match(readme, /Task 27[^\n]*MQTT 연결 전에[^\n]*identity\/mqtt\/current/);
});

test("runbook 백업은 compose와 같은 GATEWAY_DATA_DIR에서 outbox와 manifest를 보관한다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");
  const envExample = await readFile(path.join(gatewayDir, ".env.appliance.example"), "utf8");
  const runbook = await readFile(path.resolve(gatewayDir, "../../docs/runbooks/raspberry-pi-gateway-appliance.md"), "utf8");

  assert.match(compose, /\$\{GATEWAY_DATA_DIR:-\/opt\/led-control\/data\}\/gateway:\/var\/lib\/led-control/);
  assert.match(envExample, /^GATEWAY_DATA_DIR=\/opt\/led-control\/data$/m);
  assert.match(runbook, /GATEWAY_DATA_DIR="\$\{GATEWAY_DATA_DIR:-\/opt\/led-control\/data\}"/);
  assert.match(runbook, /tar -C "\$GATEWAY_DATA_DIR"[^\n]*gateway mesh/);
  assert.match(runbook, /tar -C "\$GATEWAY_DATA_DIR" -xzf "\$BACKUP_PATH" gateway mesh/);
  assert.match(runbook, /rm -f "\$GATEWAY_DATA_DIR\/gateway\/state-event-outbox\.json"/);
  assert.doesNotMatch(runbook, /\/opt\/led-control\/gateway\/data\/gateway/);

  for (const label of ["default", "custom"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `gateway-backup-${label}-`));
    const dataDir = label === "default" ? path.join(root, "opt/led-control/data") : path.join(root, "mnt/gateway-data");
    const archive = path.join(root, "gateway-data-backup.tgz");
    const restoreDir = path.join(root, "restore");
    try {
      await mkdir(path.join(dataDir, "gateway"), { recursive: true });
      await mkdir(path.join(dataDir, "mesh"), { recursive: true });
      await writeFile(path.join(dataDir, "gateway/state-event-outbox.json"), "{}\n");
      await writeFile(path.join(dataDir, "gateway/state-event-outbox.json.manifest.json"), "{}\n");
      await execFileAsync("tar", ["-C", dataDir, "-czf", archive, "gateway", "mesh"]);
      const { stdout } = await execFileAsync("tar", ["-tzf", archive]);
      assert.match(stdout, /gateway\/state-event-outbox\.json\n/);
      assert.match(stdout, /gateway\/state-event-outbox\.json\.manifest\.json\n/);
      await mkdir(restoreDir, { recursive: true });
      await execFileAsync("tar", ["-C", restoreDir, "-xzf", archive, "gateway", "mesh"]);
      await readFile(path.join(restoreDir, "gateway/state-event-outbox.json"), "utf8");
      await readFile(path.join(restoreDir, "gateway/state-event-outbox.json.manifest.json"), "utf8");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
