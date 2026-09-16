# Task 19.2 Fix Round 5 보고서

## 상태

- 완료: 재검토 4의 유일 P2인 tokenization/matcher/grid 내부 작업의 cooperative budget 우회를 수정했다.
- 범위: rule-based lighting symbol detector 구현, 해당 regression test, 이 보고서만 변경했다.
- 공유 worktree의 기존 문서 및 산출물 변경은 수정하거나 stage하지 않았다.
- subagent를 사용하지 않았다.

## 원인

- 기존 `afterWork()`는 엔티티와 nearby text 항목 같은 coarse 작업만 계산했다.
- `tokenize()`의 문자 순회와 `matchesTokens()`의 matcher/token 중첩 비교는 긴 동기 구간이었다.
- grid cell 내부의 거리 계산도 cooperative counter와 분리돼 있었다.
- 마지막 candidate 판정 뒤와 최종 반환 직전에 deadline/abort를 다시 검사하지 않았다.

## 구현 내용

- `detect()`가 소유하는 단일 `workSinceYield` counter를 tokenization, identifier normalization, matcher 선택 및 token equality, grid cell 조회와 cell 내부 거리 계산에 전달했다.
- 허용 interval은 기존대로 최대 `1024`이며, interval 도달 시 `setImmediate`로 event loop에 양보한 다음 AbortSignal과 monotonic deadline을 다시 검사한다.
- matcher보다 token 수가 적어 equality가 실행되지 않는 경우와 token group 순회도 primitive work로 계산한다.
- 모든 candidate 종료 경로와 최종 `return` 직전에 budget을 재검사한다.
- 기존 spatial-index 테스트의 가상 clock 상한은 새 문자/비교 단위 계측을 반영해 `300,000`으로 조정했다. 1,000 x 1,000 전체 탐색 퇴행을 막는 선형성 검증 목적은 유지한다.

## RED -> GREEN

### RED

명령:

```bash
pnpm --filter @led-control/api exec jest src/floor-import/rule-based-lighting-symbol-detector.spec.ts --runInBand
```

수정 전 결과:

- FAIL: 1 suite
- 15 passed, 신규 regression 2 failed
- parser 상한 크기의 dense nearby text 49건에서 실행 중 예약한 abort보다 2개 검출 결과가 먼저 resolve됐다.
- 반복 token matcher 도중 만료되도록 구성한 monotonic deadline보다 1개 검출 결과가 먼저 resolve됐다.

### GREEN

같은 scoped 명령의 수정 후 결과:

- PASS: 1 suite, 17/17 tests
- 최대 cooperative interval `1024`에서 64 KiB 단일 token의 실행 중 abort가 결과보다 먼저 reject됐다.
- 10,000자 tokenization 이후 dense matcher 비교 중 만료된 deadline이 결과보다 먼저 reject됐다.

## 최종 검증

```bash
pnpm --filter @led-control/api exec jest src/floor-import --runInBand
```

- PASS: 5 suites, 66 passed, 1 Darwin-gated skipped

```bash
pnpm --filter @led-control/api typecheck
```

- PASS: `tsc --noEmit`, exit 0

```bash
pnpm --filter @led-control/api build
```

- PASS: `nest build`, exit 0

```bash
git diff --check
```

- PASS

## 변경 파일

- `apps/api/src/floor-import/rule-based-lighting-symbol-detector.ts`
- `apps/api/src/floor-import/rule-based-lighting-symbol-detector.spec.ts`
- `.superpowers/sdd/2026-07-06-floor-editor-implementation/task-19.2-fix5-report.md`

## 커밋

- `fix: budget dense lighting detection work`
- 위 3개 Task 19.2 fix round 5 파일만 포함한다.
