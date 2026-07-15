import type { EventEmitter } from "node:events";
import type {
  IdentifyDevicePayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningScanStartPayload,
  UnprovisionedDeviceFoundPayload
} from "@led-control/shared";
import type { BleMeshAdapter, BleMeshCommandReport, ProvisioningAdapter, ProvisioningScannerAdapter } from "../gateway";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import type { BluezConfigClient } from "./bluez-config-client";
import { decodeLightnessStatus, encodeLightnessSet, lightnessToPercent, percentToLightness } from "./bluez-model-codec";

const BLUEZ_SERVICE = "org.bluez.mesh";
const NODE_INTERFACE = "org.bluez.mesh.Node1";

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
}

interface TransactionStore {
  next(destination?: number): Promise<number>;
}

interface ConfigClient {
  configureNode(input: { unicast: number; elementCount: number }): Promise<unknown>;
}

export class BluezMeshAdapter implements BleMeshAdapter, ProvisioningScannerAdapter, ProvisioningAdapter {
  private readonly responseTimeoutMs: number;
  private readonly scanSeconds: number;

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
  }

  start() {
    return this.provisioner.start();
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
