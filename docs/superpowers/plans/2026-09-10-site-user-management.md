# 현장 유저 관리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현장 admin이 최대 100명의 조회·제어 사용자를 안전하게 관리하고, 사용자 권한이 웹 메뉴와 백엔드 API에서 동일하게 적용되도록 구현한다.

**Architecture:** 기존 `User.role`은 시스템 역할로 유지하고 `SiteMembership.accessLevel`로 현장 단위 `read/control` 권한을 표현한다. 유저 관리 write와 수동 제어 권한은 Site 행 잠금 이후 transaction 내부에서 재인가하며, 영구 삭제 시 계정 데이터는 제거하되 조명 명령 이력의 사용자 참조만 nullable로 익명화한다. Dashboard가 계산된 capability를 반환하고 웹은 이를 메뉴·route·제어 UI의 단일 기준으로 사용한다.

**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL, React 18, React Query, React Router, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-09-10-site-user-management-design.md`

## Global Constraints

- 모든 일반 유저의 `User.role`은 `viewer`로 유지한다.
- 접근 수준은 현장 전체에 적용되는 `read` 또는 `control` 두 가지만 사용한다.
- active와 disabled 일반 유저를 합쳐 현장당 최대 100명으로 제한한다.
- 비밀번호 평문과 hash를 API 응답, 로그, 감사 로그, React Query cache에 포함하지 않는다.
- 일반 유저 영구 삭제 후에도 조명 명령·장비 응답·수동 override 이력은 익명화 상태로 보존한다.
- 스케줄, 차량 이벤트, 구역 관리, 설치, 조명 등록과 맵 편집은 admin 전용으로 유지한다.
- 모바일 구현은 이번 범위에서 제외한다.
- DB 구조 변경과 메뉴 기능 변경 시 `docs/database-schema.md`, `docs/menus/settings.md`, `docs/menus/control.md`, `docs/menus/monitoring.md`, `docs/menus/statistics.md`, `docs/project-status.md`를 함께 갱신한다.
- 기존 dirty worktree의 관련 없는 변경은 수정하거나 되돌리지 않는다.

---

### Task 1: 사용자 권한과 영구 삭제 DB 계약

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260910010000_site_user_access/migration.sql`
- Create: `apps/api/src/prisma/site-user-access-migration.integration.spec.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: Prisma enum `SiteAccessLevel`, `User.mustChangePassword`, `SiteMembership.accessLevel`
- Produces: nullable `Command.requestedBy`, nullable `ManualOverride.requestedById`, cascading `Session.user`
- Preserves: `Command.id`와 `ManualOverride.commandId`의 1:1 관계

- [x] **Step 1: migration 통합 테스트를 작성한다.**

  기존 membership의 `accessLevel = read` backfill, 사용자 삭제 후 Session과 membership 삭제, Command와 ManualOverride의 요청자 `NULL` 보존을 실제 PostgreSQL schema에서 검증한다.

- [x] **Step 2: migration 테스트가 신규 column과 삭제 정책 부재로 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/api exec jest src/prisma/site-user-access-migration.integration.spec.ts --runInBand`

- [x] **Step 3: Prisma schema와 SQL migration을 구현한다.**

  `SiteAccessLevel`, 두 신규 필드, `onDelete: SetNull/Cascade`를 추가한다. `ManualOverride.command`는 `commandId -> Command.id` 관계로 단순화하고 더 이상 필요한 없는 `[id, siteId, requestedBy]`와 `[commandId, siteId, requestedById]` unique 계약을 제거한다.

- [x] **Step 4: Prisma client를 생성하고 migration 테스트를 통과시킨다.**

  Run: `pnpm --filter @led-control/api prisma:generate`

  Run: `pnpm --filter @led-control/api exec jest src/prisma/site-user-access-migration.integration.spec.ts --runInBand`

- [x] **Step 5: DB 문서를 현재 schema와 삭제 정책으로 갱신한다.**

- [x] **Step 6: Task 1 변경만 커밋한다.**

  Commit: `feat(api): add site user access schema`

