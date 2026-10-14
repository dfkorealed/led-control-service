# BIO 전용 시간제 제어·스케줄 달력 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BIO 조명의 지정 밝기 시간제 유지·검증된 최신 자동 운전 복귀와 일정별 주말/한국 공휴일 제외·완전 달력 조회를 실제 API/DB/Gateway/UI로 연결한다.

**Architecture:** 독립 TemporaryControlSession과 영속 fixture lease로 BIO configuration apply/release를 직렬화한다. 버전 있는 완전 공휴일 dataset과 공통 발생일 평가기를 서버·Gateway가 소비하고 기존 제어 UI가 그 결과를 표시한다. 같은 lease/V3/qualification/occurrence 계약을 단계마다 소비하므로 독립 계획을 여러 개 만드는 대신 한 통합 계획이 타당하다.

**Tech Stack:** 기존 Node 22, pnpm 9.15.0, TypeScript, NestJS/Prisma/PostgreSQL, MQTT, Temporal 0.5.1, React/React Query, Jest/Vitest/Playwright. 신규 패키지 설치 없음.

**Spec:** [승인 설계](../specs/2026-10-14-bio-control-operations-design.md), 승인 커밋 91bf922e. UI 정본은 /Users/kim-jh/Documents/led 조명 관제 서비스/preview/lighting-operations-real-ui/README.md 및 승인 설계 §3의 추가 위치 통일.

**현재 상태:** Tasks1–6 공유 계약·DB·공휴일·API·발생일/달력·Gateway 영속 잠금/apply는 구현/리뷰 완료(`111ef160`/`0d201dbd`/`817fe030`/`19c87c6f`/`fd492953`/`e585b657`). Task7 최신 자동 복귀/V3/MQTT 연결을 시작하며 Tasks8–9는 대기다. 전체 기능 완료·운영 반영은 아직 아니다.

**작업 공간/방법:** /Users/kim-jh/Documents/led-control-service/.worktrees/bio-control-operations-20261014, codex/bio-control-operations-20261014. 총괄 오케스트레이터→backend 공유 계약/Prisma→engine/Gateway→기존 UI 담당 순차 협업을 보존한다.

## 실행 상태

| 작업 | 상태 |
| --- | --- |
| Task1 공유 계약·V3·MQTT/ACL | 완료, 재리뷰 지적0 |
| Task2 DB 저장·V3 SQL | 완료, 차단 지적0·Minor1 최종 리뷰 추적 |
| Task3 공식 공휴일 완전 데이터 | 완료, 차단 지적0·테스트 Minor2 최종 리뷰 추적 |
| Task4 HTTP/MQTT/V3 연결 | 완료, fix round1 재리뷰 지적0 |
| Task5 발생일 평가기·달력 API | 완료, 차단 지적0·문서 Minor1 최종 리뷰 추적 |
| Task6 Gateway 영속 잠금/apply | 완료, fix round1 재리뷰 지적0 |
| Task7 Gateway 최신 복귀/V3 | 구현 중 |
| Tasks8–9 지정 Web 연결·최소 QA·로컬 머지 | 대기 |

## Global Constraints

- 신규 기능은 BIO 센서 조명만 지원한다. 기존 native/다른 장치 코드·데이터·등록·정책을 삭제/변환하거나 새 generic/ESP32 분기를 만들지 않는다.
- 대상은 당시 resolve한 단일 Gateway의 unique 1~1000대, 밝기 정수 0~100%, 기간 정수 1~1440분, preset 15/30/60/120분이다. active BIO source 자체는 금지한다.
- startedAt은 서버 시작 transaction의 UTC instant, endsAt=startedAt+durationMinutes×60,000ms다. 재전송·중복·재접속·재시작으로 연장하지 않는다.
- 신규 start/apply delivery는 기존 CommandDbClockHealth.assertHealthy(tx)의 신뢰된 DB UTC sample과 currentassignment의 현재 적용확인된 V3(snapshot desired/applied revision·exact hash/ACK)를 요구한다. attestor 부재는 새시작503/전달보류, 미적용 config는409다. 기존 요청 replay·조회·accepted end intent와 durable 만료/복구를 새 admission 관문으로 폐기하지 않는다. fixture bigint generation을 중앙 Set epoch로 사용하지 않는다.
- 활성/unresolved fixture lease는 하나다. 새 임시·영구·자동 SET은 충돌 시 거절/보류한다. 자동 증거·건강·정책은 계속 갱신한다.
- 임시 제어는 baseline 승격·retireManualTargets·영구 suppression·영구 preState 삭제를 호출하지 않는다.
- applyConfirmed와 configurationMayHaveChanged/partialMutation은 별개다. RF0/unchanged를 증명한 대상만 복귀 불필요; unknown은 lease를 유지한다.
- 종료는 최신 승인 revision/현재 유효 자동 우선순위로 재평가한다. 정상 mode는 sensor/force-on/force-off이며 sensor readback은 광출력 증거가 아니다.
- release intent/tombstone을 먼저 영속화하고 RF 직전 신원·배정·generation·건강·신선도를 재검사한다. stale release/ACK가 새 lease를 해제하지 못한다.
- 최초/매일 공휴일 갱신은 당해+다음해 전체연도 대상이며 실제 지원은 검증된 coverage뿐이다. 모든 월/페이지/totalCount 검증 후 원자 승격; 정상 빈 월도 검증한다.
- 공휴일 payloadHash는 정렬·unique normalized {country,source,year,coverageFrom,coverageUntil,dates}의 기존 canonical hash이며 fetchedAt/revision을 제외한다. 현재 coverage와 동일한 hash만 unchanged다. changed완전 승격 hook은 같은 mutation transaction을 소비하고 실패 시 dataset/pointer/snapshot을 함께 rollback한다.
- 한국 휴일 제외는 Asia/Seoul만, 주말 제외는 현장 TZ다. 없는 coverage를 평일로 간주하지 않는다. 실패 시 이전 완전 revision 유지; 알 수 없는 신규 발생은 차단하되 기존 end/release는 계속한다.
- 두 제외 boolean은 NOT NULL DEFAULT false다. once/Mon1…Sun7/31일/윤일/야간 시작일/Temporal DST/현장 날짜 양끝 포함 계약을 보존한다.
- 임시 목록 기본20/최대100; 달력 현장 날짜 양끝 포함 최대42일, 전체 일정 projection이다. 목록의 첫25/100건 또는 검색 페이지를 달력 전체로 사용하지 않는다.
- SessionAuthGuard·site read/control/manage transaction 검사를 유지한다. 비로그인401, 미노출 site/id404, 읽기전용 쓰기403, 형식400, 충돌/미지원/coverage409, 서비스 불가503, start/end202; 조회 private,no-store.
- idempotency는 site+actor+operation+clientRequestId unique다. unresolved/최소 fingerprint/마지막 generation/tombstone은 TTL 삭제 금지; terminal 상세는 기존 UTC3개월 ON/OFF 정책을 재사용한다.
- 알려진 V2/V3와 필수 capability만 허용한다. >=2 허용·true flag 제거·영구 제어 fallback·outer ACK/PUBACK를 장비 성공으로 표시하는 우회는 금지한다.
- PC 실행 패널350px, 모바일320×600/390×844의 기존4열 실행행·동일 map/canvas identity·가로/전체 overflow 없음, 달력 띠44px, Dialog visible Switch label focus·Escape/opener 복귀를 검증한다.
- common component는 기존 components/ui 또는 automation/components에 둔다. 업무모드/휴무·특별근무/global opt-in/배지/중복추가/제거된 설명문을 다시 넣지 않는다. 버튼 제거는 unknown/복구 안전 경로 삭제가 아니다.
- 현재는 승인 계획의 software 구현 단계다. 한정 software 검증/로컬 merge와 운영 DB migration·서버/Pi 재시작·HIL·PKI/ACL reload·ServiceKey/provider 실제 연결·remote는 별도 승인이다.
- 후속 leaf 명령 전 pnpm workspace:prepare를 한 번 수행하고 공유 산출물 변경 때 갱신한다. Gateway test는 기존 single-worker script. 전체 suite·무관 build/audit/HIL 반복 금지; 변경 package 타입과 필요한 최종 build만 한다.
- 각 구현 commit에 docs/menus/control.md를 실제 상태로 갱신하고 DB 변경은 docs/database-schema.md도 갱신한다. 모니터링/설정에 실제 영향이 생기면 docs/menus/monitoring.md/settings.md도 같은 작업에서 갱신한다. 총괄이 plan 체크리스트/상태판을 같은 결과로 기록한다.

## Review Focus

1. high-brightness 쓰기 뒤 mode 실패/저장 실패: 최종 실패도 설정 변경 가능성을 보존하고 정확한 GET·복귀 없이는 lease를 해제하지 않는다 → Tasks 6·7의 partial_high_write와 restart_pending_apply.
2. 복귀 GET/fsync 사이 정책·source health가 바뀜: RF 직전 재계산/재검증하며 과거 force 값·오래된 pulse를 재생하지 않는다 → Task 7의 release_revision_race와 degraded_release.
3. fixture 삭제→같은 주소 재등록/상세 retention→client 재시도: unresolved 삭제는 RESTRICT하고 다른 UUID/fixtureId에 옛 lease/ACK를 적용하지 않는다. 같은 fixture의 최소 fingerprint/generation을 유지한다 → Tasks 2·4의 recreated_fixture와 redacted_replay.
4. 빈 공휴일 월/중복 페이지/뒤늦은 임시공휴일: 완전성 없는 revision을 승격하지 않고 cache 실패·offline 결과를 같게 유지한다 → Tasks 3·5의 empty_month_complete와 late_holiday_revision.
5. 100건 넘는 일정/달력 응답 중 권한·revision 전환: 일부 결과를 빈/완전 달력으로 표시하지 않고 이전 scope mutation과 draft를 폐기한다 → Tasks 5·8·9의 complete_calendar와 revoked_scope.

## 파일 구조·계약 초안과 실행 관문

아래 Create는 신규 제안, Modify/Test(existing)는 직접 확인한 기존 파일이다. 괄호의 같은 경로 아래 파일들은 각각 명시 파일이다. 공유 wire/type 초안은 총괄과 backend/Gateway가 사용자 계획 검토 뒤 Task1 착수 전 승인한다; 안전 의미 변경이면 재설계한다.
test 예시의 h는 각 해당 test 파일에 만드는 로컬 fixture helper이며 메모리 fake/임시 파일/자기 소유 disposable PG만 사용한다. 외부 .env/DB/장비/ServiceKey를 읽지 않는다.

