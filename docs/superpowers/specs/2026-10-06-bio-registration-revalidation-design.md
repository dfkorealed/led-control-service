# 기존 BIO 조명 등록의 현재 장치 재검증·감사 수복 설계안

기준일: 2026-10-06. **사용자가 승인한 삭제 없는 현재 장치 재검증의 소프트웨어 Tasks1~6 구현·집중 검증·독립 검토는 완료했다. 최종 신규 DB108/108·직접 회귀5/5·API/Gatewaytypecheck/build0이며 운영 적용·실제 B 수복·센서 감지/독립 건강 공급 완료는 아니다. 결과와 미완료 관문은 `docs/superpowers/plans/2026-10-06-bio-registration-revalidation.md`를 따른다.**

## 목적과 범위

재검색으로 B의 `DiscoveredMeshNode.status`가 `discovered`로 내려간 문제를 해결한다. 과거 `completed` terminal 원문을 복원했다고 주장하지 않고, 현재 동일 장치에 대한 새 읽기 전용 확인과 관리자의 감사 수복으로 등록 상태를 정리한다. Fixture/정식 MeshNode/등록 후보 ID, 이름·좌표·밝기·전원·그룹·명령 및 등록 이력은 보존한다.

초기 범위는 현재 canonical BIO graph가 이미 존재하는 **조명 한 개**의 관리자 API다. 신규 등록, 삭제·재등록, 일괄 backfill, BlueZ 전체 제거, 고객용 새 화면, 센서 profile/healthy/supported 승격은 포함하지 않는다. B 수복 뒤 기존 A/B 원자 분류 API를 별도로 적용한다. 센서 감지·독립 건강 확인은 기존 BIO 펄스 계획 Task9로 남긴다.

## 현재 코드와 선택 근거

- 기존 분류 서비스는 `provisioned/confirmed`와 정확한 저장 provision command를 요구하므로 현재 B를 거부한다. 이 검사는 유지한다.
- 기존 terminal의 중복 재생은 ACK만 반환한다. 원문을 찾지 못한 상황에서 상태나 terminal 원문을 만들어 넣지 않는다.
- 공개 sensor-mode API와 publisher/ingest는 이미 BIO로 분류된 node만 받는다. 또한 `verified`는 `sensor` 확인만 뜻하고 force-on/off의 `mismatch`는 시간 검증된 성공 proof가 아니다. 기존 의미·권한·CHECK는 바꾸지 않는다.
- `BioUsbDongleAdapter.sensorModeOperation(...operation: "query")`는 현재 Fixture/native hash/address, confirmed mapping, fresh discovery, transport generation과 exact mode GET을 검증한다. 이 low-level 조회만 재사용할 수 있다. discovery/GET 장치 통신은 발생하지만 밝기·mode SET은 없다.
- 별도 등록 재검증 목적의 strict command/result와 보관 row를 선택한다. 기존 sensor-mode 경로에 목적을 섞는 대안은 BIO-only·시간·capability observer·verified 의미를 동시에 바꿔야 하므로 채택하지 않는다. 직접 SQL 수정/삭제·재등록도 채택하지 않는다.

## 관리자 흐름과 권한

1. `POST /registration-sessions/bio-revalidations`로 현재 조명 확인을 요청한다. 입력은 strict `{ siteId, gatewayId, fixtureId, expectedAssignmentVersion, clientRequestId }`뿐이다. 요청자는 현재 사이트의 commission 권한을 가진 관리자여야 한다.
2. 서버가 현재 canonical Fixture/MeshNode/DiscoveredMeshNode/session/저장 provision command를 조회·검증하고, 하나의 durable operation과 서버 소유 binding snapshot을 저장한다. 현재 B처럼 `discovered/confirmed`인 기존 graph만 대상이다. identify command, 임의 UUID prefix만 있는 node, 미확정 mapping, graph/주소/배정 불일치는 거부한다.
3. publisher가 현재 권한·배정을 다시 확인하고 조회 command를 전달한다. DB transaction을 잡은 채 USB 응답을 기다리지 않는다.
4. Gateway가 기존 단일 client에서 조회하고 durable 결과를 API에 보고한다. `GET /registration-sessions/bio-revalidations/:commandId`는 같은 사이트 commission 권한과 요청자 귀속을 확인한 최소 상태만 반환한다.
5. 관리자 요청 `POST /registration-sessions/bio-revalidations/:commandId/apply`가 새 proof를 소비해 등록 후보 상태를 `provisioned`로 바꾼다. 조회 성공만으로 자동 수복하지 않는다. 구현 후 현장 실행 시각·중단/원복 경계는 별도로 확정한다.

모든 create/get/apply/retry에서 현재 권한을 다시 확인한다. 입력의 actor/native UUID/raw payload/지원 상태를 신뢰하지 않는다. Gateway claim·inventory·assignment와 active/unrevoked MQTT 인증서의 notBefore/notAfter까지 검사한다. broker mTLS/ACL과 DB 인증 상태를 사용하며 per-message hardware peer certificate를 직접 확인했다고 표현하지 않는다.

## 전달 계약 — 기존 V1/V2 불변, 독립 목적

