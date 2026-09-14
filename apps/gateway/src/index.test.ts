import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGatewayAutomationServices,
  createGatewayStatusCheckRuntime,
  initializeAutomationBeforeManualRecovery,
  observeAutomationFixtureStatuses,
  requeuePendingFixtureObservations,
  createDurableAutomationLifecycleHandoff,
  createDurableAutomationTerminalHandoff,
  executeAutomationWithBestEffortTelemetry,
  gatewayDeferredPubackTopics,
  enqueueAutomationFixtureStates,
  createManualOverrideCoordinator,
  enqueueFixturePresence,
  createFixturePresencePublisher,
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
  recoverStateEventCapacityAfterAcknowledgement,
  registerGatewayShutdownHandlers,
  shouldPublishFinalAcceptance,
  shouldPublishFixtureStates,
  stateEventOutboxHealthReason,
  handoffPersistedAutomationTelemetryGap,
  handleProvisionDeviceCommand,
  hydrateAdapterGroupState,
  recordAndHandoffAutomationTelemetryGap,
  recoverProvisioningDevicesOnStartup,
  refreshVehicleSensorCapabilitiesIfSupported,
  runGatewayStartupStageWithAdapterCleanup,
  startGatewayRuntime,
  subscribeGatewayAcknowledgements,
  subscribeGatewayCommands,
  observeFixturePresenceIntake
} from "./index";
import { StateEventOutboxError } from "./state/state-event-outbox";
import { CommandJournal } from "./commands/command-journal";
import type { BleMeshFixturePresence, BleMeshLightingObservation } from "./gateway";
import { mqttTopicsV2, provisioningScanCompletedSchema, provisioningScanFailedSchema, provisioningScanFoundSchema, type FixturePresenceV2 } from "@led-control/shared";
import { FileAutomationStateStore } from "./automation/automation-state-store";
import { AutomationTelemetryOutbox } from "./automation/automation-telemetry-outbox";
import { automationScope, automationSnapshot } from "./automation/automation-test-fixtures";
import {
  handleGatewayDimmingCommand,
  recoverPendingManualAutomationHandoffs
} from "./commands/gateway-command-handler";
import { ProvisioningDeviceJournal } from "./state/provisioning-device-journal";
import { GroupStateStore } from "./mesh/group-state-store";
import { BioUsbDongleAdapter } from "./adapters/bio-usb-dongle-adapter";

const scopedSiteId = "00000000-0000-4000-8000-000000000003";
const scopedGatewayId = "00000000-0000-4000-8000-000000000004";
const scopedFixtureId = "00000000-0000-4000-8000-000000000005";

it("defers QoS1 PUBACK for commands whose durable journal must commit first", () => {
  expect(gatewayDeferredPubackTopics(scopedSiteId, scopedGatewayId)).toEqual([
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/dimming`,
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/status-check`,
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/provisioning/identify-device`,
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/provisioning/provision-device`,
    `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/automation/config-sync`
  ]);
});

