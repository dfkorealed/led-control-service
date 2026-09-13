# Task 3 웹 앱 셸 복구 보고서

상태: 리뷰 Important/Minor 수정·소프트웨어 검증 완료, 재검토 대기. 기준 HEAD `ed873b6738f64d5170d8a2ee5fd90b21ac059b84`, 지정 branch `codex/p0p1-platform-deploy-observability`와 지정 worktree만 사용했다.

## 구현

- `/auth/me` 401은 기존 로그인으로 수렴하고 403·기타 4xx·비일시 오류는 명시적 재로그인 UI로 분리했다. Fetch 전송 오류와 5xx만 최대 두 번 자동 재시도한다. 호출자 취소와 JSON 파싱/일반 TypeError는 재시도하지 않는다. 자동·수동 재시도 성공은 reload 없이 기존 role shell로 수렴한다.
- `AppRecoveryState`는 공통 Card/Button, main 1개, alert, 포커스 가능한 h1, 44px touch target과 한국어 고정 문구를 제공한다. raw error/body/stack/URL/tenant 값은 화면에 표시하지 않는다.
- `AppRoot`는 세션 세대별 QueryClientProvider와 그 아래의 `AppErrorBoundary`를 소유하며, boundary는 실제 App의 hook/render·BrowserRouter·두 lazy shell을 감싼다. main.tsx는 StrictMode와 AppRoot를 조합하고 최초 navigator.onLine을 onlineManager에 전달한다. 실패 lazy Promise 재사용을 막는 기본 복구는 전체 `window.location.reload()`다. 세대 변화만 boundary를 reset하며 재로그인 중/뒤에는 App을 재실행하지 않고 eager loading/AuthView로 수렴한다.
- 인증 실패·재로그인·principal 전환은 새 QueryClient를 먼저 활성화해 이전 mutation option callback을 폐기된 client에 격리한다. 재로그인은 동기 중복 lock → fresh client/auth null → 이전 query 취소와 tenant/mutation/draft·앱 active-command namespace 정리 → 최대 5초 logout → eager 로컬 signed-out 순서다. 초기 403에서 사용자 정보를 몰라도 앱 namespace만 비우며 무관한 저장값은 보존한다. 최초 정상 부팅은 기존 제어 복구 기록을 유지한다. Logout 실패는 노출하지 않으며 요청 종료 전 로그인 폼을 열지 않는다.
- 네 메뉴 문서의 lazy 오류 복구 미구현 기록을 갱신하고 운영 기준·상태판·Task 3 체크리스트를 함께 갱신했다. Task 4 runbook은 작성하지 않았다.

## 최초 구현 TDD RED → GREEN 증거 (bf33cb4)

1. 프로덕션 변경 전 `pnpm --filter @led-control/web test src/App.recovery.test.tsx src/components/ui/AppRecoveryState.test.tsx src/components/ui/AppErrorBoundary.test.tsx`: App 10개 중 9 실패/기존 401 1 통과. 403/400/429·network/timeout/503·parse 오류에 복구 heading이 없고 자동 retry 성공 shell이 없었다. 두 공통 컴포넌트 suite는 구현 파일이 없어 실패했다. 모든 새 test 이름에 놓치면 실패해야 하는 동작을 명시했다.
2. Client classifier 구현 전 `pnpm --filter @led-control/web test src/api/client.recovery.test.ts`: 5/5 실패, `isTransientApiError is not a function`. 구현 후 fetch-only TypeError/AbortError/TimeoutError, caller cancellation 및 parse/programming error 구분이 5/5 통과했다.
3. 초기 GREEN 과정의 App 2개 실패는 로그인 성공 뒤에도 mock `/auth/me`가 이전 403/400을 반환한 잘못된 fixture였다. 성공 로그인 시 fixture 세션을 실제 계약대로 전환했고 timeout/retry 정책을 바꾸지 않았다.
4. Self-review에서 기존 정상 logout은 `clearActiveCommandsForUser`를 호출하지만 새 복구 logout은 누락함을 확인했다. 후속 403→재로그인 회귀에 현재 사용자 sessionStorage와 무관한 key를 추가한 RED는 1 실패/9 통과(`expected 'old-command' to be null`)였다. 기존 helper를 재사용해 GREEN 10/10으로 수렴했다.
5. Focused 최종 명령: `pnpm --filter @led-control/web test src/App.recovery.test.tsx src/App.test.tsx src/api/client.recovery.test.ts src/components/ui/AppRecoveryState.test.tsx src/components/ui/AppErrorBoundary.test.tsx` → 5 files, 85/85 통과. 기존 App의 customer/operator/mandatory-password/account-switch 회귀 64개를 포함한다.

