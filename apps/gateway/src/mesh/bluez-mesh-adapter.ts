import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  mapHealthFaults,
  type IdentifyDevicePayload,
  type MeshGroupSubscriptionResultPayload,
  type MeshGroupSubscriptionSyncPayload,
  type ProvisionDevicePayload,
  type ProvisioningCompletedPayload,
  type ProvisioningScanStartPayload,
  type ProvisioningScanFoundDevice
} from "@led-control/shared";
import type { BleMeshAdapter, BleMeshCommandReport, BleMeshFixtureStatus, BleMeshResyncReport, ProvisioningAdapter, ProvisioningScannerAdapter } from "../gateway";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import type { BluezConfigClient } from "./bluez-config-client";
import {
  decodeGenericOnOffStatus,
  decodeHealthStatus,
  decodeLightnessStatus,
  encodeLightnessSet,
  encodeLightnessSetUnacknowledged,
  lightnessToPercent,
  percentToLightness
} from "./bluez-model-codec";
import { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

const BLUEZ_SERVICE = "org.bluez.mesh";
const NODE_INTERFACE = "org.bluez.mesh.Node1";
const HEALTH_COMPANY_ID = 0x02e5;
const GENERIC_ONOFF_GET = Uint8Array.from([0x82, 0x01]);
const LIGHT_LIGHTNESS_GET = Uint8Array.from([0x82, 0x4b]);
const HEALTH_FAULT_GET = Uint8Array.from([0x80, 0x31, HEALTH_COMPANY_ID & 0xff, HEALTH_COMPANY_ID >> 8]);

interface AdapterTransport {
  call(service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<unknown>;
}

interface AdapterProvisioner {
  nodePath: string | null;
  start(): Promise<void>;
  scan(seconds: number): Promise<Array<{ deviceUuid: string; rssi: number; oobCapability: ProvisioningScanFoundDevice["oobCapability"] }>>;
  provision(input: { nodeId: string; deviceUuid: string; meshAddress: string }): Promise<{ primaryUnicast: number; elementCount: number }>;
}

interface AdapterAddressStore {
  findByFixtureId(fixtureId: string): Promise<{ primaryUnicast: number; status: "reserved" | "confirmed" } | null>;
  findByPrimaryUnicast(primaryUnicast: number): Promise<{ fixtureId: string; primaryUnicast: number; elementCount: number; status: "reserved" | "confirmed" } | null>;
  listConfirmed(): Promise<Array<{ fixtureId: string; primaryUnicast: number; elementCount: number; status: "confirmed" }>>;
}

interface TransactionStore {
  next(destination: number): Promise<number>;
  nextMany(destinations: number[]): Promise<number[]>;
}

interface ConfigClient {
  configureNode(input: { unicast: number; elementCount: number }): Promise<unknown>;
  addModelSubscription(input: { unicast: number; groupAddress: number; modelId?: number }): Promise<unknown>;
  removeModelSubscription(input: { unicast: number; groupAddress: number; modelId?: number }): Promise<unknown>;
}

export type FixtureMeshStatus = BleMeshFixtureStatus;

export class BluezMeshAdapter implements BleMeshAdapter, ProvisioningScannerAdapter, ProvisioningAdapter {
  private readonly responseTimeoutMs: number;
  private readonly scanSeconds: number;
  private readonly resyncConcurrency: number;
  private readonly resyncRetryMs: number;
  private readonly resyncSendAttempts: number;
  private readonly observationCoherenceMs: number;
  private readonly now: () => number;
  private readonly fixtureStatuses = new Set<(status: FixtureMeshStatus) => void>();
  private readonly fixtureLightingPairs = new Set<(fixtureId: string, generation: number) => void>();
  private readonly resyncReportListeners = new Set<(report: BleMeshResyncReport) => void>();
  private readonly latestObservations = new Map<string, FixtureObservation>();
  private readonly healthPendingFixtures = new Set<string>();
  private nextObservationGeneration = 0;
  private resyncInFlight: Promise<BleMeshResyncReport> | undefined;
  private lastResyncReport: BleMeshResyncReport | undefined;
  private readonly commandSources = new KeyedSerialTaskQueue();
  private readonly appliedGroupMembers = new Map<string, Map<string, string>>();

  constructor(
    private readonly transport: AdapterTransport,
    private readonly application: EventEmitter,
    private readonly provisioner: AdapterProvisioner,
    private readonly addressStore: AdapterAddressStore,
    private readonly createConfigClient: (nodePath: string) => ConfigClient | BluezConfigClient,
    private readonly transactions: TransactionStore,
    options: {
      responseTimeoutMs?: number;
      scanSeconds?: number;
      resyncConcurrency?: number;
      resyncRetryMs?: number;
      resyncSendAttempts?: number;
      observationCoherenceMs?: number;
      now?: () => number;
    } = {}
  ) {
    this.responseTimeoutMs = options.responseTimeoutMs ?? 8_000;
    this.scanSeconds = options.scanSeconds ?? 10;
    this.resyncConcurrency = options.resyncConcurrency ?? 4;
    this.resyncRetryMs = options.resyncRetryMs ?? 100;
    this.resyncSendAttempts = options.resyncSendAttempts ?? 3;
    this.observationCoherenceMs = options.observationCoherenceMs ?? 65_000;
    this.now = options.now ?? Date.now;
    this.application.on("messageReceived", this.receiveFixtureStatus);
  }

  start() {
    return this.provisioner.start();
  }

  onFixtureStatus(listener: (status: FixtureMeshStatus) => void) {
    this.fixtureStatuses.add(listener);
    return () => this.fixtureStatuses.delete(listener);
  }

  onResyncReport(listener: (report: BleMeshResyncReport) => void) {
    this.resyncReportListeners.add(listener);
    return () => this.resyncReportListeners.delete(listener);
  }

  /** Reconfigures confirmed nodes and waits for actual state without treating a missing reply as offline. */
  resyncFixtureStates() {
    if (!this.resyncInFlight) {
      this.resyncInFlight = this.performResync().finally(() => {
        this.resyncInFlight = undefined;
      });
    }
    return this.resyncInFlight;
  }

  async scan(_command: ProvisioningScanStartPayload): Promise<ProvisioningScanFoundDevice[]> {
    const rows = await this.provisioner.scan(this.scanSeconds);
    const discoveredAt = new Date().toISOString();
    return rows.map((row) => ({
      deviceUuid: row.deviceUuid,
      serialNumber: row.deviceUuid,
      rssi: row.rssi,
      oobCapability: row.oobCapability,
      firmwareVersion: "unknown"
    }));
  }

  async provision(command: ProvisionDevicePayload): Promise<ProvisioningCompletedPayload> {
    const result = await this.provisioner.provision({
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress
    });
    const nodePath = this.requireNodePath();
    await this.createConfigClient(nodePath).configureNode({ unicast: result.primaryUnicast, elementCount: result.elementCount });
    return {
      sessionId: command.sessionId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress,
      firmwareVersion: "unknown",
      rssi: null,
      hopCount: null,
      completedAt: new Date().toISOString()
    };
  }

  async identify(command: IdentifyDevicePayload) {
    const mapping = await this.addressStore.findByFixtureId(command.nodeId);
    if (!mapping || mapping.status !== "confirmed") {
      throw new Error("UNPROVISIONED_IDENTIFY_UNAVAILABLE: standard BLE Mesh cannot blink a node before provisioning");
    }
    await this.setBrightness([command.nodeId], 100);
  }

  async setBrightness(fixtureIds: string[], brightness: number): Promise<BleMeshCommandReport[]> {
    await this.start();
    const reports: BleMeshCommandReport[] = [];
    for (const fixtureId of fixtureIds) reports.push(await this.applyUnicast(fixtureId, brightness));
    return reports;
  }

  async applyUnicast(
    fixtureId: string,
    brightness: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport> {
    await this.start();
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceeded(fixtureId, brightness, signal);
    const mapping = await this.addressStore.findByFixtureId(fixtureId);
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceeded(fixtureId, brightness, signal);
    if (!mapping || mapping.status !== "confirmed") return failed(fixtureId, brightness, "MESH_MAPPING_NOT_FOUND");
    return this.commandSources.run(String(mapping.primaryUnicast), () =>
      isCommandExpired(signal, deadlineAt)
        ? Promise.resolve(deadlineExceeded(fixtureId, brightness, signal))
        : this.sendFixtureBrightness(fixtureId, mapping.primaryUnicast, brightness, signal, deadlineAt)
    );
  }

  async applyParallelUnicast(
    fixtureIds: string[],
    brightness: number,
    concurrency = 8,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport[]> {
    await this.start();
    validateConcurrency(concurrency);
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceededMany(fixtureIds, brightness, signal);
    const mappings = await Promise.all(fixtureIds.map(async (fixtureId) => ({
      fixtureId,
      mapping: await this.addressStore.findByFixtureId(fixtureId)
    })));
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceededMany(fixtureIds, brightness, signal);

    const confirmed = mappings.filter((row): row is typeof row & { mapping: NonNullable<typeof row.mapping> } =>
      row.mapping?.status === "confirmed"
    );
    const destinations = confirmed.map(({ mapping }) => mapping.primaryUnicast);
    if (new Set(destinations).size !== destinations.length) {
      return fixtureIds.map((fixtureId) => failed(fixtureId, brightness, "mesh_mapping_duplicate"));
    }
    const tids = await this.transactions.nextMany(destinations);
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceededMany(fixtureIds, brightness, signal);
    const tidsByFixture = new Map(confirmed.map(({ fixtureId }, index) => [fixtureId, tids[index]]));

    return mapWithConcurrency(mappings, concurrency, ({ fixtureId, mapping }) => {
      if (!mapping || mapping.status !== "confirmed") {
        return Promise.resolve(failed(fixtureId, brightness, "MESH_MAPPING_NOT_FOUND"));
      }
      return this.commandSources.run(String(mapping.primaryUnicast), () =>
        isCommandExpired(signal, deadlineAt)
          ? Promise.resolve(deadlineExceeded(fixtureId, brightness, signal))
          : this.sendFixtureBrightness(
            fixtureId,
            mapping.primaryUnicast,
            brightness,
            signal,
            deadlineAt,
            tidsByFixture.get(fixtureId)
          )
      );
    }, signal);
  }

  async applyMeshGroup(
    groupAddress: number,
    fixtureIds: string[],
    brightness: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport[]> {
    await this.start();
    validateGroupAddress(groupAddress);
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceededMany(fixtureIds, brightness, signal);
    const mappings = await Promise.all(fixtureIds.map(async (fixtureId) => ({
      fixtureId,
      mapping: await this.addressStore.findByFixtureId(fixtureId)
    })));
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceededMany(fixtureIds, brightness, signal);
    const complete = mappings.every(({ mapping }) => mapping?.status === "confirmed");
    const uniqueSources = new Set(mappings.flatMap(({ mapping }) => mapping?.status === "confirmed" ? [mapping.primaryUnicast] : []));
    if (!complete || uniqueSources.size !== fixtureIds.length) {
      return fixtureIds.map((fixtureId) => failed(fixtureId, brightness, "mesh_mapping_incomplete", "failed"));
    }
    const expected = mappings.map(({ fixtureId, mapping }) => ({ fixtureId, source: mapping!.primaryUnicast }));
    return this.commandSources.runMany(expected.map(({ source }) => String(source)), async () => {
      if (isCommandExpired(signal, deadlineAt)) return deadlineExceededMany(fixtureIds, brightness, signal);
      const tid = await this.transactions.next(groupAddress);
      if (isCommandExpired(signal, deadlineAt)) return deadlineExceededMany(fixtureIds, brightness, signal);
      const targetLightness = percentToLightness(brightness);
      const timeoutMs = remainingStatusTimeout(this.responseTimeoutMs, deadlineAt);
      if (timeoutMs === 0) return deadlineExceededMany(fixtureIds, brightness, signal);
      const statuses = waitForGroupLightnessStatuses(
        this.application,
        expected,
        targetLightness,
        timeoutMs,
        signal
      );
      try {
        if (isCommandExpired(signal, deadlineAt)) {
          statuses.cancel();
          return deadlineExceededMany(fixtureIds, brightness, signal);
        }
        await this.transport.call(BLUEZ_SERVICE, this.requireNodePath(), NODE_INTERFACE, "Send", [
          BLUEZ_APPLICATION_PATHS.element,
          groupAddress,
          0,
          [],
          Array.from(encodeLightnessSetUnacknowledged(targetLightness, tid))
        ]);
        const observed = await statuses.promise;
        return expected.map(({ fixtureId, source }) => {
          const status = observed.get(source);
          if (!status) return failed(fixtureId, brightness, "status_timeout", "timed_out");
          const reportedBrightness = lightnessToPercent(status.present);
          if (Math.abs(reportedBrightness - brightness) > 1) {
            return failed(fixtureId, reportedBrightness, "state_mismatch", "failed");
          }
          return applied(fixtureId, reportedBrightness, true);
        });
      } catch (error) {
        statuses.cancel();
        if (signal?.aborted || isAbortError(error)) return aborted(fixtureIds, brightness);
        return fixtureIds.map((fixtureId) => failed(
          fixtureId,
          brightness,
          error instanceof Error && error.message.includes("timed out") ? "status_timeout" : "mesh_send_failed",
          error instanceof Error && error.message.includes("timed out") ? "timed_out" : "failed"
        ));
      }
    });
  }

  async syncGroupSubscriptions(
    command: MeshGroupSubscriptionSyncPayload,
    appliedMembers?: MeshGroupSubscriptionSyncPayload["desiredMembers"]
  ): Promise<MeshGroupSubscriptionResultPayload> {
    await this.start();
    const nodePath = this.requireNodePath();
    const configClient = this.createConfigClient(nodePath);
    const applied = new Map((appliedMembers ?? [...(this.appliedGroupMembers.get(command.groupId) ?? new Map())]
      .map(([meshNodeId, meshAddress]) => ({ meshNodeId, meshAddress })))
      .map((member) => [member.meshNodeId, member.meshAddress]));
    const desired = new Map(command.desiredMembers.map((member) => [member.meshNodeId, member.meshAddress]));
    const operations: MeshGroupSubscriptionResultPayload["operations"] = [];
    const changes = [
      ...[...applied].filter(([meshNodeId, meshAddress]) => !desired.has(meshNodeId) || desired.get(meshNodeId) !== meshAddress)
        .map(([meshNodeId, meshAddress]) => ({ action: "delete" as const, meshNodeId, meshAddress })),
      ...[...desired].filter(([meshNodeId, meshAddress]) => !applied.has(meshNodeId) || applied.get(meshNodeId) !== meshAddress)
        .map(([meshNodeId, meshAddress]) => ({ action: "add" as const, meshNodeId, meshAddress }))
    ];
    for (const change of changes) {
      try {
        const input = {
          unicast: parseMeshAddress(change.meshAddress),
          groupAddress: parseMeshAddress(command.groupAddress)
        };
        if (change.action === "add") await configClient.addModelSubscription(input);
        else await configClient.removeModelSubscription(input);
        if (change.action === "add") applied.set(change.meshNodeId, change.meshAddress);
        else applied.delete(change.meshNodeId);
        operations.push({ operationId: randomUUID(), action: change.action, meshNodeId: change.meshNodeId, status: "ready" });
      } catch (error) {
        operations.push({
          operationId: randomUUID(),
          action: change.action,
          meshNodeId: change.meshNodeId,
          status: "failed",
          error: error instanceof Error ? error.message : "Bluetooth Mesh group subscription failed"
        });
      }
    }
    this.appliedGroupMembers.set(command.groupId, applied);

    return {
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      groupId: command.groupId,
      version: command.version,
      groupAddress: command.groupAddress,
      operations,
      occurredAt: new Date().toISOString()
    };
  }

  private async sendFixtureBrightness(
    fixtureId: string,
    primaryUnicast: number,
    brightness: number,
    signal?: AbortSignal,
    deadlineAt?: number,
    reservedTid?: number
  ): Promise<BleMeshCommandReport> {
    const nodePath = this.requireNodePath();
    const tid = reservedTid ?? await this.transactions.next(primaryUnicast);
    if (isCommandExpired(signal, deadlineAt)) return deadlineExceeded(fixtureId, brightness, signal);
    const targetLightness = percentToLightness(brightness);
    const timeoutMs = remainingStatusTimeout(this.responseTimeoutMs, deadlineAt);
    if (timeoutMs === 0) return deadlineExceeded(fixtureId, brightness, signal);
    const status = waitForLightnessStatus(
      this.application,
      primaryUnicast,
      targetLightness,
      timeoutMs,
      signal
    );
    try {
      if (isCommandExpired(signal, deadlineAt)) {
        status.cancel();
        return deadlineExceeded(fixtureId, brightness, signal);
      }
      await this.transport.call(BLUEZ_SERVICE, nodePath, NODE_INTERFACE, "Send", [
        BLUEZ_APPLICATION_PATHS.element,
        primaryUnicast,
        0,
        [],
        Array.from(encodeLightnessSet({ lightness: targetLightness, tid }))
      ]);
      const reportedBrightness = lightnessToPercent((await status.promise).present);
      if (Math.abs(reportedBrightness - brightness) > 1) {
        return failed(fixtureId, reportedBrightness, "state_mismatch");
      }
      return applied(fixtureId, reportedBrightness);
    } catch (error) {
      status.cancel();
      if (signal?.aborted || isAbortError(error)) {
        return failed(fixtureId, brightness, "command_aborted", "timed_out");
      }
      return failed(fixtureId, brightness, error instanceof Error && error.message.includes("timed out") ? "STATUS_TIMEOUT" : "MESH_SEND_FAILED");
    }
  }

  private requireNodePath() {
    if (!this.provisioner.nodePath) throw new Error("BlueZ Mesh provisioner is not attached");
    return this.provisioner.nodePath;
  }

  private readonly receiveFixtureStatus = (event: { source: number; data: Uint8Array }) => {
    void this.handleFixtureStatus(event).catch(() => undefined);
  };

  private async handleFixtureStatus(event: { source: number; data: Uint8Array }) {
    const payload = Buffer.from(event.data);
    const kind = fixtureStatusKind(payload);
    if (!kind) return;
    const mapping = await this.addressStore.findByPrimaryUnicast(event.source);
    if (!mapping || mapping.status !== "confirmed") return;

    const now = this.now();
    const health = kind === "health" ? decodeHealthStatus(payload) : undefined;
    if (health?.kind === "registered") return;
    let observation = this.latestObservations.get(mapping.fixtureId);
    if (
      !observation ||
      observation.completed ||
      (hasAnyObservation(observation) && now - observation.startedAt > this.observationCoherenceMs)
    ) {
      observation = this.beginObservationGeneration(mapping.fixtureId, now);
    }
    if (!hasAnyObservation(observation)) observation.startedAt = now;
    if (kind === "onoff") {
      observation.powerOn = { value: decodeGenericOnOffStatus(payload).present, observedAt: now };
    } else if (kind === "lightness") {
      observation.brightness = { value: lightnessToPercent(decodeLightnessStatus(payload).present), observedAt: now };
    } else {
      observation.currentFault = {
        value: {
          companyId: health!.companyId,
          faultCodes: mapHealthFaults(health!.faults)
        },
        observedAt: now
      };
    }
    this.latestObservations.set(mapping.fixtureId, observation);
    if (hasLightingPair(observation)) {
      for (const listener of this.fixtureLightingPairs) listener(mapping.fixtureId, observation.generation);
    }
    if (!observation.powerOn || !observation.brightness || !observation.currentFault) return;
    if (!isCoherent(observation, this.observationCoherenceMs)) return;
    observation.completed = true;
    const healthSnapshot = observation.currentFault.value;
    const faultCode = healthSnapshot.faultCodes.length === 0
      ? undefined
      : `health:${healthSnapshot.companyId.toString(16).padStart(4, "0")}:${healthSnapshot.faultCodes.map((fault) => fault.toString(16).padStart(2, "0")).join("")}`;
    const status: FixtureMeshStatus = {
      fixtureId: mapping.fixtureId,
      brightness: observation.brightness.value,
      powerOn: observation.powerOn.value,
      status: healthSnapshot.faultCodes.length > 0 ? "fault" : "online",
      ...(faultCode ? { faultCode } : {}),
      health: {
        faultCodes: healthSnapshot.faultCodes,
        observedAt: new Date(observation.currentFault.observedAt).toISOString()
      },
      rssi: null,
      hopCount: null
    };
    for (const listener of this.fixtureStatuses) listener(status);
    this.markHealthPendingRecovered(mapping.fixtureId);
  }

  private async performResync(): Promise<BleMeshResyncReport> {
    await this.start();
    const mappings = await this.addressStore.listConfirmed();
    this.healthPendingFixtures.clear();
    const results = await mapWithConcurrency(mappings, this.resyncConcurrency, (mapping) => this.resyncFixture(mapping));
    for (const result of results) {
      if (result.healthPending) this.healthPendingFixtures.add(result.fixtureId);
    }
    const report = results.reduce<BleMeshResyncReport>((summary, result) => ({
      total: summary.total + 1,
      configured: summary.configured + (result.status === "observed" || result.status === "timed_out" ? 1 : 0),
      observed: summary.observed + (result.status === "observed" ? 1 : 0),
      healthPending: summary.healthPending + (result.healthPending ? 1 : 0),
      timedOut: summary.timedOut + (result.status === "timed_out" ? 1 : 0),
      failed: summary.failed + (result.status === "failed" ? 1 : 0)
    }), { total: 0, configured: 0, observed: 0, healthPending: 0, timedOut: 0, failed: 0 });
    this.lastResyncReport = report;
    return report;
  }

  private async resyncFixture(mapping: { fixtureId: string; primaryUnicast: number; elementCount: number }): Promise<ResyncFixtureResult> {
    try {
      await this.retryBusy(() => this.createConfigClient(this.requireNodePath()).configureNode({
        unicast: mapping.primaryUnicast,
        elementCount: mapping.elementCount
      }));
      // Start the observation window when this bounded-queue item actually runs. Large
      // sites may wait longer than one coherence window before reaching this point.
      const generation = this.beginObservationGeneration(mapping.fixtureId, this.now()).generation;
      const observation = this.waitForFixtureLightingPair(mapping.fixtureId, generation);
      try {
        await Promise.all([
          this.sendStatusGetWithRetry(mapping.primaryUnicast, GENERIC_ONOFF_GET),
          this.sendStatusGetWithRetry(mapping.primaryUnicast, LIGHT_LIGHTNESS_GET),
          this.sendStatusGetWithRetry(mapping.primaryUnicast, HEALTH_FAULT_GET)
        ]);
      } catch {
        observation.cancel();
        return { fixtureId: mapping.fixtureId, status: "failed" };
      }
      observation.startDeadline();
      try {
        await observation.promise;
        return {
          fixtureId: mapping.fixtureId,
          status: "observed",
          healthPending: !this.hasCurrentHealth(mapping.fixtureId, generation)
        };
      } catch {
        return { fixtureId: mapping.fixtureId, status: "timed_out" };
      }
    } catch {
      return { fixtureId: mapping.fixtureId, status: "failed" };
    }
  }

  private waitForFixtureLightingPair(fixtureId: string, generation: number) {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolvePromise: () => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    };
    const onPair = (observedFixtureId: string, observedGeneration: number) => {
      if (settled || observedFixtureId !== fixtureId || observedGeneration !== generation) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const unsubscribe = () => this.fixtureLightingPairs.delete(onPair);
    this.fixtureLightingPairs.add(onPair);
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // The observer starts before requests are sent so a fast reply cannot be lost.
    // Attaching a handler now also prevents a timeout during retry from becoming unhandled.
    void promise.catch(() => undefined);
    return {
      promise,
      startDeadline: () => {
        if (settled || timeout) return;
        timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectPromise(new Error("Fixture resync observation timed out"));
        }, this.responseTimeoutMs);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error("Fixture resync observation cancelled"));
      }
    };
  }

  private sendStatusGetWithRetry(destination: number, payload: Uint8Array) {
    return this.retryBusy(() => this.sendStatusGet(destination, payload));
  }

  private async retryBusy<T>(operation: () => Promise<T>) {
    for (let attempt = 0; attempt < this.resyncSendAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt + 1 === this.resyncSendAttempts || !isBusyError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.resyncRetryMs * (attempt + 1)));
      }
    }
    throw new Error("Mesh resync retry exhausted");
  }

  private async sendStatusGet(destination: number, payload: Uint8Array) {
    await this.transport.call(BLUEZ_SERVICE, this.requireNodePath(), NODE_INTERFACE, "Send", [
      BLUEZ_APPLICATION_PATHS.element,
      destination,
      0,
      [],
      Array.from(payload)
    ]);
  }

  private beginObservationGeneration(fixtureId: string, startedAt: number) {
    const observation: FixtureObservation = {
      generation: ++this.nextObservationGeneration,
      startedAt,
      completed: false
    };
    this.latestObservations.set(fixtureId, observation);
    return observation;
  }

  private hasCurrentHealth(fixtureId: string, generation: number) {
    const observation = this.latestObservations.get(fixtureId);
    return observation?.generation === generation && observation.currentFault !== undefined;
  }

  private markHealthPendingRecovered(fixtureId: string) {
    if (!this.healthPendingFixtures.delete(fixtureId) || !this.lastResyncReport) return;
    this.lastResyncReport.healthPending = this.healthPendingFixtures.size;
    for (const listener of this.resyncReportListeners) listener(this.lastResyncReport);
  }
}

