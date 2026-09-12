# 에이전트 운영 기준

기준일: 2026-09-12

이 문서는 프로젝트 자동화 작업의 단일 운영 기준이다. 새 운영 문서를 작업마다 만들지 않으며, 이 문서와 `docs/project-status.md`를 지속 갱신한다. `project-status.md`는 현재 상태 요약의 정본이고, `writing-plans`는 진행 중인 작업의 실행 체크리스트다. 작업 상태나 체크리스트가 바뀌면 둘을 함께 일치시켜 갱신한다.

## 역할과 소유 경계

| 역할 | 책임 | 주 소유 범위 |
| --- | --- | --- |
| 총괄 | 요구사항 확정, 작업 분해, 의존성·승인 관리, 결과 통합 | 전체 조율, 공유 계약 |
| designer | 사용자 흐름, 화면 명세, 디자인 토큰, 접근성 검토 | `docs`, 웹 디자인 토큰 |
| web_frontend | React 웹 화면, 상태 관리, 브라우저 E2E | `apps/web` |
| mobile | React Native, WebView, 네이티브 인증·권한 | `apps/mobile` |
| backend | NestJS API, PostgreSQL, Redis, MQTT 서버 계약 | `apps/api`, `packages/shared` 승인 후 |
| gateway | Raspberry Pi, Docker, BlueZ, MQTT, 장비 인증서 | `apps/gateway`, `infra` 일부 |
| firmware | ESP-IDF, BLE Mesh, PWM, Health, OTA | `apps/esp32-h2-firmware` |
| qa_reviewer | 요구사항·코드·문서·검증 증거 검토 | 기본 읽기 전용 |

`packages/shared`, 공통 MQTT 계약, Prisma 스키마, 배포 인프라는 둘 이상의 역할에 영향을 준다. 변경 전 총괄 승인과 영향 역할의 검토를 받고, 병렬 수정하지 않는다.

## Custom Agent와 Skill

Custom agent는 **누가** 작업하는지를 정의한다. 역할, 기본 모델, 권한, 소유 범위와 검토 책임을 고정한다. Skill은 **어떻게** 작업하는지를 정의한다. 따라서 custom agent는 기존 Superpowers skill 전체를 대체하지 않는다.

계속 사용하는 skill:

- `brainstorming`
- `writing-plans`
- `test-driven-development`
- `systematic-debugging`
- `verification-before-completion`
- `requesting-code-review`, `receiving-code-review`

Custom agent가 대체하는 범위는 임시 역할 프롬프트, 역할 선택, 기본 모델·권한·파일 소유권이다. `subagent-driven-development`의 지속적인 역할 배정은 custom agent가 일부 대체하지만, 작업별 독립 작업 맥락, 검토 승인 관문, 작업 상태 기록부는 유지한다.

## 작업 생명주기

1. 총괄은 요구사항, 완료 조건, 영향 메뉴와 담당 역할을 `project-status.md`와 활성 `writing-plans` 체크리스트에 함께 기록한다.
2. 담당 역할은 관련 `AGENTS.md`, 교훈 문서, 메뉴 문서와 기존 코드를 읽고 계획을 확정한다.
3. 구현 전 테스트 또는 재현 절차를 먼저 정의한다.
4. 독립 소유 범위만 병렬로 작업하고, 공유 계약 변경은 순차로 처리한다.
5. 담당 역할은 코드·테스트·관련 메뉴 문서를 같은 작업 단위에서 갱신하고 작은 단위로 커밋한다.
6. QA가 요구사항, diff, 자동 검증과 문서 일치 여부를 검토한다.
7. 총괄은 결과와 미해결 사항을 상태판과 활성 체크리스트에 함께 반영하고, 사용자 승인 관문이 필요한 작업은 승인 뒤 진행한다.

## 병렬화와 승인 규칙

