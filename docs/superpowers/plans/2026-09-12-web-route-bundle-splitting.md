# Web 라우트 번들 분할 구현 계획

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before any completion claim.

**Goal:** 인증·권한·라우트·기능을 그대로 유지하면서 Web 프로덕션 main 번들을 기존 raw 1,070 kB 및 gzip 325 kB 예산 아래로 낮추고, 데스크톱과 모바일 WebView 크기에서 안정적인 비동기 화면 전환을 제공한다.

**Architecture:** `App`은 로그인과 최초 비밀번호 변경만 eager로 유지하고 고객/운영자 shell을 역할 단위로 lazy-load한다. 각 shell은 내비게이션·권한 가드·로그아웃을 유지한 채 기능 화면을 route 단위로 lazy-load하며, 공통 접근성 로딩 상태를 `Suspense` fallback으로 사용한다. 번들 audit은 기존 예산을 변경하지 않고 role/route chunk 생성과 main chunk의 Konva/Recharts 부재를 fail-closed로 검증한다.

**Tech Stack:** React 18, React Router 6, TypeScript, Vite, Vitest/Testing Library, Playwright, pnpm workspace

**Design:** [Web 라우트 번들 분할 설계](../specs/2026-09-12-web-route-bundle-splitting-design.md)

## 공통 제약과 완료 기준

- [ ] 기존 raw 1,070 kB 및 gzip 325 kB 예산을 올리거나 audit을 skip하지 않는다.
- [ ] URL, `siteId`, query/hash, capability guard, dirty floor editor 보호, 로그아웃, 인증·최초 비밀번호 변경 동작을 보존한다.
- [ ] API·DB·MQTT·firmware·mobile native·HIL·운영 환경·main 브랜치를 변경하지 않는다.
- [ ] 테스트 RED를 확인한 뒤 최소 구현으로 GREEN을 만들고, 각 구현 작업 뒤 독립 task review를 통과한다.
- [ ] 1440/390/320px Chromium과 RealBackendLab을 포함해 회귀를 검증한다.
- [ ] `pnpm ci:production-audit`를 끝까지 실행해 Web container와 dependency policy 단계까지 통과시킨다.
- [ ] 모니터링·제어·통계·설정 기능 현황 문서와 프로젝트 상태·에이전트 운영 기록을 최신화한다.

### Task 1: 공통 route loading과 역할 shell 경계

**Files:**

- Create: `apps/web/src/components/ui/RouteLoadingState.tsx`
- Modify: `apps/web/src/components/ui/index.ts`
- Modify: `apps/web/src/components/ui/ui-primitives.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/scripts/audit-schedule-bundle.mjs`

- [ ] **Step 1: 역할 shell bundle audit을 먼저 강화한다.**
  - audit이 customer/operator shell의 별도 production chunk와 main chunk의 Konva/Recharts 부재를 요구하게 한다.
  - 기존 raw/gzip 예산, schedule chunk, shared browser contract와 Gateway 문구 검사를 유지한다.
  - 명령: `pnpm --filter @led-control/web build && node apps/web/scripts/audit-schedule-bundle.mjs`
  - 예상: 정적 role shell이 별도 chunk가 아니므로 실패한다(RED).

- [ ] **Step 2: 공통 로딩 상태와 shell 지연 로딩 기대를 테스트로 고정한다.**
  - `RouteLoadingState`가 `role="status"`, `aria-live="polite"`, 이해하기 쉬운 한국어를 제공하는지 추가한다.
  - 로그인·최초 비밀번호 변경은 즉시 렌더링되고, 고객/운영자 shell은 비동기 경계에서 공통 fallback을 거쳐 렌더링되는지 추가한다.
  - 명령: `pnpm --filter @led-control/web test -- src/components/ui/ui-primitives.test.tsx src/App.test.tsx`
  - 예상: 새 기대가 구현 전 실패한다(RED).

- [ ] **Step 3: 고정 폭 없이 재사용 가능한 로딩 상태를 구현한다.**
  - 기존 공통 primitive의 색상·간격·접근성 규칙을 재사용한다.
  - viewport 밖으로 밀어내는 width/min-width를 추가하지 않는다.

