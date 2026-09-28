# 공개 랜딩 메뉴 기능 현황

기준일: 2026-09-28

## 구현 완료

- 2026-09-28 UI 정책 전환 Task 5: 다섯 장면의 공통 틀과 모니터링·제어 예시를 승인 유틸리티, 공통 Button/Card, 네이티브 RangeSlider 소유 스타일로 옮겼다. 모니터링·제어는 다시 보기 때 버튼/input DOM을 유지해 키보드 포커스를 보존하고 장식 커서만 재시작한다. Scene observer·타이머·재생 길이, 조명 선택·밝기 자동15→70%·수동 조정/적용, reduced motion 완료 상태를 유지한다. 통계·보고서·맵 예시의 내부 전환은 후속 단계이며 실제 장비 명령이나 API 동작 변경은 없다.

- 공통 공개 헤더·회사 푸터·상담 팝업을 승인된 유틸리티와 공통 Button·LinkButton·Card 변형으로 전환했다. 320·390·1024·1440px의 기존 배치·글자·팝업 스크롤/포커스 복귀 및 `/login`의 401 로그인 화면 계산 스타일을 비교했다. 팝업 모서리는 원래 CSS 우선순위로 표시되던14px을 보존한다.
- `LandingStory`가 기존 다섯 장면과 상담 callback을 공유하고 `site`/`concept` 시각 인자를 받는다. 현재 `/`는 `site`를 사용한다. 히어로 애니메이션의 재진입·순서·지연과 reduced-motion 정지 상태를 유지한다. 재진입은 애니메이션 클래스만 다시 적용하므로 상담 버튼·CTA의 DOM과 키보드 포커스도 유지한다. 정적 시안 경로의 React 통합은 후속이다.

