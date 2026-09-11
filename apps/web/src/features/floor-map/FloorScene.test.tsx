import { fireEvent, render, screen } from "@testing-library/react";
import type { FloorMapSnapshot } from "@led-control/shared";
import { describe, expect, it, vi } from "vitest";
import { FloorScene } from "./FloorScene";

const snapshot: FloorMapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000003",
  revision: 3,
  width: 1200,
  height: 800,
  floorPlan: null,
  objects: [{
    id: "rectangle-1",
    type: "rectangle",
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

describe("FloorScene", () => {
  it("renders compact selectable fixtures without visible marker copy", () => {
    const onSelectFixture = vi.fn();
    render(
      <FloorScene
        snapshot={snapshot}
        fixtures={[{
          id: "fixture-1",
          name: "B1-L001",
          x: 100,
          y: 120,
          brightness: 70,
          status: "online"
        }]}
        interactive={false}
        selectedFixtureId="fixture-1"
        onSelectFixture={onSelectFixture}
      />
    );

    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();
    expect(screen.queryByTestId("floor-transformer")).not.toBeInTheDocument();
    const fixture = screen.getByRole("button", { name: "B1-L001 정상 70%" });
    expect(fixture).toHaveAttribute("data-spatial-map-marker", "true");
    expect(fixture).toHaveAttribute("aria-current", "true");
    expect(fixture).toHaveAttribute("title", "B1-L001 정상 70%");
    expect(fixture).toBeEmptyDOMElement();
    expect(screen.queryByText("B1-L001")).not.toBeInTheDocument();
    expect(screen.queryByText("70%")).not.toBeInTheDocument();
    fireEvent.click(fixture);
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-1");
  });

  it("maps online brightness to monotonically stronger light variables", () => {
    render(
      <FloorScene
        snapshot={snapshot}
        fixtures={[0, 50, 100].map((brightness, index) => ({
          id: `fixture-${brightness}`,
          name: `B1-L00${index + 1}`,
          x: 100 + index * 100,
          y: 120,
          brightness,
          status: "online" as const
        }))}
        interactive={false}
      />
    );

    const off = screen.getByRole("button", { name: "B1-L001 정상 0%" });
    const medium = screen.getByRole("button", { name: "B1-L002 정상 50%" });
    const full = screen.getByRole("button", { name: "B1-L003 정상 100%" });

    expect(off).toHaveStyle({ "--fixture-lightness": "18%", "--fixture-glow-alpha": "0", "--fixture-glow-radius": "0px" });
    expect(medium).toHaveStyle({ "--fixture-lightness": "50%", "--fixture-glow-alpha": "0.24", "--fixture-glow-radius": "7px" });
    expect(full).toHaveStyle({ "--fixture-lightness": "82%", "--fixture-glow-alpha": "0.48", "--fixture-glow-radius": "14px" });
  });
});
