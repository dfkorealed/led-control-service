# Task 2 report: shared/dist reader-writer 경쟁 제거

구현 커밋: `8f6146e7870f5ad0f96ccfacd45a848e710edf8b`

## 결과

- Canonical root `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`가 하나의 repository owner lock을 공유한다. Gate는 lock 안에서 `shared`와 `automation-engine`을 순서대로 한 번씩 build하고 consumer command가 끝날 때까지 소유권을 유지한다.
- API, Gateway, Web, automation, Shared의 canonical leaf `build`/`lint`/`typecheck`/`test`에서 nested dependency writer를 제거했다. 개발·HIL처럼 root gate 밖의 명시적 보조 명령은 필요한 준비 단계를 유지한다.
- Shared publisher는 기존 generation 전체를 먼저 삭제하지 않는다. 동일 path는 기존 파일을 읽을 수 있는 상태로 두고 temp-file rename으로 교체한 뒤, 새 manifest에 없는 이전 manifest-owned stale path만 제거한다.
- Workspace command lock은 정상적으로 실행 중인 긴 consumer를 임의 deadline으로 실패시키지 않는다. 종료 경계에서 owner identity가 잠시 `unknown`이어도 gate 전용 opt-in은 lock을 훔치지 않고 기다린다. Shared writer의 기본 unknown-owner 정책은 계속 fail-closed다.
- Task 1에서 이관된 production audit policy, patched `image-size` parser security, production MQTT config regression을 canonical root test 경로에 각각 정확히 한 번 연결했다.
- Gateway 전체 Vitest는 병렬 filesystem/crypto 부하에서 durable-fence wall-clock 회귀가 간헐 실패한 증거에 따라 한 worker로 고정했다. 제품 timeout과 retry 계약은 변경하지 않았다.

## 원인과 baseline 재현

동시에 실행한 root `pnpm lint`와 `pnpm test`에서 Web TypeScript가 다음 오류로 실패했다.

```text
apps/web/src/features/control/active-command-store.ts(2,44): error TS2307:
Cannot find module '@led-control/shared/dimming-command' or its corresponding type declarations.
```

직접 writer 8개와 declaration reader를 겹친 baseline에서는 `packages/shared/dist/esm/dimming-command.d.ts`가 8/8 publish cycle마다 29~220ms 사라졌다. `packages/shared/scripts/build.mjs`는 writer끼리만 직렬화한 뒤 이전 manifest 파일을 전부 삭제하고 새 결과를 순차 복사했다. 반면 TypeScript/Jest/Vitest/Vite reader는 그 lock을 잡지 않았고, leaf script가 시작한 dependency build는 outer pnpm workspace topology에도 보이지 않았다. 따라서 writer/writer lock은 안전했지만 writer/reader 가용성은 보장하지 못했다.

## TDD 증거

- 실제 Shared publisher를 fixture에 복사하고 cleanup 직후의 명시적 cross-process file barrier에서 writer를 멈춘 뒤 기존 export를 읽는 regression을 먼저 추가했다. 수정 전에는 `dist/index.js` read가 deterministic `ENOENT`로 RED였고, 동일-path pre-delete 제거 뒤 GREEN이었다.
- Whole-workspace owner가 60초보다 오래 실행될 수 있다는 lock regression은 synthetic clock을 크게 진행시켜 기존 deadline 오류를 RED로 만들었다. `timeoutMs: null` opt-in 뒤 deadline 없이 대기하고 GREEN이었다.
- Root script와 leaf graph contract는 기존 root command/nested writers 때문에 0/2 RED였다. Root gate exact entry, shared→automation exact prepare 순서, production contract exact-once, forbidden lifecycle/nested writer 검사를 구현한 뒤 2/2 GREEN이었다.
- 세 번째 concurrent integration에서 이전 owner가 release한 직후 process identity 조회가 일시 `unknown`인 경계가 드러났다. Exact marker는 훔치지 않되 gate만 재확인하는 regression을 RED→GREEN으로 추가했다. 기존 default fail-closed test도 그대로 통과한다.

## 최종 검증

```text
pnpm --filter @led-control/shared exec vitest run \
  src/build-output-lock.test.ts src/package-exports.test.ts
=> 2 files, 90 tests passed (21.56s)

node --test scripts/workspace-gate.test.mjs
=> 2 tests passed

8 concurrent `pnpm --filter @led-control/shared build` + tight declaration poll
=> writers 8/8 exit 0; 82,195 checks; absence 0; final export present
```

