import { Link, useLocation } from "react-router-dom";
import { useDashboard, type SiteCapabilities } from "../../api/queries";
import { useSiteUsers } from "../../api/site-users";
import { NavigationCard } from "../../components/ui";
import { InstallationPending, SetupWizard } from "../setup/SetupWizard";
import { TestDataToolsPanel } from "./TestDataToolsPanel";
import { settingsActionLinkClass } from "./settings-action-link";
import { buildSettingsCards } from "./settings-card-model";

export function SettingsView({ userRole, siteId, capabilities }: { userRole: "operator" | "admin" | "viewer"; siteId?: string; capabilities: SiteCapabilities }) {
  const { data } = useDashboard(siteId);
  const location = useLocation();
  // A disabled query must not receive even a stale route site ID. Counts are
  // available only to a manager of the loaded, fully installed site.
  const usersSiteId = capabilities.manage && data?.site.installationStatus === "installed" ? data.site.id : undefined;
  const usersQuery = useSiteUsers(usersSiteId);

  if (!data?.site.id) {
    return <section className="grid gap-5"><InstallationPending /></section>;
  }

  if (data.site.installationStatus === "pending") {
    return <section className="grid gap-5">{userRole === "admin"
      ? <SetupWizard siteId={data.site.id} customerName={data.site.customerName} siteName={data.site.name} />
      : <InstallationPending />}</section>;
  }

  const cards = buildSettingsCards({ dashboard: data, capabilities, userCount: usersQuery.data?.count ?? null });
  const nextStepSearch = new URLSearchParams(location.search);
  nextStepSearch.set("siteId", data.site.id);
  const nextStep = data.gateways.length === 0
    ? { title: "게이트웨이 연결", description: "조명을 검색하기 전에 현장의 게이트웨이를 등록합니다.", label: "게이트웨이 연결하기", path: "/settings/registration" }
    : data.summary.totalFixtures === 0
      ? { title: "조명 등록", description: "연결된 게이트웨이에서 조명을 검색하고 등록합니다.", label: "조명 등록하기", path: "/settings/registration" }
      : { title: "조명 위치 배치", description: "등록한 조명의 위치를 층별 맵에서 확인하고 배치합니다.", label: "조명 위치 배치하기", path: "/settings/floor-plans" };

  return <section className="grid min-w-0 gap-5">
    {capabilities.manage ? <section className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-border-default bg-action-secondary p-4" aria-label="설치 이어가기">
      <div className="grid gap-1">
        <span className="text-overline font-bold text-content-secondary">설치 이어가기</span>
        <strong className="text-card-title text-content-primary">{nextStep.title}</strong>
        <p className="m-0 text-body-sm text-content-secondary">{nextStep.description}</p>
      </div>
      <Link className={settingsActionLinkClass} to={{ pathname: nextStep.path, search: nextStepSearch.toString(), hash: location.hash }}>{nextStep.label}</Link>
    </section> : null}
    <div className="grid min-w-0 gap-4 compact:grid-cols-2 tablet:grid-cols-3">
      {cards.map(({ id, label, path, icon: Icon, summary }) => <NavigationCard key={id}
        aria-label={label} title={label} icon={<Icon size={24} />} className="min-h-32"
        summary={<span className="break-words">{summary}</span>}
        to={{ pathname: path, search: location.search, hash: location.hash }} />)}
    </div>
    <TestDataToolsPanel userRole={userRole} dashboard={data} />
  </section>;
}
