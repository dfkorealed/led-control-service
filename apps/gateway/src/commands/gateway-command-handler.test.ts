import { describe, expect, it, vi } from "vitest";
import { StubBleMeshAdapter } from "../../test/stub-adapters";
import {
  executeAutomationDimmingActions,
  handleGatewayDimmingCommand,
  parseCommandTimeout,
  recoverPendingManualAutomationHandoffs
} from "./gateway-command-handler";
import { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";
import { CommandJournal } from "./command-journal";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAutomationStateStore } from "../automation/automation-state-store";
import { ScheduleRuntime } from "../automation/schedule-runtime";
import { createManualControlCoordinator } from "../index";

const command = {
  commandId: "11111111-1111-4111-8111-111111111111",
  dispatchId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  sequence: 1,
  siteId: "44444444-4444-4444-8444-444444444444",
  gatewayId: "55555555-5555-4555-8555-555555555555",
  targetType: "fixture" as const,
  targetId: "66666666-6666-4666-8666-666666666666",
  targetFixtureIds: ["66666666-6666-4666-8666-666666666666"],
  deliveryMode: "unicast" as const,
  brightness: 65,
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
};

describe("handleGatewayDimmingCommand", () => {
  it("waits for a live unicast prepare before recovering its DUP, leaving no orphaned pending control", async () => {
    const directory = await mkdtemp(join(tmpdir(), "live-prepare-duplicate-"));
    try {
      const journal = new CommandJournal(join(directory, "journal.json"));
      const runtime = new ScheduleRuntime({ store: new FileAutomationStateStore(join(directory, "state.json")), clockTrust: { isTrusted: async () => true }, execute: async () => [], allowManualStateInitialization: true });
      await runtime.initialize();
      const coordinator = createManualControlCoordinator(runtime);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const preparing = new Promise<void>((resolve) => { entered = resolve; });
      const prepare = coordinator.prepare;
      coordinator.prepare = async (...args) => { entered(); await gate; await prepare(...args); };
      const adapter = new StubBleMeshAdapter();
      const options = { automation: coordinator, setPermit: () => undefined };
      const original = handleGatewayDimmingCommand(adapter, journal, command, undefined, options);
      await preparing;
      let duplicateSettled = false;
      const duplicate = handleGatewayDimmingCommand(adapter, journal, command, undefined, options).then((result) => { duplicateSettled = true; return result; });
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        expect(duplicateSettled).toBe(false);
        expect(await journal.get(command.idempotencyKey)).toMatchObject({ state: "accepted", executionPhase: "pre_rf" });
      } finally { release(); await Promise.allSettled([original, duplicate]); }
      expect(await duplicate).toEqual(await original);
      expect((await original).deviceStatus.status).toBe("succeeded");
      expect(runtime.state().pendingManualControls).toEqual({});
      expect(adapter.commands).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["different-key", "different-journal-and-site"])("does not serialize independent %s work behind a live prepare", async (scope) => {
    const journal = memoryJournal(new Map());
    const adapter = new StubBleMeshAdapter();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const original = handleGatewayDimmingCommand(adapter, journal, command, undefined, { automation: { prepare: async () => { entered(); await gate; }, handoff: async () => undefined } });
    await preparing;
    try {
      const second = { ...command, ...(scope === "different-key" ? { idempotencyKey: "77777777-7777-4777-8777-777777777777" } : { siteId: "77777777-7777-4777-8777-777777777777" }) };
      const result = await handleGatewayDimmingCommand(adapter, scope === "different-key" ? journal : memoryJournal(new Map()), second);
      expect(result.deviceStatus.status).toBe("succeeded");
      expect(adapter.commands).toHaveLength(1);
    } finally { release(); await original; }
    expect(adapter.commands).toHaveLength(2);
  });
  it.each(["GATEWAY_CLOCK_UNTRUSTED", "COMMAND_EXPIRED"] as const)("aborts before adapter submission when the RF-marker fsync loses proof with %s", async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), "marker-proof-loss-"));
    try {
      const journal = new CommandJournal(join(directory, "journal.json"));
      const runtime = new ScheduleRuntime({ store: new FileAutomationStateStore(join(directory, "state.json")), clockTrust: { isTrusted: async () => true }, execute: async () => [], allowManualStateInitialization: true });
      await runtime.initialize();
      let valid = true;
      const mark = journal.markExecutionMayHaveStarted.bind(journal);
      journal.markExecutionMayHaveStarted = async (key) => { await mark(key); valid = false; };
      const adapter = new StubBleMeshAdapter();
      const result = await handleGatewayDimmingCommand(adapter, journal, command, undefined, { automation: createManualControlCoordinator(runtime), setPermit: () => valid ? undefined : reason });
      expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: reason });
      expect(runtime.state().pendingManualControls).toEqual({});
      expect(await journal.pendingAutomationRecoveries()).toEqual([]);
      expect(await journal.latestFixtureSnapshots()).toEqual([]);
      expect(adapter.commands).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(["pre_rf", "abort_pending", "admission_race", "refusal_race"])("uses the durable source and fixtures when an altered DUP triggers %s abort", async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "abort-duplicate-scope-"));
    try {
      const journal = new CommandJournal(join(directory, "journal.json"));
      const runtime = new ScheduleRuntime({ store: new FileAutomationStateStore(join(directory, "state.json")), clockTrust: { isTrusted: async () => true }, execute: async () => [], allowManualStateInitialization: true });
      await runtime.initialize();
      const coordinator = createManualControlCoordinator(runtime);
      await journal.accept(command.idempotencyKey, { command }, { executionPhase: "pre_rf" });
      await coordinator.prepare(command);
      const otherId = "77777777-7777-4777-8777-777777777777";
      await runtime.prepareManualControl({ sourceId: otherId, fixtureIds: [otherId], brightnessPercent: 20, requestedAt: command.requestedAt });
      const adapter = new StubBleMeshAdapter();
      if (phase !== "pre_rf") {
        await expect(handleGatewayDimmingCommand(adapter, journal, command, undefined, { automation: { ...coordinator, abortManualControl: async () => { throw new Error("crash"); } } })).rejects.toThrow("crash");
      }
      if (phase.endsWith("race")) {
        // The initial lookup precedes another receiver's terminal fsync; this
        // caller learns it lost journal admission only from accept(false).
        const get = journal.get.bind(journal);
        let first = true;
        journal.get = async (key) => { if (first) { first = false; return null; } return get(key); };
      }
      const result = await handleGatewayDimmingCommand(adapter, journal, { ...command, commandId: otherId, targetFixtureIds: [otherId] }, undefined, { automation: coordinator, setPermit: () => phase === "admission_race" ? undefined : "GATEWAY_CLOCK_UNTRUSTED" });
      expect(result.acceptance.commandId).toBe(command.commandId);
      expect(runtime.state().pendingManualControls).toEqual({ [otherId]: expect.objectContaining({ sourceId: otherId }) });
      expect(adapter.commands).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["before-marker", "after-marker", "after-write"])("keeps correct uncertainty when interrupted %s", async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "rf-marker-restart-"));
    try {
      const path = join(directory, "journal.json");
      const journal = new CommandJournal(path);
      const runtime = new ScheduleRuntime({ store: new FileAutomationStateStore(join(directory, "state.json")), clockTrust: { isTrusted: async () => true }, execute: async () => [], allowManualStateInitialization: true });
      await runtime.initialize();
      const coordinator = createManualControlCoordinator(runtime);
      const adapter = new StubBleMeshAdapter();
      if (boundary === "after-write") journal.complete = async () => { throw new Error("crash"); };
      else {
        const mark = journal.markExecutionMayHaveStarted.bind(journal);
        journal.markExecutionMayHaveStarted = async (key) => { if (boundary === "after-marker") await mark(key); throw new Error("crash"); };
      }
      await expect(handleGatewayDimmingCommand(adapter, journal, command, undefined, { automation: coordinator, setPermit: () => undefined })).rejects.toThrow("crash");
      const restarted = new CommandJournal(path);
      await recoverPendingManualAutomationHandoffs(restarted, coordinator);
      const result = await handleGatewayDimmingCommand(adapter, restarted, command, undefined, { automation: coordinator, setPermit: () => "GATEWAY_CLOCK_UNTRUSTED" });
      expect(result.acceptance.status).toBe(boundary === "before-marker" ? "rejected" : "accepted");
      expect(result.deviceStatus.status).toBe(boundary === "before-marker" ? "failed" : "timed_out");
      expect((await restarted.get(command.idempotencyKey))?.automationAbort).toBe(boundary === "before-marker" ? "completed" : undefined);
      expect(adapter.commands).toHaveLength(boundary === "after-write" ? 1 : 0);
      expect(result.fixtureStateObserved).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each(["prepare", "terminal-before", "terminal-after", "abort-before", "abort-after", "abort-ack-before", "abort-ack-after"])("recovers an exact pre-RF abort after crash at %s without handoff or RF", async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "manual-abort-restart-"));
    try {
      const journalPath = join(directory, "journal.json");
      const statePath = join(directory, "state.json");
      const createRuntime = () => new ScheduleRuntime({ store: new FileAutomationStateStore(statePath), clockTrust: { isTrusted: async () => true }, execute: async () => [], allowManualStateInitialization: true });
      const runtime = createRuntime();
      await runtime.initialize();
      const otherId = "77777777-7777-4777-8777-777777777777";
      await runtime.prepareManualControl({ sourceId: otherId, fixtureIds: [otherId], brightnessPercent: 20, requestedAt: command.requestedAt });
      const journal = new CommandJournal(journalPath);
      const coordinator = createManualControlCoordinator(runtime);
      let valid = true;
      const prepare = coordinator.prepare;
      coordinator.prepare = async (...args) => { await prepare(...args); valid = false; if (boundary === "prepare") throw new Error("crash"); };
      if (boundary.startsWith("terminal")) {
        const complete = journal.complete.bind(journal);
        journal.complete = async (...args) => { if (boundary === "terminal-before") throw new Error("crash"); await complete(...args); throw new Error("crash"); };
      }
      if (boundary.startsWith("abort-ack")) {
        const mark = journal.markAutomationAbortComplete?.bind(journal);
        journal.markAutomationAbortComplete = async (...args) => { if (boundary === "abort-ack-before") throw new Error("crash"); await mark!(...args); throw new Error("crash"); };
      } else if (boundary.startsWith("abort")) {
        const abort = coordinator.abortManualControl?.bind(coordinator);
        coordinator.abortManualControl = async (...args) => { if (boundary === "abort-before") throw new Error("crash"); await abort!(...args); throw new Error("crash"); };
      }
      const adapter = new StubBleMeshAdapter();
      await expect(handleGatewayDimmingCommand(adapter, journal, command, undefined, {
        automation: coordinator, setPermit: () => valid ? undefined : "GATEWAY_CLOCK_UNTRUSTED"
      })).rejects.toThrow("crash");
      const restarted = createRuntime();
      await restarted.initialize();
      const recoveryJournal = new CommandJournal(journalPath);
      const recoveredCoordinator = createManualControlCoordinator(restarted);
      await recoverPendingManualAutomationHandoffs(recoveryJournal, recoveredCoordinator);
      await recoverPendingManualAutomationHandoffs(recoveryJournal, recoveredCoordinator);
      expect(restarted.state().pendingManualControls).toEqual({ [otherId]: expect.objectContaining({ sourceId: otherId }) });
      expect(restarted.state().transitionsByFixture[command.targetId]).toBeUndefined();
      expect(restarted.state().manualAutomationSuppressions).toEqual({});
      expect(restarted.state().pendingTelemetryHandoffs).toEqual([]);
      expect(await recoveryJournal.latestFixtureSnapshots()).toEqual([]);
      expect(await recoveryJournal.pendingAutomationRecoveries()).toEqual([]);
      const result = await handleGatewayDimmingCommand(adapter, recoveryJournal, command, undefined, { automation: recoveredCoordinator, setPermit: () => undefined });
      expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "GATEWAY_CLOCK_UNTRUSTED" });
      expect(result.fixtureStateObserved).toBe(false);
      expect(adapter.commands).toHaveLength(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each([
    ["receive", "GATEWAY_CLOCK_UNTRUSTED"], ["reservation", "GATEWAY_CLOCK_UNTRUSTED"],
    ["fsync", "GATEWAY_CLOCK_UNTRUSTED"], ["accepted ACK", "GATEWAY_CLOCK_UNTRUSTED"],
    ["reservation", "COMMAND_EXPIRED"], ["fsync", "COMMAND_EXPIRED"], ["accepted ACK", "COMMAND_EXPIRED"]
  ] as const)("durably refuses at %s with %s without RF or automation handoff", async (boundary, reason) => {
    const records = new Map<string, any>();
    const journal = memoryJournal(records);
    const accept = journal.accept;
    let valid = boundary !== "receive";
    journal.accept = async (key, value) => {
      const reserved = await accept(key, value);
      if (boundary === "fsync") valid = false;
      return reserved;
    };
    const adapter = new StubBleMeshAdapter();
    const automation = { prepare: vi.fn(), handoff: vi.fn() };
    let durable = false;
    let acceptedAckSent = false;
    const options = {
      setPermit: () => valid ? undefined : reason,
      isCommandExpired: () => false,
      beforeExecution: async () => { if (boundary === "reservation") valid = false; },
      automation,
      onDurableReceipt: () => { durable = true; }
    };
    const result = await handleGatewayDimmingCommand(adapter, journal, command,
      async () => { acceptedAckSent = true; if (boundary === "accepted ACK") valid = false; }, options);
    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: reason });
    expect(result.fixtureStateObserved).toBe(false);
    expect(records.get(command.idempotencyKey)).toMatchObject({ state: "completed", result });
    expect(durable).toBe(true);
    expect(acceptedAckSent).toBe(boundary === "accepted ACK");
    expect(automation.prepare).not.toHaveBeenCalled();
    expect(automation.handoff).not.toHaveBeenCalled();
    valid = true;
    expect(await handleGatewayDimmingCommand(adapter, journal, command, undefined, options)).toEqual(result);
    expect(adapter.commands).toHaveLength(0);
  });

  it("does not revive a receive-time refusal when proof arrives before dequeue", async () => {
    const queue = new KeyedSerialTaskQueue();
    const queued = meshCommand();
    let release!: () => void;
    const held = queue.run(queued.meshControlGroupId, () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    let valid = false;
    const adapter = new StubBleMeshAdapter();
    const applyMeshGroup = async (_address: number, fixtureIds: string[], brightness: number) => adapter.setBrightness(fixtureIds, brightness);
    const pending = handleGatewayDimmingCommand(Object.assign(adapter, { applyMeshGroup }), memoryJournal(new Map()), queued, undefined, {
      groupQueue: queue, groupStateStore: { assertReady: async () => undefined },
      setPermit: () => valid ? undefined : "GATEWAY_CLOCK_UNTRUSTED"
    });
    valid = true;
    release();
    await held;
    expect((await pending).acceptance.errorCode).toBe("GATEWAY_CLOCK_UNTRUSTED");
    expect(adapter.commands).toHaveLength(0);
  });

  it.each(["GATEWAY_CLOCK_UNTRUSTED", "COMMAND_EXPIRED"] as const)("waits for live group RF before replaying a DUP whose permit now returns %s", async (reason) => {
    const records = new Map<string, any>();
    const journal = memoryJournal(records);
    const groupCommand = meshCommand();
    const groupQueue = new KeyedSerialTaskQueue();
    const adapter = new StubBleMeshAdapter();
    let releaseRf!: () => void;
    let notifyRfStarted!: () => void;
    const rfGate = new Promise<void>((resolve) => { releaseRf = resolve; });
    const rfStarted = new Promise<void>((resolve) => { notifyRfStarted = resolve; });
    let rfCalls = 0;
    let manualPending = false;
    let valid = true;
    const handoffs: string[] = [];
    const automation = {
      prepare: async () => { manualPending = true; },
      handoff: async (_command: unknown, terminal: { status: string }) => {
        handoffs.push(terminal.status);
        manualPending = false;
      }
    };
    const applyMeshGroup = async (_address: number, fixtureIds: string[], brightness: number) => {
      rfCalls += 1;
      notifyRfStarted();
      await rfGate;
      return adapter.setBrightness(fixtureIds, brightness);
    };
    const groupAdapter = Object.assign(adapter, { applyMeshGroup });
    const options = {
      groupQueue, automation, groupStateStore: { assertReady: async () => undefined },
      setPermit: () => valid ? undefined : reason
    };
    const original = handleGatewayDimmingCommand(groupAdapter, journal, groupCommand, undefined, options);
    await rfStarted;
    valid = false;
    let duplicateSettled = false;
    const duplicate = handleGatewayDimmingCommand(groupAdapter, journal, groupCommand, undefined, options)
      .then((result) => { duplicateSettled = true; return result; });
    try {
      // Let all immediate journal/recovery work settle while RF remains held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await journal.get(groupCommand.idempotencyKey)).toMatchObject({ state: "accepted" });
      expect(duplicateSettled).toBe(false);
      expect(manualPending).toBe(true);
      expect(handoffs).toEqual([]);
      expect(rfCalls).toBe(1);
    } finally {
      releaseRf();
      await Promise.all([original, duplicate]);
    }
    const result = await original;
    expect(result.deviceStatus.status).toBe("succeeded");
    expect(await duplicate).toEqual(result);
    expect(handoffs).toEqual(["succeeded"]);
    expect(manualPending).toBe(false);
    expect(rfCalls).toBe(1);
  });

  it.each(["GATEWAY_CLOCK_UNTRUSTED", "COMMAND_EXPIRED"] as const)("rechecks proof for %s when a Set leaves the group queue", async (reason) => {
    const queue = new KeyedSerialTaskQueue();
    const queued = meshCommand();
    let release!: () => void;
    const held = queue.run(queued.meshControlGroupId, () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    let valid = true;
    const adapter = new StubBleMeshAdapter();
    const applyMeshGroup = async (_address: number, fixtureIds: string[], brightness: number) => adapter.setBrightness(fixtureIds, brightness);
    const pending = handleGatewayDimmingCommand(Object.assign(adapter, { applyMeshGroup }), memoryJournal(new Map()), queued, undefined, {
      groupQueue: queue,
      groupStateStore: { assertReady: async () => undefined },
      setPermit: () => valid ? undefined : reason
    });
    valid = false;
    release();
    await held;
    expect((await pending).acceptance.errorCode).toBe(reason);
    expect(adapter.commands).toHaveLength(0);
  });

  it("refuses a DUP after the 24h journal prune and replays that terminal refusal after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-pruned-dup-"));
    try {
      let now = new Date("2026-09-26T00:00:00.000Z");
      const path = join(directory, "journal.json");
      const journal = new CommandJournal(path, { now: () => now });
      const adapter = new StubBleMeshAdapter();
      await journal.accept(command.idempotencyKey, { command });
      await journal.complete(command.idempotencyKey, { acceptance: { status: "accepted" }, fixtureStateObserved: false });
      now = new Date("2026-09-27T00:00:00.001Z");
      await journal.accept("trigger-prune", {});
      expect(await journal.get(command.idempotencyKey)).toBeNull();
      const options = { setPermit: () => "GATEWAY_CLOCK_UNTRUSTED" as const, isCommandExpired: () => false };
      const result = await handleGatewayDimmingCommand(adapter, journal, command, undefined, options);
      expect(result.acceptance.errorCode).toBe("GATEWAY_CLOCK_UNTRUSTED");
      expect(await handleGatewayDimmingCommand(adapter, new CommandJournal(path, { now: () => now }), command, undefined, options)).toEqual(result);
      expect(adapter.commands).toHaveLength(0);
      expect(await journal.latestFixtureSnapshots()).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps an accepted-only restart indeterminate even if the Set permit is now refused", async () => {
    const records = new Map<string, any>();
    const journal = memoryJournal(records);
    await journal.accept(command.idempotencyKey, { command });
    const adapter = new StubBleMeshAdapter();
    const result = await handleGatewayDimmingCommand(adapter, journal, command, undefined, {
      setPermit: () => "GATEWAY_CLOCK_UNTRUSTED"
    });
    expect(result.acceptance.status).toBe("accepted");
    expect(result.deviceStatus.status).toBe("timed_out");
    expect(adapter.commands).toHaveLength(0);
  });
  it.each(["unknown key", "bad fixture", "duplicate identity", "capacity", "wrong source", "wrong terminal", "missing success"])(
    "rejects malformed terminal suppression context during replay: %s", async (fault) => {
      const terminal = "2026-08-30T00:50:00.000Z";
      const identity = { ruleId: "00000000-0000-4000-8000-000000000104", startedAt: "2026-08-30T01:00:00.000Z" };
      const suppression = { sourceId: command.commandId, appliedAt: terminal, schedules: [], vehicleEvents: [identity] };
      const context: any = { suppressions: { [command.targetId]: suppression } };
      if (fault === "unknown key") context.extra = true;
      if (fault === "bad fixture") context.suppressions = { invalid: suppression };
      if (fault === "duplicate identity") suppression.vehicleEvents.push(identity);
      if (fault === "capacity") suppression.vehicleEvents = Array.from({ length: 10_001 }, () => identity);
      if (fault === "wrong source") suppression.sourceId = command.dispatchId;
      if (fault === "wrong terminal") suppression.appliedAt = "2026-08-30T00:51:00.000Z";
      if (fault === "missing success") context.suppressions = {};
      const journal = {
        pendingAutomationRecoveries: async () => [{
          idempotencyKey: command.idempotencyKey, state: "completed" as const, command: { command },
          result: { deviceStatus: { occurredAt: terminal, results: [{ fixtureId: command.targetId, status: "succeeded", brightness: 65 }] },
            manualTerminalContext: context }
        }], complete: vi.fn(), markAutomationHandoffComplete: vi.fn()
      };
      const automation = { prepare: vi.fn(), handoff: vi.fn() };
      await expect(recoverPendingManualAutomationHandoffs(journal, automation)).rejects.toThrow();
      expect(automation.handoff).not.toHaveBeenCalled();
      expect(journal.markAutomationHandoffComplete).not.toHaveBeenCalled();
    }
  );

  it("validates the production BLE status timeout at startup", () => {
    expect(parseCommandTimeout(undefined)).toBe(8000);
    expect(parseCommandTimeout("29000")).toBe(29000);
    expect(() => parseCommandTimeout("999")).toThrow("1000-29000ms");
    expect(() => parseCommandTimeout("invalid")).toThrow("1000-29000ms");
    expect(() => parseCommandTimeout("29001")).toThrow("1000-29000ms");
  });
  it("returns acceptance then device status and reuses terminal result for duplicates", async () => {
    const records = new Map<string, any>();
    const journal = {
      get: async (key: string) => records.get(key) ?? null,
      accept: async (key: string, value: unknown) => {
        records.set(key, { state: "accepted", command: value });
        return true;
      },
      complete: async (key: string, result: unknown) => {
        records.set(key, { ...records.get(key), state: "completed", result });
      }
    };
    const adapter = new StubBleMeshAdapter();

    const first = await handleGatewayDimmingCommand(adapter, journal, command);
    const duplicate = await handleGatewayDimmingCommand(adapter, journal, command);

    expect(first.acceptance.status).toBe("accepted");
    expect(first.deviceStatus).toMatchObject({ status: "succeeded", results: [{ status: "succeeded", brightness: 65 }] });
    expect(duplicate).toEqual(first);
    expect(adapter.commands).toHaveLength(1);
  });

  it.each([false, true])("durably prepares manual control before RF and hands off once (legacy expiry: %s)", async (legacy) => {
    const events: string[] = [];
    const adapter = new StubBleMeshAdapter();
    const automation = {
      prepare: vi.fn(async () => { events.push("prepared"); }),
      handoff: vi.fn(async () => { events.push("handoff"); })
    };
    const timed = legacy ? { ...command, overrideUntil: new Date(Date.now() + 3_600_000).toISOString() } : command;
    const records = new Map<string, any>();

    const first = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(records),
      timed,
      async () => { events.push("accepted"); },
      { automation }
    );
    const duplicate = await handleGatewayDimmingCommand(adapter, memoryJournal(records), timed, undefined, { automation });

    expect(events).toEqual(["accepted", "prepared", "handoff"]);
    expect(automation.prepare).toHaveBeenCalledWith(timed);
    expect(automation.handoff).toHaveBeenCalledWith(timed, first.deviceStatus, "live");
    expect(duplicate).toEqual(first);
    expect(adapter.commands).toHaveLength(1);
  });

  it("opens the MQTT receipt boundary after journal acceptance and before publishing acceptance", async () => {
    const events: string[] = [];

    const result = await handleGatewayDimmingCommand(
      new StubBleMeshAdapter(),
      memoryJournal(new Map()),
      command,
      async () => { events.push("acceptance-published"); },
      { onDurableReceipt: () => events.push("receipt-durable") }
    );

    expect(result.deviceStatus.status).toBe("succeeded");
    expect(events).toEqual(["receipt-durable", "acceptance-published"]);
  });

  it("replays a completed command whose durable automation handoff was interrupted", async () => {
    const adapter = new StubBleMeshAdapter();
    const timed = { ...command, overrideUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const records = new Map<string, any>();
    const automation = {
      prepare: vi.fn().mockResolvedValue(undefined),
      handoff: vi.fn()
        .mockRejectedValueOnce(new Error("crash before handoff commit"))
        .mockResolvedValueOnce(undefined)
    };

    const first = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(records),
      timed,
      undefined,
      { automation, onAutomationError: vi.fn() }
    );
    expect(records.get(command.idempotencyKey)).toMatchObject({
      state: "completed",
      automationHandoff: "pending"
    });

    const duplicate = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(records),
      timed,
      undefined,
      { automation }
    );

    expect(duplicate).toEqual(first);
    expect(adapter.commands).toHaveLength(1);
    expect(automation.handoff).toHaveBeenCalledTimes(2);
    expect(automation.handoff).toHaveBeenNthCalledWith(1, timed, first.deviceStatus, "live");
    expect(automation.handoff).toHaveBeenNthCalledWith(2, timed, first.deviceStatus, "recovery");
    expect(records.get(command.idempotencyKey)).toMatchObject({ automationHandoff: "completed" });
  });

  it("closes a prepared accepted-only command through a replayable indeterminate handoff without RF", async () => {
    const adapter = new StubBleMeshAdapter();
    const timed = { ...command, overrideUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const records = new Map<string, any>([[command.idempotencyKey, {
      state: "accepted",
      command: { command: timed },
      automationHandoff: "not_required"
    }]]);
    const automation = {
      prepare: vi.fn(),
      handoff: vi.fn().mockResolvedValue(undefined)
    };

    const recovered = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(records),
      timed,
      undefined,
      { automation }
    );

    expect(recovered.deviceStatus.status).toBe("timed_out");
    expect(adapter.commands).toHaveLength(0);
    expect(automation.prepare).not.toHaveBeenCalled();
    expect(automation.handoff).toHaveBeenCalledWith(timed, recovered.deviceStatus, "recovery");
    expect(records.get(command.idempotencyKey)).toMatchObject({
      state: "completed",
      automationHandoff: "completed"
    });
  });

  it.each([false, true])("replays accepted manual preparation without broker redelivery (legacy expiry: %s)", async (legacy) => {
    const timed = legacy ? { ...command, overrideUntil: new Date(Date.now() + 3_600_000).toISOString() } : command;
    const completed: unknown[] = [];
    const marked: string[] = [];
    const journal = {
      pendingAutomationRecoveries: async () => [{
        idempotencyKey: command.idempotencyKey,
        state: "accepted" as const,
        command: { command: timed }
      }],
      complete: async (_key: string, result: unknown, options?: unknown) => { completed.push({ result, options }); },
      markAutomationHandoffComplete: async (key: string) => { marked.push(key); }
    };
    const automation = { prepare: vi.fn(), handoff: vi.fn().mockResolvedValue(undefined) };

    await recoverPendingManualAutomationHandoffs(journal, automation);

    expect(completed).toEqual([expect.objectContaining({
      result: expect.objectContaining({ deviceStatus: expect.objectContaining({ status: "timed_out" }) }),
      options: { automationHandoffPending: true }
    })]);
    expect(automation.handoff).toHaveBeenCalledWith(
      timed,
      expect.objectContaining({ status: "timed_out" }),
      "recovery"
    );
    expect(marked).toEqual([command.idempotencyKey]);
  });

  it("replays a legacy near-expiry manual journal record during a mixed-version restart", async () => {
    const legacy = {
      ...command,
      requestedAt: "2026-07-11T00:00:00.000Z",
      overrideUntil: "2026-07-11T00:00:05.000Z",
      expiresAt: "2026-07-11T00:00:10.000Z"
    };
    const journal = {
      pendingAutomationRecoveries: async () => [{
        idempotencyKey: legacy.idempotencyKey,
        state: "accepted" as const,
        command: { command: legacy }
      }],
      complete: vi.fn().mockResolvedValue(undefined),
      markAutomationHandoffComplete: vi.fn().mockResolvedValue(undefined)
    };
    const automation = { prepare: vi.fn(), handoff: vi.fn().mockResolvedValue(undefined) };

    await recoverPendingManualAutomationHandoffs(journal, automation);

    expect(journal.complete).toHaveBeenCalledWith(
      legacy.idempotencyKey,
      expect.objectContaining({ deviceStatus: expect.objectContaining({ status: "timed_out" }) }),
      { automationHandoffPending: true }
    );
    expect(automation.handoff).toHaveBeenCalledWith(
      legacy,
      expect.objectContaining({ status: "timed_out" }),
      "recovery"
    );
    expect(journal.markAutomationHandoffComplete).toHaveBeenCalledWith(legacy.idempotencyKey);
  });

  it("closes a durable manual prepare failure without starting RF", async () => {
    const adapter = new StubBleMeshAdapter();
    const timed = { ...command, overrideUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const automation = {
      prepare: vi.fn(async () => { throw Object.assign(new Error("state unavailable"), { code: "automation_state_unavailable" }); }),
      handoff: vi.fn()
    };

    const result = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(new Map()),
      timed,
      undefined,
      { automation }
    );

    expect(result.acceptance.status).toBe("accepted");
    expect(result.deviceStatus).toMatchObject({
      status: "failed",
      results: [{ fixtureId: command.targetFixtureIds[0], status: "failed" }]
    });
    expect(adapter.commands).toHaveLength(0);
    expect(automation.handoff).toHaveBeenCalledWith(timed, result.deviceStatus, "live");
  });

  it("rejects a command whose publish-relative expiry passed without calling BLE or observing fixture state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:10.000Z"));
    const records = new Map<string, any>();
    const adapter = new StubBleMeshAdapter();

    const result = await handleGatewayDimmingCommand(adapter, memoryJournal(records), {
      ...command,
      requestedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-11T00:00:00.000Z"
    });

    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
    expect(result.deviceStatus).toMatchObject({
      status: "failed",
      results: [{ status: "failed", errorMessage: "gateway command expired before execution" }]
    });
    expect(result.fixtureStateObserved).toBe(false);
    expect(adapter.commands).toHaveLength(0);
    vi.useRealTimers();
  });

  it("does not reject an old requestedAt when its publish-relative expiry is still valid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:01.000Z"));
    const adapter = new StubBleMeshAdapter();

    const result = await handleGatewayDimmingCommand(adapter, memoryJournal(new Map()), {
      ...command,
      requestedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-11T00:00:10.000Z"
    });

    expect(result.acceptance.status).toBe("accepted");
    expect(result.fixtureStateObserved).toBe(true);
    expect(adapter.commands).toHaveLength(1);
    vi.useRealTimers();
  });

  it("accepts a broker-bounded manual command when the wall clock is untrusted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:20.000Z"));
    const adapter = new StubBleMeshAdapter();
    const automation = {
      prepare: vi.fn().mockResolvedValue(undefined),
      handoff: vi.fn().mockResolvedValue(undefined)
    };

    const result = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(new Map()),
      {
        ...command,
        overrideUntil: "2026-07-11T01:00:00.000Z",
        expiresAt: "2026-07-11T00:00:10.000Z"
      },
      undefined,
      {
        automation,
        isCommandExpired: vi.fn().mockResolvedValue(false)
      }
    );

    expect(result.acceptance.status).toBe("accepted");
    expect(adapter.commands).toHaveLength(1);
    expect(automation.prepare).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reserves durable state capacity before acceptance or physical BLE execution", async () => {
    const records = new Map<string, any>();
    const adapter = new StubBleMeshAdapter();
    const beforeExecution = vi.fn().mockRejectedValue(new Error("state event outbox capacity exceeded"));

    const result = await handleGatewayDimmingCommand(adapter, memoryJournal(records), command, undefined, { beforeExecution });

    expect(beforeExecution).toHaveBeenCalledTimes(1);
    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "STATE_OUTBOX_CAPACITY" });
    expect(result.fixtureStateObserved).toBe(false);
    expect(adapter.commands).toHaveLength(0);
  });

  it("rejects after a delayed acceptance crosses expiry before BLE starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:07.999Z"));
    const records = new Map<string, any>();
    const adapter = new StubBleMeshAdapter();
    let releaseAcceptance!: () => void;
    let acceptanceStarted!: () => void;
    const acceptanceGate = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    const acceptanceStartedGate = new Promise<void>((resolve) => { acceptanceStarted = resolve; });

    const resultPromise = handleGatewayDimmingCommand(
      adapter,
      memoryJournal(records),
      { ...command, expiresAt: "2026-07-11T00:00:10.000Z" },
      async (acceptance) => {
        expect(acceptance.status).toBe("accepted");
        acceptanceStarted();
        await acceptanceGate;
      }
    );
    await acceptanceStartedGate;
    await vi.advanceTimersByTimeAsync(1);
    releaseAcceptance();

    const result = await resultPromise;

    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
    expect(result.deviceStatus.status).toBe("failed");
    expect(result.fixtureStateObserved).toBe(false);
    expect(records.get(command.idempotencyKey)).toMatchObject({ state: "completed", result: { acceptance: { status: "rejected" } } });
    expect(adapter.commands).toHaveLength(0);
    vi.useRealTimers();
  });

  it("rejects after acceptance exhausts the broker receipt deadline even when wall time is untrusted", async () => {
    let monotonicNow = 1_000;
    const adapter = new StubBleMeshAdapter();

    const result = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(new Map()),
      { ...command, expiresAt: "2026-07-11T00:00:10.000Z" },
      async () => { monotonicNow = 3_001; },
      {
        isCommandExpired: vi.fn().mockResolvedValue(false),
        receipt: { receivedAtMonotonicMs: 1_000, brokerRemainingTtlMs: 2_000 },
        monotonicClock: () => monotonicNow
      }
    );

    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
    expect(result.fixtureStateObserved).toBe(false);
    expect(adapter.commands).toHaveLength(0);
  });

  it("rechecks the broker receipt deadline after manual persistence immediately before RF", async () => {
    let monotonicNow = 1_000;
    const adapter = new StubBleMeshAdapter();
    const automation = {
      prepare: vi.fn(async () => { monotonicNow = 3_001; }),
      abortManualControl: vi.fn().mockResolvedValue(undefined),
      handoff: vi.fn().mockResolvedValue(undefined)
    };

    const result = await handleGatewayDimmingCommand(
      adapter,
      memoryJournal(new Map()),
      { ...command, overrideUntil: "2026-07-11T01:00:00.000Z" },
      undefined,
      {
        isCommandExpired: vi.fn().mockResolvedValue(false),
        receipt: { receivedAtMonotonicMs: 1_000, brokerRemainingTtlMs: 2_000 },
        monotonicClock: () => monotonicNow,
        automation
      }
    );

    expect(automation.prepare).toHaveBeenCalledTimes(1);
    expect(result.acceptance).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
    expect(adapter.commands).toHaveLength(0);
    expect(automation.handoff).not.toHaveBeenCalled();
    expect(automation.abortManualControl).toHaveBeenCalledWith(command.commandId, command.targetFixtureIds);
  });

  it("times out a BLE adapter that never returns", async () => {
    vi.useFakeTimers();
    const records = new Map<string, any>();
    const journal = memoryJournal(records);
    const pendingAdapter = {
      setBrightness: vi.fn(() => new Promise<never>(() => undefined)),
      onFixtureStatus: vi.fn(() => () => undefined),
      onLightingObservation: vi.fn(() => () => undefined),
      resyncFixtureStates: vi.fn(async () => ({ total: 0, configured: 0, observed: 0, healthPending: 0, timedOut: 0, failed: 0 })),
      resyncLightingFixtures: vi.fn(async () => ({ total: 0, configured: 0, observed: 0, healthPending: 0, timedOut: 0, failed: 0 })),
      syncGroupSubscriptions: vi.fn(async () => ({
        siteId: command.siteId,
        gatewayId: command.gatewayId,
        groupId: command.targetId,
        version: 1,
        groupAddress: "0xc000",
        operations: [],
        occurredAt: new Date().toISOString()
      }))
    };

    const resultPromise = handleGatewayDimmingCommand(pendingAdapter, journal, command, undefined, { timeoutMs: 8000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8250);
    const result = await resultPromise;

    expect(result.deviceStatus).toMatchObject({
      status: "timed_out",
      results: [{ fixtureId: command.targetFixtureIds[0], status: "timed_out", errorMessage: "BLE Mesh status timeout after 8000ms" }]
    });
    vi.useRealTimers();
  });

  it("closes an accepted-only restart as indeterminate without controlling again", async () => {
    const acceptance = {
      commandId: command.commandId,
      dispatchId: command.dispatchId,
      idempotencyKey: command.idempotencyKey,
      sequence: command.sequence,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      eventId: "88888888-8888-4888-8888-888888888888",
      status: "accepted" as const,
      acceptedAt: "2026-07-11T00:00:01.000Z"
    };
    const records = new Map<string, any>([
      [command.idempotencyKey, { state: "accepted", command: { command, acceptance } }]
    ]);
    const journal = memoryJournal(records);
    const adapter = new StubBleMeshAdapter();

    const result = await handleGatewayDimmingCommand(adapter, journal, command);

    expect(result.deviceStatus.status).toBe("timed_out");
    expect(result.deviceStatus.results[0]).toMatchObject({ status: "timed_out", errorMessage: "indeterminate after gateway restart" });
    expect(adapter.commands).toHaveLength(0);
  });

  it("dispatches unicast and parallel-unicast through their explicit adapter methods", async () => {
    const applyUnicast = vi.fn(async (fixtureId: string, brightness: number) => ({
      fixtureId, acknowledged: true, brightness, rssi: null, hopCount: null
    }));
    const applyParallelUnicast = vi.fn(async (fixtureIds: string[], brightness: number, concurrency: number) =>
      fixtureIds.map((fixtureId) => ({ fixtureId, acknowledged: true, brightness, rssi: null, hopCount: null }))
    );
    const adapter = { setBrightness: vi.fn(), applyUnicast, applyParallelUnicast } as any;

    await handleGatewayDimmingCommand(adapter, memoryJournal(new Map()), command);
    await handleGatewayDimmingCommand(adapter, memoryJournal(new Map()), {
      ...command,
      idempotencyKey: "99999999-9999-4999-8999-999999999991",
      targetType: "fixtures",
      targetId: null,
      targetFixtureIds: [command.targetFixtureIds[0], "66666666-6666-4666-8666-666666666667"],
      deliveryMode: "parallel_unicast"
    });

    expect(applyUnicast).toHaveBeenCalledWith(
      command.targetFixtureIds[0],
      65,
      expect.any(AbortSignal),
      expect.any(Number)
    );
    expect(applyParallelUnicast).toHaveBeenCalledWith(
      [command.targetFixtureIds[0], "66666666-6666-4666-8666-666666666667"],
      65,
      8,
      expect.any(AbortSignal),
      expect.any(Number)
    );
    expect(adapter.setBrightness).not.toHaveBeenCalled();
  });

  it("reuses limited parallel unicast and returns terminal automation results per fixture", async () => {
    const fixtures = [command.targetFixtureIds[0], "66666666-6666-4666-8666-666666666667"];
    const applyParallelUnicast = vi.fn(async (fixtureIds: string[], brightness: number, concurrency: number) =>
      fixtureIds.map((fixtureId, index) => ({
        fixtureId,
        acknowledged: index === 0,
        outcome: index === 0 ? "applied" as const : "timed_out" as const,
        brightness,
        ...(index === 0 ? {} : { faultCode: "status_timeout" }),
        rssi: null,
        hopCount: null
      }))
    );

    const results = await executeAutomationDimmingActions(
      { setBrightness: vi.fn(), applyParallelUnicast } as any,
      fixtures.map((fixtureId) => ({ fixtureId, brightnessPercent: 70 })),
      { now: () => new Date("2026-08-30T01:00:00.000Z") }
    );

    expect(applyParallelUnicast).toHaveBeenCalledWith(fixtures, 70, 8, expect.any(AbortSignal), expect.any(Number));
    expect(results).toEqual([
      {
        fixtureId: fixtures[0],
        status: "succeeded",
        brightnessPercent: 70,
        faultCode: null,
        errorCode: null,
        occurredAt: "2026-08-30T01:00:00.000Z"
      },
      {
        fixtureId: fixtures[1],
        status: "timed_out",
        brightnessPercent: null,
        faultCode: "status_timeout",
        errorCode: "status_timeout",
        occurredAt: "2026-08-30T01:00:00.000Z"
      }
    ]);
  });

  it("validates an exact durable ready snapshot before accepting and sending one mesh group command", async () => {
    const events: string[] = [];
    const groupStateStore = {
      assertReady: vi.fn(async () => { events.push("ready"); })
    };
    const applyMeshGroup = vi.fn(async (_address: number, fixtureIds: string[], brightness: number) => {
      events.push("mesh");
      return fixtureIds.map((fixtureId) => ({
        fixtureId,
        acknowledged: true,
        outcome: "applied" as const,
        brightness,
        rssi: null,
        hopCount: null
      }));
    });
    const groupCommand = meshCommand();

    const result = await handleGatewayDimmingCommand(
      { setBrightness: vi.fn(), applyMeshGroup } as any,
      memoryJournal(new Map()),
      groupCommand,
      async () => { events.push("accepted"); },
      { groupStateStore, groupQueue: new KeyedSerialTaskQueue() }
    );

    expect(events).toEqual(["ready", "accepted", "mesh"]);
    expect(groupStateStore.assertReady).toHaveBeenCalledWith({
      groupId: groupCommand.meshControlGroupId,
      groupAddress: "0xc000",
      version: 3
    });
    expect(applyMeshGroup).toHaveBeenCalledWith(
      0xc000,
      groupCommand.targetFixtureIds,
      65,
      expect.any(AbortSignal),
      expect.any(Number)
    );
    expect(result.acceptance.status).toBe("accepted");
  });

  it("durably rejects a mesh group snapshot mismatch without acceptance callback or BLE send", async () => {
    const records = new Map<string, any>();
    const onAccepted = vi.fn();
    const applyMeshGroup = vi.fn();
    const groupCommand = meshCommand();
    const options = {
      groupStateStore: {
        assertReady: vi.fn(async () => { throw Object.assign(new Error("not ready"), { code: "MESH_GROUP_NOT_READY" }); })
      },
      groupQueue: new KeyedSerialTaskQueue()
    };

    const first = await handleGatewayDimmingCommand(
      { setBrightness: vi.fn(), applyMeshGroup } as any,
      memoryJournal(records),
      groupCommand,
      onAccepted,
      options
    );
    const duplicate = await handleGatewayDimmingCommand(
      { setBrightness: vi.fn(), applyMeshGroup } as any,
      memoryJournal(records),
      groupCommand,
      onAccepted,
      options
    );

    expect(first.acceptance).toMatchObject({ status: "rejected", errorCode: "MESH_GROUP_NOT_READY" });
    expect(first.deviceStatus.results).toEqual(groupCommand.targetFixtureIds.map((fixtureId) => expect.objectContaining({
      fixtureId,
      status: "failed"
    })));
    expect(duplicate).toEqual(first);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(applyMeshGroup).not.toHaveBeenCalled();
  });

  it("maps per-fixture group timeout and state mismatch without collapsing the whole result", async () => {
    const groupCommand = meshCommand();
    const result = await handleGatewayDimmingCommand(
      {
        setBrightness: vi.fn(),
        applyMeshGroup: vi.fn(async () => [
          { fixtureId: groupCommand.targetFixtureIds[0], acknowledged: false, outcome: "failed", brightness: 30, faultCode: "state_mismatch", rssi: null, hopCount: null },
          { fixtureId: groupCommand.targetFixtureIds[1], acknowledged: false, outcome: "timed_out", brightness: 65, faultCode: "status_timeout", rssi: null, hopCount: null }
        ])
      } as any,
      memoryJournal(new Map()),
      groupCommand,
      undefined,
      { groupStateStore: { assertReady: vi.fn() }, groupQueue: new KeyedSerialTaskQueue() }
    );

    expect(result.deviceStatus).toMatchObject({
      status: "failed",
      results: [
        { status: "failed", faultCode: "state_mismatch" },
        { status: "timed_out", faultCode: "status_timeout" }
      ]
    });
    expect(result.observedFixtureIds).toEqual([groupCommand.targetFixtureIds[0]]);
    expect(result.deviceStatus.results[0]).toMatchObject({ brightness: 30 });
  });

  it("preserves a BIO sensor-mode mismatch without marking power-unknown state publishable", async () => {
    const result = await handleGatewayDimmingCommand(
      {
        setBrightness: vi.fn(async () => [{
          fixtureId: command.targetFixtureIds[0],
          acknowledged: false,
          outcome: "failed" as const,
          brightness: 38,
          mode: "sensor" as const,
          faultCode: "BIO_CONTROL_MODE_STATE_MISMATCH",
          rssi: -41,
          hopCount: null
        }])
      } as any,
      memoryJournal(new Map()),
      command
    );

    expect(result.fixtureStateObserved).toBe(false);
    expect(result.observedFixtureIds).toEqual([]);
    expect(result.fixtureObservations).toEqual([{
      fixtureId: command.targetFixtureIds[0],
      brightness: 38,
      mode: "sensor"
    }]);
    expect(result.deviceStatus).toMatchObject({
      status: "failed",
      results: [{
        fixtureId: command.targetFixtureIds[0],
        status: "failed",
        brightness: 38,
        faultCode: "BIO_CONTROL_MODE_STATE_MISMATCH",
        rssi: -41,
        hopCount: null
      }]
    });
  });

  it("marks a BIO mismatch publishable only when brightness and exact force mode were observed", async () => {
    const result = await handleGatewayDimmingCommand(
      {
        setBrightness: vi.fn(async () => [{
          fixtureId: command.targetFixtureIds[0],
          acknowledged: false,
          outcome: "failed" as const,
          brightness: 38,
          mode: "force-off" as const,
          faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH",
          rssi: -41,
          hopCount: null
        }])
      } as any,
      memoryJournal(new Map()),
      command
    );

    expect(result.fixtureStateObserved).toBe(true);
    expect(result.observedFixtureIds).toEqual(command.targetFixtureIds);
    expect(result.fixtureObservations).toEqual([{
      fixtureId: command.targetFixtureIds[0],
      brightness: 38,
      mode: "force-off"
    }]);
  });

  it("preserves a mode-only BIO mismatch without marking unknown brightness publishable", async () => {
    const result = await handleGatewayDimmingCommand(
      {
        setBrightness: vi.fn(async () => [{
          fixtureId: command.targetFixtureIds[0],
          acknowledged: false,
          outcome: "failed" as const,
          mode: "force-on" as const,
          faultCode: "BIO_CONTROL_MODE_STATE_MISMATCH",
          rssi: -41,
          hopCount: null
        }])
      } as any,
      memoryJournal(new Map()),
      command
    );

    expect(result.fixtureStateObserved).toBe(false);
    expect(result.observedFixtureIds).toEqual([]);
    expect(result.fixtureObservations).toEqual([{
      fixtureId: command.targetFixtureIds[0],
      mode: "force-on"
    }]);
    expect(result.deviceStatus.results[0]).not.toHaveProperty("brightness");
  });

  it("aborts the adapter signal when the outer command timeout expires", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const adapter = {
        setBrightness: vi.fn(),
        applyParallelUnicast: vi.fn((_fixtures, _brightness, _concurrency, receivedSignal: AbortSignal) => {
          signal = receivedSignal;
          return new Promise<never>(() => undefined);
        })
      } as any;
      const pending = handleGatewayDimmingCommand(adapter, memoryJournal(new Map()), {
        ...command,
        targetType: "fixtures",
        targetId: null,
        targetFixtureIds: [command.targetFixtureIds[0], "66666666-6666-4666-8666-666666666667"],
        deliveryMode: "parallel_unicast"
      }, undefined, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1250);

      await expect(pending).resolves.toMatchObject({ deviceStatus: { status: "timed_out" } });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an adapter mismatch returned at the end of its status collection window", async () => {
    vi.useFakeTimers();
    try {
      const groupCommand = meshCommand();
      const adapter = {
        setBrightness: vi.fn(),
        applyMeshGroup: vi.fn(async () => {
          await Promise.resolve();
          return await new Promise<any[]>((resolve) => {
            setTimeout(() => resolve(groupCommand.targetFixtureIds.map((fixtureId) => ({
              fixtureId,
              acknowledged: false,
              outcome: "failed",
              brightness: 30,
              faultCode: "state_mismatch",
              rssi: null,
              hopCount: null
            }))), 8000);
          });
        })
      } as any;

      const pending = handleGatewayDimmingCommand(
        adapter,
        memoryJournal(new Map()),
        groupCommand,
        undefined,
        { timeoutMs: 8000, groupStateStore: { assertReady: vi.fn() }, groupQueue: new KeyedSerialTaskQueue() }
      );
      await vi.advanceTimersByTimeAsync(8000);

      await expect(pending).resolves.toMatchObject({
        deviceStatus: {
          status: "failed",
          results: [
            { status: "failed", faultCode: "state_mismatch" },
            { status: "failed", faultCode: "state_mismatch" }
          ]
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes one absolute deadline so slow preparation still preserves the terminal mismatch", async () => {
    vi.useFakeTimers();
    try {
      const groupCommand = meshCommand();
      const applyMeshGroup = vi.fn(
        async (_address: number, fixtureIds: string[], _brightness: number, _signal: AbortSignal, deadlineAt: number) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return await new Promise<any[]>((resolve) => {
            setTimeout(() => resolve(fixtureIds.map((fixtureId) => ({
              fixtureId,
              acknowledged: false,
              outcome: "failed",
              brightness: 30,
              faultCode: "state_mismatch",
              rssi: null,
              hopCount: null
            }))), Math.max(0, deadlineAt - Date.now()));
          });
        }
      );
      const pending = handleGatewayDimmingCommand(
        { setBrightness: vi.fn(), applyMeshGroup } as any,
        memoryJournal(new Map()),
        groupCommand,
        undefined,
        { timeoutMs: 1000, groupStateStore: { assertReady: vi.fn() }, groupQueue: new KeyedSerialTaskQueue() }
      );

      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toMatchObject({
        deviceStatus: { status: "failed", results: [{ faultCode: "state_mismatch" }, { faultCode: "state_mismatch" }] }
      });
      expect(applyMeshGroup.mock.calls[0][4]).toBeTypeOf("number");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a genuinely hung adapter after the bounded completion grace", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let settled = false;
      const adapter = {
        setBrightness: vi.fn(),
        applyParallelUnicast: vi.fn((_fixtures, _brightness, _concurrency, receivedSignal: AbortSignal) => {
          signal = receivedSignal;
          return new Promise<never>(() => undefined);
        })
      } as any;
      const pending = handleGatewayDimmingCommand(adapter, memoryJournal(new Map()), {
        ...command,
        targetType: "fixtures",
        targetId: null,
        targetFixtureIds: [command.targetFixtureIds[0], "66666666-6666-4666-8666-666666666667"],
        deliveryMode: "parallel_unicast"
      }, undefined, { timeoutMs: 8000 });
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(8249);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ deviceStatus: { status: "timed_out" } });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits behind same-group subscription work but not unrelated group work", async () => {
    const queue = new KeyedSerialTaskQueue();
    const groupCommand = meshCommand();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = queue.run(groupCommand.meshControlGroupId, async () => gate);
    const applyMeshGroup = vi.fn(async (_address: number, fixtureIds: string[], brightness: number) =>
      fixtureIds.map((fixtureId) => ({ fixtureId, acknowledged: true, brightness, rssi: null, hopCount: null }))
    );
    const pending = handleGatewayDimmingCommand(
      { setBrightness: vi.fn(), applyMeshGroup } as any,
      memoryJournal(new Map()),
      groupCommand,
      undefined,
      { groupStateStore: { assertReady: vi.fn() }, groupQueue: queue }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applyMeshGroup).not.toHaveBeenCalled();
    release();
    await held;
    await pending;
    expect(applyMeshGroup).toHaveBeenCalledTimes(1);
  });
});

