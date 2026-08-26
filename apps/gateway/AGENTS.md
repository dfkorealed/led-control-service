# 게이트웨이 작업 규칙

## 소유 역할과 범위

- 담당 역할은 `gateway`다.
- 기본 수정 범위는 `apps/gateway`다. Raspberry Pi 게이트웨이 런타임, Docker 패키징, BlueZ, BLE Mesh provisioner 연동, MQTT와 장비 인증을 소유한다.
- `infra` 변경은 총괄이 승인한 파일에 한정한다.

## 공유 계약

- MQTT topic·payload, 장비 식별자, 인증서, BLE Mesh 모델과 `packages/shared`는 공유 경계다.
- 공유 경계를 임의로 변경하지 않는다. 변경 전 총괄 승인을 받고, 총괄이 정한 순서에 따라 `backend` 또는 `firmware`의 계약 변경과 검증이 끝난 뒤 게이트웨이를 적용한다.

## 검증

저장소 루트에서 다음 명령을 실행한다.

```bash
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway test
```

- 로컬 자동 테스트와 mock 어댑터 결과는 실제 Raspberry Pi·BlueZ·ESP32-H2 검증과 구분한다.
- 실장비 HIL, 인증서 발급·폐기, Raspberry Pi 배포와 운영 MQTT 연결은 사용자 승인 관문 뒤에 실행한다.

## 문서

- 모니터링 또는 제어 흐름이 바뀌면 관련 `docs/menus/*.md`를 갱신한다.
- 반복 가능한 설치·통신 실패와 예방책은 `docs/lesson_leared.md`에 누적한다.
- DB 구조 변경이 필요하면 `backend`에 요청한다.
