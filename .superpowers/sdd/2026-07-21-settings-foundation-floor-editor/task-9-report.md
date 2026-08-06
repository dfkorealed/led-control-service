# Task 9 Report: 웹 변경분 저장과 버전 복구 UI

## Review base

구현 시작 전 아래 명령으로 실제 base를 확인했다.

```bash
git rev-parse HEAD
# 9cec6640e06df298d0a9358d94c59b88bbc64900
```

Task 9 코드와 문서 review 범위는 `9cec664..HEAD`다. 시작 작업 트리는 clean이었고 기존 변경을 되돌리지 않았다.

## 구현 커밋

- `c43ff85 feat(floor-editor): add revision-aware atomic editing`
- `a9c01ca docs(settings): record revision-aware web editor`
- `bc60b5b fix(settings): preserve editor width on mobile`
- `1810237 fix(settings): guard dirty site navigation`
- `b51539e fix(floor-editor): report skipped restore fixtures`

DB schema는 변경하지 않아 `docs/database-schema.md`는 갱신하지 않았다.

## RED

브리프의 첫 RED를 그대로 확인했다.

```bash
pnpm --filter @led-control/web exec vitest run src/features/floor-editor/editor-diff.test.ts
# exit 1: ./editor-diff 모듈을 찾지 못해 suite FAIL
```

API, store, View와 Route 행동 테스트를 구현 전에 함께 실행했다.

```bash
pnpm --filter @led-control/web exec vitest run \
  src/api/client.test.ts src/api/floor-editor.test.ts \
  src/features/floor-editor/editor-store.test.ts \
  src/features/floor-editor/FloorEditorView.test.tsx \
  src/features/settings/floor-plans/FloorEditorRoute.test.tsx
# exit 1: 5 files failed, 25 tests failed, 9 passed
```

`apiPut`, status/body 보존 `ApiError`, atomic floor editor API, baseline/dirty store, revision UI와 dirty route 계약이 없어서 실패했다. 기존 View가 `updateFloorPlan`, `updateEditorFixture`, `create/updateFloorMapObject`를 병렬 호출하는 것도 RED에서 확인했다.

후속 self-review에서 발견한 경계도 각각 실패 상태를 먼저 확인했다.

- dirty 현장 전환: SettingsShell test 1 failed, confirm 호출 0회
- restore missing fixture 안내: FloorEditorView test 1 failed, `role=status` 부재
- 모바일 시각 측정: 390px viewport에서 editor shell 폭 124px

## GREEN

초기 focused GREEN:

```bash
pnpm --filter @led-control/web exec vitest run \
  src/api/client.test.ts src/api/floor-editor.test.ts \
  src/features/floor-editor src/features/settings/floor-plans
# PASS: 8 files, 47 tests
```

최종 전체 검증:

```bash
pnpm --filter @led-control/web test
# PASS: 16 files, 96 tests

pnpm --filter @led-control/web typecheck
# PASS

pnpm --filter @led-control/web build
# PASS: 1,745 modules transformed

git diff --check 9cec664..HEAD
# PASS
```

Playwright mock API 시각 검증에서 desktop은 `scrollWidth=viewport=1440`, 모바일 수정 후에는 `scrollWidth=viewport=390`, editor shell 폭 362px를 확인했다. toolbar, canvas, side panels와 revision panel에 겹침이 없었다. 개발 서버는 `http://localhost:5173/`에서 실행했다.

## Self-review

- Web은 shared `SaveEditorStateInput`을 직접 사용한다. `buildEditorChanges`는 fixture/object ID map과 set을 한 번씩 구성해 1,000 fixture 한 건 변경을 O(n)으로 찾고, floor plan과 object create/update/delete를 실제 변경분만 생성한다.
- 기존 object ID는 update 또는 delete 한 곳에만 들어가고 baseline에 없는 draft만 create로 분류된다. unchanged payload는 저장하지 않으며 같은 값 patch는 dirty를 만들지 않는다.
- save는 atomic `PUT /floors/:floorId/editor-state` 한 번만 사용한다. 성공 응답은 새 baseline과 revision이 되고, 네트워크 오류와 `409`는 현재 편집 상태를 유지한다. `409`에는 강제 저장 동작이 없다.
- `ApiError`는 HTTP status와 JSON/text body를 보존한다. floor ID와 revision query는 encode하고 dashboard/editor/revision query key는 site/floor 범위와 일치시켰다.
- revision 목록은 cursor pagination으로 수정자 display name, 시각과 변경 수를 표시한다. operator/admin만 restore할 수 있고 현재 baseline `mapRevision`을 `expectedRevision`으로 보낸다. restore 응답을 baseline으로 채택하고 사라진 fixture 수를 표시한다.
- editor route와 restore 권한은 operator/admin으로 제한하고 viewer 직접 진입은 state 조회 전에 차단한다. 목록 이동, query key, invalidation과 현장 전환에서 `siteId`를 보존한다.
- dirty guard는 내부 링크, 현장 전환, 취소, browser history와 `beforeunload`를 확인한다. 저장 성공 또는 명시적 폐기 확인 뒤에는 이동을 허용한다.
- 기존 개별 mutation API 함수는 Task 11 호환을 위해 유지하지만 현재 Web save 경로에서는 호출하지 않는다.
- `docs/menus/settings.md`와 기준 계획 Task 9 Step 1-7을 갱신했다.

