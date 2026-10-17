# 서비스 전체 클린 코드 정책 및 동작 보존 정리 설계

작성일: 2026-10-17

상태: **방향 승인 후 작성한 서면 설계 — 사용자 검토 대기**. 이 문서는 코드 수정·도구 설치·실행 계획 승인이나 운영 적용 완료를 뜻하지 않는다.

## 1. 목적과 승인 범위

사용자는 서비스 전체 코드를 확인하면서 정리하고, 이후 개발에도 적용할 기본 클린 코드 정책을 명확하게 정의하도록 요청했다. 유지보수자가 파일을 열었을 때 책임과 의도를 이해할 수 있고, 같은 업무 규칙이 중복되지 않으며, 새로운 변경이 기존 정책을 다시 어기지 않는 상태를 목표로 한다.

사용자가 승인한 방향은 **동작을 보존하는 단계적 정리**다. 포맷만 통일하는 접근은 책임 혼재를 해결하지 못하고, 전면 재작성은 장비·데이터·비동기 상태의 안전성을 다시 증명해야 하므로 선택하지 않는다. 미리 정한 파일 크기나 추상화 수를 맞추는 것이 목적은 아니다.

- 명명·책임 분리, 의미가 같은 중복 제거, 타입·오류·비동기 경계, 공통 UI 재사용, 주석과 자동 검사 기준을 함께 다룬다.
- 기존 기능·UI 표현·공개 계약·데이터·실패 처리 의미는 유지한다. 정리 중 발견한 제품 결함은 별도 항목으로 기록하고 정리 커밋에 조용히 섞지 않는다.
- 이번 승인 단계에서는 이 설계와 상태 기록만 작성한다. 서면 설계 승인 뒤 `writing-plans`로 구체적인 실행 계획을 작성하고, 계획 및 실행 방식 승인 뒤 구현한다.

## 2. 조사 기준과 현재 증거의 한계

조사 기준 checkout은 `/Users/kim-jh/Documents/led-control-service`, 브랜치는 `codex/mvp1-cloud-web`, 기준 커밋은 `dabb01f42867d8f641fc4d0179c827e176a48376`이다. 작업 시작 시 `AGENTS.md`와 `docs/project-status.md`에 있던 다른 작업의 미커밋 변경을 보존한다.

읽기 전용 사전 조사에서 다음을 확인했다.

- 주요 TypeScript 패키지는 `strict`를 사용하지만 `lint`와 `typecheck`가 모두 `tsc --noEmit`이다. 추적 파일 검색에서 별도 ESLint·Prettier·Biome 설정을 찾지 못했다.
- Web은 `components/ui`와 `apps/web/scripts/ui-policy.mjs`를 이미 보유한다. 공통 UI가 없다는 전제로 새 체계를 만들지 않고 기존 정책을 유지한다.
- Gateway 진입점, MQTT 서비스, 등록·제어 화면 등에 책임 분리 후보가 있고, 일부 timeout/error predicate는 실제 의미가 같은 중복임을 확인했다. 후보는 결함이나 즉시 삭제 대상으로 확정한 목록이 아니다.
- 상태판에는 Web·API·Gateway의 기존 실패 및 환경 의존 제외 기록이 있다. 이번 조사에서 테스트를 실행하거나 현재 기준 결과를 다시 판정하지 않았다.
- 별도 Web 디자인 시스템 통합 작업은 이 정리와 구분한다. 미승인 간격·타이포·색상 변경을 코드 정리에 포함하지 않는다.

`git ls-files`로 `apps`, `packages`, `scripts`, `tests`, `infra` 아래의 TS/TSX/JS/JSX/MJS/CJS/C/H/SH 파일을 집계한 결과는 2,076개다. 경로·파일명 기반 임시 분류는 제품·도구·설정 1,082개와 테스트 계열 994개이며, fixture와 지원 코드가 섞일 수 있다. CSS·HTML·SQL·Prisma·JSON·YAML 등은 이 수치에 포함되지 않는다. **이는 파일 inventory이며 전수 소스 리뷰 결과가 아니다.** 실행 시작 시 최종 포함 범위를 다시 집계한다.

