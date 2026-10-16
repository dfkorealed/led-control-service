# 실제 조명 등록 삭제 구현 계획

> 담당 에이전트: `superpowers:subagent-driven-development`로 작업별 구현·검토를 수행한다. 사용자는 2026-10-16 계획 작성 후 즉시 구현과 별도 브랜치 후 메인 병합을 승인했다. 추가 계획 승인 대기로 중단하지 않는다.

**목표:** admin이 BIO 조명의 서비스 등록을 안전하게 삭제하고 이력 보존과 동일 제품 재등록을 지원한다.

**구조:** durable 삭제 작업/결과 원장으로 서버와 Gateway의 정리를 연결한다. 완료 전 신규 작업을 차단하고, 완료 후 Fixture/MeshNode를 이력 전용으로 퇴역시킨다. 기존 공통 확인창과 현장 관리 조명 카드를 확장한다.

**기술:** 기존 TypeScript/Zod·NestJS/Prisma/PostgreSQL·MQTT·Node Gateway·React/React Query·React Aria·Vitest/Jest/Playwright. 신규 제품 의존성은 추가하지 않는다.

**설계:** `docs/superpowers/specs/2026-09-12-settings-assets-operations-design.md`의 `2026-10-15 추가 설계: 실제 조명 등록 삭제`.

## 공통 제약

- 작업 브랜치 `codex/fixture-registration-removal-20261015`, 정본 메인 `codex/mvp1-cloud-web`. MAIN의 사용자 AGENTS/상태판 및 병행 작업을 보존한다.
- 실제 DB migration/삭제, Pi 배포·재시작/RF, PKI/ACL 변경은 하지 않는다. PostgreSQL 통합 검증은 소유한 임시 DB만 사용한다.
- 신규 BIO만 지원하며 기존 native 장치와 데이터는 보존한다. 삭제가 물리 초기화·소등·센서 모드 변경이 아님을 명시한다.
- 과거 명령/등록/통계 FK는 유지하고 운영 등록만 퇴역한다. retired Fixture/MeshNode는 운영 조회·새 mutation·late telemetry에서 사용하지 않는다.
- Gateway 미지원/오프라인, 구역·스케줄·이벤트 연결, 불확정/진행 제어·복귀·맵 편집은 거절한다. 실행 여부 불명은 성공이나 단순 실패로 바꾸지 않는다.
- 공유 계약과 schema는 Task 1 소유자만 작성한다. 이후 Gateway/API/Web은 확정된 계약을 읽으며 변경 요청은 총괄이 직렬 배정한다.

## 중점 검토

1. 삭제 접수와 새 제어/규칙/맵 저장이 동시에 통과하지 않아야 한다(Task 1/3).
2. Gateway가 mapping을 읽은 직후 삭제되어도 USB write 전에 구세대 작업을 차단해야 한다(Task 2).
3. Gateway 정리 후 서버 반영 실패/ACK 유실·재시작은 같은 원장으로 복구해야 한다(Task 2/3).
4. 퇴역 장비의 과거 제어/통계는 유지하고 새 등록에 이전 상태가 승계되지 않아야 한다(Task 3/5).
5. UI 재조회 실패·새로고침·이중 클릭·현장 전환이 다른 장비 삭제나 성공 오표시를 만들면 안 된다(Task 4/5).

## Task 1: 공유 계약과 DB 기반

**담당:** backend. **소유:** `packages/shared`, `apps/api/prisma`, 삭제 기반 API 파일, `docs/database-schema.md`.

**파일:** 신규 `packages/shared/src/fixture-registration-removal-contracts.ts`와 테스트/공통 export, `gateway-contracts.ts`; Prisma schema와 순방향 migration; 신규 `apps/api/src/fixtures/fixture-registration-removal-policy.ts`와 migration/정책 테스트.

