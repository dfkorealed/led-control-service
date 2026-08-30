import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import {
  GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS,
  type AcceptanceAckV2,
  type AutomationExecutionFixtureResultV1,
  type DeviceStatusAckV2,
  type FixtureStateV2,
  gatewayDimmingCommandV2CompatibilitySchema,
  gatewayHeartbeatV2Schema,
  identifyDeviceSchema,
  isGatewayCommandExpired,
  mqttTopicsV2,
  mqttTopics,
  fixtureStateV2Schema,
  provisionDeviceSchema,
  provisioningScanStartSchema
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import type { IPublishPacket, MqttClient } from "mqtt";
import {
  applyIdentifyDevice,
  applyProvisionDevice,
  createProvisioningScanFailedPayload,
  handleAutomationConfigPayload,
  ProvisioningScanRecoveryPublisher,
  handleDurableProvisioningScan
} from "./gateway";
export {
  createProvisioningScanCompletedPayload,
  createProvisioningScanFailedPayload,
  createProvisioningScanFoundPayload
} from "./gateway";
import { createAssignmentStore, resolveGatewayAssignment } from "./config/resolve-assignment";
import { createMqttClient } from "./mqtt/create-mqtt-client";
import { CommandJournal } from "./commands/command-journal";
import {
  executeAutomationDimmingActions,
  handleGatewayDimmingCommand,
  parseCommandTimeout,
  recoverPendingManualAutomationHandoffs,
  type GatewayCommandReceipt,
  type GatewayCommandResult,
  type ManualOverrideCoordinator
} from "./commands/gateway-command-handler";
import { EventSequenceStore } from "./state/event-sequence-store";
import { ProvisioningScanJournal } from "./state/provisioning-scan-journal";
import {
  StateEventCapacityGate,
  StateEventOutbox,
  StateEventOutboxError,
  StateEventOutboxPublisher,
  StateEventReservationSlot,
  type StateEventCapacityReservation
} from "./state/state-event-outbox";
import { createProductionAdapters } from "./adapters/adapter-factory";
import { ApplianceHealth, parseHeartbeatInterval } from "./health/appliance-health";
import type { GatewayAssignment } from "./config/assignment";
import { MqttCertificateClient } from "./identity/mqtt-certificate-client";
import { MqttIdentityStore, type PreparedMqttIdentity } from "./identity/mqtt-identity-store";
import { probeMqttIdentity } from "./identity/mqtt-identity-probe";
import { KeyMaterialStore } from "./identity/key-material-store";
import { DeviceCertificateClient } from "./identity/device-certificate-client";
import { createGatewayCertificateRotation, type CertificateRotation } from "./identity/certificate-rotation";
import { GatewayMqttRuntime, type GatewayMqttClient } from "./runtime/gateway-mqtt-runtime";
import {
  BackgroundMeshResyncWorker,
  TargetedLightingResyncQueue,
  requestFixtureObservationResync,
  startControlPlaneWithBackgroundMeshResync
} from "./runtime/background-mesh-resync";
import { SerialTaskQueue } from "./runtime/serial-task-queue";
import type { BleMeshAdapter, BleMeshFixtureStatus, BleMeshResyncReport } from "./gateway";
import { GroupSubscriptionHandler } from "./mesh/group-subscription-handler";
import { GroupStateStore } from "./mesh/group-state-store";
import { KeyedSerialTaskQueue } from "./runtime/keyed-serial-task-queue";
import { MeshGroupResyncPublisher, MeshGroupResyncStore } from "./mesh/group-resync-store";
import {
  FileAutomationConfigStore,
  type AutomationConfigStore,
  type AutomationScope
} from "./automation/automation-config-store";
import { AutomationRuntime } from "./automation/automation-runtime";
import { AutomationConfigAckOutbox, AutomationConfigAckPublisher } from "./automation/automation-config-ack-outbox";
import { FileAutomationStateStore } from "./automation/automation-state-store";
import { ScheduleRuntime, type AutomationTerminalHandoff, type ScheduleRuntimeOptions } from "./automation/schedule-runtime";
import { SystemClockTrustProvider, type ClockTrustProvider } from "./automation/clock-trust-provider";

const STATE_EVENT_RESERVATION_BYTES = 2_048;

export { createMeshGroupResyncRequest, MeshGroupResyncPublisher, MeshGroupResyncStore } from "./mesh/group-resync-store";

export function createGatewayAutomationServices(options: {
  configStore: AutomationConfigStore;
  stateStore: FileAutomationStateStore;
  scope: AutomationScope;
  clockTrust: ClockTrustProvider;
  execute: ScheduleRuntimeOptions["execute"];
  requestFixtureObservation?: ScheduleRuntimeOptions["requestFixtureObservation"];
  wallClock?: () => Date;
  monotonicClock?: () => number;
  onTerminalResults?: ScheduleRuntimeOptions["onTerminalResults"];
  onError?: ScheduleRuntimeOptions["onError"];
}) {
  const scheduleRuntime = new ScheduleRuntime({
    store: options.stateStore,
    clockTrust: options.clockTrust,
    execute: options.execute,
    ...(options.requestFixtureObservation ? { requestFixtureObservation: options.requestFixtureObservation } : {}),
    ...(options.wallClock ? { wallClock: options.wallClock } : {}),
    ...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
    ...(options.onTerminalResults ? { onTerminalResults: options.onTerminalResults } : {}),
    ...(options.onError ? { onError: options.onError } : {})
  });
  const automationRuntime = new AutomationRuntime({
    store: options.configStore,
    scope: options.scope,
    recompute: (snapshot) => scheduleRuntime.recompute(snapshot),
    applyDesiredState: (next, previous) => scheduleRuntime.applyDesiredState(next, previous),
    onActivated: () => scheduleRuntime.commitActivation(),
    onActivationFailed: () => scheduleRuntime.rollbackActivation(),
    ...(options.wallClock ? { now: options.wallClock } : {})
  });
  return { scheduleRuntime, automationRuntime };
}

export function createManualOverrideCoordinator(
  runtime: Pick<ScheduleRuntime, "prepareManualOverride" | "handoffManualTerminal">,
  monotonicClock?: () => number
): ManualOverrideCoordinator {
  return {
    prepare: async (command, receipt) => {
      const elapsedSinceReceiptMs = receipt && monotonicClock
        ? Math.max(0, Math.floor(monotonicClock() - receipt.receivedAtMonotonicMs))
        : 0;
      const brokerRemainingTtlMs = Math.max(
        1,
        (receipt?.brokerRemainingTtlMs ?? GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS) - elapsedSinceReceiptMs
      );
      const transitAgeMs = "deliveryWindowMs" in command
        ? Math.max(0, command.deliveryWindowMs - (receipt?.brokerRemainingTtlMs ?? command.deliveryWindowMs))
        : 0;
      const overrideRemainingMs = "overrideRemainingMs" in command && command.overrideRemainingMs !== undefined
        ? Math.max(1, command.overrideRemainingMs - transitAgeMs - elapsedSinceReceiptMs)
        : undefined;
      await runtime.prepareManualOverride({
        sourceId: command.commandId,
        fixtureIds: command.targetFixtureIds,
        brightnessPercent: command.brightness,
        startedAt: command.requestedAt,
        overrideUntil: command.overrideUntil!,
        deliveryWindowMs: brokerRemainingTtlMs,
        ...(overrideRemainingMs === undefined ? {} : { overrideRemainingMs }),
        ...("deliveryGeneration" in command ? {} : { timingSource: "legacy_wire" as const })
      });
    },
    handoff: (command, terminal) => runtime.handoffManualTerminal(
      command.commandId,
      manualTerminalResults(terminal)
    )
  };
}

export function createGatewayCommandReceipt(
  packet: Pick<IPublishPacket, "properties"> | undefined,
  monotonicClock: () => number = () => performance.now()
): GatewayCommandReceipt {
  const remainingSeconds = packet?.properties?.messageExpiryInterval;
  const brokerRemainingTtlMs = Number.isSafeInteger(remainingSeconds) && remainingSeconds! > 0
    ? remainingSeconds! * 1_000
    : 0;
  return { receivedAtMonotonicMs: monotonicClock(), brokerRemainingTtlMs };
}

export async function initializeAutomationBeforeManualRecovery(
  automationRuntime: Pick<AutomationRuntime, "initialize">,
  recoverManualHandoffs: () => Promise<void>
) {
  await automationRuntime.initialize();
  await recoverManualHandoffs();
}

export function observeAutomationFixtureStatuses(
  adapter: Pick<BleMeshAdapter, "onLightingObservation">,
  runtime: Pick<ScheduleRuntime, "recordFixtureState">,
  onError?: (error: unknown) => void,
  onObserved?: (fixtureId: string) => void
) {
  return adapter.onLightingObservation((status) => {
    const effectiveBrightness = status.powerOn ? status.brightness : 0;
    void runtime.recordFixtureState(status.fixtureId, effectiveBrightness, status.observedAt)
      .then(() => onObserved?.(status.fixtureId))
      .catch((error) => onError?.(error));
  });
}

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function main() {
  if (process.env.GATEWAY_PHASE0_PROBE === "1") {
    await createProductionAdapters(process.env);
    console.log(JSON.stringify({ status: "passed", capability: "bluez-mesh-bootstrap" }));
    process.exit(0);
  }
  const heartbeatMs = parseGatewayHeartbeatInterval(process.env.GATEWAY_HEARTBEAT_MS);
  const health = new ApplianceHealth(process.env.GATEWAY_HEALTH_PATH ?? "/var/run/led-control/health.json", { heartbeatMs });
  await health.startingUnassigned();
  const runtime = await startGatewayRuntime({ env: process.env });
  if (!runtime.adapters.healthProbes) throw new Error("BlueZ health probes are unavailable");
  health.setProbes(runtime.adapters.healthProbes);
  const assignment = runtime.assignment;
  await health.startingAssigned();
  const { siteId, gatewayId, serialNumber: gatewaySerial, mqttUrl } = assignment;
  const gatewayFirmwareVersion = process.env.GATEWAY_FIRMWARE_VERSION || "gateway-dev-local";
  const commandTimeoutMs = parseCommandTimeout(process.env.GATEWAY_BLE_STATUS_TIMEOUT_MS);
  const adapters = runtime.adapters;
  await health.meshReady();
  const adapter = adapters.dimming;
  const scannerAdapter = adapters.scanner;
  const provisioningAdapter = adapters.provisioning;
  const provisioningQueue = new SerialTaskQueue();
  const commandJournal = new CommandJournal(process.env.GATEWAY_COMMAND_JOURNAL_PATH ?? "/var/lib/led-control/command-journal.json");
  const eventSequence = new EventSequenceStore(process.env.GATEWAY_EVENT_SEQUENCE_PATH ?? "/var/lib/led-control/event-sequence.json");
  const provisioningScanJournal = new ProvisioningScanJournal(
    process.env.GATEWAY_PROVISIONING_SCAN_JOURNAL_PATH ?? "/var/lib/led-control/provisioning-scan-journal.json"
  );
  await provisioningScanJournal.initialize();
  const stateEventOutbox = new StateEventOutbox(
    process.env.GATEWAY_STATE_EVENT_OUTBOX_PATH ?? "/var/lib/led-control/state-event-outbox.json",
    { siteId, gatewayId }
  );
  try {
    await stateEventOutbox.initialize();
  } catch (error) {
    await health.setOperationalBlocker(stateEventOutboxHealthReason(error), true);
    throw error;
  }
  const stateEventCapacity = new StateEventCapacityGate(stateEventOutbox, {
    payloadBytesPerEvent: STATE_EVENT_RESERVATION_BYTES,
    onBlocked: (reason) => health.setOperationalBlocker(reason, true),
    onRecovered: () => health.setOperationalBlocker("state_outbox_capacity", false)
  });
  await stateEventCapacity.initialize();
  const stateEventPublisher = new StateEventOutboxPublisher(stateEventOutbox, {
    onError: (error) => void reportGatewayError(error, "state_event_outbox_retry")
  });
  const provisioningScanRecovery = new ProvisioningScanRecoveryPublisher(provisioningScanJournal);
  await provisioningScanRecovery.prepare(async (command) => ({
    topic: mqttTopicsV2.provisioningScanFailed(command.siteId, command.gatewayId),
    payload: createProvisioningScanFailedPayload(command, new Error("gateway scan interrupted"), {
      eventId: randomUUID(),
      sequence: await eventSequence.next(),
      occurredAt: new Date().toISOString()
    })
  }));
  const groupStateStore = new GroupStateStore(
    process.env.GATEWAY_MESH_GROUP_STATE_PATH ?? "/var/lib/led-control/mesh-groups.json"
  );
  const groupRestore = await groupStateStore.initialize();
  const groupQueue = new KeyedSerialTaskQueue();
  const groupResyncStore = new MeshGroupResyncStore(
    process.env.GATEWAY_MESH_GROUP_RESYNC_PATH ?? "/var/lib/led-control/mesh-group-resync.json",
    { siteId, gatewayId }
  );
  await groupResyncStore.initialize(groupRestore.reason);
  const groupResyncPublisher = new MeshGroupResyncPublisher({ siteId, gatewayId }, groupResyncStore);
  const automationStateStore = new FileAutomationStateStore(
    process.env.GATEWAY_AUTOMATION_STATE_PATH ?? "/var/lib/led-control/automation-state.json"
  );
  const clockTrust = new SystemClockTrustProvider();
  const targetedLightingResync = new TargetedLightingResyncQueue({
    run: (fixtureIds, signal) => adapter.resyncLightingFixtures(fixtureIds, signal),
    onError: (error) => reportGatewayError(error, "automation_targeted_lighting_resync")
  });
  let meshResyncWorker!: BackgroundMeshResyncWorker;
  let fullResyncRerunPending = false;
  const fullResyncFallback = {
    schedule: (rerunIfActive = false) => {
      if (!meshResyncWorker) {
        fullResyncRerunPending = true;
        return true;
      }
      return meshResyncWorker.schedule(rerunIfActive);
    }
  };
  const { scheduleRuntime, automationRuntime } = createGatewayAutomationServices({
    configStore: new FileAutomationConfigStore(
      process.env.GATEWAY_AUTOMATION_CONFIG_PATH ?? "/var/lib/led-control/automation-snapshot.json",
      { siteId, gatewayId }
    ),
    stateStore: automationStateStore,
    scope: { siteId, gatewayId },
    clockTrust,
    requestFixtureObservation: (fixtureIds) => {
      requestFixtureObservationResync(fixtureIds, targetedLightingResync, fullResyncFallback);
    },
    execute: (actions) => executeAutomationWithBestEffortTelemetry({
      actions,
      execute: (requested) => executeAutomationDimmingActions(adapter, requested, { timeoutMs: commandTimeoutMs }),
      enqueueTelemetry: (results) => enqueueAutomationFixtureStates({
        siteId,
        gatewayId,
        eventSequence,
        results,
        enqueue: (state) => enqueueFixtureState(state)
      }),
      recordGap: (firstDroppedAt, droppedCount, lastDroppedAt) =>
        automationStateStore.recordTelemetryGap(firstDroppedAt, droppedCount, lastDroppedAt),
      onError: (error) => void reportGatewayError(error, "automation_terminal_telemetry")
    }),
    onTerminalResults: createDurableAutomationTerminalHandoff({
      enqueue: (handoff) => reportAutomationTerminalHandoff(handoff),
      recordGap: (firstDroppedAt, droppedCount, lastDroppedAt) =>
        automationStateStore.recordTelemetryGap(firstDroppedAt, droppedCount, lastDroppedAt),
      onError: (error) => void reportGatewayError(error, "automation_terminal_handoff")
    }),
    onError: (error) => void reportGatewayError(error, "automation_runtime")
  });
  try {
    await scheduleRuntime.initialize();
  } catch (error) {
    await health.setOperationalBlocker(automationStateHealthReason(error), true);
    throw error;
  }
  const gatewayMonotonicClock = () => performance.now();
  const manualOverrideCoordinator = createManualOverrideCoordinator(scheduleRuntime, gatewayMonotonicClock);
  await initializeAutomationBeforeManualRecovery(
    automationRuntime,
    () => recoverPendingManualAutomationHandoffs(commandJournal, manualOverrideCoordinator)
  );
  const stopAutomationFixtureStatusIntake = observeAutomationFixtureStatuses(
    adapter,
    scheduleRuntime,
    (error) => void reportGatewayError(error, "automation_fixture_status"),
    (fixtureId) => targetedLightingResync.markObserved(fixtureId)
  );
  await health.setOperationalBlocker("mesh_resync_pending", true);
  meshResyncWorker = new BackgroundMeshResyncWorker({
    run: (signal) => adapter.resyncFixtureStates(signal),
    onReport: async (report) => {
      await recordMeshResyncOutcome(health, report);
      await health.setOperationalBlocker("mesh_resync_failed", false);
      await health.setOperationalBlocker("mesh_resync_pending", false);
    },
    onError: async (error) => {
      console.error("Gateway background Mesh resync failed", error);
      await health.setOperationalBlocker("mesh_resync_pending", false);
      await health.setOperationalBlocker("mesh_resync_failed", true);
    }
  });
  if (fullResyncRerunPending) meshResyncWorker.schedule(true);
  scheduleRuntime.start();
  const automationAckOutbox = new AutomationConfigAckOutbox(
    process.env.GATEWAY_AUTOMATION_ACK_OUTBOX_PATH ?? "/var/lib/led-control/automation-config-acks.json",
    { siteId, gatewayId }
  );
  await automationAckOutbox.initialize();
  const automationAckPublisher = new AutomationConfigAckPublisher(automationAckOutbox, { siteId, gatewayId }, {
    onError: (error) => void reportGatewayError(error, "automation_config_ack_retry")
  });

  async function handleDimmingPayloadV2(payload: Buffer, source: GatewayMqttClient, packet?: IPublishPacket) {
    const receipt = createGatewayCommandReceipt(packet, gatewayMonotonicClock);
    const command = gatewayDimmingCommandV2CompatibilitySchema.parse(JSON.parse(payload.toString()));
    let acceptancePublished = false;
    let stateReservation: StateEventCapacityReservation | undefined;
    try {
      const result = await handleGatewayDimmingCommand(
        adapter,
        commandJournal,
        command,
        async (acceptance) => {
          await publish(source, mqttTopicsV2.acceptanceAck(siteId, gatewayId), acceptance);
          acceptancePublished = true;
        },
        {
          timeoutMs: commandTimeoutMs,
          groupStateStore,
          groupQueue,
          beforeExecution: async () => {
            try {
              stateReservation = await stateEventCapacity.reserve(command.targetFixtureIds);
            } catch (error) {
              throw error;
            }
          },
          isCommandExpired: async (expiresAt) => {
            const now = new Date();
            return await clockTrust.isTrusted(now) && isGatewayCommandExpired(expiresAt, now);
          },
          receipt,
          monotonicClock: gatewayMonotonicClock,
          automation: manualOverrideCoordinator,
          onAutomationError: (error) => void reportGatewayError(error, "automation_manual_handoff")
        }
      );
      if (shouldPublishFinalAcceptance(acceptancePublished, result.acceptance.status)) {
        await publish(source, mqttTopicsV2.acceptanceAck(siteId, gatewayId), result.acceptance);
      }
      await publish(source, mqttTopicsV2.deviceStatusAck(siteId, gatewayId), result.deviceStatus);
      if (shouldPublishFixtureStates(result)) await publishDeviceStates(result, command.brightness, stateReservation);
    } finally {
      if (stateReservation) await stateEventOutbox.release(stateReservation);
    }
  }

  async function publishDeviceStates(
    result: GatewayCommandResult,
    fallbackBrightness: number,
    reservation?: StateEventCapacityReservation
  ) {
    await publishObservedDeviceStates({
      siteId,
      gatewayId,
      eventSequence,
      publish: (_topic, state) => enqueueFixtureState(state, reservation),
      result,
      fallbackBrightness
    });
  }

  async function enqueueFixtureState(state: FixtureStateV2, reservation?: StateEventCapacityReservation) {
    try {
      await stateEventOutbox.enqueue(state, reservation);
      stateEventPublisher.wake();
    } catch (error) {
      await stateEventCapacity.block();
      throw error;
    }
  }

  function publish(client: Pick<MqttClient, "publish">, topic: string, payload: unknown) {
    return new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => (error ? reject(error) : resolve()));
    });
  }

  async function handleProvisioningScanPayload(payload: Buffer, source: GatewayMqttClient) {
    const command = provisioningScanStartSchema.parse(JSON.parse(payload.toString()));
    return stateEventCapacity.run(["*"], async () => {
      try {
        await handleDurableProvisioningScan({
          adapter: scannerAdapter,
          journal: provisioningScanJournal,
          command,
          nextEnvelope: async () => ({ eventId: randomUUID(), sequence: await eventSequence.next(), occurredAt: new Date().toISOString() }),
          publish: (topic, event) => publish(source, topic, event),
          onTerminalPersisted: () => provisioningScanRecovery.scheduleRetry()
        });
      } finally {
        provisioningScanRecovery.scheduleRetry();
      }
    });
  }

  async function handleIdentifyPayload(payload: Buffer, _source: GatewayMqttClient) {
    const command = identifyDeviceSchema.parse(JSON.parse(payload.toString()));
    await stateEventCapacity.run(["*"], () => applyIdentifyDevice(provisioningAdapter, command));
  }

  async function handleProvisionDevicePayload(payload: Buffer, source: GatewayMqttClient) {
    return provisioningQueue.run(async () => {
      const command = provisionDeviceSchema.parse(JSON.parse(payload.toString()));
      return stateEventCapacity.run(["*"], async () => {
        const result = await applyProvisionDevice(provisioningAdapter, command);
        if (result.completed) {
          source.publish(mqttTopics.provisioningCompleted(command.siteId, command.gatewayId), JSON.stringify(result.completed), { qos: 1 });
          return;
        }
        if (result.failed) {
          source.publish(mqttTopics.provisioningFailed(command.siteId, command.gatewayId), JSON.stringify(result.failed), { qos: 1 });
        }
      });
    });
  }

  async function handleAutomationPayload(payload: Buffer) {
    await handleAutomationConfigPayload(payload, automationRuntime, async (acknowledgement) => {
      await automationAckOutbox.enqueue(acknowledgement);
      void automationAckPublisher.wake()
        .catch((error) => void reportGatewayError(error, "automation_config_ack_publish"));
    });
  }

  const fixtureStatusReservation = new StateEventReservationSlot(stateEventOutbox);
  let stopFixtureStatusIntake: (() => void) | undefined;

  async function armFixtureStatusIntake(reservation?: StateEventCapacityReservation) {
    const candidate = reservation ?? await stateEventCapacity.reserve(["*"]);
    const alreadyCurrent = fixtureStatusReservation.isCurrent(candidate);
    if (!await fixtureStatusReservation.attach(candidate)) return false;
    if (stopFixtureStatusIntake) {
      if (!alreadyCurrent) await fixtureStatusReservation.release(candidate);
      return false;
    }

    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = adapter.onFixtureStatus((status) => {
        const currentReservation = fixtureStatusReservation.take(candidate);
        if (!currentReservation) return;
        unsubscribe();
        if (stopFixtureStatusIntake === unsubscribe) stopFixtureStatusIntake = undefined;
        const publishFixtureStatus = createFixtureStatusPublisher({
          siteId,
          gatewayId,
          eventSequence,
          publish: (_topic, state) => enqueueFixtureState(state, currentReservation)
        });
        void publishFixtureStatus(status)
          .then(() => armFixtureStatusIntake())
          .catch(async (error) => {
            await stateEventOutbox.release(currentReservation);
            await reportGatewayError(error, "mesh_fixture_status");
          });
      });
      stopFixtureStatusIntake = unsubscribe;
      return true;
    } catch (error) {
      await fixtureStatusReservation.release(candidate);
      throw error;
    }
  }

  if (!stateEventCapacity.isBlocked()) await armFixtureStatusIntake();

  const groupSubscriptionHandler = new GroupSubscriptionHandler(
    adapter,
    { siteId, gatewayId },
    groupStateStore,
    groupQueue
  );

  async function publishHeartbeat() {
    const occurredAt = new Date().toISOString();
    const heartbeat = gatewayHeartbeatV2Schema.parse({
      siteId,
      gatewayId,
      eventId: randomUUID(),
      sequence: await eventSequence.next(),
      occurredAt,
      gatewaySerial,
      firmwareVersion: gatewayFirmwareVersion,
      configVersion: assignment.configVersion
    });
    await publish(mqttRuntime.client, mqttTopicsV2.heartbeat(siteId, gatewayId), heartbeat);
    await health.heartbeatPublished();
    await groupResyncPublisher.publishPending((topic, payload) => publish(mqttRuntime.client, topic, payload));
  }

  const mqttRuntime: GatewayMqttRuntime = new GatewayMqttRuntime({
    client: runtime.client,
    heartbeatMs,
    subscribe: (client, sessionPresent, force) => subscribeGatewayCommands(client, assignment, sessionPresent, force),
    publishHeartbeat,
    topicHandlers: {
      [mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming")]: handleDimmingPayloadV2,
      [mqttTopicsV2.gatewayCommand(siteId, gatewayId, "provisioning/scan-start")]: handleProvisioningScanPayload,
      [mqttTopicsV2.gatewayCommand(siteId, gatewayId, "provisioning/identify-device")]: handleIdentifyPayload,
      [mqttTopicsV2.gatewayCommand(siteId, gatewayId, "provisioning/provision-device")]: handleProvisionDevicePayload,
      [mqttTopics.automationConfig(siteId, gatewayId)]: handleAutomationPayload,
      [`sites/${siteId}/gateways/${gatewayId}/commands/mesh-group/subscription-sync`]: (payload, source) => groupSubscriptionHandler.handle(payload, source),
      [mqttTopicsV2.meshGroupResyncAck(siteId, gatewayId)]: (payload) =>
        groupResyncPublisher.acknowledge(JSON.parse(payload.toString())),
      [mqttTopicsV2.provisioningScanTerminalIngestedAck(siteId, gatewayId)]: (payload) =>
        provisioningScanRecovery.acknowledgeTerminal(JSON.parse(payload.toString())),
      [mqttTopicsV2.stateIngestedAck(siteId, gatewayId)]: async (payload) => {
        const removed = await stateEventPublisher.acknowledge(JSON.parse(payload.toString()));
        if (removed && stateEventCapacity.isBlocked()) {
          const reservation = await stateEventCapacity.recoverAndReserve(["*"]);
          if (reservation) {
            await armFixtureStatusIntake(reservation);
            meshResyncWorker.schedule(true);
          }
        }
      }
    },
    deferredPubackTopics: [mqttTopics.automationConfig(siteId, gatewayId)],
    onMessageError: (error, topic) => reportGatewayError(error, `mqtt_message:${topic}`),
    onConnect: () => connectGatewayServices({
      connectAutomationAcks: () => automationAckPublisher
        .connect((topic, acknowledgement) => publish(mqttRuntime.client, topic, acknowledgement)),
      connectOperationalServices: async () => {
        await health.mqttConnected();
        await provisioningScanRecovery.connect(
          (topic, event) => publish(mqttRuntime.client, topic, event),
          (error) => reportGatewayError(error, "provisioning_scan_terminal_retry")
        );
        await stateEventPublisher.connect((topic, state) => publish(mqttRuntime.client, topic, state));
        await groupResyncPublisher.publishPending((topic, payload) => publish(mqttRuntime.client, topic, payload));
        meshResyncWorker.schedule();
      },
      onAutomationAckError: (error) => reportGatewayError(error, "automation_config_ack_connect")
    }),
    onClose: () => {
      provisioningScanRecovery.disconnect();
      stateEventPublisher.disconnect();
      automationAckPublisher.disconnect();
      return health.unhealthy("mqtt_disconnected");
    },
    onError: () => health.unhealthy("mqtt_error"),
    onRuntimeError: reportGatewayError
  });
  adapter.onResyncReport?.((report) => {
    void recordMeshResyncOutcome(health, report).catch((error) => void reportGatewayError(error, "mesh_resync"));
  });
  startControlPlaneWithBackgroundMeshResync(() => mqttRuntime.start(), meshResyncWorker);
  const rotation = startCertificateRotation(assignment, process.env, createMqttIdentityActivation(assignment, process.env, mqttRuntime));
  registerGatewayShutdownHandlers({
    stop: async () => {
      const schedulerDrain = scheduleRuntime.stopAndDrain();
      const meshResyncDrain = meshResyncWorker.stopAndDrain();
      const targetedResyncDrain = targetedLightingResync.stopAndDrain();
      stopAutomationFixtureStatusIntake();
      stopFixtureStatusIntake?.();
      await fixtureStatusReservation.release();
      await Promise.all([schedulerDrain, meshResyncDrain, targetedResyncDrain]);
      stateEventPublisher.disconnect();
      automationAckPublisher.disconnect();
      await mqttRuntime.stop();
    }
  }, rotation);

  function reportGatewayError(error: unknown, context: string) {
    console.error(`Gateway MQTT ${context} failed`, error);
    return health.unhealthy("mqtt_error");
  }
}

