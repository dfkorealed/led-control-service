# 층별 도면 에디터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**목표:** 설정의 층별 에디터에서 1,000개 조명 검색·드래그 배치·확인 후 배치 해제·일괄 편집·실물 위치 확인을 제공한다. 파일 도면 활용은 보류한다.

**구조:** 기존 Konva 에디터와 atomic save/lease/revision을 확장하고 배치 상태를 장비 등록 상태에서 분리한다. 읽기 전용 지도만 미배치 마커를 제외하며 제어·통계에는 전체 등록 조명을 유지한다. 식별 점멸은 독립된 등록 후 장비 명령으로 연결한다.

**기술:** React, TypeScript, React Query, Zustand, Konva, NestJS, Prisma, PostgreSQL, MQTT, BlueZ, ESP-IDF, Jest, Vitest, Playwright.

**설계:** [층별 도면 에디터 설계](../specs/2026-07-06-floor-editor-design.md)의 `2026-09-09 최종 구현 범위`.

## 2026-09-09 대량 배치 실행 계획

상태: 2026-09-09 사용자 구현 승인으로 실행 중. 이 절이 활성 체크리스트이며 하단 작업/진행 로그는 기존 구현 이력이다. 실장비 검증은 사용자 요청으로 후속이며 소프트웨어 구현·실DB·브라우저 검증을 진행한다.

진행 기록:
- backend: Task 1/10 및 Task 2 서버 배치 분리 완료. Shared 172, API 800, 격리 DB/HTTP 18 테스트와 typecheck/build 및 독립 코드 검토를 통과했다. 등록 웹의 좌표 입력 제거와 전체 브라우저 연동은 web_frontend 작업에서 검증한다.
- web_frontend: Task 3~7 및 9의 층별 UI·목록 드롭·확인 후 배치 해제·대량 편집 진행 중.
- gateway/backend: Task 8 등록 후 Health Attention 명령 진행 중. firmware 출력 우선순위 단위는 구현·host 테스트·ESP-IDF 빌드 및 독립 코드 검토 완료.
- 총괄: 공유 계약/소유 범위 조율, 통합 검증과 문서/커밋 진행. 실제 장비 동작 검증·배포는 실행하지 않는다.

### 공통 규칙

- `AGENTS.md`, `docs/agent-operations.md`, `docs/lesson_leared.md`와 해당 경로 지침을 읽고 시작한다. 담당 역할별로 검증 가능한 작은 변경을 진행하고 공유 계약은 총괄 검토 후 한 역할이 먼저 적용한다.
- 각 Task는 회귀 작성·구현·검증·메뉴 문서/상태판 갱신·범위별 커밋 순서로 완료한다. 구현 완료와 실장비 검증 완료를 분리한다.
- 위치 데이터와 장비 식별 명령을 분리한다. 배치 해제에 장비 삭제/초기화/그룹 변경/제어 명령을 연결하지 않는다.
- 입력 상한은 fixture 변경 1,000개, 기존 object mutation 합계 2,000개를 유지한다. 에디터 요청 body는 1 MiB로 명시하고 초과 요청은 일관된 413으로 표시한다. 기존 과대 데이터가 있을 때 마이그레이션으로 잘라내지 않는다.
- UI는 한글과 기존 공통 컴포넌트를 사용한다. 도면 업로드/교체와 CAD/AI 확장은 실행하지 않는다. 기존 자산과 기존 좌표는 유지한다.

### Task 1: 배치 상태와 저장 버전 계약 / backend

대상: `apps/api/prisma/schema.prisma`, 해당 migration, `packages/shared/src/schemas.ts`, `apps/api/src/floor-editor/floor-editor-snapshot.ts`, `docs/database-schema.md`.

제안 공통 값:

```ts
type FixturePlacement = {
  placementStatus: 'unplaced' | 'placed';
  positionVerifiedAt: string | null;
};
// 저장 입력은 확인 시각을 신뢰하지 않고 서버가 명시적 위치 확인에 시각을 부여한다.
type PlacementPatch = { placementStatus?: 'unplaced' | 'placed'; positionVerified?: boolean };
```

- [x] 신규 조명 기본 unplaced, 기존 row placed/미확인, 기존 x/y 보존 migration을 작성하고 이전/신규 row와 이전 snapshot 호환 테스트를 실행한다.
- [x] 배치 상태/위치 확인 필드를 editor 조회·저장·snapshot에 전파하고 새 snapshot 버전과 이전 버전 parser를 연결한다. unplaced 확인 금지와 좌표 변경 시 확인 해제를 검증한다.
- [x] shared/API 타입 및 migration 통합 검증 뒤 DB 문서/메뉴/상태판을 갱신하고 커밋한다.

### Task 2: 등록과 배치 분리 / backend

대상: `apps/api/src/registration/registration.service.ts`, `apps/api/src/floor-editor/floor-editor.service.ts`, `apps/api/src/floor-map/floor-map.service.ts`, 조명/대시보드 조회 소비자.

