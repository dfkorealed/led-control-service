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
