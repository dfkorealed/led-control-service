import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { editorLeaseTtlMs, editorLeaseTtlSeconds, hashEditorLeaseToken } from "./editor-lease-token";

export const editorLeaseRenewScript = `
  local lease = redis.call("GET", KEYS[1])
  if not lease then return 0 end
  local decoded = cjson.decode(lease)
  if decoded.token ~= ARGV[1] then return 0 end
  return redis.call("EXPIRE", KEYS[1], ARGV[2])
`;
export const editorLeaseReleaseScript = `
  local lease = redis.call("GET", KEYS[1])
  if not lease then return 0 end
  local decoded = cjson.decode(lease)
  if decoded.token ~= ARGV[1] then return 0 end
  return redis.call("DEL", KEYS[1])
`;

interface StoredEditorLease {
  userId: string;
  userName: string;
  token: string;
  fence: number;
  acquiredAt: string;
}

export interface EditorLeaseResult {
  editable: boolean;
  token?: string;
  fence?: number;
  holderName?: string;
  acquiredAt?: string;
}

@Injectable()
export class EditorLeaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly auditService: AuditService,
    private readonly redisProvider: RedisProvider
  ) {}

  async acquire(floorId: string, user: AuthenticatedUser, token?: string): Promise<EditorLeaseResult> {
    await this.assertManageAccess(floorId, user);
    if (token) return this.renew(floorId, user, token);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidate = {
        userId: user.id,
        userName: user.name,
        token: randomUUID()
      };
      const result = await this.prisma.$transaction(async (tx) => {
        const floor = await tx.floor.findUnique({
          where: { id: floorId },
          select: this.leaseAuthoritySelect
        });
        if (!floor) throw new NotFoundException("floor not found");
        if (this.isLeaseActive(floor)) return { kind: "read-only" as const, floor };

        const fence = floor.editorLeaseFence + 1;
        const acquiredAt = new Date();
        const expiresAt = new Date(acquiredAt.getTime() + editorLeaseTtlMs);
        const updated = await tx.floor.updateMany({
          where: { id: floorId, editorLeaseFence: floor.editorLeaseFence },
          data: {
            editorLeaseFence: fence,
            editorLeaseTokenHash: hashEditorLeaseToken(candidate.token),
            editorLeaseHolderId: candidate.userId,
            editorLeaseHolderName: candidate.userName,
            editorLeaseAcquiredAt: acquiredAt,
            editorLeaseExpiresAt: expiresAt
          }
        });
        if (updated.count !== 1) return { kind: "retry" as const };
        return {
          kind: "editable" as const,
          lease: { ...candidate, fence, acquiredAt: acquiredAt.toISOString() }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      if (result.kind === "editable") {
        await this.writeLeaseCache(floorId, result.lease);
        return this.editable(result.lease);
      }
      if (result.kind === "read-only") return this.readOnly(this.toStoredLease(result.floor));
    }

    return this.readOnly(await this.readLeaseAuthority(floorId));
  }

  async release(floorId: string, user: AuthenticatedUser, force: boolean, token?: string) {
    const access = await this.assertManageAccess(floorId, user);
    const authority = await this.loadLeaseAuthority(floorId);
    const holder = this.toStoredLease(authority);
    if (!authority || !holder) return { released: false };

    if (force) {
      if (user.role !== "operator" && user.role !== "admin") {
        throw new ForbiddenException("floor editor lease force release requires operator or admin role");
      }
      await this.recordForceReleaseAudit(access, user, floorId, holder, "floor_editor.lease_force_release_requested", "attempted");
      const released = await this.forceInvalidateLease(floorId, holder.fence);
      await this.recordForceReleaseAudit(
        access,
        user,
        floorId,
        holder,
        released ? "floor_editor.lease_force_released" : "floor_editor.lease_force_release_not_applied",
        released ? "success" : "stale_token"
      );
      return { released };
    }

    if (!token || holder.userId !== user.id || authority.editorLeaseTokenHash !== hashEditorLeaseToken(token)) {
      throw new ForbiddenException("floor editor lease is held by another user");
    }
    return { released: await this.releaseOwnedLease(floorId, user.id, holder.fence, token) };
  }

  private async renew(floorId: string, user: AuthenticatedUser, token: string): Promise<EditorLeaseResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authority = await this.prisma.$transaction(async (tx) => {
        const floor = await tx.floor.findUnique({
          where: { id: floorId },
          select: this.leaseAuthoritySelect
        });
        if (!floor) throw new NotFoundException("floor not found");
        if (!this.isLeaseActive(floor)) return { kind: "read-only" as const, floor };
        if (floor.editorLeaseHolderId !== user.id || floor.editorLeaseTokenHash !== hashEditorLeaseToken(token)) {
          return { kind: "read-only" as const, floor };
        }

        const expiresAt = new Date(Date.now() + editorLeaseTtlMs);
        const updated = await tx.floor.updateMany({
          where: {
            id: floorId,
            editorLeaseFence: floor.editorLeaseFence,
            editorLeaseHolderId: user.id,
            editorLeaseTokenHash: hashEditorLeaseToken(token)
          },
          data: { editorLeaseExpiresAt: expiresAt }
        });
        if (updated.count !== 1) return { kind: "retry" as const };
        return {
          kind: "editable" as const,
          lease: {
            userId: user.id,
            userName: floor.editorLeaseHolderName ?? user.name,
            token,
            fence: floor.editorLeaseFence,
            acquiredAt: floor.editorLeaseAcquiredAt?.toISOString() ?? new Date().toISOString()
          }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      if (authority.kind === "editable") {
        await this.redisProvider.getClient().eval(
          editorLeaseRenewScript,
          1,
          this.key(floorId),
          token,
          String(editorLeaseTtlSeconds)
        );
        await this.writeLeaseCache(floorId, authority.lease);
        return this.editable(authority.lease);
      }
      if (authority.kind === "read-only") return this.readOnly(this.toStoredLease(authority.floor));
    }

    return this.readOnly(await this.readLeaseAuthority(floorId));
  }

  private async releaseOwnedLease(floorId: string, userId: string, fence: number, token: string) {
    const released = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.floor.updateMany({
        where: {
          id: floorId,
          editorLeaseFence: fence,
          editorLeaseHolderId: userId,
          editorLeaseTokenHash: hashEditorLeaseToken(token)
        },
        data: {
          editorLeaseFence: { increment: 1 },
          editorLeaseTokenHash: null,
          editorLeaseHolderId: null,
          editorLeaseHolderName: null,
          editorLeaseAcquiredAt: null,
          editorLeaseExpiresAt: null
        }
      });
      return updated.count === 1;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (released) {
      await this.redisProvider.getClient().eval(editorLeaseReleaseScript, 1, this.key(floorId), token);
    }
    return released;
  }

  private async forceInvalidateLease(floorId: string, fence: number) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.floor.updateMany({
        where: { id: floorId, editorLeaseFence: fence },
        data: {
          editorLeaseFence: { increment: 1 },
          editorLeaseTokenHash: null,
          editorLeaseHolderId: null,
          editorLeaseHolderName: null,
          editorLeaseAcquiredAt: null,
          editorLeaseExpiresAt: null
        }
      });
      if (updated.count === 1) {
        await this.redisProvider.getClient().del(this.key(floorId));
        return true;
      }
      return false;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async assertManageAccess(floorId: string, user: AuthenticatedUser) {
    const floor = await this.prisma.floor.findUnique({ where: { id: floorId }, select: { id: true, siteId: true } });
    if (!floor) throw new NotFoundException("floor not found");
    return this.siteAccess.assert(user, floor.siteId, "manage");
  }

  private recordForceReleaseAudit(
    access: { id: string; organizationId: string },
    user: AuthenticatedUser,
    floorId: string,
    holder: StoredEditorLease,
    action: string,
    outcome: string
  ) {
    return this.auditService.record({
      organizationId: access.organizationId,
      siteId: access.id,
      actorId: user.id,
      action,
      targetType: "floor",
      targetId: floorId,
      outcome,
      metadata: { leaseHolderId: holder.userId, acquiredAt: holder.acquiredAt }
    });
  }

  private async readLeaseAuthority(floorId: string): Promise<StoredEditorLease | null> {
    return this.toStoredLease(await this.loadLeaseAuthority(floorId));
  }

  private loadLeaseAuthority(floorId: string) {
    return this.prisma.floor.findUnique({
      where: { id: floorId },
      select: this.leaseAuthoritySelect
    });
  }

  private key(floorId: string) {
    return `floor-editor:lease:${floorId}`;
  }

  private editable(lease: StoredEditorLease): EditorLeaseResult {
    return { editable: true, token: lease.token, fence: lease.fence, holderName: lease.userName, acquiredAt: lease.acquiredAt };
  }

  private readOnly(lease: StoredEditorLease | null): EditorLeaseResult {
    return lease ? { editable: false, fence: lease.fence, holderName: lease.userName, acquiredAt: lease.acquiredAt } : { editable: false };
  }

  private async writeLeaseCache(floorId: string, lease: StoredEditorLease) {
    await this.redisProvider.getClient().set(this.key(floorId), JSON.stringify(lease), "EX", editorLeaseTtlSeconds);
  }

  private isLeaseActive(floor: {
    editorLeaseTokenHash: string | null;
    editorLeaseHolderId: string | null;
    editorLeaseHolderName: string | null;
    editorLeaseAcquiredAt: Date | null;
    editorLeaseExpiresAt: Date | null;
    editorLeaseFence: number;
  }) {
    return Boolean(
      floor.editorLeaseTokenHash &&
      floor.editorLeaseHolderId &&
      floor.editorLeaseHolderName &&
      floor.editorLeaseAcquiredAt &&
      floor.editorLeaseExpiresAt &&
      floor.editorLeaseExpiresAt.getTime() > Date.now()
    );
  }

  private toStoredLease(
    floor: {
      editorLeaseTokenHash: string | null;
      editorLeaseHolderId: string | null;
      editorLeaseHolderName: string | null;
      editorLeaseAcquiredAt: Date | null;
      editorLeaseExpiresAt: Date | null;
      editorLeaseFence: number;
    } | null
  ): StoredEditorLease | null {
    if (!floor || !this.isLeaseActive(floor)) return null;
    return {
      userId: floor.editorLeaseHolderId!,
      userName: floor.editorLeaseHolderName!,
      token: "",
      fence: floor.editorLeaseFence,
      acquiredAt: floor.editorLeaseAcquiredAt!.toISOString()
    };
  }

  private readonly leaseAuthoritySelect = {
    editorLeaseFence: true,
    editorLeaseTokenHash: true,
    editorLeaseHolderId: true,
    editorLeaseHolderName: true,
    editorLeaseAcquiredAt: true,
    editorLeaseExpiresAt: true
  } satisfies Prisma.FloorSelect;
}
