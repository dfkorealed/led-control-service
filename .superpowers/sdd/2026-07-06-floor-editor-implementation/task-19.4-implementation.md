# Task 19.4 구현 보고서

## 구현 요약

- DWG/DXF 원본 업로드, import job 생성, 상태 polling, 후보 검토, 취소 및 적용 UI를 추가했다.
- `queued`와 `processing` 상태에서만 1초 간격으로 polling하고, `review_required`와 terminal 상태에서는 polling을 중단한다. unmount 시 예약 timer와 응답 반영도 정리한다.
- 변환된 CAD SVG를 검토 배경으로 표시하고, 최대 1,000개 후보는 하나의 Konva `Layer` 안의 단일 `Shape`로 batch 렌더링한다.
- 후보 선택은 하나의 ID 배열/`Set`으로 관리하고 선택 또는 hover 후보에만 상세 label을 표시한다. 후보로 `Fixture` 또는 `MeshNode`를 생성하지 않는다.
- 적용 요청에 기존 FloorEditorView의 `expectedRevision`, `leaseToken`, `leaseFence`를 전달한다.
- 기존 PDF floor plan 읽기와 렌더링은 유지하고, 신규 수동 도면 업로드 선택에서는 PDF를 제거했다.

## 변경 파일

- `apps/web/src/api/floor-editor.ts`
- `apps/web/src/api/floor-editor.test.ts`
- `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`
- `apps/web/src/features/floor-editor/CadCandidateLayer.tsx`
- `apps/web/src/features/floor-editor/CadCandidateLayer.test.tsx`
- `apps/web/src/features/floor-editor/editor-types.ts`
- `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`
- `apps/web/src/features/floor-editor/FloorAssetUploadPanel.tsx`
- `apps/web/src/features/floor-editor/FloorAssetUploadPanel.test.tsx`

## TDD 증거

### RED

- 최초 focused test: 4 test files failed.
  - `CadImportPanel.tsx`, `CadCandidateLayer.tsx` 모듈 부재
  - CAD import API 함수 부재
  - 기존 PDF accept 및 PDF 업로드 동작 잔존
- MIME 호환성 RED: `application/x-dwg`가 UI에서 거부되어 `CadImportPanel` 1 test failed.
- View 통합 RED: review 배경의 `data-background-url`이 없어 CAD SVG preview test failed.

### GREEN

- focused tests: 5 files, 72 tests passed.
- floor-editor 전체 tests: 12 files, 128 tests passed.
- 1,000개 후보 테스트에서 Konva Layer 1개와 batch Shape 1개를 확인했다.
- queued/processing polling, review/terminal 정지, unmount cleanup, fenced apply payload를 테스트로 확인했다.

## 검증

- `pnpm --filter @led-control/web test -- src/api/floor-editor.test.ts src/features/floor-editor/CadImportPanel.test.tsx src/features/floor-editor/CadCandidateLayer.test.tsx src/features/floor-editor/FloorAssetUploadPanel.test.tsx src/features/floor-editor/FloorEditorView.test.tsx`: PASS, 72/72
- `pnpm --filter @led-control/web test -- src/features/floor-editor`: PASS, 128/128
- `pnpm --filter @led-control/web typecheck`: PASS
- `pnpm --filter @led-control/web build`: PASS
- `pnpm --filter @led-control/web test:ui-policy`: PASS, 53/53
- `pnpm --filter @led-control/web ui:check`: PASS, 기존/신규 위반 0
- `git diff --check`: PASS

첫 build는 shared 루트 CommonJS entry가 신규 CAD runtime export를 Rollup named export로 노출하지 못해 실패했다. brief 범위 밖 shared package를 수정하지 않고, 계약의 MIME 목록을 `CadImportMimeType`으로 검증한 웹 상수로 사용한 뒤 같은 build를 재실행해 통과했다.

## 커밋

- 구현 커밋: `38977cf08012fa2d8ca7fd0b8ab78ccdd7bf9385` (`feat(web): add CAD floor import review UI`)

## 남은 한계

- 현재 API에는 층별 활성 import job 조회 endpoint가 없으므로 페이지를 새로 열었을 때 진행 중인 job을 자동 재발견하지 못한다. 현재 세션에서 시작한 job의 polling과 cleanup은 지원한다.
- 후보 hit testing은 최대 1,000개 배열을 대상으로 수행한다. React/Konva 노드 수는 batch 처리하지만, 후보 상한이 커지면 공간 인덱스가 필요하다.
- DWG 변환 가능 여부와 정확도는 서버에 설정된 CAD converter 및 규칙 기반 detector 결과에 의존한다. AI detector는 현재 범위대로 비활성 상태다.
