import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  capabilities = manageCapabilities,
  coarse = false,
  initialEntry
}: {
  capabilities?: SiteCapabilities;
  coarse?: boolean;
  initialEntry: string;
}) {
  mockMatchMedia({ coarse });
  const search = new URL(initialEntry, "http://localhost").search;
  return render(
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

  it("설정 아이콘과 라벨만 표시한다", () => {
    const { container } = renderSettingsItem({
      capabilities: readCapabilities,
      initialEntry: "/monitoring?siteId=site-1"
    });

    const link = screen.getByRole("link", { name: "설정" });
    expect(link.querySelector(".lucide-settings")).toBeInTheDocument();
    expect(container.querySelector(".lucide-chevron-right")).not.toBeInTheDocument();
  });

  it("search와 현재 hash를 보존해 설정 루트로 이동한다", () => {
    renderSettingsItem({ initialEntry: "/monitoring?siteId=site-1#fragment" });

    const link = screen.getByRole("link", { name: "설정" });
    expect(link).toHaveAttribute("href", "/settings?siteId=site-1#fragment");

    fireEvent.click(link);

    expect(screen.getByTestId("location")).toHaveTextContent("/settings?siteId=site-1#fragment");
  });

  it.each([
    ["/settings?siteId=site-1", true],
    ["/settings/floor-plans?siteId=site-1", true],
    ["/monitoring?siteId=site-1", false]
  ])("현재 경로가 %s일 때 active 상태를 %s로 표시한다", (initialEntry, active) => {
    renderSettingsItem({ initialEntry });

    const link = screen.getByRole("link", { name: "설정" });
    if (active) {
      expect(link).toHaveClass("active");
      expect(link).toHaveAttribute("aria-current", "page");
    } else {
      expect(link).not.toHaveClass("active");
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("hover와 focus에도 설정 서브메뉴를 열지 않는다", () => {
    renderSettingsItem({ initialEntry: "/monitoring?siteId=site-1" });
    const link = screen.getByRole("link", { name: "설정" });

    fireEvent.mouseEnter(link);
    fireEvent.focus(link);

    expect(link).not.toHaveAttribute("aria-expanded");
    expect(link).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("navigation", { name: "설정 메뉴" })).not.toBeInTheDocument();
  });

  it("coarse pointer에서도 bottom sheet 없이 설정 링크로 이동한다", () => {
    renderSettingsItem({ coarse: true, initialEntry: "/monitoring?siteId=site-1#mobile" });

    const link = screen.getByRole("link", { name: "설정" });
    fireEvent.click(link);

    expect(screen.getByTestId("location")).toHaveTextContent("/settings?siteId=site-1#mobile");
    expect(screen.queryByRole("button", { name: "설정 메뉴 닫기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "설정 메뉴" })).not.toBeInTheDocument();
  });
});
