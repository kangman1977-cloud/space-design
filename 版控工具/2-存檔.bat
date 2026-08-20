@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0.."

REM ============================================================
REM  Step 2 : commit. Pure additive - this never deletes anything.
REM
REM  Commit message is read from commit-msg.txt (UTF-8, same folder).
REM  The AI rewrites that file before telling you to run this.
REM  If the message file is missing this stops without committing.
REM
REM  RUN STEP 1 FIRST. Saving without looking at the diff is how a
REM  broken layout gets locked into history. Step 1 is read-only and
REM  costs nothing.
REM
REM  Content of this file is pure ASCII on purpose (Big5 mojibake).
REM  No parenthesised block on purpose: pipe escaping inside ( )
REM  is fragile in cmd. Plain >> append works everywhere.
REM ============================================================

set LOG=%~dp0git-log-2-save.txt
set MSG=%~dp0commit-msg.txt

if exist ".git\index.lock" goto stalelock
if not exist "%MSG%" goto nomsg

echo ================================================== > "%LOG%"
echo  STEP 2 : commit                                  >> "%LOG%"
echo  run at : %DATE% %TIME%                           >> "%LOG%"
echo ================================================== >> "%LOG%"
echo. >> "%LOG%"

echo ---- [1] branch we are committing to ---- >> "%LOG%"
git status -sb >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [2] what changed since last save ---- >> "%LOG%"
git status --porcelain --untracked-files=all >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [3] stage everything - respecting .gitignore ---- >> "%LOG%"
git add -A >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [4] line counts per file - last chance to spot a bad write ---- >> "%LOG%"
git diff --cached --stat >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [5] the message being used ---- >> "%LOG%"
type "%MSG%" >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [6] commit ---- >> "%LOG%"
git commit -F "%MSG%" >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ---- [7] last 10 saves ---- >> "%LOG%"
git log --oneline --decorate -10 >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo ================================================== >> "%LOG%"
echo  END OF STEP 2.                                   >> "%LOG%"
echo ================================================== >> "%LOG%"

echo.
echo Done.
echo Result written to: %LOG%
echo.
pause
exit /b 0

:nomsg
echo.
echo ERROR: message file not found:
echo   %MSG%
echo Ask the AI to write it first. Nothing was committed.
echo.
pause
exit /b 1

:stalelock
echo.
echo ERROR: .git\index.lock exists - git is locked. Nothing was committed.
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