- [ ] 캔버스 공간이 가득 차도 신규 등록이 성공하고 unplaced로 생성되는 회귀를 추가한다. 최신 웹에서는 등록 단계 배치 입력을 제거하고 구버전 요청의 기존 필드 수신 정책을 명시적으로 호환 처리한다.
  서버와 회귀 완료: 구버전 placement 입력은 호환 수신 후 무시한다. 웹 입력 제거는 Task 9와 함께 검증 중이다.
- [ ] 지도 마커의 배치 필터를 조회·제어·통계 집계 필터와 분리한다. 편집기는 미배치 조명도 포함한 전체 편집 상태를 제공한다.
- [x] 미배치 전환 전후 fixture ID, Mesh 주소, 그룹 멤버, 자동화 대상, 전력 이력이 동일한지 실DB 테스트 후 관련 문서 갱신과 커밋을 진행한다.

### Task 3: 1,000개 렌더링 기반 / web_frontend

대상: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`, `editor-store.ts`, 신규 `EditorFixtureNode.tsx`, `apps/web/src/features/floor-map/FloorScene.tsx`.

- [ ] 기존 1,000개 fixture 브라우저 시나리오에 pan/zoom 프레임 측정과 안정적인 ref 유지 검사를 추가해 기준을 기록한다.
- [ ] 배경/도형/조명/선택 레이어와 Zustand selector를 분리하고 조명 노드를 memo 처리한다. pan/zoom 중 반복적인 전체 React 상태 갱신을 제거한다.
- [ ] 화면 크기 Stage와 단일 좌표 변환 경로, 저배율 이름 축소, locked 객체의 상호작용 차단을 검증하고 문서 갱신 후 커밋한다.

### Task 4: 편집 명령과 Undo/Redo / web_frontend

대상: `editor-store.ts`, `editor-diff.ts`, 신규 `editor-history.ts`, `FloorEditorView.tsx`, `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`.

- [ ] `placeFixtures`, `unplaceFixture`, `moveFixtures`, `updateFixtureProperties` 동작을 한 번의 이력 항목으로 적용한다. ID별 변경 추적과 재배치/배치 해제/Undo/Redo 왕복 검증을 작성한다.
- [ ] 저장 후 에디터를 유지하고 응답으로 baseline/cache를 교체한다. 저장 실패/충돌에서 초안을 보존하고 서버 버전 복구와 로컬 Undo를 구분한다.
- [ ] 로컬 초안은 사용자·현장·층·baseline revision으로 격리하고 로그아웃 시 제거한다. 복구 시 권한과 revision을 다시 확인하며 lease가 없으면 변경을 차단한다. 문서 갱신 후 커밋한다.

### Task 5: 목록 드롭과 확인 팝업 배치 해제 / web_frontend

대상: 신규 `FixturePlacementList.tsx`, `FixturePlacementAction.tsx`, `UnplaceFixtureDialog.tsx`, `FloorEditorCanvas.tsx`, 공통 dialog/button 컴포넌트.

- [ ] 미배치 목록에서 fixture ID만 드래그하고 캔버스 drop에서 현재 층/상태를 다시 확인한다. 화면에서 월드 좌표로 변환한 중심점에 한 번 배치한다.
- [ ] 단일 선택 조명 우상단에 화면 크기 고정 배치 해제 버튼을 추가한다. 핸들 중첩, 경계 넘침, 클릭 이벤트 전파를 차단한다.
- [ ] 설계의 정확한 팝업 문구와 취소/확인/포커스 복귀를 구현한다. 승인 후 로컬 미배치 목록 복귀와 저장/Undo/재드롭을 검증한다.
- [ ] 0.5배/1배/2배 및 pan/스크롤 상태의 드롭, 캔버스 밖 취소, 중복 drop, lease 만료, viewer 변경 차단 브라우저 회귀 후 문서 갱신과 커밋을 진행한다.

### Task 6: 검색과 지도 탐색 / web_frontend

대상: `FixturePlacementList.tsx`, `FloorEditorView.tsx`, `FloorEditorCanvas.tsx`, `EditorPropertiesPanel.tsx`.

- [ ] 이름/현재 제공 가능한 시리얼·Mesh 주소 검색, 전체/배치/미배치 필터와 가상화 목록, 선택 수/배치 수를 추가한다. 식별자 DTO가 없으면 backend와 shared 계약을 먼저 확장한다.
- [ ] 검색 결과 선택은 배치 조명일 때 위치로 이동하고 미배치이면 목록/속성에 머문다. 도면 맞춤·선택 맞춤·미니맵·휠 줌·팬을 연결한다.
- [ ] 우측 속성/배치/레이어 탭에 기본 도형과 색상 기능을 유지하고 배경 업로드/교체 진입점을 숨긴다. 저장된 기존 배경 호환 표시와 1,000번째 항목 탐색을 검증한 뒤 문서 갱신과 커밋을 진행한다.

### Task 7: 대량 선택과 반자동 배치 / web_frontend

대상: 신규 `editor-placement.ts`, `EditorBatchPlacementPanel.tsx`, `editor-store.ts`, `EditorPropertiesPanel.tsx`, `FloorEditorCanvas.tsx`.

- [ ] 박스/Shift 선택, 필터 결과 전체 선택, 다중 이동, 화살표 이동, 스냅, 정렬/균등 분배를 구현한다. 잠긴 항목을 제외하고 그룹 이동 경계는 선택 집합에 동일한 이동량을 적용한다.
- [ ] 사각형 영역 격자/통로 선형 배치의 대상 ID·행/열·간격·방향 미리보기와 취소/적용을 구현한다. 공간이 부족하면 개수/간격을 수정하도록 안내하고 겹침이나 누락을 숨기지 않는다.
- [ ] 이름 규칙·표시 크기·정격 W 일괄 속성을 혼합값/결과 미리보기와 연결한다. 24개 일괄 배치의 단일 Undo, 1,000개 이동, fixture 복제 없음과 제어 그룹 불변을 검증하고 커밋한다.

### Task 8: 실물 조명 위치 확인 / backend → gateway → firmware → web_frontend

대상: `packages/shared/src/schemas.ts`, `gateway-contracts.ts`, 등록 후 fixture 명령 API, `apps/gateway/src/mesh/bluez-mesh-adapter.ts`, Health client 경로, `apps/esp32-h2-firmware/main/identify.c`, `ble_mesh_node.c`, 신규 웹 `FixtureIdentifyPanel.tsx`.

- [ ] 공유 명령에 fixture ID/site/gateway/command ID와 절대 만료 시각을 정의하고 시작/중지/결과를 분리한다. 현장 admin, 현재 lease, online/등록 상태, 단일 진행 대상을 서버에서 검증한다.
- [ ] Gateway가 Health Attention 시작/중지와 응답을 처리하고 중복/만료/응답 없음/다음 대상 전환 시 이전 대상 중지를 처리한다. 기존 identify의 100% 고정 동작을 사용하지 않는다.
- [x] ESP32에서 자체 만료와 종료/재시작 처리를 검증하고 식별 중 정상 제어 목표를 보존한다. 시작 당시 밝기가 아닌 최신 목표로 돌아가도록 PWM 출력 우선순위를 정리한다. 12개 fake driver 시나리오와 portable 상태 테스트, ESP-IDF compile-only 빌드/산출물 감사 및 독립 코드 검토를 통과했다. 서비스의 10초 한도는 API/Gateway가 강제하며 펌웨어는 표준 Health Attention의 1~255초를 수용한다. 실제 RF/LED 동작은 미검증이다.
- [ ] 웹의 확인 시작/중지/다음/건너뛰기와 위치 클릭·명시적 확인을 연결한다. 명령 응답과 사람의 위치 확인을 구분해 저장한다.
- [ ] 소프트웨어 계약·Gateway·firmware host 테스트 및 ESP-IDF build를 통과한 각 소단위마다 커밋한다. 실제 LED 점멸/종료/스케줄·이벤트 복귀는 HIL 완료 전까지 미검증으로 남긴다.

### Task 9: 모니터링·제어·통계 연동 / web_frontend + backend

대상: `apps/web/src/features/floor-map/FloorScene.tsx`, 모니터링 목록/빈 상태, 제어 대상 선택, API 대시보드/통계 조회와 각 회귀 테스트.

- [ ] 지도에서 unplaced만 제외하고 목록에는 남긴다. 등록 1,000개/배치 0개와 등록 0개의 안내를 구분하고 설정 편집 진입을 제공한다.
- [ ] 배치 해제 후 수동 제어, 기존 그룹/스케줄/이벤트 대상 유지와 전력 합계를 실백엔드에서 검증한다. 사용자가 저장하기 전에는 모니터링 지도가 바뀌지 않도록 한다.
- [ ] 저장/재조회/revision 복구 후 배치/위치 확인 상태와 도형이 일치하는지 검증하고 영향받는 메뉴 문서를 갱신한 뒤 커밋한다.

### Task 10: 대량 저장·복구 안정성 / backend

대상: `apps/api/src/main.ts`, `apps/api/src/floor-editor/floor-editor.service.ts`, snapshot parser와 실DB/HTTP 통합 테스트.

- [x] 1,000개 fixture 전체 필드와 2,000개 object 변경을 실제 HTTP 경로로 보내 body 상한/검증 응답을 확인한다. 좌표 변경을 묶음 SQL로 처리하며 정격 W 변경은 기존 에너지 checkpoint를 보존한다.
- [x] 저장·복구 시간 예산과 timeout 오류 응답을 명시하고 lease/revision/atomic audit 경계를 유지한다. 실패 시 일부 row나 revision만 저장되지 않는 회귀를 실행한다.
- [x] snapshot 크기/복구 지연을 100회 저장으로 측정한다. 새 snapshot 버전·해시와 이전 버전 파서를 검증하고 기존 이력을 자동 삭제하지 않는다. 장기 보관 정책은 측정 결과와 함께 문서에 제안값으로 남긴다.
- [x] 관련 API 테스트/typecheck와 문서를 갱신하고 커밋한다. 2026-09-09 로컬 Mac 격리 PostgreSQL/HTTP 최종 재실행: 저장 100회 p95 425ms, 복구 485ms. 실제 운영 부하/HIL 성능 보장은 아니다.

### Task 11: 통합 검증과 완료 판정 / qa_reviewer

- [ ] 브라우저 정상 흐름을 검증한다: 신규 등록 → 미배치 → 목록 드롭 → 다중 배치 → 위치 확인 초안 → 저장 → 모니터링 → 배치 해제 취소/승인 → 저장 → 제어/통계 유지 → 재배치.
- [ ] 1,000개 조명으로 대표 PC 1440/1024, 좁은 화면 390/320의 패널/버튼 겹침을 확인한다. 성능 합격 목표는 편집 준비 p95 3초 이내, 연속 이동 중 장시간 30fps 미만 구간 없음, 대량 저장 p95 3초 이내다. 하드웨어/브라우저/회차를 증거에 기록한다.
- [ ] 일반적인 데이터 손실 경로인 새로고침, 저장 실패, lease 만료, 계정 전환, Undo 후 저장, 이전 revision 복구를 점검한다. 인터랙티브 시안은 생산 코드 검증 증거로 사용하지 않는다.
- [ ] 실장비가 준비되면 Raspberry Pi/ESP32-H2/LED로 식별 시간 제한, 중지, 다음 조명 전환과 자동제어 복귀를 실행한다. 실장비 부재는 UI/소프트웨어 완료와 구분한다.
- [ ] 발견된 오류를 소유 역할에 반환하고 수정 후 필요한 회귀를 재실행한다. 최종 상태판/메뉴 문서와 이 체크리스트를 일치시키고 작업 단위별 커밋을 확인한다.

### 실행 순서와 범위 검토

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 순서다. Task 8의 공유 계약/API → Gateway → firmware → 웹 순서는 유지한다. 독립된 backend 대량 저장 최적화는 공유 계약 완료 후 웹 작업과 병렬 진행할 수 있다.

- [x] 미배치 목록 드래그 앤 드롭: Task 5.
- [x] 단일 선택 조명 우상단 버튼과 확인 팝업: Task 5.
- [x] 장비 삭제가 아닌 미배치 복귀: Task 1, 2, 4, 5, 9.
- [x] 기존 파일 도면 활용 보류와 기존 자산 보존: Task 6.
- [x] 앞서 제안한 검색/일괄 편집/식별/성능 보완: Task 3, 4, 6, 7, 8, 10, 11.

위 체크는 계획 범위 대조 완료를 뜻하며 구현 완료가 아니다.

---

## 진행 로그

### 2026-07-07 09:30 Konva 에디터 전환

- 완료된 작업: `FloorEditorCanvas`를 DOM 절대좌표 요소 기반에서 `react-konva` Stage/Layer/Transformer 기반으로 전환했다.
- 완료된 작업: 좌측 툴바의 도형 도구를 도면 위로 HTML drag/drop할 때 Konva 좌표계로 변환해 기본 크기 객체가 생성되도록 수정했다.
- 완료된 작업: 좌측 도구 선택 후 도면 내부를 드래그해 크기를 지정하는 생성 방식도 Konva 캔버스와 DOM fallback 이벤트에서 동작하도록 유지했다.
- 완료된 작업: 도형/텍스트 객체는 Konva Transformer의 모서리/변 핸들로 리사이즈하고, 조명 객체도 동일하게 Transformer로 크기를 조절한다.
- 완료된 작업: 조명 리사이즈 저장을 위해 `Fixture.size` DB 컬럼과 API/update payload를 추가했다.
- 검증 완료:
  - `PATH="/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH" pnpm --filter @led-control/web test -- FloorEditorView.test.tsx geometry.test.ts`

### 2026-07-07 09:02 에디터 편집 UX 보강 완료

- 완료된 작업: 좌측 도구에서 네모, 세모, 선, 텍스트 객체를 클릭 생성이 아니라 툴바 도구를 도면 위로 드래그 앤 드롭해 생성하도록 변경했다.
- 완료된 작업: 좌측 도구 선택 후 캔버스 내부를 드래그해 크기를 지정하는 보조 생성 방식은 유지하되, 단순 클릭만으로 객체가 생성되지 않도록 변경했다.
- 완료된 작업: 생성된 도형/텍스트 객체를 선택 모드에서 드래그 이동할 수 있게 했다. 드래그 시작 지점과 객체 좌상단 사이의 offset을 유지해 마우스 포인터를 자연스럽게 따라간다.
- 완료된 작업: 선택된 도형/텍스트 객체에 우하단 리사이즈 핸들을 표시하고, 핸들 드래그로 `width/height`를 변경할 수 있게 했다.
- 완료된 작업: 채우기 색상 입력을 선 색상과 동일한 color palette 입력으로 변경했다. 기본 도형 fill 색상은 팔레트 입력과 호환되는 hex 값으로 정리했다.
- 검증 완료:
  - `PATH="/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH" pnpm --filter @led-control/web test -- FloorEditorView.test.tsx geometry.test.ts`
  - `PATH="/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH" pnpm --filter @led-control/web typecheck`
- 남은 개선: 도형 다중 선택/일괄 이동, 삭제, 복사/붙여넣기, 4방향/8방향 리사이즈, 회전, grid snap, undo/redo는 후속 MVP 범위다.

### 2026-07-06 15:31 통합 구현 완료

- 완료된 작업: Prisma schema와 migration에 `FloorPlanSourceType`, `FloorPlan` 확장 필드, `FloorMapObject`를 추가하고 로컬 PostgreSQL에 migration을 적용했다.
- 완료된 작업: `floor-editor` NestJS module/controller/service를 추가하고 조직 범위 guard를 적용했다. `GET /floors/:floorId/editor-state`는 웹 에디터가 바로 사용할 수 있는 `{ floor, fixtures, objects }` DTO 형태로 반환한다.
- 완료된 작업: 모니터링 화면의 `도면 편집` 진입점, 에디터 상단바, 툴바, 캔버스, 배경 업로더, 속성 패널, 저장/취소 흐름을 구현했다.
- 완료된 작업: 배경 없음, JPG/PNG data URL 배경, PDF 첫 페이지 렌더링 배경, 줌/패닝, 네모/세모/선/텍스트 추가, 조명 단일 드래그 및 기본 정보 수정, 저장 후 query invalidate를 구현했다.
- MVP 한계: 업로드 파일은 아직 별도 파일 스토리지에 저장하지 않고 data URL로 `FloorPlan`에 저장한다. 운영 전에는 정적 업로드 디렉터리 또는 S3 호환 저장소로 분리해야 한다.
- 검증 완료:
  - `pnpm --filter @led-control/api test -- floor-editor.service.spec.ts sites.service.spec.ts --runInBand`
  - `pnpm --filter @led-control/web test -- geometry.test.ts FloorEditorView.test.tsx App.test.tsx`
  - `pnpm typecheck`
  - `git diff --check`

### 2026-07-06 15:20 문서/검토 서브 에이전트 갱신

- 당시 상태: Task 1 의존성 설치가 완료되었고, 나머지 구현은 통합 전이었다. 코드 구현은 다른 에이전트가 진행할 수 있으므로 이 문서는 통합 중단에 대비한 기준점으로 사용했다.
- 완료된 작업: 메인 에이전트가 `pnpm --filter @led-control/web add konva react-konva pdfjs-dist`를 실행한 뒤 React 18 peer 호환을 위해 `react-konva@18.2.16`으로 조정했다. `pnpm --filter @led-control/web typecheck`는 PATH를 명시한 실행 환경에서 통과했다.
- Subagent-Driven 분담:
  - 백엔드 에이전트: Prisma schema/migration, `floor-editor` API, 조직 범위 guard, 서비스 테스트를 담당한다.
  - 웹 에이전트: `react-konva` 기반 에디터 화면, Zustand draft 상태, 도형/텍스트/조명 드래그 편집, 저장/취소 흐름을 담당한다.
  - 문서/검토 에이전트: `docs/menus/monitoring.md`, `docs/database-schema.md`, 서비스 설계 문서, 이 계획서의 진행 상태를 실제 구현 상태에 맞춰 갱신한다.
- 예상 통합 순서:
  1. Task 2로 Prisma 모델과 migration을 먼저 합친다.
  2. Task 3-4로 백엔드 테스트와 API를 통과시킨 뒤 editor-state 응답 계약을 고정한다.
  3. Task 5-7로 웹 타입, API client, 좌표 변환 helper, 에디터 store를 붙인다.
  4. Task 8-13으로 UI shell, canvas 렌더링, 편집 상호작용, 저장/취소, 배경 등록, 모니터링 진입점을 순서대로 연결한다.
  5. Task 14-15에서 문서를 완료 상태로 재분류하고 API/Web/typecheck/manual 검증을 수행한다.
- 당시 문서 상태: 메뉴/DB/설계 문서는 완료가 아니라 `구현 중`과 `예정`을 명시해 두었다. 실제 코드와 migration이 합쳐진 뒤 Task 14에서 완료 항목으로 이동했다.

## 1. 목표 범위

MVP 1에서 구현한다.

- 모니터링 페이지 `에디터` 버튼
- 선택 층 기준 전체 화면 편집 모드
- 도면 배경 선택 등록
  - 배경 없음 허용
  - JPG/PNG
  - PDF 첫 페이지 렌더링
- 줌인, 줌아웃, 팬
- 네모, 세모, 선, 텍스트 추가/수정
- 도형 색상, 선 두께, 텍스트 수정
- LED 조명 선택, 드래그 이동
- 조명 이름, 정격 W, 좌표 수정
- 저장, 취소
- 저장 후 dashboard 갱신

MVP 1에서 구현하지 않는다.

- 다중 조명 일괄 이동
- CAD/DWG/DXF import
- AI 도면 해석
- RF heatmap
- 전체 undo/redo 이력

## 2. 목표 파일 구조

### Backend

- Modify: `apps/api/prisma/schema.prisma`
  - `FloorPlan.sourceType`, `originalFileUrl`, `renderedImageUrl` 추가
  - `FloorMapObject` 모델 추가
- Create: `apps/api/prisma/migrations/<timestamp>_add_floor_editor/migration.sql`
- Create: `apps/api/src/floor-editor/floor-editor.module.ts`
- Create: `apps/api/src/floor-editor/floor-editor.controller.ts`
- Create: `apps/api/src/floor-editor/floor-editor.service.ts`
- Create: `apps/api/src/floor-editor/floor-editor.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/sites/sites.service.ts`

### Web

- Create: `apps/web/src/api/floor-editor.ts`
- Create: `apps/web/src/features/floor-editor/editor-types.ts`
- Create: `apps/web/src/features/floor-editor/editor-store.ts`
- Create: `apps/web/src/features/floor-editor/geometry.ts`
- Create: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Create: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Create: `apps/web/src/features/floor-editor/EditorToolbar.tsx`
- Create: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`
- Create: `apps/web/src/features/floor-editor/FloorAssetUploader.tsx`
- Create: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`
- Create: `apps/web/src/features/floor-editor/geometry.test.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/styles.css`

### Docs

- Modify: `docs/menus/monitoring.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md`

## 3. Task 1: 에디터 라이브러리 설치

**Files:**

- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Install dependencies**

Run:

```bash
pnpm --filter @led-control/web add konva react-konva pdfjs-dist
```

Expected:

```text
dependencies:
+ konva
+ react-konva
+ pdfjs-dist
```

Result: React 18 peer 호환을 위해 `react-konva@18.2.16`으로 조정했다.

- [x] **Step 2: Verify install**

Run:

```bash
pnpm --filter @led-control/web typecheck
```

Expected: pass.

Result: PATH를 명시한 실행 환경에서 통과했다.

## 4. Task 2: Prisma 모델 추가

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_floor_editor/migration.sql`

