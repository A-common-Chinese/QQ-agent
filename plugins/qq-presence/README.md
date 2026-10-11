# qq-presence —— 在线状态守卫（关机前请勿打扰）

## 它解决什么问题

QQ 的在线状态是**服务器侧**的：进程被杀掉后，状态会一直挂在那里。所以

- 机器人被关掉（计划任务 / 策略 / 手动）→ 希望它显示**「请勿打扰」**，别让人以为它还在；
- 下次上线 → 如果那个「请勿打扰」是**我们设的**，就自动改回**「在线」**。

## 怎么做的（两个时机）

| 时机 | 由谁触发 | 动作 |
|---|---|---|
| **关闭前** | 核心的 `before-shutdown` 钩子（**优雅退出**：托盘退出等） | `api.setPresence('dnd')` |
| **关闭前**（强杀那条路） | `stop-qq-agent.ps1` 直接 `POST /api/presence {"status":"dnd"}` | 同上 |
| **上线时** | `activate()` 里起一个后台重试循环 | 读记账；是 DND 就 `api.restorePresenceIfDnd()` |

> ⚠️ 为什么强杀那条路必须靠脚本：`Stop-Process -Force` / `taskkill /F` **不会执行任何 JS**，
> 插件不可能感知到那次关闭。所以"关闭前设 DND"有两个入口，缺一不可。

## 关键机制：为什么要记账

SnowLuma **没有** `get_online_status`（实测 `1404 unknown action`），当前状态读不回来 ——
所以"上次是不是我们设的请勿打扰"只能自己记：核心把它写进 `data/presence.json`，
插件下次启动读到 `dnd: true` 才动手。**你自己手动设的状态不会被它动。**

审计：每一次状态变更都追加一行到 `data/presence.log`（插件的 `api.log` 走 `console.log`，
而宿主不落盘插件输出，所以必须自己留证据）。

## 上线恢复的真实日志（本机 2026-10-11）

```
2026-10-11 12:49:52  FAIL status=10 source=plugin-activate → OneBot set_online_status 请求失败：[ECONNREFUSED] 127.0.0.1:3000
2026-10-11 12:49:56  OK   status=10（在线） source=plugin-activate
```

第一行说明**重试是必要的**：插件激活可能早于 OneBot 连上（默认重试 20 次 × 3 秒）。

## 状态码

`status` 是 QQ 协议里的整数（NapCat 约定）：**10 在线 / 30 离开 / 40 隐身 / 50 忙碌 / 60 Q我吧 / 70 请勿打扰**。
改默认值：`data/config.json` 的 `presence.dndStatus` / `presence.onlineStatus`
（SnowLuma 的文档里没有这个接口，这份映射来自实测；如果你的 QQ 上显示的不是「请勿打扰」，换一个码即可）。

## 依赖

- 核心 `src/presence.js`（设置 + 记账 + 审计）
- 核心 `POST/GET /api/presence`（给脚本和调试用）
- 核心 `before-shutdown` 钩子 + `api.setPresence / api.getPresence / api.restorePresenceIfDnd`
  （契约已写进 `doc/extend_development/plugin-development.md` §3.2 / §6）
- 清单里声明 `permissions: ["presence_control"]`
