@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "PY_CMD="
py -3 --version >nul 2>&1
if not errorlevel 1 (
    set "PY_CMD=py -3"
) else if exist "%LOCALAPPDATA%\Python\bin\python.exe" (
    set "PY_CMD="%LOCALAPPDATA%\Python\bin\python.exe""
) else (
    python --version >nul 2>&1
    if not errorlevel 1 set "PY_CMD=python"
)

if not defined PY_CMD (
    echo [ERROR] Python 3 실행 파일을 찾을 수 없습니다.
    pause
    exit /b 1
)

cd /d "%~dp0"

set "LAN_IP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1 -ExpandProperty IPAddress)" 2^>nul`) do (
    set "LAN_IP=%%i"
)

echo ========================================================
echo   AI Workspace (정보시스템 감리사 학습 웹앱) 서버 시작
echo ========================================================
echo   PC 브라우저 : http://localhost:8000
if defined LAN_IP (
    echo   모바일 접속 : http://%LAN_IP%:8000  (동일 Wi-Fi)
)
echo   브리핑 파일 : web\data\user_briefings.json (토큰 없이 자동 저장)
echo   종료 방법   : 이 창을 닫거나 Ctrl+C 를 누르세요
echo ========================================================

start "" /b cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:8000"
%PY_CMD% "%~dp0scripts\serve_web.py" --host 0.0.0.0 --port 8000
