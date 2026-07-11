# LED 조명 관제 서비스

주차장 LED 조명 제어 및 모니터링 서비스의 MVP 1 구현 저장소입니다.

## MVP 1 로컬 데모

1. 의존성을 설치합니다.

   ```bash
   pnpm install
   ```

2. 로컬 인프라를 실행합니다. Docker가 없다면 macOS에서는 Homebrew로 실제 런타임을 설치해 사용할 수 있습니다.

   ```bash
   pnpm docker:up
   cp .env.example .env
   ```

   Docker 대신 Homebrew를 사용하는 경우:

   ```bash
   brew install postgresql@16 redis mosquitto
   brew services start postgresql@16
   brew services start redis
   /opt/homebrew/opt/mosquitto/sbin/mosquitto -c infra/mosquitto.conf
   cp .env.example .env
   /opt/homebrew/opt/postgresql@16/bin/psql -d postgres -c 'DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '\''led'\'') THEN CREATE ROLE led LOGIN PASSWORD '\''led'\'' CREATEDB; ELSE ALTER ROLE led WITH LOGIN PASSWORD '\''led'\'' CREATEDB; END IF; END $$;'
   /opt/homebrew/opt/postgresql@16/bin/createdb -O led led_control 2>/dev/null || true
   /opt/homebrew/opt/postgresql@16/bin/psql -d postgres -c "ALTER DATABASE led_control OWNER TO led;"
   ```

3. 데이터베이스를 준비합니다.

   ```bash
   pnpm --filter @led-control/api prisma:generate
   pnpm --filter @led-control/api prisma:migrate --name init
   pnpm --filter @led-control/api prisma:seed
   ```

4. API, Web, Mock 게이트웨이를 실행합니다.

   ```bash
   pnpm dev
   ```

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

## 검증 명령

```bash
pnpm test
pnpm typecheck
pnpm --filter @led-control/web exec playwright test
```

## 실제 백엔드 로그인 E2E

아래 검증은 mock API가 아니라 실제 NestJS API, PostgreSQL, Redis, MQTT broker를 사용한다.
로컬에 Docker Desktop 또는 Homebrew 기반 PostgreSQL/Redis/Mosquitto가 먼저 준비되어 있어야 한다.

```bash
pnpm docker:up
cp .env.example .env
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api prisma:migrate --name auth
pnpm --filter @led-control/api prisma:seed
pnpm --filter @led-control/api dev
```

다른 터미널에서 웹과 실제 로그인 E2E를 실행한다.

```bash
VITE_USE_MOCK_API=false pnpm --filter @led-control/web dev
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
- MQTT 기반 Mock 게이트웨이
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

실제 라즈베리파이 BLE Mesh provisioner/client adapter, 실기기 provisioning/model bind/group subscription 검증, 실제 OTA, 스케줄/이벤트 제어, 파일럿 설치 플로우는 후속 하드웨어 검증과 MVP 2/MVP 3 범위입니다.
