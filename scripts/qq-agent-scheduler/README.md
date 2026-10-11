# QQ Agent DSH 定时开关脚本

三个计划任务，覆盖你的作息 + 校园网的实际情况。

| 你的需求 | 实现 |
|---|---|
| **每次开机、能真正上网后**自动启动 | 任务 `... Start on logon (network ready)`：**登录时**触发（**每 10 分钟重试、共 3 小时**）+ **每天 08:00** 兜底一次。判定"能上网"是**校验内容**而不是端口通不通（见下方校园网一节） |
| **周日至周四 23:20** 关闭 QQ Agent 和 SnowLuma | 任务 `... Stop nightly (Sun-Thu)`：每周 日/一/二/三/四 23:20 |
| **手动关机/重启/注销**时先执行关闭再走 | 任务 `... Session-end hook`：登录时挂一个隐藏监视进程，监听系统 `SessionEnding` + 轮询 `HasShutdownStarted`，触发即在**本进程内强杀**应用与 SnowLuma |

## 三个任务的窗口是**完全隐藏**的（2026-10-11 修）

**症状**：任务每 5 分钟跑一次，屏幕上闪一下控制台窗口，打断操作。

**原因**：动作原来是 `powershell.exe -WindowStyle Hidden -File …` —— **`-WindowStyle Hidden` 仍会创建控制台窗口并闪一下**；
而且 start 任务有**两个触发器各自带重复**，等于"每 5 分钟跑两次"（一天最多 192 次）。

**修法**：
1. 动作改成 `wscript.exe "run-hidden.vbs" "<脚本>.ps1"` —— `wscript.exe` 是 **GUI 子系统**，
   根本不创建控制台；`run-hidden.vbs` 里用 `WshShell.Run cmd, 0, False` 让子进程窗口也隐藏。
2. 任务设置加 `Hidden=True`（双保险）。
3. 重复只挂在 **logon 触发器**上，并把默认改成 **10 分钟 / 3 小时**（约 18 次），每天 08:00 那个触发器只跑一次。

**验证**：手动触发后日志 +2 行（说明包装跑通了），`conhost.exe` 数量 0 增量、可见窗口列表里没有新控制台。

> ⚠️ **`.ps1` 必须纯 ASCII**（PS 5.1 把无 BOM 的 .ps1 按 ANSI 读）。今天就因为给
> `install-tasks.ps1` 加中文注释，注释被解释成乱码后**吞掉了函数体那行 `return`**，
> 导致 `New-Action` 返回 null、任务注册失败。改完脚本务必复检：
> `Get-ChildItem *.ps1 | ForEach-Object { (($_ | Get-Content -Raw) -match '[^\x00-\x7F]') }`（全 False 才对）。

## 校园网（门户认证）怎么办

**不要把"端口能连上"当成"能上网"**：门户认证的网络里，TCP 握手往往直接成功，HTTP 也常被劫持到登录页，
所以纯 TCP 探测会骗人。这里的判定是：

1. 取 Windows 自己的连通性探针 `http://www.msftconnecttest.com/connecttest.txt`，
   **校验返回内容**是否为 `Microsoft Connect Test`；被门户劫持会返回登录页 → 判为**未上网**；
2. 兜底：对 `https://api.deepseek.com/` 发一次真实 TLS 请求（门户无法完成与源站的 TLS 交互）。

你要的效果因此是：**开机 → 登录系统（机器人先不动）→ 你完成校园网登录 → 最迟 10 分钟内机器人自动起来**。
（脚本自己也会在当前这一轮里等最多 3 分钟；超时就交给下一次重试，不会误启。重试窗口想改长：
`install-tasks.ps1 -RetryEveryMin 10 -RetryForHours 8`。）

