# 스케줄·차량 감지 이벤트 제어 설계

기준일: 2026-08-29

## 목적과 범위

제어 메뉴에 스케줄 제어와 차량 감지 이벤트 제어를 추가한다. 클라우드는 규칙 관리와 배포 상태의 정본이고 Raspberry Pi Gateway는 현장 실행의 정본이다. 인터넷이 끊겨도 마지막으로 승인된 규칙을 실행하며, ESP32-H2는 통합 센서의 감지 이벤트를 전달하고 기존 Light Lightness/PWM 경로로 밝기를 적용한다.

이번 범위에는 Web CRUD, NestJS API와 PostgreSQL, durable MQTT 동기화, Gateway 현장 규칙 엔진, ESP32-H2 센서 이벤트 계약과 software/HIL 검증 경계를 포함한다. 실제 센서의 GPIO polarity, 전압, UART/I2C 규격은 센서 하드웨어 계약이 확정된 뒤 driver binding으로 추가한다. 센서 입력 디바운스는 수행하지 않는다.

## 확정 결정

- 규칙 실행은 Gateway에서 수행하며 규칙 변경 때문에 Gateway를 재시작하지 않는다.
- 규칙 하나에는 시간 구간 하나만 둔다. 자정을 넘는 구간은 허용한다.
- 스케줄 반복은 1회, 매일, 매주, 매월, 매년을 지원한다.
- 겹치는 기간과 공통 대상 조명이 있는 활성 스케줄은 저장하지 않는다.
- 디밍 ON은 지정 밝기, 디밍 OFF는 100%를 의미한다. 완전 소등은 밝기 0%로 지정한다.
- 스케줄 종료 시 시작 직전 밝기로 복귀한다.
- 차량 감지는 한 규칙의 센서 중 하나만 감지해도 실행하며 추가 감지마다 유지시간을 연장한다.
- 여러 차량 이벤트가 같은 조명에서 겹치면 가장 높은 밝기를 적용한다.
- 차량 이벤트 종료 시 활성 스케줄로 복귀하고 활성 스케줄이 없으면 최초 이벤트 직전 밝기로 복귀한다.
- 실행 우선순위는 `만료되지 않은 수동 override > 차량 이벤트 > 활성 스케줄 > 현재 밝기 유지`다.
- 수동 override 종료 시각은 사용자가 선택하며 미선택 시 1시간으로 저장한다.
- 센서와 제어 대상은 현재 한 Gateway 안에 있어야 한다. 다중 Gateway fan-out은 별도 후속 범위다.

## 전체 아키텍처

### Cloud API

API는 스케줄과 이벤트 규칙, 정확한 대상 Fixture snapshot, Gateway별 `desiredRevision`과 `appliedRevision`, 감사 정보의 정본이다. CRUD transaction은 Site row를 잠그고 assigned active customer admin을 다시 인가한 뒤 규칙, 대상, revision과 durable outbox를 함께 commit한다.

Gateway에는 변경분이 아니라 해당 Gateway의 전체 automation snapshot을 전송한다. full snapshot은 장기간 offline, MQTT 중복·순서 변경과 누락 revision을 최신 revision 하나로 복구한다. UI 저장 성공과 Gateway 적용 완료는 구분하며 application ACK 전에는 `동기화 중`으로 표시한다.

### Gateway 현장 규칙 엔진

Gateway는 다음 책임을 가진다.

- 현장 IANA timezone 기준 스케줄 계산
- 차량 이벤트 유지시간과 중복 제거
- 수동 override, 차량 이벤트, 스케줄의 계층형 desired state 계산
- 기존 BLE Mesh unicast, 제한 병렬 unicast와 준비된 group 단일 전송 재사용
- 규칙, 실행 중 occurrence, 시작 직전 밝기와 이벤트 만료 시각의 영속 저장
- 실행·결과 이벤트의 durable outbox와 application ACK 재전달

규칙 snapshot을 한 번도 승인받지 못한 초기 상태에서는 자동제어를 실행하지 않는다. 인터넷이 끊기면 마지막 applied revision을 계속 사용한다.

### ESP32-H2

