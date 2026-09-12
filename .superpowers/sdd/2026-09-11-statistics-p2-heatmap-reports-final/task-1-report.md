# Task 1: Shared P2 Contracts and Report Document Model

## Implementation

- Added `energy-p2-contracts.ts` with strict Zod contracts and inferred types for inclusive `energy|brightness` heatmap query/response, report request/job/list/download, and the immutable report document model.
- Heatmap queries and responses support only `site|fixture|floor|group`, enforce ordered 168 cells, preserve numeric zero versus `null` data, and limit ranges to 92 inclusive dates.
- Report requests have exactly `from`, `to`, `scope`, `identityId`, and `format`; no section selection is accepted.
- The document model has strict metadata/value/table/heatmap/notes section variants, runtime row alignment and cell-order validation, and a distinct fingerprint input excluding `contentFingerprint`.
- Added root and `./energy-p2-contracts` ESM/CommonJS exports plus packed-package module smoke coverage.

## RED / GREEN Evidence

RED command: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts`

Result: failed as expected before production implementation because Vitest could not resolve `./energy-p2-contracts` from the new consumer-contract test.

GREEN command: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts`

Result: passed — 1 test file, 8 tests.

## Verification

Commands passed:

- `pnpm --filter @led-control/shared test`
- `pnpm --filter @led-control/shared typecheck`
- `pnpm --filter @led-control/shared build`
- `git diff --check`

The package suite passed 14 test files and 194 tests, including packed ESM/CommonJS subpath import smoke tests.

## Files Changed

- `packages/shared/src/energy-p2-contracts.ts`
- `packages/shared/src/energy-p2-contracts.test.ts`
- `packages/shared/src/index.ts`
- `packages/shared/package.json`
- `packages/shared/tsconfig.esm.json`
- `packages/shared/src/package-exports.test.ts`
- `.superpowers/sdd/2026-09-11-statistics-p2-heatmap-reports-final/task-1-report.md`

## Self-Review

- Confirmed outer API/document objects are strict and section variants are discriminated by `kind`.
- Confirmed document order is represented by arrays and the canonical fingerprint input excludes `contentFingerprint`.
- Confirmed status combinations cannot expose a download-ready state for a non-completed job.
- Confirmed no P2-C contract was introduced and report requests cannot select sections.
- Confirmed the package archive contains executable ESM declarations/code and CommonJS code for the new subpath.

## Concerns

No blocker. SHA-256 generation intentionally belongs to the Task 4 document builder; this shared package only defines and validates the canonical input it must hash.

## Fix Round 1

### Changed Behavior

All numeric values that can enter a heatmap or an immutable fingerprint input must now be finite. `Infinity` is rejected before it can be serialized as `null` by canonical JSON and diverge from a renderer's input.

### Files

- `packages/shared/src/energy-p2-contracts.ts`
- `packages/shared/src/energy-p2-contracts.test.ts`

### RED / GREEN Evidence

RED command: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts`

RED output: 10 tests ran; the two new regression cases failed because `safeParse(...Infinity...).success` was `true` for a heatmap response and a fingerprinted document.

GREEN command: `pnpm --filter @led-control/shared test -- energy-p2-contracts.test.ts`

GREEN output: 1 test file and all 10 tests passed after applying `.finite()` to the heatmap cell, report scalar, and report heatmap cell number schemas.

### Final Verification

- `pnpm --filter @led-control/shared test` — 14 files, 196 tests passed.
- `pnpm --filter @led-control/shared typecheck` — passed.
- `pnpm --filter @led-control/shared build` — passed.
- `git diff --check` — passed.
