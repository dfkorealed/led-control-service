# BIO 주기적 생존 상태 조회 및 10분 Polling 설계

기준일: 2026-09-14

## 목적

게이트웨이에 직접 연결된 바이오일렉트로닉스 USB-C 동글이 등록 완료된 센서통신모듈을 10분마다 능동적으로 조회하고, 제조사 앱 없이도 관제 서비스가 조명의 통신 가능 여부를 유지하도록 한다. 대시보드의 자동 갱신 주기도 10분으로 통일하고, 마지막으로 확인된 뒤 20분을 초과한 조명은 오프라인으로 판정한다.

BIO 센서 모드는 주변 센서 조건에 따라 조명이 스스로 변하므로, 동글의 설정 밝기 응답만으로 순간 출력 밝기나 전원 상태를 확정할 수 없다. 따라서 이번 변경은 `통신 생존 상태(presence)`와 `실제 출력 상태(state)`를 분리한다. 온라인 표시를 위해 거짓 밝기나 전원값을 생성하지 않는 것이 핵심 원칙이다.

## 확정된 운영 기준

- 게이트웨이 전체 장치 상태 재조회 간격: `600,000ms`(10분)
- 웹 모니터링 자동 갱신 간격: `600,000ms`(10분)
- 마지막 성공 응답 후 조명 stale 판정: `1,200초`(20분)
- 정확히 20분이 된 경계는 fresh이고, 20분을 초과한 시점부터 stale이다.
- 창이 다시 활성화되거나 모니터링 화면에 새로 진입하면 10분 타이머를 기다리지 않고 기존 React Query 동작대로 즉시 서버 상태를 조회한다.
- API의 짧은 freshness 판정 worker 간격은 외부 장치나 대시보드를 조회하는 polling이 아니다. 20분 경계를 지연 없이 반영하기 위한 내부 판정 주기이므로 기존 30초를 유지한다.
- 에너지 계산의 `KNOWN_STATE_WINDOW_MS=180,000`도 polling 주기가 아니다. presence는 실제 출력 밝기를 증명하지 않으므로 이 값을 20분으로 늘리지 않는다.

## 고려한 접근

### A. 별도 `fixture-presence` 이벤트 — 채택

BIO 조회 성공은 별도 MQTT 이벤트로 전달한다. API는 `lastSeenAt`, RSSI와 BIO 제어 모드·설정값만 갱신하고 기존 `brightness`, `powerOn`, 에너지 checkpoint는 변경하지 않는다. 센서 모드에서도 정확한 온라인 상태를 표현하면서 소비전력 데이터의 의미를 보존할 수 있다.

### B. 기존 `fixture-state`에 추정값 기록 — 제외

설정 밝기를 실제 밝기로, 센서 모드를 전원 ON으로 간주하면 기존 경로를 그대로 사용할 수 있다. 하지만 주변 환경에 의해 꺼져 있거나 부분 점등 중인 조명을 잘못 표시하고 에너지 통계까지 오염시키므로 사용하지 않는다.

### C. 검색 응답만으로 생존 처리 — 제외

scan 응답만 확인하면 wire traffic은 줄지만, 등록된 주소에서 상태 GET에 응답 가능한지 확인하지 못한다. 이번 polling은 UUID와 주소가 일치하는 장치의 밝기 설정 GET과 제어 모드 GET을 모두 성공한 경우에만 생존 성공으로 인정한다.

## 이벤트 계약

shared package에 `fixturePresenceV2Schema`와 `FixturePresenceV2`를 추가한다. topic은 다음과 같다.

```text
sites/{siteId}/gateways/{gatewayId}/state/fixture-presence
```

payload는 기존 `orderedGatewayEventSchema`의 `siteId`, `gatewayId`, `eventId`, `sequence`, `occurredAt`을 재사용하고 다음 필드를 갖는다.

- `fixtureId`: 등록된 조명 UUID
- `controlMode`: `sensor | force-off | force-on`
- `rawHighBrightness`: BIO high-brightness GET이 반환한 원시 1-byte 값
- `configuredBrightness`: APK에서 확인한 고정 변환표에 값이 존재할 때만 `0..100`, 대응값이 없으면 `null`
- `rssi`: 같은 polling pass의 정확한 UUID/address scan 응답 RSSI
- `hopCount`: BIO direct-USB 경로에는 Mesh hop 의미가 없으므로 항상 `null`

