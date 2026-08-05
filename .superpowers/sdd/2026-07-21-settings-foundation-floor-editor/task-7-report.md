# Task 7 Report: 도면 에디터를 설정으로 이동

## 구현 커밋

- `295c4e9 feat(settings): move floor editor from monitoring`

## 변경 파일

- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx`
- `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`
- `apps/web/src/features/settings/floor-plans/FloorEditorRoute.test.tsx`
- `docs/menus/monitoring.md`
- `docs/menus/settings.md`
- `docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md`

## RED / GREEN 기록

### RED

Command:

```bash
pnpm --filter @led-control/web exec vitest run src/features/monitoring src/features/settings
```

Result: exit 1. 새 `FloorPlanSettingsView`와 `FloorEditorRoute` module을 resolve하지 못해 두 신규 suite가 실패했다. 이는 Task 7 전용 컴포넌트와 실제 settings editor route가 아직 없다는 기대된 실패였다.

### GREEN

Commands and results:

```bash
pnpm --filter @led-control/web exec vitest run src/App.test.tsx src/features/monitoring src/features/settings src/features/floor-editor
# PASS: 8 files, 60 tests

pnpm --filter @led-control/web test
# PASS: 13 files, 71 tests

pnpm --filter @led-control/web typecheck
# PASS

pnpm --filter @led-control/web build
# PASS

git diff --check
# PASS
```

## Self-review

- `MonitoringView`에서 `editingFloorId`, editor query와 editor branch를 제거해 monitoring 도면을 읽기 전용으로 제한했다.
- `FloorPlanSettingsView`는 `operator/admin`에게만 층별 edit link를 표시하고 현재 query string을 그대로 유지한다. `viewer`는 층과 도면 등록 상태만 본다.
- `FloorEditorRoute`가 floor route param으로 editor state를 조회하고, 저장 및 취소 callback에서 `/settings/floor-plans`로 이동한다. 두 이동 모두 현재 `siteId`를 포함한 query string을 유지한다.
- `viewer`의 직접 edit URL은 editor state query를 비활성화한 뒤 도면 목록으로 redirect하므로 편집기를 렌더링하지 않는다.
- 기존 `FloorEditorView`의 `initialState`, `onCancel`, `onSaved` API를 그대로 사용했다. editor state fetch와 navigation만 settings route로 옮겼다.

## Concerns

- Web production build는 기존 500 kB 초과 JavaScript chunk 경고를 출력한다 (`index` 576.15 kB). 이번 route 이동과 관계없는 기존 번들 크기 경고이며 build는 성공했다.
