import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import type { BleMeshResyncReport } from "../gateway";

export interface ApplianceHealthState {
  version: 1;
  adapterKind: "bluez" | "bio-usb";
  status: "starting-unassigned" | "starting" | "healthy" | "unhealthy";
  assignment: boolean;
  mesh: boolean;
  mqtt: boolean;
  mapping: boolean;
  dbusOwner?: boolean;
  bluezAttached?: boolean;
  transportConnected?: boolean;
  protocolReady?: boolean;
  mappingValid: boolean;
  heartbeatFresh: boolean;
  lastHeartbeatPublishedAt: string | null;
  meshResync: BleMeshResyncReport | null;
  updatedAt: string;
  reason?: string;
}

export interface BluezApplianceHealthProbes {
  adapterKind: "bluez";
  dbusOwner: () => Promise<boolean>;
  bluezAttached: () => Promise<boolean>;
  mappingValid: () => Promise<boolean>;
}

export interface BioUsbApplianceHealthProbes {
  adapterKind: "bio-usb";
  transportConnected: () => Promise<boolean>;
  protocolReady: () => Promise<boolean>;
  mappingValid: () => Promise<boolean>;
}

export type ApplianceHealthProbes = BluezApplianceHealthProbes | BioUsbApplianceHealthProbes;

export interface ApplianceHealthOptions {
  now?: () => Date;
  heartbeatMs?: number;
  adapterKind?: ApplianceHealthProbes["adapterKind"];
  probes?: ApplianceHealthProbes;
}

export class ApplianceHealth {
  private readonly now: () => Date;
  private readonly heartbeatMs: number;
  private readonly adapterKind: ApplianceHealthProbes["adapterKind"];
  private probes: ApplianceHealthProbes;
  private assignment = false;
  private mqtt = false;
  private lastHeartbeatPublishedAt: Date | null = null;
  private lastMeshResync: BleMeshResyncReport | null = null;
  private meshResyncFailure: string | undefined;
  private readonly operationalBlockers = new Set<string>();

  constructor(
    private readonly path: string,
    options: ApplianceHealthOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.heartbeatMs = parseHeartbeatInterval(options.heartbeatMs);
    const adapterKind = options.adapterKind ?? options.probes?.adapterKind ?? "bluez";
    if (options.probes && options.probes.adapterKind !== adapterKind) {
      throw new Error("health adapter kind does not match its probes");
    }
    this.adapterKind = adapterKind;
    this.probes = options.probes ?? unavailableProbes(adapterKind);
  }

  setProbes(probes: ApplianceHealthProbes) {
    if (probes.adapterKind !== this.adapterKind) {
      throw new Error("health adapter kind does not match its probes");
    }
    this.probes = probes;
  }

  startingUnassigned() {
    this.assignment = false;
    this.mqtt = false;
    this.lastHeartbeatPublishedAt = null;
    const adapter = this.adapterState(false, false);
    return this.write({
      status: "starting-unassigned",
      adapterKind: this.probes.adapterKind,
      assignment: false,
      mesh: false,
      mqtt: false,
      mapping: false,
      mappingValid: false,
      heartbeatFresh: false,
      lastHeartbeatPublishedAt: null,
      meshResync: null,
      ...adapter
    });
  }

  startingAssigned() {
    this.assignment = true;
    return this.refresh();
  }

  meshReady() {
    return this.refresh();
  }

  healthy() {
    return this.heartbeatPublished();
  }

  mqttConnected() {
    this.mqtt = true;
    return this.refresh();
  }

  heartbeatPublished() {
    this.mqtt = true;
    this.lastHeartbeatPublishedAt = this.now();
    return this.refresh();
  }

  unhealthy(reason: string) {
    this.mqtt = false;
    return this.refresh(reason);
  }

  setOperationalBlocker(reason: string, active: boolean) {
    if (!reason) throw new Error("operational blocker reason is required");
    if (active) this.operationalBlockers.add(reason);
    else this.operationalBlockers.delete(reason);
    return this.refresh();
  }

  recordMeshResync(report: BleMeshResyncReport) {
    this.lastMeshResync = report;
    this.meshResyncFailure = meshResyncFailureReason(report);
    return this.refresh();
  }

