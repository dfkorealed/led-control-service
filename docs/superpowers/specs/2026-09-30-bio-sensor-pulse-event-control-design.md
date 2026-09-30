# BIO 센서 펄스 기반 이벤트 제어 설계

기준일: 2026-09-30

이 문서는 [2026-09-15 상태형 설계](2026-09-15-bio-sensor-event-control-design.md)의 BIO 감지/해제, 상태 복구 및 HIL 활성화 조건을 대체한다. 기존 BlueZ 센서의 상태형 처리와 [수동 기본 밝기 설계](2026-09-14-manual-baseline-control-design.md)의 occurrence별 억제 의미를 유지한다. 이 문서는 구현 완료 또는 현재 장비의 제품 지원 판정이 아니다.

## 목적과 사용자 경험

사용자는 A 조명을 센서 전용으로 두고, A가 감지 시 자체적으로 밝아지는 동안 별도의 B 조명(향후 여러 대상 조명)도 이벤트 밝기로 켜지길 원한다. A의 `sensor` 모드와 `0x09` 보고가 공존한다는 것은 확인됐지만, **A의 자율 밝기 반응 자체는 광학적으로 검증되지 않았다**. 따라서 이 구현은 A의 센서 모드를 유지하고 검증된 펄스로 B를 제어하는 소프트웨어부터 만들며, A의 실제 자체 밝기 변화는 별도 HIL 관문에서 확인한다. 신호가 새로 들어올 때마다 유지시간을 다시 시작하고, 건강한 센서 연결에서 마지막 신호 뒤 유지시간이 지나면 B를 이벤트 이전의 밝기와 BIO 제어 모드로 복원한다. 사용자는 제어 화면에서 유지시간을 바꿀 수 있어야 한다. 제조사 앱이나 확인되지 않은 패킷 송신에 의존하지 않는다.

처음 제공할 BIO 유지시간 범위는 **10~1,800초**, 기본값은 **60초**다. 10초로 설정하면 실제 움직임이 이어져도 신호 간격이 10초를 넘는 동안 B가 꺼졌다 다음 신호에 다시 켜질 수 있다. 사용자가 이 동작을 수용했으므로 값을 임의로 늘리지 않고 UI에서 경고한다. 기존 BlueZ 규칙의 최소 5초와 기본 60초는 바꾸지 않는다.

## 근거, 미확정 사실과 안전 경계

- 현재 Gateway는 USB 외부 `0x12`의 내부 `0x09`를 `sensor-status-candidate`로 보존하고, `0x0c`를 alive로 분류한다. `0x09` 본문에서 감지/해제 boolean은 해석하지 않으며, BIO cloud 센서 capability는 OFF다.
- 펌웨어 담당자와의 읽기 전용 검토에서는 A의 `sensor` 모드와 `0x09` 보고의 공존을 확인했다. 과거 사용자의 점등 관찰은 A의 자율 밝기 변화를 광학적으로 계측한 증거가 아니며, `CD 13` raw 밝기 설정과 `CC 12 00` 센서 모드 설정이 별개라는 사실만으로 raw 밝기 변경 후 센서 동작이 유지된다고 볼 수도 없다. 따라서 A의 자율 밝기 및 센서 모드 보존형 밝기 조절은 미검증이다.
- 2026-09-30 A 단일 시험의 300초 관찰창에서 `0x09` 후보는 계획상 첫 움직임 6건, 정지 8건, 재움직임 9건, 마지막 범위 밖 0건이었다. 모든 후보 body는 `0101000000000000`였고 관찰된 신호 공백 중 하나는 34.250초였다. 정지 중에도 들어왔으므로 “정지하면 즉시 해제” 또는 본문 `01`이 감지/해제 상태라는 결론은 낼 수 없다.
- 사용자의 전환 시간은 모두 대략값이다. 시험 뒤 범위 밖 유지·타인/움직이는 물체 부재·휴대폰 자동 시간 설정을 확인했지만, 휴대폰–Pi 시간 오차 한계와 독립적인 행동 기록은 없다. 증거의 `physicalTimingVerified=false`를 유지한다. 원본은 `codex/bio-sensor-motion-test-resume-20260929` 브랜치의 `docs/diagnostics/bio-sensor-motion-20260930`에 보존돼 있다.
- 따라서 `0x09`는 **펄스 후보**다. 개별 packet과 움직임의 물리적 상관관계, 반복/정지 시 보고 특성, firmware별 형식, 독립적인 연결 건강 판정은 추가 shadow HIL 전까지 미확정이다. 이 한 번의 시험으로 `supported`를 발행하거나 B를 자동 제어하지 않는다.
- 동글의 접수 ACK, 조명의 출력 변화, `0x0c` alive 및 일정 시간의 침묵은 각각 움직임 또는 해제 패킷의 증거가 아니다. 검증되지 않은 `clear`를 합성하지 않는다.

