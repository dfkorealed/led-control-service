import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteSummary } from "../../api/queries";
import { dirtyEditorSentinelKey } from "../floor-editor/dirty-editor-history";
import { SiteSwitcher } from "./SiteSwitcher";

const sites = [
  { id: "site-1", name: "본사 주차장", customerName: "고객사 A" },
  { id: "site-2", name: "물류센터", customerName: "고객사 B" }
] satisfies SiteSummary[];

function LocationProbe() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function RoutedSiteSwitcher() {
  const location = useLocation();
  const selectedSiteId = new URLSearchParams(location.search).get("siteId") ?? undefined;
  return <><SiteSwitcher sites={sites} selectedSiteId={selectedSiteId} canSelectSite={() => window.confirm("discard?")} /><LocationProbe /></>;
}

describe("SiteSwitcher", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("updates only the siteId query while preserving the settings route", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <SiteSwitcher
          sites={[
            { id: "site-1", name: "본사 주차장" },
            { id: "site-2", name: "물류센터" }
          ] satisfies SiteSummary[]}
          selectedSiteId="site-1"
        />
        <LocationProbe />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("현장 선택"), { target: { value: "site-2" } });

    expect(screen.getByText("/settings/floor-plans?siteId=site-2")).toBeInTheDocument();
  });

  it("renders customer and site name when duplicate site names exist", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <SiteSwitcher
          sites={[
            { id: "site-1", name: "본사", customerName: "고객사 A" },
            { id: "site-2", name: "본사", customerName: "고객사 B" }
          ] satisfies SiteSummary[]}
          selectedSiteId="site-1"
        />
      </MemoryRouter>
    );

    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["고객사 A · 본사", "고객사 B · 본사"]);
  });

  it("preserves the current hash while replacing only the siteId", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1#map-preview"]}>
        <SiteSwitcher
          sites={[
            { id: "site-1", name: "본사 주차장" },
            { id: "site-2", name: "물류센터" }
          ] satisfies SiteSummary[]}
          selectedSiteId="site-1"
          canSelectSite={() => true}
        />
        <LocationProbe />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("현장 선택"), { target: { value: "site-2" } });

    expect(screen.getByText("/settings/floor-plans?siteId=site-2#map-preview")).toBeInTheDocument();
  });

  it("leaves a floor-specific editor route when switching sites", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans/floor-1/edit?siteId=site-1"]}>
        <SiteSwitcher
          sites={[
            { id: "site-1", name: "본사 주차장" },
            { id: "site-2", name: "물류센터" }
          ] satisfies SiteSummary[]}
          selectedSiteId="site-1"
        />
        <LocationProbe />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("현장 선택"), { target: { value: "site-2" } });

    expect(screen.getByText("/settings/floor-plans?siteId=site-2")).toBeInTheDocument();
  });

  it("replaces a dirty editor sentinel on an approved site switch", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({ idx: 0 }, "", "/settings?siteId=site-1");
    window.history.pushState({ idx: 1 }, "", "/settings/floor-plans/floor-1/edit?siteId=site-1");
    window.history.pushState({ idx: 2, [dirtyEditorSentinelKey]: "sentinel" }, "", window.location.href);
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/settings" element={<h2>설정 개요</h2>} />
          <Route path="/settings/floor-plans" element={<><h2>도면 관리</h2><RoutedSiteSwitcher /></>} />
          <Route path="/settings/floor-plans/:floorId/edit" element={<><h2>도면 편집</h2><RoutedSiteSwitcher /></>} />
        </Routes>
      </BrowserRouter>
    );

    fireEvent.change(screen.getByRole("combobox", { name: "현장 선택" }), { target: { value: "site-2" } });
    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "도면 편집" })).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();
  });
});
