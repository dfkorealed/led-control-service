import {
  meshGroupSubscriptionSyncSchema,
  meshGroupSubscriptionResultSchema,
  mqttTopics
} from "@led-control/shared";
import type { BleMeshAdapter } from "../gateway";
import type { GatewayMqttClient } from "../runtime/gateway-mqtt-runtime";
import type { GroupStateIdentity, GroupStateStore } from "./group-state-store";
import type { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

export class GroupSubscriptionHandler {
  constructor(
    private readonly adapter: Pick<BleMeshAdapter, "syncGroupSubscriptions">,
    private readonly scope: { siteId: string; gatewayId: string },
    private readonly stateStore: Pick<GroupStateStore, "readAppliedMembers" | "writeConfiguring" | "writeReady" | "writeFailed">,
    private readonly queue: Pick<KeyedSerialTaskQueue, "run">
  ) {}

  async handle(payload: Buffer, source: Pick<GatewayMqttClient, "publish">) {
    const command = meshGroupSubscriptionSyncSchema.parse(JSON.parse(payload.toString()));
    if (command.siteId !== this.scope.siteId || command.gatewayId !== this.scope.gatewayId) {
      throw new Error("mesh group subscription scope mismatch");
    }

    await this.queue.run(command.groupId, async () => {
      const appliedMembers = await this.stateStore.readAppliedMembers(command.groupId);
      const identity: GroupStateIdentity = {
        groupId: command.groupId,
        groupAddress: command.groupAddress,
        version: command.version
      };
      await this.stateStore.writeConfiguring(identity);
      let result;
      try {
        result = meshGroupSubscriptionResultSchema.parse(await this.adapter.syncGroupSubscriptions(command, appliedMembers));
        assertResultIdentity(command, result);
        assertResultOperations(command.desiredMembers, appliedMembers, result.operations);
        if (result.operations.every((operation) => operation.status === "ready")) await this.stateStore.writeReady(identity, command.desiredMembers);
        else await this.stateStore.writeFailed(identity);
      } catch (error) {
        await this.stateStore.writeFailed(identity).catch(() => undefined);
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        source.publish(
          mqttTopics.meshGroupSubscriptionResult(command.siteId, command.gatewayId),
          JSON.stringify(result),
          { qos: 1 },
          (error) => (error ? reject(error) : resolve())
        );
      });
    });
  }
}

function assertResultOperations(
  desiredMembers: Array<{ meshNodeId: string; meshAddress: string }>,
  appliedMembers: Array<{ meshNodeId: string; meshAddress: string }>,
  operations: Array<{ action: "add" | "delete"; meshNodeId: string }>
) {
  const desired = new Set(desiredMembers.map((member) => member.meshNodeId));
  const applied = new Set(appliedMembers.map((member) => member.meshNodeId));
  const expected = new Set([
    ...desiredMembers.filter((member) => !applied.has(member.meshNodeId)).map((member) => `add:${member.meshNodeId}`),
    ...appliedMembers.filter((member) => !desired.has(member.meshNodeId)).map((member) => `delete:${member.meshNodeId}`)
  ]);
  const actual = new Set(operations.map((operation) => `${operation.action}:${operation.meshNodeId}`));
  if (expected.size !== actual.size || [...expected].some((operation) => !actual.has(operation))) {
    throw new Error("mesh group subscription operation diff mismatch");
  }
}

function assertResultIdentity(
  command: { siteId: string; gatewayId: string; groupId: string; groupAddress: string; version: number },
  result: { siteId: string; gatewayId: string; groupId: string; groupAddress: string; version: number }
) {
  if (
    result.siteId !== command.siteId ||
    result.gatewayId !== command.gatewayId ||
    result.groupId !== command.groupId ||
    result.groupAddress.toLowerCase() !== command.groupAddress.toLowerCase() ||
    result.version !== command.version
  ) {
    throw new Error("mesh group subscription result identity mismatch");
  }
}
