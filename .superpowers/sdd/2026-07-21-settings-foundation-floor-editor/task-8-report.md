# Task 8 Report: 도면 원자 저장과 revision API

## 구현 커밋

- `d8d42f1 feat(floor-editor): save floor revisions atomically`
- `62807bf docs(settings): record atomic floor revisions`

## 변경 파일

- `apps/api/src/floor-editor/floor-editor.controller.ts`
- `apps/api/src/floor-editor/floor-editor.controller.spec.ts`
- `apps/api/src/floor-editor/floor-editor.service.ts`
- `apps/api/src/floor-editor/floor-editor.service.spec.ts`
- `apps/api/src/floor-editor/floor-editor-snapshot.ts`
- `apps/api/src/floor-editor/floor-editor.integration.spec.ts`
- `apps/api/src/floor-editor/floor-editor.module.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/schemas.test.ts`
- `docs/menus/settings.md`
- `docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md`
- `.superpowers/sdd/2026-07-21-settings-foundation-floor-editor/task-8-report.md`

Prisma model과 migration은 변경하지 않았으므로 `docs/database-schema.md` 갱신은 필요하지 않았다.

## RED / GREEN 기록

### RED

Command:

```bash
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.service.spec.ts --runInBand
```

Result: exit 1. 기존 11개 테스트는 통과했고 신규 15개 테스트는 `saveEditorState`, `listEditorRevisions`, `restoreEditorRevision`이 없어서 실패했다. stale save, 다른 floor fixture/object, non-ready asset, duplicate ID, canonical snapshot/hash, revision read, restore conflict, missing fixture, transaction audit와 접근 거부가 구현 전 실패하는 것을 확인했다.

Commands:

```bash
pnpm --filter @led-control/shared test -- src/schemas.test.ts
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.controller.spec.ts --runInBand
```

Result: 각각 exit 1. shared suite는 atomic save/restore/snapshot schema가 없어서 2개가 실패했고 controller suite는 save route method가 없어서 실패했다.

Draft optional field 호환성도 별도 RED로 확인했다.

```bash
pnpm --filter @led-control/shared test -- src/schemas.test.ts
```

Result: exit 1. `FloorMapObjectDraft`에서 생략 가능한 `fillColor`, `fontSize`, `zIndex`를 schema가 필수로 처리해 1개가 실패했다.

### GREEN

Commands and results:

```bash
pnpm --filter @led-control/api exec jest src/floor-editor --runInBand
# PASS: 3 suites, 34 tests; opt-in PostgreSQL suite 3 tests skipped

pnpm --filter @led-control/api exec jest src/access/site-access.service.spec.ts src/access/roles.guard.spec.ts src/audit/audit.service.spec.ts --runInBand
# PASS: 3 suites, 21 tests

pnpm --filter @led-control/shared test -- src/schemas.test.ts
# PASS: 1 file, 4 tests

pnpm --filter @led-control/api typecheck
# PASS

pnpm --filter @led-control/api build
# PASS

DATABASE_URL='postgresql://validate:validate@127.0.0.1:1/validate?schema=public' pnpm --filter @led-control/api exec prisma validate
# PASS: schema is valid

git diff --check
# PASS
```

일회용 `postgres:16-alpine` 컨테이너를 랜덤 localhost port로 시작하고 17개 migration을 적용한 뒤 아래 opt-in suite를 실행했다. 테스트 종료 시 container를 강제 제거했으며 제품 DB에는 연결하거나 destructive command를 실행하지 않았다.

```bash
FLOOR_EDITOR_TEST_DATABASE_URL="$url" pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.integration.spec.ts --runInBand
# PASS: 1 suite, 3 tests
```

- audit 기록 단계의 의도적 예외 후 `Floor.mapRevision=0`, fixture `x=10`, revision 0개, audit 0개를 실제 PostgreSQL에서 확인했다.
- 성공 저장은 revision/audit 각 1개를 commit했고 같은 `expectedRevision` 재요청은 `ConflictException`으로 끝나 추가 commit이 없었다.
- 배정 viewer의 revision read, viewer manage `403`, cross-tenant admin read opaque `404`를 실제 SiteAccess와 PostgreSQL로 확인했다.

## Self-review

- save/restore는 권한 확인 후 입력을 검증하고 `Prisma.TransactionIsolationLevel.Serializable` transaction을 연다. transaction 안에서 대상 층 소속과 asset ready 상태를 mutation 전에 확인한 뒤 `Floor.updateMany({ id, mapRevision })`로 optimistic revision을 증가시킨다.
- normalized rows, 최신 상태 조회, canonical snapshot/SHA-256, `FloorMapRevision`, `AuditService.record({ transaction: tx })`가 같은 transaction client를 사용한다. root Prisma audit 호출은 unit test와 실제 DB rollback test에서 배제했다.
- snapshot array는 ID로 정렬하고 JSON object key를 코드포인트 순서로 재귀 정렬해 hash를 계산한다. runtime 상태인 fixture brightness/status와 장비 등록 필드는 snapshot에서 제외했다.
- restore는 `expectedRevision`을 필수로 받고 과거 snapshot을 새 revision으로 적용한다. 현재 없는 fixture는 생성하지 않으며 정렬된 `skippedFixtureIds`로 반환한다. map object와 floor plan만 snapshot 상태로 교체한다.
- revision list는 SiteAccess `read`, save/restore와 기존 개별 mutation endpoint는 `manage`를 확인한다. 미배정/cross-tenant 접근은 기존 SiteAccess의 opaque `404`를 유지한다.
- shared Zod schema는 strict object, finite number, non-empty patch와 nonnegative integer revision을 검증한다. 서비스는 권한 확인 뒤 schema 오류를 `400 Bad Request`로 정규화한다.
- 기존 개별 endpoint 5개는 Task 11 E2E 완료 전까지 유지하며 제거 목록과 통합 revision/audit 미생성 한계를 settings 문서에 기록했다.
- 기준 계획의 Task 8 Step 1-7을 완료 표시했다.

## Concerns

- 웹 에디터는 Task 9 전까지 기존 개별 API를 병렬 호출한다. atomic API가 구현됐어도 현재 UI 저장에는 부분 저장 위험이 남아 있으며 revision conflict/list/restore UI가 아직 연결되지 않았다.
- 기존 개별 mutation endpoint는 Task 11까지 호환 목적으로 남아 있고 직접 호출 시 통합 `FloorMapRevision`과 `floor_editor.saved` audit를 만들지 않는다.
- PostgreSQL integration suite는 `FLOOR_EDITOR_TEST_DATABASE_URL`이 없으면 3개 테스트를 skip한다. 이번 작업에서는 별도 disposable PostgreSQL로 모두 실행했다.
