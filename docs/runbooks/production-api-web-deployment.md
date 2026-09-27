# API·Web 운영 배포와 장애 대응

기준일: 2026-09-17. [승인 설계](../superpowers/specs/2026-09-12-platform-deploy-observability-design.md), [운영 기준](../agent-operations.md), [현재 상태](../project-status.md)를 함께 따른다.

## 적용 범위와 사전 조건

### Command Set 세대 egress 준비 — 운영 전환 OFF

`COMMAND_SET_EGRESS_ENABLED=0`이 기본이다. 기존 API identity의 Set/Get과 수집은 계속 동작한다. ACL은 `sites/#` 대신 아래 명시적 권한으로 좁히되 OFF에서는 `sites/+/gateways/+/commands/dimming`과 구형 `sites/+/commands/dimming` write를 유지한다. `infra/mosquitto.acl.example`은 production Compose가 mount하는 OFF 예시이며 기존 Gateway onboarding의 `%u` scoped pattern도 유지한다. 전환 시에는 이 파일을 전체 Gateway 목록의 renderer 결과로 교체해야 한다. 전역 `pattern`은 새 Set principal에도 다른 권한을 주므로 ON에서는 남기지 않는다.

ACL 수정 전 확인한 공용 identity 토픽 목록은 모두 `sites/+/gateways/+/` 접두사를 사용한다.

| 방향 | 필요한 suffix |
| --- | --- |
| write: Get 및 제어 보조 | `commands/status-check` (legacy/recovery 공용), `commands/identify`, `commands/fixture-presence-check`, `commands/provisioning/{scan-start,scan-stop,identify-device,provision-device}`, `commands/mesh-group/{subscription-sync,resync-ack}`, `commands/automation/config-sync` |
| write: 수신 확인·시각 | `acks/state-ingested`, `acks/fixture-presence-check-completed`, `acks/provisioning/{scan-terminal-ingested,device-terminal-ingested}`, `acks/automation/{config-applied-ingested,execution-ingested,vehicle-sensor-capability-ingested}`, `events/clock/response`, `commands/drain/request` |
| read: ACK·상태 | `acks/{acceptance,device-status}`, `state/{fixtures,fixture-presence,heartbeat}` |
| read: 이벤트·시각 | `events/provisioning/{scan-found,scan-completed,scan-failed,device-terminal}`, `events/{provisioning-completed,provisioning-failed,provisioning-progress,identify-result,fixture-presence-check-completed,fixture-unreachable,mesh-node-metrics}`, `events/mesh-group/{resync-request,subscription-result}`, `events/automation/{config-applied,current-config-request,execution,vehicle-sensor-capability}`, `commands/clock/request`, `events/drain/response` |

위 목록은 19개 gateway-scoped write와 24개 read다. 추가로 production broker healthcheck의 정확한 `sites/health/production-probe` write를 유지한다. clock/drain, telemetry 호환 권한도 포함한다. Gateway에는 자기 clock request write/response read를 명시한다. 전환 후에도 이 목록을 그대로 유지한다.

명시적 개발/일회용 전환은 `COMMAND_SET_EGRESS_ENABLED=1`, 양의 `MQTT_SET_GENERATION=N`, 고유한 `MQTT_API_INSTANCE_ID`, 별도 `MQTT_SET_CLIENT_CERT_PATH`·`MQTT_SET_CLIENT_KEY_PATH`를 요구한다. 전용 인증서 CN은 정확히 `command-set-N`이며 key와 일치해야 한다. 서비스는 시작 시 active epoch의 `(generation, workerId, brokerIdentity)` DB member를 등록하고 publish마다 active·미ACK member를 재확인한다. 권한이 없는 DB 계정, 등록 실패, 잘못된 cert, epoch 없는 구 wire는 Set 거부로 남으며 shared API client로 fallback하지 않는다. clean MQTT v5/session expiry 0/자동 reconnect 없음은 로컬 lifecycle 특성일 뿐 broker drain 증거가 아니다. timeout 후 client를 닫고 해당 instance에서 추가 Set을 거부한다.

개발 prepare는 ON인 경우에만 `renderMosquittoAcl(ids, { setGeneration: N })`으로 두 legacy Set write를 제거하고 `command-set-N`에 dimming write 하나만 부여한다. 인증서 발급, DB migration/epoch 생성, 운영 broker reload는 자동 실행하지 않는다. 기본 production Compose는 credential mount·wire epoch producer·모든 노드 admission 검증이 준비되지 않았으므로 preflight에서 ON을 무조건 거부한다. 빈 Set credential 환경 입력은 준비 인터페이스일 뿐 사용 가능한 mount가 아니다.

