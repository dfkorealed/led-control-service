# UI 간격 규칙

기준일: 2026-09-16

## 목적과 적용 범위

이 문서는 Web UI의 간격·색상·타이포그래피 토큰과 정책 검사 기준이다. `apps/web/src/styles/theme.css`의 CSS-first `@theme static`이 단일 토큰 원천이며 JavaScript Tailwind config는 만들지 않는다. Task 12에서 공통 컴포넌트와 모니터링·제어·통계·설정 화면을 승인 utility로 전환하고 legacy selector를 제거했다.

- 적용 범위: 공통 shell/auth/operator UI와 모니터링·제어·통계·설정 메뉴
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

2026-09-16 최종 검증에서 UI policy **52/52**, `ui:check` **기존 0·신규/증가 0**, Web Vitest **83 files·1,224/1,224**, 1440×900·1024×768·390×844·320×740 layout assertions를 포함한 전체 Chromium 직렬 **257 passed·5 environment-gated skipped·실패 0**을 확인했다. 별도 opt-in RealBackendLab도 설치 여정 **2/2**와 층 배치·제어·통계 **1/1**을 통과했다. 루트 `pnpm test`도 fail-closed UI 정책 체인을 포함한 상태로 통과했다. 실제 native WebView safe-area 실측과 수동 in-app 시각 QA는 별도 후속 검증이다.

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
