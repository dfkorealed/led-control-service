import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, type CertificateRevocationReconciliation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CERTIFICATE_AUTHORITY_PROVIDER, type CertificateAuthorityProvider } from "./certificate-authority.provider";
import { CERTIFICATE_LIFECYCLE_CONFIGURATION, type CertificateLifecycleConfiguration } from "./certificate-lifecycle.configuration";
import { publishCrlAtomically } from "./crl-publisher";
import { lockGatewayCertificates, lockGatewayInventory } from "./inventory-certificate-lock";
import type { RevokeCertificateInput } from "./pki.types";

const POLL_INTERVAL_MS = 30_000;
const LEASE_DURATION_MS = 300_000;
const MAX_BACKOFF_MS = 3_600_000;
// "PKIC" reserves a two-int PostgreSQL advisory namespace for CRL publication.
// PostgreSQL keeps this key space separate from inventory's one-bigint locks.
// The second key is device=1 / mqtt=2, so different CA CRLs remain independent.
const CRL_ADVISORY_NAMESPACE = 0x504b4943;
const MAX_CRL_PUBLICATIONS = 3;
// At most four CA reads (initial + three confirmations), each bounded by Vault's
// 120s request limit: <=8 minutes of network requests. Fifteen minutes is the
// cumulative transaction budget for external I/O and DB work, not a strict
// filesystem I/O bound. The budget deliberately exceeds the row's 5-minute
// lease. Any combination of reads, token/file I/O and DB work that outlives the
// transaction (or a lost DB session) can release the purpose lock while an
// already-started publish continues: Prisma cannot cancel that external I/O.
const CRL_TRANSACTION_TIMEOUT_MS = 15 * 60_000;
// Must exceed CERTIFICATE_TRANSACTION_TIMEOUT_MS (140s). The independent commit
// survives rollback/crash, while the delay protects successful certificate writes.
const SIGNED_CERTIFICATE_GRACE_MS = 180_000;
type RevocationSource = "signed_certificate" | "inventory_revocation";

export interface ArmSignedCertificateInput extends RevokeCertificateInput {
  inventoryId: string;
  certificateId?: string;
  source?: RevocationSource;
}

