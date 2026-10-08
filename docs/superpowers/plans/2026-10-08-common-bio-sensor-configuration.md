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

- [ ] **Step 1 RED:** strict 추가 필드·잘못된 byte/build·중복 profile·누락 approval근거·잘못된 TTL·ready에 mode/link누락·다른scope/hash ACK 거부, canonical key의 값/순서와8-byte exact body를 단언한다.
- [ ] **Step 2 RED 확인:** `pnpm --filter @led-control/shared exec vitest run src/bio-sensor-profile-contracts.test.ts src/bio-sensor-preparation-contracts.test.ts`.
- [ ] **Step 3 구현:** 위 타입/schema/helper/topics만 추가한다. 기존 wire는 확장하지 않는다.
- [ ] **Step 4 GREEN:** 같은 focused command와 Shared typecheck/build; 기존 sensor-mode/capability 계약 회귀를 포함한다.
- [ ] **Step 5 검토·커밋:** 담당 보고·독립 spec/quality 검토 후 shared 경계를 저장하고 다음 소비자로 넘긴다.

### Task 2: 서버 카탈로그·준비 요청/결과·버전형 내구 전달

**Owner:** backend.
**Files:** Create `apps/api/src/automation/bio-sensor-profiles.{service,controller}.ts`, `bio-sensor-preparation.{service,controller}.ts`, `bio-sensor-catalog-outbox.service.ts`와 unit/integration specs; Modify Prisma schema/new migration, `automation.module.ts`, MQTT consumer/ACL 계약, `docs/database-schema.md`, `docs/menus/settings.md`.

**Interfaces:**
- Prisma: `BioSensorProfileRevision`(profileId/revision compound key, status, fingerprint/bodyHexes/linkPolicy Json, evidenceDigest/reuseScope, actorId/createdAt), `BioSensorCatalogState`(singleton id/revision), `BioSensorSitePolicy`(siteId key/enabled/ownerUserId/maximumResponseSeconds/escalationAction/revision), `BioSensorCatalogDelivery`(deliveryId,site/gateway/assignment/catalog revision,payload/hash,status,publishedAt/attempts/nextAttemptAt/lease/ACK), `BioSensorPreparationOperation`(commandId,scope/fixture/node/currentbinding hash,clientRequestId/actor,operation,catalogRevision,payload/hash,status,expiresAt/supersededAt,result/hash/event,publish/lease fields). Fixture relation과 indexes를 추가하고 native/raw는 외부 response에 노출하지 않는다. 기존 operation/ledger를 전용하지 않는다.
- `BioSensorProfilesService.list/createRevision/revoke/setSitePolicy/buildCurrentCatalog`; operator/service-provider 카탈로그 관리와 site admin의 현장 설정 권한을 분리하고 기존 재인가 패턴을 사용한다. `/bio-sensor-profiles` 관리 API와 site policy API를 등록한다. approved 초기 seed는 추가하지 않는다.
- `BioSensorPreparationService.create(principal,request)/get(principal,commandId)/ingestAuthenticated(report)`; UI API `POST /bio-sensor-preparations`, `GET /bio-sensor-preparations/:commandId`. 기존 mode operation을 변경하지 않고 공통 client의 query/ensure를 새 handler가 재사용한다.
- 전용 catalog delivery worker는 lease/retry를 쓰지만 기존 automation revision/applicationAckKey를 유용하지 않는다. current claim/inventory/certificate/assignment를 lock 안에서 확인하고 publish는 transaction 밖에서 수행한다. exact ACK의 scope/hash/revision을 확인해 desired/applied를 저장한다.
- prepared result는 현재 request/TTL/binding/catalog/profile/시간과 대조해 immutable 저장·ACK를 동일 transaction에 둔다. mode/GET만 성공하면 ready로 만들지 않는다. 재전송에는 동일 결과를 반환하고 새로운 failed 보고가 과거 ready를 유지하지 않게 한다.

- [ ] **Step 1 RED:** 권한·재배정·기한·profile 철회·scope/hash 불일치·중복/replay, 빈 catalog·mode-only 거부·query SET0 계약을 재현한다.
- [ ] **Step 2 RED 확인:** API focused unit과 일회용 PostgreSQL integration(사용자 DB에 연결하지 않는다).
- [ ] **Step 3 구현:** immutable profile revisions, site policy OFF 기본값, 전용 worker, prepare request/result/ACK를 기존 lease/identity-lock 방식으로 구현한다. MQTT dispatch와 strict topic ACL을 연결한다.
- [ ] **Step 4 GREEN/문서:** focused unit/temporary DB migrations와 API typecheck/build, database-schema/settings 갱신. 등록 ID/brightness/history 보존을 확인한다.
- [ ] **Step 5 검토·커밋:** report에 exact migration/검증과 운영 미적용을 명시하고 검토 후 Gateway로 계약을 넘긴다.

### Task 3: Gateway discovery 보존·동적 카탈로그·실제 준비/authority 공급

