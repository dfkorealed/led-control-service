import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("SiteUsersView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createSiteUser.mockResolvedValue(users[0]);
    api.updateSiteUser.mockImplementation(async (_siteId: string, userId: string, input: Record<string, unknown>) => ({
      ...users.find((user) => user.id === userId)!, ...input, updatedAt: "2026-09-11T00:00:00.000Z"
    }));
    api.resetSiteUserPassword.mockResolvedValue({ ok: true });
    api.deleteSiteUser.mockResolvedValue({ ok: true });
    setQuery({ users, count: 2, limit: 100 });
  });

  afterEach(cleanup);

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
  });

  it("keeps stale rows visible when a background refresh fails and supports retry", () => {
    const refetch = vi.fn();
    api.useSiteUsers.mockReturnValue(queryState({ users, count: 2, limit: 100 }, {
      error: new Error("network"), isRefetchError: true, refetch
    }));
    renderView();

    expect(screen.getByText("hyunsu.kim")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("최신 사용자 목록을 불러오지 못했습니다");
    fireEvent.click(screen.getByRole("button", { name: "목록 다시 시도" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("searches by name or login id and filters access and status", () => {
    renderView();

    fireEvent.change(screen.getByLabelText("사용자 검색"), { target: { value: "night.viewer" } });
    expect(screen.getByText("야간 당직")).toBeVisible();
    expect(screen.queryByText("김현수")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("사용자 검색"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("권한 필터"), { target: { value: "control" } });
    expect(screen.getByText("김현수")).toBeVisible();
    expect(screen.queryByText("야간 당직")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("권한 필터"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("상태 필터"), { target: { value: "disabled" } });
    expect(screen.getByText("야간 당직")).toBeVisible();
  });

  it("validates creation, sends the selected control permission and never re-shows the password", async () => {
    const queryClient = renderView();
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog", { name: "사용자 추가" });

    fireEvent.click(within(dialog).getByRole("button", { name: "사용자 생성" }));
    expect(await within(dialog).findByText("이름을 입력하세요.")).toBeVisible();
    expect(api.createSiteUser).not.toHaveBeenCalled();

    fillProfile(dialog, { name: "새 사용자", loginId: "new.user", password: "Temporary-123" });
    fireEvent.click(within(dialog).getByRole("button", { name: "제어" }));
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
    fireEvent.click(screen.getByRole("button", { name: "김현수 수정" }));
    const dialog = screen.getByRole("dialog", { name: "김현수 사용자 수정" });
    expect(within(dialog).queryByLabelText(/비밀번호/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("이름"), { target: { value: "김수정" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "조회" }));
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
    fireEvent.click(screen.getByRole("button", { name: "김현수 비밀번호 초기화" }));
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
    fireEvent.click(screen.getByRole("button", { name: "김현수 비활성화" }));
    await waitFor(() => expect(api.updateSiteUser).toHaveBeenCalledWith("site-1", "user-1", {
      name: "김현수",
      loginId: "hyunsu.kim",
      accessLevel: "control",
      status: "disabled",
      expectedUpdatedAt: users[0].updatedAt
    }));

    fireEvent.click(screen.getByRole("button", { name: "야간 당직 활성화" }));
    await waitFor(() => expect(api.updateSiteUser).toHaveBeenCalledWith("site-1", "user-2", expect.objectContaining({ status: "active" })));
  });

  it("enables permanent deletion only after the exact current login id is entered", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "야간 당직 영구 삭제" }));
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
    expect(screen.getByText("현장 사용자는 최대 100명까지 등록할 수 있습니다.")).toBeVisible();

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
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "사용자 추가" }));
    const dialog = screen.getByRole("dialog", { name: "사용자 추가" });
    fillProfile(dialog, { name: "마지막 사용자", loginId: "last.user", password: "Temporary-123" });
    fireEvent.click(within(dialog).getByRole("button", { name: "사용자 생성" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("현장 사용자는 최대 100명까지 등록할 수 있습니다.");
    expect(within(dialog).getByRole("button", { name: "사용자 생성" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.getByRole("button", { name: "사용자 추가" })).toBeDisabled();
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><SiteUsersView siteId="site-1" /></QueryClientProvider>);
  return queryClient;
}

function fillProfile(dialog: HTMLElement, values: { name: string; loginId: string; password: string }) {
  fireEvent.change(within(dialog).getByLabelText("이름"), { target: { value: values.name } });
  fireEvent.change(within(dialog).getByLabelText("로그인 아이디"), { target: { value: values.loginId } });
  fireEvent.change(within(dialog).getByLabelText("임시 비밀번호"), { target: { value: values.password } });
}