## 최초 구현 Chromium 재현과 수정 (bf33cb4)

- 신규 9개: 네 viewport(1440/1024/390/320px) 503 세 요청 후 keyboard manual retry, 실제 fetch network abort 소진/동일 document 복구, 401 단일 요청 로그인, 403 단일 요청·logout 503 이후 로그인·tenant draft 제거/무관 저장값 보존, 실제 CustomerShell lazy module 요청 차단 이후 full reload 또는 relogin. Main/alert/heading focus/키보드/터치 크기/overflow/오류 비노출을 검사한다.
- 최초 신규 실행은 8 통과/1 실패였다. 403 fixture의 `**/api/**` glob이 Vite `/src/api/*.ts`도 대체해 entry module을 막았음을 확인했다. 기존 settings fixture와 동일한 `pathname.startsWith('/api/')` guard로 API 응답만 대체하여 9/9 통과했다. 제품 코드를 바꾸거나 시간 제한을 늘리지 않았다.
- 확장 실행은 21/22에서 기존 site-user 권한 회귀가 제거된 설정 hover 메뉴를 기다리며 실패했다. `git show ed873b6:apps/web/src/features/shells/SettingsNavigationItem.tsx`는 이미 일반 NavLink만 가지며, 현재 두 navigation 파일은 기준 HEAD 대비 diff가 없다. 따라서 기존 메뉴 구현과 assertion의 불일치로 판정했다. 총괄 승인으로 read/control/admin 3곳의 `hover()`만 `click()`으로 바꿨으며 동일한 링크 목록·접근 차단·제어 권한 assertion은 유지했다. 별도 baseline checkout 실행을 한 것은 아니며 이 근거를 baseline 전체 실행으로 확대하지 않는다.
- 최종 명령: `pnpm --filter @led-control/web exec playwright test e2e/app-shell-recovery.spec.ts e2e/calm-operations-auth-operator.spec.ts e2e/calm-operations-shell.spec.ts e2e/site-user-management.spec.ts --project=chromium --workers=1` → 22/22 통과(30.7초). Default Playwright timeout/retry는 변경하지 않았다.

## 리뷰 수정 RED → GREEN 증거

1. 프로덕션 수정 전 신규 단위 5개는 모두 실패했고 기존 recovery 10개는 통과했다: pending/paused 인증이 요청 0회인 로그인으로 빠짐, 실제 deferred MutationCache mutation의 onSuccess가 403→재로그인→다른 principal 뒤 active cache에 old tenant를 재생성함, App의 실제 useQueryClient hook throw가 boundary 밖으로 전파됨, principal 없는 초기 403에서 old active-command key가 남음, 같은 event batch의 두 클릭이 logout 2개를 시작함.
2. Root가 오류 발생·재로그인·principal 전환에서 QueryClient를 새 인스턴스로 교체한다. deferred mutation이 끝난 뒤 old client에 실제 old data가 존재하면서 active new client에는 없고 새 principal만 존재함을 assertion으로 고정했다. 개별 mutation callback을 수정하거나 mock으로 성공을 생략하지 않았다.
3. 첫 rotation 구현에서 old observer의 passive setOptions가 제거된 auth query를 새 객체로 해석해 401/403 요청을 한 번 더 보내는 회귀를 확인했다. old auth query 객체는 null 상태로 유지하고 다른 cache를 제거하며, 새 세대는 auth 결과만 전달하고 mount refetch/retry를 하지 않는다. 401/403/400/429는 1회, transient는 3회 소진·manual success 총 4회 assertion으로 remount/retry loop가 없음을 검증했다.
4. App hook을 Router 밖으로 옮긴 첫 구조는 기존 필수 비밀번호 변경 성공 후 principal-cache 교체를 route navigation이 관찰하지 못했다. 기존 App 64개 중 해당 1개가 RED였고, auth 관찰자와 완료 navigate를 Router 안의 AppRuntime에 유지해 64/64를 복구했다. boundary 자체는 AppRoot에서 실제 App 위를 감싼다.
5. 실제 browser offline-at-boot Chromium도 RED였다. App의 isPaused 분기만으로는 React Query 5 onlineManager가 최초 browser event 전 online=true를 기본값으로 사용해 해결되지 않았다. main.tsx의 navigator.onLine 초기 동기화 후 static resource만 fixture로 제공하고 context.setOffline(true)인 실제 브라우저에서 요청 0회 복구 UI→online 이벤트→auth 1회·실제 monitoring shell을 검증했다. onlineManager/navigator mock 및 timeout inflation은 없다.
6. 새 boundary regression은 중첩 mock child가 아니라 실제 App이 호출하는 useQueryClient hook을 throw시킨다. 지속 throw 상태에서 logout 503 후에도 App을 remount하지 않고 fresh client/auth null·eager 로그인으로 수렴한다. fake timer regression은 같은 batch 중복 클릭을 억제하고 4,999ms에는 미abort·로그인 미노출, 정확히 5,000ms에는 abort/failure 후 로그인·auth null을 확인한다.
7. 리뷰 최종 focused 90/90, recovery 15/15, offline Chromium 1/1, 전체 Web 712/712 및 관련 Chromium 23/23이다. 이 증거가 위 최초 구현의 85/707/22 수치를 대체한다.

