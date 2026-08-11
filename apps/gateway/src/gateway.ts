import type {
  IdentifyDevicePayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningFailedPayload,
  ProvisioningScanStartPayload,
  UnprovisionedDeviceFoundPayload
} from "@led-control/shared";

export interface BleMeshAdapter {
  setBrightness(fixtureIds: string[], brightness: number): Promise<BleMeshCommandReport[]>;
  onFixtureStatus(listener: (status: BleMeshFixtureStatus) => void): () => void;
  resyncFixtureStates(): Promise<void>;
}

export interface BleMeshFixtureStatus {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  status: "online" | "fault";
  faultCode?: string;
  rssi: number | null;
  hopCount: number | null;
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
