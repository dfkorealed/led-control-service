# 기존 BIO 등록 현재 재검증 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 B의 ID·밝기·이력을 보존하면서 현재 장치의 새 GET 결과를 근거로 등록 후보 상태만 감사와 함께 수복한다.

**Architecture:** 독립 registration 목적의 strict Shared 계약과 durable API operation을 먼저 구현하고 Gateway가 이를 소비한다. 현재 graph/권한 재검증, 결과 수용, 명시적 apply를 분리하며 기존 sensor-mode/terminal 의미는 바꾸지 않는다. 총괄은 결과·체크리스트를 통합하고 backend→gateway→독립 QA 순서로 배정한다.

**Tech Stack:** 기존 Node 22, pnpm 9.15.0, TypeScript, Zod, NestJS, Prisma/PostgreSQL, MQTT QoS 1, Gateway CommandJournal/StateEventOutbox, Jest/Vitest. 의존성 추가 없음.

**Spec:** `docs/superpowers/specs/2026-10-06-bio-registration-revalidation-design.md` — 2026-10-06 사용자 상세 설계·실행 승인. **Tasks1~6 소프트웨어 구현·집중 검증·독립 최종 검토 완료. 최종 신규 DB108/108·직접 회귀5/5·API/Gatewaytypecheck/build0, 새C0/I0/M0·기존 pnpm 경고M1. 운영 DB·실제 B 수복·감지/독립 건강 공급은 미완료이며 제품 OFF를 유지한다.**

## Global Constraints

- 초기 범위는 조명 한 개의 commission 관리자 API. 신규 등록·삭제/재등록·일괄 backfill·고객용 화면·BlueZ 전체 제거는 제외한다.
- Fixture/정식 MeshNode/등록 후보 ID, 이름·좌표·밝기·전원·그룹·명령 및 등록 이력은 보존한다.
- `purpose: "bio_registration_revalidation"`, `operation: "query"`; command TTL 최대 **30초**, owned 조회 budget **8초** 이내, `applyDeadlineAt=requestedAt+120초`.
- observed의 모든 mode에 `requestedAt ≤ occurredAt ≤ expiresAt`, `receivedAt < expiresAt`, `occurredAt ≤ receivedAt+1초`를 동일 적용한다.
- 수복은 **등록 후보 status만** 변경한다. identifyState/session/terminal/ledger/원래 command/Fixture 출력은 변경하지 않는다.
- 과거 completed 원문 합성, sensor-mode BIO-only/verified 조건 완화, 센서 profile/healthy/supported·제품 ON은 금지한다.
- 실제 조회도 discovery/GET 통신이다. 운영 migration·배포·원본 서비스 변경·장비 조회·분류·머지는 별도 현재 환경/시간창 관문이며 옛 START를 재사용하지 않는다.
- 공유 계약은 backend 한 역할이 먼저 생산·검증하고 API/DB를 완성한 뒤 Gateway가 소비한다. 같은 파일/계약 병렬 변경 금지.
- leaf 검증 전 동일 checkout에서 `pnpm workspace:prepare`; Shared 변경 후 다시 준비한다. 이미 검증한 전체 저장소 suite와 무관 UI/성능/실장비 시험을 반복하지 않는다.

## Review Focus

1. 인증서 notBefore/notAfter 경계·관리자 권한 철회·Gateway 재배정: 과거 성공 조회라도 현재 요청/apply는 거부한다. Task 2/3/4 경계 테스트.
2. Fixture ID와 canonical node ID가 다른 정상 graph: 정확한 매핑은 허용하고 두 ID를 동일하다고 가정하지 않는다. Task 2/5 테스트.
3. 다른 목적/옛 ACK·전체 payload 일부만 다른 재전달: 신규 proof를 소비하거나 신규 outbox를 지우지 않는다. Task 1/3/5 테스트.
4. RF 완료 직전 transport 교체·종료/clock 철회 및 durable write 실패: observed/수복을 만들지 않고 원장을 보존한다. Task 3/5 테스트.
5. scan/등록/다른 apply의 양방향 경합과 AuditLog 실패: 상태만 변경되거나 감사만 추가되지 않으며 교착 없이 직렬화/rollback한다. Task 4 테스트.

---

## 파일 책임과 계약

