import { onlineManager } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entry = vi.hoisted(() => ({ element: null as ReactNode | null }));

// Capture the real browser entry element without attaching a second React root in jsdom.
vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: (element: ReactNode) => { entry.element = element; } }) }
}));

import "../../main";

beforeEach(() => {
  onlineManager.setOnline(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("browser entry route", () => {
  it("shows the public landing with a contact anchor without requesting auth", async () => {
    window.history.replaceState({}, "", "/");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(entry.element);
    expect(screen.getByRole("heading", { name: /조명 운영을 간단하게/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /상담/ }).every((link) => link.getAttribute("href") === "#contact")).toBe(true);
    expect(screen.getByRole("img", { name: "킨다" })).toBeInTheDocument();
    await act(async () => undefined);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/me"))).toBe(false);
  });

  it("keeps the existing login auth check at /login", async () => {
    window.history.replaceState({}, "", "/login");
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(entry.element);
    expect(await screen.findByRole("heading", { name: "킨다 로그인" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/me"))).toBe(true);
  });
});
