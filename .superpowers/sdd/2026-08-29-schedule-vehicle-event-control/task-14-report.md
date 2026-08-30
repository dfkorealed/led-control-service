# Task 14 보고서: Gateway BLE Mesh 차량 센서 입력

상태: 완료(소프트웨어, HIL 미실행)

초기 커밋: `5d17f16` (`feat(gateway): ingest BLE Mesh vehicle sensors`)

Fix Round 1 커밋: self (`fix(gateway): close vehicle sensor review gaps`)

## 구현 내용

- Bluetooth Mesh Presence Detected와 Motion Sensed Sensor Status MPID를 strict decode하고 startup, reconnect, automation hot reload에서 enabled source마다 Presence Sensor Get을 보낸다.
- 제품 vendor payload의 version, `bootId`, `sequence`, event kind와 level 조합을 exact length로 검증한다. Identity receipt는 automation state v5의 source별 current/recent boot high-water inbox에 도메인 transition과 함께 저장하며 duplicate와 관측한 이전 boot에도 ACK를 재전송한다.
- Unknown/unconfigured source, unknown property, malformed payload와 Sensor Get 실패는 runtime 상태를 바꾸지 않고 source와 정제 reason만 기록한다.
- BlueZ application에 Sensor Client와 제품 vendor client model을 등록하고 confirmed node의 Sensor Server/vendor server AppKey binding과 provisioner publication을 exact Config Status로 확인한다.
- Node별 `VehicleSensorCapabilityReportV1` complete payload와 canonical hash를 원자 journal에 저장한다. 실제 binding 상태 변경 때만 revision/event ID를 새로 만들고 broker PUBACK과 무관하게 exact application ACK 전까지 1~30초 bounded retry한다.
- Reconnect는 저장된 동일 event ID, revision, payload와 hash를 재발행한다. `applied|stale|duplicate`는 event/gateway/node/revision/hash가 모두 일치할 때만 terminal이며 `rejected`와 hash mismatch는 journal을 보존한다.
- Production `gateway.ts`/BlueZ adapter/MQTT lifecycle과 capability ACK read-only Mosquitto ACL을 연결했다. DB schema 변경은 없다.

## 검증

- Focused vehicle sensor/BlueZ/Gateway wiring: 7 files, 94/94 passed.
- Gateway 전체: 57 files, 523/523 passed.
- Shared 전체: 7 files, 74/74 passed.
- Gateway Docker 계약: 17/17 passed.
- 필수 Docker/mTLS Mosquitto persistence와 capability ACK ACL: 2/2 passed.
- Shared와 Gateway typecheck, lint, production build: passed.
- `git diff --check`: passed.

## 남은 한계

- Task 15/16의 ESP32-H2 GPIO driver, Sensor Server와 vendor event/ACK retry firmware는 아직 구현되지 않았다.
- 실제 Raspberry Pi BlueZ와 ESP32-H2 사이의 RF packet loss, startup current-state, duplicate ACK, reconnect, 전원 차단과 flash wear HIL은 실행하지 않았다.
- 자동 테스트와 Docker/mTLS Mosquitto 결과는 production 장비 RF 증거가 아니다.

## Fix Round 1 (2026-08-30)

- P1 Company ID: Espressif `0x02E5` product 상수를 제거했다. Production은 `GATEWAY_BLUETOOTH_COMPANY_ID`, firmware는 `CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID`에 같은 Bluetooth SIG 자사 할당값을 요구하며 누락·미할당·타사 기존값·test/internal 값은 fail-closed한다.
- P1 boot oscillation: automation state를 v5로 올리고 source별 current boot와 최근 8개 boot high-water를 bounded inbox에 저장했다. Recent boot packet은 sequence가 커져도 runtime에 재적용하지 않고 ACK만 한다.
- P2 exactly-once: vendor identity receipt와 vehicle active/hold state 및 lifecycle telemetry를 한 durable transaction에 포함해 별도 dedupe 파일과 두 commit crash window를 제거했다.
- P1 provisioning ordering: provisioning terminal QoS1 callback을 먼저 await한다. 완료 뒤 capability refresh node를 durable pending queue에 넣고, startup 전체 refresh도 대상부터 pending으로 저장해 실패를 bounded retry와 health blocker로 격리한다.
- P2 codec: Presence는 strict boolean, Motion Sensed Percentage 8은 `0..100`, `>0 active`로 decode한다. Sensor Status 128 bytes, automation state 64 MiB, capability journal 16 MiB 상한을 적용했다.
- P2 capability uncertainty: binding candidate identity를 먼저 고정하고 target read-back이 previous/next/unknown인지 판정한다. Next는 same revision/eventId/hash를 채택하고 previous는 이전 상태를 유지하며 unknown은 journal을 fence한다.
- P2 shutdown: listener intake를 먼저 차단하고 수락된 sensor promise 전체를 기본 5초로 bounded drain한다. Timeout 진단에는 pending count만 포함한다.
- 구조: 1,041줄 혼합 모듈을 3줄 barrel과 codec 99줄, controller 343줄, capability 420줄로 분리했다.

### TDD, 검증 및 HIL

- RED에서 protocol config 부재, Motion 101/Presence 2, atomic inbox 부재, boot oscillation, definite/uncertain commit, capability previous/next/unknown, accepted promise drain, terminal-before-refresh, bounded JSON read를 재현했다.
- Focused vehicle sensor/BlueZ/automation/production wiring: 9 files, 189/189 passed.
- Gateway 전체: 58 files, 535/535 passed. Shared 전체: 7 files, 75/75 passed.
- Gateway Docker 계약 17/17, 실 Mosquitto persistence/ACL 통합 2/2 passed.
- Shared/Gateway typecheck, lint, build와 `git diff --check` passed.
- DB schema 변경은 없다.
- 실제 assigned value를 주입한 Raspberry Pi/ESP32-H2 RF, packet loss, sudden power loss, bootId entropy/oscillation, flash wear HIL은 미실행이다.
