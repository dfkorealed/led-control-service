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
| 메뉴 완성 구현 계획 | 완료 | [구현 계획](superpowers/plans/2026-08-26-monitoring-control-statistics-completion.md)을 12개 검증·커밋 단위로 작성했다. |
| 메뉴 완성 구현 | 진행 중 | Task 1 공용 계약, Task 2 검색 lifecycle, Task 3 Web 상태 구현, Task 4 저장 구역 API와 fix round 3를 완료했다. Task 3/6 병렬 Web 검증과 Task 5 장비 HIL이 다음 의존 단계다. |

## 다음 단계

현재 작업은 **메뉴 완성 구현**이다. Task 4 fix round 3는 configuring desired 변경 시 version 증가와 stale ACK 무시, `first_run/state_missing/state_corrupt`의 영속 full-state reconciliation, retiring cloud-applied Delete 복구를 완료했다. 새 migration 포함 PostgreSQL 29개 migration deploy와 integration 2건, API/shared/gateway 전체 테스트 및 전체 typecheck/build는 통과했다. 병렬 작업 중인 Web command recovery 변경의 unit 25건은 현재 실패 상태이며 Task 4 파일에서 수정하지 않았다. Raspberry Pi/ESP32-H2 HIL은 남아 있다.

## 알려진 미해결 항목

### 모니터링

- Web 등록 패널에서 provisioning 전 조명 `점멸 확인` 버튼·상태를 제거하고 scan lifecycle 재시도/0건/실패 화면을 연결해야 한다.
- 도면 최초 조회 실패가 빈 기본 canvas로 보일 수 있으며, 등록 완료 뒤 필요한 query를 즉시 갱신하지 않는다.

### 제어

- 저장 구역 CRUD와 cloud desired membership, dashboard 준비 상태 기반 제어 차단은 구현됐지만, 생성·수정·삭제·resync 관리 dialog는 Task 7에서 구현해야 한다.
- Gateway Config Model Subscription Add/Delete의 cloud exact operation 계약은 구현됐지만 실제 Raspberry Pi/ESP32-H2 HIL은 Task 5에서 검증해야 한다.
- device-status ACK 대상·aggregate status 완전성과 동시 요청 client request id 멱등성 보완이 필요하다.

### 통계

- 현재 통계는 12시간 snapshot 계산이며, migration 시점 추적·첫 상태 이전 unknown·180초 투영·fixture별 forecast가 없다. Gateway durable state outbox와 DB commit 뒤 application ACK도 아직 구현되지 않았다.

### 실장비 검증

- Raspberry Pi, MQTT broker, ESP32-H2를 연결한 검색·등록·제어·상태 수집 HIL은 아직 실행하지 않았다.

## 기록 원칙

이 문서는 현재 상태 요약의 정본이다. 활성 작업의 세부 실행 단계는 `writing-plans` 체크리스트에서 관리하며, 상태가 바뀌면 두 기록을 함께 일치시켜 갱신한다. 장기 설계와 미구현 계획은 기존 설계·계획 문서를 유지하며, 완료 여부를 실제 자동 검증과 HIL 증거에 맞춰 갱신한다.
