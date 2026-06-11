# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 프로젝트는 무엇인가

네이버페이 결제센터의 취소요청 건을 사용자 지정 날짜/시각 범위에 맞춰 자동으로 "취소 완료처리" 시키는 Node + Playwright 도구. 웹 UI 폼으로 조건을 입력하고, 로그인은 사용자가 직접 한다.

## 작업 시작 전 반드시 [HANDOFF.md](HANDOFF.md) 를 읽을 것

현재 진행 상태, 막힌 지점, 다음에 할 일, 알려진 버그가 정리되어 있다.

## 명령어

```bash
npm install                # 의존성
npm run install-browser    # Playwright Chromium (ASCII 경로 C:\playwright-browsers 에 설치)
npm start                  # 웹 UI 서버 시작 → http://localhost:3000
node --check index.js      # 문법 검증
```

## 아키텍처

- `index.js` 한 파일 안에 HTTP 서버 + Playwright 자동화 로직 통합 (의도된 단순화)
- 로그인은 사용자, 그 이후 자동. `.browser-profile/` 에 persistent context 저장하므로 두 번째 실행부터 로그인 생략
- DRY RUN 모드는 브라우저를 자동으로 닫지 않음 (디버깅용)

## 핵심 변경 시 주의

- **셀렉터 변경** 은 `findColumnIndexes` 및 `scanRows` (모두 `page.evaluate` 안에서 실행됨)
- **확인 팝업 텍스트** 변경은 `processOne` 의 정규식
- **컬럼 헤더 / 버튼 텍스트** 는 `CFG` 블록에서 한 곳에서 관리

## 자동화 감지 회피 (이미 적용됨, 함부로 제거하지 말 것)

- `channel: 'chrome'` — 시스템 Chrome 사용
- `--disable-blink-features=AutomationControlled` 플래그
- `ignoreDefaultArgs: ['--enable-automation']`
- `navigator.webdriver = undefined` init script

## Windows 한글 사용자 경로 회피 (이미 적용됨)

`PLAYWRIGHT_BROWSERS_PATH=C:\playwright-browsers` 를 `index.js` 상단과 `install-browser.js` 에서 자동 설정. Node `child_process.spawn` 이 한글 경로에서 `UNKNOWN` 으로 실패하는 이슈 회피용.
