# BIO 전용 시간제 제어·스케줄 달력 설계

작성일: 2026-10-14 · 상태: 사용자 서면 설계 승인 완료 / 실행 계획 사용자 검토 대기 / 제품 미구현
브랜치: `codex/bio-control-operations-20261014`
기준: `833121fbdf309e86987d6c6c60652ed83993abef`

## 1. 승인 단계와 목표

최초 사용자의 ‘오케이’는 BIO-only 구조를 서면 설계로 정리하는 승인이었다.
이후 사용자가 서면 설계 커밋 `91bf922e`를 승인했다. 현재 [상세 실행 계획](../plans/2026-10-14-bio-control-operations.md)의 사용자 검토를 기다리며 제품은 미구현이다.
실행 방식은 총괄 오케스트레이터→backend 공유 계약→engine/Gateway→기존 UI 담당 순차 협업으로 지정됐다. 계획 검토 승인 뒤 제품 코드를 시작한다.
API·DB·MQTT의 아래 안전 의미는 승인된 설계이며 상세 wire/type 초안은 실행 계획에서 제안하고 총괄·소유 역할이 일치 검토한다.
검증 후 로컬 소프트웨어 병합은 승인 방향이지만 이번 단계는 문서만 작성한다.
운영 DB migration, Pi 배포, HIL, PKI, 서버/장비 재시작, 원격 작업은 별도 승인이다.

목표는 BIO 조명의 지정 밝기를 일정 시간 유지하고 종료 시 최신 유효 자동 운전으로 안전하게 복귀시키는 것이다.
달력은 기존 일정의 대체 보기이며 휴무 운영 시스템을 새로 만들지 않는다.
앞으로 본서비스 신규 기능의 지원 대상은 BIO 센서 조명만이다. 시간제와 새 스케줄 제외 기능도 BIO 대상에 한정한다.
이미 등록된 native/다른 장치 데이터·설정·기존 코드·제어 경로를 자동 삭제/변환하지 않는다.
기존 일정의 두 제외 값은 기본false로 기존 동작을 보존하며, 미지원 장치/날짜를 false로 조용히 치환하지 않는다.
제조사 펌웨어 변경이 필수라는 근거는 현재 없고 자체 ESP32 신규 코드·대량 처리 최적화는 제외한다.

## 2. 정본과 현재 코드의 차이

UI 정본은 저장소 밖 `/Users/kim-jh/Documents/led 조명 관제 서비스/preview/lighting-operations-real-ui/README.md`의12개 확정 코멘트와 최신 ‘추가 위치 통일’ 합의다.
목업의 메모리 복귀·공휴일6날짜·브라우저 테스트를 제품/실장비 검증으로 승격하지 않는다.
목업의 과거 밝기 복원 예시는 제품에서 최신 승인 설정·유효 스케줄·센서 상태 재평가로 대체해야 한다.

| 현재 소스에서 확인한 경계 | 설계 결정 |
| --- | --- |
| `packages/shared/src/dimming-command.ts`: legacy overrideUntil strip | 영구 밝기 API에 TTL을 붙여 시간제라고 부르지 않음 |
| `apps/api/src/commands/commands.service.ts`: ManualOverride overrideUntil=null | 독립 TemporaryControlSession·전달·결과 계약 필요 |
| `apps/gateway/src/automation/schedule-runtime.ts`: 영구 성공 baseline/retire 연결 | 시간제는 baseline 승격·retireManualTargets·영구 suppression 금지 |
| `apps/gateway/src/bio/bio-dongle-client.ts`: setOutput/restoreConfiguration/독립 GET | 기존 정확한 신원·설정 readback 재사용, outer ACK만으로 성공 금지 |
| `packages/automation-engine/src/recurrence.ts`: 날짜/반복 계약 | 달력·next·overlap·실제 실행이 동일 evaluator/dataset 사용 |
| `packages/shared/src/automation-contracts.ts`: V2/maxSnapshotVersion guard | V3는 SQL/자격/ACK/소비 guard를 함께 업그레이드 |

## 3. 유지·조정·추가할 UI

실제 CustomerShell, ControlView, 지도 renderer/canvas/camera,4탭과 공통 UI를 유지한다.
새 셸·지도·메뉴를 만들거나 확정한 위치 외 다른 UI를 재설계하지 않는다.