후속 운영 전환에는 별도로 승인한 cert/key RO mount, DB publisher role, epoch/attempt producer, 전체 API·Gateway census를 준비하고 유지보수 절차에서 기존 발행 중지 → 모든 broker 구 principal 거부/세션·queue 폐기 → 새 epoch/credential/ACL/wire 일치 확인 → 신규 발행 재개를 검증해야 한다. 이 순서는 runbook 요구이며 Compose·ACL 파일 게시가 여러 프로세스의 원자적 전환을 제공한다는 뜻이 아니다. ACL/CRL 롤백 또는 broker 재시작은 stock Mosquitto에서 구세대를 되살릴 수 있다. 독립적인 단조 admission 최소 세대·폐기 원장·모든 broker 노드 증거와 Gateway RF drain/HIL 없이는 purge·recovery POST 및 운영 cutover를 계속 OFF로 둔다.

`BrokerGenerationFence.verifyRetired(generation)`의 기본 운영 adapter는 항상 `immutable_admission_unavailable`을 반환한다. `verified`는 일회용 검증용 `scope: disposable`에서만 존재하며 두 반환 분기 모두 `productionPurgeAllowed: false`다. JSON 증거·환경 변수·ACL 거부 응답·`client.end()`를 운영 승인으로 해석하지 않는다. 현재 구성 검사는 stock broker에서 purge 활성화를 거부한다.

일회용 증거도 배포/CA 관리 측에서 별도로 제공한 전체 broker census와 해당 세대의 모든 인증서 fingerprint 목록을 요구한다. 응답한 노드 목록으로 census를 대체하지 않는다. 각 노드는 같은 generation·요청 nonce·inventory revision·boot ID에 대해 인증서의 비가역 폐기, 기존 연결 0, persistent session 0, 구 Set을 보유한 subscriber outgoing queue 0, 새 구세대 publish 거부, 재시작/구 ACL/구 CRL/둘의 복원 뒤에도 단조 최소 세대와 폐기 원장 유지·거부를 모두 확인해야 한다. 노드 누락·중복, 다른 세대·이전 nonce, 조회 중 inventory/boot 변경, 시간 제한 초과는 전체 증거를 무효화한다. 수집은 단조 시각의 기본 1초 기한(최대 10초)으로 제한한다. 반환 deadline은 해당 verifier 프로세스 안에서만 유효하며 재시작 후 재사용하지 않는다. barrier 소비자는 같은 프로세스의 기한을 재확인하고 새 증거를 수집해야 하며, digest는 서명이나 운영 신뢰의 대체물이 아니다.

운영 adapter를 추가하려면 broker 설정/디스크 snapshot과 별개로 롤백할 수 없는 단조 최소 세대 및 CA 폐기 원장, 그 원장을 검증하지 못하면 입장 또는 기동을 거부하는 제어 계층, 전체 배포·인증서 inventory의 신뢰 경계, 모든 노드의 인증된 증거 수집을 먼저 마련해야 한다. 현재 인터페이스의 boolean 필드나 `source` 문자열은 외부 증거의 서명 검증을 구현한 것이 아니다. 운영 adapter·제한 worker 연동·DB clock의 재시작 연속성·Gateway census/RF HIL 승인은 후속 gate다.

`DEV_MQTT_ACL_INTEGRATION=1 node --test scripts/dev-mqtt-acl.integration.test.mjs`는 임시 CA/인증서와 임의 로컬 포트의 일회용 broker만 사용한다. 실제 stock broker에서 ACL 변경·재시작 후 오프라인 session/Set queue가 남는 반례, CRL 폐기 후 이전 ACL+CRL 복원 시 구 credential 발행이 다시 성공하는 반례를 재현하고 verifier가 거부하는지 검사한다. 별도 admission test double은 모든 롤백 뒤 구세대를 거부하되 운영 purge를 승인하지 않는다. 이 검증은 운영 broker/CA 설정 변경 절차가 아니다.

Task 3 시점에서 original-Command cutoff/permit과 recovery publisher 일부는 기존 미커밋 작업에만 있다. 이 egress 준비 커밋만으로 Get 복구·3개월 보관 안전성의 전체 커밋 연속성을 주장하지 않는다. 후속 Task 4/6에서 반드시 통합·검증한다.

이 절차는 단일 호스트의 standalone `docker-compose.production.yml`에 적용한다. 운영 배포 권한, 유지보수 시간, DB·Object Storage·CRL 백업과 복원 책임자, 승인된 API/Web release digest, Docker daemon/Compose, 저장소 Node 22·pnpm 9.15.0 환경이 필요하다. DNS·방화벽·외부 Vault와 MQTT/Object Storage 진입점은 별도로 준비한다. 이 작업은 `docker:up:production`, 운영 migration, 실장비 HIL, 실제 자격 증명 작업을 실행하지 않았다.

아래 명령은 저장소 루트에서 Bash로 실행한다. `/secure/path/.env.production`과 `led-production-sitea`는 자리표시자이므로 승인된 절대 경로와 운영 project로 바꾼다. 값이 든 env 파일을 shell에서 `source`하거나 출력하지 않는다. `set -x`, 전체 `docker inspect`, raw Compose config 출력은 secret을 노출할 수 있다.

## 1. 소스·artifact 확인 — 읽기 전용

```bash
git status --short
git rev-parse HEAD
node --version
pnpm --version
docker version
docker compose version
```

