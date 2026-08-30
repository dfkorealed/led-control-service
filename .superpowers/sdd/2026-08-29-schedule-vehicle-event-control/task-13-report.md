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
