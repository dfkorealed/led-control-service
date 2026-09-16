import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteSummary } from "../../api/queries";
import { SiteSwitcher } from "./SiteSwitcher";

const sites = [
  { id: "site-1", name: "본사 주차장", customerName: "고객사 A" },
  { id: "site-2", name: "물류센터", customerName: "고객사 B" }
] satisfies SiteSummary[];

function LocationProbe() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function selectSite(label: string) {
  fireEvent.click(screen.getByRole("button", { name: /현장 선택/ }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("SiteSwitcher", () => {
  afterEach(() => {
    cleanup();
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

    selectSite("물류센터");

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

    fireEvent.click(screen.getByRole("button", { name: /현장 선택/ }));
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
        />
        <LocationProbe />
      </MemoryRouter>
    );

    selectSite("물류센터");

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

    selectSite("물류센터");

    expect(screen.getByText("/settings/floor-plans?siteId=site-2")).toBeInTheDocument();
  });

  it("delegates a site selection when the shell owns navigation", () => {
    const onSelectionChange = vi.fn();
    render(
      <MemoryRouter initialEntries={["/settings?siteId=site-1"]}>
        <SiteSwitcher sites={sites} selectedSiteId="site-1" onSelectionChange={onSelectionChange} />
        <LocationProbe />
      </MemoryRouter>
    );

    selectSite("고객사 B · 물류센터");

    expect(onSelectionChange).toHaveBeenCalledWith("site-2");
    expect(screen.getByText("/settings?siteId=site-1")).toBeInTheDocument();
  });
});
