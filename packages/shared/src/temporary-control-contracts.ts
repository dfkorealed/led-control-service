import { z } from "zod";
import { dimmingTargetSchema } from "./dimming-command.js";

const id = z.string().uuid();
const instant = z.string().datetime();
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonnegativeInteger = z.number().int().nonnegative().safe();
const positiveInteger = z.number().int().positive().safe();
const generation = z.string().regex(/^[1-9][0-9]*$/);
const brightness = z.number().int().min(0).max(100);
const reason = z.string().trim().min(1).nullable();
const sessionRevision = z.union([z.literal(1), z.literal(2)]);
const state = z.enum(["pending", "applying", "holding", "partial", "unknown", "releasing", "restored", "recovery_pending", "rejected", "cancelled"]);
const issue = (context: z.RefinementCtx, message: string, path: (string | number)[] = []) => context.addIssue({ code: "custom", message, path });

export const temporaryControlCreateSchema = z.object({ clientRequestId: id, target: dimmingTargetSchema,
  brightness, durationMinutes: z.number().int().min(1).max(1440) }).strict();
export const temporaryControlEndSchema = z.object({ clientRequestId: id }).strict();
export const temporaryFixtureSnapshotSchema = z.object({ fixtureId: id, meshNodeId: id,
  // BIO uses a six-byte native identity; it is distinct from the legacy Mesh UUID.
  nativeUuid: z.string().regex(/^[0-9a-f]{12}$/),
  logicalAddress: z.string().regex(/^0x[0-7][0-9a-f]{3}$/).refine(value => value !== "0x0000"),
  applyGeneration: generation, releaseGeneration: generation
}).strict().superRefine((target, context) => {
  if (/^[1-9][0-9]*$/.test(target.applyGeneration) && /^[1-9][0-9]*$/.test(target.releaseGeneration)
    && BigInt(target.releaseGeneration) !== BigInt(target.applyGeneration) + 1n) issue(context, "reserved release generation must immediately follow apply", ["releaseGeneration"]);
});
function validateTargets(targets: z.infer<typeof temporaryFixtureSnapshotSchema>[], context: z.RefinementCtx) {
  for (const key of ["fixtureId", "meshNodeId", "nativeUuid", "logicalAddress"] as const) {
    if (new Set(targets.map(target => target[key])).size !== targets.length) issue(context, `targets require unique ${key}`, ["targets"]);
  }
}
const targets = z.array(temporaryFixtureSnapshotSchema).min(1).max(1000);
const wire = { schemaVersion: z.literal(1), sessionId: id, sessionRevision, siteId: id, gatewayId: id,
  assignmentVersion: positiveInteger, admissionRevision: nonnegativeInteger, sequence: nonnegativeInteger, payloadHash: hash };
const admission = { sessionId: id, siteId: id, gatewayId: id, assignmentVersion: positiveInteger,
  admissionRevision: nonnegativeInteger, originCommandHash: hash, originSequence: nonnegativeInteger };
const start = z.object({ ...wire, kind: z.literal("start"), sessionRevision: z.literal(1), targets, brightness,
  startedAt: instant, endsAt: instant }).strict();
const end = z.object({ ...wire, kind: z.literal("end"), sessionRevision: z.literal(2), targets,
  originCommandHash: hash, originSequence: nonnegativeInteger, endsAt: instant }).strict();
export const temporaryControlCommandSchema = z.discriminatedUnion("kind", [start, end]).superRefine((command, context) => {
  validateTargets(command.targets, context);
  if (command.kind === "start") {
    const duration = Date.parse(command.endsAt) - Date.parse(command.startedAt);
    if (duration < 60000 || duration > 86400000 || duration % 60000 !== 0) issue(context, "start requires 1 to 1440 whole minutes", ["endsAt"]);
  }
});
export const bioConfigurationReadbackSchema = z.object({ configuredHighBrightnessPercent: brightness,
  bioMode: z.enum(["sensor", "force-on", "force-off"]) }).strict();
const evidence = { fixtureId: id, applyConfirmed: z.boolean(), releaseConfirmed: z.boolean(),
  configurationMayHaveChanged: z.boolean(), partialMutation: z.enum(["none", "high_brightness", "mode", "unverified"]),
  configurationReadback: bioConfigurationReadbackSchema.nullable(), rfWriteEvidence: z.enum(["not_started", "may_have_written", "observed"]), reason };
