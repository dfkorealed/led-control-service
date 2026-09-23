const { chromium } = require('../../../apps/web/node_modules/@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const scenes = [
    ['01-setup', 'setup', 1440, 900],
    ['02-monitoring', 'monitoring', 1440, 900],
    ['03-control', 'control', 1440, 900],
    ['04-statistics', 'statistics', 1440, 900],
    ['05-reports', 'reports', 1440, 900],
    ['06-settings', 'settings', 1440, 900],
    ['07-mobile-monitoring', 'mobile', 390, 844],
    ['08-mobile-map-placement', 'mobileEditor', 390, 844],
    ['09-status-center', 'statusCenter', 1440, 900],
    ['10-auth-recovery', 'auth', 1440, 900],
    ['11-mobile-monitoring-320', 'mobile', 320, 740]
  ];
  for (const [name, scene, width, height] of scenes) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(__dirname, 'scenes.html')).href + '?scene=' + scene);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode().catch(() => {}))));
    const state = await page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const touchTargets = [...document.querySelectorAll('.mobile button,.mobile .search,.mobile .top-icon,.mobile .pill.blue,.mobile .placement-target')]
        .filter(visible);
      const touchViolations = touchTargets.map(element => {
        const box = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 24) || element.className, width: box.width, height: box.height };
      }).filter(target => target.width < 44 || target.height < 44);
      const markerRects = [...document.querySelectorAll('.mobile .map-stage .marker')].filter(visible).map(element => element.getBoundingClientRect());
      const markerOverlaps = [];
      for (let i = 0; i < markerRects.length; i++) {
        for (let j = i + 1; j < markerRects.length; j++) {
          const a = markerRects[i], b = markerRects[j];
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) markerOverlaps.push([i, j]);
        }
      }
      return {
        title: document.title,
        viewport: [innerWidth, innerHeight],
        bodyScrollWidth: document.body.scrollWidth,
        failedImages: [...document.images].filter(img => !img.naturalWidth).map(img => img.src),
        selectedMarkers: document.querySelectorAll('.map-stage .marker.selected').length,
        touchViolations,
        markerOverlaps,
        text: document.body.innerText.length
      };
    });
    if (state.failedImages.length || state.bodyScrollWidth > width || state.touchViolations.length || state.markerOverlaps.length
      || (scene === 'control' && state.selectedMarkers !== 3)) {
      throw new Error(name + ' layout/contract check failed: ' + JSON.stringify(state));
    }
    await page.screenshot({ path: path.join(__dirname, name + '.png') });
    console.log(name, JSON.stringify(state));
    await page.close();
  }
  await browser.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
