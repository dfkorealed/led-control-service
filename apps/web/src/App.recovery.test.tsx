import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import * as reactQuery from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRoot as App } from "./AppRoot";
import { authMeQueryKey } from "./api/principal-cache";
import { activeCommandStorageKey } from "./features/control/active-command-store";

const user = { id: "operator-new", organizationId: "provider-new", organizationType: "service_provider", loginId: "operator_new", name: "운영자", role: "operator", status: "active", mustChangePassword: false };
let client: QueryClient;
let requests: string[];
const response = (status: number, body: unknown = { message: "secret-tenant-url-stack" }) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Observe the real provider's active client so assertions follow production client rotation.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, QueryClientProvider: (props: reactQuery.QueryClientProviderProps) => {
    client = props.client;
    return <actual.QueryClientProvider {...props} />;
  } };
});

function mount(authResponse: () => Promise<Response>, logoutResponse?: (init?: RequestInit) => Promise<Response>) {
  let loggedIn = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url === "/api/auth/me") return loggedIn ? response(200, { user }) : authResponse();
    if (url === "/api/auth/login") { loggedIn = true; return response(200, { user }); }
    if (url === "/api/auth/logout") return logoutResponse ? logoutResponse(init) : response(503);
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
afterEach(() => { cleanup(); client.clear(); sessionStorage.clear(); onlineManager.setOnline(true); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("app auth recovery (real client and shells)", () => {
  it("catches initial pending/paused auth becoming a zero-request login instead of offline recovery", async () => {
    onlineManager.setOnline(false);
    mount(async () => response(200, { user }));
    expect(await screen.findByRole("heading", { name: "서비스에 연결할 수 없습니다" })).toHaveFocus();
    expect(requests).toEqual([]);
    expect(screen.queryByRole("heading", { name: "킨다 로그인" })).not.toBeInTheDocument();
    await act(async () => { onlineManager.setOnline(true); });
    expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    expect(requests.filter((path) => path === "/api/auth/me")).toHaveLength(1);
  });

  it("catches an old mutation callback repopulating the active client after 403/relogin/different principal", async () => {
    let forbidden = false;
    mount(async () => forbidden ? response(403) : response(200, { user: { ...user, id: "old-user", organizationId: "old-organization" } }));
    await screen.findByRole("heading", { name: "현장 관리자 계정" });
    const oldClient = client;
    let resolveMutation!: () => void;
    const mutation = oldClient.getMutationCache().build(oldClient, {
      mutationFn: () => new Promise<void>((resolve) => { resolveMutation = resolve; }),
      onSuccess: () => { oldClient.setQueryData(["dashboard", "old-site"], { secret: "old-tenant-data" }); }
    });
    let pending!: Promise<void>;
    await act(async () => { pending = mutation.execute(undefined); });
    forbidden = true;
    await act(async () => { await oldClient.invalidateQueries({ queryKey: authMeQueryKey }); });
    await screen.findByRole("heading", { name: "다시 로그인이 필요합니다" });
    fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
    await screen.findByRole("heading", { name: "킨다 로그인" });
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: user.loginId } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "new-password" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    await screen.findByRole("heading", { name: "현장 관리자 계정" });
    await act(async () => { resolveMutation(); await pending; });
    expect(client.getQueryData(["dashboard", "old-site"])).toBeUndefined();
    expect(client.getQueryData(authMeQueryKey)).toMatchObject({ user: { id: "operator-new", organizationId: "provider-new" } });
    expect(client).not.toBe(oldClient);
    expect(oldClient.getQueryData(["dashboard", "old-site"])).toEqual({ secret: "old-tenant-data" });
  });

  it("catches App-own hook render failure outside the root boundary and clears the failed session on relogin", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(reactQuery, "useQueryClient").mockImplementation(() => { throw new Error("secret-App-runtime"); });
    const oldClient = client;
    oldClient.setQueryData(["dashboard", "old-site"], { secret: "old-tenant" });
    mount(async () => response(200, { user }));
    expect(await screen.findByRole("heading", { name: "화면을 불러오지 못했습니다" })).toHaveFocus();
    expect(document.body).not.toHaveTextContent("secret-App-runtime");
    fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
    expect(await screen.findByRole("heading", { name: "킨다 로그인" })).toBeVisible();
    expect(client).not.toBe(oldClient);
    expect(client.getQueryData(authMeQueryKey)).toBeNull();
    expect(client.getQueryData(["dashboard", "old-site"])).toBeUndefined();
    expect(requests).toEqual(["/api/auth/logout"]);
  });

  it("catches pre-existing active-command sessions surviving an initial 403 without cached principal", async () => {
    sessionStorage.setItem(activeCommandStorageKey("unknown-old-user", "old-site"), "old-command");
    sessionStorage.setItem("unrelated-preference", "keep");
    mount(async () => response(403));
    await screen.findByRole("heading", { name: "다시 로그인이 필요합니다" });
    expect(sessionStorage.getItem(activeCommandStorageKey("unknown-old-user", "old-site"))).toBeNull();
    expect(sessionStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("catches duplicate recovery logout and premature login before the exact 5000ms abort bound", async () => {
    let logoutSignal: AbortSignal | undefined;
    mount(async () => response(403), (init) => new Promise<Response>((_resolve, reject) => {
      logoutSignal = init?.signal ?? undefined;
      logoutSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    await screen.findByRole("heading", { name: "다시 로그인이 필요합니다" });
    vi.useFakeTimers();
    const relogin = screen.getByRole("button", { name: "다시 로그인" });
    await act(async () => { relogin.click(); relogin.click(); });
    expect(requests.filter((path) => path === "/api/auth/logout")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "킨다 로그인" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(logoutSignal?.aborted).toBe(false);
    expect(screen.queryByRole("heading", { name: "킨다 로그인" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(logoutSignal?.aborted).toBe(true);
    expect(screen.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
    expect(client.getQueryData(authMeQueryKey)).toBeNull();
    expect(requests).not.toContain("/api/auth/login");
  });

  it("catches classifying 401 as transient: one request reaches existing login", async () => {
    mount(async () => response(401));
    expect(await screen.findByRole("heading", { name: "킨다 로그인" })).toBeVisible();
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
    expect(await screen.findByRole("heading", { name: "킨다 로그인" })).toBeVisible();
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
    expect(screen.queryByRole("heading", { name: "킨다 로그인" })).not.toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "킨다 로그인" });
    expect(sessionStorage.getItem(activeCommandStorageKey(user.id, "old-site"))).toBeNull();
    expect(sessionStorage.getItem("unrelated-preference")).toBe("keep");
  });
});
