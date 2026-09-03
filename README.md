# LED 조명 관제 서비스

PKI 제조 등록 -> claim -> bootstrap -> MQTT 발급과 token 재사용, serial mismatch, disabled/revoked 차단은 실제 PostgreSQL E2E로 검증한다. HIL runner는 제조·부정 시험·재시작·rotation·2대 fingerprint·secret scan을 JSON 명령 배열로 3회 반복하며 실패 시 non-zero를 반환한다.

실물 Raspberry Pi/ESP32와 offline Root/Vault backup 승인 증거는 아직 확인하지 않았으므로 상태는 **코드 완료·실기 미검증**이다.

주차장 LED 조명 제어 및 모니터링 서비스의 MVP 1 구현 저장소입니다.

## 로컬 실장비 개발 환경

Lab Vault 실행, Lab Root 서명, 제조 station 발급부터 Raspberry Pi claim과 ESP32-H2 등록·제어까지 양산 흐름을 따르는 반복 시험은 [`docs/runbooks/device-lab-first-install.md`](docs/runbooks/device-lab-first-install.md)를 기준으로 한다. 아래 절차는 기존 개발 CA를 사용하는 빠른 로컬 실행 경로다.

1. 의존성을 설치합니다.

   ```bash
   pnpm install
   ```

2. `.env`와 로컬 인프라를 준비합니다. Docker를 사용하면 개발용 PKI를 먼저 생성한 뒤 PostgreSQL, Redis, mTLS Mosquitto, MinIO를 실행합니다.

   ```bash
   cp .env.example .env
   scripts/dev-pki/create-ca.sh
   pnpm docker:up
   ```

   Docker 대신 Homebrew를 사용하는 경우 PostgreSQL, Redis, Mosquitto를 설치합니다. PostgreSQL과 Redis만 서비스로 실행하며, mTLS Mosquitto는 `pnpm dev`가 현재 터미널의 자식 프로세스로 관리합니다.

   ```bash
   brew install postgresql@16 redis mosquitto
   brew services start postgresql@16
   brew services start redis
   cp .env.example .env
   /opt/homebrew/opt/postgresql@16/bin/psql -d postgres -c 'DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '\''led'\'') THEN CREATE ROLE led LOGIN PASSWORD '\''led'\'' CREATEDB; ELSE ALTER ROLE led WITH LOGIN PASSWORD '\''led'\'' CREATEDB; END IF; END $$;'
   /opt/homebrew/opt/postgresql@16/bin/createdb -O led led_control 2>/dev/null || true
   /opt/homebrew/opt/postgresql@16/bin/psql -d postgres -c "ALTER DATABASE led_control OWNER TO led;"
   ```

3. 데이터베이스 migration을 적용합니다.

   ```bash
   pnpm --filter @led-control/api prisma:generate
   pnpm --filter @led-control/api prisma:migrate --name init
   ```

   완전히 빈 DB의 최초 설치에서만 서비스 운영사 operator 계정을 생성합니다. 사용자가 한 명이라도 있으면 명령은 실패하며 기존 현장과 장비 데이터를 삭제하지 않습니다.

   ```bash
   BOOTSTRAP_ORGANIZATION_NAME='DF Korea Service' \
   BOOTSTRAP_OPERATOR_LOGIN_ID='operator_01' \
   BOOTSTRAP_OPERATOR_NAME='운영자' \
   BOOTSTRAP_OPERATOR_PASSWORD="$APPROVED_BOOTSTRAP_OPERATOR_PASSWORD" \
   pnpm --filter @led-control/api auth:bootstrap-operator
   ```

   기존 운영 DB의 `loginId` 전환은 유지보수 창에서 write freeze → 구버전 API와 worker 완전 drain → expand, backfill, contract migration 완료 → 새 `loginId` API/Web 배포 → smoke 확인과 write 재개 순서로 수행합니다. 전환 중 실행 가능한 API 인스턴스를 남기지 않으므로 `loginId IS NULL` 사용자가 로그인해야 하는 구간이 없으며 email 로그인 fallback은 배포하지 않습니다. 빈 DB는 migration 전체 적용 후 새 API/Web만 시작합니다.

