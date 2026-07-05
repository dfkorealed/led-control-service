# 현장·층 등록 온보딩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 최초 가입 또는 빈 DB 상태에서 사용자가 직접 현장, 층, 게이트웨이를 등록하고 조명 검색을 시작할 수 있게 한다.

**Architecture:** 기존 `Site`, `Floor`, `FloorPlan`, `Gateway` 모델을 우선 활용한다. 백엔드는 인증된 사용자의 조직 범위 안에서만 현장/층/게이트웨이를 생성하고, 웹은 모니터링 empty state와 설정 화면에서 초기 설치 마법사를 제공한다.

**Tech Stack:** NestJS, Prisma, PostgreSQL, React, React Query, TypeScript, Vitest/Jest.

---

## 1. 설계 결정

### 1.1 기본 흐름

층 등록은 게이트웨이 검색 결과에서 자동 생성하지 않는다. 사용자가 현장 구조를 먼저 정의하고, 게이트웨이는 등록된 현장에 연결한다.

```text
최초 로그인
→ 현장 정보 입력
→ 층 일괄 등록
→ 도면은 나중에 등록 가능
→ 게이트웨이 시리얼/이름 등록
→ 층 선택 후 조명 검색 시작
```

### 1.2 게이트웨이 검색의 위치

`각 층의 게이트웨이 검색 후 등록`은 기본 흐름이 아니라 보조 흐름으로 둔다.

- MVP 1: 게이트웨이 이름, 시리얼, 펌웨어 버전을 수동 등록한다.
- MVP 2: 실제 게이트웨이가 heartbeat를 보내면 미등록 게이트웨이 목록에서 claim한다.
- 파일럿: 게이트웨이를 특정 층/구역 커버리지에 연결하는 별도 모델을 검토한다.

현재 DB의 `Gateway`는 `siteId`만 가지고 있고 `floorId`가 없다. MVP 1에서는 한 현장에 게이트웨이 1개 이상을 등록하고, 조명 등록 시 첫 번째 게이트웨이를 사용한다. 층별 게이트웨이 매핑은 실제 장비 배치 기준이 잡힌 뒤 `GatewayCoverage` 같은 별도 테이블로 확장한다.

## 2. 층 등록 시 입력 정보

### 2.1 MVP 필수 입력

| 항목 | DB 매핑 | 예시 | 이유 |
| --- | --- | --- | --- |
| 층 이름 | `Floor.name` | `B2`, `B1`, `1F` | 화면, 조명명 자동 생성, 운영 기준 |
| 층 레벨 | `Floor.level` | `-2`, `-1`, `1` | 정렬, 지하/지상 구분, 통계 기준 |

### 2.2 MVP 권장 입력

| 항목 | DB 매핑 | 예시 | 처리 방식 |
| --- | --- | --- | --- |
| 층 일괄 생성 범위 | `Floor.name`, `Floor.level` | 지하 3층-지상 1층 | UI에서 `B3`, `B2`, `B1`, `1F` 자동 생성 |
| 도면 등록 여부 | `FloorPlan` | 도면 없이 시작 | MVP에서는 선택 사항 |
| 도면 이미지 URL | `FloorPlan.imageUrl` | `/uploads/b2.svg` | 파일 업로드 전까지 URL 또는 기본 placeholder 사용 |
| 도면 기준 크기 | `FloorPlan.width`, `FloorPlan.height` | `1200 x 800` | 좌표계 기준 |

### 2.3 후순위 입력

다음 정보는 실제 운영에 유용하지만 MVP 1에서는 DB 컬럼을 늘리지 않는다.

| 항목 | 이유 | 후속 저장 위치 |
| --- | --- | --- |
| 주차면 수 | 전력/운영 리포트 보조 지표 | `Floor.parkingCapacity` 후보 |
| 층 설명/메모 | 설치 작업자 커뮤니케이션 | `Floor.description` 후보 |
| 구역 이름 | A구역, 출입구, 엘리베이터 홀 | `Zone` 또는 `FixtureGroup` |
| 기본 조명 정격 전력 | 조명 등록 시 기본값 | site 설정 또는 registration form |
| 담당 게이트웨이 | 층별 장비 배치 | `GatewayCoverage` 후보 |

## 3. 목표 파일 구조

