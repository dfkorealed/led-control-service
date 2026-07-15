import type { EventEmitter } from "node:events";
import { BLUEZ_APPLICATION_PATHS, type BluezDbusApplication } from "./bluez-dbus-application";
import type { BluezTransport } from "./bluez-transport";
import type { MeshAddressStore } from "./mesh-address-store";
import type { MeshIdentityStore } from "./mesh-identity-store";

const BLUEZ_SERVICE = "org.bluez.mesh";
const NETWORK_PATH = "/org/bluez/mesh";
const NETWORK_INTERFACE = "org.bluez.mesh.Network1";
const MANAGEMENT_INTERFACE = "org.bluez.mesh.Management1";

interface ProvisionerApplication extends EventEmitter {
  start(): Promise<void>;
  setProvisioningDataProvider?(provider: (count: number) => Promise<[number, number]>): void;
}

interface ProvisionerTransport {
  call<T>(service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<T>;
}

interface IdentityStore {
  loadOrCreate(): Promise<{ uuid: Uint8Array; token?: bigint }>;
  saveToken(token: bigint): Promise<void>;
}

interface AddressStore {
  reserve(input: { nodeId: string; deviceUuid: string; meshAddress: string }): Promise<{ primaryUnicast: number }>;
  confirm(deviceUuid: string, primaryUnicast: number, elementCount: number): Promise<unknown>;
  prepareElementRange?(deviceUuid: string, elementCount: number): Promise<unknown>;
  release?(deviceUuid: string): Promise<void>;
}

export interface BluezScanResult {
  deviceUuid: string;
  rssi: number;
  oobCapability: "none" | "static-oob" | "output-oob" | "input-oob";
}

export interface BluezProvisionRequest {
  nodeId: string;
  deviceUuid: string;
  meshAddress: string;
}

interface BluezProvisionerOptions {
  bootstrapTimeoutMs?: number;
  provisioningTimeoutMs?: number;
}

export class BluezProvisioner {
  nodePath: string | null = null;
  private startPromise: Promise<void> | null = null;
  private activeReservation: { deviceUuid: string; primaryUnicast: number } | null = null;
  private provisioning = false;
  private readonly bootstrapTimeoutMs: number;
  private readonly provisioningTimeoutMs: number;

  constructor(
    private readonly transport: ProvisionerTransport | BluezTransport,
    private readonly application: ProvisionerApplication | BluezDbusApplication,
    private readonly identityStore: IdentityStore | MeshIdentityStore,
    private readonly addressStore: AddressStore | MeshAddressStore,
    options: BluezProvisionerOptions = {}
  ) {
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 30_000;
    this.provisioningTimeoutMs = options.provisioningTimeoutMs ?? 120_000;
    this.application.setProvisioningDataProvider?.(async (elementCount) => {
      const reservation = this.activeReservation;
      if (!reservation) throw new Error("No active mesh address reservation");
      if (!Number.isInteger(elementCount) || elementCount < 1) throw new Error("Invalid provisioning element count");
      await this.addressStore.prepareElementRange?.(reservation.deviceUuid, elementCount);
      return [0, reservation.primaryUnicast];
    });
  }

