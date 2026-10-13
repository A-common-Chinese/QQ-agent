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

### 卸载旧版时的一个坑（实测）

旧版的卸载器 `Uninstall QQ Agent.exe` 里带着上游的 `installer.nsh` 逻辑：**它会先"关掉正在运行的
QQ Agent"** —— 按进程名匹配，所以 `QQ Agent DSH.exe` 也会被它一起杀掉（我们的新版进程名以
"QQ Agent" 开头）。卸完**重新启动一次新版**即可，数据没影响：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 从 DSH 的 shell 里启动才需要
Start-Process "$env:LOCALAPPDATA\Programs\QQ Agent DSH\QQ Agent DSH.exe"
```

另外：从 DSH 派生的终端里启动 Electron 应用，必须清掉继承来的 `ELECTRON_RUN_AS_NODE`
（否则 Electron 会当纯 Node 跑，秒退且不写任何日志 —— 这个坑很容易误判成"程序坏了"）。

## DSH 出站隐私过滤（fork 侧）

目的：**DSH 的内容发往非白名单会话时不得携带隐私信息**；白名单会话（默认 `private:85946573`）
原样放行。实现见 `src/privacy.js`，与 dsh-qq 插件的 `privacy.js` **同源同规则**
（由 `ref-qqagent/build-fork-privacy.cjs` 从插件那份生成，避免两边跑偏）。

为什么 fork 侧也要做一层：fork 才是所有 DSH 内容落到 QQ 的**咽喉** —— `/api/inbound` 主动推送
和桥回传的回复都经它的 sender 出去；而且改这里只要重启 QQ Agent（约 6 秒），不必重启 DSH
（DSH 会缓存插件的 ESM 模块，插件侧那层要等下次重启 DSH 才生效）。

| 闸门 | 位置 | 覆盖 |
|---|---|---|
| 桥回传回复 | `src/dsh-bridge.js` 的 `reply()` | DSH 的答案、进度提示、错误提示（主要泄漏面） |
| 主动推送 | `src/routes.js` `POST /api/inbound` | 插件 `qq_send` 工具 |
| 发文件 | `src/routes.js` `POST /api/inbound-file` | 文件名按文本规则；文本类文件内容只做拒发级扫描 |

配置在 `data/config.json` 的 `dsh.privacy`（默认值见 `src/config.js`）：`enabled` /
`allowedChats` / `mode`(redact|block) / `blockOnSecrets` / `blockedReply` / `noticeSuffix` /
`logMatches` / `scanFileContents` / `maxScanBytes` / `extraPatterns`。改完**立即生效**
（过滤器按配置内容做缓存，配置一变就重建），不需要重启。

实测（2026-10-11，本机安装版）：

```
打码级  POST /api/inbound → 200 {"privacy":{"redacted":[email×1,cn-mobile×1,win-user-path×1,ipv4×1]}}
        实际发出：测试A：邮箱 [已隐去:邮箱]，手机 [已隐去:手机号]，路径 C:\Users\***\dsh-workspace\note.txt，内网 [已隐去:IP]
