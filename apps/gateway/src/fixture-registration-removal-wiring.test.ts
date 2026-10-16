import type { MqttClient } from "mqtt";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureRegistrationRemovalTopics, type FixtureRegistrationRemovalTerminal } from "@led-control/shared";
import {
  gatewayCommandTopics,
  gatewayDeferredPubackTopics,
  subscribeGatewayAcknowledgements,
  subscribeGatewayCommands,
  gatewayRegistrationRemovalVersion,
  createGatewayRegistrationRemovalServices
} from "./index";
import { BioUsbDongleAdapter } from "./adapters/bio-usb-dongle-adapter";
import { BioDeviceMappingStore } from "./bio/bio-device-mapping-store";
import { FixtureRegistrationRemovalJournal } from "./state/fixture-registration-removal-journal";
import { FileAutomationStateStore } from "./automation/automation-state-store";
import { GroupStateStore } from "./mesh/group-state-store";
import type { GatewayMqttClient } from "./runtime/gateway-mqtt-runtime";
import { mappingInput, removalAck, removalCommand, removalNow, removalScope } from "../test/registration-removal-fixtures";

const assignment = {
  siteId: "11111111-1111-4111-8111-111111111111",
  gatewayId: "22222222-2222-4222-8222-222222222222"
};
const commandTopic = "sites/11111111-1111-4111-8111-111111111111/gateways/22222222-2222-4222-8222-222222222222/commands/registration-removal";
const ackTopic = "sites/11111111-1111-4111-8111-111111111111/gateways/22222222-2222-4222-8222-222222222222/commands/registration-removal-ack";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function assembledFixture() {
  const root = await mkdtemp(join(tmpdir(), "removal-production-")); roots.push(root);
  const mappings = new BioDeviceMappingStore(join(root, "mappings.json"), () => removalNow);
  await mappings.reserve(mappingInput); await mappings.confirm(mappingInput.deviceUuid, mappingInput.logicalAddress);
  const journal = new FixtureRegistrationRemovalJournal(join(root, "removals.json")); await journal.initialize();
  const state = new FileAutomationStateStore(join(root, "automation.json")); await state.initialize();
  const survivor = "88888888-8888-4888-8888-888888888888";
  await state.updateDurable(value => {
    for (const key of ["currentByFixture", "baseBrightnessByFixture", "lastDesiredByFixture"] as const) {
      value[key][mappingInput.fixtureId] = 30; value[key][survivor] = 70;
    }
    return value;
  });
  const groups = new GroupStateStore(join(root, "groups.json")); await groups.initialize();
  const group = { groupId: "99999999-9999-4999-8999-999999999999", groupAddress: "0xc001", version: 1 };
  await groups.writeConfiguring(group);
  await groups.writeReady(group, [{ meshNodeId: mappingInput.nodeId, meshAddress: removalCommand().meshAddress },
    { meshNodeId: survivor, meshAddress: "0x0101" }]);
  const idle = () => vi.fn(async (): Promise<string | null> => null);
  const options = { journal, port: mappings, scope: removalScope, clockTrusted: async () => true, now: () => removalNow,
    automationRuntime: { registrationRemovalBlocked: false, currentSnapshot: null },
    scheduleRuntime: { pendingObservationFixtureIds: vi.fn((): string[] => []) },
    sensorOperationsInProgress: vi.fn(() => false),
    adapter: { registrationRemovalBlocker: vi.fn((): string | null => null), forgetRegistration: vi.fn() },
    fixtureIdentify: { registrationRemovalBlocker: vi.fn((): string | null => null) }, groups, state,
    commandJournals: [{ registrationRemovalBlocker: idle() }, { registrationRemovalBlocker: idle() }, { registrationRemovalBlocker: idle() }],
    provisioningJournal: { registrationRemovalBlocker: idle() },
    bioSensors: { registrationRemovalBlocker: idle(), monitor: { retire: vi.fn() } },
    capabilities: { invalidateCommissionProofs: vi.fn() }, resync: { markObserved: vi.fn() } };
  const services = createGatewayRegistrationRemovalServices(options);
  const source = {} as GatewayMqttClient;
  const command = async (receipt = vi.fn()) => {
    await services.topicHandlers[commandTopic](Buffer.from(JSON.stringify(removalCommand())), source, undefined,
      { acknowledgeDurable: receipt });
    return (await journal.records())[0].terminal!;
  };
  return { root, mappings, journal, state, groups, group, options, services, source, command, survivor };
}

