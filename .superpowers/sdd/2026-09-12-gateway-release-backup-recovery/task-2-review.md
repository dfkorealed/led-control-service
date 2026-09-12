# Task 2 독립 리뷰 — 총괄 전달 원문

아래는 수정 전에 전달받은 리뷰 요청 전문이다.

Task 2 독립 리뷰의 4개 Important를 수정하세요. 같은 worktree/branch, Task2만, TDD/subagent 금지. 먼저 리뷰 전문을 `.superpowers/sdd/2026-09-12-gateway-release-backup-recovery/task-2-review.md`에 보존하세요.
1) site `.env.appliance`의 single-quoted multiline 안 image-key-like line을 awk가 바꾸는 문제: quote-aware exact dotenv mutation을 구현하거나, 지원하지 않을 문법은 mutation 전 명확히 fail-closed하고 원본 완전 보존을 증명하세요. Top-level image keys가 없거나 중복이면 안전하게 exact one each로 생성/교체. unrelated bytes/mode 보존. 실제 Compose 해석 경계에서 candidate가 선택됐는지 확인하고, 실행 container image config digest가 candidate digest와 일치해야 pointer commit 가능. 기존 shim이 같은 regex로 문제를 가리지 않도록 quote-aware/default-image 회귀 포함.
2) ambient GATEWAY_DATA_DIR 및 image env가 검증 경로/후보를 override하지 못하게 모든 compose config/up/down/recovery invocation의 authoritative env를 명시적으로 고정·sanitize하세요. site env에서 검증한 data dir과 image 좌표 resolver를 한 계약으로 만들고 Task3 전달을 보고서에 명시. absent/ambient malicious 회귀.
3) 기존 `/opt/.../gateway` default Compose project와 호환되게 project ownership을 preflight inspect하고 기존 `gateway` 프로젝트는 안전 인계, foreign project/container는 mutation 전 거부. 실제 모든 호출의 project name을 일관되게 사용하고 legacy ownership shim 회귀.
4) coreutils `timeout`을 preflight하고 Docker/Compose load/config/up/down/inspect/log/health 및 recovery 호출에 wall-clock deadline/kill-after를 적용. hanging shim이 bounded exit, recovery 시 journal 유지 또는 안전 rollback하는 회귀.
Focused RED→GREEN, combined release+bundle+appliance tests, Gateway contracts/static/diff. task-2-fix-report.md 작성, 커밋, clean 종료. 실제 Docker/Pi/SSH 금지.
