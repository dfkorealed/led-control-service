import { Building2, Lightbulb, Map, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import type { Dashboard, SiteCapabilities } from "../../api/queries";
import { settingsSectionsFor, type SettingsSection } from "./settings-sections";

export type SettingsCardModel = { id: string; label: string; path: string; icon: LucideIcon; summary: string };

export function buildSettingsCards({ dashboard, capabilities, userCount }: {
  dashboard: Dashboard;
  capabilities: SiteCapabilities;
  userCount: number | null;
}): readonly SettingsCardModel[] {
  const configured = dashboard.floors.filter(floor => floor.mapConfigured === true).length;
  const unknown = dashboard.floors.filter(floor => floor.mapConfigured === undefined).length;
  const gateway = dashboard.gateways[0];
  const gatewaySummary = gateway
    ? `Gateway ${gateway.name} · 시리얼 ${gateway.serialNumber} · ${gateway.connectionStatus === "online" ? "정상" : "오프라인"}`
    : "Gateway 미등록";
  const presentation: Record<Exclude<SettingsSection["id"], "overview">, { icon: LucideIcon; summary: string }> = {
    site: { icon: Building2, summary: `${dashboard.site.name} · ${dashboard.floors.length}개 층` },
    users: { icon: Users, summary: userCount === null ? "사용자 수 확인 중" : `사용자 ${userCount.toLocaleString("ko-KR")}명` },
    registration: { icon: Lightbulb, summary: `등록 조명 ${dashboard.summary.totalFixtures.toLocaleString("ko-KR")}개 · ${gatewaySummary}` },
    "floor-plans": { icon: Map, summary: `${dashboard.floors.length}개 층 · 맵 설정 ${configured}개${unknown > 0 ? ` · 상태 확인 중 ${unknown}개` : ""}` },
    // The home does not query MFA. Describe actions, never an unobserved state.
    security: { icon: ShieldCheck, summary: "비밀번호 · 2단계 인증 · 세션" }
  };
  return settingsSectionsFor(capabilities).flatMap(({ id, label, path }) => id === "overview" ? [] : [{ id, label, path, ...presentation[id] }]);
}
