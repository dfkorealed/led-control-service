import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import test from "node:test";

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

  try {
    await chmod(directory, 0o755);
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "mosquitto.conf"), brokerConfig(), { mode: 0o644 });
    await mkdir(dataDirectory);
    await chmod(dataDirectory, 0o777);
    await startBroker({ containerName, configDirectory, dataDirectory, port });

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
    await execFile("docker", ["rm", containerName]);
    containerName = `led-mqtt-persistence-${randomUUID()}`;
    await startBroker({ containerName, configDirectory, dataDirectory, port });

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
    await execFile("docker", ["rm", "-f", containerName]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mosquitto rejects application ACK publishes from a Gateway certificate", async (t) => {
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
      await readFile(new URL("../../../infra/mosquitto.acl.example", import.meta.url)),
      { mode: 0o644 }
    );
    const configPath = join(configDirectory, "mosquitto.conf");
    await writeFile(configPath, useDocker
      ? tlsBrokerConfig()
      : tlsBrokerConfig({ listener: port, certificatesDirectory, aclPath }), { mode: 0o644 });
    if (useDocker) {
      await startBroker({ containerName, configDirectory, certificatesDirectory, dataDirectory, port, containerPort: 8883 });
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
    await assert.doesNotReject(publish(gateway, `${base}/acceptance`, "{}"));
    await assert.doesNotReject(publish(gateway, `${base}/device-status`, "{}"));
    await assert.doesNotReject(subscribe(gateway, automationAckTopic));
    const receivedAutomationAck = waitForMessage(gateway, automationAckTopic);
    await publish(api, automationAckTopic, JSON.stringify({ status: "ingested" }));
    await assert.doesNotReject(receivedAutomationAck);
    await assert.rejects(publish(gateway, `${base}/state-ingested`, "{}"), /not authorized/i);
    await assert.rejects(
      publish(gateway, automationAckTopic, "{}"),
      /not authorized/i
    );
    await assert.rejects(
      publish(gateway, `${base}/provisioning/scan-terminal-ingested`, "{}"),
      /not authorized/i
    );
  } finally {
    await end(gateway);
    await end(api);
    if (useDocker) await execFile("docker", ["rm", "-f", containerName]).catch(() => undefined);
    await stopHostBroker(hostBroker);
    await rm(directory, { recursive: true, force: true });
  }
});

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

async function startBroker({ containerName, configDirectory, certificatesDirectory, dataDirectory, port, containerPort = 1883 }) {
  const mounts = [
    "-v", `${configDirectory}:/mosquitto/config:ro`,
    "-v", `${dataDirectory}:/mosquitto/data`
  ];
  if (certificatesDirectory) mounts.push("-v", `${certificatesDirectory}:/mosquitto/certs:ro`);
  await execFile("docker", [
    "run", "--detach", "--name", containerName, "--user", "1883:1883",
    "-p", `${port}:${containerPort}`,
    ...mounts,
    dockerImage
  ]);
  await sleep(100);
  const { stdout } = await execFile("docker", ["inspect", "--format", "{{.State.Running}}", containerName]);
  if (stdout.trim() === "true") return;
  const { stdout: logs, stderr } = await execFile("docker", ["logs", containerName]).catch((error) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr ?? ""
  }));
  throw new Error(`Mosquitto container exited during startup: ${logs}${stderr}`);
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
