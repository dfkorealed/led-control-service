import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { EditorLeaseService } from "./editor-lease.service";

describe("EditorLeaseService", () => {
  const floorId = "00000000-0000-4000-8000-000000000003";
  const siteId = "00000000-0000-4000-8000-000000000002";
  const adminA = {
    id: "admin-a", organizationId: "customer-1", organizationType: "customer" as const,
    email: "a@example.com", name: "김관리", role: "admin" as const, status: "active" as const
  };
  const adminB = { ...adminA, id: "admin-b", email: "b@example.com", name: "이관리" };

  async function createService({
    set = jest.fn().mockResolvedValue("OK"),
    get = jest.fn().mockResolvedValue(null),
    eval: evaluate = jest.fn().mockResolvedValue(1),
    auditRecord = jest.fn().mockResolvedValue({ id: "audit-1" }),
    floor = { id: floorId, siteId }
  }: {
    set?: jest.Mock;
    get?: jest.Mock;
    eval?: jest.Mock;
    auditRecord?: jest.Mock;
    floor?: { id: string; siteId: string } | null;
  } = {}) {
    const prisma = { floor: { findUnique: jest.fn().mockResolvedValue(floor) } };
    const redis = { set, get, eval: evaluate };
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

    return {
      service: moduleRef.get(EditorLeaseService),
      prisma,
      redis,
      siteAccess,
      auditRecord
    };
  }

  it("returns the active holder as read-only and rejects a different user's normal release", async () => {
    const holder = JSON.stringify({
      userId: adminA.id,
      userName: adminA.name,
      token: "holder-token",
      acquiredAt: "2026-08-06T00:00:00.000Z"
    });
    const { service, redis } = await createService({
      set: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(holder)
    });

    await expect(service.acquire(floorId, adminB)).resolves.toMatchObject({
      editable: false,
      holderName: adminA.name,
      acquiredAt: "2026-08-06T00:00:00.000Z"
    });
    await expect(service.release(floorId, adminB, false)).rejects.toBeInstanceOf(ForbiddenException);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("uses a 90-second NX lease when the floor is authorized for editing", async () => {
    const { service, redis, siteAccess } = await createService();

    const lease = await service.acquire(floorId, adminA);

    expect(lease).toMatchObject({ editable: true, holderName: adminA.name });
    expect(lease.token).toEqual(expect.any(String));
    expect(redis.set).toHaveBeenCalledWith(
      `floor-editor:lease:${floorId}`,
      expect.stringContaining(`\"userId\":\"${adminA.id}\"`),
      "EX",
      90,
      "NX"
    );
    expect(siteAccess.assert).toHaveBeenCalledWith(adminA, siteId, "manage");
  });

  it("acquires after an expired holder disappears between the failed NX attempt and lookup", async () => {
    const set = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    const { service } = await createService({ set, get: jest.fn().mockResolvedValue(null) });

    await expect(service.acquire(floorId, adminB)).resolves.toMatchObject({ editable: true, holderName: adminB.name });
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("renews and releases only the caller's matching token", async () => {
    const { service, redis } = await createService({
      set: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(JSON.stringify({
        userId: adminA.id,
        userName: adminA.name,
        token: "lease-token",
        acquiredAt: "2026-08-06T00:00:00.000Z"
      }))
    });

    await expect(service.acquire(floorId, adminA, "lease-token")).resolves.toMatchObject({ editable: true, token: "lease-token" });
    await expect(service.release(floorId, adminA, false, "lease-token")).resolves.toEqual({ released: true });

    expect(redis.eval).toHaveBeenNthCalledWith(1, expect.any(String), 1, `floor-editor:lease:${floorId}`, "lease-token", "90");
    expect(redis.eval).toHaveBeenNthCalledWith(2, expect.any(String), 1, `floor-editor:lease:${floorId}`, "lease-token");
  });

  it("records a force-release audit before atomically releasing the audited token", async () => {
    const get = jest.fn().mockResolvedValue(JSON.stringify({
      userId: adminA.id,
      userName: adminA.name,
      token: "holder-token",
      acquiredAt: "2026-08-06T00:00:00.000Z"
    }));
    const auditRecord = jest.fn().mockResolvedValue({ id: "audit-1" });
    const { service, redis } = await createService({ get, auditRecord });

    await expect(service.release(floorId, adminB, true)).resolves.toEqual({ released: true });

    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: "floor_editor.lease_force_released",
      actorId: adminB.id,
      siteId,
      targetId: floorId,
      metadata: expect.objectContaining({ leaseHolderId: adminA.id })
    }));
    expect(auditRecord.mock.invocationCallOrder[0]).toBeLessThan(redis.eval.mock.invocationCallOrder[0]);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, `floor-editor:lease:${floorId}`, "holder-token");
  });

  it("does not release a lease when its required audit record fails", async () => {
    const { service, redis } = await createService({
      get: jest.fn().mockResolvedValue(JSON.stringify({
        userId: adminA.id, userName: adminA.name, token: "holder-token", acquiredAt: "2026-08-06T00:00:00.000Z"
      })),
      auditRecord: jest.fn().mockRejectedValue(new Error("audit unavailable"))
    });

    await expect(service.release(floorId, adminB, true)).rejects.toThrow("audit unavailable");
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("does not expose a missing floor as an editable lease", async () => {
    const { service } = await createService({ floor: null });

    await expect(service.acquire(floorId, adminA)).rejects.toBeInstanceOf(NotFoundException);
  });
});
