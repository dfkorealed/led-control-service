import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "./site-access.service";

const databaseUrl = process.env.SITE_ACCESS_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("SiteAccessService PostgreSQL manage reauthorization", () => {
  let prisma: PrismaService;
  let competingPrisma: PrismaService;
  const organizationIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    competingPrisma = new PrismaService();
    await prisma.$connect();
    await competingPrisma.$connect();
  });

  afterEach(async () => {
    for (const organizationId of organizationIds.splice(0)) {
      const sites = await prisma.site.findMany({ where: { organizationId }, select: { id: true } });
      await prisma.floor.deleteMany({ where: { siteId: { in: sites.map((site) => site.id) } } });
      await prisma.site.updateMany({ where: { organizationId }, data: { adminUserId: null } });
      await prisma.site.deleteMany({ where: { organizationId } });
      await prisma.user.deleteMany({ where: { organizationId } });
      await prisma.organization.delete({ where: { id: organizationId } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await competingPrisma.$disconnect();
  });

  it.each(["reassigned", "disabled"] as const)(
    "blocks a stale admin write after the site is %s between the outer precheck and transaction",
    async (mode) => {
      const fixture = await createFixture(prisma);
      organizationIds.push(fixture.organizationId);
      const access = new SiteAccessService(prisma);
      const prechecked = deferred<void>();
      const continueWrite = deferred<void>();
      const staleWrite = (async () => {
        await access.assert(fixture.oldAdmin, fixture.siteId, "manage");
        prechecked.resolve();
        await continueWrite.promise;
        return prisma.$transaction(async (tx) => {
          await access.assertManageInTransaction(tx, fixture.oldAdmin, fixture.siteId);
          return tx.floor.create({ data: { siteId: fixture.siteId, name: "stale floor", level: 99 } });
        });
      })();

      await prechecked.promise;
      await competingPrisma.$transaction(async (tx) => {
        await tx.site.update({ where: { id: fixture.siteId }, data: { adminUserId: null } });
        await tx.user.update({ where: { id: fixture.oldAdmin.id }, data: { status: "disabled" } });
        if (mode === "reassigned") {
          await tx.site.update({ where: { id: fixture.siteId }, data: { adminUserId: fixture.newAdminId } });
        }
      });
      continueWrite.resolve();

      await expect(staleWrite).rejects.toBeInstanceOf(NotFoundException);
      await expect(prisma.floor.count({ where: { siteId: fixture.siteId, level: 99 } })).resolves.toBe(0);
    }
  );
});

async function createFixture(prisma: PrismaService) {
  const organizationId = randomUUID();
  const siteId = randomUUID();
  const oldAdminId = randomUUID();
  const newAdminId = randomUUID();
  await prisma.organization.create({ data: { id: organizationId, name: `Manage race ${siteId}`, type: "customer" } });
  await prisma.user.createMany({ data: [
    {
      id: oldAdminId,
      organizationId,
      loginId: `old_${oldAdminId.slice(0, 8)}`,
      email: null,
      name: "Old Admin",
      passwordHash: "test",
      role: "admin",
      status: "active"
    },
    {
      id: newAdminId,
      organizationId,
      loginId: `new_${newAdminId.slice(0, 8)}`,
      email: null,
      name: "New Admin",
      passwordHash: "test",
      role: "admin",
      status: "active"
    }
  ] });
  await prisma.site.create({
    data: { id: siteId, organizationId, adminUserId: oldAdminId, name: "Manage race site", address: "Seoul", tariffKwhRate: "160" }
  });
  const oldAdmin: AuthenticatedUser = {
    id: oldAdminId,
    organizationId,
    organizationType: "customer",
    loginId: `old_${oldAdminId.slice(0, 8)}`,
    name: "Old Admin",
    role: "admin",
    status: "active"
  };
  return { organizationId, siteId, oldAdmin, newAdminId };
}

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise as typeof resolve;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
