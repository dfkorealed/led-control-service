# MVP 1 코드 리뷰 후속 처리 현황

## 확인 방법

- 이전 세션의 별도 리뷰/피드백 문서 파일은 저장소 안에서 발견되지 않았다.
- 현재 확인은 이전 서브에이전트 리뷰 요약, `codex/mvp1-cloud-web` 브랜치의 커밋 이력, 핵심 소스 파일 대조를 기준으로 진행했다.

## 처리 완료 항목

### P1. 웹 제어 화면의 `requestedBy` 값 불일치

- 문제: 웹은 `operator@example.com`을 전송했지만, DB의 `Command.requestedBy`는 `User.id` 외래키라 명령 생성이 실패할 수 있었다.
- 조치:
  - 웹 제어 화면이 `VITE_OPERATOR_ID`를 사용하도록 변경했다.
  - 데모 seed가 고정 사용자 ID를 생성하도록 변경했다.
  - API가 `requestedBy` 사용자 존재 여부를 검증하고, 없는 경우 `400 Bad Request`를 반환하도록 보강했다.
  - 잘못된 사용자 ID일 때 명령 생성과 MQTT 발행이 실행되지 않는 테스트를 추가했다.

### P1. Mock Gateway 실행 환경 재현성 부족

- 문제: `pnpm dev` 실행 시 Mock Gateway에 필요한 `MOCK_SITE_ID`, `MOCK_FIXTURE_IDS`가 기본 환경에 없어 데모 실행이 재현되지 않았다.
- 조치:
  - `.env.example`에 Mock Gateway 실행에 필요한 site, fixture, group 매핑 값을 추가했다.
  - seed 데이터와 환경 변수의 ID를 `packages/shared/src/demo.ts` 기준으로 고정했다.
  - API와 Mock Gateway가 루트 `.env`를 읽도록 `dotenv` 로딩을 추가했다.

### P2. MQTT 상태 이벤트가 API 데이터에 반영되지 않음

- 문제: Mock Gateway가 `fixture-state`, `command-ack` 이벤트를 발행해도 API가 구독하지 않아 화면 폴링 데이터가 갱신되지 않았다.
- 조치:
  - API MQTT 서비스가 `sites/+/events/fixture-state`, `sites/+/events/command-ack`를 구독하도록 변경했다.
  - `fixture-state` 수신 시 조명 밝기, 상태, 마지막 수신 시각을 DB에 반영한다.
  - `command-ack` 수신 시 명령 상태와 오류 메시지를 DB에 반영한다.
  - 두 이벤트 처리에 대한 단위 테스트를 추가했다.

### P2. CORS와 사용자 검증 최소 보강

- 문제: 개발용 API가 넓은 CORS 설정과 사용자 검증 부재 상태였다.
- 조치:
  - CORS origin을 `WEB_PUBLIC_URL`, `localhost:5173`, `127.0.0.1:5173`로 제한했다.
  - 명령 생성 시 `requestedBy`가 실제 사용자 ID인지 검증한다.

### P3. 그룹 디밍 Mock Gateway 반영

- 문제: 스키마는 그룹 명령을 허용하지만 Mock Gateway는 개별 조명만 처리하면서 성공 ACK를 반환했다.
- 조치:
  - `MOCK_GROUP_FIXTURE_IDS` 환경 변수로 그룹-조명 매핑을 주입한다.
  - 그룹 명령 수신 시 매핑된 조명만 밝기를 변경한다.
  - 그룹 명령 단위 테스트를 추가했다.

## 아직 제품 범위에서 남은 항목

### 실제 DB, MQTT broker, API, 웹을 모두 연결한 통합 검증

- 현재 자동화 검증은 단위 테스트, 타입 체크, 웹 Playwright 라우트 mock 기반 E2E까지 포함한다.
- 실제 Docker 기반 Postgres, Redis, MQTT broker를 띄운 end-to-end 검증은 로컬 Docker CLI가 없어 완료하지 못했다.
- 다음 작업 단위에서는 Docker 실행 환경이 준비되면 `pnpm docker:up`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev` 순서로 실제 명령 전송부터 화면 상태 갱신까지 검증한다.

### 운영 인증/권한

- MVP 1에 초대 기반 회원가입, 이메일/비밀번호 로그인, HttpOnly cookie 기반 서버 저장 session, 자동 로그인 옵션을 반영했다.
- 조명 제어 명령은 클라이언트가 보낸 `requestedBy` 대신 인증된 session 사용자 ID를 사용한다.
- 역할은 `owner`, `admin`, `operator`, `viewer` 구조로 스키마에 반영했다.
- 조직/현장 단위 세밀 권한 검사와 SaaS형 게이트웨이/현장 claim 플로우는 후속 작업으로 분리한다.
