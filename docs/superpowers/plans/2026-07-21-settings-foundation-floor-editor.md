# 설정 권한 기반 및 도면 에디터 이동 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `operator/admin/viewer` 3단계 권한과 현장 접근 범위를 양산 기준으로 적용하고, 도면 에디터를 모니터링에서 설정으로 옮겨 원자 저장·버전 복구·동시 편집 방지를 제공한다.

**Architecture:** 서비스 운영사 operator는 `SiteMembership`으로 배정된 고객 현장만 접근하고, 고객사 admin은 자기 Organization의 현장을 관리하며 viewer는 배정 현장을 조회한다. API의 기존 `organizationId` 직접 비교를 공통 `SiteAccessService`로 교체하고, 도면 편집은 단일 transaction API와 `Floor.mapRevision`으로 저장한다. Redis lease는 편집 충돌 가능성을 낮추고 PostgreSQL revision 검사는 최종 덮어쓰기를 차단한다.

**Tech Stack:** React 18, React Router, React Query, Zustand, TypeScript, NestJS, Prisma, PostgreSQL, Redis/ioredis, Konva, Vitest, Jest, Playwright

## Global Constraints

- 사용자 역할은 `operator`, `admin`, `viewer` 세 개만 사용한다.
- operator는 서비스 운영사 소속이며 SiteMembership으로 배정된 고객 현장만 접근한다.
- admin은 자기 고객사 Organization의 모든 현장을 관리하고 viewer는 SiteMembership 현장만 조회한다.
- 최초 현장 생성, Gateway claim, BLE Mesh provisioning은 operator만 수행한다.
- 설치 후 도면, 조명 표시 정보, 그룹과 운영 정책은 operator와 admin이 수정한다.
- viewer는 설정과 도면을 조회만 하며 조명 제어와 모든 설정 변경을 할 수 없다.
- 모니터링 도면은 읽기 전용이고 도면 편집은 설정 경로에서만 제공한다.
- 도면 저장은 단일 PostgreSQL transaction이며 revision 불일치 시 `409 Conflict`를 반환한다.
- DB schema 변경 커밋은 `docs/database-schema.md`를, 메뉴 변경 커밋은 관련 `docs/menus/*.md`를 함께 갱신한다.
- 실물 Raspberry Pi와 ESP32-H2 증거 없이 Hardware E2E 또는 양산 검증 완료로 표시하지 않는다.

---

## 파일 구조

### 새 파일

- `apps/api/src/access/access.module.ts`: 역할 Guard와 현장 접근 서비스를 export한다.
- `apps/api/src/access/roles.decorator.ts`: controller role metadata를 선언한다.
- `apps/api/src/access/roles.guard.ts`: `operator/admin/viewer` endpoint 역할을 검사한다.
- `apps/api/src/access/site-access.service.ts`: 역할별 site read/manage/commission 권한을 판정한다.
- `apps/api/src/access/*.spec.ts`: 권한 행렬과 교차 고객사 접근 차단을 검증한다.
- `apps/api/src/audit/audit.module.ts`: 설정 변경 감사 기록 기능을 export한다.
- `apps/api/src/audit/audit.service.ts`: 민감값을 제외한 actor, site, action과 결과를 기록한다.
- `apps/api/src/redis/redis.module.ts`: 단일 ioredis client를 생성하고 종료 lifecycle을 관리한다.
- `apps/api/src/redis/redis.provider.ts`: `REDIS_CLIENT` injection token과 provider를 제공한다.
- `apps/api/src/floor-editor/editor-lease.service.ts`: Redis 기반 층 편집 lease를 관리한다.
- `apps/api/src/floor-editor/editor-lease.service.spec.ts`: lease 생성·갱신·충돌·만료·강제 해제를 검증한다.
- `apps/web/src/features/settings/SettingsShell.tsx`: 설정 하위 navigation과 outlet을 제공한다.
- `apps/web/src/features/settings/settings-sections.ts`: 역할별 설정 메뉴 정의를 제공한다.
- `apps/web/src/features/sites/SiteSwitcher.tsx`: 접근 가능한 고객 현장을 선택하고 URL의 siteId를 갱신한다.
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`: 층별 도면 목록과 편집 진입점을 제공한다.
- `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`: editor state, lease와 저장 lifecycle을 관리한다.
- `apps/web/src/features/floor-editor/editor-diff.ts`: 최초 상태와 현재 상태의 변경 payload를 계산한다.
- `apps/web/src/features/floor-editor/editor-diff.test.ts`: 1,000개 조명에서도 변경 항목만 생성하는지 검증한다.
- `apps/web/e2e/settings-floor-editor.spec.ts`: operator 설치, admin 편집, viewer 차단을 검증한다.

### 주요 수정 파일

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260721120000_simplify_roles_and_floor_revisions/migration.sql`
- `apps/api/prisma/bootstrap-owner.ts`에서 `bootstrap-operator.ts`로 rename
- `apps/api/src/auth/*`
- `apps/api/src/sites/*`, `commands/*`, `energy/*`, `fixtures/*`
- `apps/api/src/setup/*`, `registration/*`, `gateway-onboarding/*`, `floor-editor/*`
- `apps/web/src/App.tsx`, `apps/web/src/api/auth.ts`, `apps/web/src/api/floor-editor.ts`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/settings/SettingsView.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.tsx`, `editor-store.ts`, `editor-types.ts`
- `docs/database-schema.md`, `docs/menus/settings.md`, `docs/menus/monitoring.md`

---

### Task 1: 3단계 역할과 tenant schema migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260721120000_simplify_roles_and_floor_revisions/migration.sql`
- Modify: `apps/api/test/domain-schema.test.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: `UserRole = operator | admin | viewer`
- Produces: `OrganizationType = service_provider | customer`
- Produces: `SiteMembership(userId, siteId)`
- Produces: `Floor.mapRevision`과 `FloorMapRevision`
- Produces: 공통 `AuditLog`

- [ ] **Step 1: schema 계약 실패 테스트 작성**

```ts
const schema = readSchema();
expect(schema).toMatch(/enum UserRole\s*{\s*operator\s+admin\s+viewer\s*}/);
expect(schema).not.toMatch(/enum UserRole\s*{[^}]*owner/);
expect(schema).toContain("enum OrganizationType");
expect(schema).toContain("model SiteMembership");
expect(schema).toContain("@@unique([userId, siteId])");
expect(schema).toContain("mapRevision");
expect(schema).toContain("model FloorMapRevision");
expect(schema).toMatch(/snapshot\s+Json/);
expect(schema).toContain("model AuditLog");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api exec jest test/domain-schema.test.ts --runInBand`

Expected: `owner` enum과 신규 모델 누락으로 FAIL.

- [ ] **Step 3: Prisma 모델 추가**

```prisma
enum UserRole {
  operator
  admin
  viewer
}