4. API와 Web을 실제 장비 모드로 실행합니다. 이 명령은 누락된 개발용 PKI와 `.env`의 `DEV_GATEWAY_ID`용 인증서를 생성하고, 8883 mTLS broker를 시작하고, 대기 중인 DB migration을 적용합니다. Raspberry Pi gateway와 ESP32-H2가 동작하지 않으면 조명 검색 결과는 0개가 정상입니다.

   ```bash
   pnpm dev
   ```

   API는 `4000`, Web은 `5173` 포트를 고정 사용한다. 기존 프로세스가 포트를 점유하거나 PostgreSQL/Redis가 꺼져 있으면 원인과 실행 명령을 시작 전에 출력한다. 최초 claim 전에는 `DEV_GATEWAY_ID`를 비워 API/Web 온보딩 모드로 실행한다. claim 후 DB에 생성된 실제 `Gateway.id`를 입력하고 `pnpm dev`를 재시작해야 로컬 MQTT ACL과 인증서 identity가 맞는다.

5. PC 웹 앱에 접속합니다.

   ```text
   http://localhost:5173
   ```

   bootstrap한 operator의 아이디 예시는 `operator_01`입니다. 비밀번호는 승인된 secret manager 또는 현재 shell의 runtime 환경 변수로만 전달합니다. 공개 회원가입·초대 UI와 제품용 데모 기본 계정은 제공하지 않습니다.