function subscriptionClient() {
  const subscriptions = new Map<string, number>();
  const client = {
    subscribe(topics: string[], options: { qos: number }, done: (error: Error | null) => void) {
      for (const topic of topics) subscriptions.set(topic, options.qos);
      done(null);
    }
  } as unknown as Pick<MqttClient, "subscribe">;
  return { client, subscriptions };
}

describe("registration removal production MQTT wiring", () => {
  it("dispatches the production factory command through durable cleanup, reconnect replay and exact application ACK", async () => {
    const f = await assembledFixture(), receipt = vi.fn();
    const captured = (await f.mappings.findByFixtureId(mappingInput.fixtureId))!;
    const events: Array<{ topic: string; value: FixtureRegistrationRemovalTerminal }> = [];
    const publish = async (topic: string, value: FixtureRegistrationRemovalTerminal) => { events.push({ topic, value }); };
    try {
      const terminal = await f.command(receipt);
      expect(receipt).toHaveBeenCalledTimes(1);
      expect(terminal.status).toBe("removed");
      expect(f.options.adapter.forgetRegistration.mock.calls).toEqual([[mappingInput.fixtureId, mappingInput.deviceUuid]]);
      expect(f.options.bioSensors.monitor.retire.mock.calls).toEqual([[mappingInput.fixtureId]]);
      expect(f.options.capabilities.invalidateCommissionProofs).toHaveBeenCalledTimes(1);
      expect(f.options.resync.markObserved.mock.calls).toEqual([[mappingInput.fixtureId]]);
      expect(f.mappings.isRegistrationCurrent(captured)).toBe(false);
      expect(await new BioDeviceMappingStore(join(f.root, "mappings.json")).retirement(removalCommand())).not.toBeNull();
      const restoredGroups = new GroupStateStore(join(f.root, "groups.json"));
      expect(await restoredGroups.readAppliedMembers(f.group.groupId)).toEqual([{ meshNodeId: f.survivor, meshAddress: "0x0101" }]);
      const restoredState = new FileAutomationStateStore(join(f.root, "automation.json")); await restoredState.initialize();
      for (const key of ["currentByFixture", "baseBrightnessByFixture", "lastDesiredByFixture"] as const) {
        expect(restoredState.read()[key]).toEqual({ [f.survivor]: 70 });
      }
      f.services.handler.connect(publish); await f.services.handler.flush();
      f.services.handler.disconnect(); f.services.handler.connect(publish); await f.services.handler.flush();
      expect(events).toEqual(Array(2).fill({ topic: fixtureRegistrationRemovalTopics.terminal(removalScope.siteId, removalScope.gatewayId), value: terminal }));
      expect((await f.journal.records())[0].acknowledged).toBe(false);
      await f.services.topicHandlers[ackTopic](Buffer.from(JSON.stringify({ ...removalAck(terminal), resultHash: `sha256:${"0".repeat(64)}` })), f.source);
      expect((await f.journal.records())[0].acknowledged).toBe(false);
      await f.services.topicHandlers[ackTopic](Buffer.from(JSON.stringify(removalAck(terminal))), f.source);
      await f.services.handler.flush(); expect(events).toHaveLength(2);
      expect((await new FixtureRegistrationRemovalJournal(join(f.root, "removals.json")).records())[0].acknowledged).toBe(true);
      expect(await f.command()).toEqual(terminal);
      expect(f.options.adapter.forgetRegistration).toHaveBeenCalledTimes(1);
    } finally { await f.services.handler.stopAndDrain(); }
  });

  it.each(["automation", "sensor", "observation", "adapter", "identify", "group", "commandJournal", "sensorJournal", "revalidationJournal", "provisioning", "bioSensor"] as const)(
    "preserves mapping and cleanup state on production %s busy refusal", async busy => {
      const f = await assembledFixture();
      let expected = "CONTROL_IN_PROGRESS";
      if (busy === "automation") { f.options.automationRuntime.registrationRemovalBlocked = true; expected = "AUTOMATION_SYNC_IN_PROGRESS"; }
      else if (busy === "sensor") { f.options.sensorOperationsInProgress.mockReturnValue(true); expected = "SENSOR_OPERATION_IN_PROGRESS"; }
      else if (busy === "observation") { f.options.scheduleRuntime.pendingObservationFixtureIds.mockReturnValue([mappingInput.fixtureId]); expected = "CONTROL_UNCERTAIN"; }
      else if (busy === "adapter") f.options.adapter.registrationRemovalBlocker.mockReturnValue(expected);
      else if (busy === "identify") f.options.fixtureIdentify.registrationRemovalBlocker.mockReturnValue(expected);
      else if (busy === "group") { await f.groups.writeConfiguring(f.group); expected = "GROUP_SYNC_IN_PROGRESS"; }
      else if (busy === "provisioning") f.options.provisioningJournal.registrationRemovalBlocker.mockResolvedValue(expected);
      else if (busy === "bioSensor") f.options.bioSensors.registrationRemovalBlocker.mockResolvedValue(expected);
      else f.options.commandJournals[["commandJournal", "sensorJournal", "revalidationJournal"].indexOf(busy)].registrationRemovalBlocker.mockResolvedValue(expected);
      const before = f.state.read(), members = await f.groups.readAppliedMembers(f.group.groupId);
      try {
        expect(await f.command()).toMatchObject({ status: "rejected", errorCode: expected });
        expect(await f.mappings.findByFixtureId(mappingInput.fixtureId)).not.toBeNull();
        expect(await f.mappings.retirement(removalCommand())).toBeNull();
        expect(f.state.read()).toEqual(before);
        expect(await f.groups.readAppliedMembers(f.group.groupId)).toEqual(members);
        expect(f.options.adapter.forgetRegistration).not.toHaveBeenCalled();
        expect(f.options.bioSensors.monitor.retire).not.toHaveBeenCalled();
        expect(f.options.capabilities.invalidateCommissionProofs).not.toHaveBeenCalled();
        expect(f.options.resync.markObserved).not.toHaveBeenCalled();
      } finally { await f.services.handler.stopAndDrain(); }
    });

  it("advertises heartbeat version 1 only for the guarded BIO production path", () => {
    const mappings = new BioDeviceMappingStore("unused-software-only");
    const dimming = new BioUsbDongleAdapter({} as never, mappings);
    expect(gatewayRegistrationRemovalVersion({ dimming, bioSensorHardware: { mappings } as never })).toBe(1);
    expect(gatewayRegistrationRemovalVersion({ dimming })).toBeUndefined();
    expect(gatewayRegistrationRemovalVersion({ dimming, bioSensorHardware: { mappings: {} } as never })).toBeUndefined();
    expect(gatewayRegistrationRemovalVersion({ dimming: {} as never, bioSensorHardware: { mappings } as never })).toBeUndefined();
  });
  it("routes removal commands through the production command dispatcher", () => {
    expect(gatewayCommandTopics(assignment.siteId, assignment.gatewayId)).toContain(commandTopic);
  });

  it("defers removal command PUBACK until the durable intake boundary", () => {
    expect(gatewayDeferredPubackTopics(assignment.siteId, assignment.gatewayId)).toContain(commandTopic);
  });

  it.each([false, true])("subscribes removal commands at QoS 1 with sessionPresent=%s", async sessionPresent => {
    const { client, subscriptions } = subscriptionClient();
    await subscribeGatewayCommands(client, assignment, sessionPresent);
    expect(subscriptions.get(commandTopic)).toBe(1);
  });

  it.each([false, true])("subscribes exact application ACKs at QoS 1 with sessionPresent=%s", async sessionPresent => {
    const { client, subscriptions } = subscriptionClient();
    await subscribeGatewayAcknowledgements(client, assignment, sessionPresent);
    expect(subscriptions.get(ackTopic)).toBe(1);
  });

  it("restores removal ACK delivery in the persistent command-session subscription path", async () => {
    const { client, subscriptions } = subscriptionClient();
    await subscribeGatewayCommands(client, assignment, true);
    expect(subscriptions.get(ackTopic)).toBe(1);
  });
});
