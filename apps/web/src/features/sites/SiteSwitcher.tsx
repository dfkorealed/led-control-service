import { forwardRef } from "react";
import { useLocation, useNavigate, type Location, type To } from "react-router-dom";
import type { SiteSummary } from "../../api/queries";
import { cn, SelectBox } from "../../components/ui";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";

interface SiteSwitcherProps {
  sites: SiteSummary[];
  selectedSiteId?: string;
  onSelectionChange?: (siteId: string) => void;
  className?: string;
  isDisabled?: boolean;
}

export function siteSelectionTarget(location: Pick<Location, "pathname" | "search" | "hash">, siteId: string): To {
  const search = new URLSearchParams(location.search);
  search.set("siteId", siteId);
  const pathname = /^\/settings\/floor-plans\/[^/]+\/edit$/.test(location.pathname)
    ? "/settings/floor-plans"
    : location.pathname;
  return { pathname, search: search.toString(), hash: location.hash };
}

export const SiteSwitcher = forwardRef<HTMLButtonElement, SiteSwitcherProps>(function SiteSwitcher({ sites, selectedSiteId, onSelectionChange, className, isDisabled }, ref) {
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
      ref={ref}
      aria-label="현장 선택"
      placeholder="현장 선택"
      className={cn("min-w-0 w-full [&_button]:min-w-0 [&_button]:w-full [&_button]:overflow-hidden", className)}
      isDisabled={isDisabled}
      items={sites.map((site) => ({
        id: site.id,
        label: site.customerName ? `${site.customerName} · ${site.name}` : site.name
      }))}
      selectedKey={selectedSiteId ?? null}
      onSelectionChange={(siteId) => { if (siteId) selectSite(siteId); }}
    />
  );
});
