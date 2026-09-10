import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changePassword, logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, replacePrincipalCache } from "../../api/principal-cache";
import { activeCommandStorageKey, saveActiveCommandId } from "../control/active-command-store";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { RequiredPasswordChangeView } from "./RequiredPasswordChangeView";

vi.mock("../../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/auth")>();
  return { ...actual, changePassword: vi.fn(), logout: vi.fn() };
});

const changePasswordMock = vi.mocked(changePassword);
const logoutMock = vi.mocked(logout);
const pendingUser: AuthUser = {
  id: "user-pending",
  organizationId: "organization-1",
  organizationType: "customer",
  loginId: "viewer_01",
  name: "조회 사용자",
  role: "viewer",
  status: "active",
  mustChangePassword: true
};
const changedUser: AuthUser = { ...pendingUser, mustChangePassword: false };

function renderView(queryClient = new QueryClient()) {
  const onAuthenticated = vi.fn(async (auth: { user: AuthUser }) => {
    await replacePrincipalCache(queryClient, auth);
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RequiredPasswordChangeView user={pendingUser} onAuthenticated={onAuthenticated} />
    </QueryClientProvider>
  );
  return { ...result, queryClient, onAuthenticated };
}

function fillPasswords(currentPassword = "temporary-password", newPassword = "new-password") {
  fireEvent.change(screen.getByLabelText("현재 임시 비밀번호"), { target: { value: currentPassword } });
  fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: newPassword } });
  fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: newPassword } });
}

describe("RequiredPasswordChangeView", () => {
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    useFloorEditorStore.getState().reset();
    vi.clearAllMocks();
  });

  it.each([
    ["현재 비밀번호 누락", "", "new-password", "현재 임시 비밀번호를 입력하세요."],
    ["8자 미만", "temporary-password", "short", "새 비밀번호는 8자 이상 1024자 이하이며 공백만 사용할 수 없습니다."],
    ["공백만 입력", "temporary-password", "        ", "새 비밀번호는 8자 이상 1024자 이하이며 공백만 사용할 수 없습니다."],
    ["1024자 초과", "temporary-password", "a".repeat(1025), "새 비밀번호는 8자 이상 1024자 이하이며 공백만 사용할 수 없습니다."]
  ])("%s를 API 요청 전에 차단한다", (_case, currentPassword, newPassword, message) => {
    renderView();
    fillPasswords(currentPassword, newPassword);
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(changePasswordMock).not.toHaveBeenCalled();
  });

  it("새 비밀번호 확인 불일치를 API 요청 전에 차단한다", () => {
    renderView();
    fillPasswords();
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "different-password" } });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    expect(screen.getByRole("alert")).toHaveTextContent("새 비밀번호 확인이 일치하지 않습니다.");
    expect(changePasswordMock).not.toHaveBeenCalled();
  });

  it("성공 응답의 user로 principal cache를 교체하고 tenant 평문·편집기·활성 명령 상태를 정리한다", async () => {
    changePasswordMock.mockResolvedValue({ ok: true, user: changedUser });
    const queryClient = new QueryClient();
    queryClient.setQueryData(["dashboard", "site-1"], { secret: "tenant-data" });
    saveActiveCommandId(pendingUser.id, "site-1", "00000000-0000-4000-8000-000000000001");
    useFloorEditorStore.setState({ isDirty: true });
    const { onAuthenticated } = renderView(queryClient);
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith({ user: changedUser }));
    expect(queryClient.getQueryData(authMeQueryKey)).toEqual({ user: changedUser });
    expect(queryClient.getQueryData(["dashboard", "site-1"])).toBeUndefined();
    expect(sessionStorage.getItem(activeCommandStorageKey(pendingUser.id, "site-1"))).toBeNull();
    expect(useFloorEditorStore.getState().isDirty).toBe(false);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain("temporary-password");
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain("new-password");
  });

  it("실패하면 세 입력을 모두 지우고 첫 입력에 focus한 뒤 재시도할 수 있다", async () => {
    changePasswordMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true, user: changedUser });
    const { onAuthenticated } = renderView();
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("비밀번호를 변경하지 못했습니다. 다시 시도해 주세요.");
    expect(screen.getByLabelText("현재 임시 비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("새 비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("새 비밀번호 확인")).toHaveValue("");
    expect(screen.getByLabelText("현재 임시 비밀번호")).toHaveFocus();

    fillPasswords("temporary-password-2", "new-password-2");
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith({ user: changedUser }));
    expect(changePasswordMock).toHaveBeenCalledTimes(2);
  });

  it("같은 tick의 빠른 연속 제출과 비밀번호 변경 중 로그아웃을 차단한다", async () => {
    let resolveRequest: ((value: { ok: true; user: AuthUser }) => void) | undefined;
    changePasswordMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    renderView();
    fillPasswords();

    const submit = screen.getByRole("button", { name: "비밀번호 변경" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(changePasswordMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(logoutMock).not.toHaveBeenCalled();

    await act(async () => resolveRequest?.({ ok: true, user: changedUser }));
  });

  it("로그아웃 성공 시 현재 principal과 tenant·활성 명령·편집기 상태를 정리한다", async () => {
    logoutMock.mockResolvedValue({ ok: true });
    const queryClient = new QueryClient();
    queryClient.setQueryData(authMeQueryKey, { user: pendingUser });
    queryClient.setQueryData(["dashboard", "site-1"], { secret: "tenant-data" });
    saveActiveCommandId(pendingUser.id, "site-1", "00000000-0000-4000-8000-000000000001");
    useFloorEditorStore.setState({ isDirty: true });
    renderView(queryClient);

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    await waitFor(() => expect(logoutMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(queryClient.getQueryData(authMeQueryKey)).toBeNull());
    expect(queryClient.getQueryData(["dashboard", "site-1"])).toBeUndefined();
    expect(sessionStorage.getItem(activeCommandStorageKey(pendingUser.id, "site-1"))).toBeNull();
    expect(useFloorEditorStore.getState().isDirty).toBe(false);
  });
});