Concurrent canonical root gate를 세 번 반복하고 `dist/esm/dimming-command.d.ts`를 tight poll했다.

| 반복 | 먼저 lock을 잡은 command | lint | test | declaration poll |
| --- | --- | --- | --- | --- |
| 1 | test | exit 0, 92.130s | exit 0, 77.086s | 0 / 4,898,994 absent |
| 2 | lint | exit 0, 14.557s | exit 0, 91.177s | 0 / 5,084,957 absent |
| 3 | test | exit 0, 92.135s | exit 0, 78.090s | 0 / 5,000,813 absent |

합계는 root lint/test 3/3 성공, declaration absence `0 / 14,984,764`다. 양쪽 lock 획득 순서를 모두 관찰했다.

```text
pnpm lint
=> Shared, automation, Gateway, API, Web, Mobile passed

pnpm typecheck
=> Shared, automation, Gateway, API, Web, Mobile passed

pnpm build
=> shared → automation 준비 뒤 Gateway, API, Web build passed
=> Web의 기존 >500 kB chunk warning만 남음

pnpm --filter @led-control/shared test
=> 14 files, 200 tests passed

pnpm --filter @led-control/automation-engine test
=> 2 files, 28 tests passed

pnpm --filter @led-control/web test
=> 59 files, 677 tests passed

pnpm --filter @led-control/gateway test
=> 64 files, 608 tests passed

pnpm --filter @led-control/api test
=> 112 suites passed, 28 skipped; 1,103 passed, 289 environment-gated skipped

pnpm --filter @led-control/shared --filter @led-control/automation-engine \
  --filter @led-control/gateway --filter @led-control/api \
  --filter @led-control/web -r typecheck
=> all passed

canonical root Node contract group
=> 33/33 passed; audit/image/MQTT included once each

git diff --check
=> passed
```

## 관찰한 비제품 test 불안정성

초기 full root test에서 Gateway durable-fence `4098` wall-clock case가 전체 file-level 병렬 부하 아래 두 번 실패했다. 해당 focused test는 즉시 1/1 통과했고, Gateway 전체 suite를 one-worker로 실행하면 64 files/608 tests가 35.47s에 통과했다. Canonical Gateway test script를 `--maxWorkers=1 --minWorkers=1`로 고정해 test scheduling을 결정적으로 만들었고 제품 코드의 deadline이나 retry는 늘리지 않았다.

## 남은 위험과 운용 계약

- Root gate를 우회해 leaf command를 직접 실행하려면 먼저 `pnpm workspace:prepare`가 필요하다. 직접 ad-hoc writer와 reader를 동시에 실행하는 경로까지 repository gate가 강제하지는 않는다.
- Shared publisher는 동일 path의 `ENOENT` window를 제거하지만 여러 파일을 한 directory transaction으로 교체하지는 않는다. Root gate가 canonical consumer를 한 generation에 고정하고, per-file replacement가 비정상 종료 시 기존 또는 새 완전 파일을 보존한다.
- Repository lock은 같은 checkout의 local filesystem 범위다. 별도 worktree는 자체 output과 lock을 가지며, network/distributed lock은 아니다.
- Gate의 no-deadline/unknown-owner wait는 active command를 잘못 훔치지 않는 쪽을 택한다. 운영자가 강제 종료 또는 손상된 owner marker를 수동 처리해야 하는 상황은 명시적으로 fail-safe 대기가 될 수 있다. Shared writer 자체는 unknown identity에서 기존처럼 즉시 fail-closed한다.
- API의 289개는 PostgreSQL/MinIO 등 environment-gated case라 이번 local software run에서 skip되었다. 사용자 DB·운영 서비스·실장비·CI workflow·main은 변경하지 않았다.
- Web production build의 기존 chunk-size warning은 이번 경쟁 제거 범위 밖이며 Task 3 CI/HIL 후속에서도 별도 성능 판단이 필요하다.

## Review fix: release handoff, signal lifetime, RealBackendLab cold output

리뷰 수정 구현 커밋: `82d0e182dbef7ea0efdf9c4d175f7388eb115ac6`

리뷰의 Important 3건을 각각 deterministic RED 뒤 수정했다.

