# U9a 공통 맵 렌더러 코어 보고서

상태: **범위 구현·집중 검증 완료, 독립 리뷰 관문 대기**. U9 전체 및 사용자 화면 통합 완료가 아니다.

- 작업 위치: `/Users/kim-jh/Documents/led-control-service`, 현재 브랜치 직접 작업.
- 선행 계약: U2 `61ce049e`, U8a `22131660`, U4a `bbd99208` 및 ID 보정 `cbe64ccb`.
- 수정 범위: `features/map-scene` 신규 코어/테스트/검증 설정, 기존 `cad-scene/CadSceneRenderer.ts`, `cad-scene-worker.ts`의 범용 확장, 이 보고서만.
- `map-performance`, FloorEditor, store/types, API client, shared, 중앙 문서, DB를 변경하지 않았다. 사용자 DB 접근·초기화·migration 실행 없음. 에이전트 생성 없음.
- 요청된 기존 CAD 소비자 호환을 유지하며 전체 렌더러를 복제하지 않았다.

## 진행 체크리스트

- [x] 가까운 AGENTS, 역할 운영 기준, 교훈, 승인 U9 계획·설계 확인.
- [x] 구현 전 source 계약 전달. 사용자 피드백 후 canonical 전체 청크 접근 제안을 폐기하고 파생 타일+ID 정본 조회 경계 승인.
- [x] 실패 테스트 확인 후 코어와 geometry helper 구현.
- [x] 명시적 display layer 매핑과 선택·메모리·요청 경합 회귀 보완.
- [x] 집중 Vitest, 웹 타입 검사, 기존/신규 실제 WebGL fixture 검증.
- [x] 자체 검토 결과 및 통합 한계 기록.
- [ ] 총괄의 독립 리뷰 및 U7/U8b/U9b 소비자 통합.

## 확정 인터페이스

정의 파일: `apps/web/src/features/map-scene/map-scene-source.ts`.

```ts
interface MapSceneSource {
  readonly scopeKey: string;
  getManifest(ref: MapDocumentRef, signal: AbortSignal): Promise<MapSceneManifest>;
  loadDisplayTile(tile: CadSceneTile, signal: AbortSignal): Promise<Uint8Array>;
  getElements(ref: MapDocumentRef, ids: readonly string[], signal: AbortSignal): Promise<readonly MapElement[]>;
  decodeDisplayTile?: CadSceneWorkerClient["decode"];
}
interface MapSceneManifest {
  generationId: string;
  revision: number;
  canonical: MapAssetRef;
  display: CadSceneManifest;
  displayLayerBindings: Array<{ layerName: string; layerId: string }>;
  groups: MapGroup[];
  layers: MapLayer[];
}
```

- `canonical`은 `MapDocumentRef.manifest`의 ID/hash/encoded/decoded 크기와 일치해야 한다. 초기 fit에서 정본 geometry를 받지 않는다.
- `display`만 기존 compact binary/LOD의 내부 파생 계약이다. 사용자 도형·편집 정본은 항상 MapElement다. 서버 URL을 가정하지 않는다.
- `displayLayerBindings`는 필수다. 동일명 수동 어댑터도 명시적 identity mapping을 전달한다. 이름으로 ID를 추측하지 않는다. 없는 binding, 중복 layerName, 존재하지 않는 canonical layerId는 오류다. Worker 결과의 layerName을 이 mapping으로 canonical ID로 변환한다.
- provider는 인증 scope별로 생성한다. scopeKey를 변경하지 말고 층/현장/사용자 전환 시 이전 renderer를 dispose하고 새 source/renderer를 만든다.
- provider는 manifest/asset 권한·무결성 및 streaming byte 상한을 검증한다. 기본 Worker는 기존 compact codec SHA/크기 검증을 재사용한다. 주입 decoder도 동일한 검증을 보장하고 캐시 입력 Uint8Array를 detach/변경하지 않는다.
- renderer 기본 Worker는 renderer가 종료한다. `decodeDisplayTile`을 주입한 경우 그 Worker 수명은 provider 소유다.
- `getElements`의 서버 ID lookup 및 HTTP body 상한은 U7 소유다. renderer는 요청 ID 수, 응답 수/ID 일치/중복/serialized byte 상한을 추가 검사한다. 전체 canonical generation을 반환하면 안 된다.

공개 클래스: `MapSceneRenderer`.

```ts
const renderer = new MapSceneRenderer({ source, onError, onDegraded });
await renderer.mount(canvas);
await renderer.setDocument(documentRef);
renderer.setCamera(camera);
renderer.applyChanges(operations, changedBounds);
const picked = await renderer.pick(screenPoint); // { element: MapElement } | null
const selected = await renderer.getElements(ids); // bounded canonical lookup
renderer.dispose();
```

