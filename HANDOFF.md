# 인계 노트 (HANDOFF)

다른 PC에서 이 프로젝트를 이어 작업할 때 이 문서를 먼저 읽어주세요.

## 목표

네이버페이 결제센터(`https://admin.pay.naver.com/o/v3/claim/cancel?summaryInfoType=CANCEL_REQUEST_C1`)
의 **취소요청 목록**에서, 사용자가 지정한 **결제일/취소요청일 범위 안**에 들어오는 건만
자동으로 "취소 완료처리" 시킨다.

## 아키텍처

```
브라우저(폼 UI) ──HTTP──> Node 서버(index.js) ──Playwright──> Chrome(네이버페이)
                                  │
                                  └─ 로그 ──폴링──> 브라우저(UI 콘솔)
```

- `index.js` — HTTP 서버(`localhost:3000`) + Playwright 자동화 로직 (한 파일)
- `public/index.html` — 폼 UI (datetime-local 4개, DRY RUN 토글, 실행 버튼, 로그 콘솔)
- `install-browser.js` — `playwright install chromium` 을 ASCII 경로에 설치하는 헬퍼
- `.browser-profile/` — Playwright persistent context (로그인 세션 저장, **민감 정보**)

## 현재까지 해결된 것

| 이슈 | 해결 |
|------|------|
| Windows 한글 경로 `spawn UNKNOWN` | `PLAYWRIGHT_BROWSERS_PATH=C:\playwright-browsers` (index.js, install-browser.js 양쪽에서 자동 설정) |
| 네이버 자동화 감지로 로그인 페이지 2번 뜸 | `channel: 'chrome'` + `--disable-blink-features=AutomationControlled` + `ignoreDefaultArgs:['--enable-automation']` + `navigator.webdriver` 마스킹 + persistent profile |
| 확인 팝업 2개 처리 | `page.on('dialog', accept)` + HTML 모달은 "확인/예/OK/네" 버튼 최대 2회 클릭 |
| DRY RUN 후 브라우저가 너무 빨리 닫힘 | `ctx.once('close')` 대기로 사용자가 직접 닫을 때까지 유지 (최대 10분) |

## 현재 막힌 지점 ← 여기부터 이어서

DRY RUN 결과 `[테이블 헤더] []` 가 빈 배열. `table thead th` 선택자가 매칭 안 됨.

가능성:
1. **div-기반 그리드** (네이버페이가 `<table>` 대신 `<div role="grid">` 사용)
2. **iframe 내부**에 테이블이 있음
3. URL이 의도와 다른 페이지로 리다이렉트됨

### 다음에 해야 할 일

1. 회사 PC에서 2FA 통과해 로그인 완료
2. DRY RUN 실행 → 새로 추가된 진단 로그 확인:
   - `[현재 URL]` — 의도된 URL인지
   - `[테이블 헤더] []` 일 때 출력되는 셀렉터 카운트 (`table`, `[role=grid]`, `iframe`, ...)
   - `"결제일/취소요청일" 텍스트가 발견된 요소` — 어떤 태그에 있는지
3. F12 → 실제 헤더 셀의 DOM 구조 확인
4. `index.js` 의 `findColumnIndexes` 함수와 `scanRows` 함수의 셀렉터를 실제 구조에 맞게 수정

   현재는 `table thead th` 및 `table tbody tr`. 만약 div-grid면 `[role=columnheader]` 및 `[role=row]` 같은 식으로 변경.

5. `processOne` 의 라디오 셀렉터(`input[type=radio]`)와 "취소 완료처리" 버튼 셀렉터(`getByRole('button', { name: ... })`)도 실제와 맞는지 확인.

## 잠재 버그 (이전 PC에서 정리)

1. 컬럼 헤더 자동 탐지 — 텍스트 부분 매칭만 함. 정확한 텍스트가 다르면 `CFG` 수정 필요
2. 셀 날짜 포맷 — `YYYY.MM.DD HH:mm` 가정. "오늘 14:30" 같은 상대 표기면 null
3. 라디오 선택자 — 한 행에 라디오 여러 개면 첫 번째만 클릭
4. 확인 팝업 텍스트 — "확인/예/OK/네" 외 다른 단어면 처리 안 됨
5. 페이지네이션 미지원 — 첫 페이지만 처리
6. 세션 만료 — 처리 중 끊기면 무한 루프 (loopGuard 500회로 차단됨)
7. 다국어/타임존 — datetime-local 은 브라우저 로컬 타임존 사용

## 새 PC 셋업 절차

```bash
# 1. Node.js LTS 설치 (https://nodejs.org/ko)

# 2. 이 폴더로 이동
cd path\to\naverpay-cancel

# 3. 의존성 + Chromium 설치 (5분쯤 걸림)
npm install
npm run install-browser

# 4. 실행
npm start

# 5. 브라우저로 http://localhost:3000 열기
```

## 전송 시 주의

- **`.browser-profile/`** 은 로그인 쿠키를 담고 있으므로 가능하면 **전송하지 말기**. 새 PC에서 첫 실행 시 다시 로그인. 회사 PC라면 2FA가 다시 트리거되어도 정상.
- **`node_modules/`** 는 전송 불필요 — `npm install` 로 재생성.
- **`C:\playwright-browsers\`** 도 전송 불필요 — `npm run install-browser` 로 재설치.

## 회사 PC에서 Claude Code 로 이어가는 방법

새 Claude Code 세션에서 이 폴더 안에서 다음과 같이 시작:

```
이 폴더의 HANDOFF.md 와 CLAUDE.md 를 먼저 읽고, "현재 막힌 지점" 부터 이어가줘.
```

또는 더 구체적으로:

```
DRY RUN 한 번 돌려서 로그 보내줄게. 진단 정보 보고 findColumnIndexes / scanRows
셀렉터를 실제 DOM 구조에 맞게 수정해줘.
```
