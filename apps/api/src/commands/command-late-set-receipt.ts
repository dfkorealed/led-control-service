import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CommandSafetyDigest } from "./command-safety-digest";

/**
 * Protected pre-purge staging only. The caller must hold the shared command
 * mutation lock and use the same transaction as its eventual Command purge.
 * A missing or mismatched dispatch/target aborts the entire candidate; no
 * guessed Gateway status or partial receipt is acceptable.
 */
export async function stageLateSetReceiptsForHold(
  tx: Prisma.TransactionClient, holdId: string, digest: CommandSafetyDigest
): Promise<number> {
  const hold = await tx.unresolvedCommandHold.findUnique({ where: { id: holdId }, include: { targets: true } });
  if (!hold || hold.targets.length === 0) throw unavailable();
  const command = await tx.command.findUnique({ where: { id: hold.originalCommandId },
    include: { dispatches: { include: { fixtureResults: true } } } });
  if (!command || command.siteId !== hold.siteId || command.createdAt.getTime() !== hold.originalCreatedAt.getTime()
    || command.outcome !== "unknown") throw unavailable();
  const targetIds = hold.targets.map(row => row.fixtureId).sort();
  const commandTargets = Array.isArray(command.targetFixtureIds)
    ? command.targetFixtureIds.filter((id): id is string => typeof id === "string").sort() : [];
  if (new Set(targetIds).size !== targetIds.length
    || commandTargets.length !== targetIds.length
    || commandTargets.some((id, index) => id !== targetIds[index])
    || hold.targets.some(row => row.expectedBrightness !== command.brightness)) throw unavailable();
  const setDispatches = command.dispatches.filter(row => row.kind === "dimming");
  // Current Set writer emits one dimming dispatch per Command; legacy/future
  // multi-Set layouts need an aggregate ACK design before physical purge.
  if (setDispatches.length !== 1) throw unavailable();
  let created = 0;
  for (const dispatch of setDispatches) {
    const dispatchTargets = dispatch.fixtureResults.map(row => row.fixtureId).sort();
    if (dispatch.gatewayId !== hold.gatewayId || dispatchTargets.length !== targetIds.length
      || dispatchTargets.some((id, index) => id !== targetIds[index])) throw unavailable();
    const wire = [hold.siteId, hold.gatewayId, command.id,
      dispatch.id, dispatch.idempotencyKey, String(dispatch.sequence)];
    const existing = await tx.lateSetReceipt.findUnique({ where: { originalDispatchId: dispatch.id } });
    if (existing) {
      if (existing.holdId !== hold.id || !digest.verify("late-set-wire", wire,
        { keyVersion: existing.keyVersion, value: existing.wireDigest })
        || JSON.stringify(existing.targetFixtureIds) !== JSON.stringify(targetIds)) throw unavailable();
      continue;
    }
    const signed = digest.sign("late-set-wire", wire);
    await tx.lateSetReceipt.create({ data: { holdId: hold.id, originalDispatchId: dispatch.id,
      keyVersion: signed.keyVersion, wireDigest: signed.value, targetFixtureIds: targetIds } });
    created += 1;
  }
  return created;
}

/** Transfer ACK ownership before cascading away active receipts with a hold.
 * The marker is a keyed dispatch lookup only; it cannot reconstruct the old
 * Command, wire payload, target list, or physical result. It stays until the
 * site is explicitly deleted because an offline Gateway may retry indefinitely.
 */
export async function stageTerminalSetFences(
  tx: Prisma.TransactionClient, holdId: string, siteId: string, digest: CommandSafetyDigest
): Promise<number> {
  const hold = await tx.unresolvedCommandHold.findUnique({ where: { id: holdId },
    include: { targets: true } });
  const receipts = await tx.lateSetReceipt.findMany({ where: { holdId } });
  // One Set dispatch is the current wire contract. Unknown multi-dispatch
  // legacy layouts remain blocked from purge until aggregate late-ACK support
  // exists; a partial marker must never allow the hold to disappear.
  if (!hold || hold.siteId !== siteId || hold.targets.length === 0 || receipts.length !== 1) throw unavailable();
  for (const receipt of receipts) {
    const versions = digest.signAll("late-set-dispatch", [receipt.originalDispatchId]);
    const targets = Array.isArray(receipt.targetFixtureIds)
      ? receipt.targetFixtureIds.filter((id): id is string => typeof id === "string").sort() : [];
    const expected = hold.targets.map(row => row.fixtureId).sort();
    if (!versions.some(row => row.keyVersion === receipt.keyVersion)
      || targets.length !== expected.length || targets.some((id, index) => id !== expected[index])) throw unavailable();
    const existing = await tx.lateSetTerminalFence.findFirst({ where: {
      dispatchDigest: { in: versions.map(row => row.value) }
    } });
    if (existing) {
      if (existing.siteId !== siteId || !versions.some(row =>
        row.keyVersion === existing.keyVersion && row.value === existing.dispatchDigest)) throw unavailable();
      continue;
    }
    const signed = digest.sign("late-set-dispatch", [receipt.originalDispatchId]);
    await tx.lateSetTerminalFence.create({ data: { siteId,
      dispatchDigest: signed.value, keyVersion: signed.keyVersion } });
  }
  return receipts.length;
}

function unavailable() {
  return new ServiceUnavailableException({ code: "late_set_receipt_unverifiable" });
}
