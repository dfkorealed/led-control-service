# Task 3 independent-review fixes

Review base: `eefe47102c799c919e3c8fe9633aaada9a4d0dfe`.

The orchestrator-supplied review was saved verbatim in `task-3-review.md` before implementation. This patch is confined to Task 3 production state handling, its shared test fixture, behavior tests and these review/fix reports. No CI/runbook, DB/runtime schema, operational data, Docker daemon, Pi or HIL work was performed. No subagents were used.

## Important 1 — identical producer/parser path limits

The v1 USTAR profile still does not accept a prefix field. Directory names now reserve one byte for tar's trailing slash: maximum relative directory path **99 ASCII bytes**; regular-file/link path **100 bytes**. `state_name` supplies the same directory-aware bound to both the filesystem producer and archive parser. Before quiescing, backup performs a read-only path walk and rejects unsupported names. It repeats validation during the quiesced manifest pass, so a newly appearing invalid path cannot be published.

Real backup tests cover accepted directory 99/file 100 paths and require both `verify` and `drill` for every accepted boundary backup. Directory 100/file 101 fail before any stop call or output creation. An independently encrypted 100-byte directory with no prefix field is also refused by the parser.

## Important 2 — trusted plaintext workspace location

All commands now **ignore ambient `TMPDIR`**. They resolve the physical system `/tmp`, require root ownership and full mode `01777`, and allocate an exclusive `0700` mktemp direct child there. macOS `/tmp` may be its system symlink; its physical directory is checked. Full BSD mode is used for the sticky-bit check because BSD `%Lp` omits special bits.

Before creating any workspace, input/output paths are validated. Live commands additionally read the existing strict site data resolver before staging and refuse a site/artifact that contains the system temporary base. Sites and artifacts may be below that base, because a fresh direct-child workspace is then their sibling, not inside them. Relevant placement checks are repeated after runtime/site revalidation, during journal recovery, and before workspace removal. Verify/drill remain independent of live root/Docker: they ignore the caller-selected TMPDIR and never consult the live site dotenv.

Tests record the directories returned by **actual mktemp executions**, without changing their paths, and assert placement and cleanup. Hostile TMPDIR values cover gateway, mesh, identity, factory-trust, appliance root, runtime, input backup and a safe temporary path. Verify/drill retain identical live data/site env and input file sets, invoke no Docker, and place no workspace inside the appliance or backup. Restore with TMPDIR pointing at gateway now round-trips instead of moving its own workspace and failing. Existing TERM tests also observe the actual trusted workspace and require its removal.

Recovery rejects older/custom-TMPDIR workspaces outside the newly trusted base rather than trying to delete them. An appliance with such a pending transaction needs explicit operator review/recovery before upgrading the manager; the journal is retained. The previously documented untrappable SIGKILL-before-journal/operator-temp-cleanup limitation is unchanged.

## Important 3 — exact immediate parents and cleanup revalidation

`owned_directory_path` now requires all of:

- literal `dirname(WORKSPACE) == physical system TEMP_BASE`, or `dirname(STAGE) == validated DATA_DIR`;
- an exact allowed basename prefix and the six alphanumeric characters produced by `mktemp ...XXXXXX`;
- physical, non-symlinked ancestors and an unchanged physical parent.

Journal parsing uses this shared validation, not prefix-plus-final-basename matching. Recursive cleanup recognizes only workspace, restore-stage and encrypted-output-stage classes. It checks the exact parent/path and directory mode again immediately before removal; restore child-copy cleanup also rechecks the enclosing stage and child directory immediately before its recursive removal command. Unsafe, nested, broad or symlinked paths fail closed.

The two RED fixtures placed a sentinel inside a nested `.gateway-state.VICTIM` / `.state-restore.VICTIM` directory. Before the fix, recovery deleted the sentinel. After the fix, both sentinels and the original journals survive, status is `3`, and no runtime call is made. Tests remove only their own victim fixtures after verifying preservation.

## Scoped Minor follow-up

Four additional persistence-boundary tests pass:

1. SIGKILL after the actual `new/gateway -> live gateway` rename, before the next phase write; the journal still says `old_gateway`.
2. SIGKILL after the actual `old/gateway -> live gateway` rollback rename.
3. SIGKILL at durable `rolled_back` before old-service recovery completes.
4. Recovery of a durable `committed` journal after one old root has already been removed, representing partial commit cleanup.

The fourth case constructs the partially cleaned persisted filesystem after an actual committed-phase SIGKILL; it is not a physical power-loss test. Exhaustive interruption of every filesystem instruction/root and real GNU/Linux/Pi durability remain unproven Minor/rollout work, not claimed complete.

## TDD and final verification

- Boundary/ambient RED: **7 cases, 2 accepted-boundary passes and 5 expected failures** (100-byte directory accepted, 101-byte file stopped too early, parser accepted incompatible directory, live TMPDIR plaintext, restore workspace move/exit `3`).
- Nested-journal RED: **2/2 failed**, with both sentinel files actually deleted in disposable fixtures.
- Development targeted GREEN: boundary/parser **5/5**, nested-journal **2/2**, temp/TERM/nested **13/13**, additional persistence boundaries **4/4**. These diagnostics are superseded by the definitive serial full-suite evidence below.
- Gateway contracts, rerun after the combined suite: **24/24**, exit `0`, duration **322.811 ms**; Bash/Node syntax and diff-check pass. The installed pnpm still emits the existing root `pnpm`-field compatibility warning; no dependency files were changed.
- Final serial focused state: **84/84**, exit `0`, fail/cancelled/skipped `0`, duration **504.165 seconds**.
- Final serial combined regression: **267/267** (the previous **247** plus **20** new state regressions, including all **183** existing release/bundle/appliance tests), exit `0`, fail/cancelled/skipped `0`, duration **746.840 seconds**. No new regression was observed in these scoped checks.

The first full focused and combined invocations overlapped and are **excluded from final verification evidence**. That probe reported focused 84/84 and combined 265/267: the existing legacy baseline test received an earlier ownership-preflight rejection, and the existing hanging-recovery test exceeded its 8-second wall-clock assertion. Host contention/short fixture deadlines were a hypothesis, not a confirmed code defect. Both processes were allowed to finish fixture teardown. The definitive rerun was focused first, then combined with `--test-concurrency=1`; both previously failing cases passed, and no timeout, assertion or production contract was relaxed.

```text
node --test scripts/gateway-appliance-state.test.mjs
node --test --test-concurrency=1 scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs scripts/gateway-appliance-scripts.test.mjs
pnpm --filter @led-control/gateway test:contracts
bash -n scripts/gateway-appliance-state.sh scripts/gateway-appliance-common.sh scripts/gateway-appliance-release.sh scripts/gateway-appliance-deploy.sh
node --check scripts/gateway-appliance-state.test.mjs
node --check scripts/gateway-appliance-fixture.mjs
node --check scripts/gateway-appliance-release.test.mjs
git diff --check
```

Artifact, inner manifest and nine-field journal schema names are unchanged. This fix narrows the supported directory-path and workspace-location profiles. Ephemeral test recipients and all plaintext state remain confined to owned disposable fixtures; no plaintext tar archive or key/certificate payload log is produced. Final commit SHA and clean-worktree evidence are supplied in the handoff.