**Owner:** gateway.
**Files:** Modify `bio-dongle-client.ts`, `bio-device-mapping-store.ts`, `adapters/adapter-factory.ts`, `bio-sensor-pulse-source.ts`, `index.ts`; Create `bio/bio-sensor-profile-catalog.ts`, `bio/bio-node-link-monitor.ts`, `bio/bio-pulse-authority-provider.ts`, `commands/bio-sensor-preparation-handler.ts` 및 대응 tests; 기존 registered observation·MQTT routing/ACK·health lifecycle 및 Gateway ACL 계약; `docs/menus/{settings,control}.md`.

**Interfaces:**
- `BioDiscoveredDevice.fingerprint?: BioSensorFingerprintV1`; fresh discovery에서 보존하며 legacy mapping은 fingerprint없음→unverified. 단순 firmware문자열에서 만들어내지 않는다.
- `BioPulseCatalogPort.snapshot()/onChange()`: immutable current scoped catalog/revision/hash를 공급한다. `FileBioSensorProfileCatalog.apply(envelope)`는 strict scope/hash·monotonic revision·durability 후 ACK, stale/duplicate/conflicting 거부. restart에는 독립 health 복구0.
- `BioNodeLinkMonitor.start()/snapshot(fixtureId)/stopAndDrain()`: 승인 profile과 exact commission에만 기존 readDeviceInfo 전역 queue로 node mode GET, monotonic maxAge/generation 확인·연속healthySince 유지. pulse/alive로 health를 만들지 않는다. fresh probe가 health를 갱신해도 authority의 stable observation을 불필요하게 변경하지 않으며 실패/만료 시즉시철회한다.
- `CommissionedBioPulseAuthorityProvider.read()/onChange()`는 승인 profile·현재 canonical command/binding·mode/link·카탈로그 실행정책·현재 적용/준비중 authenticated snapshot context를 합성한다. requested snapshot revision만으로 신뢰하지 않고 index/runtime에서 실제 검증된 snapshot context를 공급한다. capabilityRevision은 현재 node-local 전달 원장의 revision과 결속한다.
- preparation handler는 exact authenticated command/mapping·fresh discovery와 approved profile matching 뒤에만 ensure_sensor를 수행한다. query는 SET0. ready/불가사유 결과를 내구 journal에 저장하고 정확 ACK까지 재전송한다. 단순 onIdentityProof는 mode전 호출이므로 실제 별도 GET 뒤 mode/link 증거를 생산한다. canonical MeshNode와 local nodeId를 합치지 않는다.
- dynamiccatalog/source를 한 수명 경계에서 교체하고 queued/cached receipt·authority 철회를 즉시 수행한다. 확인된 원상태/미확정 pending을 삭제하거나 profile승인을 환경변수로 주입하지 않는다. 기존 source intake/target/controller를 재사용한다.

- [ ] **Step 1 RED:** 서로 다른 Fixture/native3개 동일profile매칭, 다른hardware거부, legacyunknown, serialquery/lateGET, setupmode-only, catalog교체/await중revocation, reconnect/restart·decoderfailure·healthage를 재현한다.
- [ ] **Step 2 RED 확인:** 신규 Gateway tests + 기존 source/production integration focused Vitest.
- [ ] **Step 3 구현:** discovery→mapping/준비 관측 보존, catalog/handler/monitor/provider·실제 MQTT/ACK/index wiring을 연결한다. approved 기본catalog빈상태와 BlueZ 없는 BIO경로를 유지한다.
- [ ] **Step 4 GREEN/문서:** 집중 Gateway unit/integration·typecheck/build, control/settings 갱신. 실제 RF/장비 배포 없이 가짜 transport만 사용한다.
- [ ] **Step 5 검토·커밋:** report·독립 spec/quality 검토와 기존 unresolved/state 수명 확인 후 서버 준비 projection으로 넘긴다.

### Task 4: API 준비 projection·조건부 이벤트 활성화·등록 연결

**Owner:** backend.
**Files:** Create `apps/api/src/automation/bio-sensor-eligibility.ts`와 대응 spec; Modify `sites/vehicle-event-source-view.ts`, `sites.service.ts`, `vehicle-sensor-capability.service.ts`, `vehicle-event-rules.service.ts`, 등록 terminal/discovered projection, Task2 services/tests, 필요한 forward migration 및 `docs/{database-schema,menus/control,menus/monitoring,menus/settings}.md`.