## 선택한 방식과 제외한 방식

채택 방식은 **검증된 `0x09` 수신을 개별 펄스로 정규화하고, Gateway의 유지 타이머를 갱신하는 방식**이다. 첫 펄스가 B의 이벤트를 시작하고 다음 펄스마다 만료 시각을 뒤로 옮긴다. 독립적으로 센서 링크가 건강하다는 조건에서만 타이머 만료를 종료 조건으로 삼는다. 감지/해제 상태 byte를 찾지 못한 상황에도 일관된 의미를 제공하고 기존 stateful BlueZ와 프로토콜 경계를 분리할 수 있다.

본문 `01`을 감지, 다른 값을 해제로 해석하는 상태형 방식은 근거가 없어 폐기한다. 조명 밝기 변화에서 센서 입력을 역추정하는 방식도 수동/스케줄/조명 자체 센서 동작과 구분할 수 없어 제외한다. 임의의 sensor GET·ACK 명령 송신이나 USB를 여는 두 번째 client도 범위 밖이다.

## 구성요소와 계약

```text
BIO A → 기존 USB 동글 client/CRC·frame 검증 → 0x09 후보 분류
      → 검증된 형식·identity·freshness의 펄스만 source intake
      → protocol=pulse인 이벤트 규칙의 만료시각 갱신
      → 기존 자동화 우선순위/대상 제어 → B 밝기·BIO mode read-back
      → 실행·복원 결과와 센서 건강 상태를 API/Web에 보고
```

