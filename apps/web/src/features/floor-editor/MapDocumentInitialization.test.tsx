import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapDocumentInitialization } from "./MapDocumentInitialization";
import { resetFloorEditorDocument } from "../../api/floor-editor-reset";
import { getFloorEditorState } from "../../api/floor-editor";
import type { FloorEditorState } from "./editor-types";

vi.mock("../../api/floor-editor-reset", async original => ({ ...await original<typeof import("../../api/floor-editor-reset")>(), resetFloorEditorDocument: vi.fn() }));
vi.mock("../../api/floor-editor", () => ({ getFloorEditorState: vi.fn() }));
const state: FloorEditorState = { floor: { id: "f", siteId: "s", name: "F", level: 1, mapRevision: 0, mapDocument: null, floorPlan: null }, fixtures: [], lightSlots: [], objects: [] };
const ref = { formatVersion: 1 as const, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 0,
  manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
beforeEach(() => vi.resetAllMocks());
describe("editor initialization lease and confirmation", () => {
  it("coalesces StrictMode empty initialization, locks while pending, and adopts only the matching response", async () => {
    let resolve!: (value: typeof ref) => void;
    vi.mocked(resetFloorEditorDocument).mockReturnValue(new Promise(done => { resolve = done; }));
    const next = { ...state, floor: { ...state.floor, mapRevision: 1, mapDocument: ref } };
    vi.mocked(getFloorEditorState).mockResolvedValue(next);
    const onInitialized = vi.fn(), onBusyChange = vi.fn();
    render(<StrictMode><MapDocumentInitialization state={state} readOnly={false} leaseToken="lease" leaseFence={1} onInitialized={onInitialized} onBusyChange={onBusyChange} /></StrictMode>);
    expect(resetFloorEditorDocument).toHaveBeenCalledTimes(1);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    resolve(ref);
    await waitFor(() => expect(onInitialized).toHaveBeenCalledWith(next));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("never exposes a destructive legacy reset bypass", async () => {
    const legacy = { ...state, lightSlots: [{ id: "slot", x: 1, y: 1, rotation: 0, assignedFixtureId: null }] };
    vi.mocked(resetFloorEditorDocument).mockResolvedValue(ref);
    vi.mocked(getFloorEditorState).mockResolvedValue({ ...state, floor: { ...state.floor, mapRevision: 1, mapDocument: ref } });
    render(<MapDocumentInitialization state={legacy} readOnly={false} leaseToken="lease" leaseFence={1} onInitialized={vi.fn()} />);
    expect(resetFloorEditorDocument).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "맵 초기화" })).not.toBeInTheDocument();
    expect(screen.getByText(/이전 형식 맵은 초기화할 수 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(resetFloorEditorDocument).not.toHaveBeenCalled();
  });
  it("does not initialize without a lease or adopt a stale generation", async () => {
    const onInitialized = vi.fn();
    const view = render(<MapDocumentInitialization state={state} readOnly={false} onInitialized={onInitialized} />);
    expect(resetFloorEditorDocument).not.toHaveBeenCalled();
    vi.mocked(resetFloorEditorDocument).mockResolvedValue(ref);
    vi.mocked(getFloorEditorState).mockResolvedValue({ ...state, floor: { ...state.floor, mapRevision: 1, mapDocument: { ...ref, generationId: "other" } } });
    view.rerender(<MapDocumentInitialization state={state} readOnly={false} leaseToken="lease" leaseFence={1} onInitialized={onInitialized} />);
    await screen.findByText("맵을 준비하지 못했습니다.");
    expect(onInitialized).not.toHaveBeenCalled();
  });
});
