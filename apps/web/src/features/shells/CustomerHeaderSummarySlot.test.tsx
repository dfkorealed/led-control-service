import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CustomerHeaderSummarySlot, type CustomerShellScope, type CustomerSiteSummary } from "./CustomerHeaderSummarySlot";
const scope: CustomerShellScope = { principalKey: "account-a", siteId: "site-a", pathname: "/monitoring" };
const ready: CustomerSiteSummary = { scope, siteName: "긴 현장 이름", state: "ready", counts: { totalFixtures: 17, onlineFixtures: 0, faultFixtures: null, offlineFixtures: null } };
afterEach(cleanup);
it("rejects summary values from a different principal or site", () => {
  const { rerender } = render(<CustomerHeaderSummarySlot currentScope={{ ...scope, principalKey: "account-b" }} value={ready} />);
  expect(screen.queryByRole("region", { name: "현장 전체" })).not.toBeInTheDocument();
  rerender(<CustomerHeaderSummarySlot currentScope={{ ...scope, siteId: "site-b" }} value={ready} />);
  expect(screen.queryByRole("region", { name: "현장 전체" })).not.toBeInTheDocument();
});
it("preserves unknown counts separately from actual zero, loading and errors", () => {
  const { rerender } = render(<CustomerHeaderSummarySlot currentScope={scope} value={ready} />);
  expect(screen.getByRole("region", { name: "현장 전체" })).toHaveTextContent("17대");
  expect(screen.getByText("0대")).toBeVisible();
  expect(screen.getAllByText("—")).toHaveLength(2);
  rerender(<CustomerHeaderSummarySlot currentScope={scope} value={{ scope, siteName: "긴 현장 이름", state: "loading" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("확인 중");
  expect(screen.queryByText("0대")).not.toBeInTheDocument();
  rerender(<CustomerHeaderSummarySlot currentScope={scope} value={{ scope, siteName: "긴 현장 이름", state: "error" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("확인 불가");
});

it("keeps compact aggregate collapsed until explicit disclosure", () => {
  render(<CustomerHeaderSummarySlot compact currentScope={scope} value={ready} />);
  expect(screen.getByText("0대")).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "현장 전체 보기" }));
  expect(screen.getByText("0대")).toBeVisible();
  expect(screen.getByRole("button", { name: "현장 전체 접기" })).toHaveAttribute("aria-expanded", "true");
});
