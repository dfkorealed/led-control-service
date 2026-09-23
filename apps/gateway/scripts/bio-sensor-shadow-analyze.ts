import { open, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_LINE_BYTES = 4 * 1024;
const APK_SHA256 = "1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e" as const;
const EXPECTED_PHASES = [
  { kind: "baseline", cycle: 0, durationMs: 60_000 },
  ...Array.from({ length: 10 }, (_, index) => [
    { kind: "stimulus", cycle: index + 1, durationMs: 8_000 },
    { kind: "recovery", cycle: index + 1, durationMs: 22_000 }
  ]).flat()
];

export interface BioSensorShadowAnalysis {
  schemaVersion: 1;
  apkSha256: typeof APK_SHA256;
  firmware: string;
  protocol: string;
  captureComplete: boolean;
  phaseSequenceValid: boolean;
  cyclesObserved: number;
  sourceFingerprints: string[];
  networkIds: number[];
  sequence: { observed: number; duplicates: number; wraps: number };
  sensorVariants: Array<{ bodyHex: string; baselineCount: number; stimulusCycles: number[]; recoveryCycles: number[] }>;
  alivePackets: number;
  readyForProtocolReview: boolean;
  productionActivationAllowed: false;
  reasons: string[];
}

type JsonObject = Record<string, unknown>;
type Phase = { kind: string; cycle: number };
type Variant = { baselineCount: number; stimulusCycles: Set<number>; recoveryCycles: Set<number> };

function record(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid BIO shadow record");
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[]): void {
  // 허용한 스키마 필드만 해석한다. 현장 식별자 같은 추가 필드가 분석 결과로 흘러가는 것을 차단한다.
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid BIO shadow record fields");
}

function string(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("Invalid BIO shadow string field");
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error("Invalid BIO shadow integer field");
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw new Error("Invalid BIO shadow timestamp");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("Invalid BIO shadow timestamp");
  return time;
}

function parseLines(input: string): JsonObject[] {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_BYTES) throw new Error("BIO shadow input exceeds size limit");
  // 줄 수를 먼저 세어 개행만 수백만 개 들어온 입력에서도 split 배열이 과도하게 커지지 않게 한다.
  let lineCount = 1;
  for (const character of input) {
    if (character === "\n" && ++lineCount > MAX_LINES + 1) throw new Error("BIO shadow input exceeds line limit");
  }
  const lines = input.endsWith("\n") ? input.slice(0, -1).split("\n") : input.split("\n");
  if (lines.length > MAX_LINES) throw new Error("BIO shadow input exceeds line limit");
  return lines.map((line) => {
    if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Invalid BIO shadow line size");
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Invalid BIO shadow JSON"); }
    return record(value);
  });
}

