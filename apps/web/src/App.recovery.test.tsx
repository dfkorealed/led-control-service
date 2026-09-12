import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { authMeQueryKey } from "./api/principal-cache";
import { activeCommandStorageKey } from "./features/control/active-command-store";

const user = { id: "operator-new", organizationId: "provider-new", organizationType: "service_provider", loginId: "operator_new", name: "운영자", role: "operator", status: "active", mustChangePassword: false };
let client: QueryClient;
let requests: string[];
const response = (status: number, body: unknown = { message: "secret-tenant-url-stack" }) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mount(authResponse: () => Promise<Response>) {
  let loggedIn = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    if (url === "/api/auth/me") return loggedIn ? response(200, { user }) : authResponse();
    if (url === "/api/auth/login") { loggedIn = true; return response(200, { user }); }
    if (url === "/api/auth/logout") return response(503);
    if (url === "/api/operator/site-admins") return response(200, []);
    return response(404);
  }));
  render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } } });
  requests = [];
  window.history.replaceState({}, "", "/operator/site-admins");
});
afterEach(() => { cleanup(); client.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("app auth recovery (real client and shells)", () => {
  it("catches classifying 401 as transient: one request reaches existing login", async () => {
    mount(async () => response(401));
    expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeVisible();
    expect(requests).toEqual(["/api/auth/me"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([403, 400, 429])("catches %s becoming login or retry: clears tenant data and requires explicit relogin even if logout fails", async (status) => {
    client.setQueryData(["dashboard", "old"], { secret: "old-tenant" });
    client.setQueryData(["auth", "other-session"], { secret: "old-session" });
    mount(async () => response(status));
    expect(await screen.findByRole("heading", { name: "다시 로그인이 필요합니다" })).toHaveFocus();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret-tenant-url-stack");
    expect(screen.queryByRole("heading", { name: "현장 관리자 계정" })).not.toBeInTheDocument();
    expect(client.getQueryData(["dashboard", "old"])).toBeUndefined();
    expect(requests).toEqual(["/api/auth/me"]);
    fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
    expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeVisible();
    expect(client.getQueryData(["auth", "other-session"])).toBeUndefined();
    expect(client.getQueryData(authMeQueryKey)).toBeNull();
    expect(requests).toEqual(["/api/auth/me", "/api/auth/logout"]);
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: "operator_new" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toMatch(/old-tenant|old-session/);
  });

  it.each(["network", "timeout", "503"])("catches missing/unbounded %s retries: exactly two retries then manual success", async (failure) => {
    let available = false;
    mount(async () => {
      if (available) return response(200, { user });
      if (failure === "network") throw new TypeError("secret-tenant-url-stack");
      if (failure === "timeout") throw new DOMException("secret-tenant-url-stack", "TimeoutError");
      return response(503);
    });
    expect(await screen.findByRole("heading", { name: "서비스에 연결할 수 없습니다" })).toHaveFocus();
    expect(requests).toEqual(["/api/auth/me", "/api/auth/me", "/api/auth/me"]);
    expect(screen.queryByRole("heading", { name: "LED Control 로그인" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret-tenant-url-stack");
    client.setQueryData(["dashboard", "old"], { secret: "old-tenant" });
    available = true;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    expect(requests.filter((path) => path === "/api/auth/me")).toHaveLength(4);
    expect(client.getQueryData(["dashboard", "old"])).toBeUndefined();
  });

  it("catches treating parse errors as network errors: no retry and safe relogin", async () => {
    mount(async () => new Response("invalid-json-secret", { status: 200 }));
    expect(await screen.findByRole("heading", { name: "다시 로그인이 필요합니다" })).toBeVisible();
    expect(requests).toEqual(["/api/auth/me"]);
    expect(document.body).not.toHaveTextContent("invalid-json-secret");
  });

  it("catches discarding successful automatic retries before the operator shell", async () => {
    let attempt = 0;
    mount(async () => ++attempt === 1 ? response(503) : response(200, { user }));
    expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    expect(requests.filter((path) => path === "/api/auth/me")).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("catches stale authenticated data winning over a later 403", async () => {
    let forbidden = false;
    mount(async () => forbidden ? response(403) : response(200, { user }));
    await screen.findByRole("heading", { name: "현장 관리자 계정" });
    sessionStorage.setItem(activeCommandStorageKey(user.id, "old-site"), "old-command");
    sessionStorage.setItem("unrelated-preference", "keep");
    client.setQueryData(["dashboard", "old"], { secret: "old-tenant" });
    forbidden = true;
    await act(async () => { await client.invalidateQueries({ queryKey: authMeQueryKey }); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "다시 로그인이 필요합니다" })).toHaveFocus());
    expect(screen.queryByRole("heading", { name: "현장 관리자 계정" })).not.toBeInTheDocument();
    expect(client.getQueryData(["dashboard", "old"])).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
    await screen.findByRole("heading", { name: "LED Control 로그인" });
    expect(sessionStorage.getItem(activeCommandStorageKey(user.id, "old-site"))).toBeNull();
    expect(sessionStorage.getItem("unrelated-preference")).toBe("keep");
  });
});
