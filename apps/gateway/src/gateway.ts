import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  DimmingCommandPayload,
  FixtureState,
  GatewayHeartbeatPayload,
  IdentifyDevicePayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningFailedPayload,
  ProvisioningScanStartPayload,
  UnprovisionedDeviceFoundPayload
} from "@led-control/shared";

export interface BleMeshAdapter {
  setBrightness(fixtureIds: string[], brightness: number): Promise<BleMeshCommandReport[]>;
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

export interface CommandAckPayload {
  commandId: string;
  status: "acknowledged" | "failed";
  acknowledgedAt?: string;
  errorMessage?: string;
}

export class StubBleMeshAdapter implements BleMeshAdapter {
  readonly commands: Array<{ fixtureIds: string[]; brightness: number }> = [];

  async setBrightness(fixtureIds: string[], brightness: number) {
    this.commands.push({ fixtureIds, brightness });
    return fixtureIds.map((fixtureId) => ({
      fixtureId,
      acknowledged: true,
      brightness,
      rssi: null,
      hopCount: null
    }));
  }
}

export class StubProvisioningScannerAdapter implements ProvisioningScannerAdapter {
  constructor(
    private readonly options: {
      count?: number;
      floorName?: string;
    } = {}
  ) {}

  async scan(command: ProvisioningScanStartPayload) {
    const count = this.options.count ?? Number(process.env.GATEWAY_STUB_DISCOVERY_COUNT ?? 4);
    const floorName = this.options.floorName ?? process.env.GATEWAY_STUB_FLOOR_NAME ?? "B2";
    const floorCode = floorName.toLowerCase().replace(/[^a-z0-9]/g, "") || "floor";
    const serialFloorCode = floorName.toUpperCase().replace(/[^A-Z0-9]/g, "") || "FLOOR";
    const discoveredAt = new Date().toISOString();

    return Array.from({ length: count }, (_, index) => {
      const sequence = String(index + 1).padStart(3, "0");
      return {
        sessionId: command.sessionId,
        deviceUuid: `esp32h2-${floorCode}-${sequence}`,
        serialNumber: `LC-${serialFloorCode}-${sequence}`,
        rssi: -54 - index * 3,
        oobCapability: "static-oob" as const,
        firmwareVersion: "esp32h2-stub-0.1.0",
        discoveredAt
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
      firmwareVersion: "esp32h2-stub-0.1.0",
      rssi: -58,
      hopCount: 1,
      completedAt: new Date().toISOString()
    };
  }
}

export class CommandProvisioningScannerAdapter implements ProvisioningScannerAdapter {
  constructor(private readonly command: string) {}

  async scan(input: ProvisioningScanStartPayload) {
    const rows = await executeJsonLinesCommand(this.command, input);
    return rows.map((row) => ({
      sessionId: input.sessionId,
      deviceUuid: requiredString(row.deviceUuid, "deviceUuid"),
      serialNumber: typeof row.serialNumber === "string" && row.serialNumber ? row.serialNumber : requiredString(row.deviceUuid, "deviceUuid"),
      rssi: typeof row.rssi === "number" ? row.rssi : -99,
      oobCapability: parseOobCapability(row.oobCapability),
      firmwareVersion: typeof row.firmwareVersion === "string" && row.firmwareVersion ? row.firmwareVersion : "unknown",
      discoveredAt: typeof row.discoveredAt === "string" && row.discoveredAt ? row.discoveredAt : new Date().toISOString()
    }));
  }
}

export class CommandProvisioningAdapter implements ProvisioningAdapter {
  constructor(
    private readonly provisionCommand: string,
    private readonly identifyCommand?: string
  ) {}

  async identify(command: IdentifyDevicePayload) {
    if (!this.identifyCommand) return;
    await executeJsonLinesCommand(this.identifyCommand, command);
  }

  async provision(command: ProvisionDevicePayload): Promise<ProvisioningCompletedPayload> {
    const [result = {}] = await executeJsonLinesCommand(this.provisionCommand, command);
    return {
      sessionId: command.sessionId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: typeof result.meshAddress === "string" && result.meshAddress ? result.meshAddress : command.meshAddress,
      firmwareVersion: typeof result.firmwareVersion === "string" && result.firmwareVersion ? result.firmwareVersion : undefined,
      rssi: typeof result.rssi === "number" ? result.rssi : null,
      hopCount: typeof result.hopCount === "number" ? result.hopCount : null,
      completedAt: typeof result.completedAt === "string" && result.completedAt ? result.completedAt : new Date().toISOString()
    };
  }
}

export async function applyManualDimmingCommand(adapter: BleMeshAdapter, command: DimmingCommandPayload) {
  const fixtureIds = resolveFixtureIds(command);
  if (fixtureIds.length === 0) {
    return {
      ack: {
        commandId: command.commandId,
        status: "failed" as const,
        acknowledgedAt: new Date().toISOString(),
        errorMessage: "No fixture ids resolved for dimming command"
      },
      fixtureStates: []
    };
  }

  try {
    const reports = await adapter.setBrightness(fixtureIds, command.brightness);
    const now = new Date().toISOString();
    const failedReports = reports.filter((report) => !report.acknowledged);
    return {
      ack: {
        commandId: command.commandId,
        status: failedReports.length > 0 ? ("failed" as const) : ("acknowledged" as const),
        acknowledgedAt: now,
        ...(failedReports.length > 0 ? { errorMessage: createFailureMessage(failedReports) } : {})
      },
      fixtureStates: reports.map((report) => createFixtureState(report, now))
    };
  } catch (error) {
    return {
      ack: {
        commandId: command.commandId,
        status: "failed" as const,
        acknowledgedAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : "Unknown BLE Mesh adapter error"
      },
      fixtureStates: []
    };
  }
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

export function createHeartbeatPayload(
  siteId: string,
  gatewaySerial: string,
  now = new Date(),
  firmwareVersion?: string
): GatewayHeartbeatPayload {
  return {
    siteId,
    gatewaySerial,
    ...(firmwareVersion ? { firmwareVersion } : {}),
    sentAt: now.toISOString()
  };
}

function resolveFixtureIds(command: DimmingCommandPayload) {
  if (command.targetFixtureIds?.length) return command.targetFixtureIds;
  if (command.targetType === "fixture") return [command.targetId];
  return [];
}

function createFixtureState(report: BleMeshCommandReport, now: string): FixtureState {
  return {
    fixtureId: report.fixtureId,
    brightness: report.acknowledged ? report.brightness : 0,
    powerOn: report.acknowledged && report.brightness > 0,
    status: report.acknowledged ? "online" : "fault",
    rssi: report.rssi,
    hopCount: report.hopCount,
    commandSuccessRate: report.acknowledged ? 1 : 0,
    lastSeenAt: now
  };
}

function createFailureMessage(failedReports: BleMeshCommandReport[]) {
  const failures = failedReports.map((report) => `${report.fixtureId}(${report.faultCode ?? "unknown"})`).join(", ");
  return `${failedReports.length} fixture command failed: ${failures}`;
}

async function executeJsonLinesCommand(command: string, input: unknown): Promise<Array<Record<string, unknown>>> {
  const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();

  const rows: Array<Record<string, unknown>> = [];
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Provisioning command returned non-object JSON line: ${trimmed}`);
    }
    rows.push(parsed as Record<string, unknown>);
  }

  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    throw new Error(stderr || `Provisioning command exited with code ${exitCode}`);
  }
  return rows;
}

function requiredString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Provisioning command result missing ${fieldName}`);
  return value;
}

function parseOobCapability(value: unknown): UnprovisionedDeviceFoundPayload["oobCapability"] {
  if (value === "none" || value === "static-oob" || value === "output-oob" || value === "input-oob") return value;
  return "none";
}
