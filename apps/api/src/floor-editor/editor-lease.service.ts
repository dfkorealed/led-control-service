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

interface LockedLeaseAuthorityRow {
  id: string;
  editorLeaseFence: number;
  editorLeaseTokenHash: string | null;
  editorLeaseHolderId: string | null;
  editorLeaseHolderName: string | null;
  editorLeaseAcquiredAt: Date | null;
  editorLeaseExpiresAt: Date | null;
  dbNow: Date;
}

type LeaseAuthoritySnapshot = Omit<LockedLeaseAuthorityRow, "id" | "dbNow"> & { id?: string; dbNow?: Date };

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
        const floor = await this.lockLeaseAuthority(tx, floorId);
        if (!floor) throw new NotFoundException("floor not found");
        if (this.isLeaseActive(floor)) return { kind: "read-only" as const, floor };
        if (floor.editorLeaseFence >= 2_147_483_647) throw new ForbiddenException("floor editor lease fence overflow");

        const fence = floor.editorLeaseFence + 1;
        const acquiredAt = floor.dbNow;
        const expiresAt = new Date(acquiredAt.getTime() + editorLeaseTtlMs);
        await tx.floor.update({
          where: { id: floorId },
          data: {
            editorLeaseFence: fence,
            editorLeaseTokenHash: hashEditorLeaseToken(candidate.token),
            editorLeaseHolderId: candidate.userId,
            editorLeaseHolderName: candidate.userName,
            editorLeaseAcquiredAt: acquiredAt,
            editorLeaseExpiresAt: expiresAt
          }
        });
        return {
          kind: "editable" as const,
          lease: { ...candidate, fence, acquiredAt: acquiredAt.toISOString() }
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      if (result.kind === "editable") {
        await this.tryWriteLeaseCache(floorId, result.lease);
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
        const floor = await this.lockLeaseAuthority(tx, floorId);
        if (!floor) throw new NotFoundException("floor not found");
        if (!this.isLeaseActive(floor)) return { kind: "read-only" as const, floor };
        if (floor.editorLeaseHolderId !== user.id || floor.editorLeaseTokenHash !== hashEditorLeaseToken(token)) {
          return { kind: "read-only" as const, floor };
        }

        const expiresAt = new Date(floor.dbNow.getTime() + editorLeaseTtlMs);
        await tx.floor.update({
          where: { id: floorId },
          data: { editorLeaseExpiresAt: expiresAt }
        });
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
        await this.tryRenewLeaseCache(floorId, token);
        await this.tryWriteLeaseCache(floorId, authority.lease);
        return this.editable(authority.lease);
      }
      if (authority.kind === "read-only") return this.readOnly(this.toStoredLease(authority.floor));
    }

    return this.readOnly(await this.readLeaseAuthority(floorId));
  }

  private async releaseOwnedLease(floorId: string, userId: string, fence: number, token: string) {
    const released = await this.prisma.$transaction(async (tx) => {
      const floor = await this.lockLeaseAuthority(tx, floorId);
      if (!floor) return false;
      if (
        floor.editorLeaseFence !== fence ||
        floor.editorLeaseHolderId !== userId ||
        floor.editorLeaseTokenHash !== hashEditorLeaseToken(token)
      ) {
        return false;
      }
      if (floor.editorLeaseFence >= 2_147_483_647) throw new ForbiddenException("floor editor lease fence overflow");
      await tx.floor.update({
        where: { id: floorId },
        data: {
          editorLeaseFence: { increment: 1 },
          editorLeaseTokenHash: null,
          editorLeaseHolderId: null,
          editorLeaseHolderName: null,
          editorLeaseAcquiredAt: null,
          editorLeaseExpiresAt: null
        }
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (released) {
      await this.tryReleaseLeaseCache(floorId, token);
    }
    return released;
  }

  private async forceInvalidateLease(floorId: string, fence: number) {
    const released = await this.prisma.$transaction(async (tx) => {
      const floor = await this.lockLeaseAuthority(tx, floorId);
      if (!floor) return false;
      if (floor.editorLeaseFence !== fence) {
        return false;
      }
      if (floor.editorLeaseFence >= 2_147_483_647) throw new ForbiddenException("floor editor lease fence overflow");
      await tx.floor.update({
        where: { id: floorId },
        data: {
          editorLeaseFence: { increment: 1 },
          editorLeaseTokenHash: null,
          editorLeaseHolderId: null,
          editorLeaseHolderName: null,
          editorLeaseAcquiredAt: null,
          editorLeaseExpiresAt: null
        }
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (released) {
      await this.tryDeleteLeaseCache(floorId);
    }
    return released;
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

  private async tryWriteLeaseCache(floorId: string, lease: StoredEditorLease) {
    try {
      await this.redisProvider.getClient().set(this.key(floorId), JSON.stringify(lease), "EX", editorLeaseTtlSeconds);
    } catch {
      return;
    }
  }

  private async tryRenewLeaseCache(floorId: string, token: string) {
    try {
      await this.redisProvider.getClient().eval(
        editorLeaseRenewScript,
        1,
        this.key(floorId),
        token,
        String(editorLeaseTtlSeconds)
      );
    } catch {
      return;
    }
  }

  private async tryReleaseLeaseCache(floorId: string, token: string) {
    try {
      await this.redisProvider.getClient().eval(editorLeaseReleaseScript, 1, this.key(floorId), token);
    } catch {
      return;
    }
  }

  private async tryDeleteLeaseCache(floorId: string) {
    try {
      await this.redisProvider.getClient().del(this.key(floorId));
    } catch {
      return;
    }
  }

  private isLeaseActive(floor: LeaseAuthoritySnapshot) {
    const dbNow = floor.dbNow ?? new Date();
    return Boolean(
      floor.editorLeaseTokenHash &&
      floor.editorLeaseHolderId &&
      floor.editorLeaseHolderName &&
      floor.editorLeaseAcquiredAt &&
      floor.editorLeaseExpiresAt &&
      floor.editorLeaseExpiresAt.getTime() > dbNow.getTime()
    );
  }

  private toStoredLease(floor: LeaseAuthoritySnapshot | null): StoredEditorLease | null {
    if (!floor || !this.isLeaseActive(floor)) return null;
    return {
      userId: floor.editorLeaseHolderId!,
      userName: floor.editorLeaseHolderName!,
      token: "",
      fence: floor.editorLeaseFence,
      acquiredAt: floor.editorLeaseAcquiredAt!.toISOString()
    };
  }

  private async lockLeaseAuthority(tx: Prisma.TransactionClient, floorId: string) {
    const rows = await tx.$queryRaw<Omit<LockedLeaseAuthorityRow, "dbNow">[]>(Prisma.sql`
      SELECT
        "id",
        "editorLeaseFence",
        "editorLeaseTokenHash",
        "editorLeaseHolderId",
        "editorLeaseHolderName",
        "editorLeaseAcquiredAt",
        "editorLeaseExpiresAt"
      FROM "Floor"
      WHERE "id" = ${floorId}
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) return null;
    const nowRows = await tx.$queryRaw<Array<{ dbNow: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "dbNow"`);
    return { ...row, dbNow: nowRows[0]!.dbNow };
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