export function stateEventOutboxHealthReason(error: unknown) {
  if (!(error instanceof StateEventOutboxError)) return "state_outbox_corrupt";
  switch (error.code) {
    case "STATE_OUTBOX_MISSING":
      return "state_outbox_missing";
    case "STATE_OUTBOX_PERMISSIONS":
      return "state_outbox_permissions";
    case "STATE_OUTBOX_CAPACITY":
      return "state_outbox_capacity";
    case "STATE_OUTBOX_CORRUPT":
    case "STATE_OUTBOX_MANIFEST_CORRUPT":
      return "state_outbox_corrupt";
  }
}

export function connectGatewayServices(options: {
  connectAutomationAcks: () => Promise<unknown>;
  connectOperationalServices: () => Promise<unknown>;
  onAutomationAckError: (error: unknown) => unknown;
}) {
  try {
    void options.connectAutomationAcks().catch((error) => void options.onAutomationAckError(error));
  } catch (error) {
    void options.onAutomationAckError(error);
  }
  return options.connectOperationalServices();
}

export function manualTerminalResults(terminal: DeviceStatusAckV2): AutomationExecutionFixtureResultV1[] {
  return terminal.results.map((result) => ({
    fixtureId: result.fixtureId,
    status: result.status,
    brightnessPercent: result.brightness ?? null,
    faultCode: result.faultCode ?? null,
    errorCode: result.status === "succeeded"
      ? null
      : result.faultCode ?? (result.status === "timed_out" ? "status_timeout" : "manual_command_failed"),
    occurredAt: terminal.occurredAt
  }));
}

