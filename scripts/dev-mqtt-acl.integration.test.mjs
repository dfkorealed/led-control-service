import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { publishNativeBrokerIdentity, reloadExistingDevelopmentBroker } from "./dev-broker.mjs";
import { publishMosquittoAcl } from "./dev-runtime.mjs";

const ALLOWED_ID = "11111111-1111-4111-8111-111111111111";
const REMOVED_ID = "22222222-2222-4222-8222-222222222222";
const { connect } = createRequire(new URL("../apps/api/package.json", import.meta.url))("mqtt");
const { require: requireTs } = createRequire(new URL("../apps/api/package.json", import.meta.url))("tsx/cjs/api");
const { BrokerGenerationFence } = requireTs("../apps/api/src/mqtt/broker-generation-fence.ts", import.meta.url);

// A deliberately disposable admission model: the ledger is outside the state
// restored by restart/ACL/CRL rollback. It is NOT a Mosquitto production plugin.
test("immutable admission double rejects retired credentials after every rollback; node gaps cannot certify", async () => {
  const fingerprint = "a".repeat(64);
  const census = { generation: 7, source: "deployment-inventory", complete: true, revision: "lab-1",
    nodes: ["node-a", "node-b"].map(nodeId => ({ nodeId, bootId: "boot-1", retiredCertificateFingerprints: [fingerprint] })) };
  const ledger = { minimumGeneration: 8, revoked: new Set([fingerprint]) };
  const accepted = (generation, certificate, restored) => generation >= ledger.minimumGeneration
    && !ledger.revoked.has(certificate) && restored.acl.has(generation) && !restored.crl.has(certificate);
  let omitNode = false;
  const fence = new BrokerGenerationFence({ census: async () => census, adapter: { kind: "disposable",
    collect: async challenge => {
      const current = { acl: new Set([8]), crl: new Set([fingerprint]) };
      const old = { acl: new Set([7, 8]), crl: new Set() };
      const denial = state => !accepted(7, fingerprint, state);
      assert.equal(accepted(8, "b".repeat(64), old), true, "probe must preserve active-generation admission");
      const nodes = census.nodes.map(node => ({ ...challenge, nodeId: node.nodeId, bootId: node.bootId,
        revokedCertificateFingerprints: [...ledger.revoked], irreversibleRevocation: true,
        sessionInventoryComplete: true, activeConnections: 0, persistentSessions: 0, queuedMessages: 0,
        freshPublishDenied: denial(current), admissionMinimumGeneration: ledger.minimumGeneration,
        rollback: { restartDenied: denial(current), oldAclDenied: denial({ ...current, acl: old.acl }),
          oldCrlDenied: denial({ ...current, crl: old.crl }), oldAclAndCrlDenied: denial(old),
          minimumGenerationAfterRollback: ledger.minimumGeneration, revocationLedgerPreserved: ledger.revoked.has(fingerprint) }
      }));
      return omitNode ? nodes.slice(0, 1) : nodes;
    }
  } });
  const proof = await fence.verifyRetired(7);
  assert.equal(proof.status, "verified");
  assert.equal(proof.productionPurgeAllowed, false);
  omitNode = true;
  assert.equal((await fence.verifyRetired(7)).status, "unavailable");
});

