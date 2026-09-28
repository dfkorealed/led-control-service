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


test("concept uses the shared Vite entry without public styles", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  const check = async () => {
    await expect(page).toHaveTitle("현장의 하루 · 킨다 랜딩 시안");
    await expect(page.locator("[data-open-inquiry]")).toHaveCount(3);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("현장의 하루,");
  };
  await page.goto("/concepts/index.html");
  await page.locator('a[href="field-day.html"]').click();
  await check();
  await page.reload();
  await check();
  await page.getByRole("link", { name: "로그인" }).click();
  await page.goBack();
  await check();
  await page.goto(concept);
  await check();
  expect(requests).not.toContain("/concepts/field-day.css");
  expect(requests).not.toContain("/concepts/field-day.js");
});

test("시안 문의는 닫고 다시 열어도 입력 내용과 실패한 문의 키를 유지한다", async ({ page }) => {
  const keys: string[] = [];
  await page.route("**/api/landing/inquiries", async route => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await page.goto(concept);
  const trigger = page.locator("[data-open-inquiry]").first();
  await trigger.click();
  await expect(page.getByRole("heading", { name: "도입 상담", exact: true })).toBeFocused();
  await fillInquiry(page);
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByText("현재 온라인 상담을 접수할 수 없습니다.")).toBeVisible();
  await page.keyboard.press("Escape");
  await trigger.click();
  await expect(page.getByLabel("회사명 *")).toHaveValue("  예시 회사  ");
  await expect(page.getByText("현재 온라인 상담을 접수할 수 없습니다.")).toBeVisible();
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
});

test("시안 성공 상태와 네이티브 필드 계약은 팝업 재진입에도 유지된다", async ({ page }) => {
  await page.route("**/api/landing/inquiries", route => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ status: "received", reference: "KND-PERSIST" }) }));
  await page.goto(concept);
  const trigger = page.locator("[data-open-inquiry]").first();
  await trigger.click();
  for (const [label, maxLength, autocomplete] of [["회사명 *", "120", "organization"], ["담당자 이름 *", "80", "name"], ["회신 이메일 *", "254", "email"], ["전화번호 선택", "30", "tel"]]) {
    await expect(page.getByLabel(label)).toHaveAttribute("maxlength", maxLength);
    await expect(page.getByLabel(label)).toHaveAttribute("autocomplete", autocomplete);
  }
  await expect(page.getByLabel("문의 내용 *")).toHaveAttribute("maxlength", "2000");
  expect(await page.getByLabel("고객 유형 선택").evaluate(node => node.tagName)).toBe("SELECT");
  await fillInquiry(page);
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  const close = page.getByRole("button", { name: "상담 팝업 닫기" });
  await expect(close).toBeFocused();
  await expect(page.getByRole("button", { name: "상담 문의 보내기" })).toBeDisabled();
  await close.click();
  await trigger.click();
  await expect(page.getByText("접수번호: KND-PERSIST")).toBeVisible();
  await expect(page.getByRole("button", { name: "상담 문의 보내기" })).toBeDisabled();
});

test("시안 PDF 미리보기와 공개 페이지의 인증 조회 부재를 보존한다", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) calls.push(path); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(concept);
  const report = page.locator("#report");
  await report.scrollIntoViewIfNeeded();
  await expect(report.getByText("PDF 형식", { exact: true })).toBeVisible();
  await expect(report.getByRole("status")).toHaveText("예시 PDF 보고서 미리보기가 준비됐습니다.");
  await expect(report.getByRole("button", { name: /PDF|CSV|XLSX/ })).toHaveCount(0);
  expect(calls).toEqual([]);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "CSV", exact: true })).toHaveCount(0);
});

