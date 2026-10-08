import { expect, test, type APIResponse, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { RealBackendLab, type DeferredAlarmIncident } from "./support/real-backend-lab";
import type { MonitoringIncidentsResponse } from "../src/api/monitoring-incidents";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: "off" });
test.skip(process.env.E2E_TASK9_ALARMS !== "1", "Requires the sole owned Task9 disposable Lab; never a user database or hardware.");

// Comments 2/12/13: personal dismissal is independently observed through real
// browser HTTP sessions and owned PostgreSQL, not inferred from a mocked badge.
test("real alarm persistence, frozen bulk targets, replay and account/site isolation", async ({ browser }, info) => {
  test.setTimeout(300_000);
  const ports = { postgres: 25439, redis: 26389, mqtt: 28893, api: 24009, web: 25183 };
  const origin = `http://127.0.0.1:${ports.web}`;
  const lab = new RealBackendLab({ ports, isolatedCadStorage: true });
  const contexts: BrowserContext[] = [];
  const deferred: DeferredAlarmIncident[] = [];
  const witness: Array<{ label: string; value: unknown }> = [];
  let fixturesReady = false;
  const record = (label: string, value: unknown) => { witness.push({ label, value }); };
  const database = async (label: string) => { const value = await lab.readAlarmEvidence(); record(label, value); return value; };
  const response = async (label: string, result: Pick<APIResponse, "json" | "status">, status: number) => {
    const body: unknown = await result.json(); record(label, { status: result.status(), body });
    expect(result.status(), label).toBe(status); return body;
  };
  const newPage = async () => {
    const context = await browser.newContext({ baseURL: origin }); contexts.push(context);
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    return context.newPage();
  };
  try {
    // Resolve exact own ports and local images immediately before the existing
    // Lab startup. --pull=never and all lifecycle isolation remain in the Lab.
    for (const port of Object.values(ports)) await unused(port);
    for (const [tag, expectedId] of [
      ["minio/minio:RELEASE.2025-04-22T22-12-26Z", "sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"],
      ["minio/mc:RELEASE.2025-04-16T18-13-26Z", "sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3"]
    ]) {
      const actual = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { encoding: "utf8" });
      record("owned-storage-image", { tag, status: actual.status, actualId: actual.stdout.trim() });
      expect(actual.status).toBe(0); expect(actual.stdout.trim()).toBe(expectedId);
    }
    await lab.start();
    const operator = await newPage(); lab.captureNetwork(operator, "operator");
    await operator.goto("/monitoring");
    await login(operator, lab.operator.loginId, lab.operator.password);
    await expect(operator.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    await operator.getByRole("button", { name: "현장 및 관리자 생성" }).click();
    for (const [label, value] of [["고객사명", "Task9 own alarm QA"], ["현장명", "Task9 own primary"],
      ["관리자 이름", lab.admin.name], ["로그인 아이디", lab.admin.loginId], ["초기 비밀번호", lab.admin.password]]) {
      await operator.getByLabel(label, { exact: true }).fill(value);
    }
    const createdResponse = operator.waitForResponse(r => r.url().endsWith("/api/operator/site-admins") && r.request().method() === "POST");
    await operator.getByRole("button", { name: "생성", exact: true }).click();
    const created = await response("create-own-site", await createdResponse, 201) as { siteId: string };
    lab.assertOperatorNetworkIsolation();
    await operator.context().close();

    const admin = await newPage(); lab.captureNetwork(admin, "admin");
    await admin.goto(`/monitoring?siteId=${created.siteId}`);
    await login(admin, lab.admin.loginId, lab.admin.password);
    await expect(admin.getByRole("heading", { name: "현장 기본 정보를 입력하세요" })).toBeVisible();
    await admin.getByLabel("주소", { exact: true }).fill("Task9 disposable address");
    await admin.getByLabel("kWh 단가").fill("160");
    await admin.getByRole("button", { name: "시간대", exact: true }).click();
    await admin.getByRole("option", { name: "Asia/Seoul", exact: true }).click();
    await admin.getByLabel("지하 층수").fill("1"); await admin.getByLabel("지상 층수").fill("0");
    await admin.getByRole("button", { name: "맵 생성", exact: true }).click();
    const setup = admin.waitForResponse(r => r.url().endsWith("/api/setup/initial-site") && r.request().method() === "POST");
    await admin.getByRole("button", { name: "초기 설정 완료" }).click();
    await response("setup-own-site", await setup, 201);
    await expect(admin.getByRole("heading", { name: "설정 개요" })).toBeVisible();
    expect((await lab.readInstallation()).siteId).toBe(created.siteId);
    const scope = await lab.seedAlarmFixtures(); fixturesReady = true; record("scope", scope);
    const ids: string[] = [];
    // More than one API/UI page, including resolved and unresolved incidents.
    for (let index = 0; index < 53; index++) ids.push(await lab.seedAlarmIncident({ status: index === 0 ? "open" : "resolved" }));
    const other = await lab.seedAlarmIncident({ site: "secondary" });
    const viewer = await newPage(); lab.captureNetwork(viewer, "viewer");
    await viewer.goto(`/monitoring?siteId=${scope.primarySiteId}`);
    await login(viewer, lab.viewer.loginId, lab.viewer.password);
    await expect(viewer.getByRole("button", { name: /^알람센터,/ })).toBeVisible();
    const path = (site = scope.primarySiteId) => `/api/sites/${site}/monitoring-incidents`;
    const list = async (page: Page, site = scope.primarySiteId, suffix = "view=personal&status=all&limit=100") => {
      const r = await page.request.get(`${path(site)}?${suffix}`);
      expect(r.status()).toBe(200); return r.json() as Promise<MonitoringIncidentsResponse>;
    };
    const original = await database("before-any-center-open-or-read");
    expect(original.reads).toEqual([]); expect(original.dismissals).toEqual([]);
    // Both actors are assigned only to the primary site. The production schema
    // permits one membership per viewer, so cross-site isolation is a real 404
    // plus complete database invariance, never an impossible second membership.
    const assertSecondaryDenied = async (stage: string) => {
      for (const [actor, page] of [["admin", admin], ["viewer", viewer]] as const) {
        const baseline = await database(`${stage}-${actor}-before-secondary-denials`);
        await response(`${stage}-${actor}-secondary-get`, await page.request.get(`${path(scope.secondarySiteId)}?view=personal&status=all`), 404);
        expect(await database(`${stage}-${actor}-after-secondary-get`)).toEqual(baseline);
        await response(`${stage}-${actor}-secondary-dismiss`, await page.request.put(`${path(scope.secondarySiteId)}/${other}/dismiss`, { data: {} }), 404);
        expect(await database(`${stage}-${actor}-after-secondary-dismiss`)).toEqual(baseline);
        await response(`${stage}-${actor}-secondary-bulk`, await page.request.post(`${path(scope.secondarySiteId)}/dismiss-all`, { data: { clientRequestId: randomUUID() } }), 404);
        expect(await database(`${stage}-${actor}-after-secondary-bulk`)).toEqual(baseline);
      }
    };
    await assertSecondaryDenied("before-primary-dismissals");
    await response("admin-individual", await admin.request.put(`${path()}/${ids[0]}/dismiss`, { data: {} }), 200);
    const individual = await database("after-api-individual");
    expect(individual.incidents).toEqual(original.incidents); expect(individual.reads).toEqual(original.reads);
    expect(individual.dismissals).toEqual([expect.objectContaining({ incidentId: ids[0], userId: scope.adminId })]);
    expect((await list(admin)).incidents.map(i => i.id)).not.toContain(ids[0]);
    expect((await list(viewer)).incidents.map(i => i.id)).toContain(ids[0]);
    await lab.updateAlarmIncident(ids[0]);
    expect((await list(admin)).incidents.map(i => i.id)).not.toContain(ids[0]);
    const recurrence = await lab.seedAlarmIncident();
    expect((await list(admin)).incidents.map(i => i.id)).toContain(recurrence);
    const filtered = await list(viewer, scope.primarySiteId, "view=personal&status=open&limit=1");
    record("filtered-page-before-bulk", filtered);
    expect(filtered.incidents.map(i => i.id)).toEqual([ids[0]]);

    const late = await lab.beginDeferredAlarmIncident(); deferred.push(late);
    const bulkKey = randomUUID();
    const frozenIds = (await list(viewer)).incidents.map(i => i.id).sort();
    await lab.setAlarmEffectFailure(true);
    const beforeFailure = await database("before-effect-failure");
    await response("bulk-effect-failure", await viewer.request.post(`${path()}/dismiss-all`, { data: { clientRequestId: bulkKey } }), 500);
    const pending = await database("durable-reservation-after-effect-rollback");
    expect(pending.incidents).toEqual(beforeFailure.incidents); expect(pending.reads).toEqual(beforeFailure.reads);
    expect(pending.dismissals).toEqual(beforeFailure.dismissals);
    const reservation = pending.reservations.find(r => r.clientRequestId === bulkKey)!;
    expect(reservation).toMatchObject({ userId: scope.viewerId, siteId: scope.primarySiteId, completedAt: null, dismissedCount: null });
    expect([...reservation.targetIncidentIds].sort()).toEqual(frozenIds);
    await lab.setAlarmEffectFailure(false);
    await lab.setAlarmViewerAccess(false);
    await response("permission-revoked-pending-replay", await viewer.request.post(`${path()}/dismiss-all`, { data: { clientRequestId: bulkKey } }), 404);
    expect(await lab.readAlarmEvidence()).toEqual(pending);
    await lab.setAlarmViewerAccess(true);
    await late.commit();
    const newId = await lab.seedAlarmIncident();
    const beforeReplay = await database("late-commit-and-new-incident-before-replay");
    const replies = await Promise.all([bulkKey, bulkKey.toUpperCase()].map(clientRequestId => viewer.request.post(`${path()}/dismiss-all`, { data: { clientRequestId } })));
    const first = await response("same-key-concurrent-replay-a", replies[0], 201);
    expect(await response("same-key-concurrent-replay-b", replies[1], 201)).toEqual(first);
    expect(first).toMatchObject({ clientRequestId: bulkKey, dismissedCount: frozenIds.length });
    const completed = await database("after-replay-completed");
    expect(completed.incidents).toEqual(beforeReplay.incidents); expect(completed.reads).toEqual(beforeReplay.reads);
    expect(completed.dismissals.filter(d => d.userId === scope.viewerId).map(d => d.incidentId).sort()).toEqual(frozenIds);
    expect(completed.reservations.find(r => r.clientRequestId === bulkKey)).toMatchObject({
      snapshotAt: reservation.snapshotAt, targetIncidentIds: reservation.targetIncidentIds, dismissedCount: frozenIds.length, completedAt: expect.any(String)
    });
    expect((await list(viewer)).incidents.map(i => i.id).sort()).toEqual([late.id, newId].sort());
    await assertSecondaryDenied("after-primary-replay");
    expect((await list(admin)).incidents.map(i => i.id)).toContain(recurrence);

    // UI auto-read is intentional and captured separately from hide-only API
    // invariants. Observe read completion before taking the dismissal baseline.
    await viewer.reload();
    await viewer.getByRole("button", { name: /^알람센터,/ }).click();
    const row = viewer.locator(`[data-alarm-id="${newId}"]`);
    await expect(row).toBeVisible(); await expect(row.getByText("읽음", { exact: true })).toBeVisible();
    const beforeUi = await database("after-center-auto-read-before-ui-dismiss");
    await row.getByRole("button", { name: "지우기", exact: true }).click(); await expect(row).toHaveCount(0);
    const afterUi = await database("after-ui-individual-dismiss");
    expect(afterUi.incidents).toEqual(beforeUi.incidents);
    expect(afterUi.reads.filter(r => r.incidentId === newId)).toEqual(beforeUi.reads.filter(r => r.incidentId === newId));
    await viewer.screenshot({ path: info.outputPath("alarm-personal-after-dismiss.png"), fullPage: false });
    await viewer.reload(); expect((await list(viewer)).incidents.map(i => i.id)).toEqual([late.id]);
    await viewer.context().close();
    const relogin = await newPage(); lab.captureNetwork(relogin, "viewer");
    await relogin.goto(`/monitoring?siteId=${scope.primarySiteId}`); await login(relogin, lab.viewer.loginId, lab.viewer.password);
    expect((await list(relogin)).incidents.map(i => i.id)).toEqual([late.id]);
    await relogin.getByRole("button", { name: /^알람센터,/ }).click();
    await expect(relogin.locator(`[data-alarm-id="${late.id}"]`)).toBeVisible();
    await relogin.getByRole("button", { name: "전체 지우기", exact: true }).click();
    const confirm = relogin.getByRole("alertdialog", { name: "전체 알람 지우기" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "전체 지우기", exact: true }).click();
    await expect(relogin.getByText("등록된 알람이 없습니다.")).toBeVisible();
    await relogin.screenshot({ path: info.outputPath("alarm-new-context-bulk-empty.png"), fullPage: false });
    const final = await database("final-ui-bulk");
    expect(final.incidents).toEqual(beforeReplay.incidents);
    expect(final.dismissals.filter(d => d.userId === scope.adminId).map(d => d.incidentId)).toEqual([ids[0]]);
    expect(final.dismissals.filter(d => d.incidentId === other)).toEqual([]);
    expect(lab.dimmingCommandCount()).toBe(0);
  } finally {
    // Always persist raw witnesses before stop removes the owned resource tree.
    const errors: unknown[] = [];
    for (const transaction of deferred) try { await transaction.rollback(); } catch (error) { errors.push(error); }
    if (fixturesReady) {
      try { await lab.setAlarmEffectFailure(false); await lab.setAlarmViewerAccess(true); } catch (error) { errors.push(error); }
      try { await database("finally-before-stop"); } catch (error) { errors.push(error); }
    }
    for (const context of contexts) try { await context.close(); } catch (error) { errors.push(error); }
    try { await lab.writeEvidence(info); } catch (error) { errors.push(error); }
    try { await lab.stop(); } catch (error) { errors.push(error); }
    record("cad-storage-cleanup", lab.cadStorageEvidence());
    for (const port of Object.values(ports)) try { await unused(port); } catch (error) { errors.push(error); }
    record("cleanup-errors", errors.map(String));
    await info.attach("alarm-http-postgres-and-cleanup", { body: JSON.stringify(witness, null, 2), contentType: "application/json" });
    if (errors.length) throw new AggregateError(errors, "Owned alarm QA cleanup failed");
  }
});

async function login(page: Page, loginId: string, password: string) {
  const heading = page.getByRole("heading", { name: "킨다 로그인", exact: true });
  await expect(heading).toBeVisible();
  await page.getByLabel("아이디", { exact: true }).fill(loginId);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  // The submit button changes its accessible name while pending. Only actual
  // login completion and the authenticated AuthView transition prove readiness.
  const completed = page.waitForResponse(result => new URL(result.url()).pathname === "/api/auth/login" && result.request().method() === "POST");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  const response = await completed;
  expect(response.status()).toBe(201);
  expect(await response.finished()).toBeNull();
  await expect(heading).toHaveCount(0);
}

async function unused(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
