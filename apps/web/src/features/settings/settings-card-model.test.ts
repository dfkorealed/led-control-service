import { describe, expect, it } from "vitest";
import { mockDashboard } from "../../test/fixtures";
import { buildSettingsCards } from "./settings-card-model";

const manager = { read: true, control: true, manage: true, commission: true };

describe("buildSettingsCards", () => {
  it("exposes five real destinations using capabilities rather than account role", () => {
    const cards = buildSettingsCards({ dashboard: mockDashboard, capabilities: manager, userCount: 7 });
    expect(cards.map(({ id, path }) => [id, path])).toEqual([
      ["site", "/settings/site"], ["users", "/settings/users"],
      ["registration", "/settings/registration"], ["floor-plans", "/settings/floor-plans"],
      ["security", "/settings/security"]
    ]);
    expect(cards.find(card => card.id === "users")?.summary).toBe("사용자 7명");
    expect(cards.find(card => card.id === "security")?.summary).toBe("비밀번호 · 2단계 인증 · 세션");
    expect(buildSettingsCards({ dashboard: mockDashboard, capabilities: { ...manager, manage: false }, userCount: null }).map(card => card.id)).toEqual(["floor-plans", "security"]);
    expect(buildSettingsCards({ dashboard: mockDashboard, capabilities: { read: false, control: false, manage: false, commission: false }, userCount: null })).toEqual([]);
  });

  it.each([[null, "사용자 수 확인 중"], [0, "사용자 0명"]])("does not turn unknown user count %s into zero", (userCount, summary) => {
    expect(buildSettingsCards({ dashboard: mockDashboard, capabilities: manager, userCount }).find(card => card.id === "users")?.summary).toBe(summary);
  });

  it("uses server mapConfigured, keeping reset and unknown maps distinct", () => {
    const dashboard = structuredClone(mockDashboard);
    const floor = dashboard.floors[0];
    dashboard.floors = [
      { ...floor, id: "ready", floorPlan: null, mapConfigured: true },
      { ...floor, id: "reset", mapConfigured: false },
      { ...floor, id: "unknown", mapConfigured: undefined }
    ];
    expect(buildSettingsCards({ dashboard, capabilities: manager, userCount: 0 }).find(card => card.id === "floor-plans")?.summary).toBe("3개 층 · 맵 설정 1개 · 상태 확인 중 1개");
    dashboard.floors = [{ ...floor, mapConfigured: false }];
    expect(buildSettingsCards({ dashboard, capabilities: manager, userCount: 0 }).find(card => card.id === "floor-plans")?.summary).toBe("1개 층 · 맵 설정 0개");
    dashboard.floors = [];
    expect(buildSettingsCards({ dashboard, capabilities: manager, userCount: 0 }).find(card => card.id === "floor-plans")?.summary).toBe("0개 층 · 맵 설정 0개");
  });

  it("uses server fixture totals instead of the loaded fixture page", () => {
    const dashboard = { ...mockDashboard, gateways: [], summary: { ...mockDashboard.summary, totalFixtures: 1000 } };
    expect(buildSettingsCards({ dashboard, capabilities: manager, userCount: null }).find(card => card.id === "registration")?.summary).toBe("등록 조명 1,000개 · Gateway 미등록");
  });

  it.each([ ["online", "정상"], ["offline", "오프라인"] ] as const)("preserves the first real Gateway identity and %s status", (connectionStatus, label) => {
    const dashboard = { ...mockDashboard, summary: { ...mockDashboard.summary, totalFixtures: 7 }, gateways: [
      { ...mockDashboard.gateways[0], name: "설정 게이트웨이", serialNumber: "GW-SETTINGS-001", connectionStatus },
      { ...mockDashboard.gateways[0], id: "second", name: "다른 게이트웨이", serialNumber: "GW-OTHER-002" }
    ] };
    const cards = buildSettingsCards({ dashboard, capabilities: manager, userCount: null });
    expect(cards).toHaveLength(5);
    expect(cards.find(card => card.id === "registration")?.summary).toBe(`등록 조명 7개 · Gateway 설정 게이트웨이 · 시리얼 GW-SETTINGS-001 · ${label}`);
  });

  it("does not truncate long actual Gateway identity in the summary", () => {
    const name = "지하주차장현장관리게이트웨이".repeat(8);
    const serialNumber = "GW-LONG-SERIAL-".repeat(8);
    const dashboard = { ...mockDashboard, gateways: [{ ...mockDashboard.gateways[0], name, serialNumber, connectionStatus: "offline" as const }] };
    const summary = buildSettingsCards({ dashboard, capabilities: manager, userCount: null }).find(card => card.id === "registration")?.summary;
    expect(summary).toContain(name);
    expect(summary).toContain(serialNumber);
    expect(summary).toContain("오프라인");
  });
});
