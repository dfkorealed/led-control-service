import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDashboard } from "../../test/fixtures";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { SettingsShell } from "./SettingsShell";
import { SettingsView } from "./SettingsView";

const manageCapabilities = { read: true, control: true, manage: true, commission: true };

vi.mock("../../api/queries", () => ({
  useSites: () => ({ data: [
    { id: "site-1", name: "본사 주차장" },
    { id: "site-2", name: "지사 주차장" }
  ] }),
  useDashboard: () => ({ data: mockDashboard })
}));
vi.mock("../registration/RegistrationPanel", () => ({ RegistrationPanel: () => <section aria-label="조명 등록 패널">조명 등록 패널</section> }));
vi.mock("../setup/GatewayClaimPanel", () => ({ GatewayClaimPanel: () => null }));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function RoutedSettingsShell() {
  const location = useLocation();
  const selectedSiteId = new URLSearchParams(location.search).get("siteId") ?? undefined;
  return <SettingsShell capabilities={manageCapabilities} selectedSiteId={selectedSiteId} />;
}

describe("SettingsShell", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useFloorEditorStore.setState({ isDirty: false });
  });

  it("renders settings sections as top tabs with the routed content", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1#map"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} selectedSiteId="site-1" />}>
            <Route path="floor-plans" element={<h2>맵 관리</h2>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("button", { name: /현장 선택/ })).toHaveTextContent("본사 주차장");
    expect(screen.getByRole("heading", { name: "맵 관리" })).toBeInTheDocument();
    const tabs = screen.getByRole("navigation", { name: "설정 메뉴" });
    expect(within(tabs).getByRole("link", { name: "설정 개요" })).toHaveAttribute(
      "href",
      "/settings?siteId=site-1#map"
    );
    expect(within(tabs).getByRole("link", { name: "맵 관리" })).toHaveAttribute("aria-current", "page");
  });

  it("filters settings tabs with the current site capabilities", () => {
    const readCapabilities = { read: true, control: false, manage: false, commission: false };
    render(
      <MemoryRouter initialEntries={["/settings?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell capabilities={readCapabilities} selectedSiteId="site-1" />}>
            <Route index element={<h2>설정 개요</h2>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const tabs = screen.getByRole("navigation", { name: "설정 메뉴" });
    expect(within(tabs).getByRole("link", { name: "설정 개요" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "맵 관리" })).toBeInTheDocument();
    expect(within(tabs).getByRole("link", { name: "계정 보안" })).toBeInTheDocument();
    expect(within(tabs).queryByRole("link", { name: "유저 관리" })).not.toBeInTheDocument();
    expect(within(tabs).queryByRole("link", { name: "조명 등록" })).not.toBeInTheDocument();
  });

  it("설정 개요는 실제 데이터와 route action으로 네 카드를 표시한다", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/settings?siteId=site-1#fragment"]}>
          <Routes>
            <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} selectedSiteId="site-1" />}>
              <Route index element={<SettingsView siteId="site-1" userRole="admin" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    const site = screen.getByRole("group", { name: "현장 정보" });
    expect(site).toHaveTextContent(mockDashboard.site.customerName);
    expect(site).toHaveTextContent(mockDashboard.site.address!);
    expect(site).toHaveTextContent(mockDashboard.site.timeZone);

    const floors = screen.getByRole("group", { name: "층·도면" });
    expect(floors).toHaveTextContent(`${mockDashboard.floors.length}개 층`);
    expect(floors).toHaveTextContent(`맵 설정 ${mockDashboard.floors.length}개`);
    expect(within(floors).getByRole("link", { name: "맵 관리 열기" })).toHaveAttribute(
      "href",
      "/settings/floor-plans?siteId=site-1#fragment"
    );

    expect(screen.getByRole("group", { name: "Gateway 상태" })).toHaveTextContent(/정상|오프라인|미등록/);
    const security = screen.getByRole("group", { name: "계정·보안" });
    expect(within(security).getByRole("link", { name: "계정 보안 열기" })).toHaveAttribute(
      "href",
      "/settings/security?siteId=site-1#fragment"
    );
    expect(screen.queryByRole("region", { name: "조명 등록 패널" })).not.toBeInTheDocument();
  });

  it("asks before switching sites while the floor editor is dirty", () => {
    const draft = {
      floor: { id: "floor-1", siteId: "site-1", name: "작성 중", level: -1, mapRevision: 3, floorPlan: null },
      fixtures: [],
      lightSlots: [],
      objects: []
    };
    useFloorEditorStore.setState({ state: draft, isDirty: true });
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} selectedSiteId="site-1" />}>
            <Route path="floor-plans" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: /현장 선택/ }));
    fireEvent.click(screen.getByRole("option", { name: "지사 주차장" }));

    expect(screen.getByRole("alertdialog", { name: "현장 변경" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-1");
    expect(useFloorEditorStore.getState()).toMatchObject({ state: draft, isDirty: true });

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("alertdialog", { name: "현장 변경" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-1");
  });

  it("discards the editor draft once after an approved site switch", () => {
    const baseline = {
      floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 3, floorPlan: null },
      fixtures: [{
        id: "fixture-1", name: "L1", x: 10, y: 20, size: 20, ratedWatt: 40,
        brightness: 70, status: "online" as const
      }],
      lightSlots: [],
      objects: []
    };
    useFloorEditorStore.getState().initialize(baseline);
    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 99 });
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans/floor-1/edit?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<RoutedSettingsShell />}>
            <Route path="floor-plans" element={<LocationProbe />} />
            <Route path="floor-plans/:floorId/edit" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: /현장 선택/ }));
    fireEvent.click(screen.getByRole("option", { name: "지사 주차장" }));
    fireEvent.click(screen.getByRole("button", { name: "변경" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-2");
    expect(useFloorEditorStore.getState()).toMatchObject({ state: baseline, initialState: baseline, isDirty: false });

    fireEvent.click(screen.getByRole("button", { name: /현장 선택/ }));
    fireEvent.click(screen.getByRole("option", { name: "본사 주차장" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-1");
  });

  it("uses explicit refs for active-tab scrolling", () => {
    const source = readFileSync("src/features/settings/SettingsSubnavigation.tsx", "utf8");
    expect(source).not.toContain("querySelector");
  });

  it("uses the shared form controls across general settings", () => {
    const files = [
      "src/features/sites/SiteSwitcher.tsx",
      "src/features/settings/security/AccountSecurityView.tsx",
      "src/features/settings/security/PasswordSettingsView.tsx",
      "src/features/settings/site/SiteOperationsView.tsx",
      "src/features/settings/users/SiteUsersView.tsx",
      "src/features/settings/users/SiteUserFormDialog.tsx",
      "src/features/settings/users/ResetSiteUserPasswordDialog.tsx",
      "src/features/settings/users/DeleteSiteUserDialog.tsx"
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/<(input|select|textarea)\b/);
    }
  });

  it("keeps settings commissioning screens independent from legacy style hooks", () => {
    const files = [
      "src/features/registration/RegistrationPanel.tsx",
      "src/features/registration/FixtureBatchForm.tsx",
      "src/features/registration/FixtureIndividualForm.tsx",
      "src/features/settings/registration/RegistrationSettingsView.tsx",
      "src/features/settings/SettingsView.tsx",
      "src/features/settings/SettingsSubnavigation.tsx",
      "src/features/settings/floor-plans/FloorPlanSettingsView.tsx",
      "src/features/settings/TestDataToolsPanel.tsx",
      "src/features/setup/SetupWizard.tsx",
      "src/features/setup/GatewayClaimPanel.tsx",
      "src/features/rf/RfPlanningPanel.tsx",
      "src/features/floor-editor/FixtureIdentifyPanel.tsx",
      "src/features/floor-editor/FloorEditorCanvas.tsx"
    ];
    const legacyHook = /\b(?:ui-button(?:-secondary)?|ui-underline-navigation-item|registration-(?:panel|summary|targets|session|selection-toolbar|node-list|eligibility-warning|config|mode-toggle|config-form|fields|submit)|node-(?:row|selection|identity|status)|selection-checkbox|reconcile-actions|registered-(?:node-details|node-list|node-row|elsewhere-notice)|settings-(?:screen|card-list|test-data-card|test-data-actions|card-heading)|floor-plan-(?:card|card-summary|edit-link)|setup-(?:wizard|section|form-grid|range-row|submit)|gateway-claim-panel|floor-edit-(?:list|row)|panel-title-row|eyebrow|compact-list|floor-editor-(?:actions|konva-stage)|editor-properties-panel|individual-fixture-(?:list|fields|error)|session-meta|muted-node|success-text|danger-text|setting-card)\b/;

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const classNames = [...source.matchAll(/className=(?:["']([^"']*)["']|{["']([^"']*)["']}|{`([^`]*)`})/g)]
        .flatMap((match) => match.slice(1).filter(Boolean));
      expect(classNames.join(" "), file).not.toMatch(legacyHook);
    }
  });
});
