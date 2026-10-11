# 킨다 공개 Web AWS 배포

기준일: 2026-10-11. 실제 AWS 배포는 수행하지 않았다. 전용 private S3·CloudFront 배포에서 `WEB_DEPLOY_MODE` 하나로 공개 범위를 선택한다. 기존 관제 API·DB·장비를 생성하거나 변경하는 도구가 아니다.

## 한 번 설정할 항목

`infra/landing/config.example.json`을 `.local/landing-aws.json`으로 복사하고 승인된 정확한 값을 입력한다.

- AWS CLI v2와 기존 SSO/profile 또는 승인된 OIDC 인증, 12자리 `accountId`, `region`.
- 새 전용 `stackName` (`kinda-landing-...`), 계정 ID를 포함하는 새 전용 `bucket`. 생성 후 출력에서 정확한 `distributionId`를 복사한다.
- 사용자 도메인을 쓸 경우 `domainName`, 같은 계정의 기존 ISSUED `us-east-1` ACM `certificateArn`, 기존 public Route 53 `hostedZoneId`. 모두 함께 설정하며 해당 이름의 기존 A/AAAA/CNAME을 덮어쓰지 않는다. 비어 있으면 CloudFront 기본 도메인을 사용한다.
- 서비스 전환 전에 `apiOriginDomain`에 기존 HTTPS API의 **호스트 이름만** 입력한다. scheme, 경로, 포트, IP, 로컬 호스트는 허용하지 않는다. 예시 파일은 빈 값이며 임의 주소로 채우지 않는다.
- API origin은 공개적으로 신뢰되는 TLS 인증서와 해당 hostname을 지원하고 `/api/*`를 그대로 처리해야 한다. DB/migration·인증·역할·tenant·쿠키는 기존 백엔드 책임이다. 쿠키의 Domain은 공개 Web과 호환되거나 host-only여야 하며, Secure/HttpOnly/SameSite·원래 요청 origin/CSRF 허용 정책도 운영 환경에 맞게 사전 검증한다. CloudFront는 origin Host를 사용하므로 API가 viewer Host를 필요로 한다면 해당 운영 설계를 먼저 조정한다. backend provisioning은 이 명령에 포함되지 않는다.

서비스 모드는 이 입력이 없으면 빌드 및 원격 호출 전에 실패한다. 이후 공개 범위 선택에는 별도 로그인 URL·라우팅 변수·수동 CloudFront 편집이 필요 없다. `VITE_LANDING_SERVICE_URL`은 이전 랜딩 전용 외부 로그인 링크를 위한 선택 설정으로만 남으며 service에서는 무시하고 `/login`을 사용한다. 이 값은 비밀이 아니며 번들에 들어간다.

## 동일 명령으로 모드 선택

```sh
# 최초 의존성 준비: Node 22 / pnpm 9.15.0, frozen lockfile
pnpm install --frozen-lockfile
pnpm workspace:prepare

# 랜딩만 공개 (미설정도 landing)
WEB_DEPLOY_MODE=landing node scripts/landing/deploy.mjs deploy --config .local/landing-aws.json --release 20261011-landing-r1 --execute

# 기존 인증을 사용하는 전체 프론트 공개
WEB_DEPLOY_MODE=service node scripts/landing/deploy.mjs deploy --config .local/landing-aws.json --release 20261011-service-r2 --execute
```

각 새 배포는 새 release ID를 사용한다(영숫자로 시작하는 영숫자/하이픈/밑줄, 최대 80자). 변경하는 기능 선택값은 `WEB_DEPLOY_MODE=landing|service`뿐이다. 빈 문자열·오타는 오류이며 브라우저 런타임 토글이 아니다. **플래그 변경 뒤 같은 명령으로 재빌드·재배포해야 한다.** `deploy --execute`는 항상 `build:public`을 먼저 실행하며 이전 `--dist` 우회 옵션은 받지 않는다.

