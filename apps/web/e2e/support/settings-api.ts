import type { Page } from "@playwright/test";
import {
  createDimmingCommandSchema,
  floorMapSnapshotSchema,
  type CreateDimmingCommandInput,
  type FloorMapSnapshot
} from "@led-control/shared";
import type { RegistrationScanRetryResult, RegistrationSession } from "../../src/api/registration";

export type SettingsRole = "operator" | "admin" | "viewer";

export interface SettingsFixture {
  id: string;
  name: string;
  x: number;
  y: number;
  size?: number;
  ratedWatt: number;
  brightness: number;
  status: "online" | "offline" | "fault";
  statusReason?: "reported";
  health: { faultCodes: number[]; observedAt: string } | null;
  rssi: number | null;
  hopCount: number | null;
  commandSuccessRate: number | null;
  lastSeenAt: string | null;
  gateway: { id: string; name: string; connectionStatus: "online" | "offline" } | null;
  controllable: boolean;
  controlBlockReason: null;
}

interface InstallSettingsApiOptions {
  fixtures?: SettingsFixture[];
  commandId?: string;
  mapObjects?: SettingsMapObject[];
  mapSnapshotFailuresBeforeSuccess?: number;
  registrationSession?: RegistrationSession;
  registrationRetrySession?: RegistrationScanRetryResult;
  registrationPollingSessions?: RegistrationSession[];
  ids?: Partial<SettingsApiIds>;
}

interface SettingsApiIds {
  siteId: string;
  floorId: string;
  gatewayId: string;
}

export type SettingsMapObject = FloorMapSnapshot["objects"][number];

export interface FixtureCommandResult {
  fixtureId: string;
  fixtureName: string;
  status: "pending" | "succeeded" | "failed" | "timed_out";
  errorMessage: string | null;
}

type FixtureCommandStage = "queued" | "published" | "accepted" | "completed" | "partial_failed" | "failed" | "timed_out";

interface SavePayload {
  expectedRevision: number;
  leaseToken?: string;
  leaseFence?: number;
  floorPlan?: unknown;
  fixtureUpdates: Array<{ id: string; x?: number; y?: number; size?: number; name?: string; ratedWatt?: number }>;
  objectCreates: unknown[];
  objectUpdates: unknown[];
  objectDeletes: string[];
}

type EditorRequest =
  | {
    sequence: number;
    type: "lease-acquire";
    payload: Record<string, unknown>;
    result: { editable: boolean; token?: string; fence?: number; holderName?: string; acquiredAt?: string };
  }
  | { sequence: number; type: "atomic-save"; payload: SavePayload }
  | { sequence: number; type: "lease-release"; payload: Record<string, unknown>; released: boolean };

export interface SettingsApiFixtureState {
  requests: string[];
  leaseRequests: Array<Record<string, unknown>>;
  editorRequests: EditorRequest[];
  atomicSavePayloads: SavePayload[];
  fixtureUpdates: SavePayload["fixtureUpdates"];
  logoutRequests: number;
  dashboardRequests: number;
  fixturePageRequests: number;
  mapSnapshotRequests: number;
  fixturePageCursors: Array<string | null>;
  dimmingRequests: CreateDimmingCommandInput[];
  commandStatusRequests: string[];
  registrationSessionRequests: number;
  registrationScanRetryRequests: number;
  updateFixture: (fixtureId: string, update: Pick<SettingsFixture, "status" | "brightness">) => void;
  setCommandStatus: (input: { stage: FixtureCommandStage; results: FixtureCommandResult[] }) => void;
}

const floor = {
  id: "floor-1",
  siteId: "site-1",
  name: "B2",
  level: -2,
  mapRevision: 7,
  floorPlan: {
    imageUrl: "/demo/floor-b2.svg",
    sourceType: "image",
    originalFileUrl: "/demo/floor-b2.svg",
    renderedImageUrl: "/demo/floor-b2.svg",
    width: 1200,
    height: 800,
    version: 1
  }
};

const defaultIds: SettingsApiIds = {
  siteId: floor.siteId,
  floorId: floor.id,
  gatewayId: "gateway-1"
};