## 최종 fresh 검증

- `pnpm --filter @led-control/web test`: 64 files, 712/712 통과(기존 686 + 최초 신규 21 + 리뷰 신규 5).
- `pnpm --filter @led-control/web typecheck`: exit 0.
- `pnpm --filter @led-control/web build`: exit 0, 2,440 modules, chunk-size warning 없음.
- `pnpm --filter @led-control/web test:bundle-audit`: exit 0, main 319.19 kB / gzip 99.21 kB, 기존 예산과 lazy route·Konva/Recharts 격리 유지.
- 마지막 프로덕션 수정 이후 focused 5 files·90/90(위 최초 focused와 동일 경로), 전체 Web/typecheck/build/bundle, 관련 Chromium 23/23(38.5초)을 fresh 실행하여 모두 exit 0을 확인했다. Web와 Chromium은 독립 프로세스로 병렬 검증했다.
- `git diff --check`: exit 0. Task 3 변경 경로와 네 메뉴 문서 구조·추가 경로 존재 여부를 확인했다.
- 로컬 host는 Node v24.19.0, 저장소 pnpm 9.15.0이다. 기존 상위 launcher의 pnpm 설정 위치 경고와 Playwright NO_COLOR/FORCE_COLOR 경고는 유지하며 lockfile·설치·정책을 변경하지 않았다. Production Node22 container 증거는 Task 2의 기존 결과이며 Task 3에서 재실행한 것으로 기록하지 않는다.

## 자기 검토와 한계

- 401/403/400/429는 request 1회이며 network/timeout/503은 초기 1 + retry 2회 뒤 서비스 복구 UI다. Manual retry 성공은 총 4회로 끝난다. 이전 auth data가 있는 403에서도 shell을 숨기고 tenant query를 제거한다.
- Relogin은 auth query null인 fresh client를 활성화하고 이전 tenant/Mutation cache·draft 및 앱 active-command namespace를 제거한 뒤 다른 principal 로그인을 허용한다. 늦은 mutation callback은 캡처한 old client에 데이터를 다시 써도 active client와 분리된다. UI에는 기존 tenant/server synthetic private 값이 없으며 일반 데이터 저장소를 통째로 clear하지 않는다.
- Boundary는 App 자체의 hook/render와 Router·두 lazy shell 위에 있고 fallback은 eager 공통 컴포넌트만 사용한다. Full reload 동작은 browser document sentinel 소멸/새 dynamic import로 검증했으며 relogin은 실패 module 재요청 없이 로그인으로 수렴했다.
- Recovery UI는 기존 디자인 토큰과 공통 버튼을 사용하고 네 viewport에서 가로 overflow 없이 키보드 focus와 44px 터치 영역을 확인했다. 새 animation은 없고 reduced-motion에서도 검증했다.
- Logout endpoint 장애 시 HttpOnly 서버 cookie 폐기는 보장할 수 없다. 복구 작업은 현재 document의 로컬 principal을 폐기하며 전체 새로고침 후 서버 세션 판정은 별개다.
- 동적 import 검증은 실제 Vite 앱 셸 모듈 요청에 대한 deterministic 오류 주입이다. Production CDN/nginx 장애·실백엔드 오류·native WebView·수동 시각 QA·HIL 결과로 확대하지 않는다. Entry bundle 자체가 로드되기 전의 오류는 React boundary 실행 전이므로 범위 밖이다.
- API/shared 소스/Gateway/firmware/Compose/container/schema/migration/secret/사용자 DB/main/외부 시스템은 변경하지 않았다. Shared build output 재생성은 기존 Web dev/bundle 명령의 dependency 준비이며 tracked shared 변경은 없다. 실제 production 배포·외부 알림·HIL 및 Task 4 final convergence는 미실행이다.