### 수동 제어

- 기존 기본 밝기 변경은 기존 영구 제어 흐름으로 유지한다.
- 같은 ManualExecutionPanel에 기본/시간제 선택,15/30/60/120분 preset, 정수1~1440분 입력을 제공한다.
- PC는 실제350px 실행 패널 안에 기간·실행 전 예상 종료를 표시하고 내부 스크롤로 적용 버튼에 접근한다.
- 모바일 기존4열 실행행을 유지하고 기간/종료/관측 상세는 기존 More 보조 패널에 둔다.
- 닫힌 상태는 한 줄 대상/기간 또는 유지·안전 경고만 남겨 지도 높이를 유지한다.
- 대상·밝기·기간 미리보기→접수→조명별 적용 확인→확정 종료→자동 운전 복귀 확인을 구분한다.
- 일반 스케줄·센서 보류 설명문은 제거하지만 내부 보류/안전 차단 자체는 유지한다.
- 수동 이력은 workspace 최하단 전체폭 한 줄 최신/empty+전체 보기이며 기존 상세 Dialog를 재사용한다.
- 저장 구역 옵션은 중앙 대상 목록에서 먼저 보인다. 실제 클릭→멤버 선택→지도 강조→실행 대상 연결을 유지한다.
- 업무별 모드/불러오기·확인 필요한 명령 버튼은 제거한다. 내부 권한·불확정 잠금·관측·복구 안전 보호는 유지한다.

### 스케줄·이벤트 공통 상단행

- 스케줄 왼쪽은 목록/달력, 오른쪽은 스케줄 추가 한 개로 두 보기 모두 위치가 같다.
- 이벤트도 같은 상단행 오른쪽에 기존 이벤트 추가 한 개를 둔다. 필터행에 추가를 중복하지 않는다.
- 검색/필터/페이지네이션은 목록 전용 별도행이다. 달력 결과를 목록 필터의 일부 페이지와 혼동시키지 않는다.
- 스케줄 필터 초기화만 제거하며 필터 자체와 이벤트 필터 초기화는 유지한다.
- 구역 CRUD/동기화·이벤트/BIO 기능·명시적 활성화 보호는 그대로 접근 가능하다.

### 달력·일정 편집

- 이름은 달력이다. 휴무/특별근무/운영 예외/opt-in/관련 설명·배지는 제거한다.
- 목록의 추가/수정/활성/삭제와 달력은 같은 서버 일정 revision을 소비한다.
- 띠는 실제 실행 시작 날짜의 연속 구간이며 주 경계와 제외 빈 날짜에서 분할한다.
- 이름·반복·시각/야간+1일을 표시해24시간 연속 점등과 구분한다. 띠 클릭은 원본 ScheduleDialog 수정이다.
- 시간 입력 아래 실제 공통 Switch 주말 제외/휴일 제외를 둔다. 두 DB 값은 NOT NULL DEFAULT false다.
- Dialog별 local draft는 저장할 때만 반영한다. 취소/Escape 미반영·재열기 저장값·신규 draft 격리를 지킨다.
- 제외는 그 일정의 발생만 제거한다. 전체 소등·센서 중단이 아니다. 새 제외 기능을 미지원/non-BIO 대상으로 저장하지 않는다.

320×600/390×844는 map-first·전체/가로 overflow 없음·동일 map/canvas identity를 기준으로 한다.
달력은 viewport 안의 내부 스크롤과44px 띠 영역을 확보한다.
Dialog 내부만 스크롤하며 숨김 Switch input이 아닌 visible label 전체까지 포커스 노출한다.
Escape/opener focus 복귀·권한 변경 시 이전 mutation 폐기 보호를 유지한다.

## 4. BIO 시간제 소유권과 실행

서버 TemporaryControlSession은 요청/종료 시각/대상 snapshot/감사 정본을 소유한다.
Gateway durable 상태는 조명별 임시 lease와 apply/release 실행·관측 결과를 소유한다.
활성 또는 unresolved lease는 조명별 하나다. 새 요청으로 덮거나 TTL을 연장하지 않는다.
기본 밝기·자동 SET도 같은 lease와 충돌하면 기존 안전 경계로 거절/보류한다.

