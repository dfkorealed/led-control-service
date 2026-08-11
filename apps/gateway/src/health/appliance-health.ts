import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";

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

  constructor(
    private readonly path: string,
    options: ApplianceHealthOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
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
      lastHeartbeatPublishedAt: null
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
    const status = !this.assignment
      ? "starting-unassigned"
      : this.mqtt && mesh && mapping && heartbeatFresh
        ? "healthy"
        : reason || this.mqtt
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
      ...(status === "unhealthy" ? { reason: reason ?? healthFailureReason({ dbusOwner, bluezAttached, hciPowered, mappingValid, heartbeatFresh }) } : {})
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
    return this.now().getTime() - this.lastHeartbeatPublishedAt.getTime() <= Math.max(30_000, this.heartbeatMs * 3);
  }
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
