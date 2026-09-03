import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { config } from "dotenv";
import {
  GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS,
  type AcceptanceAckV2,
  type AutomationConfigAppliedReceiptV1,
  type AutomationExecutionFixtureResultV1,
  type DeviceStatusAckV2,
  type FixtureStateV2,
  type GatewayDimmingCommandV2Compatible,
  type ProvisionDevicePayload,
  type ProvisioningCompletedPayload,
  type ProvisioningDeviceCommandV2,
  type ProvisioningFailedPayload,
  gatewayDimmingCommandV2CompatibilitySchema,
  gatewayHeartbeatV2Schema,
  automationConfigAppliedReceiptV1Schema,
  automationExecutionIngestedAckV1Schema,
  vehicleSensorCapabilityIngestedAckV1Schema,
  identifyDeviceSchema,
  isGatewayCommandExpired,
  mqttTopicsV2,
  mqttTopics,
  fixtureStateV2Schema,
  provisioningDeviceCommandV2Schema,
  provisioningScanStartSchema
} from "@led-control/shared";
import { isLabHilDeployment, resolveGatewayBluetoothCompanyId } from "./deployment-profile";
import { randomUUID } from "node:crypto";
import type { IPublishPacket, MqttClient } from "mqtt";
import {
  applyIdentifyDevice,
  applyProvisionDevice,
  createProvisioningScanFailedPayload,
  configuredVehicleSensorSourceFixtureIds,
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
  ProvisioningDeviceJournal,
  ProvisioningDeviceReplayPublisher,
  createProvisioningOutcomeUnknownTerminal,
  handleDurableProvisioningDevice
} from "./state/provisioning-device-journal";
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
import {
  GatewayMqttRuntime,
  type GatewayDeferredMessageControl,
  type GatewayMqttClient
} from "./runtime/gateway-mqtt-runtime";
import {
  BackgroundMeshResyncWorker,
  TargetedLightingResyncQueue,
  requestFixtureObservationResync,
  startControlPlaneWithBackgroundMeshResync
} from "./runtime/background-mesh-resync";
import { SerialTaskQueue } from "./runtime/serial-task-queue";
import type { BleMeshAdapter, BleMeshFixtureStatus, BleMeshResyncReport, ProvisioningAdapter } from "./gateway";
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
import { AutomationCurrentConfigRequester } from "./automation/automation-current-config-requester";
import { FileAutomationStateStore } from "./automation/automation-state-store";
import {
  ScheduleRuntime,
  type AutomationLifecycleHandoff,
  type AutomationTerminalHandoff,
  type ScheduleRuntimeOptions
} from "./automation/schedule-runtime";
import { SystemClockTrustProvider, type ClockTrustProvider } from "./automation/clock-trust-provider";
import {
  AutomationTelemetryOutbox,
  AutomationTelemetryPublisher
} from "./automation/automation-telemetry-outbox";
import { AutomationTelemetryCoordinator } from "./automation/automation-telemetry-coordinator";
import { createAutomationStorage } from "./automation/automation-storage";
import {
  lifecycleTelemetryRecords,
  terminalTelemetryRecords,
  type AutomationTelemetryRecordInput
} from "./automation/automation-telemetry-handoff";
import {
  VehicleSensorCapabilityJournal,
  VehicleSensorCapabilityPublisher,
  VehicleSensorClient,
  VehicleSensorGatewayController
} from "./mesh/vehicle-sensor-client";
import { createVehicleSensorVendorModel } from "./mesh/bluez-mesh-model-config";
import {
  attachSoftwareAutomationSimulatorIpc,
  createSoftwareAutomationSimulatorFromEnvironment
} from "./automation/software-automation-simulator";

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
  onLifecycleEvents?: ScheduleRuntimeOptions["onLifecycleEvents"];
  flushTelemetryHandoffs?: ScheduleRuntimeOptions["flushTelemetryHandoffs"];
  onError?: ScheduleRuntimeOptions["onError"];
  onDiagnostic?: ScheduleRuntimeOptions["onDiagnostic"];
}) {
  const scheduleRuntime = new ScheduleRuntime({
    store: options.stateStore,
    clockTrust: options.clockTrust,
    execute: options.execute,
    ...(options.requestFixtureObservation ? { requestFixtureObservation: options.requestFixtureObservation } : {}),
    ...(options.wallClock ? { wallClock: options.wallClock } : {}),
    ...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
    ...(options.onLifecycleEvents ? { onLifecycleEvents: options.onLifecycleEvents } : {}),
    ...(options.onTerminalResults ? { onTerminalResults: options.onTerminalResults } : {}),
    ...(options.flushTelemetryHandoffs ? { flushTelemetryHandoffs: options.flushTelemetryHandoffs } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {})
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

export function requeuePendingFixtureObservations(
  runtime: Pick<ScheduleRuntime, "pendingObservationFixtureIds">,
  targeted: Pick<TargetedLightingResyncQueue, "requeuePendingFixtures">
) {
  return targeted.requeuePendingFixtures(runtime.pendingObservationFixtureIds());
}

export async function handleProvisionDeviceCommand(input: {
  adapter: ProvisioningAdapter;
  command: ProvisionDevicePayload;
  publishTerminal: (
    topic: string,
    payload: ProvisioningCompletedPayload | ProvisioningFailedPayload
  ) => Promise<void>;
  requestCapabilityRefresh: (meshNodeId: string) => Promise<void>;
  onCapabilityRefreshError?: () => void;
}) {
  const result = await applyProvisionDevice(input.adapter, input.command);
  if (result.completed) {
    await input.publishTerminal(
      mqttTopics.provisioningCompleted(input.command.siteId, input.command.gatewayId),
      result.completed
    );
    void input.requestCapabilityRefresh(input.command.nodeId).catch(() => {
      input.onCapabilityRefreshError?.();
    });
    return;
  }
  if (result.failed) {
    await input.publishTerminal(
      mqttTopics.provisioningFailed(input.command.siteId, input.command.gatewayId),
      result.failed
    );
  }
}

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function main() {
  // 시작 순서는 현장 의존성을 안쪽부터 조립하는 과정이다. 먼저 배정·인증으로
  // site/gateway 범위를 확정하고, 그 범위의 local journal/outbox와 BlueZ adapter를
  // 준비한 뒤 MQTT를 연다. 순서가 바뀌면 재시작 때 재발행할 이벤트의 저장소 없이
  // 명령을 받거나, 다른 현장의 메시지를 다음 계층으로 전달할 수 있다.
  const softwareAutomationSimulator = createSoftwareAutomationSimulatorFromEnvironment(process.env);
  if (process.env.GATEWAY_PHASE0_PROBE === "1") {
    await createProductionAdapters(process.env);
    console.log(JSON.stringify({ status: "passed", capability: "bluez-mesh-bootstrap" }));
    process.exit(0);
  }
  const heartbeatMs = parseGatewayHeartbeatInterval(process.env.GATEWAY_HEARTBEAT_MS);
  const health = new ApplianceHealth(process.env.GATEWAY_HEALTH_PATH ?? "/var/run/led-control/health.json", { heartbeatMs });
  await health.startingUnassigned();
  let detachSoftwareAutomationSimulatorIpc: (() => unknown) | undefined;
  if (softwareAutomationSimulator) {
    if (!process.send || !process.connected) {
      throw new Error("software automation simulator requires private child IPC");
    }
  }
  const runtime = await startGatewayRuntime({
    env: process.env,
    ...(softwareAutomationSimulator ? {
      createAdapters: async () => softwareAutomationSimulator.adapters
    } : {})
  });
  if (!runtime.adapters.healthProbes) throw new Error("BlueZ health probes are unavailable");
  health.setProbes(runtime.adapters.healthProbes);
  const assignment = runtime.assignment;
  await health.startingAssigned();
  const { siteId, gatewayId, serialNumber: gatewaySerial, mqttUrl } = assignment;
  const gatewayFirmwareVersion = process.env.GATEWAY_FIRMWARE_VERSION || "gateway-dev-local";
  const commandTimeoutMs = parseCommandTimeout(process.env.GATEWAY_BLE_STATUS_TIMEOUT_MS);
  const adapters = runtime.adapters;
  const bluetoothCompanyId = resolveGatewayBluetoothCompanyId(process.env);
  if (isLabHilDeployment(process.env)) {
    console.warn("LAB HIL ONLY: non-production RFU Bluetooth Company ID 0xFFFE; NOT FOR PRODUCTION");
  }
  const vehicleSensorVendorModel = createVehicleSensorVendorModel(bluetoothCompanyId);
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
  const provisioningDeviceJournal = new ProvisioningDeviceJournal(
    process.env.GATEWAY_PROVISIONING_DEVICE_JOURNAL_PATH ?? "/var/lib/led-control/provisioning-device-journal.json"
  );
  await provisioningDeviceJournal.initialize();
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
  const provisioningDeviceReplay = new ProvisioningDeviceReplayPublisher(provisioningDeviceJournal);
  await provisioningDeviceJournal.recoverAccepted(async (command) =>
    createProvisioningOutcomeUnknownTerminal(command, {
      eventId: randomUUID(),
      sequence: await eventSequence.next(),
      occurredAt: new Date().toISOString()
    })
  );
  const activeProvisioningHandlers = new Set<Promise<unknown>>();
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
  const automationStorage = createAutomationStorage({
    statePath: process.env.GATEWAY_AUTOMATION_STATE_PATH ?? "/var/lib/led-control/automation-state.json",
    telemetryOutboxPath: process.env.GATEWAY_AUTOMATION_TELEMETRY_OUTBOX_PATH ??
      "/var/lib/led-control/automation-telemetry.json",
    scope: { siteId, gatewayId },
    onStateDurabilityChange: (mode) => {
      void health.setOperationalBlocker("automation_state_durability_degraded", mode === "degraded")
        .catch((error) => void reportGatewayError(error, "automation_state_durability_health"));
    },
    onStorageError: (error) => void reportGatewayError(error, "automation_storage")
  });
  let automationStorageInitialization: Awaited<ReturnType<typeof automationStorage.initialize>>;
  try {
    automationStorageInitialization = await automationStorage.initialize();
  } catch (error) {
    await health.setOperationalBlocker(automationStateHealthReason(error), true);
    throw error;
  }
  const automationStateStore = automationStorage.stateStore;
  const automationTelemetryOutbox = automationStorage.telemetryOutbox;
  if (automationStorageInitialization.telemetry.mode === "degraded" ||
    automationStorageInitialization.headroom.mode === "degraded") {
    await health.setOperationalBlocker("automation_telemetry_unavailable", true);
  }
  if (automationStateStore.durability().mode === "degraded") {
    await health.setOperationalBlocker("automation_state_durability_degraded", true);
  }
  const automationTelemetryPublisher = new AutomationTelemetryPublisher(
    automationTelemetryOutbox,
    { siteId, gatewayId },
    { onError: (error) => void reportGatewayError(error, "automation_telemetry_retry") }
  );
  const automationTelemetryCoordinator = new AutomationTelemetryCoordinator(
    automationStateStore,
    automationTelemetryOutbox,
    {
      onError: (error) => void reportGatewayError(error, "automation_telemetry_cleanup"),
      onRetryChanged: () => automationTelemetryPublisher.wake()
        .catch((error) => void reportGatewayError(error, "automation_telemetry_recovery_publish"))
    }
  );
  const clockTrust = softwareAutomationSimulator?.clockTrust ?? new SystemClockTrustProvider();
  let scheduleRuntime!: ScheduleRuntime;
  let automationRuntime!: AutomationRuntime;
  const recordRuntimeTelemetryGap = async (
    firstDroppedAt: string,
    droppedCount: number,
    lastDroppedAt: string
  ) => {
    const handedOff = await automationTelemetryCoordinator.recordGap(
      automationRuntime?.currentRevision ?? null,
      firstDroppedAt,
      droppedCount,
      lastDroppedAt
    );
    if (handedOff) void automationTelemetryPublisher.wake()
      .catch((error) => void reportGatewayError(error, "automation_gap_publish"));
    return handedOff;
  };
  const targetedLightingResync: TargetedLightingResyncQueue = new TargetedLightingResyncQueue({
    run: (fixtureIds, signal) => adapter.resyncLightingFixtures(fixtureIds, signal),
    onError: (error) => reportGatewayError(error, "automation_targeted_lighting_resync"),
    onPassComplete: () => {
      requeuePendingFixtureObservations(scheduleRuntime, targetedLightingResync);
    }
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
  const automationServices = createGatewayAutomationServices({
    configStore: new FileAutomationConfigStore(
      process.env.GATEWAY_AUTOMATION_CONFIG_PATH ?? "/var/lib/led-control/automation-snapshot.json",
      { siteId, gatewayId }
    ),
    stateStore: automationStateStore,
    scope: { siteId, gatewayId },
    clockTrust,
    ...(softwareAutomationSimulator ? {
      wallClock: softwareAutomationSimulator.wallClock,
      monotonicClock: softwareAutomationSimulator.monotonicClock
    } : {}),
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
      recordGap: recordRuntimeTelemetryGap,
      onError: (error) => void reportGatewayError(error, "automation_terminal_telemetry")
    }),
    flushTelemetryHandoffs: async () => {
      const result = await automationTelemetryCoordinator.flush(automationRuntime?.currentRevision ?? null);
      if (result.changed) void automationTelemetryPublisher.wake()
        .catch((error) => void reportGatewayError(error, "automation_telemetry_publish"));
    },
    onError: (error) => void reportGatewayError(error, "automation_runtime"),
    onDiagnostic: (diagnostic) => console.warn(JSON.stringify(diagnostic))
  });
  scheduleRuntime = automationServices.scheduleRuntime;
  automationRuntime = automationServices.automationRuntime;
  try {
    await scheduleRuntime.initialize();
  } catch (error) {
    await health.setOperationalBlocker(automationStateHealthReason(error), true);
    throw error;
  }
  if (softwareAutomationSimulator) {
    detachSoftwareAutomationSimulatorIpc = attachSoftwareAutomationSimulatorIpc(
      softwareAutomationSimulator,
      process,
      required(process.env, "AUTOMATION_E2E_SIMULATOR_IPC_TOKEN"),
      { onClockAdvanced: () => scheduleRuntime.tick() }
    );
  }
  const gatewayMonotonicClock = softwareAutomationSimulator?.monotonicClock ?? (() => performance.now());
  const manualOverrideCoordinator = createManualOverrideCoordinator(scheduleRuntime, gatewayMonotonicClock);
  await initializeAutomationBeforeManualRecovery(
    automationRuntime,
    () => recoverPendingManualAutomationHandoffs(commandJournal, manualOverrideCoordinator)
  );
  if (automationRuntime.currentRevision !== null) {
    await automationTelemetryCoordinator.flush(automationRuntime.currentRevision);
  }
  const vehicleSensorCapabilityJournal = new VehicleSensorCapabilityJournal(
    process.env.GATEWAY_VEHICLE_SENSOR_CAPABILITY_JOURNAL_PATH ??
      "/var/lib/led-control/vehicle-sensor-capabilities.json",
    { siteId, gatewayId }
  );
  const vehicleSensorCapabilityPublisher = new VehicleSensorCapabilityPublisher(
    vehicleSensorCapabilityJournal,
    { siteId, gatewayId },
    { onError: (error) => void reportGatewayError(error, "vehicle_sensor_capability_publish") }
  );
  const vehicleSensorClient = new VehicleSensorClient({
    vendorModel: vehicleSensorVendorModel,
    listConfiguredSourceFixtureIds: () =>
      configuredVehicleSensorSourceFixtureIds(scheduleRuntime.currentSnapshot),
    resolveByFixtureId: (fixtureId) => adapters.vehicleSensors.resolveByFixtureId(fixtureId),
    resolveBySourceUnicast: (sourceUnicast) => adapters.vehicleSensors.resolveBySourceUnicast(sourceUnicast),
    recordInput: (input) => scheduleRuntime.recordVehicleSensorInput(input),
    recordVendorInput: (input, identity) => scheduleRuntime.recordVehicleSensorEvent(input, identity),
    send: (destination, payload) => adapters.vehicleSensors.send(destination, payload),
    warn: (warning) => console.warn("Gateway vehicle sensor input rejected", warning)
  });
  const vehicleSensorController = new VehicleSensorGatewayController({
    port: adapters.vehicleSensors,
    client: vehicleSensorClient,
    journal: vehicleSensorCapabilityJournal,
    publisher: vehicleSensorCapabilityPublisher,
    diagnose: (diagnostic) => {
      console.warn("Gateway vehicle sensor diagnostic", diagnostic);
      if (diagnostic.event === "vehicle_sensor_capability_ack_rejected") {
        void reportGatewayError(new Error(diagnostic.event), "vehicle_sensor_capability_ack");
      } else if (diagnostic.event === "vehicle_sensor_capability_configuration_failed" ||
        diagnostic.event === "vehicle_sensor_capability_refresh_failed") {
        // Sensor capability setup is a degraded automation feature, not a gateway
        // liveness failure. Keep lighting control online and report it separately.
        void reportGatewayError(new Error(diagnostic.event), "vehicle_sensor_capability_configuration");
      }
    }
  });
  await vehicleSensorController.initialize();
  const initialVehicleSensorCapabilityRefresh = vehicleSensorController.refreshCapabilities()
    .catch((error) => reportGatewayError(error, "vehicle_sensor_capability_configuration"));
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
      requeuePendingFixtureObservations(scheduleRuntime, targetedLightingResync);
      await recordMeshResyncOutcome(health, report);
      await health.setOperationalBlocker("mesh_resync_failed", false);
      await health.setOperationalBlocker("mesh_resync_pending", false);
    },
    onError: async (error) => {
      requeuePendingFixtureObservations(scheduleRuntime, targetedLightingResync);
      console.error("Gateway background Mesh resync failed", error);
      await health.setOperationalBlocker("mesh_resync_pending", false);
      await health.setOperationalBlocker("mesh_resync_failed", true);
    }
  });
  requeuePendingFixtureObservations(scheduleRuntime, targetedLightingResync);
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
  const automationConfigRequester = new AutomationCurrentConfigRequester({ siteId, gatewayId }, {
    onError: (error) => void reportGatewayError(error, "automation_current_config_request_retry")
  });

  async function handleDimmingPayloadV2(
    payload: Buffer,
    source: GatewayMqttClient,
    packet?: IPublishPacket,
    control?: GatewayDeferredMessageControl
  ) {
    // MQTT command는 바로 RF 성공으로 바꾸지 않는다. command journal이 수신·실행
    // 경계를 보존하고, 결과 상태는 state outbox에 넣어 다음 MQTT publisher가 재시도한다.
    // 이것이 Pi 전원·인터넷 장애 뒤 남은 결과를 복구·재발행해 ACK와 실제 조명 상태의
    // 불일치를 줄이는 범위다. 저장과 RF 실행을 하나의 원자 작업으로 보장하지는 않는다.
    const receipt = createGatewayCommandReceipt(packet, gatewayMonotonicClock);
    let command: GatewayDimmingCommandV2Compatible;
    try {
      command = gatewayDimmingCommandV2CompatibilitySchema.parse(JSON.parse(payload.toString()));
    } catch (error) {
      // 형식 오류는 재전송해도 복구되지 않는다. PUBACK을 열어 poison message가
      // 영구 재전송되는 것을 막되 runtime 오류 경로에는 그대로 보고한다.
      control?.acknowledgeDurable();
      throw error;
    }
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
          onDurableReceipt: () => control?.acknowledgeDurable(),
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
    // 검색 종료 이벤트도 journal에 먼저 남긴다. 다음 reconnect 계층은 이 journal을
    // 읽어 아직 cloud에 확인되지 않은 terminal event만 다시 발행한다.
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

  async function handleProvisionDevicePayload(
    payload: Buffer,
    _source: GatewayMqttClient,
    _packet?: IPublishPacket,
    control?: GatewayDeferredMessageControl
  ) {
    let command: ProvisioningDeviceCommandV2;
    try {
      command = await handleProvisioningDevicePayloadForCurrentScope({
        payload,
        scope: { siteId, gatewayId },
        handle: (parsed) => parsed
      });
    } catch (error) {
      control?.acknowledgeDurable();
      throw error;
    }
    const handling = stateEventCapacity.run(["*"], () => handleDurableProvisioningDevice({
      journal: provisioningDeviceJournal,
      command,
      execute: (accepted) => provisioningQueue.run(() => provisioningAdapter.provision(accepted)),
      nextEnvelope: async () => ({
        eventId: randomUUID(),
        sequence: await eventSequence.next(),
        occurredAt: new Date().toISOString()
      }),
      onDurableAccept: () => control?.acknowledgeDurable(),
      onTerminalPersisted: () => {
        void provisioningDeviceReplay.wake()
          .catch((error) => void reportGatewayError(error, "provisioning_device_terminal_retry"));
      },
      onCompleted: () => {
        void vehicleSensorController.requestCapabilityRefresh(command.nodeId).catch(() => {
          void reportGatewayError(
            new Error("vehicle_sensor_capability_refresh_pending"),
            "vehicle_sensor_capability_configuration"
          );
        });
      }
    }));
    activeProvisioningHandlers.add(handling);
    void handling.finally(() => activeProvisioningHandlers.delete(handling)).catch(() => undefined);
    return handling;
  }

  async function handleAutomationPayload(payload: Buffer) {
    const acknowledgement = await handleAutomationConfigPayload(payload, automationRuntime, async (acknowledgement) => {
      await automationAckOutbox.enqueue(acknowledgement);
      void automationAckPublisher.wake()
        .catch((error) => void reportGatewayError(error, "automation_config_ack_publish"));
    });
    if (acknowledgement.status === "applied" && automationRuntime.currentSnapshot) {
      automationConfigRequester.confirm(automationRuntime.currentSnapshot);
    }
    if (automationRuntime.currentRevision !== null) {
      const result = await automationTelemetryCoordinator.flush(automationRuntime.currentRevision);
      if (result.changed) void automationTelemetryPublisher.wake()
        .catch((error) => void reportGatewayError(error, "automation_gap_publish"));
    }
    await vehicleSensorController.refreshConfiguration();
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
    commandTopics: gatewayCommandTopics(siteId, gatewayId),
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
      [mqttTopicsV2.provisioningDeviceTerminalIngestedAck(siteId, gatewayId)]: (payload) =>
        provisioningDeviceReplay.acknowledgeTerminal(JSON.parse(payload.toString())),
      [mqttTopicsV2.stateIngestedAck(siteId, gatewayId)]: async (payload) => {
        const removed = await stateEventPublisher.acknowledge(JSON.parse(payload.toString()));
        if (removed && stateEventCapacity.isBlocked()) {
          const reservation = await stateEventCapacity.recoverAndReserve(["*"]);
          if (reservation) {
            await armFixtureStatusIntake(reservation);
            meshResyncWorker.schedule(true);
          }
        }
      },
      [mqttTopics.automationConfigAppliedReceipt(siteId, gatewayId)]: async (payload) => {
        const receipt = automationConfigAppliedReceiptV1Schema.parse(
          JSON.parse(payload.toString())
        ) as AutomationConfigAppliedReceiptV1;
        const result = await automationAckOutbox.acknowledge(receipt);
        if (result === "conflict") throw new Error("automation config receipt conflict");
        if (result === "deleted") void automationAckPublisher.wake()
          .catch((error) => void reportGatewayError(error, "automation_config_ack_publish"));
      },
      [mqttTopics.automationExecutionIngested(siteId, gatewayId)]: async (payload) => {
        const acknowledgement = automationExecutionIngestedAckV1Schema.parse(JSON.parse(payload.toString()));
        if (acknowledgement.gatewayId !== gatewayId) throw new Error("automation execution ACK scope mismatch");
        const result = await automationTelemetryOutbox.markIngested(acknowledgement);
        if (result === "conflict") throw new Error("automation execution ACK hash conflict");
        if (result === "deleted") void automationTelemetryPublisher.wake()
          .catch((error) => void reportGatewayError(error, "automation_telemetry_publish"));
      },
      [mqttTopics.vehicleSensorCapabilityIngested(siteId, gatewayId)]: (payload) =>
        vehicleSensorController.acknowledge(
          vehicleSensorCapabilityIngestedAckV1Schema.parse(JSON.parse(payload.toString()))
        )
    },
    deferredPubackTopics: gatewayDeferredPubackTopics(siteId, gatewayId),
    onMessageError: (error, topic) => reportGatewayError(error, `mqtt_message:${topic}`),
    onConnect: () => connectGatewayServices({
      connectAutomationAcks: () => Promise.all([
        automationAckPublisher.connect(
          (topic, acknowledgement) => publish(mqttRuntime.client, topic, acknowledgement)
        ),
        automationConfigRequester.connect(
          (topic, request) => publish(mqttRuntime.client, topic, request)
        ),
        automationTelemetryPublisher.connect(mqttRuntime.client),
        vehicleSensorController.reconnect(
          (topic, report) => publish(mqttRuntime.client, topic, report)
        )
      ]),
      connectOperationalServices: async () => {
        await health.mqttConnected();
        await provisioningScanRecovery.connect(
          (topic, event) => publish(mqttRuntime.client, topic, event),
          (error) => reportGatewayError(error, "provisioning_scan_terminal_retry")
        );
        await provisioningDeviceReplay.connect(
          (topic, event) => publish(mqttRuntime.client, topic, event),
          (error) => reportGatewayError(error, "provisioning_device_terminal_retry")
        );
        await stateEventPublisher.connect((topic, state) => publish(mqttRuntime.client, topic, state));
        await groupResyncPublisher.publishPending((topic, payload) => publish(mqttRuntime.client, topic, payload));
        await initialVehicleSensorCapabilityRefresh;
        meshResyncWorker.schedule();
      },
      onAutomationAckError: (error) => reportGatewayError(error, "automation_config_ack_connect")
    }),
    onClose: () => {
      provisioningScanRecovery.disconnect();
      provisioningDeviceReplay.disconnect();
      stateEventPublisher.disconnect();
      automationAckPublisher.disconnect();
      automationConfigRequester.disconnect();
      automationTelemetryPublisher.disconnect();
      vehicleSensorController.disconnect();
      return health.unhealthy("mqtt_disconnected");
    },
    onBeforeStop: async () => {
      await Promise.all([...activeProvisioningHandlers].map((handling) => handling.catch(() => undefined)));
      await provisioningQueue.drain();
      await Promise.all([
        provisioningDeviceReplay.stopAndDrain(),
        automationTelemetryPublisher.stopAndDrain(),
        vehicleSensorController.stopAndDrain()
      ]);
    },
    onError: () => health.unhealthy("mqtt_error"),
    onRuntimeError: reportGatewayError
  });
  adapter.onResyncReport?.((report) => {
    void recordMeshResyncOutcome(health, report).catch((error) => void reportGatewayError(error, "mesh_resync"));
  });
  startControlPlaneWithBackgroundMeshResync(() => mqttRuntime.start(), meshResyncWorker);
  const rotation = startCertificateRotation(
    assignment,
    process.env,
    createMqttIdentityActivation(assignment, process.env, mqttRuntime)
  );
  registerGatewayShutdownHandlers({
    stop: () => drainGatewayProcessShutdown({
      runtime: mqttRuntime,
      drainBeforeMqttStop: async () => {
        detachSoftwareAutomationSimulatorIpc?.();
        const schedulerDrain = scheduleRuntime.stopAndDrain();
        const meshResyncDrain = meshResyncWorker.stopAndDrain();
        const targetedResyncDrain = targetedLightingResync.stopAndDrain();
        const vehicleSensorDrain = vehicleSensorController.stopAndDrain();
        stopAutomationFixtureStatusIntake();
        stopFixtureStatusIntake?.();
        automationTelemetryCoordinator.stop();
        automationStorage.headroom.stop();
        await fixtureStatusReservation.release();
        await Promise.all([schedulerDrain, meshResyncDrain, targetedResyncDrain, vehicleSensorDrain]);
        stateEventPublisher.disconnect();
        automationAckPublisher.disconnect();
        automationConfigRequester.disconnect();
      }
    })
  }, rotation);

  function reportGatewayError(error: unknown, context: string) {
    console.error(`Gateway MQTT ${context} failed`, error);
    return health.unhealthy("mqtt_error");
  }
}

