import { NotFoundException } from "@nestjs/common";
import { FixtureGroupsController } from "./fixture-groups.controller";

describe("FixtureGroupsController", () => {
  it("delegates malformed list queries before parsing so SiteAccess can preserve the 404 boundary", async () => {
    const fixtureGroups = {
      list: jest.fn().mockRejectedValue(new NotFoundException("site not found"))
    };
    const controller = new FixtureGroupsController(fixtureGroups as never);
    const user = { id: "user-1", role: "admin" } as never;

    await expect(controller.list("missing-site", { floorId: ["invalid"] }, user)).rejects.toThrow("site not found");
    expect(fixtureGroups.list).toHaveBeenCalledWith(user, "missing-site", { floorId: ["invalid"] });
  });
});
