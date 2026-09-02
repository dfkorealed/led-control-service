import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDashboard } from "../../test/fixtures";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { SettingsShell } from "./SettingsShell";
import { SettingsView } from "./SettingsView";

vi.mock("../../api/queries", () => ({
  useSites: () => ({ data: [
    { id: "site-1", name: "본사 주차장" },
    { id: "site-2", name: "지사 주차장" }
  ] }),
  useDashboard: () => ({ data: mockDashboard })
}));
vi.mock("../registration/RegistrationPanel", () => ({ RegistrationPanel: () => null }));
vi.mock("../setup/GatewayClaimPanel", () => ({ GatewayClaimPanel: () => null }));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function RoutedSettingsShell() {
  const location = useLocation();
  const selectedSiteId = new URLSearchParams(location.search).get("siteId") ?? undefined;
  return <SettingsShell selectedSiteId={selectedSiteId} />;
}

describe("SettingsShell", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useFloorEditorStore.setState({ isDirty: false });
  });

  it("renders the site context and routed content without an internal settings sidebar", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell selectedSiteId="site-1" />}>
            <Route path="floor-plans" element={<h2>도면 관리</h2>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("combobox", { name: "현장 선택" })).toHaveValue("site-1");
    expect(screen.getByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    expect(screen.queryByLabelText("설정 메뉴")).not.toBeInTheDocument();
  });

  it("설정 개요는 실제 데이터와 route action으로 네 카드를 표시한다", () => {
    render(
      <MemoryRouter initialEntries={["/settings?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell selectedSiteId="site-1" />}>
            <Route index element={<SettingsView siteId="site-1" userRole="admin" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    const site = screen.getByRole("group", { name: "현장 정보" });
    expect(site).toHaveTextContent(mockDashboard.site.customerName);
    expect(site).toHaveTextContent(mockDashboard.site.address!);
    expect(site).toHaveTextContent(mockDashboard.site.timeZone);

    const floors = screen.getByRole("group", { name: "층·도면" });
    expect(floors).toHaveTextContent(`${mockDashboard.floors.length}개 층`);
    expect(floors).toHaveTextContent(`도면 등록 ${mockDashboard.floors.length}개`);
    expect(within(floors).getByRole("link", { name: "도면 관리 열기" })).toHaveAttribute(
      "href",
      "/settings/floor-plans?siteId=site-1"
    );

    expect(screen.getByRole("group", { name: "Gateway 상태" })).toHaveTextContent(/정상|오프라인|미등록/);
    const security = screen.getByRole("group", { name: "계정·보안" });
    expect(within(security).getByRole("link", { name: "비밀번호 변경 열기" })).toHaveAttribute(
      "href",
      "/settings/security?siteId=site-1"
    );
  });

  it("blocks a site switch while the floor editor is dirty", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const draft = {
      floor: { id: "floor-1", siteId: "site-1", name: "작성 중", level: -1, mapRevision: 3, floorPlan: null },
      fixtures: [],
      objects: []
    };
    useFloorEditorStore.setState({ state: draft, isDirty: true });
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell selectedSiteId="site-1" />}>
            <Route path="floor-plans" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByRole("combobox", { name: "현장 선택" }), { target: { value: "site-2" } });

    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-1");
    expect(useFloorEditorStore.getState()).toMatchObject({ state: draft, isDirty: true });
  });

  it("discards the editor draft once after an approved site switch", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const baseline = {
      floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 3, floorPlan: null },
      fixtures: [{
        id: "fixture-1", name: "L1", x: 10, y: 20, size: 20, ratedWatt: 40,
        brightness: 70, status: "online" as const
      }],
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

    fireEvent.change(screen.getByRole("combobox", { name: "현장 선택" }), { target: { value: "site-2" } });

    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-2");
    expect(useFloorEditorStore.getState()).toMatchObject({ state: baseline, initialState: baseline, isDirty: false });

    fireEvent.change(screen.getByRole("combobox", { name: "현장 선택" }), { target: { value: "site-1" } });
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-1");
    expect(confirm).toHaveBeenCalledOnce();
  });
});