새 `packages/shared/src/bio-registration-revalidation-contracts.ts`에 독립 strict schema/type/topic helper를 추가한다. 기존 sensor-mode/terminal/automation 계약은 불변이다.

- command: `version: 2`, `purpose: "bio_registration_revalidation"`, `operation: "query"`, command/site/gateway/fixture/canonical node ID, expected assignmentVersion, deviceIdentityHash, canonical meshAddress, requestedAt, expiresAt. ID/hash/주소 형식은 기존 sensor-mode의 동일 제약을 사용한다. native UUID·사용자 입력 밝기·ensure_sensor는 넣지 않는다.
- 결과: 동일 목적·operation·전체 identity, eventId, sequence, occurredAt. `status: "observed"`에는 `evidence: "mode_get"`, observedMode=`sensor|force-on|force-off`만 포함한다. 실패는 `unknown|timed_out`과 고정 errorCode다. observed는 현재 identity/address에서 설정 mode를 읽었다는 의미이며 역사적 등록 완료·밝기/전력·감지 또는 건강 확인이 아니다.
- command TTL은 최대 **30초**, 실제 owned 조회 budget은 기존 **8초** 이내다. Gateway clock 불신뢰/재시작/만료/취소/identity 변경은 observed를 만들지 않는다. 이미 USB에 제출된 통신의 물리 취소를 보장한다고 표현하지 않는다.
- topics: `sites/{siteId}/gateways/{gatewayId}/commands/bio-registration-revalidation`, `.../events/bio-registration-revalidation-result`, `.../acks/bio-registration-revalidation-result`. 기존 topic scope와 ACL 인증 경계를 따른다.
- 수용 ACK는 purpose/site/gateway/assignment/command/event/fixture/node/sequence와 **전체 result payload hash**에 묶는다. ingested/duplicate/stale_checkpoint는 결과 수용 상태일 뿐 등록 수복·센서 활성화 성공이 아니다. 구 Gateway가 모르는 command는 timeout/미지원으로 남고 기존 ACK로 성공을 대체하지 않는다.

Gateway는 registration 전용 handler를 사용한다. low-level query에는 operation=query를 고정하고 기존 센서 capability `onIdentityProof` observer를 호출하지 않는다. journal의 요청 동일성, in-flight 단일 소유, terminal 원자 저장, outbox/ACK 재전송·종료 대기는 재사용한다. 새 목적이 기존 sensor-mode pending 복구/ACK와 섞이지 않도록 kind를 구분한다. 중단 뒤 새 operation 없이 조회를 재실행하거나 과거 observed를 새 proof로 만들지 않는다.

## DB와 fresh proof

새 additive migration으로 `BioRegistrationRevalidationOperation`을 추가한다. 기존 migration/terminal ledger/등록 command는 수정하지 않는다. `docs/database-schema.md`도 실제 스키마 구현과 같은 작업에서 갱신한다.

