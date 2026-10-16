# 실제 조명 등록 삭제 구현 계획

> 담당 에이전트: `superpowers:subagent-driven-development`로 작업별 구현·검토를 수행한다. 사용자는 2026-10-16 계획 작성 후 즉시 구현과 별도 브랜치 후 메인 병합을 승인했다. 추가 계획 승인 대기로 중단하지 않는다.

**목표:** admin이 BIO 조명의 서비스 등록을 안전하게 삭제하고 이력 보존과 동일 제품 재등록을 지원한다.

**구조:** durable 삭제 작업/결과 원장으로 서버와 Gateway의 정리를 연결한다. 완료 전 신규 작업을 차단하고, 완료 후 Fixture/MeshNode를 이력 전용으로 퇴역시킨다. 기존 공통 확인창과 현장 관리 조명 카드를 확장한다.

**기술:** 기존 TypeScript/Zod·NestJS/Prisma/PostgreSQL·MQTT·Node Gateway·React/React Query·React Aria·Vitest/Jest/Playwright. 신규 제품 의존성은 추가하지 않는다.

**설계:** `docs/superpowers/specs/2026-09-12-settings-assets-operations-design.md`의 `2026-10-15 추가 설계: 실제 조명 등록 삭제`.

## 공통 제약

- 작업 브랜치 `codex/fixture-registration-removal-20261015`, 정본 메인 `codex/mvp1-cloud-web`. MAIN의 사용자 AGENTS/상태판 및 병행 작업을 보존한다.
- Task1–5의 PostgreSQL 통합 검증은 소유한 임시 DB에서 수행한다. 사용자 추가 승인에 따라 코드 검증 후 현재 로컬 DB를 백업하고 본 기능의 migration을 적용한 뒤 개발 서버를 재시작한다. 이 단계에서는 실제 조명 삭제·Pi 배포/재시작·RF·PKI 변경을 하지 않는다. 후속 Task6은 별도 승인된 Gateway 업데이트와 규칙 복구만 추가하며 실제 삭제·PKI 변경은 계속 제외한다.
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
- 온라인 상태 수신도 Fixture.updatedAt을 바꾸므로 preview는 현재 `expectedUpdatedAt: ISO`를 함께 반환한다. 확인 클릭 시 fresh preview의 이름·시리얼/가능 여부를 재검사하고 같은 대상이면 그 timestamp를 전송 전에 고정한다. 이름/시리얼이 바뀌면 다시 확인하며 오래된 카드 timestamp를 그대로 제출하지 않는다. 전송 뒤 같은 요청 ID의 body는 변경하지 않는다.
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

- [x] RED: 정상 삭제/무관장치 보존·중복/재시작·ACK 유실·mapping 캡처 후 delete→write·오프라인 조명·진행/복귀/규칙 거절·과거 provision 재생·새 등록을 작성하고 실패 확인.
- [x] 삭제 중 장비별 admission 잠금과 실제 RF 직전 재검사, runtime/authority/poll/member 정리, terminal/application ACK와 heartbeat version1을 기존 production 실행 경로에 연결한다. 하드웨어 초기화/밝기 SET은 호출하지 않는다.
- [x] Gateway 관련 테스트/type/build 및 MQTT topic 인가 검증 후 커밋·독립 검토한다. 원장만 만들고 index에 미연결인 구현은 완료가 아니다.

## Task 3: 서버 삭제 흐름과 운영/이력 경계

**담당:** backend. **소유:** `apps/api`, `docs/database-schema.md`. Task 2와는 확정된 계약만 공유한다.

**파일:** 신규 삭제 controller/service/publisher/terminal·모듈/테스트; 기존 fixtures/site-settings/sites/floor-editor/map-display/registration/commands/automation/energy/MQTT의 실제 운영 조회·mutation·late-ingestion 경계.

**인터페이스:** 설계의 조명 경로 아래 GET preview, POST removals(202), GET removals/:operationId. Task 1 response 타입과 exact terminal/ACK를 사용한다.