## 3. 전체 점검의 대상과 기록 방식

### 포함 범위

- `apps/web`: 고객·운영자·공개 화면, 공통 UI, API client, 상태·query·effect, CAD/지도 worker, 테스트와 빌드 설정.
- `apps/mobile`: WebView 셸, bridge, 네이티브 권한·인증 연결과 테스트.
- `apps/api`: controller·DTO·service·외부 I/O, DB transaction·publisher·worker, CLI·Prisma 도구, 테스트.
- `apps/gateway`: bootstrap·runtime·MQTT·BIO·Mesh·automation·영속 저장·스크립트·테스트.
- `packages/shared`, `packages/automation-engine`: 공개 export·검증 계약·시간 계산·자동화 규칙과 테스트.
- `apps/esp32-h2-firmware`: C/H·ESP-IDF 설정·호스트 테스트. 신규 기능이 BIO 전용이라는 이유로 legacy 코드를 제거하지 않는다.
- root 및 패키지 설정, `scripts`, `infra`, `tests`, `.github`와 저장소에 있는 실행·배포 설정. 외부 서비스에 적용하지 않고 소스만 점검한다.
- 소스와 연결된 README·메뉴·운영 문서의 실제 경로·명령·책임 설명.

### 제외와 보호

의존성·vendor·생성물·빌드 결과·번들·캐시·ignored 실행 증거·바이너리 도면/이미지·키/인증서/토큰·실제 env 값은 코드 정리 대상으로 삼지 않는다. 제외 경로와 이유도 목록에 남긴다. SQL migration은 읽기 점검에 포함하지만 이미 적용된 파일을 수정·포맷·재생성하지 않는다. 기존 DB ID·스키마·영속 JSON 버전·API/MQTT/BIO wire 계약 변경은 기본 정리 범위 밖이다.

### 파일별 검토 기록

실행 계획에서 하나의 추적 가능한 점검 원장을 정하고 다음 정보를 남긴다. 실행 중간에 여러 보고서가 서로 다른 정본이 되지 않게 한다.

| 필드 | 의미 |
| --- | --- |
| 파일·기준 소스 | 경로, 기준 커밋 또는 내용 해시, 영역·담당 |
| 분류 | 제품 / 테스트·fixture / 설정·스크립트 / 문서 / 생성물·보호 대상 |
| 검토 상태 | 미검토 / 검토 중 / 검토 완료. 파일 검색·지표 집계만으로 완료 처리하지 않음 |
| 처리 결과 | 유지 / 수정 / 명시 예외 / 승인 대기 |
| 판단 근거 | 적용 정책 ID, 책임·중복·타입·오류·주석·안전 경계에 대한 실제 확인 |
| 검증 | 관련 명령·소스 기준·결과·제외와 한계. 변경 없으면 무실행 이유를 구분 |
| 예외 | 구체 위치·이유·담당·재검토 조건. 광범위 디렉터리 무시로 대체하지 않음 |

파일이 이동·추가·삭제되면 원장과 대상을 함께 갱신한다. 최종 소스에서 변경된 파일은 재검토하며 최종 inventory와 원장을 다시 대조한다. 전체 완료는 포함 대상의 미검토·판정 없는 파일이 0인 상태를 뜻한다. 장비 검증 부재나 기존 실패가 남으면 별도 한계로 공개한다.

## 4. 클린 코드 정책

아래는 승인 후 적용할 정책의 내용이다. 실제 설정과 개발자 진입점은 구현 단계에서 `docs/clean-code.md`에 단일 정본으로 만들고 README·AGENTS·운영 기준은 이를 참조한다. 현재 미커밋 AGENTS의 다른 규칙을 덮어쓰지 않는다.

### CC-01 명명과 데이터 의미