1. **BIO packet decoder**는 기존 USB connection·queue를 공유한다. CRC16, 외부 `0x12`, 내부 `0x09`, 정확한 길이·고정 byte·허용된 firmware/sensor fingerprint가 모두 맞는 packet만 별도 `BioSensorPulse`로 낸다. 검증 전에는 지금처럼 후보로 남긴다. `0x0c`는 별도 liveness 관찰용일 뿐 이벤트 입력이 아니다. USB 비동기 packet이 command ACK 또는 GET read-back을 소비하지 않도록 소유권을 분리한다.
2. **Source intake**는 confirmed Fixture와 packet의 native UUID/address/network를 함께 대조하고, 활성 규칙·capability revision·링크 건강을 확인한다. 8-bit sequence는 짧은 구간의 exact 중복 억제에만 쓰고 `255→0` wrap이나 재부팅을 오래된 이벤트로 단정하지 않는다. 재연결 이전의 지연 packet과 이미 소비한 packet은 타이머를 갱신하지 않는다. 새 유효 펄스의 기준 시각은 장치가 보낸 시각이 아닌 Gateway 수신 monotonic time이다.
3. **자동화 입력 계약**에는 BlueZ의 `detected/cleared/current-state`와 별개인 `pulse` 의미를 추가한다. BIO 펄스를 기존 `detected`로 변환하지 않는다. 기존 runtime은 `detected`를 active source로 붙잡고 `cleared` 이후에야 hold를 시작하기 때문이다. 첫 펄스는 `event_started`, 활성 중 후속 펄스는 같은 occurrence의 hold 갱신(`event_extended`)으로 기록한다. `vehicle_detected`를 사용한다면 그것은 검증된 각 펄스의 관측 기록이지 상태 진입의 증거가 아님을 payload의 protocol로 명시한다.
4. **규칙·capability 계약**은 프로토콜과 입력 의미를 명시적으로 versioning한다. API는 source capability에서 `bio-usb-pulse` 또는 기존 BlueZ stateful을 판정하고, 이를 versioned snapshot으로 Gateway에 전달한다. 클라이언트가 보낸 protocol 표기를 신뢰하지 않는다. 현재 V1 Zod 계약은 strict이므로 필드를 조용히 추가하지 않는다. V2 발행·수용·적용 ACK를 명시적으로 협상하고, V2를 모르는 Gateway에는 BIO 규칙을 보내거나 적용 성공으로 간주하지 않는다. DB migration은 기존 capability row와 규칙을 BlueZ 상태형으로 유지하며 BIO를 기본 OFF로 추가한다. 초기 BIO 규칙은 한 개의 A source와 하나 이상의 다른 target만 허용하며 BIO와 BlueZ source 혼합은 막는다. 기존 BlueZ row/snapshot은 상태형 의미와 5초 하한을 그대로 유지한다. DB 변경 시 migration과 `docs/database-schema.md`를 같은 작업에서 갱신한다.
5. **제어 화면**은 검증 중/사용 가능/재검증 필요 상태를 구별하고, 사용 가능한 BIO source만 저장 가능하게 한다. A는 센서 전용, B는 대상임을 지도·선택 요약·저장 오류에서 알려준다. 선택된 source protocol에 맞춰 같은 유지시간 입력의 하한과 설명을 바꾸고, BIO 10초 선택 시 신호 공백에 따른 꺼짐/재점등 가능성을 표시한다. 저장 후에도 UI에서 수정할 수 있다. 화면 검사 외에 API/Gateway가 동일 범위를 검증한다.

공유 wire·DB 경계는 한 담당 역할이 version/migration을 먼저 확정·검증하고, Gateway/API/Web 소비자는 그 뒤 순차 적용한다. 오래된 Gateway가 BIO 의미를 모르는 snapshot을 적용했다고 ACK하지 못하게 하며, rollout 중 BIO 규칙은 OFF를 유지한다.

## 이벤트 수명주기와 복원

- 첫 검증된 A 펄스에서 B의 이벤트 이전 **확인된 밝기와 BIO 제어 모드**를 보존한 뒤 이벤트 밝기를 적용한다. B의 양수 밝기 명령이 `force-on`, 0%가 `force-off`로 바뀌는 현재 BIO 동작 때문에 mode까지 보존·복원한다. 상태가 확인되지 않으면 성공한 적용/복원으로 표시하지 않는다.
- 유효한 새 펄스마다 `deadline = monotonicReceiveTime + holdSeconds`로 갱신한다. 과거 발생 시각으로 들어온 replay, exact duplicate, 불확실한 identity는 갱신하지 않는다. 상태형 source의 active/clear 로직과 deadline은 섞지 않는다.
- 링크가 건강하고 마지막 펄스 뒤 deadline에 도달하면 이벤트를 종료한다. 그 사이 성공한 수동 제어가 있었다면 그 시점에 활성인 **정확한 이벤트 activation만** 해당 B에서 억제하고 수동 밝기를 새 기본값으로 삼는다. 같은 activation의 후속 펄스는 그 억제를 해제하지 않는다. 새 activation 또는 스케줄 occurrence는 다시 자동 제어할 수 있고, 억제되지 않은 자동 source 사이에서는 기존 `event > schedule` 우선순위를 따른다. 종료 시점에는 최신 기본값과 억제·자동 source 상태를 재계산하며, 낡은 이벤트 전 snapshot으로 새 수동 의도를 덮지 않는다. 적용·복원 모두 read-back을 확인하고 불일치 시 성공으로 기록하지 않는다.
- 여러 target의 일부만 성공한 경우 각 target의 적용 전 상태와 결과를 독립적으로 추적하고, 실패한 target을 성공했다고 보고하지 않는다. rule 재트리거는 이미 저장된 원래 상태를 덮어쓰지 않는다. 명시적 규칙 비활성화/운영자 해제는 건강한 만료와 다른 종료 사유로 기록하고 read-back을 거쳐 제어를 해제한다.
- Gateway 재시작 뒤 단순 wall-clock 경과 또는 journal의 오래된 deadline만으로 B를 복원하지 않는다. 저장된 occurrence·대상 원상태와 capability를 검증하고, 시각/링크가 불확실하면 degraded로 둔다. 건강 판정이 회복된 시점부터 **유지시간 전체를 새로 관찰**하면서 새 펄스가 오면 갱신하고, 그 기간 펄스가 없을 때만 정상 만료로 종료한다. 이 보수적 재시작 동작은 평상시 사용자가 고른 10초 하한을 바꾸지 않는다.

