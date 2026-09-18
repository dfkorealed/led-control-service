import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { FloorEditorService } from "./floor-editor.service";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { Test } from "@nestjs/testing";
import { NestExpressApplication } from "@nestjs/platform-express";
import { FloorEditorController } from "./floor-editor.controller";
import { EditorLeaseService } from "./editor-lease.service";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { configureApiBodyParser } from "../api-body-parser";
import { EDITOR_MAX_BODY_BYTES } from "@led-control/shared";
import { TargetSnapshotService } from "../automation/target-snapshot.service";
import { FixturesService } from "../fixtures/fixtures.service";
import { EnergyService } from "../energy/energy.service";
import { EnergyAnalyticsQueryService } from "../energy/energy-analytics-query.service";
import { createHash, randomUUID } from "node:crypto";
import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";

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
    unassignedOperatorId: "10000000-0000-4000-8000-000000000014",
    siteId: "10000000-0000-4000-8000-000000000007",
    floorId: "10000000-0000-4000-8000-000000000008",
    fixtureId: "10000000-0000-4000-8000-000000000009",
    missingFixtureId: "10000000-0000-4000-8000-000000000010",
    otherFloorId: "10000000-0000-4000-8000-000000000011",
    foreignFixtureId: "10000000-0000-4000-8000-000000000012",
    assetId: "10000000-0000-4000-8000-000000000013"
  };
  const readyAssetPath = `/api/floors/${ids.floorId}/assets/${ids.assetId}/content`;
  const operator = {
    id: ids.operatorId,
    organizationId: ids.customerOrganizationId,
    organizationType: "customer" as const,
    loginId: "floor_editor_operator",
    name: "Floor editor operator",
    role: "admin" as const,
    mustChangePassword: false,
    status: "active" as const
  };
  const viewer = {
    id: ids.viewerId,
    organizationId: ids.customerOrganizationId,
    organizationType: "customer" as const,
    loginId: "floor_editor_viewer",
    name: "Floor editor viewer",
    role: "viewer" as const,
    mustChangePassword: false,
    status: "active" as const
  };
  const otherAdmin = {
    id: ids.otherAdminId,
    organizationId: ids.otherOrganizationId,
    organizationType: "customer" as const,
    loginId: "floor_editor_other_admin",
    name: "Other admin",
    role: "admin" as const,
    mustChangePassword: false,
    status: "active" as const
  };
  const unassignedOperator = {
    ...operator,
    id: ids.unassignedOperatorId,
    loginId: "floor_editor_unassigned_operator",
    name: "Unassigned floor editor operator"
  };
  const lease = {
    token: "lease-token",
    fence: 1
  };
  const saveInput = {
    expectedRevision: 0,
    leaseToken: lease.token,
    leaseFence: lease.fence,
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

    const existingProvider = await prisma.organization.findFirst({
      where: { type: "service_provider" },
      select: { id: true }
    });
    if (existingProvider) {
      ids.providerOrganizationId = existingProvider.id;
    } else {
      await prisma.organization.create({
        data: { id: ids.providerOrganizationId, name: "Provider", type: "service_provider" }
      });
    }
    await prisma.organization.upsert({
      where: { id: ids.customerOrganizationId },
      create: { id: ids.customerOrganizationId, name: "Customer", type: "customer" },
      update: { name: "Customer", type: "customer" }
    });
    await prisma.organization.upsert({
      where: { id: ids.otherOrganizationId },
      create: { id: ids.otherOrganizationId, name: "Other customer", type: "customer" },
      update: { name: "Other customer", type: "customer" }
    });
    for (const userRecord of [
      operator,
      viewer,
      otherAdmin,
      unassignedOperator
    ]) {
      await prisma.user.upsert({
        where: { id: userRecord.id },
        create: {
        id: userRecord.id,
        organizationId: userRecord.organizationId,
        loginId: userRecord.loginId,
        email: null,
          name: userRecord.name,
          passwordHash: "test",
          role: userRecord.role,
          status: userRecord.status
        },
        update: {
        organizationId: userRecord.organizationId,
        loginId: userRecord.loginId,
        email: null,
          name: userRecord.name,
          role: userRecord.role,
          status: userRecord.status
        }
      });
    }
    await prisma.site.upsert({
      where: { id: ids.siteId },
      create: {
        id: ids.siteId,
        organizationId: ids.customerOrganizationId,
        adminUserId: operator.id,
        name: "Transaction site",
        address: "Test",
        tariffKwhRate: "100.00"
      },
      update: {
        organizationId: ids.customerOrganizationId,
        adminUserId: operator.id,
        name: "Transaction site",
        address: "Test",
        tariffKwhRate: "100.00"
      }
    });
    await prisma.siteMembership.upsert({
      where: { userId_siteId: { userId: ids.operatorId, siteId: ids.siteId } },
      create: { userId: ids.operatorId, siteId: ids.siteId },
      update: {}
    });
    await prisma.siteMembership.upsert({
      where: { userId_siteId: { userId: ids.viewerId, siteId: ids.siteId } },
      create: { userId: ids.viewerId, siteId: ids.siteId },
      update: {}
    });
    await prisma.floor.upsert({
      where: { id: ids.floorId },
      create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 },
      update: { siteId: ids.siteId, name: "B1", level: -1 }
    });
    await prisma.floor.upsert({
      where: { id: ids.otherFloorId },
      create: { id: ids.otherFloorId, siteId: ids.siteId, name: "B2", level: -2 },
      update: { siteId: ids.siteId, name: "B2", level: -2 }
    });
    await prisma.fixture.upsert({
      where: { id: ids.fixtureId },
      create: { id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10 },
      update: { floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10 }
    });
    await prisma.fixture.upsert({
      where: { id: ids.foreignFixtureId },
      create: { id: ids.foreignFixtureId, floorId: ids.otherFloorId, name: "B2-L01", ratedWatt: "40.00", x: 10, y: 10 },
      update: { floorId: ids.otherFloorId, name: "B2-L01", ratedWatt: "40.00", x: 10, y: 10 }
    });
    await prisma.floorAsset.upsert({
      where: { id: ids.assetId },
      create: {
        id: ids.assetId,
        floorId: ids.floorId,
        kind: "original",
        status: "ready",
        objectKey: "integration/floor.png",
        mimeType: "image/png",
        sizeBytes: 1024n,
        sha256: "a".repeat(64),
        readyAt: new Date()
      },
      update: {
        floorId: ids.floorId,
        kind: "original",
        status: "ready",
        objectKey: "integration/floor.png",
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
    await prisma.fixture.deleteMany({ where: { floorId: ids.floorId, id: { not: ids.fixtureId } } });
    await prisma.floor.update({
      where: { id: ids.floorId },
      data: {
        status: "active",
        mapRevision: 0,
        editorLeaseFence: 0,
        editorLeaseTokenHash: null,
        editorLeaseHolderId: null,
        editorLeaseHolderName: null,
        editorLeaseAcquiredAt: null,
        editorLeaseExpiresAt: null
      }
    });
    await prisma.fixture.update({
      where: { id: ids.fixtureId },
      data: { name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10, size: 20,
        placementStatus: "placed", positionVerifiedAt: null }
    });
    await prisma.floorAsset.update({
      where: { id: ids.assetId },
      data: { status: "ready", cleanupStartedAt: null, readyAt: new Date() }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function activateLease(token = lease.token, fence = lease.fence, expiresAt = new Date(Date.now() + 60_000)) {
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
    return { token, fence };
  }

  it("rolls back normalized rows and revision when transactional audit recording fails", async () => {
    await activateLease();
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

  it("returns current light slots and writes them into every new V2 snapshot", async () => {
    await activateLease();
    const slotX = 120.1234567890123;
    const slotY = 240.9876543210987;
    const sourceAssetId = randomUUID(); const jobId = randomUUID(); const candidateId = randomUUID();
    await prisma.floorAsset.create({ data: {
      id: sourceAssetId, floorId: ids.floorId, kind: "original", status: "ready",
      objectKey: `integration/${sourceAssetId}.dxf`, mimeType: "application/dxf",
      sizeBytes: 128n, sha256: "d".repeat(64), readyAt: new Date()
    } });
    await prisma.floorImportJob.create({ data: {
      id: jobId, floorId: ids.floorId, sourceAssetId, sourceFormat: "dxf",
      status: "failed", stage: "failed", failureCode: "TEST_FIXTURE",
      failureMessage: "editor slot snapshot fixture", failedAt: new Date()
    } });
    await prisma.floorImportCandidate.create({ data: {
      id: candidateId, jobId, sourceEntityId: "slot-source", layerName: "LIGHT", blockName: "LED",
      x: slotX, y: slotY, rotation: 30, confidence: 0.95, detectionMethod: "rule_based",
      profileVersion: "test/1", profileDigest: "e".repeat(64), reviewStatus: "accepted", reviewedAt: new Date()
    } });
    const slot = await prisma.floorLightSlot.create({ data: {
      floorId: ids.floorId, sourceImportJobId: jobId, sourceCandidateId: candidateId,
      assignedFixtureId: null, x: slotX, y: slotY, rotation: 30
    } });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    try {
      await expect(service.getEditorState(ids.floorId, operator)).resolves.toMatchObject({
        lightSlots: [{ id: slot.id, x: slotX, y: slotY, rotation: 30, assignedFixtureId: null }]
      });
      const saved = await service.saveEditorState(operator, ids.floorId, {
        ...saveInput,
        fixtureUpdates: [{ id: ids.fixtureId, x: slotX, y: slotY, placementStatus: "placed" }],
        slotAssignments: [{ slotId: slot.id, assignedFixtureId: ids.fixtureId }],
        objectCreates: [], objectUpdates: [], objectDeletes: []
      });
      expect(saved).toMatchObject({
        lightSlots: [{ id: slot.id, x: slotX, y: slotY, rotation: 30, assignedFixtureId: ids.fixtureId }]
      });
      const revision = await prisma.floorMapRevision.findUniqueOrThrow({
        where: { floorId_revision: { floorId: ids.floorId, revision: 1 } }
      });
      expect(revision.snapshot).toMatchObject({
        version: 2,
        lightSlots: [{ id: slot.id, x: slotX, y: slotY, rotation: 30, assignedFixtureId: ids.fixtureId }]
      });
      await expect(service.getEditorState(ids.floorId, operator)).resolves.toMatchObject({
        fixtures: [expect.objectContaining({ id: ids.fixtureId, x: slotX, y: slotY, placementStatus: "placed" })],
        lightSlots: [{ id: slot.id, x: slotX, y: slotY, rotation: 30, assignedFixtureId: ids.fixtureId }]
      });
    } finally {
      await prisma.floorImportJob.delete({ where: { id: jobId } });
      await prisma.floorAsset.delete({ where: { id: sourceAssetId } });
    }
  });

  it("rejects final slot placement mismatches and rolls fixture, slot, revision, snapshot, and audit back", async () => {
    await activateLease();
    const slotX = 120.1234567890123;
    const slotY = 240.9876543210987;
    const sourceAssetId = randomUUID();
    const jobId = randomUUID();
    const candidateId = randomUUID();
    await prisma.floorAsset.create({ data: {
      id: sourceAssetId, floorId: ids.floorId, kind: "original", status: "ready",
      objectKey: `integration/${sourceAssetId}.dxf`, mimeType: "application/dxf",
      sizeBytes: 128n, sha256: "8".repeat(64), readyAt: new Date()
    } });
    await prisma.floorImportJob.create({ data: {
      id: jobId, floorId: ids.floorId, sourceAssetId, sourceFormat: "dxf",
      status: "failed", stage: "failed", failureCode: "TEST_FIXTURE",
      failureMessage: "slot final-state validation fixture", failedAt: new Date()
    } });
    await prisma.floorImportCandidate.create({ data: {
      id: candidateId, jobId, sourceEntityId: "slot-final-state", layerName: "LIGHT", blockName: "LED",
      x: slotX, y: slotY, rotation: 30, confidence: 0.95, detectionMethod: "rule_based",
      profileVersion: "test/1", profileDigest: "9".repeat(64), reviewStatus: "accepted", reviewedAt: new Date()
    } });
    const slot = await prisma.floorLightSlot.create({ data: {
      floorId: ids.floorId, sourceImportJobId: jobId, sourceCandidateId: candidateId,
      assignedFixtureId: null, x: slotX, y: slotY, rotation: 30
    } });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const assignmentOnlyCases = [
      { placementStatus: "unplaced" as const, x: slotX, y: slotY },
      { placementStatus: "placed" as const, x: slotX + 1, y: slotY },
      { placementStatus: "placed" as const, x: slotX, y: slotY + 1 }
    ];

    try {
      for (const fixtureState of assignmentOnlyCases) {
        await prisma.fixture.update({ where: { id: ids.fixtureId }, data: fixtureState });
        await expect(service.saveEditorState(operator, ids.floorId, {
          ...saveInput,
          fixtureUpdates: [],
          slotAssignments: [{ slotId: slot.id, assignedFixtureId: ids.fixtureId }],
          objectCreates: [], objectUpdates: [], objectDeletes: []
        })).rejects.toBeInstanceOf(BadRequestException);

        await expect(prisma.floorLightSlot.findUniqueOrThrow({
          where: { id: slot.id }, select: { assignedFixtureId: true }
        })).resolves.toEqual({ assignedFixtureId: null });
      }

      await prisma.fixture.update({
        where: { id: ids.fixtureId },
        data: { placementStatus: "placed", x: 10, y: 10 }
      });
      await expect(service.saveEditorState(operator, ids.floorId, {
        ...saveInput,
        fixtureUpdates: [{ id: ids.fixtureId, placementStatus: "placed", x: slotX, y: slotY + 1 }],
        slotAssignments: [{ slotId: slot.id, assignedFixtureId: ids.fixtureId }],
        objectCreates: [], objectUpdates: [], objectDeletes: []
      })).rejects.toBeInstanceOf(BadRequestException);

      await expect(prisma.fixture.findUniqueOrThrow({
        where: { id: ids.fixtureId }, select: { placementStatus: true, x: true, y: true }
      })).resolves.toEqual({ placementStatus: "placed", x: 10, y: 10 });
      await expect(prisma.floorLightSlot.findUniqueOrThrow({
        where: { id: slot.id }, select: { assignedFixtureId: true }
      })).resolves.toEqual({ assignedFixtureId: null });
      await expect(prisma.floor.findUniqueOrThrow({
        where: { id: ids.floorId }, select: { mapRevision: true }
      })).resolves.toEqual({ mapRevision: 0 });
      await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
      await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
    } finally {
      await prisma.floorImportJob.delete({ where: { id: jobId } });
      await prisma.floorAsset.delete({ where: { id: sourceAssetId } });
    }
  });

  it("swaps two slot assignments without unique conflicts in one save transaction", async () => {
    await activateLease();
    const secondFixtureId = ids.missingFixtureId;
    const sourceAssetId = randomUUID();
    const jobId = randomUUID();
    const firstCandidateId = randomUUID();
    const secondCandidateId = randomUUID();
    await prisma.fixture.create({ data: {
      id: secondFixtureId, floorId: ids.floorId, name: "B1-L02", ratedWatt: "30.00",
      x: 220, y: 240, placementStatus: "placed"
    } });
    await prisma.floorAsset.create({ data: {
      id: sourceAssetId, floorId: ids.floorId, kind: "original", status: "ready",
      objectKey: `integration/${sourceAssetId}.dxf`, mimeType: "application/dxf",
      sizeBytes: 128n, sha256: "f".repeat(64), readyAt: new Date()
    } });
    await prisma.floorImportJob.create({ data: {
      id: jobId, floorId: ids.floorId, sourceAssetId, sourceFormat: "dxf",
      status: "failed", stage: "failed", failureCode: "TEST_FIXTURE",
      failureMessage: "slot swap fixture", failedAt: new Date()
    } });
    await prisma.floorImportCandidate.createMany({ data: [
      {
        id: firstCandidateId, jobId, sourceEntityId: "slot-swap-a", layerName: "LIGHT", blockName: "LED",
        x: 120, y: 240, rotation: 0, confidence: 0.95, detectionMethod: "rule_based",
        profileVersion: "test/1", profileDigest: "1".repeat(64), reviewStatus: "accepted", reviewedAt: new Date()
      },
      {
        id: secondCandidateId, jobId, sourceEntityId: "slot-swap-b", layerName: "LIGHT", blockName: "LED",
        x: 220, y: 240, rotation: 90, confidence: 0.95, detectionMethod: "rule_based",
        profileVersion: "test/1", profileDigest: "2".repeat(64), reviewStatus: "accepted", reviewedAt: new Date()
      }
    ] });
    const firstSlot = await prisma.floorLightSlot.create({ data: {
      floorId: ids.floorId, sourceImportJobId: jobId, sourceCandidateId: firstCandidateId,
      assignedFixtureId: ids.fixtureId, x: 120, y: 240, rotation: 0
    } });
    const secondSlot = await prisma.floorLightSlot.create({ data: {
      floorId: ids.floorId, sourceImportJobId: jobId, sourceCandidateId: secondCandidateId,
      assignedFixtureId: secondFixtureId, x: 220, y: 240, rotation: 90
    } });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    try {
      const saved = await service.saveEditorState(operator, ids.floorId, {
        ...saveInput,
        fixtureUpdates: [
          { id: ids.fixtureId, x: 220, y: 240, placementStatus: "placed" },
          { id: secondFixtureId, x: 120, y: 240, placementStatus: "placed" }
        ],
        slotAssignments: [
          { slotId: firstSlot.id, assignedFixtureId: secondFixtureId },
          { slotId: secondSlot.id, assignedFixtureId: ids.fixtureId }
        ],
        objectCreates: [], objectUpdates: [], objectDeletes: []
      });

      expect(saved.lightSlots).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstSlot.id, assignedFixtureId: secondFixtureId }),
        expect.objectContaining({ id: secondSlot.id, assignedFixtureId: ids.fixtureId })
      ]));
      await expect(prisma.floorLightSlot.findMany({
        where: { floorId: ids.floorId }, orderBy: { id: "asc" },
        select: { id: true, assignedFixtureId: true }
      })).resolves.toEqual(expect.arrayContaining([
        { id: firstSlot.id, assignedFixtureId: secondFixtureId },
        { id: secondSlot.id, assignedFixtureId: ids.fixtureId }
      ]));
    } finally {
      await prisma.floorImportJob.delete({ where: { id: jobId } });
      await prisma.floorAsset.delete({ where: { id: sourceAssetId } });
      await prisma.fixture.deleteMany({ where: { id: secondFixtureId } });
    }
  });

  it("rejects duplicate assignments and other-floor slot or fixture targets without committing", async () => {
    await activateLease();
    const currentAssetId = randomUUID();
    const foreignAssetId = randomUUID();
    const currentJobId = randomUUID();
    const foreignJobId = randomUUID();
    const currentCandidateIds = [randomUUID(), randomUUID()];
    const foreignCandidateId = randomUUID();
    await prisma.floorAsset.createMany({ data: [
      {
        id: currentAssetId, floorId: ids.floorId, kind: "original", status: "ready",
        objectKey: `integration/${currentAssetId}.dxf`, mimeType: "application/dxf",
        sizeBytes: 128n, sha256: "3".repeat(64), readyAt: new Date()
      },
      {
        id: foreignAssetId, floorId: ids.otherFloorId, kind: "original", status: "ready",
        objectKey: `integration/${foreignAssetId}.dxf`, mimeType: "application/dxf",
        sizeBytes: 128n, sha256: "4".repeat(64), readyAt: new Date()
      }
    ] });
    await prisma.floorImportJob.createMany({ data: [
      {
        id: currentJobId, floorId: ids.floorId, sourceAssetId: currentAssetId, sourceFormat: "dxf",
        status: "failed", stage: "failed", failureCode: "TEST_FIXTURE",
        failureMessage: "slot validation fixture", failedAt: new Date()
      },
      {
        id: foreignJobId, floorId: ids.otherFloorId, sourceAssetId: foreignAssetId, sourceFormat: "dxf",
        status: "failed", stage: "failed", failureCode: "TEST_FIXTURE",
        failureMessage: "foreign slot validation fixture", failedAt: new Date()
      }
    ] });
    await prisma.floorImportCandidate.createMany({ data: [
      ...currentCandidateIds.map((id, index) => ({
        id, jobId: currentJobId, sourceEntityId: `slot-validation-${index}`,
        layerName: "LIGHT", blockName: "LED", x: 120 + (index * 100), y: 240,
        rotation: 0, confidence: 0.95, detectionMethod: "rule_based" as const,
        profileVersion: "test/1", profileDigest: `${5 + index}`.repeat(64),
        reviewStatus: "accepted" as const, reviewedAt: new Date()
      })),
      {
        id: foreignCandidateId, jobId: foreignJobId, sourceEntityId: "foreign-slot-validation",
        layerName: "LIGHT", blockName: "LED", x: 320, y: 240, rotation: 0,
        confidence: 0.95, detectionMethod: "rule_based" as const, profileVersion: "test/1",
        profileDigest: "7".repeat(64), reviewStatus: "accepted" as const, reviewedAt: new Date()
      }
    ] });
    const currentSlots = await Promise.all(currentCandidateIds.map((sourceCandidateId, index) =>
      prisma.floorLightSlot.create({ data: {
        floorId: ids.floorId, sourceImportJobId: currentJobId, sourceCandidateId,
        assignedFixtureId: null, x: 120 + (index * 100), y: 240, rotation: 0
      } })
    ));
    const foreignSlot = await prisma.floorLightSlot.create({ data: {
      floorId: ids.otherFloorId, sourceImportJobId: foreignJobId, sourceCandidateId: foreignCandidateId,
      assignedFixtureId: null, x: 320, y: 240, rotation: 0
    } });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const invalidAssignments = [
      [
        { slotId: currentSlots[0].id, assignedFixtureId: ids.fixtureId },
        { slotId: currentSlots[0].id, assignedFixtureId: null }
      ],
      [
        { slotId: currentSlots[0].id, assignedFixtureId: ids.fixtureId },
        { slotId: currentSlots[1].id, assignedFixtureId: ids.fixtureId }
      ],
      [{ slotId: foreignSlot.id, assignedFixtureId: ids.fixtureId }],
      [{ slotId: currentSlots[0].id, assignedFixtureId: ids.foreignFixtureId }]
    ];

    try {
      for (const slotAssignments of invalidAssignments) {
        await expect(service.saveEditorState(operator, ids.floorId, {
          ...saveInput,
          fixtureUpdates: [],
          slotAssignments,
          objectCreates: [], objectUpdates: [], objectDeletes: []
        })).rejects.toThrow();
      }

      await expect(prisma.floor.findUniqueOrThrow({
        where: { id: ids.floorId }, select: { mapRevision: true }
      })).resolves.toEqual({ mapRevision: 0 });
      await expect(prisma.floorLightSlot.count({
        where: { id: { in: currentSlots.map(({ id }) => id) }, assignedFixtureId: { not: null } }
      })).resolves.toBe(0);
      await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
      await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
    } finally {
      await prisma.floorImportJob.deleteMany({ where: { id: { in: [currentJobId, foreignJobId] } } });
      await prisma.floorAsset.deleteMany({ where: { id: { in: [currentAssetId, foreignAssetId] } } });
    }
  });

  it("persists placement, verifies on the server, clears on movement, and restores exact metadata", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const saved = await service.saveEditorState(operator, ids.floorId, {
      ...saveInput, fixtureUpdates: [{ id: ids.fixtureId, placementStatus: "placed", positionVerified: true }]
    });
    expect(saved.fixtures[0]).toMatchObject({ placementStatus: "placed", positionVerifiedAt: expect.any(String) });
    const verifiedAt = (await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } })).positionVerifiedAt;
    expect(verifiedAt).toBeInstanceOf(Date);
    await service.saveEditorState(operator, ids.floorId, {
      ...saveInput, expectedRevision: 1, fixtureUpdates: [{ id: ids.fixtureId, name: "Renamed", size: 24 }]
    });
    expect((await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } })).positionVerifiedAt).toEqual(verifiedAt);
    await service.saveEditorState(operator, ids.floorId, { ...saveInput, expectedRevision: 2 });
    expect((await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } })).positionVerifiedAt).toBeNull();
    await service.restoreEditorRevision(operator, ids.floorId, 1, { expectedRevision: 3, leaseToken: lease.token, leaseFence: lease.fence });
    expect((await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } })).positionVerifiedAt).toEqual(verifiedAt);
    const before = await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } });
    const cursor = await prisma.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: ids.fixtureId } });
    await service.saveEditorState(operator, ids.floorId, {
      ...saveInput, expectedRevision: 4, fixtureUpdates: [{ id: ids.fixtureId, placementStatus: "unplaced", ratedWatt: "40.00" }]
    });
    const after = await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } });
    expect(after).toMatchObject({ placementStatus: "unplaced", positionVerifiedAt: null, x: before.x, y: before.y,
      meshNodeId: before.meshNodeId, gatewayId: before.gatewayId, ratedWatt: before.ratedWatt });
    expect(await prisma.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: ids.fixtureId } })).toEqual(cursor);
  });

  it("rejects verifying an unplaced fixture and coordinates outside this floor without creating a revision", async () => {
    await activateLease();
    await prisma.fixture.update({ where: { id: ids.fixtureId }, data: { placementStatus: "unplaced", positionVerifiedAt: null } });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    for (const patch of [{ positionVerified: true }, { placementStatus: "placed", x: 1201 }, { placementStatus: "placed", y: -1 }]) {
      await expect(service.saveEditorState(operator, ids.floorId, {
        ...saveInput, fixtureUpdates: [{ id: ids.fixtureId, ...patch }]
      })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(await prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).toBe(0);
  });

  it("restores legacy V1 without rewriting its hash or placing fixtures registered after the revision", async () => {
    await activateLease();
    const snapshot = { fixtures: [{ id: ids.fixtureId, name: "Legacy", ratedWatt: "40.00", size: 20, x: -12.5, y: 20000 }],
      floorPlan: null, objects: [] };
    const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    await prisma.floorMapRevision.create({ data: { floorId: ids.floorId, revision: 1, snapshot,
      snapshotSha256: hash, changeSummary: {}, changedBy: operator.id } });
    const later = await prisma.fixture.create({ data: { floorId: ids.floorId, name: "New", ratedWatt: "40", x: 0, y: 0 } });
    await prisma.floor.update({ where: { id: ids.floorId }, data: { mapRevision: 1 } });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const result = await service.restoreEditorRevision(operator, ids.floorId, 1, {
      expectedRevision: 1, leaseToken: lease.token, leaseFence: lease.fence
    });
    expect(result.fixtures.find(({ id }) => id === ids.fixtureId)).toMatchObject({
      placementStatus: "placed", positionVerifiedAt: null, x: -12.5, y: 20000
    });
    expect(result.fixtures.find(({ id }) => id === later.id)).toMatchObject({ placementStatus: "unplaced", positionVerifiedAt: null });
    const source = await prisma.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId: ids.floorId, revision: 1 } } });
    expect(source.snapshot).toEqual(snapshot);
    expect(source.snapshotSha256).toBe(hash);
    await expect(service.saveEditorState(operator, ids.floorId, { ...saveInput, expectedRevision: 2,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Legacy renamed", x: -12.5, y: 20000,
        placementStatus: "placed", positionVerified: false }] })).resolves.toBeDefined();
  });

  it("keeps registered identity, group and schedule targets, controllability and energy intact when unplaced", async () => {
    await activateLease();
    const gateway = await prisma.gateway.create({ data: {
      siteId: ids.siteId, name: "Placement test", serialNumber: randomUUID(), firmwareVersion: "test",
      lastHeartbeatAt: new Date()
    } });
    const node = await prisma.meshNode.create({ data: {
      gatewayId: gateway.id, meshAddress: "0x0100", serialNumber: "fixture-search-serial", firmwareVersion: "test"
    } });
    await prisma.fixture.update({ where: { id: ids.fixtureId }, data: { meshNodeId: node.id, status: "online",
      brightness: 50, powerOn: true, energyTrackingStartedAt: new Date("2026-09-01T00:00:00Z"),
      firstStateOccurredAt: new Date("2026-09-01T00:00:00Z"), lastStateOccurredAt: new Date("2026-09-02T00:00:00Z"),
      lastStateEventId: randomUUID(), lastStateSequence: 1n } });
    const group = await prisma.fixtureGroup.create({ data: { siteId: ids.siteId, floorId: ids.floorId,
      gatewayId: gateway.id, name: "Placement group", groupFixtures: { create: { fixtureId: ids.fixtureId } } } });
    const schedule = await prisma.lightingSchedule.create({ data: {
      siteId: ids.siteId, gatewayId: gateway.id, name: "Placement schedule", activeFrom: new Date("2026-09-01T00:00:00Z"),
      activeUntil: new Date("2026-10-01T00:00:00Z"), localStartTime: "08:00", localEndTime: "20:00", recurrenceKind: "daily",
      dimmingEnabled: true, brightnessPercent: 50, createdById: operator.id, updatedById: operator.id,
      fixtures: { create: { fixtureId: ids.fixtureId } }
    } });
    const checkpointTime = new Date("2026-09-02T00:00:00Z");
    await prisma.fixtureEnergyStateCursor.upsert({ where: { fixtureId: ids.fixtureId },
      create: { fixtureId: ids.fixtureId, aggregatedThrough: checkpointTime, observedStateOccurredAt: checkpointTime,
        brightness: 50, powerOn: true, ratedWatt: 40, durationRemainders: [] },
      update: { aggregatedThrough: checkpointTime, observedStateOccurredAt: checkpointTime,
        brightness: 50, powerOn: true, ratedWatt: 40, durationRemainders: [] } });
    const energyIdentity = await prisma.energyFixtureIdentity.upsert({
      where: { fixtureId: ids.fixtureId },
      create: { siteId: ids.siteId, fixtureId: ids.fixtureId, trackingStartedAt: new Date("2026-09-01T00:00:00Z") },
      update: { retiredAt: null }
    });
    await prisma.fixtureEnergyDailyAggregate.upsert({ where: { energyFixtureId_localDate: {
      energyFixtureId: energyIdentity.id, localDate: new Date("2026-09-01T00:00:00Z") } },
      create: { fixtureId: ids.fixtureId, energyFixtureId: energyIdentity.id, localDate: new Date("2026-09-01T00:00:00Z"), estimatedKwh: "0.48", estimatedCost: "48", knownSeconds: 86400, unknownSeconds: 0 },
      update: { estimatedKwh: "0.48", estimatedCost: "48" } });
    const energy = new EnergyService(prisma, siteAccess, new EnergyAnalyticsQueryService(prisma, siteAccess));
    const fixtures = new FixturesService(prisma, siteAccess);
    const editor = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const targets = new TargetSnapshotService();
    const getEvidence = async () => ({
      membership: await prisma.groupFixture.findMany({ where: { groupId: group.id } }),
      schedule: await prisma.lightingScheduleFixture.findMany({ where: { scheduleId: schedule.id } }),
      targets: await targets.resolve(prisma, ids.siteId, { type: "group", groupId: group.id }),
      cursor: await prisma.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: ids.fixtureId } }),
      energy: await energy.getSiteSeries(operator, ids.siteId, { granularity: "day", from: "2026-09-01", to: "2026-09-01" })
    });
    try {
      const before = await getEvidence();
      const saved = await editor.saveEditorState(operator, ids.floorId, { ...saveInput,
        fixtureUpdates: [{ id: ids.fixtureId, placementStatus: "unplaced", ratedWatt: "40.00", positionVerified: false }] });
      expect(saved.fixtures[0]).toMatchObject({ placementStatus: "unplaced", meshAddress: "0x0100", serialNumber: "fixture-search-serial" });
      const after = await getEvidence();
      expect(after.membership).toEqual(before.membership);
      expect(after.schedule).toEqual(before.schedule);
      expect(after.targets).toEqual(before.targets);
      expect(after.cursor).toEqual(before.cursor);
      expect(after.energy.points).toEqual(before.energy.points);
      const list = await fixtures.getFloorFixtures(operator, ids.siteId, ids.floorId, {});
      expect(list.items[0]).toMatchObject({ id: ids.fixtureId, placementStatus: "unplaced", controllable: true, controlBlockReason: null });
      expect(await prisma.meshNode.findUnique({ where: { id: node.id } })).toMatchObject({ meshAddress: "0x0100" });
    } finally {
      await prisma.lightingSchedule.delete({ where: { id: schedule.id } });
      await prisma.fixtureGroup.delete({ where: { id: group.id } });
      await prisma.fixture.update({ where: { id: ids.fixtureId }, data: { meshNodeId: null } });
      await prisma.gateway.delete({ where: { id: gateway.id } });
      await prisma.fixtureEnergyStateCursor.deleteMany({ where: { fixtureId: ids.fixtureId } });
      await prisma.fixtureEnergyDailyAggregate.deleteMany({ where: { fixtureId: ids.fixtureId } });
    }
  });

  it("saves 1,000 fixtures and 2,000 objects over HTTP 100 times and restores within budget", async () => {
    await activateLease(lease.token, lease.fence, new Date(Date.now() + 600_000));
    const fixtureIds = [ids.fixtureId, ...Array.from({ length: 999 }, (_, i) => `bulk-fixture-${i}`)];
    await prisma.fixture.createMany({ data: fixtureIds.slice(1).map((id) => ({
      id, floorId: ids.floorId, name: id, ratedWatt: "40", x: 0, y: 0
    })) });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const module = await Test.createTestingModule({
      controllers: [FloorEditorController], providers: [
        { provide: FloorEditorService, useValue: service }, { provide: EditorLeaseService, useValue: {} }
      ]
    }).overrideGuard(SessionAuthGuard).useValue({ canActivate: (context: any) => {
      context.switchToHttp().getRequest().user = operator;
      return true;
    } }).compile();
    const app = module.createNestApplication<NestExpressApplication>();
    configureApiBodyParser(app);
    await app.listen(0, "127.0.0.1");
    const url = `${await app.getUrl()}/floors/${ids.floorId}`;
    const put = (input: unknown) => fetch(`${url}/editor-state`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
    });
    try {
      const fixtureUpdates = fixtureIds.map((id, index) => ({ id, name: `Light ${index}`, ratedWatt: 40,
        x: 20 + index % 40 * 25, y: 20 + Math.floor(index / 40) * 25, size: 20, placementStatus: "placed", positionVerified: false }));
      const input = { ...saveInput, fixtureUpdates,
        objectCreates: Array.from({ length: 2000 }, () => ({ type: "rectangle", x: 10, y: 20,
          width: 30, height: 40, rotation: 0, points: null, text: null, strokeColor: "#ffffff",
          fillColor: null, strokeWidth: 1, fontSize: null, zIndex: 0, locked: false, visible: true })) };
      const payloadBytes = Buffer.byteLength(JSON.stringify(input));
      expect(payloadBytes).toBeGreaterThan(102400);
      expect(payloadBytes).toBeLessThan(EDITOR_MAX_BODY_BYTES);
      const first = await put(input);
      expect(first.status).toBe(200);
      const baseline: any = await first.json();
      expect(baseline.fixtures).toHaveLength(1000);
      expect(baseline.objects).toHaveLength(2000);
      expect((await put({ ...input, expectedRevision: 1, objectCreates: [...input.objectCreates, input.objectCreates[0]] })).status).toBe(400);
      expect((await put({ ...input, expectedRevision: 1, padding: "x".repeat(EDITOR_MAX_BODY_BYTES) })).status).toBe(413);
      const durations: number[] = [];
      for (let i = 1; i <= 100; i++) {
        const start = performance.now();
        const response = await put({ ...input, expectedRevision: i,
          fixtureUpdates: fixtureUpdates.map((fixture) => ({ ...fixture, x: fixture.x + i % 2 })),
          objectCreates: [], objectUpdates: baseline.objects.map((object: { id: string }) => ({ id: object.id, patch: { x: i } })) });
        expect(response.status).toBe(200);
        await response.json();
        durations.push(performance.now() - start);
      }
      const restoreStart = performance.now();
      const response = await fetch(`${url}/editor-revisions/1/restore`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 101, leaseToken: lease.token, leaseFence: lease.fence }) });
      expect(response.status).toBe(201);
      const restored: any = await response.json();
      const restoreMs = performance.now() - restoreStart;
      expect(restored.fixtures).toEqual(baseline.fixtures);
      expect(restored.objects).toEqual(baseline.objects);
      const rows = await prisma.$queryRaw<Array<{ bytes: number; storedBytes: number }>>`
        SELECT avg(octet_length(snapshot::text))::int AS bytes, avg(pg_column_size(snapshot))::int AS "storedBytes"
        FROM "FloorMapRevision" WHERE "floorId" = ${ids.floorId}
      `;
      expect(await prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).toBe(102);
      const p95 = durations.sort((a, b) => a - b)[94];
      console.info("floor-editor PostgreSQL/HTTP benchmark", { payloadBytes, saves: 100, p95Ms: Math.round(p95),
        restoreMs: Math.round(restoreMs), meanSnapshotBytes: rows[0].bytes, meanStoredBytes: rows[0].storedBytes });
      expect(p95).toBeLessThan(3000);
      expect(restoreMs).toBeLessThan(3000);
    } finally {
      await app.close();
    }
  }, 120_000);

  it("commits one audit and revision and rejects a stale optimistic save without another commit", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.saveEditorState(operator, ids.floorId, saveInput)).resolves.toMatchObject({
      floor: { mapRevision: 1 },
      fixtures: [{ id: ids.fixtureId, x: 20 }]
    });
    await expect(service.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      fixtureUpdates: [{ id: ids.fixtureId, x: 30 }]
    })).rejects.toBeInstanceOf(ConflictException);

    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId, action: "floor_editor.saved" } })).resolves.toBe(1);
    await expect(prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId }, select: { x: true } }))
      .resolves.toEqual({ x: 20 });
  });

  it("allows revision reads for an assigned viewer but blocks manage and cross-tenant reads", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.listEditorRevisions(viewer, ids.floorId)).resolves.toEqual({ items: [], nextCursor: null });
    await expect(service.saveEditorState(viewer, ids.floorId, saveInput)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listEditorRevisions(otherAdmin, ids.floorId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("round-trips floor plan, objects, fixtures, canonical snapshot, and hash through restore", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const rectangle = {
      type: "rectangle" as const,
      x: 10,
      y: 20,
      width: 300,
      height: 120,
      rotation: 0,
      points: null,
      text: null,
      strokeColor: "#111111",
      fillColor: "#eeeeee",
      strokeWidth: 2,
      fontSize: null,
      zIndex: 5,
      locked: false,
      visible: true
    };
    const floorPlan = {
      sourceType: "image" as const,
      imageUrl: readyAssetPath,
      originalFileUrl: readyAssetPath,
      renderedImageUrl: readyAssetPath,
      width: 1200,
      height: 800
    };

    await service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence,
      floorPlan,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Saved L01", ratedWatt: "55.5", x: 20, y: 30, size: 24 }],
      objectCreates: [rectangle],
      objectUpdates: [],
      objectDeletes: []
    });
    const revisionOne = await prisma.floorMapRevision.findUniqueOrThrow({
      where: { floorId_revision: { floorId: ids.floorId, revision: 1 } }
    });
    const savedObject = await prisma.floorMapObject.findFirstOrThrow({ where: { floorId: ids.floorId } });

    await service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 1,
      leaseToken: lease.token,
      leaseFence: lease.fence,
      floorPlan: null,
      fixtureUpdates: [{ id: ids.fixtureId, name: "Mutated L01", x: 99 }],
      objectCreates: [{ ...rectangle, type: "text", text: "Mutated", width: 160, height: 40, points: null }],
      objectUpdates: [],
      objectDeletes: [savedObject.id]
    });
    const nextLease = await activateLease("restore-lease-token", 2);
    const restored = await service.restoreEditorRevision(operator, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: nextLease.token,
      leaseFence: nextLease.fence
    });

    expect(restored).toMatchObject({
      floor: { mapRevision: 3, floorPlan },
      fixtures: [{ id: ids.fixtureId, name: "Saved L01", ratedWatt: 55.5, x: 20, y: 30, size: 24 }],
      objects: [{ id: savedObject.id, type: "rectangle", x: 10, y: 20, width: 300, height: 120 }],
      skippedFixtureIds: []
    });
    const revisionThree = await prisma.floorMapRevision.findUniqueOrThrow({
      where: { floorId_revision: { floorId: ids.floorId, revision: 3 } }
    });
    expect(revisionThree.snapshot).toEqual(revisionOne.snapshot);
    expect(revisionThree.snapshotSha256).toBe(revisionOne.snapshotSha256);
    await expect(prisma.floorMapObject.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(3);
  });

  it("restores the historical slot set and assignments when the current CAD slots differ", async () => {
    await activateLease();
    const historicalAssetId = randomUUID();
    const currentAssetId = randomUUID();
    const historicalJobId = randomUUID();
    const currentJobId = randomUUID();
    const historicalCandidateIds = [randomUUID(), randomUUID()];
    const currentCandidateId = randomUUID();
    const historicalCoordinates = [
      { x: 125.5, y: 245.25, rotation: 15 },
      { x: 425.5, y: 545.25, rotation: 45 }
    ];

    await prisma.floorAsset.createMany({ data: [
      {
        id: historicalAssetId, floorId: ids.floorId, kind: "original", status: "ready",
        objectKey: `integration/${historicalAssetId}.dxf`, mimeType: "application/dxf",
        sizeBytes: 128n, sha256: "b".repeat(64), readyAt: new Date()
      },
      {
        id: currentAssetId, floorId: ids.floorId, kind: "original", status: "ready",
        objectKey: `integration/${currentAssetId}.dxf`, mimeType: "application/dxf",
        sizeBytes: 128n, sha256: "c".repeat(64), readyAt: new Date()
      }
    ] });
    await prisma.floorImportJob.createMany({ data: [
      {
        id: historicalJobId, floorId: ids.floorId, sourceAssetId: historicalAssetId, sourceFormat: "dxf",
        status: "failed", stage: "failed", failureCode: "TEST_FIXTURE",
        failureMessage: "historical slot restore fixture", failedAt: new Date()
      },
      {
        id: currentJobId, floorId: ids.floorId, sourceAssetId: currentAssetId, sourceFormat: "dxf",
        status: "failed", stage: "failed", failureCode: "TEST_FIXTURE",
        failureMessage: "current slot restore fixture", failedAt: new Date()
      }
    ] });
    await prisma.floorImportCandidate.createMany({ data: [
      ...historicalCandidateIds.map((id, index) => ({
        id, jobId: historicalJobId, sourceEntityId: `historical-slot-${index}`,
        layerName: "LIGHT", blockName: "LED", ...historicalCoordinates[index], confidence: 0.95,
        detectionMethod: "rule_based" as const, profileVersion: "test/1",
        profileDigest: `${index + 1}`.repeat(64), reviewStatus: "accepted" as const, reviewedAt: new Date()
      })),
      {
        id: currentCandidateId, jobId: currentJobId, sourceEntityId: "current-slot",
        layerName: "LIGHT", blockName: "LED", x: 700, y: 600, rotation: 0, confidence: 0.95,
        detectionMethod: "rule_based" as const, profileVersion: "test/1",
        profileDigest: "3".repeat(64), reviewStatus: "accepted" as const, reviewedAt: new Date()
      }
    ] });
    const historicalSlots = await Promise.all(historicalCandidateIds.map((sourceCandidateId, index) =>
      prisma.floorLightSlot.create({ data: {
        floorId: ids.floorId,
        sourceImportJobId: historicalJobId,
        sourceCandidateId,
        assignedFixtureId: index === 0 ? ids.fixtureId : null,
        ...historicalCoordinates[index]
      } })
    ));
    await prisma.fixture.update({
      where: { id: ids.fixtureId },
      data: { x: historicalCoordinates[0].x, y: historicalCoordinates[0].y, placementStatus: "placed" }
    });
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    try {
      await service.saveEditorState(operator, ids.floorId, {
        expectedRevision: 0,
        leaseToken: lease.token,
        leaseFence: lease.fence,
        fixtureUpdates: [],
        slotAssignments: [],
        objectCreates: [],
        objectUpdates: [],
        objectDeletes: []
      });
      const sourceRevision = await prisma.floorMapRevision.findUniqueOrThrow({
        where: { floorId_revision: { floorId: ids.floorId, revision: 1 } }
      });

      await prisma.floorLightSlot.deleteMany({ where: { floorId: ids.floorId } });
      const currentSlot = await prisma.floorLightSlot.create({ data: {
        floorId: ids.floorId,
        sourceImportJobId: currentJobId,
        sourceCandidateId: currentCandidateId,
        x: 700,
        y: 600,
        rotation: 0
      } });
      await prisma.fixture.update({
        where: { id: ids.fixtureId },
        data: { x: 0, y: 0, placementStatus: "unplaced", positionVerifiedAt: null }
      });

      const restoreLease = await activateLease("historical-slot-restore", 2);
      const restored = await service.restoreEditorRevision(operator, ids.floorId, 1, {
        expectedRevision: 1,
        leaseToken: restoreLease.token,
        leaseFence: restoreLease.fence
      });

      expect(restored.lightSlots).toEqual(expect.arrayContaining(historicalSlots.map((slot, index) => ({
        id: slot.id,
        ...historicalCoordinates[index],
        assignedFixtureId: index === 0 ? ids.fixtureId : null
      }))));
      expect(restored.lightSlots).toHaveLength(2);
      expect(restored.lightSlots).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: currentSlot.id })]));
      await expect(prisma.fixture.findUniqueOrThrow({
        where: { id: ids.fixtureId },
        select: { x: true, y: true, placementStatus: true }
      })).resolves.toEqual({
        x: historicalCoordinates[0].x,
        y: historicalCoordinates[0].y,
        placementStatus: "placed"
      });
      const restoredRevision = await prisma.floorMapRevision.findUniqueOrThrow({
        where: { floorId_revision: { floorId: ids.floorId, revision: 2 } }
      });
      expect(restoredRevision.snapshot).toEqual(sourceRevision.snapshot);
      expect(restoredRevision.snapshotSha256).toBe(sourceRevision.snapshotSha256);
    } finally {
      await prisma.floorImportJob.deleteMany({ where: { id: { in: [historicalJobId, currentJobId] } } });
      await prisma.floorAsset.deleteMany({ where: { id: { in: [historicalAssetId, currentAssetId] } } });
    }
  });

  it("preserves an old ready asset when editor save wins the cleanup race", async () => {
    await activateLease();
    await prisma.floorAsset.update({
      where: { id: ids.assetId },
      data: { readyAt: new Date(Date.now() - 25 * 60 * 60_000), cleanupStartedAt: null }
    });
    const saveReachedAudit = deferred<void>();
    const releaseSave = deferred<void>();
    const audit = {
      record: jest.fn(async () => {
        saveReachedAudit.resolve();
        await releaseSave.promise;
      })
    };
    const editor = new FloorEditorService(prisma, siteAccess, audit as never);
    const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const cleanup = new FloorAssetCleanupService(prisma, storage as never);
    const saving = editor.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      floorPlan: {
        sourceType: "image",
        imageUrl: readyAssetPath,
        originalFileUrl: readyAssetPath,
        renderedImageUrl: readyAssetPath,
        width: 1200,
        height: 800
      },
      fixtureUpdates: []
    });
    await saveReachedAudit.promise;

    const cleaning = cleanup.processPending(new Date());
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(storage.deleteObject).not.toHaveBeenCalled();

    releaseSave.resolve();
    await saving;
    await cleaning;
    expect(storage.deleteObject).not.toHaveBeenCalled();
    await expect(prisma.floorAsset.findUniqueOrThrow({
      where: { id: ids.assetId },
      select: { cleanupStartedAt: true }
    })).resolves.toEqual({ cleanupStartedAt: null });
  });

  it("rejects an editor save when cleanup claims the ready asset first", async () => {
    await activateLease();
    await prisma.floorAsset.update({
      where: { id: ids.assetId },
      data: { readyAt: new Date(Date.now() - 25 * 60 * 60_000), cleanupStartedAt: null }
    });
    const deleteStarted = deferred<void>();
    const releaseDelete = deferred<void>();
    const storage = {
      deleteObject: jest.fn(async () => {
        deleteStarted.resolve();
        await releaseDelete.promise;
        throw new Error("storage unavailable");
      })
    };
    const cleanup = new FloorAssetCleanupService(prisma, storage as never);
    const cleanupNow = new Date();
    const cleaning = cleanup.processPending(cleanupNow);
    await deleteStarted.promise;
    const editor = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(editor.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      floorPlan: {
        sourceType: "image",
        imageUrl: readyAssetPath,
        originalFileUrl: readyAssetPath,
        renderedImageUrl: readyAssetPath,
        width: 1200,
        height: 800
      },
      fixtureUpdates: []
    })).rejects.toThrow("ready floor assets");

    releaseDelete.resolve();
    await cleaning;
    await expect(prisma.floorAsset.findUniqueOrThrow({
      where: { id: ids.assetId },
      select: { cleanupStartedAt: true }
    })).resolves.toEqual({ cleanupStartedAt: cleanupNow });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
  });

  it("skips a fixture removed after the source revision instead of recreating it", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    await prisma.fixture.create({
      data: {
        id: ids.missingFixtureId,
        floorId: ids.floorId,
        name: "B1-L02",
        ratedWatt: "30.00",
        x: 40,
        y: 50
      }
    });
    await service.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      fixtureUpdates: [{ id: ids.fixtureId, x: 20 }, { id: ids.missingFixtureId, x: 60 }]
    });
    await service.saveEditorState(operator, ids.floorId, {
      ...saveInput,
      expectedRevision: 1,
      fixtureUpdates: [{ id: ids.fixtureId, x: 30 }]
    });
    await prisma.fixture.delete({ where: { id: ids.missingFixtureId } });
    const nextLease = await activateLease("restore-lease-token", 2);

    await expect(service.restoreEditorRevision(operator, ids.floorId, 1, {
      expectedRevision: 2,
      leaseToken: nextLease.token,
      leaseFence: nextLease.fence
    })).resolves.toMatchObject({ skippedFixtureIds: [ids.missingFixtureId] });
    await expect(prisma.fixture.findUnique({ where: { id: ids.missingFixtureId } })).resolves.toBeNull();
  });

  it("rejects partial plans, non-ready assets, and foreign fixtures without changing revision state", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const invalidInputs = [
      { ...saveInput, floorPlan: { sourceType: "image" } },
      {
        ...saveInput,
        floorPlan: {
          sourceType: "image",
          imageUrl: "https://assets.example/not-ready.png",
          originalFileUrl: "https://assets.example/not-ready.png",
          renderedImageUrl: "https://assets.example/not-ready.png",
          width: 1200,
          height: 800
        }
      },
      { ...saveInput, fixtureUpdates: [{ id: ids.foreignFixtureId, x: 90 }] }
    ];

    for (const input of invalidInputs) {
      await expect(service.saveEditorState(operator, ids.floorId, input)).rejects.toThrow();
    }

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorPlan.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
  });

  it("rejects invalid merged object geometry without committing revision state", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));
    const rectangle = await prisma.floorMapObject.create({
      data: {
        floorId: ids.floorId,
        type: "rectangle",
        x: 10,
        y: 20,
        width: 100,
        height: 80
      }
    });

    await expect(service.saveEditorState(operator, ids.floorId, {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [{ id: rectangle.id, patch: { width: null } }],
      objectDeletes: []
    })).rejects.toBeInstanceOf(BadRequestException);

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorMapObject.findUniqueOrThrow({ where: { id: rectangle.id }, select: { width: true } }))
      .resolves.toEqual({ width: 100 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(0);
  });

  it("preserves opaque restore access before validating an invalid revision path", async () => {
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    await expect(service.restoreEditorRevision(otherAdmin, ids.floorId, "2147483648", {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence
    })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreEditorRevision(unassignedOperator, ids.floorId, "2147483648", {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence
    })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restoreEditorRevision(operator, ids.floorId, "2147483648", {
      expectedRevision: 0,
      leaseToken: lease.token,
      leaseFence: lease.fence
    })).rejects.toBeInstanceOf(BadRequestException);

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: ids.floorId }, select: { mapRevision: true } }))
      .resolves.toEqual({ mapRevision: 0 });
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(0);
  });

  it("commits only one of two concurrent saves with the same expected revision", async () => {
    await activateLease();
    const service = new FloorEditorService(prisma, siteAccess, new AuditService(prisma));

    const results = await Promise.allSettled([
      service.saveEditorState(operator, ids.floorId, {
        ...saveInput,
        fixtureUpdates: [{ id: ids.fixtureId, x: 20 }]
      }),
      service.saveEditorState(operator, ids.floorId, {
        ...saveInput,
        fixtureUpdates: [{ id: ids.fixtureId, x: 30 }]
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.floorMapRevision.count({ where: { floorId: ids.floorId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { siteId: ids.siteId } })).resolves.toBe(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