export function gatewayDeferredPubackTopics(siteId: string, gatewayId: string) {
  return [
    mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming"),
    mqttTopicsV2.gatewayCommand(siteId, gatewayId, "provisioning/provision-device"),
    mqttTopics.automationConfig(siteId, gatewayId)
  ];
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
  enqueue: (handoff: AutomationTerminalHandoff) => Promise<unknown>;
  recordGap: (firstDroppedAt: string, droppedCount: number, lastDroppedAt: string) => Promise<unknown>;
  onPersisted?: () => void;
  onError?: (error: unknown) => void;
}) {
  return async (handoff: AutomationTerminalHandoff) => {
    const records = terminalTelemetryRecords(handoff);
    try {
      const result = await input.enqueue(handoff);
      const dropped = droppedTelemetryRecords(result);
      if (dropped.length === 0) input.onPersisted?.();
      else await recordDroppedAutomationRecords(dropped, input.recordGap, input.onError);
    } catch (error) {
      input.onError?.(error);
      await recordDroppedAutomationRecords(records, input.recordGap, input.onError);
    }
  };
}

export function createDurableAutomationLifecycleHandoff(input: {
  enqueue: (handoff: AutomationLifecycleHandoff) => Promise<unknown>;
  recordGap: (firstDroppedAt: string, droppedCount: number, lastDroppedAt: string) => Promise<unknown>;
  onPersisted?: () => void;
  onError?: (error: unknown) => void;
}) {
  return async (handoff: AutomationLifecycleHandoff) => {
    const records = lifecycleTelemetryRecords(handoff);
    try {
      const result = await input.enqueue(handoff);
      const dropped = droppedTelemetryRecords(result);
      if (dropped.length === 0) input.onPersisted?.();
      else await recordDroppedAutomationRecords(dropped, input.recordGap, input.onError);
    } catch (error) {
      input.onError?.(error);
      await recordDroppedAutomationRecords(records, input.recordGap, input.onError);
    }
  };
}