const defaultFixtures: SettingsFixture[] = [{
  id: "fixture-1",
  name: "B2-L01",
  x: 120,
  y: 140,
  size: 20,
  ratedWatt: 40,
  brightness: 70,
  status: "online",
  statusReason: "reported",
  health: { faultCodes: [], observedAt: "2026-07-12T00:00:00.000Z" },
  rssi: -60,
  hopCount: 2,
  commandSuccessRate: 0.99,
  lastSeenAt: "2026-07-12T00:00:00.000Z",
  gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
  controllable: true,
  controlBlockReason: null
}];

/**
 * Browser-only API fixture for settings and monitoring/control contract E2E.
 * It deliberately exposes only the assigned site so an overly broad route mock
 * cannot hide tenant regressions. This fixture never represents real hardware.
 */
export async function installSettingsApiRoutes(
  page: Page,
  role: SettingsRole,
  {
    fixtures = defaultFixtures,
    commandId = "77777777-7777-4777-8777-777777777777",
    mapObjects = [],
    mapSnapshotFailuresBeforeSuccess = 0,
    registrationSession,
    registrationRetrySession,
    registrationPollingSessions = [],
    ids: idOverrides
  }: InstallSettingsApiOptions = {}
): Promise<SettingsApiFixtureState> {
  const ids = { ...defaultIds, ...idOverrides };
  const runtimeFloor = { ...floor, id: ids.floorId, siteId: ids.siteId };
  const fixtureState = structuredClone(fixtures);
  let commandStage: FixtureCommandStage = "accepted";
  let commandResults: FixtureCommandResult[] = [];
  let commandCreated = false;
  const initialRegistrationSession = registrationSession ? structuredClone(registrationSession) : null;
  const retriedRegistrationSession = registrationRetrySession ? structuredClone(registrationRetrySession) : null;
  const queuedRegistrationSessions = structuredClone(registrationPollingSessions);
  let currentRegistrationSession = initialRegistrationSession;
  let registrationRetryStarted = false;
  const state: SettingsApiFixtureState = {
    requests: [],
    leaseRequests: [],
    editorRequests: [],
    atomicSavePayloads: [],
    fixtureUpdates: [],
    logoutRequests: 0,
    dashboardRequests: 0,
    fixturePageRequests: 0,
    mapSnapshotRequests: 0,
    fixturePageCursors: [],
    dimmingRequests: [],
    commandStatusRequests: [],
    registrationSessionRequests: 0,
    registrationScanRetryRequests: 0,
    updateFixture: (fixtureId, update) => {
      const fixture = fixtureState.find((candidate) => candidate.id === fixtureId);
      if (!fixture) throw new Error(`fixture not found: ${fixtureId}`);
      if (!Number.isInteger(update.brightness) || update.brightness < 0 || update.brightness > 100) {
        throw new Error(`invalid fixture brightness: ${update.brightness}`);
      }
      if (!(["online", "offline", "fault"] as const).includes(update.status)) {
        throw new Error(`invalid fixture status: ${String(update.status)}`);
      }
      Object.assign(fixture, structuredClone(update));
    },
    setCommandStatus: (input) => {
      const expectedFixtureIds = commandResults.map((result) => result.fixtureId).sort();
      const receivedFixtureIds = input.results.map((result) => result.fixtureId).sort();
      if (expectedFixtureIds.length === 0 || expectedFixtureIds.join(",") !== receivedFixtureIds.join(",")) {
        throw new Error("command result fixtures must match the created command targets");
      }
      commandStage = input.stage;
      commandResults = structuredClone(input.results);
    }
  };
  let mapRevision = floor.mapRevision;
  let remainingMapSnapshotFailures = mapSnapshotFailuresBeforeSuccess;
  let activeLeaseToken: string | null = null;
  let activeLeaseFence = 0;
  let editorRequestSequence = 0;
  let issuedLeaseCount = 0;
  let loggedOut = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    state.requests.push(`${request.method()} ${path}`);

    if (path === "/auth/me") {
      if (loggedOut) return route.fulfill({ status: 401, json: { message: "unauthorized" } });
      return route.fulfill({ json: { user: currentUser(role) } });
    }
    if (path === "/auth/logout" && request.method() === "POST") {
      loggedOut = true;
      state.logoutRequests += 1;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/sites") {
      return route.fulfill({ json: [{ id: ids.siteId, name: "고객사 B2 현장" }] });
    }
    if (path === "/registration-sessions" && request.method() === "POST") {
      if (!initialRegistrationSession) return route.fulfill({ status: 404, json: { message: "registration fixture not configured" } });
      return route.fulfill({ json: structuredClone(initialRegistrationSession) });
    }
    if (path === `/registration-sessions/${initialRegistrationSession?.id}` && request.method() === "GET") {
      if (!currentRegistrationSession) return route.fulfill({ status: 404, json: { message: "registration fixture not configured" } });
      state.registrationSessionRequests += 1;
      if (registrationRetryStarted && queuedRegistrationSessions.length > 0) {
        currentRegistrationSession = queuedRegistrationSessions.shift() ?? currentRegistrationSession;
      }
      return route.fulfill({ json: structuredClone(currentRegistrationSession) });
    }
    if (path === `/registration-sessions/${initialRegistrationSession?.id}/scan/retry` && request.method() === "POST") {
      if (!retriedRegistrationSession) return route.fulfill({ status: 409, json: { message: "registration retry fixture not configured" } });
      state.registrationScanRetryRequests += 1;
      registrationRetryStarted = true;
      return route.fulfill({ json: structuredClone(retriedRegistrationSession) });
    }
    if (path === "/sites/default/dashboard" || path === `/sites/${ids.siteId}/dashboard`) {
      state.dashboardRequests += 1;
      return route.fulfill({
        json: dashboard(fixtureState, runtimeFloor, ids.gatewayId, url.searchParams.get("includeFixtures") === "true")
      });
    }
    if (path === `/sites/${ids.siteId}/floors/${ids.floorId}/fixtures`) {
      state.fixturePageRequests += 1;
      const cursor = url.searchParams.get("cursor");
      state.fixturePageCursors.push(cursor);
      return route.fulfill({ json: pagedFixtures(fixtureState, cursor) });
    }
    if (path === `/sites/${ids.siteId}/floors/${ids.floorId}/map-snapshot`) {
      state.mapSnapshotRequests += 1;
      if (remainingMapSnapshotFailures > 0) {
        remainingMapSnapshotFailures -= 1;
        return route.fulfill({ status: 503, json: { message: "map snapshot unavailable" } });
      }
      const snapshot = mapSnapshot(runtimeFloor, mapRevision, mapObjects);
      // Legacy settings specs retain short IDs; UUID-based contract specs use the same strict parser as the API.
      const response = idOverrides ? floorMapSnapshotSchema.parse(snapshot) : snapshot;
      return route.fulfill({ json: response });
    }
    if (path === "/commands/dimming" && request.method() === "POST") {
      const parsed = createDimmingCommandSchema.safeParse(request.postDataJSON());
      if (!parsed.success) {
        return route.fulfill({ status: 400, json: { message: "invalid dimming command request" } });
      }
      const payload = parsed.data;
      state.dimmingRequests.push(payload);
      const targetFixtureIds = fixtureIdsForTarget(payload, fixtureState, runtimeFloor.id);
      const deliveryMode = payload.target.type === "fixture"
        ? "unicast"
        : payload.target.type === "fixtures"
          ? "parallel_unicast"
          : "mesh_group";
      commandResults = targetFixtureIds.map((fixtureId) => {
        const fixture = fixtureState.find((candidate) => candidate.id === fixtureId);
        return {
          fixtureId,
          fixtureName: fixture?.name ?? fixtureId,
          status: "pending" as const,
          errorMessage: null
        };
      });
      commandStage = "accepted";
      commandCreated = true;
      return route.fulfill({
        json: {
          id: commandId,
          dispatchCount: 1,
          selectedTargetCount: targetFixtureIds.length,
          transmissionCount: deliveryMode === "parallel_unicast" ? targetFixtureIds.length : 1,
          deliveryMode,
          terminalStatusUrl: `/commands/${commandId}`
        }
      });
    }
    const commandStatusMatch = path.match(/^\/commands\/([^/]+)$/);
    if (commandStatusMatch && request.method() === "GET") {
      const requestedCommandId = decodeURIComponent(commandStatusMatch[1]);
      state.commandStatusRequests.push(requestedCommandId);
      if (!commandCreated || requestedCommandId !== commandId) {
        return route.fulfill({ status: 404, json: { message: "command not found" } });
      }
      return route.fulfill({ json: commandStatus(commandId, commandStage, commandResults, ids.gatewayId) });
    }
    if (path === `/floors/${ids.floorId}/editor-state`) {
      if (request.method() === "GET") return route.fulfill({ json: editorState(runtimeFloor, fixtureState, mapRevision) });
      if (request.method() === "PUT") {
        if (role === "viewer") return route.fulfill({ status: 403, json: { message: "insufficient role" } });
        const payload = request.postDataJSON() as SavePayload;
        if (!payload.leaseToken || payload.leaseToken !== activeLeaseToken || payload.leaseFence !== activeLeaseFence) {
          return route.fulfill({ status: 409, json: { message: "floor editor lease is no longer active" } });
        }
        if (payload.expectedRevision !== mapRevision) {
          return route.fulfill({ status: 409, json: { message: "floor editor revision conflict" } });
        }
        state.editorRequests.push({ sequence: ++editorRequestSequence, type: "atomic-save", payload });
        state.atomicSavePayloads.push(payload);
        state.fixtureUpdates.push(...payload.fixtureUpdates);
        applyFixtureUpdates(fixtureState, payload.fixtureUpdates);
        mapRevision += 1;
        return route.fulfill({ json: editorState(runtimeFloor, fixtureState, mapRevision) });
      }
    }
    if (path === `/floors/${ids.floorId}/editor-lease`) {
      if (role === "viewer") return route.fulfill({ status: 403, json: { message: "insufficient role" } });
      if (request.method() === "POST") {
        const payload = (request.postDataJSON() as Record<string, unknown> | null) ?? {};
        const requestedToken = typeof payload.token === "string" ? payload.token : null;
        const result = requestedToken
          ? requestedToken === activeLeaseToken
            ? editableLease(requestedToken, activeLeaseFence)
            : readOnlyLease(activeLeaseToken)
          : activeLeaseToken
            ? readOnlyLease(activeLeaseToken)
            : editableLease(`lease-token-${++issuedLeaseCount}`, ++activeLeaseFence);
        if (result.editable && result.token) {
          activeLeaseToken = result.token;
          activeLeaseFence = result.fence ?? activeLeaseFence;
        }
        state.leaseRequests.push(payload);
        state.editorRequests.push({ sequence: ++editorRequestSequence, type: "lease-acquire", payload, result });
        return route.fulfill({ json: result });
      }
      if (request.method() === "DELETE") {
        const payload = (request.postDataJSON() as Record<string, unknown> | null) ?? {};
        if (!activeLeaseToken) {
          state.editorRequests.push({ sequence: ++editorRequestSequence, type: "lease-release", payload, released: false });
          return route.fulfill({ json: { released: false } });
        }
        if (payload.token !== activeLeaseToken) {
          state.editorRequests.push({ sequence: ++editorRequestSequence, type: "lease-release", payload, released: false });
          return route.fulfill({ status: 403, json: { message: "floor editor lease is held by another user" } });
        }
        const released = true;
        state.editorRequests.push({ sequence: ++editorRequestSequence, type: "lease-release", payload, released });
        activeLeaseToken = null;
        activeLeaseFence += 1;
        return route.fulfill({ json: { released } });
      }
    }
    if (path === `/floors/${ids.floorId}/editor-revisions`) {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }

    return route.fulfill({ status: 404, json: { message: "site not found" } });
  });

  return state;
}

