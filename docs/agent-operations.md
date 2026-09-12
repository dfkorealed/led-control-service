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
- Canonical root unit/contract 경로는 dependency audit policy, patched `image-size` parser security, production MQTT config regression을 각각 정확히 한 번 실행한다. Gateway 전체 Vitest는 filesystem·crypto 부하가 큰 suite의 wall-clock 경합을 피하도록 단일 worker로 실행하며 제품 timeout이나 retry 횟수는 완화하지 않는다.

## Software CI와 HIL gate

- `.github/workflows/ci.yml`은 `quality → unit → postgres-redis-integration → playwright-real-core → build → production-audit`의 단일 `needs` chain이다. 모든 독립 software job은 Ubuntu, Node 22, pnpm 9.15.0과 frozen install을 새로 수행하고, frozen install 직후 API Prisma Client를 생성한 다음에만 validation을 시작한다. Canonical root `lint`/`typecheck`/`test`/`build`를 우회하지 않는다.
- Integration은 GitHub Actions의 disposable PostgreSQL 16과 Redis 7 healthcheck 뒤에만 실행한다. 일반 suite는 `led_control`, inventory/certificate 전역 cleanup이 있는 PKI concurrency 17개는 전용 `pki_concurrency` DB를 사용하고 두 DB 모두 전체 `prisma migrate deploy`를 적용한다. Redis editor lease는 DB 15, fixture identify는 DB 14로 분리한다. 필수 URL 또는 `RUN_REDIS_INTEGRATION=true`가 없거나 DB identity가 다르면 테스트를 skip하지 않고 migration 전에 실패한다. 지정 suite는 cleanup 충돌을 막기 위해 `--runInBand`로 실행한다.
- Real-backend core는 host PostgreSQL server/client, Redis, Mosquitto, OpenSSL, `lsof`/`procps`와 Chromium dependency를 설치하고 `E2E_REAL_BACKEND_LAB=1`, Chromium 한 worker로 `installation-customer-journey.spec.ts`만 실행한다. Fixed lab port를 공유하는 real suite를 같은 job에서 병렬화하지 않는다.
- Production audit는 Docker daemon과 Compose를 선검사하고 production Compose render, MQTT production config, Gateway container contract와 required MQTT persistence, Web bundle/container contract, `pnpm audit:production`을 모두 통과해야 한다. Docker 부재를 container test의 skip으로 성공 처리하지 않는다.
- Task 3 local production audit는 Docker/MQTT/Gateway 단계까지 통과한 뒤 기존 Web bundle 예산에서 fail-closed했다(main 1268.65 kB > 1070.00 kB, gzip 378.89 kB > 325.00 kB). Node 22.20.0에서도 동일하므로 branch protection을 활성화하기 전에 Web bundle 회귀를 별도 수정해야 하며, CI에서 이 실패를 완화하거나 skip하지 않는다.
- `.github/workflows/hil.yml`은 자동 push/PR trigger가 없는 `workflow_dispatch` 전용이다. Repository 관리자는 `hil` GitHub environment에 required reviewer를 설정하고, `[self-hosted, led-hil]` runner와 environment secret을 준비해야 한다. 입력이 정확히 `RUN_LED_HIL`이 아니거나 공통 장비 값, readable regular 인증서/키 파일, readable+writable character device, 단계별 command JSON이 하나라도 없거나 잘못되면 PKI/2-node HIL 전에 실패한다. 각 JSON argv의 첫 원소는 PATH 또는 명시 경로에서 executable regular file로 resolve만 하며 preflight 중 실행하지 않는다. Concurrency group `led-hil`은 진행 중 실행을 취소하지 않고 직렬화한다.
- Workflow contract는 protected production-audit job/step과 HIL job/preflight step에 `if` 또는 `continue-on-error` 우회가 추가되면 실패한다. Frozen install/Prisma generation step도 같은 우회를 허용하지 않는다.
- Software CI 성공은 Raspberry Pi/ESP32-H2 HIL 완료 증거가 아니다. HIL command JSON은 승인된 lab 절차만 가리켜야 하며 production firmware의 Company ID·manufacturing approval·attestation gate를 우회해서는 안 된다. Workflow 추가만으로 GitHub environment 보호, runner 등록, secret 또는 branch protection은 생성되지 않으므로 운영자가 별도로 설정한다.

## 다음 자동화 단계

Task 4에서 fresh software CI command, disposable PostgreSQL/Redis integration, real-backend Chromium journey와 production audit를 전체 재검증하고, 확인된 Web bundle 예산 실패를 포함해 branch review를 수행한다. 실제 장비를 변경하거나 배포하는 HIL 실행은 이번 software 검증과 분리하고 사용자·GitHub environment 승인 관문을 계속 유지한다.