enum OrganizationType {
  service_provider
  customer
}

model SiteMembership {
  id        String   @id @default(uuid())
  userId    String
  siteId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  site      Site     @relation(fields: [siteId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@unique([userId, siteId])
  @@index([siteId])
}

model FloorMapRevision {
  id                   String   @id @default(uuid())
  floorId              String
  revision             Int
  snapshot             Json
  snapshotSha256       String
  changeSummary        Json
  changedBy            String
  restoredFromRevision Int?
  floor                 Floor    @relation(fields: [floorId], references: [id], onDelete: Cascade)
  user                  User     @relation(fields: [changedBy], references: [id], onDelete: Restrict)
  createdAt             DateTime @default(now())

  @@unique([floorId, revision])
  @@index([floorId, createdAt])
}

model AuditLog {
  id             String   @id @default(uuid())
  organizationId String?
  siteId         String?
  actorId        String?
  action         String
  targetType     String
  targetId       String?
  outcome        String
  metadata       Json?
  ipAddress      String?
  userAgent      String?
  createdAt      DateTime @default(now())

  @@index([siteId, createdAt])
  @@index([actorId, createdAt])
}
```

`Organization.type @default(customer)`, `Floor.mapRevision @default(0)`과 관계 필드를 기존 모델에 추가한다.

- [ ] **Step 4: 비파괴 SQL migration 작성**

Migration 순서는 Organization type 생성과 customer 기본값 적용, service_provider partial Unique index 생성, 새 UserRole enum 변환, membership backfill, revision 모델 생성 순서로 고정한다. legacy 데이터의 현장 유무는 서비스 운영사 식별 근거가 아니므로 기존 Organization을 분류하거나 service_provider로 update하지 않는다.

```sql
ALTER TABLE "Organization"
  ADD COLUMN "type" "OrganizationType" NOT NULL DEFAULT 'customer';

CREATE UNIQUE INDEX "Organization_single_service_provider_key"
  ON "Organization"("type")
  WHERE "type" = 'service_provider';

ALTER TABLE "User" ADD COLUMN "role_new" "UserRole";
UPDATE "User"
SET "role_new" = CASE
  WHEN "role"::text IN ('owner', 'operator') THEN 'admin'::"UserRole"
  ELSE 'viewer'::"UserRole"
END;
```

기존 viewer는 customer로 유지된 자기 Organization의 site 전체에 membership을 backfill해 migration 직후 조회 권한이 갑자기 사라지지 않게 한다. `Invitation.role`도 새 enum으로 변환하며 기존 owner/operator invitation은 admin으로 이관한다. service_provider Organization과 첫 operator는 migration이 아니라 `auth:bootstrap-operator` CLI가 PostgreSQL transaction advisory lock, 사전 존재 검사 및 partial Unique index 방어 아래 생성한다.

이 migration 파일을 수정 전 이미 적용한 로컬 개발 DB는 Prisma checksum 충돌이 난다. 데이터 보존이 불필요한 로컬 DB만 reset을 선택할 수 있고, 보존이 필요하면 잘못 추론된 service provider/operator 데이터를 감사한 뒤 수동 보정 migration을 적용한다. 자동 reset은 실행하지 않는다.

- [ ] **Step 5: schema와 migration 검증**

Run: `pnpm --filter @led-control/api exec prisma validate`

Run: `pnpm --filter @led-control/api exec jest test/domain-schema.test.ts --runInBand`

Expected: 모두 PASS.

- [ ] **Step 6: DB 문서 갱신 후 커밋**

```bash
git add apps/api/prisma apps/api/test/domain-schema.test.ts docs/database-schema.md
git commit -m "feat(auth): simplify roles and add site memberships"
```

---

### Task 2: operator bootstrap과 인증 타입 전환

**Files:**
- Rename: `apps/api/src/auth/bootstrap-owner.ts` → `apps/api/src/auth/bootstrap-operator.ts`
- Rename: `apps/api/src/auth/bootstrap-owner.spec.ts` → `apps/api/src/auth/bootstrap-operator.spec.ts`
- Rename: `apps/api/prisma/bootstrap-owner.ts` → `apps/api/prisma/bootstrap-operator.ts`
- Modify: `apps/api/src/auth/auth.types.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.service.spec.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/web/src/api/auth.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `AuthenticatedUser.role: UserRole`
- Produces: `auth:bootstrap-operator`
- Produces: service_provider Organization과 operator 계정

- [ ] **Step 1: bootstrap 실패 테스트를 새 의미로 변경**

```ts
expect(prisma.organization.create).toHaveBeenCalledWith({
  data: { name: "DF Korea Service", type: "service_provider" }
});
expect(prisma.user.create).toHaveBeenCalledWith({
  data: expect.objectContaining({ role: "operator" })
});
```

- [ ] **Step 2: 현재 코드에서 실패 확인**

Run: `pnpm --filter @led-control/api exec jest src/auth/bootstrap-operator.spec.ts --runInBand`

Expected: rename 또는 `owner` 기대값 때문에 FAIL.

- [ ] **Step 3: bootstrap과 typed role 구현**

```ts
export type UserRole = "operator" | "admin" | "viewer";

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  organizationType: "service_provider" | "customer";
  email: string;
  name: string;
  role: UserRole;
  status: "active" | "disabled";
}
```

로그인과 session 조회는 User와 Organization type을 함께 조회해 공개 사용자에 포함한다.

- [ ] **Step 4: invitation role 방어**

`AuthService.signup`은 invitation의 Organization type과 role 조합을 검사한다.

```ts
if (organization.type === "service_provider" && invitation.role !== "operator") {
  throw new BadRequestException("service provider invitations require operator role");
}
if (organization.type === "customer" && invitation.role === "operator") {
  throw new BadRequestException("customer invitations cannot grant operator role");
}
```

- [ ] **Step 5: API·웹 인증 테스트 실행**

Run: `pnpm --filter @led-control/api exec jest src/auth --runInBand`

Run: `pnpm --filter @led-control/web exec vitest run src/features/auth src/App.test.tsx`

Expected: 모두 PASS.

- [x] **Step 6: 커밋**

```bash
git add apps/api apps/web/src/api/auth.ts package.json README.md docs
git commit -m "feat(auth): bootstrap service operators"
```

---

### Task 3: 공통 역할 Guard와 현장 접근 서비스

**Files:**
- Create: `apps/api/src/access/access.module.ts`
- Create: `apps/api/src/access/roles.decorator.ts`
- Create: `apps/api/src/access/roles.guard.ts`
- Create: `apps/api/src/access/roles.guard.spec.ts`
- Create: `apps/api/src/access/site-access.service.ts`
- Create: `apps/api/src/access/site-access.service.spec.ts`
- Create: `apps/api/src/audit/audit.module.ts`
- Create: `apps/api/src/audit/audit.service.ts`
- Create: `apps/api/src/audit/audit.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Produces: `@Roles(...roles: UserRole[])`
- Produces: `SiteAccessService.assert(user, siteId, capability)`
- Produces: `SiteAccessService.listAccessibleSiteIds(user)`
- Produces: `SiteCapability = read | manage | commission`
- Produces: `AuditService.record(input)`

- [ ] **Step 1: 권한 행렬 실패 테스트 작성**

```ts
await expect(service.assert(operator, customerSiteId, "commission")).resolves.toBeDefined();
await expect(service.assert(unassignedOperator, customerSiteId, "read")).rejects.toThrow("site not found");
await expect(service.assert(admin, ownSiteId, "manage")).resolves.toBeDefined();
await expect(service.assert(admin, ownSiteId, "commission")).rejects.toBeInstanceOf(ForbiddenException);
await expect(service.assert(viewer, ownSiteId, "manage")).rejects.toBeInstanceOf(ForbiddenException);
await expect(service.assert(admin, otherCustomerSiteId, "read")).rejects.toThrow("site not found");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api exec jest src/access src/audit --runInBand`

Expected: module 미존재로 FAIL.

- [ ] **Step 3: 역할 Guard 구현**

```ts
export const Roles = (...roles: UserRole[]) => SetMetadata("roles", roles);

const allowed = this.reflector.getAllAndOverride<UserRole[]>("roles", [
  context.getHandler(),
  context.getClass()
]);
if (!allowed || allowed.includes(request.user.role)) return true;
throw new ForbiddenException("insufficient role");
```

- [ ] **Step 4: SiteAccessService 구현**

```ts
async assert(user: AuthenticatedUser, siteId: string, capability: SiteCapability) {
  const site = await this.prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, organizationId: true, memberships: { where: { userId: user.id }, select: { id: true } } }
  });
  if (!site) throw new NotFoundException("site not found");

  const assigned = site.memberships.length > 0;
  const customerAdmin = user.role === "admin" && site.organizationId === user.organizationId;
  const canRead = customerAdmin || assigned;
  const canManage = user.role === "admin" ? customerAdmin : user.role === "operator" && assigned;
  const canCommission = user.role === "operator" && assigned;
  if (!(capability === "read" ? canRead : capability === "manage" ? canManage : canCommission)) {
    if (!canRead) throw new NotFoundException("site not found");
    throw new ForbiddenException("site capability denied");
  }
  return site;
}
```

`listAccessibleSiteIds`는 admin이면 자기 customer Organization의 site ID를, operator/viewer이면 SiteMembership의 site ID만 반환한다. dashboard, 통계와 현장 선택기는 이 목록을 사용한다.

`AuditService.record`는 `claimCode`, `password`, `privateKey`, `certificatePem` key를 metadata에서 거부한다. 설정 transaction에서 호출할 때는 같은 Prisma transaction client를 받아 감사 기록 실패 시 설정 변경도 rollback한다.

- [ ] **Step 5: 테스트와 typecheck**

Run: `pnpm --filter @led-control/api exec jest src/access src/audit --runInBand`

Run: `pnpm --filter @led-control/api typecheck`

Expected: 모두 PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/api/src/access apps/api/src/audit apps/api/src/app.module.ts
git commit -m "feat(auth): enforce role and site capabilities"
```

