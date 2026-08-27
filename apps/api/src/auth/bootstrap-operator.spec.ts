import { bootstrapFirstOperator } from "./bootstrap-operator";

describe("bootstrapFirstOperator", () => {
  it("creates the first service provider operator with a normalized login id", async () => {
    const prisma = bootstrapPrisma();

    await expect(bootstrapFirstOperator(prisma, input() as any, async () => "scrypt$hash")).resolves.toEqual({
      organizationId: "organization-1",
      userId: "operator-1",
      loginId: "operator_01"
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        organizationId: "organization-1",
        loginId: "operator_01",
        email: null,
        name: "Operator",
        passwordHash: "scrypt$hash",
        role: "operator",
        status: "active"
      }
    });
  });

  it("refuses when a service provider organization or operator already exists", async () => {
    await expect(bootstrapFirstOperator(bootstrapPrisma({ operator: { id: "operator-1" } }), input() as any, async () => "scrypt$hash"))
      .rejects.toThrow("BOOTSTRAP_REFUSED");
    await expect(bootstrapFirstOperator(bootstrapPrisma({ serviceProvider: { id: "provider-1" } }), input() as any, async () => "scrypt$hash"))
      .rejects.toThrow("BOOTSTRAP_REFUSED");
  });

  it("normalizes a concurrent login id unique violation to BOOTSTRAP_REFUSED", async () => {
    const prisma = bootstrapPrisma();
    prisma.user.create.mockRejectedValue({ code: "P2002" });

    await expect(bootstrapFirstOperator(prisma, input() as any, async () => "scrypt$hash"))
      .rejects.toThrow("BOOTSTRAP_REFUSED");
  });
});

const input = () => ({
  organizationName: "DF Korea Service",
  loginId: " OPERATOR_01 ",
  name: "Operator",
  password: "secure-password"
});

const bootstrapPrisma = ({ serviceProvider = null, operator = null }: { serviceProvider?: { id: string } | null; operator?: { id: string } | null } = {}) => {
  const prisma: any = {
    user: {
      findFirst: jest.fn().mockResolvedValue(operator),
      create: jest.fn().mockResolvedValue({ id: "operator-1", loginId: "operator_01" })
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
