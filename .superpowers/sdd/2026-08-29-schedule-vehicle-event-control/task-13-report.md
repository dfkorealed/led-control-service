# Task 13 Report: Gateway Vehicle Runtime and Durable Telemetry

Status: DONE

Commit: self (`feat(gateway): execute vehicle sensor events`)

## Delivered

- Added normalized `detected|cleared|current-state` vehicle input handling with source OR, no High timeout, last-Low monotonic hold, retrigger cancellation, trusted-UTC restart recovery, maximum overlapping event brightness and existing manual/schedule/base arbitration.
- Added lifecycle and terminal action telemetry for `schedule_started`, `schedule_ended`, `vehicle_detected`, `event_started`, `event_extended`, `event_ended`, `action_result` and `telemetry_gap`.
- Added one atomic JSON outbox commit for event ID, sequence, exact payload and canonical hash. The complete pretty-printed file, including metadata and reserved gap slots, is capped at 64 MiB.
- Added unpublished `event_extended` replacement, bounded gap accumulation under capacity, commit-uncertain rollback/fencing, restart recovery and Task 12 `telemetryGap` handoff.
- Added exact MQTT QoS 1 JSON publishing, generation-safe reconnect retry, exact application ACK deletion, hash-conflict preservation and publisher shutdown drain before MQTT close.
- Added the Gateway certificate ACL read rule for execution-ingested ACKs while retaining the ACK publish denial.

## Verification

- Focused Gateway: 7 files, 135/135 passed.
- Full Gateway: 53 files, 448/448 passed.
- Gateway Docker contracts: 17/17 passed.
- Docker/mTLS Mosquitto persistence and ACL: 2/2 passed.
- Shared: 7 files, 74/74 passed.
- Shared typecheck, lint and build: passed.
- Gateway typecheck, lint and build: passed.
- `git diff --check`: passed after final status/report updates.

## Remaining Concerns

- Task 14 must bind actual ESP32-H2 Sensor Server/vendor vehicle event models to `recordVehicleSensorInput`; no Raspberry Pi/ESP32-H2 RF HIL or production deployment was run in Task 13.
- Docker Mosquitto validates certificate ACL and MQTT behavior, not field hardware timing, BlueZ delivery or long-running flash/storage wear.

## Fix Round 1

Status: DONE

Commit: self (`fix(gateway): harden automation telemetry handoffs`)

### Delivered

- Migrated automation state to schema v4. Lifecycle, manual/automatic terminal transitions and stable `pendingTelemetryHandoffs` now share one atomic state commit; each handoff stores exact records and a canonical hash.
- Added a serialized coordinator that replays state-only, outbox-committed and state-cleared crash boundaries. Outbox acceptance receipts deduplicate replay even if an execution record was application-ACKed before state clear; records otherwise remain until exact event ID/sequence/hash ACK.
- Replaced per-record append with one atomic/idempotent `appendBatch`. A batch is fully stored or its exact record set is returned as dropped. Grouped `action_result` counts one payload regardless of fixture-result count.
- Added an 8 KiB gap journal with two checksummed 4 KiB blocks preallocated at startup. Capacity and regular-storage failures update the alternate block by positional fixed-size write and file `fsync`, retaining aggregate range/count and source handoff identity without allocating new blocks.
- Added a separate regular-outbox-size rewrite reserve. The strict 64 MiB cap still includes every regular JSON record, receipt and metadata; the reserve and fixed journal are explicit sidecars.
- Isolated outbox JSON corruption, reserve `ENOSPC` and regular write failure as telemetry degraded mode. Scheduler startup and local RF continue, while exact state handoffs or the gap journal retain the telemetry boundary.
- Gave persisted state gaps stable identity/provenance and cumulative idempotent `recordGap` handling so an outbox commit followed by a state-clear crash cannot double-count.
- Changed vehicle/manual recovery deadline maps to copy-on-write plans installed only after successful state commit. Definite failure and commit-uncertain rollback preserve current-process monotonic expiry.

### Verification

- Gateway focused regression: 6 files, 119/119 tests passed.
- Gateway full regression: 54 files, 464/464 tests passed.
- Shared full regression: 7 files, 74/74 tests passed.
- Docker contract suite: 17/17 tests passed.
- Required Mosquitto integration: 2/2 tests passed.
- Shared and Gateway typecheck, lint and production build passed; `git diff --check` passed.

### Remaining Concerns

- Raspberry Pi filesystem exhaustion, power-cut behavior and flash wear were not measured on hardware. The fault suite injects `ENOSPC`, corruption and commit uncertainty against real local files.
- ESP32-H2 Sensor Client/vendor event input and Raspberry Pi/BlueZ RF HIL remain outside Task 13 fix round 1.

