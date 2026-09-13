# Task 3 — encrypted state backup and transactional restore

## Scope and outcome

Implemented the Task 3 host-side `backup`, `verify`, `drill`, and `restore` CLI in the designated gateway-release worktree. No runtime persistence schema, DB, firmware, menu, CI, runbook, operational identity, Docker daemon, Pi or HIL changes/runs were made. Task 4 documentation/CI integration remains separate.

Review base: `bc8c595731208add7a200877145ac3a961bc052b`. The implementation and this report are delivered together in the Task 3 feature commit; its SHA is provided in the final handoff.

Production is shell/coreutils/GNU tar/OpenSSL plus the existing trusted Task 2 shell utilities; Docker and util-linux flock are used only for live operations. Node and C-compiled compatibility boundaries exist only in disposable tests. The executable release manager is not sourced: both CLIs source a function-only `gateway-appliance-common.sh`. The deploy transport now includes this trusted library alongside the manager and bundle.

## CLI

```text
scripts/gateway-appliance-state.sh backup /absolute/new-backup --recipient /absolute/recipient.crt --policy-sha256 SHA
scripts/gateway-appliance-state.sh verify /absolute/backup --recipient /absolute/recipient.crt --key /absolute/recipient.key
scripts/gateway-appliance-state.sh drill /absolute/backup --recipient /absolute/recipient.crt --key /absolute/recipient.key
scripts/gateway-appliance-state.sh restore /absolute/backup --recipient /absolute/recipient.crt --key /absolute/recipient.key --policy-sha256 SHA
```

`backup`/`restore` use production root `/opt/led-control/gateway`. Tests may add `--test-root DIR`, but only a physical safe root containing the exact `gateway-release-test/v1` disposable sentinel is accepted. `verify`/`drill` reject live-root/policy switches. `backup` accepts no private-key argument. The advertised profile accepts RSA recipient certificates only. Paths are absolute, physical, and restricted to the shared safe-path alphabet. Backup cannot overwrite an existing path or write inside the appliance/data root.

Package aliases are `pnpm gateway:state -- ...` and `pnpm gateway:state:test`.

Exit statuses: `0` success, `1` rejected input/operation failure with successful recovery where required, `2` CLI misuse, `3` failed or unresolved recovery/cleanup requiring attention, `4` shared-lock contention, `130` INT, and `143` TERM (recovery failure takes precedence as `3`).

## Exact encrypted artifact

New immutable directory, mode `0550`, contains exactly three regular single-link files, each `0440`:

```text
backup.env
checksums.sha256
state.cms
```

`backup.env` is printable ASCII with one final LF and exactly these eight sorted assignments, no duplicate or unknown keys:

```text
CIPHERTEXT=state.cms
CIPHERTEXT_SHA256=<64 lowercase hex>
CIPHERTEXT_SIZE=<positive decimal byte count>
CREATED_AT=<UTC YYYY-MM-DDTHH:MM:SSZ>
ENCRYPTION=openssl-cms-aes-256-cbc-rsa/v1
RECIPIENT_SHA256=<SHA-256 of recipient certificate DER>
RELEASE_ID=<verified current immutable release ID>
SCHEMA=led-control-gateway-backup/v1
```

`checksums.sha256` has exactly two sorted `sha256sum`-style lines, for `backup.env` and `state.cms`. Verification checks outer closure, file types/link counts, metadata, size/hash, checksums and supplied recipient fingerprint, then verifies a private copied ciphertext/metadata snapshot before decryption. Extra files/directories, symlinks, hardlinks, missing entries, malformed metadata and wrong recipient/key are rejected.

Encryption streams USTAR bytes into `openssl cms -encrypt -binary -aes-256-cbc -outform DER -stream`; `state.cms` is OpenSSL's streamed binary CMS encoding, not a plaintext tar. Decryption is streamed directly into the strict parser. No plaintext archive file is created at any point.

