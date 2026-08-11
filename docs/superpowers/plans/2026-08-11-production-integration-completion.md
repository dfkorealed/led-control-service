# 양산 통합 기능 완성 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모바일과 기존 후속 로드맵을 제외하고 현재 부분 구현된 Gateway, BLE Mesh, 조명 등록, 모니터링, 수동 그룹 제어와 HIL 경로를 양산 코드 기준으로 완성한다.

**Architecture:** PostgreSQL을 클라우드 원장, MQTT QoS 1 persistent session을 현장 전달 경계, Raspberry Pi BlueZ를 BLE Mesh provisioner/client로 유지한다. 등록과 상태는 실제 장비 응답 전에는 성공으로 확정하지 않고, Gateway별 영속 mapping과 idempotency journal을 통해 재연결·중복 전달을 견딘다.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, React/React Query, MQTT.js, Mosquitto, BlueZ Mesh D-Bus, ESP-IDF C, Node test/Jest/Vitest/Playwright

## Global Constraints

- 모든 설계와 완료 판정은 양산 기준을 사용한다.
- 모바일, OTA, 스케줄·이벤트, RF/AI와 기존 설정 후속 기능은 구현하지 않는다.
- 기존 메뉴 문서의 미구현 목록은 해당 기능을 구현한 작업이 아니면 변경하지 않는다.
- MQTT v2 topic과 command ACK 상태 기계를 유지하고 runtime mock 경로를 추가하지 않는다.
- DB 변경은 비파괴 migration으로 작성하고 `docs/database-schema.md`를 같은 작업에서 갱신한다.
- 각 작업은 red-green TDD, 관련 문서 갱신, 검증과 독립 커밋으로 끝낸다.

---

### Task 1: 완료 상태 문서 정합성과 제품 테스트 기본값 제거

**Files:**
- Modify: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md`
- Modify: `docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md`
- Modify: `docs/menus/control.md`
- Modify: `apps/web/src/features/auth/AuthView.tsx`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces: 현재 역할·에디터 위치·펌웨어 구현 범위와 일치하는 문서
- Produces: 빈 로그인·초대 입력값을 가진 production UI

- [x] **Step 1: 로그인 기본값 회귀 테스트 작성**

`AuthView` 최초 렌더에서 이메일, 비밀번호와 초대 token input value가 빈 문자열인지 검증한다.

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/web test -- --run src/App.test.tsx`

- [x] **Step 3: UI와 완료 문서 정정**

`owner`와 모니터링 에디터 설명을 세 역할과 설정 에디터로 바꾸고, 실제 구현된 물리 factory reset/Health Attention identify와 아직 미구현인 원격 연결을 구분한다. 완료 증거가 있는 기존 계획 checkbox만 `[x]`로 바꾼다.

- [x] **Step 4: 검증과 커밋**

Run: `pnpm --filter @led-control/web test -- --run src/App.test.tsx && git diff --check`

Commit: `docs: align completed product state`

### Task 2: MQTT persistent command delivery

**Files:**
- Modify: `apps/gateway/src/mqtt/create-mqtt-client.ts`
- Modify: `apps/gateway/src/mqtt/create-mqtt-client.test.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `infra/mosquitto.production-tls.conf`
- Modify: `docker-compose.yml`
- Test: `tests/mqtt-production-config.node.mjs`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Produces: `createMqttConnectionOptions(env, identity?)`의 stable `clientId`, `clean: false`, MQTT 5 session expiry 계약
- Produces: broker persistence volume과 QoS 1 offline queue

- [ ] **Step 1: session 및 broker 계약 실패 테스트 작성**

Gateway ID가 client ID에 포함되고 `clean=false`, session expiry가 명시되며 production Mosquitto가 persistence를 활성화하는지 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- --run src/mqtt/create-mqtt-client.test.ts && node --test tests/mqtt-production-config.node.mjs`

- [ ] **Step 3: persistent session 구현**

Gateway client는 assignment의 gateway ID로 stable client ID를 구성하고 API publisher는 별도 stable service client ID를 사용한다. broker data directory를 persistent volume으로 mount한다.

- [ ] **Step 4: 재연결·중복 계약 검증**

신규 session과 기존 session의 subscribe 동작 및 QoS 1 중복이 command journal에서 재실행되지 않는 테스트를 추가한다.

- [ ] **Step 5: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/api test -- --runInBand && node --test tests/mqtt-production-config.node.mjs`

Commit: `fix(mqtt): preserve offline gateway commands`

### Task 3: Gateway reconnect 생명주기와 오류 경계

**Files:**
- Create: `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- Create: `apps/gateway/src/runtime/gateway-mqtt-runtime.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/index.test.ts`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Produces: `GatewayMqttRuntime.start()` / `stop()`
- Produces: heartbeat timer single instance, session-aware subscribe, topic handler error callback

