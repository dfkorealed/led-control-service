import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { BioSensorSettingsPanel } from "./BioSensorSettingsPanel";
vi.mock("../../../api/automation", async original => ({ ...await original<typeof import("../../../api/automation")>(), getBioSensorPolicy: vi.fn(), saveBioSensorPolicy: vi.fn() }));
const dashboardQuery = vi.hoisted(() => vi.fn((): { data: Dashboard | undefined; refetch: ReturnType<typeof vi.fn> } => ({ data: undefined, refetch: vi.fn() })));
vi.mock("../../../api/queries", async original => ({ ...await original<typeof import("../../../api/queries")>(), useControlDashboard: dashboardQuery }));
afterEach(() => { cleanup(); vi.clearAllMocks(); dashboardQuery.mockReturnValue({ data: undefined, refetch: vi.fn() }); });
const off = { enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null, revision: 1 };
function renderPanel() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><BioSensorSettingsPanel siteId="site" ownerUserId="admin-id" canPrepare /></QueryClientProvider>); }
it("keeps policy OFF by default and blocks ON without response metadata", async () => {
  vi.mocked(api.getBioSensorPolicy).mockResolvedValue(off); renderPanel();
  const toggle = await screen.findByRole("checkbox", { name: "현장 이벤트 운영 허용" }); expect(toggle).not.toBeChecked();
  fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: "센서 운영 정책 저장" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/대응 시간.*조치/); expect(api.saveBioSensorPolicy).not.toHaveBeenCalled();
});
it("uses the current assigned administrator as policy owner and saves editable OFF drafts", async () => {
  vi.mocked(api.getBioSensorPolicy).mockResolvedValue(off); vi.mocked(api.saveBioSensorPolicy).mockResolvedValue({ ...off, revision: 2 }); renderPanel();
  await screen.findByRole("checkbox", { name: "현장 이벤트 운영 허용" });
  fireEvent.change(screen.getByRole("textbox", { name: "최대 대응 시간 (초)" }), { target: { value: "90" } });
  fireEvent.change(screen.getByRole("textbox", { name: "연결 이상 시 조치" }), { target: { value: "현장 점검 담당자 호출" } });
  fireEvent.click(screen.getByRole("button", { name: "센서 운영 정책 저장" }));
  await waitFor(() => expect(api.saveBioSensorPolicy).toHaveBeenCalledWith("site", { enabled: false, ownerUserId: "admin-id", maximumResponseSeconds: 90, escalationAction: "현장 점검 담당자 호출" }));
});

it("keeps a legacy blocked fixture reachable at the registration recovery section without sending device work", async () => {
  vi.mocked(api.getBioSensorPolicy).mockResolvedValue(off);
  dashboardQuery.mockReturnValue({ data: { site: { id: "site" }, floors: [{ fixtures: [{ id: "legacy-source", name: "B1-L004",
    status: "online", gateway: { id: "gateway", assignmentVersion: 3, connectionStatus: "online" },
    bioSensorPreparation: { preparationCandidate: false, status: "unverified", commandId: null, profileKey: null,
      observedAt: null, blockedReasons: ["binding_changed"] },
    vehicleEventSource: { sensorProtocol: "bluez-stateful", sourceEligible: false, readiness: "off" }
  }] }] } as Dashboard, refetch: vi.fn() });
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /준비 상태를 확인할 조명/ }));
  fireEvent.click(await screen.findByRole("option", { name: "B1-L004" }));
  expect(screen.getByRole("button", { name: "등록 연결 확인" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "센서 사용 설정" })).toBeDisabled();
  expect(screen.getByRole("heading", { name: "등록 조명 센서 준비" }).closest("#bio-sensor-preparation")).not.toBeNull();
});
