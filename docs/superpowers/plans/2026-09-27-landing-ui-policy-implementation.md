# 랜딩 UI 정책 0건 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공개 랜딩과 보관용 정적 시안의 화면·동작·URL을 보존하면서 UI 정책 위반 925건을 0건으로 줄인다.

**Architecture:** 필요한 의미 기반 토큰만 검토 커밋으로 추가하고 승인 Git ref를 회전한다. React 공개 페이지의 일반 CSS를 컴포넌트 소유 유틸리티로 옮긴 뒤, 정적 시안을 같은 React 진입점을 쓰는 Vite 다중 페이지로 전환한다. 기존 `src/App.tsx`만 `styles.css`를 가져오는 단일 CSS 소유 계약을 유지한다.

**Tech Stack:** React 18, TypeScript, Tailwind CSS 4, Vite 5, Vitest, Node test runner, Playwright Chromium.

**Spec:** [랜딩 UI 정책 전환 설계 명세](../specs/2026-09-27-landing-ui-policy-design.md)

**실행 상태(2026-09-28):** 사용자 실행 승인. Task 1–5 구현·독립 검토를 완료했다. Task 5 `0056c64f`의 문서 P2를 `514e10be`에서 고쳐 scoped 재검토를 통과했다. 모니터링·제어는 focused Vitest 31·Chromium 31·typecheck/build와 4너비 시각/13너비 계산 비교·실제 모션 검증을 통과했다. 밝기 트랙의 루트 변수 토큰은 실제 15% 고정 실패를 확인해 철회했고, 기존 Tailwind 단일 paint gradient의 24개 원본 초기 렌더 비교가 픽셀 일치했다. 승인 앵커는 `b1b50079`/374선언으로 복원됐다(`b1a03939`). 현재 정책 186건(CSS 182·import 1·Report/Map 버튼 2·정적 CSS 1)은 expected FAIL이다. Task 6 통계·보고서·맵을 진행하고 Task 7–8 URL/전체 0건 검증이 남는다.

## Global Constraints

- 기준은 `6c61995099db7329adaf5910aac323b03fa331de`, 격리 브랜치는 `codex/landing-ui-policy`다. 기존 925건은 해결 전까지 실패로 기록한다.
- `ui-policy-baseline.json`의 `files: {}`와 0건 목표를 유지한다. 허용 경로·위반 예외·`reviewedThemeTokenAdditions`를 늘리거나 검사 밖 CSS/JS/HTML로 스타일을 숨기지 않는다.
- 새 토큰은 기존 토큰으로 표현할 수 없는 **재사용 가능한 역할 또는 히어로처럼 핵심 의미가 분명한 고유 역할**에 한정한다. 숫자 하나마다 토큰을 만들지 않는다. 정확한 값·역할을 승인받지 못하면 화면을 근사하거나 정책을 완화하지 말고 해당 단계에서 멈춘다.
- 승인 Git ref를 **검토된 토큰 전용 커밋**으로 교체하는 것은 신뢰 앵커의 검토 가능한 회전이다. 이름→값·누락·중복 검증, `files: {}` 및 기존 거부 사례는 그대로 유지한다. 위반 억제용 ref 교체나 예외 추가와 구분한다.
- `430px`, `720px`, `1050px`의 기존 `max-width`는 경계값을 **포함**한다. 기존 React와 정적 시안은 각각 자기 기준 화면과 비교한다.
- `/`, `/features`, `/pricing`, `/login`, `/concepts/index.html`, `/concepts/field-day.html`의 직접 접근·새로고침·뒤로 가기를 유지한다. 공개 페이지는 인증 조회를 하지 않는다.
- 조명 선택·밝기·통계·보고서·맵 배치의 미리보기, 섹션 재진입 재생, reduced-motion 완료 상태, 상담 API/503/동일 문의 재시도·포커스 복귀를 유지한다. 실제 장비 명령은 보내지 않는다.
- 320·390·1024·1440px에서 글자·배치·색·그림자·상담 팝업을 비교하고 429/430/431·719/720/721·1049/1050/1051px에서 경계 동작을 검사한다. API·DB·배포 설정은 변경하지 않는다.
- 시각 차이는 모두 원인을 분류한다. **사용자가 알아볼 만한 외형·동작 차이**는 실패로 처리하고 수정한다. 브라우저/폰트 래스터 차이만 근거를 남겨 허용하며 임의의 픽셀 오차율로 자동 승인하지 않는다.
- 실행 동안 `docs/project-status.md`와 이 체크리스트의 상태를 함께 갱신하고, 기능 현황이 바뀌면 `docs/menus/landing.md` 및 영향 메뉴 문서를 같은 커밋에 포함한다.

