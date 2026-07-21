import { FixturesController } from "./fixtures.controller";

describe("FixturesController", () => {
  it("forwards the explicit site, floor, and pagination context to the fixtures service", async () => {
    const service = { getFloorFixtures: jest.fn().mockResolvedValue({ items: [], nextCursor: null }) };
    const controller = new FixturesController(service as never);
    const user = { id: "user-1", organizationId: "org-1", role: "admin" } as never;

    await controller.getFloorFixtures("site-1", "floor-1", "fixture-20", "100", user);

    expect(service.getFloorFixtures).toHaveBeenCalledWith(user, "site-1", "floor-1", {
      cursor: "fixture-20",
      limit: 100
    });
  });
});
