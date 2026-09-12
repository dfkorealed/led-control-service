# Task 1 독립 리뷰 수정 보고서

기준일: 2026-09-12

## 상태·커밋·범위

- Important 2건 / Minor 1건을 Task 1 안에서 수정하고 TDD·자체 리뷰·요청 검증을 완료했다. 독립 재검토 판정은 총괄에게 넘긴다.
- Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`
- Branch: `codex/p0p1-platform-gateway-release`
- 수정 전 HEAD: `edd4d027902d98cee00e0754dc58dfebec498161`
- 기능 수정 커밋: `77b37f798e80aff213ac884724ea81c11efd03d8` — `fix(gateway): verify visible inventory and encoded keys`
- Reviewer findings는 production/test 수정 **전** `task-1-review.md`에 전달 원문 그대로 기록했다.
- Task 2/3/4 파일, Docker smoke, 다른 worktree/main, 운영 키·identity·실장비·배포·HIL을 변경하거나 실행하지 않았다. 별도 subagent도 실행하지 않았다.

## Findings 처리

### Important 1 — full whiteout semantics와 최종 visible inventory

이전 코드는 네 marker만 hard-code하고 tar 순서대로 inventory를 즉시 파싱했다. Root/상위 opaque marker는 옛 inventory를 유지했고, 일부 same-layer marker는 새 inventory까지 지웠다.

수정은 각 layer에 대해 whiteout을 lower-layer 상태에 먼저 적용한 다음 같은 layer의 새 파일을 반영한다. `.wh.<name>`의 삭제 경로와 `.wh..wh..opq`의 부모 directory를 계산해 root와 모든 inventory ancestor를 처리한다. Marker는 빈 일반 파일이어야 한다. 최종 visible entry의 offset만 보관하고 모든 layer 처리 후 regular-file JSON을 읽는다. 상위 경로가 일반 파일/symlink로 바뀌면 기존 inventory를 제거하며 directory만 다시 만든다고 부활하지 않는다.

8종 marker 각각에 lower/upper layer 및 same-layer 전/후 순서를 검증했다. Stale bundle은 image config·layer digest, release ID, env, SPDX/checksum까지 adversarial fixture에 맞춰 재결속한 후 **실제 CLI verify**가 inventory 원인으로 거부하도록 했다. 따라서 단순 checksum 불일치에 기대는 음성 테스트가 아니다. 가려진 malformed JSON 대신 최종 새 inventory만 읽는 경우도 검증했다.

적용한 의미는 [OCI image-spec v1.1.1 whiteouts](https://github.com/opencontainers/image-spec/blob/v1.1.1/layer.md#whiteouts)의 lower-layer-only 규칙이다. 다른 압축 image format까지 지원한다고 확장하지 않는다.

### Important 2 — enforceable DER / base64 검사와 명시적 한계

기존 filename/literal PEM 검사에 더해 다음 내용을 검사한다.

- ASN.1 definite-length DER SEQUENCE 후보에 대해 Node `createPrivateKey`가 인식하는 PKCS#1/PKCS#8/SEC1 private key.
- PKCS#8 crypto parsing이 명시적 `ERR_MISSING_PASSPHRASE`로 판정하는 encrypted key container. 실제 복호화나 암호 추측은 하지 않는다.
- Literal private-key PEM 또는 위 DER를 표준 base64 **한 겹**으로 감싼 내용. JSON/text 안의 키, whitespace/짧은 마지막 줄, stream chunk 경계도 처리한다.
- DER bytes와 whitespace 제거 후 base64 text는 각각 별도 bounded carry로 이어 붙인다. 삭제된 layer를 포함한 archive/layer bytes도 검사한다.

검사는 실제 crypto parsing 결과에 결속하며 [Node crypto API](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptocreateprivatekeykey)의 지원 형식을 사용한다. 테스트는 매 실행 새 EC/RSA ephemeral key를 만들고 PKCS#1/8/SEC1, encrypted PKCS#8, base64 PEM/DER, 공개 SPKI 대조군을 사용했다. Key bytes/base64 원문/passphrase를 로그나 보고서에 기록하지 않았고, 기존 운영 키를 읽지 않았다.

Manifest에 `privateMaterialScan` profile을 추가하고 verifier가 고정 값과 정확히 비교한다. `apps/gateway/RELEASE-BUNDLE.md`에 같은 범위를 적었다. Profile은 DER 최대 **65,536 bytes**, whitespace 제거 후 base64 candidate/carry 최대 **131,072 characters**, 인식 가능한 과대 후보의 fail-closed를 명시한다.

이는 **일반 secret 부재 보증이 아니다**. Password/token/raw symmetric key, 임의 obfuscation, 다른/재귀 encoding, 암호문 복호화, nested compressed payload, Node가 인식하지 못하는 key/container는 보장하지 않는다. Base image provenance/checksum도 서명은 아니므로 trusted policy와 expected commit/승인된 전달 경로는 계속 필요하다.

### Minor 1 — strict shell `0|1`

`appliance.env`의 `GATEWAY_RELEASE_TEST_MODE`는 production `0`, test-only `1`로만 직렬화한다. 실제 verify는 `true`, `false`, 빈 값, `00`, `01`, `2`, manifest와 반대인 값을 checksum 재생성 뒤에도 거부한다. JSON `testMode` boolean과 OCI boolean-text label은 별도 계약으로 유지한다.

## TDD RED/GREEN 기록

실행 환경은 macOS / Node `v24.19.0` / repository pnpm `9.15.0`이다. 아래 숫자는 Node parent/subtest를 포함한 실제 runner 집계다.

### RED 1 — 원 findings

```bash
node --test --test-name-pattern='OCI whiteouts|OCI inventory|private-material content|numeric test-mode' scripts/gateway-release-bundle.test.mjs
```

Exit `1`: **52 tests / 24 passed / 28 failed / 0 skipped**.

원인: `.wh.usr`/root·ancestor opaque가 stale inventory를 허용, 기존 marker가 같은 layer의 새 inventory를 지움, 숨은 malformed inventory를 먼저 파싱, DER/base64 key를 허용, `false` shell wire를 출력했다.

### RED 2 — encrypted DER와 profile 선언

```bash
node --test --test-name-pattern='private-material content|bounded private-material' scripts/gateway-release-bundle.test.mjs
```

Exit `1`: **22 tests / 0 passed / 22 failed / 0 skipped**. Encrypted PKCS#8/base64와 private-material profile 미구현을 확인했다. 1차 수정 후 원 whiteout·key·numeric·profile 합동 suite는 **57/57 GREEN**이었다.

### RED 3 — base64 whitespace 경계

```bash
node --test --test-name-pattern='private-material content' scripts/gateway-release-bundle.test.mjs
```

Exit `1`: **25 tests / 20 passed / 5 failed / 0 skipped**. 초기 base64 matcher가 짧은 마지막 줄 및 글자 사이 whitespace를 놓쳤다. 공백 제거를 위한 별도 carry와 인식 가능한 encoded start를 적용한 뒤 `private-material content|bounded private-material`은 **26/26 GREEN**이었다.

### RED 4 — ancestor 교체 뒤 stale 부활

```bash
node --test --test-name-pattern='OCI ancestor replacement' scripts/gateway-release-bundle.test.mjs
```

Exit `1`: **4 tests / 0 passed / 4 failed / 0 skipped**. Inventory 상위 경로를 non-directory로 교체하고 다시 directory로 만드는 layer sequence가 stale inventory를 유지했다. Ancestor 차단 상태와 새 inventory 요구를 추가한 뒤 같은 명령 **4/4 GREEN**.

### 최종 GREEN

```bash
node --test scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-scripts.test.mjs
```

Exit `0`: **115 tests / 115 passed / 0 failed / 0 skipped** (32.31초). 최초 Task 1의 모든 기존 behavior와 이번 whiteout/ancestor/crypto/base64/profile/numeric 회귀를 함께 통과했다.

```bash
pnpm --filter @led-control/gateway test:contracts && bash -n scripts/gateway-appliance-build.sh && node --check scripts/gateway-release-bundle.mjs && git diff --check
```

Exit `0`: Gateway **24 tests / 24 passed / 0 failed / 0 skipped**, Bash syntax, Node syntax, diff check 통과. 문서 작성 뒤 `git diff --check`와 커밋 전 `git diff --cached --check`도 통과했다. pnpm launcher의 기존 설정 위치 경고는 그대로이며 runtime 검증 실패는 없다.

## 변경 파일

- `scripts/gateway-release-bundle.mjs` — whiteout two-phase visibility, ancestor 교체, bounded crypto/base64 scanner, manifest profile, `0|1` serialization.
- `scripts/gateway-release-bundle.test.mjs` — multi-layer/tar type fixture, fully rebound adversarial verify, ephemeral key/stream 경계/profile/env 회귀.
- `apps/gateway/RELEASE-BUNDLE.md` — Task 1 계약·보장 범위·비보장 범위와 shell metadata 문서.
- `task-1-review.md` — 수정 전 reviewer findings 원문.
- `task-1-report.md` — 후속 profile/`0|1` 계약과 역사적 검증 범위 안내.
- 이 `task-1-fix-report.md` — 수정 증거와 한계.

## 자체 리뷰·전달·남은 한계

- Reviewer의 Important 1/2와 Minor 1을 실제 CLI 실패 테스트로 재현했고, 모든 관련 검증이 GREEN인 상태에서 기능을 커밋했다. 최종 diff에서 단계별 whiteout, split carry, crypto 예외 비노출, profile exact 비교와 env wire를 확인했다.
- Task 2 consumer는 `GATEWAY_RELEASE_TEST_MODE=0|1`만 허용해야 한다. Manifest에는 새 필수 `privateMaterialScan`이 있으므로 pre-review bundle을 그대로 재사용하지 말고 현 코드로 새 bundle을 생성한다. 다른 env allowlist 키 12개는 유지했다.
- 실제 Docker image smoke, Node 22 container 안 inventory 생성/crypto 대조, 대용량 실제 image 성능은 Task 4에서 수행해야 한다. 이번 검증의 local Node는 24다. 지원은 압축하지 않은 `docker save` 형식이며 광범위한 secret scanner 또는 OCI 전체 runtime 구현으로 확대해서는 안 된다.
- 이번 wave에서는 Gateway 전체 Vitest/typecheck/build를 재실행하지 않았다. 이전 `574689f`의 608/608·typecheck/build는 역사적 증거로 유지하며 현재 HEAD의 fresh full-package 결과라고 주장하지 않는다.
- Task 2/3/4, DB/migration, 운영 키/identity, 실제 Raspberry Pi/ESP32-H2/BlueZ/HCI, 배포·backup/restore·HIL은 **미실행/미변경**이다.
