# 전역 운영자와 현장 관리자 계정 흐름 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전역 단일 operator가 현장별 단일 admin 계정을 관리하고, admin이 로그인 아이디로 접속해 최초 설치부터 관제 운영까지 수행하도록 인증·권한·웹 흐름을 전환한다.

**Architecture:** `User.loginId`와 `Site.adminUserId`를 정본으로 삼고 operator와 고객 역할의 API·웹 shell을 분리한다. operator는 고객 현장 API를 사용하지 않고 전용 계정 관리 모듈만 사용하며, admin은 자기에게 직접 연결된 한 현장에서 `read/manage/commission` 권한을 갖는다. DB와 인증 계약을 먼저 적용한 뒤 설치·장비 권한, 웹 UI, 실백엔드 E2E 순서로 소비자를 전환한다.

**Tech Stack:** NestJS, TypeScript, Prisma, PostgreSQL, React, React Query, React Router, Vitest, Jest, Playwright

**Spec:** `docs/superpowers/specs/2026-08-26-operator-admin-account-flow-design.md`

## Global Constraints

- 재설치 기능과 모바일 변경은 이번 범위에 포함하지 않는다.
- 서비스 전체의 활성 operator는 한 명, 현장별 활성 admin은 한 명, admin 계정별 현장은 한 곳이다.
- 로그인 식별자는 대소문자를 구분하지 않는 `loginId`이며 이메일 형식을 요구하지 않는다.
- 평문 비밀번호와 비밀번호 hash는 조회 응답·로그·감사 metadata에 포함하지 않는다.
- admin은 자기 현장의 최초 설치, Gateway claim, 조명 등록, 모니터링, 제어, 통계, 맵 편집과 본인 비밀번호 변경을 수행한다.
- operator 웹에는 현장별 admin 계정 관리만 표시하고 고객 현장 API를 호출하지 않는다.
- viewer의 여러 계정과 현장별 읽기 전용 권한은 유지하되 신규 viewer 관리 UI는 만들지 않는다.
- DB schema 변경은 `docs/database-schema.md`, 메뉴 변경은 영향받는 `docs/menus/*.md`, 진행 상태는 `docs/project-status.md`를 같은 작업에서 갱신한다.
- software E2E와 Raspberry Pi/ESP32-H2 HIL 결과를 구분한다.

---

## 파일 구조

### Backend

- `apps/api/prisma/schema.prisma`: loginId, nullable 설치 전 현장 정보, Site-admin 일대일 관계
- `apps/api/prisma/migrations/20260827090000_operator_admin_account_flow/migration.sql`: 사전 검증, backfill, unique/FK/check 제약
- `apps/api/src/auth/password.service.ts`: 비밀번호 hash와 검증의 공용 경계
- `apps/api/src/operator-site-admins/`: operator 전용 현장/admin CRUD 모듈
- `apps/api/src/access/site-access.service.ts`: admin 직접 연결, viewer membership, operator 현장 차단
- `apps/api/src/setup/`: 설치 대기 현장을 admin이 완성하는 계약
- `apps/api/src/gateway-onboarding/`, `apps/api/src/registration/`: admin commissioning 권한

### Web

- `apps/web/src/features/shells/CustomerShell.tsx`: admin/viewer 고객 관제 shell
- `apps/web/src/features/operator/OperatorShell.tsx`: operator 전용 shell
- `apps/web/src/features/operator/site-admins/`: 현장별 admin 계정 관리 화면과 대화상자
- `apps/web/src/features/settings/security/PasswordSettingsView.tsx`: admin 본인 비밀번호 변경
- `apps/web/src/features/setup/SetupWizard.tsx`: 배정된 설치 대기 현장을 완성하는 admin wizard
- `apps/web/src/api/operator-site-admins.ts`: operator CRUD client

---

