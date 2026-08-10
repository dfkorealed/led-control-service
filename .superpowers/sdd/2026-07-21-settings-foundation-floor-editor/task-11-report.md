# Task 11 완료 보고서: 설정 기반과 도면 편집 회귀 검증

작성일: 2026-08-10

기준 커밋: `8876664` (`fix(floor-editor): bound lease deadlines to request start`)

작업 브랜치: `codex/mvp1-cloud-web`

## 결과

Task 11의 browser regression, 1,000 fixture 저장 검증 및 한국어 문서 갱신을 완료했다. Fix Round 1은 viewer read-only 목록, lease/save/release 순서, editor latency budget과 메뉴 문서 소유권을 보강했다. E2E route fixture는 `apps/web/e2e/support` 아래에만 두었고, runtime mock Gateway, BLE 발견 이벤트 또는 device 경로는 추가하지 않았다.

## RED -> GREEN 증거

### RED

1. 새 역할별 E2E를 먼저 추가하고 실행했을 때 `./support/settings-api` module이 없어 Playwright가 test discovery 전에 실패했다. 이후 browser 전용 fixture를 추가했다.
2. 첫 fixture의 `**/api/**` route가 Vite의 `/src/api/auth.ts`, `/src/api/queries.ts` module 요청까지 가로채 `404`를 반환했고 React 화면이 비어 있었다. handler가 `pathname.startsWith("/api/")`가 아닌 요청은 `route.continue()`하도록 고쳐 실제 API path만 fixture 처리했다.
3. 1,000 marker를 렌더한 editor에서 실제 canvas click이 45초 test timeout까지 완료되지 않았다. Circle마다 적용된 shadow blur와 Konva perfect draw가 Chrome renderer를 포화시킨 것이 원인이었다.
4. 기존 `mvp1` smoke E2E는 역할 selector, dashboard query 및 site-scoped fixture endpoint가 현재 route 계약과 달라 실패했다. 현재 customer admin 계약과 `/sites/:siteId/...` route로 fixture를 맞췄다.
5. Fix Round 1에서 lease/save/release 순서 assertion을 먼저 추가했을 때 fixture에 `editorRequests`가 없어 `undefined.filter`로 실패했다. fixture가 initial acquire마다 같은 token을 발급해 StrictMode의 늦은 cleanup release가 새 acquire까지 지우는 문제도 드러났다.

### GREEN

- `settings-floor-editor.spec.ts`는 operator의 시운전 메뉴 노출, customer admin의 fixture 이동/저장/모니터링 좌표 반영, viewer가 assigned B2 row와 `도면 등록됨` 상태를 보는 read-only 목록, editor route 사전 redirect와 mutation `403`을 확인한다.
- admin 저장은 ordered browser fixture request에서 acquire가 atomic save보다 앞서는지, `expectedRevision: 7`과 한 개의 fixture update만 있는 완전한 payload인지, `floorPlan`과 object mutation이 없는지, save navigation 후 acquired token으로 release하는지를 eventually-safe polling으로 확인한다.
- `monitoring-1000.spec.ts`는 기존 1,000 marker count, 10초 이내 loading, 마지막 marker visibility assertion을 유지한 채 settings editor에 진입한다. navigation 시작부터 marker 색상 pixel `[32, 201, 151, 255]`와 실제 Konva hit selection의 속성 패널까지 8초 budget을 적용하고, X 좌표 변경 후 저장 payload의 `fixtureUpdates.length === 1`을 확인한다.
- unknown tenant route의 `404` browser assertion은 support fixture가 assigned data 밖을 노출하지 않는지 확인할 뿐 production tenant authorization E2E라고 해석하지 않는다. 실제 tenant 경계는 API service/integration tests가 담당한다.

## 1,000 Fixture 성능 및 제품 변경 근거

`apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`에서 fixture Circle의 장식 shadow (`shadowColor`, `shadowBlur`)를 제거하고 `perfectDrawEnabled={false}` 및 `shadowEnabled={false}`를 설정했다. 이는 데이터 모델, 저장 payload, hit area, drag/click handler, marker fill/stroke를 바꾸지 않는 제한된 rendering 비용 변경이다.