## A 센서 전용 및 대상 보호

A가 source로 활성화된 동안에는 A를 동일 또는 다른 이벤트 규칙의 target으로 넣지 못한다. 수동 개별/다중 제어, 스케줄, 그룹·층 선택이 확장된 결과, 식별 점등처럼 A를 `force-on/off`로 바꿀 수 있는 경로도 저장/API 명령/Gateway 실행 경계에서 거부한다. Web에서 숨기는 것만으로 보호하지 않는다. 등록·설정에서 A의 sensor mode가 read-back으로 확인되지 않으면 capability를 활성화하지 않는다. 다만 sensor mode read-back은 설정 모드의 확인이지 출력 밝기나 움직임 보고가 정상이라는 증거가 아니다. 실제 펄스 전달과 A의 자율 밝기 반응을 각각 별도 HIL로 검증한다. A에 `CD 13` 같은 밝기 명령을 보내면서 `sensor` 모드를 보존하는 동작은 검증 전 구현·노출하지 않는다. 향후 source/target 겸용 또는 A의 센서 안전 밝기 조절은 별도 펌웨어·실장비 검증 및 설계가 필요하다.

B는 A와 다른 Fixture이고 펄스 source가 아니다. B가 이벤트 전 `sensor`, `force-on`, `force-off` 중 어느 모드였든 밝기와 mode를 함께 돌린다. 여러 B target으로 확대할 때에도 source 제외·동일 Gateway·같은 site 경계를 서버와 Gateway에서 확인한다.

## 링크 장애와 fail-safe

펄스가 없는 것과 감지 범위가 비었다는 것은 동의어가 아니다. USB transport 단절, identity/mapping 변경, firmware fingerprint 불일치, decoder 오류, 독립 liveness 검증 실패, 신뢰할 수 없는 재시작 시각 중 하나가 발생하면 source를 `degraded`로 전환한다. 새 이벤트를 시작하지 않고 건강한 만료 타이머를 멈춘다. 이미 켜진 B는 침묵만으로 꺼뜨리지 않으며, 현재 상태와 원상태를 보존한다. Web/운영 알림에는 대상, 장애 시작 시각, 마지막 유효 펄스, 복원 대기 사유와 명시적 운영자 해제 경로를 지속 표시하고 장애 진입·조치·복구를 기록한다. 링크가 다시 건강해지면 위의 새 관찰창을 적용한다. 무기한 무인 점등으로 방치하지 않도록 제품 ON 전 현장별 **담당자·최대 확인/조치 시간·연락 실패 시 후속 조치**를 운영 정책으로 승인해야 한다. 그 정책이 없으면 BIO capability는 OFF다. 자동으로 B를 끄는 장애 timeout은 이 정책의 대체물이 아니다. 이 명세가 계속 켜짐을 전기·화재 안전상 인증한 것은 아니다.

