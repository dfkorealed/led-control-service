import { useCallback, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useSites, type SiteCapabilities } from "../../api/queries";
import { ConfirmDialog } from "../../components/ui";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";
import { SiteSwitcher, siteSelectionTarget } from "../sites/SiteSwitcher";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { SettingsSubnavigation } from "./SettingsSubnavigation";

interface SettingsShellProps {
  capabilities: SiteCapabilities;
  selectedSiteId?: string;
}

export function SettingsShell({ capabilities, selectedSiteId }: SettingsShellProps) {
  const { data: sites = [] } = useSites();
  const location = useLocation();
  const navigate = useNavigate();
  const isEditorDirty = useFloorEditorStore((store) => store.isDirty);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const [pendingSiteId, setPendingSiteId] = useState<string | null>(null);
  const navigateToSite = useCallback((siteId: string) => {
    navigate(siteSelectionTarget(location, siteId), { replace: hasDirtyEditorSentinel() });
  }, [location, navigate]);
  const selectSite = useCallback((siteId: string) => {
    if (isEditorDirty) {
      setPendingSiteId(siteId);
      return;
    }
    navigateToSite(siteId);
  }, [isEditorDirty, navigateToSite]);
  const confirmSiteChange = useCallback(() => {
    if (!pendingSiteId) return;
    const nextSiteId = pendingSiteId;
    setPendingSiteId(null);
    discardEditorChanges();
    navigateToSite(nextSiteId);
  }, [discardEditorChanges, navigateToSite, pendingSiteId]);

  return (
    <section className="grid min-w-0 content-start gap-5">
      <div className="flex items-center justify-end">
        <SiteSwitcher
          sites={sites}
          selectedSiteId={selectedSiteId}
          onSelectionChange={selectSite}
        />
      </div>
      <SettingsSubnavigation capabilities={capabilities} />
      <div className="min-w-0">
        <Outlet />
      </div>
      <ConfirmDialog
        isOpen={pendingSiteId !== null}
        title="현장 변경"
        role="alertdialog"
        confirmLabel="변경"
        onCancel={() => setPendingSiteId(null)}
        onConfirm={confirmSiteChange}
      >
        저장하지 않은 맵 편집 내용이 사라집니다. 다른 현장으로 변경하시겠습니까?
      </ConfirmDialog>
    </section>
  );
}
