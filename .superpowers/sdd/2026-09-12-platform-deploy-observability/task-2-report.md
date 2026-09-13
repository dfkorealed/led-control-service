# Task 2 구현·검증 보고

이 문서 앞부분은 최초 구현 `5a3a6fd`의 증거이며, 마지막 「리뷰 수정」 절이 현재 최종 구현·검증 증거다.

기준: `03af2cd`, branch `codex/p0p1-platform-deploy-observability`. 지정 worktree 안에서만 작업했다. Task 2 소프트웨어 구현과 필수 production audit를 완료했으며 총괄 검토를 기다린다.

## 구현

- API multi-stage image는 고정 Node 22.20.0/Alpine 3.22, frozen pnpm install와 repository patch, Prisma generate, Shared→Automation→API build를 사용한다. `pnpm deploy --prod`로 runtime dependency를 분리하고 동일 설치 graph의 Prisma CLI dependency closure만 `/migration`에 복사했다. 최종 image에서 실제 Prisma Decimal 및 workspace runtime import를 검사한다. Runtime은 UID 1000, `/sbin/tini --`, compiled `dist/src/main.js`이며 Nest/TypeScript CLI를 사용하지 않는다.
- standalone Compose의 9개 서비스는 PostgreSQL 16.10, Redis 7.4.5, Mosquitto 2.0.22 mTLS, MinIO와 bucket init, CRL init, one-shot migration, API, Web이다. `api-migrate` 성공→API readiness 성공→Web 순서를 유지한다. API/dependency에는 host port가 없고 Web만 HTTP/HTTPS를 publish한다. Required env에는 기본 credential/URL이 없으며 secret mount는 read-only다.
- API/Web non-root, 모든 서비스 read-only root·capability 제거·no-new-privileges·resource/stop/restart 설정을 제공한다. PostgreSQL/Redis/Mosquitto의 named volume 소유권은 upstream image를 사용한다. MinIO `/data`는 root 소유라 UID 0·capability 없음으로 실행하는 예외를 Compose 주석과 운영 문서에 기록했다.
- Web nginx는 TLS 1.2/1.3, canonical origin HTTP 308, HTTPS API 인증서/identity 검증, forwarding chain 덮어쓰기와 request ID 보존을 사용한다. hashed asset immutable, index no-cache 및 HSTS/nosniff/frame/referrer header를 제공한다. Web에는 API CA만 mount하고 API private key는 노출하지 않는다. Public certificate에 private `web` SAN을 요구하지 않도록 healthcheck는 canonical origin+local connect-to를 사용한다.
- `production:contract`, `production:smoke`, 실제 env-file preflight를 거치는 `docker:up:production`을 추가했다. 운영 API/Web image는 digest만 허용하고 latest/dev/commit tag를 거부한다. 테스트 harness만 정확한 crypto project/tag 조합을 허용한다. Audit는 Docker/Compose와 실제 image/container smoke가 없거나 실패하면 전체 실패한다.
- 기존 API의 CRL atomic writer를 보존하기 위해 총괄 승인으로 공개 동적 CRL 두 개만 전용 named volume으로 분리했다. `crl-init`은 API image의 non-root/network-none one-shot으로 RO seed를 검증·초기 공급하고, API만 runtime writer다. API device CRL은 `/run/device-crl`, MQTT CRL은 `/run/mqtt-crl`의 디렉터리 전체가 동일 volume이므로 기존 fsync+atomic rename이 가능하다. Broker는 MQTT CRL volume을 RO로 소비한다. 인증서/private key/CA/제조 CRL과 host seed는 계속 RO이고 migration은 CRL writer가 아니다. 재실행은 최신 CRL을 seed로 덮어쓰지 않는다.
- 총괄이 승인한 추가 파일은 `scripts/production-compose-config.mjs`, `apps/api/container-init-crls.cjs`이며 CRL 예외에 필요한 broker 경로·설계·계획 갱신을 포함했다. 기존 merge 명령 기대값인 `tests/mqtt-production-config.node.mjs`와 audit 직접 문자열 계약인 `scripts/ci-workflows.test.mjs`의 최소 갱신도 총괄 승인을 받아 포함했다.

