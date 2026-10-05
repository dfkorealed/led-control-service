# 운영 UI 추가 주석 14건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 주석 14건을 수정하고 검색 외 필터·목록 Grid·지도 기반을 공통화하여 검증 후 별도 브랜치를 병합한다.

**Architecture:** 기존 React Aria와 공통 UI에 호환 가능한 표시 계약을 먼저 추가하고 페이지별 조회·명령·편집 상태는 소비자가 소유한다. 지도는 카메라·좌표·툴바만 공유하며 읽기/선택/편집 정책은 합치지 않는다. 알람 개인 숨김은 읽음과 독립된 저장 모델 및 영속된 전체 대상 snapshot을 사용한다.

**Tech Stack:** React 18, TypeScript, React Aria Components 1.21.1, 기존 Tailwind 토큰, NestJS, Prisma 6.19.3, PostgreSQL 16, Vitest/Jest/Playwright, Node 22, pnpm 9.15.0.

**Spec:** [승인된 설계 명세](../specs/2026-10-04-operations-ui-refinement-design.md), 제품 기준 `32e7a45aa114c19111b252cdcf32a13375099067`.

## Global Constraints

- 작업 공간은 `/Users/kim-jh/Documents/led-control-service/.worktrees/operations-ui-refinement-20261004`, 브랜치는 `codex/operations-ui-refinement-20261004`다. 채팅 cwd의 옛 비 Git 폴더에 쓰지 않는다. 기본 checkout·실행 중 서비스·사용자 DB·Gateway/센서/broker는 Task 10의 승인된 반영 전까지 불변이다.
- “검색 입력은 외부에 항상 노출한다. 검색이 없는 화면에 가짜 검색을 추가하지 않는다.” 검색 외 목록/조회 조건은 필터 아이콘 Popover로 이동한다. 편집 폼·현장/맵/제어 유형·페이지 이동은 주요 조작으로 남긴다.
- “필터 적용 시점은 기존 소비자의 정책을 유지한다.” 열기/닫기는 조회·저장·새 적용 단계를 만들지 않는다. 부분 날짜/오류·debounce·URL·cursor·조회 유효성을 보존한다. 잘못된 조건의 조회/보고서/CSV 요청은 0이다.
- “헤더 기본값은 중앙 정렬. body는 이름/설명 왼쪽, 수치 오른쪽, 상태/행동 가운데처럼 컬럼별로 별도 지정한다.” 실제 컨테이너 폭으로 표/카드를 전환한다. HTML table/caption/TH를 사용하고 미지원 ARIA grid를 선언하지 않는다.
- “문서와 표/카드 내부 모두 가로 스크롤 0이다.” overflow-hidden으로 데이터/행동을 잘라 통과시키지 않는다. 일반 조작 hit ≥44×44px, 이웃 hit 중첩 0, 운영 마커의 기존 48px와 편집 hit 여유 22px를 축소하지 않는다.
- 지도 드래그 경계 8 CSS px·터치 hold 400ms, 운영 상대 줌 0.1~4, 편집 절대 줌 0.001~4·자동 fit 상한 2를 유지한다. 최초 자동 fit과 사용자 camera를 구분한다. 사용자 camera 이후 fit/reset은 명시적 조작만 수행한다.
- “표시를 단순화한다고 retry/timeout/retention 정책을 변경하지 않는다.” 완료 outcome 3종과 pending/unknown/확인 필요를 분리한다. resize/필터/상세 닫기/복귀로 UUID·frozen targets 변경, 명령 잠금 해제, 추가 제어 POST가 발생하면 불합격이다.
- 개인 알람 숨김은 현재 계정·선택 현장만 대상으로 한다. 원본/다른 계정/읽음/resolve/revision/운영 activeCount 불변이다. 전체 지우기는 페이지·필터 밖을 포함하며 최초 영속 snapshot 이후 새 알람을 포함하지 않는다. 동일키 재시도는 같은 집합만 사용한다.
- 폭 320/390/768/1023/1024/1287/1440, 짧은 390×320·1440×600, 실제 브라우저 200%에서 장문/빈/로딩/오류·실제 입력을 검증한다. native WebView·HIL·현재 로컬 DB 적용을 합성/임시 DB 증거로 주장하지 않는다.
- 하나의 checkout에서 제품 작성자·공유 build/root gate·브라우저 Lab은 한 번에 하나다. 기존 담당 세션을 재사용하고 구현자의 추가 에이전트·자체 중복 검토를 금지한다. 공유 변경은 단독 생산자 커밋과 독립 요구/품질 검토 뒤 소비자에게 넘긴다.
- 변경 메뉴 문서를 같은 구현 작업에서 갱신하고 DB 변경은 `docs/database-schema.md`에 반영한다. 원 실패/skip/제외 및 이전 22건의 완료 이력은 보존한다. 기록된 옛 테스트 수를 새 소스의 전체 통과 수로 재사용하지 않는다.
- 기존 별도 센서·Figma/모바일 시안 작업, PKI/TLS, 감사 정책, 기존 migration checksum을 수정하지 않는다. DB 초기화·기존 데이터 삭제·기존 migration 재적용·원격 push·배포는 범위 밖이다.

## Review Focus

1. 같은 키로 A→B→A 현장/계정을 왕복한 뒤 늦은 날짜 callback이 돌아오는 경우: 원 A의 초안이 새 A를 덮어쓰지 않는다. Task 1/5/6/7의 scope epoch 시험으로 고정한다.
2. 전체 알람 snapshot 저장 후 네트워크/SQL 실패 및 과거 openedAt으로 늦게 commit한 새 알람: 같은 요청키는 저장된 집합만 재사용한다. Task 3/4의 실패 주입·두 연결 시험으로 고정한다.
3. 행 더보기/달력이 열린 채 표↔카드 전환 또는 행 삭제·scope 변경: overlay를 올바르게 닫고 살아 있는 관련 트리거/목록으로 복귀하며 다른 화면의 초점을 빼앗지 않는다. Task 1/6/7/8 시험으로 고정한다.
4. viewer·현장 없음·capability 오류·설정 lazy 실패와 dirty/명령 잠금의 조합: 단일 로그아웃 owner와 계정 탈출을 유지한다. Task 4 시험으로 고정한다.
5. 짧은 높이에서 summary 이동/inline 상세 펼침 후 지도 footer·범례가 밀리는 경우: 실제 bounds와 끝 항목 입력으로 검증하며 카메라를 강제 초기화하지 않는다. Task 2/5/6/9 시험으로 고정한다.

---

## 상태·실행 방식·파일 소유

- 최신 checkpoint(2026-10-05 16:43:40 UTC): R47 focused8GREEN/ONE실제second1PASS의7원본을 rootDIRECT 승인했고16:41:53 독립644소스/7원SHA-lossless/4artifact/정리 issues0을 확인했다. ONLYSurface9d285/helper0f9507/Flow56619b/dateFilter제품 불변. SAME writer finalmenu/selfreview/consumercommit→freshTask7package47385..HEAD gate 순서로 진행한다. 장문 filter-area photos/full44matrix/nativeHIL 미인증·원FAIL/89시점 한계 보존. Tasks8–10·병합 아직이다.

- 최신 checkpoint(2026-10-05 16:27UTC): R46 second Surface1FAIL의 guard는 literal aria-label/공개 접근성 이름 혼동이다. FULLreport369–401/5원본 직접 검수·644소스/원response/정리 독립 대조 완료, 후속 보고서 입력/POST/CSV는 미실행. Ruling47으로 SAME writer의 기존 Surface 시험 한 파일만 semantic guard와 원trigger 즉시 centered-scroll/실제unoccluded44 검증을 보완한다. FocusedREDGREEN/freeze→ONE 원second→모든새원PNG rootDIRECT 후 소비자commit/독립gate; 제품/helper/Flow/date/Filter/launch/입력·기준 불변. Tasks8–10·병합 미완료.

- 최신 checkpoint(2026-10-05 16:09:22UTC): R46 first PRIMARY 실제200% Flow1PASS와 원PNG41733B1440×813/닫힌보고서필터·초점을 root직접 승인했다. FULLreport321–EOF/29GREEN/type0 및 독립644소스·원response/4artifactSHA/자기정리를 대조했다. 같은 원secondSurface/모든원본 개별시각검수만 재개하며 helper/date/Filter/제품/launch/원입력·기준 동결이다. Universalpaint/fullmatrix/HIL/최종Task7/8–10·병합은 아직이며 consumercommit 전 second원본rootgate가 필요하다.

- 날짜 producer fix `6c3af085`(8cf3 기준 정확3파일250+/31−)의 원자료/77사전해시/커밋 일치·295후test-only2추가→29·physical12/타입UI0·자기자원0/idle를 확인해 fresh scoped 요구/품질 gate를 배정했다. cold8/20→28/consumed-key/ref·no-op·reset 수명 요구를 함께 검토한다. Gate 전 native200/소비자commit/다음페이지/병합을 진행하지 않는다.

- Ruling41(12:50UTC): fresh 아키텍처 검토의 공개 render/span/ref 계약을 확인해 같은 세 producer 파일의 range-only 키 완료를 공급 public DOM handler 정상 반환 뒤 정확 token에만 합성하도록 원writer 재개했다. 원23/2실패 및 새 no-op/repeat/reset/cleanup/ref 증거·기존 affected/physical 검증, 별도 fixcommit/fresh gate 필요. Private API/타이머/새경로/이벤트취소는 없으며 실제200·최종통계/설정/QA/병합은 아직이다. 이유·오판비용은 ledger와 producer brief에 기록했다.

- 진행 체크포인트(12:45UTC): R40 첫 검증23중21PASS/Backspace2FAIL, 완료 아님. 원writer는 제품 재시도·commit 없이 중단/진단 계측 제거·자기16627 종료를 보고했다. Exact RAC1.21.1 DateSegment 공개 target 핸들러 결합 순서를 읽기 전용 아키텍처 검토로 확인한 뒤만 같은 세 파일 보완을 재개한다. Consumer freeze/실제200 첫 원PNG·Task7 최종gate/Tasks8–10·병합은 남아 있다.

- [x] 사용자 주석 14건 및 공통화 범위 확인, 6개 기존 담당 세션 준비 검토 회수.
- [x] 별도 브랜치·격리 작업 공간 준비, 서면 명세 승인 회수.
- [x] 이 구현 계획 검토·승인 회수: 2026-10-05 사용자의 “진행해줘”로 승인됐다.
- [x] 개인 숨김용 신규 additive DDL과 마지막 로컬 서버 반영의 명시적 승인 회수: 새 두 테이블 추가·Web/API 잠시 중지/재시작을 함께 설명한 확인에 2026-10-05 사용자가 승인했다. 이전 읽음 테이블 승인으로 대체하지 않는다.

현재 실행: Task1~7의 각 독립 검토 및 scoped 보완 gate는 완료했다. Task8은 기존 설정 담당자가 사용자/CAD 공통 UI를 적용한 뒤 320×740 편집 작업 영역0px와 실제200% 사진의 의도 내용 누락을 발견해 최소 수정 범위를 판정 중이다. Whole Web71FAIL/CAD66미수집은 별도 모듈 초기화 조사 대상으로 보존한다. 각 과거 시험과 후속 covering의 소스/시점을 구분하며 Tasks9~10 최종 통합검수·사용자 DB/서버 반영·기본 병합은 미실행이다.

Task7 추가 상태(2026-10-05 12:17UTC): 공유 FilterPanel `841a714d`와 날짜 `8cf3a728`의 당시 scoped gate는 승인됐다. 후속 consumer153PASS/타입0·selected mock79PASS1FAIL은 원로그로 유지하며 새 전체 통과가 아니다. 마지막 original101행 기간 입력에서 cold 첫 start-day8이 자동 초점 이동 전 publication되지 않고 복원에 지워지는 genuine producer counterexample를 독립1FAIL1PASS 및 public native timeline로 확인했다. 세 cause/다섯 variant 뒤 추가 가드 시도를 멈추고 Ruling39의 read-only GPT6Astra high 아키텍처 검토로 pending-edit/publication/hydration 계약을 먼저 확정한다. 원 입력순서·1~3·impossible20 보호·clear1/calendar/readonly/publicAPI/기준을 유지하며 정확 producer fix·새 독립 gate와 첫 실제200 PNG가 필요하다. 아직 Task7 최종/8–10·병합/사용자 환경 반영 완료가 아니다.

아키텍처 checkpoint 회수(12:23UTC): exact locked 두 module/map의 공개 setter→focus 순서와 partial/complete publication 경계가 수명 분리 설계를 뒷받침했다. Root가 FULL 보고를 읽고 Ruling40으로 같은3파일의 pending/accepted/restoration 보완을 원writer에게 재개했다. Native blur fence 유지·hydration만미저장edit와분리·기존두발행경로의동기ack, 명시적post-handler commit/no-op/reset/remount/cleanup proof를요구한다. 표현불가면named context반환/추가guard0, 정확3fixcommit·freshgate 전native/다음소비자0. Recommendation은실행통과가아니다.

Task 1의 이전 중간 기록: 설치/격리 Prisma/준비 완료, 원 baseline exit 1과 CAD spool·bulk-map·Gateway 분석 CLI의 기존 실패를 보존했다. 원 소스 단독 확인은 각각 8/8·7/7·24/24 PASS이며 전체 baseline 통과로 치환하지 않는다. 당시 UI RED 26실패/20통과와 공통 UI 부분 수정본을 남겼고 GREEN/커밋은 아직 없었다. 담당 세션 압축 뒤 범위 이탈은 작성권 회수·보고/idle 감사로 정리했으며, 기본 checkout/서버/DB/장비 변경은 없었다. 기존 담당에게 정확한 brief/인계 보고로 작성권을 다시 배정했고 이후 완료/보완 결과는 Task 1 하단에 기록했다. 디자이너의 읽기 전용 검수 방법 준비는 실제 Task 9 화면 검증과 구분한다.

