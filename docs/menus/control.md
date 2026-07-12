# 제어 메뉴 기능 현황

기준일: 2026-07-12

## 구현 완료

- dashboard의 fixture 목록을 기반으로 제어 대상 조명을 표시한다.
- 개별 조명 카드를 선택할 수 있다.
- 선택 조명의 현재 밝기를 슬라이더에 반영한다.
- 0%, 30%, 70%, 100% 프리셋 버튼으로 밝기 값을 바꿀 수 있다.
- `POST /commands/dimming`으로 개별 조명 밝기 명령을 전송한다.
- 명령 생성 응답은 command ID와 gateway dispatch 수를 반환하고, `GET /commands/:commandId`는 로그인 사용자 조직 범위에서만 조회를 허용한다.
- 제어 화면은 최근 명령을 1초 polling하며 접수, MQTT 발행, gateway 수신, 조명 적용 완료, 일부 실패, 실패, timeout 단계를 표시하고 종료 상태에서 polling을 중단한다.
- 최근 명령의 전체/처리 조명 수와 조명별 실패 또는 timeout 사유를 표시한다.
- dashboard의 group 목록을 그룹 카드로 표시하고 선택할 수 있다.
- `개별`, `그룹` segmented control이 실제 제어 모드를 전환한다.
- 그룹 선택 후 `POST /commands/dimming`에 `targetType: "group"`으로 밝기 명령을 전송한다.
- 백엔드는 로그인 사용자의 조직/현장에 속한 fixture 또는 group만 제어 대상으로 허용한다.
- `viewer` 권한 사용자는 조명 제어 명령을 생성할 수 없다.
- 백엔드는 조명의 gateway 매핑, gateway 90초 heartbeat, fixture online/fault 상태를 명령 생성 전에 검증하며 하나라도 제어할 수 없는 그룹 전체를 거부한다.
- 제어 화면은 서버의 `controllable`, `controlBlockReason`에 따라 개별/그룹 적용 버튼을 비활성화하고 미매핑, gateway offline, fixture offline/fault 사유를 한국어로 표시한다.
- 그룹 제어 명령은 MQTT payload에 `targetFixtureIds`를 포함해 게이트웨이가 실제 대상 조명 목록을 바로 처리할 수 있게 한다.
- MQTT `command-ack` 이벤트가 command 상태를 갱신한다.
- Mock gateway가 개별/그룹 dimming command를 받아 fixture state와 command ack를 발행한다.
- Raspberry Pi gateway 앱 골격이 `sites/{siteId}/commands/dimming` MQTT 명령을 수신하고 ACK, fixture state, heartbeat를 발행한다.
- ESP32-H2 펌웨어는 PlatformIO 대신 ESP-IDF 구조로 작성하며, LEDC PWM 기반 밝기 적용 골격을 제공한다.
- ESP-IDF `v5.5.1` + `esp32h2` 환경을 로컬에 구성했고 `scripts/esp32-h2-build.sh`로 실제 펌웨어 빌드를 통과했다.
- 로컬 게이트웨이 smoke test 스크립트(`pnpm gateway:smoke`)로 MQTT 명령, ACK, fixture state 흐름을 검증할 수 있다.
- ESP32-H2 실제 보드 플래시 절차와 라즈베리파이 게이트웨이 로컬 실행 절차를 문서화했다.
- ESP32-H2 펌웨어에 BLE Mesh node 초기화, provisioning advertisement, node identity, Health Server, Generic OnOff Server, Light Lightness Server, status publication 골격을 추가했고 ESP-IDF 빌드를 통과했다.
- Gateway adapter 계약을 fixture별 장비 리포트 기반으로 확장해 일부 노드 실패 시 command ACK와 fixture state가 함께 동기화되도록 했다.
- Raspberry Pi gateway의 MQTT 명령 수신 계약은 구현되어 있으며 실제 BlueZ Mesh adapter 연결 전에는 gateway 시작을 거부한다.
- Mock 검색/등록은 별도 `apps/mock-gateway`에서만 실행하며 양산 gateway에 stub/command adapter를 포함하지 않는다.
- 수동 개별/그룹 명령을 소유 gateway별 `CommandDispatch`로 분할하고 gateway마다 독립 sequence와 idempotency key를 발급한다.
- Command, gateway별 dispatch, 조명별 pending 결과, MQTT outbox를 하나의 DB transaction에 저장한다.
- MQTT outbox publisher가 PostgreSQL `FOR UPDATE SKIP LOCKED`와 30초 worker lease로 다중 API 인스턴스의 중복 발행을 차단한다.
- broker 전송 실패에는 지수 backoff와 jitter를 적용하며 최대 10회 또는 15분을 넘으면 outbox를 dead-letter 처리하고 dispatch, 조명별 결과, 상위 명령을 실패로 종료한다.
- API timeout worker는 미발행 명령 15분, MQTT 발행 후 acceptance 10초, acceptance 후 장비 상태 30초 deadline을 적용하고 종료되지 않은 명령을 `timed_out`으로 확정한다.
- gateway는 v2 dimming command를 로컬 `0600` journal에 먼저 기록한 뒤 acceptance ACK를 보내고, BLE Mesh adapter 결과 후 fixture별 device-status ACK를 보낸다.
- 동일 idempotency key의 최종 결과가 journal에 있으면 실제 조명을 다시 제어하지 않고 기존 ACK를 재발행한다.
- API는 gateway/site/command/dispatch identity가 모두 일치하는 ACK만 반영하고, 모든 gateway dispatch가 끝난 뒤 상위 Command 상태를 확정한다.
- BLE Mesh fixture status는 기본 8초 timeout을 적용하고 adapter가 반환하지 않아도 fixture별 `timed_out` 결과로 명령을 종료한다.
- Gateway 재시작 후 accepted-only 명령은 실제 조명을 다시 제어하지 않고 `indeterminate after gateway restart` timeout 결과로 닫는다.
- Gateway journal은 idempotency 결과를 24시간·최대 10,000건만 유지하고 fixture별 최신 snapshot 한 건만 startup resync에 사용한다.

