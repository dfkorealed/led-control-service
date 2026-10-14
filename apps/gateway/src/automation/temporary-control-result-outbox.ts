import { isDeepStrictEqual } from "node:util";
import { temporaryControlIngestedReceiptSchema, temporaryControlResultSchema,
  type TemporaryControlResult, type TemporaryControlIngestedReceipt } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import type { FileAutomationStateStore } from "./automation-state-store";

export class TemporaryControlResultOutbox {
  constructor(private readonly store: FileAutomationStateStore,
    private readonly scope: { siteId: string; gatewayId: string; assignmentVersion: number }) {}

  async pending(): Promise<TemporaryControlResult[]> {
    await this.store.initialize();
    return Object.values(this.store.read().temporaryResultOutbox).filter(result => this.inScope(result));
  }

  async persist(value: TemporaryControlResult): Promise<void> {
    const result = temporaryControlResultSchema.parse(value);
    const { resultHash, ...payload } = result;
    if (!this.inScope(result) || resultHash !== bioEnvelopeHash(payload)) throw new Error("temporary_result_invalid");
    await this.store.updateDurable(state => {
      const existing = state.temporaryResultOutbox[result.eventId];
      if (existing && !isDeepStrictEqual(existing, result)) throw new Error("temporary_result_conflict");
      state.temporaryResultOutbox[result.eventId] = result;
      return state;
    });
  }

  async confirm(value: TemporaryControlIngestedReceipt): Promise<boolean> {
    const receipt = temporaryControlIngestedReceiptSchema.parse(value);
    if (!this.inScope(receipt)) return false;
    let matched = false;
    await this.store.updateDurable(state => {
      const result = state.temporaryResultOutbox[receipt.eventId];
      if (!result || !sameReceipt(result, receipt)) return state;
      matched = true;
      delete state.temporaryResultOutbox[result.eventId];
      if (result.sessionRevision !== 2) return state;
      const lease = state.fixtureLeases[result.fixtureId];
      const session = state.temporarySessions[result.sessionId];
      if (!session) {
        const proof = state.temporaryEndProofs[result.sessionId]?.[result.fixtureId];
        if (receipt.status === "applied" && isDeepStrictEqual(proof, result) &&
          lease?.sessionId === result.sessionId && lease.lastGeneration === result.targetGeneration) {
          lease.sessionId = null; lease.phase = "cancelled";
        }
        // A rejected end-only event cannot later be accepted. Keep its minimal
        // RF0 proof; a later release can mint a fresh proof under the same fence.
        return state;
      }
      const row = session.targets[result.fixtureId];
      if (!row || row.releaseAcknowledged) return state;
      const unchanged = !row.configurationMayHaveChanged && result.rfWriteEvidence === "not_started";
      if (receipt.status === "applied" && result.kind === "release" && (unchanged || result.releaseConfirmed)) {
        // This exact retained event is immutable SERVER settlement, not a claim
        // about today's output. A newer local goal/result cannot revoke it. Keep
        // the accepted event as the acknowledged proof and hand current policy
        // back to ordinary automation; never reopen this old session afterwards.
        row.releaseResult = result; row.releaseConfirmed = result.releaseConfirmed;
        row.releaseAcknowledged = true; row.applyConfirmed = false; row.partialMutation = "none";
        const phase = unchanged ? "cancelled" : "restored";
        if (lease?.sessionId === result.sessionId && lease.lastGeneration === result.targetGeneration) {
          lease.sessionId = null; lease.phase = phase;
          delete state.lastDesiredByFixture[result.fixtureId];
        } else if (lease?.sessionId === null && lease.lastGeneration === result.targetGeneration && isDeepStrictEqual(lease.identity, row.snapshot)) {
          lease.phase = phase;
        }
        if (Object.values(session.targets).every(target => target.releaseAcknowledged)) {
          session.state = Object.values(session.targets).some(target => target.releaseConfirmed) ? "restored" : "cancelled";
        }
      } else if (isDeepStrictEqual(row.releaseResult, result) && lease?.sessionId === result.sessionId && lease.lastGeneration === result.targetGeneration) {
        row.releaseConfirmed = false; session.state = "recovery_pending";
        for (const target of Object.values(session.targets)) if (!target.releaseAcknowledged) state.fixtureLeases[target.snapshot.fixtureId]!.phase = session.state;
      }
      return state;
    });
    return matched;
  }

  private inScope(value: { siteId: string; gatewayId: string; assignmentVersion: number }) {
    return value.siteId === this.scope.siteId && value.gatewayId === this.scope.gatewayId && value.assignmentVersion === this.scope.assignmentVersion;
  }
}

function sameReceipt(result: TemporaryControlResult, receipt: TemporaryControlIngestedReceipt) {
  return (["schemaVersion", "eventId", "sessionId", "siteId", "gatewayId", "assignmentVersion", "admissionRevision", "originCommandHash",
    "originSequence", "sessionRevision", "targetGeneration", "resultHash"] as const).every(key => result[key] === receipt[key]);
}
