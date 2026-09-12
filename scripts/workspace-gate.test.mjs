import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForObservedValue } from "./test-event-wait.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("event wait closes the initial access-watch gap by rechecking after subscription", async () => {
  let published;
  const watcher = createTestWatcher([{ done: true }]);

  const result = await waitForObservedValue({
    observe: async () => published,
    subscribe: () => {
      published = "ready";
      return watcher.iterator;
    },
    description: "fixture signal"
  });

  assert.equal(result, "ready");
  assert.equal(watcher.nextCalls, 0);
  assert.equal(watcher.returnCalls, 1);
});

test("event wait races producer failure and closes the watcher", async () => {
  const producerError = new Error("producer failed before signal");
  let rejectProducer;
  const producer = new Promise((_, reject) => { rejectProducer = reject; });
  producer.catch(() => undefined);
  const watcher = createTestWatcher([], producer);

  await assert.rejects(waitForObservedValue({
    observe: async () => undefined,
    subscribe: () => {
      queueMicrotask(() => rejectProducer(producerError));
      return watcher.iterator;
    },
    producer,
    description: "fixture signal"
  }), producerError);
  assert.equal(watcher.returnCalls, 1);
});

test("event wait abort and iterator-end paths close the watcher", async () => {
  const controller = new AbortController();
  const abortWatcher = createTestWatcher([{ done: true }]);
  await assert.rejects(waitForObservedValue({
    observe: async () => undefined,
    subscribe: () => {
      controller.abort();
      return abortWatcher.iterator;
    },
    signal: controller.signal,
    description: "fixture signal"
  }), { name: "AbortError" });
  assert.equal(abortWatcher.returnCalls, 1);

  const endedWatcher = createTestWatcher([{ done: true }]);
  await assert.rejects(waitForObservedValue({
    observe: async () => undefined,
    subscribe: () => endedWatcher.iterator,
    description: "fixture signal"
  }), /watch ended before fixture signal was observed/);
  assert.equal(endedWatcher.returnCalls, 1);
});

test("event wait returns a producer exit path before the watcher ends and closes it", async () => {
  let resolveProducer;
  const producer = new Promise((resolve) => { resolveProducer = resolve; });
  const watcher = createTestWatcher([], producer);

  const resultPromise = waitForObservedValue({
    observe: async () => undefined,
    subscribe: () => {
      queueMicrotask(() => resolveProducer("child-exited"));
      return watcher.iterator;
    },
    producer,
    description: "fixture signal"
  });

  await assert.doesNotReject(resultPromise);
  assert.equal(await resultPromise, "child-exited");
  assert.equal(watcher.returnCalls, 1);
});

test("waitForOnePath returns a child exit path without a filesystem signal and removes its listeners", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "led-workspace-wait-child-"));
  const child = spawn(process.execPath, ["--eval", "process.exit(7)"], { stdio: "ignore" });
  const initialExitListeners = child.listenerCount("exit");
  try {
    const result = await waitForOnePath([path.join(fixtureRoot, "never-published")], child);

    assert.equal(path.basename(result), "gate-exited");
    assert.equal(await readFile(result, "utf8"), "exited\n");
    assert.equal(child.exitCode, 7);
    assert.equal(child.listenerCount("exit"), initialExitListeners);
  } finally {
    terminate(child.pid);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function createTestWatcher(steps, producer) {
  let nextCalls = 0;
  let returnCalls = 0;
  const iterator = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      nextCalls += 1;
      const step = steps.shift();
      if (step) return step;
      if (producer) {
        await producer.then(
          () => new Promise((resolve) => queueMicrotask(resolve)),
          () => new Promise((resolve) => queueMicrotask(resolve))
        );
      }
      return { done: true };
    },
    async return() {
      returnCalls += 1;
      return { done: true };
    }
  };
  return {
    iterator,
    get nextCalls() { return nextCalls; },
    get returnCalls() { return returnCalls; }
  };
}

async function readPackageJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