- 서로 다른 앱 디렉터리의 독립 작업만 병렬 실행한다.
- 같은 파일, 같은 API 계약, 같은 Prisma migration은 한 역할만 수정한다.
- `packages/shared`와 DB 스키마는 총괄 승인 후 관련 역할이 순서대로 변경한다.
- 인증서, private key, DB 초기화, 실제 장비 flash, Raspberry Pi 배포, 운영 환경 명령은 사용자 승인 관문을 통과한 뒤 실행한다.
- QA의 `sandbox_mode = "read-only"`는 기본 권한 프로필이며 보안 경계가 아니다. 부모 세션 권한이 우선하므로 QA 검토 턴은 부모 세션도 읽기 전용으로 실행하고, 수정이 필요하면 총괄이 담당 역할에 별도 태스크로 배정한다.

## 문서와 커밋 규칙

- 기능 변경 시 영향을 받은 `docs/menus/*.md`를 같은 커밋에서 갱신한다.
- DB 변경 시 `docs/database-schema.md`를 같은 커밋에서 갱신한다.
- 반복 가능한 실패와 예방책은 `docs/lesson_leared.md`에 누적한다.
- `project-status.md`는 상태 요약의 정본으로 유지한다. 활성 작업은 `writing-plans` 체크리스트에도 같은 상태를 반영한다.
- mock·자동 fixture·빌드 성공은 실제 하드웨어 검증 완료와 구분해 기록한다.

## Production dependency audit 정책

- 저장소가 고정한 `pnpm@9.15.0`에서 `package.json#pnpm`을 override와 patch의 단일 설정 위치로 사용한다. 로컬의 상위 pnpm launcher가 새 설정 위치 경고를 출력하더라도 저장소 안 `pnpm --version`과 frozen install, 실제 dependency graph를 함께 확인한다.
- `pnpm audit:production`은 fresh `pnpm audit --prod --audit-level=moderate --json`을 정책 스크립트로 전달한다. 예상하지 못한 Moderate/High/Critical advisory는 exact 경로와 patched floor를 출력하고 실패하며, 허용된 예외도 성공 로그에서 숨기지 않는다.
- `@nestjs/platform-express>multer=2.3.0`은 Nest 11.2.3이 아직 2.2.0을 고정하므로 사용하는 selector override다. 현재 API에 multipart upload/FileValidator 경로는 없지만 Nest bootstrap/controller와 API typecheck/build로 검증한다. Nest가 Multer 2.3.0 이상을 지원하면 제거한다.
- `@prisma/config>deepmerge-ts=8.0.2`는 request runtime이 아닌 Prisma CLI config 경로에만 적용한다. Prisma validate/generate와 새 disposable PostgreSQL에 대한 전체 `prisma migrate deploy`가 모두 통과해야 유지하며, Prisma가 8.x 이상을 직접 사용하면 제거한다.
- `image-size@1.2.1`은 upstream safe release가 없어서 Metro build-time asset 검사 경로의 ICNS/JXL/HEIF signature를 parser dispatch 전에 fail-close하는 repository patch를 사용한다. 악성 shape와 정상 PNG regression, patch SHA-256, exact 두 GHSA와 dependency path가 모두 일치해야 정책 예외가 허용된다. upstream non-vulnerable release가 나오면 patch와 예외를 함께 제거한다.
- `uuid@8.3.2` Moderate는 ExcelJS 4.4.0의 `uuid.v4()` 사용 경로만 남는다. advisory의 caller-provided buffer API는 호출하지 않으며 XLSX render/load regression으로 소비 경로를 고정한다. ExcelJS가 `uuid>=11.1.1`을 지원하거나 검증된 대체재를 채택하면 예외를 제거한다.

## Workspace build·검증 gate

