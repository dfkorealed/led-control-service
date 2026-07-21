# LED 조명 관제 서비스

PKI 제조 등록 -> claim -> bootstrap -> MQTT 발급과 token 재사용, serial mismatch, disabled/revoked 차단은 실제 PostgreSQL E2E로 검증한다. HIL runner는 제조·부정 시험·재시작·rotation·2대 fingerprint·secret scan을 JSON 명령 배열로 3회 반복하며 실패 시 non-zero를 반환한다.

실물 Raspberry Pi/ESP32와 offline Root/Vault backup 승인 증거는 아직 확인하지 않았으므로 상태는 **코드 완료·실기 미검증**이다.

주차장 LED 조명 제어 및 모니터링 서비스의 MVP 1 구현 저장소입니다.

## 로컬 실장비 개발 환경

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
   BOOTSTRAP_OPERATOR_EMAIL='operator@example.com' \
   BOOTSTRAP_OPERATOR_NAME='운영자' \
   BOOTSTRAP_OPERATOR_PASSWORD='demo-password-1234' \
   pnpm --filter @led-control/api auth:bootstrap-operator
   ```

4. API와 Web을 실제 장비 모드로 실행합니다. 이 명령은 누락된 개발용 PKI와 `.env`의 `DEV_GATEWAY_ID`용 인증서를 생성하고, 8883 mTLS broker를 시작하고, 대기 중인 DB migration을 적용합니다. Raspberry Pi gateway와 ESP32-H2가 동작하지 않으면 조명 검색 결과는 0개가 정상입니다.

   ```bash
   pnpm dev
   ```

   API는 `4000`, Web은 `5173` 포트를 고정 사용한다. 기존 프로세스가 포트를 점유하거나 PostgreSQL/Redis가 꺼져 있으면 원인과 실행 명령을 시작 전에 출력한다. 최초 claim 전에는 `DEV_GATEWAY_ID`를 비워 API/Web 온보딩 모드로 실행한다. claim 후 DB에 생성된 실제 `Gateway.id`를 입력하고 `pnpm dev`를 재시작해야 로컬 MQTT ACL과 인증서 identity가 맞는다.

5. PC 웹 앱에 접속합니다.

   ```text
   http://localhost:5173
   ```

   데모 로그인 정보:

   ```text
   아이디: operator@example.com
   비밀번호: demo-password-1234
   초대 회원가입 코드: demo-invite-token
   ```

6. 제조 단계에서 발급한 gateway 인증서의 SHA-256 지문과 일회성 등록 코드를 원장에 적재합니다. 이 명령은 기존 원장을 덮어쓰지 않으며 같은 시리얼이나 인증서 지문이면 실패합니다.

   ```bash
   export ENROLL_GATEWAY_SERIAL='GW-RPI-001'
   export ENROLL_GATEWAY_CLAIM_CODE='출고 시 밀봉 제공한 일회성 코드'
   export ENROLL_GATEWAY_CERT_FINGERPRINT="$(openssl x509 -in /path/to/gateway.crt -noout -fingerprint -sha256 | cut -d= -f2)"
   pnpm gateway:enroll-inventory
   ```

   Web에서 현장과 층을 먼저 생성한 뒤 `게이트웨이 등록` 화면에 같은 시리얼과 일회성 코드를 입력합니다. claim 성공 후에만 gateway가 현장에 연결되고 조명 검색 화면이 열린다.

## 검증 명령

```bash
pnpm test
pnpm typecheck
pnpm --filter @led-control/web exec playwright test
```

## 실제 백엔드 로그인 E2E

아래 검증은 mock API가 아니라 실제 NestJS API, PostgreSQL, Redis, mTLS MQTT broker를 사용한다.
로컬에 Docker Desktop 또는 Homebrew 기반 PostgreSQL/Redis/Mosquitto가 먼저 준비되어 있어야 한다.

```bash
cp .env.example .env
scripts/dev-pki/create-ca.sh
pnpm docker:up
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api prisma:migrate --name auth
BOOTSTRAP_ORGANIZATION_NAME='DF Korea Service' BOOTSTRAP_OPERATOR_EMAIL='operator@example.com' BOOTSTRAP_OPERATOR_NAME='운영자' BOOTSTRAP_OPERATOR_PASSWORD='demo-password-1234' pnpm --filter @led-control/api auth:bootstrap-operator
pnpm dev
```

다른 터미널에서 실제 로그인 E2E를 실행한다.

```bash
pnpm --filter @led-control/web e2e:auth:real
```

데모 로그인 정보:

```text
아이디: operator@example.com
비밀번호: demo-password-1234
```

## 현재 범위

- PC 웹 관제 shell
- 초대 기반 회원가입, 로그인, 자동 로그인 session
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

- 로그인 폼의 데모 이메일, 비밀번호, 초대 코드 기본값은 이번 작업의 명시적 제외 항목으로 유지한다. 외부 고객 배포 전 반드시 빈 값으로 바꾼다.
- `apps/web/src/test`, `apps/gateway/test`, Playwright route interception은 자동 회귀 테스트에만 사용하며 제품 빌드와 Raspberry Pi image에는 포함하지 않는다. 이 항목은 양산 코드 우회가 아니므로 유지한다.
- `*.spec.ts`의 `mock-node-*`, `GW-DEMO-*` 문자열은 메시지 파서와 tenant 검증용 불변 입력값이다. 실행 프로세스나 DB seed가 아니며 테스트에서만 유지한다.
- `gateway:enroll-inventory`는 실험실과 소량 생산에서 쓰는 비파괴 제조 원장 적재 명령이다. 제조 PKI/ERP가 serial, 인증서 지문, 일회성 claim code hash를 직접 발급·감사하는 시점에 CLI를 제거한다.
- 로컬 개발 CA와 `DEV_GATEWAY_ID` 인증서는 실험실 broker 전용이다. 운영에서는 제조 device certificate, gateway claim, bootstrap assignment, 운영 CA 발급으로 교체한다.
- gateway journal의 과거 형식 migration은 배포된 모든 gateway가 새 형식으로 전환되고 24시간 idempotency 보존 기간이 지난 뒤 제거한다.
- 예상 전력은 정격 전력, 현재 밝기, 일 12시간 점등 가정이다. 실제 전력 계측과 시간대별 적산이 도입되면 이 계산 경로를 교체한다.
- HIL runner의 `HIL_*_COMMAND_JSON` 단계 실행기 연결부는 실제 Pi와 두 노드의 반복 시험을 자동화하기 위해 유지한다. 표준 시험 장비 daemon/API가 도입되면 환경 변수 command hook을 제거하고 해당 API client로 교체한다.

실제 라즈베리파이 BLE Mesh provisioner/client adapter, 실기기 provisioning/model bind/group subscription 검증, 실제 OTA, 스케줄/이벤트 제어, 파일럿 설치 플로우는 후속 하드웨어 검증과 MVP 2/MVP 3 범위입니다.
