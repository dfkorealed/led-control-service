# 킨다 공개 Web AWS 배포

기준일: 2026-10-12. AWS 계정 연결, ACM 인증서 발급과 호스팅케이알 인증서 검증 CNAME 저장은 완료했다. 전용 Sydney stack·private S3·CloudFront 생성과 릴리스 게시, 호스팅케이알 `kinda` CNAME 연결 및 실제 HTTPS 검증까지 완료했다. 전용 private S3·CloudFront 배포에서 `WEB_DEPLOY_MODE` 하나로 공개 범위를 선택한다. 기존 관제 API·DB·장비를 생성하거나 변경하는 도구가 아니다. 아래 `kinda.dfkorealed.com` 절차는 호스팅케이알에서 DNS를 관리하는 경우의 수동 절차다.

현재 계정의 무료 플랜을 유지하기로 선택했으므로 첫 사이트 배포 리전은 **Sydney `ap-southeast-2`**다. CloudFront용 ACM만 `us-east-1`에 둔다. 아래 Seoul 리전 예시는 일반 입력 형식 설명이며 현재 계정에 그대로 적용하지 않는다. 추후 Seoul 이전은 새 리소스 생성·검증·DNS 전환이 필요하다. 전체 서비스는 정확한 배포 후보의 canonical CI 여섯 단계 통과를 요구한다. 사용자가 승인한 landing-only 공개는 아래의 별도 landing 관문 통과를 요구한다. 관문 통과 전 사이트 리소스 생성·콘텐츠 게시를 하지 않는다. 최신 진행 상태는 [실행 계획](../superpowers/plans/2026-10-11-web-deploy-mode.md)을 참조한다.

현재 공개 후보의 네 보안 업데이트와 CI launcher 보완은 독립 검토를 통과했다. 그러나 전체 저장소 감사는 수정 릴리스가 없는 모바일 도구 `node-forge`·`braces` High 두 건으로 실패한다. 실제 landing 빌드의 unfiltered module graph에는 두 패키지가 없고 manifest 파일 검증도 통과했지만, 이 증거는 기존 전체 CI 통과 요구를 대신하지 않는다. 2026-10-12 사용자가 landing 전용 release 관문 추가와 통과 후 배포를 명시 승인했다. 별도 frozen dependencies/공개 기능/산출물 security graph/HTTP 차단 검증을 구현·독립 검토하고 exact 후보의 landing CI가 실제 성공한 뒤에만 공개한다. 전체 서비스 CI·감사 정책은 유지하며 현재 두 High findings의 해결을 주장하지 않는다.

## 최초 실제 공개 결과 — 2026-10-12

