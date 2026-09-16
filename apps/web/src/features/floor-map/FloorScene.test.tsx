import { fireEvent, render, screen } from "@testing-library/react";
import type { FloorMapSnapshot } from "@led-control/shared";
import type Konva from "konva";
import { Layer, Stage } from "react-konva";
import { describe, expect, it, vi } from "vitest";
import { FloorMapObjectNode, FloorScene } from "./FloorScene";

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
    expect(fixture).toHaveClass("size-5!", "min-h-5!", "rounded-fixture-marker!", "p-0!");
    expect(fixture).toHaveAttribute("data-spatial-map-marker", "true");
    expect(fixture).toHaveAttribute("data-brightness-level", "8");
    expect(fixture).toHaveClass(
      "bg-fixture-brightness-8",
      "shadow-fixture-brightness-8",
      "outline-fixture-selected"
    );
    expect(fixture).toHaveAttribute("aria-current", "true");
    expect(fixture).toHaveAttribute("title", "B1-L001 정상 70%");
    expect(fixture).toHaveTextContent("");
    expect(fixture.querySelector("span[aria-hidden='true']")).toHaveClass("bg-fixture-connected");
    expect(screen.queryByText("B1-L001")).not.toBeInTheDocument();
    expect(screen.queryByText("70%")).not.toBeInTheDocument();
    fireEvent.click(fixture);
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-1");
  });

  it.each([
    [-20, 1], [0, 1], [9, 1],
    [10, 2], [19, 2],
    [20, 3], [29, 3],
    [30, 4], [39, 4],
    [40, 5], [49, 5],
    [50, 6], [59, 6],
    [60, 7], [69, 7],
    [70, 8], [79, 8],
    [80, 9], [89, 9],
    [90, 10], [100, 10], [150, 10]
  ])("maps brightness %i to static level %i", (brightness, level) => {
    render(
      <FloorScene
        snapshot={snapshot}
        fixtures={[{
          id: `fixture-${brightness}`,
          name: `B1-${brightness}`,
          x: 100,
          y: 120,
          brightness,
          status: "online"
        }]}
        interactive={false}
      />
    );

    const marker = screen.getByRole("button", { name: `B1-${brightness} 정상 ${brightness}%` });
    expect(marker).toHaveAttribute("data-brightness-level", String(level));
    expect(marker).toHaveClass(`bg-fixture-brightness-${level}`, `shadow-fixture-brightness-${level}`);
  });

  it("keeps null-filled editor objects hit-testable across their interior", () => {
    const nodeRef: { current: Konva.Node | null } = { current: null };
    render(
      <Stage width={300} height={200}>
        <Layer>
          <FloorMapObjectNode
            object={{ ...snapshot.objects[0], fillColor: null }}
            interactive
            setNodeRef={(value) => { nodeRef.current = value; }}
          />
        </Layer>
      </Stage>
    );

    expect(nodeRef.current?.getAttr("fill")).toBe("transparent");
    expect(nodeRef.current?.listening()).toBe(true);
  });
});
