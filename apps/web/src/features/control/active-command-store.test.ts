import { beforeEach, describe, expect, it } from "vitest";
import {
  activeCommandStorageKey,
  clearActiveCommandId,
  loadActiveCommandId,
  saveActiveCommandId
} from "./active-command-store";

const COMMAND_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_COMMAND_ID = "00000000-0000-4000-8000-000000000002";

describe("active command store", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores and loads command IDs under a site-specific key", () => {
    saveActiveCommandId("site-a", COMMAND_ID);

    expect(loadActiveCommandId("site-a")).toBe(COMMAND_ID);
    expect(sessionStorage.getItem(activeCommandStorageKey("site-a"))).toBe(JSON.stringify({ commandId: COMMAND_ID }));
  });

  it("isolates commands between sites", () => {
    saveActiveCommandId("site-a", COMMAND_ID);

    expect(loadActiveCommandId("site-b")).toBeNull();
  });

  it("clears only when the stored ID matches the expected ID", () => {
    saveActiveCommandId("site-a", COMMAND_ID);

    expect(clearActiveCommandId("site-a", OTHER_COMMAND_ID)).toBe(false);
    expect(loadActiveCommandId("site-a")).toBe(COMMAND_ID);
    expect(clearActiveCommandId("site-a", COMMAND_ID)).toBe(true);
    expect(loadActiveCommandId("site-a")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["invalid JSON", "{"],
    ["wrong shape", JSON.stringify({ commandId: 42 })],
    ["null JSON", "null"],
    ["malformed command ID", JSON.stringify({ commandId: "not-a-uuid" })],
    ["whitespace-padded UUID", JSON.stringify({ commandId: ` ${COMMAND_ID} ` })]
  ])("returns null for %s stored values", (_label, value) => {
    sessionStorage.setItem(activeCommandStorageKey("site-a"), value);

    expect(loadActiveCommandId("site-a")).toBeNull();
  });

  it.each(["not-a-uuid", ` ${COMMAND_ID} `])("rejects invalid command ID %s when saving", (commandId) => {
    saveActiveCommandId("site-a", commandId);

    expect(sessionStorage.getItem(activeCommandStorageKey("site-a"))).toBeNull();
  });

  it.each(["not-a-uuid", ` ${COMMAND_ID} `])("returns false for invalid command ID %s during CAS clear", (commandId) => {
    sessionStorage.setItem(activeCommandStorageKey("site-a"), JSON.stringify({ commandId }));

    expect(clearActiveCommandId("site-a", commandId)).toBe(false);
    expect(sessionStorage.getItem(activeCommandStorageKey("site-a"))).not.toBeNull();
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
      expect(() => saveActiveCommandId("site-a", COMMAND_ID)).not.toThrow();
      expect(() => clearActiveCommandId("site-a", COMMAND_ID)).not.toThrow();
    } finally {
      if (originalDescriptor) Object.defineProperty(window, "sessionStorage", originalDescriptor);
    }
  });
});