- 수정: `apps/api/prisma/schema.prisma` - MVP 1에서는 변경하지 않는다.
- 생성: `apps/api/src/setup/setup.module.ts` - 초기 설치 API module
- 생성: `apps/api/src/setup/setup.controller.ts` - 현장/층/게이트웨이 생성 endpoint
- 생성: `apps/api/src/setup/setup.service.ts` - 조직 범위 검증과 transaction 처리
- 생성: `apps/api/src/setup/setup.service.spec.ts` - 초기 설치 service 테스트
- 수정: `apps/api/src/app.module.ts` - `SetupModule` 등록
- 생성: `apps/web/src/api/setup.ts` - 초기 설치 API client
- 생성: `apps/web/src/features/setup/SetupWizard.tsx` - 현장/층/게이트웨이 등록 마법사
- 생성: `apps/web/src/features/setup/SetupWizard.test.tsx` - 마법사 화면/입력 테스트
- 수정: `apps/web/src/features/monitoring/MonitoringView.tsx` - 빈 현장 상태에서 마법사 표시
- 수정: `apps/web/src/features/settings/SettingsView.tsx` - 설정 화면에서 마법사 재사용
- 수정: `apps/web/src/App.test.tsx` - 최초 설치 흐름 통합 테스트
- 수정: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md` - 현장/층 등록 설계 반영
- 수정: `docs/database-schema.md` - MVP 1에서는 모델 변경 없음, 운영 메모만 반영
- 수정: `docs/lesson_leared.md` - 빈 DB 상태에서 선행 설정이 필요하다는 교훈 보강

## 4. API 계약

### 4.1 초기 설치 요청

Endpoint:

```text
POST /setup/initial-site
```

Request:

```ts
interface InitialSiteSetupRequest {
  siteName: string;
  address: string;
  tariffKwhRate: number;
  floors: Array<{
    name: string;
    level: number;
    floorPlan?: {
      imageUrl: string;
      width: number;
      height: number;
    };
  }>;
  gateway: {
    name: string;
    serialNumber: string;
    firmwareVersion?: string;
  };
}
```

Response는 기존 dashboard와 같은 형태로 반환한다.

Validation:

- `siteName`은 trim 후 1자 이상이어야 한다.
- `tariffKwhRate`는 0보다 커야 한다.
- `floors`는 1개 이상이어야 한다.
- `floors[].name`은 같은 요청 안에서 중복될 수 없다.
- `floors[].level`은 같은 요청 안에서 중복될 수 없다.
- `gateway.serialNumber`는 필수이며 전체 DB에서 중복될 수 없다.
- 이미 조직에 site가 있으면 `400 Bad Request`를 반환한다. 추가 층 등록은 별도 endpoint에서 처리한다.

### 4.2 추가 층 등록

Endpoint:

```text
POST /setup/floors
```

Request:

```ts
interface AddFloorsRequest {
  siteId: string;
  floors: Array<{
    name: string;
    level: number;
    floorPlan?: {
      imageUrl: string;
      width: number;
      height: number;
    };
  }>;
}
```

Validation:

- `siteId`는 로그인 사용자의 조직에 속한 site여야 한다.
- 같은 site 안에서 `name`, `level` 중복을 막는다.

### 4.3 게이트웨이 등록

Endpoint:

```text
POST /setup/gateways
```

Request:

```ts
interface RegisterGatewayRequest {
  siteId: string;
  name: string;
  serialNumber: string;
  firmwareVersion?: string;
}
```

Validation:

- `siteId`는 로그인 사용자의 조직에 속한 site여야 한다.
- `serialNumber`는 전체 DB에서 unique여야 한다.
- `firmwareVersion` 기본값은 `manual-unknown`이다.

## 5. 작업 1: Setup API 테스트 작성

**Files:**

- Create: `apps/api/src/setup/setup.service.spec.ts`

- [ ] **Step 1: 성공 케이스 테스트 작성**

```ts
it("creates the initial site with floors and a gateway for the current organization", async () => {
  prisma.site.count.mockResolvedValue(0);
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  prisma.site.create.mockResolvedValue({
    id: "site-1",
    name: "A 주차장",
    address: "서울시 강남구",
    tariffKwhRate: "160.00"
  });
  prisma.floor.createMany.mockResolvedValue({ count: 2 });
  prisma.gateway.create.mockResolvedValue({
    id: "gateway-1",
    siteId: "site-1",
    name: "B2 게이트웨이",
    serialNumber: "GW-001",
    firmwareVersion: "manual-unknown"
  });
  sitesService.getDefaultDashboard.mockResolvedValue(emptyDashboardWithSite);

  const result = await service.createInitialSite({
    organizationId: "organization-1",
    siteName: "A 주차장",
    address: "서울시 강남구",
    tariffKwhRate: 160,
    floors: [
      { name: "B2", level: -2 },
      { name: "B1", level: -1 }
    ],
    gateway: { name: "B2 게이트웨이", serialNumber: "GW-001" }
  });

  expect(prisma.site.create).toHaveBeenCalledWith({
    data: {
      organizationId: "organization-1",
      name: "A 주차장",
      address: "서울시 강남구",
      tariffKwhRate: "160.00"
    }
  });
  expect(prisma.floor.createMany).toHaveBeenCalledWith({
    data: [
      { siteId: "site-1", name: "B2", level: -2 },
      { siteId: "site-1", name: "B1", level: -1 }
    ]
  });
  expect(prisma.gateway.create).toHaveBeenCalledWith({
    data: {
      siteId: "site-1",
      name: "B2 게이트웨이",
      serialNumber: "GW-001",
      firmwareVersion: "manual-unknown"
    }
  });
  expect(result).toBe(emptyDashboardWithSite);
});
```

- [ ] **Step 2: 실패 케이스 테스트 작성**

```ts
it("rejects initial setup when the organization already has a site", async () => {
  prisma.site.count.mockResolvedValue(1);

  await expect(
    service.createInitialSite({
      organizationId: "organization-1",
      siteName: "A 주차장",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      floors: [{ name: "B2", level: -2 }]
    })
  ).rejects.toThrow("initial site already exists");
});

