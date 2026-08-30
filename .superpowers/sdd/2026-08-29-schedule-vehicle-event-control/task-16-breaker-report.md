# Task 16 Breaker 구현 보고서

상태: 완료(software/native, production-source host fake, patched ESP-IDF fullclean target build; HIL 미실행)

기준 HEAD: `ba5449f9e7c512f9d376db61d4c1d615b122532a`

대상 finding: `task-16-review.md` Fix Round 5 P2-15. Coordinator adjudication에 따라 load-bearing finding으로 처리했다.

## 결론

ESP-IDF v5.5.1의 기존 server-send deep-copy callback은 `void`라 nested payload/context allocation 실패를 `btc_transfer_context()` caller에 전달할 수 없었다. API는 `ESP_OK`를 반환하고 NULL payload/context가 BTC handler에 도달할 수 있어, Fix Round 5의 synchronous failure/retry 계약을 만족하지 못했다.

Repository patch는 `SERVER_MODEL_SEND`만 public API thread에서 payload와 context를 all-or-nothing snapshot한다. Queue 수락 전 실패는 동기 오류로 반환하고, 성공 후에만 ownership을 queued argument로 이동한다. Client send와 다른 action의 기존 secondary deep-copy는 변경하지 않았다.

## 고정 upstream 경계

| 항목 | 고정값 |
| --- | --- |
| ESP-IDF | `v5.5.1` |
| Commit | `fcae32885b0296b32044cb99ecbdc50d98dddb83` |
| `btc_task.c` upstream SHA-256 | `de360194bf14666c56f18b3e89f8586819440a310f7311f729e75b4985bbcbd1` |
| `esp_ble_mesh_networking_api.c` upstream SHA-256 | `0afc15b87d9f90c179295ba4a085c0b73f483bc194412f95c10290ac24ba7704` |
| `btc_ble_mesh_prov.c` upstream SHA-256 | `62e5dd29f93379321d85b3a338c6d8b04d7c0e3450027df42ff6d71335e0d9d7` |
| Patched networking source SHA-256 | `8e6100be9508a21e9e9a44539eff36b06754dbf109dbeb52fe81c7c213880898` |
| Patch SHA-256 | `dc6f4c7d62203444686416a6a511ceb366fa7162a47b9ff90520c9c047205df5` |

## Ownership 상태 전이

| 경로 | Queue post | API 결과 | 해제 주체 |
| --- | --- | --- | --- |
| Payload allocation 실패 | 없음 | `ESP_ERR_NO_MEM` | allocation 없음 |
| Context snapshot 실패 | 없음 | `ESP_ERR_NO_MEM` | API caller가 payload 해제 |
| BTC envelope allocation 실패 | 없음 | `ESP_ERR_NO_MEM` | API caller가 payload/context 해제 |
| Queue post 실패 | 없음 | `ESP_FAIL` | `btc_transfer_context()`가 envelope, API caller가 payload/context 해제 |
| Queue 수락 | 1건 | `ESP_OK` | BTC handler의 기존 deep-free가 payload/context를 각 1회 해제 |

Queue 수락 경로는 `btc_transfer_context()`에 already-owning pointers와 `NULL` copy/free callback을 전달한다. 따라서 transfer 실패 때 queued arg alias를 deep-free하지 않고 caller가 원본 ownership을 유지한다. Success 때 local pointers를 NULL로 바꿔 caller cleanup을 생략하며, `btc_ble_mesh_model_call_handler()`의 기존 unconditional `btc_ble_mesh_model_arg_deep_free()`가 마지막 owner다.

## Repository 통합

- Patch와 exact hash metadata를 `apps/esp32-h2-firmware/patches`에 저장했다.
- `scripts/esp32-h2-idf-patch.sh`는 source verify, build-only stage, apply/verify, identity 작성과 report를 담당한다.
- Build/flash wrapper는 사용자 global checkout을 수정하지 않는다. Exact upstream `components/bt`를 외부 build workdir의 project component overlay로 복사한 뒤 그 overlay만 patch한다.
- Existing overlay가 upstream/patched hash가 아닌 경우 덮어쓰지 않는다. Wrong commit/tag, 세 source hash mismatch, `components/bt`의 다른 tracked 변경이나 untracked 파일도 IDF 실행 전에 실패한다.
- Build는 매번 `idf.py fullclean`을 수행한다. Target audit는 `compile_commands.json`이 patched overlay source를 실제 compile했는지 structured JSON으로 확인한다.
- Test manifest schema는 `led-control-test-artifact-v3`, production signed attestation schema는 `led-control-artifact-attestation-v2`다. 둘 다 ESP-IDF version/commit, patch digest, patched source digest와 patch identity digest를 결속한다.

