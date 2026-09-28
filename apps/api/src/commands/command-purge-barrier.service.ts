import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import type { BrokerGenerationFence } from "../mqtt/broker-generation-fence";
import type { GatewayCommandDrainService } from "../mqtt/gateway-command-drain.service";
import { CommandPublishEpochService } from "../mqtt/command-publish-epoch.service";

interface BarrierOptions {
  broker: Pick<BrokerGenerationFence, "verifyRetired">;
  gateways: Pick<GatewayCommandDrainService, "verify">;
  monotonicNow?: () => number;
}
type Snapshot = { generation: number; status: string; fencedAt: Date; dbNow: Date; cutoff: Date;
  primaryId: string; continuityId: string; healthy: boolean; clockDigest: string;
  memberDigest: string; memberCount: number; missingMembers: number };
export type PurgeBarrierProof = Record<typeof PROOF_FIELDS[number], string>;
const PROOF_FIELDS = ["generation", "workerBootId", "primaryId", "continuityId", "memberDigest",
  "brokerDigest", "gatewayDigest", "clockDigest", "fencedAt", "maxExpiresAt", "cutoff", "dbSampleAt",
  "validUntil", "monotonicWaitMs", "minimumWaitMs"] as const;
export type BarrierResult = { ready: false; reason: string } | { ready: true; evidence: {
  generation: number; minimumWaitMs: number; monotonicWaitMs: number;
  productionPurgeAllowed: false; proof: PurgeBarrierProof } };

/** Dormant restricted-worker component. No Nest registration or production signer. */
export class CommandPurgeBarrier {
  readonly workerBootId = randomUUID();
  private observed: { broker: Awaited<ReturnType<BrokerGenerationFence["verifyRetired"]>>;
    gateway: Awaited<ReturnType<GatewayCommandDrainService["verify"]>> } | undefined;
  private wait: { key: string; started: number; dbStarted: number; lastMonotonic: number;
    minimumWaitMs: number; maximumExpiryMs: number } | undefined;
  private readonly invalidatedGenerations = new Set<number>();
  constructor(private readonly options: BarrierOptions) {}
  /** Collect outside a DB transaction: a publisher permit must not span broker/network waits. */
  async refresh(generation: number): Promise<void> {
    this.observed = undefined;
    try {
      const [broker, gateway] = await Promise.all([this.options.broker.verifyRetired(generation),
        this.options.gateways.verify(generation)]);
      this.observed = { broker, gateway };
    } catch { this.wait = undefined; }
  }

