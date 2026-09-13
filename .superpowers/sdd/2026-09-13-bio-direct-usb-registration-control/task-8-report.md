# Task 8 report — Non-root raw USB deployment and MQTT baseline recovery

## 상태

`DONE_WITH_CONCERNS`

Task 8의 non-root 단일 raw USB software 배포 계약과 Raspberry Pi read-only preflight를 구현·검증했다. 그러나 기존 운영 MQTT baseline은 DNS와 TLS hostname 단계에서 실패했고 healthy heartbeat 3회를 확인하지 못했다. 안전 관문에 따라 새 BIO image 배포, 운영 container 재생성, 조명 주소/제어 명령은 실행하지 않았다.

## 기준과 커밋

- 확인한 clean base: `930a52e54a8c0f1d9b39df80889ab96769c26b7a`
- 구현 커밋: `b80e550` — `feat(gateway): deploy one BIO raw USB device safely`
- self-review hardening: `42a9210` — `fix(gateway): prevent BIO preflight root overrides`
- DB schema와 firmware는 변경하지 않았다.

## 구현

### Exact-one host/container preflight

- sysfs에서 허용된 BIO VID:PID가 정확히 한 대인지 매 실행 다시 계산한다.
- 현재 bus/device 번호로 계산한 node가 실제 character device인지, sysfs의 major/minor와 같은지, GID가 숫자인지 모두 확인한다.
- host preflight 결과를 compose에 전달한 뒤 container entrypoint가 같은 identity/node/GID를 다시 확인한다. test root override는 entrypoint가 제거하므로 production container 검증을 우회할 수 없다.
- 오류와 보고서에는 raw USB node, descriptor, protocol payload 또는 장치 identity를 남기지 않는다.

### 최소 권한 compose와 entrypoint

- BIO overlay는 preflight가 계산한 node 하나만 동일 container 경로에 `rwm`으로 전달하고 숫자 supplemental group 하나만 추가한다.
- `privileged`, root user, whole `/dev`, whole `/dev/bus/usb` mapping은 추가하지 않았다.
- BIO entrypoint는 D-Bus daemon, `btmgmt`, `bluetooth-meshd`, HCI setup을 실행하지 않는다.
- 숫자 GID가 image의 `/etc/group`에 없을 수 있어 Docker가 준 supplementary group을 보존한 채 `gateway` UID/GID로 전환한다. 동시에 bounding/inheritable/ambient capability를 모두 제거하고 Node만 `exec`한다.
- 기존 BlueZ branch의 D-Bus, HCI reset, mesh daemon, non-root Node 시작 순서는 유지했다.

### Fail-closed deploy와 rollback capture

- `--adapter bio-usb`만 명시적으로 허용하고 unknown/hybrid 값은 SSH 전에 거부한다. 인자가 없으면 기존 `bluez` 경로다.
- 현재 container image/lifecycle metadata, compose, env, Gateway/Mesh data archive를 권한 제한된 rollback directory에 먼저 기록한 뒤 BIO preflight를 실행한다.
- preflight 성공 뒤에만 image 좌표, adapter, 현재 USB node/GID를 env에 원자 반영하고 base compose와 BIO overlay로 Gateway service 하나만 강제 재생성한다.
- 재연결로 bus/device 번호가 바뀌면 저장된 node를 그대로 재사용하지 않고 deploy preflight를 다시 거쳐야 한다.

### MQTT ACL

- provisioning device-terminal application ACK를 Gateway read-only topic으로 production example과 dev renderer에 추가했다.
- acceptance/device-status는 기존 write-only 방향을 유지했다.
- wildcard ACK ACL은 추가하지 않았다.
- 이 변경은 저장소 계약에만 적용했다. 운영 broker ACL은 변경하지 않았다.

## Strict TDD 증거

초기 RED:

```text
planned Task 8 Node contracts: 43 passed, 7 failed
```

의도된 실패는 BIO overlay 없음, preflight 없음, entrypoint adapter 분기 없음, rollback/preflight deploy 경로 없음, device-terminal ACK ACL 없음이었다.

GREEN:

```text
planned Task 8 Node contracts: 50 passed, 0 failed
expanded Docker/deploy/dev-runtime contracts: 55 passed, 0 failed
Gateway full suite: 76 files, 974 passed
```

각 production 변경 전에 해당 RED를 확인했고, 중간 fixture가 compose env 파일과 shell inner-case를 잘못 경계 짓던 두 테스트는 production 동작을 완화하지 않고 실제 compose rendering과 outer adapter branch 기준으로 바로잡았다.

Self-review RED:

```text
deploy preflight root override 차단: 5 passed, 1 failed
```