`occurredAt`은 두 GET이 모두 성공한 직후의 게이트웨이 시각이다. API의 실제 freshness 기준인 `lastSeenAt`은 기존 보안 원칙대로 API 수신 시각을 사용한다. 장치가 전송하지 않은 실제 밝기, 실제 전원, health fault는 presence payload에 넣지 않는다.

기존 `applicationStateIngestedAckV2`와 `state-ingested` ACK topic은 fixture-state와 fixture-presence가 함께 사용한다. ACK는 `eventId + sequence + fixtureId`를 식별하므로 새 ACK 종류를 만들 필요가 없다. Gateway durable state outbox는 두 payload의 union을 저장하며 각 record의 실제 topic을 함께 보존한다. 재시작·MQTT 단절 후에도 presence 이벤트가 application ACK를 받을 때까지 삭제되지 않는다.

## 게이트웨이 동작

### 10분 주기 실행

`BackgroundMeshResyncWorker`에 기본 `pollIntervalMs=600_000`의 완료 후 재실행 타이머를 추가한다. 프로세스 시작과 MQTT 재연결 직후의 즉시 resync는 유지한다. 주기 타이머는 한 pass가 끝난 시점부터 10분 뒤를 예약해 느린 USB 작업이 겹치지 않게 한다.

- 이미 resync가 실행 중이면 두 번째 작업을 병렬로 시작하지 않는다.
- 기존 명시적 `schedule(true)` 요청은 현재 pass가 끝난 뒤 한 번만 추가 실행한다.
- 일시 실패에 대한 기존 bounded exponential retry는 유지한다. retry 성공 후 다음 정규 polling은 성공 pass 완료 시점부터 10분 뒤다.
- shutdown에서는 정규 polling timer와 retry timer를 모두 해제하고 실행 중 AbortSignal을 취소한다.
- `pollIntervalMs`는 양의 safe integer만 허용해 0이나 잘못된 환경값으로 busy loop가 생기지 않게 한다.

### BIO 전체 resync

`BioUsbDongleAdapter.resyncFixtureStates()`는 다음 순서로 동작한다.

1. mapping journal에서 `confirmed` row만 읽는다.
2. 한 번의 serial discovery scan으로 현재 BIO 장치 목록을 갱신한다.
3. 각 mapping마다 `deviceUuid`, `nativeUuid`, `logicalAddress`가 모두 일치하는 scan 결과만 선택한다.
4. 검증된 `BioVerifiedLampTarget`에 high-brightness GET을 전송한다.
5. 같은 target에 control-mode GET을 전송한다.
6. 두 응답의 UUID/address correlation이 모두 검증되면 presence listener에 관측값을 전달한다.
7. 장치별 성공·실패를 집계해 기존 `BleMeshResyncReport`의 `observed`, `failed`, `timedOut`으로 반환한다.

BIO USB transport는 한 번에 하나의 request만 correlation할 수 있으므로 polling GET도 직렬 실행한다. 한 조명 실패가 뒤 조명의 조회를 막지 않으며, AbortSignal이 취소되면 새 장치 조회를 시작하지 않는다. 장치의 `rawHighBrightness`가 앱에서 확인한 변환표 밖이어도 정상 response 자체는 생존 증거이므로 `configuredBrightness=null`로 게시한다.

`resyncLightingFixtures()`는 기존 실제 출력 관측 계약을 유지한다. `force-off`는 `powerOn=false, brightness=0`, `force-on`은 변환 가능한 설정 밝기와 함께 실제 lighting observation으로 만들 수 있지만, `sensor`는 실제 출력이 불명확하므로 lighting observation을 만들지 않는다. 대신 성공한 GET은 presence 이벤트로만 게시한다.

### 이벤트 발행

adapter에 `onFixturePresence()` listener를 추가한다. Gateway index는 fixture-state와 같은 capacity reservation 및 durable outbox를 통해 presence를 enqueue한다. listener 예외나 MQTT 단절은 USB polling 자체의 장치 관측 결과를 바꾸지 않으며, outbox capacity가 없으면 intake를 중단하고 ACK로 공간이 회복된 뒤 full resync를 다시 예약한다.

