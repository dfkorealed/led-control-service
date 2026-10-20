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
  - 후속f4fc4d94/run38196386765: quality 성공·실제Linux root152PASS/4기존환경SKIP/0FAIL, 원수정은 실제CI통과. Web3567PASS/20FAIL/3기존SKIP이며 App17/FixtureGroupDialog1/OperatorShell1/SettingsShell1의 네 파일을 단일 Web writer가 현재계약과 대조·최소교정 후 독립 review한다. 현재승인계약과의 fixture/selector 불일치를 확인했고 실제 Operator security h1 owner누락에는 해당route의 공통PageHeader+operator메뉴문서 범위만 추가승인했다. API/role/dirtylogout/focus·모달 동작을 보존한다. 검토용6de105fe 승인6파일은 원RED20FAIL/96PASS→동일네파일116/116PASS·Web타입0/diffcheck0이다. 독립exact381aa7d6→6de105fe C/I/M0·spec/qualityPASS·통합YES로 승인해 root4404bf8d에cherry-pick/제품diff0확인후docs포함d6c49828 exactSHA CI에전달했다. 외부AGENTS.md unstaged추가는보존/미커밋하며root전체clean으로표시하지않는다. 전체CI후속4단계 미실행/공개gate를 유지한다.
  - 현재exactd6c49828/run38197956442 qualitySUCCESS/unitFAIL/후속4SKIP. 원수정root152PASS/기존4ENVskip·Web3587PASS/3baselineSKIP·shared546/automation28/mobile109PASS. Gateway1828PASS/2FAIL은기존담당의read-only조사, API3 migration files45진단헤더(원46중Console1제외, 실패총계아님)(initdbENOENT, finaltotalsunfinished)는독립backend/CI조사로분리한다. 추가scope승인전mutation금지/skip·timeout·gate약화금지이며전체CI/공개gate미완료다. AWS FREE/ACTIVE 플랜은 그대로다.
  - 원인확정후승인: Gateway두test의coldstartup/diagnostic→exit분리(750ms/기존5s·routing smoke유지)와중복launcher제거. API는existingPG16.15bindir PATH누락으로 unitworkflow+ci-workflows회귀2파일만승인(existingtools preflight/GITHUB_PATH/order/skip금지). APIproduction/schema·외부DB·apt/service변경없음, ownfreshfixture검증과독립review후통합한다.
  - Gateway67898b15 독립C/I/M0·spec/qualityPASS·통합YES, root04e5ab06 cherry-pick/diff0. 원baselinefiltered2PASS63제외 vs최종두file65PASSskip0 분리.
  - CI PG 준비 c55a4a9c: unit의 PostgreSQL 16·네 tool 검증 후 GITHUB_PATH 추가, 계약43/43·actual Bash wrongversion/missingtool fail-closed, fresh CAD3 RED44FAIL/2PASS/기존1SKIP→GREEN46PASS/기존1SKIP. 독립 C/I/M0·spec/qualityPASS·통합YES, root91b35da5에동일두파일통합. 첫 macOS 전체API의 비운 locale startup 오류는 완료 근거에서 제외하며 동일source PATH+LC_ALL=C 검증과 새 exactSHA canonical 여섯 gate를 확인한다. skip/timeout/gate 약화·외부 DB 연결 없음.
  - d8b1bc2d/run38200133219 quality·unit PG준비step SUCCESS/unit최종대기. 정상locale frozen API전체는260PASS/1FAIL/기존85ENVskip suites·3178PASS/3FAIL/기존1209ENVskip tests, PG6파일모두PASS/유일BIO stalefixture3사례FAIL. 승인test-only6475583e 한파일은RED3FAIL15PASS→GREEN20/20·APItypecheck/build0·독립C/I/M0 specqualityPASS 통합YES, root7c7c8ee4 cherry/diff0. own DB9dirs/process정리·기존DB보존. 최종교정source의canonical6단계가모두green이어야공개하며 부분결과를전체성공으로표시하지않는다.
  - d8 unit최종Web coldlazy1FAIL/3586PASS/기존3SKIP·GW/API미완結, 실제PG16.15preflight성공. readiness79fb453f 단일test는timeout/skip/production변경없이actualimport/Reactcommit대기, controlledrealtransform1500ms RED1FAIL→GREEN1PASS(9filter제외), 정식file10/10PASS0SKIP, 독립C/I/M0 specqualityPASS 통합YES/root101ff508 cherry/diff0. b0a9b953/run38200912492 병행중이나최종readiness교정source의새exactcanonical6green관문유지.
