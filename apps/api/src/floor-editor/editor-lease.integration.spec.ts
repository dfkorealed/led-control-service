import { ConflictException } from "@nestjs/common";
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
    email: "lease-a@example.com",
    name: "Lease Operator A",
    role: "operator" as const,
    status: "active" as const
  };
  const operatorB = {
    id: ids.operatorBId,
    organizationId: ids.providerOrganizationId,
    organizationType: "service_provider" as const,
    email: "lease-b@example.com",
    name: "Lease Operator B",
    role: "operator" as const,
    status: "active" as const
  };

  let prisma: PrismaService;
  let siteAccess: SiteAccessService;
  let redisProvider: RedisProvider;
  let leaseService: EditorLeaseService;
  let floorEditorService: FloorEditorService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    siteAccess = new SiteAccessService(prisma);
    redisProvider = new RedisProvider();
    const auditService = new AuditService(prisma);
    leaseService = new EditorLeaseService(prisma, siteAccess, auditService, redisProvider);
    floorEditorService = new FloorEditorService(prisma, siteAccess, auditService);

    await prisma.user.upsert({
      where: { id: operatorA.id },
      create: {
        id: operatorA.id,
        organizationId: operatorA.organizationId,
        email: operatorA.email,
        name: operatorA.name,
        passwordHash: "test",
        role: operatorA.role,
        status: operatorA.status
      },
      update: {
        organizationId: operatorA.organizationId,
        email: operatorA.email,
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
        email: operatorB.email,
        name: operatorB.name,
        passwordHash: "test",
        role: operatorB.role,
        status: operatorB.status
      },
      update: {
        organizationId: operatorB.organizationId,
        email: operatorB.email,
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
    await prisma.$disconnect();
  });

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

  it("rejects stale predecessor save and restore after a force release creates a successor", async () => {
    const first = await leaseService.acquire(ids.floorId, operatorA);
    if (!first.token || !first.fence) throw new Error("expected active lease token");

    await expect(leaseService.release(ids.floorId, operatorB, true)).resolves.toEqual({ released: true });
    const successor = await leaseService.acquire(ids.floorId, operatorB);
    if (!successor.token || !successor.fence) throw new Error("expected successor lease token");

    await expect(floorEditorService.saveEditorState(operatorA, ids.floorId, {
      expectedRevision: 0,
      leaseToken: first.token,
      leaseFence: first.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 50 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(ConflictException);

    await expect(floorEditorService.saveEditorState(operatorB, ids.floorId, {
      expectedRevision: 0,
      leaseToken: successor.token,
      leaseFence: successor.fence,
      fixtureUpdates: [{ id: ids.fixtureId, x: 60 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).resolves.toMatchObject({ floor: { mapRevision: 1 }, fixtures: [{ id: ids.fixtureId, x: 60 }] });

    await expect(floorEditorService.restoreEditorRevision(operatorA, ids.floorId, 1, {
      expectedRevision: 1,
      leaseToken: first.token,
      leaseFence: first.fence
    })).rejects.toBeInstanceOf(ConflictException);
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
