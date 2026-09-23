import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeBioSensorShadowJsonl } from "./bio-sensor-shadow-analyze";

const execFileAsync = promisify(execFile);
const apkSha256 = "1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e";
const fingerprint = "a".repeat(64);
const roots: string[] = [];
const timestamp = (index: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, index)).toISOString();
type Entry = Record<string, unknown>;

function capture(): Entry[] {
  const entries: Entry[] = [{ type: "capture-start", schemaVersion: 1, apkSha256, timestamp: timestamp(0), source: { fingerprint, logicalAddress: 12, firmware: "1.2.0", protocol: "bio-v1" } }];
  let tick = 1;
  let sequence = 1;
  const phase = (kind: string, cycle: number, durationMs: number) => entries.push({ type: "phase", kind, cycle, durationMs, timestamp: timestamp(tick++) });
  const observation = (classification: string, body: string) => entries.push({ type: "observation", timestamp: timestamp(tick++), classification, sourceFingerprint: fingerprint, logicalAddress: 12, networkId: 7, destination: 254, rssiDbm: -42, sequence: sequence++, ttl: 3, control: true, innerOpcode: classification === "candidate" ? 9 : 12, innerBodyHex: body });
  phase("baseline", 0, 60_000);
  observation("candidate", "bb");
  for (let cycle = 1; cycle <= 10; cycle++) {
    phase("stimulus", cycle, 8_000);
    observation("candidate", "aa");
    phase("recovery", cycle, 22_000);
    observation("candidate", "bb");
  }
  entries.push({ type: "capture-complete", timestamp: timestamp(tick) });
  return entries;
}