- 공유 임시 계약: CreateTemporaryControlInput={clientRequestId,target,brightness,durationMinutes}; EndTemporaryControlInput={clientRequestId}; TemporaryControlState는 spec §5의10상태이며 아래 literal union을 사용한다.
- Generation은 양수 canonical decimal string이고 DB/Gateway 내부 bigint; 안전 정수 admissionRevision/sequence와 구분한다. WireIdentity의 정확한 필드는 아래 TS 선언이 정본이다.
- TemporaryControlCommand는 strict kind=start|end. start는 apply/release generation쌍을 포함한 fixture snapshot·brightness/startedAt/endsAt를 가진다. end는 같은 immutable snapshot·원 start hash/sequence를 사용한다. delivery envelope 필드는 기존 GatewayCommandDeliveryGeneration의 deliveryGeneration/deliveryGeneratedAt/deliveryWindowMs/expiresAt를 재사용하고 envelope hash를 별도 계산한다.
- 시작 transaction에서 fixture counter+1의 apply와 counter+2의 release를 한 쌍으로 예약하고 counter를+2로 저장한다. release는 자동 만료/수동 end가 공유한다. sessionRevision은 start1/release2이며 오프라인 만료 결과도2다. 중복 end는 예약값을 재사용하고 새 같은 fixture 세션은 다음 쌍을 예약한다.
- TemporaryControlResult는 kind=apply|release|observation이며 아래 SessionAdmissionIdentity와 fixture generation/eventId/resultHash/observedAt·별도 restorationRevision을 검사한다. applyConfirmed/configurationMayHaveChanged/partialMutation/configurationReadback/rfWriteEvidence/reason를 개별 결과로 검증한다.
- TemporaryControlView는 서버now/state/startedAt/endsAt/immutable targets/target별 apply·release evidence/recovery reason을 포함한다. 이력 항목은 kind=temporary_control이며 기존 Command로 cast하지 않는다.
- HolidayDatasetSnapshot={country:KR,source:kasi,year,revision,fetchedAt,coverageFrom,coverageUntil,payloadHash,dates:[{date,names}]}; 완전12개월 proof는 서버에 보관하고 wire도 coverage/year/hash를 검증한다.
- LightingScheduleSnapshotV3는 V1 필드+excludeWeekends/excludeHolidays, AutomationSnapshotV3는 기존 V2 sensorProtocol을 보존하고 V3 schedules/holidayDatasets를 포함한다.
- AutomationCurrentConfigRequestV3는 V2 귀속+maxSnapshotVersion:3+temporaryControlVersion:1+bioConfigurationReadback:true+durableFixtureLease:true. helper supportsBioAutomation(v)는 알려진2/3만, supportsTemporaryBioControl(v)는3+세 필수 증거만 허용한다.
- ScheduleCalendarResponse={from,to,timeZone,complete:true,revisionKey,holidayCoverage,schedules,occurrences:[{scheduleId,key,localDate,startsAt,endsAt}]}; revisionKey는 현장+모든 Gateway 승인 revision/hash+dataset revision의 canonical hash다. 이번 구현은 최대42일의 완전 단일 응답으로 pagination을 새로 만들지 않는다.
- 신규 토픽: sites/{siteId}/gateways/{gatewayId}/temporary-control/command, /result, /ingested. API write/read/write, 해당 Gateway read/write/read만; 타Gateway·타site·익명 거절. 기존 wire와 multiplex하지 않는다. 기존 commands/#·events 권한을 새 경로에 상속하지 않으며 render/publish ACL options의 temporaryControlScopes:Array<{siteId:string;gatewayId:string}>로 명시한 현재 귀속만 부여한다. 기본[]는 신규 권한 없음이다. 실제 귀속 설정/ACL 반영은 운영 승인 단계다.

### Task1에서 고정할 named type 핵심 형태

아래는 필드/별칭 합의이며 schema 구현 본문은 아니다. string UUID/ISO/date/hash/Generation과 integer 범위는 Task1 strict parser로 검증한다. 기존 타입 이름은 shared/src/automation-contracts.ts에서 확장한다.
~~~ts
type Generation = string; // /^[1-9][0-9]*$/, JSON은 decimal string, 내부 bigint
type TemporaryControlState = "pending"|"applying"|"holding"|"partial"|"unknown"|"releasing"|"restored"|"recovery_pending"|"rejected"|"cancelled";
type CreateTemporaryControlInput = {clientRequestId:string;target:DimmingTarget;brightness:number;durationMinutes:number};
type EndTemporaryControlInput = {clientRequestId:string};
type TemporaryFixtureSnapshot = {fixtureId:string;meshNodeId:string;nativeUuid:string;logicalAddress:string;applyGeneration:Generation;releaseGeneration:Generation};
// 기존 BIO wire 신원: nativeUuid /^[0-9a-f]{12}$/ (6 bytes), logicalAddress /^0x[0-7][0-9a-f]{3}$/ 및 0x0000 금지.
// fixtureId/meshNodeId는 앱 UUID이며 BIO 6-byte nativeUuid와 혼용하지 않는다.
type WireIdentity = {schemaVersion:1;sessionId:string;sessionRevision:1|2;siteId:string;gatewayId:string;assignmentVersion:number;admissionRevision:number;sequence:number;payloadHash:string};
type SessionAdmissionIdentity = {sessionId:string;siteId:string;gatewayId:string;assignmentVersion:number;admissionRevision:number;originCommandHash:string;originSequence:number};
type StartTemporaryControlCommand = WireIdentity & {kind:"start";sessionRevision:1;targets:TemporaryFixtureSnapshot[];brightness:number;startedAt:string;endsAt:string};
type EndTemporaryControlCommand = WireIdentity & {kind:"end";sessionRevision:2;targets:TemporaryFixtureSnapshot[];originCommandHash:string;originSequence:number;endsAt:string};
type TemporaryControlCommand = StartTemporaryControlCommand|EndTemporaryControlCommand;
type BioConfigurationReadback = {configuredHighBrightnessPercent:number;bioMode:"sensor"|"force-on"|"force-off"};
type TemporaryTargetEvidence = {fixtureId:string;applyConfirmed:boolean;releaseConfirmed:boolean;configurationMayHaveChanged:boolean;partialMutation:"none"|"high_brightness"|"mode"|"unverified";configurationReadback:BioConfigurationReadback|null;rfWriteEvidence:"not_started"|"may_have_written"|"observed";reason:string|null};
type TemporaryControlResult = SessionAdmissionIdentity & TemporaryTargetEvidence & {schemaVersion:1;eventId:string;sessionRevision:1|2;kind:"apply"|"release"|"observation";targetGeneration:Generation;restorationRevision:number|null;restorationPayloadHash:string|null;observedAt:string;resultHash:string};
type TemporaryControlIngestedReceipt = SessionAdmissionIdentity & {schemaVersion:1;eventId:string;sessionRevision:1|2;targetGeneration:Generation;resultHash:string;status:"applied"|"rejected";reason:string|null;ingestedAt:string};
type TemporaryControlView = {id:string;siteId:string;gatewayId:string;state:TemporaryControlState;sessionRevision:1|2;now:string;startedAt:string;endsAt:string;brightness:number|null;targets:TemporaryFixtureSnapshot[];results:TemporaryControlResult[];reason:string|null;detailsRedacted:boolean};
type TemporaryControlListQuery = {state?:TemporaryControlState;cursor?:string;limit?:number};
type TemporaryControlListResponse = {items:TemporaryControlView[];nextCursor:string|null};
type ScheduleCalendarOccurrence = {scheduleId:string;key:string;localDate:string;startsAt:string;endsAt:string};
type LightingScheduleSnapshotV3 = LightingScheduleSnapshotV1 & {excludeWeekends:boolean;excludeHolidays:boolean};
type LightingScheduleSnapshot = LightingScheduleSnapshotV1|LightingScheduleSnapshotV3;
type HolidayDatasetSnapshot = {country:"KR";source:"kasi";year:number;revision:string;fetchedAt:string;coverageFrom:string;coverageUntil:string;payloadHash:string;dates:Array<{date:string;names:string[]}>};
type ScheduleCalendarResponse = {from:string;to:string;timeZone:string;complete:true;revisionKey:string;holidayCoverage:HolidayDatasetSnapshot[];schedules:LightingScheduleSnapshot[];occurrences:ScheduleCalendarOccurrence[]};
type AutomationSnapshotV3 = Omit<AutomationSnapshotV2,"schemaVersion"|"schedules"> & {schemaVersion:3;schedules:LightingScheduleSnapshotV3[];holidayDatasets:HolidayDatasetSnapshot[]};
type AutomationSnapshot = AutomationSnapshotV1|AutomationSnapshotV2|AutomationSnapshotV3;
type AutomationCurrentConfigRequestV3 = Omit<AutomationCurrentConfigRequestV2,"schemaVersion"|"maxSnapshotVersion"> & {schemaVersion:3;maxSnapshotVersion:3;temporaryControlVersion:1;bioConfigurationReadback:true;durableFixtureLease:true};
type AutomationCurrentConfigRequest = AutomationCurrentConfigRequestV1|AutomationCurrentConfigRequestV2|AutomationCurrentConfigRequestV3;
type AutomationConfigAppliedV3 = Omit<AutomationConfigAppliedV2,"schemaVersion"> & {schemaVersion:3};
type AutomationConfigApplied = AutomationConfigAppliedV1|AutomationConfigAppliedV2|AutomationConfigAppliedV3;
type AutomationConfigAppliedDeliveryV3 = Omit<AutomationConfigAppliedDeliveryV2,"schemaVersion"|"acknowledgement"> & {schemaVersion:3;acknowledgement:AutomationConfigAppliedV3};
type AutomationConfigAppliedDelivery = AutomationConfigAppliedDeliveryV1|AutomationConfigAppliedDeliveryV2|AutomationConfigAppliedDeliveryV3;
type AutomationConfigAppliedReceiptV3 = AutomationConfigAppliedDeliveryV3 & {ingestedAt:string};
type AutomationConfigAppliedReceipt = AutomationConfigAppliedReceiptV1|AutomationConfigAppliedReceiptV2|AutomationConfigAppliedReceiptV3;
~~~
V3 선언의 literal capability는 위 초안대로 고정하고 automationConfigAppliedV3Schema/DeliveryV3Schema/ReceiptV3Schema는 exact scope/version/revision/payloadHash/acknowledgementId를 검사한다. V3 receipt가 V2 ACK를 감싸거나 이전 revision/hash로 현재 적용을 승격하지 못한다.
원 명령 귀속은 originCommandHash/originSequence/admissionRevision으로 저장한다. release 결과의 restorationRevision은 최신 자동 목표 revision이며 원 start hash/승인 귀속을 변경하지 않는다. 자동 만료 결과는 예약 releaseGeneration+sessionRevision2로 접수돼 HTTP end가 없더라도 releasing/terminal 정본에 합쳐진다.
aggregate holding은 전체 target applyConfirmed일 때만, restored는 전체 target이 RF0/unchanged를 증명했거나 최신 자동 설정 복귀 readback을 확인했을 때만이다. unknown/configurationMayHaveChanged가 미해결이면 restored가 아니며 lease를 보류한다. rejected/cancelled도 RF0 증거가 필요하다. capability·clock·configuration GET은 광출력/차량 존재 증거로 변환하지 않는다.
releaseConfirmed는 release의 high brightness와 mode 독립 GET이 최신 자동 목표와 모두 일치하고 현재 lease/generation/restorationRevision/restorationPayloadHash가 여전히 유효할 때만 true다. applyConfirmed로 복귀 완료를 추정하지 않는다. kind별 targetGeneration은 예약 apply/release 값과 일치하고 immutable DB 대상 snapshot의 fixtureId/meshNodeId/nativeUuid/logicalAddress를 exact 검증한다. detailsRedacted=true 응답은 brightness=null,targets=[],results=[]이며 id/fingerprint replay와 canonical terminal 상태를 보존한다.

