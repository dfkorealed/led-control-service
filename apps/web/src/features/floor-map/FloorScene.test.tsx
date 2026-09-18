import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FloorMapSnapshot } from "@led-control/shared";
import type Konva from "konva";
import { Layer, Stage } from "react-konva";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => cleanup());

  it("renders multi-selected and disabled markers with 44px coarse hit targets", () => {
    const onFixturePress = vi.fn();
    const fixtureA = {
      id: "fixture-a",
      name: "B1-L001",
      x: 100,
      y: 120,
      brightness: 70,
      status: "online" as const
    };
    const fixtureB = {
      id: "fixture-b",
      name: "B1-L002",
      x: 200,
      y: 240,
      brightness: 20,
      status: "online" as const
    };

    render(
      <FloorScene
        snapshot={snapshot}
        fixtures={[fixtureA, fixtureB]}
        interactive={false}
        selection={{
          kind: "multiple",
          selectedFixtureIds: new Set([fixtureA.id]),
          disabledFixtureIds: new Set([fixtureB.id])
        }}
        coarsePointer
        onFixturePress={onFixturePress}
      />
    );

    expect(screen.getByRole("button", { name: /B1-L001.*선택됨/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /B1-L002.*선택 불가/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /B1-L001/ })).toHaveClass("size-12!", "min-h-12!");
  });

  it("renders compact selectable fixtures without visible marker copy", () => {
    const onFixturePress = vi.fn();
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
        selection={{ kind: "single", selectedFixtureIds: new Set(["fixture-1"]) }}
        onFixturePress={onFixturePress}
      />
    );

    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();
    expect(screen.queryByTestId("floor-transformer")).not.toBeInTheDocument();
    const fixture = screen.getByRole("button", { name: "B1-L001 정상 70%" });
    expect(fixture).toHaveClass("size-5!", "min-h-5!", "rounded-fixture-marker!", "p-0!");
    expect(fixture).toHaveAttribute("data-spatial-map-marker", "true");
    expect(fixture).toHaveAttribute("data-brightness-level", "8");
    expect(fixture.querySelector("[data-spatial-map-marker-dot]")).toHaveClass(
      "bg-fixture-brightness-8",
      "shadow-fixture-brightness-8",
      "outline-fixture-selected"
    );
    expect(fixture).toHaveAttribute("aria-current", "true");
    expect(fixture).not.toHaveAttribute("aria-pressed");
    expect(fixture).toHaveAttribute("title", "B1-L001 정상 70%");
    expect(fixture).toHaveTextContent("");
    expect(fixture.querySelector("span[aria-hidden='true']")).toHaveClass("bg-fixture-connected");
    expect(screen.queryByText("B1-L001")).not.toBeInTheDocument();
    expect(screen.queryByText("70%")).not.toBeInTheDocument();
    fireEvent.click(fixture);
    expect(onFixturePress).toHaveBeenCalledWith("fixture-1");
  });

  it("renders the CAD background and only assigned fixture layouts from the monitoring snapshot", () => {
    render(
      <FloorScene
        snapshot={{
          ...snapshot,
          floorPlan: {
            sourceType: "pdf",
            imageUrl: "",
            originalFileUrl: "/api/floors/floor-1/assets/source/content",
            renderedImageUrl: "/api/floors/floor-1/assets/rendered/content",
            width: 1200,
            height: 800,
            gridSize: 10
          },
          fixtures: [{ id: "fixture-assigned", name: "B1-L001", x: 300, y: 200, size: 20 }]
        }}
        fixtures={[
          { id: "fixture-assigned", name: "B1-L001", x: 999, y: 999, brightness: 70, status: "online", placementStatus: "placed" },
          { id: "fixture-unassigned", name: "B1-L002", x: 400, y: 300, brightness: 40, status: "online", placementStatus: "placed" }
        ]}
        interactive={false}
        floorName="B1"
      />
    );

    expect(screen.getByRole("img", { name: "B1 도면" })).toHaveAttribute(
      "src",
      "/api/floors/floor-1/assets/rendered/content"
    );
    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B1-L001 정상 70%" })).toHaveStyle({
      "--fixture-left": "25%",
      "--fixture-top": "25%"
    });
    expect(screen.queryByRole("button", { name: /B1-L002/ })).not.toBeInTheDocument();
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
    expect(marker.querySelector("[data-spatial-map-marker-dot]")).toHaveClass(`bg-fixture-brightness-${level}`, `shadow-fixture-brightness-${level}`);
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