- [ ] **Step 4: `App` 역할 shell을 lazy-load한다.**
  - `AuthView`와 `RequiredPasswordChangeView`는 eager로 유지한다.
  - `CustomerShell`, `OperatorShell`만 `React.lazy`로 가져오고 공통 `Suspense` fallback을 적용한다.
  - 기존 principal 검증, role/capability 분기와 로그아웃 흐름은 변경하지 않는다.

- [ ] **Step 5: focused 회귀와 정적 검증을 실행한다.**
  - `pnpm --filter @led-control/web test -- src/components/ui/ui-primitives.test.tsx src/App.test.tsx`
  - `pnpm --filter @led-control/web typecheck`
  - `pnpm --filter @led-control/web build`
  - `node apps/web/scripts/audit-schedule-bundle.mjs`

- [ ] **Step 6: 독립 task review 후 수정하고 커밋한다.**
  - 요구사항·접근성·인증 경계·테스트 품질을 검토한다.
  - 커밋: `feat(web): lazy load role shells`

### Task 2: 고객/운영자 기능 route 분할과 번들 정책

**Files:**

- Modify: `apps/web/src/CustomerShell.tsx`
- Modify: `apps/web/src/CustomerShell.test.tsx`
- Modify: `apps/web/src/operator/OperatorShell.tsx`
- Create: `apps/web/src/features/operator/OperatorShell.test.tsx`
- Modify: `apps/web/scripts/audit-schedule-bundle.mjs`

- [ ] **Step 1: bundle audit과 shell route 테스트를 먼저 강화한다.**
  - Task 1 audit에 대표 기능 route chunk 생성 요구를 추가한다.
  - capability가 없는 직접 URL은 lazy module 실행 전에 기존 안전 route로 이동하고, 허용 route는 fallback 뒤 정상 화면을 표시하는지 고정한다.
  - 명령: `pnpm --filter @led-control/web test -- src/CustomerShell.test.tsx src/features/operator/OperatorShell.test.tsx`
  - 명령: `pnpm --filter @led-control/web build && node apps/web/scripts/audit-schedule-bundle.mjs`
  - 예상: route chunk 요구가 구현 전 실패한다(RED).

- [ ] **Step 2: 고객 기능 화면을 route 단위로 lazy-load한다.**
  - 모니터링, 제어, 통계 shell/overview/analysis/reports, 설정 shell/overview/users/registration/floor plans/floor editor/password를 동적 import로 전환한다.
  - 고객 shell chrome, capability 계산·가드, `siteId`/query/hash 보존과 dirty editor blocker는 기존 위치와 계약을 유지한다.
  - route 영역에 공통 `RouteLoadingState` fallback을 적용한다.

- [ ] **Step 3: 운영자 기능 화면을 route 단위로 lazy-load한다.**
  - operator shell chrome과 로그아웃은 eager로 유지하고 `SiteAdminManagementView`를 동적 import한다.
  - 운영자 route와 접근성 fallback 회귀를 추가한다.

- [ ] **Step 4: 비동기 전환에 맞춰 테스트를 최소 수정한다.**
  - 동기 `getBy*`를 무차별 변경하지 않고 실제 lazy 경계 뒤 결과만 `findBy*`/`waitFor`로 전환한다.
  - URL, capability, site 선택, 설정/통계 하위 route 및 편집기 보호 기대를 그대로 유지한다.

- [ ] **Step 5: focused·전체 Web 검증과 bundle audit을 실행한다.**
  - `pnpm --filter @led-control/web test -- src/CustomerShell.test.tsx src/features/operator/OperatorShell.test.tsx src/App.test.tsx`
  - `pnpm --filter @led-control/web test`
  - `pnpm --filter @led-control/web typecheck`
  - `pnpm --filter @led-control/web lint`
  - `pnpm --filter @led-control/web build`
  - `node apps/web/scripts/audit-schedule-bundle.mjs`
  - 예상: main raw/gzip 모두 기존 예산 미만이며 role/route chunk 및 Konva/Recharts 격리 검사가 통과한다(GREEN).

- [ ] **Step 6: 독립 task review 후 수정하고 커밋한다.**
  - 라우트 누락, 권한 우회, chunk naming 의존성과 중복 구현을 검토한다.
  - 커밋: `perf(web): split customer feature routes`

### Task 3: 데스크톱·모바일 WebView 크기와 실제 백엔드 회귀

