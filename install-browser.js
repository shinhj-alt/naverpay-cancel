// Windows 한글 경로에서 spawn UNKNOWN 회피를 위해 ASCII 경로에 설치.
const { execSync } = require('child_process');

if (process.platform === 'win32' && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = 'C:\\playwright-browsers';
  console.log(`Setting PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
}

execSync('npx playwright install chromium', { stdio: 'inherit', env: process.env });