POST 응답 유실 복구를 위해 `GET registration-removals/by-request/:clientRequestId`는 같은 actor/site/floor/fixture의 `FixtureRegistrationRemovalView|null`을 반환한다. POST의 같은 요청 ID 재생은 인가 뒤, expectedUpdatedAt·진행 차단 검사보다 먼저 조회한다. 이 예외는 동일 body 재생에만 적용하며 새 요청은 허용하지 않는다.

- [x] RED: assigned admin만 허용·다른 현장404·preview와 POST 재검사·offline/version0·스케줄/이벤트/구역/제어·맵 lease409·요청 ID 재생/충돌·Gateway 완료 후 DB 실패/재시작을 작성하고 실패 확인.
- [x] POST는 canonical 잠금/재인가 후 snapshot·outbox를 원자 생성한다. DB-only 보호와 기존 생산자의 pending/retired 거절을 연결한다. Publisher 네트워크 I/O는 DB transaction 밖이며 trusted time/assignment·인증 계약을 유지한다.
- [x] exact 결과·재조정과 최종 퇴역/UUID 해제/맵·내부 그룹/catalog 동기화를 연결한다. raw/Prisma 조회·모니터링 수·pagination·선택·상태수집·기존 맵 복구를 조사해 retired 제외와 이력 읽기를 분리한다. 기존 전력 집계는 보존하고 삭제 뒤 적산을 종료한다.
- [x] 임시 실제 PostgreSQL로 pending↔제어/등록 경쟁·late telemetry/ACK·실패 재시도·퇴역 후 동일 UUID 새 등록·구/신 통계/제어 이력을 검증한다. API 관련 테스트/type/build 후 커밋·독립 검토한다.

**Preflight 추가 인수 조건:**
- 확정 rejected terminal은 삭제 전에 변경된 catalog/내부 멤버십의 원 상태를 새 revision과 정확한 ACK로 복구한 뒤에만 rejected로 종결한다. 불확정 결과에는 이 경로를 쓰지 않는다. 복구 snapshot은 재시작 후에도 불변이며 전역 catalog를 영구 잠그지 않아야 한다.
- 기존 Site 유지 recommission은 실제 mqtt_revoked 작업의 정확한 scope와 정상 폐기 완료를 검증하는 좁은 DB 경계로만 새 원장을 정리한다. 일반 hard delete·가짜 GUC·다른 현장/작업의 삭제는 계속 거절한다.
- 퇴역 후 맵 clear/reset와 legacy/common CAD apply가 불변 row를 UPDATE하거나 snapshot에 다시 포함하지 않는지 확인한다. 통계 조회의 live projection은 retiredAt에서 끝내고 현재 baseline/forecast에서는 퇴역을 제외하되 과거 합계는 유지한다.
- Gateway의 `reconcile_required -> removed`는 같은 command에 새 event/hash의 확정 증거를 반환할 수 있다. 기존 result/ACK를 append-only 이력으로 보존한 뒤 이 진행만 허용하는 forward migration/API를 추가한다. 이미 확정된 결과 변경·이전 결과로의 상태 회귀는 막고 정확한 과거 재생은 보존 ACK로 처리한다. 임시 PostgreSQL에서 unknown 수신/ACK→TTL 뒤 새 removed→완료→옛 terminal/ACK 재생과 두 증거 보존을 검증한다.
- `energy/fixture-state-ingestion.service.ts`의 요금 변경 cursor 재적산도 닫는다. 최종 transaction에서 기존 `retireFixture()`를 연결하고 삭제→요금 변경→늦은 상태→동일 제품 재등록 뒤 구/신 집계가 분리되는지 검증한다.
- `floor-editor.service.ts`의 `existingFixtureIds`는 물리 존재가 아니라 운영 등록 자격으로 판정한다. legacy/document 복구·slot·save·snapshot에 같은 조건을 적용하고 두 복구 경로의 `skippedFixtureIds`·다른 도형 보존을 검증한다. `FixtureFreshnessService` raw UPDATE와 `MonitoringIncidentReconcilerService`의 운영 조회도 포함한다.
- `TargetSnapshotService`, BIO eligibility/binding과 `MeshControlGroupService` desired 조회는 잠금 뒤 pending/불확정/retired를 거절한다. `BioSensorProfilesService.catalogInTransaction()`은 동일 revision의 과거 payload를 재사용하므로 새 catalog revision 발행·정확 applied ACK를 확인해야 하며 퇴역 필터만 추가해 완료로 처리하지 않는다.

