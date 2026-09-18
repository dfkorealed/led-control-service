import { BadRequestException } from "@nestjs/common";
import { MonitoringRefreshController } from "./monitoring-refresh.controller";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationType: "customer" as const,
  loginId: "viewer@example.com",
  name: "Viewer",
  role: "viewer" as const,
  status: "active" as const,
  mustChangePassword: false
};
const siteId = "33333333-3333-4333-8333-333333333333";
const floorId = "44444444-4444-4444-8444-444444444444";
const refreshId = "55555555-5555-4555-8555-555555555555";
const clientRequestId = "66666666-6666-4666-8666-666666666666";

describe("MonitoringRefreshController", () => {
  it("strictly parses POST input and delegates only site, floor, identity, and current user", async () => {
    const service: any = { create: jest.fn().mockResolvedValue({ id: refreshId }) };
    const controller = new MonitoringRefreshController(service);

    await expect(controller.create(siteId, floorId, { clientRequestId }, user)).resolves.toEqual({ id: refreshId });
    expect(service.create).toHaveBeenCalledWith(user, siteId, floorId, { clientRequestId });

    expect(() => controller.create(siteId, floorId, { clientRequestId, fixtureIds: [refreshId] }, user))
      .toThrow(BadRequestException);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it("delegates site-scoped GET with the current user", async () => {
    const response = { id: refreshId, status: "pending" };
    const service: any = { get: jest.fn().mockResolvedValue(response) };
    const controller = new MonitoringRefreshController(service);
    await expect(controller.get(siteId, refreshId, user)).resolves.toEqual(response);
    expect(service.get).toHaveBeenCalledWith(user, siteId, refreshId);
  });
});
