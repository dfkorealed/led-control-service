import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FloorMapSnapshot } from "@led-control/shared";
import { FloorPlanPreview } from "./FloorPlanPreview";

const { useFloorMapSnapshot, refetch } = vi.hoisted(() => ({ useFloorMapSnapshot: vi.fn(), refetch: vi.fn() }));
vi.mock("../../../api/queries", () => ({ useFloorMapSnapshot }));
const snapshot: FloorMapSnapshot = { floorId: "floor-1", revision: 0, width: 1200, height: 800, floorPlan: null, objects: [], fixtures: [{ id: "fixture-1", name: "실제 조명", x: 200, y: 300, size: 20 }] };
function preview(active: boolean) { return <QueryClientProvider client={new QueryClient()}><FloorPlanPreview floorId="floor-1" siteId="site-1" floorName="B1" active={active} /></QueryClientProvider>; }
describe("FloorPlanPreview", () => {
  it("announces first image paint outside the inert readonly map", () => {
    useFloorMapSnapshot.mockReturnValue({ data: { ...snapshot, floorPlan: {
      sourceType: "image", imageUrl: "/preview.svg", version: 1, width: 1200, height: 800
    } }, error: null, refetch });
    const view = render(preview(true));
    const status = screen.getByRole("status");
    expect(status.closest('[inert], [aria-hidden="true"], [role="img"]')).toBeNull();
    expect(view.container.querySelector('[data-floor-map-webgl-overlay]')).toHaveAttribute("aria-hidden", "true");
    fireEvent.load(view.container.querySelector('img[src="/preview.svg"]')!);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("uses the shared map overlay during snapshot fetch and stops it on error", () => {
    useFloorMapSnapshot.mockReturnValue({ data: undefined, error: null, refetch });
    const view = render(preview(true));
    expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    useFloorMapSnapshot.mockReturnValue({ data: undefined, error: new Error("failed"), refetch });
    view.rerender(preview(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it("renders actual readonly snapshot with unknown pins and disposes scene offscreen", () => {
    useFloorMapSnapshot.mockReturnValue({ data: snapshot, error: null, refetch });
    const view = render(preview(true));
    const image = screen.getByRole("img", { name: "B1 도면 미리보기" });
    expect(image).toHaveClass("h-44");
    expect(within(image).getByRole("button", { name: "실제 조명 조명 정보 확인 전", hidden: true })).toBeInTheDocument();
    expect(image.querySelector('[inert][aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /정상|오프라인|0%|확대/ })).not.toBeInTheDocument();
    view.rerender(preview(false));
    expect(useFloorMapSnapshot).toHaveBeenLastCalledWith(undefined, "site-1");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(view.container.querySelector("canvas")).not.toBeInTheDocument();
  });
  it("exposes actual query errors and an accessible retry outside the inert scene", () => {
    useFloorMapSnapshot.mockReturnValue({ data: undefined, error: new Error("failed"), refetch });
    render(preview(true));
    expect(screen.getByRole("alert")).toHaveTextContent("도면 조회 오류");
    fireEvent.click(screen.getByRole("button", { name: "B1 미리보기 다시 불러오기" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
  it("supports an actual zero-fixture snapshot without invented counts or markers", () => {
    useFloorMapSnapshot.mockReturnValue({ data: { ...snapshot, fixtures: [] }, refetch });
    render(preview(true));
    expect(screen.getByRole("img", { name: "B1 도면 미리보기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /조명 정보/ , hidden: true })).not.toBeInTheDocument();
  });
});
