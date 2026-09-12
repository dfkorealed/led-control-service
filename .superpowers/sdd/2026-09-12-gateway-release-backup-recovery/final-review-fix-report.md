# Whole-branch final review fix: bounded state decoding

Date: 2026-09-13 (Asia/Seoul). Worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`, branch `codex/p0p1-platform-gateway-release`. Review base: `344bd6b9e1ff78d7ded791513ab0442c5e4e7edc`.

Status: **The scoped Important is implemented, software-verified and independently re-reviewed.** The reviewer confirmed the finding addressed, no new Critical/Important/Minor findings and merge readiness. Full state **98/98**, combined current behavior **358/358**, Gateway contracts **30/30**, Bash/Node syntax and diff PASS. Functional commit **`0f12135fe2503d71156b006d3e1d658fca490634`** passed both the committed-clean canonical Docker gate and full production audit serially. Final evidence commit **`cf3051bd1938570c5ad1f6cb87a56673f707170c`** was independently checked again with combined **358/358**, Prisma generation plus workspace typecheck, full workspace test/build and the full production audit, all exit 0. No production code changes follow the functional gate. Prior Task 4 counts are not reused as fresh evidence. No merge or push. Only ephemeral recipients and disposable fixtures are used; no key/passphrase/payload contents or plaintext tar files are logged/committed.

## Finding and operating budget

The final whole-branch Important was an unbounded state USTAR resource profile: safe paths/types and a 16 MiB manifest cap did not bound entry processing, regular-file bytes, aggregate extracted bytes or end-of-archive zero padding. A declared oversized file reached `dd` before the old parser rejected truncation. The requested fix must bound work before header handling/filesystem payload creation and must not reject the existing 64 MiB automation outbox/reserve operating budget.

Production uses explicit `readonly` constants, without environment/CLI overrides:

| Limit | Value / accounting |
| --- | --- |
| Entry count | 4,096 nonzero headers, including manifest, directories, links, duplicate and zero-byte entries; checked before checksum/field handling |
| Regular file | 256 MiB / 268,435,456 bytes, before payload `dd` opens the target |
| Regular total | 512 MiB / 536,870,912 bytes, **including manifest**; subtraction guard before adding/reading a payload |
| Manifest | 16 MiB / 16,777,216 bytes |
| Framing | `4096 × (512 + 511) + 2 × 512 + 10240 = 4,201,472 bytes`; header, padding, mandatory end blocks and trailer accounted separately from regular bytes |
| Decoded archive | 541,072,384 bytes = regular total + framing |
| Ciphertext | 544 MiB / 570,425,344 bytes; capped before hash/copy/decrypt, with CMS BER/encryption overhead margin |

Current runtime sources: `automation-state-store.ts` caps state at 64 MiB; `automation-telemetry-outbox.ts` caps the regular outbox at 64 MiB; `automation-storage.ts` defaults shared `.reserve` to the same 64 MiB; `state-event-outbox.ts` budgets 100 MiB payload before serialized metadata. Per-file 256 MiB leaves serialization space, total 512 MiB leaves room for sidecars/mesh/identity generations, and 4,096 entries balances identity generation accumulation against small/empty-file CPU/inode exhaustion. This is a bounded supported profile, not a promise that arbitrary accumulation or every independently maximal runtime file will always fit.

Producer preflight computes exact future manifest length from metadata (real path/type/uid/gid/size/link, fixed four-digit mode and 64-character regular digest lengths). It includes the manifest in the regular-byte budget before file hashing and quiesce, then repeats the same check on the quiesced snapshot. No state is pruned and no partial backup is emitted on rejection. Existing oversized backups also fail closed: operator ACK drain, approved retention/capacity action or a separately reviewed profile change is required, not deleting outboxes/identity generations or truncating archives.

The parser counts every nonzero header before handling fields, reserves per-file/aggregate/padding bytes before payload I/O and bounds trailing zero reads to 10,241 bytes (limit+1), rejecting nonzero or oversized trailers. Outer size checks also reject padded oversized CMS containers which OpenSSL otherwise accepts. Shared lock, safe physical scratch paths, four-root transaction journal and recovery decisions are unchanged.

## Schema compatibility

No schema rename, database migration, image identity/policy change or runtime dependency was introduced. Exact artifact remains `backup.env`, `checksums.sha256`, `state.cms`, with outer `led-control-gateway-backup/v1`, inner `led-control-gateway-state/v1`, CMS `openssl-cms-aes-256-cbc-rsa/v1`, and nine-field durable `gateway-state-operation/v1` journal. The existing USTAR ASCII/path/type/mode/ownership/identity containment contract remains; this fix narrows its supported resource profile.

## TDD evidence (all commands serial)

1. Before production edits, `node --test --test-name-pattern='state budget' scripts/gateway-appliance-state.test.mjs` used actual production-scale USTAR/CMS fixtures: **13 tests, 4 pass / 9 expected fail, 0 skip/cancel, 534195.910042 ms**. Failures: 4,097 unique directories (145067.963958 ms) and zero-size files (208445.693125 ms) reached the forbidden final `mkdir`/`dd`; per-file 256 MiB+1 header opened its output; real 512 MiB+1 aggregate reached the crossing payload; 10,241 trailing zeros and 544 MiB+1 padded CMS were accepted; producer count/per-file/aggregate crossed quiesce. Controls: duplicate was already rejected, exact 512 MiB including manifest passed, real 64+64+100 MiB size profile passed, and exact 10,240 trailer bytes passed. The per-file negative uses a declared cap+1 header with a truncated encrypted stream deliberately: opening `dd` before rejection, not reading a huge actual body, was the defect under test.
2. CI contract RED: `node --test --test-name-pattern='executes contracts|state-legacy|state-budget-regression' scripts/gateway-release-ci.test.mjs`: **3 tests, 1 pass / 2 expected fail**, 5508.407042 ms. The old gate rejected the new complete 98-test suite but accepted the old 85-test suite. Existing failed-test rejection remained a passing control.
3. With parent approval, permanent boundary fixtures now verify exact production literals and only then copy the same shell/common library into an owned disposable directory, replacing that copy's limits with 64 entries, 256 KiB/file, 512 KiB total, 16 KiB manifest and 1 MiB ciphertext. Real 512-byte USTAR framing/trailer accounting and actual OpenSSL CMS/I/O remain. No production override, mocked parser, plaintext tar file or altered ordinary/CI deadline exists. The exact-entry control also passes at the scaled cap. Production-scale RED above is preserved; permanent production-source 64+64+100 MiB streaming verify/drill remains separate. Its opaque zero-byte payloads demonstrate archive size compatibility, not runtime JSON validity or HIL.
4. Focused state GREEN, same name-filter command: **13/13**, fail/cancel/skip/todo 0, **73427.746 ms**. Real forwarding wrappers observe `mkdir`/`dd` without replacing their I/O; overflow is rejected before the forbidden target is touched. Every successful rejection/control checks exact scratch cleanup, no Docker call for verify/drill/invalid restore and unchanged live snapshot; producer overlimit never stops the service or writes final output.
5. CI contract GREEN, same three-test command: **3/3**, fail/cancel/skip/todo 0, **5392.91925 ms**. Canonical gate requires full unfiltered serial **98 tests/98 pass**, no skip/cancel/fail/todo, and exactly one named real CMS roundtrip. An older 85-test suite, short result, skipped case or failed new budget regression is not accepted.

## Full verification and committed-clean gate

`node --test --test-concurrency=1 scripts/gateway-appliance-state.test.mjs`: **98/98**, fail/cancel/skip/todo 0, **610622.678583 ms**. This includes all prior 85 regressions and 13 new budget cases. The retained production-source 64+64+100 MiB streaming acceptance took **12406.971417 ms** (about 2% of the state suite); the large entry/aggregate overflow repetitions use the fast disposable-copy profile.

`node --test --test-concurrency=1 scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/ci-workflows.test.mjs`: **358/358**, fail/cancel/skip/todo 0, **945225.855458 ms**. Full existing behavior plus all budget/CI regressions; no new regression observed in this scope.

`pnpm --filter @led-control/gateway test:contracts`: **30/30**, fail/cancel/skip/todo 0, **371.336709 ms**. The existing host pnpm-field warning was emitted, not a test failure. `bash -n` on state/common/release/deploy; `node --check` on state test/CI runner/CI test/appliance fixture; `git diff --check`: exit 0, serial after combined.

Both commands below ran at clean functional commit `0f12135fe2503d71156b006d3e1d658fca490634`. `git status --porcelain -uall` was empty before, between and after them; no document/code edits occurred while either command ran.

| Exact command | Fresh result |
| --- | --- |
| `time pnpm gateway:release:ci` | Exit **0**, wall **16m21.113s**. Artifact/activation **223/223** (321067.054292 ms), full state **98/98** (641489.651375 ms), fail/cancel/skip/todo 0, named actual CMS happy flow exactly 1. Real test-only image/v3 scan/default production rejection/load-inspect-run identity/Node inventory and owned cleanup PASS. |
| `time pnpm ci:production-audit` | Exit **0**, wall **16m41.939s**. Docker/Compose preflight and workspace preparation; MQTT configuration **2/2**; Gateway contracts **30/30**; actual MQTT persistence/ACL **2/2**; in-band canonical **223/223** (321590.973417 ms) + full state **98/98** (642983.220208 ms), named CMS 1/no skip; actual image and owned cleanup; Web main **314.83 kB**/gzip **97.58 kB** and container **5/5**; dependency **820**, Critical **0**/High **2**/Moderate **1**/Low **0**, existing approved exceptions **3**, unexpected **0**. |

The dependency exceptions remain `image-size@1.2.1` GHSA-5p2g-fcmc-qvqq/GHSA-w3rx-r6r6-pgpr (existing fail-closed repository patch) and ExcelJS `uuid@8.3.2` GHSA-w5hq-g745-h8pq (existing scoped v4 consumer evidence). No exception or dependency policy was added/relaxed here. Existing host pnpm-field and amd64-on-arm64 emulation warnings were non-failing and are not hidden.

## Exact artifact and cleanup evidence

Both actual image runs bound Git `0f12135fe2503d71156b006d3e1d658fca490634`, `linux/amd64`, test mode true, version `0.1.0`, policy SHA `18d07a51124e5ee4d62a161606fb16b11460d29c0af10b54319ed833c146dd9e`, lock SHA `bb948af508ce537f33ea65180914a717031e23e42e5140133d4e967cf810c828`, inventory SHA `dab4d3d146b2a2c3c856426df50186cfa3ab66641c91c2cd59f50d5f841dd8cb`, and private-material profile v3. Actual smoke observed Node **22.23.2**, OS **120**/Node **263** packages. The BlueZ 5.82 source hash and exact firmware compatibility stayed unchanged.

Both runs shared config digest `sha256:bacc25d55b2926446b26d08376a956b39a7c097f693fa809cf89a88472a0ed06` and selected runtime leaf `sha256:3df08d0d0fc5782e252028ea7810a3ede44093fe296d39c5ba0e1186a7229e99`. Each separately verified its new attestation/index and bound Docker 29's descriptor-valued daemon ID to container `.Image`:

| Run | Image tag (`led-control-gateway-ci:`) | Descriptor = daemon ID = container `.Image` |
| --- | --- | --- |
| Standalone canonical | `cee84ac716344920afd34f635739c488-test` | `sha256:e50ee87ab6c1001e94be68524e51794aba791ba52bfd67c6c5760bd90e326a77` |
| Full-audit in-band | `f4526b36abc6448b8a542395f833ca50-test` | `sha256:6a9e63642f933287da52da04f39b5194a506723978200b5ee3fad03a88ee87be` |

Exact release closure in each run: `appliance.env`, `checksums.sha256`, `compose.yml`, `docker/seccomp-bluez-mesh.json`, `gateway-image-linux-amd64.tar`, `release-manifest.json`, `sbom.spdx.json`. Release ID: `0.1.0-0f12135fe2503d71156b006d3e1d658fca490634-bacc25d55b292644-test`. This seven-file release bundle is distinct from the three-file encrypted state artifact described above.

Both gates reported successful removal of owned images, containers, artifacts, ephemeral keys and plaintext. Post-audit read-only checks, with a working Docker daemon, independently confirmed both exact CI roots (`/private/tmp/gateway-release-ci-jGqxm2`, `/private/tmp/gateway-release-ci-mPMz49`) absent as file/directory/symlink, both Gateway image tags and `led-control-web:test` absent, and all four exact nonce-bound smoke/inventory container names absent. No global prune or unrelated-resource deletion occurred. Builds used warm cache and amd64 emulation: shared config/leaf hashes do not establish uncached byte-identical reproducibility or production ARM64/Pi readiness.

## Remaining boundaries

Software fixtures do not prove Pi/ARM64 filesystem durability, power-loss recovery, HCI/RF/HIL, production recipient custody/signing or GitHub protected-environment configuration. Existing interruption/rename/rollback/committed-cleanup coverage is preserved; this fix adds resource accounting, not new durability claims. No operational key, actual Pi/HIL, user DB, menu/schema change or main-branch change is authorized or performed.

Scope boundary sent to the parent for independent review: this decoded USTAR/static ciphertext budget is not a general guarantee against arbitrary-sized outer text metadata or concurrently mutating input writers/TOCTOU. Those broader pre-existing reader/copy concerns were not silently folded into this Task 3 fix.
