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
  const access = { assert: jest.fn().mockResolvedValue({ id: siteId, timeZone: "Asia/Seoul" }) };
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
      where: expect.objectContaining({ siteId, floorId, recordedAt: {
        gte: new Date("2026-06-25T01:00:00.000Z"), lt: new Date("2026-09-25T01:00:00.000Z")
      } }),
      take: 2
    }));
  });

  it("rejects a cursor from another principal or floor without leaking rows", async () => {
    const { service, prisma } = setup();
    const page = await service.list(user, siteId, floorId, { limit: 1 });
    const cursor = page.nextCursor!;
    await expect(service.list({ ...user, id: otherFloorId }, siteId, floorId, { cursor, limit: 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(user, siteId, otherFloorId, { cursor, limit: 1 })).rejects.toBeInstanceOf(BadRequestException);
    const otherSiteId = "00000000-0000-4000-8000-000000000007";
    prisma.floor.findUnique.mockResolvedValueOnce({ siteId: otherSiteId, status: "active" });
    await expect(service.list(user, otherSiteId, otherFloorId, { cursor, limit: 1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.monitoringActivity.findMany).toHaveBeenCalledTimes(1);
  });

  it("distinguishes expired anchor from malformed cursor and checks site authority first", async () => {
    const { service, prisma, access } = setup([second, first]);
    const cursor = (await service.list(user, siteId, floorId, { limit: 1 })).nextCursor!;
    prisma.$queryRaw.mockResolvedValueOnce([{ generatedAt: new Date("2026-10-25T01:00:00.001Z"),
      retainedFrom: new Date("2026-07-25T01:00:00.001Z") }]);
    await expect(service.list(user, siteId, floorId, { cursor, limit: 1 }))
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

  it("monitoring_limit_1000_preserves_floor_scope and precise local-day boundaries", async () => {
    const { service, prisma } = setup([first]);
    prisma.$queryRaw.mockResolvedValue([{ generatedAt: new Date("2026-10-02T12:00:00.123Z"),
      retainedFrom: new Date("2026-07-02T12:00:00.123Z") }]);
    const input = { limit: 1000, fromDate: "2026-10-01", toDate: "2026-10-01" };
    await expect(service.list(user, siteId, floorId, input)).resolves.toMatchObject({ items: [{ id: first.id }] });
    expect(prisma.monitoringActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 1001, where: { siteId, floorId, recordedAt: {
        gte: new Date("2026-09-30T15:00:00.000Z"), lt: new Date("2026-10-01T15:00:00.000Z")
      } }
    }));
    await expect(service.list(user, siteId, floorId, { limit: 1001 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns all 1000 allowlisted records and reserves the extra row only for nextCursor", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({ ...first,
      id: `00000000-0000-4000-8000-${(1001 - index).toString().padStart(12, "0")}` }));
    const { service } = setup(rows);
    const page = await service.list(user, siteId, floorId, { limit: 1000 });
    expect(page.items).toHaveLength(1000);
    expect(page.items.at(-1)?.id).toBe("00000000-0000-4000-8000-000000000002");
    expect(page.items.some(row => row.id === rows[1000].id)).toBe(false);
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())).toMatchObject({
      version: 2, id: "00000000-0000-4000-8000-000000000002"
    });
    expect(page.items.every(row => !("payload" in row) && !("ipAddress" in row))).toBe(true);
  });

  it("binds v2 to limit and period, issues a compact cursor and keeps the default five", async () => {
    const { service, prisma } = setup();
    const page = await service.list(user, siteId, floorId, { limit: 1 });
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())).toMatchObject({ version: 2 });
    expect(Buffer.byteLength(page.nextCursor!)).toBeLessThanOrEqual(512);
    await expect(service.list(user, siteId, floorId, { cursor: page.nextCursor!, limit: 2 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(user, siteId, floorId, { cursor: page.nextCursor!, limit: 1,
      fromDate: "2026-09-01", toDate: "2026-09-25" })).rejects.toBeInstanceOf(BadRequestException);
    prisma.monitoringActivity.findMany.mockResolvedValue([]);
    await service.list(user, siteId, floorId, {});
    expect(prisma.monitoringActivity.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 6 }));
  });

  it("returns an empty intersection without reading outside the selected period", async () => {
    const { service, prisma } = setup();
    await expect(service.list(user, siteId, floorId, { fromDate: "2026-01-01", toDate: "2026-01-02" }))
      .resolves.toMatchObject({ items: [], nextCursor: null, retainedFrom: "2026-06-25T01:00:00.000Z" });
    expect(prisma.monitoringActivity.findMany).not.toHaveBeenCalled();
    await expect(service.list(user, siteId, floorId, { fromDate: "2026-09-01" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("log_cursor_ties_and_legacy_compatibility keeps v1 only for old no-date limits", async () => {
    const { service } = setup();
    const cursor = Buffer.from(JSON.stringify({ version: 1, principalId: user.id, siteId, floorId,
      recordedAt: first.recordedAt.toISOString(), id: first.id })).toString("base64url");
    const page = await service.list(user, siteId, floorId, { cursor, limit: 1 });
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString()).version).toBe(2);
    await expect(service.list(user, siteId, floorId, { cursor, limit: 51 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list(user, siteId, floorId, { cursor, fromDate: "2026-09-01", toDate: "2026-09-25" }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("log_cursor_ties_and_legacy_compatibility preserves millisecond anchors and descending IDs", async () => {
    const stamp = new Date("2026-09-25T00:59:59.123Z");
    const rows = [9, 8, 7].map(id => ({ ...first, recordedAt: stamp,
      id: `00000000-0000-4000-8000-00000000000${id}` }));
    const { service, prisma } = setup(rows);
    const page = await service.list(user, siteId, floorId, { limit: 2 });
    prisma.monitoringActivity.findMany.mockResolvedValue([rows[2]]);
    const next = await service.list(user, siteId, floorId, { limit: 2, cursor: page.nextCursor! });
    expect([...page.items, ...next.items].map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(prisma.monitoringActivity.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [
        { recordedAt: { lt: stamp } }, { recordedAt: stamp, id: { lt: rows[1].id } }
      ] }), orderBy: [{ recordedAt: "desc" }, { id: "desc" }]
    }));
    expect(next.nextCursor).toBeNull();
  });
});
