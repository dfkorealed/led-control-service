# 제어 메뉴 기능 현황

기준일: 2026-08-22

## 확정 구현 범위

- 사용자가 명령을 적용하면 실제 BLE Mesh 상태 기반 terminal 결과가 나올 때까지 현재 제어 입력을 잠그는 사용자 관점의 동기 제어를 구현한다. HTTP는 길게 유지하지 않고 기존 Command/Outbox/MQTT 상태 조회 구조를 사용한다.
- 개별 조명, 임의 다중 선택, 층 전체, 저장 구역 단위 밝기 제어를 제공한다.
- 개별 조명은 unicast, 임의 다중 선택은 제한된 병렬 unicast를 사용한다.
- 층 전체와 저장 구역은 사전 구성된 BLE Mesh Group Address에 단일 전송한다.
- 임의 선택이 기존 층 또는 구역 구성과 정확히 같으면 Group Address 경로를 사용한다.
- 장비별 BLE Mesh Health Current의 현재 fault만 수집해 제어 가능 여부와 결과에 반영한다.
- gateway별 영속 `MeshControlGroup`/`MeshControlGroupMember` 저장 구조와 `0xC000~0xFEFF` group address allocator를 둔다. group은 `configurationVersion`으로 구성 버전을 관리하고, member는 `subscriptionStatus`/`appliedVersion`/`statusVersion`으로 실제 ACK 적용 여부와 마지막 결과 version을 분리한다.
- API는 `configuring` 상태의 control group 중 현재 member가 1개 이상인 group만 10초 주기로 gateway-scoped MQTT subscription sync command를 발행한다.
- gateway는 같은 group/version command를 다시 받아도 Light Lightness Server `0x1300`에 표준 Config Model Subscription Add를 안전하게 재적용하고 결과를 한 번 발행한다.
- API는 `siteId`, `gatewayId`, `groupId`, `version`이 모두 현재 group과 일치하는 subscription result만 반영한다. 현재 group/gateway에 속하지 않는 member 결과는 무시하고, 외부 result의 `ready`를 내부 `subscriptionStatus="applied"`로 변환한다. 모든 현재 member가 해당 version의 `appliedVersion == configurationVersion` 및 `statusVersion == configurationVersion`일 때만 group을 `ready`, 같은 version의 member 하나라도 `failed`면 group을 `failed`로 집계한다.

상세 계약은 `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`를 따른다.

## 명시적 보류 범위

- 다중 gateway command 최종 집계 고도화
- ACK 계약 전면 개편과 API MQTT 소비 내구성 재설계
- 명령 재시도, 취소, rollback과 명령 이력 전용 화면
- 스케줄 제어와 이벤트 제어
- RSSI, hop count와 제품별 상세 diagnostics
- 자동 HIL 판정. 실제 하드웨어 검증은 단일 gateway 기준으로 수동 수행한다.

## 구현 완료

