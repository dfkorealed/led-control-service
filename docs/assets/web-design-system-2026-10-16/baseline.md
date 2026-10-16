# Web 디자인 시스템 통일 적용 전 baseline

기준일: 2026-10-16. 소스: `50fabbfc7b89b694cc6691b1bae38ca073ae0b36`. 분리 작업공간에서 제품 변경 전에 새로 실행한 결과다. 과거3834PASS/6FAIL/3SKIP 또는32개 브라우저 통과를 이번 baseline으로 재사용하지 않는다.

## 준비와 실행 환경

최초 `pnpm workspace:prepare`는 `node_modules` 부재로 실패했다. `pnpm install --frozen-lockfile` 후 prepare는 성공했다. 최초 전체 Web은3901PASS/5FAIL/3SKIP와 `editor-store.activation.test.ts` 수집 실패(`Cannot find module '.prisma/client/default'`)였다. 해당 Web test가 실제 API staging fixture를 가져오므로 총괄 승인 아래 로컬 `pnpm --filter @led-control/api prisma:generate`만 실행하고, prepare 성공 후 제품 변경 전에 전체 Web을 다시 실행했다. DB 접속·migration·seed·schema 변경은 없다.

Chromium은 workers1, serviceWorkers block, 소유 Vite `127.0.0.1:15341`, strictPort, reuseExistingServer false다. 기존5173/4000에 접속·중단·재사용하지 않는다. 기존 mock-api-boundary의 context fallback과 기존 page 도메인 mock을 사용했다. 과거12개 선택 테스트의 assertion·locator·timeout은 보존하고 복사본의 test/expect import만 이번 격리 fixture로 바꿨다. 임시 복사본은 제품 route나 제품 산출물이 아니다.

원 로그와 임시 runner는 같은 checkout의 `.superpowers/sdd/2026-10-16-web-design-system-unification/`에 보존한다. 아래 파일 이름은 이 공통 경로를 기준으로 한다. 이 폴더는 Git 제외 scratch이며 본 요약만 커밋한다.

| 명령 | 실제 결과 | 로그 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit0 | `task-1-install.log` |
| `pnpm --filter @led-control/api prisma:generate` | exit0, 로컬 client 생성만 | `task-1-prisma-generate.log` |
| `pnpm workspace:prepare` | exit0, shared→automation 준비 | `task-1-prepare-before-baseline.log` |
| `pnpm --filter @led-control/web test` | exit1, 3904PASS/5FAIL/3SKIP, 1 failed/261 passed/1 skipped files | `task-1-baseline-unit-prepared.log` |
| `pnpm --filter @led-control/web exec playwright test --config=../../.superpowers/sdd/2026-10-16-web-design-system-unification/task-1-baseline.config.ts` | exit1, 과거 선택12개 중6PASS/6FAIL, 1.5분 | `task-1-baseline-browser.log` |

최초 준비 실패 파일은 성공한 prepare 실행에서 재사용되어 덮어써졌다. 당시 도구 출력에서 복원한 기록을 `task-1-prepare-initial-failure.log`로 명시적으로 구별한다. 미생성 client의 최초 전체 결과는 원본 `task-1-baseline-unit.log`에 따로 남긴다. 준비 오류를 제품 테스트 실패나 skip으로 숨기지 않는다.

## 단위 테스트 실패별 근거

아래5건은 모두 `apps/web/src/features/control/ControlView.test.tsx > ControlView 대상 선택`이다. 당시 원본 SHA-256은 `d74b722ee546b1b5ea3057247d5326b976c936064497a1026f9689054f5ba623`이다. Task1은 이 테스트 또는 ControlView 동작을 수정하지 않는다. 원인은 이번 기반 작업 범위에서 확정하지 않으며 전체 GREEN으로 표시하지 않는다.