1. 시작 transaction에서 현재 site control, 대상 귀속/BIO 자격, 단일 Gateway, unique1~1000대, 빈 대상/불확정 충돌을 재검증한다.
2. group/floor는 당시 fixture snapshot으로 고정하며 이후 구역 편집이 실행 중 대상을 바꾸지 않는다.
3. active BIO source 자체의 수동 선택은 현행 보호대로 거절한다. source force mode가 다른 target에 미치는 영향을 우회하지 않는다.
4. 정상 센서 설정·신원·assignment/revision/apply-generation을 durable 확보한 뒤 조명별 lease를 잡는다.
5. 실제 RF 직전 lease/generation·정확한 UUID/address/귀속·자격/시각을 다시 검사한다.
6. 기존 setOutput으로0~100%를 적용하고 정확한 readback으로 조명별 결과를 기록한다.
7. 유지 중 스케줄/센서 증거·정책/신선도는 계속 갱신한다. 선택 target의 SET/이전 activation restore만 보류한다.
8. 종료/만료는 release intent를 durable 기록한 뒤 최신 유효 자동 운전을 계산하고 설정/출력을 적용·확인한다.

정상 센서 설정·activation 귀속/preState·apply/release 결과를 보존한다.
시간제는 retireManualTargets, baseline 승격, 영구 suppression, 영구 preState 삭제를 호출하지 않는다.
임시 전 상태는 복구 증거이지 무조건 되돌릴 최종 출력 값이 아니다.
misconfigured/unknown·capability 부재·신원 불일치는 fail-closed이며 일부 실패를 다른 성공으로 가리지 않는다.
BIO setOutput의 high brightness→mode는 비원자적 두 쓰기다. 최종 출력 실패/mismatch여도 앞선 설정 쓰기가 남을 수 있다.
대상 결과는 applyConfirmed와 configurationMayHaveChanged/검증된 partialMutation을 별도로 기록한다.
최종 적용 실패를 RF0/설정 불변으로 간주하거나 부분 설정 변경의 복귀를 누락하지 않는다.

### 종료 시 자동 운전 재평가

종료 시 최신 승인 snapshot의 현재 유효 BIO 이벤트/센서·스케줄·기본 설정을 기존 승인된 자동 우선순위로 재평가한다.
현재 원장·신원·건강·신선도를 검증한 뒤 자동 목표를 선택하며 스케줄 우선/센서 fallback이라는 새 우선순위를 만들지 않는다.
restoreConfiguration의 high brightness+mode 독립 GET으로 복귀 설정을 확인한다.
현재 승인된 정상 mode는 sensor/force-on/force-off일 수 있다. 자동 운전 복귀를 무조건 sensor mode로 단정하지 않는다.
센서 mode 확인은 설정 확인이지 광출력/차량 존재 확인이 아니다.
현재 건강·신원·fresh event/activation만 평가하며 이전/중간의 오래된 pulse를 재생하지 않는다.
종료 시 still-valid current activation은 기존 정책으로 평가하지만 보류된 pulse를 새 발생처럼 재실행하지 않는다.
종료 중 새 revision은 RF 직전 최신 generation으로 재계산한다. 오래된 release가 새 세션을 해제하지 못한다.
안전한 최신 설정을 정할 수 없으면 과거 밝기/임의 OFF 대신 recovery_pending으로 남긴다.

## 5. 상태·장애·시간 계약

| 제안 상태 | 의미/표시 |
| --- | --- |
| pending / applying | 접수/적용 중, 아직 유지 성공 아님 |
| holding | 모든 대상 적용 확인·지정 밝기 유지·서버 종료 시각 |
| partial | 일부 확인, 조명별 성공/실패/unknown 표시 |
| unknown | 적용 여부 불확정·새 겹친 제어 안전 잠금 |
| releasing | 종료 intent 접수·복귀 확인 중 |
| restored | 필요한 대상의 최신 자동 운전 복귀 readback 확인 |
| recovery_pending | 복귀 실패/미확인·lease 보류·재관측 필요 |
| rejected / cancelled | RF 전 거절/release-before-start, 미적용 근거 필요 |