  start() {
    this.startPromise ??= this.startInternal().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  async scan(seconds: number): Promise<BluezScanResult[]> {
    await this.start();
    const nodePath = this.requireNodePath();
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("Scan duration must be 1-3600 seconds");
    const results = new Map<string, BluezScanResult>();
    const onResult = (event: { rssi: number; data: Uint8Array }) => {
      const parsed = parseScanResult(event);
      const previous = results.get(parsed.deviceUuid);
      if (!previous || parsed.rssi > previous.rssi) results.set(parsed.deviceUuid, parsed);
    };
    this.application.on("scanResult", onResult);
    try {
      await this.transport.call(BLUEZ_SERVICE, nodePath, MANAGEMENT_INTERFACE, "UnprovisionedScan", [
        [["Seconds", ["q", seconds]]]
      ]);
      await delay(seconds * 1000);
      return [...results.values()].sort((left, right) => right.rssi - left.rssi);
    } finally {
      this.application.off("scanResult", onResult);
    }
  }

  async stopScan() {
    await this.start();
    await this.transport.call(BLUEZ_SERVICE, this.requireNodePath(), MANAGEMENT_INTERFACE, "UnprovisionedScanCancel", []);
  }

  async provision(request: BluezProvisionRequest): Promise<{ primaryUnicast: number; elementCount: number }> {
    await this.start();
    if (this.provisioning) throw new Error("BLE Mesh provisioning is already in progress");
    const deviceUuid = normalizeDeviceUuid(request.deviceUuid);
    this.provisioning = true;
    try {
      const reservation = await this.addressStore.reserve({ ...request, deviceUuid });
      this.activeReservation = { deviceUuid, primaryUnicast: reservation.primaryUnicast };
      const completion = waitForProvisioningResult(this.application, deviceUuid, this.provisioningTimeoutMs);
      await this.transport.call(BLUEZ_SERVICE, this.requireNodePath(), MANAGEMENT_INTERFACE, "AddNode", [
        Array.from(Buffer.from(deviceUuid, "hex")),
        []
      ]);
      const result = await completion;
      await this.addressStore.confirm(deviceUuid, result.primaryUnicast, result.elementCount);
      return result;
    } catch (error) {
      await this.addressStore.release?.(deviceUuid);
      throw error;
    } finally {
      this.activeReservation = null;
      this.provisioning = false;
    }
  }

  private async startInternal() {
    await this.application.start();
    const identity = await this.identityStore.loadOrCreate();
    let token = identity.token;
    if (token === undefined) {
      const joined = waitForSingleEvent<{ token: unknown }>(
        this.application,
        "joinComplete",
        "joinFailed",
        this.bootstrapTimeoutMs
      );
      await this.transport.call(BLUEZ_SERVICE, NETWORK_PATH, NETWORK_INTERFACE, "CreateNetwork", [
        BLUEZ_APPLICATION_PATHS.root,
        Array.from(identity.uuid)
      ]);
      const event = await joined;
      token = parseToken(event.token);
      await this.identityStore.saveToken(token);
    }
    const attached = await this.transport.call<unknown>(BLUEZ_SERVICE, NETWORK_PATH, NETWORK_INTERFACE, "Attach", [
      BLUEZ_APPLICATION_PATHS.root,
      token.toString(10)
    ]);
    this.nodePath = parseAttachedNodePath(attached);
  }

  private requireNodePath() {
    if (!this.nodePath) throw new Error("BlueZ Mesh provisioner is not attached");
    return this.nodePath;
  }
}

function waitForProvisioningResult(application: EventEmitter, expectedUuid: string, timeoutMs: number) {
  return new Promise<{ primaryUnicast: number; elementCount: number }>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("BLE Mesh provisioning timed out")), timeoutMs);
    const onAdded = (event: { uuid: Uint8Array; unicast: number; count: number }) => {
      if (Buffer.from(event.uuid).toString("hex") !== expectedUuid) return;
      finish(undefined, { primaryUnicast: event.unicast, elementCount: event.count });
    };
    const onFailed = (event: { uuid: Uint8Array; reason: string }) => {
      if (Buffer.from(event.uuid).toString("hex") !== expectedUuid) return;
      finish(new Error(`BLE Mesh provisioning failed: ${event.reason}`));
    };
    const finish = (error?: Error, result?: { primaryUnicast: number; elementCount: number }) => {
      clearTimeout(timeout);
      application.off("nodeAdded", onAdded);
      application.off("nodeAddFailed", onFailed);
      if (error) reject(error);
      else resolve(result!);
    };
    application.on("nodeAdded", onAdded);
    application.on("nodeAddFailed", onFailed);
  });
}

function waitForSingleEvent<T>(
  emitter: EventEmitter,
  successEvent: string,
  failureEvent: string,
  timeoutMs: number
) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${successEvent}`)), timeoutMs);
    const onSuccess = (event: T) => finish(undefined, event);
    const onFailure = (event: { reason?: string }) => finish(new Error(event.reason ?? failureEvent));
    const finish = (error?: Error, event?: T) => {
      clearTimeout(timeout);
      emitter.off(successEvent, onSuccess);
      emitter.off(failureEvent, onFailure);
      if (error) reject(error);
      else resolve(event!);
    };
    emitter.on(successEvent, onSuccess);
    emitter.on(failureEvent, onFailure);
  });
}

function parseScanResult(event: { rssi: number; data: Uint8Array }): BluezScanResult {
  if (!Number.isFinite(event.rssi) || event.data.length < 16) throw new Error("Invalid BlueZ unprovisioned scan result");
  const deviceUuid = Buffer.from(event.data.subarray(0, 16)).toString("hex");
  const oobMask = event.data.length >= 18 ? event.data[16] | (event.data[17] << 8) : 0;
  return { deviceUuid, rssi: event.rssi, oobCapability: oobMask === 0 ? "none" : "static-oob" };
}

function normalizeDeviceUuid(value: string) {
  const normalized = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new Error("Invalid BLE Mesh device UUID");
  return normalized;
}

function parseToken(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (value && typeof value === "object" && "low" in value && "high" in value) {
    const row = value as { low: unknown; high: unknown; unsigned?: unknown };
    if (Number.isInteger(row.low) && Number.isInteger(row.high) && row.unsigned !== false) {
      return (BigInt((row.high as number) >>> 0) << 32n) | BigInt((row.low as number) >>> 0);
    }
  }
  throw new Error("BlueZ returned an invalid mesh token");
}

function parseAttachedNodePath(value: unknown) {
  const path = Array.isArray(value) ? value[0] : value;
  if (typeof path !== "string" || !path.startsWith("/org/bluez/mesh/node")) {
    throw new Error("BlueZ Attach returned an invalid node path");
  }
  return path;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
