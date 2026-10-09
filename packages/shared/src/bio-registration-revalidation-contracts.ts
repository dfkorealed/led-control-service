import { z } from "zod";

const identity = {
  version: z.literal(2),
  purpose: z.literal("bio_registration_revalidation"),
  operation: z.literal("query"),
  commandId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  fixtureId: z.string().uuid(),
  nodeId: z.string().uuid(),
  assignmentVersion: z.number().int().positive(),
  deviceIdentityHash: z.string().regex(/^[0-9a-f]{64}$/),
  meshAddress: z.string().regex(/^0x[0-7][0-9a-f]{3}$/).refine((value) => value !== "0x0000")
};
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const bioRegistrationRevalidationRequestSchema = z.object({
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  fixtureId: z.string().uuid(),
  expectedAssignmentVersion: z.number().int().positive(),
  clientRequestId: z.string().uuid()
}).strict();

export const bioRegistrationRevalidationCommandSchema = z.object({
  ...identity,
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict().superRefine((value, context) => {
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.requestedAt);
  if (ttl <= 0 || ttl > 30_000) {
    context.addIssue({ code: "custom", message: "registration revalidation requires a bounded 30 second lifetime" });
  }
});

const resultEnvelope = {
  ...identity,
  eventId: z.string().uuid(),
  sequence: sequenceSchema,
  occurredAt: z.string().datetime()
};

// A current mode GET is neither historical registration completion nor sensor/health qualification.
export const bioRegistrationRevalidationResultSchema = z.union([
  z.object({
    ...resultEnvelope,
    status: z.literal("observed"),
    evidence: z.literal("mode_get"),
    observedMode: z.enum(["sensor", "force-on", "force-off"])
  }).strict(),
  z.object({
    ...resultEnvelope,
    status: z.enum(["unknown", "timed_out"]),
    errorCode: z.enum([
      "MODE_GET_UNCONFIRMED", "COMMAND_EXPIRED", "GATEWAY_RESTART",
      "UNSUPPORTED_ADAPTER", "GATEWAY_SHUTDOWN", "GATEWAY_CLOCK_UNTRUSTED"
    ])
  }).strict()
]);

export const bioRegistrationRevalidationAckSchema = z.object({
  ...identity,
  eventId: z.string().uuid(),
  sequence: sequenceSchema,
  payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  ingestedAt: z.string().datetime(),
  status: z.enum(["ingested", "duplicate", "stale_checkpoint"])
}).strict();

export type BioRegistrationRevalidationRequest = z.infer<typeof bioRegistrationRevalidationRequestSchema>;
export type BioRegistrationRevalidationCommand = z.infer<typeof bioRegistrationRevalidationCommandSchema>;
export type BioRegistrationRevalidationResult = z.infer<typeof bioRegistrationRevalidationResultSchema>;
export type BioRegistrationRevalidationAck = z.infer<typeof bioRegistrationRevalidationAckSchema>;

export const bioRegistrationRevalidationTopics = {
  command: (siteId: string, gatewayId: string): string =>
    `sites/${siteId}/gateways/${gatewayId}/commands/bio-registration-revalidation`,
  result: (siteId: string, gatewayId: string): string =>
    `sites/${siteId}/gateways/${gatewayId}/events/bio-registration-revalidation-result`,
  ack: (siteId: string, gatewayId: string): string =>
    `sites/${siteId}/gateways/${gatewayId}/acks/bio-registration-revalidation-result`
};

/** Canonicalize JSON wire values before consumers compute their SHA-256 payload hash. */
export function bioRegistrationRevalidationCanonicalJson(value: unknown): string {
  // Normalize through JSON first so undefined fields, toJSON and array holes retain JSON semantics.
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("registration revalidation payload must be a JSON value");
  const serialize = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(serialize).join(",")}]`;
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      // Write sorted entries directly: JSON.stringify on an object would reorder integer-like keys.
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(item);
  };
  return serialize(JSON.parse(json));
}

export function matchesBioRegistrationRevalidationAck(
  result: BioRegistrationRevalidationResult,
  ack: BioRegistrationRevalidationAck,
  resultPayloadHash: string
): boolean {
  const keys = [...Object.keys(identity), "eventId", "sequence"] as (keyof BioRegistrationRevalidationAck & keyof BioRegistrationRevalidationResult)[];
  return keys.every((key) => result[key] === ack[key]) && ack.payloadHash === resultPayloadHash;
}
