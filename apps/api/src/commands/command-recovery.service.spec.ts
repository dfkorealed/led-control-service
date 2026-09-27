import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandSafetyDigest } from "./command-safety-digest";
import { CommandRecoveryService } from "./command-recovery.service";
import { CommandStatusService } from "./command-status.service";

const user: AuthenticatedUser = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId: "org-1",
  organizationType: "customer", loginId: "operator", name: "Operator", role: "admin", mustChangePassword: false, status: "active" };
const otherUser = { ...user, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const siteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const originalCommandId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const key = Buffer.alloc(32, 0x32).toString("base64url");
const now = new Date("2026-09-25T12:00:00.000Z");

function fixture() {
  const row = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", siteId, gatewayId: "gateway-1", originalCommandId,
    originalCreatedAt: new Date("2026-05-01T00:00:00.000Z"), createdAt: new Date("2026-05-01T00:00:00.000Z"),
    reasonCode: "outcome_unknown", verificationAttemptCount: 1, lastCheckedAt: null,
    _count: { targets: 2 }, recoveryDispatches: [] };
  const prisma = { unresolvedCommandHold: { findMany: jest.fn().mockResolvedValue([row]), findUnique: jest.fn().mockResolvedValue({
    ...row, targets: [{ fixtureId: "fixture-1" }, { fixtureId: "fixture-2" }]
  }) }, resolvedCommandRecovery: { findUnique: jest.fn().mockResolvedValue(null) } };
  const access = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
  const service = new (CommandRecoveryService as any)(prisma, access,
    new CommandSafetyDigest({ activeVersion: 1, keys: { 1: key } }));
  return { service, prisma, access, row };
}

describe("CommandRecoveryService read-only case contract", () => {
  it("lists only minimal active case fields and supports exact originalCommandId lookup", async () => {
    const { service, prisma, access } = fixture();
    const result = await service.listCases(user, { siteId, originalCommandId, limit: "1" }, now);
    expect(result).toEqual({ items: [{ caseId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", originalCommandId,
      siteId, targetCount: 2, verificationAttemptCount: 1, status: "verification_required",
      canRequestStatusCheck: true, lastCheckedAt: null, reasonCode: "outcome_unknown" }],
    nextCursor: null, generatedAt: now.toISOString() });
    expect(JSON.stringify(result)).not.toMatch(/gateway-1|fixture-1|brightness|payload/i);
    expect(access.assert).toHaveBeenCalledWith(user, siteId, "read");
    expect(prisma.unresolvedCommandHold.findMany.mock.calls[0][0]).toMatchObject({ where: { siteId, originalCommandId }, take: 2 });
  });

  it("authorizes the site before parsing the original filter or cursor", async () => {
    const { service, prisma, access } = fixture();
    access.assert.mockRejectedValue(new NotFoundException());
    await expect(service.listCases(user, { siteId, originalCommandId: "bad", cursor: "bad" }, now))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.unresolvedCommandHold.findMany).not.toHaveBeenCalled();
  });

  it("binds opaque pagination to principal, site, and exact filter", async () => {
    const { service, prisma } = fixture();
    prisma.unresolvedCommandHold.findMany.mockResolvedValueOnce([{ ...fixture().row }, { ...fixture().row, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }]);
    const first = await service.listCases(user, { siteId, originalCommandId, limit: "1" }, now);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(service.listCases(otherUser, { siteId, originalCommandId, cursor: first.nextCursor }, now))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listCases(user, { siteId, cursor: first.nextCursor }, now))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.listCases(user, { siteId: "11111111-1111-4111-8111-111111111111", originalCommandId,
      cursor: first.nextCursor }, now)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fails closed for pagination when the configured HMAC key is unavailable", async () => {
    const { prisma, access, row } = fixture();
    prisma.unresolvedCommandHold.findMany.mockResolvedValue([row, { ...row, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }]);
    const service = new (CommandRecoveryService as any)(prisma, access,
      new CommandSafetyDigest({ activeVersion: 1, keys: {} }));
    const unavailable = await service.listCases(user, { siteId, limit: "1" }, now).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(ServiceUnavailableException);
    expect(unavailable.getResponse()).toMatchObject({ code: "verification_case_cursor_unavailable" });
  });

  it("returns target IDs only in authorized case detail, without Set reconstruction fields", async () => {
    const { service } = fixture();
    const result = await service.getCase(user, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    expect(result).toMatchObject({ caseId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      targetFixtureIds: ["fixture-1", "fixture-2"] });
    expect(JSON.stringify(result)).not.toMatch(/expectedBrightness|idempotencyKey|sequence|payload/i);
  });

  it("returns only a bounded terminal classification after hold/dispatch deletion", async () => {
    const { service, prisma, access } = fixture();
    prisma.unresolvedCommandHold.findUnique.mockResolvedValue(null);
    prisma.resolvedCommandRecovery.findUnique.mockResolvedValue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      siteId, classification: "verified_partial", targetCount: 2,
      resolvedAt: new Date("2026-06-25T12:00:00.000Z") });
    const result = await service.getCase(user, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", now);
    expect(result).toEqual({ caseId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", siteId,
      status: "verified_partial", targetCount: 2, resolvedAt: "2026-06-25T12:00:00.000Z" });
    expect(JSON.stringify(result)).not.toMatch(/originalCommandId|fixtureId|brightness|gateway|payload/i);
    expect(access.assert).toHaveBeenCalledWith(user, siteId, "read");
  });

  it("keeps the exact UTC three-month terminal boundary but hides earlier and foreign summaries", async () => {
    const { service, prisma, access } = fixture();
    prisma.unresolvedCommandHold.findUnique.mockResolvedValue(null);
    const terminal = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", siteId,
      classification: "verified_not_applied", targetCount: 2,
      resolvedAt: new Date("2026-06-25T12:00:00.000Z") };
    prisma.resolvedCommandRecovery.findUnique.mockResolvedValue(terminal);
    await expect(service.getCase(user, terminal.id, now)).resolves.toMatchObject({ status: "verified_not_applied" });
    prisma.resolvedCommandRecovery.findUnique.mockResolvedValue({ ...terminal,
      resolvedAt: new Date("2026-06-25T11:59:59.999Z") });
    await expect(service.getCase(user, terminal.id, now)).rejects.toMatchObject({ status: 404 });
    prisma.resolvedCommandRecovery.findUnique.mockResolvedValue(terminal);
    access.assert.mockRejectedValue(new NotFoundException());
    await expect(service.getCase(otherUser, terminal.id, now)).rejects.toMatchObject({ status: 404 });
  });
});

