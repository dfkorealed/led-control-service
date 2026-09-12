import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { GATEWAY_HIL_WORKING_DIRECTORY, REPOSITORY_ROOT } from "./gateway-hil-path-contract.mjs";

const modeCommands = {
  preflight: ["node", "../../scripts/ci-hil-preflight.mjs"],
  pki: ["tsx", "scripts/pki-hil-test.ts"],
  "two-node": ["tsx", "scripts/hil-2node-test.ts"]
};

export function createGatewayHilInvocation(mode, args) {
  const command = modeCommands[mode];
  if (!command) throw new Error("HIL mode must be preflight, pki or two-node");
  return {
    command: "pnpm",
    args: ["exec", ...command, ...args],
    cwd: GATEWAY_HIL_WORKING_DIRECTORY,
    prepareShared: mode !== "preflight"
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  const invocation = createGatewayHilInvocation(mode, args);
  if (invocation.prepareShared && !run("pnpm", ["--filter", "@led-control/shared", "build"], REPOSITORY_ROOT)) return;
  run(invocation.command, invocation.args, invocation.cwd);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Gateway HIL launcher failed"}\n`);
    process.exitCode = 1;
  }
}