## RED → GREEN

- 구현 전 `node --test scripts/production-deploy-contract.test.mjs apps/api/container-contract.node.mjs apps/web/container-contract.node.mjs`: **11 tests, 2 passed, 9 failed**, exit 1. API Dockerfile 부재 2, Web non-root/TLS/proxy/cache 미구현 3, standalone 렌더·hardening 부재 2, merged production 명령과 audit 경로 2였다. 당시 누락 env 음성 검사는 부정확하게도 invalid standalone에서 통과했으므로 이후 반드시 valid positive render를 먼저 확인하도록 보완했다.
- 추가 RED는 Web의 API private-key directory 노출, YAML flow의 쉼표로 분리된 invalid tmpfs 경로, preflight module 부재, private `web` SAN을 요구하는 healthcheck, `CMD true` no-op healthcheck를 각각 재현했다. 마지막 no-op guard를 추가한 뒤 계약 **13/13**, CI/MQTT 연결 계약 **9/9**를 다시 통과했다.
- 실제 image/startup RED가 정적 검사로는 드러나지 않는 오류를 잡았다. Prisma package.json export 차단은 설치된 Node package search path로 해결했고, pnpm deploy가 만든 `.prisma` stub은 실제 runtime package의 가장 가까운 `.prisma` 경로에 generated client를 복사해 해결했다. Alpine tini의 실제 경로 `/sbin/tini`, nginx PID `/run/nginx.pid`의 tmpfs 이동, MinIO 데이터 소유권, Docker internal network의 host port 미할당도 실제 실패 후 수정했다. Timeout/retry 상한은 늘리지 않았다.

- 동적 CRL 추가 계약 RED는 **15 tests, 12 passed, 3 failed**(initializer 부재, 서비스 경계, CRL writer 경계)였고 구현 후 **15/15**를 통과했다. 실제 disposable smoke에서도 seed 누락의 nonzero 실패와 기존 API publisher의 atomic rename을 검증했다.

- Self-review에서 cleanup 조회가 running container만 포함하는 것을 발견했다. Stopped one-shot 포함 계약은 focused **1 failed → GREEN**였으며 `docker container ls -aq`와 Docker 조회 실패의 fail-closed 처리를 추가했다. 최종 전체 계약 15/15 및 새 image build·smoke·정리를 재실행했다.

## 검증 결과

- `pnpm production:contract`: **15/15**, skip 0. Docker Compose 실제 렌더를 사용하며 required 변수 32개는 positive control 후 각각 제거해 failure를 확인한다.
- `node --test tests/mqtt-production-config.node.mjs scripts/ci-workflows.test.mjs`: **9/9**.
- `pnpm workspace:prepare`, API/Web 각각 `typecheck`와 `build`: exit 0. Web은 2,437 modules이며 bundle audit는 main **314.83 kB / gzip 97.58 kB**다.
- `pnpm --filter @led-control/api run test --runInBand`: **120 suites / 1,138 passed / 289 environment-dependent skipped**. `pnpm --filter @led-control/web test`: **60 files / 686 passed**, skip 0. API test 첫 호출은 상위 pnpm launcher가 `test --runInBand`를 자체 옵션으로 해석해 실패했으므로 명시적인 `run test`로 실행했다. 테스트 로직이나 timeout을 변경하지 않았다.
- `pnpm ci:production-audit`: **exit 0**. Production contract 15/15, MQTT config 2/2, Gateway container contract 24/24, required MQTT persistence/ACL integration 2/2, Web bundle, 실제 smoke, fresh dependency audit 순서로 전부 통과했다. 최종 full audit는 동적 CRL 보완을 포함한 project `led-production-smoke-c262d65fae571bc9029801b05ed42f17`에서 새 image build와 전체 smoke를 다시 수행했다. 이후 cleanup proof를 종료된 container까지 포함하도록 강화하고 아래 최종 smoke 및 계약 15/15를 재실행했다.
- Dependency audit: **820 dependencies; Critical 0, High 2, Moderate 1, Low 0; unexpected 0**. 기존 image-size patch 예외 2건과 ExcelJS uuid 예외 1건을 숨기지 않고 출력했다.
- `git diff --check`: 통과. `git diff --exit-code 03af2cd -- docker-compose.yml apps/api/prisma packages/shared apps/web/src`: 통과. 개발 Compose, schema/migrations/shared 계약과 Task 3 React 코드는 변경하지 않았다.

