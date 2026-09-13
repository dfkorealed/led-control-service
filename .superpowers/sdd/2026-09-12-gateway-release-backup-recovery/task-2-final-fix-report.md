# Task 2 final Important fix — legacy host without verified baseline

## Scope and cause

Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`, branch `codex/p0p1-platform-gateway-release`.

The final review identified that an existing legacy `gateway` project container with no verified `current` release was being treated like a true first installation. On candidate failure, the first-install recovery path could stop the replacement but could not restore the unregistered legacy image. Project ownership alone is not a rollback baseline.

Only `scripts/gateway-appliance-release.sh`, its behavior tests, and this report changed. No migration/registration implementation, Task 3 state backup, Task 4 CI/runbook, API/schema/application code, subagent, live Docker, SSH, Pi/HIL, or operational key was used.

## Minimal fix

- Ownership preflight rejects an existing accepted-project container when `OLD_CURRENT=none` and no activation journal is active. The guard covers both `gateway` and the earlier explicit `led-control-gateway` project so a lost pointer cannot bypass the same safety boundary.
- An early ownership check runs before candidate staging, image load, Compose config/up/down, env snapshot/replacement, or activation journal creation when there is no old current.
- Diagnostic: `existing service has no verified baseline; baseline migration or registration is required before activation`.
- A valid active journal is deliberately exempt: it can own a failed/interrupted true-first-install candidate that recovery must bring down. Journal validation, snapshot hash, release verification, and project binding still precede recovery.
- Existing services with a verified current bundle keep their existing project ownership and normal activation/rollback behavior. True first install (no existing container, no current) is unchanged.

## Behavior/TDD evidence

Two new fixtures create real disposable service-state files (legacy active tag, Compose owner, image digest) and an existing site env with no current/previous/journal. They invoke the real Bash manager through the existing external-command boundary shims.

Each fixture asserts failure with the baseline migration/registration diagnostic; byte-for-byte and mode preservation of the site env and all service-state files; current/previous still absent; no journal/snapshot; no immutable candidate release; and no image load or Compose config/up/down invocation.

The prior project-handoff success fixture now includes a verified current baseline. Existing metadata deadline tests likewise establish a valid baseline first and scope the hang to the candidate, preserving their original timeout/recovery coverage rather than allowing the new earlier rejection to make them pass vacuously.

- RED against the prior manager: **2 tests, 0 pass, 2 expected failures**, **8.03 seconds**. Both unsupported legacy hosts incorrectly completed activation with exit 0 instead of required exit 1.
- Focused GREEN: **11/11 pass**, **61.57 seconds**. Includes both legacy rejection cases, verified-baseline project handoff, true-first-install failure/recovery, normal activation, metadata deadlines and previous-only rollback.
- Combined release/bundle/appliance: **183/183 pass**, **229.33 seconds**, zero failures/cancellations/skips. All six durable journal interruption/recovery phases and the true-first-install recovery/down tests passed.
- Gateway contracts: **24/24 pass**, zero failures/skips. Bash syntax, Node test syntax, and diff whitespace checks: **pass**.

Commands:

```text
node --test --test-name-pattern='legacy service without verified current' scripts/gateway-appliance-release.test.mjs
node --test --test-name-pattern='legacy|first-install|activate health-gates|hanging metadata|rollback selects' scripts/gateway-appliance-release.test.mjs
pnpm gateway:release:test
pnpm --filter @led-control/gateway test:contracts
bash -n scripts/gateway-appliance-release.sh scripts/gateway-appliance-deploy.sh scripts/gateway-appliance-build.sh
node --check scripts/gateway-appliance-release.test.mjs
git diff --check
```

## State matrix and limits

| Existing target container | Verified current | Active validated journal | Outcome |
| --- | --- | --- | --- |
| Absent | Absent | No | True first install remains allowed |
| Accepted project | Absent | No | Exit 1 before candidate/env/service mutation; migration/registration required |
| Accepted project | Present | No | Normal verified-baseline activation/rollback |
| First-install candidate | Absent | Yes | Existing journal-owned down/recovery path remains allowed |
| Foreign ownership or corrupt journal/current | Any | Any | Existing fail-closed checks remain authoritative |

This change does not invent a legacy migration or silently register an unverified image. Such hosts need a separately authorized verified-baseline migration/registration procedure before using activation. Real Docker/Pi validation remains outside this shim-only task. All previously documented dotenv/deadline/journal limitations still apply; this report supersedes the earlier implication that any legacy project could be inherited without a verified current baseline.

## Commit

Final implementation/report SHA is recorded in the completion handoff after verification.