## Review Focus

1. 430/720/1050 **정확한 경계와 분수 CSS 픽셀**에서 이전 규칙과 같은 쌓임/보임 상태여야 한다 — Task 2·7.
2. 공개 페이지에서 CSS가 `/login`·인증 shell로 새어 들어가거나 공개 페이지가 `/api/auth/me`를 호출하면 안 된다 — Task 3·8.
3. 애니메이션 도중 스크롤 이탈·재진입·다시 보기와 reduced-motion 전환에서 타이머/WAAPI가 중복되거나 최종 정보가 사라지면 안 된다 — Task 5·6·7.
4. 상담 전송 실패/503/접수 중 닫기에서 문의 키·폼 값·포커스와 URL이 변하면 안 된다 — Task 3·7·8.
5. 정적 `.html`의 dev 성공만으로 배포 성공을 판단하면 안 된다. production `dist` 실파일·nginx 직접 접근·갤러리 상대 링크를 확인한다 — Task 7·8.

## 파일 구조와 작업 소유

| 단위 | 파일과 책임 |
| --- | --- |
| 토큰·승인 | `apps/web/src/styles/theme.css` 의미 토큰, `apps/web/src/styles.css` 포함형 variant, `apps/web/scripts/ui-policy.mjs` 승인 Git ref와 정확한 variant 검증, `apps/web/scripts/ui-policy-baseline.json` 빈 baseline ref, `apps/web/scripts/ui-policy.test.mjs` 계약 회귀, `docs/ui-spacing.md` 값·용도 |
| 공개 공통 | `apps/web/src/features/landing/PublicSiteLayout.tsx` 헤더·문의, `LandingPage.tsx` 히어로·닫는 장면, `field-day/CompanyFooter.tsx` 푸터. 기존 `apps/web/src/components/ui/{Button,Card,ModalDialog}.tsx` API를 소비하고 새 버튼/카드 모양이 반복될 때만 해당 공통 폴더에서 variant를 만든다. `LandingStory`는 Task 7 시안에서도 사용한다. |
| 공개 하위 페이지 | `field-day/FeatureOverview.tsx`, `field-day/PricingSection.tsx`의 화면 스타일. `FeaturesPage.tsx`·`PricingPage.tsx`의 공개 라우트는 유지한다. |
| 다섯 장면 | `field-day/Scene.tsx`의 `SceneMotion`·`DemoCard`, `MonitoringDemo.tsx`, `ControlDemo.tsx`, `StatisticsDemo.tsx`, `ReportDemo.tsx`, `MapDemo.tsx`의 상태·화면 스타일 |
| 기존 CSS 제거 | `apps/web/src/features/landing/field-day.css`에서 전환 완료한 규칙을 단계별로 제거하고 마지막에 파일 및 `PublicSiteLayout.tsx` import를 삭제한다. CSS를 다른 파일에 옮기는 것은 금지한다. |
| 정적 시안 | `apps/web/concepts/field-day.html` 물리 페이지, `apps/web/src/features/landing/FieldDayConceptPage.tsx` 시안 구성·동작, `apps/web/src/main.tsx` 경로 분기, `apps/web/vite.config.ts` 다중 입력. 기존 `public/concepts/field-day.{html,css,js}`는 URL·동작 이관 후 제거한다. `public/concepts/index.html` 링크는 유지한다. |
| 검증 | `apps/web/e2e/{landing.spec.ts,landing-field-day.spec.ts,field-day-inquiry.spec.ts}`의 브라우저 계약, 기존 `LandingPage.content.test.tsx`, `InquiryForm.test.tsx`, `FeaturesPage.content.test.tsx`의 집중 단위 회귀. Task 2의 컴파일 경계는 `ui-policy.test.mjs`에 추가한다. |

