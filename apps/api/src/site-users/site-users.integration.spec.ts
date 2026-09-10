import { Prisma } from "@prisma/client";
import {
  gatewayDimmingCommandDraftV2Schema,
  gatewayDimmingCommandPublishedV2Schema
} from "@led-control/shared";
import { Test } from "@nestjs/testing";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { OutboxPublisherService } from "../mqtt/outbox-publisher.service";
import { PrismaService } from "../prisma/prisma.service";
import { SiteUsersService } from "./site-users.service";
import { SiteUsersModule } from "./site-users.module";

const databaseUrl = process.env.SITE_USERS_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

// Only this generated schema is modified. Use the real Prisma schema and the
// production assignment triggers, not simplified tables that hide lock conflicts.
describeDatabase("Site Users PostgreSQL concurrency and deletion", () => {
  const schema = `site_users_${randomUUID().replaceAll("-", "")}`;
  let prisma: PrismaService;
  let competitor: PrismaService;
  let service: SiteUsersService;
  let audit: AuditService;
  let admin: AuthenticatedUser;
  let siteId: string;
  const passwords = new PasswordService();
  const input = (suffix = randomUUID().slice(0, 8)) => ({
    name: "일반 사용자", loginId: `member_${suffix}`, temporaryPassword: "Temporary-123",
    accessLevel: "control", status: "active"
  });
  const sql = (statement: string) => {
    const url = new URL(databaseUrl!);
    url.searchParams.delete("schema");
    const password = decodeURIComponent(url.password);
    url.password = "";
    const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--dbname", url.toString()], {
      env: { ...process.env, PGPASSWORD: password }, encoding: "utf8", input: statement
    });
    if (result.status !== 0) throw new Error(`Test schema SQL failed: ${result.stderr}`);
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    url.searchParams.set("schema", schema);
    sql(`CREATE SCHEMA "${schema}";`);
    const generated = spawnSync("pnpm", ["exec", "prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], {
      cwd: join(__dirname, "../.."), env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8"
    });
    if (generated.status !== 0) throw new Error(`Prisma test DDL failed: ${generated.stderr}`);
    const migration = readFileSync(join(__dirname, "../../prisma/migrations/20260827090000_operator_admin_account_flow/migration.sql"), "utf8");
    const triggers = migration.slice(migration.indexOf('CREATE FUNCTION "serialize_admin_assignment_writes"'), migration.lastIndexOf("COMMIT;"));
    sql(`SET search_path TO "${schema}";\n${generated.stdout}\n${triggers}`);
    prisma = new PrismaService({ datasources: { db: { url: url.toString() } } });
    competitor = new PrismaService({ datasources: { db: { url: url.toString() } } });
    await prisma.$connect();
    await competitor.$connect();
    audit = new AuditService(prisma);
    service = new SiteUsersService(prisma, new SiteAccessService(prisma), passwords, audit);
  }, 60_000);

  beforeEach(async () => {
    const org = await prisma.organization.create({ data: { name: "현장 유저 테스트", type: "customer" } });
    const user = await prisma.user.create({ data: {
      organizationId: org.id, loginId: `admin_${randomUUID()}`, name: "관리자", passwordHash: "unused", role: "admin"
    } });
    const site = await prisma.site.create({ data: { organizationId: org.id, adminUserId: user.id, name: "테스트 현장" } });
    siteId = site.id;
    admin = { id: user.id, organizationId: org.id, organizationType: "customer", role: "admin", mustChangePassword: user.mustChangePassword, status: "active", loginId: user.loginId, name: user.name };
  });

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    await prisma?.$disconnect();
    await competitor?.$disconnect();
    sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  });

  it("admits exactly one of two concurrent creates at 99 active+disabled users", async () => {
    const users = Array.from({ length: 99 }, (_, i) => ({
      id: randomUUID(), organizationId: admin.organizationId, loginId: `seed_${randomUUID()}`,
      name: "seed", passwordHash: "unused", role: "viewer" as const, status: i % 2 ? "active" as const : "disabled" as const
    }));
    await prisma.user.createMany({ data: users });
    await prisma.siteMembership.createMany({ data: users.map((u) => ({ userId: u.id, siteId })) });
    const other = new SiteUsersService(competitor, new SiteAccessService(competitor), passwords, new AuditService(competitor));
    const results = await Promise.allSettled([service.create(admin, siteId, input("first")), other.create(admin, siteId, input("second"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { response: { code: "USER_LIMIT_REACHED" } } });
    expect((await service.list(admin, siteId)).count).toBe(100);
    expect(await prisma.user.count({ where: { organizationId: admin.organizationId } })).toBe(101);
  }, 20_000);

  it("rolls back user and membership when audit insertion fails", async () => {
    jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("audit unavailable"));
    const body = input();
    await expect(service.create(admin, siteId, body)).rejects.toThrow("site user operation failed");
    expect(await prisma.user.findUnique({ where: { loginId: body.loginId } })).toBeNull();
    expect(await prisma.siteMembership.count({ where: { siteId } })).toBe(0);
  });

  it.each([0, 1, 2])("enforces one shared last slot when admin create and invitation signup compete (%i)", async () => {
    const users = Array.from({ length: 99 }, (_, i) => ({
      id: randomUUID(), organizationId: admin.organizationId, loginId: `mixed_${randomUUID()}`,
      name: "seed", passwordHash: "unused", role: "viewer" as const,
      status: i % 2 ? "active" as const : "disabled" as const
    }));
    await prisma.user.createMany({ data: users });
    await prisma.siteMembership.createMany({ data: users.map((u) => ({ userId: u.id, siteId })) });
    const token = randomUUID();
    const invitation = await prisma.invitation.create({ data: {
      organizationId: admin.organizationId, siteId, role: "viewer", email: `${randomUUID()}@example.com`,
      tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000)
    } });
    const auth = new AuthService(competitor, passwords, new AuditService(competitor));
    const signupBody = { token, loginId: `invited_${randomUUID()}`, email: invitation.email!, name: "초대 사용자", password: "Invitation-123" };
    const results = await Promise.allSettled([
      service.create(admin, siteId, input()), auth.signup(signupBody)
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { response: { code: "USER_LIMIT_REACHED" } } });
    expect((await service.list(admin, siteId)).count).toBe(100);
    const storedInvitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    if (results[1].status === "rejected") {
      expect(storedInvitation.acceptedAt).toBeNull();
      expect(await prisma.user.findUnique({ where: { loginId: signupBody.loginId } })).toBeNull();
    } else {
      expect(storedInvitation.acceptedAt).not.toBeNull();
      expectNoPasswordSecrets(results[1].value, [signupBody.password]);
    }
  });

  it("rejects invitation signup at 100 users without consuming the token", async () => {
    const users = Array.from({ length: 100 }, () => ({
      id: randomUUID(), organizationId: admin.organizationId, loginId: `full_${randomUUID()}`,
      name: "seed", passwordHash: "unused", role: "viewer" as const, status: "disabled" as const
    }));
    await prisma.user.createMany({ data: users });
    await prisma.siteMembership.createMany({ data: users.map((u) => ({ userId: u.id, siteId })) });
    const token = randomUUID();
    const invitation = await prisma.invitation.create({ data: {
      organizationId: admin.organizationId, siteId, role: "viewer", email: "full@example.com",
      tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000)
    } });
    const auth = new AuthService(prisma, passwords, audit);
    await expect(auth.signup({ token, loginId: "full_invited", email: invitation.email!, name: "초대", password: "Invitation-123" }))
      .rejects.toMatchObject({ response: { code: "USER_LIMIT_REACHED" } });
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedAt).toBeNull();
    expect(await prisma.user.findUnique({ where: { loginId: "full_invited" } })).toBeNull();
  });

  it("returns safe summaries and preserves password on disable/reactivate", async () => {
    const member = await service.create(admin, siteId, input());
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: member.id } });
    const auth = new AuthService(prisma, passwords, audit);
    const login = await auth.login({ loginId: member.loginId, password: "Temporary-123", rememberMe: false });
    const latest = (await service.list(admin, siteId)).users[0];
    expect(latest.lastLoginAt).not.toBeNull();
    expect(Object.keys(latest).sort()).toEqual(["id", "name", "loginId", "accessLevel", "status", "lastLoginAt", "createdAt", "updatedAt"].sort());
    const disabled = await service.update(admin, siteId, member.id, {
      name: member.name, loginId: member.loginId, accessLevel: "control",
      expectedUpdatedAt: latest.updatedAt.toISOString(), status: "disabled"
    });
    await expect(auth.getUserBySessionToken(login.sessionToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login({ loginId: member.loginId, password: "Temporary-123", rememberMe: false })).rejects.toMatchObject({ status: 401 });
    await service.update(admin, siteId, member.id, {
      name: member.name, loginId: member.loginId, accessLevel: "read", status: "active", expectedUpdatedAt: disabled.updatedAt.toISOString()
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).passwordHash).toBe(stored.passwordHash);
    expect((await service.list(admin, siteId)).count).toBe(1);
  });

  it("serializes concurrent edits with expectedUpdatedAt including membership-only changes", async () => {
    const member = await service.create(admin, siteId, input());
    const body = { name: member.name, loginId: member.loginId, accessLevel: "read", status: "active", expectedUpdatedAt: member.updatedAt.toISOString() };
    const results = await Promise.allSettled([service.update(admin, siteId, member.id, body), service.update(admin, siteId, member.id, body)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { response: { code: "SITE_USER_CHANGED" } } });
  });

  it.each(["disable", "reset", "delete"] as const)("%s waits for in-flight login and removes or revokes its new session", async (operation) => {
    const member = await service.create(admin, siteId, input());
    let release!: () => void;
    let entered!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const loginPasswords = new PasswordService();
    jest.spyOn(loginPasswords, "verify").mockImplementationOnce(async () => { entered(); await resume; return true; });
    const auth = new AuthService(competitor, loginPasswords, new AuditService(competitor));
    const login = auth.login({ loginId: member.loginId, password: "Temporary-123", rememberMe: false });
    await locked;
    const pending = operation === "reset"
      ? service.resetPassword(admin, siteId, member.id, { temporaryPassword: "Replacement-123" })
      : operation === "delete" ? service.remove(admin, siteId, member.id, { confirmationLoginId: member.loginId })
      : service.update(admin, siteId, member.id, { name: member.name, loginId: member.loginId, accessLevel: "read", status: "disabled", expectedUpdatedAt: member.updatedAt.toISOString() });
    try {
      // A real blocked User lock proves overlap; no arbitrary timing assumption.
      for (let attempt = 0; attempt < 200; attempt++) {
        const blocked = await competitor.$queryRaw<{ count: bigint }[]>(Prisma.sql`
          SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%User%FOR UPDATE%'
        `);
        if (Number(blocked[0].count) > 0) break;
        if (attempt === 199) throw new Error("User mutation never waited for login lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally { release(); }
    const signedIn = await login;
    await pending;
    await expect(auth.getUserBySessionToken(signedIn.sessionToken)).rejects.toMatchObject({ status: 401 });
    expect(await prisma.session.count({ where: { userId: member.id, revokedAt: null } })).toBe(0);
    if (operation === "reset") {
      expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).mustChangePassword).toBe(true);
      await expect(auth.login({ loginId: member.loginId, password: "Temporary-123", rememberMe: false })).rejects.toMatchObject({ status: 401 });
    }
  }, 15_000);

  it("permanently deletes account PII and requester payloads while retaining publishable command history", async () => {
    const member = await service.create(admin, siteId, input());
    const gateway = await prisma.gateway.create({ data: { siteId, name: "gateway", serialNumber: randomUUID(), firmwareVersion: "1" } });
    const command = await prisma.command.create({ data: { siteId, requestedBy: member.id, clientRequestId: randomUUID(), requestFingerprint: "fingerprint", targetType: "fixture", brightness: 70 } });
    const override = await prisma.manualOverride.create({ data: {
      siteId, gatewayId: gateway.id, commandId: command.id, requestedById: member.id,
      brightnessPercent: 70, startedAt: new Date(), overrideUntil: new Date(Date.now() + 3600_000)
    } });
    const dispatch = await prisma.commandDispatch.create({ data: {
      commandId: command.id, gatewayId: gateway.id, idempotencyKey: randomUUID(), sequence: 1
    } });
    const requestedAt = new Date();
    const fixtureId = randomUUID();
    const outbox = await prisma.mqttOutbox.create({ data: {
      dispatchId: dispatch.id,
      topic: `sites/${siteId}/gateways/${gateway.id}/commands/dimming`,
      payload: {
        commandId: command.id,
        dispatchId: dispatch.id,
        idempotencyKey: dispatch.idempotencyKey,
        sequence: 1,
        siteId,
        gatewayId: gateway.id,
        targetType: "fixture",
        targetId: fixtureId,
        targetFixtureIds: [fixtureId],
        deliveryMode: "unicast",
        brightness: 70,
        requestedBy: member.id,
        requestedAt: requestedAt.toISOString(),
        overrideUntil: override.overrideUntil.toISOString()
      }
    } });
    const unrelatedInvitation = await prisma.invitation.create({ data: {
      organizationId: admin.organizationId,
      siteId,
      email: `unrelated.${randomUUID()}@example.com`,
      role: "viewer",
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      expiresAt: new Date(Date.now() + 3600_000),
      acceptedAt: new Date()
    } });
    await prisma.session.create({ data: { userId: member.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) } });
    await audit.record({ actorId: member.id, targetType: "User", targetId: member.id, siteId, action: "auth.password_changed", outcome: "success", metadata: { loginId: member.loginId }, ipAddress: "127.0.0.1" });
    expect(await service.remove(admin, siteId, member.id, { confirmationLoginId: member.loginId })).toEqual({ ok: true });
    expect(await prisma.user.findUnique({ where: { id: member.id } })).toBeNull();
    expect(await prisma.siteMembership.count({ where: { userId: member.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: member.id } })).toBe(0);
    expect((await prisma.command.findUniqueOrThrow({ where: { id: command.id } })).requestedBy).toBeNull();
    expect(await prisma.manualOverride.findUniqueOrThrow({ where: { id: override.id } })).toMatchObject({ requestedById: null, commandId: command.id, endedAt: null });
    const scrubbedOutbox = await prisma.mqttOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(scrubbedOutbox).toMatchObject({ dispatchId: dispatch.id, publishedAt: null, deadLetteredAt: null });
    expect(scrubbedOutbox.payload).not.toHaveProperty("requestedBy");
    expect(gatewayDimmingCommandDraftV2Schema.parse(scrubbedOutbox.payload)).toEqual(scrubbedOutbox.payload);

    const publishNow = new Date(requestedAt.getTime() + 1_000);
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const publisher = new OutboxPublisherService(prisma, mqtt as never, {
      workerId: `site-user-delete-${randomUUID()}`,
      clock: () => publishNow,
      deliveryGeneration: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    const claimed = await publisher.claimBatch(publishNow);
    expect(claimed.map((row) => row.id)).toContain(outbox.id);
    await publisher.publishClaimed(claimed.find((row) => row.id === outbox.id)!);
    const publishedOutbox = await prisma.mqttOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    expect(publishedOutbox.publishedAt).toEqual(publishNow);
    expect(gatewayDimmingCommandPublishedV2Schema.parse(publishedOutbox.payload)).not.toHaveProperty("requestedBy");
    expect(mqtt.publishTopic).toHaveBeenCalledWith(
      outbox.topic,
      expect.not.objectContaining({ requestedBy: member.id }),
      expect.any(Object)
    );
    expect(await prisma.invitation.findUnique({ where: { id: unrelatedInvitation.id } })).not.toBeNull();
    const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { siteId } }));
    for (const value of [member.id, member.name, member.loginId, "Temporary-123"]) expect(audits).not.toContain(value);
    expect((await service.list(admin, siteId)).count).toBe(0);
  });

  it("deletes only the accepted invitation PII that created the signup user", async () => {
    const token = randomUUID();
    const normalizedEmail = `deleted.${randomUUID()}@example.com`;
    const accepted = await prisma.invitation.create({ data: {
      organizationId: admin.organizationId,
      siteId,
      email: `  ${normalizedEmail.toUpperCase()}  `,
      role: "viewer",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3600_000)
    } });
    const signup = await new AuthService(prisma, passwords, audit).signup({
      token,
      loginId: `invited_${randomUUID()}`,
      email: normalizedEmail,
      name: "초대 삭제 대상",
      password: "Invitation-123"
    });
    const otherSite = await prisma.site.create({ data: {
      organizationId: admin.organizationId,
      name: "다른 초대 현장"
    } });
    const otherOrg = await prisma.organization.create({ data: { name: "다른 초대 고객사", type: "customer" } });
    const preserved = await Promise.all([
      prisma.invitation.create({ data: {
        organizationId: admin.organizationId, siteId, email: normalizedEmail, role: "viewer",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAt: new Date(Date.now() + 3600_000)
      } }),
      prisma.invitation.create({ data: {
        organizationId: admin.organizationId, siteId: otherSite.id, email: normalizedEmail, role: "viewer",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAt: new Date(Date.now() + 3600_000), acceptedAt: new Date()
      } }),
      prisma.invitation.create({ data: {
        organizationId: otherOrg.id, siteId, email: normalizedEmail, role: "viewer",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAt: new Date(Date.now() + 3600_000), acceptedAt: new Date()
      } }),
      prisma.invitation.create({ data: {
        organizationId: admin.organizationId, siteId, email: `other.${normalizedEmail}`, role: "viewer",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        expiresAt: new Date(Date.now() + 3600_000), acceptedAt: new Date()
      } })
    ]);

    await expect(service.remove(admin, siteId, signup.user.id, {
      confirmationLoginId: signup.user.loginId
    })).resolves.toEqual({ ok: true });

    expect(await prisma.user.findUnique({ where: { id: signup.user.id } })).toBeNull();
    expect(await prisma.invitation.findUnique({ where: { id: accepted.id } })).toBeNull();
    expect((await prisma.invitation.findMany({
      where: { id: { in: preserved.map((invitation) => invitation.id) } },
      select: { id: true }
    })).map((invitation) => invitation.id).sort()).toEqual(preserved.map((invitation) => invitation.id).sort());
  });

  it("cannot mutate an admin, a viewer in another site, or another organization's viewer", async () => {
    const member = await service.create(admin, siteId, input());
    const otherSite = await prisma.site.create({ data: { organizationId: admin.organizationId, name: "다른 현장" } });
    await prisma.siteMembership.updateMany({ where: { userId: member.id }, data: { siteId: otherSite.id } });
    for (const target of [admin.id, member.id]) {
      await expect(service.remove(admin, siteId, target, { confirmationLoginId: member.loginId })).rejects.toMatchObject({ response: { code: "SITE_USER_NOT_FOUND" } });
    }
    const foreignOrg = await prisma.organization.create({ data: { name: "다른 고객사", type: "customer" } });
    await prisma.user.update({ where: { id: member.id }, data: { organizationId: foreignOrg.id } });
    await prisma.siteMembership.updateMany({ where: { userId: member.id }, data: { siteId } });
    await expect(service.remove(admin, siteId, member.id, { confirmationLoginId: member.loginId })).rejects.toMatchObject({ response: { code: "SITE_USER_NOT_FOUND" } });
    expect(await prisma.user.count({ where: { id: { in: [admin.id, member.id] } } })).toBe(2);
  });

  it("rolls back permanent deletion and audit anonymization when the final audit fails", async () => {
    const member = await service.create(admin, siteId, input());
    const email = `rollback.${randomUUID()}@example.com`;
    await prisma.user.update({ where: { id: member.id }, data: { email } });
    const invitation = await prisma.invitation.create({ data: {
      organizationId: admin.organizationId,
      siteId,
      email,
      role: "viewer",
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      expiresAt: new Date(Date.now() + 3600_000),
      acceptedAt: new Date()
    } });
    const gateway = await prisma.gateway.create({ data: {
      siteId, name: "rollback gateway", serialNumber: randomUUID(), firmwareVersion: "1"
    } });
    const command = await prisma.command.create({ data: {
      siteId, requestedBy: member.id, clientRequestId: randomUUID(),
      requestFingerprint: "rollback-fingerprint", targetType: "fixture", brightness: 70
    } });
    const dispatch = await prisma.commandDispatch.create({ data: {
      commandId: command.id, gatewayId: gateway.id, idempotencyKey: randomUUID(), sequence: 1
    } });
    const outbox = await prisma.mqttOutbox.create({ data: {
      dispatchId: dispatch.id,
      topic: `sites/${siteId}/gateways/${gateway.id}/commands/dimming`,
      payload: { commandId: command.id, requestedBy: member.id }
    } });
    await prisma.session.create({ data: { userId: member.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) } });
    jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(service.remove(admin, siteId, member.id, { confirmationLoginId: member.loginId })).rejects.toMatchObject({ status: 500 });
    expect(await prisma.user.findUnique({ where: { id: member.id } })).not.toBeNull();
    expect(await prisma.session.count({ where: { userId: member.id } })).toBe(1);
    expect(await prisma.siteMembership.count({ where: { userId: member.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { targetId: member.id, action: "site_user.created" } })).toBe(1);
    expect(await prisma.invitation.findUnique({ where: { id: invitation.id } })).toMatchObject({ email });
    expect((await prisma.mqttOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).payload)
      .toMatchObject({ requestedBy: member.id });
    expect((await prisma.command.findUniqueOrThrow({ where: { id: command.id } })).requestedBy).toBe(member.id);
  });

  it("serves the full HTTP CRUD flow with real session/admin guards and safe JSON responses", async () => {
    const module = await Test.createTestingModule({ imports: [SiteUsersModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    const app = module.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const cookie = async (userId: string) => {
      const token = randomUUID();
      await prisma.session.create({ data: { userId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600_000) } });
      return `led_session=${token}`;
    };
    const request = (method: string, path: string, session?: string, body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(session ? { Cookie: session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    try {
      const path = `/sites/${siteId}/users`;
      const adminCookie = await cookie(admin.id);
      const body = input();
      const created = await request("POST", path, adminCookie, body);
      expect(created.status).toBe(201);
      const member = await created.json() as SiteUserJson;
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: member.id } });
      expectNoPasswordSecrets(member, [body.temporaryPassword, stored.passwordHash!]);
      const memberCookie = await cookie(member.id);
      const endpoints = [["GET", ""], ["POST", ""], ["PATCH", `/${member.id}`], ["POST", `/${member.id}/reset-password`], ["DELETE", `/${member.id}`]];
      for (const [method, suffix] of endpoints) {
        expect((await request(method, path + suffix)).status).toBe(401);
        const denied = await request(method, path + suffix, memberCookie, method === "GET" ? undefined : {});
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
      }
      const beforeChange = await request("GET", "/auth/me", memberCookie);
      expect(beforeChange.status).toBe(200);
      expect(await beforeChange.json()).toMatchObject({ user: { mustChangePassword: true } });
      const changed = await request("POST", "/auth/change-password", memberCookie, {
        currentPassword: body.temporaryPassword, newPassword: "Personal-password-123", newPasswordConfirmation: "Personal-password-123"
      });
      expect(changed.status).toBe(201);
      const changedBody = await changed.json();
      expect(changedBody).toMatchObject({ ok: true, user: { id: member.id, mustChangePassword: false } });
      expectNoPasswordSecrets(changedBody, [body.temporaryPassword, "Personal-password-123", stored.passwordHash!]);
      // Updating the password also updates User.updatedAt; use the current version
      // for the later optimistic-lock edit rather than the creation response.
      member.updatedAt = (await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).updatedAt.toISOString();
      for (const [method, suffix] of endpoints) {
        const denied = await request(method, path + suffix, memberCookie, method === "GET" ? undefined : {});
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ code: "SITE_CAPABILITY_DENIED" });
      }
      const provider = await prisma.organization.create({ data: { name: "운영사", type: "service_provider" } });
      const operator = await prisma.user.create({ data: { organizationId: provider.id, loginId: `operator_${randomUUID()}`, name: "운영자", role: "operator", passwordHash: "unused" } });
      const deniedOperator = await request("GET", path, await cookie(operator.id));
      expect(deniedOperator.status).toBe(403);
      expect(await deniedOperator.json()).toMatchObject({ code: "SITE_CAPABILITY_DENIED" });
      expect((await request("GET", `/sites/${randomUUID()}/users`, adminCookie)).status).toBe(404);
      expect((await request("POST", path, adminCookie, body)).status).toBe(409);
      const malformed = await request("POST", path, adminCookie, { ...body, temporaryPassword: { nested: "secret" } });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain("secret");
      const listed = await request("GET", path, adminCookie);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ count: 1, limit: 100 });
      const patched = await request("PATCH", `${path}/${member.id}`, adminCookie, {
        name: "수정 이름", loginId: member.loginId, accessLevel: "read", status: "disabled", expectedUpdatedAt: member.updatedAt
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({ name: "수정 이름", status: "disabled", accessLevel: "read" });
      expect((await request("GET", path, memberCookie)).status).toBe(401);
      const reset = await request("POST", `${path}/${member.id}/reset-password`, adminCookie, { temporaryPassword: "New-password-123" });
      expect(reset.status).toBe(201);
      expect(await reset.json()).toEqual({ ok: true });
      const deleted = await request("DELETE", `${path}/${member.id}`, adminCookie, { confirmationLoginId: member.loginId });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
    } finally { await app.close(); }
  }, 15_000);
});

interface SiteUserJson { id: string; loginId: string; updatedAt: string }

function expectNoPasswordSecrets(value: unknown, secrets: string[]) {
  if (typeof value === "string") {
    for (const secret of secrets) expect(value).not.toContain(secret);
    expect(value).not.toMatch(/^scrypt\$/);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      expect(["password", "passwordhash", "temporarypassword", "currentpassword", "newpassword"]).not.toContain(key.toLowerCase());
      expectNoPasswordSecrets(child, secrets);
    }
  }
}
