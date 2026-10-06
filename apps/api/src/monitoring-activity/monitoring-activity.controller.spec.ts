import { BadRequestException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { MonitoringActivityController } from "./monitoring-activity.controller";

const siteId = "00000000-0000-4000-8000-000000000001";
const floorId = "00000000-0000-4000-8000-000000000002";
const user = { id: "00000000-0000-4000-8000-000000000003" } as AuthenticatedUser;
function setup() {
  const service = { list: jest.fn().mockReturnValue({ items: [], nextCursor: null }) };
  return { service, controller: new MonitoringActivityController(service as never) };
}

describe("MonitoringActivityController log query", () => {
  it("monitoring_limit_1000_preserves_floor_scope parses a paired date range and the new maximum", () => {
    const { controller, service } = setup();
    controller.list(user, siteId, floorId, { limit: "1000", fromDate: "2026-10-01", toDate: "2026-10-01" });
    expect(service.list).toHaveBeenCalledWith(user, siteId, floorId,
      { limit: 1000, fromDate: "2026-10-01", toDate: "2026-10-01" });
  });

  it("keeps the compact service default instead of forcing the full-screen size", () => {
    const { controller, service } = setup();
    controller.list(user, siteId, floorId, {});
    expect(service.list).toHaveBeenCalledWith(user, siteId, floorId, {});
  });

  it.each([
    { limit: "1001" }, { limit: "0" }, { limit: "1.5" }, { limit: "1e3" }, { limit: ["1000"] },
    { fromDate: "2026-10-01" }, { toDate: "2026-10-01" },
    { fromDate: "2026-02-29", toDate: "2026-03-01" },
    { fromDate: "2026-10-02", toDate: "2026-10-01" },
    { fromDate: "2026-1-01", toDate: "2026-10-01" },
    { fromDate: ["2026-10-01"], toDate: "2026-10-01" },
    { cursor: "x".repeat(513) }, { unknown: "field" },
  ])("log_dates_pair_invalid_and_site_day_inclusive rejects invalid query %p", query => {
    const { controller, service } = setup();
    expect(() => controller.list(user, siteId, floorId, query)).toThrow(BadRequestException);
    expect(service.list).not.toHaveBeenCalled();
  });
});
