# Task 19.3 비동기 CAD import API/worker 구현 보고서

## 상태

- Task 19.3 API와 PostgreSQL lease worker 구현 완료
- create/get/list candidates/cancel/apply API, candidate read model, private object I/O, 3회 retry와 shutdown drain을 포함함
- import 단계에서는 `FloorImportCandidate`만 만들며 `Fixture`/`MeshNode`를 생성하거나 수정하지 않음
- 공유 worktree의 orchestrator 문서, 통계 코드, chart/research/output 산출물은 수정하거나 stage하지 않음

## API

- `POST /api/floors/:floorId/import-jobs`
  - manage 권한을 transaction 안에서 재검증한다.
  - Floor와 source `FloorAsset`을 함께 잠근 뒤 same floor, `original`, `ready`, cleanup 미시작, DWG/DXF MIME-format 일치를 검증한다.
  - DB partial unique constraint의 층당 활성 job 충돌을 안정적인 HTTP 409로 변환한다.
- `GET /api/floors/:floorId/import-jobs/:jobId`
  - private object key와 내부 실패 메시지를 제외한 job read model을 반환한다.
- `GET /api/floors/:floorId/import-jobs/:jobId/candidates`
  - 최대 1,000개의 strict candidate read model만 반환한다.
- `POST /api/floors/:floorId/import-jobs/:jobId/cancel`
  - queued/processing/review_required job을 terminal cancelled로 바꾸고 lease를 해제한다.
- `POST /api/floors/:floorId/import-jobs/:jobId/apply`
  - editor lease token hash, fence, DB clock expiry, expected revision을 잠근 row에서 검증한다.
  - rendered SVG metadata를 private storage에서 확인하고 accepted/rejected 후보, floor background, map revision snapshot, audit, job completion을 한 serializable transaction에 반영한다.
  - 기존 Fixture와 FloorMapObject는 읽어 revision snapshot에 보존하며 update/delete하지 않는다.

## Worker와 storage

- 기존 PostgreSQL worker 방식대로 `FOR UPDATE SKIP LOCKED`, owner/attempt/expiry fence, 30초 lease, 10초 heartbeat를 사용한다.
- queued job과 lease가 만료된 processing job을 회수하고 attempt 3회까지만 처리한다. 만료된 3회차는 네 번째 실행 없이 terminal failed로 정리한다.
- source object는 ledger의 MIME, byte size, SHA-256과 대조하면서 mode 0600 bounded temp file로 stream download한다.
- converter -> bounded ASCII DXF parser -> rule detector -> disabled AI detector -> bounded SVG renderer 순서로 실행한다.
- SVG를 private/no-store object로 저장하고 HEAD checksum/MIME/viewport metadata를 확인한 뒤 rendered `FloorAsset`과 candidate upsert를 fenced transaction으로 commit한다.
- candidate 좌표와 회전은 SVG viewport 좌표계로 투영한다. AI detector 주입은 `DisabledAiLightingSymbolDetector` 하나뿐이다.
- 실패/lease loss에서 temp directory와 원장 미등록 partial object를 정리한다. shutdown은 외부 작업을 abort하고 active run을 drain하며 job lease는 expiry recovery에 남기되 이미 PUT된 미등록 object는 삭제한다.
- floor asset cleanup의 후보 조회와 lock 후 재검증 모두 source/rendered import 참조를 제외한다.

## 운영 구성

- production은 `CAD_IMPORT_CONVERTER_MODE=linux`만 허용한다.
- converter executable과 JSON argv, absolute temp root가 없거나 Linux가 아니면 module boot가 fail-close한다.
- Linux converter는 Task 19.2의 repository-owned canonical `/usr/bin/prlimit` identity attestation과 hard file-size limit를 그대로 사용한다.
- 로컬 DXF 통과 adapter는 `CAD_IMPORT_CONVERTER_MODE=local-dxf-copy`를 명시해야 하며 production에서는 거부한다. mode가 없는 non-production module은 worker를 시작하지 않는다.