const jsonl = (entries: Entry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const analyze = (entries: Entry[]) => analyzeBioSensorShadowJsonl(jsonl(entries));

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("BIO shadow analyzer parser", () => {
  it("rejects byte, line count, and individual line limits", () => {
    expect(() => analyzeBioSensorShadowJsonl("x".repeat(8 * 1024 * 1024 + 1))).toThrow();
    expect(() => analyzeBioSensorShadowJsonl("\n".repeat(20_001))).toThrow();
    expect(() => analyzeBioSensorShadowJsonl("x".repeat(4097))).toThrow();
  });

  it.each([
    ["invalid JSON", "{bad}\n"],
    ["array record", "[]\n"],
    ["unknown schema", jsonl([{ ...capture()[0], schemaVersion: 2 }])],
    ["unknown type", jsonl([{ type: "mystery", timestamp: timestamp(0) }])],
    ["wrong APK", jsonl([{ ...capture()[0], apkSha256: "b".repeat(64) }])],
    ["invalid SHA", jsonl([{ ...capture()[0], apkSha256: "not-a-hash" }])],
    ["non ISO timestamp", jsonl([{ ...capture()[0], timestamp: "2026-09-15" }])],
    ["unknown field", jsonl([{ ...capture()[0], secret: "must-not-pass" }])],
    ["unknown source field", jsonl([{ ...capture()[0], source: { ...(capture()[0]!.source as Entry), nativeUuid: "001122334455" } }])],
    ["invalid body hex", jsonl(capture().map((entry) => entry.type === "observation" ? { ...entry, innerBodyHex: "xyz" } : entry))]
  ])("rejects %s", (_name, input) => expect(() => analyzeBioSensorShadowJsonl(input)).toThrow());

  it("rejects duplicate lifecycle records and observations outside the lifecycle", () => {
    const entries = capture();
    expect(() => analyze([entries[0]!, entries[0]!, ...entries.slice(1)])).toThrow();
    expect(() => analyze([...entries, entries.at(-1)!])).toThrow();
    expect(() => analyze([entries[2]!, ...entries])).toThrow();
    expect(() => analyze([...entries, entries[2]!])).toThrow();
  });

  it("rejects non-monotonic timestamps and mixed source fingerprints", () => {
    const entries = capture();
    expect(() => analyze(entries.map((entry, index) => index === 2 ? { ...entry, timestamp: timestamp(0) } : entry))).toThrow();
    expect(() => analyze(entries.map((entry, index) => index === 2 ? { ...entry, sourceFingerprint: "b".repeat(64) } : entry))).toThrow();
  });
});

describe("BIO shadow evidence gate", () => {
  it("accepts ten complete ordered cycles as review evidence but never allows production activation", () => {
    expect(analyze(capture())).toMatchObject({ captureComplete: true, phaseSequenceValid: true, cyclesObserved: 10, sourceFingerprints: [fingerprint], networkIds: [7], sequence: { observed: 21, duplicates: 0, wraps: 0 }, sensorVariants: [{ bodyHex: "aa", baselineCount: 0, stimulusCycles: [1,2,3,4,5,6,7,8,9,10], recoveryCycles: [] }, { bodyHex: "bb", baselineCount: 1, stimulusCycles: [], recoveryCycles: [1,2,3,4,5,6,7,8,9,10] }], alivePackets: 0, readyForProtocolReview: true, productionActivationAllowed: false, reasons: [] });
  });

  it("requires a complete capture with all phases in order", () => {
    const entries = capture();
    expect(analyze(entries.slice(0, -1))).toMatchObject({ captureComplete: false, readyForProtocolReview: false });
    expect(analyze(entries.filter((entry) => !(entry.type === "phase" && entry.kind === "recovery" && entry.cycle === 10)))).toMatchObject({ phaseSequenceValid: false, readyForProtocolReview: false });
    const reordered = [...entries];
    reordered[3] = { ...reordered[3]!, kind: "recovery", durationMs: 22_000 };
    expect(analyze(reordered)).toMatchObject({ phaseSequenceValid: false, readyForProtocolReview: false });
  });

  it("requires one stable network and discriminating variants across all ten windows", () => {
    const entries = capture();
    expect(analyze(entries.map((entry, index) => index === 2 ? { ...entry, networkId: 8 } : entry))).toMatchObject({ networkIds: [7, 8], readyForProtocolReview: false });
    expect(analyze(entries.filter((entry) => !(entry.type === "observation" && entry.innerBodyHex === "aa" && entry.sequence === 2)))).toMatchObject({ readyForProtocolReview: false });
    expect(analyze(entries.map((entry) => entry.type === "observation" && entry.innerBodyHex === "bb" ? { ...entry, innerBodyHex: "aa" } : entry))).toMatchObject({ readyForProtocolReview: false });
    expect(analyze(entries.map((entry) => entry.type === "observation" && entry.innerBodyHex === "aa" ? { ...entry, innerBodyHex: "bb" } : entry))).toMatchObject({ readyForProtocolReview: false });
  });

  it("excludes baseline-only variants and stimulus variants also found in baseline", () => {
    const entries = capture();
    const extra = { ...entries[2]!, sequence: 250, innerBodyHex: "cc" };
    expect(analyze([...entries.slice(0, 3), extra, ...entries.slice(3)])).toMatchObject({ readyForProtocolReview: false });
    expect(analyze(entries.map((entry, index) => index === 2 ? { ...entry, innerBodyHex: "aa" } : entry))).toMatchObject({ readyForProtocolReview: false });
  });

  it("counts exact duplicates without adding coverage, counts wrap, and rejects other backwards jumps", () => {
    const entries = capture();
    const duplicate = { ...entries[4]!, timestamp: entries[4]!.timestamp };
    const withDuplicate = [...entries.slice(0, 5), duplicate, ...entries.slice(5)];
    expect(analyze(withDuplicate)).toMatchObject({ sequence: { observed: 22, duplicates: 1, wraps: 0 }, readyForProtocolReview: true });
    const withWrap = entries.map((entry) => entry.type === "observation" ? { ...entry, sequence: (entry.sequence as number) === 1 ? 255 : (entry.sequence as number) - 2 } : entry);
    expect(analyze(withWrap)).toMatchObject({ sequence: { observed: 21, duplicates: 0, wraps: 1 }, readyForProtocolReview: true });
    const backwards = entries.map((entry) => entry.type === "observation" && entry.sequence === 4 ? { ...entry, sequence: 1 } : entry);
    const report = analyze(backwards);
    expect(report.readyForProtocolReview).toBe(false);
    expect(report.reasons.length).toBeGreaterThan(0);
  });

  it("counts liveness without treating its body as a sensor variant", () => {
    const entries = capture();
    const alive = { ...entries[4]!, classification: "liveness", innerOpcode: 12, innerBodyHex: "cc", sequence: 100 };
    const report = analyze([...entries.slice(0, 5), alive, ...entries.slice(5)]);
    expect(report.alivePackets).toBe(1);
    expect(report.sensorVariants.some((variant) => variant.bodyHex === "cc")).toBe(false);
  });
});

describe("BIO shadow analyzer CLI", () => {
  async function run(args: string[]) {
    return execFileAsync("pnpm", ["exec", "tsx", join(import.meta.dirname, "bio-sensor-shadow-analyze.ts"), ...args], { cwd: join(import.meta.dirname, "..") });
  }

  it("writes a private analysis file and does not echo evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "bio-analyze-")); roots.push(root);
    const input = join(root, "capture.jsonl"); const output = join(root, "analysis.json");
    await writeFile(input, jsonl(capture()));
    const result = await run(["--output", output, "--input", input]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ readyForProtocolReview: true, productionActivationAllowed: false });
  });

  it("rejects duplicates, extras, relative paths, existing outputs, and symlink outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bio-analyze-")); roots.push(root);
    const input = join(root, "capture.jsonl"); const output = join(root, "analysis.json");
    await writeFile(input, jsonl(capture()));
    for (const args of [["--input", input, "--input", input, "--output", output], ["--input", input, "--output", output, "extra"], ["--input", "relative.jsonl", "--output", output], ["--input", input, "--output", "relative.json"]]) {
      await expect(run(args)).rejects.toThrow();
    }
    await writeFile(output, "keep");
    await expect(run(["--input", input, "--output", output])).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("keep");
    const link = join(root, "link.json");
    await symlink(output, link);
    await expect(run(["--input", input, "--output", link])).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("keep");
  });
});