(process.env.COMMAND_CASE_READ_TEST === "1" ? describe : describe.skip)(
  "read-only verification cases on disposable PostgreSQL", () => {
    let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
    let db: PrismaClient;
    let owner: AuthenticatedUser;
    let viewer: AuthenticatedUser;
    let site: string;
    let foreignSite: string;
    let newest: { id: string; originalCommandId: string; fixtureId: string };
    let older: { id: string; originalCommandId: string };
    let foreign: { id: string; originalCommandId: string };
    const at = new Date("2026-09-25T12:00:00.000Z");

    beforeAll(async () => {
      cluster = await disposablePostgres();
      const url = cluster.database();
      const deployed = cluster.deploy(url);
      expect(deployed.status).toBe(0);
      db = new PrismaClient({ datasourceUrl: url });
    }, 90_000);
    afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
    beforeEach(async () => {
      await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
      const organization = await db.organization.create({ data: { name: "case reads" } });
      const otherOrganization = await db.organization.create({ data: { name: "foreign case reads" } });
      const admin = await db.user.create({ data: { organizationId: organization.id, loginId: randomUUID(),
        name: "Site admin", passwordHash: "test", role: "admin" } });
      const reader = await db.user.create({ data: { organizationId: organization.id, loginId: randomUUID(),
        name: "Site reader", passwordHash: "test", role: "viewer" } });
      const foreignAdmin = await db.user.create({ data: { organizationId: otherOrganization.id, loginId: randomUUID(),
        name: "Foreign admin", passwordHash: "test", role: "admin" } });
      const ownedSite = await db.site.create({ data: { organizationId: organization.id, adminUserId: admin.id,
        name: "Owned site" } });
      const otherSite = await db.site.create({ data: { organizationId: otherOrganization.id,
        adminUserId: foreignAdmin.id, name: "Foreign site" } });
      await db.siteMembership.create({ data: { siteId: ownedSite.id, userId: reader.id, accessLevel: "read" } });
      site = ownedSite.id; foreignSite = otherSite.id;
      owner = { ...user, id: admin.id, organizationId: organization.id };
      viewer = { ...user, id: reader.id, organizationId: organization.id, role: "viewer" };
      const fixtureId = randomUUID();
      const recent = await db.unresolvedCommandHold.create({ data: { siteId: site, gatewayId: randomUUID(),
        originalCommandId: randomUUID(), originalCreatedAt: new Date("2026-03-01T00:00:00.000Z"),
        reasonCode: "outcome_unknown", createdAt: new Date("2026-09-02T00:00:00.000Z"),
        targets: { create: { fixtureId, expectedBrightness: 70 } } } });
      const old = await db.unresolvedCommandHold.create({ data: { siteId: site, gatewayId: randomUUID(),
        originalCommandId: randomUUID(), originalCreatedAt: new Date("2026-02-01T00:00:00.000Z"),
        reasonCode: "attempts_exhausted", createdAt: new Date("2026-09-01T00:00:00.000Z") } });
      const other = await db.unresolvedCommandHold.create({ data: { siteId: foreignSite, gatewayId: randomUUID(),
        originalCommandId: randomUUID(), originalCreatedAt: new Date("2026-03-01T00:00:00.000Z"),
        reasonCode: "gateway_unavailable", createdAt: new Date("2026-09-03T00:00:00.000Z") } });
      newest = { id: recent.id, originalCommandId: recent.originalCommandId, fixtureId };
      older = { id: old.id, originalCommandId: old.originalCommandId };
      foreign = { id: other.id, originalCommandId: other.originalCommandId };
    });

    function services() {
      const access = new SiteAccessService(db as never);
      return {
        recovery: new CommandRecoveryService(db as never, access,
          new CommandSafetyDigest({ activeVersion: 1, keys: { 1: key } })),
        history: new CommandStatusService(db as never, access)
      };
    }

    it("pages only the authorized site's cases and binds its cursor to the principal", async () => {
      const { recovery } = services();
      const first = await recovery.listCases(owner, { siteId: site, limit: "1" }, at);
      expect(first.items.map(item => item.caseId)).toEqual([newest.id]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await recovery.listCases(owner, { siteId: site, limit: "1", cursor: first.nextCursor }, at);
      expect(second.items.map(item => item.caseId)).toEqual([older.id]);
      expect(second.nextCursor).toBeNull();
      await expect(recovery.listCases(viewer, { siteId: site, limit: "1", cursor: first.nextCursor }, at))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(recovery.listCases(owner, { siteId: foreignSite, limit: "1", cursor: first.nextCursor }, at))
        .rejects.toBeInstanceOf(NotFoundException);
      const exact = await recovery.listCases(owner, { siteId: site,
        originalCommandId: newest.originalCommandId }, at);
      expect(exact.items.map(item => item.caseId)).toEqual([newest.id]);
    });

    it("returns authorized target IDs while hiding foreign case and original details", async () => {
      const { recovery, history } = services();
      const detail = await recovery.getCase(owner, newest.id, at);
      expect(detail).toMatchObject({ targetFixtureIds: [newest.fixtureId] });
      await expect(recovery.getCase(owner, foreign.id, at)).rejects.toBeInstanceOf(NotFoundException);
      await expect(history.getCommand(owner, newest.originalCommandId, at))
        .rejects.toMatchObject({ status: 410, response: { code: "command_expired" } });
      await expect(history.getCommand(owner, foreign.originalCommandId, at))
        .rejects.toMatchObject({ status: 404, response: { code: "command_not_found" } });
      await expect(history.getCommand(owner, randomUUID(), at))
        .rejects.toMatchObject({ status: 404, response: { code: "command_not_found" } });
    });

    it("keeps unpaginated reads available but returns sanitized 503 when cursor signing lacks a key", async () => {
      const recovery = new CommandRecoveryService(db as never, new SiteAccessService(db as never),
        new CommandSafetyDigest({ activeVersion: 1, keys: {} }));
      await expect(recovery.listCases(owner, { siteId: site, limit: "100" }, at))
        .resolves.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ caseId: newest.id })]),
          nextCursor: null });
      await expect(recovery.getCase(owner, newest.id, at)).resolves.toMatchObject({ caseId: newest.id });
      await expect(recovery.listCases(owner, { siteId: site, limit: "1" }, at))
        .rejects.toMatchObject({ status: 503, response: { code: "verification_case_cursor_unavailable" } });
    });
  });