拒发级  POST /api/inbound → 403 {"error":"隐私过滤拦截（命中 openai-key）"}
白名单  恢复 allowedChats 后同一条文本原样发出（一个字没动）
单测    node test/privacy.test.mjs → 26/26；回归 test/selftest.mjs → 41/41
```

> 注：桥回传回复那条闸门的**运行位置**在 fork 的 `reply()`，只有真实 QQ 消息触发 `/dsh` 时才会走到；
> 上面的实测覆盖的是同一个 `filterText()` 在推送路径上的行为 + 单测。要眼见为实，可以在**群里**
> 发一条 `/dsh 请原样回复：邮箱 someone@example.com` —— 群不在隐私白名单里，回复应当收到打码版。

## DSH 任务的权限（`dsh.permissionMode`，两种通道都生效）

常驻会话默认是「工作区可写 + 越界要审批」，而这类无人值守的会话里**没人应答审批 = 自动拒绝** ——
所以「帮我关机」「改系统设置」这种越界命令会直接失败。控制台「设置 → 聊天设置 → DSH 桥」里新增了
**「DSH 任务的权限」**下拉：默认 / `danger-full-access`（完全放开）/ `workspace-write` / `read-only`。

- **headless 通道**：该值当 `DSH_PERMISSION_MODE` 环境变量传给 `dsh headless`；
- **plugin 通道**：该值当 `permissionPreset` 写进 `POST /__dsh-qq/message` 请求体，
  dsh-qq 插件用 `ctx.permissionPresets.set(session, name)` 就地把会话切过去（**不丢上下文**）。

⚠️ `danger-full-access` = 沙箱全开 + 不弹审批：等于把本机交给能从白名单 QQ 号下指令的人。
唯一的门是 `dsh.allowedSenderIds`，务必只填自己的号。

实测（本机安装版，2026-10-11）：让 QQ 侧常驻会话执行
`shutdown /s /t 300` → 退出码 0，3 秒后 `shutdown /a` → 退出码 0；事后外部再跑 `shutdown /a`
得到 `(1116) no shutdown was in progress` —— 反证前面那条真的排程过。

> 工具面那一半在 DSH 侧（`agentPreset` / `agentPresets.mount`），详见
> dsh-qq 插件 README 的「常驻会话的『工具面』与『权限』」一节 —— 两边缺一不可：
> **协议上允许**（权限）与**手里有工具**（预设）是两件事。

## DSH 结果只留摘要进提示词（2026-10-13 修的设计缺陷）

**症状**：QQ 里发几次 `/dsh`，QQ Agent 的上下文很快被撑满、token 白烧。

**成因**（不是 bug，是设计缺口）：`/dsh` 这条命令本身**不进大模型**（`app.js` 里桥认领后直接 return），
但桥把结果回发时会经 `sender.sendTextBatch` → `store.appendSelf` **存成一条"我"的消息**；
而提示词的历史窗口（`store.historyCount`，默认 80 条）会把 `self` 消息整段渲染成
`[时间] 我：<全文>`（见 `prompt.js` 的 `formatEntry`）。于是一份几千字的长报告进了存档，
之后**每一轮**都跟着进提示词 —— 反复计费。

**修法（两层）**：

| 层 | 做什么 | 位置 |
|---|---|---|
| 精确 | DSH 结果进提示词时**只留摘要**：QQ 里照发全文；存档里 `text` 存全文、`promptText` 存摘要，渲染时优先用 `promptText` | `dsh-bridge.js` 的 `promptDigest()` + `store.appendSelf(promptText)` + `prompt.js` |
| 兜底 | 任何单条消息渲染进提示词时超过上限就截断并标注原字数（历史里已经存下的长报告靠这道） | `prompt.js` 的 `formatEntry()` |

**两个开关**（`data/config.json`）：

```jsonc
{
  "dsh":   { "resultPromptChars": 200 },   // DSH 结果进提示词的字数上限；0 = 完全不进上下文
  "store": { "maxPromptChars": 2000 }      // 单条消息进提示词的上限（兜底）；0 = 不限制
}
```

**实测（2026-10-13）**：

- 单元级：同一份 2600 字报告，进提示词 **2600 → 237 字**（约 11 倍）；`resultPromptChars:0` 时只留一行「已直接发到本会话（N 字），未进上下文」。
- 端到端（真实走 DSH 插件通道）：DSH 回答 592 字 → **QQ 收到全文 592 字，进提示词 234 字**。
- 短消息、非 DSH 消息渲染完全不变。

> 摘要长这样：`[DSH 执行结果已直接发到本会话（共 592 字，此处只是摘要）] 磁盘占用排查的常规顺序是：…`
> —— 模型知道"有这么个结果、大致说了什么"，但不跟着读一遍；需要细节时它会去读存档或用工具查。

## 按会话静默（只转发工具人，0 token）

**需求**：白名单里的**部分群**只当转发工具人 —— 不回复、不消耗 token。

**先说结论：靠"人格卡空着"做不到。** 人格卡只决定提示词里写什么人设；
要不要调模型是另一条链（`resolveContextTier(...).shouldRespond`）—— 空着人设照样调用模型、照样烧 token。

**做法**：`store.silentChats`（控制台「聊天设置 → 静默会话」）

```jsonc
{ "store": { "silentChats": ["group:759694210", "941199011"] } }
// 写法 group:123 / private:123；裸数字按【群】算（这个开关主要给群用）
```

静默会话里：

| 行为 | 结果 |
|---|---|
| 调用模型 | **完全不调**（真 0 token）|
| 消息存档 | 照常（历史与记忆素材不丢）|
| 链接媒体转发（确定性）| 照常（它在 ingest 阶段就跑，不经模型）|
| `/dsh` 命令桥 | 照常（桥在 app.js 里先认领，也不经模型）|
| 主动机会 / 积压 drain | 跳过 |
| 记忆整理 | 跳过（整理会调模型）|

**实现位置**（三处闸门 + 一个 helper）：

- `config.js`：`silentChats` 默认值 + `isSilentChat(chatKey, list?)`（`list` 只为可测性）；
- `orchestrator.js`：`onIncoming`（标已读后 return）、`wake`（标已读 + 结束等待会话后 return）、
  `#maybeConsolidateMemory`（直接 return）；
- UI：`06-settings-render.js` 输入框 + `08-modals.js` 进 chat 分支的 patch（数组按整体替换语义合并）。

**单测**：`test-silent-chats.mjs` 11 项（带前缀命中、裸号按群算、裸号不误伤同号私聊、严格匹配、脏值容错、空名单）。

> 与「屏蔽名单」的区别：屏蔽名单是**按人**（那个人不存档不触发），静默是**按会话**（整个群静音但消息照存）。
