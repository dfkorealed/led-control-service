import { act, cleanup, renderHook } from "@testing-library/react";
import { type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { dirtyEditorSentinelKey } from "../floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { useGuardedSiteSelection } from "./useGuardedSiteSelection";

const baseline = {
  floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 3, floorPlan: null },
  fixtures: [{ id: "fixture-1", name: "L1", x: 10, y: 20, size: 20, ratedWatt: 40, brightness: 70, status: "online" as const }],
  lightSlots: [],
  objects: []
};

function wrapper(initialEntry: string) {
  return ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>;
}

function useHarness() {
  const selection = useGuardedSiteSelection("site-1");
  const location = useLocation();
  return { ...selection, href: `${location.pathname}?${new URLSearchParams(location.search).toString()}${location.hash}` };
}

afterEach(() => {
  cleanup();
  useFloorEditorStore.getState().reset();
  window.history.replaceState({}, "", "/");
});

describe("useGuardedSiteSelection", () => {
  it("switches a clean editor to the floor list while preserving query and hash", () => {
    const { result } = renderHook(useHarness, { wrapper: wrapper("/settings/floor-plans/floor-1/edit?siteId=site-1&mode=map#selection") });

    act(() => result.current.requestSiteChange("site-2"));

    expect(result.current.href).toBe("/settings/floor-plans?siteId=site-2&mode=map#selection");
    expect(result.current.pendingSiteId).toBeNull();
  });

  it("preserves a dirty draft on cancel and discards it exactly once on confirm", () => {
    useFloorEditorStore.getState().initialize(baseline);
    useFloorEditorStore.getState().updateFixture("fixture-1", { x: 99 });
    const { result } = renderHook(useHarness, { wrapper: wrapper("/settings/floor-plans/floor-1/edit?siteId=site-1") });

    act(() => result.current.requestSiteChange("site-2"));
    expect(result.current.pendingSiteId).toBe("site-2");
    expect(result.current.href).toBe("/settings/floor-plans/floor-1/edit?siteId=site-1");
    expect(useFloorEditorStore.getState().isDirty).toBe(true);

    act(() => result.current.cancelSiteChange());
    expect(result.current.pendingSiteId).toBeNull();
    expect(useFloorEditorStore.getState().isDirty).toBe(true);

    act(() => result.current.requestSiteChange("site-2"));
    act(() => result.current.confirmSiteChange());
    expect(result.current.href).toBe("/settings/floor-plans?siteId=site-2");
    expect(useFloorEditorStore.getState()).toMatchObject({ state: baseline, initialState: baseline, isDirty: false });
  });

  it("also guards a remaining dirty history sentinel", () => {
    window.history.replaceState({ [dirtyEditorSentinelKey]: "draft-token" }, "", "/");
    const { result } = renderHook(useHarness, { wrapper: wrapper("/monitoring?siteId=site-1") });

    act(() => result.current.requestSiteChange("site-2"));

    expect(result.current.pendingSiteId).toBe("site-2");
    expect(result.current.href).toBe("/monitoring?siteId=site-1");
  });
});
