import { expect, test, type Page, type Route } from "@playwright/test";
import type { FloorEditorState, FloorImportJob } from "../src/features/floor-editor/editor-types";

const now = "2026-09-18T00:00:00.000Z";
const jobId = "00000000-0000-4000-8000-000000000020";
const sourceAssetId = "00000000-0000-4000-8000-000000000010";
const renderedAssetId = "00000000-0000-4000-8000-000000000040";
const candidates = [
  candidate("00000000-0000-4000-8000-000000000031", "insert-1", 200, 180),
  candidate("00000000-0000-4000-8000-000000000032", "insert-2", 400, 180)
];

test("기존 맵을 CAD로 교체하고 두 조명을 슬롯에 배치해 저장하면 모니터링에 반영된다", async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1_440, height: 900 });
  const api = await installCadJourney(page);

  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByRole("heading", { name: "B1 맵 편집" })).toBeVisible();
  expect(api.state().objects).toHaveLength(1);
  expect(api.state().fixtures.filter(fixture => fixture.placementStatus === "placed")).toHaveLength(2);

  await page.getByLabel("CAD 파일").setInputFiles({
    name: "parking.dwg",
    mimeType: "application/dwg",
    buffer: Buffer.from("AC1027-e2e-cad")
  });
  await page.getByRole("button", { name: "CAD 가져오기" }).click();
  await expect(page.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveAttribute("value", "0");
  await expect(page.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveAttribute("value", "100", { timeout: 10_000 });
  await expect(page.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();

  const applyButton = page.getByRole("button", { name: "선택한 후보와 배경 적용" });
  await applyButton.click();
  let resetDialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
  await expect(resetDialog).toContainText("조명 2개가 미배치 상태로 변경됩니다.");
  await expect(resetDialog).toContainText("수동 도형 1개가 삭제됩니다.");
  await expect(resetDialog).toContainText("기존 CAD 슬롯 1개가 삭제됩니다.");
  await resetDialog.getByRole("button", { name: "취소" }).click();
  await expect(resetDialog).not.toBeVisible();
  expect(api.applyPayloads()).toHaveLength(0);

  await applyButton.click();
  resetDialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
  await resetDialog.getByRole("button", { name: "교체 후 적용" }).click();
  await expect.poll(() => api.applyPayloads()).toHaveLength(1);
  expect(api.applyPayloads()[0]).toMatchObject({
    expectedRevision: 1,
    confirmMapReset: true,
    candidateIds: candidates.map(candidate => candidate.id)
  });
  await expect.poll(() => api.state().objects).toHaveLength(0);
  await expect.poll(() => api.state().lightSlots).toHaveLength(2);
  await expect.poll(() => api.state().fixtures.every(fixture => fixture.placementStatus === "unplaced")).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("placement-fixture-fixture-1")).toBeVisible();
  await expect(page.getByTestId("placement-fixture-fixture-2")).toBeVisible();
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-width", "1200");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-height", "800");

  const canvas = page.getByTestId("floor-editor-canvas");
  const transform = await canvas.evaluate(element => ({
    zoom: Number(element.dataset.zoom),
    panX: Number(element.dataset.panX),
    panY: Number(element.dataset.panY)
  }));
  await page.getByTestId("placement-fixture-fixture-1").dragTo(canvas, {
    targetPosition: { x: transform.panX + 200 * transform.zoom, y: transform.panY + 180 * transform.zoom }
  });
  await page.getByTestId("placement-fixture-fixture-2").dragTo(canvas, {
    targetPosition: { x: transform.panX + 400 * transform.zoom, y: transform.panY + 180 * transform.zoom }
  });
  await expect.poll(async () => (await currentState(page)).fixtures.filter(fixture => fixture.placementStatus === "placed").length).toBe(2);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect.poll(() => api.savePayloads()).toHaveLength(1);
  expect(api.state().lightSlots.map(slot => slot.assignedFixtureId)).toEqual(["fixture-1", "fixture-2"]);

  await page.getByRole("link", { name: "모니터링", exact: true }).click();
  await expect(page).toHaveURL(/\/monitoring\?siteId=site-1$/);
  await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
  await expect(page.getByRole("button", { name: "B1-L01 정상 70%" })).toBeVisible();
  await expect(page.getByRole("button", { name: "B1-L02 정상 70%" })).toBeVisible();
  await expect.poll(() => api.monitoringSnapshotRequests()).toBeGreaterThan(0);
});

