# Task 1 report: O안 스위치 플립 정본 SVG와 PNG

## Implementation summary

- Added the canonical 64×64 O안 switch-flip SVG mark with the specified Navy, Blue, and Coral palette, geometry, translation, and 12° rotation.
- Added reversed and monochrome SVG variants that preserve canonical geometry.
- Added a Playwright-based renderer and `brand:assets` package script to generate transparent 512px and 32px PNG assets.
- Added the brand asset contract test covering geometry, colors, safe bounds, and PNG signatures.

## TDD evidence

### RED

Command:

```text
pnpm --filter @led-control/web test -- src/components/brand/brand-assets.test.ts
```

Result: failed as expected before implementation. Vitest reported `ENOENT: no such file or directory, open 'public/brand/kinda-mark.svg'`; the PNG checks also reported missing files. One geometry-bound test passed independently.

### GREEN

After adding the SVGs, renderer, package script, and test fixture assets:

```text
pnpm --filter @led-control/web brand:assets
```

Result: exit code 0; generated `favicon-32.png` and `kinda-mark-512.png`.

```text
pnpm --filter @led-control/web test -- src/components/brand/brand-assets.test.ts
```

Result: exit code 0; 1 test file and 7 tests passed.

## Files changed

- `apps/web/package.json`
- `apps/web/public/brand/kinda-mark.svg`
- `apps/web/public/brand/kinda-mark-reversed.svg`
- `apps/web/public/brand/kinda-mark-monochrome.svg`
- `apps/web/public/brand/kinda-mark-512.png`
- `apps/web/public/brand/favicon-32.png`
- `apps/web/scripts/render-brand-assets.mjs`
- `apps/web/src/components/brand/brand-assets.test.ts`

## Self-review findings

- Confirmed canonical and derived SVGs use the required IDs and exact geometry attributes.
- Confirmed derived assets contain no text, filter, or gradient elements beyond their accessible titles.
- Confirmed PNGs are generated from the canonical SVG through the existing Playwright dependency and have PNG signatures.
- Confirmed the worktree is clean after commit.

## Concerns

- No task-specific concerns. The renderer requires Playwright/Chromium to be installed, which is already available in this workspace.

## Commit

`bc48834 feat(web): add kinda switch flip assets`
