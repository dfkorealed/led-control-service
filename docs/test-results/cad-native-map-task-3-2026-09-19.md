# CAD Native Map Task 3 검증 보고

## 범위

- expanded CAD geometry의 deterministic multi-region 탐지
- 큰 geometry의 실제 선분 기반 spatial bucket 순회
- cell 크기 tessellation 이전의 초대형 curve analytic sparse 전환
- sparse record 쌍의 실제 curve/segment 간 거리·교차 검사
- INSERT occurrence와 spatial component를 분리한 조명 후보 귀속
- zero-area singleton POINT noise의 명시적 제외 accounting과 child manifest 크기 제한
- 기존 SVG preview `2400x1600` 상한 유지

## TDD 결과

- 임의 위치에서 1,000,000 단위 closed outline과 접촉한 detail이 2개 region으로 갈라지는 RED를 재현한 뒤 exact segment-to-cell traversal로 1개 region GREEN을 확인했다.
- 하나의 XREF wrapper INSERT 아래 원거리 자식 8 primitives가 1개 region으로 합쳐지는 RED를 재현한 뒤 spatial clustering 후 occurrence 관계를 구축해 2개 region과 정확한 후보 귀속을 확인했다.
- 의미 geometry와 150,000 POINT noise가 150,001 regions 및 8 MiB 초과 manifest를 만드는 RED를 재현했다. GREEN에서는 의미 region의 bounds, primitiveCount와 regionId를 변경하지 않고 `excludedRegionPrimitiveCount=150000`으로 분리해 bounded response와 exact rendered-occurrence accounting을 확인했다.
- 의미 있는 singleton circle은 유지하고 의미 region 수가 `CAD_MAX_DETECTED_REGIONS=16384`를 넘으면 deterministic domain error로 실패하도록 고정했다.
- 3,000,000×3,000,000 outline의 exact cell enumeration이 global bucket limit에서 실패하는 RED를 재현했다. 4,096 cells를 넘는 segment는 endpoint spanner와 bounds interval index의 exact segment/AABB proximity 검사로 전환해 touching 10-unit detail은 같은 region, distant detail은 별도 region으로 유지했다.
- Fix round 4에서는 반지름 3,000,000 circle, wrap-around ARC, 양/음 bulge polyline, 양방향 hatch arc와 full-circle hatch를 추가했다. 원본 및 회전·반사·비균일 scale INSERT의 14개 stress case와 생략된 sweep의 5개 case가 모두 `CAD region spatial bucket limit exceeded`로 실패하는 RED를 확인했다.
- GREEN에서는 affine stretch 상한과 arc 길이로 sparse 여부를 먼저 결정한다. 초대형 curve마다 중심·cos/sin 계수·signed sweep만 보관하고 기존 bounds index와 analytic arc/AABB 교차 검사를 사용한다. 반지름에 비례하는 cell/segment 열거 없이 10-unit 접촉 detail과 20-unit 인접 detail은 연결하고, curve bounds 내부라도 실제 곡선에서 10,000-unit 떨어진 detail과 생략된 sweep의 detail은 분리한다.
- 새 19개 회귀는 모두 통과했다. 14개 stress case는 기본 200,000 bucket 제한뿐 아니라 입력 순서를 뒤집은 `maxSpatialBuckets=128`, `checkBudget` 최대 1,000회 조건에서도 동일한 전체 결과를 반환했다. 이는 curve 크기 대신 입력 primitive/후보 수에 따라 비용이 증가하는 구현이며, 무제한 입력의 상수 시간 처리를 의미하지 않는다.
- Fix round 5 RED: 반지름 3,000,000/2,900,000의 동심 circle과 ARC가 넓은 간격에도 하나로 합쳐지는 8개 실패를 확인했다. direct, 회전 INSERT, 반사 INSERT, 회전·반사·비균일 scale INSERT를 각각 검사했다. 원인은 curve/다른 record bounds 교차를 실제 geometry 접촉으로 간주한 것이다.
- Fix round 5 GREEN: 양쪽 모두 sparse인 record는 bounds를 후보 검색에만 사용하고 모든 실제 arc/segment 쌍의 proximity를 검사한다. affine arc의 chord 보간 오차 상한으로 거리를 배제·확정하고 불확실한 구간만 depth-first 분할한다. 반대 방향의 segment/AABB 또는 arc/AABB fallback도 차단하며, 같은 record의 짧은 hatch edge를 빠뜨리지 않는다.
- 동심 8개 case는 `maxSpatialBuckets=128`, `checkBudget` 최대 10,000회 안에서 entity/block 내부 순서를 뒤집어도 동일한 결과다. 9개 추가 control은 교차·접선·인접 circle, 원 내부의 독립 sparse line, line/circle 교차·접선, 짧은 hatch edge 접촉을 검증한다. 기존 huge curve와 10-unit detail 접촉·인접성 회귀도 유지된다.
- 쌍별 proximity는 cell 크기의 Euclidean 거리와 `max(cellSize * 1e-6, 좌표 크기 기반 64 ULP)` 수치 허용치를 사용한다. 분할 stack만 유지하고 detector 전체의 pair-refinement 200,000회 상한을 넘으면 `CAD sparse proximity work limit exceeded`로 실패한다. 병적인 근접 geometry에서 임의로 merge하거나 무제한 세분화하지 않는다.
- core manifest는 `sum(region.primitiveCount) + excludedRegionPrimitiveCount == rendered.renderedOccurrences`를 검증하며 excluded noise를 region count나 ID에 귀속하지 않는다.

