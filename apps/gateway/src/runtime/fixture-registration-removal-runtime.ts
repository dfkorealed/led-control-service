import { fixtureRegistrationRemovalTopics } from "@led-control/shared";
import type { BioUsbDongleAdapter } from "../adapters/bio-usb-dongle-adapter";
import type { AutomationRuntime } from "../automation/automation-runtime";
import type { FileAutomationStateStore } from "../automation/automation-state-store";
import type { ScheduleRuntime } from "../automation/schedule-runtime";
import type { BioCapabilityDeliveryController } from "../bio/bio-capability-delivery";
import type { BioNodeLinkMonitor } from "../bio/bio-node-link-monitor";
import type { createBioSensorRuntime } from "../bio/bio-sensor-runtime";
import type { CommandJournal } from "../commands/command-journal";
import { FixtureRegistrationRemovalHandler, type RegistrationRemovalOptions } from "../commands/fixture-registration-removal-handler";
import { automationRegistrationRemovalBlocker } from "../commands/registration-removal-safety";
import type { GroupStateStore } from "../mesh/group-state-store";
import type { ProvisioningDeviceJournal } from "../state/provisioning-device-journal";
import type { TargetedLightingResyncQueue } from "./background-mesh-resync";
import type { FixtureIdentifyRuntime } from "./fixture-identify-runtime";
import type { GatewayMqttRuntimeOptions } from "./gateway-mqtt-runtime";

interface Options extends Pick<RegistrationRemovalOptions, "journal" | "port" | "scope" | "clockTrusted" | "now" | "onError"> {
  automationRuntime: Pick<AutomationRuntime, "registrationRemovalBlocked" | "currentSnapshot">;
  scheduleRuntime: Pick<ScheduleRuntime, "pendingObservationFixtureIds">;
  sensorOperationsInProgress(): boolean;
  adapter?: Pick<BioUsbDongleAdapter, "registrationRemovalBlocker" | "forgetRegistration">;
  fixtureIdentify: Pick<FixtureIdentifyRuntime, "registrationRemovalBlocker">;
  groups: Pick<GroupStateStore, "registrationRemovalBlocker" | "retireAddress">;
  state: Pick<FileAutomationStateStore, "read" | "updateDurable">;
  commandJournals: readonly Pick<CommandJournal, "registrationRemovalBlocker">[];
  provisioningJournal: Pick<ProvisioningDeviceJournal, "registrationRemovalBlocker">;
  bioSensors?: Pick<Awaited<ReturnType<typeof createBioSensorRuntime>>, "registrationRemovalBlocker"> & {
    monitor: Pick<BioNodeLinkMonitor, "retire">;
  };
  capabilities?: Pick<BioCapabilityDeliveryController, "invalidateCommissionProofs">;
  resync: Pick<TargetedLightingResyncQueue, "markObserved">;
}

/** The production assembly owns both safety checks and local-only cleanup. */
export function createGatewayRegistrationRemovalServices(options: Options) {
  const handler = new FixtureRegistrationRemovalHandler({
    journal: options.journal, port: options.port, scope: options.scope,
    clockTrusted: options.clockTrusted, now: options.now, onError: options.onError,
    blockedReason: async command => {
      if (options.automationRuntime.registrationRemovalBlocked) return "AUTOMATION_SYNC_IN_PROGRESS";
      if (options.sensorOperationsInProgress()) return "SENSOR_OPERATION_IN_PROGRESS";
      if (options.scheduleRuntime.pendingObservationFixtureIds().includes(command.fixtureId)) return "CONTROL_UNCERTAIN";
      const local = options.adapter?.registrationRemovalBlocker(command.fixtureId)
        ?? options.fixtureIdentify.registrationRemovalBlocker(command.fixtureId) ?? options.groups.registrationRemovalBlocker()
        ?? automationRegistrationRemovalBlocker(command.fixtureId, options.automationRuntime.currentSnapshot, options.state.read());
      if (local) return local;
      for (const journal of options.commandJournals) {
        const reason = await journal.registrationRemovalBlocker(command.fixtureId, command.nodeId); if (reason) return reason;
      }
      return await options.provisioningJournal.registrationRemovalBlocker(command.deviceUuid, command.nodeId)
        ?? await options.bioSensors?.registrationRemovalBlocker(command.fixtureId, command.nodeId) ?? null;
    },
    afterRetire: async command => {
      options.adapter?.forgetRegistration(command.fixtureId, command.deviceUuid);
      options.bioSensors?.monitor.retire(command.fixtureId);
      options.capabilities?.invalidateCommissionProofs();
      // Remove an obsolete queued poll only; this emits no presence/observation.
      options.resync.markObserved(command.fixtureId);
      await options.groups.retireAddress(command.meshAddress);
      await options.state.updateDurable(state => {
        for (const key of ["currentByFixture", "baseBrightnessByFixture", "lastDesiredByFixture", "unverifiedDesiredByFixture",
          "transitionsByFixture", "manualAutomationSuppressions", "bioNormalConfigurations", "bioTargetsByFixture", "bioPulseInbox"] as const) {
          delete state[key][command.fixtureId];
        }
        return state;
      });
    }
  });
  const { siteId, gatewayId } = options.scope;
  const topicHandlers: GatewayMqttRuntimeOptions["topicHandlers"] = {
    [fixtureRegistrationRemovalTopics.command(siteId, gatewayId)]: (payload, _source, _packet, control) =>
      handler.handle(JSON.parse(payload.toString()), () => control?.acknowledgeDurable()).then(() => undefined),
    [fixtureRegistrationRemovalTopics.ack(siteId, gatewayId)]: payload =>
      handler.acknowledge(JSON.parse(payload.toString())).then(() => undefined)
  };
  return { handler, topicHandlers };
}