**인터페이스:**
- `fixtureRegistrationRemovalRequestSchema`: `{clientRequestId: UUID, expectedUpdatedAt: ISO}`.
- `FixtureRegistrationRemovalPreview`: `fixtureId`, `fixtureName`, `serialNumber: string|null`, `allowed`, `blockedReasons: {code,message}[]`.
- `FixtureRegistrationRemovalView`: `operationId`, `siteId`, `floorId`, `fixtureId`, `status: pending|gateway_confirmed|completed|rejected|reconcile_required`, `errorCode: string|null`, `createdAt`, `completedAt: string|null`.
- `fixtureRegistrationRemovalCommandSchema`: version1, operationId/siteId/gatewayId/gatewaySerial/assignmentVersion/fixtureId/nodeId/deviceUuid/meshAddress/originalProvisionCommandId/bindingHash/requestedAt/expiresAt. UUID/주소/일관성은 strict 검증한다.
- terminal은 동일 command identity와 `eventId`, `occurredAt`, `status: removed|rejected|reconcile_required`, `errorCode`를 갖는다. 명령 hash는 서버/Gateway가 기존 canonical hash 방식으로 대조한다. application ACK도 operation/event/hash를 결합한다.
- `fixtureRegistrationRemovalTopics`는 `sites/{siteId}/gateways/{gatewayId}/commands/registration-removal`, `/events/registration-removal`, `/commands/registration-removal-ack`를 제공한다. 실제 ACL 생성 계약도 API/장비 소유자가 통합한다.
- `nodeId`는 원 provisioning command의 후보 ID이며 Cloud MeshNode.id와 구별한다. `fixtureRegistrationRemovalBindingIdentity(command)`는 `{version,siteId,gatewayId,gatewaySerial,assignmentVersion,fixtureId,nodeId,deviceUuid,meshAddress,originalProvisionCommandId}`만 반환한다. bindingHash는 이 객체의 canonical JSON을 SHA256한 `sha256:`+hex이며 commandHash는 전체 command를 같은 방식으로 해시한다. DB 원장은 Cloud meshNodeId도 별도 보존한다.
- Gateway heartbeat `fixtureRegistrationRemovalVersion?: 1`; DB default0은 미지원이다. Fixture/MeshNode `retiredAt: DateTime?`; Gateway 지원 버전, 삭제 작업(원장/outbox/불변 snapshot·중복 방지·결과·재전송·lease)을 추가한다.

- [x] RED: strict 계약/미지원 heartbeat·원장 idempotency·퇴역 row/동시 mutation 보호 migration 회귀 작성 및 실패 확인.
- [x] 위 계약/schema/공유 상태 판정 구현. 기존 기능 default는 모두 active/null이며 퇴역을 offline으로 표현하지 않는다.
- [x] shared 테스트/type/build·격리 PostgreSQL migration 검증, DB 문서 갱신, 소유 파일 커밋.
- [x] 독립 task 검토와 필요한 수정/재검토 후 소비 계약을 고정한다.

## Task 2: Gateway 영속 삭제와 실행 직전 차단

**담당:** gateway. **소유:** `apps/gateway`, 합의된 MQTT ACL 생성에 필요한 gateway 인프라 파일만.

**파일:** 신규 `commands/fixture-registration-removal-handler.ts`, 영속 원장/테스트; `bio/bio-device-mapping-store.ts`, `adapters/bio-usb-dongle-adapter.ts`, `index.ts`, health/automation 직접 경계와 관련 테스트.

**인터페이스:** Task 1 command/terminal/ACK/topics. Handler는 exact assignment/기존 등록 identity를 검사하고 `removed`를 durable 저장한 뒤 재전송한다. 같은 operation 내용 충돌은 거절한다. mapping 삭제·퇴역 fence·onChange는 같은 영속 경계다.

- [ ] RED: 정상 삭제/무관장치 보존·중복/재시작·ACK 유실·mapping 캡처 후 delete→write·오프라인 조명·진행/복귀/규칙 거절·과거 provision 재생·새 등록을 작성하고 실패 확인.
- [ ] 삭제 중 장비별 admission 잠금과 실제 RF 직전 재검사, runtime/authority/poll/member 정리, terminal/application ACK와 heartbeat version1을 기존 production 실행 경로에 연결한다. 하드웨어 초기화/밝기 SET은 호출하지 않는다.
- [ ] Gateway 관련 테스트/type/build 및 MQTT topic 인가 검증 후 커밋·독립 검토한다. 원장만 만들고 index에 미연결인 구현은 완료가 아니다.

## Task 3: 서버 삭제 흐름과 운영/이력 경계

