import { BioRegistrationRevalidationService } from "./bio-registration-revalidation.service";

describe("BIO registration revalidation service input boundary", () => {
  it.each([null, {}, { siteId: "invalid" }, { actorId: "forged", deviceUuid: "bio:aabbccddeeff" }])(
    "create rejects invalid or caller-owned identity before a transaction: %j", async input => {
      const prisma = { $transaction: jest.fn() };
      const service = new BioRegistrationRevalidationService(prisma as never, {} as never, {} as never);
      await expect(service.create({} as never, input)).rejects.toMatchObject({ status: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  it.each(["get", "apply"] as const)("%s rejects a session path identifier before a database read", async method => {
    const prisma = { $transaction: jest.fn() };
    const service = new BioRegistrationRevalidationService(prisma as never, {} as never, {} as never);
    await expect(service[method]({} as never, "active")).rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
