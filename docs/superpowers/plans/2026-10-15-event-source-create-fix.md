# 이벤트 기준 조명 및 추가 실패 수리 Implementation Plan

> **For agentic workers:** 담당 역할을 나눠 직접 실행한다. 총괄은 조사 결과와 이 체크리스트/상태판을 통합하고, Web·Gateway 담당은 독립 소유 파일만 수정한다.

**Goal:** B1-L004 기준/B1-L006 실행 구성의 자격 차단 원인을 밝히고, 기준 외 센서의 이벤트 적용·유지 연장을 거부하는지 검증하며 추가 실패의 구체 안내와 기존 정상 복구 동선을 보완한다.
**Architecture:** 기존 source identity/준비·권한 검사를 유지한다. 등록 상태 미완료는 기존 장비 재확인→검증 결과 적용→BIO 분류·센서 준비 경로를 사용하며 임의 DB 상태 변경/재등록으로 대체하지 않는다.
**Tech Stack:** React/React Query, 기존 registration/automation HTTP 계약, Gateway Vitest product harness, 격리 Chromium fixture.
**Spec:** 사용자 2026-10-15 요청(기준 B1-L004/실행 B1-L006, 무관 감지 반응 및 일반 실패 안내), 기존 docs/menus/control.md·settings.md의 기준/등록 복구 계약.

## Global Constraints

- base c3f11789f6d4c6832aa28458f64a248e2b3fc034, branch codex/event-source-create-fix-20261015. MAIN의 사용자 AGENTS/상태판 dirty 및 다른 자기 감지 제어 브랜치는 보존한다.
- 공유 DTO/DB schema·migration/Gateway 제품 동작은 변경하지 않는다. 기존 RF/등록/프로필·기한·권한 검사를 완화하지 않는다.
- 운영 자료는 localhost READ ONLY의 해당 site/두 조명 범위만 조회한다. 실장비 RF 조회·설정·운영 데이터 적용·배포/재시작은 소프트웨어 보완과 구분하고 구체 승인 경계를 기록한다.
- 소프트웨어 fixture/최종 SET 의도는 실제 장비 광출력/HIL 증거가 아니다. 일반 온라인 표시를 센서 sourceEligible의 대체 증거로 사용하지 않는다.

## Review Focus

- 정상 등록된 무관 C 센서는 A→B의 시작뿐 아니라 유지시간 연장도 만들지 않는다.
- L004의 discovered/legacy protocol 상태를 주소/UUID 불일치나 센서 고장으로 오인하지 않는다.
- source candidate·준비 가능성과 sourceEligible를 구분하고 최종 준비 전 기준 선택/저장을 허용하지 않는다.
- prepare 실패와 rule POST 실패를 구분해 알려진 원인만 설명한다. 모르는 오류를 성공/설정 복구로 표시하지 않는다.
- 설정 이동/재조회 및 비동기 응답에서 site/principal 변경·중복 요청·실패 잠금을 유지한다.

### Task1: 실제 원인 조사

- [x] API/Web/Gateway source 및 현재 UI를 독립 읽기 조사한다.
- [x] localhost BEGIN READ ONLY로 L004/L006 등록 귀속·준비 상태와 현재 규칙/적용 snapshot 증거를 확인한다.
- [x] L004의 UUID/address/gateway/site/session/원 등록 command·ACK 귀속은 일치하나 Discovery.status=discovered, vehicleSensorProtocol=bluez_stateful임을 확인한다.
- [x] 현재 서버 규칙0/최근7일 이벤트 실행0, applied39와 정확 hash가 일치하는 V3 payload의 event0을 확인한다. Pi의 현재 메모리/디스크까지 확인한 것으로 확대하지 않는다.

### Task2: Web 추가 실패 안내 및 정상 복구 동선

- [x] Web 담당이 기존 설정의 등록 연결 확인/준비가 L004 형태에 도달 가능함을 확인하고 기존 설정 링크/카드 anchor만 연결한다.
- [x] 구체 오류·복구 동선의 실패 회귀(신규 9 FAIL)를 먼저 확인하고 기존 공통 UI/API로 최소 수리한다. 최종 covering 및 독립 검토는 다음 단계다.
- [x] 직접 관련 6파일167/167·자기 fixture Chromium PC/모바일2/2·Web typecheck/build/UI policy exit0, control/settings 메뉴를 갱신했다. 전체 Web/무관 audit는 실행하지 않았다. 원실패·정확명령은 `.local/event-source-create-fix-20261015/web/report.md`에 보존한다.

### Task3: 기준 외 센서 거부의 product 회귀

- [x] Gateway 담당이 기존 bio-sensor-common-path.integration.test.ts의 완전 fixture로 정상 C가 B SET/시작/A hold 연장을 만들지 않는지 검증한다.
- [x] A의 정상 적용·연장·원 기한 복귀를 함께 확인한다. 제품 RF 성공으로 기록하지 않는다. 최종 3/3·Gateway typecheck/diff exit0이며 독립 검토 I1의 C 권한 실제 null 단언 보완 후 재검토 ADDRESSED·새 C/I/M0·Ready YES다.

### Task4: 독립 검토·소프트웨어 통합 및 운영 복구 경계

- [x] 독립 담당이 소유 diff/회귀·원 증거·자격 우회 여부를 검토했다. Web/Gateway 모두 Ready YES·새 C/I/M0, Gateway I1은 실제 null 단언으로 해소했다.
- [x] 소유 16파일만 `3f62905b`로 커밋하고 `codex/mvp1-cloud-web`에 로컬 ff-only 병합했다. MAIN 기존 AGENTS/상태판 사용자 내용 SHA와 index empty를 검증해 보존했다. push/배포/서비스 재시작은 하지 않았다.
- [x] 실제 L004 복구의 query→receipt→apply→classification 및 필요 센서 준비 효과를 확인했다. 기존 ID/기본 밝기는 유지하며 센서 준비는 장비 모드를 설정할 수 있다. 운영 RF/등록 apply/SET은 미실행이다. 저장소 AGENTS.md의 운영 환경 변경 승인 관문에 따라 구체 승인 뒤 기존 정상 UI로 수행할 후속 단계로 남긴다. 소프트웨어 보완만으로 등록/장비 상태 복구를 주장하지 않는다.

## 현재 한계

장비 조회/등록 복구/센서 모드 SET은 아직 실행하지 않았다. L006 자체 sensor 동작·감지 범위 중첩·장비 내부 연동 또는 Pi의 현재 상태는 확인되지 않아 무관 감지 현상을 코드 필터 결함으로 확정하지 않는다. B를 임의 강제 OFF하거나 원 설정을 바꾸지 않는다.

## 최종 소프트웨어 결과

검증된 제품 Web13파일 및 Gateway 테스트1파일 SHA는 병합 후에도 동일하다. 직접 Web167·Gateway3·격리 Chromium2와 타입/build/UI 정책을 통과했고 양쪽 독립 검토 Ready YES다. 이 결과는 이벤트 추가 원인 안내·기존 정상 복구 접근 및 기준 필터 회귀에 대한 것이다. 실제 L004 등록 복구·센서 준비·이벤트 생성/활성화와 무관 센서에 대한 물리 현상 검증은 운영 승인 후속으로 남아 있다. 원 결과/검토/보존 병합 증거는 이 worktree와 MAIN `.local/event-source-create-fix-20261015`에 유지한다.
