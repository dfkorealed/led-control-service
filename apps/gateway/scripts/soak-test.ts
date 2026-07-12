import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

type SoakExecution = { passed: boolean; evidence?: unknown; error?: string };

export async function runSoak(options: {
  durationMs: number;
  intervalMs: number;
  execute: () => Promise<SoakExecution>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  record: (entry: unknown) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let samples = 0;
  let failures = 0;

  while (now() - startedAt < options.durationMs) {
    const sampleStartedAt = now();
    let execution: SoakExecution;
    try {
      execution = await options.execute();
    } catch (error) {
      execution = { passed: false, error: safeError(error) };
    }
    samples += 1;
    if (!execution.passed) failures += 1;
    await options.record({
      sample: samples,
      passed: execution.passed,
      elapsedMs: now() - startedAt,
      durationMs: now() - sampleStartedAt,
      evidence: redactSecrets(execution.evidence),
      error: execution.error
    });
    if (!execution.passed) return { passed: false, samples, failures, error: execution.error ?? "soak sample failed" };
    const remaining = options.durationMs - (now() - startedAt);
    if (remaining > 0) await sleep(Math.min(options.intervalMs, remaining));
  }
  return { passed: true, samples, failures };
}

function processExecutor(command: string[], timeoutMs: number) {
  return () => new Promise<SoakExecution>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        resolve({ passed: false, error: `health command exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").trim()}` });
        return;
      }
      try {
        resolve({ passed: true, evidence: JSON.parse(Buffer.concat(stdout).toString("utf8")) });
      } catch {
        resolve({ passed: false, error: "health command must output one JSON document" });
      }
    });
  });
}

async function main() {
  const command = parseCommand(process.env.SOAK_HEALTH_COMMAND_JSON);
  const outputPath = process.env.SOAK_OUTPUT_PATH ?? ".local/soak-72h.jsonl";
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await runSoak({
    durationMs: Number(process.env.SOAK_DURATION_HOURS ?? 72) * 60 * 60 * 1000,
    intervalMs: Number(process.env.SOAK_INTERVAL_SECONDS ?? 300) * 1000,
    execute: processExecutor(command, Number(process.env.SOAK_SAMPLE_TIMEOUT_MS ?? 120_000)),
    record: async (entry) => {
      await appendFile(outputPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      await chmod(outputPath, 0o600);
    }
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

function parseCommand(value: string | undefined) {
  if (!value) throw new Error("SOAK_HEALTH_COMMAND_JSON is required");
  const command = JSON.parse(value) as unknown;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error("SOAK_HEALTH_COMMAND_JSON must be a non-empty JSON string array");
  }
  return command;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(secret|password|claim.?code|private.?key|token)/i.test(key) ? "[REDACTED]" : redactSecrets(item)
  ]));
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "unknown soak error";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
