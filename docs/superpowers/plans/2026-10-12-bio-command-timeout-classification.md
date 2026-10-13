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

## 2026-10-13 사용자 선택 후속: 개별 응답 대기 확대

사용자는 과거 이력 조회 재분류 대신 응답 대기를 넉넉히 늘리도록 요청했고, 이번에는 응답 대기시간 조정과 대규모 제어 설계 정리까지 선택했다. 위 과거 기록 보정·다른 채팅 메시지 발송 단계는 이번 범위에서 실행하지 않는다. 현재 MAIN 소스·dist에 기존 API TIMEOUT 정규화가 포함되어 있으나, 과거337f 기록은 그대로 보존한다.

**Goal:** BIO USB ACK 기본 대기를300ms→1,000ms, 조명 상태 보고 기본 대기를300ms→2,000ms로 늘려 늦은 정상 응답을 수용한다.
**Architecture:** Gateway의 설정과 직접 생성 경로에서 동일한 기본값을 사용한다. 명시적인 설정 override, 응답 신원/종류 검증, 세대 폐기, Set 재시도 금지와 기존 전체 명령 만료 경계를 유지한다.
**Workspace:** `.worktrees/dimming-timeout-budget-20261013`, branch `codex/dimming-timeout-budget-20261013`, base `d88e4d4c`, merge target `codex/mvp1-cloud-web`.
**Files:** Gateway timeout/config/client/transport 및 해당 Vitest 테스트·README/env 예제·`docs/menus/control.md`는 gateway 소유; 이 체크리스트와 `docs/project-status.md`는 총괄 소유.

### Task 3: Gateway 대기 기본값과 회귀

- [x] ACK/상태 보고와 전체 명령 deadline을 구분하고 현재 wire 직렬 처리·target 제한을 읽기 조사한다.
- [x] 사용자에게ACK1초·상태보고2초 및 대규모 설계만 정리하는 범위를 보고하고 선택을 반영한다.
- [x] 지연ACK/상태보고·응답부재·명시적override 테스트로 기본값 변경 전 assertion RED를 확인한다.
- [x] 실제 설정 경로와 직접 client/transport 생성 기본값을 수정하고 scoped GREEN을 확인한다.
- [x] Gateway 전체 test·typecheck·build, 메뉴5섹션·README/예제를 검증한다.

### Task 4: 검토·대규모 설계 기록·로컬 머지

- [x] 대규모 제어 설계와 현재 제한을 아래 및 메뉴 문서에 정리한다.
- [x] 독립 QA가 diff/RED-GREEN/원문 응답 검증·no Set retry·만료 fence·문서와 증거를 검토한다.
- [ ] 소유 변경만 커밋하고 MAIN의 진행 중 사용자/다른 작업 변경을 보존하여 로컬 머지한다.
- [ ] 머지 소스 일치와 dirty 변경 보존을 검증하고 소프트웨어 완료·실장비 적용 경계를 함께 보고한다.

### 대규모 제어 설계 (미구현)

- 현재 수동 Set은 한 dispatch이며 wire 대상 상한은1,000개다. 상태 확인 Get의64개 분할은 수동 Set 분할을 구현한 것이 아니다. 따라서1,000개 초과 제어는 이번 수정으로 지원되지 않는다.
- BIO 가상 mesh group은 개별 unicast로 처리되고 USB wire 작업은 직렬이다. 양수 밝기는 대상별 밝기Set→강제ON Set→밝기Get→모드Get의 최소4회 transaction,0%는 강제OFF Set→모드Get의2회다. 다른 adapter의 실제 병렬성/그룹 전송과 구분해 실행 예산을 산정해야 한다.
- 현재 전체 수동 실행 기본8초/설정 상한29초, wire TTL10초와 만료2초 guard, API accepted 결과 대기30초는 이번 수정에서 유지한다. 긴 개별 대기는 전체 만료를 넘겨 Set을 허용하지 않는다. ACK/상태보고 확대만으로 모든 대상의 적용 확인을 보장할 수 없다.
- 후속 설계는 부모 명령과 bounded chunk dispatch·대상별 결과 집계·진행률/heartbeat/취소를 함께 다룬다. chunk를 실제 발행할 때 fresh TTL을 부여하고 command/dispatch idempotency와 정확한 대상 집합을 유지해야 한다.
- 현재 TTL은 각 native Set 직전에도 검사하므로 수신 freshness와 장기 실행을 분리하려면 별도 durable 실행 lease(commandID·대상·bootID·publishEpoch·monotonic deadline), 대상별 최신 수동 명령 fence, API 대기/복구 정책을 함께 설계해야 한다. 현재 pending 수동 명령끼리의 supersession을 이미 보장한다고 가정하지 않는다.
- 장기 처리 중 재시작·응답 유실은 기존 불확정 결과 및 Get 확인으로 수렴한다. 실제 응답 없이 성공을 합성하거나 Set을 자동 재실행하지 않는다. 처리량 수치는 실제 장비 지연/queue 측정 후 확정한다.

### 후속 검증 증거

- 초기 assertion RED는 Node24.19.0에서5FAIL/2PASS/94개 필터 제외였고 초기 GREEN은7PASS다. 초기 탐색의 직접client USB-only 설정 분리 테스트는 최종 요구인 기존 `timeoutMs` 단독 호환 회귀로 교체했다. 모든 최종 신규 테스트가 동일 RED 이름을 가졌다고 해석하지 않는다. 기존 timeout 시간 좌표를 맞춘 최종 focused3파일191PASS(exit0)는 Node24에서 검증했다.
- 최종 기준 환경은 Node22.20.0/pnpm9.15.0이며 `workspace:prepare`·Gateway typecheck/build는exit0다. 코드·메뉴 freeze10파일 SHA256과 원 로그는 수리 worktree `.local/dimming-timeout-budget-20261013`에 보존한다. 전체Gateway test도exit0(102파일/1,839PASS/FAIL0/SKIP0,82.95초)다. 독립 QA는 C0/I0/M0·Ready to merge Yes다. 머지 검증은 아직 진행 중이다.
- 초기 RED5FAIL 중 변경된 직접client 탐색1case를 제외한 나머지4FAIL은 최종 기본 대기 요구와 일치한다. 최종 override 회귀와 전체 Node22 GREEN을 별도 증거로 유지한다.
