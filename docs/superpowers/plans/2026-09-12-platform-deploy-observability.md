# 플랫폼 Production 배포·관측·Web 복구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API/Web의 실행 가능한 production 배포 경로와 dependency-aware 관측, 앱 셸 복구 UI를 완성한다.

**Architecture:** Nest API가 liveness/readiness/request context/구조화 지표를 소유하고, production Compose가 동일 API image의 migration one-shot 뒤 API와 TLS Web proxy를 순서대로 기동한다. React 앱 셸은 인증 상태와 전송·chunk 오류를 분류해 공통 복구 UI로 수렴한다.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL 16, Redis 7, MQTT 5, AWS SDK S3, React 18, React Query 5, Vite 5, nginx 1.27, Docker Compose, Jest/Vitest/Playwright/Node test.

**Spec:** `docs/superpowers/specs/2026-09-12-platform-deploy-observability-design.md`

## Global Constraints

- 지정 worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-deploy-observability`와 branch `codex/p0p1-platform-deploy-observability`만 수정한다.
- 실제 production 배포, secret 변경, 사용자 DB migration, 실제 MQTT/Gateway/Raspberry Pi/BlueZ/ESP32-H2 HIL, production notification은 실행하지 않는다.
- production secret과 외부 URL은 저장소 기본값 없이 fail-fast하고, health/log/metrics는 credential·tenant·body·query value·stack trace를 노출하지 않는다.
- migration 성공 → API readiness 성공 → Web 시작 순서를 보장한다.
- 테스트 timeout/retry를 늘려 실패를 숨기지 않고 TDD RED→GREEN 증거를 작업 보고서에 남긴다.
- DB schema는 변경하지 않는다. 변경이 불가피하면 작업을 중단하고 총괄에 보고한다.
- 메뉴 기능에 영향을 주는 Web 복구 변경은 `docs/menus/monitoring.md`, `control.md`, `statistics.md`, `settings.md`를 함께 갱신한다.

---

### Task 1: API health, request context, structured observability

**Files:**
- Create: `apps/api/src/observability/observability.module.ts`
- Create: `apps/api/src/observability/health.controller.ts`
- Create: `apps/api/src/observability/readiness.service.ts`
- Create: `apps/api/src/observability/request-context.middleware.ts`
- Create: `apps/api/src/observability/structured-logger.service.ts`
- Create: focused `*.spec.ts` files beside each production unit
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify only as needed to expose safe probes: existing Prisma/Redis/MQTT/Object Storage services

**Interfaces:**
- Produces: `GET /health/live`, `GET /health/ready`, `GET /health/metrics`.
- Produces: `RequestContext.run(requestId, fn)`, `RequestContext.getRequestId(): string | undefined`.
- Produces: readiness result `{ status: "ready" | "not_ready"; checks: Record<"postgres" | "redis" | "mqtt" | "objectStorage", "up" | "down">; timestamp: string }`.
- Consumes: existing `PrismaService`, `RedisProvider`, `MqttService`, `ObjectStorageService`; no second dependency clients.

- [x] Write focused Jest RED tests proving live does no dependency I/O, ready returns 200/503 with only safe fields, probe timeout is bounded, shutdown becomes not-ready, and metrics use only fixed labels.
- [x] Run the focused Jest files and record the expected missing-module/behavior failures.
- [x] Write request-context/logger RED tests with valid/invalid `X-Request-Id`, response propagation, concurrent request isolation, JSON-line fields, and redaction of cookie/authorization/body/query/stack.
- [x] Run the focused tests and record the expected failures.
- [x] Implement the minimal observability module and small probe methods on existing services. Use `Promise.allSettled`, an injected clock/timeout boundary, and generic down states; do not expose caught errors.
- [x] Wire middleware and structured logger in `main.ts`, keeping existing TLS/body parser/lifecycle behavior. Mark readiness stopping before dependency shutdown starts.
- [x] Run focused tests, full API test/typecheck/build and `git diff --check`.
- [x] Update `docs/agent-operations.md` and `docs/project-status.md` with Task 1 evidence and exclusions; commit.

### Task 2: Immutable API image and fail-fast production Compose path

**Files:**
- Create: `apps/api/Dockerfile`
- Create: `apps/api/container-contract.node.mjs`
- Create: `apps/api/container-init-crls.cjs` (승인된 동적 공개 CRL 예외)
- Create: `apps/web/nginx.stream.conf` (리뷰 승인: socket mTLS용 TCP passthrough)
- Create: `scripts/production-deploy-contract.test.mjs`
- Create: `scripts/production-compose-config.mjs`
- Create: `scripts/production-compose-smoke.sh`
- Modify: `docker-compose.production.yml`
- Modify: `apps/web/Dockerfile`
- Modify: `apps/web/nginx.conf.template`
- Modify: `apps/web/container-contract.node.mjs`
- Modify: `scripts/ci-production-audit.sh`
- Modify: `infra/mosquitto.production-tls.conf`, `tests/mqtt-production-config.node.mjs`, `scripts/ci-workflows.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 `/health/live` and `/health/ready` endpoints.
- Produces: one API image usable as `api-migrate` one-shot and `api` runtime.
- Produces: `pnpm production:contract` and `pnpm production:smoke` commands.
- Produces: Web TLS endpoint and same-origin `/api/` proxy; API is private to the Compose network.

