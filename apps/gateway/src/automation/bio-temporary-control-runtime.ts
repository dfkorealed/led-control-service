import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { temporaryControlCommandSchema, temporaryControlResultSchema, type TemporaryControlCommand,
  type StartTemporaryControlCommand, type EndTemporaryControlCommand, type TemporaryControlResult, type TemporaryFixtureSnapshot } from "@led-control/shared";
import type { BioOperationControl, BioVerifiedLampTarget, BioConfigurationState } from "../bio/bio-dongle-client";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import { AutomationStateStoreError, AutomationStateCommitUncertainError, parseBioConfigurationState,
  type FileAutomationStateStore, type PersistedAutomationStateV10, type PersistedTemporarySession,
  type PersistedTemporaryTarget } from "./automation-state-store";
import type { ClockTrustProvider } from "./clock-trust-provider";

export interface BioTemporaryApplyControl extends BioOperationControl {
  beforeMutation(stage: "high_brightness" | "mode"): Promise<void>;
}
export interface BioTemporaryTargetPort {
  read(fixtureId: string, control: BioOperationControl): Promise<{ target: BioVerifiedLampTarget; configuration: BioConfigurationState }>;
  apply(fixtureId: string, brightness: number, control: BioTemporaryApplyControl): Promise<{ brightnessPercent: number; mode: "force-on" | "force-off" }>;
  restore(fixtureId: string, target: BioVerifiedLampTarget, configuration: BioConfigurationState, control: BioTemporaryApplyControl): Promise<BioConfigurationState>;
}
export interface BioTemporaryControlOptions {
  store: FileAutomationStateStore;
  port: BioTemporaryTargetPort;
  clockTrust: ClockTrustProvider;
  now?: () => Date;
  /** Required current V3/assignment/exact fixture/source/capability authority.
   * The product owner must revalidate current authority here; there is no allow-all default. */
  preflight(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot): Promise<void>;
}

/** Owns durable apply and expiry intent. Latest automatic restoration and ACK
 * settlement are deliberately owned by the current-V3 integration, never by replaying preState. */
export class BioTemporaryControlRuntime {
  private readonly queue = new SerialTaskQueue();
  private readonly now: () => Date;
  constructor(private readonly options: BioTemporaryControlOptions) { this.now = options.now ?? (() => new Date()); }

  ownsFixture(fixtureId: string): boolean { return Boolean(this.options.store.read().fixtureLeases[fixtureId]?.sessionId); }

