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

## Fix Round 1

### 구현 커밋

- `edde0a8 fix(floor-editor): harden revision API contracts`
- `8d7aa2e test(floor-editor): verify restore round trips in postgres`

### RED

Shared floor editor boundary:

```bash
pnpm --filter @led-control/shared test -- src/schemas.test.ts
# exit 1: 3 failed, 4 passed
```

- 부분 `{ sourceType: "image" }` floor plan이 parse되어 complete floor plan 테스트가 실패했다.
- INT4/collection 상한 상수가 없어 expected revision 경계 테스트가 실패했다.
- rectangle에 triangle points를 넣어도 parse되어 type-specific points 테스트가 실패했다.

Revision pagination schema:

```bash
pnpm --filter @led-control/shared test -- src/schemas.test.ts
# exit 1: pagination schema 부재로 1 failed, 7 passed
```

Service/controller behavior:

```bash
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.service.spec.ts src/floor-editor/floor-editor.controller.spec.ts --runInBand
# exit 1: 6 failed, 24 passed
```

- rectangle points와 points 없는 triangle type 변경이 성공해 pre-mutation 검증 2개가 실패했다.
- save 응답 object가 ID order를 유지해 zIndex/createdAt order 테스트가 실패했다.
- revision 목록이 pagination 없이 raw `changedBy`, revision/user ID와 email을 반환해 PII-safe 응답 테스트가 실패했다.
- controller가 cursor/limit query를 service에 전달하지 않아 forwarding 테스트가 실패했다.
- complete floor plan fixture 보정으로 canonical hash literal이 달라진 1개는 독립 canonical JSON으로 SHA-256을 다시 계산해 갱신했다.

Trim/semantic ordering 추가 RED:

```bash
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.service.spec.ts --runInBand
# exit 1: blank object color 1 failed, 32 passed
```

공백 fixture 이름, 잘못된 rated watt와 공백 object type은 transaction 전에 거부됐지만 공백 fill color는 저장까지 성공했다. non-null color에 trim 후 최소 길이를 적용한 뒤 네 케이스 모두 transaction을 열지 않는 것을 확인했다.

Expected revision overflow 추가 RED:

```bash
pnpm --filter @led-control/shared test -- src/schemas.test.ts
# exit 1: expected revision 상한 계약 1 failed, 7 passed
```

`INT_MAX` expected revision은 다음 increment가 INT4를 초과하므로 `EDITOR_MAX_EXPECTED_REVISION = INT_MAX - 1`로 제한했다.

### GREEN

```bash
pnpm --filter @led-control/shared test
# PASS: 2 files, 12 tests

pnpm --filter @led-control/api exec jest src/floor-editor --runInBand
# PASS: 3 suites, 41 tests; opt-in PostgreSQL 7 tests skipped

pnpm --filter @led-control/api exec jest src/access/site-access.service.spec.ts src/access/roles.guard.spec.ts src/audit/audit.service.spec.ts --runInBand
# PASS: 3 suites, 21 tests

pnpm --filter @led-control/shared typecheck
pnpm --filter @led-control/shared build
pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/api build
# PASS: all four commands

DATABASE_URL='postgresql://validate:validate@127.0.0.1:1/validate?schema=public' pnpm --filter @led-control/api exec prisma validate
# PASS: schema is valid

git diff --check
# PASS
```

Disposable PostgreSQL 16에 17개 migration을 적용한 실제 DB 검증:

```bash
FLOOR_EDITOR_TEST_DATABASE_URL="$url" pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.integration.spec.ts --runInBand
# PASS: 1 suite, 7 tests
```

- save revision 1에서 floor plan/object/fixture를 만든 뒤 revision 2에서 floor plan 삭제와 object/fixture 변경을 수행하고 revision 1을 복구했다. restore revision 3의 normalized state, snapshot JSON과 SHA-256이 revision 1과 동일했다.
- source revision 뒤 삭제한 fixture는 복구 시 재생성하지 않고 `skippedFixtureIds`로 반환했다.
- partial floor plan, non-ready asset과 foreign-floor fixture 실패 후 map revision/floor plan/revision/audit가 모두 0 상태를 유지했다.
- 같은 expected revision의 동시 Serializable save 두 건 중 한 건만 revision/audit를 commit했다.
- 기존 audit failure 전체 rollback, stale conflict, viewer read/manage와 cross-tenant opaque 404도 함께 통과했다.

### Self-review

- non-null floor plan은 image/pdf 완전 객체만 허용하고 URL 세 개 모두 ready asset 검증 대상이다. atomic create/update와 임시 legacy floor-plan endpoint에서 빈 URL/default create 우회를 제거했다.
- shared named constants가 fixture 1,000개 요구를 수용하면서 object mutation 합계, points와 문자열 크기를 제한한다. PostgreSQL Int 필드와 다음 revision increment까지 범위를 검증한다.
- schema trim/decimal/type 검증과 service prepared mutation 생성은 transaction 전에 실행된다. 현재 DB object type이 필요한 points/type 검증도 transaction 안에서 optimistic `updateMany`보다 먼저 끝난다.
- revision list는 revision-number cursor와 제한된 page size를 사용하고 명시적 safe-field mapping으로 mock/ORM select 동작과 무관하게 internal ID/email을 제거한다. 교차 조직 actor 이름은 generic display name으로 바꾼다.
- snapshot ID order/hash와 editor response z-order를 분리했다. 동률은 `createdAt`, ID 순으로 결정한다.
- destructive restore와 nullable JSON/object `createMany`를 실제 PostgreSQL round-trip으로 검증했다.

### Remaining concerns

