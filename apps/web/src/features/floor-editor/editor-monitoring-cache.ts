import type { FloorMapSnapshot } from "@led-control/shared";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Dashboard, FixtureSnapshot } from "../../api/queries";
import type { EditorFixture, FloorEditorState } from "./editor-types";

export function synchronizeMonitoringCaches(queryClient: QueryClient, state: FloorEditorState) {
  queryClient.setQueryData<FloorMapSnapshot>(
    ["floor-map", state.floor.siteId, state.floor.id],
    (previous) => toFloorMapSnapshot(state, previous)
  );

  const fixturesById = new Map(state.fixtures.map((fixture) => [fixture.id, fixture]));
  queryClient.setQueryData<InfiniteData<{ items: FixtureSnapshot[]; nextCursor: string | null }>>(
    ["floor-fixtures", state.floor.siteId, state.floor.id],
    (previous) => previous
      ? {
          ...previous,
          pages: previous.pages.map((page) => ({
            ...page,
            items: page.items.map((fixture) => mergeFixture(fixture, fixturesById.get(fixture.id)))
          }))
        }
      : undefined
  );

  queryClient.setQueriesData<Dashboard>({ queryKey: ["dashboard"] }, (previous) => {
    if (!previous || previous.site.id !== state.floor.siteId) return previous;
    return {
      ...previous,
      floors: previous.floors.map((floor) => floor.id === state.floor.id
        ? {
            ...floor,
            floorPlan: state.floor.floorPlan
              ? {
                  imageUrl: state.floor.floorPlan.imageUrl,
                  width: state.floor.floorPlan.width,
                  height: state.floor.floorPlan.height,
                  version: state.floor.floorPlan.version
                }
              : null,
            fixtures: floor.fixtures.map((fixture) => mergeFixture(fixture, fixturesById.get(fixture.id)))
          }
        : floor)
    };
  });
}

function mergeFixture<T extends FixtureSnapshot>(fixture: T, saved: EditorFixture | undefined): T {
  if (!saved) return fixture;
  return {
    ...fixture,
    name: saved.name,
    x: saved.x,
    y: saved.y,
    ratedWatt: saved.ratedWatt,
    ...(saved.size === undefined ? {} : { size: saved.size }),
    ...(saved.placementStatus === undefined ? {} : { placementStatus: saved.placementStatus }),
    ...(saved.positionVerifiedAt === undefined ? {} : { positionVerifiedAt: saved.positionVerifiedAt })
  };
}

function toFloorMapSnapshot(state: FloorEditorState, previous: FloorMapSnapshot | undefined): FloorMapSnapshot {
  const plan = state.floor.floorPlan;
  const sourceType = plan?.sourceType ?? previous?.floorPlan?.sourceType ?? "image";
  return {
    floorId: state.floor.id,
    revision: state.floor.mapRevision,
    width: plan?.width ?? 1200,
    height: plan?.height ?? 800,
    floorPlan: plan
      ? sourceType === "none"
        ? {
            sourceType,
            imageUrl: "",
            originalFileUrl: null,
            renderedImageUrl: null,
            width: plan.width,
            height: plan.height,
            gridSize: plan.gridSize ?? 10
          }
        : {
            sourceType,
            imageUrl: plan.imageUrl,
            originalFileUrl: plan.originalFileUrl ?? null,
            renderedImageUrl: plan.renderedImageUrl ?? null,
            width: plan.width,
            height: plan.height,
            gridSize: plan.gridSize ?? 10
          }
      : null,
    objects: state.objects.map((object): FloorMapSnapshot["objects"][number] => {
      const common = {
        id: object.id,
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
        rotation: object.rotation,
        text: object.text || null,
        strokeColor: object.strokeColor,
        fillColor: object.fillColor ?? null,
        strokeWidth: object.strokeWidth,
        fontSize: object.fontSize ?? null,
        zIndex: object.zIndex,
        locked: object.locked,
        visible: object.visible
      };
      if (object.type === "triangle") {
        return { ...common, type: object.type, points: object.points ?? [
          { x: object.width / 2, y: 0 },
          { x: object.width, y: object.height },
          { x: 0, y: object.height }
        ] };
      }
      if (object.type === "line") return { ...common, type: object.type, height: 0, points: null };
      if (object.type === "text") return { ...common, type: object.type, points: null };
      return { ...common, type: "rectangle", points: null };
    })
  };
}
