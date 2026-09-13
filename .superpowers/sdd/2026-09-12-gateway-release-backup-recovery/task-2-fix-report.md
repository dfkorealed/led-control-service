# Task 2 review-fix report

## Scope and review preservation

- Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`.
- Branch: `codex/p0p1-platform-gateway-release`.
- Baseline: implementation `945985e6090bf2cc79ec8f170a3a9e0c48992eb2`, report `11b382da853263365ec3d9016b341595a216e29c`.
- The complete review request received from the controller was preserved before implementation in `task-2-review.md` beside this report.
- Only the Task 2 release manager and its behavioral tests changed. Task 3 state backup, Task 4 CI/runbooks, source build/deploy interfaces, application code, API DTOs, database schema and migrations did not change.
- No subagent, actual Docker daemon, SSH/deploy, Raspberry Pi, HIL, operational key, or host-side Python/Node invocation was used by the manager.

## Four findings and fixes

### 1. Exact supported dotenv mutation and image selection

The prior line-regex writer could treat image-key-looking lines inside a single-quoted multiline secret as top-level assignments. The prior shim repeated that regex, so it could incorrectly confirm the same behavior.

`site_dotenv` now validates complete input before service/env/pointer mutation and uses the same parser for resolution and rewriting. It deliberately supports single-line assignments only, with blank/comment lines, leading assignment whitespace, unquoted values, and single/double-quoted single-line values. It rejects multiline/unclosed quoted values, unsupported non-assignment syntax such as `export`, NUL, CR/CRLF, and missing final LF. The error explicitly identifies the single-line requirement. Managed data/image values are restricted literals; no shell evaluation or variable interpolation occurs in the manager. Unrelated UTF-8 and literal shell expressions remain bytes, not executable shell code.

Managed image assignment lines are normalized to exactly one repository and one tag: first occurrence replaced, further duplicates removed, missing keys appended. All other lines and their byte contents are preserved, including Korean UTF-8 and quoted comments; original file mode is retained across atomic replacement. A multiline secret containing both image-key-looking lines is rejected with the entire original env and mode unchanged and without Compose up/down or a journal.

Preflight runs authoritative `docker compose ... config --images` and requires exactly the candidate `repository:tag` as its complete output, not merely valid YAML. The same boundary is checked again after env replacement. Health inspection obtains the running container `.Image` config digest together with health status. `healthy` requires both the verified candidate digest and healthy status before either pointer is committed. A healthy container with a different image digest triggers recovery.

The test Docker boundary uses Node `util.parseEnv` independently of the production AWK parser and models Compose shell-over-env precedence and missing-key image defaults. This avoids reproducing the original line-matcher defect. These are command-shim behavior tests, not claims that a real Docker/Compose daemon ran.

### 2. Authoritative resolver/env contract, including Task 3 handoff

`resolve_site` and `identity_preflight` establish the site data root. The `docker_cmd` boundary supplies all three coordinates explicitly for every Docker/Compose operation:

- `GATEWAY_DATA_DIR`: validated site literal, never inherited ambient shell input.
- `GATEWAY_IMAGE_REPOSITORY` and `GATEWAY_IMAGE_TAG`: exact verified release `appliance.env` coordinates, including candidate shutdown and previous-release recovery.
- Ambient `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `COMPOSE_ENV_FILES`, and `COMPOSE_PROFILES` are removed; the Compose file, project name/directory, and site env file are explicit CLI inputs.

Task 3 must preserve this resolver contract rather than parse site env with a new line regex or source/eval it:

