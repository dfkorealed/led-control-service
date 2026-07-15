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

const MQTT_CERTIFICATE_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_VAULT_REQUEST_TIMEOUT_MS = 120_000;
const INVENTORY_ADVISORY_LOCK_TIMEOUT_MS = 10_000;
const DATABASE_COMPLETION_MARGIN_MS = 10_000;
const MQTT_ISSUANCE_TRANSACTION_TIMEOUT_MS =
  MAX_VAULT_REQUEST_TIMEOUT_MS + INVENTORY_ADVISORY_LOCK_TIMEOUT_MS + DATABASE_COMPLETION_MARGIN_MS;
const MQTT_ISSUANCE_TRANSACTION_MAX_WAIT_MS = MQTT_ISSUANCE_TRANSACTION_TIMEOUT_MS;

interface IssueMqttCertificateInput {
  csrPem?: unknown;
  deviceCertificateFingerprint?: unknown;
}

@Injectable()
export class GatewayCertificateService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CERTIFICATE_AUTHORITY_PROVIDER) private readonly certificateAuthority: CertificateAuthorityProvider,
    private readonly csrValidator: GatewayCsrValidator
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
    try {
      const issuance = await this.db().$transaction(async (tx: any) => {
        // Keep the advisory-lock wait finite within this transaction, and bind both dynamic values.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${INVENTORY_ADVISORY_LOCK_TIMEOUT_MS}ms`}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${inventory.id}::text, 0))`;
        signed = await this.certificateAuthority.signCsr({
          purpose: "mqtt",
          csrPem,
          commonName: inventory.claimedGateway.id,
          uriSans: [`urn:dfkorea:gateway:${inventory.claimedGateway.id}`],
          ttlSeconds: MQTT_CERTIFICATE_TTL_SECONDS
        });
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

        return { signed, certificateData };
      }, {
        maxWait: MQTT_ISSUANCE_TRANSACTION_MAX_WAIT_MS,
        timeout: MQTT_ISSUANCE_TRANSACTION_TIMEOUT_MS
      });

      return {
        gatewayId: inventory.claimedGateway.id,
        certificatePem: issuance.signed.certificatePem,
        caChainPem: issuance.signed.caChainPem,
        notAfter: issuance.certificateData.notAfter.toISOString()
      };
    } catch {
      if (signed) await this.bestEffortRevoke(signed);
      throw new ServiceUnavailableException("MQTT certificate issuance failed");
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
      // A later lifecycle reconciliation can retry when CA revocation is temporarily unavailable.
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