interface FixtureObservation {
  generation: number;
  startedAt: number;
  completed: boolean;
  brightness?: TimedObservation<number>;
  powerOn?: TimedObservation<boolean>;
  currentFault?: TimedObservation<{ companyId: number; faultCodes: number[] }>;
}

interface TimedObservation<T> {
  value: T;
  observedAt: number;
}

interface ResyncFixtureResult {
  fixtureId: string;
  status: "observed" | "timed_out" | "failed";
  healthPending?: boolean;
}

function hasLightingPair(observation: FixtureObservation) {
  return observation.powerOn !== undefined && observation.brightness !== undefined;
}

function hasAnyObservation(observation: FixtureObservation) {
  return observation.powerOn !== undefined || observation.brightness !== undefined || observation.currentFault !== undefined;
}

function isCoherent(observation: FixtureObservation, coherenceMs: number) {
  if (!observation.powerOn || !observation.brightness || !observation.currentFault) return false;
  const oldest = Math.min(observation.powerOn.observedAt, observation.brightness.observedAt, observation.currentFault.observedAt);
  const newest = Math.max(observation.powerOn.observedAt, observation.brightness.observedAt, observation.currentFault.observedAt);
  return newest - oldest <= coherenceMs;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
  signal?: AbortSignal
) {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length && !signal?.aborted) {
      const index = next++;
      if (signal?.aborted) break;
      results[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return results.filter((value): value is R => value !== undefined);
}

function isBusyError(error: unknown) {
  return error instanceof Error && /busy|in.?progress|no.?resources/i.test(error.message);
}

function fixtureStatusKind(payload: Buffer) {
  if (payload.subarray(0, 2).equals(Buffer.from([0x82, 0x04]))) return "onoff" as const;
  if (payload.subarray(0, 2).equals(Buffer.from([0x82, 0x4e]))) return "lightness" as const;
  if (payload[0] === 0x04 || payload[0] === 0x05) return "health" as const;
  return null;
}

function waitForLightnessStatus(
  application: EventEmitter,
  source: number,
  targetLightness: number,
  timeoutMs: number,
  signal?: AbortSignal
) {
  let rejectPromise: (error: Error) => void = () => undefined;
  let resolvePromise: (status: ReturnType<typeof decodeLightnessStatus>) => void = () => undefined;
  let settled = false;
  let latestMismatch: ReturnType<typeof decodeLightnessStatus> | undefined;
  const cleanup = () => {
    clearTimeout(timeout);
    application.off("messageReceived", onMessage);
    signal?.removeEventListener("abort", onAbort);
  };
  const onMessage = (event: { source: number; data: Uint8Array }) => {
    if (event.source !== source || event.data[0] !== 0x82 || event.data[1] !== 0x4e) return;
    try {
      const decoded = decodeLightnessStatus(Buffer.from(event.data));
      if (decoded.present !== targetLightness) {
        latestMismatch = decoded;
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(decoded);
    } catch {
      // A malformed or unrelated periodic publication cannot satisfy this command.
    }
  };
  const promise = new Promise<ReturnType<typeof decodeLightnessStatus>>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  const onAbort = () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(new Error("Lightness request aborted"));
  };
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    if (latestMismatch) resolvePromise(latestMismatch);
    else rejectPromise(new Error("Lightness Status timed out"));
  }, timeoutMs);
  application.on("messageReceived", onMessage);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
      promise.catch(() => undefined);
      rejectPromise(new Error("Lightness request cancelled"));
    }
  };
}

