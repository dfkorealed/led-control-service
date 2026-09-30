import { z } from "zod";

const identity = {
  version: z.literal(2), commandId: z.string().uuid(), siteId: z.string().uuid(), gatewayId: z.string().uuid(),
  fixtureId: z.string().uuid(), nodeId: z.string().uuid(), assignmentVersion: z.number().int().positive(),
  deviceIdentityHash: z.string().regex(/^[0-9a-f]{64}$/),
  meshAddress: z.string().regex(/^0x[0-7][0-9a-f]{3}$/).refine((value) => value !== "0x0000"),
  operation: z.enum(["ensure_sensor", "query"]), requeryOfCommandId: z.string().uuid().optional()
};
export const bioSensorModeRequestSchema = z.object({ siteId: z.string().uuid(), fixtureId: z.string().uuid(),
  clientRequestId: z.string().uuid(), operation: z.enum(["ensure_sensor", "query"]),
  requeryOfCommandId: z.string().uuid().optional() }).strict().refine((v) => !v.requeryOfCommandId || v.operation === "query");
export const bioSensorModeCommandSchema = z.object({ ...identity,
  requestedAt: z.string().datetime(), expiresAt: z.string().datetime()
}).strict().superRefine((value, context) => {
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.requestedAt);
  if (ttl <= 0 || ttl > 30_000) context.addIssue({ code: "custom", message: "sensor mode command requires a bounded 30 second lifetime" });
  if (value.requeryOfCommandId && (value.operation !== "query" || value.requeryOfCommandId === value.commandId)) {
    context.addIssue({ code: "custom", message: "requery requires a new read-only command identity" });
  }
});
const resultEnvelope = { ...identity, eventId: z.string().uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.string().datetime() };
// No brightness/power fields: even a verified sensor mode says nothing about optical output.
export const bioSensorModeResultSchema = z.union([
  z.object({ ...resultEnvelope, status: z.literal("verified"), modeVerified: z.literal(true), observedMode: z.literal("sensor"), evidence: z.literal("mode_get") }).strict(),
  z.object({ ...resultEnvelope, status: z.literal("mismatch"), modeVerified: z.literal(false), observedMode: z.enum(["force-on", "force-off"]), evidence: z.literal("mode_get") }).strict(),
  z.object({ ...resultEnvelope, status: z.enum(["unknown", "timed_out"]), modeVerified: z.literal(false),
    errorCode: z.enum(["MODE_GET_UNCONFIRMED", "COMMAND_EXPIRED", "GATEWAY_RESTART", "UNSUPPORTED_ADAPTER", "GATEWAY_SHUTDOWN", "GATEWAY_CLOCK_UNTRUSTED"]) }).strict()
]);
export const bioSensorModeTopics = {
  command: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/commands/bio-sensor-mode`,
  result: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/events/bio-sensor-mode-result`
};
export type BioSensorModeCommand = z.infer<typeof bioSensorModeCommandSchema>;
export type BioSensorModeResult = z.infer<typeof bioSensorModeResultSchema>;
export type BioSensorModeRequest = z.infer<typeof bioSensorModeRequestSchema>;