---

### Task 1: 기준 채증과 최소 토큰 검토 커밋

**Files:** Modify `apps/web/src/styles/theme.css`, `docs/ui-spacing.md`; Test `apps/web/scripts/ui-policy.test.mjs`; capture ignored `apps/web/.local/landing-visuals/*`.

**Interfaces:** Consumes 설계 명세 2절과 기존 `@theme static`. Produces 검토된 토큰 이름→정확 값의 **토큰 전용 Git 커밋 SHA**; Task 2의 승인 ref 입력이다. 승인 요청 후보는 `--text-landing-hero-fluid: clamp(55px, 5.3vw, 78px)`, `--text-landing-concept-hero-fluid: clamp(55px, 6.7vw, 100px)`, `--text-landing-eyebrow: 13px`, `--radius-landing-glass-panel: 18px`, `--shadow-landing-demo-card: 0 18px 55px rgb(21 50 74 / .10)`다. 두 히어로는 서로 다른 핵심 역할이다. 사용 위치·횟수 및 기존 토큰과의 차이를 검토받기 전에는 추가하지 않는다.

- [x] **Step 1: 기준 이미지를 저장한다.** React `/`·`/features`·`/pricing`와 시안 `.html`의 320/390/1024/1440 전체·히어로·데모·팝업 PNG를 같은 브라우저/높이/폰트/reduced-motion으로 저장한다. `pnpm --filter @led-control/web ui:check`의 기존 925건 FAIL도 함께 기록한다.
- [x] **Step 2: 값의 역할을 전수 분류한다.** 57종·175회 간격 및 36/14/20/23/20종 서체·반경·그림자를 사용 위치별로 분류해 기존 토큰 적합/유틸리티로 정확 표현/새 의미 토큰 필요의 세 갈래와 사용 횟수를 `docs/ui-spacing.md`에 기록한다.
- [x] **Step 3: 후보를 검토받는다.** 위 다섯 후보 및 Step 2의 추가 후보에 정확한 역할·값·사용처를 붙여 승인받는다. 반려된 후보는 테스트에 고정하지 않고 정확한 대체 경로가 확인될 때까지 멈춘다.
- [x] **Step 4: 확정된 후보의 RED 테스트를 쓴다.** `ui-policy.test.mjs`에 `landing token proposal preserves exact values` 테스트를 추가해 승인된 이름→값 표와 실제 `theme.css`의 값/선언 횟수 1을 단언한다. 위 다섯 후보가 승인되면 다섯 값을 그대로 고정한다. `pnpm --filter @led-control/web exec node --test --test-name-pattern="landing token proposal preserves exact values" scripts/ui-policy.test.mjs`는 첫 누락 토큰에서 FAIL해야 한다.
- [x] **Step 5: 승인된 선언만 `@theme static`에 넣는다.** 위 `--test-name-pattern` 집중 명령의 신규 토큰 값 단언만 PASS해야 한다. 전체 `test:ui-policy`의 생산 0건 단언과 `ui:check`는 승인 ref가 옛 Git 객체를 가리키므로 이 중간 커밋에서 FAIL한다; 전체 테스트 성공으로 보고하지 않는다.
- [x] **Step 6: 토큰 전용 커밋을 만든다.** `git add apps/web/src/styles/theme.css docs/ui-spacing.md apps/web/scripts/ui-policy.test.mjs && git commit -m "feat(web): approve minimal landing tokens"`. SHA와 추가 토큰 표를 Task 2에 넘기며, 나머지 구현 파일은 이 커밋에 섞지 않는다.

### Task 2: 정책 신뢰 앵커와 포함형 반응형 variant

**Files:** Modify `apps/web/src/styles.css`, `apps/web/scripts/{ui-policy.mjs,ui-policy-baseline.json,ui-policy.test.mjs}`, `docs/ui-spacing.md`; Test `apps/web/scripts/ui-policy.test.mjs`의 Vite 컴파일 증거.

**Interfaces:** Consumes Task 1의 커밋 SHA와 토큰 이름→값. Produces `landing-narrow:`, `landing-stack:`, `landing-wide:` 클래스 variant로 각각 `@media (max-width: 430px)`, `720px`, `1050px`를 포함하는 컴파일 CSS, 그리고 그 세 이름·값만 검증하는 정책 계약이다.

