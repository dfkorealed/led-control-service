import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { changePassword } from "../../../api/auth";
import { PasswordSettingsView } from "./PasswordSettingsView";

vi.mock("../../../api/auth", () => ({ changePassword: vi.fn() }));

const changePasswordMock = vi.mocked(changePassword);

function renderView() {
  render(<PasswordSettingsView />);
}

function fillPasswords(currentPassword = "current-password", newPassword = "new-password") {
  fireEvent.change(screen.getByLabelText("현재 비밀번호"), { target: { value: currentPassword } });
  fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: newPassword } });
  fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: newPassword } });
}

describe("PasswordSettingsView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("blocks a new password shorter than eight characters before requesting", () => {
    renderView();
    fillPasswords("current-password", "short");
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    expect(screen.getByRole("alert")).toHaveTextContent("새 비밀번호는 8자 이상이어야 합니다.");
    expect(changePasswordMock).not.toHaveBeenCalled();
  });

  it("blocks mismatched new-password confirmation before requesting", () => {
    renderView();
    fillPasswords();
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "different-password" } });
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    expect(screen.getByRole("alert")).toHaveTextContent("새 비밀번호 확인이 일치하지 않습니다.");
    expect(changePasswordMock).not.toHaveBeenCalled();
  });

  it("shows the exact current-password failure and keeps inputs for retry", async () => {
    changePasswordMock.mockRejectedValue(new ApiError("POST failed", 401, { message: "Current password is incorrect" }));
    renderView();
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("현재 비밀번호가 올바르지 않습니다.");
    expect(screen.getByLabelText("현재 비밀번호")).toHaveValue("current-password");
    expect(screen.getByLabelText("새 비밀번호")).toHaveValue("new-password");
  });

  it("blocks duplicate password submissions while a local request is pending", async () => {
    let resolveRequest: (() => void) | undefined;
    changePasswordMock.mockImplementation(() => new Promise((resolve) => { resolveRequest = () => resolve({ ok: true }); }));
    renderView();
    fillPasswords();

    const submit = screen.getByRole("button", { name: "비밀번호 변경" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(changePasswordMock).toHaveBeenCalledTimes(1);
    resolveRequest?.();
    await screen.findByText("비밀번호를 변경했습니다.");
  });

  it("clears all password inputs only after a successful change", async () => {
    changePasswordMock.mockResolvedValue({ ok: true });
    renderView();
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    await waitFor(() => expect(changePasswordMock).toHaveBeenCalledWith({
      currentPassword: "current-password",
      newPassword: "new-password",
      newPasswordConfirmation: "new-password"
    }));
    expect(await screen.findByText("비밀번호를 변경했습니다.")).toBeInTheDocument();
    expect(screen.getByLabelText("현재 비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("새 비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("새 비밀번호 확인")).toHaveValue("");
  });

  it("shows a retryable general error for other failures", async () => {
    changePasswordMock.mockRejectedValue(new ApiError("POST failed", 500, { message: "Unexpected error" }));
    renderView();
    fillPasswords();
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도하세요.");
  });
});
