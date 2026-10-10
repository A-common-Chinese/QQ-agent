# 打「DSH 版」安装包

产物：`dist/QQ-Agent-DSH-Setup.exe`（NSIS，`appId=cn.kondius.qq-agent.dsh`、`productName=QQ Agent DSH`、
`asar: false`）。**与上游正式版并行安装、互不影响** —— 这是刻意的：上游 `package.json` 里的 build 段
appId/productName 与正式版完全相同，还 `include: build/installer.nsh`（那个脚本会检测旧版
"直接覆盖升级"、杀掉运行中的 QQ Agent、把用户数据备份走），用它打包会顶掉已装的正版，
而正版目录里放着 SnowLuma 与 QQ 登录态。所以这里用**独立的 `electron-builder-dsh.yml`**。

## 本机为什么需要额外四步

这台机器有三个环境特性，缺一步就会失败（都实测过）：

1. **github.com 被 hosts 指到 127.0.0.1**（走本地代理）→ 拉大文件会挂死到 600s 超时。
   所以 electron 本体、nsis/winCodeSign 全部要走 npmmirror。
2. **没有独立 Node**，用的是 DSH 自带的 node/pnpm；`pnpm` 不在 PATH 上，
   而 electron-builder 的依赖收集器会 spawn `pnpm list --prod --json …`，
   找不到命令就拿不到输出 → 报 `No JSON content found in output`。
3. pnpm 默认的 isolated 布局把依赖做成 junction，打进包后运行时解析不可靠。

## 一次性准备

```powershell
$node = "C:\Users\noapi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\noapi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

# ① 依赖改扁平布局（pnpm-workspace.yaml 里已写 nodeLinker: hoisted，执行一次生效）
$env:PATH = "C:\Users\noapi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
& $node $pnpm install

# ② pnpm 垫片：electron-builder 在 Windows 上用 powershell -EncodedCommand 起包管理器命令，
#    所以 .cmd 垫片对它有效（注意：Node 自己 spawnSync 一个 .cmd 会 EINVAL，别用那个去测）
$shim = "$env:LOCALAPPDATA\dsh-pnpm-shim"
New-Item -ItemType Directory -Force $shim | Out-Null
[System.IO.File]::WriteAllText("$shim\pnpm.cmd",
  "@echo off`r`n`"$node`" `"$pnpm`" %*`r`n", (New-Object System.Text.ASCIIEncoding))

# ③ 把 nsis / nsis-resources / winCodeSign 预先喂进 electron-builder 缓存（走镜像，带官方 sha256 校验）
$cache = "$env:LOCALAPPDATA\electron-builder\Cache"
$items = @(
  @{ d='winCodeSign-2.6.0';    f='winCodeSign-2.6.0.7z';    s='cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4' },
  @{ d='nsis-3.0.4.1';         f='nsis-3.0.4.1.7z';         s='9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa' },
  @{ d='nsis-resources-3.4.1'; f='nsis-resources-3.4.1.7z'; s='593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103' }
)
foreach ($i in $items) {
  New-Item -ItemType Directory -Force "$cache\$($i.d)" | Out-Null
  & curl.exe -sL --fail -o "$cache\$($i.d)\$($i.f)" "https://npmmirror.com/mirrors/electron-builder-binaries/$($i.d)/$($i.f)"
  $h = (Get-FileHash "$cache\$($i.d)\$($i.f)" -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $i.s) { throw "sha256 不匹配：$($i.f)" }
}
```

## 每次打包

```powershell
$node = "C:\Users\noapi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\noapi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$env:PATH    = "$env:LOCALAPPDATA\dsh-pnpm-shim;C:\Users\noapi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
$env:NODE_OPTIONS = "--use-system-ca"                       # 本机代理的证书只有 Windows 信任
$env:npm_config_update_notifier = "false"                   # 别让 pnpm 的版本横幅污染 JSON
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_CUSTOM_DIR = "{{ version }}"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"                  # 无签名证书，别去发现

cd <仓库根>
& $node $pnpm exec electron-builder --config electron-builder-dsh.yml --win nsis --publish never
```

正常输出末尾应有 `building target=nsis file=dist\QQ-Agent-DSH-Setup.exe` 与
`building block map`，耗时约 30 秒（electron 已缓存时）。

## 装完之后的迁移（装 → 迁 → 验 → 才能卸载旧的）

新装目录默认 `%LOCALAPPDATA%\Programs\QQ Agent DSH`，它**不含 SnowLuma**（仓库里没有 `snowluma/`，
打包也排除了 `snowluma/config|data|logs`）。所以要么：

- 把旧安装的 `resources\app\snowluma\`（含 QQ 登录态）复制进新安装的同名目录；或
- 在新装的 `data\config.json` 里把 `snowluma.dir` 指到旧安装那份（但卸载旧版前记得再搬一次）。

同时要迁的还有：旧 `data\`（模型 Key / 人设 / 记忆 / 表情库，可整体覆盖）与
旧 `resources\app\plugins\`（自己装的插件）。

**顺序很重要**：先装新版并验证能连 QQ、`/dsh` 正常，再卸载旧版。验证期间不要同时跑两个核心
（同一个 QQ 号会被两条核心处理 → 群里重复回复）。