- [x] **Step 1: 컴파일 RED 테스트를 쓴다.** `ui-policy.test.mjs`에 `approved landing variants compile at inclusive boundaries`를 추가한다. 기존 Vite `load` hook의 테스트용 `@source inline(...)`에 `landing-narrow:block landing-stack:block landing-wide:block`을 넣고 CSS의 세 media 조건이 각각 정확히 `max-width:430px/720px/1050px`이며 클래스가 그 안에 생성되는지 단언한다.
- [x] **Step 2: 거부 RED 테스트를 쓴다.** `approved landing policy rejects mutated variant or anchor`에서 ref/baseline 불일치, 값 변경·삭제, 네 번째 custom variant, 세 값 변경, 임의 `max-[777px]`을 거부하도록 단언한다. `pnpm --filter @led-control/web exec node --test --test-name-pattern="approved landing" scripts/ui-policy.test.mjs`는 현재 variant 누락/구 ref로 FAIL해야 한다.
- [x] **Step 3: 최소 구현한다.** `src/styles.css`에 정확히 세 `@custom-variant`를 선언한다. `ui-policy.mjs`의 신뢰 ref와 빈 baseline의 `sourceRef`를 Task 1 SHA로 함께 바꾸고, 테스트 fixture의 구 ref도 교체한다. 스캐너는 세 이름을 클래스 문자열에서 인식해 `@custom-variant`의 정확한 이름·미디어·중복/누락을 검증해야 한다. 광범위 allowlist나 새 CSS entry는 금지한다.
- [x] **Step 4: GREEN을 확인한다.** 위 `--test-name-pattern` 집중 명령은 PASS하고 전체 `test:ui-policy`의 생산 0건 단언만 기존 925건 때문에 FAIL인지 분리한다. `ui:check`는 이전 925개 path/rule/match 목록과 비교해 **신규 위반이 없어야** 한다. 컴파일 CSS의 `max-width` 조건은 해당 정수 경계를 포함하고 430.5/720.5/1050.5px은 제외하는지 테스트한다. 실제 페이지 폭별 E2E는 variant가 사용되는 Task 3–6과 Task 8에서 실행한다.
- [x] **Step 5: 커밋한다.** `git add apps/web/src/styles.css apps/web/scripts/ui-policy.mjs apps/web/scripts/ui-policy-baseline.json apps/web/scripts/ui-policy.test.mjs docs/ui-spacing.md && git commit -m "fix(web): anchor approved landing tokens and exact breakpoints"`.

**Task 2 추가 범위:** 추가 Web 회귀가 발견한 canonical color adapter 누락을 controller ruling으로 같은 단계에서 좁게 보완했다. `components/ui/utils/theme-color.ts`에 이미 승인된 문의 색상 이름 3개만 별도 `c2c5a42c`로 추가했고, 기존 Typography 테스트의 실제 RED와 focused 24/24 GREEN·typecheck를 확인했다. 전체 Web 재실행은 최종 Task 8 관문이다.

### Task 3: 공개 공통 껍질·히어로·문의·푸터 전환

**Files:** Modify `apps/web/src/features/landing/{PublicSiteLayout.tsx,LandingPage.tsx,field-day/CompanyFooter.tsx,field-day.css}`, optionally `apps/web/src/components/ui/{Button,Card}.tsx` for genuinely shared variants; Test `apps/web/e2e/{landing.spec.ts,landing-field-day.spec.ts}` and `apps/web/src/features/landing/{LandingPage.content.test.tsx,InquiryForm.test.tsx}`.

**추가 승인 범위:** 실제 공통 `LinkButton` 랜딩 variant·`KindaLogo` landing presentation·`Card` glass variant, 정확히 알려진 승인 text/radius/spacing 역할의 `cn` 병합 및 집중 회귀, canonical `styles.css`의 원래 pure keyframes, 영향받는 features/pricing 메뉴 문서. React 상담 22px 행간의 토큰 전용 보완·앵커 회전은 별도 검토 커밋으로 수행했다.

