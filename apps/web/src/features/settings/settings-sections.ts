import type { AuthUser } from "../../api/auth";

export interface SettingsSection {
  label: string;
  path: string;
  roles: AuthUser["role"][];
}

const settingsSections: SettingsSection[] = [
  { label: "설정 개요", path: "/settings", roles: ["operator", "admin", "viewer"] },
  { label: "현장 및 층", path: "/settings/floors", roles: ["operator", "admin"] },
  { label: "도면 관리", path: "/settings/floor-plans", roles: ["operator", "admin", "viewer"] },
  { label: "조명 및 그룹", path: "/settings/fixtures", roles: ["operator", "admin"] },
  { label: "Gateway 및 네트워크", path: "/settings/gateways", roles: ["operator", "admin"] },
  { label: "설치 및 시운전", path: "/settings/commissioning", roles: ["operator"] },
  { label: "운영 정책", path: "/settings/operation-policy", roles: ["operator", "admin"] },
  { label: "알림", path: "/settings/alerts", roles: ["operator", "admin"] },
  { label: "사용자 및 보안", path: "/settings/security", roles: ["operator", "admin"] },
  { label: "펌웨어 및 유지보수", path: "/settings/firmware", roles: ["operator"] },
  { label: "외부 연동", path: "/settings/integrations", roles: ["operator", "admin"] },
  { label: "장비 상태", path: "/settings/device-status", roles: ["viewer"] }
];

export function settingsSectionsFor(role: AuthUser["role"]) {
  return settingsSections.filter((section) => section.roles.includes(role));
}