function droppedTelemetryRecords(value: unknown): AutomationTelemetryRecordInput[] {
  if (!value || typeof value !== "object" || !("droppedRecords" in value) || !Array.isArray(value.droppedRecords)) {
    return [];
  }
  return value.droppedRecords as AutomationTelemetryRecordInput[];
}

async function recordDroppedAutomationRecords(
  records: AutomationTelemetryRecordInput[],
  recordGap: (firstDroppedAt: string, droppedCount: number, lastDroppedAt: string) => Promise<unknown>,
  onError?: (error: unknown) => void
) {
  if (records.length === 0) return;
  const timestamps = records.map((record) => record.occurredAt).sort();
  try {
    await recordGap(timestamps[0]!, records.length, timestamps.at(-1)!);
  } catch (error) {
    onError?.(error);
  }
}

export async function handoffPersistedAutomationTelemetryGap(
  stateStore: FileAutomationStateStore,
  outbox: Pick<AutomationTelemetryOutbox, "recordGap">,
  revision: number
) {
  const gap = stateStore.read().telemetryGap;
  if (!gap) return false;
  await outbox.recordGap({ revision, ...gap });
  return (await stateStore.clearTelemetryGap(gap)).cleared;
}

export async function recordAndHandoffAutomationTelemetryGap(
  stateStore: FileAutomationStateStore,
  outbox: Pick<AutomationTelemetryOutbox, "recordGap">,
  revision: number | null,
  firstDroppedAt: string,
  droppedCount: number,
  lastDroppedAt: string
) {
  await stateStore.recordTelemetryGap(firstDroppedAt, droppedCount, lastDroppedAt);
  if (revision === null) return false;
  return handoffPersistedAutomationTelemetryGap(stateStore, outbox, revision);
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
        ...gatewayCommandTopics(assignment.siteId, assignment.gatewayId),
        mqttTopicsV2.meshGroupResyncAck(assignment.siteId, assignment.gatewayId),
        mqttTopicsV2.provisioningScanTerminalIngestedAck(assignment.siteId, assignment.gatewayId),
        mqttTopicsV2.provisioningDeviceTerminalIngestedAck(assignment.siteId, assignment.gatewayId),
        mqttTopicsV2.stateIngestedAck(assignment.siteId, assignment.gatewayId),
        mqttTopics.automationConfigAppliedReceipt(assignment.siteId, assignment.gatewayId),
        mqttTopics.automationExecutionIngested(assignment.siteId, assignment.gatewayId),
        mqttTopics.vehicleSensorCapabilityIngested(assignment.siteId, assignment.gatewayId)
      ],
      { qos: 1 },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