function waitForGroupLightnessStatuses(
  application: EventEmitter,
  expected: Array<{ fixtureId: string; source: number }>,
  targetLightness: number,
  timeoutMs: number,
  signal?: AbortSignal
) {
  const expectedSources = new Set(expected.map(({ source }) => source));
  const observed = new Map<number, ReturnType<typeof decodeLightnessStatus>>();
  const matched = new Set<number>();
  let settled = false;
  let resolvePromise: (statuses: Map<number, ReturnType<typeof decodeLightnessStatus>>) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const cleanup = () => {
    clearTimeout(timeout);
    application.off("messageReceived", onMessage);
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(observed);
  };
  const onMessage = (event: { source: number; data: Uint8Array }) => {
    if (settled || !expectedSources.has(event.source) || matched.has(event.source)) return;
    const payload = Buffer.from(event.data);
    if (payload[0] !== 0x82 || payload[1] !== 0x4e) return;
    try {
      const decoded = decodeLightnessStatus(payload);
      observed.set(event.source, decoded);
      if (decoded.present === targetLightness) matched.add(event.source);
      if (matched.size === expectedSources.size) finish();
    } catch {
      // A malformed publication cannot satisfy an expected source and remains timed out.
    }
  };
  const promise = new Promise<Map<number, ReturnType<typeof decodeLightnessStatus>>>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  const onAbort = () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(new Error("Lightness request aborted"));
  };
  const timeout = setTimeout(finish, timeoutMs);
  application.on("messageReceived", onMessage);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error("Lightness request cancelled"));
    }
  };
}