변경 전 1,000 marker editor canvas interaction은 45초 timeout에 도달했다. Fix Round 1은 editor navigation 시작부터 marker fill pixel과 선택 후 속성 패널이 준비될 때까지 명시적으로 8,000ms를 허용한다. 이는 기존 45초 failure를 잡고 현재 반복 Chromium 실행의 약 1.1초 readiness에는 충분한 CI 여유를 둔다. 새 E2E가 marker fill pixel과 선택 후 속성 패널을 함께 검증하므로, shadow 제거가 marker 표시나 Konva interaction을 없애지 않았음을 확인한다. 기존 monitoring의 1,000 marker/10초 assertion도 그대로 유지했다.

## 변경 파일

- `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`: dense marker render 비용을 줄이는 제한된 production 변경.
- `apps/web/e2e/support/settings-api.ts`: role/site-scoped browser-only API fixture와 ordered save/lease request capture.
- `apps/web/e2e/settings-floor-editor.spec.ts`: operator/admin/viewer와 tenant/atomic revision E2E.
- `apps/web/e2e/monitoring-1000.spec.ts`: 기존 monitoring scale assertion을 보존한 editor one-fixture diff save E2E.
- `apps/web/e2e/mvp1.spec.ts`, `apps/web/e2e/auth-real.spec.ts`: 현재 customer admin/site route 계약 및 real-auth env 이름과 정렬.
- `docs/menus/settings.md`, `docs/menus/monitoring.md`, `docs/menus/control.md`, `docs/database-schema.md`: 구현 상태와 역할/DB 모델을 한국어로 갱신.
- `docs/lesson_leared.md`: Vite source module까지 포획하는 Playwright route glob의 재사용 가능한 실패 패턴 기록.

## 커밋

- `4862796 perf(floor-editor): streamline dense fixture markers`
- `58d4ced test(settings): cover role-scoped floor editing`

이 보고서는 위 구현 커밋과 분리된 문서 커밋으로 기록한다.

## 검증 결과

다음 명령이 모두 exit code 0으로 완료됐다.

```text
pnpm --filter @led-control/web exec playwright test e2e/settings-floor-editor.spec.ts e2e/monitoring-1000.spec.ts e2e/mvp1.spec.ts --repeat-each=3
# 15 passed

pnpm --filter @led-control/web exec playwright test e2e/settings-floor-editor.spec.ts e2e/monitoring-1000.spec.ts e2e/mvp1.spec.ts
# 5 passed

pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @led-control/web build
git diff --check
```

`pnpm test`는 workspace unit/integration suite를 통과했다. web은 16 files/131 tests, API는 48 passed files/318 passed tests (intentional skips 포함), gateway는 32 files/115 tests를 통과했다. Vite production build도 성공했으며 기존 large chunk warning만 남았다.

`auth-real.spec.ts`는 `E2E_REAL_AUTH=true` 및 인증 환경 변수가 없어 1 test skipped였다. `E2E_OPERATOR_EMAIL`/`E2E_OPERATOR_PASSWORD`를 우선 사용하고 이전 owner variable도 호환 fallback으로 유지한다.

## 자체 검토

- viewer는 assigned B2 도면 row와 `도면 등록됨` 상태를 read-only로 볼 수 있고, direct editor URL은 editor-state/lease 요청 전에 목록으로 redirect되는 계약을 test로 고정했다. viewer mutation fixture는 여전히 `403`을 반환한다.
- fixture route는 assigned `site-1`만 제공하고 unknown path를 `404`로 처리한다. 이는 fixture-isolation coverage이며 production tenant boundary 증거는 API service/integration tests에 남긴다.
- atomic save는 acquire, save, post-navigation release의 순서와 acquired token을 capture하고, 변경 fixture 하나와 empty object mutation 목록만 허용한 뒤 mutable E2E fixture state에 반영한다.
- monitoring의 기존 규모 assertion을 제거하거나 완화하지 않았다.
- documentation은 browser route fixture를 실제 Raspberry Pi, ESP32-H2, BLE 또는 hardware E2E라고 주장하지 않는다.

## 남은 우려와 후속 확인

- real authentication E2E는 필요한 secret/environment이 이 작업 환경에 없어 skipped였다. 실제 staging credential을 제공하는 별도 실행에서 확인이 필요하다.
- 이 범위는 browser API fixture 기반 UI regression이다. 실제 Gateway, BLE mesh, Raspberry Pi 및 hardware end-to-end 검증은 수행하거나 주장하지 않았다.
- Vite build의 large chunk warning은 기존 경고로 build를 막지는 않지만, editor/PDF 영역의 future code splitting 후보로 남는다.
