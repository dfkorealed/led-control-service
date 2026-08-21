import type {
  IdentifyDevicePayload,
  MeshGroupSubscriptionResultPayload,
  MeshGroupSubscriptionSyncPayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningScanStartPayload
} from "@led-control/shared";
import type { BleMeshAdapter, BleMeshFixtureStatus, ProvisioningAdapter, ProvisioningScannerAdapter } from "../src/gateway";

export class StubBleMeshAdapter implements BleMeshAdapter {
  readonly commands: Array<{ fixtureIds: string[]; brightness: number }> = [];
  private readonly fixtureStatusListeners = new Set<(status: BleMeshFixtureStatus) => void>();
  async setBrightness(fixtureIds: string[], brightness: number) {
    this.commands.push({ fixtureIds, brightness });
    return fixtureIds.map((fixtureId) => ({ fixtureId, acknowledged: true, brightness, rssi: null, hopCount: null }));
  }
  onFixtureStatus(listener: (status: BleMeshFixtureStatus) => void) {
    this.fixtureStatusListeners.add(listener);
    return () => this.fixtureStatusListeners.delete(listener);
  }
  async resyncFixtureStates() {
    return { total: 0, configured: 0, observed: 0, healthPending: 0, timedOut: 0, failed: 0 };
  }
  async syncGroupSubscriptions(command: MeshGroupSubscriptionSyncPayload): Promise<MeshGroupSubscriptionResultPayload> {
    return {
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      groupId: command.groupId,
      version: command.version,
      groupAddress: command.groupAddress,
      members: command.members.map((member) => ({ meshNodeId: member.meshNodeId, status: "applied" as const })),
      occurredAt: new Date().toISOString()
    };
  }
}

export class StubProvisioningScannerAdapter implements ProvisioningScannerAdapter {
  constructor(private readonly options: { count?: number; floorName?: string } = {}) {}
  async scan(command: ProvisioningScanStartPayload) {
    const count = this.options.count ?? 4;
    const floorName = this.options.floorName ?? "B2";
    const floorCode = floorName.toLowerCase().replace(/[^a-z0-9]/g, "") || "floor";
    const serialFloorCode = floorName.toUpperCase().replace(/[^A-Z0-9]/g, "") || "FLOOR";
    return Array.from({ length: count }, (_, index) => {
      const sequence = String(index + 1).padStart(3, "0");
      return {
        sessionId: command.sessionId,
        deviceUuid: `esp32h2-${floorCode}-${sequence}`,
        serialNumber: `LC-${serialFloorCode}-${sequence}`,
        rssi: -54 - index * 3,
        oobCapability: "static-oob" as const,
        firmwareVersion: "esp32h2-test-0.1.0",
        discoveredAt: new Date().toISOString()
      };
    });
  }
}

export class StubProvisioningAdapter implements ProvisioningAdapter {
  readonly identifiedDeviceUuids: string[] = [];
  readonly provisionedDeviceUuids: string[] = [];
  async identify(command: IdentifyDevicePayload) {
    this.identifiedDeviceUuids.push(command.deviceUuid);
  }
  async provision(command: ProvisionDevicePayload): Promise<ProvisioningCompletedPayload> {
    this.provisionedDeviceUuids.push(command.deviceUuid);
    return {
      sessionId: command.sessionId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress,
      firmwareVersion: "esp32h2-test-0.1.0",
      rssi: -58,
      hopCount: 1,
      completedAt: new Date().toISOString()
    };
  }
}
