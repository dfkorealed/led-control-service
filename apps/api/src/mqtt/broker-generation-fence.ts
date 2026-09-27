import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Supplied by deployment/CA inventory, never discovered from responding nodes.
 * Certificate lists cover ALL credentials for the retired generation on each
 * node, including offline/removed publishers. Empty/partial inventories fail.
 */
export interface BrokerFenceCensus {
  generation: number;
  source: "deployment-inventory";
  complete: boolean;
  revision: string;
  nodes: { nodeId: string; bootId: string; retiredCertificateFingerprints: string[] }[];
}

export interface BrokerFenceChallenge {
  generation: number;
  nonce: string;
  inventoryRevision: string;
}

/** Adapter observations are trusted only inside a disposable fault harness.
 * Counts cover both publisher state and subscriber queues holding retired Set
 * packets. A disconnected publisher says nothing about offline Gateway queues.
 */
export interface BrokerNodeFenceObservation extends BrokerFenceChallenge {
  nodeId: string;
  bootId: string;
  revokedCertificateFingerprints: string[];
  irreversibleRevocation: boolean;
  sessionInventoryComplete: boolean;
  activeConnections: number;
  persistentSessions: number;
  queuedMessages: number;
  freshPublishDenied: boolean;
  admissionMinimumGeneration: number;
  rollback: {
    restartDenied: boolean;
    oldAclDenied: boolean;
    oldCrlDenied: boolean;
    oldAclAndCrlDenied: boolean;
    minimumGenerationAfterRollback: number;
    revocationLedgerPreserved: boolean;
  };
}

export interface BrokerFenceAdapter {
  readonly kind: "stock-mosquitto" | "disposable";
  collect(challenge: BrokerFenceChallenge): Promise<BrokerNodeFenceObservation[]>;
}

/** Stock ACL/CRL, PUBACK denial and client.end() cannot attest antirollback.
 * There is intentionally no production success adapter or enable flag here.
 */
export class StockMosquittoFenceAdapter implements BrokerFenceAdapter {
  readonly kind = "stock-mosquitto" as const;
  async collect(): Promise<BrokerNodeFenceObservation[]> { return []; }
}

type UnavailableReason = "invalid_generation" | "immutable_admission_unavailable" | "census_unavailable"
  | "census_changed" | "node_evidence_invalid" | "evidence_stale" | "verification_timeout" | "adapter_unavailable";

export type BrokerFenceEvidence = Readonly<{
  status: "unavailable"; generation: number; reason: UnavailableReason; productionPurgeAllowed: false;
}> | Readonly<{
  status: "verified"; scope: "disposable"; productionPurgeAllowed: false;
  generation: number; inventoryRevision: string; nodeIds: readonly string[];
  nonce: string; digest: string;
  // Process-local freshness only. Never persist these as cross-restart proof.
  verifiedAtMonotonicMs: number; expiresAtMonotonicMs: number;
}>;

interface BrokerFenceOptions {
  adapter?: BrokerFenceAdapter;
  census?: (generation: number) => Promise<BrokerFenceCensus>;
  monotonicNow?: () => number;
  maxVerificationMs?: number;
}

export class BrokerGenerationFence {
  constructor(private readonly options: BrokerFenceOptions = {}) {}