- 카메라는 기존 `centerX/centerY/zoom/viewportWidth/viewportHeight`다. 한 rAF 안의 입력은 병합하며 fetch를 기다리지 않고 기존 scene을 먼저 변환·그린다.
- setDocument의 Promise는 manifest 채택까지만 의미한다. 전체 visible tile 표시 완료 Promise가 아니다.
- 동일 generation의 revision 변경은 backend/canvas를 재생성하지 않는다. 불변 ID/hash/size가 같은 display tile과 원본 바이트를 재사용한다.
- 로컬 draft mask는 같은 generation의 revision 변경으로 자동 해제하지 않는다. 저장 응답만 보고 지연된 파생 타일의 삭제 복원을 허용하지 않기 위한 정책이다.
- applyChanges는 검증된 공통 operation의 표시 소비자다. U8의 존재 조건·잠금·그룹 참조·transaction 검증을 대체하지 않는다. changedBounds는 기존/새 영역을 모두 전달해야 한다. 로드되지 않은 요소의 이전 bounds는 renderer가 추측하지 않는다.

## U4b/U7 필수 계약

U4a 보고서의 `onSemanticEntity`가 반환한 canonical 배열을 그대로 저장하고 **반드시 builder callback에서도 반환**해야 한다. void 반환은 legacy display 전용이며 새 문서 연결에 사용하면 안 된다.

- 모든 compact `elementId === canonical.id`, `groupId === canonical.groupId`.
- HATCH outer/hole/island 표시 조각도 소유 canonical polygon ID를 사용한다. renderer는 조각을 정본으로 합성하거나 마지막 조각으로 덮어쓰지 않는다.
- 선택은 파생 spatial 후보 ID를 모은 후 요청한 canonical만 조회한다. canonical geometry로 재검증하므로 구멍 내부를 면으로 오인하지 않으며 구멍 뒤의 다른 후보도 선택한다.
- converter metadata의 `displayLayerBindings`를 U3 display asset pin, U4b 저장, U7 manifest 응답까지 보존해야 한다.
- 텍스트는 출처와 무관한 공통 top-left다. helper가 `geometry.position + (0, height)`에 canonical transform을 한 번 적용해 기존 atlas baseline으로 변환한다. CAD provenance별 추가 보정 없음. U4의 baseline→top-left 보정과 중복 적용하지 않는다.

## 메모리 및 변경 경계

- 기존 Pixi mesh/style batching, text atlas, Worker, LRU, source spatial index를 재사용한다. 요소별 Pixi/DOM/React/Konva 노드를 생성하지 않는다.
- aggregate retained cache 기본값: desktop 128 MiB, mobile 32 MiB. 원본 바이트 LRU 기본값은 각각 32/8 MiB이며 같은 aggregate에 포함된다. 원본 키는 scope/generation/assetId/hash/size다.
- decoded CPU + GPU + atlas + canonical draft 추정 메모리를 함께 계산한다. 기존 GPU 128/32 MiB, atlas 64/16 MiB 세부 상한도 검사한다. cache 입장 실패는 오류 또는 onDegraded이며 조용한 완전 표시 성공이 아니다.
- 캐시 합산 수치는 기존 추정식이다. fetch/Worker의 bounded 전송 복사·일시 decode peak, JavaScript engine overhead까지 포함한 process RSS 보장은 아니다. 기존 16 MiB 단일 compact tile 제한과 bounded prefetch/단일 순차 decode를 유지한다.
- 로컬 draft: element/group/layer 합계 2,000 ID, serialized 8 MiB. canonical retained 추정값은 serialized 크기의 4배다. 초과는 기존 초안을 변경하기 전에 실패한다. 대량 삭제/외부 staged inverse 통합은 후속 작업이다.
- 로컬 geometry: 총 131,072점, 곡선 4,096 segment 상한. 구멍은 기존 earcut으로 삼각화한다. local draft용 legacy AABB pick grid는 만들지 않아 큰 polygon이 수십만 셀을 점유하지 않는다.
- 정본 선택: 최대 128개 ID/serialized 8 MiB, 1개 진행 중 lookup. exact pick: 후보 tile 최대 32개, encoded 합계 16 MiB, 한 decoded tile 최대 16 MiB 또는 aggregate 상한 중 작은 값. 과밀 후보는 명시적으로 거부한다. UI는 실패/확대 안내를 제공해야 한다.
- generation/요청 epoch와 AbortSignal로 늦은 manifest/byte/lookup 결과를 폐기한다. 삭제 ID를 늦게 온 display decode에도 적용한다. dirty source batch를 즉시 제거하고 인접 descriptor만 다시 decode한다.
- context loss에서 GPU를 해제하고 display CPU cache는 evictable로 낮춘다. draft CPU는 보존하고 복원 시 같은 backend에 다시 올린다. dispose 후 집계 메모리 0을 검증했다.

## 검증 증거

최종 집중 명령:

