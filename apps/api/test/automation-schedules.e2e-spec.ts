import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { AutomationModule } from "../src/automation/automation.module";
import { SessionAuthGuard } from "../src/auth/session-auth.guard";
import type { AuthenticatedUser } from "../src/auth/auth.types";
import { PrismaService } from "../src/prisma/prisma.service";

const databaseUrl = process.env.AUTOMATION_SCHEDULES_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("automation schedules PostgreSQL E2E", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  const actors = new Map<string, AuthenticatedUser>();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const authGuard: CanActivate = {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: AuthenticatedUser }>();
        const actor = actors.get(req.headers["x-test-actor"]);
        if (!actor) return false;
        req.user = actor;
        return true;
      }
    };
    const module = await Test.createTestingModule({ imports: [AutomationModule] })
      .overrideGuard(SessionAuthGuard)
      .useValue(authGuard)
      .compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("enforces read/mutation tenant roles and rechecks overlap when enabling", async () => {
    const scenario = await createScenario(prisma, actors);
    const enabled = scheduleBody(scenario.fixtureIds, { name: "Enabled schedule" });
    expect((await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", enabled)).status).toBe(201);

    const viewerList = await api("GET", `/sites/${scenario.siteId}/automation/schedules`, "viewer");
    expect(viewerList.status).toBe(200);
    expect((viewerList.body as { items: unknown[] }).items).toHaveLength(1);
    expect((await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "viewer", enabled)).status).toBe(403);
    expect((await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "operator", enabled)).status).toBe(404);
    expect((await api("GET", `/sites/${scenario.siteId}/automation/schedules`, "foreign-admin")).status).toBe(404);

    const disabled = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      scenario.fixtureIds,
      { name: "Disabled overlap", status: "disabled" }
    ));
    expect(disabled.status).toBe(201);
    const enable = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/schedules/${(disabled.body as { id: string }).id}`,
      "admin",
      { status: "enabled" }
    );
    expect(enable.status).toBe(409);
    expect(enable.body).toMatchObject({ code: "schedule_overlap" });
  });

  it("serializes concurrent overlapping creates under the Site row lock", async () => {
    const scenario = await createScenario(prisma, actors);
    const [first, second] = await Promise.all([
      api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
        scenario.fixtureIds,
        { name: "Concurrent A" }
      )),
      api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
        scenario.fixtureIds,
        { name: "Concurrent B" }
      ))
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect([first.body, second.body]).toContainEqual(expect.objectContaining({ code: "schedule_overlap" }));
    expect(await prisma.lightingSchedule.count({ where: { siteId: scenario.siteId } })).toBe(1);
    expect(await prisma.mqttOutbox.count({ where: { gatewayId: scenario.gatewayId } })).toBe(1);
  });

  it("serializes concurrent enable and update overlap checks under the Site row lock", async () => {
    const enableScenario = await createScenario(prisma, actors);
    const disabledA = await api("POST", `/sites/${enableScenario.siteId}/automation/schedules`, "admin", scheduleBody(
      enableScenario.fixtureIds,
      { name: "Enable A", status: "disabled" }
    ));
    const disabledB = await api("POST", `/sites/${enableScenario.siteId}/automation/schedules`, "admin", scheduleBody(
      enableScenario.fixtureIds,
      { name: "Enable B", status: "disabled" }
    ));
    const enabled = await Promise.all([
      api("PATCH", `/sites/${enableScenario.siteId}/automation/schedules/${(disabledA.body as { id: string }).id}`, "admin", {
        status: "enabled"
      }),
      api("PATCH", `/sites/${enableScenario.siteId}/automation/schedules/${(disabledB.body as { id: string }).id}`, "admin", {
        status: "enabled"
      })
    ]);
    expect(enabled.map((result) => result.status).sort()).toEqual([200, 409]);

    const updateScenario = await createScenario(prisma, actors);
    const morning = await api("POST", `/sites/${updateScenario.siteId}/automation/schedules`, "admin", scheduleBody(
      updateScenario.fixtureIds,
      { name: "Update A", localStartTime: "08:00", localEndTime: "09:00" }
    ));
    const evening = await api("POST", `/sites/${updateScenario.siteId}/automation/schedules`, "admin", scheduleBody(
      updateScenario.fixtureIds,
      { name: "Update B", localStartTime: "18:00", localEndTime: "19:00" }
    ));
    const updated = await Promise.all([
      api("PATCH", `/sites/${updateScenario.siteId}/automation/schedules/${(morning.body as { id: string }).id}`, "admin", {
        localStartTime: "12:00",
        localEndTime: "13:00"
      }),
      api("PATCH", `/sites/${updateScenario.siteId}/automation/schedules/${(evening.body as { id: string }).id}`, "admin", {
        localStartTime: "12:30",
        localEndTime: "13:30"
      })
    ]);
    expect(updated.map((result) => result.status).sort()).toEqual([200, 409]);
  });

  it("writes exact targets, normalized action, revisions and a full snapshot outbox atomically", async () => {
    const scenario = await createScenario(prisma, actors);
    const created = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      scenario.fixtureIds,
      { action: { dimmingEnabled: false, brightnessPercent: 7 } }
    ));

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      action: { dimmingEnabled: false, brightnessPercent: 100 },
      desiredRevision: 1,
      appliedRevision: 0,
      syncStatus: "PENDING"
    });
    expect((created.body as { targets: Array<{ fixtureId: string }> }).targets.map((item) => item.fixtureId).sort())
      .toEqual([...scenario.fixtureIds].sort());

    const configuration = await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({
      where: { gatewayId: scenario.gatewayId }
    });
    const outbox = await prisma.mqttOutbox.findFirstOrThrow({ where: { gatewayId: scenario.gatewayId } });
    expect(configuration).toMatchObject({ desiredRevision: 1, appliedRevision: 0, syncStatus: "PENDING" });
    expect(outbox).toMatchObject({ gatewayId: scenario.gatewayId, revision: 1, payloadHash: configuration.payloadHash });
    expect(outbox.payload).toMatchObject({
      schemaVersion: 1,
      siteId: scenario.siteId,
      gatewayId: scenario.gatewayId,
      revision: 1,
      schedules: [expect.objectContaining({
        id: (created.body as { id: string }).id,
        action: { dimmingEnabled: false, brightnessPercent: 100 },
        fixtureIds: [...scenario.fixtureIds].sort()
      })]
    });

    const scheduleId = (created.body as { id: string }).id;
    await prisma.automationExecution.create({ data: {
      siteId: scenario.siteId,
      gatewayId: scenario.gatewayId,
      eventId: randomUUID(),
      sequence: 1,
      revision: 1,
      ruleId: scheduleId,
      lightingScheduleId: scheduleId,
      occurrenceKey: `${scheduleId}:2026-09-01`,
      kind: "schedule_started",
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
      payload: { result: "started" }
    } });
    const listed = await api("GET", `/sites/${scenario.siteId}/automation/schedules`, "viewer");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      items: [expect.objectContaining({
        id: scheduleId,
        nextOccurrence: expect.objectContaining({ startsAt: expect.any(String), endsAt: expect.any(String) }),
        lastExecution: expect.objectContaining({ kind: "schedule_started", sequence: "1" })
      })]
    });

    const updated = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/schedules/${scheduleId}`,
      "admin",
      { name: "Updated full snapshot" }
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ desiredRevision: 2, syncStatus: "PENDING" });
    expect(await prisma.mqttOutbox.count({ where: { gatewayId: scenario.gatewayId } })).toBe(2);

    const removed = await api(
      "DELETE",
      `/sites/${scenario.siteId}/automation/schedules/${scheduleId}`,
      "admin"
    );
    expect(removed.status).toBe(200);
    expect(await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: scenario.gatewayId } }))
      .toMatchObject({ desiredRevision: 3, syncStatus: "PENDING" });
    expect(await prisma.mqttOutbox.count({ where: { gatewayId: scenario.gatewayId } })).toBe(3);
  });

  it("moves a schedule between gateways with removal and addition snapshots in one transaction", async () => {
    const scenario = await createScenario(prisma, actors);
    const created = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      [scenario.fixtureIds[0]],
      { name: "Movable schedule" }
    ));
    expect(created.status).toBe(201);
    const appliedAt = new Date();
    await prisma.gatewayAutomationConfiguration.update({
      where: { gatewayId: scenario.gatewayId },
      data: { appliedRevision: 1, syncStatus: "APPLIED", lastAppliedAt: appliedAt }
    });
    await prisma.lightingSchedule.update({
      where: { id: (created.body as { id: string }).id },
      data: { appliedRevision: 1 }
    });
    await prisma.mqttOutbox.updateMany({
      where: { gatewayId: scenario.gatewayId, revision: 1 },
      data: { publishedAt: appliedAt }
    });

    const floor = await prisma.fixture.findUniqueOrThrow({
      where: { id: scenario.fixtureIds[0] },
      select: { floorId: true }
    });
    const secondGateway = await prisma.gateway.create({ data: {
      siteId: scenario.siteId,
      name: "Second gateway",
      serialNumber: `SCHEDULE-MOVE-${randomUUID()}`,
      firmwareVersion: "test"
    } });
    const meshNode = await prisma.meshNode.create({ data: {
      gatewayId: secondGateway.id,
      meshAddress: "0200",
      firmwareVersion: "test"
    } });
    const targetFixture = await prisma.fixture.create({ data: {
      floorId: floor.floorId,
      meshNodeId: meshNode.id,
      name: "Moved target",
      ratedWatt: 20,
      x: 80,
      y: 0,
      status: "online"
    } });

    const moved = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/schedules/${(created.body as { id: string }).id}`,
      "admin",
      { target: { type: "fixture", fixtureId: targetFixture.id } }
    );
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      gatewayId: secondGateway.id,
      desiredRevision: 1,
      appliedRevision: 0,
      targets: [{ fixtureId: targetFixture.id }]
    });
    const oldPayload = (await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 2 }
    })).payload;
    const newPayload = (await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: secondGateway.id, revision: 1 }
    })).payload;
    expect(oldPayload).toMatchObject({ schedules: [] });
    expect(newPayload).toMatchObject({
      schedules: [expect.objectContaining({ fixtureIds: [targetFixture.id] })]
    });
  });

  it("rejects a partial update whose merged active range is invalid without advancing revision", async () => {
    const scenario = await createScenario(prisma, actors);
    const created = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      scenario.fixtureIds,
      { name: "Range validation" }
    ));
    expect(created.status).toBe(201);

    const invalid = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/schedules/${(created.body as { id: string }).id}`,
      "admin",
      { activeFrom: "2026-10-01T00:00:00.000Z" }
    );
    expect(invalid.status).toBe(400);
    expect(await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: scenario.gatewayId } }))
      .toMatchObject({ desiredRevision: 1 });
    expect(await prisma.mqttOutbox.count({ where: { gatewayId: scenario.gatewayId } })).toBe(1);
  });

  async function api(method: string, path: string, actor: string, body?: unknown) {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(url, {
        method,
        headers: {
          "x-test-actor": actor,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
        }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
});

async function createScenario(prisma: PrismaService, actors: Map<string, AuthenticatedUser>) {
  const suffix = randomUUID().slice(0, 8);
  const customer = await prisma.organization.create({ data: { name: `Schedule customer ${suffix}`, type: "customer" } });
  const serviceProvider = await prisma.organization.findFirst({ where: { type: "service_provider" } })
    ?? await prisma.organization.create({ data: { name: "Schedule test operator", type: "service_provider" } });
  const admin = await prisma.user.create({ data: {
    organizationId: customer.id,
    loginId: `schedule_admin_${suffix}`,
    email: `schedule-admin-${suffix}@example.com`,
    name: "Schedule admin",
    passwordHash: "not-used",
    role: "admin"
  } });
  const viewer = await prisma.user.create({ data: {
    organizationId: customer.id,
    loginId: `schedule_viewer_${suffix}`,
    email: `schedule-viewer-${suffix}@example.com`,
    name: "Schedule viewer",
    passwordHash: "not-used",
    role: "viewer"
  } });
  const operator = await prisma.user.findFirst({ where: { role: "operator" } })
    ?? await prisma.user.create({ data: {
      organizationId: serviceProvider.id,
      loginId: "schedule_test_operator",
      email: "schedule-test-operator@example.com",
      name: "Schedule operator",
      passwordHash: "not-used",
      role: "operator"
    } });
  const foreignAdmin = await prisma.user.create({ data: {
    organizationId: customer.id,
    loginId: `schedule_foreign_${suffix}`,
    email: `schedule-foreign-${suffix}@example.com`,
    name: "Foreign admin",
    passwordHash: "not-used",
    role: "admin"
  } });
  const site = await prisma.site.create({ data: {
    organizationId: customer.id,
    adminUserId: admin.id,
    name: `Schedule site ${suffix}`,
    timeZone: "Asia/Seoul"
  } });
  await prisma.siteMembership.create({ data: { siteId: site.id, userId: viewer.id } });
  const floor = await prisma.floor.create({ data: { siteId: site.id, name: "B1", level: -1 } });
  const gateway = await prisma.gateway.create({ data: {
    siteId: site.id,
    name: "Gateway",
    serialNumber: `SCHEDULE-${suffix}`,
    firmwareVersion: "test"
  } });
  const fixtureIds: string[] = [];
  for (const [index, meshAddress] of ["0100", "0101"].entries()) {
    const meshNode = await prisma.meshNode.create({ data: {
      gatewayId: gateway.id,
      meshAddress,
      firmwareVersion: "test"
    } });
    const fixture = await prisma.fixture.create({ data: {
      floorId: floor.id,
      meshNodeId: meshNode.id,
      name: `Fixture ${index + 1}`,
      ratedWatt: 20,
      x: index * 20,
      y: 0,
      status: "online"
    } });
    fixtureIds.push(fixture.id);
  }

  actors.set("admin", actor(admin, customer.id, "customer"));
  actors.set("viewer", actor(viewer, customer.id, "customer"));
  actors.set("operator", actor(operator, operator.organizationId, "service_provider"));
  actors.set("foreign-admin", actor(foreignAdmin, customer.id, "customer"));
  return { siteId: site.id, gatewayId: gateway.id, fixtureIds };
}

function actor(
  user: { id: string; loginId: string; name: string; role: "operator" | "admin" | "viewer"; status: "active" | "disabled" },
  organizationId: string,
  organizationType: "service_provider" | "customer"
): AuthenticatedUser {
  return { ...user, organizationId, organizationType };
}

function scheduleBody(fixtureIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    name: "Daily schedule",
    status: "enabled",
    activeFrom: "2026-09-01T00:00:00.000Z",
    activeUntil: "2026-09-30T00:00:00.000Z",
    localStartTime: "09:00",
    localEndTime: "10:00",
    recurrence: {
      kind: "daily",
      weeklyDays: [],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null
    },
    action: { dimmingEnabled: true, brightnessPercent: 70 },
    target: { type: "fixtures", fixtureIds },
    ...overrides
  };
}
