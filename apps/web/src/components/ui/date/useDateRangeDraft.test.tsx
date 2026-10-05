import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as UI from "../index";

afterEach(cleanup);
describe("useDateRangeDraft", () => {
  it("isolates stale range writes and reset callbacks across A B A", () => {
    expect(UI.useDateRangeDraft).toBeTypeOf("function");
    const { result, rerender } = renderHook(({ scope }) => UI.useDateRangeDraft(scope, null), { initialProps: { scope: "A" } });
    const write = result.current.onDraftChange; const reset = result.current.reset;
    rerender({ scope: "B" }); rerender({ scope: "A" });
    act(() => write({ start: { year: 2055, month: 2, day: null }, end: { year: null, month: null, day: 15 } }));
    act(() => reset({ start: "2055-02-01", end: "2055-02-15" }));
    expect(result.current.draft).toEqual({ start: { year: null, month: null, day: null }, end: { year: null, month: null, day: null } });
  });
  it("retains reversed dates without sorting and resets both endpoints explicitly", () => {
    expect(UI.useDateRangeDraft).toBeTypeOf("function");
    const { result } = renderHook(() => UI.useDateRangeDraft("site", { start: "2026-03-15", end: "2026-02-01" }));
    expect(result.current.draft).toEqual({ start: { year: 2026, month: 3, day: 15 }, end: { year: 2026, month: 2, day: 1 } });
    act(() => result.current.reset(null));
    expect(result.current.draft).toEqual({ start: { year: null, month: null, day: null }, end: { year: null, month: null, day: null } });
  });
});
