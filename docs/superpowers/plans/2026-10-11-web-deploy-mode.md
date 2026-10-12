# Public Web Deployment Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement the coupled tasks sequentially.

**Goal:** `WEB_DEPLOY_MODE` 하나로 동일 배포 명령의 랜딩/전체 서비스 빌드와 AWS 공개 범위를 전환한다.

**Architecture:** 최신 UI 기준에 승인된 정적 랜딩 준비를 통합한다. 모드 parser/route/artifact 계약을 빌드와 배포가 공유하고, 서비스 모드만 인증된 기존 앱과 same-origin API origin을 제공한다.

**Tech Stack:** Node22/pnpm9.15/Vite/React/CloudFormation/S3/OAC/CloudFront.

**Spec:** `docs/superpowers/specs/2026-10-11-web-deploy-mode-design.md`

## Global Constraints

- 단일 모드 `WEB_DEPLOY_MODE=landing|service`; 기본 landing, invalid fail before writes.
- landing graph/output 내부 제외, service 최신 UI/인증 보존, 시안/test 자료 제외.
- service 로그인 같은 origin `/login`, API `/api` 계약 유지. 운영 API origin은 최초 한 번 명시 입력.
- 계정/소유권·lock/hash/archive/과거 assets 보존·canonical CI gate 유지. 운영 AWS/DB/장비 조작 없음.

## Review Focus

- 플래그는 service인데 landing 산출물/edge가 남은 경우: 모드·바이트 연계 gate 및 fake deploy assertion.
- landing으로 돌아왔는데 API/로그인/내부 JS 접근이 열린 경우: 왕복 전환 HTTP/edge/API 계약.
- API 401/403을 HTML404로 바꾸거나 쿠키가 캐시되는 경우: API behavior/cache/error 정책 검사.
- 직접 접속·새로고침 또는 정상 nested route를 잘못404로 처리하는 경우: 실제 route 계약+production browser.
- 실패한 전환/rollback이 다른 모드의 archive를 게시하는 경우: manifest mismatch/identity/no-write·복구 검사.

## Task1 — 단일 writer, 연결된 배포 모드 전체 구현

- [x] Step1: 최신 `cc6b9a7a`에 기존 AWS/Web 준비를 `7f132751`/`1f78274c`로 통합했다. 충돌 없이 최신 UI·기본 main entry를 유지하고 과거 상태판은 가져오지 않았다.
- [x] Step2: 공통 배포 모드 parser·route/artifact 계약, `build:public` 및 production-only service entry/config 구현. 실패 테스트→최소 구현→양 모드 build/graph/HTTP와 서비스 로그인/일반 auth 회귀. 파일: `apps/web/**`, 필요 `scripts/landing` 공통 계약. 구현 `a549fb16`, 양 모드 실제 빌드·landing2PASS/서비스전용2SKIP·service4PASS와 관련 unit45/타입/UI 관문을 확인했다. 독립 리뷰는 Task2에서 진행한다.
- [x] Step3: 기존 `infra/landing/**`, `scripts/landing/**` 배포 흐름을 양 모드로 확장. 같은 deploy 명령으로 edge/API 설정과 산출물 조율, service preflight, mode-bound release/rollback, 최소 IAM·runbook·공개 메뉴 문서. fake AWS 왕복/부분 실패/틀린 모드/쿠키·캐시 계약으로 검증. 통합 구현 `a549fb16`과 보고서를 고정했고 독립 task/전체 branch 검토를 시작했다.

## Task2 — 최종 검증·독립 리뷰

- [x] 한정 최종 타입/UI/양 모드 build·생산 browser, 독립 spec/quality 전체 리뷰 및 필요한 국소 수리. 기본 UI 기존 실패/전체 CI·remote 미실행을 구분한다. `577e7cfa` 재검토 specYES/qualityApproved/전체 source통합YES, Critical0/Important0. 영구 증거는 `docs/assets/web-deploy-mode-2026-10-11`에 보존했다.

## Task3 — 결과 통합

- [x] 총괄이 체크리스트·상태판 최신화, 검토된 커밋·미리보기/정확한 사용 명령·최초 환경 입력·실제 공개 상태 보고. 기존 root 서비스/다른 worktree는 보존한다. 첫 로컬FF `cc6b9a7a`→`d95f0a96` exit0·clean·제품diff0와 기존5173의 공개세경로/login200을 확인했다. 운영 AWS·fullCI·remote push는 수행하지 않았다. 영구 증거를 보존하고 이번 임시 preview/worktree만 정리한다.