  accept(input: TemporaryControlCommand): Promise<void> {
    const command = temporaryControlCommandSchema.parse(structuredClone(input));
    const { payloadHash, ...payload } = command;
    if (bioEnvelopeHash(payload) !== payloadHash) return Promise.reject(new Error("temporary_command_hash_mismatch"));
    return this.queue.run(async () => {
      await this.options.store.initialize();
      const previous = this.options.store.read().temporarySessions[command.sessionId];
      if (command.kind === "end") {
        if (previous) this.assertEndOrigin(command, previous.command);
        await this.options.store.updateDurable(state => {
          const existing = state.temporaryEndTombstones[command.sessionId];
          if (existing) {
            if (!isDeepStrictEqual(existing, command)) throw new Error("temporary_end_replay_mismatch");
            return state;
          }
          for (const target of command.targets) {
            const lease = state.fixtureLeases[target.fixtureId];
            if (lease?.sessionId === null && previous && ["restored", "rejected", "cancelled"].includes(previous.state) &&
              isDeepStrictEqual(lease.identity, target) && BigInt(lease.lastGeneration) <= BigInt(target.releaseGeneration)) continue;
            // A later accepted session may end before its start reaches this
            // Gateway. A settled older pair is a fence, not a permanent lock.
            if (lease?.sessionId === null && BigInt(lease.releaseGeneration) < BigInt(target.applyGeneration) &&
              lease.identity.fixtureId === target.fixtureId && lease.identity.meshNodeId === target.meshNodeId &&
              lease.identity.nativeUuid === target.nativeUuid && lease.identity.logicalAddress === target.logicalAddress) continue;
            if (lease && (lease.sessionId !== command.sessionId || !isDeepStrictEqual(lease.identity, target) ||
              BigInt(lease.lastGeneration) > BigInt(target.releaseGeneration))) throw new Error("temporary_fixture_lease_conflict");
          }
          state.temporaryEndTombstones[command.sessionId] = command;
          if (previous && ["restored", "rejected", "cancelled"].includes(previous.state)) return state;
          for (const target of command.targets) state.fixtureLeases[target.fixtureId] = {
            sessionId: command.sessionId, identity: target, lastGeneration: target.releaseGeneration,
            applyGeneration: target.applyGeneration, releaseGeneration: target.releaseGeneration, phase: "releasing" };
          if (state.temporarySessions[command.sessionId]) {
            state.temporarySessions[command.sessionId]!.sessionRevision = 2;
            this.phase(state, command.sessionId, "releasing");
          }
          return state;
        });
        return;
      }
      if (previous && !isDeepStrictEqual(previous.command, command)) throw new Error("temporary_replay_mismatch");
      const ended = this.options.store.read().temporaryEndTombstones[command.sessionId];
      if (ended) this.assertEndOrigin(ended, command);
      if (!previous) {
        await this.options.store.updateDurable(state => {
          for (const target of command.targets) {
            const lease = state.fixtureLeases[target.fixtureId];
            if (ended && lease?.sessionId === command.sessionId && isDeepStrictEqual(lease.identity, target) &&
              lease.lastGeneration === target.releaseGeneration) continue;
            if (lease?.sessionId || (lease && BigInt(lease.releaseGeneration) >= BigInt(target.applyGeneration)) ||
              state.pendingManualControls[target.fixtureId] || state.transitionsByFixture[target.fixtureId]?.phase === "pending") {
              throw new Error("temporary_fixture_lease_conflict");
            }
          }
          const session: PersistedTemporarySession = { command, sessionRevision: ended ? 2 : 1, state: ended ? "releasing" : "pending", targets: {} };
          for (const snapshot of command.targets) {
            session.targets[snapshot.fixtureId] = { snapshot, preState: null,
              preActivationId: state.bioTargetsByFixture[snapshot.fixtureId]?.activationId ?? null,
              applyConfirmed: false, releaseConfirmed: false, configurationMayHaveChanged: false,
              partialMutation: "none", applyResult: null, releaseResult: null };
            state.fixtureLeases[snapshot.fixtureId] = { sessionId: command.sessionId, identity: snapshot,
              lastGeneration: ended ? snapshot.releaseGeneration : snapshot.applyGeneration, applyGeneration: snapshot.applyGeneration,
              releaseGeneration: snapshot.releaseGeneration, phase: session.state };
          }
          state.temporarySessions[command.sessionId] = session; return state;
        });
      }
      const session = this.session(command.sessionId);
      if (session.sessionRevision === 2 || ["restored", "rejected", "cancelled"].includes(session.state)) return;
      if (this.now().getTime() >= Date.parse(command.endsAt)) { await this.releaseIntent(command.sessionId); return; }
      for (const target of command.targets) {
        const row = this.session(command.sessionId).targets[target.fixtureId]!;
        if (row.applyResult) continue;
        // A persisted preparation/mutation may have reached RF before a crash.
        // Never recapture that base or issue another apply from a duplicate delivery.
        if (row.preState !== null) await this.reconcile(command, target, true);
        else await this.apply(command, target);
      }
    });
  }

  tick(): Promise<void> {
    return this.queue.run(async () => {
      await this.options.store.initialize();
      for (const session of Object.values(this.options.store.read().temporarySessions)) {
        if (["restored", "rejected", "cancelled"].includes(session.state)) continue;
        if (this.now().getTime() >= Date.parse(session.command.endsAt)) await this.releaseIntent(session.command.sessionId);
        else if (session.sessionRevision === 1) for (const row of Object.values(session.targets)) {
          if (row.preState && !row.applyResult) await this.reconcile(session.command, row.snapshot, true);
        }
      }
    });
  }

  observe(fixtureId: string, observation: { target: BioVerifiedLampTarget; configuration: BioConfigurationState }): Promise<void> {
    const exact = structuredClone(observation);
    return this.queue.run(async () => {
      const lease = this.options.store.read().fixtureLeases[fixtureId];
      if (!lease?.sessionId) return;
      const session = this.session(lease.sessionId);
      if (!session) return; // End-only tombstones have no invented preState or apply proof.
      await this.guard(session.command, lease.identity, false);
      this.assertIdentity(lease.identity, exact.target);
      await this.record(session.command, lease.identity, parseBioConfigurationState(exact.configuration), false);
    });
  }

