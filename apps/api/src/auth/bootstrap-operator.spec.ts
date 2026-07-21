import { bootstrapFirstOperator } from "./bootstrap-operator";

describe("bootstrapFirstOperator", () => {
  it("creates the first service provider operator without deleting existing domain data", async () => {
    const prisma: any = {
      user: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "operator-1", email: "operator@example.com" })
      },
      organization: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "organization-1", name: "DF Korea" })
      },
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
    };

    const result = await bootstrapFirstOperator(
      prisma,
      { organizationName: "DF Korea Service", email: "OPERATOR@EXAMPLE.COM", name: "운영자", password: "secure-password" },
      async () => "scrypt$hash"
    );

    expect(result).toEqual({ organizationId: "organization-1", userId: "operator-1", email: "operator@example.com" });
    expect(prisma.organization.create).toHaveBeenCalledWith({
      data: { name: "DF Korea Service", type: "service_provider" }
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        organizationId: "organization-1",
        email: "operator@example.com",
        name: "운영자",
        passwordHash: "scrypt$hash",
        role: "operator",
        status: "active"
      }
    });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(80520260721)");
  });

  it("allows bootstrap when only customer users already exist", async () => {
    const prisma: any = {
      user: {
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "operator-1", email: "operator@example.com" })
      },
      organization: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "organization-1", name: "DF Korea" })
      },
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
    };

    await expect(bootstrapFirstOperator(prisma, input(), async () => "scrypt$hash")).resolves.toEqual({
      organizationId: "organization-1",
      userId: "operator-1",
      email: "operator@example.com"
    });
  });

  it("refuses when a service provider organization already exists", async () => {
    const prisma = bootstrapPrisma({ serviceProvider: { id: "service-provider-1" } });

    await expect(bootstrapFirstOperator(prisma, input(), async () => "scrypt$hash")).rejects.toThrow("BOOTSTRAP_REFUSED");
    expect(prisma.organization.create).not.toHaveBeenCalled();
  });

  it("refuses when an operator already exists", async () => {
    const prisma = bootstrapPrisma({ operator: { id: "operator-1" } });

    await expect(bootstrapFirstOperator(prisma, input(), async () => "scrypt$hash")).rejects.toThrow("BOOTSTRAP_REFUSED");
    expect(prisma.organization.create).not.toHaveBeenCalled();
  });
});

const input = () => ({
  organizationName: "DF Korea Service",
  email: "operator@example.com",
  name: "운영자",
  password: "secure-password"
});

const bootstrapPrisma = ({
  serviceProvider = null,
  operator = null
}: {
  serviceProvider?: { id: string } | null;
  operator?: { id: string } | null;
} = {}) => {
  const prisma: any = {
    user: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(operator),
      create: jest.fn().mockResolvedValue({ id: "operator-1", email: "operator@example.com" })
    },
    organization: {
      findFirst: jest.fn().mockResolvedValue(serviceProvider),
      create: jest.fn().mockResolvedValue({ id: "organization-1", name: "DF Korea" })
    },
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
  };

  return prisma;
};
