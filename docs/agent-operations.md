# 에이전트 운영 기준

기준일: 2026-08-26

이 문서는 프로젝트 자동화 작업의 단일 운영 기준이다. 새 운영 문서를 작업마다 만들지 않으며, 이 문서와 `docs/project-status.md`를 지속 갱신한다.

## 역할과 소유 경계

| 역할 | 책임 | 주 소유 범위 |
| --- | --- | --- |
| 총괄 | 요구사항 확정, 작업 분해, 의존성·승인 관리, 결과 통합 | 전체 조율, 공유 계약 |
| designer | 사용자 흐름, 화면 명세, 디자인 토큰, 접근성 검토 | `docs`, 웹 디자인 토큰 |
| web_frontend | React 웹 화면, 상태 관리, 브라우저 E2E | `apps/web` |
| mobile | React Native, WebView, 네이티브 인증·권한 | `apps/mobile` |
| backend | NestJS API, PostgreSQL, Redis, MQTT 서버 계약 | `apps/api`, `packages/shared` 승인 후 |
| gateway | Raspberry Pi, Docker, BlueZ, MQTT, 장비 인증서 | `apps/gateway`, `infra` 일부 |
| firmware | ESP-IDF, BLE Mesh, PWM, Health, OTA | `apps/esp32-h2-firmware` |
| qa_reviewer | 요구사항·코드·문서·검증 증거 검토 | 기본 읽기 전용 |

`packages/shared`, 공통 MQTT 계약, Prisma 스키마, 배포 인프라는 둘 이상의 역할에 영향을 준다. 변경 전 총괄 승인과 영향 역할의 검토를 받고, 병렬 수정하지 않는다.

## Custom Agent와 Skill

Custom agent는 **누가** 작업하는지를 정의한다. 역할, 기본 모델, 권한, 소유 범위와 검토 책임을 고정한다. Skill은 **어떻게** 작업하는지를 정의한다. 따라서 custom agent는 기존 Superpowers skill 전체를 대체하지 않는다.

계속 사용하는 skill:

- `brainstorming`
- `writing-plans`
- `test-driven-development`
- `systematic-debugging`
- `verification-before-completion`
- `requesting-code-review`, `receiving-code-review`

Custom agent가 대체하는 범위는 임시 역할 프롬프트, 역할 선택, 기본 모델·권한·파일 소유권이다. `subagent-driven-development`의 durable role routing은 custom agent가 일부 대체하지만, 태스크별 독립 context, review gate, 작업 상태 ledger는 유지한다.

## 작업 생명주기

1. 총괄은 요구사항, 완료 조건, 영향 메뉴와 담당 역할을 `project-status.md`에 기록한다.
2. 담당 역할은 관련 `AGENTS.md`, 교훈 문서, 메뉴 문서와 기존 코드를 읽고 계획을 확정한다.
3. 구현 전 테스트 또는 재현 절차를 먼저 정의한다.
4. 독립 소유 범위만 병렬로 작업하고, 공유 계약 변경은 순차로 처리한다.
5. 담당 역할은 코드·테스트·관련 메뉴 문서를 같은 작업 단위에서 갱신하고 작은 단위로 커밋한다.
6. QA가 요구사항, diff, 자동 검증과 문서 일치 여부를 검토한다.
7. 총괄은 결과와 미해결 사항을 상태판에 반영하고, human gate가 필요한 작업은 사용자 승인 뒤 진행한다.

## 병렬화와 승인 규칙

- 서로 다른 앱 디렉터리의 독립 작업만 병렬 실행한다.
- 같은 파일, 같은 API 계약, 같은 Prisma migration은 한 역할만 수정한다.
- `packages/shared`와 DB 스키마는 총괄 승인 후 관련 역할이 순서대로 변경한다.
- 인증서, private key, DB 초기화, 실제 장비 flash, Raspberry Pi 배포, 운영 환경 명령은 human gate를 통과한 뒤 실행한다.
- QA는 기본 읽기 전용이다. 수정이 필요하면 총괄이 담당 역할에 별도 태스크로 배정한다.

## 문서와 커밋 규칙

- 기능 변경 시 영향을 받은 `docs/menus/*.md`를 같은 커밋에서 갱신한다.
- DB 변경 시 `docs/database-schema.md`를 같은 커밋에서 갱신한다.
- 반복 가능한 실패와 예방책은 `docs/lesson_leared.md`에 누적한다.
- 현재 진행 상태와 다음 작업은 `docs/project-status.md`만 갱신한다.
- mock·자동 fixture·빌드 성공은 실제 하드웨어 검증 완료와 구분해 기록한다.

## 다음 자동화 단계

CI와 HIL 자동화는 다음 단계다. CI는 타입 검사, 린트, 단위·통합·브라우저 테스트와 build를 자동 실행한다. HIL은 전용 Raspberry Pi와 ESP32-H2에서 인증, 검색, provisioning, 상태 수집, 제어 및 재시작 복구를 검증한다. 실제 장비를 변경하거나 배포하는 HIL 실행은 human gate를 유지한다.
