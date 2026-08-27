import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { SiteAccessService } from "../access/site-access.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { EditorLeaseService } from "./editor-lease.service";
import { FloorEditorService } from "./floor-editor.service";

const databaseUrl = process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeWithDependencies = databaseUrl && process.env.RUN_REDIS_INTEGRATION === "true" && redisUrl ? describe : describe.skip;

describeWithDependencies("Editor lease PostgreSQL and Redis integration", () => {
  const ids = {
    providerOrganizationId: "10000000-0000-4000-8000-000000000001",
    customerOrganizationId: "10000000-0000-4000-8000-000000000002",
    operatorAId: "20000000-0000-4000-8000-000000000003",
    operatorBId: "20000000-0000-4000-8000-000000000004",
    siteId: "20000000-0000-4000-8000-000000000005",
    floorId: "20000000-0000-4000-8000-000000000006",
    fixtureId: "20000000-0000-4000-8000-000000000007"
  };
  const operatorA = {
    id: ids.operatorAId,
    organizationId: ids.providerOrganizationId,
    organizationType: "service_provider" as const,
    loginId: "lease_operator_a",
    name: "Lease Operator A",
    role: "operator" as const,
    status: "active" as const
  };
  const operatorB = {
    id: ids.operatorBId,
    organizationId: ids.providerOrganizationId,
    organizationType: "service_provider" as const,
    loginId: "lease_operator_b",
    name: "Lease Operator B",
    role: "operator" as const,
    status: "active" as const
  };

  let prisma: PrismaService;
  let lockingPrisma: PrismaService;
  let siteAccess: SiteAccessService;
  let redisProvider: RedisProvider;
  let leaseService: EditorLeaseService;
  let floorEditorService: FloorEditorService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    prisma = new PrismaService();
    lockingPrisma = new PrismaService();
    await prisma.$connect();
    await lockingPrisma.$connect();
    siteAccess = new SiteAccessService(prisma);
    redisProvider = new RedisProvider();
    const auditService = new AuditService(prisma);
    leaseService = new EditorLeaseService(prisma, siteAccess, auditService, redisProvider);
    floorEditorService = new FloorEditorService(prisma, siteAccess, auditService);

    const existingProvider = await prisma.organization.findFirst({
      where: { type: "service_provider" },
      select: { id: true }
    });
    if (existingProvider) {
      ids.providerOrganizationId = existingProvider.id;
      operatorA.organizationId = existingProvider.id;
      operatorB.organizationId = existingProvider.id;
    } else {
      await prisma.organization.create({
        data: { id: ids.providerOrganizationId, name: "Provider", type: "service_provider" }
      });
    }
    await prisma.organization.upsert({
      where: { id: ids.customerOrganizationId },
      create: { id: ids.customerOrganizationId, name: "Lease customer", type: "customer" },
      update: { name: "Lease customer", type: "customer" }
    });

    await prisma.user.upsert({
      where: { id: operatorA.id },
      create: {
        id: operatorA.id,
        organizationId: operatorA.organizationId,
        loginId: operatorA.loginId,
        email: null,
        name: operatorA.name,
        passwordHash: "test",
        role: operatorA.role,
        status: operatorA.status
      },
      update: {
        organizationId: operatorA.organizationId,
        loginId: operatorA.loginId,
        email: null,
        name: operatorA.name,
        role: operatorA.role,
        status: operatorA.status
      }
    });
    await prisma.user.upsert({
      where: { id: operatorB.id },
      create: {
        id: operatorB.id,
        organizationId: operatorB.organizationId,
        loginId: operatorB.loginId,
        email: null,
        name: operatorB.name,
        passwordHash: "test",
        role: operatorB.role,
        status: operatorB.status
      },
      update: {
        organizationId: operatorB.organizationId,
        loginId: operatorB.loginId,
        email: null,
        name: operatorB.name,
        role: operatorB.role,
        status: operatorB.status
      }
    });
    await prisma.site.upsert({
      where: { id: ids.siteId },
      create: {
        id: ids.siteId,
        organizationId: ids.customerOrganizationId,
        name: "Lease integration site",
        address: "Test",
        tariffKwhRate: "100.00"
      },
      update: {}
    });
    await prisma.floor.upsert({
      where: { id: ids.floorId },
      create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 },
      update: { siteId: ids.siteId, name: "B1", level: -1 }
    });
    await prisma.fixture.upsert({
      where: { id: ids.fixtureId },
      create: { id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10, size: 20 },
      update: { floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10, size: 20 }
    });
    await prisma.siteMembership.upsert({
      where: { userId_siteId: { userId: ids.operatorAId, siteId: ids.siteId } },
      create: { userId: ids.operatorAId, siteId: ids.siteId },
      update: {}
    });
    await prisma.siteMembership.upsert({
      where: { userId_siteId: { userId: ids.operatorBId, siteId: ids.siteId } },
      create: { userId: ids.operatorBId, siteId: ids.siteId },
      update: {}
    });
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { siteId: ids.siteId } });
    await prisma.floorMapRevision.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.floorMapObject.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.floorPlan.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.fixture.update({
      where: { id: ids.fixtureId },
      data: { name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10, size: 20 }
    });
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: {
        mapRevision: 0,
        editorLeaseFence: 0,
        editorLeaseTokenHash: null,
        editorLeaseHolderId: null,
        editorLeaseHolderName: null,
        editorLeaseAcquiredAt: null,
        editorLeaseExpiresAt: null
      }
    });
    await redisProvider.getClient().del(`floor-editor:lease:${ids.floorId}`);
  });

  afterAll(async () => {
    await redisProvider.onModuleDestroy();
    await lockingPrisma.$disconnect();
    await prisma.$disconnect();
  });

  async function lockFloorAuthorityRow(work: () => Promise<void>) {
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const transaction = lockingPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Floor" WHERE id = ${ids.floorId} FOR UPDATE`;
      markLocked?.();
      await released;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000
    });

    await locked;
    try {
      await work();
    } finally {
      releaseLock();
      await transaction;
    }
  }

  async function waitForExpiry() {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  async function createBaselineRevision(token: string, fence: number) {
    return floorEditorService.saveEditorState(operatorA, ids.floorId, {
      expectedRevision: 0,
      leaseToken: token,
      leaseFence: fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 40 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });
  }

  it("allows only one active holder and advances the fence for a successor after expiry", async () => {
    const first = await leaseService.acquire(ids.floorId, operatorA);
    expect(first).toMatchObject({ editable: true, fence: 1 });

    const readOnly = await leaseService.acquire(ids.floorId, operatorB);
    expect(readOnly).toMatchObject({ editable: false, fence: 1, holderName: operatorA.name });

    await prisma.floor.update({
      where: { id: ids.floorId },
      data: { editorLeaseExpiresAt: new Date(Date.now() - 1_000) }
    });

    const successor = await leaseService.acquire(ids.floorId, operatorB);
    expect(successor).toMatchObject({ editable: true, fence: 2 });
    expect(successor.token).toEqual(expect.any(String));
    expect(successor.token).not.toBe(first.token);
  });

  it("rejects renewals that expire while waiting on the authoritative PostgreSQL row lock", async () => {
    const lease = await leaseService.acquire(ids.floorId, operatorA);
    if (!lease.token) throw new Error("expected active lease token");
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: { editorLeaseExpiresAt: new Date(Date.now() + 100) }
    });

    let renewalPromise: Promise<Awaited<ReturnType<typeof leaseService.acquire>>> | null = null;
    await lockFloorAuthorityRow(async () => {
      renewalPromise = leaseService.acquire(ids.floorId, operatorA, lease.token!);
      await waitForExpiry();
    });
    const renewal = await renewalPromise;

    expect(renewal).toEqual({ editable: false });
  });

  it("rejects stale predecessor save and restore after an expiry successor even without Redis state, while allowing the successor to continue", async () => {
    const first = await leaseService.acquire(ids.floorId, operatorA);
    if (!first.token || !first.fence) throw new Error("expected active lease token");
    await createBaselineRevision(first.token, first.fence);
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: { editorLeaseExpiresAt: new Date(Date.now() - 1_000) }
    });
    await redisProvider.getClient().del(`floor-editor:lease:${ids.floorId}`);

    const successor = await leaseService.acquire(ids.floorId, operatorB);
    if (!successor.token || !successor.fence) throw new Error("expected successor lease token");
    await redisProvider.getClient().del(`floor-editor:lease:${ids.floorId}`);

    await expect(floorEditorService.saveEditorState(operatorA, ids.floorId, {
      expectedRevision: 1,
      leaseToken: first.token,
      leaseFence: first.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 50 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(ConflictException);

    await expect(floorEditorService.restoreEditorRevision(operatorA, ids.floorId, 1, {
      expectedRevision: 1,
      leaseToken: first.token,
      leaseFence: first.fence
    })).rejects.toBeInstanceOf(ConflictException);

    await expect(floorEditorService.saveEditorState(operatorB, ids.floorId, {
      expectedRevision: 1,
      leaseToken: successor.token,
      leaseFence: successor.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 60 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).resolves.toMatchObject({ floor: { mapRevision: 2 }, fixtures: [{ id: ids.fixtureId, x: 60 }] });

    await expect(floorEditorService.restoreEditorRevision(operatorB, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: successor.token,
      leaseFence: successor.fence
    })).resolves.toMatchObject({
      floor: { mapRevision: 3 },
      fixtures: [{ id: ids.fixtureId, x: 40 }]
    });
  });

  it("rejects stale predecessor save and restore after a force release creates a successor", async () => {
    const first = await leaseService.acquire(ids.floorId, operatorA);
    if (!first.token || !first.fence) throw new Error("expected active lease token");
    await createBaselineRevision(first.token, first.fence);

    await expect(leaseService.release(ids.floorId, operatorB, true)).resolves.toEqual({ released: true });
    const successor = await leaseService.acquire(ids.floorId, operatorB);
    if (!successor.token || !successor.fence) throw new Error("expected successor lease token");
    await redisProvider.getClient().del(`floor-editor:lease:${ids.floorId}`);

    await expect(floorEditorService.saveEditorState(operatorA, ids.floorId, {
      expectedRevision: 1,
      leaseToken: first.token,
      leaseFence: first.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 50 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(ConflictException);

    await expect(floorEditorService.saveEditorState(operatorB, ids.floorId, {
      expectedRevision: 1,
      leaseToken: successor.token,
      leaseFence: successor.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 60 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).resolves.toMatchObject({ floor: { mapRevision: 2 }, fixtures: [{ id: ids.fixtureId, x: 60 }] });

    await expect(floorEditorService.restoreEditorRevision(operatorA, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: first.token,
      leaseFence: first.fence
    })).rejects.toBeInstanceOf(ConflictException);

    await expect(floorEditorService.restoreEditorRevision(operatorB, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: successor.token,
      leaseFence: successor.fence
    })).resolves.toMatchObject({
      floor: { mapRevision: 3 },
      fixtures: [{ id: ids.fixtureId, x: 40 }]
    });
  });

  it("rejects saves and restores that become stale while waiting on the authoritative PostgreSQL row lock", async () => {
    const lease = await leaseService.acquire(ids.floorId, operatorA);
    if (!lease.token || !lease.fence) throw new Error("expected active lease token");
    await createBaselineRevision(lease.token, lease.fence);
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: { editorLeaseExpiresAt: new Date(Date.now() + 100) }
    });

    let staleSave: Promise<unknown> | null = null;
    await lockFloorAuthorityRow(async () => {
      staleSave = floorEditorService.saveEditorState(operatorA, ids.floorId, {
        expectedRevision: 1,
        leaseToken: lease.token!,
        leaseFence: lease.fence!,
        fixtureUpdates: [{ id: ids.fixtureId, x: 90 }],
        objectCreates: [],
        objectUpdates: [],
        objectDeletes: []
      });
      await waitForExpiry();
    });
    await expect(staleSave).rejects.toBeInstanceOf(ConflictException);

    const successor = await leaseService.acquire(ids.floorId, operatorB);
    if (!successor.token || !successor.fence) throw new Error("expected successor lease token");

    let staleRestore: Promise<unknown> | null = null;
    await lockFloorAuthorityRow(async () => {
      staleRestore = floorEditorService.restoreEditorRevision(operatorA, ids.floorId, 1, {
        expectedRevision: 1,
        leaseToken: lease.token!,
        leaseFence: lease.fence!
      });
      await waitForExpiry();
    });
    await expect(staleRestore).rejects.toBeInstanceOf(ConflictException);

    await expect(floorEditorService.restoreEditorRevision(operatorB, ids.floorId, 1, {
      expectedRevision: 1,
      leaseToken: successor.token,
      leaseFence: successor.fence
    })).resolves.toMatchObject({
      floor: { mapRevision: 2 },
      fixtures: [{ id: ids.fixtureId, x: 40 }]
    });
  });

  it("keeps mapRevision as a final conflict guard after a valid lease check", async () => {
    const lease = await leaseService.acquire(ids.floorId, operatorA);
    if (!lease.token || !lease.fence) throw new Error("expected active lease token");

    await floorEditorService.saveEditorState(operatorA, ids.floorId, {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 40 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });

    await expect(floorEditorService.saveEditorState(operatorA, ids.floorId, {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 80 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
