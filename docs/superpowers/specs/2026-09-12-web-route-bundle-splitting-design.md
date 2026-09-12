# Web route 번들 분할 설계

## 목적

Web production main entry를 기존 예산인 raw `1,070,000` bytes, gzip `325,000` bytes 이하로 줄인다. 예산이나 검사를 완화하지 않으며 현재 인증, 권한, URL, `siteId` query, dirty editor, logout, 접근성 동작을 유지한다.

## 확인된 원인

현재 `App`은 customer/operator shell을 정적으로 import하고, `CustomerShell`은 monitoring, control, statistics, settings, registration, floor editor route를 모두 정적으로 import한다. 따라서 현재 사용자가 방문하지 않은 화면의 Konva, Recharts, Zod와 화면 구현이 main entry에 포함된다.

기준 번들은 main raw `1,268.65 kB`, gzip `378.89 kB`다. 주요 포함 모듈은 React DOM, Zod, React reconciler, React Router, Recharts, Konva와 각 route 화면이다. Control의 schedule/event panel만 기존 dynamic chunk로 분리되어 있다.

## 선택한 구조

### 1. Role shell 경계

`App`은 로그인과 필수 비밀번호 변경 화면을 eager로 유지한다. 인증된 사용자의 `CustomerShell`과 `OperatorShell`은 role별 `React.lazy` import로 로드한다. 인증 확인과 principal cache 격리는 main entry에 남으므로 보안 분기 전에 customer/operator 코드를 실행하지 않는다.

### 2. Customer route 경계

`CustomerShell`의 shell chrome, installation/capability guard, navigation, logout과 dirty editor guard는 eager shell chunk에 유지한다. 다음 화면은 route 단위 dynamic import로 분리한다.

- monitoring
- manual/schedule/event control shell
- statistics shell, overview, analysis, reports
- settings shell, overview, users, registration, floor plans, floor editor, password

라우트의 path, redirect, capability 조건과 전달 props는 바꾸지 않는다. 특히 unauthorized route는 lazy component를 mount하지 않고 기존 `Navigate` 경로로 수렴해야 한다.

### 3. Operator route 경계

`OperatorShell`의 header/logout은 shell chunk에 유지하고 현장 관리자 관리 화면은 route chunk로 분리한다. Operator 직접 URL의 `/operator/site-admins` 수렴 계약은 유지한다.

### 4. 공통 loading UI

공통 UI 폴더에 route loading component를 추가한다. `role="status"`, `aria-live="polite"`와 명확한 한글 문구를 제공한다. App role boundary는 전체 화면 loading variant를, shell 내부 route boundary는 content panel variant를 사용한다. Layout을 강제로 넓히는 fixed width/height는 두지 않아 320px와 WebView에서도 overflow를 만들지 않는다.

Lazy import 실패는 기존 React error 처리 경계를 새로 정의하지 않는다. 이번 범위는 loading과 성공 렌더링을 보존하며, 별도 chunk-load recovery UI는 후속 범위다.

## 번들 정책

`audit-schedule-bundle.mjs`는 기존 raw/gzip 예산과 shared browser 계약 검사를 그대로 유지한다. 추가로 다음을 검증한다.

- customer/operator shell과 대표 customer route chunk가 production graph에 존재한다.
- Konva와 Recharts module이 main entry에 포함되지 않는다.
- schedule panel과 narrow shared browser automation contract가 production graph에 계속 존재한다.
- `@led-control/shared` CommonJS root와 관련 없는 Gateway 계약 문구가 main에 재유입되지 않는다.

개별 dynamic chunk 크기는 이번 작업에서 새 예산을 만들지 않는다. 목표는 초기 main entry와 route ownership을 안정화하는 것이며, 전체 다운로드 용량 최적화는 별도 작업이다.

## 테스트

1. Bundle audit regression을 먼저 강화해 현재 정적 import에서 실패하는 RED를 확인한다.
2. App unit은 인증 전 eager 화면과 role shell loading/완료를 검증한다.
3. Customer/Operator shell unit은 route loading, route 완료, 권한 redirect와 기존 navigation/logout 계약을 검증한다.
4. Web 전체 unit, typecheck, lint, production build와 bundle audit를 실행한다.
5. 1440/390/320 Chromium에서 대표 monitoring/control/statistics/settings/floor editor route의 overflow와 최종 화면 전환을 확인한다.
6. RealBackendLab core와 `pnpm ci:production-audit`를 실행해 Web container 및 최종 dependency policy까지 도달하는지 검증한다.

## 문서와 경계

영향받는 `docs/menus/monitoring.md`, `control.md`, `statistics.md`, `settings.md`, `docs/project-status.md`, `docs/agent-operations.md`와 실행 계획을 실제 결과에 맞춰 갱신한다.

API, DB, MQTT, firmware, mobile native code, HIL과 운영 환경은 변경하지 않는다. 사용자 DB migration, 운영 배포, secret 변경, 실장비 실행과 `main` merge는 수행하지 않는다.

## 제외 사항

- bundle budget 상향 또는 검사 skip
- API/DB/MQTT 계약 변경
- 화면 디자인이나 사용자 기능 변경
- prefetch 전략, offline chunk cache, chunk-load 재시도 UX
- `automation-control-flow.spec.ts`의 기존 setup route 후속 정리