- `/`, `/features`, `/pricing`은 로그인 없이 여는 공개 페이지다. 세 경로 모두 인증 상태를 조회하지 않고, 공통 고정 헤더·회사 푸터·상담 팝업을 사용한다. 헤더의 `주요 기능`과 `요금제`는 각각 독립 경로로 이동하며 `/login`은 기존 로그인 화면을 연다.
- `/`는 승인된 **현장의 하루** 시안을 React 컴포넌트로 제공한다. 네이비 히어로, 화면 높이에 맞춘 모니터링·제어·통계 그래프·보고서·맵 편집 5개 장면, 마지막 상담 유도 영역을 포함한다. 히어로 보조 문장의 두 번째 문장은 별도 줄에 두고 상담 버튼의 평상시 테두리를 제거했다.
- `/features`는 모니터링·제어·통계·맵 편집을 네 개의 큰 상세 구획으로 설명한다. 각 기능은 3단계 사용 흐름, 운영 이점, 기존 관제 장면을 닮은 추상 화면과 홈의 예시 장면 링크를 갖는다. 통계에는 상태 기반 추정 전력 그래프와 PDF·XLSX 보고서 흐름을 함께 안내한다. 직접 해시 진입에서도 상세 구획이 고정 헤더 아래 표시된다.
- `/pricing`은 Basic 월 99,000원(기본 기능·로그 3개월·보고서 월 10회)과 Plus 월 199,000원(기본 기능·로그 1년·보고서 무제한·상담 시 안내할 AI 기능)을 비교한다. 요금 카드의 CTA는 기존 상담 팝업을 열고 선택한 요금제를 보여준다. 문의 내용에 편집 가능한 상담 문장을 제공하고 제출 시 선택 요금제를 기존 API `message` 앞에 덧붙여 사용자가 문장을 바꿔도 선택 정보가 유지된다. 일반 상담과 이전 `#contact` 북마크는 빈 문장으로 시작한다. 팝업을 닫으면 카드로 포커스가 돌아온다. 가격은 월 기준 안내이고 부가세·계약 조건·상품 적용 범위는 상담에서 확인한다.
- 세 공개 페이지의 푸터는 회사 홈페이지 소스의 (주)디에프코리아 전화 032-528-2953, 팩스 032-551-2954, 메일 kjukym@dfkorealed.com, 인천광역시 부평구 평천로 199번길 53 A동 2층과 실제 회사 페이지 링크를 제공한다. 기존 예시 데이터 고지는 유지한다.
- 다섯 장면의 예시 화면은 조명 선택, 밝기 조정/적용, 그래프 그리기, PDF·XLSX 보고서 형식 선택, 도면 위 조명 배치·이동을 보여준다. 예시는 React 상태로 조작하며 관제 API·장비·저장소를 호출하지 않는다. 각 장면에 예시 데이터와 실제 동작의 차이를 고지한다. CSV는 생성 이력형 보고서가 아닌 별도 즉시 내보내기이므로 보고서 장면에 표시하지 않는다.
- 맵 배치 재생의 시작점·드래그 고스트는 React ref로 참조한다. 조명 선택·이동과 보고서 형식 버튼의 태그·클래스·동작은 그대로 유지한다.
- 히어로와 장면은 화면에 다시 들어올 때 애니메이션을 재생하고, 각 예시의 다시 보기 버튼으로 반복할 수 있다. 장면이 화면을 떠나면 타이머·프레임·효과를 정리하며, 축소 동작 설정에서는 최종 상태를 즉시 표시한다.
- 헤더·히어로·마지막 장면의 도입 상담 버튼은 현재 페이지의 팝업을 연다. 오래된 `/#contact` 진입도 같은 팝업으로 연결하고 주소의 낡은 앵커를 지운다. 팝업은 공통 `ModalDialog`와 기존 `InquiryForm`을 재사용한다.
- 상담 양식은 회사명·담당자·회신 이메일·문의 내용·개인정보 동의를 필수로, 전화번호·고객 유형을 선택으로 받으며 고객 유형의 빈 선택은 `선택해 주세요`로 표시한다. 동의 안내에 목적·항목·90일 보관·거부 시 온라인 접수 제한·NAVER WORKS 메일 사본 정책을 표시한다. 필드와 4KB 본문을 검사하고 중복 제출을 막는다.
- 공개 API는 동의 버전 `landing-2026-09-v1-90d`, honeypot, IP당 15분 5회 제한, 정규화된 내용의 UUID 멱등 키, DB 트랜잭션 저장을 적용한다. HTTP 201과 접수번호는 **서버 접수**를 뜻한다. 동일 요청을 응답 유실 후 재시도하면 같은 접수번호를 반환하고, 같은 키에 다른 내용이면 409다.
- Production은 인증된 Web nginx가 덮어쓴 실제 방문자 IP로 요청량을 분리하며, 장비용 TLS 포트를 통한 직접·위조 문의는 503으로 거부한다. 필수 ingress 비밀과 서버 전용 선택 메일 설정은 [운영 절차](../runbooks/landing-mail-setup.md)를 따른다.
- 오류 시 입력을 보존한다. 429는 잠시 후 재시도를, 메일 연결 미준비·명시적 자격 증명 거부·ingress 검증 실패의 503은 직접 이메일 문의 링크를 안내한다. 네트워크 오류/타임아웃 뒤 내용이 같으면 같은 멱등 키로 재시도한다.
- 랜딩/양식의 자동 검증에는 홈의 320·390·1024·1440px와 새 공개 페이지의 320·390px 가로 넘침, 팝업 크기·스크롤, 키보드 접근, 축소 동작, 접근성 검사, 세 공개 경로의 인증 비호출·직접 진입·새로고침·뒤로가기가 포함된다.

## 미구현

- 파일 첨부와 랜딩에서의 계정 생성은 제공하지 않는다.
- 공개 화면에서 실제 고객 현장 데이터를 조회하거나 제어하는 체험 기능은 제공하지 않는다. 대시보드의 조명·명령·전력 수치는 모두 이해를 돕는 예시다.
- 상품별 과금, 계정별 로그 보존 기간·월별 보고서 생성 횟수 집행, AI 기능 제공은 현재 공개 페이지 구현 범위에 포함되지 않는다. [요금제 페이지](pricing.md)는 구매 전 상담 안내다.

## 부족하거나 개선이 필요한 기능

- Task 5의 Chromium 검증은 네 너비(320·390·1024·1440px), 세 포함 경계의 양쪽, 키보드·터치·재생 취소와 밝기 채움을 대상으로 한다. NativeRangeSlider의 두 동적 색 경계는 원본 네 stop gradient와24개 초기 렌더 비교에서 일치했다. 실제 하드웨어·다른 브라우저 검증은 아니다. 통계·보고서·맵 및 정적 시안 CSS가 남아 전체 UI 정책0건은 아직 달성하지 않았다.

