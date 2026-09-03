# Frontend Developer Code Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프론트엔드 개발자가 최초 설치, Gateway onboarding, BLE Mesh 등록과 상태 회신을 코드로 따라갈 수 있도록 계층형 문서와 핵심 코드 주석을 제공한다.

**Architecture:** 동작과 공유 계약을 바꾸지 않는다. README는 시스템 지도를, 계층별 README는 runtime 책임과 용어를, 코드 주석은 외부 경계와 상태 보존의 이유를 설명한다.

**Tech Stack:** Markdown, TypeScript/NestJS, Prisma, MQTT.js, BlueZ D-Bus, C, ESP-IDF, BLE Mesh, LEDC PWM, NVS.

**Spec:** `docs/superpowers/specs/2026-09-03-frontend-developer-code-guide-design.md`

**실행 상태:** Task 1~5 완료. 상세 실행 기록은 `.superpowers/sdd/2026-09-03-frontend-developer-code-guide/progress.md`에 유지한다.

## Global Constraints

- 기존 작업 트리의 사용자 변경을 덮어쓰거나 되돌리지 않는다. 각 파일 수정 전 `git diff -- <file>`을 읽고 기존 변경 hunk는 수정하지 않는다.
- 현재 이미 변경된 파일은 `git add -p`로 이번 작업의 주석·문서 hunk만 선택해 stage한다. commit 직전 `git diff --cached`로 사용자 hunk가 포함되지 않았는지 확인한다.
- 주석은 한국어 평이한 용어를 우선하고, 기술 용어는 최초 등장 때만 영문을 괄호로 병기한다.
- 주석은 왜 필요한지, 어떤 실패를 막는지, 다음 계층으로 무엇을 넘기는지를 설명한다.
- 인증서 private key, claim code, token 원문을 새 문서나 주석에 넣지 않는다.
- API, Prisma schema, MQTT topic/payload, BLE Mesh opcode·주소, 펌웨어 동작은 변경하지 않는다.
- 실제 Pi/ESP32-H2 HIL과 자동 테스트 결과를 같은 의미로 기록하지 않는다.

---

## File Structure

- `README.md`: 전체 시스템 지도와 설치·등록·상태 회신 읽기 순서.
- `apps/api/README.md`: 새 API 입문 문서. Controller, Service, Prisma transaction, MQTT consumer 설명.
- `apps/gateway/README.md`: Raspberry Pi Gateway의 MQTT, BlueZ D-Bus, BLE Mesh와 local journal/outbox 경계.
- `apps/esp32-h2-firmware/README.md`: ESP-IDF, NVS, GPIO, PWM, callback, provisioning 용어와 코드 지도.
- `apps/api/src/{main.ts,gateway-onboarding/gateway-onboarding.service.ts,pki/manufacturing-enrollment.service.ts,registration/registration.service.ts,mqtt/mqtt.service.ts}`: API 핵심 주석.
- `apps/gateway/src/{index.ts,config/resolve-assignment.ts,runtime/gateway-mqtt-runtime.ts,mesh/bluez-mesh-adapter.ts}`: Gateway 핵심 주석.
- `apps/esp32-h2-firmware/main/{app_main.c,ble_mesh_node.c,control_state.c,led_driver.c,persistent_state.c}`: firmware lifecycle 주석.

### Task 1: 전체 지도와 API 입문 문서