---

### Task 4: 모니터링·제어 조회를 SiteAccess로 전환

**Files:**
- Modify: `apps/api/src/sites/sites.controller.ts`, `sites.service.ts`, `sites.service.spec.ts`
- Modify: `apps/api/src/fixtures/fixtures.controller.ts`, `fixtures.service.ts`, `fixtures.service.spec.ts`
- Modify: `apps/api/src/energy/energy.controller.ts`, `energy.service.ts`, `energy.service.spec.ts`, `energy.module.ts`
- Modify: `apps/api/src/commands/commands.controller.ts`, `commands.service.ts`, `commands.service.spec.ts`
- Modify: `apps/api/src/commands/command-status.service.ts`, `command-status.service.spec.ts`, `commands.module.ts`
- Modify: `apps/api/src/sites/sites.module.ts`, `apps/api/src/fixtures/fixtures.module.ts`

**Interfaces:**
- Consumes: `SiteAccessService.assert(user, siteId, capability)`
- Produces: operator/admin/viewer용 접근 가능한 기본 dashboard
- Produces: `GET /sites`와 `GET /sites/:siteId/dashboard`
- Produces: viewer 제어 차단, operator/admin 제어 허용

- [ ] **Step 1: 다른 고객사와 미배정 operator 실패 테스트 추가**