### Task 1: DB 정본과 안전한 migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260827090000_operator_admin_account_flow/migration.sql`
- Create: `apps/api/src/prisma/operator-admin-migration.integration.spec.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: 호환 확장 단계의 `User.loginId: string | null`, 기존 `User.email: string`, `Site.adminUserId: string | null`
- Produces: `Site.admin`/`User.administeredSite` 일대일 Prisma relation

- [x] **Step 1: migration 실패 조건을 통합 테스트로 작성**

```ts
it("rejects normalized login id collisions before enforcing uniqueness", async () => {
  await seedLegacyUsers(["Admin@Example.com", " admin@example.com "]);
  await expect(applyOperatorAdminMigration()).rejects.toThrow(/loginId collision/);
});

it("backfills only an unambiguous one-admin one-site customer", async () => {
  const { adminId, siteId } = await seedLegacyCustomer({ admins: 1, sites: 1 });
  await applyOperatorAdminMigration();
  expect(await readSiteAdminId(siteId)).toBe(adminId);
});
```

- [x] **Step 2: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/prisma/operator-admin-migration.integration.spec.ts --runInBand`
Expected: 새 migration과 relation이 없어 실패

- [x] **Step 3: schema와 migration 구현**

```prisma
model User {
  loginId          String? @unique
  email            String  @unique
  administeredSite Site?  @relation("SiteAdmin")
}

model Site {
  adminUserId       String? @unique
  admin             User?   @relation("SiteAdmin", fields: [adminUserId], references: [id], onDelete: Restrict)
}
```

Migration은 다음 순서를 한 파일에서 보장한다: nullable column 추가 → `lower(trim(email))` backfill → 허용 문자·길이·정규화 충돌·operator 중복·admin/현장 모호성 검사 → 명확한 customer의 admin 연결 → nullable loginId unique/check → `Site.adminUserId` unique/FK와 같은 customer의 active admin만 허용하는 trigger. 모호성이 있으면 PostgreSQL `RAISE EXCEPTION`으로 중단한다. `loginId NOT NULL`, email nullable, Site 설치 필드 nullable 전환은 소비자 코드와 각각 같은 Task 2·3 commit에서 수행한다.

- [x] **Step 4: Prisma 및 migration 검증**

Run: `pnpm --filter @led-control/api exec prisma validate && pnpm --filter @led-control/api prisma:generate`
Expected: PASS

Run: `pnpm --filter @led-control/api exec jest src/prisma/operator-admin-migration.integration.spec.ts --runInBand`
Expected: PASS 또는 테스트 DB 환경 미설정 시 명시적 skip

- [x] **Step 5: DB 문서와 상태판 갱신 후 커밋**

- [x] **Review fix round 1: expand-only DB 계약과 assignment invariant 보정**

`loginId`/`adminUserId`만 nullable 확장으로 유지하고 기존 `email`, `address`, `tariffKwhRate`의 required 계약은 보존했다. migration은 모든 `operator` 행의 중복을 막고, 같은 customer Organization의 active admin만 `Site.adminUserId`에 연결하도록 trigger를 추가했다. rehearsal은 전용 URL이 제공될 때 ambiguous legacy data rollback, role/tenant assignment 거부, duplicate operator/loginId/assignment를 검증한다.

- [x] **Review fix round 2: 배정 후 관계 불변식 보정**

`User.role`/`status`/`organizationId` 변경과 `Organization.type` 변경도 이미 연결된 `Site.adminUserId`의 active same-customer admin 불변식을 깨면 PostgreSQL trigger가 거부한다. Site를 먼저 unassign한 뒤 admin을 disabled로 바꾸는 정상 순서는 유지한다. rehearsal은 post-migration loginId check, operator unique, Site FK와 세 trigger를 함께 검증한다.

- [x] **Review fix round 3: row-lock 기반 관계 검증 보정**

세 trigger는 관계 행을 잠근 뒤 변경 후 상태를 검증한다. 명시 잠금은 가능한 범위에서 `Site -> User -> Organization` 순서를 따르며, 현재 UPDATE 대상 행은 PostgreSQL이 trigger 전에 잠근다. rehearsal은 같은 `loginId`의 두 번째 INSERT와 기존 loginId 중복 UPDATE가 unique index로 거부되는 계약을 추가한다.

