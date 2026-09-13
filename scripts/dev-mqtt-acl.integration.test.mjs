import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishNativeBrokerIdentity, reloadExistingDevelopmentBroker } from "./dev-broker.mjs";
import { publishMosquittoAcl } from "./dev-runtime.mjs";

const ALLOWED_ID = "11111111-1111-4111-8111-111111111111";
const REMOVED_ID = "22222222-2222-4222-8222-222222222222";

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
    assert.equal(publish(publisherBinary, pki, port, "api-service", "sites/site/api-check").status, 0);
  } finally {
    if (broker?.exitCode === null) {
      const exited = new Promise((resolve) => broker.once("exit", resolve));
      broker.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker directory bind는 UID 1883이 새 ACL inode를 읽고 제거·빈 allowlist를 reload한다", {
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
  mkdirSync(runtime, { recursive: true });
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
    execFileSync("docker", [
      "run", "-d", "--name", container, "-p", `127.0.0.1:${port}:8883`,
      "-v", `${config}:/mosquitto/config:ro`, "-v", `${runtime}:/mosquitto/runtime:ro`,
      "-v", `${pki}:/mosquitto/certs:ro`, "eclipse-mosquitto:2"
    ], { stdio: "ignore" });
    await waitForPort(port);

    assert.equal(execFileSync("docker", ["exec", "-u", "1883:1883", container, "cat", "/mosquitto/runtime/mosquitto.acl"], { encoding: "utf8" }), readFileSync(aclPath, "utf8"));
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
    assert.equal(publish(publisherBinary, pki, port, "api-service", "sites/site/api-check").status, 0);
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