펌웨어는 `vehicle_sensor_driver` 경계에서 감지 callback만 받는다. 센서의 실제 전기·통신 규격은 이 경계의 driver가 소유하며 자동제어 규칙은 ESP32에 저장하지 않는다.

표준 Sensor Server는 현재 센서 상태 조회·표현에 사용한다. 순간 감지의 application 전달 보장을 위해 자사 Vendor Event 모델에 `bootId`, 증가하는 `sequence`와 event kind를 포함한다. Gateway ACK 전까지 제한된 시간과 횟수로 재전송하고 Gateway는 `(sourceUnicast, bootId, sequence)`로 한 번만 실행한다. 센서 입력 자체에는 디바운스를 추가하지 않는다.

## 무중단 규칙 적용

1. API가 증가한 revision, site/gateway 범위, timezone, 규칙과 대상 전체 set, payload hash를 MQTT QoS 1 outbox로 발행한다.
2. Gateway는 현재 규칙을 계속 실행하면서 새 snapshot을 schema, 범위, revision과 hash 기준으로 별도 검증한다.
3. 유효한 snapshot을 임시 파일 write, file fsync, rename, parent directory fsync 순으로 원자 저장한다.
4. 규칙 실행 queue에서 메모리 참조를 한 번 교체하고 현재 desired state를 다시 계산한다.
5. durable 저장과 메모리 전환이 모두 끝난 뒤 exact revision application ACK를 발행한다.
6. 어느 단계든 실패하면 기존 snapshot과 실행 상태를 유지하고 정제된 실패 사유만 보고한다.

hot reload는 Gateway process, MQTT, heartbeat, BLE Mesh와 센서 listener를 중단하지 않는다. 규칙 전환 순간 같은 대상에 대한 계산과 전송만 직렬화한다. 현재 출력이 새 desired state와 다를 때만 조명 명령을 전송한다.

## 스케줄 규칙

### 데이터

스케줄은 다음 필드를 가진다.

- 이름과 `enabled | disabled` 상태
- 적용 시작일과 종료일
- 현장 timezone의 시작 시각과 종료 시각
- `once | daily | weekly | monthly | yearly` 반복 유형
- 주간 반복의 요일 set, 월간 반복의 일, 연간 반복의 월·일
- `dimmingEnabled`와 `brightnessPercent(0~100)`
- 선택 방식과 무관하게 저장 시 확정한 Fixture ID 전체 set
- 소유 Gateway, desired/applied revision, 생성자·수정자와 시각

월간 29~31일이 존재하지 않는 달은 해당 회차를 건너뛴다. 매년 2월 29일은 윤년에만 실행한다. 자정을 넘는 구간은 종료일의 다음 날 구간으로 계산한다. 시간 계산은 현장 IANA timezone을 사용하고 DST의 중복 현지 시각은 occurrence 하나로, 존재하지 않는 현지 시각은 다음 유효 시각으로 실행한다.

### 충돌과 수명주기

활성 스케줄의 유효 날짜, recurrence와 자정 통과 구간을 비교해 실제 시간이 겹치고 대상 Fixture 교집합이 있으면 create, update와 enable을 `409 schedule_overlap`으로 거부한다. 같은 Site의 규칙 변경은 Site lock 아래 직렬화해 동시 요청도 같은 결과로 수렴한다. disabled 규칙은 충돌에서 제외하지만 enable 시 다시 검사한다.

층이나 구역으로 선택해도 규칙에는 당시 Fixture ID snapshot을 저장한다. 구성원 변경으로 신규 조명이 자동 제어되는 것을 막고, 사용자가 규칙을 수정해 대상 변경을 명시적으로 승인하게 한다.

Gateway는 occurrence 시작 직전 대상 밝기를 durable state에 보존한다. 종료, 비활성화 또는 삭제 후 더 높은 우선순위가 없으면 이 상태로 복귀한다. 재시작 후 현재 시각이 occurrence 안이면 같은 occurrence key를 이어가고 시작·복귀 명령을 중복 생성하지 않는다.

## 차량 감지 이벤트 규칙

이벤트 규칙은 다음 필드를 가진다.

