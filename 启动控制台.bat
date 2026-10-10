@echo off
rem 启动 fork 的 headless 控制台（浏览器访问 http://127.0.0.1:3310）
rem 用 DSH 自带的 Node 跑，本机没装独立 Node 也能用。
setlocal
set "NODE=C:\Users\noapi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo [错误] 找不到 DSH 自带的 Node：%NODE%
  echo        装了独立 Node 的话，把下面这行换成 node 即可。
  pause
  exit /b 1
)
cd /d "%~dp0"
echo 控制台： http://127.0.0.1:3310
echo 日志：   %~dp0data\logs
echo 关闭本窗口即停止（或按 Ctrl+C）。
"%NODE%" src\server.js
pause
