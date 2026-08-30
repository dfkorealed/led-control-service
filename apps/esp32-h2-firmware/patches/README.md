# ESP-IDF production patch 관리

Task 16 firmware는 ESP-IDF `v5.5.1`의 server model send ownership 경계에 repository-managed patch를 적용한다. 사용자 전역 ESP-IDF checkout은 읽기 전용 source로 취급하고, build/flash wrapper가 `$ESP32_H2_BUILD_WORKDIR/components/bt`에 만든 build 전용 component overlay만 수정한다.

## 고정 경계

- ESP-IDF tag: `v5.5.1`
- ESP-IDF commit: `fcae32885b0296b32044cb99ecbdc50d98dddb83`
- Patch: `esp-idf-v5.5.1-server-send-ownership.patch`
- Hash/context metadata: `esp-idf-v5.5.1-server-send-ownership.conf`
- Apply/verify gate: `scripts/esp32-h2-idf-patch.sh`

Gate는 patch 자체와 upstream `btc_task.c`, `esp_ble_mesh_networking_api.c`, `btc_ble_mesh_prov.c`의 exact SHA-256를 먼저 확인하고 `components/bt` 전체가 pinned commit과 같으며 untracked 파일이 없는지도 검사한다. Commit, exact tag, source hash 또는 component tree가 하나라도 다르면 source나 overlay를 덮어쓰지 않고 실패한다. 이미 exact patched hash이면 재적용하지 않고 같은 identity를 생성한다.

Patch 파일은 repository whitespace 검사를 통과하도록 zero-context unified diff로 저장한다. `--unidiff-zero` 적용은 위 exact commit/source/tree 검증을 모두 통과한 build overlay에서만 실행하며, 적용 뒤 patched source SHA-256를 다시 확인한다.

## Ownership 계약

`SERVER_MODEL_SEND`만 public API thread에서 opcode를 포함한 payload와 heap context snapshot을 모두 할당한다. 둘 중 하나라도 실패하면 BTC queue에 post하지 않고 `ESP_ERR_NO_MEM`을 반환한다. BTC envelope allocation은 `ESP_ERR_NO_MEM`, queue post failure는 `ESP_FAIL`로 동기 반환하며 caller가 payload/context를 해제한다. Queue가 수락하면 ownership은 queued argument로 이동하고 기존 `btc_ble_mesh_model_arg_deep_free()`가 handler 종료 때 정확히 한 번 해제한다. Client send와 다른 ESP-IDF action은 기존 deep-copy 동작을 유지한다.

## 업그레이드 절차

1. 새 ESP-IDF tag를 별도 disposable checkout/worktree에 준비한다. 사용자 전역 checkout에서 patch를 직접 적용하지 않는다.
2. 새 revision의 `btc_transfer_context()`, public networking API, `btc_ble_mesh_model_arg_deep_copy/free()`와 실제 component build 경로를 다시 읽는다.
3. Unpatched source에 `test_esp_idf_server_send_boundary.sh`를 실행한다. Upstream이 all-or-nothing allocation/error/cleanup을 자체 보장하면 local patch 제거 가능성을 우선 검토한다.
4. Patch가 계속 필요하면 새 tag 전용 patch와 metadata를 만든다. 세 upstream source, patched networking source와 patch 파일의 SHA-256 및 exact commit/tag를 모두 갱신한다.
5. First payload, context, BTC envelope, queue post fault와 delayed success/client-send 회귀를 RED/GREEN으로 실행한다.
6. `test_esp32_h2_idf_patch_gate.sh`로 wrong revision/hash fail-closed와 두 번 stage/apply의 멱등성을 검증한다.
7. `scripts/esp32-h2-build.sh --test-build` fullclean target build를 실행하고 `compile_commands.json`이 build overlay의 patched source를 사용했는지 확인한다.
8. Artifact/attestation schema와 patch identity digest를 갱신하고 test manifest, signed fixture와 flash gate를 모두 재검증한다.

Patch 또는 metadata가 바뀌면 artifact identity도 바뀌어야 한다. 이전 attestation을 새 patch build에 재사용할 수 없어야 한다.