## Task 1: 공유 schema·V3 helper·MQTT/ACL 생성 계약 — backend

**Files:** Create packages/shared/src/temporary-control-contracts.ts, holiday-calendar-contracts.ts, bio-automation-version.ts 및 각각 .test.ts; Modify packages/shared/src/automation-contracts.ts, index.ts, mqtt.ts, mqtt.test.ts, automation-contracts.test.ts, packages/shared/package.json, tsconfig.esm.json; Modify scripts/dev-runtime.mjs, infra/mosquitto.acl.example, scripts/dev-runtime.test.mjs, scripts/dev-mqtt-acl.integration.test.mjs, tests/mqtt-production-config.node.mjs, docs/menus/control.md. scripts/dev-prepare.mjs는 명시적 temporaryControlScopes 검증/전달에 필요한 경우만 수정한다.
**Consumes:** 위 공유 계약 초안과 기존 DimmingTarget/command-delivery.ts. **Produces:** 위 named type과 strict temporaryControl{Create,End,Command,Result,IngestedReceipt,View}Schema·automationConfigApplied{V3,DeliveryV3,ReceiptV3}Schema·V3 snapshot/request schema; HolidayDatasetSnapshot/ScheduleCalendarResponse; supportsBioAutomation(value:AutomationCurrentConfigRequest):boolean, supportsTemporaryBioControl(value:AutomationCurrentConfigRequest):boolean; mqttTopics.temporaryControl{Command,Result,Ingested}(siteId:string,gatewayId:string):string.
  matchesAutomationConfigAppliedReceiptV3(delivery:AutomationConfigAppliedDeliveryV3,receipt:AutomationConfigAppliedReceiptV3):boolean는 site/gateway/ackId/schema/revision/hash의 같은 결과인지 검증한다. 외부 envelope에 없는 revision/hash 필드를 새로 만들어 비교하지 않는다.
- [x] **Step 1 / RED test:** boundary tests에 전체 최소/최대, unknown key, unique1000/1001, duration0/1441, brightness0/100/101, canonical generation, hash·scope 불일치를 추가한다. 아래 이름/증거를 pin한다.
~~~ts
it("known_v3_only_and_no_legacy_ttl_fallback", () => {
  expect(supportsTemporaryBioControl(h.v2)).toBe(false);
  expect(supportsTemporaryBioControl(h.v3)).toBe(true);
  expect(h.commandSchema.safeParse(h.command({schemaVersion:4})).success).toBe(false);
  expect(h.createSchema.safeParse(h.create({overrideUntil:h.iso})).success).toBe(false);
});
it("v3_exact_ack_cannot_wrap_v2_or_other_gateway", () => {
  expect(h.v3AckSchema.safeParse(h.ack({schemaVersion:3,payloadHash:h.currentHash})).success).toBe(true);
  expect(h.v3DeliverySchema.safeParse(h.delivery({acknowledgement:h.v2Ack})).success).toBe(false);
  expect(h.v3DeliverySchema.safeParse(h.delivery({gatewayId:h.gatewayA,acknowledgement:h.ack({gatewayId:h.gatewayB})})).success).toBe(false);
});
~~~
- [x] **Step 2 / RED 실행:** pnpm --filter @led-control/shared test src/temporary-control-contracts.test.ts src/holiday-calendar-contracts.test.ts src/bio-automation-version.test.ts src/automation-contracts.test.ts src/mqtt.test.ts; DEV_MQTT_ACL_INTEGRATION=1 node --test --test-name-pattern='temporary control' scripts/dev-runtime.test.mjs scripts/dev-mqtt-acl.integration.test.mjs tests/mqtt-production-config.node.mjs. missing export/새 ACL 권한 absence로 FAIL을 확인한다; 기존 broker prerequisite 실패는 RED로 계산하지 않으며 지정 새 broker 사례 skip은 허용하지 않는다.
- [x] **Step 3 / 최소 코드:** strict discriminated schemas/tuple exact attribution·위 version helper를 구현한다. Web용 두 신규 subpath를 package.json exports/tsconfig.esm.json에 추가하고 CJS/ESM 산출물 모두 검사한다. 새 ACL은 기존 suffix wildcard 생성과 분리하고 canonicalUUID/census 검증된 현장–Gateway mapping의 exact 신규 경로만 부여한다. template도 새 와일드카드 대신 명시적 귀속 예시를 기록한다. 기존 명령 권한은 유지하고 ACL test는 자기 소유 disposable broker만 사용한다.
- [x] **Step 4 / GREEN:** Step2 명령 동일 실행+pnpm workspace:prepare. schema 전체 지정사례 PASS, ACL own publish/receive PASS·다른 Gateway/익명 DENIED, type/export 준비 exit0. 현재 턴에서는 실행하지 않는다.
- [x] **Step 5 / 소유 commit:** 아래만 stage, 총괄 기록/공유 계약 검토 뒤 소비자에 전달한다.
~~~bash
git add packages/shared/src/temporary-control-contracts.ts packages/shared/src/temporary-control-contracts.test.ts packages/shared/src/holiday-calendar-contracts.ts packages/shared/src/holiday-calendar-contracts.test.ts packages/shared/src/bio-automation-version.ts packages/shared/src/bio-automation-version.test.ts packages/shared/src/automation-contracts.ts packages/shared/src/automation-contracts.test.ts packages/shared/src/index.ts packages/shared/src/mqtt.ts packages/shared/src/mqtt.test.ts packages/shared/package.json packages/shared/tsconfig.esm.json scripts/dev-runtime.mjs scripts/dev-runtime.test.mjs scripts/dev-mqtt-acl.integration.test.mjs infra/mosquitto.acl.example tests/mqtt-production-config.node.mjs docs/menus/control.md
git commit -m "feat(shared): define BIO temporary control and V3 contracts"
~~~

## Task 2: Prisma lease·receipt·공휴일 저장과 V3 SQL 자격 — backend

**Files:** Modify apps/api/prisma/schema.prisma, docs/database-schema.md, docs/menus/control.md; Create apps/api/prisma/migrations/20261014090000_bio_temporary_control_calendar/migration.sql, apps/api/src/automation/bio-control-schema.integration.spec.ts. 기존 test/support/disposable-postgres.ts를 소비한다. 과거20260930160000/20261008060000 migration은 읽기만 한다.
**Consumes:** Task1 exact generation/version/capability. **Produces:** Prisma TemporaryControlSession/TemporaryControlTarget/TemporaryControlLease/TemporaryControlOperationReceipt/TemporaryControlOutbox/TemporaryControlResultReceipt/HolidayDataset/HolidayYearCoverage; DB admission FK/unique/CHECK와 V2/V3 qualification SQL.
- [x] **Step 1 / RED test:** disposablePostgres().deploy/자기 fixture를 사용하고 기존 native/BIO row/defaultfalse를 대조한다. 직접 SQL 동시 lease·타site FK·generation rollback·retention 후 replay도 검증한다.
~~~ts
it("recreated_fixture_and_redacted_replay_keep_owner_fence", async () => {
  await h.redactTerminalDetails(); expect(await h.idempotencyCount()).toBe(2);
  expect(await h.oldIdentityResult()).toMatchObject({accepted:false});
  expect(await h.reserveSameFixtureNextSession()).toMatchObject({applyGeneration:"3",releaseGeneration:"4"});
  expect(await h.applyOldReceiptToDifferentUuidAndFixtureId()).toBe(false);
  expect(await h.readExistingSchedule()).toMatchObject({excludeWeekends:false,excludeHolidays:false});
});
~~~
- [x] **Step 2 / RED 실행:** pnpm workspace:prepare 후 pnpm --filter @led-control/api test --runInBand --runTestsByPath src/automation/bio-control-schema.integration.spec.ts. 새 migration/column/constraint가 없는 assertion FAIL을 확인한다. PostgreSQL16 prerequisite 부재는 skip/PASS로 대체하지 않는다.
- [x] **Step 3 / 최소 코드:** migration은 새 파일에만 작성한다. fixtureId 하나의 lease row에 owner nullable·identity·마지막 counter를 유지하고 unresolved session/fixture 삭제를 RESTRICT한다. 시작에서 apply=counter+1/release=counter+2를 예약하고 마지막 counter를+2로 원자 저장한다. site/gateway composite FK, start/end receipt unique(site,actor,operation,clientRequestId), target unique(session,fixture), exact event/hash receipt를 만든다. 새 fixtureId/다른UUID는 별도 identity이며 과거 counter 복사/PK 재사용은 하지 않는다. 설정/등록 보존과 terminal 상세 redaction 후 최소 receipt/tombstone 보존을 분리한다.
  새 migration에서 GatewayAutomationProtocolSupport CHECK를 known1/2/3로 교체하고 V3 capability column을 추가한다. bio_sensor_blocked_reasons 및 그 소비 qualification/trigger 함수는 known2 또는 필수 BIO 증거를 가진3으로 교체한다. numeric3만으로 ready를 만들지 않으며 기존V2 source 자격을 유지한다. HolidayYearCoverage는 완전 dataset FK와 country/year unique를 원자 교체한다.
