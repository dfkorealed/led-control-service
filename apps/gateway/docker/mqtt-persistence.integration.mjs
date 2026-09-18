import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import test from "node:test";
import { renderMosquittoAcl } from "../../../scripts/dev-runtime.mjs";

const execFile = promisify(execFileCallback);
const dockerImage = "eclipse-mosquitto:2";
const dockerRequired = process.env.MQTT_INTEGRATION_REQUIRED === "1";
let dockerAvailability;

test("Mosquitto restores an offline gateway QoS 1 command after broker restart", async (t) => {
  if (!(await dockerAvailable())) {
    if (dockerRequired) assert.fail("Docker daemon is required when MQTT_INTEGRATION_REQUIRED=1");
    t.skip("Docker daemon unavailable; set MQTT_INTEGRATION_REQUIRED=1 to make this a required validation.");
    return;
  }

  const directory = await mkdtemp(join(process.cwd(), ".mqtt-persistence-"));
  const dataDirectory = join(directory, "data");
  const configDirectory = join(directory, "config");
  const port = await unusedPort();
  const gatewayClientId = `gateway-persistence-${randomUUID()}`;
  let containerName = `led-mqtt-persistence-${randomUUID()}`;
  let gateway;
  let publisher;
  let resumedGateway;
  const ownedResources = { containers: [], volumes: [] };

  try {
    await chmod(directory, 0o755);
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "mosquitto.conf"), brokerConfig(), { mode: 0o644 });
    await mkdir(dataDirectory);
    await chmod(dataDirectory, 0o777);
    await startBroker({ containerName, configDirectory, dataDirectory, port, ownedResources });

    const url = `mqtt://127.0.0.1:${port}`;
    const topic = "sites/test/gateways/test/commands/dimming";
    ({ client: gateway } = await connectEventually(url, persistentGatewayOptions(gatewayClientId)));
    await subscribe(gateway, topic);
    await end(gateway);
    gateway = undefined;

    ({ client: publisher } = await connectEventually(url, { protocolVersion: 5, clean: true, reconnectPeriod: 0 }));
    await publish(publisher, topic, JSON.stringify({ command: "queued-before-restart" }));
    await end(publisher);
    publisher = undefined;
    await waitForFile(join(dataDirectory, "mosquitto.db"));

    await execFile("docker", ["stop", containerName]);
    // Remove image-declared anonymous log storage as well as this exact broker;
    // the bind-mounted persistence fixture must survive the restart.
    await execFile("docker", ["rm", "-v", containerName]);
    containerName = `led-mqtt-persistence-${randomUUID()}`;
    await startBroker({ containerName, configDirectory, dataDirectory, port, ownedResources });

    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("queued MQTT command was not delivered")), 10_000);
      resumedGateway = mqtt.connect(url, persistentGatewayOptions(gatewayClientId));
      resumedGateway.once("message", (receivedTopic, payload) => {
        clearTimeout(timeout);
        resolve({ topic: receivedTopic, payload: payload.toString() });
      });
    });
    const connack = await waitForConnect(resumedGateway);

    assert.equal(connack.sessionPresent, true);
    await assert.doesNotReject(received.then((message) => {
      assert.deepEqual(message, { topic, payload: JSON.stringify({ command: "queued-before-restart" }) });
    }));
  } finally {
    await end(resumedGateway);
    await end(gateway);
    await end(publisher);
    await execFile("docker", ["rm", "-fv", containerName]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await assertBrokerResourcesRemoved(ownedResources);
  }
});

for (const aclSource of ["production", "development"]) {
  test(`Mosquitto enforces directional monitoring/automation ACLs for a Gateway certificate (${aclSource})`,
    (t) => verifyGatewayAcl(t, aclSource));
}