**Files:**

- Modify only if RED requires it: `apps/web/e2e/calm-operations-monitoring.spec.ts`
- Modify only if RED requires it: `apps/web/e2e/calm-operations-automation.spec.ts`
- Modify only if RED requires it: `apps/web/e2e/calm-operations-commissioning.spec.ts`
- Modify only if RED requires it: `apps/web/e2e/settings-floor-editor.spec.ts`
- Modify only if RED requires it: `apps/web/e2e/statistics-flow.spec.ts`
- Modify only if RED requires it: RealBackendLab customer journey spec discovered under `apps/web/e2e`

- [ ] **Step 1: 대표 route의 1440/390/320px Chromium 회귀를 실행한다.**
  - 모니터링, 제어 자동화, 등록, 통계, 설정/맵 편집의 기존 viewport 검증을 실행한다.
  - 비동기 화면 전환 중 전체 가로 스크롤, 잘림, 로딩 상태 접근성, route 복원 문제를 확인한다.
  - 명령: `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts e2e/calm-operations-automation.spec.ts e2e/calm-operations-commissioning.spec.ts e2e/settings-floor-editor.spec.ts e2e/statistics-flow.spec.ts --project=chromium --workers=1`

- [ ] **Step 2: 실패가 기능 회귀일 때만 테스트/구현을 TDD로 보완한다.**
  - timeout 증대나 무조건 sleep 대신 사용자에게 보이는 로딩/완료 조건을 기다린다.
  - `automation-control-flow.spec.ts`의 알려진 stale route는 이번 범위에 포함하지 않는다.

- [ ] **Step 3: disposable backend RealBackendLab을 실행한다.**
  - `E2E_REAL_BACKEND_LAB=1 pnpm ci:real-backend`
  - 로그인→고객 운영 흐름, URL/capability/site 상태가 lazy chunk 이후에도 유지되는지 확인한다.

- [ ] **Step 4: 독립 task review 후 필요 시 커밋한다.**
  - viewport 범위와 테스트가 실제 사용자 동작을 검증하는지 검토한다.
  - 변경이 있을 때만 커밋: `test(web): cover lazy route transitions`

### Task 4: 전체 production audit, 문서화, 최종 검토

**Files:**

- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/agent-operations.md`
- Modify if reusable failure is found: `docs/lesson_leared.md`
- Modify: this plan checklist

- [ ] **Step 1: 최종 Web 및 workspace 검증을 새 로그로 실행한다.**
  - `pnpm --filter @led-control/web lint`
  - `pnpm --filter @led-control/web typecheck`
  - `pnpm --filter @led-control/web test`
  - `pnpm --filter @led-control/web build`
  - `node apps/web/scripts/audit-schedule-bundle.mjs`
  - `pnpm ci:production-audit`
  - 마지막 명령이 Web container와 dependency policy를 포함해 끝까지 통과해야 한다.

- [ ] **Step 2: 기능 현황과 검증 한계를 문서화한다.**
  - 네 메뉴 문서의 `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구조를 유지한다.
  - chunk 분할, 공통 로딩 상태, 실제 bundle 수치, 1440/390/320 Chromium 및 RealBackendLab 결과를 기록한다.
  - WebView 크기 검증은 브라우저 software 증거이고 실제 iOS/Android native WebView/HIL 검증이 아님을 명시한다.
  - 프로젝트 상태를 완료 또는 검증된 blocker 상태로 갱신하고 에이전트 운영 기록과 계획 체크리스트를 동기화한다.

- [ ] **Step 3: 문서 검증과 diff 위생을 확인하고 커밋한다.**
  - `git diff --check`
  - 문서의 SHA, 테스트 수, bundle 수치와 범위가 실제 로그와 일치하는지 대조한다.
  - 커밋: `docs: record web bundle split verification`

- [ ] **Step 4: whole-branch final review를 수행한다.**
  - 설계·계획 대비 누락, Critical/Important/Minor 결함, 인증·권한·라우트·접근성·반응형·번들 audit 회귀를 독립 검토한다.
  - 지적 사항은 같은 작업트리에서 수정하고 필요한 검증을 재실행한다.
  - `git status --short`, `git log`, 최종 diff와 production audit 로그를 근거로 완료 여부를 판정한다.