### Task 2: 현장 capability 판정

**Files:**
- Modify: `apps/api/src/access/site-access.service.ts`
- Modify: `apps/api/src/access/site-access.service.spec.ts`
- Modify: `apps/api/src/access/site-access.integration.spec.ts`

**Interfaces:**
- Produces: `SiteCapability = "read" | "control" | "manage" | "commission"`
- Produces: `assertControlInTransaction(tx, user, siteId)`
- Produces: `capabilities(user, siteId): Promise<SiteCapabilities>`
- Consumes: `SiteMembership.accessLevel`

- [x] **Step 1: read/control/admin capability 행렬 단위 테스트를 작성한다.**

  `read` membership은 read만, `control` membership은 read와 control, 배정 admin은 모든 capability를 허용하고 일반 유저의 manage/commission은 거절하는 사례를 포함한다.

- [x] **Step 2: transaction 재인가 통합 테스트를 작성한다.**

  Site 잠금 뒤 membership 상태를 다시 읽으며, 비활성화·membership 삭제·타 조직 이동이 발생한 요청을 거절하는지 검증한다.

- [x] **Step 3: 기존 서비스가 control을 알지 못해 테스트가 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/api exec jest src/access/site-access.service.spec.ts src/access/site-access.integration.spec.ts --runInBand`

- [x] **Step 4: capability 계산과 transaction용 control 인가를 구현한다.**

  Site 잠금 순서는 기존 `assertManageInTransaction`과 동일하게 유지하고 viewer의 조직, 상태, membership, accessLevel을 모두 확인한다.

- [x] **Step 5: 접근 제어 테스트를 통과시킨다.**

- [x] **Step 6: Task 2 변경만 커밋한다.**

  Commit: `feat(api): add site control capability`

### Task 3: 현장 유저 관리 API

**Files:**
- Create: `apps/api/src/site-users/site-users.module.ts`
- Create: `apps/api/src/site-users/site-users.controller.ts`
- Create: `apps/api/src/site-users/site-users.service.ts`
- Create: `apps/api/src/site-users/site-users.service.spec.ts`
- Create: `apps/api/src/site-users/site-users.integration.spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `GET/POST/PATCH/DELETE /sites/:siteId/users`
- Produces: `POST /sites/:siteId/users/:userId/reset-password`
- Returns: `{ users: SiteUserSummary[]; count: number; limit: 100 }`
- Consumes: `SiteAccessService.assertManageInTransaction`, `PasswordService`, `AuditService`

- [x] **Step 1: controller의 SessionAuthGuard, RolesGuard, `@Roles("admin")` 계약 테스트를 작성한다.**

- [x] **Step 2: 목록과 생성 서비스 단위 테스트를 작성한다.**

  비밀번호 field 미조회, loginId 정규화, 임시 비밀번호 hash, `mustChangePassword = true`, 기본 정렬, active+disabled 100명 제한과 transaction rollback을 검증한다.

- [x] **Step 3: 수정·비활성화·재활성화·초기화·삭제 단위 테스트를 작성한다.**

  동일 현장 viewer 대상 제한, `expectedUpdatedAt` 충돌, 비활성화와 초기화의 세션 폐기, 재활성화 시 기존 비밀번호 유지, 로그인 아이디 재입력 삭제를 검증한다.

- [x] **Step 4: 실제 PostgreSQL 경쟁 조건과 영구 삭제 통합 테스트를 작성한다.**

  99명 상태에서 병렬 생성 두 건 중 정확히 한 건만 성공하는지, 삭제 후 PII가 제거되고 명령 이력이 남는지 검증한다.

