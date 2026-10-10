# Task 2 공통 고객 표현 결과

상태: 완료. Task1 승인 token/정책을 소비하며 기본 variant를 유지하는 명시적 customer opt-in API를 구현했다.

commit: `2782a94228ab395ae4b060f7100f846d73e84462`.

## 변경 및 공개 API

- Typography의 customer-page-title/section-title/card-title/metric 네 역할, PageHeader variant customer와 기존 headingLevel, Card padding customer(default none), UnderlineNavigation variant customer 및 navigationItemClass({active,variant})를 추가했다.
- NavigationCard는 기존 Link 속성·ref와 to/icon/title/description/summary를 전달하는 단일 전체 Link다. 부가 slot은 정보 표시만 하며 별도 중첩 버튼을 만들지 않는다.
- SidePanel surface plain(default card), Slider presentation bare(default field)는 embedded 외곽 경계만 제거하고 children/ref·실제 label/설명/오류/ARIA·52px thumb/keyboard owner를 유지한다.
- FilterPanel triggerLabel(default 필터)과 count0 badge 숨김/양수 표시, RecentActivityTicker title(default 최근 이력)의 PC visible/mobile sr-only 제목·arrow·panel inset을 구현했다. ticker title 변경은 현재 row/timer를 reset하지 않으며 기존5초/pause/scope contract를 유지한다.
- 고객 theme scope의 secondary/ghost Button만 neutral/transparent/pressed-soft 표현을 적용했다. 기본 비고객·primary·danger·landing 분기와 onPress/click/disabled·큰 hit는 유지한다.
- InlineStatusSummary는 실제 tone의 장식 dot과 중립14/16 label/value를 표시하며0/null을 보존한다. 고객 context의 compact mobile DataGrid만 분리된 두 열 label/value 카드로 구성하며 ResizeObserver/실제 sortable columns/공급 rows 정렬·긴 값 wrap을 보존한다.
- 고객 spacing은 Card inset20/16, PageHeader gap20/12, navigation track gap8/padding-bottom8을 공통 소유한다. main body28/24·mobile14/18, section20/grid18의 shell 소비는 Task3에서 적용한다.
- 초기 Task1 cn 불변은 token-only 범위였다. root가 Task2 확장을 명시 승인하여 utils/cn.ts의 기존 text registry에 customer-page-title/customer-metric 정확 두 entries만 추가했다. 기존 merge 정책·entries·unknown 허용은 불변이다. 실제 size+foreground 및 같은 breakpoint size만 교체하는 composition을 focused cn contract로 확인했다.
- S3 sidebar/완전 S4 소비자 교정은 Task3로 남으며 S5/S6/S9/S10/S11/S12 공통 기반은 구현했다. 영향받은 네 메뉴 문서에 현재 기반·후속 소비/시각 확인 한계를 함께 기록했다.

## 검증

모든 명령은 task worktree cwd와 Node22.20.0/pnpm9.15.0 `PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH"`를 사용했다.

- RED/GREEN 명령: `pnpm --filter @led-control/web exec vitest run src/components/ui/CustomerPresentation.test.tsx src/components/ui/utils/cn.test.ts src/components/ui/FilterPanel.test.tsx src/components/ui/operations/RecentActivityTicker.test.tsx src/components/ui/fields/fields.test.tsx -t 'customer|Customer|whole navigation|opt-in|trigger label|visible title|bare Slider'`.
- RED: exit1, 12FAIL/1PASS/195filtered SKIP(208), 2.76초. 모두 신규 API/기본 recipe 미구현으로 실패했으며 import/fixture 오류는 없었다. `task-2-red.log`에 실패명을 보존했다.
- GREEN: exit0, 13PASS/0FAIL/195filtered SKIP(208), 2.80초. `task-2-green.log`. 필터링 제외195는 환경 skip이나 전체 suite PASS가 아니다.
- 변경된 기존 suite 한 번: `pnpm --filter @led-control/web exec vitest run src/components/ui/Typography.test.tsx src/components/ui/DataGrid.test.tsx src/components/ui/operations/InlineStatusSummary.test.tsx` → exit0, 3files/35PASS/0FAIL/0SKIP, 2.88초. `task-2-existing-green.log`.
- 위 로그에 warning/error/실패 없음. `git diff --check` exit0.
- whole Web/type/UI/build/E2E/Lab/canonical/HIL 미실행; 최종 통합 검증은 Task11 한 번의 범위다. 실제 pixel/geometry/default paint는 후속 browser 검증이며 단위 class assertion을 시각 일치 증거로 확대하지 않는다.

## concerns

- API 소비는 후속 메뉴 담당이 명시적으로 선택해야 한다. 일반 Heading을 customer provider 유무로 자동 치환하지 않는다.
- DataGrid customer compact 분기와 plain/bare 표현은 원본 owner를 그대로 소비한다. CSS geometry/portal·dark 대비·실제 pointer hit는 Task11에서 확인한다.
- root 계획/ledger/project-status, palette/token/root aliases, API/DB/실장비/기존 서버는 변경하지 않았다.
