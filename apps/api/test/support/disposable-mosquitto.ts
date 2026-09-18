import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

/** Isolated loopback broker for explicit software integration; never touches a configured broker. */
export async function disposableMosquitto() {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing broker port"));
      server.close(() => resolve(address.port));
    });
  });
  // Without a config Mosquitto 2 binds loopback only. Tests supply their own MQTT clients;
  // production still requires mTLS and directional ACLs in createMqttConnectionOptions.
  const process = spawn("mosquitto", ["-p", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  const stopped = once(process, "close");
  const stop = async () => { if (process.exitCode === null) process.kill("SIGTERM"); await stopped; };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test broker startup timeout")), 5000);
      let log = "";
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      process.once("error", finish);
      process.once("exit", () => finish(new Error("test broker exited before startup")));
      process.stderr.on("data", (chunk: Buffer) => { log += chunk.toString(); if (/mosquitto version .* running/.test(log)) finish(); });
    });
    return { url: `mqtt://127.0.0.1:${port}`, stop };
  } catch (error) { await stop(); throw error; }
}
