import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicLogin } from "./PublicLogin";
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
it("landing default remains disabled", () => {
  vi.stubEnv("VITE_PUBLIC_DEPLOY_MODE", "landing");
  vi.stubEnv("VITE_LANDING_SERVICE_URL", "");
  render(<PublicLogin />);
  expect(screen.getByRole("button", { name: "준비 중" })).toBeDisabled();
});
it.each(["service", undefined])("service and ordinary app use same-origin login (%s)", mode => {
  vi.stubEnv("VITE_PUBLIC_DEPLOY_MODE", mode);
  vi.stubEnv("VITE_LANDING_SERVICE_URL", "https://control.dfkorealed.com/login");
  render(<PublicLogin />);
  expect(screen.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", "/login");
});
