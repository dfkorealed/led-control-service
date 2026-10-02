import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bioSensorModeCommandSchema, vehicleSensorCapabilityDeliveryV2Schema, vehicleSensorCapabilityIngestedAckV2Schema,
  matchesVehicleSensorCapabilityIngestedAckV2, type BioSensorModeCommand, type VehicleSensorCapabilityDeliveryV2,
  type VehicleSensorCapabilityIngestedAckV2 } from "@led-control/shared";
import { readJsonFile, writeJsonAtomic, AtomicJsonCommitUncertainError } from "../mesh/mesh-store-file";
import { VehicleSensorCapabilityPublisher } from "../mesh/vehicle-sensor-capability";
import type { BioDeviceMapping } from "./bio-device-mapping-store";

export interface BioCapabilityIdentityPort {
  findByFixtureId(fixtureId: string): Promise<BioDeviceMapping | null>;
  snapshot(): { generation: number; ready: boolean; transportConnected: boolean; protocolReady: boolean };
  onChange?(listener: () => void): () => void;
}
type Scope = { siteId: string; gatewayId: string; assignmentVersion: number };
type MappingIdentity = Pick<BioDeviceMapping, "fixtureId" | "nativeUuid" | "deviceUuid" | "logicalAddress">;
interface IdentityProof { command: BioSensorModeCommand; mapping: MappingIdentity; connectionEpoch: string; generation: number; recordedAt: string }
interface DeliveryRecord { delivery: VehicleSensorCapabilityDeliveryV2; deliveryPayloadHash: `sha256:${string}`;
  proof: IdentityProof; receipt: VehicleSensorCapabilityIngestedAckV2 | null }
interface State { version: 1; scope: { siteId: string; gatewayId: string }; records: DeliveryRecord[] }
interface Options { scope(): Scope; identity: BioCapabilityIdentityPort; clockTrusted(): Promise<boolean>; now?: () => Date; onError?: (error: unknown) => void }
const maxRecords = 10_000;

/** Node attribution is independent of sensor qualification. This production owner
 * reports OFF only; receiving a command, candidate or mode result cannot grant health. */
export class BioCapabilityDeliveryController {
  private readonly epoch = randomUUID();
  private readonly now: () => Date;
  private state: State;
  private initialized = false;
  private fenced = false;
  private stopped = false;
  private connectionRevision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly publisher: VehicleSensorCapabilityPublisher<VehicleSensorCapabilityDeliveryV2>;
  private readonly publishPermits = new Map<string, { proof: IdentityProof; revision: number }>();
  private readonly stopMappingIntake?: () => void;

  constructor(private readonly path: string, private readonly options: Options) {
    const { siteId, gatewayId } = options.scope();
    this.state = { version: 1, scope: { siteId, gatewayId }, records: [] };
    this.now = options.now ?? (() => new Date());
    this.stopMappingIntake = options.identity.onChange?.(() => {
      this.connectionRevision++; this.publishPermits.clear();
    });
    this.publisher = new VehicleSensorCapabilityPublisher({
      pending: async () => (await this.pending()).map(record => ({ report: record.delivery })),
      acknowledge: value => this.recordAcknowledgement(value)
    }, this.state.scope, { onError: options.onError, beforePublish: async delivery => {
      const record = (await this.pending()).find(row => row.delivery.report.eventId === delivery.report.eventId);
      const revision = this.connectionRevision;
      if (!record || !this.isCurrentRecord(record.delivery) || !await this.validateProof(record.proof)) return false;
      this.publishPermits.set(delivery.report.eventId, { proof: record.proof, revision });
      return true;
    }, mayPublish: delivery => {
      const permit = this.publishPermits.get(delivery.report.eventId);
      return !!permit && this.isCurrentRecord(delivery) && this.current(permit.proof, permit.revision);
    } });
  }