- [x] 실제 같은 계정 ACM DNS 인증서 발급·호스팅케이알 검증 CNAME 저장, 권한 DNS 응답과 ISSUED 확인. 기존 회사 DNS 보존, 갱신용 CNAME 유지.
- [x] 후속 CI 실패를 분리했다. `b0a9b953` API CAD5/제조1, `53f48c69` Web focus1이며 후자는 API 미완결이다. 독립 승인된 focus2/2·제조10/10은 `8a96d19e`·`a8440716`에 반영했고 기존 deadline/보안 권한 검사를 유지한다.
- [x] native Linux 동일 UID NPROC 누적 원인·fresh UID 개선·5-case cleanup probe 및 독립 최소 6파일 설계 승인을 회수했다. Python subreaper/IPC EOF는 아직 구현 검증 전이다.
- [x] exact `a8440716` 격리 후보의 CI-only API owned UID·단일 Jest launcher 6파일 구현 `c8fe84f79c53fc83ff4c7667c9a0d3b6a5f8e69d`를 회수했다. 자동 계약48/48·문법/diff 검사, 실제 subreaper/EOF/신호·충돌·identity·cleanup fail-closed, final self-child CAD Linux21PASS·Mac20PASS/기존Linux전용1SKIP를 확인했다. root 문서는 source 커밋에서 제외했고 own12컨테이너 제거를 확인했다. 기본 argv/전체 수집·제한/deadline은 유지하며 독립 최종 source review와 실제 GitHub x64 여섯 gate는 아직이다. main 병행 제품·package/lock/docs 변경은 보존/제외한다.
  - [x] 실제 Python supervisor native ARM 여섯 lifecycle case의 기대 status 0/17/130/143/1/1 및 매회 owned UID task0·계정/HOME/TMP/cache 제거를 보고받았다. detached2개 PPid=supervisor와 waitpid reap2로 실제 subreaper를 확인했다. Jest-double 검증이며 실제 GitHub x64 전체 Jest/PG 관문을 대체하지 않는다. 첫 제한 capability의 cleanup PermissionError cohort는 실패로 보존했고 supervisor-only DAC_OVERRIDE 보완 후 actor CapEff0·Groups empty·NoNewPrivs1을 확인했다.
  - [x] helper가 TMPDIR을 무시해 생성하는 새 owned `/tmp/gateway-watermark-*` 누락 RED4개를 보존하고, 보강 후 위 여섯 lifecycle 정리 GREEN을 회수했다. baseline 이름·다른 UID·최상위/중첩 symlink 대상 보존, captured inode 교체 거부, 계정 충돌·identity·userdel 실패 계약을 확인했다. UID 종료·adopted waitpid 완료 후 경로 정리, 마지막에 계정 삭제 순서다. 실제 PostgreSQL 서버 실행 증거나 전체 API 성공으로 확대하지 않는다.
  - [x] MAIN의 배포 문서 두 줄만 검증·커밋 `e5f863ec` 후 공용문서 추가 쓰기를 중단해 사용자 승인된 다른 UI 병합 창을 확보했다. 외부 AGENTS.md와 다른 담당자 branch/source는 미stage·보존하며 배포 후보의 exacta844 baseline은 유지한다.
- [x] 고정 `a8440716..c8fe84f7` 6파일 독립 검토는 C/I/M0·spec/qualityPASS·scoped integrationYES다. source hash6개와 원시 검증 cohort를 대조했다. 총괄 문서3개만 취합하며 MAIN의 병행 UI/CAD와 외부 AGENTS는 포함하지 않는다.
- [ ] 후보 source+총괄 소유 문서만 dedicated remote branch에 normal push하고 정확한 SHA의 canonical 여섯 gate GREEN을 확인한다. timeout/skip/limit/production converter/gate 완화는 금지한다.
  - [x] 정확한 후보 `2b4abc78`를 normal push했다. 실제 run38207535048은 quality 성공·unit 실패·후속4SKIP다. root158/shared546/automation28/mobile109/Web3587 PASS(기존 root4/Web3 SKIP) 뒤 API 새 UID1002의 Jest MODULE_NOT_FOUND로 API 수집 전 종료됐다. cleanup task0·계정/임시 경로 제거 성공은 전체 suite 성공이 아니다.
  - [ ] 실제 pnpm 설치/Jest 경로와 fresh UID 접근 문제를 재현하고 최소 수정·독립 재검토·새 exact SHA 전체 CI를 확인한다. MAIN 새 UI/CAD `416785d0`는 격리 공개 후보에 섞지 않는다.
    - [x] native Ubuntu24 ARM/Node22.23.3/pnpm9.15의 runner→JS launcher→sudo→Python→fresh UID→실제 Jest 전체 chain에서 home750 조건의 같은 MODULE_NOT_FOUND를 재현했다. 같은 disposable 설치에서 home751 하나만 변경하면 실제 Jest2/2가 통과하고 fullenv/groups empty 및 cleanup을 유지했다. 실제 GitHub home mode/ACL은 측정하지 않았으며 위 테스트는 인과 재현이다. 기존 프로젝트 권한을 변경하지 않는 owned workspace snapshot을 2파일 범위로 구현·검토한다.
    - [x] frozen `62d775dc` 3파일을 회수했다. snapshot+CI-only checkpoint opt-out, 보호된 pnpm home을 거치지 않는 동일 Prisma args의 test-only 호출이다. 계약49PASS/0SKIP·native 실제 chain2PASS/gate0/task0·원본 mode/content 유지·여섯 lifecycle 및 final ghost gate1/reap2·Mac 실제 변경 파일1PASS/기존DB8SKIP·own7컨테이너 제거를 확인했다. 실제 GitHub home mode·전체 API 성공으로 확대하지 않는다.
    - [ ] 정확한 `2b4abc78..62d775dc` 3파일의 독립 최종 검토, root 문서 취합과 새 exact 후보 canonical 전체 CI를 확인한다. 기존 문서의 fresh audit floor 불일치도 정책 변경 없이 읽기 전용 재확인한다.
      - 독립 exact62 검토 C/I/M0/1/0·통합NO: 원본의 `.local/alias`를 경유하는 내부 상대 링크가 원본 resolve 검사에는 통과하지만 제외 후 mirror에서 깨질 수 있다. 복사 후 모든 mirror 링크의 내부 target/존재를 재검증하는 supervisor·계약 2파일 writer를 별도로 배정했다. package/lock writer와 파일 소유를 분리하고 root만 최종 Git 취합한다.
    - [x] fresh production audit는 critical2/high4/unexpected6, exit1이다. 현재 graph에서 과거 image-size finding은 없고 proxy-addr/shell-quote/source-map-js/sharp에 patched floor, node-forge/braces에는 `<0.0.0`가 보고됐다. 정책/예외/manifest/lock 불변이다.
    - [ ] 여섯 실제 advisory의 primary affected 범위·upstream 수정·소비 API 호환을 조사하고 검토된 최소 보완과 실제 감사 성공을 확인한다. 알려진 감사 실패 상태의 반복 전체 CI는 진행하지 않는다. 예외 확대·skip·분류 변경으로 숨기는 우회는 금지한다.
      - 네 published floor는 현재 consumer semver와 Node22를 수용해 정확한 overrides/API floor·lock만 단일 writer가 보완한다. node-forge/braces에는 공식 수정 릴리스가 없고 최신 Expo 인증서·micromatch/Metro consumer도 의존을 유지한다. 이 둘과 감사 정책은 변경하지 않는다. 공개 Web의 기존 module audit는 web/src만 필터링하므로 third-party 부재 증명이 아니며 최종 build의 raw Rollup graph로 확인해야 한다.
      - [x] root/API manifest·lock 3파일의 독립 최종 검토 C/I/M0/0/0·scoped integrationYES, post-copy supervisor·계약2파일도 기존 I1 해결·C/I/M0/0/0·scoped integrationYES다. 원본 source 승인과 실제 전체 GitHub CI는 구분한다.
      - [x] post-copy excluded intermediate alias 실제 RED1FAIL→GREEN1PASS·CI 계약49PASS/0SKIP와 source hash 일치를 확인했다. 최신 dependency 공개 landing 빌드1회 성공, raw2931/emitted160 module에 node-forge/braces/micromatch0, 배포9파일 size/SHA 및 manifest SHA `9208f5727297f1be826f7159a43dac40382d8b6b86a01f9c0407397ddada1cb3`를 검증했다. 기존 web/src-filtered audit 대신 unfiltered graph를 회수했으며 HTTP smoke·전체CI 성공으로 확대하지 않는다.
      - [ ] published fix가 없는 mobile tooling 두 finding으로 전체 감사 exit1이 유지된다. 사용자에게 landing 전용 release 관문 분리 여부를 확인하고, 응답 전 기존 여섯 gate 요구·사이트 리소스/콘텐츠/DNS 보류를 유지한다. 기존 Software CI·감사 예외는 완화하지 않는다.
      - [x] root/API manifest·lock 3파일의 네 floor와 필수 Sharp native/libvips만 frozen 갱신했다. 실제 소비 경로 RED4FAIL/3PASS→GREEN7PASS·기존 Sharp/proxy4 suites46PASS/0SKIP·frozen install/diff-check를 확인했다. fresh unchanged 감사808 dependencies는 Critical0/High2/node-forge·braces 두 UNEXPECTED/exit1이다. 독립 검토·실제 전체 GitHub CI는 별도다.