## 미구현

- 스케줄 제어 생성, 수정, 삭제
- 이벤트 기반 제어 규칙 생성
- 차량 감지, 인체 감지, 시간대 조건 등 rule builder
- 명령 전송 이력 화면
- 명령 retry, rollback, cancel
- 다중 선택 제어
- 층/구역별 일괄 제어
- 조명 on/off 전용 토글
- 위험 명령 확인 dialog
- 실제 라즈베리파이 provisioner 실행 파일 구현
- 실제 BLE Mesh provisioning, AppKey bind, group subscription BlueZ adapter 연결
- ESP32-H2 factory reset, identify 점멸 패턴, 제품/진단 정보 report 구현
- ESP32-H2 실제 보드 플래시 검증

## 부족하거나 개선이 필요한 기능

- `스케줄` 버튼은 추후 구현 범위라 비활성 상태다.
- 최근 명령은 ACK 완료/실패까지 추적할 수 있지만, 이전 명령을 검색하고 다시 열 수 있는 명령 이력 화면은 아직 없다.
- 제어 대상이 없을 때 empty state가 충분하지 않다.
- Raspberry Pi gateway는 현재 실제 BlueZ adapter 미구현으로 의도적으로 시작이 차단된다. Phase 0 통과 후 BlueZ D-Bus adapter를 연결해야 한다.
- ESP32-H2 펌웨어는 BLE Mesh node 서버 모델까지 빌드되지만, 실제 RF/provisioning/model bind/group subscription은 보드와 라즈베리파이 확보 후 실기기 검증이 필요하다.
- 로컬 게이트웨이 smoke test는 `StubBleMeshAdapter` 기준이므로 실제 BLE Mesh adapter 교체 후 라즈베리파이 실기기 재검증이 필요하다.
- BLE Mesh 포함 후 ESP32-H2 app partition 여유가 약 12%이므로 OTA와 추가 진단 기능을 넣기 전에 partition 크기를 재검토해야 한다.
- gateway가 acceptance 기록 직후 재시작하면 자동 재제어하지 않고 불확정 timeout으로 닫는다. 운영자 재시도 UI는 명령 이력 기능과 함께 보완해야 한다.

## 관련 파일

- `apps/web/src/features/control/ControlView.tsx`
- `apps/api/src/commands/commands.controller.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/commands/command-dispatch.service.ts`
- `apps/api/src/commands/command-status.service.ts`
- `apps/web/src/api/commands.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/commands/command-journal.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `apps/mock-gateway/src/simulator.ts`
- `apps/esp32-h2-firmware/main/app_main.c`
- `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- `apps/esp32-h2-firmware/main/ble_mesh_platform.c`
- `apps/esp32-h2-firmware/main/control_state.c`
- `apps/esp32-h2-firmware/main/led_driver.c`
- `apps/esp32-h2-firmware/main/mesh_state.c`
- `apps/esp32-h2-firmware/README.md`
- `apps/gateway/README.md`
- `scripts/esp32-h2-build.sh`
- `scripts/esp32-h2-flash.sh`
- `apps/gateway/scripts/local-smoke-test.mjs`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

제어 메뉴의 개별/그룹/스케줄/이벤트 제어 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