function meshCommand() {
  return {
    ...command,
    idempotencyKey: "99999999-9999-4999-8999-999999999992",
    targetType: "floor" as const,
    targetId: "88888888-8888-4888-8888-888888888888",
    targetFixtureIds: [command.targetFixtureIds[0], "66666666-6666-4666-8666-666666666667"],
    deliveryMode: "mesh_group" as const,
    destinationAddress: "0xc000",
    meshControlGroupId: "88888888-8888-4888-8888-888888888889",
    meshControlGroupVersion: 3
  };
}

function memoryJournal(records: Map<string, any>) {
  return {
    get: async (key: string) => records.get(key) ?? null,
    accept: async (key: string, value: unknown, options: { executionPhase?: "pre_rf" } = {}) => {
      if (records.has(key)) return false;
      records.set(key, { state: "accepted", command: value, ...options });
      return true;
    },
    complete: async (key: string, result: unknown, options: { automationHandoffPending?: boolean; automationAbortPending?: boolean } = {}) => {
      records.set(key, {
        ...records.get(key),
        state: "completed",
        result,
        ...(options.automationAbortPending ? { automationAbort: "pending" } : {}),
        automationHandoff: options.automationHandoffPending ? "pending" : "not_required"
      });
    },
    markAutomationHandoffComplete: async (key: string) => {
      records.set(key, { ...records.get(key), automationHandoff: "completed" });
    },
    markExecutionMayHaveStarted: async (key: string) => {
      records.set(key, { ...records.get(key), executionPhase: "may_have_written" });
    },
    markAutomationAbortComplete: async (key: string) => {
      records.set(key, { ...records.get(key), automationAbort: "completed" });
    }
  };
}