- 이름과 `enabled | disabled` 상태
- 센서가 연결된 source Fixture 1개 이상
- 제어할 target Fixture 1개 이상
- `dimmingEnabled`와 `brightnessPercent(0~100)`
- 유지시간: 기본 60초, 허용 범위 5초~30분
- 소유 Gateway, desired/applied revision, 생성자·수정자와 시각

한 source라도 감지되면 규칙을 활성화하고 추가 감지마다 마지막 감지 시점부터 만료 시각을 다시 계산한다. 여러 활성 이벤트가 같은 target을 포함하면 최대 밝기를 적용한다. 디밍 OFF는 100%이므로 최대 밝기 계산에서 100%로 취급한다.

첫 이벤트가 시작될 때 활성 스케줄이 없다면 직전 밝기를 durable state에 저장한다. 마지막 이벤트가 끝나면 현재 활성 스케줄을 우선 적용하고, 없으면 저장한 직전 밝기로 복귀한다. 규칙 변경·삭제 시 현재 이벤트 source와 target을 새 snapshot으로 다시 계산하고 더 이상 유효하지 않은 이벤트 상태는 종료한다.

수동 override 중에도 감지 event와 만료 시각은 갱신하지만 조명을 덮어쓰지 않는다. override가 끝났을 때 이벤트가 아직 활성 상태면 즉시 이벤트 밝기를 적용한다.

## 수동 override 변경

기존 수동 명령에 사용자가 선택한 `overrideUntil`을 추가하고 미입력 시 서버가 현장 timezone 기준 현재 시각부터 1시간을 확정한다. Gateway는 override를 대상별 durable state로 저장한다. override가 끝나면 현재 이벤트, 스케줄 순서로 desired state를 재계산하며 자동 규칙이 없다면 마지막 수동 밝기를 유지한다.

수동 명령의 기존 동기 ACK와 fixture별 terminal 결과는 유지한다. viewer는 수동 override와 자동 규칙을 변경할 수 없다.

## MQTT와 실행 기록

Gateway-scoped MQTT v2에 다음 계약을 추가한다.

- cloud → Gateway: automation full snapshot
- Gateway → cloud: snapshot applied/rejected ACK
- Gateway → cloud: schedule/event lifecycle과 fixture별 action result
- cloud → Gateway: execution event ingested application ACK

Gateway는 `schedule_started`, `schedule_ended`, `vehicle_detected`, `event_started`, `event_extended`, `event_ended`, `action_result`를 durable/application-ACK 원칙으로 보존한다. 반복되는 `event_extended`는 같은 활성 이벤트의 최신 만료 시각으로 병합한다. API는 `eventId + sequence`로 멱등 처리하고 별도 `AutomationExecution` 원장에 저장한다. 실제 Lightness Status는 기존 fixture-state 경로를 사용하므로 모니터링과 전력 통계도 같은 상태를 반영한다.

## 화면과 권한

제어 페이지 상단은 `수동 제어`, `스케줄 제어`, `이벤트 제어` 탭으로 구성한다.

스케줄 목록은 이름, 활성 상태, 다음 실행, 시간·반복 요약, 밝기, 대상 수, Gateway 동기화와 최근 결과를 표시한다. dialog에서 달력 기간, 반복, 한 개 시간 구간, 행동과 기존 target picker를 설정한다.

이벤트 목록은 이름, 활성 상태, source 센서 수, target 수, 감지 밝기, 유지시간, Gateway 동기화와 최근 감지를 표시한다. dialog는 `감지 센서 선택 → 제어 조명 선택 → 행동·유지시간` 순서로 구성한다.

assigned admin은 자기 Site의 규칙을 추가·수정·삭제·활성화할 수 있다. viewer는 목록과 적용·실행 상태만 조회한다. operator는 고객 Site capability와 제어 UI를 갖지 않는다. 다른 Site의 ID는 존재 여부를 숨기는 기존 `404` 경계를 유지한다.

## 장애 처리

