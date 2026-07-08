@echo off
REM Start the Loop Chat HTTP server + pi RPC bridge
cd /d "%~dp0"
npx tsx src/chat-server.mts
pause
