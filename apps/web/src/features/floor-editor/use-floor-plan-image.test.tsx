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

function Harness({ url, selection = "none" }: { url: string; selection?: string }) {
  const result = useFloorPlanImage(url);
  return <div data-image={result.image ? "ready" : "empty"}>
    <span>{result.status}</span>
    <span>{selection}</span>
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
});
