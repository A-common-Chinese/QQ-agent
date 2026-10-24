# dsh-agent —— 让 QQ 侧的模型自己调 DSH

配套 [dsh-qq](https://github.com/A-common-Chinese/dsh-qq) 插件的 QQ Agent 技能：注册一个 `dsh_task` 工具，
模型可以据此在**本机 DSH** 上执行任务（读日志、跑测试、整理文件……），结果以摘要形式回到对话里。

## 安装

把本目录拷到 QQ Agent 的 `skills/` 下：

```
<安装目录>/resources/app/skills/dsh-agent/
```

或放进用户目录的同名位置后，在控制台「技能」页启用 **DSH 远程执行**。
QQ Agent 安装包已默认携带本技能（`mode=off`，需要手动打开）。

## 配置（设置 → 技能 → DSH 远程执行）

| 键 | 默认 | 说明 |
|---|---|---|
| `scope` | `whitelist` | `whitelist` = bot 能回话的会话；`private` = 仅私聊；`mention` = 仅被点名 |
| `permissionMode` | `read-only` | 传给 dsh-qq 的权限预设：`read-only` / `workspace-write` / `danger-full-access` |
| `maxPerHour` | `3` | 每会话每小时调用上限（0 = 不限） |
| `timeoutSec` | `25` | 单次最多等多久；超时会如实告诉模型"可能仍在跑" |
| `bridgeUrl` | `http://127.0.0.1:19387/__dsh-qq/message` | dsh-qq 插件路由 |
| `bridgeToken` | 空 | 与 dsh-qq 插件的 `bridgeToken` 一致 |

## 安全说明

- 默认 **关闭**：装了也不生效，必须到技能页启用
- 默认 **只读**：模型不能改文件/装东西，除非你把权限改到 `workspace-write` 或更高
- 只在 **白名单会话** 生效：非白名单消息根本不会进入模型，也就没有工具调用
- 每小时限额 + 单次超时，避免长任务把对话卡死
- 所有调用写 QQ Agent 日志：`[dsh-agent] ✅/❌/⏱ <会话> …`

## 和 `/dsh` 命令的区别

| | `/dsh <指令>` | 本技能 |
|---|---|---|
| 触发 | 用户手动发命令 | **模型自己判断要不要调** |
| 花模型 token | 否（命令不进模型） | 是（工具调用要过模型） |
| 结果 | 直接回群 + 摘要进上下文 | 摘要作为工具结果进上下文 |
| 适用 | 你自己临时使唤它 | 让它自己"顺手把事办了" |

两条通道并存，不互相影响。
