# 프론트엔드 개발자를 위한 백엔드·Gateway·펌웨어 코드 안내 설계

## 목적

프론트엔드 개발 경력자는 React의 화면, 상태, API 호출에는 익숙하지만 NestJS의 요청 처리, MQTT 비동기 메시지, Raspberry Pi Gateway, ESP32-H2 펌웨어의 실행 모델은 처음일 수 있다. 이 작업은 현재 동작을 바꾸지 않고, 최초 설치와 조명 등록 흐름을 읽을 수 있는 문서와 코드 주석을 제공한다.

## 대상 독자와 용어 원칙

- 대상 독자는 프론트엔드 코드를 주로 읽고, 백엔드는 약간, 펌웨어는 거의 처음 접하는 개발자다.
- 낯선 용어가 처음 나오면 한국어 역할 설명을 먼저 쓰고, 필요한 경우에만 영문 용어를 괄호로 덧붙인다.
- `Controller`는 HTTP 요청 입구, `Service`는 업무 규칙, `Prisma`는 DB 접근 도구, `MQTT consumer`는 메시지 수신 event listener로 설명한다.
- 펌웨어는 `입력 → 메모리 상태 변경 → 하드웨어 출력 → 상태 응답` 순서로 설명한다.
- 주석은 코드가 무엇을 하는지 단순 반복하지 않고, 왜 필요한지, 어떤 실패를 막는지, 어느 계층과 연결되는지를 설명한다.

## 범위

### 문서

1. 루트 `README.md`
   - Web, API, MQTT broker, Gateway, ESP32-H2의 역할 지도
   - 로컬 소프트웨어 실행과 실장비 설치의 차이
   - 최초 설치·조명 등록·상태 회신의 읽기 순서

2. 새 `apps/api/README.md`
   - NestJS 요청 처리 흐름
   - 최초 운영자, 고객 현장, Gateway claim, 조명 등록의 API 경로
   - DB transaction, transactional outbox, MQTT ACK의 목적

3. `apps/gateway/README.md`
   - Gateway를 브라우저와 ESP32 사이의 현장용 protocol adapter로 설명
   - HTTPS bootstrap, mTLS MQTT, BlueZ D-Bus, BLE Mesh, local journal/outbox의 경계

4. `apps/esp32-h2-firmware/README.md`
   - ESP-IDF, NVS, GPIO, PWM, callback, FreeRTOS task의 입문 용어
   - 부팅, provisioning, 밝기 제어, 상태 publication, factory reset의 순서

### 코드 주석

주석 대상은 최초 설치와 조명 등록의 핵심 경로로 한정한다. 모든 함수에 설명을 덧붙이지 않는다.

- API: `main.ts`, `gateway-onboarding.service.ts`, `manufacturing-enrollment.service.ts`, `registration.service.ts`, `mqtt.service.ts`
- Gateway: `index.ts`, `config/resolve-assignment.ts`, `runtime/gateway-mqtt-runtime.ts`, `mesh/bluez-mesh-adapter.ts`
- Firmware: `app_main.c`, `ble_mesh_node.c`, `control_state.c`, `led_driver.c`, `persistent_state.c`

## 읽기 경험

문서는 같은 흐름을 세 단계로 나눠 설명한다.

1. **전체 지도**: 누가 어떤 데이터를 넘기는지 한 장의 흐름으로 파악한다.
2. **계층별 책임**: Web, API, Gateway, firmware의 책임과 저장 위치를 설명한다.
3. **코드 진입점**: 실제 파일을 읽는 순서와 그 파일에서 찾을 함수/상태를 안내한다.

예를 들어 밝기 제어는 Web의 버튼 클릭부터 시작하지만, 설치 안내에서는 제조 identity → claim → Gateway bootstrap → ESP32 provisioning → 상태 회신까지 먼저 설명한다. ESP32는 MQTT를 직접 사용하지 않고 BLE Mesh Status를 Gateway로 보내며, Gateway가 MQTT event로 변환한다는 경계를 명확히 한다.

## 주석 작성 규칙

- public interface, 외부 메시지, transaction 시작 지점, durable file/DB 기록, retry/idempotency, asynchronous callback 앞에 주석을 둔다.
- 장황한 줄 단위 번역 주석은 피한다.
- 보안 관련 값(인증서 private key, claim code, token)은 예시 값이나 원문을 새로 추가하지 않는다.
- 실제 장비 HIL로 확인되지 않은 항목은 자동 테스트/빌드 검증과 구분해 서술한다.
- 기존 동작, API/DB/MQTT/BLE Mesh 계약, 파일 소유 경계를 변경하지 않는다.

## 검증

- Markdown 링크와 문서의 파일 경로가 실제로 존재하는지 확인한다.
- TypeScript 주석 변경 뒤 API/Gateway typecheck를 실행한다.
- C 주석 변경 뒤 host firmware state test를 실행한다.
- 문서와 주석만 변경했음을 `git diff --check` 및 diff 검토로 확인한다.

## 완료 조건

- 프론트엔드 개발자가 README만 읽고 전체 설치 흐름과 계층별 책임을 설명할 수 있다.
- 핵심 코드 파일을 열었을 때 외부 이벤트, 상태 저장, 재시도·중복 방지의 이유를 주석으로 파악할 수 있다.
- 코드의 실행 결과와 공유 계약은 바뀌지 않는다.