export function analyzeBioSensorShadowJsonl(input: string): BioSensorShadowAnalysis {
  const lines = parseLines(input);
  let started = false;
  let complete = false;
  let previousTime = -Infinity;
  let phaseIndex = 0;
  let phaseSequenceValid = true;
  let currentPhase: Phase | undefined;
  let firmware = "";
  let protocol = "";
  let sourceFingerprint = "";
  let logicalAddress = 0;
  let observed = 0;
  let duplicates = 0;
  let wraps = 0;
  let previousSequence: number | undefined;
  let backwardsSequence = false;
  let alivePackets = 0;
  const actualPhases: Phase[] = [];
  const observedNetworkIds = new Set<number>();
  const variants = new Map<string, Variant>();
  const seenPackets = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const type = string(line.type, /^(capture-start|phase|observation|capture-complete)$/);
    if (complete || (index > 0 && !started) || (type !== "capture-start" && !started)) throw new Error("Invalid BIO shadow lifecycle");
    const time = timestamp(line.timestamp);
    if (time < previousTime) throw new Error("Non-monotonic BIO shadow timestamp");
    previousTime = time;

    if (type === "capture-start") {
      if (started || index !== 0) throw new Error("Duplicate BIO shadow capture start");
      exactKeys(line, ["type", "schemaVersion", "apkSha256", "timestamp", "source"]);
      if (line.schemaVersion !== 1) throw new Error("Unsupported BIO shadow schema");
      const hash = string(line.apkSha256, /^[0-9a-f]{64}$/);
      if (hash !== APK_SHA256) throw new Error("Unsupported BIO shadow APK");
      const source = record(line.source);
      exactKeys(source, ["fingerprint", "logicalAddress", "firmware", "protocol"]);
      sourceFingerprint = string(source.fingerprint, /^[0-9a-f]{64}$/);
      logicalAddress = integer(source.logicalAddress, 1, 0x7fff);
      firmware = string(source.firmware, /^[A-Za-z0-9._+-]{1,64}$/);
      protocol = string(source.protocol, /^[A-Za-z0-9._+-]{1,64}$/);
      started = true;
      continue;
    }

    if (type === "phase") {
      exactKeys(line, ["type", "kind", "cycle", "durationMs", "timestamp"]);
      const kind = string(line.kind, /^(baseline|stimulus|recovery)$/);
      const cycle = integer(line.cycle, 0, 10);
      const durationMs = integer(line.durationMs, 1, 60_000);
      if ((kind === "baseline") !== (cycle === 0) || durationMs !== (kind === "baseline" ? 60_000 : kind === "stimulus" ? 8_000 : 22_000)) throw new Error("Invalid BIO shadow phase");
      const expected = EXPECTED_PHASES[phaseIndex];
      if (!expected || expected.kind !== kind || expected.cycle !== cycle) phaseSequenceValid = false;
      phaseIndex++;
      currentPhase = { kind, cycle };
      actualPhases.push(currentPhase);
      continue;
    }

    if (type === "capture-complete") {
      exactKeys(line, ["type", "timestamp"]);
      complete = true;
      continue;
    }

    exactKeys(line, ["type", "timestamp", "classification", "sourceFingerprint", "logicalAddress", "networkId", "destination", "rssiDbm", "sequence", "ttl", "control", "innerOpcode", "innerBodyHex"]);
    if (!currentPhase) throw new Error("BIO shadow observation before first phase");
    const classification = string(line.classification, /^(candidate|liveness)$/);
    if (string(line.sourceFingerprint, /^[0-9a-f]{64}$/) !== sourceFingerprint || integer(line.logicalAddress, 1, 0x7fff) !== logicalAddress) throw new Error("Mixed BIO shadow source");
    observedNetworkIds.add(integer(line.networkId, 0, 0xffff));
    integer(line.destination, 0, 0xffff);
    integer(line.rssiDbm, -128, 127);
    const sequence = integer(line.sequence, 0, 255);
    integer(line.ttl, 0, 127);
    if (typeof line.control !== "boolean") throw new Error("Invalid BIO shadow control bit");
    const opcode = integer(line.innerOpcode, 0, 255);
    if (opcode !== (classification === "candidate" ? 9 : 12)) throw new Error("Invalid BIO shadow opcode");
    const bodyHex = string(line.innerBodyHex, /^(?:[0-9a-f]{2})*$/);
    observed++;
    if (classification === "liveness") alivePackets++;
    const packetKey = `${sequence}:${opcode}:${bodyHex}`;
    // 중복 패킷도 시퀀스 흐름에는 속한다. 255→0 재전송을 먼저 건너뛰면 wrap을 놓치고 다음 패킷을 역행으로 오판한다.
    if (previousSequence !== undefined && sequence < previousSequence) {
      if (previousSequence === 255 && sequence === 0) wraps++;
      else backwardsSequence = true;
    }
    previousSequence = sequence;
    // 같은 시퀀스·opcode·본문은 주기별 센서 출현 근거로 중복 계산하지 않는다.
    if (seenPackets.has(packetKey)) { duplicates++; continue; }
    seenPackets.add(packetKey);
    if (classification === "liveness") continue;
    const variant = variants.get(bodyHex) ?? { baselineCount: 0, stimulusCycles: new Set<number>(), recoveryCycles: new Set<number>() };
    if (currentPhase.kind === "baseline") variant.baselineCount++;
    else if (currentPhase.kind === "stimulus") variant.stimulusCycles.add(currentPhase.cycle);
    else variant.recoveryCycles.add(currentPhase.cycle);
    variants.set(bodyHex, variant);
  }

  // 시퀀스가 255→0 이외로 역행하면 패킷 순서를 신뢰할 수 없어 phase 근거 전체를 불완전하게 취급한다.
  // 아래 검토 가능 여부는 계획서에 고정된 단일 식으로만 계산하므로 이 안전 조건을 선행 피연산자에 반영한다.
  phaseSequenceValid &&= phaseIndex === EXPECTED_PHASES.length && !backwardsSequence;
  const cyclesObserved = Array.from({ length: 10 }, (_, index) => index + 1).filter((cycle) => {
    const stimulusAt = actualPhases.findIndex((phase) => phase.kind === "stimulus" && phase.cycle === cycle);
    return stimulusAt >= 0 && actualPhases[stimulusAt + 1]?.kind === "recovery" && actualPhases[stimulusAt + 1]?.cycle === cycle;
  }).length;
  const sensorVariants = [...variants.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([bodyHex, variant]) => ({
    bodyHex,
    baselineCount: variant.baselineCount,
    stimulusCycles: [...variant.stimulusCycles].sort((a, b) => a - b),
    recoveryCycles: [...variant.recoveryCycles].sort((a, b) => a - b)
  }));
  const baselineVariants = sensorVariants.filter((variant) => variant.baselineCount > 0).map((variant) => variant.bodyHex);
  const stimulusVariants = sensorVariants.filter((variant) => variant.stimulusCycles.length === 10).map((variant) => variant.bodyHex);
  const recoveryVariants = sensorVariants.filter((variant) => variant.recoveryCycles.length === 10).map((variant) => variant.bodyHex);
  const sourceFingerprints = started ? [sourceFingerprint] : [];
  const networkIds = [...observedNetworkIds].sort((a, b) => a - b);
  const captureComplete = complete;
  // 이 식은 기록 증거의 검토 적합성만 판단한다. 센서 의미 확정이나 제품 기능 활성화를 승인하지 않는다.
  const readyForProtocolReview =
    captureComplete
    && phaseSequenceValid
    && cyclesObserved === 10
    && sourceFingerprints.length === 1
    && networkIds.length === 1
    && stimulusVariants.length >= 1
    && recoveryVariants.length >= 1
    && baselineVariants.every((value) => recoveryVariants.includes(value))
    && stimulusVariants.some((value) => !recoveryVariants.includes(value));
  const reasons: string[] = [];
  if (!complete) reasons.push("capture-incomplete");
  if (!phaseSequenceValid) reasons.push("phase-sequence-invalid");
  if (cyclesObserved !== 10) reasons.push("cycles-incomplete");
  if (networkIds.length !== 1) reasons.push("network-id-unstable");
  if (stimulusVariants.length === 0) reasons.push("stimulus-variant-missing");
  if (recoveryVariants.length === 0) reasons.push("recovery-variant-missing");
  if (!baselineVariants.every((value) => recoveryVariants.includes(value))) reasons.push("baseline-variant-not-recovered");
  if (!stimulusVariants.some((value) => !recoveryVariants.includes(value))) reasons.push("discriminating-variant-missing");
  if (backwardsSequence) reasons.push("sequence-backwards");
  return { schemaVersion: 1, apkSha256: APK_SHA256, firmware, protocol, captureComplete, phaseSequenceValid, cyclesObserved, sourceFingerprints, networkIds, sequence: { observed, duplicates, wraps }, sensorVariants, alivePackets, readyForProtocolReview, productionActivationAllowed: false, reasons };
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_BYTES) throw new Error("BIO shadow input exceeds size limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error("Invalid BIO shadow UTF-8");
    return decoded;
  } finally { await handle.close(); }
}

