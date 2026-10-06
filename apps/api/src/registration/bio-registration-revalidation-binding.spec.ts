import { authorizeBioRegistrationGateway } from "./bio-registration-revalidation-binding";

describe("BIO registration Gateway authorization clock boundary", () => {
  it("refuses an invalid authority time before any Gateway/certificate lock", async () => {
    const query = jest.fn();
    await expect(authorizeBioRegistrationGateway({ $queryRaw: query } as never,
      { siteId: "site", gatewayId: "gateway", expectedAssignmentVersion: 2 }, new Date(NaN)))
      .rejects.toMatchObject({ status: 409 });
    expect(query).not.toHaveBeenCalled();
  });
});