test("stock broker restart with restored ACL/CRL revives retired publish and preserves queued Set; no fence proof", {
  skip: process.env.DEV_MQTT_ACL_INTEGRATION === "1" ? false : "set DEV_MQTT_ACL_INTEGRATION=1 for disposable mTLS broker",
  timeout: 30000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "led-broker-rollback-"));
  const pki = join(root, "pki"), acl = join(root, "acl"), config = join(root, "mosquitto.conf");
  const port = await freePort(), clients = [];
  const topic = `sites/site/gateways/${ALLOWED_ID}/commands/dimming`;
  let broker;
  mkdirSync(pki); chmodSync(root, 0o755);
  const stop = async () => {
    if (broker?.exitCode === null) { const ended = new Promise(resolve => broker.once("exit", resolve)); broker.kill("SIGTERM"); await ended; }
  };
  const start = async () => {
    broker = spawn(commandPath("mosquitto"), ["-c", config], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForPort(port);
  };
  const client = (name, options = {}) => {
    const value = connect(`mqtts://127.0.0.1:${port}`, { ca: readFileSync(join(pki, "ca.crt")),
      cert: readFileSync(join(pki, `${name}.crt`)), key: readFileSync(join(pki, `${name}.key`)),
      protocolVersion: 5, clean: true, reconnectPeriod: 0, connectTimeout: 1000, ...options });
    value.on("error", () => {}); clients.push(value); return value;
  };
  const connected = value => new Promise((resolve, reject) => { value.once("connect", resolve); value.once("error", reject); });
  const close = value => new Promise(resolve => value.end(true, {}, resolve));
  const send = (value, body) => new Promise((resolve, reject) => value.publish(topic, body,
    { qos: 1, retain: false, properties: { messageExpiryInterval: 60 } }, error => error ? reject(error) : resolve()));
  try {
    createCertificates(pki); issue(pki, "set7", "command-set-7");
    writeFileSync(join(pki, "index"), ""); writeFileSync(join(pki, "crlnumber"), "1000\n");
    writeFileSync(join(pki, "ca.cnf"), ["[ca]", "default_ca=lab", "[lab]", "database=index", "certificate=ca.crt",
      "private_key=ca.key", "crlnumber=crlnumber", "default_md=sha256", "default_crl_days=1", ""].join("\n"));
    run("openssl", ["ca", "-config", "ca.cnf", "-gencrl", "-out", "crl.pem"], pki);
    const oldCrl = readFileSync(join(pki, "crl.pem"));
    publishMosquittoAcl(acl, [ALLOWED_ID], { setGeneration: 7 });
    const oldAcl = readFileSync(acl);
    writeFileSync(config, [`listener ${port} 127.0.0.1`, "allow_anonymous false", `cafile ${join(pki, "ca.crt")}`,
      `certfile ${join(pki, "broker.crt")}`, `keyfile ${join(pki, "broker.key")}`, `crlfile ${join(pki, "crl.pem")}`,
      "require_certificate true", "use_identity_as_username true", `acl_file ${acl}`, "persistence true",
      `persistence_location ${root}/`, "persistence_file sessions.db", ""].join("\n"));
    await start();
    const session = { clientId: "offline-gateway", clean: false, properties: { sessionExpiryInterval: 60 } };
    const gateway = client("allowed", session); await connected(gateway); await gateway.subscribeAsync(topic, { qos: 1 }); await close(gateway);
    const oldPublisher = client("set7"); await connected(oldPublisher); await send(oldPublisher, "queued-before-retirement");
    await close(oldPublisher); // A successful end callback does not erase the subscriber queue.
    await stop();
    publishMosquittoAcl(acl, [ALLOWED_ID], { setGeneration: 8 });
    await start();
    const retired = client("set7"); await connected(retired); await assert.rejects(send(retired, "denied-now"), /not authorized/i);
    await close(retired);
    const resumed = client("allowed", session);
    const queued = new Promise(resolve => resumed.once("message", (_topic, payload) => resolve(payload.toString())));
    assert.equal((await connected(resumed)).sessionPresent, true);
    assert.equal(await queued, "queued-before-retirement", "publisher ACL revocation does not discard offline delivery queue");
    await close(resumed); await stop();
    run("openssl", ["ca", "-config", "ca.cnf", "-revoke", "set7.crt"], pki);
    run("openssl", ["ca", "-config", "ca.cnf", "-gencrl", "-out", "crl.pem"], pki);
    await start();
    const revoked = client("set7"); await assert.rejects(connected(revoked)); await close(revoked); await stop();
    // Restore exactly the earlier ACL+CRL bytes, keeping the broker's session DB.
    writeFileSync(acl, oldAcl); writeFileSync(join(pki, "crl.pem"), oldCrl); await start();
    const resurrected = client("set7"); await connected(resurrected); await send(resurrected, "accepted-after-rollback");
    const stock = await new BrokerGenerationFence().verifyRetired(7);
    assert.equal(stock.status, "unavailable"); assert.equal(stock.productionPurgeAllowed, false);
    const census = { generation: 7, source: "deployment-inventory", complete: true, revision: "rollback-lab",
      nodes: [{ nodeId: "real-node", bootId: String(broker.pid), retiredCertificateFingerprints: ["a".repeat(64)] }] };
    const observed = new BrokerGenerationFence({ census: async () => census,
      adapter: { kind: "disposable", collect: async challenge => [{ ...challenge, nodeId: "real-node", bootId: String(broker.pid),
        revokedCertificateFingerprints: [], irreversibleRevocation: false, sessionInventoryComplete: false,
        activeConnections: 1, persistentSessions: 1, queuedMessages: 0, freshPublishDenied: false,
        admissionMinimumGeneration: 7, rollback: { restartDenied: false, oldAclDenied: false, oldCrlDenied: false,
          oldAclAndCrlDenied: false, minimumGenerationAfterRollback: 7, revocationLedgerPreserved: false }
      }] } });
    const failed = await observed.verifyRetired(7);
    assert.equal(failed.status, "unavailable"); assert.equal(failed.productionPurgeAllowed, false);
    assert.equal(failed.reason, "node_evidence_invalid");
  } finally {
    await Promise.all(clients.map(close)); await stop(); rmSync(root, { recursive: true, force: true });
  }
});

