import type { Dashboard } from "./queries";

export const mockUser = {
  id: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  email: "operator@example.com",
  name: "Demo Operator",
  role: "admin",
  status: "active"
};

let isMockAuthenticated = false;

export const mockDashboard: Dashboard = {
  site: { id: "00000000-0000-4000-8000-000000000003", name: "Demo Underground Parking" },
  summary: {
    totalFixtures: 12,
    onlineFixtures: 10,
    faultFixtures: 1,
    averageBrightness: 62
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
          lastSeenAt: "2026-07-01T00:00:00.000Z"
        };
      })
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
  ]
};

export const mockEnergyEstimate = {
  day: { kwh: 21.4, cost: 3424 },
  month: { kwh: 642, cost: 102720 },
  year: { kwh: 7811, cost: 1249760 }
};

export async function mockGet<T>(path: string): Promise<T> {
  if (path === "/auth/me") {
    if (isMockAuthenticated) return { user: mockUser } as T;
    throw new Error("Mock session is not authenticated");
  }
  if (path === "/sites/default/dashboard") return mockDashboard as T;
  if (path === "/energy/default/estimate") return mockEnergyEstimate as T;
  throw new Error(`No mock response for GET ${path}`);
}

export async function mockPost<T>(path?: string): Promise<T> {
  if (path === "/auth/login" || path === "/auth/signup") {
    isMockAuthenticated = true;
    return { user: mockUser } as T;
  }
  if (path === "/auth/logout") {
    isMockAuthenticated = false;
    return { ok: true } as T;
  }
  return { status: "accepted" } as T;
}
