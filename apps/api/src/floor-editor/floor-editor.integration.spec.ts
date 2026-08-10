import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { FloorEditorService } from "./floor-editor.service";
import { hashEditorLeaseToken } from "./editor-lease-token";

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
    fixtureId: "10000000-0000-4000-8000-000000000009",
    assetId: "10000000-0000-4000-8000-000000000013"
  };
  const readyAssetUrl = "https://assets.example/integration-floor.png";
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
    await prisma.floorAsset.create({
      data: {
        id: ids.assetId,
        floorId: ids.floorId,
        kind: "original",
        status: "ready",
        objectKey: "integration/floor.png",
        publicUrl: readyAssetUrl,
        mimeType: "image/png",
        sizeBytes: 1024n,
        sha256: "a".repeat(64),
        readyAt: new Date()
      }
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
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function activateLease(token: string, fence: number, expiresAt = new Date(Date.now() + 60_000)) {
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: {
        editorLeaseFence: fence,
        editorLeaseTokenHash: hashEditorLeaseToken(token),
        editorLeaseHolderId: operator.id,
        editorLeaseHolderName: operator.name,
        editorLeaseAcquiredAt: new Date(expiresAt.getTime() - 30_000),
        editorLeaseExpiresAt: expiresAt
      }
    });
  }

  it("rolls back normalized rows and revision when transactional audit recording fails", async () => {
    await activateLease("lease-token", 1);
    const failingAudit = { record: jest.fn().mockRejectedValue(new Error("audit unavailable")) };
    const service = new FloorEditorService(prisma, siteAccess, failingAudit as never);

    await expect(service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      leaseToken: "lease-token",
      leaseFence: 1,
      fixtureUpdates: [{ id: ids.fixtureId, x: 20 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toThrow("audit unavailable");

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId }, select: { x: true } }))
      .resolves.toEqual({ x: 10 });
  });

  it("rejects a stale save after the authoritative lease fence advances", async () => {
    await activateLease("successor-token", 2);
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      leaseToken: "stale-token",
      leaseFence: 1,
      fixtureUpdates: [{ id: ids.fixtureId, x: 20 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it("round-trips floor plan and fixtures through restore when the lease remains authoritative", async () => {
    await activateLease("lease-token", 1);
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const floorPlan = {
      sourceType: "image" as const,
      imageUrl: readyAssetUrl,
      originalFileUrl: readyAssetUrl,
      renderedImageUrl: readyAssetUrl,
      width: 1200,
      height: 800
    };

    await service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      leaseToken: "lease-token",
      leaseFence: 1,
      floorPlan,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Saved L01", x: 20, y: 30, size: 24, ratedWatt: "55.5" }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });
    await activateLease("lease-token-2", 2);
    await service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 1,
      leaseToken: "lease-token-2",
      leaseFence: 2,
      floorPlan: null,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Mutated L01", x: 90 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });
    await activateLease("lease-token-3", 3);

    await expect(service.restoreEditorRevision(operator, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: "lease-token-3",
      leaseFence: 3
    })).resolves.toMatchObject({
      floor: { mapRevision: 3, floorPlan },
      fixtures: [{ id: ids.fixtureId, name: "Saved L01", x: 20, y: 30, size: 24, ratedWatt: 55.5 }]
    });
  });

  it("allows revision reads for an assigned viewer but blocks manage and cross-tenant reads", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.listEditorRevisions(viewer, ids.floorId)).resolves.toEqual({ items: [], nextCursor: null });
    await expect(service.saveEditorState(viewer, ids.floorId, {
      expectedRevision: 0,
      leaseToken: "lease-token",
      leaseFence: 1,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listEditorRevisions(otherAdmin, ids.floorId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
