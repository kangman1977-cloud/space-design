@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

REM ============================================================
REM  Step 1 : SHOW DIFF. READ-ONLY.
REM
REM  WHY THIS EXISTS
REM    The AI edits the HTML files but cannot run git here - the
REM    sandbox mount cannot unlink files inside .git, so branch and
REM    checkout operations fail. This writes everything the AI needs
REM    into a text file that it reads by itself. No pasting screens.
REM
REM  WHY IT MATTERS MORE IN THIS PROJECT THAN IN ERP
REM    Each page is one single 1000+ line file mixing HTML, CSS and
REM    JS, and a typical edit touches 200 lines. On 2026-08-20 an
REM    edit accidentally deleted the "@media print {" opening line.
REM    Braces stayed balanced, JS stayed valid, the browser reported
REM    nothing - but every print rule became global and the whole UI
REM    vanished. Syntax checks cannot catch that class of bug.
REM    A diff can. Always read this before saving.
REM
REM  READ-ONLY BY DESIGN - only status / branch / diff / log.
REM    It NEVER runs add, commit, checkout, reset, clean or stash.
REM    Worst case of pressing this by mistake: one text file is
REM    overwritten. Nothing in the project changes.
REM
REM  KNOWN LIMIT - brand new files git has never seen do NOT appear
REM    in section [4]. Git has nothing to compare them to. They show
REM    in section [1] marked "??". Read those files directly.
REM
REM  Content of this file is pure ASCII on purpose (Big5 mojibake).
REM  No parenthesised block on purpose: pipe escaping inside ( )
REM  is fragile in cmd. Plain >> append works everywhere.
REM ============================================================

set LOG=%~dp0git-log-1-diff.txt

if exist ".git\index.lock" goto stalelock

echo ================================================== > "%LOG%"
echo  STEP 1 : show diff - READ ONLY                    >> "%LOG%"
echo  run at : %DATE% %TIME%                            >> "%LOG%"
echo ================================================== >> "%LOG%"
echo. >> "%LOG%"

echo ---- [1] files touched since last save - "??" means brand new ---- >> "%LOG%"
git status --porcelain --untracked-files=all >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [2] WHICH BRANCH AM I ON - main is the desktop version ---- >> "%LOG%"
git status -sb >> "%LOG%" 2>&1
echo. >> "%LOG%"
git branch -vv >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [3] line counts per file - relative change ---- >> "%LOG%"
git diff --stat HEAD >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [4] full line-by-line diff - new files not included ---- >> "%LOG%"
git diff HEAD >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [5] ABSOLUTE line count per tracked file - truncation check ---- >> "%LOG%"
echo (a page that suddenly lost hundreds of lines was written badly) >> "%LOG%"
for /f "delims=" %%F in ('git ls-files') do call :countlines "%%F"
echo. >> "%LOG%"

echo ---- [6] where we are now ---- >> "%LOG%"
git log --oneline --decorate -5 >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ================================================== >> "%LOG%"
echo  END OF STEP 1. Nothing was changed.              >> "%LOG%"
echo ================================================== >> "%LOG%"

echo.
echo Done. Read-only - nothing was changed.
echo Result written to: %LOG%
echo.
echo NEXT: tell the AI to read it.
echo.
pause
exit /b 0

:countlines
set F=%~1
if not exist "%F%" goto :eof
for /f %%N in ('find /c /v "" ^< "%F%"') do echo %%N lines  %F% >> "%LOG%"
goto :eof

:stalelock
echo.
echo ERROR: .git\index.lock exists - git is locked.
echo.
echo Usual cause: the AI sandbox ran a git command. Even read-only ones
echo like "git status" create this lock, and the sandbox cannot delete it.
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
