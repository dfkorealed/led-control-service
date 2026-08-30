# Task 17 Fix Round 3 보고서

기준일: 2026-08-31

## 수정 내용

- `@led-control/shared/automation-contracts`의 `browser`와 `import` 조건이 더 이상 TypeScript source를 runtime export하지 않는다. 둘 다 shared build가 생성하는 `dist/esm/automation-action-result-contracts.js`를 가리키고, `types`는 built declaration을, `require`는 기존 CommonJS 산출물을 사용한다. Package root runtime은 기존 CommonJS를 유지하며 root `types`도 packed package에 포함되는 `dist/index.d.ts`로 맞췄다.
- `packages/shared/tsconfig.esm.json`은 production source-of-truth인 `automation-action-result-contracts.ts` 한 파일만 ES2022 module로 컴파일한다. schema를 복제하지 않으며 `dist/esm/package.json`의 `type: module`도 shared build가 재현 가능하게 생성한다.
- shared build는 CJS와 narrow ESM을 임시 디렉터리에서 먼저 완성한 뒤 이전 build manifest에 기록된 산출물만 정리한다. build가 소유하지 않은 `dist` 파일은 삭제하지 않으며, 실패한 compile이 기존 산출물을 먼저 지우지 않는다.
- packed package는 `dist`만 포함한다. package 회귀 테스트가 `pnpm pack` tarball을 격리 임시 consumer에 풀고 `zod`를 제공한 뒤 ESM `import`와 CJS `require` 양쪽에서 exact action-result payload를 `safeParse`한다.
- root `pnpm dev`의 shared 선행 build를 유지했다. Web의 standalone `dev`, `test`, `typecheck`, `lint`, `build`, `test:bundle-audit`도 shared build를 명시적으로 먼저 실행하므로 clean `dist`에서 동작이 결정적이다.
- Web bundle audit는 source `.ts`가 아니라 실제 `dist/esm` browser artifact가 production graph에 포함되는지 검사한다.

## TDD RED

1. direct Node ESM import 테스트를 먼저 추가했다. 수정 전 `@led-control/shared/automation-contracts`가 `src/automation-action-result-contracts.ts`를 CommonJS package 안에서 읽어 `SyntaxError: Cannot use import statement outside a module`로 실패했다.
2. packed consumer 테스트를 먼저 추가했다. 수정 전 tarball에는 `dist/esm/automation-action-result-contracts.js`, built d.ts와 ESM package metadata가 없어 파일 검증 단계에서 실패했다.

## GREEN 검증

- clean `packages/shared/dist`에서 Shared build 포함 전체 테스트 8파일 77/77, typecheck, 재build: 통과
- workspace direct Node ESM import와 packed isolated consumer의 root/subpath ESM import·CJS require exact `safeParse`: 통과
- packed files의 narrow ESM JS, built d.ts, `dist/esm/package.json` `type: module`: 확인
- `browser`/`import` runtime export에 `.ts` source 없음: 확인
- manifest 소유 stale artifact는 제거하고 미소유 `dist` 파일은 보존하는 반복 build: 통과
- focused Web 5파일 80/80, Web 전체 32파일 334/334: 통과
- Web typecheck, lint, production build, bundle audit: 통과
- production bundle: 2,370 modules, main `1,028.66 kB / gzip 313.70 kB`, schedule `76.11 kB / gzip 20.12 kB`; 기존 상한 `1,070 / 325 kB` 이내
- API CommonJS shared root typecheck/build/import smoke: 통과
- Gateway shared root ESM-to-CJS 및 narrow ESM typecheck/build/import/output syntax smoke: 통과, bundle `504.9 kB`

## 남은 한계

- production API/Gateway를 연결한 Chromium software E2E는 이번 package fix에서 실행하지 않았다.
- 실제 Raspberry Pi/BlueZ/ESP32-H2 RF 및 전원 차단 HIL은 실행하지 않았다.
- main과 PDF chunk의 기존 500 kB Vite warning은 유지된다. Task 17 회귀 상한은 bundle audit가 별도로 강제한다.