- [ ] Sydney 전용 stack provision 및 실제 DistributionId 구성. private ignored config와 AWS validate-template은 준비됐으며 CI green 전 실제 provision은 보류한다.
- [ ] mode-bound release build/deploy 완료 뒤 호스팅케이알 kinda CNAME 연결, HTTPS 공개 경로/차단 경로 smoke, 실제 결과 기록.

현재 ACM 인증서 발급과 검증 CNAME 저장은 완료했지만 stack/S3/CloudFront 생성과 서비스 공개는 미완료다. 인증서·한정 로컬 테스트 성공을 전체 CI·배포 성공으로 표시하지 않는다.

## Ownership

긴밀한 공유 계약이므로 한 implementer에게 `apps/web/**`, `infra/landing/**`, `scripts/landing/**`, 필요 root package script, 공개 메뉴3문서와 기존 AWS runbook을 승인한다. 서버/공유 MQTT/DB/인증서/기존 production Compose/CI 변경은 제외한다. 총괄만 이 계획·spec·project-status를 갱신한다.

검토는 baseline부터 task commit까지의 고정 diff package와 담당 보고서를 사용한다. 불필요한 전체 suite 재실행 없이 changed unit/actual build/실제 접속과 제한적인 auth browser로 완료 기준을 확인한다.

릴리스 구현 계약: HTML/brand는 불변 `published/<release>/`, assets는 모드 namespace로 게시한다. edge가 정확한 릴리스와 모드를 선택하고 CloudFormation 완료를 기다린다. CloudFront 전파는 전 세계 단일 시점 교체가 아니므로 부분 실패 lock·명시 retry/rollback 복구와 이미 내려받은 JS의 한계를 실행서에 기록한다.

## 2026-10-12 사용자 승인: landing 전용 공개 관문

사용자는 mobile/백엔드의 미수정 advisory와 분리하여 landing 전용 보안·기능·접근 차단 검사 통과 후 배포하도록 명시 선택했다. 기존 Software CI 여섯 단계와 전체 서비스 감사 정책/예외는 유지한다. 새 관문은 `WEB_DEPLOY_MODE=landing`에만 적용하고 service mode 공개를 승인하지 않는다. 기존 public build/manifest/routes/smoke 구현을 확장하며 production converter 제한·API/모바일 기능은 변경하지 않는다.

- [x] 보완 후보 `7dd2191f9c92828fe36721f53a39c54d3f2f9fe7`를 clean commit으로 고정했다. MAIN 외부 AGENTS/문서 수정은 보존하며 섞지 않는다.
- [x] 단일 writer가 landing release 감사/관문·별도 CI workflow·기존 public Vite evidence·Chromium 접속 검사를 구현한다. Root는 문서와 Git/AWS 운영을 담당한다.
  - writer 소유: `scripts/landing/release*.mjs`, 기존 `apps/web/vite.public.config.ts`의 evidence 연결, landing-only Playwright config/spec, `.github/workflows/landing-release.yml`. 루트 package scripts는 추가하지 않고 `node scripts/landing/release.mjs`로 실행한다. 설치된 Web deps/devDeps·shared workspace와 gate tool dependencies의 정확 metadata/lock closure를 기록하며 fresh audit는 dev를 포함한다. 기존 Software CI·전체 audit policy·API/mobile·root docs는 writer가 수정하지 않는다.
  - 추가 소유: gate writer가 `scripts/landing/deploy.mjs`의 landing-only fresh-build/proof 결속을 맡는다. dependency writer는 Web dev `vite ^6.4.3`, `vitest ^4.1.11`와 필수 lock만 갱신한다. plugin-react4.7.0/Tailwind4.3.3 및 Node22 peer 호환을 읽기 전용 확인했다.
  - [x] 실제 dev 포함 감사에서 Web 실행 도구9 advisory(esbuild1/Vite3/Vitest2/mocker1/tinypool2)를 확인했다. 기존 prod2와 검사 범위가 다르며 whole all-deps critical5/high10/moderate8이다. 예외 없이 도구 fixed floor와 consumer 호환을 보완하며 다른 workspace 구버전 finding은 숨기지 않는다.
  - [x] Vite6.4.3/Vitest4.1.11 targeted frozen install·lock scope·public actual assertions/수집 수·fresh scoped finding0을 확인한다. 다른 workspace/API/mobile production graph와 기존 보안 floor는 유지한다.
    - [x] dependency writer의 실제 frozen install exit0, floor RED2FAIL→GREEN2PASS를 회수했다. Web Vite6.4.3/esbuild0.25.12, Vitest/mocker4.1.11이며 Web tinypool 의존은 없어졌다. Vite6 요구를 수용하는 기존 Rollup4.62.2를 재사용하고 다른 workspace importer/기존 lock key 수정0·missing snapshot0·root override 불변이다. 공개37unit·fresh build/audit/browser는 gate writer가 한 번 묶어 실제 실행하며 아직 결과 전이다.
    - [x] Web manifest/lock 두 frozen hash를 root·reviewer가 검토 전후 확인했다. 독립 YAML 비교와 실제 installed tool metadata를 확인했고 C/I/M0/0/0·source scoped integrationYES다. 새 버전의 public37/typecheck/build/browser/security final 결과는 다음 gate cohort에서 확인한다.