- 공개 주소: **https://kinda.dfkorealed.com/**
- 공개 소스: `f5eb68154156d1f98d4626654a69f32d70a3a16b` · [Public Landing Release 성공](https://github.com/dfkorealed/led-control-service/actions/runs/38217099893)
- 모드/릴리스: `landing` / `20261012-landing-r1`
- 리전/stack: `ap-southeast-2` / `kinda-landing-prod-20261012`
- bucket: `kinda-landing-456721863474-web-20261012`
- CloudFront: `E2XZYU4N91AW5N` / `dyj4x3eldv08n.cloudfront.net`
- 배포 manifest SHA: `ee1534a9ad1be5b61b8bd2ee9d1834fe98914996e112492386ca65a6a2b3a55a`
- 실제 배포10파일, stack `UPDATE_COMPLETE`, invalidation `I8XCKUBM4KCAFENL14ZFR9SAJ1` `Completed`.
- HostingKR CNAME `kinda` → `dyj4x3eldv08n.cloudfront.net`, TTL180. 기존 회사 홈페이지 A·메일 MX·TXT·ACM 검증 CNAME을 유지했다.
- AWS 기본 주소와 회사 주소에서 `/`, `/features`, `/pricing` 200, 로그인·내부·API·unknown·concepts·archive404, HTTP→HTTPS와 보안 헤더를 확인했다. 실제 브라우저에서 세 페이지 이동, 요금제 문구, 상담 팝업 열기/닫기를 확인했다.
- 상담은 전화·이메일 fallback이며 온라인 접수 API·DB·메일 발송 백엔드와 로그인/관제 앱은 배포하지 않았다. 무료 플랜·기존 리전 제한을 유지한다.
- 같은 SHA의 전체 Software CI는 quality SUCCESS/unit FAILURE/나머지4 SKIPPED다. 랜딩 공개 성공은 전체 서비스 CI/API·모바일·장비/HIL 성공을 뜻하지 않는다. 전체 서비스 공개는 기존 전체 관문을 충족해야 한다.

Ignored actual 로그·CI proof·스크린샷은 배포 후보의 `.local` 및 `/Users/kim-jh/Documents/led-control-service/.local/landing-deploy-20261012`에 보존한다. AWS 인증 정보는 문서와 공개 산출물에 포함하지 않는다.

## 한 번 설정할 항목

`infra/landing/config.example.json`을 `.local/landing-aws.json`으로 복사하고 승인된 정확한 값을 입력한다.

- AWS CLI v2와 기존 SSO/profile 또는 승인된 OIDC 인증, 12자리 `accountId`, `region`.
- 새 전용 `stackName` (`kinda-landing-...`), 계정 ID를 포함하는 새 전용 `bucket`. 생성 후 출력에서 정확한 `distributionId`를 복사한다.
- 사용자 도메인을 쓸 경우 `domainName`과 같은 AWS 계정의 **ISSUED** `us-east-1` ACM `certificateArn`을 함께 설정한다. DNS가 호스팅케이알이면 `hostedZoneId`를 명시적으로 빈 문자열 `""`로 둔다. 기존 public Route 53에서 관리한다면 정확한 `Z...` hosted zone ID를 넣어 자동 A/AAAA alias 레코드를 사용한다. 잘못된 ID는 거절한다. `domainName`이 비어 있으면 인증서와 zone도 비워 CloudFront 기본 도메인을 사용한다.
- 서비스 전환 전에 `apiOriginDomain`에 기존 HTTPS API의 **호스트 이름만** 입력한다. scheme, 경로, 포트, IP, 로컬 호스트는 허용하지 않는다. 예시 파일은 빈 값이며 임의 주소로 채우지 않는다.
- API origin은 공개적으로 신뢰되는 TLS 인증서와 해당 hostname을 지원하고 `/api/*`를 그대로 처리해야 한다. DB/migration·인증·역할·tenant·쿠키는 기존 백엔드 책임이다. 쿠키의 Domain은 공개 Web과 호환되거나 host-only여야 하며, Secure/HttpOnly/SameSite·원래 요청 origin/CSRF 허용 정책도 운영 환경에 맞게 사전 검증한다. CloudFront는 origin Host를 사용하므로 API가 viewer Host를 필요로 한다면 해당 운영 설계를 먼저 조정한다. backend provisioning은 이 명령에 포함되지 않는다.

서비스 모드는 이 입력이 없으면 빌드 및 원격 호출 전에 실패한다. 이후 공개 범위 선택에는 별도 로그인 URL·라우팅 변수·수동 CloudFront 편집이 필요 없다. `VITE_LANDING_SERVICE_URL`은 이전 랜딩 전용 외부 로그인 링크를 위한 선택 설정으로만 남으며 service에서는 무시하고 `/login`을 사용한다. 이 값은 비밀이 아니며 번들에 들어간다.

### 호스팅케이알 `kinda.dfkorealed.com` 준비

1. AWS Console에서 **CloudFront에 사용할 계정**을 확인하고 리전을 **미국 동부(버지니아 북부) `us-east-1`**로 바꾼 뒤 ACM 공개 인증서를 `kinda.dfkorealed.com`용으로 요청한다. 검증 방법은 DNS다. ACM의 *Domains*에 표시되는 **CNAME 이름과 값은 계정·인증서별 실제 값**을 복사한다. 이 저장소의 예시 번호나 다른 인증서의 토큰을 사용하지 않는다. CloudFront 대체 도메인은 유효한 인증서 SAN에 포함되어야 한다. [AWS ACM과 CloudFront 리전](https://docs.aws.amazon.com/acm/latest/userguide/), [ACM DNS 검증](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html), [CloudFront 대체 도메인 요구사항](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html).
2. `dfkorealed.com`의 실제 권한 네임서버가 호스팅케이알인지 확인한다. 호스팅케이알 DNS를 사용한다면 **나의서비스 → 도메인 → `dfkorealed.com` → 네임서버 / DNS → DNS 레코드 관리 → 새 DNS 레코드 추가**로 이동한다. ACM 검증용 **CNAME**을 추가한다. 이름 칸은 `dfkorealed.com`을 다시 붙이지 않은 상대 이름이다. 예를 들어 ACM 이름이 `_token.kinda.dfkorealed.com.`이면 `_token.kinda`를 입력하고, 값은 ACM이 준 `_...acm-validations.aws` 호스트를 입력한다. `https://`나 경로를 넣지 않는다. 화면이 전체 이름을 표시하면 중복된 `.dfkorealed.com`이 없는지 확인한다. 호스팅케이알이 권한 네임서버가 아니라면 실제 DNS 제공자에서 같은 레코드를 설정한다. [호스팅케이알 CNAME 등록](https://help.hosting.kr/hc/ko/articles/5694434421529), [DNS 레코드 설정](https://help.hosting.kr/hc/ko/articles/5259561590809).
3. ACM 인증서 상태가 **ISSUED**로 바뀌고 SAN에 `kinda.dfkorealed.com`이 있는지 확인한다. 검증 CNAME은 ACM 자동 갱신에 필요하므로 유지한다. 인증서 ARN만 `certificateArn`에 복사하고 인증서 개인 키나 AWS 자격 증명은 설정 파일·로그에 적지 않는다.

`kinda.dfkorealed.com`은 서브도메인이므로 이후 CloudFront 연결에 일반 CNAME을 사용한다. `dfkorealed.com` 네임서버를 Route 53으로 변경하거나 NS 위임 레코드를 만들 필요가 없다. 기존 `kinda` A/AAAA/CNAME 레코드가 있으면 목적지를 먼저 확인한다. 도구는 호스팅케이알 DNS를 조회하거나 수정하지 않는다.

## Landing 전용 공개 관문

Node22/pnpm9.15.0에서 `WEB_DEPLOY_MODE=landing node scripts/landing/release.mjs`를 실행한다. `.github/workflows/landing-release.yml`의 **Public Landing Release**가 정확한 공개 후보 커밋에서 성공해야 한다. Frozen install → shared build → public typecheck/unit/계약 → 실제 public build → dev 포함 fresh scoped audit → served-dist Chromium 순서다. 기존 Software CI는 그대로 실행되며 service 공개에는 그 여섯 단계 전체 성공이 필요하다.

범위는 실제 Web/shared 의존성 및 빌드·검증 도구의 lock 이름/버전 closure다. Raw/emitted Rollup module을 실제 package metadata에 연결하고 전체 감사의 적용/범위 밖 finding을 모두 기록한다. Moderate 이상 적용 finding, 잘못된 감사 자료, unknown module, 누락된 검사, skip·flaky browser 또는 변경된 source/artifact는 실패다. Advisory의 dependency-path 문자열만으로 제외하지 않는다.

성공 증명은 `.local/landing-release/proof.json`이며 CI artifact `public-landing-<전체 Git SHA>`에서 받는다. 증명은 Git HEAD, source/config/workflow/lock 및 배포 manifest SHA와 실제 검사 결과를 묶는다. Landing `deploy --execute`는 항상 다시 빌드한 뒤 증명의 같은 HEAD/source/artifact 및 24시간 이내 보안 감사 여부를 검증하고, 불일치하면 첫 AWS 호출 전에 실패한다. 실패한 새 관문은 이전 proof를 삭제한다. `.local` 자료와 proof는 공개 자산에 포함하지 않는다.

2026-10-12 로컬 보존 cohort는 public unit37/37, 계약29/29, Chromium6/6(0skip/0retry), 일반 Web5/5, 타입 fixture41/41 및 전체 Web typecheck 성공이다. 최신 public build는 raw2,928/emitted164 modules, 실제 published15 packages이며 closure419/installed324에 해당 advisory0이다. 전체 dev 포함 감사의 Critical5/High10/Moderate8(23건)은 범위 밖으로 명시 보존한다. 이는 최종 커밋 CI와 AWS 공개 성공을 대신하지 않는다.

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

`--execute`를 빼면 AWS 호출과 빌드가 없는 오프라인 계획만 출력한다. 실제 계정 접근·리소스·산출물 검증 완료를 뜻하지 않는다. 현재 계정 연결과 인증서 검증이 완료됐더라도 `provision`·콘텐츠 `deploy`와 공개 smoke의 실제 성공은 별도로 확인한다.

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
# 승인된 정확한 계정·전용 이름·인증서 값 입력 후
node scripts/landing/deploy.mjs provision --config .local/landing-aws.json
node scripts/landing/deploy.mjs provision --config .local/landing-aws.json --execute
```

호스팅케이알 모드 설정 예시는 다음과 같다. `accountId`, `stackName`, `bucket`, `certificateArn`은 **본인 계정에서 확인한 실제 값**을 사용하고 `distributionId`는 최초 생성 전에는 빈 값으로 둔다. `apiOriginDomain`은 landing만 공개할 때 빈 값이어도 된다.

```json
{
  "accountId": "실제 12자리 계정 ID",
  "region": "ap-northeast-2",
  "stackName": "kinda-landing-고유한이름",
  "bucket": "kinda-landing-계정ID-고유한이름",
  "distributionId": "",
  "domainName": "kinda.dfkorealed.com",
  "certificateArn": "실제 us-east-1 ACM 인증서 ARN",
  "hostedZoneId": "",
  "apiOriginDomain": ""
}
```

위 블록은 **입력 위치 설명**이다. 한글 자리표시는 검증을 통과하지 않으므로 그대로 실행하지 않는다. `provision`은 새 전용 stack만 생성하고 기존 stack을 채택하지 않는다. 계정·도메인·인증서, Route 53 모드에서만 zone/기존 레코드 충돌을 확인하고 CloudFormation validate-template과 termination protection을 사용한다. 외부 DNS 모드는 Route 53 API 호출과 활성 Route 53 레코드 생성이 없다. `provision --execute` 응답의 `StackId`는 생성 요청 ID이며 **DNS 목적지가 아니다**. `dns.target: null`은 생성이 완료되지 않아 목적지를 알 수 없다는 뜻이다.

다음 읽기 명령으로 생성 완료를 기다린다. `--profile`을 사용하는 계정이라면 모든 AWS CLI 명령에 동일 profile을 지정한다. 완료 후 출력의 정확한 `DistributionId`를 config의 `distributionId`에 복사한다. `DistributionDomain`은 실제 `d...cloudfront.net` 호스트다. 값을 추측하거나 예시 문자열을 DNS에 넣지 않는다.

```sh
aws sts get-caller-identity
aws cloudformation wait stack-create-complete --stack-name 실제-stackName --region ap-northeast-2
aws cloudformation describe-stacks --stack-name 실제-stackName --region ap-northeast-2 --query 'Stacks[0].Outputs'
node scripts/landing/deploy.mjs check --config .local/landing-aws.json --execute
```

`check` 응답의 `dns`에는 `mode: external`, `recordType: CNAME`, `name: kinda.dfkorealed.com`, 실제 `target: d...cloudfront.net`이 표시된다. 이 시점에는 아직 빈 배포이므로 먼저 첫 `deploy`를 실행한다. 같은 검토 커밋의 `landing` 공개는 **Public Landing Release** 성공과 내려받은 proof를 확인한다. `service` 공개는 canonical CI **quality → unit → postgres-redis-integration → playwright-real-core → build → production-audit** 전체 성공을 확인한다. 도구는 원격 CI를 조회하거나 대신 실행하지 않으며 landing proof/source/artifact는 원격 쓰기 전에 검증한다. 로컬 Node 22 / pnpm 9.15.0과 frozen lockfile로 준비한다. 실제 생성에는 별도의 승인된 provisioning 권한이 필요하며 예시 OIDC 배포 정책은 신규 stack/인증서/DNS 생성 권한을 포함하지 않는다.

```sh
WEB_DEPLOY_MODE=landing node scripts/landing/deploy.mjs deploy --config .local/landing-aws.json --release 20261012-landing-r1 --execute
```

배포가 끝나면 호스팅케이알의 같은 **DNS 레코드 관리 → 새 DNS 레코드 추가**에서 `kinda.dfkorealed.com` 연결용 **별도 CNAME**을 입력한다. 이름은 `kinda`, 값은 **성공한 `check` 또는 `deploy` 응답의 정확한 `dns.target`** (`d...cloudfront.net`)이다. ACM 검증용 `_token.kinda` CNAME과 역할이 다르므로 둘 다 유지한다. 값에는 `https://`, `/`, 임의 IP 또는 `kinda.dfkorealed.com` 자체를 넣지 않는다. 기존 같은 이름의 레코드가 있으면 소유·용도를 확인한 뒤 운영자가 충돌을 해결한다. [호스팅케이알 CNAME 등록](https://help.hosting.kr/hc/ko/articles/5694434421529), [CloudFront CNAME 요구사항](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html).

```sh
dig +short CNAME kinda.dfkorealed.com
WEB_DEPLOY_MODE=landing node scripts/landing/smoke.mjs https://kinda.dfkorealed.com
```

DNS 반영 전에는 `https://실제-DistributionDomain`으로 smoke를 읽기 전용 실행할 수 있다. DNS가 실제 목적지로 해석되는지, HTTPS 인증서가 맞는지, 공개 세 경로와 `/login`·`/api` 차단이 맞는지 확인한다. DNS 전파와 CloudFront edge 전파에는 시간이 걸릴 수 있다. landing을 갱신하거나 같은 모드/다른 모드로 rollback할 때도 응답의 `dns.target`을 확인하며, 같은 distribution을 유지하는 한 CNAME 목적지는 그대로다.

```sh
node scripts/landing/deploy.mjs check --config .local/landing-aws.json --execute
```

check/deploy/rollback은 계정, stack ARN/tag/안정 상태/출력과 현재 DNS 소유권 parameter, 인증서 ISSUED/SAN, expected bucket owner, Public Access Block, BucketOwnerEnforced, CloudFront ARN·실제 `DistributionDomain`·alias/인증서·S3 origin·OAC 서명과 선택적 API origin을 검사한다. 기존 Route 53 관리 stack에서 `hostedZoneId`를 빈 값으로 바꾸거나 기본 주소 stack에 새 도메인을 붙이는 변경은 기존 레코드 삭제/전환을 막기 위해 원격 쓰기 전에 실패한다. 별도 검토된 이전 절차가 필요하다. 이전 v1 archive는 모드·바이트 계약이 없으므로 새 도구가 롤백하지 않는다. 검토된 소스로 새 v2 릴리스를 먼저 만든다.

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

`infra/landing/oidc-policy.example.json`은 정확한 계정·stack·bucket·distribution·OAC·Function과 protected GitHub Environment를 넣는 검토 템플릿이다. trust의 aud/sub를 고정한다. 배포 역할은 해당 stack 갱신, 해당 distribution/Function 갱신·게시·invalidation, 해당 S3 경로 읽기/쓰기와 lock 하나 삭제, 기존 bucket policy 갱신을 포함한다. 사용자 도메인을 쓰면 외부 DNS/Route 53 방식 모두 `check`·`deploy`·`rollback`에서 ACM 인증서를 다시 확인하므로, `EXACT_CERTIFICATE_ID`를 config의 `certificateArn`에 있는 ID로 바꿔 **같은 계정의 해당 `us-east-1` 인증서 하나에 대한 `acm:DescribeCertificate` 읽기 권한**을 배포 역할에 부여해야 한다. 기본 CloudFront 도메인만 쓰는 역할에는 이 ACM 권한 항목이 필요 없다. [AWS ACM API 권한 표](https://docs.aws.amazon.com/acm/latest/userguide/authen-apipermissions.html). ValidateTemplate은 AWS가 resource scoping을 지원하지 않아 Resource `*`가 필요하다. 새 stack/인증서/DNS/역할 생성 권한은 제공하지 않는다. 최초 `provision`은 별도 승인된 생성 권한으로 수행한다. OIDC workflow나 권한을 실제 생성하지 않았다.

전체 `service` 공개는 기존 canonical CI **quality → unit → postgres-redis-integration → playwright-real-core → build → production-audit**와 동일 검토 커밋을 배포 전 필수 확인한다. 사용자 승인 범위인 `landing` 공개는 별도 **Public Landing Release**의 동일 SHA 성공과 source/artifact-bound proof를 필수 확인한다. 도구는 원격 CI 성공을 자동 조회하지 않으며 좁은 로컬 결과만으로 어느 모드의 CI도 성공으로 표시하지 않는다. 새 배포 workflow를 연결할 때 protected environment·동일 SHA의 해당 CI 성공 확인·frozen toolchain·직렬화를 유지한다.

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