it("rejects duplicate floor names and levels in the same request", async () => {
  await expect(
    service.createInitialSite({
      organizationId: "organization-1",
      siteName: "A 주차장",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      floors: [
        { name: "B2", level: -2 },
        { name: "B2", level: -1 }
      ]
    })
  ).rejects.toThrow("floor names must be unique");

  await expect(
    service.createInitialSite({
      organizationId: "organization-1",
      siteName: "A 주차장",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      floors: [
        { name: "B2", level: -2 },
        { name: "지하2층", level: -2 }
      ]
    })
  ).rejects.toThrow("floor levels must be unique");
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run:

```bash
pnpm --filter @led-control/api test -- setup.service.spec.ts --runInBand
```

Expected: `Cannot find module './setup.service'`.

## 6. 작업 2: Setup API 구현

**Files:**

- Create: `apps/api/src/setup/setup.service.ts`
- Create: `apps/api/src/setup/setup.controller.ts`
- Create: `apps/api/src/setup/setup.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: service 구현**

```ts
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesService: SitesService
  ) {}

  async createInitialSite(input: CreateInitialSiteInput) {
    this.validateInitialSiteInput(input);
    const existingSiteCount = await this.prisma.site.count({ where: { organizationId: input.organizationId } });
    if (existingSiteCount > 0) throw new BadRequestException("initial site already exists");

    const site = await this.prisma.$transaction(async (tx) => {
      const createdSite = await tx.site.create({
        data: {
          organizationId: input.organizationId,
          name: input.siteName.trim(),
          address: input.address.trim(),
          tariffKwhRate: input.tariffKwhRate.toFixed(2)
        }
      });

      await tx.floor.createMany({
        data: input.floors.map((floor) => ({
          siteId: createdSite.id,
          name: floor.name.trim(),
          level: floor.level
        }))
      });

      for (const floor of input.floors) {
        if (!floor.floorPlan) continue;
        const createdFloor = await tx.floor.findFirstOrThrow({
          where: { siteId: createdSite.id, name: floor.name.trim(), level: floor.level }
        });
        await tx.floorPlan.create({
          data: {
            floorId: createdFloor.id,
            imageUrl: floor.floorPlan.imageUrl,
            width: floor.floorPlan.width,
            height: floor.floorPlan.height
          }
        });
      }

      if (input.gateway) {
        await tx.gateway.create({
          data: {
            siteId: createdSite.id,
            name: input.gateway.name.trim(),
            serialNumber: input.gateway.serialNumber.trim(),
            firmwareVersion: input.gateway.firmwareVersion?.trim() || "manual-unknown"
          }
        });
      }

      return createdSite;
    });

    return this.sitesService.getDefaultDashboard(input.organizationId);
  }
}
```

- [ ] **Step 2: controller 구현**

```ts
@UseGuards(SessionAuthGuard)
@Controller("setup")
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Post("initial-site")
  createInitialSite(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateInitialSiteBody) {
    return this.setupService.createInitialSite({
      organizationId: user.organizationId,
      ...body
    });
  }
}
```

- [ ] **Step 3: module 연결**

```ts
@Module({
  imports: [PrismaModule, AuthModule, SitesModule],
  controllers: [SetupController],
  providers: [SetupService]
})
export class SetupModule {}
```

`AppModule` imports에 `SetupModule`을 추가한다.

- [ ] **Step 4: API 테스트 통과 확인**

Run:

```bash
pnpm --filter @led-control/api test -- setup.service.spec.ts sites.service.spec.ts registration.service.spec.ts --runInBand
```

Expected: all tests pass.

## 7. 작업 3: 웹 API client와 SetupWizard 테스트 작성

**Files:**

- Create: `apps/web/src/api/setup.ts`
- Create: `apps/web/src/features/setup/SetupWizard.test.tsx`

- [ ] **Step 1: API client 계약 작성**

```ts
import { apiPost } from "./client";
import type { Dashboard } from "./queries";

