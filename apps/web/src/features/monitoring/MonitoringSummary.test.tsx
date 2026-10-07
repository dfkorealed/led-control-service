import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MonitoringSummary } from "./MonitoringSummary";

describe("MonitoringSummary", () => {
  afterEach(() => cleanup());

  it("presents unknown counts as a dash and real zero in a read-only inline summary", () => {
    render(<MonitoringSummary scope="floor" mapName="B1" total={24} online={null} fault={0} offline={4} />);
    const summary = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(summary).getByText("전체 조명").parentElement).toHaveTextContent("24");
    expect(within(summary).getByText("정상").parentElement).toHaveTextContent("—");
    expect(within(summary).getByText("점검 필요").parentElement).toHaveTextContent("0");
    expect(within(summary).queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps map counts read-only without a second filter entry point", () => {
    render(<MonitoringSummary scope="floor" mapName="B1" total={62} online={57} fault={3} offline={null} />);
    const summary = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(summary).getByText("전체 조명").parentElement).toHaveTextContent("62");
    expect(within(summary).queryByRole("button")).not.toBeInTheDocument();
    expect(within(summary).getByText("오프라인").parentElement).toHaveTextContent("—");
    expect(within(summary).getByRole("group", { name: "B1 · 조명 현황" })).toBeVisible();
  });

  it("separates authoritative site and floor scopes", () => {
    render(<>
      <MonitoringSummary scope="site" total={248} online={237} fault={7} offline={4} />
      <MonitoringSummary scope="floor" total={62} online={57} fault={3} offline={2} />
    </>);
    const site = screen.getByRole("region", { name: "현장 전체 조명 현황" });
    const floor = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(site).getByText("현장 조명").parentElement).toHaveTextContent("248");
    expect(within(site).getByText("현장 오프라인").parentElement).toHaveTextContent("4");
    expect(within(floor).getByText("전체 조명").parentElement).toHaveTextContent("62");
    expect(within(floor).getByText("오프라인").parentElement).toHaveTextContent("2");
    for (const helper of ["현장 전체 기준", "선택 층 기준", "최근 수신 정상", "우선 점검 대상", "상태 확인 대기 포함"]) {
      expect(screen.queryByText(helper)).not.toBeInTheDocument();
    }
  });

  it("keeps real zero distinct from a missing summary", () => {
    render(<>
      <MonitoringSummary scope="site" total={0} online={0} fault={0} offline={0} />
      <MonitoringSummary scope="floor" total={null} online={null} fault={null} offline={null} />
    </>);
    expect(within(screen.getByRole("region", { name: "현장 전체 조명 현황" })).getByText("현장 조명").parentElement).toHaveTextContent("0");
    const floor = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(floor).getByText("전체 조명").parentElement).toHaveTextContent("—");
    expect(floor).not.toHaveTextContent("0");
  });
});