**Interfaces:** Consumes Task 2 승인 토큰/variant와 기존 `OpenInquiry = (event: MouseEvent<HTMLButtonElement>, plan?: LandingPlan | null) => void`. Produces `LandingStory({ onInquiry, visualVariant = "site" }: { onInquiry: OpenInquiry; visualVariant?: "site" | "concept" }): JSX.Element`를 `LandingPage.tsx`에서 export한다. 기존 `LandingPage()`는 이를 site로 렌더링하고 Task 7은 concept로 소비한다. `PublicSiteLayout`/`CompanyFooter`, `InquiryForm` API와 `ModalDialog`의 focus/pending 계약은 유지한다.

- [x] **Step 1: RED/기준을 확인한다.** `ui:check`에서 `.site-header`, `.hero`, `.closing`, `.footer`, `.field-day-inquiry-body`의 CSS 선택자 위반이 존재해야 한다. E2E에 320/390/1024/1440 헤더 고정·로그인 링크·히어로 줄바꿈/무테두리·문의 팝업 스크롤/포커스 복귀, `/login` 계산 스타일 및 공개 경로의 `/api/auth/me` 요청 0을 보강한다. 로그인 외형 비교에는 `/api/auth/me`를 401로 stub해 실제 로그인 폼을 렌더링한다. 기존 기능 테스트는 전환 전 PASS가 기준이다.
- [x] **Step 2: 최소 구현한다.** 일반/자손/상태 선택자의 외형을 요소별 유틸리티·조건부 클래스·공통 Button/Card variant로 옮기고 해당 CSS 규칙만 제거한다. 다섯 장면 구성은 `LandingStory`로 분리해 Task 7이 공유한다. popup 18px은 승인 반경 역할 또는 기존 `ModalDialog` 정확 계약으로 처리한다. 히어로 pointer/막대 애니메이션과 reduced-motion의 최종 프레임은 React 상태/승인 motion 클래스에서 보존한다.
- [x] **Step 3: GREEN을 확인한다.** `pnpm --filter @led-control/web exec vitest run src/features/landing/LandingPage.content.test.tsx src/features/landing/InquiryForm.test.tsx`와 `pnpm --filter @led-control/web exec playwright test e2e/landing.spec.ts e2e/landing-field-day.spec.ts --project=chromium`을 통과시킨다. 기준 PNG/계산 스타일과 비교하고 이 영역의 정책 finding이 없어졌는지 `ui:check` 출력으로 확인한다. 다른 미이전 CSS의 잔여 실패는 기록한다.
- [x] **Step 4: 관련 문서와 함께 커밋한다.** `docs/menus/landing.md`의 실제 기능/검증 상태와 `docs/project-status.md`·이 체크리스트를 갱신하고 변경 파일만 `git add` 후 `git commit -m "refactor(web): migrate public shell and hero styles"`.

### Task 4: 주요 기능·요금제 페이지 전환

**Files:** Modify `apps/web/src/features/landing/field-day/{FeatureOverview,PricingSection}.tsx`, `apps/web/src/features/landing/field-day.css`; Test `apps/web/src/features/landing/{FeaturesPage.content.test.tsx,LandingPage.content.test.tsx}`, `apps/web/e2e/landing-field-day.spec.ts`.

**Interfaces:** Consumes Task 3 `PublicSiteLayout`와 `OpenInquiry`; Produces 기존 `FeatureOverview(): JSX.Element`, `PricingSection({ onInquiry }: { onInquiry: (event: MouseEvent<HTMLButtonElement>, plan: LandingPlan) => void })` 계약, Basic/Plus 카피·가격·플랜 상담 전달을 유지한다.

