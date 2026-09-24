import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FixtureGroupMetadata } from "@led-control/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { fixtureGroupQueryKey } from "../../../api/fixture-groups";
import {
  floorFixtureSettingsQueryKey,
  siteSettingsQueryKey,
  type SiteSettingsResponse
} from "../../../api/site-settings";
import { SiteOperationsView } from "./SiteOperationsView";

const siteApi = vi.hoisted(() => ({
  getSiteSettings: vi.fn(),
  updateSiteSettings: vi.fn(),
  createFloor: vi.fn(),
  updateFloor: vi.fn(),
  archiveFloor: vi.fn(),
  restoreFloor: vi.fn(),
  getFloorFixtureSettings: vi.fn(),
  updateFixtureMetadata: vi.fn()
}));

const groupApi = vi.hoisted(() => ({
  listFixtureGroups: vi.fn(),
  deleteFixtureGroup: vi.fn()
}));

vi.mock("../../../api/site-settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api/site-settings")>(),
  ...siteApi
}));

vi.mock("../../../api/fixture-groups", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api/fixture-groups")>(),
  ...groupApi
}));

const settings: SiteSettingsResponse = {
  site: {
    id: "site-1",
    name: "본사 주차장",
    address: "서울시 중구 세종대로 1",
    timeZone: "Asia/Seoul",
    currency: "KRW",
    tariffKwhRate: 158.75,
    updatedAt: "2026-09-12T00:00:00.000Z"
  },
  floors: [
    { id: "floor-1", name: "B2", level: -2, displayOrder: 1, status: "active", fixtureCount: 1, activeGroupCount: 1, updatedAt: "2026-09-12T00:00:00.000Z" },
    { id: "floor-empty", name: "B1", level: -1, displayOrder: 2, status: "active", fixtureCount: 0, activeGroupCount: 0, updatedAt: "2026-09-12T00:00:00.000Z" },
    { id: "floor-archived", name: "구 1층", level: 1, displayOrder: 3, status: "archived", fixtureCount: 0, activeGroupCount: 0, updatedAt: "2026-09-12T00:00:00.000Z" }
  ]
};

const fixturePageOne = {
  items: [{
    id: "fixture-1",
    name: "B2-L01",
    ratedWatt: 40,
    updatedAt: "2026-09-12T00:00:00.000Z",
    serialNumber: "LC-2026-0001",
    deviceUuid: "device-uuid-0001",
    meshAddress: "0x012A",
    firmwareVersion: "1.4.2"
  }],
  nextCursor: "fixture-1"
};

const fixturePageTwo = {
  items: [{
    ...fixturePageOne.items[0],
    id: "fixture-2",
    name: "B2-L02",
    updatedAt: "2026-09-12T00:00:00.000Z",
    deviceUuid: null,
    serialNumber: null,
    meshAddress: null,
    firmwareVersion: null
  }],
  nextCursor: null
};

const groups: FixtureGroupMetadata[] = [
  {
    id: "group-active",
    name: "B2 입구",
    floorId: "floor-1",
    gatewayId: "gateway-1",
    lifecycleStatus: "active",
    fixtureCount: 1,
    meshControlGroup: { status: "ready", version: 3, error: null }
  },
  {
    id: "group-retiring",
    name: "B1 이전 구역",
    floorId: "floor-empty",
    gatewayId: "gateway-1",
    lifecycleStatus: "retiring",
    fixtureCount: 0,
    meshControlGroup: { status: "retiring", version: 2, error: null }
  }
];