interface EditorLeaseResult {
  editable: boolean;
  token?: string;
  fence?: number;
  holderName?: string;
  acquiredAt?: string;
}

function editableLease(token: string, fence: number): EditorLeaseResult {
  return { editable: true, token, fence, holderName: "관리자", acquiredAt: "2026-07-12T00:00:00.000Z" };
}

function readOnlyLease(token: string | null): EditorLeaseResult {
  return token ? { editable: false, holderName: "관리자", acquiredAt: "2026-07-12T00:00:00.000Z" } : { editable: false };
}

function currentUser(role: SettingsRole) {
  return {
    id: `${role}-user-1`,
    organizationId: role === "operator" ? "service-provider-1" : "customer-org-1",
    organizationType: role === "operator" ? "service_provider" : "customer",
    email: `${role}@example.com`,
    name: role === "operator" ? "설치 담당자" : role === "admin" ? "고객 관리자" : "고객 조회자",
    role,
    status: "active"
  };
}

function dashboard(
  fixtures: SettingsFixture[],
  runtimeFloor: typeof floor,
  gatewayId: string,
  includeFixtures = false
) {
  return {
    site: { id: runtimeFloor.siteId, name: "고객사 B2 현장" },
    summary: {
      totalFixtures: fixtures.length,
      onlineFixtures: fixtures.filter((fixture) => fixture.status === "online").length,
      faultFixtures: fixtures.filter((fixture) => fixture.status === "fault").length,
      averageBrightness: fixtures.length
        ? Math.round(fixtures.reduce((total, fixture) => total + fixture.brightness, 0) / fixtures.length)
        : 0
    },
    floors: [{
      id: runtimeFloor.id,
      name: runtimeFloor.name,
      level: runtimeFloor.level,
      floorPlan: runtimeFloor.floorPlan,
      meshControlGroups: [],
      fixtures: includeFixtures ? fixtures : []
    }],
    groups: [],
    gateways: [{
      id: gatewayId,
      name: "Gateway B2",
      serialNumber: "GW-E2E-001",
      firmwareVersion: "e2e-1.0.0",
      lastHeartbeatAt: "2026-07-12T00:00:00.000Z",
      connectionStatus: "online"
    }]
  };
}

