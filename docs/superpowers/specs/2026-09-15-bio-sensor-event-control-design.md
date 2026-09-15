# BIO 센서 이벤트 제어 설계

기준일: 2026-09-15

## 목적

바이오일렉트로닉스 센서통신모듈이 USB-C 동글로 보내는 센서 상태를 Gateway가 직접 수신하고,
제조사 Android 앱 없이 기존 차량 이벤트 자동화의 입력으로 사용한다. 사용자가 이벤트 규칙을
저장하면 실제 센서 감지에서 목표 조명이 켜지고, 센서 해제와 유지 시간이 끝난 뒤 이벤트 전
밝기와 BIO 제어 모드로 복원되어야 한다.

센서 packet의 의미를 추측해 조명을 움직이지 않는 것이 가장 중요한 안전 원칙이다. packet을
수신했다는 사실, 동글의 외부 ACK, 조명의 밝기 변화는 각각 센서 감지의 증거가 아니다. 실제
자극과 상관 검증된 packet 조합만 production decoder allowlist에 포함한다.

## 현재 근거와 제한

### 확인된 사항

- 분석 대상 APK는
  `/Users/kim-jh/Downloads/bio-group-control-v11-slim-aligned-signed.apk`이며 SHA-256은
  `1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e`이다.
- APK의 `ILampCommand.OPCode` 정의에서 inner opcode `0x09`는
  `OPC_AI_SEN_STS`, `0x0c`는 `OPC_ALIVE_STS`다.
- 외부 command `0x12`는 동글이 Gateway로 전달하는 비동기 module RX다.
- `0x12` header는 RSSI, 6-byte native UUID, control/TTL, 8-bit sequence, source address,
  destination address, network ID와 inner body를 포함한다.
- 현재 golden capture에는 `0x09 01 01 00...` 형태의 AI sensor status 후보와 `0x0c`
  alive packet이 있다.
- 현재 module discovery의 `sensorType=2`는 APK 표에서 infrared sensor를 뜻한다.
- 기존 event engine은 `current-state(active=true|false)` 입력을 받아 감지, 해제, hold,
  우선순위 처리와 원래 밝기 복원을 수행할 수 있다.
- 현재 BIO 양수 밝기 제어는 high-brightness SET 뒤 control mode를 `force-on`으로 바꾸고,
  0%는 `force-off`로 바꾼다.

### 아직 확인되지 않은 사항

- `0x09` body의 어느 byte가 감지 상태인지, 혹은 packet 도착 자체가 감지 pulse인지
- 해제가 별도 packet인지, 상태 byte 변화인지, 감지 packet이 끊긴 뒤 timeout인지
- 같은 상태를 module이 반복 전송하는 주기와 8-bit sequence의 재부팅·wrap 의미
- sensor status에 device-level ACK가 필요한지와 그 ACK 형식
- read-only current-state GET 명령이 존재하는지
- `force-on` 또는 `force-off` 상태에서도 센서가 감지·해제를 계속 보고하는지
- sensor mode에서 high-brightness 값만 바꾸면 이미 감지 중인 조명 출력에 즉시 반영되는지

이 항목들은 정적 APK 분석만으로 확정하지 않는다. 특히 APK는 opcode `0x09`를 이름까지
정의하지만 payload를 단순 command로 등록하므로, `01`을 감지로 간주할 근거는 제공하지 않는다.

## 범위

### 포함

- BIO 비동기 sensor/alive packet을 구분하는 typed decoder
- raw packet을 production log에 노출하지 않는 진단 capture 도구
- confirmed UUID/address/network와 Fixture를 연결하는 BIO sensor source
- sensor 상태 중복 제거, freshness와 재연결 수렴
- adapter-neutral vehicle sensor intake
- BIO capability 보고와 API/Web source 활성화
- 이벤트 전 BIO 밝기와 제어 모드의 보존·복원
- source/target 중첩 차단과 명시적인 사용자 오류
- software E2E, fault injection과 실제 HIL

### 제외

- 근거가 없는 raw opcode 송신
- 조명 밝기나 제어 모드로 센서 감지를 역추정하는 방식
- `0x0c` alive packet을 감지 또는 해제로 취급하는 방식
- 확인되지 않은 sensor ACK 전송
- firmware OTA, AI 학습, 센서 민감도 조정
- 검증 전 source fixture와 target fixture를 동일하게 사용하는 방식