  /** Caller holds automation mutation -> exclusive publish permit until DELETE commits. */
  async assertReady(tx: Prisma.TransactionClient, generation: number): Promise<BarrierResult> {
    const blocked = (reason: string): BarrierResult => { this.wait = undefined; return { ready: false, reason }; };
    if (this.invalidatedGenerations.has(generation)) return blocked("barrier_continuity_reset");
    const now = this.options.monotonicNow?.() ?? performance.now();
    const observed = this.observed;
    if (!observed || observed.broker.status !== "verified" || observed.gateway.status !== "verified"
      || observed.broker.generation !== generation || observed.gateway.generation !== generation
      || !Number.isFinite(now) || [observed.broker, observed.gateway].some(evidence =>
        now < evidence.verifiedAtMonotonicMs || now >= evidence.expiresAtMonotonicMs)) {
      return blocked("drain_evidence_unavailable");
    }
    try {
      const rows = await tx.$queryRaw<Snapshot[]>(Prisma.sql`
        SELECT * FROM command_protected.purge_barrier_snapshot(${generation}::integer)`);
      const snapshot = rows[0];
      if (!snapshot || snapshot.status !== "fenced" || snapshot.generation !== generation
        || snapshot.memberCount < 1 || snapshot.missingMembers !== 0) return blocked("publish_members_unfenced");
      if (!snapshot.healthy || !snapshot.primaryId || !snapshot.continuityId || !snapshot.clockDigest
        || !Number.isFinite(snapshot.dbNow?.getTime())) return blocked("clock_continuity_unavailable");
      let maximum: Date | null;
      try { maximum = await new CommandPublishEpochService().maxUnsettledExpiry(tx, generation); }
      catch { return blocked("publish_attempt_envelope_unavailable"); }
      const key = JSON.stringify([generation, snapshot.fencedAt, snapshot.primaryId, snapshot.continuityId,
        snapshot.memberDigest, observed.broker.inventoryRevision, observed.gateway.inventoryRevision,
        observed.gateway.submitToRfUpperBoundMs]);
      const dbNow = snapshot.dbNow.getTime();
      if (this.wait && (this.wait.key !== key || now < this.wait.lastMonotonic
        || (maximum?.getTime() ?? -Infinity) > this.wait.maximumExpiryMs
        || Math.abs(dbNow - this.wait.dbStarted - (now - this.wait.started)) > 100)) {
        this.invalidatedGenerations.add(generation);
        return blocked("barrier_continuity_reset");
      }
      if (!this.wait) {
        this.wait = { key, started: now, lastMonotonic: now, dbStarted: dbNow,
          maximumExpiryMs: maximum?.getTime() ?? -Infinity,
          // Starting late never shortens the original fence-to-expiry bound.
          minimumWaitMs: Math.max(10000, (maximum?.getTime() ?? snapshot.fencedAt.getTime())
            - snapshot.fencedAt.getTime() + 2000) + observed.gateway.submitToRfUpperBoundMs };
      }
      this.wait.lastMonotonic = now;
      const elapsed = Math.floor(now - this.wait.started);
      if (elapsed < this.wait.minimumWaitMs) return { ready: false, reason: "drain_wait_pending" };
      const proof: PurgeBarrierProof = { generation: String(generation), workerBootId: this.workerBootId,
        primaryId: snapshot.primaryId, continuityId: snapshot.continuityId, memberDigest: snapshot.memberDigest,
        brokerDigest: observed.broker.digest, gatewayDigest: observed.gateway.digest, clockDigest: snapshot.clockDigest,
        fencedAt: snapshot.fencedAt.toISOString(), maxExpiresAt: maximum?.toISOString() ?? "",
        cutoff: snapshot.cutoff.toISOString(), dbSampleAt: snapshot.dbNow.toISOString(),
        validUntil: new Date(dbNow + Math.min(500, observed.broker.expiresAtMonotonicMs - now,
          observed.gateway.expiresAtMonotonicMs - now)).toISOString(),
        monotonicWaitMs: String(elapsed), minimumWaitMs: String(this.wait.minimumWaitMs) };
      return { ready: true, evidence: { generation, minimumWaitMs: this.wait.minimumWaitMs,
        monotonicWaitMs: elapsed, productionPurgeAllowed: false, proof } };
    } catch { return blocked("barrier_state_unavailable"); }
  }
}

/** Only a separate test worker receives this key. API credentials cannot read/sign it. */
export async function storeDisposableBarrierEvidence(tx: Prisma.TransactionClient, proof: PurgeBarrierProof,
  signer: { workerId: string; keyVersion: number; secret: Buffer }): Promise<string> {
  if (process.env.NODE_ENV !== "test" || process.env.COMMAND_RETENTION_TEST !== "1"
    || signer.secret.length !== 32) throw new Error("disposable barrier signer unavailable");
  const id = randomUUID();
  const signature = "hmac-sha256:" + createHmac("sha256", signer.secret)
    .update(JSON.stringify([id, signer.workerId, String(signer.keyVersion), ...PROOF_FIELDS.map(field => proof[field])]))
    .digest("hex");
  await tx.$executeRaw(Prisma.sql`INSERT INTO "CommandPurgeBarrierEvidence"
    ("id", "generation", "workerId", "brokerDigest", "gatewayDigest", "clockDigest", "signature", "keyVersion", "proof")
    VALUES (${id}, ${Number(proof.generation)}, ${signer.workerId}, ${"sha256:" + proof.brokerDigest},
      ${"sha256:" + proof.gatewayDigest}, ${"sha256:" + proof.clockDigest}, ${signature}, ${signer.keyVersion},
      ${JSON.stringify(proof)}::jsonb)`);
  return id;
}