function mapSnapshot(runtimeFloor: typeof floor, revision: number, objects: SettingsMapObject[]) {
  const { version: _version, ...floorPlan } = runtimeFloor.floorPlan;
  return {
    floorId: runtimeFloor.id,
    revision,
    width: runtimeFloor.floorPlan.width,
    height: runtimeFloor.floorPlan.height,
    floorPlan,
    objects: objects.map((object) => ({
      ...object,
      points: object.points ?? null,
      text: object.text ?? null,
      fillColor: object.fillColor ?? null,
      fontSize: object.fontSize ?? null
    }))
  };
}

function commandStatus(id: string, stage: FixtureCommandStage, results: FixtureCommandResult[], gatewayId: string) {
  const completedFixtureCount = results.filter((result) => result.status !== "pending").length;
  return {
    id,
    stage,
    dispatchCount: 1,
    completedFixtureCount,
    totalFixtureCount: results.length,
    errorMessage: stage === "failed" ? "one or more fixtures failed" : null,
    dispatches: [{
      id: "dispatch-1",
      status: dispatchStatusForStage(stage),
      gateway: { id: gatewayId, name: "Gateway B2" },
      errorMessage: null,
      results
    }]
  };
}

function dispatchStatusForStage(stage: FixtureCommandStage) {
  if (stage === "queued") return "pending";
  if (stage === "partial_failed") return "failed";
  return stage;
}

