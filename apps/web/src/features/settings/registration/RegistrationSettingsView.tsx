import { Link, useLocation } from "react-router-dom";
import { useDashboard } from "../../../api/queries";
import { PageHeader } from "../../../components/ui";
import { RegistrationPanel } from "../../registration/RegistrationPanel";
import { GatewayClaimPanel } from "../../setup/GatewayClaimPanel";
import { InstallationPending } from "../../setup/SetupWizard";
import { settingsActionLinkClass } from "../settings-action-link";

export function RegistrationSettingsView({ siteId }: { siteId?: string }) {
  const { data, isFetching, refetch } = useDashboard(siteId);
  const location = useLocation();

  if (!data?.site.id || data.site.installationStatus !== "installed") {
    return <section className="grid min-w-0 gap-4"><InstallationPending /></section>;
  }

  if (data.gateways.length === 0) {
    return (
      <section className="grid min-w-0 gap-4">
        <PageHeader title="조명 등록" description="조명을 검색하기 전에 현장에서 사용할 게이트웨이를 연결합니다." />
        <GatewayClaimPanel siteId={data.site.id} />
      </section>
    );
  }

  const mapSearch = new URLSearchParams(location.search);
  mapSearch.set("siteId", data.site.id);

  return (
    <section className="grid min-w-0 gap-4">
      <RegistrationPanel
        dashboard={data}
        dashboardQuerySiteId={siteId}
        headingLevel={2}
        onRefreshGatewayStatus={() => void refetch()}
        isRefreshingGatewayStatus={isFetching}
      />
      {data.summary.totalFixtures > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-default pt-4">
          <span className="text-body-sm text-content-secondary">등록한 조명의 위치는 층별 맵에서 배치할 수 있습니다.</span>
          <Link
            className={settingsActionLinkClass}
            to={{ pathname: "/settings/floor-plans", search: mapSearch.toString() }}
          >맵에서 조명 배치하기</Link>
        </div>
      ) : null}
    </section>
  );
}
