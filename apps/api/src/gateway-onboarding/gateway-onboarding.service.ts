import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { PrismaService } from "../prisma/prisma.service";
import { CertificateLifecycleService } from "../pki/certificate-lifecycle.service";

const scrypt = promisify(scryptCallback);
const CLAIM_KEY_LENGTH = 64;
const CLAIM_WINDOW_MS = 15 * 60 * 1000;
const CLAIM_FAILURE_LIMIT = 5;

interface ClaimingUser {
  id: string;
  organizationId: string;
  role: string;
}

interface ClaimGatewayInput {
  siteId: string;
  serialNumber: string;
  claimCode: string;
  name: string;
  ipAddress?: string;
}

interface BootstrapGatewayInput {
  serialNumber: string;
  certificateFingerprint: string;
}

@Injectable()
export class GatewayOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly certificateLifecycle?: CertificateLifecycleService
  ) {}

  async claimGateway(user: ClaimingUser, input: ClaimGatewayInput) {
    if (!new Set(["owner", "admin"]).has(user.role)) throw new ForbiddenException("gateway claim requires owner or admin role");
    const serialNumber = this.requireText(input.serialNumber, "serialNumber is required");
    const name = this.requireText(input.name, "gateway name is required");
    const claimCode = this.requireText(input.claimCode, "claimCode is required");

    const recentFailures = await this.db().gatewayClaimAudit.count({
      where: {
        serialNumber,
        outcome: "failed",
        createdAt: { gte: new Date(Date.now() - CLAIM_WINDOW_MS) }
      }
    });
    if (recentFailures >= CLAIM_FAILURE_LIMIT) {
      throw new HttpException("too many gateway claim attempts", HttpStatus.TOO_MANY_REQUESTS);
    }

    const [site, inventory] = await Promise.all([
      this.db().site.findFirst({ where: { id: input.siteId, organizationId: user.organizationId } }),
      this.db().gatewayInventory.findUnique({ where: { serialNumber } })
    ]);
    if (!site) throw new BadRequestException("site not found in the user's organization");
    if (!inventory || inventory.disabledAt) return this.rejectClaim(input, user.id, "gateway inventory is unavailable");
    if (inventory.claimedGatewayId || !inventory.claimCodeHash) throw new ConflictException("gateway is already claimed");
    if (!(await this.verifyClaimCode(claimCode, inventory.claimCodeHash))) {
      return this.rejectClaim(input, user.id, "invalid gateway claim code", inventory.id);
    }

    return this.db().$transaction(async (tx: any) => {
      const claimedAt = new Date();
      const gateway = await tx.gateway.create({
        data: {
          siteId: input.siteId,
          name,
          serialNumber,
          firmwareVersion: "bootstrap-pending",
          certificateFingerprint: inventory.certificateFingerprint,
          assignmentVersion: 1,
          claimedAt
        }
      });
      const consumed = await tx.gatewayInventory.updateMany({
        where: { id: inventory.id, claimedGatewayId: null, claimCodeHash: { not: null }, disabledAt: null },
        data: { claimedGatewayId: gateway.id, claimedAt, claimCodeHash: null }
      });
      if (consumed.count !== 1) throw new ConflictException("gateway claim was already consumed");
      await tx.gatewayClaimAudit.create({
        data: {
          inventoryId: inventory.id,
          siteId: input.siteId,
          requestedBy: user.id,
          serialNumber,
          outcome: "claimed",
          ipAddress: input.ipAddress ?? null
        }
      });
      return { status: "claimed" as const, gatewayId: gateway.id, siteId: gateway.siteId, serialNumber: gateway.serialNumber };
    });
  }

  async bootstrapGateway(input: BootstrapGatewayInput) {
    const serialNumber = this.requireText(input.serialNumber, "serialNumber is required");
    const fingerprint = this.normalizeFingerprint(input.certificateFingerprint);
    const inventory = await this.db().gatewayInventory.findUnique({
      where: { serialNumber },
      include: { claimedGateway: true }
    });
    if (!inventory || inventory.disabledAt || this.normalizeFingerprint(inventory.certificateFingerprint) !== fingerprint) {
      throw new UnauthorizedException("device certificate mismatch");
    }
    if (!inventory.claimedGateway) return { status: "unclaimed" as const, retryAfterSeconds: 10 };

    return {
      status: "assigned" as const,
      assignment: {
        siteId: inventory.claimedGateway.siteId,
        gatewayId: inventory.claimedGateway.id,
        serialNumber,
        mqttUrl: process.env.MQTT_PUBLIC_URL ?? "mqtts://localhost:8883",
        configVersion: inventory.claimedGateway.assignmentVersion
      }
    };
  }

  async disableInventory(user: ClaimingUser, inventoryId: string) {
    if (!new Set(["owner", "admin"]).has(user.role)) throw new ForbiddenException("inventory disable requires owner or admin role");
    const id = this.requireText(inventoryId, "inventoryId is required");
    const inventory = await this.db().$transaction(async (tx: any) => {
      const current = await tx.gatewayInventory.findFirst({
        where: { id, claimedGateway: { site: { organizationId: user.organizationId } } }
      });
      if (!current) throw new NotFoundException("inventory not found in the user's organization");
      if (current.disabledAt) return current;
      return tx.gatewayInventory.update({ where: { id: current.id }, data: { disabledAt: new Date() } });
    });
    if (!this.certificateLifecycle) throw new ServiceUnavailableException("inventory certificate revocation pending");
    try {
      const result = await this.certificateLifecycle.revokeInventoryCertificates(inventory.id);
      return { status: "disabled" as const, revoked: result.revoked };
    } catch {
      throw new ServiceUnavailableException("inventory disabled; certificate revocation pending");
    }
  }

  async hashClaimCode(claimCode: string) {
    const value = this.requireText(claimCode, "claimCode is required");
    const salt = randomBytes(16).toString("hex");
    const key = (await scrypt(value, salt, CLAIM_KEY_LENGTH)) as Buffer;
    return `scrypt$${salt}$${key.toString("hex")}`;
  }

  async verifyClaimCode(claimCode: string, claimCodeHash: string) {
    const [algorithm, salt, storedHex] = claimCodeHash.split("$");
    if (algorithm !== "scrypt" || !salt || !storedHex) return false;
    const stored = Buffer.from(storedHex, "hex");
    const candidate = (await scrypt(claimCode, salt, CLAIM_KEY_LENGTH)) as Buffer;
    return stored.length === candidate.length && timingSafeEqual(stored, candidate);
  }

  private async rejectClaim(input: ClaimGatewayInput, requestedBy: string, reason: string, inventoryId?: string): Promise<never> {
    await this.db().gatewayClaimAudit.create({
      data: {
        inventoryId: inventoryId ?? null,
        siteId: input.siteId || null,
        requestedBy,
        serialNumber: input.serialNumber.trim(),
        outcome: "failed",
        reason,
        ipAddress: input.ipAddress ?? null
      }
    });
    throw new UnauthorizedException("gateway claim failed");
  }

  private requireText(value: string, message: string) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(message);
    return value.trim();
  }

  private normalizeFingerprint(value: string) {
    return this.requireText(value, "certificate fingerprint is required").replace(/:/g, "").toUpperCase();
  }

  private db() {
    return this.prisma as any;
  }
}