test("시안 맵 도구는 원래 드롭 시점의 확대 이동과 취소·재생 흐름을 보존한다", async ({ page }) => {
  await page.goto(concept);
  const scene = page.locator('.scene--map');
  await scene.scrollIntoViewIfNeeded();
  const place = scene.locator('.button--tool');
  const marker = scene.locator('.map-light--placed');
  // The original concept marker is decorative; only the site has a movable
  // keyboard marker, so it is intentionally absent from the concept focus set.
  await expect(marker).toHaveAttribute('aria-hidden', 'true');
  expect(await marker.evaluate(node => node.tagName)).toBe('SPAN');
  await place.click();
  await expect.poll(() => scene.locator('.map-drag-ghost').evaluate(node => node.getAnimations().some(animation => animation.effect?.getTiming().duration === 1150))).toBe(true);
  await expect.poll(() => marker.evaluate(node => node.getAnimations().some(animation => animation.effect?.getTiming().duration === 950))).toBe(true);
  const move = await marker.evaluate(async node => {
    const animation = node.getAnimations().find(item => item.effect?.getTiming().duration === 950)!;
    animation.pause(); animation.currentTime = 475;
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { timing: animation.effect!.getTiming(), frames: (animation.effect as KeyframeEffect).getKeyframes().map(frame => ({ left: frame.left, top: frame.top, transform: frame.transform, offset: frame.computedOffset })), transform: getComputedStyle(node).transform };
  });
  expect(move.timing.easing).toBe('ease-in-out');
  expect(move.frames).toEqual([
    { left: '65%', top: '36%', transform: 'scale(1)', offset: 0 },
    { left: '72%', top: '53%', transform: 'scale(1.18)', offset: .72 },
    { left: '72%', top: '53%', transform: 'scale(1)', offset: 1 }
  ]);
  expect(Number(move.transform.match(/matrix\(([^,]+)/)?.[1])).toBeGreaterThan(1);
  await scene.locator('.button--quiet').click();
  await expect(marker).toHaveCSS('opacity', '0');
  expect(await marker.evaluate(node => node.getAnimations().length)).toBe(0);
  const cancelled = await marker.evaluate(node => { const style = getComputedStyle(node), parent = node.parentElement!; return { left: style.left, top: style.top, width: parent.clientWidth, height: parent.clientHeight }; });
  expect(Math.abs(parseFloat(cancelled.left) - cancelled.width * .72)).toBeLessThan(1 / 64);
  expect(Math.abs(parseFloat(cancelled.top) - cancelled.height * .53)).toBeLessThan(1 / 64);
  await place.click();
  await expect.poll(() => scene.locator('.map-drag-ghost').evaluate(node => node.getAnimations().length)).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => scene.locator('.map-drag-ghost').evaluate(node => node.getAnimations().length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await scene.scrollIntoViewIfNeeded();
  await place.click();
  await expect(marker).toHaveCSS('opacity', '1');
  await expect(scene.getByText('배치된 조명 3개')).toBeVisible();
  expect(await marker.evaluate(node => node.getAnimations().length)).toBe(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  for (const action of ["replay", "reenter"]) {
    test(`시안 PDF 보고서는 재생·재진입 후에도 형식 선택 없이 유지된다 (${action}, ${reducedMotion})`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion });
      await page.goto(concept);
      const report = page.locator("#report");
      await report.scrollIntoViewIfNeeded();
      await expect(report).toHaveClass(/is-complete/);
      const assertFormat = async () => {
        await expect(report.getByRole("button", { name: /PDF|XLSX|CSV|Excel/ })).toHaveCount(0);
        await expect(report.locator(".report-sheet__footer")).toHaveText("작성 완료 예시PDF 형식");
        await expect(report.locator(".report-history strong")).toHaveText("주간 조명 운영 보고서 · PDF");
        await expect(report.locator(".demo-disclaimer")).toHaveText("설명용 PDF 보고서입니다. 파일을 만들거나 내려받지 않습니다.");
      };
      {
        await assertFormat();
        const previousSheet = await report.locator(".report-sheet").elementHandle();
        if (action === "replay") {
          await report.getByRole("button", { name: "보고서 예시 다시 보기" }).click();
        } else {
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await expect.poll(() => report.evaluate(node => node.getBoundingClientRect().top >= innerHeight)).toBe(true);
          // Allow the real observer to record the exit before re-entering.
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await report.scrollIntoViewIfNeeded();
        }
        // A new sheet proves replay/re-entry actually ran. Waiting for completion
        // plus two frames avoids accepting a pre-replay completion on reduced motion.
        await expect.poll(() => previousSheet!.evaluate(node => node.isConnected)).toBe(false);
        await expect(report).toHaveClass(/is-complete/);
        await expect(report.getByRole("status")).toHaveText("예시 PDF 보고서 미리보기가 준비됐습니다.");
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertFormat();
      }
    });
  }
}
