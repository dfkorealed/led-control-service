import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FloorMap } from "./FloorMap";

const mapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000003",
  revision: 2,
  width: 1200,
  height: 800,
  floorPlan: {
    imageUrl: "/demo.svg",
    sourceType: "image" as const,
    originalFileUrl: "/demo.svg",
    renderedImageUrl: "/demo.svg",
    width: 1200,
    height: 800
  },
  objects: [{
    id: "rectangle-1",
    type: "rectangle" as const,
    x: 40,
    y: 60,
    width: 200,
    height: 100,
    rotation: 0,
    points: null,
    text: null,
    strokeColor: "#0b63e5",
    fillColor: "#dbeafe",
    strokeWidth: 2,
    fontSize: null,
    zIndex: 1,
    locked: false,
    visible: true
  }]
};

describe("FloorMap", () => {
  it("renders fixtures with brightness labels", () => {
    const onSelectFixture = vi.fn();
    render(
      <FloorMap
        snapshot={mapSnapshot}
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
              health: { faultCodes: [], observedAt: "2026-07-01T00:00:00.000Z" },
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
    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();

    fireEvent.click(fixtureButton);
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-1");
  });

  it("labels a provisioned fixture as waiting for its first real state", () => {
    render(
      <FloorMap
        snapshot={{ ...mapSnapshot, floorPlan: null, objects: [] }}
        selectedFixtureId={null}
        onSelectFixture={vi.fn()}
        floor={{
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: null,
          fixtures: [{
            id: "fixture-2",
            name: "B2-L02",
            x: 200,
            y: 240,
            ratedWatt: 40,
            brightness: 0,
            status: "offline",
            statusReason: "provisioning_waiting_state",
            health: null,
            rssi: null,
            hopCount: null,
            commandSuccessRate: null,
            lastSeenAt: null,
            gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
            controllable: false,
            controlBlockReason: "fixture_offline"
          }]
        }}
      />
    );

    expect(screen.getByRole("button", { name: "B2-L02 상태 확인 대기 0%" })).toBeInTheDocument();
  });
});
