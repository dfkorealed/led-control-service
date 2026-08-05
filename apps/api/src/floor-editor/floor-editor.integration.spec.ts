import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { FloorEditorService } from "./floor-editor.service";

const databaseUrl = process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("FloorEditorService PostgreSQL transaction", () => {
  const ids = {
    providerOrganizationId: "10000000-0000-4000-8000-000000000001",
    customerOrganizationId: "10000000-0000-4000-8000-000000000002",
    otherOrganizationId: "10000000-0000-4000-8000-000000000003",
    operatorId: "10000000-0000-4000-8000-000000000004",
    viewerId: "10000000-0000-4000-8000-000000000005",
    otherAdminId: "10000000-0000-4000-8000-000000000006",
    siteId: "10000000-0000-4000-8000-000000000007",
    floorId: "10000000-0000-4000-8000-000000000008",
    fixtureId: "10000000-0000-4000-8000-000000000009"
  };
  const operator = {
    id: ids.operatorId,
    organizationId: ids.providerOrganizationId,
    organizationType: "service_provider" as const,
    email: "floor-editor-operator@example.com",
    name: "Floor editor operator",
    role: "operator" as const,
    status: "active" as const
  };
  const viewer = {
    id: ids.viewerId,
    organizationId: ids.customerOrganizationId,
    organizationType: "customer" as const,
    email: "floor-editor-viewer@example.com",
    name: "Floor editor viewer",
    role: "viewer" as const,
    status: "active" as const
  };
  const otherAdmin = {
    id: ids.otherAdminId,
    organizationId: ids.otherOrganizationId,
    organizationType: "customer" as const,
    email: "floor-editor-other-admin@example.com",
    name: "Other admin",
    role: "admin" as const,
    status: "active" as const
  };
  const saveInput = {
    expectedRevision: 0,
    fixtureUpdates: [{ id: ids.fixtureId, x: 20 }],
    objectCreates: [],
    objectUpdates: [],
    objectDeletes: []
  };

  let prisma: PrismaService;
  let siteAccess: SiteAccessService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    siteAccess = new SiteAccessService(prisma);

    await prisma.organization.createMany({
      data: [
        { id: ids.providerOrganizationId, name: "Provider", type: "service_provider" },
        { id: ids.customerOrganizationId, name: "Customer", type: "customer" },
        { id: ids.otherOrganizationId, name: "Other customer", type: "customer" }
      ]
    });
    await prisma.user.createMany({
      data: [
        {
          id: operator.id, organizationId: operator.organizationId, email: operator.email, name: operator.name,
          passwordHash: "test", role: operator.role, status: operator.status
        },
        {
          id: viewer.id, organizationId: viewer.organizationId, email: viewer.email, name: viewer.name,
          passwordHash: "test", role: viewer.role, status: viewer.status
        },
        {
          id: otherAdmin.id, organizationId: otherAdmin.organizationId, email: otherAdmin.email, name: otherAdmin.name,
          passwordHash: "test", role: otherAdmin.role, status: otherAdmin.status
        }
      ]
    });
    await prisma.site.create({
      data: {
        id: ids.siteId,
        organizationId: ids.customerOrganizationId,
        name: "Transaction site",
        address: "Test",
        tariffKwhRate: "100.00"
      }
    });
    await prisma.siteMembership.createMany({
      data: [
        { userId: ids.operatorId, siteId: ids.siteId },
        { userId: ids.viewerId, siteId: ids.siteId }
      ]
    });
    await prisma.floor.create({ data: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 } });
    await prisma.fixture.create({
      data: { id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10 }
    });
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { siteId: ids.siteId } });
    await prisma.floorMapRevision.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.floorMapObject.deleteMany({ where: { floorId: ids.floorId } });
    await prisma.floor.update({ where: { id: ids.floorId }, data: { mapRevision: 0 } });
    await prisma.fixture.update({ where: { id: ids.fixtureId }, data: { x: 10 } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rolls back normalized rows and revision when transactional audit recording fails", async () => {
    const failingAudit = { record: jest.fn().mockRejectedValue(new Error("audit unavailable")) };
    const service = new FloorEditorService(prisma, siteAccess, failingAudit as never);

    await expect(service.saveEditorState(operator, ids.floorId, saveInput)).rejects.toThrow("audit unavailable");

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId }, select: { x: true } }))
      .resolves.toEqual({ x: 10 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
  });

  it("commits one audit and revision and rejects a stale optimistic save without another commit", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.saveEditorState(operator, ids.floorId, saveInput)).resolves.toMatchObject({
      floor: { mapRevision: 1 },
      fixtures: [{ id: ids.fixtureId, x: 20 }]
    });
    await expect(service.saveEditorState(operator, ids.floorId, { ...saveInput, fixtureUpdates: [{ id: ids.fixtureId, x: 30 }] }))
      .rejects.toBeInstanceOf(ConflictException);

    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId, action: "floor_editor.saved" } })).resolves.toBe(1);
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId }, select: { x: true } }))
      .resolves.toEqual({ x: 20 });
  });

  it("allows revision reads for an assigned viewer but blocks manage and cross-tenant reads", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.listEditorRevisions(viewer, ids.floorId)).resolves.toEqual([]);
    await expect(service.saveEditorState(viewer, ids.floorId, saveInput)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listEditorRevisions(otherAdmin, ids.floorId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
