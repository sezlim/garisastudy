@echo off
chcp 65001 >nul
setlocal

set "SRC=%~dp0개념정리"
set "DST=C:\Users\sezli\OneDrive\바탕 화면\개념정리"

if not exist "%SRC%\index.html" (
    echo [오류] "%SRC%" 폴더를 찾을 수 없습니다.
    pause
    exit /b 1
)

if not exist "%DST%" (
    mkdir "%DST%"
)

xcopy "%SRC%\*" "%DST%\" /E /I /Y >nul
if errorlevel 1 (
    echo [오류] 복사에 실패했습니다. 대상 경로를 확인해 주세요:
    echo        %DST%
    pause
    exit /b 1
)

echo ============================================================
echo   복사 완료!
echo   대상 폴더: %DST%
echo   index.html 을 더블클릭하면 바로 열립니다.
echo ============================================================
start "" "%DST%"
pause