각 서비스 테스트에 다음 세 경우를 추가한다.

```ts
await expect(service.getDefaultDashboard(unassignedOperator)).rejects.toThrow("site not found");
await expect(service.getFloorFixtures(otherCustomerAdmin, floorId, query)).rejects.toThrow("site not found");
await expect(commands.createDimmingCommand(viewer, input)).rejects.toThrow("viewer users cannot control lights");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api exec jest src/sites src/fixtures src/energy src/commands --runInBand`

Expected: organizationId 기반 구현으로 새 테스트 FAIL.

- [ ] **Step 3: service 입력을 AuthenticatedUser로 전환**

```ts
getDefaultDashboard(user: AuthenticatedUser, includeFixtures = false)
getFloorFixtures(user: AuthenticatedUser, floorId: string, query: FixturePageQuery)
getDefaultSiteEstimate(user: AuthenticatedUser)
createDimmingCommand(user: AuthenticatedUser, input: CreateDimmingCommandInput)
getCommand(user: AuthenticatedUser, commandId: string)
```

Floor, Fixture, Group 또는 Command에서 siteId를 먼저 구한 뒤 `SiteAccessService.assert`를 호출한다. 다른 tenant 대상에는 존재 여부가 드러나지 않도록 `404`를 사용한다.

`GET /sites`는 `listAccessibleSiteIds` 범위의 id, 고객사명, 현장명만 반환하고 `GET /sites/:siteId/dashboard`는 명시한 site를 조회한다. 기존 `/sites/default/dashboard`는 첫 접근 가능 현장을 반환하는 호환 endpoint로 유지한다.

- [ ] **Step 4: 관련 테스트 실행**

Run: `pnpm --filter @led-control/api exec jest src/sites src/fixtures src/energy src/commands --runInBand`

Expected: 모두 PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/sites apps/api/src/fixtures apps/api/src/energy apps/api/src/commands
git commit -m "fix(auth): scope monitoring and control by site access"
```

---

### Task 5: operator 전용 설치·시운전 권한 전환

**Files:**
- Modify: `apps/api/src/setup/setup.controller.ts`, `setup.controller.spec.ts`, `setup.service.ts`, `setup.service.spec.ts`, `setup.module.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.controller.ts`, `gateway-onboarding.controller.spec.ts`, `gateway-onboarding.service.ts`, `gateway-onboarding.service.spec.ts`, `gateway-onboarding.module.ts`
- Modify: `apps/api/src/registration/registration.controller.ts`, `registration.service.ts`, `registration.service.spec.ts`, `registration.module.ts`
- Modify: `apps/api/src/floor-editor/floor-assets.controller.ts`, `floor-assets.service.ts`, `floor-assets.service.spec.ts`, `floor-editor.module.ts`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`, `SetupWizard.test.tsx`

**Interfaces:**
- Consumes: `SiteCapability.commission`
- Produces: operator의 customer Organization + site + membership 원자 생성
- Produces: admin/viewer의 Claim·provisioning `403`
- Produces: operator/admin의 floor asset upload와 viewer의 upload `403`

- [ ] **Step 1: 권한 실패 테스트 작성**