- 함수는 수행하는 일과 결과를 드러낸다. boolean은 가능하면 `is`, `has`, `can`, `should`처럼 질문 형태를 사용한다.
- 모호한 `data`, `result`, `handle`이 책임을 숨기면 도메인 의미를 드러내는 이름으로 바꾼다. 짧은 반복문 변수까지 장황하게 늘리지 않는다.
- 혼동 가능한 단위는 `timeoutMs`, `holdSeconds`, `brightnessPercent`처럼 표시한다. 날짜만 있는 값, 현지 시각, UTC instant를 구분한다.
- 내부 변수 이름을 정리하면서 외부 필드명·DB 열·직렬화 순서·hash 입력·오류 코드·사용자 문구를 바꾸지 않는다.

### CC-02 단일 책임과 모듈 경계

- 화면 표현, 업무 규칙·순수 변환, 외부 I/O와 실행 조립을 구분한다. 별도로 변경되는 책임을 우선 분리한다.
- 길이는 검토 신호이지 강제 상한이 아니다. 짧게 만들려고 흐름을 의미 없는 함수 수십 개로 흩뜨리지 않는다.
- 순수 helper와 표현 컴포넌트부터 옮긴다. 상태·effect·transaction·장비 owner 분리는 입력/출력과 수명 계약을 확보한 뒤 수행한다.
- Web hook은 상태 수명과 비동기 조율을, 컴포넌트는 표현을 소유하도록 한다. React effect 순서·closure·ref·abort·scope를 기계적으로 재배치하지 않는다.
- API controller는 기존 입력·인증/인가 경계를 유지하고 service의 orchestration과 순수 변환을 구분한다. 정리를 위해 의미 없는 repository·service 계층을 추가하지 않는다.

### CC-03 중복 제거와 추상화

- 같은 입력 허용 범위·출력·실패 계약·수명을 가진 로직만 공통화한다. 비슷하게 보이는 문법만으로 합치지 않는다.
- `isRecord`의 배열 허용 여부, Prisma 오류의 실제 instance 검사와 구조 검사, timeout 뒤 실제 요청 취소 여부는 각각 다른 의미다.
- feature 한 곳에서만 사용하는 helper는 feature 안에 둔다. 여러 패키지에서 보인다는 이유로 곧바로 `packages/shared`로 이동하지 않는다.
- 일반적인 `utils.ts`를 계속 키우지 않고 `prisma-errors`, `publish-timeout`처럼 책임이 드러나는 모듈을 사용한다.
- outbox 전체를 하나의 generic 구현으로 합치지 않는다. ACK·재전송·삭제·복구 의미가 같다는 증거가 있을 때 별도로 설계한다.

### CC-04 타입과 검증

- 외부 HTTP/MQTT/USB/파일/오류 입력은 신뢰하지 않는다. `unknown`에서 현재 검증 규칙을 통과한 뒤 도메인 타입으로 변환한다.
- 신규 `any`, 비-null 단언, 이중 단언은 기본적으로 피한다. 불가피한 라이브러리 경계에는 최소 범위의 adapter와 이유·검증 근거를 둔다.
- Prisma의 생성 타입과 transaction client 타입을 우선 사용한다. 타입을 맞추려고 전체 Prisma 인스턴스를 강제 캐스팅하지 않는다.
- 현재 boolean validator는 같은 수용/거절 의미의 type predicate 또는 parser로 개선할 수 있다. `.strict()`, refinement, coercion, 오류 path를 바꾼 schema로 자동 치환하지 않는다.
- 테스트도 타입 정리 대상이다. 정상 제품 경로의 안전 검증을 생략하는 double이나 넓은 `any`로 타입 오류를 감추지 않는다. 악성 입력 테스트의 의도적 타입 위반은 국소 예외로 설명한다.

### CC-05 오류·비동기·자원 수명