- [x] **Step 4 / GREEN:** 위 명령 동일+pnpm --filter @led-control/api prisma:generate. 테스트가 자기 PG에서 migrate deploy/default/보존/동시owner/SQL qualification PASS, generate exit0이어야 한다. ambient DATABASE_URL로 prisma:migrate/dev 또는 운영 deploy를 실행하지 않는다.
- [x] **Step 5 / 소유 commit:**
~~~bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20261014090000_bio_temporary_control_calendar/migration.sql apps/api/src/automation/bio-control-schema.integration.spec.ts docs/database-schema.md docs/menus/control.md
git commit -m "feat(api): persist BIO session leases and V3 qualification"
~~~

## Task 3: 공식 한국 공휴일 완전 dataset·갱신 cache — backend

**Files:** Create apps/api/src/automation/holiday-provider.ts, holiday-dataset.service.ts, holiday-dataset.service.spec.ts; Modify apps/api/src/automation/automation-runtime.module.ts, docs/menus/control.md. 실제 ServiceKey/env 설정은 하지 않는다.
**Consumes:** Task1 HolidayDatasetSnapshot, Task2 HolidayDataset/YearCoverage, 기존 AutomationClock/lockMutation. **Produces:** holiday-provider.ts의 HolidayProviderPage={year:number,month:number,page:number,numOfRows:number,totalCount:number,items:Array<{date:string,name:string,isHoliday:boolean}>}; HolidayProvider.fetchMonth(input:{year:number;month:number;page:number},signal:AbortSignal):Promise<HolidayProviderPage>; holiday-dataset.service.ts의 HolidayRefreshResult={status:"promoted"|"unchanged"|"failed",revision:string|null,reason:string|null}; HolidayDatasetService.refreshYear(year:number):Promise<HolidayRefreshResult>, loadCoverage(from:string,to:string,tx?:Prisma.TransactionClient):Promise<HolidayDatasetSnapshot[]>. 동일 파일의 loadHolidayCoverage(tx,from,to)로 snapshot/calendar의 같은 transaction에서 검증된 자료를 읽고 역DI를 피한다. HOLIDAY_DATASET_PROMOTION/ onPromoted(tx,dataset) optional hook은 Task4가 같은 transaction에 연결한다.
- [x] **Step 1 / RED test:** HTTP mock의 response.header.resultCode/body.items/item·totalCount/numOfRows/pageNo를 pin하고12개월 모든 페이지를 확인한다. 동일 날짜의 서로 다른 합법 휴일명은 합치되 반복 페이지/동일 source row는 오류다.
~~~ts
it("empty_month_complete_and_failed_refresh_keep_revision", async () => {
  expect((await h.refreshCompleteYear({emptyMonth:2})).status).toBe("promoted");
  const old = await h.cached(); await h.failPage({month:10,page:2});
  expect(await h.cached()).toEqual(old); expect(h.promotions).toBe(1);
});
it("periodic_refresh_and_shutdown", async () => {
  await h.bootAt("2026-10-14T00:00:00Z"); await h.advanceOneDay();
  expect(h.refreshedYears()).toEqual([2026,2027,2026,2027]);
  await h.stop(); await h.advanceOneDay(); expect(h.callsAfterStop()).toBe(0);
});
~~~
- [x] **Step 2 / RED 실행:** pnpm --filter @led-control/api test --runInBand --runTestsByPath src/automation/holiday-dataset.service.spec.ts. missing service 또는 incomplete page 승격 assertion FAIL.
- [x] **Step 3 / 최소 코드:** 내장 fetch와 공식 특일 API response를 strict parse한다. year/month/date/isHoliday/totalCount/페이지 일관성·누락을 검증하고 normalized dataset canonical hash를 계산해 완전 연도만 transaction 승격한다. 최초/하루1회 당해+다음해를 목표로 하며 keyed injected provider가 없으면 refresh unavailable을 노출하고 verified cache만 사용한다. key·URL query·원응답을 로그/브라우저로 보내지 않는다. 종료 hook으로 timer/abort를 정리한다.
- [x] **Step 4 / GREEN:** Step2 동일. 정상 totalCount0·부분/중복·invalid날짜/isHoliday·hash mismatch·provider down·임시휴일 신규revision·shutdown test 전부 PASS; live provider 호출0. periodic_refresh_and_shutdown test는 fake clock에서 최초+하루 뒤 당해/다음해 갱신만 확인하고 stop 이후 호출0을 assert한다. 데이터가 달라진 완전 승격만 Task4의 snapshot revision 갱신 hook을 호출한다.
- [x] **Step 5 / 소유 commit:**
~~~bash
git add apps/api/src/automation/holiday-provider.ts apps/api/src/automation/holiday-dataset.service.ts apps/api/src/automation/holiday-dataset.service.spec.ts apps/api/src/automation/automation-runtime.module.ts docs/menus/control.md
git commit -m "feat(api): validate complete Korean holiday datasets"
~~~

## Task 4: HTTP session·전달 outbox·exact 결과 및 V3 호환 — backend

**실행 경계 보완:** source 확인 후 root는 기존 DB clock attestor와 현재 적용된 V3를 새 admission/apply 관문으로 고정했다. trusted sample은 같은 시작 transaction에서 UTC instant로 사용하며 임의 attestor/process현재시각을 신뢰증거로 합성하지 않는다. admitted replay/query/end intent는 독립 유지하고 currentconfig 없는 새start는409다. 실제 자동 목표/health/RF 직전 평가와 독립GET 일치는 Gateway Task7의 권위, API는 최신 desired/applied revision/hash·원 admission/assignment/target/현재owner/generation·strict 확인 evidence를 검증하며 우선순위 계산을 복제하지 않는다. 같은 CommandDbClockHealth provider를 export하기 위한 `apps/api/src/mqtt/mqtt.module.ts` 최소 수정도 추가 소유 범위다.

이미 권한검증·접수된 immutable start의 원payload/절대endsAt 전달은 원actor의 후속권한취소만으로 자동취소하지 않는다. 새HTTP start/end는 현재권한을 재검증하고 releaseintent/만료와 기존clock/currentconfig/귀속/owner 관문은 유지한다. 관리자의 접수중지는 명시end로 처리하며 end/expiry/recovery는 원actor권한과 독립이다.

**Files:** Create apps/api/src/temporary-controls/temporary-controls.controller.ts, temporary-controls.service.ts, temporary-controls.module.ts, temporary-control-publisher.ts, temporary-control-results.ts, temporary-control-retention.ts 및 temporary-controls.service.spec.ts, temporary-control-publisher.spec.ts, temporary-control-results.spec.ts, temporary-control-retention.spec.ts, temporary-controls.integration.spec.ts; Create apps/api/src/automation/bio-pulse-telemetry.spec.ts. Modify apps/api/src/app.module.ts, commands/commands.service.ts, automation/automation-protocol-support.ts, automation/automation-snapshot.service.ts, automation/automation-mqtt-consumer.service.ts, automation/automation-runtime.module.ts, automation/bio-pulse-telemetry.ts, mqtt/mqtt.service.ts, mqtt/topic-scope.ts, docs/menus/control.md. Existing Test automation/{automation-protocol-support.spec.ts,automation-snapshot.service.spec.ts,automation-mqtt-consumer.service.spec.ts}.
**Consumes:** Tasks1–3 DTO/models/capability/dataset. **Produces:** TemporaryControlsService.start(siteId:string,actor:AuthenticatedUser,input:CreateTemporaryControlInput):Promise<TemporaryControlView>, end(siteId:string,id:string,actor:AuthenticatedUser,input:EndTemporaryControlInput):Promise<TemporaryControlView>, get(siteId:string,id:string,actor:AuthenticatedUser):Promise<TemporaryControlView>, list(siteId:string,actor:AuthenticatedUser,query:TemporaryControlListQuery):Promise<TemporaryControlListResponse>; ingestTemporaryControlResult(scope:{siteId:string;gatewayId:string},result:TemporaryControlResult):Promise<TemporaryControlIngestedReceipt>; assertNoTemporaryLease(tx:Prisma.TransactionClient,fixtureIds:string[]):Promise<void>.
- [x] **Step 1 / RED test:** start/end202·server.now·site read/control을 실제 transaction으로 검증하고 같은 fingerprint 재송신·다른 payload409·active source/nonBIO/2GW409·관측 불확정 충돌을 확인한다.
~~~ts
it("redacted_replay_and_late_release_never_unlock_new_owner", async () => {
  const first = await h.start({durationMinutes:1}); await h.end(first.id); await h.confirmReleaseReadback(first.id);
  await h.redactTerminalDetails(); const replay = await h.retryStart();
  expect(replay).toMatchObject({id:first.id,state:"restored",detailsRedacted:true});
  expect(h.fingerprintUnchanged()).toBe(true); expect(h.extraRfOrOutboxWrites()).toBe(0);
  const next = await h.startNew(); await h.ingestOldRelease();
  expect(await h.owner()).toBe(next.id); expect(h.baselineWrites).toBe(0);
});
it("previous_v3_snapshot_hash_cannot_promote_current_revision", async () => {
  await h.ingestConfigApplied({schemaVersion:3,revision:h.currentRevision,payloadHash:h.previousHash});
  expect(await h.currentSnapshotApplied()).toBe(false);
});
~~~
- [x] **Step 2 / RED 실행:** pnpm --filter @led-control/api test --runInBand --runTestsByPath src/temporary-controls/temporary-controls.service.spec.ts src/temporary-controls/temporary-control-publisher.spec.ts src/temporary-controls/temporary-control-results.spec.ts src/temporary-controls/temporary-control-retention.spec.ts src/temporary-controls/temporary-controls.integration.spec.ts. new route/service/identity assertion FAIL.
- [x] **Step 3 / 최소 코드:** SessionAuthGuard/Cache-Control private,no-store와 spec §6의 상태 코드를 구현한다. lockMutation→site→대상 identity/lease 순서로 재검증하고 UTC 시작+immutable 대상/예약 generation쌍/sequence/receipt/outbox를 원자 생성한다. end는 이미 예약한 release generation/sessionRevision2로 intent/tombstone을 먼저 기록하고 새 counter를 할당하지 않는다. 기본 commands.service의 신규 SET도 같은 lease를 검사한다. publisher worker lease30,000ms/publish timeout10,000ms와 backoff 최대60,000ms는 기존 automation publisher의 bounded 전달 값을 재사용하고 renew/fence/CAS로 결과를 확정한다. start deliveryWindow=min(10,000ms,endsAt-publishNow), 기존 clock guard2,000ms로 RF 전에 판정한다.
  end/recovery는 별도10,000ms 전달 window로 재송신한다. 기존 MAX_DELIVERY_ATTEMPTS10/MAX_DELIVERY_AGE_MS15분은 기존 batch 관측 경계 재사용이며 새 제품 정책이 아니다. terminal batch와 영속 release intent 수명을 분리해 unresolved lease 삭제·복구 종료 조건으로 사용하지 않는다. 새 batch/재접속에서 durable 재시도를 계속하며 holding 시간은 연장하지 않는다. 결과 receipt→durable ingested ACK 순서를 지키고 이전 assignment/대상/원 commandhash/admissionRevision/sequence/generation의 ACK를 현재 상태에 적용하지 않는다. restorationRevision은 별도 최신 목표 증거다.
  V3 snapshot 생성/strict parse·known-version 선언/SQL 자격을 함께 갱신하고 bio-pulse-telemetry의 exact envelope/source binding/hash와 ACK 분기를 보존한다. 권한 만료는 새 쓰기를 막지만 accepted safety expiry/recovery는 멈추지 않는다. UTC3개월 terminal 상세 redaction만 기존 ON/OFF에 연결하며 최소 operation fingerprint/fixture counter/result replay receipt는 유지한다.
