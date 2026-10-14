import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { temporaryControlCommandSchema, temporaryControlResultSchema, type TemporaryControlCommand,
  type StartTemporaryControlCommand, type EndTemporaryControlCommand, type TemporaryControlResult, type TemporaryFixtureSnapshot, type AutomationSnapshot } from "@led-control/shared";
import type { BioOperationControl, BioVerifiedLampTarget, BioConfigurationState } from "../bio/bio-dongle-client";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import { AutomationStateStoreError, AutomationStateCommitUncertainError, parseBioConfigurationState,
  type FileAutomationStateStore, type PersistedAutomationStateV10, type PersistedTemporarySession,
  type PersistedTemporaryTarget } from "./automation-state-store";
import type { ClockTrustProvider } from "./clock-trust-provider";
import { resolveLatestBioAutomaticTarget, currentNormalConfiguration, canObserveNormalConfiguration, type BioAutomaticTarget } from "./bio-temporary-release";

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
  monotonic?: () => number;
  snapshot?: () => AutomationSnapshot | null;
  /** Synchronous last-native-frame fence supplied by trusted production wiring. */
  authorityCurrent?: (target: TemporaryFixtureSnapshot) => boolean;
  releasePreflight?: (command: TemporaryControlCommand, target: TemporaryFixtureSnapshot, goal: BioAutomaticTarget) => Promise<void>;
  /** Required current V3/assignment/exact fixture/source/capability authority.
   * The product owner must revalidate current authority here; there is no allow-all default. */
  preflight(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot): Promise<void>;
}

/** Owns durable apply and expiry intent. Latest automatic restoration and ACK
 * settlement are deliberately owned by the current-V3 integration, never by replaying preState. */
export class BioTemporaryControlRuntime {
  private readonly queue = new SerialTaskQueue();
  private readonly now: () => Date;
  private readonly deadlines = new Map<string, number>();
  private stopping = false;
  constructor(private readonly options: BioTemporaryControlOptions) { this.now = options.now ?? (() => new Date()); }

  ownsFixture(fixtureId: string): boolean { return Boolean(this.options.store.read().fixtureLeases[fixtureId]?.sessionId); }