- 같은 checkout의 canonical `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`는 모두 `scripts/workspace-gate.mjs`를 통과한다. Gate는 repository owner lock을 잡은 뒤 `shared` 한 번, `automation-engine` 한 번을 순서대로 build하고 전체 consumer command가 끝날 때까지 lock을 유지한다.
- 동시 root gate는 active owner를 훔치지 않고 순서대로 대기한다. 장시간 test를 임의 timeout으로 실패시키지 않으며, owner identity가 종료 경계에서 잠시 확인되지 않아도 gate 전용 정책은 lock을 훔치지 않은 채 재확인한다. Shared build 자체의 unknown-owner 기본 정책은 계속 fail-closed다.
- Gate가 catch 가능한 `SIGINT`/`SIGTERM`을 받으면 pnpm leader identity가 live인 owned 단계의 첫 signal만 독립 process group에 전달한다. Leader exit 뒤에는 numeric PGID가 재사용될 수 있으므로 nonzero signal을 다시 보내지 않고, later signal은 최종 gate 종료 의미에만 반영한다. POSIX에서는 `kill(-pgid, 0)`가 `ESRCH`가 될 때까지 전체 group lifetime을 관찰한 뒤 lock을 해제하며, `EPERM`은 종료가 아니라 live/unknown으로 fail-closed한다. Windows에서는 동등한 descendant-tree 보장을 제공하지 못하므로 lock 획득 전에 명시적으로 실패한다. Exact owner marker를 제거한 뒤 successor가 빈 directory를 차지한 release handoff는 성공으로 취급하되 successor marker는 삭제하지 않는다.
- Package의 canonical `build`, `lint`, `typecheck`, `test`는 준비된 workspace dependency를 소비하는 graph-pure command다. 직접 leaf 명령 전에는 `pnpm workspace:prepare`를 실행한다. 개발·HIL 보조 명령의 명시적 준비 단계는 canonical 검증 graph와 구분한다.
- Playwright `RealBackendLab.start()`도 cold checkout에서 `workspace:prepare`로 shared→automation output을 만든 뒤 graph-pure API/Web build를 실행한다. 기존 automation `dist`에 기대어 lab startup 성공을 판정하지 않는다.
- Shared output은 기존 동일-path artifact를 유지한 상태에서 temp file rename으로 교체하고, 새 generation에 없는 manifest-owned stale file만 교체 뒤 제거한다. 이 per-file 가용성 방어와 root gate를 함께 유지하며 non-empty `dist` directory의 비이식적 atomic rename으로 바꾸지 않는다.
- 테스트의 cross-process signal 대기는 `subscribe()` 호출만 watcher 등록 완료로 간주하지 않는다. `fs/promises.watch()`처럼 lazy async iterator인 경우 첫 `next()` promise에 resolve/reject handler를 즉시 붙여 prime한 뒤 상태를 재확인하고, 이벤트 뒤에도 다음 `next()`를 prime한 다음 상태를 읽는다. Observation, producer success/failure, abort, iterator end 어느 경로든 AbortController와 iterator를 닫고, signal wait/read와 writer·child release/reap을 같은 `try/finally` lifetime에 둔다.
- Empty lock directory 관찰은 삭제 권한이나 경로 지속성의 증거가 아니다. Owner release와 contender cleanup 사이 두 번째 검사에서 directory가 이미 사라진 `ENOENT`는 정상 경쟁 결과로 retry하지만, symlink·non-directory·invalid marker/contents와 그 밖의 filesystem 오류는 계속 fail-closed한다.
- Canonical root unit/contract 경로는 dependency audit policy, patched `image-size` parser security, production MQTT config regression을 각각 정확히 한 번 실행한다. Gateway 전체 Vitest는 filesystem·crypto 부하가 큰 suite의 wall-clock 경합을 피하도록 단일 worker로 실행하며 제품 timeout이나 retry 횟수는 완화하지 않는다.

## Software CI와 HIL gate