실행 방식은 사용자가 지정한 **기존 페이지 담당 세션 분담**이다. 총괄은 상태·계획·ledger와 결과만 집계한다. 각 Task는 원래 담당자에게 같은 brief/BASE/보고서 경로로 순차 전달한다. 독립 task review는 별도 읽기 전용 검토자, 화면 검수는 기존 UI/UX 디자이너, 최종 whole-branch review는 가장 강한 가용 모델의 새 검토자에게 맡긴다. 각 검토는 요구 충족과 품질 두 판정이 필요하다.

| Task | 단독 담당 | 생산/소비 파일의 책임 |
| --- | --- | --- |
| 1 | Shell·인증·운영 담당자 | `components/ui`: 필터·날짜 초안·페이지 크기·Grid·행 메뉴. 호환 생산자 |
| 2 | 설정 페이지 담당자 | `features/floor-map` 순수 기하, `components/ui/maps` 툴바, 편집기의 adapter. 지도 생산자 |
| 3 | 원 자료를 이어받는 내부 Backend 담당자 | `apps/api` 개인 숨김 모델/API·인가/멱등·DB 문서. Backend 생산자 |
| 4 | 원 자료를 이어받는 내부 Shell 담당자 | Shell의 header/account·알람 API/hook/센터, 운영자 Grid 소비 |
| 5 | 원 모니터링 자료/WIP를 이어받는 내부 담당자 | `features/monitoring`: 높이·현장/맵 요약 구분·로그 필터 |
| 6 | 원 제어 자료/WIP를 이어받는 별도 내부 GPT6.1 Sol high 담당자 | 수동 결과/지도/이력·스케줄/이벤트의 공통 표시 소비. 기존 센서 세션 보호 |
| 7 | 통계 페이지 담당자 | 개요/분석/히트맵/보고서 필터와 보고서 Grid 소비 |
| 7 인계 | 원 통계 4시험 WIP를 이어받는 내부 GPT6.1 Sol high | native 압축 뒤 과거 PDF 업무 이탈의 단독 복구, 같은 consumer 소유/BASE 유지 |
| 8 | 설정 페이지 담당자 | 사용자 Grid/필터·CAD 후보 목록 페이지 크기 소비 |
| 9 | QA 역할 + UI/UX 디자이너 | 최종 root/임시 DB·브라우저·14건 화면 검수. 읽기 전용 판정 |
| 10 | 총괄 + 단독 통합 역할 | 신규 DDL 로컬 반영·브랜치 병합·runtime 인계·문서 완료 |

공유 파일은 지정 Task 이후 다음 writer가 임의로 수정하지 않는다. 소비 중 계약 부족이 입증되면 총괄이 해당 생산자에게 좁게 되돌린다. `CustomerShell`/`SettingsShell`은 Task 4가 변경하며 Task 5/8이 복제 owner를 만들지 않는다.

### Task 1: 호환 가능한 공통 필터·날짜 초안·Grid 생산자

**Files:** 수정 `apps/web/src/components/ui/FilterPanel.tsx`, `DataTableShell.tsx`, `PaginationBar.tsx`, `index.ts`, `date/DatePicker.tsx`, `date/DateRangePicker.tsx`, `date/date-field.tsx`; 생성 같은 UI 폴더의 `DataGrid.tsx`, `DataTableHeaderCell.tsx`, `RowActions.tsx`, `PageSizeSelect.tsx`, `date/useDateDraft.ts`, `date/useDateRangeDraft.ts`. 각 변경/생성 파일의 인접 `.test.tsx`에서 직접 검증한다. 기존 공통 필드/overlay 회귀를 보존한다.

**Interfaces:** 기존 FilterPanel의 label/children/chips/actions/className을 유지하고 아래 표시 계약을 추가한다. query/reset/조건 수는 소비자 소유다.

```ts
interface FilterPanelProps {
  label: string; children: ReactNode;
  chips?: ReactNode; actions?: ReactNode; className?: string;
  mode?: "inline" | "popover"; // 기본 inline
  variant?: "default" | "compact";
  search?: ReactNode; activeFilterCount?: number;
  summary?: ReactNode; filterReset?: ReactNode;
  isOpen?: boolean; onOpenChange?(open: boolean): void;
  isDisabled?: boolean; isDismissDisabled?: boolean;
};
type DateSegmentDraft = Readonly<{ year: number | null; month: number | null; day: number | null }>;
type DateRangeDraft = Readonly<{ start: DateSegmentDraft; end: DateSegmentDraft }>;
interface DateDraftController { draft: DateSegmentDraft; onDraftChange(draft: DateSegmentDraft): void; reset(value: string | null): void }
interface DateRangeDraftController { draft: DateRangeDraft; onDraftChange(draft: DateRangeDraft): void; reset(value: DateRangeValue | null): void }
useDateDraft(scopeKey: string, initialValue: string | null): DateDraftController;
useDateRangeDraft(scopeKey: string, initialValue: DateRangeValue | null): DateRangeDraftController;
// DatePicker / DateRangePicker props에 각각 선택적 draftController 추가.
type DataGridAlign = "left" | "center" | "right";
type DataGridSurface = "table" | "card";
interface DataGridColumn<T> { id: string; header: string; minWidth: number; align?: DataGridAlign; renderCell(row: T, surface: DataGridSurface): ReactNode }
interface DataGridProps<T> { caption: string; rows: readonly T[]; columns: readonly DataGridColumn<T>[]; getRowKey(row: T): string | number; isBusy?: boolean; emptyState?: ReactNode; variant?: "default" | "compact"; className?: string }
DataGrid<T>(props: DataGridProps<T>): ReactElement;
DataTableHeaderCell(props: ThHTMLAttributes<HTMLTableCellElement> & { align?: DataGridAlign }): ReactElement;
RowActions<K extends MenuKey>(props: Omit<DropdownMenuProps<K>, "label" | "triggerIcon"> & { rowLabel: string; ref?: Ref<HTMLButtonElement> }): ReactElement;
PageSizeSelect<T extends PaginationPageSize>(props: { value: NoInfer<T>; options: readonly T[]; onChange(value: NoInfer<T>): void; isDisabled?: boolean; className?: string }): ReactElement;
// PaginationBar: showPageSizeSelector?: boolean 기본 true.
// DataTableShell: layout?: "legacy" | "fluid" 기본 legacy; DataGrid만 fluid.
```

Popover는 기존 React Aria/RegisteredPopoverContent를 사용한다. `summary ?? chips`는 한 번만 표시한다. 내부 상세/닫기/초기화는 짧은 높이에서도 도달 가능하다. draft hook은 overlay 밖에 두고 공개 DateFieldStateContext의 segments/setSegment/clearSegment로 저장/복원한다. null segment는 미입력이며 복원 중 domain onChange를 억제한다. scope epoch를 사용하여 A→B→A의 옛 callback도 거부하고 URL/명시적 reset 외에 부분 초안을 덮어쓰지 않는다.

Grid는 실제 content width를 ResizeObserver로 측정한다. 미측정/0폭은 cards, `width >= sum(columns.minWidth)`이면 table이며 행 작업도 폭 계산에 포함한다. header center/body left 기본, body align은 컬럼별이다. 변경되지 않은 raw DataTableShell 소비자는 다음 담당 Task까지 legacy 호환이며 최종에 모두 이관한다. RowActions는 기존 typed DropdownMenu+Ellipsis와 ref를 재사용하고 확인/권한을 소유하지 않는다. PageSizeSelect의 허용 값은 10/20/50/100/500/1000, 기본 Pagination 옵션은 10/20/50/100이다. 빈/중복/집합 밖 options 또는 value 불일치는 RangeError, 숨김 상태에도 검증한다.

- [x] **Setup 1:** 이 checkout의 Git identity·Node22/pnpm9.15 및 Prisma 생성 출력 경로가 격리 범위 안인지 확인한다. 다른 checkout의 node_modules symlink를 재사용하지 않는다.
- [x] **Setup 2:** `pnpm install --frozen-lockfile`을 이 checkout에서 실행한다. lockfile 변경 0이어야 한다.
- [x] **Setup 3:** 이 checkout에서 `pnpm --filter @led-control/api prisma:generate`를 실행한다. 현재 기본 폴더의 client는 수정하지 않는다.
- [x] **Setup 4:** `pnpm workspace:prepare`로 leaf 검증의 의존 build를 준비한다.
- [x] **Setup 5:** canonical `pnpm test` baseline의 실제 실패/skip을 기록한다. 실패하면 작업 원인과 기존 원인을 먼저 분리한다.
- [x] **Step 1:** RED `legacy filter panel remains inline`, `restoring a draft emits no domain change`, `drops stale draft writes across A B A scopes`, `container width selects cards independently of viewport`, `row actions preserve numeric keys and focus`, `removed row trigger closes menu without stealing new scope focus`를 작성한다. 검색 reset 보존·placeholder 미저장·부분 연/월/일/오류·0폭→넓은 폭·column 누락0·numeric key 0/문자열 "0" 구분을 단언한다. 새 초안 hook의 핵심 stale 단언은 다음과 같다.

```ts
const { result, rerender } = renderHook(({ scope }) => useDateDraft(scope, null), { initialProps: { scope: "A" } });
const staleWrite = result.current.onDraftChange;
rerender({ scope: "B" }); rerender({ scope: "A" });
act(() => staleWrite({ year: 2055, month: null, day: 15 }));
expect(result.current.draft).toEqual({ year: null, month: null, day: null });
```

- [x] **Step 2:** `pnpm --filter @led-control/web exec vitest run src/components/ui/FilterPanel.test.tsx src/components/ui/DataGrid.test.tsx src/components/ui/date/useDateDraft.test.tsx src/components/ui/date/useDateRangeDraft.test.tsx src/components/ui/RowActions.test.tsx`로 의도한 RED를 확인한다.
- [x] **Step 3:** 위 API와 공개 segment bridge를 최소 구현한다. UI wrapper가 query/validation/reset 정책을 갖지 않게 한다.
- [x] **Step 4:** 인접 전체 시험·web typecheck·UI policy를 GREEN 확인한다. 부분 날짜 close/reopen·resize, nested Escape/Back·닫힌 overlay 등록0, page-size generic 호환, header/body 정렬을 검증한다.
- [x] **Step 5:** 소유 파일만 `feat(ui): add shared filter and responsive grid contracts`로 커밋하고 BASE/HEAD·원 RED/GREEN 로그·우려를 보고한다. 독립 task spec/quality 승인 뒤 Task 2로 넘긴다.

Task 1 완료: 구현 `8962da09`와 I1 보완 `04765c7d`, 원 task review+scoped 재검토 승인(ADDRESSED/새 지적0). 원 구현 Web3060PASS/기존3skip·타입/빌드0·UI0·정책67PASS와 보완 후 날짜86PASS·타입/UI0를 구분한다. canonical 원 baseline은 UI 전 기존3실패/exit1이며 원 소스 focused8/7/24PASS만 확인했다. inherited warning·실제browser·downstream·freshfullgates는 최종 검수에 유지하고 이전 수치로 대체하지 않는다.

### Task 2: 공통 지도 기하·툴바와 편집 adapter

**Files:** 생성 `apps/web/src/features/floor-map/map-camera-geometry.ts`와 `.test.ts`, `apps/web/src/components/ui/maps/MapCameraControls.tsx`와 `.test.tsx`; 수정 `features/floor-map/FloorMapViewport.tsx`, `features/floor-editor/geometry.ts`, `FloorEditorCanvas.tsx`, `FloorEditorView.tsx`, `use-map-editor.ts`의 해당 순수 변환 소비와 인접 시험, `docs/menus/settings.md`. renderer 소유는 기존 `features/map-scene/MapSceneCanvas.tsx` 그대로다.

**Interfaces:** 기존 `map-gestures.ts`의 MapPoint/MapSize/MapRect(left/top/width/height), CadSceneCamera를 소비한다. editor의 x/y rect는 adapter에서 변환한다.

```ts
type MapTransform = { pan: MapPoint; zoom: number }; // 실제 world→screen 배율
cameraFromTransform(transform: MapTransform, viewport: MapSize): CadSceneCamera | null;
transformFromCamera(camera: CadSceneCamera): MapTransform | null;
screenToMapWorld(point: MapPoint, transform: MapTransform): MapPoint;
mapWorldToScreen(point: MapPoint, transform: MapTransform): MapPoint;
mapViewportBounds(transform: MapTransform, viewport: MapSize): MapRect;
fitMapTransform(input: { bounds: MapRect; viewport: MapSize; padding: number; minZoom: number; maxZoom: number }): MapTransform | null;
interface MapCameraControlsProps { zoomPercent: number; onZoomIn(): void; onZoomOut(): void; onResetZoom(): void; onFit(): void; onFitSelection?(): void; isDisabled?: boolean; canZoomIn?: boolean; canZoomOut?: boolean; fitLabel?: string; className?: string }
MapCameraControls(props: MapCameraControlsProps): ReactElement;
```

미측정/비유효 viewport의 camera/fit은 null로 대기한다. 운영 relative zoom은 fitScale와 합성해 순수 변환에 넣고 저장된 center ratio는 기존 camera adapter가 소유한다. editor의 기존 100% reset과 fit(false/true)는 별개 callback으로 유지한다. MapCameraControls는 store를 읽지 않으며 undo/redo/save/패널은 기존 툴바에 남긴다. 공통 기하를 실제 운영·편집 camera/좌표 경로 양쪽에서 소비하여 이름만 공통인 복제를 만들지 않는다.