export interface InitialFloorInput {
  name: string;
  level: number;
}

export interface InitialSiteSetupInput {
  siteName: string;
  address: string;
  tariffKwhRate: number;
  floors: InitialFloorInput[];
  gateway: {
    name: string;
    serialNumber: string;
    firmwareVersion?: string;
  };
}

export function createInitialSiteSetup(input: InitialSiteSetupInput) {
  return apiPost<Dashboard>("/setup/initial-site", input);
}
```

- [ ] **Step 2: 마법사 테스트 작성**

```tsx
it("creates basement floors from range inputs and submits setup", async () => {
  const onComplete = vi.fn();
  render(<SetupWizard onComplete={onComplete} />);

  fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "A 주차장" } });
  fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 강남구" } });
  fireEvent.change(screen.getByLabelText("kWh 단가"), { target: { value: "160" } });
  fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }));

  expect(screen.getByDisplayValue("B2")).toBeInTheDocument();
  expect(screen.getByDisplayValue("B1")).toBeInTheDocument();
  expect(screen.getByDisplayValue("1F")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("게이트웨이 이름"), { target: { value: "메인 게이트웨이" } });
  fireEvent.change(screen.getByLabelText("게이트웨이 시리얼"), { target: { value: "GW-001" } });
  fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

  expect(await screen.findByText("초기 설정을 저장했습니다.")).toBeInTheDocument();
  expect(onComplete).toHaveBeenCalled();
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run:

```bash
pnpm --filter @led-control/web test -- SetupWizard.test.tsx
```

Expected: component file not found.

## 8. 작업 4: SetupWizard 구현

**Files:**

- Create: `apps/web/src/features/setup/SetupWizard.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: 기본 state와 자동 층 생성 구현**

```tsx
function buildFloors(basementCount: number, groundCount: number) {
  const basementFloors = Array.from({ length: basementCount }, (_, index) => {
    const level = -(basementCount - index);
    return { name: `B${Math.abs(level)}`, level };
  });
  const groundFloors = Array.from({ length: groundCount }, (_, index) => {
    const level = index + 1;
    return { name: `${level}F`, level };
  });
  return [...basementFloors, ...groundFloors];
}
```

- [ ] **Step 2: 입력 항목 구현**

화면에는 다음 입력을 제공한다.

- 현장명: 필수
- 주소: 필수, 모르면 `미입력` 버튼으로 채움
- kWh 단가: 필수, 기본값 `160`
- 지하 층수: 숫자, 기본값 `2`
- 지상 층수: 숫자, 기본값 `0`
- 층 자동 생성 버튼
- 층 목록 편집: 이름과 level 직접 수정 가능
- 게이트웨이 이름: 선택, 기본값 `메인 게이트웨이`
- 게이트웨이 시리얼: 필수, mock gateway 테스트에서는 `GW-DEMO-001` 권장

- [ ] **Step 3: 저장 mutation 구현**

```tsx
const mutation = useMutation({
  mutationFn: () =>
    createInitialSiteSetup({
      siteName,
      address,
      tariffKwhRate: Number(tariffKwhRate),
      floors,
      gateway: gatewaySerial.trim()
        ? {
            name: gatewayName.trim() || "메인 게이트웨이",
            serialNumber: gatewaySerial.trim()
          }
        : undefined
    }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    onComplete?.();
  }
});
```

- [ ] **Step 4: 테스트 통과 확인**

Run:

```bash
pnpm --filter @led-control/web test -- SetupWizard.test.tsx
```

Expected: pass.

## 9. 작업 5: Monitoring/Settings에 온보딩 연결

**Files:**

- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/settings/SettingsView.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: 빈 현장 통합 테스트 작성**

```tsx
it("shows setup wizard when the user has no site yet and then enables lighting registration", async () => {
  apiState.dashboard = {
    site: { id: "", name: "현장 미등록" },
    summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
    floors: [],
    groups: [],
    gateways: []
  };

  render(<AppWithQueryClient />);

  expect(await screen.findByText("초기 설치 설정")).toBeInTheDocument();
  expect(screen.getByLabelText("현장명")).toBeInTheDocument();
});
```

- [ ] **Step 2: MonitoringView empty state 변경**

`data.site.id === ""`이면 `RegistrationPanel` 대신 `SetupWizard`를 표시한다.

```tsx
if (!data.site.id) {
  return (
    <section className="screen-grid monitoring-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">초기 설정</span>
          <h2>현장과 층을 먼저 등록하세요</h2>
        </div>
      </div>
      <SetupWizard />
    </section>
  );
}
```

- [ ] **Step 3: SettingsView에 동일 마법사 연결**

설정 화면에서는 현장이 없으면 상단에 `SetupWizard`를 표시한다. 현장이 있으면 기존 설정 카드와 `RegistrationPanel`을 유지한다.

- [ ] **Step 4: 테스트 통과 확인**

Run:

```bash
pnpm --filter @led-control/web test -- App.test.tsx SetupWizard.test.tsx
```

Expected: pass.

## 10. 작업 6: 문서 갱신

**Files:**

- Modify: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/lesson_leared.md`

