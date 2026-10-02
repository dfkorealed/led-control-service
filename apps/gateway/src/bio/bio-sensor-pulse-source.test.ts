import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BioDeviceMappingStore } from "./bio-device-mapping-store";
import { BioSensorPulseSource } from "./bio-sensor-pulse-source";
import type { BioPulseAuthorityProvider, BioPulseInput } from "./bio-sensor-pulse-source";
import type { BioSensorPulseCandidate } from "./bio-command-codec";
import type { BioTransportSnapshot } from "./bio-usb-transport";
import type { BioClientEvent } from "./bio-dongle-client";
import type { BioDeviceMapping } from "./bio-device-mapping-store";
import type { BioSourceAuthority } from "../automation/bio-pulse-scheduler";

const fixtureId = "11111111-1111-4111-8111-111111111111";
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function harness() {
  let candidateListener: ((candidate: BioSensorPulseCandidate) => void) | undefined;
  let stateListener: ((state: BioTransportSnapshot) => void) | undefined;
  let eventListener: ((event: BioClientEvent) => void) | undefined;
  let mappingListener: (() => void) | undefined;
  let authorityListener: (() => void) | undefined;
  let snapshot: BioTransportSnapshot = { state: "ready", generation: 1, ready: true, transportConnected: true, protocolReady: true };
  let mapping: BioDeviceMapping | null = { fixtureId, nodeId: "node", deviceUuid: "bio:001122334455",
    nativeUuid: "001122334455", logicalAddress: 256, firmware: "not-authority", protocol: "crc16",
    status: "confirmed", updatedAt: "2026-10-02T00:00:00Z" };
  let readMapping = async () => mapping && { ...mapping };
  let qualified = true;
  let revision = 1;
  let health: "healthy" | "unverified" = "healthy";
  let healthSince = 0;
  let providerThrows = false;
  const authority: BioPulseAuthorityProvider = {
    read: (_id, connection): BioSourceAuthority | null => {
      if (providerThrows) throw new Error("private provider failure");
      if (!qualified) return null;
      return { independentlyQualified: true, binding: { sourceFixtureId: fixtureId, nativeUuid: "001122334455",
        logicalAddress: 256, networkId: 7, capabilityRevision: revision, snapshotRevision: 1,
        profileId: "local-test-only", firmwareFingerprint: "fw", sensorFingerprint: "sensor" },
        connection: { ...connection }, observation: { health, reason: health === "healthy" ? "qualified" : "health_unverified",
          connectionEpoch: connection.epoch, connectionGeneration: connection.generation, healthySinceMonotonicMs: healthSince } };
    },
    onChange: listener => { authorityListener = listener; return () => { authorityListener = undefined; }; }
  };
  const profiles = [{ id: "local-test-only", firmwareFingerprint: "fw", sensorFingerprint: "sensor", bodyHex: "03" }];
  const client = {
    onSensorPulseCandidate: (listener: typeof candidateListener) => { candidateListener = listener; return () => { candidateListener = undefined; }; },
    onSensorSourceState: (listener: typeof stateListener) => { stateListener = listener; return () => { stateListener = undefined; }; },
    onEvent: (listener: typeof eventListener) => { eventListener = listener; return () => { eventListener = undefined; }; },
    sensorSourceSnapshot: () => ({ ...snapshot })
  };
  const mappings = { findByNativeUuid: async (_uuid: string) => readMapping(),
    findByFixtureId: async (_id: string) => readMapping(),
    onChange: (listener: () => void) => { mappingListener = listener; return () => { mappingListener = undefined; }; } };
  const source = new BioSensorPulseSource({ client, mappings, authority, profiles });
  const candidate: BioSensorPulseCandidate = { kind: "sensor-status-candidate", innerOpcode: 0x09, innerBody: Buffer.from([3]),
    receivedMonotonicMs: 123, generation: 1, deviceUuid: "bio:001122334455", logicalAddress: 256, networkId: 7,
    sequence: 22, destination: 0, rssiDbm: -45, ttl: 1, control: false };
  const pulses: BioPulseInput[] = [];
  const revocations: string[] = [];
  source.subscribe(pulse => pulses.push(pulse));
  source.onRevoked((_id, reason) => revocations.push(reason));
  return { source, client, mappings, authority, profiles, pulses, revocations, candidate,
    emit: () => candidateListener?.(candidate), event: (event: BioClientEvent) => eventListener?.(event),
    state: (patch: Partial<BioTransportSnapshot>) => { snapshot = { ...snapshot, ...patch }; stateListener?.(snapshot); },
    mappingChanged: () => mappingListener?.(), authorityChanged: () => authorityListener?.(),
    setMapping: (value: BioDeviceMapping | null) => { mapping = value; },
    deferMapping: () => { let resolve!: (value: BioDeviceMapping | null) => void;
      const pending = new Promise<BioDeviceMapping | null>(r => { resolve = r; });
      readMapping = () => pending; return () => resolve(mapping); },
    setQualified: (value: boolean) => { qualified = value; }, setRevision: (value: number) => { revision = value; },
    setHealth: (value: typeof health) => { health = value; }, setHealthSince: (value: number) => { healthSince = value; },
    providerThrows: () => { providerThrows = true; }
  };
}

