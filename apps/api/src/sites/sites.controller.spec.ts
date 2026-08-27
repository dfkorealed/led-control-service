import { AuthenticatedUser } from "../auth/auth.types";
import { SitesController } from "./sites.controller";
import { SitesService } from "./sites.service";

describe("SitesController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    organizationId: "org-1",
    organizationType: "customer",
    loginId: "fixture_user",
    name: "Admin",
    role: "admin",
    status: "active"
  };

  it("passes authenticated access context to list, default, and explicit dashboard requests", () => {
    const sitesService = {
      listSites: jest.fn(),
      getDefaultDashboard: jest.fn(),
      getDashboard: jest.fn()
    } as unknown as SitesService;
    const controller = new SitesController(sitesService);

    controller.listSites(user);
    controller.getDefaultDashboard(user, "true");
    controller.getDashboard(user, "site-1", "false");

    expect(sitesService.listSites).toHaveBeenCalledWith(user);
    expect(sitesService.getDefaultDashboard).toHaveBeenCalledWith(user, true);
    expect(sitesService.getDashboard).toHaveBeenCalledWith(user, "site-1", false);
  });
});
