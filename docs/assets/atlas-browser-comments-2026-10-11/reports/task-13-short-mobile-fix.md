# Task 13 short-mobile 후속 수리

- 기준 제품HEAD `e9d72b91`. 수리 commit `4802b641` (3files,7insertions,2deletions). 원 실패 증거는 task-16-initial-results/task-16-local-results에 그대로 보존하며 삭제0.
- RED는 실제 QA `browser comments short mobile: natural scroll exposes monitoring and manual actions`다. 390×600에서 body 실제wheel83 뒤 documentheight779/scrollY179=max179, 전체로그열기 rect x251.09375/y547/w109.90625/h44/bottom591/navTop532, centerreachablefalse로 최대scroll에도59px 가림을 확인했다. 578/681 tall fill은 당시PASS로 구분한다.
- 원인: Monitoring screen은 h-full/min-h0 유한 flex 높이지만 지도행은 min-h-min이다. 짧은 viewport에서 지도행/ticker가 screen 밖으로 overflow되어 screen 내부pb68이 ticker뒤 실제 scroll extent로 보존되지 않는다. 일반 compact screen에도 min-h-min을 주어 자식 자연최소+padding을 screen 최소높이에 포함시키는 1선언 보완을 적용했다. QA가 short ancestor computed height/padding/scrollHeight와 최종reachability를 확인한다.
- 변경: `apps/web/src/features/monitoring/MonitoringView.tsx` 일반 compact에 `max-compact:min-h-min`과 이유 주석, 기존 `MonitoringView.test.tsx` safe-space 소유 assertion 보완, `docs/menus/monitoring.md` 한계 포함 후속 기록. 다른 메뉴·Shell·API/DB/토큰/dependency/viewport240/contain:size/flex1/camera/renderer/전체보기 수명은 수정하지 않았다. E2E는 QA소유라 staging제외한다.
- 직접검증 한 번: `PATH='/tmp/atlas-ui-fidelity-node22.xde1wS/bin':$PATH pnpm --filter @led-control/web exec vitest run src/features/monitoring/MonitoringView.test.tsx -t 'one screen safe-space|compact map and ticker' --reporter=dot` exit0, 2PASS/103비선택, 2.47초. unit은 emitted layout 선언 검증이지 실제 pixel/scroll 성공 증거가 아니다.
- `git diff --check` exit0. 전체Web/타입/UI정책/빌드/브라우저 재실행0. QA short+영향tall 최대3cases 및 root ui/build(tsc포함) 후속 대기이며 현재 실제 short 수리 성공을 주장하지 않는다.
