export const publicSiteOrigin = "https://kinda.dfkorealed.com";

/** Shared by the static HTML renderer and the browser title effect. */
export const publicPageSeo = {
  home: {
    pathname: "/",
    title: "킨다 | 스마트 조명 관제 서비스",
    description: "도면 위 조명 위치와 상태 확인부터 밝기 제어, 운영 통계와 보고서까지. 킨다의 스마트 조명 관제 흐름을 살펴보고 이메일로 도입을 상담하세요."
  },
  features: {
    pathname: "/features",
    title: "주요 기능 | 킨다 조명 관제",
    description: "모니터링, 조명 제어, 운영 통계와 보고서, 도면 편집까지. 킨다 조명 관제의 주요 기능과 현장 운영 흐름을 살펴보세요."
  },
  pricing: {
    pathname: "/pricing",
    title: "요금제 | 킨다 조명 관제",
    description: "킨다 조명 관제 Basic과 Plus의 기록 보존 범위와 보고서 구성을 비교하세요. 월 기준 안내와 준비 중인 요금제의 제공 조건은 이메일 도입 상담에서 확인할 수 있습니다."
  }
} as const;
