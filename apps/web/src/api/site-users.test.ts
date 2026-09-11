import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSiteUser,
  deleteSiteUser,
  listSiteUsers,
  resetSiteUserPassword,
  siteUsersQueryKey,
  updateSiteUser,
  useSiteUsers
} from "./site-users";

const client = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn()
}));

vi.mock("./client", () => client);

describe("site users API", () => {
  afterEach(() => vi.clearAllMocks());

  it("uses the site-scoped CRUD endpoints and bodies", async () => {
    client.apiGet.mockResolvedValue({ users: [], count: 0, limit: 100 });
    client.apiPost.mockResolvedValue({ id: "user-1" });
    client.apiPatch.mockResolvedValue({ id: "user-1" });
    client.apiDelete.mockResolvedValue({ ok: true });

    const createInput = {
      name: "조회 사용자",
      loginId: "viewer.one",
      temporaryPassword: "Temporary-1234",
      accessLevel: "read" as const,
      status: "active" as const
    };
    const updateInput = {
      name: "제어 사용자",
      loginId: "control.one",
      accessLevel: "control" as const,
      status: "disabled" as const,
      expectedUpdatedAt: "2026-09-10T01:00:00.000Z"
    };

    await listSiteUsers("site / 1");
    await createSiteUser("site / 1", createInput);
    await updateSiteUser("site / 1", "user / 1", updateInput);
    await resetSiteUserPassword("site / 1", "user / 1", "Reset-Password-1234");
    await deleteSiteUser("site / 1", "user / 1", "control.one");

    expect(client.apiGet).toHaveBeenCalledWith("/sites/site%20%2F%201/users");
    expect(client.apiPost).toHaveBeenNthCalledWith(1, "/sites/site%20%2F%201/users", createInput);
    expect(client.apiPatch).toHaveBeenCalledWith("/sites/site%20%2F%201/users/user%20%2F%201", updateInput);
    expect(client.apiPost).toHaveBeenNthCalledWith(
      2,
      "/sites/site%20%2F%201/users/user%20%2F%201/reset-password",
      { temporaryPassword: "Reset-Password-1234" }
    );
    expect(client.apiDelete).toHaveBeenCalledWith(
      "/sites/site%20%2F%201/users/user%20%2F%201",
      { confirmationLoginId: "control.one" }
    );
  });

  it("stores only password-free summaries in the React Query cache", async () => {
    client.apiGet.mockResolvedValue({
      users: [{
        id: "user-1",
        name: "조회 사용자",
        loginId: "viewer.one",
        accessLevel: "read",
        status: "active",
        lastLoginAt: null,
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z"
      }],
      count: 1,
      limit: 100
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSiteUsers("site-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(siteUsersQueryKey("site-1")).toEqual(["site-users", "site-1"]);
    expect(JSON.stringify(queryClient.getQueryData(siteUsersQueryKey("site-1")))).not.toMatch(/password/i);
  });

  it("does not query until a site is selected", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, children);

    renderHook(() => useSiteUsers(undefined), { wrapper });

    expect(client.apiGet).not.toHaveBeenCalled();
  });
});
