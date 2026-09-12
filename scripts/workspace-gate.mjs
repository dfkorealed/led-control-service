import { spawnSync } from "node:child_process";
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

const release = await acquireOutputLock({
  lockPath: join(repositoryRoot, ".workspace-command.lock"),
  timeoutMs: null,
  waitOnUnknownOwner: true
});

try {
  run("pnpm", ["run", "workspace:prepare"]);
  run(...consumerCommands[operation]);
} finally {
  const released = await release();
  if (!released) throw new Error("workspace command lock ownership changed before release");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}
