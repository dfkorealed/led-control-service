import type { RefObject } from "react";
import type { Dashboard } from "../../api/queries";
import { ModalDialog } from "../../components/ui";
import { FixtureGroupsContent } from "./groups/FixtureGroupsContent";
import { useFixtureGroupsWorkspace } from "./groups/useFixtureGroupsWorkspace";
import { spatialTargetDialogClassName } from "./target-selection/SpatialTargetSelector";

interface FixtureGroupDialogProps {
  open: boolean; siteId: string; dashboard: Dashboard; canManage: boolean;
  mutationsBlocked?: boolean; returnFocusRef?: RefObject<HTMLElement | null>; onClose: () => void;
}
export function FixtureGroupDialog({ open, siteId, dashboard, canManage, mutationsBlocked = false, returnFocusRef, onClose }: FixtureGroupDialogProps) {
  const workspace = useFixtureGroupsWorkspace({ siteId, dashboard, canManage, mutationsBlocked, isActive: open });
  return <ModalDialog isOpen={open}
    title={workspace.form ? (workspace.form.groupId ? "구역 수정" : "구역 생성") : "구역 관리"}
    description="저장 구역" closeLabel="구역 관리 닫기" isPending={workspace.isMutating}
    returnFocusRef={returnFocusRef} onClose={() => { if (!workspace.isMutating) onClose(); }}
    className={workspace.form ? spatialTargetDialogClassName : "grid max-w-3xl gap-4"}
    bodyClassName={workspace.form ? "flex min-h-0 flex-col overflow-hidden" : undefined}>
    <FixtureGroupsContent siteId={siteId} dashboard={dashboard} workspace={workspace} />
  </ModalDialog>;
}
