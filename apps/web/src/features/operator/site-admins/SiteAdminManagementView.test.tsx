import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import type { SiteAdminSummary } from "../../../api/operator-site-admins";
import { SiteAdminFormDialog } from "./SiteAdminFormDialog";
import { SiteAdminManagementView } from "./SiteAdminManagementView";

const api = vi.hoisted(() => ({
  listSiteAdmins: vi.fn(),
  createSiteAdmin: vi.fn(),
  assignSiteAdmin: vi.fn(),
  updateSiteAdmin: vi.fn(),
  resetSiteAdminPassword: vi.fn(),
  disableSiteAdmin: vi.fn()
}));

vi.mock("../../../api/operator-site-admins", () => ({
  operatorSiteAdminsQueryKey: ["operator", "site-admins"],
  ...api
}));

const assignedSite: SiteAdminSummary = {
  siteId: "site-1",
  customerName: "새빛 물류",
  siteName: "인천 물류센터",
  installationStatus: "pending",
  admin: {
    id: "admin-1",
    name: "김관리",
    loginId: "customer_admin",
    status: "active",
    updatedAt: "2026-08-27T08:00:00.000Z"
  }
};

const unassignedSite: SiteAdminSummary = {
  siteId: "site-2",
  customerName: "한결 주차",
  siteName: "강남 주차장",
  installationStatus: "installed",
  admin: null
};

