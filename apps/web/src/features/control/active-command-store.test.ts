import { beforeEach, describe, expect, it } from "vitest";
import {
  activeCommandStorageKey,
  clearActiveCommandRequest,
  clearActiveCommandsForUser,
  clearActiveCommandId,
  loadActiveCommandRequest,
  loadActiveCommandId,
  saveActiveCommandRequest,
  saveActiveCommandId
} from "./active-command-store";

const COMMAND_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_COMMAND_ID = "00000000-0000-4000-8000-000000000002";
const CLIENT_REQUEST_ID = "00000000-0000-4000-8000-000000000003";
const USER_A = "user-a";
const USER_B = "user-b";
const REQUEST = {
  siteId: "00000000-0000-4000-8000-000000000004",
  clientRequestId: CLIENT_REQUEST_ID,
  target: {
    type: "fixtures" as const,
    fixtureIds: ["00000000-0000-4000-8000-000000000006", "00000000-0000-4000-8000-000000000005"]
  },
  brightness: 30
};

describe("active command store", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores and loads command IDs under a user-and-site-specific key", () => {
    saveActiveCommandId(USER_A, "site-a", COMMAND_ID);

    expect(loadActiveCommandId(USER_A, "site-a")).toBe(COMMAND_ID);
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, "site-a"))).toBe(JSON.stringify({ commandId: COMMAND_ID }));
  });

  it("stores the canonical request before POST and preserves it when the command ID arrives", () => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);

    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).toEqual({
      ...REQUEST,
      target: { type: "fixtures", fixtureIds: [...REQUEST.target.fixtureIds].sort() }
    });
    saveActiveCommandId(USER_A, REQUEST.siteId, COMMAND_ID);

    expect(loadActiveCommandId(USER_A, REQUEST.siteId)).toBe(COMMAND_ID);
    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).toEqual({
      ...REQUEST,
      target: { type: "fixtures", fixtureIds: [...REQUEST.target.fixtureIds].sort() }
    });
  });

  it("preserves overrideUntil so response-loss recovery replays the identical command fingerprint", () => {
    const request = { ...REQUEST, overrideUntil: "2026-09-03T01:30:00.000Z" };

    saveActiveCommandRequest(USER_A, REQUEST.siteId, request);

    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).toEqual({
      ...request,
      target: { type: "fixtures", fixtureIds: [...REQUEST.target.fixtureIds].sort() }
    });
  });

  it("rejects a request whose payload site does not match its storage scope", () => {
    saveActiveCommandRequest(USER_A, "site-a", REQUEST);

    expect(loadActiveCommandRequest(USER_A, "site-a")).toBeNull();
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, "site-a"))).toBeNull();
  });

  it("isolates commands between sites", () => {
    saveActiveCommandId(USER_A, "site-a", COMMAND_ID);

    expect(loadActiveCommandId(USER_A, "site-b")).toBeNull();
  });

  it("does not expose one user's pending request to another user at the same site", () => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);

    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).not.toBeNull();
    expect(loadActiveCommandRequest(USER_B, REQUEST.siteId)).toBeNull();
    expect(activeCommandStorageKey(USER_A, REQUEST.siteId))
      .not.toBe(activeCommandStorageKey(USER_B, REQUEST.siteId));
  });

  it("clears only when the stored ID matches the expected ID", () => {
    saveActiveCommandId(USER_A, "site-a", COMMAND_ID);

    expect(clearActiveCommandId(USER_A, "site-a", OTHER_COMMAND_ID)).toBe(false);
    expect(loadActiveCommandId(USER_A, "site-a")).toBe(COMMAND_ID);
    expect(clearActiveCommandId(USER_A, "site-a", COMMAND_ID)).toBe(true);
    expect(loadActiveCommandId(USER_A, "site-a")).toBeNull();
  });

  it("clears a rejected pending request only when its client request ID matches", () => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);

    expect(clearActiveCommandRequest(USER_A, REQUEST.siteId, OTHER_COMMAND_ID)).toBe(false);
    expect(clearActiveCommandRequest(USER_A, REQUEST.siteId, CLIENT_REQUEST_ID)).toBe(true);
    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).toBeNull();
  });

  it("clears only the logging-out user's active command records", () => {
    saveActiveCommandId(USER_A, "site-a", COMMAND_ID);
    saveActiveCommandId(USER_A, "site-b", OTHER_COMMAND_ID);
    saveActiveCommandId(USER_B, "site-a", OTHER_COMMAND_ID);

    clearActiveCommandsForUser(USER_A);

    expect(loadActiveCommandId(USER_A, "site-a")).toBeNull();
    expect(loadActiveCommandId(USER_A, "site-b")).toBeNull();
    expect(loadActiveCommandId(USER_B, "site-a")).toBe(OTHER_COMMAND_ID);
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
    sessionStorage.setItem(activeCommandStorageKey(USER_A, "site-a"), value);

    expect(loadActiveCommandId(USER_A, "site-a")).toBeNull();
  });

  it.each(["not-a-uuid", ` ${COMMAND_ID} `])("rejects invalid command ID %s when saving", (commandId) => {
    saveActiveCommandId(USER_A, "site-a", commandId);

    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, "site-a"))).toBeNull();
  });

  it.each(["not-a-uuid", ` ${COMMAND_ID} `])("returns false for invalid command ID %s during CAS clear", (commandId) => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, "site-a"), JSON.stringify({ commandId }));

    expect(clearActiveCommandId(USER_A, "site-a", commandId)).toBe(false);
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, "site-a"))).not.toBeNull();
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
      expect(() => loadActiveCommandId(USER_A, "site-a")).not.toThrow();
      expect(() => saveActiveCommandId(USER_A, "site-a", COMMAND_ID)).not.toThrow();
      expect(() => clearActiveCommandId(USER_A, "site-a", COMMAND_ID)).not.toThrow();
      expect(() => clearActiveCommandsForUser(USER_A)).not.toThrow();
    } finally {
      if (originalDescriptor) Object.defineProperty(window, "sessionStorage", originalDescriptor);
    }
  });
});
