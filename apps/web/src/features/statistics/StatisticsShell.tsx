import { Navigate, Outlet, useLocation } from "react-router-dom";
import { PageStack } from "../../components/ui";
import { StatisticsSubnavigation } from "./StatisticsSubnavigation";

export interface StatisticsOutletContext {
  siteId?: string;
}

export function StatisticsShell({ siteId }: StatisticsOutletContext) {
  return (
    // Approved compact statistics rhythm; desktop uses the ordinary section role.
    <PageStack as="section" className="max-compact:gap-2" aria-label="통계">
      <StatisticsSubnavigation />
      <Outlet context={{ siteId } satisfies StatisticsOutletContext} />
    </PageStack>
  );
}

export function StatisticsIndexRedirect() {
  const location = useLocation();
  return (
    <Navigate
      replace
      to={{ pathname: "/statistics/overview", search: location.search, hash: location.hash }}
    />
  );
}
