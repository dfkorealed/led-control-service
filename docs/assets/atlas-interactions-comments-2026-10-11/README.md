# 브라우저 조작·필터 QA 증거

제품 source: `437ebc39`. 6고유 case / 7 runs / 21 executions(6+6+3+3+1+1+1). 6개 case와 추가 marker-origin gate는 **분리된 국소 실행에서 통과**했다. 최종 spec 전체6를 한꺼번에 다시 실행한 결과는 아니다. 원 실패를 포함한 logs/PNG/JSON/error-context를 run 이름별로 그대로 보존했다.

정적: 원77f8608f typecheck/build0, policy78/79·ui1. 스타일 수리437ebc39 policy79/79·ui0·build0. C8 source/test diff0. 기존 SettingsShell baseline1 failure는 이번 미실행, chunk warning은 유지했다.

첫 run은 mock API capabilities 누락. 이후 DTO와 실제 DOM locator/text 읽기/axis readiness만 교정했고 제품·threshold·timeout·retry 변경0. `fixture-fixed`에서1/2/4 PASS, `contract-fixed`에서3/5/6 PASS. 최종 reviewer 추가 marker-origin case2는 원 `marker-origin`/`marker-reachable`에서 gesture 이전 hit setup FAIL. 제어 소유자 read-only 원인 확정 뒤 root 승인한 `body-restored` 1회에서 실제 본문 gutter wheel 복귀 후 gate 전체PASS. 기존5개 green 재실행0.

대표 실제 렌더 이미지/좌표(아래 workspace prefix는 `/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/`):

- [PC native CAD](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/fixture-fixed/atlas-interactions-comment-ee699-rve-selection-and-raw-draft-chromium/manual-pc.png), 같은 폴더 manual-pc.json.
- [짧은 dark touch/clear](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/fixture-fixed/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-touch-dark-short.png), 같은 폴더 JSON.
- [320 bottom sheet/date](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/fixture-fixed/atlas-interactions-comment-83a5a-tay-one-line-at-390-and-320-chromium/filter-sheet-320.png),390도 같은 폴더. 실제 nested calendar Escape→calendar focus→sheet close→opener focus 검증.
- [577 dark reports](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/contract-fixed/atlas-interactions-comment-ffb5d-e-row-and-preserves-actions-chromium/reports-dark-577-details.png), 같은 폴더 JSON.
- [390 chart](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/contract-fixed/atlas-interactions-comment-0d65e-C8-content-at-PC-and-mobile-chromium/overview-390.png),1440도 같은 폴더. JSON에 tick bounds/C8 원문.
- [추가 marker gate 준비 단계의 원 실패](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/marker-reachable/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-touch-original-failure.png).
- [최종 marker-origin 실제 native touch](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/body-restored/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-marker-origin-touch.png), 같은 폴더 JSON에 모든 phase camera/rect/hit와selection array. body scrollY388→0, marker48×48/bottom493.70<nav532, camera(0,0)→(8,8), selection불변/다음tap정상.
- [최종 short clear/nav bounds](/Users/kim-jh/Documents/led-control-service/docs/assets/atlas-interactions-comments-2026-10-11/body-restored/atlas-interactions-comment-416c4-rk-actions-remain-reachable-chromium/manual-touch-dark-short.png), 같은 폴더 JSON. clear y332,h44,bottom376<=실제nav top532.

raw/에 명령별 로그 보존. canonical 상세 보고서는 ignored `.superpowers/sdd/2026-10-11-atlas-interactions-comments/task-4-report.md`.

한계: headless Chromium controlled mocks이며 모든 관측 API 쓰기0. 장비/HIL/실제 DB·다운로드 transport 미실행. 미배치/pageerror/viewer 다운로드/중첩select 직접 browser assertion은 수행하지 않았다. 원 marker setup 실패 catch에는 상세 camera/rect/hit chain이 없었으며 원 자료는 그대로 남겼다. 최종 catch 및 입력전에는 실제 phase metrics를 추가했고 marker-origin/native pointerup와fixednav 전체44 visible assertion까지 최종case2에서통과했다. Owned15187 종료 확인, 사용자 서비스 untouched.