describe("SiteOperationsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    siteApi.getSiteSettings.mockResolvedValue(structuredClone(settings));
    siteApi.updateSiteSettings.mockResolvedValue(settings.site);
    siteApi.createFloor.mockResolvedValue({ ...settings.floors[1], id: "floor-new", name: "2층", level: 2 });
    siteApi.updateFloor.mockResolvedValue(settings.floors[1]);
    siteApi.archiveFloor.mockResolvedValue({ ...settings.floors[1], status: "archived" });
    siteApi.restoreFloor.mockResolvedValue({ ...settings.floors[2], status: "active" });
    siteApi.getFloorFixtureSettings.mockImplementation(async (_siteId: string, _floorId: string, cursor?: string) => cursor ? fixturePageTwo : fixturePageOne);
    siteApi.updateFixtureMetadata.mockResolvedValue({ id: "fixture-1", floorId: "floor-1", name: "B2-L01 수정", ratedWatt: 42, updatedAt: "2026-09-12T00:01:00.000Z" });
    groupApi.listFixtureGroups.mockResolvedValue(groups);
    groupApi.deleteFixtureGroup.mockResolvedValue({
      id: "group-active",
      lifecycleStatus: "retiring",
      meshControlGroup: { status: "retiring", version: 4, error: null }
    });
  });

  afterEach(cleanup);

  it("shows loading and retries a failed initial settings request", async () => {
    let release: ((value: SiteSettingsResponse) => void) | undefined;
    siteApi.getSiteSettings.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    renderView();
    expect(screen.getByText("현장 운영 정보를 불러오는 중입니다.")).toBeVisible();
    release?.(structuredClone(settings));
    expect(await screen.findByRole("heading", { name: "현장 정보" })).toBeVisible();

    cleanup();
    siteApi.getSiteSettings
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(structuredClone(settings));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent("현장 운영 정보를 불러오지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "현장 정보" })).toBeVisible();
  });

  it("keeps cached site settings visible and exposes refresh failure from a compact header status", async () => {
    const queryClient = renderView();
    expect(await screen.findByDisplayValue("본사 주차장")).toBeVisible();
    siteApi.getSiteSettings.mockRejectedValueOnce(new Error("network"));
    await queryClient.invalidateQueries({ queryKey: siteSettingsQueryKey("site-1") });

    const status = await screen.findByRole("button", { name: "운영 정보 갱신 실패 안내" });
    expect(screen.getByDisplayValue("본사 주차장")).toBeVisible();
    expect(screen.queryByRole("alert", { name: /최신 운영 정보를/ })).not.toBeInTheDocument();
    fireEvent.click(status);
    fireEvent.click(within(screen.getByRole("dialog", { name: "운영 정보 갱신 실패 안내" })).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(siteApi.getSiteSettings).toHaveBeenCalledTimes(3));
  });

  it("keeps loaded fixtures and groups visible after a background refresh failure", async () => {
    const queryClient = renderView();
    expect(await screen.findByText("B2-L01")).toBeVisible();
    expect(await screen.findByText("B2 입구")).toBeVisible();
    siteApi.getFloorFixtureSettings.mockRejectedValueOnce(new Error("network"));
    groupApi.listFixtureGroups.mockRejectedValueOnce(new Error("network"));
    await queryClient.invalidateQueries({ queryKey: floorFixtureSettingsQueryKey("site-1", "floor-1") });
    await queryClient.invalidateQueries({ queryKey: fixtureGroupQueryKey("site-1") });

    expect(screen.getByText("B2-L01")).toBeVisible();
    expect(screen.getByText("B2 입구")).toBeVisible();
    expect(await screen.findByRole("button", { name: "조명 목록 갱신 실패 안내" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "구역 목록 갱신 실패 안내" })).toBeVisible();
  });

  it("renders editable operations without exposing fixture placement controls", async () => {
    renderView();

    expect(await screen.findByDisplayValue("본사 주차장")).toBeVisible();
    expect(screen.getByRole("form", { name: "층 추가" })).toBeVisible();
    expect(screen.getByRole("button", { name: "B2 보관" })).toBeDisabled();
    expect(screen.getByText("조명 1개와 활성 구역 1개가 있어 보관할 수 없습니다.")).toBeVisible();
    expect(await screen.findByText("LC-2026-0001")).toBeVisible();
    expect(screen.getByText("0x012A")).toBeVisible();
    expect(screen.getByText("1.4.2")).toBeVisible();
    expect(screen.queryByLabelText(/X 위치|Y 위치|크기/)).not.toBeInTheDocument();
    expect(screen.getByText("B2 입구")).toBeVisible();
    expect(screen.getByText("B1 이전 구역")).toBeVisible();
    expect(screen.getByText(/구역 구성은 맵 관리에서/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "B1 이전 구역 보관" })).not.toBeInTheDocument();
  });

  it("requires installed-site billing fields and keeps currency fixed to KRW", async () => {
    renderView();

    expect(await screen.findByLabelText("주소")).toBeRequired();
    expect(screen.getByLabelText("kWh 단가")).toBeRequired();
    const currency = await screen.findByLabelText("통화");
    expect(currency).toHaveValue("KRW");
    expect(currency).toHaveAttribute("readonly");
  });

  it("rejects blank, malformed, and out-of-range tariff values before calling the API", async () => {
    renderView();
    const form = await screen.findByRole("form", { name: "현장 정보" });
    const tariff = within(form).getByLabelText("kWh 단가");
    const save = within(form).getByRole("button", { name: "현장 정보 저장" });

    fireEvent.change(tariff, { target: { value: "" } });
    fireEvent.click(save);
    expect(await within(form).findByRole("alert")).toHaveTextContent("kWh 단가를 입력하세요.");

    fireEvent.change(tariff, { target: { value: "1.234" } });
    fireEvent.click(save);
    expect(await within(form).findByRole("alert")).toHaveTextContent("소수점 둘째 자리까지");

    fireEvent.change(tariff, { target: { value: "100000000" } });
    fireEvent.click(save);
    expect(await within(form).findByRole("alert")).toHaveTextContent("0 이상 99,999,999.99 이하");
    expect(siteApi.updateSiteSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["0", 0],
    ["99999999.99", 99_999_999.99]
  ])("submits the tariff boundary %s as a number", async (draft, expected) => {
    renderView();
    const form = await screen.findByRole("form", { name: "현장 정보" });

    fireEvent.change(within(form).getByLabelText("kWh 단가"), { target: { value: draft } });
    fireEvent.click(within(form).getByRole("button", { name: "현장 정보 저장" }));

    await waitFor(() => expect(siteApi.updateSiteSettings).toHaveBeenCalledWith("site-1", expect.objectContaining({
      tariffKwhRate: expected
    })));
  });

  it("submits site and floor changes and invalidates only the selected site", async () => {
    const queryClient = renderView();
    queryClient.setQueryData(["dashboard", "site-2"], { untouched: true });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const siteForm = await screen.findByRole("form", { name: "현장 정보" });

    fireEvent.change(within(siteForm).getByLabelText("현장명"), { target: { value: "서울 본사" } });
    fireEvent.click(within(siteForm).getByRole("button", { name: "현장 정보 저장" }));
    await waitFor(() => expect(siteApi.updateSiteSettings).toHaveBeenCalledWith("site-1", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "서울 본사",
      address: "서울시 중구 세종대로 1",
      timeZone: "Asia/Seoul",
      currency: "KRW",
      tariffKwhRate: 158.75
    }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: siteSettingsQueryKey("site-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", "site-1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: floorFixtureSettingsQueryKey("site-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: fixtureGroupQueryKey("site-1") });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["dashboard", "site-2"] });

    const createForm = screen.getByRole("form", { name: "층 추가" });
    fireEvent.change(within(createForm).getByLabelText("새 층 이름"), { target: { value: "2층" } });
    fireEvent.change(within(createForm).getByLabelText("새 층 레벨"), { target: { value: "2" } });
    fireEvent.change(within(createForm).getByLabelText("새 층 표시 순서"), { target: { value: "4" } });
    fireEvent.click(within(createForm).getByRole("button", { name: "층 추가" }));
    await waitFor(() => expect(siteApi.createFloor).toHaveBeenCalledWith("site-1", { name: "2층", level: 2, displayOrder: 4 }));

    const floorForm = screen.getByRole("form", { name: "B1 층 정보 수정" });
    fireEvent.change(within(floorForm).getByLabelText("B1 이름"), { target: { value: "지하 1층" } });
    fireEvent.click(within(floorForm).getByRole("button", { name: "B1 층 정보 저장" }));
    await waitFor(() => expect(siteApi.updateFloor).toHaveBeenCalledWith("site-1", "floor-empty", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "지하 1층",
      level: -1,
      displayOrder: 2
    }));

    fireEvent.click(screen.getByRole("button", { name: "구 1층 복구" }));
    await waitFor(() => expect(siteApi.restoreFloor).toHaveBeenCalledWith("site-1", "floor-archived", "2026-09-12T00:00:00.000Z"));
  });

  it("archives an empty floor only after confirmation and retries a 409 without losing the row", async () => {
    siteApi.archiveFloor.mockRejectedValueOnce(new ApiError("conflict", 409, { code: "settings_version_conflict" }));
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "B1 보관" }));
    const dialog = screen.getByRole("alertdialog", { name: "B1 층 보관" });
    expect(siteApi.archiveFloor).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("조명과 활성 구역이 없는지 다시 확인");
    fireEvent.click(within(dialog).getByRole("button", { name: "층 보관" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("층 상태가 변경되어 보관하지 못했습니다.");
    expect(screen.getByRole("form", { name: "B1 층 정보 수정" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "최신 정보 불러오기" }));
    await waitFor(() => expect(siteApi.getSiteSettings).toHaveBeenCalledTimes(2));
    expect(siteApi.archiveFloor).toHaveBeenCalledTimes(1);
  });

  it("refreshes instead of replaying a blocked floor archive", async () => {
    siteApi.archiveFloor.mockRejectedValueOnce(new ApiError("blocked", 409, { code: "floor_archive_blocked" }));
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "B1 보관" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "B1 층 보관" })).getByRole("button", { name: "층 보관" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("조명, 활성 구역 또는 진행 중인 등록 작업");
    fireEvent.click(within(alert).getByRole("button", { name: "최신 정보 불러오기" }));
    await waitFor(() => expect(siteApi.getSiteSettings).toHaveBeenCalledTimes(2));
    expect(siteApi.archiveFloor).toHaveBeenCalledTimes(1);
  });

  it("updates fixture metadata and appends the next 200-item cursor page", async () => {
    renderView();
    const fixtureForm = await screen.findByRole("form", { name: "B2-L01 조명 정보 수정" });

    fireEvent.change(within(fixtureForm).getByLabelText("B2-L01 이름"), { target: { value: "B2-L01 수정" } });
    fireEvent.change(within(fixtureForm).getByLabelText("B2-L01 정격전력"), { target: { value: "42" } });
    fireEvent.click(within(fixtureForm).getByRole("button", { name: "B2-L01 조명 정보 저장" }));
    await waitFor(() => expect(siteApi.updateFixtureMetadata).toHaveBeenCalledWith("site-1", "floor-1", "fixture-1", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "B2-L01 수정",
      ratedWatt: 42
    }));

    fireEvent.click(screen.getByRole("button", { name: "다음 200개 불러오기" }));
    expect(await screen.findByRole("form", { name: "B2-L02 조명 정보 수정" })).toBeVisible();
    expect(siteApi.getFloorFixtureSettings).toHaveBeenCalledWith("site-1", "floor-1", "fixture-1");
  });

  it("rejects blank, malformed, and out-of-range rated watt values before calling the API", async () => {
    renderView();
    const form = await screen.findByRole("form", { name: "B2-L01 조명 정보 수정" });
    const ratedWatt = within(form).getByLabelText("B2-L01 정격전력");
    const save = within(form).getByRole("button", { name: "B2-L01 조명 정보 저장" });

    fireEvent.change(ratedWatt, { target: { value: "" } });
    fireEvent.click(save);
    expect(await within(form).findByRole("alert")).toHaveTextContent("정격전력을 입력하세요.");

    fireEvent.change(ratedWatt, { target: { value: "1.001" } });
    fireEvent.click(save);
    expect(await within(form).findByRole("alert")).toHaveTextContent("소수점 둘째 자리까지");

    fireEvent.change(ratedWatt, { target: { value: "0" } });
    fireEvent.click(save);
    expect(await within(form).findByRole("alert")).toHaveTextContent("0.01 이상 999,999.99 이하");

    fireEvent.change(ratedWatt, { target: { value: "1000000" } });
    fireEvent.click(save);
    expect(await within(form).findByRole("alert")).toHaveTextContent("0.01 이상 999,999.99 이하");
    expect(siteApi.updateFixtureMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ["0.01", 0.01],
    ["999999.99", 999_999.99]
  ])("submits the rated watt boundary %s as a number", async (draft, expected) => {
    renderView();
    const form = await screen.findByRole("form", { name: "B2-L01 조명 정보 수정" });

    fireEvent.change(within(form).getByLabelText("B2-L01 정격전력"), { target: { value: draft } });
    fireEvent.click(within(form).getByRole("button", { name: "B2-L01 조명 정보 저장" }));

    await waitFor(() => expect(siteApi.updateFixtureMetadata).toHaveBeenCalledWith(
      "site-1",
      "floor-1",
      "fixture-1",
      expect.objectContaining({ ratedWatt: expected })
    ));
  });

  it("reloads fixture metadata instead of replaying a stale update", async () => {
    siteApi.updateFixtureMetadata.mockRejectedValueOnce(new ApiError("conflict", 409, { code: "settings_version_conflict" }));
    renderView();
    const fixtureForm = await screen.findByRole("form", { name: "B2-L01 조명 정보 수정" });

    fireEvent.change(within(fixtureForm).getByLabelText("B2-L01 이름"), { target: { value: "충돌 이름" } });
    fireEvent.click(within(fixtureForm).getByRole("button", { name: "B2-L01 조명 정보 저장" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("다른 작업에서 변경되었습니다");
    fireEvent.click(within(alert).getByRole("button", { name: "최신 정보 불러오기" }));
    await waitFor(() => expect(siteApi.getFloorFixtureSettings).toHaveBeenCalledTimes(2));
    expect(siteApi.updateFixtureMetadata).toHaveBeenCalledTimes(1);
  });

  it("moves only active groups into retiring after confirmation", async () => {
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "B2 입구 보관" }));
    const dialog = screen.getByRole("alertdialog", { name: "B2 입구 구역 보관" });
    expect(groupApi.deleteFixtureGroup).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "구역 보관" }));

    await waitFor(() => expect(groupApi.deleteFixtureGroup).toHaveBeenCalledWith("site-1", "group-active"));
  });
});

function renderView(siteId = "site-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SiteOperationsView siteId={siteId} />
    </QueryClientProvider>
  );
  return queryClient;
}
