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
import {
  CERTIFICATE_AUTHORITY_PROVIDER,
  type CertificateAuthorityProvider
} from "./certificate-authority.provider";
import { GatewayCsrValidator } from "./csr-validator";
import type { SignedCertificate } from "./pki.types";
import { publishCrlAtomically } from "./crl-publisher";

const DEVICE_CERTIFICATE_TTL_SECONDS = 365 * 24 * 60 * 60;
const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVATION_GRACE_MS = 10 * 60 * 1000;
const INVENTORY_ADVISORY_LOCK_TIMEOUT_MS = 10_000;
const RENEWAL_TRANSACTION_TIMEOUT_MS = 140_000;

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

export const CERTIFICATE_LIFECYCLE_CONFIGURATION = Symbol("CERTIFICATE_LIFECYCLE_CONFIGURATION");

export interface CertificateLifecycleConfiguration {
  deviceCrlPath?: string;
  mqttCrlPath?: string;
  publishCrl: typeof publishCrlAtomically;
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
    private readonly configuration: CertificateLifecycleConfiguration = { publishCrl: publishCrlAtomically }
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
    try {
      const issuance = await this.db().$transaction(async (tx: any) => {
        // Serialize sign-and-record work per inventory so a second CSR cannot create another pending identity.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${INVENTORY_ADVISORY_LOCK_TIMEOUT_MS}ms`}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${activeCertificate.inventory.id}::text, 0))`;
        const current = await tx.gatewayCertificate.findUnique({
          where: { id: activeCertificate.id },
          include: { inventory: { include: { claimedGateway: true } } }
        });
        this.assertRenewableDeviceCertificate(current, fingerprint, now);
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
        });
        signed = signedCertificate;
        const certificateData = this.certificateData(current.inventoryId, current.inventory.claimedGatewayId, signedCertificate, "pending");
        await tx.gatewayCertificate.create({ data: certificateData });
        return { certificateData, gatewayId: current.inventory.claimedGatewayId, signed: signedCertificate };
      }, {
        maxWait: RENEWAL_TRANSACTION_TIMEOUT_MS,
        timeout: RENEWAL_TRANSACTION_TIMEOUT_MS
      });
      return {
        gatewayId: issuance.gatewayId,
        certificatePem: issuance.signed.certificatePem,
        caChainPem: issuance.signed.caChainPem,
        notAfter: issuance.certificateData.notAfter.toISOString()
      };
    } catch (error) {
      if (signed) await this.bestEffortRevoke(signed, "device");
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
    const now = this.clock.now();
    if (this.isAlreadyActiveDeviceCertificate(pending, fingerprint)) {
      return { status: "active" as const };
    }
    this.assertPendingDeviceCertificate(pending, fingerprint);

    if (pending.createdAt.getTime() + ACTIVATION_GRACE_MS < now.getTime()) {
      await this.revokeExpiredPendingCertificate(pending, now);
      throw new UnauthorizedException("pending device certificate activation expired");
    }

    try {
      await this.db().$transaction(async (tx: any) => {
        const currentPending = await tx.gatewayCertificate.findUnique({
          where: { id: pending.id },
          include: { inventory: { include: { claimedGateway: true } } }
        });
        this.assertPendingDeviceCertificate(currentPending, fingerprint);
        if (currentPending.createdAt.getTime() + ACTIVATION_GRACE_MS < now.getTime()) {
          throw new UnauthorizedException("pending device certificate activation expired");
        }
        const active = await tx.gatewayCertificate.findFirst({
          where: { inventoryId: currentPending.inventoryId, purpose: "device", status: "active" }
        });
        if (!active || active.fingerprint !== this.inventoryFingerprint(currentPending.inventory)) {
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
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException("device certificate activation failed");
    }
    return { status: "active" as const };
  }

  async revokeInventoryCertificates(inventoryId: string) {
    const certificates = await this.db().gatewayCertificate.findMany({
      where: { inventoryId, revokedAt: null },
      orderBy: { createdAt: "asc" }
    });
    let revoked = 0;
    for (const certificate of certificates) {
      try {
        await this.certificateAuthority.revoke({
          purpose: certificate.purpose,
          certificateSerial: certificate.certificateSerial,
          issuer: certificate.issuer,
          fingerprint: certificate.fingerprint
        });
        await this.db().gatewayCertificate.update({
          where: { id: certificate.id },
          data: { status: "revoked", revokedAt: this.clock.now() }
        });
        revoked += 1;
      } catch {
        throw new ServiceUnavailableException("inventory certificate revocation pending");
      }
    }
    try {
      await this.synchronizeCrls();
    } catch {
      throw new ServiceUnavailableException("certificate revocation list publication pending");
    }
    return { revoked };
  }

  private async synchronizeCrls() {
    const targets = [
      ["device", this.configuration.deviceCrlPath],
      ["mqtt", this.configuration.mqttCrlPath]
    ] as const;
    for (const [purpose, path] of targets) {
      if (!path) continue;
      await this.configuration.publishCrl(path, await this.certificateAuthority.readCrl(purpose));
    }
  }

  private assertRenewableDeviceCertificate(certificate: any, fingerprint: string, now: Date) {
    if (!certificate || certificate.purpose !== "device" || certificate.status !== "active") {
      throw new UnauthorizedException("device certificate mismatch");
    }
    const inventory = certificate.inventory;
    if (
      !inventory ||
      inventory.disabledAt ||
      !inventory.claimedGatewayId ||
      !inventory.claimedGateway ||
      inventory.claimedGateway.id !== inventory.claimedGatewayId ||
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
    if (!certificate || certificate.purpose !== "device" || certificate.status !== "pending") {
      throw new UnauthorizedException("pending device certificate mismatch");
    }
    const inventory = certificate.inventory;
    if (
      !inventory ||
      inventory.disabledAt ||
      !inventory.claimedGatewayId ||
      !inventory.claimedGateway ||
      inventory.claimedGateway.id !== inventory.claimedGatewayId ||
      this.normalizeFingerprint(certificate.fingerprint) !== fingerprint
    ) {
      throw new UnauthorizedException("pending device certificate mismatch");
    }
  }

  private isAlreadyActiveDeviceCertificate(certificate: any, fingerprint: string) {
    const inventory = certificate?.inventory;
    return certificate?.purpose === "device" && certificate.status === "active" &&
      inventory && !inventory.disabledAt && inventory.claimedGatewayId &&
      inventory.claimedGateway?.id === inventory.claimedGatewayId &&
      this.normalizeCertificateFingerprint(certificate.fingerprint) === fingerprint &&
      this.inventoryFingerprint(inventory) === fingerprint;
  }

  private async revokeExpiredPendingCertificate(certificate: any, now: Date) {
    try {
      await this.certificateAuthority.revoke({
        purpose: "device",
        certificateSerial: certificate.certificateSerial,
        issuer: certificate.issuer,
        fingerprint: certificate.fingerprint
      });
      await this.db().gatewayCertificate.update({
        where: { id: certificate.id },
        data: { status: "revoked", revokedAt: now }
      });
    } catch {
      throw new ServiceUnavailableException("pending device certificate revocation failed");
    }
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
      // The lifecycle retry path is responsible for any CA outage after signing.
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