## Task 4: 조명 카드 삭제 UI

**담당:** web_frontend. **소유:** `apps/web`.

**파일:** 신규 `src/api/fixture-registration-removals.ts`, `features/settings/site/DeleteFixtureRegistrationDialog.tsx`와 테스트; `SiteOperationsView.tsx`/직접 테스트, 관련 query invalidation; 격리 E2E/config.

**인터페이스:** Task 1 HTTP 타입과 Task 3 경로. 공통 ConfirmDialog/Modal, IconButton/Tooltip, Feedback/Toast/Loading을 재사용한다.

전송 전에 actor/site/floor/fixture와 requestId/expectedUpdatedAt을 저장한다. operationId 미확보 시 by-request 조회로 복구하고, 미확정/null을 성공·실패 확정으로 바꾸지 않는다. 명시적인 재시도는 같은 requestId/body만 재전송한다.

- [x] RED: admin만 노출·취소 요청0·차단 이유·정확한 장치/시리얼·중복 클릭·pending/unknown≠성공·재조회 실패·새로고침 복구·현장 전환 stale 결과 무시를 작성하고 실패 확인.
- [x] 카드의 등록 삭제 아이콘→preview→확인→같은 요청ID POST→terminal 조회를 연결한다. 진행 작업은 현장별 operation identity로 복구하고 완료만 삭제 성공/관련 query 갱신한다. 불확정은 동일 작업 상태 확인만 제공한다.
- [x] 웹 관련 테스트/type/build/UI정책과 Chromium1440/390 정상·취소·차단·재시작 복구를 검증하고 커밋·독립 검토한다. fake 브라우저 결과를 장비 성공으로 기록하지 않는다.

## Task 5: 통합·검증·메인 병합

**담당:** 총괄 통합 + 독립 qa_reviewer. 구현자와 reviewer의 같은 diff 중복 작업은 하지 않는다.

- [x] Task1–4의 소유 커밋과 검토 결과를 통합하고 shared/Prisma/engine을 격리 작업 환경에서 준비한다. MAIN node_modules/Prisma 생성물을 덮지 않는다.
- [x] 실제 임시 PostgreSQL·Nest HTTP·소프트웨어 Gateway에서 삭제/복구→조회/맵/제어 제외→동일 제품 새 등록과 이력 보존을 검증한다. 웹 flow는 별도 격리 API fixture Chromium으로 검증한다. 이 경계별 결과를 실제 browser→broker→장비 전체 HIL 성공으로 표현하지 않는다.
- [x] 관련 앱 전체 테스트/빌드·타입과 source 변경 diff를 확인한다. 기존 알려진 실패와 신규 실패를 분리하며 전체 GREEN으로 축약하지 않는다.
- [x] 설정/모니터링/제어/통계 현황, DB 구조, 반복 교훈과 상태판을 같은 실제 결과로 갱신하고 최종 독립 whole-branch review를 통과한다.
- [x] 메인 최신 변경을 보존해 병합하고 메인에서 한정 검증한다. 사용자 변경은 stage하지 않는다. 추가 승인된 로컬 DB 백업·본 기능 migration·개발 서버 재시작을 수행하고 데이터/인증 설정 보존을 확인한다. 실제 장비 배포와 삭제는 제외하고 후속 적용 관문을 안내한다.

## Task 6: 사용자 수동 삭제를 위한 운영 준비