- `.github/workflows/ci.yml`은 `quality → unit → postgres-redis-integration → playwright-real-core → build → production-audit`의 단일 `needs` chain이다. 모든 독립 software job은 Ubuntu, Node 22, pnpm 9.15.0과 frozen install을 새로 수행하고, frozen install 직후 API Prisma Client를 생성한 다음에만 validation을 시작한다. Canonical root `lint`/`typecheck`/`test`/`build`를 우회하지 않는다.
- Integration은 GitHub Actions의 disposable PostgreSQL 16과 Redis 7 healthcheck 뒤에만 실행한다. 일반 suite는 `led_control`, inventory/certificate 전역 cleanup이 있는 PKI concurrency 17개는 전용 `pki_concurrency` DB를 사용하고 두 DB 모두 전체 `prisma migrate deploy`를 적용한다. Redis editor lease는 DB 15, fixture identify는 DB 14로 분리한다. 필수 URL 또는 `RUN_REDIS_INTEGRATION=true`가 없거나 DB identity가 다르면 테스트를 skip하지 않고 migration 전에 실패한다. 지정 suite는 cleanup 충돌을 막기 위해 `--runInBand`로 실행한다.
- Real-backend core는 host PostgreSQL server/client, Redis, Mosquitto, OpenSSL, `lsof`/`procps`와 Chromium dependency를 설치하고 `E2E_REAL_BACKEND_LAB=1`, Chromium 한 worker로 `installation-customer-journey.spec.ts`만 실행한다. Fixed lab port를 공유하는 real suite를 같은 job에서 병렬화하지 않는다.
- Production audit는 Docker daemon과 Compose를 선검사하고 production Compose render, MQTT production config, Gateway container contract와 required MQTT persistence, Web bundle/container contract, `pnpm audit:production`을 모두 통과해야 한다. Docker 부재를 container test의 skip으로 성공 처리하지 않는다.
- Release hardening Task 3 당시 local production audit는 Docker/MQTT/Gateway 단계까지 통과한 뒤 Web bundle 예산에서 fail-closed했다(main 1268.65 kB > 1070.00 kB, gzip 378.89 kB > 325.00 kB). Node 22.20.0에서도 동일해 당시에는 branch protection 전에 별도 수정이 필요했다. 이 차단은 route 기능 코드 `34261b6`과 container fix `247f81d`의 후속 production audit에서 해소됐고, 현재 bundle 작업에는 whole-branch final review만 남아 있다. CI에서 예산 실패를 완화하거나 skip하지 않는 정책은 유지한다.
- Task 4 final functional-code 검증에서 root lint/typecheck/test/build와 dependency policy, 세 쌍의 concurrent root gate가 통과했다. Fixture 수정 `18ba2e9` 뒤 disposable PostgreSQL 16/Redis 7 integration은 두 DB의 57 migrations와 지정 in-band suite 13/13·123/123을 통과했고, journey 수정 `2b208e2` 뒤 one-worker RealBackendLab core도 2/2를 통과했다. 이후 test-harness-only `d1ecb23`·`f1661c1`은 lazy watcher gap과 cleanup lifetime을 수정했고 당시 scoped reviewer는 Critical/Important/Minor 0과 branch spec·merge quality PASS를 판정했다. Final docs 검증에서 successor가 empty lock을 읽은 뒤 old owner가 directory를 제거하는 정상 race가 89회 중 재현됐고, production lock fix `df90563`은 두 번째 inspect의 `ENOENT`만 retry하도록 수정했다. Deterministic RED→GREEN, Shared lock/export 93/93·전체 203/203, workspace gate 13/13, successor 20/20(nonzero 0), 실제 concurrent lint/typecheck 3쌍 0/0을 확인했다. 최종 reviewer는 race ADDRESSED, Critical/Important/Minor 0, branch spec·merge quality PASS로 승인했다. 이 세 후속 커밋은 integration·real-backend 경로를 바꾸지 않았으므로 앞선 full evidence는 유지하되 현재 HEAD에서 전체 재실행했다고 표현하지 않는다. `apps/web/e2e/automation-control-flow.spec.ts`의 setup 직후 registration form 가정은 core CI 대상 밖에서 같은 route drift가 남을 수 있는 known follow-up이며 이번 통과 범위로 확대하지 않는다.
- Release hardening 당시 production audit는 Mosquitto/Compose 2/2, Gateway 24/24, required MQTT persistence/ACL 2/2 뒤 같은 Web budget에서 중단되어 뒤의 Web container와 in-band dependency policy가 실행되지 않았다. 당시 별도 fresh raw audit는 Critical 0/High 2/Moderate 1/Low 0이고, policy는 unexpected 0·승인 예외 3건을 출력하며 통과했다. 이 문장은 과거 실패 범위의 증거이며 현재 통과 상태는 아래 Web route bundle 항목을 따른다.
- Web route bundle 분할의 기능 코드 SHA는 `34261b6`이다. Task 4 첫 production audit은 새 bundle 예산을 통과한 뒤 Web image frozen install에서 repository `patches/image-size@1.2.1.patch`가 build context에 없어 실패했다. 계약 RED와 실제 Docker RED를 확인하고 `COPY patches patches`를 install 전에 추가하자 frozen install은 통과했지만, 그동안 가려졌던 Alpine BusyBox `ps`의 `-p`/`lstart` 미지원 때문에 Shared lock의 process start identity가 fail-closed 됐다. 별도 계약 RED 후 container fix `247f81d`가 `procps`를 Node build stage에만 설치했으며 Shared lock 로직과 최종 nginx image는 변경하지 않았다. Focused container contract와 실제 Docker smoke는 5/5를 통과했다. 이어 전체 `pnpm ci:production-audit`를 처음부터 재실행해 Compose 2/2, Gateway 24/24, required MQTT persistence/ACL 2/2, Web bundle main `314.83 kB`/gzip `97.58 kB`, Web container 5/5와 dependency 820개 정책(Critical 0/High 2/Moderate 1/Low 0, 승인 예외 3·unexpected 0)까지 통과했다. 이 결과는 실제 iOS/Android native WebView, 수동 in-app 시각 QA 또는 HIL 증거가 아니다.
- `.github/workflows/hil.yml`은 자동 push/PR trigger가 없는 `workflow_dispatch` 전용이다. Repository 관리자는 `hil` GitHub environment에 required reviewer를 설정하고, `[self-hosted, led-hil]` runner와 environment secret을 준비해야 한다. 입력이 정확히 `RUN_LED_HIL`이 아니거나 공통 장비 값, readable regular 인증서/키 파일, readable+writable character device, 단계별 command JSON이 하나라도 없거나 잘못되면 PKI/2-node HIL 전에 실패한다. 각 JSON argv의 첫 원소는 PATH 또는 명시 경로에서 executable regular file로 resolve만 하며 preflight 중 실행하지 않는다. Absolute path는 그대로 사용하고 모든 relative credential/device/command path와 relative PATH entry는 실제 두 HIL harness의 고정 실행 cwd인 `apps/gateway` 기준으로 해석한다. Preflight 자체와 두 root HIL command는 같은 launcher의 Gateway `pnpm exec` context를 사용하므로 package-local executable lookup도 실제 실행과 일치한다. Concurrency group `led-hil`은 진행 중 실행을 취소하지 않고 직렬화한다.
- Workflow contract는 protected production-audit job/step과 HIL job/preflight step에 `if` 또는 `continue-on-error` 우회가 추가되면 실패한다. Frozen install/Prisma generation step도 같은 우회를 허용하지 않는다.
- Software CI 성공은 Raspberry Pi/ESP32-H2 HIL 완료 증거가 아니다. HIL command JSON은 승인된 lab 절차만 가리켜야 하며 production firmware의 Company ID·manufacturing approval·attestation gate를 우회해서는 안 된다. Workflow 추가만으로 GitHub environment 보호, runner 등록, secret 또는 branch protection은 생성되지 않으므로 운영자가 별도로 설정한다.