- [x] **Review fix round 4: statement-level 직렬화 보정**

Site/User/Organization 관련 DML은 target row lock 전에 동일한 transaction advisory lock을 얻는다. 기존 row trigger의 관계 검증은 유지하면서 역순 target-row 잠금으로 인한 `40P01`을 방지한다.

- [x] **Review fix round 5: deadlock 회귀 fixture 보정**

배정된 Site의 relevant no-op UPDATE와 User disable/Organization type 변경을 독립 session에서 겹쳐 Round 3 SQL의 실제 deadlock을 재현했다. 현재 SQL은 두 경합 모두 deadlock 없이 무효 변경만 거부하고 최종 불변식을 유지한다. 격리 PostgreSQL 16에서 정적 4건과 rehearsal 17건을 모두 통과했다.

```bash
git add apps/api/prisma apps/api/src/prisma/operator-admin-migration.integration.spec.ts docs/database-schema.md docs/project-status.md docs/superpowers/plans/2026-08-27-operator-admin-account-flow.md
git commit -m "feat(db): add site admin account ownership"
```

### Task 2: loginId 인증과 비밀번호 공용 경계

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260827100000_login_id_contract/migration.sql`
- Create: `apps/api/src/auth/password.service.ts`
- Create: `apps/api/src/auth/password.service.spec.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.types.ts`
- Modify: `apps/api/src/auth/auth.module.ts`
- Modify: `apps/api/src/auth/bootstrap-operator.ts`
- Modify: `apps/api/prisma/bootstrap-operator.ts`
- Modify: `apps/api/src/auth/auth.service.spec.ts`
- Modify: `apps/api/src/auth/auth.integration.spec.ts`
- Modify: `apps/api/src/auth/bootstrap-operator.spec.ts`

**Interfaces:**
- Produces: `normalizeLoginId(value: string): string`
- Produces: `PasswordService.hash(password)`, `PasswordService.verify(password, hash)`
- Produces: `POST /auth/login { loginId, password, rememberMe }`
- Produces: `POST /auth/change-password { currentPassword, newPassword, newPasswordConfirmation }`
- Produces: `AuthenticatedUser.loginId`
- Produces: 최종 `User.loginId: string`, `User.email: string | null` Prisma/DB 계약

- [x] **Step 1: loginId와 비밀번호 변경 RED 테스트 작성**

```ts
it("logs in with a normalized login id", async () => {
  await service.login({ loginId: " ADMIN_01 ", password, rememberMe: false });
  expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { loginId: "admin_01" } }));
});

it("changes an admin password and revokes every other session", async () => {
  await service.changePassword(admin, currentToken, {
    currentPassword: oldPassword,
    newPassword,
    newPasswordConfirmation: newPassword
  });
  expect(await canAuthenticate(oldPassword)).toBe(false);
  expect(await currentSessionIsActive()).toBe(true);
  expect(await otherSessionsAreRevoked()).toBe(true);
});
```

- [x] **Step 2: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/auth --runInBand`
Expected: loginId 및 change-password 미구현으로 실패

- [x] **Step 3: 최소 인증 구현**

```ts
export function normalizeLoginId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9._@-]{4,100}$/.test(normalized)) throw new BadRequestException("Invalid login id");
  return normalized;
}
```

`AuthService.signup`은 operator/admin invitation을 거부하고 viewer 호환 가입에서 `loginId = normalizeLoginId(input.loginId)`를 저장한다. `changePassword`는 현재 cookie token hash를 제외한 대상 user의 활성 Session을 transaction에서 revoke하고 `auth.password_changed` 감사를 기록한다.

- [x] **Step 4: bootstrap 계약 전환**

`BOOTSTRAP_OPERATOR_EMAIL` 대신 `BOOTSTRAP_OPERATOR_LOGIN_ID`를 필수로 받고 반환값도 `{ organizationId, userId, loginId }`로 바꾼다. operator partial unique 위반은 기존과 같은 bootstrap 거부 오류로 정규화한다.

