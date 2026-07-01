import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FloorMap } from "./FloorMap";

describe("FloorMap", () => {
  it("renders fixtures with brightness labels", () => {
    render(
      <FloorMap
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
              lastSeenAt: "2026-07-01T00:00:00.000Z"
            }
          ]
        }}
      />
    );

    expect(screen.getByText("B2-L01")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
  });
});