## 고려한 접근

### A. 검증된 비동기 sensor status + 저빈도 상태 수렴 — 채택

`0x12/0x09` packet에서 실제 자극과 함께 확인한 상태만 decoder가 `active` boolean으로
정규화한다. 실시간 packet은 즉시 event engine으로 전달하고, read-only state GET이 capture로
확인되면 startup, reconnect와 저빈도 상태 수렴에만 사용한다. 현재 transport와 같은 USB
connection을 공유하므로 command response와 비동기 packet의 소유권을 보존할 수 있다.

### B. sensor 상태 polling만 사용 — 보류

APK는 sensor setting GET과 occupancy 관련 필드를 포함하지만 현재 infrared module의 실제
감지 상태를 반환하는 정확한 request/response 조합은 확인되지 않았다. 또한 polling 주기만큼
이벤트가 늦어지고 짧은 감지를 놓칠 수 있다. 검증된 GET이 발견되면 A의 복구 수단으로만 쓴다.

### C. 조명 출력 변화로 감지 추정 — 제외

sensor mode의 설정 밝기와 순간 출력 밝기는 다르다. 조명 변화는 schedule, manual control,
event action 또는 센서 자체 동작 중 무엇 때문인지 구분할 수 없으므로 feedback loop와 오탐을
만든다.

## 아키텍처

```text
BIO module
  -> USB dongle outer 0x12
  -> BioUsbTransport (CRC와 frame 경계 검증)
  -> BioSensorPacketDecoder (허용된 firmware fingerprint와 sensor status만 해석)
  -> BioVehicleSensorSource (confirmed mapping, freshness, 중복 제거)
  -> VehicleSensorIntake (규칙에 등록된 source인지 검증)
  -> ScheduleRuntime.recordVehicleSensorInput(current-state)
  -> VehicleEventRuntime (detected/cleared/hold/priority)
  -> BIO lighting action
  -> target read-back
  -> automation telemetry/API/Web
```

BlueZ `VehicleSensorMeshPort`가 요구하는 model binding, mesh unicast와 vendor ACK를 BIO가
가짜로 구현하지 않는다. 공통 검증과 runtime 호출은 `VehicleSensorIntake`로 분리하고,
BlueZ와 BIO source가 각자 실제 protocol decode와 ACK 책임을 갖는다.

BIO source와 dimming adapter는 하나의 `BioDongleClient`를 공유한다. 별도 client가 같은 USB
descriptor를 열거나 별도 queue를 만들지 않는다. 비동기 sensor packet은 active command의
outer ACK를 소비하지 않으며, command read-back 역시 sensor packet을 응답으로 오인하지 않는다.

## 센서 packet 계약

### capture 형식

개발/HIL 전용 capture는 다음 정보만 JSON Lines로 저장한다.

- monotonic 수신 시각과 HIL marker 시각
- APK SHA-256, Gateway decoder version과 module firmware fingerprint
- outer command와 payload length
- UUID의 SHA-256 digest, logical address, network ID, destination
- control/TTL, 8-bit sequence
- inner opcode와 inner body bytes
- marker: `idle`, `stimulus-start`, `stimulus-end`, `output-command-only`, `power-cycle`

native UUID 원문, broker 인증정보, 전체 USB descriptor와 사용자·현장 ID는 저장하지 않는다.
capture 기능은 명시적인 진단 환경변수와 로컬 0600 파일 경로가 모두 있을 때만 켜지고,
production compose에는 해당 설정을 넣지 않는다.

### decoder 규칙

- CRC16이 유효한 외부 `0x12`만 입력으로 받는다.
- `0x0c`는 alive로만 분류하며 event state를 만들지 않는다.
- `0x09`는 exact payload length, 고정 byte, sensor type, firmware fingerprint와 상태 byte가
  승인된 golden vector와 모두 일치할 때만 `BioSensorObservation`을 만든다.
- 알려지지 않은 길이·opcode·고정 byte·상태값은 `unsupported`로 유지한다.
- malformed packet은 connection의 현재 request를 성공시키지 않는다.
- production diagnostic에는 raw body 대신 분류명과 안정적인 오류 code만 남긴다.

정규화 출력은 다음 의미를 갖는다.