- [x] **Step 4 / GREEN:** Step2 동일 뒤 pnpm --filter @led-control/api test --runInBand --runTestsByPath src/automation/automation-protocol-support.spec.ts src/automation/automation-snapshot.service.spec.ts src/automation/automation-mqtt-consumer.service.spec.ts src/automation/bio-pulse-telemetry.spec.ts src/commands/commands.service.spec.ts.401/403/404/400/409/503/202·cancel-before-start·권한취소/DB clock·두 worker lease·PUBACK≠apply·redaction·V2보존/V3strict PASS. pnpm --filter @led-control/api typecheck; pnpm --filter @led-control/api build exit0. PG fixture는 위 integration 파일 자체 생성·정리만 허용한다.
- [x] **Step 5 / 소유 commit:**
~~~bash
git add apps/api/src/temporary-controls/temporary-controls.controller.ts apps/api/src/temporary-controls/temporary-controls.service.ts apps/api/src/temporary-controls/temporary-controls.module.ts apps/api/src/temporary-controls/temporary-control-publisher.ts apps/api/src/temporary-controls/temporary-control-results.ts apps/api/src/temporary-controls/temporary-control-retention.ts apps/api/src/temporary-controls/temporary-controls.service.spec.ts apps/api/src/temporary-controls/temporary-control-publisher.spec.ts apps/api/src/temporary-controls/temporary-control-results.spec.ts apps/api/src/temporary-controls/temporary-control-retention.spec.ts apps/api/src/temporary-controls/temporary-controls.integration.spec.ts apps/api/src/app.module.ts apps/api/src/commands/commands.service.ts apps/api/src/commands/commands.service.spec.ts apps/api/src/automation/automation-protocol-support.ts apps/api/src/automation/automation-protocol-support.spec.ts apps/api/src/automation/automation-snapshot.service.ts apps/api/src/automation/automation-snapshot.service.spec.ts apps/api/src/automation/automation-mqtt-consumer.service.ts apps/api/src/automation/automation-mqtt-consumer.service.spec.ts apps/api/src/automation/bio-pulse-telemetry.ts apps/api/src/automation/bio-pulse-telemetry.spec.ts apps/api/src/mqtt/mqtt.service.ts apps/api/src/mqtt/topic-scope.ts docs/menus/control.md
git add apps/api/src/automation/automation-runtime.module.ts
git add apps/api/src/mqtt/mqtt.module.ts
git commit -m "feat(api): deliver and reconcile BIO temporary sessions"
~~~

## Task 5: 동일 발생일 평가기·서버 달력/next/overlap·제외 저장 — engine/backend 순차

**소유 범위 보완:** apps/api/src/automation/automation.controller.spec.ts의 직접 생성 fixture 1건도 Modify/commit/최소 covering 검증에 포함한다. 새 달력 service는 production에서 필수 의존성을 유지하며 오래된 test 인수 누락을 피하려고 optional 기능 의존성을 만들지 않는다. 다른 API suite로 검증을 확대하지 않는다.

**Files:** Create packages/automation-engine/src/schedule-exclusions.ts, schedule-calendar.ts 및 .test.ts; Modify packages/automation-engine/src/{recurrence.ts,recurrence.test.ts,overlap.ts,overlap.test.ts,index.ts}; Create apps/api/src/automation/schedule-calendar.service.ts, schedule-calendar.service.spec.ts; Modify apps/api/src/automation/{dto/schedule.dto.ts,dto/schedule.dto.spec.ts,schedules.service.ts,schedules.service.spec.ts,automation-snapshot.service.ts,automation-snapshot.service.spec.ts,automation.controller.ts,automation.module.ts}, docs/menus/control.md.
**Consumes:** Tasks1–4 V3 schedule/HolidayDatasetSnapshot/validated coverage. **Produces:** evaluateScheduleStartDate(rule:LightingScheduleSnapshot,date:string,timeZone:string,datasets:readonly HolidayDatasetSnapshot[]):{allowed:boolean;reason:"weekend"|"holiday"|"coverage_unknown"|null}; getOccurrences/getActiveOccurrence/getNextOccurrence/schedulesOverlap은 기존 인수를 유지하고 마지막에 optional datasets를 추가한다; projectScheduleCalendar(input:{rules:readonly LightingScheduleSnapshot[];from:string;to:string;timeZone:string;datasets:readonly HolidayDatasetSnapshot[]}):ScheduleCalendarOccurrence[]; ScheduleCalendarService.get(siteId:string,actor:AuthenticatedUser,range:{from:string;to:string}):Promise<ScheduleCalendarResponse>.
~~~ts
function getOccurrences(rule:LightingScheduleSnapshot,range:OccurrenceRange,timeZone:string,datasets?:readonly HolidayDatasetSnapshot[]):ScheduleOccurrence[];
function getActiveOccurrence(rule:LightingScheduleSnapshot,epochMs:number,timeZone:string,datasets?:readonly HolidayDatasetSnapshot[]):ScheduleOccurrence|null;
function getNextOccurrence(rule:LightingScheduleSnapshot,epochMs:number,timeZone:string,datasets?:readonly HolidayDatasetSnapshot[]):ScheduleOccurrence|null;
function schedulesOverlap(left:LightingScheduleSnapshot,right:LightingScheduleSnapshot,timeZone:string,datasets?:readonly HolidayDatasetSnapshot[]):boolean;
~~~
OccurrenceRange/ScheduleOccurrence는 기존 recurrence.ts 타입을 재사용하고 신규 parallel recurrence 구현은 만들지 않는다.
- [x] **Step 1 / RED test:** 주말/휴일/coverage를 시작일 iterator 한곳에서 적용하는 증거로 once/일요일7/31일/윤일/야간+1일/DST spill·next/overlap 일치를 고정한다. complete API는 권한 있는101개 일정을 첫100개에서 자르지 않는다.
~~~ts
it("late_holiday_revision_and_complete_calendar", async () => {
  expect(h.nextBeforeHoliday().localDate).toBe("2026-10-05");
  h.promoteHoliday("2026-10-05"); expect(h.nextAfterHoliday().localDate).toBe("2026-10-06");
  const view = await h.calendarWith101Rules(); expect(view.complete).toBe(true);
  expect(new Set(view.occurrences.map(x => x.scheduleId)).size).toBe(101);
});
~~~
- [x] **Step 2 / RED 실행:** pnpm --filter @led-control/automation-engine test src/schedule-exclusions.test.ts src/schedule-calendar.test.ts src/recurrence.test.ts src/overlap.test.ts; pnpm --filter @led-control/api test --runInBand --runTestsByPath src/automation/schedule-calendar.service.spec.ts src/automation/schedules.service.spec.ts src/automation/dto/schedule.dto.spec.ts src/automation/automation-snapshot.service.spec.ts. 새 flag 거절/다음 후보에 휴일 잔존/101개 누락 assertion FAIL을 확인한다.
- [x] **Step 3 / 최소 코드:** engine writer가 먼저 iterator/기존 Temporal을 최소 확장하고 검증 commit을 전달한다. 이후 backend writer가 DTO(defaultfalse/patch 생략값 유지)/DB mapping→snapshot/next/overlap/API를 연결한다. 새 true 제외는 BIO 대상/지원V3가 필요하고 휴일true는 Asia/Seoul+전체 active 기간 coverage를 재검증한다. 기존 false 일정의 native 동작은 유지한다.
  GET calendar route는 :scheduleId 계열보다 먼저 등록한다. RepeatableRead/site-read 안에서 최대42일 전체 schedules/revisions/dataset을 읽어 완전 단일 응답을 만들고 filter/page 인수 혼입은400이다. 알 수 없는 coverage의 시작만 차단 이유를 기록하고 기존 occurrence end는 유지한다. weekday/holiday 변경과 저장에 새 revision을 발행한다.
- [x] **Step 4 / GREEN:** engine Step2→pnpm workspace:prepare→API Step2 순서. flag 단독/default/patch 생략, 시작일 양끝 포함, excluded once 이월 없음, 야간 종료, coverage 부족/다른TZ409, offline 동일 결과와42/43일·101개·동일 transaction revision PASS. pnpm --filter @led-control/automation-engine typecheck; pnpm --filter @led-control/api typecheck 모두 exit0.
- [x] **Step 5 / 소유 commit:** engine 결과를 backend에게 순서대로 전달하며 같은 checkout의 단독 writer를 교대한다.
~~~bash
git add packages/automation-engine/src/schedule-exclusions.ts packages/automation-engine/src/schedule-exclusions.test.ts packages/automation-engine/src/schedule-calendar.ts packages/automation-engine/src/schedule-calendar.test.ts packages/automation-engine/src/recurrence.ts packages/automation-engine/src/recurrence.test.ts packages/automation-engine/src/overlap.ts packages/automation-engine/src/overlap.test.ts packages/automation-engine/src/index.ts docs/menus/control.md
git commit -m "feat(engine): evaluate BIO schedule exclusions consistently"
git add apps/api/src/automation/schedule-calendar.service.ts apps/api/src/automation/schedule-calendar.service.spec.ts apps/api/src/automation/dto/schedule.dto.ts apps/api/src/automation/dto/schedule.dto.spec.ts apps/api/src/automation/schedules.service.ts apps/api/src/automation/schedules.service.spec.ts apps/api/src/automation/automation-snapshot.service.ts apps/api/src/automation/automation-snapshot.service.spec.ts apps/api/src/automation/automation.controller.ts apps/api/src/automation/automation.module.ts docs/menus/control.md
git add apps/api/src/automation/automation.controller.spec.ts
git commit -m "feat(api): persist exclusions and project complete calendars"
~~~

