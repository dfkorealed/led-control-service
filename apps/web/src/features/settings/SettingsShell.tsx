import { Link, Outlet, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type { SiteCapabilities } from "../../api/queries";
import { SettingsSubnavigation } from "./SettingsSubnavigation";
import { settingsActionLinkClass } from "./settings-action-link";

interface SettingsShellProps {
  capabilities: SiteCapabilities;
  accountSlot?: ReactNode;
}

export function SettingsShell({ capabilities, accountSlot }: SettingsShellProps) {
  const location = useLocation();
  const isSubpage = location.pathname !== "/settings" && location.pathname !== "/settings/";
  return (
    <section className="grid min-w-0 content-start gap-5">
      <SettingsSubnavigation capabilities={capabilities} />
      {accountSlot}
      {isSubpage ? <Link className={`${settingsActionLinkClass} compact:hidden`} to={{ pathname: "/settings", search: location.search, hash: location.hash }}>설정으로 돌아가기</Link> : null}
      <div className="min-w-0">
        <Outlet />
      </div>
    </section>
  );
}
