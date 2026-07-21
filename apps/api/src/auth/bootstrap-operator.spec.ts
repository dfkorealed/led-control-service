import { bootstrapFirstOperator } from "./bootstrap-operator";

describe("bootstrapFirstOperator", () => {
  it("creates the first service provider operator without deleting existing domain data", async () => {
    const prisma: any = {
      user: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: "operator-1", email: "operator@example.com" })
      },
      organization: {
        create: jest.fn().mockResolvedValue({ id: "organization-1", name: "DF Korea" })
      },
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
  });

  it("refuses to bootstrap when any user already exists", async () => {
    const prisma: any = {
      user: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
    };

    await expect(
      bootstrapFirstOperator(
        prisma,
        { organizationName: "DF Korea Service", email: "operator@example.com", name: "운영자", password: "secure-password" },
        async () => "scrypt$hash"
      )
    ).rejects.toThrow("BOOTSTRAP_REFUSED");
  });
});
