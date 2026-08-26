import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEnergySeries, useEnergySummary } from "./energy";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("./client", () => ({ apiGet }));

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("energy queries", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("loads a site-scoped summary and isolates its cache by site", async () => {
    apiGet.mockResolvedValue({ siteId: "site-2" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useEnergySummary("site-2"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/energy/sites/site-2/summary"));
    expect(client.getQueryCache().find({ queryKey: ["energy-summary", "site-2"] })).toBeDefined();
  });

  it("includes site, granularity and inclusive range in the series request and cache key", async () => {
    apiGet.mockResolvedValue({ points: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useEnergySeries({
      siteId: "site/2",
      granularity: "day",
      from: "2026-08-01",
      to: "2026-08-31",
      enabled: true
    }), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      "/energy/sites/site%2F2/series?granularity=day&from=2026-08-01&to=2026-08-31"
    ));
    expect(client.getQueryCache().find({
      queryKey: ["energy-series", "site/2", "day", "2026-08-01", "2026-08-31"]
    })).toBeDefined();
  });

  it("does not call the API until the required identifiers and range are ready", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useEnergySummary(undefined), { wrapper: wrapperFor(client) });
    renderHook(() => useEnergySeries({
      siteId: undefined,
      granularity: "month",
      from: "",
      to: "",
      enabled: false
    }), { wrapper: wrapperFor(client) });

    await Promise.resolve();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
