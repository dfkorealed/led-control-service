import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import { PrismaService } from "../prisma/prisma.service";
import {
  CERTIFICATE_AUTHORITY_PROVIDER,
  type CertificateAuthorityProvider
} from "./certificate-authority.provider";
import { GatewayCsrValidator } from "./csr-validator";
import type { SignedCertificate } from "./pki.types";

const scrypt = promisify(scryptCallback);
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const DEVICE_CERTIFICATE_TTL_SECONDS = 365 * 24 * 60 * 60;
const SECRET_HASH_BYTES = 64;
const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENROLLMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENROLLMENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT_HASH_PATTERN = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

export const MANUFACTURING_ENROLLMENT_CONFIGURATION = Symbol("MANUFACTURING_ENROLLMENT_CONFIGURATION");

export interface ManufacturingEnrollmentConfiguration {
  apiCaBundlePem: string | null;
  mqttCaBundlePem: string | null;
  manufacturingCaFingerprint: string | null;
}

interface CreateEnrollmentInput {
  serialNumber: string;
  stationIdentity: string;
}

interface EnrollDeviceInput {
  serialNumber: string;
  token: string;
  csrPem: string;
}

@Injectable()
export class ManufacturingEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CERTIFICATE_AUTHORITY_PROVIDER) private readonly certificateAuthority: CertificateAuthorityProvider,
    private readonly csrValidator: GatewayCsrValidator,
    @Inject(MANUFACTURING_ENROLLMENT_CONFIGURATION)
    private readonly configuration: ManufacturingEnrollmentConfiguration
  ) {}

  async createEnrollment(input: CreateEnrollmentInput) {
    const serialNumber = this.requireSerial(input.serialNumber);
    const stationIdentity = this.requireText(input.stationIdentity, "manufacturing station identity is required", 1024);
    const enrollmentId = randomUUID();
    const enrollmentSecret = randomBytes(32).toString("base64url");
    const enrollmentToken = `${enrollmentId}.${enrollmentSecret}`;
    const tokenHash = await this.hashSecret(enrollmentSecret);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);

    try {
      await this.db().$transaction(async (tx: any) => {
        const inventory = await tx.gatewayInventory.upsert({
          where: { serialNumber },
          create: { serialNumber },
          update: { updatedAt: now }
        });
        this.assertInventoryCanEnroll(inventory);

        await tx.gatewayEnrollment.updateMany({
          where: { serialNumber, usedAt: null },
          data: { usedAt: now, outcome: "superseded", failureReason: null }
        });
        await tx.gatewayEnrollment.create({
          data: { id: enrollmentId, serialNumber, tokenHash, expiresAt, stationIdentity }
        });
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException("active gateway enrollment already exists");
      }
      throw error;
    }

    return { serialNumber, enrollmentToken, expiresAt: expiresAt.toISOString() };
  }

  async enrollDevice(input: EnrollDeviceInput) {
    const serialNumber = this.requireSerial(input.serialNumber);
    const csrPem = this.requireText(input.csrPem, "CSR is required", 16 * 1024);
    const parsedToken = this.parseEnrollmentToken(input.token);
    if (!parsedToken) return this.rejectInactiveToken();

    const enrollment = await this.db().gatewayEnrollment.findUnique({ where: { id: parsedToken.id } });
    if (!enrollment) return this.rejectInactiveToken();
    if (!(await this.verifySecret(parsedToken.secret, enrollment.tokenHash))) return this.rejectInactiveToken();

    const now = new Date();
    if (enrollment.usedAt) return this.rejectInactiveToken();
    if (enrollment.serialNumber !== serialNumber) {
      await this.terminateActiveEnrollment(enrollment.id, "serial_mismatch", now);
      return this.rejectInactiveToken();
    }
    if (enrollment.expiresAt <= now) {
      await this.terminateActiveEnrollment(enrollment.id, "token_expired", now);
      return this.rejectInactiveToken();
    }

    const consumed = await this.db().gatewayEnrollment.updateMany({
      where: {
        id: enrollment.id,
        serialNumber,
        usedAt: null,
        outcome: null,
        expiresAt: { gt: now }
      },
      data: { usedAt: now, outcome: "processing", failureReason: null }
    });
    if (consumed.count !== 1) return this.rejectInactiveToken();

    const inventory = await this.db().gatewayInventory.findUnique({ where: { serialNumber } });
    if (!inventory || inventory.disabledAt || inventory.claimedGatewayId || inventory.certificateFingerprint) {
      await this.recordFailure(enrollment.id, "inventory_unavailable");
      throw new ConflictException("gateway inventory is unavailable");
    }

    try {
      await this.csrValidator.validate(csrPem);
    } catch (error) {
      await this.recordFailure(enrollment.id, "csr_invalid");
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("CSR is invalid");
    }

    if (!this.configuration.apiCaBundlePem || !this.configuration.mqttCaBundlePem) {
      await this.recordFailure(enrollment.id, "ca_bundle_unavailable");
      throw new ServiceUnavailableException("device certificate enrollment failed");
    }

    let signed: SignedCertificate;
    try {
      signed = await this.certificateAuthority.signCsr({
        purpose: "device",
        csrPem,
        commonName: serialNumber,
        uriSans: [`urn:dfkorea:gateway:${serialNumber}`],
        ttlSeconds: DEVICE_CERTIFICATE_TTL_SECONDS
      });
    } catch {
      await this.recordFailure(enrollment.id, "certificate_signing_failed");
      throw new ServiceUnavailableException("device certificate enrollment failed");
    }

    let deviceCaBundlePem: string;
    try {
      deviceCaBundlePem = buildDeviceCaBundle(signed.caChainPem);
    } catch {
      await this.bestEffortRevoke(signed);
      await this.recordFailure(enrollment.id, "certificate_signing_failed");
      throw new ServiceUnavailableException("device certificate enrollment failed");
    }

    let claimCode = "";
    try {
      const certificateData = this.certificateData(inventory.id, signed);
      await this.db().$transaction(async (tx: any) => {
        claimCode = randomBytes(32).toString("base64url");
        const claimCodeHash = await this.hashClaimCode(claimCode);
        await tx.gatewayCertificate.create({ data: certificateData });
        const updatedInventory = await tx.gatewayInventory.updateMany({
          where: {
            id: inventory.id,
            claimedGatewayId: null,
            disabledAt: null,
            certificateFingerprint: null
          },
          data: { certificateFingerprint: certificateData.fingerprint, claimCodeHash }
        });
        if (updatedInventory.count !== 1) throw new Error("inventory state changed during certificate enrollment");
        await tx.gatewayEnrollment.update({
          where: { id: enrollment.id },
          data: { outcome: "issued", failureReason: null }
        });
      });
    } catch {
      await this.bestEffortRevoke(signed);
      await this.recordFailure(enrollment.id, "persistence_failed");
      throw new ServiceUnavailableException("device certificate enrollment failed");
    }

    return {
      deviceCertificatePem: signed.certificatePem,
      deviceCaBundlePem,
      apiCaBundlePem: this.configuration.apiCaBundlePem,
      mqttCaBundlePem: this.configuration.mqttCaBundlePem,
      claimCode
    };
  }

  private assertInventoryCanEnroll(inventory: any) {
    if (inventory.disabledAt) throw new ConflictException("gateway inventory is disabled");
    if (inventory.claimedGatewayId) throw new ConflictException("gateway inventory is already claimed");
    if (inventory.certificateFingerprint) throw new ConflictException("gateway already has a device certificate");
  }

  private certificateData(inventoryId: string, signed: SignedCertificate) {
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
      purpose: "device" as const,
      certificateSerial,
      fingerprint,
      issuer,
      notBefore,
      notAfter,
      status: "active" as const
    };
  }

  private async recordFailure(enrollmentId: string, failureReason: string) {
    try {
      await this.db().gatewayEnrollment.update({
        where: { id: enrollmentId },
        data: { outcome: "failed", failureReason }
      });
    } catch {
      // Failure recording is best-effort when the database itself is unavailable.
    }
  }

  private async terminateActiveEnrollment(enrollmentId: string, failureReason: string, now: Date) {
    await this.db().gatewayEnrollment.updateMany({
      where: { id: enrollmentId, usedAt: null, outcome: null },
      data: { usedAt: now, outcome: "failed", failureReason }
    });
  }

  private async bestEffortRevoke(signed: SignedCertificate) {
    try {
      await this.certificateAuthority.revoke({
        purpose: "device",
        certificateSerial: signed.certificateSerial,
        issuer: signed.issuer,
        fingerprint: signed.fingerprint
      });
    } catch {
      // The consumed token remains unusable; lifecycle reconciliation can retry revocation.
    }
  }

  private async hashSecret(secret: string) {
    const salt = randomBytes(16).toString("hex");
    const key = (await scrypt(secret, salt, SECRET_HASH_BYTES)) as Buffer;
    return `scrypt$${salt}$${key.toString("hex")}`;
  }

  private async verifySecret(secret: string, storedHash: string) {
    const match = SCRYPT_HASH_PATTERN.exec(storedHash);
    if (!match) return false;

    const stored = Buffer.from(match[2], "hex");
    const candidate = (await scrypt(secret, match[1], SECRET_HASH_BYTES)) as Buffer;
    return timingSafeEqual(stored, candidate);
  }

  private async hashClaimCode(claimCode: string) {
    return this.hashSecret(claimCode);
  }

  private parseEnrollmentToken(value: unknown) {
    if (typeof value !== "string") return null;
    const token = value.trim();
    const separator = token.indexOf(".");
    if (separator === -1 || separator !== token.lastIndexOf(".")) return null;

    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!ENROLLMENT_ID_PATTERN.test(id) || !ENROLLMENT_SECRET_PATTERN.test(secret)) return null;
    if (Buffer.from(secret, "base64url").toString("base64url") !== secret) return null;
    return { id, secret };
  }

  private requireSerial(value: string) {
    const serialNumber = this.requireText(value, "serialNumber is required", 128);
    if (!SERIAL_PATTERN.test(serialNumber)) throw new BadRequestException("serialNumber has an invalid format");
    return serialNumber;
  }

  private requireText(value: string, message: string, maxLength: number) {
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxLength) {
      throw new BadRequestException(message);
    }
    return value.trim();
  }

  private rejectInactiveToken(): never {
    throw new UnauthorizedException("enrollment token is not active");
  }

  private isUniqueConstraintError(error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
  }

  private db() {
    return this.prisma as any;
  }
}

function buildDeviceCaBundle(caChainPem: readonly string[]) {
  if (!Array.isArray(caChainPem) || caChainPem.length === 0) {
    throw new Error("device CA chain is invalid");
  }

  return caChainPem.map((value) => {
    if (typeof value !== "string" || value.includes("PRIVATE KEY")) {
      throw new Error("device CA chain is invalid");
    }
    const certificatePem = value.trim();
    const certificates = certificatePem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates || certificates.length !== 1 || certificates[0] !== certificatePem) {
      throw new Error("device CA chain is invalid");
    }
    new X509Certificate(certificatePem);
    return certificatePem;
  }).join("\n");
}