1. There may be at most one top-level `GATEWAY_DATA_DIR`; an explicit empty/unsafe/interpolated value is rejected.
2. Absence means `/opt/led-control/data` in production. Only the sentinel-gated disposable test root maps absence to `$ROOT/data`.
3. The resolved absolute literal must pass the existing no-symlink/unsafe-component and directory permission checks. Required identity/trust paths are validated beneath that same root.
4. Site image keys are resolved as literals, then normalized to the selected verified release during activation. Missing site image defaults are `led-control-gateway:local`, but these defaults are never allowed to override a selected release at the Compose boundary.
5. Backup/restore and release operations must use the same persistent lock inode: `$ROOT/.appliance-operation.lock`, production `/opt/led-control/gateway/.appliance-operation.lock`. Never unlink/recreate the lock file.
6. This change leaves the resolver in the release manager. A later Task 3 shared-library extraction must preserve these behavior tests and the resolver/default/authority contract; this report does not claim that Task 3 already exists.

Regression tests supply malicious ambient data/image/project values, with both present and absent site data-dir keys, and inspect every relevant config/up/recovery event. A separate first-install-failure test checks that down still uses the candidate coordinates and validated site data root after the old env is restored.

### 3. Legacy project compatibility and ownership

Preflight first lists the exact `led-control-gateway` container, then inspects its Compose ownership labels without parsing Docker JSON on the host. Only `gateway` (legacy default project) and `led-control-gateway` (earlier explicit project) are accepted, and only with service `gateway-appliance` and working directory exactly equal to `$ROOT`. Foreign project, foreign service, or foreign working directory is rejected before any service/env/pointer mutation.

Existing project ownership is inherited consistently across config/up/down. New installations default to `gateway`, compatible with the prior `/opt/led-control/gateway` Compose project directory. Recovery binds the project to the journal and rechecks ownership before env/pointer restoration. It does not attempt to rename/adopt arbitrary foreign containers.

The journal now has exactly eight sorted allowlisted fields: `CANDIDATE`, `COMPOSE_PROJECT`, `ENV_MODE`, `ENV_SHA256`, `OLD_CURRENT`, `OLD_PREVIOUS`, `PHASE`, `SCHEMA`. Project is limited to the two accepted names. It remains mode 0600, strict data-only key=value, snapshot-hash protected, durable temp/fsync/rename, and journal-last commit.

### 4. Hard Docker/Compose deadlines

`timeout` is now a required host dependency and its signal/kill-after invocation is probed before the operation lock or release-directory writes. Every actual Docker call goes through one `docker_cmd` wrapper, including version checks, ownership list/inspect, Compose config, archive load, image inspection, up/down, and health/recovery inspection. The manager does not collect Docker logs; there is no unbounded logs call outside this wrapper.

| Boundary | Production wall-clock timeout | Forced kill after TERM |
| --- | ---: | ---: |
| Docker/Compose metadata, ownership/image/container inspection | 15 seconds | 5 seconds |
| Compose config/up/down, including recovery | 120 seconds | 5 seconds |
| Docker archive load | 300 seconds | 5 seconds |
| Disposable-root test equivalents | 1 second | 1 second |

Health has at most 60 inspections separated by 2-second sleeps in production (two inspections, zero delay in tests). A timed-out inspect fails promptly instead of consuming all retry slots. A candidate start timeout is a normal activation failure (exit 1) followed by recovery; a recovery timeout exits 3 and retains the journal. GNU timeout bounds the client process, not asynchronous work already accepted by the Docker daemon; recovery and the retained journal are still necessary.

Tests compile a small local C deadline shim using actual process groups, SIGTERM, SIGKILL and monotonic time. Hanging Docker shims ignore TERM and would otherwise run six seconds. Tests assert bounded manager exit, successful old-state recovery, or distinct journal-retained recovery failure. The C/Node programs belong only to the disposable test harness, not the Pi manager dependency set.

## Journal and failure matrix

