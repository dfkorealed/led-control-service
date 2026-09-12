# Task 1 — Gateway immutable release bundle 보고서

기준일: 2026-09-12

## 상태와 범위

- Task 1 구현·focused 검증·자체 리뷰 완료. 후속 activation/rollback, encrypted backup/restore, CI/runbook 통합은 수정하지 않았다.
- Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`
- Branch: `codex/p0p1-platform-gateway-release`
- Base: `90ab6019552e03e3ee3801e39f58f0eb8ad1d85d`
- 기능 커밋: `574689f7da8d929f90a42e9fbe97fad14f556163` — `feat(gateway): produce verifiable release bundles`
- 별도 subagent를 실행하지 않았고 다른 worktree/main을 변경하지 않았다.

## 구현 결과

`apps/gateway/release-policy.json`에 schema `led-control-gateway-release/v1`, 기본 `linux/arm64`, BlueZ `5.82`/source SHA-256, product identity `1`, dimming wire `2`, automation snapshot `1`, vehicle sensor protocol `1`, ESP-IDF `v5.5.1`, runtime Company ID와 signed firmware 일치 정책을 고정했다.

생성기는 clean Git checkout에서 full lowercase 40자리 commit, commit UTC timestamp, Gateway package version과 lock hash를 읽는다. 실제 image archive config SHA-256와 Docker inspect를 비교하고, config의 layer SHA-256 및 image 내부 inventory와 공급 inventory를 비교한다. OCI version/revision/created/source, lock/policy/BlueZ/firmware/test-mode label을 manifest와 다시 대조한다. 현재 tar reader는 압축하지 않은 `docker save` archive/layer 및 POSIX/GNU long-name metadata를 대상으로 한다.

Bundle은 정확히 다음 일반 파일 7개를 생성하며 기존 output directory를 덮어쓰지 않는다.

```text
appliance.env
checksums.sha256
compose.yml
docker/seccomp-bluez-mesh.json
gateway-image-linux-arm64.tar
release-manifest.json
sbom.spdx.json
```

CI `linux/amd64` override는 archive 이름도 `gateway-image-linux-amd64.tar`가 된다. `--test-mode` 없이는 production platform을 바꿀 수 없고, test-mode bundle은 기본 verify가 거부한다.

`checksums.sha256`은 자신을 제외한 모든 일반 파일을 정렬된 상대 경로로 정확히 한 번 포함한다. CLI verify는 extra/missing/tampered file, symlink/hardlink/FIFO/예상 밖 directory, unsafe/duplicate checksum path, `.env.appliance`/private key filename/PEM 내용, duplicate JSON key, unknown manifest fields, schema/policy/source/platform/SBOM/env 불일치를 거부한다. PEM scan은 chunk 경계를 보존하며 key 내용을 로그에 출력하지 않는다. 공개 CA certificate `.pem`과 image 내부 정상 OS symlink는 private-key/bundle symlink와 구분한다.

SPDX 2.3 문서는 Gateway·BlueZ·Node runtime, 실제 dpkg 설치 OS packages 및 애플리케이션/전역 Node packages inventory를 포함한다. `DESCRIBES`/`CONTAINS` 관계와 source commit, BlueZ source checksum을 기록하며 verify가 image 내부 inventory로 SBOM을 재생성해 정확히 비교한다. SPDX의 JSON 필드 확인에는 [공식 SPDX 2.3 JSON schema](https://raw.githubusercontent.com/spdx/spdx-spec/v2.3/schemas/spdx-schema.json)를 참고했다. License scan을 수행했다고 주장하지 않으며 확인하지 않은 값은 `NOASSERTION`이다.

Build shell은 모든 dirty-build 예외를 제거하고 immutable directory를 출력한다. 실제 Docker build/save/inspect와 hardware entrypoint를 우회한 `--network none --read-only --entrypoint cat` inventory 수집을 연결했다. Dockerfile은 최종 runtime에 inventory를 생성하며 frozen install에 필요한 root `patches/`도 복사한다. 이 Docker 실행 경로 자체는 아래 범위와 같이 이번에 실제 이미지로 실행하지 않았다.

## Task 2 전달 계약

Node CLI는 build/CI용이다. Pi host에 Node가 있다고 가정하면 안 된다.

```bash
node scripts/gateway-release-bundle.mjs create \
  --source CHECKOUT --image-archive IMAGE_TAR --image-inspect INSPECT_JSON \
  --inventory INVENTORY_JSON --output NEW_BUNDLE_DIR

