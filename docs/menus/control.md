# 제어 메뉴 기능 현황

기준일: 2026-07-10

## 구현 완료

- dashboard의 fixture 목록을 기반으로 제어 대상 조명을 표시한다.
- 개별 조명 카드를 선택할 수 있다.
- 선택 조명의 현재 밝기를 슬라이더에 반영한다.
- 0%, 30%, 70%, 100% 프리셋 버튼으로 밝기 값을 바꿀 수 있다.
- `POST /commands/dimming`으로 개별 조명 밝기 명령을 전송한다.
- 명령 전송 후 API 접수와 장비 ACK 대기 상태를 구분하는 메시지를 표시한다.
- dashboard의 group 목록을 그룹 카드로 표시하고 선택할 수 있다.
- `개별`, `그룹` segmented control이 실제 제어 모드를 전환한다.
- 그룹 선택 후 `POST /commands/dimming`에 `targetType: "group"`으로 밝기 명령을 전송한다.
- 백엔드는 로그인 사용자의 조직/현장에 속한 fixture 또는 group만 제어 대상으로 허용한다.
- `viewer` 권한 사용자는 조명 제어 명령을 생성할 수 없다.
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
- Raspberry Pi gateway가 `provisioning-scan-start`, `identify-device`, `provision-device` MQTT 명령을 수신하고, stub 또는 command adapter를 통해 발견/등록 완료/등록 실패 이벤트를 발행한다.
- gateway command adapter는 실제 BLE Mesh provisioner 실행 파일의 JSON lines stdout을 읽어 `unprovisioned-device-found`, `provisioning-completed`, `provisioning-failed` 이벤트로 변환한다.

## 미구현

- 스케줄 제어 생성, 수정, 삭제
- 이벤트 기반 제어 규칙 생성
- 차량 감지, 인체 감지, 시간대 조건 등 rule builder
- 명령 전송 이력 화면
- 명령 실패 사유 상세 표시
- 명령 retry, rollback, cancel
- 다중 선택 제어
- 층/구역별 일괄 제어
- 조명 on/off 전용 토글
- 위험 명령 확인 dialog
- 실제 라즈베리파이 provisioner 실행 파일 구현
- 실제 BLE Mesh provisioning, AppKey bind, group subscription 자동화 command adapter 연결
- ESP32-H2 factory reset, identify 점멸 패턴, 제품/진단 정보 report 구현
- ESP32-H2 실제 보드 플래시 검증

## 부족하거나 개선이 필요한 기능

- `스케줄` 버튼은 추후 구현 범위라 비활성 상태다.
- 명령 메시지는 ACK 대기 상태를 표시하지만, command 이력 화면이 없어 ACK 완료/실패를 사용자가 한 곳에서 추적하기 어렵다.
- 오프라인 또는 장애 조명에도 `전송 가능`으로 보일 수 있어 상태 기반 disabled 처리가 필요하다.
- 제어 대상이 없을 때 empty state가 충분하지 않다.
- Raspberry Pi gateway의 BLE Mesh adapter와 provisioning adapter는 현재 stub/command boundary까지 구현되어 있으며, 실제 하드웨어 연동 시 BlueZ D-Bus 또는 검증된 provisioner 스택을 command adapter 뒤에 연결해야 한다.
- ESP32-H2 펌웨어는 BLE Mesh node 서버 모델까지 빌드되지만, 실제 RF/provisioning/model bind/group subscription은 보드와 라즈베리파이 확보 후 실기기 검증이 필요하다.
- 로컬 게이트웨이 smoke test는 `StubBleMeshAdapter` 기준이므로 실제 BLE Mesh adapter 교체 후 라즈베리파이 실기기 재검증이 필요하다.
- BLE Mesh 포함 후 ESP32-H2 app partition 여유가 약 12%이므로 OTA와 추가 진단 기능을 넣기 전에 partition 크기를 재검토해야 한다.

## 관련 파일

- `apps/web/src/features/control/ControlView.tsx`
- `apps/api/src/commands/commands.controller.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
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