## TDD 증거

1. API/service, worker, module boot, storage, cleanup spec을 먼저 작성해 모듈/메서드 부재와 cleanup 보호 실패를 RED로 확인했다.
2. apply viewport metadata와 SVG 좌표 투영 테스트를 추가해 잘못된 고정 크기/원시 좌표 경로를 RED로 확인한 뒤 수정했다.
3. create와 cleanup claim 경쟁 테스트를 추가해 source row 잠금 부재를 RED로 확인한 뒤 Floor/asset 동시 lock으로 수정했다.
4. shutdown 중 SVG PUT 중단 테스트를 추가해 미등록 object 잔존을 RED로 확인한 뒤 cleanup과 lease recovery를 함께 GREEN으로 만들었다.
5. disposable PostgreSQL에서 active conflict/cancel key release, lease expiry 3회 recovery, apply atomicity와 기존 fixture/map object 보존을 검증했다.

## 최종 검증

- 전체 API Jest: 156 suites passed, 1,829 tests passed, 44 suites/479 tests environment-gated skipped, 실패 0
- Task 19.3 + asset/storage focused Jest: 13 suites passed, 151 tests passed, Linux 전용 1 test environment-gated skipped, 실패 0
- disposable PostgreSQL lifecycle: 3 tests passed
- module graph boot: passed
- `pnpm --filter @led-control/api typecheck`: passed
- `pnpm --filter @led-control/api build`: passed

전체 API 회귀 후 shutdown partial-object 회귀 1건을 추가했으며, 해당 worker spec과 위 focused suite/typecheck/build를 최종 코드에서 다시 실행했다.

## 변경 파일

- `apps/api/src/floor-import/floor-import.module.ts`
- `apps/api/src/floor-import/floor-import.controller.ts`
- `apps/api/src/floor-import/floor-import.service.ts`
- `apps/api/src/floor-import/floor-import-worker.service.ts`
- `apps/api/src/floor-import/floor-import-module.spec.ts`
- `apps/api/src/floor-import/floor-import-storage.spec.ts`
- `apps/api/src/floor-import/floor-import.service.spec.ts`
- `apps/api/src/floor-import/floor-import-worker.service.spec.ts`
- `apps/api/src/floor-import/floor-import.integration.spec.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/storage/object-storage.service.ts`
- `apps/api/src/floor-editor/floor-asset-cleanup.service.ts`
- `apps/api/src/floor-editor/floor-asset-cleanup.service.spec.ts`

## 후속 경계

- 실제 production converter image에서 GNU `prlimit` identity와 선택한 DWG binary를 확인하는 smoke test는 배포/Task 19.5 범위다.
- 대표 DWG별 변환 정확도, layer/block profile 조정, 렌더 시각 QA는 Task 19.5에서 수행한다.
- 후보 검토 UI와 apply 사용자 흐름은 Task 19.4 범위다.
- completed/cancelled 이력과 참조 asset의 장기 retention 정책은 별도 운영 정책이 필요하다. 처리 중 temp/partial object cleanup과 참조 중 asset 보호는 이번 task에 포함했다.

## 커밋

- 커밋 제목: `feat: add asynchronous CAD import workflow`
- 위 Task 19.3 파일만 포함한다.

## Fix Round 1 (2026-09-17)

### Review P1/P2 수정

