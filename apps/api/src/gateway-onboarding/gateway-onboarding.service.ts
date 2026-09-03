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
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CertificateLifecycleService } from "../pki/certificate-lifecycle.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";

const scrypt = promisify(scryptCallback);
const CLAIM_KEY_LENGTH = 64;
const CLAIM_WINDOW_MS = 15 * 60 * 1000;
const CLAIM_FAILURE_LIMIT = 5;

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

type ClaimFailureReason = "invalid_claim_code" | "inventory_unavailable" | "already_consumed" | "rate_limited";

type ClaimDecision =
  | { outcome: "claimed"; value: { status: "claimed"; gatewayId: string; siteId: string; serialNumber: string } }
  | { outcome: "failed"; reason: ClaimFailureReason };

@Injectable()
export class GatewayOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    @Optional() private readonly certificateLifecycle?: CertificateLifecycleService
  ) {}

  async claimGateway(user: AuthenticatedUser, input: ClaimGatewayInput) {
    this.assertActiveCustomerAdmin(user);
    await this.siteAccess.assert(user, input.siteId, "commission");
    const serialNumber = this.requireText(input.serialNumber, "serialNumber is required");
    const name = this.requireText(input.name, "gateway name is required");
    const claimCode = this.requireText(input.claimCode, "claimCode is required");

    // Inventory를 Gateway로 바꾸고 claim code를 소비하는 일을 한 transaction에서 확정한다.
    // Pi bootstrap과 중복 claim 요청이 서로 다른 소유자를 보지 않게 하며, commit 뒤 bootstrap 계층은 한 Gateway 배정만 읽는다.
    const decision: ClaimDecision = await this.db().$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`
        SELECT true AS "locked"
        FROM pg_advisory_xact_lock(hashtextextended(${serialNumber}::text, 0))
      `;
      await this.siteAccess.assertCommissionInTransaction(tx, user, input.siteId);

      const recentFailures = await tx.gatewayClaimAudit.count({
        where: {
          serialNumber,
          outcome: "failed",
          createdAt: { gte: new Date(Date.now() - CLAIM_WINDOW_MS) }
        }
      });
      if (recentFailures >= CLAIM_FAILURE_LIMIT) {
        const rateLimitedInventory = await tx.gatewayInventory.findUnique({
          where: { serialNumber },
          select: { id: true }
        });
        await this.recordClaimAudit(tx, input, user.id, serialNumber, "rate_limited", rateLimitedInventory?.id);
        return { outcome: "failed", reason: "rate_limited" };
      }

      await tx.$queryRaw`SELECT "id" FROM "GatewayInventory" WHERE "serialNumber" = ${serialNumber} FOR UPDATE`;
      const inventory = await tx.gatewayInventory.findUnique({ where: { serialNumber } });
      if (!inventory || inventory.disabledAt) {
        await this.recordClaimAudit(tx, input, user.id, serialNumber, "inventory_unavailable", inventory?.id);
        return { outcome: "failed", reason: "inventory_unavailable" };
      }
      if (inventory.claimedGatewayId || !inventory.claimCodeHash) {
        await this.recordClaimAudit(tx, input, user.id, serialNumber, "already_consumed", inventory.id);
        return { outcome: "failed", reason: "already_consumed" };
      }
      const claimCodeHash = inventory.claimCodeHash;
      if (!(await this.verifyClaimCode(claimCode, claimCodeHash))) {
        await this.recordClaimAudit(tx, input, user.id, serialNumber, "invalid_claim_code", inventory.id);
        return { outcome: "failed", reason: "invalid_claim_code" };
      }

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
        where: { id: inventory.id, claimedGatewayId: null, claimCodeHash, disabledAt: null },
        data: { claimedGatewayId: gateway.id, claimedAt, claimCodeHash: null }
      });
      if (consumed.count !== 1) throw new ConflictException("gateway claim was already consumed");
      await this.recordClaimAudit(tx, input, user.id, serialNumber, null, inventory.id, "claimed");
      return {
        outcome: "claimed",
        value: { status: "claimed", gatewayId: gateway.id, siteId: gateway.siteId, serialNumber: gateway.serialNumber }
      };
    });
    if (decision.outcome === "claimed") return decision.value;
    if (decision.reason === "already_consumed") throw new ConflictException("gateway is already claimed");
    if (decision.reason === "rate_limited") {
      throw new HttpException("too many gateway claim attempts", HttpStatus.TOO_MANY_REQUESTS);
    }
    throw new UnauthorizedException("gateway claim failed");
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

  async disableInventory(user: AuthenticatedUser, inventoryId: string) {
    this.assertServiceProviderOperator(user);
    const id = this.requireText(inventoryId, "inventoryId is required");
    const inventory = await this.db().$transaction(async (tx: any) => {
      const current = await tx.gatewayInventory.findFirst({ where: { id } });
      if (!current) throw new NotFoundException("inventory not found");
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

  private async recordClaimAudit(
    tx: Pick<Prisma.TransactionClient, "gatewayClaimAudit">,
    input: ClaimGatewayInput,
    requestedBy: string,
    serialNumber: string,
    reason: ClaimFailureReason | null,
    inventoryId?: string,
    outcome: "claimed" | "failed" = "failed"
  ) {
    await tx.gatewayClaimAudit.create({
      data: {
        inventoryId: inventoryId ?? null,
        siteId: input.siteId || null,
        requestedBy,
        serialNumber,
        outcome,
        reason,
        ipAddress: input.ipAddress ?? null
      }
    });
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

  private assertActiveCustomerAdmin(user: AuthenticatedUser) {
    if (user.role !== "admin" || user.status !== "active" || user.organizationType !== "customer") {
      throw new NotFoundException("site not found");
    }
  }

  private assertServiceProviderOperator(user: AuthenticatedUser) {
    if (user.role !== "operator" || user.status !== "active" || user.organizationType !== "service_provider") {
      throw new ForbiddenException("inventory disable requires an active service-provider operator");
    }
  }
}