- [x] **Step 5: 신규 API가 없어 테스트가 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/api exec jest src/site-users --runInBand`

- [x] **Step 6: controller, DTO parsing, service transaction과 오류 code를 구현한다.**

  삭제 감사 로그에는 삭제 대상 이름·loginId·userId를 넣지 않는다. 목록의 `lastLoginAt`은 해당 유저 Session의 가장 최근 `createdAt`으로 계산한다.

- [x] **Step 7: 유저 관리 단위·통합 테스트를 통과시킨다.**

- [x] **Step 8: Task 3 변경만 커밋한다.**

  Commit: `feat(api): add site user management`

### Task 4: 최초 로그인 비밀번호 강제 변경

**Files:**
- Create: `apps/api/src/auth/allow-password-change-pending.decorator.ts`
- Modify: `apps/api/src/auth/session-auth.guard.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.types.ts`
- Modify: `apps/api/src/auth/auth.controller.spec.ts`
- Modify: `apps/api/src/auth/auth.service.spec.ts`
- Modify: `apps/api/src/auth/auth.integration.spec.ts`
- Create: `apps/api/src/auth/session-auth.guard.spec.ts`

**Interfaces:**
- Produces: `AuthenticatedUser.mustChangePassword: boolean`
- Produces: `@AllowPasswordChangePending()` route metadata
- Changes: `POST /auth/change-password` 응답을 `{ ok: true, user: AuthenticatedUser }`로 확장

- [x] **Step 1: public user와 로그인 응답의 `mustChangePassword` 테스트를 작성한다.**

- [x] **Step 2: guard 허용 목록 테스트를 작성한다.**

  강제 변경 사용자는 `/auth/me`, `/auth/change-password`, `/auth/logout`만 통과하고 다른 보호 route는 `PASSWORD_CHANGE_REQUIRED`로 실패해야 한다.

- [x] **Step 3: 비밀번호 변경 transaction 테스트를 작성한다.**

  성공 시 flag 해제, 현재 세션 유지, 나머지 세션 폐기, 감사 로그 기록을 검증한다.

- [x] **Step 4: 테스트가 flag와 metadata 부재로 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/api exec jest src/auth --runInBand`

- [x] **Step 5: decorator, guard 검사, auth DTO와 service 변경을 구현한다.**

  비활성 사용자의 로그인 실패 메시지는 기존과 동일하게 유지해 계정 존재 여부를 노출하지 않는다.

- [x] **Step 6: auth 테스트를 통과시킨다.**

- [x] **Step 7: Task 4 변경만 커밋한다.**

  Commit: `feat(auth): require temporary password change`

### Task 5: Dashboard capability와 수동 제어 권한

**Files:**
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `apps/api/src/sites/sites.service.spec.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`

**Interfaces:**
- Produces: Dashboard top-level `capabilities: SiteCapabilities`
- Changes: 수동 밝기 명령 생성이 `assertControlInTransaction`을 사용
- Preserves: 스케줄·이벤트·구역·설치·등록·맵 편집의 admin 전용 계약

- [x] **Step 1: admin/read/control Dashboard capability 응답 테스트를 작성한다.**

- [x] **Step 2: read 사용자의 수동 명령 거절과 control 사용자의 밝기 명령 생성 성공 테스트를 작성한다.**

- [x] **Step 3: 일반 유저의 스케줄·이벤트·구역·등록·맵 편집 거절 회귀 테스트를 보강한다.**

- [x] **Step 4: 기존 viewer 일괄 차단 때문에 테스트가 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/api exec jest src/sites/sites.service.spec.ts src/commands/commands.service.spec.ts src/automation src/fixture-groups src/registration src/floor-editor --runInBand`

- [x] **Step 5: Dashboard capability와 CommandsService control 재인가를 구현한다.**

- [x] **Step 6: 관련 API 회귀 테스트를 통과시킨다.**

- [x] **Step 7: Task 5 변경만 커밋한다.**

  Commit: `feat(control): authorize site control users`

### Task 6: Web API와 권한 기반 shell

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/auth.ts`
- Modify: `apps/web/src/api/queries.ts`
- Create: `apps/web/src/api/site-users.ts`
- Create: `apps/web/src/api/site-users.test.ts`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.test.tsx`
- Modify: `apps/web/src/features/settings/settings-sections.ts`
- Modify: `apps/web/src/features/settings/settings-sections.test.ts`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/features/control/automation/ControlModeTabs.tsx`