## 성공 disposable smoke

프로젝트: `led-production-smoke-6be28d53d9e51cbd076b11054b0d2c16`

| 항목 | 증거 |
| --- | --- |
| API image | `led-production-smoke-6be28d53d9e51cbd076b11054b0d2c16-api:sha-6be28d53d9e51cbd076b11054b0d2c16` |
| API image ID | `sha256:8b42a142595fb99c75d922a51dfc7d3744affe13d6bf92d26001773602b11425` |
| Web image | `led-production-smoke-6be28d53d9e51cbd076b11054b0d2c16-web:sha-6be28d53d9e51cbd076b11054b0d2c16` |
| Web image ID | `sha256:68c059c1a621e85fcb529b6b4ea2e09e1dc8437dcd8919c7faa8103137210be0` |
| 빈 DB 증명 | migration 전 public tables `0` |
| Migration | repository 57개와 `_prisma_migrations` finished/non-rollback row **57/57** 일치, migration exit 0 |
| 동일 image·순서 | migration/API Docker image ID 동일, migration FinishedAt ≤ API StartedAt |
| 의존성 | PostgreSQL·Redis·MQTT·Object Storage 네 check 모두 `up`, API `/health/live`·`/health/ready` 200 |
| Vault | internal 네트워크의 HTTPS lookup-self만 제공; generated token 검증, renewable 3600s/gateway-pki 응답. 실제 Vault와 미접촉 |
| Web | TLS 1.2·1.3 모두 200, HTTP 308, `/api/health/*` same-origin proxy, request ID response 보존 |
| 캐시·보안 | index no-cache, 실제 hashed JS immutable, shell/asset/API 응답의 HSTS/nosniff/frame/referrer header |
| TLS negative | 신뢰하지 않는 client CA는 실패. nginx upstream identity를 `wrong.invalid`로 바꾸면 502, `api`로 복원하면 200 |
| 장애 주입 | 해당 프로젝트 Redis만 중지 → ready 503/redis down, live 200, 실제 Web health command nonzero. Redis 재시작 → ready 200 |
| 동적 CRL | missing seed nonzero; 기존 API publisher로 두 CRL atomic publish; API·broker checksum 일치; broker RO; host seed 불변; init 재실행 no rollback; 해당 broker SIGHUP 뒤 ready 200 |
| 정리 | `CLEANUP ... containers=0 volumes=0 networks=0 owned-images=0`; 해당 프로젝트 데이터/CRL 볼륨 6개와 private PKI/env/temp directory 제거 |

실패했던 실행도 각각 같은 exact cleanup 증거를 남겼다. suffix는 `1139ddcca64c486a3f5654254232e4aa`, `a85fe5401b4e1612d24b7830a8b1f99f`, `ceef9927b2b69cbbd69fdcbdf502730d`, `4bf26ccc1274198ac52085e7cf8bcc2c`, `d6fbd88437cd0ac8bb3f2dc706509cc8`, `14c7801c09d389279af76623a02024ba`, `3248ad2b84453a846de49d52d47e5cf3`, `b8706db49165e9ebf0a17895caeb685f`, `471196aa6c69a9cd745d182c89a9399c`다. Docker prune나 default project·기존 named volume 정리는 하지 않았다. Shared base image/build cache는 광범위 정리하지 않았다.

## Self-review·한계