## 구현·검토 기록과 통합 상태

`task-1-report.md`(공통/통계), `task-2-report.md`(수동 제어), `task-3-report.md`(헤더/모니터링), `task-4-report.md`(QA), `task-5-report.md`(단일 독립 최종 검토), `execution-ledger.md`(판단·원 실패·소스별 체크포인트)를 함께 보존했다. Task3 원 단계별 로그7개는 `task3-raw/`에 있다. 공통118+통계169는 source별 고유287이며 단일 최종batch가 아니다. 제어는 같은 제품5suite295PASS이고 모니터링은 국소GREEN 경계만 주장한다.

원 Task3 로그7개는 SHA256이 canonical copy와 모두 일치한다. 원 로그의 trailing whitespace/EOF 빈 줄 때문에 artifact를 포함한 전체 diff-check는 exit2이며, 원 증거를 편집하지 않았다. 제품/E2E/메뉴/계획·상태·보고서 Markdown 범위 diff-check는 exit0이다.

20건 UI branch는 제품437/QA673에서 준비 완료이며 최종 reviewer C/I/M0이다. 운영 인사이트는 사용자 요청으로 그대로다. 숫자 날짜 segment의 개별44px 폭과 모바일 전체 제목·기간 한 행은 물리적 폭 예외로 기록했고 일반44px/전체 날짜/desktop 한 행은 유지한다. 번호 검색은 불러온 조명 이름 문자열/기존 cursor 범위이며 서버 전체 검색·실장비를 구현했다고 표현하지 않는다.

기본 브랜치는 별도 공개 웹 배포 작업으로 `34d5a375`까지 진행하여 최초 예정 FF가 불가능해졌다. 사용자가 2026-10-12 기존 변경 보존 후 일반 로컬 merge를 승인했다. 격리 worktree에서 두 부모를 가진 `113f6db24cf6f707393b1994810cf55a04e2670e`를 만들고 동일 tree `c0bc852d232f29ec4f2db1a9958ccc1caf9ea6f2`를 한정 검증했다. fresh 정적87+7+79=173PASS·UI0/0·타입 포함 build0, 실제 merge source의 기존 모바일 case2/4 각각1회2PASS(16.5s), 같은 reviewer C/I/M0·ReadyYes다. [통합 QA](integration/task-6-integration-qa.md)와 [통합 리뷰](integration/task-6-integration-review.md)에 새 소스·원 로그·PNG/JSON을 별도 보존했다. 이전6고유 case cohort와 합산하거나 통합 source 전체6PASS로 표현하지 않는다.

기본 브랜치의 freshclean/예상HEAD를 확인한 뒤 검증된 일반 merge와 QA/리뷰 전용 후속을 정확히 적용했다(`34d5a375`→`b933b28ace1c150522a723d24516f63d5c24a2f3`, `git merge --ff-only` exit0). 제품·메뉴는 검증 source와 diff0, C8는 기준과 diff0이며 기존 배포 변경의 이력도 보존된다. 이후 완료 기록은 문서 전용이다. task-owned ignored SDD와 모든 원 test-results는 `.superpowers/sdd/atlas-interactions-comments-backup-20261011.xDuwBW/`에 복사하고 원본과 재귀 diff0을 확인했다. 다른 worktree/stash/서비스/원격/실장비는 변경하지 않는다.

C2는 지정된 중복 `빠른 기간 선택`만 제거했다. 같은 label을 쓰는 기존 `절감 비교 프리셋`은 활성 query를 바꾸는 별개 기능이므로 유지한다. 최종 source 대조와 판단은 통합 리뷰·execution-ledger에 명시했다.

이번 clean merged worktree와 branch만 `git worktree remove` 및 `git branch -d`로 정리했다(exit0, force/prune 없음). tracked 변경은 MAIN/Git에, ignored 원자료는 위 백업에 남아 복구 가능하다. 계획 Task1–6과 상태판을 함께 완료로 갱신했다.
