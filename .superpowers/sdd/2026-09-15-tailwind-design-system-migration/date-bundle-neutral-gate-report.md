# Date bundle neutral gate report

## Root cause and design

The old no-date control rebuilt the real application after deleting the date
barrel exports in memory. Once `StatisticsAnalysisPage` started importing
`DatePicker`, that deliberately invalid barrel failed the build with Rollup's
`MISSING_EXPORT` error, making the migration-stage zero-cost check depend on
application adoption.

The gate now compares a virtual consumer that imports and server-renders only
`Button` from the real UI barrel. Its normal and no-date-control output must be
identical in character count, gzip bytes, module count, SHA-256 digest, and
date-module list. The no-date control is separately proven by requiring a
virtual date consumer to fail when its exports are removed. An impure in-memory
barrel mutation retains all four date controls and must increase every relevant
bundle cost. Explicit virtual consumers render Calendar, DatePicker,
DateRangePicker, and TimePicker. The production application is built separately
and reports whether DatePicker is retained; the strict current-consumer run
requires that retention, while the default gate supports a no-consumer app.

## Fresh metrics

| Build | Characters | Gzip bytes | Modules | SHA-256 | Date modules |
| --- | ---: | ---: | ---: | --- | ---: |
| Neutral normal | 110036 | 35180 | 20 | `29dcc67c41f94309b562ebdc485a84770a3506b62795b4d8cb806ae47ea75ed4` | 0 |
| Neutral no-date control | 110036 | 35180 | 20 | `29dcc67c41f94309b562ebdc485a84770a3506b62795b4d8cb806ae47ea75ed4` | 0 |
| Impure negative control | 691860 | 214300 | 611 | `b2d7a5676ceacc3a5f76d9f266f629e01acc483d1628250d062173bc216454d9` | 6 |
| Explicit date consumer | 499045 | 160280 | 357 | `cb0c2a7a353d61c3b2f84a1a34bd87187bd8c101f635f114579a3f0d5e82b2c1` | 6 |
| Current production app | 1857225 | 568242 | 1299 | `2dea3eddbe961b3dc4f437e16f883a3a91d69e019e1d6aa944cb37777e6c7087` | 4 |
| Base production app (`d2314a4a117c84cec5b0a3e9e86670e6a9d330aa`) | 1720770 | 523822 | 1148 | `003e6a4c474b4ed39be10cad3aad20f3333487280aad2d1105bf70d30e0e2fc4` | 0 |

## Verification

- Initial RED reproduced: `pnpm --filter @led-control/web test:date-bundle`
  failed because the old control removed the `DatePicker` export consumed by
  `StatisticsAnalysisPage`.
- Current Task6 consumer: `DATE_BUNDLE_REQUIRE_DATE_PICKER=1 pnpm --filter
  @led-control/web test:date-bundle` passed; the production app retained
  DatePicker.
- No-consumer foundation state: `DATE_BUNDLE_APP_SOURCE_REF=d2314a4a117c84cec5b0a3e9e86670e6a9d330aa
  pnpm --filter @led-control/web test:date-bundle` passed. The gate loaded all
  web source TypeScript blobs from that Git ref in memory and found no
  production DatePicker consumer.
- `pnpm --filter @led-control/web test:overlay-bundle`, `pnpm typecheck`,
  `pnpm build`, and `node --test scripts/ci-workflows.test.mjs` passed.