- [x] Frozen dependency, frontend typecheck 및 public 기능/계약 검증, fresh raw/emitted package/version graph와 산출물 SHA를 결속하고 적용 범위 보안 감사를 fail-closed한다. 모바일 finding 제외는 숨기지 않고 해당 패키지가 공개 및 public build tool scope 밖임을 증거로 기록한다.
- [x] 실제 public dist Chromium에서 `/`, `/features`, `/pricing`와 header/consultation fallback 동작, login/internal/API/unknown/concept/archive 차단을 검증한다.
- [x] 고정 소스·실제 검사 로그의 독립 최종 검토를 통과하고 정확한 SHA의 새 landing CI 성공을 확인한다. 기존 whole CI의 실패는 별도 상태로 유지한다.
- [x] 통과한 exact landing 후보를 Sydney 전용 private S3/OAC/CloudFront stack으로 provision하고 실제 ID를 구성한다. ACM은 ISSUED, 회사 DNS 기존 5개 record는 보존한다.
- [x] fresh mode-bound deploy·edge 전파·기본 주소 smoke 성공 후 HostingKR `kinda` CNAME을 연결한다. 최종 custom HTTPS public/blocked routes와 headers를 확인하고 실제 release/hash/resources 증거를 기록한다.

### Landing 전용 관문 실제 첫 실행

- [x] 최초 새 gate는 unit 단계에서 실패했다: 37 cases 중23PASS/14FAIL, 기존 jest-dom side-effect가 hoisted Vitest2 expect를 확장해 Web Vitest4 expect에 DOM matchers가 없었다. raw `apps/web/.local/landing-release-unit.json`·`landing-release-actual-gate.log`를 보존하며 build/audit/browser 미실행으로 기록한다.
- [x] gate writer는 기존 Web 공통 setup에 Web가 직접 import한 expect + 공식 matchers explicit extend의 최소 호환 연결을 검토·구현한다. public만 우회해 일반 Web 테스트 회귀를 남기지 않는다. 기존 assertion/cleanup/skip/deadline은 유지한다.
- [x] reviewer의 malformed audit finding.version semver guard도 TDD로 보완하고 실제 오류 자료를 배포 통과로 처리하지 않는다.
- [x] 새 setup의 공개37 및 의미 있는 기존 일반 Web 집중 검증과 정확한 source freeze·독립 검토 후 실제 fresh gate를 통과한다.

- [x] 공통 Web expect adapter 뒤 공개37/37PASS·0SKIP, 일반 Web의 기존 DOM matcher2파일5/5PASS를 회수했다. 초기 matcher14FAIL은 보존하며 새 결과로 해결 범위를 구분한다.
- [x] 다음 gate는 build evidence에서 Vite6 CommonJS `?commonjs-es-import` 새 virtual suffix를 unknown으로 거부했다. audit/browser는 아직 미실행이다.
- [x] 해당 실제 형식만 real package로 unwrap하는 TDD 보완 후 기존 unit/shared/typecheck 증거를 반복하지 않고 fresh public build·미실행 감사/Chromium을 확인한다. 최종 exact GitSHA landing CI에서 전체 gate를 새로 실행해 proof를 결속한다.

- [x] 전체 Web typecheck의 실제 exit2 원인을 확인했다: 4,532 matcher 타입 오류는 jest-dom 선언이 hoisted Vitest2 모듈에 연결된 문제이며 공통 setup에서 실제 Web Vitest 모듈에 공식 TestingLibraryMatchers를 augmentation 한다. 나머지10건은 세 기존 test의 Vitest4 unknown mock/async 반환 추론 차이로 확인했다.
- [x] 승인된 세 test 파일의 fetch mock 두 선언을 입력/반환 타입으로 명시하고 ControlledImage.decode 반환을 Promise<void>로 명시한다. product/assertion/cleanup/deadline은 유지하며 기존 세 test 실제 검증과 전체 Web typecheck 성공을 확인한다. 새로운 타입/검증 호환성을 ts-ignore·skip으로 숨기지 않는다.

- [x] 공통 matcher 선언과 mock 타입만 보완한 최종 전체 Web typecheck exit0을 회수했다. 공개37PASS/0SKIP·일반5PASS·기존3file41PASS를 보존했고 source/digest cohort를 구분한다. Mock 반환 union은 fixture 실제 Response|Promise<Response>를 표현하며 POST filter로 보장된 init 타입만 명시했다.
- [x] Vite6 실제 CommonJS es-import wrapper와 malformed-audit-version guard를 포함한 계약29/29PASS를 회수했다.
- [x] 최종 source hash에 결속된 fresh build 증명, dev 포함 audit와 served-dist Chromium6 결과를 회수한다. 앞선 wrapper 실패 cohort와 성공 새 증명을 혼동하지 않는다.

