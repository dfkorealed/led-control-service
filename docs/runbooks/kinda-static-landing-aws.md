# 킨다 공개 랜딩 AWS 배포

기준일: 2026-10-08. 실제 AWS 배포는 아직 수행하지 않았다. 이 실행서는 `/`, `/features`, `/pricing`만 공개하는 전용 S3·CloudFront 구성을 준비한다. 기존 관제 서버·DB·장비와 별도 리소스를 사용한다.

## 구성과 공개 범위

- `scripts/landing/template.mjs`가 CloudFormation JSON을 생성한다. `infra/landing/viewer-request.js`가 CloudFront Function의 단일 원본이다.
- 전용 S3 버킷은 모든 Public Access Block을 켜고 `BucketOwnerEnforced`, SSE-S3, 버전 관리를 사용한다. 삭제/교체 시 버킷을 보존한다. 수명 주기 자동 삭제 규칙은 없다.
- CloudFront는 S3 **REST origin + OAC `always`/SigV4**로 접근한다. Website endpoint나 public bucket을 사용하지 않는다. 버킷 정책은 해당 배포의 SourceArn에만 공개 HTML·assets·승인 brand 파일 경로 읽기를 허용하며 `releases/*`는 허용하지 않는다. OAC의 always 서명은 origin HTTPS도 보장한다. [AWS OAC 문서](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- Viewer HTTP는 HTTPS로 이동한다. 사용자 도메인을 설정하면 기존 `us-east-1` ACM 인증서와 TLS 1.2 이상을 적용한다. 도메인 설정이 없으면 생성된 CloudFront 도메인/기본 인증서를 사용한다. 기존 인증서를 생성·교체하지 않는다. [AWS 사용자 도메인 HTTPS](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-alternate-domain-names.html)
- 세 경로만 `/index.html`로 재작성한다. `/features/`, `/login`, `/index.html`, 내부 API·임의 경로는 SPA로 열리지 않는다. 알려지지 않은 경로는 존재하지 않는 키로 보낸다. private S3의 403·404 모두 `/404.html`과 **HTTP 404**를 반환한다. CloudFront Function은 테스트와 템플릿이 동일 파일을 소비한다. [AWS 오류 응답 상태 코드](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-response-code.html)
- 해시 assets는 `public,max-age=31536000,immutable`, HTML·승인 brand 이미지는 `public,max-age=60,must-revalidate`다. 모든 cache policy MinTTL은 0이며 query/cookie/header는 캐시 키에 넣지 않는다. HSTS, nosniff, frame DENY, Referrer-Policy, Permissions-Policy를 적용한다. [AWS 캐시 동작](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html)

## 프론트 전체 배포 후 랜딩 경로만 허용하는 대안

일반 Web 빌드 전체를 private S3에 올리고 CloudFront에서 `/`, `/features`, `/pricing`만 HTML로 열어 주는 방식도 가능하다. 직접 URL 접근과 새로고침의 내부 경로를 404로 제한할 수 있지만, 로드된 SPA 안의 클라이언트 라우팅까지 CloudFront가 제어하지는 않는다. 일반 앱에서 실제로 도달할 수 있는 화면은 앱의 라우터와 로그인 검사에 달려 있다.

| 항목 | 일반 프론트 전체 빌드 + 경로 허용 | 현재 랜딩 전용 빌드 + 경로 허용 |
| --- | --- | --- |
| HTML 요청 | 세 공개 경로만 허용하고 나머지는 404 | 동일 |
| 공개 JS/CSS | `/assets/*`를 허용하면 내부 화면 모듈도 다운로드 가능. 같은 chunk에 함께 들어간 코드도 분리되지 않음 | 랜딩 import graph와 공개 산출물 검사로 내부 모듈을 빌드에서 제외 |
| 시안/정적 파일 | 일반 설정의 concept entry와 `public` 파일이 산출물에 포함되므로 별도 차단·업로드 제외 필요 | `publicDir: false`와 승인 brand 파일 목록으로 제한 |
| 유지보수 | 일반 빌드는 재사용 가능. 랜딩 의존 chunk만 허용하려면 매 빌드의 해시·공유/동적 import 의존성에서 목록을 생성·검증해야 함 | 전용 entry/config를 유지하고 공개 페이지 변경 때 graph/output gate 실행 |
| 데이터 접근 권한 | 백엔드 인증·권한 검사가 담당 | 동일 |

실제 저장소의 `apps/web/vite.config.ts`는 `index.html`과 `concepts/field-day.html`을 입력으로 사용하고 `publicDir`를 끄지 않는다. `apps/web/public/concepts/*`도 존재하며, 현재 로컬 일반 `dist`에는 이 시안 HTML과 `CustomerShell-*`, `StatisticsOverviewPage-*` 등 내부 chunk가 있다. 이는 기존 산출물 확인이며 이번에 일반 빌드를 다시 수행한 증거는 아니다. Vite는 기본 `public` 디렉터리 파일을 변환 없이 빌드 출력에 복사한다. [Vite publicDir 공식 문서](https://vite.dev/config/shared-options.html#publicdir)

따라서 전체 빌드 방식의 경로 제한은 공개 HTML 요청 범위를 정하는 수단이며 서비스 데이터의 접근 권한을 대신하지 않는다. 해시 파일 이름을 수동으로 허용하는 방식은 빌드마다 바뀌고 공유 chunk의 내용까지 구분할 수 없어, 내부 모듈 배포 제외 요구를 안정적으로 유지하기 어렵다. 현재 요청은 대안 검토이므로 랜딩 전용 빌드 선택을 유지한다. 전체 빌드로 전환할 때는 직접 경로 404, SPA 내부 이동, 실제 배포 파일 목록과 백엔드 인증·권한을 함께 검증한다.

## 필요한 입력과 권한

현재 환경에서 AWS CLI·사용 가능한 profile/connector·정확한 AWS 리소스를 확인하지 못했다. 실제 실행에는 다음이 필요하다.

1. AWS CLI v2와 승인된 기존 인증 수단(예: 본인이 로그인한 SSO profile), 정확한 12자리 계정 ID·리전.
2. 새 전용 stack 이름 `kinda-landing-...`, 새 버킷 이름 `kinda-landing-...`(계정 ID 포함). 운영 서버/버킷을 재사용하지 않는다.
3. 최초 생성 후 CloudFormation 출력의 정확한 `BucketName`, `DistributionId`, `OacId`, `DistributionDomain`.
4. 사용자 도메인이 필요한 경우 소유한 정확한 FQDN, 같은 계정의 기존 ISSUED `us-east-1` ACM ARN, 기존 public Route 53 Hosted Zone ID. 해당 이름의 A/AAAA/CNAME이 이미 있으면 생성 스크립트는 중단한다. 기존 DNS를 덮어쓰지 않는다.
5. 로그인 활성화가 필요한 경우 `VITE_LANDING_SERVICE_URL`에 실제 승인된 HTTPS 관제 서비스 URL. 기본값은 빈 값이며 로그인은 ‘준비 중’이다. 이 값은 공개 번들에 포함된다. API 토큰·DB 비밀번호·장비 인증서·애플리케이션 secret은 필요하지 않다.

`infra/landing/config.example.json`을 `.local/landing-aws.json`으로 복사해서 빈 식별자를 채운다. 처음 provision할 때만 `distributionId`가 비어 있어도 된다. 도메인을 사용하지 않으면 `domainName`, `certificateArn`, `hostedZoneId`를 모두 빈 값으로 둔다. profile은 이미 승인된 AWS 환경 설정을 사용하며 스크립트가 credentials/config를 쓰지 않는다.

## 로컬 검증과 배포 준비

저장소 루트, Node 22, pnpm 9.15.0을 기준으로 실행한다. 커밋과 빌드 환경을 고정하고 frozen lockfile을 사용한다.

```sh
pnpm install --frozen-lockfile
pnpm --filter @led-control/web test:landing-contract
node --test scripts/landing/contracts.test.mjs
pnpm --filter @led-control/web build:landing
pnpm --filter @led-control/web e2e:landing
node scripts/landing/template.mjs > .local/landing-template.json
```

`build:landing`은 API/DB 없이 `apps/web/dist-landing`을 생성하고 실제 Rollup import graph와 공개 산출물 allowlist를 검사한다. 내부 graph 감사 파일 `apps/web/.local/landing-build-audit.json`은 공개하지 않는다. 배포 스크립트도 Web의 `assertLandingOutput`를 호출해 실제 파일 이름과 JS 내용을 검사하고, SHA-256/바이트 크기를 모든 파일에 기록한다. 원복할 때도 같은 검사를 수행한다. 임의 폴더·source map·내부 문서·알 수 없는 brand 이미지는 거부한다.

일반 앱 회귀 검사를 함께 실행할 경우, 기존 Web unit test의 API 생성 타입 import를 준비하기 위해 별도로 `pnpm --filter @led-control/api prisma:generate`를 실행한다. 이는 위 랜딩 전용 빌드·계약·브라우저 검증의 사전 조건이 아니다. 기존 CI의 Prisma 생성 단계는 일반 앱 검증 계약에 따라 유지한다.

이 좁은 검증은 기존 `.github/workflows/ci.yml`의 **quality → unit → postgres-redis-integration → playwright-real-core → build → production-audit** 성공을 대신하지 않는다. 공개 배포 전 동일한 검토 커밋의 canonical Software CI 결과를 확인한다. 현재 작업의 로컬 계약 테스트 성공을 전체 CI/production-audit 통과로 표현하지 않는다. 이 작업은 배포 workflow를 새로 만들지 않는다.

## 전용 리소스 최초 생성

```sh
cp infra/landing/config.example.json .local/landing-aws.json
# 위 파일에 승인된 정확한 입력을 채운 뒤 진행한다.
node scripts/landing/deploy.mjs provision --config .local/landing-aws.json
node scripts/landing/deploy.mjs provision --config .local/landing-aws.json --execute
```

`--execute` 없는 모든 모드는 AWS 호출 자체가 없는 **오프라인 계획 출력**이다. 계정 접근·원격 리소스·빌드 검증 성공을 의미하지 않는다. 실행 모드는 STS 계정을 먼저 확인하고, 기존 stack이 있으면 중단한다. 사용자 도메인이 있으면 인증서 상태·SAN, public zone 범위, 기존 DNS 충돌을 확인한다. CloudFormation `validate-template` 후 새 stack만 생성하며 termination protection을 켠다. 별도 provisioning 권한이 필요하며 아래 배포 전용 IAM으로는 생성할 수 없다.

CloudFormation 생성 완료를 AWS 콘솔 또는 `aws cloudformation wait stack-create-complete --stack-name <정확한 이름> --region <리전>`으로 기다린다. `describe-stacks` 출력의 정확한 ID를 config에 옮긴다. 생성 실패 시 stack 이벤트를 확인한다. 임의 삭제·재생성·기존 리소스 채택은 자동으로 하지 않는다.

```sh
node scripts/landing/deploy.mjs check --config .local/landing-aws.json --execute
```

이 읽기 전용 검사는 계정, dedicated stack tag/상태/출력, expected bucket owner, public access block, ownership, 배포 ARN·유일 REST origin·OAC ID·서명 설정을 확인한다. deploy와 rollback도 **모든 원격 쓰기 전에** 같은 검사를 수행한다.

## 새 릴리스 배포와 확인

```sh
node scripts/landing/deploy.mjs deploy --config .local/landing-aws.json --release 20261008-r1
node scripts/landing/deploy.mjs deploy --config .local/landing-aws.json --release 20261008-r1 --execute
node scripts/landing/smoke.mjs https://실제-CloudFront-또는-승인-도메인
```

릴리스 ID는 영숫자로 시작하는 영숫자·하이픈·밑줄 80자 이내이며 매번 새 값을 사용한다. `--dist`는 기본 `apps/web/dist-landing` 대신 검토된 산출물을 명시할 때만 쓴다. 스크립트는 다음 순서로 실행한다.

1. 대상 identity를 확인하고 `releases/deployment.lock`을 conditional put (`If-None-Match: *`)으로 획득한다. 다른 deploy/rollback과 동시에 실행할 수 없다.
2. 공개 파일의 경로/내용을 검사하고 SHA-256 manifest를 만든다. `releases/<id>/`에 파일을 조건부 업로드하고 마지막에 manifest를 게시한다. 기존 릴리스 파일은 덮어쓸 수 없다.
3. 모든 파일 바이트와 manifest를 다시 확인한다. 해시 assets를 먼저, HTML은 마지막(`index.html` 최후)에 게시한다. 같은 해시 경로에 다른 내용이 있으면 중단한다.
4. CloudFront `/*` invalidation을 만들고 완료를 기다린다. 원래 route/재작성 HTML 키·과거 negative cache도 제거한다. [AWS invalidation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html)
5. 자신이 획득한 lock을 해제한다. smoke는 세 경로 200, 내부/미지 경로 404, 보안 헤더와 HTTPS 이동을 확인한다. 브라우저의 새로고침·모바일·CTA·API 요청 없음은 Web E2E와 실제 페이지로 확인한다.

`sync --delete`, assets 정리, 릴리스 자동 삭제는 사용하지 않는다. 예전 HTML이 브라우저에 남아 있어도 예전 해시 assets를 계속 읽을 수 있다. `brand/*`는 버전 없는 짧은 캐시 경로이므로 같은 이름의 변경은 예전 HTML에도 반영될 수 있다. 아카이브/S3 버전이 계속 누적되므로 비용을 관찰하고, 별도로 승인된 보존 정책이 정해진 후에만 정리한다.

## 롤백과 중단 복구

```sh
node scripts/landing/deploy.mjs rollback --config .local/landing-aws.json --release 20261008-r1
node scripts/landing/deploy.mjs rollback --config .local/landing-aws.json --release 20261008-r1 --execute
```

롤백은 현재 identity를 재확인하고 같은 lock을 획득한 다음, 해당 아카이브 manifest와 모든 파일을 임시 디렉터리에 내려받아 SHA-256·크기·공개 산출물 규칙을 검증한다. assets→HTML 순서로 복원하고 `/*` invalidation 완료를 기다린다. 새 릴리스 assets와 보관본도 지우지 않는다. manifest는 우발적 손상/잘못된 파일을 탐지하며 AWS 쓰기 권한 자체를 탈취한 공격자에 대한 서명 증명은 아니다.

S3 여러 객체 교체는 단일 트랜잭션이 아니다. 업로드/invalidation 실패 시 자동 성공으로 표시하지 않으며, 보관된 직전 정상 릴리스로 위 rollback을 실행한다. 아카이브가 완성되었다면 같은 릴리스 ID를 deploy로 덮어쓰는 대신 rollback으로 재게시할 수 있다. 아카이브 일부만 남았다면 새 ID를 사용하고 부분 보관본은 자동 삭제하지 않는다. 프로세스 강제 종료로 lock이 남으면 기존 배포 프로세스 종료와 실제 객체 상태를 확인한 운영자가 **정확한 `releases/deployment.lock` 한 개만** 해제한다. bucket/version/archive 전체 삭제로 해결하지 않는다.

## GitHub OIDC를 나중에 연결할 때

`infra/landing/oidc-policy.example.json`은 현재 remote `df-kjh/led-control-service`의 **정확한 protected Environment**를 지정하는 trust/IAM 검토 템플릿이다. 계정·stack·bucket·distribution·OAC·environment placeholder를 모두 실제 식별자로 치환한다. `aud=sts.amazonaws.com`, `sub=repo:df-kjh/led-control-service:environment:<정확한 환경>`를 StringEquals로 고정하고 GitHub 환경에서 승인자/허용 브랜치를 제한한다. [AWS GitHub OIDC trust](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html)

배포 역할은 해당 bucket의 공개 객체·release 읽기/쓰기와 **lock 한 개 삭제**, 정확한 distribution 조회/invalidation, 정확한 OAC 조회와 stack 조회만 허용한다. 인증서·DNS·인프라 생성/변경·일반 객체 삭제 권한을 주지 않는다. 실제 GitHub workflow는 아직 없으며, 추가할 때 `workflow_dispatch`, `id-token: write`, `contents: read`, protected environment, 고정 Node/pnpm+frozen install, 동일 커밋 canonical Software CI 성공 확인, 위 계약/산출물 gate와 배포 직렬화를 필수로 연결한다. 운영 access key를 저장하지 않는다.

## 가격과 현재 한계

2026-10-08 공식 AWS 가격 페이지에는 배포당 월 Free $0, Pro $15, Business $200, Premium $1,000 및 별도 pay-as-you-go 선택지가 있다. Free/Pro에는 Custom Caching Rules가 표시되지 않으므로, **이 사용자 정의 cache policy 구성은 pay-as-you-go 준비**로 다룬다. 템플릿은 flat-rate 구독/WAF 요금제 연결을 만들지 않으며 월 $0를 보장하지 않는다. [AWS CloudFront 현재 가격](https://aws.amazon.com/cloudfront/pricing/)

Flat-rate는 계정 eligibility·기능 제한·WAF 연결·사용 허용량과 zone 연결 조건을 확인해야 한다. 포함되지 않는 S3 요청/누적 보관, DNS·로그·기타 서비스 비용은 별도로 발생할 수 있다. 실제 트래픽/보관 기간/리전·요금제를 선택한 뒤 예상 비용과 Billing 예산을 확인한다. [AWS flat-rate 조건과 제외 기능](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)

로컬 Node 계약과 fake AWS 테스트는 AWS API 호출 순서/안전 장치 검증이다. 실제 CloudFormation validation, ACM/S3/CloudFront 연결, 원격 HTTP 결과, 과금과 운영 배포는 계정 접근/정확한 대상 입력을 받은 뒤 확인해야 한다.