**Interfaces:**
- Produces: `SiteUserSummary`, CRUD 함수와 React Query hooks/query key
- Changes: `apiDelete(path, body?)`
- Consumes: Dashboard `capabilities`

- [x] **Step 1: site-users API가 정확한 method, path, body를 보내고 비밀번호를 cache하지 않는 테스트를 작성한다.**

- [x] **Step 2: read/control/admin 메뉴와 route 행렬 테스트를 작성한다.**

  read는 제어 메뉴가 없고 direct route가 이동하며, control은 수동 제어만, admin은 기존 모든 제어 mode와 admin 설정을 볼 수 있어야 한다.

- [x] **Step 3: 일반 유저의 비밀번호 변경 메뉴와 admin의 유저 관리 메뉴 순서 테스트를 작성한다.**

- [x] **Step 4: 기존 role 기반 분기 때문에 테스트가 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/web exec vitest run src/api/site-users.test.ts src/features/shells/CustomerShell.test.tsx src/features/settings/settings-sections.test.ts src/features/control/ControlView.test.tsx`

- [x] **Step 5: API type·hooks와 capability 기반 shell·control 분기를 구현한다.**

  권한 조회 전에는 viewer의 제어 route를 렌더링하지 않는다. 일반 유저의 schedule/event query parameter는 `manual`로 replace한다.

- [x] **Step 6: Web 권한 단위 테스트를 통과시킨다.**

- [x] **Step 7: Task 6 변경만 커밋한다.**

  Commit: `feat(web): apply site capabilities to navigation`

### Task 7: 공통 Dialog와 유저 관리 화면

**Files:**
- Create: `apps/web/src/components/ui/ModalDialog.tsx`
- Modify: `apps/web/src/components/ui/index.ts`
- Modify: `apps/web/src/components/ui/ui-primitives.test.tsx`
- Create: `apps/web/src/features/settings/users/SiteUsersView.tsx`
- Create: `apps/web/src/features/settings/users/SiteUsersView.test.tsx`
- Create: `apps/web/src/features/settings/users/SiteUserFormDialog.tsx`
- Create: `apps/web/src/features/settings/users/ResetSiteUserPasswordDialog.tsx`
- Create: `apps/web/src/features/settings/users/DeleteSiteUserDialog.tsx`
- Create: `apps/web/src/features/settings/users/site-user-form.ts`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `/settings/users` admin 전용 화면
- Produces: 재사용 가능한 focus trap·Escape·focus restore 지원 `ModalDialog`
- Consumes: `site-users.ts` hooks와 기존 `Button`, `Card`, `PageHeader`, `StatusBadge`

- [ ] **Step 1: ModalDialog의 dialog semantics, Escape, focus trap, focus restore 테스트를 작성한다.**

- [ ] **Step 2: 목록 loading, empty, success, stale-error 상태 테스트를 작성한다.**

- [ ] **Step 3: 생성·수정 form validation과 조회/제어 segmented control 테스트를 작성한다.**

- [ ] **Step 4: 비밀번호 초기화, 비활성화, 영구 삭제 확인 테스트를 작성한다.**

  삭제 버튼은 현재 loginId와 확인 입력이 정확히 일치할 때만 활성화해야 한다.

- [ ] **Step 5: 100명 제한과 API 오류 code별 사용자 문구 테스트를 작성한다.**

- [ ] **Step 6: 화면이 없어 테스트가 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/web exec vitest run src/components/ui/ui-primitives.test.tsx src/features/settings/users`

- [ ] **Step 7: 시안에 맞춰 공통 Dialog와 유저 관리 화면을 구현한다.**

  행 동작에는 lucide 아이콘과 tooltip/접근성 이름을 사용한다. 생성 성공 후 임시 비밀번호를 toast나 cache에 재표시하지 않는다.

- [ ] **Step 8: 유저 관리 화면 테스트를 통과시킨다.**

- [ ] **Step 9: Task 7 변경만 커밋한다.**

  Commit: `feat(settings): add site user management ui`

### Task 8: Web 최초 비밀번호 변경 흐름

