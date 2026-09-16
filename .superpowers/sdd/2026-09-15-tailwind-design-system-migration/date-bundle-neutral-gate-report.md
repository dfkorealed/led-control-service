# Date bundle neutral gate report — review round 2

## Composite gate

The date gate now uses two complementary controls under Vite/Rollup's normal
production tree-shaking policy.

1. The normal barrel and a structure-preserving, in-memory pure-stub barrel
   must have exactly equal raw entry characters, gzip bytes, module count,
   SHA-256 digest, and date-module set. This directly proves that public date
   implementation bodies add no emitted cost when the neutral consumer renders
   only `Button`.
2. The real stripped-barrel control proves unused-date dependency closure rather
   than raw chunk byte ordering. It requires equal total characters, module
   count, and date-module set, plus an exact sorted Rollup module signature of
   module ID, `renderedLength`, `renderedExports`, and `removedExports`.

Rollup exposes output-chunk code but does not expose a separately stable
per-module rendered-code fragment. Removing barrel export lines can change
identifier/import emission order even when the retained module closure is
identical. The current raw stripped outputs therefore differ only in gzip and
digest; this is diagnosed rather than asserted. The stronger raw exact contract
remains covered by the stub control, while the stripped closure contract is
required to reject retained dependency changes.

## Mutation evidence

- The stripped barrel must reject an explicit virtual dependency imported only
  by DatePicker; that virtual module performs one global assignment.
- It must also reject an in-memory DatePicker-local top-level global assignment,
  which retains DatePicker itself.
- The PURE negative control removes `/* @__PURE__ */` from the actual date
  `.tsx` modules. A read-only mode that preserves those annotations is required
  to fail the negative assertion; the removal must retain date modules and
  increase cost.
- A separate stripped-barrel date-consumer build must fail with `MISSING_EXPORT`.
- The explicit Calendar, DatePicker, DateRangePicker, and TimePicker consumer
  renders all four controls. The production app automatically detects a source
  DatePicker import and requires DatePicker retention when it is consumed.

## Fresh metrics

| Build | Characters | Gzip bytes | Modules | SHA-256 | Date modules |
| --- | ---: | ---: | ---: | --- | ---: |
| Raw neutral normal | 542967 | 167833 | 451 | `886de36b3db5ed67baa4fe4c9b90c83ba022dd5a09a6872c89b2d4c9d8c973d9` | 0 |
| Raw structure-preserving stub | 542967 | 167833 | 451 | `886de36b3db5ed67baa4fe4c9b90c83ba022dd5a09a6872c89b2d4c9d8c973d9` | 0 |
| Real stripped barrel | 542967 | 167880 | 451 | `cd3167034358c0cb5231bbbd383723b54999ef1fcdb147b6fcc3ee669477c073` | 0 |
| PURE-removal negative | 691781 | 214272 | 610 | `e18e4836be7f83faca2292cdfd04b6ad889ebc9c498ca8780623a8fa985cfcd7` | 6 |
| Explicit date consumer | 691840 | 214303 | 610 | `92f844c18ef3bca2bac6f9ccfcae23886c1d24e3fa1da67fca2912a2478dc49a` | 6 |

## Verification

- TDD RED: replacing the raw control with a real stripped barrel reproduced
  equal characters/modules/date modules but different gzip/digest. The
  preserveModules experiment also left this binding-order difference, so no
  source or output canonicalization was used.
- The final composite gate requires raw normal/stub equality, exact
  normal/stripped closure equality, and fail-closed virtual-dependency and
  DatePicker-local side-effect mutations.
- `pnpm --filter @led-control/web test:date-bundle`,
  `pnpm --filter @led-control/web test:overlay-bundle`, `pnpm typecheck`,
  `pnpm build`, and `node --test scripts/ci-workflows.test.mjs` are rerun
  before commit. Current consumer and detached foundation-only worktree proofs
  run after commit.