- 모든 rendered service의 image/port/dependency/user/read-only mount/health/resource/restart 경계를 대조했다. Secret 값은 임시 디렉터리에서 생성했고 tracked 파일이나 출력에 기록하지 않았다. Cleanup은 crypto project label과 exact tag만 대상으로 하며 개발 Compose는 기준 commit과 byte-identical이다.
- 운영 deploy/push/merge, secret 변경, 사용자 DB migration, real external Vault/MQTT/Object Storage, Raspberry Pi/BlueZ/ESP32-H2 HIL, Task 3 React 변경은 실행하지 않았다. 실제 외부 PKI issuance/renewal, bucket public URL·CORS와 MQTT public URL 진입점은 이 smoke의 완료 증거가 아니다.
- 동적 공개 CRL에 한정한 승인된 RW 예외로 기존 API writer의 atomic 발행을 보존했다. API TLS consumer는 writer와 같은 process라 동일 RW 공개 파일을 읽고 broker는 RO다. Broker 자동 reload sidecar는 추가하지 않았으므로 운영자는 CRL 갱신 후 해당 production project의 `mqtt-tls`에 SIGHUP을 전달해야 한다. 실제 운영 PKI issuance/renewal 수명주기까지 검증했다고 해석하면 안 된다. Web-only host-port 정책 아래 public MQTT/Object Storage 접근 경로도 운영에서 연결해야 한다. API container 교체로 upstream IP가 바뀌면 nginx 재기동/재해석 절차가 필요하며 rolling deployment는 범위 밖이다.
- API/Web runtime은 non-root지만 MinIO는 위에서 설명한 UID 0 예외다. OS/base image 취약점 스캐너, 공인 인증서 발급, 외부 metrics/log backend, alerts와 production rollout은 구성하지 않았다.

## 리뷰 수정: 프로젝트 격리와 socket mTLS 경로

- Ruling: standalone 파일만으로 개발/운영 Compose 자원이 분리된다고 가정하지 않는다. 운영 전용 project를 필수 검증하고 render/up에 동일 `-p`를 사용한다. Cost if wrong: 개발 DB·broker volume 재사용과 서비스 교체로 사용자 데이터/실행 환경을 손상할 수 있다.
- Ruling: 브라우저 HTTP reverse proxy로 장비 TLS peer identity가 유지된다고 가정하지 않는다. Web-only 별도 TCP passthrough에서 API를 TLS/mTLS terminator로 유지한다. Cost if wrong: 정상 장비·제조 요청이 모두 401로 차단되거나 우회 certificate header 신뢰로 인증 경계가 약해진다.
- `PRODUCTION_COMPOSE_PROJECT`는 `led-production-` prefix의 소문자 영숫자·단일 하이픈 조합, 최대 63자이며 checkout 기본 이름과 default/dev/development 예약값을 거부한다. 동일 helper가 config와 up의 명시적 `-p` prefix를 만들고 project 밖/external named volume을 거부한다. 실제 CLI check 성공과 check/up의 missing/invalid/default-collision 실패, 설정 값 비노출, 개발 및 다른 production project와 volume 분리를 검증한다.
- `DEVICE_API_HTTPS_PORT`를 Web의 9443 TCP listener에만 publish한다. 새 `apps/web/nginx.stream.conf`는 `api:4000`으로 encrypted TCP를 전달하며 TLS를 종료하거나 certificate header를 신뢰하지 않는다. API/guard/source/schema/shared 계약은 변경하지 않고 브라우저 `/api/` HTTPS proxy와 secret mount도 유지했다. 실제 장비 endpoint hostname과 내부 `api`가 API certificate SAN에 필요하다. Stream은 URI를 필터링하지 않으므로 API 기존 인증·인가가 모든 경로를 보호한다.
- 최초 리뷰 RED: **17 tests, 13 passed, 4 failed** — 필수 project, project validator/분리, Web 세 번째 port, nginx stream 부재. 추가 negative는 9443을 제거한 preflight가 거부하지 않음을 재현했다. CLI 행동 테스트는 Node 24.19.0이 `--env-file`을 자체 옵션으로 선처리해 exit 9가 되는 현상을 발견했고 명시적 `node -- script` separator로 수정했다. 최종 계약 **18/18**, CI/MQTT 연결 계약 **9/9**다.
- API/Web typecheck/build를 다시 수행했다. 전체 API **120 suites / 1,138 passed / 289 environment-dependent skipped**, 전체 Web **60 files / 686 passed**다. Schema/migrations/API guard·서비스·React 소스는 수정하지 않았다.
- 현재 required env는 기존 32개와 project/device port를 합한 **34개**이며 각각 누락 시 실제 Compose render 실패를 확인한다. 최종 self-review에서 개발 비교 렌더도 `/dev/null` env-file로 고정해 개발 `.env`를 읽지 않도록 한 뒤 계약 **18/18**과 CI/MQTT **9/9**, `git diff --check`를 다시 통과했다. 이 마지막 변경은 테스트 입력 격리뿐이며 production artifact와 최종 audit image는 동일하다.
- 첫 실제 passthrough 검증 project `led-production-smoke-656639a59f0de93ab932beba126ddbc5`: pinned nginx image의 stream 지원과 실제 guarded 제조 route의 no-cert **401**, 유효 disposable 제조 cert+빈 serial **400 / serialNumber is required**, 잘못된 API server identity의 TLS 실패, Inventory/Enrollment row **0/0**, browser proxy **200**을 확인했다. DB validation은 UUID/token 생성·DB I/O 이전에 실패하므로 인증서 발급이나 의미 있는 상태 변경을 수행하지 않는다. 57/57 migration·CRL atomic publish·Redis fail/recover와 exact cleanup도 통과했다.
- 최종 `pnpm ci:production-audit`: **exit 0**. 계약 **18/18**, MQTT config **2/2**, Gateway **24/24**, 실제 MQTT persistence/ACL **2/2**, Web bundle **314.83 kB / gzip 97.58 kB**, 아래 새 image build/smoke, dependency policy 모두 통과했다. Dependency **820**, Critical **0** / High **2** / Moderate **1** / Low **0**, 기존 승인 예외 **3** / unexpected **0**다.