async function installCadJourney(page: Page) {
  page.on("pageerror", error => console.error("CAD journey browser error", error.message));
  let pollCount = 0;
  let applied = false;
  let monitoringSnapshotRequestCount = 0;
  const applyPayloads: unknown[] = [];
  const savePayloads: unknown[] = [];
  const state = initialState();

  await page.route("**/cad-e2e-upload", route => route.fulfill({ status: 200, body: "" }));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/auth/me") return json(route, { user: { id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "admin", name: "관리자", role: "admin", status: "active" } });
    if (path === "/sites") return json(route, [{ id: "site-1", name: "검증 현장" }]);
    if (path === "/sites/site-1/dashboard") return json(route, dashboard(state));
    if (path === "/sites/site-1/floors/floor-1/fixtures") return json(route, { items: state.fixtures.map(monitoringFixture), nextCursor: null, generatedAt: new Date().toISOString() });
    if (path === "/sites/site-1/floors/floor-1/map-snapshot") {
      monitoringSnapshotRequestCount += 1;
      return json(route, mapSnapshot(state));
    }
    if (path === "/floors/floor-1/editor-state") {
      if (request.method() === "PUT") {
        const payload = request.postDataJSON();
        savePayloads.push(payload);
        for (const update of payload.fixtureUpdates) Object.assign(state.fixtures.find(fixture => fixture.id === update.id)!, update);
        state.lightSlots = state.lightSlots.map(slot => ({
          ...slot,
          assignedFixtureId: state.fixtures.find(fixture => fixture.placementStatus === "placed" && fixture.x === slot.x && fixture.y === slot.y)?.id ?? null
        }));
        state.floor.mapRevision += 1;
      }
      return json(route, state);
    }
    if (path === "/floors/floor-1/editor-lease") return json(route, { editable: true, token: "lease-floor-1", fence: 1 });
    if (path === "/floors/floor-1/editor-revisions") return json(route, { items: [], nextCursor: null });
    if (path === "/floors/floor-1/import-jobs/applied-overlay") return json(route, {
      overlay: applied ? {
        floorId: "floor-1", jobId, revision: state.floor.mapRevision,
        renderedAssetId, renderedAssetPath: "/api/floors/floor-1/assets/rendered/content",
        renderedViewport: { width: 1200, height: 800 }, appliedAt: now, candidates
      } : null
    });
    if (path === "/floors/floor-1/import-jobs/active") return json(route, { job: null });
    if (path === "/floors/floor-1/assets/upload-intent") return json(route, {
      assetId: sourceAssetId, uploadUrl: `${url.origin}/cad-e2e-upload`,
      accessPath: "/api/floors/floor-1/assets/source/content", expiresInSeconds: 300
    });
    if (path === `/floors/floor-1/assets/${sourceAssetId}/complete`) return json(route, {
      id: sourceAssetId, kind: "original", status: "ready", mimeType: "application/dwg", sizeBytes: 15,
      sha256: "a".repeat(64), accessPath: "/api/floors/floor-1/assets/source/content"
    });
    if (path === "/floors/floor-1/import-jobs" && request.method() === "POST") return json(route, importJob("queued", 0));
    if (path === `/floors/floor-1/import-jobs/${jobId}`) {
      pollCount += 1;
      return json(route, pollCount === 1 ? importJob("processing", 55) : importJob("review_required", 100));
    }
    if (path === `/floors/floor-1/import-jobs/${jobId}/candidates`) {
      await new Promise(resolve => setTimeout(resolve, 350));
      return json(route, { candidates });
    }
    if (path === `/floors/floor-1/import-jobs/${jobId}/apply`) {
      const payload = request.postDataJSON();
      applyPayloads.push(payload);
      applied = true;
      state.objects = [];
      state.fixtures = state.fixtures.map(fixture => ({ ...fixture, x: 0, y: 0, placementStatus: "unplaced" }));
      state.lightSlots = candidates.map((candidate, index) => ({ id: `slot-${index + 1}`, x: candidate.x, y: candidate.y, rotation: candidate.rotation, assignedFixtureId: null }));
      state.floor.mapRevision = 2;
      state.floor.floorPlan = floorPlan();
      const { version: _version, ...appliedFloorPlan } = floorPlan();
      return json(route, {
        jobId, status: "completed", revision: 2, acceptedCandidateIds: candidates.map(candidate => candidate.id),
        renderedAssetId, deletedObjectCount: 1, unplacedFixtureCount: 2, deletedSlotCount: 1, createdSlotCount: 2,
        floorPlan: appliedFloorPlan
      });
    }
    if (path === "/floors/floor-1/assets/rendered/content") return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#fff"/><path d="M40 400H1160" stroke="#111827"/></svg>'
    });
    return json(route, { message: path }, 404);
  });
  return {
    state: () => state, applyPayloads: () => applyPayloads, savePayloads: () => savePayloads,
    monitoringSnapshotRequests: () => monitoringSnapshotRequestCount
  };
}

