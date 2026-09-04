import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGatewayAutomationServices,
  initializeAutomationBeforeManualRecovery,
  observeAutomationFixtureStatuses,
  requeuePendingFixtureObservations,
  createDurableAutomationLifecycleHandoff,
  createDurableAutomationTerminalHandoff,
  executeAutomationWithBestEffortTelemetry,
  gatewayDeferredPubackTopics,
  enqueueAutomationFixtureStates,
  createManualOverrideCoordinator,
  createFixtureStatusPublisher,
  createProvisioningScanCompletedPayload,
  createProvisioningScanFailedPayload,
  createProvisioningScanFoundPayload,
  createMeshGroupResyncRequest,
  observedFixtureResults,
  publishObservedDeviceStates,
  createMqttIdentityActivation,
  connectGatewayServices,
  drainGatewayProcessShutdown,
  handleProvisioningDevicePayloadForCurrentScope,
  parseGatewayHeartbeatInterval,
  recordMeshResyncOutcome,
  registerGatewayShutdownHandlers,
  shouldPublishFinalAcceptance,
  shouldPublishFixtureStates,
  stateEventOutboxHealthReason,
  handoffPersistedAutomationTelemetryGap,
  handleProvisionDeviceCommand,
  recordAndHandoffAutomationTelemetryGap,
  startGatewayRuntime,
  subscribeGatewayAcknowledgements,
  subscribeGatewayCommands
} from "./index";
import { StateEventOutboxError } from "./state/state-event-outbox";
import { provisioningScanCompletedSchema, provisioningScanFailedSchema, provisioningScanFoundSchema } from "@led-control/shared";
import { FileAutomationStateStore } from "./automation/automation-state-store";
import { AutomationTelemetryOutbox } from "./automation/automation-telemetry-outbox";
import { automationScope, automationSnapshot } from "./automation/automation-test-fixtures";
import {
  handleGatewayDimmingCommand,
  recoverPendingManualAutomationHandoffs
} from "./commands/gateway-command-handler";

const scopedSiteId = "00000000-0000-4000-8000-000000000003";
const scopedGatewayId = "00000000-0000-4000-8000-000000000004";
const scopedFixtureId = "00000000-0000-4000-8000-000000000005";

it("defers QoS1 PUBACK for commands whose durable journal must commit first", () => {
  expect(gatewayDeferredPubackTopics(scopedSiteId, scopedGatewayId)).toEqual([
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/dimming`,
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/provisioning/provision-device`,
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/automation/config-sync`
  ]);
});

it("publishes provisioning completion before isolating capability refresh failure", async () => {
  const command = {
    sessionId: "00000000-0000-4000-8000-000000000010",
    siteId: scopedSiteId,
    gatewayId: scopedGatewayId,
    nodeId: "00000000-0000-4000-8000-000000000011",
    deviceUuid: "00112233445566778899aabbccddeeff",
    meshAddress: "0x1201",
    requestedAt: "2026-08-30T00:00:00.000Z"
  };
  const completed = {
    sessionId: command.sessionId,
    nodeId: command.nodeId,
    deviceUuid: command.deviceUuid,
    meshAddress: command.meshAddress,
    completedAt: "2026-08-30T00:00:01.000Z"
  };
  let releasePublish!: () => void;
  const publishTerminal = vi.fn(() => new Promise<void>((resolve) => { releasePublish = resolve; }));
  const requestCapabilityRefresh = vi.fn(async () => { throw new Error("private config failure"); });
  const onCapabilityRefreshError = vi.fn();
  const handling = handleProvisionDeviceCommand({
    adapter: { provision: vi.fn(async () => completed), identify: vi.fn(async () => undefined) },
    command,
    publishTerminal,
    requestCapabilityRefresh,
    onCapabilityRefreshError
  });
  await vi.waitFor(() => expect(publishTerminal).toHaveBeenCalledWith(
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/events/provisioning-completed`,
    completed
  ));
  expect(requestCapabilityRefresh).not.toHaveBeenCalled();
  releasePublish();
  await handling;
  await vi.waitFor(() => expect(onCapabilityRefreshError).toHaveBeenCalledTimes(1));
  expect(requestCapabilityRefresh).toHaveBeenCalledWith(command.nodeId);
  expect(JSON.stringify(onCapabilityRefreshError.mock.calls)).not.toContain("private config failure");
});

it.each(["siteId", "gatewayId"] as const)(
  "rejects a valid provisioning payload with a mismatched %s before journal or RF handling",
  async (scopeKey) => {
    const handle = vi.fn();
    const payload = Buffer.from(JSON.stringify({
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: scopeKey === "siteId" ? "99999999-9999-4999-8999-999999999999" : scopedSiteId,
      gatewayId: scopeKey === "gatewayId" ? "99999999-9999-4999-8999-999999999999" : scopedGatewayId,
      nodeId: "44444444-4444-4444-8444-444444444444",
      deviceUuid: "00112233445566778899aabbccddeeff",
      meshAddress: "0x0101",
      requestedAt: "2026-09-03T00:00:00.000Z"
    }));

    await expect(handleProvisioningDevicePayloadForCurrentScope({
      payload,
      scope: { siteId: scopedSiteId, gatewayId: scopedGatewayId },
      handle
    })).rejects.toThrow("provisioning device command scope mismatch");

    expect(handle).not.toHaveBeenCalled();
  }
);

