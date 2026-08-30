import { describe, expect, it, vi } from "vitest";
import { StubBleMeshAdapter } from "../../test/stub-adapters";
import {
  executeAutomationDimmingActions,
  handleGatewayDimmingCommand,
  parseCommandTimeout,
  recoverPendingManualAutomationHandoffs
} from "./gateway-command-handler";
import { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

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
  requestedBy: "77777777-7777-4777-8777-777777777777",
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
};

describe("handleGatewayDimmingCommand", () => {
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

  it("durably prepares a timed manual override before RF and hands off its terminal fixture results once", async () => {
    const events: string[] = [];
    const adapter = new StubBleMeshAdapter();
    const automation = {
      prepare: vi.fn(async () => { events.push("prepared"); }),
      handoff: vi.fn(async () => { events.push("handoff"); })
    };
    const timed = { ...command, overrideUntil: new Date(Date.now() + 3_600_000).toISOString() };
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
    expect(automation.handoff).toHaveBeenCalledWith(timed, first.deviceStatus);
    expect(duplicate).toEqual(first);
    expect(adapter.commands).toHaveLength(1);
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
    expect(automation.handoff).toHaveBeenCalledWith(timed, recovered.deviceStatus);
    expect(records.get(command.idempotencyKey)).toMatchObject({
      state: "completed",
      automationHandoff: "completed"
    });
  });

  it("replays accepted-only manual preparation during startup without waiting for broker redelivery", async () => {
    const timed = { ...command, overrideUntil: new Date(Date.now() + 3_600_000).toISOString() };
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
      expect.objectContaining({ status: "timed_out" })
    );
    expect(marked).toEqual([command.idempotencyKey]);
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
    expect(automation.handoff).toHaveBeenCalledWith(timed, result.deviceStatus);
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

  it("times out a BLE adapter that never returns", async () => {
    vi.useFakeTimers();
    const records = new Map<string, any>();
    const journal = memoryJournal(records);
    const pendingAdapter = {
      setBrightness: vi.fn(() => new Promise<never>(() => undefined)),
      onFixtureStatus: vi.fn(() => () => undefined),
      onLightingObservation: vi.fn(() => () => undefined),
      resyncFixtureStates: vi.fn(async () => ({ total: 0, configured: 0, observed: 0, healthPending: 0, timedOut: 0, failed: 0 })),
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
    accept: async (key: string, value: unknown) => {
      if (records.has(key)) return false;
      records.set(key, { state: "accepted", command: value });
      return true;
    },
    complete: async (key: string, result: unknown, options: { automationHandoffPending?: boolean } = {}) => {
      records.set(key, {
        ...records.get(key),
        state: "completed",
        result,
        automationHandoff: options.automationHandoffPending ? "pending" : "not_required"
      });
    },
    markAutomationHandoffComplete: async (key: string) => {
      records.set(key, { ...records.get(key), automationHandoff: "completed" });
    }
  };
}
