// Windows에서 사용자 경로에 비-ASCII 문자(예: 한글)가 포함되면
// child_process.spawn 이 'UNKNOWN' 으로 실패함. 영문 경로 사용으로 회피.
if (process.platform === 'win32' && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = 'C:\\playwright-browsers';
}

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const os      = require('os');
const { exec }  = require('child_process');
const { chromium } = require('playwright');

const PORT = 3000;
// HOST 를 지정하지 않으면 Node 가 0.0.0.0(IPv4) 로 바인딩 →
// localhost (127.0.0.1 또는 ::1) 양쪽에서 모두 접속 가능.
const HOST = '0.0.0.0';

const CFG = {
  loginUrl:          'https://admin.pay.naver.com',
  cancelListUrl:     'https://admin.pay.naver.com/o/v3/claim/cancel?summaryInfoType=CANCEL_REQUEST_C1',
  loginTimeoutMs:    5 * 60 * 1000,
  completeButtonText:'취소 완료처리',
};

// ----- Job state (한 번에 한 개만 실행) -----
let activeJob = null;

function jobLog(line) {
  if (!activeJob) return;
  const t = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  const entry = `[${stamp}] ${line}`;
  activeJob.logs.push(entry);
  console.log(entry);
}

// ----- Helpers -----
function fmt(ts) {
  if (ts == null) return '제한 없음';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function inRange(ts, fromTs, toTs) {
  if (fromTs == null && toTs == null) return true;
  if (ts == null) return false;
  if (fromTs != null && ts < fromTs) return false;
  if (toTs != null && ts > toTs) return false;
  return true;
}

function parseFilters(input) {
  const toTs = (s) => {
    if (!s || !String(s).trim()) return null;
    const t = new Date(s).getTime();
    return isNaN(t) ? null : t;
  };
  return {
    payFrom: toTs(input.payFrom),
    payTo:   toTs(input.payTo),
    reqFrom: toTs(input.reqFrom),
    reqTo:   toTs(input.reqTo),
    dryRun:  !!input.dryRun,
  };
}

// ── 날짜 파싱 (브라우저 컨텍스트에서도 eval() 로 사용) ──────────────────
// 지원 형식: YYYY.MM.DD, YYYY-MM-DD, YYYY/MM/DD (+ 선택적 HH:mm)
const parseTsFn = `(s) => {
  const norm = (s || '').replace(/[\\r\\n\\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  // YYYY.MM.DD HH:MM 또는 YYYY.MM.DD
  const m = norm.match(/(\\d{4})[.\\-\\/](\\d{1,2})[.\\-\\/](\\d{1,2})(?:[\\s T](\\d{1,2}):(\\d{1,2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3], +(m[4]||0), +(m[5]||0)).getTime();
}`;

// ----- Automation -----
async function waitForLogin(page) {
  jobLog('브라우저에서 로그인해주세요 (최대 5분 대기).');
  const start = Date.now();
  while (Date.now() - start < CFG.loginTimeoutMs) {
    const u = page.url();
    if (u.startsWith('https://admin.pay.naver.com/') && !/login|nid/i.test(u)) {
      await page.waitForTimeout(1500);
      const u2 = page.url();
      if (u2.startsWith('https://admin.pay.naver.com/') && !/login|nid/i.test(u2)) {
        jobLog('✅ 로그인 감지!');
        return;
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('로그인 대기 시간 초과 (5분)');
}

const USER_DATA_DIR = path.join(__dirname, '.browser-profile');

async function launchContext() {
  const opts = {
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  try {
    const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { channel: 'chrome', ...opts });
    jobLog('시스템 Chrome 으로 실행.');
    return ctx;
  } catch (err) {
    jobLog(`Chrome 실행 실패(${err.message.split('\n')[0]}), 번들 Chromium 으로 폴백.`);
    return await chromium.launchPersistentContext(USER_DATA_DIR, opts);
  }
}

async function runAutomation(input) {
  const filters = parseFilters(input);
  const startTime = Date.now();

  jobLog('─── 필터 ─────────────────────────────');
  jobLog(`  결제일     : ${fmt(filters.payFrom)} ~ ${fmt(filters.payTo)}`);
  jobLog(`  취소요청일 : ${fmt(filters.reqFrom)} ~ ${fmt(filters.reqTo)}`);
  jobLog(`  모드       : ${filters.dryRun ? 'DRY RUN (실제 처리 안 함)' : '실제 처리'}`);
  jobLog('───────────────────────────────────────');

  const ctx = await launchContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', async (d) => {
    jobLog(`  [native dialog ${d.type()}] ${d.message().slice(0, 80)}`);
    try { await d.accept(); } catch {}
  });

  // ── 데이터 행 추출: tbody tr 중 날짜 패턴(YYYY.MM.DD)이 있는 행 ──────
  // radio/checkbox 필터를 제거하고 날짜 내용으로 판별 → 더 안정적
  async function getDataRows() {
    const tbodyTrs = page.locator('tbody tr');
    const total    = await tbodyTrs.count();
    const indices  = [];
    for (let i = 0; i < total; i++) {
      const info = await tbodyTrs.nth(i).evaluate(tr => ({
        hasDate:  /\d{4}[.\-\/]\d{1,2}[.\-\/]\d{1,2}/.test(tr.innerText),
        tdCount:  tr.querySelectorAll('td').length,
      }));
      // 날짜가 있고 td 2개 이상인 행 = 실제 데이터 행
      if (info.hasDate && info.tdCount >= 2) indices.push(i);
    }
    return { locator: tbodyTrs, indices };
  }

  // ── 페이지 로드 대기 (검색 버튼 누르지 않음 — 조건 필요해서 오류 유발) ──
  async function ensureDataLoaded() {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    // 최대 5초 대기 (AJAX 렌더링 대기), 500ms 간격
    for (let i = 0; i < 10; i++) {
      const check = await getDataRows();
      if (check.indices.length > 0) return check;
      await page.waitForTimeout(500);
    }
    return await getDataRows();
  }

  // ── 다음 페이지 이동 (있으면 true 반환) ──────────────────────────
  async function goNextPage() {
    // 네이버페이 페이지네이션: 주로 "다음" 텍스트 버튼 또는 > 버튼
    const candidates = [
      page.getByRole('button', { name: /^다음$/ }),
      page.getByRole('link',   { name: /^다음$/ }),
      page.locator('button').filter({ hasText: /^>$/ }),
      page.locator('a').filter({ hasText: /^>$/ }),
    ];
    for (const btn of candidates) {
      try {
        const vis = await btn.first().isVisible({ timeout: 500 });
        if (!vis) continue;
        const dis = await btn.first().isDisabled({ timeout: 500 });
        if (dis) continue;
        await btn.first().click();
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        jobLog('  → 다음 페이지로 이동');
        return true;
      } catch {}
    }
    return false;
  }

  // ── 세션 만료 감지 ──────────────────────────────────────────────
  function checkSessionAlive() {
    const u = page.url();
    if (/login|nid\.naver|sso\.naver/i.test(u)) {
      throw new Error('세션 만료 — 브라우저에서 다시 로그인 후 재실행하세요.');
    }
  }

  // ── 날짜 추출 (페이지 evaluate 로 tr 하나 분석) ────────────────
  async function getRowDates(rowLocator) {
    return rowLocator.evaluate((tr, fn) => {
      const parseTs = eval(fn);
      const cells = Array.from(tr.querySelectorAll('td')).map(td =>
        td.innerText.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
      );
      // 날짜 패턴을 가진 셀 목록 추출
      const dateEntries = cells
        .map((c, idx) => ({ idx, ts: parseTs(c), text: c }))
        .filter(e => e.ts !== null);
      // 결제일 = 첫 번째 날짜, 취소요청일 = 두 번째 날짜 (없으면 첫 번째)
      const payTs = dateEntries[0]?.ts  ?? null;
      const reqTs = dateEntries[1]?.ts ?? dateEntries[0]?.ts ?? null;
      return { payTs, reqTs, cells, dateEntries };
    }, fn);
  }

  // ── fn 클로저 변수 바인딩 (evaluate 에 직접 전달) ──────────────
  const fn = parseTsFn;

  try {
    await page.goto(CFG.loginUrl, { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    await page.goto(CFG.cancelListUrl, { waitUntil: 'networkidle' });
    await ensureDataLoaded();

    // ══════════════════════════════════════════════════════════════
    // DRY RUN
    // ══════════════════════════════════════════════════════════════
    if (filters.dryRun) {
      let totalRows = 0, matchCount = 0, pageNum = 1;

      while (true) {
        const { locator: allTrs, indices: dataIdx } = await getDataRows();
        jobLog(`[페이지 ${pageNum}] tbody tr 전체: ${await allTrs.count()}개 / 날짜 있는 데이터 행: ${dataIdx.length}개`);
        totalRows += dataIdx.length;

        for (const i of dataIdx) {
          const { payTs, reqTs, cells, dateEntries } = await getRowDates(allTrs.nth(i));

          // 디버그: 날짜 파싱 상세 출력
          const dateDebug = dateEntries.length > 0
            ? dateEntries.map(e => `col${e.idx}:"${e.text}"→${fmt(e.ts)}`).join(', ')
            : '날짜 없음 (파싱 실패)';
          jobLog(`  행${i} [${dateDebug}]`);

          const payOk = inRange(payTs, filters.payFrom, filters.payTo);
          const reqOk = inRange(reqTs, filters.reqFrom, filters.reqTo);
          if (payOk && reqOk) {
            matchCount++;
            jobLog(`    → ✅ 매칭 | 결제일:${fmt(payTs)} 취소요청일:${fmt(reqTs)}`);
          } else {
            jobLog(`    → ⏭ 스킵 | 결제일:${fmt(payTs)} 취소요청일:${fmt(reqTs)}`);
          }
        }

        if (dataIdx.length === 0) break;
        const moved = await goNextPage();
        if (!moved) break;
        pageNum++;
      }

      jobLog(`══ DRY RUN 결과: 총 ${totalRows}행 / 매칭 ${matchCount}건 ══`);
      jobLog('브라우저는 열어두었으니 직접 확인 후 닫으세요.');
      await Promise.race([
        new Promise(r => ctx.once('close', r)),
        new Promise(r => page.once('close', r)),
        page.waitForTimeout(10 * 60 * 1000),
      ]);
      return;
    }

    // ══════════════════════════════════════════════════════════════
    // 실제 처리
    // ══════════════════════════════════════════════════════════════
    const hasPayFilter = filters.payFrom != null || filters.payTo != null;
    const hasReqFilter = filters.reqFrom != null || filters.reqTo != null;
    const needDateFilter = hasPayFilter || hasReqFilter;

    let processed = 0, skipped = 0, loopGuard = 0;
    let pageNum = 1;

    outerLoop: while (loopGuard++ < 1000) {
      checkSessionAlive();
      const { locator: allTrs, indices: dataIdx } = await getDataRows();

      if (dataIdx.length === 0) {
        // 다음 페이지 시도
        const moved = await goNextPage();
        if (!moved) {
          jobLog('더 이상 처리할 행이 없습니다.');
          break;
        }
        pageNum++;
        jobLog(`[페이지 ${pageNum}] 이동`);
        continue;
      }

      // 이번 페이지에서 처리 대상 찾기
      let targetI = -1;

      if (!needDateFilter) {
        targetI = dataIdx[0];
      } else {
        for (const i of dataIdx) {
          const { payTs, reqTs } = await getRowDates(allTrs.nth(i));
          const payOk = !hasPayFilter || inRange(payTs, filters.payFrom, filters.payTo);
          const reqOk = !hasReqFilter || inRange(reqTs, filters.reqFrom, filters.reqTo);
          if (payOk && reqOk) {
            targetI = i;
            jobLog(`  대상: 결제일=${fmt(payTs)} | 취소요청일=${fmt(reqTs)}`);
            break;
          } else {
            skipped++;
          }
        }
      }

      if (targetI < 0) {
        // 이 페이지에 맞는 건 없음 → 다음 페이지
        const moved = await goNextPage();
        if (!moved) {
          jobLog('필터 조건에 맞는 행이 없습니다.');
          break;
        }
        pageNum++;
        jobLog(`[페이지 ${pageNum}] 이동`);
        continue;
      }

      // ── 처리 실행 ──────────────────────────────────────────────
      jobLog(`  처리 중... [${processed + 1}건째]`);
      const targetRow = allTrs.nth(targetI);

      try {
        // radio 또는 checkbox 중 있는 것 클릭
        const selector = targetRow.locator('input[type=radio], input[type=checkbox]').first();
        const selectorCount = await selector.count();
        if (selectorCount > 0) {
          await selector.click({ force: true });
        } else {
          // 선택 인풋이 없으면 행 자체 클릭
          await targetRow.click({ force: true });
        }
        await page.waitForTimeout(150);

        const completeBtn = page.getByRole('button', { name: CFG.completeButtonText });
        await completeBtn.waitFor({ state: 'visible', timeout: 5000 });
        await completeBtn.click();

        // 확인 팝업 최대 2개
        for (let pi = 0; pi < 2; pi++) {
          try {
            const btn = page.getByRole('button', { name: /^(확인|예|OK|네)$/ }).first();
            await btn.waitFor({ state: 'visible', timeout: 4000 });
            await btn.click();
            await page.waitForTimeout(200);
          } catch { break; }
        }

        // networkidle 대신 load 로 변경 (더 빠름)
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
        checkSessionAlive();
        processed++;
        jobLog(`  ✅ ${processed}건 완료`);

      } catch (err) {
        jobLog(`  ⚠️ 처리 중 오류: ${err.message.split('\n')[0]} — 재시도 대기 중...`);
        await page.waitForTimeout(2000);
        // 세션 만료라면 throw, 그 외는 계속 시도
        checkSessionAlive();
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    jobLog(`══════════════════════════════════════`);
    jobLog(`  ✅ 처리 완료 : ${processed}건`);
    if (skipped > 0) jobLog(`  ⏭ 필터 스킵 : ${skipped}건`);
    jobLog(`  소요 시간   : ${elapsed}초`);
    jobLog(`══════════════════════════════════════`);
    await page.waitForTimeout(500);

  } finally {
    await ctx.close().catch(() => {});
  }
}

// ----- HTTP Server -----
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (err) {
      res.writeHead(500);
      return res.end('index.html not found: ' + err.message);
    }
  }

  if (req.method === 'POST' && u.pathname === '/run') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (activeJob && !activeJob.done) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: '이미 실행 중인 작업이 있습니다.' }));
      }
      let data;
      try { data = JSON.parse(body); }
      catch { res.writeHead(400); return res.end('bad json'); }

      const id = Date.now().toString();
      activeJob = { id, logs: [], done: false, error: null };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));

      runAutomation(data)
        .catch((err) => {
          activeJob.error = err.message;
          jobLog(`❌ 오류: ${err.message}`);
        })
        .finally(() => { activeJob.done = true; });
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/session') {
    const profileDir = path.join(__dirname, '.browser-profile');
    const hasProfile = fs.existsSync(profileDir) && fs.readdirSync(profileDir).length > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ hasProfile }));
  }

  if (req.method === 'POST' && u.pathname === '/clear-session') {
    const profileDir = path.join(__dirname, '.browser-profile');
    try {
      if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'GET' && u.pathname === '/status') {
    const id = u.query.id;
    if (!activeJob || activeJob.id !== id) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'no job' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      logs:  activeJob.logs,
      done:  activeJob.done,
      error: activeJob.error,
    }));
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  // LAN IP 목록 수집
  const ifaces = os.networkInterfaces();
  const lanIPs = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) lanIPs.push(iface.address);
    }
  }

  console.log('\n=========================================');
  console.log('  네이버페이 취소요청 자동처리 UI');
  console.log(`  → http://localhost:${PORT}  (이 PC)`);
  for (const ip of lanIPs) {
    console.log(`  → http://${ip}:${PORT}  (같은 네트워크)`);
  }
  console.log('=========================================');
  console.log('브라우저를 자동으로 엽니다...');
  console.log('(Ctrl+C 로 종료)\n');

  // 서버 시작 후 브라우저 자동 열기 (Windows)
  if (process.platform === 'win32') {
    exec(`start http://localhost:${PORT}`).unref();
  } else if (process.platform === 'darwin') {
    exec(`open http://localhost:${PORT}`).unref();
  } else {
    exec(`xdg-open http://localhost:${PORT}`).unref();
  }
});
