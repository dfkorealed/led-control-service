import { BadRequestException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { EnergyController } from "./energy.controller";

describe("EnergyController comparisons", () => {
  const user = {
    id: "user-1",
    organizationId: "org-1",
    organizationType: "customer",
    loginId: "fixture_user",
    name: "Admin",
    role: "admin",
    status: "active"
  } as AuthenticatedUser;

  it("parses and delegates a published comparison preset", async () => {
    const energyService = { getSiteComparisons: jest.fn().mockResolvedValue({ preset: "current_month" }) };
    const controller = new EnergyController(energyService as never);

    await expect(controller.getSiteComparisons(user, "site-1", "current_month")).resolves.toEqual({ preset: "current_month" });
    expect(energyService.getSiteComparisons).toHaveBeenCalledWith(user, "site-1", "current_month");
  });

  it("rejects an unknown preset before calling the service", () => {
    const energyService = { getSiteComparisons: jest.fn() };
    const controller = new EnergyController(energyService as never);

    expect(() => controller.getSiteComparisons(user, "site-1", "custom")).toThrow(BadRequestException);
    expect(energyService.getSiteComparisons).not.toHaveBeenCalled();
  });
});