describe("SiteAdminManagementView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listSiteAdmins.mockResolvedValue([assignedSite, unassignedSite]);
    api.createSiteAdmin.mockResolvedValue({ ...assignedSite, siteId: "site-3" });
    api.assignSiteAdmin.mockResolvedValue({ ...unassignedSite, admin: assignedSite.admin });
    api.updateSiteAdmin.mockResolvedValue({ ...assignedSite.admin, name: "김수정", loginId: "updated_admin" });
    api.resetSiteAdminPassword.mockResolvedValue({ ok: true });
    api.disableSiteAdmin.mockResolvedValue({ ok: true });
  });

  afterEach(cleanup);

  it("creates a site admin without creating a password-bearing React Query mutation", async () => {
    const queryClient = renderView();
    await screen.findByText("인천 물류센터");

    fireEvent.click(screen.getByRole("button", { name: "현장 및 관리자 생성" }));
    fillSiteAdminForm({
      customerName: "새 고객사",
      siteName: "새 현장",
      adminName: "신규 관리자",
      loginId: "customer_admin",
      password: "plain-text-password"
    });
    fireEvent.click(screen.getByRole("button", { name: "생성" }));

    await waitFor(() => expect(api.createSiteAdmin).toHaveBeenCalledWith({
      customerName: "새 고객사",
      siteName: "새 현장",
      adminName: "신규 관리자",
      loginId: "customer_admin",
      initialPassword: "plain-text-password"
    }));
    await screen.findByText("현장과 관리자 계정을 생성했습니다.");

    expect(screen.queryByText("plain-text-password")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("plain-text-password")).not.toBeInTheDocument();
    expect(JSON.stringify(queryClient.getQueryData(["operator", "site-admins"]))).not.toContain("plain-text-password");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("requires an initial password of at least eight characters before create", async () => {
    renderView();
    await screen.findByText("인천 물류센터");
    fireEvent.click(screen.getByRole("button", { name: "현장 및 관리자 생성" }));
    fillSiteAdminForm({
      customerName: "새 고객사",
      siteName: "새 현장",
      adminName: "신규 관리자",
      loginId: "short_password_admin",
      password: "short"
    });
    fireEvent.click(screen.getByRole("button", { name: "생성" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("비밀번호는 8자 이상이어야 합니다.");
    expect(api.createSiteAdmin).not.toHaveBeenCalled();
  });

  it("shows a server password policy error clearly during initial account creation", async () => {
    api.createSiteAdmin.mockRejectedValueOnce(new ApiError(
      "POST failed",
      400,
      { message: "Password must be at least 8 characters" }
    ));
    renderView();
    await screen.findByText("인천 물류센터");
    fireEvent.click(screen.getByRole("button", { name: "현장 및 관리자 생성" }));
    fillSiteAdminForm({
      customerName: "새 고객사",
      siteName: "새 현장",
      adminName: "신규 관리자",
      loginId: "policy_admin",
      password: "valid-password"
    });
    fireEvent.click(screen.getByRole("button", { name: "생성" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("비밀번호는 8자 이상이어야 합니다.");
  });

  it("assigns an administrator to an unassigned site with the existing site id", async () => {
    const queryClient = renderView();
    await screen.findByText("강남 주차장");

    fireEvent.click(screen.getByRole("button", { name: "강남 주차장 관리자 지정" }));
    fillSiteAdminForm({ adminName: "박관리", loginId: "parking_admin", password: "assign-password" });
    fireEvent.click(screen.getByRole("button", { name: "지정" }));

    await waitFor(() => expect(api.assignSiteAdmin).toHaveBeenCalledWith("site-2", {
      adminName: "박관리",
      loginId: "parking_admin",
      initialPassword: "assign-password"
    }));
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("updates an assigned administrator without asking for or storing a password", async () => {
    renderView();
    await screen.findByText("customer_admin");

    fireEvent.click(screen.getByRole("button", { name: "김관리 수정" }));
    expect(screen.queryByLabelText("초기 비밀번호")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("관리자 이름"), { target: { value: "김수정" } });
    fireEvent.change(screen.getByLabelText("로그인 아이디"), { target: { value: "updated_admin" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(api.updateSiteAdmin).toHaveBeenCalledWith("admin-1", {
      adminName: "김수정",
      loginId: "updated_admin"
    }));
  });

  it("restores the original create trigger instead of a fallback after creation succeeds", async () => {
    renderCreateDialogFocusHarness();

    const trigger = screen.getByRole("button", { name: "원 생성 trigger" });
    const fallback = screen.getByRole("button", { name: "fallback command" });
    fireEvent.click(trigger);
    fillSiteAdminForm({
      customerName: "새 고객사",
      siteName: "새 현장",
      adminName: "신규 관리자",
      loginId: "new_admin",
      password: "create-password"
    });
    fireEvent.click(screen.getByRole("button", { name: "생성" }));

    await waitFor(() => expect(api.createSiteAdmin).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
    expect(document.activeElement).not.toBe(fallback);
  });

  it("restores the edit trigger after a successful update", async () => {
    renderView();
    await screen.findByText("customer_admin");

    const trigger = screen.getByRole("button", { name: "김관리 수정" });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("관리자 이름"), { target: { value: "김수정" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(api.updateSiteAdmin).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("validates reset password confirmation before sending the new password", async () => {
    const queryClient = renderView();
    await screen.findByText("customer_admin");

    fireEvent.click(screen.getByRole("button", { name: "김관리 비밀번호 재설정" }));
    const dialog = screen.getByRole("dialog", { name: "김관리 비밀번호 재설정" });
    fireEvent.change(within(dialog).getByLabelText("새 비밀번호"), { target: { value: "new-password" } });
    fireEvent.change(within(dialog).getByLabelText("비밀번호 확인"), { target: { value: "different-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 재설정" }));

    expect(await within(dialog).findByText("비밀번호 확인이 일치하지 않습니다.")).toHaveAttribute("role", "alert");
    expect(api.resetSiteAdminPassword).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("비밀번호 확인"), { target: { value: "new-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 재설정" }));
    await waitFor(() => expect(api.resetSiteAdminPassword).toHaveBeenCalledWith("admin-1", "new-password"));
    expect(screen.queryByText("new-password")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("new-password")).not.toBeInTheDocument();
    expect(JSON.stringify(queryClient.getQueryData(["operator", "site-admins"]))).not.toContain("new-password");
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("requires a reset password of at least eight characters before the API call", async () => {
    renderView();
    await screen.findByText("customer_admin");
    fireEvent.click(screen.getByRole("button", { name: "김관리 비밀번호 재설정" }));
    const dialog = screen.getByRole("dialog", { name: "김관리 비밀번호 재설정" });
    fireEvent.change(within(dialog).getByLabelText("새 비밀번호"), { target: { value: "short" } });
    fireEvent.change(within(dialog).getByLabelText("비밀번호 확인"), { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 재설정" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("비밀번호는 8자 이상이어야 합니다.");
    expect(api.resetSiteAdminPassword).not.toHaveBeenCalled();
  });

  it("shows a server password policy error clearly during password reset", async () => {
    api.resetSiteAdminPassword.mockRejectedValueOnce(new ApiError(
      "POST failed",
      400,
      { message: "Password must be at least 8 characters" }
    ));
    renderView();
    await screen.findByText("customer_admin");
    fireEvent.click(screen.getByRole("button", { name: "김관리 비밀번호 재설정" }));
    const dialog = screen.getByRole("dialog", { name: "김관리 비밀번호 재설정" });
    fireEvent.change(within(dialog).getByLabelText("새 비밀번호"), { target: { value: "valid-password" } });
    fireEvent.change(within(dialog).getByLabelText("비밀번호 확인"), { target: { value: "valid-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 재설정" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("비밀번호는 8자 이상이어야 합니다.");
  });

  it("restores the reset trigger after a successful password reset", async () => {
    renderView();
    await screen.findByText("customer_admin");

    const trigger = screen.getByRole("button", { name: "김관리 비밀번호 재설정" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "김관리 비밀번호 재설정" });
    fireEvent.change(within(dialog).getByLabelText("새 비밀번호"), { target: { value: "new-password" } });
    fireEvent.change(within(dialog).getByLabelText("비밀번호 확인"), { target: { value: "new-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 재설정" }));

    await waitFor(() => expect(api.resetSiteAdminPassword).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("uses the shared destructive confirmation to disable an admin and states the access consequence", async () => {
    renderView();
    await screen.findByText("customer_admin");

    fireEvent.click(screen.getByRole("button", { name: "김관리 비활성화" }));
    const dialog = screen.getByRole("dialog", { name: "김관리 비활성화" });
    expect(within(dialog).getByText("로그아웃되며 현장 접근이 중단됩니다. 운영 이력은 보존됩니다.")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "비활성화" }));

    await waitFor(() => expect(api.disableSiteAdmin).toHaveBeenCalledWith("admin-1"));
  });

  it("maps a login id conflict to its field, focuses it, and restores trigger focus after Escape", async () => {
    api.updateSiteAdmin.mockRejectedValue(new ApiError("PATCH failed", 409, { message: "loginId already exists" }));
    renderView();
    await screen.findByText("customer_admin");

    const trigger = screen.getByRole("button", { name: "김관리 수정" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    const loginId = await screen.findByLabelText("로그인 아이디");
    expect(await screen.findByText("이미 사용 중인 로그인 아이디입니다.")).toHaveAttribute("role", "alert");
    await waitFor(() => expect(document.activeElement).toBe(loginId));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("shows a retryable general alert for a non-duplicate 409 conflict", async () => {
    api.updateSiteAdmin.mockRejectedValue(new ApiError(
      "PATCH failed",
      409,
      { message: "operator site admin transaction conflicted, please retry" }
    ));
    renderView();
    await screen.findByText("customer_admin");

    fireEvent.click(screen.getByRole("button", { name: "김관리 수정" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("관리자 계정 변경을 완료하지 못했습니다. 잠시 후 다시 시도하세요.")).toHaveAttribute("role", "alert");
    expect(screen.queryByText("이미 사용 중인 로그인 아이디입니다.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("로그인 아이디")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("restores focus to the stable create command after assigning an admin removes its trigger", async () => {
    const assignedParkingAdmin = { ...assignedSite.admin, id: "admin-2", name: "박관리", loginId: "parking_admin" };
    api.listSiteAdmins.mockReset();
    api.listSiteAdmins
      .mockResolvedValueOnce([assignedSite, unassignedSite])
      .mockResolvedValueOnce([{ ...unassignedSite, admin: assignedParkingAdmin }, assignedSite]);
    renderView();
    await screen.findByText("강남 주차장");

    const createCommand = screen.getByRole("button", { name: "현장 및 관리자 생성" });
    fireEvent.click(screen.getByRole("button", { name: "강남 주차장 관리자 지정" }));
    fillSiteAdminForm({ adminName: "박관리", loginId: "parking_admin", password: "assign-password" });
    fireEvent.click(screen.getByRole("button", { name: "지정" }));

    await screen.findByText("박관리");
    expect(screen.queryByRole("button", { name: "강남 주차장 관리자 지정" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(createCommand));
  });

  it("waits for an unchanged assign trigger refetch before closing and restores that trigger", async () => {
    const refetch = deferred<SiteAdminSummary[]>();
    api.listSiteAdmins.mockReset();
    api.listSiteAdmins
      .mockResolvedValueOnce([assignedSite, unassignedSite])
      .mockReturnValueOnce(refetch.promise);
    renderView();
    await screen.findByText("강남 주차장");

    const trigger = screen.getByRole("button", { name: "강남 주차장 관리자 지정" });
    fireEvent.click(trigger);
    fillSiteAdminForm({ adminName: "박관리", loginId: "parking_admin", password: "assign-password" });
    fireEvent.click(screen.getByRole("button", { name: "지정" }));

    await waitFor(() => expect(api.assignSiteAdmin).toHaveBeenCalledTimes(1));
    const pendingSubmit = await screen.findByRole("button", { name: "처리 중" });
    expect(pendingSubmit).toBeDisabled();
    fireEvent.click(pendingSubmit);
    expect(api.assignSiteAdmin).toHaveBeenCalledTimes(1);

    refetch.resolve([assignedSite, unassignedSite]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus to the stable create command after disabling an admin removes its trigger", async () => {
    api.listSiteAdmins.mockReset();
    api.listSiteAdmins
      .mockResolvedValueOnce([assignedSite])
      .mockResolvedValueOnce([{ ...assignedSite, admin: null }]);
    renderView();
    await screen.findByText("customer_admin");

    const createCommand = screen.getByRole("button", { name: "현장 및 관리자 생성" });
    fireEvent.click(screen.getByRole("button", { name: "김관리 비활성화" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "김관리 비활성화" })).getByRole("button", { name: "비활성화" }));

    await screen.findByText("관리자 미지정");
    expect(screen.queryByRole("button", { name: "김관리 비활성화" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(createCommand));
  });

  it("restores the disable trigger when its refetch result keeps it connected", async () => {
    api.listSiteAdmins.mockReset();
    api.listSiteAdmins
      .mockResolvedValueOnce([assignedSite])
      .mockResolvedValueOnce([assignedSite]);
    renderView();
    await screen.findByText("customer_admin");

    const trigger = screen.getByRole("button", { name: "김관리 비활성화" });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("dialog", { name: "김관리 비활성화" })).getByRole("button", { name: "비활성화" }));

    await waitFor(() => expect(api.listSiteAdmins).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes a completed reset after its active refetch fails", async () => {
    const refetch = deferred<SiteAdminSummary[]>();
    api.listSiteAdmins.mockReset();
    api.listSiteAdmins
      .mockResolvedValueOnce([assignedSite])
      .mockReturnValueOnce(refetch.promise);
    renderView();
    await screen.findByText("customer_admin");

    const createCommand = screen.getByRole("button", { name: "현장 및 관리자 생성" });
    const trigger = screen.getByRole("button", { name: "김관리 비밀번호 재설정" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "김관리 비밀번호 재설정" });
    fireEvent.change(within(dialog).getByLabelText("새 비밀번호"), { target: { value: "new-password" } });
    fireEvent.change(within(dialog).getByLabelText("비밀번호 확인"), { target: { value: "new-password" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "비밀번호 재설정" }));

    await waitFor(() => expect(api.resetSiteAdminPassword).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "처리 중" })).toBeDisabled();
    refetch.reject(new Error("offline"));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(createCommand));
  });

  it("renders loading, retryable fetch failure, and the operator table column contract", async () => {
    api.listSiteAdmins.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([assignedSite]);
    renderView();

    expect(screen.getByText("현장 관리자 목록을 불러오는 중입니다.")).toHaveAttribute("role", "status");
    expect(await screen.findByText("현장 관리자 목록을 불러오지 못했습니다.")).toHaveAttribute("role", "alert");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByText("인천 물류센터");

    for (const column of ["고객사", "현장", "설치 상태", "관리자 이름", "로그인 아이디", "계정 상태", "최종 변경", "작업"]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeVisible();
    }
  });
});

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  render(<QueryClientProvider client={queryClient}><SiteAdminManagementView /></QueryClientProvider>);
  return queryClient;
}

function renderCreateDialogFocusHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });

  function Harness() {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const fallbackRef = useRef<HTMLButtonElement>(null);

    return (
      <>
        <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>원 생성 trigger</button>
        <button ref={fallbackRef} type="button">fallback command</button>
        {open ? <SiteAdminFormDialog
          mode="create"
          returnFocusElement={triggerRef.current}
          fallbackFocusElement={fallbackRef.current}
          onCreate={api.createSiteAdmin}
          onAssign={api.assignSiteAdmin}
          onUpdate={api.updateSiteAdmin}
          onSuccess={async () => undefined}
          onClose={() => setOpen(false)}
        /> : null}
      </>
    );
  }

  render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fillSiteAdminForm(input: {
  customerName?: string;
  siteName?: string;
  adminName: string;
  loginId: string;
  password: string;
}) {
  if (input.customerName) fireEvent.change(screen.getByLabelText("고객사명"), { target: { value: input.customerName } });
  if (input.siteName) fireEvent.change(screen.getByLabelText("현장명"), { target: { value: input.siteName } });
  fireEvent.change(screen.getByLabelText("관리자 이름"), { target: { value: input.adminName } });
  fireEvent.change(screen.getByLabelText("로그인 아이디"), { target: { value: input.loginId } });
  fireEvent.change(screen.getByLabelText("초기 비밀번호"), { target: { value: input.password } });
}
