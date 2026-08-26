# 메뉴 완성 작업 상태판

기준일: 2026-08-26

## 현재 마일스톤

**메뉴 완성 설계**: 모니터링과 제어의 감사 누락을 보완하고, 상태 기반 추정 통계를 양산 계약으로 고정한다.

## 작업 상태

| 작업 | 상태 | 내용 |
| --- | --- | --- |
| 에이전트 운영 기반 Task 1 | 완료 | 운영 기준과 지속 갱신 상태판을 작성했다. |
| 에이전트 운영 기반 Task 2 | 완료 | 프로젝트 전용 custom agent 7개의 기본 권한 프로필과 디렉터리별 `AGENTS.md` 소유·검증 규칙을 구성했다. 실제 QA 읽기 전용 검토는 부모 세션도 읽기 전용 권한으로 실행한다. |
| 메뉴 완성 설계 작성 | 완료 | [모니터링·제어·통계 완료 설계](superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md)에 재검토를 반영해 migration 시점 에너지 추적과 durable state outbox·application ACK까지 확정했다. |
| 메뉴 완성 구현 계획 | 대기 | 설계를 작업 단위와 커밋 단위로 분해한 뒤 구현을 시작한다. |

## 다음 단계

다음 작업은 **메뉴 완성 구현 계획 작성**이다. 모니터링, 제어, 통계의 공유 Prisma·MQTT 계약을 먼저 순차 변경하고, 그 뒤 API, 웹, 게이트웨이 변경을 역할별로 구현한다. 실제 장비 flash, 인증서 발급·폐기, DB 초기화와 배포는 사용자 승인 후 수행한다.

## 알려진 미해결 항목

### 모니터링

- provisioning 전 조명 `점멸 확인`은 표준 BLE Mesh 경로에서 지원되지 않는데 화면과 API가 성공 흐름을 전제한다.
- 검색 session에는 correlation 기반 완료·실패, found event 검증, gateway당 단일 active scan과 retry 계약이 아직 구현되지 않았다.
- 도면 최초 조회 실패가 빈 기본 canvas로 보일 수 있으며, 등록 완료 뒤 필요한 query를 즉시 갱신하지 않는다.

### 제어

- 사용자가 저장 구역을 생성·수정할 FixtureGroup CRUD와 UI가 없어 구역 제어의 정상 사용자 흐름이 완성되지 않았다.
- 구역 lifecycle과 desired membership Add/Delete reconciliation, MeshControlGroup 준비 상태 UI가 아직 구현되지 않았다.
- device-status ACK 대상·aggregate status 완전성과 동시 요청 client request id 멱등성 보완이 필요하다.

### 통계

- 현재 통계는 12시간 snapshot 계산이며, migration 시점 추적·첫 상태 이전 unknown·180초 투영·fixture별 forecast가 없다. Gateway durable state outbox와 DB commit 뒤 application ACK도 아직 구현되지 않았다.

### 실장비 검증

- Raspberry Pi, MQTT broker, ESP32-H2를 연결한 검색·등록·제어·상태 수집 HIL은 아직 실행하지 않았다.

## 기록 원칙

이 문서는 현재 상태 요약의 정본이다. 활성 작업의 세부 실행 단계는 `writing-plans` 체크리스트에서 관리하며, 상태가 바뀌면 두 기록을 함께 일치시켜 갱신한다. 장기 설계와 미구현 계획은 기존 설계·계획 문서를 유지하며, 완료 여부를 실제 자동 검증과 HIL 증거에 맞춰 갱신한다.
