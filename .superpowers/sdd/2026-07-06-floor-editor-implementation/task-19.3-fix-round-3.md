# Task 19.3 Fix Round 3 보고서

## 상태

- 재검토 P2 1건 수정 완료
- `20260917140000_floor_import_attempt_cleanup_terminal`을 전용 disposable PostgreSQL migration integration suite에 포함
- 기존 migration SQL과 production 동작은 변경하지 않음

## 변경 내용

`apps/api/src/prisma/floor-import-attempt-cleanup-migration.integration.spec.ts`를 추가해 다음 계약을 실제 migration chain에서 검증한다.

1. `20260917130000_floor_import_attempt_cleanup`까지 배포하고 기존 tombstone 3종을 만든 뒤 terminal migration을 staged 적용한다. 기존 row와 prior checksum 보존 및 구버전 `lastCleanedAt`/`nextAttemptAt` writer 호환성을 확인한다.
2. 빈 disposable database에서 terminal migration까지 clean replay하고 prior/terminal migration의 정상 완료와 `cleanedAt` 생성을 확인한다.
3. `committedAt + cleanedAt`, `cleanedAt` without `lastCleanedAt`, active cleanup lease + `cleanedAt`을 각각 거부하고 lease가 해제된 유효 terminal update를 허용하는지 확인한다.
4. PostgreSQL catalog에서 복합 PK, attempt/key/lease/terminal CHECK, asset/key unique 및 due index, UTC defaults, lifecycle column nullability를 확인한다.
5. 기존 tombstone writer가 table lock을 보유한 상태에서 10초 lock timeout으로 migration이 실패할 때 column/CHECK/기존 row가 부분 변경되지 않는지 확인한다. writer 종료 후 실패 migration을 rolled-back resolve하고 같은 target 재시도가 성공하는지 검증한다.

## TDD RED -> GREEN

- RED: 테스트 target을 기존 `20260917130000`으로 둔 상태에서 terminal `cleanedAt` column을 요구했다. 실제 PostgreSQL catalog 결과가 `Expected: "1", Received: "0"`으로 실패해 새 migration이 suite 대상이 아니었음을 확인했다.
- GREEN: target을 `20260917140000_floor_import_attempt_cleanup_terminal`로 올리고 staged/clean/constraint/catalog/lock-timeout 회귀를 추가했다. 전용 suite 5 tests 및 기존 CAD migration suite와의 결합 실행 28 tests가 통과했다.

## 검증

- 전용 terminal migration integration: 1 suite, 5 tests passed
- 관련 migration integration: 2 suites, 28 tests passed
- Prisma schema validate: passed
- Prisma client generate: passed
- `pnpm --filter @led-control/api typecheck`: passed
- `git diff --check`: passed

## 변경 파일

- `apps/api/src/prisma/floor-import-attempt-cleanup-migration.integration.spec.ts`
- `.superpowers/sdd/2026-07-06-floor-editor-implementation/task-19.3-fix-round-3.md`

## 커밋

- 기준 SHA: `192af6b7`
- 커밋 제목: `test: cover CAD import cleanup terminal migration`
- 최종 commit SHA는 이 report를 포함하는 commit 생성 직후 `git rev-parse HEAD` 결과와 task 최종 요약에 기록한다.

기존 사용자/다른 작업의 문서, chart/research/output 변경은 수정하거나 stage하지 않는다.
