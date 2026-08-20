@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

REM ============================================================
REM  Step 3 : push to GitHub, which updates the public web page.
REM
REM  Run this AFTER step 2 (the save script). Saving records the
REM  change locally; this sends it out so tablets get the new
REM  version.
REM
REM  Pure additive: it only uploads. It never deletes local files
REM  and never rewrites history.
REM
REM  GitHub Pages usually takes 1-2 minutes to rebuild after a push,
REM  so the tablet may still show the old page for a short while.
REM
REM  If the remote is not set up yet, the script says what to do
REM  instead of failing silently.
REM
REM  Content of this file is pure ASCII on purpose (Big5 mojibake).
REM ============================================================

set LOG=%~dp0git-log-3-push.txt

if exist ".git\index.lock" goto stalelock

git remote get-url origin >nul 2>&1
if errorlevel 1 goto noremote

echo ================================================== > "%LOG%"
echo  STEP 3 : push to GitHub                          >> "%LOG%"
echo  run at : %DATE% %TIME%                           >> "%LOG%"
echo ================================================== >> "%LOG%"
echo. >> "%LOG%"

echo ---- [1] anything not saved yet - should be empty ---- >> "%LOG%"
git status --porcelain --untracked-files=all >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [2] where we are ---- >> "%LOG%"
git status -sb >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [3] remote address ---- >> "%LOG%"
git remote -v >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [4] what will be sent ---- >> "%LOG%"
git log origin/main..main --oneline >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [5] push ---- >> "%LOG%"
git push origin main >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [6] result ---- >> "%LOG%"
git log --oneline --decorate -5 >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ================================================== >> "%LOG%"
echo  END OF STEP 3.                                   >> "%LOG%"
echo ================================================== >> "%LOG%"

echo.
echo Done.
echo Result written to: %LOG%
echo.
echo The public page updates about 1-2 minutes after a successful push.
echo.
pause
exit /b 0

:noremote
echo.
echo No GitHub remote is set up yet. Nothing was sent.
echo.
echo Ask the AI for the one-time setup commands, or paste this in
echo Git Bash once you have created the repository on github.com:
echo.
echo   git remote add origin https://github.com/YOURNAME/YOURREPO.git
echo   git push -u origin main
echo.
pause
exit /b 1

:stalelock
echo.
echo ERROR: .git\index.lock exists - git is locked. Nothing was sent.
echo.
echo Fix - paste these two lines into Git Bash in the project folder:
echo.
echo   find .git -name "*.lock" -delete
echo   find .git -name "tmp_obj_*" -delete
echo.
echo Then run this file again.
echo.
pause
exit /b 1