- [ ] **Step 1: Update Prisma schema**

Add enum:

```prisma
enum FloorPlanSourceType {
  none
  image
  pdf
}
```

Extend `FloorPlan`:

```prisma
model FloorPlan {
  id               String              @id @default(uuid())
  floorId          String              @unique
  imageUrl         String
  width            Int
  height           Int
  version          Int                 @default(1)
  sourceType       FloorPlanSourceType @default(image)
  originalFileUrl  String?
  renderedImageUrl String?
  floor            Floor               @relation(fields: [floorId], references: [id])
  createdAt        DateTime            @default(now())
  updatedAt        DateTime            @updatedAt
}
```

Add model:

```prisma
model FloorMapObject {
  id          String   @id @default(uuid())
  floorId     String
  type        String
  x           Float
  y           Float
  width       Float?
  height      Float?
  rotation    Float    @default(0)
  points      Json?
  text        String?
  strokeColor String   @default("#0b63e5")
  fillColor   String?
  strokeWidth Float    @default(2)
  fontSize    Float?
  zIndex      Int      @default(0)
  locked      Boolean  @default(false)
  visible     Boolean  @default(true)
  floor       Floor    @relation(fields: [floorId], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([floorId, zIndex])
}
```

Add relation to `Floor`:

```prisma
mapObjects FloorMapObject[]
```

