# MVP 1 클라우드·웹·Mock 게이트웨이 구현 계획

> **에이전트 작업자 필수 안내:** 이 계획을 실행할 때는 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`를 사용한다. 각 단계는 체크박스(`- [ ]`)로 진행 상태를 추적한다.

**목표:** LED 조명 관제 서비스의 첫 번째 MVP로 NestJS API, PostgreSQL/Redis 데이터 모델, React PC 웹 관제 화면, React Native WebView shell, MQTT 기반 mock 게이트웨이를 구현한다.

**아키텍처:** `pnpm` monorepo를 사용하고 `apps/api`, `apps/web`, `apps/mobile`, `apps/mock-gateway`, `packages/shared`로 책임을 나눈다. API는 영속 데이터와 명령 생성을 담당하고, Redis/MQTT는 실시간 상태와 장비 명령 흐름을 담당하며, Web은 공유 타입을 기반으로 모니터링·제어·통계·설정 화면을 렌더링한다.

**기술 스택:** TypeScript, pnpm workspaces, NestJS, Prisma, PostgreSQL, Redis, MQTT, React, Vite, React Query, Zustand, React Native, WebView, Vitest/Jest, Playwright.

---

## 1. 범위

이 문서는 MVP 1만 다룬다.

포함 범위:

- 로컬 개발용 monorepo 기반 구성
- NestJS API 기본 구조
- 초대 기반 회원가입, 로그인, 자동 로그인 session
- PostgreSQL/Prisma 도메인 모델
- Redis/MQTT 기반 실시간 상태·명령 흐름 준비
- React PC 웹 관제 UI
- 로그인/회원가입 화면과 인증 상태 기반 앱 진입
- React Native WebView shell
- Mock 게이트웨이 시뮬레이터
- 추정 전력 사용량 API와 통계 화면
- Hamina Planner 기반 RF 사전 검토 절차와 서비스 내 간이 음영 검토 화면

제외 범위:

- 실제 Go 게이트웨이
- ESP32-H2 펌웨어
- 실제 BLE Mesh 통신
- 실제 OTA 배포/롤백
- 파일럿 현장 설치·프로비저닝 플로우

위 제외 범위는 MVP 2, MVP 3 구현 계획에서 별도로 다룬다.

## 2. 목표 파일 구조

- 생성: `package.json` - 루트 스크립트와 workspace 명령
- 생성: `pnpm-workspace.yaml` - workspace 패키지 탐색 규칙
- 생성: `docker-compose.yml` - PostgreSQL, Redis, MQTT broker 로컬 실행
- 생성: `.env.example` - 로컬 환경변수 계약
- 생성: `packages/shared` - DTO, enum, MQTT topic, validation schema
- 생성: `apps/api` - NestJS API, Prisma schema, MQTT command publishing, REST endpoint
- 생성: `apps/mock-gateway` - MQTT 명령을 받아 조명 상태를 시뮬레이션하는 프로세스
- 생성: `apps/web` - PC 웹 관제 UI
- 생성: `apps/mobile` - WebView로 웹 앱을 띄우는 React Native shell

## 2.1 인증 확장 작업 구조

MVP 1 인증은 기존 MVP 1 코드 위에 다음 단위로 확장한다.

- 수정: `apps/api/prisma/schema.prisma` - `User` 인증 필드, `Invitation`, `Session` 모델 추가
- 수정: `apps/api/prisma/seed.ts` - 데모 사용자의 비밀번호 hash와 관리자 초대 seed 추가
- 생성: `apps/api/src/auth/*` - 로그인, 회원가입, 세션, 현재 사용자 조회, 로그아웃
- 수정: `apps/api/src/main.ts` - 쿠키 기반 인증을 위한 CORS credentials 허용
- 수정: `apps/api/src/commands/*` - 클라이언트가 보낸 `requestedBy` 대신 인증 session의 사용자 ID 사용
- 생성: `apps/web/src/features/auth/*` - 로그인과 초대 기반 회원가입 화면
- 생성/수정: `apps/web/src/api/auth.ts`, `apps/web/src/api/client.ts` - credentials 포함 요청과 인증 API client
- 수정: `apps/web/src/App.tsx` - 인증 상태에 따라 로그인/회원가입 또는 관제 화면 표시

인증 구현은 서버 저장 opaque session을 사용한다. 브라우저와 WebView에는 HttpOnly cookie만 저장하고, DB에는 session token hash만 저장한다. 자동 로그인은 같은 session 모델에서 만료 기간을 길게 부여하는 방식으로 처리한다.

향후 SaaS 전환 시에는 `Invitation`을 `가입 코드`, `현장 claim 코드`, `게이트웨이 QR/시리얼 claim` 흐름으로 확장한다. MVP 1에서는 공개 가입을 열지 않고 초대 토큰이 있는 사용자만 가입 가능하게 한다.

현재 구현 상태:

- 완료: `User.passwordHash`, `User.status`, `UserRole`, `UserStatus`, `Invitation`, `Session` 스키마 추가
- 완료: `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`
- 완료: HttpOnly cookie 기반 session 발급, session token hash 저장, 자동 로그인 만료 기간 확장
- 완료: 웹 로그인/회원가입 화면, 앱 진입 시 `/auth/me` 확인, API credentials 포함 요청
- 완료: 조명 제어 명령에서 인증 session 사용자 ID를 `requestedBy`로 사용
- 후속: 운영 관리자용 초대 생성 화면, 세밀 권한 guard, SaaS형 현장 claim 플로우

## 3. 공통 도메인 계약

아래 타입명과 topic 이름은 모든 앱에서 동일하게 사용한다.

```ts
export type FixtureStatus = "online" | "offline" | "fault";
export type CommandStatus = "pending" | "acknowledged" | "failed";

export interface FixtureState {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  status: FixtureStatus;
  rssi: number | null;
  hopCount: number | null;
  commandSuccessRate: number | null;
  lastSeenAt: string;
}

export interface DimmingCommandPayload {
  commandId: string;
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
  requestedBy: string;
  requestedAt: string;
}
```

MQTT topic:

```text
sites/{siteId}/commands/dimming
sites/{siteId}/events/fixture-state
sites/{siteId}/events/command-ack
sites/{siteId}/events/gateway-heartbeat
```

## 작업 1. Monorepo 기반 구성

**파일:**

- 생성: `package.json`
- 생성: `pnpm-workspace.yaml`
- 생성: `docker-compose.yml`
- 생성: `.env.example`
- 생성: `infra/mosquitto.conf`
- 생성: `packages/shared/package.json`
- 생성: `packages/shared/src/domain.ts`
- 생성: `packages/shared/src/mqtt.ts`
- 생성: `packages/shared/src/schemas.ts`
- 생성: `packages/shared/src/index.ts`
- 생성: `packages/shared/src/schemas.test.ts`

- [ ] 루트 `package.json`에 `dev`, `test`, `lint`, `typecheck`, `docker:up`, `docker:down` 스크립트를 추가한다.
- [ ] `pnpm-workspace.yaml`에 `apps/*`, `packages/*`를 workspace로 등록한다.
- [ ] `docker-compose.yml`에 PostgreSQL 16, Redis 7, Eclipse Mosquitto 2를 정의한다.
- [ ] `.env.example`에 `DATABASE_URL`, `REDIS_URL`, `MQTT_URL`, `API_PORT`, `WEB_PORT`, `WEB_PUBLIC_URL`을 정의한다.
- [ ] `packages/shared`에 공통 타입, MQTT topic helper, Zod schema를 추가한다.
- [ ] `dimmingCommandSchema`, `fixtureStateSchema`가 정상 payload를 통과시키고 잘못된 밝기 값을 거부하는 테스트를 작성한다.
- [ ] 실행: `pnpm install && pnpm --filter @led-control/shared test`
- [ ] 기대 결과: shared package 테스트가 통과한다.
- [ ] 커밋: `chore: scaffold monorepo foundation`

## 작업 2. API 기본 구조와 데이터베이스 스키마

**파일:**

- 생성: `apps/api/package.json`
- 생성: `apps/api/src/main.ts`
- 생성: `apps/api/src/app.module.ts`
- 생성: `apps/api/src/prisma/prisma.module.ts`
- 생성: `apps/api/src/prisma/prisma.service.ts`
- 생성: `apps/api/prisma/schema.prisma`
- 생성: `apps/api/prisma/seed.ts`

- [ ] NestJS API package를 생성하고 `dev`, `build`, `test`, `lint`, `typecheck`, `prisma:generate`, `prisma:migrate`, `prisma:seed` 스크립트를 추가한다.
- [ ] `main.ts`에서 CORS를 활성화하고 `API_PORT`로 서버를 실행한다.
- [ ] `PrismaService`와 `PrismaModule`을 추가한다.
- [ ] Prisma schema에 `Organization`, `User`, `Site`, `Floor`, `FloorPlan`, `Fixture`, `FixtureGroup`, `GroupFixture`, `Gateway`, `MeshNode`, `Command`, `EnergyUsage` 모델을 정의한다.
- [ ] `FixtureStatus`, `CommandStatus` enum을 정의한다.
- [ ] seed는 기존 demo 데이터를 지우고 조직 1개, 운영자 1명, 현장 1개, B2 층 1개, 도면 1개, 게이트웨이 1개, 조명 12개, 그룹 1개를 만든다.
- [ ] 실행: `pnpm docker:up`
- [ ] 실행: `cp .env.example .env`
- [ ] 실행: `pnpm --filter @led-control/api prisma:generate`
- [ ] 실행: `pnpm --filter @led-control/api prisma:migrate --name init`
- [ ] 실행: `pnpm --filter @led-control/api prisma:seed`
- [ ] 기대 결과: migration이 성공하고 seed 로그에 demo ID가 출력된다.
- [ ] 커밋: `feat(api): add domain database schema`

## 작업 3. 모니터링/설정용 API 조회 모델

**파일:**

- 생성: `apps/api/src/sites/sites.module.ts`
- 생성: `apps/api/src/sites/sites.controller.ts`
- 생성: `apps/api/src/sites/sites.service.ts`
- 생성: `apps/api/src/sites/sites.service.spec.ts`
- 수정: `apps/api/src/app.module.ts`

- [ ] `SitesService.getDefaultDashboard()` 테스트를 먼저 작성한다.
- [ ] 테스트는 site, floor, floor plan, fixtures, groups를 받아 `summary.totalFixtures`, `summary.onlineFixtures`, `summary.faultFixtures`, `summary.averageBrightness`가 계산되는지 검증한다.
- [ ] `GET /sites/default/dashboard` endpoint를 만든다.
- [ ] 반환값은 `site`, `summary`, `floors`, `groups`를 포함한다.
- [ ] fixture에는 `id`, `name`, `x`, `y`, `ratedWatt`, `brightness`, `status`, `lastSeenAt`을 포함한다.
- [ ] 실행: `pnpm --filter @led-control/api test -- sites.service.spec.ts`
- [ ] 기대 결과: 사이트 대시보드 service 테스트가 통과한다.
- [ ] 커밋: `feat(api): expose monitoring dashboard read model`

## 작업 4. 조명 제어 명령 API와 MQTT 발행

**파일:**

- 생성: `apps/api/src/mqtt/mqtt.module.ts`
- 생성: `apps/api/src/mqtt/mqtt.service.ts`
- 생성: `apps/api/src/commands/commands.module.ts`
- 생성: `apps/api/src/commands/commands.controller.ts`
- 생성: `apps/api/src/commands/commands.service.ts`
- 생성: `apps/api/src/commands/commands.service.spec.ts`
- 수정: `apps/api/src/app.module.ts`

- [ ] `CommandsService.createDimmingCommand()` 테스트를 먼저 작성한다.
- [ ] 테스트는 pending command 생성 후 `publishDimmingCommand()`가 `DimmingCommandPayload`로 호출되는지 검증한다.
- [ ] `MqttService`는 `MQTT_URL`에 연결하고 `sites/{siteId}/commands/dimming` topic으로 QoS 1 publish를 수행한다.
- [ ] `POST /commands/dimming` endpoint를 만든다.
- [ ] request body는 `siteId`, `targetType`, `targetId`, `brightness`, `requestedBy`를 받는다.
- [ ] `brightness`는 0 이상 100 이하 정수만 허용한다.
- [ ] 실행: `pnpm --filter @led-control/api test -- commands.service.spec.ts`
- [ ] 기대 결과: command service 테스트가 통과한다.
- [ ] 커밋: `feat(api): publish dimming commands over mqtt`

## 작업 5. Mock 게이트웨이 시뮬레이터

**파일:**

- 생성: `apps/mock-gateway/package.json`
- 생성: `apps/mock-gateway/src/index.ts`
- 생성: `apps/mock-gateway/src/simulator.ts`
- 생성: `apps/mock-gateway/src/simulator.test.ts`

- [ ] `applyDimmingCommand()` 테스트를 먼저 작성한다.
- [ ] fixture 대상 명령을 받으면 해당 조명의 `brightness`, `powerOn`, `lastSeenAt`이 갱신되는지 검증한다.
- [ ] `apps/mock-gateway/src/simulator.ts`에 순수 함수를 구현한다.
- [ ] `apps/mock-gateway/src/index.ts`는 `MOCK_SITE_ID`와 `MQTT_URL`을 읽는다.
- [ ] Mock 게이트웨이는 dimming command topic을 subscribe한다.
- [ ] 명령 수신 후 fixture state event와 command ack event를 publish한다.
- [ ] 3초마다 gateway heartbeat를 publish한다.
- [ ] 실행: `pnpm --filter @led-control/mock-gateway test`
- [ ] 기대 결과: simulator 테스트가 통과한다.
- [ ] 커밋: `feat(mock-gateway): simulate fixture dimming commands`

## 작업 6. Web 앱 shell과 API client

**파일:**

- 생성: `apps/web/package.json`
- 생성: `apps/web/index.html`
- 생성: `apps/web/src/main.tsx`
- 생성: `apps/web/src/App.tsx`
- 생성: `apps/web/src/api/client.ts`
- 생성: `apps/web/src/api/queries.ts`
- 생성: `apps/web/src/state/navigation-store.ts`
- 생성: `apps/web/src/styles.css`
- 생성: `apps/web/src/App.test.tsx`

- [ ] `App`이 `모니터링`, `제어`, `통계`, `설정` 메뉴를 렌더링하는 테스트를 먼저 작성한다.
- [ ] Vite React 앱을 구성한다.
- [ ] React Query `QueryClientProvider`를 연결한다.
- [ ] Zustand로 현재 메뉴 상태를 관리한다.
- [ ] `apiGet`, `apiPost` helper를 만든다.
- [ ] `useDashboard()` query를 만들고 3초 간격 refetch를 설정한다.
- [ ] 흰색 배경과 파란색 primary color를 기준으로 PC 관제형 layout CSS를 작성한다.
- [ ] 실행: `pnpm --filter @led-control/web test`
- [ ] 기대 결과: 앱 shell 테스트가 통과한다.
- [ ] 커밋: `feat(web): add control center shell`

## 작업 7. 모니터링 맵, 제어, 통계, 설정 화면

**파일:**

- 생성: `apps/web/src/features/monitoring/MonitoringView.tsx`
- 생성: `apps/web/src/features/monitoring/FloorMap.tsx`
- 생성: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- 생성: `apps/web/src/features/control/ControlView.tsx`
- 생성: `apps/web/src/features/statistics/StatisticsView.tsx`
- 생성: `apps/web/src/features/settings/SettingsView.tsx`
- 생성: `apps/web/src/features/rf/RfPlanningPanel.tsx`
- 수정: `apps/web/src/App.tsx`

- [ ] `FloorMap` 테스트를 먼저 작성한다.
- [ ] 테스트는 fixture 이름과 밝기 `%` 라벨이 표시되는지 검증한다.
- [ ] `MonitoringView`는 총 조명 수, 온라인 수, 장애 수, 평균 밝기를 표시한다.
- [ ] `FloorMap`은 도면 좌표계를 기준으로 fixture 위치를 표시한다.
- [ ] fixture 상태에 따라 `online`, `offline`, `fault` class를 적용한다.
- [ ] `ControlView`는 fixture 선택, 밝기 slider, 적용 버튼을 제공한다.
- [ ] 적용 버튼은 `POST /commands/dimming`을 호출한다.
- [ ] `StatisticsView`는 작업 8 전까지 정적 일/월/년 추정 데이터를 표시한다.
- [ ] `SettingsView`는 현장, 층/도면, 그룹, OTA 메뉴 구조를 표시한다.
- [ ] `RfPlanningPanel`은 Hamina Planner를 1차 RF 검토 도구로 표시하고 입력 자료와 MVP 2 통신 품질 지표를 보여준다.
- [ ] `App.tsx`에 네 메뉴별 view component를 연결한다.
- [ ] 실행: `pnpm --filter @led-control/web test`
- [ ] 기대 결과: app shell 테스트와 floor map 테스트가 통과한다.
- [ ] 커밋: `feat(web): add monitoring control statistics screens`

## 작업 8. 추정 전력 사용량 API와 UI

**파일:**

- 생성: `apps/api/src/energy/energy.module.ts`
- 생성: `apps/api/src/energy/energy.controller.ts`
- 생성: `apps/api/src/energy/energy.service.ts`
- 생성: `apps/api/src/energy/energy.service.spec.ts`
- 수정: `apps/api/src/app.module.ts`
- 생성: `apps/web/src/api/energy.ts`
- 수정: `apps/web/src/features/statistics/StatisticsView.tsx`

- [ ] `EnergyService.calculateEstimatedUsage()` 테스트를 먼저 작성한다.
- [ ] 테스트 입력: 정격 40W, 밝기 50%, 10시간, kWh 단가 160원.
- [ ] 기대 결과: `0.2 kWh`, `32원`.
- [ ] 계산식은 `정격전력 × 밝기비율 × 시간 ÷ 1000`이다.
- [ ] `GET /energy/default/estimate` endpoint를 만든다.
- [ ] 기본 현장의 fixture를 조회하고 하루 12시간 기준으로 day/month/year 사용량과 비용을 계산한다.
- [ ] Web에 `useEnergyEstimate()` query를 추가한다.
- [ ] `StatisticsView`가 API 데이터를 표시하도록 변경한다.
- [ ] 실행: `pnpm --filter @led-control/api test -- energy.service.spec.ts`
- [ ] 실행: `pnpm --filter @led-control/web test`
- [ ] 기대 결과: 에너지 service 테스트와 web 테스트가 통과한다.
- [ ] 커밋: `feat: add estimated energy statistics`

## 작업 9. React Native WebView shell

**파일:**

- 생성: `apps/mobile/package.json`
- 생성: `apps/mobile/App.tsx`
- 생성: `apps/mobile/src/WebShell.tsx`
- 생성: `apps/mobile/src/WebShell.test.tsx`

- [ ] `WebShell`이 전달받은 web URL을 WebView source로 사용하는 테스트를 먼저 작성한다.
- [ ] `react-native-webview`를 사용한다.
- [ ] `SafeAreaView` 안에 WebView를 배치한다.
- [ ] `EXPO_PUBLIC_WEB_URL`이 있으면 해당 값을 사용하고, 없으면 `http://localhost:5173`을 사용한다.
- [ ] 실행: `pnpm --filter @led-control/mobile test`
- [ ] 기대 결과: WebView shell 테스트가 통과한다.
- [ ] 커밋: `feat(mobile): add webview shell`

## 작업 10. MVP 1 데모 검증

**파일:**

- 생성: `apps/web/e2e/mvp1.spec.ts`
- 생성: `apps/web/playwright.config.ts`
- 수정: `README.md`

- [ ] Playwright 테스트를 추가한다.
- [ ] 테스트는 `/`에 접속해 `모니터링` 화면과 `전체 조명` 문구를 확인한다.
- [ ] `제어`, `통계`, `설정` 메뉴를 클릭해 각 heading이 보이는지 확인한다.
- [ ] `README.md`에 MVP 1 로컬 데모 실행 절차를 한글로 작성한다.
- [ ] README 실행 절차에는 의존성 설치, Docker 인프라 실행, DB migration/seed, dev server 실행, 접속 URL을 포함한다.
- [ ] 실행: `pnpm test`
- [ ] 실행: `pnpm typecheck`
- [ ] 실행: `pnpm --filter @led-control/web exec playwright test`
- [ ] 기대 결과: 모든 unit test, TypeScript check, Playwright 테스트가 통과한다.
- [ ] 커밋: `test: add mvp1 demo verification`

## 4. 자체 검토

설계 요구사항 반영 현황:

- PC 웹 우선: 작업 6, 작업 7, 작업 10에서 반영한다.
- React Native WebView 재사용: 작업 9에서 반영한다.
- 층별 2D 맵 모니터링: 작업 7에서 반영한다.
- 개별/그룹 밝기 제어 흐름: 작업 4, 작업 5, 작업 7에서 반영한다.
- 전력 사용량과 예상 전기료: 작업 8에서 반영한다.
- NestJS, PostgreSQL, Redis, MQTT 기반 클라우드 스택: 작업 1, 작업 2, 작업 4에서 반영한다.
- MVP 1용 Mock 게이트웨이: 작업 5에서 반영한다.
- Hamina Planner 기반 RF/음영 검토: 작업 7과 작업 10의 README에서 반영한다.

의도적으로 제외한 항목:

- 실제 Go 게이트웨이, ESP32-H2 펌웨어, BLE Mesh, 실제 OTA, 파일럿 설치 운영은 MVP 1 범위 밖이다.
- 위 항목은 MVP 2와 MVP 3 구현 계획에서 별도 작업으로 작성한다.
