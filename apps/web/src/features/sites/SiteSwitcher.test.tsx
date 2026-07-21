import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SiteSwitcher } from "./SiteSwitcher";

function LocationProbe() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}${location.hash}`}</output>;
}

describe("SiteSwitcher", () => {
  afterEach(cleanup);

  it("updates only the siteId query while preserving the settings route", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <SiteSwitcher
          sites={[
            { id: "site-1", name: "본사 주차장" },
            { id: "site-2", name: "물류센터" }
          ]}
          selectedSiteId="site-1"
        />
        <LocationProbe />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("현장 선택"), { target: { value: "site-2" } });

    expect(screen.getByText("/settings/floor-plans?siteId=site-2")).toBeInTheDocument();
  });

  it("preserves the current hash while replacing only the siteId", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1#map-preview"]}>
        <SiteSwitcher
          sites={[
            { id: "site-1", name: "본사 주차장" },
            { id: "site-2", name: "물류센터" }
          ]}
          selectedSiteId="site-1"
        />
        <LocationProbe />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("현장 선택"), { target: { value: "site-2" } });

    expect(screen.getByText("/settings/floor-plans?siteId=site-2#map-preview")).toBeInTheDocument();
  });
});