- [x] Write Node contract RED tests that execute standalone `docker-compose.production.yml` config against explicit non-secret fixture env and reject missing required variables, inherited development defaults, non-Web host ports, mutable/latest images, writable secret mounts, absent healthchecks, or wrong dependency order.
- [x] Write container RED tests for API non-root runtime, frozen install, Prisma generation, compiled entrypoint, signal-safe process, and migration command; extend Web tests for TLS 1.2/1.3, HTTP redirect, upstream certificate verification, request ID forwarding, asset/index cache policy and security headers.
- [x] Run contract tests and record the expected failures before production config changes.
- [x] Implement API Dockerfile and standalone production Compose services. Keep `docker-compose.yml` development-only; use `${VAR:?message}`, read-only certificate mounts, named data volumes, private networks, resource/restart limits, and `api-migrate: service_completed_successfully` → `api: service_healthy` → Web ordering.
- [x] Implement nginx TLS/proxy/cache/security config without embedding certificates or upstream credentials.
- [x] Extend production audit so Docker/Compose absence or container smoke failure cannot be skipped.
- [x] Run Node contracts, `docker compose ... config`, actual API/Web image builds, and a unique disposable Compose project smoke. Apply all migrations only inside the disposable database, verify readiness dependency fail/recover, TLS Web proxy, then remove only that project and its volumes.
- [x] Run API/Web typecheck/build, production audit and `git diff --check`; update `docs/agent-operations.md`, `docs/project-status.md`; commit.
- [x] 승인된 동적 CRL 두 named volume 예외를 구현하고 read-only seed 누락 fail-fast, API 실제 publisher의 atomic rename, broker RO 소비, init 재실행의 상태 보존과 exact cleanup을 disposable smoke로 검증한다. 인증서/key/CA/제조 CRL은 RO로 유지한다.
- [x] 리뷰 수정: production 전용 project 식별자를 필수 검증하고 render/up 양쪽에 동일 `-p`를 적용한다. 개발/default project 충돌과 named volume 재사용을 거부하는 RED/GREEN을 검증한다.
- [x] 리뷰 수정: Web-only 세 번째 host port를 nginx TCP stream으로 API TLS listener에 연결한다. 실제 disposable 제조 인증서의 no-cert 401→valid-cert/invalid-body 400, 서버 identity 검증, DB 무변경과 기존 browser proxy·health·cleanup을 검증한다. 전체 production audit 및 API/Web 검증 후 문서·보고서를 갱신하고 커밋한다.

### Task 3: Accessible Web app-shell recovery

진행 상태: 리뷰 Important/Minor 수정·소프트웨어 검증 완료, 재검토 대기. 최초 RED는 auth 10개 중 9 실패·기존 401 1 통과, 공통 복구 컴포넌트 2개 미존재 suite 실패, transport classifier 5/5 실패다. Self-review의 현재 사용자 active command 정리 누락도 1 실패/9 통과 RED 후 수정했다. 최종 focused 90/90, Web 전체 64 files·712/712, auth/shell Chromium 23/23(신규 복구 10개), typecheck/build 및 main 319.19 kB/gzip 99.21 kB bundle audit를 통과했다. 운영/실백엔드/HIL과 Task 4 작업은 미실행이다. 리뷰 신규 단위 5개는 전부 RED를 확인했고 실제 offline-at-boot Chromium도 RED 후 GREEN으로 전환했다. AppRoot 세대별 client 격리, App-own boundary, 5초 logout abort·중복 억제와 기존 필수 비밀번호 변경 회귀를 함께 검증했다.