```ts
interface BioSensorObservation {
  source: {
    deviceUuid: `bio:${string}`;
    logicalAddress: number;
    networkId: number;
  };
  active: boolean;
  deviceSequence: number;
  observedAtMonotonicMs: number;
  protocolFingerprint: string;
}
```

8-bit sequence는 짧은 구간의 exact duplicate 관측에만 사용한다. 숫자가 작아졌다는 이유로
재부팅 또는 오래된 packet이라고 추정하지 않는다. durable truth는 마지막 확정 `active` 상태,
protocol fingerprint와 API가 이미 수용한 capability revision이다.

## BIO sensor source 동작

`BioVehicleSensorSource`는 packet의 UUID/address/network가 `confirmed` mapping과 모두 일치할
때만 Fixture ID로 변환한다. 다음 packet은 event engine으로 전달하지 않는다.

- 미등록 또는 reserved mapping
- 다른 address/network에서 온 같은 UUID
- 등록된 event 규칙에 source로 포함되지 않은 Fixture
- 지원하지 않는 firmware/sensor type fingerprint
- shadow mode 또는 capability가 아직 verified가 아닌 Fixture

같은 Fixture의 같은 `active` 값 반복은 마지막 수신 시각만 갱신하고 lifecycle을 다시 만들지
않는다. 상태가 바뀐 경우에만 `current-state`를 전달한다. reconnect 중 들어온 partial packet은
버리고 protocol readiness와 mapping validation이 끝난 뒤 intake를 다시 연다.

read-only current-state GET이 확인되면 startup/reconnect 직후 모든 configured source를
직렬 조회한다. GET이 없고 event가 edge-only임이 확인되면, capture로 검증된 반복·timeout
계약을 이용한 pulse adapter를 별도 구현한다. 검증된 clear 규칙이 없는 firmware는 source
capability를 활성화하지 않는다.

## capability와 활성화 조건

기존 capability V1의 `sensorServerBound`와 `vendorVehicleEventModelBound`는 BlueZ Mesh 전용
의미이므로 BIO 성공을 그 값으로 위장하지 않는다. adapter-neutral V2 capability를 추가한다.

- `sourceProtocol`: `bluetooth-mesh-v1 | bio-usb-sensor-v1`
- `status`: `supported | unsupported`
- `eventDeliveryVerified`
- `currentStateRecoveryVerified`
- `deviceAcknowledgement`: `not-required | verified`
- `protocolFingerprint`
- `verifiedAt`, `capabilityRevision`

BIO status는 다음 조건을 모두 만족한 경우만 `supported`다.

1. mapping이 confirmed이고 packet identity와 일치한다.
2. firmware, sensor type과 packet 형식이 HIL allowlist에 있다.
3. 실제 자극으로 idle → detected → cleared를 최소 10회 상관 검증했다.
4. duplicate, packet loss, sequence `255 → 0`과 module power-cycle을 검증했다.
5. Gateway USB reconnect 뒤 현재 상태가 수렴한다.
6. output command만으로 가짜 sensor transition이 생기지 않는다.
7. ACK 필요 여부를 확인했고 필요한 경우 ACK 재전송까지 검증했다.

`currentStateRecoveryVerified`는 검증된 GET 응답으로 현재 High/Low를 다시 읽거나, edge-only
firmware라면 power-cycle/reconnect 뒤 첫 authoritative packet까지 intake를 닫고 그 packet으로
수렴하는 계약을 뜻한다. 재연결 직전 journal 값을 그대로 현재 상태로 믿는다는 의미가 아니다.

firmware fingerprint가 달라지거나 current-state recovery가 실패하면 capability를
`unsupported`로 낮춘다. API는 해당 source를 사용하는 rule을 비활성화하고 UI에 재검증이
필요한 이유를 표시한다.

DB에는 V2 의미를 보존할 nullable column을 추가한다. 기존 BlueZ row는 migration에서
`bluetooth-mesh-v1` 의미로 수렴시키고 기존 동작을 유지한다. schema 변경과 함께
`docs/database-schema.md`를 갱신한다.

## source/target과 BIO 제어 모드

### 최초 production 정책

같은 Fixture가 한 rule의 BIO sensor source와 lighting target에 동시에 포함되면 API가
`bio_sensor_target_overlap_unsupported`로 저장을 거부한다. 현재 `setOutput()`은 양수 밝기에서
`force-on`, 0%에서 `force-off`로 바꾸므로 source가 센서 보고를 중단할 가능성이 있기 때문이다.