async function verifyGatewayAcl(t, aclSource) {
  const useDocker = await dockerAvailable();
  if (!useDocker && !(await hostMosquittoAvailable())) {
    if (dockerRequired) assert.fail("Docker daemon is required when MQTT_INTEGRATION_REQUIRED=1");
    t.skip("Docker daemon and host Mosquitto are unavailable.");
    return;
  }

  const directory = await mkdtemp(join(process.cwd(), ".mqtt-acl-"));
  const dataDirectory = join(directory, "data");
  const configDirectory = join(directory, "config");
  const certificatesDirectory = join(directory, "certs");
  const gatewayId = "00000000-0000-4000-8000-000000000004";
  const port = await unusedPort();
  const containerName = `led-mqtt-acl-${randomUUID()}`;
  let gateway;
  let api;
  let hostBroker;
  const ownedResources = { containers: [], volumes: [] };

  try {
    await chmod(directory, 0o755);
    await mkdir(configDirectory);
    await mkdir(certificatesDirectory);
    await mkdir(dataDirectory);
    await chmod(dataDirectory, 0o777);
    await createTestCertificates(certificatesDirectory, gatewayId);
    const aclPath = join(configDirectory, "mosquitto.acl");
    await writeFile(
      aclPath,
      aclSource === "production"
        ? await readFile(new URL("../../../infra/mosquitto.acl.example", import.meta.url))
        : renderMosquittoAcl([gatewayId]),
      { mode: 0o644 }
    );
    const configPath = join(configDirectory, "mosquitto.conf");
    await writeFile(configPath, useDocker
      ? tlsBrokerConfig()
      : tlsBrokerConfig({ listener: port, certificatesDirectory, aclPath }), { mode: 0o644 });
    if (useDocker) {
      await startBroker({ containerName, configDirectory, certificatesDirectory, dataDirectory, port, containerPort: 8883, ownedResources });
    } else {
      hostBroker = startHostBroker(configPath);
    }

    ({ client: gateway } = await connectEventually(`mqtts://127.0.0.1:${port}`, {
      clientId: `gateway-acl-${randomUUID()}`,
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 0,
      ca: await readFile(join(certificatesDirectory, "ca.crt")),
      cert: await readFile(join(certificatesDirectory, "gateway.crt")),
      key: await readFile(join(certificatesDirectory, "gateway.key")),
      rejectUnauthorized: true
    }));
    ({ client: api } = await connectEventually(`mqtts://127.0.0.1:${port}`, {
      clientId: `api-acl-${randomUUID()}`,
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 0,
      ca: await readFile(join(certificatesDirectory, "ca.crt")),
      cert: await readFile(join(certificatesDirectory, "api.crt")),
      key: await readFile(join(certificatesDirectory, "api.key")),
      rejectUnauthorized: true
    }));

    const base = `sites/site-1/gateways/${gatewayId}/acks`;
    const automationAckTopic = `${base}/automation/execution-ingested`;
    const configAppliedReceiptTopic = `${base}/automation/config-applied-ingested`;
    const capabilityAckTopic = `${base}/automation/vehicle-sensor-capability-ingested`;
    const refreshAckTopic = `${base}/fixture-presence-check-completed`;
    await subscribe(gateway, refreshAckTopic);
    const receivedRefreshAck = waitForMessage(gateway, refreshAckTopic);
    await publish(api, refreshAckTopic, JSON.stringify({ status: "completed" }));
    assert.equal(await receivedRefreshAck, JSON.stringify({ status: "completed" }));
    await assert.rejects(publish(gateway, refreshAckTopic, "{}"), /not authorized/i);
    // Certificate CN scopes the Gateway ID; the pre-existing site wildcard is
    // unchanged. API topic/payload validation enforces the site relationship.
    for (const siteId of ["site-1", "site-2"]) {
      const otherRefreshAckTopic = `sites/${siteId}/gateways/00000000-0000-4000-8000-000000000099/acks/fixture-presence-check-completed`;
      await subscribe(gateway, otherRefreshAckTopic);
      const rejectedDelivery = assert.rejects(waitForMessage(gateway, otherRefreshAckTopic), /was not delivered/);
      await publish(api, otherRefreshAckTopic, "{}");
      await rejectedDelivery;
    }
    const currentConfigRequestTopic = `sites/site-1/gateways/${gatewayId}/events/automation/current-config-request`;
    const capabilityReportTopic = `sites/site-1/gateways/${gatewayId}/events/automation/vehicle-sensor-capability`;
    await assert.doesNotReject(publish(gateway, `${base}/acceptance`, "{}"));
    await assert.doesNotReject(publish(gateway, `${base}/device-status`, "{}"));
    await assert.doesNotReject(subscribe(gateway, automationAckTopic));
    const receivedAutomationAck = waitForMessage(gateway, automationAckTopic);
    await publish(api, automationAckTopic, JSON.stringify({ status: "ingested" }));
    await assert.doesNotReject(receivedAutomationAck);
    await assert.doesNotReject(subscribe(gateway, configAppliedReceiptTopic));
    const receivedConfigAppliedReceipt = waitForMessage(gateway, configAppliedReceiptTopic);
    await publish(api, configAppliedReceiptTopic, JSON.stringify({ status: "ingested" }));
    await assert.doesNotReject(receivedConfigAppliedReceipt);
    await assert.doesNotReject(subscribe(api, currentConfigRequestTopic));
    const receivedCurrentConfigRequest = waitForMessage(api, currentConfigRequestTopic);
    await assert.doesNotReject(publish(gateway, currentConfigRequestTopic, "{}"));
    await assert.doesNotReject(receivedCurrentConfigRequest);
    await assert.doesNotReject(publish(gateway, capabilityReportTopic, "{}"));
    await assert.doesNotReject(subscribe(gateway, capabilityAckTopic));
    const receivedCapabilityAck = waitForMessage(gateway, capabilityAckTopic);
    await publish(api, capabilityAckTopic, JSON.stringify({ status: "applied" }));
    await assert.doesNotReject(receivedCapabilityAck);
    await assert.rejects(publish(gateway, `${base}/state-ingested`, "{}"), /not authorized/i);
    await assert.rejects(
      publish(gateway, automationAckTopic, "{}"),
      /not authorized/i
    );
    await assert.rejects(publish(gateway, configAppliedReceiptTopic, "{}"), /not authorized/i);
    const otherGatewayReceiptTopic =
      "sites/site-1/gateways/00000000-0000-4000-8000-000000000099/acks/automation/config-applied-ingested";
    await subscribe(gateway, otherGatewayReceiptTopic);
    const rejectedCrossGatewayDelivery = waitForMessage(gateway, otherGatewayReceiptTopic);
    await publish(api, otherGatewayReceiptTopic, "{}");
    await assert.rejects(rejectedCrossGatewayDelivery, /was not delivered/);
    await assert.rejects(publish(gateway, capabilityAckTopic, "{}"), /not authorized/i);
    await assert.rejects(
      publish(gateway, `${base}/provisioning/scan-terminal-ingested`, "{}"),
      /not authorized/i
    );
  } finally {
    await end(gateway);
    await end(api);
    if (useDocker) await execFile("docker", ["rm", "-fv", containerName]).catch(() => undefined);
    await stopHostBroker(hostBroker);
    await rm(directory, { recursive: true, force: true });
    if (useDocker) await assertBrokerResourcesRemoved(ownedResources);
  }
}

