import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const HIL_STEP_NAMES = [
  "claim",
  "bootstrap",
  "secure-mqtt",
  "scan",
  "provision",
  "bind",
  "individual-control",
  "group-control",
  "stale-event",
  "offline",
  "restart-recovery",
  "acl-negative"
] as const;

type HilStepName = (typeof HIL_STEP_NAMES)[number];
type StepExecution = { passed: boolean; evidence?: unknown; error?: string };
export type HilExecutor = (name: HilStepName) => Promise<StepExecution>;

export async function runHilScenario(executor: HilExecutor) {
  const startedAt = new Date();
  const steps = [];
  for (const name of HIL_STEP_NAMES) {
    const stepStarted = Date.now();
    try {
      const result = await executor(name);
      steps.push({
        name,
        passed: result.passed,
        durationMs: Date.now() - stepStarted,
        ...(result.evidence === undefined ? {} : { evidence: redactSecrets(result.evidence) }),
        ...(result.error ? { error: result.error } : {})
      });
    } catch (error) {
      steps.push({ name, passed: false, durationMs: Date.now() - stepStarted, error: safeError(error) });
    }
  }
  return {
    passed: steps.every((step) => step.passed),
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    steps
  };
}

export function createProcessExecutor(env: NodeJS.ProcessEnv): HilExecutor {
  validateLabEnvironment(env);
  return async (name) => {
    const variable = `HIL_${name.replace(/-/g, "_").toUpperCase()}_COMMAND_JSON`;
    const command = parseCommand(env[variable], variable);
    const result = await execute(command, Number(env.HIL_STEP_TIMEOUT_MS ?? 120_000));
    if (result.exitCode !== 0) return { passed: false, error: `${name} command exited with code ${result.exitCode}` };
    try {
      const evidence = result.stdout.trim() ? JSON.parse(result.stdout) : {};
      return { passed: true, evidence };
    } catch {
      return { passed: false, error: `${name} command must output one JSON document` };
    }
  };
}

function validateLabEnvironment(env: NodeJS.ProcessEnv) {
  for (const name of [
    "HIL_GATEWAY_SERIAL",
    "HIL_NODE1_PORT",
    "HIL_NODE2_PORT",
    "HIL_CA_PATH",
    "HIL_GATEWAY_CERT_PATH",
    "HIL_GATEWAY_KEY_PATH"
  ]) {
    if (!env[name]) throw new Error(`${name} is required for the 2-node HIL test`);
  }
}

function parseCommand(value: string | undefined, variable: string): string[] {
  if (!value) throw new Error(`${variable} is required`);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`${variable} must be a non-empty JSON string array`);
  }
  return parsed;
}

function execute(command: string[], timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(secret|password|claim.?code|private.?key|token)/i.test(key) ? "[REDACTED]" : redactSecrets(item)
    ])
  );
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.replace(/(secret|password|token)=[^\s]+/gi, "$1=[REDACTED]") : "unknown HIL error";
}

async function main() {
  const repeatIndex = process.argv.indexOf("--repeat");
  const repeat = repeatIndex >= 0 ? Number(process.argv[repeatIndex + 1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("--repeat must be an integer from 1 to 20");
  const runs = [];
  for (let index = 0; index < repeat; index += 1) runs.push(await runHilScenario(createProcessExecutor(process.env)));
  process.stdout.write(`${JSON.stringify({ passed: runs.every((run) => run.passed), repeat, runs }, null, 2)}\n`);
  if (runs.some((run) => !run.passed)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