- [x] **Step 1: RED/기준을 확인한다.** `ui:check`의 `.feature-*`, `.pricing-*`, `.section-intro` 선택자 finding을 기록한다. `/features`, `/pricing` 직접/새로고침/뒤로 가기·320/390 가로 넘침 없음·Basic/Plus 상담 값 전달 E2E는 전환 전 PASS를 확인한다.
- [x] **Step 2: 컴포넌트별 유틸리티와 공통 카드/버튼 variant로 외형을 옮기고 해당 CSS만 제거한다.** 기능 미리보기 장식 노드는 `aria-hidden`을 유지하며 18px 패널 반경·타이포·shadow를 승인 토큰/정확 유틸리티에 대응시킨다.
- [x] **Step 3: GREEN을 확인한다.** `pnpm --filter @led-control/web exec vitest run src/features/landing/FeaturesPage.content.test.tsx src/features/landing/LandingPage.content.test.tsx` 및 `pnpm --filter @led-control/web exec playwright test e2e/landing-field-day.spec.ts --project=chromium`을 통과시킨다. 각 페이지의 4너비 PNG와 계산 스타일 차이를 분류하고 해당 selector finding 소멸을 확인한다.
- [x] **Step 4: 커밋한다.** 기능 내용/한계가 달라졌다면 `docs/menus/features.md`·`pricing.md`도 갱신하고, 상태 문서/체크리스트와 함께 `git commit -m "refactor(web): migrate feature and pricing pages"`.

### Task 5: 장면 공통·모니터링·제어 전환

**Files:** Modify `apps/web/src/features/landing/field-day/{Scene,MonitoringDemo,ControlDemo}.tsx`, `apps/web/src/features/landing/field-day.css`; Test `apps/web/e2e/landing-field-day.spec.ts`, `apps/web/src/features/landing/LandingPage.content.test.tsx`.

**추가 승인 범위:** 실제 공통 native `NativeRangeSlider`(RAC 변경 없이 기존 input 계약 보존), 닫힌 Button/Card variant와 Typography union 검사, canonical 순수 cursor keyframes, Monitoring/Control 소비자 key 제거로 재생 포커스 보존, 기존 I6의 마지막 세미콜론 fixture 보정. 실패한 동적 gradient 토큰은 독립 검토 후 철회하고 승인 앵커를 이전과 바이트 동일한 테마로 복원했다.

**Interfaces:** Consumes Task 2의 토큰/variant와 Task 3의 공개 레이아웃. Produces 기존 `SceneMotion = { phase: "playing" | "complete"; run: number; replay(): void; stop(): void }`, `SceneKind`, `DemoCard` props를 그대로 유지해 Task 6의 세 데모가 소비한다.

- [x] **Step 1: RED/기준을 확인한다.** `ui:check`의 `.scene*`, `.demo-*`, `.floorplan*`, `.control-*` 위반을 기록한다. E2E에 섹션 이탈→재진입 재생, 조명 선택의 `aria-pressed`·상태, 밝기 15→70 동작·직접 조정/적용, reduced-motion의 최종 70% 및 재생 중단을 단언한다. 기존 동작 테스트는 PASS를 확인한다.
- [x] **Step 2: 상태·장식·폼을 명시적 노드 및 유틸리티로 옮기고 해당 CSS를 제거한다.** `Scene`의 observer/timer와 `SceneMotion` 계약은 유지한다. 조명·슬라이더·적용 버튼은 공통 UI 소유권을 확인해 원시 폼 스타일 위반 중 MonitoringDemo 1건을 이 단계에서 없앤다. ReportDemo/MapDemo의 나머지 2건은 해당 소비자 스타일을 소유하는 Task 6에서 실제 공통 UI로 전환한다. 동적 밝기 값만 현행 계산값으로 유지하고 정적 스타일을 인라인으로 옮기지 않는다.
- [x] **Step 3: GREEN을 확인한다.** `pnpm --filter @led-control/web exec vitest run src/features/landing/LandingPage.content.test.tsx`와 `pnpm --filter @led-control/web exec playwright test e2e/landing-field-day.spec.ts --project=chromium`을 통과시킨다. 4너비 계산 스타일/PNG, reduced-motion과 키보드/터치 조작, 대상 CSS finding 소멸을 확인한다.
- [x] **Step 4: 커밋한다.** `docs/menus/landing.md`, 상태 문서/체크리스트를 동기화하고 `git commit -m "refactor(web): migrate scene monitoring and control styles"`.

### Task 6: 통계 그래프·보고서·맵 편집 전환

**Files:** Modify `apps/web/src/features/landing/field-day/{StatisticsDemo,ReportDemo,MapDemo}.tsx`, `apps/web/src/features/landing/field-day.css`; Test `apps/web/e2e/landing-field-day.spec.ts`, `apps/web/src/features/landing/LandingPage.content.test.tsx`.