export const temporaryTargetEvidenceSchema = z.object(evidence).strict();
export const temporaryControlResultSchema = z.object({ ...admission, ...evidence, schemaVersion: z.literal(1), eventId: id,
  sessionRevision, kind: z.enum(["apply", "release", "observation"]), targetGeneration: generation,
  restorationRevision: nonnegativeInteger.nullable(), restorationPayloadHash: hash.nullable(), observedAt: instant, resultHash: hash
}).strict().superRefine((result, context) => {
  if ((result.kind === "apply" && result.sessionRevision !== 1) || (result.kind === "release" && result.sessionRevision !== 2)) issue(context, "result kind and revision mismatch", ["sessionRevision"]);
  if ((result.restorationRevision === null) !== (result.restorationPayloadHash === null)) issue(context, "restoration revision and hash must be paired");
  if (result.kind === "apply" && (result.releaseConfirmed || result.restorationRevision !== null)) issue(context, "apply cannot confirm restoration");
  if (result.partialMutation !== "none" && !result.configurationMayHaveChanged) issue(context, "partial mutation must preserve configuration uncertainty");
  if (result.rfWriteEvidence === "not_started" && (result.configurationMayHaveChanged || result.partialMutation !== "none")) issue(context, "no RF write cannot claim mutation");
  if (result.applyConfirmed || result.releaseConfirmed) {
    if (result.configurationReadback === null || result.rfWriteEvidence !== "observed" || result.partialMutation !== "none") issue(context, "confirmation requires complete observed configuration readback");
  }
  if (result.releaseConfirmed && (result.sessionRevision !== 2 || result.restorationRevision === null)) issue(context, "release confirmation requires current restoration attribution");
});
export const temporaryControlIngestedReceiptSchema = z.object({ ...admission, schemaVersion: z.literal(1), eventId: id,
  sessionRevision, targetGeneration: generation, resultHash: hash, status: z.enum(["applied", "rejected"]), reason, ingestedAt: instant
}).strict().superRefine((receipt, context) => {
  if ((receipt.status === "applied" && receipt.reason !== null) || (receipt.status === "rejected" && receipt.reason === null)) issue(context, "receipt status requires matching reason");
});
export const temporaryControlViewSchema = z.object({ id, siteId: id, gatewayId: id, state, sessionRevision,
  now: instant, startedAt: instant, endsAt: instant, brightness: brightness.nullable(),
  targets: z.array(temporaryFixtureSnapshotSchema).max(1000), results: z.array(temporaryControlResultSchema), reason,
  detailsRedacted: z.boolean()
}).strict().superRefine((view, context) => {
  if (Date.parse(view.endsAt) <= Date.parse(view.startedAt)) issue(context, "end must follow start");
  if (view.detailsRedacted) {
    if (view.brightness !== null || view.targets.length !== 0 || view.results.length !== 0) issue(context, "redacted details must be empty");
    if (!["restored", "rejected", "cancelled"].includes(view.state)) issue(context, "unresolved details cannot be redacted");
    return;
  }
  if (view.targets.length === 0 || view.brightness === null) issue(context, "unredacted view requires immutable targets and brightness");
  validateTargets(view.targets, context);
  const byFixture = new Map(view.targets.map(target => [target.fixtureId, target]));
  if (new Set(view.results.map(result => result.eventId)).size !== view.results.length) issue(context, "result event identities must be unique");
  view.results.forEach((result, index) => {
    const target = byFixture.get(result.fixtureId);
    const expectedGeneration = result.sessionRevision === 1 ? target?.applyGeneration : target?.releaseGeneration;
    if (result.sessionId !== view.id || result.siteId !== view.siteId || result.gatewayId !== view.gatewayId
      || result.targetGeneration !== expectedGeneration || result.sessionRevision > view.sessionRevision) issue(context, "result scope/generation must match immutable session", ["results", index]);
    const origin = view.results[0];
    if (result.assignmentVersion !== origin.assignmentVersion || result.admissionRevision !== origin.admissionRevision
      || result.originCommandHash !== origin.originCommandHash || result.originSequence !== origin.originSequence) {
      issue(context, "session results must preserve one immutable admission", ["results", index]);
    }
  });
  const latest = (fixtureId: string, revision: 1 | 2) => view.results.filter(result => result.fixtureId === fixtureId && result.sessionRevision === revision)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  if (view.state === "holding" && view.targets.some(target => {
    const result = latest(target.fixtureId, 1);
    return !result?.applyConfirmed || result.configurationReadback?.configuredHighBrightnessPercent !== view.brightness
      || result.configurationReadback?.bioMode !== (view.brightness === 0 ? "force-off" : "force-on");
  })) issue(context, "holding requires every target's requested configuration readback");
  if (["restored", "rejected", "cancelled"].includes(view.state) && view.targets.some(target => {
    const result = latest(target.fixtureId, view.sessionRevision);
    // A release that sent no RF cannot erase a possibly mutated start. Only a
    // whole unchanged history or a confirmed restoration settles that lease.
    const unchanged = view.results.filter(entry => entry.fixtureId === target.fixtureId).every(entry =>
      !entry.configurationMayHaveChanged && entry.partialMutation === "none" && entry.rfWriteEvidence === "not_started");
    return !result || !(unchanged || (view.state === "restored" && result.releaseConfirmed));
  })) issue(context, "terminal state requires restoration or proven unchanged evidence for every target");
});
export const temporaryControlListQuerySchema = z.object({ state: state.optional(), cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20) }).strict();
export const temporaryControlListResponseSchema = z.object({ items: z.array(temporaryControlViewSchema).max(100), nextCursor: z.string().min(1).nullable() }).strict();

export type Generation = z.infer<typeof generation>;
export type TemporaryControlState = z.infer<typeof state>;
export type CreateTemporaryControlInput = z.infer<typeof temporaryControlCreateSchema>;
export type EndTemporaryControlInput = z.infer<typeof temporaryControlEndSchema>;
export type TemporaryFixtureSnapshot = z.infer<typeof temporaryFixtureSnapshotSchema>;
export type WireIdentity = z.infer<z.ZodObject<typeof wire>>;
export type SessionAdmissionIdentity = z.infer<z.ZodObject<typeof admission>>;
export type StartTemporaryControlCommand = z.infer<typeof start>;
export type EndTemporaryControlCommand = z.infer<typeof end>;
export type TemporaryControlCommand = z.infer<typeof temporaryControlCommandSchema>;
export type BioConfigurationReadback = z.infer<typeof bioConfigurationReadbackSchema>;
export type TemporaryTargetEvidence = z.infer<typeof temporaryTargetEvidenceSchema>;
export type TemporaryControlResult = z.infer<typeof temporaryControlResultSchema>;
export type TemporaryControlIngestedReceipt = z.infer<typeof temporaryControlIngestedReceiptSchema>;
export type TemporaryControlView = z.infer<typeof temporaryControlViewSchema>;
export type TemporaryControlListQuery = z.input<typeof temporaryControlListQuerySchema>;
export type TemporaryControlListResponse = z.infer<typeof temporaryControlListResponseSchema>;
