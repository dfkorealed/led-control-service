import type { Dashboard } from "./queries";
import type { RegistrationSession } from "./registration";
import type { InitialSiteSetupRequest } from "./setup";

export const mockUser = {
  id: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  email: "operator@example.com",
  name: "Demo Operator",
  role: "admin",
  status: "active"
};

let isMockAuthenticated = false;
const demoPassword = "demo-password-1234";

export const mockDashboard: Dashboard = {
  site: { id: "00000000-0000-4000-8000-000000000003", name: "Demo Underground Parking" },
  summary: {
    totalFixtures: 16,
    onlineFixtures: 14,
    faultFixtures: 1,
    averageBrightness: 61
  },
  floors: [
    {
      id: "00000000-0000-4000-8000-000000000005",
      name: "B2",
      level: -2,
      floorPlan: { imageUrl: "/demo/floor-b2.svg", width: 1200, height: 800, version: 1 },
      fixtures: Array.from({ length: 12 }, (_, index) => {
        const brightness = [70, 65, 40, 80, 55, 0, 75, 60, 90, 45, 50, 30][index];
        const status = index === 5 ? "offline" : index === 10 ? "fault" : "online";
        return {
          id: `00000000-0000-4000-8000-${(2001 + index).toString().padStart(12, "0")}`,
          name: `B2-L${String(index + 1).padStart(2, "0")}`,
          x: 120 + (index % 4) * 220,
          y: 140 + Math.floor(index / 4) * 180,
          ratedWatt: 40,
          brightness,
          status,
          rssi: status === "offline" ? null : -58 - index,
          hopCount: status === "offline" ? null : 1 + (index % 3),
          commandSuccessRate: status === "fault" ? 0.72 : status === "offline" ? null : 0.98,
          lastSeenAt: "2026-07-01T00:00:00.000Z",
          gateway: {
            id: "00000000-0000-4000-8000-000000000004",
            name: "Gateway B2",
            connectionStatus: "online" as const
          },
          controllable: status === "online",
          controlBlockReason: status === "fault" ? "fixture_fault" as const : status === "offline" ? "fixture_offline" as const : null
        };
      })
    },
    {
      id: "00000000-0000-4000-8000-000000000015",
      name: "B1",
      level: -1,
      floorPlan: { imageUrl: "/demo/floor-b2.svg", width: 1200, height: 800, version: 1 },
      fixtures: Array.from({ length: 4 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${(3001 + index).toString().padStart(12, "0")}`,
        name: `B1-L${String(index + 1).padStart(2, "0")}`,
        x: 180 + index * 210,
        y: 220,
        ratedWatt: 40,
        brightness: 50 + index * 5,
        status: "online" as const,
        rssi: -55 - index,
        hopCount: 1,
        commandSuccessRate: 0.99,
        lastSeenAt: "2026-07-01T00:00:00.000Z",
        gateway: {
          id: "00000000-0000-4000-8000-000000000004",
          name: "Gateway B2",
          connectionStatus: "online" as const
        },
        controllable: true,
        controlBlockReason: null
      }))
    }
  ],
  groups: [
    {
      id: "00000000-0000-4000-8000-000000000006",
      name: "B2 Entrance Zone",
      fixtureIds: [
        "00000000-0000-4000-8000-000000002001",
        "00000000-0000-4000-8000-000000002002",
        "00000000-0000-4000-8000-000000002003",
        "00000000-0000-4000-8000-000000002004"
      ]
    }
  ],
  gateways: [
    {
      id: "00000000-0000-4000-8000-000000000004",
      name: "Gateway B2",
      serialNumber: "GW-DEMO-001",
      firmwareVersion: "mock-1.0.0",
      lastHeartbeatAt: new Date().toISOString(),
      connectionStatus: "online"
    }
  ]
};

export const mockEnergyEstimate = {
  day: { kwh: 21.4, cost: 3424 },
  month: { kwh: 642, cost: 102720 },
  year: { kwh: 7811, cost: 1249760 }
};

export const mockRegistrationSession: RegistrationSession = {
  id: "11111111-1111-4111-8111-111111111111",
  siteId: mockDashboard.site.id,
  floorId: mockDashboard.floors[0].id,
  gatewayId: "00000000-0000-4000-8000-000000000004",
  requestedBy: mockUser.id,
  status: "active",
  startedAt: "2026-07-01T00:00:00.000Z",
  completedAt: null,
  discoveredNodes: Array.from({ length: 4 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${(index + 1).toString().padStart(12, "0")}`,
    sessionId: "11111111-1111-4111-8111-111111111111",
    deviceUuid: `esp32h2-b2-${String(index + 1).padStart(3, "0")}`,
    serialNumber: `LC-B2-${String(index + 1).padStart(3, "0")}`,
    rssi: -54 - index * 3,
    oobCapability: "static-oob",
    firmwareVersion: "mock-node-0.1.0",
    status: "discovered" as const,
    identifyState: "idle",
    meshAddress: null,
    errorMessage: null,
    discoveredAt: "2026-07-01T00:00:01.000Z"
  }))
};

let mockDashboardState: Dashboard = mockDashboard;
let mockRegistrationSessionState: RegistrationSession = mockRegistrationSession;
let mockCommandStatusState: Record<string, unknown> | null = null;

export function resetMockApiState() {
  isMockAuthenticated = false;
  mockDashboardState = mockDashboard;
  mockRegistrationSessionState = mockRegistrationSession;
  mockCommandStatusState = null;
}

export async function mockGet<T>(path: string): Promise<T> {
  if (path === "/auth/me") {
    if (isMockAuthenticated) return { user: mockUser } as T;
    throw new Error("Mock session is not authenticated");
  }
  if (path === "/sites/default/dashboard") return mockDashboardState as T;
  if (path === "/energy/default/estimate") return mockEnergyEstimate as T;
  if (path === `/registration-sessions/${mockRegistrationSessionState.id}`) return mockRegistrationSessionState as T;
  if (mockCommandStatusState && path === `/commands/${mockCommandStatusState.id}`) return mockCommandStatusState as T;
  throw new Error(`No mock response for GET ${path}`);
}

export async function mockPost<T>(path?: string, body?: unknown): Promise<T> {
  if (path === "/auth/login") {
    const input = body as { email?: string; password?: string } | undefined;
    if (input?.email !== mockUser.email || input.password !== demoPassword) {
      throw new Error("Invalid mock credentials");
    }
    isMockAuthenticated = true;
    return { user: mockUser } as T;
  }
  if (path === "/auth/signup") {
    const input = body as { token?: string; email?: string; name?: string; password?: string } | undefined;
    if (input?.token !== "demo-invite-token" || !input.email || !input.name || input.password !== demoPassword) {
      throw new Error("Invalid mock invitation");
    }
    isMockAuthenticated = true;
    return { user: mockUser } as T;
  }
  if (path === "/auth/logout") {
    isMockAuthenticated = false;
    return { ok: true } as T;
  }
  if (path === "/registration-sessions") {
    const input = body as { siteId?: string; floorId?: string } | undefined;
    mockRegistrationSessionState = buildRegistrationSession(input?.siteId, input?.floorId);
    return mockRegistrationSessionState as T;
  }
  if (path === "/setup/initial-site") {
    mockDashboardState = buildInitialSiteDashboard(body as InitialSiteSetupRequest);
    mockRegistrationSessionState = buildRegistrationSession(
      mockDashboardState.site.id,
      mockDashboardState.floors[0]?.id
    );
    return mockDashboardState as T;
  }
  if (path === "/commands/dimming") {
    const input = body as { targetId?: string; brightness?: number } | undefined;
    const fixture = mockDashboardState.floors.flatMap((floor) => floor.fixtures).find((item) => item.id === input?.targetId);
    const commandId = "mock-command-latest";
    mockCommandStatusState = {
      id: commandId,
      stage: "completed",
      dispatchCount: 1,
      completedFixtureCount: 1,
      totalFixtureCount: 1,
      errorMessage: null,
      dispatches: [
        {
          id: "mock-dispatch-latest",
          status: "completed",
          gateway: { id: mockDashboardState.gateways[0]?.id ?? "mock-gateway", name: mockDashboardState.gateways[0]?.name ?? "Mock Gateway" },
          errorMessage: null,
          results: [
            {
              fixtureId: fixture?.id ?? input?.targetId ?? "mock-fixture",
              fixtureName: fixture?.name ?? "Mock Fixture",
              status: "succeeded",
              brightness: input?.brightness ?? 0,
              errorMessage: null
            }
          ]
        }
      ]
    };
    return { id: commandId, dispatchCount: 1 } as T;
  }
  if (path?.endsWith("/identify")) {
    return { ...mockRegistrationSessionState.discoveredNodes[0], status: "identifying", identifyState: "blinking" } as T;
  }
  if (path?.endsWith("/register")) {
    return {
      fixture: { id: "fixture-new-1", name: "B2-L13" },
      discoveredNode: { ...mockRegistrationSessionState.discoveredNodes[0], status: "provisioned" }
    } as T;
  }
  if (path?.endsWith("/complete")) return { ...mockRegistrationSessionState, status: "completed" } as T;
  return { status: "accepted" } as T;
}

function buildInitialSiteDashboard(input: InitialSiteSetupRequest): Dashboard {
  const siteId = "mock-site-initial";
  const gateway = {
    id: "mock-gateway-initial",
    name: input.gateway.name,
    serialNumber: input.gateway.serialNumber,
    firmwareVersion: "manual-unknown",
    lastHeartbeatAt: null,
    connectionStatus: "offline" as const
  };

  return {
    site: { id: siteId, name: input.siteName },
    summary: {
      totalFixtures: 0,
      onlineFixtures: 0,
      faultFixtures: 0,
      averageBrightness: 0
    },
    floors: input.floors.map((floor, index) => ({
      id: `mock-floor-${index + 1}`,
      name: floor.name,
      level: floor.level,
      floorPlan: floor.floorPlan ? { ...floor.floorPlan, version: 1 } : null,
      fixtures: []
    })),
    groups: [],
    gateways: [gateway]
  };
}

function buildRegistrationSession(siteId?: string, floorId?: string): RegistrationSession {
  const selectedSiteId = siteId || mockDashboardState.site.id;
  const selectedFloorId = floorId || mockDashboardState.floors[0]?.id || "";
  const selectedGatewayId = mockDashboardState.gateways[0]?.id || "";

  return {
    ...mockRegistrationSession,
    siteId: selectedSiteId,
    floorId: selectedFloorId,
    gatewayId: selectedGatewayId,
    discoveredNodes: mockRegistrationSession.discoveredNodes.map((node) => ({
      ...node,
      sessionId: mockRegistrationSession.id
    }))
  };
}
