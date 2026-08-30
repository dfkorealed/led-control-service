import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicJsonCommitUncertainError, writeJsonAtomic } from "../mesh/mesh-store-file";
import { StorageHeadroomManager } from "../storage/storage-headroom-manager";
import { FileAutomationStateStore } from "./automation-state-store";
import { AutomationTelemetryCoordinator } from "./automation-telemetry-coordinator";
import {
  AutomationTelemetryGapJournal,
  type AutomationTelemetryGapJournalLike
} from "./automation-telemetry-gap-journal";
import { AutomationTelemetryOutbox } from "./automation-telemetry-outbox";
import { createAutomationTelemetryHandoff } from "./automation-telemetry-handoff";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";
import { ScheduleRuntime } from "./schedule-runtime";

const directories: string[] = [];
const fixtureId = "00000000-0000-4000-8000-000000000101";
const scheduleId = "00000000-0000-4000-8000-000000000103";
const gapSourceHandoffId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AutomationTelemetryCoordinator", () => {
  it("accepts the first state ENOSPC gap in the fixed journal with its exact identity and count", async () => {
    const test = await gapAcceptanceFixture();
    test.setStateDiskFull(true);

    await expect(test.coordinator.recordGap(
      7,
      "2026-08-30T01:00:00.000Z",
      3,
      "2026-08-30T01:00:02.000Z"
    )).resolves.toBe(true);

    expect(test.stateStore.read().telemetryGap).toMatchObject({
      handoffId: gapSourceHandoffId,
      droppedCount: 3
    });
    expect(test.stateStore.retainedTelemetryGap()).toBeNull();
    await expect(test.coordinator.recordGap(
      7,
      "2026-08-30T01:00:03.000Z",
      2,
      "2026-08-30T01:00:04.000Z"
    )).resolves.toBe(true);

    expect(test.stateStore.read().telemetryGap).toMatchObject({
      handoffId: gapSourceHandoffId,
      droppedCount: 5
    });
    const accepted = await test.journal.read();
    expect(accepted).toMatchObject({
      revision: 7,
      firstDroppedAt: "2026-08-30T01:00:00.000Z",
      lastDroppedAt: "2026-08-30T01:00:04.000Z",
      droppedCount: 5,
      lastSourceHandoffId: gapSourceHandoffId,
      lastSourceDroppedCount: 5,
      provenance: "fixture_state_outbox"
    });

    const repeated = await test.journal.record({
      handoffId: accepted!.lastSourceHandoffId,
      recordsHash: accepted!.lastSourceRecordsHash,
      provenance: accepted!.provenance,
      revision: accepted!.revision,
      firstDroppedAt: accepted!.firstDroppedAt,
      lastDroppedAt: accepted!.lastDroppedAt,
      droppedCount: accepted!.lastSourceDroppedCount
    });
    expect(repeated).toEqual(accepted);
    expect(test.stateStore.durability()).toEqual({ mode: "degraded", reason: "ENOSPC" });
  });

  it("retains one cumulative retry source when state and journal fail, then merges it exactly once", async () => {
    const test = await gapAcceptanceFixture();
    test.setStateDiskFull(true);
    test.setJournalFailure(true);

    await expect(test.coordinator.recordGap(
      7,
      "2026-08-30T01:01:00.000Z",
      2,
      "2026-08-30T01:01:01.000Z"
    )).resolves.toBe(false);
    await expect(test.coordinator.recordGap(
      7,
      "2026-08-30T01:00:59.000Z",
      3,
      "2026-08-30T01:01:03.000Z"
    )).resolves.toBe(false);

    expect(test.stateStore.retainedTelemetryGap()).toEqual({
      revision: 7,
      gap: {
        handoffId: gapSourceHandoffId,
        provenance: "fixture_state_outbox",
        firstDroppedAt: "2026-08-30T01:00:59.000Z",
        lastDroppedAt: "2026-08-30T01:01:03.000Z",
        droppedCount: 5
      }
    });
    expect(test.stateStore.durability()).toEqual({
      mode: "degraded",
      reason: "telemetry_gap_retry_pending"
    });
    expect(test.retryDelays).toEqual([10]);

    test.setJournalFailure(false);
    await test.runRetry();

    expect(test.stateStore.retainedTelemetryGap()).toBeNull();
    const firstPending = await test.outbox.pending();
    expect(firstPending).toHaveLength(1);
    expect(firstPending[0]!.event).toMatchObject({
      revision: 7,
      kind: "telemetry_gap",
      payload: {
        firstDroppedAt: "2026-08-30T01:00:59.000Z",
        lastDroppedAt: "2026-08-30T01:01:03.000Z",
        droppedCount: 5
      }
    });
    expect(test.retryChanges).toEqual([true]);

    await test.coordinator.flush(7);
    expect((await test.outbox.pending()).map(storedIdentity)).toEqual(firstPending.map(storedIdentity));
    test.coordinator.stop();
  });

  it("keeps retrying a journal-accepted gap when outbox recovery fails transiently", async () => {
    const test = await gapAcceptanceFixture();
    test.setStateDiskFull(true);
    await expect(test.coordinator.recordGap(
      7,
      "2026-08-30T01:01:10.000Z",
      3,
      "2026-08-30T01:01:12.000Z"
    )).resolves.toBe(true);

    test.setOutboxDiskFull(true);
    await test.runRetry();

    expect(test.retryDelays).toEqual([10, 20]);
    await expect(test.journal.read()).resolves.toMatchObject({
      lastSourceHandoffId: gapSourceHandoffId,
      lastSourceDroppedCount: 3,
      droppedCount: 3
    });

    test.setOutboxDiskFull(false);
    await test.runRetry();
    expect((await test.outbox.pending())[0]?.event).toMatchObject({
      kind: "telemetry_gap",
      payload: { droppedCount: 3 }
    });

    test.setStateDiskFull(false);
    await test.runRetry();
    const pending = await test.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.payload).toMatchObject({ droppedCount: 3 });
    test.coordinator.stop();
  });

  it("retains commit-uncertain gap acceptance without reclassifying its ENOSPC cause as journal success", async () => {
    const test = await gapAcceptanceFixture();
    test.setStateCommitUncertain(true);

    await expect(test.coordinator.recordGap(
      7,
      "2026-08-30T01:01:30.000Z",
      4,
      "2026-08-30T01:01:33.000Z"
    )).resolves.toBe(false);

    await expect(test.journal.read()).resolves.toBeNull();
    expect(test.stateStore.retainedTelemetryGap()).toMatchObject({
      revision: 7,
      gap: { handoffId: gapSourceHandoffId, droppedCount: 4 }
    });
    expect(test.stateStore.durability()).toEqual({
      mode: "degraded",
      reason: "automation_state_commit_uncertain"
    });
    expect(test.retryDelays).toEqual([10]);
    test.coordinator.stop();
  });

  it("restarts from a newer cumulative journal fallback without replaying the older state count", async () => {
    const test = await gapAcceptanceFixture();
    await test.stateStore.recordTelemetryGap(
      "2026-08-30T01:02:00.000Z",
      2,
      "2026-08-30T01:02:01.000Z",
      7
    );
    const durableGap = test.stateStore.read().telemetryGap!;
    test.setStateDiskFull(true);

    await expect(test.coordinator.recordGap(
      7,
      "2026-08-30T01:01:59.000Z",
      3,
      "2026-08-30T01:02:03.000Z"
    )).resolves.toBe(true);
    expect(test.stateStore.read().telemetryGap).toMatchObject({
      handoffId: durableGap.handoffId,
      droppedCount: 5
    });
    const diskBeforeRestart = new FileAutomationStateStore(test.statePath);
    await expect(diskBeforeRestart.initialize()).resolves.toMatchObject({ telemetryGap: durableGap });
    await expect(test.journal.read()).resolves.toMatchObject({
      lastSourceHandoffId: durableGap.handoffId,
      lastSourceDroppedCount: 5,
      droppedCount: 5
    });
    await test.journal.record({
      handoffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      recordsHash: `sha256:${"c".repeat(64)}`,
      provenance: "automation_state_storage",
      revision: 7,
      firstDroppedAt: "2026-08-30T01:02:01.000Z",
      lastDroppedAt: "2026-08-30T01:02:01.000Z",
      droppedCount: 2
    });
    test.coordinator.stop();

    const restartedState = new FileAutomationStateStore(test.statePath);
    const restartedOutbox = new AutomationTelemetryOutbox(
      test.outboxPath,
      automationScope,
      { headroomBytes: 32_768 }
    );
    await restartedState.initialize();
    await restartedOutbox.initialize();
    const restartedCoordinator = new AutomationTelemetryCoordinator(restartedState, restartedOutbox);
    await restartedCoordinator.flush(7);
    const firstPending = await restartedOutbox.pending();

    expect(restartedState.read().telemetryGap).toBeNull();
    expect(firstPending).toHaveLength(1);
    expect(firstPending[0]!.event).toMatchObject({
      kind: "telemetry_gap",
      payload: {
        firstDroppedAt: "2026-08-30T01:01:59.000Z",
        lastDroppedAt: "2026-08-30T01:02:03.000Z",
        droppedCount: 7
      }
    });

    await restartedCoordinator.flush(7);
    expect((await restartedOutbox.pending()).map(storedIdentity)).toEqual(firstPending.map(storedIdentity));
  });

  it("imports only the unaccepted journal delta when the outbox already receipted an older cumulative count", async () => {
    const test = await gapAcceptanceFixture();
    await test.stateStore.recordTelemetryGap(
      "2026-08-30T01:03:00.000Z",
      2,
      "2026-08-30T01:03:01.000Z",
      7
    );
    test.setStateDiskFull(true);
    await test.coordinator.flush(7);
    expect((await test.outbox.inspect()).gap).toMatchObject({ droppedCount: 2 });

    await test.coordinator.recordGap(
      7,
      "2026-08-30T01:02:59.000Z",
      3,
      "2026-08-30T01:03:03.000Z"
    );
    await expect(test.journal.read()).resolves.toMatchObject({
      lastSourceHandoffId: gapSourceHandoffId,
      lastSourceDroppedCount: 5,
      droppedCount: 5
    });

    const pending = await test.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.event).toMatchObject({
      kind: "telemetry_gap",
      payload: {
        firstDroppedAt: "2026-08-30T01:02:59.000Z",
        lastDroppedAt: "2026-08-30T01:03:03.000Z",
        droppedCount: 5
      }
    });
    test.coordinator.stop();
  });

  it("keeps an accepted handoff pending in memory and on disk when durable state clear hits ENOSPC", async () => {
    const test = await cleanupFixture();
    const handoff = createAutomationTelemetryHandoff([eventRecord()])!;
    await test.stateStore.updateDurable((state) => {
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    const accepted = await test.outbox.appendBatch(handoff);
    test.setStateDiskFull(true);

    const result = await test.coordinator.flush(7);

    expect(result).toMatchObject({ changed: true, retryScheduled: true });
    expect(test.stateStore.read().pendingTelemetryHandoffs).toEqual([handoff]);
    const restartedState = new FileAutomationStateStore(test.statePath);
    await expect(restartedState.initialize()).resolves.toMatchObject({
      pendingTelemetryHandoffs: [handoff]
    });
    expect((await test.outbox.inspect()).acceptedHandoffs[handoff.handoffId]).toMatchObject({
      recordsHash: handoff.recordsHash,
      outcome: "records"
    });
    expect(accepted.storedRecords).toHaveLength(1);
    expect(test.retryDelays).toEqual([10]);
  });

  it("restarts an uncleared handoff with the same event identity, sequence, and hash without gap inflation", async () => {
    const test = await cleanupFixture();
    const handoff = createAutomationTelemetryHandoff([eventRecord()])!;
    await test.stateStore.updateDurable((state) => {
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    await test.outbox.appendBatch(handoff);
    const before = (await test.outbox.pending()).map(storedIdentity);
    test.setStateDiskFull(true);
    await test.coordinator.flush(7);
    test.coordinator.stop();

    const restartedState = new FileAutomationStateStore(test.statePath);
    const restartedOutbox = new AutomationTelemetryOutbox(
      test.outboxPath,
      automationScope,
      { headroomBytes: 32_768 }
    );
    await restartedState.initialize();
    await restartedOutbox.initialize();
    await new AutomationTelemetryCoordinator(restartedState, restartedOutbox).flush(7);

    expect((await restartedOutbox.pending()).map(storedIdentity)).toEqual(before);
    expect((await restartedOutbox.inspect()).gap).toBeNull();
    expect(restartedState.read().pendingTelemetryHandoffs).toEqual([]);
  });

  it("retries durable cleanup with bounded backoff and releases the receipt only after disk recovery", async () => {
    const test = await cleanupFixture();
    const handoff = createAutomationTelemetryHandoff([eventRecord()])!;
    await test.stateStore.updateDurable((state) => {
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    await test.outbox.appendBatch(handoff);
    test.setStateDiskFull(true);

    await test.coordinator.flush(7);
    await test.runRetry();
    expect(test.retryDelays).toEqual([10, 20]);
    expect(test.stateStore.read().pendingTelemetryHandoffs).toEqual([handoff]);
    expect((await test.outbox.inspect()).acceptedHandoffs[handoff.handoffId]).toBeDefined();

    test.setStateDiskFull(false);
    await test.runRetry();

    expect(test.stateStore.read().pendingTelemetryHandoffs).toEqual([]);
    const restartedState = new FileAutomationStateStore(test.statePath);
    await expect(restartedState.initialize()).resolves.toMatchObject({ pendingTelemetryHandoffs: [] });
    expect((await test.outbox.inspect()).acceptedHandoffs[handoff.handoffId]).toBeUndefined();
    expect((await test.outbox.pending()).map(storedIdentity)).toHaveLength(1);
    test.coordinator.stop();
  });

  it("does not cancel a pending handoff cleanup retry when a later gap handoff succeeds", async () => {
    const test = await cleanupFixture();
    const handoff = createAutomationTelemetryHandoff([eventRecord()])!;
    await test.stateStore.updateDurable((state) => {
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    await test.outbox.appendBatch(handoff);
    test.setStateDiskFull(true);
    await test.coordinator.flush(7);

    test.setStateDiskFull(false);
    await test.coordinator.recordGap(
      7,
      "2026-08-30T01:01:00.000Z",
      1,
      "2026-08-30T01:01:00.000Z"
    );

    expect(test.cancelledRetries).toEqual([]);
    await test.runRetry();
    expect(test.stateStore.read().pendingTelemetryHandoffs).toEqual([]);
    test.coordinator.stop();
  });

  it("keeps a persisted gap pending until its clear is durable and then releases its receipt", async () => {
    const test = await cleanupFixture();
    await test.stateStore.recordTelemetryGap(
      "2026-08-30T01:02:00.000Z",
      3,
      "2026-08-30T01:02:02.000Z"
    );
    const gap = test.stateStore.read().telemetryGap!;
    test.setStateDiskFull(true);

    await test.coordinator.flush(7);

    expect(test.stateStore.read().telemetryGap).toEqual(gap);
    expect((await test.outbox.inspect()).acceptedHandoffs[gap.handoffId]).toBeDefined();
    const restartedFull = new FileAutomationStateStore(test.statePath);
    await expect(restartedFull.initialize()).resolves.toMatchObject({ telemetryGap: gap });

    test.setStateDiskFull(false);
    await test.runRetry();

    expect(test.stateStore.read().telemetryGap).toBeNull();
    expect((await test.outbox.inspect()).acceptedHandoffs[gap.handoffId]).toBeUndefined();
    expect((await test.outbox.inspect()).gap).toMatchObject({ droppedCount: 3 });
    test.coordinator.stop();
  });

  it("replays one immutable handoff across every state/outbox crash boundary and retains it until ACK", async () => {
    const handoff = createAutomationTelemetryHandoff([eventRecord()])!;
    const stateOnly = await fixture();
    await stateOnly.stateStore.updateDurable((state) => {
      state.currentByFixture[fixtureId] = 40;
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    const restartedStateStore = new FileAutomationStateStore(stateOnly.statePath);
    const restartedOutbox = new AutomationTelemetryOutbox(
      stateOnly.outboxPath,
      automationScope,
      { headroomBytes: 32_768 }
    );
    await restartedStateStore.initialize();
    await restartedOutbox.initialize();
    const afterStateOnlyCrash = new AutomationTelemetryCoordinator(restartedStateStore, restartedOutbox);
    await afterStateOnlyCrash.flush(7);
    expect(await restartedOutbox.pending()).toHaveLength(1);

    const outboxCommitted = await fixture();
    await outboxCommitted.stateStore.updateDurable((state) => {
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    await outboxCommitted.outbox.appendBatch(handoff);
    const afterOutboxCommitCrash = new AutomationTelemetryCoordinator(
      outboxCommitted.stateStore,
      outboxCommitted.outbox
    );
    await afterOutboxCommitCrash.flush(7);
    const pending = await outboxCommitted.outbox.pending();
    expect(pending).toHaveLength(1);
    expect(outboxCommitted.stateStore.read().pendingTelemetryHandoffs).toEqual([]);

    const stateCleared = await fixture();
    await stateCleared.stateStore.updateDurable((state) => {
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    await stateCleared.outbox.appendBatch(handoff);
    await stateCleared.stateStore.completeTelemetryHandoff(handoff.handoffId, handoff.recordsHash);
    await new AutomationTelemetryCoordinator(stateCleared.stateStore, stateCleared.outbox).flush(7);
    expect(await stateCleared.outbox.pending()).toHaveLength(1);

    const record = (await stateCleared.outbox.pending())[0]!;
    await stateCleared.outbox.markIngested({
      eventId: record.event.eventId,
      sequence: record.event.sequence,
      reportPayloadHash: record.reportPayloadHash
    });
    expect(await stateCleared.outbox.pending()).toEqual([]);
  });

  it("does not double-count a persisted state gap replayed after outbox commit but before state clear", async () => {
    const test = await fixture();
    await test.stateStore.recordTelemetryGap(
      "2026-08-30T01:00:00.000Z",
      4,
      "2026-08-30T01:00:03.000Z"
    );
    const gap = test.stateStore.read().telemetryGap!;
    const coordinator = new AutomationTelemetryCoordinator(test.stateStore, test.outbox);
    const hash = `sha256:${"d".repeat(64)}`;
    await test.outbox.recordGap({ revision: 7, recordsHash: hash, ...gap });

    await coordinator.flush(7);

    expect(test.stateStore.read().telemetryGap).toBeNull();
    expect((await test.outbox.inspect()).gap).toMatchObject({ droppedCount: 4 });
  });

  it("reports a journal-only state-storage recovery as changed so the publisher can surface telemetry_gap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-shared-journal-"));
    directories.push(directory);
    const stateStore = new FileAutomationStateStore(join(directory, "state.json"));
    const outboxPath = join(directory, "outbox.json");
    const journal = new AutomationTelemetryGapJournal(`${outboxPath}.gap`);
    await journal.initialize();
    const outbox = new AutomationTelemetryOutbox(outboxPath, automationScope, {
      headroomBytes: 32_768,
      gapJournal: journal
    });
    await stateStore.initialize();
    await outbox.initialize();
    await journal.record({
      handoffId: "99999999-9999-4999-8999-999999999999",
      recordsHash: `sha256:${"9".repeat(64)}`,
      provenance: "automation_state_storage",
      revision: 7,
      firstDroppedAt: "2026-08-30T01:00:00.000Z",
      lastDroppedAt: "2026-08-30T01:00:01.000Z",
      droppedCount: 2
    });

    const result = await new AutomationTelemetryCoordinator(stateStore, outbox).flush(7);

    expect(result).toMatchObject({ changed: true, handoffs: [] });
    expect((await outbox.pending()).map((record) => record.event.kind)).toEqual(["telemetry_gap"]);
  });

  it("transfers a journaled source receipt before replaying state after storage recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-journal-replay-"));
    directories.push(directory);
    const statePath = join(directory, "state.json");
    const outboxPath = join(directory, "outbox.json");
    const stateStore = new FileAutomationStateStore(statePath);
    await stateStore.initialize();
    const handoff = createAutomationTelemetryHandoff([eventRecord()])!;
    await stateStore.updateDurable((state) => {
      state.pendingTelemetryHandoffs.push(handoff);
      return state;
    });
    const enospc = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const degradedHeadroom = new StorageHeadroomManager(`${outboxPath}.reserve`, 32_768, {
      preallocate: async () => { throw enospc; },
      scheduleBackground: () => 1,
      cancelBackground: () => undefined
    });
    const degradedOutbox = new AutomationTelemetryOutbox(outboxPath, automationScope, {
      headroom: degradedHeadroom,
      write: async () => { throw enospc; }
    });
    await degradedOutbox.initialize();
    await degradedOutbox.appendBatch(handoff);

    const restartedStateStore = new FileAutomationStateStore(statePath);
    const restartedOutbox = new AutomationTelemetryOutbox(outboxPath, automationScope, { headroomBytes: 32_768 });
    await restartedStateStore.initialize();
    await restartedOutbox.initialize();
    await new AutomationTelemetryCoordinator(restartedStateStore, restartedOutbox).flush(7);

    const pending = await restartedOutbox.pending();
    expect(restartedStateStore.read().pendingTelemetryHandoffs).toEqual([]);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.event.kind).toBe("telemetry_gap");
    expect(pending[0]!.event.payload).toMatchObject({ droppedCount: 1 });
  });

  it("continues local RF on a corrupt outbox cold start and durably journals the exact dropped records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-cold-start-"));
    directories.push(directory);
    const stateStore = new FileAutomationStateStore(join(directory, "state.json"));
    const outboxPath = join(directory, "outbox.json");
    await writeFile(outboxPath, "{ corrupt", "utf8");
    const outbox = new AutomationTelemetryOutbox(outboxPath, automationScope, { headroomBytes: 32_768 });
    await expect(outbox.initialize()).resolves.toMatchObject({ mode: "degraded" });
    const coordinator = new AutomationTelemetryCoordinator(stateStore, outbox);
    const execute = vi.fn(async (actions: Array<{ fixtureId: string; brightnessPercent: number }>) => actions.map((action) => ({
      fixtureId: action.fixtureId,
      status: "succeeded" as const,
      brightnessPercent: action.brightnessPercent,
      faultCode: null,
      errorCode: null,
      occurredAt: "2026-08-30T01:30:00.000Z"
    })));
    const runtime = new ScheduleRuntime({
      store: stateStore,
      wallClock: () => new Date("2026-08-30T01:30:00.000Z"),
      monotonicClock: () => 1_000,
      clockTrust: { isTrusted: async () => true },
      execute,
      flushTelemetryHandoffs: () => coordinator.flush(1).then(() => undefined)
    });
    await runtime.initialize();
    await runtime.recordFixtureState(fixtureId, 20);
    const desired = await runtime.recompute(automationSnapshot(1, {
      timeZone: "UTC",
      schedules: [{
        id: scheduleId,
        name: "Active",
        status: "enabled",
        activeFrom: "2026-08-01T00:00:00.000Z",
        activeUntil: "2026-09-30T23:59:59.000Z",
        localStartTime: "01:00",
        localEndTime: "02:00",
        recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
        action: { dimmingEnabled: true, brightnessPercent: 40 },
        fixtureIds: [fixtureId]
      }]
    }));
    await runtime.applyDesiredState(desired, {});

    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.state().transitionsByFixture[fixtureId]).toMatchObject({ phase: "terminal", status: "succeeded" });
    expect(runtime.state().pendingTelemetryHandoffs).toEqual([]);
    await expect(outbox.initialize()).resolves.toMatchObject({ mode: "degraded" });
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-coordinator-"));
  directories.push(directory);
  const statePath = join(directory, "state.json");
  const outboxPath = join(directory, "outbox.json");
  const stateStore = new FileAutomationStateStore(statePath);
  const outbox = new AutomationTelemetryOutbox(outboxPath, automationScope, { headroomBytes: 32_768 });
  await stateStore.initialize();
  await outbox.initialize();
  return { statePath, outboxPath, stateStore, outbox };
}

async function cleanupFixture() {
  const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-durable-cleanup-"));
  directories.push(directory);
  const statePath = join(directory, "state.json");
  const outboxPath = join(directory, "outbox.json");
  const journal = new AutomationTelemetryGapJournal(`${outboxPath}.gap`);
  const headroom = new StorageHeadroomManager(`${outboxPath}.reserve`, 32_768, {
    preallocate: async (_target, bytes) => bytes,
    release: async () => undefined,
    scheduleBackground: () => 1,
    cancelBackground: () => undefined
  });
  await journal.initialize();
  await headroom.initialize();
  let stateDiskFull = false;
  const stateStore = new FileAutomationStateStore(
    statePath,
    async (target, value) => {
      if (stateDiskFull) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await writeJsonAtomic(target, value);
    },
    undefined,
    { headroom, gapJournal: journal }
  );
  const outbox = new AutomationTelemetryOutbox(outboxPath, automationScope, {
    headroom,
    gapJournal: journal
  });
  await stateStore.initialize();
  await outbox.initialize();
  const retryTasks: Array<() => Promise<void>> = [];
  const retryDelays: number[] = [];
  const cancelledRetries: unknown[] = [];
  const coordinator = new AutomationTelemetryCoordinator(stateStore, outbox, {
    retryInitialDelayMs: 10,
    retryMaxDelayMs: 20,
    scheduleRetry: (task, delayMs) => {
      retryTasks.push(task);
      retryDelays.push(delayMs);
      return retryTasks.length;
    },
    cancelRetry: (handle) => { cancelledRetries.push(handle); }
  });
  return {
    statePath,
    outboxPath,
    stateStore,
    outbox,
    coordinator,
    retryDelays,
    cancelledRetries,
    setStateDiskFull(value: boolean) { stateDiskFull = value; },
    async runRetry() {
      const task = retryTasks.shift();
      if (!task) throw new Error("expected a scheduled telemetry cleanup retry");
      await task();
    }
  };
}

async function gapAcceptanceFixture() {
  const directory = await mkdtemp(join(tmpdir(), "automation-telemetry-gap-acceptance-"));
  directories.push(directory);
  const statePath = join(directory, "state.json");
  const outboxPath = join(directory, "outbox.json");
  const journal = new AutomationTelemetryGapJournal(
    `${outboxPath}.gap`,
    () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  );
  let journalFailure = false;
  const fallibleJournal: AutomationTelemetryGapJournalLike = {
    initialize: () => journal.initialize(),
    read: () => journal.read(),
    record: (input) => journalFailure
      ? Promise.reject(Object.assign(new Error("journal unavailable"), { code: "EIO" }))
      : journal.record(input),
    commitAcceptedBaseline: (baseline) => journal.commitAcceptedBaseline(baseline),
    clear: (handoffId, recordsHash) => journal.clear(handoffId, recordsHash)
  };
  const headroom = new StorageHeadroomManager(`${outboxPath}.reserve`, 32_768, {
    preallocate: async (_target, bytes) => bytes,
    release: async () => undefined,
    scheduleBackground: () => 1,
    cancelBackground: () => undefined
  });
  await journal.initialize();
  await headroom.initialize();
  let stateDiskFull = false;
  let stateCommitUncertain = false;
  let outboxDiskFull = false;
  const stateStore = new FileAutomationStateStore(
    statePath,
    async (target, value) => {
      if (stateCommitUncertain) {
        throw new AtomicJsonCommitUncertainError(target, {
          cause: Object.assign(new Error("directory full"), { code: "ENOSPC" })
        });
      }
      if (stateDiskFull) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await writeJsonAtomic(target, value);
    },
    () => gapSourceHandoffId,
    { headroom, gapJournal: fallibleJournal }
  );
  const outbox = new AutomationTelemetryOutbox(outboxPath, automationScope, {
    headroom,
    gapJournal: fallibleJournal,
    write: async (target, value) => {
      if (outboxDiskFull) throw Object.assign(new Error("outbox disk full"), { code: "ENOSPC" });
      await writeJsonAtomic(target, value);
    }
  });
  await stateStore.initialize();
  await outbox.initialize();
  const retryTasks: Array<() => Promise<void>> = [];
  const retryDelays: number[] = [];
  const retryChanges: boolean[] = [];
  const coordinator = new AutomationTelemetryCoordinator(stateStore, outbox, {
    retryInitialDelayMs: 10,
    retryMaxDelayMs: 20,
    scheduleRetry: (task, delayMs) => {
      retryTasks.push(task);
      retryDelays.push(delayMs);
      return retryTasks.length;
    },
    cancelRetry: () => undefined,
    onRetryChanged: () => { retryChanges.push(true); }
  });
  return {
    statePath,
    outboxPath,
    journal,
    stateStore,
    outbox,
    coordinator,
    retryDelays,
    retryChanges,
    setStateDiskFull(value: boolean) { stateDiskFull = value; },
    setStateCommitUncertain(value: boolean) { stateCommitUncertain = value; },
    setOutboxDiskFull(value: boolean) { outboxDiskFull = value; },
    setJournalFailure(value: boolean) { journalFailure = value; },
    async runRetry() {
      const task = retryTasks.shift();
      if (!task) throw new Error("expected a scheduled telemetry acceptance retry");
      await task();
    }
  };
}

function storedIdentity(record: Awaited<ReturnType<AutomationTelemetryOutbox["pending"]>>[number]) {
  return {
    eventId: record.event.eventId,
    sequence: record.event.sequence,
    reportPayloadHash: record.reportPayloadHash
  };
}

function eventRecord() {
  return {
    revision: 7,
    ruleId: scheduleId,
    occurrenceKey: "occurrence-1",
    kind: "schedule_started" as const,
    occurredAt: "2026-08-30T01:00:00.000Z",
    payload: { targetFixtureIds: [fixtureId] }
  };
}
