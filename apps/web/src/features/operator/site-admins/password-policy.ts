export const MIN_OPERATOR_PASSWORD_LENGTH = 8;
export const OPERATOR_PASSWORD_POLICY_MESSAGE = "비밀번호는 8자 이상이어야 합니다.";

export function isPasswordPolicyError(error: unknown) {
  if (typeof error !== "object" || error === null || !("status" in error) || !("body" in error)) return false;
  const apiError = error as { status?: unknown; body?: unknown };
  if (apiError.status !== 400 || typeof apiError.body !== "object" || apiError.body === null || !("message" in apiError.body)) {
    return false;
  }
  const message = (apiError.body as { message?: unknown }).message;
  const messages = Array.isArray(message) ? message : [message];
  return messages.some((item) => typeof item === "string" && /password.*(?:8|at least)/i.test(item));
}