다른 BIO target도 event가 끝난 뒤 단순 밝기만 복원하면 기존 sensor mode가 사라질 수 있다.
Gateway automation state는 event 시작 전에 다음 base state를 보존한다.

- 마지막으로 read-back이 확인된 밝기
- 마지막으로 read-back이 확인된 BIO control mode

event 시작에서는 target을 요청 밝기와 `force-on`으로 적용하고, clear와 hold 종료 뒤에는
기존 밝기와 `sensor | force-on | force-off` mode를 함께 복원한다. 복원 read-back이 하나라도
일치하지 않으면 성공으로 기록하지 않고 targeted resync를 예약한다.

### 중첩 허용을 위한 별도 gate

다음 HIL을 모두 통과한 firmware만 source/target 중첩 allowlist에 넣을 수 있다.

- sensor mode에서 high-brightness SET만으로 감지 중 출력이 즉시 변한다.
- 해당 SET과 read-back 자체가 가짜 감지·해제를 만들지 않는다.
- sensor mode를 유지한 채 detected와 cleared가 계속 보고된다.
- event 종료 시 이전 high-brightness 설정과 sensor mode가 복원된다.

통과한 경우에만 source target에는 `force-on` 대신 sensor-preserving brightness action을
사용한다. 시간 기반으로 command 직후 sensor packet을 무시하는 방식은 실제 clear까지 버릴 수
있으므로 사용하지 않는다.

## durable 상태와 오류 처리

Gateway의 BIO sensor state journal은 0600 atomic JSON으로 다음만 보존한다.

- site/gateway scope
- confirmed Fixture ID와 protocol fingerprint
- 마지막 확정 active 상태와 관측 시각
- 마지막 8-bit sequence 진단값
- source readiness: `shadow | verifying | ready | stale | unsupported`

journal commit 전에 device ACK를 보내지 않는다. ACK가 필요 없는 protocol이면 그 사실을
fingerprint allowlist에 기록한다. write 실패가 보인 경우 마지막 상태를 성공으로 추정하지 않고
source를 stale로 전환한다.

sensor input 실패는 조명 제어와 Gateway heartbeat 전체를 offline으로 만들지 않는다. 별도
automation capability degraded 상태로 보고한다. 반대로 mapping journal 손상, USB protocol
readiness 실패 또는 packet identity 충돌은 event intake를 즉시 닫는다.

detected 뒤 clear를 잃어버린 경우 임의의 공통 timeout으로 조명을 끄지 않는다. 검증된
current-state GET으로 수렴하거나, 해당 firmware의 검증된 edge-only timeout 계약만 사용한다.
둘 다 없으면 source를 stale로 표시하고 event를 fail-safe high 상태로 유지하면서 운영자에게
확인 필요를 표시한다.

## shadow mode와 전환

1. decoder는 production action 없이 observation만 기록한다.
2. 같은 시간대의 HIL marker와 module 자체 LED 반응을 비교한다.
3. detected/cleared, duplicate, idle, output-only, reconnect, power-cycle 결과를 자동 판정한다.
4. fingerprint별 evidence manifest를 생성한다.
5. manifest가 모든 gate를 통과한 경우에만 capability를 `supported`로 발행한다.
6. API가 capability를 commit하고 Gateway가 application ACK를 받은 다음 source 선택을 허용한다.
7. 첫 active rule은 source와 다른 target 한 대, 30% base, 70% event, hold 5초로 HIL한다.

shadow mode는 production rule을 실행하지 않는다. 단순히 packet이 보였다는 이유로 자동으로
ready로 승격하지 않으며, evidence manifest는 코드에 포함된 fingerprint allowlist와 일치해야
한다.

## 테스트 전략

### Gateway codec 및 transport

- APK/golden vector에서 `0x09` AI sensor와 `0x0c` alive를 구분한다.
- 유효한 CRC라도 길이, 고정 byte, 상태값 또는 fingerprint가 다르면 event를 만들지 않는다.
- sensor packet이 outer ACK 또는 brightness/mode read-back을 소비하지 않는다.
- USB chunk split/merge와 partial packet 중에도 sensor packet을 정확히 분리한다.
- raw packet이 일반 log, error message 또는 telemetry에 포함되지 않는다.

### source intake와 durable 상태

