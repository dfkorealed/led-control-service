import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteCapabilities } from "../../api/queries";
import { SettingsNavigationItem } from "./SettingsNavigationItem";

const manageCapabilities: SiteCapabilities = { read: true, control: true, manage: true, commission: true };
const readCapabilities: SiteCapabilities = { read: true, control: false, manage: false, commission: false };

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
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
  capabilities,
  initialEntry
}: {
  capabilities: SiteCapabilities;
  initialEntry: string;
}) {
  const search = new URL(initialEntry, "http://localhost").search;
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SettingsNavigationItem capabilities={capabilities} search={search} />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("SettingsNavigationItem", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("설정 메뉴는 siteId와 현재 항목을 보존한다", () => {
    mockMatchMedia();
    renderSettingsItem({ capabilities: manageCapabilities, initialEntry: "/settings/floor-plans?siteId=site-1#fragment" });

    const trigger = screen.getByRole("link", { name: "설정" });
    fireEvent.focus(trigger);

    expect(screen.getByRole("navigation", { name: "설정 메뉴" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("href", "/settings?siteId=site-1#fragment");
    expect(screen.getByRole("link", { name: "설정 개요" })).toHaveAttribute("href", "/settings?siteId=site-1#fragment");
    expect(screen.getByRole("link", { name: "조명 등록" })).toHaveAttribute("href", "/settings/registration?siteId=site-1#fragment");
    expect(screen.getByRole("link", { name: "맵 관리" })).toHaveAttribute("href", "/settings/floor-plans?siteId=site-1#fragment");
    expect(screen.getByRole("link", { name: "비밀번호 변경" })).toHaveAttribute("href", "/settings/security?siteId=site-1#fragment");
    expect(screen.getByRole("link", { name: "맵 관리" })).toHaveAttribute("aria-current", "page");
  });

  it("모바일 설정 메뉴는 scrim과 bottom sheet focus 계약을 유지한다", async () => {
    mockMatchMedia({ coarse: true });
    renderSettingsItem({ capabilities: manageCapabilities, initialEntry: "/monitoring?siteId=site-1" });

    const trigger = screen.getByRole("button", { name: "설정" });
    fireEvent.click(trigger);

    expect(screen.getByRole("button", { name: "설정 메뉴 닫기" })).toHaveClass("settings-submenu-scrim");
    expect(screen.getByTestId("settings-submenu-grabber")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "설정 메뉴" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "설정 개요" })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole("navigation", { name: "설정 메뉴" }), { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "설정 메뉴" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens admin settings links on hover and closes with Escape", () => {
    mockMatchMedia();
    renderSettingsItem({ capabilities: manageCapabilities, initialEntry: "/monitoring?siteId=site-1" });
    const trigger = screen.getByRole("link", { name: "설정" });

    fireEvent.mouseEnter(trigger.closest("div")!);

    expect(trigger).toHaveAttribute("aria-controls", "settings-navigation-popup");
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    expect(screen.getByRole("navigation", { name: "설정 메뉴" })).toHaveAttribute("id", "settings-navigation-popup");
    expect(screen.getByRole("link", { name: "설정 개요" })).toHaveAttribute("href", "/settings?siteId=site-1");
    expect(screen.getByRole("link", { name: "조명 등록" })).toHaveAttribute("href", "/settings/registration?siteId=site-1");
    expect(screen.getByRole("link", { name: "맵 관리" })).toHaveAttribute("href", "/settings/floor-plans?siteId=site-1");
    expect(screen.getByRole("link", { name: "비밀번호 변경" })).toBeVisible();

    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(screen.queryByRole("navigation", { name: "설정 메뉴" })).not.toBeInTheDocument();
  });

  it("exposes personal security but no admin management sections to a viewer", () => {
    mockMatchMedia();
    renderSettingsItem({ capabilities: readCapabilities, initialEntry: "/settings?siteId=site-1" });

    fireEvent.focus(screen.getByRole("link", { name: "설정" }));

    expect(screen.getByRole("link", { name: "맵 관리" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "조명 등록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "유저 관리" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "비밀번호 변경" })).toBeVisible();
  });

  it("uses a button to open the coarse disclosure without navigating", () => {
    mockMatchMedia({ coarse: true });
    renderSettingsItem({ capabilities: manageCapabilities, initialEntry: "/monitoring?siteId=site-1" });

    fireEvent.click(screen.getByRole("button", { name: "설정" }));

    const trigger = screen.getByRole("button", { name: "설정" });
    expect(trigger).toHaveAttribute("aria-controls", "settings-navigation-popup");
    expect(trigger).not.toHaveAttribute("aria-current");
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    expect(screen.getByRole("navigation", { name: "설정 메뉴" })).toHaveAttribute("id", "settings-navigation-popup");
    expect(screen.getByTestId("location")).toHaveTextContent("/monitoring?siteId=site-1");
  });

  it.each([
    ["/settings?siteId=site-1", "설정 개요"],
    ["/settings/registration?siteId=site-1", "조명 등록"],
    ["/settings/floor-plans?siteId=site-1", "맵 관리"],
    ["/settings/security?siteId=site-1", "비밀번호 변경"]
  ])("exposes one current-page link for %s", (initialEntry, currentLabel) => {
    mockMatchMedia();
    renderSettingsItem({ capabilities: manageCapabilities, initialEntry });

    const trigger = screen.getByRole("link", { name: "설정" });
    fireEvent.focus(trigger);

    expect(trigger).not.toHaveAttribute("aria-current");
    for (const label of ["설정 개요", "조명 등록", "맵 관리", "비밀번호 변경"]) {
      const link = screen.getByRole("link", { name: label });
      if (label === currentLabel) expect(link).toHaveAttribute("aria-current", "page");
      else expect(link).not.toHaveAttribute("aria-current");
    }
  });
});