- cleanup에서 `FloorAsset` 조회 오류와 조회 성공 후 `null`을 분리했다. 조회 오류와 ready asset은 object를 삭제하지 않으며, confirmed-null도 미임대 reconciliation tombstone을 확보한 경우에만 즉시 삭제한다.
- PUT 전에 deterministic `jobId-attempt-N.svg` key, pending rendered `FloorAsset`, no-FK `FloorImportAttemptCleanup` tombstone을 한 transaction으로 영속화한다. tombstone은 floor/job cascade 뒤에도 남아 kill/restart 및 늦게 완료된 PUT을 반복 회수한다.
- cleanup sweeper는 startup/60초 주기로 due tombstone을 `SKIP LOCKED` lease로 처리한다. object 삭제 뒤 asset row와 cleanup row를 다시 잠그고 유효한 cleanup owner를 확인한 경우에만 pending ledger를 정리한다.
- worker temp directory는 job/attempt identity를 포함하고 heartbeat가 mtime을 갱신한다. startup/periodic sweeper는 15분 이상 지난 소유 형식의 temp directory만 제거하며 shutdown에서 진행 중 sweep을 drain한다.
- apply 직전 private rendered object HEAD의 content-length, SHA-256 checksum, MIME, viewport metadata를 preflight ledger와 대조한다. apply transaction은 floor/job/source/rendered row를 함께 잠그고 asset id/key/MIME/size/checksum identity가 preflight와 동일한지 다시 확인한다.
- `FloorImportModule` HTTP integration에서 실제 `SessionAuthGuard`, `AuthService`, `SiteAccessService`, PostgreSQL을 사용해 unauthenticated 401, admin create, viewer read-only, 다른 tenant 404, transaction lock 중 admin 권한 회수 후 mutation 404 및 미생성을 검증한다.

### TDD RED -> GREEN

1. storage/apply 테스트에서 HEAD ledger 인자 부재와 locked checksum 변경이 통과하는 상태를 RED로 확인한 뒤 size/checksum/MIME 및 transaction identity 검증을 추가했다.
2. worker 테스트에서 PUT 전 attempt ledger 부재와 shutdown inline delete 경로를 RED로 확인한 뒤 durable reconciliation으로 전환했다.
3. cleanup 단위 테스트에서 DB read error 삭제 위험, tombstone 미확보 삭제, cleanup lease 상실 뒤 pending asset 삭제를 각각 RED로 확인하고 owner-fenced cleanup으로 수정했다.
4. disposable PostgreSQL kill/restart 테스트에서 floor cascade 후 tombstone claim이 SQL `NULL` 의미 때문에 누락되는 RED를 확인하고 deleted-job tombstone 회수 조건을 수정했다.
5. 실제 HTTP 권한 테스트로 admin/viewer/tenant/session 경계와 precheck 이후 권한 회수 경쟁을 검증했다.

### Fix Round 1 검증

- Prisma schema validate/client generate: passed
- focused + disposable PostgreSQL: 15 suites passed, 186 tests passed, Linux 전용 1 test skipped, 실패 0
- 전체 API Jest: 157 suites passed, 1,840 tests passed, 44 suites/481 tests environment-gated skipped, 실패 0
- module graph boot (`floor-import-module.spec.ts`): passed
- `pnpm --filter @led-control/api typecheck`: passed
- `pnpm --filter @led-control/api build`: passed

### Fix Round 1 변경 파일

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260917130000_floor_import_attempt_cleanup/migration.sql`
- `apps/api/src/floor-import/floor-import.tokens.ts`
- `apps/api/src/floor-import/floor-import-attempt-cleanup.service.ts`
- `apps/api/src/floor-import/floor-import-attempt-cleanup.service.spec.ts`
- `apps/api/src/floor-import/floor-import-worker.service.ts`
- `apps/api/src/floor-import/floor-import-worker.service.spec.ts`
- `apps/api/src/floor-import/floor-import.service.ts`
- `apps/api/src/floor-import/floor-import.service.spec.ts`
- `apps/api/src/floor-import/floor-import-storage.spec.ts`
- `apps/api/src/floor-import/floor-import.integration.spec.ts`
- `apps/api/src/floor-import/floor-import.module.ts`
- `apps/api/src/storage/object-storage.service.ts`

공유 worktree의 orchestrator/spec/project-status 문서와 chart/research/output 산출물은 수정하거나 stage하지 않았다. 이번 fix commit은 위 Task 19.3 파일과 이 report만 포함한다.
