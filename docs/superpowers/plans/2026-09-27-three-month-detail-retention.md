# Three-Month Detail Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 중앙 DB의 고객 표시 상세 기록을 최근 3 calendar months로 제한하고, 완료된 명령의 원문을 제거하면서 중복 실행 방지에 필요한 최소 상태를 보존한다.

**Architecture:** 기존 `Command` 행과 FK를 유지하고 `contentRedactedAt`으로 내용 제거를 명시한다. 조회 기간은 물리 행 purge·새 recovery POST와 분리한다. DB UTC 기준 bounded worker는 종료·파생 사본 정리를 입증한 후보만 한 transaction에서 비식별화하며 불명확한 명령·활성 override는 별도 안전 예외로 보존한다.

**Tech Stack:** NestJS, Prisma 6/PostgreSQL, React/Vitest/Playwright, 기존 disposable PostgreSQL harness.

**Spec:** [2026-09-27-three-month-detail-retention-design.md](../specs/2026-09-27-three-month-detail-retention-design.md)

## Global Constraints

- 현재 3 calendar months, 중앙 DB UTC transaction clock, 경계의 행은 보존한다. 90일 치환·1년 요금제 구현은 금지한다.
- `Command` 물리 DELETE·미설치 보호 cutover·`COMMAND_RETENTION_PURGE_ENABLED`·새 recovery POST/Set은 활성화하지 않는다. 기존 수동 Set·3개월 안 상태 확인, 미해결 잠금을 보존한다.
- 읽기 제한은 정리 backlog와 분리하되 오래된 미확정 명령의 별도 확인 경로가 없는 상태에서는 운영 rollout을 승인하지 않는다. 조회와 같은 내용을 반환하는 멱등 재요청도 만료 경계를 지킨다. 정리 불확실 후보는 skip+관측, 원문 부분 삭제 금지.
- 기존 dirty worktree는 사용자 소유다. 담당자는 소유 hunk만 선택 stage·검증·review 후 commit한다. 스키마는 `docs/database-schema.md`, 메뉴 동작은 영향받는 `docs/menus` 문서를 같은 선택본에 갱신한다.

## Review Focus

1. 삭제된 사용자의 `(siteId, requestedBy=NULL, clientRequestId)` 중복 요청은 새 Set을 만들지 않아야 한다 — Task 2 DB 경합 테스트.
2. 3개월 이전 `unknown`이 일반 이력 밖이어도 대상 제어 잠금이 풀리지 않고 운영자가 예외 건을 찾을 수 있어야 한다 — Task 1 preflight·Task 5 UI 테스트.
3. 이미 완료된 명령의 늦은 ACK나 manual event replay가 제거한 상세를 다시 쓰거나 조명 상태를 덮지 않아야 한다 — Task 2·3 disposable PG 테스트.
4. 비UTC DB session/API host ±60초·월말·정확 cutoff가 조회와 정리에서 일치해야 한다 — Task 1·4 DB 테스트.
5. 오래된 상세의 410, 타 현장/없는 ID의 404, 401/403/500 뒤의 cached 화면과 열린 화면의 시간 경과는 대상·밝기·재적용 동작을 드러내지 않아야 한다 — Task 1·5 HTTP/Web 테스트.

---

### Task 1: 명령 상세 조회만 독립적인 3개월 창으로 전환

**Files:** Modify `apps/api/src/commands/command-history-rollout.ts`, `command-recovery-rollout.guard.ts`, `command-status.service.ts`, `commands.service.ts`의 멱등 재응답 경계, 해당 `.spec.ts`, `command-history-db-clock.integration.spec.ts`, 운영 조회 경계용 read-only preflight 및 `docs/runbooks/production-api-web-deployment.md`, `docs/menus/control.md`의 소유 hunk.

**Interfaces:** `commandHistoryGetDbClockRequested(): boolean`은 `COMMAND_HISTORY_RETENTION_ENABLED=1`만 읽는다. `commandHistoryGetReadBoundary(db, siteId)`는 `{ generatedAt: Date; retainedFrom: Date; retentionEnabled: true }`를 반환한다. 기존 POST/Set용 `commandHistoryRetentionReady`와 recovery/purge hard-off는 변경하지 않는다.