node scripts/gateway-release-bundle.mjs verify \
  --bundle BUNDLE_DIR --policy TRUSTED_RELEASE_POLICY_JSON --expected-commit FULL_SHA
```

- `create` optional: `--test-mode`, `--platform linux/amd64` (기본 `linux/arm64`).
- `verify` optional: `--allow-test-mode`; production activation에서 이 옵션을 켜면 안 된다.
- Image-build 전용 inventory mode: `inventory --root /opt/led-control --output /usr/local/share/gateway-release-inventory.json`.
- Release ID: `VERSION-FULL_COMMIT-CONFIG_DIGEST_FIRST_16[-test]`.
- Build environment: `GATEWAY_RELEASE_TEST_MODE=0|1`, `GATEWAY_RELEASE_PLATFORM=linux/arm64|linux/amd64`, 기존 `GATEWAY_IMAGE_REPOSITORY`, `GATEWAY_IMAGE_TAG`, `GATEWAY_APPLIANCE_OUTPUT_DIR`.
- Root package commands: `pnpm gateway:release:test`, `pnpm gateway:release:verify --bundle ...`.

Checksum-protected `appliance.env`는 다음 **13개 키만** 정렬해 저장하며 값은 ASCII `[A-Za-z0-9_./:+-]+`뿐이고 각 행은 newline으로 끝난다. Task 2 shell consumer도 exact key allowlist/개별 값 형태/중복/누락을 검증하고 임의 site env나 JSON을 `source`/`eval`하면 안 된다.

```text
GATEWAY_GIT_COMMIT
GATEWAY_GIT_COMMIT_TIMESTAMP
GATEWAY_IMAGE_ARCHIVE
GATEWAY_IMAGE_CONFIG_DIGEST
GATEWAY_IMAGE_REPOSITORY
GATEWAY_IMAGE_TAG
GATEWAY_LOCK_SHA256
GATEWAY_RELEASE_ID
GATEWAY_RELEASE_PLATFORM
GATEWAY_RELEASE_POLICY_SHA256
GATEWAY_RELEASE_SCHEMA
GATEWAY_RELEASE_TEST_MODE
GATEWAY_VERSION
```

## TDD — 실제 RED/GREEN 증거

실행 환경: macOS, Node `v24.19.0`, 저장소 pnpm `9.15.0`. 모든 fixture는 OS 임시 directory의 실제 Git checkout과 ustar bytes를 사용한다. Docker daemon 없는 환경에서도 아래 behavior test 전체가 실행 가능하다. Shell 경로만 Docker CLI 경계 shim을 사용하고 생성·검증 CLI 자체는 실제 실행한다.

1. 최초 RED:

   `node --test scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-scripts.test.mjs`

   Exit `1`, **42 tests: 3 passed / 39 failed / 0 skipped**. 새 CLI `MODULE_NOT_FOUND`, policy `ENOENT`, 기존 build의 short commit 계약이 예상 원인이다. 구현 후 같은 명령은 최초 **42/42** GREEN이었다.

2. 자체 리뷰 RED (공개 인증서/JSON 비노출 경계):

   `node --test --test-name-pattern='OS public CA|JSON errors' scripts/gateway-release-bundle.test.mjs`

   Exit `1`, **2 tests: 0 passed / 2 failed**. 공개 CA `.pem`을 개인키로 오탐했고 JSON parse error가 입력 일부를 포함했다. Duplicate Docker JSON key 회귀와 generic JSON error를 함께 고정한 뒤 같은 명령 **2/2 GREEN**.

3. 자체 리뷰 RED (전역 Node package/실제 Bash 기본 경로):

   `node --test --test-name-pattern='SPDX includes global|actual build shell' scripts/gateway-release-bundle.test.mjs`

   Exit `1`, **4 tests: 1 passed / 3 failed** (parent test 포함). Global Node location이 거부됐고 macOS Bash 3.2 `nounset` + empty argv array 때문에 production-default build가 bundle 없이 종료했다. 항상 nonempty platform argv를 유지하고 global npm/corepack inventory를 포함한 뒤 같은 명령 **4/4 GREEN**.

4. 최종 focused GREEN:

   `node --test scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-scripts.test.mjs`

   Exit `0`, **50 tests: 50 passed / 0 failed / 0 skipped**. 정상 closure, deterministic build/overwrite refusal, explicit test mode, source/OCI/config/layer/inventory 결속, secret/path/type/tamper 방어와 실제 default/CI Bash 경로를 포함한다.

5. Gateway contract GREEN:

   `pnpm --filter @led-control/gateway test:contracts`

   Exit `0`, **24 tests: 24 passed / 0 failed / 0 skipped**.

6. Static GREEN:

   `bash -n scripts/gateway-appliance-build.sh && node --check scripts/gateway-release-bundle.mjs && git diff --check`

   Exit `0`.

7. `pnpm workspace:prepare` — Exit `0` (shared → automation-engine 순서).

8. Gateway 기본 검증 GREEN:

   `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway build`

   Exit `0`. Typecheck 통과, Vitest **64 files / 608 tests passed / 0 skipped**, production bundle build `564.6 kB` 통과. 검증 대상 기능 커밋은 `574689f7da8d929f90a42e9fbe97fad14f556163`이며 이후 변경은 이 보고서뿐이다.

## 변경 파일

- `apps/gateway/release-policy.json` — 새 정적 release/firmware 정책.
- `scripts/gateway-release-bundle.mjs` — 생성/검증/runtime inventory, bounded in-place tar inspection, SPDX/closure/allowlist.
- `scripts/gateway-release-bundle.test.mjs` — 실제 CLI/Git/tar/Bash behavior regressions.
- `scripts/gateway-appliance-build.sh` — clean full-commit provenance bundle producer, test-only platform override.
- `scripts/gateway-appliance-scripts.test.mjs` — 새 build 계약; 기존 deploy 경로 테스트 유지.
- `apps/gateway/docker/Dockerfile` — installed inventory 생성 및 build-context patch 입력.
- `package.json` — release test/verify commands.
- 이 보고서.

## 자체 리뷰와 우려사항

- 생성/검증 경로의 checksum set, source/OCI/config/layer/inventory/SBOM 연결, exact env allowlist, no-overwrite/오류 cleanup과 default/CI 분기를 재검토했다. 발견한 공개 PEM 오탐, JSON excerpt/duplicate key, global Node 누락, Bash 3.2 empty-array 문제는 실패 테스트 후 수정했다.
- Checksum/provenance는 서명이 아니다. Trusted policy/expected commit과 승인된 배포 경로는 여전히 필요하며 attacker가 bundle 전체를 재작성한 경우의 cryptographic authenticity를 제공한다고 주장하지 않는다.
- Image tar는 압축하지 않은 `docker save` 형식이어야 한다. 실제 Docker exporter/PAX/layer와 runtime inventory collector 조합은 Task 4 실제 image smoke에서 검증해야 한다. Docker daemon version 조회만 `29.7.2`로 확인했으며 이번 Task 1에서 실제 image build/load/run/activation을 수행하지 않았다.
- Base image tag/apt repository는 snapshot digest로 고정하지 않았다. 서로 다른 build의 실제 config digest/inventory를 식별하는 계약이지, 동일 commit의 bit-for-bit image 재현을 보장하는 계약은 아니다.
- Shell release manager가 아직 없으므로 Node verifier 통과가 Pi activation 안전성 증거는 아니다. 현재 deploy script는 Task 2 대상인 기존 archive 인터페이스를 유지한다. 새 bundle을 그 구형 deploy script에 전달하면 안 된다.
- Task 2/3/4와 전체 진행 상태·plan checkbox·운영 문서 통합은 총괄이 이 결과로 갱신한다. 메뉴/API/DB/firmware runtime 계약은 변경하지 않았다.
- 실제 Raspberry Pi/ARM64 실행, BlueZ/HCI/RF, 운영 signing/backup key, 실제 identity, 배포/rollback/restore, 사용자 DB/migration, HIL은 **미실행**이다. Synthetic private-key marker는 암호키가 아닌 테스트 문자열이다.
