# 랜딩·Final Atlas 통합 검증

기준일: 2026-09-27

## 범위

사용자가 지정한 개발 checkout `/Users/kim-jh/Documents/led-control-service`의 `codex/mvp1-cloud-web-clean-base-20260927` (`b429f856`)과 검증된 `codex/final-atlas-implementation` (`f943de42`)을 통합한다. 별도 worktree가 점유한 `codex/mvp1-cloud-web`, 맵 WIP `675184ff`, 사용자 미커밋 변경은 이동하거나 포팅하지 않는다. 운영 DB·배포·실장비·push는 제외한다.

## 체크리스트

- [x] clean base에서 `codex/integrate-atlas-landing-20260927`을 생성했다.
- [x] 다섯 충돌에서 랜딩/보존 logger 허용 필드, 배포 fixture override, 양쪽 운영 절차·교훈·상태 이력을 함께 보존했다.
- [x] Prisma generate/validate, logger 10/10, production contract 27/27을 통과했다.
- [x] 격리 PostgreSQL 신규 123개, 랜딩 이력 101→123개, Atlas 이력 120→123개 migration 적용을 통과했다. 실제 DB는 변경하지 않았다. 실행 도구는 무시된 `.local/atlas-integration-migrations.ts`이며 각 경로는 별도 DB에서 실행하고 종료 후 소유 cluster를 제거했다.
- [x] canonical root lint/typecheck/build 통과. root test의 Root 143·Shared 411·Automation 28·Mobile 6·Web 2,574·API 2,936·Gateway 1,408개는 통과했다. Root 4·Web 3·API 822개 환경 제외는 성공에 포함하지 않는다.
- [x] `/login` 진입, DB 시각 retention 앵커 mock, Atlas drawer·제어 heading 선택자를 test-only로 정합했다. 기존 44px hit-area oracle를 유지하고 실제 44×44/둥근모서리 10px/corner hit=false였던 최근 이력 버튼 두 개를 52px 높이로 보정했다. 소프트웨어 UI 검증이며 실제 장비 검증이 아니다.
- [x] 최초 focused Chromium 59 passed/16 failed를 수집했다. 위 정합 후 75개 중 73 passed/2 failed는 최근 이력의 두 번째 버튼 touch-area였으며, 해당 보정 뒤 제어 31/31을 통과했다. 동일 범위의 앞선 랜딩 31/31·auth/operator 5/5·보존 8/8을 합쳐 75개 시나리오의 성공 증거를 확보했다. 마지막 버튼 수정 뒤 관련 unit 12/12·Web typecheck 포함 production build도 통과했다. 앞선 관련 unit 147/147도 통과했다.
- [x] **당시 통합 이력**: 사용자가 기존 랜딩 작업의 정책 부채를 변경하지 않고 통합하도록 명시적으로 지시했다. canonical root test는 정책 61 passed/1 failed, `ui:check` 927건으로 계속 실패하며 GREEN으로 기록하지 않는다. 마지막 제품 보정 뒤에도 finding 전체 목록이 동일함을 확인했고 다음 여섯 파일은 기준 `b429f856` 대비 변경 0이다: `PublicSiteLayout.tsx` 2, `field-day.css` 919, `MapDemo.tsx` 3, `MonitoringDemo.tsx` 1, `ReportDemo.tsx` 1, `public/concepts/field-day.css` 1. 정책 baseline·코드 예외는 완화하지 않았다.
- [x] 통합 merge `04de3375`를 만들었고 독립 리뷰의 새 P0–P2 지적 0을 확인했다.
- [ ] 승인된 clean-base 브랜치 fast-forward는 미완료다. 현행 게이트는 랜딩 정책 0건·fresh 전체 회귀·최종 리뷰이며, 아래 과거 부채 수용을 면제로 사용하지 않는다. 승인 전 Task 8의 Chromium 73 passed/4 failed(색 대비)와 Node 24 root 두 실패는 당시 이력이며 SIGSEGV 근본 원인은 미확정이다. 이후 사용자의 두 foreground 승인과 좁은 테스트 보완을 반영해 Chromium 80/80·후속 집중 검사, 새 124 PNG/20너비·실제 nginx 경로와 시각 잔여 인과 분류를 완료했다. 부모 Node 22 기본 root test/lint/typecheck/build가 모두 통과했다(Root 143/4 skipped, Shared 411, Automation 28, Mobile 6, Web 2,577/3 skipped, API 2,936/822 skipped, Gateway 1,408, 정책 65/65·UI 0/0). 후속 테스트·문서 수정의 Task 8 재검토와 전체 브랜치 독립 리뷰는 대기 중이다. 통합/fast-forward를 실행하지 않았다.

## 유지할 경계

- 공개 상담은 landing ingress secret과 OAuth/mail 계약을 유지한다. 명령 상세 보존은 기본 OFF와 DB 준비 검증을 유지한다.
- migration 원본 이름·checksum을 변경하지 않는다. timestamp prefix가 같은 서로 다른 migration도 모두 남긴다.
- 맵 WIP는 ordered painter의 encoded LRU 예산 경계를 바꾸므로 별도 검증 전 합치지 않는다.
- 당시 기존 랜딩 UI 정책927건을 수용한 결정은 역사 기록이다. 현재 통합은 정책 0건·fresh 회귀/최종 리뷰를 요구하며 정책 예외나 root 성공으로 확대하지 않는다.

## 검증 기록

무시된 `.local/atlas-integration-root-test.log`, `atlas-integration-ui-policy.log`, `atlas-integration-ui-policy-final.log`, `atlas-integration-browser.log`, `atlas-integration-browser-fixed.log`, `atlas-integration-touch-red.json`, `atlas-integration-browser-final.log`, `atlas-integration-control-final.log`, `atlas-integration-web-build.log`에 실제 결과가 있다. 최초 실패와 후속 성공을 서로 덮어쓰지 않았다. merge `04de3375` 생성·독립 검토는 완료했고 clean-base fast-forward는 미완료다. 당시 Root 147/143 passed/4 skipped 기록과 현재 Task 8의 fresh 두 차례 root 실패를 구분한다. 현행 랜딩 0건/전체 회귀·최종 검토 게이트 뒤 통합 판단은 총괄이 수행한다.
