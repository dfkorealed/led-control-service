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
  it("shows the public field-day landing without requesting auth", async () => {
    window.history.replaceState({}, "", "/");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(entry.element);
    expect(screen.getByRole("heading", { level: 1, name: /현장의 하루.*한눈에 이어지다/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /도입 상담/ })).toHaveLength(3);
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

  for (const [path, heading] of [["/features", "현장 운영에 필요한 네 가지 흐름"], ["/pricing", "현장에 맞는 운영 방식을 선택하세요."]] as const) {
    it(`renders ${path} publicly without an auth request`, async () => {
      window.history.replaceState({}, "", path);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      render(entry.element);
      expect(screen.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await act(async () => undefined);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/me"))).toBe(false);
    });
  }
});
