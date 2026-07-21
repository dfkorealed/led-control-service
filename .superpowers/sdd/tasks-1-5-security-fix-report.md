# Task 1~5 Security Fix Report

기준일: 2026-07-21

## 구현 범위와 커밋

### Floor editor API 및 monitoring 권한

- 커밋: `da10741 fix(auth): enforce floor editor site access`
- `apps/api/src/floor-editor/floor-editor.controller.ts`
  - controller가 `organizationId`가 아닌 전체 `AuthenticatedUser`를 service에 전달한다.
- `apps/api/src/floor-editor/floor-editor.service.ts`
  - editor state는 floor의 `siteId`로 `SiteAccessService.assert(user, siteId, "read")`를 호출한다.
  - floor plan, fixture, map object 생성/수정/삭제는 `manage` capability를 호출한다.
  - 직접 organization ID 비교와 organization-filtered lookup을 제거했다.
- `apps/api/src/floor-editor/floor-editor.controller.spec.ts`
  - 모든 editor endpoint가 authenticated user를 전달하는지 검증한다.
- `apps/api/src/floor-editor/floor-editor.service.spec.ts`
  - 배정된 service-provider operator의 read와 fixture write `manage` 위임을 검증한다.
  - SiteAccess가 거부하면 opaque not-found가 그대로 반환되고 쓰기가 실행되지 않는지 검증한다.
- `apps/web/src/features/monitoring/MonitoringView.tsx`
  - monitoring의 `도면 편집` 진입 버튼을 operator/admin만 표시한다.
- `apps/web/src/App.test.tsx`
  - viewer에게 `도면 편집` 버튼을 노출하지 않는 web 회귀를 검증한다.
- `docs/menus/monitoring.md`
  - monitoring editor의 read/manage 권한 및 viewer 읽기 전용 상태를 반영했다.

### Invitation 원자적 1회 소비

- 커밋: `e0c5059 fix(auth): consume invitations atomically`
- `apps/api/src/auth/auth.service.ts`
  - signup transaction에서 `Invitation.updateMany({ where: { id, acceptedAt: null } })`를 user create보다 먼저 실행한다.
  - 결과 `count !== 1`이면 가입을 거부하고 user를 생성하지 않는다.
- `apps/api/src/auth/auth.service.spec.ts`
  - email이 nullable인 operator invitation이 이미 소비된 경우 다른 email의 두 번째 가입이 거부되고 user create가 호출되지 않는지 검증한다.

### Gateway/registration controller metadata 회귀

- 커밋: `0d798b1 test(auth): cover operator controller metadata`
- `apps/api/src/gateway-onboarding/gateway-onboarding.controller.spec.ts`
  - gateway claim과 inventory disable handler의 `SessionAuthGuard`, `RolesGuard`, `@Roles("operator")` metadata를 검증한다.
- `apps/api/src/registration/registration.controller.spec.ts`
  - registration controller 전체의 `SessionAuthGuard`, `RolesGuard`, `@Roles("operator")` metadata를 검증한다.

## RED 증거

### Floor editor API

명령:

```bash
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.controller.spec.ts src/floor-editor/floor-editor.service.spec.ts --runInBand
```

결과: FAIL, 2 suites / 3 tests failed.

- controller는 `AuthenticatedUser` 대신 `user.organizationId`를 전달했다.
- 배정된 service-provider operator의 editor state read는 `floor not found`로 거부됐다.
- fixture update는 이전 organization lookup shape를 가정해 실패했으며 `SiteAccessService.assert(..., "manage")`를 호출하지 않았다.

### Monitoring viewer UI

명령:

```bash
pnpm --filter @led-control/web exec vitest run src/App.test.tsx
```

결과: FAIL, 1 file / 1 test failed. viewer 화면에서 `도면 편집` button이 발견됐다.

### Invitation 재소비

명령:

```bash
pnpm --filter @led-control/api exec jest src/auth/auth.service.spec.ts --runInBand
```

결과: FAIL, 1 suite / 1 test failed. 이미 소비된 nullable-email invitation의 두 번째 signup promise가 reject가 아니라 resolve됐다.

### Controller metadata

이 범위는 보안 결함이 아니라 요청된 회귀 테스트 공백이었다. metadata는 이미 구현되어 있었으므로 새 테스트는 최초 실행부터 PASS였고 제품 코드는 변경하지 않았다.

```bash
pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-onboarding.controller.spec.ts src/registration/registration.controller.spec.ts --runInBand
```

결과: PASS, 2 suites / 5 tests.

## GREEN 및 최종 검증

```bash
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.controller.spec.ts src/floor-editor/floor-editor.service.spec.ts --runInBand
# PASS: 2 suites / 12 tests

pnpm --filter @led-control/web exec vitest run src/App.test.tsx
# PASS: 1 file / 20 tests

pnpm --filter @led-control/api exec jest src/auth/auth.service.spec.ts --runInBand
# PASS: 1 suite / 7 tests

pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.controller.spec.ts src/floor-editor/floor-editor.service.spec.ts src/auth/auth.service.spec.ts src/gateway-onboarding/gateway-onboarding.controller.spec.ts src/registration/registration.controller.spec.ts --runInBand
# PASS: 5 suites / 24 tests

pnpm --filter @led-control/web exec vitest run src/App.test.tsx
# PASS: 1 file / 20 tests

pnpm --filter @led-control/api typecheck
# PASS

pnpm --filter @led-control/web typecheck
# PASS

git diff --check
# PASS
```

## 우려사항 및 보류 범위

- 실제 PostgreSQL 동시성 integration test는 추가하지 않았다. 기존 DB harness는 `PKI_E2E_DATABASE_URL`이 있을 때만 동작하는 gateway PKI 전용 E2E이고, 현재 환경에는 URL이 설정되지 않았다. 범용 test DB/harness를 새로 구축하는 것은 이번 범위를 과도하게 넓히므로, 조건부 `updateMany` unit 회귀로 원자 소비 계약을 고정했다.
- setup의 실제 PostgreSQL rollback test도 같은 이유로 추가하지 않았다. 기존 `SetupService` unit test는 Serializable transaction 사용을 검증한다.
- legacy migration의 site 없는 Organization 분류와 bootstrap 동시 실행은 브리프의 사용자 결정 대기 범위이므로 수정하지 않았다.