it("quiesces process MQTT intake before blocking worker drains and stops the client last", async () => {
  const calls: string[] = [];
  let releaseDrain!: () => void;
  const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const runtime = {
    quiesceCommandIntake: vi.fn(async () => { calls.push("quiesce"); }),
    stop: vi.fn(async () => { calls.push("stop"); })
  };
  const shutdown = drainGatewayProcessShutdown({
    runtime,
    drainBeforeMqttStop: async () => {
      calls.push("drain");
      await drain;
    }
  });

  await vi.waitFor(() => expect(calls).toEqual(["quiesce", "drain"]));
  expect(runtime.stop).not.toHaveBeenCalled();
  releaseDrain();
  await shutdown;
  expect(calls).toEqual(["quiesce", "drain", "stop"]);
});

it("runs every shutdown stage and aggregates failures after command quiesce rejects", async () => {
  const calls: string[] = [];
  const quiesceError = new Error("UNSUBACK failed");
  const drainError = new Error("replay drain failed");
  const stopError = new Error("MQTT stop failed");
  const runtime = {
    quiesceCommandIntake: vi.fn(async () => {
      calls.push("quiesce");
      throw quiesceError;
    }),
    stop: vi.fn(async () => {
      calls.push("stop");
      throw stopError;
    })
  };

  const shutdown = drainGatewayProcessShutdown({
    runtime,
    drainBeforeMqttStop: async () => {
      calls.push("drain");
      throw drainError;
    }
  });

  await expect(shutdown).rejects.toMatchObject({
    errors: [quiesceError, drainError, stopError]
  });
  expect(calls).toEqual(["quiesce", "drain", "stop"]);
});

const assignment = {
  siteId: "site-27",
  gatewayId: "gateway-27",
  serialNumber: "GW-27",
  mqttUrl: "mqtts://broker.example:8883",
  configVersion: 1
};

