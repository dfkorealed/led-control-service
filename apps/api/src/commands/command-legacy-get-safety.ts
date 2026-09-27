import { Prisma } from "@prisma/client";
import { CommandSafetyDigest, CommandSafetyKeyUnavailableError } from "./command-safety-digest";

const LEGACY_GET_DOMAIN = "legacy-status-check-global";
const LEGACY_GET_PRINCIPAL = "__legacy_global__";

/**
 * The old CommandDispatch.clientRequestId constraint is global, not scoped to
 * principal/site. A keyed marker must keep that exact collision boundary once
 * the raw dispatch is physically deleted. It carries no response or payload.
 */
export async function hasLegacyGetReplayFence(
  tx: Prisma.TransactionClient, digest: CommandSafetyDigest, clientRequestId: string
): Promise<boolean> {
  const versions = digest.signAll(LEGACY_GET_DOMAIN, [clientRequestId]);
  if (await tx.commandReplayFence.count({ where: {
    domain: LEGACY_GET_DOMAIN,
    keyVersion: { notIn: versions.map(row => row.keyVersion) }
  } }) > 0) throw new CommandSafetyKeyUnavailableError("command safety HMAC key unavailable");
  return !!await tx.commandReplayFence.findFirst({ where: {
    domain: LEGACY_GET_DOMAIN, principalSnapshot: LEGACY_GET_PRINCIPAL,
    OR: versions.map(row => ({ keyDigest: row.value, keyVersion: row.keyVersion }))
  }, select: { id: true } });
}

/**
 * Called under the shared command mutation lock before a disposable purge.
 * Late Get ACKs are owned only for broker PUBACK/drain; they are not accepted
 * as partial physical evidence after the original dispatch/results disappear.
 */
export async function stageLegacyGetSafetyForCommand(
  tx: Prisma.TransactionClient, commandId: string, siteId: string,
  digest: CommandSafetyDigest
): Promise<number> {
  const dispatches = await tx.commandDispatch.findMany({ where: {
    commandId, kind: "status_check"
  }, orderBy: [{ verificationAttempt: "asc" }, { id: "asc" }], include: { fixtureResults: true } });
  if (!dispatches.length) return 0;
  const keyVersions = digest.signAll(LEGACY_GET_DOMAIN, ["version-preflight"])
    .map(row => row.keyVersion);
  if (await tx.commandReplayFence.count({ where: {
    domain: LEGACY_GET_DOMAIN, keyVersion: { notIn: keyVersions }
  } }) > 0 || await tx.legacyStatusCheckDispatchFence.count({ where: {
    keyVersion: { notIn: keyVersions }
  } }) > 0) throw new CommandSafetyKeyUnavailableError("command safety HMAC key unavailable");
  const groups = new Map<number, typeof dispatches>();
  for (const dispatch of dispatches) {
    const attempt = dispatch.verificationAttempt;
    if (!attempt || attempt < 1 || attempt > 3 || dispatch.fixtureResults.length === 0
      || dispatch.fixtureResults.length > 64
      || new Set(dispatch.fixtureResults.map(row => row.fixtureId)).size !== dispatch.fixtureResults.length) {
      throw new Error("legacy status-check dispatch snapshot invalid");
    }
    const group = groups.get(attempt) ?? [];
    group.push(dispatch);
    groups.set(attempt, group);
  }
  for (const group of groups.values()) {
    const owners = group.filter(row => row.clientRequestId);
    if (owners.length !== 1) throw new Error("legacy status-check request key owner invalid");
    const key = owners[0].clientRequestId!;
    const versions = digest.signAll(LEGACY_GET_DOMAIN, [key]);
    const existing = await tx.commandReplayFence.findFirst({ where: {
      domain: LEGACY_GET_DOMAIN, principalSnapshot: LEGACY_GET_PRINCIPAL,
      OR: versions.map(row => ({ keyDigest: row.value, keyVersion: row.keyVersion }))
    }, select: { siteId: true } });
    if (existing && existing.siteId !== siteId) {
      throw new Error("legacy status-check global key owner mismatch");
    }
    if (!existing) {
      const signed = digest.sign(LEGACY_GET_DOMAIN, [key]);
      await tx.commandReplayFence.create({ data: { siteId,
        principalSnapshot: LEGACY_GET_PRINCIPAL, domain: LEGACY_GET_DOMAIN,
        keyDigest: signed.value, keyVersion: signed.keyVersion } });
    }
  }
  for (const dispatch of dispatches) {
    const versions = digest.signAll("legacy-status-check-dispatch", [dispatch.id]);
    const existing = await tx.legacyStatusCheckDispatchFence.findFirst({ where: {
      OR: versions.map(row => ({ dispatchDigest: row.value, keyVersion: row.keyVersion }))
    }, select: { siteId: true } });
    if (existing && existing.siteId !== siteId) throw new Error("legacy status-check dispatch owner mismatch");
    if (!existing) {
      const signed = digest.sign("legacy-status-check-dispatch", [dispatch.id]);
      await tx.legacyStatusCheckDispatchFence.create({ data: {
        siteId, dispatchDigest: signed.value, keyVersion: signed.keyVersion
      } });
    }
  }
  return Math.max(...groups.keys());
}
