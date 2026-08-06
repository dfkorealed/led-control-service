import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { SettingsShell } from "./SettingsShell";

vi.mock("../../api/queries", () => ({
  useSites: () => ({ data: [
    { id: "site-1", name: "본사 주차장" },
    { id: "site-2", name: "지사 주차장" }
  ] })
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

describe("SettingsShell", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useFloorEditorStore.setState({ isDirty: false });
  });

  it("renders only the admin settings navigation", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell userRole="admin" selectedSiteId="site-1" />}>
            <Route path="floor-plans" element={<h2>도면 관리</h2>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "도면 관리" })).toHaveAttribute("href", "/settings/floor-plans?siteId=site-1");
    expect(screen.queryByRole("link", { name: "설치 및 시운전" })).not.toBeInTheDocument();
  });

  it("blocks a site switch while the floor editor is dirty", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useFloorEditorStore.setState({ isDirty: true });
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell userRole="admin" selectedSiteId="site-1" />}>
            <Route path="floor-plans" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByRole("combobox", { name: "현장 선택" }), { target: { value: "site-2" } });

    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-1");
  });
});
