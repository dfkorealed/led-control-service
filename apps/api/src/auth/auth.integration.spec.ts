import { BadRequestException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("AuthService PostgreSQL signup integration", () => {
  let providerOrganizationId = "00000000-0000-4000-8000-00000000a001";
  let prisma: PrismaService;
  let competingPrisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    competingPrisma = new PrismaService();
    await prisma.$connect();
    await competingPrisma.$connect();
    const existingProvider = await prisma.organization.findFirst({
      where: { type: "service_provider" },
      select: { id: true }
    });
    if (existingProvider) {
      providerOrganizationId = existingProvider.id;
      return;
    }
    await prisma.organization.create({
      data: { id: providerOrganizationId, name: "Integration Provider", type: "service_provider" }
    });
  });

  afterAll(async () => {
    await competingPrisma.$disconnect();
    await prisma.$disconnect();
  });

  async function createCustomerSite() {
    const customerOrganizationId = randomUUID();
    const foreignOrganizationId = randomUUID();
    const siteId = randomUUID();
    const foreignSiteId = randomUUID();
    await prisma.organization.createMany({
      data: [
        { id: customerOrganizationId, name: `Customer ${siteId.slice(0, 8)}`, type: "customer" },
        { id: foreignOrganizationId, name: `Foreign ${foreignSiteId.slice(0, 8)}`, type: "customer" }
      ]
    });
    await prisma.site.createMany({
      data: [
        { id: siteId, organizationId: customerOrganizationId, name: "Customer site", address: "Seoul", tariffKwhRate: "123.45" },
        { id: foreignSiteId, organizationId: foreignOrganizationId, name: "Foreign site", address: "Busan", tariffKwhRate: "234.56" }
      ]
    });
    return { customerOrganizationId, foreignOrganizationId, siteId, foreignSiteId };
  }

  async function createInvitation(input: {
    organizationId: string;
    siteId?: string | null;
    email: string;
    role: "operator" | "admin" | "viewer";
  }) {
    const rawToken = randomUUID();
    const service = new AuthService(prisma);
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: input.organizationId,
        siteId: input.siteId ?? null,
        email: input.email,
        role: input.role,
        tokenHash: service.hashToken(rawToken),
        expiresAt: new Date("2026-08-17T00:00:00.000Z")
      }
    });
    return { invitation, rawToken };
  }

  it("atomically creates an operator membership during signup", async () => {
    const { siteId } = await createCustomerSite();
    const { rawToken, invitation } = await createInvitation({
      organizationId: providerOrganizationId,
      siteId,
      email: `operator-${siteId}@example.com`,
      role: "operator"
    });
    const service = new AuthService(prisma);

    const result = await service.signup({
      token: rawToken,
      email: invitation.email!,
      name: "Operator Member",
      password: "correct horse battery staple"
    });

    const membership = await prisma.siteMembership.findFirstOrThrow({
      where: { userId: result.user.id, siteId }
    });
    expect(membership.siteId).toBe(siteId);
    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({
      acceptedAt: expect.any(Date)
    });
  });

  it("atomically creates a viewer membership during signup", async () => {
    const { customerOrganizationId, siteId } = await createCustomerSite();
    const { rawToken, invitation } = await createInvitation({
      organizationId: customerOrganizationId,
      siteId,
      email: `viewer-${siteId}@example.com`,
      role: "viewer"
    });
    const service = new AuthService(prisma);

    const result = await service.signup({
      token: rawToken,
      email: invitation.email!,
      name: "Viewer Member",
      password: "correct horse battery staple"
    });

    await expect(prisma.siteMembership.findFirstOrThrow({
      where: { userId: result.user.id, siteId }
    })).resolves.toBeTruthy();
  });

  it("rejects a viewer invitation without a site assignment and leaves the invitation unconsumed", async () => {
    const { customerOrganizationId } = await createCustomerSite();
    const { rawToken, invitation } = await createInvitation({
      organizationId: customerOrganizationId,
      siteId: null,
      email: `viewer-missing-${customerOrganizationId}@example.com`,
      role: "viewer"
    });
    const service = new AuthService(prisma);

    await expect(service.signup({
      token: rawToken,
      email: invitation.email!,
      name: "Missing Viewer",
      password: "correct horse battery staple"
    })).rejects.toThrow("viewer invitations require a valid customer site assignment");

    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({
      acceptedAt: null
    });
    await expect(prisma.user.findUnique({ where: { email: invitation.email! } })).resolves.toBeNull();
  });

  it("rejects a viewer invitation with an invalid site assignment and leaves the invitation unconsumed", async () => {
    const { customerOrganizationId, siteId } = await createCustomerSite();
    const { rawToken, invitation } = await createInvitation({
      organizationId: customerOrganizationId,
      siteId,
      email: `viewer-invalid-${customerOrganizationId}@example.com`,
      role: "viewer"
    });
    const service = new AuthService(prisma.$extends({
      query: {
        site: {
          async findUnique({ args, query }) {
            const result = await query(args);
            return args.where?.id === siteId ? null : result;
          }
        }
      }
    }) as unknown as PrismaService);

    await expect(service.signup({
      token: rawToken,
      email: invitation.email!,
      name: "Invalid Viewer",
      password: "correct horse battery staple"
    })).rejects.toThrow("viewer invitations require a valid customer site assignment");

    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({
      acceptedAt: null
    });
    await expect(prisma.user.findUnique({ where: { email: invitation.email! } })).resolves.toBeNull();
  });

  it("rejects a cross-organization viewer invitation and leaves the invitation unconsumed", async () => {
    const { customerOrganizationId, foreignSiteId } = await createCustomerSite();
    const { rawToken, invitation } = await createInvitation({
      organizationId: customerOrganizationId,
      siteId: foreignSiteId,
      email: `viewer-cross-${foreignSiteId}@example.com`,
      role: "viewer"
    });
    const service = new AuthService(prisma);

    await expect(service.signup({
      token: rawToken,
      email: invitation.email!,
      name: "Cross Viewer",
      password: "correct horse battery staple"
    })).rejects.toThrow("viewer invitations require a valid customer site assignment");

    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({
      acceptedAt: null
    });
    await expect(prisma.user.findUnique({ where: { email: invitation.email! } })).resolves.toBeNull();
  });

  it("rolls back invitation consumption and membership creation when a competing user wins after precheck", async () => {
    const { siteId } = await createCustomerSite();
    const email = `operator-race-${siteId}@example.com`;
    const { rawToken, invitation } = await createInvitation({
      organizationId: providerOrganizationId,
      siteId,
      email,
      role: "operator"
    });
    const racingPrisma = prisma.$extends({
      query: {
        user: {
          async findUnique({ args, query }) {
            const result = await query(args);
            if (!result && args.where?.email === email) {
              await competingPrisma.user.create({
                data: {
                  organizationId: providerOrganizationId,
                  email,
                  name: "Competing Operator",
                  passwordHash: "test",
                  role: "operator",
                  status: "active"
                }
              });
            }
            return result;
          }
        }
      }
    });
    const service = new AuthService(racingPrisma as unknown as PrismaService);

    await expect(service.signup({
      token: rawToken,
      email,
      name: "Race Loser",
      password: "correct horse battery staple"
    })).rejects.toBeInstanceOf(BadRequestException);

    await expect(prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).resolves.toMatchObject({
      acceptedAt: null
    });
    await expect(prisma.siteMembership.count({ where: { siteId } })).resolves.toBe(0);
  });
});
