import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFloorPlanImage } from "./use-floor-plan-image";

class ControlledImage extends EventTarget {
  static instances: ControlledImage[] = [];
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  src = "";
  decode = vi.fn(async () => undefined);

  constructor() {
    super();
    ControlledImage.instances.push(this);
  }

  load() {
    this.onload?.(new Event("load"));
  }

  fail() {
    this.onerror?.(new Event("error"));
  }
}

function Harness({ url, revision = 1, assetIdentity, selection = "none", renderLog }: { url: string; revision?: number; assetIdentity?: string; selection?: string; renderLog?: string[] }) {
  const result = useFloorPlanImage(url, assetIdentity ?? url);
  renderLog?.push(`${result.status}:${result.image ? "ready" : "empty"}`);
  return <div data-image={result.image ? "ready" : "empty"}>
    <span>{result.status}</span>
    <span>{selection}</span>
    <span>{revision}</span>
    <button onClick={result.retry}>retry</button>
  </div>;
}

describe("useFloorPlanImage", () => {
  afterEach(() => {
    cleanup();
    ControlledImage.instances = [];
    vi.unstubAllGlobals();
  });

  it("decodes one image for the same URL across unrelated rerenders", async () => {
    vi.stubGlobal("Image", ControlledImage);
    const view = render(<Harness url="/same.svg" selection="fixture-1" />);

    view.rerender(<Harness url="/same.svg" selection="fixture-2" />);
    expect(ControlledImage.instances).toHaveLength(1);

    await act(async () => ControlledImage.instances[0].load());
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(ControlledImage.instances[0].decode).toHaveBeenCalledOnce();
    expect(screen.getByText("fixture-2")).toBeInTheDocument();
  });

  it("reports failure and creates exactly one new decode attempt on retry", async () => {
    vi.stubGlobal("Image", ControlledImage);
    render(<Harness url="/broken.svg" />);

    act(() => ControlledImage.instances[0].fail());
    expect(screen.getByText("error")).toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "retry" }).click());
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(ControlledImage.instances).toHaveLength(2);
    await act(async () => ControlledImage.instances[1].load());
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
  });

  it("does not publish a late previous URL or unmounted load", async () => {
    vi.stubGlobal("Image", ControlledImage);
    const view = render(<Harness url="/first.svg" />);
    view.rerender(<Harness url="/second.svg" />);

    await act(async () => ControlledImage.instances[0].load());
    expect(screen.getByText("loading")).toBeInTheDocument();
    await act(async () => ControlledImage.instances[1].load());
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());

    view.unmount();
    const remount = render(<Harness url="/unmount.svg" />);
    const pending = ControlledImage.instances[2];
    remount.unmount();
    await expect(act(async () => pending.load())).resolves.toBeUndefined();
  });

  it("does not expose a ready image from the previous asset identity during render", async () => {
    vi.stubGlobal("Image", ControlledImage);
    const renderLog: string[] = [];
    const view = render(<Harness url="/revision.svg" assetIdentity="asset-1" renderLog={renderLog} />);
    await act(async () => ControlledImage.instances[0].load());
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());

    const nextRender = renderLog.length;
    view.rerender(<Harness url="/revision.svg" assetIdentity="asset-2" renderLog={renderLog} />);

    expect(renderLog.slice(nextRender)).not.toContain("ready:ready");
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.getByText("loading").parentElement).toHaveAttribute("data-image", "empty");
    expect(ControlledImage.instances).toHaveLength(2);
  });

  it("reuses an immutable asset URL when only the map revision changes", async () => {
    vi.stubGlobal("Image", ControlledImage);
    const view = render(<Harness url="/stable-asset.svg" revision={1} />);
    await act(async () => ControlledImage.instances[0].load());
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());

    view.rerender(<Harness url="/stable-asset.svg" revision={2} />);

    expect(ControlledImage.instances).toHaveLength(1);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("deduplicates shared retries and does not reset a ready entry", async () => {
    vi.stubGlobal("Image", ControlledImage);
    render(<>
      <Harness url="/shared-retry.svg" revision={7} selection="first" />
      <Harness url="/shared-retry.svg" revision={7} selection="second" />
    </>);
    expect(ControlledImage.instances).toHaveLength(1);
    act(() => ControlledImage.instances[0].fail());

    const retries = screen.getAllByRole("button", { name: "retry" });
    act(() => {
      retries[0].click();
      retries[1].click();
    });
    expect(ControlledImage.instances).toHaveLength(2);
    await act(async () => ControlledImage.instances[1].load());
    await waitFor(() => expect(screen.getAllByText("ready")).toHaveLength(2));

    act(() => retries[0].click());
    expect(ControlledImage.instances).toHaveLength(2);
    expect(screen.getAllByText("ready")).toHaveLength(2);
  });

  it("evicts old unused decoded images while protecting listeners and in-flight entries", async () => {
    vi.stubGlobal("Image", ControlledImage);
    const current = render(<Harness url="/protected-current.svg" selection="current" />);
    await act(async () => ControlledImage.instances.at(-1)!.load());
    const currentImageCount = ControlledImage.instances.length;

    const pending = render(<Harness url="/protected-pending.svg" selection="pending" />);
    const pendingImage = ControlledImage.instances.at(-1)!;
    pending.unmount();

    for (let index = 0; index < 12; index++) {
      const view = render(<Harness url={`/eviction-${index}.svg`} selection={`eviction-${index}`} />);
      await act(async () => ControlledImage.instances.at(-1)!.load());
      view.unmount();
    }

    current.rerender(<Harness url="/protected-current.svg" selection="current-rerender" />);
    expect(ControlledImage.instances).toHaveLength(currentImageCount + 13);
    const beforePendingRemount = ControlledImage.instances.length;
    const pendingRemount = render(<Harness url="/protected-pending.svg" selection="pending-remount" />);
    expect(ControlledImage.instances).toHaveLength(beforePendingRemount);
    await act(async () => pendingImage.load());
    expect(screen.getAllByText("ready").length).toBeGreaterThanOrEqual(2);
    pendingRemount.unmount();
  });

  it("ignores a stale decode that settles after its cache entry was evicted", async () => {
    vi.stubGlobal("Image", ControlledImage);
    let resolveStaleDecode!: () => void;
    const staleDecode = new Promise<void>((resolve) => { resolveStaleDecode = resolve; });
    const stale = render(<Harness url="/late-evicted.svg" />);
    const first = ControlledImage.instances.at(-1)!;
    first.decode = vi.fn(() => staleDecode);
    act(() => first.load());
    act(() => first.fail());
    act(() => screen.getByRole("button", { name: "retry" }).click());
    const retry = ControlledImage.instances.at(-1)!;
    await act(async () => retry.load());
    stale.unmount();

    for (let index = 0; index < 12; index++) {
      const view = render(<Harness url={`/late-fill-${index}.svg`} />);
      await act(async () => ControlledImage.instances.at(-1)!.load());
      view.unmount();
    }

    const beforeRemount = ControlledImage.instances.length;
    const remount = render(<Harness url="/late-evicted.svg" />);
    expect(ControlledImage.instances).toHaveLength(beforeRemount + 1);
    expect(screen.getByText("loading")).toBeInTheDocument();
    await act(async () => resolveStaleDecode());
    expect(screen.getByText("loading")).toBeInTheDocument();
    act(() => ControlledImage.instances.at(-1)!.fail());
    remount.unmount();
  });
});
