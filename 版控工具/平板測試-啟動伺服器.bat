@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

REM ============================================================
REM  Serve this folder on the local network so a tablet can open
REM  the pages. READ-ONLY: it only hands out files. It never
REM  writes, deletes or touches .git.
REM
REM  Close the black window (or press Ctrl+C) to stop sharing.
REM  Nothing is left running afterwards.
REM
REM  Requires Python or Node on this PC. If neither is found the
REM  script says so and exits without doing anything.
REM
REM  Content of this file is pure ASCII on purpose (Big5 mojibake).
REM ============================================================

set PORT=8080

echo.
echo ==========================================================
echo   TABLET TEST SERVER
echo ==========================================================
echo.
echo Folder being shared:
echo   %CD%
echo.

echo Your PC addresses on this network:
echo.
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do call :showurl %%A
echo.
echo ----------------------------------------------------------
echo  ON THE IPAD:
echo    1. Make sure it is on the SAME Wi-Fi as this PC
echo    2. Open Safari and type one of the addresses above
echo    3. A file list appears - tap the page you want
echo    4. Optional: Share button - Add to Home Screen
echo       (gives a full screen icon, more room for the canvas)
echo.
echo  TO STOP: close this window, or press Ctrl+C
echo ----------------------------------------------------------
echo.

where py >nul 2>&1
if %errorlevel%==0 goto usepy

where python >nul 2>&1
if %errorlevel%==0 goto usepython

where node >nul 2>&1
if %errorlevel%==0 goto usenode

goto nothing

:: ==========================================================
::  2026-08-31: use 平板伺服器.py instead of http.server
::  WHY: python -m http.server sends NO Cache-Control, so the
::  browser guesses (10%% of file age). Files edited often came
::  back fresh, files edited rarely stayed CACHED FOR HOURS.
::  The iPad got a NEW main.js with an OLD scene.js -> buttons
::  worked, nothing was drawn, and NO error appeared.
::  Full write-up: 版控工具\平板伺服器.py  (header comment)
:: ==========================================================

:usepy
echo Starting server with Python (py) - CACHING DISABLED...
echo.
py -3 "%~dp0平板伺服器.py" %PORT%
goto done

:usepython
echo Starting server with Python - CACHING DISABLED...
echo.
python "%~dp0平板伺服器.py" %PORT%
goto done

:usenode
echo Starting server with Node (npx serve)...
echo First run may take a minute to download the tool.
echo.
echo   WARNING: this fallback does NOT disable caching.
echo   If the tablet shows stale behaviour, install Python
echo   and run this file again - see 版控工具\平板伺服器.py
echo.
npx --yes serve -l %PORT% --no-clipboard
goto done

:nothing
echo.
echo ERROR: neither Python nor Node was found on this PC.
echo.
echo Easiest fix: install Python from
echo   https://www.python.org/downloads/windows/
echo During install TICK the box "Add python.exe to PATH".
echo Then run this file again.
echo.
pause
exit /b 1

:showurl
set IP=%1
set IP=%IP: =%
if "%IP%"=="" goto :eof
echo    http://%IP%:%PORT%/
goto :eof

:done
echo.
echo Server stopped. Nothing is being shared any more.
echo.
pause