## API 수신과 DB 반영

API MQTT runtime은 새 presence topic을 QoS 1로 구독한다. 수신 시 topic의 site/gateway scope와 payload scope가 정확히 일치해야 하며, event identity와 canonical payload hash가 다르면 연결을 닫아 broker redelivery 원칙을 유지한다.

presence ingestion은 해당 Gateway와 Fixture를 transaction 안에서 잠그고 다음만 변경한다.

- `lastSeenAt = API 수신 시각`
- `rssi`, `hopCount`
- `bioControlMode`, `bioConfiguredBrightness`, `bioRawHighBrightness`
- presence 전용 마지막 event id/sequence/occurredAt checkpoint
- 현재 persisted `statusReason`이 freshness가 만든 `fixture_stale` 또는 `gateway_offline`이면, 잠근 Gateway heartbeat가 fresh인 경우에만 persisted `status/statusReason`을 기존 `reportedStatus/reportedStatusReason`으로 복원

기존 `brightness`, `powerOn`, `firstStateOccurredAt`, 에너지 checkpoint와 일·시간 에너지 집계는 변경하지 않는다. presence가 장치 fault 해소나 이전 command 성공을 증명하지 않으므로 `reportedStatus`와 `reportedStatusReason`도 덮어쓰지 않는다. freshness 때문에 만들어진 offline 상태만 위 규칙으로 복원하므로, `command_failed`, 실제 fault, `provisioning_waiting_state`를 단순 생존 응답으로 지우지 않는다. 이 복원은 표시뿐 아니라 명령 전 안전 검사도 같은 20분 freshness를 사용하게 한다.

중복 event는 idempotent ACK하고, 같은 event identity의 다른 payload, sequence 역행, occurrence 역행, 지나치게 미래인 timestamp는 기존 fixture-state 수준으로 거부한다. 거부된 이벤트는 `lastSeenAt`을 연장하지 않는다.

Fixture 테이블에는 다음 nullable 열을 추가한다.

- `bioControlMode`
- `bioConfiguredBrightness`
- `bioRawHighBrightness`
- `lastPresenceEventId`
- `lastPresenceSequence`
- `lastPresenceOccurredAt`

DB check constraint는 `bioControlMode`를 `sensor | force-off | force-on`으로, `bioConfiguredBrightness`를 `0..100`으로, `bioRawHighBrightness`를 `0..255`로 제한한다. presence checkpoint의 event id/sequence/occurredAt은 모두 null이거나 모두 채워진 상태만 허용해 부분 저장을 막는다.

마이그레이션은 Site의 `fixtureStaleAfterSeconds` 기본값을 `1200`으로 변경하고, 이전 기본값 `180`을 그대로 사용 중인 기존 Site를 `1200`으로 갱신한다. 사용자가 별도로 설정한 다른 값은 보존한다. 허용 범위 `60..3600`은 유지한다.

운영 제어 안전성에서 사용하던 고정 180초 fixture freshness도 1200초로 변경한다. identify, 제어 가능 여부, stale sweep이 같은 shared 상수를 사용하게 해 숫자 중복으로 다시 어긋나지 않도록 한다. Gateway heartbeat 90초 기준은 장치 polling과 무관하므로 유지한다.

## 웹 동작

`MONITORING_REFRESH_INTERVAL_MS`를 `600_000`으로 변경한다. dashboard, floor fixture 목록, floor map snapshot 등 기존 monitoring query policy를 공유하는 화면에 동일하게 적용한다.

사용자가 제어를 실행한 뒤의 명시적 query invalidation과 화면 focus 복귀 refetch는 그대로 유지한다. 따라서 제어 직후 UI 반영이나 화면 재진입까지 무조건 10분을 기다리게 만들지 않는다.

API 응답에는 BIO의 마지막 `controlMode`와 설정 밝기를 nullable metadata로 제공한다. 1차 UI에서는 온라인/오프라인 판정에 사용하고, 실제 출력 밝기와 혼동될 수 있으므로 설정 밝기를 기존 밝기 게이지에 표시하지 않는다. 추후 별도의 “센서 설정” UI가 생길 때 이 필드를 사용할 수 있다.