## API production 관측 Task 1 계약

- `GET /health/live`는 외부 의존성 I/O 없이 process liveness만 반환한다. `GET /health/ready`는 기존 Prisma의 tagged `SELECT 1`, 기존 Redis `PING`, 기존 MQTT 연결 상태, 기존 Object Storage client의 bucket `HEAD`를 병렬 실행하고 probe별 `1,000ms` 안에 모두 `up`일 때만 200을 반환한다. 동시·반복 요청은 raw probe들이 끝날 때까지 한 generation으로 합쳐 background 작업이 누적되지 않으며, Object Storage transport에는 같은 deadline의 abort signal을 전달한다. 실패 원인, URL, credential, SQL과 stack은 응답하지 않고 네 고정 key의 `up | down`만 503 body에 남긴다.
- `ObservabilityModule`을 AppModule의 첫 import로 두어 `ReadinessService.onModuleDestroy()`가 dependency destroy hook보다 먼저 `stopping`을 표시한다. 종료 중 readiness는 probe I/O 없이 즉시 네 항목 `down`으로 수렴하고 liveness는 HTTP server가 닫힐 때까지 독립적으로 유지한다. Nest app 생성 뒤 Vault/CRL 설정이나 `app.listen`이 실패하면 등록된 기존 runtime의 fail-closed 경로를 정확히 한 번 실행해 CRL, token, Nest app을 정리한다.
- `X-Request-Id`는 영숫자로 시작하는 최대 128자의 영숫자/`.`/`_`/`:`/`-`만 수용하고 그 외 값은 UUID v4로 교체한다. 같은 ID를 response header와 `AsyncLocalStorage`에 전달한다. HTTP JSON-line log는 timestamp, level, context, requestId, method, route template 또는 고정 `/:unmatched`, statusCode, durationMs만 기록한다. Application log는 고정 operation/error class와 고정 context allowlist만 기록하며 raw string/Error/object를 직렬화하지 않는다. 이 logger를 Nest creation 전 bootstrap logger로 설치한 뒤 DI logger로 교체하고, 기존 Redis client의 `error` event도 raw Error 없이 `dependency`/`ConnectionError`로 소비한다. cookie, authorization, body, query, header, URL, credential, tenant, path, stack과 raw device identifier는 로그에 넣지 않는다.
- `/health/metrics`는 process memory의 고정 집계만 제공한다. HTTP total·4xx·5xx·latency sum/max와 readiness status, `postgres | redis | mqtt | objectStorage` failure total 외 tenant·path·request ID 같은 가변 label은 만들지 않는다. process restart 시 초기화되며 외부 metrics backend·dashboard·alert·log shipping은 Task 1 범위가 아니다.
- Task 1 리뷰 수정까지 포함한 소프트웨어 검증은 focused `9 suites / 37 tests`, 전체 API `120 suites / 1,138 passed / 289 environment-dependent skipped`, API typecheck/build와 `git diff --check`다. 실제 PostgreSQL·Redis·MQTT broker·Object Storage, production Compose/container/TLS proxy, 사용자 DB migration, secret 변경, 운영 배포와 Raspberry Pi/BlueZ/ESP32-H2 HIL은 실행하지 않았다. Compose와 실제 dependency fail/recover smoke는 Task 2 범위다.

