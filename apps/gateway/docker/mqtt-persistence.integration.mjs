import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import test from "node:test";

const execFile = promisify(execFileCallback);
const dockerImage = "eclipse-mosquitto:2";
const dockerRequired = process.env.MQTT_INTEGRATION_REQUIRED === "1";

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
  try {
    await execFile("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

async function startBroker({ containerName, configDirectory, dataDirectory, port }) {
  await execFile("docker", [
    "run", "--detach", "--name", containerName, "--user", "1883:1883",
    "-p", `${port}:1883`,
    "-v", `${configDirectory}:/mosquitto/config:ro`,
    "-v", `${dataDirectory}:/mosquitto/data`,
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
    client.subscribe(topic, { qos: 1 }, (error) => (error ? reject(error) : resolve()));
  });
}

function publish(client, topic, payload) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 1, properties: { messageExpiryInterval: 10 } }, (error) => (error ? reject(error) : resolve()));
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
