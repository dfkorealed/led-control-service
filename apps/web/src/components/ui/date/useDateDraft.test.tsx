import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as UI from "../index";

afterEach(cleanup);
describe("useDateDraft", () => {
  it("drops stale draft writes across A B A scopes", () => {
    expect(UI.useDateDraft).toBeTypeOf("function");
    const { result, rerender } = renderHook(({ scope }) => UI.useDateDraft(scope, null), { initialProps: { scope: "A" } });
    const staleWrite = result.current.onDraftChange;
    const staleReset = result.current.reset;
    rerender({ scope: "B" }); rerender({ scope: "A" });
    act(() => staleWrite({ year: 2055, month: null, day: 15 }));
    act(() => staleReset("2055-02-15"));
    expect(result.current.draft).toEqual({ year: null, month: null, day: null });
  });
  it("retains partial segments until explicit reset rather than following new initial values", () => {
    expect(UI.useDateDraft).toBeTypeOf("function");
    const { result, rerender } = renderHook(({ value }) => UI.useDateDraft("site-A", value), { initialProps: { value: "2026-02-28" } });
    expect(result.current.draft).toEqual({ year: 2026, month: 2, day: 28 });
    act(() => result.current.onDraftChange({ year: 2055, month: null, day: 15 }));
    rerender({ value: "2026-03-01" });
    expect(result.current.draft).toEqual({ year: 2055, month: null, day: 15 });
    act(() => result.current.reset("2024-02-29"));
    expect(result.current.draft).toEqual({ year: 2024, month: 2, day: 29 });
    act(() => result.current.reset(null));
    expect(result.current.draft).toEqual({ year: null, month: null, day: null });
  });
  it("invalidates callbacks captured before an explicit reset", () => {
    const { result } = renderHook(() => UI.useDateDraft("A", null));
    const staleWrite = result.current.onDraftChange; const staleReset = result.current.reset;
    act(() => result.current.reset("2026-03-01"));
    act(() => staleWrite({ year: 2055, month: null, day: 15 }));
    act(() => staleReset(null));
    expect(result.current.draft).toEqual({ year: 2026, month: 3, day: 1 });
  });
});