검토된 commit과 clean checkout인지 확인한다. 로컬 artifact를 재생성하는 아래 검증은 운영 서비스를 변경하지 않지만 빌드 출력·테스트 임시 자원은 만든다. 의존성 설치와 Prisma Client 생성은 승인된 CI의 frozen install 단계를 따른다.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @led-control/web test:bundle-audit
pnpm --filter @led-control/web exec playwright test --project=chromium --workers=1
pnpm production:contract
pnpm ci:production-audit
git diff --check
```

`production:contract`는 비밀이 없는 fixture로 실제 Compose render와 입력 누락·격리·TLS·기동 순서를 검사한다. `ci:production-audit`는 registry advisory 조회, Docker image build와 고유 disposable PostgreSQL/Redis/MQTT/MinIO smoke를 수행하는 로컬 상태 변경 검증이다. 임의 운영 project나 기존 volume을 입력받지 않고 자체 crypto project를 만들며, 종료 시 해당 자원만 제거한다. `CLEANUP ... containers=0 volumes=0 networks=0 owned-images=0`가 없으면 성공으로 판정하지 않는다. 운영 환경에서 장애 주입 smoke를 대체 실행하지 않는다.

## 2. 이미지 digest 준비 — 로컬 변경 / registry 승격은 별도 승인

검증된 소스의 API/Web Dockerfile은 각각 `apps/api/Dockerfile`, `apps/web/Dockerfile`이다. 승인된 빌드·registry 승격 절차에서 만든 image의 immutable reference를 `API_RELEASE_REF`, `WEB_RELEASE_REF` shell 변수로 전달한다. 두 값 모두 `repository@sha256:`와 64자리 digest여야 한다. 이미지를 내려받는 단계는 로컬 Docker 저장소를 변경한다.

```bash
docker pull "${API_RELEASE_REF:?Set approved API digest reference}"
docker pull "${WEB_RELEASE_REF:?Set approved Web digest reference}"
docker image inspect --format '{{.Id}} {{json .RepoDigests}} {{.Config.User}}' "$API_RELEASE_REF" "$WEB_RELEASE_REF"
```

API는 migration과 runtime에 같은 image를 사용한다. 로컬 image ID와 registry manifest digest는 서로 다른 식별자다. 승인된 env 파일의 `API_IMAGE`·`WEB_IMAGE`에 registry digest를 기록하는 것은 별도 release 설정 변경이다. `latest`, 개발 tag, commit tag와 smoke tag를 운영 값으로 사용하지 않는다. Smoke의 image ID는 registry 승격 증거가 아니다.

## 3. 필수 환경·PKI 경로 확인 — 읽기 전용

필수 입력 37개는 다음과 같다. 내부 URL의 PostgreSQL·Redis credential은 각각 서비스 설정과 일치하고 URL 인코딩해야 한다. 브라우저 origin 두 값은 동일한 승인 HTTPS origin을 사용한다. 도면·보고서 bucket은 모두 `anonymous none`으로 초기화하고 서로 다른 이름을 사용한다. 도면 업로드용 presigned PUT의 CORS origin은 `WEB_PUBLIC_URL` 하나로 제한하며, 조회는 인증된 API content endpoint가 발급하는 300초 signed GET만 사용한다.

| 구분 | 필수 env key |
| --- | --- |
| 격리·artifact | `PRODUCTION_COMPOSE_PROJECT`, `API_IMAGE`, `WEB_IMAGE` |
| DB·Redis | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`, `REDIS_PASSWORD`, `REDIS_URL` |
| MQTT | `MQTT_URL`, `MQTT_PUBLIC_URL`, `MQTT_API_INSTANCE_ID`, `MQTT_TLS_CERT_DIR` |
| Vault | `VAULT_ADDR`, `VAULT_TOKEN_FILE`, `VAULT_CA_CERT_PATH`, `VAULT_PKI_DEVICE_MOUNT`, `VAULT_PKI_DEVICE_ROLE`, `VAULT_PKI_MQTT_MOUNT`, `VAULT_PKI_MQTT_ROLE` |
| Object Storage | `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_PUBLIC_URL`, `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REPORT_BUCKET`, `OBJECT_STORAGE_REGION` |
| CAD converter | `CAD_IMPORT_CONVERTER_BUNDLE_PATH`, `CAD_IMPORT_CONVERTER_ARGV_JSON`, `CAD_IMPORT_CONVERTER_SHA256` |
| API·Web TLS·port | `API_TLS_CERT_DIR`, `WEB_TLS_CERT_DIR`, `WEB_PUBLIC_URL`, `WEB_HTTPS_ORIGIN`, `WEB_HTTP_PORT`, `WEB_HTTPS_PORT`, `DEVICE_API_HTTPS_PORT` |