  private async apply(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot) {
    let observed: BioConfigurationState | null = null;
    let submitted = false;
    try {
      await this.guard(command, target, true);
      const read = await this.options.port.read(target.fixtureId, { beforeWrite: () => this.guard(command, target, true) });
      this.assertIdentity(target, read.target);
      const preState = parseBioConfigurationState(read.configuration);
      await this.guard(command, target, true);
      await this.options.store.updateDurable(state => {
        const row = this.owned(state, command, target, true);
        row.preState = preState; this.phase(state, command.sessionId, "applying"); return state;
      });
      const control: BioTemporaryApplyControl = {
        beforeWrite: () => this.guard(command, target, true),
        mayStartWrite: () => {
          this.owned(this.options.store.read(), command, target, true);
          return this.now().getTime() < Date.parse(command.endsAt);
        },
        beforeMutation: async stage => {
          await this.guard(command, target, true);
          await this.options.store.updateDurable(state => {
            const row = this.owned(state, command, target, true);
            row.partialMutation = row.configurationMayHaveChanged ? "unverified" : stage;
            row.configurationMayHaveChanged = true; return state;
          });
          await this.guard(command, target, true);
        },
        // Intent is already durable. The synchronous callback is submission
        // evidence only and must never make a write safe without the fsync above.
        onWriteStarted: () => { submitted = true; }
      };
      try { await this.options.port.apply(target.fixtureId, command.brightness, control); }
      catch (error) { if (isStorageFailure(error)) throw error; }
      // setOutput's return is not sufficient, especially brightness zero where
      // its legacy result only verifies mode. Always GET both configuration fields.
      try {
        await this.guard(command, target, false);
        const readback = await this.options.port.read(target.fixtureId, { beforeWrite: () => this.guard(command, target, false) });
        this.assertIdentity(target, readback.target);
        if (!isDeepStrictEqual(readback.target, read.target)) throw new Error("temporary_target_changed");
        observed = parseBioConfigurationState(readback.configuration);
        await this.guard(command, target, false);
      } catch { observed = null; /* An unmatched/failed GET retains durable mutation uncertainty. */ }
      await this.record(command, target, observed, submitted, !submitted);
    } catch (error) {
      if (isStorageFailure(error)) throw error;
      await this.record(command, target, null, submitted, !submitted);
    }
  }

  private async reconcile(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot, uncertain: boolean) {
    let observed: BioConfigurationState | null = null;
    try {
      await this.guard(command, target, false);
      const read = await this.options.port.read(target.fixtureId, { beforeWrite: () => this.guard(command, target, false) });
      this.assertIdentity(target, read.target); observed = parseBioConfigurationState(read.configuration);
      await this.guard(command, target, false);
    } catch { observed = null; /* Restart never converts an interrupted mutation to RF0. */ }
    await this.record(command, target, observed, uncertain);
  }

  private async record(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot,
    observed: BioConfigurationState | null, submitted: boolean, provedNotSubmitted = false) {
    await this.options.store.updateDurable(state => {
      const row = this.owned(state, command, target, false);
      const session = state.temporarySessions[command.sessionId]!;
      const desired = row.preState && { configuredHighBrightnessPercent: command.brightness || row.preState.configuredHighBrightnessPercent,
        bioMode: command.brightness ? "force-on" : "force-off" };
      // Only this live first attempt can prove its own prepared SET never entered
      // native submission. Restart/observation and previous partial writes cannot
      // use the absence of a new callback to erase durable mutation uncertainty.
      if (provedNotSubmitted) { row.configurationMayHaveChanged = false; row.partialMutation = "none"; }
      row.configurationMayHaveChanged ||= submitted;
      row.applyConfirmed = session.sessionRevision === 1 && this.now().getTime() < Date.parse(command.endsAt) &&
        row.configurationMayHaveChanged && observed !== null && desired !== null && isDeepStrictEqual(observed, desired);
      if (row.applyConfirmed) row.partialMutation = "none";
      else if (row.configurationMayHaveChanged) {
        const high = observed && row.preState && observed.configuredHighBrightnessPercent !== row.preState.configuredHighBrightnessPercent;
        const mode = observed && row.preState && observed.bioMode !== row.preState.bioMode;
        row.partialMutation = high && !mode ? "high_brightness" : mode && !high ? "mode" : "unverified";
      }
      const payload = { schemaVersion: 1 as const, eventId: randomUUID(), sessionId: command.sessionId,
        siteId: command.siteId, gatewayId: command.gatewayId, assignmentVersion: command.assignmentVersion,
        admissionRevision: command.admissionRevision, originCommandHash: command.payloadHash, originSequence: command.sequence,
        sessionRevision: session.sessionRevision, kind: session.sessionRevision === 1 ? "apply" as const : "observation" as const,
        fixtureId: target.fixtureId, targetGeneration: session.sessionRevision === 1 ? target.applyGeneration : target.releaseGeneration,
        restorationRevision: null, restorationPayloadHash: null, observedAt: this.now().toISOString(),
        applyConfirmed: row.applyConfirmed, releaseConfirmed: false, configurationMayHaveChanged: row.configurationMayHaveChanged,
        partialMutation: row.partialMutation, configurationReadback: observed,
        rfWriteEvidence: row.configurationMayHaveChanged ? (observed ? "observed" as const : "may_have_written" as const) : "not_started" as const,
        reason: row.applyConfirmed ? null : row.configurationMayHaveChanged ? "temporary_configuration_unresolved" : "temporary_apply_not_started" };
      const result: TemporaryControlResult = temporaryControlResultSchema.parse({ ...payload, resultHash: bioEnvelopeHash(payload) });
      if (session.sessionRevision === 1) row.applyResult = result; else row.releaseResult = result;
      state.temporaryResultOutbox[result.eventId] = result;
      const rows = Object.values(session.targets);
      const phase = session.sessionRevision === 2 ? "recovery_pending" : rows.every(row => row.applyConfirmed) ? "holding"
        : rows.some(row => row.configurationMayHaveChanged && row.partialMutation === "unverified") ? "unknown"
        : rows.some(row => row.configurationMayHaveChanged) ? "partial"
        : rows.every(row => row.applyResult?.rfWriteEvidence === "not_started") ? "rejected" : "applying";
      this.phase(state, command.sessionId, phase);
      if (phase === "rejected") for (const snapshot of command.targets) state.fixtureLeases[snapshot.fixtureId]!.sessionId = null;
      return state;
    });
  }

