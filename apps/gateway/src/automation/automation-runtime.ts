import {
  automationConfigAppliedSchema,
  type AutomationConfigApplied,
  type AutomationSnapshot,
  type AutomationSnapshotV2, type AutomationSnapshotV3
} from "@led-control/shared";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import {
  AutomationConfigStoreError,
  AutomationConfigCommitUncertainError,
  parseAutomationSnapshot,
  type AutomationConfigStore,
  type AutomationScope
} from "./automation-config-store";
import { AutomationStateCommitUncertainError } from "./automation-state-store";
import type { BioSnapshotLifecycle } from "../bio/bio-pulse-authority-provider";

export type DesiredLightingState = Readonly<Record<string, number>>;

export type AutomationRuntimeErrorCode =
  | "snapshot_invalid"
  | "bio_pulse_control_unavailable"
  | "snapshot_scope_mismatch"
  | "snapshot_hash_mismatch"
  | "snapshot_old_revision"
  | "snapshot_revision_conflict"
  | "snapshot_commit_uncertain"
  | "snapshot_store_failed"
  | "automation_state_commit_uncertain"
  | "snapshot_recompute_failed"
  | "snapshot_rollback_failed";

export class AutomationRuntimeError extends Error {
  constructor(
    readonly code: AutomationRuntimeErrorCode,
    message: string,
    readonly revision?: number,
    readonly payloadHash?: `sha256:${string}`,
    options?: ErrorOptions,
    readonly acknowledgeable = true
  ) {
    super(message, options);
    this.name = "AutomationRuntimeError";
  }
}

interface AutomationRuntimeOptions {
  store: AutomationConfigStore;
  scope: AutomationScope;
  recompute: (snapshot: AutomationSnapshot) => Promise<DesiredLightingState>;
  applyDesiredState: (next: DesiredLightingState, previous: DesiredLightingState) => Promise<void>;
  onActivated?: (snapshot: AutomationSnapshot) => Promise<void>;
  onActivationFailed?: (previous: AutomationSnapshot | null) => Promise<void>;
  now?: () => Date;
  /** Trusted bootstrap-only preflight. Default unavailable; not an env capability. */
  bioSnapshotPreflight?: (snapshot: AutomationSnapshotV2 | AutomationSnapshotV3) => Promise<void>;
  bioSnapshotLifecycle?: BioSnapshotLifecycle;
  recoverDegradedBioSnapshot?: (snapshot: AutomationSnapshotV2 | AutomationSnapshotV3) => Promise<DesiredLightingState>;
}

export class AutomationRuntime {
  private readonly queue = new SerialTaskQueue();
  private readonly now: () => Date;
  private snapshot: AutomationSnapshot | null = null;
  private desiredState: DesiredLightingState = {};
  private initialized = false;
  private degradedRecovery = false;
  private activating = false;

  constructor(private readonly options: AutomationRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get currentRevision() {
    return this.degradedRecovery ? null : this.snapshot?.revision ?? null;
  }

  get gatewayId() {
    return this.options.scope.gatewayId;
  }

  get currentSnapshot() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  /** Swapping a candidate for recomputation does not make it applied authority. */
  get currentAppliedSnapshot() {
    return this.activating || this.degradedRecovery ? null : this.currentSnapshot;
  }

  initialize() {
    return this.queue.run(async () => {
      if (this.initialized) return;
      const recovered = await this.options.store.load();
      if (recovered) {
        this.parse(recovered);
        this.options.bioSnapshotLifecycle?.stage(recovered);
        try {
          await this.preflight(recovered);
          await this.activate(recovered, false);
          this.options.bioSnapshotLifecycle?.commit(recovered);
        } catch (error) {
          this.options.bioSnapshotLifecycle?.rollback(recovered);
          if (error instanceof AutomationRuntimeError && error.code === "bio_pulse_control_unavailable" && (recovered.schemaVersion === 2 || recovered.schemaVersion === 3)
            && this.options.bioSnapshotLifecycle?.retain && this.options.recoverDegradedBioSnapshot) {
            this.options.bioSnapshotLifecycle.retain(recovered);
            const desired = normalizeDesiredState(await this.options.recoverDegradedBioSnapshot(recovered));
            await this.options.applyDesiredState(desired, this.desiredState);
            await this.options.onActivated?.(recovered);
            this.desiredState = desired; this.snapshot = recovered; this.degradedRecovery = true; this.initialized = true;
            return;
          }
          await this.rollbackActivation(null, recovered, error, false);
          throw error;
        }
      }
      this.initialized = true;
    });
  }

  hotReload(value: unknown): Promise<AutomationConfigApplied> {
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
          if (!this.degradedRecovery) return this.applied(snapshot);
        }
      }

      this.options.bioSnapshotLifecycle?.stage(snapshot);
      try { await this.preflight(snapshot); }
      catch (error) { this.options.bioSnapshotLifecycle?.rollback(snapshot); throw error; }

