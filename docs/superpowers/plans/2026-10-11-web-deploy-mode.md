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