| Durable phase/boundary | State that may already have changed | Required recovery result |
| --- | --- | --- |
| Preflight reject: dotenv, ownership, config selection, load, metadata deadline | Staging/runtime temporary artifacts only | Site bytes/mode and pointers unchanged; no service up/down or journal |
| `prepared` | Private snapshot and journal | Restore exact old env/pointers, reapply verified old release and require matching digest/healthy |
| `env_switched` | Site image assignments | Same old-state recovery |
| `service_started` | Candidate service | Same old-state recovery |
| `healthy` | Candidate service proved healthy/digest-matched | Still recover old state if commit interrupted |
| `previous_switched` | Previous pointer | Restore old previous and old current, require old service health/digest |
| `current_switched` | Both pointers | Restore old previous and old current, require old service health/digest |
| First install failure, no old current | Candidate may exist | Restore site env, keep pointers absent, down candidate using journal-bound project and authoritative candidate/data env |
| Candidate up timeout | Candidate start uncertain | Bounded old-release reapply and matching health/digest; exit 1, journal removed only after proven recovery |
| First-install recovery down timeout | Shutdown uncertain | Exit 3; journal retained; no success claim |
| Corrupt snapshot/journal or foreign recovery ownership | Cannot establish safe authority | Exit 3, retained journal; do not evaluate untrusted text or operate foreign service |

All six phase-interruption tests kill the manager after the durable phase boundary and then invoke it with deliberately invalid new input, proving recovery happens before the new input is considered. Existing previous-only rollback, failure recovery retry, shared kernel flock, immutable directory, bundle closure/env/policy/platform/test-mode and bundle-only upload tests remain in the combined suite.

## TDD and verification evidence

The initial new focused tests ran against the unmodified manager after replacing the misleading shim parser: **15 tests, 1 pass, 14 expected failures**, 77.33 seconds. All four findings were reproduced; the already-working missing-key case was the one pass.

The first implementation run was **15 tests, 14 pass, 1 fail**: a timed-out candidate start recovered correctly but exposed exit 124 instead of the manager normal failure status 1. The failing test drove explicit failure normalization. Final focused verification, including six additional deadline/authority coverage cases, was **21/21 pass**, 85.82 seconds. Whole-manager deadline assertions include harness/process startup allowance, while each hanging Docker subprocess has the 1+1 second test deadline above.

Commands:

```text
node --test --test-name-pattern='review ' scripts/gateway-appliance-release.test.mjs
pnpm gateway:release:test
pnpm --filter @led-control/gateway test:contracts
bash -n scripts/gateway-appliance-release.sh scripts/gateway-appliance-deploy.sh scripts/gateway-appliance-build.sh
node --check scripts/gateway-appliance-release.test.mjs
git diff --check
```

- Combined release/bundle/appliance result: **181/181 pass**, zero failures/cancellations/skips, **197.67 seconds**. All 21 review regression tests and all six durable journal interruption phases passed in this final combined run.
- Gateway contracts: **24/24 pass**, no failures/skips.
- Bash syntax, Node test syntax, diff whitespace check: pass, rerun before commit.
- No application TypeScript changed; the requested scope used Gateway contracts and shell/Node static checks rather than unrelated application typechecks.

## Limits and handoff concerns

- Real Pi/Compose/Docker/Pi filesystem behavior remains an explicitly separate integration/HIL gate; only real temp files, symlinks, locks, fsync calls and process/deadline shims were exercised here.
- Unsupported site dotenv syntax is deliberately fail-closed, not automatically rewritten. Operators must convert multiline/export/CRLF/missing-final-LF input outside activation, with secrets preserved; the manager does not guess.
- A prior seven-field journal from the earlier, unshipped manager is rejected. Finish recovery with the matching old manager before upgrading a host that somehow has such a pending journal; no unsafe inferred project is inserted.
- The operation lock coordinates compliant release/state writers, not unrelated manual Docker commands or external site-env writers. Administrative operations must honor the shared lock.
- Deadlines can kill the Docker client while daemon work is still pending. Such failures still require recovery and may retain a journal for operator follow-up; no client timeout is reported as successful activation.
- No rollback of database or identity state is added; rollback remains previous verified release only. Task 3 state backup/restore remains out of scope.

## Commits

- Implementation: `0f4d5068d131080e3fd2f01146b063f2b5fd434e` — `fix(gateway): harden activation environment and deadlines`.
- Review/report commit SHA is supplied in the completion handoff; this document cannot contain its own final commit hash.
