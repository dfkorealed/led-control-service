# API 작업 규칙

## 소유 역할과 범위

- 담당 역할은 `backend`다.
- 기본 수정 범위는 `apps/api`다. NestJS API, PostgreSQL, Prisma, Redis와 서버 측 MQTT 계약을 소유한다.
- `packages/shared`와 다른 앱 디렉터리는 공유 또는 타 역할 소유 범위이므로 총괄 승인 없이 수정하지 않는다.

## 공유 계약

- Prisma 스키마와 migration, API DTO, MQTT topic·payload, 인증 및 권한 계약은 공유 경계다.
- 변경 전 총괄 승인과 영향 역할 검토를 받고, 백엔드 계약을 먼저 구현·검증한 뒤 소비 역할이 순차 적용하도록 변경 내용을 전달한다.
- 기존 migration을 다시 쓰지 않고 새 migration으로 변경 이력을 남긴다.

## 검증

저장소 루트에서 다음 명령을 실행한다.

```bash
pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/api test
pnpm --filter @led-control/api build
```

Prisma 스키마를 변경하면 migration을 생성·검토하고 클라이언트를 갱신한다.

```bash
pnpm --filter @led-control/api prisma:migrate
pnpm --filter @led-control/api prisma:generate
```

## 문서

- DB 스키마 또는 migration 변경과 같은 작업에서 `docs/database-schema.md`를 갱신한다.
- 메뉴 기능에 영향을 주면 관련 `docs/menus/*.md`도 같은 작업에서 갱신한다.
- 실제 migration 실행 여부와 테스트 DB에서만 확인한 결과를 구분해 기록한다.