  initialize(): Promise<void> { return this.exclusive(() => this.load()); }
  async connect(publish: (topic: string, payload: VehicleSensorCapabilityDeliveryV2) => Promise<void>) {
    if (this.stopped) return;
    await this.publisher.connect(publish);
  }
  disconnect() { this.connectionRevision++; this.publishPermits.clear(); this.publisher.disconnect(); }
  wake() { return this.stopped ? Promise.resolve() : this.publisher.wake(); }
  async stopAndDrain() {
    this.stopped = true; this.disconnect();
    try { this.stopMappingIntake?.(); } catch { /* Observer release cannot restore publication authority. */ }
    await Promise.all([this.publisher.stopAndDrain(), this.queue]);
  }
  pending(): Promise<DeliveryRecord[]> { return this.exclusive(async () => {
    await this.load(); this.requireAvailable(); return structuredClone(this.state.records.filter(row => !row.receipt));
  }); }

  recordIdentityProof(raw: BioSensorModeCommand): Promise<void> { return this.exclusive(async () => {
    await this.load(); this.requireAvailable();
    const command = bioSensorModeCommandSchema.parse(structuredClone(raw));
    const generation = this.options.identity.snapshot().generation;
    const proof: IdentityProof = { command, mapping: { fixtureId: command.fixtureId, nativeUuid: "", deviceUuid: "", logicalAddress: parseInt(command.meshAddress.slice(2), 16) },
      connectionEpoch: this.epoch, generation, recordedAt: this.now().toISOString() };
    const mapping = await this.options.identity.findByFixtureId(command.fixtureId);
    if (!mapping || !this.mappingMatchesCommand(mapping, command)) return;
    proof.mapping = mappingIdentity(mapping);
    if (!await this.validateProof(proof)) return;
    const next = structuredClone(this.state);
    const historical = next.records.find(row => row.delivery.report.meshNodeId === command.nodeId
      && row.delivery.assignmentVersion === command.assignmentVersion && sameIdentity(row.proof, proof));
    if (historical && !this.isCurrentRecord(historical.delivery)) {
      const related = next.records.filter(row => row.delivery.assignmentVersion === command.assignmentVersion
        && (row.delivery.report.meshNodeId === command.nodeId || row.proof.mapping.fixtureId === proof.mapping.fixtureId
          || row.proof.mapping.nativeUuid === proof.mapping.nativeUuid));
      // Exact redelivery (or an older proof retained after reproof) cannot revive a
      // superseded relation. A genuinely later authenticated command may establish
      // a new binding, but must mint its own revision rather than refresh the old row.
      if (historical.proof.command.commandId === command.commandId
        || Date.parse(command.requestedAt) <= Math.max(...related.map(row => Date.parse(row.proof.command.requestedAt)))) return;
    }
    const same = [...next.records].reverse().find(row => row.delivery.report.meshNodeId === command.nodeId
      && row.delivery.assignmentVersion === command.assignmentVersion);
    if (same && this.isCurrentRecord(same.delivery) && sameIdentity(same.proof, proof)) {
      // Reproof refreshes attribution only. Never remint an event/revision, reset a
      // rejected receipt or mutate an already hashed delivery on restart/redelivery.
      same.proof = proof;
    } else {
      if (next.records.length >= maxRecords) throw new Error("bio_capability_capacity");
      const revision = Math.max(0, ...next.records.filter(row => row.delivery.report.meshNodeId === command.nodeId)
        .map(row => row.delivery.report.capabilityRevision)) + 1;
      const delivery = vehicleSensorCapabilityDeliveryV2Schema.parse({ schemaVersion: 2, assignmentVersion: command.assignmentVersion,
        report: { schemaVersion: 2, eventId: randomUUID(), siteId: command.siteId, gatewayId: command.gatewayId,
          meshNodeId: command.nodeId, capabilityRevision: revision, sensorProtocol: "bio-usb-pulse", readiness: "off",
          verifiedFingerprintId: null, sensorModeVerifiedAt: null, verifiedAt: proof.recordedAt } });
      next.records.push({ delivery, deliveryPayloadHash: canonicalHash(delivery), proof, receipt: null });
    }
    // Proof is not 30-second RF permission. It only allows metadata publication;
    // a fsync that outlives it leaves a durable record which cannot be sent.
    await this.commit(next);
  }); }