- [ ] **Step 1: 설계 문서에 초기 설치 흐름 추가**

추가할 내용:

```md
### 현장·층 등록 온보딩

최초 가입 후 현장이 없으면 조명 검색보다 먼저 현장, 층, 게이트웨이를 등록한다. 층은 사용자가 직접 이름과 level을 정의하고, 게이트웨이 검색은 층 생성의 기준이 아니라 등록된 현장에 장비를 claim하는 보조 단계로 사용한다.
```

- [ ] **Step 2: DB 문서에 MVP 1 모델 유지 결정 추가**

추가할 내용:

```md
현장·층 온보딩 MVP 1에서는 `Site`, `Floor`, `FloorPlan`, `Gateway` 기존 모델을 그대로 사용한다. 층별 게이트웨이 커버리지, 주차면 수, 층 설명은 실제 파일럿 요구가 확인된 뒤 별도 컬럼 또는 테이블로 분리한다.
```

- [ ] **Step 3: 오답 노트에 선행 설정 순서 기록**

추가할 내용:

```md
조명 등록 기능은 `Site`, `Floor`, `Gateway` 선행 데이터가 없으면 시작할 수 없다. 빈 DB 상태에서는 조명 등록 버튼보다 초기 설치 마법사를 먼저 노출해야 한다.
```

## 11. 작업 7: 전체 검증

**Files:**

- No source changes beyond previous tasks.

- [ ] **Step 1: API 테스트**

Run:

```bash
pnpm --filter @led-control/api test -- setup.service.spec.ts sites.service.spec.ts registration.service.spec.ts --runInBand
```

Expected: all pass.

- [ ] **Step 2: Web 테스트**

Run:

```bash
pnpm --filter @led-control/web test -- App.test.tsx SetupWizard.test.tsx
```

Expected: all pass.

- [ ] **Step 3: Typecheck**

Run:

```bash
pnpm typecheck
```

Expected: all packages pass.

- [ ] **Step 4: 로컬 수동 검증**

현재 빈 DB 상태에서 다음을 확인한다.

```text
1. http://localhost:5173 접속
2. operator@example.com / demo-password-1234 로그인
3. 초기 설치 설정 화면 표시
4. 현장명, 주소, 층 자동 생성, 게이트웨이 시리얼 입력
5. 초기 설정 완료
6. 모니터링 화면에서 등록된 조명이 없습니다 표시
7. 층 이름이 표시되고 조명 검색 시작 버튼이 활성화됨
```

## 12. 자체 검토

- Spec coverage: 현장 생성, 층 등록, 게이트웨이 수동 등록, 조명 등록 선행조건 해소를 모두 포함한다.
- Placeholder scan: 이 문서에는 `TBD`, `TODO`, `적절히 처리` 같은 미정 표현을 사용하지 않는다.
- Type consistency: API request 타입의 `siteName`, `address`, `tariffKwhRate`, `floors`, `gateway` 이름을 웹 client와 백엔드 service에서 동일하게 사용한다.
- Scope check: 도면 파일 업로드, 층별 게이트웨이 커버리지, 실제 게이트웨이 자동 검색은 MVP 1 범위 밖으로 분리했다.

