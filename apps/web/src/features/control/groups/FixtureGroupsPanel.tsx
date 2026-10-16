import type { Dashboard } from "../../../api/queries";
import { Card } from "../../../components/ui";
import { FixtureGroupsContent } from "./FixtureGroupsContent";
import { useFixtureGroupsWorkspace } from "./useFixtureGroupsWorkspace";

export function FixtureGroupsPanel({ siteId, dashboard, canManage, isActive = true, mutationsBlocked = false }: {
  siteId: string; dashboard: Dashboard; canManage: boolean; isActive?: boolean; mutationsBlocked?: boolean;
}) {
  const workspace = useFixtureGroupsWorkspace({ siteId, dashboard, canManage, isActive, mutationsBlocked });
  return <Card padding="regular" className="flex min-h-0 min-w-0 flex-col gap-5 overflow-y-auto overscroll-contain">
    <FixtureGroupsContent siteId={siteId} dashboard={dashboard} workspace={workspace} />
  </Card>;
}
