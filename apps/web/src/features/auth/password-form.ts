import { ApiError } from "../../api/client";

const PASSWORD_POLICY_MESSAGE = "새 비밀번호는 8자 이상 1024자 이하이며 공백만 사용할 수 없습니다.";

export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
  currentPasswordLabel = "현재 비밀번호"
) {
  if (!currentPassword.trim()) return `${currentPasswordLabel}를 입력하세요.`;
  if (newPassword.length < 8 || newPassword.length > 1024 || !newPassword.trim()) {
    return PASSWORD_POLICY_MESSAGE;
  }
  if (newPassword !== confirmation) return "새 비밀번호 확인이 일치하지 않습니다.";
  return "";
}

export function passwordChangeErrorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError
    && typeof error.body === "object"
    && error.body !== null
    && "message" in error.body
    && error.body.message === "Current password is incorrect"
    ? "현재 비밀번호가 올바르지 않습니다."
    : fallback;
}
