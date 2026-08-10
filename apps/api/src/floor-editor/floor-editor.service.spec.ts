import { Test } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { FloorEditorService } from "./floor-editor.service";
import { hashEditorLeaseToken } from "./editor-lease-token";

describe("FloorEditorService", () => {
  const ids = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    siteId: "00000000-0000-4000-8000-000000000002",
    floorId: "00000000-0000-4000-8000-000000000003",
    fixtureId: "00000000-0000-4000-8000-000000000004"
  };
  const assignedOperator = {
    id: "operator-1",
    organizationId: "service-provider-1",
    organizationType: "service_provider" as const,
    email: "operator@example.com",
    name: "Operator",
    role: "operator" as const,
    status: "active" as const
  };

  async function createService(prismaOverrides: Record<string, unknown> = {}) {
    const prisma: any = {
      floor: {
        findUnique: jest.fn().mockResolvedValue({
          id: ids.floorId,
          siteId: ids.siteId,
          name: "B2",
          level: -2,
          mapRevision: 4,
          floorPlan: null,
          fixtures: [],
          mapObjects: []
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      floorPlan: { upsert: jest.fn(), deleteMany: jest.fn() },
      floorAsset: { count: jest.fn().mockResolvedValue(0) },
      fixture: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn()
      },
      floorMapObject: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        createMany: jest.fn()
      },
      floorMapRevision: { create: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      ...prismaOverrides
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FloorEditorService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SiteAccessService,
          useValue: {
            assert: jest.fn().mockResolvedValue({ id: ids.siteId, organizationId: ids.organizationId })
          }
        },
        { provide: AuditService, useValue: { record: jest.fn() } }
      ]
    }).compile();

    return { service: moduleRef.get(FloorEditorService), prisma };
  }

  it("returns editor state for an authorized floor", async () => {
    const { service, prisma } = await createService();

    await expect(service.getEditorState(ids.floorId, assignedOperator)).resolves.toMatchObject({
      floor: { id: ids.floorId, mapRevision: 4 }
    });
    expect(prisma.floor.findUnique).toHaveBeenCalledWith({
      where: { id: ids.floorId },
      include: {
        floorPlan: true,
        fixtures: { orderBy: { name: "asc" } },
        mapObjects: { orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }] }
      }
    });
  });

  it("requires the current authoritative lease inside the revision increment", async () => {
    const prisma: any = {
      floor: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({ siteId: ids.siteId })
          .mockResolvedValueOnce({
            id: ids.floorId,
            siteId: ids.siteId,
            name: "B2",
            level: -2,
            mapRevision: 5,
            floorPlan: null,
            fixtures: [],
            mapObjects: []
          })
          .mockResolvedValueOnce({
            mapRevision: 0,
            editorLeaseFence: 8,
            editorLeaseTokenHash: hashEditorLeaseToken("successor-token"),
            editorLeaseExpiresAt: new Date(Date.now() + 60_000)
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    };
    const { service } = await createService(prisma);

    await expect(service.saveEditorState(assignedOperator, ids.floorId, {
      expectedRevision: 0,
      leaseToken: "stale-token",
      leaseFence: 7,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it("preserves opaque access when the floor does not exist", async () => {
    const { service } = await createService({
      floor: {
        findUnique: jest.fn().mockResolvedValue(null)
      }
    });

    await expect(service.getEditorState(ids.floorId, assignedOperator)).rejects.toBeInstanceOf(NotFoundException);
  });
});
