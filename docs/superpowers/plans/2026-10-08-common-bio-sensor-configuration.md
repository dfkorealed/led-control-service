# 공통 BIO 센서 등록·UI 설정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 특정 A/B 연결 없이 등록된 센서 조명이 공통 호환 데이터와 자동 준비 확인을 통해 UI에서 이벤트 제어를 구성하도록 구현한다.

**Architecture:** 관리 권한이 있는 서버가 버전형 호환 카탈로그를 발행하고 Gateway가 단일 BIO client로 discovery·모드·독립 링크를 확인해 준비 증거와 실제 pulse authority를 생산한다. API는 현재 카탈로그/귀속/준비/운영 승인/V2 지원이 모두 맞을 때만 기존 제품 차단을 해제하고 Web은 서버 판정을 표시한다. 기존 수동 우선순위·source 보호·hold/원복·V1/V2 의미는 유지한다.

**Tech Stack:** TypeScript, Zod, NestJS, Prisma/PostgreSQL, MQTT, Vitest/Jest, React/Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-08-common-bio-sensor-configuration-design.md`

**Execution:** 2026-10-08 사용자 `구현 계획 작성 후 바로 진행해줘`에 따라 계획 작성 후 별도 재승인 없이 담당 역할을 순차 배정한다. 총괄은 코드 직접 수정 대신 계약·체크리스트·검토를 조율한다. 기존 isolated worktree `codex/bio-pulse-event-integration`을 재사용한다.

## Global Constraints

- BIO 유지시간 10~1,800초, 기본60초를 유지하고 저장 후 수정 가능하게 한다.
- A/B는 설명용 역할 이름일 뿐, ID·주소·장비 수를 코드에 고정하지 않는다.
- 현재 승인 프로파일 목록은 비어 있다. pilot 결과를 전체 firmware qualification 또는 미검증 `05` body 허용으로 전환하지 않는다.
- 모드 확인과 실제 센서 호환성을 분리한다. `modeVerified=true`만으로 `ready`를 생성하지 않는다.
- 신규 동일 검증 조합은 코드 수정·이미지 재배포 없이 자동 매칭한다. 프로파일의 승인 재사용 범위 밖 조명은 사유를 표시한다.
- 여러 조명의 준비 확인도 기존 단일 client의 전역 직렬 큐를 공유한다. 늦은 GET 응답의 generation 폐기 정책을 유지한다.
- source 자신과 다른 활성 BIO source는 target에서 제외한다. 센서 자율 점등은 유지하지만 source의 밝기까지 서비스에서 쓰는 기능은 이번 범위가 아니다.
- raw body/native UUID/자격 증명은 일반 UI·로그로 보내지 않는다. 카탈로그 승인 근거의 exact body는 관리자 계약/보호 저장에만 둔다.
- 실제 DB migration·Gateway 배포/재시작·센서 모드 변경·초기 지원 전환은 별도 운영 승인 전 실행하지 않는다.
- 불필요한 전체 회귀·장시간 현장 시험을 반복하지 않고 변경 경로의 RED/GREEN·타입 검사·일회용 DB 통합으로 검증한다. 새 checkout이 아니지만 leaf 검증 전 `pnpm workspace:prepare`를 한 번 수행한다.
- 영향 메뉴 문서와 DB schema 문서는 구현과 함께 갱신한다. 기존 완료 항목을 재구현하지 않는다.

## Review Focus

1. 동일 firmware 문자열이지만 다른 센서/hardware 조합이 잘못 매칭되지 않는가? → Tasks 1/3의 전체 fingerprint 매칭.
2. 카탈로그 교체·철회 중 대기 pulse/늦은 보고가 이전 권한을 되살리지 않는가? → Tasks 2/3/4의 revision/hash/수명 경계.
3. 준비 버튼 중복·부분 실패·GET timeout 뒤 타 조명 응답을 성공으로 오인하지 않는가? → Tasks 3/5의 단일 큐/중복/화면 세대.
4. mode 성공·ready ACK 하나로 현장 정책/독립 링크/현재 귀속 검증이 생략되지 않는가? → Tasks 2/4의 조건부 admission.
5. 서로 다른 ID의 새 조명 3개가 같은 데이터로 설정되고 기존 수동/스케줄·원복이 유지되는가? → Task 6의 공통 경로 통합.

---

### Task 1: 관측 fingerprint·카탈로그·준비 작업 공유 계약

**Owner:** backend(shared 단일 승인 소유자).
**Files:** Create `packages/shared/src/bio-sensor-profile-contracts.ts`, `bio-sensor-preparation-contracts.ts`와 대응 `.test.ts`; Modify `packages/shared/src/index.ts`.

**Interfaces:**
- `BioSensorFingerprintV1`: `deviceType`, `firmware:{major,minor,revision,build}`, `sensorType`, `infraredType`, `ambientLightType`, `hardwareType`. build는0..65535, 나머지는0..255 정수. `canonicalBioSensorFingerprint(value): string`, `bioFirmwareFingerprint(value): string`, `bioSensorFingerprint(value): string`은 고정 필드 순서의 정규화 문자열이며 browser에서 Node crypto를 요구하지 않는다.
- `BioSensorProfileV1`: `profileId` UUID, `revision` positive safe integer, `status: approved|revoked`, `fingerprint`, `bodyHexes` unique 8-byte lower hex 목록, `linkPolicy:{kind:mode-get,probeIntervalMs,maxAgeMs}`(각 positive safe integer, maxAge>=interval), `evidenceDigest` sha256 digest, `reuseScope` nonempty string. approved에 필요한 근거 필드는 생략 불가. `bioProfileKey(profile)`는 `${profileId}@${revision}`이며 기존 fingerprint/profile string 소비자는 이 key를 사용한다.
- `BioSensorCatalogV1`: `schemaVersion:1`, `siteId/gatewayId/eventId` UUID, `assignmentVersion`, `catalogRevision` positive safe integers, `issuedAt` datetime, `profiles`(동일 profileId 중복 금지), `executionPolicy:{enabled,ownerUserId,maximumResponseSeconds,escalationAction}`. enabled=true에는 owner UUID·positive response·nonempty escalation 필수. 기본 실행 정책은 disabled다.
- `BioSensorCatalogAckV1`: schemaVersion1, exact site/gateway/assignment/event/catalogRevision, `deliveryPayloadHash` sha256, `status:applied|duplicate|stale|rejected`, `occurredAt`. strict schema 및 full-envelope hash matcher. topic은 `sites/{siteId}/gateways/{gatewayId}/commands/bio-sensor-catalog`, ACK는 `.../events/bio-sensor-catalog-ack`.
- `BioSensorPreparationRequestV1`: siteId/fixtureId/clientRequestId UUID, `operation:query|ensure_sensor`. `BioSensorPreparationCommandV1`은 schemaVersion1, commandId/siteId/gatewayId/fixtureId/nodeId, assignmentVersion, deviceIdentityHash(64hex), meshAddress, operation, catalogRevision, requestedAt/expiresAt(TTL<=120초) 및 commandPayloadHash를 제외한 내용으로 hash 대조한다. Command에는 hash를 넣지 않고 report에 전체 command hash를 넣는다.
- `BioSensorPreparationReportV1`: command 공통 귀속·eventId·commandPayloadHash, catalogRevision·fingerprint nullable·profileKey nullable·connectionGeneration positive, observedAt, `status:ready|needs_setup|unverified|degraded|unsupported|failed`, `modeVerified`, `linkVerified`, `errorCode` nullable. ready에는 fingerprint/profileKey·mode/link true 필수, 다른 결과는 증거 부재를 nullable로 표현한다. 별도 `BioSensorPreparationAckV1`은 exact scope/command/event/reportPayloadHash와 applied|duplicate|stale|rejected/occurredAt. topic은 `commands/bio-sensor-preparation`, `events/bio-sensor-preparation-result`, `events/bio-sensor-preparation-result-ack`.
- 기존 sensor-mode V2·capability V2·automation V1/V2 schema는 불변이다. 새로운 준비/카탈로그 계약으로 추가 증거를 전달한다.

- [x] **Step 1 RED:** strict 추가 필드·잘못된 byte/build·중복 profile·누락 approval근거·잘못된 TTL·ready에 mode/link누락·다른scope/hash ACK 거부, canonical key의 값/순서와8-byte exact body를 단언한다.
- [x] **Step 2 RED 확인:** `pnpm --filter @led-control/shared exec vitest run src/bio-sensor-profile-contracts.test.ts src/bio-sensor-preparation-contracts.test.ts` — 신규14/14 RED(미존재 exports).
- [x] **Step 3 구현:** 위 타입/schema/helper/topics만 추가한다. 기존 wire는 확장하지 않는다.
- [x] **Step 4 GREEN:** 같은 focused command14/14 및 기존 sensor-mode/capability/등록 계약 포함102/102; Shared typecheck/build exit0.
- [x] **Step 5 검토·커밋:** `358c5f1a`; 독립 spec compliant/quality Approved(Critical0/Important0), 기존 pnpm launcher 경고는 기능 회귀와 분리 기록.

### Task 2: 서버 카탈로그·준비 요청/결과·버전형 내구 전달

**Owner:** backend.
**Files:** Create `apps/api/src/automation/bio-sensor-profiles.{service,controller}.ts`, `bio-sensor-preparation.{service,controller}.ts`, `bio-sensor-catalog-outbox.service.ts`와 unit/integration specs; Modify Prisma schema/new migration, `automation.module.ts`, MQTT consumer/ACL 계약, `docs/database-schema.md`, `docs/menus/settings.md`.

**Execution status:** `d9835271` 구현과 `ebad730f` fix1을 독립 검토 승인했다. MQTT ACL 소스 범위는 `infra/mosquitto.acl.example`, `scripts/dev-mqtt-acl.integration.test.mjs`, `scripts/dev-runtime.mjs`이며 실제 broker reload는 수행하지 않는다. preparation ACK의 전용 전달 종료 필드 `ackRetiredAt`는 checkpoint supersession과 분리했다.

**Interfaces:**
- Prisma: `BioSensorProfileRevision`(profileId/revision compound key, status, fingerprint/bodyHexes/linkPolicy Json, evidenceDigest/reuseScope, actorId/createdAt), `BioSensorCatalogState`(singleton id/revision), `BioSensorSitePolicy`(siteId key/enabled/ownerUserId/maximumResponseSeconds/escalationAction/revision), `BioSensorCatalogDelivery`(deliveryId,site/gateway/assignment/catalog revision,payload/hash,status,publishedAt/attempts/nextAttemptAt/lease/ACK), `BioSensorPreparationOperation`(commandId,scope/fixture/node/currentbinding hash,clientRequestId/actor,operation,catalogRevision,payload/hash,status,expiresAt/supersededAt,result/hash/event,publish/lease fields). Fixture relation과 indexes를 추가하고 native/raw는 외부 response에 노출하지 않는다. 기존 operation/ledger를 전용하지 않는다.
- `BioSensorProfilesService.list/createRevision/revoke/setSitePolicy/buildCurrentCatalog`; operator/service-provider 카탈로그 관리와 site admin의 현장 설정 권한을 분리하고 기존 재인가 패턴을 사용한다. `/bio-sensor-profiles` 관리 API와 site policy API를 등록한다. approved 초기 seed는 추가하지 않는다.
- `BioSensorPreparationService.create(principal,request)/get(principal,commandId)/ingestAuthenticated(report)`; UI API `POST /bio-sensor-preparations`, `GET /bio-sensor-preparations/:commandId`. 기존 mode operation을 변경하지 않고 공통 client의 query/ensure를 새 handler가 재사용한다.
- 전용 catalog delivery worker는 lease/retry를 쓰지만 기존 automation revision/applicationAckKey를 유용하지 않는다. current claim/inventory/certificate/assignment를 lock 안에서 확인하고 publish는 transaction 밖에서 수행한다. exact ACK의 scope/hash/revision을 확인해 desired/applied를 저장한다.
- prepared result는 현재 request/TTL/binding/catalog/profile/시간과 대조해 immutable 저장·ACK를 동일 transaction에 둔다. mode/GET만 성공하면 ready로 만들지 않는다. 재전송에는 동일 결과를 반환하고 새로운 failed 보고가 과거 ready를 유지하지 않게 한다.

- [x] **Step 1 RED:** 권한·재배정·기한·profile 철회·scope/hash 불일치·중복/replay, 빈 catalog·mode-only 거부·query SET0 계약을 재현한다.
- [x] **Step 2 RED 확인:** API focused unit과 일회용 PostgreSQL integration(사용자 DB에 연결하지 않는다). fix1의 선두10 stale 전달 정체·요청자 권한 해제 후 수용 결함도 RED3으로 재현했다.
- [x] **Step 3 구현:** immutable profile revisions, site policy OFF 기본값, 전용 worker, prepare request/result/ACK를 기존 lease/identity-lock 방식으로 구현한다. MQTT dispatch와 strict topic ACL을 연결한다.
- [x] **Step 4 GREEN/문서:** 최신 disposable 통합19/19·133 migrations/원본데이터 보존, API typecheck/build0; initial focused API21/21·ACL1/1·runtime68/68, database-schema/settings 갱신. fix후 같은 runtime suite를 반복했다고 기록하지 않는다.
- [x] **Step 5 검토·커밋:** `d9835271..ebad730f` 독립 검토의 Important2를 수정·재검토 모두 ADDRESSED/new C0/I0. 실제 운영 변경0이며 신규 등록 typed 보존은 Task2A로 선행 보완 후 Gateway에 넘긴다.

### Task 2A: 신규 등록의 typed discovery 보존 경계 보완

**Owner:** backend(shared/API 단일 소유자), Task2 fix/re-review 승인 후 Task3 전에 수행.
**Files:** Create `packages/shared/src/bio-discovery-contracts.ts`와 `.test.ts`; Modify shared index, API registration scan ingestion/storage·MQTT routing, Prisma nullable observation field/new forward migration, MQTT ACL source producer inventory 및 대응 focused tests, `docs/database-schema.md`, `docs/menus/{settings,monitoring}.md`. 기존 strict scan/terminal wire는 수정하지 않는다.

**Interfaces:**
- `bioProvisioningScanFoundV2Schema`: 기존 `provisioningScanFoundSchema`를 재사용해 동일 scan/장비 귀속 필드에 `schemaVersion:2`, required nullable `fingerprint:BioSensorFingerprintV1`만 추가한 strict 새 계약. `BioProvisioningScanFoundV2Payload` export. `bioDiscoveryTopics.scanFoundV2(siteId,gatewayId)`은 `sites/{siteId}/gateways/{gatewayId}/events/provisioning/scan-found-v2`다. legacy firmware 문자열에서 fingerprint를 합성하지 않는다.
- `DiscoveredMeshNode.bioDiscoveryFingerprint Json?`는 관측 데이터이며 기본null다. 별도 version parser로 검증된 현재 scan의 fingerprint만 기존 session/correlation/attempt/scope/sequence/중복 경계 안에서 저장한다. legacy/null·잘못된 scope/늦은 scan으로 새 호환/ready 증거를 생성하지 않는다. confirmed 등록 후에도 observation을 보존하고 실제 준비 query는 fresh discovery를 다시 확인한다.
- 새 API subscriber/producer ACL을 선행 적용하는 코드 경계를 제공한다. 일반 등록 HTTP 응답/로그에 raw fingerprint를 추가하지 않는다. Task3 BIO publisher만 새 topic을 사용하고 기존 다른 adapter/legacy strict 메시지는 유지한다. Gateway 소비 구현은 Task3 소유다.

- [x] **Step 1 RED:** strict fingerprint/version/byte·legacy unchanged/null·다른 scan/scope/late event 거부 및 accepted typed observation 저장/등록 후 보존을 재현한다.
- [x] **Step 2 RED 확인:** Shared 신규5 FAIL, API nullable/V2 저장11 FAIL·subscriber/DTO2 FAIL·ACL1 FAIL을 실제 assertion으로 확인; 사용자DB 미접속.
- [x] **Step 3 구현:** 새 Shared 계약 `c393309c`를 검증·먼저 커밋한 뒤 API/forward migration/ACL source `d6d2386e`를 순차 연결했다. 모드 SET/자동 센서 준비·classification/승인 seed0을 유지한다.
- [x] **Step 4 GREEN/문서:** Shared75/75/typecheck/build0, disposable 등록23/23·MQTT/등록185 PASS/기존 실제broker1 opt-in SKIP·ACL2/2/APItypecheck/build0, DTO/log redaction·schema/settings/monitoring 갱신.
- [x] **Step 5 검토·커밋:** 독립 spec/quality Approved(C0/I0); prior Tasks1/2의 기본OFF·strictwire 불변 증거와 결합해 Task3로 인계. 실제 운영 적용은 확인했다고 표현하지 않는다.

### Task 3: Gateway discovery 보존·동적 카탈로그·실제 준비/authority 공급

**Owner:** gateway.
**Files:** Modify `bio-dongle-client.ts`, `bio-device-mapping-store.ts`, `adapters/adapter-factory.ts`, `bio-sensor-pulse-source.ts`, `index.ts`; Create `bio/bio-sensor-profile-catalog.ts`, `bio/bio-node-link-monitor.ts`, `bio/bio-pulse-authority-provider.ts`, `commands/bio-sensor-preparation-handler.ts` 및 대응 tests; 기존 registered observation·MQTT routing/ACK·health lifecycle 및 Gateway ACL 계약; `docs/menus/{settings,control}.md`.

**Lifecycle ownership:** `command-journal`의 preparation 전용 result/ACK 수명, `bio-capability-delivery`의 별도 commission/live proof 경로와 `AutomationRuntime`의 실제 검증된 snapshot stage/commit/rollback 최소 확장을 포함한다. 기존 mode command의 OFF-only/TTL와 V2 wire는 변경하지 않는다.

**Interfaces:**
- `BioDiscoveredDevice.fingerprint?: BioSensorFingerprintV1`; fresh discovery에서 보존하며 legacy mapping은 fingerprint없음→unverified. 단순 firmware문자열에서 만들어내지 않는다.
- `BioPulseCatalogPort.snapshot()/onChange()`: immutable current scoped catalog/revision/hash를 공급한다. `FileBioSensorProfileCatalog.apply(envelope)`는 strict scope/hash·monotonic revision·durability 후 ACK, stale/duplicate/conflicting 거부. restart에는 독립 health 복구0.
- `BioNodeLinkMonitor.start()/snapshot(fixtureId)/stopAndDrain()`: 승인 profile과 exact commission에만 기존 readDeviceInfo 전역 queue로 node mode GET, monotonic maxAge/generation 확인·연속healthySince 유지. pulse/alive로 health를 만들지 않는다. fresh probe가 health를 갱신해도 authority의 stable observation을 불필요하게 변경하지 않으며 실패/만료 시즉시철회한다.
- `CommissionedBioPulseAuthorityProvider.read()/onChange()`는 승인 profile·현재 canonical command/binding·mode/link·카탈로그 실행정책·현재 적용/준비중 authenticated snapshot context를 합성한다. requested snapshot revision만으로 신뢰하지 않고 index/runtime에서 실제 검증된 snapshot context를 공급한다. capabilityRevision은 현재 node-local 전달 원장의 revision과 결속한다.
- `acknowledgedCommissionProof(fixtureId)`와 `pinSnapshotBinding(validatedContext,fixtureId)`는 현재 commission/connection epoch에 속한 실제 applied/duplicate ACK 원장의 exact capability revision을 context별로 고정한다. 동일 연속 healthy epoch의 반복 GET/live 보고가 pin·healthySince·대기 receipt를 바꾸지 않는다. arbitrary 숫자 범위/요청 revision은 허용하지 않으며 reconnect/restart/degraded/catalog/identity 변경 뒤 역사 ACK만으로 pin을 복구하지 않는다. snapshot wire 확장 없이 검증된 pending/current·기존 pending 원복 context를 stage/commit/rollback으로 분리 보존한다.
- preparation handler는 exact authenticated command/mapping·fresh discovery와 approved profile matching 뒤에만 ensure_sensor를 수행한다. query는 SET0. ready/불가사유 결과를 내구 journal에 저장하고 정확 ACK까지 재전송한다. 단순 onIdentityProof는 mode전 호출이므로 실제 별도 GET 뒤 mode/link 증거를 생산한다. canonical MeshNode와 local nodeId를 합치지 않는다.
- command TTL은 최초 준비 결과 수용에만 사용한다. 상시 commission은 현재 confirmed binding·승인 catalog·서버의 정확 preparation applied/duplicate ACK에 결속한다. 반복 fresh GET 건강은 별도 proof로 V2 node-local revision/verifiedAt를 갱신한다. 재시작 후 저장된 건강은 복구하지 않고 새 GET 전 OFF/degraded를 유지한다.
- dynamiccatalog/source를 한 수명 경계에서 교체하고 queued/cached receipt·authority 철회를 즉시 수행한다. 확인된 원상태/미확정 pending을 삭제하거나 profile승인을 환경변수로 주입하지 않는다. 기존 source intake/target/controller를 재사용한다.

- [x] **Step 1 RED:** discovery 누락·live API 부재·degraded startup을 재현했다. 신규 catalog의 최초 RED는 import failure였으며, 일부 통합 assertions은 구현 후 보강했다. 이를 순수 behavioral test-first로 과장하지 않는다. fix1은 실제 source/controller에서 F2 변화가 F1 pin/receipt를 끊는 경우와 profile 철회 후 명시 복원 차단을 behavioral RED2로 확인했다.
- [x] **Step 2 RED 확인:** 신규 Gateway configuration/source/production integration 집중 검증. 3 distinct Fixture/native·다른 hardware/legacy·late GET·철회·stable pin·unknown context·rollback·재시작/decoder/fresh identity를 포함한다.
- [x] **Step 3 구현:** `a574e133`+`5c787f32`의 discovery→mapping·카탈로그·준비/정확ACK·독립GET·authority·index/factory/MQTT와 `e379d159`의 source별 철회·복원 전용 journal identity를 연결했다. 승인 기본빈/OFF, 기존 mode TTL/OFF 및 strict V2 wire를 보존한다.
- [x] **Step 4 GREEN/문서:** initial 집중13파일470/마지막수명26, fix1 집중5파일102/최종source36·Gatewaytypes/build/diff0; control/settings 갱신. 실제 RF/장비/broker/배포0이며 기존 pnpm warning은 후속 도구 사항이다.
- [x] **Step 5 검토·커밋:** 독립 검토 Important2를 fix1에서 모두 ADDRESS하고 scoped re-review newC0/I0/M0으로 승인했다. degraded startup currentRevision=null·retained context release-only, 현재 same revision/hash snapshot 재전달은 Task4/6에서 수렴한다.

### Task 4: API 준비 projection·조건부 이벤트 활성화·등록 연결

**Owner:** backend.
**Files:** Create `apps/api/src/automation/bio-sensor-eligibility.ts`와 대응 spec; Modify `sites/vehicle-event-source-view.ts`, `sites.service.ts`, `vehicle-sensor-capability.service.ts`, `vehicle-event-rules.service.ts`, 등록 terminal/discovered projection, Task2 services/tests, 필요한 forward migration 및 `docs/{database-schema,menus/control,menus/monitoring,menus/settings}.md`.

**Interfaces:**
- 준비report→profile/currentcatalog/assignment·mode·sitepolicy/V2지원이 모두 맞고 최신 별도 live capability 관측 verifiedAt가 profile의 maxAge 안일 때만 기존 capability V2 ready와 결합한다. 최초 준비 observedAt를 영구 링크 건강으로 사용하지 않으며 command TTL을 상시 commission TTL로 재사용하지 않는다. 보고/ACK를 독립권한으로 사용하지 않는다. 기존 ready report만으로 우회하지 못하도록 profileKey/currentpreparation 대조를 capability·rule admission·DB guard에 일관되게 적용한다.
- profile은 현재 approved exact fingerprint의 유일한 매칭이어야 한다. 모호한 중복 매칭은 unverified다. 현장 정책 enabled 외에도 저장된 담당자가 현재 active customer/assigned admin인지 재검증하고 변경/해제로 담당자가 사라진 정책을 실제 catalog/규칙에 수렴시킨다. Gateway의 context별 exact ACK pin과 API의 최신 live verifiedAt를 혼동하지 않는다.
- dashboard에 `bioSensorPreparation:{status,commandId,profileKey,observedAt,blockedReasons}`를 반환한다. 이유는 `profile_unverified|fingerprint_unverified|mode_unverified|link_unverified|catalog_pending|operating_policy_required|gateway_protocol_unverified|binding_changed|unsupported`이다. raw fingerprint/body/native는 일반dashboard로 보내지 않는다.
- `vehicleEventSourceView`는 preparation과 currentqualification으로 판정하고 고정 `product_gate_off`를 조건부사유로 바꾼다. source/target보호·BIO1개source·같은gateway/10초하한은 유지한다. enabled의무조건v2_support_unverified 대신 authenticated V2support/currentconditions검사를 사용한다. snapshot applied ACK는 sync에만 사용한다.
- 새등록은 typeddiscovery를 보존·카탈로그대조만 하고 SET0. 기존등록은 공통 준비query로 갱신한다. 철회/재배정/식별교체는 준비증거무효화·affectedruledisable/snapshot수렴을 같은 경계에서 수행한다.

- [x] **Step 1 RED:** source-view 고정 gate 및 SQL authority 부재를 behavioral RED로 확인했다. final self-review는 proposed NULL mode의 OLD fallback을 실제 DB 실패로 재현·수정했다.
- [x] **Step 2 RED 확인:** current mode lineage/최신 독립 링크/정책·catalog·귀속·철회·재시작·nullable 관측·convergence guard의 focused unit/disposable DB 검증을 수행했다.
- [x] **Step 3 구현:** `4d854f41`의 단일 SQL eligibility를 dashboard batch/capability/rules/DBguard에 연결했다. 안전한 기본 legacy classification의 기존 검증을 preparation TX에서 재사용하고 durable convergence·expiry sweep·동일 V2 resync를 구현했다.
- [x] **Step 4 GREEN/문서:** 관련9suites161/확장DB33 이후 final SQL 수정의 Task4 15 PASS(19 비선택)·APItypes/build/diff0. schema/control/monitoring/settings 갱신, 승인 empty/OFF·운영변경0 유지.
- [x] **Step 5 검토·커밋:** 독립 Task4 spec/quality PASS C0/I0/M0. Gateway의 rejected live ACK 철회 및 initial mode instant 전달 누락은 Task6 필수 수정으로 명시했고 API gate를 약화하지 않는다. 최종 sanitized HTTP/DTO를 Web에 인계했다.

### Task 5: 전체 등록 조명의 공통 센서 준비 UI·이벤트 설정

**Owner:** web_frontend.
**Files:** Modify `apps/web/src/api/{automation,queries}.ts`, `VehicleEventDialog.tsx`, `VehicleEventSourceStatus.tsx`와tests; Create `apps/web/src/features/control/automation/BioSensorPreparationPanel.tsx`와tests; 설정센서/현장정책UI는기존settings공통component에결합; `docs/menus/{control,settings,monitoring}.md`.

**Route boundary:** 현장 정책과 관리자 준비 영역은 기존 `/settings/site`의 `SiteOperationsView`와 `capabilities.manage`를 재사용한다. 운영자 호환 프로파일은 `OperatorShell`/권한/공통UI를 따르는 작은 `/operator/sensor-profiles` 섹션으로 분리하고 `docs/menus/operator.md`를 함께 갱신한다. 관리자 계정 목록 화면에는 다른 책임의 프로파일 편집기를 끼우지 않는다. 새 디자인 토큰은 추가하지 않는다.

**Interfaces:** `requestBioSensorPreparation/getBioSensorPreparation`은Task2 POST/GET; 카탈로그/현장정책은관리권한UI만호출한다. 일반사용자는ready경로에동의/확인만하고native/body를입력하지 않는다. 지도에등록전체상태·차단사유를제공하고미준비도행동버튼으로설정가능하게한다. source확정은서버eligible만사용한다.

- [x] **Step 1 RED:** 임의 조명의 미준비 marker inspection·새 operator route·POST 직후 dashboard invalidation을 behavioral RED로 재현했다. mode/checkpoint와 current source eligibility를 구분한 panel 회귀를 추가했다.
- [x] **Step 2 RED 확인:** 신규panel/dialog/settings/operator/API 집중 검증과 실제 Vite·ESM packaging RED를 확인했다.
- [x] **Step 3 구현:** `2873c826`의 공통 단일 bounded panel·finite polling/generation/중복 요청 보호, `/settings/site` 관리자 설정·`/operator/sensor-profiles` 보호 메뉴를 연결했다. 모드/POST/GET만으로 ready를 만들지 않고 server eligible로만 확정한다.
- [x] **Step 4 GREEN/문서:** finalcore44/44·수정 adjacent3/3·실제Chromium11/11(PC/mobile4viewports/pinch)·SharedESM/browser/CJS1·Shared/Webbuild/types/UIpolicy/diff0. 현재 Vite chunk warning baseline 미확인·기존 launcher/env warnings를 숨기지 않았다.
- [x] **Step 5 검토·커밋:** 독립 core spec/quality APPROVED C0/I0/M4. 역사 revision 철회 표시·monitoring 문서·잔존 역할 문구의 작은 follow-up은 같은 Web 소유자에게 배정했고 final review에 포함한다. 등록 cache prefix 미검증은 실제 consumer key 확인으로 해소 후 Task6로 넘긴다. 새 browser framework/실장비 조작0.

### Task 6: 최소 공통 경로 통합·최종 코드 검토

**Owner:** backend/gateway중한명순차소유,qa read-only.
**Files:** Create `apps/api/src/automation/bio-sensor-preparation.integration.spec.ts`와 Gateway `production-bio-pulse-integration.test.ts` 연계fixture(기존file수정허용), 필요최소Web계약회귀; docs/status/checklist.

- [x] **Step 1 RED:** test-only canonical 등록 3개의 실제 API 준비/current eligibility·정확 ACK/V2 snapshot과 동일 fixture의 Gateway 준비/live/config ACK·pulse/full-hold/readback을 교차 확인했다. 초기 등록 프로토콜 또는 단일 프로세스/MQTT/RF E2E로 주장하지 않는다. unknown·철회·재시작도 실제 서비스/가짜 transport의 별도 harness에서 검증했다.
- [x] **Step 2 RED 확인:** current rejected ACK 뒤 과거 GET 재승격, 초기 mode instant 누락, disabled 대상 예약, API 활성 overlap 허용, failed staging rollback의 retained 복원 context 삭제, unknown profile의 unsupported 오표시를 필요한 behavioral RED로 재현했다. 기존 whole suite를 반복하지 않았다.
- [x] **Step 3 구현:** `13e786fd..b2a24978`의 소유자 순차 작업으로 누락만 수정했다. 승인 seed·운영 DB·실장비 변경0, 기존 strict V2 wire 유지. 활성 대상 충돌은 API 저장 전 거부하고 비활성 규칙은 product Gateway 대상을 점유하지 않는다.
- [x] **Step 4 GREEN:** API snapshot unit11/선택 disposable 통합1(34 비선택), Gateway config/live41·production18 이후 변경된 shared 통합2/unknown expectation1·변경 package types/build/diff0. 독립 Task6 spec/quality Approved C0/I0; 겹치는 수치를 합산하지 않고 이전 HIL 결과도 이번 검증으로 복사하지 않는다. Gateway renewed/negative 중간 envelope 일부는 strict/hash 검사이며 실제 의미 검증은 별도 harness임을 기록했다.
- [ ] **Step 5 최종검토·인계:** 전체변경diff한번독립검토,상태/메뉴/schema/checklist를동기화하고코드완료와실제초기profile·운영적용미완료를구분한다. 사용자에게실장비단계전에알리고새권한없이실행하지않는다.
