import type { SiteCapabilities } from "../../api/queries";

export interface SettingsSection {
  label: string;
  path: string;
  requiredCapability: "read" | "manage";
}

export const settingsSections: SettingsSection[] = [
  { label: "설정 개요", path: "/settings", requiredCapability: "read" },
  { label: "유저 관리", path: "/settings/users", requiredCapability: "manage" },
  { label: "조명 등록", path: "/settings/registration", requiredCapability: "manage" },
  { label: "맵 관리", path: "/settings/floor-plans", requiredCapability: "read" },
  { label: "비밀번호 변경", path: "/settings/security", requiredCapability: "read" }
];

export function settingsSectionsFor(capabilities: SiteCapabilities) {
  return settingsSections.filter((section) => capabilities[section.requiredCapability]);
}
