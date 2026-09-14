# 수동 기본 밝기 제어 설계

## 목표

수동 제어의 개별·다중 조명 화면과 명령에서 `수동 override 종료 시각`을 제거한다. 성공한 수동 밝기는 조명별 기본 밝기로 영속화하고 즉시 출력한다. 수동 명령 당시 이미 활성인 스케줄·차량 이벤트 실행만 억제하며, 이후 새 스케줄 실행 또는 새 차량 이벤트가 발생하면 기존 `이벤트 > 스케줄` 우선순위로 자동 제어를 다시 적용한다.

## 확정된 사용자 동작

1. 수동 밝기 명령은 종료 시각 없이 전송한다.
2. 조명이 자동 제어 중이어도 수동 명령 성공 시 즉시 수동 밝기로 바뀐다.
3. 명령 성공 밝기는 해당 조명의 새로운 기본 밝기가 된다.
4. 수동 명령 시점에 활성인 스케줄 occurrence와 차량 이벤트 activation은 그 조명에 대해서만 억제한다.
5. 수동 명령 이후 시작한 스케줄 occurrence 또는 새로 감지된 차량 이벤트 activation은 자동 제어를 다시 시작한다.
6. 자동 제어가 끝나면 마지막으로 성공한 수동 기본 밝기로 돌아간다.
7. 다중 제어가 부분 성공하면 성공한 조명만 기본 밝기와 억제 상태를 변경한다. 실패·시간 초과 조명은 기존 기본 밝기와 자동 제어를 유지한다.
8. 배포 전에 존재하던 미만료 수동 override는 남은 시간을 폐기한다. 실제 적용이 확인된 밝기는 기본 밝기로 승격하고, 당시 활성인 자동 제어 실행은 기존 수동 출력이 갑자기 바뀌지 않도록 억제한다.

## 채택한 접근

Gateway를 조명별 기본 밝기와 자동화 실행 상태의 정본으로 유지한다. 서버는 명령·대상·사용자와 실행 결과 감사 이력을 유지하지만 기본 밝기를 별도의 cloud configuration으로 만들지 않는다. 따라서 cloud 단절 중에도 Gateway가 마지막 수동 기본값과 자동화 전환을 동일하게 계산할 수 있다.

기존 시간 기반 manual override를 무기한 override로 연장하지 않는다. 그러면 다음 자동 제어가 다시 시작될 수 없고 clock trust·만료 timer가 계속 남기 때문이다. 서버가 기본 밝기를 직접 소유하는 방식도 선택하지 않는다. 이 방식은 자동화 snapshot revision, 오프라인 충돌 해결과 양방향 동기화를 새로 정의해야 해 이번 요구보다 범위가 크다.

## Web UI와 요청 계약

`ControlView`에서 다음 항목을 제거한다.

- `overrideUntilLocal` state와 Site/user scope 변경 시 기본 1시간으로 초기화하는 effect
- `수동 override 종료 시각` `datetime-local` 입력과 안내 문구
- local datetime→ISO 변환 및 과거/30일 검증 함수
- 요청 payload의 `overrideUntil`

개별·다중·층·구역 대상 선택, 밝기 slider·preset, 실행 잠금, 응답 유실 복구와 명령 이력은 유지한다. 같은 `clientRequestId`로 복구하는 저장소 fingerprint는 `target + brightness`만 사용한다. 화면 높이를 늘리는 별도 고정 안내 영역은 추가하지 않고, 성공 상태 문구에서만 “적용된 밝기가 기본 밝기로 저장됨”을 알린다.

공유 입력의 새 canonical shape는 다음과 같다.

```ts
interface CreateDimmingCommandInput {
  siteId: string;
  clientRequestId: string;
  target: DimmingTarget;
  brightness: number;
}
```

이전 Web 또는 저장된 복구 요청이 `overrideUntil`을 보내는 혼합 버전을 위해 request compatibility parser는 올바른 ISO instant인 legacy 필드를 받을 수 있다. API 진입 시 이 값은 제거하고 새 동작으로 처리한다. 잘못된 legacy 값은 조용히 무시하지 않고 `400`으로 거부한다. canonical response와 Web type에는 `overrideUntil`을 포함하지 않는다.

## API와 데이터베이스

`CommandsService`는 사용자 종료 시각을 계산하지 않는다. 요청 fingerprint는 canonical target과 brightness만 해시한다. 기존 불확실 명령 중첩 차단, Site transaction 재인가, 대상 snapshot, delivery mode와 idempotency는 유지한다.

`ManualOverride`/`ManualOverrideFixture`는 기존 foreign key와 `AutomationExecution` 감사 연결을 깨지 않기 위해 이번 작업에서 이름을 바꾸지 않는다. 대신 다음 호환 migration을 추가한다.

