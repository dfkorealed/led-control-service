import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { connect, type MqttClient } from "mqtt";

/** Local ACL fault fixture only. mTLS identities/antirollback are tested separately. */
export async function disposableSetBroker(generation: number) {
  const root = mkdtempSync("/tmp/command-permit-broker-");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing port"));
      server.close(() => resolve(address.port));
    });
  });
  const acl = join(root, "acl"), config = join(root, "mosquitto.conf");
  const clients: MqttClient[] = [];
  const render = (active: boolean) => ["user observer", "topic read sites/#", "user api-service",
    "topic write sites/+/gateways/+/commands/status-check", `user command-set-${generation}`,
    ...(active ? ["topic write sites/+/gateways/+/commands/dimming"] : []), ""].join("\n");
  writeFileSync(acl, render(true));
  writeFileSync(config, `listener ${port} 127.0.0.1\nallow_anonymous true\nacl_file ${acl}\npersistence false\n`);
  const broker = spawn("mosquitto", ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  broker.stderr.on("data", data => { log += String(data); });
  const ready = async (match: string, start = 0) => {
    for (let i = 0; i < 100; i++) {
      if (log.slice(start).includes(match)) return;
      if (broker.exitCode !== null) throw new Error(`disposable broker exited: ${log}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`disposable broker not ready: ${log}`);
  };
  await ready("running");
  const client = (username: string, deferred = false) => {
    const value = connect(`mqtt://127.0.0.1:${port}`, { username, manualConnect: deferred, protocolVersion: 5,
      reconnectPeriod: 0, clean: true, properties: { sessionExpiryInterval: 0 } });
    value.on("error", () => {});
    clients.push(value);
    return value;
  };
  const connected = (value: MqttClient) => value.connected ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    value.once("connect", () => resolve()); value.once("error", reject);
  });
  return {
    client, connected,
    async retire() {
      const start = log.length;
      writeFileSync(acl, render(false));
      broker.kill("SIGHUP");
      await ready("Reloading config", start);
    },
    async stop() {
      await Promise.all(clients.map(value => new Promise<void>(resolve => value.end(true, {}, () => resolve()))));
      if (broker.exitCode === null) {
        const stopped = new Promise<void>(resolve => broker.once("exit", () => resolve()));
        broker.kill("SIGTERM"); await stopped;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}
