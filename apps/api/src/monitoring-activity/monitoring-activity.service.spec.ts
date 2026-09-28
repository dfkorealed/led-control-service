import { BadRequestException, GoneException, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { MonitoringActivityService } from "./monitoring-activity.service";

const siteId = "00000000-0000-4000-8000-000000000001";
const floorId = "00000000-0000-4000-8000-000000000002";
const otherFloorId = "00000000-0000-4000-8000-000000000003";
const user = { id: "00000000-0000-4000-8000-000000000004" } as AuthenticatedUser;
const first = { id: "00000000-0000-4000-8000-000000000005", siteId, floorId,
  sourceType: "fixture", sourceKey: "source-1", kind: "fixture_status_changed",
  recordedAt: new Date("2026-09-25T01:00:00.000Z"), observedAt: null,
  fixtureId: null, displayName: "B1", status: "online", brightnessPercent: null,
  commandOutcome: null, refreshStatus: null, payload: { private: true }, ipAddress: "127.0.0.1" };
const second = { ...first, id: "00000000-0000-4000-8000-000000000006",
  recordedAt: new Date("2026-06-25T01:00:00.000Z") };

function setup(rows = [first, second]) {
  const prisma = {
    floor: { findUnique: jest.fn().mockResolvedValue({ siteId, status: "active" }) },
    monitoringActivity: { findMany: jest.fn().mockResolvedValue(rows) },
    $queryRaw: jest.fn().mockResolvedValue([{ generatedAt: new Date("2026-09-25T01:00:00.000Z"),
      retainedFrom: new Date("2026-06-25T01:00:00.000Z") }]),
    $transaction: jest.fn() as jest.Mock
  };
  prisma.$transaction.mockImplementation(async callback => callback(prisma));
  const access = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
  return { service: new MonitoringActivityService(prisma as never, access as never), prisma, access };
}

describe("MonitoringActivityService", () => {
  it("returns a read-authorized allowlist page with the exact rolling retention boundary", async () => {
    const { service, prisma, access } = setup();
    const result = await service.list(user, siteId, floorId, { limit: 1 });
    expect(access.assert).toHaveBeenCalledWith(user, siteId, "read");
    expect(result).toEqual({
      generatedAt: "2026-09-25T01:00:00.000Z", retainedFrom: "2026-06-25T01:00:00.000Z",
      items: [{ id: first.id, kind: "fixture_status_changed", recordedAt: "2026-09-25T01:00:00.000Z",
        displayName: "B1", status: "online" }], nextCursor: expect.any(String)
    });
    expect(prisma.monitoringActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ siteId, floorId, recordedAt: { gte: new Date("2026-06-25T01:00:00.000Z") } }),
      take: 2
    }));
  });

  it("rejects a cursor from another principal or floor without leaking rows", async () => {
    const { service, prisma } = setup();
    const page = await service.list(user, siteId, floorId, { limit: 1 });
    const cursor = page.nextCursor!;
    await expect(service.list({ ...user, id: otherFloorId }, siteId, floorId, { cursor })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(user, siteId, otherFloorId, { cursor })).rejects.toBeInstanceOf(BadRequestException);
    const otherSiteId = "00000000-0000-4000-8000-000000000007";
    prisma.floor.findUnique.mockResolvedValueOnce({ siteId: otherSiteId, status: "active" });
    await expect(service.list(user, otherSiteId, otherFloorId, { cursor })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.monitoringActivity.findMany).toHaveBeenCalledTimes(1);
  });

  it("distinguishes expired anchor from malformed cursor and checks site authority first", async () => {
    const { service, prisma, access } = setup([second, first]);
    const cursor = (await service.list(user, siteId, floorId, { limit: 1 })).nextCursor!;
    prisma.$queryRaw.mockResolvedValueOnce([{ generatedAt: new Date("2026-10-25T01:00:00.001Z"),
      retainedFrom: new Date("2026-07-25T01:00:00.001Z") }]);
    await expect(service.list(user, siteId, floorId, { cursor }))
      .rejects.toBeInstanceOf(GoneException);
    await expect(service.list(user, siteId, floorId, { cursor: "invalid+" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(user, siteId, floorId, { cursor: `${cursor}=` })).rejects.toBeInstanceOf(BadRequestException);
    access.assert.mockRejectedValueOnce(new NotFoundException("site not found"));
    await expect(service.list(user, siteId, floorId, { cursor: "invalid+" })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.monitoringActivity.findMany).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the DB clock row is unavailable", async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.list(user, siteId, floorId, {})).rejects.toThrow("monitoring activity DB clock unavailable");
    expect(prisma.monitoringActivity.findMany).not.toHaveBeenCalled();
  });
});