- `ManualOverride.overrideUntil`을 nullable로 변경한다.
- 기존 시간 구간 CHECK를 `overrideUntil IS NULL`인 새 수동 기본 밝기 명령도 허용하도록 변경한다.
- 기존 `overrideUntil` 값과 행은 감사·혼합 버전 호환을 위해 그대로 보존한다.
- 새 명령 행은 `overrideUntil = NULL`로 생성한다.
- nullable 시간 index는 기존 이력 조회 호환을 위해 유지하며 새 동작의 실행 판단에는 사용하지 않는다.

`ManualOverride`라는 DB 이름과 telemetry의 `manual_override` source discriminator는 wire/history 호환 표식일 뿐, 새 명령이 시간 제한 override라는 의미로 사용하지 않는다. 이 한계는 `docs/database-schema.md`에 명시한다.

MQTT outbox draft는 새 명령에 `overrideUntil`을 넣지 않는다. broker delivery freshness는 기존 고정 delivery window만 사용하고 `overrideRemainingMs`를 만들지 않는다. 이미 저장된 old outbox와 구버전 API payload는 compatibility schema로 읽되 Gateway의 새 의미에서는 남은 override 시간을 적용하지 않는다.

## Gateway 영속 상태

Automation state를 schema version 6으로 올리고 다음 구조를 사용한다.

```ts
interface PendingManualControlState {
  sourceId: string;
  brightnessPercent: number;
  requestedAt: string;
  preBrightness: number;
}

interface ManualAutomationSuppressionState {
  sourceId: string;
  appliedAt: string;
  schedules: Array<{ scheduleId: string; occurrenceKey: string }>;
  vehicleEvents: Array<{ ruleId: string; startedAt: string }>;
}
```

V6 state는 기존 `baseBrightnessByFixture`를 조명별 영속 기본 밝기로 사용하고 다음 두 map을 추가한다.

- `pendingManualControls`: RF 실행 전 durable prepare와 재시작 handoff를 보호한다.
- `manualAutomationSuppressions`: 성공 시점에 활성인 자동 source instance의 정확한 identity만 기록한다.

수동 명령 prepare는 RF보다 먼저 pending state와 transition을 저장한다. pending fixture는 같은 수동 명령의 자동 재실행과 자동화 RF 경합을 막지만 기본 밝기를 아직 변경하지 않는다. 장비 terminal 결과가 `succeeded`일 때만 다음 작업을 한 번의 state update로 수행한다.

1. `currentByFixture`, `lastDesiredByFixture`, `baseBrightnessByFixture`를 실제 성공 밝기로 갱신한다.
2. 그 순간 활성인 schedule `(scheduleId, occurrenceKey)`와 vehicle `(ruleId, startedAt)` identity를 suppression에 snapshot한다.
3. pending manual entry를 제거하고 terminal transition과 telemetry handoff를 기록한다.

실패·시간 초과 결과는 pending entry만 제거하고 기본값과 suppression을 변경하지 않는다. 응답 유실 뒤 command journal 재생은 동일 `sourceId`의 prepare/handoff를 멱등하게 다시 적용한다.

## 자동화 재개 규칙

Desired-state 계산에서 현재 활성 source identity가 해당 조명의 suppression에 정확히 들어 있을 때만 후보에서 제외한다.

- 같은 schedule ID라도 `occurrenceKey`가 달라진 새 실행은 억제하지 않는다.
- 같은 vehicle rule이라도 Low/hold 종료 뒤 새 High로 `startedAt`이 달라진 activation은 억제하지 않는다.
- 수동 적용 이후 처음 생긴 억제되지 않은 자동 source부터 기존 `vehicle event > schedule` 우선순위를 적용한다.
- 억제된 source가 종료되거나 설정 변경으로 제거되면 그 identity를 정리한다.
- suppression에 남은 활성 identity가 하나도 없으면 조명 suppression record도 제거한다.
- 자동 source가 없으면 `baseBrightnessByFixture`를 삭제하지 않고 기본값으로 계속 사용한다.

새 자동 source가 끝난 뒤에도 오래된 억제 source가 아직 활성이라면 그 오래된 source를 다시 살리지 않고 기본 밝기로 복귀한다. 이후 새 occurrence/activation이 발생해야 자동 제어가 다시 시작된다.

## V5 상태 마이그레이션

V5 `manualOverrides`는 V6 restore에서 fixture별로 다음처럼 변환한다.

- terminal `succeeded`: `brightnessPercent`를 기본 밝기로 승격하고, restore 시점에 state 안에서 활성인 schedule occurrence와 vehicle activation identity를 suppression으로 기록한다.
- transition `pending`: `pendingManualControls`로 옮기고 command journal recovery가 실제 terminal 결과를 확정하게 한다. 기존 `overrideUntil`은 판단에 사용하지 않는다.
- terminal `failed|timed_out`: 기본값을 바꾸지 않고 제거한다.
- transition이 없거나 모순인 legacy entry: `currentByFixture` 또는 `lastDesiredByFixture`가 요청 밝기와 일치할 때만 적용 성공으로 간주한다. 그렇지 않으면 요청값을 기본 밝기로 추정하지 않고 제거한다.

