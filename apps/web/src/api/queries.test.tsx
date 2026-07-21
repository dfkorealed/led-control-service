import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFloorFixtures } from "./queries";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("./client", () => ({ apiGet }));

function QueryWrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

describe("useFloorFixtures", () => {
  it("binds fixture requests to the selected site URL while retaining pagination parameters", async () => {
    apiGet.mockResolvedValue({ items: [], nextCursor: null });

    renderHook(() => useFloorFixtures("floor-1", "site-2"), { wrapper: QueryWrapper });

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/sites/site-2/floors/floor-1/fixtures?limit=200");
    });
  });
});
