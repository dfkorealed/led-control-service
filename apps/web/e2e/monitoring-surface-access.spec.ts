import { existsSync } from 'node:fs';
import { chromium, expect, test, type CDPSession, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installSettingsApiRoutes, type SettingsFixture } from './support/settings-api';
import { expectNoHorizontalOverflow } from './support/layout-assertions';

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
  return { api, reads, fixtures };
}

for (const size of [{ width: 320, height: 740 }, { width: 562, height: 1229 }, { width: 1304, height: 1229 }]) {
  for (const theme of ['light', 'dark']) test(`ATLAS monitoring server24 loaded2 theme camera ${theme} ${size.width}px`, async ({ page }, info) => {
    await page.setViewportSize(size);
    await page.addInitScript(value => localStorage.setItem('led-control.customer-theme.v1', value), theme);
    const state = await install(page);
    await page.route('**/api/**/dashboard*', route => route.fulfill({ json: {
      generatedAt: instant, monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
      capabilities: { read: true, control: true, manage: true, commission: true },
      site: { id: ids.siteId, name: 'ATLAS 현장', customerName: '고객사', installationStatus: 'installed', address: '서울', tariffKwhRate: 160, timeZone: 'Asia/Seoul' },
      summary: { totalFixtures: 48, onlineFixtures: 40, faultFixtures: 0, offlineFixtures: 8, averageBrightness: 70 },
      floors: [{ id: ids.floorId, name: 'B2', level: -2, summary: { totalFixtures: 24, onlineFixtures: 20, faultFixtures: 0, offlineFixtures: 4 }, mapRevision: 0,
        mapConfigured: true, floorPlan: { imageUrl: '/demo/floor-b2.svg', width: 1200, height: 800, version: 1 }, meshControlGroups: [], fixtures: [] }], groups: [], gateways: []
    } }));
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    await expect(page.getByRole('heading', { level: 1, name: '모니터링', exact: true })).toHaveCount(1);
    const pageTitle = page.getByRole('group', { name: '모니터링 도구' }).locator('h2');
    if (size.width < 760) await expect(pageTitle).toBeVisible();
    else await expect(pageTitle).toBeHidden();
    const summary = page.getByRole('region', { name: '선택 층 조명 현황', exact: true });
    await expect(summary.getByText('전체 조명', { exact: true }).locator('..')).toContainText('24');
    await expect(summary.getByText('점검 필요', { exact: true }).locator('..')).toContainText('0');
    await expect(page.locator('[data-spatial-map-marker]')).toHaveCount(2);
    await expect(page.locator('html')).toHaveAttribute('data-customer-theme', theme);
    await expect(page.locator('[data-operation-map-chrome]')).toContainText('B2 · 조명 현황');
    const timestamp = page.locator('[aria-label="모니터링 도구"] time');
    await expect(timestamp).toHaveAttribute('datetime', instant);
    await expect(timestamp).toContainText('2026-10-02 00:00:00');
    const viewport = page.getByTestId('monitoring-map-viewport');
    await viewport.scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '지도 확대', exact: true }).click();
    const pin = page.getByRole('button', { name: 'Task9 조명 1 정상 70%', exact: true });
    await pin.click();
    await expect(page.getByRole('dialog', { name: 'Task9 조명 1 조명 정보', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const node = await viewport.elementHandle();
    const initialZoom = await viewport.getAttribute('data-zoom');
    await page.getByRole('button', { name: theme === 'light' ? '다크 모드로 변경' : '라이트 모드로 변경' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-customer-theme', theme === 'light' ? 'dark' : 'light');
    await expect(pin).toHaveAttribute('aria-current', 'true');
    await expect(viewport).toHaveAttribute('data-zoom', initialZoom!);
    expect(await node!.evaluate(element => element.isConnected)).toBe(true);
    await page.getByRole('button', { name: '지도 전체 보기', exact: true }).click();
    await expect(page.locator('[data-shell-topbar]')).toBeHidden();
    await page.getByRole('button', { name: '전체 보기 종료', exact: true }).click();
    await expect(viewport).toHaveAttribute('data-zoom', initialZoom!);
    await expect(pin).toHaveAttribute('aria-current', 'true');
    expect(state.api.dimmingRequests).toHaveLength(0);
    await expectNoHorizontalOverflow(page);
    await info.attach(`atlas-monitoring-${theme}-${size.width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });
}

for (const size of [{ width: 1706, height: 1226 }, { width: 390, height: 844 }, { width: 390, height: 480 }]) {
  test(`monitoring unified search popover ${size.width}x${size.height}`, async ({ page }, info) => {
    await page.setViewportSize(size);
    const state = await install(page);
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    const trigger = page.getByRole('button', { name: '조명 검색·상세', exact: true });
    const map = page.getByRole('button', { name: '맵 선택', exact: true });
    await expect(map).toContainText('B2');
    const mapBox = (await map.boundingBox())!, triggerBox = (await trigger.boundingBox())!;
    expect(triggerBox.x).toBeGreaterThanOrEqual(mapBox.x + mapBox.width);
    expect(Math.abs(triggerBox.y - mapBox.y)).toBeLessThan(4);
    await expect(page.getByRole('button', { name: /맵 조명 상태 필터 상세 필터/ })).toHaveCount(0);
    await expect(page.getByText(/표시 상태:/)).toHaveCount(0);
    await trigger.click();
    const finder = page.getByRole('dialog', { name: '조명 검색·상세', exact: true });
    await expect(finder.locator('xpath=ancestor::*[@data-placement]')).toHaveCount(1);
    await expect(finder.getByRole('button', { name: '상세 보기', exact: true })).toHaveCount(0);
    await finder.getByRole('button', { name: '상태 필터', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(finder).toBeVisible();
    await expect(finder.getByRole('button', { name: '상태 필터', exact: true })).toBeFocused();
    await finder.getByRole('button', { name: '상태 필터', exact: true }).click();
    await page.getByRole('option', { name: '오프라인', exact: true }).click();
    await expect(finder).toContainText('오프라인 조명이 없습니다.');
    await expect(finder.getByRole('button', { name: '상세 조명 선택', exact: true })).toHaveCount(0);
    const search = finder.getByRole('searchbox', { name: '조명 이름 또는 번호 검색' });
    await search.fill('Task9 조명 1');
    await page.keyboard.press('Escape');
    await expect(finder).toHaveCount(0); await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(search).toHaveValue('Task9 조명 1');
    await finder.getByRole('button', { name: '필터 초기화', exact: true }).click();
    await expect(search).toHaveValue('Task9 조명 1');
    await expect(finder.getByRole('button', { name: '상태 필터', exact: true })).toContainText('전체');
    await finder.getByRole('button', { name: '상세 조명 선택', exact: true }).click();
    await page.getByRole('option', { name: 'Task9 조명 1 · 정상', exact: true }).click();
    const detailAction = finder.getByRole('button', { name: '상세 보기', exact: true });
    await assert44px(detailAction); await nativeTabTo(page, detailAction);
    await attach(info, 'popover-scroll-end', await detailAction.evaluate(node => {
      const popover = node.closest('[data-placement]')!;
      return { scrollTop: popover.scrollTop, clientHeight: popover.clientHeight, scrollHeight: popover.scrollHeight, action: node.getBoundingClientRect().toJSON(), popover: popover.getBoundingClientRect().toJSON() };
    }));
    const openScreenshot = info.outputPath('unified-popover-open.png');
    await page.screenshot({ path: openScreenshot });
    await info.attach('unified-popover-open', { path: openScreenshot, contentType: 'image/png' });
    await page.keyboard.press('Enter');
    const detail = page.getByRole(size.width >= 1024 ? 'complementary' : 'dialog', { name: '조명 상세', exact: true }); await expect(detail).toContainText('Task9 조명 1');
    await detail.getByRole('button', { name: '조명 상세 닫기', exact: true }).click();
    await trigger.click(); await expect(finder).toBeVisible();
    // Short viewports flip the popover over the header. Use a real viewport
    // corner outside the popover, not a header point that may now be inside it.
    const popupBox = (await finder.locator('xpath=ancestor::*[@data-placement]').boundingBox())!;
    expect(popupBox.x).toBeGreaterThan(1);
    await page.mouse.click(1, 1);
    await expect(finder).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const header = page.getByRole('region', { name: '현장 전체', exact: true });
    await expect(header).toBeVisible();
    const aggregateDisclosure = header.getByRole('button', { name: '현장 전체 보기', exact: true });
    if (await aggregateDisclosure.count()) await aggregateDisclosure.click();
    await expectHeaderReadingSemantics(header, '고객사 B2 현장');
    const bounds = await header.evaluate(node => {
      const parent = node.getBoundingClientRect();
      // Task4 compact h2/site-name are screen-reader-only, not painted glyphs.
      return [...node.querySelectorAll('dt,dd,h2')].filter(element => !element.closest('.sr-only')).map(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const text = range.getBoundingClientRect(), style = getComputedStyle(element);
        return { text: element.textContent, rect: text.toJSON(), element: element.getBoundingClientRect().toJSON(), parent: parent.toJSON(), lineHeight: style.lineHeight, fontSize: style.fontSize };
      });
    });
    expect(bounds.filter(item => item.text === '전체')).toHaveLength(1);
    expect(bounds.filter(item => item.text?.endsWith('대'))).toHaveLength(4);
    for (const item of bounds) {
      expect(item.rect.top).toBeGreaterThanOrEqual(item.parent.top);
      expect(item.rect.bottom).toBeLessThanOrEqual(item.parent.bottom);
      expect(item.rect.left).toBeGreaterThanOrEqual(item.parent.left);
      expect(item.rect.right).toBeLessThanOrEqual(item.parent.right);
      // Semantic heading/body tokens use different ratios. Verify real text
      // fits its own line box instead of requiring a blanket line-height ratio.
      expect(item.rect.top).toBeGreaterThanOrEqual(item.element.top);
      expect(item.rect.bottom).toBeLessThanOrEqual(item.element.bottom);
      expect(item.rect.height).toBeLessThanOrEqual(parseFloat(item.lineHeight));
    }
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    expect(state.api.dimmingRequests).toHaveLength(0);
    await attach(info, 'unified-popover-header-bounds', { mapBox, triggerBox, bounds });
    const screenScreenshot = info.outputPath('unified-popover-screen.png');
    await page.screenshot({ path: screenScreenshot, fullPage: true });
    await info.attach('unified-popover-screen', { path: screenScreenshot, contentType: 'image/png' });
  });
}

for (const size of [{ width: 1706, height: 1226 }, { width: 390, height: 844 }]) {
  test(`monitoring header CSS 200 percent glyph bounds ${size.width}x${size.height}`, async ({ page }, info) => {
    await page.setViewportSize(size); await install(page);
    await page.route('**/api/sites', route => route.fulfill({ json: [{ id: ids.siteId, name: '동측 지하주차장 B1·B2 통합 조명 운영 현장', customerName: '고객사' }] }));
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    const header = page.getByRole('region', { name: '현장 전체', exact: true });
    await expect(header).toBeVisible();
    const aggregateDisclosure = header.getByRole('button', { name: '현장 전체 보기', exact: true });
    if (await aggregateDisclosure.count()) await aggregateDisclosure.click();
    await expectHeaderReadingSemantics(header, '동측 지하주차장 B1·B2 통합 조명 운영 현장');
    await expect(header.getByText('2대').first()).toBeVisible();
    await page.evaluate(() => { document.body.style.zoom = '2'; });
    await paints(page);
    const bounds = await header.evaluate(node => {
      const parent = node.getBoundingClientRect();
      return [...node.querySelectorAll('h2,p,dt,dd')].filter(element => !element.closest('.sr-only')).map(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        return { text: element.textContent, rects: [...range.getClientRects()].map(rect => rect.toJSON()), parent: parent.toJSON() };
      });
    });
    expect(bounds.filter(item => item.text === '전체')).toHaveLength(1);
    expect(bounds.filter(item => item.text?.endsWith('대'))).toHaveLength(4);
    for (const item of bounds) for (const rect of item.rects) {
      expect(rect.top).toBeGreaterThanOrEqual(item.parent.top);
      expect(rect.bottom).toBeLessThanOrEqual(item.parent.bottom);
      expect(rect.left).toBeGreaterThanOrEqual(item.parent.left);
      expect(rect.right).toBeLessThanOrEqual(item.parent.right);
    }
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await attach(info, 'CSS-zoom-header-bounds', bounds);
    const screenshot = info.outputPath('CSS-zoom-header.png');
    await page.screenshot({ path: screenshot });
    await info.attach('CSS-zoom-header', { path: screenshot, contentType: 'image/png' });
  });
}
async function expectHeaderReadingSemantics(header: Locator, fullSiteName: string) {
  await expect(header.getByRole('heading', { name: '현장 전체', exact: true })).toHaveCount(1);
  await expect(header.locator('p.sr-only')).toHaveText(fullSiteName);
  await expect(header.locator('dt')).toHaveText(['전체', '온라인', '장애', '오프라인']);
  await expect(header.locator('dd')).toHaveCount(4);
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

async function swipe(cdp: CDPSession, page: Page, x: number, fromY: number, toY: number) {
  const point = (y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(fromY)] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(fromY + (toY - fromY) * step / 8)] });
    await paints(page);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await paints(page);
}

async function assert44px(target: Locator) {
  await target.scrollIntoViewIfNeeded(); const box = (await target.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  expect((await hit(target)).reachable).toBe(true);
}

async function mapBounds(page: Page) {
  return page.evaluate(() => {
    const selectors = { shell: '[data-app-shell]', header: '[data-shell-topbar]', monitoring: '[data-monitoring-screen]', frame: '[data-monitoring-map-panel]', map: '[data-monitoring-map-shell]', viewport: '[data-testid="monitoring-map-viewport"]', surface: '[data-floor-map-surface]', footer: '[aria-label="지도 조작"]', legend: '[aria-label="조명 상태 범례"]', log: '[data-monitoring-log-ticker]', nav: '[data-shell-navigation="compact"]' };
    const surface = document.querySelector('[data-floor-map-surface]')?.getBoundingClientRect(), viewport = document.querySelector('[data-testid="monitoring-map-viewport"]')?.getBoundingClientRect();
    const meaningfulSurface = surface && viewport ? {
      width: Math.max(0, Math.min(surface.right, viewport.right, innerWidth) - Math.max(surface.left, viewport.left, 0)),
      height: Math.max(0, Math.min(surface.bottom, viewport.bottom, innerHeight) - Math.max(surface.top, viewport.top, 0)),
      viewportHeight: Math.max(0, Math.min(surface.bottom, viewport.bottom) - Math.max(surface.top, viewport.top))
    } : null;
    return { pageY: scrollY, height: innerHeight, width: innerWidth, meaningfulSurface, document: { clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight, horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }, nodes: Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
      const node = document.querySelector<HTMLElement>(selector);
      return [key, node ? { rect: node.getBoundingClientRect().toJSON(), clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, overflowY: getComputedStyle(node).overflowY } : null];
    })) };
  });
}

async function liveNoticeGeometry(notice: Locator, control?: Locator) {
  // Capture live notice count, geometric overlap and the actual hit in one
  // browser task so expiry between independent measurements cannot fake PASS.
  return (control ?? notice).evaluate((node, isControl) => {
    const region = document.querySelector('[aria-label="알림"]')!, footer = document.querySelector('[aria-label="지도 조작"]')!;
    const band = region.getBoundingClientRect(), f = footer.getBoundingClientRect(), c = node.getBoundingClientRect();
    const articles = [...region.querySelectorAll('article')].map(article => {
      const r = article.getBoundingClientRect();
      return { text: article.textContent, rect: r.toJSON(), visibleViewportHeight: Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)),
        display: getComputedStyle(article).display, visibility: getComputedStyle(article).visibility,
        overlapArea: Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left)) * Math.max(0, Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)) };
    });
    const left = Math.max(0, c.left), right = Math.min(innerWidth, c.right), top = Math.max(0, c.top), bottom = Math.min(innerHeight, c.bottom);
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 }, target = document.elementFromPoint(point.x, point.y);
    return { capturedAt: Date.now(), count: articles.length, band: band.toJSON(), footer: f.toJSON(), position: getComputedStyle(region).position, articles,
      overlapArea: Math.max(0, Math.min(band.right, f.right) - Math.max(band.left, f.left)) * Math.max(0, Math.min(band.bottom, f.bottom) - Math.max(band.top, f.top)),
      hit: isControl ? { point, reachable: right > left && bottom > top && (node === target || node.contains(target)), target: target?.outerHTML.slice(0, 250), rect: c.toJSON() } : null,
      pageY: scrollY, documentHeight: document.documentElement.scrollHeight };
  }, Boolean(control));
}

test('task5 live toast never covers map footer at 390x320 without dismissal', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 320 }); const state = await install(page);
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  const notice = page.getByRole('region', { name: '알림', exact: true }), toast = notice.locator('article');
  await expect(toast).toHaveCount(1);
  const observedAt = Date.now();
  const observation = async (step: string, control?: Locator) => ({ step, geometry: await liveNoticeGeometry(notice, control), bounds: await mapBounds(page) });
  const initial = await observation('initial-live-toast'); expect(initial.geometry.count).toBe(1); expect(initial.geometry.articles[0].visibleViewportHeight).toBeGreaterThan(0);
  const records: unknown[] = [initial];
  const controls = page.getByRole('group', { name: '지도 조작', exact: true });
  try {
    await page.mouse.move(2, 180); await page.mouse.wheel(0, 1600); await paints(page);
    for (const name of ['지도 축소', '지도 확대', '지도 전체 보기']) {
      const control = controls.getByRole('button', { name, exact: true }); await control.scrollIntoViewIfNeeded();
      const record = await observation(name, control); records.push(record);
      expect(record.geometry.count).toBe(1); expect(record.geometry.hit!.reachable).toBe(true);
      expect(record.geometry.articles.map(article => article.overlapArea)).toEqual([0]);
      expect(record.geometry.capturedAt - observedAt).toBeLessThan(5000);
    }
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    expect(state.api.dimmingRequests).toHaveLength(0);
  } finally { await attach(info, 'live-toast-footer', records); await info.attach('live-toast-footer-screen', { body: await page.screenshot(), contentType: 'image/png' }); }
});

test('task5 long multiple live notices preserve natural scroll fullview camera and footer hits', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 320 }); const state = await install(page);
  const plan = { imageUrl: '/demo/floor-b2.svg', sourceType: 'image', originalFileUrl: '/demo/floor-b2.svg', renderedImageUrl: '/demo/floor-b2.svg', width: 1200, height: 800, version: 1 };
  await page.route('**/api/**/dashboard*', route => route.fulfill({ json: {
    generatedAt: instant, monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 }, capabilities: { read: true, control: true, manage: true, commission: true },
    site: { id: ids.siteId, name: 'Task5 알림 현장', customerName: '고객사', installationStatus: 'installed', address: null, tariffKwhRate: 160, timeZone: 'Asia/Seoul' },
    summary: { totalFixtures: 2, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 2, averageBrightness: 70 },
    floors: [{ id: ids.floorId, name: 'B2', level: -2, summary: { totalFixtures: 2, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 2 }, mapRevision: 0, mapConfigured: true, floorPlan: plan, meshControlGroups: [], fixtures: [] }], groups: [],
    gateways: [{ id: ids.gatewayId, name: 'Task5 Gateway', serialNumber: 'GW-MOCK', firmwareVersion: 'mock', lastHeartbeatAt: instant, connectionStatus: 'offline' }]
  } }));
  await page.route('**/api/**/fixtures?**', route => route.fulfill({ json: { generatedAt: new Date(Date.now() + 120_000).toISOString(), nextCursor: null,
    items: state.fixtures.map(fixture => ({ ...fixture, status: 'offline', statusReason: 'gateway_offline', gateway: { ...fixture.gateway, connectionStatus: 'offline' }, controllable: false, controlBlockReason: 'gateway_offline' })) } }));
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  const notice = page.getByRole('region', { name: '알림', exact: true }), articles = notice.locator('article'), viewport = page.getByTestId('monitoring-map-viewport');
  await expect(articles).toHaveCount(2); await expect(notice).toContainText('시간 차이 확인');
  const records: unknown[] = [], observedAt = Date.now();
  async function record(step: string, control?: Locator) {
    await expect(articles).toHaveCount(2);
    const evidence = await liveNoticeGeometry(notice, control);
    expect(evidence.count).toBe(2); expect(evidence.capturedAt - observedAt).toBeLessThan(5000);
    expect(evidence.position).toBe('static'); expect(evidence.overlapArea).toBe(0);
    expect(evidence.articles.every(article => article.display !== 'none' && article.visibility === 'visible')).toBe(true);
    expect(evidence.band.height).toBeGreaterThanOrEqual(evidence.articles.reduce((sum, article) => sum + article.rect.height, 0));
    if (evidence.hit) expect(evidence.hit.reachable).toBe(true);
    expect((await viewport.boundingBox())!.height).toBeGreaterThanOrEqual(240);
    records.push({ step, evidence, camera: await camera(viewport) });
  }
  try {
    await notice.scrollIntoViewIfNeeded(); await paints(page); await record('notice-reading');
    await page.mouse.move(2, 180); await page.mouse.wheel(0, 1800); await paints(page);
    const zoom = page.getByRole('button', { name: '지도 확대', exact: true }); await zoom.scrollIntoViewIfNeeded(); await record('normal-footer', zoom); await zoom.click(); await paints(page);
    const userCamera = await camera(viewport);
    await page.getByRole('button', { name: '지도 전체 보기', exact: true }).click(); await paints(page);
    const exit = page.getByRole('button', { name: '전체 보기 종료', exact: true }); await exit.scrollIntoViewIfNeeded(); await record('fullview-footer', exit);
    await exit.click(); await paints(page);
    const restored = await camera(viewport); expect(restored.zoom).toBe(userCamera.zoom); expect(Math.abs(restored.x - userCamera.x)).toBeLessThan(.02); expect(Math.abs(restored.y - userCamera.y)).toBeLessThan(.02);
    expect(Date.now() - observedAt).toBeLessThan(5000); await expect(articles).toHaveCount(2);
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0); expect(state.api.dimmingRequests).toHaveLength(0);
  } finally { await attach(info, 'multiple-live-notice-fullview', records); await info.attach('multiple-live-notice-screen', { body: await page.screenshot(), contentType: 'image/png' }); }
});

test('task5 map reset preserves typed search and camera without automatic selection or controls', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 720 }); const state = await install(page); await page.goto(`/monitoring?siteId=${ids.siteId}`);
  const viewport = page.getByTestId('monitoring-map-viewport'); await page.getByRole('button', { name: '지도 확대', exact: true }).click(); const before = await camera(viewport);
  await page.getByRole('button', { name: '조명 검색·상세', exact: true }).click();
  await page.getByRole('button', { name: '상태 필터', exact: true }).click(); await page.getByRole('option', { name: '점검 필요', exact: true }).click();
  const finder = page.getByRole('dialog', { name: '조명 검색·상세', exact: true }), search = finder.getByRole('searchbox', { name: '조명 이름 또는 번호 검색' });
  await search.fill('Task9 조명 1'); await finder.getByRole('button', { name: '조명 검색·상세 닫기', exact: true }).click();
  await page.getByRole('button', { name: '조명 검색·상세', exact: true }).click(); await expect(search).toHaveValue('Task9 조명 1');
  await finder.getByRole('button', { name: '필터 초기화', exact: true }).click(); await expect(search).toHaveValue('Task9 조명 1');
  await expect(finder.getByRole('button', { name: '상태 필터', exact: true })).toContainText('전체');
  await expect(finder.locator('[aria-label="선택 조명 상세"]')).toHaveCount(0);
  await finder.getByRole('button', { name: '조명 검색·상세 닫기', exact: true }).click();
  await expect(page.getByText(/표시 상태:/)).toHaveCount(0);
  const after = await camera(viewport); expect(after.zoom).toBe(before.zoom); expect(Math.abs(after.x - before.x)).toBeLessThan(.02); expect(Math.abs(after.y - before.y)).toBeLessThan(.02);
  await expect(page.locator('[data-spatial-map-marker][data-selected="true"]')).toHaveCount(0); expect(state.api.dimmingRequests).toHaveLength(0);
  await attach(info, 'search-reset-camera', { before, after, search: 'Task9 조명 1', reads: state.reads });
});

for (const size of [{width:1287,height:1226},{width:390,height:320},{width:1440,height:600}]) {
  test(`task5 original map bounds ${size.width}x${size.height}`, async ({page}, info) => {
    await page.setViewportSize(size); const state = await install(page);
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    await expect(page.getByTestId('monitoring-map-viewport')).toBeVisible();
    await expect(page.getByRole('region',{name:'선택 층 조명 현황',exact:true}).getByText('전체 조명',{exact:true}).locator('..')).toContainText('2');
    await page.evaluate(() => document.fonts.ready); await paints(page);
    await attach(info, 'original-map-bounds', await mapBounds(page));
    await page.screenshot({path:info.outputPath('original-map.png'),fullPage:true});
    await page.getByRole('button',{name:'지도 확대',exact:true}).click(); await paints(page);
    await attach(info,'zoomed-map-bounds',await mapBounds(page));
    await page.screenshot({path:info.outputPath('zoomed-map.png'),fullPage:true});
    expect(state.api.dimmingRequests).toHaveLength(0);
  });
}

for (const size of [{width:1287,height:1226},{width:390,height:320},{width:1440,height:600}]) {
  test(`task5 map footer remains reachable without resetting camera after header relocation ${size.width}x${size.height}`, async ({page}, info) => {
    await page.setViewportSize(size); const state = await install(page);
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    const viewport = page.getByTestId('monitoring-map-viewport');
    await expect(page.getByRole('region',{name:'선택 층 조명 현황',exact:true}).getByText('전체 조명',{exact:true}).locator('..')).toContainText('2');
    await page.evaluate(() => document.fonts.ready); await paints(page);
    expect(await page.locator('[data-monitoring-screen] [data-monitoring-site-summary]').count()).toBe(0);
    await expect(page.getByText('B2 · 조명 현황',{exact:true})).toBeVisible();
    await expect(page.locator('[data-shell-topbar]')).toContainText('현장 전체');
    await expect(page.locator('[aria-label="조명 상세"]')).toHaveCount(0);
    const observations: unknown[] = [{step:'initial',bounds:await mapBounds(page)}];
    const containChrome = async () => {
      const bounds = await mapBounds(page), nodes = bounds.nodes;
      expect(nodes.viewport!.rect.height).toBeGreaterThanOrEqual(240);
      expect(nodes.viewport!.rect.bottom).toBeLessThanOrEqual(nodes.footer!.rect.top);
      expect(nodes.footer!.rect.bottom).toBeLessThanOrEqual(nodes.legend!.rect.top);
      expect(nodes.legend!.rect.bottom).toBeLessThanOrEqual(nodes.map!.rect.bottom);
      expect(nodes.map!.rect.bottom).toBeLessThanOrEqual(nodes.log!.rect.top);
      expect(nodes.log!.rect.bottom).toBeLessThanOrEqual(nodes.frame!.rect.bottom);
      expect(bounds.meaningfulSurface!.viewportHeight).toBeGreaterThanOrEqual(190);
    };
    await containChrome();
    // Live notices reserve normal-flow height; footer access needs no dismiss.
    await viewport.scrollIntoViewIfNeeded();
    const wheelHit = await hit(viewport); expect(wheelHit.reachable).toBe(true);
    await page.mouse.move(wheelHit.point.x,wheelHit.point.y); await page.mouse.wheel(0,-80);
    await expect(viewport).toHaveAttribute('data-zoom','1.1'); await paints(page);
    const userCamera = await camera(viewport);
    for (const width of [1023,1024,size.width]) {
      await page.setViewportSize({width,height:size.height}); await paints(page);
      const current = await camera(viewport);
      await attach(info, `camera-resize-${width}`, { userCamera, current, bounds: await mapBounds(page) });
      expect(current.zoom).toBe(userCamera.zoom);
      expect(Math.abs(current.x-userCamera.x)).toBeLessThan(.02); expect(Math.abs(current.y-userCamera.y)).toBeLessThan(.02);
      observations.push({step:`resize-${width}`,camera:current,bounds:await mapBounds(page)});
      await containChrome();
    }
    // Ordinary wheel in the content gutter scrolls the document, not the map.
    const gutter = await page.locator('[data-shell-content]').evaluate(node => ({x:node.getBoundingClientRect().left+2,y:innerHeight/2}));
    await page.mouse.move(gutter.x,gutter.y); await page.mouse.wheel(0,1600); await paints(page);
    const controls = page.getByRole('group',{name:'지도 조작',exact:true});
    const legend = page.getByRole('list',{name:'조명 상태 범례'});
    for (const name of ['지도 축소','지도 확대','지도 전체 보기']) {
      const control = controls.getByRole('button',{name,exact:true}); await control.scrollIntoViewIfNeeded();
      const point = await hit(control); expect(point.reachable).toBe(true);
      const box=(await control.boundingBox())!; expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await legend.scrollIntoViewIfNeeded();
    // The legend is deliberately pointer-events:none: verify the complete
    // reading bounds and the underlying map owner rather than a clickable hit.
    expect(await legend.evaluate(node => {
      const r = node.getBoundingClientRect(), owner = node.closest('[data-monitoring-map-shell]')!;
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.top >= 0 && r.bottom <= innerHeight && Boolean(at && owner.contains(at));
    })).toBe(true);
    expect((await camera(viewport)).zoom).toBe(userCamera.zoom);
    await controls.getByRole('button',{name:'지도 전체 보기',exact:true}).click(); await paints(page);
    await expect(page.getByRole('button',{name:'전체 보기 종료',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'전체 보기 종료',exact:true}).click(); await paints(page);
    const restored=await camera(viewport); expect(restored.zoom).toBe(userCamera.zoom);
    expect(Math.abs(restored.x-userCamera.x)).toBeLessThan(.02); expect(Math.abs(restored.y-userCamera.y)).toBeLessThan(.02);
    observations.push({step:'fullview-roundtrip',camera:restored,bounds:await mapBounds(page)});
    expect(await page.locator('html').evaluate(node=>node.scrollWidth-node.clientWidth)).toBe(0);
    expect(state.api.dimmingRequests).toHaveLength(0);
    await attach(info,'task5-map-access',observations); await page.screenshot({path:info.outputPath('map-access.png'),fullPage:true});
  });
}

test('task5 log filter close preserves partial dates and scoped cursor without a request', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 320 }); const state = await install(page);
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  await page.getByRole('region', { name: '최근 운영 로그', exact: true }).getByRole('button', { name: '전체 보기', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '전체 로그', exact: true });
  await expect(drawer.getByRole('listitem')).toHaveCount(50);
  await drawer.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(drawer.getByText('2페이지', { exact: true })).toBeVisible();
  const trigger = drawer.getByRole('button', { name: /운영 로그 필터 상세 필터/ });
  await trigger.click();
  const filter = page.getByRole('dialog', { name: '운영 로그 필터', exact: true });
  const year = filter.getByRole('spinbutton').first();
  await year.click(); await page.keyboard.press('ArrowUp');
  const rawYear = await year.getAttribute('aria-valuenow'); expect(rawYear).not.toBeNull();
  const readCount = state.reads.length;
  await paints(page); await expect(filter).toBeVisible(); await expect(year).toBeFocused();
  // RAC's iOS announcement workaround refocuses after 500ms. Observe beyond
  // that library boundary so a transiently correct child focus cannot pass.
  await page.waitForTimeout(550); await expect(year).toBeFocused();
  await filter.getByRole('button', { name: '필터 닫기', exact: true }).click();
  await expect(trigger).toBeFocused(); await trigger.click();
  await expect(filter.getByRole('spinbutton').first()).toHaveAttribute('aria-valuenow', rawYear!);
  expect(await filter.getByRole('spinbutton').nth(1).getAttribute('aria-valuenow')).toBeNull();
  expect(state.reads).toHaveLength(readCount);
  await filter.getByRole('button', { name: '필터 닫기', exact: true }).click();
  await expect(drawer.getByText('2페이지', { exact: true })).toBeVisible();
  await attach(info, 'partial-date-cursor', { rawYear, reads: state.reads });
  expect(state.api.dimmingRequests).toHaveLength(0);
});

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
      const rect = node.getBoundingClientRect(), detail = document.querySelector('[data-monitoring-detail-scroll]')!.getBoundingClientRect();
      // The finite flex allocation may end above its naturally overflowing
      // children. Sample the visible detail's adjacent document gutter, not
      // the allocation bottom (which can now coincide with the sticky header).
      const point = { x: rect.left + 2, y: (Math.max(0, detail.top) + Math.min(innerHeight, detail.bottom)) / 2 }, target = document.elementFromPoint(point.x, point.y);
      const documentBackground = target === document.documentElement || target === document.body || Boolean(target && node.contains(target));
      const excluded = '[data-monitoring-layout],[data-monitoring-detail-scroll],[data-floor-map-surface],[data-testid="monitoring-map-viewport"],[role="dialog"],[role="alertdialog"],button,[role="button"],a,input,select,textarea,label,form,nav,header,[contenteditable]:not([contenteditable="false"])';
      return { point, rect: rect.toJSON(), pageTarget: documentBackground && Boolean(target && !target.closest(excluded)), target: target?.outerHTML.slice(0, 160), before: scrollY,
        detail: detail.toJSON(), main: node.closest('main')!.getBoundingClientRect().toJSON() };
    });
    observations.push({ step: 'page-gutter-target-before-input', gutter });
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
    for (const control of ['전체 로그 닫기', '운영 로그 필터 상세 필터, 활성 조건 0개', '이전 페이지', '다음 페이지']) {
      const target = dialog.getByRole('button', { name: control, exact: true }), rect = (await target.boundingBox())!;
      expect(rect.height).toBeGreaterThanOrEqual(44); expect(rect.width).toBeGreaterThanOrEqual(44);
      expect((await hit(target, dialog)).reachable).toBe(true);
    }
    const list = dialog.getByRole('region', { name: '운영 로그 본문', exact: true });
    for (const size of [50, 100, 500, 1000]) {
      if (size !== 50) {
        await dialog.getByRole('button', { name: /운영 로그 필터 상세 필터/ }).click();
        await page.getByRole('button', { name: '페이지당 항목 수' }).click();
        await page.getByRole('option', { name: `${size}개`, exact: true }).click();
        await page.getByRole('button', { name: '필터 닫기', exact: true }).click();
      }
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
    await filters.getByRole('button', { name: /운영 로그 필터 상세 필터/ }).click();
    const filterDialog = page.getByRole('dialog', { name: '운영 로그 필터', exact: true });
    const dates = filterDialog.getByRole('spinbutton'); await expect(dates).toHaveCount(6);
    for (const offset of [0, 3]) for (const [index, text] of [[2, '25'], [1, '9'], [0, '2026']] as const) {
      const segment = dates.nth(offset + index);
      await nativeTabTo(page, segment);
      const segmentHit = await hit(segment, filterDialog); expect(segmentHit.reachable).toBe(true);
      records.push({ step: 'native-date-input', offset, index, segmentHit });
      // Numeric segments advance as soon as their value is complete. Insert
      // the selected segment's entire value (native paste/IME input), rather
      // than letting the remaining digits type into the next segment.
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text);
    }
    await page.keyboard.press('Tab'); await expect.poll(() => state.reads.some(r => r.fromDate === '2026-09-25' && r.toDate === '2026-09-25' && r.limit === '1000')).toBe(true);
    const periodReset = filterDialog.getByRole('button', { name: '필터 초기화', exact: true });
    await nativeTabTo(page, periodReset); expect((await hit(periodReset, filterDialog)).reachable).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => state.reads.at(-1)?.fromDate).toBeUndefined();
    await page.getByRole('button', { name: '필터 닫기', exact: true }).click();
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

test('task5 invalid date input makes no request and cursor400 recovers only the visited page', async ({ page }, info) => {
  const state = await install(page); let failCursor = false;
  await page.route('**/api/**/monitoring-activity?**', route => {
    const params = new URL(route.request().url()).searchParams;
    if (failCursor && params.get('cursor')) return route.fulfill({ status: 400, json: { message: 'Invalid scoped cursor' } });
    return route.fallback();
  });
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  await page.getByRole('region', { name: '최근 운영 로그', exact: true }).getByRole('button', { name: '전체 보기', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '전체 로그', exact: true });
  await expect(drawer.getByRole('listitem')).toHaveCount(50);
  await drawer.getByRole('button', { name: /운영 로그 필터 상세 필터/ }).click();
  const filter = page.getByRole('dialog', { name: '운영 로그 필터', exact: true }), dates = filter.getByRole('spinbutton');
  const before = state.reads.length;
  // Complete both valid individual dates in reverse order. A paired period
  // remains invalid and must never reach the existing GET contract.
  for (const [offset, day] of [[0, '25'], [3, '24']] as const) for (const [index, value] of [[2, day], [1, '9'], [0, '2026']] as const) {
    await dates.nth(offset + index).click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(value);
  }
  await page.keyboard.press('Tab'); await paints(page);
  await expect(filter).toContainText('날짜 순서를 확인하세요.');
  expect(state.reads).toHaveLength(before);
  await filter.getByRole('button', { name: '필터 닫기', exact: true }).click();
  await expect(drawer.getByRole('listitem')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '다음 페이지', exact: true })).toBeDisabled();
  await drawer.getByRole('button', { name: /운영 로그 필터 상세 필터/ }).click();
  await filter.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await filter.getByRole('button', { name: '필터 닫기', exact: true }).click();
  await expect(drawer.getByRole('listitem')).toHaveCount(50);
  failCursor = true;
  await drawer.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(drawer.getByText('1페이지', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('listitem')).toHaveCount(50);
  await attach(info, 'invalid-period-and-cursor400', { before, reads: state.reads });
  expect(state.api.dimmingRequests).toHaveLength(0);
});

test('task5 late prior floor log response never replaces the current floor', async ({ page }, info) => {
  const state = await install(page), otherFloor = id(4);
  const plan = { imageUrl: '/demo/floor-b2.svg', sourceType: 'image', originalFileUrl: '/demo/floor-b2.svg', renderedImageUrl: '/demo/floor-b2.svg', width: 1200, height: 800, version: 1 };
  await page.route('**/api/**/dashboard*', route => route.fulfill({ json: {
    generatedAt: instant, monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
    capabilities: { read: true, control: true, manage: true, commission: true },
    site: { id: ids.siteId, name: 'Task5 두 맵 현장', customerName: '고객사', installationStatus: 'installed', address: '서울', tariffKwhRate: 160, timeZone: 'Asia/Seoul' },
    summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, offlineFixtures: 0, averageBrightness: 70 },
    floors: [{ id: ids.floorId, name: 'B2', level: -2, summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, offlineFixtures: 0 } },
      { id: otherFloor, name: 'B3', level: -3, summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 0 } }]
      .map(floor => ({ ...floor, mapRevision: 0, mapConfigured: true, floorPlan: plan, meshControlGroups: [], fixtures: [] })), groups: [], gateways: []
  } }));
  let release!: () => void, entered = false, lateOutcome = '';
  const deferred = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith(`/${otherFloor}/fixtures`)) return route.fulfill({ json: { generatedAt: instant, items: [], nextCursor: null } });
    if (url.pathname.endsWith(`/${otherFloor}/map-snapshot`)) return route.fulfill({ json: { floorId: otherFloor, revision: 0, width: 1200, height: 800, floorPlan: plan, objects: [] } });
    if (!url.pathname.endsWith('/monitoring-activity') || url.searchParams.get('limit') !== '50') return route.fallback();
    const prior = url.pathname.includes(`/${ids.floorId}/`);
    if (prior) { entered = true; await deferred; }
    try {
      await route.fulfill({ json: { generatedAt: instant, retainedFrom: '2026-07-01T15:00:00Z', items: [{ id: id(prior ? 30001 : 30002), kind: 'fixture_online', recordedAt: instant, displayName: prior ? '늦은 B2 기록' : '현재 B3 기록' }], nextCursor: null } });
      if (prior) lateOutcome = 'fulfilled';
    } catch (error) { if (!prior) throw error; lateOutcome = `cancelled: ${String(error)}`; }
  });
  try {
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    const open = page.getByRole('region', { name: '최근 운영 로그', exact: true }).getByRole('button', { name: '전체 보기', exact: true });
    await open.click(); await expect.poll(() => entered).toBe(true);
    await page.getByRole('button', { name: '전체 로그 닫기', exact: true }).click();
    await page.getByRole('button', { name: '맵 선택', exact: true }).click();
    await page.getByRole('option', { name: 'B3', exact: true }).click();
    await expect(page.getByText('B3 · 조명 현황', { exact: true })).toBeVisible();
    await open.click(); const drawer = page.getByRole('dialog', { name: '전체 로그', exact: true });
    await expect(drawer).toContainText('현재 B3 기록'); release();
    await expect.poll(() => lateOutcome).not.toBe(''); await paints(page);
    await expect(drawer).toContainText('현재 B3 기록'); await expect(drawer).not.toContainText('늦은 B2 기록');
    await expect(drawer.getByText('1페이지', { exact: true })).toBeVisible();
    expect(state.api.dimmingRequests).toHaveLength(0);
  } finally { release(); await attach(info, 'late-floor-scope', { entered, lateOutcome, requests: state.api.requests }); }
});

for (const width of [320, 390, 768, 1023, 1024, 1287, 1440]) {
  test(`task5 map filter and visible search preserve context at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 }); const state = await install(page);
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    const trigger = page.getByRole('button', { name: '조명 검색·상세', exact: true });
    await assert44px(trigger); await trigger.click();
    const finder = page.getByRole('dialog', { name: '조명 검색·상세', exact: true });
    await assert44px(finder.getByRole('button', { name: '상태 필터', exact: true }));
    await finder.getByRole('button', { name: '상태 필터', exact: true }).click();
    for (const name of ['전체', '정상', '점검 필요', '오프라인', '미배치']) await assert44px(page.getByRole('option', { name, exact: true }));
    await page.getByRole('option', { name: '점검 필요', exact: true }).click();
    await expect(finder.getByRole('searchbox', { name: '조명 이름 또는 번호 검색' })).toBeVisible();
    await expect(finder).toContainText('점검 필요 조명이 없습니다.');
    await finder.getByRole('button', { name: '조명 검색·상세 닫기', exact: true }).click();
    await expect(page.getByText(/표시 상태:/)).toHaveCount(0);
    await expect(page.locator('[aria-label="조명 상세"]')).toHaveCount(0);
    await trigger.click();
    await expect(finder.getByRole('button', { name: '상태 필터', exact: true })).toContainText('점검 필요');
    await assert44px(finder.getByRole('button', { name: '필터 초기화', exact: true }));
    await finder.getByRole('button', { name: '필터 초기화', exact: true }).click();
    await expect(finder.getByRole('button', { name: '상태 필터', exact: true })).toContainText('전체');
    await page.getByRole('dialog', { name: '조명 검색·상세', exact: true }).getByRole('button', { name: '조명 검색·상세 닫기', exact: true }).click();
    await expect(trigger).toBeFocused();
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    expect(state.api.dimmingRequests).toHaveLength(0);
    await attach(info, 'filter-context-bounds', await mapBounds(page));
  });
}

test.describe('task5 actual touch', () => {
  test.use({ hasTouch: true });
  test('map pinch and log swipe retain precise selection and last record', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 720 }); const state = await install(page);
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    const cdp = await page.context().newCDPSession(page);
    try {
      await page.getByRole('button', { name: '지도 전체 보기', exact: true }).tap();
      const viewport = page.getByTestId('monitoring-map-viewport'); const before = await camera(viewport);
      const box = (await viewport.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
      const point = (id: number, offset: number) => ({ id, x: x + offset, y, radiusX: 2, radiusY: 2, force: 1 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, -35), point(2, 35)] });
      for (let step = 1; step <= 6; step++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(1, -35 - step * 5), point(2, 35 + step * 5)] }); await paints(page); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => Number(await viewport.getAttribute('data-zoom'))).toBeGreaterThan(Number(before.zoom));
      const marker = page.locator('[data-spatial-map-marker][title="Task9 조명 1"]');
      await marker.tap(); await expect(marker).toHaveAttribute('data-selected', 'true');
      await expect(page.getByRole('dialog', { name: 'Task9 조명 1 조명 정보', exact: true })).toBeVisible();
      await marker.tap(); await page.getByRole('button', { name: '전체 보기 종료', exact: true }).tap();
      const userZoom = await viewport.getAttribute('data-zoom');
      await page.getByRole('region', { name: '최근 운영 로그', exact: true }).getByRole('button', { name: '전체 보기', exact: true }).tap();
      const drawer = page.getByRole('dialog', { name: '전체 로그', exact: true }), list = drawer.getByRole('region', { name: '운영 로그 본문', exact: true });
      await expect(list.getByRole('listitem')).toHaveCount(50); const initial = await metrics(list);
      for (let step = 0; step < 24 && !(await hit(list.getByRole('listitem').last(), list)).reachable; step++) {
        const r = (await list.boundingBox())!; await swipe(cdp, page, r.x + r.width / 2, r.y + r.height - 12, r.y + 12);
      }
      expect((await metrics(list)).top).toBeGreaterThan(initial.top);
      expect((await hit(list.getByRole('listitem').last(), list)).reachable).toBe(true);
      await drawer.getByRole('button', { name: '다음 페이지', exact: true }).tap(); await expect(list.getByRole('listitem').last()).toContainText('Task9 운영 기록 100');
      await drawer.getByRole('button', { name: '전체 로그 닫기', exact: true }).tap();
      await expect(viewport).toHaveAttribute('data-zoom', userZoom!); expect(state.api.dimmingRequests).toHaveLength(0);
      await attach(info, 'native-touch-results', { before, userZoom, initial, reads: state.reads });
      await info.attach('native-touch-map', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    } finally { await cdp.detach(); }
  });
});