- dashboard의 fixture 목록을 기반으로 제어 대상 조명을 표시한다.
- 개별 조명 카드를 선택할 수 있다.
- 선택 조명의 현재 밝기를 슬라이더에 반영한다.
- 0%, 30%, 70%, 100% 프리셋 버튼으로 밝기 값을 바꿀 수 있다.
- `POST /commands/dimming`으로 개별 조명 밝기 명령을 전송한다.
- 명령 API는 `fixture`, `fixtures`, `floor`, `group` target을 받고, 실제 현장 DB 관계를 같은 transaction 안에서 다시 조회해 확정된 `targetFixtureIds` snapshot을 저장한다. 현재 웹의 `{targetType,targetId}` 요청은 Task 14 전까지 controller 경계에서만 신규 target으로 변환한다.
- 단일 조명은 `unicast`, 임의 다중 선택은 `parallel_unicast`, 준비 완료된 층/저장 구역은 `mesh_group` delivery mode로 저장한다. 임의 선택이 준비 완료된 층 또는 구역 구성과 정확히 같으면 층 우선, 같은 종류 ID 정렬 순으로 Group Address 경로를 선택한다.
- 하나의 논리 target이 여러 gateway에 걸치면 `현재 여러 게이트웨이에 걸친 대상은 지원하지 않습니다`로 전체 거부하며, 준비되지 않은 floor/group은 unicast로 fallback하지 않는다.
- 명령 생성 응답은 `selectedTargetCount`, `transmissionCount`, `deliveryMode`, `terminalStatusUrl`을 제공하고 상태 응답은 nullable `targetId`, 확정 fixture snapshot과 dispatch의 delivery metadata를 반환한다.
- 명령 생성 응답은 command ID와 gateway dispatch 수를 반환하고, `GET /commands/:commandId`는 command의 현장 read 권한이 있는 사용자에게만 조회를 허용한다. 존재하지 않는 command와 접근할 수 없는 command는 같은 `command not found` 404 응답으로 처리한다.
- 제어 화면은 최근 명령을 1초 polling하며 접수, MQTT 발행, gateway 수신, 조명 적용 완료, 일부 실패, 실패, timeout 단계를 표시하고 종료 상태에서 polling을 중단한다.
- 최근 명령의 전체/처리 조명 수와 조명별 실패 또는 timeout 사유를 표시한다.
- dashboard의 group 목록을 그룹 카드로 표시하고 선택할 수 있다.
- `개별`, `그룹` segmented control이 실제 제어 모드를 전환한다.
- 그룹 선택 후 `POST /commands/dimming`에 `targetType: "group"`으로 밝기 명령을 전송한다.
- 백엔드는 SiteAccess `manage` 권한이 있는 operator/admin만 해당 현장의 fixture 또는 group을 제어 대상으로 허용하며, 미배정 또는 다른 고객사 현장은 `404`로 숨긴다.
- `viewer` 권한 사용자는 배정 현장을 조회할 수 있지만 조명 제어 명령 생성은 `403`으로 거부한다.
- 사용자 역할은 service-provider `operator`, customer `admin`, 조회 전용 `viewer` 세 가지다. operator/admin의 제어는 SiteAccess `manage` 범위로 한정되고, viewer는 화면 비활성화와 API `403` 양쪽에서 변경이 차단된다.
- `viewer`가 제어 화면에 진입하면 읽기 전용 안내를 표시하고 밝기 슬라이더, 프리셋, 대상 선택과 `적용` 버튼을 모두 비활성화한다. 이 경우 브라우저는 `POST /commands/dimming`을 보내지 않으며 권한 오류를 장비 장애로 오인하지 않는다.
- 백엔드는 조명의 gateway 매핑, gateway 90초 heartbeat, fixture online/fault 상태를 명령 생성 전에 검증하며 하나라도 제어할 수 없는 그룹 전체를 거부한다.
- 제어 화면은 서버의 `controllable`, `controlBlockReason`에 따라 개별/그룹 적용 버튼을 비활성화하고 미매핑, gateway offline, fixture offline/fault 사유를 한국어로 표시한다.
- 그룹 제어 명령은 MQTT payload에 `targetFixtureIds`를 포함해 게이트웨이가 실제 대상 조명 목록을 바로 처리할 수 있게 한다.
- MQTT `command-ack` 이벤트가 command 상태를 갱신한다.
- Raspberry Pi gateway 앱 골격이 `sites/{siteId}/commands/dimming` MQTT 명령을 수신하고 ACK, fixture state, heartbeat를 발행한다.
- ESP32-H2 펌웨어는 PlatformIO 대신 ESP-IDF 구조로 작성하며, LEDC PWM 기반 밝기 적용 골격을 제공한다.
- ESP-IDF `v5.5.1` + `esp32h2` 환경을 로컬에 구성했고 `scripts/esp32-h2-build.sh`로 실제 펌웨어 빌드를 통과했다.
- 게이트웨이 smoke test 스크립트(`pnpm gateway:smoke`)는 mTLS와 gateway-scoped v2 명령, acceptance/device-status ACK 흐름만 검증한다.
- ESP32-H2 실제 보드 플래시 절차와 라즈베리파이 게이트웨이 로컬 실행 절차를 문서화했다.
- ESP32-H2 펌웨어는 Health Server, Generic OnOff Server, Light Lightness Server를 제공한다. provisioning 및 gateway startup 보정 시 세 Server model에 AppKey bind와 provisioner 주소 60초 publication을 응답으로 확인한다. ESP-IDF publication update callback은 OnOff/Lightness publication buffer만 실제 상태로 갱신하고, 전송은 Mesh stack 자동 publication에 맡겨 중복 송신하지 않는다.
- ESP32-H2 펌웨어는 BLE Mesh Health Attention 이벤트를 250ms identify 점멸로 처리하고 종료 시 원래 밝기로 복원한다. Health fault test/clear와 watchdog fault 기록도 펌웨어 경계에서 구현했다.
- ESP32-H2 펌웨어는 active-low GPIO를 8초간 누르면 앱 NVS와 BLE Mesh credential을 지우고 재부팅하는 물리 factory reset을 수행한다.
- Gateway adapter 계약을 fixture별 장비 리포트 기반으로 확장해 일부 노드 실패 시 command ACK와 fixture state가 함께 동기화되도록 했다.
- Raspberry Pi gateway는 BlueZ 5.82 D-Bus application, network 생성/attach, fixture-unicast 영속 mapping, acknowledged Light Lightness Set/Status adapter를 양산 경로로 사용한다.
- 실제 조명 Status 수신 전에는 제어 성공으로 처리하지 않으며 mapping 없음, status 불일치, timeout을 fixture별 실패 코드로 반환한다.
- ESP32-H2 등록 후 AppKey 0 추가, Health Server `0x0002`, Generic OnOff Server `0x1000`, Light Lightness Server `0x1300` bind와 provisioner 주소 60초 publication을 설정한다.
- Docker appliance는 Raspberry Pi 실제 HCI에서 mesh network 생성과 token 재시작 attach를 통과했다.
- API와 gateway의 legacy MQTT v1 dimming, fixture-state, command-ack, heartbeat 경로를 제거하고 gateway-scoped MQTT v2만 사용한다.
- 양산 gateway에 mock, stub, shell command adapter를 포함하지 않는다. 자동 테스트 adapter는 `apps/gateway/test`에만 둔다.
- 수동 명령은 현재 단일 gateway `CommandDispatch`로 만들고 gateway 독립 sequence와 idempotency key를 발급한다. 여러 gateway에 걸친 논리 target은 후속 fan-out 설계 전까지 생성하지 않는다.
- Command, gateway별 dispatch, 조명별 pending 결과, MQTT outbox를 하나의 DB transaction에 저장한다.
- MQTT outbox publisher가 PostgreSQL `FOR UPDATE SKIP LOCKED`와 30초 worker lease로 다중 API 인스턴스의 중복 발행을 차단한다.
- broker 전송 실패에는 지수 backoff와 jitter를 적용하며 최대 10회 또는 15분을 넘으면 outbox를 dead-letter 처리하고 dispatch, 조명별 결과, 상위 명령을 실패로 종료한다.
- API timeout worker는 미발행 명령 15분, MQTT 발행 후 acceptance 10초, acceptance 후 장비 상태 30초 deadline을 적용하고 종료되지 않은 명령을 `timed_out`으로 확정한다.
- gateway는 v2 dimming command를 로컬 `0600` journal에 먼저 기록한 뒤 acceptance ACK를 보내고, BLE Mesh adapter 결과 후 fixture별 device-status ACK를 보낸다.
- 동일 idempotency key의 최종 결과가 journal에 있으면 실제 조명을 다시 제어하지 않고 기존 ACK를 재발행한다.
- API는 gateway/site/command/dispatch identity가 모두 일치하는 ACK만 반영한다. rejected acceptance는 같은 transaction에서 dispatch, 남은 조명별 결과, 상위 Command를 failed로 종료하며, acceptance 발행 뒤 만료된 rejection도 `accepted` dispatch를 같은 terminal 상태로 닫는다. terminal dispatch의 늦은 ACK는 무시한다.
- BLE Mesh fixture status는 기본 8초 timeout을 적용하고 adapter가 반환하지 않아도 fixture별 `timed_out` 결과로 명령을 종료한다.
- Gateway 재시작 후 accepted-only 명령은 실제 조명을 다시 제어하지 않고 `indeterminate after gateway restart` timeout 결과로 닫는다.
- Gateway journal은 idempotency 결과를 24시간·최대 10,000건만 유지한다. restart resync는 journal 추정값을 상태로 발행하지 않고 확인된 node에 OnOff/Lightness/Health Get을 보내 실제 응답만 fixture-state로 반영한다.
- Gateway startup state는 OnOff, Lightness, Health Current가 같은 관측 generation의 65초 window 안에 모두 확인될 때만 제어 화면과 API에 새 snapshot으로 반영한다. Health Current가 아직 오지 않았거나 한 model만 갱신된 경우에는 기존 상태를 보존한다.
- Health Current fault code는 MQTT v2 구조화 payload와 `Fixture` 최신 snapshot으로 저장된다. API는 fault가 하나라도 있는 조명을 `fixture_fault`로 제어 차단하고, 제어 목록은 각 조명을 `Health 정상`, `Health 장애`, `Health 확인 대기`로 표시한다. Health가 없는 명령 결과 이벤트는 확인된 최신 Health snapshot을 지우지 않는다.
- gateway health artifact는 startup resync의 `total/configured/observed/healthPending/timedOut/failed`를 `meshResync`로 기록한다. `observed`는 같은 generation의 OnOff/Lightness 실제 pair 기준이며, Health Current는 이후 publication까지 pending으로 보존한다. lighting pair 전체 실패만 unhealthy로 유지되어 제어 가능 상태를 heartbeat만으로 잘못 회복하지 않는다.
- Gateway는 assignment의 gateway ID 기반 MQTT 5 persistent session으로 QoS 1 command subscription을 유지한다. Outbox는 실제 MQTT publish 직전에 `expiresAt`을 API의 10초 acceptance deadline 기준으로 계산해 DB payload에 기록하고, 같은 기준의 10초 MQTT message expiry를 설정한다. Gateway는 `requestedAt`이 아니라 `expiresAt`을 사용하며, 최대 2초 느린 gateway clock도 deadline 이후 BLE를 실행하지 않도록 acceptance ACK 뒤 BLE 직전에 다시 만료를 검사한다. BLE 실행 또는 장비 상태 관측이 없었던 만료/불확정 결과는 fixture-state와 journal의 최신 실제 관측을 갱신하지 않아 기존 실제 상태를 보존한다. Production broker는 gateway별 최대 100개 또는 1 MiB QoS 1 queue를 유지하므로 이 한도를 넘는 offline 명령은 보장하지 않는다. API의 global event consumer는 deployment instance ID가 포함된 고유 client ID를 쓰되 clean session으로 연결한다.
- `MeshControlGroupService.ensureFloorGroup/ensureFixtureGroup`은 호출자 transaction 안에서 gateway row를 잠그고 기존 group을 재사용하며, 증가 전 `Gateway.nextMeshGroupAddress` 값을 실제 group address로 예약한다. 새 group은 `configurationVersion = 1`로 시작한다. 대상이 다른 site에 있으면 거부하고 `0xFF00` 이상이면 명시적 소진 오류를 반환한다.
- `RegistrationService.registerBatch`는 provisioning publish 전에 층 control group을 선확보하고, provisioning 완료 transaction은 floor group과 기존 `FixtureGroup` membership의 control group member를 idempotent하게 연결한다.
- 새 member가 기존 `ready` 또는 `failed` group에 추가되면 `configurationVersion`을 1 올리고 group을 `configuring`으로 되돌리며, 해당 group의 전체 member를 `pending`, `statusVersion = 0`, `lastError = null`로 초기화한다. `appliedVersion`은 마지막 성공 이력으로 보존한다.
- `MeshControlGroupService.getReadyDestination`은 floor/fixture-group과 gateway site 경계를 확인한 뒤 `ready` group address만 반환하고, 아직 준비되지 않은 target은 `mesh control group is not ready`로 거부한다.
- control group member 추가와 subscription ACK 반영은 둘 다 group row를 먼저 잠그는 같은 순서로 직렬화해 중복 member attach, version 이중 증가와 group/member 교착 경계를 줄인다.
- 기존 fixture가 다른 층에 이미 연결돼 있으면 provisioning 완료는 `fixture is already assigned to another floor` 오류로 실패시키고, 자동 재배치나 잘못된 floor group attach를 허용하지 않는다.