- Gateway system clock이 신뢰할 수 없으면 새 스케줄 경계 전환을 중단하고 기존 출력을 유지한다. 차량 이벤트 유지시간은 monotonic clock으로 계속 계산한다.
- snapshot 검증·저장·hot reload 실패는 기존 applied revision에 영향을 주지 않는다.
- Gateway offline 중 API 저장은 허용하지만 Web은 적용 완료로 표시하지 않는다.
- Cloud는 Gateway 대신 규칙을 실행하지 않아 reconnect 시 이중 실행을 방지한다.
- fixture 일부가 응답하지 않으면 성공 fixture 상태를 유지하고 조명별 timeout/실패를 실행 원장에 기록한다.
- 활성 스케줄은 상태 publication과 desired state를 주기적으로 비교하고 이탈한 fixture만 제한적으로 재적용한다.
- 실행 이력 저장공간이 상한에 도달해도 주차장 로컬 스케줄·차량 감지 제어는 계속한다. Gateway는 반복 연장 이벤트를 먼저 병합하고, 그래도 공간이 부족하면 유실된 실행 이력의 최초·최종 시각과 건수를 별도 `telemetry_gap` 메타데이터에 영속 기록해 재연결 후 API와 운영 화면에 보고한다. 이력 손실을 정상 동기화로 표시하지 않는다.
- ESP sensor event retry가 모두 실패하면 로컬 fault counter를 증가시키며 다음 감지를 막지 않는다.

## 데이터 모델 방향

- `AutomationConfiguration`: Site/Gateway별 desired/applied revision과 동기화 상태
- `LightingSchedule`, `LightingScheduleFixture`: recurrence, action과 대상 snapshot
- `VehicleEventRule`, `VehicleEventSource`, `VehicleEventTarget`: source, target, action과 hold duration
- `ManualOverride`: 대상, 밝기, 시작·종료와 source command
- `AutomationExecution`, `AutomationExecutionFixtureResult`: lifecycle 원장과 fixture별 결과
- `AutomationConfigOutbox`: Gateway full snapshot durable publish

실제 Prisma 필드와 migration을 작성할 때 `docs/database-schema.md`를 같은 커밋에서 갱신한다.

## 테스트와 완료 기준

### 자동 검증

- Web: 탭, CRUD, 달력·반복 입력, 대상 선택, overlap 오류, 동기화 상태와 viewer read-only
- API: tenant/role 경계, 월말·윤년·자정·DST, exact target snapshot, 동시 overlap, outbox와 application ACK
- Gateway: fake wall/monotonic clock, 무중단 hot reload, invalid snapshot rollback, 재시작 복구, 우선순위와 이벤트 중첩·복귀
- Firmware: sensor driver callback, boot/sequence, ACK·재전송과 ESP-IDF `esp32h2` build
- Software E2E: PostgreSQL, Redis, mTLS MQTT, production API/Gateway runtime과 Chromium CRUD·적용 상태

### 실제 장비 검증

- 센서 입력 1회가 BLE Mesh를 거쳐 정확히 한 이벤트 실행으로 수렴
- 추가 감지가 hold timer를 연장하고 마지막 만료 뒤 정확한 밝기로 복귀
- 규칙 CRUD 중 Gateway process, MQTT, heartbeat와 기존 조명 제어가 중단되지 않음
- Cloud 단절 중 스케줄과 이벤트 실행, 재연결 뒤 실행 원장 재전달
- Gateway와 ESP32-H2 재시작 뒤 규칙, occurrence와 중복 제거 상태 복구
- 두 센서 규칙과 겹치는 target에서 최대 밝기 및 마지막 이벤트 종료 복귀

센서 전기 인터페이스와 절연 회로가 승인되기 전에는 센서 포함 HIL을 실행하지 않는다. software simulator 결과는 실제 BLE Mesh 센서 전달 완료로 표시하지 않는다.

## 명시적 제외

- 다중 Gateway에 걸친 하나의 규칙과 최종 결과 집계
- 센서 신호 분석, 차량 방향·속도·대수 판정
- 장면, 인체 감지와 외부 BMS event source
- 규칙 우선순위 사용자 설정과 겹치는 스케줄 허용
- ESP32 노드 내부 Scheduler Server 기반 분산 규칙 실행
- 모바일 네이티브 화면

## 구현 선행 조건

현재 working tree의 Gateway/PKI 실장비 수정사항을 테스트하고 작업 단위별로 먼저 커밋한다. 그 뒤 shared 계약과 DB migration, API 규칙 관리·동기화, Gateway engine, firmware event, Web UI, software E2E, HIL 순서로 구현한다.