- Shared: `packages/shared/src/bio-registration-revalidation-contracts.ts` 및 `.test.ts`, `src/index.ts` — strict 입력/command/result/ACK, topic, 목적 전용 canonical JSON/ACK matcher. 기존 계약 파일 수정 없음.
- Backend 등록: `apps/api/src/registration/bio-registration-revalidation.service.ts`, `.service.spec.ts`, `bio-registration-revalidation-binding.ts`, `.spec.ts` — 현재 graph·권한·원 provision 근거·잠금·operation/수복. 기존 classification의 Gateway 인증 함수만 공통 helper로 추출하고 역사적 evidence 조건은 보존한다.
- DB: `apps/api/prisma/schema.prisma`, 새 `prisma/migrations/20261006120000_bio_registration_revalidation/migration.sql`, `docs/database-schema.md` — additive operation/제약/Fixture relation. 기존 migration 수정/운영 migrate dev 금지.
- Backend 전달: `apps/api/src/mqtt/bio-registration-revalidation-publisher.service.ts`, `.spec.ts`, `mqtt.service.ts`, `mqtt.module.ts`, `mqtt-shutdown-coordinator.service.ts` 및 대응 기존 spec — 명령 lease/전달, 독립 ACK의 내구 수용·재전송, shutdown drain.
- 관리자 라우트: 기존 `registration.controller.ts`, `registration.module.ts`, `registration.controller.spec.ts` — 새 정적 경로를 기존 `:sessionId`보다 앞에 둔다. service는 MqttModule에서 단일 제공/export하고 RegistrationModule이 import하여 순환 import를 만들지 않는다.
- 분류: 기존 `bio-classification-reconciliation.service.ts`, `.service.spec.ts`, `.integration.spec.ts` — applied current-device evidence 표기만 보완; 기존 provisioned/confirmed 및 A/B 원자 검증 유지.
- Gateway: 새 `apps/gateway/src/commands/bio-registration-revalidation-handler.ts`, `.test.ts`; 기존 `command-journal.ts/.test.ts`, `state/state-event-outbox.ts/.test.ts`, `index.ts`, `index.test.ts`, `runtime/gateway-mqtt-runtime.test.ts` — 별도 kind/복구·전체 ACK hash·조회 수명. low-level adapter 수정이 필요하면 기존 `bio-usb-dongle-adapter.ts/.test.ts` 안에서 query 재검증만 보완한다.
- Broker 소프트웨어 계약: 기존 `infra/mosquitto.acl.example`, `scripts/dev-runtime.mjs`, `.test.mjs`, `scripts/dev-mqtt-acl.integration.test.mjs` — own-Gateway 신규 command/result/ACK 권한만 추가. 실제 broker reload 없음.
- 통합: 새 `apps/api/test/bio-registration-revalidation.integration.spec.ts`, 기존 `test/support/disposable-postgres.ts` 재사용 — 별도 opt-in `BIO_REGISTRATION_REVALIDATION_DISPOSABLE_POSTGRES=1`, ambient DB URL을 사용하지 않는다.
- 문서: 이 계획, 기존 BIO 펄스 계획 Task9, `docs/project-status.md`, 메뉴 `settings/control/monitoring.md`. 총괄이 담당 검증 결과를 취합해 갱신하며 소프트웨어/실장비를 분리한다.

## Task 1: 독립 Shared wire 계약 — 담당 backend

**상태:** 완료(Shared 소프트웨어), `e902a393`, 신규32+기존6=38PASS·typecheck/build/consumer 준비0, 독립 Spec✅/Quality Approved·C0/I0/M0. Node24 검증이며 Node22 parity/실장비는 확인하지 않았다. 아래 단계는 모두 이 증거로 완료했다.

**Files:** Shared 책임에 열거한 새 2개 파일과 `packages/shared/src/index.ts`.

**Interfaces:**
- Produces: `bioRegistrationRevalidationRequestSchema/CommandSchema/ResultSchema/AckSchema`, 타입 `BioRegistrationRevalidationRequest/Command/Result/Ack`.
- `bioRegistrationRevalidationTopics.command/result/ack(siteId: string, gatewayId: string): string`는 설계의 정확한 세 topic을 반환한다.
- `bioRegistrationRevalidationCanonicalJson(value: unknown): string`는 객체 key 재귀 정렬·배열 순서 보존 JSON. API/Gateway는 이 문자열의 SHA-256로 `sha256:<64 lowercase hex>` hash를 만든다. `deviceIdentityHash`만 prefix 없는 64 hex다.
- `matchesBioRegistrationRevalidationAck(result: BioRegistrationRevalidationResult, ack: BioRegistrationRevalidationAck, resultPayloadHash: string): boolean` — 전체 scope/identity/sequence/hash 비교. 기존 state ACK와 교환 불가.

- [x] **Step 1: RED 테스트 작성.** `it.each(["sensor", "force-on", "force-off"])`에서 observed parse 성공; query 외 operation/다른 purpose/brightness/modeVerified/native UUID/unknown key, TTL0·30001ms, unicast0·0x8000, unsafe sequence는 실패한다.
  ```ts
  expect(commandSchema.safeParse({ ...validCommand, operation: "ensure_sensor" }).success).toBe(false);
  expect(commandSchema.safeParse(withTtl(validCommand, 30_000)).success).toBe(true);
  expect(matches(result, { ...ack, payloadHash: otherHash }, hash)).toBe(false);
  ```
  테스트 alias는 위 export를 import하며 `withTtl(command, ms)`는 테스트 내부 UTC 시간 fixture 함수다. ACK의 모든 identity 필드를 한 개씩 바꾸는 table test, key 순서만 다른 payload의 canonical JSON 동일성도 고정한다.
- [x] **Step 2: RED 실행.** `pnpm --filter @led-control/shared exec vitest run src/bio-registration-revalidation-contracts.test.ts` → 신규 export/schema 부재로 FAIL.
- [x] **Step 3: 계약 구현.** command/result 공통 identity는 설계 그대로이며 실패 errorCode는 기존 고정 집합 `MODE_GET_UNCONFIRMED|COMMAND_EXPIRED|GATEWAY_RESTART|UNSUPPORTED_ADAPTER|GATEWAY_SHUTDOWN|GATEWAY_CLOCK_UNTRUSTED`. ACK는 version2/purpose/full identity/eventId/sequence/`payloadHash`/`ingestedAt`/status=`ingested|duplicate|stale_checkpoint` strict 객체다. result에는 requestedAt/expiresAt 없이 occurredAt을 사용한다.
- [x] **Step 4: GREEN.** 동일 신규 테스트 + `pnpm --filter @led-control/shared exec vitest run src/bio-sensor-mode-contracts.test.ts` 및 Shared typecheck/build → exit0. export를 독립 검토하고 consumer용 `pnpm workspace:prepare`를 실행한다.
- [x] **Step 5: commit·독립 검토.** 정확 Shared 파일만 stage, `feat(shared): add BIO registration revalidation contracts`. 소스 커밋의 독립 검토 승인 뒤에만 API 소비 구현을 시작했다.

