import { bootstrapFirstOwner } from "./bootstrap-owner";

describe("bootstrapFirstOwner", () => {
  it("creates the first organization owner without deleting existing domain data", async () => {
    const prisma: any = {
      user: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: "owner-1", email: "owner@example.com" })
      },
      organization: {
        create: jest.fn().mockResolvedValue({ id: "organization-1", name: "DF Korea" })
      },
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
    };

    const result = await bootstrapFirstOwner(
      prisma,
      { organizationName: "DF Korea", email: "OWNER@EXAMPLE.COM", name: "관리자", password: "secure-password" },
      async () => "scrypt$hash"
    );

    expect(result).toEqual({ organizationId: "organization-1", userId: "owner-1", email: "owner@example.com" });
    expect(prisma.organization.create).toHaveBeenCalledWith({ data: { name: "DF Korea" } });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        organizationId: "organization-1",
        email: "owner@example.com",
        name: "관리자",
        passwordHash: "scrypt$hash",
        role: "owner",
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
      bootstrapFirstOwner(
        prisma,
        { organizationName: "DF Korea", email: "owner@example.com", name: "관리자", password: "secure-password" },
        async () => "scrypt$hash"
      )
    ).rejects.toThrow("BOOTSTRAP_REFUSED");
  });
});