- Release handoff RED는 old owner의 exact marker unlink와 old directory `rmdir` 사이에 successor marker를 publish했다. 기존 결과는 `oldReleaseResult=false`였지만 successor marker는 온전했다. Exact marker unlink가 끝난 시점을 ownership release 완료로 정의해 후속 `ENOENT`/`ENOTEMPTY`를 safe handoff success로 반환한다. Marker unlink 전에 owner가 달라진 기존 fencing은 계속 `false`이고 successor를 건드리지 않는다.
- Process RED는 실제 gate와 fake pnpm/ps를 별도 filesystem fixture에서 실행했다. 기존 `spawnSync` gate에 SIGTERM을 보내자 gate만 죽고 old consumer가 살아 있는 동안 successor가 `consumer-started`를 publish했다. Gate는 이제 detached async child를 소유하고 catch 가능한 SIGINT/SIGTERM을 child process group에 전달한다. Child exit를 받은 뒤에만 lock을 release하고 실제 child/gate signal semantics로 종료한다. SIGINT와 SIGTERM 모두 old child가 살아 있는 동안 successor가 active owner 대기를 관찰하고, old child 종료 뒤 successor가 실행되며 orphan/lock이 남지 않는다.
- RealBackendLab RED는 기존 `packages/automation-engine/dist`를 임시 backup으로 격리하고 실제 startup build를 Prisma 직전까지만 실행했다. 기존 shared-only 준비는 automation entry를 만들지 못했다. `RealBackendLab.start()`가 root `workspace:prepare`를 호출해 shared→automation을 준비하도록 연결했으며, test는 생성된 `dist/index.js`를 확인한 뒤 원래 warm output을 복원한다. DB, service, browser journey는 시작하지 않는다.

Review fix 최종 증거:

```text
pnpm --filter @led-control/shared exec vitest run \
  src/build-output-lock.test.ts src/package-exports.test.ts
=> 2 files, 91 tests passed (23.36s)

node --test scripts/workspace-gate.test.mjs
=> 4/4 passed: root/leaf contracts, SIGINT lifecycle, SIGTERM lifecycle

pnpm --filter @led-control/web exec playwright test \
  e2e/real-backend-lab-support.spec.ts --project=chromium
=> 14/14 passed, including isolated cold automation output

concurrent `pnpm lint` + `pnpm typecheck` with lock/export polling
=> both exit 0; distinct owner PIDs 8533, 8534
=> declaration absence 0 / 648,191; final lock absent; export present

git diff --check
=> passed
```

Catch 가능한 SIGINT/SIGTERM만 graceful child drain을 보장한다. `SIGKILL`, host crash, power loss는 전달하거나 await할 수 없으므로 다음 contender가 stale owner recovery를 수행하며, 해당 crash 이후의 외부 orphan side effect는 OS/process supervisor 책임으로 남는다.

## Review fix round 2: pnpm descendant process-group lifetime

리뷰 수정 구현 커밋: `865520aee3b2c98478358656a0cf02f6169b1bc0`

첫 review fix의 process test는 gate의 direct pnpm child만 signal 뒤 살아 있게 했기 때문에 pnpm leader보다 오래 사는 descendant를 검증하지 못했다. 실제 문제는 gate가 leader의 `exit` event만 기다린 뒤 lock을 해제한다는 점이었다. 동일 process group의 grandchild가 signal을 받았지만 cleanup barrier에서 계속 살아 있는 동안에도 leader와 gate가 먼저 끝나 successor가 lock을 획득할 수 있었다.

Round 2 regression은 SIGINT와 SIGTERM 각각에 대해 실제 gate → fake pnpm leader → same-group grandchild process tree를 만든다. Grandchild의 signal 수신과 leader reap을 file event로 확인한 뒤 successor를 시작한다. 수정 전 두 case 모두 successor가 `consumer-started`를 먼저 publish해 RED였다. 수정 뒤 successor는 old gate owner를 세 번 연속 관찰하는 동안 실행되지 않고, grandchild barrier 해제와 전체 group 종료 뒤에만 실행한다. Old leader와 grandchild가 모두 사라지고 repository lock도 남지 않는 것을 확인한다.