- 빈 `catch`와 버려지는 Promise에는 전파·재시도·원장 기록·의도된 best effort 중 처리 방침이 드러나야 한다.
- 의도적인 취소나 종료 중 해제 오류까지 사용자 실패로 승격하지 않는다. 반대로 실제 실패를 성공값으로 바꾸지 않는다.
- listener·timer·subscription·worker·AbortController는 소유자와 정리 경로가 명확해야 한다. 종료 시 새 작업 차단과 진행 작업 drain을 보존한다.
- 지연 응답이 이전 현장·사용자·장비 세대의 상태를 갱신하지 않도록 기존 scope/generation 검사를 유지한다.
- 오류 개선을 이유로 raw payload·token·cookie·키·장치 식별자·stack을 새 로그에 출력하지 않는다. 기존 정제된 코드와 로거를 사용한다.

### CC-06 UI와 설정 재사용

- 공통 Button·Card·form·overlay·loading 등은 기존 `apps/web/src/components/ui`와 디자인 토큰을 우선 사용한다.
- feature 전용 조합은 feature 안에 둔다. 단일 사용 조합을 수많은 boolean props를 가진 범용 컴포넌트로 만들지 않는다.
- 공통화 후에도 accessible name·role·focus·키보드·터치 영역·로딩/오류/빈 상태를 보존한다.
- 이번 작업으로 색상·간격·폰트·문구·경로를 새롭게 디자인하지 않는다. 별도 디자인 시스템 작업과 겹치는 파일은 소유권을 확인하고 순차 적용한다.

### CC-07 주석과 확인 근거

- 주석은 필요한 이유, 방지하는 실패, 소유 계층과 제약을 설명한다. 함수 본문의 한국어 번역을 반복하지 않는다.
- 비표준 예외·의도적인 중복·취소하지 않는 timeout·독립 transaction·내구 저장 순서에는 이유를 남긴다.
- BIO 패킷 관련 주석은 해당 코드의 필드·단위·범위·byte order·길이/검증값, ACK와 실제 적용 확인의 차이, 실패/복원 시 의미를 설명한다. 이미 자세한 안전 주석을 줄이는 작업은 하지 않는다.
- 제조사 정적 자료, 캡처·독립 read-back, 소프트웨어 테스트, 실제 LED 관측을 구분한다. 확인됨·추정·미확인 표시를 근거 없이 승격하지 않는다.
- 의미와 단위가 다른 opcode·한도는 이름 있는 상수로 표현하되 모든 숫자나 한 번 쓰는 자명한 값까지 상수화하지 않는다.

### CC-08 미사용 코드와 호환성

- 삭제 전 정적 import/export 외에도 동적 import·라우트·CLI·package export·빌드·배포·테스트·과거 상태 복구 경로를 확인한다.
- 현재 BIO 신규 기능만 지원한다는 정책은 legacy BlueZ/native/펌웨어·등록·migration·구버전 parser 자동 삭제 권한이 아니다.
- 공유 파일 이동 시 기존 import/export 진입점을 유지한다. 공개 진입점 제거는 별도 호환성 변경으로 다룬다.
- 주석 처리된 폐기 코드는 실제 사용 근거와 Git 이력을 확인한 뒤 제거할 수 있지만, 보호 설명·실패 증거·운영 절차는 죽은 코드로 분류하지 않는다.

### CC-09 포맷과 정적 검사

