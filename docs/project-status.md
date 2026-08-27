# 메뉴 완성 작업 상태판

기준일: 2026-08-27

## 현재 마일스톤

**계정·설치 주체 전환 설계**: 전역 단일 operator는 현장별 단일 admin 계정만 관리하고, admin이 최초 현장 설치와 고객 운영을 담당하도록 인증·권한·UI 경계를 전환한다. 재설치와 모바일 변경은 이번 범위에서 제외한다.

## 작업 상태

| 작업 | 상태 | 내용 |
| --- | --- | --- |
| 에이전트 운영 기반 Task 1 | 완료 | 운영 기준과 지속 갱신 상태판을 작성했다. |
| 에이전트 운영 기반 Task 2 | 완료 | 프로젝트 전용 custom agent 7개의 기본 권한 프로필과 디렉터리별 `AGENTS.md` 소유·검증 규칙을 구성했다. 실제 QA 읽기 전용 검토는 부모 세션도 읽기 전용 권한으로 실행한다. |
| 메뉴 완성 설계 작성 | 완료 | [모니터링·제어·통계 완료 설계](superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md)에 재검토를 반영해 migration 시점 에너지 추적과 durable state outbox·application ACK까지 확정했다. |
| 메뉴 완성 구현 계획 | 완료 | [구현 계획](superpowers/plans/2026-08-26-monitoring-control-statistics-completion.md)을 12개 검증·커밋 단위로 작성했다. |
| 메뉴 완성 구현 | 완료(소프트웨어) | Task 12까지 구현·문서·전체 회귀와 실백엔드 설치·고객 운영 Chromium E2E를 통과했다. 실제 Raspberry Pi/ESP32-H2 HIL은 별도 검증으로 남아 있다. |
| 계정·설치 주체 전환 설계 | 완료 | [전역 운영자와 현장 관리자 계정 흐름 설계](superpowers/specs/2026-08-26-operator-admin-account-flow-design.md)에 로그인 아이디, 전역 단일 operator, 현장별 단일 admin, admin 최초 설치와 설정 범위를 정의했고 재설치는 제외했다. |
| 계정·설치 주체 전환 구현 계획 | 완료 | [구현 계획](superpowers/plans/2026-08-27-operator-admin-account-flow.md)을 DB·인증·권한·웹·E2E의 9개 검증·커밋 단위로 작성했다. |
| 계정·설치 주체 전환 구현 | 진행 중 | Task 1 expand migration과 Task 2 loginId 인증 경계(Review Fix Round 1 포함)를 완료했다. `User.loginId`는 required unique 로그인 정본이고 `email`은 nullable 연락처다. viewer invitation signup만 유지하며 operator/admin signup은 거부한다. 비밀번호 변경은 현재 세션만 남기고 나머지 세션을 revoke하며 민감 metadata 없는 감사를 남긴다. 격리 PostgreSQL에서 fresh/staged contract migration과 세션 회귀를 실행했다. Task 3 pending-site contract migration과 operator admin 관리 API가 후속이다. |

## 다음 단계

**메뉴 완성 소프트웨어 범위는 완료했다.** 모니터링, 수동 제어, 상태 기반 통계와 격리 PostgreSQL·Redis·mTLS Mosquitto·API·Web을 사용하는 Chromium E2E를 완료했다. E2E는 운영자 현장 생성, Gateway claim, 0건 검색과 재검색, 조명 2개 등록, 모니터링/Health, 고객 관리자·viewer 초대 가입, 통계, 저장 구역 CRUD, 개별·다중·층·구역 제어와 viewer 제어 차단을 실제 HTTP/MQTT 계약으로 검증한다. 실제 Raspberry Pi/ESP32-H2 HIL은 남아 있다.

## 알려진 미해결 항목

### 모니터링

- 진행 중인 조명 검색·등록 세션은 브라우저 새로고침 뒤 자동 복구되지 않는다. 현재 세션 ID가 화면 상태에만 있으므로 active session 조회·복구 API와 UI가 후속으로 필요하다.

### 제어

- 저장 구역 CRUD, ready 차단, 요청 멱등성, ACK 대상·종합 상태 검증과 개별·다중·층·구역 동기 제어는 구현됐다.
- Gateway Config Model Subscription Add/Delete와 실제 조명 제어는 Raspberry Pi/ESP32-H2 HIL에서 검증해야 한다.

### 통계

- 상태 이벤트 기반 오늘·월·년 집계, 일·월 차트, 180초 projection, 예상 비용과 24시간 100% 기준 절감량을 구현했다.
- 실제 ESP32-H2 상태 publication을 장시간 수집하는 HIL은 실행하지 않았다.

### 계정 인계

- 초대 토큰 소비와 고객 관리자 회원가입은 구현·E2E 검증됐다. 운영자용 고객 관리자 초대 발급 API/UI는 설정 메뉴 보류 범위이며 현재 제조·운영 절차에서 초대 record를 준비해야 한다.

### 실장비 검증

- Raspberry Pi, MQTT broker, ESP32-H2를 연결한 검색·등록·제어·상태 수집 HIL은 아직 실행하지 않았다.

## 기록 원칙

이 문서는 현재 상태 요약의 정본이다. 활성 작업의 세부 실행 단계는 `writing-plans` 체크리스트에서 관리하며, 상태가 바뀌면 두 기록을 함께 일치시켜 갱신한다. 장기 설계와 미구현 계획은 기존 설계·계획 문서를 유지하며, 완료 여부를 실제 자동 검증과 HIL 증거에 맞춰 갱신한다.