## Task 6: Gateway BIO durable lease·RF 부분변경 apply — gateway

**연결 경계:** 필수 current-target preflight와 기존 adapter의 실제 쓰기 경계 lease guard를 연결한다. 명시적 temporaryTargetPort의 private control token만 owner 쓰기를 구분하며 source/clock/현재 신원·generation 검사 우회는 없다. 실제 production wiring·최신 자동 목표 restore/독립GET/settlement는 Task7이다. Task6 tick은 예약된 release pair의 영속 intent만 기록하고 placeholder 복귀 목표를 실행하지 않는다.

**Files:** Create apps/gateway/src/automation/bio-temporary-control-runtime.ts, bio-temporary-control-runtime.test.ts; Modify apps/gateway/src/automation/{automation-state-store.ts,automation-state-store.test.ts,bio-pulse-scheduler.ts,schedule-runtime.ts}, apps/gateway/src/bio/bio-dongle-client.ts, apps/gateway/src/adapters/bio-usb-dongle-adapter.ts; Test(existing) bio/bio-dongle-client.test.ts, adapters/bio-usb-dongle-adapter.test.ts, automation/schedule-runtime-bio.test.ts; docs/menus/control.md.
**Consumes:** Task1 TemporaryControlCommand/Result, Task4 accepted start, 기존 BioVerifiedLampTarget/BioConfigurationState/BioTargetConfigurationPort/SerialTaskQueue/ClockTrustProvider. **Produces:** BioTemporaryControlRuntime.accept(command:TemporaryControlCommand):Promise<void>, ownsFixture(fixtureId:string):boolean, tick():Promise<void>, observe(fixtureId:string,observation:{target:BioVerifiedLampTarget;configuration:BioConfigurationState}):Promise<void>; 아래 새 state/port 타입.
~~~ts
// bio-temporary-control-runtime.ts에서 생산하고 기존 readBioState/restoreBioState/setOutput에 연결한다.
interface BioTemporaryApplyControl extends BioOperationControl {beforeMutation(stage:"high_brightness"|"mode"):Promise<void>}
interface BioTemporaryTargetPort {
  read(fixtureId:string,control:BioOperationControl):Promise<{target:BioVerifiedLampTarget;configuration:BioConfigurationState}>;
  apply(fixtureId:string,brightness:number,control:BioTemporaryApplyControl):Promise<{brightnessPercent:number;mode:"force-on"|"force-off"}>;
  restore(fixtureId:string,target:BioVerifiedLampTarget,configuration:BioConfigurationState,control:BioTemporaryApplyControl):Promise<BioConfigurationState>;
}
// automation-state-store.ts에서 생산; 기존 V9의 모든 필드를 보존한다.
type PersistedTemporaryTarget = {snapshot:TemporaryFixtureSnapshot;preState:BioConfigurationState|null;preActivationId:string|null;applyConfirmed:boolean;releaseConfirmed:boolean;configurationMayHaveChanged:boolean;partialMutation:TemporaryTargetEvidence["partialMutation"];applyResult:TemporaryControlResult|null;releaseResult:TemporaryControlResult|null};
type PersistedTemporarySession = {command:StartTemporaryControlCommand;sessionRevision:1|2;state:TemporaryControlState;targets:Record<string,PersistedTemporaryTarget>};
type PersistedFixtureLease = {sessionId:string|null;identity:TemporaryFixtureSnapshot;lastGeneration:Generation;applyGeneration:Generation;releaseGeneration:Generation;phase:TemporaryControlState};
type PersistedAutomationStateV10 = Omit<PersistedAutomationStateV9,"schemaVersion"> & {schemaVersion:10;temporarySessions:Record<string,PersistedTemporarySession>;fixtureLeases:Record<string,PersistedFixtureLease>;temporaryResultOutbox:Record<string,TemporaryControlResult>;temporaryEndTombstones:Record<string,EndTemporaryControlCommand>};
~~~
- [x] **Step 1 / RED test:** fresh 정당 identity/정상 자동 설정 preState 저장 뒤에만 RF를 실행하고 low-level writesStarted 증거를 callback으로 기록한다. high 쓰기 후 mode mismatch의 최종 실패도 복귀 대상이다.
~~~ts
it("partial_high_write_never_becomes_unchanged_or_baseline", async () => {
  await h.failAfterHighBrightnessWrite(); const row = h.targetState();
  expect(row).toMatchObject({applyConfirmed:false,configurationMayHaveChanged:true,partialMutation:"high_brightness"});
  expect(h.leaseOwner()).toBe(h.sessionId); expect(h.baseline).toEqual(h.initialBaseline);
  expect(h.permanentRetireCalls).toBe(0);
});
~~~
- [x] **Step 2 / RED 실행:** pnpm --filter @led-control/gateway test src/automation/bio-temporary-control-runtime.test.ts src/automation/automation-state-store.test.ts src/automation/schedule-runtime-bio.test.ts src/bio/bio-dongle-client.test.ts src/adapters/bio-usb-dongle-adapter.test.ts. lease/partialMutation/persisted state assertion FAIL。
- [x] **Step 3 / 최소 코드:** V9→V10은 기존 원장/설정 보존+빈 session/lease로 migration하고 absolute endsAt/단조 lease를 저장한다. GET/prepare/may_have_written/result 경계는 updateDurable, ENOSPC에서는 새 RF를 하지 않는다. source 금지/UUID-address/assignment/revision/current capability를 RF 직전에 재검증하고 명시 RF0와 unknown을 분리한다.
  product BIO target의 write/apply/restore가 같은 fixture lease를 검사한다. pulse/health/source 증거 수신은 유지하고 선택 target의 쓰기만 보류한다. arbiter candidate 추가나 retireManualTargets로 대체하지 않는다. beforeMutation은 각 설정 쓰기 전에 변경 가능 intent를 durable 저장한 뒤 resolve하고, setOutput/restore의 callback evidence와 정확한 configuration GET로 검증된 부분변경·unknown을 구분한다. 시작 명령의 예약 apply/release쌍을 그대로 저장해 offline expiry가 새 서버 counter를 필요로 하지 않게 한다.
- [x] **Step 4 / GREEN:** Step2 동일+pnpm --filter @led-control/gateway typecheck. active source 거절·identity 차단·highonly/modeonly/unknown·RF 전 실패·duplicate·endsAt 경과·1/1440분·clock rollback·ENOSPC·restart_pending_apply PASS. unknown row/lease는 관측까지 유지하고 holding/restored로 바꾸지 않는다.
- [x] **Step 5 / 소유 commit:**
~~~bash
git add apps/gateway/src/automation/bio-temporary-control-runtime.ts apps/gateway/src/automation/bio-temporary-control-runtime.test.ts apps/gateway/src/automation/automation-state-store.ts apps/gateway/src/automation/automation-state-store.test.ts apps/gateway/src/automation/bio-pulse-scheduler.ts apps/gateway/src/automation/schedule-runtime.ts apps/gateway/src/automation/schedule-runtime-bio.test.ts apps/gateway/src/bio/bio-dongle-client.ts apps/gateway/src/bio/bio-dongle-client.test.ts apps/gateway/src/adapters/bio-usb-dongle-adapter.ts apps/gateway/src/adapters/bio-usb-dongle-adapter.test.ts docs/menus/control.md
git commit -m "feat(gateway): persist BIO temporary ownership and partial writes"
~~~

## Task 7: 최신 자동 운전 release·V3/holiday 적용·durable 결과 ACK — gateway

**소유 범위 보완:** apps/gateway/src/automation/automation-config-store.ts도 Modify/commit에 포함한다. 기존 parseAutomationSnapshot 경계에서 V3 holiday의 검증된 내용/hash를 확인한 뒤 공통 evaluator가 소비하도록 연결하는 데 필요한 파일이다. 별도 recurrence/hash 구현이나 새 운영 설정은 추가하지 않는다.

**내구성 소비 범위 보완:** automation/automation-state-store.ts 및 automation-state-store.test.ts도 Modify/commit/직접 covering 범위에 포함한다. 실제 end-before-start에서는 API가 뒤의 start 전달을 보류하므로 존재하지 않는 start를 기다리거나 조작하지 않고 genuine end-only 결과/최소 settlement proof를 보존해야 한다. Task6의 strict reservation/slot/revision 검증을 약화시키지 않는다. 새 저장 타입이 필요하면 root에 정확한 제안/근거를 전달한 뒤 구현한다.

