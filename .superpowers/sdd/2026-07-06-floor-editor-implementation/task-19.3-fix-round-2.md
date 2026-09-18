# Task 19.3 Fix Round 2 보고서

## 상태

- 재검토 신규 finding P1 1건, P2 2건 수정 완료
- pending CAD attempt asset의 cleanup 소유권을 전용 attempt reconciliation으로 단일화
- orphan tombstone에 15분 quiet period와 terminal `cleanedAt` lifecycle 도입
- `docs/database-schema.md`에 cleanup tombstone 구조와 운영 계약 반영

## 변경 내용

### Pending cleanup과 ready 승격 경쟁

- 범용 `FloorAssetCleanupService`의 pending 후보 SQL과 Floor→asset 잠금 claim 양쪽에서 `FloorImportAttemptCleanup.assetId`가 존재하는 자산을 제외한다.
- CAD worker의 최종 transaction은 Floor→asset→attempt tombstone을 잠그고 asset identity, pending status, `cleanupStartedAt IS NULL`, 미임대·미종료 tombstone을 확인한 뒤에만 ready로 승격한다.
- ready update에도 `cleanupStartedAt: null` 조건을 유지해 과거 또는 비정상 claim 상태가 있으면 job 연결 transaction 전체가 rollback된다.

### Quiet period와 terminal cleanup

- `FloorImportAttemptCleanup.cleanedAt`을 추가하고 `committedAt`과의 상호 배타, `lastCleanedAt` 필수, lease 해제 상태를 DB CHECK로 강제한다.
- 첫 orphan DELETE 성공 뒤 `lastCleanedAt`을 기록하고 `nextAttemptAt`을 15분 뒤로 이동한다. 이 기간에는 storage DELETE를 반복하지 않는다.
- 15분 후 final DELETE가 성공하면 `cleanedAt`을 기록한다. `cleanedAt` tombstone은 이후 startup/periodic sweep 대상에서 제외된다.
- 10초 bounded rendered PUT이 cleanup 직후 늦게 완료돼도 quiet period final DELETE가 같은 deterministic key를 다시 회수한다.

### Schema 정본

- `docs/database-schema.md`에 `(jobId, attemptCount)` 복합 PK, `assetId`/`objectKey` unique, key/lease/terminal CHECK, `FOR UPDATE SKIP LOCKED`, 의도적인 no-FK cascade 생존 정책, committed/orphan terminal lifecycle을 문서화했다.

## TDD RED -> GREEN 증거

1. 실제 disposable PostgreSQL과 storage PUT/DELETE gate를 사용해 범용 cleanup이 pending attempt를 점유한 뒤 worker가 ready/review_required로 commit하고 object만 삭제하는 경쟁을 재현했다. RED는 최종 object set이 비어 `Expected: true, Received: false`로 실패했다. tombstone exclusion과 공통 잠금 순서 적용 뒤 동일 테스트가 GREEN이다.
2. kill/restart orphan 테스트를 15분 quiet policy로 변경했다. RED는 첫 cleanup 1분 뒤 늦은 PUT이 즉시 다시 삭제되어 `Expected set to contain object key, Received Set {}`로 실패했다. quiet period와 `cleanedAt` terminal 도입 뒤 1분에는 object가 유지되고 15분 final sweep에서 삭제되며 후속 sweep의 DELETE 횟수가 증가하지 않는 GREEN을 확인했다.
3. 기존 cleanup/worker 단위 테스트를 새 SQL lock 및 terminal ledger 계약에 맞춰 갱신했고 attempt exclusion SQL, Floor→asset 및 Floor→asset→attempt lock을 검증한다.

## 검증

- Prisma schema validate: passed
- Prisma client generate: passed
- focused Jest + disposable PostgreSQL: 15 suites passed, 187 tests passed, Linux 전용 1 test skipped, 실패 0
- PostgreSQL race/quiet-period integration: 6 tests passed, 실패 0
- `pnpm --filter @led-control/api typecheck`: passed
- `pnpm --filter @led-control/api build`: passed
- `git diff --check`: passed

## 변경 파일

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260917140000_floor_import_attempt_cleanup_terminal/migration.sql`
- `apps/api/src/floor-editor/floor-asset-cleanup.service.ts`
- `apps/api/src/floor-editor/floor-asset-cleanup.service.spec.ts`
- `apps/api/src/floor-import/floor-import-worker.service.ts`
- `apps/api/src/floor-import/floor-import-worker.service.spec.ts`
- `apps/api/src/floor-import/floor-import-attempt-cleanup.service.ts`
- `apps/api/src/floor-import/floor-import-attempt-cleanup.service.spec.ts`
- `apps/api/src/floor-import/floor-import.integration.spec.ts`
- `docs/database-schema.md`
- `.superpowers/sdd/2026-07-06-floor-editor-implementation/task-19.3-fix-round-2.md`

## 커밋

- 기준 SHA: `84bd5404`
- 커밋 제목: `fix: fence CAD import cleanup lifecycle`
- 최종 커밋 식별자: `84bd5404..HEAD`
- 이 보고서가 동일 commit tree에 포함되므로 최종 commit SHA를 파일 내용에 자기참조로 고정할 수 없다. 정확한 최종 SHA는 commit 직후 `git rev-parse HEAD` 검증 결과와 task 최종 요약에 기록한다.

기존 사용자/다른 작업의 web, orchestrator/spec/project-status, chart/research/output 변경은 수정하거나 stage하지 않는다.
