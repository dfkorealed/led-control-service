import { Outlet } from "react-router-dom";
import type { SiteCapabilities } from "../../api/queries";
import { SettingsSubnavigation } from "./SettingsSubnavigation";

interface SettingsShellProps {
  capabilities: SiteCapabilities;
}

export function SettingsShell({ capabilities }: SettingsShellProps) {
  return (
    <section className="grid min-w-0 content-start gap-5">
      <SettingsSubnavigation capabilities={capabilities} />
      <div className="min-w-0">
        <Outlet />
      </div>
    </section>
  );
}
