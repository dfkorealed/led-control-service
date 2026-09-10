import type { AuthUser } from "../../api/auth";

export interface SettingsSection {
  label: string;
  path: string;
  roles: AuthUser["role"][];
}

export const settingsSections: SettingsSection[] = [
  { label: "설정 개요", path: "/settings", roles: ["admin", "viewer"] },
  { label: "유저 관리", path: "/settings/users", roles: ["admin"] },
  { label: "조명 등록", path: "/settings/registration", roles: ["admin"] },
  { label: "맵 관리", path: "/settings/floor-plans", roles: ["admin", "viewer"] },
  { label: "비밀번호 변경", path: "/settings/security", roles: ["admin", "viewer"] }
];

export function settingsSectionsFor(role: AuthUser["role"]) {
  return settingsSections.filter((section) => section.roles.includes(role));
}