  private async releaseIntent(sessionId: string) {
    await this.options.store.updateDurable(state => {
      const session = state.temporarySessions[sessionId]!;
      if (session.sessionRevision === 2 || ["restored", "rejected", "cancelled"].includes(session.state)) return state;
      for (const target of session.command.targets) this.owned(state, session.command, target, false);
      session.sessionRevision = 2; this.phase(state, sessionId, "releasing");
      for (const target of session.command.targets) state.fixtureLeases[target.fixtureId]!.lastGeneration = target.releaseGeneration;
      return state;
    });
  }

  private assertEndOrigin(end: EndTemporaryControlCommand, start: StartTemporaryControlCommand) {
    if (end.originCommandHash !== start.payloadHash || end.originSequence !== start.sequence ||
      end.siteId !== start.siteId || end.gatewayId !== start.gatewayId || end.assignmentVersion !== start.assignmentVersion ||
      end.admissionRevision !== start.admissionRevision || end.endsAt !== start.endsAt || !isDeepStrictEqual(end.targets, start.targets)) {
      throw new Error("temporary_origin_mismatch");
    }
  }

  private phase(state: PersistedAutomationStateV10, sessionId: string, phase: PersistedTemporarySession["state"]) {
    const session = state.temporarySessions[sessionId]!; session.state = phase;
    for (const target of session.command.targets) state.fixtureLeases[target.fixtureId]!.phase = phase;
  }
  private session(id: string) { return this.options.store.read().temporarySessions[id]!; }
  private owned(state: PersistedAutomationStateV10, command: StartTemporaryControlCommand,
    target: TemporaryFixtureSnapshot, apply: boolean): PersistedTemporaryTarget {
    const session = state.temporarySessions[command.sessionId]; const lease = state.fixtureLeases[target.fixtureId];
    if (!session || session.command.payloadHash !== command.payloadHash || lease?.sessionId !== command.sessionId ||
      !isDeepStrictEqual(lease.identity, target) || lease.applyGeneration !== target.applyGeneration ||
      lease.releaseGeneration !== target.releaseGeneration || lease.lastGeneration !==
      (session.sessionRevision === 1 ? target.applyGeneration : target.releaseGeneration) || (apply && session.sessionRevision !== 1)) {
      throw new Error("temporary_fixture_lease_changed");
    }
    return session.targets[target.fixtureId]!;
  }
  private async guard(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot, apply: boolean) {
    this.owned(this.options.store.read(), command, target, apply);
    if (apply && (!await this.options.clockTrust.isTrusted(this.now()) || this.now().getTime() < Date.parse(command.startedAt) ||
      this.now().getTime() >= Date.parse(command.endsAt))) throw new Error("temporary_clock_or_deadline_untrusted");
    await this.options.preflight(command, target);
    this.owned(this.options.store.read(), command, target, apply);
    if (apply && (!await this.options.clockTrust.isTrusted(this.now()) || this.now().getTime() < Date.parse(command.startedAt) ||
      this.now().getTime() >= Date.parse(command.endsAt))) throw new Error("temporary_clock_or_deadline_untrusted");
  }
  private assertIdentity(snapshot: TemporaryFixtureSnapshot, target: BioVerifiedLampTarget) {
    if (target.kind !== "unicast" || target.nativeUuid !== snapshot.nativeUuid ||
      target.logicalAddress !== Number.parseInt(snapshot.logicalAddress.slice(2), 16) ||
      !Number.isInteger(target.networkId) || target.networkId < 0 || target.networkId > 65535) throw new Error("temporary_target_identity_mismatch");
  }
}

function isStorageFailure(error: unknown) {
  return error instanceof AutomationStateStoreError || error instanceof AutomationStateCommitUncertainError;
}
