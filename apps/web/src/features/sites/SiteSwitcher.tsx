import { useLocation, useNavigate } from "react-router-dom";
import type { SiteSummary } from "../../api/queries";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";

interface SiteSwitcherProps {
  sites: SiteSummary[];
  selectedSiteId?: string;
  canSelectSite?: () => boolean;
}

export function SiteSwitcher({ sites, selectedSiteId, canSelectSite }: SiteSwitcherProps) {
  const location = useLocation();
  const navigate = useNavigate();

  if (sites.length === 0) return null;

  function selectSite(siteId: string) {
    if (siteId === selectedSiteId || canSelectSite?.() === false) return;
    const search = new URLSearchParams(location.search);
    search.set("siteId", siteId);
    const pathname = /^\/settings\/floor-plans\/[^/]+\/edit$/.test(location.pathname)
      ? "/settings/floor-plans"
      : location.pathname;
    navigate(
      { pathname, search: search.toString(), hash: location.hash },
      { replace: hasDirtyEditorSentinel() }
    );
  }

  return (
    <label className="site-switcher">
      <span className="sr-only">현장 선택</span>
      <select aria-label="현장 선택" value={selectedSiteId ?? ""} onChange={(event) => selectSite(event.target.value)}>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>{site.customerName ? `${site.customerName} · ${site.name}` : site.name}</option>
        ))}
      </select>
    </label>
  );
}