**Files:**
- Modify: `README.md`
- Create: `apps/api/README.md`
- Reference: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/prisma/schema.prisma`, `packages/shared/src/gateway-contracts.ts`

**Interfaces:**
- Consumes: 현행 runtime port와 shared Gateway 메시지 계약.
- Produces: Web → API → MQTT → Gateway → BLE Mesh → ESP32의 읽기 지도.

- [x] **Step 1: README의 기존 hunk와 삽입 위치를 확인한다.**
  - Run: `git diff -- README.md && sed -n '1,160p' README.md`
  - Expected: 기존 설치 명령을 바꾸지 않고 `프론트엔드 개발자를 위한 코드 지도` 섹션을 독립적으로 넣을 위치를 정한다.

- [x] **Step 2: 루트 README에 전체 시스템 지도를 작성한다.**
  - Web은 HTTP 요청과 화면 상태, API는 권한·업무 규칙·DB transaction, MQTT broker는 비동기 전달, Gateway는 MQTT/BLE Mesh 변환, ESP32는 BLE Mesh/PWM/Status를 맡는다고 설명한다.
  - 빠른 로컬 소프트웨어 실행과 제조 identity가 필요한 실장비 설치를 분리하고, 각 흐름의 실제 파일 링크를 넣는다.

- [x] **Step 3: API README를 작성한다.**
  - `route handler → Controller`, `domain/use-case → Service`, `query/mutation 저장소 → Prisma transaction`, `event listener → MQTT consumer` 대응 표를 만든다.
  - operator bootstrap, customer site/admin, Gateway claim, registration session, fixture-state ingestion을 `Controller → Service → 저장 모델` 순서로 안내한다.

- [x] **Step 4: 링크와 공백을 검증하고 task 파일만 커밋한다.**
  - Run: `rg -n '\]\([^)]*\)' README.md apps/api/README.md && git diff --check -- README.md apps/api/README.md`
  - Expected: 공백 오류가 없고 문서가 실제 파일을 가리킨다.
  - Commit: `git add -p README.md apps/api/README.md && git diff --cached && git commit -m "docs: add API beginner code guide"`

### Task 2: API 핵심 경로 주석

**Files:**
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts`
- Modify: `apps/api/src/pki/manufacturing-enrollment.service.ts`
- Modify: `apps/api/src/registration/registration.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Test: API typecheck와 existing focused test suites

**Interfaces:**
- Consumes: Task 1 API 용어와 NestJS/Prisma/MQTT 계약.
- Produces: HTTP/제조/claim/등록/MQTT 상태 수신의 외부 경계와 durable 처리 이유.

- [x] **Step 1: 기존 API hunk를 확인한다.**
  - Run: `git diff -- apps/api/src/main.ts apps/api/src/gateway-onboarding/gateway-onboarding.service.ts apps/api/src/pki/manufacturing-enrollment.service.ts apps/api/src/registration/registration.service.ts apps/api/src/mqtt/mqtt.service.ts`
  - Expected: 사용자 변경 행을 피하고 class, transaction, publish/subscribe 경계에만 주석을 넣는다.

- [x] **Step 2: API process와 claim transaction의 의도를 주석으로 설명한다.**
  - `main.ts`: HTTP/CORS/TLS와 background worker를 하나의 API process에 조립하는 이유.
  - `gateway-onboarding.service.ts`: `GatewayInventory → Gateway` 전환과 claim code 소비를 같은 transaction에서 확정해야 Pi bootstrap과 중복 claim 경합을 막는 이유.

- [x] **Step 3: 제조와 registration의 비동기 경계를 주석으로 설명한다.**
  - `manufacturing-enrollment.service.ts`: Pi private key를 서버에 보내지 않고 CSR만 서명하는 이유, claim code는 hash로만 저장하는 이유.
  - `registration.service.ts`: UI `accepted`는 물리 provisioning 완료가 아니라 Gateway 작업 예약이라는 점, Mesh address 예약과 outbox를 같은 transaction에 기록하는 이유.

- [x] **Step 4: MQTT 수신의 중복 방지와 application ACK를 주석으로 설명한다.**
  - `mqtt.service.ts`: broker PUBACK은 전송 확인일 뿐 DB 반영 확인이 아니라는 점, event ID/sequence/scope 검증과 DB commit 뒤 application ACK의 순서를 설명한다.

- [x] **Step 5: API 검증 후 task 파일만 커밋한다.**
  - Run: `pnpm --filter @led-control/api typecheck`
  - Run: `pnpm --filter @led-control/api test -- --runInBand src/gateway-onboarding/gateway-onboarding.service.spec.ts src/pki/manufacturing-enrollment.service.spec.ts src/registration/registration.service.spec.ts src/mqtt/mqtt.service.spec.ts`
  - Run: `git diff --check -- apps/api`
  - Expected: TypeScript 오류가 없고 기존 assertions가 통과한다.
  - Commit: `git add -p apps/api/src/main.ts apps/api/src/gateway-onboarding/gateway-onboarding.service.ts apps/api/src/pki/manufacturing-enrollment.service.ts apps/api/src/registration/registration.service.ts apps/api/src/mqtt/mqtt.service.ts && git diff --cached && git commit -m "docs: explain API installation flow"`

### Task 3: Gateway 문서와 adapter 주석

**Files:**
- Modify: `apps/gateway/README.md`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/config/resolve-assignment.ts`
- Modify: `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Test: Gateway typecheck와 existing Gateway tests

**Interfaces:**
- Consumes: API의 gateway-scoped MQTT command와 assignment.
- Produces: HTTPS bootstrap, mTLS MQTT, BlueZ D-Bus, BLE Mesh, local persistence 설명.

- [x] **Step 1: Gateway 기존 hunk를 확인한다.**
  - Run: `git diff -- apps/gateway/README.md apps/gateway/src/index.ts apps/gateway/src/config/resolve-assignment.ts apps/gateway/src/runtime/gateway-mqtt-runtime.ts apps/gateway/src/mesh/bluez-mesh-adapter.ts`
  - Expected: existing HIL/automation 변경을 보존하고 설명과 주석 위치를 정한다.

- [x] **Step 2: Gateway README에 역할 지도와 프론트엔드 비유를 추가한다.**
  - Gateway를 현장용 protocol adapter로 비유하되 browser가 아닌 Raspberry Pi process라는 차이를 설명한다.
  - MQTT는 cloud 방향, BlueZ D-Bus/BLE Mesh는 조명 방향, journal/outbox는 전원·인터넷 장애 후 재시도용 local persistence라고 설명한다.

- [x] **Step 3: 시작·assignment·MQTT 재연결 주석을 추가한다.**
  - `index.ts`: dependency 조립 순서와 command handler가 어떤 event를 어느 저장소로 넘기는지.
  - `resolve-assignment.ts`: claim 전 `unclaimed` 재시도, claim 후 0600 atomic local assignment 저장의 역할.
  - `gateway-mqtt-runtime.ts`: reconnect generation과 serialized operation이 이전 connection callback의 뒤늦은 실행을 막는 이유.

- [x] **Step 4: BlueZ adapter 변환 경계에 주석을 추가한다.**
  - `bluez-mesh-adapter.ts`: D-Bus가 Pi의 Bluetooth Mesh daemon API라는 점, fixture ID/Mesh unicast address mapping, send만으로 성공 처리하지 않고 Lightness/Health Status를 기다리는 이유.

- [x] **Step 5: Gateway 검증 후 task 파일만 커밋한다.**
  - Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test && git diff --check -- apps/gateway`
  - Expected: unit/mock 결과와 실제 Pi/BlueZ/ESP32 RF HIL의 차이를 README에 유지한다.
  - Commit: `git add -p apps/gateway/README.md apps/gateway/src/index.ts apps/gateway/src/config/resolve-assignment.ts apps/gateway/src/runtime/gateway-mqtt-runtime.ts apps/gateway/src/mesh/bluez-mesh-adapter.ts && git diff --cached && git commit -m "docs: explain gateway installation flow"`