```sh
pnpm --filter @led-control/web exec vitest run \
  src/features/map-scene/MapSceneRenderer.test.ts \
  src/features/map-scene/map-scene-geometry.test.ts \
  src/features/cad-scene/cad-scene-renderer.test.ts \
  src/features/cad-scene/cad-scene-display.test.ts \
  src/features/cad-scene/cad-scene-pixi-backend.test.ts \
  src/features/cad-scene/cad-scene-memory-budget.test.ts
pnpm --filter @led-control/web exec tsc --noEmit --pretty false
pnpm --filter @led-control/web exec playwright test --config=src/features/map-scene/playwright.config.ts
```

- Vitest: **6 files, 70 tests PASS**. 공통 renderer 19개, geometry 5개, 기존 46개. 기존 300,000-line batching benchmark 포함.
- 웹 TypeScript: exit 0. 지적된 테스트 `id` implicit-any는 명시적 readonly string[] 매개변수로 수정했다.
- Chromium: **4/4 PASS**, skip/실패 0. 기존 atlas 문자 폭·다른 영역 context 복원 2개, 신규 공통 renderer 1024px/320px 2개.
- 신규 browser fixture는 실제 golden compact bytes, 기본 Browser Worker, 실제 Pixi WebGL을 사용한다. 정본 API만 메모리 provider fixture다.
- 신규 두 viewport 모두 초기 정본 조회 0, 전체 여정 display fetch 1, 선택 정본 lookup 1, polygon hole alpha 0, 삭제 후 기존 source pixel 유지, context 복원 성공, dispose 후 집계 0.
- retained 추정 메모리: 1024px 88,619 bytes, 320px 88,161 bytes. 작은 fixture 값이며 대형 도면 성능 수치가 아니다.
- 브라우저 JSON 증거: `apps/web/.local/map-scene-smoke/report.json`. 새 설정은 전용 포트 15179/별도 Vite cache를 쓰고 제품 서버·DB를 사용하지 않는다. 종료 시 smoke 서버 정리.
- 최초 신규 GPU fixture 실패는 camera 밖 픽셀과 compositor 이후 clear된 framebuffer를 읽은 테스트 오류였다. camera 범위와 실제 render 직후 readPixels로 바로잡았으며 제품 상한을 올리지 않았다.
- 자체 검토 RED→GREEN: 명시적 layer mapping, bounded selection, polygon hole 뒤 후보, 중복 draft pick grid, atlas 세부 상한, 취소된 manifest 오류, 숨긴 draft layer 재표시.
- git diff --check 통과. pnpm 설정 위치/NO_COLOR 경고는 기존 환경 경고다.
- root/full suite/shared/Prisma/사용자 DB 검증 미실행. 기존 CAD smoke 원래 설정은 composition용 fixture build를 준비했으나, 최종 통합 smoke 설정은 추가 전체 build 없이 두 renderer smoke만 실행했다.

## 남은 통합 및 제한

1. U7 HTTP/provider 구현, U3 canonical metadata와 별도 display assets 연결, U4b ID/mapping 저장, 권한·hash·stream body 경계의 실제 통합 검증.
2. MapSceneCanvas와 editor/monitoring 소비자, U8b draft/history 연결, error/degradation 한글 UI. 기존 CAD 소비자는 그대로 유지되며 사용자 맵이 자동 전환되지 않는다.
3. 저장 후 로컬 masks를 안전하게 acknowledge/rebase하는 명시적 경계. 현재는 generation 전환까지 유지하므로 장기 편집 세션은 2,000 draft ID 상한에 도달할 수 있다. revision만 보고 mask를 지우면 안 된다.
4. draft는 작고 임시인 최상단 편집 batch다. 기존 파생 renderer의 style/tile painter 순서를 재사용한다. layer order/zIndex/그룹 membership의 완전한 시각적 재정렬은 정본 변경 후 derived regeneration과 후속 통합 검증 대상이다. 선택 후보는 canonical layer order/zIndex로 판정한다.
5. 주입한 metadata/binding은 동일 파생 자산 identity에 대해 불변이어야 한다. mapping/구조를 재작성하면 대응 display 자산 identity도 갱신해야 한다.
6. 실제 두 DWG, 500k 전체 fit의 전체 coverage/HTTP byte/p95 재측정, 300k 혼합 도형, iOS/Android 실제 WebView, 실제 DB 저장→재조회는 미검증이다. 작은 fixture와 기존 line benchmark를 해당 완료 증거로 확대하지 않는다.
7. 새 provider의 staged 대량 선택·삭제와 높은 복잡도 selection의 서버 측 후보 조회는 별도 확장이다. 이번 코어는 상한 초과를 숨기지 않는다.

독립 리뷰를 요청할 범위는 이 커밋의 map-scene 신규 파일과 cad-scene 두 파일이다. 중앙 메뉴/상태/체크리스트 문서는 총괄이 U9a 완료와 U9 전체 미완료를 구분해 갱신한다.