// Independent inventory from API publish producers and MqttService subscriptions.
const API_WRITE = ["commands/status-check", "commands/identify", "commands/fixture-presence-check",
  "commands/provisioning/scan-start", "commands/provisioning/scan-stop", "commands/provisioning/identify-device",
  "commands/provisioning/provision-device", "commands/mesh-group/subscription-sync", "commands/mesh-group/resync-ack",
  "commands/automation/config-sync", "events/clock/response", "commands/drain/request", "acks/state-ingested",
  "acks/fixture-presence-check-completed", "acks/provisioning/scan-terminal-ingested", "acks/provisioning/device-terminal-ingested",
  "acks/automation/config-applied-ingested", "acks/automation/execution-ingested", "acks/automation/vehicle-sensor-capability-ingested"];
const API_READ = ["acks/acceptance", "acks/device-status", "state/fixtures", "state/fixture-presence", "state/heartbeat",
  "events/provisioning/scan-found", "events/provisioning/scan-completed", "events/provisioning/scan-failed",
  "events/provisioning/device-terminal", "events/provisioning-completed", "events/provisioning-failed",
  "events/identify-result", "events/fixture-presence-check-completed", "events/fixture-unreachable",
  "events/mesh-group/resync-request", "events/mesh-group/subscription-result", "events/mesh-node-metrics",
  "events/provisioning-progress", "events/automation/config-applied", "events/automation/current-config-request",
  "events/automation/execution", "events/automation/vehicle-sensor-capability", "commands/clock/request", "events/drain/response"];