- confirmed UUID/address/network만 Fixture에 연결한다.
- 같은 state 반복, 같은 sequence 반복, sequence wrap과 reconnect를 처리한다.
- current-state recovery 전에는 source가 ready가 되지 않는다.
- journal 재시작 뒤 가짜 detected/cleared를 생성하지 않는다.
- capability downgrade가 관련 rule을 비활성화한다.

### automation과 제어 모드

- `current-state false → true → true → false`에서 lifecycle이 정확히 한 번씩 생성된다.
- manual > event > schedule 우선순위를 유지한다.
- event 종료 뒤 base brightness와 BIO mode를 함께 복원한다.
- source/target 중첩 rule은 명시 오류로 거부한다.
- read-back 불일치와 timeout은 성공 telemetry를 만들지 않는다.

### API/Web/E2E

- verified BIO source만 event source 목록에 표시된다.
- unsupported/stale source 선택과 중첩 rule 저장을 막고 이해 가능한 오류를 표시한다.
- disposable real backend에서 sensor input → 70% → clear → hold → base restore와 MQTT
  application ACK까지 검증한다.
- 기존 BlueZ sensor event, schedule, manual override 동작을 회귀 검증한다.

### 실제 HIL

1. 모든 automation rule을 비활성화하고 sensor mode idle trace를 수집한다.
2. outbound `0x10`이 없는 동안 sensor packet이 들어오는지 확인한다.
3. 물체 이동으로 idle → detected → cleared를 최소 10회 만들고 marker를 기록한다.
4. 장시간 감지, 짧은 pulse와 반복 감지를 기록한다.
5. packet loss와 duplicate를 fault injection으로 검증한다.
6. sequence `255 → 0`과 module power-cycle을 검증한다.
7. USB를 재연결하고 current-state 수렴을 확인한다.
8. 물리 자극 없이 brightness/mode command만 보내 false event가 없는지 확인한다.
9. source와 다른 target으로 감지 → 70% → 해제 → hold 5초 → base/mode 복원을 확인한다.
10. capability report, execution/action result와 application ACK가 모두 수렴하는지 확인한다.

## 관측성과 사용자 표시

- UI source 상태: `검증 중`, `사용 가능`, `재검증 필요`, `지원하지 않음`
- 규칙 실행 기록에는 source Fixture, detected/cleared, target 결과와 복원 결과를 표시한다.
- 공개 오류 code는 `bio_sensor_packet_unsupported`, `bio_sensor_identity_mismatch`,
  `bio_sensor_state_stale`, `bio_sensor_recovery_unavailable`,
  `bio_sensor_target_overlap_unsupported`로 제한한다.
- 로그에는 raw frame, native UUID, logical address와 protocol body를 출력하지 않는다.
- HIL capture만 redacted identity와 제한된 body를 0600 로컬 파일에 저장한다.

## 문서 갱신 범위

- `docs/database-schema.md`: adapter-neutral capability V2와 Fixture BIO sensor 상태
- `docs/menus/control.md`: BIO event source, mode 복원, source/target 중첩 제한과 HIL 상태
- `docs/menus/settings.md`: 등록된 BIO sensor capability 검증과 재검증
- `docs/menus/monitoring.md`: sensor source freshness와 Gateway 전체 health의 분리
- `docs/project-status.md`: software/HIL evidence와 남은 제한

각 메뉴 문서는 기존 `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`,
`갱신 규칙` 구성을 유지한다.

## 완료 조건

- 제조사 앱 없이 confirmed BIO module의 실제 sensor 상태를 Gateway가 수신한다.
- `0x0c` alive 또는 미확인 packet은 이벤트를 만들지 않는다.
- 실제 detected/cleared가 정확한 Fixture source로 전달되고 중복 lifecycle을 만들지 않는다.
- reconnect와 module power-cycle 뒤 current state가 안전하게 수렴한다.
- 검증된 fingerprint에서만 Web이 BIO source를 선택할 수 있다.
- source와 다른 target에서 감지 → 점등 → 해제 → hold → event 전 밝기·mode 복원이 실제
  장비와 telemetry에서 모두 확인된다.
- source/target 중첩은 별도 HIL 통과 전까지 저장 단계에서 거부된다.
- 기존 BlueZ event, BIO manual/schedule/group control과 10분 presence polling이 회귀 없이
  동작한다.
- schema, API, Gateway, Web, E2E와 HIL 테스트 및 관련 문서가 모두 최신 상태다.
