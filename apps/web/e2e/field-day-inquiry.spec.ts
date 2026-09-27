import { expect, test } from "@playwright/test";

const concept = "/concepts/field-day.html";

test("공개 시안의 보고서 미리보기는 PDF만 표시하고 재생해도 형식 선택을 노출하지 않는다", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(concept);
  const report = page.locator("#report");
  await report.scrollIntoViewIfNeeded();

  await expect(report.getByText("PDF 보고서", { exact: true })).toBeVisible();
  await expect(report.getByRole("group", { name: "보고서 파일 형식 미리보기" })).toHaveCount(0);
  await expect(report.getByRole("button", { name: /XLSX|CSV|PDF/ })).toHaveCount(0);
  await expect(report.getByRole("status")).toContainText("PDF");

  await report.getByRole("button", { name: "보고서 예시 다시 보기" }).click();
  await expect(report.getByRole("status")).toContainText("PDF");
  await expect(report.getByRole("button", { name: /XLSX|CSV|PDF/ })).toHaveCount(0);
});

async function fillInquiry(page: import("@playwright/test").Page) {
  await page.getByLabel("회사명 *").fill("  예시 회사  ");
  await page.getByLabel("담당자 이름 *").fill("  김담당  ");
  await page.getByLabel("회신 이메일 *").fill("  test@example.com  ");
  await page.getByLabel("전화번호 선택").fill("  010-1234-5678  ");
  await page.getByLabel("고객 유형 선택").selectOption("facility");
  await page.getByLabel("문의 내용 *").fill("  상담을 요청합니다.  ");
  await page.getByLabel("개인정보 수집·이용에 동의합니다 *").check();
}

test("세 상담 버튼은 현재 시안의 팝업을 열고 닫으면 포커스가 돌아온다", async ({ page }) => {
  await page.goto(concept);
  const buttons = page.locator("[data-open-inquiry]");
  await expect(buttons).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await buttons.nth(index).click();
    await expect(page.getByRole("dialog", { name: "도입 상담" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${concept}$`));
    if (index === 0) await page.getByRole("button", { name: "상담 팝업 닫기" }).click();
    else await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "도입 상담" })).toBeHidden();
    await expect(buttons.nth(index)).toBeFocused();
  }
});

test("상담 폼은 정규화된 계약으로 제출하고 접수번호를 표시한다", async ({ page }) => {
  let payload: Record<string, unknown> | undefined;
  await page.route("**/api/landing/inquiries", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ status: "received", reference: "KND-TEST-001" }) });
  });
  await page.goto(concept);
  await page.locator("[data-open-inquiry]").first().click();
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByText("회사명을 입력해 주세요.")).toBeVisible();
  await fillInquiry(page);
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByText("상담 문의가 접수되었습니다.")).toBeVisible();
  await expect(page.getByText("접수번호: KND-TEST-001")).toBeVisible();
  await expect(page.getByRole("link", { name: "이메일로 직접 문의하기" })).toBeHidden();
  expect(payload).toMatchObject({
    companyName: "예시 회사", contactName: "김담당", email: "test@example.com",
    phone: "010-1234-5678", audience: "facility", message: "상담을 요청합니다.",
    consent: true, consentVersion: "landing-2026-09-v1-90d", website: "",
  });
  expect(payload?.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(4096);
});

test("실패한 동일 문의는 키를 유지하고 503에서 직접 메일을 안내한다", async ({ page }) => {
  const keys: string[] = [];
  let calls = 0;
  await page.route("**/api/landing/inquiries", async (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    calls += 1;
    await route.fulfill({ status: calls === 1 ? 500 : calls === 2 ? 503 : 201, contentType: "application/json", body: calls === 3 ? JSON.stringify({ status: "received", reference: "KND-TEST-002" }) : "{}" });
  });
  await page.goto(concept);
  await page.locator("[data-open-inquiry]").first().click();
  await fillInquiry(page);
  const send = page.getByRole("button", { name: "상담 문의 보내기" });
  await send.click();
  await expect(page.getByText("접수 결과를 확인하지 못했습니다.")).toBeVisible();
  await expect(page.getByRole("link", { name: "이메일로 직접 문의하기" })).toBeHidden();
  await expect(page.getByLabel("회사명 *")).toHaveValue("  예시 회사  ");
  await send.click();
  await expect(page.getByText("현재 온라인 상담을 접수할 수 없습니다.")).toBeVisible();
  await expect(page.getByRole("link", { name: "이메일로 직접 문의하기" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
  expect(keys[1]).toBe(keys[0]);
  await page.getByLabel("문의 내용 *").fill("새 문의입니다.");
  await send.click();
  await expect(page.getByText("접수번호: KND-TEST-002")).toBeVisible();
  expect(keys[2]).not.toBe(keys[0]);
});

test("390px 화면에서 팝업을 끝까지 스크롤할 수 있다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(concept);
  await page.locator("[data-open-inquiry]").first().click();
  const dialog = page.getByRole("dialog", { name: "도입 상담" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "상담 문의 보내기" })).toBeAttached();
  const metrics = await dialog.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight, width: node.getBoundingClientRect().width }));
  expect(metrics.scroll).toBeGreaterThan(metrics.client);
  expect(metrics.width).toBeLessThan(390);
  await page.getByRole("button", { name: "상담 문의 보내기" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "상담 문의 보내기" })).toBeInViewport();
});

test("UTF-8 본문이 4KB를 넘으면 전송하지 않는다", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/landing/inquiries", async (route) => {
    calls += 1;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ status: "received", reference: "UNEXPECTED" }) });
  });
  await page.goto(concept);
  await page.locator("[data-open-inquiry]").first().click();
  await fillInquiry(page);
  await page.getByLabel("문의 내용 *").fill("가".repeat(1500));
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByText("문의 내용이 너무 깁니다. 내용을 줄여 주세요.")).toBeVisible();
  expect(calls).toBe(0);
});

test("접수 중에는 세 닫기 경로를 막고 응답 후 닫기와 포커스 복귀를 허용한다", async ({ page }) => {
  let releaseReply!: () => void;
  const reply = new Promise<void>((resolve) => { releaseReply = resolve; });
  await page.route("**/api/landing/inquiries", async (route) => {
    await reply;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ status: "received", reference: "KND-PENDING" }) });
  });
  await page.goto(concept);
  const trigger = page.locator("[data-open-inquiry]").first();
  await trigger.click();
  await fillInquiry(page);
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  const dialog = page.getByRole("dialog", { name: "도입 상담" });
  await expect(page.getByRole("button", { name: "접수 중" })).toHaveAttribute("aria-disabled", "true");
  const close = page.getByRole("button", { name: "상담 팝업 닫기" });
  await expect(close).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByRole("status")).toHaveText("상담 문의를 접수하고 있습니다. 잠시만 기다려 주세요.");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await close.evaluate((button: HTMLButtonElement) => button.click());
  await page.keyboard.press("Escape");
  await page.mouse.click(3, 300);
  await expect(dialog).toBeVisible();
  releaseReply();
  await expect(page.getByText("접수번호: KND-PENDING")).toBeVisible();
  await expect(close).toHaveAttribute("aria-disabled", "false");
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