function initialState(): FloorEditorState {
  return {
    floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 1, floorPlan: { imageUrl: "/old.svg", width: 800, height: 600, version: 1 } },
    objects: [{ id: "object-1", floorId: "floor-1", type: "rectangle", x: 50, y: 50, width: 200, height: 100, rotation: 0, strokeColor: "#334155", fillColor: "transparent", strokeWidth: 1, text: "", fontSize: null, zIndex: 0, locked: false, visible: true }],
    lightSlots: [{ id: "old-slot", x: 100, y: 100, rotation: 0, assignedFixtureId: "fixture-1" }],
    fixtures: [
      { id: "fixture-1", name: "B1-L01", x: 100, y: 100, size: 20, ratedWatt: 40, brightness: 70, status: "online", placementStatus: "placed", positionVerifiedAt: null },
      { id: "fixture-2", name: "B1-L02", x: 300, y: 100, size: 20, ratedWatt: 40, brightness: 70, status: "online", placementStatus: "placed", positionVerifiedAt: null }
    ]
  };
}

function importJob(status: FloorImportJob["status"], progressPercent: number): FloorImportJob {
  return {
    jobId, floorId: "floor-1", sourceAssetId, renderedAssetId: status === "review_required" ? renderedAssetId : null,
    sourceFormat: "dwg", status, stage: status, progressPercent, attemptCount: status === "queued" ? 0 : 1,
    parserVersion: status === "review_required" ? "libredwg-0.14" : null,
    detectorVersion: status === "review_required" ? "site-drawing-20260803-v1" : null,
    failureCode: null, sourceAssetPath: "/api/floors/floor-1/assets/source/content",
    renderedAssetPath: status === "review_required" ? "/api/floors/floor-1/assets/rendered/content" : null,
    renderedViewport: status === "review_required" ? { width: 1200, height: 800 } : null,
    startedAt: status === "queued" ? null : now, reviewRequiredAt: status === "review_required" ? now : null,
    appliedAt: null, completedAt: null, failedAt: null, cancelledAt: null, createdAt: now, updatedAt: now
  };
}

function candidate(id: string, sourceEntityId: string, x: number, y: number) {
  return {
    id, sourceEntityId, layerName: "LIGHT", blockName: "LED", x, y, rotation: 0, confidence: 0.95,
    detectionMethod: "rule_based" as const, provider: null, model: null, inputDigest: null,
    profileVersion: "site-drawing-20260803-v1", profileDigest: "b".repeat(64), reviewStatus: "pending" as const
  };
}

function floorPlan() {
  return {
    imageUrl: "/api/floors/floor-1/assets/rendered/content", sourceType: "image" as const,
    originalFileUrl: "/api/floors/floor-1/assets/source/content",
    renderedImageUrl: "/api/floors/floor-1/assets/rendered/content", width: 1200, height: 800, gridSize: 10, version: 2
  };
}

function dashboard(state: FloorEditorState) {
  const fixtures = state.fixtures.map(monitoringFixture);
  return {
    generatedAt: new Date().toISOString(), monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 },
    capabilities: { read: true, control: true, manage: true, commission: true },
    site: { id: "site-1", name: "검증 현장", customerName: "고객사", installationStatus: "installed", address: null, tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: fixtures.length, onlineFixtures: fixtures.length, faultFixtures: 0, averageBrightness: 70 },
    floors: [{ id: "floor-1", name: "B1", level: -1, floorPlan: state.floor.floorPlan, meshControlGroups: [], fixtures }],
    groups: [], gateways: []
  };
}

function monitoringFixture(fixture: FloorEditorState["fixtures"][number]) {
  return {
    ...fixture, rssi: -55, hopCount: 1, commandSuccessRate: 1, lastSeenAt: new Date().toISOString(),
    health: null, gateway: { id: "gateway-1", name: "Gateway B1", connectionStatus: "online" as const },
    controllable: true, controlBlockReason: null
  };
}

function mapSnapshot(state: FloorEditorState) {
  return {
    floorId: "floor-1", revision: state.floor.mapRevision,
    width: state.floor.floorPlan?.width ?? 1200, height: state.floor.floorPlan?.height ?? 800,
    floorPlan: state.floor.floorPlan, objects: state.objects
  };
}

async function currentState(page: Page) {
  return page.evaluate(async () => {
    const { useFloorEditorStore } = await import("/src/features/floor-editor/editor-store.ts");
    return useFloorEditorStore.getState().state as FloorEditorState;
  });
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