## Fix Round 2

Status: DONE

Commit: self (`fix(gateway): share automation storage headroom`)

### Delivered

- Replaced per-outbox reserve churn with one `StorageHeadroomManager` shared by automation state and telemetry outbox. The 64 MiB reserve is preallocated once; normal commits perform no reserve I/O.
- Restricted reserve release/retry to actual top-level `ENOSPC`. Replenishment runs only as a background task after free space is verified at twice the reserve size, with counters for normal writes, ENOSPC, retry, release, allocation bytes and replenish failures.
- Continued schedule, vehicle and manual control from in-memory committed state when shared-headroom state retry remains full. Exact newly-created pending handoffs move to the preallocated in-place journal and are removed from the memory queue so they cannot also become regular records.
- Added `automation_state_durability_degraded` health and full in-memory snapshot reconciliation on a later successful write. Journal-only recovery now wakes the publisher so `telemetry_gap` is surfaced without waiting for reconnect.
- Preserved atomic commit uncertainty through headroom and replenish failures. Outbox reconciles exact visible previous/next targets, fences unknown visibility until restart, and never converts typed uncertainty into a dropped gap. State rollback failure likewise retains the original atomic cause and reconciles the visible target.

### Verification

- Gateway focused regression: 8 files, 130/130 tests passed.
- Gateway full regression: 56 files, 475/475 tests passed.
- Shared full regression: 7 files, 74/74 tests passed.
- Docker contract suite: 17/17 tests passed.
- Required Mosquitto integration: 2/2 tests passed.
- Shared and Gateway typecheck, lint and production build passed; `git diff --check` passed.

### Remaining Concerns

- Raspberry Pi filesystem exhaustion, sudden power loss and flash wear remain unmeasured on hardware; the test suite uses real temp files plus injected `ENOSPC`, rename/fsync uncertainty and replenish failures.
- ESP32-H2 Sensor Client/vendor event input and Raspberry Pi/BlueZ RF HIL remain outside Task 13 fix round 2.

## Fix Round 3

Status: DONE

Commit: self (`fix(gateway): require durable telemetry cleanup`)

### Delivered

- Split automation-state mutation into explicit `updateControlState` and `updateDurable` APIs. Every mutation result exposes `durable|memory_only`; only schedule, vehicle and manual local-control transitions can use memory-only progress.
- Made persisted telemetry gap creation, exact handoff completion and gap clear durable-required. Exhausted `ENOSPC` leaves both in-memory and on-disk sources pending, and commit uncertainty also preserves the current process source until a later confirmed full-state write.
- Changed coordinator ordering to append idempotently, durably clear the source, then release the acceptance receipt. A non-durable clear stops the current batch and schedules the same stable handoff with 1-second to 30-second bounded exponential backoff.
- Retained source receipts across failed cleanup and crash/restart. Replayed handoff IDs resolve to the original event ID, sequence and report payload hash without duplicate records or gap inflation; recovery releases the receipt only after durable source clear.
- Connected cleanup retry errors and shutdown timer cancellation to the production Gateway lifecycle, and routed config-triggered gap handling through the same coordinator.

### TDD Evidence

- Added RED/GREEN coverage for outbox acceptance followed by state-clear `ENOSPC`, memory/disk pending preservation, crash/restart exact identity, disk recovery clear-before-release, bounded backoff, gap cleanup, retry starvation, commit-uncertain in-memory invariance and full-disk local RF continuation.

### Verification

- Gateway focused regression: 8 files, 136/136 tests passed.
- Gateway full regression: 56 files, 481/481 tests passed.
- Shared full regression: 7 files, 74/74 tests passed.
- Docker contract suite: 17/17 tests passed.
- Required Mosquitto integration: 2/2 tests passed.
- Shared and Gateway typecheck, lint and production build passed; `git diff --check` passed.

### Remaining Concerns

- Raspberry Pi filesystem exhaustion, sudden power loss and flash wear remain unmeasured on hardware; automated tests use real temp files with injected `ENOSPC`, rename/fsync uncertainty and restart boundaries.
- ESP32-H2 Sensor Client/vendor event input and Raspberry Pi/BlueZ RF HIL remain outside Task 13 fix round 3.

## Fix Round 4

Status: DONE_WITH_CONCERNS

Commit: self (`fix(gateway): retain initial telemetry gaps`)

### Delivered

