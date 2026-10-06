import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import type { SiteUserSummary, SiteUsersResponse } from "../../../api/site-users";
import { SiteUsersView } from "./SiteUsersView";

const api = vi.hoisted(() => ({
  useSiteUsers: vi.fn(),
  createSiteUser: vi.fn(),
  updateSiteUser: vi.fn(),
  resetSiteUserPassword: vi.fn(),
  deleteSiteUser: vi.fn()
}));

vi.mock("../../../api/site-users", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../api/site-users")>();
  return { ...original, ...api };
});

const users: SiteUserSummary[] = [
  {
    id: "user-1",
    name: "김현수",
    loginId: "hyunsu.kim",
    accessLevel: "control",
    status: "active",
    lastLoginAt: "2026-09-10T05:32:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-10T06:00:00.000Z"
  },
  {
    id: "user-2",
    name: "야간 당직",
    loginId: "night.viewer",
    accessLevel: "read",
    status: "disabled",
    lastLoginAt: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-10T07:00:00.000Z"
  }
];

let gridWidth = 1200;
const observers = new Map<Element, ResizeObserverCallback>();

describe("SiteUsersView", () => {
  it("resets detail conditions without clearing search or sending mutations", async () => {
    renderView();
    fireEvent.change(screen.getByLabelText("사용자 검색"), { target: { value: "night" } });
    const trigger = screen.getByRole("button", { name: "사용자 목록 상세 필터, 활성 조건 0개" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /권한 필터/ }));
    fireEvent.click(screen.getByRole("option", { name: "조회" }));
    fireEvent.click(screen.getByRole("button", { name: /상태 필터/ }));
    fireEvent.click(screen.getByRole("option", { name: "비활성" }));
    expect(trigger).toHaveAccessibleName("사용자 목록 상세 필터, 활성 조건 2개");
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(screen.getByRole("button", { name: "필터 초기화" })).toBeEnabled();
    expect(screen.getByLabelText("사용자 검색")).toHaveValue("night");
    expect(trigger).toHaveAccessibleName("사용자 목록 상세 필터, 활성 조건 0개");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "사용자 목록" }), { key: "Escape" });
    expect(screen.getByText("야간 당직")).toBeVisible();
    expect(screen.queryByText("김현수")).not.toBeInTheDocument();
    expect(api.updateSiteUser).not.toHaveBeenCalled();
    expect(api.deleteSiteUser).not.toHaveBeenCalled();
  });

  it("does not allow an old row menu to mutate after switching site", async () => {
    const { queryClient, rerender } = renderViewDetails();
    fireEvent.click(screen.getByRole("button", { name: "김현수 작업" }));
    const oldAction = await screen.findByRole("menuitem", { name: "김현수 비활성화" });
    rerender(<QueryClientProvider client={queryClient}><TestRouter><SiteUsersView siteId="site-2" /></TestRouter></QueryClientProvider>);
    fireEvent.click(oldAction);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(api.updateSiteUser).not.toHaveBeenCalled();
    expect(api.deleteSiteUser).not.toHaveBeenCalled();
  });

  it("locks all management entries while status is pending and drops retry after site change", async () => {
    const pending = deferred<SiteUserSummary>();
    api.updateSiteUser.mockReturnValueOnce(pending.promise);
    const { queryClient, rerender } = renderViewDetails();
    await chooseUserAction("김현수", "김현수 비활성화");
    expect(screen.getByRole("button", { name: "사용자 추가" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "야간 당직 작업" })).toBeDisabled();
    rerender(<QueryClientProvider client={queryClient}><TestRouter><SiteUsersView siteId="site-2" /></TestRouter></QueryClientProvider>);
    await act(async () => { pending.reject(new ApiError("changed", 409, { code: "SITE_USER_CHANGED" })); });
    expect(api.updateSiteUser).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "사용자 추가" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  beforeEach(() => {
    gridWidth = 1200;
    observers.clear();
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        observers.set(target, this.callback);
        this.callback([{ target, contentRect: { width: gridWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve(target: Element) { observers.delete(target); }
      disconnect() {}
    });
    vi.clearAllMocks();
    api.createSiteUser.mockResolvedValue(users[0]);
    api.updateSiteUser.mockImplementation(async (_siteId: string, userId: string, input: Record<string, unknown>) => ({
      ...users.find((user) => user.id === userId)!, ...input, updatedAt: "2026-09-11T00:00:00.000Z"
    }));
    api.resetSiteUserPassword.mockResolvedValue({ ok: true });
    api.deleteSiteUser.mockResolvedValue({ ok: true });
    setQuery({ users, count: 2, limit: 100 });
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps every column and management action when container width switches to cards", async () => {
    renderView();
    const table = screen.getByRole("table", { name: "현장 사용자 목록" });
    expect(within(table).getAllByRole("columnheader").every(cell => cell.classList.contains("text-center"))).toBe(true);
    act(() => { for (const [target, callback] of observers) callback([{ target, contentRect: { width: 320 } } as ResizeObserverEntry], {} as ResizeObserver); });
    const cards = screen.getByRole("list", { name: "현장 사용자 목록" });
    expect(cards).toHaveTextContent("hyunsu.kim");
    expect(cards).toHaveTextContent("로그인 기록 없음");
    expect(within(cards).getAllByRole("term")).toHaveLength(12);
    fireEvent.click(within(cards).getByRole("button", { name: "김현수 작업" }));
    expect(await screen.findAllByRole("menuitem")).toHaveLength(4);
    expect(api.updateSiteUser).not.toHaveBeenCalled();
  });

  it.each([
    [new Date(2026, 9, 2, 14, 5, 9).toISOString(), "2026-10-02 14:05:09"],
    [new Date(2026, 9, 2, 0, 0, 0).toISOString(), "2026-10-02 00:00:00"],
    ["invalid-instant", "—"]
  ])("shows last login with seconds in the device timezone and preserves never-login (%s)", (timestamp, expected) => {
    setQuery({ users: [{ ...users[0], lastLoginAt: timestamp }, users[1]], count: 2, limit: 100 });
    renderView();

    const table = screen.getByRole("table", { name: "현장 사용자 목록" });
    expect(within(table).getByText(expected)).toBeVisible();
    expect(within(table).getByText("로그인 기록 없음")).toBeVisible();
    expect(screen.getByRole("button", { name: "김현수 작업" })).toBeVisible();
  });

  it("renders loading, empty and successful list states", () => {
    api.useSiteUsers.mockReturnValueOnce(queryState(undefined, { isLoading: true }));
    renderView();
    expect(screen.getByText("사용자 목록을 불러오는 중입니다.")).toBeVisible();

    cleanup();
    setQuery({ users: [], count: 0, limit: 100 });
    renderView();
    expect(screen.getByText("등록된 사용자가 없습니다.")).toBeVisible();

    cleanup();
    setQuery({ users, count: 2, limit: 100 });
    renderView();
    expect(screen.getByRole("table", { name: "현장 사용자 목록" })).toHaveTextContent("hyunsu.kim");
    expect(screen.getByText("2 / 100명")).toBeVisible();
    expect(screen.getByRole("button", { name: "김현수 작업" })).toHaveClass("min-h-13", "min-w-13");
  });

  it("keeps stale rows visible when a background refresh fails and supports retry", () => {
    const refetch = vi.fn();
    api.useSiteUsers.mockReturnValue(queryState({ users, count: 2, limit: 100 }, {
      error: new Error("network"), isRefetchError: true, refetch
    }));
    renderView();

    expect(screen.getByText("hyunsu.kim")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "사용자 목록 재조회 실패 안내" }));
    const detail = screen.getByRole("dialog", { name: "사용자 목록 재조회 실패 안내" });
    expect(detail).toHaveTextContent("최신 사용자 목록을 불러오지 못했습니다");
    fireEvent.click(within(detail).getByRole("button", { name: "목록 다시 시도" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("searches by name or login id and filters access and status", async () => {
    renderView();

    fireEvent.change(screen.getByLabelText("사용자 검색"), { target: { value: "night.viewer" } });
    expect(screen.getByText("야간 당직")).toBeVisible();
    expect(screen.queryByText("김현수")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("사용자 검색"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /사용자 목록 상세 필터/ }));
    fireEvent.click(screen.getByRole("button", { name: /권한 필터/ }));
    fireEvent.click(screen.getByRole("option", { name: "제어" }));
    expect(screen.getByText("김현수")).toBeVisible();
    expect(screen.queryByText("야간 당직")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /권한 필터/ }));
    fireEvent.click(screen.getByRole("option", { name: "모든 권한" }));
    fireEvent.click(screen.getByRole("button", { name: /상태 필터/ }));
    fireEvent.click(screen.getByRole("option", { name: "비활성" }));
    expect(screen.getByText("야간 당직")).toBeVisible();
  });

  it("keeps mobile keyboard correction off for login ID without disabling Korean name input", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog", { name: "사용자 추가" });
    const login = within(dialog).getByLabelText("로그인 아이디");
    expect(login).toHaveAttribute("autocapitalize", "none");
    expect(login).toHaveAttribute("autocorrect", "off");
    expect(login).toHaveAttribute("spellcheck", "false");
    expect(within(dialog).getByLabelText("이름")).not.toHaveAttribute("autocapitalize", "none");
  });

  it("validates creation, sends the selected control permission and never re-shows the password", async () => {
    const queryClient = renderView();
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog", { name: "사용자 추가" });

    fireEvent.click(within(dialog).getByRole("button", { name: "사용자 생성" }));
    expect(await within(dialog).findByText("이름을 입력하세요.")).toBeVisible();
    expect(api.createSiteUser).not.toHaveBeenCalled();

    fillProfile(dialog, { name: "새 사용자", loginId: "new.user", password: "Temporary-123" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "제어" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "사용자 생성" }));

    await waitFor(() => expect(api.createSiteUser).toHaveBeenCalledWith("site-1", {
      name: "새 사용자",
      loginId: "new.user",
      temporaryPassword: "Temporary-123",
      accessLevel: "control",
      status: "active"
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText("Temporary-123")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Temporary-123")).not.toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("updates profile with optimistic concurrency data and never renders a password field", async () => {
    renderView();
    await chooseUserAction("김현수", "김현수 수정");
    const dialog = screen.getByRole("dialog", { name: "김현수 사용자 수정" });
    expect(within(dialog).queryByLabelText(/비밀번호/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("이름"), { target: { value: "김수정" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "조회" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "변경사항 저장" }));

    await waitFor(() => expect(api.updateSiteUser).toHaveBeenCalledWith("site-1", "user-1", {
      name: "김수정",
      loginId: "hyunsu.kim",
      accessLevel: "read",
      status: "active",
      expectedUpdatedAt: users[0].updatedAt
    }));
  });

  it("resets a password only after confirmation and explains session revocation", async () => {
    const queryClient = renderView();
    await chooseUserAction("김현수", "김현수 비밀번호 초기화");
    const dialog = screen.getByRole("dialog", { name: "김현수 비밀번호 초기화" });
    expect(dialog).toHaveTextContent("모든 로그인 세션이 종료");

    fireEvent.change(within(dialog).getByLabelText("새 임시 비밀번호"), { target: { value: "Reset-pass-123" } });
    fireEvent.change(within(dialog).getByLabelText("임시 비밀번호 확인"), { target: { value: "different" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 초기화" }));
    expect(await within(dialog).findByText("임시 비밀번호 확인이 일치하지 않습니다.")).toBeVisible();
    expect(api.resetSiteUserPassword).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("임시 비밀번호 확인"), { target: { value: "Reset-pass-123" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 초기화" }));
    await waitFor(() => expect(api.resetSiteUserPassword).toHaveBeenCalledWith("site-1", "user-1", "Reset-pass-123"));
    expect(await screen.findByText("비밀번호를 초기화했습니다. 사용자의 기존 세션이 종료되었습니다.")).toBeVisible();
    expect(screen.queryByDisplayValue("Reset-pass-123")).not.toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("disables and re-enables a user through the profile update contract", async () => {
    renderView();
    await chooseUserAction("김현수", "김현수 비활성화");
    await waitFor(() => expect(api.updateSiteUser).toHaveBeenCalledWith("site-1", "user-1", {
      name: "김현수",
      loginId: "hyunsu.kim",
      accessLevel: "control",
      status: "disabled",
      expectedUpdatedAt: users[0].updatedAt
    }));

    await chooseUserAction("야간 당직", "야간 당직 활성화");
    await waitFor(() => expect(api.updateSiteUser).toHaveBeenCalledWith("site-1", "user-2", expect.objectContaining({ status: "active" })));
  });

  it("retries a status change once with the latest profile after an optimistic conflict", async () => {
    const latest = {
      ...users[0],
      name: "로그인 후 최신 이름",
      accessLevel: "read" as const,
      updatedAt: "2026-09-11T01:00:00.000Z"
    };
    const refetch = vi.fn().mockResolvedValue({ data: { users: [latest, users[1]], count: 2, limit: 100 }, error: null });
    api.useSiteUsers.mockReturnValue(queryState({ users, count: 2, limit: 100 }, { refetch }));
    api.updateSiteUser
      .mockRejectedValueOnce(new ApiError("changed", 409, { code: "SITE_USER_CHANGED" }))
      .mockResolvedValueOnce({ ...latest, status: "disabled" });
    renderView();

    await chooseUserAction("김현수", "김현수 비활성화");

    await waitFor(() => expect(api.updateSiteUser).toHaveBeenCalledTimes(2));
    expect(api.updateSiteUser).toHaveBeenNthCalledWith(2, "site-1", "user-1", {
      name: latest.name,
      loginId: latest.loginId,
      accessLevel: latest.accessLevel,
      status: "disabled",
      expectedUpdatedAt: latest.updatedAt
    });
  });

  it("enables permanent deletion only after the exact current login id is entered", async () => {
    renderView();
    await chooseUserAction("야간 당직", "야간 당직 영구 삭제");
    const dialog = screen.getByRole("alertdialog", { name: "야간 당직 사용자 영구 삭제" });
    const confirm = within(dialog).getByRole("button", { name: "영구 삭제" });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("확인 로그인 아이디"), { target: { value: "NIGHT.VIEWER" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("확인 로그인 아이디"), { target: { value: "night.viewer" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(api.deleteSiteUser).toHaveBeenCalledWith("site-1", "user-2", "night.viewer"));
    expect(screen.queryByText("night.viewer", { selector: "input" })).not.toBeInTheDocument();
  });

  it("disables creation at 100 users and maps duplicate login errors to Korean", async () => {
    setQuery({ users, count: 100, limit: 100 });
    renderView();
    expect(screen.getByRole("button", { name: "사용자 추가" })).toBeDisabled();
    const limitNotice = screen.getByRole("button", { name: "사용자 등록 한도 안내" });
    expect(limitNotice).toBeVisible();
    fireEvent.click(limitNotice);
    expect(within(screen.getByRole("dialog", { name: "사용자 등록 한도 안내" })).getByText("현장 사용자는 최대 100명까지 등록할 수 있습니다.")).toBeVisible();

    api.createSiteUser.mockRejectedValueOnce(new ApiError("conflict", 409, { code: "LOGIN_ID_ALREADY_EXISTS" }));
    cleanup();
    setQuery({ users, count: 2, limit: 100 });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog", { name: "사용자 추가" });
    fillProfile(dialog, { name: "중복 사용자", loginId: "hyunsu.kim", password: "Temporary-123" });
    fireEvent.click(within(dialog).getByRole("button", { name: "사용자 생성" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("이미 사용 중인 로그인 아이디입니다.");
  });

  it("locks further creation when the server reports a concurrent 100-user limit", async () => {
    api.createSiteUser.mockRejectedValueOnce(new ApiError("limit", 409, { code: "USER_LIMIT_REACHED" }));
    const state = queryState({ users, count: 2, limit: 100 });
    api.useSiteUsers.mockReturnValue(state);
    const { queryClient, rerender } = renderViewDetails();
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog", { name: "사용자 추가" });
    fillProfile(dialog, { name: "마지막 사용자", loginId: "last.user", password: "Temporary-123" });
    fireEvent.click(within(dialog).getByRole("button", { name: "사용자 생성" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("현장 사용자는 최대 100명까지 등록할 수 있습니다.");
    expect(within(dialog).getByRole("button", { name: "사용자 생성" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.getByRole("button", { name: "사용자 추가" })).toBeDisabled();

    state.data = { users, count: 2, limit: 100 };
    rerender(<QueryClientProvider client={queryClient}><TestRouter><SiteUsersView siteId="site-1" /></TestRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "사용자 추가" })).toBeEnabled());
  });

  it("removes deleted PII from cache before a failed background refresh and releases the limit latch", async () => {
    api.createSiteUser.mockRejectedValueOnce(new ApiError("limit", 409, { code: "USER_LIMIT_REACHED" }));
    const state = queryState({ users, count: 99, limit: 100 });
    api.useSiteUsers.mockReturnValue(state);
    const { queryClient, rerender } = renderViewDetails();
    queryClient.setQueryData(["site-users", "site-1"], { users, count: 100, limit: 100 });
    vi.spyOn(queryClient, "invalidateQueries").mockRejectedValueOnce(new Error("refresh failed"));

    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const createDialog = screen.getByRole("dialog");
    fillProfile(createDialog, { name: "마지막 사용자", loginId: "last.user", password: "Temporary-123" });
    fireEvent.click(within(createDialog).getByRole("button", { name: "사용자 생성" }));
    expect(await within(createDialog).findByRole("alert")).toHaveTextContent("최대 100명");
    fireEvent.click(within(createDialog).getByRole("button", { name: "취소" }));
    expect(screen.getByRole("button", { name: "사용자 추가" })).toBeDisabled();
    await chooseUserAction("야간 당직", "야간 당직 영구 삭제");
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("확인 로그인 아이디"), { target: { value: "night.viewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    const cached = queryClient.getQueryData<SiteUsersResponse>(["site-users", "site-1"]);
    expect(cached).toMatchObject({ count: 99 });
    expect(JSON.stringify(cached)).not.toContain("night.viewer");
    expect(JSON.stringify(cached)).not.toContain("야간 당직");
    fireEvent.click(await screen.findByRole("button", { name: "사용자 목록 갱신 실패 안내" }));
    const refreshDetail = screen.getByRole("dialog", { name: "사용자 목록 갱신 실패 안내" });
    expect(refreshDetail).toHaveTextContent("최신 사용자 목록을 불러오지 못했습니다");
    fireEvent.keyDown(refreshDetail, { key: "Escape" });
    expect(screen.getByRole("button", { name: "사용자 추가" })).toBeEnabled();

    state.data = { users: [users[0]], count: 99, limit: 100 };
    rerender(<QueryClientProvider client={queryClient}><TestRouter><SiteUsersView siteId="site-1" /></TestRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "사용자 추가" })).toBeEnabled());
  });

  it("refetches and closes a stale edit dialog after SITE_USER_CHANGED", async () => {
    const refetch = vi.fn().mockResolvedValue({ data: { users, count: 2, limit: 100 } });
    api.useSiteUsers.mockReturnValue(queryState({ users, count: 2, limit: 100 }, { refetch }));
    api.updateSiteUser.mockRejectedValueOnce(new ApiError("changed", 409, { code: "SITE_USER_CHANGED" }));
    renderView();
    await chooseUserAction("김현수", "김현수 수정");
    fireEvent.click(screen.getByRole("button", { name: "변경사항 저장" }));

    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("다른 관리자가 먼저 수정했습니다");
  });

  it("refetches a missing status target and prevents a second stale submission", async () => {
    const refetch = vi.fn().mockResolvedValue({ data: { users: [users[0]], count: 1, limit: 100 } });
    api.useSiteUsers.mockReturnValue(queryState({ users, count: 2, limit: 100 }, { refetch }));
    api.updateSiteUser.mockRejectedValueOnce(new ApiError("missing", 404, { code: "SITE_USER_NOT_FOUND" }));
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "야간 당직 작업" }));
    const button = await screen.findByRole("menuitem", { name: "야간 당직 활성화" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(api.updateSiteUser).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("대상 사용자가 이미 삭제되었습니다");
  });

  it("uses the same stale-data recovery for password reset and permanent deletion", async () => {
    const refetch = vi.fn().mockResolvedValue({ data: { users, count: 2, limit: 100 } });
    api.useSiteUsers.mockReturnValue(queryState({ users, count: 2, limit: 100 }, { refetch }));
    api.resetSiteUserPassword.mockRejectedValueOnce(new ApiError("missing", 404, { code: "SITE_USER_NOT_FOUND" }));
    renderView();

    await chooseUserAction("김현수", "김현수 비밀번호 초기화");
    let dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("새 임시 비밀번호"), { target: { value: "Reset-pass-123" } });
    fireEvent.change(within(dialog).getByLabelText("임시 비밀번호 확인"), { target: { value: "Reset-pass-123" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 초기화" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    api.deleteSiteUser.mockRejectedValueOnce(new ApiError("changed", 409, { code: "SITE_USER_CHANGED" }));
    await chooseUserAction("야간 당직", "야간 당직 영구 삭제");
    dialog = screen.getByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("확인 로그인 아이디"), { target: { value: "night.viewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("navigates away with replace when site management capability is revoked", async () => {
    api.createSiteUser.mockRejectedValueOnce(new ApiError("denied", 403, { code: "SITE_CAPABILITY_DENIED" }));
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog");
    fillProfile(dialog, { name: "새 사용자", loginId: "new.user", password: "Temporary-123" });
    fireEvent.click(within(dialog).getByRole("button", { name: "사용자 생성" }));

    await waitFor(() => expect(screen.getByTestId("test-location")).toHaveTextContent("/settings?siteId=site-1"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes after a successful mutation even when invalidate fails and blocks rapid duplicate submission", async () => {
    const pending = deferred<SiteUserSummary>();
    api.createSiteUser.mockReturnValueOnce(pending.promise);
    const { queryClient } = renderViewDetails();
    vi.spyOn(queryClient, "invalidateQueries").mockRejectedValueOnce(new Error("refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog");
    fillProfile(dialog, { name: "새 사용자", loginId: "new.user", password: "Temporary-123" });
    const submit = within(dialog).getByRole("button", { name: "사용자 생성" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(api.createSiteUser).toHaveBeenCalledTimes(1);

    pending.resolve(users[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.createSiteUser).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole("button", { name: "사용자 목록 갱신 실패 안내" }));
    expect(screen.getByRole("dialog", { name: "사용자 목록 갱신 실패 안내" })).toHaveTextContent("최신 사용자 목록을 불러오지 못했습니다");
  });

  it("rejects whitespace-only and overlong reset passwords without an API call", async () => {
    renderView();
    await chooseUserAction("김현수", "김현수 비밀번호 초기화");
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("새 임시 비밀번호"), { target: { value: "        " } });
    fireEvent.change(within(dialog).getByLabelText("임시 비밀번호 확인"), { target: { value: "        " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 초기화" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("공백만 사용할 수 없습니다");
    expect(api.resetSiteUserPassword).not.toHaveBeenCalled();
  });
});

function setQuery(data: SiteUsersResponse) {
  api.useSiteUsers.mockReturnValue(queryState(data));
}

function queryState(data?: SiteUsersResponse, overrides: Record<string, unknown> = {}) {
  return {
    data,
    isLoading: false,
    error: null,
    isRefetchError: false,
    refetch: vi.fn(),
    ...overrides
  };
}

function renderView() {
  return renderViewDetails().queryClient;
}

function renderViewDetails() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(<QueryClientProvider client={queryClient}><TestRouter><SiteUsersView siteId="site-1" /></TestRouter></QueryClientProvider>);
  return { queryClient, ...result };
}

function TestRouter({ children }: { children: React.ReactNode }) {
  return <MemoryRouter initialEntries={["/settings/users?siteId=site-1"]}>{children}<LocationProbe /></MemoryRouter>;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="test-location">{`${location.pathname}${location.search}`}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fillProfile(dialog: HTMLElement, values: { name: string; loginId: string; password: string }) {
  fireEvent.change(within(dialog).getByLabelText("이름"), { target: { value: values.name } });
  fireEvent.change(within(dialog).getByLabelText("로그인 아이디"), { target: { value: values.loginId } });
  fireEvent.change(within(dialog).getByLabelText("임시 비밀번호"), { target: { value: values.password } });
}

async function chooseUserAction(name: string, label: string) {
  fireEvent.click(screen.getByRole("button", { name: `${name} 작업` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}
