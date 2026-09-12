# Task 4 — Protected Gateway release/recovery CI evidence

Date: 2026-09-13 (Asia/Seoul). Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`; branch: `codex/p0p1-platform-gateway-release`.

Status: **Task 4 implemented and software-verified.** Canonical clean-checkout Gateway gate, full production audit, full state regressions and Gateway typecheck/unit/build passed. Final documentation/evidence is a docs-only follow-up to functional-code commit `05c8451`; independent final review and operational/HIL validation remain outside this task's success claim.

## Scope and implementation

- Starting Task 4 commit: `b89a540b964c70f4ffc5b2447dc8c84f0370bd20`.
- Canonical `pnpm gateway:release:ci` rejects dirty source and missing Docker daemon/Buildx/Node 22+/OpenSSL prerequisites, runs real behavior contracts serially, builds a marked `linux/amd64` test-only image through the production builder, verifies trusted checked-in policy/full HEAD, and requires default production rejection.
- The actual smoke loads the checksum-verified archive, captures exact-tag daemon identity/OCI labels, calls the same pure shell identity decision as activation, runs an actual no-network/read-only/cap-drop Node container, and compares its `.Image` to the captured archive-bound ID. It does not execute a live site activation or Compose deployment.
- The exact named existing state test uses real ephemeral RSA/OpenSSL CMS and real backup/verify/drill/restore CLIs against disposable four-root data. Its Docker/Compose/platform compatibility boundaries remain fixture shims. The gate requires exactly one selected test, one pass, zero skips, so a renamed/absent test cannot turn this stage green.
- Each invocation owns unique image/container names and a physical private temp root. A real `mktemp` forwarding observer records state workspaces outside TMPDIR; cleanup validates exact observed physical parent/basename, drains child process groups, and removes only invocation-owned resources. Cleanup failure fails the gate; foreign containers sharing an image digest are preserved. Base images/build cache are not globally pruned.
- The protected production audit invokes the canonical gate exactly once before Web/dependency gates. GitHub production-audit has explicit Buildx setup and one clearly named Gateway release/recovery step with no `if`/`continue-on-error`; the original frozen-install strict dependency chain is unchanged.

## Commits

1. `5d955d7c28af476f954867aaa72a1b00aa5cff55` — canonical protected gate, behavior tests, workflow wiring and operator docs.
2. `27a08bf422f1d40d43ce16882034ed1aec4996a7` — remove only pnpm 9's build-only Gateway self-reference before final runtime inventory.
3. `ba7916d46bad2abbc34a4949f9b4afe46b8fabe6` — Docker 29 gzip/OCI archive and daemon identity compatibility, including activation/state/actual CI boundaries.
4. `78d00a438573801443dd01767be12f182cadb99e` — file-scoped v2 private-key artifact detection and precise guarantee/limitations.
5. `05c8451409571575185462453e08cad6cf3aa278` — distinguish normal public-key tooling names from private-key artifact names; extensionless content regression.

Final documentation/evidence commit is recorded by Git history after this report is finalized. No merge or push is performed.

## TDD: initial CI gate

All commands below ran from this worktree, serially. Unless specifically stated, tests had zero skips.

| Command | RED / GREEN evidence |
| --- | --- |
| `node --test scripts/ci-workflows.test.mjs` | Baseline 7/7. Initial required RED: 8 tests, 7 pass, 1 expected failure because the protected Gateway release/recovery step was absent. |
| `node --test --test-name-pattern='release CI executes' scripts/gateway-release-ci.test.mjs` | Initial CLI RED: 0/1, missing `gateway-release-ci.mjs`/ENOENT. |
| `node --test --test-name-pattern='foreign container\|owned descendant' scripts/gateway-release-ci.test.mjs` | Cleanup self-review RED 0/2 (foreign sentinel removed; descendant marker absent), 5.495 s. Exact owned names and descendant drain fix: GREEN 2/2, 7.413 s. |
| `node --test scripts/ci-workflows.test.mjs` | Fresh pre-Docker GREEN 26/26, 24.202 s. Includes existing 8 workflow contracts plus 18 real CLI-orchestration behavior tests at that revision. |

Harness-only corrections were not production successes: an initial 21-test run was 19/2 due to inherited `NODE_TEST_CONTEXT` suppressing nested test execution; removing that inherited variable made 21/21. A later 24-test run was 22/2 because the fixture expected `/tmp` while cleanup correctly resolved `/private/tmp`; using physical paths and fixture teardown made 24/24. Three inspected disposable fixture directories (`/private/tmp/.gateway-state.S2GJEH`, `.6Rorj0`, `.YXV7ek`) contained only a `fixture` file with disposable marker data and were removed. No user/operational data was involved.

## Actual Docker failures and resulting TDD fixes

### 1. Final-image inventory exposed a pnpm self-reference

`pnpm gateway:release:ci` at `5d955d7` passed artifact/activation contracts **183/183** (258523.033292 ms), then the actual Docker build failed while generating final-image inventory:

`ENOENT: realpath '/opt/led-control/node_modules/.pnpm/node_modules/@led-control/gateway'`.

An actual disposable app-builder image confirmed the symlink target was `../../../../../../workspace/apps/gateway`: valid in the build workspace but dangling after only runtime `node_modules` was copied. The fix unlinks exactly that known build-only self-reference; it does not prune arbitrary broken dependencies or bypass inventory validation. Diagnostic image cleanup completed.

- RED: `node --test --test-name-pattern='runtime packaging' apps/gateway/docker/container-contract.test.mjs` — 0/1, 47.042 ms, expected unlink absent.
- GREEN: `pnpm --filter @led-control/gateway test:contracts` — 25/25 (previously 24); subsequent fresh run 25/25, 335.419209 ms.
- Canonical failure exited 1 and confirmed owned cleanup. No bundle/Node/CMS success was claimed for this run.

### 2. First full production audit stopped at Docker 29 compressed layer identity

The **first** `pnpm ci:production-audit`, at `27a08bf`, passed Compose resolution, workspace preparation, MQTT production configuration **2/2** (45.018917 ms), Gateway contracts **25/25** (327.251584 ms), actual required MQTT persistence/restart/ACL **2/2** (5757.3475 ms), and nested Gateway artifact/activation **183/183** (258484.736666 ms). The real final-image inventory now succeeded, but bundle creation stopped at `image layer digest mismatch`. Web bundle/container and in-band dependency audit were not reached. Owned Gateway cleanup completed.

Actual saved-image diagnosis (disposable archive/image removed afterwards):

- Docker 29 `.Id`/`.Descriptor` identified an OCI index, not the config JSON digest.
- Layer blob started with gzip magic `1f8b0808` (including filename header flag).
- Compressed first-layer SHA-256: `a8ac7f6c67abc236e4c745052c404112b8fab6fe8ac3a329d1ef3b867ad67c71`.
- Decoded tar SHA-256: `1d69a5fd31932841d7825ef4780c06f008eea65aaa9f3110fe09d5832ed5c7d8`, equal to config `rootfs.diff_ids`, not to the compressed blob digest.

Parent-approved interface: `image.configDigest` remains the actual config bytes SHA. New `image.descriptorDigest` / `GATEWAY_IMAGE_DESCRIPTOR_DIGEST` separately binds the inspected daemon ID to the checked archive graph. New env has exact 14 keys; shell consumers retain explicit exact 13-key legacy rollback with its config-ID requirement. Updated producer/verifier/release/common/state helpers must be coordinated; old components are not generally mixed-version safe.

| Command | RED / GREEN evidence |
| --- | --- |
| `node --test --test-name-pattern='Docker 29 gzip' scripts/gateway-release-bundle.test.mjs` | Initial 15 tests: 1 pass / 14 expected failures (raw digest assumption); GREEN 15/15, 4.1548 s. Includes malformed, corrupt CRC, truncated, trailing/concatenated member, unsupported compression, blob/descriptor tamper, wrong diff ID, platform, 512 MiB expansion bomb, decoded whiteout/private-key tests. |
| `node --test --test-name-pattern='unselected runtime\|index tag mismatch\|bound non-runtime' scripts/gateway-release-bundle.test.mjs` | RED 3 tests, 1 pass / 2 failures (extra runtime image and wrong index tag accepted); all GREEN in fresh focused suite. |
| `node --test --test-name-pattern='Docker 29 activation' scripts/gateway-appliance-release.test.mjs` | RED 4 tests, 2 pass / 2 fail: 14-key metadata rejected. A subsequent run exposed captured-ID reset after final bundle verification; re-resolving immediately after final verification fixed it. |
| `node --test --test-name-pattern='Docker 29 state' scripts/gateway-appliance-state.test.mjs` | RED 0/1, 2.328 s: state still compared daemon ID to config digest. |
| `node --test --test-name-pattern='Docker 29 activation\|Docker 29 state' --test-concurrency=1 scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs` | GREEN 5/5, 42.1075 s: new identity success, mismatched ID/label pre-mutation refusal, mismatched running image recovery to legacy 13-key baseline, state backup/verify/drill/restore. |
| `node --test --test-name-pattern='release CI executes\|release CI fails closed at (load\|identity)' scripts/gateway-release-ci.test.mjs` | RED 0/3, 5.1517 s: actual load/identity boundaries absent; GREEN 3/3, 4.1423 s. |
| `node --test --test-concurrency=1 scripts/gateway-release-bundle.test.mjs scripts/ci-workflows.test.mjs` | First 167/168: only old expected `config digest` error wording differed. Focused old error test GREEN 1/1, 1133.971 ms; fresh full focused GREEN 168/168, 70835.642625 ms. |

Supported layer transport is raw tar or exactly one gzip member. Blob/descriptor digest verifies stored compressed bytes, bounded decoded tar hash verifies diff ID. Header/CRC/ISIZE, exact member end, archive and cumulative decoded size (2 GiB each), per-layer compressed/decoded size (512 MiB each), 128 layers and bounded descriptor graph fail closed. Selected platform/config/layers and checked tag/labels are bound; only explicitly bound Buildx non-runtime in-toto attestation manifests are allowed alongside the selected runtime image. All owned decoded staging is removed on success/failure.

### 3. Real standard runtime disproved generic byte/filename secret heuristics

At `ba7916d`, a clean canonical run passed **207/207** artifact/activation contracts (291698.228917 ms), actual image build and final inventory, then stopped at `private key material is forbidden (DER)`. Cleanup completed. A disposable archive diagnosis scanned each regular file separately and printed only path/size/detection category, never key bytes or PEM/base64 excerpts:

- DER hits: `usr/lib/x86_64-linux-gnu/libgcrypt.so.20.4.1`, `libhogweed.so.6.6`, `usr/local/bin/node`, `usr/bin/openssl`, `usr/lib/x86_64-linux-gnu/libcrypto.so.3`.
- Literal PEM-marker hits: `libgnutls.so.30.34.3`, `libssh2.so.1.0.1`, and npm `docs/content/using-npm/config.md`, `docs/output/using-npm/config.html`, `man/man7/config.7`, `node_modules/@npmcli/config/lib/definitions/definitions.js`.

The failure was not solely a tar boundary artifact: normal binary files and explanatory text also triggered. No assertion was made that these standard binaries contained an operational private key. The parent explicitly selected an enforceable **standalone artifact / complete parseable text PEM** contract instead of arbitrary binary offsets or header strings.

- RED: `node --test --test-name-pattern='private-material v2|manifest states the bounded' scripts/gateway-release-bundle.test.mjs` — 0/2, 389.235542 ms; normal binary/marker text rejected and old v1 manifest claim persisted.
- Intermediate GREEN: `node --test --test-name-pattern='private-material v2|private-material content|ASCII whitespace|manifest states the bounded|PEM content|PEM data|OS public' scripts/gateway-release-bundle.test.mjs` — 47/47, 13623.280917 ms.
- Additional RED: `node --test --test-name-pattern='private-material v2' scripts/gateway-release-bundle.test.mjs` — 0/1, 206.231042 ms, encoded binary incorrectly treated as an entire base64 key artifact; requiring decoded PEM to occupy the whole file fixed it.
- Fresh focused GREEN: `node --test --test-concurrency=1 scripts/gateway-release-bundle.test.mjs scripts/ci-workflows.test.mjs` — 169/169, 71447.673042 ms.
- At `78d00a4`, the next clean actual image scan passed these content cases and stopped at `secret filename is forbidden: usr/bin/apt-key`; owned cleanup completed. The canonical test-count line for this failed run was truncated in captured output, so no exact count is invented for that run.
- Filename RED: `node --test --test-name-pattern='filenames distinguish' scripts/gateway-release-bundle.test.mjs` — 0/1, 199.709125 ms, normal `apt-key` rejected.
- Filename GREEN: latest focused command above — **170/170**, 72329.166792 ms; normal tool/module/public SPKI filenames allowed, actual extensionless `secrets/device-key` DER and PEM rejected by content. Node/Bash syntax and diff check passed before commit.

### Exact v2 private-material guarantee

`led-control-private-material/v2` is explicitly different from v1; the current verifier rejects a v1/missing/altered profile rather than silently recertifying it. This does not remove shell rollback support for previously verified exact 13-key bundles.

- Each regular file is independent, including regular files in lower/deleted layers. Tar headers/padding/cross-file concatenations are not key contents. Image transport is decoded before this file-level inspection.
- Standalone DER PKCS#1/PKCS#8/SEC1 with optional leading/trailing ASCII whitespace is rejected only when Node crypto creates a private KeyObject.
- Whole-file standard base64 wrapping of a standalone DER/PEM key receives the same decision; all ASCII whitespace, FF/VT and stream boundaries are covered.
- Complete matching private PEM blocks in UTF-8 text (including app/docs text) are rejected on actual crypto parse success. Marker-only/dummy text and library binaries are permitted. Public SPKI/CA controls remain.
- Named `.env`/`.env.*`, known `id_*` private basenames, `private-key`/`private_key` basename/directory forms and `.key`/`.p12`/`.pfx`/`.pkcs12`/`.pkcs8` remain forbidden. Generic `*-key` or `.pem` is not automatically private. Existing `.dockerignore` is unchanged.
- Limits: DER 65,536 bytes; PEM block 131,072 characters; normalized whole-file base64 131,072 characters. Candidate buffering is bounded, not entire-image buffering.
- Not guaranteed: passwords/tokens/raw symmetric keys, encrypted keys requiring an unavailable passphrase, binary-embedded DER/PEM, embedded base64 tokens, oversized candidates, unsupported key containers/encodings/obfuscation or recursively compressed payloads. Checksum/content scan is neither an authenticity signature nor an all-secrets proof.

## Initial increasing-scope evidence (before Docker compatibility additions)

These historical results are retained with their revision boundary, not presented as a fresh current-code combined run:

| Command | Result |
| --- | --- |
| `pnpm workspace:prepare` | PASS. |
| `node --test --test-concurrency=1 scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/ci-workflows.test.mjs` | 291/291, 759891.102875 ms, zero skips; before subsequent cleanup/compatibility/profile additions. |
| `pnpm --filter @led-control/gateway test:contracts` | 24/24 initially; Docker self-reference fix adds one, fresh later 25/25. |
| `pnpm --filter @led-control/gateway typecheck` | PASS. |
| `pnpm --filter @led-control/gateway test` | 64 files, 608/608, 35.02 s. |
| `pnpm --filter @led-control/gateway build` | PASS; 564.6 kB bundle. |
| Node/Bash syntax and `git diff --check` | PASS. |

## Final clean-checkout evidence

Functional-code commit: `05c8451409571575185462453e08cad6cf3aa278`. The canonical command started with a clean tracked/untracked checkout and exited **0**.

- `pnpm gateway:release:ci`: artifact/activation contracts **209/209**, 306004.428125 ms; actual build/save/final inventory/immutable bundle/verify succeeded. Default production verification of the same marked test-only bundle exited **1** for the expected test-mode prohibition.
- Actual `docker image load` → exact tag/OCI-label inspect → pure shared Bash identity check → read-only/non-network Node container → container `.Image` inspect succeeded. Docker 29 reported the descriptor ID below, which exactly matched container `.Image`; the distinct config digest remained unchanged in provenance.
- Exact real CMS flow: `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='^backup is encrypted, binds the exact release and recipient, and round-trips all roots$' scripts/gateway-appliance-state.test.mjs` — **1/1**, 23221.927917 ms, zero skips. Real ephemeral RSA/CMS and real four-root filesystem CLIs; Docker/Compose/platform-specific operations inside this state fixture remain simulated.
- Gate output confirmed all owned images/containers/artifacts/keys/plaintext were removed and software-only PASS. A subsequent independent read-only check found `/private/tmp/gateway-release-ci-kHBGS3` absent, no exact test image tag, no exact named smoke container, and a clean Git status.

| Artifact identity | Value |
| --- | --- |
| Release ID | `0.1.0-05c8451409571575185462453e08cad6cf3aa278-5a4cf3a358189081-test` |
| Version / full source commit | `0.1.0` / `05c8451409571575185462453e08cad6cf3aa278` |
| Platform / test marker | `linux/amd64` / `true` (shell `1`) |
| Exact image tag | `led-control-gateway-ci:d1074209e091423f829efa5b0a1a6573-test` |
| Config digest | `sha256:5a4cf3a358189081a529e2ca96715acb2f2e23dedd4fd427f63c445db1cce1a4` |
| Descriptor / daemon ID / container `.Image` | `sha256:c7de80607dd11626b32fed66901569642e39f0d1a4761da09272caef81de7de4` |
| Lock SHA-256 | `bb948af508ce537f33ea65180914a717031e23e42e5140133d4e967cf810c828` |
| Policy SHA-256 | `18d07a51124e5ee4d62a161606fb16b11460d29c0af10b54319ed833c146dd9e` |
| Final inventory SHA-256 | `dab4d3d146b2a2c3c856426df50186cfa3ab66641c91c2cd59f50d5f841dd8cb` |
| Actual runtime / inventory counts | Node **22.23.2**, `linux/x64`; **120 OS packages, 263 Node packages** |
| BlueZ | **5.82**, source SHA-256 `0739fa608a837967ee6d5572b43fb89946a938d1c6c26127158aaefd743a790b` |
| Firmware policy | ESP-IDF `v5.5.1`; product identity format `1`; dimming wire `2`; automation snapshot `1`; vehicle sensor protocol `1`; Company ID must match signed firmware at runtime. |
| Content scan profile | `led-control-private-material/v2`, exact scope/limitations above. |

Exact seven-file closure: `appliance.env`, `checksums.sha256`, `compose.yml`, `docker/seccomp-bluez-mesh.json`, `gateway-image-linux-amd64.tar`, `release-manifest.json`, `sbom.spdx.json` (SPDX 2.3). This disposable artifact was deleted after evidence collection, not distributed or deployed.

The real build used `node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5` and `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171`. Warm Buildx cache was used where valid; this was not an uncached reproducibility claim.

### Full production audit rerun

`pnpm ci:production-audit` at clean `05c8451409571575185462453e08cad6cf3aa278` exited **0**, from prerequisite checks through the final dependency policy. This is a full rerun, not only the previously stopping command:

| Stage | Actual result |
| --- | --- |
| Docker/Compose configuration and `pnpm workspace:prepare` | PASS. |
| `node --test tests/mqtt-production-config.node.mjs` | 2/2, 46.939708 ms. |
| `pnpm --filter @led-control/gateway test:contracts` | 25/25, 323.062167 ms. |
| `MQTT_INTEGRATION_REQUIRED=1 pnpm mqtt:integration` | Real disposable broker restart/QoS 1 and certificate ACL: 2/2, 5661.860833 ms. |
| `pnpm gateway:release:ci` (one in-band invocation) | 209/209 contracts, 290813.151208 ms; actual image/bundle/default rejection/load/inspect/run/Node inventory PASS; exact CMS flow 1/1, 23273.208958 ms; owned cleanup PASS. |
| `pnpm --filter @led-control/web test:bundle-audit` | main 314.83 kB / gzip 97.58 kB, PASS. |
| `node --test apps/web/container-contract.node.mjs` | 5/5 including actual Docker build smoke, 15975.001 ms. |
| `pnpm audit:production` | 820 dependencies, Critical 0 / High 2 / Moderate 1 / Low 0; exactly the three checked-in approved exceptions, no unexpected finding; PASS. |

The in-band rebuild kept config SHA `5a4cf3a358189081a529e2ca96715acb2f2e23dedd4fd427f63c445db1cce1a4`, inventory SHA `dab4d3d146b2a2c3c856426df50186cfa3ab66641c91c2cd59f50d5f841dd8cb`, Node 22.23.2 and 120/263 counts. Its exact disposable tag was `led-control-gateway-ci:70b157a973ce4d0eba5451b5792671ac-test`, and descriptor/daemon/container ID was `sha256:72738890d7483e05ba0c183b8467b7a184d4431d11da4b0498d6a0da1aea8e40`. Buildx emitted a fresh attestation/index; descriptor equality across separate builds is not claimed. Both were individually bound to their saved archive/config.

After audit exit, independent checks found `/private/tmp/gateway-release-ci-UOdtLW` absent, no exact image tag or smoke container, and clean Git status. The three dependency exceptions remained visible in audit output: two patched `image-size@1.2.1` High advisories (`GHSA-5p2g-fcmc-qvqq`, `GHSA-w3rx-r6r6-pgpr`) and the existing `uuid@8.3.2` Moderate consumer exception (`GHSA-w5hq-g745-h8pq`). This task did not alter dependencies, exceptions or Web behavior.

### Final serial state and package checks

- `node --test --test-concurrency=1 scripts/gateway-appliance-state.test.mjs` — **85/85**, 480137.888166 ms, zero skips. Includes Docker 29 state identity, legacy flows, complete four-root restore/rollback/journal phases, malformed archives, identity/permission checks, hostile TMPDIR, TERM cleanup and shared resolver/lock behavior.
- `pnpm --filter @led-control/gateway typecheck` — fresh exit 0 after the full audit/state run.
- `pnpm --filter @led-control/gateway test` — fresh **64 files, 608/608**, 34.92 s, exit 0; no hardware/HIL was run by these unit fixtures.
- `pnpm --filter @led-control/gateway build` — fresh exit 0; 564.6 kB, esbuild 16 ms.
- Final static commands: `node --check scripts/gateway-release-ci.mjs`, `node --check scripts/gateway-release-bundle.mjs`, `bash -n scripts/ci-production-audit.sh scripts/gateway-appliance-build.sh scripts/gateway-appliance-common.sh scripts/gateway-appliance-release.sh scripts/gateway-appliance-state.sh`, `git diff --check` — all exit 0. Committed source diff from Task 4 base also passed `git diff --check b89a540..HEAD`.
- Current-code behavior coverage was rerun as serial component commands (focused bundle/CI **170/170**, canonical artifact/activation **209/209**, state **85/85**); this is not described as a fresh single combined run of the historical 291-test command.

## Files changed

- CI: `package.json`, `.github/workflows/ci.yml`, `scripts/ci-production-audit.sh`, `scripts/ci-workflows.test.mjs`, new `scripts/gateway-release-ci.mjs` and `.test.mjs`.
- Genuine actual-image compatibility: `apps/gateway/docker/Dockerfile`, `apps/gateway/docker/container-contract.test.mjs`, `scripts/gateway-release-bundle.mjs` and `.test.mjs`, `scripts/gateway-appliance-build.sh`, shared `gateway-appliance-common.sh`, `gateway-appliance-release.sh` and `.test.mjs`, `gateway-appliance-state.sh` and `.test.mjs`, `gateway-appliance-fixture.mjs`.
- Docs: Gateway README/RELEASE-BUNDLE, Pi runbook, agent operations, project status, lessons learned, execution plan, this report.

## Self-review and remaining boundaries

- Workflow chaining/protected-step policy is not weakened; missing prerequisites, production accepting a test-only artifact, absent state test, failed identities or cleanup all make the gate fail.
- This task did not dispatch a reviewer/subagent, as explicitly instructed. Self-review evidence is not an independent final-review approval; that remains with the parent review workflow.
- Config, blob, decoded diff ID and daemon descriptor identities remain separate. Activation/state share the same binding decision, preserve legacy shell rollback, and commit pointers only after matching-image health. Actual Docker load/inspect/run evidence is required in addition to fixture tests.
- Private-material guarantees are versioned and deliberately scoped to enforceable file artifacts; standard crypto binaries and documentation are not classified from a substring or inferred ASN.1 offset.
- Immutable bundle closure, strict env parser, supported transport limits, final-visible inventory/whiteouts, public key controls, shared lock/journal ordering and owned cleanup remain covered.
- No menus, API contracts, database schema/structure, database-schema documentation or migrations were changed/applied. No user DB, operational service, production keys, SSH, Raspberry Pi, live site activation, firmware flash, RF/HCI, power cut or HIL was used. No main merge/push.
- Real evidence is Docker Desktop software `linux/amd64` (host Docker platform `linux/arm64/v8`), not production ARM64/Pi acceptance. Host Node 24.19.0, Docker 29.7.2, Buildx v0.35.0, OpenSSL 3.6.3 were observed; shipped Node must be separately proven by the real container smoke.
- Operator signing/trusted artifact delivery, recipient certificate authenticity/off-device escrow, verified-baseline migration for legacy installs, actual GNU/Linux Pi filesystem/timeout behavior, power-loss/SIGKILL/orphan recovery, production ARM64 image acceptance, BlueZ/HCI/RF/HIL and GitHub environment/runner/secrets/protection configuration remain external approval/validation work.
