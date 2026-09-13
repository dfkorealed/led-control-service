import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
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
import { CertificateRevocationReconciliationService } from "./certificate-revocation-reconciliation.service";
import { CERTIFICATE_TRANSACTION_TIMEOUT_MS, lockGatewayCertificates, lockGatewayInventory } from "./inventory-certificate-lock";

const MQTT_CERTIFICATE_TTL_SECONDS = 90 * 24 * 60 * 60;

interface IssueMqttCertificateInput {
  csrPem?: unknown;
  deviceCertificateFingerprint?: unknown;
}

@Injectable()
export class GatewayCertificateService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CERTIFICATE_AUTHORITY_PROVIDER) private readonly certificateAuthority: CertificateAuthorityProvider,
    private readonly csrValidator: GatewayCsrValidator,
    private readonly reconciliation: CertificateRevocationReconciliationService = new CertificateRevocationReconciliationService(prisma, certificateAuthority)
  ) {}

  async issueMqttCertificate(input?: IssueMqttCertificateInput | null) {
    const csrPem = this.requireCsr(input?.csrPem);
    const deviceFingerprint = this.normalizeFingerprint(input?.deviceCertificateFingerprint);
    const deviceCertificate = await this.db().gatewayCertificate.findUnique({
      where: { fingerprint: deviceFingerprint },
      include: { inventory: { include: { claimedGateway: true } } }
    });
    const inventory = deviceCertificate?.inventory;

    if (
      !deviceCertificate ||
      deviceCertificate.purpose !== "device" ||
      deviceCertificate.status !== "active" ||
      deviceCertificate.revokedAt ||
      !inventory ||
      inventory.disabledAt ||
      this.inventoryFingerprint(inventory) !== deviceFingerprint
    ) {
      throw new UnauthorizedException("device certificate mismatch");
    }
    if (!inventory.claimedGatewayId) throw new ConflictException("gateway inventory is not claimed");
    if (!inventory.claimedGateway || inventory.claimedGateway.id !== inventory.claimedGatewayId) {
      throw new ConflictException("gateway assignment is unavailable");
    }

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
        await lockGatewayInventory(tx, inventory.id);
        await lockGatewayCertificates(tx, inventory.id);
        await this.assertCurrentIdentity(tx, deviceCertificate.id, deviceFingerprint, inventory.claimedGatewayId);
        signed = await this.certificateAuthority.signCsr({
          purpose: "mqtt",
          csrPem,
          commonName: inventory.claimedGateway.id,
          uriSans: [`urn:dfkorea:gateway:${inventory.claimedGateway.id}`],
          ttlSeconds: MQTT_CERTIFICATE_TTL_SECONDS
        });
        reconciliationId = await this.reconciliation.armSignedCertificate({
          inventoryId: inventory.id, purpose: "mqtt", issuer: signed.issuer,
          certificateSerial: signed.certificateSerial, fingerprint: signed.fingerprint
        });
        await this.assertCurrentIdentity(tx, deviceCertificate.id, deviceFingerprint, inventory.claimedGatewayId);
        const certificateData = this.certificateData(inventory.id, inventory.claimedGateway.id, signed);
        const activeMqttCertificate = await tx.gatewayCertificate.findFirst({
          where: { inventoryId: inventory.id, purpose: "mqtt", status: "active" }
        });

        if (activeMqttCertificate) {
          await tx.gatewayCertificate.update({
            where: { id: activeMqttCertificate.id },
            data: { status: "replaced" }
          });
        }
        const mqttCertificate = await tx.gatewayCertificate.create({ data: certificateData });

        if (activeMqttCertificate) {
          await tx.gatewayCertificate.update({
            where: { id: activeMqttCertificate.id },
            data: { replacedById: mqttCertificate.id }
          });
        }

        await this.reconciliation.cancelSignedCertificate(tx, reconciliationId);
        return { signed, certificateData };
      }, {
        maxWait: CERTIFICATE_TRANSACTION_TIMEOUT_MS,
        timeout: CERTIFICATE_TRANSACTION_TIMEOUT_MS
      });

      return {
        gatewayId: inventory.claimedGateway.id,
        certificatePem: issuance.signed.certificatePem,
        caChainPem: issuance.signed.caChainPem,
        notAfter: issuance.certificateData.notAfter.toISOString()
      };
    } catch {
      if (signed && !reconciliationId) await this.bestEffortRevoke(signed);
      throw new ServiceUnavailableException("MQTT certificate issuance failed");
    }
  }

  private async assertCurrentIdentity(tx: any, certificateId: string, fingerprint: string, gatewayId: string) {
    const current = await tx.gatewayCertificate.findUnique({ where: { id: certificateId }, include: { inventory: { include: { claimedGateway: true } } } });
    const inventory = current?.inventory;
    if (!current || current.purpose !== "device" || current.status !== "active" || current.revokedAt ||
      !inventory || inventory.disabledAt || this.inventoryFingerprint(inventory) !== fingerprint ||
      current.fingerprint !== fingerprint || inventory.claimedGatewayId !== gatewayId ||
      inventory.claimedGateway?.id !== gatewayId || inventory.claimedGateway.certificateFingerprint !== fingerprint) {
      throw new UnauthorizedException("device certificate mismatch");
    }
  }

  private certificateData(inventoryId: string, gatewayId: string, signed: SignedCertificate) {
    const fingerprint = signed.fingerprint.replace(/:/g, "").trim().toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(fingerprint)) throw new Error("invalid certificate fingerprint");
    const certificateSerial = signed.certificateSerial.replace(/[:-]/g, "").trim().toUpperCase();
    if (!certificateSerial || !/^[0-9A-F]+$/.test(certificateSerial)) throw new Error("invalid certificate serial");
    const issuer = signed.issuer.trim();
    const notBefore = new Date(signed.notBefore);
    const notAfter = new Date(signed.notAfter);
    if (!issuer || Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime()) || notAfter <= notBefore) {
      throw new Error("invalid certificate metadata");
    }
    return {
      inventoryId,
      gatewayId,
      purpose: "mqtt" as const,
      certificateSerial,
      fingerprint,
      issuer,
      notBefore,
      notAfter,
      status: "active" as const
    };
  }

  private async bestEffortRevoke(signed: SignedCertificate) {
    try {
      await this.certificateAuthority.revoke({
        purpose: "mqtt",
        certificateSerial: signed.certificateSerial,
        issuer: signed.issuer,
        fingerprint: signed.fingerprint
      });
    } catch {
      // With no durable arm, simultaneous DB/CA failure needs CA-side issuance auditing.
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

  private inventoryFingerprint(inventory: { certificateFingerprint?: unknown }) {
    if (typeof inventory.certificateFingerprint !== "string") return "";
    return inventory.certificateFingerprint.replace(/:/g, "").trim().toUpperCase();
  }

  private db() {
    return this.prisma as any;
  }
}