2026-10-16 추가 승인: 서버 시간 검증 복구·활성화와 실제 Gateway 업데이트를 진행한다. 실제 조명 등록 삭제는 사용자가 직접 수행한다.

- [x] 현재 MAIN·로컬 API/Web/broker·보호 ClockAttestor 설치와 기존 설정을 읽기 전용으로 확인했다. 시간 증거는 현재 `clock_unhealthy`이며 안전 관문을 유지한다.
- [x] 기존 로컬 환경/ACL과 Gateway의 인증·등록 매핑·영속 상태를 백업하고 실제 배포 대상·진행 작업·센서 소유권을 재확인한다.
- [x] 보호 clock의 정상 독립 표본/관리자 승인·같은 transaction의 DB primary 검증 후 API에 고정 소켓을 연결한다. 삭제용 MQTT 권한만 추가한다.
- [x] 안전한 drain/복구 조건을 충족한 뒤 최신 Gateway를 배포하고 실제 heartbeat의 삭제 지원 version1과 기존 identity 보존을 확인한다.
- [x] 브라우저 삭제 사전 조회/취소·원장/조명 수 보존을 확인하고 수동 시험 절차와 남은 차단 사유를 기록한다. 실제 삭제 POST는 실행하지 않는다.

운영 중간 기록: env/ACL 및 기존 TLS 파일을 private 백업한 뒤 고정 socket과 삭제 전용 ACL4행만 추가하고 broker reload를 확인했다. 실제 DB `::1/128` 대 보호 증거 `::1` 차이를 새 임시 PG RED1/6PASS로 재현하고 `host(inet_server_addr())`로 수리했다(`64eeb6d0`, MAIN ff-only). 초기 관련112PASS·IPv6 회귀·type/build0, 제어 outbox/등록 재검증/HTTP 삭제14PASS를 확인했다. 확장 런의 IPC 시간 제한1건은 단독78PASS 재검증으로 구분하며 전체 저장소 GREEN은 아니다.

06:51UTC에 실제 보호 reader+같은 운영 DB transaction 검증을 통과했다. 현재 API/Web/broker는 read-only supervisor20588/readiness5up이며 새 HTTP 쓰기를 차단한다. 서버 접수/등록/제어/소유권10종 count0을 확인했다. 규칙은 에이전트 비활성화 요청 없이 안전 정책에 의해51활성→52비활성/APPLIED로 전환됐으며 기존 설정값을 보존했다. 사용자에게 별도 임시 비활성화·배포·동일 규칙 재활성화 승인을 받았다. 실제 Pi 교체는 새 native 복귀 증거/백업 관문 뒤에만 진행한다.

후속 운영 기록: 실제54비활성/APPLIED·native0과 새 진행 작업0으로 갱신한 뒤3root/53member CMS 백업67,404,574bytes를 off-device 전체 검증했다(SHA256 `df9957718af785cf1e044f5e37a1c98748c07bdc3399f050853a27ed86e26f74`). 원 컨테이너를 TERM/natural exit0·USB0으로 정지한 후 새 `83cc7135…`/image`f9aa4ce5…`를06:59:35UTC 기동했다. 원24개 보호 항목+provision journal25개·인증/env/mount/security/USB를 보존하고 실제 heartbeat version1·healthy/USB1을 확인했다. 삭제 원장0이며 retirement manifest는 실제 삭제 전이므로 없다.

07:00UTC 점검 모드를 해제한 compiled runtime27573/readiness5up에서 정상 UI를 통해 기존 규칙을 재활성화했다. 서버 desired=applied55/hash`05d6511e…`/errornull과 실제 native applied/intentnull·original=desired=applied를07:06:43UTC에 확인했다. 감지100%·유지5초·대기10%/5초·phase0·sensor/self와 다른 대상0·등록25개 보호값을 유지했다. API와 Gateway의 source SHA는 각각64eeb6d0/24d2d8e4이며 API만 달라 검증된 Gateway 이미지를 불필요하게 재빌드하지 않았다.