export async function executeAutomationWithBestEffortTelemetry(input: {
  actions: Parameters<ScheduleRuntimeOptions["execute"]>[0];
  execute: ScheduleRuntimeOptions["execute"];
  enqueueTelemetry: (results: AutomationExecutionFixtureResultV1[]) => Promise<void>;
  recordGap: (firstDroppedAt: string, droppedCount: number, lastDroppedAt: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  const results = await input.execute(input.actions);
  try {
    await input.enqueueTelemetry(results);
  } catch (error) {
    input.onError?.(error);
    const dropped = error instanceof AutomationTerminalTelemetryEnqueueError
      ? error.droppedResults
      : results;
    const timestamps = dropped.map((result) => result.occurredAt).sort();
    try {
      await input.recordGap(timestamps[0]!, dropped.length, timestamps.at(-1)!);
    } catch (gapError) {
      input.onError?.(gapError);
    }
  }
  return results;
}

export function createDurableAutomationTerminalHandoff(input: {
  enqueue: (handoff: AutomationTerminalHandoff) => Promise<void>;
  recordGap: (firstDroppedAt: string, droppedCount: number, lastDroppedAt: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  return async (handoff: AutomationTerminalHandoff) => {
    try {
      await input.enqueue(handoff);
    } catch (error) {
      input.onError?.(error);
      const timestamps = handoff.results.map((result) => result.occurredAt).sort();
      try {
        await input.recordGap(timestamps[0]!, handoff.results.length, timestamps.at(-1)!);
      } catch (gapError) {
        input.onError?.(gapError);
      }
    }
  };
}

export async function enqueueAutomationFixtureStates(input: {
  siteId: string;
  gatewayId: string;
  eventSequence: Pick<EventSequenceStore, "next">;
  results: AutomationExecutionFixtureResultV1[];
  enqueue: (state: FixtureStateV2) => Promise<void>;
}) {
  const droppedResults: AutomationExecutionFixtureResultV1[] = [];
  const errors: unknown[] = [];
  for (const result of input.results) {
    if (result.brightnessPercent === null ||
      (result.status !== "succeeded" && result.faultCode !== "state_mismatch")) continue;
    const brightness = result.brightnessPercent;
    try {
      await input.enqueue(fixtureStateV2Schema.parse({
        siteId: input.siteId,
        gatewayId: input.gatewayId,
        eventId: randomUUID(),
        sequence: await input.eventSequence.next(),
        occurredAt: result.occurredAt,
        fixtureId: result.fixtureId,
        brightness,
        powerOn: brightness > 0,
        status: result.status === "succeeded" ? "online" : "fault",
        statusReason: result.status === "succeeded" ? "reported" : "command_failed",
        ...(result.faultCode ? { faultCode: result.faultCode } : {}),
        rssi: null,
        hopCount: null
      }));
    } catch (error) {
      droppedResults.push(result);
      errors.push(error);
    }
  }
  if (droppedResults.length > 0) throw new AutomationTerminalTelemetryEnqueueError(droppedResults, errors);
}

export class AutomationTerminalTelemetryEnqueueError extends Error {
  constructor(
    readonly droppedResults: AutomationExecutionFixtureResultV1[],
    errors: unknown[]
  ) {
    super("automation_terminal_telemetry_enqueue_failed", {
      cause: new AggregateError(errors, "automation terminal telemetry enqueue failed")
    });
    this.name = "AutomationTerminalTelemetryEnqueueError";
  }
}

export function reportAutomationTerminalHandoff(
  handoff: AutomationTerminalHandoff,
  logger: Pick<Console, "info"> = console
) {
  logger.info(JSON.stringify({ event: "automation_terminal_handoff", ...handoff }));
  return Promise.resolve();
}

export function automationStateHealthReason(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") {
    return "automation_state_unavailable";
  }
  return error.code;
}

export function observedFixtureResults(result: Pick<GatewayCommandResult, "deviceStatus" | "fixtureStateObserved" | "observedFixtureIds">) {
  if (!result.fixtureStateObserved) return [];
  const observedIds = new Set(
    result.observedFixtureIds ?? result.deviceStatus.results
      .filter((fixture) => fixture.status === "succeeded" || (fixture.faultCode === "state_mismatch" && fixture.brightness !== undefined))
      .map((fixture) => fixture.fixtureId)
  );
  return result.deviceStatus.results.filter((fixture) =>
    observedIds.has(fixture.fixtureId) &&
    fixture.brightness !== undefined &&
    (fixture.status === "succeeded" || fixture.faultCode === "state_mismatch")
  );
}

export async function publishObservedDeviceStates(input: {
  siteId: string;
  gatewayId: string;
  eventSequence: Pick<EventSequenceStore, "next">;
  publish: (topic: string, payload: FixtureStateV2) => Promise<void>;
  result: Pick<GatewayCommandResult, "deviceStatus" | "fixtureStateObserved" | "observedFixtureIds">;
  fallbackBrightness: number;
}) {
  for (const fixture of observedFixtureResults(input.result)) {
    const brightness = fixture.brightness ?? input.fallbackBrightness;
    const state = fixtureStateV2Schema.parse({
      siteId: input.siteId,
      gatewayId: input.gatewayId,
      eventId: randomUUID(),
      sequence: await input.eventSequence.next(),
      occurredAt: input.result.deviceStatus.occurredAt,
      fixtureId: fixture.fixtureId,
      brightness,
      powerOn: brightness > 0,
      status: fixture.status === "succeeded" ? "online" : "fault",
      statusReason: fixture.status === "succeeded" ? "reported" : "command_failed",
      ...(fixture.faultCode ? { faultCode: fixture.faultCode } : {}),
      rssi: fixture.rssi ?? null,
      hopCount: fixture.hopCount ?? null
    });
    await input.publish(mqttTopicsV2.fixtureState(input.siteId, input.gatewayId), state);
  }
}

export function shouldPublishFixtureStates(result: Pick<GatewayCommandResult, "fixtureStateObserved">) {
  return result.fixtureStateObserved;
}

export async function recordMeshResyncOutcome(
  health: Pick<ApplianceHealth, "recordMeshResync">,
  report: BleMeshResyncReport,
  logger: Pick<Console, "info" | "warn"> = console
) {
  await health.recordMeshResync(report);
  logger.info(JSON.stringify({ event: "mesh_resync", ...report }));
  if (report.observed !== report.total) {
    logger.warn(JSON.stringify({ event: "mesh_resync_incomplete", ...report }));
  }
}

export function createFixtureStatusPublisher(input: {
  siteId: string;
  gatewayId: string;
  eventSequence: Pick<EventSequenceStore, "next">;
  publish: (topic: string, payload: FixtureStateV2) => Promise<void>;
  now?: () => string;
}) {
  return async (status: BleMeshFixtureStatus) => {
    const state = fixtureStateV2Schema.parse({
      siteId: input.siteId,
      gatewayId: input.gatewayId,
      eventId: randomUUID(),
      sequence: await input.eventSequence.next(),
      occurredAt: (input.now ?? (() => new Date().toISOString()))(),
      fixtureId: status.fixtureId,
      brightness: status.brightness,
      powerOn: status.powerOn,
      status: status.status,
      statusReason: "mesh_publication",
      ...(status.faultCode ? { faultCode: status.faultCode } : {}),
      health: status.health,
      rssi: status.rssi,
      hopCount: status.hopCount
    });
    await input.publish(mqttTopicsV2.fixtureState(input.siteId, input.gatewayId), state);
  };
}

export function shouldPublishFinalAcceptance(acceptancePublished: boolean, status: AcceptanceAckV2["status"]) {
  return !acceptancePublished || status === "rejected";
}

export function subscribeGatewayCommands(
  client: Pick<MqttClient, "subscribe">,
  assignment: Pick<GatewayAssignment, "siteId" | "gatewayId">,
  sessionPresent: boolean,
  force = false
) {
  if (sessionPresent && !force) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    client.subscribe(
      [
        mqttTopicsV2.gatewayCommand(assignment.siteId, assignment.gatewayId, "dimming"),
        mqttTopicsV2.gatewayCommand(assignment.siteId, assignment.gatewayId, "provisioning/scan-start"),
        mqttTopicsV2.gatewayCommand(assignment.siteId, assignment.gatewayId, "provisioning/identify-device"),
        mqttTopicsV2.gatewayCommand(assignment.siteId, assignment.gatewayId, "provisioning/provision-device"),
        mqttTopics.automationConfig(assignment.siteId, assignment.gatewayId),
        mqttTopics.meshGroupSubscriptionSync(assignment.siteId, assignment.gatewayId),
        mqttTopicsV2.meshGroupResyncAck(assignment.siteId, assignment.gatewayId),
        mqttTopicsV2.provisioningScanTerminalIngestedAck(assignment.siteId, assignment.gatewayId),
        mqttTopicsV2.stateIngestedAck(assignment.siteId, assignment.gatewayId)
      ],
      { qos: 1 },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

export function createGatewayShutdownHandler(
  runtime: Pick<GatewayMqttRuntime, "stop">,
  rotationOrExit?: Pick<CertificateRotation, "stop"> | ((code: number) => void),
  exit: (code: number) => void = (code) => process.exit(code)
) {
  const rotation = typeof rotationOrExit === "function" ? undefined : rotationOrExit;
  const shutdownExit = typeof rotationOrExit === "function" ? rotationOrExit : exit;
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= Promise.all([rotation?.stop(), runtime.stop()])
      .then(() => undefined)
      .then(() => shutdownExit(0))
      .catch((error) => {
        console.error("Gateway shutdown failed", error);
        shutdownExit(1);
      });
    return stopping;
  };
}

export function registerGatewayShutdownHandlers(
  runtime: Pick<GatewayMqttRuntime, "stop">,
  rotationOrExit?: Pick<CertificateRotation, "stop"> | ((code: number) => void),
  exit: (code: number) => void = (code) => process.exit(code)
) {
  const shutdown = createGatewayShutdownHandler(runtime, rotationOrExit, exit);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return () => {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  };
}

export async function startGatewayRuntime(options: {
  env: NodeJS.ProcessEnv;
  resolveAssignment?: () => Promise<GatewayAssignment>;
  ensureMqttIdentity?: (assignment: GatewayAssignment, env: NodeJS.ProcessEnv) => Promise<void>;
  createAdapters?: typeof createProductionAdapters;
  createMqtt?: typeof createMqttClient;
}) {
  const assignment = await (options.resolveAssignment ?? (() =>
    resolveGatewayAssignment({ env: options.env, store: createAssignmentStore(options.env) })
  ))();
  await (options.ensureMqttIdentity ?? ensureMqttIdentity)(assignment, options.env);
  const adapters = await (options.createAdapters ?? createProductionAdapters)(options.env);
  const client = (options.createMqtt ?? createMqttClient)(
    { ...options.env, MQTT_URL: assignment.mqttUrl },
    { gatewayId: assignment.gatewayId }
  );
  return { assignment, adapters, client };
}

export async function ensureMqttIdentity(assignment: GatewayAssignment, env: NodeJS.ProcessEnv) {
  const bootstrapUrl = required(env, "GATEWAY_BOOTSTRAP_URL");
  const client = new MqttCertificateClient({
    url: new URL("/gateway-certificates/mqtt", bootstrapUrl).toString(),
    certificatePath: required(env, "GATEWAY_DEVICE_CERT_PATH"),
    privateKeyPath: required(env, "GATEWAY_DEVICE_KEY_PATH"),
    caPath: required(env, "GATEWAY_BOOTSTRAP_CA_PATH")
  });
  const deviceIdentityRoot = env.GATEWAY_IDENTITY_ROOT ?? "/var/lib/led-control/identity/device";
  const mqttIdentityRoot = env.GATEWAY_MQTT_IDENTITY_ROOT ?? "/var/lib/led-control/identity/mqtt";
  const mqttCaPath = env.GATEWAY_MQTT_CA_SOURCE_PATH ?? join(deviceIdentityRoot, "current", "mqtt-ca.crt");
  const store = new MqttIdentityStore({ identityRoot: mqttIdentityRoot });
  await store.ensure(
    assignment.gatewayId,
    await readFile(mqttCaPath, "utf8"),
    (csrPem) => client.requestCertificate(csrPem),
    (candidate) => probeMqttIdentity(assignment.mqttUrl, candidate)
  );
}

function startCertificateRotation(
  assignment: GatewayAssignment,
  env: NodeJS.ProcessEnv,
  activateMqttIdentity: (prepared: PreparedMqttIdentity) => Promise<void>
): CertificateRotation {
  const bootstrapUrl = required(env, "GATEWAY_BOOTSTRAP_URL");
  const deviceIdentityRoot = env.GATEWAY_IDENTITY_ROOT ?? "/var/lib/led-control/identity/device";
  const mqttIdentityRoot = env.GATEWAY_MQTT_IDENTITY_ROOT ?? "/var/lib/led-control/identity/mqtt";
  const currentDevice = join(deviceIdentityRoot, "current");
  const deviceClient = new DeviceCertificateClient({
    renewUrl: new URL("/gateway-certificates/device/renew", bootstrapUrl).toString(),
    activateUrl: new URL("/gateway-certificates/device/activate", bootstrapUrl).toString(),
    certificatePath: join(currentDevice, "device.crt"),
    privateKeyPath: join(currentDevice, "device.key"),
    caPath: join(currentDevice, "api-ca.crt")
  });
  const mqttClient = new MqttCertificateClient({
    url: new URL("/gateway-certificates/mqtt", bootstrapUrl).toString(),
    certificatePath: join(currentDevice, "device.crt"),
    privateKeyPath: join(currentDevice, "device.key"),
    caPath: required(env, "GATEWAY_BOOTSTRAP_CA_PATH")
  });
  const rotation = createGatewayCertificateRotation({
    gatewayId: assignment.gatewayId,
    deviceStore: new KeyMaterialStore({ identityRoot: deviceIdentityRoot }),
    mqttStore: new MqttIdentityStore({ identityRoot: mqttIdentityRoot }),
    deviceClient,
    mqttClient,
    mqttProbe: (candidate) => probeMqttIdentity(assignment.mqttUrl, candidate),
    activateMqttIdentity
  });
  rotation.start();
  return rotation;
}

export function parseGatewayHeartbeatInterval(value: string | undefined) {
  return parseHeartbeatInterval(value === undefined ? undefined : Number(value));
}

export function createMqttIdentityActivation(
  assignment: Pick<GatewayAssignment, "gatewayId" | "mqttUrl">,
  env: NodeJS.ProcessEnv,
  runtime: Pick<GatewayMqttRuntime, "activate">,
  createMqtt: typeof createMqttClient = createMqttClient
) {
  return async (prepared: PreparedMqttIdentity) => {
    const candidate = prepared.candidate;
    const client = createMqtt({
      ...env,
      MQTT_URL: assignment.mqttUrl,
      MQTT_CA_PATH: candidate.caPath,
      MQTT_CLIENT_CERT_PATH: candidate.certificatePath,
      MQTT_CLIENT_KEY_PATH: candidate.keyPath
    }, { gatewayId: assignment.gatewayId }, { manualConnect: true });
    await runtime.activate(client, prepared);
  };
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for MQTT identity`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
