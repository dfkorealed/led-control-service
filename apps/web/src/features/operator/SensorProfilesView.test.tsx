import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../../api/automation";
import { SensorProfilesView } from "./SensorProfilesView";
vi.mock("../../api/automation", async original => ({ ...await original<typeof import("../../api/automation")>(), listBioSensorProfiles: vi.fn(), createBioSensorProfile: vi.fn(), revokeBioSensorProfile: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function renderView() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SensorProfilesView /></QueryClientProvider>); }
it("keeps an empty approval catalog honest and refuses malformed approval without a write", async () => {
  vi.mocked(api.listBioSensorProfiles).mockResolvedValue([]); renderView();
  expect(await screen.findByText(/승인된 호환 프로파일이 없습니다/)).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "승인 프로파일 JSON" }), { target: { value: '{"status":"approved"}' } });
  fireEvent.click(screen.getByRole("checkbox", { name: /검증 근거와 재사용 범위/ }));
  fireEvent.click(screen.getByRole("button", { name: "프로파일 승인 등록" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/형식/); expect(api.createBioSensorProfile).not.toHaveBeenCalled();
});
it("appends a validated evidence approval and invalidates summaries", async () => {
  vi.mocked(api.listBioSensorProfiles).mockResolvedValue([]); vi.mocked(api.createBioSensorProfile).mockResolvedValue({ profileId: "00000000-0000-4000-8000-000000000012", revision: 1, status: "approved" }); renderView();
  await screen.findByText(/승인된 호환 프로파일이 없습니다/);
  const approved = { profileId: "00000000-0000-4000-8000-000000000012", revision: 1, status: "approved", fingerprint: { deviceType: 1, firmware: { major: 2, minor: 3, revision: 4, build: 5 }, sensorType: 6, infraredType: 7, ambientLightType: 8, hardwareType: 9 }, bodyHexes: ["0101000000000000"], linkPolicy: { kind: "mode-get", probeIntervalMs: 1000, maxAgeMs: 5000 }, evidenceDigest: `sha256:${"b".repeat(64)}`, reuseScope: "검증된 시험 장비군" };
  fireEvent.change(screen.getByRole("textbox", { name: "승인 프로파일 JSON" }), { target: { value: JSON.stringify(approved) } });
  fireEvent.click(screen.getByRole("checkbox", { name: /검증 근거와 재사용 범위/ })); fireEvent.click(screen.getByRole("button", { name: "프로파일 승인 등록" }));
  await waitFor(() => expect(api.createBioSensorProfile).toHaveBeenCalledWith(approved));
  expect(await screen.findByText(/승인 등록 요청을 저장/)).toBeVisible();
});