partial 종료는 applyConfirmed 대상뿐 아니라 검증된 partialMutation/configurationMayHaveChanged 대상도 정확한 GET으로 확인해 안전 복귀한다.
RF0/unchanged가 확정된 대상만 복귀 불필요로 처리한다. 아직 unknown인 대상은 lease를 보류하고 정확한 관측 뒤 최신 자동 목표로 복귀한다.
오프라인/복귀 실패/ENOSPC는 복귀 완료가 아니다. 상태 저장 실패 시 새 RF를 하지 않는다.
release-before-start는 session/generation tombstone으로 지연 start를 막는다.
late ACK는 exact session/target/assignment/revision/apply-generation에만 귀속한다.
종료 세션 ACK가 새 세션을 유지/해제하거나 baseline을 바꾸지 못한다.

서버 시작 transaction의 UTC instant가 startedAt/endsAt 권위이며 endsAt=startedAt+durationMinutes×60,000ms다.
제어 유지 기간과 전달 명령 TTL/expiry는 다르다. 전달 대기·재전송·중복·재접속은 원래 절대 종료 시각을 늘리지 않는다.
start의 RF 전 endsAt가 지났으면 적용하지 않는다. start 전달 expiry도 절대 endsAt를 넘지 않는다.
end/복구는 만료 이후에도 필요하므로 별도 bounded 전달 시도와 durable 재시도를 사용하며 유지 종료 시각 자체는 연장하지 않는다.
같은 부팅은 검증된 server 시각과 monotonic deadline, 재시작은 persisted 절대 endsAt를 사용한다.
시계 역행/신뢰 불명에서 deadline을 재설정하거나 새 적용하지 않고 기존 clock trust/복구 경계로 처리한다.
권한 취소는 새 사용자 쓰기를 막지만 이미 accepted된 세션의 안전 만료/복구를 중단하지 않는다.
Gateway down/전원 차단 중 장치 자체의 정확한 시각 복귀는 보장하지 않으며 복귀 미확인을 표시한다.
제조사 로컬 TTL을 검증하지 않았으므로 카운트다운을 실장비 복귀 보장으로 표현하지 않는다.

## 6. 제안 HTTP·DB 계약

route/필드·기본값·수명은 설계 제안이다. 상세 wire 식별자는 backend 검토 후 계획에서 고정하되 안전 의미는 축소하지 않는다.

| 제안 endpoint | 계약 |
| --- | --- |
| POST /sites/:siteId/temporary-controls | strict {clientRequestId,target,brightness,durationMinutes}; 기존 fixture/fixtures/group/floor target, resolve 후 단일GW/unique1~1000; 정수 밝기0~100/기간1~1440 |
| GET /sites/:siteId/temporary-controls/:sessionId | 상태·서버now/startedAt/endsAt·대상 snapshot·조명별 apply/release/관측·reason/generation; private,no-store |
| GET /sites/:siteId/temporary-controls | 상태 필터·opaque cursor 기본20/최대100; 같은 현장 stable 시간+id 정렬 |
| POST /sites/:siteId/temporary-controls/:sessionId/end | strict {clientRequestId}; 기간/대상 변경 없음, release intent 한 번·중복 종료 같은 정본 |
| GET /sites/:siteId/automation/schedules/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD | 현장 날짜 양끝 포함/최대42일/월 전체 주간 spill; 전체 발생일·시각·edit id·제외·snapshot/dataset revision·coverage |

모든 endpoint는 기존 SessionAuthGuard를 소비해 비로그인은401이다. 조회는 site read, 시작/종료는 transaction의 site control을 재검증한다.
현재 배정 admin/control membership viewer 의미를 재사용하며 역할명만으로 허용하지 않는다.
보이지 않는 site/id는404, 읽기만 가능한 쓰기는403, 잘못된 값/범위는400이다.
lease/불확정 충돌·호환 부족·coverage 미달은 명시적409 reason, 수신 불가 서비스는503이다. 영구 제어 fallback은 없다.
accepted start/end는202+정본 session이다. HTTP 접수와 장비 성공을 구분한다.
idempotency는 site+actor+operation+clientRequestId unique; 같은 fingerprint는 기존 결과, 다른 payload는409다.
unresolved 세션/lease/idempotency는 cache TTL이나 명령 상세 보관기간으로 삭제하지 않는다.
terminal 상세/감사는 기존 명령 상세의 UTC3개월 retention 정책을 재사용한다. start/end의 최소 idempotency fingerprint와 조명별 마지막 generation/tombstone은 별도 보존해 상세 정리가 재적용/구세대 수신을 허용하지 않는다.
기존 보존 ON/OFF 선택을 유지하고 OFF를 강제로 ON으로 바꾸지 않는다.

