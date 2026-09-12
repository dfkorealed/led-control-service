# Task 1 최종 ASCII whitespace 수정 보고서

기준일: 2026-09-12

## 상태·범위·커밋

- 마지막 Important인 one-level base64의 FF/VT 누락만 TDD로 수정했다. 독립 재검토 판정은 총괄에게 넘긴다.
- Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`
- Branch: `codex/p0p1-platform-gateway-release`
- 수정 전 HEAD: `6fa5255e42d0a2d45429c71df4fe1006e191034a`
- 코드·테스트·문서 커밋: `33e5bdca187ea91c334c15edfc695b82ad78d589` — `fix(gateway): normalize all ASCII base64 whitespace`
- Task 2/3/4 및 다른 worktree/main은 수정하지 않았다. 별도 subagent를 실행하지 않았다.

## Finding과 최소 수정

Manifest profile은 `one-standard-base64-layer-with-ascii-whitespace`인데 기존 정규화는 HT/LF/CR/Space만 제거했다. FF (`0x0c`)와 VT (`0x0b`)가 base64 시작 및 내용을 분리하면 실제 CLI가 private DER/PEM을 허용했다.

Production 변경은 정규식을 `/[\x09-\x0d ]/g`로 바꾼 한 줄이다. ASCII whitespace인 HT/LF/VT/FF/CR/Space를 모두 제거하고, 기존 별도 normalized carry·one-level decoding·crypto parsing·상한을 유지한다. Unicode whitespace나 다른 encoding을 새로 지원하지 않는다.

테스트는 실행마다 ephemeral EC key를 만들고 PKCS#8 DER/PEM의 base64를 네 글자마다 FF 또는 VT로 분리한다. Bundle `compose.yml` fixture에서는 첫 separator가 byte offset 65,536에 오도록 하여 default 64 KiB stream chunk를 가로지르게 했다. 같은 payload를 image layer의 허용 파일명에도 넣어 실제 `create`와 `verify` 거부를 확인했다. Image verify는 config digest, release ID, env, SPDX/checksum까지 재결속하여 단순 hash mismatch에 기대지 않는다.

추가한 8개 음성 child case와 parent test가 runner 기준 9 tests다. FF/VT를 넣은 공개 SPKI 양성 대조군도 통과했다. 기존 공개 SPKI·OS CA PEM 회귀도 전체 실행에서 유지했다. Key 원문/base64/passphrase는 로그·보고서에 남기지 않았고 운영 키를 읽지 않았다.

## TDD 증거

실행 환경: macOS / Node `v24.19.0`. 숫자는 parent/subtest를 포함한 실제 Node runner 집계다.

### RED — production 변경 전

```bash
node --test --test-name-pattern='ASCII whitespace FF/VT' scripts/gateway-release-bundle.test.mjs
```

Exit **1**, **9 tests / 0 passed / 9 failed / 0 skipped** (2.03초).

DER/PEM × FF/VT × bundle stream boundary/image layer의 8 cases가 실제 CLI의 exit **0** 때문에 실패했다. 기대 값은 private key material 거부 exit **1**이었다. 테스트 실패는 누락된 FF/VT 정규화로 키가 받아들여짐을 재현했으며 문법·fixture 오류가 아니었다.

### GREEN — 최소 수정 후

```bash
node --test --test-name-pattern='ASCII whitespace FF/VT' scripts/gateway-release-bundle.test.mjs
```

Exit **0**, **9 tests / 9 passed / 0 failed / 0 skipped** (2.64초).

```bash
node --test scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-scripts.test.mjs
```

Exit **0**, **124 tests / 124 passed / 0 failed / 0 skipped** (34.33초). 실제 fixture CLI 및 Bash build, 기존 whiteout/crypto/checksum/env/path/공개키·CA 회귀를 포함한다. Bash build는 fixture Docker 경계를 사용하며 실제 Docker smoke가 아니다.

```bash
pnpm --filter @led-control/gateway test:contracts
```

Exit **0**, **24 tests / 24 passed / 0 failed / 0 skipped**. 기존 pnpm 설정 위치 경고는 출력됐고 검증 실패는 없었다.

```bash
bash -n scripts/gateway-appliance-build.sh && node --check scripts/gateway-release-bundle.mjs && git diff --check
```

Exit **0**. 코드 커밋 전 `git diff --cached --check`도 exit **0**이었다. 보고서 커밋 전에도 diff 검사를 수행했다.

## 변경 파일·자체 리뷰

- `scripts/gateway-release-bundle.mjs`: ASCII whitespace 범위 한 줄 수정.
- `scripts/gateway-release-bundle.test.mjs`: 실제 ephemeral private DER/PEM, FF/VT 및 stream 경계, image create/verify, 공개 SPKI 대조군 회귀.
- `apps/gateway/RELEASE-BUNDLE.md`: 지원하는 여섯 ASCII whitespace를 정확하게 열거.
- `.superpowers/sdd/2026-09-12-gateway-release-backup-recovery/task-1-final-fix-report.md`: 이번 RED/GREEN과 한계 기록.

자체 리뷰에서 production diff가 정규화 한 줄뿐이며 schema/profile, scan bound, shell serialization, 다른 Task 동작이 바뀌지 않았음을 확인했다. 일반 secret 탐지 보장으로 범위를 확대하지 않았다.

## 우려사항·명시적 미실행

- 검사는 기존 bounded profile 그대로다. 일반 password/token/raw symmetric key, 임의 obfuscation, 재귀/다른 encoding, 복호화·압축 해제 등을 보장하지 않는다.
- 이번 검증은 Node 24 호스트 fixture다. Node 22 실제 image/runtime·Docker smoke는 Task 4이며 실행하지 않았다.
- 이번 한 줄 tooling 수정에 Gateway 전체 package unit/typecheck/build는 재실행하지 않았다. 위 CLI/Bash·contracts·static 결과만 이번 실행의 증거다.
- 실제 Docker build/load/run, 운영 키/identity, 배포, 실장비/HIL, DB/migration은 실행하지 않았다.
