# Task 1 독립 리뷰 findings

기준일: 2026-09-12

- 리뷰 대상 HEAD: `edd4d027902d98cee00e0754dc58dfebec498161` (기능 `574689f7da8d929f90a42e9fbe97fad14f556163`).
- 판정: Important 2건 / Minor 1건. 아래 내용은 총괄이 전달한 reviewer findings를 수정 전에 그대로 기록한 것이다.
- 이번 수정은 Task 1에 한정하며 Task 2/3/4, Docker smoke, 운영 키·실장비·배포·HIL은 실행하지 않는다.

## Important 1 — final visible inventory / OCI overlay whiteout

> scripts/gateway-release-bundle.mjs image inventory extraction이 full OCI overlay whiteout semantics를 처리하지 않아 later layer의 root/ancestor .wh.usr, .wh..wh..opq, usr/.wh..wh..opq, usr/local/.wh..wh..opq 등이 inventory를 가려도 stale inventory를 accept 가능. 각 ancestor delete/opaque marker의 inventory 전/후 multi-layer RED tests 후 full semantics로 fix하고 final visible inventory require.

## Important 2 — DER / base64 private material

> private material scan이 filename/literal PEM header뿐이라 DER/PKCS#8 private key 및 allowed filename 안 base64 PEM 우회 가능. 실제 Node crypto parsing 등으로 enforceable content detection을 구현하고 bundle-controlled text/image layer에서 DER 및 base64-wrapped known private keys를 reject하는 RED tests를 추가. raw secret 일반론을 과장하지 말고 정확한 보장 범위를 manifest/docs/report에 기술.

## Minor 1 — shell test-mode wire value

> appliance.env GATEWAY_RELEASE_TEST_MODE를 strict 0|1로 변경하고 parser/serialization tests 고정.

## 검증 조건

민감한 fixture는 테스트 전용 ephemeral 생성 또는 synthetic/non-operational만 사용한다. 원문을 로그/보고서에 남기지 않는다. Focused tests와 Gateway contracts/static을 실행하고 `task-1-fix-report.md`에 RED/GREEN 명령·정확한 결과·보장 범위·남은 한계를 기록한 뒤 커밋한다.
