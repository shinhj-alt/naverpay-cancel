@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo =========================================
echo   네이버페이 취소요청 자동처리 UI
echo =========================================
echo.

if not exist "C:\playwright-browsers" (
    echo 브라우저 최초 설치 중... (1-2분 소요)
    echo.
    "%~dp0node.exe" "%~dp0install-browser.js"
    echo.
)

echo 서버 시작 중...
start "" "http://localhost:3000"
"%~dp0node.exe" "%~dp0index.js"
pause
