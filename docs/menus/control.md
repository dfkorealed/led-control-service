# 제어 메뉴 기능 현황

기준일: 2026-07-05

## 구현 완료

- dashboard의 fixture 목록을 기반으로 제어 대상 조명을 표시한다.
- 개별 조명 카드를 선택할 수 있다.
- 선택 조명의 현재 밝기를 슬라이더에 반영한다.
- 0%, 30%, 70%, 100% 프리셋 버튼으로 밝기 값을 바꿀 수 있다.
- `POST /commands/dimming`으로 개별 조명 밝기 명령을 전송한다.
- 명령 전송 후 성공 메시지를 표시한다.
- dashboard의 group 목록을 그룹 카드로 표시한다.
- MQTT `command-ack` 이벤트가 command 상태를 갱신한다.
- Mock gateway가 dimming command를 받아 fixture state와 command ack를 발행한다.

## 미구현

- 그룹 단위 밝기 제어 UI 동작
- 스케줄 제어 생성, 수정, 삭제
- 이벤트 기반 제어 규칙 생성
- 차량 감지, 인체 감지, 시간대 조건 등 rule builder
- 명령 전송 이력 화면
- 명령 실패 사유 상세 표시
- 명령 retry, rollback, cancel
- 다중 선택 제어
- 층/구역별 일괄 제어
- 조명 on/off 전용 토글
- 제어 권한별 제한
- 위험 명령 확인 dialog

## 부족하거나 개선이 필요한 기능

- 현재 segmented control의 `그룹`, `스케줄` 버튼은 화면 상태를 바꾸지 않는다.
- `submitCommand`는 항상 `targetType: "fixture"`로 전송하므로 group card와 실제 그룹 제어가 연결되어 있지 않다.
- 명령 성공 메시지는 API 요청 성공만 의미하며 장비 ACK 완료와 구분되지 않는다.
- 오프라인 또는 장애 조명에도 `전송 가능`으로 보일 수 있어 상태 기반 disabled 처리가 필요하다.
- 명령 전송 후 dashboard invalidate 또는 최신 상태 반영이 명시적으로 연결되어 있지 않다.
- 제어 대상이 없을 때 empty state가 충분하지 않다.

## 관련 파일

- `apps/web/src/features/control/ControlView.tsx`
- `apps/api/src/commands/commands.controller.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/mock-gateway/src/simulator.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

제어 메뉴의 개별/그룹/스케줄/이벤트 제어 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