명령 상세 GET의 독립 3개월 경계는 `COMMAND_HISTORY_RETENTION_ENABLED`가 기본 `0`이다. 활성화 검토 시 중앙 DB에 read-only 자격증명으로 `pnpm --filter @led-control/api exec tsx src/commands/command-history-readiness.cli.ts`를 실행해 DB UTC cutoff와 cutoff 이전 hold 없는 pending/unknown 0건을 확인하고, 출력 시각·건수·릴리스 digest를 변경 기록에 남긴다. 양수면 오류 출력의 opaque ID를 조사하고, SQL/권한 오류도 실패로 취급한다. 현재 production Compose preflight는 이 증거를 배포 입력에 안전하게 결합하는 단계가 없어 `1`을 거부한다. 이 경로를 검증·통합하기 전에는 운영 flag를 켜지 않는다. 이 GET 경계는 물리 purge·recovery POST·publisher를 활성화하지 않는다.

`PRODUCTION_COMPOSE_PROJECT`는 `led-production-` prefix, 소문자 영숫자와 단일 하이픈, 최대 63자다. checkout 기본 project와 `led-production-default/dev/development`는 거부한다. 신규 배포는 해당 이름의 기존 자원 부재를 확인하고, 업데이트는 정확한 기존 운영 project와 백업 대상 volume을 승인 기록에 대조한다. 모든 named volume은 project prefix를 가져야 하며 external/shared volume은 금지한다.

| host 경로 입력 | 필요한 파일 / container 소비 경로 |
| --- | --- |
| `API_TLS_CERT_DIR` | `api.crt`, `api.key`, `api-ca.crt`, `device-ca.crt`, `manufacturing-ca.crt`, `device.crl`, `manufacturing.crl`; API의 `/run/api-tls` RO |
| `MQTT_TLS_CERT_DIR` | `mqtt-ca.crt`, `mqtt-server.crt`, `mqtt-server.key`, `api-client.crt`, `api-client.key`, `mqtt-client.crl`; broker 인증서 RO, API client 파일만 RO |
| `WEB_TLS_CERT_DIR` | `web.crt`, `web.key`, `web-ca.crt`; `/run/web-tls` RO |
| `VAULT_TOKEN_FILE`, `VAULT_CA_CERT_PATH` | readable regular token·CA 파일; `/run/vault/token`, `/run/vault/ca.crt` RO |
| `CAD_IMPORT_CONVERTER_BUNDLE_PATH` | 운영 승인된 절대 directory; `/opt/cad-converter` RO, 실행 파일은 `/opt/cad-converter/bin/converter` |

CAD converter bundle은 운영자가 별도로 승인·배포하며 API image에 복사하지 않는다. GPL LibreDWG는 production image/bundle 계약에 포함하지 않는다. Bundle은 read-only에서도 실행 가능한 self-contained binary 또는 승인된 shared-library/RPATH 구성을 가져야 한다. `CAD_IMPORT_CONVERTER_ARGV_JSON`은 shell 문자열이 아닌 JSON string array이며 `{input}`, `{output}`을 각각 정확히 한 번 포함한다. `CAD_IMPORT_CONVERTER_SHA256`은 `/opt/cad-converter/bin/converter`의 승인 SHA-256이다. Host preflight는 bundle/bin/file의 symlink 금지, 동일 owner, group/world 쓰기 금지, owner execute와 digest를 확인하고 sidecar가 mounted file을 startup·job마다 다시 검증한다.

Production converter는 API와 별도 UID 2000, read-only rootfs, `network_mode: none`, 1024 MiB cgroup, heap 64 MiB, pids 64, `/tmp` 64 MiB인 sidecar다. API는 UID 1000, 1408 MiB cgroup, heap 256 MiB, core heap 384 MiB, CAD concurrency 1, `/tmp/cad-import` 512 MiB다. 두 container는 UID 1000:GID 2000 소유의 512 MiB tmpfs spool만 공유한다. API에는 converter bundle/argv가 없고 sidecar에는 DB/S3/Vault/MQTT/TLS env·mount가 없다. Source 50 MiB, DXF 256 MiB, raw SVG 128 MiB, gzip SVG 8 MiB와 filesystem overhead 64 MiB를 공통 상한으로 두고 worker가 렌더 전에 raw+gzip+overhead 200 MiB를 예약한다. Sidecar 내부 `/usr/bin/prlimit`가 AS 512 MiB, CPU 60초, nofile 64, nproc 32, fsize와 process-group timeout을 적용한다. 공유 spool의 `.ready.json`은 영구 플래그가 아니라 instance ID와 2초 TTL을 가진 heartbeat다. Sidecar는 startup attestation 전에 이전 marker를 제거하고, API와 container healthcheck는 digest와 freshness를 모두 검증한다. 취소 요청과 변환 중 readiness 상실은 API가 최대 1초간 terminal 응답을 기다린 뒤 job-local directory를 정리한다.

실제 경로의 파일 존재·소유권·container UID별 읽기 권한을 제한된 운영 세션에서 확인한다. API/migration UID 1000, Web UID 101, Mosquitto UID 1883이다. Private key를 누구나 읽을 수 있게 바꾸지 않는다. API 인증서는 내부 `api`와 실제 장비 endpoint hostname을 SAN에 포함하고 MQTT 서버 인증서는 내부 `mqtt-tls` 및 승인된 공개 진입 hostname 계약과 맞아야 한다. Web 인증서는 public browser hostname을 검증하고 `web-ca.crt`가 그 chain을 신뢰해야 한다.