row에는 서버 생성 commandId, site/gateway/fixture/node/등록 session·후보·원 provision command ID, 요청자/clientRequestId, assignmentVersion, identity hash/주소와 binding snapshot/hash, command payload/hash, requestedAt/expiresAt/**applyDeadlineAt**, 상태, immutable result/hash/event ID, supersededAt, appliedAt/repair audit 연결, publisher lease/attempt 필드를 저장한다. `(siteId, requestedById, clientRequestId)`와 resultEventId는 unique다. Fixture의 복합 site 귀속 FK 및 삭제 정책은 기존 SensorModeOperation과 동일한 cascade/restrict 정책을 따르되 기존 감사 이력은 새 row 삭제에 연동해 삭제하지 않는다.

- `applyDeadlineAt=requestedAt+120초`로 서버가 고정한다. duplicate receipt/retry/restart로 기한을 연장하지 않는다. 새 요청은 해당 fixture의 미소비 이전 요청을 supersede하며 결과는 감사용으로 보존한다.
- observed 수용은 모든 mode에 동일하게 `requestedAt ≤ occurredAt ≤ expiresAt`, `receivedAt < expiresAt`, `occurredAt ≤ receivedAt+1초`를 요구한다. 서버/장비 시각이 검증되지 않거나 현재 binding이 바뀌면 observed proof로 승격하지 않는다. stale/비성공 결과의 감사 보존·ACK와 성공 proof를 구분한다.
- 결과를 받은 것만으로 Fixture 출력, 프로토콜, readiness, qualification, heartbeat를 갱신하지 않는다. unknown/만료·superseded/현재 귀속 불일치는 수복 불가다. 같은 event/command의 다른 hash는 원본을 덮지 않는다.
- 현재 canonical graph와 등록 command는 역사적 completed 증거 대신 현재 수복의 대상·귀속 근거다. 보존돼 있는 ACK/ledger는 exact scope/hash 일치를 대조하되 ACK 자체로 completed를 추론하지 않는다. 과거 원문이 없어도 current-device 방식임을 감사에 명시한다.

## 원자 수복과 분류

create/publish/ingest/apply는 각 단계에서 현재 binding을 재확인한다. 기존 membership→Site commission→registration Floor/Gateway/Session/후보/Outbox→native UUID advisory→MeshNode/Fixture 잠금 순서를 사용하고 operation row는 그 뒤 잠근다. network GET을 transaction 안에서 기다리지 않는다.

apply는 다음 조건을 같은 transaction에서 확인한다: 미소비·미supersede observed proof, 현재 시각이 applyDeadlineAt 미만, 현재 commission/인증/배정, 동일 Fixture↔정식 MeshNode↔등록 후보/native hash/address/session/provision command, 현재 `discovered/confirmed` 상태, 진행 중인 상충 등록 작업 없음. 조건부 UPDATE와 필수 AuditLog INSERT가 모두 성공할 때만 commit한다. AuditLog 실패/동시 교체/등록 경합은 전체 rollback한다.

수복은 **등록 후보 status만** 변경하고 identifyState/session 완료 여부/terminal/processed event/원래 command/Fixture 출력·ID·그룹을 바꾸지 않는다. 감사 action은 `bio_registration_current_revalidated`, evidenceKind는 `current_device_revalidation`이다. 원래 상태, 새 operation/result hash, 현재 binding 및 원 provision command를 결속하며 과거 completed terminal을 발견했다고 기록하지 않는다.

동일 applied operation 재시도는 현재 권한과 귀속을 확인하고 기존 결과만 반환하며 새 audit/UPDATE/GET을 만들지 않는다. 미소비 proof가 만료되면 새 operation이 필요하다. graph가 없어지거나 바뀐 뒤 옛 proof로 수복하지 않는다.

수복 뒤 기존 `reconcile-bio-classification`의 A/B 원자 요청을 별도로 사용한다. 이 서비스의 `provisioned/confirmed`와 현재 귀속 검사는 유지한다. 신규 applied revalidation 이력이 있는 graph의 evidenceKind를 `current_device_revalidation`으로 구분하여 새 수복을 historical completed evidence로 오표시하지 않는다. BIO 분류는 OFF만 설정하며 이미 정상인 qualification을 낮추거나 센서 지원·이벤트를 켜지 않는다.

## 구현 경계와 검증

공유 계약 담당 한 역할→API/DB→Gateway→최종 집중 통합/문서 순서로 진행한다. 실제 작성은 상세 설계안·구현 계획 검토 뒤 시작한다. 주요 경계는 새 shared 계약, API registration service/controller/module·publisher/consumer·schema/migration, Gateway 전용 handler/journal/outbox/index, 기존 분류 evidence adapter와 대응 테스트다. 필요한 broker ACL 계약은 소프트웨어 검증만 하며 실제 reload는 하지 않는다.

검증은 새 기능의 RED→GREEN·일회용 DB·가짜 단일 동글과 관련 회귀로 한정한다. 기검증 전체 suite를 이유 없이 반복하지 않는다.

- 성공 mode 세 종류 모두 실제 GET 확인과 SET0, Fixture/canonical node UUID가 다른 정상 매핑. capability observer 0, profile/healthy/readiness/밝기·전원 변경0.
- 다른 purpose/legacy result, 잘못된 actor/site/claim·만료/폐기 인증서, command/identity/hash/topic/assignment 불일치 거부.
- 요청 전/TTL 후 occurredAt, 늦은 receipt, supersede, Gateway 재시작/transport 변경/취소, apply deadline 경계 및 proof 재사용으로 수복되지 않음.
- 중복/충돌 event와 outbox 재전달, transaction/audit 실패, 등록·scan·mapping 교체와의 양방향 경합, 현재 ID/이력/출력 보존.
- 원자 수복 후 기존 A/B 분류: B 현재 재검증 감사와 분류 감사를 구분, 두 번째 fixture 실패 전체 rollback, 기존 historical evidence와 sensor-mode 의미·권한 회귀 보존.

## 실제 적용 전 조건과 완료 정의

현재 sensor HEAD `8ec4c4f1`과 기본 `f74fc94f`는 분기돼 있다. 별도 브랜치의 software 검증은 운영 적용이 아니다. 현재 UI·DB 변경을 보존하는 필요한 BIO 계약/migration 통합, 현재 환경/DB migration/인증·장비 귀속 확인, 백업·운영 적용 승인, 미확정 복원 원장 검토와 장비 조회창 합의가 선행한다. 예전 CRL·heartbeat·조회 결과를 오늘 근거로 재사용하지 않는다.

실제 장비 조회는 SET0이어도 discovery/GET 통신 및 USB 단일 소유가 필요하다. 원본 서비스를 중단하거나 재시작하는 경우에는 사용자와 시간창을 먼저 합의한다. 기존 미확정 원장을 삭제하지 않는다. B 조회/수복이나 감지 시험을 이 문서 작성만으로 시작하지 않는다.

완료는 소프트웨어 구현·집중 검증·독립 검토와 **실제 B 현재 조회/감사 수복/ID·밝기·이력 보존 확인**을 분리해 판정한다. 실제 A/B BIO 분류와 센서 감지/독립 건강 공급·제품 ON은 각각 별도 결과이며, 이 수복 성공만으로 센서 연동 완료를 선언하지 않는다.
