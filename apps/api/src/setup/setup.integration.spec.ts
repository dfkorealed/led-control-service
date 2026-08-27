import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SetupService } from "./setup.service";

const databaseUrl = process.env.INITIAL_SITE_SETUP_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("SetupService PostgreSQL integration", () => {
  let prisma: PrismaService;
  const organizationIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterEach(async () => {
    for (const organizationId of organizationIds.splice(0)) {
      await prisma.floorPlan.deleteMany({ where: { floor: { site: { organizationId } } } });
      await prisma.floor.deleteMany({ where: { site: { organizationId } } });
      await prisma.siteMembership.deleteMany({ where: { site: { organizationId } } });
      await prisma.site.deleteMany({ where: { organizationId } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("completes only the assigned pending site without changing organization or site counts and rejects retry", async () => {
    const scenario = await createPendingSite("complete");
    const service = createService(prisma);
    const before = await counts(scenario.organizationId);

    await service.completeInitialSite(scenario.admin, {
      siteId: scenario.siteId,
      address: "서울시 강남구",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul",
      floors: [{ name: "B2", level: -2, floorPlan: { imageUrl: "/plans/b2.svg", width: 1200, height: 800 } }]
    });

    const [stored, after] = await Promise.all([
      prisma.site.findUniqueOrThrow({ where: { id: scenario.siteId }, include: { floors: { include: { floorPlan: true } } } }),
      counts(scenario.organizationId)
    ]);
    expect(before).toEqual({ organizations: 1, sites: 1 });
    expect(after).toEqual(before);
    expect(stored).toMatchObject({ address: "서울시 강남구", tariffKwhRate: expect.anything(), timeZone: "Asia/Seoul" });
    expect(stored.floors).toEqual([expect.objectContaining({ name: "B2", level: -2, floorPlan: expect.objectContaining({ imageUrl: "/plans/b2.svg" }) })]);
    await expect(service.completeInitialSite(scenario.admin, {
      siteId: scenario.siteId, address: "서울시 강남구", tariffKwhRate: 160, floors: [{ name: "B1", level: -1 }]
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects the operator and another admin while allowing the assigned admin commission access", async () => {
    const scenario = await createPendingSite("access");
    const otherAdmin = await prisma.user.create({
      data: userData(scenario.organizationId, "other_admin", "admin")
    });
    const provider = await prisma.organization.create({ data: { id: randomUUID(), name: "Provider", type: "service_provider" } });
    organizationIds.push(provider.id);
    const operatorRecord = await prisma.user.create({ data: userData(provider.id, "operator", "operator") });
    const otherAdminUser = toAuthenticatedUser(otherAdmin, "customer");
    const operator = toAuthenticatedUser(operatorRecord, "service_provider");
    const access = new SiteAccessService(prisma);
    const service = createService(prisma);

    await expect(access.assert(scenario.admin, scenario.siteId, "commission")).resolves.toMatchObject({ id: scenario.siteId });
    await expect(access.assert(otherAdminUser, scenario.siteId, "read")).rejects.toBeInstanceOf(NotFoundException);
    await expect(access.assert(operator, scenario.siteId, "read")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.completeInitialSite(operator, {
      siteId: scenario.siteId, address: "서울", tariffKwhRate: 160, floors: [{ name: "B2", level: -2 }]
    })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.completeInitialSite(otherAdminUser, {
      siteId: scenario.siteId, address: "서울", tariffKwhRate: 160, floors: [{ name: "B2", level: -2 }]
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("allows exactly one concurrent completion of the same pending site", async () => {
    const scenario = await createPendingSite("race");
    const first = new PrismaService();
    const second = new PrismaService();
    await Promise.all([first.$connect(), second.$connect()]);

    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([first, second].map((client) => createService(client).completeInitialSite(scenario.admin, {
        siteId: scenario.siteId, address: "서울시 강남구", tariffKwhRate: 160, floors: [{ name: "B2", level: -2 }]
      })));
    } finally {
      await Promise.all([first.$disconnect(), second.$disconnect()]);
    }

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason instanceof ConflictException)).toHaveLength(1);
    await expect(prisma.floor.count({ where: { siteId: scenario.siteId } })).resolves.toBe(1);
    await expect(prisma.site.findUniqueOrThrow({ where: { id: scenario.siteId } })).resolves.toMatchObject({
      address: "서울시 강남구", tariffKwhRate: expect.anything()
    });
  }, 15_000);

  it("prevents stale admin floor creation after reassignment and disable", async () => {
    const scenario = await createPendingSite("add_floor_race");
    const replacement = await prisma.user.create({
      data: userData(scenario.organizationId, `replacement_${randomUUID().slice(0, 8)}`, "admin")
    });
    const realAccess = new SiteAccessService(prisma);
    let releasePrecheck!: () => void;
    let markPrecheckReached!: () => void;
    const precheckReached = new Promise<void>((resolve) => { markPrecheckReached = resolve; });
    const reassignmentComplete = new Promise<void>((resolve) => { releasePrecheck = resolve; });
    const gatedAccess = {
      assert: async (user: AuthenticatedUser, siteId: string, capability: "commission") => {
        const site = await realAccess.assert(user, siteId, capability);
        markPrecheckReached();
        await reassignmentComplete;
        return site;
      }
    } as SiteAccessService;
    const staleAttempt = createService(prisma, gatedAccess).addFloors(scenario.admin, {
      siteId: scenario.siteId,
      floors: [{ name: "B1", level: -1 }]
    });

    await precheckReached;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.site.update({ where: { id: scenario.siteId }, data: { adminUserId: null } });
        await tx.user.update({ where: { id: scenario.admin.id }, data: { status: "disabled" } });
        await tx.site.update({ where: { id: scenario.siteId }, data: { adminUserId: replacement.id } });
      });
    } finally {
      releasePrecheck();
    }

    await expect(staleAttempt).rejects.toBeInstanceOf(NotFoundException);
    await expect(prisma.floor.count({ where: { siteId: scenario.siteId } })).resolves.toBe(0);
    await expect(prisma.site.findUniqueOrThrow({ where: { id: scenario.siteId } })).resolves.toMatchObject({
      adminUserId: replacement.id
    });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: scenario.admin.id } })).resolves.toMatchObject({
      status: "disabled"
    });
  }, 15_000);

  async function createPendingSite(label: string) {
    const suffix = `${label}_${randomUUID().slice(0, 8)}`;
    const organization = await prisma.organization.create({ data: { id: randomUUID(), name: `${label} customer`, type: "customer" } });
    organizationIds.push(organization.id);
    const admin = await prisma.user.create({ data: userData(organization.id, `admin_${suffix}`, "admin") });
    const site = await prisma.site.create({
      data: { id: randomUUID(), organizationId: organization.id, adminUserId: admin.id, name: `${label} site`, address: null, tariffKwhRate: null }
    });
    return { organizationId: organization.id, siteId: site.id, admin: toAuthenticatedUser(admin, "customer") };
  }

  async function counts(organizationId: string) {
    const [organizations, sites] = await Promise.all([
      prisma.organization.count({ where: { id: organizationId } }),
      prisma.site.count({ where: { organizationId } })
    ]);
    return { organizations, sites };
  }
});

function createService(prisma: PrismaService, siteAccess = new SiteAccessService(prisma)) {
  return new SetupService(
    prisma,
    { getDashboardById: jest.fn().mockResolvedValue({}) } as never,
    siteAccess
  );
}

function userData(organizationId: string, loginId: string, role: "operator" | "admin") {
  return {
    id: randomUUID(), organizationId, loginId, email: null, name: loginId,
    passwordHash: "integration-only", role, status: "active" as const
  };
}

function toAuthenticatedUser(
  user: Pick<AuthenticatedUser, "id" | "organizationId" | "loginId" | "name" | "role" | "status">,
  organizationType: "service_provider" | "customer"
): AuthenticatedUser {
  return { ...user, organizationType };
}