- 이번 공개 스타일 전환의 소프트웨어 검증은 집중104개, Web 전체2,577개 통과(3개 환경 조건 제외), Chromium37개 및 hover 회귀1개와 typecheck/build다. 4경로×4너비의124개 기준 PNG에서 실제 레이아웃 차이를 수정했으며 남은 미세 색상/래스터 차이를 분류했다. 정책은 아직695건으로 실패하며 미전환 기능·데모·정적 시안 CSS가 남는다. 이 결과는 실장비·배포 검증이나 모든 브라우저의 동일성을 뜻하지 않는다.

- 웹 UI 정책의 현재 잔여 위반은 **695건**이다. 실제 사용 중인 [field-day.css](../../apps/web/src/features/landing/field-day.css)의 **690건**, 공개 레이아웃의 CSS import **1건**, 맵·모니터링·보고서 예시의 직접 폼 스타일 **3건**, 정적 시안 CSS **1건**이 남는다. 필요한 의미 기반 토큰과 반응형 계약은 승인됐고 공개 헤더·히어로·문의·푸터 전환을 완료했다. 기능·요금제 페이지, 장면·데모 및 정적 시안의 전환은 후속 작업이며, 남은 소비자가 사용하는 공통 CSS 규칙은 해당 전환까지 유지한다. 정책 목표는 **0건**이고 zero baseline과 검사 규칙을 우회하지 않는다. `ui:check`와 `test:ui-policy`의 생산 UI 무위반 단언은 이 잔여 위반이 있는 동안 실패한다.
- 검토용 정적 시안: [비교 갤러리](../../apps/web/public/concepts/index.html)에서 [기존 밝은 분할형](../../apps/web/public/concepts/toss-inspired-landing.html), [관제실](../../apps/web/public/concepts/control-room.html), [에디토리얼](../../apps/web/public/concepts/editorial.html), [현장의 하루](../../apps/web/public/concepts/field-day.html)를 비교할 수 있다. 네 페이지의 관제 장면은 예시 데이터로 만든 독립 HTML이며 네 번째 시안의 구성과 기능 흐름을 React 공개 `/`로 옮겼다.
- 네 번째 [**현장의 하루** 정적 시안](../../apps/web/public/concepts/field-day.html)은 적용 전 비교 기록이다. React 화면의 디자인 색상은 [웹 디자인 토큰](../../apps/web/src/styles/theme.css)을 참조한다. 정적 시안과 실제 `/`는 예시 조작을 실제 관제 API·장비·저장소에 반영하지 않는다. 상담 팝업은 필수/선택 필드·90일 고지·4KB 검사·동일 문의 UUID 재시도·15초 제한·503 이메일 대체 동선을 기존 `InquiryForm`의 `/api/landing/inquiries` 제출로 제공한다. 201 응답과 접수번호는 서버 접수만 뜻하고 실제 메일 발송은 보증하지 않는다. 별도의 [이전 색상 검토본](../../apps/web/public/concepts/field-day-design-system.html)은 이전 검토 기록이다.
- 토스의 메시지 전개 방식을 참고한 [랜딩 방향 예시](../../apps/web/public/concepts/toss-inspired-landing.html)와 [개편 계획](../superpowers/plans/2026-09-26-toss-inspired-kinda-landing.md)을 별도로 만들었다. 이 정적 예시는 디자인 검토용이며 현재 `/`의 구현·상담 API에는 반영되지 않았다. 영상은 사용하지 않는다.
- 실제 NAVER WORKS OAuth 승인, 메일 발송 및 받은편지함 도착은 운영 자격 증명과 배포 환경에서 아직 확인하지 않았다. 201 접수는 이메일 수신을 보증하지 않는다. 운영 설정과 검증 순서는 [메일 연결 운영 절차](../runbooks/landing-mail-setup.md)를 따른다.
- 브라우저의 제출 시나리오는 API 응답 대역을 사용했다. 실제 배포 브라우저에서 API·메일·운영자 확인까지의 전체 여정은 별도 점검이 필요하다.
- 네 번째 정적 시안의 팝업 역시 모의 API 응답으로만 제출 성공·오류 경로를 검증했다. 현재 로컬 API와 NAVER WORKS 설정이 준비되지 않아 실제 접수·메일 수신을 확인하지 않았다.
- 랜딩은 확인되지 않은 절감률·고객 사례·실시간 알림·도입 기간·호환성을 약속하지 않는다. CAD 후보는 검토 후 배치에 적용하는 흐름이며 자동 조명 등록을 뜻하지 않는다. 전력은 계측값이나 절감 보장이 아닌 상태 기반 추정치다.
- 가격에 따른 부가세·계약 단위·기능 적용 정책과 Plus AI 기능의 제공 상태는 상담에서 확인해야 한다. 페이지의 Basic/Plus 구성은 현재 서비스의 실제 사용 한도 집행이나 AI 기능 가동을 증명하지 않는다.