마이그레이션은 원본 V5 파일을 덮어쓰기 전에 V6 parse/validation을 통과해야 한다. V6 파일을 쓰기 시작한 뒤 구버전 Gateway binary로 단독 rollback하면 읽을 수 없으므로 운영 rollout은 Gateway state backup을 먼저 만들고, rollback 시 이전 release와 그 backup을 함께 복원하는 절차를 따른다. 이번 작업은 운영 배포나 실제 backup/restore를 실행하지 않는다.

## Clock과 delivery 단순화

수동 기본 밝기는 wall clock 또는 monotonic expiry를 갖지 않는다. 다음 코드를 제거한다.

- manual override deadline map과 timer
- recovered-manual clock-trust 대기 상태
- `manual_override_expired`, `legacy_timing_unverifiable` 수동 경로
- override duration/remaining 검증

MQTT 전송·Gateway acceptance/RF 실행 deadline은 명령 freshness와 장치 I/O 안전을 위해 그대로 유지한다. 즉, “기본 밝기의 수명”은 무기한이지만 “오래된 명령을 뒤늦게 실행할 수 있는 시간”은 늘어나지 않는다.

## 배포 호환 순서

1. V5/V6 state와 old/new dimming wire를 모두 읽는 새 Gateway를 먼저 배포한다.
2. nullable migration을 적용하고 새 payload를 발행하는 API를 배포한다.
3. 종료 시각 UI가 제거된 Web을 배포한다.

순서를 어기면 새 API의 종료 시각 없는 명령을 구 Gateway가 처리하지 못할 수 있다. 이 작업에서는 사용자 DB migration, 운영 Gateway 배포와 Web 배포를 실행하지 않고 코드·migration·runbook만 준비한다.

## 테스트 계획

### Web

- 종료 시각 label/input이 개별·다중 제어에서 존재하지 않는다.
- POST payload와 응답 유실 복구 fingerprint에 `overrideUntil`이 없다.
- PC 고정 높이와 390/320px touch/overflow 계약이 유지된다.

### Shared/API

- canonical input/draft/published command에 `overrideUntil`과 `overrideRemainingMs`가 없다.
- legacy 요청은 유효한 ISO 값만 compatibility parser로 받고 canonical input에서 제거한다.
- command fingerprint, idempotent retry와 outbox payload가 target+brightness에만 결속된다.
- 새 `ManualOverride` 감사 행은 nullable expiry와 정확한 fixture snapshot을 갖는다.
- migration clean deploy와 기존 non-null 이력 upgrade를 검증한다.

### Gateway

- 수동 성공은 자동 source 유무와 관계없이 즉시 기본 밝기를 갱신한다.
- 당시 활성 schedule/event는 억제되고 같은 source의 새 occurrence/activation은 다시 적용된다.
- 자동 source 종료 뒤 수동 기본 밝기로 복귀한다.
- 다중 부분 실패는 성공 fixture만 바꾼다.
- restart와 command journal replay 뒤에도 기본값·suppression·pending 상태가 수렴한다.
- V5 성공/pending/실패/불명확 override migration을 각각 검증한다.
- clock-untrusted 상태에서도 새 수동 명령은 정상 처리하지만 broker/RF deadline은 유지한다.

### 통합 검증

기존 RealBackendLab의 `schedule 40% → event 80% → manual 60% → expiry 복귀` 흐름을 다음으로 교체한다.

1. 활성 schedule/event 중 manual 60%가 즉시 적용된다.
2. 현재 자동 source의 polling/recompute는 60%를 덮지 않는다.
3. 다음 schedule occurrence 또는 새 vehicle High가 자동 밝기를 적용한다.
4. 자동 source 종료 뒤 60% 기본 밝기로 돌아온다.

자동 테스트 결과는 software Gateway 증거로만 기록한다. Raspberry Pi, BlueZ/BIO USB, ESP32-H2, 실제 RF와 전원 차단 HIL은 별도 승인 전에는 실행하지 않는다.

## 문서 범위

- `docs/menus/control.md`: 종료 시각 제거, 새 기본 밝기와 자동 재개 동작, software/HIL 한계를 기록한다.
- `docs/database-schema.md`: nullable legacy-named `ManualOverride.overrideUntil`과 감사 목적을 기록한다.
- `docs/project-status.md`: 설계·구현·검증 상태를 활성 계획과 함께 갱신한다.
- 관련 frontend guide 또는 runbook에 종료 시각 입력·배포 순서가 있으면 같은 작업에서 갱신한다.

## 범위 제외

- 사용자가 별도로 기본 밝기를 조회·편집하는 설정 화면
- 조명별 기본 밝기의 cloud-side 동기화 API
- 자동 제어를 수동으로 다시 시작하는 별도 버튼
- 실제 사용자 DB migration 적용, 운영 배포, 실장비 flash/HIL
- 기존 명령 감사 테이블과 telemetry discriminator의 물리적 rename
