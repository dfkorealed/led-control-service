import { useCallback } from "react";
import { Outlet } from "react-router-dom";
import { useSites, type SiteCapabilities } from "../../api/queries";
import { SiteSwitcher } from "../sites/SiteSwitcher";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { SettingsSubnavigation } from "./SettingsSubnavigation";

interface SettingsShellProps {
  capabilities: SiteCapabilities;
  selectedSiteId?: string;
}

export function SettingsShell({ capabilities, selectedSiteId }: SettingsShellProps) {
  const { data: sites = [] } = useSites();
  const isEditorDirty = useFloorEditorStore((store) => store.isDirty);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const canSelectSite = useCallback(() => {
    if (!isEditorDirty) return true;
    if (!window.confirm("저장하지 않은 변경사항이 있습니다. 이동하시겠습니까?")) return false;
    discardEditorChanges();
    return true;
  }, [discardEditorChanges, isEditorDirty]);

  return (
    <section className="settings-workspace settings-workspace-flat">
      <div className="settings-context-bar">
        <SiteSwitcher
          sites={sites}
          selectedSiteId={selectedSiteId}
          canSelectSite={canSelectSite}
        />
      </div>
      <SettingsSubnavigation capabilities={capabilities} />
      <div className="settings-content">
        <Outlet />
      </div>
    </section>
  );
}