- [x] **Step 1:** RED `round trips physical transforms without changing relative camera`, `unmeasured viewport waits without resetting user camera`, `reset zoom is distinct from fit`를 작성한다. world↔screen 왕복, editor/운영 배율 경계, callback별 1회 호출·다른 행동0을 단언한다.

```ts
expect(screenToMapWorld({ x: 50, y: 70 }, { pan: { x: 10, y: 10 }, zoom: 2 })).toEqual({ x: 20, y: 30 });
expect(cameraFromTransform({ pan: { x: 0, y: 0 }, zoom: 1 }, { width: 0, height: 0 })).toBeNull();
```
- [x] **Step 2:** `pnpm --filter @led-control/web exec vitest run src/features/floor-map/map-camera-geometry.test.ts src/components/ui/maps/MapCameraControls.test.tsx`의 RED를 확인한다.
- [x] **Step 3:** 순수 변환/표시 기반과 기존 export 호환 adapter를 구현한다. pointer policy·hit-test 순서·lease/undo/revision/CAD/ACK를 변경하지 않는다. 기존 공통 문서 더블클릭 첫 hit 후속은 이번 변경으로 고쳤다고 주장하지 않는다.
- [x] **Step 4:** 위 시험과 FloorMapViewport/편집 기하·canvas·use-map-editor 회귀, web typecheck/UI를 GREEN으로 확인한다. cold/warm 원 1000대 정확 ID·픽셀·X50·저장·실제시계 `<8000ms`는 Task 9에서도 원본 기준을 유지한다.
- [x] **Step 5:** settings 메뉴에 실제 공유 범위/한계를 기록한다.
- [x] **Step 6:** `refactor(map): share camera geometry and controls`로 소유 파일을 커밋 후 독립 검토받는다. 운영/제어 소비자 작성권은 아직 주지 않는다.

Task 2 완료 `7d13ba95`, 독립Spec✅/qualityApproved·Critical0/Important0. 최종56파일819PASS/0skip·type/UI0와 소스 불변 추가wholeWeb3087PASS/0FAIL/기존3skip/63.60s/exit0를 구분해 확인했다. 원1000/8초와 실제browser/200%는 미실행으로 Task9에 유지한다. 기존 예상경고는 최종 wholebranch 검토에 이관한다.

### Task 3: 개인 알람 숨김과 영속 전체 대상 snapshot

**Files:** 수정 `apps/api/prisma/schema.prisma`, `src/monitoring-incidents/monitoring-incidents.dto.ts`, `monitoring-incidents.controller.ts`, `monitoring-incidents.service.ts`, `monitoring-incidents.module.ts`와 인접 unit/integration 시험; 생성 `src/monitoring-incidents/monitoring-incident-dismissal.service.ts`, `.spec.ts`, `.integration.spec.ts`, `monitoring-incident-personal-access.ts`와 `.spec.ts`, `prisma/migrations/20261004100000_monitoring_incident_dismissals/migration.sql`; 갱신 `docs/database-schema.md`, `docs/menus/monitoring.md`의 Backend 범위.

**Interfaces:** 읽음 모델은 변경하지 않는다. 새 모델 `MonitoringIncidentDismissal(incidentId:String,userId:String,dismissedAt:DateTime)`은 PK(incidentId,userId), userId index, incident/User Cascade다. `MonitoringIncidentDismissalRequest(siteId:String,userId:String,clientRequestId:String @db.Uuid,snapshotAt:DateTime,targetIncidentIds:String[],dismissedCount:Int?,completedAt:DateTime?)`는 PK(siteId,userId,clientRequestId), userId index, Site/User Cascade다. UTC 시각·NOT NULL snapshot/target array·pending(null count/completedAt) 또는 completed(nonnull completedAt/nonnegative count) shape를 SQL CHECK로 검증한다. 완료 분기에는 count IS NOT NULL도 명시하여 SQL의 NULL CHECK 통과를 막는다. 독립 TTL은 없으며 부모 수명까지 보관한다.

```ts
PUT /sites/:siteId/monitoring-incidents/:incidentId/dismiss
  body: {} // strict
  response: { incidentId: string; isDismissed: true; dismissedAt: string }
POST /sites/:siteId/monitoring-incidents/dismiss-all
  body: { clientRequestId: string } // strict UUID
  response: { siteId: string; clientRequestId: string; snapshotAt: string; dismissedCount: number }
GET /sites/:siteId/monitoring-incidents?view=all|personal
  // 기본 all, 기존 limit/status/type 유지.
  // 행에 isDismissed:boolean과 dismissedAt:string|null 추가.
```

DTO 파일에서 `DismissIncidentResponse = { incidentId: string; isDismissed: true; dismissedAt: string }`와 `DismissAllIncidentsResponse = { siteId: string; clientRequestId: string; snapshotAt: string; dismissedCount: number }`를 정의한다. 서비스는 `dismiss(user: AuthenticatedUser, siteId: string, incidentId: string): Promise<DismissIncidentResponse>`와 `dismissAll(user: AuthenticatedUser, siteId: string, input: unknown): Promise<DismissAllIncidentsResponse>`를 공개한다. 기존 actor/site advisory→Site→User/Membership 순서와 트랜잭션 내 read access 재검증을 공유한다. viewer의 개인 조작은 허용하고 다른 actor/site·시각 주입은 strict DTO와 권한으로 거부한다.

인가 추출 함수는 `lockIncidentPersonalAccess(tx: Prisma.TransactionClient, user: AuthenticatedUser, siteId: string, access: SiteAccessService): Promise<void>`다. 이미 존재하는 `runSiteUserTransaction(prisma, callback, Prisma.TransactionIsolationLevel.ReadCommitted)` 안에서 호출한다. 기존 markRead와 새 서비스가 같은 함수를 소비하고 기존 gate의 3회 재시도/maxWait/timeout은 변경하지 않는다. `src/access/site-user-policy.ts` 자체는 수정하지 않는다.

bulk는 다음 두 단계로 처리한다.

1. ReadCommitted를 명시하고 인가·잠금 이후 한 materialized target SQL snapshot에서 미숨김 ID와 request key를 pending 행에 원자 저장해 commit한다. 아직 숨김 효과는 없으며 기존 key는 덮어쓰지 않는다.
2. 별도 트랜잭션에서 다시 인가·동일 순서로 잠금하고 request 행을 FOR UPDATE한다. 저장 ID 중 현재 같은 site에 존재하는 incident만 ON CONFLICT DO NOTHING으로 숨긴다. 실제 신규 insert 수와 completedAt을 같은 트랜잭션에서 저장한다.

pending 재시도는 원 ID 집합, completed 재시도는 저장 응답만 사용한다. 두 단계 사이의 인가 실패·삭제된 대상·다른 요청의 중복 숨김에도 예약을 삭제하거나 집합을 넓히지 않는다. freeze 자체가 rollback한 미수락 요청은 효과 0이며 **최초 durable reservation commit**이 수락 경계다. 효과 분할 commit·별도 worker/lease는 추가하지 않는다. snapshotAt은 설명용이고 createdAt/openedAt cutoff로 대체하지 않는다.

personal은 숨김 없는 목록/개인 미읽음 수, all은 기존 운용 목록/미읽음 의미다. activeCount는 두 view 모두 현장 전체다. cursor v2는 userId/siteId/view/status/type/active/openedAt/id에 묶고 v1은 all에서만 허용한다. read receipt·incident status/revision·기존 3개월 로그 보관에는 쓰지 않는다. 같은 ID 갱신은 숨김 유지, 새 ID 재발은 미읽음으로 표시한다. UTC/Asia/Seoul/America/New_York 연결에서 저장 시각을 확인하며 사용자 DB 시간대는 바꾸지 않는다.

- [x] **Step 1:** RED `dismiss never creates read receipts or changes incident revision`, `retry after frozen snapshot failure never includes later arrivals`, `late committing backdated incident remains visible`, `concurrent duplicate requests reuse one snapshot`을 작성한다. freeze 후 실패는 pending 예약 보존·효과/완료 0, 재시도는 원 ID만 처리한다고 단언한다. 단계 사이 권한 철회와 겹친 요청/삭제된 대상의 replay count도 고정한다.

기존 integration fixture의 viewer/siteId와 새 미읽음 incident를 사용한 핵심 단언은 다음과 같다.

```ts
await dismissalService.dismiss(viewer, siteId, incident.id);
expect(await prisma.monitoringIncidentReadReceipt.count({ where: { incidentId: incident.id, userId: viewer.id } })).toBe(0);
expect((await prisma.monitoringIncident.findUniqueOrThrow({ where: { id: incident.id } })).updatedAt).toEqual(before.updatedAt);
```
- [x] **Step 2:** API unit 및 자기 소유 disposable PostgreSQL 통합의 RED를 확인한다. `MONITORING_INCIDENTS_DISPOSABLE_TEST=1 pnpm --filter @led-control/api exec jest src/monitoring-incidents/monitoring-incident-dismissal.integration.spec.ts --runInBand`를 사용하며 외부 URL fallback은 금지한다.
- [x] **Step 3:** additive schema/SQL/API를 구현하고 이 checkout의 Prisma Client만 생성한다. 기존 migration 재작성/resolve/reset/사용자 DB 적용은 하지 않는다. 두 단계 각각 actor/membership를 재검증한다.
- [x] **Step 4:** unit/DTO·실제 PG의 전체 페이지/필터 밖/두 계정/두 현장·중간 실패/동일 key·shape CHECK/FK/index/cascade·세 시간대·cursor 거부를 GREEN으로 기록한다. 모든 migration deploy는 자신의 빈 임시 DB에서만 실행한다.
- [x] **Step 5:** DB/모니터링 문서에 모델·수락 경계·영속 ledger 증가와 운용 한계를 기록한다.
- [x] **Step 6:** `feat(api): persist account-scoped alarm dismissals`로 커밋하고 가장 강한 읽기 전용 리뷰에 넘긴다. 사용자 DB/서버는 아직 불변이다.

Task 3 완료 `9a7c82ec`: 실제PG18PASS/0skip·최종production source hash 일치, 단위84PASS/91opt-in skip·타입0이다. 기본 전체API3042PASS/877skip/exit0는 UUID 표기 보완 전이며 그 뒤 실제PG RED1→GREEN18·covering unit/type로 확인했다. 강한 독립 Spec✅/품질Approved·Critical0/Important0/Minor2를 회수했다. 원 실패/launcher 및 console/logger 경고는 최종 whole-branch 검토에 보존했고 임시cluster/명령 종료·소유15파일 clean을 확인했다. 웹 소비/브라우저/native/HIL·현재 사용자DB/서버 반영은 Task4/9/10의 미실행 범위이며 이 완료로 대체하지 않는다.

### Task 4: Shell 현장 헤더·설정 계정·알람 소비

**Files:** 생성 `apps/web/src/features/shells/CustomerHeaderSummarySlot.tsx`, `CustomerAccountContext.tsx`, `CustomerAccountPanel.tsx`, `CustomerRouteErrorBoundary.tsx`와 인접 시험; 수정 `CustomerShell.tsx`, `features/settings/SettingsShell.tsx`, `api/monitoring-incidents.ts`, `components/ui/session-status/useMonitoringIncidents.ts`, `SessionStatusCenter.tsx`와 기존 시험. 생성 `components/ui/session-status/monitoring-dismissal-request.ts`와 `.test.ts`는 요청키 저장만 담당한다. 공통 Grid 소비는 `features/operator/LandingInquiriesView.tsx`, `features/operator/site-admins/SiteAdminManagementView.tsx`와 해당 시험; 문서는 `docs/menus/{monitoring,settings,operator}.md`다. Step 4의 모의 browser 회귀 수정 범위는 `apps/web/e2e/{ui-overlays,app-shell-recovery,calm-operations-shell}.spec.ts`로 명시한다. `apps/web/src/App.test.tsx`의 새 헤더/설정 로그아웃 동선·strict personal 응답 fixture 호환과 `features/shells/CustomerShell.monitoring.test.tsx`의 personal URL 기대도 Task 4에 앞당겨 단독 소유를 부여한다. 명령 잠금/취소·복구/동일 요청·추가 POST 금지 assertion은 모두 유지하며 runtime/auth/제어 정책은 바꾸지 않는다. 다른 공통 fixture 파일은 정확한 경로/필요 변경을 총괄에게 확인한 뒤 소유를 추가한다.

**Interfaces:** Task 1/3을 소비한다. 헤더 값은 Shell의 기존 authorized dashboard query에서 직접 생산하고 자식 등록 context는 추가하지 않는다.

```ts
interface CustomerShellScope { principalKey: string; siteId: string; pathname: "/monitoring" }
type CustomerSiteSummary = { scope: CustomerShellScope; siteName: string; state: "loading" | "error" }
  | { scope: CustomerShellScope; siteName: string; state: "ready"; counts: { totalFixtures: number|null; onlineFixtures: number|null; faultFixtures: number|null; offlineFixtures: number|null } };
CustomerHeaderSummarySlot(props: { currentScope: CustomerShellScope; value: CustomerSiteSummary|null; className?: string }): ReactElement|null;
interface CustomerAccountContextValue { user: AuthUser; isLoggingOut: boolean; logoutError: string|null; requestLogout(returnFocusRef: RefObject<HTMLButtonElement|null>): void }
useCustomerAccount(): CustomerAccountContextValue;
// SettingsShellProps += accountSlot?: ReactNode.
```