DB 제안: TemporaryControlSession, 조명별 대상/lease·결과, 전달 outbox/receipt, HolidayDataset/year coverage.
FK/site/gateway 귀속·활성 fixture single-owner unique·단조 generation·fingerprint/release intent를 원자 기록한다.
단조 generation은 재시작/상세 정리로 초기화하지 않는다. 최소 receipt/tombstone 제거·현장/장비 폐기는 별도 승인된 수명 관리로만 한다.
스케줄 boolean 두 개는 NOT NULL DEFAULT false로 기존 반복/설정/등록/정책을 보존한다.
운영 migration은 이번에 실행하지 않으며 후속 disposable PG로 default/보존/제약을 검증한다.

달력은 목록의 첫 cursor 페이지만 그리지 않는다.
서버는 bounded 범위 전체 authorized 일정의 완전 projection을 만들며 목록 검색/필터/페이지와 분리한다.
수량 경계상 분할 응답이면 같은 snapshot의 cursor를 끝까지 모은 뒤 완전 달력으로 표시한다.
부분 실패/중간 revision 변경은 incomplete/재조회이지 빈 달력이 아니다.
저장 후 목록/달력/next occurrence는 같은 새 revision으로 invalidate/재조회한다.

## 7. 공휴일 dataset과 실제 실행

