import type { FloorMapSnapshot } from "@led-control/shared";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Dashboard, FixtureSnapshot } from "../../api/queries";
import type { EditorFixture, FloorEditorState } from "./editor-types";
import { useLocation } from "react-router-dom";
import { useCurrentUser } from "../../api/auth";
import { useDashboard } from "../../api/queries";
import { editorDraftGeneration } from "./editor-drafts";

/** Reuse the shell's principal/tenant queries; never infer read authority from
 * a saved document or from an editor draft. Cache resets rotate the epoch. */
export function useMapDocumentReadScope(floorId: string) {
  const location = useLocation();
  const siteId = new URLSearchParams(location.search).get("siteId") ?? undefined;
  const auth = useCurrentUser();
  const dashboard = useDashboard(siteId);
  const user = auth.data?.user;
  const site = dashboard.data;
  if (!user || user.status !== "active" || !site || site.capabilities?.read === false
    || !site.floors.some(floor => floor.id === floorId)) return null;
  return { siteId: site.site.id, authScope: JSON.stringify([user.organizationId, user.id, user.role, editorDraftGeneration(),
    site.site.id, site.capabilities ?? null]) };
}

export function synchronizeMonitoringCaches(queryClient: QueryClient, state: FloorEditorState) {
  const key = ["floor-map", state.floor.siteId, state.floor.id];
  const previous = queryClient.getQueryData<FloorMapSnapshot>(key);
  // Floor revisions remain monotonic across import generations. An older save
  // callback must not roll back geometry or fixture placements already fetched.
  if (previous && previous.revision > state.floor.mapRevision) return;
  queryClient.setQueryData<FloorMapSnapshot>(
    key,
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
  const document = state.floor.mapDocument;
  const sourceType = plan?.sourceType ?? previous?.floorPlan?.sourceType ?? "image";
  const slotsByFixtureId = new Map(state.lightSlots.flatMap((slot) =>
    slot.assignedFixtureId ? [[slot.assignedFixtureId, slot] as const] : []
  ));
  return {
    floorId: state.floor.id,
    revision: state.floor.mapRevision,
    width: document?.width ?? plan?.width ?? 1200,
    height: document?.height ?? plan?.height ?? 800,
    // Only callers with a confirmed save/apply response publish this snapshot.
    // Clone the reference so subsequent local draft edits cannot mutate monitoring.
    mapDocument: document ? structuredClone(document) : null,
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
    objects: document ? [] : state.objects.map((object): FloorMapSnapshot["objects"][number] => {
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
    }),
    fixtures: state.fixtures.flatMap((fixture) => {
      if (fixture.placementStatus === "unplaced") return [];
      const slot = slotsByFixtureId.get(fixture.id);
      return [{
        id: fixture.id,
        name: fixture.name,
        x: slot?.x ?? fixture.x,
        y: slot?.y ?? fixture.y,
        size: fixture.size ?? 20
      }];
    })
  };
}