현장 band는 `현장 전체`와 현장 이름을 표기하고 값/null/오류를 그대로 표현한다. 계정 panel은 eager이며 admin/viewer/no-site/loading/error/lazy 실패에서 제공한다. 기존 Shell logout controller만 사용하고 dirty 취소/실패 반환 ref·command block/unblock/cache를 유지한다. OperatorShell 인증/관리/MFA gate는 바꾸지 않는다.

총괄 Ruling: 실제 SettingsShell은 기존 lazy 경계를 유지한다. 계정 context/controller와 설정 경로의 단일 eager panel은 route Suspense/ErrorBoundary 바깥에서 살아 있고, 초기 권한/설치/no-site gate에도 계정 탈출을 제공한다. SettingsShell의 선택적 accountSlot 공개 계약은 유지·직접 검증하되 live Shell에서 동일 계정 panel을 중복 넣거나 lazy 본문이 panel 수명을 소유하게 하지 않는다. 모든 return 경로에서 provider/관련 확인·초점 controller를 유지하고 이 예외의 이유를 코드/메뉴 문서에 설명한다.

Task 4 중간 검증: 직접 covering 8파일152PASS/exit0, 타입/UI exit0다. 전체 Web을 한 번 실행한 결과는 3112PASS/12FAIL/기존3skip(223파일)로 보존한다. 기존 App의 헤더 로그아웃 동선·중복 현장 이름·strict 알람 fixture와 Shell monitoring의 personal URL 기대를 위 소유 범위에서 이관한다. 보완 후 직접 App/Shell covering만 재실행하고 마지막 fresh root는 Task 9에 유지한다. 모의 browser 9건 중 8PASS/1FAIL의 인증 요청3대4는 개발 StrictMode의 초기 observer 취소1개와 실제503응답3개가 혼합된 계수로 진단됐다. 최종 genuine StrictMode 시험은 초기 ERR_ABORTED1개가 첫503보다 앞선다는 조건과 전체 시작=완료응답+취소 관계를 별도로 단언하고, 기존 완료응답3회/수동복구후4회·keyboard/동일문서 복구를 유지한다. 합성 Fragment 진단은 원인 분리 증거일 뿐 최종 검증에 쓰지 않으며 auth/retry production은 바꾸지 않는다. 최종 보완 결과/원로그 감사는 아직이다.

Task 4 구현 반환 `38b6b3d1`: 최종 직접 10파일227PASS·타입/UI0·genuine StrictMode 선택browser9PASS다. 실제 Node22/exitmetadata·소유28파일/커밋·원로그를 대조했다. 최종 단위/타입의28hashes는 커밋과 전부 일치하며 browser/UI 이후 변경은 App 테스트의 지원하지 않는 옵션 제거뿐이다. 원 전체Web3112PASS/12FAIL/기존3skip과 중간 타입8오류/fixture 실패·wrapper transient hash 실패는 보존했다. 사용자DB/runtime/장비는 불변이고 자체 자원은 종료됐다. 독립 task Spec/quality는 아직 검토 중이므로 다음 소비자/완료 체크는 대기한다.

Task 4 독립 검토는 Spec❌/품질Needs fixes·Critical0/Important1/Minor2다. I1은 대·소문자 동등 UUID 저장키와 DB canonical bulk 응답의 strict 문자열 비교 불일치다. 같은 담당자에게 valid UUID 비교·원 저장키 재시도/정확한 제거/다른 키 보존의 좁은 RED→fix와 fallback의 “설정의 내 계정” 안내 보완만 배정했다. API의 siteId도 DB 예약의 canonical UUID를 반환하므로 같은 비교 계약을 확인한다. 새 요청키/target 확장·auth/제어/공유 producer 변경은 없다. 경고 지적은 최종 검토에 보존하며 원 전체Web 실패나 이전227/9 결과를 보완 소스의 fresh 전체통과로 재사용하지 않는다.

Task 4 fix round1 반환 `2ba94c06`: 실제 RED5/60PASS와 생산자 허용 UUID 형식 RED2/40PASS를 확인했다. 최종 covering6파일120PASS/0skip·타입/UI0·Node22/exitmetadata 및 커밋7파일 hashes 일치를 대조했다. 원 대문자 키로 실패/새로고침/명시적 재시도를 수행하고 성공 후 그 정확한 저장 항목만 제거하며 다른 철자/키/현장/설정을 보존한다. 오류 안내는 설정의 계정 위치를 명시한다. 새 브라우저/서버/전체Web/root 실행은 없고 기존 결과를 새 전체통과로 재사용하지 않는다. 좁은 재검토 결과는 아직 대기 중이다.

alarm API client에 `view`, strict 응답 parser 및 `dismissMonitoringIncident(siteId, incidentId, options)`/`dismissAllMonitoringIncidents(siteId, clientRequestId, options)`를 추가한다. hook/query key는 principal/site/personal/조건으로 묶는다. 실패/응답 불명에 낙관적 삭제는 없으며 성공 뒤 이전 scope 요청을 취소하고 첫 페이지/badge를 재조회한다. 화면에 실제 보인 항목만 읽음 처리한다. 전체 확인에는 페이지/필터 밖도 포함하는 선택 현장 범위를 알린다.

bulk UUID는 첫 POST **전에** 계정·현장별 브라우저 저장소에 기록하고, 성공 확인 전 재시도/재열기/새로고침에도 그대로 사용한다. 저장은 비밀/토큰/target IDs 없이 요청키만 기록한다. 복수 탭의 key 유실을 막도록 각 `(userId, siteId, clientRequestId)`를 독립 저장 항목으로 둔다. 남은 key는 명시적 결과 확인/재시도에서 각각 소비하고 자동 POST/새 key 교체를 금지한다. 저장 실패는 전체 지우기 POST 전에 안내하고 중지한다. 완료 key만 제거하고 다른 계정/현장의 key는 건드리지 않는다.

요청 저장 모듈의 공개 계약은 `DismissalRequestScope={userId:string;siteId:string}`, `listPendingDismissalRequestIds(scope, storage):readonly string[]`, `storePendingDismissalRequest(scope, clientRequestId, storage):void`, `removePendingDismissalRequest(scope, clientRequestId, storage):void`다. storage는 `Pick<Storage,"length"|"key"|"getItem"|"setItem"|"removeItem">`이며 UUID/scope/version을 검증한다. 사용자별 요청키는 숨김 실패 복구용이지 명령 recovery나 인증 storage와 합치지 않는다.

- [x] **Step 1:** RED `stale summary is rejected across scope transition`, `account escape remains available for viewer admin no site pending and lazy failure`, `dirty cancel preserves draft and logout failure restores initiating focus`, `bulk retry preserves request key across reload and ignores late scope responses`를 작성한다. 값의 거짓 0 치환·숨김의 읽음 변경·추가 제어 POST는 0, 실패 목록은 보존한다. 저장 실패 시 POST 0, 복수 pending key/다른 scope 보존도 단언한다. 운영자 Grid에는 넓은 window/좁은 container에서 cards와 모든 필드/권한 보존 시험을 추가한다.

```ts
const scope = { userId: "00000000-0000-4000-8000-000000000001", siteId: "00000000-0000-4000-8000-000000000002" };
const key = "00000000-0000-4000-8000-000000000003";
storePendingDismissalRequest(scope, key, localStorage);
expect(listPendingDismissalRequestIds(scope, localStorage)).toContain(key);
```
- [x] **Step 2:** 인접 Vitest에서 의도한 RED를 확인한다.
- [x] **Step 3:** 공개 계약과 기존 handler/overlay로 구현한다. 계정/ref는 route 오류에서도 owner 수명을 유지한다. 숨김은 서버 정본만 반영한다. 운영자 표는 DataGrid/중앙 헤더를 소비하며 조회·메일·관리 API는 그대로다.
- [x] **Step 4:** Shell/API/parser/hook/센터/설정/운영자 회귀·web typecheck/UI 및 격리 `ui-overlays.spec.ts`, `app-shell-recovery.spec.ts`, `calm-operations-shell.spec.ts`를 GREEN으로 기록한다. 명시적인 UI case만 선택하고 사용자 서버의 계정·알람은 조작하지 않는다.
- [x] **Step 5:** 영향 3개 메뉴를 실제 소유 변경과 일치하게 갱신한다.
- [x] **Step 6:** `feat(shell): unify site context account and alarm actions`로 소유 파일을 커밋 후 독립 검토받는다. Monitoring 본문 현장 요약 제거는 다음 Task 5의 소비 범위다.

Task 4 완료: `38b6b3d1`+`2ba94c06`, 원 task review의 I1/M1은 scoped 재검토 ADDRESSED·새Critical/Important/Minor0으로 닫혔다. 원 나머지 Spec✅ 판정과 합쳐 요구/품질 gate를 승인했다. 최종 보완 covering120PASS/타입/UI0는 이전227단위/9선택browser 및 원 전체Web12실패와 구분한다. 원 소스-only principal cache guard를 확인했고 전체폭/200%/실DB/현재runtime은 Task9/10에 명시 배정돼 있다. M2·기존 task의 launcher/color/schedule/Konva/fault-injection 경고는 최종 whole-branch triage에 남기며 무해/해결로 선언하지 않는다. 소유 소스clean/자체명령 종료를 확인하고 기존 모니터링 담당자에게 Task5만 넘긴다.

### Task 5: 모니터링 높이·맵 요약·로그 필터

**Files:** `apps/web/src/features/monitoring/{MonitoringView,FloorMap,MonitoringSummary,MonitoringLogDrawer}.tsx` 및 각 인접 시험, `apps/web/e2e/monitoring-surface-access.spec.ts`, `docs/menus/monitoring.md`.

**추가 소유(총괄 Ruling11):** `components/ui/overlays/DialogBase.tsx`와 기존 `overlays.test.tsx`의 stable dialog ref/공개 forwarded ref/중첩 초점 회귀만. Drawer 내부 날짜 초안 rerender의 실제 stack과 설치된 React Aria의 ref 의존 focus effect를 확인했다. 브라우저 통과로 실패한 단위 회귀를 삭제하지 않고 별도 공통 보완 커밋·직접 RED-GREEN·Task5 독립 검토를 거친다. 영향받는 `docs/menus/{monitoring,control,statistics,settings,operator}.md`에는 공통 초기초점 수명 보완·검증 한계만 함께 기록한다. 기존 디자인/pending/Back/safe-area/조회·명령 정책과 다른 공통 소스는 소유 범위 밖이다.

**추가 시험 소유(총괄 Ruling12):** `App.test.tsx:897`과 `CustomerShell.monitoring.test.tsx:102/116`의 네 실패 사례는 button→group 표시 selector만 이관한다. 원 존재/집계/상세/refresh POST/권한/명령 assertion은 유지하고 직접 두 파일을 확인한다. 원 전체Web4FAIL/3137PASS/3skip은 보존하며 반복하지 않는다. 다른 App/인증/제어 소스나 시험 의미는 변경하지 않는다.

**추가 소유(총괄 Ruling13 / fix round1):** 공통 `ui/session-status/{ToastRegion.tsx,session-status.test.tsx}`와 `features/shells/{CustomerShell.tsx,CustomerShell.monitoring.test.tsx}`의 알림 배치/높이 예약/짧은 모니터링 자연 스크롤 및 직접 회귀만 추가한다. `placement?: "overlay" | "flow"` 기본 overlay로 기존 소비자는 보존하고 CustomerShell은 sticky header 밖·content 앞에 단일 flow band를 소비한다. 실제 알림 높이를 정상 흐름으로 예약하고 표시 중 bounds/hit·복수 장문·전체보기/camera를 확인한다. 다른 공통 소스/더 넓은 구조가 필요하면 정확한 근거를 반환한다. Provider/타이머/알림·ARIA/읽음·숨김/권한/Back/pending/명령 정책은 변경하지 않는다. 영향 모니터링·제어·통계·설정 메뉴에 배치·검증 한계만 기록하며, I2 reset 검색 보존과 함께 covering/scoped 재검토하고 전체Web은 반복하지 않는다.

**시험 입력 보정(총괄 Ruling14 / 같은 fix round1):** native detail gutter의 옛 allocated ShellContent bottom45 기반 좌표는 실제 고정 header를 겨냥했다(events=[]·wheel 이전 실패). detail의 실제 보이는 중간 높이에서 문서 배경 여백을 elementFromPoint로 확인하고 header/nav/map/detail/dialog/interactive를 제외한다. 원 wheel80→문서 끝·내부 입력 page 고정·전체 마지막 의미 행·breakpoint scroll/camera/focus·POST0 단언은 모두 유지하며 새 실제 좌표/target/events를 기록한다. 제품 CSS·programmatic scroll/focus·threshold 완화는 하지 않는다.

**Interfaces:** Task 1의 FilterPanel mode=popover/PageSizeSelect/DateRangeDraft, Task 2의 FloorMapViewport/MapCameraControls, Task 4의 Shell 소유 헤더를 소비한다. FloorMap camera/reset/policy callbacks의 기존 타입/뜻을 유지한다. MonitoringSummary의 site 사용만 제거하고 선택 맵의 filter/onSelect·null 표현은 유지한다.

- [x] **Reproduction 1:** 격리 fixture의 1287×1226/390×320/1440×600에서 Shell→Monitoring→frame→viewport→surface→footer/범례의 실제 bounds/scrollHeight를 기록했다. 이 원 fixture에서는 viewport 잘림이 재현되지 않아 높이 CSS를 억지로 변경하지 않았다. 짧은 화면의 자연스러운 세로 스크롤과 확대 도면 부분 표시를 구분했다.
- [x] **Step 1:** RED `map footer remains reachable without resetting camera after header relocation`, `log filter close preserves partial dates and scoped cursor`를 추가한다.