## 미구현

- 스케줄 제어 생성, 수정, 삭제
- 이벤트 기반 제어 규칙 생성
- 차량 감지, 인체 감지, 시간대 조건 등 rule builder
- 명령 전송 이력 화면
- 명령 retry, rollback, cancel
- 다중 선택, 층/구역별 제어 화면과 신규 target 요청 연결(Task 14). 백엔드 target 해석과 delivery mode 영속화는 구현 완료했다.
- 조명 on/off 전용 토글
- 위험 명령 확인 dialog
- Gateway에서 `parallel_unicast`와 `mesh_group` delivery mode를 실제 BLE Mesh 송신으로 분기하고 group 단일 전송 뒤 fixture별 status를 집계(Task 13)
- gateway의 원격 `identify-device` 명령을 실제 BlueZ adapter의 Health Attention Set으로 전달하는 연결
- ESP32-H2 제품/진단 정보 report의 gateway/API 연동
- ESP32-H2 실제 보드 플래시 검증

## 부족하거나 개선이 필요한 기능

- 스케줄 제어는 추후 구현 범위이며, 동작하지 않는 버튼은 양산 UI에서 제거했다.
- 최근 명령은 ACK 완료/실패까지 추적할 수 있지만, 이전 명령을 검색하고 다시 열 수 있는 명령 이력 화면은 아직 없다.
- Health Current는 최신 snapshot만 사용하며 fault 이력과 제품별 code 설명은 아직 제공하지 않는다.
- 제어 대상이 없을 때 empty state가 충분하지 않다.
- viewer의 읽기 전용 안내는 구현됐지만, 향후 명령 이력 화면에서도 동일한 권한 설명을 재사용하도록 공통화할 수 있다.
- Raspberry Pi Phase 0의 daemon/HCI/network/token 재연결은 통과했지만 ESP32-H2 provisioning과 0/25/50/100% 왕복, 2-node HIL은 아직 실기 검증이 필요하다.
- 자동 테스트 adapter는 `apps/gateway/test`에만 있고 양산 gateway runtime과 배포 진입점에는 포함되지 않는다.
- BLE Mesh 포함 후 ESP32-H2 app partition 여유가 약 12%이므로 OTA와 추가 진단 기능을 넣기 전에 partition 크기를 재검토해야 한다.
- gateway가 acceptance 기록 직후 재시작하면 자동 재제어하지 않고 불확정 timeout으로 닫는다. 운영자 재시도 UI는 명령 이력 기능과 함께 보완해야 한다.
- API target 해석, 확정 fixture snapshot, delivery mode와 destination address 영속화까지 반영됐다. 다만 실제 Gateway 병렬 unicast/group dimming 송신은 Task 13, 신규 웹 제어 UI는 Task 14 범위다.

