import { Link, Outlet, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type { SiteCapabilities } from "../../api/queries";
import { SettingsSubnavigation } from "./SettingsSubnavigation";
import { settingsActionLinkClass } from "./settings-action-link";
import { PageHeader } from "../../components/ui";
import { settingsSectionsFor } from "./settings-sections";

interface SettingsShellProps {
  capabilities: SiteCapabilities;
  accountSlot?: ReactNode;
}

export function SettingsShell({ capabilities, accountSlot }: SettingsShellProps) {
  const location = useLocation();
  // Only exact capability-approved top-level routes belong to this title owner.
  // Detailed editor routes keep their existing child-owned h1.
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  const section = settingsSectionsFor(capabilities).find(item => item.path === pathname);
  const isSubpage = location.pathname !== "/settings" && location.pathname !== "/settings/";
  return (
    <section className="grid min-w-0 content-start gap-5">
      {section ? <PageHeader variant="customer" headingLevel={1} title={section.pageTitle} /> : null}
      <SettingsSubnavigation capabilities={capabilities} />
      {accountSlot}
      {isSubpage ? <Link className={`${settingsActionLinkClass} compact:hidden`} to={{ pathname: "/settings", search: location.search, hash: location.hash }}>설정으로 돌아가기</Link> : null}
      <div className="min-w-0">
        <Outlet />
      </div>
    </section>
  );
}