센서 건강 판정은 `0x09` 수신 자체에 순환 의존하지 않는다. USB 연결·프레임 오류·confirmed identity와, 반복 HIL에서 시간 특성이 검증된 독립적인 alive/읽기 전용 probe를 조합한다. 이전 관찰에서 `0x0c`가 약 10초 간격으로 29건, 범위 밖 구간에서도 12건 보였지만 이는 heartbeat **후보**일 뿐 실패 timeout의 검증이 아니다. `0x0c`를 독립 liveness로 사용할 수 있는지는 HIL에서 주기·장애 시 동작을 확인한 뒤 확정한다. 그 검증이 없으면 capability는 OFF다. MQTT 장애는 별도로 보고한다. USB와 로컬 snapshot이 건강하면 기존 오프라인 자동화 정책을 따르되, API에 새 capability 지원 상태를 확인·전달하지 못하는 동안 새 BIO 규칙 활성화는 막고 telemetry를 수렴 후 재전송한다.

일반 로그와 MQTT telemetry에는 raw body, native UUID, 자격 증명을 기록하지 않는다. 진단 capture는 명시적 opt-in, 접근 제한된 로컬 파일, redacted identity와 보존 기간을 갖고 제품 capability와 분리한다.

## 단계별 활성화와 검증

1. **소프트웨어, capability OFF:** decoder·펄스 runtime·저널·versioned 계약·API guard·UI를 feature gate 뒤에 구현한다. 유효/무효 frame, identity mismatch, 중복, 8-bit wrap, partial USB frame, late replay, 첫 펄스/갱신/정상 만료, 10·60·1,800초 경계, BlueZ 5초 회귀, 우선순위, target별 brightness+mode 복원, fail-safe/restart/USB 단절을 자동 테스트한다. Real backend와 가짜 동글로 저장→snapshot ACK→실행 결과/telemetry의 계약을 검증한다. 이 단계 성공을 실장비 지원이라고 표시하지 않는다.
2. **shadow HIL, B 미제어:** A를 sensor mode로 두고 실제 움직임/정지/재움직임/범위 밖을 동기화된 marker와 반복 기록한다. 최소 10회 독립 주기와 길게 정지/지속 움직임, 무자극 출력 명령, 중복·loss·sequence wrap, USB 분리/재연결·동글 전원 재시작을 확인한다. 별도의 광학 측정으로 A의 자율 밝기 반응과 sensor mode 지속을 확인한다. `CD 13` raw 밝기 설정으로 A를 조절하는 실험은 제품 경로와 분리된 별도 승인·원복 절차가 있을 때만 수행하며, 그 결과 전에는 A 밝기 설정 UI를 노출하지 않는다. body/fingerprint allowlist, packet–행동 상관관계, 정상 신호 간격 분포, 독립 liveness와 ACK 필요 여부를 판정한다. 물리 행동 시각과 Pi 수신 시각의 오차 범위를 실제로 측정하고 원시 증거 해시를 보존한다. 반복 결과가 펄스 가설이나 A의 기대 밝기 동작을 지지하지 않으면 capability는 계속 OFF이고 설계를 다시 검토한다.
3. **B-only 현장 시험:** 사용자와 별도 시험창을 합의한 뒤 A는 제어하지 않고 B 하나에서 60초 기본값을 먼저 확인한다. 사전 B 밝기/mode read-back, 움직임→첫 펄스→점등, 반복 펄스의 유지 갱신, 건강한 침묵→만료→밝기/mode 복원, 장애 시 degraded와 재연결 관찰창, 동작 기록·API 상태가 모두 일치해야 한다. 그 뒤 10초 선택의 꺼짐/재점등 가능성을 별도 관찰한다. 원복 절차와 종료 조건을 시험 전에 정한다.
4. **제품 지원 전환:** 검증된 firmware/sensor fingerprint·module identity의 capability만 `supported`로 발행하고 API 수용 ACK, Gateway snapshot ACK, Web 사용 가능 상태까지 수렴시킨다. 설정 snapshot의 `applied` ACK는 설정이 반영됐다는 뜻일 뿐 A sensor mode, 펄스 전달 또는 source readiness의 증거가 아니다. 별도의 live capability/health 판정이 모두 갖춰져야 규칙을 실행한다. 다른 firmware·불일치 mapping·서로 다른 장비는 기본 OFF다. 초기 제품 문구는 검증한 조합과 유지시간의 의미를 한정해 설명한다.