  async verifyRetired(generation: number): Promise<BrokerFenceEvidence> {
    const unavailable = (reason: UnavailableReason): BrokerFenceEvidence => Object.freeze({
      status: "unavailable", generation, reason, productionPurgeAllowed: false
    });
    if (!positiveInteger(generation)) return unavailable("invalid_generation");
    const adapter = this.options.adapter ?? new StockMosquittoFenceAdapter();
    // Even a caller attaching seemingly valid JSON to a stock broker must not
    // bypass the absent immutable admission/CA trust boundary.
    if (adapter.kind !== "disposable") return unavailable("immutable_admission_unavailable");
    const inventory = this.options.census;
    if (!inventory) return unavailable("census_unavailable");
    const maxMs = this.options.maxVerificationMs ?? 1000;
    if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > 10_000) return unavailable("evidence_stale");
    const now = this.options.monotonicNow ?? (() => performance.now());
    let timer: NodeJS.Timeout | undefined;
    try {
      const startedAt = now();
      if (!Number.isFinite(startedAt) || startedAt < 0) return unavailable("evidence_stale");
      const verify = async (): Promise<BrokerFenceEvidence> => {
        const census = structuredClone(await inventory(generation));
        if (!validCensus(census) || census.generation !== generation) return unavailable("census_unavailable");
        const before = censusKey(census);
        const challenge = Object.freeze({ generation, nonce: randomUUID(), inventoryRevision: census.revision });
        const nodes = structuredClone(await adapter.collect(challenge));
        if (!Array.isArray(nodes) || nodes.length !== census.nodes.length
          || new Set(nodes.map(node => node?.nodeId)).size !== nodes.length
          || !census.nodes.every(expected => validNode(nodes.find(node => node?.nodeId === expected.nodeId), expected, challenge))) {
          return unavailable("node_evidence_invalid");
        }
        // A rollout, new credential, or broker restart during collection makes
        // the entire proof unusable; never shrink the census to live responders.
        const after = structuredClone(await inventory(generation));
        if (!validCensus(after) || censusKey(after) !== before) return unavailable("census_changed");
        const completedAt = now();
        if (!Number.isFinite(completedAt) || completedAt < startedAt || completedAt - startedAt >= maxMs) {
          return unavailable("evidence_stale");
        }
        const ordered = nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
        const digest = createHash("sha256").update(JSON.stringify({ census: before, challenge, nodes: ordered })).digest("hex");
        return Object.freeze({ status: "verified", scope: "disposable", productionPurgeAllowed: false,
          ...challenge, nodeIds: Object.freeze(ordered.map(node => node.nodeId)), digest,
          verifiedAtMonotonicMs: completedAt, expiresAtMonotonicMs: startedAt + maxMs });
      };
      return await Promise.race([verify(), new Promise<BrokerFenceEvidence>(resolve => {
        timer = setTimeout(() => resolve(unavailable("verification_timeout")), maxMs);
      })]);
    } catch {
      // Adapter errors can include URLs/credentials. Expose only a bounded code.
      return unavailable("adapter_unavailable");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function positiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function fingerprints(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))
    && new Set(value).size === value.length;
}

function validCensus(census: BrokerFenceCensus): boolean {
  return census?.source === "deployment-inventory" && census.complete === true && nonempty(census.revision)
    && Array.isArray(census.nodes) && census.nodes.length > 0
    && census.nodes.every(node => node && nonempty(node.nodeId) && nonempty(node.bootId) && fingerprints(node.retiredCertificateFingerprints))
    && new Set(census.nodes.map(node => node.nodeId)).size === census.nodes.length;
}

function censusKey(census: BrokerFenceCensus): string {
  return JSON.stringify({ generation: census.generation, revision: census.revision, nodes: census.nodes.map(node => ({
    nodeId: node.nodeId, bootId: node.bootId, certificates: [...node.retiredCertificateFingerprints].sort()
  })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)) });
}

function validNode(node: BrokerNodeFenceObservation | undefined, expected: BrokerFenceCensus["nodes"][number],
  challenge: BrokerFenceChallenge): boolean {
  if (!node || node.bootId !== expected.bootId || node.generation !== challenge.generation
    || node.nonce !== challenge.nonce || node.inventoryRevision !== challenge.inventoryRevision) return false;
  if (!fingerprints(node.revokedCertificateFingerprints)
    || node.revokedCertificateFingerprints.length !== expected.retiredCertificateFingerprints.length
    || !expected.retiredCertificateFingerprints.every(cert => node.revokedCertificateFingerprints.includes(cert))) return false;
  const rollback = node.rollback;
  return node.irreversibleRevocation === true && node.sessionInventoryComplete === true
    && node.activeConnections === 0 && node.persistentSessions === 0 && node.queuedMessages === 0
    && node.freshPublishDenied === true && positiveInteger(node.admissionMinimumGeneration)
    && node.admissionMinimumGeneration > challenge.generation
    && rollback?.restartDenied === true && rollback.oldAclDenied === true && rollback.oldCrlDenied === true
    && rollback.oldAclAndCrlDenied === true && rollback.revocationLedgerPreserved === true
    && positiveInteger(rollback.minimumGenerationAfterRollback)
    && rollback.minimumGenerationAfterRollback >= node.admissionMinimumGeneration;
}