POSIX gate는 leader exit code/signal을 저장한 뒤 `kill(-pgid, 0)` ownership observation이 `ESRCH`를 반환할 때까지 lock을 유지한다. `EPERM`은 group 부재가 아니므로 live로 취급해 계속 대기하고 lock을 해제하지 않는다. Correctness timeout은 없다. Windows에는 동등하게 신뢰할 descendant-tree termination/wait primitive를 구현하지 않았으므로, platform preload regression으로 lock 획득과 pnpm child 시작 전에 명시적으로 실패한다. Guard 제거 mutation에서는 fixture가 exit 0으로 child marker를 만들었고, guard 복원 뒤 exit 1이며 lock/child marker가 모두 없었다.

```text
node --test scripts/workspace-gate.test.mjs
=> 5/5 passed
=> root/leaf contracts, SIGINT group lifetime, SIGTERM group lifetime,
   Windows pre-lock fail-closed

concurrent `pnpm lint` + `pnpm typecheck` with lock/export polling
=> both exit 0; distinct owner PIDs 18636, 18648
=> declaration absence 0 / 651,148; final lock absent; export present

git diff --check
=> passed
```

`SIGKILL`, kernel/host crash, power loss는 여전히 catch/forward/await할 수 없다. Windows canonical workspace gate는 현재 사용할 수 없으며, 향후 dependable Job Object 기반 descendant tree ownership을 구현하고 동일 process regression을 통과하기 전에는 지원으로 표시하지 않는다.

## Review fix round 3: reaped leader PGID signal fencing

리뷰 수정 구현 커밋: `86acd036637938a328de113bcb2f3a79575fade6`

Round 2는 pnpm leader를 reap한 뒤에도 `activeChild.pid`를 신호 대상으로 남겨 두었다. 그 사이 OS가 동일 numeric PGID를 무관한 process group에 재사용하면 drain 중 뒤늦은 SIGINT/SIGTERM이 그 group에 잘못 전달될 수 있었다. Group existence 관찰은 lock lifetime에 필요하지만, reap된 leader의 numeric PID는 더 이상 signal authority가 아니다.

Deterministic regression은 SIGINT와 SIGTERM 각각에 대해 실제 gate → fake pnpm leader → same-group grandchild를 실행했다. Leader 생존 중 첫 shutdown signal이 grandchild에 도달하고 leader가 종료된 후, preload된 `process.kill` probe가 이제 재사용된 unrelated group을 대표하는 음수 PID 신호를 감지하도록 했다. 반대 종류의 late signal을 gate에 보낸 RED에서 두 case 모두 `unrelated-group-signaled`가 생성되어 `Missing expected rejection`으로 실패했다.

Gate signal state를 owned와 drain으로 분리했다. Child leader identity가 live인 owned 단계의 첫 catchable signal만 process group에 전달한다. Child `exit` callback 진입 즉시 drain으로 전환하고, callback 전 race는 `exitCode`/`signalCode`로 추가 fencing한다. Drain에서는 `kill(-pgid, 0)`으로 group이 `ESRCH`가 될 때까지 관찰만 하며 nonzero signal은 보내지 않는다. Late signal은 기록해 group 종료 뒤 gate의 최종 signal semantics에 반영하고, 그 전까지 lock을 유지한다.

```text
node --test --test-name-pattern="reused group" scripts/workspace-gate.test.mjs
=> RED: SIGINT/SIGTERM 0/2 passed; both published unrelated-group-signaled
=> GREEN: SIGINT/SIGTERM 2/2 passed

node --test scripts/workspace-gate.test.mjs
=> 5/5 passed: root/leaf contracts, SIGINT/SIGTERM descendant lifetime and
   reused-PGID fencing, Windows pre-lock fail-closed

concurrent `pnpm lint` + `pnpm typecheck` with lock/export polling
=> both exit 0; distinct owner PIDs 34227, 34239
=> declaration absence 0 / 315,396; final lock absent; export present

git diff --check
=> passed
```

이 fencing은 reap 후 numeric PGID 관찰을 그 group에 신호를 보낼 권한으로 사용하지 않는다. 안전을 위해 late cancellation이 자연스럽게 drain되는 descendant 뒤로 지연될 수 있다. `EPERM`은 계속 live/unknown으로 fail-closed하고, Windows는 동등한 tree ownership이 없으므로 기존대로 lock 전에 실패한다. `SIGKILL`, kernel/host crash, power loss는 catch 범위 밖이다.
