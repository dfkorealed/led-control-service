import type { AuthenticatedUser } from "../auth/auth.types";
import { AutomationController } from "./automation.controller";

const actor = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  organizationType: "customer",
  loginId: "viewer",
  name: "Viewer",
  role: "viewer",
  mustChangePassword: false,
  status: "active"
} satisfies AuthenticatedUser;

describe("AutomationController", () => {
  it("passes the raw schedule list query to the service for authorization-first parsing", async () => {
    const rawQuery = { limit: "not-valid", cursor: "also-not-valid" };
    const schedules = { list: jest.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }) };
    const controller = new AutomationController(schedules as never);

    await expect(controller.list("00000000-0000-4000-8000-000000000003", rawQuery, actor))
      .resolves.toMatchObject({ total: 0 });
    expect(schedules.list).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000003",
      actor,
      rawQuery
    );
  });
});