## Task 2: additive DB와 관리자 요청/현재 binding — 담당 backend

**상태:** 완료(backend 요청/조회 소프트웨어), `04e8c31b`. 신규 DB35+unit6=41PASS·직접 회귀55PASS·Prisma generate/typecheck/diffcheck0, 독립 Spec✅/Quality Approved·C0/I0/M1(기존 pnpm config 경고). 운영 DB가 아닌 일회용 PostgreSQL로만 신규 schema/create/get을 검증했다. clock attestor 미연결은 거부하며 실제 운영 수복은 아직 실행하지 않았다.

**Files:** DB, binding/service, controller/module 책임 파일; `apps/api/test/bio-registration-revalidation.integration.spec.ts` 첫 DB·create/get 사례; 기존 classification 인증 helper 소비 변경.

**Interfaces:**
- `BioRegistrationBinding`은 `{ siteId, gatewayId, floorId, fixtureId, nodeId, sessionId, discoveredNodeId, originalProvisionCommandId, originalProvisionPayloadHash, assignmentVersion, deviceIdentityHash, meshAddress }`다. snapshot hash는 Task1 canonical JSON으로 계산한다.
- `authorizeBioRegistrationGateway(tx: Prisma.TransactionClient, scope: {siteId: string; gatewayId: string; expectedAssignmentVersion: number}, now: Date): Promise<void>`를 binding 파일로 추출한다. 현재 claim/inventory 및 active/unrevoked/notBefore≤now<notAfter 검사는 기존 classification과 동일하다.
- `loadLockedBioRegistrationBinding(tx: Prisma.TransactionClient, scope: {siteId: string; gatewayId: string; fixtureId: string; expectedAssignmentVersion: number}, requiredStatus: "discovered" | "provisioned", now: Date): Promise<BioRegistrationBinding>` — 정확 graph/confirmed/native/provision command와 보존된 receipt/ledger가 있으면 exact 일치 검사. status를 과거 completed 근거로 해석하지 않는다.
- `BioRegistrationRevalidationService.create(user: AuthenticatedUser, input: unknown): Promise<BioRegistrationRevalidationView>`와 `get(user: AuthenticatedUser, commandId: string): Promise<BioRegistrationRevalidationView>`.
- `BioRegistrationRevalidationView`은 `{ commandId, siteId, gatewayId, fixtureId, status: "pending"|"observed"|"unknown"|"timed_out", observedMode: "sensor"|"force-on"|"force-off"|null, requestedAt, expiresAt, applyDeadlineAt, supersededAt, appliedAt }`; 시간 값은 UTC string/nullable, raw binding/native/cert/payload 노출 없음.

- [x] **Step 1: RED DB/create/get 테스트.** 일회용 DB에 기존 B형 graph를 seed하는 테스트 내부 `seedRegisteredGraph({status, fixtureNodeIdsDiffer})` 사용. ID가 다른 정상 node로 create → pending, TTL30000ms/apply120000ms, immutable command/snapshot 확인. 다른 actor/site, authority 만료·미개시·폐기, 잘못된 배정/hash/address/identify command·unconfirmed·진행 중 상충 등록은 거부한다. 동일 actor/clientRequestId·동일 입력은 같은 command/원기한, 다른 입력은 conflict; 새 요청은 미소비 이전 row만 supersede한다. foreign requester GET 및 동적 `:sessionId` 오매칭은 거부한다.
  ```ts
  expect(created.commandId).toBe((await service.create(admin, sameRequest)).commandId);
  expect(row.applyDeadlineAt.getTime() - row.requestedAt.getTime()).toBe(120_000);
  expect(await readProtectedFixtureState()).toEqual(before);
  ```
  `readProtectedFixtureState()`는 같은 DB에서 Fixture/Node/후보와 명령·그룹·이력을 읽는 테스트 내부 snapshot 함수다.