function brokerConfig() {
  return [
    "listener 1883",
    "allow_anonymous true",
    "persistence true",
    "persistence_location /mosquitto/data/",
    "persistence_file mosquitto.db",
    "autosave_interval 1",
    "max_queued_messages 100",
    "max_queued_bytes 1048576",
    "log_dest stdout",
    ""
  ].join("\n");
}

function persistentGatewayOptions(clientId) {
  return {
    clientId,
    protocolVersion: 5,
    clean: false,
    reconnectPeriod: 0,
    properties: { sessionExpiryInterval: 60 }
  };
}

async function dockerAvailable() {
  dockerAvailability ??= execFile(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { timeout: 5_000 }
  ).then(() => true, () => false);
  return dockerAvailability;
}

async function hostMosquittoAvailable() {
  try {
    await execFile("mosquitto", ["-h"], { timeout: 5_000 });
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

async function startBroker({ containerName, configDirectory, certificatesDirectory, dataDirectory, port, containerPort = 1883, ownedResources }) {
  const mounts = [
    "-v", `${configDirectory}:/mosquitto/config:ro`,
    "-v", `${dataDirectory}:/mosquitto/data`
  ];
  if (certificatesDirectory) mounts.push("-v", `${certificatesDirectory}:/mosquitto/certs:ro`);
  ownedResources.containers.push(containerName);
  await execFile("docker", [
    "run", "--detach", "--name", containerName, "--user", "1883:1883",
    "-p", `${port}:${containerPort}`,
    ...mounts,
    dockerImage
  ]);
  // The image also declares /mosquitto/log as a volume. Capture daemon-assigned
  // identities before removing a broker so cleanup assertions cannot lose them.
  const { stdout: mountJson } = await execFile("docker", ["inspect", "--format", "{{json .Mounts}}", containerName]);
  ownedResources.volumes.push(...JSON.parse(mountJson).filter((mount) => mount.Type === "volume").map((mount) => mount.Name));
  await sleep(100);
  const { stdout } = await execFile("docker", ["inspect", "--format", "{{.State.Running}}", containerName]);
  if (stdout.trim() === "true") return;
  const { stdout: logs, stderr } = await execFile("docker", ["logs", containerName]).catch((error) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? ""
  }));
  throw new Error(`Mosquitto container exited during startup: ${logs}${stderr}`);
}

