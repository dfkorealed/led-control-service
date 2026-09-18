import { useDashboard } from "../../../api/queries";
import { PageHeader } from "../../../components/ui";
import { RegistrationPanel } from "../../registration/RegistrationPanel";
import { GatewayClaimPanel } from "../../setup/GatewayClaimPanel";
import { InstallationPending } from "../../setup/SetupWizard";

export function RegistrationSettingsView({ siteId }: { siteId?: string }) {
  const { data } = useDashboard(siteId);

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

  return (
    <section className="grid min-w-0 gap-4">
      <RegistrationPanel dashboard={data} dashboardQuerySiteId={siteId} headingLevel={2} />
    </section>
  );
}
