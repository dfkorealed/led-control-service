import { z } from "zod";
import { bioRegistrationRevalidationCanonicalJson } from "./bio-registration-revalidation-contracts.js";

export const FIXTURE_REGISTRATION_REMOVAL_TTL_MS = 30_000;
const id = z.string().uuid();
const timestamp = z.string().datetime({ precision: 3 });
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

export const fixtureRegistrationRemovalStatusSchema = z.enum([
  "pending", "gateway_confirmed", "completed", "rejected", "reconcile_required"
]);
export const fixtureRegistrationRemovalRequestSchema = z.object({
  clientRequestId: id, expectedUpdatedAt: timestamp
}).strict();
export const fixtureRegistrationRemovalPreviewSchema = z.object({
  fixtureId: id, fixtureName: z.string().min(1), serialNumber: z.string().nullable(), expectedUpdatedAt: timestamp,
  allowed: z.boolean(), blockedReasons: z.array(z.object({ code: errorCode, message: z.string().min(1) }).strict())
}).strict().refine(value => value.allowed === (value.blockedReasons.length === 0), "allowed must agree with blockedReasons");
export const fixtureRegistrationRemovalViewSchema = z.object({
  operationId: id, siteId: id, floorId: id, fixtureId: id, status: fixtureRegistrationRemovalStatusSchema,
  errorCode: errorCode.nullable(), createdAt: timestamp, completedAt: timestamp.nullable()
}).strict().refine(value => (value.status === "completed") === (value.completedAt !== null), "completed requires completedAt");

const identity = {
  version: z.literal(1), operationId: id, siteId: id, gatewayId: id,
  gatewaySerial: z.string().min(1).max(128).refine(value => value.trim() === value && value.length > 0),
  assignmentVersion: z.number().int().positive().max(2_147_483_647), fixtureId: id, nodeId: id,
  deviceUuid: z.string().regex(/^bio:[0-9a-f]{12}$/),
  meshAddress: z.string().regex(/^0x[0-7][0-9a-f]{3}$/).refine(value => value !== "0x0000"),
  originalProvisionCommandId: id, bindingHash: hash
};
const command = z.object({ ...identity, requestedAt: timestamp, expiresAt: timestamp }).strict();
function boundedLifetime(value: { requestedAt: string; expiresAt: string }) {
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.requestedAt);
  return ttl > 0 && ttl <= FIXTURE_REGISTRATION_REMOVAL_TTL_MS;
}
export const fixtureRegistrationRemovalCommandSchema = command.refine(boundedLifetime, "removal lifetime must be 1..30000ms");
export const fixtureRegistrationRemovalTerminalSchema = command.extend({
  commandHash: hash, eventId: id, occurredAt: timestamp,
  status: z.enum(["removed", "rejected", "reconcile_required"]), errorCode: errorCode.nullable()
}).strict().refine(boundedLifetime, "removal lifetime must be 1..30000ms")
  .refine(value => Date.parse(value.occurredAt) >= Date.parse(value.requestedAt), "terminal cannot precede its command")
  .refine(value => (value.status === "removed") === (value.errorCode === null), "only removed has a null errorCode");
export const fixtureRegistrationRemovalAckSchema = z.object({
  ...identity, commandHash: hash, eventId: id, resultHash: hash, ingestedAt: timestamp,
  status: z.enum(["ingested", "duplicate"])
}).strict();

export type FixtureRegistrationRemovalStatus = z.infer<typeof fixtureRegistrationRemovalStatusSchema>;
export type FixtureRegistrationRemovalRequest = z.infer<typeof fixtureRegistrationRemovalRequestSchema>;
export type FixtureRegistrationRemovalPreview = z.infer<typeof fixtureRegistrationRemovalPreviewSchema>;
export type FixtureRegistrationRemovalView = z.infer<typeof fixtureRegistrationRemovalViewSchema>;
export type FixtureRegistrationRemovalCommand = z.infer<typeof fixtureRegistrationRemovalCommandSchema>;
export type FixtureRegistrationRemovalTerminal = z.infer<typeof fixtureRegistrationRemovalTerminalSchema>;
export type FixtureRegistrationRemovalAck = z.infer<typeof fixtureRegistrationRemovalAckSchema>;

// The command hash is computed over the complete command, never over a terminal
// or a self-referential commandHash field. Registration generation stays bound.
export const fixtureRegistrationRemovalCanonicalJson = bioRegistrationRevalidationCanonicalJson;
/** nodeId is the original provisioning candidate ID, NOT the Cloud MeshNode ID. */
export function fixtureRegistrationRemovalBindingIdentity(command: FixtureRegistrationRemovalCommand) {
  const { version, siteId, gatewayId, gatewaySerial, assignmentVersion, fixtureId, nodeId,
    deviceUuid, meshAddress, originalProvisionCommandId } = command;
  return { version, siteId, gatewayId, gatewaySerial, assignmentVersion, fixtureId, nodeId,
    deviceUuid, meshAddress, originalProvisionCommandId };
}
export type FixtureRegistrationRemovalBindingIdentity = ReturnType<typeof fixtureRegistrationRemovalBindingIdentity>;

export function matchesFixtureRegistrationRemovalAck(
  terminal: FixtureRegistrationRemovalTerminal, ack: FixtureRegistrationRemovalAck, resultHash: string
): boolean {
  const keys = [...Object.keys(identity), "commandHash", "eventId"] as
    (keyof FixtureRegistrationRemovalTerminal & keyof FixtureRegistrationRemovalAck)[];
  return keys.every(key => terminal[key] === ack[key]) && ack.resultHash === resultHash;
}
function topic(siteId: string, gatewayId: string, suffix: string) {
  return `sites/${id.parse(siteId)}/gateways/${id.parse(gatewayId)}/${suffix}`;
}
export const fixtureRegistrationRemovalTopics = {
  command: (siteId: string, gatewayId: string) => topic(siteId, gatewayId, "commands/registration-removal"),
  terminal: (siteId: string, gatewayId: string) => topic(siteId, gatewayId, "events/registration-removal"),
  ack: (siteId: string, gatewayId: string) => topic(siteId, gatewayId, "commands/registration-removal-ack")
};
