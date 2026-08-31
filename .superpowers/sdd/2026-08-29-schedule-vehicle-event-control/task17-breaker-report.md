# Task 17 Breaker 보고서

기준일: 2026-08-31

## Finding과 수정 범위

- Fix Round 5의 colon/backslash, drive-relative, ADS, UNC/device prefix와 terminal dot/space 거부는 유지했다.
- 남은 breaker는 POSIX host에서 `CON`, `con.txt`, nested `PRN`, `COM1.log`, `LPT9.txt` 같은 Windows reserved device basename을 portable artifact path로 수락해 manifest-owned cleanup을 시작할 수 있다는 점이었다.
- `packages/shared/scripts/build.mjs`의 중앙 `validateGeneratedPath()`만 보강했다. 모든 segment에서 terminal dot/space를 제거한 문자열의 첫 `.` 앞 stem을 대문자로 바꿔 `CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]`와 일치하면 거부한다.
- Generated file 수집, metadata 생성, preflight, manifest read/write, cleanup, copy와 output inspection은 계속 이 validator를 공통으로 사용한다.

## TDD RED와 GREEN

- 먼저 `packages/shared/src/package-exports.test.ts`에 예약 path 표와 비예약 대조군, generated nested artifact fixture를 추가했다.
- 기존 `76a33ab`에서는 focused 58건 중 예약 manifest 28건과 generated `nested/COM1.log` 1건이 build 성공으로 수락돼 29건이 기대한 이유로 실패했다. 기존 29건과 비예약 대조군은 통과했다.
- 수정 뒤 focused 58/58이 통과했다. Root/nested segment, 대소문자, extension과 `COM1..COM9`, `LPT1..LPT9` 전체를 거부했다.
- `console`, `con1`, `com0`, `com10`, `lpt0`, `lpt10`, `null`, `auxiliary`는 정상 수락해 과잉 거부를 막았다.
- 예약 manifest와 generated artifact 거부 시 기존 manifest-owned `existing.js`, unrelated `user-kept.txt`, 외부 sentinel이 모두 변경되지 않았다.

## 전체 검증

- Shared focused: 1파일 58/58 통과
- Shared full: 8파일 133/133 통과
- Shared build/typecheck: 통과
- Packed isolated consumer: 실제 `pnpm pack` archive의 root/subpath ESM·CJS import와 `safeParse`, declaration 및 ESM metadata 확인 통과
- Web focused: 5파일 80/80 통과
- Web full: 32파일 334/334 통과
- Web typecheck/lint/build: 통과
- Web bundle audit: main `1,028.66 kB / gzip 313.70 kB`, schedule `76.11 kB / gzip 20.12 kB`; 기존 500 kB Vite warning은 유지되지만 audit 상한 통과
- API: typecheck/build, CommonJS root/narrow import와 built main syntax smoke 통과
- Gateway: typecheck/build, ESM-to-CJS root/narrow import와 output syntax smoke 통과; bundle `504.9 kB`
- `git diff --check 76a33ab`: 통과

## 남은 범위

- Fix Round 4에서 문서화한 적대적 concurrent parent-swap TOCTOU 제한은 변경되지 않았다. 현재 local sequential build threat model과 mutation 직전 재검증을 유지한다.
- Production API/Gateway Chromium E2E와 실제 Raspberry Pi/BlueZ/ESP32-H2 RF HIL은 build path 수정 범위에서 실행하지 않았다.