test('task5 genuine browser 200 percent retains map and log filters', async ({ baseURL }, info) => {
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', viewport: null, deviceScaleFactor: undefined, baseURL, args: ['--window-size=1440,900', '--enable-automation'] });
  let profile: string | undefined;
  try {
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    const argv = await cdp.send('Browser.getBrowserCommandLine'); profile = argv.arguments.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    expect(profile && existsSync(profile)).toBeTruthy(); await cdp.detach();
    const state = await install(page); await page.goto(`/monitoring?siteId=${ids.siteId}`);
    const geometry = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport!.scale }));
    const before = await geometry(), settings = await context.newPage();
    await settings.goto('chrome://settings/appearance'); await settings.locator('select#zoomLevel').selectOption('2'); await expect(settings.locator('select#zoomLevel')).toHaveValue('2'); await settings.close();
    await page.bringToFront(); await page.reload(); const after = await geometry();
    expect(after.dpr / before.dpr).toBe(2); expect(Math.abs(after.width * 2 - before.width)).toBeLessThanOrEqual(1); expect(after.scale).toBe(1);
    await page.getByRole('button', { name: '조명 검색·상세', exact: true }).click();
    const mapFilter = page.getByRole('dialog', { name: '조명 검색·상세', exact: true });
    await assert44px(mapFilter.getByRole('button', { name: '조명 검색·상세 닫기', exact: true })); await mapFilter.getByRole('button', { name: '조명 검색·상세 닫기', exact: true }).click();
    await page.getByRole('region', { name: '최근 운영 로그', exact: true }).getByRole('button', { name: '전체 보기', exact: true }).click();
    await page.getByRole('button', { name: /운영 로그 필터 상세 필터/ }).click();
    const logFilter = page.getByRole('dialog', { name: '운영 로그 필터', exact: true });
    await expect(logFilter.getByRole('spinbutton')).toHaveCount(6);
    await assert44px(logFilter.getByRole('button', { name: '페이지당 항목 수', exact: true }));
    await assert44px(logFilter.getByRole('button', { name: '필터 닫기', exact: true }));
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await attach(info, 'genuine-browser-200', { before, after, argv, profile, bounds: await mapBounds(page) });
    await page.bringToFront(); await paints(page);
    await info.attach('genuine-browser-200-filter', { body: await page.screenshot(), contentType: 'image/png' });
    // Browser-level zoom can make Playwright's emulated screenshot surface
    // blank. Also retain the native compositor viewport without changing zoom.
    const capture = await context.newCDPSession(page);
    const native = await capture.send('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false });
    await info.attach('genuine-browser-200-native-viewport', { body: Buffer.from(native.data, 'base64'), contentType: 'image/png' }); await capture.detach();
    expect(state.api.dimmingRequests).toHaveLength(0);
  } finally {
    await context.close(); await attach(info, 'browser-profile-cleanup', { profile, exists: profile ? existsSync(profile) : null }); expect(profile && !existsSync(profile)).toBeTruthy();
  }
});