- [x] **Step 2: RED 실행.** `BIO_REGISTRATION_REVALIDATION_DISPOSABLE_POSTGRES=1 pnpm --filter @led-control/api exec jest test/bio-registration-revalidation.integration.spec.ts --runInBand -t 'schema|create|get'` → 새 model/service/route 부재 FAIL. opt-in 시 PostgreSQL tools 부재는 SKIP 아닌 실패.
- [x] **Step 3: DB·binding 구현.** 새 operation row는 설계 필드 전부, 추가 `proofAcceptedAt: Date|null`, `auditId: string|null`를 갖는다. status CHECK, result/hash/event 동시 null 또는 동시 존재, observed는 proofAcceptedAt/result/evidence 일치, appliedAt/auditId 동시 존재, assignment>0·hash/주소 형식·UTC 기한 및 유일성 제약. Fixture/site 복합 FK의 cascade/restrict는 SensorModeOperation을 따른다. auditId는 감사 삭제를 유발하지 않는 참조로 결속한다. `docs/database-schema.md` 갱신. migration은 새 SQL만 작성해 disposable cluster에서 deploy; 운영 `prisma:migrate` 실행 금지.
- [x] **Step 4: create/get 구현.** 현재 commission과 membership→Site→registration domain→native advisory→canonical node/Fixture→operation lock 순서. Gateway/cert authorization 잠금은 Floor 잠금 이후에만 획득한다. create는 기존 `CommandDbClockHealth.assertHealthy(tx): Promise<Date>`를 사용해 서버 소유 requestedAt을 얻고 기한을 고정한다. 실제 provider가 없으면 fail-closed로 거부하며 local clock을 신뢰 근거로 대체하지 않는다. get도 현재 귀속/commission/requester를 검사하며 applied row의 현재 provisioned 상태는 허용한다. 관측 mode는 proofAcceptedAt이 있는 경우에만 공개한다. 정적 POST/GET 경로와 단일 DI provider 연결. requester 중복 retry는 현재 권한/binding 재검증 후 기존 row 반환, 기한 연장 없음.
- [x] **Step 5: GREEN.** 같은 DB 선택 + `pnpm --filter @led-control/api prisma:generate`, API typecheck, binding/service/controller spec → exit0; migrate deploy 성공과 필수 DB 사례 실제 실행 수 기록. classification 기존 인증 경계 회귀도 실행한다.
- [x] **Step 6: 독립 검토·commit.** API/DB·DB 문서와 해당 메뉴/상태를 함께 반영, `feat(api): persist read-only BIO registration revalidation requests`.

## Task 3: fresh 결과 수용·내구 ACK와 publisher — 담당 backend

**상태:** 완료(결과 수용/내구 전달 소프트웨어), `9d650aba`·제한 시간 보완 `d93eaf40`. 고유 집중54+fix1PASS·API typecheck/diffcheck0, 독립 검토 I1 수정 뒤 재검토 승인·새C0/I0/M0(기존 pnpm 경고 보존). 신규 결과/ACK와 기존 MQTT 종료 경계만 검증했고 Task2 전체는 반복하지 않았다. 실제 DB clock 공급/장비 조회는 별도 관문이다.

**Files:** service, 신규 publisher, MQTT module/consumer/shutdown 및 해당 spec; Task2 통합 spec에 ingest/publish 사례 추가.

**Interfaces:**
- Consumes: Task1 wire, Task2 binding/row.
- `BioRegistrationRevalidationService.ingest(topic: string, rawResult: unknown, receivedAt: Date): Promise<BioRegistrationRevalidationAck>`.
- `BioRegistrationRevalidationService.expire(now?: Date): Promise<void>`은 pending만 terminal timed_out로 만들며 result/감사를 합성하지 않는다.
- `BioRegistrationRevalidationPublisherService.processBatch(): Promise<void>`, `stopAndDrain(): Promise<void>`; 기존 MqttService `publishTopic`와 MqttOutbox 원자 ACK 저장/재전송을 소비한다.

- [x] **Step 1: RED 수용/전달 테스트.** 세 mode 모두 엄격 시간/identity 확인 뒤만 observed, Fixture/qualification/heartbeat 변경0. occurredAt=requestedAt−1ms·expiresAt+1ms·receivedAt+1001ms, receipt=expiresAt, supersede·binding 변경·이미 timed_out·server clock 불신뢰는 immutable 감사 결과만 저장하고 `stale_checkpoint`, proofAcceptedAt=null로 남긴다. 동일 command/event/fullhash 재전달은 duplicate/동일 row, 다른 hash/event는 conflict/원본 보존. old-purpose/result ACK는 실패. result 저장/ACK outbox 원자 rollback, 중복 PUBACK·lease 교체·publish 실패 재시도·shutdown drain도 고정한다.
  ```ts
  expect(await service.ingest(topic, lateObserved, expiresAt)).toMatchObject({ status: "stale_checkpoint" });
  expect((await readOperation()).proofAcceptedAt).toBeNull();
  expect(await readProtectedFixtureState()).toEqual(before);
  ```
- [x] **Step 2: RED 실행.** Task2 DB 명령의 `-t 'ingest|publish|expiry|ack'` 및 `pnpm --filter @led-control/api exec jest src/mqtt/bio-registration-revalidation-publisher.service.spec.ts --runInBand` → 새 기능 부재/회귀 FAIL.
- [x] **Step 3: ingest 구현.** exact topic→strict result→현재 authority/binding→operation lock→fullhash 검증. observed 수용에는 `CommandDbClockHealth.assertHealthy(tx)`의 UTC 기준을 요구한다. 실패/stale 보관은 proof로 승격하지 않으며 result는 최초 한 번만 저장한다. event unique 충돌도 전체 rollback. ACK를 같은 transaction의 MqttOutbox에 `bio-registration-revalidation:<gatewayId>:<commandId>:<eventId>` key로 저장하고 신규 ACK topic으로 보낸다. 일반 state ACK parser와 topic에 넣지 않는다.
- [x] **Step 4: publisher/shutdown 구현.** 짧은 lease claim commit 후 canonical 잠금 순서로 현재 requester/commission/cert/assignment/binding/clock/TTL을 재검증한다. MQTT publish만 최대2초 bounded이며 USB/결과를 기다리지 않는다. 같은 payload/hash 재시도·lease fencing, authority/clock 불명확 시 query publish0 및 unknown; PUBACK으로 observed 금지. 새 result를 durable inbound 관찰 topic에 등록하고 저장 실패 시 inbound PUBACK 성공을 만들지 않는다. shutdown은 publisher/inbound drain 뒤 MQTT를 닫는다.
- [x] **Step 5: GREEN.** 동일 신규 선택 + 기존 `mqtt-shutdown-coordinator.spec.ts`, `mqtt.service.spec.ts` 관련 routing/ack 회귀, API typecheck → exit0. 시간 경계 사례와 모든 mode 실행 수를 기록한다.
- [x] **Step 6: 독립 검토·commit.** 영향 메뉴/status 갱신, `feat(api): ingest fresh BIO revalidation proof with durable acknowledgements`.