- [x] **Step 1: RED 테스트 작성.** HISTORY만 ON·RECOVERY/PUBLISHER OFF에서 서버 시작 허용, DB UTC cutoff 직전/정각 목록·상세 410/포함, 만료 cursor 400, 타 현장 404, host ±60초·session 3종, old `unknown`으로 site 전체가 legacy 목록으로 되돌아가지 않음을 고정한다. 만료된 기존 `clientRequestId`로 POST/Set을 재시도하면 payload-free 409·Set/outbox 0, 최근 멱등 재시도는 기존 응답인 것을 HTTP/service로 고정한다. 컷오프 이전 unheld `pending`/`unknown` 한 건에서 rollout preflight 실패, 0건에서 통과, 검사 오류에서 fail-closed를 검증한다. 기존 안전 overlap 차단 회귀도 추가한다.
- [x] **Step 2: RED 확인.** `pnpm --filter @led-control/api exec jest src/commands/command-history-rollout.spec.ts src/commands/command-status.service.spec.ts src/commands/command-recovery-rollout.guard.spec.ts --runInBand`와 opt-in disposable PG spec에서 현재 joint gate 실패를 확인한다.
- [x] **Step 3: 최소 구현.** GET-only flag/clock 경계를 분리하고 `CommandStatusService`의 list/detail에 DB 시각을 사용한다. `CommandsService.findIdempotentCommand`/`toCreateResponse`도 recovery readiness와 독립된 같은 DB cutoff로 만료된 재응답을 차단한다. 인가 먼저, 404 cloak, payload-free 410/409, 기존 cursor 400 및 no-store를 유지한다. read-only preflight는 같은 중앙 DB 시계로 컷오프 이전의 Hold 없는 미확정 명령 수와 식별 가능한 증거만 출력하고 양수/오류에서 실패한다. 배포 경로는 해당 검사 통과 증거가 없으면 HISTORY flag ON을 거부하고 기본 OFF를 유지한다.
- [x] **Step 4: GREEN·선택 통합.** 위 focused+PG, 전체 API test/typecheck/build, 소유 파일 diff-check를 통과하고 독립 리뷰 뒤 정확 선택본 commit.

Task 1 검증 메모: 집중·일회용 PG·배포 계약 테스트와 API typecheck/build, 독립 리뷰가 통과했다. Task 3까지 포함한 선택 커밋만의 전체 API 235 suites·2,839 tests도 통과해 커밋 코드의 전체 GREEN을 확인했다. 공유 dirty 작업 트리의 별도 `data-retention.service.spec.ts` 5개 실패는 최종 통합 관문에서 따로 해결한다.

### Task 2: 명령 내용 제거 상태와 API 소비자 차단

**Files:** Modify `apps/api/prisma/schema.prisma`, new forward migration, `apps/api/src/commands/{commands.service,command-verification.service,command-status.service}.ts`와 specs, `apps/api/src/mqtt/mqtt.service.ts`의 해당 ACK hunk/spec, new disposable PG spec, `docs/database-schema.md`·`docs/menus/control.md` 소유 hunk.

**Interfaces:** `Command.contentRedactedAt: DateTime?`; 새 행은 현재 payload 필수, 비식별 행은 `targetType/targetFixtureIds/brightness/requestFingerprint/errorMessage`가 없음. DB CHECK는 두 상태의 중간값을 거부한다. 중복 키에 비식별 행이 발견되면 `409 command_request_expired`, 상태 확인은 내용 없는 `410 command_expired`와 발행 0건이다.

- [x] **Step 1: RED 테스트 작성.** SQL의 반쪽 비식별 INSERT/UPDATE 거부, 정상 Set 생성 불변, 동일 키 비식별 재POST 409·Set/outbox 0, 삭제된 user의 orphan key 재사용 409·Set 0(동시 2요청 포함), 옛 Get 410·Get 0, late ACK의 원문 재생성 0을 검증한다.
- [x] **Step 2: RED 확인.** focused Jest와 opt-in disposable PG에서 현재 `contentRedactedAt` 부재·orphan 중복 반례를 확인한다.
- [x] **Step 3: 최소 구현.** 새 nullable 내용 필드+`contentRedactedAt`/DB CHECK를 순방향 migration에 추가한다. `clientRequestId` UUID와 요청자 내부 ID는 중복 방지에만 유지하고 API에서 숨긴다. User 삭제로 NULL인 legacy 키는 site-scoped 직렬화 guard로 보수적 충돌 처리한다. Set·Get·ACK 소비자는 비식별 상태를 먼저 검사한다. 기존 HMAC purge dual-write를 전제로 하지 않는다.
- [x] **Step 4: GREEN·선택 통합.** Prisma validate/generate, focused+PG, 전체 API test/typecheck/build, 메뉴·schema 문서 및 독립 리뷰 후 정확 선택본 commit. 이 단계는 비식별 worker를 켜지 않는다.

