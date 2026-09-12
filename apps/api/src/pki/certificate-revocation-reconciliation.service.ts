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
      if (certificate.status === "revoked") continue;
      const row = await this.record(tx, this.metadata({ ...certificate, certificateId: certificate.id, source: "inventory_revocation" }), now);
      if (row.completedAt) {
        // A retained completed identity is already revoked in the CA and CRL.
        await tx.gatewayCertificate.updateMany({ where: { id: certificate.id }, data: { status: "revoked", revokedAt: row.revokedAt ?? now } });
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
      await this.configuration.publishCrl(path, await this.certificateAuthority.readCrl(row.purpose));
      await this.prisma.$transaction(async tx => {
        // Keep the common inventory -> certificate -> ledger lock order; reversing
        // it here would deadlock against disable staging this same obligation.
        if (row.certificateId) {
          await lockGatewayInventory(tx, row.inventoryId);
          await lockGatewayCertificates(tx, row.inventoryId);
        }
        const result = await tx.certificateRevocationReconciliation.updateMany({ where: this.fence(row), data: {
          completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null
        } });
        if (result.count !== 1) return;
        if (row.certificateId) await tx.gatewayCertificate.updateMany({
          where: { id: row.certificateId, inventoryId: row.inventoryId, fingerprint: row.fingerprint },
          data: { status: "revoked", revokedAt: row.revokedAt }
        });
      });
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
