import { useLocation, useNavigate } from "react-router-dom";
import type { SiteSummary } from "../../api/queries";

interface SiteSwitcherProps {
  sites: SiteSummary[];
  selectedSiteId?: string;
}

export function SiteSwitcher({ sites, selectedSiteId }: SiteSwitcherProps) {
  const location = useLocation();
  const navigate = useNavigate();

  if (sites.length === 0) return null;

  function selectSite(siteId: string) {
    const search = new URLSearchParams(location.search);
    search.set("siteId", siteId);
    navigate({ pathname: location.pathname, search: search.toString(), hash: location.hash });
  }

  return (
    <label className="site-switcher">
      <span className="sr-only">현장 선택</span>
      <select aria-label="현장 선택" value={selectedSiteId ?? ""} onChange={(event) => selectSite(event.target.value)}>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>{site.name}</option>
        ))}
      </select>
    </label>
  );
}