- TypeScript/JavaScript 품질 검사는 ESLint와 typescript-eslint, 포맷은 Prettier로 역할을 나눈다. 버전은 실행 계획의 도입 작업에서 Node22·pnpm9.15·현재 TS/React와 호환되는 exact 버전으로 검증·고정한다. 지금 설치하지 않는다.
- 기본 TS/JS 표현은 2칸 들여쓰기, 세미콜론, 큰따옴표, 후행 쉼표 없음, LF로 한다. 줄 길이 목표는 100자이며 긴 문자열/주석을 이유로 동작을 바꾸지 않는다.
- 핵심 규칙은 미사용 선언, 도달 불가·중복 조건, 의도하지 않은 Promise 누락, React Hooks 규칙, 이유 없는 unsafe 타입 우회다. Hooks dependency와 비동기 규칙을 자동 수정으로 한꺼번에 적용하지 않는다.
- 형식 수정과 의미 있는 구조 변경은 별도 변경 단위로 남긴다. 저장소 전체 일괄 `--fix`·`--write`는 하지 않는다. 완료한 cohort의 명시적 파일 목록만 수정한다.
- C·shell·SQL·YAML을 ESLint/Prettier가 모두 검사한다고 주장하지 않는다. C는 기존 warning/host test·ESP-IDF, shell은 문법/기존 계약 테스트를 활용한다. 새 shell/C 분석기를 추가하려면 해당 도입 작업에서 효과·환경 의존성을 검토한다.

### CC-10 예외와 점진 적용

- 처음 전체 진단을 보존하고 기존 위반을 새 위반과 구분한다. 기존 debt가 많다는 이유로 검사 자체를 빼거나 package 전체를 무시하지 않는다.
- 단계적 적용에는 정확한 경로·규칙·코드 문맥 fingerprint가 있는 진단 원장을 사용한다. 새 파일/새 위반은 차단하고, 완료한 파일은 전체 검사한다. 기존 위반의 자동 재기준 생성으로 실패를 숨기지 않는다.
- 미전환 파일은 전수 점검 대상에 남는다. 포맷 검사는 전환한 명시 목록에서 시작해 최종에는 모든 적용 대상과 명시 예외를 확인한다.
- 예외는 이유·안전 근거·담당·재검토 조건을 갖고 최소 범위로 둔다. `eslint-disable`/formatter ignore는 단순히 통과시키기 위한 수단이 아니다.

## 5. 구조 정리의 불변 조건

- API 권한 재검증, 현장/장비 소유권, row/advisory lock 순서, DB 시각·primary 증거, 멱등성·상태 전이와 commit 이후 ACK를 유지한다.
- Web query key·cache scope·상태 복구·요청 취소·식별 operation ID/최신 revision 비교와 unknown 제어 잠금을 유지한다.
- BIO 동글 전송 ACK는 조명 적용 성공이 아니다. UUID/address가 맞는 독립 상태 재조회와 복원 확인을 유지한다.
- unknown을 confirmed로 바꾸거나, 실패·불명 상태를 자동 SET 재전송으로 해결하지 않는다. 현재 세대·등록·owner fence와 durable intent 이전 SET 금지를 유지한다.
- 영속 기록의 임시 파일 생성·권한·file fsync·rename·directory fsync 및 불확정 commit 재확인을 유지한다. 과거 저장 버전의 읽기 호환성은 이름만 보고 지우지 않는다.
- timeout/retry 횟수·RF 전송 순서·주소 배정·기본 밝기·센서 설정·JSON/wire 필드·hash·오류 code/의미를 바꾸지 않는다.

이 조건을 바꿔야 정리가 가능한 후보는 자동 진행하지 않고 별도 설계로 분리한다.

## 6. 초기 정리 후보와 순서

다음은 사전 조사 근거가 있는 후보이며, 이 순서가 실행 완료나 파일별 수정 승인을 뜻하지 않는다. 상세 변경·검증은 실행 계획에서 확정한다.