## Task 4 — 2026-10-12 호스팅케이알 외부 DNS 후속

사용자가 `kinda.dfkorealed.com` / 호스팅케이알과 수동 AWS 배포를 선택했다. 호스팅케이알 공식 NS 레코드 지원은 확인되지 않아 CNAME 연결을 사용한다. 기존 수정 즉시 반영 요청에 따라 앞서 제시한 외부 DNS 지원 설계로 진행한다. 리소스 생성/인증서 발급/DNS 변경/AWS 배포는 사용자가 직접 수행한다.

- [x] Step1: 단일 담당이 `scripts/landing/deploy.mjs`, `template.mjs`, 관련 테스트와 `infra/landing/config.example.json`, 기존 AWS runbook을 수정한다. `domainName`+같은 계정 `us-east-1` 인증서가 있으면 `hostedZoneId` 빈 값은 수동 외부 DNS, 유효한 Z ID는 기존 Route 53 자동 연결로 판별한다. 도메인 없음은 CloudFront 기본 주소를 유지한다. 별도 환경 플래그는 추가하지 않는다.
- [x] Step2: 실패 테스트→구현→전체 Node 배포 계약을 검증했다(`9a13a444`, RED6→22/22PASS, Node24; Node22/fullCI/liveAWS는 미검증). 외부 DNS에는 Route 53 조회/쓰기/리소스 생성이 없으며 CF 도메인/인증서는 유지한다. Route 53 호환, 잘못된 인증서/zone 거절, domain 없이 cert/zone 거절, 미발급·미일치 cert 원격 쓰기 전 거절, landing/service 모드 보존과 check/deploy/rollback DNS 안내를 검증한다.
- [x] Step3: 독립 QA가 고정 diff·증거·초보자 수동 절차를 검토했다. ACM 읽기 권한 예시 누락 I1을 ffbd8b09로 수정하고 재검토 I1 ADDRESSED/new C0/I0/M0·specYES/qualityAPPROVED/source통합YES를 받았다. 소유권/비공개 S3/OAC/hash/lock/rollback/CI 관문과 기존 backend/UI를 보존한다.
- [x] Step4: 검토된 소스를 로컬 기본 브랜치에 반영하고 체크리스트·상태판을 함께 갱신한다. 코드 검증과 실제 AWS/DNS/TLS 성공을 구분해 정확한 명령과 호스팅케이알 입력값을 보고한다. f31e56fa→2b3d9aae FF 이후 기본 checkout에서 Node계약23/23·diffcheck0을 재확인했다. 실제 AWS/DNS/배포는 사용자 수동 관문으로 남는다.

검토 초점: empty hostedZoneId와 malformed ID 구분, custom domain 인증서 안전 검증, CFN의 CustomDomain과 DNS 생성 조건 분리, 기존 관리 DNS에서 외부 DNS로 의도치 않게 전환하여 레코드가 삭제되는 경우, 실제 DistributionDomain과 CNAME 안내 일치. 기존 managed DNS stack의 설정 전환은 자동 허용하지 않고 명확한 실패로 보호한다.


## Task 5 — 2026-10-12 직접 공개 배포·무료 플랜 유지

사용자가 직접 배포를 요청하여 Task4의 수동 운영 경계를 변경했다. 최초 서울 요청의 계정 제한을 확인한 뒤 사용자는 현재 무료 플랜을 유지하고 크레딧 소진 뒤 서울 이전을 선택했다. 현재 공개 범위는 landing, 회사 DNS는 호스팅케이알, 리소스 리전은 기존 ap-southeast-2다. CloudFront viewer 인증서는 서비스 요구에 따라 us-east-1을 사용한다. 과금 플랜·고급 기능·SCP는 변경하지 않으며 향후 서울 이전은 새 리소스와 DNS 전환 작업으로 별도 진행한다.