- Made first-gap creation a telemetry acceptance boundary. The state store fixes the cumulative gap identity/count before writing state; a definite state `ENOSPC` writes that exact source to the preallocated fixed journal and reports success only after journal `fsync` succeeds.
- Retained state+journal failures as one bounded in-memory cumulative source instead of an unbounded event list. New drops merge their first/last timestamps and count into the same identity, set `automation_state_durability_degraded`, and return control so local RF continues while coordinator retry uses the existing 1-second to 30-second backoff.
- Mirrored a journal-accepted source into process state so later full-disk drops continue from the accepted cumulative count rather than stale disk state. The fixed journal now keeps one dedicated cumulative source receipt in addition to the last general source receipt, preventing interleaved handoffs from inflating an older state replay.
- Imported both bounded journal receipts into the outbox, treated lower cumulative state replay as an idempotent no-op, and retained clear-before-release ordering. Restart and repeated recovery converge on one `telemetry_gap` event/count while exact execution event ID, sequence, hash and application-ACK behavior remain unchanged.
- Preserved `AtomicJsonCommitUncertainError` taxonomy: an `ENOSPC` nested inside commit uncertainty is retained for retry and is never reclassified as fixed-journal acceptance. A retry that first creates outbox work wakes the production publisher, and a transient outbox recovery failure re-arms the bounded backoff instead of abandoning the journal source.

### TDD Evidence

- Verified RED failures before implementation for first state-gap write `ENOSPC`, state+journal dual failure, cumulative post-fallback drops, restart with stale state, interleaved journal source replay, commit uncertainty, retry publisher wake and transient outbox recovery retry continuity.
- GREEN coverage uses real temp state/outbox/journal files with injected state and journal faults. It asserts stable identity, exact counts, one bounded retained source, explicit degraded health, no duplicate event after restart and exact-once cumulative outbox merge.

### Verification

- Gateway Task 13 focused regression: 8 files, 161/161 tests passed.
- Gateway full regression: 56 files, 488/488 tests passed.
- Shared full regression: 7 files, 74/74 tests passed.
- Docker contract suite: 17/17 tests passed.
- Required Docker/mTLS Mosquitto integration: 2/2 tests passed.
- Shared and Gateway typecheck, lint and production build passed; `git diff --check` passed.

### Remaining Concerns

- Raspberry Pi filesystem exhaustion, sudden power loss, fixed-block durability and flash wear remain unmeasured on hardware; automated tests inject `ENOSPC`, journal I/O failure, commit uncertainty, restart and interleaving against local files.
- ESP32-H2 Sensor Client/vendor event input and Raspberry Pi/BlueZ RF HIL remain outside Task 13 fix round 4.

## Fix Round 5

Status: DONE_WITH_CONCERNS

Commit: self (`fix(gateway): converge telemetry gap baselines`)

### Delivered

- Added a fixed-journal accepted baseline with the durable outbox acceptance handoff ID and records hash. Journal reimport now applies only `aggregate droppedCount - accepted baseline`; bounded last/cumulative source receipts remain replay identities and no longer drive aggregate delta arithmetic.
- Kept one stable aggregate handoff ID until journal clear. An outbox commit followed by failed or uncertain baseline persistence can therefore recover the durable cumulative receipt after restart even when a later general source replaces the journal's bounded source metadata.
- Ordered recovery as outbox cumulative acceptance, in-place baseline commit, then compare-and-clear. Baseline and clear uncertainty converge for either previous or next visible journal block without changing the pending `telemetry_gap` event ID, sequence or final canonical payload hash.
- Preserved the two preallocated 4 KiB blocks, fixed inode/block allocation and bounded source metadata. Also retained tombstone generation after clear so a post-clear source is newer than the durable null block rather than disappearing on restart.
- Preserved cumulative state-source bootstrap, exact source replay receipts, RF independence, application-ACK retention and the existing 64 MiB regular outbox/headroom contracts.

### TDD Evidence

- Reproduced RED with cumulative `C=5`, general `A=1`, successful import, failed clear, replacement `B=1`: the old implementation emitted count 8.
- GREEN covers exact count 7, crash/restart identity convergence, accepted-baseline and clear commit uncertainty with both previous/next blocks visible, and 32 repeated source replacements with unchanged 8 KiB inode/block allocation.

### Verification

- Gateway Task 13 focused regression: 8 files, 175/175 tests passed.
- Gateway full regression: 56 files, 494/494 tests passed.
- Shared full regression: 7 files, 74/74 tests passed.
- Docker contract suite: 17/17 tests passed.
- Required Docker/mTLS Mosquitto integration: 2/2 tests passed.
- Shared and Gateway typecheck, lint and production build passed; `git diff --check` passed.

### Remaining Concerns

- Raspberry Pi filesystem exhaustion, sudden power loss, fixed-block durability and flash wear remain unmeasured on hardware; automated tests use local files and injected previous/next visibility at outbox, baseline and clear boundaries.
- ESP32-H2 Sensor Client/vendor event input and Raspberry Pi/BlueZ RF HIL remain outside Task 13 fix round 5.