- [ ] **Step 2: Create migration**

Run:

```bash
pnpm --filter @led-control/api prisma migrate dev --name add_floor_editor
```

Expected: migration created and applied.

- [ ] **Step 3: Generate Prisma client**

Run:

```bash
pnpm --filter @led-control/api prisma:generate
```

Expected: generated client without errors.

## 5. Task 3: Backend service tests

**Files:**

- Create: `apps/api/src/floor-editor/floor-editor.service.spec.ts`

- [ ] **Step 1: Write editor-state test**

Create tests for:

```ts
it("returns editor state for a floor in the current organization", async () => {});
it("rejects editor state access for another organization", async () => {});
```

Expected behavior:

- Service checks `floor.site.organizationId`.
- Response includes `floor`, `floorPlan`, `fixtures`, `objects`.

- [ ] **Step 2: Write fixture update test**

Create tests for:

```ts
it("updates fixture name rated watt and position inside the current organization", async () => {});
it("rejects fixture update outside the current organization", async () => {});
```

- [ ] **Step 3: Write map object CRUD tests**

Create tests for:

```ts
it("creates a rectangle map object", async () => {});
it("updates a text map object", async () => {});
it("deletes a map object", async () => {});
```

- [ ] **Step 4: Run failing tests**

Run:

```bash
pnpm --filter @led-control/api test -- floor-editor.service.spec.ts --runInBand
```

