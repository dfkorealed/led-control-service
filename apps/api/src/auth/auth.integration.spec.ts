import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("AuthService PostgreSQL viewer signup integration", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createViewerInvitation() {
    const organizationId = randomUUID();
    const siteId = randomUUID();
    const email = `viewer-${siteId}@example.com`;
    const rawToken = randomUUID();
    const service = new AuthService(prisma);
    await prisma.organization.create({ data: { id: organizationId, name: `Customer ${siteId.slice(0, 8)}`, type: "customer" } });
    await prisma.site.create({
      data: { id: siteId, organizationId, name: "Customer site", address: "Seoul", tariffKwhRate: "123.45" }
    });
    const invitation = await prisma.invitation.create({
      data: {
        organizationId,
        siteId,
        email,
        role: "viewer",
        tokenHash: service.hashToken(rawToken),
        expiresAt: new Date("2026-09-01T00:00:00.000Z")
      }
    });
    return { organizationId, siteId, email, rawToken, invitation };
  }

  it("stores loginId separately from the invitation contact email and grants viewer membership", async () => {
    const { siteId, email, rawToken, invitation } = await createViewerInvitation();
    const service = new AuthService(prisma);

    const result = await service.signup({
      token: rawToken,
      loginId: `viewer_${siteId.slice(0, 8)}`,
      email,
      name: "Viewer Member",
      password: "correct horse battery staple"
    });

    expect(result.user).toMatchObject({ loginId: `viewer_${siteId.slice(0, 8)}`, email, role: "viewer" });
    await expect(prisma.siteMembership.findFirstOrThrow({ where: { userId: result.user.id, siteId } })).resolves.toBeTruthy();
    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({ acceptedAt: expect.any(Date) });
  });

  it("rolls back invitation consumption when another user claims the same login id", async () => {
    const { organizationId, siteId, email, rawToken, invitation } = await createViewerInvitation();
    const loginId = `viewer_${siteId.slice(0, 8)}`;
    await prisma.user.create({
      data: {
        organizationId,
        loginId,
        email: `already-${siteId}@example.com`,
        name: "Existing Viewer",
        passwordHash: "scrypt$hash",
        role: "viewer",
        status: "active"
      }
    });
    const service = new AuthService(prisma);

    await expect(service.signup({
      token: rawToken,
      loginId,
      email,
      name: "Race Loser",
      password: "correct horse battery staple"
    })).rejects.toBeInstanceOf(BadRequestException);

    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({ acceptedAt: null });
  });
});
