import { isDeepStrictEqual } from "node:util";
import { temporaryControlIngestedReceiptSchema, temporaryControlResultSchema,
  type TemporaryControlResult, type TemporaryControlIngestedReceipt } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import type { FileAutomationStateStore, PersistedAutomationStateV10 } from "./automation-state-store";

export class TemporaryControlResultOutbox {
  constructor(private readonly store: FileAutomationStateStore,
    private readonly scope: { siteId: string; gatewayId: string; assignmentVersion: number },
    private readonly currentRestoration: (result: TemporaryControlResult, state: PersistedAutomationStateV10) => boolean = () => false) {}

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
      const known = state.temporarySessions[result.sessionId], knownRow = known?.targets[result.fixtureId];
      if (known?.state === "rejected" && knownRow && !knownRow.configurationMayHaveChanged &&
        knownRow.applyResult?.rfWriteEvidence === "not_started" && isDeepStrictEqual(knownRow.releaseResult, result)) {
        if (receipt.status === "applied") {
          knownRow.releaseAcknowledged = true;
          if (lease?.sessionId === null && isDeepStrictEqual(lease.identity, knownRow.snapshot)) lease.phase = "cancelled";
          if (Object.values(known.targets).every(row => row.releaseAcknowledged)) known.state = "cancelled";
        }
        return state;
      }
      if (lease?.sessionId !== result.sessionId || lease.lastGeneration !== result.targetGeneration) return state;
      const session = state.temporarySessions[result.sessionId];
      if (!session) {
        const proof = state.temporaryEndProofs[result.sessionId]?.[result.fixtureId];
        if (receipt.status === "applied" && isDeepStrictEqual(proof, result)) {
          lease.sessionId = null; lease.phase = "cancelled";
        }
        // A rejected end-only event cannot later be accepted. Keep its minimal
        // RF0 proof; a later release can mint a fresh proof under the same fence.
        return state;
      }
      const row = session.targets[result.fixtureId];
      if (!row || row.releaseAcknowledged || !isDeepStrictEqual(row.releaseResult, result)) return state;
      const unchanged = !row.configurationMayHaveChanged && result.rfWriteEvidence === "not_started";
      if (receipt.status === "applied" && (unchanged || (result.releaseConfirmed && this.currentRestoration(result, state)))) {
        row.releaseAcknowledged = true; lease.sessionId = null; lease.phase = unchanged ? "cancelled" : "restored";
        if (Object.values(session.targets).every(target => target.releaseAcknowledged)) {
          session.state = Object.values(session.targets).some(target => target.releaseConfirmed) ? "restored" : "cancelled";
        }
      } else {
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