제안 provider는 [한국천문연구원 특일 정보 공식 API](https://www.data.go.kr/data/15012690/openapi.do)다.
공공기관 공휴일 기준·안내상 무료/이용 제한 없음이지만 인증 ServiceKey는 필요하다.
키 추출/발급/provider 호출·설정은 이번 범위가 아니라 후속 승인된 설정 경계다.
목업6날짜를 제품 데이터로 사용하거나2026/2027만 영구 고정하지 않는다.

- 최초 당해+다음해 전체 연도를 갱신 대상으로 삼고 실제 지원 기간은 검증된 coverage뿐이다.
- 모든 월/페이지와 totalCount를 검증한다. totalCount0도 완전성을 입증한 정상 빈 월로 처리한다.
- 부분 응답·중복 페이지/일관성 오류·잘못된 날짜/isHoliday·범위 위반·tampered/hash 오류는 새 revision 승격 거절이다.
- 완료 dataset의 source/country=KR/year/date coverage/revision/fetchedAt/canonical hash를 서버 캐시/DB에 저장한다.
- 신뢰 provider의 완전 결과만 승격한다. hash는 변경 검출이지 외부 원문 서명 증거가 아니다.
- 하루 한 번 완전 dataset 단위로 갱신하고 실패하면 이전 완전 캐시의 동일 revision을 보존한다.
- 갱신 장애가 coverage 안 현재 운전을 즉시 정지시키지 않는다. fetchedAt/범위/실패를 공개해 신선도를 구분한다.
- 영원히 새 임시공휴일을 알 수 있다고 주장하지 않으며 데이터 없는 기간을 평일로 간주하지 않는다.
- Gateway는 동일 승인 dataset/hash/coverage를 durable snapshot으로 보관해 offline에도 같은 evaluator를 사용한다.
- 휴일 제외는 현장 Asia/Seoul만 지원한다. 타TZ 저장/활성화는 명시 거절, 주말 제외는 현장TZ 지원이다.
- coverage 미달 새 휴일 제외 저장/활성화는 거절한다. 이미 운전 중 불명확 발생일은 시작을 skip/차단 이유 기록한다.
- 기존 occurrence end/임시 release·복구는 계속 처리한다. 데이터 장애를 전체 소등/센서 중단으로 바꾸지 않는다.

automation-engine에서 후보 시작일의 제외를 적용하고 next/overlap/달력/실제 실행 모두 같은 결과를 사용한다.
activeFrom/Until는 현장 날짜 양끝 포함, weeklyMon1…Sun7, once는activeFrom 날짜다.
없는 월31일/윤일은 skip, 제외 once는 다음날 이월하지 않는다.
야간은 시작일 제외 여부로 결정하고 기존 종료는 다음날까지 처리한다. DST/Temporal 기존 계약을 재사용한다.

## 8. MQTT·V3 호환 제안

임시 start/end와 ACK는 기존 인증/outbox/assignment·command sequencing 경계의 별도 계약이다.
sessionId/target snapshot/assignmentVersion/approved revision/apply·release generation/endsAt/hash를 exact 귀속한다.
중복/순서 역전/late ACK/release-before-start는 durable receipt/terminal tombstone으로 방어한다.
publisher 성공은 장비 성공이 아니다. apply·release readback 결과를 서버가 정확히 확인한다.
V3 snapshot은 두 제외 flag/검증 holiday dataset을 전달하고 temporary capability는 durable lease/BIO readback 지원을 명시한다.
현재 schemaVersion===2/maxSnapshotVersion1|2/BIO authority guard와 SQL·자격·선언·exact ACK 보호를 함께 확장한다.
숫자만 올리거나 >=2로 느슨하게 허용하지 않는다. 알려진 V2/V3와 새 필수 capability를 명시 검사한다.
old V2 Gateway는 기존 기능을 유지하되 시간제/제외 기능이 필요한 새 요청은 거절한다.
true 제외 값을 V2 payload에서 빼고 실행시키는 silent downgrade는 금지한다.
공유 schema→Prisma/SQL→서버 자격·snapshot/ACK→engine/Gateway를 검증한 뒤 Web이 소비한다.
기존 V2 제어·센서 설정/원장/등록을 삭제하거나 자동 재발급하지 않는다.

## 9. 후속 소유 순서와 최소 검증

서면 승인→writing-plans→계획 검토/실행 방식 승인→backend 공유 계약·Prisma→engine/Gateway→Web→최소 QA→로컬 병합이다.
동일 파일/공유 계약 병렬 writer 금지; 총괄이 backend/reviewer/Gateway gate를 순차 배정한다.
Web은 기존 ‘제어 UI 개선 담당자’ 사용자 thread `01a0f776-b930-7eb2-a121-e05bef4d1581`가 소비한다.
센서 작업 중인 ‘제어 페이지 담당자’에게 UI를 중복 배정하지 않는다. GUI 구현/실행 안내는 후속 승인 단계에 전달한다.
이번 designer는3개 문서만 변경하고 제품 테스트/설치/빌드/커밋은 하지 않는다.

후속 검증은 아래 변경 경계에 한정하고 전체 suite/무관 리팩터링은 추가하지 않는다.

- 새 DTO/schema·권한/idempotency/site scope·1~1000대·충돌·구버전 거절.
- disposable PG migration/defaultfalse·기존 데이터 보존·lease unique/삭제→재생성 귀속.
- recurrence/next/overlap·TZ/once/31일/윤일/야간·42일spill·다중cursor 완전성·hole/주 분할.
- holiday 빈 정상월/부분/중복/coverage/hash·캐시 실패·offline 동일 projection.
- partial/unknown/restart/clock/ENOSPC/late generation/release-before-start·새 세션 해제 방지.
- BIO single-owner/active source 거절·정상 설정/원장 보존·RF 직전 신원·최신 승인 복귀·pulse 미재생.
- 기존 기본 영구 제어·안전 차단 불변, 권한 취소/stale mutation·취소/저장/재열기·focus.
- 실제 공통 UI의PC/320×600/390×844 추가 위치·하단 이력·지도 유지·달력/모달 내부 스크롤.

후속 구현은 `docs/menus/control.md`를 같은 작업에서 갱신한다.
모니터링/설정에 실제 영향이 생기면 해당 메뉴도 갱신하고 DB 변경은 `docs/database-schema.md`를 반드시 갱신한다.
이번에는 실제 기능/스키마 미구현이므로 해당 문서를 완료로 바꾸지 않는다.
이번 검증은 git diff --check와 문서/소스 실경로 확인뿐이다.

## 10. 잔여 승인 경계

BIO 장치 자체 TTL/전원 차단 복귀는 보장하지 않으며 software와 별도 승인 HIL을 구분한다.
ServiceKey 설정/실제 provider 연결·임시공휴일 신선도는 후속 운영 승인 대상이다.
exact wire 식별자/V3 SQL·선언 호환은 backend/Gateway 검토 후 계획에서 고정한다.
안전 조건이 바뀌면 총괄이 사용자에게 설계를 다시 제시하며 구현자가 임의 기능을 추가하지 않는다.
