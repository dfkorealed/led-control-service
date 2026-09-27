import { z } from "zod";
import { mqttTopicsV2 } from "./gateway-contracts";

const scopedNonceSchema = z.object({
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  nonce: z.string().uuid()
}).strict();

const publishEpochSchema = z.number().positive().refine(Number.isSafeInteger, "publishEpoch must be a safe integer");
const commandCountSchema = z.number().nonnegative().refine(Number.isSafeInteger, "count must be a safe integer");

export const commandClockRequestSchema = scopedNonceSchema;
export const commandClockResponseSchema = scopedNonceSchema.extend({
  publishEpoch: publishEpochSchema,
  dbNow: z.string().datetime({ offset: false }).refine((value) => value.endsWith("Z"), "dbNow must be UTC ISO")
}).strict();

export const commandDrainRequestSchema = scopedNonceSchema.extend({
  publishEpoch: publishEpochSchema
}).strict();
// Counts describe conservative Gateway work state; none certifies physical RF completion.
export const commandDrainResponseSchema = commandDrainRequestSchema.extend({
  gatewayVersion: z.string().min(1),
  bootId: z.string().uuid(),
  queuedCount: commandCountSchema,
  submittedCount: commandCountSchema,
  unconfirmedCount: commandCountSchema
}).strict();

export type CommandClockRequest = z.infer<typeof commandClockRequestSchema>;
export type CommandClockResponse = z.infer<typeof commandClockResponseSchema>;
export type CommandDrainRequest = z.infer<typeof commandDrainRequestSchema>;
export type CommandDrainResponse = z.infer<typeof commandDrainResponseSchema>;

type CommandSafetyTopicKind = "clock-request" | "clock-response" | "drain-request" | "drain-response";

// Payload validation cannot authenticate the MQTT topic; consumers must compare both scopes.
export function matchesCommandSafetyTopicScope(
  topic: string,
  kind: CommandSafetyTopicKind,
  scope: { siteId: string; gatewayId: string }
): boolean {
  switch (kind) {
    case "clock-request": return topic === mqttTopicsV2.commandClockRequest(scope.siteId, scope.gatewayId);
    case "clock-response": return topic === mqttTopicsV2.commandClockResponse(scope.siteId, scope.gatewayId);
    case "drain-request": return topic === mqttTopicsV2.commandDrainRequest(scope.siteId, scope.gatewayId);
    case "drain-response": return topic === mqttTopicsV2.commandDrainResponse(scope.siteId, scope.gatewayId);
  }
}
