# Task 4 공유 지도 chrome 결과

상태: 완료. S7/S8 상단 순서·하단 한 bar 교정. Tasks1–4 이후 추가 page 수정/검증은 하지 않는다.

commit: `e27fd5104e6aa867568dfae1e5c6b4c5f9367bf8`.

## 변경 및 공개 API

- export FloorMapViewportProps에 `footerStart?: ReactNode`를 추가했다. `controlsPlacement="footer"`와 non-null slot의 명시적 opt-in만 한 full-width wrapping static footer를 만든다. legend-left/camera-right, inset px3.5/py2.5를 공통 소유하며0도 유효 slot이다. 미지정 footer는 기존 m2/self-end, 기본 overlay는 기존 absolute 배치를 유지한다.
- 카메라 JSX는 같은 handlers를 재사용하고 새로운 camera/state owner를 만들지 않는다. viewport/stage/surface/renderer subtree·overlay context·gesture/selection·showControls/showFitControl/controlAfterZoom/resetControlFits·zoom/fit/전체보기·44px/기존52px hit·viewport240 및 runtime geometry는 유지한다.
- OperationMapPanel title/tools-left 묶음→status-right, px4/py3/mobilepx3을 적용했다. 상태0도 그대로 표시하며 tools/state는 호출자가 소유한다.
- monitoring 기존 present-state icon/text legend를 footerStart로 옮기고 strip을 제거했다. manual SpatialTargetSelector만 동일 slot을 소비하고 embedded는 기존 strip·footer와 선택 정책을 유지한다. readonly/등록/그룹 선택 owner, CAD 색/scale/aspect는 변경하지 않는다.
- 영향받은 monitoring/control 메뉴 문서 다섯 필수 항목·시각/HIL 한계를 갱신했다. 계획 명시 파일 외 FloorMap.test.tsx의 기존 legend 위치 assertion을 새 실제 footer 계약으로 좁게 수정했다.
- palette/token/root/base/cn/API/DB/실장비/서버·root 계획/ledger/project-status 불변 및 root dirty 미stage.

## 검증

Node22.20.0/pnpm9.15.0 task runtime `PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH"` 재사용. 설치/lock 변경 없음.

- RED: `pnpm --filter @led-control/web exec vitest run src/components/ui/maps/OperationMapPanel.test.tsx src/features/floor-map/FloorMapViewport.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx -t 'groups title|combines footerStart|manual legend'` → exit1,3FAIL/0PASS/66filtered SKIP(69),2.75초. title/tools grouping 미구현 및 footerStart 미표시/consumer shared footer 부재의 예상 실패. task-4-red.log.
- GREEN: `pnpm --filter @led-control/web exec vitest run src/components/ui/maps/OperationMapPanel.test.tsx src/features/floor-map/FloorMapViewport.test.tsx src/features/control/target-selection/SpatialTargetSelector.test.tsx` → exit0,3files/69PASS/0FAIL/0SKIP,5.17초. task-4-green.log. 새 계약과 기존 gesture/camera/selection/embedded behavior를 확인했다.
- monitoring 관련: `pnpm --filter @led-control/web exec vitest run src/features/monitoring/FloorMap.test.tsx -t 'renders only present|shows an icon and text legend|changes the fitted map zoom'` → exit0,3PASS/0FAIL/12filtered SKIP(15),2.76초. task-4-monitoring-green.log. 필터 제외12를 전체 suite PASS로 기록하지 않는다.
- 마지막 test-only type-safe non-null parent assertion 정리 후 OperationMapPanel.test.tsx 단독 재확인 → exit0,3PASS/0FAIL/0SKIP,1.90초. task-4-chrome-green.log. runtime/product 수정 없음.
- GREEN 로그 warning 없음, git diff --check exit0. whole Web/type/UI/build/browser/E2E/Lab/canonical/HIL 미실행. Task11 한 번의 통합 검증 범위다.

## concerns / 인계

- mobile/footer wrap·dark·short desktop 실제 canvas240/외부 scroll/포커스·POST0 관찰은 Task11에 남는다. class/DOM identity 증거를 pixel 일치나 HIL 증거로 확대하지 않는다.
- 최종 type/UI/build는 아직 실행하지 않았다. Task3 child 직접 mount 테스트는 새 Shell 제목 소유에 맞춘 후속 menu 소비 검증이 필요할 수 있다.
- runtime `/tmp/atlas-ui-fidelity-node22.xde1wS/bin`을 후속 담당에게 공유하며 삭제하지 않는다. root 계획/상태 dirty는 root 소유다.