- [ ] **Step 1: reconnect 실패 테스트 작성**

세 번 reconnect해도 활성 heartbeat timer가 하나이고, handler reject가 unhandled rejection 대신 `onMessageError`로 전달되는지 fake timer로 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- --run src/runtime/gateway-mqtt-runtime.test.ts`

- [ ] **Step 3: runtime 추출과 single-flight 구현**

timer handle을 소유하고 reconnect 전 clear하며 topic handler를 `Promise.resolve(...).catch(...)` 경계로 실행한다.

- [ ] **Step 4: index 전환과 종료 정리**

기존 inline listener를 runtime으로 교체하고 SIGTERM에서 timer와 client listener를 정리한다.

- [ ] **Step 5: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway typecheck`

Commit: `fix(gateway): harden mqtt reconnect lifecycle`

### Task 4: 인증서 rotation runtime 전환과 실상태 healthcheck

**Files:**
- Modify: `apps/gateway/src/identity/certificate-rotation.ts`
- Modify: `apps/gateway/src/identity/certificate-rotation.test.ts`
- Modify: `apps/gateway/src/health/appliance-health.ts`
- Modify: `apps/gateway/src/health/appliance-health.test.ts`
- Modify: `apps/gateway/docker/healthcheck.sh`
- Modify: `apps/gateway/src/index.ts`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`

**Interfaces:**
- Produces: rotation 성공 후 `activateMqttIdentity()` callback
- Produces: health state의 `lastHeartbeatPublishedAt`, `bluezAttached`, `hciPowered`, `mappingValid`

- [ ] **Step 1: rotation과 health 실패 테스트 작성**

새 MQTT identity probe 성공 후 runtime reconnect가 한 번 호출되고 실패하면 기존 identity가 유지되는지 검증한다. 선언형 boolean이 아니라 probe 결과로 health가 결정되는지 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- --run src/identity/certificate-rotation.test.ts src/health/appliance-health.test.ts`

- [ ] **Step 3: 안전한 MQTT client 교체 구현**

새 client가 mTLS connect·subscribe 준비를 마친 뒤 runtime reference를 원자 교체하고 이전 client를 종료한다.

- [ ] **Step 4: health probe 구현**

D-Bus owner, attached node path, HCI powered, mapping 파일 parse와 마지막 heartbeat publish freshness를 검사한다.

- [ ] **Step 5: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway typecheck && sh -n apps/gateway/docker/healthcheck.sh`

Commit: `fix(gateway): activate rotated identity and real health probes`

### Task 5: BLE Mesh 주기 상태와 Health 동기화

**Files:**
- Modify: `apps/gateway/src/mesh/bluez-config-codec.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-codec.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-client.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-client.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-model-codec.ts`
- Modify: `apps/gateway/src/mesh/bluez-model-codec.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `packages/shared/src/mqtt.ts`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Produces: 60초 OnOff/Lightness/Health publication 설정
- Produces: `onFixtureStatus(listener)`와 fixture-state MQTT v2 event 변환

- [ ] **Step 1: publication period와 status codec 실패 테스트 작성**

60초 Mesh period encoding, Generic OnOff/Lightness/Health status decode와 source mapping을 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- --run src/mesh/bluez-config-codec.test.ts src/mesh/bluez-model-codec.test.ts`

- [ ] **Step 3: Config Client에 Health와 publication 구현**

Health Server model을 구성하고 OnOff/Lightness publication period를 60초로 설정한다.

- [ ] **Step 4: 자발 status 수신과 MQTT 변환 구현**

BlueZ application message event를 source address mapping으로 fixture ID에 연결하고 online/fault 상태를 gateway-scoped fixture-state로 발행한다.

- [ ] **Step 5: startup resync와 펌웨어 publication 보완**

알려진 node의 상태를 조회하고 펌웨어 상태 publication이 구성된 주기에 맞게 동작하도록 한다.

- [ ] **Step 6: 검증과 커밋**

Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/gateway test && scripts/esp32-h2-build.sh`

Commit: `feat(mesh): synchronize periodic fixture health state`

### Task 6: 조명 등록 소유권과 실제 초기 상태

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `apps/api/src/registration/registration.controller.ts`
- Modify: `apps/api/src/registration/registration.service.ts`
- Modify: `apps/api/src/registration/registration.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/settings.md`

**Interfaces:**
- Consumes: Gateway heartbeat와 fixture-state 계약
- Produces: `CreateRegistrationSessionInput { siteId, floorId, gatewayId }`
- Produces: `provisioning_waiting_state` 초기 상태와 device UUID 충돌 오류

- [ ] **Step 1: 소유권·초기 상태 실패 테스트 작성**