`--execute`를 빼면 AWS 호출과 빌드가 없는 오프라인 계획만 출력한다. 실제 계정 접근·리소스·산출물 검증 완료를 뜻하지 않는다. 현재 환경에서는 실제 AWS 계정/배포 대상이 제공되지 않았으며 이 문서의 원격 명령을 실행하지 않았다.

## 두 모드의 산출물과 경로

| 항목 | landing | service |
| --- | --- | --- |
| 공개 페이지 | `/`, `/features`, `/pricing` | 동일 |
| 헤더 로그인 | 기본 disabled `준비 중` | 같은 origin `/login` |
| 내부 앱 | 실제 Rollup graph와 출력에서 제외 | 현재 AppRoot·세션·역할·tenant·mobile bootstrap 유지 |
| 내부 직접 접근 | HTTP 404 | 실제 CustomerShell/OperatorShell 경로만 허용 |
| API | 공개하지 않음, edge HTTP 404 | `/api`, `/api/*` → 사전 설정 HTTPS origin |
| 자산 | `assets/landing/*`만 허용 | `assets/service/*`만 허용 |
| 시안·테스트·알 수 없는 경로 | 제외, HTTP 404 | 제외, HTTP 404 |

서비스 허용 경로는 `/login`, `/monitoring`, `/control`, `/statistics`와 overview/analysis/reports, `/settings`와 site/users/registration/floor-plans/security, `/settings/floor-plans/:floorId/edit`, `/operator/site-admins`, sensor-profiles/landing-inquiries/security다. query는 보존하고 알 수 없는 하위 경로와 trailing slash는 404다. 허용 목록은 `apps/web/scripts/public-deploy-contract.mjs`에 있으며 실제 앱 route 변경 시 함께 갱신한다. HTML 접근 허용은 인증 우회가 아니며 로그인하지 않은 내부 요청은 기존 인증 화면/권한 처리를 거친다.

`build:public`은 `apps/web/dist-public`을 깨끗이 생성한다. `publicDir: false`, 별도 service entry, 실제 Rollup 전체 모듈 검사, 허용 파일 검사, 모드별 worker 자산 경로를 사용한다. `deployment.json`은 모드와 전체 파일 SHA-256/크기를 묶는다. 누락·추가·변경 파일 또는 다른 모드는 원격 쓰기 전에 거절한다. 감사 파일은 `apps/web/.local/public-{mode}-build-audit.json`이며 배포하지 않는다. 일반 `dev`/`build`와 시안 경로는 유지하고 일반 헤더 로그인은 `/login`이다. 기존 `build:landing`/`dist-landing`은 독립 로컬 검증용으로 유지하되 새 배포 입력으로 받지 않는다.

## 최초 리소스 생성

```sh
mkdir -p .local
cp infra/landing/config.example.json .local/landing-aws.json
# 승인된 정확한 대상 값 입력 후
node scripts/landing/deploy.mjs provision --config .local/landing-aws.json
node scripts/landing/deploy.mjs provision --config .local/landing-aws.json --execute
```

provision은 새 전용 stack만 생성하고 기존 stack을 채택하지 않는다. 계정·도메인·인증서·DNS 충돌 확인, CloudFormation validate-template, termination protection을 사용한다. Stack 생성 완료를 기다리고 출력의 정확한 대상 ID를 config에 옮긴다. 빈 배포에는 아직 게시된 페이지가 없으므로 바로 첫 deploy를 완료한다. 실제 생성은 별도 승인된 provisioning 권한이 필요하다.

```sh
node scripts/landing/deploy.mjs check --config .local/landing-aws.json --execute
```

check/deploy/rollback은 계정, stack ARN/tag/안정 상태/출력, expected bucket owner, Public Access Block, BucketOwnerEnforced, CloudFront ARN·S3 origin·OAC 서명과 선택적 API origin을 검사한다. 기존 배포 스택은 같은 소유권 검증을 통과한 경우에만 새 템플릿으로 갱신한다. 이전 v1 archive는 모드·바이트 계약이 없으므로 새 도구가 롤백하지 않는다. 검토된 소스로 새 v2 릴리스를 먼저 만든다.

## 원격 적용 순서와 캐시

