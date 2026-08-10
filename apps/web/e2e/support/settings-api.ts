import type { Page } from "@playwright/test";

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
}

interface SavePayload {
  expectedRevision: number;
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
    result: { editable: boolean; token?: string; holderName?: string; acquiredAt?: string };
  }
  | { sequence: number; type: "atomic-save"; payload: SavePayload }
  | { sequence: number; type: "lease-release"; payload: Record<string, unknown>; released: boolean };

export interface SettingsApiFixtureState {
  requests: string[];
  leaseRequests: Array<Record<string, unknown>>;
  editorRequests: EditorRequest[];
  atomicSavePayloads: SavePayload[];
  fixtureUpdates: SavePayload["fixtureUpdates"];
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
  rssi: -60,
  hopCount: 2,
  commandSuccessRate: 0.99,
  lastSeenAt: "2026-07-12T00:00:00.000Z",
  gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
  controllable: true,
  controlBlockReason: null
}];

/**
 * Browser-only API fixture for settings E2E. It deliberately exposes only the
 * assigned site so an overly broad route mock cannot hide tenant regressions.
 */
export async function installSettingsApiRoutes(
  page: Page,
  role: SettingsRole,
  { fixtures = defaultFixtures }: InstallSettingsApiOptions = {}
): Promise<SettingsApiFixtureState> {
  const state: SettingsApiFixtureState = {
    requests: [],
    leaseRequests: [],
    editorRequests: [],
    atomicSavePayloads: [],
    fixtureUpdates: []
  };
  const fixtureState = structuredClone(fixtures);
  let mapRevision = floor.mapRevision;
  let activeLeaseToken: string | null = null;
  let editorRequestSequence = 0;
  let issuedLeaseCount = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    state.requests.push(`${request.method()} ${path}`);

    if (path === "/auth/me") {
      return route.fulfill({ json: { user: currentUser(role) } });
    }
    if (path === "/sites") {
      return route.fulfill({ json: [{ id: "site-1", name: "고객사 B2 현장" }] });
    }
    if (path === "/sites/default/dashboard" || path === "/sites/site-1/dashboard") {
      return route.fulfill({ json: dashboard(fixtureState) });
    }
    if (path === "/sites/site-1/floors/floor-1/fixtures") {
      return route.fulfill({ json: pagedFixtures(fixtureState, url.searchParams.get("cursor")) });
    }
    if (path === "/floors/floor-1/editor-state") {
      if (request.method() === "GET") return route.fulfill({ json: editorState(fixtureState, mapRevision) });
      if (request.method() === "PUT") {
        if (role === "viewer") return route.fulfill({ status: 403, json: { message: "insufficient role" } });
        const payload = request.postDataJSON() as SavePayload;
        state.editorRequests.push({ sequence: ++editorRequestSequence, type: "atomic-save", payload });
        state.atomicSavePayloads.push(payload);
        state.fixtureUpdates.push(...payload.fixtureUpdates);
        applyFixtureUpdates(fixtureState, payload.fixtureUpdates);
        mapRevision += 1;
        return route.fulfill({ json: editorState(fixtureState, mapRevision) });
      }
    }
    if (path === "/floors/floor-1/editor-lease") {
      if (role === "viewer") return route.fulfill({ status: 403, json: { message: "insufficient role" } });
      if (request.method() === "POST") {
        const payload = (request.postDataJSON() as Record<string, unknown> | null) ?? {};
        const requestedToken = typeof payload.token === "string" ? payload.token : null;
        const result = requestedToken
          ? requestedToken === activeLeaseToken
            ? editableLease(requestedToken)
            : readOnlyLease(activeLeaseToken)
          : activeLeaseToken
            ? readOnlyLease(activeLeaseToken)
            : editableLease(`lease-token-${++issuedLeaseCount}`);
        if (result.editable && result.token) activeLeaseToken = result.token;
        state.leaseRequests.push(payload);
        state.editorRequests.push({ sequence: ++editorRequestSequence, type: "lease-acquire", payload, result });
        return route.fulfill({ json: result });
      }
      if (request.method() === "DELETE") {
        const payload = (request.postDataJSON() as Record<string, unknown> | null) ?? {};
        const released = payload.token === activeLeaseToken;
        state.editorRequests.push({ sequence: ++editorRequestSequence, type: "lease-release", payload, released });
        if (released) activeLeaseToken = null;
        return route.fulfill({ json: { released } });
      }
    }
    if (path === "/floors/floor-1/editor-revisions") {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }

    return route.fulfill({ status: 404, json: { message: "site not found" } });
  });

  return state;
}

function editableLease(token: string) {
  return { editable: true, token, holderName: "관리자", acquiredAt: "2026-07-12T00:00:00.000Z" };
}

function readOnlyLease(token: string | null) {
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

function dashboard(fixtures: SettingsFixture[]) {
  return {
    site: { id: "site-1", name: "고객사 B2 현장" },
    summary: {
      totalFixtures: fixtures.length,
      onlineFixtures: fixtures.filter((fixture) => fixture.status === "online").length,
      faultFixtures: fixtures.filter((fixture) => fixture.status === "fault").length,
      averageBrightness: fixtures.length
        ? Math.round(fixtures.reduce((total, fixture) => total + fixture.brightness, 0) / fixtures.length)
        : 0
    },
    floors: [{ id: floor.id, name: floor.name, level: floor.level, floorPlan: floor.floorPlan, fixtures: [] }],
    groups: [],
    gateways: [{
      id: "gateway-1",
      name: "Gateway B2",
      serialNumber: "GW-E2E-001",
      firmwareVersion: "e2e-1.0.0",
      lastHeartbeatAt: "2026-07-12T00:00:00.000Z",
      connectionStatus: "online"
    }]
  };
}

function editorState(fixtures: SettingsFixture[], mapRevision: number) {
  return {
    floor: { ...floor, mapRevision },
    fixtures,
    objects: []
  };
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
