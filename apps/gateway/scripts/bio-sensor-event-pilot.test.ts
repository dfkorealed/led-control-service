import { describe, expect, it } from "vitest";
import { PilotRuntime, type PilotOriginal, type PilotPort, type PilotState } from "./bio-sensor-event-pilot-runtime";
import type { BioSensorPulseCandidate } from "../src/bio/bio-command-codec";
import type { BioOperationControl } from "../src/bio/bio-dongle-client";
import { main, parsePilotArgs, openPilotJournal } from "./bio-sensor-event-pilot";
import { mkdtemp, readFile, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  let now = 0, link = true;
  const originals: Record<"A" | "B", PilotOriginal> = {
    A: { raw: 155, configuration: { configuredHighBrightnessPercent: 40, bioMode: "force-off" } },
    B: { raw: 155, configuration: { configuredHighBrightnessPercent: 40, bioMode: "sensor" } }
  };
  const states: PilotState[] = [], calls: string[] = [];
  const port: PilotPort = {
    prepare: async () => ({ generation: 1, originals: structuredClone(originals) }),
    sensor: async () => { calls.push("sensor-A"); },
    applyB: async control => { if (control.mayStartWrite?.() === false) throw Error("stopped"); calls.push("apply-B-60"); },
    link: async () => { calls.push("GET-A"); return link; },
    restore: async name => { calls.push("restore-" + name); }, close: async () => { calls.push("close"); }
  };
  const runtime = new PilotRuntime({ holdSeconds: 10, monotonic: () => now, journal: async s => { states.push(structuredClone(s)); }, port });
  const pulse = (sequence = 1, body = "0101000000000000"): BioSensorPulseCandidate => ({
    kind: "sensor-status-candidate", innerOpcode: 9, innerBody: Buffer.from(body, "hex"), deviceUuid: "bio:e466e5265fe4",
    logicalAddress: 256, networkId: 0, destination: 0, sequence, ttl: 0, control: false, rssiDbm: -70,
    generation: 1, receivedMonotonicMs: now
  });
  return { runtime, port, calls, states, pulse, setNow: (v: number) => { now = v; }, breakLink: () => { link = false; } };
}