**담당:** backend. **소유:** `apps/api`, `docs/database-schema.md`. Task 2와는 확정된 계약만 공유한다.

**파일:** 신규 삭제 controller/service/publisher/terminal·모듈/테스트; 기존 fixtures/site-settings/sites/floor-editor/map-display/registration/commands/automation/energy/MQTT의 실제 운영 조회·mutation·late-ingestion 경계.

**인터페이스:** 설계의 조명 경로 아래 GET preview, POST removals(202), GET removals/:operationId. Task 1 response 타입과 exact terminal/ACK를 사용한다.

POST 응답 유실 복구를 위해 `GET registration-removals/by-request/:clientRequestId`는 같은 actor/site/floor/fixture의 `FixtureRegistrationRemovalView|null`을 반환한다. POST의 같은 요청 ID 재생은 인가 뒤, expectedUpdatedAt·진행 차단 검사보다 먼저 조회한다. 이 예외는 동일 body 재생에만 적용하며 새 요청은 허용하지 않는다.

- [ ] RED: assigned admin만 허용·다른 현장404·preview와 POST 재검사·offline/version0·스케줄/이벤트/구역/제어·맵 lease409·요청 ID 재생/충돌·Gateway 완료 후 DB 실패/재시작을 작성하고 실패 확인.
- [ ] POST는 canonical 잠금/재인가 후 snapshot·outbox를 원자 생성한다. DB-only 보호와 기존 생산자의 pending/retired 거절을 연결한다. Publisher 네트워크 I/O는 DB transaction 밖이며 trusted time/assignment·인증 계약을 유지한다.
- [ ] exact 결과·재조정과 최종 퇴역/UUID 해제/맵·내부 그룹/catalog 동기화를 연결한다. raw/Prisma 조회·모니터링 수·pagination·선택·상태수집·기존 맵 복구를 조사해 retired 제외와 이력 읽기를 분리한다. 기존 전력 집계는 보존하고 삭제 뒤 적산을 종료한다.
- [ ] 임시 실제 PostgreSQL로 pending↔제어/등록 경쟁·late telemetry/ACK·실패 재시도·퇴역 후 동일 UUID 새 등록·구/신 통계/제어 이력을 검증한다. API 관련 테스트/type/build 후 커밋·독립 검토한다.

**Preflight 추가 인수 조건:**
- `energy/fixture-state-ingestion.service.ts`의 요금 변경 cursor 재적산도 닫는다. 최종 transaction에서 기존 `retireFixture()`를 연결하고 삭제→요금 변경→늦은 상태→동일 제품 재등록 뒤 구/신 집계가 분리되는지 검증한다.
- `floor-editor.service.ts`의 `existingFixtureIds`는 물리 존재가 아니라 운영 등록 자격으로 판정한다. legacy/document 복구·slot·save·snapshot에 같은 조건을 적용하고 두 복구 경로의 `skippedFixtureIds`·다른 도형 보존을 검증한다. `FixtureFreshnessService` raw UPDATE와 `MonitoringIncidentReconcilerService`의 운영 조회도 포함한다.
- `TargetSnapshotService`, BIO eligibility/binding과 `MeshControlGroupService` desired 조회는 잠금 뒤 pending/불확정/retired를 거절한다. `BioSensorProfilesService.catalogInTransaction()`은 동일 revision의 과거 payload를 재사용하므로 새 catalog revision 발행·정확 applied ACK를 확인해야 하며 퇴역 필터만 추가해 완료로 처리하지 않는다.

## Task 4: 조명 카드 삭제 UI

**담당:** web_frontend. **소유:** `apps/web`.

**파일:** 신규 `src/api/fixture-registration-removals.ts`, `features/settings/site/DeleteFixtureRegistrationDialog.tsx`와 테스트; `SiteOperationsView.tsx`/직접 테스트, 관련 query invalidation; 격리 E2E/config.

**인터페이스:** Task 1 HTTP 타입과 Task 3 경로. 공통 ConfirmDialog/Modal, IconButton/Tooltip, Feedback/Toast/Loading을 재사용한다.

