# Task 4 independent-review fix report

Date: 2026-09-13 (Asia/Seoul). Worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`, branch `codex/p0p1-platform-gateway-release`. Review base: `1b9326f06ef3e60de0a602f74f7bb574cc2b5c63`.

Status: **All five Important findings and the Minor addressed and software-verified.** Fresh full behavior **343/343**, Gateway contracts **30/30**, typecheck, **608/608** units/build, committed clean canonical Docker gate and full production audit all passed. Functional fix commit: **`3ba80f8fa09939ab12687e824acdfb6cfe1d7fe0`**. This final report/docs update is evidence-only; its commit is identifiable as `docs(gateway): record final review gate evidence` in Git history. The independent review was preserved in `task-4-review.md` before implementation. No subagents, merge or push were used.

## Findings and implementation

1. **Encrypted private-key artifacts:** exact manifest profile advances from v2 to v3. Complete `ENCRYPTED PRIVATE KEY` PEM blocks in UTF-8 text are structurally rejected without decrypting them; standalone whole-file PKCS#8 EncryptedPrivateKeyInfo DER is rejected through bounded canonical definite-length container/OID/parameter structure. Plain unencrypted PKCS#1/PKCS#8/SEC1 still requires Node crypto private-key parsing. Whole-file base64/ASCII-whitespace rules also apply to encrypted artifacts. Public SPKI/CA, ordinary encrypted non-key bytes and malformed/non-container DER remain permitted. This is an artifact/container guarantee, not decryption, signature, general-secret or embedded-binary-offset detection. DER limit 65,536 bytes, nested structure limit 12/128 parser visits, PEM/normalized base64 131,072 characters; v1/v2 are not silently recertified as v3.
2. **Protected full recovery suite:** canonical CI runs the entire state suite serially once, requires exact 85 tests/85 pass, fail/cancel/skip/todo 0, and exactly one successful named real CMS happy flow in that same output. No happy-flow-only duplicate run remains. Malicious archive/path/permissions/identity/partial swap/journal rollback are now in-band.
3. **Bounded process lifetime:** a reusable runner owns detached POSIX process groups, distinguishes launcher exit from live descendants, allows a 3-second descendant drain, then TERM 2 seconds → KILL 2 seconds. Child work timeout is 30 minutes; gate execution is 45 minutes; cleanup gets 2 minutes with a 5-second hard backstop. Still-live group cleanup fails with exit 3 and retains staging. Workflow production-audit has a protected literal 60-minute timeout. Real TERM-ignoring child/descendant tests exercise deadlines and escalation; normal nonzero results/output and unrelated containers stay preserved.
4. **Attestations:** references must target the selected runtime **leaf manifest**, never a selected intermediate index; at least one in-toto layer is required. Config/descriptor identities remain separate and valid Buildx attestations remain supported.
5. **Tar entry bounds:** count every nonzero header (including duplicates, zero-byte files and extension metadata) before parsing/pushing an entry. Limits: outer 4,096; per-layer 100,000; cumulative layer 250,000. Existing 2 GiB archive/cumulative decoded, 512 MiB compressed/decoded layer and 128-layer limits remain.
6. **pnpm unlink:** require exact symlink type and `../../../../../../workspace/apps/gateway` target before unlinking the one build-only self-reference. Real shell execution of the Dockerfile command tests expected/wrong target, regular file, directory and missing entry. Actual Docker build step `[app-builder 21/22]` ran this exact check/removal successfully (0.2 s) in the clean canonical run; the subsequent audit reused that verified cache layer.

## RED evidence

All commands execute from the assigned worktree, serially. Key fixtures are freshly generated ephemeral material and no key/passphrase/base64 contents are recorded.

| Exact command | Observed RED |
| --- | --- |
| `node --test --test-concurrency=1 --test-name-pattern='encrypted private\|attestation rejects\|tar entry cap' scripts/gateway-release-bundle.test.mjs` | 14 tests, 0 pass / 14 fail, no skip/cancel, 44847.40375 ms. Encrypted keys, index-target/empty attestations and unique/duplicate layer cap+1 bundles were accepted. Outer duplicate case rejected only after building the unbounded entry list (wrong duplicate-path error instead of pre-push cap). |
| `node --test --test-concurrency=1 --test-name-pattern='executes contracts\|state-regression\|state-skip\|state-short\|production audit protects\|runtime packaging' scripts/ci-workflows.test.mjs apps/gateway/docker/container-contract.test.mjs` | 11 tests, 3 pass / 8 fail, no skip/cancel, 8161.460541 ms. Full state tests were not run; failed/skipped/short state results passed the gate; workflow timeout was absent; wrong-target/regular-file entries were deleted. |
| `node --test --test-concurrency=1 --test-name-pattern='TERM-ignoring' scripts/gateway-release-ci.test.mjs` | Real descendant RED 0/1, 30130.50525 ms. Existing gate did not finish before the harness 30-second SIGKILL safety deadline (`status null`, not 1). Harness killed only its recorded owned process group afterwards. |
| `node --test --test-concurrency=1 scripts/gateway-release-process.test.mjs` | 0/3, 44.4275 ms: bounded runner module/API did not exist. Subsequent GREEN executes actual child processes, including TERM-ignoring ones. |

Harness correction (not production RED): the first descendant attempt was 0/1 at 1548.997916 ms because its nested JavaScript newline was incorrectly escaped, so the descendant had not installed its TERM handler. Correcting the fixture yielded the genuine 30-second hang above. The timed-out run left `/private/tmp/gateway-release-ci-adS29w`; read-only inspection showed only two test forwarding scripts bound to `release-ci-contract-w819rE` and empty fixture/build directories. That exact disposable directory was removed, not a glob, after process absence was checked. No keys/user data were present. Fixture teardown now also removes only observed owned CI roots on a failed test.

## Focused GREEN and static checks

| Exact command | Result |
| --- | --- |
| `node --test --test-concurrency=1 --test-name-pattern='encrypted private\|attestation rejects\|tar entry cap\|private-material\|ASCII whitespace\|public CA\|Docker 29 gzip accepts' scripts/gateway-release-bundle.test.mjs` | **56/56**, no skip/cancel/fail, 42154.151417 ms. Includes real CLI create/verify encrypted PEM/DER/base64 and existing private/public/library/FF/VT/whiteout/gzip controls. |
| `node --test --test-concurrency=1 scripts/ci-workflows.test.mjs apps/gateway/docker/container-contract.test.mjs` | **55/55**, no skip/cancel/fail, 37496.221041 ms. Real TERM-ignoring descendant terminates in 6344.507958 ms; hard deadline child 625.852875 ms; abort/open-pipe child 156.694041 ms. |
| `pnpm workspace:prepare` | Exit 0. Host `pnpm --version` reports 9.15.0; the launcher emitted the existing package.json pnpm-field warning, not a test failure. |
| `node --check scripts/gateway-release-process.mjs`, `node --check scripts/gateway-release-ci.mjs`, `node --check scripts/gateway-release-bundle.mjs`, `git diff --check` | Exit 0 before full verification. |

## Full serial verification and clean artifact evidence

| Exact command | Result |
| --- | --- |
| `node --test --test-concurrency=1 scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/ci-workflows.test.mjs` | **343/343**, fail/cancel/skip/todo 0, 817323.310084 ms. Fresh combined current-code behavior, including the full state suite. |
| `pnpm --filter @led-control/gateway test:contracts` | **30/30**, fail/cancel/skip/todo 0, 338.600708 ms. |
| `pnpm --filter @led-control/gateway typecheck` | Exit 0. |
| `pnpm --filter @led-control/gateway test` | **64 files, 608/608**, 34.76 s, exit 0. Unit fixtures do not execute real HIL. |
| `pnpm --filter @led-control/gateway build` | Exit 0; 564.6 kB, esbuild 16 ms. |
| `bash -n scripts/ci-production-audit.sh scripts/gateway-appliance-build.sh scripts/gateway-appliance-common.sh scripts/gateway-appliance-release.sh scripts/gateway-appliance-state.sh` and Node syntax/diff checks above | Exit 0. |

### Clean canonical gate

Exact command: `time pnpm gateway:release:ci` at clean `3ba80f8fa09939ab12687e824acdfb6cfe1d7fe0`, exit **0**, wall time **14m37.149s** (user 6m32.851s, sys 4m30.508s).

- Artifact/activation contracts: **223/223**, fail/cancel/skip/todo 0, **320659.720042 ms**.
- Actual Docker build/save/bundle verification, test-only default production rejection (expected exit 1), exact tag load/inspect/OCI-label binding, shared activation identity decision, read-only/network-none Node 22 container and `.Image` comparison all passed.
- Full state command: `node --test --test-concurrency=1 --test-reporter=spec scripts/gateway-appliance-state.test.mjs` — **85/85**, fail/cancel/skip/todo 0, **535763.793625 ms**. The named actual RSA/OpenSSL CMS happy flow appeared once, **23855.712667 ms**, within those 85 tests. It was not rerun separately.
- Cleanup reported removal of all owned images/containers/artifacts/ephemeral keys/plaintext. Independent read-only checks confirmed exact image tag/container name below and `/private/tmp/gateway-release-ci-8vJMeG` were absent; Git remained clean.

The full-state stage now takes about **8–9 minutes** instead of only the former ~23-second selected happy flow. This is intentional in-band coverage, not a hang. Main suites ran serially; no filesystem/deadline suite was parallelized.

### Full production audit

Exact command: `time pnpm ci:production-audit` at the same clean functional commit, exit **0**, wall time **14m26.227s** (user 6m48.393s, sys 4m31.882s). This was a full rerun from prerequisites through the final dependency policy, not a partial resume.

| Stage | Current actual result |
| --- | --- |
| Docker/Compose resolution and workspace prepare | PASS. |
| MQTT production configuration | **2/2**, 46.356208 ms. |
| Gateway contracts | **30/30**, 326.88725 ms. |
| Actual disposable Mosquitto persistence/restart and certificate ACL | **2/2**, 5546.095458 ms. |
| Single in-band Gateway canonical invocation | **223/223**, 322463.829125 ms; actual image/bundle/default production rejection/load/inspect/run PASS. |
| Full in-band state suite | **85/85**, fail/cancel/skip/todo 0, **506304.882875 ms**; named actual CMS happy flow exactly once (**23074.940791 ms**); owned cleanup PASS. |
| Web bundle audit | main **314.83 kB**, gzip **97.58 kB**, PASS. |
| Web container contracts including actual Docker build smoke | **5/5**, 1932.2845 ms. |
| Production dependency policy | **820 dependencies**, Critical **0**, High **2**, Moderate **1**, Low **0**; exactly the existing three approved exceptions, no unexpected finding, PASS. |

Existing exceptions are `GHSA-5p2g-fcmc-qvqq` and `GHSA-w3rx-r6r6-pgpr` for patched build-time `image-size@1.2.1`, and `GHSA-w5hq-g745-h8pq` for the existing `uuid@8.3.2` ExcelJS consumer. No dependency, patch, exception or Web behavior was changed here.

Both full current runs passed on the first attempt after this fix commit. The original Task 4 audit's Docker 29 compressed-diff-ID stopping point and later compatibility failures remain historical evidence in `task-4-report.md`, not erased or represented as failures of this fix wave.

### Exact actual artifact identity

| Field | Verified value |
| --- | --- |
| Release ID | `0.1.0-3ba80f8fa09939ab12687e824acdfb6cfe1d7fe0-fb20a7a61382a633-test` |
| Source / version / timestamp | `3ba80f8fa09939ab12687e824acdfb6cfe1d7fe0` / `0.1.0` / `2026-09-12T17:58:29.000Z` |
| Platform / marker | `linux/amd64` / JSON `true`, shell `1` (test-only). |
| Config digest (both runs) | `sha256:fb20a7a61382a633560b3d4b1ea7438a38ca2f174f8ac5f0ca62100608ffccc6` |
| Runtime leaf manifest (both Buildx exports) | `sha256:f3c2e6ebbea3b5f0484e461f4c32053e4fd7049aba8f9e936b08d9f06fddd0c5` |
| Canonical tag | `led-control-gateway-ci:835963b0e2be4e3896a1626464e80793-test` |
| Canonical descriptor / daemon / container ID | `sha256:f7c3f26d147efbb8169281f5e7c8715091f7bfe987be1f3055a9b012dc13bcbf` |
| Canonical attestation manifest | `sha256:73425ae976da2f62c75ec8c634c4224e164576f3283bc7667a9c73fb46136c57` |
| Audit tag | `led-control-gateway-ci:7bdc1c112f7e4419a98ebd9786a743e2-test` |
| Audit descriptor / daemon / container ID | `sha256:51518685293722e47047fc938b38c4f72db2d1295ee5ed27deedc47fe67b37ce` |
| Audit attestation manifest | `sha256:49b954b6c29073ae55aa614a65ef38bcb7c2cf8c40171ddd2cbb46eb36f3f2c5` |
| Lock SHA-256 | `bb948af508ce537f33ea65180914a717031e23e42e5140133d4e967cf810c828` |
| Policy SHA-256 | `18d07a51124e5ee4d62a161606fb16b11460d29c0af10b54319ed833c146dd9e` |
| Inventory SHA-256 | `dab4d3d146b2a2c3c856426df50186cfa3ab66641c91c2cd59f50d5f841dd8cb` |
| Actual runtime/inventory | Node **22.23.2**, `linux/x64`, **120 OS / 263 Node packages**. |
| BlueZ | **5.82**, source SHA-256 `0739fa608a837967ee6d5572b43fb89946a938d1c6c26127158aaefd743a790b`. |
| Firmware policy | ESP-IDF `v5.5.1`, product identity `1`, dimming wire `2`, automation snapshot `1`, vehicle protocol `1`, Company ID must match signed firmware at runtime. |
| Scan/schema | `led-control-private-material/v3`, `led-control-gateway-release/v1`; SPDX **2.3**. |

Exact seven-file closure: `appliance.env`, `checksums.sha256`, `compose.yml`, `docker/seccomp-bluez-mesh.json`, `gateway-image-linux-amd64.tar`, `release-manifest.json`, `sbom.spdx.json`.

The two builds used warm Buildx cache and the same config/runtime leaf/inventory; fresh attestation/index identities differed and were individually archive-bound, not assumed interchangeable. Base images were `node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5` and `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171`. Docker warned that its host was `linux/arm64/v8` while the requested test image was `linux/amd64`; the explicit actual smoke proved `linux/x64`. This is emulated disposable software evidence, not a production ARM64 or uncached reproducibility claim.

After the audit, independent checks confirmed both exact image tags/container names and both `/private/tmp/gateway-release-ci-8vJMeG` / `gateway-release-ci-WNGQzP` directories absent, with clean Git status and `git diff --check 1b9326f..HEAD` exit 0. Artifacts were deleted, not retained for deployment. Base images/cache and unrelated containers were not globally pruned.

## Files and self-review

- Code/contracts: `scripts/gateway-release-bundle.mjs`, `.test.mjs`; `scripts/gateway-release-ci.mjs`, `.test.mjs`; new `scripts/gateway-release-process.mjs`, `.test.mjs`; `scripts/ci-workflows.test.mjs`; `.github/workflows/ci.yml`; `apps/gateway/docker/Dockerfile`, `container-contract.test.mjs`.
- Docs/evidence: Gateway README and RELEASE-BUNDLE, Pi runbook, agent operations, lessons, project status, governing spec/plan, preserved independent review, original Task 4 report and this fix report.
- Review boundary: no Task 2/3 lifecycle/state implementation changes, menus, API/DB schema/structure, migrations, operational keys, user database, SSH/Pi/firmware/HCI/RF/HIL, deployment, main merge or push.
- Parent supplies independent review; this agent did not dispatch a reviewer. Software-only Docker/fixture evidence does not establish production ARM64/Pi or power-loss acceptance. Operator signing/recipient custody, baseline migration, GNU/Linux Pi/power loss/HCI/RF/HIL and GitHub environment/runner/secrets/protection still require external approval/validation.
- Self-review checked the exact manifest/profile fields and scope, bounded candidate/parser lifetimes, cap checks before entry allocation, leaf-only attestation set, no state name filter/one named success, process deadlines and still-live failure path, exact unlink type/target, workflow non-skippability and unchanged Task 2/3 mutation contracts. Real TERM/KILL fixtures prove owned-group cleanup, not behavior under an actual host/kernel power cut. Existing checksum/trusted-policy approval and recipient custody boundaries remain.
