import { z } from "zod";
import { bioRegistrationRevalidationCanonicalJson } from "./bio-registration-revalidation-contracts.js";

const byteSchema = z.number().int().min(0).max(255);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const payloadHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const bioSensorFingerprintV1Schema = z.object({
  deviceType: byteSchema,
  firmware: z.object({ major: byteSchema, minor: byteSchema, revision: byteSchema,
    build: z.number().int().min(0).max(65535) }).strict(),
  sensorType: byteSchema,
  infraredType: byteSchema,
  ambientLightType: byteSchema,
  hardwareType: byteSchema
}).strict();

export const bioSensorProfileV1Schema = z.object({
  profileId: z.string().uuid(),
  revision: positiveSafeIntegerSchema,
  status: z.enum(["approved", "revoked"]),
  fingerprint: bioSensorFingerprintV1Schema,
  bodyHexes: z.array(z.string().regex(/^[0-9a-f]{16}$/)).min(1).refine(values => new Set(values).size === values.length,
    "exact sensor bodies must be unique"),
  linkPolicy: z.object({ kind: z.literal("mode-get"), probeIntervalMs: positiveSafeIntegerSchema,
    maxAgeMs: positiveSafeIntegerSchema }).strict().refine(value => value.maxAgeMs >= value.probeIntervalMs,
    "link maximum age must cover the probe interval"),
  evidenceDigest: payloadHashSchema,
  reuseScope: z.string().trim().min(1)
}).strict();

const executionPolicySchema = z.object({
  enabled: z.boolean(),
  ownerUserId: z.string().uuid().nullable().default(null),
  maximumResponseSeconds: positiveSafeIntegerSchema.nullable().default(null),
  escalationAction: z.string().trim().min(1).nullable().default(null)
}).strict().superRefine((value, context) => {
  if (value.enabled && (value.ownerUserId === null || value.maximumResponseSeconds === null || value.escalationAction === null)) {
    context.addIssue({ code: "custom", message: "enabled execution requires an owner and response policy" });
  }
});

export const bioSensorCatalogV1Schema = z.object({
  schemaVersion: z.literal(1),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  eventId: z.string().uuid(),
  assignmentVersion: positiveSafeIntegerSchema,
  catalogRevision: positiveSafeIntegerSchema,
  issuedAt: z.string().datetime({ offset: true }),
  profiles: z.array(bioSensorProfileV1Schema).refine(values => new Set(values.map(value => value.profileId)).size === values.length,
    "catalog profile IDs must be unique"),
  executionPolicy: executionPolicySchema.default({ enabled: false, ownerUserId: null,
    maximumResponseSeconds: null, escalationAction: null })
}).strict();

export const bioSensorCatalogAckV1Schema = z.object({
  schemaVersion: z.literal(1),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  assignmentVersion: positiveSafeIntegerSchema,
  eventId: z.string().uuid(),
  catalogRevision: positiveSafeIntegerSchema,
  deliveryPayloadHash: payloadHashSchema,
  status: z.enum(["applied", "duplicate", "stale", "rejected"]),
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export type BioSensorFingerprintV1 = z.infer<typeof bioSensorFingerprintV1Schema>;
export type BioSensorProfileV1 = z.infer<typeof bioSensorProfileV1Schema>;
export type BioSensorCatalogV1 = z.infer<typeof bioSensorCatalogV1Schema>;
export type BioSensorCatalogAckV1 = z.infer<typeof bioSensorCatalogAckV1Schema>;

/** Fixed discovery field order is the matching key, not a manufacturer model or health claim. */
export function canonicalBioSensorFingerprint(value: unknown): string {
  return JSON.stringify(bioSensorFingerprintV1Schema.parse(value));
}

export const bioSensorFingerprint = canonicalBioSensorFingerprint;

export function bioFirmwareFingerprint(value: unknown): string {
  const { major, minor, revision, build } = bioSensorFingerprintV1Schema.parse(value).firmware;
  return `${major}.${minor}.${revision}.${build}`;
}

export function bioProfileKey(value: BioSensorProfileV1): string {
  const profile = bioSensorProfileV1Schema.parse(value);
  return `${profile.profileId}@${profile.revision}`;
}

// Preserve the existing JSON wire normalization and browser-safe sorting algorithm.
export const bioSensorCatalogCanonicalJson = bioRegistrationRevalidationCanonicalJson;

/** Match transport attribution only. Even an applied receipt is not live sensor qualification.
 * The caller supplies its SHA-256 of the complete catalog envelope, not its profile list. */
export function matchesBioSensorCatalogAckV1(catalog: unknown, acknowledgement: unknown, expectedDeliveryPayloadHash: string): boolean {
  const parsedCatalog = bioSensorCatalogV1Schema.safeParse(catalog);
  const parsedAck = bioSensorCatalogAckV1Schema.safeParse(acknowledgement);
  if (!parsedCatalog.success || !parsedAck.success || !payloadHashSchema.safeParse(expectedDeliveryPayloadHash).success) return false;
  const value = parsedCatalog.data;
  const ack = parsedAck.data;
  return value.siteId === ack.siteId && value.gatewayId === ack.gatewayId && value.eventId === ack.eventId
    && value.assignmentVersion === ack.assignmentVersion && value.catalogRevision === ack.catalogRevision
    && ack.deliveryPayloadHash === expectedDeliveryPayloadHash;
}

export const bioSensorCatalogTopics = {
  command: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/commands/bio-sensor-catalog`,
  ack: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/events/bio-sensor-catalog-ack`
};
