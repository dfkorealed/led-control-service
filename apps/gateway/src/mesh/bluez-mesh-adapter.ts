import type { EventEmitter } from "node:events";
import type {
  IdentifyDevicePayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningScanStartPayload,
  UnprovisionedDeviceFoundPayload
} from "@led-control/shared";
import type { BleMeshAdapter, BleMeshCommandReport, BleMeshFixtureStatus, ProvisioningAdapter, ProvisioningScannerAdapter } from "../gateway";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import type { BluezConfigClient } from "./bluez-config-client";
import {
  decodeGenericOnOffStatus,
  decodeHealthStatus,
  decodeLightnessStatus,
  encodeLightnessSet,
  lightnessToPercent,
  percentToLightness
} from "./bluez-model-codec";

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
  scan(seconds: number): Promise<Array<{ deviceUuid: string; rssi: number; oobCapability: UnprovisionedDeviceFoundPayload["oobCapability"] }>>;
  provision(input: { nodeId: string; deviceUuid: string; meshAddress: string }): Promise<{ primaryUnicast: number; elementCount: number }>;
}

interface AdapterAddressStore {
  findByFixtureId(fixtureId: string): Promise<{ primaryUnicast: number; status: "reserved" | "confirmed" } | null>;
  findByPrimaryUnicast(primaryUnicast: number): Promise<{ fixtureId: string; primaryUnicast: number; status: "reserved" | "confirmed" } | null>;
  listConfirmed(): Promise<Array<{ fixtureId: string; primaryUnicast: number; status: "confirmed" }>>;
}

interface TransactionStore {
  next(destination?: number): Promise<number>;
}

interface ConfigClient {
  configureNode(input: { unicast: number; elementCount: number }): Promise<unknown>;
}

export type FixtureMeshStatus = BleMeshFixtureStatus;

export class BluezMeshAdapter implements BleMeshAdapter, ProvisioningScannerAdapter, ProvisioningAdapter {
  private readonly responseTimeoutMs: number;
  private readonly scanSeconds: number;
  private readonly fixtureStatuses = new Set<(status: FixtureMeshStatus) => void>();
  private readonly latestState = new Map<string, Pick<FixtureMeshStatus, "brightness" | "powerOn">>();

  constructor(
    private readonly transport: AdapterTransport,
    private readonly application: EventEmitter,
    private readonly provisioner: AdapterProvisioner,
    private readonly addressStore: AdapterAddressStore,
    private readonly createConfigClient: (nodePath: string) => ConfigClient | BluezConfigClient,
    private readonly transactions: TransactionStore,
    options: { responseTimeoutMs?: number; scanSeconds?: number } = {}
  ) {
    this.responseTimeoutMs = options.responseTimeoutMs ?? 8_000;
    this.scanSeconds = options.scanSeconds ?? 10;
    this.application.on("messageReceived", this.receiveFixtureStatus);
  }

  start() {
    return this.provisioner.start();
  }

  onFixtureStatus(listener: (status: FixtureMeshStatus) => void) {
    this.fixtureStatuses.add(listener);
    return () => this.fixtureStatuses.delete(listener);
  }

  /** Requests actual node state after gateway startup; absent replies are intentionally not interpreted as offline. */
  async resyncFixtureStates() {
    await this.start();
    const mappings = await this.addressStore.listConfirmed();
    await Promise.allSettled(mappings.flatMap((mapping) => [
      this.sendStatusGet(mapping.primaryUnicast, GENERIC_ONOFF_GET),
      this.sendStatusGet(mapping.primaryUnicast, LIGHT_LIGHTNESS_GET),
      this.sendStatusGet(mapping.primaryUnicast, HEALTH_FAULT_GET)
    ]));
  }

