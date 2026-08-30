import {
  automationConfigAppliedV1Schema,
  type AutomationConfigAppliedV1,
  type AutomationSnapshotV1
} from "@led-control/shared";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import {
  AutomationConfigStoreError,
  parseAutomationSnapshot,
  type AutomationConfigStore,
  type AutomationScope
} from "./automation-config-store";

export type DesiredLightingState = Readonly<Record<string, number>>;

export type AutomationRuntimeErrorCode =
  | "snapshot_invalid"
  | "snapshot_scope_mismatch"
  | "snapshot_hash_mismatch"
  | "snapshot_old_revision"
  | "snapshot_revision_conflict"
  | "snapshot_store_failed"
  | "snapshot_recompute_failed";

export class AutomationRuntimeError extends Error {
  constructor(
    readonly code: AutomationRuntimeErrorCode,
    message: string,
    readonly revision?: number,
    readonly payloadHash?: `sha256:${string}`,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AutomationRuntimeError";
  }
}

interface AutomationRuntimeOptions {
  store: AutomationConfigStore;
  scope: AutomationScope;
  recompute: (snapshot: AutomationSnapshotV1) => Promise<DesiredLightingState>;
  applyDesiredState: (next: DesiredLightingState, previous: DesiredLightingState) => Promise<void>;
  now?: () => Date;
}

export class AutomationRuntime {
  private readonly queue = new SerialTaskQueue();
  private readonly now: () => Date;
  private snapshot: AutomationSnapshotV1 | null = null;
  private desiredState: DesiredLightingState = {};
  private initialized = false;

  constructor(private readonly options: AutomationRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get currentRevision() {
    return this.snapshot?.revision ?? null;
  }

  get gatewayId() {
    return this.options.scope.gatewayId;
  }

  get currentSnapshot() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  initialize() {
    return this.queue.run(async () => {
      if (this.initialized) return;
      const recovered = await this.options.store.load();
      if (recovered) await this.activate(recovered, false);
      this.initialized = true;
    });
  }

  hotReload(value: unknown): Promise<AutomationConfigAppliedV1> {
    return this.queue.run(async () => {
      const snapshot = this.parse(value);
      const current = this.snapshot;
      if (current) {
        if (snapshot.revision < current.revision) {
          throw runtimeError("snapshot_old_revision", snapshot);
        }
        if (snapshot.revision === current.revision) {
          if (snapshot.payloadHash !== current.payloadHash) {
            throw runtimeError("snapshot_revision_conflict", snapshot);
          }
          return this.applied(snapshot);
        }
      }

      try {
        await this.options.store.apply(snapshot);
      } catch (error) {
        throw new AutomationRuntimeError(
          "snapshot_store_failed",
          "snapshot_store_failed",
          snapshot.revision,
          snapshot.payloadHash,
          { cause: error }
        );
      }
      await this.activate(snapshot, true);
      this.initialized = true;
      return this.applied(snapshot);
    });
  }

  private parse(value: unknown) {
    try {
      return parseAutomationSnapshot(value, this.options.scope);
    } catch (error) {
      if (error instanceof AutomationConfigStoreError) {
        const identity = snapshotIdentity(value);
        throw new AutomationRuntimeError(error.code, error.code, identity.revision, identity.payloadHash, { cause: error });
      }
      throw error;
    }
  }

  private async activate(snapshot: AutomationSnapshotV1, swapBeforeRecompute: boolean) {
    const previousSnapshot = this.snapshot;
    if (swapBeforeRecompute) this.snapshot = snapshot;
    try {
      const nextDesired = normalizeDesiredState(await this.options.recompute(snapshot));
      if (!sameDesiredState(this.desiredState, nextDesired)) {
        await this.options.applyDesiredState(nextDesired, this.desiredState);
      }
      this.desiredState = nextDesired;
      this.snapshot = snapshot;
    } catch (error) {
      this.snapshot = previousSnapshot;
      throw new AutomationRuntimeError(
        "snapshot_recompute_failed",
        "snapshot_recompute_failed",
        snapshot.revision,
        snapshot.payloadHash,
        { cause: error }
      );
    }
  }

  private applied(snapshot: AutomationSnapshotV1): AutomationConfigAppliedV1 {
    return automationConfigAppliedV1Schema.parse({
      schemaVersion: 1,
      gatewayId: this.options.scope.gatewayId,
      revision: snapshot.revision,
      payloadHash: snapshot.payloadHash,
      status: "applied",
      errorCode: null,
      appliedAt: this.now().toISOString()
    }) as AutomationConfigAppliedV1;
  }
}

function runtimeError(code: AutomationRuntimeErrorCode, snapshot: AutomationSnapshotV1) {
  return new AutomationRuntimeError(code, code, snapshot.revision, snapshot.payloadHash);
}

function snapshotIdentity(value: unknown): {
  revision?: number;
  payloadHash?: `sha256:${string}`;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  return {
    ...(Number.isInteger(candidate.revision) && (candidate.revision as number) >= 0
      ? { revision: candidate.revision as number }
      : {}),
    ...(typeof candidate.payloadHash === "string" && /^sha256:[a-f0-9]{64}$/.test(candidate.payloadHash)
      ? { payloadHash: candidate.payloadHash as `sha256:${string}` }
      : {})
  };
}

function normalizeDesiredState(value: DesiredLightingState): DesiredLightingState {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sameDesiredState(left: DesiredLightingState, right: DesiredLightingState) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length &&
    leftEntries.every(([fixtureId, brightness]) => right[fixtureId] === brightness);
}
