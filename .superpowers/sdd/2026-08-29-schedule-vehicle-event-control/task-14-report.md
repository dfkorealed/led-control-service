# Task 14 보고서: Gateway BLE Mesh 차량 센서 입력

상태: 완료(소프트웨어, HIL 미실행)

커밋: self (`feat(gateway): ingest BLE Mesh vehicle sensors`)

## 구현 내용

- Bluetooth Mesh Presence Detected와 Motion Sensed Sensor Status MPID를 strict decode하고 startup, reconnect, automation hot reload에서 enabled source마다 Presence Sensor Get을 보낸다.
- 제품 vendor payload의 version, `bootId`, `sequence`, event kind와 level 조합을 exact length로 검증한다. `(sourceUnicast,bootId,sequence)`를 manifest가 있는 원자 JSON에 저장하며 duplicate와 이전 sequence에도 ACK를 재전송하고 bootId 변경은 새 session으로 처리한다.
- Unknown/unconfigured source, unknown property, malformed payload와 Sensor Get 실패는 runtime 상태를 바꾸지 않고 source와 정제 reason만 기록한다.
- BlueZ application에 Sensor Client와 제품 vendor client model을 등록하고 confirmed node의 Sensor Server/vendor server AppKey binding과 provisioner publication을 exact Config Status로 확인한다.
- Node별 `VehicleSensorCapabilityReportV1` complete payload와 canonical hash를 원자 journal에 저장한다. 실제 binding 상태 변경 때만 revision/event ID를 새로 만들고 broker PUBACK과 무관하게 exact application ACK 전까지 1~30초 bounded retry한다.
- Reconnect는 저장된 동일 event ID, revision, payload와 hash를 재발행한다. `applied|stale|duplicate`는 event/gateway/node/revision/hash가 모두 일치할 때만 terminal이며 `rejected`와 hash mismatch는 journal을 보존한다.
- Production `gateway.ts`/BlueZ adapter/MQTT lifecycle과 capability ACK read-only Mosquitto ACL을 연결했다. DB schema 변경은 없다.

## 검증

- Focused vehicle sensor/BlueZ/Gateway wiring: 7 files, 94/94 passed.
- Gateway 전체: 57 files, 523/523 passed.
- Shared 전체: 7 files, 74/74 passed.
- Gateway Docker 계약: 17/17 passed.
- 필수 Docker/mTLS Mosquitto persistence와 capability ACK ACL: 2/2 passed.
- Shared와 Gateway typecheck, lint, production build: passed.
- `git diff --check`: passed.

## 남은 한계

- Task 15/16의 ESP32-H2 GPIO driver, Sensor Server와 vendor event/ACK retry firmware는 아직 구현되지 않았다.
- 실제 Raspberry Pi BlueZ와 ESP32-H2 사이의 RF packet loss, startup current-state, duplicate ACK, reconnect, 전원 차단과 flash wear HIL은 실행하지 않았다.
- 자동 테스트와 Docker/mTLS Mosquitto 결과는 production 장비 RF 증거가 아니다.
