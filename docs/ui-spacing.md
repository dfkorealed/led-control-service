# UI 간격 규칙

기준일: 2026-09-28

## 목적과 적용 범위

이 문서는 Web UI의 간격·색상·타이포그래피 토큰과 정책 검사 기준이다. `apps/web/src/styles/theme.css`의 CSS-first `@theme static`이 단일 토큰 원천이며 JavaScript Tailwind config는 만들지 않는다. Task 12에서 공통 컴포넌트와 모니터링·제어·통계·설정 화면을 승인 utility로 전환하고 legacy selector를 제거했다.

- 적용 범위: 공통 shell/auth/operator UI와 모니터링·제어·통계·설정 메뉴, 공개 랜딩·주요 기능·요금제 및 field-day 시안
- 간격을 변경한 메뉴는 해당 `docs/menus/*.md`에 적용 범위와 검증 결과를 같이 기록한다.

## 간격 스케일

허용 간격은 아래 16개 값이다. Tailwind의 `--spacing: 4px` 곱셈 기능은 임의 숫자도 생성하므로 `ui:check`가 이 목록을 별도로 강제한다. `0`은 간격 초기화 예외이며 승인값 개수에 포함하지 않는다.

| 값 | utility 예시 | 용도 |
| ---: | --- | --- |
| 2px | `p-0.5` | 작은 광학 보정 |
| 4px | `gap-1` | 아이콘과 라벨 |
| 6px | `gap-1.5` | 작은 인라인 요소 |
| 8px | `gap-2` | 라벨과 값 |
| 10px | `p-2.5` | compact control |
| 12px | `gap-3` | 카드 내부 행 |
| 14px | `p-3.5` | 기존 밀도 보존 |
| 16px | `gap-4` | 패널 gap·모바일 padding |
| 18px | `p-4.5` | 제한적 중간 단계 |
| 20px | `gap-5` | control group |
| 24px | `p-6` | 독립 섹션·데스크톱 padding |
| 28px | `gap-7` | 큰 제목 블록 |
| 32px | `gap-8` | 큰 단락 |
| 40px | `p-10` | shell 여백 |
| 48px | `p-12` | 큰 layout 여백 |
| 64px | `p-16` | 최상위 빈 상태 |

삭제된 legacy `--space-1..6`의 의미는 각각 4/8/12/16/24/32px였다. 전환 시 `--space-5`는 `p-6`, `--space-6`은 `p-8`에 대응시켰으며 숫자만 그대로 utility 이름으로 바꾸지 않았다. 음수 margin/위치 utility에도 같은 승인값을 적용한다.

## 배치 원칙

1. 화면의 직계 섹션은 `--space-5`로 분리한다.
2. 같은 섹션에 속한 카드나 패널의 gap은 `--space-4`를 기본으로 한다.
3. 카드 padding은 데스크톱 `--space-5`, 760px 이하 `--space-4`를 기본으로 한다. 단, 정보량이 적은 compact 카드는 뷰포트와 관계없이 `--space-4`를 사용할 수 있다.
4. 반복 요소의 간격은 각 자식의 margin보다 부모 layout의 `gap`으로 소유한다. 요소 내부 기본 margin은 0으로 재설정한다.
5. 고정 높이나 큰 하단 padding으로 내용 영역을 예약하지 않는다. badge와 보조 정보는 기본 문서 흐름 또는 CSS grid 영역에 배치한다.
6. 정보 위계를 보여주기 위한 간격과 단순한 빈 공간을 구분한다. 더 넓은 간격을 사용할 때는 요소가 서로 다른 섹션인지 먼저 확인한다.

## 반응형과 예외

- 신규 utility는 `p-6 max-compact:p-4`처럼 쓴다. `compact=47.5rem`(기본 16px 기준 760px), `tablet=64rem`이며 `max-compact`는 **760px 미만**이다. 기존 compatibility CSS의 `max-width: 760px`는 경계값을 포함하므로 페이지 전환 시 760px 경계도 확인한다. 섹션 간 24px 리듬은 유지한다.
- 44px 최소 터치 영역, safe area, 차트 높이는 간격 토큰이 아닌 사용성 제약이다. compact shell은 공통 `pb-shell-navigation-safe`, `h-shell-navigation-safe`, `pb-safe-area-bottom` utility로 iOS `safe-area-inset-bottom`을 반영하고 feature 코드에는 raw `env(...)`를 쓰지 않는다.
- 텍스트 줄바꿈으로 카드 높이가 달라질 수 있으며, 정렬을 위해 내용을 잘라내거나 터치 영역을 줄이지 않는다.
- `0`, percentage/viewport, runtime geometry 계산, border 1px과 최소 터치 영역 44px는 일반 spacing과 구분한다. `exceptions.css`에는 React Konva가 생성하는 `.konvajs-content`/canvas 크기·위치 selector만 남긴다. Recharts chart margin과 Konva geometry 값은 JS runtime exact-count allowlist로 관리한다. 예외에는 이유·대상·utility로 대체할 수 없는 근거를 기록하며 정적 padding/margin/gap/color는 예외로 옮기지 않는다.

## 통계 메뉴 적용

- 페이지 헤더, 수집 공백 안내, KPI, 보고서 패널 사이는 24px을 사용한다.
- KPI 그리드와 차트·비용 패널 사이는 16px을 사용한다.
- KPI 카드는 16px compact padding을 사용하고 상태 badge를 첫 행의 라벨과 함께 배치한다.
- 차트·비용 패널은 데스크톱 24px, 760px 이하 16px padding을 사용한다.
- 760px 이하의 KPI는 라벨·값·보조 설명·badge를 순서대로 쌓아 라벨이 한 글자씩 줄바꿈되는 것을 막는다. 차트 제목과 기간 탭도 세로로 배치해 제목을 말줄임하지 않는다.

## Shell layout 크기 토큰

| token | 값 | 용도 |
| --- | ---: | --- |
| `--spacing-shell-rail` | 88px | 고객 desktop navigation rail |
| `--container-auth` | 960px | 로그인 2열 composition 최대 폭 |
| `--container-operator` | 1160px | 운영자 shell content 최대 폭 |
| `--container-status-drawer` | 440px | 상태센터 우측 drawer 최대 폭 |

이 값들은 padding, margin, gap scale을 확장하지 않는 layout geometry다. 760px 미만 navigation과 safe-area 높이는 기존 utility 계약을 유지한다.

## 검증 규칙

```bash
node --test apps/web/scripts/ui-policy.test.mjs
pnpm --filter @led-control/web ui:check
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web test
pnpm --filter @led-control/web build
```

정책은 production `src`의 CSS/JS/TS/JSX/TSX를 검사하고, production module에서 test/e2e 경로를 import하는 우회를 거부한다. `index.html`의 style/stylesheet 진입점과 `public` CSS도 인벤토리하며, canonical `styles.css`의 필수 import는 각각 정확히 한 번만 존재해야 한다. 테스트 파일·test/e2e 디렉터리 내부의 금지 예시는 직접 부채로 집계하지 않지만 production graph에 연결되면 실패한다. Tailwind source에서도 scripts/e2e/test fixture를 제외하여 금지 예시 클래스가 배포 CSS로 생성되지 않게 한다. `theme.css`의 `@theme` 안 semantic color와 typed scale 선언만 literal을 허용하며, 해당 파일의 일반 CSS 규칙은 계속 검사한다. Fix Round 2부터 승인 Git theme의 이름→값 map과 비교하므로 spacing·typography·breakpoint·color·radius·shadow·namespace reset의 값 변경도 별도의 anchor 검토가 필요하다. 주석·공백·함수 구분자 주변 서식과 마지막 세미콜론 생략은 허용하지만 값의 의미를 자동 동치 변환하지 않는다.

차단 항목은 arbitrary spacing/color/typography, 미승인 숫자 spacing과 기본 palette/typography utility, CSS·inline 정적 spacing/typography와 literal color, production `querySelector`/`querySelectorAll`(TypeScript generic 포함), 미승인 CSS 파일/import/selector, 공통 UI 밖의 신규 native form style이다. 검사기는 정적 문자열을 읽는 lexical guard이므로 동적 클래스 조합·전체 JS/CSS 의미 해석과 런타임 geometry의 타당성은 코드 검토로 보완한다.

Task 12 baseline의 violation map은 비어 있으며 production 정책 부채는 **0건**이어야 한다. `inspectWorkspace`는 non-empty allowance를 거부하고 CLI도 빈 map만 허용한다. entry stylesheet import와 문서화된 runtime 예외는 baseline 부채가 아니라 정책 코드의 exact allowlist로 관리한다.

2026-09-16 최종 검증에서 UI policy **53/53**, `ui:check` **기존 0·신규/증가 0**, Web Vitest **83 files·1,224/1,224**, 1440×900·1024×768·390×844·320×740 layout assertions를 포함한 전체 Chromium 직렬 **257 passed·5 environment-gated skipped·실패 0**을 확인했다. 별도 opt-in RealBackendLab도 설치 여정 **2/2**와 층 배치·제어·통계 **1/1**을 통과했다. 루트 `pnpm test`도 fail-closed UI 정책 체인을 포함한 상태로 통과했다. 실제 native WebView safe-area 실측과 수동 in-app 시각 QA는 별도 후속 검증이다.

baseline의 `sourceRef`는 scanner에 고정된 승인 Git commit `24b5ea593e860575f7bf1007781146cf1101beb7`과 일치해야 한다. Git object가 없거나 sourceRef·빈 map이 변조되면 fail-closed한다. canonical root unit gate가 Web `test:ui-policy`와 `ui:check`를 일반 unit 뒤에 실행하고, CI unit checkout은 `fetch-depth: 0`으로 승인 object를 확보한다.

`p-px`와 정적 `calc`/`clamp` 간격, semantic typography의 `/7`·`/[17px]`·변수 line-height modifier, 계산식 안의 literal font-size를 거부한다. 측정/percentage/viewport를 사용하는 runtime position은 별도 예외이며 일반 padding/margin/gap에 임의 간격을 더하는 수단으로 쓰지 않는다. 허용 token 이름은 승인 commit의 canonical `theme.css`에서 읽는다. 신규 `--text-rogue`, `bg-surface-pannel` 같은 오타와 `max-[777px]:*` 같은 임의 breakpoint는 정책 오류다. CSS import의 query/hash suffix도 원본 resource ID 기준으로 검사한다.

주석 처리는 기존 TypeScript parser의 실제 trivia 위치를 사용해 trailing/JSX comment를 제거하고 URL·문자열·template 내용을 보존한다. CSS는 문자열을 인식하는 comment scan을 사용한다. `test:ui-policy`에는 실제 Vite 메모리 빌드의 semantic/spacing/typography/`max-compact` 생성 및 test fixture 클래스 제외 검증이 포함된다. standalone 두 정책 command는 canonical root/CI unit gate에 연결되어 있다.

색상은 JSX template의 정적 구간, `backgroundImage`/`background-image`, `boxShadow`/`box-shadow`, `text-shadow`, `filter`/`drop-shadow` 및 SVG `stopColor`/`stop-color`의 literal도 검사한다. TypeScript AST로 template expression을 분리하므로 semantic `var(--color-...)`와 runtime palette/shadow 표현식은 named color로 오인하지 않는다. URL payload는 제외하되 그 뒤 쉼표·줄바꿈으로 연결된 gradient는 계속 검사한다.

Canonical theme는 단 하나의 `@theme static` block에 승인 anchor의 모든 token을 정확히 한 번씩 선언해야 한다. Token이나 block 삭제, 같은 값의 중복 선언, unknown/value 변경, `@theme inline` 같은 다른 형식과 추가 block은 fail-closed한다. 공백·주석·마지막 세미콜론 생략 허용은 유지한다.

- 1440×900, 1024×768, 390×844, 320×740 뷰포트에서 계산된 section gap, grid gap, panel padding을 확인한다.
- 상태 badge가 absolute positioning으로 빈 영역을 예약하지 않는지 확인한다.
- 간격 변경 후에도 문서 수준 가로 overflow와 44×44px 터치 영역 회귀를 함께 실행한다.

## 색상 inventory와 semantic mapping

색상값은 [theme.css](../apps/web/src/styles/theme.css)에만 새로 선언한다. 아래는 초기 역할 매핑이며 기존 페이지 literal은 baseline 부채로 유지한다. 우연히 같은 값이어도 역할이 다른 토큰은 구분한다.

| 기존 출처·역할 | semantic token | 보존한 값 |
| --- | --- | --- |
| 전역 root의 Navy/Blue/Coral/Paper | `brand-*`, `content-primary`, `action-primary`, `surface-canvas` | `#15324a`, `#256fa1`, `#ff7a5c`, `#f4f8fa` |
| panel/inset/tooltip 역상, 본문/비활성·경계 | `surface-*`, `content-*`, `border-*` | 기존 panel, feedback, tooltip, control 선언 |
| primary hover/soft, danger button | `action-*` | `#1d5c86`, `#e8f2f8`, `#fff7f7`/`#b91c1c`/`#fecaca` |
| status badge·feedback | `status-{neutral,info,success,warning,danger}-{foreground,background,border}` | 기본 상태값과 기존 배경·경계값 |
| badge/feedback의 별도 대비색 | `status-*-badge`, `status-*-feedback-*` | `#a16207`, `#be123c`, `#0b63e5`, `#166534`, `#92400e`, `#991b1b` 등 |
| StatisticsOverview 실제 사용량·EnergyComparison 기준/예측 | `chart-usage`, `chart-baseline`, `chart-forecast` | `#256fa1`, `#e8f2f8`, `#b45309` |
| 비용/경고 의미, ranking line, grid와 점 | `chart-cost`, `chart-ranking`, `chart-grid`, `chart-point` | `#b45309`, `#2563eb`, `#dbe7f5`, `#ffffff` |
| heatmap cell·legend의 기존 단계 | `chart-heatmap-{empty,default,1..5}` | `#eff6ff`, `#dbeafe`, `#bfdbfe`, `#93c5fd`, `#60a5fa`, `#2563eb`, `#1e3a8a` |
| fixture-dot의 online/awaiting/offline/fault | `fixture-connected`, `fixture-inspection`, `fixture-offline`, `fixture-fault` | `#15803d`, `#ca8a04`, `#94a3b8`, `#dc2626` |
| fixture-dot 밝기 10단계 | `fixture-brightness-1..10`, `fixture-off`, `fixture-on` | 기존 `#334155`부터 `#fffde8`까지 각 단계 |
| EditorFixtureNode/FloorEditorCanvas/EditorMinimap | `fixture-editor-*` | 기존 online `#159f81`, offline `#8b929f`, fault `#d84c58`, 선택 `#185ed0` 및 도형/guide/preview 값 |

`chart-cost`는 현재 warning 기반 비용 의미를 초기 매핑한 Task 2 typed adapter 최소 토큰이다. 아직 독립 비용 시계열은 구현하지 않았다. `action-primary-active`는 기존 hover와 같은 색으로 시작하며 새로운 상호작용을 추가하지 않는다. 색상 adapter와 공통 컴포넌트 전환은 Task 2 이후다.


## 공개 랜딩 Task 1 — 전수 감사와 역할 토큰 승인

2026-09-28, 기준 commit `029c35f802cec9c9f89219f7dbccbbb30beb5f8a`에서 React `/`, `/features`, `/pricing`와 static `/concepts/field-day.html`를 각각 자기 화면 기준으로 감사했다. 320/390/1024/1440px, 높이900px, DPR1, Chromium149.0.7827.55, ko-KR, reduced-motion reduce 조건에서 전체·제목·데모·상담 PNG124개를 ignored `apps/web/.local/landing-visuals/baseline/`에 저장했다. 이는 전환 전 기준 증거이며 전환 후 시각 동치 증거가 아니다.

기준 `ui:check`는 기존925·신규/증가925건으로 실패했다. 이번 Task1은 **승인된 토큰만 추가하는 중간 커밋**이다. 기존 theme 값, immutable policy ref, baseline, 화면 컴포넌트와 CSS는 변경하지 않는다. 뒤의 정책 ref 회전 및 화면 전환 전까지 전체 `test:ui-policy`와 `ui:check`는 계속 실패한다. 신규 focused test의 PASS를 정책 전체 PASS로 해석하지 않는다. 실제 중간 검증은 focused1/1 PASS, 전체 정책63개 중59PASS·4FAIL, `ui:check` 기존1368·신규/증가1368 FAIL이었다. 기존925건에 옛 승인 ref가 신규 선언을 미승인으로 판정한443건이 추가됐다.