describe("A/B opt-in pilot boundaries", () => {
  it("durably captures pending originals before sensor preparation and first B write", async () => {
    const f = fixture();
    f.port.sensor = async () => { expect(f.states.at(-1)?.pending).toContain("A"); f.calls.push("sensor-A"); };
    f.port.applyB = async () => { expect(f.states.at(-1)?.pending).toContain("B"); expect(f.states.at(-1)?.originals?.B.raw).toBe(155); f.calls.push("apply-B-60"); };
    await f.runtime.start(); await f.runtime.pulse(f.pulse());
    expect(f.calls).toContain("apply-B-60");
  });
  it("extends one occurrence without another B write or recapturing its base", async () => {
    const f = fixture(); await f.runtime.start(); await f.runtime.pulse(f.pulse());
    f.setNow(9000); await f.runtime.pulse(f.pulse(2, "0505000000000000"));
    expect(f.calls.filter(x => x === "apply-B-60")).toHaveLength(1);
    expect(f.states.at(-1)?.deadlineMonotonicMs).toBe(19000);
    f.setNow(10000); await f.runtime.tick(); expect(f.calls).not.toContain("restore-B");
    f.setNow(19000); await f.runtime.tick(); expect(f.calls).toContain("GET-A"); expect(f.calls).toContain("restore-B");
  });
  it("rejects unknown bodies, wrong node/network/generation and duplicate or replay receipts", async () => {
    const f = fixture(); await f.runtime.start(); await f.runtime.pulse(f.pulse(5));
    f.setNow(5000);
    for (const candidate of [f.pulse(5), f.pulse(4), f.pulse(6, "0303000000000000"), { ...f.pulse(6), networkId: 1 },
      { ...f.pulse(6), deviceUuid: "bio:e466e55d7e3d" }, { ...f.pulse(6), logicalAddress: 259 },
      { ...f.pulse(6), innerOpcode: 12 } as unknown as BioSensorPulseCandidate, { ...f.pulse(6), generation: 2 }]) await f.runtime.pulse(candidate);
    expect(f.states.at(-1)?.deadlineMonotonicMs).toBe(10000);
    expect(f.calls.filter(x => x === "apply-B-60")).toHaveLength(1);
  });
  it("holds B after an independent GET failure and restores only on explicit stop", async () => {
    const f = fixture(); await f.runtime.start(); await f.runtime.pulse(f.pulse()); f.breakLink(); f.setNow(10000);
    await f.runtime.tick(); expect(f.calls).not.toContain("restore-B");
    await f.runtime.pulse(f.pulse(2)); expect(f.calls.filter(x => x === "apply-B-60")).toHaveLength(1);
    await f.runtime.stop(); expect(f.calls).toContain("restore-B"); expect(f.calls).toContain("restore-A");
  });
  it("does no sensor SET when durable capture fails", async () => {
    const f = fixture(); const runtime = new PilotRuntime({ holdSeconds: 10, monotonic: () => 0, port: f.port, journal: async () => { throw Error("fsync failed"); } });
    await expect(runtime.start()).rejects.toThrow(); expect(f.calls).not.toContain("sensor-A"); await runtime.stop();
  });
  it("stop cancels an in-flight B apply and uses independent recovery signal before closing", async () => {
    const f = fixture(); await f.runtime.start(); let enter!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    f.port.applyB = control => new Promise((_resolve, reject) => { enter(); control.signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true }); });
    f.port.restore = async (name, _original, control) => { expect(control.signal?.aborted).toBe(false); f.calls.push("restore-" + name); };
    const applying = f.runtime.pulse(f.pulse()); await entered; const stopping = f.runtime.stop(); await applying; await stopping;
    await f.runtime.pulse(f.pulse(2)); expect(f.calls.slice(-3)).toEqual(["restore-B", "restore-A", "close"]);
  });
  it("preserves pending when recovery fails and never retries automatically", async () => {
    const f = fixture(); await f.runtime.start(); await f.runtime.pulse(f.pulse());
    f.port.restore = async name => { f.calls.push("restore-" + name); if (name === "B") throw Error("unknown"); };
    await f.runtime.stop(); expect(f.states.at(-1)?.pending).toEqual(["B"]);
    expect(f.calls.filter(x => x === "restore-B")).toHaveLength(1);
  });
  it("uses monotonic trial end even if UTC steps", async () => {
    const f = fixture(); await f.runtime.start(); f.setNow(300000); await f.runtime.tick();
    expect(f.calls).toContain("restore-A"); expect(f.calls.at(-1)).toBe("close");
  });
  it("ends degraded trial on monotonic cap without automatic silence restore", async () => {
    const f = fixture(); await f.runtime.start(); await f.runtime.pulse(f.pulse()); f.runtime.fault();
    f.setNow(299999); await f.runtime.tick(); expect(f.calls).not.toContain("restore-B");
    f.setNow(300000); await f.runtime.tick(); expect(f.calls).toContain("restore-B"); expect(f.calls.at(-1)).toBe("close");
  });
  it("does not accept short exact duplicate even with advancing sequence", async () => {
    const f = fixture(); await f.runtime.start(); await f.runtime.pulse(f.pulse());
    f.setNow(100); await f.runtime.pulse(f.pulse(2)); expect(f.states.at(-1)?.deadlineMonotonicMs).toBe(10000);
  });
  it("cancellation while positive link GET waits cannot start normal restore", async () => {
    const f = fixture(); await f.runtime.start(); await f.runtime.pulse(f.pulse()); f.setNow(10000);
    let entered!: () => void, resolve!: (value: boolean) => void;
    const waiting = new Promise<void>(r => { entered = r; });
    f.port.link = () => new Promise(r => { resolve = r; entered(); });
    const expiry = f.runtime.tick(); await waiting; const stop = f.runtime.stop(); resolve(true); await expiry; await stop;
    expect(f.calls.filter(x => x === "restore-B")).toHaveLength(1);
  });
  it("default CLI and invalid opt-in return before constructing a USB session", async () => {
    await main([]); await expect(main(["--run"])).rejects.toThrow("PILOT_ARGUMENT");
    expect(parsePilotArgs(["--hold-seconds=1800"]).holdSeconds).toBe(1800);
    expect(() => parsePilotArgs(["--hold-seconds=9"])).toThrow();
    expect(() => parsePilotArgs(["--target=arbitrary"])).toThrow();
    // This path may be absent on the developer host; either result is mapping-only.
    await main(["--preflight"]).catch(() => {});
  });
  it("private append-only journal retains actual originals and refuses reuse", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "bio-event-pilot-")));
    const journal = await openPilotJournal(directory);
    await journal.write({ phase: "captured", originals: { A: { raw: 155, configuration: { configuredHighBrightnessPercent: 40, bioMode: "force-off" } }, B: { raw: 155, configuration: { configuredHighBrightnessPercent: 40, bioMode: "sensor" } } }, pending: ["A", "B"], occurrence: 1, deadlineMonotonicMs: 10000 });
    await journal.close();
    expect((await stat(join(directory, "pilot-journal.jsonl"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await readFile(join(directory, "pilot-journal.jsonl"), "utf8")).trim()).pending).toEqual(["A", "B"]);
    await expect(openPilotJournal(directory)).rejects.toThrow();
    await expect(openPilotJournal(join(directory, "missing"))).rejects.toThrow();
  });
});
