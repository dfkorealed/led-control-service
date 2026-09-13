# Task 2 — Gateway staged activation과 rollback 보고서

기준일: 2026-09-12

## 상태·범위·커밋

- Task 2 구현, TDD, 요청된 focused/contract/static 검증과 자체 검토를 완료했다. 독립 리뷰는 총괄에게 넘긴다.
- Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`.
- Branch: `codex/p0p1-platform-gateway-release`.
- 시작 HEAD: `51bea965464ebaec854364a6e9653ba7f3dc74c0`.
- 기능 커밋: `945985e6090bf2cc79ec8f170a3a9e0c48992eb2` — `feat(gateway): activate and roll back verified releases`.
- Task 3 state backup, Task 4 CI/runbook/운영 문서, 다른 worktree/main은 수정하지 않았다. 별도 subagent를 실행하지 않았다.
- 실제 SSH, Docker deploy/smoke, Pi, BlueZ/HCI/RF, 운영 key/identity 및 HIL은 실행하지 않았다.

## CLI와 host 전제

```bash
scripts/gateway-appliance-release.sh verify /absolute/bundle --policy-sha256 TRUSTED_SHA256
scripts/gateway-appliance-release.sh activate /absolute/bundle --policy-sha256 TRUSTED_SHA256
scripts/gateway-appliance-release.sh rollback --policy-sha256 TRUSTED_SHA256
scripts/gateway-appliance-deploy.sh user@raspberry-pi [/absolute/bundle]
```

Production root는 `/opt/led-control/gateway`다. 현장 `.env.appliance`, `GATEWAY_DATA_DIR`와 identity가 이미 준비돼 있어야 하며 release manager는 identity를 생성하거나 전송하지 않는다.

테스트는 `--test-root ABSOLUTE_DIR`를 사용하며 mutation 전에 그 root의 일반 파일 `.gateway-release-disposable-root` 내용이 `gateway-release-test/v1`인지 확인한다. 이 경계에서만 health poll을 2회/대기 0초로 줄인다. Production에서는 최대 60회, 간격 2초이며 test-mode 또는 다른 architecture 허용 옵션은 없다.

Pi host에는 Bash, GNU coreutils의 `sha256sum`, `mv -T`, `sync -f`, `find`, `stat`, `cp`, `cmp`, `df`, `du` 등, util-linux `flock`, Docker/Compose가 필요하다. Node나 Python은 필요하지 않으며 어떤 bundle/site/journal도 source/eval하지 않는다. GNU `sync -f`의 filesystem flush가 실패하면 성공으로 간주하지 않는다.

종료 코드: 정상/정상 동일 current `0`, 검증·preflight·후보 실패 후 정상 복구 `1`, CLI 오류 `2`, 중단 복구 불가 또는 재적용/health 복구 실패 `3`, operation lock 경합 `4`. INT/TERM은 EXIT 복구 경로를 거친다.

## 검증 경계

- Task 1의 exact 7개 regular-file closure와 `docker` directory 하나만 허용한다. 추가/누락, symlink, hardlink, special file, unsafe checksum path, checksum 중복·정렬·내용 불일치를 거부한다.
- `appliance.env`는 exact 13개 키, 정렬·중복·누락·ASCII 값·newline 종료를 확인한다. Bash 버전에 따른 NUL 누락 해석을 막기 위해 text의 bytes부터 검사한다.
- schema, version/full commit/hash 형태, timestamp wire 형태, image repository/tag, release ID 계산, archive filename, trusted policy SHA, `linux/arm64`, strict test marker `0`을 확인한다. `1`, `false`, injection text, policy/platform/release ID 불일치는 실패한다.
- Host에서는 manifest와 SPDX를 checksum으로 보호된 opaque 파일로 취급한다. **Node verifier의 JSON 전체·SPDX inventory·image layer·private-material crypto 검증을 재현했다고 주장하지 않는다.** Task 1/CI 검증과 승인된 bundle 전달이 전제다. Checksum과 policy digest는 서명이 아니다.
- Image load 이후 정확한 repository/tag에 대한 `docker image inspect` config digest가 bundle env와 일치해야 한다. Docker/Compose 사용 가능, 현장 env로 Compose config 성공, identity regular/nonempty, device key `0600`, generation 내부 귀속, data/mesh/identity/factory-trust directory와 디스크 여유도 preflight에서 검사한다.

## 파일 배치와 shared lock

```text
ROOT/
  .env.appliance                         # 현장 설정; image repo/tag만 교체, 기존 mode 보존
  .appliance-operation.lock              # release와 후속 state 작업의 공통 flock inode
  .activation.journal                    # 진행 중일 때만 존재, 0600
  .activation-env.snapshot               # 이전 site env, hash 결속, 0600
  current -> releases/RELEASE_ID
  previous -> releases/RELEASE_ID
  releases/
    RELEASE_ID/                          # files 0440, directories 0550
    .staging.UNIQUE/                      # 같은 filesystem의 이번 실행 staging
  runtime/
    RELEASE_ID.yml                       # site env/절대 seccomp 경로를 연결하는 0600 사본
