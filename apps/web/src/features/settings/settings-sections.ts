import type { SiteCapabilities } from "../../api/queries";

export interface SettingsSection {
  id: "overview" | "site" | "users" | "registration" | "floor-plans" | "security";
  label: string;
  pageTitle: string;
  path: string;
  requiredCapability: "read" | "manage";
}

export const settingsSections: SettingsSection[] = [
  { id: "overview", label: "설정 개요", pageTitle: "설정", path: "/settings", requiredCapability: "read" },
  { id: "site", label: "현장 관리", pageTitle: "현장 관리", path: "/settings/site", requiredCapability: "manage" },
  { id: "users", label: "유저 관리", pageTitle: "사용자 관리", path: "/settings/users", requiredCapability: "manage" },
  { id: "registration", label: "조명 등록", pageTitle: "조명 등록", path: "/settings/registration", requiredCapability: "manage" },
  { id: "floor-plans", label: "맵 관리", pageTitle: "도면 관리", path: "/settings/floor-plans", requiredCapability: "read" },
  { id: "security", label: "계정 보안", pageTitle: "계정 및 보안", path: "/settings/security", requiredCapability: "read" }
];

export function settingsSectionsFor(capabilities: SiteCapabilities) {
  return settingsSections.filter((section) => capabilities[section.requiredCapability]);
}
