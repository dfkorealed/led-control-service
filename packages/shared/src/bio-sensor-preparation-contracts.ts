import { z } from "zod";
import { bioSensorFingerprintV1Schema } from "./bio-sensor-profile-contracts";
import { bioRegistrationRevalidationCanonicalJson } from "./bio-registration-revalidation-contracts";

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const payloadHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const operationSchema = z.enum(["query", "ensure_sensor"]);
const scope = {
  schemaVersion: z.literal(1),
  commandId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  fixtureId: z.string().uuid(),
  nodeId: z.string().uuid(),
  assignmentVersion: positiveSafeIntegerSchema
};
const commandIdentity = {
  ...scope,
  deviceIdentityHash: z.string().regex(/^[0-9a-f]{64}$/),
  meshAddress: z.string().regex(/^0x[0-7][0-9a-f]{3}$/).refine(value => value !== "0x0000"),
  operation: operationSchema,
  catalogRevision: positiveSafeIntegerSchema
};
const profileKeySchema = z.string().superRefine((value, context) => {
  const parts = value.split("@");
  if (parts.length !== 2 || !z.string().uuid().safeParse(parts[0]).success || !/^[1-9][0-9]*$/.test(parts[1])
    || !positiveSafeIntegerSchema.safeParse(Number(parts[1])).success) {
    context.addIssue({ code: "custom", message: "profile key must identify an exact UUID and safe revision" });
  }
});

export const bioSensorPreparationRequestV1Schema = z.object({
  siteId: z.string().uuid(), fixtureId: z.string().uuid(), clientRequestId: z.string().uuid(), operation: operationSchema
}).strict();

export const bioSensorPreparationCommandV1Schema = z.object({
  ...commandIdentity,
  requestedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, context) => {
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.requestedAt);
  if (ttl <= 0 || ttl > 120_000) context.addIssue({ code: "custom", message: "preparation requires a bounded 120 second lifetime" });
});

export const bioSensorPreparationReportV1Schema = z.object({
  ...commandIdentity,
  eventId: z.string().uuid(),
  commandPayloadHash: payloadHashSchema,
  fingerprint: bioSensorFingerprintV1Schema.nullable(),
  profileKey: profileKeySchema.nullable(),
  connectionGeneration: positiveSafeIntegerSchema,
  observedAt: z.string().datetime({ offset: true }),
  status: z.enum(["ready", "needs_setup", "unverified", "degraded", "unsupported", "failed"]),
  modeVerified: z.boolean(),
  linkVerified: z.boolean(),
  errorCode: z.string().trim().min(1).nullable()
}).strict().superRefine((value, context) => {
  // Structural evidence never grants support: consumers must also verify current
  // binding, approved catalog revision, observation freshness and execution policy.
  if (value.status === "ready" && (value.fingerprint === null || value.profileKey === null || !value.modeVerified || !value.linkVerified)) {
    context.addIssue({ code: "custom", message: "ready preparation requires fingerprint, profile and mode/link evidence" });
  }
});

export const bioSensorPreparationAckV1Schema = z.object({
  ...scope,
  eventId: z.string().uuid(),
  reportPayloadHash: payloadHashSchema,
  status: z.enum(["applied", "duplicate", "stale", "rejected"]),
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export type BioSensorPreparationRequestV1 = z.infer<typeof bioSensorPreparationRequestV1Schema>;
export type BioSensorPreparationCommandV1 = z.infer<typeof bioSensorPreparationCommandV1Schema>;
export type BioSensorPreparationReportV1 = z.infer<typeof bioSensorPreparationReportV1Schema>;
export type BioSensorPreparationAckV1 = z.infer<typeof bioSensorPreparationAckV1Schema>;

// Both directions hash the complete parsed wire envelope with the existing serializer.
export const bioSensorPreparationCanonicalJson = bioRegistrationRevalidationCanonicalJson;

/** Validate full-command attribution; freshness and device authority remain consumer checks. */
export function matchesBioSensorPreparationReportV1(command: unknown, report: unknown, expectedCommandPayloadHash: string): boolean {
  const parsedCommand = bioSensorPreparationCommandV1Schema.safeParse(command);
  const parsedReport = bioSensorPreparationReportV1Schema.safeParse(report);
  if (!parsedCommand.success || !parsedReport.success || !payloadHashSchema.safeParse(expectedCommandPayloadHash).success) return false;
  const keys = Object.keys(commandIdentity) as Array<keyof typeof commandIdentity>;
  return keys.every(key => parsedCommand.data[key] === parsedReport.data[key])
    && parsedReport.data.commandPayloadHash === expectedCommandPayloadHash;
}

/** A matched ACK proves receipt attribution, including rejected receipts, never readiness. */
export function matchesBioSensorPreparationAckV1(report: unknown, acknowledgement: unknown, expectedReportPayloadHash: string): boolean {
  const parsedReport = bioSensorPreparationReportV1Schema.safeParse(report);
  const parsedAck = bioSensorPreparationAckV1Schema.safeParse(acknowledgement);
  if (!parsedReport.success || !parsedAck.success || !payloadHashSchema.safeParse(expectedReportPayloadHash).success) return false;
  const keys = Object.keys(scope) as Array<keyof typeof scope>;
  return keys.every(key => parsedReport.data[key] === parsedAck.data[key])
    && parsedReport.data.eventId === parsedAck.data.eventId && parsedAck.data.reportPayloadHash === expectedReportPayloadHash;
}

export const bioSensorPreparationTopics = {
  command: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/commands/bio-sensor-preparation`,
  result: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/events/bio-sensor-preparation-result`,
  ack: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/events/bio-sensor-preparation-result-ack`
};