browser의 가로 넘침 단언은 아래와 같으며, 별도로 footer/범례의 실제 bounds와 입력 접근을 검증한다.

```ts
expect(await page.locator("html").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
```
- [x] **Step 2:** `pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/monitoring/MonitoringLogDrawer.test.tsx`와 표적 browser RED를 확인한다. 확대 surface의 정상 부분 표시를 viewport 잘림으로 오판하지 않는다.
- [x] **Step 3:** 입증된 높이/overflow 경계만 수정하고 본문 site 요약을 제거한다. 맵 요약은 맵 이름·선택 필터로 헤더 현장 밴드와 구별하고 상태 조회 조작은 공통 FilterPanel Popover로 연결한다. 기존 로그에는 검색 계약이 없으므로 가짜 검색을 만들지 않으며, 기간/limit를 Popover로 이동한다. 기본 limit 50, 옵션 50/100/500/1000, 기간 null, 3개월 보관, cursor400 첫 페이지 복구는 보존한다.
- [x] **Step 4:** GREEN unit/type/UI와 실제 browser wheel/keyboard 끝 항목·camera1023↔1024/전체보기·로그 끝/44px 필터·scope 변경의 늦은 응답을 확인한다. 헤더/로그/도구/범례 겹침 0, 선택하지 않은 조명 상세 0, 추가 제어 POST 0이다. 표시 수명 중 알림은 flow 정상 스크롤로 위에 벗어날 수 있으며 실제 footer 시점 visible0을 기록한다. 임의 초장문·전체 상태 조합의 통합 검수는 Task9 범위로 유지한다.
- [x] **Step 5:** 메뉴에 실제 구현 범위/검증 한계를 기록한다.
- [x] **Step 6:** `fix(monitoring): preserve map space and shared log filters`로 소유 파일을 커밋 후 독립 검토받는다.

Task 5 중간 회수: `7b773e4a` 공통 ref 수명 보완을 먼저 커밋하고 `13ecfac6` 모니터링 소비를 커밋했다. 직접312PASS·타입/UI0·20모의browserPASS와 후속 capture1/표시호환75PASS는 실제 Node22/exit metadata·원로그로 확인했다. 전체Web 한 번의3137PASS/4FAIL/3skip은 뒤의 네 selector 이관 전 실패이며 전체통과로 바꾸지 않는다. 원 알림 표시 중 footer 입력 가림 및 최종 상태·폭 matrix는 미승인으로 Step4를 열어두고 독립 검토에서 판정한다. 실제200%는 headless 브라우저 확대와 CDP fromSurface:false compositor PNG 한 사례이며 빈 Playwright PNG는 보존하고 headed/native/HIL/최종시각 승인으로 확대하지 않는다. 총괄은 16파일 committed/working/verified blob 일치를 별도로 대조했다.

Task 5 독립 gate: 전체 `task-5-review.md`를 회수해 Spec❌/Needs fixes·Critical0/Important2/Minor1을 확인했다. I1은 실제 알림 표시 중 footer 입력 가림, I2는 새 외부 reset이 기존 `onSelect("all")`의 검색 삭제까지 호출하는 문제다. 같은 구현 담당자에게 FIX_BASE13ecfac6의 논리 보완 round1을 배정했다. I2는 별도 reset callback·원 선택 의미 유지, I1은 공통 알림/쉘 배치의 최소 소유 제안 후 승인 범위만 수정한다. 재현을 닫기 전 PASS로 바꾸지 않으며 직접 covering 재검증·scoped 재검토 전 Task6로 넘기지 않는다. M1 경고는 기존 owner/최종검토 triage에 유지한다.

Task 5 보완 회수: `54400893` 13파일·원/full append 보고·원로그·별도 blob 대조를 확인했다. 현재 생산 소스는593PASS, 보완된3시험은105PASS에 각각 일치하고 타입/UI0다. 원23browser의22PASS/1FAIL은 보존하며, 후속 atomic알림2PASS·native상세1PASS·finalE2E타입0를 별도 기록한다. flow 알림은 표시 수명/DOM을 유지한 채 자연 문서 스크롤로 위에 벗어날 수 있으며 해당 footer 시점 visible0을 명시했다. 원/수정PNG 및 현재 headless 실제200% compositorPNG를 직접 확인했으나 최종 headed/장문·상태/native/HIL은 미검증이다. 독립 scoped 재검토에서 I1/I2 및 새 보완 부작용을 판정 중이며 Step4/6은 아직 열려 있다.

Task 5 완료: 전체 `task-5-rereview.md`를 회수했다. I1/I2 모두 ADDRESSED·새Critical0/Important0/Minor0이며 원 나머지 broad Spec✅와 결합해 요구/품질 gate를 승인했다. 원23 및 전체Web 실패 경계는 그대로 두고, 직접593/105·타입/UI0·affected 알림2/상세1·13파일 hash를 실제 검증 소스에 연결했다. 기존 M1/noise와 headed/native/HIL/전체 상태·폭·사용자runtime은 Task9/10에 유지한다. 소유 sourceclean/자체자원 종료·idle를 확인하고 제어 담당자에게 Task6만 넘긴다.

### Task 6: 제어의 공통 Grid/필터·지도 입력·inline 결과

Task6 인계(총괄 Ruling15): 기존 제어 세션의 turn01a10ac4 압축 이후 과거 센서 질문 응답을 새 업무로 해석했다. UI 보류/센서 재개 질문만 발생했고 장비 실행은 시작하지 않았다. 작성권을 회수한 후 중지 turn01a10ad0 completed/idle·전체 `task-6-handoff.md`를 확인했다. 제품 구현/커밋0, 소유6시험 WIP와 원RED25FAIL/297name-filtered·exit1/Node22/06:39:43..47UTC를 보존한다. 범위 밖 센서 문서·thread·기본 Git 읽기를 명시하고 서버/DB/장비 쓰기·시그널·CUA0/소유active0을 회수했다. 총괄은 main32e7a45/clean·Web71947지속·API4000nolisten을 대조했으며 원인/복구를 추정하지 않았다. 기존 센서 세션을 재사용하지 않고 fresh 내부 GPT6.1 Sol high가 같은 brief·BASE1850c0f6·원자료와 남은 작업만 이어받는다. 준비/원RED/기본서버 반복·새 사용자 sidebar세션·센서권한 확장은 없다.

Task6 총괄 Rulings16~18: 소유E2E의 map400×240는 실제 interactive viewport에 적용하고 fitted inner도면 visibility·원ID/48hit·nativeclick은 유지한다. dense목표는 원fixture와 기존 실제 확대controls 뒤 중심hit/가림0/선택을 증명한다. ordinary natural-flow의 문서높이0 대리 단언은 명명된 popup/Drawer의 실제bounds·내부끝접근·실wheel/key의 background scrollY보존으로만 정정하고 모든X0/안전기준을 유지한다. Shell/group/overlay 제품 또는fixed-height 변경은 없다. 자기새profile의 최소권한tinyextension public tabs.setZoom/getZoom은 viewportnull/metrics0·실flags/환경·원100↔200 독립geometry/DPR/실입력/nonblankPNG가 있을 때만 genuine200으로 인정하며 Task9/headed/native/HIL까지 확대하지 않는다. 원 실패/covering/hash/독립gate를 요구하고 판단오류비용은 작업ledger에 전부 남긴다.

Task6 총괄 Ruling19: populated40개의 상세행이2084px intrinsic크기로 auto grid행과 전체 지도/문서를 늘리는 실제desktop 결함은 테스트 변경으로 숨기지 않는다. owned SpatialTargetSelector의 표시상세 scrollport에만 tablet:[contain:size]/예외주석을 추가해 기존 mapmin240/footer/legend가 행 크기를 정하도록 하고 원overflowauto/min-h0·selection/camera/command/48hit를 유지한다. internalwheel/end040/pagefixed/mapminimum/X0/안전 단언을 그대로 새GREEN 증명해야 하며 Shell/group/fixed-offset/hide 변경은 없다. 판단오류 시 다른상태/배치·camera 회귀를 되돌리고 UI/단위 검수를 반복하는 비용을 ledger에 기록했다.

Task6 총괄 Rulings20~23: 자기freshprofile의 public chrome://settings global200+reload 단일 비교는 기존blank/nonqual 원로그와 함께 보존하되 geometry/input/traceJPEG를 strictvisualPNG 승인으로 바꾸지 않는다. 소유 ManualControlFeedback만 실제compact47.5rem 가용높이 scrollport와 auto-rows로 보완하고 고정입력/Apply·접힘밖 경고/안전행동·UUID/targets/잠금을 유지한다. 새1440×600의 마지막 width-only 문서높이 proxy만 승인명세의 short natural-flow 실제 wheel/key·지도/footer/범례/끝안전조작 hit·clip겹침0/minmap240/X0으로 정정하고 기존desktop pagefixed/internalwheel은 유지한다. App.test.tsx named partial polling1348 직전 명시적 상세 click 한 줄만 추가 소유로 주며 원POST70%/2targets/clientRequestId와세detail단언을 유지한다. 원whole-Web3171PASS/1FAIL/3SKIP·exit1은 보존하고 직접covering/typeUI/affectedbrowser만 재확인한다. 전체판단근거/오판비용은 ledger에 기록됐고 Task9 실제200·14PNG/독립gate는 아직 남아 있다.

**Files:** `apps/web/src/features/control/ControlView.tsx`, `CommandHistoryPanel.tsx`, `target-selection/SpatialTargetSelector.tsx`, `automation/{ScheduleControlPanel,VehicleEventControlPanel}.tsx`, `automation/components/{AutomationRuleControls,AutomationRuleTable,AutomationRuleCard}.tsx`와 인접 시험; 생성 `command-result-presentation.ts`/`.test.ts`; 수정 `e2e/calm-operations-automation.spec.ts`, `calm-operations-manual-control.spec.ts`, `control-map-target-selection.spec.ts`; `docs/menus/control.md`.

**Interfaces:** Task 1의 DataGrid columns/getRowKey/RowActions를 소비하고 window 기반 useCompactAutomationList/AutomationRuleTable 중복을 제거한다. 활성 토글은 별도 44px icon, 수정/삭제는 RowActions의 typed items/onAction/ref로 전달한다. DateRangeDraft/PageSizeSelect는 popup 밖 부모 소유다.

```ts
type RecentCommandResult = { kind: "empty" | "pending" | "verification" | "unknown" }
  | { kind: "completed"; result: "success" | "partial" | "failure"; label: "성공" | "일부 성공" | "실패" };
presentRecentCommandResult(status: CommandStatusResponse|null): RecentCommandResult;
```

completed/verified_applied+applied→성공, partial_failed/verified_partial+partially_applied→일부 성공, failed/verified_not_applied+not_applied→실패다. 진행 중/verification_required/timeout·없거나 모순된 outcome은 확정하지 않는다. 조회/보관/저장 오류는 기존 부모 경계에 남긴다. CommandOutcomeActions의 원본 UUID/안전 판정/콜백/잠금은 바꾸지 않는다.

스케줄 brightness는 표/카드 표시만 제거하고 이벤트 brightness는 유지한다. 두 AutomationWorkspaceSummary 호출만 제거하며 timezone/동기화 대기·실패·센서/대상/유지 시간·다음 실행은 행/편집에서 보존한다. 기본 필터는 status=all/sync=all/limit10, 상세 reset은 검색을 유지한다. 명령 이력은 검색 300ms 외부, period/stage/limit는 Popover로 이동한다. 기본 null/빈 stage/50과 옵션 50/100/500/1000을 보존한다. Task 2 viewport의 wheelZoomWithoutModifier=true를 소비하며 다중 선택은 빈 지도의 직접 선택 policy에서 추가한다.

- [x] **Step 1:** RED `removes overview and schedule brightness without changing save payload`, `preserves event brightness and synchronization states in table and cards`, `collapsing inline details preserves unresolved command ownership`, `preserves partial date draft across filter close`를 작성한다. 단계/outcome 진리표와 처리 건수만으로 성공을 확정하지 않는다고 단언한다.

```ts
expect(presentRecentCommandResult({ id: "command-1", stage: "completed", outcome: "unknown", dispatchCount: 1,
  completedFixtureCount: 1, totalFixtureCount: 1, errorMessage: null, dispatches: [] })).toEqual({ kind: "unknown" });
```
- [x] **Step 2:** control/automation 인접 Vitest 및 원 browser 8px/Space/middle-pointer case의 RED를 확인한다. 기존 drag 로직의 실제 실패 원인과 wheel 옵션 누락을 구분한다.
- [x] **Step 3:** 공유 인터페이스로 목록·필터·지도·최근 결과를 구현한다. 상세는 명시적 inline 펼침과 세로 스크롤, 새 dialog/Drawer 0이다. 미확정 경고/안전 행동은 접힌 상세 밖에도 남긴다. AutomationRuleCard는 DataGrid 카드로 이관 후 미사용이면 제거한다.
- [x] **Step 4:** 관련 회귀/type/UI와 실제 pointer anchor·7/8px·400ms/핀치·capture/blur/Escape·disabled·줌/이동 뒤 정확 ID·추가 선택·44px 더보기/삭제 확인/초점·내부 가로 넘침 0·inline 끝 정보를 GREEN 확인한다. resize/filter/details의 추가 제어 POST·UUID/targets/소유 잠금 변경은 0이다. 원79browser의77PASS/2FAIL 후 affectedautomation8/short1PASS만 새소스에 연결하며 fresh전체79/whole-Web PASS로 바꾸지 않는다. strictvisual200·전체폭/상태·native/HIL은 Task9에 미검증으로 유지한다.
- [x] **Step 5:** 제어 메뉴에 실제 구현·검증 범위를 기록한다.
- [x] **Step 6:** `feat(control): unify automation grids and inline results`로 커밋, 독립 검토 뒤 Task 7로 넘긴다. 실제 장비 명령/센서 테스트는 하지 않는다.