```ts
await expect(setup.createInitialSite(admin, input)).rejects.toBeInstanceOf(ForbiddenException);
await expect(gateway.claimGateway(admin, claimInput)).rejects.toBeInstanceOf(ForbiddenException);
await expect(registration.createSession(admin, sessionInput)).rejects.toBeInstanceOf(ForbiddenException);
await expect(floorAssets.createUploadIntent(admin, floorId, uploadInput)).resolves.toBeDefined();
await expect(floorAssets.createUploadIntent(viewer, floorId, uploadInput)).rejects.toBeInstanceOf(ForbiddenException);
```

- [ ] **Step 2: operator onboarding transaction 테스트 작성**

```ts
expect(tx.organization.create).toHaveBeenCalledWith({
  data: { name: "고객사 A", type: "customer" }
});
expect(tx.siteMembership.create).toHaveBeenCalledWith({
  data: { userId: operator.id, siteId: createdSite.id }
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm --filter @led-control/api exec jest src/setup src/gateway-onboarding src/registration --runInBand`

Expected: 기존 admin claim 허용과 organizationId 주입 때문에 FAIL.

- [ ] **Step 4: endpoint와 transaction 구현**

`POST /setup/initial-site` 입력을 다음으로 변경한다.

```ts
interface InitialSiteSetupBody {
  customerOrganizationName: string;
  siteName: string;
  address: string;
  tariffKwhRate: number;
  floors: FloorBody[];
}
```

operator 사용자 검증 후 customer Organization, Site, Floor, operator SiteMembership을 하나의 serializable transaction으로 만든다. Gateway claim과 registration endpoint에는 `@Roles("operator")`와 commission access를 적용한다. Floor asset 조회는 read access, 업로드·완료는 manage access를 적용해 admin의 설치 후 도면 교체를 허용한다.

- [ ] **Step 5: SetupWizard에 고객사명 추가**

`customerOrganizationName` 필드를 필수로 추가하고 admin/viewer가 현장이 없을 때는 마법사 대신 `설치 담당자가 현장을 준비 중입니다` 상태를 표시한다.

- [ ] **Step 6: 테스트 실행**

Run: `pnpm --filter @led-control/api exec jest src/setup src/gateway-onboarding src/registration --runInBand`

Run: `pnpm --filter @led-control/web exec vitest run src/features/setup src/App.test.tsx`

Expected: 모두 PASS.

- [ ] **Step 7: 커밋**

```bash
git add apps/api/src/setup apps/api/src/gateway-onboarding apps/api/src/registration apps/web/src/features/setup apps/web/src/App.test.tsx
git commit -m "feat(setup): restrict commissioning to assigned operators"
```

---

### Task 6: URL 기반 설정 shell과 역할별 navigation

