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
        assertOperationPlan(command.desiredMembers, appliedMembers, command.expectedOperations);
        result = meshGroupSubscriptionResultSchema.parse(await this.adapter.syncGroupSubscriptions(command, appliedMembers));
        assertResultIdentity(command, result);
        assertResultOperations(command.expectedOperations, result.operations);
        const nextAppliedMembers = applySuccessfulOperations(appliedMembers, result.operations);
        if (result.operations.every((operation) => operation.status === "ready")) await this.stateStore.writeReady(identity, nextAppliedMembers);
        else await this.stateStore.writeFailed(identity, nextAppliedMembers);
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

function assertOperationPlan(
  desiredMembers: Array<{ meshNodeId: string; meshAddress: string }>,
  appliedMembers: Array<{ meshNodeId: string; meshAddress: string }>,
  operations: Array<{ action: "add" | "delete"; meshNodeId: string; meshAddress: string }>
) {
  const desired = new Set(desiredMembers.map(memberKey));
  const applied = new Set(appliedMembers.map(memberKey));
  const residual = new Set([
    ...desiredMembers.filter((member) => !applied.has(memberKey(member))).map((member) => `add:${memberKey(member)}`),
    ...appliedMembers.filter((member) => !desired.has(memberKey(member))).map((member) => `delete:${memberKey(member)}`)
  ]);
  const planned = new Set(operations.map(operationKey));
  const includesResidual = [...residual].every((operation) => planned.has(operation));
  const containsOnlySafeOperations = operations.every((operation) => {
    const key = memberKey(operation);
    return operation.action === "add" ? desired.has(key) : !desired.has(key);
  });
  if (planned.size !== operations.length || !includesResidual || !containsOnlySafeOperations) {
    throw new Error("mesh group subscription operation diff mismatch");
  }
}

function assertResultOperations(
  expectedOperations: Array<{ operationId: string; action: "add" | "delete"; meshNodeId: string; meshAddress: string }>,
  operations: Array<{ operationId: string; action: "add" | "delete"; meshNodeId: string; meshAddress: string }>
) {
  const expected = new Set(expectedOperations.map(exactOperationKey));
  const actual = new Set(operations.map(exactOperationKey));
  if (expected.size !== expectedOperations.length || actual.size !== operations.length || expected.size !== actual.size || [...expected].some((operation) => !actual.has(operation))) {
    throw new Error("mesh group subscription operation result mismatch");
  }
}

function applySuccessfulOperations(
  appliedMembers: Array<{ meshNodeId: string; meshAddress: string }>,
  operations: Array<{ action: "add" | "delete"; meshNodeId: string; meshAddress: string; status: "ready" | "failed" }>
) {
  const members = new Map(appliedMembers.map((member) => [memberKey(member), normalizeMember(member)]));
  for (const operation of operations) {
    if (operation.status !== "ready") continue;
    const member = normalizeMember(operation);
    if (operation.action === "add") members.set(memberKey(member), member);
    else members.delete(memberKey(member));
  }
  // A failed old-address delete can coexist with a successful new-address add. Keep both pair identities
  // so the next desired-state diff retries only the physical subscription that still remains.
  return [...members.values()].sort((left, right) => memberKey(left).localeCompare(memberKey(right)));
}

function normalizeMember(member: { meshNodeId: string; meshAddress: string }) {
  return { meshNodeId: member.meshNodeId, meshAddress: member.meshAddress.toLowerCase() };
}

function memberKey(member: { meshNodeId: string; meshAddress: string }) {
  return `${member.meshNodeId}:${member.meshAddress.toLowerCase()}`;
}

function operationKey(operation: { action: "add" | "delete"; meshNodeId: string; meshAddress: string }) {
  return `${operation.action}:${memberKey(operation)}`;
}

function exactOperationKey(operation: { operationId: string; action: "add" | "delete"; meshNodeId: string; meshAddress: string }) {
  return `${operation.operationId}:${operationKey(operation)}`;
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
