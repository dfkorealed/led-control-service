import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import type { BleMeshResyncReport } from "../gateway";

export interface ApplianceHealthState {
  version: 1;
  status: "starting-unassigned" | "starting" | "healthy" | "unhealthy";
  assignment: boolean;
  mesh: boolean;
  mqtt: boolean;
  mapping: boolean;
  dbusOwner: boolean;
  bluezAttached: boolean;
  hciPowered: boolean;
  mappingValid: boolean;
  heartbeatFresh: boolean;
  lastHeartbeatPublishedAt: string | null;
  meshResync: BleMeshResyncReport | null;
  updatedAt: string;
  reason?: string;
}

export interface ApplianceHealthProbes {
  dbusOwner: () => Promise<boolean>;
  bluezAttached: () => Promise<boolean>;
  hciPowered: () => Promise<boolean>;
  mappingValid: () => Promise<boolean>;
}

export interface ApplianceHealthOptions {
  now?: () => Date;
  heartbeatMs?: number;
  probes?: ApplianceHealthProbes;
}

export class ApplianceHealth {
  private readonly now: () => Date;
  private readonly heartbeatMs: number;
  private probes: ApplianceHealthProbes;
  private assignment = false;
  private mqtt = false;
  private lastHeartbeatPublishedAt: Date | null = null;
  private lastMeshResync: BleMeshResyncReport | null = null;
  private meshResyncFailure: string | undefined;

  constructor(
    private readonly path: string,
    options: ApplianceHealthOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.heartbeatMs = parseHeartbeatInterval(options.heartbeatMs);
    this.probes = options.probes ?? unavailableProbes;
  }

  setProbes(probes: ApplianceHealthProbes) {
    this.probes = probes;
  }

  startingUnassigned() {
    this.assignment = false;
    this.mqtt = false;
    this.lastHeartbeatPublishedAt = null;
    return this.write({
      status: "starting-unassigned",
      assignment: false,
      mesh: false,
      mqtt: false,
      mapping: false,
      dbusOwner: false,
      bluezAttached: false,
      hciPowered: false,
      mappingValid: false,
      heartbeatFresh: false,
      lastHeartbeatPublishedAt: null,
      meshResync: null
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

  recordMeshResync(report: BleMeshResyncReport) {
    this.lastMeshResync = report;
    this.meshResyncFailure = meshResyncFailureReason(report);
    return this.refresh();
  }

  async refresh(reason?: string) {
    const [dbusOwner, bluezAttached, hciPowered, mappingValid] = await Promise.all([
      probe(this.probes.dbusOwner),
      probe(this.probes.bluezAttached),
      probe(this.probes.hciPowered),
      probe(this.probes.mappingValid)
    ]);
    const mesh = dbusOwner && bluezAttached && hciPowered;
    const mapping = mappingValid;
    const lastHeartbeatPublishedAt = this.lastHeartbeatPublishedAt?.toISOString() ?? null;
    const heartbeatFresh = this.isHeartbeatFresh();
    const failure = reason ?? this.meshResyncFailure;
    const status = !this.assignment
      ? "starting-unassigned"
      : this.mqtt && mesh && mapping && heartbeatFresh && !failure
        ? "healthy"
        : failure || this.mqtt
          ? "unhealthy"
          : "starting";
    return this.write({
      status,
      assignment: this.assignment,
      mesh,
      mqtt: this.mqtt,
      mapping,
      dbusOwner,
      bluezAttached,
      hciPowered,
      mappingValid,
      heartbeatFresh,
      lastHeartbeatPublishedAt,
      meshResync: this.lastMeshResync,
      ...(status === "unhealthy" ? { reason: failure ?? healthFailureReason({ dbusOwner, bluezAttached, hciPowered, mappingValid, heartbeatFresh }) } : {})
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
}

export function parseHeartbeatInterval(value: number | undefined) {
  const heartbeatMs = value ?? 5_000;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 86_400_000) {
    throw new Error("heartbeat interval must be a positive finite integer no greater than 86400000ms");
  }
  return heartbeatMs;
}

const unavailableProbes: ApplianceHealthProbes = {
  dbusOwner: async () => false,
  bluezAttached: async () => false,
  hciPowered: async () => false,
  mappingValid: async () => false
};

async function probe(check: () => Promise<boolean>) {
  try {
    return await check();
  } catch {
    return false;
  }
}

function healthFailureReason(state: {
  dbusOwner: boolean;
  bluezAttached: boolean;
  hciPowered: boolean;
  mappingValid: boolean;
  heartbeatFresh: boolean;
}) {
  if (!state.dbusOwner) return "dbus_owner_missing";
  if (!state.bluezAttached) return "bluez_not_attached";
  if (!state.hciPowered) return "hci_not_powered";
  if (!state.mappingValid) return "mapping_invalid";
  return "heartbeat_stale";
}

function meshResyncFailureReason(report: BleMeshResyncReport) {
  if (report.total === 0 || report.observed > 0) return undefined;
  if (report.failed === report.total) return "mesh_resync_all_failed";
  if (report.timedOut === report.total) return "mesh_resync_all_timed_out";
  return "mesh_resync_no_observations";
}