@Injectable()
export class CertificateRevocationReconciliationService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CERTIFICATE_AUTHORITY_PROVIDER) private readonly certificateAuthority: CertificateAuthorityProvider,
    @Optional() @Inject(CERTIFICATE_LIFECYCLE_CONFIGURATION)
    private readonly configuration: CertificateLifecycleConfiguration = { publishCrl: publishCrlAtomically }
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.processNow().catch(() => undefined), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.processNow().catch(() => undefined);
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.running);
  }

  async armSignedCertificate(input: ArmSignedCertificateInput): Promise<string> {
    const metadata = this.metadata(input);
    try {
      // Never use the enclosing issuance transaction: that rollback must not erase
      // the CA serial's revocation obligation. No certificate/inventory FK is held.
      const row = await this.prisma.$transaction(tx => this.record(tx, metadata,
        new Date(Date.now() + SIGNED_CERTIFICATE_GRACE_MS)));
      return row.id;
    } catch {
      // If both DB and CA are unavailable there is no durable place to record the
      // serial. Fail issuance closed; provider error bodies must never leak.
      try { await this.certificateAuthority.revoke(this.revokeInput(metadata)); } catch { /* Recovery requires CA-side issuance auditing in this dual-outage window. */ }
      throw new ServiceUnavailableException("certificate revocation reconciliation unavailable");
    }
  }

  async cancelSignedCertificate(tx: Prisma.TransactionClient, reconciliationId: string): Promise<void> {
    const result = await tx.certificateRevocationReconciliation.updateMany({
      where: { id: reconciliationId, cancelledAt: null, completedAt: null, revokedAt: null, leaseOwner: null },
      data: { cancelledAt: new Date() }
    });
    if (result.count !== 1) throw new ServiceUnavailableException("certificate revocation reconciliation unavailable");
  }

  async stageInventoryRevocation(tx: Prisma.TransactionClient, inventoryId: string, now: Date): Promise<string[]> {
    await lockGatewayInventory(tx, inventoryId);
    const certificates = await lockGatewayCertificates(tx, inventoryId);
    await tx.gatewayInventory.updateMany({ where: { id: inventoryId }, data: { certificateFingerprint: null } });
    const ids: string[] = [];
    for (const certificate of certificates) {
      // Legacy releases persisted revoked before CRL publication, without this
      // ledger. Only completedAt proves both steps finished. On first encounter
      // safely re-revoke/republish, retaining the original certificate history.
      const row = await this.record(tx, this.metadata({ ...certificate, certificateId: certificate.id, source: "inventory_revocation" }), now);
      if (row.completedAt) {
        // A retained completed identity is already revoked in the CA and CRL.
        await tx.gatewayCertificate.updateMany({ where: { id: certificate.id }, data: { status: "revoked", revokedAt: certificate.revokedAt ?? row.revokedAt ?? now } });
        continue;
      }
      await tx.gatewayCertificate.updateMany({ where: { id: certificate.id, status: { not: "revoked" } }, data: { status: "revocation_pending" } });
      // Successful issuance cancelled this identity earlier. Reopening it is an
      // explicit new revocation, and must not steal a live worker's lease.
      await tx.certificateRevocationReconciliation.updateMany({ where: { id: row.id, completedAt: null }, data: {
        certificateId: certificate.id, cancelledAt: null, nextAttemptAt: now, source: "inventory_revocation"
      } });
      ids.push(row.id);
    }
    return ids;
  }

  processNow(id?: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const run = this.processPending(id);
    this.running.add(run);
    void run.finally(() => this.running.delete(run)).catch(() => undefined);
    return run;
  }

  private async processPending(id?: string) {
    // Claim one at a time so a slow CA cannot consume the lease of queued work.
    for (let index = 0; index < (id ? 1 : 20) && !this.stopping; index += 1) {
      const row = await this.claim(id);
      if (!row) return;
      await this.processClaim(row);
    }
  }

  private async claim(id?: string) {
    const now = new Date();
    const leaseOwner = randomUUID();
    const rows = await this.prisma.$transaction(tx => tx.$queryRaw<CertificateRevocationReconciliation[]>(Prisma.sql`
      WITH candidate AS (
        SELECT "id" FROM "CertificateRevocationReconciliation"
        WHERE "cancelledAt" IS NULL AND "completedAt" IS NULL AND "nextAttemptAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
          ${id ? Prisma.sql`AND "id" = ${id}` : Prisma.empty}
        ORDER BY "nextAttemptAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE "CertificateRevocationReconciliation" AS job
      SET "leaseOwner" = ${leaseOwner}, "leaseExpiresAt" = ${new Date(now.getTime() + LEASE_DURATION_MS)},
          "attempts" = job."attempts" + 1, "updatedAt" = ${now}
      FROM candidate WHERE job."id" = candidate."id" RETURNING job.*
    `));
    return rows[0] ?? null;
  }

  private async processClaim(row: CertificateRevocationReconciliation) {
    let failureCode = "ca_revoke_failed";
    try {
      if (!row.revokedAt) {
        await this.certificateAuthority.revoke(this.revokeInput(row));
        const revokedAt = new Date();
        const result = await this.prisma.certificateRevocationReconciliation.updateMany({
          where: this.fence(row), data: { revokedAt, lastError: null }
        });
        if (result.count !== 1) return;
        row.revokedAt = revokedAt;
      }
      failureCode = "crl_publish_failed";
      const path = row.purpose === "device" ? this.configuration.deviceCrlPath : this.configuration.mqttCrlPath;
      if (!path) throw new Error("CRL publication destination unavailable");
      await this.prisma.$transaction(async tx => {
        // The file is shared by all certificate rows of this purpose. A row lease
        // alone cannot prevent an older snapshot overwriting a newer one. This
        // deliberate exception holds a DB transaction over CRL I/O, but no
        // inventory/certificate row lock is held until publication has finished.
        await tx.$executeRaw(Prisma.sql`SELECT set_config('lock_timeout', '10000ms', true)`);
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(
          ${CRL_ADVISORY_NAMESPACE}::integer, ${row.purpose === "device" ? 1 : 2}::integer
        )`);
        let snapshot = await this.certificateAuthority.readCrl(row.purpose);
        let confirmed = false;
        for (let attempt = 0; attempt < MAX_CRL_PUBLICATIONS; attempt += 1) {
          // Prisma timeouts do not cancel an awaiting JS callback. Re-query after
          // every CA read so a timed-out transaction or expired lease cannot
          // begin another publish after its advisory lock has been released.
          const live = await tx.certificateRevocationReconciliation.findFirst({
            where: this.fence(row), select: { id: true }
          });
          if (!live) return;
          await this.configuration.publishCrl(path, snapshot);
          // CA revoke itself is intentionally outside the publication lock. A
          // concurrent revoke may advance the CRL during I/O; confirm convergence
          // before completion, otherwise publish the freshly read snapshot again.
          const latest = await this.certificateAuthority.readCrl(row.purpose);
          if (latest === snapshot) {
            confirmed = true;
            break;
          }
          snapshot = latest;
        }
        if (!confirmed) throw new Error("CRL changed throughout the publication budget");
        // Keep the common inventory -> certificate -> ledger lock order; reversing
        // it here would deadlock against disable staging this same obligation.
        let certificateRevokedAt = row.revokedAt;
        if (row.certificateId) {
          await lockGatewayInventory(tx, row.inventoryId);
          const certificates = await lockGatewayCertificates(tx, row.inventoryId);
          // An upgrade repair may repeat CA revoke long after the original
          // revocation. Do not rewrite the certificate's historical timestamp.
          certificateRevokedAt = certificates.find(certificate => certificate.id === row.certificateId)?.revokedAt ?? row.revokedAt;
        }
        const result = await tx.certificateRevocationReconciliation.updateMany({ where: this.fence(row), data: {
          completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null
        } });
        if (result.count !== 1) return;
        if (row.certificateId) await tx.gatewayCertificate.updateMany({
          where: { id: row.certificateId, inventoryId: row.inventoryId, fingerprint: row.fingerprint },
          data: { status: "revoked", revokedAt: certificateRevokedAt }
        });
      }, { timeout: CRL_TRANSACTION_TIMEOUT_MS });
    } catch {
      const delay = Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** Math.min(20, Math.max(0, row.attempts - 1)));
      await this.prisma.certificateRevocationReconciliation.updateMany({ where: this.fence(row), data: {
        nextAttemptAt: new Date(Date.now() + delay), leaseOwner: null, leaseExpiresAt: null, lastError: failureCode
      } });
    }
  }

  private fence(row: CertificateRevocationReconciliation) {
    return { id: row.id, leaseOwner: row.leaseOwner, leaseExpiresAt: { gt: new Date() }, cancelledAt: null, completedAt: null };
  }

  private metadata(input: ArmSignedCertificateInput) {
    // Construct fields explicitly: passing a SignedCertificate object must not
    // persist PEM, CSR, chain material, or arbitrary provider exception strings.
    return {
      inventoryId: input.inventoryId, certificateId: input.certificateId ?? null, purpose: input.purpose,
      issuer: input.issuer.trim(), certificateSerial: input.certificateSerial.replace(/[:-]/g, "").trim().toUpperCase(),
      fingerprint: input.fingerprint.replace(/:/g, "").trim().toUpperCase(),
      source: input.source === "inventory_revocation" ? "inventory_revocation" : "signed_certificate"
    };
  }

  private async record(tx: Prisma.TransactionClient, metadata: ReturnType<CertificateRevocationReconciliationService["metadata"]>, nextAttemptAt: Date) {
    // ON CONFLICT DO NOTHING handles both uniqueness keys, including concurrent
    // inserts, without poisoning the caller transaction with a unique violation.
    await tx.certificateRevocationReconciliation.createMany({ data: { ...metadata, nextAttemptAt }, skipDuplicates: true });
    const row = await tx.certificateRevocationReconciliation.findFirst({ where: { OR: [
      { issuer: metadata.issuer, certificateSerial: metadata.certificateSerial }, { fingerprint: metadata.fingerprint }
    ] } });
    if (!row) throw new ServiceUnavailableException("certificate revocation reconciliation unavailable");
    return row;
  }

  private revokeInput(input: RevokeCertificateInput): RevokeCertificateInput {
    return { purpose: input.purpose, issuer: input.issuer, certificateSerial: input.certificateSerial, fingerprint: input.fingerprint };
  }
}