Expected: fail because module/service does not exist.

## 6. Task 4: Backend floor-editor module 구현

**Files:**

- Create: `apps/api/src/floor-editor/floor-editor.module.ts`
- Create: `apps/api/src/floor-editor/floor-editor.controller.ts`
- Create: `apps/api/src/floor-editor/floor-editor.service.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Create service input types**

Implement internal service inputs:

```ts
export interface UpdateFixtureEditorInput {
  organizationId: string;
  fixtureId: string;
  name?: string;
  ratedWatt?: number;
  x?: number;
  y?: number;
}
```

```ts
export interface UpsertMapObjectInput {
  organizationId: string;
  floorId: string;
  type: "rectangle" | "triangle" | "line" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  points?: unknown;
  text?: string;
  strokeColor?: string;
  fillColor?: string;
  strokeWidth?: number;
  fontSize?: number;
  zIndex?: number;
}
```

- [ ] **Step 2: Implement organization guards**

Every query must verify ownership through `site.organizationId`.

```ts
await prisma.floor.findFirst({
  where: { id: floorId, site: { organizationId } }
});
```

- [ ] **Step 3: Implement endpoints**

Controller routes:

```text
GET /floors/:floorId/editor-state
PATCH /floors/:floorId/floor-plan
PATCH /fixtures/:fixtureId
POST /floor-map-objects
PATCH /floor-map-objects/:objectId
DELETE /floor-map-objects/:objectId
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @led-control/api test -- floor-editor.service.spec.ts --runInBand
```

Expected: pass.

## 7. Task 5: Web API client와 타입

**Files:**

- Create: `apps/web/src/api/floor-editor.ts`
- Create: `apps/web/src/features/floor-editor/editor-types.ts`

- [ ] **Step 1: Define editor types**

Create:

```ts
export type EditorTool = "select" | "pan" | "fixture" | "rectangle" | "triangle" | "line" | "text";
export type MapObjectType = "rectangle" | "triangle" | "line" | "text";
```

Define `FloorEditorState`, `EditorFixture`, `FloorMapObject`.

- [ ] **Step 2: Implement API client**

Functions:

```ts
export function getFloorEditorState(floorId: string) {}
export function updateFloorPlan(floorId: string, payload: UpdateFloorPlanPayload) {}
export function updateEditorFixture(fixtureId: string, payload: UpdateEditorFixturePayload) {}
export function createFloorMapObject(payload: CreateFloorMapObjectPayload) {}
export function updateFloorMapObject(objectId: string, payload: UpdateFloorMapObjectPayload) {}
export function deleteFloorMapObject(objectId: string) {}
```

## 8. Task 6: Geometry unit tests

**Files:**

- Create: `apps/web/src/features/floor-editor/geometry.ts`
- Create: `apps/web/src/features/floor-editor/geometry.test.ts`

- [ ] **Step 1: Write tests**

Test:

```ts
it("converts screen coordinates to world coordinates with zoom and pan", () => {});
it("moves a fixture by a delta and clamps it inside the floor plan", () => {});
it("creates default rectangle triangle line and text objects", () => {});
```

- [ ] **Step 2: Implement helpers**

Functions:

```ts
export function screenToWorld(point, viewport) {}
export function clampPoint(point, bounds) {}
export function moveByDelta(point, delta, bounds) {}
export function createDefaultObject(type, point) {}
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @led-control/web test -- geometry.test.ts
```

Expected: pass.

## 9. Task 7: Editor store

**Files:**

- Create: `apps/web/src/features/floor-editor/editor-store.ts`

- [ ] **Step 1: Implement Zustand state**

State:

```ts
interface FloorEditorStore {
  tool: EditorTool;
  zoom: number;
  pan: { x: number; y: number };
  selectedId: string | null;
  dirtyFixtureIds: string[];
  dirtyObjectIds: string[];
  setTool(tool: EditorTool): void;
  setZoom(zoom: number): void;
  setPan(pan: { x: number; y: number }): void;
  select(id: string | null): void;
  markFixtureDirty(id: string): void;
  markObjectDirty(id: string): void;
  resetEditor(): void;
}
```

## 10. Task 8: FloorEditorView shell

**Files:**

- Create: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Create: `apps/web/src/features/floor-editor/EditorToolbar.tsx`
- Create: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`
- Create: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