## TDD RED

Production patch 작성 전에 다음 실패를 확인했다.

1. 실제 pristine ESP-IDF networking source를 faithful allocator/BTC transfer harness로 compile했다. Context snapshot allocation fault에서 API가 `ESP_OK`를 반환해 assertion이 abort(`exit 134`)했다.
2. Production-source runtime 16 burst에 payload, context, envelope, queue-post deterministic failure를 주입했다. Context failure event가 accepted되어 최초 vendor queue count가 기대값 12를 초과하는 assertion이 abort(`exit 134`)했다.
3. Patch gate가 없는 상태에서 idempotency/fail-closed test가 실패했다.
4. Patch identity 필드를 먼저 요구한 artifact manifest와 signed attestation test가 기존 schema에서 실패했다.

## GREEN

- Boundary harness: first payload, context, envelope, queue-post failure가 각각 API error, handler 0회와 exact free를 만족했다. Host envelope arg 정렬을 명시해 ASan/UBSan 실행도 clean하게 통과했다.
- Delayed success: caller payload/context를 호출 후 변조해도 queued snapshot이 보존됐고 handler가 payload/context를 각 1회 해제했다. NULL server payload/context는 handler에 도달하지 않았다.
- Client send: 기존 secondary deep-copy와 caller buffer 해제를 유지했다.
- 16 burst: sequence 2/5/9/13에서 네 failure를 재현해 initial accepted snapshot 12개만 queue에 남겼다. Fault 해제 후 250ms retry에서 실패 이벤트를 포함한 16개 exact `(bootId, sequence)` snapshot이 모두 전송됐다.
- Patch gate: 두 번 stage/apply 후 source/identity hash가 동일했다. Unpatched overlay verify, tampered overlay apply, wrong source hash/revision, 다른 tracked component 변경과 untracked component source는 파일을 덮어쓰지 않고 실패했다.

## 전체 검증

- Firmware native strict C11: codec/retry, Mesh adapter, Health, Task 15 driver 통과.
- Firmware production-source host fake 전체와 P2-14 focused 4종, breaker allocation burst 통과.
- Gateway: 59 files, 547/547 tests 통과.
- Shared: 7 files, 75/75 tests 통과.
- Shared/Gateway typecheck, lint, production build 통과.
- Patch/build/trust/artifact/signed attestation gate 통과.
- Production CID `4660` build는 고정 trust root 미등록으로 `idf.py` 실행 전 `production trust root is not provisioned` expected fail-closed했다.
- ESP-IDF v5.5.1 `esp32h2` fullclean test build, linker map, target artifact, manifest audit와 compile source gate를 통과했다.
- Global ESP-IDF checkout은 exact tag/commit과 upstream source hash를 유지하며 working tree가 clean하다.

## Binary와 OTA

- `led_control_node.bin`: `0xefa30` (`981,552`) 바이트
- OTA app slot: `0x1f0000` (`2,031,616`) 바이트
- OTA free: `0x1005d0` (`1,050,064`, 약 52%)
- Production minimum free gate: `406,324` 바이트
- Fix Round 5 대비 binary 64바이트 증가, free 64바이트 감소
- 산출물: test mode, CID `0xFFFF`; flash/HIL/production 사용 금지

## HIL 한계

실제 ESP32-H2 flash, Raspberry Pi/BlueZ provisioning, RF packet loss/late ACK, BTC heap pressure와 queue saturation의 device timing, power-cycle/reprovision/AppKey rebinding, Sensor 전압/noise/ESD/surge는 실행하지 않았다. Test image는 boot fail-stop 정책 때문에 HIL에 사용할 수 없고, production Company ID/trust root/release key/제조 승인 자료가 provision되기 전 production image 생성은 의도적으로 불가능하다.
