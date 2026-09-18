# Task 7 보고서: 렌더링 최적화와 배경 오류 상태

## 상태

- 완료. fixture 1,000개, CAD slot 2,000개, map object 2,000개 상한을 전제로 렌더링 경로를 최적화했다.
- Task 6 이월 사항인 Web의 shared 소스 직접 import를 공식 `@led-control/shared/cad-import-contracts` export로 교체하고 non-default pan/zoom exact slot snap 브라우저 회귀를 추가했다.

## RED/GREEN

- RED: `editor-spatial-index`와 `use-floor-plan-image` 모듈 부재, CAD 오류 안내 부재, viewport 밖 Konva 노드 생성, 6 Layer 경고, pointer move 무제한 갱신, 1,000행 End-key focus 실패를 실제 테스트 실패로 확인했다.
- GREEN: 지정 spatial/image/view 테스트와 slot component 회귀가 통과했고 Konva 6 Layer 경고가 사라졌다.
- 첫 Chromium 실행은 stale shared CJS root의 runtime named export 때문에 앱 부팅에서 실패했다. CAD 계약 ESM subpath를 공식 export로 추가한 뒤 동일 Chromium 명령으로 9/9 통과했다.

## 최적화 구조

- `buildEditorSpatialIndex`는 입력 순서를 보존하는 deterministic cell index를 만들고 `queryEditorSpatialIndex`는 rectangle 교차, 중복 제거와 world-space margin을 적용한다.
- fixture·slot·map object는 현재 pan/zoom에서 계산한 같은 world viewport와 160px screen margin 안의 항목만 React/Konva 노드를 만든다. 선택 fixture/object와 drag 중 fixture 집합, highlighted slot은 query 밖이어도 유지한다.
- zoom 0.5 미만에서 bulk label, 비선택 fixture stroke detail과 slot dash/방향선을 줄인다. fixture 상태색, 선택 stroke와 44px screen-space hit stroke는 유지한다.
- background/grid/CAD slot을 하나의 non-listening static Layer로 합쳤다. candidate, object, fixture, overlay를 포함해 실제 측정 Stage는 4 Layer였다.
- `useFloorPlanImage`는 URL별 Image와 decode를 공유한다. 동일 URL rerender는 재생성하지 않고 URL 변경, load/decode 실패, retry와 unmount 후 완료 race를 분리한다.
- canvas pointer move와 fixture/object drag move는 최신 작업만 requestAnimationFrame에 합친다. fixture draft store는 drag end에 한 번만 commit한다.
- fixture 목록은 64px row, 16행 window를 유지하며 search/filter 변경 초기화, roving tab focus, Arrow/Home/End offscreen reveal, selection과 unplace focus 복귀를 지원한다.

## 측정

- 환경: Apple M2 Pro, macOS arm64, Chromium 149.0.7827.55, viewport 1440×900, mock API, warm local Vite/OS cache. Playwright route 특성상 HTTP cache는 비활성이고 운영 cold start 측정이 아니다.
- 준비: 제외 warm-up 뒤 같은 browser context에서 reload 20회, nearest-rank p95 648ms. 기준 3,000ms 이하 통과.
- pan/zoom: fixture 1,000개와 slot 2,000개 culling 상태의 requestAnimationFrame 257개, p95 17.1ms. 기준 33ms 이하 통과.
- drag commit: 실제 Konva dragstart/dragend 20회, nearest-rank p95 1.0ms. 기준 100ms 이하 통과.
- 각 reload에서 fixture 1,000개, slot 2,000개, Layer 4개와 CAD URL decode 1회를 확인했다.

## 변경 파일/커밋

- 신규: `editor-spatial-index.ts`, `editor-spatial-index.test.ts`, `use-floor-plan-image.ts`, `use-floor-plan-image.test.tsx`.
- 수정: `FloorEditorCanvas.tsx`, `EditorFixtureNode.tsx`, `CadPlacementSlotLayer.tsx`, `CadPlacementSlotLayer.test.tsx`, `FixturePlacementList.tsx`, `FloorEditorView.test.tsx`, `floor-placement.spec.ts`, Web CAD API/panel import, shared CAD ESM export, `docs/menus/settings.md`.
- 커밋: `0de3b43ff4e6c02edf15ef7973442881be76d5b1` (`perf(editor): optimize large floor plans`).

## 우려

- 측정은 mock API와 warm local cache 기준이며 운영 네트워크, cold browser, 저사양 현장 단말을 대표하지 않는다.
- 다중 선택된 항목은 culling에서 의도적으로 제외되므로 1,000개 전체 선택 상태의 노드 비용은 남는다. 선택/drag 정확성을 위한 계약이다.
