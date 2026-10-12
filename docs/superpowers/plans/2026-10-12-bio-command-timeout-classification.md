# BIO 응답 유실 이력 판정 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 담당 역할은 독립 읽기 조사 후 백엔드 순차 구현, QA 읽기 검토다.

**Goal:** BIO TIMEOUT 응답 유실을 확정된 일부 미적용으로 오인하지 않고 기존 불확정 명령의 상태 확인 경로로 연결한다.
**Architecture:** 기존 신원·집합·aggregate·원문 hash 검증을 먼저 유지한 채 API의 fixture 결과 TIMEOUT 호환 정규화만 STATUS_TIMEOUT과 같은 의미로 처리한다. 성공 승격·장비 Set 재전송·보관/UUID/hold 우회는 하지 않는다.
**Tech Stack:** NestJS, Prisma/PostgreSQL, Jest, TypeScript; Gateway/BIO는 읽기 조사.
**Spec:** 사용자 명령337f5ac3-76fd-4abc-b41b-bab2a3d896c1 버그 요청과 기존 docs/menus/control.md의 불확정·복구 계약.

## Global Constraints

- MAIN 사용자 AGENTS.md dirty 수정·기존 서비스·DB 기록·장비 설정을 보존한다. 운영/실장비 변경은 검토 가능한 수리 결과를 만든 뒤 해당 승인 관문을 따른다.
- 실제 Command70%, 4개 대상 중 B1-L004 failed/TIMEOUT, 나머지3 succeeded70을 RED 입력으로 사용한다. Gateway 최신 소스와 실제 실행 bundle의 일치 여부는 미확정이다.
- API/공유 계약·schema 변화0, source owner apps/api. TIMEOUT을 성공으로 합성하지 않고 원 faultCode를 보존한다.
- 과거 명령은 자동으로 DB 성공 상태로 덮지 않는다. 현 기록 재분류/장비 Get/런타임 반영 여부는 검증과 별도로 기록한다.

## Review Focus

- 유실TIMEOUT과 확정state_mismatch를 구분해 후자3성공/1실패는 기존 partially_applied 유지.
- fixture집합/aggregate 불일치와 duplicate hash 충돌은 기존 거부/기록 유지.
- unknown 이후 원70%/원4UUID 상태 확인 및 겹치는 Set 잠금 유지.
- failed+STATUS_TIMEOUT과 native timed_out 기존 의미 보존.
- 과거 partially_applied DB행을 소스 변경만으로 수리했다고 주장하지 않음.

### Task 1: 원인 조사·API 정규화·회귀

**Files:** apps/api/src/mqtt/mqtt.service.ts; apps/api/src/commands/command-delivery-reliability.spec.ts 또는 기존 해당 MQTT 단위 suite; docs/menus/control.md; 필요 확인된 교훈 docs/lesson_leared.md.
**Interfaces:** consumes 기존 DeviceStatusAckV2; produces 기존 command outcome unknown/verification_required 및 timed_out result. 새 wire/interface 없음.

- [x] 실제 Command/Dispatch/FixtureResult를 READ ONLY로 조회하고 source/동일 조명 과거70·100·37 TIMEOUT/0성공 기록을 대조한다.
- [x] gateway와 backend 역할의 독립 source 조사를 회수한다. 구체 USB/RF 유실 단계와 현 Pi bundle은 미확정으로 남긴다.
- [x] 실제4결과 형태 failed/TIMEOUT을 수신했을 때 unknown·timed_out·상태 확인 경로가 되는 실패 테스트를 먼저 실행한다.
- [x] mqtt.service 기존 STATUS_TIMEOUT 정규화 조건에 승인된 TIMEOUT 호환을 최소 적용하고 원문 검증/DB faultCode/확정오류를 보존한다.
- [x] scoped RED→GREEN, API typecheck/test/build와 unknown 이후 확인/겹침 잠금·실패 회귀를 실행하고 메뉴 문서를 갱신한다.

### Task 2: 독립 검토·반영 경계

- [x] QA 역할이 소유 diff/RED-GREEN/실제 사례와 분류 semantics, 과거 기록/현재 실행 bundle 한계를 읽기 검토한다.
- [x] 총괄이 검증 결과와 체크리스트/상태판을 함께 최신화하고 소유 파일만 커밋·로컬 통합 가능한 상태로 만든다.
- [x] 로컬 API 반영 및 과거 명령에 필요한 안전 재분류/Get의 구체 절차를 마련하고 실행된 범위와 승인 필요 범위를 구분해 보고한다.