6. Gateway 제조 등록은 deprecated inventory 적재 CLI가 아니라 station mTLS, Pi 내부 key 생성, 제조 enrollment API와 Vault 서명 절차를 사용합니다. 명령과 secret 취급의 정본은 [device lab first install의 제조 station 절차](docs/runbooks/device-lab-first-install.md#6-제조-station으로-pi-identity-발급)입니다. Web claim에는 제조 label의 시리얼과 일회성 code를 한 번만 사용합니다.

## 프론트엔드 개발자를 위한 코드 지도

이 서비스의 제어·상태 흐름은 `Web → API → MQTT broker → Gateway → BLE Mesh → ESP32-H2`입니다.

- **Web**은 사용자의 HTTP 요청을 만들고 화면 상태를 갱신합니다. 시작점은 [apps/web/src/main.tsx](apps/web/src/main.tsx)이며, 화면 기능은 `apps/web/src/features` 아래에 있습니다.
- **API**는 로그인·권한을 확인하고 업무 규칙을 적용한 뒤, 여러 레코드가 함께 바뀌는 작업은 DB transaction으로 묶습니다. NestJS 시작점과 모듈 목록은 [apps/api/src/main.ts](apps/api/src/main.ts), [apps/api/src/app.module.ts](apps/api/src/app.module.ts)에서 봅니다.
- **MQTT broker**는 API와 Gateway 사이의 비동기 메시지 전달을 담당합니다. API의 발행·수신 코드는 [apps/api/src/mqtt/mqtt.service.ts](apps/api/src/mqtt/mqtt.service.ts), 메시지 형식과 topic 생성 함수는 [packages/shared/src/gateway-contracts.ts](packages/shared/src/gateway-contracts.ts)에 있습니다.
- **Gateway**는 MQTT 명령과 상태 메시지를 BLE Mesh 동작으로 바꾸고, 반대 방향의 장비 상태를 MQTT로 올립니다. 실행 시작점은 [apps/gateway/src/index.ts](apps/gateway/src/index.ts)입니다.
- **ESP32-H2**는 BLE Mesh node와 PWM 밝기 제어, 상태 보고를 맡습니다. 펌웨어 시작점은 [apps/esp32-h2-firmware/main/app_main.c](apps/esp32-h2-firmware/main/app_main.c)이고, 밝기 제어는 [apps/esp32-h2-firmware/main/control_state.c](apps/esp32-h2-firmware/main/control_state.c)에 있습니다.

### 먼저 따라갈 두 흐름

**빠른 로컬 소프트웨어 확인**에서는 이 README의 [로컬 실장비 개발 환경](#로컬-실장비-개발-환경) 절차로 API, Web, 로컬 MQTT를 실행합니다. 실제 장비가 없으면 조명 검색 결과가 0개여도 정상입니다. 화면에서 명령을 보냈을 때는 Web의 요청이 API의 Controller와 Service를 거쳐 MQTT outbox에 기록되고, 이후 Gateway용 topic으로 발행되는 흐름을 추적합니다. API 계층의 파일별 역할과 입문 순서는 [apps/api/README.md](apps/api/README.md)를 봅니다.

**실장비 설치**는 제조 identity가 먼저 필요합니다. 제조 station이 Gateway identity를 발급하고, 고객 사이트의 admin이 Gateway를 claim한 뒤 bootstrap 응답으로 사이트·Gateway·MQTT 연결 정보를 받습니다. 이후 Gateway가 BLE Mesh 장비를 등록하고 상태를 보고합니다. 이 절차와 장비별 준비물은 [device lab first install](docs/runbooks/device-lab-first-install.md)에서 확인합니다. 실장비가 아직 검증되지 않은 범위는 이 문서의 [양산 장비 기반 진행 상태](#양산-장비-기반-진행-상태)를 함께 확인하세요.

## 검증 명령

```bash
pnpm test
pnpm typecheck
pnpm --filter @led-control/web exec playwright test
```

## 실제 백엔드 로그인 E2E

아래 검증은 mock API가 아니라 실제 NestJS API, 매 실행 새 PostgreSQL cluster, Redis와 lab CA 기반 mTLS Mosquitto를 사용한다. `initdb`, `postgres`, `psql`, `createdb`, `redis-server`, `redis-cli`, `mosquitto`, `openssl`, `lsof` 실행 파일이 PATH에 있어야 한다.

```bash
pnpm --filter @led-control/web e2e:auth:real
```

이 명령은 기존 5173/API/개발 DB를 재사용하지 않는다. 계정과 secret은 실행 중 임의 생성되고 trace/report에 원문을 남기지 않으며 종료 시 모든 전용 process group과 임시 데이터가 삭제된다.

## 현재 범위

- PC 웹 관제 shell
- `loginId` 로그인, 자동 로그인 session, viewer 초대 소비 호환 API. 공개 signup·초대 UI는 제공하지 않음
- 층별 2D 맵 기반 조명 상태 표시
- 개별/그룹 조명 수동 밝기 제어 명령 API
- Raspberry Pi gateway MQTT 실행 골격
- ESP32-H2 ESP-IDF 펌웨어 PWM 제어 및 BLE Mesh node 서버 모델 골격
- 추정 전력 사용량과 예상 전기료 API
- React Native WebView shell
- Hamina Planner 기반 RF/음영 검토 패널

## 양산 장비 기반 진행 상태

- 완료: gateway scoped MQTT v2 계약, 제조 gateway claim/bootstrap API, assignment `0600` 원자 저장
- 완료: 개발 PKI, MQTT mTLS/ACL/CRL 부정 시험, gateway별 command dispatch와 transactional outbox
- 완료: acceptance/device-status 2단계 ACK, 상태 event sequence, tenant scope 검증, gateway/fixture offline TTL
- 코드 및 build 완료·실기 미검증: ESP32-H2 NVS 밝기 복원, Health Attention identify, watchdog fault, 8초 물리 factory reset
- 테스트 도구 완료·실기 미검증: 2-node HIL runner와 실험실 runbook
- 미완료: Raspberry Pi BlueZ Phase 0, 실제 provision/bind/Lightness Status adapter, 2-node HIL 3회 연속 시험

현재 상태는 자동 검증 단계이며 양산 준비 완료가 아니다. 실제 장비 판정 절차는 `docs/runbooks/production-device-lab.md`, 상세 구현 계획과 체크 상태는 `docs/superpowers/plans/2026-07-11-production-device-foundation.md`를 기준으로 한다.

## 임시 유지 항목과 제거 조건

- `apps/web/src/test`, `apps/gateway/test`, Playwright route interception은 자동 회귀 테스트에만 사용하며 제품 빌드와 Raspberry Pi image에는 포함하지 않는다. 이 항목은 양산 코드 우회가 아니므로 유지한다.
- `*.spec.ts`의 `mock-node-*`, `GW-DEMO-*` 문자열은 메시지 파서와 tenant 검증용 불변 입력값이다. 실행 프로세스나 DB seed가 아니며 테스트에서만 유지한다.
- 로컬 개발 CA와 `DEV_GATEWAY_ID` 인증서는 실험실 broker 전용이다. 운영에서는 제조 device certificate, gateway claim, bootstrap assignment, 운영 CA 발급으로 교체한다.
- gateway journal의 과거 형식 migration은 배포된 모든 gateway가 새 형식으로 전환되고 24시간 idempotency 보존 기간이 지난 뒤 제거한다.
- 예상 전력은 정격 전력, 현재 밝기, 일 12시간 점등 가정이다. 실제 전력 계측과 시간대별 적산이 도입되면 이 계산 경로를 교체한다.
- HIL runner의 `HIL_*_COMMAND_JSON` 단계 실행기 연결부는 실제 Pi와 두 노드의 반복 시험을 자동화하기 위해 유지한다. 표준 시험 장비 daemon/API가 도입되면 환경 변수 command hook을 제거하고 해당 API client로 교체한다.

실제 라즈베리파이 BLE Mesh provisioner/client adapter, 실기기 provisioning/model bind/group subscription 검증, 실제 OTA, 스케줄/이벤트 제어, 파일럿 설치 플로우는 후속 하드웨어 검증과 MVP 2/MVP 3 범위입니다.
