import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDashboard, mockEnergyEstimate } from "./api/mock";
import { App } from "./App";

const authState = vi.hoisted(() => ({
  user: {
    id: "user-1",
    organizationId: "organization-1",
    email: "operator@example.com",
    name: "Demo Operator",
    role: "admin",
    status: "active"
  } as null | {
    id: string;
    organizationId: string;
    email: string;
    name: string;
    role: string;
    status: string;
  }
}));

vi.mock("./api/client", () => ({
  apiGet: vi.fn((path: string) => {
    if (path === "/auth/me") {
      return authState.user ? Promise.resolve({ user: authState.user }) : Promise.reject(new Error("Unauthorized"));
    }
    if (path === "/sites/default/dashboard") return Promise.resolve(mockDashboard);
    if (path === "/energy/default/estimate") return Promise.resolve(mockEnergyEstimate);
    return Promise.reject(new Error(`No mock for ${path}`));
  }),
  apiPost: vi.fn(() => Promise.resolve({ status: "accepted" }))
}));

describe("App", () => {
  afterEach(() => {
    authState.user = {
      id: "user-1",
      organizationId: "organization-1",
      email: "operator@example.com",
      name: "Demo Operator",
      role: "admin",
      status: "active"
    };
    cleanup();
  });

  it("renders the login form when no authenticated session exists", async () => {
    authState.user = null;
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("heading", { name: "LED Control 로그인" })).toBeInTheDocument();
    expect(screen.getByLabelText("아이디")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
    expect(screen.getByLabelText("자동 로그인")).toBeInTheDocument();
  });

  it("renders the four primary navigation items", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByRole("button", { name: "모니터링" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "제어" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "통계" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "설정" })).toBeInTheDocument();
  });

  it("renders the approved control center landmarks", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(await screen.findByText("B2 운영 현황")).toBeInTheDocument();
    expect(screen.getAllByText("관제 센터").length).toBeGreaterThan(0);
    expect(await screen.findByText("상세 패널")).toBeInTheDocument();
  });

  it("renders redesigned landmarks for control statistics and settings", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "제어" }));
    expect(await screen.findByText("빠른 밝기 제어")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "통계" }));
    expect(await screen.findByText("에너지 리포트")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "설정" }));
    expect(await screen.findByText("운영 설정")).toBeInTheDocument();
  });
});