  accept(input: TemporaryControlCommand): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("temporary_runtime_stopping"));
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
            if (state.temporarySessions[command.sessionId]?.targets[target.fixtureId]?.releaseAcknowledged) continue;
            if (previous?.state === "rejected" && previous.targets[target.fixtureId]?.applyResult?.rfWriteEvidence === "not_started" &&
              !previous.targets[target.fixtureId]?.configurationMayHaveChanged) continue;
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
          if (previous?.state === "rejected") { this.proveKnownUnchanged(state, command.sessionId); return state; }
          if (previous && ["restored", "rejected", "cancelled"].includes(previous.state)) return state;
          for (const target of command.targets) if (!state.temporarySessions[command.sessionId]?.targets[target.fixtureId]?.releaseAcknowledged) state.fixtureLeases[target.fixtureId] = {
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
      // An independently persisted end-only proof is sufficient forever. A late
      // start must not fabricate a session or reacquire its already settled pair.
      if (ended && this.options.store.read().temporaryEndProofs[command.sessionId]) return;
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
              partialMutation: "none", applyResult: null, releaseResult: null, releaseAcknowledged: false };
            state.fixtureLeases[snapshot.fixtureId] = { sessionId: command.sessionId, identity: snapshot,
              lastGeneration: ended ? snapshot.releaseGeneration : snapshot.applyGeneration, applyGeneration: snapshot.applyGeneration,
              releaseGeneration: snapshot.releaseGeneration, phase: session.state };
          }
          state.temporarySessions[command.sessionId] = session; return state;
        });
      }
      const session = this.session(command.sessionId);
      if (!this.deadlines.has(command.sessionId)) this.deadlines.set(command.sessionId,
        this.monotonic() + Math.max(0, Date.parse(command.endsAt) - this.now().getTime()));
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

  async release(command: EndTemporaryControlCommand): Promise<void> {
    await this.accept(command);
    await this.queue.run(() => this.restoreSession(command.sessionId));
  }

  expire(now: Date = this.now()): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("temporary_runtime_stopping"));
    return this.queue.run(async () => {
      await this.options.store.initialize();
      for (const session of Object.values(this.options.store.read().temporarySessions)) {
        if (session.state === "rejected" && session.sessionRevision === 2) {
          await this.options.store.updateDurable(state => { this.proveKnownUnchanged(state, session.command.sessionId); return state; });
        }
        if (["restored", "rejected", "cancelled"].includes(session.state)) continue;
        const id = session.command.sessionId;
        if (!this.deadlines.has(id) && await this.options.clockTrust.isTrusted(now)) {
          // A restart cannot reuse a prior boot's monotonic value. Anchor only
          // the remaining immutable absolute interval on the first trusted tick.
          this.deadlines.set(id, this.monotonic() + Math.max(0, Date.parse(session.command.endsAt) - now.getTime()));
        }
        if (now.getTime() >= Date.parse(session.command.endsAt) ||
          (this.deadlines.has(id) && this.monotonic() >= this.deadlines.get(id)!)) await this.releaseIntent(id);
        if (this.session(id).sessionRevision === 2) await this.restoreSession(id);
      }
      for (const id of Object.keys(this.options.store.read().temporaryEndTombstones)) if (!this.session(id)) await this.proveEndOnly(id);
    });
  }

  async stopAndDrain(): Promise<void> { this.stopping = true; await this.queue.drain(); }

  withConfigurationMutation<T>(fixtureId: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("temporary_runtime_stopping"));
    return this.queue.run(async () => {
      await this.options.store.updateDurable(state => {
        if (state.fixtureLeases[fixtureId]?.sessionId) throw new Error("temporary_fixture_lease_conflict");
        delete state.bioNormalConfigurations[fixtureId]; return state;
      });
      return operation();
    });
  }

  private monotonic() { return (this.options.monotonic ?? (() => performance.now()))(); }

  private async restoreSession(id: string) {
    const session = this.session(id);
    if (!session) { await this.proveEndOnly(id); return; }
    if (!session || session.sessionRevision !== 2 || ["restored", "rejected", "cancelled"].includes(session.state)) return;
    for (const target of session.command.targets) {
      const row = this.session(id).targets[target.fixtureId]!;
      if (row.releaseAcknowledged) continue;
      const snapshot = this.options.snapshot?.();
      if (row.releaseConfirmed && row.releaseResult && snapshot && snapshot.revision === row.releaseResult.restorationRevision &&
        snapshot.payloadHash === row.releaseResult.restorationPayloadHash) {
        const current = resolveLatestBioAutomaticTarget({ fixtureId: target.fixtureId, snapshot, state: this.options.store.read(), now: this.now() });
        // Time/activation boundaries can change the goal without a new snapshot.
        if (!("reason" in current) && isDeepStrictEqual(current.configuration, row.releaseResult.configurationReadback) &&
          this.options.authorityCurrent?.(target) !== false) continue;
      }
      if (!row.configurationMayHaveChanged && (row.applyResult?.rfWriteEvidence === "not_started" || row.preState === null)) {
        await this.recordRelease(session.command, target, null, null, true, null); continue;
      }
      let observed: BioConfigurationState | null = null; let goal: BioAutomaticTarget | null = null;
      try {
        goal = await this.releaseGuard(session.command, target);
        const before = await this.options.port.read(target.fixtureId, { beforeWrite: async () => { await this.releaseGuard(session.command, target); } });
        this.assertIdentity(target, before.target);
        if (currentNormalConfiguration(this.options.store.read(), session.command, target)?.networkId !== before.target.networkId) throw new Error("temporary_target_identity_mismatch");
        goal = await this.releaseGuard(session.command, target);
        const planned = goal;
        const control: BioTemporaryApplyControl = {
          beforeWrite: async () => { await this.releaseGuard(session.command, target, planned); },
          mayStartWrite: () => {
            if (this.stopping) return false;
            this.owned(this.options.store.read(), session.command, target, false);
            const snapshot = this.options.snapshot?.();
            return !!snapshot && snapshot.revision === planned.restorationRevision && snapshot.payloadHash === planned.restorationPayloadHash &&
              this.options.authorityCurrent?.(target) !== false;
          },
          beforeMutation: async stage => {
            await this.releaseGuard(session.command, target, planned);
            await this.options.store.updateDurable(state => {
              const current = this.owned(state, session.command, target, false);
              current.applyConfirmed = false; current.releaseConfirmed = false;
              current.configurationMayHaveChanged = true; current.partialMutation = stage;
              this.phase(state, id, "releasing"); return state;
            });
            await this.releaseGuard(session.command, target, planned);
          }
        };
        if (!isDeepStrictEqual(parseBioConfigurationState(before.configuration), planned.configuration)) {
          await this.options.port.restore(target.fixtureId, before.target, planned.configuration, control);
        }
        const after = await this.options.port.read(target.fixtureId, control);
        this.assertIdentity(target, after.target);
        if (!isDeepStrictEqual(before.target, after.target)) throw new Error("temporary_target_changed");
        observed = parseBioConfigurationState(after.configuration);
        await this.releaseGuard(session.command, target, planned);
        if (!isDeepStrictEqual(observed, planned.configuration)) throw new Error("temporary_restoration_mismatch");
        await this.recordRelease(session.command, target, observed, planned, false, null);
      } catch (error) {
        if (isStorageFailure(error)) throw error;
        await this.recordRelease(session.command, target, observed, null, false,
          error instanceof Error ? error.message : "temporary_restoration_unresolved");
      }
    }
  }

  private async proveEndOnly(id: string) {
    await this.options.store.updateDurable(state => {
      const end = state.temporaryEndTombstones[id];
      if (!end || state.temporarySessions[id]) return state;
      for (const target of end.targets) {
        const prior = state.temporaryEndProofs[id]?.[target.fixtureId];
        if (prior && state.temporaryResultOutbox[prior.eventId]) continue;
        const lease = state.fixtureLeases[target.fixtureId];
        if (lease?.sessionId !== id || !isDeepStrictEqual(lease.identity, target) || lease.lastGeneration !== target.releaseGeneration) continue;
        // Every possible apply requires a durable known start and mutation intent.
        // This intact state contains neither; no GET or fabricated Start is needed.
        const payload = { schemaVersion: 1 as const, eventId: randomUUID(), sessionId: id,
          siteId: end.siteId, gatewayId: end.gatewayId, assignmentVersion: end.assignmentVersion,
          admissionRevision: end.admissionRevision, originCommandHash: end.originCommandHash, originSequence: end.originSequence,
          sessionRevision: 2 as const, kind: "release" as const, fixtureId: target.fixtureId, targetGeneration: target.releaseGeneration,
          restorationRevision: null, restorationPayloadHash: null, observedAt: this.now().toISOString(),
          applyConfirmed: false, releaseConfirmed: false, configurationMayHaveChanged: false, partialMutation: "none" as const,
          configurationReadback: null, rfWriteEvidence: "not_started" as const, reason: "temporary_end_before_start" };
        const result = temporaryControlResultSchema.parse({ ...payload, resultHash: bioEnvelopeHash(payload) });
        (state.temporaryEndProofs[id] ??= {})[target.fixtureId] = result;
        state.temporaryResultOutbox[result.eventId] = result;
      }
      return state;
    });
  }

  private proveKnownUnchanged(state: PersistedAutomationStateV10, id: string) {
    const session = state.temporarySessions[id], end = state.temporaryEndTombstones[id];
    if (!session || !end || session.state !== "rejected" || Object.values(session.targets).some(row =>
      row.configurationMayHaveChanged || row.partialMutation !== "none" || row.applyResult?.rfWriteEvidence !== "not_started")) return;
    this.assertEndOrigin(end, session.command); session.sessionRevision = 2;
    for (const row of Object.values(session.targets)) {
      if (row.releaseAcknowledged || (row.releaseResult && state.temporaryResultOutbox[row.releaseResult.eventId])) continue;
      const lease = state.fixtureLeases[row.snapshot.fixtureId]!;
      if (isDeepStrictEqual(lease.identity, row.snapshot) && (lease.sessionId === null || lease.sessionId === id)) {
        lease.lastGeneration = row.snapshot.releaseGeneration; lease.phase = "rejected";
      }
      // Known RF0 already relinquished its owner. Publish the reserved End proof
      // without reacquiring a lease or modifying a newer session's generation.
      const payload = { ...row.applyResult!, eventId: randomUUID(), sessionRevision: 2 as const, kind: "release" as const,
        targetGeneration: row.snapshot.releaseGeneration, observedAt: this.now().toISOString(), reason: "temporary_apply_not_started" };
      const { resultHash: _hash, ...fields } = payload;
      const result = temporaryControlResultSchema.parse({ ...fields, resultHash: bioEnvelopeHash(fields) });
      row.releaseResult = result; state.temporaryResultOutbox[result.eventId] = result;
    }
  }

  private async releaseGuard(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot, planned?: BioAutomaticTarget) {
    this.owned(this.options.store.read(), command, target, false);
    if (this.stopping || !await this.options.clockTrust.isTrusted(this.now())) throw new Error("temporary_clock_or_deadline_untrusted");
    const snapshot = this.options.snapshot?.();
    if (!snapshot || !this.options.releasePreflight) throw new Error("temporary_release_authority_unavailable");
    const goal = resolveLatestBioAutomaticTarget({ fixtureId: target.fixtureId, snapshot, state: this.options.store.read(), now: this.now() });
    if ("reason" in goal) throw new Error(goal.reason);
    if (planned && !isDeepStrictEqual(planned, goal)) throw new Error("temporary_automatic_goal_changed");
    await this.options.releasePreflight(command, target, goal);
    if (!await this.options.clockTrust.isTrusted(this.now())) throw new Error("temporary_clock_or_deadline_untrusted");
    this.owned(this.options.store.read(), command, target, false);
    const latest = this.options.snapshot?.();
    if (!latest || !isDeepStrictEqual(goal, resolveLatestBioAutomaticTarget({ fixtureId: target.fixtureId, snapshot: latest,
      state: this.options.store.read(), now: this.now() })) || this.options.authorityCurrent?.(target) === false) throw new Error("temporary_automatic_goal_changed");
    return goal;
  }

  private async recordRelease(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot,
    observed: BioConfigurationState | null, goal: BioAutomaticTarget | null, unchanged: boolean, reason: string | null) {
    await this.options.store.updateDurable(state => {
      if (goal) {
        const snapshot = this.options.snapshot?.();
        if (!snapshot || !isDeepStrictEqual(goal, resolveLatestBioAutomaticTarget({ fixtureId: target.fixtureId, snapshot, state, now: this.now() })) ||
          this.options.authorityCurrent?.(target) === false) throw new Error("temporary_automatic_goal_changed");
      }
      const row = this.owned(state, command, target, false);
      row.applyConfirmed = false; row.releaseConfirmed = goal !== null; row.releaseAcknowledged = false;
      row.partialMutation = goal || unchanged ? "none" : row.configurationMayHaveChanged ? "unverified" : "none";
      const payload = { schemaVersion: 1 as const, eventId: randomUUID(), sessionId: command.sessionId,
        siteId: command.siteId, gatewayId: command.gatewayId, assignmentVersion: command.assignmentVersion,
        admissionRevision: command.admissionRevision, originCommandHash: command.payloadHash, originSequence: command.sequence,
        sessionRevision: 2 as const, kind: "release" as const, fixtureId: target.fixtureId, targetGeneration: target.releaseGeneration,
        restorationRevision: goal?.restorationRevision ?? null, restorationPayloadHash: goal?.restorationPayloadHash ?? null,
        observedAt: this.now().toISOString(), applyConfirmed: false, releaseConfirmed: goal !== null,
        configurationMayHaveChanged: row.configurationMayHaveChanged, partialMutation: row.partialMutation,
        configurationReadback: observed, rfWriteEvidence: unchanged ? "not_started" as const : observed ? "observed" as const : "may_have_written" as const, reason };
      const result = temporaryControlResultSchema.parse({ ...payload, resultHash: bioEnvelopeHash(payload) });
      if (row.releaseResult && state.temporaryResultOutbox[row.releaseResult.eventId]) {
        const comparable = (value: TemporaryControlResult) => { const { eventId: _event, observedAt: _at, resultHash: _hash, ...fields } = value; return fields; };
        if (isDeepStrictEqual(comparable(row.releaseResult), comparable(result))) return state;
      }
      row.releaseResult = result; state.temporaryResultOutbox[result.eventId] = result;
      this.phase(state, command.sessionId, goal || unchanged ? "releasing" : "recovery_pending");
      return state;
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
      if (session.sessionRevision === 2) { await this.restoreSession(lease.sessionId); return; }
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
      const normalSnapshot = this.options.snapshot?.() ?? null;
      const normalContext = { snapshot: normalSnapshot, marker: this.options.store.read().baseBrightnessByFixture[target.fixtureId] ?? null,
        eligible: !!normalSnapshot && canObserveNormalConfiguration(normalSnapshot, this.options.store.read(), target.fixtureId, this.now()) };
      const read = await this.options.port.read(target.fixtureId, { beforeWrite: () => this.guard(command, target, true) });
      this.assertIdentity(target, read.target);
      const preState = parseBioConfigurationState(read.configuration);
      await this.guard(command, target, true);
      if (this.options.snapshot) await this.qualifyNormal(command, target, read.target, preState, normalContext);
      await this.options.store.updateDurable(state => {
        const row = this.owned(state, command, target, true);
        row.preState = preState; this.phase(state, command.sessionId, "applying"); return state;
      });
      const control: BioTemporaryApplyControl = {
        beforeWrite: () => this.guard(command, target, true),
        mayStartWrite: () => {
          this.owned(this.options.store.read(), command, target, true);
          return !this.stopping && this.now().getTime() < Date.parse(command.endsAt) && this.options.authorityCurrent?.(target) !== false;
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

  private async qualifyNormal(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot,
    observedTarget: BioVerifiedLampTarget, configuration: BioConfigurationState,
    before: { snapshot: AutomationSnapshot | null; marker: number | null; eligible: boolean }) {
    const existing = currentNormalConfiguration(this.options.store.read(), command, target);
    if (existing && existing.networkId === observedTarget.networkId) return;
    const snapshot = before.snapshot;
    if (!snapshot || !before.eligible || !canObserveNormalConfiguration(snapshot, this.options.store.read(), target.fixtureId, this.now())) throw new Error("normal_configuration_unavailable");
    const marker = before.marker;
    const current = (state: PersistedAutomationStateV10) => {
      this.owned(state, command, target, true);
      const latest = this.options.snapshot?.();
      if (!latest || latest.revision !== snapshot.revision || latest.payloadHash !== snapshot.payloadHash ||
        marker !== (state.baseBrightnessByFixture[target.fixtureId] ?? null) ||
        !canObserveNormalConfiguration(latest, state, target.fixtureId, this.now())) throw new Error("normal_configuration_authority_changed");
    };
    await this.guard(command, target, true);
    await this.options.store.updateDurable(state => {
      current(state);
      state.bioNormalConfigurations[target.fixtureId] = {
        identity: { fixtureId: target.fixtureId, meshNodeId: target.meshNodeId, nativeUuid: target.nativeUuid, logicalAddress: target.logicalAddress },
        siteId: command.siteId, gatewayId: command.gatewayId, assignmentVersion: command.assignmentVersion, networkId: observedTarget.networkId,
        configuration, observedAt: this.now().toISOString(), baselineBrightness: marker,
        snapshotRevision: snapshot.revision, snapshotPayloadHash: snapshot.payloadHash
      }; return state;
    });
    try { await this.guard(command, target, true); current(this.options.store.read()); }
    catch (error) {
      await this.options.store.updateDurable(state => { delete state.bioNormalConfigurations[target.fixtureId]; return state; });
      throw error;
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
    for (const target of session.command.targets) if (!session.targets[target.fixtureId]!.releaseAcknowledged) state.fixtureLeases[target.fixtureId]!.phase = phase;
  }
  private session(id: string) { return this.options.store.read().temporarySessions[id]!; }
  private owned(state: PersistedAutomationStateV10, command: StartTemporaryControlCommand,
    target: TemporaryFixtureSnapshot, apply: boolean): PersistedTemporaryTarget {
    const session = state.temporarySessions[command.sessionId]; const lease = state.fixtureLeases[target.fixtureId];
    if (!session || session.targets[target.fixtureId]?.releaseAcknowledged || session.command.payloadHash !== command.payloadHash || lease?.sessionId !== command.sessionId ||
      !isDeepStrictEqual(lease.identity, target) || lease.applyGeneration !== target.applyGeneration ||
      lease.releaseGeneration !== target.releaseGeneration || lease.lastGeneration !==
      (session.sessionRevision === 1 ? target.applyGeneration : target.releaseGeneration) || (apply && session.sessionRevision !== 1)) {
      throw new Error("temporary_fixture_lease_changed");
    }
    return session.targets[target.fixtureId]!;
  }
  private async guard(command: StartTemporaryControlCommand, target: TemporaryFixtureSnapshot, apply: boolean) {
    const row = this.owned(this.options.store.read(), command, target, apply);
    if (apply && row.preState && this.options.snapshot && !currentNormalConfiguration(this.options.store.read(), command, target)) throw new Error("normal_configuration_unavailable");
    if (apply && (!await this.options.clockTrust.isTrusted(this.now()) || this.now().getTime() < Date.parse(command.startedAt) ||
      this.now().getTime() >= Date.parse(command.endsAt))) throw new Error("temporary_clock_or_deadline_untrusted");
    await this.options.preflight(command, target);
    this.owned(this.options.store.read(), command, target, apply);
    if (apply && (!await this.options.clockTrust.isTrusted(this.now()) || this.now().getTime() < Date.parse(command.startedAt) ||
      this.now().getTime() >= Date.parse(command.endsAt))) throw new Error("temporary_clock_or_deadline_untrusted");
    if (this.options.authorityCurrent?.(target) === false) throw new Error("temporary_authority_changed");
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