### 조사·RED 중간 증거

- API Prisma Client 생성 전의 launcher/타입 준비 실패를 assertion RED와 구분한다. 실제 생성 후 RED는 2FAIL/6PASS/139SKIP: 실4조명70% expected unknown / actual partially_applied, 기존 소비자 TIMEOUT expected unknown / actual not_applied. 원 로그 `.local/command-ack-timeout-20261012/backend/red-generated.log`.
- 문서에 지정된 Pi `dfkorea@dfkorea.local`의 read-only docker ps/inspect: 문제 시각을 포함하는 task2c container는 04:21:31.861Z~06:55:19.675Z, image72b1af7d9105/revision27138ae5였다. 이 구버전 source는 BIO applyUnicast catch를 무조건 failed로 반환한다. 해당 명령 시간대 docker logs는0줄이고 rawACK DB 보관도 없어 정확한 USB/GET 단계와 컨테이너 귀속을 확정하지 않는다. 현재06:55:54 이후의 별도 field container(revision440ead0c)와 구분하며 Pi stop/start/exec/Set은0이다.

### 최종 소프트웨어 검증·반영 절차

- backend 원 session 회수: assertion RED exit1(2FAIL/6PASS/139SKIP), scoped exit0(5 suites259PASS/1SKIP), API 전체 exit0(264PASS/84SKIP suites,3271PASS/1209SKIP tests,875.833s), typecheck/build/diffcheck exit0. 원 로그와 source/raw SHA는 `.local/command-ack-timeout-20261012/backend/source-and-results.json`에서 검토했다. 환경 의존 opt-in skip·실장비 미실행을 별도 한계로 유지한다.
- fresh QA는 원문 검증/4개 실제UUID·70%/TIMEOUT-vs-mismatch/native timed_out/STATUS_TIMEOUT/duplicate guard/Get·겹침 Set 잠금을 읽고 소유4파일 및 raw 해시 일치를 확인했다. 문서 포함 C/I/M0·Ready to merge Yes 최종판정. 같은 제품 소스의 테스트를 중복 전체 실행하지 않았다.
- 현재API PID90698은 다른 센서 현장시험용 overlay다. MAIN 수리 통합은 해당 runtime을 변경하지 않는다. 실행 반영은 owner `제어 페이지 담당자`와 기존 overlay 변경 보존/진행중 명령 drain/원복 가능한 현재 실행 identity·소스 snapshot/타입·빌드/현재 DB·Gateway 신원 preflight/한 번의 API 재기동/ready·신원·기존 데이터 postflight 순서를 합의한 뒤 별도 승인된 절차로 수행해야 한다. Pi 재배포·새 밝기 Set은 이 API 수리의 반영에 필요하지 않으며 자동으로 추가하지 않는다.
- 기존337f를 보정하려면 원본 before snapshot·원 UUID/70%/4집합/dispatch/result/CAS·보관/tenant·후속0% 명령·잠금 영향 및 감사 기록을 함께 검토한다. unknown만 UPDATE하거나 현재0% Get을 과거70% 실패/성공의 증거로 바꾸는 절차는 채택하지 않는다.

### 실제 런타임·과거 기록 후속 (미실행)

- [ ] 사용자 메시지 발송 승인 후 현장시험 owner에 수정 커밋을 전달하고 반영 순서를 합의한다.
- [ ] 별도 승인된 현재 overlay 보존·drain·재시작·postflight로 실행 API에 반영한다.
- [ ] 과거337f의 보정 필요 여부와 의미·잠금 영향에 대해 감사 가능한 절차를 확정한다. 성공값 합성 금지.

- 제품·제어문서 소유4파일 커밋 `03bb454d`를 기존 MAIN `1ffa69f4`에서 ff-only 통합했다. 원 사용자 AGENTS.md hash `8472784d2cf414e45cc3f4b9ae3e9e3bf69acdf7`은 통합 전후 보존 대상이며, 원 증거를 가진 수리 worktree는 runtime handoff까지 유지한다. 실제 실행 반영·과거 보정 체크는 위 미실행 상태로 남긴다.