function applied(fixtureId: string, brightness: number, includeOutcome = false): BleMeshCommandReport {
  return {
    fixtureId,
    acknowledged: true,
    ...(includeOutcome ? { outcome: "applied" as const } : {}),
    brightness,
    rssi: null,
    hopCount: null
  };
}

function failed(
  fixtureId: string,
  brightness: number,
  faultCode: string,
  outcome: "failed" | "timed_out" = "failed"
): BleMeshCommandReport {
  return { fixtureId, acknowledged: false, outcome, brightness, faultCode, rssi: null, hopCount: null };
}

function aborted(fixtureIds: string[], brightness: number) {
  return fixtureIds.map((fixtureId) => failed(fixtureId, brightness, "command_aborted", "timed_out"));
}

function deadlineExceeded(fixtureId: string, brightness: number, signal?: AbortSignal) {
  return failed(
    fixtureId,
    brightness,
    signal?.aborted ? "command_aborted" : "command_deadline_exceeded",
    "timed_out"
  );
}

function deadlineExceededMany(fixtureIds: string[], brightness: number, signal?: AbortSignal) {
  return fixtureIds.map((fixtureId) => deadlineExceeded(fixtureId, brightness, signal));
}

function isCommandExpired(signal?: AbortSignal, deadlineAt?: number) {
  return signal?.aborted === true || (deadlineAt !== undefined && Date.now() >= deadlineAt);
}

function remainingStatusTimeout(configuredTimeoutMs: number, deadlineAt?: number) {
  if (deadlineAt === undefined) return configuredTimeoutMs;
  return Math.max(0, Math.min(configuredTimeoutMs, deadlineAt - Date.now()));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("abort");
}

function parseMeshAddress(value: string) {
  if (!/^0x[0-9a-f]{4}$/i.test(value)) throw new Error("Invalid mesh address");
  return Number.parseInt(value.slice(2), 16);
}

function validateConcurrency(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error("mesh unicast concurrency must be 1 to 64");
}

function validateGroupAddress(value: number) {
  if (!Number.isInteger(value) || value < 0xc000 || value > 0xfeff) throw new Error("invalid mesh group address");
}
