@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\GooeShell.exe" "%~dp0..\app.asar\dist-main\main\cli.js" %*
exit /b %ERRORLEVEL%
