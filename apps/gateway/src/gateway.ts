import type {
  IdentifyDevicePayload,
  MeshGroupSubscriptionResultPayload,
  MeshGroupSubscriptionSyncPayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningFailedPayload,
  ProvisioningScanStartPayload,
  UnprovisionedDeviceFoundPayload
} from "@led-control/shared";

export interface BleMeshAdapter {
  setBrightness(fixtureIds: string[], brightness: number): Promise<BleMeshCommandReport[]>;
  applyUnicast?(fixtureId: string, brightness: number, signal?: AbortSignal, deadlineAt?: number): Promise<BleMeshCommandReport>;
  applyParallelUnicast?(
    fixtureIds: string[],
    brightness: number,
    concurrency?: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport[]>;
  applyMeshGroup?(
    groupAddress: number,
    fixtureIds: string[],
    brightness: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport[]>;
  onFixtureStatus(listener: (status: BleMeshFixtureStatus) => void): () => void;
  onResyncReport?(listener: (report: BleMeshResyncReport) => void): () => void;
  resyncFixtureStates(): Promise<BleMeshResyncReport>;
  syncGroupSubscriptions(command: MeshGroupSubscriptionSyncPayload): Promise<MeshGroupSubscriptionResultPayload>;
}

export interface BleMeshFixtureStatus {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  status: "online" | "fault";
  faultCode?: string;
  health: { faultCodes: number[]; observedAt: string };
  rssi: number | null;
  hopCount: number | null;
}

export interface BleMeshResyncReport {
  total: number;
  configured: number;
  observed: number;
  healthPending: number;
  timedOut: number;
  failed: number;
}

export interface ProvisioningScannerAdapter {
  scan(command: ProvisioningScanStartPayload): Promise<UnprovisionedDeviceFoundPayload[]>;
}

export interface ProvisioningAdapter {
  identify(command: IdentifyDevicePayload): Promise<void>;
  provision(command: ProvisionDevicePayload): Promise<ProvisioningCompletedPayload>;
}

export interface BleMeshCommandReport {
  fixtureId: string;
  acknowledged: boolean;
  outcome?: "applied" | "failed" | "timed_out";
  brightness: number;
  faultCode?: string;
  rssi: number | null;
  hopCount: number | null;
}

export async function applyProvisioningScan(adapter: ProvisioningScannerAdapter, command: ProvisioningScanStartPayload) {
  return adapter.scan(command);
}

export async function applyIdentifyDevice(adapter: ProvisioningAdapter, command: IdentifyDevicePayload) {
  await adapter.identify(command);
}

export async function applyProvisionDevice(
  adapter: ProvisioningAdapter,
  command: ProvisionDevicePayload
): Promise<{ completed?: ProvisioningCompletedPayload; failed?: ProvisioningFailedPayload }> {
  try {
    return { completed: await adapter.provision(command) };
  } catch (error) {
    return {
      failed: {
        sessionId: command.sessionId,
        nodeId: command.nodeId,
        deviceUuid: command.deviceUuid,
        errorMessage: error instanceof Error ? error.message : "Unknown provisioning adapter error",
        failedAt: new Date().toISOString()
      }
    };
  }
}