**Interfaces:** Consumes Task 5 `DemoCard`·`SceneMotion`; Produces 기존 세 데모의 props `({ motion }: { motion: SceneMotion })`와 상태 안내, 포맷 선택, 지도 배치·취소·드래그 동작.

- [x] **Step 1: RED/기준을 확인한다.** `ui:check`의 `.chart-*`, `.report-*`, `.map-*` CSS finding을 기록한다. Playwright에 그래프 선/점의 재생·완료, PDF/XLSX 선택과 보고서 상태, 맵 요소 배치→중간 이동→취소·touch drag, reduced-motion 완료 상태·이탈 중 WAAPI 취소를 단언한다. 기존 테스트의 PASS가 동작 기준이다.
- [x] **Step 2: 정적 배치·색·장식을 승인 유틸리티/토큰으로 옮기고 해당 CSS를 제거한다.** ReportDemo/MapDemo의 원시 폼 스타일 2건도 실제 스타일을 소유하는 공통 UI로 전환한다. 그래프 drawing/보고서 행 reveal/맵 ghost의 CSS keyframe은 합의된 motion utility 또는 기존 WAAPI 상태로 옮겨 프레임과 최종 상태를 보존한다. 미리보기 값·좌표 계산만 동적 style로 남긴다.
- [x] **Step 3: GREEN을 확인한다.** `pnpm --filter @led-control/web exec playwright test e2e/landing-field-day.spec.ts --project=chromium`과 해당 Vitest, 4너비 비교, 대상 정책 finding 소멸을 확인한다. 장면 전체가 이전됐다면 `field-day.css`의 남은 규칙을 전수 검토하고 파일과 `PublicSiteLayout.tsx`의 import를 제거한다. `ui:check`는 시안 CSS 1건 등이 남을 수 있으므로 잔여 목록을 기록한다.
- [x] **Step 4: 커밋한다.** `docs/menus/landing.md`, 상태 문서/체크리스트와 변경 코드만 `git commit -m "refactor(web): migrate statistics report and map demos"`.

### Task 7: 보관용 정적 시안의 URL 보존 전환

**Files:** Create `apps/web/concepts/field-day.html`, `apps/web/src/features/landing/FieldDayConceptPage.tsx`; Modify `apps/web/src/main.tsx`, `apps/web/vite.config.ts`, `apps/web/e2e/field-day-inquiry.spec.ts`; Remove `apps/web/public/concepts/field-day.{html,css,js}` only after parity. Preserve `apps/web/public/concepts/index.html` gallery URL.

**Interfaces:** Consumes Task 3의 `LandingStory({ onInquiry, visualVariant: "concept" })`, Task 5–6의 장면 컴포넌트, 기존 `InquiryForm`·단일 `styles.css` 경로. Produces `FieldDayConceptPage(): JSX.Element`, `WebEntry` pathname `/concepts/field-day.html` → 해당 페이지, `PublicSiteLayout`의 `page` union에 `"concept"` 추가, Vite `build.rollupOptions.input`에 `index.html`과 `concepts/field-day.html` 두 물리 entry. 시안은 기존 고유 카피·히어로 100px cap·밑줄·세 상담 CTA와 문의 흐름을 자기 기준대로 유지한다.

