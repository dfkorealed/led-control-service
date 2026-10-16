# BIO legacy registration native-control fix

> Execute inline with superpowers:executing-plans; user requires solo work and minimal directly relevant tests.

**Goal:** Apply the user's existing L006 100%/5s self-control rule without re-registering or modifying identity/default brightness/authentication.
**Spec:** ../specs/2026-10-15-bio-self-sensing-control-design.md
**Architecture:** Resolve current independently qualified source authority first. Strictly parse its sensor fingerprint and compare firmware/physical mapping; optional persisted legacy fingerprint is an additional constraint, not the sole source of truth. Keep all readback/durable ownership/USB/lease guards.

## Evidence and scope

- Actual desired43/applied42 REJECTED `bio_self_firmware_unsupported`; legacy L006 mapping lacks fingerprint; no native journal exists, so native SET never started.
- New registrations have fingerprint. Current commissioning authority already binds an independently observed fingerprint to exact native UUID/address/network, current health and server-acknowledged capability.
- Work on `codex/fix-native-legacy-fingerprint-20261016`; preserve main dirty AGENTS/status notes.
- User approved new encrypted backup, bounded Gateway interruption/deployment and exact current rule application. No waterproof testing, broker/API restart, DB migration or identity rewrite.

## Review focus

- Missing legacy fingerprint must not become inferred support from firmware text alone.
- Explicit mapping mismatch/unknown hardware must fail before native SET.
- Restoring a previously qualified legacy owner must retain independent release identity checks.
- Connection/mapping/lease changes after resolve must still revoke writes.
- Partial native journals remain protected; no blind retries or old backup restoration.

## Task 1 — production resolver compatibility

- [x] Add failing legacy mapping activation/restore regression to `apps/gateway/src/bio/bio-self-sensor-port.test.ts`; assert independent authority missing/invalid/conflicting firmware/hardware never permits settings.
- [x] Run focused file and observe legacy-specific RED (1 failed/9 passed, exact firmware error).
- [x] Update `bio-self-sensor-port.ts`: derive strict supported fingerprint from qualified binding, compare optional mapping fingerprint and existing firmware string, retain beforeWrite fencing.
- [x] Run directly related resolver/source/runtime tests (52/52) and production lifecycle/path tests (37/37), Gateway typecheck/build exit0; solo whole-diff review found no new C/I. No independent agent used per user instruction; no full suite repetition.
- [ ] Update control menu/lesson/status and commit; merge main preserving user changes.

## Task 2 — approved deployment and exact rule verification

- [ ] Build/verify new immutable ARM64 bundle for committed source; retain prior canonical release-infrastructure evidence (infrastructure unchanged).
- [ ] Fresh exact runtime/USB/journal/rule preflight; encrypted three-root backup and off-device verification before replacing current container.
- [ ] Deploy with unchanged environment/security/mounts/auth/IDs; keep old container stopped and retained.
- [ ] Verify actual latest rule/native full GET readback and matching server/Gateway APPLIED hash; no movement or waterproof test.
- [ ] Record actual result and limitations, merge final docs, leave UI ready.
