import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FloorMap } from "./FloorMap";

describe("FloorMap", () => {
  it("renders fixtures with brightness labels", () => {
    const onSelectFixture = vi.fn();
    render(
      <FloorMap
        selectedFixtureId="fixture-1"
        onSelectFixture={onSelectFixture}
        floor={{
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: { imageUrl: "/demo.svg", width: 1200, height: 800, version: 1 },
          fixtures: [
            {
              id: "fixture-1",
              name: "B2-L01",
              x: 100,
              y: 120,
              ratedWatt: 40,
              brightness: 70,
              status: "online",
              rssi: -58,
              hopCount: 1,
              commandSuccessRate: 0.98,
              lastSeenAt: "2026-07-01T00:00:00.000Z"
            }
          ]
        }}
      />
    );

    expect(screen.getByText("B2-L01")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B2-L01 online 70%" })).toBeInTheDocument();
    expect(screen.getByAltText("B2 도면")).toHaveAttribute("src", "/demo.svg");

    fireEvent.click(screen.getByRole("button", { name: "B2-L01 online 70%" }));
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-1");
  });
});