남은 관문: 시간 증거가 정상 관측 뒤에도 간헐적으로 unavailable/새 step latch로 바뀌어 브라우저 확인창이503으로 차단됐다. 실제 기존 clock 프로세스의 background scheduling을 해제했으나 보안 기준·설치 프로그램/plist·세대 상태 초기화는 하지 않았다. 추가 Mac 인증 명령은10분 넘게 응답 대기여서 소유 osascript32814를 신원 확인 후 SIGTERM/exit143으로 취소했다. launchd runs1/기존63547로 정상 재시작 미실행을 확인했으며 대기 중 특권 명령은 없다. 사람의 실제 OS 인증 완료 뒤 기존 서비스 정상 재시작→보호된3개 독립 표본→현재 observation 승인→동일 DB transaction 검증→브라우저 사전 확인/취소를 이어야 한다. 안정화 전 수동 삭제 시험 준비 완료로 기록하지 않는다. Gateway/인증/매핑/조명 수·삭제 원장은 보존한다.

당시 사전 조회: 실제 admin의 방습등1 확인창에서 한국어 시간 검증 미준비 안내와 삭제 disabled를 다시 확인하고 취소했다. 현장6개 등록은 유지하며 실제 삭제 POST는0이다. 증거 이미지는 root `.local/fixture-removal-20261016-ops/final-clock-blocked-preview.jpg`다. Mac 인증 창과 실제 명령 실행 완료는 별개이므로 재개 시 먼저 보호된 operator의 `status`와 launchd의 현재 PID/실행 횟수를 확인한다. 새 인증 창을 누적 생성하거나 지연 실행할 명령을 남기지 않는다.

최종 후속(16:43~16:44KST): 사용자 터미널에서 기존 서비스 정상 종료/재시작을 실행해 runs2·새51344·이전exit0을 확인했다. 새 인증 명령도 실제 실행됐다. 동일 서비스 계정의 primary 검사3회는 정상이고7~8ms였으며 SNTP는 간헐 실패했다.5초 간격 진단3회는213~232ms/return0·children0·stoppedfalse였다. 공용 서버 제한이나 수집기 영구 고장을 원인으로 확정하지 않는다. 기존 daemon의5초 간격 독립 probe1→2→3·세대167/9/같은primary·마지막 observation의 승인에 성공했다. 실제 보호 reader+같은 운영 DB transaction은16:43:35KST 통과했다.

실제 admin의 방습등1 삭제 preview가 정상 반환되어 최종 등록 삭제 버튼 활성화를 확인했다. `.local/fixture-removal-20261016-ops/final-clock-approved-preview.jpg`를 저장하고 취소했다. POST·퇴역·삭제 작업·결과/복구 원장0, 현장6개/전체8개 조명과 Gateway version1을 유지한다. 시간 안전 기준·설치 프로그램/plist·상태 세대의 강제 변경은0이다. runtime scheduling 해제는 현재 프로세스 한정이며 재시작 후 영구 적용으로 보장하지 않는다. 처리 중이던 특권 명령은 모두 종료됐다.

규칙 후속: 최초 복구55활성/APPLIED 뒤16:27KST 정상 PATCH가 있었고 현재56비활성/APPLIED·errornull이다. 자동 비활성화로 추정하지 않고 현재 상태를 보존했다. 이전 복구 승인을 현재 사용자의 변경을 덮어쓰는 권한으로 해석하지 않는다.

수동 시험: 설정→현장 관리→조명 관리에서 방습등1 또는2의 등록 삭제를 열고 이름/시리얼을 확인한 뒤 사용자가 최종 승인한다. 다른4개는 규칙/구역/진행 작업 또는 지원 분류 등 기존 사전 차단 사유가 있으므로 강제 삭제하지 않는다. 시간 서버 응답이 실패하면503 안내 후 수동 재확인하며 Mac sleep/새 step·primary 세대는 새 승인부터 수행한다. 실제 장비 삭제·구세대 RF 차단·재등록 HIL은 아직이다.

