import { useLocation, useNavigate, type Location, type To } from "react-router-dom";
import type { SiteSummary } from "../../api/queries";
import { SelectBox } from "../../components/ui";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";

interface SiteSwitcherProps {
  sites: SiteSummary[];
  selectedSiteId?: string;
  onSelectionChange?: (siteId: string) => void;
}

export function siteSelectionTarget(location: Pick<Location, "pathname" | "search" | "hash">, siteId: string): To {
  const search = new URLSearchParams(location.search);
  search.set("siteId", siteId);
  const pathname = /^\/settings\/floor-plans\/[^/]+\/edit$/.test(location.pathname)
    ? "/settings/floor-plans"
    : location.pathname;
  return { pathname, search: search.toString(), hash: location.hash };
}

export function SiteSwitcher({ sites, selectedSiteId, onSelectionChange }: SiteSwitcherProps) {
  const location = useLocation();
  const navigate = useNavigate();

  if (sites.length === 0) return null;

  function selectSite(siteId: string) {
    if (siteId === selectedSiteId) return;
    if (onSelectionChange) {
      onSelectionChange(siteId);
      return;
    }
    navigate(siteSelectionTarget(location, siteId), { replace: hasDirtyEditorSentinel() });
  }

  return (
    <SelectBox
      aria-label="현장 선택"
      className="min-w-56"
      items={sites.map((site) => ({
        id: site.id,
        label: site.customerName ? `${site.customerName} · ${site.name}` : site.name
      }))}
      selectedKey={selectedSiteId ?? null}
      onSelectionChange={(siteId) => { if (siteId) selectSite(siteId); }}
    />
  );
}