  async refresh(reason?: string) {
    // [확인됨] adapter kind가 probe 집합을 판별한다. BIO 분기에서는 BlueZ/D-Bus
    // 함수를 구조적으로 받지 않으므로 해당 daemon을 조회하거나 필요 조건으로 만들지 않는다.
    // [추정] boolean snapshot은 그 순간의 readiness이며 raw USB descriptor/경로/UUID/payload를
    // health 파일로 운반하지 않는다. 실제 탈착 복구는 Task 8~10 현장 검증 전까지 [미확인]이다.
    const adapter = this.probes.adapterKind === "bluez"
      ? await bluezHealth(this.probes)
      : await bioUsbHealth(this.probes);
    const mesh = adapter.mesh;
    const mappingValid = adapter.mappingValid;
    const mapping = mappingValid;
    const lastHeartbeatPublishedAt = this.lastHeartbeatPublishedAt?.toISOString() ?? null;
    const heartbeatFresh = this.isHeartbeatFresh();
    const failure = this.operationalBlockers.values().next().value ?? reason ?? this.meshResyncFailure;
    const status = !this.assignment
      ? "starting-unassigned"
      : this.mqtt && mesh && mapping && heartbeatFresh && !failure
        ? "healthy"
        : failure || this.mqtt
          ? "unhealthy"
          : "starting";
    return this.write({
      status,
      adapterKind: this.probes.adapterKind,
      assignment: this.assignment,
      mesh,
      mqtt: this.mqtt,
      mapping,
      mappingValid,
      heartbeatFresh,
      lastHeartbeatPublishedAt,
      meshResync: this.lastMeshResync,
      ...adapter.details,
      ...(status === "unhealthy" ? {
        reason: failure ?? healthFailureReason(this.probes.adapterKind, adapter.details, mappingValid, heartbeatFresh)
      } : {})
    });
  }

  async read(): Promise<ApplianceHealthState | null> {
    return await readJsonFile(this.path) as ApplianceHealthState | null;
  }

  private write(state: Omit<ApplianceHealthState, "version" | "updatedAt">) {
    return writeJsonAtomic(this.path, { version: 1, ...state, updatedAt: this.now().toISOString() } satisfies ApplianceHealthState);
  }

  private isHeartbeatFresh() {
    if (!this.lastHeartbeatPublishedAt) return false;
    const age = this.now().getTime() - this.lastHeartbeatPublishedAt.getTime();
    return age >= 0 && age <= Math.max(30_000, this.heartbeatMs * 3);
  }

  private adapterState(first: boolean, second: boolean) {
    return this.probes.adapterKind === "bluez"
      ? { dbusOwner: first, bluezAttached: second }
      : { transportConnected: first, protocolReady: second };
  }
}

export function parseHeartbeatInterval(value: number | undefined) {
  const heartbeatMs = value ?? 5_000;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 86_400_000) {
    throw new Error("heartbeat interval must be a positive finite integer no greater than 86400000ms");
  }
  return heartbeatMs;
}

function unavailableProbes(adapterKind: ApplianceHealthProbes["adapterKind"]): ApplianceHealthProbes {
  if (adapterKind === "bio-usb") return {
    adapterKind,
    transportConnected: async () => false,
    protocolReady: async () => false,
    mappingValid: async () => false
  };
  return {
    adapterKind,
    dbusOwner: async () => false,
    bluezAttached: async () => false,
    mappingValid: async () => false
  };
}

async function probe(check: () => Promise<boolean>) {
  try {
    return await check();
  } catch {
    return false;
  }
}

async function bluezHealth(probes: BluezApplianceHealthProbes) {
  const [dbusOwner, bluezAttached, mappingValid] = await Promise.all([
    probe(probes.dbusOwner), probe(probes.bluezAttached), probe(probes.mappingValid)
  ]);
  return { mesh: dbusOwner && bluezAttached, mappingValid, details: { dbusOwner, bluezAttached } };
}

async function bioUsbHealth(probes: BioUsbApplianceHealthProbes) {
  const [transportConnected, protocolReady, mappingValid] = await Promise.all([
    probe(probes.transportConnected), probe(probes.protocolReady), probe(probes.mappingValid)
  ]);
  return { mesh: transportConnected && protocolReady, mappingValid, details: { transportConnected, protocolReady } };
}

function healthFailureReason(
  adapterKind: ApplianceHealthProbes["adapterKind"],
  state: { dbusOwner?: boolean; bluezAttached?: boolean; transportConnected?: boolean; protocolReady?: boolean },
  mappingValid: boolean,
  heartbeatFresh: boolean
) {
  if (adapterKind === "bluez") {
    if (!state.dbusOwner) return "dbus_owner_missing";
    if (!state.bluezAttached) return "bluez_not_attached";
  } else {
    if (!state.transportConnected) return "bio_transport_disconnected";
    if (!state.protocolReady) return "bio_protocol_not_ready";
  }
  if (!mappingValid) return "mapping_invalid";
  return "heartbeat_stale";
}

function meshResyncFailureReason(report: BleMeshResyncReport) {
  if (report.total === 0 || report.observed > 0) return undefined;
  if (report.failed === report.total) return "mesh_resync_all_failed";
  if (report.timedOut === report.total) return "mesh_resync_all_timed_out";
  return "mesh_resync_no_observations";
}
