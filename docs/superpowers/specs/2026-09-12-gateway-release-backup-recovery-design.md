# Gateway Release, Rollback, Backup and Recovery Design

기준일: 2026-09-12

## 목적

Raspberry Pi Gateway 배포물을 어떤 소스와 의존성으로 만들었는지 기계적으로 검증하고, 현장 활성화 실패 시 직전 검증 버전으로 자동 복구하며, Gateway 영속 상태와 장비 identity를 암호화 백업에서 안전하게 복원할 수 있게 한다.

이 설계는 소프트웨어 도구와 disposable 검증까지만 다룬다. 운영 signing key, 운영 backup private key, 실제 Raspberry Pi 배포, 실제 identity, 사용자 데이터, ESP32-H2 flash와 HIL은 사용하지 않는다.

## 선택한 접근

이미지 태그만 교체하는 방식은 dependency/SBOM과 rollback 입력이 분리되고, Pi 전체 OS snapshot은 애플리케이션 릴리스보다 범위가 크다. 따라서 다음 세 경계를 하나의 릴리스 계약으로 묶는다.

1. immutable release directory가 image archive, manifest, SPDX SBOM, compose/seccomp, release env와 checksum closure를 함께 보관한다.
2. 현장 release manager가 bundle 전체를 staging에서 검증하고 image load, preflight, health 확인 뒤에만 `current`/`previous` pointer를 원자적으로 전환한다.
3. 영속 데이터는 서비스 quiesce 뒤 암호화 archive로 만들고, 복구 시 동일 filesystem staging에서 내용·권한·세대를 검증한 뒤 교체하며 실패하면 기존 디렉터리를 되돌린다.

## 1. Release bundle 계약

`apps/gateway/release-policy.json`은 저장소의 정적 호환성 정책이다.

- bundle schema: `led-control-gateway-release/v1`
- target platform: 기본 `linux/arm64`
- Gateway package version: `apps/gateway/package.json#version`
- full lowercase 40자리 Git commit과 commit timestamp
- `pnpm-lock.yaml` SHA-256
- image repository/tag/config digest
- BlueZ `5.82`와 source SHA-256
- firmware compatibility: product identity format `1`, dimming command wire `2`, automation snapshot schema `1`, vehicle sensor protocol `1`, ESP-IDF `v5.5.1`, runtime Bluetooth Company ID와 signed firmware의 일치 요구

`scripts/gateway-release-bundle.mjs`는 build script가 만든 image archive와 image inventory를 입력으로 다음 파일을 생성하고 `verify` 모드에서 동일 계약을 다시 검증한다.

- `gateway-image-linux-arm64.tar`
- `release-manifest.json`
- `sbom.spdx.json` (SPDX 2.3 JSON, OS/Node package inventory 포함)
- `appliance.env`
- `compose.yml`
- `docker/seccomp-bluez-mesh.json`
- `checksums.sha256`

Checksum 목록은 자기 자신을 제외한 모든 일반 파일을 상대 경로로 포함한다. Bundle에는 symlink, socket/device/FIFO, site env나 private key artifact가 없어야 한다. Exact `led-control-private-material/v3` profile은 각 regular file(삭제된 image layer 포함)의 whole-file DER PKCS#1/PKCS#8/SEC1 및 complete UTF-8 PEM을 crypto parse로 검사한다. Complete `ENCRYPTED PRIVATE KEY` PEM은 passphrase 없이 구조적으로 거부하고, whole-file PKCS#8 EncryptedPrivateKeyInfo DER도 canonical definite-length SEQUENCE(AlgorithmIdentifier OID/optional parameters + nonempty OCTET STRING) 구조를 bounded 검증해 거부한다. DER 65,536 bytes·중첩 12/128 parser visits, PEM/base64 131,072 characters를 넘는 후보는 보장 밖이다. 앞뒤 ASCII whitespace와 파일 전체를 감싼 표준 base64 한 겹을 지원한다. Binary 임의 offset·header-only 설명·일반 암호문/token/secret·nested encoding은 보장하지 않고 public SPKI/CA는 허용한다. 구조적 encrypted container 거부는 암호문을 복호화해 진위를 판정하는 보장이 아니다. 이전 v1/v2 profile을 v3로 재인증하지 않는다. `verify`는 누락·추가·변조 파일, schema/policy/source commit/platform 불일치와 unsafe path를 fail-closed한다.

Docker archive는 raw tar 및 단일 gzip layer만 허용하고 blob digest와 decoded diff ID를 분리한다. Outer/누적 decoded bytes 각 2 GiB, layer compressed/decoded 각 512 MiB·최대 128 layers를 유지한다. 모든 nonzero tar header(중복/zero-byte/metadata 포함)는 record push 전에 outer 4,096·layer별 100,000·전체 layer 누적 250,000개로 제한한다. OCI attestation은 selected runtime leaf manifest digest에만 결속하며 in-toto layer 최소 1개를 요구한다. Intermediate index나 다른 identity는 attestation 대상이 아니다.

`scripts/gateway-appliance-build.sh`는 clean tree만 허용하는 기존 계약을 유지하고 full SHA를 OCI label과 manifest에 결속한다. 기본 산출물은 ARM64다. CI disposable smoke에서만 명시적 test mode로 host platform을 사용할 수 있고, test-mode bundle은 production activation이 거부한다.

## 2. 활성화와 rollback 계약

`scripts/gateway-appliance-release.sh`는 `verify`, `activate`, `rollback`을 제공한다. 배포 root 기본값은 `/opt/led-control/gateway`이며 테스트에서는 임시 root를 명시한다.

모든 mutation은 `flock`으로 직렬화한다. `activate`는 다음 순서를 지킨다.