## Task 4: 명시적 원자 apply와 분류 evidence 구분 — 담당 backend

**상태:** 완료(명시적 감사 apply/분류 소프트웨어), `1fde5c3c`, 독립 Spec✅/QualityApproved·새C0/I0/M0. 집중22/직접회귀61PASS·retained metadata/다른 미완결 provision 경계 RED2→GREEN2·unknown1GREEN·typecheck/diffcheck0. 실제 PostgreSQL scan/register 양방향 barrier·감사 실패 rollback·재시도 쓰기0을 확인했고 최종 신규23개 일괄 실행은 Task6에서 한다. 실제 A/B에는 아직 적용하지 않는다.

**Files:** service/controller 및 해당 spec; 기존 classification service/spec/integration spec; Task2 신규 통합 spec apply 사례.

**Interfaces:**
- Consumes: Task3의 immutable result·proofAcceptedAt·snapshot.
- `BioRegistrationRevalidationService.apply(user: AuthenticatedUser, commandId: string): Promise<BioRegistrationRevalidationView>`와 `POST /registration-sessions/bio-revalidations/:commandId/apply`.
- classification의 기존 Evidence union에 `evidenceKind: "current_device_revalidation"`, `revalidationCommandId`, `revalidationResultHash`, `repairAuditId`를 추가한다. 기존 historical 두 evidenceKind 및 guard는 그대로다.

- [x] **Step 1: RED apply/분류 테스트.** fresh observed를 apply하면 후보 status=provisioned, mandatory audit1/appliedAt1, 나머지 snapshot 동일. 같은 operation 반복은 현재 auth/binding 재검사 뒤 UPDATE/감사/GET0. unknown/superseded/기한120000ms 경계/다른 requester/current 권한철회·cert 만료·graph 교체는 거부한다. AuditLog insert fault는 상태·appliedAt 모두 rollback. scan/등록이 먼저 잠근 경우와 apply가 먼저 잠근 경우를 두 DB transaction barrier로 검증하고 두 apply race audit1/수복1을 고정한다.
  ```ts
  await expect(applyWithAuditFault()).rejects.toThrow();
  expect((await readCandidate()).status).toBe("discovered");
  expect(await repairAuditCount()).toBe(0);
  ```
  수복 뒤 A/B 분류는 B evidenceKind=current_device_revalidation이며 BIO/OFF만 변경; 두 번째 fixture 부적격이면 A 변경/분류 감사도 rollback. applied 수복 이력이 있는데 현재 binding/result/audit가 불일치하면 historical evidence로 fallback하지 않는다.
- [x] **Step 2: RED 실행.** 새 DB 선택 `-t 'apply|race|rollback|classification'` + `BIO_CLASSIFICATION_RECONCILIATION_TEST=1 pnpm --filter @led-control/api exec jest src/registration/bio-classification-reconciliation.integration.spec.ts --runInBand`. 새 apply 기능 부재 FAIL이 필요하며 unrelated 기존 실패를 RED로 쓰지 않는다.
- [x] **Step 3: apply 구현.** trusted DB 현재 시각<applyDeadlineAt, 권한/귀속/원 command/confirmed·discovered/등록 경합을 canonical lock 안에서 확인. 후보 조건부 UPDATE1 + 감사 action=`bio_registration_current_revalidated`, evidenceKind=`current_device_revalidation`, old/new status·binding/hash·원 provision ID·operation/result hash 저장 + operation 소비를 같은 transaction에 수행. 기존 applied row의 retry는 현재 binding 검사를 유지하되 후보 provisioned를 허용한다. session/terminal/processed ledger 수정0.
- [x] **Step 4: classification evidence 구현.** provisioned/confirmed/current ownership를 기존처럼 먼저 확인한 다음 적용된 revalidation row/audit의 exact binding을 검사해 current evidence로 기록한다. 이력이 없는 기존 graph는 원래 historical 경로를 그대로 사용한다. 재분류된 정상 qualification은 낮추지 않고 기존 A/B transaction 경계를 유지한다.
- [x] **Step 5: GREEN.** 동일 신규 DB 선택과 기존 classification/registration domain lock 회귀, API typecheck → exit0. 실제 race barrier·rollback·protected state 동일성 증거를 보고한다.
- [x] **Step 6: 독립 검토·commit.** 영향 메뉴/status 갱신, `feat(api): audit atomic BIO registration repair without changing fixture state`.

## Task 5: Gateway query-only 소비·복구·정확 ACK — 담당 gateway