```bash
export PRODUCTION_COMPOSE_PROJECT=led-production-sitea
export PRODUCTION_ENV_FILE=/secure/path/.env.production
node -- scripts/production-compose-config.mjs check --project "$PRODUCTION_COMPOSE_PROJECT" --env-file "$PRODUCTION_ENV_FILE"
docker container ls -a --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT"
docker volume ls --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT"
docker network ls --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT"
```

Preflight는 입력 값을 출력하지 않으며 mount 파일 존재/내용, 실제 DNS·TLS 연결, 기존 DB 호환성과 backup 성공까지 보장하지 않는다. 이후 직접 Compose 진단도 helper와 같은 제한된 환경과 명시적 project/env/standalone 파일을 쓴다. 아래 Bash 함수는 현재 shell만 변경하며 서비스는 실행하지 않는다. 매번 preflight가 성공한 경우에만 요청한 Compose 명령을 실행한다.

```bash
production_compose() {
  node -- scripts/production-compose-config.mjs check --project "${PRODUCTION_COMPOSE_PROJECT:?}" --env-file "${PRODUCTION_ENV_FILE:?}" || return
  env -i PATH="$PATH" HOME="$HOME" DOCKER_HOST="${DOCKER_HOST-}" DOCKER_CONTEXT="${DOCKER_CONTEXT-}" \
    PRODUCTION_COMPOSE_PROJECT="$PRODUCTION_COMPOSE_PROJECT" \
    docker compose -p "$PRODUCTION_COMPOSE_PROJECT" --env-file "$PRODUCTION_ENV_FILE" -f docker-compose.production.yml "$@"
}
production_compose ps -a
```

## 4. 백업·유지보수 승인과 migration — 운영 상태 변경

운영자는 배포 대상 project, DB identity, 복원 가능한 최신 backup과 복구 시점, 이전/새 digest 및 schema 호환성을 먼저 승인받는다. DB뿐 아니라 Object Storage, broker persistence, 최신 device/MQTT CRL도 함께 복구 계획에 넣는다. 이 문서는 사용자 DB backup/restore를 자동 실행하지 않는다. 기존 서비스 업데이트는 유지보수 창에서 트래픽·write 유입을 차단한다. 먼저 CAD job을 조회해 `processing`과 `applying`을 0으로 drain하고, `review_required`는 유지하거나 운영자가 명시적으로 취소한다. queued job은 migration 뒤 새 worker가 source SHA로 profile을 resolve하므로 임의 backfill하지 않는다. drain 확인 후 아래와 같이 Web/API를 멈춘다. 정지와 API shutdown은 서비스 가용성을 바꾼다.

```sql
SELECT status, count(*) FROM "FloorImportJob"
WHERE status IN ('processing', 'applying') GROUP BY status;
```

위 조회 결과가 한 행이라도 있으면 배포를 시작하지 않는다. `20260917144000_cad_profile_upgrade_gate`가 singleton/trigger를 먼저 설치해 구 worker의 queued→processing claim도 DB에서 거부한다. `20260917145000_cad_profile_upgrade_preflight`와 `20260917160000_cad_upgrade_safety`는 table lock 뒤 active 상태를 발견하면 fail-close하며, `20260917170000_cad_profile_upgrade_release`만 전체 profile/content migration 완료를 확인하고 gate를 연다. 10초 안에 lock을 얻지 못하면 transaction이 rollback되며 부분 schema를 정상으로 간주하지 않는다.

```bash
production_compose stop web api
```

승인된 env 파일과 digest 확인 후 운영 기동은 다음 한 경로만 사용한다. **`docker:up:production`은 선택된 운영 환경의 container·volume·bucket/CRL 초기화와 DB migration을 실제 변경한다. 이 Task에서는 실행하지 않았다.** 개발 Compose와 production Compose를 합치지 않는다.

```bash
PRODUCTION_COMPOSE_PROJECT=led-production-sitea PRODUCTION_ENV_FILE=/secure/path/.env.production pnpm docker:up:production
```

`api-migrate`는 PostgreSQL healthy 뒤 동일 API image의 `prisma migrate deploy`를 실행한다. migration exit 0 → API 시작·네 의존성 readiness 200 → Web 시작 순서다. `crl-init` 성공 뒤 API/broker가 시작하고 Object Storage bucket init 성공도 API의 선행 조건이다. `up -d` 반환만으로 전체 서비스 정상 기동을 판정하지 않고 아래 상태·health를 확인한다.

```bash
production_compose ps -a
production_compose logs --no-color --tail=100 api-migrate crl-init object-storage-init
```

