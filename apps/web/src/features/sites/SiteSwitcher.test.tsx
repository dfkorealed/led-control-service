import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SiteSwitcher } from "./SiteSwitcher";

function LocationProbe() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}`}</output>;
}

describe("SiteSwitcher", () => {
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
});