| 순서 | 후보 | 정리 경계와 주요 위험 |
| --- | --- | --- |
| 1 | Gateway telemetry/config-ACK/state-event outbox의 동일 `withTimeout` | 오류 메시지를 인자로 받는 helper 추출. 실제 publish는 취소하지 않는 현재 의미와 timer 정리 보존 |
| 1 | API ingestion 서비스의 동일 Prisma `P2002` predicate | 실제 instance 검사 3곳만 통합. 구조적 오류 객체도 허용하는 다른 helper는 합치지 않음 |
| 2 | Web API validator·Mobile network fallback | 현재 응답 수용 범위를 지키며 타입 연결·의도된 오류 처리 설명 보강 |
| 2 | floor-editor 서비스의 순수 변환·검증 | `undefined/null/빈 문자열`, 소수 표현·오류를 고정. transaction·lease·revision 경계는 그대로 |
| 3 | RegistrationPanel·ControlView | 순수 progress/error helper와 표현부터 분리. scope·effect·권한·unknown 잠금은 후속 covering 회귀 뒤 분리 |
| 3 | `packages/shared/src/schemas.ts` | 도메인별 이동/재노출. 검증 의미·공개 export·소비자 호환성을 순차 확인 |
| 4 | Gateway `index.ts`, API `mqtt.service.ts` | 실행 조립/handler 경계로 나누되 기동·recovery·commit/ACK·종료 순서를 보존 |
| 4 | automation state store·BIO client·CAD renderer/worker | parser·I/O·자원 수명 경계를 먼저 조사. 현재 표본만으로 분해 방식이나 안전성 확정 금지 |

후보 외 파일도 전수 원장에 따라 검토한다. C/모바일 native/운영 스크립트를 형식상 목록에만 넣고 완료 처리하지 않는다. 낮은 위험의 순수 이동과 높은 위험의 상태·I/O 리팩터링은 같은 변경 단위로 섞지 않는다.

## 7. 실행 구조와 검증 설계

1. **정책·기준선:** 격리 작업 공간에서 최종 inventory, 기존 실패, 정적 진단과 형식 현황을 기록한다. 정책 정본·도구 설정·검사 자체 회귀를 먼저 준비한다.
2. **낮은 위험 cohort:** 동일한 helper, 명확한 타입·변수·주석, 순수 변환을 소유 영역별로 정리한다. formatter-only 수정과 구조 수정을 분리한다.
3. **영역별 cohort:** Web/Mobile, API, shared/engine, Gateway, 펌웨어·도구의 전수 검토와 필요한 책임 분리를 수행한다. 공유 경계는 한 소유자가 먼저 반영하고 소비자는 순차 검증한다.
4. **결합 검증·잔여 분류:** 최종 소스에서 원장 누락, 새 위반, 회귀·공개 계약·문서 불일치와 예외를 대조한다.

대량의 독립 영역 작업은 역할별 서브에이전트에 배정하고 총괄은 결과·소스·검증을 통합한다. 작은 작업은 사용자가 준 위임 기준에 따라 직접 처리한다. 같은 파일·계약을 동시에 수정하지 않으며 다른 작업의 WIP나 실행 자원을 재사용하지 않는다. 사용자 승인 없이 다른 채팅에 작업을 발송하지 않는다.

검증은 다음 원칙을 따른다.

- 정책/검사 도입에는 정상·위반·예외·제외 파일 fixture와 재현 가능한 검사 회귀를 둔다. 단순 파일 길이 감소를 통과 기준으로 삼지 않는다.
- 추출 전 기존 구현의 입력·출력·오류·순서·cleanup을 고정한다. 필요한 covering 회귀를 먼저 확보하고 이동 뒤 재실행한다. 구현을 그대로 복제하는 무의미한 테스트는 늘리지 않는다.
- UI의 비동기·상태·이벤트 경계를 변경하면 현장/사용자 전환·지연 응답·취소·복구 및 PC/모바일 입력 회귀를 확인한다. 표현 추출도 접근성과 화면 동일성을 확인한다.
- DB·영속 저장·외부 메시지 경계는 자기 소유 일회용 DB/파일·broker에서 검사하며 운영 DB나 실제 동글을 fixture로 사용하지 않는다. packet/wire/hash·구버전 JSON·export 결과가 유지되는지 대조한다.
- 같은 checkout의 canonical `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`와 dependency 준비/owner lock 체계를 유지한다. 단계 중에는 직접 관련 검증을 사용하고 결합 시 canonical 명령을 순차 실행한다. 필요한 leaf 실행 전 준비는 기존 운영 기준을 따른다.
- 신규 format/quality 검사는 CI 품질 단계에 연결하되 기존 UI 정책·integration·실백엔드·production/HIL gate를 삭제하거나 약화하지 않는다. 도구가 tsconfig 밖 파일을 누락시키지 않는지 inventory와 대조한다.
- 기존 실패는 같은 기준 소스·환경·명령에서 재현 여부를 분리하고 원 로그를 보존한다. 실패·skip·환경 차이를 0건처럼 표현하지 않고 새 회귀는 다음 단계 전 해결한다. 전체 검증이 실패하면 전체 GREEN/무조건 병합 가능으로 표시하지 않는다.
- 실제 firmware build/native 수동 검증을 실행할 수 없다면 상태를 명시한다. 소프트웨어 fixture나 성공한 build를 장비/HIL 성공으로 대체하지 않는다.