随时自检当前算不算"能上网"：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Documents\deepseek-harness\default-workspace\qq-agent-scheduler\start-qq-agent.ps1" -CheckOnly
# 例：real internet = True  via=msftconnecttest  detail=content verified
```

## 文件

| 文件 | 作用 |
|---|---|
| `start-qq-agent.ps1` | 已在跑就什么都不做；否则做门户感知探测，通过后用 **WMI** 创建进程启动应用（脱离任务进程树），最后回报控制台状态。`-CheckOnly` 只探测 |
| `stop-qq-agent.ps1` | 先给 8 秒优雅关闭，再强制结束；然后按安装目录路径结束 SnowLuma；最后核对 3210/3000/3001/5099 是否释放（供 23:20 任务使用） |
| `watch-shutdown.ps1` | 关机钩子：`SessionEnding` + `HasShutdownStarted` 双信号，触发时**进程内**强杀应用与 SnowLuma（关机窗口只有几秒，起子进程不可靠）。`-TestFire` 可手动走一遍停机逻辑 |
| `install-tasks.ps1` | 注册三个任务（当前用户、交互式、无需管理员） |
| `uninstall-tasks.ps1` | 删除这三个任务（不碰 QQ Agent 本身） |
| `qq-agent-scheduler.log` | 运行日志（每次执行追加） |

> 脚本正文**故意只用 ASCII**：Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 按 ANSI 解析，
> 中文注释会在解析阶段直接崩且没有任何日志（本机踩过）。README 是 `.md`，随便写中文。

## 安装 / 卸载 / 常用命令

```powershell
$dir = 'D:\Documents\deepseek-harness\default-workspace\qq-agent-scheduler'

# 安装（含每日 08:00 兜底启动 + 关机钩子）
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install-tasks.ps1" -AddMorningStart -MorningAt 08:00

# 不带早间兜底（只登录时启动）
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install-tasks.ps1"

# 不想要关机钩子
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install-tasks.ps1" -AddMorningStart -NoShutdownHook

# 查看状态
Get-ScheduledTask -TaskName 'QQ Agent DSH*' | Get-ScheduledTaskInfo | Format-List TaskName,LastRunTime,LastTaskResult,NextRunTime

# 立即试跑
Start-ScheduledTask -TaskName 'QQ Agent DSH - Start on logon (network ready)'
Start-ScheduledTask -TaskName 'QQ Agent DSH - Stop nightly (Sun-Thu)'
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\watch-shutdown.ps1" -TestFire   # 验证关机钩子的停机逻辑

# 看日志
Get-Content "$dir\qq-agent-scheduler.log" -Tail 30

# 卸载
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\uninstall-tasks.ps1"
```

## 组策略关机脚本（已安装：同步等待，比监视进程更硬）

这是关机的**第二层保险**。两个机制并存，各管一段：

| 机制 | 覆盖 | 特点 |
|---|---|---|
| `watch-shutdown.ps1` 监视进程 | **注销 + 关机** | 事件一到立即进程内强杀，实测 <1 秒 |
| **本地组策略关机脚本** | **关机 / 重启** | 由组策略引擎执行，**Windows 会等待它跑完**（上限 `MaxGPOScriptWait`） |

已落盘的内容（改完执行了 `gpupdate /target:computer /force`，注册表同步确认过）：

- `C:\Windows\System32\GroupPolicy\Machine\Scripts\scripts.ini` → `[Shutdown]` 段
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Shutdown\0\0`
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\State\Machine\Scripts\Shutdown\0\0`
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System` → `MaxGPOScriptWait = 120`

实际执行的命令行（整条实测 **0.4 秒**，关机上代价可忽略）：

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -File "<此目录>\stop-qq-agent.ps1"
  -AppDir "C:\Users\noapi\AppData\Local\Programs\QQ Agent DSH"
  -GracefulWaitSec 0 -Quick
  -LogFile "<此目录>\qq-agent-scheduler.log"
```

⚠️ **`-AppDir` 必须写绝对路径**：组策略的*计算机*关机脚本是以 **SYSTEM** 身份运行的，
脚本里默认的 `%LOCALAPPDATA%\Programs\QQ Agent DSH` 会解析到 SYSTEM 的配置文件目录、找不到应用。
安装器已经自动把**你当前用户的绝对路径**烘进参数（这也是为什么它必须提权安装、且和用户绑定）。

### 安装 / 卸载 / 查看

```powershell
$dir = 'D:\Documents\deepseek-harness\default-workspace\qq-agent-scheduler'

# 安装（双击也行，会自己请求管理员；UAC 点「是」）
& "$dir\install-shutdown-gpo.cmd"

# 或者用命令行（同样会自提权）
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install-shutdown-gpo.ps1"

# 卸载
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\install-shutdown-gpo.ps1" -Uninstall