describe("status check MQTT runtime", () => {
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), "status-runtime-"));
    const journal = new CommandJournal(join(directory, "journal.json"));
    const now = Date.now();
    const command = {
      commandId: "11111111-1111-4111-8111-111111111111", originalCommandId: "11111111-1111-4111-8111-111111111111",
      dispatchId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "33333333-3333-4333-8333-333333333333",
      sequence: 1, siteId: scopedSiteId, gatewayId: scopedGatewayId, targetFixtureIds: [scopedFixtureId],
      expectedBrightness: 65, verificationAttempt: 1, requestedAt: new Date(now).toISOString(),
      deliveryGeneratedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10000).toISOString(),
      deliveryGeneration: "88888888-8888-4888-8888-888888888888", deliveryWindowMs: 10000
    };
    const listeners = new Set<(observation: BleMeshLightingObservation) => void>();
    const events: string[] = [];
    const adapter = {
      onLightingObservation: (listener: (observation: BleMeshLightingObservation) => void) => {
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
      resyncLightingFixtures: vi.fn(async (_ids: string[], _signal?: AbortSignal) => {
        events.push("get");
        for (const listener of listeners) listener({ fixtureId: scopedFixtureId, brightness: 65, powerOn: true, observedAt: new Date().toISOString() });
        return { total: 1, configured: 1, observed: 1, timedOut: 0, failed: 0, healthPending: 0 };
      })
    };
    const published: Array<{ topic: string; payload: any }> = [];
    const publish = vi.fn(async (_source: unknown, topic: string, payload: unknown) => {
      events.push(topic.endsWith("acceptance") ? "acceptance" : "status"); published.push({ topic, payload });
    });
    const runtime = createGatewayStatusCheckRuntime({ adapter, journal, scope: { siteId: scopedSiteId, gatewayId: scopedGatewayId }, publish });
    const receipt = { properties: { messageExpiryInterval: 10 } } as any;
    const control = { acknowledgeDurable: () => { events.push("durable"); } };
    const handle = () => runtime.handle(Buffer.from(JSON.stringify(command)), {} as any, receipt, control);
    return { directory, journal, command, adapter, listeners, events, published, publish, runtime, handle, control, receipt };
  }

  it("subscribes to status-check with QoS1 alongside the existing command topics", async () => {
    const subscribe = vi.fn((_topics, _options, callback) => callback());
    await subscribeGatewayCommands({ subscribe } as any, { siteId: scopedSiteId, gatewayId: scopedGatewayId }, false);
    expect(subscribe).toHaveBeenCalledWith(expect.arrayContaining([
      `sites/${scopedSiteId}/gateways/${scopedGatewayId}/commands/status-check`
    ]), { qos: 1 }, expect.any(Function));
  });

  it("publishes durable receipt, acceptance, Get, then device status and replays a failed terminal publish", async () => {
    const ctx = await setup();
    try {
      ctx.publish.mockImplementationOnce(async (_source, topic, payload) => {
        expect(await ctx.journal.get(ctx.command.idempotencyKey)).toMatchObject({ state: "accepted" });
        ctx.events.push("acceptance"); ctx.published.push({ topic, payload });
      }).mockImplementationOnce(async () => { ctx.events.push("status-failed"); throw new Error("broker disconnected"); });
      await expect(ctx.handle()).rejects.toThrow("broker disconnected");
      expect(ctx.events).toEqual(["durable", "acceptance", "get", "status-failed"]);
      const stored = await ctx.journal.get(ctx.command.idempotencyKey);
      await ctx.handle();
      expect(ctx.adapter.resyncLightingFixtures).toHaveBeenCalledOnce();
      expect(ctx.published.at(-1)?.payload).toEqual((stored?.result as any).deviceStatus);
      expect(ctx.published.at(-1)?.topic).toBe(`sites/${scopedSiteId}/gateways/${scopedGatewayId}/acks/device-status`);
      expect(ctx.published.at(-2)?.topic).toBe(`sites/${scopedSiteId}/gateways/${scopedGatewayId}/acks/acceptance`);
    } finally { await ctx.runtime.stopAndDrain(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  it("fails closed on a mismatched scope and drains an aborted in-flight Get before stop resolves", async () => {
    const ctx = await setup();
    try {
      await expect(ctx.runtime.handle(Buffer.from(JSON.stringify({ ...ctx.command, gatewayId: scopedFixtureId })), {} as any, ctx.receipt, ctx.control)).rejects.toThrow("scope mismatch");
      expect(await ctx.journal.get(ctx.command.idempotencyKey)).toBeNull();
      let signal: AbortSignal | undefined;
      ctx.adapter.resyncLightingFixtures.mockImplementation(async (_ids, received) => {
        signal = received;
        await new Promise<void>(() => undefined);
        throw new Error("unreachable");
      });
      const handling = ctx.handle();
      await vi.waitFor(() => expect(ctx.adapter.resyncLightingFixtures).toHaveBeenCalledOnce());
      await ctx.runtime.stopAndDrain();
      await handling;
      expect(signal?.aborted).toBe(true);
      expect(ctx.listeners.size).toBe(0);
      expect(ctx.published.at(-1)?.payload.status).toBe("timed_out");
      await expect(ctx.handle()).rejects.toThrow("stopped");
      expect(ctx.adapter.resyncLightingFixtures).toHaveBeenCalledOnce();
    } finally { await ctx.runtime.stopAndDrain(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  it("replays an acceptance publish failure as indeterminate and rejects a missing broker TTL without Get", async () => {
    const ctx = await setup();
    try {
      ctx.publish.mockRejectedValueOnce(new Error("acceptance publish lost"));
      await expect(ctx.handle()).rejects.toThrow("acceptance publish lost");
      await ctx.handle();
      expect(ctx.published.at(-1)?.payload).toMatchObject({ status: "timed_out", results: [
        { fixtureId: scopedFixtureId, faultCode: "GATEWAY_RESTART_INDETERMINATE" }
      ] });
      expect(ctx.adapter.resyncLightingFixtures).not.toHaveBeenCalled();
      const expired = { ...ctx.command, idempotencyKey: "99999999-9999-4999-8999-999999999999" };
      await ctx.runtime.handle(Buffer.from(JSON.stringify(expired)), {} as any, undefined, ctx.control);
      expect(ctx.published.at(-2)?.payload).toMatchObject({ status: "rejected", errorCode: "COMMAND_EXPIRED" });
      expect(ctx.adapter.resyncLightingFixtures).not.toHaveBeenCalled();
    } finally { await ctx.runtime.stopAndDrain(); await rm(ctx.directory, { recursive: true, force: true }); }
  });

  it("releases a duplicate PUBLISH before the first acceptance PUBACK so MQTT intake cannot deadlock", async () => {
    const ctx = await setup();
    let releaseAcceptance!: () => void;
    const acceptancePuback = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    const firstReceipt = vi.fn();
    const duplicateReceipt = vi.fn(() => releaseAcceptance());
    const deliveries: Promise<void>[] = [];
    try {
      ctx.publish.mockImplementationOnce(async () => { await acceptancePuback; });
      const payload = Buffer.from(JSON.stringify(ctx.command));
      deliveries.push(ctx.runtime.handle(payload, {} as any, ctx.receipt, { acknowledgeDurable: firstReceipt }));
      await vi.waitFor(() => expect(ctx.publish).toHaveBeenCalledOnce());
      expect(firstReceipt).toHaveBeenCalledOnce();
      expect(ctx.adapter.resyncLightingFixtures).not.toHaveBeenCalled();
      // Model MQTT.js serial packet intake: the first acceptance PUBACK is
      // behind this duplicate PUBLISH's durable receipt callback.
      deliveries.push(ctx.runtime.handle(payload, {} as any, ctx.receipt, { acknowledgeDurable: duplicateReceipt }));
      await vi.waitFor(() => expect(duplicateReceipt).toHaveBeenCalledOnce());
      await Promise.all(deliveries);
      expect(ctx.adapter.resyncLightingFixtures).toHaveBeenCalledOnce();
      const terminals = ctx.published.filter(({ topic }) => topic.endsWith("device-status"));
      expect(terminals).toHaveLength(2);
      expect(terminals[0].payload).toEqual(terminals[1].payload);
    } finally {
      releaseAcceptance();
      await Promise.allSettled(deliveries);
      await ctx.runtime.stopAndDrain();
      await rm(ctx.directory, { recursive: true, force: true });
    }
  });
});

describe("fixture presence runtime intake", () => {
  const presence: BleMeshFixturePresence = {
    fixtureId: scopedFixtureId,
    controlMode: "sensor",
    rawHighBrightness: 127,
    configuredBrightness: null,
    rssi: -41,
    hopCount: null,
    observedAt: "2026-09-14T00:00:01.000Z"
  };

  it("does not schedule resync after a non-capacity presence write failure and later ACK", async () => {
    let listener: ((value: BleMeshFixturePresence) => Promise<void> | void) | undefined;
    let blocked = false;
    const capacity = {
      run: vi.fn(async (_fixtureIds, operation) => operation({ id: "presence-reservation" })),
      block: vi.fn(async () => { blocked = true; }),
      isBlocked: () => blocked,
      recoverAndReserve: vi.fn()
    };
    const intake = observeFixturePresenceIntake({
      adapter: { onFixturePresence: (next) => { listener = next; return vi.fn(); } },
      stateEventCapacity: capacity as never,
      enqueue: (value, reservation) => enqueueFixturePresence({
        outbox: { enqueue: vi.fn().mockRejectedValue(new Error("disk I/O failed")) },
        stateEventPublisher: { wake: vi.fn() },
        stateEventCapacity: capacity as never
      }, fixturePresenceEvent(value), reservation)
    });

    await expect(listener?.(presence)).rejects.toThrow("disk I/O failed");
    expect(capacity.run).toHaveBeenCalledWith([scopedFixtureId], expect.any(Function));
    expect(capacity.block).not.toHaveBeenCalled();

    const scheduleFullResync = vi.fn();
    await expect(recoverStateEventCapacityAfterAcknowledgement({
      stateEventCapacity: capacity as never,
      armFixtureStatusIntake: vi.fn(),
      scheduleFullResync
    })).resolves.toBe(false);
    expect(capacity.recoverAndReserve).not.toHaveBeenCalled();
    expect(scheduleFullResync).not.toHaveBeenCalled();
    await intake.stopAndDrain();
  });

  it("schedules full resync only after a capacity failure recovers a reservation", async () => {
    let listener: ((value: BleMeshFixturePresence) => Promise<void> | void) | undefined;
    let blocked = false;
    const recoveredReservation = { id: "recovered-reservation" };
    const capacity = {
      run: vi.fn(async (_fixtureIds, operation) => operation({ id: "presence-reservation" })),
      block: vi.fn(async () => { blocked = true; }),
      isBlocked: () => blocked,
      recoverAndReserve: vi.fn(async () => blocked ? recoveredReservation : null)
    };
    const intake = observeFixturePresenceIntake({
      adapter: { onFixturePresence: (next) => { listener = next; return vi.fn(); } },
      stateEventCapacity: capacity as never,
      enqueue: (value, reservation) => enqueueFixturePresence({
        outbox: { enqueue: vi.fn().mockRejectedValue(new StateEventOutboxError("STATE_OUTBOX_CAPACITY", "full")) },
        stateEventPublisher: { wake: vi.fn() },
        stateEventCapacity: capacity as never
      }, fixturePresenceEvent(value), reservation)
    });

    await expect(listener?.(presence)).rejects.toMatchObject({ code: "STATE_OUTBOX_CAPACITY" });
    expect(capacity.block).toHaveBeenCalledOnce();

    const armFixtureStatusIntake = vi.fn().mockResolvedValue(true);
    const scheduleFullResync = vi.fn();
    await expect(recoverStateEventCapacityAfterAcknowledgement({
      stateEventCapacity: capacity as never,
      armFixtureStatusIntake,
      scheduleFullResync
    })).resolves.toBe(true);
    expect(armFixtureStatusIntake).toHaveBeenCalledWith(recoveredReservation);
    expect(scheduleFullResync).toHaveBeenCalledOnce();
    await intake.stopAndDrain();
  });

  it("reserves one fixture slot, awaits durable enqueue, and drains active presence intake after unsubscribe", async () => {
    let listener: ((value: BleMeshFixturePresence) => Promise<void> | void) | undefined;
    const unsubscribe = vi.fn();
    let releaseEnqueue!: () => void;
    const enqueueBarrier = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
    const stateEventCapacity = {
      run: vi.fn(async (_fixtureIds, operation) => operation({ id: "presence-reservation" }))
    };
    const enqueue = vi.fn(async () => { await enqueueBarrier; });
    const intake = observeFixturePresenceIntake({
      adapter: { onFixturePresence: (next) => { listener = next; return unsubscribe; } },
      stateEventCapacity: stateEventCapacity as never,
      enqueue
    });

    const handling = listener?.(presence);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(stateEventCapacity.run).toHaveBeenCalledWith([scopedFixtureId], expect.any(Function));
    const stop = intake.stopAndDrain();
    expect(unsubscribe).toHaveBeenCalledOnce();
    listener?.(presence);
    expect(stateEventCapacity.run).toHaveBeenCalledOnce();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseEnqueue();
    await handling;
    await stop;
    expect(stopped).toBe(true);
  });
});

function fixturePresenceEvent(presence: BleMeshFixturePresence): FixturePresenceV2 {
  return {
    siteId: scopedSiteId,
    gatewayId: scopedGatewayId,
    eventId: "99999999-9999-4999-8999-999999999999",
    sequence: 42,
    occurredAt: presence.observedAt,
    fixtureId: presence.fixtureId,
    controlMode: presence.controlMode,
    rawHighBrightness: presence.rawHighBrightness,
    configuredBrightness: presence.configuredBrightness,
    rssi: presence.rssi,
    hopCount: presence.hopCount
  };
}

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
  const adapter = { stop: vi.fn(async () => { calls.push("adapter-stop"); }) };
  const shutdown = drainGatewayProcessShutdown({
    runtime,
    adapter,
    drainBeforeMqttStop: async () => {
      calls.push("drain");
      await drain;
    }
  });

  await vi.waitFor(() => expect(calls).toEqual(["quiesce", "drain"]));
  expect(runtime.stop).not.toHaveBeenCalled();
  releaseDrain();
  await shutdown;
  expect(calls).toEqual(["quiesce", "drain", "stop", "adapter-stop"]);
});

it("runs every shutdown stage and aggregates failures after command quiesce rejects", async () => {
  const calls: string[] = [];
  const quiesceError = new Error("UNSUBACK failed");
  const drainError = new Error("replay drain failed");
  const stopError = new Error("MQTT stop failed");
  const adapterStopError = new Error("USB release failed");
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
    adapter: {
      stop: vi.fn(async () => {
        calls.push("adapter-stop");
        throw adapterStopError;
      })
    },
    drainBeforeMqttStop: async () => {
      calls.push("drain");
      throw drainError;
    }
  });

  await expect(shutdown).rejects.toMatchObject({
    errors: [quiesceError, drainError, stopError, adapterStopError]
  });
  expect(calls).toEqual(["quiesce", "drain", "stop", "adapter-stop"]);
});

it("does not refresh vehicle sensor cloud capabilities for an unsupported adapter", async () => {
  const refresh = vi.fn(async () => undefined);

  await expect(refreshVehicleSensorCapabilitiesIfSupported(false, refresh)).resolves.toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  await expect(refreshVehicleSensorCapabilitiesIfSupported(true, refresh)).resolves.toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
});

const assignment = {
  siteId: "site-27",
  gatewayId: "gateway-27",
  serialNumber: "GW-27",
  mqttUrl: "mqtts://broker.example:8883",
  configVersion: 1
};

function provisioningCommand(overrides: Record<string, unknown> = {}) {
  return {
    commandId: "10000000-0000-4000-8000-000000000000",
    sessionId: "11000000-0000-4000-8000-000000000000",
    siteId: scopedSiteId,
    gatewayId: scopedGatewayId,
    nodeId: "20000000-0000-4000-8000-000000000000",
    deviceUuid: "00112233445566778899aabbccddeeff",
    meshAddress: "0x0101",
    requestedAt: "2026-09-13T00:00:00.000Z",
    ...overrides
  } as any;
}

describe("startGatewayRuntime", () => {
  it("recovers confirmed and reserved BIO accepted commands through the production startup journal path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-bio-provisioning-recovery-"));
    try {
      const path = join(directory, "provisioning.json");
      const confirmedCommand = provisioningCommand({
        commandId: "10000000-0000-4000-8000-000000000001",
        nodeId: "20000000-0000-4000-8000-000000000001",
        deviceUuid: "bio:001122334455",
        meshAddress: "0x0101"
      });
      const reservedCommand = provisioningCommand({
        commandId: "10000000-0000-4000-8000-000000000002",
        nodeId: "20000000-0000-4000-8000-000000000002",
        deviceUuid: "bio:001122334466",
        meshAddress: "0x0102"
      });
      const seed = new ProvisioningDeviceJournal(path);
      await seed.initialize();
      await seed.accept(confirmedCommand);
      await seed.accept(reservedCommand);
      const client = {
        scan: vi.fn(),
        startIdentify: vi.fn(),
        stopIdentify: vi.fn(),
        restoreSensorMode: vi.fn(),
        assignAddress: vi.fn(),
        assignAddressOnce: vi.fn(),
        reconcileAddress: vi.fn(async (nativeUuid: string) => ({
          outcome: "confirmed" as const,
          device: {
            nativeUuid,
            deviceUuid: `bio:${nativeUuid}`,
            logicalAddress: 0x0102,
            networkId: 0,
            firmwareVersion: "1.2.3.4",
            rssi: -42
          }
        })),
        setOutput: vi.fn()
      };
      const mappings = {
        findByDeviceUuidIncludingReserved: vi.fn(async (deviceUuid: string) => ({
          fixtureId: deviceUuid.endsWith("55") ? confirmedCommand.nodeId : reservedCommand.nodeId,
          nodeId: deviceUuid.endsWith("55") ? confirmedCommand.nodeId : reservedCommand.nodeId,
          deviceUuid,
          nativeUuid: deviceUuid.slice(4),
          logicalAddress: deviceUuid.endsWith("55") ? 0x0101 : 0x0102,
          observedLogicalAddressBeforeAssignment: deviceUuid.endsWith("55") ? 0x1234 : 0x1235,
          commandId: deviceUuid.endsWith("55") ? confirmedCommand.commandId : reservedCommand.commandId,
          firmware: "1.2.3.4",
          protocol: "crc16" as const,
          status: deviceUuid.endsWith("55") ? "confirmed" as const : "reserved" as const,
          updatedAt: "2026-09-13T00:00:00.000Z"
        })),
        reserve: vi.fn(),
        confirm: vi.fn(),
        findByFixtureId: vi.fn(),
        findByLogicalAddress: vi.fn(),
        listConfirmed: vi.fn(async () => [])
      };
      const adapter = new BioUsbDongleAdapter(client, mappings);
      const restarted = new ProvisioningDeviceJournal(path);
      await restarted.initialize();
      let sequence = 0;

      await recoverProvisioningDevicesOnStartup(restarted, adapter, async () => ({
        eventId: sequence++ === 0
          ? "30000000-0000-4000-8000-000000000001"
          : "30000000-0000-4000-8000-000000000002",
        sequence,
        occurredAt: "2026-09-13T00:00:01.000Z"
      }));

      const terminals = await restarted.pendingTerminals();
      expect(terminals.map(({ payload }) => payload.status)).toEqual(["completed", "completed"]);
      expect(client.reconcileAddress).toHaveBeenCalledOnce();
      expect(client.reconcileAddress).toHaveBeenCalledWith("001122334466", 0x1235, 0x0102);
      expect(client.assignAddress).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the existing BlueZ startup fallback outcome-unknown when the adapter has no recovery contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-bluez-provisioning-recovery-"));
    try {
      const path = join(directory, "provisioning.json");
      const command = provisioningCommand();
      const seed = new ProvisioningDeviceJournal(path);
      await seed.initialize();
      await seed.accept(command);
      const restarted = new ProvisioningDeviceJournal(path);
      await restarted.initialize();

      await recoverProvisioningDevicesOnStartup(restarted, {
        identify: vi.fn(),
        provision: vi.fn()
      }, async () => ({
        eventId: "30000000-0000-4000-8000-000000000003",
        sequence: 1,
        occurredAt: "2026-09-13T00:00:01.000Z"
      }));

      await expect(restarted.pendingTerminals()).resolves.toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ status: "failed", errorCode: "provisioning_outcome_unknown" })
        })
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs only the adapter safety restore after a restarted identify and records outcome-unknown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-bio-identify-recovery-"));
    try {
      const path = join(directory, "provisioning.json");
      const { meshAddress: _unusedMeshAddress, ...command } = provisioningCommand({
        operation: "identify",
        deviceUuid: "bio:001122334455"
      });
      const seed = new ProvisioningDeviceJournal(path);
      await seed.initialize();
      await seed.accept(command);
      const restarted = new ProvisioningDeviceJournal(path);
      await restarted.initialize();
      const recoverProvisioning = vi.fn();
      const recoverIdentifySafety = vi.fn(async () => undefined);

      await recoverProvisioningDevicesOnStartup(restarted, {
        identify: vi.fn(),
        provision: vi.fn(),
        recoverProvisioning,
        recoverIdentifySafety
      }, async () => ({
        eventId: "30000000-0000-4000-8000-000000000004",
        sequence: 1,
        occurredAt: "2026-09-13T00:00:01.000Z"
      }));

      expect(recoverProvisioning).not.toHaveBeenCalled();
      expect(recoverIdentifySafety).toHaveBeenCalledOnce();
      expect(recoverIdentifySafety).toHaveBeenCalledWith(command);
      await expect(restarted.pendingTerminals()).resolves.toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            operation: "identify",
            status: "failed",
            errorCode: "identify_outcome_unknown"
          })
        })
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hydrates BIO virtual membership from ready GroupStateStore snapshots on the production startup path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-bio-group-hydration-"));
    try {
      const path = join(directory, "groups.json");
      const identity = {
        groupId: "40000000-0000-4000-8000-000000000001",
        groupAddress: "0xc000",
        version: 1
      };
      const member = { meshNodeId: "50000000-0000-4000-8000-000000000001", meshAddress: "0x0101" };
      const seed = new GroupStateStore(path);
      await seed.initialize();
      await seed.writeConfiguring(identity);
      await seed.writeReady(identity, [member]);
      const mapping = {
        fixtureId: "60000000-0000-4000-8000-000000000001",
        nodeId: member.meshNodeId,
        deviceUuid: "bio:001122334455",
        nativeUuid: "001122334455",
        logicalAddress: 0x0101,
        observedLogicalAddressBeforeAssignment: 0x1234,
        commandId: "70000000-0000-4000-8000-000000000001",
        firmware: "1.2.3.4",
        protocol: "crc16" as const,
        status: "confirmed" as const,
        updatedAt: "2026-09-13T00:00:00.000Z"
      };
      const client = {
        scan: vi.fn(async () => [{
          nativeUuid: mapping.nativeUuid,
          deviceUuid: mapping.deviceUuid,
          logicalAddress: mapping.logicalAddress,
          networkId: 0,
          firmwareVersion: mapping.firmware,
          rssi: -41
        }]),
        startIdentify: vi.fn(), stopIdentify: vi.fn(), restoreSensorMode: vi.fn(),
        assignAddress: vi.fn(), assignAddressOnce: vi.fn(), reconcileAddress: vi.fn(),
        setOutput: vi.fn(async () => ({ brightnessPercent: 60, powerOn: true, rawHighBrightness: 198, mode: "force-on" as const }))
      };
      const mappings = {
        findByDeviceUuidIncludingReserved: vi.fn(), reserve: vi.fn(), confirm: vi.fn(),
        findByFixtureId: vi.fn(async () => mapping),
        findByLogicalAddress: vi.fn(async (address: number) => address === mapping.logicalAddress ? mapping : null),
        listConfirmed: vi.fn(async () => [mapping])
      };
      const adapter = new BioUsbDongleAdapter(client, mappings);
      await adapter.scan({} as never);

      await hydrateAdapterGroupState(adapter, new GroupStateStore(path));

      await expect(adapter.applyMeshGroup(0xc000, [mapping.fixtureId], 60)).resolves.toEqual([
        expect.objectContaining({ fixtureId: mapping.fixtureId, acknowledged: true, outcome: "applied" })
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("lets the BIO adapter establish the first automation state through verified manual read-back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-bio-first-manual-state-"));
    try {
      const services = createGatewayAutomationServices({
        configStore: {
          load: async () => null,
          apply: async () => undefined,
          restore: async () => undefined
        },
        stateStore: new FileAutomationStateStore(join(directory, "state.json")),
        scope: automationScope,
        adapterKind: "bio-usb",
        wallClock: () => new Date("2026-08-30T01:00:00.000Z"),
        monotonicClock: () => 5_000,
        clockTrust: { isTrusted: async () => true },
        execute: vi.fn()
      });
      await services.scheduleRuntime.initialize();
      const command = timedGatewayCommand();
      const adapter = {
        applyUnicast: async (targetFixtureId: string, brightness: number) => ({
          fixtureId: targetFixtureId,
          acknowledged: true,
          outcome: "applied" as const,
          brightness,
          rawBrightness: 99,
          mode: "force-on" as const,
          rssi: -68,
          hopCount: null
        })
      };

      const result = await handleGatewayDimmingCommand(
        adapter as never,
        memoryGatewayJournal(),
        command,
        undefined,
        {
          automation: createManualOverrideCoordinator(services.scheduleRuntime, () => 5_000),
          receipt: { receivedAtMonotonicMs: 5_000, brokerRemainingTtlMs: 10_000 },
          monotonicClock: () => 5_000,
          isCommandExpired: () => false
        }
      );

      expect(result.deviceStatus.status).toBe("succeeded");
      expect(services.scheduleRuntime.state()).toMatchObject({
        currentByFixture: { [scopedFixtureId]: 60 },
        baseBrightnessByFixture: { [scopedFixtureId]: 60 },
        lastDesiredByFixture: { [scopedFixtureId]: 60 }
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

  it("keeps BIO mismatch metadata but requires an exact force mode before publication", () => {
    const sensor = observedFixtureResults({
      fixtureStateObserved: true,
      observedFixtureIds: [scopedFixtureId],
      fixtureObservations: [{ fixtureId: scopedFixtureId, brightness: 38, mode: "sensor" }],
      deviceStatus: {
        results: [{
          fixtureId: scopedFixtureId,
          status: "failed",
          brightness: 38,
          faultCode: "BIO_CONTROL_MODE_STATE_MISMATCH"
        }]
      }
    } as never);
    const forced = observedFixtureResults({
      fixtureStateObserved: true,
      observedFixtureIds: [scopedFixtureId],
      fixtureObservations: [{ fixtureId: scopedFixtureId, brightness: 38, mode: "force-on" }],
      deviceStatus: {
        results: [{
          fixtureId: scopedFixtureId,
          status: "failed",
          brightness: 38,
          faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH"
        }]
      }
    } as never);
    const unknown = observedFixtureResults({
      fixtureStateObserved: true,
      observedFixtureIds: [scopedFixtureId],
      fixtureObservations: [{ fixtureId: scopedFixtureId, brightness: 38 }],
      deviceStatus: {
        results: [{
          fixtureId: scopedFixtureId,
          status: "failed",
          brightness: 38,
          faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH"
        }]
      }
    } as never);

    expect(sensor).toEqual([]);
    expect(forced).toEqual([{
      fixtureId: scopedFixtureId,
      status: "failed",
      brightness: 38,
      mode: "force-on",
      faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH"
    }]);
    expect(unknown).toEqual([]);
  });

  it("publishes BIO power only from exact force mode and suppresses missing or sensor mode", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValueOnce(31).mockResolvedValueOnce(32);
    await publishObservedDeviceStates({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next },
      publish,
      result: {
        fixtureStateObserved: true,
        observedFixtureIds: [scopedFixtureId],
        fixtureObservations: [{ fixtureId: scopedFixtureId, brightness: 38, mode: "sensor" }],
        deviceStatus: {
          occurredAt: "2026-09-13T00:00:00.000Z",
          results: [{ fixtureId: scopedFixtureId, status: "failed", brightness: 38, faultCode: "BIO_CONTROL_MODE_STATE_MISMATCH" }]
        }
      } as never
    });
    await publishObservedDeviceStates({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next },
      publish,
      result: {
        fixtureStateObserved: true,
        observedFixtureIds: [scopedFixtureId],
        fixtureObservations: [{ fixtureId: scopedFixtureId, brightness: 38 }],
        deviceStatus: {
          occurredAt: "2026-09-13T00:00:01.000Z",
          results: [{ fixtureId: scopedFixtureId, status: "failed", brightness: 38, faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH" }]
        }
      } as never
    });
    for (const [mode, occurredAt] of [["force-on", "2026-09-13T00:00:02.000Z"], ["force-off", "2026-09-13T00:00:03.000Z"]] as const) {
      await publishObservedDeviceStates({
        siteId: scopedSiteId,
        gatewayId: scopedGatewayId,
        eventSequence: { next },
        publish,
        result: {
          fixtureStateObserved: true,
          observedFixtureIds: [scopedFixtureId],
          fixtureObservations: [{ fixtureId: scopedFixtureId, brightness: 38, mode }],
          deviceStatus: {
            occurredAt,
            results: [{ fixtureId: scopedFixtureId, status: "failed", brightness: 38, faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH" }]
          }
        } as never
      });
    }

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(
      1,
      `sites/${scopedSiteId}/gateways/${scopedGatewayId}/state/fixtures`,
      expect.objectContaining({
        fixtureId: scopedFixtureId,
        brightness: 38,
        powerOn: true,
        status: "fault",
        faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH"
      })
    );
    expect(publish).toHaveBeenNthCalledWith(
      2,
      `sites/${scopedSiteId}/gateways/${scopedGatewayId}/state/fixtures`,
      expect.objectContaining({
        fixtureId: scopedFixtureId,
        brightness: 38,
        powerOn: false,
        status: "fault",
        faultCode: "BIO_BRIGHTNESS_STATE_MISMATCH"
      })
    );
  });

  it("publishes fixture state only for the observed member of a partial command", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const next = vi.fn().mockResolvedValue(21);
    await publishObservedDeviceStates({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next },
      publish,
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

  it("publishes a BIO presence observation without inferring output state", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const publishFixturePresence = createFixturePresencePublisher({
      siteId: scopedSiteId,
      gatewayId: scopedGatewayId,
      eventSequence: { next: vi.fn().mockResolvedValue(42) },
      publish
    });
    const presence: BleMeshFixturePresence = {
      fixtureId: scopedFixtureId,
      controlMode: "sensor",
      rawHighBrightness: 127,
      configuredBrightness: null,
      rssi: -41,
      hopCount: null,
      observedAt: "2026-09-14T00:00:01.000Z"
    };

    await publishFixturePresence(presence);

    expect(publish).toHaveBeenCalledWith(
      mqttTopicsV2.fixturePresence(scopedSiteId, scopedGatewayId),
      expect.objectContaining({
        siteId: scopedSiteId,
        gatewayId: scopedGatewayId,
        eventId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
        sequence: 42,
        occurredAt: presence.observedAt,
        fixtureId: scopedFixtureId,
        controlMode: "sensor",
        rawHighBrightness: 127,
        configuredBrightness: null,
        rssi: -41,
        hopCount: null
      })
    );
    const payload = publish.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("brightness");
    expect(payload).not.toHaveProperty("powerOn");
  });

  it("stops the MQTT runtime before exiting for SIGTERM", async () => {
    const calls: string[] = [];
    let releaseAdapter!: () => void;
    const adapterBarrier = new Promise<void>((resolve) => { releaseAdapter = resolve; });
    const stop = vi.fn(() => drainGatewayProcessShutdown({
      runtime: {
        quiesceCommandIntake: vi.fn(async () => { calls.push("mqtt-intake-stop"); }),
        stop: vi.fn(async () => { calls.push("mqtt-stop"); })
      },
      drainBeforeMqttStop: async () => undefined,
      adapter: { stop: vi.fn(async () => { calls.push("adapter-stop"); await adapterBarrier; }) }
    }));
    const stopRotation = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const unregister = registerGatewayShutdownHandlers({ stop } as never, { stop: stopRotation } as never, exit);

    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(calls).toEqual(["mqtt-intake-stop", "mqtt-stop", "adapter-stop"]));
    expect(exit).not.toHaveBeenCalled();
    releaseAdapter();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopRotation).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("runs one idempotent shutdown for repeated SIGINT and exits non-zero after adapter cleanup failure", async () => {
    const exit = vi.fn();
    const stop = vi.fn(async () => { throw new Error("BIO_USB_RELEASE_FAILED"); });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unregister = registerGatewayShutdownHandlers({ stop } as never, exit);

    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith("Gateway shutdown failed", expect.any(Error));
    unregister();
    errorLog.mockRestore();
  });

  it("keeps the real SIGTERM handler installed until slow USB cleanup finishes", async () => {
    const fixture = fileURLToPath(new URL("./test-fixtures/shutdown-signal-child.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      await vi.waitFor(() => expect(output).toContain("SIGNAL_HANDLER_READY"), { timeout: 5_000 });
      expect(child.kill("SIGTERM")).toBe(true);
      await vi.waitFor(() => expect(output).toContain("USB_CLEANUP_STARTED"), { timeout: 5_000 });
      expect(child.kill("SIGTERM")).toBe(true);

      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      expect(output).toContain("USB_CLEANUP_FINISHED");
      expect(output.indexOf("USB_CLEANUP_STARTED")).toBeLessThan(output.indexOf("USB_CLEANUP_FINISHED"));
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

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
        "sites/site-27/gateways/gateway-27/commands/identify",
        "sites/site-27/gateways/gateway-27/commands/dimming",
        "sites/site-27/gateways/gateway-27/commands/status-check",
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

  it("awaits adapter cleanup before rejecting when MQTT client construction fails", async () => {
    const primaryError = new Error("MQTT client construction failed");
    let releaseCleanup!: () => void;
    const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const stop = vi.fn(() => cleanupBarrier);
    const startup = startGatewayRuntime({
      env: {},
      resolveAssignment: async () => assignment,
      ensureMqttIdentity: async () => undefined,
      createAdapters: (async () => ({ stop })) as never,
      createMqtt: (() => { throw primaryError; }) as never
    });
    let settled = false;
    void startup.catch(() => { settled = true; });

    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    releaseCleanup();
    await expect(startup).rejects.toBe(primaryError);
  });

  it("preserves MQTT construction and adapter cleanup errors together", async () => {
    const primaryError = new Error("MQTT client construction failed");
    const cleanupError = new Error("USB release failed");

    await expect(startGatewayRuntime({
      env: {},
      resolveAssignment: async () => assignment,
      ensureMqttIdentity: async () => undefined,
      createAdapters: (async () => ({ stop: async () => { throw cleanupError; } })) as never,
      createMqtt: (() => { throw primaryError; }) as never
    })).rejects.toMatchObject({
      errors: [primaryError, cleanupError]
    });
  });

  it("keeps adapter cleanup ownership through later startup initialization failures", async () => {
    const primaryError = new Error("health initialization failed");
    let cleanupFinished = false;
    const adapter = {
      async stop() {
        await Promise.resolve();
        cleanupFinished = true;
      }
    };

    await expect(runGatewayStartupStageWithAdapterCleanup(adapter, async () => {
      throw primaryError;
    })).rejects.toBe(primaryError);
    expect(cleanupFinished).toBe(true);
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