- 웹 에디터의 atomic save/revision UI 연결은 여전히 Task 9 범위다.
- 기존 개별 mutation endpoint는 Task 11까지 유지되며 통합 revision/audit을 만들지 않는다.
- PostgreSQL integration suite 7개는 `FLOOR_EDITOR_TEST_DATABASE_URL`이 없으면 skip된다. Fix Round 1에서는 별도 disposable PostgreSQL로 모두 실행했다.

## Fix Round 2

### 구현 커밋

- `a3aa1b7 fix(floor-editor): preserve legacy revision compatibility`
- `669be7e test(floor-editor): cover legacy postgres restores`

### 변경 파일

- `packages/shared/src/schemas.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/api/src/floor-editor/floor-editor.controller.ts`
- `apps/api/src/floor-editor/floor-editor.controller.spec.ts`
- `apps/api/src/floor-editor/floor-editor.service.ts`
- `apps/api/src/floor-editor/floor-editor.service.spec.ts`
- `apps/api/src/floor-editor/floor-editor-snapshot.ts`
- `apps/api/src/floor-editor/floor-editor.integration.spec.ts`
- `docs/menus/settings.md`

### RED

Persisted snapshot와 shared path revision parser:

```bash
pnpm --filter @led-control/shared test -- src/schemas.test.ts
# exit 1: 2 failed, 8 passed
```

- legacy v1 snapshot parser가 없어 `sourceType: none`, nullable URL과 nullable legacy geometry snapshot을 읽지 못했다.
- shared positive PostgreSQL INT parser가 없어 restore path의 `2147483648`, `1e100` 경계를 검증할 수 없었다.

Legacy endpoint, restore overflow와 merged object geometry:

```bash
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.controller.spec.ts src/floor-editor/floor-editor.service.spec.ts --runInBand
# exit 1: 9 failed, 34 passed
```

- legacy floor-plan endpoint가 현재 Web의 `sourceType: none` payload를 `400`으로 거부했다.
- controller는 overflow/지수/0/소수 revision을 service로 전달했고 service는 floor lookup을 먼저 실행했다.
- rectangle `width: null`, line의 nonzero height, incomplete rectangle-to-line patch가 optimistic mutation과 저장까지 진행됐다.

Unsafe persisted state error mapping:

```bash
pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.service.spec.ts --runInBand
# exit 1: 1 failed, 41 passed
```

- 좌표 배열이 아닌 persisted points는 transaction rollback됐지만 `BadRequestException` 대신 raw `ZodError`로 노출됐다.

### GREEN

```bash
pnpm --filter @led-control/shared test
# PASS: 2 files, 14 tests

pnpm --filter @led-control/api exec jest src/floor-editor --runInBand
# PASS: 3 suites, 54 tests; opt-in PostgreSQL 9 tests skipped

pnpm --filter @led-control/api exec jest src/access/site-access.service.spec.ts src/access/roles.guard.spec.ts src/audit/audit.service.spec.ts --runInBand
# PASS: 3 suites, 21 tests

pnpm --filter @led-control/shared typecheck
pnpm --filter @led-control/shared build
pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/api build
# PASS: all four commands

DATABASE_URL='postgresql://validate:validate@127.0.0.1:1/validate?schema=public' pnpm --filter @led-control/api exec prisma validate
# PASS: schema is valid

git diff --check
# PASS
```

Disposable PostgreSQL 16에 17개 migration을 적용한 실제 DB 검증:

```bash
FLOOR_EDITOR_TEST_DATABASE_URL="$url" pnpm --filter @led-control/api exec jest src/floor-editor/floor-editor.integration.spec.ts --runInBand
# PASS: 1 suite, 9 tests
```

- legacy endpoint로 `sourceType: none` 배경을 생성하고 width partial patch를 적용한 뒤 nullable geometry의 legacy object와 함께 revision 1을 저장했다.
- image/strict geometry로 변경한 뒤 revision 1을 restore해 floor plan/object 상태, canonical snapshot JSON과 SHA-256이 원본과 동일함을 확인했다.
- rectangle `width: null` patch는 실제 PostgreSQL에서 `400`으로 끝났고 `Floor.mapRevision`, object width, revision, audit가 모두 변경되지 않았다.
- 기존 save/restore, missing fixture skip, audit rollback, stale/concurrent conflict, access isolation 테스트도 함께 통과했다.

### Self-review

- atomic `floorPlan` write는 complete image/pdf + ready URL 계약을 그대로 사용한다. 별도 v1 persisted parser만 `none`, nullable URL/geometry와 bounded legacy type을 허용하므로 신규 write 계약이 느슨해지지 않는다.
- legacy floor-plan PATCH는 unknown response-only `id/version`을 strip하고 background-none 및 partial patch를 유지한다. non-empty URL은 계속 object-storage URL/ready asset 검사를 거친다.
- snapshot parser는 URL/type/text/color/points 길이, finite number와 INT4를 제한하고 malformed points를 거부한다. parser/build 오류는 restore/save 서비스 경계에서 `400`으로 변환된다.
- object patch는 같은 floor의 현재 type/width/height/points를 조회해 merge한 뒤 shared type-specific geometry schema를 통과해야 한다. 검증은 `floor.updateMany`보다 먼저 실행된다.
- restore revision은 controller와 service 모두 같은 shared positive INT4 parser를 사용하며 DB 조회 전에 overflow를 거부한다.

### Remaining concerns

- 웹 에디터의 atomic save/revision UI 연결은 Task 9 범위다.
- 기존 개별 mutation endpoint는 Task 11까지 유지되며 통합 revision/audit을 만들지 않는다.
- PostgreSQL integration suite 9개는 `FLOOR_EDITOR_TEST_DATABASE_URL`이 없으면 skip된다. Fix Round 2에서는 별도 disposable PostgreSQL로 모두 실행했다.
