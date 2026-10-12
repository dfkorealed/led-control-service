# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux.spec.ts >> 02 short mobile monitoring >> 390x600 dark: toolbar, HH:mm and detail scroll
- Location: ../../.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux.spec.ts:188:7

# Error details

```
Error: locator.evaluate: Error: Native input target is clipped or covered
    at eval (eval at evaluate (:303:30), <anonymous>:5:124)
    at UtilityScript.evaluate (<anonymous>:305:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - navigation "모바일 주 메뉴" [ref=e4]:
    - link "모니터링" [ref=e6] [cursor=pointer]:
      - /url: /monitoring?siteId=12121212-1212-4121-8121-121212121212
      - img [ref=e7]
      - generic [ref=e9]: 모니터링
    - link "제어" [ref=e11] [cursor=pointer]:
      - /url: /control?siteId=12121212-1212-4121-8121-121212121212
      - img [ref=e12]
      - generic [ref=e13]: 제어
    - link "통계" [ref=e15] [cursor=pointer]:
      - /url: /statistics/overview?siteId=12121212-1212-4121-8121-121212121212
      - img [ref=e16]
      - generic [ref=e18]: 통계
    - link "설정" [ref=e20] [cursor=pointer]:
      - /url: /settings?siteId=12121212-1212-4121-8121-121212121212
      - img [ref=e21]
      - generic [ref=e24]: 설정
  - main [ref=e25]:
    - generic [ref=e26]:
      - generic [ref=e27]: 모니터링
      - generic "현장 정보" [ref=e28]:
        - img "킨다" [ref=e29]:
          - img [ref=e30]
          - strong [ref=e31]: 킨다
        - paragraph [ref=e32]: 고객사 B2 현장
        - generic [ref=e33]: 고객사 B2 현장
      - generic [ref=e34]:
        - button "알람센터, 확인 불가" [ref=e36] [cursor=pointer]:
          - img [ref=e37]
          - generic [ref=e40]: "?"
        - button "라이트 모드로 변경" [pressed] [ref=e41] [cursor=pointer]:
          - img [ref=e42]
      - region "현장 전체" [ref=e48]:
        - heading "현장 전체" [level=2] [ref=e49]
        - paragraph [ref=e50]: 고객사 B2 현장
        - generic [ref=e51]:
          - generic [ref=e52]:
            - term [ref=e53]: 전체
            - definition [ref=e54]: 3대
          - generic [ref=e55]:
            - term [ref=e56]: 온라인
            - definition [ref=e57]: 3대
          - generic [ref=e58]:
            - term [ref=e59]: 장애
            - definition [ref=e60]: 0대
          - generic [ref=e61]:
            - term [ref=e62]: 오프라인
            - definition [ref=e63]: 0대
    - generic [ref=e65]:
      - heading "모니터링" [level=1] [ref=e66]
      - group "모니터링 도구" [ref=e67]:
        - generic [ref=e68]:
          - generic [ref=e69]: 맵 선택
          - generic [ref=e70]:
            - button "맵 선택" [ref=e71]:
              - generic [ref=e72]: B2
              - generic [ref=e73]: ▾
            - combobox [ref=e76]
        - button "조명 검색/목록" [ref=e77] [cursor=pointer]:
          - img [ref=e78]
        - 'generic "마지막 갱신: 2026-10-12 11:16:43 (현장 시간)" [ref=e81]':
          - generic [ref=e82]: "마지막 갱신:"
          - time [ref=e83]: 11:16
        - button "새로고침" [ref=e84] [cursor=pointer]:
          - img [ref=e85]
      - generic [ref=e91]:
        - generic [ref=e92]:
          - region "선택 층 조명 현황" [ref=e95]:
            - group "B2 · 조명 현황" [ref=e96]:
              - generic [ref=e97]:
                - generic [ref=e99]: 전체 조명
                - strong [ref=e100]: "3"
              - generic [ref=e101]:
                - generic [ref=e103]: 정상
                - strong [ref=e104]: "3"
              - generic [ref=e105]:
                - generic [ref=e107]: 점검 필요
                - strong [ref=e108]: "0"
              - generic [ref=e109]:
                - generic [ref=e111]: 오프라인
                - strong [ref=e112]: "0"
          - generic [ref=e113]:
            - region "층 도면" [ref=e114]:
              - generic [ref=e116]:
                - region "상하좌우로 이동하고 확대 축소할 수 있는 지도" [ref=e117]:
                  - generic [ref=e119]:
                    - generic:
                      - img
                    - generic [ref=e120]:
                      - button "UX 조명 01 정상 70%" [ref=e122] [cursor=pointer]
                      - button "UX 조명 02 정상 70%" [ref=e123] [cursor=pointer]
                      - button "UX 조명 03 정상 70%" [ref=e124] [cursor=pointer]
                - generic [ref=e125]:
                  - generic [ref=e126]:
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
                  - group "지도 조작" [ref=e127]:
                    - button "지도 축소" [ref=e128] [cursor=pointer]:
                      - img [ref=e129]
                    - button "지도 배율 100%" [ref=e130] [cursor=pointer]: 100%
                    - button "지도 확대" [ref=e131] [cursor=pointer]:
                      - img [ref=e132]
                    - button "지도 전체 보기" [ref=e133] [cursor=pointer]:
                      - img [ref=e134]
            - complementary "조명 상세" [active] [ref=e139]:
              - generic [ref=e140]:
                - heading "조명 상세" [level=2] [ref=e141]
                - button "조명 상세 닫기" [ref=e142] [cursor=pointer]: 닫기
              - complementary "선택 조명 상세" [ref=e144]:
                - generic [ref=e145]:
                  - heading "UX 조명 01" [level=3] [ref=e146]
                  - generic [ref=e147]:
                    - img [ref=e148]
                    - generic [ref=e151]: 정상
                - region "선택 조명 정보" [ref=e152]:
                  - generic [ref=e153]:
                    - generic [ref=e154]: 현재 밝기
                    - strong [ref=e155]: 70%
                    - paragraph [ref=e156]:
                      - text: "마지막 확인:"
                      - time [ref=e157]: 2026-10-12 11:16:43
                  - generic [ref=e158]:
                    - generic [ref=e159]:
                      - term [ref=e160]: 상태 안내
                      - definition [ref=e161]: 조명이 최신 상태를 정상적으로 보고했습니다.
                    - generic [ref=e162]:
                      - term [ref=e163]: 권장 조치
                      - definition [ref=e164]: 조치 불필요
                    - generic [ref=e165]:
                      - term [ref=e166]: 지도 배치
                      - definition [ref=e167]: 미배치
        - region "최근 운영 로그" [ref=e168]:
          - region "최근 활동" [ref=e169]:
            - generic [ref=e170]: 최근 활동
            - paragraph [ref=e172]: 운영 활동을 불러오지 못했습니다.
            - button "다시 조회" [ref=e173] [cursor=pointer]
            - button "전체 보기" [ref=e174] [cursor=pointer]:
              - text: 전체 보기
              - img [ref=e175]
```