| 테스트 이름 | source와 재현 조건 | 실패한 단언 | prepared 로그 시작 행 |
| --- | --- | --- | --- |
| `reopens historical detail with one close action in single-column=true without issuing physical control` |982–991행, verified_applied 이력 선택 후 narrow 상세 확장 | `getByRole("region", { name: "최근 결과 상세" })` 부재 |2939 |
| `preserves only the focused close action across single-column=false transitions` |1005–1012행, verified_applied 상세를 열고 전환 준비 | `getByRole("button", { name: "명령 상세 닫기" })` 부재 |3506 |
| `preserves only the focused close action across single-column=true transitions` |동일 parameterized source, singleColumn=true | 동일 닫기 버튼 부재 |4061 |
| `group URL and roving focus survive back forward and theme` |2386–2397행, manual 탭에서 End로 group 이동 | `expect(group).toHaveFocus()` 불일치 |4616 |
| `uses roving tab focus and selects modes with circular arrow, Home, and End keys` |2567–2582행, manual에서 ArrowLeft로 group 이동 | `expect(groupTab).toHaveFocus()` 불일치 |4759 |

과거 여섯 번째 CAD 실패의 source는 `apps/web/src/features/floor-editor/FloorEditorView.test.tsx:1280`의 `previews CAD review results and applies with editor authority (common map: $common, interruption: $interruption)`다. common=true의 principal 및 onSaved-purge 조건에 대한 역사적 실패가 있으나 이번 prepared 전체에서는 해당 파일85/85가 통과했다. source SHA-256은 `d1bdebbf1728933e9c778f6ccc5025474c2b6b91a97c6e306b9f1b0b7ddc9fe0`이다. 미재현을 원인 해결로 해석하지 않는다.

## 과거 선택 브라우저12개

source는 모두 `apps/web/e2e/` 기준이며 실행한 임시 복사본에는 import 분리 때문에 원본 대비1행 offset이 있다. 여섯 실패는 현재 제품 동작의 성공·실패를 끝까지 검증하기 전에 locator에서 중단된 결과다.

| source·시나리오 | 조건·단언 | 결과 |
| --- | --- | --- |
| `control-map-target-selection.spec.ts:454`, `manual map selection stays synchronized with the list and command payload` |marker 선택 후 `getByRole("button", { name: "조명 목록 열기" }).click()` 대기, 30초 |FAIL1, 로그41행 |
| `settings-mobile-lifecycle.spec.ts:24`, `ATLAS settings home and mobile return` |320/390px × light/dark, `getByRole("heading", { name: "설정", exact: true, level: 2 })` 부재, 기대 visible |FAIL4, 로그71/108/145/182행 |
| `site-user-management.spec.ts:202`, `admin이 일반 유저의 전체 관리 여정을 완료하고 평문 비밀번호를 남기지 않는다` |기존 `유저 관리` heading visible 기대 |FAIL1, 원 로그의 해당 source/error-context |
| `calm-operations-manual-control.spec.ts:101`, `전송 전 수동 거절은 편집을 유지하고 불확정 거절만 잠근다` |1440/390px, 거절 종류별 잠금·편집과 요청 보존 |PASS2 |
| `settings-floor-editor.spec.ts:391`, `common map elements saved in settings render immediately in monitoring` |mock 저장 후 모니터링 반영 |PASS1 |
| `settings-floor-editor.spec.ts:573`, `dirty editor logout keeps the draft on cancel and logs out only after confirmation` |취소 draft 보존·확인 후 logout |PASS1 |
| `settings-mobile-lifecycle.spec.ts`, `settings real touch pan and background draft/lease` |320/390px HTTP fixture, 실제 touch context |PASS2 |

실패 context/trace는 scratch의 `task-1-baseline-browser-results/`에 있다. 원본 source SHA-256: control-map `a486ad3c39426471036efc0e4b1c5ce5f5adbcad21497c594729a35d50675761`, settings-mobile `513a596f2e6638db0783259ea66a07c2a13168146f6ea302e889d8f3521a463d`, site-users `bfcc1c68d79409dc680b839f729152fd7ef91361cb090a0b8a39ee38767c89c4`.

## 검증 범위와 후속

이 baseline은 mock-only Chromium과 로컬 단위 테스트다. 운영 API·실제 인증 mutation·메일·장비·DB·native WebView·Safari/WebKit·HIL 증거가 아니다. Task1 기반의 RED/GREEN·역할 mutation·최종 검증과 새로 관측한 기존 spec 한계는 같은 scratch의 `task-1-report.md`에 기록한다. source locator를 완화하거나 전체 FAIL을 집중 PASS로 덮지 않는다.