- [x] **Step 5: loginId contract migration 구현**

dual-write 인증 코드가 준비된 뒤 contract migration은 `loginId IS NULL AND email IS NOT NULL` 행을 다시 `lower(btrim(email))`으로 backfill하고 형식·충돌·NULL guard를 실행한 다음 `loginId NOT NULL`을 적용한다. Prisma schema는 `loginId String @unique`, `email String? @unique`로 전환한다. 배포 runbook은 Task 1 expand migration 적용 → 이 Task의 dual-write API 배포 → contract migration 적용 순서를 기록한다.

- [x] **Step 6: GREEN 및 회귀 확인**

Run: `pnpm --filter @led-control/api exec jest src/auth --runInBand && pnpm --filter @led-control/api typecheck`
Expected: PASS

- [x] **Step 7: 문서 갱신 후 커밋**

```bash
git add apps/api/src/auth apps/api/prisma/schema.prisma apps/api/prisma/bootstrap-operator.ts apps/api/prisma/migrations/20260827100000_login_id_contract docs/database-schema.md docs/menus/settings.md docs/project-status.md
git commit -m "feat(auth): switch authentication to login ids"
```

### Task 3: Operator 현장 admin 관리 API

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260827110000_pending_site_contract/migration.sql`
- Create: `apps/api/src/operator-site-admins/operator-site-admins.module.ts`
- Create: `apps/api/src/operator-site-admins/operator-site-admins.controller.ts`
- Create: `apps/api/src/operator-site-admins/operator-site-admins.service.ts`
- Create: `apps/api/src/operator-site-admins/operator-site-admins.service.spec.ts`
- Create: `apps/api/src/operator-site-admins/operator-site-admins.integration.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/audit/audit.service.ts`
- Modify: `apps/api/src/audit/audit.service.spec.ts`
- Modify: `apps/api/src/energy/energy.service.ts`
- Modify: `apps/api/src/energy/energy.service.spec.ts`

**Interfaces:**
- Produces: `SiteAdminSummary { siteId, customerName, siteName, installationStatus, admin: { id, loginId, name, status, updatedAt } | null }`
- Produces: 설계서의 operator 전용 6개 endpoint
- Consumes: `PasswordService`, `normalizeLoginId`, `AuditService`
- Produces: `Site.address: string | null`, `Site.tariffKwhRate: Decimal | null`과 pending site 비용 산출 불가 처리

- [ ] **Step 1: CRUD·격리·민감정보 RED 테스트 작성**

```ts
it("creates a customer, pending site and single admin atomically", async () => {
  const result = await service.createSiteAdmin(operator, input);
  expect(result.admin).toMatchObject({ loginId: "customer_admin", status: "active" });
  expect(JSON.stringify(result)).not.toMatch(/password|passwordHash/);
});