**Files:** Create apps/gateway/src/automation/bio-temporary-release.ts, bio-temporary-release.test.ts, temporary-control-mqtt.ts, temporary-control-mqtt.test.ts, temporary-control-result-outbox.ts, temporary-control-result-outbox.test.ts; Modify automation/{bio-temporary-control-runtime.ts,bio-product-pulse-controller.ts,bio-pulse-scheduler.ts,bio-source-target-guard.ts,vehicle-event-runtime.ts,schedule-runtime.ts,automation-runtime.ts,automation-current-config-requester.ts}, apps/gateway/src/index.ts, docs/menus/control.md. Test(existing) automation/{production-bio-pulse-integration.test.ts,bio-source-target-guard.test.ts,automation-runtime.test.ts,automation-current-config-requester.test.ts,automation-config-store.test.ts,automation-config-ack-outbox.test.ts,vehicle-event-runtime.test.ts}; 새 release test의 file-store로 restart/ACK replay를 검증한다.
**Consumes:** Tasks1/5/6 contract/evaluator/lease, 기존 product BIO authority/current activation/정상 configuration 증거. **Produces:** bio-temporary-release.ts의 BioAutomaticTarget={configuration:BioConfigurationState,restorationRevision:number,restorationPayloadHash:string,sourceIdentity:string|null}; resolveLatestBioAutomaticTarget(input:{fixtureId:string;snapshot:AutomationSnapshot;state:PersistedAutomationStateV10;now:Date}):BioAutomaticTarget|{reason:string}; runtime.release(command:EndTemporaryControlCommand):Promise<void>, expire(now:Date):Promise<void>, stopAndDrain():Promise<void>; temporary-control-result-outbox.ts의 TemporaryControlResultOutbox.persist(result:TemporaryControlResult):Promise<void>, confirm(receipt:TemporaryControlIngestedReceipt):Promise<boolean>.
- [ ] **Step 1 / RED test:** partialMutation+applyConfirmed 대상은 관측·재평가 후 복귀하고 unchanged를 증명한 대상만 제외한다. GET/fsync 사이 snapshot/health/lease 변경을 주입한다.
~~~ts
it("release_revision_race_and_degraded_release", async () => {
  await h.beginReleaseThenChangeRevision(); expect(h.lastAppliedRevision()).toBe(h.latestRevision);
  await h.degradeBeforeRestore(); expect(h.state()).toBe("recovery_pending");
  expect(h.leaseReleased()).toBe(false); expect(h.replayedOldPulseCount).toBe(0);
});
it("offline_expiry_uses_reserved_release_fence", async () => {
  await h.startWithReservedPair("1","2"); await h.disconnectApiAndExpire();
  expect(h.releaseResult()).toMatchObject({sessionRevision:2,targetGeneration:"2",originCommandHash:h.startHash,admissionRevision:h.startRevision,restorationRevision:h.latestRevision,restorationPayloadHash:h.latestHash,releaseConfirmed:true});
  expect(h.serverCounterAllocationsDuringExpiry()).toBe(0);
});
~~~
- [ ] **Step 2 / RED 실행:** pnpm --filter @led-control/gateway test src/automation/bio-temporary-release.test.ts src/automation/temporary-control-mqtt.test.ts src/automation/temporary-control-result-outbox.test.ts src/automation/production-bio-pulse-integration.test.ts src/automation/bio-source-target-guard.test.ts src/automation/automation-runtime.test.ts src/automation/automation-current-config-requester.test.ts src/automation/automation-config-store.test.ts src/automation/automation-config-ack-outbox.test.ts src/automation/vehicle-event-runtime.test.ts. 최신 release revision/oldACK/knownV3/source 보호/예약 offline fence assertion FAIL.
- [ ] **Step 3 / 최소 코드:** release intent/tombstone→exact GET→현재 자동 목표→RF 직전 revision/health/generation 재검증→restoreConfiguration high+mode GET→durable result 순서를 지킨다. 기존 event>schedule>normal 우선 의미와 still-valid activation을 유지하고 만료 hold/중간 pulse 재활성은 금지한다. 안전 목표를 결정할 수 없으면 recovery_pending으로 owner를 유지한다.
  V3 snapshot은 해당 version으로 install한다. 관련 schemaVersion===2 분기를 known helper로 갱신해 V3 BIO/source reservation/telemetry/store 내구성을 보호한다. index.ts1059 부근 선언과 requester를 V3로 바꾸고 Task1 새 topics의 strict scope/router/outbox를 MQTT에 연결한다. 검증 dataset을 config store에 저장하고 next/actual에 Task5 evaluator를 사용한다. result outbox는 저장된 originCommandHash/admissionRevision과 별도 restorationRevision을 그대로 replay하고 exact ingested receipt 뒤에만 해당 event를 정리한다.
- [ ] **Step 4 / GREEN:** Step2 동일+pnpm --filter @led-control/gateway typecheck; pnpm --filter @led-control/gateway build 한 번. release-before-start·end-after-expiry·권한 취소 후 안전 만료·late apply/release·identity 변경·partial terminal fsync/restart·source health fault·동일 부팅 monotonic/재시작 absolute·offline holiday·V2 보존/V3 source 보호 PASS. 카운트다운0/PUBACK는 restored 증거가 아니며 새 USB listener는 만들지 않는다.
- [ ] **Step 5 / 소유 commit:**
~~~bash
git add apps/gateway/src/automation/bio-temporary-release.ts apps/gateway/src/automation/bio-temporary-release.test.ts apps/gateway/src/automation/temporary-control-mqtt.ts apps/gateway/src/automation/temporary-control-mqtt.test.ts apps/gateway/src/automation/temporary-control-result-outbox.ts apps/gateway/src/automation/temporary-control-result-outbox.test.ts apps/gateway/src/automation/bio-temporary-control-runtime.ts apps/gateway/src/automation/bio-product-pulse-controller.ts apps/gateway/src/automation/bio-pulse-scheduler.ts apps/gateway/src/automation/bio-source-target-guard.ts apps/gateway/src/automation/bio-source-target-guard.test.ts apps/gateway/src/automation/vehicle-event-runtime.ts apps/gateway/src/automation/vehicle-event-runtime.test.ts apps/gateway/src/automation/schedule-runtime.ts apps/gateway/src/automation/automation-runtime.ts apps/gateway/src/automation/automation-runtime.test.ts apps/gateway/src/automation/automation-current-config-requester.ts apps/gateway/src/automation/automation-current-config-requester.test.ts apps/gateway/src/automation/automation-config-store.test.ts apps/gateway/src/automation/automation-config-ack-outbox.test.ts apps/gateway/src/automation/production-bio-pulse-integration.test.ts apps/gateway/src/index.ts docs/menus/control.md
git add apps/gateway/src/automation/automation-config-store.ts
git add apps/gateway/src/automation/automation-state-store.ts apps/gateway/src/automation/automation-state-store.test.ts
git commit -m "feat(gateway): verify latest BIO automatic restoration and V3"
~~~

## Task 8: 공통 추가 행·서버 달력·ScheduleDialog 제외 — 지정 Web 담당

**Files:** Create apps/web/src/features/control/automation/components/AutomationRuleHeader.tsx, AutomationRuleHeader.test.tsx, ScheduleCalendar.tsx, ScheduleCalendar.test.tsx, calendar-segments.ts, calendar-segments.test.ts; Modify apps/web/src/api/automation.ts, features/control/automation/{ScheduleControlPanel.tsx,ScheduleControlPanel.test.tsx,VehicleEventControlPanel.tsx,VehicleEventControlPanel.test.tsx,ScheduleDialog.tsx,ScheduleDialog.test.tsx,schedule-form.ts,schedule-form.test.ts,automation-presenters.ts}, components/AutomationRuleControls.tsx, components/AutomationRuleControls.test.tsx, docs/menus/control.md.
**Consumes:** Task5 ScheduleCalendarResponse/flags·기존 beginAdd/beginEdit(schedule,opener)/scheduleQueryKey. **Produces:** listScheduleCalendar(siteId:string,range:{from:string;to:string},signal?:AbortSignal):Promise<ScheduleCalendarResponse>; AutomationRuleHeader(props:{view?:"list"|"calendar";onViewChange?:(view:"list"|"calendar")=>void;addAction:ReactNode}):JSX.Element; calendarWeekSegments(dates:readonly string[],rangeStart:string):CalendarWeekSegment[]; CalendarWeekSegment={week:number,start:number,end:number,from:string,to:string}.
- [ ] **Step 1 / RED test:** 서버 완전 응답만 띠로 투영하고 header 추가 한개·dialog draft/bothfalse·cancel/Escape/A→B→신규 격리·scope 만료 중 응답 폐기를 검증한다.
~~~ts
it("complete_calendar_and_revoked_scope", async () => {
  await h.showCalendarWith101Rules(); expect(h.renderedScheduleIds().size).toBe(101);
  expect(h.addButtons("스케줄 추가")).toHaveLength(1);
  await h.revokeScopeBeforeResponse(); expect(h.staleCalendarVisible()).toBe(false);
  await h.cancelAndOpenNewDialog(); expect(h.exclusions()).toEqual([false,false]);
});
~~~
- [ ] **Step 2 / RED 실행:** pnpm --filter @led-control/web test src/features/control/automation/components/AutomationRuleHeader.test.tsx src/features/control/automation/components/ScheduleCalendar.test.tsx src/features/control/automation/components/calendar-segments.test.ts src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx src/features/control/automation/ScheduleDialog.test.tsx src/features/control/automation/schedule-form.test.ts src/features/control/automation/components/AutomationRuleControls.test.tsx. header/flag/완전 응답 assertion FAIL.
- [ ] **Step 3 / 최소 코드:** 왼쪽 list/calendar·오른쪽 add를 같은 common header에 두고 event add에도 재사용한다. filter는 목록 전용, reset만 schedule에서 제거하고 event reset은 유지한다. 공통 Switch를 time helper 바로 아래 두고 네 form 변환 함수에 flags를 연결한다. 저장 뒤 list/calendar/next를 동일 revision으로 invalidate한다. 서버 occurrence를 sorted unique→연속 날짜→주 분할하며 hole/앞뒤 월 spill/야간+1일 표시·띠 클릭의 기존 edit dialog 연결을 구현한다.
- [ ] **Step 4 / GREEN:** Step2 동일. disabled/range/coverage reason·401/403/409·incomplete response/저장 실패·timezone/weekly/중간 holiday/월·주 경계·44px 띠/visible label focus PASS. 별도 shell/map/휴일 관리는 추가하지 않는다.
- [ ] **Step 5 / 소유 commit:**
~~~bash
git add apps/web/src/api/automation.ts apps/web/src/features/control/automation/components/AutomationRuleHeader.tsx apps/web/src/features/control/automation/components/AutomationRuleHeader.test.tsx apps/web/src/features/control/automation/components/ScheduleCalendar.tsx apps/web/src/features/control/automation/components/ScheduleCalendar.test.tsx apps/web/src/features/control/automation/components/calendar-segments.ts apps/web/src/features/control/automation/components/calendar-segments.test.ts apps/web/src/features/control/automation/ScheduleControlPanel.tsx apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx apps/web/src/features/control/automation/VehicleEventControlPanel.tsx apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx apps/web/src/features/control/automation/ScheduleDialog.tsx apps/web/src/features/control/automation/ScheduleDialog.test.tsx apps/web/src/features/control/automation/schedule-form.ts apps/web/src/features/control/automation/schedule-form.test.ts apps/web/src/features/control/automation/automation-presenters.ts apps/web/src/features/control/automation/components/AutomationRuleControls.tsx apps/web/src/features/control/automation/components/AutomationRuleControls.test.tsx docs/menus/control.md
git commit -m "feat(web): share automation actions and render server calendars"
~~~

## Task 9: 실제 시간제 UI·이력/선택 보존·한정 통합 검증 — 지정 Web→총괄 QA