test("canonical root checks enter one workspace gate and wire every production contract once", async () => {
  const rootPackage = await readPackageJson("package.json");

  for (const operation of ["lint", "typecheck", "test", "build"]) {
    assert.equal(rootPackage.scripts[operation], `node scripts/workspace-gate.mjs ${operation}`);
  }

  const unitCommand = rootPackage.scripts["test:unit"];
  for (const contractPath of [
    "scripts/production-audit-policy.test.mjs",
    "scripts/image-size-security.test.mjs",
    "tests/mqtt-production-config.node.mjs"
  ]) {
    assert.equal(unitCommand.split(contractPath).length - 1, 1, `${contractPath} must run exactly once`);
  }
});

test("workspace dependency preparation is ordered once and leaf checks cannot start nested writers", async () => {
  const rootPackage = await readPackageJson("package.json");
  assert.equal(
    rootPackage.scripts["workspace:prepare"],
    "pnpm --filter @led-control/shared build && pnpm --filter @led-control/automation-engine build"
  );

  const packageFiles = [
    "apps/api/package.json",
    "apps/gateway/package.json",
    "apps/web/package.json",
    "packages/automation-engine/package.json",
    "packages/shared/package.json"
  ];
  const forbiddenLifecycleScripts = new Set([
    "prebuild",
    "prelint",
    "pretest",
    "pretypecheck"
  ]);
  const forbiddenNestedWriter = /(?:pnpm\s+--filter\s+@led-control\/(?:shared|automation-engine)\s+build|pnpm\s+run\s+(?:build:shared|build:dependencies))/;

  for (const packageFile of packageFiles) {
    const packageJson = await readPackageJson(packageFile);
    for (const lifecycle of forbiddenLifecycleScripts) {
      assert.equal(packageJson.scripts[lifecycle], undefined, `${packageJson.name} must not define ${lifecycle}`);
    }
    for (const commandName of ["build", "lint", "test", "typecheck"]) {
      const command = packageJson.scripts[commandName];
      if (!command || packageJson.name === "@led-control/shared" && commandName === "build") continue;
      assert.doesNotMatch(command, forbiddenNestedWriter, `${packageJson.name} ${commandName} must be graph-pure`);
    }
  }
});