  async scan(command: ProvisioningScanStartPayload): Promise<UnprovisionedDeviceFoundPayload[]> {
    const rows = await this.provisioner.scan(this.scanSeconds);
    const discoveredAt = new Date().toISOString();
    return rows.map((row) => ({
      sessionId: command.sessionId,
      deviceUuid: row.deviceUuid,
      serialNumber: row.deviceUuid,
      rssi: row.rssi,
      oobCapability: row.oobCapability,
      firmwareVersion: "unknown",
      discoveredAt
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
    for (const fixtureId of fixtureIds) reports.push(await this.setFixtureBrightness(fixtureId, brightness));
    return reports;
  }

  private async setFixtureBrightness(fixtureId: string, brightness: number): Promise<BleMeshCommandReport> {
    const mapping = await this.addressStore.findByFixtureId(fixtureId);
    if (!mapping || mapping.status !== "confirmed") return failed(fixtureId, brightness, "MESH_MAPPING_NOT_FOUND");
    const nodePath = this.requireNodePath();
    const tid = await this.transactions.next(mapping.primaryUnicast);
    const status = waitForLightnessStatus(this.application, mapping.primaryUnicast, this.responseTimeoutMs);
    try {
      await this.transport.call(BLUEZ_SERVICE, nodePath, NODE_INTERFACE, "Send", [
        BLUEZ_APPLICATION_PATHS.element,
        mapping.primaryUnicast,
        0,
        [],
        Array.from(encodeLightnessSet({ lightness: percentToLightness(brightness), tid }))
      ]);
      const reportedBrightness = lightnessToPercent((await status.promise).present);
      if (Math.abs(reportedBrightness - brightness) > 1) return failed(fixtureId, brightness, "STATUS_MISMATCH");
      return { fixtureId, acknowledged: true, brightness: reportedBrightness, rssi: null, hopCount: null };
    } catch (error) {
      status.cancel();
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

    const previous = this.latestState.get(mapping.fixtureId) ?? { brightness: 0, powerOn: false };
    let status: FixtureMeshStatus;
    if (kind === "onoff") {
      const onoff = decodeGenericOnOffStatus(payload);
      status = { fixtureId: mapping.fixtureId, ...previous, powerOn: onoff.present, status: "online", rssi: null, hopCount: null };
    } else if (kind === "lightness") {
      const lightness = decodeLightnessStatus(payload);
      const brightness = lightnessToPercent(lightness.present);
      status = { fixtureId: mapping.fixtureId, brightness, powerOn: brightness > 0, status: "online", rssi: null, hopCount: null };
    } else {
      const health = decodeHealthStatus(payload);
      const faultCode = health.faults.length === 0 ? undefined : `health:${health.companyId.toString(16).padStart(4, "0")}:${health.faults.map((fault) => fault.toString(16).padStart(2, "0")).join("")}`;
      status = { fixtureId: mapping.fixtureId, ...previous, status: faultCode ? "fault" : "online", ...(faultCode ? { faultCode } : {}), rssi: null, hopCount: null };
    }
    this.latestState.set(mapping.fixtureId, { brightness: status.brightness, powerOn: status.powerOn });
    for (const listener of this.fixtureStatuses) listener(status);
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
}

function fixtureStatusKind(payload: Buffer) {
  if (payload.subarray(0, 2).equals(Buffer.from([0x82, 0x04]))) return "onoff" as const;
  if (payload.subarray(0, 2).equals(Buffer.from([0x82, 0x4e]))) return "lightness" as const;
  if (payload[0] === 0x04 || payload[0] === 0x05) return "health" as const;
  return null;
}

function waitForLightnessStatus(application: EventEmitter, source: number, timeoutMs: number) {
  let rejectPromise: (error: Error) => void = () => undefined;
  let resolvePromise: (status: ReturnType<typeof decodeLightnessStatus>) => void = () => undefined;
  let settled = false;
  const cleanup = () => {
    clearTimeout(timeout);
    application.off("messageReceived", onMessage);
  };
  const onMessage = (event: { source: number; data: Uint8Array }) => {
    if (event.source !== source || event.data[0] !== 0x82 || event.data[1] !== 0x4e) return;
    try {
      const decoded = decodeLightnessStatus(Buffer.from(event.data));
      settled = true;
      cleanup();
      resolvePromise(decoded);
    } catch (error) {
      settled = true;
      cleanup();
      rejectPromise(error instanceof Error ? error : new Error("Invalid Lightness Status"));
    }
  };
  const promise = new Promise<ReturnType<typeof decodeLightnessStatus>>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(new Error("Lightness Status timed out"));
  }, timeoutMs);
  application.on("messageReceived", onMessage);
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

function failed(fixtureId: string, brightness: number, faultCode: string): BleMeshCommandReport {
  return { fixtureId, acknowledged: false, brightness, faultCode, rssi: null, hopCount: null };
}