다른 현장 Gateway 거부, offline Gateway 거부, 기존 device UUID의 cross-site 재사용 거부와 Status 전 online 금지를 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api test -- --runInBand src/registration/registration.service.spec.ts src/mqtt/mqtt.service.spec.ts`

- [ ] **Step 3: 세션 입력과 검증 구현**

첫 Gateway 자동 선택을 제거하고 명시 gateway ID와 90초 heartbeat를 검사한다.

- [ ] **Step 4: 실제 초기 상태 구현**

provisioning 완료 시 fixture를 미확정 상태로 만들고 첫 장비 Status에서만 online/fault, 밝기와 lastSeenAt을 확정한다.

- [ ] **Step 5: 문서와 통합 검증**

Run: `pnpm --filter @led-control/api test -- --runInBand && pnpm --filter @led-control/api typecheck`

Commit: `fix(registration): require owned gateway and real initial state`

### Task 7: 조명 등록 UI와 post-provision identify

**Files:**
- Modify: `apps/web/src/features/registration/RegistrationPanel.tsx`
- Create: `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- Modify: `apps/web/src/api/registration.ts`
- Modify: `apps/api/src/registration/registration.service.ts`
- Modify: `apps/api/src/registration/registration.service.spec.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `packages/shared/src/mqtt.ts`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/settings.md`

**Interfaces:**
- Produces: 층·Gateway 선택, fixture name/ratedWatt/x/y 입력 UI
- Produces: identify result MQTT event와 `confirmed | failed` 상태

- [ ] **Step 1: 등록 UI와 identify 실패 테스트 작성**

첫 항목 자동 고정이 없고 사용자가 층/Gateway/조명 정보를 선택·수정하며 실패 결과가 `점멸 중`에 머물지 않는지 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/web test -- --run src/features/registration/RegistrationPanel.test.tsx`

- [ ] **Step 3: 선택·입력 UI 구현**

dashboard의 모든 층/Gateway를 선택지로 제공하고 후보별 draft를 유지한다.

- [ ] **Step 4: post-provision identify 구현**

미등록 단계에서는 UUID/serial/RSSI 안내만 제공하고 model bind 이후 Health Attention 요청과 성공·실패 결과를 저장한다.

- [ ] **Step 5: 검증과 커밋**

Run: `pnpm --filter @led-control/web test && pnpm --filter @led-control/api test -- --runInBand src/registration/registration.service.spec.ts && pnpm --filter @led-control/gateway test`

Commit: `feat(registration): select targets and confirm provisioned lights`

### Task 8: 모니터링 도형 렌더링과 기본 현장 정합성

**Files:**
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `apps/api/src/sites/sites.service.spec.ts`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/api/src/energy/energy.service.ts`
- Modify: `apps/api/src/energy/energy.service.spec.ts`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/statistics.md`

**Interfaces:**
- Produces: dashboard floor의 `mapObjects` 배열
- Produces: 서비스 전체의 동일한 stable default site 선택 규칙

- [ ] **Step 1: 도형과 기본 현장 실패 테스트 작성**

zIndex 순 도형 응답, rectangle/triangle/line/text 읽기 전용 렌더링과 dashboard/energy의 동일 default site를 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api test -- --runInBand src/sites/sites.service.spec.ts src/energy/energy.service.spec.ts && pnpm --filter @led-control/web test -- --run src/features/monitoring/FloorMap.test.tsx`

- [ ] **Step 3: API와 SVG overlay 구현**

도형을 좌표계 기반 SVG로 렌더링하고 pointer event를 차단해 조명 선택을 방해하지 않게 한다.

- [ ] **Step 4: default site 규칙 통일**

SiteAccess 결과를 직접 쓰지 않고 이름과 ID의 stable ordering을 공통 helper로 선택한다.

- [ ] **Step 5: 검증과 커밋**

Run: `pnpm --filter @led-control/api test -- --runInBand && pnpm --filter @led-control/web test`

Commit: `feat(monitoring): render floor objects consistently`

### Task 9: BLE Mesh group address 제어

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260811150000_add_mesh_group_address/migration.sql`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`
- Modify: `packages/shared/src/mqtt.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-codec.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-client.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.test.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Produces: `FixtureGroup.meshAddress`와 model subscription
- Produces: group single-send 및 bounded-concurrency result verification

- [ ] **Step 1: group address와 timeout 실패 테스트 작성**

site별 주소 uniqueness, group 단일 Send, 상태 조회 결과와 기존 그룹 fallback의 대상 수 비례 timeout을 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- --run src/mesh/bluez-mesh-adapter.test.ts src/commands/gateway-command-handler.test.ts`

- [ ] **Step 3: DB와 MQTT 계약 구현**

group address를 dispatch payload에 포함하고 Gateway별 대상만 전달한다.