      try {
        await this.options.store.apply(snapshot);
      } catch (error) {
        this.options.bioSnapshotLifecycle?.rollback(snapshot);
        if (error instanceof AutomationConfigCommitUncertainError) {
          throw new AutomationRuntimeError(
            "snapshot_commit_uncertain",
            "snapshot_commit_uncertain",
            snapshot.revision,
            snapshot.payloadHash,
            { cause: error },
            false
          );
        }
        throw new AutomationRuntimeError(
          "snapshot_store_failed",
          "snapshot_store_failed",
          snapshot.revision,
          snapshot.payloadHash,
          { cause: error }
        );
      }
      try {
        await this.activate(snapshot, true);
        this.options.bioSnapshotLifecycle?.commit(snapshot);
      } catch (error) {
        this.options.bioSnapshotLifecycle?.rollback(snapshot);
        await this.rollbackActivation(current, snapshot, error, true);
        throw error;
      }
      this.initialized = true;
      this.degradedRecovery = false;
      return this.applied(snapshot);
    });
  }

  private parse(value: unknown) {
    try {
      const snapshot = parseAutomationSnapshot(value, this.options.scope);
      // Declared V2 support confirms transport/configuration ability only.
      // Product BIO execution remains OFF until its independent authority is wired.
      if (!this.options.bioSnapshotPreflight && (snapshot.schemaVersion === 2 || snapshot.schemaVersion === 3) && snapshot.vehicleEventRules.some(rule =>
        rule.sensorProtocol === "bio-usb-pulse" && rule.status === "enabled")) {
        throw runtimeError("bio_pulse_control_unavailable", snapshot);
      }
      return snapshot;
    } catch (error) {
      if (error instanceof AutomationConfigStoreError) {
        const identity = snapshotIdentity(value);
        throw new AutomationRuntimeError(error.code, error.code, identity.revision, identity.payloadHash, { cause: error });
      }
      throw error;
    }
  }

  private async preflight(snapshot: AutomationSnapshot): Promise<void> {
    if ((snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3) || !snapshot.vehicleEventRules.some(rule => rule.sensorProtocol === "bio-usb-pulse" && rule.status === "enabled")) return;
    try { await this.options.bioSnapshotPreflight!(snapshot); }
    catch (cause) { throw new AutomationRuntimeError("bio_pulse_control_unavailable", "bio_pulse_control_unavailable",
      snapshot.revision, snapshot.payloadHash, { cause }); }
  }

  private async activate(snapshot: AutomationSnapshot, swapBeforeRecompute: boolean) {
    this.activating = true;
    const previousSnapshot = this.snapshot;
    if (swapBeforeRecompute) this.snapshot = snapshot;
    try {
      const nextDesired = normalizeDesiredState(await this.options.recompute(snapshot));
      if (!sameDesiredState(this.desiredState, nextDesired)) {
        await this.options.applyDesiredState(nextDesired, this.desiredState);
      }
      await this.options.onActivated?.(snapshot);
      this.desiredState = nextDesired;
      this.snapshot = snapshot;
    } catch (error) {
      this.snapshot = previousSnapshot;
      if (error instanceof AutomationStateCommitUncertainError) {
        throw new AutomationRuntimeError(
          "automation_state_commit_uncertain",
          "automation_state_commit_uncertain",
          snapshot.revision,
          snapshot.payloadHash,
          { cause: error },
          false
        );
      }
      throw new AutomationRuntimeError(
        "snapshot_recompute_failed",
        "snapshot_recompute_failed",
        snapshot.revision,
        snapshot.payloadHash,
        { cause: error }
      );
    } finally { this.activating = false; }
  }

  private async rollbackActivation(
    previous: AutomationSnapshot | null,
    attempted: AutomationSnapshot,
    activationError: unknown,
    restoreConfig: boolean
  ) {
    const rollbackErrors: unknown[] = [];
    if (restoreConfig) {
      try {
        await this.options.store.restore(previous);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    try {
      await this.options.onActivationFailed?.(previous);
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      throw new AutomationRuntimeError(
        "snapshot_rollback_failed",
        "snapshot_rollback_failed",
        attempted.revision,
        attempted.payloadHash,
        { cause: new AggregateError([activationError, ...rollbackErrors], "snapshot rollback failed") },
        false
      );
    }
  }

  private applied(snapshot: AutomationSnapshot): AutomationConfigApplied {
    return automationConfigAppliedSchema.parse({
      schemaVersion: snapshot.schemaVersion,
      gatewayId: this.options.scope.gatewayId,
      revision: snapshot.revision,
      payloadHash: snapshot.payloadHash,
      status: "applied",
      errorCode: null,
      appliedAt: this.now().toISOString()
    }) as AutomationConfigApplied;
  }
}

function runtimeError(code: AutomationRuntimeErrorCode, snapshot: AutomationSnapshot) {
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