Migration은 forward-only다. Prisma 자동 down migration은 없고 실패 시 API를 수동으로 선기동하거나 실패 migration을 임의 성공 처리하지 않는다. Active CAD job 또는 lock timeout으로 transaction이 rollback된 경우 DB 담당자가 원인과 미적용 상태를 확인하고 해당 migration만 `prisma migrate resolve --rolled-back`로 기록한 뒤 drain부터 다시 수행한다. `--applied`로 우회하지 않는다. 새 schema와 호환되는 이전 image만 image rollback이 가능하며, 비호환 rollback은 DB 담당자가 승인한 backup restore/복구 절차가 필요하다. `migrate reset`, `db push --force-reset`, 임의 테이블 삭제는 이 runbook의 작업이 아니다.

## 5. Health·요청 상관관계 — 읽기 전용 점검

공인 HTTPS와 same-origin `/api/`에서 확인한다. 아래 hostname과 CA 경로는 운영 값으로 대체한다. `curl -k`로 TLS 검증을 끄지 않는다. Header에는 승인된 correlation ID만 넣고 tenant나 장비 식별자를 넣지 않는다.

```bash
curl --fail-with-body --silent --show-error --max-time 5 --cacert /secure/path/web-ca.crt https://control.example.invalid/api/health/live
curl --fail-with-body --silent --show-error --max-time 5 --cacert /secure/path/web-ca.crt --header 'X-Request-Id: operator-health-check' --dump-header - https://control.example.invalid/api/health/ready
curl --fail-with-body --silent --show-error --max-time 5 --cacert /secure/path/web-ca.crt https://control.example.invalid/api/health/metrics
```

Live 200 body는 `{"status":"live"}`다. Ready는 `status: ready | not_ready`, `checks`의 `postgres | redis | mqtt | objectStorage: up | down`, ISO `timestamp`만 반환한다. 하나라도 down이거나 shutdown 중이면 503이다. 내부 URL, SQL, credential, 오류 메시지와 stack은 없다. Metrics는 `http`의 `requestsTotal`, `responses4xxTotal`, `responses5xxTotal`, `latencyMsSum`, `latencyMsMax` 및 `readiness.status`, `readiness.dependencyFailuresTotal` 네 고정 key만 가진 JSON이다. `/health/*`는 인증 없이 접근 가능하며 secret·tenant label이 없다.

유효한 `X-Request-Id`는 영숫자로 시작하는 최대 128자의 영숫자·`.`·`_`·`:`·`-`다. 그 외 값은 UUID v4로 바뀐다. 응답 ID와 API JSON-line log의 `requestId`를 맞춰 timestamp, method, route template, statusCode, durationMs를 조회한다. 로그는 body/query/cookie/authorization/raw device/stack을 기본 기록하지 않는다. Compose의 다른 서비스 로그는 같은 redaction 보장이 없으므로 제한된 세션에서만 보고 공유 전 별도 정제한다.

```bash
production_compose logs --no-color --since=10m --tail=200 api
```

## 6. 브라우저 TLS·장비 mTLS — 읽기 전용 점검과 별도 HIL

```bash
curl --silent --show-error --max-time 5 --head http://control.example.invalid/
curl --fail --silent --show-error --max-time 5 --cacert /secure/path/web-ca.crt --tlsv1.2 --tls-max 1.2 --head https://control.example.invalid/
curl --fail --silent --show-error --max-time 5 --cacert /secure/path/web-ca.crt --tlsv1.3 --head https://control.example.invalid/
openssl x509 -in /secure/path/api-tls/api.crt -noout -checkhost api
openssl x509 -in /secure/path/api-tls/api.crt -noout -checkhost devices.example.invalid
curl --fail --silent --show-error --max-time 5 --cacert /secure/path/api-tls/api-ca.crt https://devices.example.invalid:9443/health/live
```

HTTP 308의 Location, TLS 1.2/1.3, index no-cache, 실제 `/assets/` hashed JS immutable, HSTS/nosniff/frame/referrer header를 확인한다. 브라우저 개발자 도구에서 API가 같은 HTTPS origin의 `/api/`를 사용하며 TLS 오류·혼합 콘텐츠가 없는지 확인한다. nginx는 API upstream HTTPS의 내부 `api` identity를 검증한다.

장비 endpoint는 `DEVICE_API_HTTPS_PORT`에 지정한 host port로 바꾼다(위 9443은 예시). Web 9443 stream은 암호화 TCP를 `api:4000`에 넘기며 API가 TLS와 socket client certificate를 검증한다. 브라우저 HTTPS proxy는 장비 인증 endpoint의 대체 경로가 아니다. Stream은 URI 필터가 없으므로 기존 API 인증·인가가 모든 경로를 책임진다. Live 점검은 server TLS/DNS만 확인한다. 승인된 장비 인증서의 실제 guarded API 요청과 발급·갱신·폐기, Raspberry Pi/ESP32-H2 HIL은 별도 승인된 절차에서 검증한다. 운영 제조 등록 요청을 smoke 재현 목적으로 보내지 않는다.

## 7. 동적 CRL 발행과 broker reload — 운영 상태 변경

