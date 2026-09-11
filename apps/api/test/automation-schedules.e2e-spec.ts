import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import { SiteAccessService } from "../src/access/site-access.service";
import { AutomationClock } from "../src/automation/automation-clock";
import { AutomationModule } from "../src/automation/automation.module";
import { SchedulesService } from "../src/automation/schedules.service";
import { SessionAuthGuard } from "../src/auth/session-auth.guard";
import type { AuthenticatedUser } from "../src/auth/auth.types";
import { PrismaService } from "../src/prisma/prisma.service";

const databaseUrl = process.env.AUTOMATION_SCHEDULES_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const FIXED_NOW = new Date("2026-08-31T23:00:00.000Z");

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
      .overrideProvider(AutomationClock)
      .useValue({ now: () => new Date(FIXED_NOW) })
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
    const payload = outbox.payload as Record<string, unknown>;
    const { payloadHash, ...payloadWithoutHash } = payload;
    expect(payloadHash).toBe(`sha256:${createHash("sha256")
      .update(independentCanonicalJson(payloadWithoutHash))
      .digest("hex")}`);
    await expect(prisma.mqttOutbox.create({ data: {
      gatewayId: scenario.gatewayId,
      revision: outbox.revision,
      payloadHash: outbox.payloadHash,
      topic: outbox.topic,
      payload: outbox.payload as Prisma.InputJsonValue
    } })).rejects.toMatchObject({ code: "P2002" });

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
        nextOccurrence: {
          key: `${scheduleId}:2026-09-01`,
          localDate: "2026-09-01",
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-09-01T01:00:00.000Z"
        },
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

  it("rejects equal local times on create and after merging a PATCH", async () => {
    const scenario = await createScenario(prisma, actors);
    const equalCreate = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      scenario.fixtureIds,
      { localEndTime: "09:00" }
    ));
    expect(equalCreate.status).toBe(400);

    const created = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      scenario.fixtureIds,
      { name: "Merged local time" }
    ));
    const equalPatch = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/schedules/${(created.body as { id: string }).id}`,
      "admin",
      { localEndTime: "09:00" }
    );
    expect(equalPatch.status).toBe(400);
    expect(await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: scenario.gatewayId } }))
      .toMatchObject({ desiredRevision: 1 });
  });

  it("reauthorizes a stale assigned admin after the automation lock barrier", async () => {
    const scenario = await createScenario(prisma, actors);
    const lockClient = new PrismaClient({ datasourceUrl: databaseUrl });
    const siteAccess = app.get(SiteAccessService);
    const originalAssert = siteAccess.assert.bind(siteAccess);
    let signalOuterCheck!: () => void;
    const outerCheck = new Promise<void>((resolve) => { signalOuterCheck = resolve; });
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => { signalLockHeld = resolve; });
    const assertSpy = jest.spyOn(siteAccess, "assert").mockImplementation(async (...args) => {
      const result = await originalAssert(...args);
      if (args[1] === scenario.siteId && args[2] === "manage") signalOuterCheck();
      return result;
    });
    const blocker = lockClient.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
      signalLockHeld();
      await holdLock;
    });

    try {
      await lockHeld;
      const mutation = api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
        scenario.fixtureIds,
        { name: "Stale admin" }
      ));
      await outerCheck;
      const site = await prisma.site.findUniqueOrThrow({
        where: { id: scenario.siteId },
        select: { organizationId: true }
      });
      const replacement = await prisma.user.create({ data: {
        organizationId: site.organizationId,
        loginId: `replacement_${randomUUID()}`,
        email: `replacement-${randomUUID()}@example.com`,
        name: "Replacement admin",
        passwordHash: "not-used",
        role: "admin"
      } });
      await prisma.site.update({
        where: { id: scenario.siteId },
        data: { adminUserId: replacement.id }
      });
      releaseLock();

      expect((await mutation).status).toBe(404);
      expect(await prisma.lightingSchedule.count({ where: { siteId: scenario.siteId } })).toBe(0);
    } finally {
      releaseLock();
      await blocker;
      assertSpy.mockRestore();
      await lockClient.$disconnect();
    }
  });

  it("does not deadlock a same-site API create against a direct parent transaction", async () => {
    const scenario = await createScenario(prisma, actors);
    const directClient = new PrismaClient({ datasourceUrl: databaseUrl });
    const siteAccess = app.get(SiteAccessService);
    const originalAssert = siteAccess.assertManageInTransaction.bind(siteAccess);
    let signalSiteLocked!: () => void;
    const siteLocked = new Promise<void>((resolve) => { signalSiteLocked = resolve; });
    let releaseApi!: () => void;
    const holdApi = new Promise<void>((resolve) => { releaseApi = resolve; });
    let armed = true;
    const assertSpy = jest.spyOn(siteAccess, "assertManageInTransaction").mockImplementation(async (...args) => {
      const result = await originalAssert(...args);
      if (armed && args[2] === scenario.siteId) {
        armed = false;
        signalSiteLocked();
        await holdApi;
      }
      return result;
    });

    try {
      const apiCreate = api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
        [scenario.fixtureIds[0]],
        { name: "API lock order", localStartTime: "11:00", localEndTime: "12:00" }
      ));
      await siteLocked;
      const directScheduleId = randomUUID();
      const directCreate = directClient.$transaction(async (tx) => {
        await tx.lightingSchedule.create({ data: directScheduleData(
          directScheduleId,
          scenario,
          { name: "Direct parent", status: "disabled" }
        ) });
        await tx.lightingScheduleFixture.create({ data: {
          scheduleId: directScheduleId,
          fixtureId: scenario.fixtureIds[0],
          siteId: scenario.siteId,
          gatewayId: scenario.gatewayId
        } });
      });
      await sleep(150);
      releaseApi();

      const [apiResult] = await withTimeout(Promise.all([apiCreate, directCreate]), 5_000);
      expect(apiResult.status).toBe(201);
      expect(await prisma.lightingSchedule.count({ where: { siteId: scenario.siteId } })).toBe(2);
    } finally {
      releaseApi();
      assertSpy.mockRestore();
      await directClient.$disconnect();
    }
  });

  it("resolves floor and group snapshots and rejects empty, unregistered, and mixed-gateway targets", async () => {
    const scenario = await createScenario(prisma, actors);
    const group = await prisma.fixtureGroup.create({ data: {
      siteId: scenario.siteId,
      floorId: scenario.floorId,
      gatewayId: scenario.gatewayId,
      name: "Schedule group",
      groupFixtures: { create: [{ fixtureId: scenario.fixtureIds[1] }] }
    } });

    const floorSchedule = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      scenario.fixtureIds,
      { name: "Floor snapshot", status: "disabled", target: { type: "floor", floorId: scenario.floorId } }
    ));
    expect(floorSchedule.status).toBe(201);
    expect((floorSchedule.body as { targets: Array<{ fixtureId: string }> }).targets)
      .toEqual(scenario.fixtureIds.slice().sort().map((fixtureId) => ({ fixtureId })));

    const groupSchedule = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      scenario.fixtureIds,
      { name: "Group snapshot", status: "disabled", target: { type: "group", groupId: group.id } }
    ));
    expect(groupSchedule.status).toBe(201);
    expect((groupSchedule.body as { targets: Array<{ fixtureId: string }> }).targets)
      .toEqual([{ fixtureId: scenario.fixtureIds[1] }]);

    const emptyFloor = await prisma.floor.create({ data: {
      siteId: scenario.siteId,
      name: "Empty floor",
      level: 2
    } });
    const unregistered = await prisma.fixture.create({ data: {
      floorId: scenario.floorId,
      name: "Unregistered",
      ratedWatt: 20,
      x: 90,
      y: 0,
      status: "online"
    } });
    const secondGateway = await prisma.gateway.create({ data: {
      siteId: scenario.siteId,
      name: "Second gateway",
      serialNumber: `SCHEDULE-MATRIX-${randomUUID()}`,
      firmwareVersion: "test"
    } });
    const secondNode = await prisma.meshNode.create({ data: {
      gatewayId: secondGateway.id,
      meshAddress: "0300",
      firmwareVersion: "test"
    } });
    const secondGatewayFixture = await prisma.fixture.create({ data: {
      floorId: scenario.floorId,
      meshNodeId: secondNode.id,
      name: "Other gateway fixture",
      ratedWatt: 20,
      x: 100,
      y: 0,
      status: "online"
    } });

    const rejected = await Promise.all([
      api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody([], {
        name: "Empty floor",
        status: "disabled",
        target: { type: "floor", floorId: emptyFloor.id }
      })),
      api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody([unregistered.id], {
        name: "Unregistered",
        status: "disabled"
      })),
      api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody([
        scenario.fixtureIds[0], secondGatewayFixture.id
      ], { name: "Mixed gateway", status: "disabled" }))
    ]);
    expect(rejected.map((result) => result.status).sort()).toEqual([400, 400, 409]);
  });

  it("allows touching enabled boundaries and normalizes false dimming on PATCH", async () => {
    const scenario = await createScenario(prisma, actors);
    const first = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      [scenario.fixtureIds[0]],
      { name: "First boundary", localStartTime: "09:00", localEndTime: "10:00" }
    ));
    const second = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
      [scenario.fixtureIds[0]],
      { name: "Second boundary", localStartTime: "10:00", localEndTime: "11:00" }
    ));
    expect([first.status, second.status]).toEqual([201, 201]);

    const patched = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/schedules/${(second.body as { id: string }).id}`,
      "admin",
      { action: { dimmingEnabled: false, brightnessPercent: 3 } }
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ action: { dimmingEnabled: false, brightnessPercent: 100 } });
    expect(await prisma.lightingSchedule.findUniqueOrThrow({
      where: { id: (second.body as { id: string }).id },
      select: { dimmingEnabled: true, brightnessPercent: true }
    })).toEqual({ dimmingEnabled: false, brightnessPercent: 100 });
    const latestOutbox = await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId },
      orderBy: { revision: "desc" }
    });
    expect(latestOutbox.payload).toMatchObject({
      schedules: expect.arrayContaining([expect.objectContaining({
        id: (second.body as { id: string }).id,
        action: { dimmingEnabled: false, brightnessPercent: 100 }
      })])
    });
  });

  it("paginates schedules with a stable cursor, bounded limit, and full site total", async () => {
    const scenario = await createScenario(prisma, actors);
    const createdAt = new Date("2026-08-30T00:00:00.000Z");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
      for (let index = 0; index < 27; index += 1) {
        const id = randomUUID();
        await tx.lightingSchedule.create({ data: {
          ...directScheduleData(id, scenario, { name: `Page ${index}`, status: "disabled" }),
          createdAt: new Date(createdAt.getTime() + index * 1_000),
          updatedAt: new Date(createdAt.getTime() + index * 1_000)
        } });
        await tx.lightingScheduleFixture.create({ data: {
          scheduleId: id,
          fixtureId: scenario.fixtureIds[0],
          siteId: scenario.siteId,
          gatewayId: scenario.gatewayId
        } });
      }
    });
    const expected = await prisma.lightingSchedule.findMany({
      where: { siteId: scenario.siteId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: { id: true, createdAt: true }
    });

    const first = await api("GET", `/sites/${scenario.siteId}/automation/schedules?limit=10`, "viewer");
    expect(first.status).toBe(200);
    const firstCursor = (first.body as { nextCursor: string }).nextCursor;
    expect(first.body).toMatchObject({ total: 27, nextCursor: expect.any(String) });
    expect(decodeCursor(firstCursor)).toEqual({
      v: 1,
      siteId: scenario.siteId,
      createdAt: expected[9].createdAt.toISOString(),
      id: expected[9].id
    });
    const second = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/schedules?limit=10&cursor=${firstCursor}`,
      "viewer"
    );
    const third = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/schedules?limit=10&cursor=${(second.body as { nextCursor: string }).nextCursor}`,
      "viewer"
    );
    const ids = [first, second, third].flatMap((page) =>
      (page.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)
    );
    expect(ids).toEqual(expected.map(({ id }) => id));
    expect(third.body).toMatchObject({ total: 27, nextCursor: null });
    expect((await api("GET", `/sites/${scenario.siteId}/automation/schedules?limit=101`, "viewer")).status)
      .toBe(400);
  });

  it("keeps tied timestamps stable and continues after a deleted anchor", async () => {
    const scenario = await createScenario(prisma, actors);
    const tiedAt = new Date("2026-08-30T02:00:00.000Z");
    const ids = [21, 22, 23, 24, 25].map((suffix) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`);
    await insertDirectSchedules(prisma, scenario, ids.map((id, index) => ({
      id,
      name: `Tied ${index}`,
      createdAt: tiedAt
    })));

    const first = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/schedules?limit=2`,
      scenario.actorKeys.viewer
    );
    expect((first.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual(ids.slice(0, 2));
    const deletedAnchorCursor = (first.body as { nextCursor: string }).nextCursor;
    await prisma.lightingSchedule.delete({ where: { id: ids[1] } });

    const second = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/schedules?limit=2&cursor=${deletedAnchorCursor}`,
      scenario.actorKeys.viewer
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ total: 4, nextCursor: expect.any(String) });
    expect((second.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual(ids.slice(2, 4));
    const third = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/schedules?limit=2&cursor=${(second.body as { nextCursor: string }).nextCursor}`,
      scenario.actorKeys.viewer
    );
    expect(third.body).toMatchObject({ total: 4, nextCursor: null });
    expect((third.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual(ids.slice(4));
  });

  it("authorizes the requested Site before parsing malformed or foreign-site cursors", async () => {
    const firstSite = await createScenario(prisma, actors);
    await insertDirectSchedules(prisma, firstSite, [
      { id: randomUUID(), name: "Cursor A", createdAt: new Date("2026-08-30T03:00:00.000Z") },
      { id: randomUUID(), name: "Cursor B", createdAt: new Date("2026-08-30T02:00:00.000Z") }
    ]);
    const firstPage = await api(
      "GET",
      `/sites/${firstSite.siteId}/automation/schedules?limit=1`,
      firstSite.actorKeys.viewer
    );
    const foreignCursor = (firstPage.body as { nextCursor: string }).nextCursor;
    const secondSite = await createScenario(prisma, actors);

    expect((await api(
      "GET",
      `/sites/${secondSite.siteId}/automation/schedules?cursor=${foreignCursor}`,
      secondSite.actorKeys.viewer
    )).status).toBe(400);
    expect((await api(
      "GET",
      `/sites/${secondSite.siteId}/automation/schedules?cursor=malformed`,
      secondSite.actorKeys.viewer
    )).status).toBe(400);
    expect((await api(
      "GET",
      `/sites/${secondSite.siteId}/automation/schedules?limit=invalid`,
      secondSite.actorKeys.operator
    )).status).toBe(404);
    expect((await api(
      "GET",
      `/sites/${secondSite.siteId}/automation/schedules?limit=invalid`,
      secondSite.actorKeys.foreignAdmin
    )).status).toBe(404);
    expect((await api(
      "GET",
      `/sites/${secondSite.siteId}/automation/schedules?cursor=malformed`,
      firstSite.actorKeys.viewer
    )).status).toBe(404);
    expect((await api(
      "GET",
      `/sites/${randomUUID()}/automation/schedules?limit=invalid`,
      secondSite.actorKeys.admin
    )).status).toBe(404);
  });

  it("keeps total and page on one RepeatableRead snapshot during a concurrent insert", async () => {
    const scenario = await createScenario(prisma, actors);
    await insertDirectSchedules(prisma, scenario, [{
      id: randomUUID(),
      name: "Before insert",
      createdAt: new Date("2026-08-30T04:00:00.000Z")
    }]);
    const barrier = createCountBarrier();
    const service = createBarrierListService(prisma, barrier.waitAfterCount);
    const list = service.list(scenario.siteId, actors.get(scenario.actorKeys.viewer)!, { limit: "100" });
    await barrier.counted;
    await insertDirectSchedules(prisma, scenario, [{
      id: randomUUID(),
      name: "Concurrent insert",
      createdAt: new Date("2026-08-30T05:00:00.000Z")
    }]);
    barrier.release();

    await expect(list).resolves.toMatchObject({ total: 1, items: [expect.objectContaining({ name: "Before insert" })] });
  });

  it("keeps total and page on one RepeatableRead snapshot during a concurrent delete", async () => {
    const scenario = await createScenario(prisma, actors);
    const deletedId = randomUUID();
    await insertDirectSchedules(prisma, scenario, [
      { id: deletedId, name: "Concurrent delete", createdAt: new Date("2026-08-30T06:00:00.000Z") },
      { id: randomUUID(), name: "Retained", createdAt: new Date("2026-08-30T05:00:00.000Z") }
    ]);
    const barrier = createCountBarrier();
    const service = createBarrierListService(prisma, barrier.waitAfterCount);
    const list = service.list(scenario.siteId, actors.get(scenario.actorKeys.viewer)!, { limit: "100" });
    await barrier.counted;
    await prisma.lightingSchedule.delete({ where: { id: deletedId } });
    barrier.release();

    const result = await list;
    expect(result.total).toBe(2);
    expect(result.items.map(({ id }) => id)).toContain(deletedId);
    expect(result.items).toHaveLength(2);
  });

  it("rolls back parent, targets, revision, and outbox when snapshot persistence fails", async () => {
    const scenario = await createScenario(prisma, actors);
    const suffix = randomUUID().replaceAll("-", "");
    const triggerName = `schedule_outbox_failure_${suffix}`;
    const functionName = `raise_schedule_outbox_failure_${suffix}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."gatewayId" = '${scenario.gatewayId}' THEN
          RAISE EXCEPTION 'injected schedule outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "MqttOutbox"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);

    try {
      const failed = await api("POST", `/sites/${scenario.siteId}/automation/schedules`, "admin", scheduleBody(
        scenario.fixtureIds,
        { name: "Rollback injection" }
      ));
      expect(failed.status).toBe(500);
      expect(await prisma.lightingSchedule.count({ where: { siteId: scenario.siteId } })).toBe(0);
      expect(await prisma.lightingScheduleFixture.count({ where: { siteId: scenario.siteId } })).toBe(0);
      expect(await prisma.gatewayAutomationConfiguration.findUnique({ where: { gatewayId: scenario.gatewayId } }))
        .toBeNull();
      expect(await prisma.mqttOutbox.count({ where: { gatewayId: scenario.gatewayId } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "MqttOutbox";`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"();`);
    }
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

  const actorKeys = {
    admin: `admin-${suffix}`,
    viewer: `viewer-${suffix}`,
    operator: `operator-${suffix}`,
    foreignAdmin: `foreign-admin-${suffix}`
  };
  const scenarioActors = {
    admin: actor(admin, customer.id, "customer"),
    viewer: actor(viewer, customer.id, "customer"),
    operator: actor(operator, operator.organizationId, "service_provider"),
    foreignAdmin: actor(foreignAdmin, customer.id, "customer")
  };
  actors.set("admin", scenarioActors.admin);
  actors.set("viewer", scenarioActors.viewer);
  actors.set("operator", scenarioActors.operator);
  actors.set("foreign-admin", scenarioActors.foreignAdmin);
  actors.set(actorKeys.admin, scenarioActors.admin);
  actors.set(actorKeys.viewer, scenarioActors.viewer);
  actors.set(actorKeys.operator, scenarioActors.operator);
  actors.set(actorKeys.foreignAdmin, scenarioActors.foreignAdmin);
  return {
    siteId: site.id,
    gatewayId: gateway.id,
    floorId: floor.id,
    adminId: admin.id,
    fixtureIds,
    actorKeys
  };
}

async function insertDirectSchedules(
  prisma: PrismaService,
  scenario: {
    siteId: string;
    gatewayId: string;
    adminId: string;
    fixtureIds: string[];
  },
  schedules: Array<{ id: string; name: string; createdAt: Date }>
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
    for (const schedule of schedules) {
      await tx.lightingSchedule.create({ data: {
        ...directScheduleData(schedule.id, scenario, { name: schedule.name, status: "disabled" }),
        createdAt: schedule.createdAt,
        updatedAt: schedule.createdAt
      } });
      await tx.lightingScheduleFixture.create({ data: {
        scheduleId: schedule.id,
        fixtureId: scenario.fixtureIds[0],
        siteId: scenario.siteId,
        gatewayId: scenario.gatewayId
      } });
    }
  });
}

function createCountBarrier() {
  let signalCounted!: () => void;
  const counted = new Promise<void>((resolve) => { signalCounted = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    counted,
    release,
    waitAfterCount: async () => {
      signalCounted();
      await released;
    }
  };
}

function createBarrierListService(prisma: PrismaService, waitAfterCount: () => Promise<void>) {
  const adapter = {
    $transaction: (callback: (tx: unknown) => Promise<unknown>, options: unknown) =>
      prisma.$transaction(async (tx) => callback({
        site: tx.site,
        lightingSchedule: {
          count: async (args: Parameters<typeof tx.lightingSchedule.count>[0]) => {
            const total = await tx.lightingSchedule.count(args);
            await waitAfterCount();
            return total;
          },
          findMany: (args: Parameters<typeof tx.lightingSchedule.findMany>[0]) =>
            tx.lightingSchedule.findMany(args)
        }
      }), options as never)
  };
  return new SchedulesService(
    adapter as never,
    new SiteAccessService(adapter as never),
    {} as never,
    { now: () => new Date(FIXED_NOW) } as never,
    {} as never
  );
}

function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    v: number;
    siteId: string;
    createdAt: string;
    id: string;
  };
}

function directScheduleData(
  id: string,
  scenario: {
    siteId: string;
    gatewayId: string;
    adminId: string;
  },
  overrides: { name: string; status: "enabled" | "disabled" }
) {
  return {
    id,
    siteId: scenario.siteId,
    gatewayId: scenario.gatewayId,
    name: overrides.name,
    status: overrides.status,
    activeFrom: new Date("2026-09-01T00:00:00.000Z"),
    activeUntil: new Date("2026-09-30T00:00:00.000Z"),
    localStartTime: "13:00",
    localEndTime: "14:00",
    recurrenceKind: "daily" as const,
    weeklyDays: [],
    monthlyDay: null,
    yearlyMonth: null,
    yearlyDay: null,
    dimmingEnabled: true,
    brightnessPercent: 70,
    desiredRevision: 0,
    appliedRevision: 0,
    createdById: scenario.adminId,
    updatedById: scenario.adminId
  };
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function independentCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${independentCanonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function actor(
  user: { id: string; loginId: string; name: string; role: "operator" | "admin" | "viewer"; status: "active" | "disabled"; mustChangePassword: boolean },
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
