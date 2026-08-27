import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteAdminSummary } from "../../../api/operator-site-admins";
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

  it("creates a site admin and never retains the plaintext password in query data or rendered output", async () => {
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
    expect(queryClient.getMutationCache().getAll().every((mutation) => mutation.state.variables === undefined)).toBe(true);
  });

  it("assigns an administrator to an unassigned site with the existing site id", async () => {
    renderView();
    await screen.findByText("강남 주차장");

    fireEvent.click(screen.getByRole("button", { name: "강남 주차장 관리자 지정" }));
    fillSiteAdminForm({ adminName: "박관리", loginId: "parking_admin", password: "assign-password" });
    fireEvent.click(screen.getByRole("button", { name: "지정" }));

    await waitFor(() => expect(api.assignSiteAdmin).toHaveBeenCalledWith("site-2", {
      adminName: "박관리",
      loginId: "parking_admin",
      initialPassword: "assign-password"
    }));
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
    expect(queryClient.getMutationCache().getAll().every((mutation) => mutation.state.variables === undefined)).toBe(true);
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
    api.updateSiteAdmin.mockRejectedValue({ name: "ApiError", status: 409, body: { message: "loginId already exists" } });
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