## 실행 상태

- 2026-10-16: 사용자 서면 설계 승인 및 계획 후 즉시 구현/별도 브랜치 병합 지시. 기존 브랜치를 최신 MAIN a6260156까지 문서 양쪽 보존 merge했다. Task1 시작 전이다.
- Task1 구현 `a960dbd8`: shared585/585·helper61/61, 임시PG/정책23/23·migration139→140, 타입/빌드 통과. 독립검토의 DB 잠금 역전1건은 fixround1 진행 중이며 Task1 전체 완료가 아니다. 고정된 shared 계약만 소비하는 Task2/4는 DB 수리와 독립이므로 구현을 시작하고 DB 기반을 사용하는 Task3는 수리 gate까지 대기한다. 커밋은 공유 index 보호를 위해 총괄이 직렬 승인한다.
- 병행 범위 보완: Task3도 고정 schema/helper를 소비하는 별도 API 파일 구현은 진행하되 Carver의 migration/policy 파일을 수정하지 않는다. Task1 전체 gate와 Task3 실제 PostgreSQL 최종 검증은 잠금 수리 재검토 뒤에 통과시킨다. 고정된 계약의 소비 작업과 DB 기반 승인 시점을 구분한다.
- Task1 완료: `a960dbd8`와 fix `549055d2`, reviewer James 독립 실제 PostgreSQL139→141/DB·정책30/30·Critical/Important0·ReadyYES다. 기존 raw-row 잠금과 새 전역 잠금의 순서 역전을 RED로 재현해 일반 UPDATE 범위를 좁혔고, 실제 Site cascade와 일반 직접 삭제 차단·과거 command/energy/settled lease의 DDL 보존을 확인했다. Site를 유지하는 resetInstallation의 새 원장 cleanup은 Task3 필수 인계다.
- Task2 완료: `1cd8cac2`와 `2cb424c7`. 최초 focused379/379, 시계 불신 중 durable intent 보존/TTL 후 동일 작업 복구와 실제 production factory 연결을 보강한 focused273/273, type/build 통과다. 독립 재검토50/50·C/I/M0·ReadyYES다. 기존 Gateway3개 suite14FAIL은 a6260156 비교에서도 동일하며 본 기능 성공 근거와 분리한다. MAIN의 신규 native sensor 통합 후 추가 회귀 검증은 Task5다.
- Task4 완료: `9946de16`. 공식 focused64/64·Chromium10/10(1440/390)·type/build/UI policy 통과, 독립64/64·C/I/M0·ReadyYES다. 동일 현장 default dashboard 캐시 갱신과 fresh preview 재확인을 포함한다. route fixture 브라우저 결과이지 실제 API/장비 삭제 결과는 아니다.
- Task3 중간 커밋 `a69abd18`/`9381b402`/`38af5b5b`: shared 실제ESM/CJS22, 임시PG/실제Nest HTTP·software Gateway11, foundation30·직접489PASS/1SKIP다. 독립 검토 I4건(확정거절 복구·recommission·맵 초기화/CAD·통계 projection)을 발견해 각 소유자가 보완 중이며 Task3 완료나 전체 승인이 아니다. 최신 MAIN `e4794fdf`를 `7c4b49af`로 보존 merge했다.
- Task5 중간 Gateway 전체: 통합 `7c4b49af` 기준113파일/2,112개 중2,098PASS·14FAIL, type/build0. 3개 suite14FAIL은 a6260156 baseline의 이름/오류와 일치하며 신규 실패는0이다. 별도 legacy ACL wildcard 기대1FAIL은 이전과 같고 새 removal ACL1PASS다. root 관련 runtime/ACL74PASS·5SKIP·0FAIL이며 실제 broker 정책 변경/HIL 결과는 아니다.
- Task3 최종: `db4aa219` recommission(PG146/40PASS), `d35e6180` 맵/통계(PG146포함72PASS), `5c0e5ce4` 확정 거절 복구(PG43PASS·직접169PASS/1SKIP), `84ae1936` clear/CAD/staged 잠금 순서(60PASS·양방향8PASS)를 확정했다. I1–I5 독립 재검토49+12PASS·C/I/M0·ReadyYES다. `d7f87124`는 미래 의존 migration을 먼저 실행하던 staged 시험과 command harness를 정합화했다. 새 schema는146 migrations/삭제 작업·결과 증거·설정 복구 원장3개다.
- 최종 API 전체 검증은 제품 소스 `84ae1936` 고정 후 별도 코호트에서 진행한다. source 수정 중 시작한 전체 실행은 최종 freeze 증거로 사용하지 않는다. 추가 코드 변경은 없으며 문서와 승인된 로컬 적용만 남았다.
- 최종 API 고정 전체 런은 자연 완주479.508초/3,668PASS·14FAIL·1,259SKIP(375파일)이다. 실패14 중7은 기존 공휴일 fixture 관련으로 MAIN 독립 재현했고, 나머지7은 `d049b368`의 테스트 builder `retiredAt:null` 한 줄 보완 후 EnergyService/Analytics36/36으로 해소했다. 제품/단언/expected 변경은0이다. 이후 전체를 재실행하지 않았으므로 전체 GREEN이나 재계산한 전체 통과 수를 주장하지 않는다. API 타입/빌드와 diff 검증은 통과했다.
- 최종 계약 통합 독립 검토: MAIN `e4794fdf`→제품 `84ae1936`, Spec/quality PASS·C/I/M0·ReadyYES다. 기존 Gateway14·Web5·API 공휴일7과 legacy ACL 기대1 실패는 새 기능과 분리해 남긴다. 무관한 기존 실패 수리로 범위를 확장하지 않고 신규 기능 직접 검증/실제 PG/계약 승인과 baseline 비교를 근거로 사용자 요청의 로컬 병합을 진행한다.
- 실제 로컬 적용 완료: 기존 프로세스 신원을 확인해 정상 종료하고 MAIN에 ff 병합했다. 사용자 AGENTS84줄·상태판13줄은 stage하지 않고 보존했다. `.local/fixture-removal-20261016-ops/backup-2026-10-16T03-10-41Z-02485604439d`의0600 custom archive8,336,869bytes/list/전체 읽기와 동일 snapshot을 검증했다. 실제 DB141→146·실패0, 기존127개 테이블의 원래 열 hash/행 수·기존 migration 메타데이터·환경/인증/ACL을 보존했다. 역사적20260918 checksum 차이는 검토된 정확한 쌍을 유지했으며 resolve/재실행하지 않았다.
- 실제 브라우저 후속: 시간 증거 미설정의 일반Error가 preview500을 만들던 문제를 `008f2ca5`의 새접수/preview503 정규화로 보완했다(HTTP/실PG/DI/unit21·clock97PASS/type/build0). `5677908d`는 정확한503+code에만 한국어 안내를 제공한다(웹69PASS/Chromium12PASS/type/build/policy0). 독립7PASS·C/I/M0·ReadyYES, 실제 admin 사전GET503 안내/삭제disabled/취소 뒤6개 버튼 유지를 확인했다. 실제 POST/퇴역/새 삭제 원장0이다.
- 실행 관문: 기존 Nest watch가 재빌드 중4GB heap 한도로 종료돼 최신 root API/Web을 다시 빌드하고 API는 compiled entry, Web은 기존0.0.0.0:5173 Vite로 기동했다. 최종 API4000/Web5173/MQTT8883 및 readiness5개 up·보호파일 불변을 확인했다. API source 수정 시 별도 재빌드/재기동이 필요하며 전역 pnpm dev/watch 설정은 바꾸지 않았다. 증거는 root `.local/fixture-removal-20261016-ops`에 남겼다. 실제 Pi 배포/clock 활성화/ACL 변경/장비 삭제·재등록 HIL은 실행하지 않았다.
