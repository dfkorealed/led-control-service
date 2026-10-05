import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitoringSummary } from "./MonitoringSummary";

describe("MonitoringSummary", () => {
  afterEach(() => cleanup());

  it("keeps map counts visible while changing status only through the shared filter popover", async () => {
    const onSelect = vi.fn();
    render(<MonitoringSummary scope="floor" mapName="B1" total={62} online={57} fault={3} offline={null} filter="all" onSelect={onSelect} />);
    const summary = screen.getByRole("region", { name: "선택 층 조명 현황" });
    expect(within(summary).getByRole("group", { name: "전체 조명" })).toHaveTextContent("62");
    expect(within(summary).queryByRole("button", { name: "정상" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /맵 조명 상태 필터 상세 필터/ }));
    fireEvent.click(await screen.findByRole("button", { name: "정상" }));
    expect(onSelect).toHaveBeenCalledWith("online");
    expect(screen.queryByRole("button", { name: "정상" })).not.toBeInTheDocument();
    expect(screen.getByText("B1 · 조명 현황")).toBeVisible();
  });

  it("makes floor metrics interactive but keeps site metrics read-only", () => {
    const onSelect = vi.fn();
    render(<><MonitoringSummary scope="site" total={2} online={2} fault={0} offline={0} onSelect={onSelect} />
      <MonitoringSummary scope="floor" total={2} online={2} fault={0} offline={null} filter="fault" onSelect={onSelect} /></>);
    const floor = screen.getByRole("region", { name: "선택 층 조명 현황" });
    fireEvent.click(within(floor).getByRole("button", { name: /맵 조명 상태 필터 상세 필터/ }));
    expect(screen.getByRole("button", { name: "점검 필요" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "오프라인" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "점검 필요" }));
    expect(onSelect).toHaveBeenCalledWith("fault");
    expect(within(screen.getByRole("region", { name: "현장 전체 조명 현황" })).queryByRole("button")).toBeNull();
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
