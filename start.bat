@echo off
echo ==============================================
echo   Pandas Terminal - One Click Launcher
echo ==============================================
echo.

echo [1/2] Starting Python FastAPI Backend (Port 8000)...
start /min cmd /c "cd /d E:\crypto-terminal\backend && .\venv\Scripts\python.exe -m uvicorn app:app --reload"

echo [2/2] Starting Frontend Server (Port 3000)...
start /min cmd /c "cd /d E:\crypto-terminal && python -m http.server 3000"

:: Wait 2 seconds for servers to boot
timeout /t 2 /nobreak >nul

echo.
echo [OK] Both servers are running!
echo [OK] Opening Pandas Terminal in browser...
start http://localhost:3000

echo.
echo ==============================================
echo   Terminal is LIVE. Close this window anytime.
echo ==============================================
