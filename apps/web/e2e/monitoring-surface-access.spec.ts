import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installSettingsApiRoutes, type SettingsFixture } from './support/settings-api';

// These are the original Task9 two-fixture inputs, not denser or taller data
// chosen to make native scrolling pass. All API activity remains software-only.
const ids = { siteId: '99999999-9999-4999-8999-000000000001', floorId: '99999999-9999-4999-8999-000000000002', gatewayId: '99999999-9999-4999-8999-000000000003' };
const instant = '2026-10-01T15:00:00.000Z';
const id = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, '0')}`;
async function install(page: Page) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient'));
  const fixtures: SettingsFixture[] = [1, 2].map(n => ({ id: id(100 + n), name: `Task9 조명 ${n}`, x: n === 1 ? 350 : 750, y: n === 1 ? 250 : 450, ratedWatt: 40, brightness: 70,
    status: 'online', statusReason: 'reported', health: null, rssi: -60, hopCount: 1, commandSuccessRate: 1, lastSeenAt: instant,
    gateway: { id: ids.gatewayId, name: 'Task9 Gateway', connectionStatus: 'online' }, controllable: true, controlBlockReason: null }));
  const api = await installSettingsApiRoutes(page, 'admin', { ids, fixtures, snapshotGeneratedAt: instant, gatewayHeartbeatAt: instant });
  const reads: Record<string, string>[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    if (url.pathname.endsWith('/monitoring-activity')) {
      expect(route.request().method()).toBe('GET');
      const params = Object.fromEntries(url.searchParams); reads.push(params);
      const limit = Number(params.limit), start = params.cursor ? limit + 1 : 1;
      return route.fulfill({ json: { generatedAt: instant, retainedFrom: '2026-07-01T15:00:00Z',
        items: Array.from({ length: limit }, (_, i) => ({ id: id(20_000 + start + i), kind: 'fixture_online', recordedAt: instant, displayName: `Task9 운영 기록 ${start + i}` })), nextCursor: params.cursor ? null : 'task9-page2' } });
    }
    if (url.pathname.endsWith('/monitoring-incidents')) return route.fulfill({ json: { incidents: [], unreadCount: 0, activeCount: 0, nextCursor: null } });
    // The reusable settings installer handles known contracts; unknown API404
    // is its last branch, never a proxy fallback to an actual API process.
    return route.fallback();
  });
  return { api, reads };
}
async function paints(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function metrics(body: Locator) {
  return body.evaluate(node => {
    const owner = (element: Element) => ({ tag: element.tagName, name: element.getAttribute('aria-label'), detail: element.hasAttribute('data-monitoring-detail-scroll'),
      top: element.scrollTop, client: element.clientHeight, total: element.scrollHeight, overflow: getComputedStyle(element).overflowY, overscroll: getComputedStyle(element).overscrollBehaviorY });
    return { ...owner(node), box: node.getBoundingClientRect().toJSON(), pageY: scrollY, active: document.activeElement?.outerHTML.slice(0, 250),
      descendants: [...node.querySelectorAll('[data-monitoring-detail-panel]')].map(owner),
      surface: node.closest('[role="dialog"],aside[aria-label="조명 상세"]') ? owner(node.closest('[role="dialog"],aside[aria-label="조명 상세"]')!) : null };
  });
}
async function hit(target: Locator, port: Locator = target) {
  const clip = (await port.boundingBox())!;
  return target.evaluate((node, clip) => {
    const r = node.getBoundingClientRect(), left = Math.max(0, r.left, clip.x), top = Math.max(0, r.top, clip.y), right = Math.min(innerWidth, r.right, clip.x + clip.width), bottom = Math.min(innerHeight, r.bottom, clip.y + clip.height);
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 }, actual = document.elementFromPoint(point.x, point.y);
    return { point, reachable: bottom > top && right > left && (node === actual || node.contains(actual)), target: actual?.outerHTML.slice(0, 250), rect: r.toJSON() };
  }, clip);
}
async function attach(info: TestInfo, label: string, data: unknown) {
  await info.attach(label, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}
async function nativeTabTo(page: Page, target: Locator) {
  // FocusScope may retain its last real control after a pointer click on text.
  // Enter the existing tab order instead of assigning focus/scroll in script.
  for (let step = 0; step < 24; step++) {
    if (await target.evaluate(node => node === document.activeElement)) return step;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
  return 24;
}
async function camera(viewport: Locator) {
  return viewport.evaluate(node => {
    const s = node.querySelector('[data-floor-map-surface]')!.getBoundingClientRect(), v = node.getBoundingClientRect();
    return { zoom: node.getAttribute('data-zoom'), x: (v.x + v.width / 2 - s.x) / s.width, y: (v.y + v.height / 2 - s.y) / s.height };
  });
}

test('monitoring detail native wheel keyboard last information and nonzero breakpoint restoration', async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 480 }); const state = await install(page);
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  expect(await page.evaluate(() => fetch('/api/task9-finish-unknown').then(response => response.status))).toBe(404);
  const viewport = page.getByTestId('monitoring-map-viewport'), originalMarker = page.locator('[data-spatial-map-marker][title="Task9 조명 1"]');
  await page.getByRole('button', { name: '지도 확대', exact: true }).click();
  // Query the literal original fixture, never a first-hit replacement.
  await originalMarker.click(); await page.getByRole('button', { name: '상세 보기', exact: true }).click(); await paints(page);
  const body = page.locator('[data-monitoring-detail-scroll]');
  const originalCamera = await camera(viewport);
  await page.evaluate(() => {
    const records: unknown[] = [];
    (window as unknown as { monitoringNativeEvents: unknown[] }).monitoringNativeEvents = records;
    for (const capture of [true, false]) document.addEventListener('wheel', event => records.push({ kind: 'wheel', capture, trusted: event.isTrusted, prevented: event.defaultPrevented, deltaY: event.deltaY,
      target: (event.target as Element)?.outerHTML.slice(0, 160), path: event.composedPath().filter(n => n instanceof Element).map(n => ({ tag: (n as Element).tagName, detail: (n as Element).hasAttribute('data-monitoring-detail-scroll'), map: (n as Element).getAttribute('data-testid') })) }), { capture, passive: true });
    document.addEventListener('scroll', event => records.push({ kind: 'scroll', target: (event.target as Element)?.outerHTML?.slice(0, 160), pageY: scrollY }), { capture: true, passive: true });
  });
  const observations: unknown[] = [];
  try {
    await body.scrollIntoViewIfNeeded(); await paints(page);
    // Expose the surface's trailing chrome with one ordinary page-gutter
    // wheel before measuring detail input. Never scroll the final row itself.
    const gutter = await page.locator('[data-shell-content]').evaluate(node => {
      const rect = node.getBoundingClientRect(), point = { x: rect.left + 2, y: Math.min(innerHeight / 2, rect.bottom - 2) }, target = document.elementFromPoint(point.x, point.y);
      return { point, pageTarget: Boolean(target && node.contains(target) && !target.closest('[data-monitoring-layout],button,nav,header')), target: target?.outerHTML.slice(0, 160), before: scrollY };
    });
    expect(gutter.pageTarget).toBe(true);
    await page.mouse.move(gutter.point.x, gutter.point.y); await page.mouse.wheel(0, 80);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight));
    observations.push({ step: 'native-page-gutter-exposure', gutter, after: await page.evaluate(() => scrollY) });
    const point = await hit(body); expect(point.reachable).toBe(true); const before = await metrics(body);
    const wheelPageOrigin = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await page.mouse.move(point.point.x, point.point.y); await page.mouse.wheel(0, 80);
    await expect.soft.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect.soft(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(wheelPageOrigin);
    observations.push({ step: 'native-wheel-before-capture', before, hit: point, after: await metrics(body), camera: await camera(viewport) });
    // Native click and keys are measured independently. No scripted focus or
    // scrollTop writes can manufacture successful browser-default movement.
    await page.mouse.click(point.point.x, point.point.y);
    const tabSteps = await nativeTabTo(page, body);
    await expect(body).toBeFocused();
    await paints(page);
    const pageOrigin = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    for (const key of ['Home', 'PageDown', 'End']) {
      const beforeKey = await metrics(body); await page.keyboard.press(key); await paints(page);
      if (key === 'Home') await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(0);
      if (key === 'PageDown') await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      if (key === 'End') await expect.poll(() => body.evaluate(node => Math.abs(node.scrollTop + node.clientHeight - node.scrollHeight))).toBeLessThanOrEqual(1);
      await expect(body).toBeFocused();
      expect.soft(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(pageOrigin);
      observations.push({ step: `native-${key}`, before: beforeKey, after: await metrics(body) });
    }
    const last = body.getByText('배치됨', { exact: true });
    await expect.soft.poll(() => body.evaluate(node => Math.abs(node.scrollTop + node.clientHeight - node.scrollHeight))).toBeLessThanOrEqual(1);
    expect.soft((await hit(last, body)).reachable).toBe(true);
    const readable = await body.evaluate(node => {
      const body = node.getBoundingClientRect(), row = node.querySelector('dl')!.lastElementChild!.getBoundingClientRect();
      const values = [...node.querySelector('dl')!.lastElementChild!.querySelectorAll('dt,dd')].map(element => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() }));
      return { body: body.toJSON(), row: row.toJSON(), values, page: { x: scrollX, y: scrollY } };
    });
    observations.push({ step: 'full-final-information-readability', tabSteps, readable });
    // A positive viewport or hittable text sliver is insufficient. The natural
    // map minimum must leave space for a complete semantic detail row, and End
    // must show both its label and full value within the actual visible clip.
    expect.soft(readable.body.height).toBeGreaterThanOrEqual(readable.row.height);
    for (const value of readable.values) {
      expect.soft(value.rect.top).toBeGreaterThanOrEqual(Math.max(0, readable.body.top));
      expect.soft(value.rect.bottom).toBeLessThanOrEqual(Math.min(480, readable.body.bottom));
    }
    expect.soft(readable.page).toEqual(pageOrigin);
    const saved = await body.evaluate(node => node.scrollTop); expect.soft(saved).toBeGreaterThan(0);
    for (const width of [1023, 1024, 1023, 1025]) {
      await page.setViewportSize({ width, height: 480 }); await paints(page);
      const surface = page.getByRole(width >= 1024 ? 'complementary' : 'dialog', { name: '조명 상세', exact: true });
      await expect(surface).toBeVisible(); await expect(originalMarker).toHaveAttribute('data-selected', 'true');
      const expected = await body.evaluate((node, saved) => Math.min(saved, node.scrollHeight - node.clientHeight), saved);
      await expect.soft.poll(() => body.evaluate(node => node.scrollTop)).toBe(expected);
      const current = await camera(viewport); expect(current.zoom).toBe(originalCamera.zoom); expect(Math.abs(current.x - originalCamera.x)).toBeLessThan(.02); expect(Math.abs(current.y - originalCamera.y)).toBeLessThan(.02);
      await expect.poll(() => surface.evaluate(node => node.contains(document.activeElement))).toBe(true);
      observations.push({ step: `crossing-${width}`, expected, body: await metrics(body), camera: current });
    }
    await page.getByRole('button', { name: '조명 상세 닫기', exact: true }).click(); await expect(originalMarker).toBeFocused();
    const shortMap = (await viewport.boundingBox())!;
    expect(shortMap.height).toBeGreaterThanOrEqual(240);
    await page.setViewportSize({ width: 1025, height: 900 }); await paints(page);
    await expect.poll(async () => (await viewport.boundingBox())!.height).toBeGreaterThan(shortMap.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(state.api.dimmingRequests).toHaveLength(0);
    expect(state.api.requests.filter(request => !request.startsWith('GET '))).toEqual([]);
  } finally {
    await attach(info, 'native-detail-input-before-screenshot', { observations, events: await page.evaluate(() => (window as unknown as { monitoringNativeEvents: unknown[] }).monitoringNativeEvents), requests: state.api.requests });
    await info.attach('native-detail-final', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  }
});

test('monitoring log positive env24/34 owns insets and native list controls stay reachable', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 320 }); const state = await install(page);
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  const cdp = await page.context().newCDPSession(page);
  const trigger = page.getByRole('region', { name: '최근 운영 로그', exact: true }).getByRole('button', { name: '전체 보기', exact: true });
  const bounds = async (dialog: Locator) => dialog.evaluate(node => {
    const box = (element: Element) => element.getBoundingClientRect().toJSON();
    return { owner: node.querySelectorAll('[data-dialog-safe-area]').length, close: box(node.querySelector('[data-dialog-close]')!), footer: box(node.querySelector('footer')!),
      filter: box(node.querySelector('[aria-label="운영 로그 필터·상태"]')!), list: box(node.querySelector('[aria-label="운영 로그 본문"]')!) };
  });
  const records: unknown[] = [];
  try {
    await trigger.click(); let dialog = page.getByRole('dialog', { name: '전체 로그', exact: true });
    const zero = await bounds(dialog); await dialog.getByRole('button', { name: '전체 로그 닫기' }).click(); await expect(trigger).toBeFocused();
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 24, bottom: 34, left: 0, right: 0 } });
    await trigger.click(); dialog = page.getByRole('dialog', { name: '전체 로그', exact: true });
    const positive = await bounds(dialog); records.push({ zero, positive });
    expect.soft(positive.owner).toBe(1); expect.soft(positive.close.top).toBeGreaterThanOrEqual(24); expect.soft(positive.footer.bottom).toBeLessThanOrEqual(286);
    // A numerically positive 1px viewport is not usable. Keep a complete native
    // 44px interaction/reading band in each independently scrolling region.
    expect(positive.filter.height).toBeGreaterThanOrEqual(44); expect(positive.list.height).toBeGreaterThanOrEqual(44);
    await info.attach('log-positive-env-viewport', { body: await page.screenshot(), contentType: 'image/png' });
    for (const control of ['전체 로그 닫기', '페이지당 항목 수', '이전 페이지', '다음 페이지']) {
      const target = dialog.getByRole('button', { name: control, exact: true }), rect = (await target.boundingBox())!;
      expect(rect.height).toBeGreaterThanOrEqual(44); expect(rect.width).toBeGreaterThanOrEqual(44);
      expect((await hit(target, dialog)).reachable).toBe(true);
    }
    const list = dialog.getByRole('region', { name: '운영 로그 본문', exact: true });
    for (const size of [50, 100, 500, 1000]) {
      if (size !== 50) { await dialog.getByRole('button', { name: '페이지당 항목 수' }).click(); await page.getByRole('option', { name: `${size}개`, exact: true }).click(); }
      await expect(list.locator('li')).toHaveCount(size);
      const point = await hit(list); expect(point.reachable).toBe(true);
      await page.mouse.click(point.point.x, point.point.y);
      const clickFocus = await metrics(list), tabSteps = await nativeTabTo(page, list);
      await page.keyboard.press('Home'); await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0);
      await page.mouse.wheel(0, 700); await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      records.push({ step: 'before-native-End', size, clickFocus, tabSteps, list: await metrics(list) });
      await expect(list).toBeFocused(); await page.keyboard.press('End');
      await expect.poll(() => list.evaluate(node => Math.abs(node.scrollTop + node.clientHeight - node.scrollHeight))).toBeLessThanOrEqual(1);
      expect((await hit(list.locator('li').last(), list)).reachable).toBe(true);
      expect((await bounds(dialog)).footer).toEqual(positive.footer);
      records.push({ size, list: await metrics(list), bounds: await bounds(dialog) });
    }
    await dialog.getByRole('button', { name: '다음 페이지', exact: true }).click(); await expect(dialog.getByText('2페이지', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '이전 페이지', exact: true }).click(); await expect(dialog.getByText('1페이지', { exact: true })).toBeVisible();
    const filters = dialog.getByRole('region', { name: '운영 로그 필터·상태', exact: true });
    await filters.click(); await nativeTabTo(page, filters); await page.keyboard.press('Home');
    const dates = filters.getByRole('spinbutton'); await expect(dates).toHaveCount(6);
    for (const offset of [0, 3]) for (const [index, text] of [[2, '25'], [1, '9'], [0, '2026']] as const) {
      const segment = dates.nth(offset + index);
      await nativeTabTo(page, segment);
      const segmentHit = await hit(segment, filters); expect(segmentHit.reachable).toBe(true);
      records.push({ step: 'native-date-input', offset, index, segmentHit });
      // Numeric segments advance as soon as their value is complete. Insert
      // the selected segment's entire value (native paste/IME input), rather
      // than letting the remaining digits type into the next segment.
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text);
    }
    await page.keyboard.press('Tab'); await expect.poll(() => state.reads.some(r => r.fromDate === '2026-09-25' && r.toDate === '2026-09-25' && r.limit === '1000')).toBe(true);
    const periodReset = filters.getByRole('button', { name: '전체 보관 기간', exact: true });
    await nativeTabTo(page, periodReset); expect((await hit(periodReset, filters)).reachable).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => state.reads.at(-1)?.fromDate).toBeUndefined();
    await dialog.getByRole('button', { name: '전체 로그 닫기' }).click(); await expect(trigger).toBeFocused();
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
    await trigger.click(); dialog = page.getByRole('dialog', { name: '전체 로그', exact: true }); const reset = await bounds(dialog);
    expect(reset.close).toEqual(zero.close); expect(reset.footer).toEqual(zero.footer);
    records.push({ reset, reads: state.reads }); await dialog.getByRole('button', { name: '전체 로그 닫기' }).click();
    expect(state.api.dimmingRequests).toHaveLength(0);
  } finally {
    await attach(info, 'log-positive-safe-area-input', records);
    await info.attach('log-positive-safe-area', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } }); await cdp.detach();
  }
});
