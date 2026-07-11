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
              lastSeenAt: "2026-07-01T00:00:00.000Z",
              gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
              controllable: true,
              controlBlockReason: null
            }
          ]
        }}
      />
    );

    expect(screen.getByText("B2-L01")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    const fixtureButton = screen.getByRole("button", { name: "B2-L01 정상 70%" });
    expect(fixtureButton).toBeInTheDocument();
    expect(fixtureButton).toHaveStyle({ "--fixture-left": "8.333333333333332%", "--fixture-top": "15%", "--brightness": "70%" });
    expect(screen.getByAltText("B2 도면")).toHaveAttribute("src", "/demo.svg");

    fireEvent.click(fixtureButton);
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-1");
  });
});