### Task 4: ESP32-H2 문서와 firmware lifecycle 주석

**Files:**
- Modify: `apps/esp32-h2-firmware/README.md`
- Modify: `apps/esp32-h2-firmware/main/app_main.c`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- Modify: `apps/esp32-h2-firmware/main/control_state.c`
- Modify: `apps/esp32-h2-firmware/main/led_driver.c`
- Modify: `apps/esp32-h2-firmware/main/persistent_state.c`
- Test: host control-state and mesh transaction tests

**Interfaces:**
- Consumes: Gateway가 provisioning 뒤 보내는 Generic OnOff, Light Lightness, Health, Sensor BLE Mesh message.
- Produces: 부팅/callback, state/PWM, NVS persistence, BLE Mesh status publication 설명.

- [x] **Step 1: 기존 firmware hunk를 확인한다.**
  - Run: `git diff -- apps/esp32-h2-firmware/README.md apps/esp32-h2-firmware/main/app_main.c apps/esp32-h2-firmware/main/ble_mesh_node.c apps/esp32-h2-firmware/main/control_state.c apps/esp32-h2-firmware/main/led_driver.c apps/esp32-h2-firmware/main/persistent_state.c`
  - Expected: current vehicle-sensor 구현을 보존하고 조명 lifecycle과 나란히 설명할 위치를 정한다.

- [x] **Step 2: firmware README에 용어 사전과 코드 읽기 순서를 추가한다.**
  - ESP-IDF, firmware, flash/NVS, GPIO, PWM, FreeRTOS task, callback, provisioning, BLE Mesh model, Status publication을 한 문장씩 정의한다.
  - `app_main.c → control_state.c → led_driver.c → persistent_state.c → ble_mesh_node.c` 순서의 이유를 설명한다.

