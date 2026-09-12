# Task 4 independent-review fix report

Date: 2026-09-13 (Asia/Seoul). Worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`, branch `codex/p0p1-platform-gateway-release`. Review base: `1b9326f06ef3e60de0a602f74f7bb574cc2b5c63`.

Status: fixes, fresh full behavior **343/343**, Gateway contracts **30/30**, typecheck, **608/608** unit tests and build verified. Committed clean Docker/audit evidence is pending and is not yet claimed. The independent review is preserved in `task-4-review.md` before implementation. No subagents were used.

## Findings and implementation

1. **Encrypted private-key artifacts:** exact manifest profile advances from v2 to v3. Complete `ENCRYPTED PRIVATE KEY` PEM blocks in UTF-8 text are structurally rejected without decrypting them; standalone whole-file PKCS#8 EncryptedPrivateKeyInfo DER is rejected through bounded canonical definite-length container/OID/parameter structure. Plain unencrypted PKCS#1/PKCS#8/SEC1 still requires Node crypto private-key parsing. Whole-file base64/ASCII-whitespace rules also apply to encrypted artifacts. Public SPKI/CA, ordinary encrypted non-key bytes and malformed/non-container DER remain permitted. This is an artifact/container guarantee, not decryption, signature, general-secret or embedded-binary-offset detection. DER limit 65,536 bytes, nested structure limit 12/128 parser visits, PEM/normalized base64 131,072 characters; v1/v2 are not silently recertified as v3.
2. **Protected full recovery suite:** canonical CI runs the entire state suite serially once, requires exact 85 tests/85 pass, fail/cancel/skip/todo 0, and exactly one successful named real CMS happy flow in that same output. No happy-flow-only duplicate run remains. Malicious archive/path/permissions/identity/partial swap/journal rollback are now in-band.
3. **Bounded process lifetime:** a reusable runner owns detached POSIX process groups, distinguishes launcher exit from live descendants, allows a 3-second descendant drain, then TERM 2 seconds → KILL 2 seconds. Child work timeout is 30 minutes; gate execution is 45 minutes; cleanup gets 2 minutes with a 5-second hard backstop. Still-live group cleanup fails with exit 3 and retains staging. Workflow production-audit has a protected literal 60-minute timeout. Real TERM-ignoring child/descendant tests exercise deadlines and escalation; normal nonzero results/output and unrelated containers stay preserved.
4. **Attestations:** references must target the selected runtime **leaf manifest**, never a selected intermediate index; at least one in-toto layer is required. Config/descriptor identities remain separate and valid Buildx attestations remain supported.
5. **Tar entry bounds:** count every nonzero header (including duplicates, zero-byte files and extension metadata) before parsing/pushing an entry. Limits: outer 4,096; per-layer 100,000; cumulative layer 250,000. Existing 2 GiB archive/cumulative decoded, 512 MiB compressed/decoded layer and 128-layer limits remain.
6. **pnpm unlink:** require exact symlink type and `../../../../../../workspace/apps/gateway` target before unlinking the one build-only self-reference. Real shell execution of the Dockerfile command tests expected/wrong target, regular file, directory and missing entry. Actual image build is additionally required below.

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

Clean canonical and full production-audit evidence remains pending before the code commit. Do not substitute prior `05c8451` evidence for these fixes. The new full-state gate deliberately adds all recovery regressions (about 8 minutes on this host) instead of the former ~23-second happy-flow-only stage; the fresh combined behavior command took 13m37s. Actual gate/audit elapsed time will be recorded after execution.

## Files and self-review

- Code/contracts: `scripts/gateway-release-bundle.mjs`, `.test.mjs`; `scripts/gateway-release-ci.mjs`, `.test.mjs`; new `scripts/gateway-release-process.mjs`, `.test.mjs`; `scripts/ci-workflows.test.mjs`; `.github/workflows/ci.yml`; `apps/gateway/docker/Dockerfile`, `container-contract.test.mjs`.
- Docs/evidence: Gateway README and RELEASE-BUNDLE, Pi runbook, agent operations, lessons, project status, governing spec/plan, preserved independent review, original Task 4 report and this fix report.
- Review boundary: no Task 2/3 lifecycle/state implementation changes, menus, API/DB schema/structure, migrations, operational keys, user database, SSH/Pi/firmware/HCI/RF/HIL, deployment, main merge or push.
- Parent supplies independent review; this agent did not dispatch a reviewer. Software-only Docker/fixture evidence does not establish production ARM64/Pi or power-loss acceptance. Operator signing/recipient custody, baseline migration, GNU/Linux Pi/power loss/HCI/RF/HIL and GitHub environment/runner/secrets/protection still require external approval/validation.
