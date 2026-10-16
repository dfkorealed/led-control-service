import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";

const entry = vi.hoisted(() => ({ roots: [] as Root[], reject: undefined as undefined | ((reason: Error) => void) }));
vi.mock("react-dom/client", async importOriginal => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return { ...actual, default: { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => {
    const root = actual.createRoot(...args); entry.roots.push(root); return root;
  } } };
});
vi.mock("../../features/mobile/mobile-environment", () => ({ requiresNativeBootstrap: () => true }));
vi.mock("../../features/mobile/mobile-bootstrap", () => ({ startMobileWebEntry: () => new Promise((_resolve, reject) => { entry.reject = reject; }) }));
vi.mock("../../AppRoot", () => ({ AppRoot: () => null }));
vi.mock("../../features/landing/FieldDayConceptPage", () => ({ FieldDayConceptPage: () => null }));

afterEach(() => {
  act(() => entry.roots.splice(0).forEach(root => root.unmount()));
  cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals();
});

it.each(["main", "service-main"] as const)("%s preserves preparation announcement, failure recovery and functional spacing", async name => {
  document.body.innerHTML = '<div id="root"></div>';
  const reload = vi.fn(); vi.stubGlobal("location", { reload });
  await act(async () => { if (name === "main") await import("../../main"); else await import("../../service-main"); });
  const preparation = screen.getByRole("status");
  expect(preparation).toHaveTextContent("앱 연결을 준비하고 있습니다.");
  expect(preparation).toHaveClass("gap-5", "p-5", "max-compact:p-4");
  const preparationClass = preparation.className;
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  await act(async () => entry.reject!(new Error("fixture bootstrap failure")));
  const failure = screen.getByRole("alert");
  expect(failure).toHaveTextContent("앱 연결을 준비하지 못했습니다. 다시 시도해 주세요.");
  expect(failure.className).toBe(preparationClass);
  await act(async () => screen.getByRole("button", { name: "다시 연결" }).click());
  expect(reload).toHaveBeenCalledTimes(1);
});