Task6 구현 회수: `16eefc1957ebac120e9d9ca3945b3a27277a0402` 단일21파일커밋/parent1850c0f6·전체최종보고 및 source-freeze/cleanup을 읽었다. 실제350/App69/typeUI0/automation8/short1 원stdout·UTC/Node22/exit와 21 committed=working=실제metadata hashes를 독립대조했다. 원whole1FAIL/3SKIP 및79browser77PASS/2FAIL, 이후scoped 범위·actual200 PNG/flags 미검증은 그대로 유지한다. 소유16626/PID0·프로필recoverable archive/원자료보존·작성자idle를 확인하고 freshGPT6.1Solhigh의 독립 요구/품질 gate를 배정했다. 아직 Step6/Task7/최종검수/병합은 미완료다.

Task6 독립 gate: FULLtask-6-review76줄을 읽었으며 Spec❌/품질Needsfixes·C0/I2/M2이다. I1은 invaliddraft의 자동조회enabled가 manualrefetch를 막지 않아 이전valid 기간을 다시 조회하는 경로다. I2는 세 E2E denyfallback와두 automation단위 measurement/menuhelper의 새복제다. Root는 exactnamed경계만 검증하고 같은작성자 FIX_BASE16eef fixround1을 재개했다. Ruling24로 test-only `e2e/support/mock-api-boundary.ts`, `src/test/automation-list.ts`와필요한동명인접.test.ts만 추가소유를 주며 fixture순서/404외부abort/원기하/assertions·명령은 유지한다. M2의 실제open/close callback0도 함께 추가하고 M1원noise는Task9namedtriage로 남긴다. whole/root/zoom 반복없이 직접covering/typeUI/affected3browser·sourcefreeze/scoped재검토 전 다음소비자는 시작하지 않는다.

- [x] **Fix round1 I1:** historyerror→partial/impossible/reversed draft→닫기/재열기보존·manualretry 추가GET0→valid correction 정상조회 RED/GREEN, UI/handler 둘다guard.
- [x] **Fix round1 I2/M2:** 테스트지원 로직 공통화/fixture순서·경계·원assertions 보존, 필터 actualopen/close callback0, directcovering/typeUI/affectedbrowser/sourcefreeze/scoped검토.

Task6 fixround1 회수: `999d7db6e6d3c8042ad9267766804a18f6951fc7` parent16eef·소유11파일150+/52−, all23 cumulative committed=working=actualmetadata MATCH를 총괄이 독립 대조했다. Intended RED2FAIL/reversed1PASS→같은test GREEN3, direct176PASS 및강화final날짜3PASS/typeUI0, affected3browser80raw79기존PASS/신규1FAIL→정정boundary1PASS의원metadata·출력을 읽었다. 원전체1FAIL/3SKIP·visual200미검증은보존한다. Own16626/PID0·recoverableprofiles·idle를확인하고 I1/I2/M2와fixdiff만freshGPT6.1Solhigh scoped재검토에넘겼다. 다음소비자는승인후시작한다.

### Task 7: 통계 조회 필터·보고서 Grid 소비

Task7 완료 gate(2026-10-05 17:33UTC): full9f13소비자 검토의 I1을85372913 create-error cleanup2파일 보완/fresh29-line scoped 재검토로 닫았다. Spec✅/QualityApproved·새C/I/M0. Root FULL최종보고481–523/RED3→GREEN32/helpertype0/ALL642및12원artifact 일치·소유자원 종료를 확인했다. Successfulcapture unchanged/staticmethodreuse승인과 oldhelperactualpixels는 별도이며 미래8/9 모든 원본직검은필수다. 원whole6FAIL/89temporal/실제장문/14행·nativeHIL·M1pnpm/color는최종9/10에정확히남긴다. root2docs만별도커밋뒤기존설정담당Task8, 아직병합0.

현재 최종 gate: 9f13d511의 fresh combined 검토 FULL66lines는 Spec❌/QualityNeedsfixes C0/I1/M1이다. 소비자 요구에는 새 blocker가 없고, test-only helper.create의 errorpersist 실패가 Page detach를 건너뛰는 I1만 exacthelper+ownedFlow2파일로 동일 담당자에게 fixround1 반환한다. Initial/error-record IO의 genuineRED→GREEN·기존29contracts/helpertype·2filecommit/scoped I1+newbreakage review가 필요하다. Successfulcapture/제품/date/Filter/layout 불변, originalnative/whole/build/3spec 재실행0이며 옛 원본은 원hash의 역사적 개별승인으로 유지한다. M1package/colornoise는 finalTask9triage. 근거/오판비용ledger48, 설정/통합검수/병합미완료.

Ruling46 primarysnapshot: R45focused25/type0뒤 actualfirst1FAIL은정적stream의lastswap.783066<finalstate.808로8s후후보없음이다. RootFULLreport/independent644hash·37원bytes·4artifacts/cleanup읽었고, FULL68-line별도공개계약검토+exactChrome149schema가PNGsurface현재화면요청을지원함을확인했다. Existingtest3paths만ONEprimaryPage.captureScreenshot request afterfinalDOM/focus로분리수집하며nostream/no timeoutfallback/oldframe승격/hosttimestamp조작0이다. 실제1440×813/원입력·launch/zoom·state/date/API/hit/source·8s정리 유지,개별원본root직검pending. FocusedRED→Green/type/freeze→samefirst1→root원PNG/fullraw전second/reuse/commit0. 새방법unsupported/blank/wrongsize/drift면STOP/no tuningloop. 원인·오판비용ledger46,Task7/8–10/merge未完成。

Ruling45 scoped: FULL94-line freshreadonlyarchitecture로기존timestamp-only최종상태승인은불충분함을확정했다. Exacttest-onlyhelper+ownedFlow+ownedSurface3파일만 caller의원최종DOM/초점관측뒤 strict later candidate·개별root원PNG시각승인 pending을분리한다. 기존8s/noeligible실패·모든원bytes/ACK/44/X0/입력·launch/제품은불변;기준완화/새paint/input/methodloop0. Genuinewrong-state negatives와persistFrames실패시detach-finally회귀→helpertype/sourcefreeze→samefirstoriginal1→root직검뒤second. 이전89회귀는시간/소스별보존,새전체반복0;finalTask9longnamevisual은별도. 원인·오판비용ledger45;Task7/8–10/merge未完成。

Ruling44 현재: 두 번째original1PASS의7원PNG를root직접검수한결과 genuine-native-200은Escape완료/초점검사와달리OPEN필터를보였다. Frame1791212036.790017>dispatchSTART.790만으로입력렌더완료를증명할수없어 universal final-state method승인/reuse를다시열었다. 현89nonnative시험종료→정리/IDLE만허용,새native/helper/consumercommit0. ExactreadonlyAstra공개계약/원raw아키텍처검토뒤만다음범위를결정하며원첫Flow/58bytes/7PNGs·과거실패는보존한다. 제품/날짜/Filter/flags/입력·44/X0/viewport는불변,단순시간가드/추가입력·repaint/fallback0. 원인·오판비용은ledger44,Task7/8–10/merge未完成。

현재 native 방법은 root 원본 직접 검수로 승인됐다. 두 번째 original surface의 첫1FAIL은 fixed bottom nav가 trigger를 가린 physical setup이며 원52PNG·실패를 보존했다. Owned E2E가 기존 Flow의 공개 centered-scroll/unoccluded44 검사를 소비하는 최소 보완만 수행하고 실제 노출/원입력·단언을 유지한다. 동일 second/remaining3spec·메뉴/consumercommit/독립gate는 아직 진행 중이다. 실제 스크롤로 노출 불가능하면 제품 실패를 보고한다; helper/date/Filter/제품/launch 변경이나 강제 클릭/기준완화0이다.

Root Ruling43: R42 metadata11PASS/helpertype0/sourcefreeze644 뒤 ONE originalnativeflow는 public100→200/같은target·geometry·실입력까지 실행됐지만 최종 검사 완료(.739) 뒤 frame을 요구해 마지막 실제frame(.719140)을 거부하고 원bytes도 실패경로에 유실했다. Test-only 기존zoomhelper+ownedFlow 정확2파일만 마지막 실제 pointer/key dispatch 시작·완료·검사완료를 분리하고 strict 마지막입력 후 최신frame/모든원bytes 보존으로 보완한다. 원flags/launch/stream/8s/전체viewport/PNG/입력·44/X0는 불변; capture-start/tolerance/추가입력/repaint/fallback0. Focused RED→GREEN/helpertype/sourcefreeze 뒤 동일 첫flow 딱1회/root 원PNG·fullraw 직검 전 second/8–10/병합0. 이전1FAIL·lostbytes/diagnostic은 보존하고 이유·오판비용 ledger43에 기록한다.

Ruling42 metadata-only: 최종src type/helpertype/productionbuild PASS 뒤 first nativeflow1FAIL/exit1은 globalzoom/PNGstream 이전의 getBrowserCommandLine 조건부제약이었다. 기존test-only zoomhelper+ownedFlow focusedpreflight만 ownpublicBrowser-session/SystemInfo.getInfo actualcommandLine·단계별version/error/profile즉시저장으로보완한다. 공식API·원metadata/diagnosticPNG한계를보존하고launchflags/viewport/capturePNG/threshold/경로·제품·dateproducer변경0이다. 동일PNG방법의첫실qualification 1회/rootdirect原PNG/fullraw 뒤second/reuse하며일반whole/unit/build반복0·필요helperTDD/type/sourcefreeze만수행한다. 원인·오판비용ledger42에기록; native200/최종Task7/8–10/병합は未完成。

날짜 producer 최종 gate ACCEPTED: `f3d50c2e` fresh scoped rereview I1/stale-clear ADDRESSED·Spec✅/QualityApproved 새 C/I/M0. Root FULL보고서·429proof 및커밋/실77hash를대조했다. 원6c3 cold8/actual20/consumed-key 해결과결합하되원301/preannotation과final33/typeUI/browser12는별도증거다. Shared3파일은동결/read-only; 같은원writer의remainingconsumer 최종type/helpertype/build·ALLsourcefreeze→첫originalnative200flow R25/R38→root직접원PNG/fullraw판정 뒤second/후속소비만허용한다. 최종Task7/8–10/병합은미완료다.

현재 scoped fix round1: `6c3af085`의 독립 검토는 원 cold8/actual20/consumed-key ADDRESSED, Spec❌/QualityNeedsfixes다. 동일 빈 raw/canonical-null·같은 mount에서 pending 입력이 새 현장 callback으로 재결합되는 I1 하나를 원 writer의 정확 producer3파일에 반환했다. 기존 guarded callback의 발행 소유권을 유지하고 equal-null A→B 및 A→B→A nested-focus RED→GREEN/새 현장의 다음 정상입력·형제값 보존을 증명한다. 일반 callback identity를 숨은 epoch로 해석하거나 새API/hook/path를 추가하지 않는다. 별도 exact3fixcommit와 I1+new-breakage scoped rereview 뒤에만 최종 consumerfreeze·실제200%로 진행한다. 최종Task7/8–10/병합은 미완료다.

R36/37 producer8cf3 independent gate ACCEPTED: FULLreview Spec✅/QualityApproved C0/I0/M3이며rawrange lifecycle/실입력20/원publication/calendar/blocked/single/cleanup과동일source21·136·65·88/physical10+direct1경계를확인했다. 원실패·pnpm/color/expectednondateZod진단은최종9triage에유지,추가product/tooling권한0. Samewriter remainingconsumer/helperGreen→sourcefreeze→R25첫actual200/root원PNGqualification를진행한다. 최종Task7/8–10 완료는아니다.

Root Ruling38: 신규test-only support/statistics-native-zoom-evidence.ts 한 파일로기존two-native200의공개CDP/원PNG·provenance·cleanup을공통화한다. 이미ownedflow의purevalidator RED→GREEN와원case계약을유지하며dateproducergate/전체sourcefreeze뒤첫flowbounded1회/root원PNG·fullrawqualification→same surface/8/9재사용이다. Syntheticvalidator≠actual200,지원실패NEEDS_CONTEXT/실UIFAIL·원44/X0/전체viewport기준불변;capturefallback/flag/profiletabloop/emulation/JPEG변환0. 원인·오판비용ledger와brief기록.

Root Ruling37: immutable trusted 입력20→원canonical20→암묵blur28→focusout28을직접확인해 R36동일3파일 range-only nativeancestorblur capture로기존raw보호시점만앞당긴다. 실제첫입력/원publication·달력·fullclear·single/readOnly/disabled/초점전파불변, parser/private상태/이벤트차단/timeout/추가경로0. Event-order RED→GREEN·실입력/cleanup/기존date관문필수이며실패하면다음guard변형이아니라exactarchitecturecontext를반환한다. 원인·오판비용ledger/producerbrief참조.

Root Ruling36: URL seed/sync를 배제한 공개 cold range 재현에서도 untouched endpoint가null로 사라져 shared producer 결함을 확인했다. 기존 DateRangePicker.tsx/date-field.tsx/DateRangePicker.test.tsx 정확3파일만 최소 raw 수명 보완·별도commit/fresh scoped producer gate를 추가한다. 원clear null1회/complete·reversed/calendar/disabled·readonly/single·time/소비자·실URL/GET0/repair·200 기준 불변, 공개API/hook/adapter/private상태·bridge복제0. 원RED1/15명시적선택제외 및실browser실패를보존하며원인·오판비용은ledger/별도producerbrief에기록한다.

