import { beforeEach, describe, expect, it } from "vitest";
import {
  activeCommandStorageKey,
  clearActiveCommandId,
  loadActiveCommandId,
  saveActiveCommandId
} from "./active-command-store";

describe("active command store", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores and loads command IDs under a site-specific key", () => {
    saveActiveCommandId("site-a", "command-a");

    expect(loadActiveCommandId("site-a")).toBe("command-a");
    expect(sessionStorage.getItem(activeCommandStorageKey("site-a"))).toBe(JSON.stringify({ commandId: "command-a" }));
  });

  it("isolates commands between sites", () => {
    saveActiveCommandId("site-a", "command-a");

    expect(loadActiveCommandId("site-b")).toBeNull();
  });

  it("clears only when the stored ID matches the expected ID", () => {
    saveActiveCommandId("site-a", "command-a");

    expect(clearActiveCommandId("site-a", "stale-command")).toBe(false);
    expect(loadActiveCommandId("site-a")).toBe("command-a");
    expect(clearActiveCommandId("site-a", "command-a")).toBe(true);
    expect(loadActiveCommandId("site-a")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["invalid JSON", "{"],
    ["wrong shape", JSON.stringify({ commandId: 42 })],
    ["null JSON", "null"]
  ])("returns null for %s stored values", (_label, value) => {
    sessionStorage.setItem(activeCommandStorageKey("site-a"), value);

    expect(loadActiveCommandId("site-a")).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      }
    });

    try {
      expect(() => loadActiveCommandId("site-a")).not.toThrow();
      expect(() => saveActiveCommandId("site-a", "command-a")).not.toThrow();
      expect(() => clearActiveCommandId("site-a", "command-a")).not.toThrow();
    } finally {
      if (originalDescriptor) Object.defineProperty(window, "sessionStorage", originalDescriptor);
    }
  });
});
