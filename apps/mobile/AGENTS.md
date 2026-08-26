# 모바일 작업 규칙

## 소유 역할과 범위

- 담당 역할은 `mobile`이다.
- 기본 수정 범위는 `apps/mobile`이다. React Native 셸, WebView 연동, 모바일 인증, 권한과 네이티브 경계를 소유한다.
- PC 웹 우선과 WebView 재사용 원칙을 유지하고, 네이티브 구현은 WebView로 충족할 수 없는 기능에 한정한다.

## 공유 계약

- 웹 URL·메시지 브리지, `packages/shared`, API, 인증과 DB 스키마는 공유 계약이다.
- 공유 계약을 직접 변경하지 않는다. 총괄 승인 후 소유 역할이 먼저 변경하고 검증하면 모바일을 순차 적용한다.

## 검증

저장소 루트에서 다음 명령을 실행한다.

```bash
pnpm --filter @led-control/mobile typecheck
pnpm --filter @led-control/mobile test
```

네이티브 권한이나 WebView 브리지가 바뀌면 지원 플랫폼의 수동 재현 절차와 결과도 기록한다.

## 문서

- 메뉴 기능 변경과 같은 작업에서 영향받는 `docs/menus/*.md`를 갱신한다.
- 모바일에서 확인하지 않은 웹 동작을 모바일 검증 완료로 기록하지 않는다.
- DB 구조 변경이 필요하면 `backend`에 요청한다.
