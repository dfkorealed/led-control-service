import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPost } from "./client";

describe("API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the same-origin API prefix for production requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "site-1" }) });
    vi.stubGlobal("fetch", fetchMock);

    await apiGet("/sites/site-1/dashboard");
    await apiPost("/commands", { brightness: 60 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/sites/site-1/dashboard",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/commands",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
  });
});
