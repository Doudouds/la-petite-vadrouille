@echo off
setlocal

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8010"

if exist "C:\Users\212806999.HCAD\AppData\Local\Microsoft\WindowsApps\python3.13.exe" (
    "C:\Users\212806999.HCAD\AppData\Local\Microsoft\WindowsApps\python3.13.exe" serve-local.py --port %PORT%
    goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3.13 serve-local.py --port %PORT%
    goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
    python serve-local.py --port %PORT%
    goto :eof
)

echo Python introuvable.
echo Installe Python 3.13 ou adapte start-interface.bat.
exit /b 1