## Concerns

- 기존 개별 floor editor mutation endpoint와 Web API 함수는 Task 11 전체 E2E 전까지 남는다. 직접 호출하면 통합 revision/audit가 생성되지 않는다.
- 실제 API를 포함한 browser E2E와 두 사용자 동시 편집은 Task 10 lease 및 Task 11 범위다. 이번 시각 검증은 mock API를 사용했다.
- production build는 성공하지만 기존 PDF worker와 main bundle이 500kB를 넘는 Vite chunk 경고를 유지한다.

## Fix Round 1 (2026-08-06)

### Review base

수정 시작 전 `git rev-parse HEAD` 결과는 `2fba753f7d295ea7c49101162f82efb674c29a33`였다. Fix Round 1 review 범위는 이 SHA 이후이며 시작 작업 트리는 clean이었다.

### RED

review의 Important 1~6, Minor 1~2를 테스트로 먼저 재현했다.

```bash
pnpm --filter web test -- --run \
  src/features/floor-editor/FloorEditorView.test.tsx \
  src/features/floor-editor/editor-diff.test.ts \
  src/features/floor-editor/editor-store.test.ts \
  src/features/settings/floor-plans/FloorEditorRoute.test.tsx \
  src/features/sites/SiteSwitcher.test.tsx
# FAIL: 5 files, 13 failed / 37 passed
```

실패는 rapid save와 save/restore race, mutation surface 활성 상태, popstate confirm 반복, site/floor 불일치, floorPlan 의미 비교, draft ID 충돌, boolean revision count, skipped 안내 소멸, revision 상태 혼합을 각각 확인했다. self-review에서는 이미 시작된 background upload 중 save/restore가 열리는 실패 테스트도 추가해 `1 failed / 26 passed` RED를 확인했다.

### GREEN

- focused Vitest: 5 files, 51 tests PASS. background upload 보완 후 `FloorEditorView`: 27 tests PASS.
- Playwright layout: desktop 1440x1000, mobile 390x844에서 2 tests PASS. body 수평 overflow 없이 toolbar, canvas, background/properties/revision panel 가시성을 확인했다.
- 전체 Web Vitest: 16 files / 111 tests PASS.
- Web typecheck: PASS.
- Web production build: 1,745 modules transformed, PASS.
- `git diff --check`는 문서 커밋 직전과 최종 커밋 후 재실행한다.

### Self-review

- save/restore는 같은 synchronous ref lock을 사용하며 delayed promise와 rapid double click 양방향 race에서 한 요청만 허용한다. 요청 중 도구, Konva canvas, 배경 파일/삭제와 속성 입력은 실제 disabled/read-only다. 시작된 asset upload도 별도 ref로 save/restore와 상호 배제한다.
- 취소된 popstate의 보상 forward 이벤트는 skip-next ref로 한 번 건너뛰고 unmount에서 모든 guard listener와 ref를 정리한다.
- editor에서 승인된 site switch는 floorId를 버리고 새 site 목록으로 이동한다. siteId 없는 direct URL은 응답 floor.siteId로 canonicalize해 site/floor query key를 사용하고, 선택 site와 floor site가 다르면 editor를 렌더링하지 않는다.
- floorPlan 양쪽을 API 의미 형태로 먼저 정규화해 null/none과 default/fallback URL 동치를 no-op으로 처리하며 실제 image 삭제는 null mutation으로 유지한다. draft ID는 `crypto.randomUUID()`를 사용한다.
- revision 요약은 true인 `floorPlanChanged`를 1건으로 합산한다. loading/error/empty를 분리하고 오류 announcement와 retry를 제공하며, skipped fixture 안내는 같은 floor refetch로 지워지지 않는다.
- 기존 role, atomic PUT, network failure state 유지, 409 reload-only, expectedRevision, site/floor invalidation과 `ApiError` status/body 계약은 기존 회귀 테스트에서 유지된다.

### Concerns

- dirty history guard는 React Router data-router blocker가 아닌 capture click/popstate 보상 방식이다. 현재 link, back/forward와 cleanup은 테스트하지만 후속 programmatic navigation은 같은 guard 계약에 연결해야 한다.
- 실제 API를 포함한 다중 사용자/lease E2E는 Task 10~11 범위다. 이번 desktop/mobile 검증은 mock API를 사용했다.
- production build의 기존 PDF worker와 main bundle 500kB 초과 경고는 유지된다.