## 관련 파일

- 화면: [공개 경로](../../apps/web/src/main.tsx), [공통 공개 레이아웃](../../apps/web/src/features/landing/PublicSiteLayout.tsx), [홈 랜딩](../../apps/web/src/features/landing/LandingPage.tsx), [기능 페이지](../../apps/web/src/features/landing/FeaturesPage.tsx), [기능 상세](../../apps/web/src/features/landing/field-day/FeatureOverview.tsx), [요금 페이지](../../apps/web/src/features/landing/PricingPage.tsx), [요금 안내](../../apps/web/src/features/landing/field-day/PricingSection.tsx), [회사 푸터](../../apps/web/src/features/landing/field-day/CompanyFooter.tsx), [공통 장면/데모 틀](../../apps/web/src/features/landing/field-day/Scene.tsx), [모니터링 예시](../../apps/web/src/features/landing/field-day/MonitoringDemo.tsx), [제어 예시](../../apps/web/src/features/landing/field-day/ControlDemo.tsx), [공통 네이티브 슬라이더](../../apps/web/src/components/ui/fields/NativeRangeSlider.tsx), [맵 예시](../../apps/web/src/features/landing/field-day/MapDemo.tsx), [랜딩 CSS](../../apps/web/src/features/landing/field-day.css), [상담 양식](../../apps/web/src/features/landing/InquiryForm.tsx), [웹 API 어댑터](../../apps/web/src/api/landing-inquiries.ts)
- 정적 시안: [현장의 하루](../../apps/web/public/concepts/field-day.html), [스타일](../../apps/web/public/concepts/field-day.css), [인터랙션](../../apps/web/public/concepts/field-day.js), [비교 갤러리](../../apps/web/public/concepts/index.html)
- API: [접수 컨트롤러](../../apps/api/src/landing-inquiries/landing-inquiries.controller.ts), [접수 서비스](../../apps/api/src/landing-inquiries/landing-inquiries.service.ts), [DTO](../../apps/api/src/landing-inquiries/landing-inquiry.dto.ts), [요청 제한](../../apps/api/src/landing-inquiries/landing-inquiry-rate-limit.service.ts), [DB 스키마](../database-schema.md)
- 검증: [랜딩 브라우저 테스트](../../apps/web/e2e/landing.spec.ts), [공개 페이지·장면 조작 테스트](../../apps/web/e2e/landing-field-day.spec.ts), [정적 시안 상담 팝업 테스트](../../apps/web/e2e/field-day-inquiry.spec.ts), [랜딩 내용 테스트](../../apps/web/src/features/landing/LandingPage.content.test.tsx), [기능 상세 테스트](../../apps/web/src/features/landing/FeaturesPage.content.test.tsx), [양식 테스트](../../apps/web/src/features/landing/InquiryForm.test.tsx), [접수 서비스 테스트](../../apps/api/src/landing-inquiries/landing-inquiries.service.spec.ts), [요청 크기 테스트](../../apps/api/src/api-body-parser-landing.spec.ts)

## 갱신 규칙

- 공개 경로, 화면 문구·접근성, 상담 필드·동의·보관 정책, API 접수/오류 계약이 바뀌면 이 문서와 영향을 받는 [주요 기능](features.md), [요금제](pricing.md), [운영자 상담](operator.md) 문서를 같은 작업에서 갱신한다.
- 자동 테스트, 실제 배포 연결, 최종 메일 수신의 검증 상태를 구분해 기록한다.