describe("BioSensorPulseSource", () => {
  it("joins authenticated Fixture identity through real confirmed mappings, never through a different node UUID", async () => {
    const h = harness(); h.source.stop();
    const directory = await mkdtemp(join(tmpdir(), "bio-source-identity-"));
    const nodeId = "22222222-2222-4222-8222-222222222222";
    const mappings = new BioDeviceMappingStore(join(directory, "mapping.json"));
    await mappings.reserve({ fixtureId, nodeId, nativeUuid: "001122334455", deviceUuid: "bio:001122334455",
      logicalAddress: 256, observedLogicalAddressBeforeAssignment: 5, commandId: "software-identity-regression",
      firmware: "not-authority", protocol: "crc16" });
    await mappings.confirm("bio:001122334455", 256);
    // Only the explicit software fixture supplies qualification. A mapping/UUID alone
    // never grants health; the real production factory still has no such provider.
    const source = new BioSensorPulseSource({ client: h.client, mappings, authority: h.authority, profiles: h.profiles });
    const pulses: BioPulseInput[] = []; source.subscribe(pulse => pulses.push(pulse));
    try {
      expect((await source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 1 }, { requireHealthy: true }))?.binding.sourceFixtureId).toBe(fixtureId);
      expect(await source.preflight({ sourceFixtureId: nodeId, snapshotRevision: 1 }, { requireHealthy: true })).toBeNull();
      h.emit(); await vi.waitFor(() => expect(pulses).toHaveLength(1));
      expect(pulses[0].sourceFixtureId).toBe(fixtureId);
      expect(source.sourceAuthority(nodeId)).toBeNull();
    } finally { source.stop(); await rm(directory, { recursive: true, force: true }); }
  });
  it("preflights independent snapshot authority without any candidate and requires exact saved binding for unhealthy release", async () => {
    const h = harness();
    const request = { sourceFixtureId: fixtureId, snapshotRevision: 1 };
    const healthy = await h.source.preflight(request, { requireHealthy: true });
    expect(healthy?.binding).toMatchObject({ sourceFixtureId: fixtureId, logicalAddress: 256, snapshotRevision: 1 });
    expect(h.pulses).toEqual([]);
    h.setHealth("unverified"); h.authorityChanged();
    expect(await h.source.preflight(request, { requireHealthy: true })).toBeNull();
    expect(await h.source.preflight(request, { requireHealthy: false })).toBeNull();
    expect((await h.source.preflight(healthy!.binding, { requireHealthy: false }))?.observation.health).toBe("unverified");
    h.setQualified(false);
    expect(await h.source.preflight(healthy!.binding, { requireHealthy: false })).toBeNull();
  });

  it.each(["revision", "mapping", "generation", "stop"])("cancels snapshot preflight on %s change across an await", async kind => {
    const h = harness(); const release = h.deferMapping();
    const pending = h.source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 1 }, { requireHealthy: true });
    if (kind === "revision") h.setRevision(2);
    if (kind === "mapping") h.setMapping(null);
    if (kind === "generation") h.state({ generation: 2 });
    if (kind === "stop") h.source.stop();
    release(); expect(await pending).toBeNull(); expect(h.pulses).toEqual([]);
  });

  it("does not call a future monotonic healthy interval qualified snapshot health", async () => {
    const h = harness(); h.setHealthSince(Number.MAX_SAFE_INTEGER);
    expect(await h.source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 1 }, { requireHealthy: true })).toBeNull();
  });
  it("emits only qualified typed receipts and preserves the original receipt across asynchronous lookup", async () => {
    const h = harness(); const release = h.deferMapping(); h.emit();
    h.candidate.innerBody[0] = 1; h.candidate.receivedMonotonicMs = 999; release(); await flush();
    expect(h.pulses).toHaveLength(1);
    expect(h.pulses[0]).toMatchObject({ type: "pulse", sourceFixtureId: fixtureId, receivedMonotonicMs: 123,
      receipt: { nativeUuid: "001122334455", logicalAddress: 256, networkId: 7, sequence: 22, connectionGeneration: 1 } });
    expect(h.source.sourceAuthority(fixtureId)?.connection.epoch).toBe(h.pulses[0].receipt.connectionEpoch);
  });

  it.each(["qualification", "health", "health-interval", "identity", "body", "generation"])("rejects %s without synthesizing authority", async kind => {
    const h = harness();
    if (kind === "qualification") h.setQualified(false);
    if (kind === "health") h.setHealth("unverified");
    if (kind === "health-interval") h.setHealthSince(124);
    if (kind === "identity") h.candidate.logicalAddress++;
    if (kind === "body") h.candidate.innerBody[0] = 1;
    if (kind === "generation") h.candidate.generation++;
    h.emit(); await flush(); expect(h.pulses).toEqual([]); expect(h.source.sourceAuthority(fixtureId)).toBeNull();
  });

  it.each(["stop", "disconnect", "generation", "mapping", "profile", "decoder"])("revokes %s immediately and cancels queued candidates", async kind => {
    const h = harness(); h.emit(); await flush(); expect(h.pulses).toHaveLength(1);
    const release = h.deferMapping(); h.emit();
    if (kind === "stop") h.source.stop();
    if (kind === "disconnect") h.state({ ready: false, protocolReady: false, transportConnected: false });
    if (kind === "generation") h.state({ generation: 2 });
    if (kind === "mapping") h.mappingChanged();
    if (kind === "profile") h.authorityChanged();
    if (kind === "decoder") h.event({ kind: "invalid-notification" });
    expect(h.source.sourceAuthority(fixtureId)).toBeNull();
    release(); await flush(); expect(h.pulses).toHaveLength(1); expect(h.revocations).toHaveLength(1);
  });

  it("rechecks silent revision and health changes after an await", async () => {
    const h = harness(); let reads = 0; let resolve!: () => void;
    const original = h.mappings.findByNativeUuid;
    h.mappings.findByNativeUuid = async uuid => { const value = await original(uuid);
      if (++reads === 2) await new Promise<void>(r => { resolve = r; }); return value; };
    h.emit(); await flush(); h.setRevision(2); resolve(); await flush();
    expect(h.pulses).toEqual([]);
    h.emit(); await flush(); expect(h.pulses).toHaveLength(1);
    h.setHealth("unverified"); expect(h.source.sourceAuthority(fixtureId)).toBeNull();
  });

  it("isolates provider and subscriber exceptions, clones output, and honors unsubscribe/stop", async () => {
    const h = harness(); h.source.subscribe(() => { throw new Error("observer failed"); });
    h.source.subscribe(pulse => { pulse.receipt.sequence = 999; });
    const received: BioPulseInput[] = []; const unsubscribe = h.source.subscribe(pulse => received.push(pulse));
    h.emit(); await flush(); expect(received[0].receipt.sequence).toBe(22);
    const authority = h.source.sourceAuthority(fixtureId)!; authority.binding.logicalAddress = 999;
    expect(h.source.sourceAuthority(fixtureId)!.binding.logicalAddress).toBe(256);
    unsubscribe(); h.providerThrows(); h.emit(); await flush(); expect(received).toHaveLength(1);
    expect(h.source.sourceAuthority(fixtureId)).toBeNull(); h.source.stop(); h.emit(); await flush();
    expect(h.pulses).toHaveLength(1);
  });

  it("defaults OFF even when the provider qualifies, and owns copied immutable profile values", async () => {
    const h = harness();
    h.source.stop();
    const productionDefaults = new BioSensorPulseSource({ client: h.client, mappings: h.mappings, authority: h.authority });
    productionDefaults.subscribe(pulse => h.pulses.push(pulse)); h.emit(); await flush();
    expect(h.pulses).toEqual([]); productionDefaults.stop();
    const local = harness(); local.profiles[0].bodyHex = "01"; local.emit(); await flush();
    expect(local.pulses).toHaveLength(1);
  });

  it("does not emit if the provider stops the source during a synchronous recheck", async () => {
    const h = harness(); const original = h.authority.read; let calls = 0;
    h.authority.read = (id, connection) => { const value = original(id, connection);
      if (++calls === 3) h.source.stop(); return value; };
    h.emit(); await flush(); expect(h.pulses).toEqual([]);
  });

  it("detects mutable mapping references changed during the second lookup", async () => {
    const h = harness(); const original = h.mappings.findByNativeUuid;
    const row = await original("001122334455"); let reads = 0;
    h.mappings.findByNativeUuid = async () => { if (++reads === 2) row!.updatedAt = "2026-10-02T00:00:01Z"; return row; };
    h.emit(); await flush(); expect(h.pulses).toEqual([]);
  });

  it.each(["deleted", "address", "identity", "fixture", "reserved", "lookup-error"])("revokes a known source after first lookup finds %s, including queued output", async kind => {
    const h = harness(); h.emit(); await flush(); expect(h.pulses).toHaveLength(1);
    const original = h.mappings.findByNativeUuid;
    const mapping = (await original("001122334455"))!;
    let release!: (value: typeof mapping) => void;
    const pending = new Promise<typeof mapping>(resolve => { release = resolve; });
    let queued = true;
    h.mappings.findByNativeUuid = async () => {
      if (queued) { queued = false; return pending; }
      if (kind === "lookup-error") throw new Error("unreadable mapping");
      if (kind === "deleted") return null;
      if (kind === "address") return { ...mapping, logicalAddress: 257 };
      if (kind === "identity") return { ...mapping, nativeUuid: "112233445566", deviceUuid: "bio:112233445566" };
      if (kind === "fixture") return { ...mapping, fixtureId: "22222222-2222-4222-8222-222222222222" };
      return { ...mapping, status: "reserved" };
    };
    h.emit(); h.emit(); await flush();
    expect(h.source.sourceAuthority(fixtureId)).toBeNull(); expect(h.revocations).toHaveLength(1);
    release(mapping); await flush(); expect(h.pulses).toHaveLength(1);
  });

  it.each(["missing", "lookup-error", "wrong-packet-address"])("does not revoke a valid authority for an unrelated/rejected candidate: %s", async kind => {
    const h = harness(); h.emit(); await flush();
    if (kind === "wrong-packet-address") h.candidate.logicalAddress = 257;
    else {
      h.candidate.deviceUuid = "bio:112233445566";
      const original = h.mappings.findByNativeUuid;
      h.mappings.findByNativeUuid = async uuid => {
        if (uuid === "112233445566") {
          if (kind === "lookup-error") throw new Error("unknown sensor lookup failure");
          return null;
        }
        return original(uuid);
      };
    }
    h.emit(); await flush(); expect(h.pulses).toHaveLength(1); expect(h.revocations).toEqual([]);
    expect(h.source.sourceAuthority(fixtureId)).not.toBeNull();
  });
});
