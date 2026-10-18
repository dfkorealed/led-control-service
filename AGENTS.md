# 프로젝트 에이전트 운영 규칙

작업을 시작하기 전에 이 파일과 작업 대상 경로에서 가장 가까운 `AGENTS.md`, `docs/agent-operations.md`, `docs/project-status.md`를 읽는다. 하위 `AGENTS.md`는 해당 디렉터리에서 이 파일의 규칙을 보완하며, 충돌할 경우 더 구체적인 하위 규칙을 따른다.

## 역할 라우팅

| 작업 | 담당 역할 | 기본 소유 범위 |
| --- | --- | --- |
| 요구사항 분해, 공유 계약 승인, 결과 통합 | 총괄 | 저장소 전체 조율 |
| 사용자 흐름, 화면 명세, 디자인 토큰, 접근성 | `designer` | `docs`, 합의된 웹 디자인 토큰 |
| React 웹, 상태 관리, 브라우저 사용자 흐름 | `web_frontend` | `apps/web` |
| React Native, WebView, 모바일 권한과 인증 | `mobile` | `apps/mobile` |
| NestJS, PostgreSQL, Redis, 서버 MQTT 계약 | `backend` | `apps/api` |
| Raspberry Pi, Docker, BlueZ, MQTT, 장비 인증 | `gateway` | `apps/gateway`, 합의된 `infra` 일부 |
| ESP-IDF, BLE Mesh, PWM, Health, OTA | `firmware` | `apps/esp32-h2-firmware` |
| 요구사항, 회귀, 테스트 증거, 문서 일치 검토 | `qa_reviewer` | 저장소 전체 읽기 전용 검토 |

## Sub-Agent Delegation Rules

- 단일 파일 수정, 유닛 테스트 작성, 단순 코드 리뷰, 린트 오류 수정 등 5분 이내에 끝낼 수 있는 **독립적인 작업**은 직접 처리하지 않고 해당 소유 역할의 서브에이전트 하나에 위임한다.
- 작고 독립적인 작업마다 담당 역할 에이전트 하나만 사용한다. 같은 결과를 만들기 위한 중복 에이전트를 생성하지 않는다.
- 같은 파일, 공유 계약, 선후 관계가 있는 작업 또는 긴밀히 결합된 작업은 병렬화하지 않는다. 총괄이 한 담당 역할에 순차적으로 배정하고 결과를 통합한 뒤 다음 역할로 넘긴다.
- 서로 다른 소유 디렉터리에서 독립적으로 완료하고 검증할 수 있는 작업만 병렬 실행한다.
- 메인 에이전트는 오케스트레이터 역할에 집중하며, 범위와 완료 조건을 전달하고 결과, 검증 증거, 미해결 사항을 취합한다.
- 작업 중 필요하다고 판단되는 경우 이 파일을 직접 갱신할 수 있다. 규칙 변경도 검토와 커밋 대상이다.

## 공유 경계와 변경 순서

- `packages/shared`, Prisma 스키마와 migration, 공통 API 및 MQTT 계약, 장비 식별자, 인증서 계약, 공통 배포 인프라는 공유 경계다.
- 공유 경계 변경 전 총괄 승인을 받고 영향받는 역할과 호환성 및 적용 순서를 확정한다.
- 총괄이 지정한 한 역할만 공유 경계를 먼저 변경하고 검증한다. 소비하는 앱, 게이트웨이, 펌웨어 변경은 그 커밋 뒤에 순차적으로 진행한다.
- 소유 범위 밖 파일을 임의로 수정하지 않는다. 필요한 변경은 총괄에게 알리고 해당 역할에 배정한다.
- 실제 장비 flash, 자격 증명 주입·발급·폐기, OTA, Raspberry Pi 배포, DB 초기화와 운영 환경 변경은 사용자 승인 관문을 통과한 뒤 실행한다.

## 진행 상태 관리

- `docs/project-status.md`는 현재 상태 요약의 정본이다.
- 활성 `writing-plans` 체크리스트는 현재 작업의 세부 실행 상태를 기록한다.
- 활성 체크리스트가 있는 작업은 시작, 완료, 보류 상태를 `docs/project-status.md`와 체크리스트에 동시에 반영하고 서로 다르게 남기지 않는다.
- 담당 역할은 검증 결과와 남은 위험을 총괄에게 보고하고, 총괄이 두 기록을 갱신한다.

## Coding GuideLines

### 공통

- 모든 코드는 재사용 가능하며 반복적이지 않고 가독성이 좋도록 항상 유지한다.
- 예외 사항 및 일반적인 경우를 따르지 않는 로직은 주석을 통해 상세하게 명시한다.

### Frontend

- 버튼, 카드 같은 재사용 가능한 컴포넌트는 공통 컴포넌트로 분리하고 하나의 폴더에 모은다.

### Backend

- DB 스키마 및 구조가 변경되면 `docs/database-schema.md`를 같은 작업에서 갱신한다.

## Documentation Update Rules

### 메뉴별 기능 현황 문서

- 페이지 또는 메뉴 기능을 구현, 수정, 삭제할 때는 반드시 해당 메뉴의 기능 현황 문서를 같은 작업 안에서 최신화한다.
- 메뉴별 문서는 `docs/menus` 하위에 유지한다.
  - 모니터링: `docs/menus/monitoring.md`
  - 제어: `docs/menus/control.md`
  - 통계: `docs/menus/statistics.md`
  - 설정: `docs/menus/settings.md`
  - 공개 랜딩: `docs/menus/landing.md`
  - 주요 기능: `docs/menus/features.md`
  - 요금제: `docs/menus/pricing.md`
  - 운영자 상담 문의: `docs/menus/operator.md`
- 각 메뉴 문서는 `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구성을 유지한다.
- 기능이 여러 메뉴에 걸쳐 있으면 영향을 받는 모든 메뉴 문서를 갱신한다. 예를 들어 조명 등록은 설정 메뉴와 모니터링 빈 상태에 모두 영향을 줄 수 있다.
- 임시 구현, mock 전용 구현, 실제 하드웨어 연동 전 구현은 완료 기능으로만 적지 않고 한계와 후속 작업을 함께 기록한다.
- 새 메뉴가 추가되면 `docs/menus/{menu-name}.md` 파일을 만들고 이 목록에도 추가한다.
- 반복 가능한 실패와 예방책은 `docs/lesson_leared.md`에 누적한다.

<!-- BEGIN AWS Agent Toolkit rules -->
## AWS Agent Toolkit project configuration

- AWS CLI profile: `kinda`. Use `--profile kinda` for this project's AWS CLI commands.
- Selected project Region: `ap-southeast-2`.
- The Agent Toolkit catalog and AWS MCP service use `us-east-1`; this does not change the Region for application resources.
- Installing the toolkit does not authorize resource deployment, billing changes, or destructive AWS operations.

# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion
<!-- END AWS Agent Toolkit rules -->