function editorState(runtimeFloor: typeof floor, fixtures: SettingsFixture[], mapRevision: number) {
  return {
    floor: { ...runtimeFloor, mapRevision },
    fixtures,
    objects: []
  };
}

function fixtureIdsForTarget(
  payload: CreateDimmingCommandInput,
  fixtures: SettingsFixture[],
  floorId: string
) {
  if (payload.target.type === "fixture") return [payload.target.fixtureId];
  if (payload.target.type === "fixtures") return payload.target.fixtureIds;
  if (payload.target.type === "floor") return payload.target.floorId === floorId ? fixtures.map((fixture) => fixture.id) : [];
  return [];
}

function pagedFixtures(fixtures: SettingsFixture[], cursor: string | null) {
  const start = cursor ? fixtures.findIndex((fixture) => fixture.id === cursor) + 1 : 0;
  const items = fixtures.slice(start, start + 200);
  return { items, nextCursor: start + 200 < fixtures.length ? items.at(-1)?.id ?? null : null };
}

function applyFixtureUpdates(fixtures: SettingsFixture[], updates: SavePayload["fixtureUpdates"]) {
  for (const update of updates) {
    const fixture = fixtures.find((candidate) => candidate.id === update.id);
    if (fixture) Object.assign(fixture, update);
  }
}