전송 전에 actor/site/floor/fixture와 requestId/expectedUpdatedAt을 저장한다. operationId 미확보 시 by-request 조회로 복구하고, 미확정/null을 성공·실패 확정으로 바꾸지 않는다. 명시적인 재시도는 같은 requestId/body만 재전송한다.

- [ ] RED: admin만 노출·취소 요청0·차단 이유·정확한 장치/시리얼·중복 클릭·pending/unknown≠성공·재조회 실패·새로고침 복구·현장 전환 stale 결과 무시를 작성하고 실패 확인.
- [ ] 카드의 등록 삭제 아이콘→preview→확인→같은 요청ID POST→terminal 조회를 연결한다. 진행 작업은 현장별 operation identity로 복구하고 완료만 삭제 성공/관련 query 갱신한다. 불확정은 동일 작업 상태 확인만 제공한다.
- [ ] 웹 관련 테스트/type/build/UI정책과 Chromium1440/390 정상·취소·차단·재시작 복구를 검증하고 커밋·독립 검토한다. fake 브라우저 결과를 장비 성공으로 기록하지 않는다.

## Task 5: 통합·검증·메인 병합

**담당:** 총괄 통합 + 독립 qa_reviewer. 구현자와 reviewer의 같은 diff 중복 작업은 하지 않는다.

- [ ] Task1–4의 소유 커밋과 검토 결과를 통합하고 shared/Prisma/engine을 격리 작업 환경에서 준비한다. MAIN node_modules/Prisma 생성물을 덮지 않는다.
- [ ] 실제 임시 PostgreSQL·소프트웨어 Gateway·브라우저 등록 삭제→조회/맵/제어 제외→재검색/새 등록과 과거 이력 보존의 연결을 검증한다. 실제 장비/운영 DB 검증은 미실행으로 기록한다.
- [ ] 관련 앱 전체 테스트/빌드·타입과 source 변경 diff를 확인한다. 기존 알려진 실패와 신규 실패를 분리하며 전체 GREEN으로 축약하지 않는다.
- [ ] 설정/모니터링/제어/통계 현황, DB 구조, 반복 교훈과 상태판을 같은 실제 결과로 갱신하고 최종 독립 whole-branch review를 통과한다.
- [ ] 메인 최신 변경을 보존해 병합하고 메인에서 한정 검증한다. 사용자 변경은 stage하지 않으며 로컬 DB migration/개발 서버 재시작/Pi 배포를 자동 실행하지 않는다. 제품 사용에 필요한 적용 관문을 최종 안내한다.

## 실행 상태

- 2026-10-16: 사용자 서면 설계 승인 및 계획 후 즉시 구현/별도 브랜치 병합 지시. 기존 브랜치를 최신 MAIN a6260156까지 문서 양쪽 보존 merge했다. Task1 시작 전이다.
- Task1 구현 `a960dbd8`: shared585/585·helper61/61, 임시PG/정책23/23·migration139→140, 타입/빌드 통과. 독립검토의 DB 잠금 역전1건은 fixround1 진행 중이며 Task1 전체 완료가 아니다. 고정된 shared 계약만 소비하는 Task2/4는 DB 수리와 독립이므로 구현을 시작하고 DB 기반을 사용하는 Task3는 수리 gate까지 대기한다. 커밋은 공유 index 보호를 위해 총괄이 직렬 승인한다.
- 병행 범위 보완: Task3도 고정 schema/helper를 소비하는 별도 API 파일 구현은 진행하되 Carver의 migration/policy 파일을 수정하지 않는다. Task1 전체 gate와 Task3 실제 PostgreSQL 최종 검증은 잠금 수리 재검토 뒤에 통과시킨다. 고정된 계약의 소비 작업과 DB 기반 승인 시점을 구분한다.
- Task1 완료: `a960dbd8`와 fix `549055d2`, reviewer James 독립 실제 PostgreSQL139→141/DB·정책30/30·Critical/Important0·ReadyYES다. 기존 raw-row 잠금과 새 전역 잠금의 순서 역전을 RED로 재현해 일반 UPDATE 범위를 좁혔고, 실제 Site cascade와 일반 직접 삭제 차단·과거 command/energy/settled lease의 DDL 보존을 확인했다. Site를 유지하는 resetInstallation의 새 원장 cleanup은 Task3 필수 인계다.