- [ ] **Step 4: subscription과 group Send 구현**

Config Model Subscription Add를 구현하고 group address로 unacknowledged Lightness Set 후 제한된 상태 조회를 수행한다.

- [ ] **Step 5: fallback과 검증**

기존 null address 그룹은 동시성 제한 개별 명령으로 처리하고 전체 timeout을 대상 수에 맞춘다.

- [ ] **Step 6: 검증과 커밋**

Run: `pnpm --filter @led-control/api test -- --runInBand && pnpm --filter @led-control/gateway test && pnpm typecheck`

Commit: `feat(control): use mesh group addresses safely`

### Task 10: 실제 Gateway HIL step 실행기

**Files:**
- Create: `apps/gateway/scripts/hil-step.ts`
- Create: `apps/gateway/scripts/hil-step.test.ts`
- Create: `apps/gateway/scripts/pki-step.ts`
- Create: `apps/gateway/scripts/pki-step.test.ts`
- Modify: `apps/gateway/package.json`
- Modify: `apps/gateway/docker/Dockerfile`
- Modify: `scripts/gateway-appliance-build.sh`
- Modify: `docs/runbooks/production-device-lab.md`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`

**Interfaces:**
- Produces: `/opt/led-control/bin/hil-step <step>`
- Produces: `/opt/led-control/bin/pki-step <step>`
- Produces: secret 없는 단일 JSON stdout와 단계별 exit code

- [ ] **Step 1: step command 실패 테스트 작성**

필수 환경 변수, timeout, stdout JSON, secret redaction, non-zero 실패와 각 단계 command adapter를 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- --run scripts/hil-step.test.ts scripts/pki-step.test.ts`

- [ ] **Step 3: 실제 API·MQTT·system command step 구현**

shell 문자열을 사용하지 않고 argv 배열로 claim부터 ACL negative까지 실행하며 결과를 schema로 검증한다.

- [ ] **Step 4: appliance 포함과 runbook 갱신**

build artifact에 실행기를 포함하고 `/opt/led-lab/bin` 호환 symlink 또는 runbook 경로를 하나로 통일한다.

- [ ] **Step 5: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test && scripts/gateway-appliance-build.sh`

Commit: `feat(gateway): add production hardware hil steps`

### Task 11: 전체 회귀, 문서와 양산 판정

**Files:**
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-08-11-production-integration-completion.md`
- Create: `.superpowers/sdd/2026-08-11-production-integration-completion/final-review.md`

**Interfaces:**
- Consumes: Task 1~10의 최종 코드와 테스트
- Produces: 자동 검증과 실기 검증을 분리한 최종 판정

- [ ] **Step 1: 실제 backend browser E2E 실행**

PostgreSQL, Redis, API와 Web을 실제로 실행하고 `E2E_REAL_AUTH=true` 로그인, 현장 선택, 등록 API 권한과 도면 반영을 검증한다.

- [ ] **Step 2: 전체 자동 검증**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @led-control/web build && pnpm --filter @led-control/api build && git diff --check`

- [ ] **Step 3: 펌웨어·Gateway artifact 검증**

Run: `scripts/esp32-h2-build.sh && scripts/gateway-appliance-build.sh`

- [ ] **Step 4: 문서 완료 상태 갱신**

실제로 구현한 부분 구현 항목만 완료로 이동하고 기존 제외·미구현 목록은 유지한다. 실장비 로그가 없으면 `코드 완료·실기 미검증`으로 기록한다.

- [ ] **Step 5: 전체 branch 리뷰와 보완**

보안, tenant 격리, MQTT 내구성, DB migration, 실제 장비 계약과 테스트 무결성을 검토하고 모든 load-bearing finding을 수정한다.

- [ ] **Step 6: 최종 검증과 커밋**

Commit: `docs: complete production integration hardening`

## 완료 조건

- 완료 기능을 과거 상태로 설명하는 문서가 남지 않는다.
- Gateway offline과 broker 재시작 중 QoS 1 명령이 유실되지 않는다.
- reconnect 후 heartbeat와 handler가 중복되지 않고 rotation 인증서가 runtime에 반영된다.
- 정상 조명이 publication 부재로 120초 후 offline 처리되지 않는다.
- 실제 Status 전 fixture를 임의 online/60%로 만들지 않는다.
- 사용자가 층, Gateway와 조명 정보를 선택해 등록하고 post-provision identify 결과를 확인한다.
- 에디터 도형이 모니터링에서 읽기 전용으로 표시된다.
- 그룹 제어가 group address 또는 안전한 bounded fallback으로 처리된다.
- HIL runner가 참조하는 실제 step 실행 파일이 appliance에 포함된다.
- 전체 자동 검증 결과와 실장비 미검증 항목이 명확히 분리된다.