- [x] **Step 3: 부팅·state·PWM·NVS 주석을 추가한다.**
  - `app_main.c`: boot 순서와 NVS 복구.
  - `control_state.c`: memory state와 persistence 분리.
  - `led_driver.c`: 0~100 brightness에서 LEDC duty 변환.
  - `persistent_state.c`: flash 수명 보호 2초 debounce.

- [x] **Step 4: BLE Mesh callback과 RF 상태 publication 주석을 추가한다.**
  - `ble_mesh_node.c`: Config Server가 provisioner 설정을 받는 입구, Generic OnOff/Lightness callback이 API handler처럼 호출되는 점, group jitter가 다수 노드 동시 응답의 RF 충돌을 줄이는 이유.
  - vehicle sensor callback: interrupt context에서 BLE 송신 대신 worker handoff를 하는 이유.

- [x] **Step 5: host firmware tests 후 task 파일만 커밋한다.**
  - Run: `cc -std=c11 -Wall -Wextra -Werror apps/esp32-h2-firmware/test/control_state_test.c apps/esp32-h2-firmware/main/control_state.c apps/esp32-h2-firmware/main/mesh_state.c apps/esp32-h2-firmware/main/mesh_publication_jitter.c -o /tmp/led-control-state-test && /tmp/led-control-state-test`
  - Run: `cc -std=c11 -Wall -Wextra -Werror apps/esp32-h2-firmware/test/mesh_transaction_cache_test.c apps/esp32-h2-firmware/main/mesh_transaction_cache.c -o /tmp/led-mesh-transaction-test && /tmp/led-mesh-transaction-test`
  - Run: `git diff --check -- apps/esp32-h2-firmware`
  - Expected: host tests가 통과한다. 실제 flash, target build, RF HIL은 실행하지 않는다.
  - Commit: `git add -p apps/esp32-h2-firmware/README.md apps/esp32-h2-firmware/main/app_main.c apps/esp32-h2-firmware/main/ble_mesh_node.c apps/esp32-h2-firmware/main/control_state.c apps/esp32-h2-firmware/main/led_driver.c apps/esp32-h2-firmware/main/persistent_state.c && git diff --cached && git commit -m "docs: explain firmware lifecycle"`

### Task 5: 문서 수렴과 검증 기록

**Files:**
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-03-frontend-developer-code-guide.md`

**Interfaces:**
- Consumes: Tasks 1~4의 실제 변경과 검증 결과.
- Produces: 초보자 코드 가이드 완료 범위와 실장비 검증 한계 기록.

- [x] **Step 1: 상태판과 기존 hunk의 충돌 여부를 확인한다.**
  - Run: `git diff -- docs/project-status.md`
  - Expected: existing user hunk와 겹치지 않을 때만 문서화 작업 행을 추가한다. 겹치면 수정하지 않고 총괄에게 보고한다.

- [x] **Step 2: 상태판과 체크리스트를 완료 상태로 갱신한다.**
  - 상태판에는 `README/핵심 주석을 보강했고 API/Gateway typecheck 및 firmware host test를 실행했다. 실제 Pi/ESP32 HIL 결과는 추가하지 않았다.`를 기록한다.

- [x] **Step 3: 전체 diff를 독해 관점으로 검토한다.**
  - Run: `git diff --check && git diff -- README.md apps/api/README.md apps/gateway/README.md apps/esp32-h2-firmware/README.md apps/api/src apps/gateway/src apps/esp32-h2-firmware/main docs/project-status.md`
  - Expected: logic/contract 변경 없이 주석이 바로 뒤 외부 경계 또는 의도를 설명한다.
  - Commit: 실행하지 않음. 공유 작업 트리에 controller의 기존 미커밋 변경이 있어 문서 기록 파일도 커밋하지 않고 총괄 에이전트에게 인계한다.

## Plan Self-Review

- Spec coverage: 전체 지도와 API 문서는 Task 1, API 주석은 Task 2, Gateway 설명은 Task 3, firmware lifecycle은 Task 4, 상태 기록과 검증은 Task 5가 담당한다.
- Scope: 문서와 주석은 외부 동작을 바꾸지 않는다. 기존 typecheck, unit test, host test는 문법과 회귀 보호를 확인하는 용도다.
- Worktree safety: 모든 task는 변경 전 diff 검토, 선택적 stage, staged diff 검토 절차를 포함한다.
