@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo =========================================
echo   네이버페이 취소요청 자동처리 UI
echo =========================================
echo.
echo 서버 시작 중...
start "" "http://localhost:3000"
"C:\Program Files\nodejs\node.exe" "%~dp0index.js"
pause
