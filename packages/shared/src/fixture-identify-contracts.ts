import { z } from "zod";

export const FIXTURE_IDENTIFY_TTL_MS = 10_000;
const id = z.string().uuid();
const timestamp = z.string().datetime({ precision: 3 });
const action = z.enum(["start", "stop"]);
export const fixtureIdentifyRequestSchema = z.object({
  action,
  leaseToken: z.string().min(1).max(256),
  leaseFence: z.number().int().positive().max(2_147_483_647),
  sessionId: id.optional()
}).strict().refine((value) => value.action !== "stop" || value.sessionId !== undefined, {
  message: "stop requires sessionId", path: ["sessionId"]
});

const envelope = z.object({
  version: z.literal(1), commandId: id, sessionId: id, fixtureId: id, siteId: id, gatewayId: id,
  action, requestedAt: timestamp, expiresAt: timestamp
}).strict();
function boundedLifetime(value: { requestedAt: string; expiresAt: string }) {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.requestedAt);
  return duration > 0 && duration <= FIXTURE_IDENTIFY_TTL_MS;
}
export const fixtureIdentifyCommandSchema = envelope.refine(boundedLifetime, "identify lifetime must be 1..10000ms");
export const fixtureIdentifyResultSchema = envelope.extend({
  status: z.enum(["attention_confirmed", "stopped", "timed_out", "rejected"]),
  reportedAt: timestamp,
  attentionSeconds: z.number().int().min(0).max(10).optional(),
  reason: z.string().min(1).max(128).optional()
}).strict().refine(boundedLifetime, "identify lifetime must be 1..10000ms")
  .refine((value) => {
    if (value.status === "attention_confirmed") return value.action === "start" && (value.attentionSeconds ?? 0) > 0;
    if (value.status === "stopped") return value.action === "stop" && value.attentionSeconds === 0;
    return value.attentionSeconds === undefined && value.reason !== undefined;
  }, "result must describe an actual Attention response or explicit failure");
export const fixtureIdentifyResponseSchema = z.object({
  commandId: id, sessionId: id, fixtureId: id, action, expiresAt: timestamp,
  dispatchStatus: z.enum(["broker_accepted", "unconfirmed"]),
  status: z.enum(["attention_confirmed", "stopped", "timed_out", "rejected", "dispatch_failed"]),
  reason: z.string().min(1).max(128).optional()
}).strict();
export type FixtureIdentifyRequest = z.infer<typeof fixtureIdentifyRequestSchema>;
export type FixtureIdentifyCommand = z.infer<typeof fixtureIdentifyCommandSchema>;
export type FixtureIdentifyResult = z.infer<typeof fixtureIdentifyResultSchema>;
export type FixtureIdentifyResponse = z.infer<typeof fixtureIdentifyResponseSchema>;
const topicSegment = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const fixtureIdentifyTopics = {
  command: (siteId: string, gatewayId: string) => `sites/${topicSegment.parse(siteId)}/gateways/${topicSegment.parse(gatewayId)}/commands/identify`,
  result: (siteId: string, gatewayId: string) => `sites/${topicSegment.parse(siteId)}/gateways/${topicSegment.parse(gatewayId)}/events/identify-result`
};