  acknowledge(raw: unknown) { return this.publisher.acknowledge(raw); }
  private recordAcknowledgement(raw: unknown): Promise<"ignored" | "terminal" | "rejected"> { return this.exclusive(async () => {
    await this.load(); this.requireAvailable();
    const ack = vehicleSensorCapabilityIngestedAckV2Schema.parse(raw) as VehicleSensorCapabilityIngestedAckV2;
    const row = this.state.records.find(record => matchesVehicleSensorCapabilityIngestedAckV2(record.delivery, ack, record.deliveryPayloadHash));
    if (!row || !this.isCurrentRecord(row.delivery) || !await this.validateProof(row.proof)) return "ignored";
    if (row.receipt) return isDeepStrictEqual(row.receipt, ack) ? (ack.status === "rejected" ? "rejected" : "terminal") : "ignored";
    const next = structuredClone(this.state); next.records[this.state.records.indexOf(row)]!.receipt = ack;
    await this.commit(next);
    return ack.status === "rejected" ? "rejected" : "terminal";
  }); }

  private mappingMatchesCommand(mapping: BioDeviceMapping, command: BioSensorModeCommand) {
    return mapping.status === "confirmed" && mapping.fixtureId === command.fixtureId
      && mapping.logicalAddress === parseInt(command.meshAddress.slice(2), 16)
      && mapping.deviceUuid === `bio:${mapping.nativeUuid}` && /^[0-9a-f]{12}$/.test(mapping.nativeUuid)
      && createHash("sha256").update(mapping.deviceUuid).digest("hex") === command.deviceIdentityHash;
  }
  private isCurrentRecord(delivery: VehicleSensorCapabilityDeliveryV2) {
    // A newer authenticated binding supersedes transmission authority, not the
    // older pending audit record. Never rewrite/delete old uncertain delivery.
    const latest = [...this.state.records].reverse().find(row => row.delivery.report.meshNodeId === delivery.report.meshNodeId
      && row.delivery.assignmentVersion === delivery.assignmentVersion);
    if (latest?.delivery.report.eventId !== delivery.report.eventId) return false;
    const latestSource = [...this.state.records].reverse().find(row => row.delivery.assignmentVersion === delivery.assignmentVersion
      && (row.proof.mapping.fixtureId === latest.proof.mapping.fixtureId || row.proof.mapping.nativeUuid === latest.proof.mapping.nativeUuid));
    return latestSource?.delivery.report.eventId === delivery.report.eventId;
  }
  private current(proof: IdentityProof, revision: number): boolean {
    const scope = this.options.scope(), state = this.options.identity.snapshot(), time = this.now().getTime();
    return !this.stopped && !this.fenced && this.connectionRevision === revision && proof.connectionEpoch === this.epoch
      && state.ready && state.protocolReady && state.transportConnected && state.generation === proof.generation
      && scope.siteId === this.state.scope.siteId && scope.gatewayId === this.state.scope.gatewayId
      && scope.siteId === proof.command.siteId && scope.gatewayId === proof.command.gatewayId
      && scope.assignmentVersion === proof.command.assignmentVersion && time >= Date.parse(proof.command.requestedAt)
      && time < Date.parse(proof.command.expiresAt);
  }
  private async validateProof(proof: IdentityProof): Promise<boolean> {
    const revision = this.connectionRevision;
    try {
      if (!this.current(proof, revision) || !await this.options.clockTrusted() || !this.current(proof, revision)) return false;
      const first = await this.options.identity.findByFixtureId(proof.command.fixtureId);
      if (!this.current(proof, revision) || !first || !this.mappingMatchesCommand(first, proof.command)
        || !isDeepStrictEqual(mappingIdentity(first), proof.mapping)) return false;
      const second = await this.options.identity.findByFixtureId(proof.command.fixtureId);
      return this.current(proof, revision) && !!second && this.mappingMatchesCommand(second, proof.command)
        && isDeepStrictEqual(first, second) && isDeepStrictEqual(mappingIdentity(second), proof.mapping);
    } catch { return false; }
  }
  private async load() {
    if (this.initialized) return;
    const manifest = await readJsonFile(`${this.path}.manifest`, { maxBytes: 4096 });
    const stored = await readJsonFile(this.path, { maxBytes: 16 * 1024 * 1024 });
    if (manifest === null && stored === null) {
      await writeJsonAtomic(`${this.path}.manifest`, { version: 1, scope: this.state.scope });
      await writeJsonAtomic(this.path, this.state);
    } else {
      if (!isDeepStrictEqual(manifest, { version: 1, scope: this.state.scope })) throw new Error("bio_capability_scope_mismatch");
      this.state = this.parse(stored);
    }
    this.initialized = true;
  }
  private parse(value: unknown): State {
    if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "records,scope,version") throw new Error("bio_capability_journal_invalid");
    const state = value as State;
    if (state.version !== 1 || !isDeepStrictEqual(state.scope, this.state.scope) || !Array.isArray(state.records) || state.records.length > maxRecords) throw new Error("bio_capability_journal_invalid");
    const events = new Set<string>();
    for (const row of state.records) {
      if (!row || Object.keys(row).sort().join() !== "delivery,deliveryPayloadHash,proof,receipt") throw new Error("bio_capability_journal_invalid");
      const delivery = vehicleSensorCapabilityDeliveryV2Schema.parse(row.delivery);
      const command = bioSensorModeCommandSchema.parse(row.proof.command);
      if (Object.keys(row.proof).sort().join() !== "command,connectionEpoch,generation,mapping,recordedAt"
        || Object.keys(row.proof.mapping).sort().join() !== "deviceUuid,fixtureId,logicalAddress,nativeUuid"
        || !Number.isSafeInteger(row.proof.generation) || row.proof.generation < 1 || typeof row.proof.connectionEpoch !== "string"
        || !Number.isFinite(Date.parse(row.proof.recordedAt)) || delivery.report.siteId !== this.state.scope.siteId
        || delivery.report.gatewayId !== this.state.scope.gatewayId || delivery.report.meshNodeId !== command.nodeId
        || delivery.assignmentVersion !== command.assignmentVersion || command.siteId !== this.state.scope.siteId
        || command.gatewayId !== this.state.scope.gatewayId || delivery.report.readiness !== "off"
        || delivery.report.verifiedFingerprintId !== null || delivery.report.sensorModeVerifiedAt !== null
        || row.deliveryPayloadHash !== canonicalHash(delivery) || events.has(delivery.report.eventId)
        || !this.mappingMatchesCommand({ ...row.proof.mapping, status: "confirmed" } as BioDeviceMapping, command)) throw new Error("bio_capability_journal_invalid");
      if (row.receipt && !matchesVehicleSensorCapabilityIngestedAckV2(delivery, row.receipt, row.deliveryPayloadHash)) throw new Error("bio_capability_receipt_invalid");
      events.add(delivery.report.eventId);
    }
    return structuredClone(state);
  }
  private async commit(next: State) {
    try { await writeJsonAtomic(this.path, next); } catch (error) {
      if (!(error instanceof AtomicJsonCommitUncertainError)) throw error;
      try {
        const visible = this.parse(await readJsonFile(this.path, { maxBytes: 16 * 1024 * 1024 }));
        if (isDeepStrictEqual(visible, next)) { this.state = next; return; }
        if (!isDeepStrictEqual(visible, this.state)) this.fenced = true;
      } catch { this.fenced = true; }
      throw new Error("bio_capability_commit_uncertain");
    }
    this.state = next;
  }
  private requireAvailable() { if (this.fenced) throw new Error("bio_capability_fenced"); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> { const run = this.queue.then(work); this.queue = run.catch(() => undefined); return run; }
}
function mappingIdentity(mapping: BioDeviceMapping): MappingIdentity {
  return { fixtureId: mapping.fixtureId, nativeUuid: mapping.nativeUuid, deviceUuid: mapping.deviceUuid, logicalAddress: mapping.logicalAddress };
}
function sameIdentity(a: IdentityProof, b: IdentityProof) {
  return a.command.nodeId === b.command.nodeId && a.command.assignmentVersion === b.command.assignmentVersion && isDeepStrictEqual(a.mapping, b.mapping);
}
function canonicalHash(value: unknown): `sha256:${string}` {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : input;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
