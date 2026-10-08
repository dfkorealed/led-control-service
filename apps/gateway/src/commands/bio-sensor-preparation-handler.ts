import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bioSensorPreparationCommandV1Schema, bioSensorPreparationReportV1Schema, bioSensorPreparationAckV1Schema,
  bioSensorPreparationTopics, bioProfileKey, type BioSensorPreparationCommandV1, type BioSensorPreparationReportV1 } from "@led-control/shared";
import type { BioDongleClient } from "../bio/bio-dongle-client";
import type { BioDeviceMapping, BioDeviceMappingStore } from "../bio/bio-device-mapping-store";
import { approvedBioProfile, bioEnvelopeHash, type BioPulseCatalogPort, type BioSensorScope } from "../bio/bio-sensor-profile-catalog";
import { CommandJournal } from "./command-journal";

export interface BioSensorCommission {
  command: BioSensorPreparationCommandV1;
  report: BioSensorPreparationReportV1;
  mapping: BioDeviceMapping;
  networkId: number;
}
export function matchesPreparationMapping(mapping: BioDeviceMapping, command: BioSensorPreparationCommandV1) {
  return mapping.status === "confirmed" && mapping.fixtureId === command.fixtureId && mapping.deviceUuid === `bio:${mapping.nativeUuid}`
    && mapping.logicalAddress === parseInt(command.meshAddress.slice(2), 16)
    && createHash("sha256").update(mapping.deviceUuid).digest("hex") === command.deviceIdentityHash;
}
interface Options {
  scope: BioSensorScope; catalog: BioPulseCatalogPort; mappings: BioDeviceMappingStore; client: BioDongleClient; journal: CommandJournal;
  clockTrusted(): Promise<boolean>; onCommission?(commission: BioSensorCommission): void; onInvalidate?(fixtureId: string): void;
}
export class BioSensorPreparationHandler {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, BioSensorCommission>();
  private readonly accepted = new Set<string>();
  private readonly abort = new AbortController();
  private readonly releases: (() => void)[];
  private publish?: (topic: string, payload: unknown) => Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private flushTask?: Promise<void>;
  private revision = 0;
  constructor(private readonly options: Options) {
    const invalidate = () => this.invalidate();
    this.releases = [options.catalog.onChange(invalidate), options.mappings.onChange(invalidate), options.client.onSensorSourceState(invalidate),
      options.client.onEvent(event => { if (event.kind === "invalid-notification") invalidate(); })];
  }
  handle(raw: unknown, onDurableReceipt?: () => void): Promise<BioSensorPreparationReportV1> {
    const command = bioSensorPreparationCommandV1Schema.parse(raw);
    if (command.siteId !== this.options.scope.siteId || command.gatewayId !== this.options.scope.gatewayId
      || command.assignmentVersion !== this.options.scope.assignmentVersion) return Promise.reject(new Error("BIO_PREPARATION_SCOPE"));
    const run = this.queue.then(() => this.execute(command, onDurableReceipt)); this.queue = run.catch(() => undefined); return run;
  }
  private async execute(command: BioSensorPreparationCommandV1, onDurableReceipt?: () => void): Promise<BioSensorPreparationReportV1> {
    const { journal, client, catalog, mappings } = this.options;
    const wrapper = { kind: "bio_sensor_preparation", command }, previous = await journal.get(command.commandId);
    if (previous && !isDeepStrictEqual(previous.command, wrapper)) throw new Error("BIO_PREPARATION_CONFLICT");
    if (previous?.state === "completed") { onDurableReceipt?.(); void this.wake(); return bioSensorPreparationReportV1Schema.parse(previous.result); }
    this.active.delete(command.fixtureId); this.options.onInvalidate?.(command.fixtureId);
    if (!previous) await journal.accept(command.commandId, wrapper);
    onDurableReceipt?.();
    const start = client.sensorSourceSnapshot(), currentCatalog = catalog.snapshot(), revision = this.revision;
    const controller = new AbortController(), stop = () => controller.abort(); this.abort.signal.addEventListener("abort", stop);
    const timer = setTimeout(stop, Math.max(1, Date.parse(command.expiresAt) - Date.now()));
    let fingerprint: BioSensorPreparationReportV1["fingerprint"] = null, profileKey: string | null = null;
    let status: BioSensorPreparationReportV1["status"] = "unverified", errorCode: string | null = "BIO_PREPARATION_UNVERIFIED";
    let commission: Omit<BioSensorCommission, "report"> | undefined;
    const current = () => revision === this.revision && !controller.signal.aborted && !this.abort.signal.aborted && Date.now() < Date.parse(command.expiresAt)
      && client.sensorSourceSnapshot().generation === start.generation && client.sensorSourceSnapshot().ready
      && isDeepStrictEqual(currentCatalog, catalog.snapshot());
    try {
      if (previous || Date.now() < Date.parse(command.requestedAt) || !current() || !await this.options.clockTrusted()
        || currentCatalog?.catalogRevision !== command.catalogRevision) throw new Error("unverified");
      const mapping = await mappings.findByFixtureId(command.fixtureId);
      if (!mapping || !matchesPreparationMapping(mapping, command)) throw new Error("identity");
      const guard = async () => {
        if (!current() || !isDeepStrictEqual(mapping, await mappings.findByFixtureId(command.fixtureId)) || !current()) throw new Error("changed");
      };
      const control = { signal: controller.signal, deadlineAt: Date.parse(command.expiresAt), beforeWrite: guard, mayStartWrite: current };
      const observations = await client.scanObservations(control); await guard();
      const exact = observations.filter(d => d.nativeUuid === mapping.nativeUuid && d.logicalAddress === mapping.logicalAddress);
      const device = exact[0];
      if (!device || observations.some(d => d.nativeUuid === mapping.nativeUuid && (d.logicalAddress !== mapping.logicalAddress || !isDeepStrictEqual(d.fingerprint, device.fingerprint))
        || d.nativeUuid !== mapping.nativeUuid && d.logicalAddress === mapping.logicalAddress)
        || exact.some(d => d.networkId !== device.networkId)) throw new Error("ambiguous_discovery");
      fingerprint = device.fingerprint ?? null;
      const profile = approvedBioProfile(currentCatalog, fingerprint);
      // Missing/ambiguous approval does not establish that the device is unsupported.
      if (!profile) { status = "unverified"; errorCode = "BIO_PROFILE_UNVERIFIED"; }
      else {
        profileKey = bioProfileKey(profile); await guard();
        if (command.operation === "ensure_sensor") await client.restoreSensorMode(device, control);
        await guard();
        const mode = await client.readDeviceInfo({ kind: "unicast", nativeUuid: mapping.nativeUuid, logicalAddress: mapping.logicalAddress, networkId: device.networkId }, control);
        await guard();
        if (mode.deviceUuid !== device.deviceUuid || mode.logicalAddress !== device.logicalAddress || mode.networkId !== device.networkId) throw new Error("wrong_get");
        status = mode.mode === "sensor" ? "ready" : "needs_setup"; errorCode = status === "ready" ? null : "BIO_SENSOR_MODE_REQUIRED";
        commission = { command, mapping, networkId: device.networkId };
      }
    } catch { status = "unverified"; errorCode = previous ? "GATEWAY_RESTART" : "BIO_PREPARATION_UNVERIFIED"; }
    finally { clearTimeout(timer); this.abort.signal.removeEventListener("abort", stop); controller.abort(); }
    const { requestedAt: _requestedAt, expiresAt: _expiresAt, ...identity } = command;
    const report = bioSensorPreparationReportV1Schema.parse({ ...identity, eventId: randomUUID(), commandPayloadHash: bioEnvelopeHash(command),
      fingerprint, profileKey, connectionGeneration: Math.max(1, start.generation), observedAt: new Date().toISOString(), status,
      modeVerified: status === "ready", linkVerified: status === "ready", errorCode });
    await journal.complete(command.commandId, report);
    if (status === "ready" && commission && revision === this.revision && !this.abort.signal.aborted && client.sensorSourceSnapshot().generation === start.generation
      && isDeepStrictEqual(currentCatalog, catalog.snapshot())) this.active.set(command.fixtureId, { ...commission, report });
    void this.wake(); return report;
  }
  async acknowledge(raw: unknown) {
    const ack = bioSensorPreparationAckV1Schema.parse(raw);
    if (!await this.options.journal.acknowledgeBioSensorPreparation(ack)) return false;
    const entry = this.active.get(ack.fixtureId);
    if (entry && entry.report.eventId === ack.eventId && (ack.status === "applied" || ack.status === "duplicate") && !this.accepted.has(ack.eventId)) {
      // TTL bounded the first result only. ACK acceptance plus current local binding
      // establishes commission; independent GETs own all subsequent health.
      if (this.options.client.sensorSourceSnapshot().generation !== entry.report.connectionGeneration
        || !isDeepStrictEqual(entry.mapping, await this.options.mappings.findByFixtureId(ack.fixtureId))
        || this.options.catalog.snapshot()?.catalogRevision !== entry.command.catalogRevision
        || this.active.get(ack.fixtureId) !== entry || this.options.client.sensorSourceSnapshot().generation !== entry.report.connectionGeneration) return true;
      this.accepted.add(ack.eventId); this.options.onCommission?.(structuredClone(entry));
    }
    return true;
  }
  async connect(publish: (topic: string, payload: unknown) => Promise<void>) {
    this.publish = publish;
    if (!this.timer) { this.timer = setInterval(() => { void this.wake(); }, 2000); this.timer.unref(); }
    for (const record of await this.options.journal.pendingBioSensorPreparations()) {
      if (record.state === "accepted") await this.handle((record.command as { command: unknown }).command);
    }
    await this.wake();
  }
  disconnect() { this.publish = undefined; clearInterval(this.timer); this.timer = undefined; this.invalidate(); }
  private invalidate() { this.revision++; for (const id of this.active.keys()) this.options.onInvalidate?.(id); this.active.clear(); this.accepted.clear(); }
  wake(): Promise<void> {
    if (!this.publish) return Promise.resolve();
    if (this.flushTask) return this.flushTask;
    this.flushTask = (async () => { for (const record of await this.options.journal.pendingBioSensorPreparations()) {
      if (!this.publish) break;
      if (record.state === "completed") await this.publish(bioSensorPreparationTopics.result(this.options.scope.siteId, this.options.scope.gatewayId), record.result);
    } })().catch(() => undefined).finally(() => { this.flushTask = undefined; }); return this.flushTask;
  }
  async stopAndDrain() { this.abort.abort(); this.disconnect(); for (const stop of this.releases) stop(); await this.queue; await this.flushTask; }
}