Task 2 검증 메모: 선택본 312 passed/1 skipped, 신규 PostgreSQL·HTTP 12 passed, Prisma validate/generate·API typecheck/build와 독립 리뷰가 통과했다. Task 3까지 포함한 선택 커밋의 전체 API도 235 suites·2,839 tests를 통과했다. 공유 dirty 작업 트리의 별도 retention 테스트 5개 실패는 최종 관문에 남아 있다.

### Task 3: 완료 후보의 raw 사본 정리 helper

**Files:** Create `apps/api/src/retention/command-detail-redaction.ts`와 `.spec.ts`/disposable PG spec; approved derived-parent tombstone forward migration/`schema.prisma` and exact-replay helper; modify only necessary owned hunks in `apps/api/src/automation/automation-mqtt-consumer.service.ts`, `apps/api/src/mqtt/mqtt.service.ts`, `docs/database-schema.md`, `docs/menus/{control,monitoring}.md`. 기존 `manual-execution-retirement.ts`/활동 source backfill은 감사하되 보호 cutover를 호출하지 않는다.

**Interfaces:** `redactSettledCommandDetails(tx: Prisma.TransactionClient, commandId: string, retainedFromUtc: Date): Promise<"redacted" | "already_redacted">`; 불확실 후보는 `CommandDetailRedactionBlocked(reasonCode)`를 던져 transaction 전체를 rollback한다. 호출자는 같은 transaction에서 원본 행을 잠근다. helper는 새로운 Set/Get을 발행하지 않는다.

- [x] **Step 1: RED 테스트 작성.** 종료 `outcome`+모든 dispatch terminal/outbox settled/no lease/no Hold/no active override에서 원본 및 결과·wire/outbox·수동 실행·활동 source·완료 재위촉 snapshot raw copy가 남지 않음을 검증한다. 하나라도 미확정·raw 사본 검증 실패면 전부 rollback, 성공 뒤 manual replay·late ACK로 복사본 재생성 0을 검증한다.
- [x] **Step 2: RED 확인.** 신규 helper spec과 `COMMAND_DETAIL_REDACTION_TEST=1` disposable PG spec에서 raw 사본 잔존 반례를 확인한다.
- [x] **Step 3: 최소 구현.** 기존 부모/FK는 유지하고 안전 종료 사본만 같은 transaction에서 제거·비식별화한다. 기존 full-row purge staging/보호 SQL을 그대로 재사용하지 않는다. 활성 override·미해결 명령은 이유와 함께 skip한다.
- [x] **Step 4: GREEN·선택 통합.** focused+PG, 관련 automation/MQTT 회귀, 전체 API test/typecheck/build 및 독립 리뷰 후 정확 선택본 commit.

Task 3 검증 메모: 선택 커밋만의 전체 API 235 suites·2,839 tests, 신규 일회용 PG 18/18, 집중 150 passed/1 skipped, typecheck/build와 독립 리뷰가 통과했다. legacy ACK 귀속 불가·증명/키 부재는 안전하게 건너뛰며 운영 rollout은 별도다.

### Task 4: 기본-OFF bounded 내용 정리 worker

**Files:** Create `apps/api/src/retention/command-detail-retention.service.ts`와 specs/PG spec; modify `apps/api/src/retention/retention.module.ts`와 `docs/database-schema.md`, `docs/menus/control.md` 소유 hunk.

**Interfaces:** `runBatch(maxCandidates = 100): Promise<{ examined: number; redacted: number; skippedByReason: Record<string, number>; overdueCount: number }>`; `COMMAND_DETAIL_REDACTION_ENABLED` 기본 OFF. Task 3 helper를 호출하며 physical purge flag를 읽거나 켜지 않는다.

