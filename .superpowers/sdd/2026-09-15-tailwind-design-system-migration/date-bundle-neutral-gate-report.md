# Date bundle neutral gate report — review round 1

## Findings addressed

The first neutral gate forced `moduleSideEffects: false`, used a barrel-side
live-reference negative control, and put application DatePicker retention
behind an environment flag. Those choices could hide production tree-shaking
behavior and made the clean-app proof depend on a Git-ref source overlay.

The gate now uses Vite/Rollup's production-default tree-shaking policy for all
normal, stub-control, and negative builds. The neutral virtual consumer imports
and server-renders only `Button` from the real UI barrel. Its control keeps the
barrel's export and import-discovery graph intact: each date implementation is
loaded in memory with its original source body, while its public runtime export
is renamed and replaced by a pure stub. The original implementation is then
dead, so implementation cost is removed without changing Rollup's emission
ordering. A separate stripped-barrel virtual date consumer must fail with
`MISSING_EXPORT`, proving that the export-removal mutation remains effective.

The negative control removes `/* @__PURE__ */` from the actual date `.tsx`
modules under that same production-default policy. A read-only `pure-date`
mutation leaves those annotations intact and is required to fail the negative
control assertion. The stub-control fixture explicitly imports every runtime
barrel date export and rejects output containing implementation signatures, so
an implementation leak cannot satisfy the zero-cost comparison unnoticed.

The production app build now observes TypeScript/TSX barrel imports through a
Vite transform. When an app module imports `DatePicker`, the gate automatically
requires the emitted application chunks to retain `DatePicker`; otherwise it
emits an explicit `DatePicker not consumed` diagnostic. No environment flag or
Git-ref source overlay remains. The explicit virtual Calendar, DatePicker,
DateRangePicker, and TimePicker consumer still renders all four controls.

## Fresh metrics

| Build | Characters | Gzip bytes | Modules | SHA-256 | Date modules |
| --- | ---: | ---: | ---: | --- | ---: |
| Neutral normal | 542967 | 167833 | 451 | `886de36b3db5ed67baa4fe4c9b90c83ba022dd5a09a6872c89b2d4c9d8c973d9` | 0 |
| Neutral pure-stub control | 542967 | 167833 | 451 | `886de36b3db5ed67baa4fe4c9b90c83ba022dd5a09a6872c89b2d4c9d8c973d9` | 0 |
| PURE-removal negative control | 691781 | 214272 | 610 | `e18e4836be7f83faca2292cdfd04b6ad889ebc9c498ca8780623a8fa985cfcd7` | 6 |
| Explicit date consumer | 691840 | 214303 | 610 | `92f844c18ef3bca2bac6f9ccfcae23886c1d24e3fa1da67fca2912a2478dc49a` | 6 |
| Current production app | 1857225 | 568242 | 1299 | `2dea3eddbe961b3dc4f437e16f883a3a91d69e019e1d6aa944cb37777e6c7087` | 4 |

## Verification

- TDD RED: an explicit stub-control consumer initially retained six real date
  modules; the replacement-module test failed as expected.
- The default date gate passed after the fix. It recorded exact normal/control
  equality, exercised the stripped-barrel `MISSING_EXPORT` mutation, required
  the PURE-preserving mutation to fail the negative assertion, retained all
  date modules after actual PURE removal, and detected the current application
  DatePicker consumer automatically.
- `pnpm --filter @led-control/web test:overlay-bundle`, `pnpm typecheck`,
  `pnpm build`, and `node --test scripts/ci-workflows.test.mjs` are rerun
  before commit. A detached clean worktree at the committed head is then used
  to prove the default no-consumer state independently.