1. 선택 모드로 재빌드하고 `deployment.json`과 실제 바이트를 확인한다. service API 입력과 대상 identity를 확인한다.
2. `releases/deployment.lock`을 `If-None-Match: *`로 획득한다. 같은 대상 deploy/rollback은 직렬화한다.
3. `releases/<id>/`에 모드가 포함된 v2 manifest와 전체 파일을 불변 보관한다. manifest는 모든 파일 업로드 뒤 마지막으로 게시한다. 복원도 hash·크기·공개 출력 검사를 통과해야 한다.
4. 해시 자산을 root `assets/{mode}/...`에 불변 업로드하고 HTML·brand를 `published/<id>/...`에 불변 업로드한다. 같은 이름의 다른 바이트는 실패한다. 기존 자산과 보관본은 삭제하지 않는다.
5. CloudFormation의 동일 stack update로 릴리스 경로 Function과 서비스 API behavior를 적용한다. Function은 HTML을 정확한 `published/<id>/index.html`로 보낸다. 원래 `/published/*`, `/releases/*`, 임의 파일 접근은 차단한다. 완료된 stack과 CloudFront 전체 `Deployed` 상태, 릴리스/모드 출력을 확인한 뒤 `/*` invalidation 완료까지 기다린다.
6. 성공 후 자신이 획득한 잠금을 해제한다.

S3는 private REST origin이며 OAC always/SigV4, SSE-S3, versioning, Retain 정책을 유지한다. 해시 자산만 1년 immutable 캐시하고 HTML/brand는 no-store다. 오류 페이지는 script 없는 정적 HTML을 Function이 **실제 404**로 반환한다. origin 403/404를 HTML로 바꾸는 전역 오류 매핑은 없으며 CloudFront가 지원하는 오류의 TTL은 0이다.

서비스 API behavior는 모든 7개 HTTP 메서드와 쿠키·Authorization·쿼리·viewer header(Host 제외)를 전달한다. managed CachingDisabled와 AllViewerExceptHostHeader를 조합하고 Function을 API behavior에 연결하지 않는다. 401/403/404와 오류 본문은 origin 응답 그대로 유지한다. 운영 API는 응답에도 적절한 no-store를 유지해야 한다. [AWS origin request policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-request-understand-origin-request-policy.html), [오류 캐시 TTL](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesErrorPages.html).

CloudFront Function/배포 설정의 전파는 전 세계에서 동시에 일어나지 않는다. 전파 중에는 일부 edge에서 이전 모드가 보일 수 있다. 릴리스별 HTML은 혼합되지 않도록 불변 경로에 묶지만 서비스 진입과 API behavior가 모든 edge에서 동시에 바뀌는 트랜잭션은 보장하지 않는다. service→landing 완료 후 API·새 service 자산 요청은 차단되며 이미 내려받은 JavaScript나 발급된 세션을 취소하지는 않는다. 원격 전환과 실제 세션은 운영 smoke로 검증해야 한다.

## 롤백과 실패 복구

```sh
# 아카이브에 기록된 모드와 같은 값을 지정한다.
WEB_DEPLOY_MODE=landing node scripts/landing/deploy.mjs rollback --config .local/landing-aws.json --release 20261011-landing-r1 --execute
```

롤백은 원래 모드 manifest와 모든 바이트를 검증한 뒤 같은 publish→stack update→전파 대기→invalidation 순서로 복원한다. 현재 모드와 다른 모드로 돌아갈 수 있지만 지정 플래그와 아카이브 모드는 일치해야 한다. archive hash는 손상 탐지이며 서명이 아니다.

