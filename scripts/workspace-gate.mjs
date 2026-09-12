import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOutputLock } from "../packages/shared/scripts/build-output-lock.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const operation = process.argv[2];
const consumerCommands = {
  build: ["pnpm", [
    "--filter", "!@led-control/shared",
    "--filter", "!@led-control/automation-engine",
    "-r", "--if-present", "build"
  ]],
  lint: ["pnpm", ["-r", "lint"]],
  test: ["pnpm", ["run", "test:unit"]],
  typecheck: ["pnpm", ["-r", "typecheck"]]
};

if (!(operation in consumerCommands)) {
  throw new Error(`unsupported workspace gate operation: ${String(operation)}`);
}
if (process.platform === "win32") {
  throw new Error("workspace gate cannot guarantee descendant process lifetime on Windows");
}

const release = await acquireOutputLock({
  lockPath: join(repositoryRoot, ".workspace-command.lock"),
  timeoutMs: null,
  waitOnUnknownOwner: true
});
const signalState = installSignalForwarding();
let outcome;

try {
  outcome = await run("pnpm", ["run", "workspace:prepare"], signalState);
  if (isSuccessful(outcome) && !signalState.received) {
    outcome = await run(...consumerCommands[operation], signalState);
  }
} finally {
  signalState.dispose();
  const released = await release();
  if (!released) throw new Error("workspace command lock ownership changed before release");
}

if (signalState.forwardingError) throw signalState.forwardingError;
if (outcome?.signal) {
  process.kill(process.pid, outcome.signal);
} else if (signalState.received) {
  process.kill(process.pid, signalState.received);
} else {
  process.exitCode = outcome?.code ?? 1;
}

function run(command, args, signalState) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      detached: true,
      stdio: "inherit"
    });
    signalState.own(child);
    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      try {
        await waitForProcessGroupExit(child.pid);
        signalState.disown(child);
        resolve({ code, signal });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitForProcessGroupExit(processGroupId) {
  while (hasLiveProcessGroupMember(processGroupId)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function hasLiveProcessGroupMember(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return false;
    if (isErrorCode(error, "EPERM")) return true;
    throw error;
  }
}

function installSignalForwarding() {
  let activeChild;
  let received;
  let forwardingError;
  const handlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => {
    received ??= signal;
    if (!activeChild?.pid) return;
    try {
      process.kill(-activeChild.pid, signal);
    } catch (error) {
      if (!isErrorCode(error, "ESRCH")) forwardingError ??= error;
    }
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return {
    get received() { return received; },
    get forwardingError() { return forwardingError; },
    own(child) { activeChild = child; },
    disown(child) {
      if (activeChild === child) activeChild = undefined;
    },
    dispose() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  };
}

function isSuccessful(outcome) {
  return outcome.code === 0 && outcome.signal === null;
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
