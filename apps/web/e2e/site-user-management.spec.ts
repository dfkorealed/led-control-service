import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { StatisticsNativeZoomEvidence } from "./support/statistics-native-zoom-evidence";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: "off" });

const siteId = "11111111-1111-4111-8111-111111111111";
const floorId = "22222222-2222-4222-8222-222222222222";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const commandId = "44444444-4444-4444-8444-444444444444";

const longUserName = "지하주차장안전점검담당현장사용자".repeat(3);
function listUser(id: string, name = longUserName): SiteUser {
  return { id, name, loginId: `parking.${id}.` + "long".repeat(12), accessLevel: "control", status: "active",
    lastLoginAt: null, createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z" };
}

for (const viewport of [
  { width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 900 },
  { width: 1023, height: 900 }, { width: 1024, height: 900 }, { width: 1287, height: 900 },
  { width: 1440, height: 900 }, { width: 390, height: 320 }, { width: 1440, height: 600 }
]) test(`Task8 user list detail reset and row controls at ${viewport.width}x${viewport.height}`, async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport, hasTouch: viewport.width < 768 });
  try {
    const page = await context.newPage();
    const api = await installProductApi(page, "admin");
    api.users.push(listUser("user-long"), { ...listUser("night", "야간 담당"), accessLevel: "read", status: "disabled" });
    await page.goto(`/settings/users?siteId=${siteId}`);
    await expect(page.getByText(longUserName, { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const grid = page.getByRole("table", { name: "현장 사용자 목록" }).or(page.getByRole("list", { name: "현장 사용자 목록" }));
    expect(await grid.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.getByRole("searchbox", { name: "사용자 검색" }).fill("parking");
    const filter = page.getByRole("button", { name: /사용자 목록 상세 필터/ });
    await filter.focus(); await page.keyboard.press("Enter");
    const detail = page.getByRole("dialog", { name: "사용자 목록", exact: true });
    await detail.getByRole("button", { name: /권한 필터/ }).click();
    await page.getByRole("option", { name: "조회", exact: true }).click();
    await detail.getByRole("button", { name: /상태 필터/ }).click();
    await page.getByRole("option", { name: "비활성", exact: true }).click();
    await expect(filter).toHaveAccessibleName("사용자 목록 상세 필터, 활성 조건 2개");
    await expectMinimumTouchTargetsAfterScrolling(page, '[role="dialog"][aria-label="사용자 목록"]');
    await detail.getByRole("button", { name: "필터 초기화" }).click();
    await page.keyboard.press("Escape");
    await expect(filter).toBeFocused();
    await expect(page.getByRole("searchbox", { name: "사용자 검색" })).toHaveValue("parking");
    await expect(filter).toHaveAccessibleName("사용자 목록 상세 필터, 활성 조건 0개");
    const actions = page.getByRole("button", { name: `${longUserName} 작업` });
    await actions.scrollIntoViewIfNeeded();
    if (viewport.width < 768) await actions.tap(); else { await actions.focus(); await page.keyboard.press("Enter"); }
    await expect(page.getByRole("menuitem")).toHaveCount(4);
    await page.keyboard.press("Escape"); await expect(actions).toBeFocused();
    await userAction(page, longUserName, `${longUserName} 영구 삭제`);
    const deletion = page.getByRole("alertdialog");
    await expect(deletion.getByRole("button", { name: "영구 삭제", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(actions).toBeFocused();
    expect(api.updatedRequests).toEqual([]);
    expect(api.users).toHaveLength(2);
    await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="유저 관리"]');
    await expectNoHorizontalOverflow(page);
  } finally { await context.close(); }
});

test("Task8 user grid responds to container width and not window width", async ({ page }) => {
  const api = await installProductApi(page, "admin"); api.users.push(listUser("container"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/settings/users?siteId=${siteId}`);
  await expect(page.getByRole("table", { name: "현장 사용자 목록" })).toBeVisible();
  const section = page.getByRole("region", { name: "유저 관리" });
  await section.evaluate(element => { (element as HTMLElement).style.width = "320px"; });
  await expect(page.getByRole("list", { name: "현장 사용자 목록" })).toBeVisible();
  await expect(page.getByText(longUserName, { exact: true })).toBeVisible();
  await section.evaluate(element => { (element as HTMLElement).style.removeProperty("width"); });
  await expect(page.getByRole("table", { name: "현장 사용자 목록" })).toBeVisible();
  expect(api.updatedRequests).toEqual([]);
});

test("Task8 native 200 user long names and row menu remain reachable", async ({}, info) => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", viewport: null, deviceScaleFactor: undefined, args: ["--window-size=1440,900"]
  });
  let native: StatisticsNativeZoomEvidence | undefined;
  try {
    const page = context.pages()[0]!;
    const api = await installProductApi(page, "admin"); api.users.push(listUser("native", "장문현장사용자설비안전관리담당자".repeat(2)));
    await page.goto(`${info.project.use.baseURL}/settings/users?siteId=${siteId}`);
    native = await StatisticsNativeZoomEvidence.create(context, page, info);
    await native.global200(context);
    const name = api.users[0]!.name;
    const filter = page.getByRole("button", { name: /사용자 목록 상세 필터/ });
    await filter.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "사용자 목록", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(filter).toBeFocused();
    const rowTrigger = page.getByRole("button", { name: `${name} 작업` });
    await rowTrigger.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem")).toHaveCount(4);
    await page.keyboard.press("Escape"); await expect(rowTrigger).toBeFocused();
    await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="유저 관리"]');
    await rowTrigger.evaluate(element => element.scrollIntoView({ block: "center" }));
    const observeContent = () => page.getByText(name, { exact: true }).evaluate((element, rowLabel) => {
      const action = [...document.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === rowLabel);
      if (!action) throw new Error("Native user row action is missing");
      const text = element.getBoundingClientRect(), row = action.getBoundingClientRect();
      const header = document.querySelector("[data-shell-topbar]")?.getBoundingClientRect();
      const nav = document.querySelector('[data-shell-navigation="compact"]')?.getBoundingClientRect();
      const top = header?.bottom ?? 0, bottom = nav?.top ?? innerHeight;
      const clips = [...function* () { for (let node = element.parentElement; node; node = node.parentElement) yield node; }()].map(node => ({
        tag: node.tagName, overflowX: getComputedStyle(node).overflowX, overflowY: getComputedStyle(node).overflowY,
        rect: node.getBoundingClientRect().toJSON(), clientWidth: node.clientWidth, clientHeight: node.clientHeight,
        clientLeft: node.clientLeft, clientTop: node.clientTop, scrollHeight: node.scrollHeight
      }));
      const readable = text.top >= top && text.bottom <= bottom && text.left >= 0 && text.right <= innerWidth
        && clips.every(c => (!/auto|hidden|clip|scroll/.test(c.overflowX) || (text.left >= c.rect.left + c.clientLeft && text.right <= c.rect.left + c.clientLeft + c.clientWidth))
          && (!/auto|hidden|clip|scroll/.test(c.overflowY) || (text.top >= c.rect.top + c.clientTop && text.bottom <= c.rect.top + c.clientTop + c.clientHeight)));
      const centerHit = document.elementFromPoint(text.x + text.width / 2, text.y + text.height / 2);
      return { utc: new Date().toISOString(), name: element.textContent, text: text.toJSON(), action: row.toJSON(),
        usable: { top, bottom, height: bottom - top }, innerWidth, innerHeight, scrollY,
        unionHeight: Math.max(text.bottom, row.bottom) - Math.min(text.top, row.top),
        readable: readable && Boolean(centerHit && (centerHit === element || element.contains(centerHit))),
        clips };
    }, `${name} 작업`);
    const content = await observeContent();
    writeFileSync(join(process.env.TASK8_OUTPUT!, "native-user-content-setup.json"), JSON.stringify(content, null, 2));
    await expectNoHorizontalOverflow(page);
    const contentObservations: Awaited<ReturnType<typeof observeContent>>[] = [];
    const observeState = async (requireName: boolean) => {
        await expect(page.getByRole("menu")).not.toBeVisible();
        await expect(page.getByRole("dialog", { name: "사용자 목록", exact: true })).not.toBeVisible();
        const finalContent = await observeContent();
        contentObservations.push(finalContent);
        writeFileSync(join(process.env.TASK8_OUTPUT!, "native-user-content-observations.json"), JSON.stringify(contentObservations, null, 2));
        if (requireName) expect(finalContent.readable, "Actual long name must be readable above fixed overlays").toBe(true);
        expect(api.updatedRequests).toEqual([]); expect(api.users).toHaveLength(1);
        // Observation timestamps belong to evidence, not the unchanged UI state comparison.
        const { utc: _observedAt, ...semanticContent } = finalContent;
        return { name, login: api.users[0]!.loginId, count: api.users.length, mutations: api.updatedRequests.length, expanded: await rowTrigger.getAttribute("aria-expanded"), content: semanticContent };
    };
    if (content.unionHeight <= content.usable.height) {
      // Name and row action fit together: scroll their union into usable space.
      await page.evaluate(({ text, action, usable }) => window.scrollBy(0, (Math.min(text.top, action.top) + Math.max(text.bottom, action.bottom)) / 2 - (usable.top + usable.bottom) / 2), content);
      await native.capture("Task8-users-name-and-action", rowTrigger, async () => { await expect(page.getByRole("menuitem")).toHaveCount(4); }, ["Escape"], {
        description: "실제 장문 이름과 행 작업 초점·닫힘, mutation 0", observe: () => observeState(true)
      });
    } else {
      // A tall card needs two ordinary scroll states, not a test-only compact layout.
      const reset = page.getByRole("button", { name: "필터 초기화", exact: true });
      await reset.evaluate(element => element.scrollIntoView({ block: "center" }));
      await native.capture("Task8-users-readable-name", reset, async () => { await expect(filter).toHaveAccessibleName("사용자 목록 상세 필터, 활성 조건 0개"); }, [], {
        description: "실제 장문 이름·필터 초기화 초점, 현장 사용자 1명·mutation 0", observe: () => observeState(true)
      });
      await rowTrigger.evaluate(element => element.scrollIntoView({ block: "center" }));
      await native.capture("Task8-users-row-action", rowTrigger, async () => { await expect(page.getByRole("menuitem")).toHaveCount(4); }, ["Escape"], {
        description: "행 작업 4개 접근·닫힘·트리거 초점, mutation 0", observe: async () => {
          await expectMinimumTouchTargets(page, '[aria-label="유저 관리"]');
          return observeState(false);
        }
      });
    }
  } finally { try { await native?.stop(); } finally { await context.close(); await native?.recordContextCleanup(); } }
});

test("admin이 일반 유저의 전체 관리 여정을 완료하고 평문 비밀번호를 남기지 않는다", async ({ page }) => {
  const api = await installProductApi(page, "admin");
  const temporaryPassword = runtimePassword("create");
  const resetPassword = runtimePassword("reset");

  await page.goto(`/settings/users?siteId=${siteId}`);
  await expect(page.getByRole("heading", { name: "유저 관리" })).toBeVisible();
  await expect(page.getByText("0 / 100명")).toBeVisible();

  await page.getByRole("button", { name: "사용자 추가" }).click();
  const createDialog = page.getByRole("dialog", { name: "사용자 추가" });
  await createDialog.getByLabel("이름").fill("김현수");
  await createDialog.getByLabel("로그인 아이디").fill("user_read");
  await createDialog.getByLabel("임시 비밀번호").fill(temporaryPassword);
  await createDialog.getByRole("button", { name: "사용자 생성" }).click();
  await expect(page.getByText("사용자를 생성했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("user_read")).toBeVisible();
  await expect(page.getByText("1 / 100명")).toBeVisible();
  expect(api.createdPasswordDigests).toEqual([digestSecret(temporaryPassword)]);
  expect(containsAnySecret(api.responseBodies, [temporaryPassword])).toBe(false);
  expect(await pageContainsAnySecret(page, [temporaryPassword])).toBe(false);

  await userAction(page, "김현수", "김현수 수정");
  const editDialog = page.getByRole("dialog", { name: "김현수 사용자 수정" });
  await editDialog.getByLabel("이름").fill("김현수 수정");
  await editDialog.getByText("제어", { exact: true }).click();
  await editDialog.getByRole("button", { name: "변경사항 저장" }).click();
  await expect(page.getByText("김현수 수정")).toBeVisible();
  const editedRow = page.getByRole("row").filter({ hasText: "user_read" });
  await expect(editedRow).toContainText("제어");
  expect(api.updatedRequests[0]).toEqual({
    name: "김현수 수정",
    loginId: "user_read",
    accessLevel: "control",
    status: "active",
    expectedUpdatedAt: "2026-09-11T00:00:00.000Z"
  });

  await userAction(page, "김현수 수정", "김현수 수정 비활성화");
  await expect(editedRow).toContainText("비활성");
  await userAction(page, "김현수 수정", "김현수 수정 활성화");
  await expect(editedRow).toContainText("활성");

  await userAction(page, "김현수 수정", "김현수 수정 비밀번호 초기화");
  const resetDialog = page.getByRole("dialog", { name: "김현수 수정 비밀번호 초기화" });
  await resetDialog.getByLabel("새 임시 비밀번호").fill(resetPassword);
  await resetDialog.getByLabel("임시 비밀번호 확인").fill(resetPassword);
  await resetDialog.getByRole("button", { name: "비밀번호 초기화" }).click();
  await expect(page.getByText("비밀번호를 초기화했습니다. 사용자의 기존 세션이 종료되었습니다.", { exact: true })).toBeVisible();
  expect(api.resetPasswordDigests).toEqual([digestSecret(resetPassword)]);
  expect(containsAnySecret(api.responseBodies, [resetPassword])).toBe(false);
  expect(await pageContainsAnySecret(page, [resetPassword])).toBe(false);

  await userAction(page, "김현수 수정", "김현수 수정 영구 삭제");
  const deleteDialog = page.getByRole("alertdialog", { name: "김현수 수정 사용자 영구 삭제" });
  await expect(deleteDialog.getByRole("button", { name: "영구 삭제" })).toBeDisabled();
  await deleteDialog.getByLabel("확인 로그인 아이디").fill("user_read");
  await deleteDialog.getByRole("button", { name: "영구 삭제" }).click();
  await expect(page.getByText("0 / 100명")).toBeVisible();
  await expect(page.getByText("user_read")).toHaveCount(0);

  const browserStorage = await page.evaluate(() => JSON.stringify({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage }
  }));
  expect(containsAnySecret([browserStorage], [temporaryPassword, resetPassword])).toBe(false);
});

test("신규 일반 유저가 최초 로그인 비밀번호를 변경한 뒤 모니터링에 진입한다", async ({ page }) => {
  const temporaryPassword = runtimePassword("temporary");
  const permanentPassword = runtimePassword("permanent");
  const api = await installProductApi(page, null, {
    accounts: [{ role: "read", loginId: "first_login_user", password: temporaryPassword, mustChangePassword: true }]
  });

  await page.goto("/login");
  await login(page, "first_login_user", temporaryPassword);
  await expect(page.getByRole("heading", { name: "비밀번호를 변경해 주세요" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  const protectedResponse = await page.evaluate(async () => {
    const response = await fetch("/api/sites", { credentials: "include" });
    const body = await response.json() as { code?: string };
    return { status: response.status, code: body.code };
  });
  expect(protectedResponse).toEqual({ status: 403, code: "PASSWORD_CHANGE_REQUIRED" });

  await page.getByLabel("현재 임시 비밀번호").fill(temporaryPassword);
  await page.getByLabel("새 비밀번호", { exact: true }).fill(permanentPassword);
  await page.getByLabel("새 비밀번호 확인").fill(permanentPassword);
  await page.getByRole("button", { name: "비밀번호 변경" }).click();

  await expect(page).toHaveURL(/\/monitoring$/);
  await expect(page.getByLabel("맵 선택")).toBeVisible();
  expect(api.accounts[0]?.mustChangePassword).toBe(false);
  expect(containsAnySecret(api.responseBodies, [temporaryPassword, permanentPassword])).toBe(false);
  expect(await pageContainsAnySecret(page, [temporaryPassword, permanentPassword])).toBe(false);
});

test("mock API가 중복 로그인 아이디와 100명 상한 초과 생성을 거절한다", async ({ page }) => {
  const api = await installProductApi(page, "admin");
  const temporaryPassword = runtimePassword("duplicate");

  await page.goto(`/settings/users?siteId=${siteId}`);
  await page.getByRole("button", { name: "사용자 추가" }).click();
  let createDialog = page.getByRole("dialog", { name: "사용자 추가" });
  await createDialog.getByLabel("이름").fill("기존 사용자");
  await createDialog.getByLabel("로그인 아이디").fill("duplicate.user");
  await createDialog.getByLabel("임시 비밀번호").fill(temporaryPassword);
  await createDialog.getByRole("button", { name: "사용자 생성" }).click();
  await expect(page.getByText("사용자를 생성했습니다.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "사용자 추가" }).click();
  createDialog = page.getByRole("dialog", { name: "사용자 추가" });
  await createDialog.getByLabel("이름").fill("중복 사용자");
  await createDialog.getByLabel("로그인 아이디").fill("duplicate.user");
  await createDialog.getByLabel("임시 비밀번호").fill(runtimePassword("duplicate-retry"));
  await createDialog.getByRole("button", { name: "사용자 생성" }).click();
  await expect(createDialog.getByRole("alert")).toHaveText("이미 사용 중인 로그인 아이디입니다.");
  await createDialog.getByRole("button", { name: "취소" }).click();

  await page.getByRole("button", { name: "사용자 추가" }).click();
  createDialog = page.getByRole("dialog", { name: "사용자 추가" });
  await createDialog.getByLabel("이름").fill("제한 초과 사용자");
  await createDialog.getByLabel("로그인 아이디").fill("limit.user");
  await createDialog.getByLabel("임시 비밀번호").fill(runtimePassword("limit"));
  api.users.push(...Array.from({ length: 99 }, (_, index) => ({
    id: `limit-user-${index}`,
    name: `제한 사용자 ${index}`,
    loginId: `limit.user.${index}`,
    accessLevel: "read" as const,
    status: "active" as const,
    lastLoginAt: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z"
  })));
  await createDialog.getByRole("button", { name: "사용자 생성" }).click();
  await expect(createDialog.getByRole("alert")).toHaveText("현장 사용자는 최대 100명까지 등록할 수 있습니다.");
  await expect(createDialog.getByRole("button", { name: "사용자 생성" })).toBeDisabled();
});

test("read, control, admin의 메뉴와 직접 경로 및 수동 제어 API 권한이 일치한다", async ({ browser, baseURL }) => {
  const read = await actorPage(browser, baseURL, "read");
  try {
    await read.page.goto(`/monitoring?siteId=${siteId}`);
    await expect(read.page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link")).toHaveText(["모니터링", "통계", "설정"]);
    await read.page.getByRole("link", { name: "설정", exact: true }).click();
    await expect(read.page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link")).toHaveText(["설정 개요", "맵 관리", "계정 보안"]);
    await read.page.goto(`/settings/users?siteId=${siteId}`);
    await expect(read.page).toHaveURL(new RegExp(`/settings\\?siteId=${siteId}`));
    await expect(read.page.getByRole("heading", { name: "설정 개요" })).toBeVisible();
    await expect(read.page.getByRole("heading", { name: "유저 관리" })).toHaveCount(0);
    await read.page.goto(`/control?siteId=${siteId}&mode=schedule`);
    await expect(read.page).toHaveURL(new RegExp(`/monitoring\\?siteId=${siteId}`));
    expect(await manualCommandStatus(read.page)).toBe(403);
  } finally {
    await read.page.close();
  }

  const control = await actorPage(browser, baseURL, "control");
  try {
    await control.page.goto(`/monitoring?siteId=${siteId}`);
    await expect(control.page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link")).toHaveText(["모니터링", "제어", "통계", "설정"]);
    await control.page.getByRole("link", { name: "설정", exact: true }).click();
    await expect(control.page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link")).toHaveText(["설정 개요", "맵 관리", "계정 보안"]);
    await control.page.goto(`/settings/users?siteId=${siteId}`);
    await expect(control.page).toHaveURL(new RegExp(`/settings\\?siteId=${siteId}`));
    await expect(control.page.getByRole("heading", { name: "유저 관리" })).toHaveCount(0);
    await control.page.goto(`/control?siteId=${siteId}&mode=schedule`);
    await expect(control.page).toHaveURL(new RegExp(`/control\\?siteId=${siteId}&mode=manual`));
    await expect(control.page.getByRole("tab", { name: "수동 제어" })).toBeVisible();
    await expect(control.page.getByRole("tab", { name: "스케줄 제어" })).toHaveCount(0);
    await expect(control.page.getByRole("tab", { name: "이벤트 제어" })).toHaveCount(0);
    await expect(control.page.getByRole("button", { name: "구역 관리" })).toHaveCount(0);
    await expect(control.page.getByRole("button", { name: "구역 현황" })).toBeVisible();
    expect(await manualCommandStatus(control.page)).toBe(201);

    await control.page.getByRole("button", { name: "조명 목록 열기" }).click();
    const fixtureDrawer = control.page.getByRole("dialog", { name: "조명 목록" });
    const fixtureCheckbox = fixtureDrawer.getByRole("checkbox", { name: "B2-L01 선택" });
    await fixtureCheckbox.locator("xpath=ancestor::label[1]").click();
    await expect(fixtureCheckbox).toBeChecked();
    await fixtureDrawer.getByRole("button", { name: "선택 완료" }).click();
    await control.page.getByRole("textbox", { name: "밝기 수치", exact: true }).fill("30");
    await control.page.getByRole("button", { name: "1개 조명에 밝기 적용" }).click();
    await expect(control.page.getByRole("status", { name: "명령 진행 상태" }).getByText("성공", { exact: true })).toBeVisible();
    await control.page.getByRole("button", { name: "상세 보기", exact: true }).click();
    await expect(control.page.getByRole("region", { name: "최근 결과 상세" }).getByText("조명 적용 완료 · 기본 밝기로 저장됨", { exact: true })).toBeVisible();
    expect(control.api.commandRequests).toHaveLength(2);
  } finally {
    await control.page.close();
  }

  const admin = await actorPage(browser, baseURL, "admin");
  try {
    await admin.page.goto(`/monitoring?siteId=${siteId}`);
    await expect(admin.page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link")).toHaveText(["모니터링", "제어", "통계", "설정"]);
    await admin.page.getByRole("link", { name: "설정", exact: true }).click();
    await expect(admin.page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link")).toHaveText(["설정 개요", "현장 관리", "유저 관리", "조명 등록", "맵 관리", "계정 보안"]);
    await admin.page.goto(`/control?siteId=${siteId}&mode=schedule`);
    await expect(admin.page.getByRole("tab", { name: "수동 제어" })).toBeVisible();
    await expect(admin.page.getByRole("tab", { name: "스케줄 제어" })).toBeVisible();
    await expect(admin.page.getByRole("tab", { name: "이벤트 제어" })).toBeVisible();
    await admin.page.goto(`/settings/users?siteId=${siteId}`);
    await expect(admin.page.getByRole("heading", { name: "유저 관리" })).toBeVisible();
    expect(await manualCommandStatus(admin.page)).toBe(201);
  } finally {
    await admin.page.close();
  }
});

type ActorRole = "admin" | "read" | "control";
type Account = {
  id: string;
  role: ActorRole;
  loginId: string;
  password: string;
  mustChangePassword: boolean;
  status: "active" | "disabled";
};
type SiteUser = {
  id: string;
  name: string;
  loginId: string;
  accessLevel: "read" | "control";
  status: "active" | "disabled";
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

interface ProductApiState {
  accounts: Account[];
  users: SiteUser[];
  createdPasswordDigests: string[];
  resetPasswordDigests: string[];
  updatedRequests: UpdateSiteUserRequest[];
  responseBodies: string[];
  commandRequests: unknown[];
}

type CreateSiteUserRequest = {
  name: string;
  loginId: string;
  temporaryPassword: string;
  accessLevel: "read" | "control";
  status: "active" | "disabled";
};

type UpdateSiteUserRequest = Omit<CreateSiteUserRequest, "temporaryPassword"> & {
  expectedUpdatedAt: string;
};

async function actorPage(browser: Browser, baseURL: string | undefined, role: ActorRole) {
  const page = await browser.newPage({ baseURL });
  return { page, api: await installProductApi(page, role) };
}

async function installProductApi(
  page: Page,
  initialRole: ActorRole | null,
  options: { accounts?: Array<Pick<Account, "role" | "loginId" | "password" | "mustChangePassword">> } = {}
): Promise<ProductApiState> {
  await installMockApiBoundary(page.context(), test.info().project.use.baseURL);
  const now = "2026-09-11T00:00:00.000Z";
  const accounts: Account[] = (options.accounts ?? [
    { role: initialRole ?? "read", loginId: `${initialRole ?? "read"}_user`, password: runtimePassword("actor"), mustChangePassword: false }
  ]).map((account) => ({ ...account, id: randomUUID(), status: "active" }));
  let principal = initialRole ? accounts.find((account) => account.role === initialRole) ?? accounts[0] : null;
  const state: ProductApiState = {
    accounts,
    users: [],
    createdPasswordDigests: [],
    resetPasswordDigests: [],
    updatedRequests: [],
    responseBodies: [],
    commandRequests: []
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    const method = request.method();

    if (path === "/auth/me") return respond(route, principal ? { user: authUser(principal) } : { code: "UNAUTHORIZED" }, principal ? 200 : 401, state);
    if (path === "/auth/login" && method === "POST") {
      const body = request.postDataJSON() as { loginId: string; password: string };
      const account = accounts.find((candidate) => candidate.loginId === body.loginId && candidate.password === body.password && candidate.status === "active");
      principal = account ?? null;
      return respond(route, account ? { user: authUser(account) } : { code: "INVALID_CREDENTIALS" }, account ? 201 : 401, state);
    }
    if (path === "/auth/change-password" && method === "POST") {
      const body = request.postDataJSON() as { currentPassword: string; newPassword: string };
      if (!principal || principal.password !== body.currentPassword) return respond(route, { code: "INVALID_CURRENT_PASSWORD" }, 400, state);
      principal.password = body.newPassword;
      principal.mustChangePassword = false;
      return respond(route, { ok: true, user: authUser(principal) }, 201, state);
    }
    if (path === "/auth/logout" && method === "POST") {
      principal = null;
      return respond(route, { ok: true }, 201, state);
    }
    if (!principal) return respond(route, { code: "UNAUTHORIZED" }, 401, state);
    if (principal.mustChangePassword) return respond(route, { code: "PASSWORD_CHANGE_REQUIRED" }, 403, state);

    if (path === "/sites") return respond(route, [{ id: siteId, name: "B2 테스트 현장", customerName: "테스트 고객사" }], 200, state);
    if (path === "/sites/default/dashboard" || path === `/sites/${siteId}/dashboard`) return respond(route, dashboardFor(principal.role), 200, state);
    if (path === `/sites/${siteId}/floors/${floorId}/fixtures`) return respond(route, { items: dashboardFixture(), nextCursor: null }, 200, state);
    if (path === `/sites/${siteId}/floors/${floorId}/map-snapshot`) return respond(route, { floorId, revision: 1, width: 1200, height: 800, floorPlan: null, objects: [] }, 200, state);

    if (path === `/sites/${siteId}/users` && method === "GET") {
      return principal.role === "admin" ? respond(route, { users: state.users, count: state.users.length, limit: 100 }, 200, state) : respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
    }
    if (path === `/sites/${siteId}/users` && method === "POST") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const body = assertCreateSiteUserRequest(request.postDataJSON());
      if (state.users.length >= 100) return respond(route, { code: "USER_LIMIT_REACHED" }, 409, state);
      if (accounts.some((account) => account.loginId === body.loginId)) {
        return respond(route, { code: "LOGIN_ID_ALREADY_EXISTS" }, 409, state);
      }
      state.createdPasswordDigests.push(digestSecret(body.temporaryPassword));
      const user = { id: randomUUID(), name: body.name, loginId: body.loginId, accessLevel: body.accessLevel, status: body.status, lastLoginAt: null, createdAt: now, updatedAt: now };
      state.users.push(user);
      accounts.push({ id: user.id, role: user.accessLevel, loginId: user.loginId, password: body.temporaryPassword, mustChangePassword: true, status: user.status });
      return respond(route, user, 201, state);
    }
    const userMatch = path.match(new RegExp(`^/sites/${siteId}/users/([^/]+)$`));
    if (userMatch && method === "PATCH") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const user = state.users.find((candidate) => candidate.id === userMatch[1]);
      if (!user) return respond(route, { code: "SITE_USER_NOT_FOUND" }, 404, state);
      const body = assertUpdateSiteUserRequest(request.postDataJSON());
      state.updatedRequests.push(body);
      if (body.expectedUpdatedAt !== user.updatedAt) return respond(route, { code: "SITE_USER_CHANGED" }, 409, state);
      Object.assign(user, {
        name: body.name,
        loginId: body.loginId,
        accessLevel: body.accessLevel,
        status: body.status,
        updatedAt: new Date(Date.parse(user.updatedAt) + 1_000).toISOString()
      });
      const account = accounts.find((candidate) => candidate.id === user.id);
      if (account) Object.assign(account, { loginId: user.loginId, role: user.accessLevel, status: user.status });
      return respond(route, user, 200, state);
    }
    const resetMatch = path.match(new RegExp(`^/sites/${siteId}/users/([^/]+)/reset-password$`));
    if (resetMatch && method === "POST") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const body = assertTemporaryPasswordRequest(request.postDataJSON());
      state.resetPasswordDigests.push(digestSecret(body.temporaryPassword));
      const account = accounts.find((candidate) => candidate.id === resetMatch[1]);
      if (account) Object.assign(account, { password: body.temporaryPassword, mustChangePassword: true });
      return respond(route, { ok: true }, 201, state);
    }
    if (userMatch && method === "DELETE") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const body = request.postDataJSON() as { confirmationLoginId: string };
      const index = state.users.findIndex((candidate) => candidate.id === userMatch[1] && candidate.loginId === body.confirmationLoginId);
      if (index < 0) return respond(route, { code: "INVALID_INPUT" }, 400, state);
      const [deleted] = state.users.splice(index, 1);
      const accountIndex = accounts.findIndex((candidate) => candidate.id === deleted.id);
      if (accountIndex >= 0) accounts.splice(accountIndex, 1);
      return respond(route, { ok: true }, 200, state);
    }

    if (path === "/commands/dimming" && method === "POST") {
      if (principal.role === "read") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      state.commandRequests.push(request.postDataJSON());
      return respond(route, { id: commandId, dispatchCount: 1, selectedTargetCount: 1, transmissionCount: 1, deliveryMode: "unicast", terminalStatusUrl: `/commands/${commandId}` }, 201, state);
    }
    if (path === `/commands/${commandId}` && method === "GET") {
      return respond(route, {
        id: commandId,
        stage: "completed",
        outcome: "applied",
        siteId,
        createdAt: now,
        // Match the server's three-calendar-month retention anchor; missing
        // anchors intentionally keep the production command controller locked.
        generatedAt: now,
        retainedFrom: "2026-06-11T00:00:00.000Z",
        dispatchCount: 1,
        completedFixtureCount: 1,
        totalFixtureCount: 1,
        errorMessage: null,
        dispatches: [{ id: "dispatch-1", status: "completed", gateway: { id: "gateway-1", name: "B2 Gateway" }, errorMessage: null, results: [{ fixtureId, fixtureName: "B2-L01", status: "succeeded", errorMessage: null }] }]
      }, 200, state);
    }

    return respond(route, { code: "NOT_FOUND", path }, 404, state);
  });
  return state;
}

async function userAction(page: Page, name: string, label: string) {
  await page.getByRole("button", { name: `${name} 작업` }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

function assertCreateSiteUserRequest(value: unknown): CreateSiteUserRequest {
  const body = assertExactRequestShape(value, ["accessLevel", "loginId", "name", "status", "temporaryPassword"]);
  expect(isNonEmptyString(body.name)).toBe(true);
  expect(isNonEmptyString(body.loginId)).toBe(true);
  expect(isNonEmptyString(body.temporaryPassword)).toBe(true);
  expect(body.accessLevel === "read" || body.accessLevel === "control").toBe(true);
  expect(body.status === "active" || body.status === "disabled").toBe(true);
  return body as CreateSiteUserRequest;
}

function assertUpdateSiteUserRequest(value: unknown): UpdateSiteUserRequest {
  const body = assertExactRequestShape(value, ["accessLevel", "expectedUpdatedAt", "loginId", "name", "status"]);
  expect(isNonEmptyString(body.name)).toBe(true);
  expect(isNonEmptyString(body.loginId)).toBe(true);
  expect(body.accessLevel === "read" || body.accessLevel === "control").toBe(true);
  expect(body.status === "active" || body.status === "disabled").toBe(true);
  expect(typeof body.expectedUpdatedAt === "string" && !Number.isNaN(Date.parse(body.expectedUpdatedAt))).toBe(true);
  return body as UpdateSiteUserRequest;
}

function assertTemporaryPasswordRequest(value: unknown) {
  const body = assertExactRequestShape(value, ["temporaryPassword"]);
  expect(isNonEmptyString(body.temporaryPassword)).toBe(true);
  return body as { temporaryPassword: string };
}

function assertExactRequestShape(value: unknown, expectedKeys: string[]) {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) throw new Error("mock API request body must be an object");
  expect(Object.keys(value).sort()).toEqual([...expectedKeys].sort());
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function respond(route: Route, body: unknown, status: number, state: ProductApiState) {
  const serialized = JSON.stringify(body);
  state.responseBodies.push(serialized);
  await route.fulfill({ status, contentType: "application/json", body: serialized });
}

function authUser(account: Account) {
  return {
    id: account.id,
    organizationId: "customer-organization-1",
    organizationType: "customer" as const,
    loginId: account.loginId,
    name: account.role === "admin" ? "고객 관리자" : "현장 사용자",
    role: account.role === "admin" ? "admin" as const : "viewer" as const,
    status: account.status,
    mustChangePassword: account.mustChangePassword
  };
}

function dashboardFor(role: ActorRole) {
  return {
    capabilities: { read: true, control: role === "admin" || role === "control", manage: role === "admin", commission: role === "admin" },
    site: { id: siteId, name: "B2 테스트 현장", customerName: "테스트 고객사", installationStatus: "installed", address: "서울", tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
    floors: [{ id: floorId, name: "B2", level: -2, floorPlan: null, meshControlGroups: [], fixtures: dashboardFixture() }],
    groups: [],
    gateways: [{ id: "gateway-1", name: "B2 Gateway", serialNumber: "GW-E2E-001", firmwareVersion: "1.0.0", lastHeartbeatAt: new Date().toISOString(), connectionStatus: "online" }]
  };
}

function dashboardFixture() {
  return [{
    id: fixtureId,
    name: "B2-L01",
    x: 100,
    y: 100,
    size: 20,
    placementStatus: "placed",
    positionVerifiedAt: null,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    statusReason: "reported",
    health: { faultCodes: [], observedAt: new Date().toISOString() },
    rssi: -50,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: new Date().toISOString(),
    gateway: { id: "gateway-1", name: "B2 Gateway", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null
  }];
}

async function login(page: Page, loginId: string, password: string) {
  await page.getByLabel("아이디").fill(loginId);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
}

async function manualCommandStatus(page: Page) {
  return page.evaluate(async ({ siteId: targetSiteId, fixtureId: targetFixtureId }) => {
    const response = await fetch("/api/commands/dimming", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ siteId: targetSiteId, clientRequestId: crypto.randomUUID(), target: { type: "fixture", fixtureId: targetFixtureId }, brightness: 50 })
    });
    return response.status;
  }, { siteId, fixtureId });
}

function runtimePassword(label: string) {
  return `${label}-${randomUUID()}-A1!`;
}

function digestSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function containsAnySecret(values: string[], secrets: string[]) {
  return values.some((value) => secrets.some((secret) => value.includes(secret)));
}

async function pageContainsAnySecret(page: Page, secrets: string[]) {
  const renderedValues = await page.evaluate(() => [
    document.body.textContent ?? "",
    ...Array.from(document.querySelectorAll("input, textarea"), (element) => (element as HTMLInputElement | HTMLTextAreaElement).value)
  ]);
  return containsAnySecret(renderedValues, secrets);
}