**Interfaces:**
- 준비report→profile/currentcatalog/assignment·mode·linkdeadline·sitepolicy/V2지원이 모두 맞을 때만 기존 capability V2 ready와 결합한다. 보고/ACK를 독립권한으로 사용하지 않는다. 기존 ready report만으로 우회하지 못하도록 profileKey/currentpreparation 대조를 capability·rule admission·DB guard에 일관되게 적용한다.
- dashboard에 `bioSensorPreparation:{status,commandId,profileKey,observedAt,blockedReasons}`를 반환한다. 이유는 `profile_unverified|fingerprint_unverified|mode_unverified|link_unverified|catalog_pending|operating_policy_required|gateway_protocol_unverified|binding_changed|unsupported`이다. raw fingerprint/body/native는 일반dashboard로 보내지 않는다.
- `vehicleEventSourceView`는 preparation과 currentqualification으로 판정하고 고정 `product_gate_off`를 조건부사유로 바꾼다. source/target보호·BIO1개source·같은gateway/10초하한은 유지한다. enabled의무조건v2_support_unverified 대신 authenticated V2support/currentconditions검사를 사용한다. snapshot applied ACK는 sync에만 사용한다.
- 새등록은 typeddiscovery를 보존·카탈로그대조만 하고 SET0. 기존등록은 공통 준비query로 갱신한다. 철회/재배정/식별교체는 준비증거무효화·affectedruledisable/snapshot수렴을 같은 경계에서 수행한다.

- [ ] **Step 1 RED:** mode-only/과거ready/카탈로그미ACK/정책OFF/다른귀속/만료link 거부, current준비+V2지원만enable, profile철회→disable·부분rollback을 재현한다.
- [ ] **Step 2 RED 확인:** source-view/rules/capability focused tests와Task2 temporaryDB통합.
- [ ] **Step 3 구현:** 단일 eligibility정책을 server admission/dashboard/DB guard와연결하며 V1/old BIOOFF호환을 유지한다.
- [ ] **Step 4 GREEN/문서:** 집중검증·APItypecheck/build·해당DB통합·메뉴문서. 승인기본값OFF·실제운영미적용을 명시한다.
- [ ] **Step 5 검토·커밋:** Gate의falsepositive/저장→snapshotACK소프트웨어흐름을 확인해Web으로넘긴다.

### Task 5: 전체 등록 조명의 공통 센서 준비 UI·이벤트 설정

**Owner:** web_frontend.
**Files:** Modify `apps/web/src/api/{automation,queries}.ts`, `VehicleEventDialog.tsx`, `VehicleEventSourceStatus.tsx`와tests; Create `apps/web/src/features/control/automation/BioSensorPreparationPanel.tsx`와tests; 설정센서/현장정책UI는기존settings공통component에결합; `docs/menus/{control,settings,monitoring}.md`.

**Interfaces:** `requestBioSensorPreparation/getBioSensorPreparation`은Task2 POST/GET; 카탈로그/현장정책은관리권한UI만호출한다. 일반사용자는ready경로에동의/확인만하고native/body를입력하지 않는다. 지도에등록전체상태·차단사유를제공하고미준비도행동버튼으로설정가능하게한다. source확정은서버eligible만사용한다.

- [ ] **Step 1 RED:** 임의이름/ID의3조명표시·unready설정/ready선택·실패/재조회/중복클릭/늦은응답·profileunknown·samegateway/source배제·10/1800·PC잘림과모바일조작 회귀를 작성한다.
- [ ] **Step 2 RED 확인:** 신규panel·source-status·eventdialog focused Vitest.
- [ ] **Step 3 구현:** 기존 Button/Card/Text/지도selection을재사용해준비상태공통panel을연결하고 A/B전용문구를역할기반문구로바꾼다. polling은유한대기·manualretry로하며모드POST접수를ready로표시하지않는다.
- [ ] **Step 4 GREEN/문서:** focused Web/typecheck/build/UI policy,PC·mobile실제component검증. 정책/프로파일관리화면은권한분리·approval없는기본OFF를명시한다.
- [ ] **Step 5 검토·커밋:** 영향메뉴정리·독립spec/quality검토. browser시험도구를새로만들지않는다.

### Task 6: 최소 공통 경로 통합·최종 코드 검토

**Owner:** backend/gateway중한명순차소유,qa read-only.
**Files:** Create `apps/api/src/automation/bio-sensor-preparation.integration.spec.ts`와 Gateway `production-bio-pulse-integration.test.ts` 연계fixture(기존file수정허용), 필요최소Web계약회귀; docs/status/checklist.

- [ ] **Step 1 RED:** syntheticapprovedprofile1개·서로다른조명3개로 등록/준비→catalogACK→currentcapability→UIrule저장→V2snapshot/ACK→pulsehold→readback복원을교차확인한다. unknown다른조합과철회/재시작negative를같은fixture로검증한다.
- [ ] **Step 2 RED 확인:** 필요한 missinghandoff만재현하고 기존whole suite재실행을대체하지않는다.
- [ ] **Step 3 구현:** 발견된연결누락만소유역할에수정배정한다. 실제profile승인seed/운영DB/장비조작은없다.
- [ ] **Step 4 GREEN:** 신규cross-boundaryfocused통합·변경package타입/빌드·diffcheck. 통과한패키지full/기존HIL수치를이번통과로복사하지않는다.
- [ ] **Step 5 최종검토·인계:** 전체변경diff한번독립검토,상태/메뉴/schema/checklist를동기화하고코드완료와실제초기profile·운영적용미완료를구분한다. 사용자에게실장비단계전에알리고새권한없이실행하지않는다.