인증서/key/CA/제조 CRL·host seed는 RO다. 공개 device/MQTT CRL 두 파일만 각각 `device-crl`, `mqtt-crl` named volume에서 API의 RW atomic rename을 허용한다. non-root/network-none `crl-init`은 seed를 검사해 빈 volume만 초기화하고 기존 최신 CRL을 덮어쓰지 않는다. API는 device CRL을 같은 process에서 소비하고 Mosquitto는 MQTT CRL volume을 RO로 읽는다. 오래된 host seed로 최신 volume을 덮어쓰면 안 된다.

승인된 기존 PKI 발행·폐기 절차가 완료됐는지 확인하고 공개 파일 checksum을 대조한 뒤 **해당 project의 broker만** SIGHUP한다. 명령 전후 API readiness와 broker 오류를 확인한다. Checksum 조회는 읽기 전용이고 SIGHUP은 broker TLS 상태 변경이다. 자동 reload sidecar는 없다.

```bash
production_compose exec -T api sha256sum /run/mqtt-crl/mqtt-client.crl
production_compose exec -T mqtt-tls sha256sum /mosquitto/crls/mqtt-client.crl
production_compose kill -s SIGHUP mqtt-tls
production_compose logs --no-color --since=5m --tail=100 mqtt-tls
```

Checksum 일치는 CRL 내용의 권한·서명·기한이나 기존 TLS 연결의 즉시 폐기를 증명하지 않는다. 실제 폐기 전파와 reconnect 동작은 승인된 PKI/HIL 절차가 필요하다.

## 8. Rollback·정지·장애 진단

Image rollback은 유지보수 승인, schema compatibility 검토와 이전 digest 확인 후 env release 값 변경→preflight→운영 기동 순서를 다시 따른다. API 교체로 container IP가 바뀌면 nginx HTTP/stream upstream은 자동 재해석을 보장하지 않으므로 새 API readiness가 정상인 뒤 Web을 재시작하고 browser/device 경로를 다시 확인한다. 이 재시작은 연결 중단을 일으킨다.

```bash
production_compose restart web
```

운영 정지는 승인된 유지보수 시간에 다음을 사용한다. `stop`은 container와 named volume을 보존한다. 운영 자원에 `down --volumes`, prune 또는 smoke cleanup을 적용하지 않는다.

```bash
production_compose stop web api
production_compose stop
production_compose ps -a
```

장애 시 먼저 project/digest와 migration exit 상태를 확인한다. Live down은 process/bootstrap/TLS를, live up·ready down은 네 dependency check를, ready up·browser 502는 nginx upstream identity/IP·CA와 Web log를 확인한다. 401은 비로그인, 403·비일시 오류는 재로그인, network/5xx는 최대 2회 재시도와 수동 복구다. Offline 부팅은 연결 복구를 기다린다. Lazy/render 실패는 전체 새로고침이 기본이며 entry bundle 자체를 못 읽는 오류는 React boundary 실행 전이다. 서버 logout 실패 시 로컬 cache는 정리되지만 HttpOnly cookie 폐기를 보장하지 않아 새 document의 서버 세션 판정은 별개다.

```bash
production_compose logs --no-color --since=10m --tail=200 web
production_compose logs --no-color --since=10m --tail=100 postgres redis mqtt-tls object-storage
```

운영에서 readiness 실패를 지우려고 dependency를 무작정 재시작하거나 timeout/retry를 늘리지 않는다. Vault token/CRL bootstrap 실패는 정제된 startup error와 승인된 PKI 진단 절차로 조사한다. Readiness는 Vault issuance/renewal을 직접 probe하지 않는다. PostgreSQL/Redis의 취소 불가능한 raw probe가 끝나지 않으면 coalesced down 상태가 유지될 수 있어 기존 transport 복구 또는 승인된 API 재시작 판단이 필요하다.

## 관측 연결과 권장 알림

현재 외부 metrics backend, dashboard, alert 전달, log shipping은 구성하지 않았다. 다음은 운영 수집·SLO를 정한 후 적용할 권고이며 자동 발송되는 알림이 아니다.

| 조건 | 판단·후속 |
| --- | --- |
| 지속 readiness down | 유지보수 제외 연속 실패 창을 정하고 네 dependency와 migration/bootstrap을 확인 |
| 5xx 비율 상승 | `responses5xxTotal` 증가량 / `requestsTotal` 증가량; 표본 수와 재시작 reset 처리 |
| latency 상승 | `latencyMsSum` 증가량 / 요청 증가량으로 구간 평균 관찰; `latencyMsMax`는 process lifetime 최대이며 percentile 지표가 아님 |
| dependency failure 증가 | 네 고정 failure counter 증가량과 probe 빈도를 함께 확인; 독립 장애 건수로 해석하지 않음 |
| 반복 Web recovery/offline | 브라우저 지원 접수·합성 점검 등 별도 수집 필요; 현재 프론트 오류 전송 backend는 없음 |
| CRL reload 실패 | 승인된 발행 결과·checksum·broker reload log·기한·실제 재접속 검증으로 판단 |
| migration 실패 | one-shot nonzero는 release 중단; DB 복구 책임자에게 escalate하고 API 선기동 금지 |

