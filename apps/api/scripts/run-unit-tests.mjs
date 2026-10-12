import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = "isolated-linux-ci";

export function createJestInvocation({ args, env, platform, nodeExecutable, apiRoot: directory }) {
  const jest = path.join(directory, "node_modules/jest/bin/jest.js");
  if (env.LED_API_UNIT_PROFILE === undefined) {
    return { executable: nodeExecutable, args: [jest, ...args], detached: false };
  }
  if (env.LED_API_UNIT_PROFILE !== profile) throw new Error("invalid API unit profile");
  if (platform !== "linux") throw new Error("isolated API unit profile requires Linux");
  for (const [key, value] of Object.entries({ CI: "true", GITHUB_ACTIONS: "true", GITHUB_JOB: "unit", RUNNER_OS: "Linux" })) {
    if (env[key] !== value) throw new Error(`API unit profile requires ${key}=${value}`);
  }
  if (env.GITHUB_WORKSPACE !== path.resolve(directory, "../..")) throw new Error("API unit profile workspace mismatch");
  if (args.length) throw new Error("isolated API unit profile must run the full suite without caller filters");
  return {
    executable: "/usr/bin/sudo",
    args: ["--non-interactive", "--", "/usr/bin/python3", path.join(directory, "scripts/ci-unit-supervisor.py"), "--node", nodeExecutable],
    // Workspace group termination must leave the privileged cleanup supervisor alive.
    detached: true
  };
}

export async function runJest({ args = process.argv.slice(2), env = process.env } = {}) {
  const invocation = createJestInvocation({ args, env, platform: process.platform, nodeExecutable: process.execPath, apiRoot });
  const isolated = invocation.detached;
  const child = spawn(invocation.executable, invocation.args, {
    cwd: apiRoot, env, detached: invocation.detached,
    stdio: [isolated ? "pipe" : "inherit", "inherit", "inherit"]
  });
  let received;
  let forwardingError;
  const handlers = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, () => {
    if (received) return;
    received = signal;
    try {
      if (isolated) child.stdin.write(JSON.stringify({ signal }) + "\n");
      else child.kill(signal);
    } catch (error) { forwardingError = error; }
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  if (isolated) {
    // Full parent environment is forwarded to nonroot Jest. The converter still
    // applies its existing credential allowlist; root commands never use this PATH.
    child.stdin.on("error", error => { if (error.code !== "EPIPE") forwardingError = error; });
    child.stdin.write(JSON.stringify({ version: 1, env, args }) + "\n");
  }
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (forwardingError) throw forwardingError;
    return { code: outcome.code ?? 1, signal: received ?? outcome.signal };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    child.stdin?.end();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runJest();
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
