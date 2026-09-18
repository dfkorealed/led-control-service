# Task 7 보고서: 렌더링 최적화와 배경 오류 상태

## 상태

- 수정 라운드 1 완료. fixture 1,000개, CAD slot 2,000개, map object 2,000개 결합 상한에서 렌더링 경로와 측정 계약을 보강했다.
- Task 6 이월 사항인 Web의 shared 소스 직접 import를 공식 `@led-control/shared/cad-import-contracts` export로 교체하고 non-default pan/zoom exact slot snap 브라우저 회귀를 추가했다.

## RED/GREEN

- RED: `editor-spatial-index`와 `use-floor-plan-image` 모듈 부재, CAD 오류 안내 부재, viewport 밖 Konva 노드 생성, 6 Layer 경고, pointer move 무제한 갱신, 1,000행 End-key focus 실패를 실제 테스트 실패로 확인했다.
- GREEN: 지정 spatial/image/view 테스트와 slot component 회귀가 통과했고 Konva 6 Layer 경고가 사라졌다.
- 첫 Chromium 실행은 stale shared CJS root의 runtime named export 때문에 앱 부팅에서 실패했다. CAD 계약 ESM subpath를 공식 export로 추가한 뒤 동일 Chromium 명령으로 9/9 통과했다.
- 수정 라운드 RED: 대형 rectangle은 기존 grid index에서 실제 `Map maximum size exceeded`가 발생했고 invalid bounds, 회전/stroke AABB, pan 중 live culling, revision current-key, 공유 retry, readOnly drag cleanup, 수동 scroll focus 회귀가 각각 실패했다. 결합 workload의 첫 실제 측정은 frame p95 59ms로 기준을 넘었고 synthetic drag 측정이 실제 pointer/paint를 포함하지 않음을 확인했다.
- 수정 라운드 GREEN: 관련 unit/component 69/69, 실제 Chromium floor placement 9/9, Web typecheck/build와 UI policy를 통과했다.

## 최적화 구조

- `buildEditorSpatialIndex`는 입력 순서를 보존하는 deterministic bounded cell index를 만든다. invalid item/query bounds를 방어하고 256 cell을 넘는 대형 항목은 별도 목록, 4,096 cell을 넘는 query는 입력 수에 비례하는 선형 교차 경로를 사용한다.
- fixture·map object는 160px, slot은 80px screen-space margin을 world 좌표로 변환해 culling한다. map object는 회전된 네 모서리와 실제 render stroke를 포함한 AABB를 사용하고, pan gesture 중 rAF transient pan으로 새 viewport의 노드를 pointer-up 전에 mount한다. 선택 fixture/object와 drag 중 fixture 집합, highlighted slot은 query 밖이어도 유지한다.
- zoom 0.5 미만에서 bulk label, 비선택 fixture stroke detail과 slot dash/방향선을 줄인다. fixture 상태색, 선택 stroke와 44px screen-space hit stroke는 유지한다.
- background/grid/CAD slot을 하나의 non-listening static Layer로 합쳤다. candidate, object, fixture, overlay를 포함해 실제 측정 Stage는 4 Layer였다.
- `useFloorPlanImage`는 URL+revision key별 Image와 decode를 공유하고 render 단계에서 current-key snapshot만 반환한다. error 상태의 공유 retry만 한 번 시작해 동시 consumer를 dedupe하며 URL/revision 변경, load/decode 실패와 unmount 후 완료 race를 분리한다.
- canvas pointer move와 fixture/object drag move는 최신 작업만 requestAnimationFrame에 합친다. drag interaction token은 readOnly/lease, tool, layer, floor/state 변경 시 frame, queue, guide와 imperative node 위치를 취소·복구하며 stale drag-end store commit을 차단한다.
- fixture 목록은 64px row, 16행 window를 유지하며 search/filter 변경 초기화, roving tab focus, Arrow/Home/End offscreen reveal, selection과 unplace focus 복귀를 지원한다. 수동 wheel/scrollbar 이동으로 active row가 unmount되면 첫 viewport 행으로 roving target과 실제 focus를 옮긴다.

## 측정

- 환경: Apple M2 Pro, macOS arm64, Chromium 149.0.7827.55, viewport 1440×900, mock API, warm local Vite/OS cache. Playwright route 특성상 HTTP cache는 비활성이고 운영 cold start 측정이 아니다.
- 준비: fixture 1,000개, slot 2,000개, map object 2,000개를 함께 넣고 제외 warm-up 뒤 같은 browser context에서 reload 20회, nearest-rank p95 876.2ms. 기준 3,000ms 이하 통과.
- pan/zoom: 동일 결합 데이터의 2x culling 상태에서 실제 pointer pan과 wheel zoom을 수행한 requestAnimationFrame 299개, nearest-rank p95 9.2ms. 기준 33ms 이하 통과.
- drag commit: 실제 Playwright mouse drag 20회에서 browser `mouseup`부터 store 좌표, Konva node 좌표와 fixture layer painted pixel이 일치한 frame까지 nearest-rank p95 37.4ms. 기준 100ms 이하 통과.
- 각 reload에서 fixture 1,000개, slot 2,000개, map object 2,000개, Layer 4개와 CAD URL+revision decode 1회를 확인했다. culling suite는 visible rotated object와 viewport 밖 selected object 유지도 확인했다.

## 변경 파일/커밋

- 신규: `editor-spatial-index.ts`, `editor-spatial-index.test.ts`, `use-floor-plan-image.ts`, `use-floor-plan-image.test.tsx`.
- 수정: `FloorEditorCanvas.tsx`, `EditorFixtureNode.tsx`, `CadPlacementSlotLayer.tsx`, `CadPlacementSlotLayer.test.tsx`, `FixturePlacementList.tsx`, `FloorEditorView.test.tsx`, `floor-placement.spec.ts`, Web CAD API/panel import, shared CAD ESM export, `docs/menus/settings.md`.
- 커밋: `0de3b43ff4e6c02edf15ef7973442881be76d5b1` (`perf(editor): optimize large floor plans`).
- 수정 라운드 1 커밋: `8dc15e42316dcd9eac046b9ef70524c6666ce174` (`fix(editor): harden large floor rendering`).

## 우려

- 측정은 mock API와 warm local cache 기준이며 운영 네트워크, cold browser, 저사양 현장 단말을 대표하지 않는다.
- 다중 선택된 항목은 culling에서 의도적으로 제외되므로 1,000개 전체 선택 상태의 노드 비용은 남는다. 선택/drag 정확성을 위한 계약이다.