| 최종 리뷰 수정 smoke | 증거 |
| --- | --- |
| Project | `led-production-smoke-20c71af3d390cb402599e5abe546bfb5` |
| API image | `led-production-smoke-20c71af3d390cb402599e5abe546bfb5-api:sha-20c71af3d390cb402599e5abe546bfb5` |
| API image ID | `sha256:1cd00a53de0911382614f7528f9b6c1dcc2d2b95486d542f243d2686b0fdcf7c` (user `node`) |
| Web image | `led-production-smoke-20c71af3d390cb402599e5abe546bfb5-web:sha-20c71af3d390cb402599e5abe546bfb5` |
| Web image ID | `sha256:80f27310ef44417670831939dce0d4e1bafd701ecdbca9faf6f5db1a534d594a` (user `nginx`) |
| Project boundary | 운영과 동일한 helper의 명시적 `-p` 인자·project name 일치, 모든 volume project prefix 검증, Web 세 host port만 loopback ephemeral publish |
| DB/migration | 최초 public tables **0**, migration **57/57**, migration/API 동일 image·migration 완료 후 API 기동 |
| mTLS | Web 9443 raw TCP→API: no-client **401**, valid-client/빈 serial **400**, 정확한 `serialNumber is required`; Inventory/Enrollment **0/0**; API server identity 검증 및 wrong identity TLS 실패 |
| Browser | TLS **1.2/1.3**, proxy/live/ready **200**, HTTP **308**, request ID·cache·security header 통과 |
| CRL | missing-seed nonzero, atomic publish **2**, consumer checksum 일치, broker RO, seed 불변, init no rollback, SIGHUP 후 ready **200** |
| Failure/recovery | wrong nginx upstream identity **502→200**; Redis 중단 ready **503**/live **200**/Web health nonzero→복구 ready **200** |
| Cleanup | `containers=0 volumes=0 networks=0 owned-images=0`; stopped one-shot 포함, 6개 데이터/CRL volume·임시 PKI/env 제거, broad cleanup 없음 |

운영 배포·push·merge·secret 변경·사용자 DB·실외부 Vault/MQTT/Object Storage·HIL은 실행하지 않았다. 실제 PKI issuance/renewal, 장비 공개 endpoint DNS/인증서, MQTT/Object Storage 외부 진입점은 운영 연결이 필요하다. 기존 CRL SIGHUP 절차·MinIO UID 0 예외·API 교체 후 nginx 재해석 한계는 유지한다. 리뷰 수정은 배포 artifact·계약 테스트·문서에만 한정했다.