- [ ] **Step 1: Write shell test**

Test:

```ts
it("renders toolbar canvas properties panel save and cancel actions", async () => {});
```

- [ ] **Step 2: Implement shell**

Layout:

```text
topbar: floor name, zoom buttons, save, cancel
left: toolbar
center: FloorEditorCanvas
right: properties panel
```

- [ ] **Step 3: Run test**

Run:

```bash
pnpm --filter @led-control/web test -- FloorEditorView.test.tsx
```

Expected: pass.

## 11. Task 9: Konva canvas 렌더링

**Files:**

- Create: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

- [ ] **Step 1: Render background optional**

Rules:

- If `floorPlan.renderedImageUrl` or `floorPlan.imageUrl` exists, render image background.
- If no background exists, render grid background.

- [ ] **Step 2: Render fixtures**

Fixture marker rules:

- online: blue
- offline: gray
- fault: red
- selected: outline

- [ ] **Step 3: Render map objects**

Render:

- rectangle
- triangle
- line
- text

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @led-control/web test -- FloorEditorView.test.tsx
```

Expected: pass.

## 12. Task 10: 편집 상호작용

**Files:**

- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`

- [ ] **Step 1: Implement zoom controls**

Buttons:

```text
확대
축소
100%
```

Clamp zoom:

