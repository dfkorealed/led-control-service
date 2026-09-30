import type { BioConfigurationState, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import { isDeepStrictEqual } from "node:util";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import { bioEventConfiguration, parseBioConfigurationState, type FileAutomationStateStore,
  type PersistedBioTargetResult, type PersistedBioTargetState } from "./automation-state-store";

export interface BioTargetConfigurationPort {
  readBioState(fixtureId: string): Promise<{ target: BioVerifiedLampTarget; configuration: BioConfigurationState }>;
  restoreBioState(fixtureId: string, target: BioVerifiedLampTarget, configuration: BioConfigurationState): Promise<BioConfigurationState>;
}

export interface BioTargetConfigurationRequest {
  activationId: string;
  sourceFixtureId: string;
  targetFixtureIds: string[];
  brightnessPercent: number;
  protectedSourceFixtureIds: string[];
}

export class BioTargetConfigurationRuntime {
  private readonly queue = new SerialTaskQueue();

  /**
   * Dormant port for the later V2 scheduler: this class does not subscribe to pulses,
   * establish source readiness or enable product capability. Its owner must serialize
   * manual/schedule priority with these operations and pass the current protected set.
   */
  constructor(private readonly store: FileAutomationStateStore, private readonly port: BioTargetConfigurationPort,
    private readonly now: () => Date = () => new Date()) {}

  apply(request: BioTargetConfigurationRequest) { return this.run(structuredClone(request), "applyResult"); }
  restore(request: BioTargetConfigurationRequest) { return this.run(structuredClone(request), "restoreResult"); }

  private run(request: BioTargetConfigurationRequest, phase: "applyResult" | "restoreResult") {
    return this.queue.run(async () => {
      // UUID case is not a new physical fixture or activation base.
      request.sourceFixtureId = request.sourceFixtureId.toLowerCase();
      request.targetFixtureIds = request.targetFixtureIds.map(id => id.toLowerCase());
      request.protectedSourceFixtureIds = request.protectedSourceFixtureIds.map(id => id.toLowerCase());
      this.validate(request);
      const results: Record<string, PersistedBioTargetState> = {};
      for (const fixtureId of request.targetFixtureIds) {
        let row = this.store.read().bioTargetsByFixture[fixtureId];
        if (phase === "restoreResult" && (!row || row.activationId !== request.activationId)) continue;
        if (phase === "applyResult" && (!row || row.activationId !== request.activationId || row.preState === null)) {
          row = await this.capture(fixtureId, request, row);
        }
        if (!row) continue;
        // A completed/releasing activation cannot be revived by another pulse/retry.
        if (row.preState && (phase !== "applyResult" || row.restoreResult === null) && row[phase]?.status !== "succeeded") {
          row = await this.transition(fixtureId, row, phase);
        }
        results[fixtureId] = row;
      }
      return results;
    });
  }

  private validate(request: BioTargetConfigurationRequest) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!request.activationId || request.activationId.length > 512 || !uuid.test(request.sourceFixtureId) ||
      request.targetFixtureIds.length === 0 || request.targetFixtureIds.length > 10_000 ||
      !Number.isInteger(request.brightnessPercent) || request.brightnessPercent < 0 || request.brightnessPercent > 100 ||
      [...request.targetFixtureIds, ...request.protectedSourceFixtureIds].some(id => !uuid.test(id)) ||
      new Set(request.targetFixtureIds.map(id => id.toLowerCase())).size !== request.targetFixtureIds.length) throw new Error("invalid_bio_target_request");
    const sources = new Set([request.sourceFixtureId, ...request.protectedSourceFixtureIds].map(id => id.toLowerCase()));
    if (request.targetFixtureIds.some(id => sources.has(id.toLowerCase()))) throw new Error("bio_source_target_forbidden");
    // Validate the entire batch before its first write, including activation conflicts.
    const rows = this.store.read().bioTargetsByFixture;
    for (const fixtureId of request.targetFixtureIds) {
      const row = rows[fixtureId];
      if (!row) continue;
      if (row.activationId === request.activationId) {
        if (row.sourceFixtureId !== request.sourceFixtureId || row.eventBrightnessPercent !== request.brightnessPercent) {
          throw new Error("bio_target_activation_conflict");
        }
      } else if (row.preState !== null && row.restoreResult?.status !== "succeeded") {
        throw new Error("bio_target_activation_conflict");
      }
    }
  }

  private async capture(fixtureId: string, request: BioTargetConfigurationRequest, previous?: PersistedBioTargetState) {
    const row: PersistedBioTargetState = {
      activationId: request.activationId, sourceFixtureId: request.sourceFixtureId,
      eventBrightnessPercent: request.brightnessPercent, target: null, preState: null,
      applyResult: this.result("failed", previous?.activationId === request.activationId ? previous.applyResult.attempt + 1 : 1),
      restoreResult: null
    };
    try {
      const observed = await this.port.readBioState(fixtureId);
      row.preState = parseBioConfigurationState(observed.configuration);
      row.target = observed.target;
      row.applyResult.status = "pending";
    } catch {
      // Unknown configuration cannot become an invented base or an RF command.
      row.preState = null; row.target = null;
    }
    return this.persist(fixtureId, previous, row);
  }

  private async transition(fixtureId: string, previous: PersistedBioTargetState, phase: "applyResult" | "restoreResult") {
    const row = structuredClone(previous);
    const desired = phase === "applyResult" ? bioEventConfiguration(row.preState!, row.eventBrightnessPercent) : row.preState!;
    const prior = row[phase];
    const attempt = prior?.status === "pending" ? prior.attempt : (prior?.attempt ?? 0) + 1;
    row[phase] = this.result("pending", attempt);
    let current: BioConfigurationState;
    try {
      const readback = await this.port.readBioState(fixtureId);
      if (!isDeepStrictEqual(readback.target, row.target)) throw new Error("bio_target_identity_changed");
      current = parseBioConfigurationState(readback.configuration);
    } catch {
      row[phase] = this.result("failed", attempt);
      return this.persist(fixtureId, previous, row);
    }
    if (isDeepStrictEqual(current, desired)) {
      row[phase] = this.result("succeeded", attempt, current);
      return this.persist(fixtureId, previous, row);
    }
    // Prestate/identity and pending attempt must survive a process crash before RF.
    const pending = await this.persist(fixtureId, previous, row);
    try {
      const observed = parseBioConfigurationState(await this.port.restoreBioState(fixtureId, row.target!, desired));
      row[phase] = this.result(isDeepStrictEqual(observed, desired) ? "succeeded" : "failed", attempt, observed);
    } catch (error) {
      // A write exception is outcome-unknown. Only an explicit matched GET mismatch
      // carries an observed configuration; arbitrary exception details never persist.
      let observed: BioConfigurationState | null = null;
      if (error && typeof error === "object" && "observedConfiguration" in error) {
        try { observed = parseBioConfigurationState(error.observedConfiguration); } catch { /* Untrusted observation stays unknown. */ }
      }
      row[phase] = this.result(observed ? "failed" : "timed_out", attempt, observed);
    }
    // Keep storage errors outside the RF catch. A failed terminal commit leaves the
    // durable pending row available for GET reconciliation without recapturing base.
    return this.persist(fixtureId, pending, row);
  }

  private result(status: PersistedBioTargetResult["status"], attempt: number, observed: BioConfigurationState | null = null): PersistedBioTargetResult {
    return { status, attempt, at: this.now().toISOString(), observed };
  }

  private async persist(fixtureId: string, previous: PersistedBioTargetState | undefined, row: PersistedBioTargetState) {
    const result = await this.store.updateDurable(state => {
      if (!isDeepStrictEqual(state.bioTargetsByFixture[fixtureId], previous)) throw new Error("bio_target_state_conflict");
      state.bioTargetsByFixture[fixtureId] = row;
      return state;
    });
    return result.state.bioTargetsByFixture[fixtureId]!;
  }
}