Root Rulings33–35: 기존 첫 시작 날짜 초점은 Overview의 공개 autoFocus로 보존한다. Test-only 기존 layout-assertions.ts/spec의 HTML viewport-root clip 좌표만 정확히 보완하고 원44/ordinary/fixed/occlusion 기준·전체 negative suite를 유지한다. 초기 보고서 날짜-invalid URL은 소유 소비자 안에서 rawURL/draft/error·모든 자동/수동 요청0·명시적 유효 복구를 보장하며 parser/schema/API hook·비날짜 거부·독립 생성/CSV 계약은 그대로다. RED2→focused39PASS는 부분 증거이며 전체 helper/복구/200%/최종 독립 gate는 남아 있다. 이유·오판비용은 ledger와 task7 brief에 기록한다.

별도 producer `841a714d`의 독립 gate는 Spec✅/qualityApproved·C0/I0/M1로 승인됐다. Root가 unchanged keyboard/disabled/pending 코드 및helperBASE=commit=working을연결했고pre-run helperhash미포함/노이즈는정확한한계로Task9에남긴다. Samewriter가남은consumer회귀/actual200를진행하며Task7최종독립gate는별도다.

Ruling32 producer `841a714d`를 별도 회수하고 root가 FULL보고/9단위·실브라우저3·타입/UI0·소유자원종료 및두실sourcehash를 독립대조했다. Fresh GPT6.1Solmedium의 scoped 요구/품질 gate를 배정했으며 아직 consumer/actual200/Task7완료가 아니다. 앞선 원focusedbrowser6의2setupFAIL와defaultwhole6FAIL는 보존한다.

Task7 Ruling32: narrow에서 공통 필터 trigger의 실제 연속44×44 hit 부족을 확인해 기존 FilterPanel.tsx/test 두 파일만 최소 min-w16로 보완한다. 기존125/44/X0·공개API·일반버튼·조회/초안은 유지하고 별도 생산자 commit/독립 scoped gate 뒤 소비자 작업을 승인한다. Default whole3178PASS/6FAIL/3SKIP·exit1과 첫selected mock50PASS13FAIL은 원로그로 보존하며 전체 재실행/외부 실패 임의수정은 없다. 원인·오판비용은ledger와 별도hit brief/report에 남긴다.

Task7 Ruling31: 기존Atlas analysis filterCard<125를유지하며public FilterPanel compact variant를소비해44hit/전체요약/reset과간결함을함께보존한다. Heatmap metric→loading의filterunmount는실초점/overlay수명검증으로판별하고실consumer결함이면같은소유범위에서원query/pending/로딩의미를유지해보완한다. 단순selector교체/threshold완화/공통·도메인변경0이며근거와오판비용은ledger에기록한다.

Task7 Ruling29: 기존두actual-file시험의ownedephemeral loopback PDF byteserver만해당시험수명/최대동시1로허용한다. assignedport/정확URL GET·원byteLength/SHA/manifest/PDF/CSV단언과close/socket0를보존하고새middleware/helper·다른origin/unknownAPI허용·외부API/DB/S3/장비0이다. 원경로를가짜download로대체하지않으며이유·오판비용은ledger에기록한다.

Task7 Ruling28: 기존persistent-contextactual200두case만선택mock실행에서명시적분리한다. 정확argv/제외수와미실행상태를보존하며skip·삭제·단언완화·전체세spec통과표시0이다. sourcefreeze뒤Ruling25최초원PNG/root판정후같은방법으로기존두case의실입력/초점/기간/장문/API0조건을회수해야한다. 방법실패는NEEDS_CONTEXT·실UIFAIL을구분하고Task7gate/Task9전체matrix완료로바꾸지않는다. 이유·오판비용은ledger에기록했다.

Task6 완료 gate: 총괄이 FULLtask-6-rereview를 읽어 I1/I2/M2 모두ADDRESSED·새Critical/Important/Minor0·open0을 확인하고 원 broad 검토의 다른요구충족 판정과 합쳐 Task6 소비gate를 승인했다. M1원noise·wholefresh·strict200/fullmatrix/nativeHIL은Task9에명시적으로남긴다. 다음통계담당은기존scope/보고/기준을소비하며이전제어결과를새전체통과로재사용하지않는다.

Task7 배정: 기존통계담당01a088fa/local GPT6.1Solhigh, BASE47385f86 clean·단독consumerwriter/own16627. Root Ruling25는Task7 소스동결후 publicglobal100→200/settings read-back·samepage directPNG screencast의bounded1가설만허용한다. actualflags/version/source/전체viewportgeometry/freshframe·원PNG·실pointer/key를root직접판정하기전성공또는8/9재사용0; 실패/모호함NEEDS_CONTEXT·UI결함FAIL. 원실패와7폭/2short/14행/nativeHIL분리기준은그대로이다. 전체근거/오판비용은ignoredledger에보존한다.

Task7 native인계 Ruling26: 4시험WIP를남긴후contextCompaction01a10b65에서과거PDF업무로전환해496.420s turn을완료했다. Rootexactcommandinventory/응답과기본32e7clean/Web71947/API4000none을확인했고범위밖PDFff-only명령은Alreadyup-to-date·HEAD변경0이다. 현재UI완료로인정하지않고STOP/작성권회수·전체handoff/ownresources0/idle확인후fresh내부GPT6.1Solhigh가sameBASE47385와4시험·원자료만이어받는다. 원제품/featurecommit/RED0을인계에서확정하며준비/기본서버/옛baseline재실행0·사용자sidebar새task0·Files/검수기준불변이다.

Task7 recovery 시작: FULLhandoff의4시험WIP71+/1−/4hash를root독립대조하고nativeSTOPturn305.197s completed/idle·active0를확인했다. Fresh /root/ui_refinement_statistics_recovery에게원未실행runner/WIP·같은BASE·소유Files/Root25를넘겼으며설정오류는scratch내최소보완·원로그보존후첫 genuineRED로구분한다. Root는plan/status/ledger만집계하며writercommit에서제외한다.

**Files:** `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`, `analysis/{StatisticsAnalysisPage,EnergyHeatmap}.tsx`, `reports/{ReportHistoryFilters,ReportJobList,ReportJobTable,ReportJobCards,StatisticsReportsPage}.tsx`와 기존 시험; `apps/web/e2e/statistics-flow.spec.ts`, `statistics-surface-regression.spec.ts`, `statistics-mobile-files.spec.ts`; `docs/menus/statistics.md`.

**Interfaces:** Task 1의 mode=popover를 소비한다. 검색 없는 개요는 비교 preset/custom 기간과 독립 추이 단위를 별도 FilterPanel로 유지한다. 분석의 dimension/metric/date/sort, 히트맵 metric도 각 범위의 Popover다. DatePicker 두 개는 useDateDraft, 기간은 useDateRangeDraft를 부모에서 소유한다. 보고서는 검색 외 status/request-period/scope/limit를 Popover로 옮기며 DataGrid renderCell(item,surface)에 기존 renderFailure(item,surface)/행동을 전달한다.

기간 조회 Modal은 필터 Popover 내 필드로 옮기되 개요의 기존 명시적 기간 적용은 유지한다. 보고서 생성 폼/비조회 상세 dialog는 유지한다. 검색 300ms·limit20/기존 허용 값·URL/history/cursor/site·90일 요청 기간·PDF/CSV·파일 취소/실패·pending과 실제 0/결측/추정 표현을 보존한다. 분석 기본 기간은 기존 completedSiteMonth이며 1~400 완료일 검증/이름 줄바꿈·차트 gap은 바꾸지 않는다.

- [x] **Step 1:** RED `separate comparison and trend filter scopes without invented search`, `preserves partial single and range dates across popover lifetime`, `report grid adapts to actual container and retains failed expired actions`를 추가한다. invalid 기간의 조회/생성/CSV 0, 상세 reset의 검색 유지, 실제 0과 null 구분을 단언한다.

입력 거부 회귀에는 기존 계약의 역전 기간 검증과 실제 요청 spy 0을 함께 둔다.

```ts
expect(energyRangeComparisonQuerySchema.safeParse({ from: "2026-09-02", to: "2026-09-01" }).success).toBe(false);
```
- [x] **Step 2:** Overview/Analysis/EnergyHeatmap/ReportHistoryFilters/ReportJobList Vitest의 RED를 확인한다. report table/cards의 중복 표시·window-only 기대만 새 container 계약으로 고친다.
- [x] **Step 3:** 공통 표시/초안 API를 소비하고 기간 Modal의 기존 apply 행동은 Popover에 옮긴다. 날짜 자동 보정·불완전 draft의 URL 쓰기/API 조회는 금지한다. ReportJobTable/Cards의 미사용 표시 복제만 이관 후 제거한다.
- [x] **Step 4:** GREEN 단위/type/UI와 세 statistics browser 회귀를 실제 200%/장문/320폭/short·nested calendar/Escape/Back·URL 뒤로가기·invalid 수동 복구로 확인한다. 원89/301/33 및 actual2cases는 각 소스/시점의 증거로 구분하며 현재32는 helper 직접 covering이다. 실제 장문 표시/전체14행·whole6FAIL은Task9에서확인한다. 400일/PDF 전용/파일 수명/cursor 초점 기준은 낮추지 않는다.
- [x] **Step 5:** 통계 메뉴를 실제 필터/표 소비와 일치하게 갱신한다.
- [x] **Step 6:** `refactor(statistics): consume shared filter and grid surfaces`9f13 및 scopedfix85372913을 커밋하고 full/scoped 독립 gate를 통과했다. M1은Task9triage로명시한다.

### Task 8: 설정 목록 필터/Grid와 CAD 페이지 크기 소비

완료 gate:575e7886+cd0949b5, fullSpec✅와 fresh scoped I1ADDRESSED·새C/I/M0/미해결fix0을 총괄이 FULL읽고 합쳐 승인했다. 제품247/브라우저28와 후속helper31/엄격type/native3원본직검/출력path3의소스·시간을 분리한다. 변경되지 않은 생산자는 앞Task1/2/7gate에 연결하며 freshwhole71FAIL/CAD66미수집·노이즈·전체matrix/ownnative/실Lab·HIL·로컬반영은 Task9/10에 남긴다. 미래QA의 readonly준비READY를 받은 뒤 root문서커밋·clean을 확보하고 단독GO로 실행한다.

독립 full gate575e7886: Spec✅/QualityNeedsfixes C0I1M1. I1은 기존2E2E의 native sidecar3곳에 추가된 미문서 TASK8_OUTPUT 의존이다. Ruling55로 SAME소유자의3출력식만 public TestInfo.outputPath로 고치고 실제 출력경로 RED/GREEN·동일엄격타입·소유2파일커밋 뒤 scoped 재검토한다. 제품/공통helper/소스가드·실제200 방식/원증거는 불변이며 캡처·전체suite·build 반복0. M1 노이즈와 whole71FAIL/CAD66미수집은 최종Task9에서 명시 검증한다.

최신 R54 총괄 직검: 실제200% 원본3개(CAD 영역 이름·선택, 실제 사용자 장문, 별도 자연스크롤의 행 작업 닫힘·초점)를 각각 승인했다. exact722 source/current 일치와 lossless/상태·기하·target/frame 일치, 타입0/helper31/타입-erasure동일/자체 정리를 대조했다. 소유14경로 커밋과 독립 gate를 진행하며 원 전체71FAIL/CAD66미수집은 Task9 fresh 관문에 남긴다. 과거 미승인/실패를 소급 통과로 바꾸지 않는다.

Task8 배정 준비: Task7 독립 gate/4204f1ed clean 뒤 기존 설정 담당019f1d62/local의 freshwait0=inactive/completed를 확인했다. 같은 담당에게 task-8-dispatch.md/brief의 exactfiles·단독writer/own16628·현재readonlyhelper/source/OWN원본직검·원권한/payload 보존 계약으로만 배정한다. 이전Task2/기본checkout/사용자runtime로 전환0, root2docs는작업commit제외. 실행/검증/완료gate는아직이다.

Task8 진행: focused92PASS와 wholeonce3085PASS/71FAIL/3SKIP+CAD66미수집은 별도 결과다. Ruling50의 ONE CAD320×740 정상 자료 클릭 진단은 원30초 실패를 재현했고 header343px/workspace0px를 계측했다. 공통 카메라 도구 소비 배치의 최소 수정과 native 장문 내용 검증 보완은 독립 원인 분석 뒤에만 배정한다. 의도 사용자 이름 없는 기존 native 원본은 REJECTED이며 새 helper/부모 실패 판정으로 바꾸지 않는다. 구현 완료/독립 gate/병합은 아직이다.

Ruling53 보완 범위: 원인 분석 뒤 FloorEditorView.tsx·FloorEditorRoute.tsx·CustomerShell.tsx의 editor-route 레이아웃과 각각 기존 시험만 추가한다. 카메라 도구 소비 nowrap/minimum을 기존 공개 className으로 조정하고 map≥240·짧은 화면 자연 문서 스크롤·충분한 화면 채움을 유지하며 계정/카메라/lease/save owner는 바꾸지 않는다. 사용자 native 시험은 실제 장문 내용·44px 행 작업에 맞는 안전한 최종 입력으로 검증 범위만 고친다. ONE 원config focused 비교163PASS는 whole71FAIL을 대체하지 않으며 최종Task9에서 다시 검증한다. 상세 요구/오판 비용은 ignored brief/ledger에 보존한다.

