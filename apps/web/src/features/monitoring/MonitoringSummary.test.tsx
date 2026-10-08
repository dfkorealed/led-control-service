import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MonitoringSummary } from "./MonitoringSummary";

describe("MonitoringSummary", () => {
  afterEach(() => cleanup());

  it("keeps map counts read-only without a second filter entry point", () => {
    render(<MonitoringSummary scope="floor" mapName="B1" total={62} online={57} fault={3} offline={null} />);
    const summary = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(summary).getByRole("group", { name: "전체 조명" })).toHaveTextContent("62");
    expect(within(summary).queryByRole("button")).not.toBeInTheDocument();
    expect(within(summary).getByRole("group", { name: "오프라인" })).toHaveTextContent("집계 준비 중");
    expect(screen.getByText("B1 · 조명 현황")).toBeVisible();
  });

  it("separates authoritative site and floor scopes", () => {
    render(<>
      <MonitoringSummary scope="site" total={248} online={237} fault={7} offline={4} />
      <MonitoringSummary scope="floor" total={62} online={57} fault={3} offline={2} />
    </>);
    const site = screen.getByRole("region", { name: "현장 전체 조명 현황" });
    const floor = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(site).getByRole("group", { name: "현장 조명" })).toHaveTextContent("248");
    expect(within(site).getByRole("group", { name: "현장 오프라인" })).toHaveTextContent("4");
    expect(within(floor).getByRole("group", { name: "전체 조명" })).toHaveTextContent("62");
    expect(within(floor).getByRole("group", { name: "오프라인" })).toHaveTextContent("2");
    for (const helper of ["현장 전체 기준", "선택 층 기준", "최근 수신 정상", "우선 점검 대상", "상태 확인 대기 포함"]) {
      expect(screen.queryByText(helper)).not.toBeInTheDocument();
    }
  });

  it("keeps real zero distinct from a missing summary", () => {
    render(<>
      <MonitoringSummary scope="site" total={0} online={0} fault={0} offline={0} />
      <MonitoringSummary scope="floor" total={null} online={null} fault={null} offline={null} />
    </>);
    expect(within(screen.getByRole("region", { name: "현장 전체 조명 현황" })).getByRole("group", { name: "현장 조명" })).toHaveTextContent("0");
    const floor = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(floor).getByRole("group", { name: "전체 조명" })).toHaveTextContent("집계 준비 중");
    expect(floor).not.toHaveTextContent("0");
  });
});