독립 pre-RED 검토는 첫 inventory에서 서체/반경의 역할 경계와 불필요한 상속 token을 지적했다. 수정 후 I1–I3와 Minor1–3 모두 ADDRESSED, spec/quality PASS, 새 Important0으로 검토됐다. 총괄은 이 결과를 근거로 **369개 flat 선언**을 승인했다. 승인 JSON의 SHA-256은 `076c52be2aa4e81b7308ae4c680af8bac4bae74e2a2fc1028aa661c1bba4182a`다. 아래 표가 저장소에 보존되는 이름→값·소비자 계약이며 focused test가 같은 승인값과 선언1회를 독립적으로 고정한다.

### 기존 토큰 적합성 및 동등성 기준

- 기존 spacing의0/2/4/6/8/10/12/14/16/18/20/24/28/32/40/48/64px는 정확한 standard utility를 쓴다. 기존 canonical semantic color와 radius-control10px/fixture-marker3px도 대응 역할에 재사용한다.
- React hero의 `clamp(55px, 5.3vw, 78px)`와 static hero의 `clamp(55px, 6.7vw, 100px)`는 각각 핵심 역할이다. 기존 landing-hero4rem을 덮어쓰지 않는다. 두 역할은 행간1.15/자간-.085em을 동반 속성으로 소유한다.
- eyebrow13px는 기존 body-sm13px와 크기가 같아도 기존 token이20px 행간을 강제하므로 대체하지 않는다. 원래 자간.16em과 상속 행간을 보존한다. 나머지 font-size-only 역할도 기존 paired typography의 강제 행간이 다르면 독립 역할이 필요하다.
- glass-panel18px는 기존 panel14px와 다르며 hero/preview glass surface가 공유한다. 상담 dialog18px는 별도 inquiry-modal 역할이다. DemoCard의 `0 18px 55px rgb(21 50 74 / .10)`은 기존 panel의 `0 8px 24px rgb(30 64 175 / 0.06)`으로 근사하지 않는다.
- 50% 반경은 원과 타원을 포함하므로 named ellipse를 유지한다. 99px/999px pill은16조합 box20개 실측에서 짧은 변의 절반이 각각 status≤14.5px, slider≤3.5px, badge≤16.25px라 CSS overlap 결과가 기존9999px pill과 동일하다. specified/computed radius 문자열 차이는 인정하며 paint geometry 동치만 주장한다.
- 상속으로 제거 가능한 privacy strong의12px 선언은 parent12px/1.65를 그대로 상속시킨다. 요소/weight를 유지하고 새 token을 만들지 않는다. 상태 기반 selector를 dead selector로 오인해 지우지 않는다.

### 표를 읽는 방법과 전환 제약

전수 표의 세 갈래는 **기존 토큰 적합 / 유틸리티로 정확 표현 / 새 의미 토큰 필요**다. `새 의미 토큰 필요`는 아래 최종 승인표의 역할로 해소한다. 횟수는 DOM 수가 아닌 CSS 선언 또는 px 출현 수이며, R은 `apps/web/src/features/landing/field-day.css`, C는 `apps/web/public/concepts/field-day.css`의 기준 행이다. 원본 파일 전환 후에는 이 기준 provenance를 유지한다. 실제 반복은 scene5/demo5/feature card4/detail4/preview작은4·확장4/pricing2개다.

- Percentage 위치는 정확한 fraction geometry utility로 표현한다. padding/margin/gap의 percentage나 clamp는 문서 spacing이며 runtime 예외가 아니다. 새 shorthand spacing token은 표에 적힌 p/m/py/gap 등 **원래 속성에서만** 사용하고 다른 치수로 전용하지 않는다. 향후 compile gate에서 복합값·reset·반응형 우선순위를 검증한다.
- React의 기본1.5와 static의 normal 행간 상속은 각 baseline으로 보존한다. font-size-only responsive utility는 base companion을 제거하거나 새 행간을 강제하지 않는다. 서로 다른 narrative/heading/action 역할을 숫자가 같다는 이유만으로 합치지 않는다.
- 원래 DOM/SVG 구조와 애니메이션을 유지한다. wrapper 간격 합산, margin의 transform 대체, scanner 예외, arbitrary property 우회 및 근사값은 사용하지 않는다.
- 순수 spread shadow를 semantic-color ring으로 옮기는 경로는 후속 compile/PNG 검증이 필요하다. offset·blur·복합·runtime glow는 승인된 shadow 역할을 유지한다.
- animation11개는 기존 shorthand의 duration/easing/delay/fill을 정확히 보존한다. 생략된 delay0s/easing ease/iteration1/direction normal은 CSS 기본값이다. report-history는 같은 report-row-in keyframe의1.45s delay 역할이다. theme는 평평하게 유지하고 keyframe body는 후속 canonical styles task에서 옮긴다. nth-child delay와 replay/reduced-motion도 후속 동작 gate 대상이다.
- 이번 값 승인과 focused 테스트는 utility 생성/시각·동작 동치를 아직 보증하지 않는다. 포함형430/720/1050px variant, production URL, PNG 비교와 전체 정책0건은 후속 Task gate다.

## React 전수 분류

### font-size — 36종

