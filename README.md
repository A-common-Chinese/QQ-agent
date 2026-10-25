# QQ Agent（桌面端）

![平台](https://img.shields.io/badge/platform-Windows%20%7C%20Electron-lightgrey)
![版本](https://img.shields.io/badge/version-v0.7.2-blue)
![测试](https://img.shields.io/badge/tests-33%20suites%20(npm%20test)-brightgreen)
![许可](https://img.shields.io/badge/license-MIT-green)

一个跑在你自己电脑上的 QQ 群聊机器人：装完双击启动，扫码登录，填个模型 Key 就能用。事件驱动 + 无状态会话架构，每次处理的 token 成本恒定可控；所有操作都在图形控制台里完成，不用碰命令行。

接 QQ 有**两种方式**（v0.7.0 起）：原来的 SnowLuma（OneBot v11，玩法最全），或 **QQ 开放平台的官方机器人**（合规、不因协议违规被封号）。两者凭据、白名单、日志、记忆完全独立，在控制台「QQ 接口」页里二选一。

> **这是一个 fork。** 上游是 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)，本仓库是 **[A-common-Chinese/QQ-agent](https://github.com/A-common-Chinese/QQ-agent)**，当前版本 `v0.7.2`。
> 上游功能一个没删。[这个 fork 改了什么](#这个-fork-改了什么) 一节是全部改动的清单，其余章节对上游和本 fork 同样适用。

## 这是什么

| 能力 | 说明 |
|---|---|
| 像真人一样混群 | 被 @ 或被叫到时回话，平时看心情插嘴；会发文字、表情包、戳一戳，会引用、会 @ 人，也知道什么时候该闭嘴 |
| 记住每个群友 | 长期记忆 + 记忆卡，按 QQ 号记人、按群记事，下次聊天自然带上；控制台里随时可看、可改 |
| 说得像谁由你定 | 人格卡系统：每个会话独立选卡，共用段 + 本卡特有段 + 回复示例 + 按需场景 |
| 看得懂图、上得了网 | 视觉模型直接看消息里的图片；内置 6 家搜索服务（含免 Key 的 Bing 网页解析），还能自己加兼容服务 |
| 花多少看多少 | 每次调用的 token 与成本精确记录，按天 / 按会话 / 按模型统计，缓存命中率、峰谷分时、图片计费口径都标出来 |
| 零编程门槛 | 配置全在控制台点选：白名单从 QQ 里直接勾群，模型从目录里点选，不用查群号、不用写配置文件 |
| 能指挥本机 DSH | QQ 里发 `/dsh <指令>`，交给本机 DeepSeek Harness 执行并回传结果（本 fork 加的第一件事） |
| 两种方式接 QQ | **OneBot（SnowLuma）**：玩法最全；**官方机器人（QQ 开放平台）**：合规、无协议封号风险。凭据/白名单/日志/记忆互相独立 |

**技术架构**（沿用上游，本 fork 未改动主干）

1. 群聊消息持续写入本地 JSON 存档，每条带时间与已读状态；
2. 有新消息时新开一个独立会话，提示词 = 静态系统提示（人设 / 规则 / 策略）+ 存档摘要 + 本次新消息；
3. 会话结束即弃置，LLM 层面零历史，单次成本不随聊天量膨胀；
4. 处理期间新来的消息只写存档，本轮结束后发现未读就自动再开一轮，直到清空；
5. 长期信息走记忆工具持久化，跨运行生效。

整体组成：协议端走 OneBot v11 正向 WebSocket（默认配 SnowLuma，任何兼容实现可换）；大脑是任意 OpenAI 兼容 API；桌面壳是 Electron（托盘常驻、开机自启、关窗不退出、端口占用自动让位）；控制台是零框架原生 HTML/CSS/JS，明暗双主题。安全边界上，工具天然绑定会话（模型无法把消息发到别的群）、发送有白名单与限频、联网抓取带 SSRF 防护（DNS 校验 / IP 固定 / 手动跟重定向）。

## 接入方式：OneBot 与官方机器人

| | OneBot（SnowLuma） | 官方机器人（QQ 开放平台） |
|---|---|---|
| 协议 | 第三方 OneBot v11（非官方） | 官方开放平台 API |
| 账号风险 | ⚠️ 违反《QQ 软件许可及服务协议》8.2.2(6)，可能**封 QQ 号** | ✅ 不因协议违规被封；风险只在内容合规 |
| 玩法 | 全量群消息、主动发言、拍一拍、贴表情、改群名片 | 群/单聊收发、被动回复、主动发言（群主授权）、群管理（禁言/成员/黑名单） |
| 缺口 | — | 无拍一拍 / 贴表情 / 改群名片 / 撤回他人消息（官方无接口） |
| 前置 | 本机跑 QQ + SnowLuma | 开放平台创建机器人 → 个人认证 → 拉进自己是群主的群 |
| 群消息范围 | 全部消息 | 默认只推 @；全量需群主在手机 QQ 授权「接收全量消息」 |
| 主动消息 | 随时 | 需群主授权「主动推送消息」，1000 条/群/日；被动回复 5 分钟内有效 |

**怎么配**：控制台 → 「QQ 接口」页 → 选通道 → 填配置 → 测试 → 设为当前通道 → 重启。

- OneBot：WS 地址 / HTTP 地址 / 令牌 / 自动拉起 / 「设为当前通道」
- 协议端的检测、启停、卸载：**设置 → 服务 → 「协议端管理（可选）」**
- 官方机器人：AppID / AppSecret（只存本机，页面脱敏）/ 环境（正式·沙箱）/ 群消息模式（全量·仅 @）
- 官方通道的 openid 不用手抄：卡片下方「最近收到的会话」点「加入白名单」

**协议端是外部依赖**（v0.7.0 起）：

- 控制台**不代管**协议端的安装与登录，也不随包分发第三方程序；没检测到协议端时，「QQ 接口」页只显示官方机器人通道
- 检测到之后才会出现 OneBot 选项；协议的检测/启停/卸载都在 **设置 → 服务 → 「协议端管理（可选）」**，QQ 接口页只保留连接配置与日志
- **默认不读取**第三方程序的账号目录/令牌文件（`snowluma.autoReadToken` 默认关），令牌以手动填写为准
- 「卸载协议端」只对**外部目录**生效；随应用解包/自带的目录会被保护拒绝删除

**两套东西互不影响**：

| 项 | OneBot | 官方机器人 |
|---|---|---|
| 白名单 | 群号 / QQ 号 | `group_openid` / `user_openid` |
| 日志 | `data/logs/snowluma/` | `data/logs/qqbot/` |
| 记忆 | `group:<群号>` | `group:<openid>`（`identityLinks` 预留映射，后续打通） |

## 下载安装

| 方式 | 怎么做 |
|---|---|
| **安装包（推荐，只想用）** | 去 **[最新 Release](https://github.com/A-common-Chinese/QQ-agent/releases/latest)** 下载 `QQ-Agent-DSH-Setup-0.7.2.exe`（Windows x64，约 83 MB），双击安装后从桌面/开始菜单快捷方式启动 |
| **源码（要改代码或跑测试）** | 见下面[快速开始](#快速开始) |
| **更新** | 启动 8 秒后自动检查一次本仓库的 GitHub Releases，发现新版本时在控制台提示并可下载安装包（12 小时结果缓存、下载后按资产 `sha256` 校验）。**不会自动安装**，安装包要自己跑一遍。不想要就在设置里关掉（`update.enabled` / `update.checkOnStartup`） |

首次启动后，控制台的体检卡会告诉你还缺什么：填模型接口地址与 Key → 选模型 → 勾白名单 → 补齐协议端（SnowLuma）与 QQ 运行环境。

## 这个 fork 改了什么

| # | 改动 | 位置 | 状态 |
|---|---|---|---|
| 1 | **DSH 桥**：QQ 里发 `/dsh <指令>`，交给本机 DeepSeek Harness 执行并把结果回传 QQ | `src/dsh-bridge.js`、`src/routes.js`、控制台「设置 → 聊天设置 → DSH 桥」 | v0.4.0 起 |
| 2 | **出站隐私过滤**：DSH 内容送往非白名单会话时按规则打码 / 整条拒发 | `src/privacy.js`（与 DSH 插件侧同源同规则，两层互兜） | v0.4.0 起 |
| 3 | **在线状态守卫**：被关掉前把 QQ 设为「请勿打扰」，下次上线自动改回「在线」 | `plugins/qq-presence/`、`src/presence.js`，审计在 `data/presence.log` | v0.4.0 起 |
| 4 | **按会话的权限档位**：默认 / `read-only` / `workspace-write` / `danger-full-access` | 控制台「DSH 桥 → DSH 任务的权限」，`dsh.permissionMode` | v0.4.0 起 |
| 5 | **定时开关与关机联动**：确认能上网再启动、每晚定时关闭、关机注销前先收尾，全程无窗口 | [`scripts/qq-agent-scheduler/`](scripts/qq-agent-scheduler/)（部署到 `C:\ProgramData\qq-agent-scheduler`） | v0.4.0 起 |
| 6 | **自动更新（阶段 1）**：读本 fork 的 Releases 检查 + 下载安装包，不自动安装 | `src/updater.js`、`data/update-check.json` | v0.5.0 |
| 7 | **隐私默认关闭**：禁用「意见收集」「金句上传」入口，匿名遥测默认关；技能/插件市场保持可用 | `ui/app/10-feedback.js`（`COMMUNITY_UPLOADS_ENABLED = false`）、`src/config.js`（`telemetry.enabled: false`） | v0.5.0 |
| 8 | **人设系统重构**：人格卡 + 控制台人设页 + AI 生成卡 + 原版卡导入；未分配人格的会话直接静默 | `src/personas.js`、`src/persona-import.js`、`src/persona-filter.js`、`src/config.js`、`src/prompt.js`、控制台「人设」 | v0.5.0（本次重点） |
| 9 | **记忆卡系统**：通用卡 / 群聊卡 / 个人卡 / 话题卡，按需注入、每轮字数预算 | `src/memory-cards.js`、`src/memory-cards-prompt.js`、控制台「记忆」 | v0.5.0 |
| 10 | **插件 / 技能可删除**：移入回收站目录，可恢复 | `src/routes.js` → `data/trash/extensions/<id>-<时间戳>` | v0.5.0 |
| 11 | **人格切换感知插件** `persona-switch-notice`：模型能意识到自己刚被换了人格 | `plugins/persona-switch-notice/`，**默认关闭**，反应文本可留空 | v0.5.0 |
| 12 | **DSH 侧插件（独立仓库）**：桥的本体，路由 `/__dsh-qq/message`、工具 `qq_send` / `qq_send_file`、隐私过滤、按会话权限白名单、agent 预设挂载 | [A-common-Chinese/dsh-qq](https://github.com/A-common-Chinese/dsh-qq) | v0.4.0 起 |
| 13 | **同步上游** | 把上游 `11577ba..fdfd325` 的改动**合并进本 fork**（上游作者 Kondius 的提交；不是我们向对方提 PR，也没有向对方提交任何改动） | v0.5.0 |
| 14 | **双通道接入**：新增官方 QQ 机器人通道（传输层抽象 + `src/transport/qqbot.js`），`transport.active` 切换，未配置时自动回落 OneBot | `src/transport/`、`src/app.js`、`src/config.js` | v0.7.0 |
| 15 | **界面重构**：「SnowLuma」页改成「QQ 接口」（两张卡统一「连接配置 → 运行状态 → 运行日志 → 应用日志」+ ⓘ 说明弹窗）；顶栏通道胶囊 + 状态菜单；设置里只留跳转入口 | `ui/app/03-snowluma.js`、`ui/app/01-boot.js`、`ui/index.html`、`ui/app/06-settings-render.js` | v0.7.0 |
| 16 | **双通道隔离**：白名单两套（`allow` / `allowQqbot`，openid 自动迁移）、日志分目录、顶栏就绪点按通道换语义 | `src/app.js`、`src/channel-log.js`、`src/routes.js` | v0.7.0 |
| 17 | **协议端可选化**：未检测到协议端时只显示官方通道；检测/启停/卸载集中到 **设置 → 服务 → 「协议端管理（可选）」**（QQ 接口页只留连接配置与日志）；默认不读第三方令牌（`snowluma.autoReadToken=false`）；「卸载协议端」仅对外部目录生效、自带目录受保护 | `ui/app/03-snowluma.js`、`ui/app/06-settings-render.js`、`src/app.js`、`src/routes.js`、`src/config.js` | v0.7.0 |
| 20 | **通道映射（群号 ↔ openid）**：设置 → 服务 → 通道映射，把官方 openid 与 OneBot 群号绑成同一逻辑会话；两种模式「读合并」（读两边、各写）与「只合并未来」（写入镜像）；解绑默认仅停合并，A 模式可选复制绑定期间新增的印象/卡（卡片整卡复制）；解绑保留 7 天可撤销 | `src/identity-links.js`、`src/memory.js`、`src/memory-cards.js`、`ui/app/06-settings-render.js` | v0.7.2 待发布 |
| 19 | **记忆自动写卡 + 分层记忆可见**：会话结束后按 6 小时冷却自动把聊天记录/印象/小时摘要/语义卡交给整理模型，生成并更新「群卡 + 个人卡」（`memoryCards.autoUpdate` 可关）；记忆页新增「记忆整理」配置条（间隔/上限/包含静默会话 + 立即整理全部 + 进度），数据来自 `conversation-memory` 插件的 `memory-v2` 与 `semantic-cards` | `src/orchestrator.js`、`src/memory-layers.js`、`src/memory-cards.js`、`src/routes.js`、`ui/app/05-memory-settings.js` | v0.7.2 待发布 |
| 18 | **可用性修复**：保存 OneBot 配置 / 自动读取令牌开关（PATCH→POST）；官方通道下顶部体检卡常驻导致的"自动刷新"（就绪检查与横幅改按通道判断 + 体检卡内容去抖）；OneBot 卡片补「设为当前通道」；未安装提示可点击跳转协议端管理 | `ui/app/00-core.js`、`ui/app/01-boot.js`、`ui/app/03-snowluma.js`、`ui/app/06-settings-render.js` | v0.7.1 |

### 人设系统（v0.5.0 重点）

一张人格卡由四部分组成，注入时按 `共用段 → 本卡特有段 → 回复示例 → 命中的场景` 拼装：

| 组成 | 内容 | 复用范围 |
|---|---|---|
| 共用段 `personaShared` | `core`（你是谁）+ `voice`（说话方式），一处改全库生效 | 所有勾选了「用共用段」的卡 |
| 本卡特有 `variant` | 这张卡独有的性格、边界、称呼习惯 | 单卡 |
| 回复示例 `examples` | 每组三格：群友说 / ✗ 错误示范 / ✓ 正确示范，最多取 4 组注入 | 单卡 |
| 按需场景 `scenarios` | 触发词（编辑器把逗号分隔的词自动转正则）+ 该场景下的反应，命中才注入 | 单卡 |

| 控制台「人设」页 | 能做什么 |
|---|---|
| 会话分配 | 每个白名单会话单独选卡，支持批量分配、支持设为默认卡 |
| 卡管理 | 新建 / 复制 / 编辑 / 删除；内置「小鲸鱼」卡只读 |
| 卡片编辑器 | 表单式，只打字，格式由系统拼 |
| AI 生成人格卡 | 写一句描述 → 模型返回结构化卡片 → 预填进编辑器 → 点保存才落盘；可用 `personaPolicy.genModel` 单独指定模型 |
| 导入原版卡 | 检测人格市场下载的卡与旧的 `roleText`，一键拆成新结构（示例自动识别「你不要 / 你可以」式写法，AI 味黑名单段剥给全局策略） |
| AI 味黑名单 | `personaPolicy.bannedPhrases`：默认只作提示词约束（`prompt`），可切 `filter` / `both` 在出站时把命中的短语直接删掉（`src/persona-filter.js`），命中留痕在 `data/banned-phrase-hits.log` |

未分配人格卡的会话 = **静默**：消息照常存档、链接照常转发、`/dsh` 照常响应，但不调模型、0 token。旧的按会话静默名单（`store.silentChats`）仍然可用。

本机实测：人设注入从 7414 字降到 3015 字（**-59%**），整轮提示词约 **-21%**。

### 记忆卡系统

| 卡类型 | 存哪 | 什么时候注入 |
|---|---|---|
| 通用卡 | `data/memory-cards/generals/<id>.json` | 每轮都带（多张卡，标 ★ 的那张是全局默认；人设卡可挂靠指定通用卡） |
| 群聊 / 私聊卡 | `data/memory-cards/<会话>/group.json` | 只在该会话带 |
| 个人卡 | `data/memory-cards/persons/<QQ号>.json` | 该人「在场」时带，只带摘要 + 对应会话的印象。「在场」= 最近 20 条消息里出现过，或本轮被点名 |
| 话题卡 | `data/memory-cards/<会话>/topic_*.json` | 关键词命中 → 拉全文（最多 2 条）；未命中 → 只给标题索引；再随机闪回 2~3 张的摘要 |

预算与开关都在配置的 `memoryCards` 段：每轮总预算默认 **1500 字**，超出按优先级截断；最多带 6 个在场成员；「最近 N 条」「被点名」两个在场判定可分别关；闪回张数可设 0。个人卡按 QQ 号为主键，记着他在各个群用的昵称和别名，印象分三层——通用 / 群聊 / 私聊；控制台「记忆」栏目是通用（基本事实）/ 群聊 / 个人三个分区，群 ↔ 人可互相跳转。话题卡的注入路径已实现，控制台目前只有通用 / 群聊 / 个人三类卡的界面，话题卡按上面的文件布局放进来即生效。

### 在 QQ 里指挥本机 DSH

前置：DSH 侧装 [dsh-qq](https://github.com/A-common-Chinese/dsh-qq) 插件，QQ 侧在「设置 → 聊天设置 → DSH 桥」填 DSH 的监听地址与令牌（不填则桥完全不生效，行为与上游一致）。

| 命令 | 作用 |
|---|---|
| `/dsh <任务>` | 在当前会话里执行，会记住上下文，可连续追问 |
| `/dsh 新会话 <任务>` | 丢掉上下文，开一条新会话 |
| `/dsh 状态` | 看当前会话 id、是否在跑、轮次与自动轮换阈值 |
| `/dsh 停` | 终止正在跑的任务 |
| `/dsh 帮助` | 上面的说明 |

几个刻意的取舍：命中前缀的消息不进触发判定，所以不花机器人的模型额度、也不受响应档位影响；结果默认只有摘要（`dsh.resultPromptChars`，出厂 200 字）进提示词，长报告不会把上下文撑满；需要额外发文件就让 DSH 那边调 `qq_send_file`。

### 这不是「又把 QQ Agent 塞回 DSH」

| | 上游 | 本 fork |
|---|---|---|
| QQ Agent 本体 | 独立运行，不依赖 DSH | 完全一样，不装 DSH 也照常工作 |
| DSH 的角色 | — | 只是一个可选的外部能力：有人发 `/dsh <指令>` 时，把这一条指令交给本机 DSH 执行，再把结果送回 QQ |

## 隐私说明

| 会离开本机的请求 | 默认 | 说明 |
|---|---|---|
| 模型 API 调用 | 必需 | 只发往你自己填的 Base URL |
| 联网搜索 | 开 | 默认用 Bing 网页解析（免 Key）；换成别的服务时请求发到对应厂商；设置里可整体关掉 |
| 匿名遥测 | **关** | 上游默认会把匿名用量上报到作者服务器，本 fork 出厂即关（`telemetry.enabled`）。关掉后不发任何统计 |
| 意见收集 / 金句上传 | **禁用** | 入口在本 fork 里直接关掉，点了只会提示「本版本不向原作者服务器上传」；市场功能（技能 / 插件）保持可用 |
| 云端全局屏蔽名单 | 拉取 | 每 5 分钟从 `www.kondius.cn` 拉一次名单；首次时若云端为空而本机已有名单，会把本机名单上传一次用于初始化。不想让 QQ 号出现在公共名单里就别用这个功能 |
| 版本检查 | 开 | 只读 `api.github.com` 的 `releases/latest`，默认 12 小时一次；下载安装包走 GitHub Release 资产 |
| 消息存档 / 记忆 / 人设 | 本地 | 全部在 `data/` 下，不上传 |
| 第三方协议端账号目录 | **不读取** | 默认不扫描 SnowLuma 等程序的配置/令牌（`snowluma.autoReadToken` 默认关，开启后也只读取令牌字段） |

DSH 内容送往 QQ 时的出站过滤（`src/privacy.js`）：

| 级别 | 命中内容 | 处理 |
|---|---|---|
| block | 私钥块、`sk-…` / `sk-ant-…` / `ghp_…` / `AIza…` / `AKIA…` / `xox…`、JWT、口令与密钥赋值、带凭据的数据库连接串 | **整条拒发**（fail-closed，不给「改一改再发」的余地） |
| redact | 邮箱、手机号、身份证、银行卡号、`C:\Users\…` 这类用户目录路径、UNC 主机、IPv4、本机用户名与主机名 | 就地打码为 `[已隐去:…]` |

白名单会话（默认 `private:85946573`，改成你自己的 QQ 号）一个字不动；其它会话全过。支持自定义规则、文本类文件内容扫描（限文本扩展名且 ≤ 2 MB），命中只记规则名与次数的留痕。打码后什么都不剩，等同于拒发。

> ⚠️ 风险按通道区分：**OneBot 通道**通过非官方方式接入 QQ 协议，账号存在被风控/封禁的风险，建议用小号；**官方机器人通道**不涉及协议违规，但需遵守平台内容规范（见下节「合规说明」）。SnowLuma 是独立第三方项目，受其自身 EULA 约束，本仓库不分发其代码；QQ 是腾讯专有软件，本仓库同样不分发 QQ 本体。使用者自行承担全部风险。

## 合规说明（含「这算不算反代」）

**结论：不算反向代理，也不是中转。** 这是「本地客户端直连官方 API」：每个部署者装在自己电脑上，填**自己的** API Key，程序在本机直接请求模型官方端点；安装包里不含任何 Key，也没有对外提供接入点。

判定标准是三个问题：**谁的 key？有没有共享？有没有对外提供入口？**

| 形态 | 判定 |
|---|---|
| 用户各自填自己的 Key，本机直连 | ✅ 正常客户端用法 |
| 安装包内置 Key、多人共用一把 Key、托管额度池 | ❌ 违反《DeepSeek 开放平台服务协议》2.4（禁止共享/暴露 Key） |
| 搭服务器用你的 Key 转发给别人用（真·反代/中转站） | ❌ 违规，且可能构成转售 |

### DeepSeek 侧条款（[《DeepSeek 开放平台服务协议》](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html)，2026-04-29 生效）

> **1.1** 您可以基于上述开放平台服务，将 DeepSeek 模型的能力集成于各种下游系统、应用或功能，用于预期的目的和具体的场景中，**向内外部的终端用户提供服务**。

→ 把模型接进 QQ 机器人、服务群友，是被明确允许的下游集成。

> **2.4** 您通过账号创建的 API key 是您调用开放平台 API 接口的必要凭证……**不要与他人共享或对外公开您的 API key，不要将其暴露在浏览器或其他客户端代码中**。

→ 所以本项目：**安装包不带 Key**、**不提供托管/共享额度**，每个部署者自己填。

> **3.3 / 3.4** 您应作为生成式人工智能服务提供者，承担相应法律责任；服务涉及具有舆论属性或者社会动员能力的，应当依法开展安全评估、算法备案等程序；**对终端用户的输入和输出进行审查**，建立关键词表、违法内容特征库等风险识别、过滤机制。

→ 群里对外服务时，内容审查义务在部署者身上（本项目内置 `src/privacy.js` 出站过滤与安全模式可复用）。

### 腾讯侧条款

[《QQ开放平台服务协议》](https://q.qq.com/wiki/business/protocol/) **4.2 条**明确写了 AIGC 机器人：

> 特别地，对于您在开放平台上创建的**具备生成式人工智能能力的机器人（AIGC 机器人）**……您可以选择使用腾讯提供的大模型服务，您也可以选择使用自身或第三方授权提供的大模型服务。**当您使用大模型服务时，您需充分承诺保障该服务已经获得提供服务所需的合法资质（包括但不限于已向相关主管部门完成生成式大语言模型服务上线备案或算法备案）**……并向您的用户做充分的告知和说明。

同协议 **6.3 条**：

> 您创建的机器人**不得编造、传播虚假信息**。发布或传播利用您创建的机器人服务制作生成的非真实信息时，**依法应当以显著方式予以标识**。

→ 官方通道是平台正式支持的业务形态；义务集中在「模型服务有备案」「生成内容有标识」「不编造虚假信息」。

对比 OneBot 通道，[《QQ 软件许可及服务协议》](https://ti.qq.com/agreement/index.html) **8.2.2(6)**：

> 除非法律法规允许或腾讯书面许可，您不得……**通过非腾讯开发、授权的第三方软件、插件、外挂、系统，登录或使用本软件和/或本服务**。

→ 这是 OneBot/SnowLuma 模式的根本风险：处罚对象是**你的 QQ 号**（8.3.1 明确可「中止、终止您对相应 QQ 号码的使用」）。

### 本项目的边界

- ✅ 安装包**不含任何 API Key / AppSecret**，全部由部署者填在本机
- ✅ 不提供「共享 Key / 托管额度 / 中转转发」功能
- ✅ 官方通道凭据只存本机 `data/config.json`，接口回传时脱敏（只回 `hasAppSecret`）
- ⚠️ 群里对外服务时：请自行确保内容合规、有必要时标识 AI 生成；大规模公开运营/收费需自行完成备案等合规程序

## 快速开始

三步（推荐）：

```bash
git clone https://github.com/A-common-Chinese/QQ-agent.git
cd qq-agent
npm install
npm run setup    # 自动下载 SnowLuma + 固定版本便携 QQ
```

然后双击 `启动QQ机器人.bat`（或 `npm start`），在 SnowLuma 页签点「启动 QQ」，扫码登录即可。想只开控制台看数据，用 `启动控制台.bat` 或 `npm run server`（浏览器打开 http://127.0.0.1:3210）。

装完之后：设置页顶部体检卡会指出还缺什么 → 填接口地址和 Key → 选模型 → 勾白名单 → 去「人设」页给每个会话分配一张人格卡（没分配的会话只存档不回复）。

手动安装（`npm run setup` 下载失败时）：

1. **协议端**：SnowLuma 是独立第三方项目，从其官方渠道获取后解压到项目根目录，目录名保持 `snowluma`；
2. **便携 QQ**：机器上已装过 QQ 的话，先完全退出 QQ（含托盘），直接跑 `npm run setup`，脚本会从注册表找到已装的 QQ 并复制一份到 `runtime/qq-portable/`（约 1.6 GB，自动跳过聊天记录）；也可以下载 <https://www.kondius.cn/netdisk/api/download/QQ_9.9.33_260813_x64_01.exe> 正常安装一遍，退出后重跑 `npm run setup`。QQ 9.9.x 用的是腾讯自研 HummerSetup 安装器，不接受 NSIS/Inno 的静默开关，所以这一步没法自动完成。
3. 便携 QQ 用独立 `--user-data-dir`，与日常使用的 QQ 数据完全隔离；关闭时只杀路径匹配 `runtime/qq-portable` 的进程。
4. 换 QQ 版本前注意：`npm run setup` 会把协议栈里写死的两处客户端版本声明（`CLIENT_BUILD`、`BUILD_VERSION_SHORT`）对齐到实际运行的版本（当前 `9.9.33-51802`），改前会备份成 `snowluma/index.mjs.orig`；登录被拒时优先怀疑版本不匹配，而不是网络或账号。

常用命令：

| 命令 | 作用 |
|---|---|
| `npm install` | 装依赖 |
| `npm run setup` / `setup:check` | 一键下载 SnowLuma + 便携 QQ（幂等）/ 只检查是否就绪 |
| `npm start` | 桌面端启动 |
| `npm run server` | headless 模式，浏览器开 http://127.0.0.1:3210 |
| `npm test` | 全量测试（26 个套件） |
| `npm run test:coverage` | 覆盖测试（模块层 + 全部 HTTP 接口 + 端到端 + 静态界面层 + 界面接线） |
| `npm run test:all` | 两套一起跑 |
| `npm run pack:qq` | 把自己机器上的 QQ 打包成免安装包，输出 SHA256 和可粘贴的配置 |
| `node scripts/sanitize-release.mjs` | 分享部署副本前清空 Key / 白名单 / 存档 / 登录态（先加 `--dry-run` 看会清什么） |

### 扩展（插件 / Skill，沿用上游机制）

| 类型 | 放哪 | 靠什么生效 | 谁决定何时执行 |
|---|---|---|---|
| 确定性型（插件） | `plugins/<id>/` | 能力 `providers` / 钩子 `hooks` | 核心代码：满足条件必然执行，不经过 LLM |
| LLM 型（Skill） | `skills/<id>/` | 工具 `registerTool` + 提示词片段 | 模型：看工具说明自己判断 |

规则能写死就写插件，要理解人话就写技能。选错类型的后果是功能静默失效（不报错、不崩、就是没反应），动笔前先读 [doc/extend_development/plugin-development.md](doc/extend_development/plugin-development.md) 与 [skill-development.md](doc/extend_development/skill-development.md)，共同机制见 [skill-reference.md](doc/extend_development/skill-reference.md)。

开关只有 `config.skills[id].enabled` 一处；扩展的提示词片段优先级被强制压在核心安全规则之下；控制台「技能」「插件」两个页签会直接告诉你某项为什么没生效（未启用 / 依赖缺失 / 加载失败 / 模型不支持）。本 fork 新增：**删除**插件或技能不会真的删文件，而是移到 `data/trash/extensions/<id>-<时间戳>`，需要就手动挪回原目录恢复。热重载默认开启，共享机器建议在 `config.extensions.hotReload` 里关掉。

## 版本记录

| 版本 | 时间 | 内容 |
|---|---|---|
| **v0.7.1** | 2026-10-24 | 协议端可选化收尾：未装协议端时「QQ 接口」只显示官方通道；检测/启停/卸载迁到 **设置 → 服务 → 协议端管理（可选）**；默认不读第三方令牌；「两种接入方式只能选一种」仅在双通道时显示，未安装提示可点击跳转。修复：保存 OneBot 配置报 `PATCH /api/config`（改 POST）、官方通道下体检卡常驻导致顶部闪烁/自动刷新（就绪检查与横幅按通道判断 + 体检卡内容去抖）、OneBot 缺「设为当前通道」、误插 `</details>` 结构错位 |
| **v0.7.0** | 2026-10-24 | **双通道**：新增官方 QQ 机器人通道（传输层抽象 / `src/transport/`；AppID+AppSecret 本地配置；被动回复自动带 msg_id；@ 判定兼容全量模式 mentions）。**界面重构**：「QQ 接口」页替代 SnowLuma 页（两卡统一连接配置/运行状态/运行日志/应用日志 + ⓘ 说明）；顶栏通道胶囊（绿=官方/蓝=OneBot）+ 状态详情菜单；设置里只留跳转入口。**双通道隔离**：白名单 `allow`/`allowQqbot` 两套（openid 自动迁移）、日志分 `snowluma/` 与 `qqbot/` 目录、存档支持 openid 会话。修复：@ 判定导致官方通道不回、存档 openid 会话打不开/消失、顶栏第 3 点不回填、QQ 接口页输入被打断。随包技能 `dsh-agent` 1.0.2；协议端改为可选外部依赖（默认不读第三方令牌、可卸载、自带目录受保护） |
| v0.6.5 | 2026-10-24 | 启动动画修复（"更新后不播"：标记改存版本号）；随包技能 1.0.1 |
| v0.6.4 | 2026-10-24 | 人设卡重构（core 迁移、`{{owner}}` 占位符、内置卡查看/复制、共用段可选、core/voice 分开关）；用量图表（tokens 输入/输出拆分、悬浮提示修复、输出放大 ×N）；启动动画微调 |
| v0.6.3 | 2026-10-24 | 启动动画（角色升起→停顿→左移出字 + 配音）；720×888 原生素材、去青边、去水印 |
| v0.6.0–0.6.2 | 2026-10-22 | 工具全局开关保护、图片背景预设（小鲸鱼/指认/深海海报）、磨砂性能优化、新会话自动配人设 |
| **v0.5.0** | 2026-10-21 | 人设系统重构（人格卡 / 控制台人设页 V2 / 表单式编辑器 / AI 生成卡 / 原版卡导入 / AI 味黑名单 / 未分配即静默）；记忆卡系统（通用 / 群聊 / 个人 / 话题，按需注入 + 1500 字预算 + 三层印象 + 关系网跳转，多张通用卡 + 人设挂靠）；自动更新阶段 1（读本 fork Releases + 下载安装包，12 小时缓存、sha256 校验，不自动安装）；隐私默认关闭（意见收集 / 金句上传入口禁用、匿名遥测出厂即关）；插件与技能支持删除进回收站；新插件 `persona-switch-notice`；同步上游 `11577ba..fdfd325`（把 Kondius 的提交合并进本 fork）；安装包名规范为 `QQ-Agent-DSH-Setup-${version}.exe` |
| v0.4.4 | 2026-10-13 | `/dsh 新会话` 重置 + 状态显示轮次与自动轮换阈值 + 轮换提示；DSH 结果只留摘要进提示词（修上下文被长报告撑满）；控制台加「结果进入提示词的字数上限」开关；按会话静默（只存档 / 只转发，0 token）；状态守卫审计日志去重；长自聊天消息回溯清理脚本 |
| v0.4.0 | 2026-10-11 | fork 的第一批改动成形：DSH 桥、出站隐私过滤、在线状态守卫 `qq-presence`、按会话权限档位、定时开关与关机联动脚本、独立打包配方 |
| v0.3.x | 2026-09 | 跟随上游版本线，fork 尚未引入自有功能 |

完整提交记录见 `git log`；改动背后的原因与踩过的坑写在 [BUILD-DSH.md](BUILD-DSH.md) 里，例如：headless 会话续接失败要能自动清记录重试、`Stop-Process -Force` 不会执行任何 JS 所以「关闭前设 DND」必须有脚本这条兜底路径、SnowLuma 没有 `get_online_status` 所以状态只能自己记账、宿主不落盘插件的 `console.log` 所以诊断信息搬进了 HTTP 接口与文件、计划任务用 `-WindowStyle Hidden` 仍会闪窗所以改用 `wscript` + VBS、无 BOM 的 `.ps1` 会被 PowerShell 5.1 按 ANSI 解析所以调度脚本全保持纯 ASCII。

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/` | 核心逻辑（约 62 个模块）。关键文件：`app.js` 主循环与 ingest、`orchestrator.js` 会话编排、`prompt.js` 提示词组装、`transport/`（传输层：`base.js` 接口与能力位、`onebot.js`、`qqbot.js` 官方机器人适配器、`index.js` 工厂）、`channel-log.js` 分通道日志、`personas.js` / `persona-import.js` / `persona-filter.js` 人设系统、`memory.js` / `memory-cards.js` / `memory-cards-prompt.js` 记忆与记忆卡、`dsh-bridge.js` DSH 桥、`privacy.js` 出站过滤、`presence.js` 状态守卫、`updater.js` 自动更新、`tools.js` 工具集、`routes.js` HTTP 接口、`config.js` 默认值与会话级解析 |
| `ui/` | 控制台前端（零框架原生 JS，`ui/app/*.js` 分片加载）+ `ui/persona-plaza/`、`ui/plugin-market/`、`ui/skill-market/` |
| `plugins/` | 随包发布的两个插件：`qq-presence`、`persona-switch-notice`；用户后装的插件也放这里 |
| `skills/` | 随包携带 `dsh-agent`（默认禁用，工具 `dsh_task`）；其余为用户后装技能的落点 |
| `electron/` | 桌面壳：`main.js`、`preload.cjs` |
| `doc/extend_development/` | 扩展开发与提示词管线文档，随安装包发布（控制台「让 AI 写插件」的提示词要读它） |
| `scripts/` | 工具脚本：`setup.mjs`、`pack-qq-portable.mjs`、`sanitize-release.mjs`、`new-skill.mjs`、校验类脚本，以及 `qq-agent-scheduler/`（定时开关与关机联动的 PowerShell/VBS） |
| `test/` | 33 个自测套件（含 `transport-test.mjs`、`qqbot-transport-test.mjs`）+ 覆盖测试入口，另含隐私规则专项 |
| `data/` | 运行数据，整体不进版本库：`config.json`、`memory/`、`memory-cards/`、`messages/`、`sessions/`、`logs/`、`presence.json` / `presence.log`、`dsh-sessions.json`、`update-check.json`、`updates/`、`trash/extensions/` |
| `build/` `assets/` | NSIS 自定义安装脚本 `installer.nsh`、图标 |
| `dev-tools/` | 假 OneBot 端到端调试器 |
| `server/` | 社区 API（作者侧部署用，打包时被排除） |
| `.github/workflows/` | 便携 QQ 包的上传中转 workflow |

## 构建

```bash
npm install
npx electron-builder --win nsis
# 产物：dist/QQ-Agent-DSH-Setup-<version>.exe
# 另附 electron-builder 生成的 latest.yml / blockmap；本 fork 的更新器走 GitHub Releases API，不依赖它们
```

版本号与打包参数在 `package.json` 的 `build` 段（`artifactName: QQ-Agent-DSH-Setup-${version}.exe`，`asar: false`，装完就是可读可改的源码）。`electron-builder-dsh.yml` 是另一份配方，用独立 `appId` / `productName` 打出一个与上游正式版**并行安装、互不覆盖**的 `QQ-Agent-DSH-Setup.exe`；v0.6.x 起本 fork 的 Release 产物统一走 `--config electron-builder-dsh.yml`（独立 appId，与上游并行安装）。

本机的完整打包配方（pnpm 垫片、Electron 与 nsis/winCodeSign 走 npmmirror 预置缓存、装完之后的迁移顺序）写在 **[BUILD-DSH.md](BUILD-DSH.md)**，先读它再动手。

重装前记得备份 `resources\app\plugins\`：后来在控制台装的社区插件不在本仓库里。

测试：`npm test` 跑 33 个套件。其中 `test/setup-qq-version.mjs` 会去检测本机安装的 QQ，在没装 QQ 也没跑过 `npm run setup` 的机器上那 1 项会红，属环境缺失不是代码问题。`npm run test:wiring`（含在 `test:coverage` 里）需要额外装 jsdom：`npm i -D jsdom`，没装时该套件打印提示并自动跳过。

## 许可

本项目以 MIT 许可发布（见 [LICENSE](LICENSE)）。上游由 **Kondius** 开发与维护，本 fork 由 [A-common-Chinese](https://github.com/A-common-Chinese) 维护。前置依赖 SnowLuma 是独立项目，受其自身许可约束，不受本项目许可覆盖；QQ 客户端版权归腾讯所有，本仓库不随代码分发 QQ 本体。

## 致谢

- **[K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)** —— 本 fork 的上游：机器人本体、控制台、记忆与提示词体系都是他做的
- **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)** —— 上游的起点，「仿真群友」的思路来源
- **SnowLuma** —— QQ 协议端（OneBot v11）提供者
- **[OneBot](https://github.com/botuniverse/onebot)** 生态与各协议实现作者 —— 没有这套标准就没有"自己接 QQ"这条路
- **腾讯 QQ 开放平台** —— 提供了官方机器人能力，让"不违反协议地接 QQ"成为可能
- **DeepSeek（深度求索）** —— 模型与开放平台 API

做这个 fork 的动机很朴素：平时就用 DSH，每天在 QQ 和终端之间来回切很烦，那就把指令直接丢进 QQ，让本机的 DSH 去跑。顺手做了几件一直想做的小事——出站隐私过滤、权限按会话收口、机器人被关掉时挂个「请勿打扰」。v0.5.0 这次动的是自己每天看的东西：人设和记忆。以后大概也只会在我自己用得上的地方继续加东西。