**Files:**
- Create: `apps/web/src/AppRoot.tsx` (root boundary and session-generation QueryClient coordinator)
- Modify: `apps/web/src/features/control/active-command-store.ts` (scoped recovery cleanup helper)
- Create: `apps/web/src/components/ui/AppRecoveryState.tsx`
- Create: `apps/web/src/components/ui/AppErrorBoundary.tsx`
- Create: focused tests beside the new components
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/api/auth.ts`
- Modify: `apps/web/src/api/client.ts` only if error classification needs a stable helper
- Modify: `apps/web/src/components/ui/index.ts`
- Modify: `apps/web/src/styles.css`
- Modify/Create: focused Playwright app-shell recovery spec and fixture support

**Interfaces:**
- Produces: `AppRecoveryState` variants `service_unavailable | forbidden | chunk_error` with accessible retry/relogin actions.
- Produces: top-level `AppErrorBoundary` that catches lazy/render failures and never renders raw error details.
- Consumes: existing `ApiError`, `clearTenantCache`, `AuthView`, `Button`, role shells and `RouteLoadingState`.

- [x] Write Vitest RED cases for initial 401→login, 403→forbidden/relogin, network and 5xx→service retry, retry success, and no tenant cache leakage.
- [x] Write Error Boundary RED cases for rejected lazy import/render error, accessible focus/alert, reload and relogin; name the production mutation each test catches.
- [x] Run focused Vitest and record the expected failures.
- [x] Implement auth retry policy: only network/5xx, maximum 2 retries; do not retry 401/403. Preserve existing authenticated principal and mandatory-password flows.
- [x] Implement common recovery UI and root boundary. Full reload is the canonical chunk recovery; relogin clears tenant cache/session state without exposing error text.
- [x] Add Chromium scenarios for first-load API 503→retry success, 401 login, 403 relogin, and lazy chunk failure recovery. Do not increase Playwright timeout.
- [x] Review RED/GREEN: offline-at-boot browser state and resume; deferred old mutation after 403/relogin/different principal isolated from active client; initial 403 without known principal clears only app active-command namespace.
- [x] Review RED/GREEN: root boundary catches App-own hook failure and converges to eager login after failed logout; synchronous duplicate suppression and exactly 5,000ms abort prevent login/logout races.
- [x] Run focused Chromium, full Web test/typecheck/build and `git diff --check`.
- [x] Update all four `docs/menus/*.md`, `docs/agent-operations.md`, `docs/project-status.md`; commit.

### Task 4: Runbook and final convergence

진행 상태: 검토 승인 HEAD `349bc4c`에서 runbook·최종 소프트웨어 수렴을 완료했고, 최종 HEAD `728e0a8`의 Task 4/whole-branch 독립 검토도 Critical/Important/Minor 0, PASS로 승인됐다. Task 1~3 항목은 당시 이력이다. 최종 root lint/typecheck/test/build 0, root 58·Shared 203·Automation 28·Mobile 1·Web 712·API 1,138/환경 289 제외·Gateway 608(합계 2,748/289 제외), 전체 Chromium 189 통과/5 opt-in 제외(188 mock/브라우저+실제 disposable automation 1), main 319.19 kB/gzip 99.21 kB다. Production 계약 18/18, 전체 audit의 MQTT 2/2·Gateway container 24/24·required MQTT 2/2·dependency 820개/기존 High 2·Moderate 1 예외/unexpected 0을 확인했다. 새 smoke `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`는 빈 DB 57/57 migration·TLS/mTLS·CRL·장애 복구와 exact cleanup container/volume/network/image/temp dir 0을 통과했다. API/Web image ID와 모든 실패→승인 수정 근거는 Task 4 보고서/runbook에 있다. 승인 예외 커밋은 CRL test `73e413d`, stale Web E2E `651a3ce`, restore selector 접근성 `ad864f9`, Gateway durable observation test sync `e3daa6a`다. Timeout/retry·API/Gateway production·schema/shared/개발 Compose는 불변이고 운영 배포·사용자 DB·외부 서비스·HIL은 미실행이다.

**Files:**
- Create: `docs/runbooks/production-api-web-deployment.md`
- Modify: `docs/agent-operations.md`
- Modify: `docs/project-status.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/menus/settings.md`
- Modify: this plan checklist

**Interfaces:**
- Consumes: Task 1 health/metrics contract, Task 2 production Compose/scripts, Task 3 recovery UI.
- Produces: operator procedure for preflight, secret files, migration, startup, health/readiness/metrics, rollback boundary, log correlation and alert recommendations.

- [x] Write the runbook with exact commands that use an example `.env.production` path without real values; distinguish render/build/smoke evidence from actual deployment authorization.
- [x] Document alerts for readiness down, 5xx rate, latency, dependency failures and repeated Web recovery without claiming an external alert backend exists.
- [x] Run fresh root lint/typecheck/test/build, full relevant Playwright, production contract/audit, and unique disposable Compose smoke. Record exact counts, image digests/names, migration count and cleanup evidence.
- [x] Confirm no schema/migration/secret/user DB/real broker or HIL changes, run `git diff --check`, and reconcile `docs/project-status.md` with all menu docs and this checklist.
- [x] Commit final documentation and verification evidence; Task 4와 whole-branch 독립 검토에서 Critical/Important/Minor 0, PASS 승인을 확인한다.