The trusted files-from list places the `-C` argument on the following line, a supported GNU tar form ([GNU tar manual](https://www.gnu.org/software/tar/manual/tar.html)).

## Inner manifest and archive validation

The first USTAR member is the regular `0600` `manifest.state`. Its first line is:

```text
led-control-gateway-state/v1|<source release ID>|<created UTC>
```

All subsequent lines are C-locale path-sorted records:

```text
relative/path|f/d/l|four-digit-octal-mode|uid|gid|size|sha256-or--|link-target-or--
```

Every directory, regular file, and supported link in exactly `factory-trust`, `gateway`, `identity`, and `mesh` is recorded. Directories and symlinks have size `0` and hash `-`; files have their actual size/hash and target `-`. Numeric ownership, modes, bytes, all generation directories, outbox/manifest pairs and automation files round-trip unchanged. There is no JSON rewrite, state-schema migration, or current-generation-only filtering.

Entry paths must be unambiguous ASCII `[A-Za-z0-9_+./-]`, at most 100 bytes, with no empty, `.` or `..` components. This deliberately excludes spaces, newlines, non-ASCII names, long paths and tar extension records. The parser reads exact 512-byte headers without Bash NUL truncation, verifies checksum/USTAR version, octal fields, entry types, sorted uniqueness, data lengths, zero padding, two zero end records and no trailing nonzero archive. It rejects traversal, absolute names, hardlinks, devices, FIFO, sockets, unknown roots and extension formats before the corresponding filesystem operation. Directory parents may not be symlinks. It extracts only into a `0700` parent, then independently walks/hashes actual files and byte-compares a regenerated manifest, detecting extra/missing entries and size/hash/mode/ownership differences.

Only `identity/device/current` and `identity/mqtt/current` may be symlinks, each to its own existing `generations/<id>` directory. Other state/outbox paths must be regular files/directories. Every identity directory is `0750`; every identity `*.key` is a nonempty single-link regular `0600` file. Current device identity requires `device.crt`, `device.key`, `api-ca.crt`, `mqtt-ca.crt`; current MQTT identity requires `gateway.crt`, `gateway.key`, `mqtt-ca.crt`. Required files and `factory-trust/api-ca.crt` are nonempty regular files. Public CA certificates are not assigned private-key permissions. Group/world-writable regular state or directories and special permission bits are rejected.

## Lock, runtime, and lifecycle

Both managers use the same never-unlinked `.appliance-operation.lock` inode and kernel exclusive nonblocking flock. The library has an executable contract test proving sourcing changes no shell options, traps, positional parameters or caller globals. The exact existing single-line dotenv resolver determines optional `GATEWAY_DATA_DIR`, with production default `/opt/led-control/data` and sentinel-test default `$ROOT/data`; no env/journal is sourced or evaluated. Tests cover absent/custom quoted dotenv values and hostile ambient data/image coordinates. Authoritative Docker environment/Compose project ownership and bounded deadlines are shared with Task 2.

Backup verifies the current bundle/policy, physical roots, identity, image/Compose resolution and healthy baseline, journals before stopping the service, reads/hashes/encrypts state while quiesced, then starts the same verified release and requires healthy before publishing immutable output. Stop/encryption/restart failures clean temporary output and restart the original state; failed recovery is distinct and retains a journal.

Verify never acquires the appliance lock or reads/writes live data, pointers, site env, journals or Docker. Drill performs a second actual CMS decryption and independent extraction/validation and compares regenerated manifests. Success, validation failure, second-decryption truncation, and TERM tests prove plaintext cleanup and no live/runtime access.

Restore normally completes two full disposable decrypt/validate passes before every Docker/live boundary, then takes the lock, checks unchanged outer closure, verified current bundle/site/runtime/identity and healthy baseline, and copies validated roots into a same-filesystem `0700` stage. Existing journals take precedence over new inputs: only recovery is allowed before considering the new request. State operations fail closed on pending activation journals; activation fails closed on pending state journals.

## Durable journal and recovery

`$ROOT/.state.journal` is a `0600` single-link regular ASCII file with exactly nine sorted fields:

```text
COMPOSE_PROJECT=<gateway or led-control-gateway>
DATA_DIR=<validated physical site data directory>
ENV_SHA256=<unchanged site dotenv SHA-256>
OPERATION=<backup or restore>
PHASE=<allowlisted phase>
RELEASE_ID=<unchanged verified current ID>
SCHEMA=gateway-state-operation/v1
STAGE=<none for backup; DATA_DIR/.state-restore.NONCE for restore>
WORKSPACE=<physical TMPDIR/.gateway-state.NONCE>
```

Every journal update uses a private temp file, mode setting, `sync -f`, atomic rename and `sync -f` of the root. Restore creates `new`, `old`, and `discard` stage directories on the live filesystem; staged data and root renames are filesystem-synced before advancing phases.

Backup phases: `prepared`, `committed`.

Restore phases: `prepared`, `stopped`, `old_gateway`, `new_gateway`, `old_mesh`, `new_mesh`, `old_identity`, `new_identity`, `old_factory-trust`, `new_factory-trust`, then `committed`; recovery may write `rolled_back`.

Each of the four roots is renamed into `old`, then the matching validated `new` root is renamed live. Recovery uses validated stage/live presence as well as journal phase, so a rename followed by interruption before phase advancement is handled. Candidate live roots are quarantined into `discard`, every prior root is put back, `rolled_back` is durably recorded, then original service health is required. `prepared` precedes all swaps; a stop failure therefore restarts untouched state without requiring another successful stop. Failed recovery retains the journal and rollback/live evidence. The `committed` decision is durable before old-copy deletion, so interrupted commit cleanup finishes the accepted restore rather than losing both old and new state. A later valid recovery also removes the recorded previous plaintext workspace; no arbitrary/broad/symlink journal path is recursively deleted.

EXIT/INT/TERM cleanup removes this invocation's extracted plaintext and encrypted output staging. SIGKILL/power loss cannot execute traps: transaction-bound workspaces are remembered for next-invocation recovery. A kill before the first durable transaction journal, or during non-mutating verify/drill, can leave only restricted disposable staging and requires operator temp-directory cleanup; no live mutation has occurred in those windows.

## TDD and verification evidence

- Initial state RED: 47 tests, 46 expected missing-CLI failures and one initially vacuous library-source assertion. The assertion was corrected and separately demonstrated RED (1/1 failure for missing library) before extraction.
- Initial implementation normal-path probes caught the outer-key numeric suffix and macOS tar argument/symlink-mode differences; real USTAR/CMS round-trip then passed.
- Behavior RED→GREEN fixed restore stop-failure recovery, next-invocation cleanup of SIGKILL workspace, and rejection of EC certificates under the advertised RSA profile.
- Additional real behavior checks cover missing/empty key/cert, unsafe outer/live links/FIFO, TERM cleanup, default/custom/ambient data resolver, backup recovery failure, second-drill extraction truncation and cross-journal exclusion.
- Existing Task 2 suite after library extraction: **183/183 pass**, 222.05 seconds.
- Gateway Docker/Compose contracts: **24/24 pass**; old plaintext-tar runbook test replaced by exact four-mount/CLI contract, with real encrypted behavior in the state suite.
- Final focused state: **64/64 pass**, 287.14 seconds, zero failures/cancellations/skips.
- Final combined release/bundle/state/appliance: **247/247 pass**, 268.49 seconds, zero failures/cancellations/skips. This includes all existing 183 Task 2 tests and all 64 state tests after final changes.
- Final `pnpm --filter @led-control/gateway test:contracts`: **24/24 pass**; Bash/Node syntax and staged diff-check also pass. The installed pnpm emitted an existing root `pnpm`-field compatibility warning; no dependency or lockfile was changed.

Commands:

```text
node --test scripts/gateway-appliance-state.test.mjs
node --test scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs scripts/gateway-appliance-scripts.test.mjs
node --test apps/gateway/docker/*.test.mjs
bash -n scripts/gateway-appliance-state.sh scripts/gateway-appliance-common.sh scripts/gateway-appliance-release.sh scripts/gateway-appliance-deploy.sh
node --check scripts/gateway-appliance-state.test.mjs
node --check scripts/gateway-appliance-fixture.mjs
node --check scripts/gateway-appliance-release.test.mjs
node --check apps/gateway/docker/compose-contract.test.mjs
git diff --check
```

## Limits and review/rollout gates

- Tests use actual ephemeral RSA recipients, actual OpenSSL CMS, actual files/symlinks/renames and kernel flock. No recipient private key/certificate body or decrypted payload is logged, committed or kept beyond disposable test fixtures.
- This host is macOS: archive production used real BSD/libarchive USTAR bytes and a separately implemented test USTAR writer against the production byte validator. GNU-dd full-block/count-bytes and Linux symlink `0777` semantics have explicit test-only C/shell boundaries; sync/mv/Compose have Task 2-compatible test boundaries. This is not GNU/Linux/Pi durability or actual Docker/BlueZ health evidence. GNU tar/coreutils, OpenSSL 3 and util-linux remain production prerequisites and need Task 4/Linux gate plus separately approved operational/HIL validation.
- CMS encryption provides recipient confidentiality; outer hashes/inner manifest detect corruption and bind the documented closure but are not a producer signature or an authenticated backup provenance service. Operators must obtain artifacts/recipient certificates through a trusted channel.
- Restoring uses the current verified healthy release, not the source backup image, and does not restore image pointers, `.env.appliance`, external secrets or database state. Existing invalid identity or unhealthy-baseline repair remains an explicit operator/review concern. Cross-release state compatibility is an operational gate; no migration is invented.
- ACLs, xattrs, mtimes, arbitrary symlinks, hardlinks, non-ASCII/long names and tar extension formats are not part of this v1 state profile. UID/GID preservation requires appropriate host privileges. Non-journaled SIGKILL staging cleanup requires operator attention as described above.
- Task 4 must replace the old runbook's plaintext backup instructions, install/distribute the state manager and trusted common library, wire CI, and document recipient custody/recovery and rollout gates. No deployment or merge is claimed by this task.