async function main(args: string[]): Promise<void> {
  // pnpm 9의 package-script 경로는 문서의 `--`를 그대로 전달한다. 맨 앞 하나만 인자 구분자로 소비한다.
  const cliArgs = args[0] === "--" ? args.slice(1) : args;
  let input: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < cliArgs.length; index += 2) {
    const flag = cliArgs[index];
    const value = cliArgs[index + 1];
    if (!value || !isAbsolute(value)) throw new Error("Invalid BIO shadow CLI arguments");
    if (flag === "--input" && input === undefined) input = value;
    else if (flag === "--output" && output === undefined) output = value;
    else throw new Error("Invalid BIO shadow CLI arguments");
  }
  if (cliArgs.length !== 4 || !input || !output || resolve(input) === resolve(output)) throw new Error("Invalid BIO shadow CLI arguments");
  try { await lstat(output); throw new Error("BIO shadow output already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const analysis = analyzeBioSensorShadowJsonl(await readBounded(input));
  // 결과 파일은 새 이름으로만 열고 권한을 고정한다. 기존 파일과 심볼릭 링크는 덮어쓸 수 없다.
  const handle = await open(output, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(analysis, null, 2)}\n`, "utf8");
    await handle.datasync();
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // 파싱 실패 메시지에는 증거 원문·경로를 출력하지 않는다.
    process.stderr.write("BIO shadow analysis failed\n");
    process.exitCode = 1;
  });
}