it("disables an admin, revokes sessions and leaves the site unassigned", async () => {
  await service.disable(operator, adminId);
  expect(await readUserStatus(adminId)).toBe("disabled");
  expect(await readSiteAdminId(siteId)).toBeNull();
  expect(await activeSessionCount(adminId)).toBe(0);
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/operator-site-admins --runInBand`
Expected: module 미존재로 실패

- [ ] **Step 3: controller/service 구현**

pending-site migration이 `address`와 `tariffKwhRate`의 NOT NULL을 제거하고 Prisma schema를 nullable로 전환한다. energy service는 null 단가를 비용 산출 불가 상태로 안전하게 처리한다. 모든 route에 `SessionAuthGuard`, `RolesGuard`, `@Roles("operator")`를 적용하고 service에서도 `organizationType === "service_provider"`를 재검증한다. create/update/reset/disable은 Serializable transaction과 감사 로그를 함께 사용하고 P2002는 loginId conflict로 변환한다.

- [ ] **Step 4: 감사 metadata 민감 키 검사 강화**

`password`, `passwordHash`, `currentPassword`, `newPassword`, `privateKey`, `claimCode`, `certificatePem`을 대소문자와 중첩 위치에 관계없이 거부한다.

- [ ] **Step 5: GREEN 및 integration 확인**

Run: `pnpm --filter @led-control/api exec jest src/operator-site-admins src/audit --runInBand`
Expected: PASS

- [ ] **Step 6: 문서 갱신 후 커밋**

```bash
git add apps/api/prisma apps/api/src/operator-site-admins apps/api/src/audit apps/api/src/energy apps/api/src/app.module.ts docs/database-schema.md docs/menus/settings.md docs/project-status.md
git commit -m "feat(api): add operator site admin management"
```

### Task 4: 현장 접근과 admin 최초 설치 계약

**Files:**
- Modify: `apps/api/src/access/site-access.service.ts`
- Modify: `apps/api/src/access/site-access.service.spec.ts`
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `apps/api/src/sites/sites.service.spec.ts`
- Modify: `apps/api/src/setup/setup.controller.ts`
- Modify: `apps/api/src/setup/setup.service.ts`
- Modify: `apps/api/src/setup/setup.controller.spec.ts`
- Modify: `apps/api/src/setup/setup.service.spec.ts`

**Interfaces:**
- Produces: admin에게 직접 연결된 현장의 `read/manage/commission`
- Produces: viewer membership의 `read` 전용, operator의 고객 현장 capability 없음
- Produces: `POST /setup/initial-site { siteId, address, tariffKwhRate, timeZone?, floors }`
- Produces: dashboard `site.installationStatus`, `customerName`, `address`, `tariffKwhRate`, `timeZone`
- Consumes: Task 3의 `Site.address: string | null`, `Site.tariffKwhRate: Decimal | null` Prisma/DB 계약

- [ ] **Step 1: 권한 RED 테스트 작성**

```ts
it("grants commission only to the site's assigned admin", async () => {
  await expect(access.assert(assignedAdmin, siteId, "commission")).resolves.toBeDefined();
  await expect(access.assert(otherAdmin, siteId, "read")).rejects.toThrow("site not found");
  await expect(access.assert(operator, siteId, "read")).rejects.toThrow("site not found");
});
```

- [ ] **Step 2: 설치 RED 테스트 작성**

```ts
it("completes the assigned pending site without creating another organization or site", async () => {
  await service.completeInitialSite(admin, { siteId, address, tariffKwhRate: 160, floors });
  expect(prisma.organization.create).not.toHaveBeenCalled();
  expect(prisma.site.create).not.toHaveBeenCalled();
  expect(await floorCount(siteId)).toBe(1);
});
```

- [ ] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/access src/sites src/setup --runInBand`
Expected: 기존 operator 중심 기대와 충돌해 실패

- [ ] **Step 4: 접근·dashboard·setup 구현**

`installationStatus`는 DB enum이 아니라 `address !== null && tariffKwhRate !== null && floors.length > 0`에서 `pending|installed`로 계산한다. setup은 assigned admin과 pending 상태를 잠근 뒤 site update와 floor create를 Serializable transaction으로 수행하고 재호출은 Conflict로 거부한다.

- [ ] **Step 5: GREEN 확인 및 커밋**

Run: `pnpm --filter @led-control/api exec jest src/access src/sites src/setup --runInBand && pnpm --filter @led-control/api typecheck`
Expected: PASS

```bash
git add apps/api/src/access apps/api/src/sites apps/api/src/setup docs/menus/monitoring.md docs/menus/settings.md docs/project-status.md
git commit -m "feat(api): move initial site setup to assigned admin"
```

### Task 5: Gateway claim과 조명 등록 commissioning 이전

**Files:**
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.controller.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.controller.spec.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.spec.ts`
- Modify: `apps/api/src/registration/registration.controller.ts`
- Modify: `apps/api/src/registration/registration.service.ts`
- Modify: `apps/api/src/registration/registration.controller.spec.ts`
- Modify: `apps/api/src/registration/registration.service.spec.ts`

**Interfaces:**
- Consumes: `SiteAccessService.assert(admin, siteId, "commission")`
- Produces: assigned admin의 claim/scan/identify/register/complete
- Preserves: `gateway-inventories/:inventoryId/disable`은 제조 보안 동작으로 operator 전용

- [ ] **Step 1: controller와 service RED 테스트 작성**

```ts
it("allows the assigned admin to claim and rejects the global operator", async () => {
  await expect(service.claimGateway(admin, claim)).resolves.toMatchObject({ status: "claimed" });
  await expect(service.claimGateway(operator, claim)).rejects.toThrow();
});

it("requires admin commission for every registration operation", async () => {
  expect(Reflect.getMetadata(rolesMetadataKey, RegistrationController)).toEqual(["admin"]);
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/gateway-onboarding src/registration --runInBand`
Expected: 기존 operator role 때문에 실패

- [ ] **Step 3: controller/service 이중 권한 검사 전환**

claim과 registration controller는 `@Roles("admin")`을 사용하고 service의 `assertServiceProviderOperator`를 제거해 대상 site의 commission capability를 확인한다. inventory disable과 제조 enrollment는 operator/internal 경계를 유지한다.

- [ ] **Step 4: GREEN 확인 및 커밋**

Run: `pnpm --filter @led-control/api exec jest src/gateway-onboarding src/registration --runInBand && pnpm --filter @led-control/api typecheck`
Expected: PASS

```bash
git add apps/api/src/gateway-onboarding apps/api/src/registration docs/menus/monitoring.md docs/menus/settings.md docs/project-status.md
git commit -m "feat(api): grant commissioning to site admins"
```

### Task 6: loginId 로그인과 역할별 웹 shell

**Files:**
- Modify: `apps/web/src/api/auth.ts`
- Modify: `apps/web/src/features/auth/AuthView.tsx`
- Create: `apps/web/src/features/shells/CustomerShell.tsx`
- Create: `apps/web/src/features/operator/OperatorShell.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `AuthUser.loginId`, loginId login endpoint
- Produces: operator는 `/operator/site-admins`, admin/viewer는 고객 shell

- [ ] **Step 1: 로그인·route RED 테스트 작성**

```tsx
it("submits loginId and never renders public signup", async () => {
  render(<App />);
  expect(screen.queryByText(/회원 가입|초대 코드/)).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("아이디"), "admin_01");
  await user.type(screen.getByLabelText("비밀번호"), "password-1234");
  await user.click(screen.getByRole("button", { name: "로그인" }));
  expect(login).toHaveBeenCalledWith(expect.objectContaining({ loginId: "admin_01" }));
});

it("does not request sites or dashboard for an operator", async () => {
  renderAuthenticatedApp(operator, "/monitoring");
  expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
  expect(fetchDashboard).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/App.test.tsx`
Expected: signup UI와 공용 shell 때문에 실패

- [ ] **Step 3: 인증 화면과 shell 분리 구현**

`AppContent`에서 인증 후 role을 먼저 분기한다. `OperatorShell`은 dashboard/site query를 import하지 않고 전용 route 외 모든 경로를 replace한다. 기존 고객 shell 로직은 `CustomerShell`로 이동해 기능을 보존한다.

- [ ] **Step 4: GREEN 확인 및 커밋**

Run: `pnpm --filter @led-control/web exec vitest run src/App.test.tsx && pnpm --filter @led-control/web typecheck`
Expected: PASS

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/api/auth.ts apps/web/src/features/auth apps/web/src/features/shells apps/web/src/features/operator/OperatorShell.tsx docs/menus/settings.md docs/project-status.md
git commit -m "feat(web): separate operator and customer shells"
```

### Task 7: Operator 현장 admin 관리 화면

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/api/operator-site-admins.ts`
- Create: `apps/web/src/components/ConfirmDialog.tsx`
- Create: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`
- Create: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.test.tsx`
- Create: `apps/web/src/features/operator/site-admins/SiteAdminFormDialog.tsx`
- Create: `apps/web/src/features/operator/site-admins/ResetAdminPasswordDialog.tsx`
- Create: `apps/web/src/features/operator/site-admins/DisableSiteAdminDialog.tsx`
- Modify: `apps/web/src/features/operator/OperatorShell.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 3의 `SiteAdminSummary`와 6개 endpoint
- Produces: 목록, 신규 현장/admin 생성, 관리자 미지정 현장 admin 생성, 이름/loginId 수정, 비밀번호 재설정, 비활성화

- [ ] **Step 1: 사용자 흐름 RED 테스트 작성**

```tsx
it("creates an admin and never displays a stored password", async () => {
  renderView();
  await user.click(screen.getByRole("button", { name: "관리자 계정 생성" }));
  await fillSiteAdminForm(validInput);
  await user.click(screen.getByRole("button", { name: "생성" }));
  expect(await screen.findByText("customer_admin")).toBeVisible();
  expect(screen.queryByText(validInput.password)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/operator/site-admins/SiteAdminManagementView.test.tsx`
Expected: 파일 미존재로 실패

- [ ] **Step 3: API client와 화면 구현**

React Query key는 `["operator", "site-admins"]`로 고정한다. mutation 중 버튼을 비활성화하고 성공 시 목록 invalidate, 409는 loginId 필드 오류, 그 외 오류는 화면 alert로 표시한다. 비밀번호 재설정과 비활성화에는 공통 `ConfirmDialog`를 사용한다.

- [ ] **Step 4: GREEN·접근성 확인 및 커밋**

Run: `pnpm --filter @led-control/web exec vitest run src/features/operator/site-admins/SiteAdminManagementView.test.tsx && pnpm --filter @led-control/web typecheck`
Expected: PASS

```bash
git add apps/web/src/api apps/web/src/components apps/web/src/features/operator apps/web/src/styles.css docs/menus/settings.md docs/project-status.md
git commit -m "feat(web): add site admin account management"
```

### Task 8: Admin 설치·맵·비밀번호 설정 UI

**Files:**
- Modify: `apps/web/src/api/setup.ts`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx`
- Modify: `apps/web/src/features/settings/SettingsView.tsx`
- Modify: `apps/web/src/features/settings/settings-sections.ts`
- Modify: `apps/web/src/features/settings/settings-sections.test.ts`
- Create: `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- Create: `apps/web/src/features/settings/security/PasswordSettingsView.test.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: dashboard 설치 상태, admin setup endpoint, change-password endpoint
- Produces: admin 설정 메뉴 `설정 개요`, `도면 관리`, `비밀번호 변경`
- Produces: 설치 대기 admin이 고객 route에 진입하면 `/settings?siteId=...`로 이동하는 route guard

- [ ] **Step 1: admin setup RED 테스트 작성**

```tsx
it("completes the assigned pending site without customer or site name inputs", async () => {
  renderWizard({ siteId: "site-1", customerName: "고객사", siteName: "주차장" });
  expect(screen.queryByLabelText("고객사명")).not.toBeInTheDocument();
  await fillInstallationFields();
  await user.click(screen.getByRole("button", { name: "초기 설정 완료" }));
  expect(createInitialSiteSetup).toHaveBeenCalledWith(expect.objectContaining({ siteId: "site-1" }));
});

it("redirects a pending admin from monitoring to initial settings", async () => {
  renderAuthenticatedApp(pendingAdmin, "/monitoring?siteId=site-1");
  expect(await screen.findByRole("heading", { name: "초기 설치 설정" })).toBeVisible();
  expect(window.location.pathname).toBe("/settings");
});
```

- [ ] **Step 2: 비밀번호 변경 RED 테스트 작성**

현재 비밀번호 오류, 확인값 불일치, 8자 미만, 중복 제출 차단, 성공 후 입력 초기화와 안내를 각각 독립 테스트로 작성한다.

- [ ] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/setup/SetupWizard.test.tsx src/features/settings/security/PasswordSettingsView.test.tsx src/features/settings/settings-sections.test.ts`
Expected: 새 계약과 화면 미구현으로 실패

- [ ] **Step 4: 설치 상태 분기와 설정 구현**

pending admin은 어떤 고객 route로 진입해도 query의 `siteId`를 유지하며 설정 개요로 replace 이동하고 SetupWizard를 수행한다. 설치 완료 후 Gateway claim/RegistrationPanel을 admin에게 표시한다. operator는 floor plan/editor route를 사용할 수 없고 admin은 기존 lease·atomic save 흐름을 유지한다. viewer의 도면 목록 read-only는 유지한다.

- [ ] **Step 5: GREEN 및 회귀 확인**

Run: `pnpm --filter @led-control/web test && pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/web build`
Expected: PASS

- [ ] **Step 6: 메뉴 문서 갱신 후 커밋**

```bash
git add apps/web/src docs/menus/monitoring.md docs/menus/control.md docs/menus/settings.md docs/project-status.md
git commit -m "feat(web): let admins install sites and manage passwords"
```

### Task 9: 실백엔드 E2E, 전체 회귀와 최종 문서

**Files:**
- Modify: `apps/web/e2e/auth-real.spec.ts`
- Modify: `apps/web/e2e/installation-customer-journey.spec.ts`
- Modify: `apps/web/e2e/support/real-backend-lab.ts`
- Modify: `apps/web/e2e/floor-editor-layout.spec.ts`
- Modify: `apps/web/e2e/monitoring-control-flow.spec.ts`
- Modify: `apps/web/e2e/mvp1.spec.ts`
- Modify: `apps/web/e2e/settings-floor-editor.spec.ts`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `docs/project-status.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/runbooks/device-lab-first-install.md`

**Interfaces:**
- Validates: operator 계정 발급 → admin 설치 → 장비 등록 → 관제 → 비밀번호 변경

- [ ] **Step 1: 실백엔드 journey를 새 흐름으로 변경**

```text
operator loginId 로그인
→ 현장/admin 생성
→ operator 고객 route 차단 확인
→ admin 로그인
→ 주소·단가·시간대·층 설정
→ Gateway claim
→ 0건 검색과 재검색
→ 조명 2개 등록
→ 모니터링·제어·통계
→ 맵 저장과 모니터링 반영
→ 비밀번호 변경
→ 이전 비밀번호 실패와 새 비밀번호 재로그인
→ viewer 읽기 전용 회귀
```

viewer는 공개 signup UI를 사용하지 않고 격리 DB support에서 loginId·membership을 직접 준비한다. 이 fixture는 production bundle에 포함하지 않는다.

- [ ] **Step 2: 브라우저 RED 확인**

Run: `pnpm --filter @led-control/web e2e:journey:real`
Expected: 기존 operator 설치 UI가 없어 새 assertion이 실패한 뒤 구현 완료 시 PASS

- [ ] **Step 3: 전체 자동 검증**

Run: `pnpm typecheck`
Expected: PASS

Run: `pnpm lint`
Expected: PASS

Run: `pnpm test`
Expected: PASS

Run: `pnpm --filter @led-control/web exec playwright test --project=chromium`
Expected: PASS, 환경 조건부 HIL/real-auth test만 명시적 skip

Run: `pnpm --filter @led-control/web e2e:journey:real`
Expected: PASS

- [ ] **Step 4: 실제 브라우저 수동 QA**

개발 서버를 실행하고 operator/admin/viewer 역할로 deep link, 새로고침, CRUD 확인창, 설치 wizard, 맵 편집, 비밀번호 변경과 재로그인을 확인한다. Network에서 operator shell이 `/sites`와 `/dashboard`를 호출하지 않고 admin CRUD 응답에 password 계열 필드가 없는지 확인한다.

- [ ] **Step 5: 문서와 상태판을 실제 검증 결과로 확정**

완료한 소프트웨어 기능과 남은 Raspberry Pi/ESP32-H2 HIL을 구분해 기록한다. 계획 체크박스와 `docs/project-status.md` 상태를 일치시킨다.

- [ ] **Step 6: 최종 커밋**

```bash
git add apps/web/e2e docs
git commit -m "test(e2e): verify admin-led site installation"
```
