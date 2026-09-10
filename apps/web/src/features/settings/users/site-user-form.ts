import { ApiError } from "../../../api/client";
import type { SiteUserAccessLevel, SiteUserStatus } from "../../../api/site-users";

export interface SiteUserFormValues {
  name: string;
  loginId: string;
  temporaryPassword: string;
  accessLevel: SiteUserAccessLevel;
  status: SiteUserStatus;
}

export type SiteUserFormErrors = Partial<Record<"name" | "loginId" | "temporaryPassword", string>>;

export function validateSiteUserForm(values: SiteUserFormValues, requiresPassword: boolean): SiteUserFormErrors {
  const errors: SiteUserFormErrors = {};
  if (!values.name.trim()) errors.name = "이름을 입력하세요.";
  if (!/^[a-z0-9._@-]{4,100}$/.test(values.loginId.trim())) {
    errors.loginId = "로그인 아이디는 영문 소문자, 숫자, ., _, @, -를 사용해 4자 이상 입력하세요.";
  }
  if (requiresPassword && values.temporaryPassword.length < 8) {
    errors.temporaryPassword = "임시 비밀번호는 8자 이상 입력하세요.";
  }
  return errors;
}

const errorMessages: Record<string, string> = {
  INVALID_INPUT: "입력값을 다시 확인해 주세요.",
  SITE_USER_NOT_FOUND: "대상 사용자가 이미 삭제되었습니다. 목록을 새로고침했습니다.",
  LOGIN_ID_ALREADY_EXISTS: "이미 사용 중인 로그인 아이디입니다.",
  USER_LIMIT_REACHED: "현장 사용자는 최대 100명까지 등록할 수 있습니다.",
  SITE_USER_CHANGED: "다른 관리자가 먼저 수정했습니다. 최신 정보를 확인한 뒤 다시 시도하세요.",
  SITE_CAPABILITY_DENIED: "유저 관리 권한이 변경되었습니다. 설정 개요로 이동해 주세요."
};

export function siteUserErrorMessage(error: unknown) {
  const code = siteUserErrorCode(error);
  return code && errorMessages[code]
    ? errorMessages[code]
    : "요청을 완료하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.";
}

export function siteUserErrorCode(error: unknown) {
  return error instanceof ApiError && isRecord(error.body) && typeof error.body.code === "string"
    ? error.body.code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
