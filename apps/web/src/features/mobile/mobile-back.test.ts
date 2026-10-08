import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOverlay, closeTopOverlay } from "../../components/ui/overlays/overlay-stack";
import { dirtyEditorSentinelKey } from "../floor-editor/dirty-editor-history";
import { handleMobileBack, registerMobileBackGuard } from "./mobile-back";

afterEach(() => { window.history.replaceState({ idx: 0 }, ""); vi.restoreAllMocks(); });
describe("native back ownership", () => {
  it("dismisses only the top overlay before any history movement", () => {
    const closed: string[] = []; const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const first = registerOverlay({}, () => { closed.push("first"); });
    const second = registerOverlay({}, () => { closed.push("second"); });
    expect(handleMobileBack()).toEqual({ handled: true, canGoBack: true });
    expect(closed).toEqual(["second"]); expect(back).not.toHaveBeenCalled(); second(); first();
  });
  it("consumes non-dismissible overlays instead of escaping to history", () => {
    const remove = registerOverlay({}); expect(closeTopOverlay()).toBe(true); remove();
  });
  it("runs the dirty callback before navigating and removes it on cleanup", () => {
    let confirms = 0; const remove = registerMobileBackGuard(() => { confirms++; return true; });
    window.history.replaceState({ idx: 2 }, "");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    expect(handleMobileBack().handled).toBe(true); expect(confirms).toBe(1); expect(back).not.toHaveBeenCalled();
    remove(); handleMobileBack(); expect(back).toHaveBeenCalledTimes(1);
  });
  it("lets the existing dirty history sentinel trigger its popstate confirmation", () => {
    window.history.replaceState({ idx: 1, [dirtyEditorSentinelKey]: "dirty-token" }, "");
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    expect(handleMobileBack()).toEqual({ handled: true, canGoBack: true }); expect(back).toHaveBeenCalledTimes(1);
  });
  it("permits native exit only at an explicit clean router root", () => {
    window.history.replaceState({ idx: 0 }, ""); expect(handleMobileBack()).toEqual({ handled: false, canGoBack: false });
    window.history.replaceState(null, ""); expect(handleMobileBack().handled).toBe(true);
  });
});