## 오류 처리와 관측성

- exact UUID/address를 찾지 못하면 `BIO_DEVICE_NOT_FOUND`로 해당 fixture만 실패 처리한다.
- brightness GET timeout과 mode GET timeout은 장치별 timeout으로 집계하고 presence를 게시하지 않는다.
- 한 GET만 성공한 부분 관측은 온라인 성공으로 처리하지 않는다.
- polling 자체는 쓰기 opcode를 사용하지 않으며 주소·밝기·제어 모드를 변경하지 않는다.
- 기본 로그에는 native UUID, 전체 패킷, 현장 식별자를 출력하지 않는다. 집계 로그에는 total/observed/timedOut/failed만 남긴다.
- 10분 polling 사이에 즉시 장애를 알아내지는 못한다. 승인된 정책상 최대 20분 동안 마지막 성공 상태를 유지할 수 있음을 모니터링 문서에 명시한다.

## 테스트 전략

### shared

- presence schema가 정상 sensor/force mode payload를 허용한다.
- 실제 출력 `brightness`와 `powerOn`을 presence에 넣으면 strict schema가 거부한다.
- MQTT topic builder가 site/gateway scoped presence topic을 만든다.

### Gateway

- background worker가 시작 직후 실행되고 성공 pass 완료 10분 뒤 다시 실행한다.
- 실행이 10분보다 길어도 resync가 겹치지 않는다.
- retry와 정규 timer가 중복 pass를 만들지 않고 shutdown 시 모두 정리된다.
- BIO resync가 confirmed mapping만 대상으로 scan → brightness GET → mode GET 순서를 지킨다.
- 두 GET이 성공하면 presence를 한 번 발행하고 sensor 모드에서는 lighting observation을 만들지 않는다.
- UUID/address 불일치, 부분 응답, timeout은 presence를 발행하지 않으며 다른 fixture 조회는 계속한다.
- outbox 재시작과 ACK가 fixture-state와 fixture-presence를 각각 올바른 topic으로 복원·삭제한다.

### API

- presence 수신은 `lastSeenAt`과 BIO metadata만 갱신하고 brightness/power/energy checkpoint를 보존한다.
- 중복 presence는 한 번만 반영하며 ACK는 반복 가능하다.
- scope 위조, altered replay, 역행 sequence/time은 상태와 `lastSeenAt`을 변경하지 않는다.
- 기존 기본 Site는 stale threshold 1200초가 되고 사용자 지정 Site는 유지된다.
- 정확히 1200초 경계는 제어 가능하며 1ms 초과부터 stale/offline이다.

### Web 및 회귀

- monitoring query policy가 600,000ms 자동 갱신과 focus refetch를 함께 유지한다.
- BIO metadata가 실제 밝기 게이지 값을 덮어쓰지 않는다.
- 기존 BlueZ fixture-state ingestion, 명령 직후 상태 반영, 에너지 집계 테스트가 그대로 통과한다.

## 문서 갱신 범위

- `docs/database-schema.md`: Fixture presence 열과 Site 기본 stale 기준
- `docs/menus/monitoring.md`: 10분 화면 갱신, 20분 stale, 센서 모드의 실제 출력 한계
- `docs/menus/control.md`: 제어 freshness 20분과 명령 결과 state/presence 구분
- `docs/menus/settings.md`: BIO 등록 후 주기 조회와 제조사 앱 불필요 조건

## 완료 조건

- 제조사 앱 없이 등록된 BIO 모듈이 게이트웨이 시작 직후와 이후 10분마다 read-only 조회된다.
- 성공 응답은 실제 출력값을 조작하지 않고 API의 `lastSeenAt`을 갱신한다.
- 마지막 성공 후 정확히 20분까지 online/fresh이고 20분 초과부터 stale/offline이다.
- 대시보드는 10분 자동 갱신과 focus refetch를 사용한다.
- MQTT 단절·Gateway 재시작에도 application ACK 전 presence 이벤트가 유실되지 않는다.
- 센서 모드 설정 밝기가 실제 출력 밝기 또는 에너지 사용량으로 기록되지 않는다.
- 관련 자동 테스트, 타입 검사, 빌드와 메뉴/DB 문서가 모두 최신 상태다.