- [x] **Step 1: 안전한 RED를 쓴다.** `field-day-inquiry.spec.ts`에 `concept uses the shared Vite entry without public styles` 테스트를 추가한다. `/concepts/index.html`의 상대 링크로 들어가 직접 접근·새로고침·뒤로 가기 후 제목과 세 상담 CTA를 확인하고, 수집한 request pathname에 `/concepts/field-day.css`·`/concepts/field-day.js`가 없어야 한다고 단언한다. `pnpm --filter @led-control/web exec playwright test e2e/field-day-inquiry.spec.ts --project=chromium -g "concept uses the shared Vite entry without public styles"`는 현재 두 공개 자산 요청 때문에 FAIL해야 한다. 기존 성공·503·동일 키·접수 중 닫기 제한·포커스 복귀 테스트는 이관 전 PASS 기준으로 기록한다.
- [x] **Step 2: 최소 구현한다.** Vite 다중 입력 HTML을 프로젝트 루트 `concepts/`에 두고 `src/main.tsx`를 공유한다. `FieldDayConceptPage`는 `PublicSiteLayout page="concept"`와 `LandingStory visualVariant="concept"`를 조합하고, 시안 제목·헤더의 상담/로그인 두 메뉴와 `#top` 브랜드 링크·카피·100px cap·밑줄 등의 고유 차이를 variant로 보존한다. 100px cap은 Task 1의 `--text-landing-concept-hero-fluid` 승인 결과를 소비한다; 반려됐다면 시안 구현 전 Task 1의 정확한 대체 수단을 승인받는다. 옛 HTML/JS/CSS를 제거하고 갤러리의 `href="field-day.html"`을 유지한다. 새 CSS import/style 태그/일회성 인라인 CSS는 만들지 않는다.
- [x] **Step 3: GREEN을 확인한다.** `pnpm --filter @led-control/web exec playwright test e2e/field-day-inquiry.spec.ts --project=chromium`, `pnpm --filter @led-control/web build`를 통과시키고 `apps/web/dist/concepts/field-day.html` 실파일과 자산 경로를 확인한다. 320/390/1024/1440 기준 시안 PNG 및 430/720/1050 경계를 비교한다. `ui:check`는 이 단계에서 0건이어야 하며 남으면 Task 8 전에 원인을 수정한다.
- [x] **Step 4: 커밋한다.** `docs/menus/landing.md`, 상태 문서/체크리스트와 함께 `git commit -m "refactor(web): preserve concept URL with shared React entry"`.

### Task 8: 전체 회귀와 정책 0건 판정

**Files:** Modify only regressions exposed by verification, `docs/menus/landing.md`, `docs/project-status.md`, this plan. Review `apps/web/nginx.conf.template`, `apps/web/Dockerfile` without changing deployment contract.

**Interfaces:** Consumes Task 1–7 산출물. Produces 0건 정책 보고, React/시안별 4너비 시각 비교, production 경로·문의·로그인 격리 증거. 배포·merge·push는 이 작업의 산출물이 아니다.

- [ ] **Step 1: 최종 RED가 남았다면 정확한 경로·rule·match를 기록한다.** `pnpm --filter @led-control/web ui:check`와 `test:ui-policy`의 생산 단언을 실행해 잔여를 확인한다. 실패를 baseline 변경이나 예외로 없애지 말고 해당 소유 Task로 되돌아간다.
- [ ] **Step 2: 전체 GREEN을 실행한다.** `pnpm --filter @led-control/web ui:check`는 `0 existing violations; 0 new/increased violations`, `pnpm --filter @led-control/web test:ui-policy`, `typecheck`, `test`, `build`, 관련 Chromium (`landing.spec.ts`, `landing-field-day.spec.ts`, `field-day-inquiry.spec.ts`, 로그인/운영자 회귀), 루트 `pnpm test`를 통과해야 한다. `files: {}`, 승인 Git ref 실재·값 일치, CSS entry 하나, 공개 CSS 0개를 별도 확인한다.
- [ ] **Step 3: 화면·배포 경로를 판정한다.** React와 시안 각각의 320/390/1024/1440 PNG 및 계산 스타일·애니메이션/reduced-motion을 기준과 비교하고 차이를 전부 분류한다. 429/430/431·719/720/721·1049/1050/1051 및 분수 폭에서 표시 전환을 확인한다. production `dist`를 실제 nginx 설정으로 서빙하여 `/`, `/features`, `/pricing`, `/concepts/index.html`, `/concepts/field-day.html`, `/login` 직접 접근·새로고침·자산 200과 CSS 격리·문의/로그인을 확인한다. 서버 환경이 없으면 운영 경로는 미검증으로 남긴다.
- [ ] **Step 4: 독립 검토 후 커밋한다.** 요구사항·diff·정책·시각·동작·문서 일치 검토의 지적을 소유 Task에서 수정/재검증한다. 최종 상태와 한계를 `docs/project-status.md` 및 이 체크리스트에 똑같이 적고 `git commit -m "docs: record landing UI policy zero verification"`.