Ruling54 후속: 직접247/브라우저28·Web타입/UI0를 회수했다. 별도 엄격 E2E 타입의 공통 layout-assertions.ts229 오류만 type-only Element 배열로 보완하고 기존 helper-spec/타입·erasure 동등성을 검증한다. 실제200 CAD 원본은 닫힌 필터/기본20 범위만 승인되며 실제 영역 이름은 별도 자연스크롤 상태로 입증한다. 긴 카드의 이름과 행 작업은 동시에 한 viewport에 있어야 한다는 추가 기준을 만들지 않고 각각 실제 접근·내용으로 검증한다. helper 방법/제품/저장·권한/기준은 그대로이며 native 원본별 총괄 직검 전 완료 커밋·독립 gate는 보류한다.

**Files:** `apps/web/src/features/settings/users/SiteUsersView.tsx`/`.test.tsx`, `features/floor-editor/CadImportPanel.tsx`와 기존 시험, `e2e/site-user-management.spec.ts`, `e2e/settings-floor-editor.spec.ts`, `docs/menus/settings.md`.

**Interfaces:** 사용자 목록은 DataGrid+FilterPanel을 사용한다. 검색 외부, 권한 all/read/control·상태 all/active/disabled는 상세 Popover, 활성 수 0~2와 검색을 유지하는 reset이다. 100명 한도·비활성화/영구 삭제/권한/확인은 부모 소유다. CAD 후보 page-size는 검색 없는 FilterPanel/PageSizeSelect와 기본20·옵션10/20/50/100을 사용하며 이전/다음은 남긴다. 등록 층/게이트웨이·현장 관리 층·CAD 영역 선택은 primary 입력이므로 숨기지 않는다. 계정/logout은 Task 4의 단일 eager 계정 영역을 소비하며 owner를 복제하지 않는다. SettingsShell accountSlot 공개 API의 예외적인 live 배치는 Task 4 Ruling에 따른다.

- [x] **Step 1:** RED `user detail reset preserves search and pending permissions`, `user grid switches by container without losing mutation controls`, `CAD page size is a filter while region selection stays visible`를 작성한다. scope 전환 시 열린 옛 행 menu의 요청 0, 삭제 확인/초점 복귀·페이지 크기 검증을 단언한다.

```ts
render(<PageSizeSelect value={50} options={[50, 100, 500, 1000]} onChange={vi.fn()} />);
expect(screen.getByRole("button", { name: /페이지당 항목 수/ })).toBeVisible();
```
- [x] **Step 2:** SiteUsers/CadImportPanel 인접 Vitest의 RED를 확인한다.
- [x] **Step 3:** 공통 표시를 소비하고 편집/관리 writer guard·후보 선택 payload·lease/revision 수명을 보존한다. 페이지 크기 변경만 기존 첫 페이지 reset을 호출한다.
- [x] **Step 4:** GREEN unit/type/UI와 사용자 관리·CAD 후보의 모의 browser case를 keyboard/touch/44px·장문·container/short/200%로 확인한다. 실제 등록/장비/현재 계정 삭제는 시도하지 않는다. 제품247/브라우저28와 후속helper31/엄격타입·실제200 원본3승인·출력경로3은 각 소스의 별도 증거다. 원 whole71FAIL/CAD66미수집은 Task9에서 검증한다.
- [x] **Step 5:** 메뉴에 공통화/미검증 native/HIL 범위를 기록한다.
- [x] **Step 6:** `refactor(settings): share list filters and responsive grids`575e7886 및 출력path보완cd0949b5를 커밋 후 full/scoped 독립 검토를 통과했다. M1은 Task9 triage에 남긴다.

### Task 9: 동결 소스의 엄격한 통합/UI 검수

진행 시작: Task8 full/scoped관문과root문서e50236a5 clean 뒤 readonlyREADY QA에게 단독GO를 배정한다. 최초수행은exact신규2E2E/typedLab지원의RED→GREEN, 이후harnesscommit과actual소스동결/단독canonical4종각1회·자체Lab·14행7폭/short/actual200/1000대, 총괄원본직검·새UIUX/wholebranch검토다. 제품수정·기준완화·사용자서비스/DB/장비변경권한은 없다. 원71FAIL/CAD66미수집과M1노이즈를명시적으로새원로그에서검증한다. 아직검증완료/Task10/병합아니다.

Task9 Ruling30: 미래단독harness writer에기존real-backend-lab.ts 및필요한real-backend-lab-support.spec.ts exactpath의최소public typed alarmfixture/oracle만추가허용한다. Ownstart/installation/clusteridentity뒤자기DB 두actor/두site/incident/read/예약·효과상태를다루며arbitrarySQL/secret/socket/env공개/privatecast·skipbuild/timeout/제품/보안변경0이다. 7/8gate뒤만실행하고실두browserHTTP·실PGoracle/독립최종검토를유지한다. 이유·오판비용은ledger에기록한다.

Root Ruling27: 미래단독RealBackendLab에기존publicisolatedCadStorage:true를써외부storage/PKI/proxyfallback을차단한다. ownrunId/label MinIO/mc/privatebucket/Docker동적loopback여섯째포트/CADtemp·development worker·partialcleanup까지Lab소유에포함한다. exactlocal2이미지읽기확인은완료됐지만실실행/ready/PASS아니며--pull=never/usercontainer·imageprune/다운로드0·원label재확인/portrelease를요구한다. 7/8gate/동결/단독build인계후만소비하며helper추가소유와현재사용자반영은이결정범위밖이다.

**Files:** 검수자는 제품을 수정하지 않는다. 필요한 harness 작성 범위는 생성 `apps/web/e2e/operations-ui-refinement.spec.ts`, `monitoring-alarm-dismissals-real.spec.ts`, 기존 표적 E2E/`src/App.test.tsx`의 승인된 표시 기대 변경이다. 기존 보안/권한/명령 시험을 낮추지 않는다. 결과/원로그는 이 계획의 전용 ignored workspace, 상태는 총괄이 본 계획과 `docs/project-status.md`에 동시 반영한다.

**Interfaces:** Tasks 1~8의 동결 HEAD와 보고서/review package를 소비한다. mock UI는 전체 `/api/**`를 명시적으로 가로채고 사용자 서버를 호출하지 않는다. 실제 저장은 자기 소유 RealBackendLab/임시 DB·두 계정 browser로 별도 검증한다. 주석 매핑은 1→Task5, 2→3/4, 3/4/5/6/7/8/9/10/11/14→6, 12→4/5, 13→4; 공통 filter 후속은5/7/8, 공통 map은2/5/6이다.

- [ ] **Step 1:** QA가 동결 HEAD/clean·단독 build owner를 확인하고 `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 canonical root gate로 실행한다. fresh 통과/실패/skip/UI 위반 수와 원로그를 보고하며 옛 숫자를 붙이지 않는다.
- [ ] **Step 2:** 시각/개인 숨김 disposable PG 및 real-backend 두 계정 여정을 실행한다. 전체 범위·동일 key/신규 알람/다른 현장·계정/새 ID 재발/권한 거부/원 read·incident 불변을 확인한다. Lab은 자신의 독립 PG/Redis/MQTT/API/Web 포트만 쓰며 현재 서버와 공유하지 않는다. 기존 지원 env `E2E_LAB_POSTGRES_PORT`, `E2E_LAB_REDIS_PORT`, `E2E_LAB_MQTT_PORT`, `E2E_LAB_API_PORT`, `E2E_LAB_WEB_PORT`로 선택하고 사용 가능 여부를 선검사한다.
- [ ] **Step 3:** UI/UX 디자이너가 7폭·2short·실제 200%·장문/빈/로딩/오류에서 primary/모든 filter·row menu/inline 상세·지도 bounds를 실제 입력으로 검수한다. 문서/Grid/Popover/상세 가로 넘침0·44px/운영map48px·도구/범례/닫기 겹침0·keyboard/touch/Back/focus를 판정한다. 원 1000대 편집기 cold/warm8초·정확 ID/픽셀/저장 관문은 수정 없이 확인한다. 합성 Android Back은 실제 native 검증과 구분한다.
- [ ] **Step 4:** 총괄이 지도 하단/좁은 Grid/실제 200%/최근 결과 끝/설정 계정/알람의 원 PNG와 14행 증거를 직접 검토한다. Needs fixes는 소유자에게 한 수정 묶음으로 돌리고 변경 코드의 표적 검증/scoped 재검토만 수행한다.
- [ ] **Step 5:** 가장 강한 가용 모델의 새 whole-branch reviewer가 32e7a45→동결 HEAD의 diff package/명세/계획/보고서/원 실패·잔여 지적에서 Spec PASS/품질 Approved/미해결 P0–P2 0을 판정한다. 구현자 self-review는 대체 불가다. 통과 뒤 Task10으로 넘기고 증거/커밋/자원 정리를 두 상태 기록에 함께 반영한다.

### Task 10: 명시적 승인 범위의 로컬 반영·병합·인계

**Files:** 새 제품 수정은 없다. 통합 역할이 실제 반영을 단독 소유하고 총괄이 `docs/project-status.md`/본 계획의 완료 상태·메뉴/DB 문서 사실 일치를 집계한다.

**Interfaces:** 별도 브랜치 후 병합 권한과 Task9 승인, 기본 HEAD/dirty·현재 서비스 owner·Prisma/migration identity를 소비한다. 허용 DDL은 새 `20261004100000_monitoring_incident_dismissals`의 두 모델/제약/index/FK 추가뿐이다. 원 데이터/시간대/기존 migration·장비를 변경하지 않는다.

- [ ] **Step 1:** 계획 승인과 구분하여 명시된 두 숨김 테이블 추가·로컬 서버 잠시 중지/재실행 승인을 확인한다. 승인이 없으면 이 외부 반영 앞에서만 멈춘다.
- [ ] **Step 2:** 기본 checkout의 clean·기준 HEAD/브랜치, API의 실제 PID/시작 identity·프로세스 그룹과 DB 정체성을 비밀 출력 없이 확인한다. 옛 watcher를 무심코 재개하거나 다른 세션의 numeric tool handle을 재사용하지 않는다.
- [ ] **Step 3:** 단독 owner가 확인된 Web/API만 잠시 멈춘다. Gateway/센서/broker는 멈추거나 재설정하지 않는다.
- [ ] **Step 4:** 동결 migration을 사용자 DB에 한 번만 additive 적용한다. 기존 checksum 불일치를 전체 migrate deploy/resolve/reset으로 치료하지 않는다. 기존 migration 기록은 변경하지 않고 새 migration 식별자만 기록한다.
- [ ] **Step 5:** 새 migration 완료 기록·두 테이블·shape CHECK/FK/index를 읽기 전용으로 확인한다. 확인 실패 시 병합/새 서버 시작 전 원인을 보고한다.
- [ ] **Step 6:** 검증 브랜치를 기본 `codex/mvp1-cloud-web`에 non-destructive 병합한다. 기본 HEAD가 예상대로이면 `git merge --ff-only codex/operations-ui-refinement-20261004`를 사용한다. 새로운 사용자 변경은 보존하고 충돌/호환성을 먼저 검토한다. 원격 push/PR/배포는 하지 않는다.
- [ ] **Step 7:** 기본 폴더에서 `pnpm --filter @led-control/api prisma:generate`를 실행한다. 이 단계가 완료되기 전 새 API를 시작하지 않는다.
- [ ] **Step 8:** 승인된 Web/API만 단독 owner로 재실행하고 runtime 소유권을 기록한다.
- [ ] **Step 9:** compiler·Web route·TLS health/live·미인증 정상401·실제 schema/model을 확인한다. readiness의 MQTT 관측은 현재 시점 사실만 보고하고 장비 연결을 고치지 않는다. 실제 사용자 알람 숨김/장비 명령을 smoke 목적으로 보내지 않는다.
- [ ] **Step 10:** 병합 SHA/clean·검증 범위/미실행 native·HIL·runtime 한계를 완료 상태 문서에 기록한다. 사용자가 받은 최종 보고는 실제 14건 적용/공통화·검수·병합 결과다. 원로그와 이전 업무 worktree/자료는 삭제하지 않는다.
- [ ] **Step 11:** 검증한 완료 상태 문서만 커밋하고 최종 HEAD/작업 공간 상태를 확인한다.

## 계획 자체 검토와 인계

- [x] 명세 대응: 주석 1~14는 Task 9의 매핑에 있으며 추가 공통 필터/지도/기존 표 소비자와 메뉴/DB 문서도 담당 Task에 포함했다.
- [x] 단계 검토: setup·원 재현·RED·GREEN·문서·커밋 및 실제 로컬 반영의 각 행동을 분리했다. 제품의 전체 함수 본문을 미리 쓰지 않았다.
- [x] 타입 일치: FilterPanel children/mode, DataGrid getRowKey/renderCell, draftController, MapCameraControls reset/fit, 숨김 응답 DTO, view=personal/v2 cursor, accountSlot/context의 생산·소비 이름이 일치한다.
- [x] Review Focus: scope epoch·영속 bulk 실패·행/overlay 수명·계정 탈출·짧은 지도 높이의 다섯 조건을 담당 Task의 시험으로 연결했다.
- [x] 분량/소유: 공유 생산자 이후 소비자 작성/검토를 직렬화한다. 계획은 테스트할 계약·식별자·범위 결정을 담고 구현 본문을 대신하지 않는다.

미해결 명세 누락/계약 이름 충돌은 자체 검토에서 발견하지 않았다. 이 체크는 구현·테스트·UI/DB 반영 완료가 아니다. 승인된 기존 담당 세션 분담으로 실행하며, 완료 상태는 담당자의 검증과 독립 검토를 회수한 뒤에만 갱신한다.