- [x] 최종 source/file freeze 해시를 root가 독립 대조했다(17/17 일치). Fresh build raw2,928/emitted164/published15, scoped audit closure419/installed324 적용0·차단0/범위 밖23, served-dist Chromium6/6·0skip/0retry를 회수했다. 앞선 실패와 sequential local cohort를 구분하며 exact committed-SHA CI proof는 다음 단계다.

- [x] 최종 독립 검토 C/I/M0·spec/quality/integrationYES(17/17 hash 동일)를 회수했다. 커밋 `f5eb68154156d1f98d4626654a69f32d70a3a16b`의 [실제 landing CI](https://github.com/dfkorealed/led-control-service/actions/runs/38217099893) 성공, archive hash/HEAD/37unit·6Chromium·적용finding0/범위밖23을 확인했다. CI proof를 로컬 fresh build에 적용해 검증 성공했다.
- [x] AWS actual account456721863474/certISSUED, template validation 성공 뒤 전용 Sydney stack create 요청 성공. 현재 CloudFront 전파를 기다리며 콘텐츠·서비스 DNS 변경은 아직 실행하지 않았다.

- [x] 실제 provision/check/deploy/stack wait/CloudFront invalidation을 성공했다. 공개source `f5eb68154156d1f98d4626654a69f32d70a3a16b`/release20261012-landing-r1/10files, 전용 stackUPDATE_COMPLETE·distributionE2XZYU4N91AW5N이다. 기본AWS와 회사domain smoke exit0(3public200/blocked404/HTTPS/API계약), HostingKR 실제kindaCNAME/TTL180과 권한DNS응답, in-app 실제3페이지·상담fallback·요금문구 확인 및 최종 JPEG 스크린샷을 보존했다. 무료플랜·Sydney 유지, 전체 SoftwareCI는unitFAIL이며 service/장비는 미배포다.

## 2026-10-12 공개 사이트 모바일 보완·두 번째 배포

사용자 승인: 배포된 사이트 주석5개를 적용하고 배포. 기존 공개 후보 checkout(591ff9e1)을 재사용하고 MAIN c438bd71/외부 AGENTS 변경은 보존한다. 기존 landing 전용 CI와 source/artifact-bound 증명·무료 플랜/Sydney·private S3/OAC·exact 공개/차단 경로를 유지한다.

- [x] 주석 요구사항과 코드/공개 상태를 확인하고 bounded 보완 방향을 확정했다. 모바일 hero의 grid gap15px+negative art margin(-15px/-5px)이 간격을 상쇄하는 원인을 writer가 확인했다.
- [x] 단일 web_frontend writer: 모바일320/390/504에서 buttons↔실제 art 경계32px 이상, pointer/touch/keyboard 반응 그림, popup 전화 제거+email 카드/CTA, footer 회사 페이지 nav 제거, pricing 출시 전 변경 가능 안내를 구현하고 영향 메뉴3문서를 갱신한다.
- [x] 실제 모바일 overlap RED→GREEN·touch/keyboard/reduced-motion 검증 및 기존 공개 unit/typecheck 결과를 회수한다. 사소한 카피 mirror 신규 unit은 추가하지 않는다.
- [x] 독립 final review·source freeze를 확인하고 정확한 commit의 Public Landing Release 성공 및 CI proof/fresh local build 동일성을 확인한다.
- [x] 기존 전용 stack 리소스를 재사용해 새 immutable landing release를 게시한다. 이번 세션의 AWS 작업은 공식 MCP를 사용하고 CLI는 호출하지 않는다. 기존 deployment engine의 target/lock/archive/hash/edge activation 계약을 보존한다.
- [x] 실제 custom HTTPS public/blocked/headers와 모바일popup/hero 상태반응·pricing/footer를 확인하고 screenshot/메뉴/상태판/배포 문서를 갱신한다.

Ruling: 사용자의 구체적 주석과 직접 구현·배포 지시가 승인 범위를 확정하므로 설계/배포의 중복 승인 질문은 추가하지 않는다. 이메일 문의 방식은 유지하며 백엔드/API·온라인접수/가짜 제출 완료는 추가하지 않는다. Footer 회사 연락처와 회사 홈페이지 단일 CTA는 요청된 nav 목록 제거와 별개로 유지한다.

- [x] Root가 writer19/19 frozenSHA와 최종12/12 Chromium·37publicunit·9release계약·typecheck/UIpolicy 증거를 확인했다. 기존6+신규6을publicreleaseCI에연결하고staleexpected6report거부를보완했다. 아직새exactCI/prod배포완료는아니다.
- [x] 공식MCP read로AWS project456721863474/FREE ACTIVE/기존ownedstackUPDATE_COMPLETE r1을확인했다. Ignored JSON-RPC bridge는기존freshbuild/proof/target/immutablelock/archive/SHA/activation/wait/cleanupengine을재사용하며7fake검증통과·actual쓰기0이다. CloudFrontglobalus-east1,regionalSydney를유지한다. Metadata가없는서명이나CLI우회는허용하지않는다.

- [x] Source19/19 및ignoredbridge7파일해시/검토C/I/M0·specqualityPASS. 공개SHAafecbd55 actualCI SUCCESS/37unit12browser0skip0flaky/securityscope0/whole23유지, 내려받은proof와localfreshartifact가일치했다.
- [x] R2실제시도는target8read/조건부lock/텍스트3archive파일Put 후PNGBadDigest로preactivation중단·ownlockDelete성공. Binary무결성검사를삭제하지않고실패를보존했다. 공식MCPregistrySDK호출실패후freshproviderinitialize에서OAuthrefresh만료를확인했다. User에게auth갱신을요청했고nativeTerminal자동조작은안전제한으로거절됐다.
- [x] 인증복구후새release20261013-landing-ui-r3를시작한다. 동일바이트PNG는r1sourceHead/version-pinnedpresignedGET·localSHA확인뒤 SDKconditionalCopy(IfNoneMatch*,CopySourceVersionId/ETag/양owner/MetadataDirectiveREPLACE/원Metadata,type,cache)를수행하고destHead의VersionId·length/SHA/type/cache/ETag까지확인후만existingengineRPC성공을반환한다. 계획 당시 Copy실행0/조건부QA승인이고서비스r1정상인 상태였다. 이후 실제 r3/r4 실행 완료는 아래 결과를 따른다. Source/CI가변하지않더라도새freshbuild/proofguard/ownedtarget8검사를생략하지않는다.

- [x] 2026-10-13 사용자 로그인 완료 후 공식 MCP 새 세션에서 회사 계정456721863474를 확인했다. 원본 PNG 두 파일은 r1의 실제 VersionId/ETag로 고정한 다운로드와 로컬 바이트가 일치했다. root MCP adapter 독립 검토 PASS/C0/I0, 새 fresh build와 실제 proof guard 뒤 owned target8 검사를 통과하고 immutable archive/published 파일을 모두 게시했다. PNG는 조건부 CopyObject 뒤 목적지 VersionId·ETag·SHA·크기·type/cache를 실제 HeadObject로 확인했다. 현재 CloudFormation UPDATE_IN_PROGRESS이며 전환 완료/공개 HTTPS 성공은 아직 주장하지 않는다.

- [x] 실제 r3 engine 10파일/UPDATE_COMPLETE/Deployed/invalidation I29VLZAQAC5N32XZNB3TS8GNOQ Completed/lock삭제·exit0. 회사/CloudFront HTTPS smoke exit0와 native504px 새JS·43px간격/두기능반응/이메일popup·pricing/footer를 확인했다. 실제 hover 선택 배경 경쟁을 발견해 기존 desktop 테스트 내 색상/대비 RED→최소 수리→정확 CI→새immutable release의 한정 후속을 수행한다.

- [x] 실제 hover 대비 RED1→선택/hover 결합 상태 한 줄 수리·기존 desktop 케이스 내 세 버튼 coral/대비 검증 GREEN·public-polish6PASS. Source3222fb34 exactCI38326334739 unit37/Chromium12·skip/flaky0, source09fd8671/artifact2744a84d/proof7cab310b 검증 후 r4 fresh guard/ownedtarget8/immutable10files/UPDATE_COMPLETE/Deployed/invalidation I9GDZQWNV5R2KFGX60QHF1VQ9W Completed/lock삭제·exit0을 확인했다. 실제 회사/CloudFront HTTPS smoke exit0, native504px 43px간격/hover=true coral배경/전화없는 emailpopup/3페이지·pricing/footer를 확인하고 docs/assets/landing-mobile-2026-10-13에 JPEG와 완료 기록을 보존했다. 전체 서비스·native장비·메일 도착은 이번 범위가 아니다.


## 2026-10-13 히어로 정리·모바일 추가 간격 배포

사용자 승인: 직전 미리보기 버튼/설명 제거에 이어 627px 로컬의 CTA·그림 간격 수정과 배포. 기존 후보와 실행 중 MAIN의 소스 차이를 유지하면서 각 홈의 모바일 gap을64px로 맞춘다. MAIN 음수 그림 margin만 제거하고 API/CAD/외부 AGENTS는 보존한다.

- [x] 개발 담당: 후보 `LandingPage.tsx` gap16, MAIN 같은 gap과 음수 margin 제거, 기존 `public-mobile-polish.spec.ts` 6케이스 내 reported627px 포함 그림 여유56px·footer32px·overflow·motion 회귀와 랜딩 메뉴 문서를 갱신한다.
- [x] 총괄: source diff/검증 결과를 확인하고 정확 SHA의 Public Landing Release SUCCESS와 CI proof·fresh build 동일성을 확인한다. 기존 미리보기 제거 소스도 함께 포함한다.
- [x] 기존 공식 MCP adapter에 새 immutable release ID만 적용하고 기존 Sydney/private S3/OAC/CloudFront·lock·source/artifact guard·전체 전파/invalidaton 계약으로 게시한다.
- [x] 실제 회사/CloudFront HTTPS route·header와 모바일 CTA 간격·제거된 두 요소를 확인하고 메뉴/상태판/체크리스트를 완료한다.

- 개발 검증: actual MAIN627 CTA/art gap0→64px, 320/390/504/627/720/721/768 비겹침·overflow0. 후보 정적504 gap48<56 RED1→gap64 GREEN Chromium6/6(no skip/flaky), unit37/37·전체Webtypecheck/publicbuild exit0. 기존기능/축소모션/상담포커스는 유지하며 MAIN API/서버재시작0이다.

- 독립 검토: Critical/Important 코드 결함0. 720px 이하gap64/721px이상두열, 미리보기state/import제거와motion/depth/재진입보존, existing6case coverage를확인했다. 배포후627px실제동작의간격과삭제요소0개를추가확인한다.

- 정확source `f3f97f3f2f54a1b055364db6948a8e63229b63de` [Public Landing Release](https://github.com/dfkorealed/led-control-service/actions/runs/38370409105) SUCCESS: unit37·browser12/실패·skip·flaky0·scoped blocked0. CI zipSHA52884ac3/sourceSHA0c9386bf/artifactSHA43b79a00을검증했고기존adapter의freshbuild/source/artifact guard를통과했다. 새r5불변10파일게시/UpdateStack뒤전파대기중이며완료로확대하지않는다.

- r5 완료: engine10파일/UPDATE_COMPLETE/Deployed/invalidation I59BDHZAF9M6IDP3JPKFNMWKEL Completed/ownlock삭제·exit0. 실제 회사/CloudFront HTTPS smoke exit0,627px Chromium 정상motion 8회 최소59px·overlap/overflow0·removed controls/description0. In-appkernel오류는자동Chromium증거와구분하며예전r4수동화면으로새수정을주장하지않는다. 새영구JPEG/메뉴/상태/실행서를갱신했다.


## 2026-10-13 공개 페이지 간격·상담 카드 정리 배포

사용자 승인: 운영 페이지 주석9개 적용 및 배포. 첫 페이지 제목은 고정 헤더 아래32px 이상 여유를 두고, 상담은 흰 외곽/중복 헤더를 제거해 내부 navy 카드·닫기·요금제 문맥으로 구성한다. 지정 안내6개만 삭제하며 footer 예시 문장과 그래프 추정치·replay/motion은 유지한다.

- [x] 개발 담당: 공통 내부 페이지 간격과 opt-in 모달 UI, overview1개/공통 demo footer5개·미사용 prop을 정리하고 영향 메뉴3문서를 갱신한다. 기존 기본 모달 UI/접근성을 유지한다.
- [x] 개발 담당 검증: 기존 모바일 Chromium6케이스 안에서637px 포함 제목 여유와 navy 팝업·닫기/포커스를 확인하고 stale 문구 기대만 갱신한다. public unit/typecheck/fresh build와 공유 모달 집중 검증을 확인한다.
- [x] 총괄: 소스 freeze·독립 리뷰·정확 Git SHA의 Public Landing Release 성공 및 CI proof/fresh build 동일성을 확인한다.
- [x] 총괄: 공식 MCP·기존 guard/lock/archive/ownedtarget으로 새 immutable release를 게시하고 stack/CloudFront/invalidation 완료·lock 정리를 확인한다.
- [x] 총괄: 실제 회사/CloudFront HTTPS 및637px 모바일 제목 간격·내부 상담 UI·6개 안내 삭제를 확인하고 영구 증거와 상태/배포 문서를 완료한다.

- 개발 검증: 실제 운영637px 첫 제목 gap-3px/팝업 흰 외곽20px·1px 원인을 확인하고, 지정 문구·팝업 기대 RED8/14와 간격 browser RED2/2→공통 내부 페이지pt40px·chrome opt-in·navy 카드 닫기/plan·안내6개 삭제로GREEN을 회수했다. 마지막 닫기 버튼 흰 기본 배경은 RED1→transparent 보완 뒤 final public37/37·Chromium6/6·전체Webtypecheck/publicbuild exit0을 확인했다. 공통 overlay42/42·UIpolicy0/0도 통과했다. 운영 반영은 아직 r5다.

- 독립 검토: writer25/25 및 aggregateSHA6818ed를 재검증했고 C/I/M0·spec/integrationPASS를 회수했다. 기본 modal/drawer/sheet/safe-area와 새 title/description/초점 계약, 내부 요금제/닫기 버튼을 확인했다. 정확 커밋 CI와 실제 운영 배포는 다음 관문이다.

- 정확 source `2627a80d7717e51f83ee75f4a75a7aa2969dfc4d` [Public Landing Release38388627479](https://github.com/dfkorealed/led-control-service/actions/runs/38388627479) SUCCESS: unit37·Chromium12·실패/skip/flaky0·scoped blocked0. Artifact11806909424/zipSHA96a1d10c/sourceSHAe95b254f/artifactSHA2e0cc181을 검증하고 CI proof와 adapter fresh local build/source/artifact guard를 통과했다. 새 r6 불변10파일 게시 및 기존 stack UpdateStack은 성공했고 현재 UPDATE_IN_PROGRESS 전파 대기다. 운영 완료는 아직 주장하지 않는다.

- r6 운영 완료: 기존 stack UPDATE_COMPLETE·CloudFront Deployed·invalidation I90YIJQJLOJ7NB4NPI9K0LMNDL Completed·소유 lock 삭제·engine exit0. 실제 두 HTTPS smoke exit0, 운영320/390/637/720/1440px 제목 여유32px 이상(637px37px), 상담320/637/1440px 외곽0·navy/Plus/닫기/Tab/Escape/초점 복귀, overview/footer 안내6개 삭제와 footer 예시 안내 유지·새JS 확인을 통과했다. 자동 운영JPEG3개와 메뉴3문서/상태/실행서를 갱신했다.


## 2026-10-16 Plus 준비중 표시 운영 배포

사용자 승인: 기존 수정의 운영 배포. 제품 소스4130f74a를 유지하며 기존 무료 플랜·Sydney·landing-only·private S3/OAC와 source/artifact/lock/immutable guard로 새 release20261016-landing-ui-r7을 게시한다. MAIN/관제/API/DB/Gateway 변경은 범위 밖이다.

- [x] 기존 source diff와 실행서/대상을 확인한다. Plus `준비중`·단위 숨김, Basic99,000원 유지와 기존 가격 검증을 확인했고 공식 MCP preflight의 LoginRefreshRequired로 게시 쓰기0을 확인했다.
- [x] 인증을 갱신하고 정확 커밋의 Public Landing Release 성공·artifact ZIP digest·CI proof와 fresh local build 동일성을 확인한다.
- [x] 공식 MCP transport로 r7을 게시하고 기존 stack UPDATE_COMPLETE/CloudFront Deployed/invalidation Completed·소유 lock 삭제를 확인한다.
- [x] 실제 회사/CloudFront HTTPS와 모바일·데스크톱 Plus `준비중`/단위0·Basic금액·상담 열기를 확인하고 메뉴/상태/실행서를 완료한다.

- 인증 갱신 후 회사456721863474를 공식 MCP 실제 STS로 확인했다. 정확 source `b536b5ef7f0fe640a1feafcdd8dc0830ac4e1712`의 Public Landing Release38837111557 SUCCESS(unit37/browser12·실패/skip/flaky0·scoped blocked0), artifact12019083189/zipSHA944dc4cf/sourceSHA769f6035/artifactSHA2ca8a3b7를 확인했다. 새 adapter fresh build/proof guard 및 ownedtarget8을 통과해 r7 게시가 진행 중이며 전환 완료는 아직 아니다.

- r7 공개 완료: engine10파일/UPDATE_COMPLETE/Deployed·invalidation IBZXEETJW54LB3YQ2F38R10ADS Completed·소유 lock 삭제·exit0. 공식 MCP 추가3read actual api_calls도 성공했다. 실제 회사/CloudFront smoke exit0와 운영320/637/1440px Plus준비중/단위0·Basic월99,000원·넘침0·Plus상담/이메일/Escape/API0을 확인했다. 운영637px JPEG 및 메뉴/상태/실행서를 갱신했다. 인증 갱신 외 계정/무료 플랜/리전/MAIN/API/DB/장비 변경0이다.


## 2026-10-16 공개 사이트 SEO·검색 도구 등록

사용자 승인: 실제 SEO 점검 후 기존 화면을 유지하며 검색용 HTML·페이지별 metadata·robots/sitemap 보완·운영 배포와 네이버·구글 인증/사이트맵 제출. 등록 성공은 검색 색인·노출 순위·실측 Core Web Vitals 완료가 아니다. `brainstorming`의 bounded 설계를 사용자가 선택했고 `writing-plans` 체크리스트로 실행한다.

설계: 순수 PublicLandingEntry(pathname)를 기존 화면에서 추출해 빌드 시 기존 React renderToString으로3페이지를 생성하고 클라이언트는 hydrateRoot로 연결한다. landing route→index/features/pricing.html, metadata/config는 빌드·클라이언트 title이 공유한다. robots.txt(text/plain)/sitemap.xml(application/xml)은 exact 공개파일이며 canonical3URL만 포함한다. sitemap lastmod/평점/미확정 요금 등은 만들지 않는다. 정적 네이버 태그를 유지하고 Google은 기존 domain 인증으로 URL-prefix 속성을 추가한다. Service mode의 기존index/내부 경로·API404와 landing 공개 경계·artifact/source/lock/immutable/ownership guard는 유지한다.

- [x] 총괄: 실제3페이지/rawHTML·robots/sitemap/404와 공식 Google/Naver 가이드를 확인한다. 기존 회사 검색관리 계정에서 Google소유권 자동확인·킨다 속성 추가 및 Naver태그 발급을 확인한다.
- [x] 개발 담당: 공개 entry/공유SEO metadata/정적SSR·hydration,3HTML·robots/sitemap·네이버태그를 구현한다. 정적renderer 의존성도 기존 audited closure와 실제 module provenance에 결속하고 날짜/환경 출력은 결정적으로 유지한다.
- [x] 개발 담당: 미리보기·CloudFront의 정확한 route mapping, output/key/MIME·레거시 builder 호환 계약과 실패 회귀를 갱신하고3메뉴 문서를 최신화한다. 기본 UI/motion/상담·Plus준비중과 service flag는 보존한다.
- [x] 총괄: root-owned officialMCP adapter의 정확한4추가파일/key/MIME를 확장하고 기존 guard 검증/독립 리뷰를 통과한다. 소유 writer와 root는 같은 파일을 수정하지 않는다.
- [x] 개발 담당/QA: raw HTTP·JS-off 본문/고유 head·canonical·robots/sitemap·hydration 오류/중복0·기존 접근차단/상담/motion을 기존12케이스 안에서 검증하고 source freeze/독립 최종 검토를 회수한다. 추가 optional 전체suite나 baseline 재생성은 구체적 위험이 있을 때만 수행한다.
- [ ] 총괄: exact Git SHA의 Public Landing Release와 CI artifact digest·fresh local build/proof를 검증하고 새 immutable release를 배포한다. 실제 stack/CloudFront/invalidation·ownlock 삭제와 두 HTTPS/SEO 응답을 확인한다.
- [ ] 총괄: 실제 Naver 소유확인·robots/사이트맵 제출, Google 사이트맵 제출/대표URL 색인 요청을 수행하고 표시된 성공 상태·남은 수집/색인 지연을 기록한다. CAPTCHA/로그인/약관 등 실제 사용자 입력이 필요한 경우만 인계한다. 영구 증거/메뉴/상태/실행서를 완료한다.

- 개발 freeze:27파일 SHA 일치, Node40/40·공개unit37/37·strictChromium12/12(실패/skip/flaky0)·public typecheck/UI정책0/0과 raw/noJS·hydration 검증을 확인했다. 두 fresh build의 source95802f76/artifact14a02be5/rendererba4d1b51 동일성과 실제renderer172/raw2941·published15/audited419 결속을 확인했다. 총괄 adapter9/9·정확4파일/MIME 거부 테스트도 통과했다. 새 독립 검토가 진행 중이며 운영 게시/네이버 소유확인은 아직이다.

- 독립 검토: Critical/Important0·exact CI/배포 진행 가능. Reviewer가 source95802f76/artifact14a02be5/rendererba4d1b51을 독립 재계산했고 SSR·exact route/404·legacy quartet·audit/sourceproof·기존 guard를 확인했다. ignored adapter 실패로그 안내의 파일명 오타1건만 실제r8 이름으로 정리했다. 실제 Linux CI/AWS/등록/색인/CWV는 이 코드 검토가 검증한 범위가 아니다.


## 2026-10-21 기본 구독·추가 조명 로컬 수정 운영 배포

- [x] 운영 SEO 계열/배포 대상과 로컬 승인 소스 ef668368을 대조하고 요금 UI·관련 기대·메타만 반영한다. 기존 준비중 로그인/이메일 상담/모바일 수정·SEO 인증과 정적 HTML은 보존한다.
- [ ] 정확 후보를 커밋하고 Public Landing Release CI와 새 로컬 관문·source/artifact guard를 통과한다. 기존 전체 service gate는 변경하지 않는다.
- [ ] 기존 kinda 인증/서울 이전 없는 Sydney 대상에서 새 릴리스를 게시하고 CloudFront 전파/invalidation·lock 해제를 확인한다.
- [ ] 실제 회사/CloudFront HTTP·검색 파일·기본 구독/100원/문구/부가세·소개/Plus 제거와 상담/반응형 화면을 확인하고 상태/메뉴/실행서를 완료한다.

- 2026-10-21 관문 수리: 첫9205bfbb는 감사 집계 불일치로 실패했다. 실제 원본은 새 Vite3 advisory가 두 설치 버전에 대응했다. 공개 Vite6.4.4와 해당 frozen lock만 갱신했고 감사 정책/예외는 보존했다. working candidate 로컬 unit37/Chromium12/타입/계약/빌드/scoped blocked0 통과 후 최종 후보 CI를 기다린다.