한 번의 2026-09-30 시험, software test 통과 또는 B 점등 한 번만으로 4단계를 완료 처리하지 않는다. 매 단계 실패 시 앞 단계 상태로 머물며 장비의 현재 밝기·mode와 원복 결과를 확인한다. 실제 Pi 변경과 B 점등은 별도 현장 실행 승인 관문을 따른다.

## 현장 MQTT 선행 복구 범위

현재 랩에서는 Gateway USB·mesh 경로와 별개로 MQTT가 불건강하다. 최근 읽기 전용 진단에서 Mac의 현재 IP는 `172.30.1.47`이었지만 Pi의 `/etc/hosts`는 `api.led.lan`/`mqtt.led.lan`을 이전 `172.30.1.58`로 해석했고, 저장된 assignment와 bootstrap URL도 이전 IP를 가리켰다. DHCP 주소와 인증서 SAN은 재시험 때 바뀔 수 있으므로 이 숫자를 영구 설정으로 복사하지 않는다.

현장 작업 직전 Gateway 원본 container·identity·mapping·assignment, 실제 서버 IP/port, Pi hosts, broker/API 인증서 SAN·만료·신뢰 체인, bootstrap 응답을 **다시 읽기 전용으로 확인**한다. 백업과 원복 절차를 먼저 확보하고, 랩의 이름 해석 및 저장된 assignment/bootstrap을 인증서가 허용한 DNS hostname에 맞춰 최소 범위에서 원자적으로 고친다. 저장된 assignment가 환경변수보다 우선하므로 `MQTT_URL`만 바꾸는 작업은 완료가 아니다. TLS hostname 검증을 끄거나 private key/production DNS/DB를 임의로 바꾸지 않는다. 이름·SAN이 맞지 않으면 인증서 재발급을 이 작업에서 즉흥적으로 수행하지 않고 중단한다.

복구 검증은 DNS → TCP → TLS/mTLS hostname·체인 → MQTT CONNACK → 같은 Gateway의 신규 heartbeat 3회 순서로 한다. 어느 단계든 실패하면 원본 hosts/assignment/bootstrap과 컨테이너 설정을 복원하고, rollback 후 Gateway의 USB·mapping·조명 상태까지 확인한다. MQTT 복구는 센서 펄스 의미의 증거가 아니며 B 점등 시험을 자동 승인하지 않는다.

## 완료 기준과 문서 갱신

- software 계약/회귀 테스트와 단계별 HIL이 모두 통과하고, 승인된 A fingerprint에만 capability가 ON이다.
- A는 sensor mode를 유지하고 어떤 제어 경로에서도 target이 되지 않는다. A의 실제 자율 밝기 반응은 광학 HIL 결과로 확인하거나 미지원으로 명시한다. B는 첫 검증 펄스에 적용되고 매 펄스에 타이머가 갱신되며, 건강한 만료 또는 명시적 운영자 해제 뒤 최신 우선순위를 존중하면서 밝기·mode가 확인된 상태로 복원된다.
- 불확실한 침묵·USB 장애·identity 불일치는 해제 이벤트를 만들지 않고 degraded와 조치 필요를 표시한다. 10초 경계의 가능한 재점등을 UI와 HIL 결과가 동일하게 설명한다.
- 기존 BlueZ 상태형 이벤트와 5초 하한, BIO 수동/스케줄 제어, Gateway heartbeat와 read-back 경로가 회귀 없이 유지된다.
- 구현과 같은 작업에서 `docs/database-schema.md`(스키마 변경 시), `docs/menus/control.md`, `docs/menus/settings.md`, `docs/menus/monitoring.md`, `docs/project-status.md`를 실제 소프트웨어/HIL 단계에 맞게 갱신한다. 미실행 현장 시험은 완료로 표기하지 않는다.
