import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimGateway } from "../../api/setup";
import { GatewayClaimPanel } from "./GatewayClaimPanel";

vi.mock("../../api/setup", () => ({ claimGateway: vi.fn() }));
const claimGatewayMock = vi.mocked(claimGateway);

describe("GatewayClaimPanel", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("제조 시리얼과 일회성 등록 코드로 게이트웨이를 claim한다", async () => {
    claimGatewayMock.mockResolvedValue({ status: "claimed", gatewayId: "gateway-1", siteId: "site-1", serialNumber: "GW-001" });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    render(<QueryClientProvider client={queryClient}><GatewayClaimPanel siteId="site-1" /></QueryClientProvider>);

    expect(screen.getByRole("region", { name: "Gateway 연결" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Viewer 설치 대기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "게이트웨이 등록" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("제품 시리얼"), { target: { value: " GW-001 " } });
    fireEvent.change(screen.getByLabelText("일회성 등록 코드"), { target: { value: " once-1234 " } });
    fireEvent.click(screen.getByRole("button", { name: "게이트웨이 등록" }));

    await waitFor(() => expect(claimGatewayMock).toHaveBeenCalledWith({
      siteId: "site-1", name: "메인 게이트웨이", serialNumber: "GW-001", claimCode: "once-1234"
    }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });
});
