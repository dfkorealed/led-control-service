# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux.spec.ts >> 01 PC monitoring actual CAD and nonmodal detail >> 1194 light: pan, single selection, half overlay and focus
- Location: ../../.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux.spec.ts:167:7

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - img "킨다 관제 센터" [ref=e6]:
        - img [ref=e7]
        - strong [ref=e8]: 킨다
        - generic [ref=e9]: 관제 센터
      - button "사이드바 접기" [expanded] [ref=e11] [cursor=pointer]:
        - img [ref=e12]
    - navigation "주 메뉴" [ref=e15]:
      - link "모니터링" [ref=e17] [cursor=pointer]:
        - /url: /monitoring?siteId=12121212-1212-4121-8121-121212121212
        - img [ref=e18]
        - generic [ref=e20]: 모니터링
      - link "제어" [ref=e22] [cursor=pointer]:
        - /url: /control?siteId=12121212-1212-4121-8121-121212121212
        - img [ref=e23]
        - generic [ref=e24]: 제어
      - link "통계" [ref=e26] [cursor=pointer]:
        - /url: /statistics/overview?siteId=12121212-1212-4121-8121-121212121212
        - img [ref=e27]
        - generic [ref=e29]: 통계
      - link "설정" [ref=e31] [cursor=pointer]:
        - /url: /settings?siteId=12121212-1212-4121-8121-121212121212
        - img [ref=e32]
        - generic [ref=e35]: 설정
  - main [ref=e36]:
    - generic [ref=e37]:
      - generic [ref=e38]: 모니터링
      - generic "현장 정보" [ref=e39]:
        - paragraph [ref=e40]: 고객사 B2 현장
        - generic [ref=e41]: 고객사 B2 현장
      - generic [ref=e42]:
        - button "알람센터, 확인 불가" [ref=e44] [cursor=pointer]:
          - img [ref=e45]
          - generic [ref=e48]: "?"
        - button "다크 모드로 변경" [ref=e49] [cursor=pointer]:
          - img [ref=e50]
        - link "내 계정 및 보안" [ref=e52] [cursor=pointer]:
          - /url: /settings/security?siteId=12121212-1212-4121-8121-121212121212
          - img [ref=e53]
      - region "현장 전체" [ref=e56]:
        - heading "현장 전체" [level=2] [ref=e57]
        - paragraph [ref=e58]: 고객사 B2 현장
        - generic [ref=e59]:
          - generic [ref=e60]:
            - term [ref=e61]: 전체
            - definition [ref=e62]: 3대
          - generic [ref=e63]:
            - term [ref=e64]: 온라인
            - definition [ref=e65]: 3대
          - generic [ref=e66]:
            - term [ref=e67]: 장애
            - definition [ref=e68]: 0대
          - generic [ref=e69]:
            - term [ref=e70]: 오프라인
            - definition [ref=e71]: 0대
    - generic [ref=e73]:
      - heading "모니터링" [level=1] [ref=e74]
      - group "모니터링 도구" [ref=e75]:
        - generic [ref=e76]:
          - generic [ref=e77]: 맵 선택
          - generic [ref=e78]:
            - button "맵 선택" [ref=e79]:
              - generic [ref=e80]: B2
              - generic [ref=e81]: ▾
            - combobox [ref=e84]
        - button "조명 검색/목록" [ref=e85] [cursor=pointer]:
          - img [ref=e86]
          - generic [ref=e88]: 조명 검색/목록
        - 'generic "마지막 갱신: 2026-10-12 11:16:13 (현장 시간)" [ref=e90]':
          - text: "마지막 갱신:"
          - time [ref=e91]:
            - generic [ref=e92]: 2026-10-12 11:16:13 (현장 시간)
        - button "새로고침" [ref=e93] [cursor=pointer]:
          - img [ref=e94]
          - generic [ref=e99]: 새로고침
      - generic [ref=e101]:
        - generic [ref=e102]:
          - region "선택 층 조명 현황" [ref=e105]:
            - group "B2 · 조명 현황" [ref=e106]:
              - generic [ref=e107]:
                - generic [ref=e109]: 전체 조명
                - strong [ref=e110]: "3"
              - generic [ref=e111]:
                - generic [ref=e113]: 정상
                - strong [ref=e114]: "3"
              - generic [ref=e115]:
                - generic [ref=e117]: 점검 필요
                - strong [ref=e118]: "0"
              - generic [ref=e119]:
                - generic [ref=e121]: 오프라인
                - strong [ref=e122]: "0"
          - region "층 도면" [ref=e124]:
            - generic [ref=e126]:
              - region "상하좌우로 이동하고 확대 축소할 수 있는 지도" [ref=e127]:
                - generic [ref=e129]:
                  - generic:
                    - img
                  - generic [ref=e130]:
                    - button "UX 조명 01 정상 70%" [active] [ref=e132] [cursor=pointer]
                    - button "UX 조명 02 정상 70%" [ref=e133] [cursor=pointer]
                    - button "UX 조명 03 정상 70%" [ref=e134] [cursor=pointer]
              - generic [ref=e135]:
                - generic [ref=e136]:
                  - list "조명 상태 범례":
                    - listitem:
                      - img
                      - generic: 정상
                    - listitem:
                      - img
                      - generic: 장애
                    - listitem:
                      - img
                      - generic: 오프라인
                    - listitem:
                      - img
                      - generic: 상태 확인 대기
                    - listitem:
                      - img
                      - generic: 조명 정보 확인 전
                - group "지도 조작" [ref=e137]:
                  - button "지도 축소" [ref=e138] [cursor=pointer]:
                    - img [ref=e139]
                  - button "지도 배율 100%" [ref=e140] [cursor=pointer]: 100%
                  - button "지도 확대" [ref=e141] [cursor=pointer]:
                    - img [ref=e142]
                  - button "지도 전체 보기" [ref=e143] [cursor=pointer]:
                    - img [ref=e144]
        - region "최근 운영 로그" [ref=e149]:
          - region "최근 활동" [ref=e150]:
            - generic [ref=e151]: 최근 활동
            - paragraph [ref=e153]: 운영 활동을 불러오지 못했습니다.
            - button "다시 조회" [ref=e154] [cursor=pointer]
            - button "전체 보기" [ref=e155] [cursor=pointer]:
              - text: 전체 보기
              - img [ref=e156]
```