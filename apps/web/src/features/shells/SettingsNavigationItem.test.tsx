import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../api/auth";
import { SettingsNavigationItem } from "./SettingsNavigationItem";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function mockMatchMedia({ coarse = false }: { coarse?: boolean } = {}) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: coarse && query === "(hover: none), (pointer: coarse)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}

function renderSettingsItem({
  role,
  initialEntry
}: {
  role: AuthUser["role"];
  initialEntry: string;
}) {
  const search = initialEntry.includes("?") ? initialEntry.slice(initialEntry.indexOf("?")) : "";
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SettingsNavigationItem role={role} search={search} />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("SettingsNavigationItem", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens admin settings links on hover and closes with Escape", () => {
    mockMatchMedia();
    renderSettingsItem({ role: "admin", initialEntry: "/monitoring?siteId=site-1" });
    const trigger = screen.getByRole("link", { name: "설정" });

    fireEvent.mouseEnter(trigger.closest("div")!);

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-controls", "settings-navigation-popup");
    expect(screen.getByRole("menu", { name: "설정 메뉴" })).toHaveAttribute("id", "settings-navigation-popup");
    expect(screen.getByRole("menuitem", { name: "설정 개요" })).toHaveAttribute("href", "/settings?siteId=site-1");
    expect(screen.getByRole("menuitem", { name: "도면 관리" })).toHaveAttribute("href", "/settings/floor-plans?siteId=site-1");
    expect(screen.getByRole("menuitem", { name: "비밀번호 변경" })).toBeVisible();

    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(screen.queryByRole("menuitem", { name: "도면 관리" })).not.toBeInTheDocument();
  });

  it("does not expose admin-only security to a viewer", () => {
    mockMatchMedia();
    renderSettingsItem({ role: "viewer", initialEntry: "/settings?siteId=site-1" });

    fireEvent.focus(screen.getByRole("link", { name: "설정" }));

    expect(screen.getByRole("menuitem", { name: "도면 관리" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "비밀번호 변경" })).not.toBeInTheDocument();
  });

  it("opens the mobile sheet instead of navigating on a coarse pointer", () => {
    mockMatchMedia({ coarse: true });
    renderSettingsItem({ role: "admin", initialEntry: "/monitoring?siteId=site-1" });

    fireEvent.click(screen.getByRole("link", { name: "설정" }));

    const trigger = screen.getByRole("link", { name: "설정" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-controls", "settings-navigation-popup");
    expect(screen.getByRole("dialog", { name: "설정 메뉴" })).toHaveAttribute("id", "settings-navigation-popup");
    expect(screen.getByTestId("location")).toHaveTextContent("/monitoring?siteId=site-1");
  });
});