# 查看是否已生效
Get-Content "$env:SystemRoot\System32\GroupPolicy\Machine\Scripts\scripts.ini"
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Shutdown\0\0' | Select Script,Parameters
```

想在图形界面里核对/手改：`gpedit.msc` → **计算机配置 → Windows 设置 → 脚本（启动/关机）→ 关机**；
等待时间在 **计算机配置 → 管理模板 → 系统 → 脚本 → 最大等待时间**。

### 怎么确认它真的跑了

**下次真实关机/重启后**，看日志里有没有一条关机时刻的新记录（脚本以 SYSTEM 身份写入，该目录 SYSTEM 是 FullControl，权限没问题）：

```powershell
Get-Content "$dir\qq-agent-scheduler.log" -Tail 20
# 期望看到： --- stop requested ---  和  --- stop done, app processes left=0 ---
```

> 注：Windows 11 默认开启**快速启动**，"关机"其实是注销所有用户 + 内核休眠。注销那一步会触发上面的
> 监视进程（所以机器人一定会被关掉）；组策略关机脚本在快速启动下同样由关机流程执行。两层互为兜底。

## 附：清掉 Steam++ 守卫留下的探测任务（`clean-guard-tasks.ps1`）

Steam++ 守卫插件在探测"计划任务能不能拉起 Steam++"时会注册一批
`dsh-guard-missing-<pid>` 任务（动作指向故意不存在的 `X:\definitely\missing\Steam++.exe`）。
它们**只在登录时触发一次、不重复、也不弹窗**，但属于垃圾条目。

删它们**必须提权**（这些任务是用 `RunLevel = Highest` 注册的，普通权限会 `拒绝访问`）：

```powershell
# 会弹一次 UAC；日志写到 clean-guard-tasks.log
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\qq-agent-scheduler\clean-guard-tasks.ps1"
```

**刻意保留** `dsh-steampp-github-guard-launch`：它是守卫 README 推荐的那个任务，
作用是在每次登录时把 Steam++ 拉起来（虽然"程序启动 ≠ 加速启动"，但比没有强）。
确实不想要它就在上面那条命令后面加 `-Pattern 'dsh-steampp-*'`。

## 可靠性边界（说清楚，免得以为万无一失）

- **关机钩子是"尽力而为"**：正常关机/重启/注销会触发，实测 <1 秒完成停机。但**断电、长按电源、
  蓝屏、任务管理器强杀**这类情况下什么都跑不了 —— 好在那种情况下 Windows 本来也会把应用收走。
- **睡眠/休眠不触发关机钩子**：笔记本合盖睡觉时 `SessionEnding` 不会触发，机器人会继续在后台跑
  （SnowLuma 连接可能超时重连）。想要"睡眠前也关掉"的话，钩子里加一个 `PowerModeChanged`
  （`Suspend`）分支即可，需要的话说一声。
- **23:20 的关闭不补跑**：如果那时电脑是关机/睡眠状态，任务不会在第二天早上突然执行
  （避免"一开电脑就被关掉"）。启动任务则相反，开了 `StartWhenAvailable`，并按 logon 后 10 分钟一次重试 3 小时。
- **需要登录才启动**：应用是带托盘的 Electron 程序，必须在你的桌面会话里运行，所以用"登录触发"
  而不是"开机触发"（后者跑在 session 0，窗口起不来）。
- 想要比"尽力而为"更强的关机保证，已经用上面的**组策略关机脚本**做了（Windows 同步等待，上限 120 秒）。

## 设计上踩过的坑（都在脚本里留了注释）

1. **启动必须用 WMI**：计划任务在实例结束时会把**自己的进程树**一起回收（实测：应用起来了、几秒后消失）。
   WMI 创建的进程挂在 `WmiPrvSE` 下，任务结束也带不走。
2. **任务名不能含冒号**：`... (Sun-Thu 23:20)` 会注册失败报 `0x80070057`，所以时间写在任务描述里。
3. **`-At` 参数要 DateTime**：给周/日触发器传字符串 `'23:20'` 同样报 `0x80070057`。
4. **探测要校验内容**：见校园网一节。
5. **脚本必须纯 ASCII**：见上。
6. **组策略计算机脚本跑在 SYSTEM 下**：默认的 `%LOCALAPPDATA%` 会解析到 SYSTEM 的配置文件目录，
   必须把用户的绝对 `-AppDir` 烘进参数（安装器已处理）。