**상태:** 완료(Gateway 조회 전용 소프트웨어), `efdc84d2`·내구 receipt 보완 `34e16704`. 집중68+adapter21+runtime38+ACL2PASS, actual fsync fault RED1→GREEN1·변경39PASS·typecheck/build0. I1 수정 재검토 승인·새C0/I0/M0, 기존 pnpm 경고 보존. actual broker matrix는 구문검사·optin1SKIP이며 Node22 parity/실장비는 미검증이다.

**Files:** Gateway·Broker 소프트웨어 책임에 열거한 파일. Tasks1~4 승인 커밋 이후만 시작하며 Shared/API 변경 금지.

**Interfaces:**
- `handleBioRegistrationRevalidation(adapter: Pick<BleMeshAdapter, "sensorModeOperation">, input: BioRegistrationRevalidationCommand, options: BioRegistrationRevalidationHandlerOptions): Promise<void>`.
- Options는 `{ journal: CommandJournal, outbox: StateEventOutbox, nextSequence: () => Promise<number>, scope: {siteId: string; gatewayId: string; assignmentVersion: number}, clockTrusted: () => Promise<boolean>, now?: () => Date, signal?: AbortSignal, onDurableReceipt?: () => void }`. capability observer/ensure_sensor 옵션 없음.
- `recoverBioRegistrationRevalidations(options: BioRegistrationRevalidationHandlerOptions): Promise<void>`, `CommandJournal.pendingBioRegistrationRevalidations()` 및 `markBioRegistrationRevalidationHandedOff(commandId: string): Promise<void>`.
- StateEventOutbox의 신규 result union/목적 우선 parsing·topic routing, `acknowledge(value: unknown): Promise<boolean>`은 신규 ACK의 전체 hash matcher를 사용하며 기존 ACK 의미는 바꾸지 않는다.

- [x] **Step 1: RED 단일 소유·SET0 테스트.** 세 mode GET 성공 observed, Fixture≠node ID 정상매핑, single client 사용/query만 전달, 모든 SET·capability observer0. in-flight same ID는 GET1/event1, 다른 payload는 conflict. deadline≤8초/TTL, clock false 및 GET 후 clock 철회, transport identity/generation 교체, abort/종료/restart는 observed0. durable journal/outbox write fault·재시작 retry는 원장 보존/새 GET0, 기존 terminal은 같은 event로 재전송한다.
  ```ts
  expect(adapter.sensorModeOperation).toHaveBeenCalledWith(expect.objectContaining({ operation: "query" }), expect.anything());
  expect(setWrites).toHaveLength(0);
  expect(capabilityObserver).not.toHaveBeenCalled();
  ```
  adapter fake는 기존 실제 query의 fresh discovery/confirmed/native/address/transport 검증을 별도 유지하고, malformed response/실패를 성공 mode로 바꾸지 않는다. exact ACK만 제거, legacy/state ACK·변경hash/site/assignment/node/sequence는 pending 유지. 기존 sensor-mode journal/recovery/ACK가 신규 kind를 처리하지 않는 회귀 포함.
- [x] **Step 2: RED 실행.** `pnpm --filter @led-control/gateway exec vitest run src/commands/bio-registration-revalidation-handler.test.ts src/commands/command-journal.test.ts src/state/state-event-outbox.test.ts --maxWorkers=1 --minWorkers=1` → 신규 소비/ACK 기능 부재 FAIL.
- [x] **Step 3: handler/journal/outbox 구현.** `kind: "bio_registration_revalidation"`와 별도 journal path `GATEWAY_BIO_REGISTRATION_REVALIDATION_JOURNAL_PATH`(기본 `/var/lib/led-control/bio-registration-revalidation-journal.json`). query command를 기존 sensorModeOperation의 query DTO로 명시적 변환한다. 같은 journal/in-flight 소유, 8초/remaining 작은 deadline, GET 전후 clock/abort/TTL 검사, 실패 고정 code. restart pending은 unknown/GATEWAY_RESTART만 만들며 새 GET 없음. terminal→outbox handoff 완료 뒤에만 handedOff 기록; fsync/복구 실패 시 원장 삭제/거짓 durable receipt 금지.
- [x] **Step 4: runtime/ACL 연결.** index inbound handler·독립 ACK 구독·reconnect 복구·현재 assignment scope·stop/drain 연결. 신규 목적에서 `onIdentityProof` 호출 경로 없음. api-service 신규 command write/result read/ACK write, Gateway own scoped command read/result write/ACK read만 허용; 다른 Gateway/역방향 권한 금지. dev ACL renderer/test와 production template의 동일 계약을 수정하되 실제 환경 reload 없음.
- [x] **Step 5: GREEN.** 동일 신규 suite + 기존 bio-sensor-mode-handler/adapter query/runtime routing/ACL 렌더 회귀, Gateway typecheck/build → exit0. 과거 Shared/API 계약 변경 요청이 필요하면 총괄로 반환하고 병렬 수정하지 않는다.
- [x] **Step 6: 독립 검토·commit.** 영향 메뉴/status 갱신, `feat(gateway): handle read-only BIO registration revalidation with exact acknowledgements`.

## Task 6: 제한 통합·최종 검토·인계 — backend/독립 QA, 총괄 취합

**상태:** 완료(소프트웨어 검증/문서 인계). 통합 `e83ed3f3`, Task6 scoped와 전체 요청 최종 검토 Approved·새C0/I0/M0·기존M1. 새 API↔Gateway 통합3개 첫GREEN(인위적 RED 없음)·최종 신규 일회용 DB108/108PASS·skip0·migration deploy0·기존 직접5/5PASS·API/Gateway typecheck/build0. 실제 broker/조명은 사용하지 않았으며 별도 브랜치를 보존한다.

