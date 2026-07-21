# Task 6 Report: URL-Based Settings Shell and Site Selection

## Scope

- Implemented Task 6 from `.superpowers/sdd/task-6-brief.md`.
- Preserved the existing monitoring floor-editor button and in-memory edit flow. Moving the editor's actual state loading, save, and cancel routing is Task 7.

## Implementation Commit

- `b5a92bd feat(settings): add routed settings workspace`

## Changed Files

- `apps/web/package.json`, `pnpm-lock.yaml`: added `react-router-dom@^7.0.0`.
- `apps/web/src/App.tsx`, `App.test.tsx`: URL routes, URL-based primary navigation tests, refresh route test, and site-scoped dashboard test.
- `apps/web/src/state/navigation-store.ts`: removed obsolete Zustand navigation state.
- `apps/web/src/features/settings/SettingsShell.tsx`, `SettingsShell.test.tsx`: role-aware settings shell and menu test.
- `apps/web/src/features/settings/settings-sections.ts`, `settings-sections.test.ts`: reusable role-to-section mapping and tests.
- `apps/web/src/features/sites/SiteSwitcher.tsx`, `SiteSwitcher.test.tsx`: `/sites`-driven selector that preserves the current path and changes only `siteId`.
- `apps/web/src/api/queries.ts`: site-scoped dashboard/control/fixture query keys and selected dashboard URLs.
- `apps/web/src/features/monitoring/MonitoringView.tsx`, `features/control/ControlView.tsx`, `features/settings/SettingsView.tsx`: forwarded URL `siteId` to dashboard queries.
- `apps/web/Dockerfile`, `apps/web/nginx.conf`: production SPA image and refresh fallback.
- `apps/web/src/styles.css`: navigation link and settings workspace styles.

## RED Evidence

1. Added the `/settings/floor-plans` refresh test before routing implementation.
2. Ran:

   ```sh
   pnpm --filter @led-control/web exec vitest run src/App.test.tsx --reporter=verbose
   ```

   Result: 20 passed, 1 failed. The new test failed with `Unable to find role="heading" and name "도면 관리"` because the app still rendered Zustand's monitoring view regardless of the URL.
3. Added role-section and site-switcher tests before their implementation. The combined RED run reported the expected unresolved module imports for `settings-sections` and `SiteSwitcher`, in addition to the route failure.

## GREEN Evidence

1. Focused route, role, and site-selection run:

   ```sh
   pnpm --filter @led-control/web exec vitest run src/App.test.tsx src/features/settings src/features/sites/SiteSwitcher.test.tsx --reporter=verbose
   ```

   Result: 4 files, 26 tests passed.
2. Full web verification:

   ```sh
   pnpm --filter @led-control/web typecheck
   pnpm --filter @led-control/web test
   pnpm --filter @led-control/web build
   ```

   Result: typecheck passed; 9 files and 51 tests passed; production Vite build passed.
3. Container and refresh verification:

   ```sh
   docker build -f apps/web/Dockerfile -t led-control-web-task6:verify .
   docker run --rm -d --name led-control-web-task6-verify -p 127.0.0.1:8096:80 led-control-web-task6:verify
   curl --fail --silent --show-error 'http://127.0.0.1:8096/settings/floor-plans?siteId=site-2'
   ```

   Result: Docker image build passed and the deep settings URL returned SPA HTML containing `<div id="root"></div>`.

## Concerns and Follow-Up

- Vite reports pre-existing large production chunks (PDF worker and main bundle) above 500 kB; this does not fail the build.
- `/settings/floor-plans/:floorId/edit` is intentionally a route skeleton. Task 7 must connect editor state loading, saving, and cancel navigation there, then move/remove the monitoring editor entry point.
- The settings shell currently uses the desktop side navigation at mobile widths. The planned mobile top selection control remains follow-up UI work.

## Fix Follow-up (2026-07-21)

### RED Evidence

1. Added focused web, API, route, site-switcher, and container-contract regression tests before the fixes.
2. Ran:

   ```sh
   pnpm --filter @led-control/web exec vitest run src/api/client.test.ts src/api/queries.test.tsx src/features/sites/SiteSwitcher.test.tsx src/App.test.tsx --reporter=verbose
   pnpm --filter @led-control/api exec jest src/fixtures/fixtures.controller.spec.ts src/fixtures/fixtures.service.spec.ts --runInBand
   node --test apps/web/container-contract.test.mjs
   ```

   Result: the web client requested `http://localhost:4000`, fixture requests omitted `siteId`, displayed settings links fell through to the wildcard route, and the hash was discarded. The API controller/service still accepted only `floorId`, and the container contract failed because the nginx template/proxy did not exist.

### GREEN Evidence

1. Focused regression tests:

   ```sh
   pnpm --filter @led-control/web exec vitest run src/api/client.test.ts src/api/queries.test.tsx src/features/sites/SiteSwitcher.test.tsx src/App.test.tsx --reporter=dot
   pnpm --filter @led-control/api exec jest src/fixtures/fixtures.controller.spec.ts src/fixtures/fixtures.service.spec.ts --runInBand
   node --test apps/web/container-contract.node.mjs
   ```

   Result: 37 focused web tests, 7 fixture API tests, and the Node container contract test passed.
2. Full web and type verification:

   ```sh
   pnpm --filter @led-control/web test
   pnpm --filter @led-control/web typecheck
   pnpm --filter @led-control/api typecheck
   pnpm --filter @led-control/web build
   ! rg -n "http://localhost:4000" apps/web/dist
   ```

   Result: 11 web test files and 65 tests passed; both typechecks and the production build passed; the built web assets contain no browser `http://localhost:4000` API URL. Vite retained the existing large-chunk warning.
3. Container and runtime proxy verification:

   ```sh
   docker build --no-cache -f apps/web/Dockerfile -t led-control-web-task6-followup .
   docker exec led-control-task6-web nginx -t
   curl --fail --silent --show-error 'http://127.0.0.1:18096/settings/floor-plans?siteId=site-2'
   curl --fail --silent --show-error 'http://127.0.0.1:18096/api/contract?siteId=site-2'
   ```

   Result: the image built successfully; nginx configuration validation passed; the deep route returned SPA HTML; and `/api/contract?siteId=site-2` reached the configured upstream as `/contract?siteId=site-2`.