**Files:**
- Create: `apps/web/src/features/auth/RequiredPasswordChangeView.tsx`
- Create: `apps/web/src/features/auth/RequiredPasswordChangeView.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.test.tsx`
- Modify: `apps/web/src/api/principal-cache.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `AuthUser.mustChangePassword`, 확장된 `changePassword` 응답
- Produces: 일반 shell보다 우선하는 강제 비밀번호 변경 화면

- [ ] **Step 1: 강제 변경 사용자가 CustomerShell/OperatorShell 대신 전용 화면을 보는 App 테스트를 작성한다.**

- [ ] **Step 2: 현재·새·확인 비밀번호 validation, 성공, 실패, 로그아웃 테스트를 작성한다.**

- [ ] **Step 3: 일반 사용자에게 설정 비밀번호 변경 route가 열리는 회귀 테스트를 작성한다.**

- [ ] **Step 4: 전용 화면이 없어 테스트가 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/web exec vitest run src/App.test.tsx src/features/auth/RequiredPasswordChangeView.test.tsx src/features/settings/security/PasswordSettingsView.test.tsx`

- [ ] **Step 5: 강제 변경 화면과 인증 cache 원자 갱신을 구현한다.**

  성공 응답의 user로 principal cache를 교체하고 `/monitoring`으로 진입한다. 실패 시 비밀번호 값을 지우고 사용자가 다시 시도할 수 있게 한다.

- [ ] **Step 6: 인증 UI 테스트를 통과시킨다.**

- [ ] **Step 7: Task 8 변경만 커밋한다.**

  Commit: `feat(auth): add required password change ui`

### Task 9: 브라우저 E2E와 문서 정합성

**Files:**
- Create: `apps/web/e2e/site-user-management.spec.ts`
- Create: `apps/web/e2e/site-user-management-real.spec.ts`
- Modify: `apps/web/package.json`
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md`

**Interfaces:**
- Produces: mock API UI E2E와 실제 PostgreSQL/API 인증 E2E
- Produces: `pnpm --filter @led-control/web e2e:site-users:real`

- [ ] **Step 1: admin 목록·생성·수정·비활성화·재활성화·초기화·삭제 브라우저 E2E를 작성한다.**

- [ ] **Step 2: 신규 일반 유저 최초 로그인과 강제 비밀번호 변경 E2E를 작성한다.**

- [ ] **Step 3: read/control/admin 권한별 메뉴, direct route, 수동 제어 API E2E를 작성한다.**

- [ ] **Step 4: 비활성화된 브라우저 세션의 다음 요청 차단과 재로그인 실패 E2E를 작성한다.**

- [ ] **Step 5: 구현 전 또는 누락 상태에서 E2E가 실패하는지 확인한다.**

  Run: `pnpm --filter @led-control/web exec playwright test e2e/site-user-management.spec.ts --project=chromium`

- [ ] **Step 6: mock E2E와 실제 backend E2E를 통과시킨다.**

  Run: `pnpm --filter @led-control/web exec playwright test e2e/site-user-management.spec.ts --project=chromium`

  Run: `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/site-user-management-real.spec.ts --project=chromium`

- [ ] **Step 7: 메뉴·DB·프로젝트 현황 문서를 실제 구현 상태로 갱신한다.**

  `lesson_leared.md`에는 역할과 capability를 분리하고 write transaction에서 재인가해야 한다는 반복 가능한 교훈을 기록한다.

- [ ] **Step 8: 전체 API/Web 검증을 실행한다.**

  Run: `pnpm --filter @led-control/api test -- --runInBand`

  Run: `pnpm --filter @led-control/web test`

  Run: `pnpm --filter @led-control/web typecheck`

  Run: `pnpm --filter @led-control/web build`

- [ ] **Step 9: diff와 설계서를 대조한다.**

  Run: `git diff --check`

  비밀번호 노출, admin 전용 기능 권한 완화, 관련 없는 dirty 파일 수정, 문서 누락이 없는지 확인한다.

- [ ] **Step 10: Task 9 변경만 커밋한다.**

  Commit: `test: cover site user management journey`
