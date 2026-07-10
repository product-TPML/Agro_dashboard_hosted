@echo off
cd /d "%~dp0"
echo [0/5] Checking dependencies...
call npm install
echo [1/5] Building database...
call npm run build:static-db
npm run update-data
pause
