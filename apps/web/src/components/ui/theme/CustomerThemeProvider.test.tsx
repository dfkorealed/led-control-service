import { StrictMode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerThemeProvider, useCustomerTheme } from "./CustomerThemeProvider";
import { customerThemeStorageKey, parseCustomerThemePreference } from "./customer-theme";
import { ThemeToggle } from "./ThemeToggle";
import { useThemeColors } from "./useThemeColors";

let style: HTMLStyleElement;
beforeEach(() => {
  localStorage.clear(); document.documentElement.removeAttribute("data-customer-theme");
  style = document.createElement("style");
  // JSDOM does not resolve custom-property aliases; Task2 real Chromium tests
  // own the alias contract. These selectors exercise live computed publication.
  style.textContent = ':root { --color-surface-canvas: #F4F8FA; } :root[data-customer-theme="light"] { --color-surface-canvas: #F4F7FB; } :root[data-customer-theme="dark"] { --color-surface-canvas: #0F1724; }';
  document.head.append(style);
});
afterEach(() => { cleanup(); style.remove(); vi.restoreAllMocks(); document.documentElement.removeAttribute("data-customer-theme"); localStorage.clear(); });

function Probe() {
  const { theme, persistence } = useCustomerTheme();
  const palette = useThemeColors();
  return <><ThemeToggle /><output data-testid="theme">{theme}/{persistence}/{palette["surface-canvas"]}</output></>;
}
function mount() { return render(<CustomerThemeProvider><Probe /></CustomerThemeProvider>); }
describe("customer theme preference", () => {
  it("reserves a nonshrinking customer frame while preserving the native toggle identity and preference", () => {
    mount();
    const toggle = screen.getByRole("button", { name: "다크 모드로 변경" });
    // JSDOM checks the approved frame declaration; real-browser continuous44
    // and mobile header-fit evidence are recorded separately.
    expect(toggle).toHaveClass("size-13", "shrink-0");
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "라이트 모드로 변경" })).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(customerThemeStorageKey)).toBe("dark");
    expect(toggle).toHaveClass("size-13", "shrink-0");
  });
  it("defaults invalid and missing preferences without accepting approximate dark values", () => {
    expect(parseCustomerThemePreference("dark")).toBe("dark");
    for (const input of [null, "corrupted", "DARK", " dark", "light"]) expect(parseCustomerThemePreference(input)).toBe("light");
  });
  it("restores stored dark on first customer commit and persists explicit toggles", () => {
    localStorage.setItem(customerThemeStorageKey, "dark"); mount();
    expect(screen.getByTestId("theme")).toHaveTextContent("dark/available/#0F1724");
    expect(document.documentElement).toHaveAttribute("data-customer-theme", "dark");
    expect(screen.getByRole("button", { name: "라이트 모드로 변경" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "라이트 모드로 변경" }));
    expect(localStorage.getItem(customerThemeStorageKey)).toBe("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("light/available/#F4F7FB");
  });
  it("preserves in-memory dark when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    mount(); fireEvent.click(screen.getByRole("button", { name: "다크 모드로 변경" }));
    expect(screen.getByTestId("theme")).toHaveTextContent("dark/unavailable/#0F1724");
    expect(document.documentElement).toHaveAttribute("data-customer-theme", "dark");
  });
  it("applies cross-tab clear as light and removes its listener on logout", () => {
    const mounted = mount();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: customerThemeStorageKey, newValue: "dark", storageArea: localStorage })));
    expect(screen.getByTestId("theme")).toHaveTextContent("dark/available/#0F1724");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: customerThemeStorageKey, newValue: null, storageArea: localStorage })));
    expect(screen.getByTestId("theme")).toHaveTextContent("light/available/#F4F7FB");
    mounted.unmount();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: customerThemeStorageKey, newValue: "dark" })));
    expect(document.documentElement).not.toHaveAttribute("data-customer-theme");
  });
  it("ignores unrelated and session storage changes but handles origin clear", () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "다크 모드로 변경" }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "account", newValue: "light", storageArea: localStorage })));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: customerThemeStorageKey, newValue: "light", storageArea: sessionStorage })));
    expect(screen.getByTestId("theme")).toHaveTextContent("dark/");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })));
    expect(screen.getByTestId("theme")).toHaveTextContent("light/");
  });
  it("restores only its root attributes after StrictMode and logout", () => {
    document.documentElement.dataset.nativeFrame = "preserve";
    document.documentElement.style.colorScheme = "light";
    const mounted = render(<StrictMode><CustomerThemeProvider><Probe /></CustomerThemeProvider></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "다크 모드로 변경" }));
    expect(document.documentElement).toHaveAttribute("data-customer-theme", "dark");
    mounted.unmount();
    expect(document.documentElement).not.toHaveAttribute("data-customer-theme");
    expect(document.documentElement.dataset.nativeFrame).toBe("preserve");
    expect(document.documentElement.style.colorScheme).toBe("light");
    delete document.documentElement.dataset.nativeFrame; document.documentElement.style.removeProperty("color-scheme");
  });
  it("restores prior ownership without overwriting another root owner's marker", () => {
    document.documentElement.dataset.customerTheme = "previous";
    const first = mount(); first.unmount();
    expect(document.documentElement.dataset.customerTheme).toBe("previous");
    const second = mount(); document.documentElement.dataset.customerTheme = "other-owner"; second.unmount();
    expect(document.documentElement.dataset.customerTheme).toBe("other-owner");
  });
  it("does not restore a released customer's marker during overlapping boundary cleanup", () => {
    const first = mount();
    localStorage.setItem(customerThemeStorageKey, "dark");
    const second = mount();
    expect(document.documentElement).toHaveAttribute("data-customer-theme", "dark");
    first.unmount();
    expect(document.documentElement).toHaveAttribute("data-customer-theme", "dark");
    second.unmount();
    expect(document.documentElement).not.toHaveAttribute("data-customer-theme");
  });
  it("updates an open body portal without remounting children or changing route/query identity", () => {
    const queryClient = new QueryClient(); let mounts = 0; let unmounts = 0;
    function Child() {
      const client = useQueryClient(); const location = useLocation(); const palette = useThemeColors();
      const [draft, setDraft] = useState("70");
      useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
      expect(client).toBe(queryClient);
      return <><Probe /><input aria-label="brightness draft" value={draft} onChange={event => setDraft(event.target.value)} />{createPortal(<output data-testid="portal">{`${location.pathname}${location.search}${location.hash}/${palette["surface-canvas"]}`}</output>, document.body)}</>;
    }
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/control?siteId=site#draft"]}><CustomerThemeProvider><Child /></CustomerThemeProvider></MemoryRouter></QueryClientProvider>);
    const portal = screen.getByTestId("portal"); const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: "다크 모드로 변경" }));
    expect(screen.getByTestId("portal")).toBe(portal); expect(screen.getByRole("textbox")).toBe(input);
    expect(portal).toHaveTextContent("/control?siteId=site#draft/#0F1724"); expect(input).toHaveValue("35");
    expect(mounts).toBe(1); expect(unmounts).toBe(0);
  });
  it("reads the existing default palette outside the customer provider", () => {
    function DefaultProbe() { return <output>{useThemeColors()["surface-canvas"]}</output>; }
    render(<DefaultProbe />); expect(screen.getByText("#F4F8FA")).toBeInTheDocument();
  });
});