```ts
min = 0.25;
max = 4;
```

- [ ] **Step 2: Implement pan tool**

When tool is `pan`, drag empty canvas to move viewport.

- [ ] **Step 3: Implement fixture drag**

When selected fixture is dragged, update draft `x/y` and mark fixture dirty.

- [ ] **Step 4: Implement object creation**

When tool is `rectangle`, `triangle`, `line`, or `text`, click canvas to create default object.

- [ ] **Step 5: Implement property edits**

Properties panel updates:

- fixture name
- fixture ratedWatt
- fixture x/y
- object strokeColor
- object fillColor
- object strokeWidth
- object text
- object fontSize

## 13. Task 11: 저장/취소

**Files:**

- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/api/floor-editor.ts`

- [ ] **Step 1: Save changed fixtures**

For each dirty fixture:

```ts
await updateEditorFixture(fixture.id, {
  name: fixture.name,
  ratedWatt: fixture.ratedWatt,
  x: fixture.x,
  y: fixture.y
});
```

- [ ] **Step 2: Save changed objects**

For new objects call `createFloorMapObject`.

For existing dirty objects call `updateFloorMapObject`.

- [ ] **Step 3: Save floor plan background**

If floor plan changed, call `updateFloorPlan`.

- [ ] **Step 4: Invalidate dashboard**

After save:

```ts
queryClient.invalidateQueries({ queryKey: ["dashboard"] });
```

- [ ] **Step 5: Cancel**

Cancel discards draft and exits edit mode.

## 14. Task 12: MonitoringView 연결

**Files:**

- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Add edit mode state**

Add:

```ts
const [isEditing, setIsEditing] = useState(false);
```

- [ ] **Step 2: Add editor button**

Button:

```text
에디터
```

Only show when `data.site.id` and selected floor exist.

- [ ] **Step 3: Render FloorEditorView**

If `isEditing`:

```tsx
<FloorEditorView floorId={floor.id} onClose={() => setIsEditing(false)} />
```

- [ ] **Step 4: Test route**

Test:

```ts
it("opens the floor editor from monitoring and returns after cancel", async () => {});
```

Run:

```bash
pnpm --filter @led-control/web test -- App.test.tsx FloorEditorView.test.tsx
```

Expected: pass.

## 15. Task 13: 도면 배경 등록

**Files:**

- Create: `apps/web/src/features/floor-editor/FloorAssetUploader.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/api/src/floor-editor/floor-editor.controller.ts`

- [ ] **Step 1: JPG/PNG input**

Support:

```text
image/jpeg
image/png
```

MVP 1 can store uploaded file in API static upload directory.

- [ ] **Step 2: PDF input**

Support:

```text
application/pdf
```

Render first page through `pdfjs-dist` and save rendered image as background.

- [ ] **Step 3: Background none**

Add action:

```text
배경 없음
```

This sets `sourceType = "none"`.

## 16. Task 14: 문서 갱신

**Files:**

- Modify: `docs/menus/monitoring.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md`

- [x] **Step 1: Update monitoring menu doc**

Move these items from 미구현 to 구현 완료 when implemented:

- 지도 확대, 축소, 패닝
- 조명 위치 드래그 편집
- 도면 업로드 및 도면 버전 관리 UI

Add:

- 도형/텍스트 에디터
- 배경 없는 편집 캔버스

- [x] **Step 2: Update database schema doc**

Document:

- `FloorPlan.sourceType`
- `FloorPlan.originalFileUrl`
- `FloorPlan.renderedImageUrl`
- `FloorMapObject`

- [x] **Step 3: Update service design doc**

Add:

- MVP 1 manual editor
- MVP 2 automatic placement helper
- MVP 3 AI drawing interpretation

## 17. Task 15: 전체 검증

**Files:** No new files.

- [x] **Step 1: API tests**

Run:

```bash
pnpm --filter @led-control/api test -- floor-editor.service.spec.ts sites.service.spec.ts --runInBand
```

Expected: pass.

- [x] **Step 2: Web tests**

Run:

```bash
pnpm --filter @led-control/web test -- FloorEditorView.test.tsx geometry.test.ts App.test.tsx
```

Expected: pass.

- [x] **Step 3: Typecheck**

Run:

```bash
pnpm typecheck
```

Expected: pass.

- [x] **Step 4: Manual browser check**

Check:

```text
1. http://localhost:5173 접속
2. 로그인
3. 모니터링 진입
4. 층 선택
5. 에디터 클릭
6. 배경 없이 도형과 조명 편집 가능
7. 이미지 배경 등록 가능
8. 조명 드래그 후 저장
9. 읽기 모드에서 위치 반영 확인
```

## 18. Self-review

- Spec coverage: MVP 1 도면 선택 등록, 배경 없음, 도형, 텍스트, 조명 위치/정보 수정, 줌/팬을 포함한다.
- MVP separation: 다중 이동과 자동 배치는 MVP 2, AI 도면 해석과 CAD 연동은 MVP 3으로 분리했다.
- Type consistency: `FloorMapObject`, `FloorEditorState`, `UpdateFixtureRequest` 이름을 설계 문서와 구현 계획에서 일치시켰다.
- Documentation: 메뉴 문서와 DB 문서 갱신 작업을 별도 Task로 포함했다.