- [ ] **Step 1: RED 테스트 작성.** OFF 쓰기 0, DB UTC `< retainedFrom`만 대상, 정각 보존·월말/비UTC session, 1,001건의 반복 수렴과 재실행 멱등, 두 worker 경합/rollback, 100개 오래된 blocked·이미 비식별화된 후보 뒤 eligible 행이 굶지 않는지, 예외·최고 경과 건수 관측을 고정한다.
- [ ] **Step 2: RED 확인.** focused Jest+opt-in PG에서 worker 부재/경계 반례를 확인한다.
- [ ] **Step 3: 최소 구현.** `contentRedactedAt IS NULL`인 후보만 `FOR UPDATE SKIP LOCKED`로 bounded 선택한다. 동일 transaction helper와 기존 `CommandRetentionAttempt.retryAfterAt`의 별도 detail reason을 재사용해 blocked 후보가 뒤 행을 굶기지 않게 한다. 실패 transaction rollback 뒤 이유를 기록한다. 운영 DB migration·flag ON은 별도 백업/dry-run/시계·raw-copy 감사 뒤로 남긴다.
- [ ] **Step 4: GREEN·선택 통합.** focused+PG, 전체 API test/typecheck/build, 메뉴/schema 문서·독립 리뷰 후 정확 선택본 commit.

### Task 5: 제어·모니터링 화면의 만료/실패 표시

**Files:** Modify `apps/web/src/features/control/{ControlView,CommandHistoryPanel,CommandVerificationCases}.tsx`, `apps/web/src/api/commands.ts`의 조회 재검증 설정과 tests, `apps/web/src/features/monitoring/{MonitoringLogDrawer,MonitoringLogTicker}.tsx`와 tests, `docs/menus/{control,monitoring}.md` 소유 hunk.

**Interfaces:** 410 `command_expired`만 ‘상세 보관 종료’로 표현한다. 등록되지 않은 case POST 두 기능은 준비 전 비활성+이유 표시하며 기존 최근 명령의 `POST /commands/:id/status-checks`는 유지한다.

- [ ] **Step 1: RED 테스트 작성.** 열린 상세의 refetch 410/404/401/403/500 후 대상·밝기·재실행 버튼/POST 0, terminal 상세·목록 및 `ControlView.terminalResult`를 열린 채 3 calendar months 경과할 때 fake timer로 내용·동작 숨김과 서버 재검증(포커스·재연결·오프라인 오류 포함), cached case로 잠금 해제 0, fresh exact-case 0건에서만 해제, 미등록 case action 버튼 비활성, 모니터링 cursor 410과 3개월 문구를 고정한다.
- [ ] **Step 2: RED 확인.** `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/CommandVerificationCases.test.tsx src/features/monitoring/MonitoringLogDrawer.test.tsx`에서 기존 stale/case 버튼 계약 실패를 확인한다.
- [ ] **Step 3: 최소 구현.** 기존 공통 Button/카드 재사용, 404를 만료로 오해하지 않으며 refetch 중 stale payload를 숨긴다. terminal 결과의 polling 중단과 `ControlView.terminalResult`에 복사된 상세 각각에 보관 기한/서버 재검증/만료 시 폐기 정책을 적용하고 열린 drawer/list가 경계를 넘으면 즉시 payload를 숨긴다. 1년 tier UI는 추가하지 않는다.
- [ ] **Step 4: GREEN·선택 통합.** focused+Web 전체 Vitest/typecheck/build/ui:check, `pnpm --filter @led-control/web exec playwright test e2e/monitoring-control-flow.spec.ts --project=chromium`, 실제 API proxy의 401/404/410/최근 명령 status-check smoke, 독립 리뷰 후 정확 선택본 commit.

## Final integration gate

- [ ] 다섯 선택 커밋과 기본-OFF 상태를 확인하고 API/Web/shared 전체·일회용 PG·실제 API↔Web HTTP/Chromium·문서 diff를 독립 재실행한다. 첫 Web 전체 간헐 실패는 새 재현 증거 없이 제품 변경 근거로 쓰지 않는다.
- [ ] 운영 전 백업/마이그레이션 dry-run, 기존 host-stamped 행·오래된 미확정 case·raw 사본 후보/예외 수를 기록한다. unresolved 예외가 자동 해결될 때까지의 제한 보존을 승인 spec대로 노출한다. 중앙 DB 적용·flag ON·RF/HIL 및 별도 case POST는 이 계획 완료와 구분해 보고한다.
