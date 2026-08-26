import type { Dashboard } from "../api/queries";
import type { RegistrationSession } from "../api/registration";

export const mockUser = {
  id: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  email: "operator@example.com",
  name: "Demo Operator",
  role: "admin",
  status: "active"
};

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
          health: {
            faultCodes: status === "fault" ? [1] : [],
            observedAt: "2026-07-01T00:00:00.000Z"
          },
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
        health: { faultCodes: [], observedAt: "2026-07-01T00:00:00.000Z" },
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
  scanStatus: "scanning",
  scanCorrelationId: "44444444-4444-4444-8444-444444444444",
  scanAttempt: 1,
  scanStartedAt: "2026-07-01T00:00:00.000Z",
  scanCompletedAt: null,
  scanFailureCode: null,
  scanFailureMessage: null,
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
