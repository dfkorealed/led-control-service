import { randomUUID } from "node:crypto";
import {
  type MeshGroupResyncAckV2,
  type MeshGroupResyncRequestV2,
  meshGroupResyncAckV2Schema,
  meshGroupResyncRequestV2Schema,
  mqttTopicsV2
} from "@led-control/shared";
import type { GroupStateRestoreReason } from "./group-state-store";
import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

interface StoredResyncRequest {
  version: 1;
  revision: number;
  pending: MeshGroupResyncRequestV2 | null;
}

interface StoreManifest {
  version: 1;
  revision: number;
}

type Scope = { siteId: string; gatewayId: string };

export function createMeshGroupResyncRequest(
  scope: Scope,
  reason: GroupStateRestoreReason,
  now: () => string = () => new Date().toISOString(),
  eventId: () => string = randomUUID
) {
  return meshGroupResyncRequestV2Schema.parse({ ...scope, eventId: eventId(), occurredAt: now(), reason });
}

export class MeshGroupResyncStore {
  private state: StoredResyncRequest = { version: 1, revision: 0, pending: null };
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly scope: Scope,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly eventId: () => string = randomUUID
  ) {}

  initialize(reason: GroupStateRestoreReason) {
    return this.exclusive(async () => {
      if (this.initialized) return;
      await this.restore(reason);
      this.initialized = true;
    });
  }

  pending() {
    return this.exclusive(async () => {
      this.assertInitialized();
      return this.state.pending ? { ...this.state.pending } : null;
    });
  }

  acknowledge(value: unknown) {
    return this.exclusive(async () => {
      this.assertInitialized();
      const acknowledgement = meshGroupResyncAckV2Schema.parse(value);
      const pending = this.state.pending;
      if (
        !pending ||
        acknowledgement.siteId !== this.scope.siteId ||
        acknowledgement.gatewayId !== this.scope.gatewayId ||
        acknowledgement.requestEventId !== pending.eventId
      ) return false;
      await this.persist(null);
      return true;
    });
  }

  private async restore(reason: GroupStateRestoreReason) {
    let rawState: unknown | null;
    let rawManifest: unknown | null;
    try {
      [rawState, rawManifest] = await Promise.all([readJsonFile(this.path), readJsonFile(`${this.path}.manifest`)]);
    } catch {
      await this.replaceWithFailSafe("state_corrupt");
      return;
    }

    if (rawState === null && rawManifest === null) {
      await this.persist(reason === "startup" ? null : createMeshGroupResyncRequest(this.scope, reason, this.now, this.eventId));
      return;
    }
    if (rawState === null && rawManifest !== null) {
      await this.replaceWithFailSafe("state_missing");
      return;
    }
    try {
      const state = parseState(rawState);
      const manifest = parseManifest(rawManifest);
      if (state.revision !== manifest.revision) throw new Error("resync state revision mismatch");
      if (state.pending && (state.pending.siteId !== this.scope.siteId || state.pending.gatewayId !== this.scope.gatewayId)) {
        throw new Error("resync state scope mismatch");
      }
      this.state = state;
      if (reason !== "startup" && !state.pending) {
        await this.persist(createMeshGroupResyncRequest(this.scope, reason, this.now, this.eventId));
      }
    } catch {
      await this.replaceWithFailSafe("state_corrupt");
    }
  }

  private replaceWithFailSafe(reason: "state_missing" | "state_corrupt") {
    this.state = { version: 1, revision: 0, pending: null };
    return this.persist(createMeshGroupResyncRequest(this.scope, reason, this.now, this.eventId));
  }

  private async persist(pending: MeshGroupResyncRequestV2 | null) {
    const next = { version: 1, revision: this.state.revision + 1, pending } satisfies StoredResyncRequest;
    await writeJsonAtomic(`${this.path}.manifest`, { version: 1, revision: next.revision } satisfies StoreManifest);
    await writeJsonAtomic(this.path, next);
    this.state = next;
  }

  private assertInitialized() {
    if (!this.initialized) throw new Error("mesh group resync store is not initialized");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class MeshGroupResyncPublisher {
  private inFlight: Promise<void> | undefined;

  constructor(private readonly scope: Scope, private readonly store: MeshGroupResyncStore) {}

  publishPending(publish: (topic: string, payload: MeshGroupResyncRequestV2) => Promise<void>) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.store.pending()
      .then((payload) => payload
        ? publish(mqttTopicsV2.meshGroupResyncRequest(this.scope.siteId, this.scope.gatewayId), payload)
        : undefined)
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  acknowledge(payload: unknown): Promise<boolean> {
    return this.store.acknowledge(payload as MeshGroupResyncAckV2);
  }
}

function parseState(value: unknown): StoredResyncRequest {
  if (!isRecord(value) || value.version !== 1 || !isPositiveInteger(value.revision)) {
    throw new Error("invalid resync state");
  }
  return {
    version: 1,
    revision: value.revision,
    pending: value.pending === null ? null : meshGroupResyncRequestV2Schema.parse(value.pending)
  };
}

function parseManifest(value: unknown): StoreManifest {
  if (!isRecord(value) || value.version !== 1 || !isPositiveInteger(value.revision)) {
    throw new Error("invalid resync manifest");
  }
  return { version: 1, revision: value.revision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