1. bundle checksum, manifest/policy, source commit, platform, secret 부재 검증
2. 충분한 disk 공간, Docker/Compose, 기존 `.env.appliance`, identity regular file·권한·generation symlink containment, Gateway data/mesh 경로 확인
3. bundle을 `releases/<releaseId>.staging`에 복사·fsync하고 final release directory로 rename
4. image archive load와 manifest의 config digest 확인
5. 기존 release 좌표와 pointer를 rollback journal에 기록
6. `.env.appliance`의 image repository/tag를 temp+fsync+rename으로 갱신
7. Compose 적용 및 bounded health 확인
8. 성공한 경우에만 `previous`, 이어서 `current` symlink를 temp symlink+rename으로 전환하고 journal 제거

실패하면 이전 env/pointer를 복원하고 이전 image로 Compose를 다시 적용해 health를 확인한다. 이전 release가 없는 최초 설치 실패는 새 컨테이너를 내리고 `current`를 만들지 않는다. Process interruption 뒤 남은 journal은 다음 invocation의 preflight에서 자동 복구하거나, 안전한 판정이 불가능하면 mutation 전에 중단한다. `rollback`은 `previous`가 가리키는 이미 검증된 release에 같은 activation 경로를 적용하며 임의 tag를 받지 않는다.

`scripts/gateway-appliance-deploy.sh`는 bundle directory 하나만 업로드하고 remote release manager를 호출한다. identity/private key나 site `.env.appliance`를 bundle 또는 전송 목록에 넣지 않는다.

## 3. 백업·복구 계약

`scripts/gateway-appliance-state.sh`는 `backup`, `verify`, `restore`, `drill`을 제공한다.

백업 대상은 compose의 실제 `GATEWAY_DATA_DIR` 아래 `gateway`, `mesh`, `identity`, `factory-trust`다. Command/provisioning journal, state-event outbox와 manifest, automation snapshot/state/ACK/telemetry 및 sidecar, mesh identity/address/transaction/group 상태, BlueZ mesh DB, device/MQTT certificate generation과 `current` symlink를 함께 보존한다.

Identity private key가 있으므로 plaintext tar를 최종 산출물로 남기지 않는다. 백업은 `umask 077` 임시 staging에서 payload manifest를 만든 뒤 OpenSSL CMS 수신자 인증서로 암호화하고, plaintext staging을 trap에서 제거한다. CLI·로그·outer manifest에는 private key 내용이나 passphrase를 출력하지 않는다. Outer manifest는 schema, backup ID, 생성 시각, source release ID, 암호 방식, ciphertext SHA-256/size만 가진다. 파일별 path/type/mode/uid/gid/size/SHA-256과 symlink target은 암호문 내부 payload manifest에 둔다.

복구는 backup recipient certificate/private key로 임시 staging에 복호화한다. Archive entry는 상대 경로만 허용하고 traversal, hard link, absolute/external symlink, device/socket/FIFO를 거부한다. 내부 manifest checksum과 mode, identity `current` symlink의 generation 내부 귀속, private key `0600`, identity/generation directory `0750`, gateway/mesh state의 regular-file 조건을 검증한다.

Live restore는 Gateway를 중지한 뒤 같은 filesystem에서 기존 네 디렉터리를 rollback 이름으로 이동하고 검증된 staging을 rename한다. 어느 단계든 실패하거나 새 Gateway health가 실패하면 새 데이터를 격리하고 기존 네 디렉터리를 모두 복원한다. 성공 후에만 rollback copy를 제거한다. `drill`은 임시 경로에만 복호화·검증·재추출하고 live data 또는 Docker를 변경하지 않으며 CI가 실제 ephemeral recipient key/certificate로 실행한다.

## 4. CI와 검증

`.github/workflows/ci.yml`의 protected production-audit chain을 유지한다. `scripts/ci-production-audit.sh`는 기존 Compose/MQTT/Gateway/Web/dependency gate와 함께 다음을 실행한다.

- release policy/manifest/SBOM/checksum unit·contract 테스트
- host-platform test-mode image build와 bundle verify
- image label/config digest와 manifest 일치 및 secret scan
- fake Compose/Docker 경계의 activation 성공, unhealthy rollback, interrupted journal recovery
- ephemeral OpenSSL recipient를 사용한 backup→verify→disposable restore drill
- malformed/tampered/traversal/symlink/permission/partial-swap 실패 회귀

Canonical `pnpm gateway:release:ci`는 전체 state suite를 serial로 한 번 실행하며 85 tests/85 pass 및 fail/cancel/skip/todo 0을 요구한다. 실제 ephemeral CMS happy flow가 그 결과 안에 정확히 1개 있어야 한다. Gate execution 45분, child 30분, launcher 이후 drain 3초→TERM 2초→KILL 2초, cleanup 2분(+5초 hard backstop), protected workflow 60분 timeout으로 무한 대기를 막는다. Still-live group은 cleanup failure/exit 3이며 staging을 보존한다. pnpm build-only self-reference 제거도 exact symlink type/target 검사 후에만 허용한다.

자동 검증은 Raspberry Pi의 실제 ARM64 실행, BlueZ/HCI, 운영 인증서, 현장 filesystem power-loss와 RF/HIL 증거가 아니다. 기본 ARM64 production bundle과 실제 restore는 승인된 운영 절차에서 별도 수행한다.

## 5. 문서와 운영 순서

`docs/runbooks/raspberry-pi-gateway-appliance.md`, `apps/gateway/README.md`, `docs/agent-operations.md`, `docs/project-status.md`, `docs/lesson_leared.md`를 갱신한다. 릴리스는 bundle 생성→CI 검증→운영 승인→현장 encrypted backup→preflight→activate→health 확인 순서이며, rollback/restore는 임의 파일 삭제나 re-provision으로 대체하지 않는다.
