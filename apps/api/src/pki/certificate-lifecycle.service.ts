import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma, type GatewayRecommissionJob } from "@prisma/client";
import { CertificateRevocationReconciliationService } from "./certificate-revocation-reconciliation.service";
import { CERTIFICATE_TRANSACTION_TIMEOUT_MS, lockGatewayCertificates, lockGatewayInventory } from "./inventory-certificate-lock";
import {
  CERTIFICATE_AUTHORITY_PROVIDER,
  type CertificateAuthorityProvider
} from "./certificate-authority.provider";
import { GatewayCsrValidator } from "./csr-validator";
import type { SignedCertificate } from "./pki.types";
import { publishCrlAtomically } from "./crl-publisher";
import { CERTIFICATE_LIFECYCLE_CONFIGURATION, type CertificateLifecycleConfiguration } from "./certificate-lifecycle.configuration";
export { CERTIFICATE_LIFECYCLE_CONFIGURATION, type CertificateLifecycleConfiguration } from "./certificate-lifecycle.configuration";

const DEVICE_CERTIFICATE_TTL_SECONDS = 365 * 24 * 60 * 60;
const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVATION_GRACE_MS = 10 * 60 * 1000;

export interface CertificateLifecycleClock {
  now(): Date;
}

interface RenewDeviceCertificateInput {
  csrPem?: unknown;
  deviceCertificateFingerprint?: unknown;
}

interface ActivateDeviceCertificateInput {
  deviceCertificateFingerprint?: unknown;
}