| 정확 값 | 횟수 | 분류·판단 | 위치 |
|---|---:|---|---|
| `14px` | 6 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L35 `.button`; L73 `.hero-contact`; L115 `.scene-benefit`; L282 `.feature-detail__copy > a`; L304 `.footer h2`; L355 `.feature-detail__copy > p:not(.feature-detail__outcome), .feature-detail li` |
| `13px` | 7 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L47 `.eyebrow`; L55 `.header-nav`; L180 `.control-panel__heading`; L267 `.feature-card p`; L268 `.feature-card a`; L296 `.inquiry-selected-plan`; L301 `.footer` |
| `22px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L53 `.brand`; L225 `.report-sheet h3` |
| `inherit` | 1 | 유틸리티로 정확 표현 — 상속 유지; inherited typography는 text-inherit와 색 의미 혼동 금지 | L58 `.header-contact` |
| `clamp(55px, 5.3vw, 78px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L68 `.hero h1` |
| `clamp(16px, 1.55vw, 20px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L70 `.hero-copy > p:not(.eyebrow)` |
| `10px` | 19 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L75 `.hero-footer`; L80 `.hero-art__panel--back span`; L131 `.demo-disclaimer`; L137 `.floorplan__top, .floorplan__legend`; L147 `.floorplan__entry`; L158 `.inspector__label`; L160 `.status-pill`; L163 `.inspector dl div`; L186 `.range-ends`; L194 `.chart-heading div span`; L196 `.chart-unit`; L212 `.chart-x`; L213 `.chart-foot`; L220 `.format-button`; L228 `.report-row span`; L234 `.report-history strong`; L243 `.map-tools .button`; L255 `.map-canvas__hint`; L362 `.report-controls > span` |
| `11px` | 19 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L85 `.hero-art__panel--front span`; L108 `.scene-number`; L126 `.demo-title small`; L132 `.demo-status`; L178 `.control-visual__caption`; L187 `.control-hint`; L218 `.report-controls`; L225 `.report-sheet > p`; L228 `.report-row strong`; L242 `.map-tools > span`; L250 `.map-canvas__room`; L256 `.map-bottom`; L265 `.feature-card__number`; L291 `.pricing-card__head small`; L306 `.footer-bottom`; L354 `.feature-card p, .feature-card strong`; L356 `.header-nav`; L356 `.header-contact`; L356 `.button--header` |
| `clamp(17px, 2.1vw, 26px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L86 `.hero-art__panel--front strong` |
| `clamp(120px, 17vw, 250px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L104 `.scene::before` |
| `clamp(43px, 4.55vw, 70px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L110 `.scene h2` |
| `clamp(16px, 1.35vw, 18px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L113 `.scene-description` |
| `20px` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L116 `.scene-benefit::before`; L195 `.chart-heading strong`; L356 `.brand` |
| `12px` | 13 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L124 `.demo-title`; L128 `.replay-button`; L267 `.feature-card strong`; L277 `.feature-overview__note`; L281 `.feature-detail li::before`; L283 `.feature-detail__preview > span`; L294 `.pricing-card li span`; L295 `.pricing-section__note`; L344 `.header-nav`; L344 `.header-contact`; L344 `.button--header`; L354 `.feature-card a`; L358 `.scene-benefit` |
| `18px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L130 `.replay-button:first-letter` |
| `17px` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L159 `.inspector > strong`; L262 `.section-intro > p:last-child`; L300 `.closing p:not(.eyebrow)` |
| `28px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L181 `.control-panel__heading strong` |
| `9px` | 4 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L198 `.chart-y`; L223 `.report-sheet__top, .report-sheet__footer`; L224 `.report-sheet__top small`; L233 `.report-history` |
| `clamp(40px, 4.4vw, 66px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L261 `.section-intro :is(h1, h2)` |
| `clamp(22px, 2vw, 28px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L266 `.feature-card h2` |
| `clamp(36px, 4vw, 58px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L280 `.feature-detail h2` |
| `16px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L280 `.feature-detail__copy > p:not(.feature-detail__outcome)`; L361 `.chart-heading strong` |
| `15px` | 10 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L281 `.feature-detail li`; L282 `.feature-detail__outcome`; L291 `.pricing-card__head`; L292 `.pricing-card__summary`; L293 `.pricing-card__price span`; L294 `.pricing-card li`; L354 `.section-intro > p:last-child`; L357 `.hero-copy > p:not(.eyebrow)`; L358 `.scene-description`; L365 `.closing p:not(.eyebrow)` |
| `19px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L284 `.feature-detail__preview .feature-preview__control small`; L362 `.report-sheet h3` |
| `clamp(34px, 3.2vw, 48px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L293 `.pricing-card__price strong` |
| `clamp(46px, 6vw, 82px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L299 `.closing h2` |
| `23px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L303 `.footer-company strong` |
| `clamp(37px, 7.4vw, 48px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L342 `.feature-detail h2` |
| `clamp(48px, 10vw, 72px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L345 `.hero h1` |
| `clamp(40px, 8.2vw, 58px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L346 `.scene h2` |
| `40px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L354 `.section-intro :is(h1, h2)` |
| `21px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L354 `.feature-card h2` |
| `37px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L355 `.feature-detail h2` |
| `clamp(46px, 11vw, 57px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L357 `.hero h1` |
| `clamp(38px, 10vw, 48px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L358 `.scene h2` |
| `clamp(40px, 10vw, 52px)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L365 `.closing h2` |

### line-height — 14종

| 정확 값 | 횟수 | 분류·판단 | 위치 |
|---|---:|---|---|
| `1.2` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L35 `.button`; L110 `.scene h2`; L299 `.closing h2` |
| `1.15` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L68 `.hero h1` |
| `1.8` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L70 `.hero-copy > p:not(.eyebrow)`; L113 `.scene-description`; L280 `.feature-detail__copy > p:not(.feature-detail__outcome)` |
| `1.6` | 4 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L115 `.scene-benefit`; L281 `.feature-detail li`; L304 `.footer-contact dl div`; L306 `.footer-bottom` |
| `1` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L116 `.scene-benefit::before` |
| `1.55` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L131 `.demo-disclaimer`; L187 `.control-hint`; L267 `.feature-card strong` |
| `1.5` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L132 `.demo-status`; L294 `.pricing-card li` |
| `1.18` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L261 `.section-intro :is(h1, h2)` |
| `1.75` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L262 `.section-intro > p:last-child` |
| `1.35` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L266 `.feature-card h2` |
| `1.65` | 4 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L267 `.feature-card p`; L282 `.feature-detail__outcome`; L292 `.pricing-card__summary`; L303 `.footer-company p` |
| `1.24` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L280 `.feature-detail h2` |
| `1.1` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L293 `.pricing-card__price strong` |
| `1.7` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L295 `.pricing-section__note`; L300 `.closing p:not(.eyebrow)` |

### letter-spacing — 20종

| 정확 값 | 횟수 | 분류·판단 | 위치 |
|---|---:|---|---|
| `.16em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L47 `.eyebrow` |
| `-.07em` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L53 `.brand`; L280 `.feature-detail h2` |
| `-.085em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L68 `.hero h1` |
| `.2em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L75 `.hero-footer` |
| `.15em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L80 `.hero-art__panel--back span` |
| `-.05em` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L86 `.hero-art__panel--front strong`; L181 `.control-panel__heading strong`; L225 `.report-sheet h3` |
| `-.1em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L104 `.scene::before` |
| `-.045em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L105 `.scene--monitoring::before` |
| `.12em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L108 `.scene-number` |
| `-.073em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L110 `.scene h2` |
| `-.04em` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L159 `.inspector > strong`; L195 `.chart-heading strong` |
| `.1em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L223 `.report-sheet__top, .report-sheet__footer` |
| `0` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L224 `.report-sheet__top small`; L232 `.report-sheet__footer`; L291 `.pricing-card__head small` |
| `-.075em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L261 `.section-intro :is(h1, h2)` |
| `.11em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L265 `.feature-card__number` |
| `-.055em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L266 `.feature-card h2` |
| `.08em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L281 `.feature-detail li::before` |
| `.04em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L291 `.pricing-card__head` |
| `-.06em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L293 `.pricing-card__price strong` |
| `-.08em` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L299 `.closing h2` |

### border-radius — 23종

| 정확 값 | 횟수 | 분류·판단 | 위치 |
|---|---:|---|---|
| `8px` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L32 `.skip-link`; L54 `.brand img`; L243 `.map-tools .button` |
| `12px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L35 `.button`; L136 `.floorplan` |
| `15px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L46 `.card` |
| `50%` | 21 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L63 `.hero-orbit`; L77 `.hero-art__ring`; L94 `.hero-art__pulse`; L127 `.demo-title__dot`; L148 `.fixture`; L149 `.fixture span`; L154 `.floorplan__legend i`; L161 `.status-pill i`; L172 `.control-visual__glow`; L174 `.control-visual__lamp::before`; L177 `.control-visual__floor`; L183 `.control-panel input[type="range"]::-webkit-slider-thumb`; L184 `.control-panel input[type="range"]::-moz-range-thumb`; L214 `.chart-foot i`; L245 `.map-tools .button--tool i`; L246 `.map-drag-ghost`; L252 `.map-light`; L270 `.feature-preview__header span`; L272 `.feature-preview__map span, .feature-preview__editor i`; L273 `.feature-preview__control i`; L294 `.pricing-card li span` |
| `18px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L78 `.hero-art__panel`; L269 `.feature-preview` |
| `10px` | 2 | 기존 토큰 적합 — radius-control / radius-fixture-marker; 16px root 기준 | L81 `.hero-art__panel--back i`; L248 `.map-canvas` |
| `5px 5px 0 0` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L88 `.hero-art__panel--front b` |
| `30px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L119 `.demo-wrap::after` |
| `20px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L122 `.demo-card`; L355 `.feature-detail__preview` |
| `9px` | 3 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L128 `.replay-button`; L233 `.report-history`; L296 `.inquiry-selected-plan` |
| `7px` | 4 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L139 `.floorplan__drawing`; L220 `.format-button`; L271 `.feature-preview__map`; L275 `.feature-preview__report` |
| `4px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L147 `.floorplan__entry`; L273 `.feature-preview__control > span` |
| `99px` | 2 | 기존 토큰 후보 — radius-pill; 실제 box 기반 곡률 동치 검증 필요 | L160 `.status-pill`; L182 `.control-panel input[type="range"]` |
| `0 0 31px 31px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L173 `.control-visual__lamp` |
| `6px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L228 `.report-row i`; L255 `.map-canvas__hint` |
| `5px` | 2 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L273 `.feature-preview__control > div:not(.feature-preview__schedule)`; L273 `.feature-preview__schedule b` |
| `inherit` | 1 | 유틸리티로 정확 표현 — 상속 유지; inherited typography는 text-inherit와 색 의미 혼동 금지 | L273 `.feature-preview__control > div:not(.feature-preview__schedule)::before` |
| `4px 4px 0 0` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L274 `.feature-preview__chart span` |
| `3px` | 1 | 기존 토큰 적합 — radius-control / radius-fixture-marker; 16px root 기준 | L275 `.feature-preview__report i` |
| `35px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L283 `.feature-detail__preview` |
| `24px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L283 `.feature-detail__preview .feature-preview` |
| `999px` | 1 | 기존 토큰 후보 — radius-pill; 실제 box 기반 곡률 동치 검증 필요 | L291 `.pricing-card__head small` |
| `16px` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L355 `.feature-detail__preview .feature-preview` |

### box-shadow — 20종

| 정확 값 | 횟수 | 분류·판단 | 위치 |
|---|---:|---|---|
| `0 8px 24px rgb(23 32 51 / .14)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L51 `.site-header.is-scrolled` |
| `0 0 80px rgb(37 111 161 / .20)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L77 `.hero-art__ring` |
| `0 25px 50px rgb(23 32 51 / .26)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L78 `.hero-art__panel` |
| `0 0 0 16px rgb(255 122 92 / .18)` | 1 | 유틸리티 정확 표현 후보 — semantic color ring과 현재 그림자 합성 동치 확인; 신규 shadow 최소화 | L94 `.hero-art__pulse` |
| `var(--shadow)` | 1 | 새 의미 토큰 필요 — 승인 요청 shadow-landing-demo-card | L122 `.demo-card` |
| `0 0 0 3px var(--panel)` | 1 | 유틸리티 정확 표현 후보 — semantic color ring과 현재 그림자 합성 동치 확인; 신규 shadow 최소화 | L149 `.fixture span` |
| `0 0 0 5px var(--soft-blue), 0 0 0 9px rgb(37 111 161 / .12)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L150 `.fixture:hover span, .fixture[aria-pressed="true"] span` |
| `0 0 var(--floor-glow, 15px) rgb(232 242 248 / .42)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L177 `.control-visual__floor` |
| `0 0 0 2px var(--blue)` | 2 | 유틸리티 정확 표현 후보 — semantic color ring과 현재 그림자 합성 동치 확인; 신규 shadow 최소화 | L183 `.control-panel input[type="range"]::-webkit-slider-thumb`; L184 `.control-panel input[type="range"]::-moz-range-thumb` |
| `0 12px 30px rgb(21 50 74 / .07)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L222 `.report-sheet` |
| `0 0 0 6px var(--soft-blue), 0 7px 17px rgb(21 50 74 / .24)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L246 `.map-drag-ghost` |
| `0 0 0 5px var(--soft-blue)` | 1 | 유틸리티 정확 표현 후보 — semantic color ring과 현재 그림자 합성 동치 확인; 신규 shadow 최소화 | L252 `.map-light` |
| `0 9px 32px rgb(21 50 74 / .05)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L264 `.feature-card` |
| `12px 14px 0 var(--soft-blue)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L269 `.feature-preview` |
| `0 0 0 1px var(--blue)` | 1 | 유틸리티 정확 표현 후보 — semantic color ring과 현재 그림자 합성 동치 확인; 신규 shadow 최소화 | L273 `.feature-preview__control i` |
| `0 7px 16px rgb(21 50 74 / .11)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L275 `.feature-preview__report` |
| `17px 20px 0 rgb(37 111 161 / .1)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L283 `.feature-detail__preview .feature-preview` |
| `0 12px 36px rgb(21 50 74 / .06)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L289 `.pricing-card` |
| `0 20px 54px rgb(21 50 74 / .11)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L290 `.pricing-card--featured` |
| `6px 7px 0 var(--soft-blue)` | 1 | 새 의미 토큰 필요 — 위 공통/핵심 역할과 반응형 variant로 소유 | L354 `.feature-preview` |

### 승인 단계 밖 간격 — 57종·175회

px 수치의 출현 단위다. shorthand/clamp 내 두 수치는 두 번 센다. 기존 승인 0/2/4/6/8/10/12/14/16/18/20/24/28/32/40/48/64px는 기존 p/m/gap utility로 정확 전환한다. Percentage position은 `top-23/100` 등 fraction geometry utility로 정확 표현하고 width/height/min/max/aspect/transform geometry는 허용 utility를 쓴다. Fraction을 padding·margin·gap에 쓰지 않는다.

| 값 | 횟수 | 분류 | 위치·속성·전체 값 |
|---|---:|---|---|
| -250px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L65 `.hero-orbit--two` right: `-250px` |
| -100px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L32 `.skip-link` top: `-100px` |
| -90px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L64 `.hero-orbit--one` right: `-90px` |
| -65px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L175 `.control-visual__lamp span` top: `-65px` |
| -38px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L119 `.demo-wrap::after` bottom: `-38px` |
| -35px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L119 `.demo-wrap::after` right: `-35px` |
| -15px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L345 `.hero-art` margin-top: `-15px` |
| -13px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L346 `.demo-wrap::after` bottom: `-13px` |
| -5px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L198 `.chart-y` top: `-5px`; L357 `.hero-art` margin-top: `-5px` |
| 3px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L54 `.brand img` padding: `3px` |
| 5px | 6 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L147 `.floorplan__entry` padding: `5px 9px`; L153 `.floorplan__legend span` gap: `5px`; L160 `.status-pill` gap: `5px`; L225 `.report-sheet h3` margin: `37px 0 5px`; L274 `.feature-preview__chart` padding: `15px 5px 6px`; L344 `.header-inner` gap: `5px 20px` |
| 7px | 8 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L214 `.chart-foot span:first-child` gap: `7px`; L241 `.map-tools` gap: `7px`; L273 `.feature-preview__schedule` gap: `7px`; L274 `.feature-preview__chart` gap: `7px`; L293 `.pricing-card__price` gap: `7px`; L347 `.inspector` gap: `7px 12px`; L356 `.button--header` padding-inline: `7px`; L359 `.demo-title` gap: `7px` |
| 9px | 6 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L87 `.hero-art__panel--front div` gap: `9px`; L147 `.floorplan__entry` padding: `5px 9px`; L160 `.status-pill` padding: `6px 9px`; L182 `.control-panel input[type="range"]` margin: `28px 0 9px`; L220 `.format-button` padding: `0 9px`; L255 `.map-canvas__hint` padding: `6px 9px` |
| 11px | 8 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L131 `.demo-disclaimer` padding: `11px 22px`; L137 `.floorplan__top, .floorplan__legend` padding: `11px 13px`; L232 `.report-sheet__footer` padding-top: `11px`; L273 `.feature-preview__control small` margin-top: `11px`; L282 `.feature-detail__copy > a` gap: `11px`; L284 `.feature-detail__preview .feature-preview__chart` gap: `11px`; L296 `.inquiry-selected-plan` padding: `11px 14px`; L344 `.button--header` padding-inline: `11px` |
| 13px | 6 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L137 `.floorplan__top, .floorplan__legend` padding: `11px 13px`; L163 `.inspector dl div` padding-top: `13px`; L233 `.report-history` padding: `10px 13px`; L257 `.map-content > .demo-status` margin-top: `13px`; L359 `.demo-toolbar` padding-inline: `13px`; L359 `.demo-disclaimer` padding-inline: `13px` |
| 15px | 17 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L87 `.hero-art__panel--front div` margin-top: `15px`; L189 `.control-panel .demo-status` margin-top: `15px`; L193 `.chart-heading` gap: `15px`; L236 `.report-content > .demo-status` margin: `15px auto 0`; L255 `.map-canvas__hint` left: `15px`; L266 `.feature-card h2` margin: `15px 0 10px`; L274 `.feature-preview__chart` padding: `15px 5px 6px`; L304 `.footer-contact dl` gap: `15px`; L345 `.hero-inner` gap: `15px`; L345 `.hero-art__panel--back` padding: `15px`; L348 `.control-panel` margin: `15px`; L354 `.feature-card a` margin-top: `15px`; L355 `.feature-detail__preview .feature-preview__map, .feature-detail__preview .feature-preview__editor` inset: `50px 15px 15px`; L355 `.feature-detail__preview .feature-preview__map, .feature-detail__preview .feature-preview__editor` inset: `50px 15px 15px`; L357 `.hero-actions` gap: `15px`; L362 `.report-content` padding: `15px 12px`; L364 `.map-content` padding: `15px 12px` |
| 17px | 9 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L110 `.scene h2` margin: `17px 0 24px`; L218 `.report-controls` margin-bottom: `17px`; L273 `.feature-preview__schedule` margin-top: `17px`; L274 `.feature-preview__chart` margin: `14px 17px`; L282 `.feature-detail__outcome` padding: `14px 0 14px 17px`; L303 `.footer-company p` margin: `17px 0 24px`; L354 `.feature-card` padding: `17px`; L355 `.feature-detail__preview .feature-preview__chart` margin: `22px 17px`; L358 `.scene-benefit` padding-top: `17px` |
| 19px | 6 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L35 `.button` padding: `0 19px`; L178 `.control-visual__caption` bottom: `19px`; L283 `.feature-detail__preview .feature-preview__header` padding-inline: `19px`; L299 `.closing h2` margin: `19px 0 24px`; L355 `.feature-detail__preview .feature-preview__schedule` margin-top: `19px`; L358 `.scene-benefit` margin-top: `19px` |
| 22px | 10 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L68 `.hero h1` margin: `22px 0 26px`; L123 `.demo-toolbar` padding: `0 22px`; L131 `.demo-disclaimer` padding: `11px 22px`; L198 `.chart-y` bottom: `22px`; L239 `.map-content` padding: `20px 24px 22px`; L280 `.feature-detail h2` margin: `20px 0 22px`; L284 `.feature-detail__preview .feature-preview__map, .feature-detail__preview .feature-preview__editor` inset: `60px 24px 22px`; L304 `.footer h2` margin: `4px 0 22px`; L355 `.feature-detail__preview .feature-preview__control` padding: `33px 22px`; L355 `.feature-detail__preview .feature-preview__chart` margin: `22px 17px` |
| 23px | 6 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L115 `.scene-benefit` padding-top: `23px`; L179 `.control-panel` padding: `23px`; L217 `.report-content` padding: `20px 25px 23px`; L226 `.report-rule` margin: `23px 0 8px`; L268 `.feature-card a` margin-top: `23px`; L273 `.feature-preview__control` padding: `23px 16px` |
| 25px | 6 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L79 `.hero-art__panel--back` padding: `25px`; L192 `.chart-content` padding: `25px 27px 20px`; L217 `.report-content` padding: `20px 25px 23px`; L273 `.feature-preview__control > div:not(.feature-preview__schedule)` margin-top: `25px`; L295 `.pricing-section__note` margin: `25px 0 0`; L306 `.footer-bottom` padding-top: `25px` |
| 26px | 4 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L68 `.hero h1` margin: `22px 0 26px`; L72 `.hero-actions` gap: `26px`; L222 `.report-sheet` padding: `26px 31px 18px`; L362 `.report-sheet h3` margin-top: `26px` |
| 27px | 4 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L84 `.hero-art__panel--front` padding: `27px`; L192 `.chart-content` padding: `25px 27px 20px`; L284 `.feature-detail__preview .feature-preview__chart` margin: `27px 35px`; L301 `.footer` padding-block: `70px 27px` |
| 29px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L213 `.chart-foot` margin-top: `29px`; L282 `.feature-detail__copy > a` margin-top: `29px` |
| 30px | 9 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L55 `.header-nav` gap: `30px`; L115 `.scene-benefit` margin: `30px 0 0`; L187 `.control-hint` margin: `30px 0 14px`; L264 `.feature-card` padding: `30px`; L281 `.feature-detail ol` margin: `32px 0 30px`; L293 `.pricing-card__price` padding-bottom: `30px`; L300 `.closing p:not(.eyebrow)` margin: `0 auto 30px`; L342 `.feature-detail__preview` padding: `30px`; L358 `.scene-number` margin-bottom: `30px` |
| 31px | 3 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L197 `.chart-frame` padding: `0 4px 0 31px`; L222 `.report-sheet` padding: `26px 31px 18px`; L294 `.pricing-card ul` margin: `31px 0 39px` |
| 33px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L197 `.chart-frame` margin-top: `33px`; L355 `.feature-detail__preview .feature-preview__control` padding: `33px 22px` |
| 34px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L355 `.feature-detail__preview .feature-preview__control > div:not(.feature-preview__schedule)` margin-top: `34px` |
| 35px | 3 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L284 `.feature-detail__preview .feature-preview__control` padding: `52px 35px`; L284 `.feature-detail__preview .feature-preview__chart` margin: `27px 35px`; L302 `.footer-main` gap: `clamp(35px, 6vw, 95px)` |
| 36px | 3 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L72 `.hero-actions` margin-top: `36px`; L75 `.hero-footer` bottom: `36px`; L284 `.feature-detail__preview .feature-preview__schedule` margin-top: `36px` |
| 37px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L225 `.report-sheet h3` margin: `37px 0 5px`; L358 `.scene-layout` gap: `37px` |
| 38px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L349 `.footer-main` gap: `38px` |
| 39px | 3 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L271 `.feature-preview__map` inset: `39px 12px 12px`; L276 `.feature-preview__editor` inset: `39px 12px 12px`; L294 `.pricing-card ul` margin: `31px 0 39px` |
| 44px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L287 `.pricing-section .section-intro` margin-bottom: `44px`; L289 `.pricing-card` padding: `clamp(28px, 3vw, 44px)` |
| 45px | 3 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L108 `.scene-number` margin: `0 0 clamp(45px, 8vh, 90px)`; L283 `.feature-detail__preview` padding: `45px`; L330 `.feature-detail__layout` gap: `45px` |
| 50px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L332 `.scene-layout` gap: `50px`; L355 `.feature-detail__preview .feature-preview__map, .feature-detail__preview .feature-preview__editor` inset: `50px 15px 15px` |
| 52px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L284 `.feature-detail__preview .feature-preview__control` padding: `52px 35px` |
| 55px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L284 `.feature-detail__preview .feature-preview__control > div:not(.feature-preview__schedule)` margin-top: `55px` |
| 60px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L284 `.feature-detail__preview .feature-preview__map, .feature-detail__preview .feature-preview__editor` inset: `60px 24px 22px` |
| 67px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L302 `.footer-main` padding-bottom: `67px` |
| 70px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L301 `.footer` padding-block: `70px 27px` |
| 72px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L358 `.scene-layout` padding-block: `72px 80px` |
| 76px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L106 `.scene-layout` gap: `clamp(28px, 4.5vw, 76px)` |
| 80px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L358 `.scene-layout` padding-block: `72px 80px` |
| 85px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L346 `.scene-layout` padding-block: `85px 90px` |
| 90px | 5 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L108 `.scene-number` margin: `0 0 clamp(45px, 8vh, 90px)`; L298 `.closing` padding-block: `90px`; L342 `.feature-detail` padding-block: `110px 90px`; L346 `.scene-layout` padding-block: `85px 90px`; L354 `.feature-overview` padding-block: `120px 90px` |
| 95px | 3 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L106 `.scene-layout` padding-block: `clamp(95px, 9vh, 135px)`; L302 `.footer-main` gap: `clamp(35px, 6vw, 95px)`; L345 `.hero-inner` padding-block: `120px 95px` |
| 100px | 3 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L28 `.field-day [id]` scroll-margin-top: `100px`; L259 `.feature-overview` padding-block: `clamp(100px, 11vw, 180px)`; L286 `.pricing-section` padding-block: `clamp(100px, 11vw, 180px)` |
| 105px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L278 `.feature-detail` padding-block: `clamp(105px, 9vw, 160px)` |
| 110px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L279 `.feature-detail__layout` gap: `clamp(40px, 6vw, 110px)`; L342 `.feature-detail` padding-block: `110px 90px` |
| 118px | 1 | 새 의미 토큰 또는 실제 그림 좌표 구조 검토 — 정적 위치이며 runtime 아님 | L353 `[id]` scroll-margin-top: `118px` |
| 120px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L345 `.hero-inner` padding-block: `120px 95px`; L354 `.feature-overview` padding-block: `120px 90px` |
| 130px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L66 `.hero-inner` padding-block: `150px 130px` |
| 135px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L106 `.scene-layout` padding-block: `clamp(95px, 9vh, 135px)` |
| 150px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L66 `.hero-inner` padding-block: `150px 130px` |
| 160px | 1 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L278 `.feature-detail` padding-block: `clamp(105px, 9vw, 160px)` |
| 180px | 2 | 새 의미 토큰 필요 — 문서 여백, 해당 공통 primitive/section frame이 소유 | L259 `.feature-overview` padding-block: `clamp(100px, 11vw, 180px)`; L286 `.pricing-section` padding-block: `clamp(100px, 11vw, 180px)` |

## 정적 시안 추가 차이 (React에 없는 속성·값)

| 속성 | 정확 값 | 정적 횟수 | 위치 |
|---|---|---:|---|
| margin | `-1px` | 1 | L32 `.sr-only` |
| font-size | `clamp(55px, 6.7vw, 100px)` | 1 | L67 `.hero h1` |
| padding | `25px 0` | 1 | L259 `.footer` |
| box-shadow | `0 24px 80px rgb(23 32 51 / .25)` | 1 | L265 `.inquiry-dialog` |
| padding | `30px 34px 20px` | 1 | L267 `.inquiry-dialog__head` |
| margin | `0 0 8px` | 1 | L268 `.inquiry-dialog__eyebrow` |
| letter-spacing | `.17em` | 1 | L268 `.inquiry-dialog__eyebrow` |
| font-size | `32px` | 1 | L269 `.inquiry-dialog h2` |
| margin | `9px 0 0` | 1 | L270 `.inquiry-dialog__head p:last-child` |
| gap | `19px` | 1 | L274 `#inquiry-form` |
| padding | `24px 34px 34px` | 1 | L274 `#inquiry-form` |
| padding | `10px 12px` | 1 | L281 `.inquiry-field input:not([type=checkbox]), .inquiry-field select, .inquiry-field textarea` |
| padding | `15px 17px` | 2 | L287 `.inquiry-privacy`; L291 `.inquiry-feedback` |
| border-radius | `11px` | 1 | L287 `.inquiry-privacy` |
| margin | `5px 0 0` | 2 | L288 `.inquiry-privacy p`; L294 `.inquiry-feedback p` |
| margin-top | `7px` | 1 | L294 `.inquiry-feedback a` |
| border-radius | `13px` | 1 | L333 `.inquiry-dialog` |
| padding | `23px 20px 17px` | 1 | L333 `.inquiry-dialog__head` |


### 최종 승인 역할·정확 값·사용처

| 이름 | 정확 값 | utility/동반 속성 | 근거 수 | 위치와 역할 |
|---|---|---|---:|---|
| `--text-landing-button` | `14px` | `text-landing-button` | 2 | R:35 .button [font-size]; C:36 .button [font-size] |
| `--text-landing-button--line-height` | `1.2` | `text-landing-button` | 2 | R:35 .button [line-height]; C:36 .button [line-height] |
| `--text-landing-eyebrow` | `13px` | `text-landing-eyebrow` | 2 | R:47 .eyebrow [font-size]; C:48 .eyebrow [font-size] |
| `--text-landing-eyebrow--letter-spacing` | `.16em` | `text-landing-eyebrow` | 2 | R:47 .eyebrow [letter-spacing]; C:48 .eyebrow [letter-spacing] |
| `--text-landing-brand` | `22px` | `text-landing-brand` | 2 | R:53 .brand [font-size]; C:54 .brand [font-size] |
| `--text-landing-brand--letter-spacing` | `-.07em` | `text-landing-brand` | 2 | R:53 .brand [letter-spacing]; C:54 .brand [letter-spacing] |
| `--text-landing-navigation` | `13px` | `text-landing-navigation` | 2 | R:55 .header-nav [font-size]; C:56 .header-nav [font-size] |
| `--text-landing-hero-fluid` | `clamp(55px, 5.3vw, 78px)` | `text-landing-hero-fluid` | 1 | R:68 .hero h1 [font-size] |
| `--text-landing-hero-fluid--line-height` | `1.15` | `text-landing-hero-fluid` | 1 | R:68 .hero h1 [line-height] |
| `--text-landing-hero-fluid--letter-spacing` | `-.085em` | `text-landing-hero-fluid` | 1 | R:68 .hero h1 [letter-spacing] |
| `--text-landing-hero-description` | `clamp(16px, 1.55vw, 20px)` | `text-landing-hero-description` | 2 | R:70 .hero-copy > p:not(.eyebrow) [font-size]; C:69 .hero-copy > p:not(.eyebrow) [font-size] |
| `--text-landing-hero-description--line-height` | `1.8` | `text-landing-hero-description` | 2 | R:70 .hero-copy > p:not(.eyebrow) [line-height]; C:69 .hero-copy > p:not(.eyebrow) [line-height] |
| `--text-landing-hero-footer` | `10px` | `text-landing-hero-footer` | 2 | R:75 .hero-footer [font-size]; C:73 .hero-footer [font-size] |
| `--text-landing-hero-footer--letter-spacing` | `.2em` | `text-landing-hero-footer` | 2 | R:75 .hero-footer [letter-spacing]; C:73 .hero-footer [letter-spacing] |
| `--text-landing-hero-art-label` | `10px` | `text-landing-hero-art-label` | 2 | R:80 .hero-art__panel--back span [font-size]; C:78 .hero-art__panel--back span [font-size] |
| `--text-landing-hero-art-label--letter-spacing` | `.15em` | `text-landing-hero-art-label` | 2 | R:80 .hero-art__panel--back span [letter-spacing]; C:78 .hero-art__panel--back span [letter-spacing] |
| `--text-landing-hero-art-metric` | `clamp(17px, 2.1vw, 26px)` | `text-landing-hero-art-metric` | 2 | R:86 .hero-art__panel--front strong [font-size]; C:84 .hero-art__panel--front strong [font-size] |
| `--text-landing-hero-art-metric--letter-spacing` | `-.05em` | `text-landing-hero-art-metric` | 2 | R:86 .hero-art__panel--front strong [letter-spacing]; C:84 .hero-art__panel--front strong [letter-spacing] |
| `--text-landing-scene-watermark` | `clamp(120px, 17vw, 250px)` | `text-landing-scene-watermark` | 2 | R:104 .scene::before [font-size]; C:102 .scene::before [font-size] |
| `--text-landing-scene-watermark--letter-spacing` | `-.1em` | `text-landing-scene-watermark` | 2 | R:104 .scene::before [letter-spacing]; C:102 .scene::before [letter-spacing] |
| `--text-landing-scene-number` | `11px` | `text-landing-scene-number` | 2 | R:108 .scene-number [font-size]; C:106 .scene-number [font-size] |
| `--text-landing-scene-number--letter-spacing` | `.12em` | `text-landing-scene-number` | 2 | R:108 .scene-number [letter-spacing]; C:106 .scene-number [letter-spacing] |
| `--text-landing-scene-heading` | `clamp(43px, 4.55vw, 70px)` | `text-landing-scene-heading` | 2 | R:110 .scene h2 [font-size]; C:108 .scene h2 [font-size] |
| `--text-landing-scene-heading--line-height` | `1.2` | `text-landing-scene-heading` | 2 | R:110 .scene h2 [line-height]; C:108 .scene h2 [line-height] |
| `--text-landing-scene-heading--letter-spacing` | `-.073em` | `text-landing-scene-heading` | 2 | R:110 .scene h2 [letter-spacing]; C:108 .scene h2 [letter-spacing] |
| `--text-landing-scene-description` | `clamp(16px, 1.35vw, 18px)` | `text-landing-scene-description` | 2 | R:113 .scene-description [font-size]; C:111 .scene-description [font-size] |
| `--text-landing-scene-description--line-height` | `1.8` | `text-landing-scene-description` | 2 | R:113 .scene-description [line-height]; C:111 .scene-description [line-height] |
| `--text-landing-scene-benefit` | `14px` | `text-landing-scene-benefit` | 2 | R:115 .scene-benefit [font-size]; C:113 .scene-benefit [font-size] |
| `--text-landing-scene-benefit--line-height` | `1.6` | `text-landing-scene-benefit` | 2 | R:115 .scene-benefit [line-height]; C:113 .scene-benefit [line-height] |
| `--text-landing-scene-benefit-marker` | `20px` | `text-landing-scene-benefit-marker` | 2 | R:116 .scene-benefit::before [font-size]; C:114 .scene-benefit::before [font-size] |
| `--text-landing-scene-benefit-marker--line-height` | `1` | `text-landing-scene-benefit-marker` | 2 | R:116 .scene-benefit::before [line-height]; C:114 .scene-benefit::before [line-height] |
| `--text-landing-demo-disclaimer` | `10px` | `text-landing-demo-disclaimer` | 2 | R:131 .demo-disclaimer [font-size]; C:129 .demo-disclaimer [font-size] |
| `--text-landing-demo-disclaimer--line-height` | `1.55` | `text-landing-demo-disclaimer` | 2 | R:131 .demo-disclaimer [line-height]; C:129 .demo-disclaimer [line-height] |
| `--text-landing-demo-status` | `11px` | `text-landing-demo-status` | 2 | R:132 .demo-status [font-size]; C:130 .demo-status [font-size] |
| `--text-landing-demo-status--line-height` | `1.5` | `text-landing-demo-status` | 2 | R:132 .demo-status [line-height]; C:130 .demo-status [line-height] |
| `--text-landing-inspector-heading` | `17px` | `text-landing-inspector-heading` | 2 | R:159 .inspector > strong [font-size]; C:157 .inspector > strong [font-size] |
| `--text-landing-inspector-heading--letter-spacing` | `-.04em` | `text-landing-inspector-heading` | 2 | R:159 .inspector > strong [letter-spacing]; C:157 .inspector > strong [letter-spacing] |
| `--text-landing-control-metric` | `28px` | `text-landing-control-metric` | 2 | R:181 .control-panel__heading strong [font-size]; C:179 .control-panel__heading strong [font-size] |
| `--text-landing-control-metric--letter-spacing` | `-.05em` | `text-landing-control-metric` | 2 | R:181 .control-panel__heading strong [letter-spacing]; C:179 .control-panel__heading strong [letter-spacing] |
| `--text-landing-control-hint` | `11px` | `text-landing-control-hint` | 2 | R:187 .control-hint [font-size]; C:185 .control-hint [font-size] |
| `--text-landing-control-hint--line-height` | `1.55` | `text-landing-control-hint` | 2 | R:187 .control-hint [line-height]; C:185 .control-hint [line-height] |
| `--text-landing-chart-heading` | `20px` | `text-landing-chart-heading` | 2 | R:195 .chart-heading strong [font-size]; C:193 .chart-heading strong [font-size] |
| `--text-landing-chart-heading--letter-spacing` | `-.04em` | `text-landing-chart-heading` | 2 | R:195 .chart-heading strong [letter-spacing]; C:193 .chart-heading strong [letter-spacing] |
| `--text-landing-demo-micro` | `9px` | `text-landing-demo-micro` | 4 | R:198 .chart-y [font-size]; R:233 .report-history [font-size]; C:196 .chart-y [font-size]; C:231 .report-history [font-size] |
| `--text-landing-report-micro` | `9px` | `text-landing-report-micro` | 2 | R:223 .report-sheet__top, .report-sheet__footer [font-size]; C:221 .report-sheet__top, .report-sheet__footer [font-size] |
| `--text-landing-report-micro--letter-spacing` | `.1em` | `text-landing-report-micro` | 2 | R:223 .report-sheet__top, .report-sheet__footer [letter-spacing]; C:221 .report-sheet__top, .report-sheet__footer [letter-spacing] |
| `--text-landing-report-meta` | `9px` | `text-landing-report-meta` | 2 | R:224 .report-sheet__top small [font-size]; C:222 .report-sheet__top small [font-size] |
| `--text-landing-report-meta--letter-spacing` | `0` | `text-landing-report-meta` | 2 | R:224 .report-sheet__top small [letter-spacing]; C:222 .report-sheet__top small [letter-spacing] |
| `--text-landing-report-heading` | `22px` | `text-landing-report-heading` | 2 | R:225 .report-sheet h3 [font-size]; C:223 .report-sheet h3 [font-size] |
| `--text-landing-report-heading--letter-spacing` | `-.05em` | `text-landing-report-heading` | 2 | R:225 .report-sheet h3 [letter-spacing]; C:223 .report-sheet h3 [letter-spacing] |
| `--text-landing-section-heading` | `clamp(40px, 4.4vw, 66px)` | `text-landing-section-heading` | 1 | R:261 .section-intro :is(h1, h2) [font-size] |
| `--text-landing-section-heading--line-height` | `1.18` | `text-landing-section-heading` | 1 | R:261 .section-intro :is(h1, h2) [line-height] |
| `--text-landing-section-heading--letter-spacing` | `-.075em` | `text-landing-section-heading` | 1 | R:261 .section-intro :is(h1, h2) [letter-spacing] |
| `--text-landing-section-description` | `17px` | `text-landing-section-description` | 1 | R:262 .section-intro > p:last-child [font-size] |
| `--text-landing-section-description--line-height` | `1.75` | `text-landing-section-description` | 1 | R:262 .section-intro > p:last-child [line-height] |
| `--text-landing-feature-card-number` | `11px` | `text-landing-feature-card-number` | 1 | R:265 .feature-card__number [font-size] |
| `--text-landing-feature-card-number--letter-spacing` | `.11em` | `text-landing-feature-card-number` | 1 | R:265 .feature-card__number [letter-spacing] |
| `--text-landing-feature-card-heading` | `clamp(22px, 2vw, 28px)` | `text-landing-feature-card-heading` | 1 | R:266 .feature-card h2 [font-size] |
| `--text-landing-feature-card-heading--line-height` | `1.35` | `text-landing-feature-card-heading` | 1 | R:266 .feature-card h2 [line-height] |
| `--text-landing-feature-card-heading--letter-spacing` | `-.055em` | `text-landing-feature-card-heading` | 1 | R:266 .feature-card h2 [letter-spacing] |
| `--text-landing-feature-card-body` | `13px` | `text-landing-feature-card-body` | 1 | R:267 .feature-card p [font-size] |
| `--text-landing-feature-card-body--line-height` | `1.65` | `text-landing-feature-card-body` | 1 | R:267 .feature-card p [line-height] |
| `--text-landing-feature-card-outcome` | `12px` | `text-landing-feature-card-outcome` | 1 | R:267 .feature-card strong [font-size] |
| `--text-landing-feature-card-outcome--line-height` | `1.55` | `text-landing-feature-card-outcome` | 1 | R:267 .feature-card strong [line-height] |
| `--text-landing-feature-detail-heading` | `clamp(36px, 4vw, 58px)` | `text-landing-feature-detail-heading` | 1 | R:280 .feature-detail h2 [font-size] |
| `--text-landing-feature-detail-heading--line-height` | `1.24` | `text-landing-feature-detail-heading` | 1 | R:280 .feature-detail h2 [line-height] |
| `--text-landing-feature-detail-heading--letter-spacing` | `-.07em` | `text-landing-feature-detail-heading` | 1 | R:280 .feature-detail h2 [letter-spacing] |
| `--text-landing-feature-detail-description` | `16px` | `text-landing-feature-detail-description` | 1 | R:280 .feature-detail__copy > p:not(.feature-detail__outcome) [font-size] |
| `--text-landing-feature-detail-description--line-height` | `1.8` | `text-landing-feature-detail-description` | 1 | R:280 .feature-detail__copy > p:not(.feature-detail__outcome) [line-height] |
| `--text-landing-feature-detail-step` | `15px` | `text-landing-feature-detail-step` | 1 | R:281 .feature-detail li [font-size] |
| `--text-landing-feature-detail-step--line-height` | `1.6` | `text-landing-feature-detail-step` | 1 | R:281 .feature-detail li [line-height] |
| `--text-landing-feature-detail-step-number` | `12px` | `text-landing-feature-detail-step-number` | 1 | R:281 .feature-detail li::before [font-size] |
| `--text-landing-feature-detail-step-number--letter-spacing` | `.08em` | `text-landing-feature-detail-step-number` | 1 | R:281 .feature-detail li::before [letter-spacing] |
| `--text-landing-feature-detail-outcome` | `15px` | `text-landing-feature-detail-outcome` | 1 | R:282 .feature-detail__outcome [font-size] |
| `--text-landing-feature-detail-outcome--line-height` | `1.65` | `text-landing-feature-detail-outcome` | 1 | R:282 .feature-detail__outcome [line-height] |
| `--text-landing-plan-name` | `15px` | `text-landing-plan-name` | 1 | R:291 .pricing-card__head [font-size] |
| `--text-landing-plan-name--letter-spacing` | `.04em` | `text-landing-plan-name` | 1 | R:291 .pricing-card__head [letter-spacing] |
| `--text-landing-plan-badge` | `11px` | `text-landing-plan-badge` | 1 | R:291 .pricing-card__head small [font-size] |
| `--text-landing-plan-badge--letter-spacing` | `0` | `text-landing-plan-badge` | 1 | R:291 .pricing-card__head small [letter-spacing] |
| `--text-landing-plan-summary` | `15px` | `text-landing-plan-summary` | 1 | R:292 .pricing-card__summary [font-size] |
| `--text-landing-plan-summary--line-height` | `1.65` | `text-landing-plan-summary` | 1 | R:292 .pricing-card__summary [line-height] |
| `--text-landing-price` | `clamp(34px, 3.2vw, 48px)` | `text-landing-price` | 1 | R:293 .pricing-card__price strong [font-size] |
| `--text-landing-price--line-height` | `1.1` | `text-landing-price` | 1 | R:293 .pricing-card__price strong [line-height] |
| `--text-landing-price--letter-spacing` | `-.06em` | `text-landing-price` | 1 | R:293 .pricing-card__price strong [letter-spacing] |
| `--text-landing-plan-feature` | `15px` | `text-landing-plan-feature` | 1 | R:294 .pricing-card li [font-size] |
| `--text-landing-plan-feature--line-height` | `1.5` | `text-landing-plan-feature` | 1 | R:294 .pricing-card li [line-height] |
| `--text-landing-pricing-note` | `12px` | `text-landing-pricing-note` | 1 | R:295 .pricing-section__note [font-size] |
| `--text-landing-pricing-note--line-height` | `1.7` | `text-landing-pricing-note` | 1 | R:295 .pricing-section__note [line-height] |
| `--text-landing-closing-heading` | `clamp(46px, 6vw, 82px)` | `text-landing-closing-heading` | 2 | R:299 .closing h2 [font-size]; C:257 .closing h2 [font-size] |
| `--text-landing-closing-heading--line-height` | `1.2` | `text-landing-closing-heading` | 2 | R:299 .closing h2 [line-height]; C:257 .closing h2 [line-height] |
| `--text-landing-closing-heading--letter-spacing` | `-.08em` | `text-landing-closing-heading` | 2 | R:299 .closing h2 [letter-spacing]; C:257 .closing h2 [letter-spacing] |
| `--text-landing-closing-description` | `17px` | `text-landing-closing-description` | 2 | R:300 .closing p:not(.eyebrow) [font-size]; C:258 .closing p:not(.eyebrow) [font-size] |
| `--text-landing-closing-description--line-height` | `1.7` | `text-landing-closing-description` | 2 | R:300 .closing p:not(.eyebrow) [line-height]; C:258 .closing p:not(.eyebrow) [line-height] |
| `--text-landing-footer-company` | `23px` | `text-landing-footer-company` | 1 | R:303 .footer-company strong [font-size] |
| `--text-landing-footer-legal` | `11px` | `text-landing-footer-legal` | 1 | R:306 .footer-bottom [font-size] |
| `--text-landing-footer-legal--line-height` | `1.6` | `text-landing-footer-legal` | 1 | R:306 .footer-bottom [line-height] |
| `--text-landing-feature-detail-heading-stacked` | `clamp(37px, 7.4vw, 48px)` | `text-landing-feature-detail-heading-stacked` | 1 | R:342 .feature-detail h2 [font-size] |
| `--text-landing-navigation-stacked` | `12px` | `text-landing-navigation-stacked` | 5 | R:344 .header-nav [font-size]; R:344 .header-contact [font-size]; R:344 .button--header [font-size]; C:327 .header-contact [font-size]; C:327 .button--header [font-size] |
| `--text-landing-hero-fluid-stacked` | `clamp(48px, 10vw, 72px)` | `text-landing-hero-fluid-stacked` | 2 | R:345 .hero h1 [font-size]; C:328 .hero h1 [font-size] |
| `--text-landing-scene-heading-stacked` | `clamp(40px, 8.2vw, 58px)` | `text-landing-scene-heading-stacked` | 2 | R:346 .scene h2 [font-size]; C:329 .scene h2 [font-size] |
| `--text-landing-section-heading-narrow` | `40px` | `text-landing-section-heading-narrow` | 1 | R:354 .section-intro :is(h1, h2) [font-size] |
| `--text-landing-feature-card-heading-narrow` | `21px` | `text-landing-feature-card-heading-narrow` | 1 | R:354 .feature-card h2 [font-size] |
| `--text-landing-feature-detail-heading-narrow` | `37px` | `text-landing-feature-detail-heading-narrow` | 1 | R:355 .feature-detail h2 [font-size] |
| `--text-landing-brand-narrow` | `20px` | `text-landing-brand-narrow` | 2 | R:356 .brand [font-size]; C:336 .brand [font-size] |
| `--text-landing-navigation-narrow` | `11px` | `text-landing-navigation-narrow` | 3 | R:356 .header-nav [font-size]; R:356 .header-contact [font-size]; R:356 .button--header [font-size] |
| `--text-landing-hero-fluid-narrow` | `clamp(46px, 11vw, 57px)` | `text-landing-hero-fluid-narrow` | 2 | R:357 .hero h1 [font-size]; C:337 .hero h1 [font-size] |
| `--text-landing-scene-heading-narrow` | `clamp(38px, 10vw, 48px)` | `text-landing-scene-heading-narrow` | 2 | R:358 .scene h2 [font-size]; C:338 .scene h2 [font-size] |
| `--text-landing-closing-heading-narrow` | `clamp(40px, 10vw, 52px)` | `text-landing-closing-heading-narrow` | 2 | R:365 .closing h2 [font-size]; C:345 .closing h2 [font-size] |
| `--text-landing-concept-hero-fluid` | `clamp(55px, 6.7vw, 100px)` | `text-landing-concept-hero-fluid` | 1 | C:67 .hero h1 [font-size] |
| `--text-landing-concept-hero-fluid--line-height` | `1.15` | `text-landing-concept-hero-fluid` | 1 | C:67 .hero h1 [line-height] |
| `--text-landing-concept-hero-fluid--letter-spacing` | `-.085em` | `text-landing-concept-hero-fluid` | 1 | C:67 .hero h1 [letter-spacing] |
| `--text-landing-concept-inquiry-eyebrow` | `10px` | `text-landing-concept-inquiry-eyebrow` | 1 | C:268 .inquiry-dialog__eyebrow [font-size] |
| `--text-landing-concept-inquiry-eyebrow--letter-spacing` | `.17em` | `text-landing-concept-inquiry-eyebrow` | 1 | C:268 .inquiry-dialog__eyebrow [letter-spacing] |
| `--text-landing-concept-inquiry-title` | `32px` | `text-landing-concept-inquiry-title` | 1 | C:269 .inquiry-dialog h2 [font-size] |
| `--text-landing-concept-inquiry-title--letter-spacing` | `-.07em` | `text-landing-concept-inquiry-title` | 1 | C:269 .inquiry-dialog h2 [letter-spacing] |
| `--text-landing-concept-inquiry-description` | `13px` | `text-landing-concept-inquiry-description` | 1 | C:270 .inquiry-dialog__head p:last-child [font-size] |
| `--text-landing-concept-inquiry-description--line-height` | `1.6` | `text-landing-concept-inquiry-description` | 1 | C:270 .inquiry-dialog__head p:last-child [line-height] |
| `--text-landing-concept-inquiry-dismiss` | `14px` | `text-landing-concept-inquiry-dismiss` | 1 | C:271 .inquiry-dialog__close [font-size] |
| `--text-landing-concept-inquiry-label` | `12px` | `text-landing-concept-inquiry-label` | 1 | C:278 .inquiry-field > label [font-size] |
| `--text-landing-concept-inquiry-optional` | `11px` | `text-landing-concept-inquiry-optional` | 1 | C:280 .inquiry-optional [font-size] |
| `--text-landing-concept-inquiry-error` | `11px` | `text-landing-concept-inquiry-error` | 1 | C:285 .inquiry-error [font-size] |
| `--text-landing-concept-inquiry-error--line-height` | `1.5` | `text-landing-concept-inquiry-error` | 1 | C:285 .inquiry-error [line-height] |
| `--text-landing-concept-inquiry-privacy` | `12px` | `text-landing-concept-inquiry-privacy` | 1 | C:287 .inquiry-privacy [font-size] |
| `--text-landing-concept-inquiry-privacy--line-height` | `1.65` | `text-landing-concept-inquiry-privacy` | 1 | C:287 .inquiry-privacy [line-height] |
| `--text-landing-concept-inquiry-feedback` | `12px` | `text-landing-concept-inquiry-feedback` | 1 | C:291 .inquiry-feedback [font-size] |
| `--text-landing-concept-inquiry-feedback--line-height` | `1.6` | `text-landing-concept-inquiry-feedback` | 1 | C:291 .inquiry-feedback [line-height] |
| `--text-landing-action` | `14px` | `text-landing-action` | 3 | R:73 .hero-contact [font-size]; R:282 .feature-detail__copy > a [font-size]; C:71 .hero-contact [font-size] |
| `--text-landing-footer-heading` | `14px` | `text-landing-footer-heading` | 1 | R:304 .footer h2 [font-size] |
| `--text-landing-feature-detail-copy-narrow` | `14px` | `text-landing-feature-detail-copy-narrow` | 1 | R:355 .feature-detail__copy > p:not(.feature-detail__outcome), .feature-detail li [font-size] |
| `--text-landing-demo-meta` | `11px` | `text-landing-demo-meta` | 18 | R:85 .hero-art__panel--front span [font-size]; R:126 .demo-title small [font-size]; R:178 .control-visual__caption [font-size]; R:218 .report-controls [font-size]; R:225 .report-sheet > p [font-size]; R:228 .report-row strong [font-size]; R:242 .map-tools > span [font-size]; R:250 .map-canvas__room [font-size]; R:256 .map-bottom [font-size]; C:83 .hero-art__panel--front span [font-size]; C:124 .demo-title small [font-size]; C:176 .control-visual__caption [font-size]; C:216 .report-controls [font-size]; C:223 .report-sheet > p [font-size]; C:226 .report-row strong [font-size]; C:240 .map-tools > span [font-size]; C:248 .map-canvas__room [font-size]; C:253 .map-bottom [font-size] |
| `--text-landing-feature-card-copy-narrow` | `11px` | `text-landing-feature-card-copy-narrow` | 1 | R:354 .feature-card p, .feature-card strong [font-size] |
| `--text-landing-concept-footer-body` | `11px` | `text-landing-concept-footer-body` | 1 | C:259 .footer [font-size] |
| `--text-landing-preview-control-value-expanded` | `19px` | `text-landing-preview-control-value-expanded` | 1 | R:284 .feature-detail__preview .feature-preview__control small [font-size] |
| `--text-landing-report-heading-narrow` | `19px` | `text-landing-report-heading-narrow` | 2 | R:362 .report-sheet h3 [font-size]; C:342 .report-sheet h3 [font-size] |
| `--text-landing-chart-heading-narrow` | `16px` | `text-landing-chart-heading-narrow` | 2 | R:361 .chart-heading strong [font-size]; C:341 .chart-heading strong [font-size] |
| `--text-landing-demo-title` | `12px` | `text-landing-demo-title` | 2 | R:124 .demo-title [font-size]; C:122 .demo-title [font-size] |
| `--text-landing-compact-action` | `12px` | `text-landing-compact-action` | 3 | R:128 .replay-button [font-size]; R:354 .feature-card a [font-size]; C:126 .replay-button [font-size] |
| `--text-landing-feature-supporting-note` | `12px` | `text-landing-feature-supporting-note` | 2 | R:277 .feature-overview__note [font-size]; R:283 .feature-detail__preview > span [font-size] |
| `--text-landing-plan-feature-marker` | `12px` | `text-landing-plan-feature-marker` | 1 | R:294 .pricing-card li span [font-size] |
| `--text-landing-scene-benefit-narrow` | `12px` | `text-landing-scene-benefit-narrow` | 2 | R:358 .scene-benefit [font-size]; C:338 .scene-benefit [font-size] |
| `--text-landing-control-heading` | `13px` | `text-landing-control-heading` | 2 | R:180 .control-panel__heading [font-size]; C:178 .control-panel__heading [font-size] |
| `--text-landing-feature-card-link` | `13px` | `text-landing-feature-card-link` | 1 | R:268 .feature-card a [font-size] |
| `--text-landing-inquiry-plan` | `13px` | `text-landing-inquiry-plan` | 1 | R:296 .inquiry-selected-plan [font-size] |
| `--text-landing-footer-body` | `13px` | `text-landing-footer-body` | 1 | R:301 .footer [font-size] |
| `--text-landing-price-unit` | `15px` | `text-landing-price-unit` | 1 | R:293 .pricing-card__price span [font-size] |
| `--text-landing-narrative-copy-narrow` | `15px` | `text-landing-narrative-copy-narrow` | 7 | R:354 .section-intro > p:last-child [font-size]; R:357 .hero-copy > p:not(.eyebrow) [font-size]; R:358 .scene-description [font-size]; R:365 .closing p:not(.eyebrow) [font-size]; C:337 .hero-copy > p:not(.eyebrow) [font-size]; C:338 .scene-description [font-size]; C:345 .closing p:not(.eyebrow) [font-size] |
| `--text-landing-demo-caption` | `10px` | `text-landing-demo-caption` | 28 | R:137 .floorplan__top, .floorplan__legend [font-size]; R:147 .floorplan__entry [font-size]; R:158 .inspector__label [font-size]; R:160 .status-pill [font-size]; R:163 .inspector dl div [font-size]; R:186 .range-ends [font-size]; R:194 .chart-heading div span [font-size]; R:196 .chart-unit [font-size]; R:212 .chart-x [font-size]; R:213 .chart-foot [font-size]; R:228 .report-row span [font-size]; R:234 .report-history strong [font-size]; R:255 .map-canvas__hint [font-size]; R:362 .report-controls > span [font-size]; C:135 .floorplan__top, .floorplan__legend [font-size]; C:145 .floorplan__entry [font-size]; C:156 .inspector__label [font-size]; C:158 .status-pill [font-size]; C:161 .inspector dl div [font-size]; C:184 .range-ends [font-size]; C:192 .chart-heading div span [font-size]; C:194 .chart-unit [font-size]; C:210 .chart-x [font-size]; C:211 .chart-foot [font-size]; C:226 .report-row span [font-size]; C:232 .report-history strong [font-size]; C:252 .map-canvas__hint [font-size]; C:342 .report-controls > span [font-size] |
| `--text-landing-demo-control-label` | `10px` | `text-landing-demo-control-label` | 4 | R:220 .format-button [font-size]; R:243 .map-tools .button [font-size]; C:218 .format-button [font-size]; C:241 .map-tools .button [font-size] |
| `--text-landing-replay-icon` | `18px` | `text-landing-replay-icon` | 2 | R:130 .replay-button:first-letter [font-size]; C:128 .replay-button:first-letter [font-size] |
| `--tracking-landing-monitoring-watermark` | `-.045em` | `tracking-landing-monitoring-watermark` | 2 | R:105 .scene--monitoring::before [letter-spacing]; C:103 .scene--monitoring::before [letter-spacing] |
| `--tracking-landing-report-footer` | `0` | `tracking-landing-report-footer` | 2 | R:232 .report-sheet__footer [letter-spacing]; C:230 .report-sheet__footer [letter-spacing] |
| `--leading-landing-footer-description` | `1.65` | `leading-landing-footer-description` | 1 | R:303 .footer-company p [line-height] |
| `--leading-landing-footer-contact-row` | `1.6` | `leading-landing-footer-contact-row` | 1 | R:304 .footer-contact dl div [line-height] |
| `--leading-landing-concept-inquiry-message` | `1.5` | `leading-landing-concept-inquiry-message` | 1 | C:282 .inquiry-field textarea [line-height] |
| `--leading-landing-concept-document` | `normal` | `leading-landing-concept-document` | 1 | C:26 body [browser normal inherited by document descendants; original static baseline] |
| `--spacing-landing-anchor-anchor-offset` | `100px` | `scroll-mt-landing-anchor-anchor-offset` | 1 | R:28 .field-day [id] [scroll-margin-top] |
| `--spacing-landing-skip-link-top` | `-100px` | `top-landing-skip-link-top` | 2 | R:32 .skip-link [top]; C:33 .skip-link [top] |
| `--spacing-landing-button-inset` | `0 19px` | `p-landing-button-inset` | 2 | R:35 .button [padding]; C:36 .button [padding] |
| `--spacing-landing-brand-mark-inset` | `3px` | `p-landing-brand-mark-inset` | 2 | R:54 .brand img [padding]; C:55 .brand img [padding] |
| `--spacing-landing-navigation-gap` | `30px` | `gap-landing-navigation-gap` | 2 | R:55 .header-nav [gap]; C:56 .header-nav [gap] |
| `--spacing-landing-hero-orbit-near-right` | `-90px` | `right-landing-hero-orbit-near-right` | 2 | R:64 .hero-orbit--one [right]; C:63 .hero-orbit--one [right] |
| `--spacing-landing-hero-orbit-far-right` | `-250px` | `right-landing-hero-orbit-far-right` | 2 | R:65 .hero-orbit--two [right]; C:64 .hero-orbit--two [right] |
| `--spacing-landing-hero-frame-gap` | `5%` | `gap-landing-hero-frame-gap` | 2 | R:66 .hero-inner [gap]; C:65 .hero-inner [gap] |
| `--spacing-landing-hero-frame-block-inset` | `150px 130px` | `py-landing-hero-frame-block-inset` | 2 | R:66 .hero-inner [padding-block]; C:65 .hero-inner [padding-block] |
| `--spacing-landing-hero-heading-margin` | `22px 0 26px` | `m-landing-hero-heading-margin` | 2 | R:68 .hero h1 [margin]; C:67 .hero h1 [margin] |
| `--spacing-landing-hero-actions-gap` | `26px` | `gap-landing-hero-actions-gap` | 2 | R:72 .hero-actions [gap]; C:70 .hero-actions [gap] |
| `--spacing-landing-hero-actions-top-space` | `36px` | `mt-landing-hero-actions-top-space` | 2 | R:72 .hero-actions [margin-top]; C:70 .hero-actions [margin-top] |
| `--spacing-landing-hero-footer-bottom` | `36px` | `bottom-landing-hero-footer-bottom` | 2 | R:75 .hero-footer [bottom]; C:73 .hero-footer [bottom] |
| `--spacing-landing-hero-art-background-card-inset` | `25px` | `p-landing-hero-art-background-card-inset` | 2 | R:79 .hero-art__panel--back [padding]; C:77 .hero-art__panel--back [padding] |
| `--spacing-landing-hero-art-metric-card-inset` | `27px` | `p-landing-hero-art-metric-card-inset` | 2 | R:84 .hero-art__panel--front [padding]; C:82 .hero-art__panel--front [padding] |
| `--spacing-landing-hero-art-chart-gap` | `9px` | `gap-landing-hero-art-chart-gap` | 2 | R:87 .hero-art__panel--front div [gap]; C:85 .hero-art__panel--front div [gap] |
| `--spacing-landing-hero-art-chart-top-space` | `15px` | `mt-landing-hero-art-chart-top-space` | 2 | R:87 .hero-art__panel--front div [margin-top]; C:85 .hero-art__panel--front div [margin-top] |
| `--spacing-landing-scene-frame-gap` | `clamp(28px, 4.5vw, 76px)` | `gap-landing-scene-frame-gap` | 2 | R:106 .scene-layout [gap]; C:104 .scene-layout [gap] |
| `--spacing-landing-scene-frame-block-inset` | `clamp(95px, 9vh, 135px)` | `py-landing-scene-frame-block-inset` | 2 | R:106 .scene-layout [padding-block]; C:104 .scene-layout [padding-block] |
| `--spacing-landing-scene-number-margin` | `0 0 clamp(45px, 8vh, 90px)` | `m-landing-scene-number-margin` | 2 | R:108 .scene-number [margin]; C:106 .scene-number [margin] |
| `--spacing-landing-scene-heading-margin` | `17px 0 24px` | `m-landing-scene-heading-margin` | 2 | R:110 .scene h2 [margin]; C:108 .scene h2 [margin] |
| `--spacing-landing-scene-benefit-margin` | `30px 0 0` | `m-landing-scene-benefit-margin` | 2 | R:115 .scene-benefit [margin]; C:113 .scene-benefit [margin] |
| `--spacing-landing-scene-benefit-top-inset` | `23px` | `pt-landing-scene-benefit-top-inset` | 2 | R:115 .scene-benefit [padding-top]; C:113 .scene-benefit [padding-top] |
| `--spacing-landing-demo-backplate-right` | `-35px` | `right-landing-demo-backplate-right` | 2 | R:119 .demo-wrap::after [right]; C:117 .demo-wrap::after [right] |
| `--spacing-landing-demo-backplate-bottom` | `-38px` | `bottom-landing-demo-backplate-bottom` | 2 | R:119 .demo-wrap::after [bottom]; C:117 .demo-wrap::after [bottom] |
| `--spacing-landing-demo-frame-inline-inset` | `22px` | `px-landing-demo-frame-inline-inset` | 2 | R:123 .demo-toolbar [padding]; C:121 .demo-toolbar [padding] |
| `--spacing-landing-demo-disclaimer-inset` | `11px 22px` | `p-landing-demo-disclaimer-inset` | 2 | R:131 .demo-disclaimer [padding]; C:129 .demo-disclaimer [padding] |
| `--spacing-landing-floorplan-caption-inset` | `11px 13px` | `p-landing-floorplan-caption-inset` | 2 | R:137 .floorplan__top, .floorplan__legend [padding]; C:135 .floorplan__top, .floorplan__legend [padding] |
| `--spacing-landing-parking-spaces-gap` | `3%` | `gap-landing-parking-spaces-gap` | 2 | R:140 .parking-spaces [gap]; C:138 .parking-spaces [gap] |
| `--spacing-landing-demo-map-label-inset` | `5px 9px` | `p-landing-demo-map-label-inset` | 2 | R:147 .floorplan__entry [padding]; C:145 .floorplan__entry [padding] |
| `--spacing-landing-demo-status-label-gap` | `5px` | `gap-landing-demo-status-label-gap` | 4 | R:153 .floorplan__legend span [gap]; R:160 .status-pill [gap]; C:151 .floorplan__legend span [gap]; C:158 .status-pill [gap] |
| `--spacing-landing-demo-status-label-inset` | `6px 9px` | `p-landing-demo-status-label-inset` | 4 | R:160 .status-pill [padding]; R:255 .map-canvas__hint [padding]; C:158 .status-pill [padding]; C:252 .map-canvas__hint [padding] |
| `--spacing-landing-inspector-property-top-inset` | `13px` | `pt-landing-inspector-property-top-inset` | 2 | R:163 .inspector dl div [padding-top]; C:161 .inspector dl div [padding-top] |
| `--spacing-landing-control-pendant-cord-top` | `-65px` | `top-landing-control-pendant-cord-top` | 2 | R:175 .control-visual__lamp span [top]; C:173 .control-visual__lamp span [top] |
| `--spacing-landing-control-caption-bottom` | `19px` | `bottom-landing-control-caption-bottom` | 2 | R:178 .control-visual__caption [bottom]; C:176 .control-visual__caption [bottom] |
| `--spacing-landing-control-panel-inset` | `23px` | `p-landing-control-panel-inset` | 2 | R:179 .control-panel [padding]; C:177 .control-panel [padding] |
| `--spacing-landing-control-slider-margin` | `28px 0 9px` | `m-landing-control-slider-margin` | 2 | R:182 .control-panel input[type="range"] [margin]; C:180 .control-panel input[type="range"] [margin] |
| `--spacing-landing-control-hint-margin` | `30px 0 14px` | `m-landing-control-hint-margin` | 2 | R:187 .control-hint [margin]; C:185 .control-hint [margin] |
| `--spacing-landing-demo-result-top-space` | `15px` | `mt-landing-demo-result-top-space` | 4 | R:189 .control-panel .demo-status [margin-top]; R:236 .report-content > .demo-status [margin]; C:187 .control-panel .demo-status [margin-top]; C:234 .report-content > .demo-status [margin] |
| `--spacing-landing-chart-content-inset` | `25px 27px 20px` | `p-landing-chart-content-inset` | 2 | R:192 .chart-content [padding]; C:190 .chart-content [padding] |
| `--spacing-landing-chart-heading-gap` | `15px` | `gap-landing-chart-heading-gap` | 2 | R:193 .chart-heading [gap]; C:191 .chart-heading [gap] |
| `--spacing-landing-chart-frame-top-space` | `33px` | `mt-landing-chart-frame-top-space` | 2 | R:197 .chart-frame [margin-top]; C:195 .chart-frame [margin-top] |
| `--spacing-landing-chart-frame-inset` | `0 4px 0 31px` | `p-landing-chart-frame-inset` | 2 | R:197 .chart-frame [padding]; C:195 .chart-frame [padding] |
| `--spacing-landing-chart-axis-top` | `-5px` | `top-landing-chart-axis-top` | 2 | R:198 .chart-y [top]; C:196 .chart-y [top] |
| `--spacing-landing-chart-axis-bottom` | `22px` | `bottom-landing-chart-axis-bottom` | 2 | R:198 .chart-y [bottom]; C:196 .chart-y [bottom] |
| `--spacing-landing-chart-footer-top-space` | `29px` | `mt-landing-chart-footer-top-space` | 2 | R:213 .chart-foot [margin-top]; C:211 .chart-foot [margin-top] |
| `--spacing-landing-chart-legend-gap` | `7px` | `gap-landing-chart-legend-gap` | 2 | R:214 .chart-foot span:first-child [gap]; C:212 .chart-foot span:first-child [gap] |
| `--spacing-landing-report-content-inset` | `20px 25px 23px` | `p-landing-report-content-inset` | 2 | R:217 .report-content [padding]; C:215 .report-content [padding] |
| `--spacing-landing-report-controls-bottom-space` | `17px` | `mb-landing-report-controls-bottom-space` | 2 | R:218 .report-controls [margin-bottom]; C:216 .report-controls [margin-bottom] |
| `--spacing-landing-report-format-inset` | `0 9px` | `p-landing-report-format-inset` | 2 | R:220 .format-button [padding]; C:218 .format-button [padding] |
| `--spacing-landing-report-sheet-inset` | `26px 31px 18px` | `p-landing-report-sheet-inset` | 2 | R:222 .report-sheet [padding]; C:220 .report-sheet [padding] |
| `--spacing-landing-report-heading-margin` | `37px 0 5px` | `m-landing-report-heading-margin` | 2 | R:225 .report-sheet h3 [margin]; C:223 .report-sheet h3 [margin] |
| `--spacing-landing-report-divider-margin` | `23px 0 8px` | `m-landing-report-divider-margin` | 2 | R:226 .report-rule [margin]; C:224 .report-rule [margin] |
| `--spacing-landing-report-footer-top-inset` | `11px` | `pt-landing-report-footer-top-inset` | 2 | R:232 .report-sheet__footer [padding-top]; C:230 .report-sheet__footer [padding-top] |
| `--spacing-landing-report-history-inset` | `10px 13px` | `p-landing-report-history-inset` | 2 | R:233 .report-history [padding]; C:231 .report-history [padding] |
| `--spacing-landing-map-content-inset` | `20px 24px 22px` | `p-landing-map-content-inset` | 2 | R:239 .map-content [padding]; C:237 .map-content [padding] |
| `--spacing-landing-map-toolbar-gap` | `7px` | `gap-landing-map-toolbar-gap` | 2 | R:241 .map-tools [gap]; C:239 .map-tools [gap] |
| `--spacing-landing-map-hint-left` | `15px` | `left-landing-map-hint-left` | 2 | R:255 .map-canvas__hint [left]; C:252 .map-canvas__hint [left] |
| `--spacing-landing-map-result-top-space` | `13px` | `mt-landing-map-result-top-space` | 2 | R:257 .map-content > .demo-status [margin-top]; C:254 .map-content > .demo-status [margin-top] |
| `--spacing-landing-section-frame-block-inset` | `clamp(100px, 11vw, 180px)` | `py-landing-section-frame-block-inset` | 2 | R:259 .feature-overview [padding-block]; R:286 .pricing-section [padding-block] |
| `--spacing-landing-feature-card-inset` | `30px` | `p-landing-feature-card-inset` | 1 | R:264 .feature-card [padding] |
| `--spacing-landing-feature-card-heading-margin` | `15px 0 10px` | `m-landing-feature-card-heading-margin` | 1 | R:266 .feature-card h2 [margin] |
| `--spacing-landing-feature-card-link-top-space` | `23px` | `mt-landing-feature-card-link-top-space` | 1 | R:268 .feature-card a [margin-top] |
| `--spacing-landing-preview-canvas-position-inset` | `39px 12px 12px` | `inset-landing-preview-canvas-position-inset` | 2 | R:271 .feature-preview__map [inset]; R:276 .feature-preview__editor [inset] |
| `--spacing-landing-preview-control-inset` | `23px 16px` | `p-landing-preview-control-inset` | 1 | R:273 .feature-preview__control [padding] |
| `--spacing-landing-preview-slider-top-space` | `25px` | `mt-landing-preview-slider-top-space` | 1 | R:273 .feature-preview__control > div:not(.feature-preview__schedule) [margin-top] |
| `--spacing-landing-preview-value-top-space` | `11px` | `mt-landing-preview-value-top-space` | 1 | R:273 .feature-preview__control small [margin-top] |
| `--spacing-landing-preview-schedule-gap` | `7px` | `gap-landing-preview-schedule-gap` | 1 | R:273 .feature-preview__schedule [gap] |
| `--spacing-landing-preview-schedule-top-space` | `17px` | `mt-landing-preview-schedule-top-space` | 1 | R:273 .feature-preview__schedule [margin-top] |
| `--spacing-landing-preview-chart-gap` | `7px` | `gap-landing-preview-chart-gap` | 1 | R:274 .feature-preview__chart [gap] |
| `--spacing-landing-preview-chart-margin` | `14px 17px` | `m-landing-preview-chart-margin` | 1 | R:274 .feature-preview__chart [margin] |
| `--spacing-landing-preview-chart-inset` | `15px 5px 6px` | `p-landing-preview-chart-inset` | 1 | R:274 .feature-preview__chart [padding] |
| `--spacing-landing-preview-report-inset` | `14% 9%` | `p-landing-preview-report-inset` | 1 | R:275 .feature-preview__report [padding] |
| `--spacing-landing-feature-detail-block-inset` | `clamp(105px, 9vw, 160px)` | `py-landing-feature-detail-block-inset` | 1 | R:278 .feature-detail [padding-block] |
| `--spacing-landing-feature-frame-gap` | `clamp(40px, 6vw, 110px)` | `gap-landing-feature-frame-gap` | 1 | R:279 .feature-detail__layout [gap] |
| `--spacing-landing-feature-detail-heading-margin` | `20px 0 22px` | `m-landing-feature-detail-heading-margin` | 1 | R:280 .feature-detail h2 [margin] |
| `--spacing-landing-feature-steps-margin` | `32px 0 30px` | `m-landing-feature-steps-margin` | 1 | R:281 .feature-detail ol [margin] |
| `--spacing-landing-feature-detail-outcome-inset` | `14px 0 14px 17px` | `p-landing-feature-detail-outcome-inset` | 1 | R:282 .feature-detail__outcome [padding] |
| `--spacing-landing-feature-detail-link-gap` | `11px` | `gap-landing-feature-detail-link-gap` | 1 | R:282 .feature-detail__copy > a [gap] |
| `--spacing-landing-feature-detail-link-top-space` | `29px` | `mt-landing-feature-detail-link-top-space` | 1 | R:282 .feature-detail__copy > a [margin-top] |
| `--spacing-landing-preview-stage-inset` | `45px` | `p-landing-preview-stage-inset` | 1 | R:283 .feature-detail__preview [padding] |
| `--spacing-landing-preview-toolbar-expanded-inline-inset` | `19px` | `px-landing-preview-toolbar-expanded-inline-inset` | 1 | R:283 .feature-detail__preview .feature-preview__header [padding-inline] |
| `--spacing-landing-preview-canvas-expanded-position-inset` | `60px 24px 22px` | `inset-landing-preview-canvas-expanded-position-inset` | 1 | R:284 .feature-detail__preview .feature-preview__map, .feature-detail__preview .feature-preview__editor [inset] |
| `--spacing-landing-preview-control-expanded-inset` | `52px 35px` | `p-landing-preview-control-expanded-inset` | 1 | R:284 .feature-detail__preview .feature-preview__control [padding] |
| `--spacing-landing-preview-slider-expanded-top-space` | `55px` | `mt-landing-preview-slider-expanded-top-space` | 1 | R:284 .feature-detail__preview .feature-preview__control > div:not(.feature-preview__schedule) [margin-top] |
| `--spacing-landing-preview-schedule-expanded-top-space` | `36px` | `mt-landing-preview-schedule-expanded-top-space` | 1 | R:284 .feature-detail__preview .feature-preview__schedule [margin-top] |
| `--spacing-landing-preview-chart-expanded-margin` | `27px 35px` | `m-landing-preview-chart-expanded-margin` | 1 | R:284 .feature-detail__preview .feature-preview__chart [margin] |
| `--spacing-landing-preview-chart-expanded-gap` | `11px` | `gap-landing-preview-chart-expanded-gap` | 1 | R:284 .feature-detail__preview .feature-preview__chart [gap] |
| `--spacing-landing-pricing-intro-bottom-space` | `44px` | `mb-landing-pricing-intro-bottom-space` | 1 | R:287 .pricing-section .section-intro [margin-bottom] |
| `--spacing-landing-pricing-card-inset` | `clamp(28px, 3vw, 44px)` | `p-landing-pricing-card-inset` | 1 | R:289 .pricing-card [padding] |
| `--spacing-landing-pricing-value-row-gap` | `7px` | `gap-landing-pricing-value-row-gap` | 1 | R:293 .pricing-card__price [gap] |
| `--spacing-landing-pricing-value-row-bottom-inset` | `30px` | `pb-landing-pricing-value-row-bottom-inset` | 1 | R:293 .pricing-card__price [padding-bottom] |
| `--spacing-landing-pricing-features-margin` | `31px 0 39px` | `m-landing-pricing-features-margin` | 1 | R:294 .pricing-card ul [margin] |
| `--spacing-landing-pricing-note-margin` | `25px 0 0` | `m-landing-pricing-note-margin` | 1 | R:295 .pricing-section__note [margin] |
| `--spacing-landing-inquiry-plan-inset` | `11px 14px` | `p-landing-inquiry-plan-inset` | 1 | R:296 .inquiry-selected-plan [padding] |
| `--spacing-landing-closing-block-inset` | `90px` | `py-landing-closing-block-inset` | 2 | R:298 .closing [padding-block]; C:256 .closing [padding-block] |
| `--spacing-landing-closing-heading-margin` | `19px 0 24px` | `m-landing-closing-heading-margin` | 2 | R:299 .closing h2 [margin]; C:257 .closing h2 [margin] |
| `--spacing-landing-closing-description-margin` | `0 auto 30px` | `m-landing-closing-description-margin` | 2 | R:300 .closing p:not(.eyebrow) [margin]; C:258 .closing p:not(.eyebrow) [margin] |
| `--spacing-landing-footer-body-block-inset` | `70px 27px` | `py-landing-footer-body-block-inset` | 1 | R:301 .footer [padding-block] |
| `--spacing-landing-footer-main-gap` | `clamp(35px, 6vw, 95px)` | `gap-landing-footer-main-gap` | 1 | R:302 .footer-main [gap] |
| `--spacing-landing-footer-main-bottom-inset` | `67px` | `pb-landing-footer-main-bottom-inset` | 1 | R:302 .footer-main [padding-bottom] |
| `--spacing-landing-footer-description-margin` | `17px 0 24px` | `m-landing-footer-description-margin` | 1 | R:303 .footer-company p [margin] |
| `--spacing-landing-footer-heading-margin` | `4px 0 22px` | `m-landing-footer-heading-margin` | 1 | R:304 .footer h2 [margin] |
| `--spacing-landing-footer-contacts-gap` | `15px` | `gap-landing-footer-contacts-gap` | 1 | R:304 .footer-contact dl [gap] |
| `--spacing-landing-footer-legal-top-inset` | `25px` | `pt-landing-footer-legal-top-inset` | 1 | R:306 .footer-bottom [padding-top] |
| `--spacing-landing-feature-frame-medium-gap` | `45px` | `gap-landing-feature-frame-medium-gap` | 1 | R:330 .feature-detail__layout [gap] |
| `--spacing-landing-scene-frame-medium-gap` | `50px` | `gap-landing-scene-frame-medium-gap` | 2 | R:332 .scene-layout [gap]; C:318 .scene-layout [gap] |
| `--spacing-landing-feature-detail-stacked-block-inset` | `110px 90px` | `py-landing-feature-detail-stacked-block-inset` | 1 | R:342 .feature-detail [padding-block] |
| `--spacing-landing-preview-stage-stacked-inset` | `30px` | `p-landing-preview-stage-stacked-inset` | 1 | R:342 .feature-detail__preview [padding] |
| `--spacing-landing-header-frame-stacked-gap` | `5px 20px` | `gap-landing-header-frame-stacked-gap` | 1 | R:344 .header-inner [gap] |
| `--spacing-landing-navigation-login-stacked-inline-inset` | `11px` | `px-landing-navigation-login-stacked-inline-inset` | 2 | R:344 .button--header [padding-inline]; C:327 .button--header [padding-inline] |
| `--spacing-landing-hero-frame-stacked-gap` | `15px` | `gap-landing-hero-frame-stacked-gap` | 2 | R:345 .hero-inner [gap]; C:328 .hero-inner [gap] |
| `--spacing-landing-hero-frame-stacked-block-inset` | `120px 95px` | `py-landing-hero-frame-stacked-block-inset` | 2 | R:345 .hero-inner [padding-block]; C:328 .hero-inner [padding-block] |
| `--spacing-landing-hero-illustration-stacked-top-space` | `-15px` | `mt-landing-hero-illustration-stacked-top-space` | 2 | R:345 .hero-art [margin-top]; C:328 .hero-art [margin-top] |
| `--spacing-landing-hero-art-background-card-stacked-inset` | `15px` | `p-landing-hero-art-background-card-stacked-inset` | 2 | R:345 .hero-art__panel--back [padding]; C:328 .hero-art__panel--back [padding] |
| `--spacing-landing-scene-frame-stacked-block-inset` | `85px 90px` | `py-landing-scene-frame-stacked-block-inset` | 2 | R:346 .scene-layout [padding-block]; C:329 .scene-layout [padding-block] |
| `--spacing-landing-demo-backplate-stacked-bottom` | `-13px` | `bottom-landing-demo-backplate-stacked-bottom` | 2 | R:346 .demo-wrap::after [bottom]; C:329 .demo-wrap::after [bottom] |
| `--spacing-landing-inspector-stacked-gap` | `7px 12px` | `gap-landing-inspector-stacked-gap` | 2 | R:347 .inspector [gap]; C:330 .inspector [gap] |
| `--spacing-landing-control-panel-stacked-margin` | `15px` | `m-landing-control-panel-stacked-margin` | 2 | R:348 .control-panel [margin]; C:331 .control-panel [margin] |
| `--spacing-landing-footer-main-stacked-gap` | `38px` | `gap-landing-footer-main-stacked-gap` | 1 | R:349 .footer-main [gap] |
| `--spacing-landing-anchor-narrow-anchor-offset` | `118px` | `scroll-mt-landing-anchor-narrow-anchor-offset` | 1 | R:353 [id] [scroll-margin-top] |
| `--spacing-landing-section-frame-block-inset-narrow` | `120px 90px` | `py-landing-section-frame-block-inset-narrow` | 1 | R:354 .feature-overview [padding-block] |
| `--spacing-landing-feature-card-narrow-inset` | `17px` | `p-landing-feature-card-narrow-inset` | 1 | R:354 .feature-card [padding] |
| `--spacing-landing-feature-card-link-narrow-top-space` | `15px` | `mt-landing-feature-card-link-narrow-top-space` | 1 | R:354 .feature-card a [margin-top] |
| `--spacing-landing-preview-canvas-expanded-narrow-position-inset` | `50px 15px 15px` | `inset-landing-preview-canvas-expanded-narrow-position-inset` | 1 | R:355 .feature-detail__preview .feature-preview__map, .feature-detail__preview .feature-preview__editor [inset] |
| `--spacing-landing-preview-control-expanded-narrow-inset` | `33px 22px` | `p-landing-preview-control-expanded-narrow-inset` | 1 | R:355 .feature-detail__preview .feature-preview__control [padding] |
| `--spacing-landing-preview-slider-expanded-narrow-top-space` | `34px` | `mt-landing-preview-slider-expanded-narrow-top-space` | 1 | R:355 .feature-detail__preview .feature-preview__control > div:not(.feature-preview__schedule) [margin-top] |
| `--spacing-landing-preview-schedule-expanded-narrow-top-space` | `19px` | `mt-landing-preview-schedule-expanded-narrow-top-space` | 1 | R:355 .feature-detail__preview .feature-preview__schedule [margin-top] |
| `--spacing-landing-preview-chart-expanded-narrow-margin` | `22px 17px` | `m-landing-preview-chart-expanded-narrow-margin` | 1 | R:355 .feature-detail__preview .feature-preview__chart [margin] |
| `--spacing-landing-navigation-login-narrow-inline-inset` | `7px` | `px-landing-navigation-login-narrow-inline-inset` | 1 | R:356 .button--header [padding-inline] |
| `--spacing-landing-hero-actions-narrow-gap` | `15px` | `gap-landing-hero-actions-narrow-gap` | 2 | R:357 .hero-actions [gap]; C:337 .hero-actions [gap] |
| `--spacing-landing-hero-illustration-narrow-top-space` | `-5px` | `mt-landing-hero-illustration-narrow-top-space` | 2 | R:357 .hero-art [margin-top]; C:337 .hero-art [margin-top] |
| `--spacing-landing-scene-frame-narrow-gap` | `37px` | `gap-landing-scene-frame-narrow-gap` | 2 | R:358 .scene-layout [gap]; C:338 .scene-layout [gap] |
| `--spacing-landing-scene-frame-narrow-block-inset` | `72px 80px` | `py-landing-scene-frame-narrow-block-inset` | 2 | R:358 .scene-layout [padding-block]; C:338 .scene-layout [padding-block] |
| `--spacing-landing-scene-number-narrow-bottom-space` | `30px` | `mb-landing-scene-number-narrow-bottom-space` | 2 | R:358 .scene-number [margin-bottom]; C:338 .scene-number [margin-bottom] |
| `--spacing-landing-scene-benefit-narrow-top-space` | `19px` | `mt-landing-scene-benefit-narrow-top-space` | 2 | R:358 .scene-benefit [margin-top]; C:338 .scene-benefit [margin-top] |
| `--spacing-landing-scene-benefit-narrow-top-inset` | `17px` | `pt-landing-scene-benefit-narrow-top-inset` | 2 | R:358 .scene-benefit [padding-top]; C:338 .scene-benefit [padding-top] |
| `--spacing-landing-demo-frame-compact-inline-inset` | `13px` | `px-landing-demo-frame-compact-inline-inset` | 4 | R:359 .demo-toolbar [padding-inline]; R:359 .demo-disclaimer [padding-inline]; C:339 .demo-toolbar [padding-inline]; C:339 .demo-disclaimer [padding-inline] |
| `--spacing-landing-demo-title-narrow-gap` | `7px` | `gap-landing-demo-title-narrow-gap` | 2 | R:359 .demo-title [gap]; C:339 .demo-title [gap] |
| `--spacing-landing-demo-content-compact-inset` | `15px 12px` | `p-landing-demo-content-compact-inset` | 4 | R:362 .report-content [padding]; R:364 .map-content [padding]; C:342 .report-content [padding]; C:344 .map-content [padding] |
| `--spacing-landing-report-heading-narrow-top-space` | `26px` | `mt-landing-report-heading-narrow-top-space` | 2 | R:362 .report-sheet h3 [margin-top]; C:342 .report-sheet h3 [margin-top] |
| `--spacing-landing-html-scroll-padding` | `94px` | `scroll-pt-landing-html-scroll-padding` | 1 | C:24 html [scroll-padding-top] |
| `--spacing-landing-concept-footer-body-inset` | `25px 0` | `p-landing-concept-footer-body-inset` | 1 | C:259 .footer [padding] |
| `--spacing-landing-concept-inquiry-header-inset` | `30px 34px 20px` | `p-landing-concept-inquiry-header-inset` | 1 | C:267 .inquiry-dialog__head [padding] |
| `--spacing-landing-concept-inquiry-description-margin` | `9px 0 0` | `m-landing-concept-inquiry-description-margin` | 1 | C:270 .inquiry-dialog__head p:last-child [margin] |
| `--spacing-landing-concept-inquiry-form-gap` | `19px` | `gap-landing-concept-inquiry-form-gap` | 1 | C:274 #inquiry-form [gap] |
| `--spacing-landing-concept-inquiry-form-inset` | `24px 34px 34px` | `p-landing-concept-inquiry-form-inset` | 1 | C:274 #inquiry-form [padding] |
| `--spacing-landing-concept-inquiry-fields-gap` | `15px` | `gap-landing-concept-inquiry-fields-gap` | 1 | C:275 .inquiry-fields [gap] |
| `--spacing-landing-concept-inquiry-field-gap` | `7px` | `gap-landing-concept-inquiry-field-gap` | 1 | C:276 .inquiry-field [gap] |
| `--spacing-landing-concept-inquiry-message-inset` | `15px 17px` | `p-landing-concept-inquiry-message-inset` | 2 | C:287 .inquiry-privacy [padding]; C:291 .inquiry-feedback [padding] |
| `--spacing-landing-concept-inquiry-message-description-space` | `5px 0 0` | `m-landing-concept-inquiry-message-description-space` | 2 | C:288 .inquiry-privacy p [margin]; C:294 .inquiry-feedback p [margin] |
| `--spacing-landing-concept-inquiry-consent-gap` | `9px` | `gap-landing-concept-inquiry-consent-gap` | 1 | C:289 .inquiry-consent label [gap] |
| `--spacing-landing-concept-inquiry-feedback-action-top-space` | `7px` | `mt-landing-concept-inquiry-feedback-action-top-space` | 1 | C:294 .inquiry-feedback a [margin-top] |
| `--spacing-landing-html-stacked-scroll-padding` | `78px` | `scroll-pt-landing-html-stacked-scroll-padding` | 1 | C:325 html [scroll-padding-top] |
| `--spacing-landing-concept-inquiry-header-stacked-inset` | `23px 20px 17px` | `p-landing-concept-inquiry-header-stacked-inset` | 1 | C:333 .inquiry-dialog__head [padding] |
| `--radius-landing-skip-link` | `8px` | `rounded-landing-skip-link` | 2 | R:32 .skip-link [border-radius]; C:33 .skip-link [border-radius] |
| `--radius-landing-button` | `12px` | `rounded-landing-button` | 2 | R:35 .button [border-radius]; C:36 .button [border-radius] |
| `--radius-landing-demo-surface` | `15px` | `rounded-landing-demo-surface` | 2 | R:46 .card [border-radius]; C:47 .card [border-radius] |
| `--radius-landing-brand-mark` | `8px` | `rounded-landing-brand-mark` | 2 | R:54 .brand img [border-radius]; C:55 .brand img [border-radius] |
| `--radius-landing-ellipse` | `50%` | `rounded-landing-ellipse` | 38 | R:63 .hero-orbit [border-radius]; R:77 .hero-art__ring [border-radius]; R:94 .hero-art__pulse [border-radius]; R:127 .demo-title__dot [border-radius]; R:148 .fixture [border-radius]; R:149 .fixture span [border-radius]; R:154 .floorplan__legend i [border-radius]; R:161 .status-pill i [border-radius]; R:172 .control-visual__glow [border-radius]; R:174 .control-visual__lamp::before [border-radius]; R:177 .control-visual__floor [border-radius]; R:183 .control-panel input[type="range"]::-webkit-slider-thumb [border-radius]; R:184 .control-panel input[type="range"]::-moz-range-thumb [border-radius]; R:214 .chart-foot i [border-radius]; R:245 .map-tools .button--tool i [border-radius]; R:246 .map-drag-ghost [border-radius]; R:252 .map-light [border-radius]; R:270 .feature-preview__header span [border-radius]; R:272 .feature-preview__map span, .feature-preview__editor i [border-radius]; R:273 .feature-preview__control i [border-radius]; R:294 .pricing-card li span [border-radius]; C:62 .hero-orbit [border-radius]; C:75 .hero-art__ring [border-radius]; C:92 .hero-art__pulse [border-radius]; C:125 .demo-title__dot [border-radius]; C:146 .fixture [border-radius]; C:147 .fixture span [border-radius]; C:152 .floorplan__legend i [border-radius]; C:159 .status-pill i [border-radius]; C:170 .control-visual__glow [border-radius]; C:172 .control-visual__lamp::before [border-radius]; C:175 .control-visual__floor [border-radius]; C:181 .control-panel input[type="range"]::-webkit-slider-thumb [border-radius]; C:182 .control-panel input[type="range"]::-moz-range-thumb [border-radius]; C:212 .chart-foot i [border-radius]; C:243 .map-tools .button--tool i [border-radius]; C:244 .map-drag-ghost [border-radius]; C:250 .map-light [border-radius] |
| `--radius-landing-glass-panel` | `18px` | `rounded-landing-glass-panel` | 3 | R:78 .hero-art__panel [border-radius]; R:269 .feature-preview [border-radius]; C:76 .hero-art__panel [border-radius] |
| `--radius-landing-hero-chart-bar` | `5px 5px 0 0` | `rounded-landing-hero-chart-bar` | 2 | R:88 .hero-art__panel--front b [border-radius]; C:86 .hero-art__panel--front b [border-radius] |
| `--radius-landing-demo-backplate` | `30px` | `rounded-landing-demo-backplate` | 2 | R:119 .demo-wrap::after [border-radius]; C:117 .demo-wrap::after [border-radius] |
| `--radius-landing-demo-card` | `20px` | `rounded-landing-demo-card` | 2 | R:122 .demo-card [border-radius]; C:120 .demo-card [border-radius] |
| `--radius-landing-floorplan` | `12px` | `rounded-landing-floorplan` | 2 | R:136 .floorplan [border-radius]; C:134 .floorplan [border-radius] |
| `--radius-landing-floorplan-entry` | `4px` | `rounded-landing-floorplan-entry` | 2 | R:147 .floorplan__entry [border-radius]; C:145 .floorplan__entry [border-radius] |
| `--radius-landing-control-pendant` | `0 0 31px 31px` | `rounded-landing-control-pendant` | 2 | R:173 .control-visual__lamp [border-radius]; C:171 .control-visual__lamp [border-radius] |
| `--radius-landing-report-progress` | `6px` | `rounded-landing-report-progress` | 2 | R:228 .report-row i [border-radius]; C:226 .report-row i [border-radius] |
| `--radius-landing-map-tool` | `8px` | `rounded-landing-map-tool` | 2 | R:243 .map-tools .button [border-radius]; C:241 .map-tools .button [border-radius] |
| `--radius-landing-map-hint` | `6px` | `rounded-landing-map-hint` | 2 | R:255 .map-canvas__hint [border-radius]; C:252 .map-canvas__hint [border-radius] |
| `--radius-landing-preview-label-bar` | `4px` | `rounded-landing-preview-label-bar` | 1 | R:273 .feature-preview__control > span [border-radius] |
| `--radius-landing-preview-detail` | `5px` | `rounded-landing-preview-detail` | 2 | R:273 .feature-preview__control > div:not(.feature-preview__schedule) [border-radius]; R:273 .feature-preview__schedule b [border-radius] |
| `--radius-landing-preview-chart-bar` | `4px 4px 0 0` | `rounded-landing-preview-chart-bar` | 1 | R:274 .feature-preview__chart span [border-radius] |
| `--radius-landing-preview-stage` | `35px` | `rounded-landing-preview-stage` | 1 | R:283 .feature-detail__preview [border-radius] |
| `--radius-landing-preview-window-expanded` | `24px` | `rounded-landing-preview-window-expanded` | 1 | R:283 .feature-detail__preview .feature-preview [border-radius] |
| `--radius-landing-preview-stage-narrow` | `20px` | `rounded-landing-preview-stage-narrow` | 1 | R:355 .feature-detail__preview [border-radius] |
| `--radius-landing-preview-window-expanded-narrow` | `16px` | `rounded-landing-preview-window-expanded-narrow` | 1 | R:355 .feature-detail__preview .feature-preview [border-radius] |
| `--radius-landing-inquiry-modal` | `18px` | `rounded-landing-inquiry-modal` | 2 | C:265 .inquiry-dialog [border-radius]; R:PublicSiteLayout.tsx:19 ConsultationDialog → ModalDialog [rounded-[18px]!] |
| `--radius-landing-concept-inquiry-privacy` | `11px` | `rounded-landing-concept-inquiry-privacy` | 1 | C:287 .inquiry-privacy [border-radius] |
| `--radius-landing-concept-inquiry-modal-stacked` | `13px` | `rounded-landing-concept-inquiry-modal-stacked` | 1 | C:333 .inquiry-dialog [border-radius] |
| `--radius-landing-compact-control` | `9px` | `rounded-landing-compact-control` | 4 | R:128 .replay-button [border-radius]; C:126 .replay-button [border-radius]; C:271 .inquiry-dialog__close [border-radius]; C:281 .inquiry-field input:not([type=checkbox]), .inquiry-field select, .inquiry-field textarea [border-radius] |
| `--radius-landing-compact-summary-surface` | `9px` | `rounded-landing-compact-summary-surface` | 3 | R:233 .report-history [border-radius]; C:231 .report-history [border-radius]; R:296 .inquiry-selected-plan [border-radius] |
| `--radius-landing-inset-surface` | `7px` | `rounded-landing-inset-surface` | 4 | R:139 .floorplan__drawing [border-radius]; R:271 .feature-preview__map [border-radius]; R:275 .feature-preview__report [border-radius]; C:137 .floorplan__drawing [border-radius] |
| `--radius-landing-compact-choice-control` | `7px` | `rounded-landing-compact-choice-control` | 2 | R:220 .format-button [border-radius]; C:218 .format-button [border-radius] |
| `--shadow-landing-demo-card` | `0 18px 55px rgb(21 50 74 / .10)` | `shadow-landing-demo-card` | 2 | R:20 .field-day [--shadow]; C:21 :root [--shadow] |
| `--shadow-landing-hero-atmosphere` | `0 0 80px rgb(37 111 161 / .20)` | `shadow-landing-hero-atmosphere` | 2 | R:77 .hero-art__ring [box-shadow]; C:75 .hero-art__ring [box-shadow] |
| `--shadow-landing-glass-panel` | `0 25px 50px rgb(23 32 51 / .26)` | `shadow-landing-glass-panel` | 2 | R:78 .hero-art__panel [box-shadow]; C:76 .hero-art__panel [box-shadow] |
| `--shadow-landing-hero-highlight` | `0 0 0 16px rgb(255 122 92 / .18)` | `shadow-landing-hero-highlight` | 2 | R:94 .hero-art__pulse [box-shadow]; C:92 .hero-art__pulse [box-shadow] |
| `--shadow-landing-control-floor-glow` | `0 0 var(--floor-glow, 15px) rgb(232 242 248 / .42)` | `shadow-landing-control-floor-glow` | 2 | R:177 .control-visual__floor [box-shadow]; C:175 .control-visual__floor [box-shadow] |
| `--shadow-landing-report-sheet` | `0 12px 30px rgb(21 50 74 / .07)` | `shadow-landing-report-sheet` | 2 | R:222 .report-sheet [box-shadow]; C:220 .report-sheet [box-shadow] |
| `--shadow-landing-map-drag-preview` | `0 0 0 6px var(--color-action-primary-soft), 0 7px 17px rgb(21 50 74 / .24)` | `shadow-landing-map-drag-preview` | 2 | R:246 .map-drag-ghost [box-shadow]; C:244 .map-drag-ghost [box-shadow] |
| `--shadow-landing-feature-card` | `0 9px 32px rgb(21 50 74 / .05)` | `shadow-landing-feature-card` | 1 | R:264 .feature-card [box-shadow] |
| `--shadow-landing-preview-window` | `12px 14px 0 var(--color-action-primary-soft)` | `shadow-landing-preview-window` | 1 | R:269 .feature-preview [box-shadow] |
| `--shadow-landing-preview-report` | `0 7px 16px rgb(21 50 74 / .11)` | `shadow-landing-preview-report` | 1 | R:275 .feature-preview__report [box-shadow] |
| `--shadow-landing-preview-window-expanded` | `17px 20px 0 rgb(37 111 161 / .1)` | `shadow-landing-preview-window-expanded` | 1 | R:283 .feature-detail__preview .feature-preview [box-shadow] |
| `--shadow-landing-pricing-card` | `0 12px 36px rgb(21 50 74 / .06)` | `shadow-landing-pricing-card` | 1 | R:289 .pricing-card [box-shadow] |
| `--shadow-landing-pricing-featured-card` | `0 20px 54px rgb(21 50 74 / .11)` | `shadow-landing-pricing-featured-card` | 1 | R:290 .pricing-card--featured [box-shadow] |
| `--shadow-landing-preview-window-narrow` | `6px 7px 0 var(--color-action-primary-soft)` | `shadow-landing-preview-window-narrow` | 1 | R:354 .feature-preview [box-shadow] |
| `--shadow-landing-concept-inquiry-modal` | `0 24px 80px rgb(23 32 51 / .25)` | `shadow-landing-concept-inquiry-modal` | 1 | C:265 .inquiry-dialog [box-shadow] |
| `--shadow-landing-header-raised` | `0 8px 24px rgb(23 32 51 / .14)` | `shadow-landing-header-raised` | 2 | R:51 .site-header.is-scrolled [box-shadow]; C:52 .site-header.is-scrolled [box-shadow] |
| `--shadow-landing-fixture-highlight` | `0 0 0 5px var(--color-action-primary-soft), 0 0 0 9px rgb(37 111 161 / .12)` | `shadow-landing-fixture-highlight` | 2 | R:150 .fixture:hover span, .fixture[aria-pressed="true"] span [box-shadow]; C:148 .fixture:hover span, .fixture[aria-pressed="true"] span [box-shadow] |
| `--animate-landing-monitoring-cursor` | `cursor-path 3.4s ease-in-out forwards` | `animate-landing-monitoring-cursor` | 2 | R:166 .scene--monitoring.is-playing .demo-cursor [animation]; C:164 .scene--monitoring.is-playing .demo-cursor [animation] |
| `--animate-landing-chart-line` | `draw-chart 2.3s ease forwards` | `animate-landing-chart-line` | 2 | R:204 .scene--statistics.is-playing .chart-line [animation]; C:202 .scene--statistics.is-playing .chart-line [animation] |
| `--animate-landing-chart-area` | `reveal-area 1.1s 1.2s ease forwards` | `animate-landing-chart-area` | 2 | R:205 .scene--statistics.is-playing .chart-area [animation]; C:203 .scene--statistics.is-playing .chart-area [animation] |
| `--animate-landing-chart-points` | `reveal-points .45s 2s ease forwards` | `animate-landing-chart-points` | 2 | R:206 .scene--statistics.is-playing .chart-points circle [animation]; C:204 .scene--statistics.is-playing .chart-points circle [animation] |
| `--animate-landing-report-row` | `report-row-in .45s ease forwards` | `animate-landing-report-row` | 2 | R:229 .scene--report.is-playing .report-row [animation]; C:227 .scene--report.is-playing .report-row [animation] |
| `--animate-landing-report-history` | `report-row-in .45s 1.45s ease forwards` | `animate-landing-report-history` | 2 | R:235 .scene--report.is-playing .report-history [animation]; C:233 .scene--report.is-playing .report-history [animation] |
| `--animate-landing-hero-copy` | `rise-in .8s both` | `animate-landing-hero-copy` | 2 | R:310 .hero.is-animating .hero-copy > * [animation]; C:299 .hero.is-animating .hero-copy > * [animation] |
| `--animate-landing-hero-ring` | `art-float 1.2s .3s both` | `animate-landing-hero-ring` | 2 | R:311 .hero.is-animating .hero-art__ring [animation]; C:300 .hero.is-animating .hero-art__ring [animation] |
| `--animate-landing-hero-bars` | `hero-bar-rise 1.55s ease-out both` | `animate-landing-hero-bars` | 2 | R:312 .hero.is-animating .hero-art__panel--front b [animation]; C:301 .hero.is-animating .hero-art__panel--front b [animation] |
| `--animate-landing-hero-dot` | `hero-dot-drift 3.8s ease-in-out both` | `animate-landing-hero-dot` | 2 | R:314 .hero.is-animating .hero-art__pulse [animation]; C:303 .hero.is-animating .hero-art__pulse [animation] |
| `--animate-landing-hero-pointer` | `hero-pointer-drift 3.8s ease-in-out both` | `animate-landing-hero-pointer` | 2 | R:315 .hero.is-animating .hero-art__pointer [animation]; C:304 .hero.is-animating .hero-art__pointer [animation] |
| `--color-status-inquiry-danger-foreground` | `#b42318` | `semantic color utility` | 1 | 정적 상담 필수표시/오류본문/invalid border |
| `--color-status-inquiry-danger-border` | `#fecdca` | `semantic color utility` | 1 | 정적 상담 error feedback border |
| `--color-status-inquiry-danger-background` | `#fff5f4` | `semantic color utility` | 1 | 정적 상담 error feedback background |


## Pre-RED fix round 1 — 역할 경계 계약

I1. 모든 font-size-only 역할은 원래 상속된 행간/자간을 유지한다. 아래 계약은 크기만 공유하며 배경·배치·weight를 묶지 않는다.

| 역할 계약 | 소비자와 경계 | 정확 값 |
|---|---|---|
| action | hero contact 및 feature detail link. 클릭 가능한 텍스트 action만 소유; footer heading/서술문 제외 | 14px |
| feature-detail-copy-narrow | 좁은 feature detail 설명과 단계 목록의 공통 narrative size. 각 1.8/1.6 행간은 그대로 | 14px |
| footer-heading | 회사 연락/안내 그룹을 구분하는 footer heading | 14px |
| demo-meta | 데모 내부 toolbar/room/row/caption의 보조 metadata. feature-card copy와 page footer는 제외 | 11px |
| feature-card-copy-narrow / concept-footer-body | compact feature description/outcome과 static page footer는 별도 역할. card 두 소비자는 같은 compact narrative tier이며 inherited 1.65/1.55를 보존 | 각각 11px |
| preview-control-value-expanded / report-heading-narrow | 확장 미리보기의 수치와 좁은 보고서 제목은 별도 역할 | 각각 19px |
| chart-heading-narrow | 좁은 chart title. 일반 body와 공유하지 않음 | 16px |
| compact-action | demo replay 및 좁은 feature-card link의 compact text action. label·설명·장식 marker 제외 | 12px |
| demo-title / feature-supporting-note / plan-feature-marker / scene-benefit-narrow | 각각 demo toolbar title, feature overview/preview의 예시 안내, plan check marker, 좁은 scene benefit 서술문을 소유 | 각각 12px |
| control-heading / feature-card-link / inquiry-plan / footer-body | control section caption, feature link, 선택계획 summary, footer prose. 기존 body-secondary의 동일 값 묶음을 해제 | 각각 13px |
| narrative-copy-narrow / price-unit | 좁은 hero·scene·section intro·closing 설명은 공통 narrative size variant. price 단위는 독립 metric suffix. 각 설명의 기존 1.8/1.75/1.7 행간은 유지 | 각각 15px |
| demo-caption / demo-control-label | demo의 compact 정보 tier와 클릭 가능한 format/map-tool control label은 구분 | 각각 10px |
| replay-icon | replay button의 선행 기호. 텍스트 label 크기와 독립 | 18px |

기타 small list 검토: demo-micro의 axis tick/report history는 데모 안 공간 제약이 큰 보조 데이터 tier이며 별도 heading/action이 아니므로 9px 공유를 유지한다. concept form label(12px)은 입력과 연결된 label 역할이므로 feature note와 병합하지 않는다. concept dismiss(14px)는 닫기 glyph이고 일반 텍스트 action이 아니므로 별도로 유지한다. optional11px는 실제 form optional 표시이고 demo meta가 아니므로 병합하지 않는다. 이들은 동일 숫자만으로 묶지 않았다.

I2. Corner 계약은 아래 component primitive의 모양만 소유하며 interaction/배치/markup을 바꾸지 않는다.

| corner primitive | 소비자 | 경계·이유 | 값 |
|---|---|---|---|
| compact-control | demo replay, concept dismiss, concept input/select/textarea | compact interactive control의 동일 corner contract. control 종류가 달라도 control frame의 corner만 공유한다 | 9px |
| compact-summary-surface | report-history 및 선택 요금제 summary | compact contextual summary container. 클릭 action이나 form field가 아니다 | 9px |
| inset-surface | floor drawing, preview map, preview report | 큰 demo/preview 안의 nested drawing/document surface | 7px |
| compact-choice-control | PDF/XLSX format selector | compact option 선택 control의 작은 corner variant. surface와 구분하며 replay/dismiss보다 작은 형태를 보존 | 7px |

I3. `concept-inquiry-privacy-label` 후보를 삭제했다. C:288의 direct strong size12px는 C:287 privacy container의12px/1.65를 정확히 상속한다. `strong`과 기본 font weight는 유지한다. C HTML:373의 direct child 구조로 확인했으며 dead selector 삭제로 주장하지 않는다. 후속 migration은 child에 별도 text size utility를 주지 않는다.

Minor1. header-raised 및 fixture-highlight로 shadow 계약을 명명했다. fixture-highlight의 hover와 aria-pressed 소비자는 표의 원본 selector에 모두 남겼다.
Minor2. demo toolbar/disclaimer가 실제 공유하는 것은 compact inline inset13px뿐이다. toolbar 기본 inline inset22px와 disclaimer 기본 `11px 22px` 전체 frame은 별도로 유지하므로 기본22px 통합을 성과로 주장하지 않는다.
Minor3. inquiry-modal 표에 React `PublicSiteLayout.tsx:19`의18px override를 추가해 static/React dialog corner 소비자 두 개를 명시했다.


### Supplemental 승인: 시안 문서 기본 행간

앞의369선언 승인 및 `d7044f139ee663ebeeff9437e08cc14f45ac061d` 커밋은 당시 검토 결과로 보존한다. 이후 concept 문서의 기본 행간 보존 경로를 보완하면서 `--leading-landing-concept-document: normal` **한 선언만** 추가 승인했다. 기존369값은 그대로이며 현재 승인 map은370개, SHA-256은 `2b145a3c5a5229f66d5f74b96978122f1e30991a9e8436b4b7f55c0bd98896a4`다. 최종표의 문서 행간 역할은 새 기본 UI 스케일이 아니라 original static baseline을 유지하는 root 상속 계약이다.

동일 브라우저1440×900 조건에서 original static의 html/body/hero/eyebrow는 computed line-height `normal`이었다. React의 html/body/field-day/hero는 font-size16px에 line-height24px, eyebrow는13px에19.5px라 기존1.5 상속이 확인됐다. 보완 전 확인에 사용한 static·React 원본 CSS와 component는 기준 commit 이후 변경하지 않았다.

현재 UI policy는 `leading-normal`을 unapproved-typography, `leading-[normal]`을 arbitrary-typography로 거부한다. 따라서 뒤의 시안 전환은 document root에 승인된 `leading-landing-concept-document`를 사용해 명시 행간이 없는 자손에게 original normal을 상속시킨다. 개별 역할의 explicit line-height는 그대로 우선하며 React root를 변경하지 않는다. normal을1.5 같은 숫자로 근사하거나 @utility·arbitrary property 우회를 추가하지 않는다.

이번 보완의 focused exact-value test는 신규 역할 누락0회에서 RED를 확인한 뒤, flat theme에1회 추가해370개 값/선언1회 GREEN을 확인한다. 시안 전환 후 실제 root utility 적용과 각 element의 inherited/explicit line-height 보존은 후속 compile/PNG gate에서 검증한다.
