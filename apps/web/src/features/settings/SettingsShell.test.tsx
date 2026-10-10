import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDashboard } from "../../test/fixtures";
import { SettingsShell } from "./SettingsShell";
import { SettingsView } from "./SettingsView";

const manageCapabilities = { read: true, control: true, manage: true, commission: true };
const settingsDashboard = {
  ...mockDashboard,
  floors: mockDashboard.floors.map((floor) => ({
    ...floor,
    mapConfigured: true,
    mapRevision: 1,
    summary: {
      totalFixtures: floor.fixtures.length,
      onlineFixtures: floor.fixtures.filter((fixture) => fixture.status === "online").length,
      faultFixtures: floor.fixtures.filter((fixture) => fixture.status === "fault").length,
      offlineFixtures: floor.fixtures.filter((fixture) => fixture.status === "offline").length
    }
  }))
};

vi.mock("../../api/queries", () => ({
  useDashboard: () => ({ data: settingsDashboard })
}));
vi.mock("../registration/RegistrationPanel", () => ({ RegistrationPanel: () => <section aria-label="조명 등록 패널">조명 등록 패널</section> }));
vi.mock("../setup/GatewayClaimPanel", () => ({ GatewayClaimPanel: () => null }));
vi.mock("../../api/site-users", () => ({ useSiteUsers: () => ({ data: { users: [], count: 0, limit: 100 } }) }));

describe("SettingsShell", () => {
  it.each([
    ["/settings", "설정"], ["/settings/site/", "현장 관리"], ["/settings/users", "사용자 관리"],
    ["/settings/registration", "조명 등록"], ["/settings/floor-plans", "도면 관리"], ["/settings/security", "계정 및 보안"],
  ])("owns one h1 before tabs and leaves the child toolbar on exact route %s", (path, title) => {
    render(<MemoryRouter initialEntries={[`${path}?siteId=site-1#draft`]}><Routes>
      <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} />}>
        <Route index element={<div role="group" aria-label="본문 도구"><button>원본 동작</button></div>} />
        <Route path="*" element={<div role="group" aria-label="본문 도구"><button>원본 동작</button></div>} />
      </Route>
    </Routes></MemoryRouter>);
    const heading = screen.getByRole("heading", { name: title, level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(heading.compareDocumentPosition(screen.getByRole("navigation", { name: "설정 메뉴" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "원본 동작" })).toBeEnabled();
  });
  it("does not claim a heading for a detailed editor route or a capability-filtered exact route", () => {
    const capabilities = { read: true, control: false, manage: false, commission: false };
    const view = render(<MemoryRouter initialEntries={["/settings/floor-plans/floor-1/edit"]}><Routes>
      <Route path="/settings" element={<SettingsShell capabilities={capabilities} />}>
        <Route path="*" element={<h1>편집기 원본 제목</h1>} />
      </Route>
    </Routes></MemoryRouter>);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    view.unmount();
    render(<MemoryRouter initialEntries={["/settings/users"]}><Routes>
      <Route path="/settings" element={<SettingsShell capabilities={capabilities} />}><Route path="*" element={<p>차단 처리</p>} /></Route>
    </Routes></MemoryRouter>);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders an optional account slot without changing the routed settings content", () => {
    render(<MemoryRouter initialEntries={["/settings"]}><Routes>
      <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} accountSlot={<section aria-label="내 계정">계정 표시</section>} />}>
        <Route index element={<h2>설정 내용</h2>} />
      </Route>
    </Routes></MemoryRouter>);
    expect(screen.getByRole("region", { name: "내 계정" })).toHaveTextContent("계정 표시");
    expect(screen.getByRole("heading", { name: "설정 내용" })).toBeVisible();
  });

  it("renders settings sections as top tabs with the routed content", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1#map"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} />}>
            <Route path="floor-plans" element={<h2>맵 관리</h2>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByRole("button", { name: /현장 선택/ })).not.toBeInTheDocument();
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
          <Route path="/settings" element={<SettingsShell capabilities={readCapabilities} />}>
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

  it("설정 홈은 실제 데이터와 route action으로 다섯 카드를 표시한다", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/settings?siteId=site-1#fragment"]}>
          <Routes>
            <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} />}>
              <Route index element={<SettingsView siteId="site-1" userRole="admin" capabilities={manageCapabilities} />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByRole("heading", { name: "설정" })).toBeInTheDocument();
    const site = screen.getByRole("group", { name: "현장 관리" });
    expect(site).toHaveTextContent(mockDashboard.site.name);

    const floors = screen.getByRole("group", { name: "맵 관리" });
    expect(floors).toHaveTextContent(`${mockDashboard.floors.length}개 층`);
    expect(floors).toHaveTextContent(`맵 설정 ${mockDashboard.floors.length}개`);
    expect(within(floors).getByRole("link", { name: "맵 관리 열기" })).toHaveAttribute(
      "href",
      "/settings/floor-plans?siteId=site-1#fragment"
    );

    expect(screen.getByRole("group", { name: "조명 등록" })).toHaveTextContent(`등록 조명 ${mockDashboard.summary.totalFixtures}개`);
    expect(screen.getByRole("group", { name: "유저 관리" })).toHaveTextContent("사용자 0명");
    const security = screen.getByRole("group", { name: "계정 보안" });
    expect(within(security).getByRole("link", { name: "계정 보안 열기" })).toHaveAttribute(
      "href",
      "/settings/security?siteId=site-1#fragment"
    );
    expect(screen.queryByRole("region", { name: "조명 등록 패널" })).not.toBeInTheDocument();
  });

  it.each(["site", "users", "registration", "floor-plans", "security", "floor-plans/floor-1/edit"])("provides exactly one mobile home Link preserving query/hash from %s", (path) => {
    render(<MemoryRouter initialEntries={[`/settings/${path}?siteId=site-1&keep=value#draft`]}><Routes>
      <Route path="/settings" element={<SettingsShell capabilities={manageCapabilities} />}>
        <Route path="*" element={<h2>현재 설정 내용</h2>} />
      </Route>
    </Routes></MemoryRouter>);
    const links = screen.getAllByRole("link", { name: "설정으로 돌아가기" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/settings?siteId=site-1&keep=value#draft");
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