## Production Compose Task 2 계약

- 개발 Compose를 합치지 않는 `docker-compose.production.yml`, API migration/runtime 공통 이미지, non-root Web TLS proxy와 `production:contract`·`production:smoke` 경로를 구현했다. `PRODUCTION_COMPOSE_PROJECT=led-production-sitea PRODUCTION_ENV_FILE=/절대/경로/.env.production pnpm docker:up:production`은 실제 env-file을 읽는 `scripts/production-compose-config.mjs`로 API/Web content digest, HTTPS/mTLS, host port와 기동 순서를 검증한 뒤 실행한다. 운영 API/Web은 `@sha256:` digest가 필요하고 변경 가능한 commit tag도 거부한다. 고유 smoke tag는 disposable harness 안에서만 허용한다. 렌더링한 설정 값은 출력하지 않는다. `PRODUCTION_COMPOSE_PROJECT`는 `led-production-` prefix·소문자 영숫자와 단일 하이픈·최대 63자를 검증하고 checkout 기본 project 및 default/dev/development 예약값을 거부한다. Render/up 모두 동일 `-p`를 사용하며 named volume은 해당 project에만 속하고 external volume은 금지한다. 같은 checkout에서 개발 Compose를 써도 DB volume을 공유하지 않는다.
- 최초 계약 RED는 11개 중 9개 실패·2개 통과였고, 추가 credential 최소 노출·tmpfs 렌더·운영 preflight 검사를 포함한 현재 계약은 18/18이다. 동적 CRL RED 15개 중 3개 실패를 확인한 뒤 15/15로 전환했다. API/Web 실제 이미지 build와 로컬 typecheck/build, API 1,138 passed(289 환경 의존 skipped)·Web 686/686, CI/MQTT 연결 계약 9/9를 통과했다. 전체 `pnpm ci:production-audit`는 계약 18/18, MQTT 설정 2/2, Gateway container 24/24, required MQTT persistence/ACL 2/2, Web bundle `314.83 kB / gzip 97.58 kB`, disposable Compose smoke와 dependency policy까지 exit 0이다. Dependency 820개는 기존 승인 예외 High 2·Moderate 1을 출력하며 unexpected 0이다.
- 성공 smoke 프로젝트는 `led-production-smoke-20c71af3d390cb402599e5abe546bfb5`다. 빈 DB의 public table 0개에서 migration 57/57을 적용하고 migration/API의 동일 image ID와 종료→기동 순서, API live/ready 200, TLS 1.2/1.3, Web same-origin proxy 200, HTTP 308, request ID·cache·security header를 확인했다. nginx upstream 인증서 identity를 틀리게 만들면 502, 복원하면 200이다. 제조 mTLS는 Web raw TCP port를 통해 no-cert 401, valid-cert/빈 serial 400(`serialNumber is required`), wrong API identity TLS 실패와 Inventory/Enrollment 0/0을 검증했다. Redis 중단 시 ready 503·live 200·Web healthcheck nonzero, 재시작 시 ready 200을 확인했다. 종료 trap은 이 프로젝트의 container·volume·network·전용 image를 모두 0으로 정리하고 임시 PKI/env 디렉터리를 제거했다.
- API/Web은 non-root·read-only root·capability 제거로 실행한다. MinIO는 upstream `/data`가 root 소유라 UID 0을 유지하되 모든 capability를 제거하고 named data volume과 tmpfs만 쓰게 한다. Vault는 운영에서 외부 HTTPS dependency이며 smoke에만 고유 격리 네트워크의 token lookup contract double을 사용한다.
- Web은 HTTP 8080·브라우저 TLS 8443·장비 raw TLS 9443만 publish한다. 운영 env-file에는 `DEVICE_API_HTTPS_PORT`가 추가로 필요하다. 장비·제조 클라이언트는 이 별도 port의 API endpoint를 사용하고, API 인증서 SAN에는 내부 `api`와 운영 장비 endpoint hostname이 모두 있어야 한다. nginx stream은 암호화 TCP를 그대로 `api:4000`으로 전달하므로 API가 client certificate를 직접 검증하며 Web에 새 secret mount나 certificate forwarding header는 없다. HTTP 경로와 달리 stream은 URI별 필터링을 하지 않으며 API 기존 guard가 책임진다. API 인증서는 private DNS `api`를 검증하며 Web health는 `WEB_HTTPS_ORIGIN`의 public certificate hostname을 유지한 채 loopback으로 연결한다. Web에 API private key를 제공하지 않는다. 승인된 기능상 예외로 동적 공개 device/MQTT CRL만 전용 named volume에 둔다. Network-none/non-root `crl-init`이 RO seed를 검증·초기 공급하고 API만 runtime RW writer이며 broker는 RO다. API TLS consumer는 writer와 같은 process이므로 동일 공개 파일을 읽는다. 인증서/key/CA/제조 CRL과 host seed는 RO다. Smoke에서 seed 누락 실패, 기존 publisher atomic rename 2건, consumer checksum 일치, seed 불변, init 재실행 no rollback을 확인했다. Broker 자동 reload는 추가하지 않았으며 운영자는 갱신 후 해당 production project의 `mqtt-tls`에 SIGHUP을 전달해야 한다(smoke에서 reload 후 ready 200 검증). 공개 MQTT/Object Storage URL의 외부 진입·CORS·인증서 발급, 운영 Vault token renewal/issuance, 실제 배포와 사용자 DB 적용은 이번 smoke로 검증하지 않았다. 이 Compose는 Web만 host port를 publish하며 실제 외부 접속 구성과 PKI 발행 운영은 Task 4 runbook에서 이 한계를 명시한다.

