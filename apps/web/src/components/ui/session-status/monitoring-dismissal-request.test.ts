import { afterEach, expect, it, vi } from "vitest";
import { listPendingDismissalRequestIds, removePendingDismissalRequest, storePendingDismissalRequest } from "./monitoring-dismissal-request";
const scope = { userId: "00000000-0000-4000-8000-000000000001", siteId: "00000000-0000-4000-8000-000000000002" };
const first = "00000000-0000-4000-8000-000000000003";
const second = "00000000-0000-4000-8000-000000000004";
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it("stores independent requests across tabs and removes only the confirmed scoped key", () => {
  const otherAccount = { ...scope, userId: "00000000-0000-4000-8000-000000000005" };
  const otherSite = { ...scope, siteId: "00000000-0000-4000-8000-000000000006" };
  storePendingDismissalRequest(scope, first, localStorage);
  storePendingDismissalRequest(scope, second, localStorage);
  storePendingDismissalRequest(otherAccount, first, localStorage);
  storePendingDismissalRequest(otherSite, first, localStorage);
  localStorage.setItem("unrelated", "keep");
  expect(listPendingDismissalRequestIds(scope, localStorage)).toEqual([first, second]);
  removePendingDismissalRequest(scope, first, localStorage);
  expect(listPendingDismissalRequestIds(scope, localStorage)).toEqual([second]);
  expect(listPendingDismissalRequestIds(otherAccount, localStorage)).toEqual([first]);
  expect(listPendingDismissalRequestIds(otherSite, localStorage)).toEqual([first]);
  expect(localStorage.getItem("unrelated")).toBe("keep");
});
it.each([{ version: 2 }, { userId: "other" }, { siteId: "other" }, { clientRequestId: second }, { token: "forbidden" }])("rejects corrupted version and scope records", corruption => {
  storePendingDismissalRequest(scope, first, localStorage);
  const key = localStorage.key(0)!;
  localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)!), ...corruption }));
  expect(() => listPendingDismissalRequestIds(scope, localStorage)).toThrow();
});
it("rejects invalid UUIDs and propagates a failed durable write", () => {
  expect(() => storePendingDismissalRequest(scope, "invalid", localStorage)).toThrow();
  expect(() => listPendingDismissalRequestIds({ ...scope, userId: "invalid" }, localStorage)).toThrow();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => storePendingDismissalRequest(scope, first, localStorage)).toThrow("quota");
  expect(localStorage.length).toBe(0);
});