describe("startGatewayRuntime", () => {
  it("connects Task 11 hot reload to the durable scheduler and executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-automation-wiring-"));
    try {
      let stored = null as ReturnType<typeof automationSnapshot> | null;
      const execute = vi.fn(async (actions: Array<{ fixtureId: string; brightnessPercent: number }>) => actions.map((action) => ({
        fixtureId: action.fixtureId,
        status: "succeeded" as const,
        brightnessPercent: action.brightnessPercent,
        faultCode: null,
        errorCode: null,
        occurredAt: "2026-08-30T01:30:00.000Z"
      })));
      const services = createGatewayAutomationServices({
        configStore: {
          load: async () => stored,
          apply: async (snapshot) => { stored = snapshot; },
          restore: async (snapshot) => { stored = snapshot; }
        },
        stateStore: new FileAutomationStateStore(join(directory, "state.json")),
        scope: automationScope,
        wallClock: () => new Date("2026-08-30T01:30:00.000Z"),
        monotonicClock: () => 1_000,
        clockTrust: { isTrusted: async () => true },
        execute
      });
      await services.scheduleRuntime.initialize();
      await services.scheduleRuntime.recordFixtureState(scopedFixtureId, 20);

      await services.automationRuntime.hotReload(automationSnapshot(1, {
        timeZone: "UTC",
        schedules: [{
          id: "00000000-0000-4000-8000-000000000103",
          name: "Active",
          status: "enabled",
          activeFrom: "2026-08-01T00:00:00.000Z",
          activeUntil: "2026-09-30T23:59:59.000Z",
          localStartTime: "01:00",
          localEndTime: "02:00",
          recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
          action: { dimmingEnabled: true, brightnessPercent: 40 },
          fixtureIds: [scopedFixtureId]
        }]
      }));

      expect(execute).toHaveBeenCalledWith([
        expect.objectContaining({ fixtureId: scopedFixtureId, brightnessPercent: 40, sourceType: "schedule" })
      ]);
      expect(services.scheduleRuntime.state().lastDesiredByFixture[scopedFixtureId]).toBe(40);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps new-generation timing metadata strict while mapping terminal results", async () => {
    const scheduleRuntime = {
      prepareManualOverride: vi.fn().mockResolvedValue(undefined),
      handoffManualTerminal: vi.fn().mockResolvedValue(undefined)
    };
    const coordinator = createManualOverrideCoordinator(scheduleRuntime);
    const command = {
      commandId: "11111111-1111-4111-8111-111111111111",
      targetFixtureIds: [scopedFixtureId],
      brightness: 60,
      requestedAt: "2026-08-30T01:00:00.000Z",
      overrideUntil: "2026-08-30T02:00:00.000Z",
      deliveryGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deliveryGeneratedAt: "2026-08-30T01:00:00.000Z",
      deliveryWindowMs: 10_000,
      overrideRemainingMs: 3_600_000,
      expiresAt: "2026-08-30T01:00:10.000Z"
    } as never;

    await coordinator.prepare(command, {
      receivedAtMonotonicMs: 5_000,
      brokerRemainingTtlMs: 7_000
    });
    await coordinator.handoff(command, {
      occurredAt: "2026-08-30T01:00:01.000Z",
      results: [{ fixtureId: scopedFixtureId, status: "timed_out", errorMessage: "private adapter detail" }]
    } as never);

    expect(scheduleRuntime.prepareManualOverride).toHaveBeenCalledWith({
      sourceId: "11111111-1111-4111-8111-111111111111",
      fixtureIds: [scopedFixtureId],
      brightnessPercent: 60,
      startedAt: "2026-08-30T01:00:00.000Z",
      overrideUntil: "2026-08-30T02:00:00.000Z",
      deliveryWindowMs: 7_000,
      overrideRemainingMs: 3_597_000
    });
    expect(scheduleRuntime.handoffManualTerminal).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      [{
        fixtureId: scopedFixtureId,
        status: "timed_out",
        brightnessPercent: null,
        faultCode: null,
        errorCode: "status_timeout",
        occurredAt: "2026-08-30T01:00:01.000Z"
      }]
    );
  });

  it("marks a legacy timed wire without inventing absolute remaining metadata", async () => {
    const scheduleRuntime = {
      prepareManualOverride: vi.fn().mockResolvedValue(undefined),
      handoffManualTerminal: vi.fn().mockResolvedValue(undefined)
    };
    const coordinator = createManualOverrideCoordinator(scheduleRuntime, () => 5_000);
    const command = {
      ...timedGatewayCommand(),
      requestedAt: "2026-08-30T01:00:00.000Z",
      overrideUntil: "2026-08-30T02:00:00.000Z",
      expiresAt: "2026-08-30T01:00:10.000Z"
    };

    await coordinator.prepare(command as never, {
      receivedAtMonotonicMs: 5_000,
      brokerRemainingTtlMs: 7_000
    });

    expect(scheduleRuntime.prepareManualOverride).toHaveBeenCalledWith({
      sourceId: command.commandId,
      fixtureIds: command.targetFixtureIds,
      brightnessPercent: command.brightness,
      startedAt: command.requestedAt,
      overrideUntil: command.overrideUntil,
      deliveryWindowMs: 7_000,
      timingSource: "legacy_wire"
    });
  });

  it.each([
    ["one hour", "2026-08-30T02:00:00.000Z"],
    ["30 days", "2026-09-29T01:00:00.000Z"]
  ])("rejects an old-publisher %s timed wire on an untrusted Gateway without RF", async (_case, overrideUntil) => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-untrusted-legacy-wire-"));
    try {
      const stateStore = new FileAutomationStateStore(join(directory, "state.json"));
      const services = createGatewayAutomationServices({
        configStore: {
          load: async () => null,
          apply: async () => undefined,
          restore: async () => undefined
        },
        stateStore,
        scope: automationScope,
        wallClock: () => new Date("2026-08-30T01:00:00.000Z"),
        monotonicClock: () => 5_000,
        clockTrust: { isTrusted: async () => false },
        execute: vi.fn()
      });
      await services.scheduleRuntime.initialize();
      await services.scheduleRuntime.recordFixtureState(scopedFixtureId, 20);
      const command = {
        ...timedGatewayCommand(),
        overrideUntil,
        expiresAt: "2026-08-30T01:00:10.000Z"
      };
      const setBrightness = vi.fn();

      const result = await handleGatewayDimmingCommand(
        { setBrightness } as never,
        memoryGatewayJournal(),
        command,
        undefined,
        {
          automation: createManualOverrideCoordinator(services.scheduleRuntime, () => 5_000),
          receipt: {
            receivedAtMonotonicMs: 5_000,
            brokerRemainingTtlMs: 10_000
          },
          monotonicClock: () => 5_000,
          isCommandExpired: () => false
        }
      );

      expect(setBrightness).not.toHaveBeenCalled();
      expect(result.deviceStatus).toMatchObject({
        status: "failed",
        results: [{
          fixtureId: scopedFixtureId,
          status: "failed",
          errorMessage: "legacy_timing_unverifiable"
        }]
      });
      expect(services.scheduleRuntime.state().manualOverrides).toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["trusted legacy", true, false, "2026-08-30T02:00:00.000Z", 3_600_000],
    ["untrusted new-generation", false, true, "2026-09-29T01:00:00.000Z", 30 * 24 * 60 * 60 * 1_000]
  ] as const)("executes a %s timed wire with verifiable remaining time", async (
    _case,
    trusted,
    newGeneration,
    overrideUntil,
    overrideRemainingMs
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-verifiable-timed-wire-"));
    try {
      const stateStore = new FileAutomationStateStore(join(directory, "state.json"));
      const services = createGatewayAutomationServices({
        configStore: {
          load: async () => null,
          apply: async () => undefined,
          restore: async () => undefined
        },
        stateStore,
        scope: automationScope,
        wallClock: () => new Date("2026-08-30T01:00:00.000Z"),
        monotonicClock: () => 5_000,
        clockTrust: { isTrusted: async () => trusted },
        execute: vi.fn()
      });
      await services.scheduleRuntime.initialize();
      await services.scheduleRuntime.recordFixtureState(scopedFixtureId, 20);
      const command = {
        ...timedGatewayCommand(),
        overrideUntil,
        expiresAt: "2026-08-30T01:00:10.000Z",
        ...(newGeneration ? {
          deliveryGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          deliveryGeneratedAt: "2026-08-30T01:00:00.000Z",
          deliveryWindowMs: 10_000,
          overrideRemainingMs
        } : {})
      };
      const setBrightness = vi.fn(async (fixtureIds: string[], brightness: number) => fixtureIds.map((targetFixtureId) => ({
        fixtureId: targetFixtureId,
        acknowledged: true,
        brightness,
        rssi: null,
        hopCount: null
      })));

      const result = await handleGatewayDimmingCommand(
        { setBrightness } as never,
        memoryGatewayJournal(),
        command as never,
        undefined,
        {
          automation: createManualOverrideCoordinator(services.scheduleRuntime, () => 5_000),
          receipt: {
            receivedAtMonotonicMs: 5_000,
            brokerRemainingTtlMs: 10_000
          },
          monotonicClock: () => 5_000,
          isCommandExpired: () => false
        }
      );

      expect(setBrightness).toHaveBeenCalledWith([scopedFixtureId], 60);
      expect(result.deviceStatus.status).toBe("succeeded");
      expect(services.scheduleRuntime.state().manualOverrides[scopedFixtureId]).toMatchObject({
        brightnessPercent: 60,
        overrideUntil
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("initializes the real snapshot runtime before replaying a pending manual terminal handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-manual-recovery-order-"));
    try {
      const stateStore = new FileAutomationStateStore(join(directory, "state.json"));
      await stateStore.initialize();
      await stateStore.updateDurable((state) => {
        state.currentByFixture[scopedFixtureId] = 20;
        state.baseBrightnessByFixture[scopedFixtureId] = 20;
        state.lastDesiredByFixture[scopedFixtureId] = 20;
        state.manualOverrides[scopedFixtureId] = {
          sourceId: "11111111-1111-4111-8111-111111111111",
          brightnessPercent: 60,
          startedAt: "2026-08-30T01:00:00.000Z",
          overrideUntil: "2026-08-30T02:00:00.000Z",
          preBrightness: 20
        };
        state.transitionsByFixture[scopedFixtureId] = {
          phase: "pending",
          brightnessPercent: 60,
          sourceType: "manual_override",
          sourceId: "11111111-1111-4111-8111-111111111111",
          occurrenceKey: null,
          attempt: 1,
          startedAt: "2026-08-30T01:00:00.000Z",
          status: null,
          terminalAt: null
        };
        return state;
      });
      const terminalHandoff = vi.fn().mockResolvedValue(undefined);
      const persisted = automationSnapshot(1);
      const services = createGatewayAutomationServices({
        configStore: {
          load: async () => persisted,
          apply: async () => undefined,
          restore: async () => undefined
        },
        stateStore,
        scope: automationScope,
        wallClock: () => new Date("2026-08-30T01:30:00.000Z"),
        monotonicClock: () => 1_000,
        clockTrust: { isTrusted: async () => true },
        execute: vi.fn(),
        onTerminalResults: terminalHandoff
      });
      await services.scheduleRuntime.initialize();
      const command = timedGatewayCommand();
      const journal = {
        pendingAutomationRecoveries: async () => [{
          idempotencyKey: command.idempotencyKey,
          state: "completed" as const,
          command: { command },
          result: successfulGatewayCommandResult(command)
        }],
        complete: vi.fn(),
        markAutomationHandoffComplete: vi.fn().mockResolvedValue(undefined)
      };
      const coordinator = createManualOverrideCoordinator(services.scheduleRuntime);

      await initializeAutomationBeforeManualRecovery(
        services.automationRuntime,
        () => recoverPendingManualAutomationHandoffs(journal, coordinator)
      );

      expect(services.automationRuntime.currentRevision).toBe(1);
      expect(terminalHandoff).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
      expect(journal.markAutomationHandoffComplete).toHaveBeenCalledWith(command.idempotencyKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("feeds fixture observations to automation independently of telemetry intake", async () => {
    let listener: ((status: { fixtureId: string; brightness: number; powerOn: boolean; observedAt: string }) => void) | undefined;
    const adapter = {
      onLightingObservation: vi.fn((next) => { listener = next; return vi.fn(); })
    };
    const runtime = { recordFixtureState: vi.fn().mockResolvedValue(undefined) };
    const onObserved = vi.fn();

    observeAutomationFixtureStatuses(adapter as never, runtime, vi.fn(), onObserved);
    listener?.({
      fixtureId: scopedFixtureId,
      brightness: 40,
      powerOn: false,
      observedAt: "2026-08-30T01:00:00.000Z"
    });
    await vi.waitFor(() => expect(runtime.recordFixtureState).toHaveBeenCalledWith(
      scopedFixtureId,
      0,
      "2026-08-30T01:00:00.000Z"
    ));
    expect(onObserved).toHaveBeenCalledWith(scopedFixtureId);
  });

  it("keeps targeted observation retry armed when fixture state persistence fails", async () => {
    let listener: ((status: { fixtureId: string; brightness: number; powerOn: boolean; observedAt: string }) => void) | undefined;
    const adapter = {
      onLightingObservation: vi.fn((next) => { listener = next; return vi.fn(); })
    };
    const runtime = { recordFixtureState: vi.fn().mockRejectedValue(new Error("state write failed")) };
    const onError = vi.fn();
    const onObserved = vi.fn();

    observeAutomationFixtureStatuses(adapter as never, runtime, onError, onObserved);
    listener?.({
      fixtureId: scopedFixtureId,
      brightness: 40,
      powerOn: true,
      observedAt: "2026-08-30T01:00:00.000Z"
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onObserved).not.toHaveBeenCalled();
  });

  it("seeds durable restart observation fences into the targeted background queue", () => {
    const runtime = {
      pendingObservationFixtureIds: vi.fn(() => ["fixture-recovered-1", "fixture-recovered-2"])
    };
    const targeted = { requeuePendingFixtures: vi.fn(() => true) };

    expect(requeuePendingFixtureObservations(runtime, targeted)).toBe(true);
    expect(targeted.requeuePendingFixtures).toHaveBeenCalledWith([
      "fixture-recovered-1",
      "fixture-recovered-2"
    ]);
  });

  it("keeps local automation RF successful when terminal telemetry capacity is exhausted", async () => {
    const actions = [{
      fixtureId: scopedFixtureId,
      brightnessPercent: 70,
      sourceType: "schedule" as const,
      sourceId: "00000000-0000-4000-8000-000000000103",
      occurrenceKey: "occurrence-1"
    }];
    const terminal = [{
      fixtureId: scopedFixtureId,
      status: "succeeded" as const,
      brightnessPercent: 70,
      faultCode: null,
      errorCode: null,
      occurredAt: "2026-08-30T01:00:00.000Z"
    }];
    const order: string[] = [];
    const recordGap = vi.fn(async () => { order.push("gap"); });

    await expect(executeAutomationWithBestEffortTelemetry({
      actions,
      execute: async () => { order.push("rf"); return terminal; },
      enqueueTelemetry: async () => {
        order.push("telemetry");
        throw new StateEventOutboxError("STATE_OUTBOX_CAPACITY", "full");
      },
      recordGap,
      onError: vi.fn()
    })).resolves.toEqual(terminal);

    expect(order).toEqual(["rf", "telemetry", "gap"]);
    expect(recordGap).toHaveBeenCalledWith(
      "2026-08-30T01:00:00.000Z",
      1,
      "2026-08-30T01:00:00.000Z"
    );
  });

  it("records a durable gap when the Task 13 terminal handoff seam cannot enqueue", async () => {
    const recordGap = vi.fn().mockResolvedValue(undefined);
    const handoff = createDurableAutomationTerminalHandoff({
      enqueue: vi.fn().mockRejectedValue(new Error("telemetry outbox full")),
      recordGap,
      onError: vi.fn()
    });

    await expect(handoff({
      revision: 3,
      actions: [{
        fixtureId: scopedFixtureId,
        brightnessPercent: 70,
        sourceType: "schedule",
        sourceId: "00000000-0000-4000-8000-000000000103",
        occurrenceKey: "occurrence-1"
      }],
      results: [{
        fixtureId: scopedFixtureId,
        status: "failed",
        brightnessPercent: null,
        faultCode: null,
        errorCode: "status_timeout",
        occurredAt: "2026-08-30T01:00:02.000Z"
      }]
    })).resolves.toBeUndefined();

    expect(recordGap).toHaveBeenCalledWith(
      "2026-08-30T01:00:02.000Z",
      1,
      "2026-08-30T01:00:02.000Z"
    );
  });

  it("counts one dropped action_result payload rather than its two fixture results", async () => {
    const secondFixtureId = "00000000-0000-4000-8000-000000000006";
    const recordGap = vi.fn().mockResolvedValue(undefined);
    const handoff = createDurableAutomationTerminalHandoff({
      enqueue: vi.fn().mockRejectedValue(new Error("telemetry outbox unavailable")),
      recordGap
    });

    await handoff({
      revision: 3,
      actions: [scopedFixtureId, secondFixtureId].map((fixtureId) => ({
        fixtureId,
        brightnessPercent: 70,
        sourceType: "schedule" as const,
        sourceId: "00000000-0000-4000-8000-000000000103",
        occurrenceKey: "occurrence-1"
      })),
      results: [scopedFixtureId, secondFixtureId].map((fixtureId, index) => ({
        fixtureId,
        status: "succeeded" as const,
        brightnessPercent: 70,
        faultCode: null,
        errorCode: null,
        occurredAt: `2026-08-30T01:00:0${index + 1}.000Z`
      }))
    });

    expect(recordGap).toHaveBeenCalledWith(
      "2026-08-30T01:00:02.000Z",
      1,
      "2026-08-30T01:00:02.000Z"
    );
  });

  it("records a durable gap when lifecycle telemetry persistence fails after local RF", async () => {
    const recordGap = vi.fn().mockResolvedValue(undefined);
    const handoff = createDurableAutomationLifecycleHandoff({
      enqueue: vi.fn().mockRejectedValue(new Error("telemetry commit uncertain")),
      recordGap,
      onError: vi.fn()
    });

    await handoff({
      revision: 3,
      events: [{
        kind: "event_started",
        ruleId: "00000000-0000-4000-8000-000000000103",
        occurrenceKey: "event-1",
        occurredAt: "2026-08-30T01:00:00.000Z",
        payload: {}
      }, {
        kind: "event_extended",
        ruleId: "00000000-0000-4000-8000-000000000103",
        occurrenceKey: "event-1",
        occurredAt: "2026-08-30T01:00:03.000Z",
        payload: { holdUntil: "2026-08-30T01:01:03.000Z" }
      }]
    });

    expect(recordGap).toHaveBeenCalledWith(
      "2026-08-30T01:00:00.000Z",
      2,
      "2026-08-30T01:00:03.000Z"
    );
  });

  it("hands Task 12 persisted gaps to the new outbox before exact state clear", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-gap-handoff-"));
    try {
      const stateStore = new FileAutomationStateStore(join(directory, "state.json"));
      const outbox = new AutomationTelemetryOutbox(join(directory, "telemetry.json"), automationScope);
      await stateStore.initialize();
      await outbox.initialize();
      await stateStore.recordTelemetryGap("2026-08-30T01:00:00.000Z", 4, "2026-08-30T01:00:05.000Z");

      await expect(handoffPersistedAutomationTelemetryGap(stateStore, outbox, 9)).resolves.toBe(true);
      expect(stateStore.read().telemetryGap).toBeNull();
      expect((await outbox.inspect()).gap).toMatchObject({ revision: 9, droppedCount: 4 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("immediately hands a runtime telemetry drop to the outbox when a revision is active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-live-gap-handoff-"));
    try {
      const stateStore = new FileAutomationStateStore(join(directory, "state.json"));
      const outbox = new AutomationTelemetryOutbox(join(directory, "telemetry.json"), automationScope);
      await stateStore.initialize();
      await outbox.initialize();

      await recordAndHandoffAutomationTelemetryGap(
        stateStore,
        outbox,
        11,
        "2026-08-30T01:00:00.000Z",
        3,
        "2026-08-30T01:00:02.000Z"
      );

      expect(stateStore.read().telemetryGap).toBeNull();
      expect((await outbox.inspect()).gap).toMatchObject({ revision: 11, droppedCount: 3 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("counts only terminal fixture telemetry that actually failed after a partial enqueue", async () => {
    const secondFixtureId = "00000000-0000-4000-8000-000000000006";
    const actions = [scopedFixtureId, secondFixtureId].map((fixtureId) => ({
      fixtureId,
      brightnessPercent: 70,
      sourceType: "schedule" as const,
      sourceId: "00000000-0000-4000-8000-000000000103",
      occurrenceKey: "occurrence-1"
    }));
    const results = actions.map((action, index) => ({
      fixtureId: action.fixtureId,
      status: "succeeded" as const,
      brightnessPercent: 70,
      faultCode: null,
      errorCode: null,
      occurredAt: `2026-08-30T01:00:0${index + 1}.000Z`
    }));
    let sequence = 0;
    const enqueue = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new StateEventOutboxError("STATE_OUTBOX_CAPACITY", "full"));
    const recordGap = vi.fn().mockResolvedValue(undefined);

    await executeAutomationWithBestEffortTelemetry({
      actions,
      execute: async () => results,
      enqueueTelemetry: (terminal) => enqueueAutomationFixtureStates({
        siteId: scopedSiteId,
        gatewayId: scopedGatewayId,
        eventSequence: { next: async () => ++sequence },
        results: terminal,
        enqueue
      }),
      recordGap
    });

    expect(recordGap).toHaveBeenCalledWith(
      "2026-08-30T01:00:02.000Z",
      1,
      "2026-08-30T01:00:02.000Z"
    );
  });

  it("starts automation ACK recovery even when unrelated connect work fails", async () => {
    const connectAutomationAcks = vi.fn().mockResolvedValue(undefined);
    const connectOperationalServices = vi.fn().mockRejectedValue(new Error("health failed"));

    await expect(connectGatewayServices({
      connectAutomationAcks,
      connectOperationalServices,
      onAutomationAckError: vi.fn()
    })).rejects.toThrow("health failed");

    expect(connectAutomationAcks).toHaveBeenCalledTimes(1);
  });

  it("reports automation ACK connect failure without blocking operational connect work", async () => {
    const onAutomationAckError = vi.fn();
    const connectOperationalServices = vi.fn().mockResolvedValue(undefined);

    await connectGatewayServices({
      connectAutomationAcks: vi.fn().mockRejectedValue(new Error("ACK broker failure")),
      connectOperationalServices,
      onAutomationAckError
    });
    await vi.waitFor(() => expect(onAutomationAckError).toHaveBeenCalledWith(new Error("ACK broker failure")));

    expect(connectOperationalServices).toHaveBeenCalledTimes(1);
  });

  it("builds strict v2 scan found, completed, and sanitized failed payloads", () => {
    const command = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      scanCorrelationId: "22222222-2222-4222-8222-222222222222",
      scanAttempt: 1,
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      floorId: "33333333-3333-4333-8333-333333333333",
      requestedAt: "2026-08-26T00:00:00.000Z"
    };
    const envelope = { eventId: "44444444-4444-4444-8444-444444444444", sequence: 3, occurredAt: "2026-08-26T00:00:01.000Z" };
    expect(provisioningScanFoundSchema.parse(createProvisioningScanFoundPayload(command, {
      deviceUuid: "device-1", serialNumber: "serial-1", rssi: -50, oobCapability: "none", firmwareVersion: "1.0.0"
    }, envelope))).not.toHaveProperty("floorId");
    expect(provisioningScanCompletedSchema.parse(createProvisioningScanCompletedPayload(command, 1, envelope)).acceptedNodeCount).toBe(1);
    const failed = provisioningScanFailedSchema.parse(createProvisioningScanFailedPayload(command, new Error("BlueZ private path /secret failed"), envelope));
    expect(failed).toMatchObject({ code: "scan_runtime_failed", message: "조명 검색 중 문제가 발생했습니다." });
    expect(failed.message).not.toContain("/secret");
  });
  it("creates a strict startup mesh-group resync request", () => {
    expect(createMeshGroupResyncRequest(
      { siteId: scopedSiteId, gatewayId: scopedGatewayId },
      "state_missing",
      () => "2026-08-23T00:00:00.000Z",
      () => "11111111-1111-4111-8111-111111111111"
    )).toEqual({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-08-23T00:00:00.000Z",
      reason: "state_missing"
    });
  });

  it("returns only applied and state-mismatch fixtures with actual observed brightness", () => {
    expect(observedFixtureResults({
      fixtureStateObserved: true,
      observedFixtureIds: [scopedFixtureId, "00000000-0000-4000-8000-000000000006"],
      deviceStatus: {
        results: [
          { fixtureId: scopedFixtureId, status: "failed", brightness: 31, faultCode: "state_mismatch" },
          { fixtureId: "00000000-0000-4000-8000-000000000006", status: "timed_out", faultCode: "status_timeout" }
        ]
      }
    } as never)).toEqual([
      { fixtureId: scopedFixtureId, status: "failed", brightness: 31, faultCode: "state_mismatch" }
    ]);
  });

  it("publishes fixture state only for the observed member of a partial command", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(21);
    await publishObservedDeviceStates({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next },
      publish,
      fallbackBrightness: 70,
      result: {
        fixtureStateObserved: true,
        observedFixtureIds: [scopedFixtureId],
        deviceStatus: {
          occurredAt: "2026-08-23T00:00:00.000Z",
          results: [
            { fixtureId: scopedFixtureId, status: "failed", brightness: 31, faultCode: "state_mismatch" },
            { fixtureId: "00000000-0000-4000-8000-000000000006", status: "timed_out", faultCode: "status_timeout" }
          ]
        }
      } as never
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      `sites/${scopedSiteId}/gateways/${scopedGatewayId}/state/fixtures`,
      expect.objectContaining({ fixtureId: scopedFixtureId, brightness: 31, powerOn: true, status: "fault" })
    );
  });
  it("publishes mapped Mesh status only on the assigned gateway v2 topic with a persisted sequence", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(41);
    const publishFixtureStatus = createFixtureStatusPublisher({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next },
      publish,
      now: () => "2026-08-11T00:00:00.000Z"
    });

    await publishFixtureStatus({
      fixtureId: scopedFixtureId,
      brightness: 75,
      powerOn: true,
      status: "fault",
      faultCode: "health:02e5:01",
      health: { faultCodes: [1], observedAt: "2026-08-10T23:59:59.000Z" },
      rssi: null,
      hopCount: null
    });

    expect(publish).toHaveBeenCalledWith(
      `sites/${scopedSiteId}/gateways/${scopedGatewayId}/state/fixtures`,
      expect.objectContaining({
        siteId: scopedSiteId,
        gatewayId: scopedGatewayId,
        fixtureId: scopedFixtureId,
        sequence: 41,
        occurredAt: "2026-08-11T00:00:00.000Z",
        health: { faultCodes: [1], observedAt: "2026-08-10T23:59:59.000Z" },
        statusReason: "mesh_publication"
      })
    );
  });

  it("stops the MQTT runtime before exiting for SIGTERM", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const stopRotation = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const unregister = registerGatewayShutdownHandlers({ stop } as never, { stop: stopRotation } as never, exit);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopRotation).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("rejects an invalid heartbeat interval before gateway startup", () => {
    expect(() => parseGatewayHeartbeatInterval("NaN")).toThrow("positive finite integer");
    expect(() => parseGatewayHeartbeatInterval("Infinity")).toThrow("positive finite integer");
    expect(() => parseGatewayHeartbeatInterval("0")).toThrow("positive finite integer");
  });

  it("subscribes command topics only when MQTT reports a new session", () => {
    const subscribe = vi.fn((_topics, _options, callback?: (error?: Error) => void) => callback?.());
    const client = { subscribe };

    subscribeGatewayCommands(client as never, assignment, false);
    subscribeGatewayCommands(client as never, assignment, true);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(
      [
        "sites/site-27/gateways/gateway-27/commands/dimming",
        "sites/site-27/gateways/gateway-27/commands/provisioning/scan-start",
        "sites/site-27/gateways/gateway-27/commands/provisioning/identify-device",
        "sites/site-27/gateways/gateway-27/commands/provisioning/provision-device",
        "sites/site-27/gateways/gateway-27/commands/automation/config-sync",
        "sites/site-27/gateways/gateway-27/commands/mesh-group/subscription-sync",
        "sites/site-27/gateways/gateway-27/commands/mesh-group/resync-ack",
        "sites/site-27/gateways/gateway-27/acks/provisioning/scan-terminal-ingested",
        "sites/site-27/gateways/gateway-27/acks/provisioning/device-terminal-ingested",
        "sites/site-27/gateways/gateway-27/acks/state-ingested",
        "sites/site-27/gateways/gateway-27/acks/automation/config-applied-ingested",
        "sites/site-27/gateways/gateway-27/acks/automation/execution-ingested",
        "sites/site-27/gateways/gateway-27/acks/automation/vehicle-sensor-capability-ingested"
      ],
      { qos: 1 },
      expect.any(Function)
    );
  });

  it("subscribes only acknowledgement topics while command intake is quiesced", async () => {
    const subscribe = vi.fn((_topics, _options, callback?: (error?: Error) => void) => callback?.());
    const client = { subscribe };

    await subscribeGatewayAcknowledgements(client as never, assignment, false);

    expect(subscribe).toHaveBeenCalledWith(
      [
        "sites/site-27/gateways/gateway-27/commands/mesh-group/resync-ack",
        "sites/site-27/gateways/gateway-27/acks/provisioning/scan-terminal-ingested",
        "sites/site-27/gateways/gateway-27/acks/provisioning/device-terminal-ingested",
        "sites/site-27/gateways/gateway-27/acks/state-ingested",
        "sites/site-27/gateways/gateway-27/acks/automation/config-applied-ingested",
        "sites/site-27/gateways/gateway-27/acks/automation/execution-ingested",
        "sites/site-27/gateways/gateway-27/acks/automation/vehicle-sensor-capability-ingested"
      ],
      { qos: 1 },
      expect.any(Function)
    );
  });

  it("does not publish fixture-state for a command result without fixture observation", () => {
    expect(shouldPublishFixtureStates({ fixtureStateObserved: false })).toBe(false);
    expect(shouldPublishFixtureStates({ fixtureStateObserved: true })).toBe(true);
  });

  it.each([
    ["STATE_OUTBOX_MISSING", "state_outbox_missing"],
    ["STATE_OUTBOX_CORRUPT", "state_outbox_corrupt"],
    ["STATE_OUTBOX_MANIFEST_CORRUPT", "state_outbox_corrupt"],
    ["STATE_OUTBOX_PERMISSIONS", "state_outbox_permissions"],
    ["STATE_OUTBOX_CAPACITY", "state_outbox_capacity"]
  ] as const)("maps %s startup failure to an explicit health blocker", (code, expected) => {
    expect(stateEventOutboxHealthReason(new StateEventOutboxError(code, "failed"))).toBe(expected);
  });

  it("records and logs a mixed startup resync outcome", async () => {
    const health = { recordMeshResync: vi.fn().mockResolvedValue(undefined) };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const report = { total: 4, configured: 4, observed: 2, healthPending: 1, timedOut: 1, failed: 1 };

    await recordMeshResyncOutcome(health, report, logger);

    expect(health.recordMeshResync).toHaveBeenCalledWith(report);
    expect(JSON.parse(logger.info.mock.calls[0][0])).toEqual({ event: "mesh_resync", ...report });
    expect(JSON.parse(logger.warn.mock.calls[0][0])).toEqual({ event: "mesh_resync_incomplete", ...report });
  });

  it("publishes a terminal rejection after an earlier acceptance was published", () => {
    expect(shouldPublishFinalAcceptance(true, "accepted")).toBe(false);
    expect(shouldPublishFinalAcceptance(true, "rejected")).toBe(true);
    expect(shouldPublishFinalAcceptance(false, "accepted")).toBe(true);
  });

  it("fails closed before BlueZ and MQTT startup when the current MQTT identity has unsafe permissions", async () => {
    const createAdapters = vi.fn();
    const createMqtt = vi.fn();

    await expect(startGatewayRuntime({
      env: {},
      resolveAssignment: async () => assignment,
      ensureMqttIdentity: async () => { throw new Error("MQTT identity permissions are invalid"); },
      createAdapters,
      createMqtt
    })).rejects.toThrow("MQTT identity permissions are invalid");

    expect(createAdapters).not.toHaveBeenCalled();
    expect(createMqtt).not.toHaveBeenCalled();
  });

  it("starts BlueZ and MQTT only after the assigned MQTT identity is ready", async () => {
    const calls: string[] = [];
    const adapters = { dimming: {}, scanner: {}, provisioning: {} };
    const mqtt = {};

    await expect(startGatewayRuntime({
      env: { MQTT_URL: "mqtts://ignored.example:8883" },
      resolveAssignment: async () => { calls.push("assignment"); return assignment; },
      ensureMqttIdentity: async (received) => { calls.push("identity"); expect(received).toEqual(assignment); },
      createAdapters: (async () => { calls.push("bluez"); return adapters; }) as never,
      createMqtt: ((env: NodeJS.ProcessEnv, identity: { gatewayId: string }) => {
        calls.push("mqtt");
        expect(env.MQTT_URL).toBe(assignment.mqttUrl);
        expect(identity).toEqual({ gatewayId: assignment.gatewayId });
        return mqtt;
      }) as never
    })).resolves.toEqual({ assignment, adapters, client: mqtt });

    expect(calls).toEqual(["assignment", "identity", "bluez", "mqtt"]);
  });

  it("creates a rotated MQTT client from the probed candidate paths before activating the runtime", async () => {
    const candidate = {
      generationPath: "/identity/mqtt/pending-generations/candidate",
      certificatePath: "/identity/mqtt/pending-generations/candidate/gateway.crt",
      keyPath: "/identity/mqtt/pending-generations/candidate/gateway.key",
      caPath: "/identity/mqtt/pending-generations/candidate/mqtt-ca.crt"
    };
    const client = {};
    const createMqtt = vi.fn(() => client);
    const runtime = { activate: vi.fn().mockResolvedValue(undefined) };

    const prepared = {
      candidate,
      commit: vi.fn(),
      rollback: vi.fn(),
      finalize: vi.fn(),
      isCommitted: vi.fn(() => false),
      isCurrentCandidate: vi.fn(async () => false)
    };
    await createMqttIdentityActivation(assignment, { MQTT_URL: "mqtts://ignored.example:8883" }, runtime as never, createMqtt as never)(prepared);

    expect(createMqtt).toHaveBeenCalledWith({
      MQTT_URL: assignment.mqttUrl,
      MQTT_CA_PATH: candidate.caPath,
      MQTT_CLIENT_CERT_PATH: candidate.certificatePath,
      MQTT_CLIENT_KEY_PATH: candidate.keyPath
    }, { gatewayId: assignment.gatewayId }, { manualConnect: true });
    expect(runtime.activate).toHaveBeenCalledWith(client, prepared);
  });
});

function timedGatewayCommand() {
  return {
    commandId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    sequence: 1,
    siteId: scopedSiteId,
    gatewayId: scopedGatewayId,
    targetType: "fixture" as const,
    targetId: scopedFixtureId,
    targetFixtureIds: [scopedFixtureId],
    deliveryMode: "unicast" as const,
    brightness: 60,
    requestedBy: "77777777-7777-4777-8777-777777777777",
    requestedAt: "2026-08-30T01:00:00.000Z",
    expiresAt: "2026-08-30T01:01:00.000Z",
    overrideUntil: "2026-08-30T02:00:00.000Z"
  };
}

function successfulGatewayCommandResult(command: ReturnType<typeof timedGatewayCommand>) {
  return {
    acceptance: {
      commandId: command.commandId,
      dispatchId: command.dispatchId,
      idempotencyKey: command.idempotencyKey,
      sequence: command.sequence,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      eventId: "88888888-8888-4888-8888-888888888888",
      status: "accepted",
      acceptedAt: "2026-08-30T01:00:00.000Z"
    },
    deviceStatus: {
      commandId: command.commandId,
      dispatchId: command.dispatchId,
      idempotencyKey: command.idempotencyKey,
      sequence: command.sequence,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      eventId: "99999999-9999-4999-8999-999999999999",
      status: "succeeded",
      occurredAt: "2026-08-30T01:00:01.000Z",
      results: [{
        fixtureId: scopedFixtureId,
        status: "succeeded",
        brightness: 60,
        rssi: -60,
        hopCount: 1
      }]
    },
    fixtureStateObserved: true,
    observedFixtureIds: [scopedFixtureId]
  };
}

function memoryGatewayJournal() {
  const records = new Map<string, {
    state: "accepted" | "completed";
    command: unknown;
    result?: unknown;
    automationHandoff?: "pending" | "completed";
  }>();
  return {
    get: async (key: string) => records.get(key) ?? null,
    accept: async (key: string, command: unknown) => {
      if (records.has(key)) return false;
      records.set(key, { state: "accepted", command });
      return true;
    },
    complete: async (key: string, result: unknown, options: { automationHandoffPending?: boolean } = {}) => {
      const accepted = records.get(key)!;
      records.set(key, {
        ...accepted,
        state: "completed",
        result,
        ...(options.automationHandoffPending ? { automationHandoff: "pending" as const } : {})
      });
    },
    markAutomationHandoffComplete: async (key: string) => {
      const completed = records.get(key)!;
      records.set(key, { ...completed, automationHandoff: "completed" });
    }
  };
}