## 13. 현재 구현 상태

2026-07-05 기준으로 다음 항목을 구현했다.

- 백엔드: `SetupModule`을 추가하고 `POST /setup/initial-site`, `POST /setup/floors`, `POST /setup/gateways`를 제공한다.
- 백엔드 검증: 현장명, 주소, 전기요금 단가, 층 이름, 층 level, 도면 크기, 게이트웨이 시리얼을 런타임에서 검증한다.
- 백엔드 동시성: 최초 현장 생성과 추가 층 등록은 Serializable transaction으로 처리하고 transaction 충돌은 `409 Conflict`로 반환한다.
- 웹: `SetupWizard`에서 현장명, 주소, kWh 단가, 지하/지상 층수, 층 이름, 층 level, 필수 게이트웨이 시리얼을 입력한다.
- 웹 진입점: 현장이 없는 dashboard에서는 모니터링/설정 화면에 조명 등록 패널보다 초기 설치 마법사를 먼저 표시한다.
- 웹 검증: 주소 필수, 층수 상한, 무한대/NaN 방지, 층 이름/level 중복 방지, 게이트웨이 시리얼 공백 시 gateway payload 생략을 처리한다.
- Mock API: `/setup/initial-site` 이후 dashboard와 registration session의 site/floor/gateway ID가 서로 맞도록 유지한다.

검증한 명령:

```bash
pnpm --filter @led-control/api test -- setup.service.spec.ts setup.controller.spec.ts --runInBand
pnpm --filter @led-control/web test -- SetupWizard.test.tsx App.test.tsx
pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/web typecheck
```

## 14. Mock 게이트웨이 테스트 절차

Mock 게이트웨이로 초기 설치 이후 조명 등록 흐름을 테스트할 때는 다음 순서로 진행한다.

1. API와 웹을 실행한다.

```bash
pnpm --filter @led-control/api dev
pnpm --filter @led-control/web dev
```

2. 웹에서 로그인 후 초기 설치 마법사를 완료한다.

- 현장명과 주소를 입력한다.
- 지하/지상 층수를 입력한 뒤 `층 자동 생성`을 누른다.
- Mock 게이트웨이 heartbeat와 맞추려면 게이트웨이 시리얼은 `GW-DEMO-001`로 입력한다.
- 저장 후 모니터링 화면에서 `등록된 조명이 없습니다`와 `조명 검색 시작` 버튼이 보이는지 확인한다.

3. DB에서 생성된 site ID를 확인한다.

```sql
SELECT id, name FROM "Site" ORDER BY "createdAt" DESC;
SELECT id, name, "serialNumber" FROM "Gateway" ORDER BY "createdAt" DESC;
```

4. Mock 게이트웨이를 해당 site ID로 실행한다.

```bash
MOCK_SITE_ID=<생성된_SITE_ID> \
MOCK_DISCOVERED_NODE_COUNT=4 \
MOCK_REGISTRATION_FLOOR_NAME=B2 \
pnpm --filter @led-control/mock-gateway dev
```

5. 웹에서 `조명 검색 시작`을 누른다.

- API가 MQTT로 provisioning scan 명령을 발행한다.
- Mock 게이트웨이가 미등록 노드 발견 이벤트를 발행한다.
- 웹 등록 패널에 `LC-B2-001` 같은 후보 조명이 표시되는지 확인한다.
- `점멸 확인`, `등록`, `등록 세션 완료` 순서로 동작을 확인한다.

6. 등록된 fixture 상태 이벤트까지 테스트하려면 fixture ID를 조회한 뒤 mock gateway에 전달한다.

```sql
SELECT id, name FROM "Fixture" ORDER BY "createdAt" DESC;
```

```bash
MOCK_SITE_ID=<생성된_SITE_ID> \
MOCK_FIXTURE_IDS=<FIXTURE_ID_1>,<FIXTURE_ID_2> \
pnpm --filter @led-control/mock-gateway dev
```

DB를 초기화한 뒤에는 과거 `MOCK_FIXTURE_IDS`를 그대로 쓰지 않는다. 삭제된 fixture ID 이벤트가 들어와도 API는 죽지 않게 방어하지만, 테스트 결과가 헷갈릴 수 있으므로 mock gateway를 재시작하면서 현재 DB의 ID로 맞춘다.
