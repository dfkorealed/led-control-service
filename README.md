# LED 조명 관제 서비스

주차장 LED 조명 제어 및 모니터링 서비스의 MVP 1 구현 저장소입니다.

## MVP 1 로컬 데모

1. 의존성을 설치합니다.

   ```bash
   pnpm install
   ```

2. 로컬 인프라를 실행합니다.

   ```bash
   pnpm docker:up
   cp .env.example .env
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

## 검증 명령

```bash
pnpm test
pnpm typecheck
pnpm --filter @led-control/web exec playwright test
```

## 현재 범위

- PC 웹 관제 shell
- 층별 2D 맵 기반 조명 상태 표시
- 개별 조명 밝기 제어 명령 API
- MQTT 기반 Mock 게이트웨이
- 추정 전력 사용량과 예상 전기료 API
- React Native WebView shell
- Hamina Planner 기반 RF/음영 검토 패널

실제 Go 게이트웨이, ESP32-H2 BLE Mesh 펌웨어, 실제 OTA, 파일럿 설치 플로우는 MVP 2와 MVP 3에서 별도로 구현합니다.
