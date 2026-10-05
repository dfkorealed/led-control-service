import { Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import type { SiteCapabilities } from "../../api/queries";
import { SettingsSubnavigation } from "./SettingsSubnavigation";

interface SettingsShellProps {
  capabilities: SiteCapabilities;
  accountSlot?: ReactNode;
}

export function SettingsShell({ capabilities, accountSlot }: SettingsShellProps) {
  return (
    <section className="grid min-w-0 content-start gap-5">
      <SettingsSubnavigation capabilities={capabilities} />
      {accountSlot}
      <div className="min-w-0">
        <Outlet />
      </div>
    </section>
  );
}
