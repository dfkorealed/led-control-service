import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutomationVisiblePagePoll } from "./useAutomationVisiblePagePoll";

describe("useAutomationVisiblePagePoll", () => {
  afterEach(cleanup);

  it("ignores a manual refresh response after the site, filter, or page scope changes", async () => {
    let resolveOld!: (value: string) => void;
    const oldRequest = new Promise<string>((resolve) => { resolveOld = resolve; });
    const oldSuccess = vi.fn();
    const newSuccess = vi.fn();
    const onError = vi.fn();
    const { result, rerender } = renderHook(({ scopeKey, pageKey, fetchPage, onSuccess }) =>
      useAutomationVisiblePagePoll({ enabled: false, scopeKey, pageKey, fetchPage, onSuccess, onError }), {
      initialProps: { scopeKey: "site-a:all", pageKey: "0:", fetchPage: () => oldRequest, onSuccess: oldSuccess }
    });

    const pending = result.current();
    rerender({ scopeKey: "site-b:filtered", pageKey: "1:other-cursor", fetchPage: async () => "new", onSuccess: newSuccess });
    await act(async () => { resolveOld("old site data"); await pending; });

    expect(oldSuccess).not.toHaveBeenCalled();
    expect(newSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores an old manual response after an A to B to A scope roundtrip", async () => {
    let resolveOld!: (value: string) => void;
    const oldRequest = new Promise<string>((resolve) => { resolveOld = resolve; });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const { result, rerender } = renderHook(({ scopeKey, pageKey, fetchPage }) =>
      useAutomationVisiblePagePoll({ enabled: false, scopeKey, pageKey, fetchPage, onSuccess, onError }), {
      initialProps: { scopeKey: "A", pageKey: "0:first", fetchPage: () => oldRequest }
    });

    const pending = result.current();
    rerender({ scopeKey: "B", pageKey: "0:first", fetchPage: async () => "B" });
    rerender({ scopeKey: "A", pageKey: "0:first", fetchPage: async () => "fresh A" });
    await act(async () => { resolveOld("stale A"); await pending; });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