for (const shutdownSignal of ["SIGINT", "SIGTERM"]) test(`${shutdownSignal} keeps the workspace lock until the owned process group exits without signaling a reused group`, { timeout: 15_000 }, async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "led-workspace-gate-signal-"));
  const stateDirectory = path.join(fixtureRoot, "state");
  const fakeBin = path.join(fixtureRoot, "bin");
  const gatePath = path.join(fixtureRoot, "scripts", "workspace-gate.mjs");
  const lockModulePath = path.join(fixtureRoot, "packages", "shared", "scripts", "build-output-lock.mjs");
  const reuseProbePath = path.join(fixtureRoot, "group-reuse-probe.cjs");
  const unrelatedSignalPath = path.join(stateDirectory, "unrelated-group-signaled");
  const lateSignal = shutdownSignal === "SIGINT" ? "SIGTERM" : "SIGINT";
  await Promise.all([
    mkdir(stateDirectory, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(path.dirname(gatePath), { recursive: true }),
    mkdir(path.dirname(lockModulePath), { recursive: true })
  ]);
  await Promise.all([
    copyFile(path.join(repositoryRoot, "scripts", "workspace-gate.mjs"), gatePath),
    copyFile(path.join(repositoryRoot, "packages", "shared", "scripts", "build-output-lock.mjs"), lockModulePath),
    writeExecutable(path.join(fakeBin, "ps"), fakePsSource()),
    writeExecutable(path.join(fakeBin, "pnpm"), fakePnpmSource()),
    writeFile(reuseProbePath, groupReuseProbeSource())
  ]);

  const commonEnvironment = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    GATE_FIXTURE_STATE: stateDirectory,
    GATE_FIXTURE_SIGNAL: shutdownSignal,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${reuseProbePath}`.trim()
  };
  let oldGate;
  let successorGate;
  let oldChildPid;
  let oldGrandchildPid;
  try {
    oldGate = spawn(process.execPath, [gatePath, "test"], {
      cwd: fixtureRoot,
      env: { ...commonEnvironment, GATE_FIXTURE_ID: "old" },
      stdio: "ignore"
    });
    oldChildPid = Number(await waitForPathContent(path.join(stateDirectory, "old.child.pid")));
    oldGrandchildPid = Number(await waitForPathContent(path.join(stateDirectory, "old.grandchild.pid")));
    await waitForPathContent(path.join(stateDirectory, "old.grandchild-ready"));
    process.kill(oldGate.pid, shutdownSignal);
    await waitForPathContent(path.join(stateDirectory, "old.grandchild-received"));
    await waitForPathContent(path.join(stateDirectory, "old.leader-gone"));
    assert.equal(isProcessAlive(oldGrandchildPid), true);
    process.kill(oldGate.pid, lateSignal);

    successorGate = spawn(process.execPath, [gatePath, "test"], {
      cwd: fixtureRoot,
      env: { ...commonEnvironment, GATE_FIXTURE_ID: "successor" },
      stdio: "ignore"
    });
    const successorExitListeners = successorGate.listenerCount("exit");
    const firstSuccessorState = await waitForOnePath([
      path.join(stateDirectory, "successor.confirmed-waiting"),
      path.join(stateDirectory, "successor.consumer-started")
    ], successorGate);
    assert.equal(path.basename(firstSuccessorState), "successor.confirmed-waiting");
    assert.equal(successorGate.listenerCount("exit"), successorExitListeners);
    await assert.rejects(access(path.join(stateDirectory, "successor.consumer-started")));

    await writeFile(path.join(stateDirectory, "allow-old-exit"), "release\n");
    const oldOutcome = await childOutcome(oldGate);
    assert.equal(oldOutcome.code, null);
    await assert.rejects(access(unrelatedSignalPath));
    assert.equal(oldOutcome.signal, lateSignal);
    const successorOutcome = await childOutcome(successorGate);
    assert.deepEqual(successorOutcome, { code: 0, signal: null });
    assert.equal(isProcessAlive(oldChildPid), false);
    assert.equal(isProcessAlive(oldGrandchildPid), false);
    await assert.rejects(access(path.join(fixtureRoot, ".workspace-command.lock")));
  } finally {
    terminate(oldGate?.pid);
    terminate(successorGate?.pid);
    terminate(oldChildPid);
    terminate(oldGrandchildPid);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function groupReuseProbeSource() {
  return `
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const originalKill = process.kill.bind(process);
process.kill = (pid, signal) => {
  const leaderGone = join(process.env.GATE_FIXTURE_STATE ?? "", "old.leader-gone");
  if (pid < 0 && signal && signal !== 0 && existsSync(leaderGone)) {
    writeFileSync(join(process.env.GATE_FIXTURE_STATE, "unrelated-group-signaled"), String(signal));
    return true;
  }
  return originalKill(pid, signal);
};
`;
}

test("Windows fails closed before acquiring a lock or starting a child", { timeout: 10_000 }, async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "led-workspace-gate-windows-"));
  const fakeBin = path.join(fixtureRoot, "bin");
  const gatePath = path.join(fixtureRoot, "scripts", "workspace-gate.mjs");
  const lockModulePath = path.join(fixtureRoot, "packages", "shared", "scripts", "build-output-lock.mjs");
  const preloadPath = path.join(fixtureRoot, "windows-platform.cjs");
  const childMarker = path.join(fixtureRoot, "child-started");
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(path.dirname(gatePath), { recursive: true }),
    mkdir(path.dirname(lockModulePath), { recursive: true })
  ]);
  await Promise.all([
    copyFile(path.join(repositoryRoot, "scripts", "workspace-gate.mjs"), gatePath),
    copyFile(path.join(repositoryRoot, "packages", "shared", "scripts", "build-output-lock.mjs"), lockModulePath),
    writeFile(preloadPath, 'Object.defineProperty(process, "platform", { value: "win32" });\n'),
    writeExecutable(path.join(fakeBin, "pnpm"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(childMarker)}, "started");\n`)
  ]);

  try {
    const child = spawn(process.execPath, [gatePath, "lint"], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preloadPath}`.trim(),
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const outcome = await childOutcome(child);

    assert.deepEqual(outcome, { code: 1, signal: null });
    assert.match(stderr, /cannot guarantee descendant process lifetime on Windows/);
    await assert.rejects(access(path.join(fixtureRoot, ".workspace-command.lock")));
    await assert.rejects(access(childMarker));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function writeExecutable(filePath, source) {
  await writeFile(filePath, source);
  await chmod(filePath, 0o755);
}

function fakePsSource() {
  return `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const targetPid = Number(args[args.indexOf("-p") + 1]);
if (process.env.GATE_FIXTURE_ID === "successor" && targetPid !== process.ppid) {
  const countPath = join(process.env.GATE_FIXTURE_STATE, "successor.owner-observations");
  const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
  writeFileSync(countPath, String(count));
  if (count >= 3) writeFileSync(join(process.env.GATE_FIXTURE_STATE, "successor.confirmed-waiting"), String(targetPid));
}
process.stdout.write("Sat Sep 12 12:00:00 2026\\n");
`;
}

function fakePnpmSource() {
  const grandchildSource = `
const { existsSync, watch, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const state = process.env.GATE_FIXTURE_STATE;
const shutdownSignal = process.env.GATE_FIXTURE_SIGNAL;
const leaderPid = Number(process.env.GATE_FIXTURE_LEADER_PID);
const allowExit = join(state, "allow-old-exit");
const finish = () => {
  if (!existsSync(allowExit)) return;
  process.removeListener(shutdownSignal, onSignal);
  process.kill(process.pid, shutdownSignal);
};
const onSignal = () => {
  writeFileSync(join(state, "old.grandchild-received"), shutdownSignal);
  if (existsSync(allowExit)) return finish();
  const watcher = watch(state, () => {
    if (!existsSync(allowExit)) return;
    watcher.close();
    finish();
  });
};
const observeLeaderExit = () => {
  try {
    process.kill(leaderPid, 0);
    setImmediate(observeLeaderExit);
  } catch {
    writeFileSync(join(state, "old.leader-gone"), String(leaderPid));
  }
};
process.on(shutdownSignal, onSignal);
writeFileSync(join(state, "old.grandchild-ready"), String(process.pid));
setImmediate(observeLeaderExit);
setInterval(() => {}, 1_000);
`;
  return `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const state = process.env.GATE_FIXTURE_STATE;
const id = process.env.GATE_FIXTURE_ID;
const shutdownSignal = process.env.GATE_FIXTURE_SIGNAL;
if (process.argv.slice(2).join(" ") === "run workspace:prepare") process.exit(0);
if (id === "successor") {
  writeFileSync(join(state, "successor.consumer-started"), String(process.pid));
  process.exit(0);
}
const onSignal = () => {
  writeFileSync(join(state, "old.leader-received"), shutdownSignal);
  process.removeListener(shutdownSignal, onSignal);
  process.kill(process.pid, shutdownSignal);
};
process.on(shutdownSignal, onSignal);
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {
  env: { ...process.env, GATE_FIXTURE_LEADER_PID: String(process.pid) },
  stdio: "ignore"
});
writeFileSync(join(state, "old.child.pid"), String(process.pid));
writeFileSync(join(state, "old.grandchild.pid"), String(grandchild.pid));
setInterval(() => {}, 1_000);
`;
}

async function waitForPathContent(filePath) {
  return waitForObservedValue({
    observe: async () => {
      try {
        return (await readFile(filePath, "utf8")).trim();
      } catch {
        return undefined;
      }
    },
    subscribe: (signal) => watch(path.dirname(filePath), { signal }),
    description: filePath
  });
}

async function waitForOnePath(paths, child) {
  const childWaitController = child && new AbortController();
  const exitedPath = child && path.join(path.dirname(paths[0]), "gate-exited");
  const exitPromise = child && childOutcome(child, { signal: childWaitController.signal }).then(async () => {
    await writeFile(exitedPath, "exited\n");
    return exitedPath;
  });
  try {
    return await waitForObservedValue({
      observe: () => firstExistingPath(paths),
      subscribe: (signal) => watch(path.dirname(paths[0]), { signal }),
      producer: exitPromise,
      description: "a requested path"
    });
  } finally {
    childWaitController?.abort();
  }
}

async function firstExistingPath(paths) {
  for (const filePath of paths) {
    try {
      await access(filePath);
      return filePath;
    } catch {
      // Check the next candidate.
    }
  }
  return undefined;
}

function childOutcome(child, { signal } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, exitSignal) => {
      cleanup();
      resolve({ code, signal: exitSignal });
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminate(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}
