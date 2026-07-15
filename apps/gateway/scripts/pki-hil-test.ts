import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PKI_HIL_STEPS = [
  "manufacturing",
  "token-reuse",
  "csr-tamper",
  "serial-mismatch",
  "wrong-ca",
  "claim-bootstrap-mqtt",
  "restart-recovery",
  "mqtt-rotation",
  "two-gateway-fingerprint",
  "secret-scan"
] as const;
export type PkiHilStep = (typeof PKI_HIL_STEPS)[number];
export type PkiStepResult = { passed: boolean; evidence?: unknown; error?: string };
export type PkiExecutor = (step: PkiHilStep) => Promise<PkiStepResult>;

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(secret|password|claim.?code|private.?key|token)/i.test(key) ? "[REDACTED]" : redactSecrets(item)
  ]));
}

export async function runPkiHil(execute: PkiExecutor) {
  const steps = [];
  for (const name of PKI_HIL_STEPS) {
    const startedAt = Date.now();
    try {
      const result = await execute(name);
      const validationError = result.passed ? validateEvidence(name, result.evidence) : undefined;
      steps.push({
        name,
        passed: result.passed && !validationError,
        durationMs: Date.now() - startedAt,
        evidence: redactSecrets(result.evidence),
        ...((validationError || result.error) ? { error: safeError(validationError || result.error) } : {})
      });
    } catch (error) {
      steps.push({ name, passed: false, durationMs: Date.now() - startedAt, error: safeError(error) });
    }
  }
  return { passed: steps.every((step) => step.passed), steps };
}

function validateEvidence(step: PkiHilStep, evidence: unknown) {
  const value = evidence && typeof evidence === "object" ? evidence as Record<string, unknown> : {};
  if (step === "manufacturing" && value.privateKeyExported !== false) return "manufacturing must prove privateKeyExported=false";
  if (["token-reuse", "csr-tamper", "serial-mismatch", "wrong-ca"].includes(step) && value.rejected !== true) {
    return `${step} must prove rejected=true`;
  }
  if (step === "claim-bootstrap-mqtt" && (value.assigned !== true || value.mqttIssued !== true)) {
    return "claim/bootstrap must prove assignment and MQTT issuance";
  }
  if (step === "restart-recovery" && (value.identityRecovered !== true || value.assignmentRecovered !== true)) {
    return "restart must prove identity and assignment recovery";
  }
  if (step === "mqtt-rotation" && (value.lostCommands !== 0 || value.duplicateCommands !== 0)) {
    return "rotation must prove zero lost and duplicate commands";
  }
  if (step === "two-gateway-fingerprint") {
    const fingerprints = value.fingerprints;
    if (!Array.isArray(fingerprints) || fingerprints.length !== 2 ||
      fingerprints.some((fingerprint) => typeof fingerprint !== "string" || !/^[0-9A-F]{64}$/.test(fingerprint)) ||
      new Set(fingerprints).size !== 2) {
      return "two gateways must have distinct fingerprints";
    }
  }
  if (step === "secret-scan" && value.matches !== 0) return "secret scan must report zero matches";
  return undefined;
}

function command(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`${name} must be a non-empty JSON string array`);
  }
  return parsed as string[];
}

function run(commandLine: string[], timeoutMs: number) {
  return new Promise<PkiStepResult>((resolve, reject) => {
    const child = spawn(commandLine[0], commandLine.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    const output: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (result: PkiStepResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ passed: false, error: "command output exceeded limit" });
      } else output.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return finish({ passed: false, error: `command exited with code ${code}` });
      try { finish({ passed: true, evidence: JSON.parse(Buffer.concat(output).toString("utf8")) }); }
      catch { finish({ passed: false, error: "command must output one JSON document" }); }
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ passed: false, error: "command timed out" });
    }, timeoutMs);
  });
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown HIL error";
  return message.replace(/(secret|password|claim.?code|private.?key|token)=\S+/gi, "$1=[REDACTED]");
}

export async function main() {
  const repeat = boundedInteger(process.env.PKI_HIL_REPEAT ?? "3", "PKI_HIL_REPEAT", 1, 10);
  const timeoutMs = boundedInteger(process.env.PKI_HIL_STEP_TIMEOUT_MS ?? "120000", "PKI_HIL_STEP_TIMEOUT_MS", 1, 600_000);
  const runs = [];
  for (let i = 0; i < repeat; i += 1) {
    runs.push(await runPkiHil((step) => {
      const key = `PKI_HIL_${step.replace(/-/g, "_").toUpperCase()}_COMMAND_JSON`;
      return run(command(process.env[key], key), timeoutMs);
    }));
  }
  const result = { passed: runs.every((runResult) => runResult.passed), repeat, runs };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} is invalid`);
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => { process.stderr.write(`${safeError(error)}\n`); process.exitCode = 1; });
}