- [x] AWS CLI 임시 세션과 STS 회사 계정 확인. 서울 로그인 오류를 공식 문서와 실제 프로젝트 설정으로 조사하고 프로젝트의 기존 Sydney 리전에서 CLI 연결을 완료했다.
- [x] 읽기 전용 리전/인증서/DNS 사전 확인. 서울 ListStacks는 조직 SCP explicit deny, Sydney ListStacks는 성공/빈 목록. AWS Settings는 신규 경험 Free Plan 및 Sydney 지정, us-east-1 ACM 목록 없음, 권한 NS 호스팅케이알, kinda CNAME 조회 없음.
- [x] 사용자 계정 변경 선택: 현재 무료 플랜 유지·기존 Sydney 리전 공개 배포, 서울 이전은 크레딧 소진 뒤 별도 진행. 자동 전환/예약하지 않는다.
- [x] Node22.23.3 공식 archive checksum 확인·pnpm9.15 frozen install, fresh landing build와 공개 계약23/23. 새 canonical 원격 branch에 source3540ea41 push 완료.
- [ ] 정확한 reviewed source의 canonical CI 전체 성공. run38194736652는 quality 성공/unit 실패/후속4 skipped. isolated Ubuntu 원RED0/2→승인381aa7d6 세 파일의 focusedGREEN2/2·Mac root152PASS/기존환경4SKIP를 회수했다. Compose 생략 출력·OpenSSL stdout·GNU/BSD stat 오염 최소수정은 독립 C/I/M0·spec/qualityPASS·통합YES 승인 뒤 clean root에 d270c3a9로 통합했다. 추가Linux root의 환경 차이 실패는 전체GREEN으로 주장하지 않으며 실제 nonroot/init runner의 새 exactSHA CI를 확인한다. workflow/skip/production policy 완화는 금지한다.
  - 후속f4fc4d94/run38196386765: quality 성공·실제Linux root152PASS/4기존환경SKIP/0FAIL, 원수정은 실제CI통과. Web3567PASS/20FAIL/3기존SKIP이며 App17/FixtureGroupDialog1/OperatorShell1/SettingsShell1의 네 파일을 단일 Web writer가 현재계약과 대조·최소교정 후 독립 review한다. 현재승인계약과의 fixture/selector 불일치를 확인했고 실제 Operator security h1 owner누락에는 해당route의 공통PageHeader+operator메뉴문서 범위만 추가승인했다. API/role/dirtylogout/focus·모달 동작을 보존한다. 검토용6de105fe 승인6파일은 원RED20FAIL/96PASS→동일네파일116/116PASS·Web타입0/diffcheck0이다. 독립재검토 중이며 전체CI후속4단계 미실행/공개gate를 유지한다.
- [x] 실제 같은 계정 ACM DNS 인증서 발급·호스팅케이알 검증 CNAME 저장, 권한 DNS 응답과 ISSUED 확인. 기존 회사 DNS 보존, 갱신용 CNAME 유지.
- [ ] Sydney 전용 stack provision 및 실제 DistributionId 구성. private ignored config와 AWS validate-template은 준비됐으며 CI green 전 실제 provision은 보류한다.
- [ ] mode-bound release build/deploy 완료 뒤 호스팅케이알 kinda CNAME 연결, HTTPS 공개 경로/차단 경로 smoke, 실제 결과 기록.

현재 ACM 인증서 발급과 검증 CNAME 저장은 완료했지만 stack/S3/CloudFront 생성과 서비스 공개는 미완료다. 인증서·한정 로컬 테스트 성공을 전체 CI·배포 성공으로 표시하지 않는다.

## Ownership

긴밀한 공유 계약이므로 한 implementer에게 `apps/web/**`, `infra/landing/**`, `scripts/landing/**`, 필요 root package script, 공개 메뉴3문서와 기존 AWS runbook을 승인한다. 서버/공유 MQTT/DB/인증서/기존 production Compose/CI 변경은 제외한다. 총괄만 이 계획·spec·project-status를 갱신한다.

검토는 baseline부터 task commit까지의 고정 diff package와 담당 보고서를 사용한다. 불필요한 전체 suite 재실행 없이 changed unit/actual build/실제 접속과 제한적인 auth browser로 완료 기준을 확인한다.

릴리스 구현 계약: HTML/brand는 불변 `published/<release>/`, assets는 모드 namespace로 게시한다. edge가 정확한 릴리스와 모드를 선택하고 CloudFormation 완료를 기다린다. CloudFront 전파는 전 세계 단일 시점 교체가 아니므로 부분 실패 lock·명시 retry/rollback 복구와 이미 내려받은 JS의 한계를 실행서에 기록한다.