**Files:** backend가 신규 API 통합 spec에 fake Gateway end-to-end를 추가한다. 총괄은 영향 메뉴3/status/기존 BIO 계획/이 계획만 결과를 취합해 갱신한다. QA는 읽기 전용 검토하며 코드 지적 수정은 원 소유 역할에 반환한다.

**Interfaces:** Tasks1~5 public 계약/서비스/handler만 소비. API 통합에서 Gateway import는 기존 sensor-mode integration처럼 runtime-only require를 사용해 API emit root를 바꾸지 않는다.

- [x] **Step 1: 통합 RED 작성.** create→durable command→fake single adapter query→result outbox→API ingest/ACK→apply→A/B classification. force-off도 fresh observed이며 query/repair 자체는 Fixture output/qualification 변화0; ACK 전달 중단/duplicate/restart가 기존 event/기한을 보존한다. legacy Gateway는 result 없음/timeout, 기존 legacy ACK로 새 성공 없음.
- [x] **Step 2: RED 실행.** 신규 DB spec `-t 'end-to-end|legacy gateway|restart delivery'`; integration 연결 누락의 FAIL을 기록하고 Task 소유 역할이 최소 연결을 수정한다. 완성된 경로가 처음부터 통과하면 임의 결함을 넣어 RED를 만들지 않고 GREEN 증거로 기록한다.
- [x] **Step 3: 최종 집중 검증 한 번.** `BIO_REGISTRATION_REVALIDATION_DISPOSABLE_POSTGRES=1 pnpm --filter @led-control/api exec jest test/bio-registration-revalidation.integration.spec.ts --runInBand` → 전체 신규 DB 실제 PASS/skip0; 기존 sensor-mode/terminal/classification과 Gateway journal/outbox/adapter 직접 영향 회귀만 함께 실행한다. API/Gateway typecheck/build 및 `git diff --check` exit0. 무관 Web/root 전체 suite·benchmark/HIL 반복 없음. 실패는 baseline이라고 추정하지 말고 exact 결과/범위를 남긴다.
- [x] **Step 4: 독립 QA 검토.** spec·diff·command logs·새 wire compatibility/시각/권한/원자성/SET0·문서 일치; Critical/Important 수정 후 같은 reviewer 재검토. 실장비 증거 없는 healthy/지원/PASS 표기가 있으면 제거한다.
- [x] **Step 5: 상태 인계·commit.** 소프트웨어 구현/검증만 완료 표시하고 실제 B 조회/apply/A/B 분류는 미완료로 유지. `docs: record BIO registration revalidation software verification`.

## 이후 현장 관문 — 이 소프트웨어 구현 완료와 별개

- [ ] 현재 기본 브랜치의 UI/DB를 보존하는 필요한 BIO 계약·migration 통합 및 fresh 환경/귀속/clock/cert 확인. sensor 전체 dist로 현재 런타임을 덮지 않는다.
- [ ] trusted DB clock attestor와 Gateway clock 근거의 실제 공급 확인. 기존 `CommandDbClockHealth`는 실제 attestor 기본 미연결이므로 자동 성공하지 않는다. provider가 없으면 현장 apply 보류이며 이 계획에서 더미 공급/Set 권한을 열지 않는다.
- [ ] 사용자와 현재 조회창·원본 서비스 중단 필요 여부/USB 단일 소유·백업/원복을 합의한 뒤 운영 migration/배포와 exact B query를 진행한다.
- [ ] fresh observed가 있을 때 관리자 apply와 감사, ID·밝기·전원·그룹·이력 보존 확인. 그 뒤 기존 A/B 분류 API를 별도 실행하며 제품 OFF 유지.
- [ ] 기존 Task9의 실제 움직임 반복/시각 오차/광학·독립 link health 관찰과 실제 supplier/profile 구현은 별도 작업. mode GET/ACK/등록 수복으로 이를 완료 판정하지 않는다.

## 계획 자체 검토 — 총괄

- [x] 설계 각 요구를 Tasks1~6/별도 현장 관문에 배치했다. 실제 provider·현장 결과가 없는 점은 명시적으로 미완료다.
- [x] 단계별 exact 파일/입출력/값/RED-GREEN 명령/검토/commit을 지정했다. 운영 변경 권한을 구현 단계에 섞지 않았다.
- [x] task 간 타입/메서드 이름·purpose/topic/TTL/ACK hash/시간 비교·잠금 순서 일치를 대조했다.
- [x] Review Focus 다섯 항목을 담당 task의 실제 테스트 assertions/경계 사례에 배치했다.
- [x] 함수 본문 대신 경계·signature·핵심 assertions만 남겼고 독립 provider/고객 UI/BlueZ 제거를 추가하지 않았다.
- [x] 사용자 실행 계획 승인으로 Tasks1~6 시작. 이미 합의된 역할별 서브에이전트 순차 구현/총괄 취합 방식 유지.

## 최종 소프트웨어 인계 기록