```

Task 3가 재사용할 lock은 **`ROOT/.appliance-operation.lock`**, `flock -n 9`이며 FD 9를 복구 시작 전부터 최종 journal 제거까지 유지한다. Lock 파일은 unlink하지 않는다. 같은 inode를 잠가야 하며 lock 자체의 symlink/hardlink/특수 파일은 거부한다.

Release와 root 경로의 symlink 및 group/other writable 관리 directory를 거부한다. 검증된 입력을 root의 `releases/.staging.UNIQUE`에 복사·flush하고 다시 검증/preflight한 뒤 같은 filesystem에서 final 이름으로 rename한다. 기존 동일 ID는 검증과 checksum 목록 `cmp`가 같을 때만 재사용하며 다른 directory를 덮어쓰지 않는다.

Compose 원본의 상대 `.env.appliance`는 `--project-directory ROOT`로 기존 현장 파일에 연결한다. Seccomp 경로만 선택한 release 내부의 절대 경로로 바꾼 runtime 사본을 사용하며 bundle에 site env나 secret 파일을 추가하지 않는다. Ambient image env가 실제 적용 image를 덮어쓰지 못하게 한다.

## Journal의 exact 계약과 recovery matrix

Journal은 다음 정렬된 키 7개만 허용하는 데이터 파일이다. Snapshot path는 입력에서 받지 않고 root의 고정 파일을 사용한다.

```text
CANDIDATE=RELEASE_ID
ENV_MODE=640
ENV_SHA256=SHA256
OLD_CURRENT=RELEASE_ID_OR_none
OLD_PREVIOUS=RELEASE_ID_OR_none
PHASE=ALLOWLISTED_PHASE
SCHEMA=gateway-activation/v1
```

Snapshot을 먼저 temp+flush+rename하고 hash를 journal에 결속한다. Journal 갱신과 site env 교체도 temp+flush+rename+parent flush를 사용한다. Pointer는 임시 symlink를 `mv -T`로 rename하고 parent를 flush한다.

| durable journal phase | 완료한 동작 | 다음 실행의 복구 |
| --- | --- | --- |
| `prepared` | old pointer/env snapshot 기록 | old env/pointer 복원 후 old release 재적용·healthy |
| `env_switched` | 후보 image repo/tag로 site env 교체 | 동일 복구 |
| `service_started` | 후보 Compose up 완료 | 동일 복구 |
| `healthy` | 후보 health 성공, pointer commit 전 | 동일 복구 |
| `previous_switched` | previous를 former current로 전환 | 동일 복구, old previous도 복원 |
| `current_switched` | current를 healthy candidate로 전환 | journal이 남아 있으면 동일 복구 |
| journal 없음 | 최종 flush된 journal 제거가 commit point | interrupted activation으로 취급하지 않음 |

어느 단계에서든 journal 제거 전 남은 journal은 **새 mutation보다 먼저** 복구한다. Journal/snapshot exact 형식·hash, candidate/old release, 실제 pointer가 journal이 허용한 old/candidate 좌표인지 확인한 뒤 원래 env/pointer를 복원한다. Old current가 있으면 그 검증된 archive를 재적용하고 health까지 성공해야 journal을 제거한다. 최초 설치라 old current가 없으면 후보 Compose down 후 current를 만들지 않는다.

일반 실패와 interruption 모두 같은 복구 함수다. 복구 자체 실패나 손상된 journal/snapshot은 exit `3`과 journal 유지로 종료하며 새로운 후보를 적용하지 않는다. `rollback`은 별도 tag/ID 인자를 받지 않고 previous만 같은 경로로 활성화하며 성공하면 former current가 previous가 된다.

Snapshot은 journal 제거 뒤에도 `0600`으로 보존하고 다음 transaction에서 덮어쓴다. Snapshot을 journal보다 먼저 지우면 그 사이 crash가 복구 불가하고, 이후 지우면 journal-last commit 계약과 어긋나므로 의도적으로 남긴다.

## Deploy 변경

기존 image.tar + loose checksum/env + compose/example 전송과 remote shell sourcing을 제거했다. 현재 CLI는 bundle directory 하나를 host verifier로 확인하고 trusted checkout의 manager와 함께 `mktemp -d /tmp/led-control-gateway-upload.XXXXXX`로 받은 unique staging에 전송한다. Trusted policy SHA는 bundle 밖 CLI 인자로 넘기며 remote manager의 `activate`를 실행한다. 기존 identity, private key, site `.env.appliance`, env example, loose archive sidecar는 전송하지 않는다.

## TDD·검증 증거

최초 RED:

```bash
node --test scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-scripts.test.mjs
```

Exit `1`: **36 tests, 2 passed / 34 failed / 0 skipped**. Release manager 미존재(exit 127)와 old deploy가 bundle directory를 archive로 거부하는 것이 예상 실패 원인이다. 단순 source regex였던 old deploy assertions 2개는 실제 script lifecycle/전송 assertions로 교체했다.

기본 구현 후 focused lifecycle:

```bash
node --test --test-name-pattern='activate health-gates|unhealthy activation|first-install failure|rollback selects|deploy transfers' scripts/gateway-appliance-release.test.mjs
```

**5/5 GREEN**. 초기 fault-injection shim이 설정되지 않은 phase와 undefined를 같다고 보아 정상 실행도 종료시킨 문제는 test harness에서 명시적 crashPhase가 있을 때만 주입하도록 수정했다.

이어 six-phase SIGKILL recovery, recovery failure, malformed snapshot/journal, shared kernel lock, immutable conflict와 host env/checksum 음성 회귀를 함께 확인했다. NUL env 음성 회귀를 추가하고 Bash 버전과 무관하게 bytes를 검사하도록 했다.

최종 combined GREEN:

```bash
node --test scripts/gateway-appliance-release.test.mjs scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-scripts.test.mjs
```

Exit `0`: **160 tests, 160 passed / 0 failed / 0 skipped**, 93.68초. 이 중 release/deploy lifecycle 파일은 38개 top-level test이며, Node runner 집계는 bundle parent/subtest도 포함한다. 모든 phase의 강제 종료 뒤 old env/pointer/service 복구, first-install down, explicit previous-only rollback, rollback recovery 실패 exit 3, lock 경합 exit 4를 실제 임시 파일/symlink로 검사했다.

```bash
pnpm --filter @led-control/gateway test:contracts
bash -n scripts/gateway-appliance-release.sh scripts/gateway-appliance-deploy.sh scripts/gateway-appliance-build.sh
node --check scripts/gateway-appliance-release.test.mjs
node --check scripts/gateway-release-bundle.mjs
node --check scripts/gateway-appliance-scripts.test.mjs
git diff --check
```

Gateway **24/24 GREEN**, Bash/Node syntax 및 diff check exit `0`. 커밋 직전 staged diff check도 exit `0`이었다. pnpm launcher의 기존 설정 위치 경고는 남지만 실패는 없다. Task 4 broad suite, 실제 Docker smoke, 전체 Gateway runtime suite는 이번 범위에서 실행하지 않았다.

## 자체 검토와 한계

- bundle/env/journal의 exact parser, 원자 rename의 `mv -T`, 모든 mutation의 shared lock, preflight 전 site/service 비변경, old pointer/secret snapshot 보존, previous-only rollback을 자체 검토했다.
- macOS에서 실행했으므로 Docker/SSH/SCP는 command shim이다. `flock` shim은 C의 실제 kernel flock syscall을 inherited FD에 적용하며, sync/mv shim은 실제 file/directory fsync와 filesystem rename을 실행한다. Tests의 Node/C 도구는 disposable boundary 전용이며 Pi dependency가 아니다.
- Image archive는 lifecycle shim 경계의 synthetic bytes다. 실제 Docker image import/Compose config resolution, GNU syncfs·util-linux/Bash 조합, ARM64/Pi storage power-loss 검증은 수행하지 않았다. Task 1의 실제 tar/Node verifier 회귀는 combined suite에서 별도로 통과한다.
- Health poll 횟수는 제한하지만 개별 Docker CLI가 응답하지 않는 상황에 대한 별도 전체 wall-clock watchdog은 없다. 실제 daemon hang/HIL 시간 상한은 후속 검토 대상이다.
- SIGKILL이 journal 이전 staging 중 발생하면 service/env mutation은 없지만 미완 staging/temp 파일이 남을 수 있다. 다른 실행이 만든 것으로 보이는 임시 경로를 추정 삭제하지 않는다. Remote upload staging도 자동 정리하지 않는다.
- Checksum/policy는 서명이 아니며 root 권한 공격자나 완전히 재작성된 악성 bundle의 authenticity를 증명하지 않는다. 승인된 build/CI 검증 및 trusted 전달 경로가 필요하다.
- Task 3는 위 shared lock을 재사용해야 한다. 계획 체크리스트·상태판과 Task 4 운영 문서의 수렴은 총괄이 이 증거를 취합해 갱신한다.
