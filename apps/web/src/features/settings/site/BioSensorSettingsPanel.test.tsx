import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../../../api/automation";
import { BioSensorSettingsPanel } from "./BioSensorSettingsPanel";
vi.mock("../../../api/automation", async original => ({ ...await original<typeof import("../../../api/automation")>(), getBioSensorPolicy: vi.fn(), saveBioSensorPolicy: vi.fn() }));
vi.mock("../../../api/queries", async original => ({ ...await original<typeof import("../../../api/queries")>(), useControlDashboard: () => ({ data: undefined, refetch: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
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