최종 독립 검토 범위는 `b86cdc4bfc0cd8b4c7ced04d619512dfe7932961..1fbce40190d97c81e2f6370efafa2ef0b7f32ff7`다. Tasks1~6 소프트웨어 인계는 Approved이며 새 Critical/Important/Minor는 0/0/0이다. 기존 pnpm 설정 경고 M1은 남아 있다. 이전 센서 브랜치 전체 변경이나 운영 준비성을 검토한 것은 아니므로 **전체 브랜치 머지 준비 승인 또는 실제 센서 연동 완료를 뜻하지 않는다**. 운영 migration/배포/실제 B 조회·apply·A/B 분류와 머지는 실행하지 않았다.

| 구현 | 소스 커밋 | 최종 근거 |
| --- | --- | --- |
| 엄격한 조회 전용 계약 | `e902a393` | 신규32+직접6 PASS, Shared typecheck/build |
| 요청·현재 바인딩·DB 원장 | `04e8c31b` | 신규41+직접55 PASS, Prisma generate/typecheck |
| 결과 수용·정확 ACK·publish | `9d650aba`, `d93eaf40` | 고유54+지연 회귀1 PASS, 수정 재검토 승인 |
| 감사와 원자 apply·분류 근거 | `1fde5c3c` | 실제 PG 경합/rollback/상태 보존; 최종 신규23 포함 |
| Gateway GET 전용·내구 원장·복구 | `efdc84d2`, `34e16704` | 실제 fsync fault RED→GREEN, 변경39 PASS, 수정 재검토 승인 |
| 제한 API↔Gateway 통합 | `e83ed3f3` | 최종 신규 일회용 PG108/108 PASS·skip0, 기존 직접5/5 PASS |

최종 신규 DB108은 한 번 실행했고 소요36.314초다. 과거 단계별 숫자를 여기에 합산하지 않는다. API/Gateway typecheck/build 및 API emit 경로 확인은 exit0이다. USB/MQTT는 통합 테스트 경계에서 대체했으며 실제 broker opt-in 시험은 skip1, 구문/ACL 정적 검토만 수행했다. Node24.19.0/pnpm9.15.0에서 검증했으며 Node22 런타임 동등성, 실제 RF·mTLS·전원 차단 HIL, 무관 Web/root 전체 회귀는 주장하지 않는다. 운영 DB 대신 자체 일회용 PG를 사용했다.

실제 승인된 움직임 profile registry와 독립 link-health producer는 아직 없다. 운영 DB clock attestor와 배포 Gateway clock의 실제 근거도 이번 검증으로 대체할 수 없다. 이미 구현된 typed 소비/철회 경계에 항상 null인 미사용 조합기나 가짜 provider를 추가하지 않았다. 이러한 입력 확보 및 위 현장 관문 전까지 제품 OFF를 유지하며 전체 센서 목표는 미완료다. 임시 검토자료는 아래 판단과 검증을 문서에 취합한 뒤 이번 계획의 scratch 디렉터리만 정리한다. 코드·별도 브랜치·기존 현장 증거는 보존한다.

### Rulings I made — 작업 중 판단과 잘못됐을 때의 비용

1. 준비된 worktree를 재사용하고 무관 전체 baseline/install은 생략했다. 사용자 요청대로 변경 기능 집중 검증만 수행했다. 비용: 무관한 기존 실패나 저장소 전체 정상 여부를 인증할 수 없다.
2. 새 schema 작성 후 DB GREEN 전에 Prisma Client를 생성했다. 미생성 client 오류를 기능 RED로 취급하지 않았다. 비용: 생성물이 schema와 다르면 DB 검증 근거가 무효가 된다.
3. 현재 권한 상실 결과는 거부하고, 현재 인증된 scope의 binding 변경 결과만 immutable stale 감사로 보관했다. 비용: 경계를 잘못 판단하면 잘못된 proof 수용 또는 정상 수복 거부가 발생한다.
4. 이미 applied된 재시도는 현재 권한·동일 graph를 확인해 기존 결과만 반환한다. 만료를 이유로 새 apply를 하지 않는다. 비용: graph 변경을 놓치면 과거 proof 재사용이 가능하므로 변경 시 거부가 필수다.
5. 기존 pnpm 설정 경고 M1은 도구 후속 항목으로 보존하고 dependency 범위를 확장하지 않았다. 비용: 경고 없는 검증 또는 완전한 dependency 검증이라고 주장할 수 없다.
6. apply 잠금은 Floor 선점→현재 Gateway/cert 권한→기존 binding helper 재진입 순서로 맞췄다. 비용: Floor 선점 누락 시 기존 분류 경로와 잠금 역전·교착 위험이 있다.
7. 등록 경합은 현재 상태·scan·다른 미완결 provision으로 판단한다. terminal 이후 잔존 pending metadata나 원 outbox의 unpublished만으로 차단하지 않는다. 비용: 실제 진행 작업을 놓칠 수 있으므로 잠금 안의 상태/outbox 검사가 필수다.
8. 최종 요청 검토는 계획 시작 커밋 이후로 제한하고 이전159개 역사적 변경은 이번 검토 범위에서 제외했다. 비용: 전체 분기와 기본 브랜치 병합 준비성은 인증하지 못한다.
9. 최종 검토가 유보한 이전 전체 merge, 실제 B/현장 보존, 실제 profile/독립 health, 운영 clock attestor, 실제 broker/mTLS/RF/전원 차단 HIL/CRL, Node22/dependency/무관 전체 회귀, 운영 migration/배포는 별도 미완료 관문으로 유지했다. 비용: 이를 software PASS와 섞으면 근거 없는 센서 활성화나 운영 변경을 허용할 수 있다.