test("Set cutover denies legacy/retired identities including deferred QoS1 after timeout; non-Set remains live", {
  skip: process.env.DEV_MQTT_ACL_INTEGRATION === "1" ? false : "set DEV_MQTT_ACL_INTEGRATION=1 for disposable mTLS broker"
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "led-set-acl-"));
  const pki = join(root, "pki"), runtime = join(root, "runtime"), acl = join(runtime, "acl");
  const config = join(root, "mosquitto.conf"), port = await freePort();
  const clients = []; let broker;
  mkdirSync(pki); mkdirSync(runtime); chmodSync(runtime, 0o755);
  const scoped = (suffix) => `sites/site/gateways/${ALLOWED_ID}/${suffix}`;
  function client(name, manualConnect = false) {
    const result = connect(`mqtts://127.0.0.1:${port}`, { ca: readFileSync(join(pki, "ca.crt")),
      cert: readFileSync(join(pki, `${name}.crt`)), key: readFileSync(join(pki, `${name}.key`)),
      protocolVersion: 5, clean: true, reconnectPeriod: 0, manualConnect, properties: { sessionExpiryInterval: 0 } });
    result.on("error", () => {}); clients.push(result); return result;
  }
  const connected = (value) => value.connected ? Promise.resolve() : new Promise((resolve, reject) => {
    value.once("connect", resolve); value.once("error", reject);
  });
  const send = (value, topic) => new Promise((resolve, reject) => value.publish(topic, "{}", {
    qos: 1, retain: false, properties: { messageExpiryInterval: 8 }
  }, (error) => error ? reject(error) : resolve()));
  try {
    createCertificates(pki); issue(pki, "set7", "command-set-7"); issue(pki, "set8", "command-set-8");
    writeFileSync(acl, readFileSync(new URL("../infra/mosquitto.acl.example", import.meta.url)));
    writeFileSync(config, [`listener ${port} 127.0.0.1`, "allow_anonymous false", `cafile ${join(pki, "ca.crt")}`,
      `certfile ${join(pki, "broker.crt")}`, `keyfile ${join(pki, "broker.key")}`, "require_certificate true",
      "use_identity_as_username true", `acl_file ${acl}`, "persistence false", ""].join("\n"));
    broker = spawn(commandPath("mosquitto"), ["-c", config], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForPort(port);
    const api = client("api"); await connected(api);
    await send(api, "sites/health/production-probe");
    const gateway = client("allowed"); await connected(gateway);
    await send(gateway, scoped("state/heartbeat")); // Production OFF onboarding patterns.
    await send(api, scoped("commands/dimming")); // OFF compatibility remains usable.
    await send(api, scoped("commands/status-check"));
    publishMosquittoAcl(acl, [ALLOWED_ID], { setGeneration: 7 }); broker.kill("SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(send(api, scoped("commands/dimming")), /not authorized/i);
    const active = client("set7"); await connected(active);
    await send(active, scoped("commands/dimming"));
    await send(api, "sites/health/production-probe");
    await assert.rejects(send(active, "sites/health/production-probe"), /not authorized/i);
    await assert.rejects(send(active, scoped("commands/status-check")), /not authorized/i);
    await assert.rejects(send(api, scoped("commands/unknown")), /not authorized/i);
    for (const suffix of API_WRITE) await send(api, scoped(suffix));
    const unlisted = client("removed"); await connected(unlisted);
    await assert.rejects(send(unlisted, `sites/site/gateways/${REMOVED_ID}/state/heartbeat`), /not authorized/i);
    const received = new Set(); api.on("message", (topic) => received.add(topic));
    await api.subscribeAsync(API_READ.map(scoped), { qos: 1 });
    for (const suffix of API_READ) await send(gateway, scoped(suffix));
    const deadline = Date.now() + 3000;
    while (received.size < API_READ.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([...received].sort(), API_READ.map(scoped).sort());
    const deferred = client("set7", true);
    const packet = send(deferred, scoped("commands/dimming"));
    // The application timeout has already elapsed. The actual QoS1 packet stays
    // in MQTT.js and is first submitted only AFTER broker-side retirement.
    await assert.rejects(Promise.race([packet, new Promise((_, reject) => setTimeout(() => reject(new Error("local timeout")), 20))]), /local timeout/);
    publishMosquittoAcl(acl, [ALLOWED_ID], { setGeneration: 8 }); broker.kill("SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const denied = assert.rejects(packet, /not authorized/i); deferred.connect(); await denied;
    await assert.rejects(send(active, scoped("commands/dimming")), /not authorized/i);
    const next = client("set8"); await connected(next); await send(next, scoped("commands/dimming"));
    await send(api, scoped("commands/status-check"));
  } finally {
    await Promise.all(clients.map((value) => new Promise((resolve) => value.end(true, {}, resolve))));
    if (broker?.exitCode === null) { const stopped = new Promise((resolve) => broker.once("exit", resolve)); broker.kill("SIGTERM"); await stopped; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("native broker reload는 제거·빈 allowlist를 즉시 거부하고 API identity는 유지한다", {
  skip: process.env.DEV_MQTT_ACL_INTEGRATION === "1" ? false : "set DEV_MQTT_ACL_INTEGRATION=1 for the host Mosquitto fixture"
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "led-control-acl-integration-"));
  const local = join(root, ".local");
  const pki = join(root, "pki");
  const runtime = join(local, "mosquitto-runtime");
  const aclPath = join(runtime, "mosquitto.acl");
  const configPath = join(local, "mosquitto.host.conf");
  const identityPath = join(local, "mosquitto.host.pid.json");
  const brokerBinary = commandPath("mosquitto");
  const publisherBinary = commandPath("mosquitto_pub");
  const port = await freePort();
  let broker;
  mkdirSync(local, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  chmodSync(runtime, 0o755);
  mkdirSync(pki, { recursive: true });
  try {
    createCertificates(pki);
    publishMosquittoAcl(aclPath, [ALLOWED_ID, REMOVED_ID]);
    writeFileSync(configPath, [
      `listener ${port} 127.0.0.1`,
      "allow_anonymous false",
      `cafile ${join(pki, "ca.crt")}`,
      `certfile ${join(pki, "broker.crt")}`,
      `keyfile ${join(pki, "broker.key")}`,
      "require_certificate true",
      "use_identity_as_username true",
      `acl_file ${aclPath}`,
      "persistence false",
      ""
    ].join("\n"), { mode: 0o600 });
    broker = spawn(brokerBinary, ["-c", configPath], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    publishNativeBrokerIdentity(identityPath, { pid: broker.pid, root, binary: brokerBinary, config: configPath });
    await waitForPort(port);

    assert.equal(publish(publisherBinary, pki, port, ALLOWED_ID, `sites/site/gateways/${ALLOWED_ID}/state/light`).status, 0);
    assert.equal(publish(publisherBinary, pki, port, REMOVED_ID, `sites/site/gateways/${REMOVED_ID}/state/light`).status, 0);

    publishMosquittoAcl(aclPath, [ALLOWED_ID]);
    reloadExistingDevelopmentBroker({ root, aclPath, nativeIdentityPath: identityPath, port });
    assert.equal(publish(publisherBinary, pki, port, ALLOWED_ID, `sites/site/gateways/${ALLOWED_ID}/state/light`).status, 0);
    assertDenied(publish(publisherBinary, pki, port, REMOVED_ID, `sites/site/gateways/${REMOVED_ID}/state/light`));

    publishMosquittoAcl(aclPath, []);
    reloadExistingDevelopmentBroker({ root, aclPath, nativeIdentityPath: identityPath, port });
    assertDenied(publish(publisherBinary, pki, port, ALLOWED_ID, `sites/site/gateways/${ALLOWED_ID}/state/light`));
    assert.equal(publish(publisherBinary, pki, port, "api-service", `sites/site/gateways/${ALLOWED_ID}/commands/status-check`).status, 0);
  } finally {
    if (broker?.exitCode === null) {
      const exited = new Promise((resolve) => broker.once("exit", resolve));
      broker.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker directory bind는 호출 UID가 비밀키와 새 ACL inode를 읽고 제거·빈 allowlist를 reload한다", {
  skip: process.env.DEV_MQTT_ACL_INTEGRATION === "1" ? false : "set DEV_MQTT_ACL_INTEGRATION=1 for the Docker Mosquitto fixture"
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "led-control-acl-docker-"));
  const runtime = join(root, "runtime");
  const config = join(root, "config");
  const pki = join(root, "pki");
  const aclPath = join(runtime, "mosquitto.acl");
  const port = await freePort();
  const container = `led-control-acl-${process.pid}-${port}`;
  const publisherBinary = commandPath("mosquitto_pub");
  const invokingUid = process.getuid();
  const invokingGid = process.getgid();
  mkdirSync(runtime, { recursive: true });
  chmodSync(runtime, 0o755);
  mkdirSync(config, { recursive: true });
  mkdirSync(pki, { recursive: true });
  try {
    createCertificates(pki);
    publishMosquittoAcl(aclPath, [ALLOWED_ID, REMOVED_ID]);
    writeFileSync(join(config, "mosquitto.conf"), [
      "listener 8883 0.0.0.0",
      "allow_anonymous false",
      "cafile /mosquitto/certs/ca.crt",
      "certfile /mosquitto/certs/broker.crt",
      "keyfile /mosquitto/certs/broker.key",
      "require_certificate true",
      "use_identity_as_username true",
      "acl_file /mosquitto/runtime/mosquitto.acl",
      "persistence false",
      ""
    ].join("\n"), { mode: 0o644 });
    assert.equal(statSync(join(pki, "broker.key")).mode & 0o777, 0o600);
    execFileSync("docker", [
      "run", "-d", "--name", container, "--user", `${invokingUid}:${invokingGid}`,
      "-p", `127.0.0.1:${port}:8883`,
      "-v", `${config}:/mosquitto/config:ro`, "-v", `${runtime}:/mosquitto/runtime:ro`,
      "-v", `${pki}:/mosquitto/certs:ro`, "eclipse-mosquitto:2"
    ], { stdio: "ignore" });
    await waitForPort(port);

    assert.equal(containerProcessUid(container), String(invokingUid));
    execFileSync("docker", ["exec", container, "test", "-r", "/mosquitto/certs/broker.key"]);
    assert.equal(execFileSync("docker", ["exec", container, "stat", "-c", "%a", "/mosquitto/certs/broker.key"], { encoding: "utf8" }).trim(), "600");
    assert.equal(execFileSync("docker", ["exec", container, "cat", "/mosquitto/runtime/mosquitto.acl"], { encoding: "utf8" }), readFileSync(aclPath, "utf8"));
    const oldInode = containerInode(container);
    publishMosquittoAcl(aclPath, [ALLOWED_ID]);
    const newInode = containerInode(container);
    assert.notEqual(newInode, oldInode);
    execFileSync("docker", ["kill", "--signal=SIGHUP", container], { stdio: "ignore" });
    assert.equal(publish(publisherBinary, pki, port, ALLOWED_ID, `sites/site/gateways/${ALLOWED_ID}/state/light`).status, 0);
    assertDenied(publish(publisherBinary, pki, port, REMOVED_ID, `sites/site/gateways/${REMOVED_ID}/state/light`));

    publishMosquittoAcl(aclPath, []);
    execFileSync("docker", ["kill", "--signal=SIGHUP", container], { stdio: "ignore" });
    assertDenied(publish(publisherBinary, pki, port, ALLOWED_ID, `sites/site/gateways/${ALLOWED_ID}/state/light`));
    assert.equal(publish(publisherBinary, pki, port, "api-service", `sites/site/gateways/${ALLOWED_ID}/commands/status-check`).status, 0);
  } finally {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
});

function createCertificates(directory) {
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=dev-acl-test-ca", "-keyout", "ca.key", "-out", "ca.crt"], directory);
  issue(directory, "broker", "broker", ["-extfile", "server.ext"]);
  issue(directory, "allowed", ALLOWED_ID);
  issue(directory, "removed", REMOVED_ID);
  issue(directory, "api", "api-service");
}

function issue(directory, name, commonName, extra = []) {
  if (name === "broker") writeFileSync(join(directory, "server.ext"), "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${commonName}`, "-keyout", `${name}.key`, "-out", `${name}.csr`], directory);
  run("openssl", ["x509", "-req", "-days", "1", "-sha256", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, ...extra], directory);
}

function publish(binary, pki, port, identity, topic) {
  const name = identity === ALLOWED_ID ? "allowed" : identity === REMOVED_ID ? "removed" : "api";
  return spawnSync(binary, ["-h", "127.0.0.1", "-p", String(port), "--cafile", join(pki, "ca.crt"), "--cert", join(pki, `${name}.crt`), "--key", join(pki, `${name}.key`), "-V", "mqttv5", "-q", "1", "-t", topic, "-m", "{}"], { encoding: "utf8" });
}

function assertDenied(result) {
  assert.match(`${result.stdout}${result.stderr}`, /not authorized|135/i);
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "ignore" });
}

function commandPath(command) {
  return execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim();
}

function containerInode(container) {
  return execFileSync("docker", ["exec", container, "stat", "-c", "%i", "/mosquitto/runtime/mosquitto.acl"], { encoding: "utf8" }).trim();
}

function containerProcessUid(container) {
  return execFileSync(
    "docker",
    ["exec", container, "sh", "-c", "awk '/^Uid:/ { print $2; exit }' /proc/1/status"],
    { encoding: "utf8" }
  ).trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("isolated Mosquitto did not start");
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