Remote deploy와 container entrypoint 모두 test-only root override 환경을 제거하도록 보완한 뒤 focused `10/10`으로 전환했다.

## Fresh 검증

```bash
node --test apps/gateway/docker/compose-contract.test.mjs apps/gateway/docker/container-contract.test.mjs scripts/gateway-bio-usb-preflight.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/dev-runtime.test.mjs
node --test apps/gateway/docker/*.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/gateway-host-prepare.test.mjs scripts/dev-runtime.test.mjs
pnpm --filter @led-control/gateway test
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway build
bash -n scripts/gateway-bio-usb-preflight.sh scripts/gateway-appliance-deploy.sh
sh -n apps/gateway/docker/entrypoint.sh
git diff --check
```

결과:

- planned contracts `50/50`
- expanded contracts `55/55`
- Gateway `974/974`
- typecheck exit `0`
- build exit `0`, `dist/gateway.mjs 659.2kb`
- 모든 변경 shell syntax와 diff check exit `0`

## Live read-only 진단

### 운영 container 기준선

진단 전후 모두 다음 값이 같았다.

- container identity: `b6fe1713c404…`
- image ref: `led-control-gateway:a965f05f0261`
- image identity: `bd2d3a019f0a…`
- StartedAt: `2026-09-09T22:29:21.159845542Z`
- running: `true`
- restart count: `0`

Pi의 production container, image, compose, env, assignment, certificate, ACL과 data는 변경하지 않았다. 따라서 live rollback artifact를 새로 만들 필요가 없었고 현재 실행 상태 자체가 보존됐다.

### USB preflight 경계

새 image를 배포하거나 장치를 container에 전달하지 않고 host에서 read-only로 실행했다.

- exact approved device count: `1`
- character device: `true`
- sysfs/node identity match: `true`
- numeric GID: `true`

raw node와 descriptor 값은 기록하지 않았다.

### MQTT systematic-debugging 결과

1. **설치 원장 대 assignment**: Lab 설치 원장의 intended broker는 `mqtt.led.lan:8883`이고 Pi assignment도 같은 hostname/port와 config version `1`이었다. assignment가 잘못됐다는 증거가 없으므로 수정하지 않았다.
2. **실행 환경 drift**: 현재 현상이 아니라 확인한 현재 API process의 effective public MQTT URL은 local-only 주소였다. 실행 중 broker도 intended hostname용 TLS identity가 아니었다. 이는 설치 원장/assignment보다 현재 Lab service 실행 context가 달라졌다는 증거다.
3. **DNS**: Pi host와 기존 container 모두 intended hostname을 해석하지 못했다.
4. **TCP 8883**: 현재 Lab host IP로의 TCP 연결은 통과했다.
5. **TLS SAN/mTLS**: intended hostname을 SNI와 hostname verifier에 고정한 handshake는 서버 인증서 hostname 불일치로 실패했다. 이 단계가 실패했으므로 인증서나 trust를 추측 변경하지 않았다.
6. **MQTT CONNACK**: 선행 TLS 검증이 실패해 시도하지 않았다.
7. **heartbeat gate**: 6초 간격 세 표본 모두 published heartbeat가 없고 MQTT connected도 false였다.

단일 assignment 변경으로 DNS와 TLS identity를 동시에 올바르게 만들 수 없으며, local-only 주소를 Pi assignment에 쓰는 것도 올바른 원격 broker 경로가 아니다. 따라서 assignment, certificate, live ACL을 변경하지 않고 deployment gate를 닫았다.

## 문서

- `docs/menus/monitoring.md`: 최소 권한 배포 software 상태와 production baseline 차단을 반영했다.
- `docs/menus/settings.md`: preflight/overlay/rollback 계약과 아직 production 등록 완료가 아님을 반영했다.
- `docs/menus/control.md`: non-root/capability 제거와 exact ACL 방향, 미배포 경계를 반영했다.

## 우려와 후속 관문

- 현재 Lab API와 broker를 설치 원장의 DNS/SAN 환경으로 다시 기동하고 Pi/container DNS를 같은 intended endpoint로 복구해야 한다. 이 작업은 Task 8에서 허용된 좁은 assignment 수정이 아니므로 수행하지 않았다.
- DNS → TCP 8883 → TLS SAN/mTLS → MQTT CONNACK을 순서대로 모두 통과하고 서로 다른 healthy heartbeat 3회를 확인하기 전에는 BIO image를 production Gateway에 배포하면 안 된다.
- software compose/entrypoint 검증과 host preflight는 실제 container 내 libusb open/reconnect, USB 탈착 후 service recreate 또는 조명 제어 증거가 아니다.
- 주소 변경과 밝기 제어는 Task 9의 별도 사용자 승인 및 HIL 관문을 유지한다.
