# ESP32-H2 펌웨어 작업 규칙

## 소유 역할과 범위

- 담당 역할은 `firmware`다.
- 기본 수정 범위는 `apps/esp32-h2-firmware`다. ESP-IDF, BLE Mesh node, PWM, 상태·Health publication, 영속 상태와 OTA 경계를 소유한다.
- 양산 대상 ESP32-H2와 ESP-IDF 버전을 기준으로 구현하며, 테스트 전용 우회 경로를 양산 코드에 추가하지 않는다.

## 공유 계약

- BLE Mesh 모델·opcode·주소·publication, 장비 UUID, MQTT 변환 계약과 OTA 메타데이터는 공유 경계다.
- 공유 계약을 직접 확정하지 않는다. 총괄 승인과 `gateway`·`backend` 영향 검토 뒤 지정된 한 역할이 계약을 먼저 변경하고, 펌웨어는 그 결과를 순차 적용한다.

## 검증

ESP-IDF 환경이 준비된 호스트에서 저장소 루트 기준으로 빌드한다.

```bash
scripts/esp32-h2-build.sh
```

ESP-IDF와 무관한 모듈을 수정하면 가능한 호스트 테스트를 함께 실행한다.

```bash
cc -std=c11 -Wall -Wextra -Werror apps/esp32-h2-firmware/test/control_state_test.c apps/esp32-h2-firmware/main/control_state.c apps/esp32-h2-firmware/main/mesh_state.c apps/esp32-h2-firmware/main/mesh_publication_jitter.c -o /tmp/led-control-state-test && /tmp/led-control-state-test
cc -std=c11 -Wall -Wextra -Werror apps/esp32-h2-firmware/test/mesh_transaction_cache_test.c apps/esp32-h2-firmware/main/mesh_transaction_cache.c -o /tmp/led-mesh-transaction-test && /tmp/led-mesh-transaction-test
```

- 실제 보드 flash, 제조 자격 증명 주입, 서명된 OTA 배포와 HIL은 사용자 승인 관문 뒤에 실행한다.
- 빌드와 호스트 테스트 통과를 실제 BLE Mesh 무선 동작 검증 완료로 기록하지 않는다.

## 문서

- 모니터링 또는 제어 동작이 바뀌면 관련 `docs/menus/*.md`와 펌웨어 README를 갱신한다.
- 반복 가능한 빌드·flash 실패와 예방책은 `docs/lesson_leared.md`에 누적한다.
- DB 구조 변경은 `backend`에 요청한다.
