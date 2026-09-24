import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { siteSelectionTarget } from "./SiteSwitcher";

export function useGuardedSiteSelection(selectedSiteId?: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const isEditorDirty = useFloorEditorStore((store) => store.isDirty);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const [pendingSiteId, setPendingSiteId] = useState<string | null>(null);

  const navigateToSite = useCallback((siteId: string) => {
    navigate(siteSelectionTarget(location, siteId), { replace: hasDirtyEditorSentinel() });
  }, [location, navigate]);

  const requestSiteChange = useCallback((siteId: string) => {
    if (siteId === selectedSiteId) return;
    if (isEditorDirty || hasDirtyEditorSentinel()) {
      setPendingSiteId(siteId);
      return;
    }
    navigateToSite(siteId);
  }, [isEditorDirty, navigateToSite, selectedSiteId]);

  const cancelSiteChange = useCallback(() => setPendingSiteId(null), []);
  const confirmSiteChange = useCallback(() => {
    if (!pendingSiteId) return;
    const nextSiteId = pendingSiteId;
    setPendingSiteId(null);
    discardEditorChanges();
    navigateToSite(nextSiteId);
  }, [discardEditorChanges, navigateToSite, pendingSiteId]);

  return { pendingSiteId, requestSiteChange, cancelSiteChange, confirmSiteChange };
}
