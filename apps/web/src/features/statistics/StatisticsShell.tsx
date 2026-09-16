import { Navigate, Outlet, useLocation } from "react-router-dom";
import { StatisticsSubnavigation } from "./StatisticsSubnavigation";

export interface StatisticsOutletContext {
  siteId?: string;
}

export function StatisticsShell({ siteId }: StatisticsOutletContext) {
  return (
    <section className="grid min-w-0 content-start gap-6" aria-label="통계">
      <StatisticsSubnavigation />
      <Outlet context={{ siteId } satisfies StatisticsOutletContext} />
    </section>
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