## 다음 자동화 단계

플랫폼 배포·관측·Web 복구의 Task 3은 구현·소프트웨어 검증을 완료했으며, 독립 검토 뒤 Task 4 runbook/final convergence로 진행한다. Task 3의 최신 증거와 아래 별도 Web route bundle 작업의 과거 증거를 구분한다.

## Web 앱 셸 복구 Task 3 계약

- 초기 `/auth/me` 401은 자동 재시도 없이 기존 로그인 화면을 표시한다. 403과 기타 비일시 오류는 tenant query/mutation cache와 맵 초안을 비운 후 권한·재로그인 안내를 표시하며 인증된 shell을 숨긴다. Fetch 전송 TypeError/AbortError/TimeoutError와 HTTP 5xx만 최대 2회 재시도하고 이후 서비스 연결 실패 화면과 수동 `다시 시도`를 제공한다. 호출자 signal 취소, JSON 파싱 및 일반 programming error는 transient로 분류하지 않는다.
- `AppRoot`가 세션 세대별 QueryClientProvider를 소유하고 그 안의 `AppErrorBoundary`는 실제 App의 hook/render부터 BrowserRouter/lazy shells까지 포착한다. 실패 Promise를 자동 remount하지 않고 전체 문서 새로고침 또는 eager 로그인으로 복구한다. 공통 `AppRecoveryState`는 main 1개, alert, 프로그램 포커스 heading, 공통 Button과 44px touch target을 사용하며 원시 오류를 표시하지 않는다. 부팅 시 navigator.onLine을 onlineManager에 전달하고 pending/paused 인증은 로그인 대신 서비스 복구로 분기해 실제 online 이벤트로 재개한다.
- 인증 실패·재로그인·principal 전환 시 fresh QueryClient를 먼저 활성화해 이전 mutation option callback의 지연 쓰기를 폐기된 client에 격리한다. tenant cache·맵 초안을 비우고 재로그인/비일시 인증 실패에서는 사용자를 몰라도 앱의 `led-control:active-command:` sessionStorage namespace만 정리한다. 최초 정상 부팅의 제어 복구 기록과 무관한 저장값은 보존한다. 재로그인 동기 lock은 같은 event batch의 중복 요청을 막고 정확히 5초에 logout을 abort한다. 종료 전에는 로그인 폼을 열지 않으며 실패해도 로컬 signed-out으로 수렴한다. 서버 logout 실패 시 HttpOnly cookie 폐기는 보장하지 않으므로 문서 새로고침의 서버 세션 판정은 별개다.
- 최종 fresh 검증은 focused 5 files·90/90, 전체 Web 64 files·712/712, 신규 복구 10개를 포함한 auth/shell/site-user Chromium 23/23, typecheck/build, bundle main `319.19 kB / gzip 99.21 kB`와 `git diff --check`다. Chromium은 1440/1024/390/320px·키보드·reduced-motion·실제 Vite lazy request 차단과 mock API를 사용한다. 기존 role regression의 제거된 hover 메뉴 가정만 click으로 갱신했다. 실제 backend/container/CDN 장애, iOS/Android native WebView, 수동 시각 QA, production 배포나 HIL은 이번 증거에 포함하지 않는다.

## 별도 Web route bundle 작업 후속

Web route bundle 분할 Task 4 Step 1~3은 완료했고 whole-branch final review는 아직 수행하지 않았다. Route 기능 코드 SHA `34261b6`과 container fix `247f81d`에서 fresh Web 686/686 및 전체 production audit가 Web container와 dependency policy까지 통과했다. Task 3의 planned Chromium 64/64와 one-worker RealBackendLab 2/2는 유지하되 실제 iOS/Android native WebView·수동 in-app 시각 QA·HIL 완료로 확대하지 않는다. Final reviewer가 설계·계획 대비 branch 전체를 판정한 뒤 상태판과 Step 4를 갱신한다. CI core 밖 `automation-control-flow.spec.ts`의 setup→registration stale route 가정은 별도 후속으로 유지한다. 실제 장비를 변경하거나 배포하는 HIL은 software 수정과 계속 분리하고 사용자·GitHub environment 승인 관문을 유지한다.
