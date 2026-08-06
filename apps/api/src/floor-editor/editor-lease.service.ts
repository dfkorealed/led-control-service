import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";

const leaseTtlSeconds = 90;
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
  acquiredAt: string;
}

export interface EditorLeaseResult {
  editable: boolean;
  token?: string;
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

    const lease: StoredEditorLease = {
      userId: user.id,
      userName: user.name,
      token: randomUUID(),
      acquiredAt: new Date().toISOString()
    };
    const client = this.redisProvider.getClient();
    const acquired = await client.set(this.key(floorId), JSON.stringify(lease), "EX", leaseTtlSeconds, "NX");
    if (acquired === "OK") return this.editable(lease);

    const holder = await this.readLease(floorId);
    if (holder) return this.readOnly(holder);

    // A lease can expire after SET NX reports a conflict but before GET reads it. Retry once so an expired
    // key does not incorrectly force a newly arriving editor into read-only mode.
    const retried = await client.set(this.key(floorId), JSON.stringify(lease), "EX", leaseTtlSeconds, "NX");
    if (retried === "OK") return this.editable(lease);
    return this.readOnly(await this.readLease(floorId));
  }

  async release(floorId: string, user: AuthenticatedUser, force: boolean, token?: string) {
    const access = await this.assertManageAccess(floorId, user);
    const holder = await this.readLease(floorId);
    if (!holder) return { released: false };

    if (force) {
      if (user.role !== "operator" && user.role !== "admin") {
        throw new ForbiddenException("floor editor lease force release requires operator or admin role");
      }
      await this.recordForceReleaseAudit(access, user, floorId, holder, "floor_editor.lease_force_release_requested", "attempted");
      const released = await this.releaseToken(floorId, holder.token);
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

    if (!token || holder.userId !== user.id || holder.token !== token) {
      throw new ForbiddenException("floor editor lease is held by another user");
    }
    return { released: await this.releaseToken(floorId, token) };
  }

  private async renew(floorId: string, user: AuthenticatedUser, token: string): Promise<EditorLeaseResult> {
    const holder = await this.readLease(floorId);
    if (!holder || holder.userId !== user.id || holder.token !== token) return this.readOnly(holder);

    const renewed = await this.redisProvider.getClient().eval(
      editorLeaseRenewScript,
      1,
      this.key(floorId),
      token,
      String(leaseTtlSeconds)
    );
    if (Number(renewed) === 1) return this.editable(holder);
    return this.readOnly(await this.readLease(floorId));
  }

  private async releaseToken(floorId: string, token: string) {
    const released = await this.redisProvider.getClient().eval(editorLeaseReleaseScript, 1, this.key(floorId), token);
    return Number(released) === 1;
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

  private async readLease(floorId: string): Promise<StoredEditorLease | null> {
    const raw = await this.redisProvider.getClient().get(this.key(floorId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<StoredEditorLease>;
      if (
        typeof value.userId !== "string" ||
        typeof value.userName !== "string" ||
        typeof value.token !== "string" ||
        typeof value.acquiredAt !== "string"
      ) return null;
      return value as StoredEditorLease;
    } catch {
      return null;
    }
  }

  private key(floorId: string) {
    return `floor-editor:lease:${floorId}`;
  }

  private editable(lease: StoredEditorLease): EditorLeaseResult {
    return { editable: true, token: lease.token, holderName: lease.userName, acquiredAt: lease.acquiredAt };
  }

  private readOnly(lease: StoredEditorLease | null): EditorLeaseResult {
    return lease ? { editable: false, holderName: lease.userName, acquiredAt: lease.acquiredAt } : { editable: false };
  }
}