## 관련 파일

- `apps/web/src/features/control/ControlView.tsx`
- `apps/api/src/commands/commands.controller.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/commands/command-dispatch.service.ts`
- `apps/api/src/commands/command-status.service.ts`
- `apps/web/src/api/commands.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/fixtures/fixture-health.ts`
- `apps/api/src/mqtt/outbox-publisher.service.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `packages/shared/src/command-delivery.ts`
- `packages/shared/src/gateway-contracts.ts`
- `apps/gateway/docker/mqtt-persistence.integration.mjs`
- `infra/mosquitto.production-tls.conf`
- `docker-compose.production.yml`
- `apps/gateway/src/commands/command-journal.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/mesh/bluez-provisioner.ts`
- `apps/gateway/src/mesh/bluez-config-client.ts`
- `apps/gateway/src/mesh/group-subscription-handler.ts`
- `apps/gateway/src/mesh/bluez-model-codec.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/prisma/migrations/20260821093000_add_mesh_control_group_member_status_version/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260819093000_add_mesh_control_groups/migration.sql`
- `apps/api/prisma/migrations/20260819094000_extend_command_targets/migration.sql`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`
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
- `apps/api/src/mqtt/mqtt.service.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

제어 메뉴의 개별/그룹/스케줄/이벤트 제어 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