## 8. 문서와 완료 조건

변경한 메뉴는 기능 상태뿐 아니라 `관련 파일` 경로도 같은 작업에서 갱신한다. 동작 변경이 없는 구조 정리를 새 기능 완료로 기록하지 않는다. DB 스키마는 이번 작업에서 바꾸지 않으므로 기존 `docs/database-schema.md`에 존재하지 않는 migration을 기록하지 않는다.

완료 조건은 다음과 같다.

- 클린 코드 정책 정본·진입 링크·자동 검사와 예외 규칙이 일치한다.
- 최종 포함 대상의 검토·처리 근거가 모두 있고 미검토 파일은 0이다. 명시 예외와 운영/실기기 미검증은 별도 공개한다.
- 중복 제거·책임 분리·타입 개선의 실제 변경과 검증이 연결되며, 기존 API/장비/저장·권한 계약이 보존된다.
- 신규 정책 위반이나 회귀를 숨기는 ignore·baseline 갱신·timeout 완화·테스트 삭제가 없다.
- 기존 실패가 남으면 정확한 최종 실패와 영향·후속 승인 필요를 기록한다. 전수 검토 완료와 모든 테스트 통과를 별개로 보고한다.
- 변경은 검토 가능한 작은 단위이며 기존 사용자 변경·보호 파일·다른 작업 자원을 보존한다.

## 9. 이번 설계 작성 단계의 결과와 다음 승인

- [x] 사용자 목적·동작 보존 방향과 기존 정책·사전 조사 근거를 반영했다.
- [x] 적용 정책·전체 inventory 경계·파일별 검토 기록·단계적 검사·안전 불변 조건을 정의했다.
- [ ] 사용자가 이 서면 설계를 검토·승인한다.
- [ ] 승인 뒤 `writing-plans`로 구체적 파일·작업 순서·검증·실행 방식을 정한다.
- [ ] 계획과 실행 방식 승인 뒤 정책·도구 및 서비스 코드 정리를 구현한다.

문서 작성만으로 제품 코드 정리·테스트 기준선·운영 적용을 완료했다고 표현하지 않는다. 제품 의존성 설치, build/test/서버·DB·SSH·USB·실장비·PKI·클라우드 작업은 이 작성 단계에서 실행하지 않는다.

## 참고 기준

- [기존 운영 및 검증 기준](../../agent-operations.md)
- [현재 상태와 과거 검증의 한계](../../project-status.md)
- [Web 디자인 시스템 기준](../../ui-design-system.md)
- [기존 코드 안내·주석 원칙](2026-09-03-frontend-developer-code-guide-design.md)
- 정적 검사/포맷 도입의 구현 근거: [typescript-eslint 시작 문서](https://typescript-eslint.io/getting-started/), [타입 기반 모노레포 검사](https://typescript-eslint.io/troubleshooting/typed-linting/monorepos/), [Prettier 설정 항목](https://prettier.io/docs/options). 이 문서는 도구의 모든 최신 규칙을 일괄 채택하지 않으며 저장소 적합성 검증은 실행 계획에서 다룬다.
