@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo =========================================
echo   네이버페이 취소요청 자동처리 UI
echo =========================================
echo.
echo  서버를 시작합니다... (이 창을 닫으면 종료됩니다)
echo.
npm start
echo.
echo 서버가 종료되었습니다.
pause
