# 플랫폼 Production 배포·관측·Web 복구 설계

상태: 승인됨. API/Web production 배포 경로, 운영 관측 경계, Web 앱 셸 복구를 한 작업으로 완성한다.

## 목표

- 저장소의 API/Web artifact를 실제로 기동 가능한 production container와 Compose 경로로 연결한다.
- migration이 성공한 뒤에만 API가 시작되고, API readiness가 성공한 뒤에만 Web이 트래픽을 받게 한다.
- API process 생존과 필수 의존성 준비 상태를 분리하고, 요청 상관관계와 구조화 로그·핵심 지표를 제공한다.
- Web 앱 셸이 초기 API 장애, 인증·인가 오류, 일시 네트워크 오류, lazy chunk 로드 실패를 빈 화면으로 끝내지 않고 접근 가능한 복구 UI로 수렴한다.

## 선택한 구조

### 1. Production Compose를 단일 실행 계약으로 사용

기존 `docker-compose.yml`의 PostgreSQL 16, Redis 7, Mosquitto 2, MinIO 서비스를 production overlay가 보강하고, 새 migration/API/Web 서비스를 추가한다. 운영 secret과 외부 URL은 `${NAME:?message}` 형태로 누락 즉시 실패하게 하며 저장소에 실제 secret을 넣지 않는다.

API image는 workspace dependency와 Prisma Client를 build stage에서 생성하고 Nest artifact를 만든다. 같은 immutable image를 migration one-shot과 API runtime이 공유한다. `api-migrate`가 `prisma migrate deploy`를 끝낸 뒤에만 API가 시작되고, API readiness가 성공한 뒤에만 Web이 시작한다. API는 host에 직접 publish하지 않고 Web nginx가 same-origin `/api/`만 proxy한다.

Web nginx는 사용자가 제공한 TLS certificate/key를 read-only mount해 TLS 1.2/1.3으로 서비스하고, HTTP는 HTTPS로 redirect한다. API upstream은 private Compose network의 HTTPS API이며 내부 CA를 명시적으로 신뢰한다. forwarded headers와 request ID를 보존하고, 정적 asset에는 immutable cache, `index.html`에는 no-cache를 적용한다.

### 2. Liveness와 readiness를 분리

- `GET /health/live`: process event loop가 요청을 처리할 수 있는지만 확인한다. 외부 의존성을 조회하지 않는다.
- `GET /health/ready`: PostgreSQL `SELECT 1`, Redis `PING`, MQTT 연결 상태, Object Storage bucket `HEAD`를 각각 짧은 제한 시간 안에 확인한다. 모두 준비된 경우에만 200, 하나라도 실패하면 503이다.
- 응답에는 `status`, 의존성별 `up/down`, timestamp만 제공한다. URL, credential, SQL, stack trace와 내부 error message는 노출하지 않는다.
- shutdown이 시작되면 readiness는 즉시 503으로 바뀌고 liveness는 process 종료 전까지 응답할 수 있다.

MQTT와 Object Storage는 기존 production client를 재사용한다. readiness 전용 연결이나 별도 credential을 만들지 않는다. 각 probe는 호출자의 제한 시간에 종속되고 background reconnect 정책을 변경하지 않는다.

### 3. 요청 상관관계와 구조화 관측

HTTP middleware가 안전한 `X-Request-Id`를 받아들이거나 새 UUID를 만들고 response header에 반영한다. request context는 `AsyncLocalStorage`로 service/logger까지 전달한다. production logger는 한 줄 JSON으로 timestamp, level, context, requestId, method, route template 또는 정규화 path, statusCode, durationMs를 기록한다. body, query value, cookie, authorization, raw device identifier와 stack trace는 기본 로그에 넣지 않는다.

프로세스 메모리 기반 지표는 총 요청 수, 4xx/5xx 수, latency 합계/최댓값, readiness 결과와 dependency failure 횟수를 bounded key 집합으로 유지한다. `GET /health/metrics`는 인증정보나 tenant label 없이 이 집계만 반환한다. 영속 metrics backend와 alert 전달은 운영 후속 범위다.

### 4. Web 앱 셸 복구 상태

초기 `/auth/me`는 다음으로 분기한다.

- 401: 정상 비로그인 상태로 로그인 화면을 표시한다.
- 403: 권한이 없거나 principal 상태가 바뀐 것으로 보고 캐시를 비운 뒤 재로그인 안내를 표시한다.
- network/timeout/5xx: 서비스 연결 실패 화면과 `다시 시도`를 표시하며 로그인 폼으로 잘못 전환하지 않는다.
- 성공: 기존 principal cache 격리와 role shell 흐름을 유지한다.

일시 네트워크/5xx만 최대 2회 재시도하고 401/403은 재시도하지 않는다. 오류 화면은 `main`, `role=alert` 또는 적절한 live region, 명확한 focus heading과 키보드 가능한 공통 Button을 사용한다.

최상위 Error Boundary는 lazy import/chunk 오류를 포함한 render 오류를 포착한다. route chunk 실패에서는 캐시된 실패 Promise를 재사용하지 않도록 전체 문서 새로고침을 기본 복구로 제공하고, 재로그인 경로는 tenant query cache와 세션을 정리한 뒤 로그인 화면으로 이동한다. 오류 상세·stack은 사용자에게 표시하지 않는다.

## 검증

- API unit: probe 성공/부분 실패/timeout, shutdown readiness, 정보 비노출, request ID validation/propagation, JSON log redaction, bounded metric labels.
- API container/Compose contract: non-root runtime, frozen install, Prisma generate/build, migration-before-app, required env, secret-free render, TLS mount, healthcheck fail-fast.
- Disposable smoke: 고유 Compose project에서 빈 PostgreSQL에 전체 migration, Redis/MQTT/MinIO 준비, API liveness/readiness, Web TLS/same-origin proxy, 의존성 중 하나 중단 시 readiness 503와 복구를 확인한 뒤 해당 project/volume만 제거한다.
- Web unit/Chromium: initial 401/403/network/5xx, retry 성공, lazy chunk rejection, reload/relogin, focus·landmark·버튼 접근성, 기존 로그인·role shell 회귀.
- root lint/typecheck/test/build, production audit, `git diff --check`를 실행한다.

## 제외와 운영 후속

- 실제 production 배포, DNS·공인 TLS 발급, secret 주입·변경, 사용자 DB migration은 실행하지 않는다.
- 실제 MQTT broker/Gateway/Raspberry Pi/BlueZ/ESP32-H2 HIL과 production notification은 실행하지 않는다.
- 외부 metrics backend, dashboard, alert routing, log shipping은 이 작업에서 구성하지 않는다. 운영 연결점과 권장 alert만 runbook에 기록한다.
- Compose 단일 호스트 경로만 제공한다. Kubernetes, rolling deploy, multi-region, zero-downtime schema migration orchestration은 후속 범위다.