Metrics는 process-local이며 재시작 시 초기화된다. 여러 instance 합산, durable 보존, route/tenant label, p95/p99 histogram은 제공하지 않는다. 단일 호스트 Compose는 rolling·multi-region·zero-downtime orchestration을 제공하지 않는다. API/Web은 non-root지만 MinIO는 upstream `/data` 소유권 때문에 UID 0·capability 없음 예외다. Web만 세 host port를 publish하므로 MQTT/Object Storage의 외부 TLS 진입점은 별도 운영 구성이 필요하고 smoke로 외부 경로 정상 여부를 판정하지 않는다. Object Storage 진입점을 구성하더라도 두 bucket의 anonymous 접근은 금지하며, CORS는 승인된 `WEB_PUBLIC_URL`에서의 presigned PUT만 허용하고 다운로드는 인증 endpoint에서 발급한 300초 signed GET 경로를 유지한다.

## 검증 증거와 남은 승인

Task 19.5 최종 보정 뒤 상시 synthetic production smoke는 고유 project `led-production-smoke-b523bf418592c6719e549d3cd791d4aa`에서 빈 DB migration 84/84, API/sidecar 별도 cgroup `1476395008`/`1073741824`, API temp 512 MiB, UID/process/network 분리와 secret env·mount 부재를 확인했다. 실제 Nest worker/core, PostgreSQL/MinIO와 HTTP create/status/candidates/content/apply를 통과했고 정상 gzip signed GET 뒤 malformed, output bomb, memory bomb, timeout을 처리해 API와 sidecar readiness가 유지되며 정상 재처리가 `review_required`로 복귀했다. Stale heartbeat, startup digest mismatch, API abort/readiness-loss acknowledgment과 사라진 job directory는 별도 회귀 테스트로 고정했다. 종료 시 container/volume/network/owned image가 모두 0이었다. 이 synthetic 결과는 승인된 실제 converter와 제공 DWG의 opt-in sample HIL, 운영 DB backup/migration/restore 또는 실장비 HIL을 대신하지 않는다.

실도면 sample HIL은 승인된 로컬/격리 환경에서만 다음 입력을 명시한다. Converter argv는 제품 bundle의 CLI 계약에 맞춰 바꾸며, production host에서는 같은 승인 bundle의 executable을 사용한다.

```bash
CAD_SAMPLE_DWG_PATH=/approved/sample.dwg \
CAD_SAMPLE_CONVERTER_PATH=/approved/converter-bundle/bin/converter \
CAD_SAMPLE_CONVERTER_ARGV_JSON='["{input}","{output}"]' \
RUN_OBJECT_STORAGE_INTEGRATION=true \
pnpm --filter @led-control/api exec jest src/floor-import/cad-sample-pipeline.integration.spec.ts --runInBand
```

Task 4의 fresh root lint/typecheck/test/build는 exit 0이다. Root script 58, Shared 203, Automation 28, Mobile 1, Web 64 files·712, API 120 suites·1,138 통과/289 환경 의존 제외, Gateway 64 files·608로 합계 2,748 통과/289 제외다. Main bundle은 319.19 kB/gzip 99.21 kB다. 전체 Chromium 194개는 189 통과/5 opt-in 제외이며, 통과는 188개 mock/브라우저 회귀와 실제 disposable automation journey 1개로 구분한다.

Production 계약 18/18과 전체 `ci:production-audit`가 exit 0이다. MQTT 설정 2/2, Gateway container 24/24, required MQTT persistence/ACL 2/2, bundle·smoke·dependency policy까지 실행했다. Dependency 820개 중 기존 승인 예외 High 2/Moderate 1, unexpected 0이며 무취약 판정이 아니다.

새 smoke project는 `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`다. API image ID는 `sha256:b3f08cd500def9667cfcdbaafde721565e713ec0bbfbe4283b670cc25cf78ecc`, Web은 `sha256:8ad3bcfa79db2d9daa78cc0316550843a23d70ed6475c8c0a515ce0186de9fed`다. 이는 삭제된 로컬 smoke image 식별자이지 운영 registry digest가 아니다. 초기 public table 0→migration 57/57, migration/API 동일 image·기동 순서, live/ready·TLS·proxy·request ID/cache/header, 장비 mTLS, CRL publish/reload, upstream identity 실패·복구, Redis 실패·복구를 검증했다. 종료 후 `containers=0 volumes=0 networks=0 owned-images=0`과 private PKI/env 임시 디렉터리 부재를 독립 재확인했다.

최종 증거는 [상태판](../project-status.md), 네 메뉴 문서와 Task 4 보고서에 같은 수치로 기록한다. Task 4/whole-branch 독립 검토는 요청 단계다. 실제 Vault 발급/갱신·CRL 폐기 전파, 공개 DNS/TLS/mTLS, MQTT/Object Storage 외부 진입, 사용자 DB backup/migration/restore, 전체 앱 수동 시각 QA/native WebView·실장비 HIL과 외부 관측 연결은 별도 운영 승인·검증이 남는다.
