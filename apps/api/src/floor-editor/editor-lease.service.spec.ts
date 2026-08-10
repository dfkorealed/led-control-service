import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { EditorLeaseService } from "./editor-lease.service";
import { hashEditorLeaseToken } from "./editor-lease-token";

describe("EditorLeaseService", () => {
  const floorId = "00000000-0000-4000-8000-000000000003";
  const siteId = "00000000-0000-4000-8000-000000000002";
  const adminA = {
    id: "admin-a", organizationId: "customer-1", organizationType: "customer" as const,
    email: "a@example.com", name: "김관리", role: "admin" as const, status: "active" as const
  };
  const adminB = { ...adminA, id: "admin-b", email: "b@example.com", name: "이관리" };

  async function createService({
    floorState,
    update = jest.fn().mockResolvedValue({ id: floorId }),
    auditRecord = jest.fn().mockResolvedValue({ id: "audit-1" })
  }: {
    floorState?: Record<string, unknown> | null;
    update?: jest.Mock;
    auditRecord?: jest.Mock;
  } = {}) {
    const now = new Date();
    const resolvedFloorState = floorState === undefined ? {
      id: floorId,
      siteId,
      editorLeaseFence: 4,
      editorLeaseTokenHash: hashEditorLeaseToken("holder-token"),
      editorLeaseHolderId: adminA.id,
      editorLeaseHolderName: adminA.name,
      editorLeaseAcquiredAt: now,
      editorLeaseExpiresAt: new Date(now.getTime() + 60_000)
    } : floorState;
    const floorFindUnique = jest.fn().mockResolvedValue(resolvedFloorState);
    const prisma = {
      floor: {
        findUnique: floorFindUnique,
        update
      },
      $transaction: jest.fn().mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback({
        floor: {
          findUnique: floorFindUnique,
          update
        },
        $queryRaw: jest.fn()
          .mockResolvedValueOnce(resolvedFloorState ? [{
            id: floorId,
            ...resolvedFloorState
          }] : [])
          .mockResolvedValue([{ dbNow: now }])
      }))
    };
    const redis = { set: jest.fn(), get: jest.fn(), eval: jest.fn().mockResolvedValue(1), del: jest.fn() };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: siteId, organizationId: "customer-1" }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EditorLeaseService,
        { provide: PrismaService, useValue: prisma },
        { provide: SiteAccessService, useValue: siteAccess },
        { provide: AuditService, useValue: { record: auditRecord } },
        { provide: RedisProvider, useValue: { getClient: () => redis } }
      ]
    }).compile();

    return { service: moduleRef.get(EditorLeaseService), prisma, redis, auditRecord };
  }

  it("acquires a new fenced lease when no active holder exists", async () => {
    const { service, redis, prisma } = await createService({
      floorState: {
        id: floorId,
        siteId,
        editorLeaseFence: 4,
        editorLeaseTokenHash: null,
        editorLeaseHolderId: null,
        editorLeaseHolderName: null,
        editorLeaseAcquiredAt: null,
        editorLeaseExpiresAt: null
      }
    });

    const lease = await service.acquire(floorId, adminA);

    expect(lease.editable).toBe(true);
    expect(lease.fence).toBe(5);
    expect(prisma.floor.update).toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalled();
  });

  it("returns the active holder as read-only and rejects a different user's normal release", async () => {
    const { service, redis } = await createService();

    await expect(service.acquire(floorId, adminB)).resolves.toMatchObject({
      editable: false,
      holderName: adminA.name,
      fence: 4
    });
    await expect(service.release(floorId, adminB, false, "stale-token")).rejects.toBeInstanceOf(ForbiddenException);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("records requested and final force-release audits", async () => {
    const auditRecord = jest.fn().mockResolvedValue({ id: "audit-1" });
    const { service } = await createService({ auditRecord });

    await expect(service.release(floorId, adminB, true)).resolves.toEqual({ released: true });
    expect(auditRecord).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "floor_editor.lease_force_release_requested",
      outcome: "attempted"
    }));
    expect(auditRecord).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "floor_editor.lease_force_released",
      outcome: "success"
    }));
  });

  it("keeps PostgreSQL authority updates even when Redis release calls fail", async () => {
    const { service, prisma, redis } = await createService();
    redis.eval.mockRejectedValueOnce(new Error("redis offline"));

    await expect(service.release(floorId, adminA, false, "holder-token")).resolves.toEqual({ released: true });
    expect(prisma.floor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        editorLeaseFence: { increment: 1 },
        editorLeaseTokenHash: null
      })
    }));
  });

  it("rejects lease acquire when incrementing the authoritative fence would overflow PostgreSQL int4", async () => {
    const { service } = await createService({
      floorState: {
        id: floorId,
        siteId,
        editorLeaseFence: 2_147_483_647,
        editorLeaseTokenHash: null,
        editorLeaseHolderId: null,
        editorLeaseHolderName: null,
        editorLeaseAcquiredAt: null,
        editorLeaseExpiresAt: null
      }
    });

    await expect(service.acquire(floorId, adminA)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("does not expose a missing floor as an editable lease", async () => {
    const { service } = await createService({ floorState: null });

    await expect(service.acquire(floorId, adminA)).rejects.toBeInstanceOf(NotFoundException);
  });
});
