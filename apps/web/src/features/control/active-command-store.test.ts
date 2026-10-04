import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commandStore from "./active-command-store";
import {
  activeCommandStorageKey,
  clearActiveCommandRequest,
  clearActiveCommandsForUser,
  clearActiveCommandId,
  clearObservedVerificationCase,
  loadActiveCommandRequest,
  loadActiveCommandId,
  loadObservedVerificationCase,
  loadPendingCaseStatusCheck,
  savePendingCaseStatusCheck,
  clearPendingCaseStatusCheck,
  isActiveCommandReplayRejected,
  markActiveCommandReplayRejected,
  loadActiveCommandReplayRejectedCaseId,
  loadReconciledOriginalCommandId,
  markActiveCommandCaseReconciled,
  loadRecentResolvedCaseId,
  saveRecentResolvedCaseId,
  saveActiveCommandRequest,
  saveActiveCommandId,
  saveObservedVerificationCase
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

// The native bootstrap, not an unvalidated window flag, owns this opt-in.
const mobileKey = `led-control:active-command:mobile:v1:${USER_A}:${REQUEST.siteId}`;
describe("mobile durable command recovery", () => {
  beforeEach(() => {
    commandStore.configureActiveCommandPersistence(true);
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    commandStore.configureActiveCommandPersistence(false);
    sessionStorage.clear();
    localStorage.clear();
  });

  it("keeps the original canonical request and returned identity when the session is lost", () => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);
    saveActiveCommandId(USER_A, REQUEST.siteId, COMMAND_ID);
    sessionStorage.clear();
    expect(localStorage.getItem(mobileKey)).not.toBeNull();
    expect(loadActiveCommandId(USER_A, REQUEST.siteId)).toBe(COMMAND_ID);
    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).toEqual({ ...REQUEST,
      target: { type: "fixtures", fixtureIds: ["00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006"] } });
    expect(loadActiveCommandRequest(USER_B, REQUEST.siteId)).toBeNull();
    expect(loadActiveCommandRequest(USER_A, "another-site")).toBeNull();
  });

  it("does not switch browser persistence based on the legacy mobile flag", () => {
    commandStore.configureActiveCommandPersistence(false);
    vi.stubGlobal("__LED_CONTROL_MOBILE_WEBVIEW__", true);
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);
    expect(sessionStorage.getItem(activeCommandStorageKey(USER_A, REQUEST.siteId))).not.toBeNull();
    expect(localStorage.getItem(mobileKey)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("preserves an unreadable existing record and prevents replacement instead of treating it as absent", () => {
    const raw = JSON.stringify({ request: REQUEST });
    localStorage.setItem(mobileKey, raw);
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (this === localStorage) throw new DOMException("blocked", "SecurityError");
      return getItem.call(this, key);
    });
    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).toBeNull();
    expect(commandStore.getActiveCommandStorageError()).toBeTruthy();
    expect(saveActiveCommandRequest(USER_A, REQUEST.siteId, { ...REQUEST, brightness: 90 })).toBe(false);
    expect(getItem.call(localStorage, mobileKey)).toBe(raw);
  });

  it("fails closed on corrupt native records without deleting or overwriting them", () => {
    localStorage.setItem(mobileKey, "{");
    expect(loadActiveCommandId(USER_A, REQUEST.siteId)).toBeNull();
    expect(commandStore.getActiveCommandStorageError()).toBeTruthy();
    expect(saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST)).toBe(false);
    expect(localStorage.getItem(mobileKey)).toBe("{");
  });

  it("reports durable write failure before a request can be sent", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST)).toBe(false);
    expect(commandStore.getActiveCommandStorageError()).toBeTruthy();
  });

  it.each(["request", "command", "status-check"] as const)("locks native control when an invalid %s cannot be persisted", (kind) => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);
    const original = localStorage.getItem(mobileKey);
    const saved = kind === "request"
      ? saveActiveCommandRequest(USER_A, REQUEST.siteId, { ...REQUEST, brightness: 101 })
      : kind === "command"
      ? saveActiveCommandId(USER_A, REQUEST.siteId, "invalid-command-id")
      : commandStore.savePendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID, "invalid-check-id");
    expect(saved).toBe(false);
    expect(commandStore.getActiveCommandStorageError()).toBeTruthy();
    expect(localStorage.getItem(mobileKey)).toBe(original);
  });

  it("keeps the same manual status-check key across session loss and clears it only by matching identity", () => {
    commandStore.savePendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID, CLIENT_REQUEST_ID);
    sessionStorage.clear();
    expect(commandStore.loadPendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID)).toEqual({ commandId: COMMAND_ID, clientRequestId: CLIENT_REQUEST_ID });
    expect(commandStore.loadPendingCommandStatusCheck(USER_B, REQUEST.siteId, COMMAND_ID)).toBeNull();
    expect(commandStore.clearPendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID, OTHER_COMMAND_ID)).toBe(false);
    expect(commandStore.clearPendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID, CLIENT_REQUEST_ID)).toBe(true);
    expect(commandStore.loadPendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID)).toBeNull();
  });

  it("clears both command namespaces at auth boundaries without removing unrelated storage", () => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);
    localStorage.setItem("unrelated-preference", "keep");
    sessionStorage.setItem(`led-control:active-command:${USER_B}:site-b`, JSON.stringify({ commandId: OTHER_COMMAND_ID }));
    commandStore.clearAllActiveCommands();
    expect(localStorage.getItem(mobileKey)).toBeNull();
    expect(sessionStorage.getItem(`led-control:active-command:${USER_B}:site-b`)).toBeNull();
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("retains a durable record and latches a safety error when auth cleanup cannot remove it", () => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    commandStore.clearAllActiveCommands();
    expect(commandStore.getActiveCommandStorageError()).toBeTruthy();
    expect(localStorage.getItem(mobileKey)).not.toBeNull();
  });

  it("does not overwrite an unreadable or corrupt pending manual Get identity", () => {
    const checkKey = `${mobileKey}:command-check:${COMMAND_ID}`;
    localStorage.setItem(checkKey, "{");
    expect(commandStore.savePendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID, CLIENT_REQUEST_ID)).toBe(false);
    expect(commandStore.getActiveCommandStorageError()).toBeTruthy();
    expect(localStorage.getItem(checkKey)).toBe("{");
  });

  it("removes the matching manual Get record when a resolved command is cleared", () => {
    saveActiveCommandId(USER_A, REQUEST.siteId, COMMAND_ID);
    commandStore.savePendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID, CLIENT_REQUEST_ID, ["check-dispatch"]);
    expect(commandStore.loadPendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID)).toEqual({ commandId: COMMAND_ID, clientRequestId: CLIENT_REQUEST_ID, dispatchIds: ["check-dispatch"] });
    expect(clearActiveCommandId(USER_A, REQUEST.siteId, COMMAND_ID)).toBe(true);
    sessionStorage.clear();
    expect(loadActiveCommandId(USER_A, REQUEST.siteId)).toBeNull();
    expect(commandStore.loadPendingCommandStatusCheck(USER_A, REQUEST.siteId, COMMAND_ID)).toBeNull();
  });
});

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

  it("persists a safety rejection so the same dimming request cannot be replayed after reload", () => {
    saveActiveCommandRequest(USER_A, REQUEST.siteId, REQUEST);
    markActiveCommandReplayRejected(USER_A, REQUEST.siteId, CLIENT_REQUEST_ID, "case-1");
    expect(isActiveCommandReplayRejected(USER_A, REQUEST.siteId, CLIENT_REQUEST_ID)).toBe(true);
    expect(loadActiveCommandReplayRejectedCaseId(USER_A, REQUEST.siteId, CLIENT_REQUEST_ID)).toBe("case-1");
    expect(markActiveCommandCaseReconciled(USER_A, REQUEST.siteId, CLIENT_REQUEST_ID, "wrong-case", COMMAND_ID)).toBe(false);
    expect(markActiveCommandCaseReconciled(USER_A, REQUEST.siteId, CLIENT_REQUEST_ID, "case-1", COMMAND_ID)).toBe(true);
    expect(loadReconciledOriginalCommandId(USER_A, REQUEST.siteId, CLIENT_REQUEST_ID)).toBe(COMMAND_ID);
    expect(isActiveCommandReplayRejected(USER_B, REQUEST.siteId, CLIENT_REQUEST_ID)).toBe(false);
  });

  it("persists a case status-check key only inside its user, site and case scope", () => {
    savePendingCaseStatusCheck(USER_A, "site-a", "case-a", CLIENT_REQUEST_ID);
    expect(loadPendingCaseStatusCheck(USER_A, "site-a", "case-a")).toBe(CLIENT_REQUEST_ID);
    expect(loadPendingCaseStatusCheck(USER_A, "site-b", "case-a")).toBeNull();
    expect(loadPendingCaseStatusCheck(USER_B, "site-a", "case-a")).toBeNull();
    expect(clearPendingCaseStatusCheck(USER_A, "site-a", "case-a", OTHER_COMMAND_ID)).toBe(false);
    expect(clearPendingCaseStatusCheck(USER_A, "site-a", "case-a", CLIENT_REQUEST_ID)).toBe(true);
    expect(loadPendingCaseStatusCheck(USER_A, "site-a", "case-a")).toBeNull();
  });

  it("keeps only the recent resolved case identity in the user/site session", () => {
    saveRecentResolvedCaseId(USER_A, "site-a", "case-1");
    expect(loadRecentResolvedCaseId(USER_A, "site-a")).toBe("case-1");
    expect(loadRecentResolvedCaseId(USER_B, "site-a")).toBeNull();
    expect(loadRecentResolvedCaseId(USER_A, "site-b")).toBeNull();
    clearActiveCommandsForUser(USER_A);
    expect(loadRecentResolvedCaseId(USER_A, "site-a")).toBeNull();
  });

  it("normalizes a legacy stored expiry away before response-loss recovery", () => {
    sessionStorage.setItem(activeCommandStorageKey(USER_A, REQUEST.siteId), JSON.stringify({
      request: { ...REQUEST, overrideUntil: "2026-09-03T01:30:00.000Z" }
    }));

    expect(loadActiveCommandRequest(USER_A, REQUEST.siteId)).toEqual({
      ...REQUEST,
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

  it("persists an observed safety case across remounts but scopes and clears it with logout", () => {
    saveObservedVerificationCase(USER_A, "site-a", COMMAND_ID, "case-1");
    expect(loadObservedVerificationCase(USER_A, "site-a", COMMAND_ID)).toBe("case-1");
    expect(loadObservedVerificationCase(USER_A, "site-b", COMMAND_ID)).toBeNull();
    expect(loadObservedVerificationCase(USER_B, "site-a", COMMAND_ID)).toBeNull();
    expect(loadObservedVerificationCase(USER_A, "site-a", OTHER_COMMAND_ID)).toBeNull();
    expect(clearObservedVerificationCase(USER_A, "site-a", COMMAND_ID, "wrong-case")).toBe(false);
    expect(clearObservedVerificationCase(USER_A, "site-a", COMMAND_ID, "case-1")).toBe(true);
    expect(loadObservedVerificationCase(USER_A, "site-a", COMMAND_ID)).toBeNull();
    saveObservedVerificationCase(USER_A, "site-a", COMMAND_ID, "case-1");
    clearActiveCommandsForUser(USER_A);
    expect(loadObservedVerificationCase(USER_A, "site-a", COMMAND_ID)).toBeNull();
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