export function gatewayCommandTopics(siteId: string, gatewayId: string) {
  return [
    mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming"),
    mqttTopicsV2.gatewayCommand(siteId, gatewayId, "provisioning/scan-start"),
    mqttTopicsV2.gatewayCommand(siteId, gatewayId, "provisioning/identify-device"),
    mqttTopicsV2.gatewayCommand(siteId, gatewayId, "provisioning/provision-device"),
    mqttTopics.automationConfig(siteId, gatewayId),
    mqttTopics.meshGroupSubscriptionSync(siteId, gatewayId)
  ];
}

export async function handleProvisioningDevicePayloadForCurrentScope<T>(input: {
  payload: Buffer;
  scope: { siteId: string; gatewayId: string };
  handle: (command: ProvisioningDeviceCommandV2) => T | Promise<T>;
}) {
  const command = provisioningDeviceCommandV2Schema.parse(JSON.parse(input.payload.toString()));
  if (command.siteId !== input.scope.siteId || command.gatewayId !== input.scope.gatewayId) {
    throw new Error("provisioning device command scope mismatch");
  }
  return input.handle(command);
}

export async function drainGatewayProcessShutdown(input: {
  runtime: Pick<GatewayMqttRuntime, "quiesceCommandIntake" | "stop">;
  drainBeforeMqttStop: () => Promise<void>;
}) {
  await input.runtime.quiesceCommandIntake();
  await input.drainBeforeMqttStop();
  await input.runtime.stop();
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