- 활성화 전 실패: 공개 경로는 이전 릴리스를 유지하고 잡은 lock을 해제한다. 불완전한 archive는 삭제하지 않으므로 새 release ID로 다시 배포한다.
- 활성화/전파/invalidation 실패: 성공으로 처리하지 않고 lock을 유지한다. 이전 프로세스가 **완전히 종료**했고 stack이 CREATE_COMPLETE/UPDATE_COMPLETE/UPDATE_ROLLBACK_COMPLETE, distribution이 Deployed로 안정된 것을 확인한 운영자가 아래 명령을 실행한다. 진행 중이거나 UPDATE_ROLLBACK_FAILED인 stack은 자동 복구하지 않고 CloudFormation 실패 원인을 먼저 해결해야 한다.
- SIGKILL/호스트 종료: 같은 규칙으로 정확한 잠금 release를 확인한다. `--recover-lock`은 기존 프로세스 종료에 대한 명시적인 운영자 확인이다. 살아 있는 배포와 동시에 사용하지 않는다. 도구는 release와 ETag를 함께 검사해 정확한 lock 하나만 조건부 해제하며 일반 S3 삭제 명령이 필요하지 않다.

```sh
# 실패 release가 20261011-service-r2였을 때, 이전 landing으로 복원
WEB_DEPLOY_MODE=landing node scripts/landing/deploy.mjs rollback --config .local/landing-aws.json --release 20261011-landing-r1 --recover-lock 20261011-service-r2 --execute

# 또는 완료된 실패 release archive 자체를 다시 활성화
WEB_DEPLOY_MODE=service node scripts/landing/deploy.mjs rollback --config .local/landing-aws.json --release 20261011-service-r2 --recover-lock 20261011-service-r2 --execute
```

같은 release의 deploy 재시도는 새 빌드가 기존 archive와 바이트까지 동일할 때만 허용된다. 복구에는 위 rollback 명령을 권장한다. `sync --delete`, 자동 archive/old asset 정리는 하지 않는다. 누적 S3 보관 비용과 별도 보존 정책은 운영자가 관리한다.

## 권한과 검증 경계

`infra/landing/oidc-policy.example.json`은 정확한 계정·stack·bucket·distribution·OAC·Function과 protected GitHub Environment를 넣는 검토 템플릿이다. trust의 aud/sub를 고정한다. 배포 역할은 해당 stack 갱신, 해당 distribution/Function 갱신·게시·invalidation, 해당 S3 경로 읽기/쓰기와 lock 하나 삭제, 기존 bucket policy 갱신을 포함한다. ValidateTemplate은 AWS가 resource scoping을 지원하지 않아 Resource `*`가 필요하다. 새 stack/인증서/DNS/역할 생성 권한은 제공하지 않는다. OIDC workflow나 권한을 실제 생성하지 않았다.

기존 canonical CI **quality → unit → postgres-redis-integration → playwright-real-core → build → production-audit**와 동일 검토 커밋을 배포 전 필수 확인한다. 이 도구는 CI 성공을 자동 조회하지 않으며 좁은 로컬 테스트가 전체 CI 성공을 대체하지 않는다. 새 workflow를 연결할 때 protected environment·동일 SHA의 CI 성공 확인·frozen toolchain·직렬화를 유지한다.

```sh
node --test scripts/landing/*.test.mjs apps/web/scripts/public-deploy-contract.test.mjs
WEB_DEPLOY_MODE=landing pnpm --filter @led-control/web build:public
WEB_DEPLOY_MODE=landing pnpm --filter @led-control/web exec playwright test --config playwright.public.config.ts
WEB_DEPLOY_MODE=service pnpm --filter @led-control/web build:public
WEB_DEPLOY_MODE=service pnpm --filter @led-control/web exec playwright test --config playwright.public.config.ts
# 실제 배포가 끝난 뒤 명시적 운영 URL에 읽기 전용 확인
WEB_DEPLOY_MODE=service node scripts/landing/smoke.mjs https://승인된-정확한-호스트
```

production preview는 기본 5187 포트이며 `PUBLIC_PORT`로 충돌 없는 로컬 포트를 고른다. API를 proxy하지 않으므로 서비스 브라우저 검증은 명시적인 mock만 사용한다. 로컬/fake AWS 증거는 실제 CloudFormation validation·IAM·TLS·쿠키·운영 API·외부 DNS·과금·HIL 성공을 뜻하지 않는다. CloudFront/S3는 사용량과 보관량에 따른 비용이 발생하며 이 템플릿이 무료 요금제를 보장하지 않는다.