@Injectable()
export class CertificateLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CERTIFICATE_AUTHORITY_PROVIDER) private readonly certificateAuthority: CertificateAuthorityProvider,
    private readonly csrValidator: GatewayCsrValidator,
    @Optional() private readonly clock: CertificateLifecycleClock = { now: () => new Date() },
    @Optional()
    @Inject(CERTIFICATE_LIFECYCLE_CONFIGURATION)
    private readonly configuration: CertificateLifecycleConfiguration = { publishCrl: publishCrlAtomically },
    private readonly reconciliation: CertificateRevocationReconciliationService = new CertificateRevocationReconciliationService(prisma, certificateAuthority, configuration)
  ) {}

  async renewDeviceCertificate(input?: RenewDeviceCertificateInput | null) {
    const csrPem = this.requireCsr(input?.csrPem);
    const fingerprint = this.normalizeFingerprint(input?.deviceCertificateFingerprint);
    const activeCertificate = await this.db().gatewayCertificate.findUnique({
      where: { fingerprint },
      include: { inventory: { include: { claimedGateway: true } } }
    });
    const now = this.clock.now();
    this.assertRenewableDeviceCertificate(activeCertificate, fingerprint, now);

    try {
      await this.csrValidator.validate(csrPem);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("CSR is invalid");
    }

    let signed: SignedCertificate | undefined;
    let reconciliationId: string | undefined;
    try {
      const issuance = await this.db().$transaction(async (tx: any) => {
        await lockGatewayInventory(tx, activeCertificate.inventory.id);
        await lockGatewayCertificates(tx, activeCertificate.inventory.id);
        const current = await tx.gatewayCertificate.findUnique({
          where: { id: activeCertificate.id },
          include: { inventory: { include: { claimedGateway: true } } }
        });
        this.assertRenewableDeviceCertificate(current, fingerprint, this.clock.now());
        const gatewayId = current.inventory.claimedGatewayId;
        const existingPending = await tx.gatewayCertificate.findFirst({
          where: { inventoryId: current.inventoryId, purpose: "device", status: "pending" }
        });
        if (existingPending) throw new ConflictException("device certificate renewal is already pending");
        const signedCertificate = await this.certificateAuthority.signCsr({
          purpose: "device",
          csrPem,
          commonName: current.inventory.serialNumber,
          uriSans: [`urn:dfkorea:gateway:${current.inventory.serialNumber}`],
          ttlSeconds: DEVICE_CERTIFICATE_TTL_SECONDS
        }).catch(() => { throw new ServiceUnavailableException("device certificate renewal failed"); });
        signed = signedCertificate;
        reconciliationId = await this.reconciliation.armSignedCertificate({
          inventoryId: current.inventoryId, purpose: "device", issuer: signedCertificate.issuer,
          certificateSerial: signedCertificate.certificateSerial, fingerprint: signedCertificate.fingerprint
        });
        const refreshed = await tx.gatewayCertificate.findUnique({ where: { id: current.id }, include: { inventory: { include: { claimedGateway: true } } } });
        this.assertRenewableDeviceCertificate(refreshed, fingerprint, this.clock.now());
        if (refreshed.inventory.claimedGatewayId !== gatewayId ||
          await tx.gatewayCertificate.findFirst({ where: { inventoryId: current.inventoryId, purpose: "device", status: "pending" } })) {
          throw new ConflictException("device certificate renewal state changed");
        }
        const certificateData = this.certificateData(current.inventoryId, current.inventory.claimedGatewayId, signedCertificate, "pending");
        await tx.gatewayCertificate.create({ data: certificateData });
        await this.reconciliation.cancelSignedCertificate(tx, reconciliationId);
        return { certificateData, gatewayId: current.inventory.claimedGatewayId, signed: signedCertificate };
      }, {
        maxWait: CERTIFICATE_TRANSACTION_TIMEOUT_MS,
        timeout: CERTIFICATE_TRANSACTION_TIMEOUT_MS
      });
      return {
        gatewayId: issuance.gatewayId,
        certificatePem: issuance.signed.certificatePem,
        caChainPem: issuance.signed.caChainPem,
        notAfter: issuance.certificateData.notAfter.toISOString()
      };
    } catch (error) {
      if (signed && !reconciliationId) await this.bestEffortRevoke(signed, "device");
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException("device certificate renewal failed");
    }
  }

  async activateDeviceCertificate(input?: ActivateDeviceCertificateInput | null) {
    const fingerprint = this.normalizeFingerprint(input?.deviceCertificateFingerprint);
    const pending = await this.db().gatewayCertificate.findUnique({
      where: { fingerprint },
      include: { inventory: { include: { claimedGateway: true } } }
    });
    if (!pending) throw new UnauthorizedException("pending device certificate mismatch");

    let expiredJob: string | undefined;
    try {
      await this.db().$transaction(async (tx: any) => {
        await lockGatewayInventory(tx, pending.inventoryId);
        await lockGatewayCertificates(tx, pending.inventoryId);
        const currentPending = await tx.gatewayCertificate.findUnique({
          where: { id: pending.id },
          include: { inventory: { include: { claimedGateway: true } } }
        });
        if (this.isAlreadyActiveDeviceCertificate(currentPending, fingerprint)) return;
        this.assertPendingDeviceCertificate(currentPending, fingerprint);
        if (currentPending.createdAt.getTime() + ACTIVATION_GRACE_MS < this.clock.now().getTime()) {
          // Expiry revokes only the pending identity. The active device remains
          // usable, while the orphan ledger survives rollback or worker failure.
          expiredJob = await this.reconciliation.armSignedCertificate({
            inventoryId: currentPending.inventoryId, certificateId: currentPending.id, purpose: "device",
            issuer: currentPending.issuer, certificateSerial: currentPending.certificateSerial, fingerprint: currentPending.fingerprint
          });
          await tx.certificateRevocationReconciliation.updateMany({ where: { id: expiredJob, completedAt: null }, data: {
            certificateId: currentPending.id, cancelledAt: null, nextAttemptAt: this.clock.now()
          } });
          await tx.gatewayCertificate.update({ where: { id: currentPending.id }, data: { status: "revocation_pending" } });
          return;
        }
        const active = await tx.gatewayCertificate.findFirst({
          where: { inventoryId: currentPending.inventoryId, purpose: "device", status: "active" }
        });
        if (!active || active.revokedAt || active.fingerprint !== this.inventoryFingerprint(currentPending.inventory) ||
          currentPending.inventory.claimedGateway.certificateFingerprint !== active.fingerprint) {
          throw new UnauthorizedException("active device certificate mismatch");
        }
        await tx.gatewayCertificate.update({
          where: { id: active.id },
          data: { status: "replaced", replacedById: currentPending.id }
        });
        await tx.gatewayCertificate.update({ where: { id: currentPending.id }, data: { status: "active" } });
        await tx.gatewayInventory.update({
          where: { id: currentPending.inventoryId },
          data: { certificateFingerprint: fingerprint }
        });
        await tx.gateway.update({
          where: { id: currentPending.inventory.claimedGatewayId },
          data: { certificateFingerprint: fingerprint }
        });
      }, { maxWait: CERTIFICATE_TRANSACTION_TIMEOUT_MS, timeout: CERTIFICATE_TRANSACTION_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException("device certificate activation failed");
    }
    if (expiredJob) {
      await this.reconciliation.processNow(expiredJob).catch(() => undefined);
      throw new UnauthorizedException("pending device certificate activation expired");
    }
    return { status: "active" as const };
  }

  async revokeInventoryCertificates(inventoryId: string) {
    try {
      const ids = await this.db().$transaction((tx: Prisma.TransactionClient) => this.stageInventoryDisable(tx, inventoryId),
        { maxWait: CERTIFICATE_TRANSACTION_TIMEOUT_MS, timeout: CERTIFICATE_TRANSACTION_TIMEOUT_MS });
      return await this.processInventoryRevocation(ids);
    } catch {
      throw new ServiceUnavailableException("inventory certificate revocation pending");
    }
  }

  async revokeMqttCertificatesForRecommission(inventoryId: string, jobId: string) {
    const ids = await this.prisma.$transaction(async tx => {
      const jobs = await tx.$queryRaw<GatewayRecommissionJob[]>(Prisma.sql`
        SELECT * FROM "GatewayRecommissionJob" WHERE "id" = ${jobId} FOR UPDATE
      `);
      const job = jobs[0];
      if (!job || job.inventoryId !== inventoryId || !["prepared", "mqtt_revocation_pending", "mqtt_revoked"].includes(job.status)) {
        throw new ConflictException("gateway recommission cannot revoke MQTT certificates");
      }
      const staged = await this.reconciliation.stagePurposeRevocation(tx, inventoryId, "mqtt", "gateway_recommission", this.clock.now());
      if (job.status !== "mqtt_revoked") await tx.gatewayRecommissionJob.update({ where: { id: jobId }, data: { status: "mqtt_revocation_pending" } });
      return staged;
    }, { timeout: CERTIFICATE_TRANSACTION_TIMEOUT_MS });
    try {
      await this.processInventoryRevocation(ids);
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "GatewayRecommissionJob" WHERE "id" = ${jobId} FOR UPDATE`);
        await lockGatewayInventory(tx, inventoryId);
        await lockGatewayCertificates(tx, inventoryId);
        await assertMqttRevocationCompleted(tx, inventoryId);
        // MQTT CRL 게시 완료는 되돌릴 수 없다. 이 뒤 DB 초기화가 실패해도 구 런타임을
        // 재시작하지 않고 mqtt_revoked 작업으로 운영자 재시도를 이어가야 한다.
        await tx.gatewayRecommissionJob.updateMany({ where: { id: jobId, status: { in: ["prepared", "mqtt_revocation_pending", "mqtt_revoked"] } },
          data: { status: "mqtt_revoked", revokedAt: this.clock.now(), lastError: null } });
      });
    } catch {
      throw new ServiceUnavailableException("gateway recommission MQTT revocation pending");
    }
    return { revoked: ids.length };
  }

  async stageInventoryDisable(tx: Prisma.TransactionClient, inventoryId: string) {
    const inventory = await lockGatewayInventory(tx, inventoryId);
    if (!inventory) return [];
    const ids = await this.reconciliation.stageInventoryRevocation(tx, inventoryId, this.clock.now());
    await tx.gatewayInventory.update({ where: { id: inventoryId }, data: { disabledAt: inventory.disabledAt ?? this.clock.now() } });
    // Gateway writes follow inventory and certificate locks, including site deletion.
    await tx.gateway.updateMany({ where: { id: inventory.claimedGatewayId ?? "" }, data: { certificateFingerprint: null } });
    return ids;
  }

  async processInventoryRevocation(ids: string[]) {
    for (const id of ids) await this.reconciliation.processNow(id);
    const pending = await this.db().certificateRevocationReconciliation.count({ where: { id: { in: ids }, completedAt: null } });
    if (pending) throw new ServiceUnavailableException("inventory certificate revocation pending");
    return { revoked: ids.length };
  }

  private assertRenewableDeviceCertificate(certificate: any, fingerprint: string, now: Date) {
    if (!certificate || certificate.purpose !== "device" || certificate.status !== "active" || certificate.revokedAt) {
      throw new UnauthorizedException("device certificate mismatch");
    }
    const inventory = certificate.inventory;
    if (
      !inventory ||
      inventory.disabledAt ||
      !inventory.claimedGatewayId ||
      !inventory.claimedGateway ||
      inventory.claimedGateway.id !== inventory.claimedGatewayId ||
      inventory.claimedGateway.certificateFingerprint !== fingerprint ||
      this.inventoryFingerprint(inventory) !== fingerprint ||
      this.normalizeFingerprint(certificate.fingerprint) !== fingerprint
    ) {
      throw new UnauthorizedException("device certificate mismatch");
    }
    if (certificate.notAfter <= now) throw new UnauthorizedException("device certificate expired");
    if (certificate.notAfter.getTime() - now.getTime() > RENEWAL_WINDOW_MS) {
      throw new ConflictException("device certificate is not in the renewal window");
    }
  }

  private assertPendingDeviceCertificate(certificate: any, fingerprint: string) {
    if (!certificate || certificate.purpose !== "device" || certificate.status !== "pending" || certificate.revokedAt) {
      throw new UnauthorizedException("pending device certificate mismatch");
    }
    const inventory = certificate.inventory;
    if (
      !inventory ||
      inventory.disabledAt ||
      !inventory.claimedGatewayId ||
      !inventory.claimedGateway ||
      inventory.claimedGateway.id !== inventory.claimedGatewayId ||
      certificate.gatewayId !== inventory.claimedGatewayId ||
      this.normalizeFingerprint(certificate.fingerprint) !== fingerprint
    ) {
      throw new UnauthorizedException("pending device certificate mismatch");
    }
  }

  private isAlreadyActiveDeviceCertificate(certificate: any, fingerprint: string) {
    const inventory = certificate?.inventory;
    return certificate?.purpose === "device" && certificate.status === "active" && !certificate.revokedAt &&
      inventory && !inventory.disabledAt && inventory.claimedGatewayId &&
      inventory.claimedGateway?.id === inventory.claimedGatewayId &&
      inventory.claimedGateway?.certificateFingerprint === fingerprint &&
      this.normalizeCertificateFingerprint(certificate.fingerprint) === fingerprint &&
      this.inventoryFingerprint(inventory) === fingerprint;
  }

  private certificateData(inventoryId: string, gatewayId: string, signed: SignedCertificate, status: "pending") {
    const fingerprint = this.normalizeCertificateFingerprint(signed.fingerprint);
    const certificateSerial = signed.certificateSerial.replace(/[:-]/g, "").trim().toUpperCase();
    const issuer = signed.issuer.trim();
    const notBefore = new Date(signed.notBefore);
    const notAfter = new Date(signed.notAfter);
    if (!certificateSerial || !/^[0-9A-F]+$/.test(certificateSerial) || !issuer || Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime()) || notAfter <= notBefore) {
      throw new Error("invalid certificate metadata");
    }
    return { inventoryId, gatewayId, purpose: "device" as const, certificateSerial, fingerprint, issuer, notBefore, notAfter, status };
  }

  private async bestEffortRevoke(signed: SignedCertificate, purpose: "device" | "mqtt") {
    try {
      await this.certificateAuthority.revoke({
        purpose,
        certificateSerial: signed.certificateSerial,
        issuer: signed.issuer,
        fingerprint: signed.fingerprint
      });
    } catch {
      // Without a durable arm, simultaneous DB/CA failure requires CA-side issuance auditing.
    }
  }

  private requireCsr(value: unknown) {
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 16 * 1024) {
      throw new BadRequestException("CSR is invalid");
    }
    return value.trim();
  }

  private normalizeFingerprint(value: unknown) {
    if (typeof value !== "string") throw new UnauthorizedException("device certificate mismatch");
    const fingerprint = value.replace(/:/g, "").trim().toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(fingerprint)) throw new UnauthorizedException("device certificate mismatch");
    return fingerprint;
  }

  private normalizeCertificateFingerprint(value: unknown) {
    if (typeof value !== "string") throw new Error("invalid certificate fingerprint");
    const fingerprint = value.replace(/:/g, "").trim().toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(fingerprint)) throw new Error("invalid certificate fingerprint");
    return fingerprint;
  }

  private inventoryFingerprint(inventory: { certificateFingerprint?: unknown }) {
    try {
      return this.normalizeFingerprint(inventory.certificateFingerprint);
    } catch {
      return "";
    }
  }

  private db() {
    return this.prisma as any;
  }
}

export async function assertMqttRevocationCompleted(tx: Prisma.TransactionClient, inventoryId: string) {
  const incomplete = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT certificate."id" FROM "GatewayCertificate" certificate
    WHERE certificate."inventoryId" = ${inventoryId} AND certificate."purpose" = 'mqtt'
      AND (certificate."status" <> 'revoked' OR certificate."revokedAt" IS NULL OR NOT EXISTS (
        SELECT 1 FROM "CertificateRevocationReconciliation" obligation
        WHERE obligation."inventoryId" = certificate."inventoryId" AND obligation."certificateId" = certificate."id"
          AND obligation."fingerprint" = certificate."fingerprint" AND obligation."purpose" = 'mqtt'
          AND obligation."completedAt" IS NOT NULL AND obligation."revokedAt" IS NOT NULL AND obligation."cancelledAt" IS NULL
      ))
  `);
  if (incomplete.length) throw new ServiceUnavailableException("gateway recommission MQTT revocation pending");
}
