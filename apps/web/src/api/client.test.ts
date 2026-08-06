import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiPost, apiPut } from "./client";

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

  it("sends JSON PUT requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await apiPut("/floors/floor-1/editor-state", { expectedRevision: 3 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/floors/floor-1/editor-state",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({ expectedRevision: 3 })
      })
    );
  });

  it("preserves status and safely parsed body on API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: new Headers({ "Content-Type": "application/json" }),
      json: () => Promise.resolve({ message: "revision conflict" })
    }));

    const error = await apiPut("/floors/floor-1/editor-state", {}).catch((value) => value);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, body: { message: "revision conflict" } });
  });

  it("keeps a non-JSON error body without throwing a parser error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers({ "Content-Type": "text/plain" }),
      text: () => Promise.resolve("upstream unavailable")
    }));

    const error = await apiGet("/health").catch((value) => value);

    expect(error).toMatchObject({ status: 502, body: "upstream unavailable" });
  });
});
