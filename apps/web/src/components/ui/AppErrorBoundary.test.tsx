import { lazy, Suspense } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Broken(): never { throw new Error("secret-tenant-url-stack"); }

it("catches blank roots/raw render errors and uses a full document reload", async () => {
  const reload = vi.fn();
  render(<AppErrorBoundary onRelogin={vi.fn()} onReload={reload} resetKey={0}><Broken /></AppErrorBoundary>);
  expect(screen.getByRole("heading", { name: "화면을 불러오지 못했습니다" })).toHaveFocus();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("alert")).not.toHaveTextContent("secret-tenant-url-stack");
  fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
  expect(reload).toHaveBeenCalledOnce();
});
it("catches rejected lazy promises without repeatedly remounting the failed child", async () => {
  const load = vi.fn(async () => { throw new Error("secret-chunk-url"); });
  const BrokenLazy = lazy(load);
  const relogin = vi.fn();
  const { rerender } = render(<AppErrorBoundary onRelogin={relogin} resetKey={0}><Suspense fallback="loading"><BrokenLazy /></Suspense></AppErrorBoundary>);
  const heading = await screen.findByRole("heading", { name: "화면을 불러오지 못했습니다" });
  // 비동기 lazy 실패에서는 복구 DOM 출현과 passive focus effect 완료가 별개다.
  // 기본 대기 제한 안에서 실제 포커스까지 확인해 접근성 계약을 유지한다.
  await waitFor(() => expect(heading).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
  expect(relogin).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
  expect(document.body).not.toHaveTextContent("secret-chunk-url");
  rerender(<AppErrorBoundary onRelogin={relogin} resetKey={1}><main>로그인 준비 완료</main></AppErrorBoundary>);
  expect(screen.getByRole("main")).toHaveTextContent("로그인 준비 완료");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