## Fixture 통합

`scripts/fixtures/cad-import/valid-mixed-layout.dxf`를 임의 region 결과로 대체하지 않고 실제 `cad-core-child`와 `ChildProcessCadCoreExecutor`로 실행했다. parser, detector, SVG renderer와 manifest validator를 통과한 결과는 model entities 2개, block 1개, rendered occurrences 2개, region 1개, preview `2400x1472`다. generic profile의 최소 반복 횟수 정책에 따라 조명 후보는 0개다.

## 최종 검증

- Fix round 5 focused Jest: 7 suites, 169 tests 통과 (7.82초)
- API typecheck: `tsc --noEmit` 통과
- `pnpm workspace:prepare` 통과
- `git diff --check` 및 아직 untracked인 detector 구현/테스트의 `git diff --no-index --check /dev/null <file>`에서 whitespace 오류 없음 (`--no-index` exit 1은 파일 차이 표시)
- `cad-viewport.ts`와 `cad-viewport.spec.ts` 변경 없음
- XREF 공간 분리, occurrence 기반 후보 귀속, 150,000 POINT 제외 accounting, 8 MiB child response 제한 및 실제 child pipeline 회귀 통과
- pnpm launcher의 기존 `pnpm.overrides`/`pnpm.patchedDependencies` 설정 위치 경고는 남아 있으나 검증 명령은 모두 성공했다.

```bash
pnpm workspace:prepare
pnpm --filter @led-control/api exec jest src/floor-import/cad-region-detector.spec.ts --runInBand --testNamePattern='huge'
pnpm --filter @led-control/api exec jest src/floor-import/cad-region-detector.spec.ts --runInBand --testNamePattern='sparse geometry pairs|actual sparse contact'
pnpm --filter @led-control/api exec jest src/floor-import/cad-region-detector.spec.ts src/floor-import/cad-region-detector.integration.spec.ts src/floor-import/cad-core-executor.spec.ts src/floor-import/cad-svg-renderer.spec.ts src/floor-import/cad-viewport.spec.ts src/floor-import/dxf-document-parser.spec.ts src/floor-import/rule-based-lighting-symbol-detector.spec.ts --runInBand
pnpm --filter @led-control/api typecheck
git diff --check
```

## 남은 검증

승인된 converter와 제공 DWG를 사용하는 외부 통합 환경은 이번 focused 검증에서 사용하지 않았다. 두 실제 DWG의 region bounds, primitive/candidate 수, 변환 불가 비율과 성능 측정은 구현 계획 Task 11에서 수행한다.
