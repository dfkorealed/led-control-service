import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import { siteUserErrorMessage, validateSiteUserForm } from "./site-user-form";

describe("site user form", () => {
  it("validates the server-compatible profile and temporary password contract", () => {
    expect(validateSiteUserForm({
      name: "",
      loginId: "한글 아이디",
      temporaryPassword: "short",
      accessLevel: "read",
      status: "active"
    }, true)).toEqual({
      name: "이름을 입력하세요.",
      loginId: "로그인 아이디는 영문 소문자, 숫자, ., _, @, -를 사용해 4자 이상 입력하세요.",
      temporaryPassword: "임시 비밀번호는 8자 이상 입력하세요."
    });
  });

  it.each([
    ["INVALID_INPUT", "입력값을 다시 확인해 주세요."],
    ["SITE_USER_NOT_FOUND", "대상 사용자가 이미 삭제되었습니다. 목록을 새로고침했습니다."],
    ["LOGIN_ID_ALREADY_EXISTS", "이미 사용 중인 로그인 아이디입니다."],
    ["USER_LIMIT_REACHED", "현장 사용자는 최대 100명까지 등록할 수 있습니다."],
    ["SITE_USER_CHANGED", "다른 관리자가 먼저 수정했습니다. 최신 정보를 확인한 뒤 다시 시도하세요."],
    ["SITE_CAPABILITY_DENIED", "유저 관리 권한이 변경되었습니다. 설정 개요로 이동해 주세요."]
  ])("maps %s API errors to a safe Korean message", (code, message) => {
    expect(siteUserErrorMessage(new ApiError("request failed", 409, { code, message: "server details" }))).toBe(message);
  });
});