**Files:**
- Modify: `apps/web/package.json`, `pnpm-lock.yaml`
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`
- Delete: `apps/web/src/state/navigation-store.ts`
- Create: `apps/web/src/features/settings/SettingsShell.tsx`, `SettingsShell.test.tsx`
- Create: `apps/web/src/features/settings/settings-sections.ts`, `settings-sections.test.ts`
- Create: `apps/web/src/features/sites/SiteSwitcher.tsx`, `SiteSwitcher.test.tsx`
- Modify: `apps/web/src/api/queries.ts`
- Create: `apps/web/Dockerfile`
- Create: `apps/web/nginx.conf`

**Interfaces:**
- Produces: `/monitoring`, `/control`, `/statistics`, `/settings/*`
- Produces: `settingsSectionsFor(role: UserRole)`
- Produces: URL query `siteId` 기반 현장 선택

- [x] **Step 1: routing 실패 테스트 작성**

```tsx
window.history.pushState({}, "", "/settings/floor-plans");
renderAppAs({ role: "admin" });
expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
expect(screen.queryByRole("link", { name: "설치 및 시운전" })).not.toBeInTheDocument();
```

- [x] **Step 2: dependency 설치**

Run: `pnpm --filter @led-control/web add react-router-dom@^7.0.0`

Expected: `apps/web/package.json`과 lockfile 변경.

- [x] **Step 3: App route 구현**

```tsx
<Routes>
  <Route element={<AuthenticatedShell />}>
    <Route path="/monitoring" element={<MonitoringView />} />
    <Route path="/control" element={<ControlView />} />
    <Route path="/statistics" element={<StatisticsView />} />
    <Route path="/settings" element={<SettingsShell />}>
      <Route index element={<SettingsView />} />
      <Route path="floor-plans" element={<FloorPlanSettingsView />} />
      <Route path="floor-plans/:floorId/edit" element={<FloorEditorRoute />} />
    </Route>
    <Route path="*" element={<Navigate to="/monitoring" replace />} />
  </Route>
</Routes>
```

- [x] **Step 4: 역할별 메뉴 구현**

operator에는 모든 설정 섹션을, admin에는 설치·Gateway 해제·OTA를 제외한 운영 설정을, viewer에는 조회 가능한 개요·도면·장비 상태만 반환한다.

`SiteSwitcher`는 `/sites` 응답만 표시하고 선택한 siteId를 URL query에 보존한다. `useDashboard(siteId)`와 설정 query는 이 값을 사용하므로 operator가 고객사 사이를 이동해도 이전 고객의 cache를 재사용하지 않는다.

`apps/web/nginx.conf`에는 새로고침 시 route가 404가 되지 않도록 다음 fallback을 포함한다.

```nginx
location / {
  try_files $uri $uri/ /index.html;
}
```

- [x] **Step 5: 테스트 실행**

Run: `pnpm --filter @led-control/web exec vitest run src/App.test.tsx src/features/settings`

Expected: 새로고침 경로와 역할별 menu 테스트 PASS.

- [x] **Step 6: 커밋**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src apps/web/Dockerfile apps/web/nginx.conf
git commit -m "feat(settings): add routed settings workspace"
```

---

### Task 7: 도면 에디터를 설정으로 이동

**Files:**
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/src/App.test.tsx`
- Create: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`, `FloorPlanSettingsView.test.tsx`
- Create: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`, `FloorEditorRoute.test.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `docs/menus/monitoring.md`, `docs/menus/settings.md`

**Interfaces:**
- Consumes: `GET /floors/:floorId/editor-state`
- Produces: 읽기 전용 monitoring과 `/settings/floor-plans/:floorId/edit`

- [x] **Step 1: monitoring 회귀 테스트 수정**

```tsx
expect(screen.queryByRole("button", { name: "도면 편집" })).not.toBeInTheDocument();
expect(screen.getByLabelText("층 도면")).toBeInTheDocument();
```

- [x] **Step 2: settings 도면 목록 테스트 작성**

```tsx
expect(await screen.findByText("B2")).toBeInTheDocument();
expect(screen.getByText("도면 등록됨")).toBeInTheDocument();
fireEvent.click(screen.getByRole("link", { name: "B2 도면 편집" }));
expect(await screen.findByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
```

- [x] **Step 3: 실패 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/monitoring src/features/settings`

Expected: monitoring 편집 버튼과 settings route 누락으로 FAIL.

- [x] **Step 4: 컴포넌트 이동 구현**

`MonitoringView`의 `editingFloorId`, editor query와 editor branch를 제거한다. `FloorEditorRoute`가 route param을 읽고 editor query를 실행하며 `FloorEditorView`의 저장·취소는 각각 설정 도면 목록으로 이동한다.

- [x] **Step 5: 문서와 테스트 갱신**

Run: `pnpm --filter @led-control/web exec vitest run src/features/monitoring src/features/settings src/features/floor-editor`

Expected: 모두 PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/web/src/features/monitoring apps/web/src/features/settings apps/web/src/features/floor-editor docs/menus/monitoring.md docs/menus/settings.md
git commit -m "feat(settings): move floor editor from monitoring"
```

---

### Task 8: 도면 원자 저장과 revision API

**Files:**
- Modify: `apps/api/src/floor-editor/floor-editor.controller.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.service.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.service.spec.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.module.ts`
- Modify: `packages/shared/src/schemas.ts` 또는 floor-editor 전용 DTO 파일

**Interfaces:**
- Produces: `PUT /floors/:floorId/editor-state`
- Produces: `GET /floors/:floorId/editor-revisions`
- Produces: `POST /floors/:floorId/editor-revisions/:revision/restore`

- [x] **Step 1: transaction과 충돌 실패 테스트 작성**

```ts
await expect(service.saveEditorState(admin, floorId, { expectedRevision: 3, ...changes }))
  .rejects.toBeInstanceOf(ConflictException);
expect(prisma.$transaction).toHaveBeenCalledTimes(1);
```

fixture가 다른 floor에 속하거나 asset이 ready가 아니면 transaction 전체가 실패하고 revision이 생성되지 않는 테스트도 추가한다.

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.service.spec.ts --runInBand`

Expected: save API 미구현으로 FAIL.

- [x] **Step 3: DTO와 transaction 구현**

```ts
interface SaveEditorStateInput {
  expectedRevision: number;
  floorPlan?: FloorPlanUpdate | null;
  fixtureUpdates: FixtureLayoutUpdate[];
  objectCreates: FloorMapObjectDraft[];
  objectUpdates: Array<{ id: string; patch: FloorMapObjectPatch }>;
  objectDeletes: string[];
}
```

Serializable transaction 시작 시 `floor.updateMany({ where: { id, mapRevision: expectedRevision }, data: { mapRevision: { increment: 1 } } })` 결과가 1인지 확인한다. 변경 적용 후 transaction 내부에서 최신 상태를 조회해 canonical JSON, SHA-256과 change summary를 `FloorMapRevision`에 저장한다.
같은 transaction에서 `AuditService.record`로 `floor_editor.saved` 또는 `floor_editor.restored` action을 기록한다.

- [x] **Step 4: 복구 구현**

복구 API는 최신 revision을 expectedRevision으로 받고 과거 snapshot을 현재 normalized tables에 적용한 뒤 새 revision을 만든다. 현재 존재하지 않는 fixture는 만들지 않고 `skippedFixtureIds`로 반환한다.

- [x] **Step 5: 기존 개별 변경 endpoint 처리**

새 웹 전환 전까지 기존 PATCH endpoint는 유지하되 operator/admin 권한과 site access를 적용한다. Task 11의 전체 E2E 통과 후 제거할 endpoint 목록을 문서에 명시한다.

- [x] **Step 6: 테스트 실행**

Run: `pnpm --filter @led-control/api exec jest src/floor-editor --runInBand`

Expected: 정상 저장, rollback, `409`, 복구와 교차 tenant 테스트 PASS.

- [x] **Step 7: 커밋**

```bash
git add apps/api/src/floor-editor packages/shared
git commit -m "feat(floor-editor): save floor revisions atomically"
```

---

### Task 9: 웹 변경분 저장과 버전 복구 UI

**Files:**
- Create: `apps/web/src/features/floor-editor/editor-diff.ts`, `editor-diff.test.ts`
- Modify: `apps/web/src/features/floor-editor/editor-types.ts`, `editor-store.ts`, `FloorEditorView.test.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/floor-editor.ts`
- Modify: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`, `FloorEditorRoute.test.tsx`

**Interfaces:**
- Consumes: Task 8 atomic save/revision API
- Produces: `buildEditorChanges(initial, current): SaveEditorStateInput`

- [x] **Step 1: diff 실패 테스트 작성**

```ts
const input = buildEditorChanges(initialWith1000Fixtures, currentWithOneMovedFixture);
expect(input.fixtureUpdates).toEqual([{ id: "fixture-500", x: 420, y: 180 }]);
expect(input.objectCreates).toHaveLength(0);
expect(input.objectUpdates).toHaveLength(0);
expect(input.objectDeletes).toHaveLength(0);
```

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/floor-editor/editor-diff.test.ts`

Expected: module 미존재로 FAIL.

- [x] **Step 3: revision과 baseline 상태 구현**

`FloorEditorState.floor.mapRevision`을 추가하고 store에 `initialState`, `state`, `isDirty`를 둔다. 업데이트 action은 값이 실제로 달라질 때만 dirty를 설정한다.

- [x] **Step 4: atomic API client 구현**

```ts
export function saveFloorEditorState(floorId: string, payload: SaveEditorStateInput) {
  return apiPut<FloorEditorState>(`/floors/${floorId}/editor-state`, payload);
}
```

API client 공통 함수에 `PUT`과 status를 보존하는 `ApiError`를 추가해 `409`를 다른 오류와 구분한다.

- [x] **Step 5: 저장·충돌·복구 UI 구현**

- 저장 성공 시 반환 상태를 새 baseline으로 설정하고 관련 dashboard/floor query를 invalidate한다.
- 네트워크 실패 시 editor state를 유지한다.
- `409`이면 강제 저장 버튼 없이 최신 버전 다시 불러오기를 제공한다.
- version panel은 수정자, 시각, 변경 수를 표시하고 operator/admin에만 복구 버튼을 보인다.
- dirty 상태에서 route 이동 또는 브라우저 종료 시 확인한다.

- [x] **Step 6: 웹 테스트 실행**

Run: `pnpm --filter @led-control/web exec vitest run src/features/floor-editor src/features/settings/floor-plans`

Expected: 변경분, 저장, 충돌, 복구와 dirty guard 테스트 PASS.

- [x] **Step 7: 커밋**

```bash
git add apps/web/src/api apps/web/src/features/floor-editor apps/web/src/features/settings/floor-plans
git commit -m "feat(floor-editor): add revision-aware editing"
```

- [x] **Step 8: Fix Round 1 review 보완**

save/restore 동기 잠금과 편집 surface 비활성화, history 보상 guard, site/floor canonical URL, floor plan 의미 정규화, UUID draft ID, revision 상태·요약·복구 안내 lifecycle을 실패 테스트 후 보완한다. desktop/mobile Playwright 레이아웃 회귀를 함께 검증한다.

---

### Task 10: Redis 편집 lease

**Files:**
- Create: `apps/api/src/redis/redis.module.ts`, `redis.provider.ts`, `redis.provider.spec.ts`
- Create: `apps/api/src/floor-editor/editor-lease.service.ts`, `editor-lease.service.spec.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.controller.ts`, `floor-editor.module.ts`
- Modify: `apps/web/src/api/floor-editor.ts`
- Modify: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`, `FloorEditorRoute.test.tsx`
- Modify: `.env.example`

**Interfaces:**
- Produces: `POST /floors/:floorId/editor-lease`
- Produces: `DELETE /floors/:floorId/editor-lease`
- Lease key: `floor-editor:lease:{floorId}`, TTL 90 seconds

- [ ] **Step 1: lease 실패 테스트 작성**

```ts
await expect(service.acquire(floorId, adminA)).resolves.toMatchObject({ editable: true });
await expect(service.acquire(floorId, adminB)).resolves.toMatchObject({ editable: false, holderName: adminA.name });
await expect(service.release(floorId, adminB, false)).rejects.toBeInstanceOf(ForbiddenException);
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api exec jest src/floor-editor/editor-lease.service.spec.ts --runInBand`

Expected: service 미존재로 FAIL.

- [ ] **Step 3: token 비교 lease 구현**

`RedisModule`은 필수 `REDIS_URL`로 단일 lazy client를 생성하고 Nest 종료 시 `quit()`한다. value는 `{ userId, userName, token, acquiredAt }` JSON이며 acquire는 Redis `SET NX EX 90`, 갱신과 해제는 Lua script로 token이 일치할 때만 수행한다. operator/admin 강제 해제는 `AuditService`에 `floor_editor.lease_force_released` action을 성공적으로 기록한 뒤에만 실행한다.

- [ ] **Step 4: 웹 heartbeat 구현**

편집 route 진입 시 lease를 얻고 editable일 때 30초마다 같은 token으로 갱신한다. lease가 없거나 상실되면 editor를 읽기 전용으로 전환하며 저장 버튼을 비활성화한다. 정상 route 이탈 시 release하고 비정상 종료는 TTL에 맡긴다.

- [ ] **Step 5: 테스트 실행**

Run: `pnpm --filter @led-control/api exec jest src/redis src/floor-editor --runInBand`

Run: `pnpm --filter @led-control/web exec vitest run src/features/settings/floor-plans`

Expected: lease 충돌, 만료, token 불일치, 읽기 전용 전환 테스트 PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/api/src/redis apps/api/src/floor-editor apps/web/src/api/floor-editor.ts apps/web/src/features/settings/floor-plans .env.example
git commit -m "feat(floor-editor): prevent concurrent floor edits"
```

---

### Task 11: 회귀 E2E, 성능과 문서 완료

**Files:**
- Create: `apps/web/e2e/settings-floor-editor.spec.ts`
- Create: `apps/web/e2e/support/settings-api.ts`
- Modify: `apps/web/e2e/mvp1.spec.ts`, `monitoring-1000.spec.ts`, `auth-real.spec.ts`
- Modify: `docs/menus/settings.md`, `docs/menus/monitoring.md`, `docs/menus/control.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/lesson_leared.md` only when a reusable failure pattern is found

**Interfaces:**
- Verifies: operator 설치 → admin 편집 → monitoring 반영 → viewer 차단
- Verifies: 1,000 fixture diff 저장과 교차 tenant 차단

- [ ] **Step 1: 실제 역할 E2E 작성**

```ts
test("operator commissions and customer admin edits a floor plan", async ({ browser }) => {
  const operatorPage = await browser.newPage();
  await installSettingsApiRoutes(operatorPage, "operator");
  await operatorPage.goto("/settings/commissioning");
  await expect(operatorPage.getByRole("heading", { name: "설치 및 시운전" })).toBeVisible();

  const adminPage = await browser.newPage();
  await installSettingsApiRoutes(adminPage, "admin");
  await adminPage.goto("/settings/floor-plans/floor-1/edit");
  await expect(adminPage.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
  await adminPage.getByRole("button", { name: "저장" }).click();
  await expect(adminPage.getByText("저장했습니다.")).toBeVisible();

  const viewerPage = await browser.newPage();
  await installSettingsApiRoutes(viewerPage, "viewer");
  await viewerPage.goto("/settings/floor-plans/floor-1/edit");
  await expect(viewerPage.getByText("읽기 전용")).toBeVisible();
  await expect(viewerPage.getByRole("button", { name: "저장" })).toBeDisabled();
});
```

`installSettingsApiRoutes`는 `auth/me`, dashboard, editor-state, lease와 atomic save 응답을 test fixture로 등록하고 viewer의 PUT에는 403을 반환한다. 실제 API의 tenant 차단은 Task 3~5 Jest 서비스 테스트가 담당한다.

테스트 데이터는 test fixture로만 만들며 런타임 mock Gateway나 가짜 BLE 발견 이벤트를 시작하지 않는다.

- [ ] **Step 2: 1,000 fixture 기준 검증**

기존 `monitoring-1000.spec.ts`에 settings editor 진입과 한 조명 이동 저장을 추가하고 request body의 `fixtureUpdates.length === 1`을 확인한다.

- [ ] **Step 3: 전체 자동 검증**

Run: `pnpm typecheck`

Run: `pnpm lint`

Run: `pnpm test`

Run: `pnpm --filter @led-control/web exec playwright test e2e/settings-floor-editor.spec.ts e2e/monitoring-1000.spec.ts`

Expected: 모두 exit code 0.

- [ ] **Step 4: 문서 상태 갱신**

- 설정 문서의 완료 항목에는 자동 검증 범위만 기록한다.
- 모니터링 문서에서 에디터를 제거하고 읽기 전용 도면을 기록한다.
- 제어 문서에 3단계 역할과 viewer 제어 금지를 반영한다.
- DB 문서에 OrganizationType, SiteMembership, mapRevision과 FloorMapRevision을 반영한다.
- 실제 Hardware가 필요하지 않은 도면 작업을 Hardware E2E 완료로 표시하지 않는다.

- [ ] **Step 5: 최종 커밋**

```bash
git add apps/web/e2e docs
git commit -m "test(settings): cover role-scoped floor editing"
```

---

## 후속 구현 계획 분리 기준

이 계획이 완료된 뒤 다음 설정 영역은 각각 독립 계획으로 작성하고 구현한다.

1. 현장·층 CRUD/archive와 고객사 사용자 관리
2. 조명 정보·그룹 관리와 장비 교체 workflow
3. 다중 Gateway coverage와 시운전 보고서
4. 운영 정책·알림과 공통 AuditLog UI
5. private floor asset 검역 pipeline
6. 서명된 Gateway/ESP32-H2 OTA와 rollback
7. 외부 API, Webhook과 BMS/BACnet 연동

각 후속 계획은 이 계획의 `SiteAccessService`, `RolesGuard`, route shell과 공통 query/error 계약을 재사용한다.

## 완료 조건

- DB와 API에서 `owner`가 완전히 제거되고 세 역할만 사용된다.
- operator는 배정되지 않은 고객 현장에 접근할 수 없다.
- admin은 다른 고객사와 설치·provisioning 기능에 접근할 수 없다.
- viewer는 설정을 변경하거나 조명을 제어할 수 없다.
- 도면 에디터는 설정에서만 열리고 모니터링은 읽기 전용이다.
- 도면 저장은 원자적이며 충돌·복구·lease 테스트가 통과한다.
- 조명 1,000개에서 변경 항목만 저장한다.
- 메뉴·DB 문서가 실제 구현 상태와 일치한다.