**Files:** Create apps/web/src/api/temporary-controls.ts, features/control/useTemporaryControlSession.ts, useTemporaryControlSession.test.tsx, TemporaryControlPanel.tsx, TemporaryControlPanel.test.tsx, TemporaryControlHistory.tsx, TemporaryControlHistory.test.tsx, apps/web/e2e/bio-control-operations.spec.ts; Modify features/control/{ControlView.tsx,ControlView.test.tsx,ManualExecutionPanel.tsx,ManualExecutionPanel.test.tsx,CommandHistoryPanel.tsx,CommandHistoryPanel.test.tsx}, manual-workspace/ManualAuxiliaryPanel.tsx, target-selection/SpatialTargetSelector.tsx, target-selection/SpatialTargetSelector.test.tsx, docs/menus/control.md. Existing components/ui/operations/RecentActivityTicker.tsx, components/ui/DrawerDialog.tsx는 재사용하고 불필요 수정하지 않는다.
**Consumes:** Task4 start/end/get/list TemporaryControlView와별도 history discriminator, Task8 common actions·기존 control scope/선택/영구 submitCommand/sendCommand. **Produces:** startTemporaryControl(siteId:string,input:CreateTemporaryControlInput):Promise<TemporaryControlView>, endTemporaryControl(siteId:string,id:string,input:EndTemporaryControlInput):Promise<TemporaryControlView>, getTemporaryControl(siteId:string,id:string,signal?:AbortSignal):Promise<TemporaryControlView>, listTemporaryControls(siteId:string,query:TemporaryControlListQuery,signal?:AbortSignal):Promise<TemporaryControlListResponse>.
~~~ts
// useTemporaryControlSession.ts에서 생산; 임시 요청은 기존 active-command-store로 cast하지 않는다.
type TemporaryControlSessionOptions = {siteId:string;principalKey:string;fixtureIds:readonly string[]};
type TemporaryControlSessionController = {session:TemporaryControlView|null;controlsLocked:boolean;error:string|null;start(input:CreateTemporaryControlInput):Promise<void>;end(input:EndTemporaryControlInput):Promise<void>;refresh():Promise<void>};
function useTemporaryControlSession(options:TemporaryControlSessionOptions):TemporaryControlSessionController;
// TemporaryControlPanel.tsx의 공통 UI 소비 props; 신규 card/button 자체 구현 없음.
type TemporaryControlPanelProps = {controller:TemporaryControlSessionController;brightness:number;fixtureIds:readonly string[];compact:boolean;durationMinutes:number;onDurationChange:(value:number)=>void};
function TemporaryControlPanel(props:TemporaryControlPanelProps):JSX.Element;
type TemporaryControlHistoryProps = {session:TemporaryControlView;onClose:()=>void};
function TemporaryControlHistory(props:TemporaryControlHistoryProps):JSX.Element;
~~~
- [ ] **Step 1 / RED test:** UI미리보기→202→holding→releasing/recovery_pending/restored를서버증거로표시,권한/site/principal전환·unknown중복start0·baseline path불변과조명설정부분변경을검사한다.
~~~ts
it("counter_zero_is_not_restored_and_stale_mutation_is_discarded", async () => {
  await h.acceptTemporary({durationMinutes:120}); h.advancePastEndsAt();
  expect(h.viewState()).not.toBe("restored"); expect(h.startPosts()).toBe(1);
  await h.changePrincipalThenResolveOld(); expect(h.oldSessionVisible()).toBe(false);
  expect(h.permanentBaselinePosts()).toBe(0);
});
~~~
- [ ] **Step 2 / RED 실행:** pnpm --filter @led-control/web test src/features/control/useTemporaryControlSession.test.tsx src/features/control/TemporaryControlPanel.test.tsx src/features/control/TemporaryControlHistory.test.tsx src/features/control/ControlView.test.tsx src/features/control/ManualExecutionPanel.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx. 새mode/증거/no duplicate mount assertionFAIL. 기존Control5 knownfail은기준선으로구분하며삭제/skip하지않는다.
- [ ] **Step 3 / 최소 코드:** 새 API module/hook은 Task1 browser export의 DTO를 import한다. owner/server phase는 root에서 유지해 tab/More 전환으로 상태를 remount하지 않는다. 기존 영구 submit은 별도 경로다. PC350px/mobile4열+More에 기간/미리보기/종료를 연결하고 unknown/partial/복귀 미확인에는 locking과 안전 경고를 유지한다.
  기존 CommandHistoryPanel/RecentActivityTicker/DrawerDialog/openHistoricalCommand의 유일한 이력 node를 workspace footer 전체폭으로 이동한다. footer는 최신 기본/시간제 중 하나를 보여주는 ticker1개/전체보기1개이며 같은 DrawerDialog 안에 kind별 행/상세를 표시한다. 기존 영구 openHistoricalCommand를 재사용하고 임시 목록은 별도 endpoint/cursor를 유지해 Command로 cast하지 않는다. 새 통합 이력 endpoint/메뉴는 만들지 않는다. 저장 구역 SelectionChoices(kind=group)을 중앙 목록 선두로 옮겨 resolveControlSelection→onChange의 실제 map 강조를 재사용한다. 확인 필요 버튼/설명문만 제거하고 관측·재송신·권한/stale 보호는 유지한다.
- [ ] **Step 4 / GREEN·최소통합:** Step2 동일+pnpm --filter @led-control/web typecheck; pnpm --filter @led-control/web ui:check; pnpm --filter @led-control/web build 각 한 번. 새 scoped e2e는 fixture HTTP→실제 React 화면의 아래4개 named case를 실행한다. backend의 자기 PG와 Gateway 실제 file-store 테스트는 API/실행 지속성 증거, 브라우저는 배치/연결 증거이며 실장비 검증과 구분한다.
~~~bash
pnpm --filter @led-control/web exec playwright test e2e/bio-control-operations.spec.ts --project=chromium --workers=1
~~~
  cases=desktop_calendar_and_shared_add / mobile_320_more_preserves_map / mobile_390_partial_and_unknown / schedule_switch_save_cancel_focus.1349×1226/320×600/390×844에서 footer1 node·group2 target/강조·유지/만료 후 map canvas 동일·document overflow0·Dialog visible Switch/Space/Escape focus·event reset 보존을 assert한다. 권한 변경/stale 응답/partialMutation 복귀는 unit/API/Gateway에서 검증하고 브라우저 전체 suite는 실행하지 않는다. Task8/9 직접 변경 test만 최종 source에서 한 번 합쳐 실행하며 영향 없는 suite는 반복하지 않는다.
- [ ] **Step 5 / 소유 commit·마지막검토:** 전체 diff의 safety/schema/실경로·증거를 단일 read-only review로 확인한다. P1/P2 수리는 해당 test만 재실행하고 총괄이 두 기록을 갱신한다. 제품/docs 검증 commit 뒤 clean/기대 HEAD/기존 dirty 보존을 확인하고 승인 범위의 local merge를 판단한다. 전체 GREEN/HIL/운영 적용은 주장하지 않는다.
  총괄은 main의 현재 HEAD와 사용자 dirty를 다시 확인한다. main 감시 프로세스가 merge 직후 API를 자동 재기동하거나 미적용 schema를 읽는다면 운영 승인 없는 자동 반영을 피하기 위해 먼저 안전한 중지/반영 경계를 사용자와 합의한다. 이 경계가 확보된 뒤 `codex/mvp1-cloud-web`에서 `git merge --no-ff codex/bio-control-operations-20261014`를 사용한다. 겹치는 상태 문서는 양쪽 이력을 보존하며 충돌 소스가 생기면 해당 변경·최소 관련 검증을 다시 수행한다. merge 후 실제 반영 diff와 보호 파일을 대조하고 변경 관련 smoke만 실행한다. DB migration·Pi 배포·provider 키 설정은 merge 명령에 묶지 않는다.
~~~bash
git add apps/web/src/api/temporary-controls.ts apps/web/src/features/control/useTemporaryControlSession.ts apps/web/src/features/control/useTemporaryControlSession.test.tsx apps/web/src/features/control/TemporaryControlPanel.tsx apps/web/src/features/control/TemporaryControlPanel.test.tsx apps/web/src/features/control/TemporaryControlHistory.tsx apps/web/src/features/control/TemporaryControlHistory.test.tsx apps/web/src/features/control/ControlView.tsx apps/web/src/features/control/ControlView.test.tsx apps/web/src/features/control/ManualExecutionPanel.tsx apps/web/src/features/control/ManualExecutionPanel.test.tsx apps/web/src/features/control/CommandHistoryPanel.tsx apps/web/src/features/control/CommandHistoryPanel.test.tsx apps/web/src/features/control/manual-workspace/ManualAuxiliaryPanel.tsx apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx apps/web/src/features/control/target-selection/SpatialTargetSelector.test.tsx apps/web/e2e/bio-control-operations.spec.ts docs/menus/control.md
git commit -m "feat(web): connect persistent BIO temporary control workflows"
~~~

## 실행 전달·문서 검토 결과

- 총괄이 Tasks1–7의 exact commit/contract schema/DTO/export/ACK/lease 안전·변경 test 결과를 검토해 전달하기 전에는 기존 사용자 thread ‘제어 UI 개선 담당자’ 01a0f776-b930-7eb2-a121-e05bef4d1581에 제품 구현을 보내지 않는다. 해당 담당자의 읽기 전용 계획 확인은 제품 구현 전달과 구분한다.
- backend→engine/Gateway는 같은 공유 파일 writer를 교대하고 Task5의 engine→API adapter도 내부 순차 진행한다. Web 담당에게 Tasks8–9를 함께 전달해도 header/calendar→session commit 순서를 지킨다. 다른 ‘제어 페이지 담당자’에게 UI를 중복 배정하지 않는다.
- 이 계획의 새 wire/type/표/lease counter/topic은 계획용 공유 계약이다. 총괄은 작성 담당자의 제안과 승인 spec의 안전 의미·type 귀속을 대조했다. Task1 구현 담당자는 이 인터페이스를 strict schema로 검증하고 후속 소비자에게 검증 commit을 전달한다. spec의 안전 의미를 축소하거나 제품 선택을 추가하면 구현 전에 총괄에게 보고한다.
- named type은 Task1, 메서드 signature는 각 Consumes/Produces가 정본이다. 미지 식별자/즉시 TTL 복귀 보장/실제 provider 성공·운영 migration·Pi 적용을 test fixture로 대신하지 않는다.
- 총괄 self-review 완료: spec§1–3→Tasks8/9, §4–5→Tasks2/4/6/7, §6→Tasks1/2/4/5, §7→Tasks1/3/5/7, §8→Tasks1/2/4/7, §9–10→위 전달/Global Constraints. 단계별 파일·검증 명령, named type/메서드의 생산·소비 일치, Review Focus5개와 해당 task assertion, 계획 분량을 직접 확인했다. 발견한 자동 만료 세대·redaction 재시도·복귀 확인 분리·V3 exact ACK·누락 signature를 보완했다. 아직 어떤 제품 테스트나 실제 wire도 통과했다고 주장하지 않는다.
- 계획 작성 단계는 문서 diffcheck·existing path/package command만 검증하고 `bd943bf6`으로 커밋했다. 사용자의 후속 진행 승인으로 software 구현을 시작한다. 당시 제품/설치/test/build/provider/DB/장비 미실행 기록은 구현 완료 증거와 구분한다. 운영 승인 경계는 그대로 유지한다.