async function assertBrokerResourcesRemoved({ containers, volumes }) {
  for (const name of containers) {
    const { stdout } = await execFile("docker", ["ps", "-aq", "--filter", `name=^/${name}$`]);
    assert.equal(stdout.trim(), "", `owned broker remains: ${name}`);
  }
  const { stdout } = await execFile("docker", ["volume", "ls", "--format", "{{.Name}}"]);
  const remaining = new Set(stdout.trim().split("\n"));
  assert.deepEqual(volumes.filter((name) => remaining.has(name)), [], "owned broker anonymous volumes remain");
}

function tlsBrokerConfig({
  listener = 8883,
  certificatesDirectory = "/mosquitto/certs",
  aclPath = "/mosquitto/config/mosquitto.acl"
} = {}) {
  return [
    `listener ${listener}`,
    "allow_anonymous false",
    `cafile ${join(certificatesDirectory, "ca.crt")}`,
    `certfile ${join(certificatesDirectory, "server.crt")}`,
    `keyfile ${join(certificatesDirectory, "server.key")}`,
    "require_certificate true",
    "use_identity_as_username true",
    `acl_file ${aclPath}`,
    "log_dest stdout",
    ""
  ].join("\n");
}

function startHostBroker(configPath) {
  const child = spawn("mosquitto", ["-c", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.logs = () => output;
  return child;
}

async function stopHostBroker(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function createTestCertificates(directory, gatewayId) {
  await execFile("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=MQTT Test CA",
    "-addext", "basicConstraints=critical,CA:true",
    "-addext", "keyUsage=critical,keyCertSign"
  ], { cwd: directory });
  await createSignedCertificate(directory, "server", "mqtt-test", [
    "subjectAltName=IP:127.0.0.1",
    "extendedKeyUsage=serverAuth"
  ]);
  await createSignedCertificate(directory, "gateway", gatewayId, ["extendedKeyUsage=clientAuth"]);
  await createSignedCertificate(directory, "api", "api-service", ["extendedKeyUsage=clientAuth"]);
  await chmod(join(directory, "server.key"), 0o644);
}

async function createSignedCertificate(directory, name, commonName, extensions) {
  await execFile("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`,
    "-subj", `/CN=${commonName}`
  ], { cwd: directory });
  await writeFile(join(directory, `${name}.ext`), ["basicConstraints=critical,CA:false", ...extensions, ""].join("\n"));
  await execFile("openssl", [
    "x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", `${name}.crt`, "-days", "1", "-sha256", "-extfile", `${name}.ext`
  ], { cwd: directory });
}

async function connectEventually(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await connect(url, options);
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw lastError ?? new Error("MQTT broker did not accept a connection");
}

function connect(url, options) {
  const client = mqtt.connect(url, options);
  return waitForConnect(client).then((connack) => ({ client, connack }), async (error) => {
    await end(client);
    throw error;
  });
}

function waitForConnect(client) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MQTT connect timed out")), 5_000);
    client.once("connect", (connack) => {
      clearTimeout(timeout);
      resolve(connack);
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function subscribe(client, topic) {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, (error, granted) => {
      if (error) return reject(error);
      if (granted?.some((entry) => entry.qos === 128)) {
        return reject(new Error(`subscription not authorized: ${topic}`));
      }
      resolve();
    });
  });
}

function publish(client, topic, payload) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1, properties: { messageExpiryInterval: 10 } }, (error) => (error ? reject(error) : resolve()));
  });
}

function waitForMessage(client, topic) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.removeListener("message", onMessage);
      reject(new Error(`MQTT message was not delivered: ${topic}`));
    }, 2_000);
    const onMessage = (receivedTopic, payload) => {
      if (receivedTopic !== topic) return;
      clearTimeout(timeout);
      client.removeListener("message", onMessage);
      resolve(payload.toString());
    };
    client.on("message", onMessage);
  });
}

function end(client) {
  if (!client) return Promise.resolve();
  return new Promise((resolve) => client.end(false, {}, resolve));
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await stat(path)).size > 0) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("Mosquitto did not persist mosquitto.db");
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
