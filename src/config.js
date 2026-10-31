// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
// ── 多实例 PROFILE ─────────────────────────────────────────────────────
// QQ_AGENT_PROFILE=2 时数据目录变成 data-2/、端口整体 +100，
// 这样同一台机器可以跑两个机器人实例（两个 QQ 号）而不互相踩。
// 优先级：QQ_AGENT_DATA_DIR（显式覆盖）> PROFILE 推导 > 默认 data/
//
// ⚠️ 必须在这里就生效（而不是在 UI 或 app.js 里改）：
//   DATA_DIR 是整个进程的根路径，配置、会话、记忆、表情库全挂在它下面。
//   晚一步设置就会有一部分文件写到主实例的目录里，造成两个实例数据互相污染。
import { profileSuffix, portOffset } from './profile.js';

// 2026-09-19 起 https：http 版 301 跳转且明文传输可被 MITM 篡改成本展示。
// 证书与内容已实测可达（同一路径，nginx 直接 200）。
export const FIXED_PRICE_REMOTE_URL = 'https://kondius.cn/qq-agent/model-prices.json';
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, `data${profileSuffix()}`);
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  // ── 自动更新（期 1：检查 + 提示 + 下载，不自动安装）──────────────
  update: {
    enabled: true,
    // github = 读本 fork 的 Releases（推荐）；server = 兼容旧版读作者服务器的 version.json
    source: 'github',
    githubRepo: 'A-common-Chinese/QQ-agent',
    checkOnStartup: true,
    intervalHours: 12,
    autoDownload: false,
  },
  // ── 匿名遥测 ────────────────────────────────────────────────────
  // 上游默认会把「匿名用量统计」上报到作者服务器；本 fork 默认关闭（见 README 隐私说明）。
  telemetry: {
    enabled: false,
  },

  // ── 自动备份 ────────────────────────────────────────────────────
  backup: {
    enabled: true,
    dir: 'D:/QQ-Agent-Backups/auto',
    everyHours: 12,          // 每隔多少小时备一次
    keep: 7,                 // 保留最近几份
    includeMessages: true,   // 是否包含 messages/ 与 sessions/
    includeResources: true   // 是否包含 resources/app 下的 plugins、skills
  },
  // ── 记忆卡（群聊 / 个人 / 基本事实 按需注入）─────────────────────
  memoryCards: {
    enabled: true,          // 总开关：关掉则完全不注入【记忆卡】段
    maxChars: 1500,         // 每轮记忆卡总预算（字符）
    maxPersonCount: 6,      // 最多带几个在场成员
    presentWindow: 20,      // "在场"判定：最近多少条消息里出现过
    presenceWindow: true,   // 在场判定：用"最近 N 条出现过的人"
    presenceMention: true,  // 在场判定：用"被点名的人"
    flashbackCount: 2,      // 随机闪回几张话题卡（0=关）
    topics: {               // 话题卡自动生成（时限与个人卡「约定」不同：半天/一天/七天/长期）
      autoEnabled: false,   // 默认关，打开后记忆整理时顺带抽取话题
      maxPerChat: 20,       // 每个会话最多保留多少张话题卡
      halfDayHours: 12,     // 半天
      dayHours: 24,         // 一天
      weekDays: 7,          // 七天
      monthDays: 30,        // 三十天
      sensitiveFilter: {    // 敏感话题过滤（标题/关键词命中即不生成、不注入）
        enabled: true,
        words: []
      }
    },
    impressionScope: 'auto',
    // 记忆卡批量整理（一次性处理所有有新消息的会话）
    batchEnabled: true,
    batchIntervalMs: 6 * 60 * 60 * 1000,   // 6 小时
    batchMaxChats: 20,                     // 单次最多处理多少个会话（控制成本）
    batchIncludeSilent: false,             // 批量整理是否包含静默会话（默认排除，静默=不花 token）
    autoUpdate: true,
    backupRetentionDays: 30,   // 删除产生的 .deleted-* 备份保留天数（0 = 永不自动清理）
  },
  // ── 语义触发（P1：只观察不生效）──
  decision: {
    enabled: false,              // 总开关（新装默认关）
    observeOnly: true,           // 只记录分数，不改变是否接话
    observeTriggered: false,     // 连「被 @/关键词命中」的触发批也记分（标 action=triggered-batch，仅观察）
    liveReply: false,            // 主动接话总开关（需配合 perChat[chatKey].live=true 才对某群生效）
    liveMaxPerDay: 5,            // 每群每天最多主动接话次数
    liveMinIntervalMs: 600000,   // 同群两次主动接话的最小间隔（默认 10 分钟）
    embedding: {
      providerId: '', baseUrl: '', apiKey: '', model: '', dims: 0,
      autoDetectDims: false,     // 预留：自动探测维度（暂不实现）
      // scope: 'group' = 群消息/卡片（旧口径）；'interest' = 人设/兴趣/技能（看"与我相关"）
      corpus: { scope: 'group', semanticCards: true, hourlySummaries: true, recentMessages: 200 },
      batchSize: 32, timeoutMs: 8000
    },
    thresholds: { low: 0.25, high: 0.55, samplePercent: 100 },
    budget: { cooldownSec: 120, dailyLimitPerChat: 200, maxJudgePerChatPerDay: 300 },
    // L2 判定：chain 为多通道（按顺序兜底），支持本地/远程混合；perChat.judgeChainIds 可指定某群用哪些
    judge: {
      enabled: false,
      batchWindowMs: 2000, maxBatch: 8,
      dedupeMs: 300000, samplePercent: 100,
      chain: [],
      providerId: '', baseUrl: '', apiKey: '', model: '',
      timeoutMs: 2500, maxTokens: 128, temperature: 0, perChat: {}
    },
    perChat: {} // auto=通用+本会话 / all=全部 / model=只给通留给模型自己查
  },
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    // 备选模型列表：主模型在重试后仍失败时，逐个用备选模型重试直至成功。
    // 每项 { model, provider? }：provider 留空则沿用主模型的 provider/baseUrl/apiKey；
    // 填了 provider 则切到该提供商（用它的 baseUrl + Key）。按顺序尝试。
    fallbackModels: [],
    // 按输入类型分开选择模型（可选）：留空则都用上方主模型 api.model。
    // 图片/视频输入需要模型支持对应模态；文字输入用纯文本模型即可（可省成本）。
    // ⚠️ 这两个字段现在是**真的会被使用**的：llm.js 检测到请求里带图片/视频部分时，
    //    会用对应字段的模型替换主模型（仅主调用路径；记忆整理/备选模型降级不受影响）。
    //    此前它们只是存下来给 UI 看，没有任何代码读取 —— 填了不起作用。
    visionModel: '',            // 图片输入专用模型（留空 = 用主模型）
    videoModel: '',             // 视频输入专用模型（留空 = 用主模型）
    // 视频走哪条路。两条路**互斥**，不会同时喂 ——
    // 同时喂等于同一内容重复计费，而且多数网关会因格式冲突直接 400。
    //   auto   配了 videoModel 就认为你有全模态模型 → 原生读视频；否则抽帧；
    //          抽帧 Skill 不可用（没装 ffmpeg）就只给元信息
    //   native 强制原生视频输入（把视频地址作为 video 部分发给模型）
    //   frames 强制抽帧（把视频变成若干张图片，任何视觉模型都能用）
    //   off    不喂画面，只给时长/分辨率等元信息（纯文本模型 / 省 token）
    videoMode: 'auto',
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    // 视频输入（模型能不能吃 video 部分）。与 vision 相互独立：
    //   勾了 vision + video → 有人发 GIF 动图时，用 ffmpeg 转成 ≤480px / ≤24 帧的
    //                        mp4，按 video 部件发给模型（llm.js 自动切 videoModel）
    //   勾了 vision 没勾 video → GIF 按图片原样发（部分视觉模型能直接读动图）
    //   没勾 vision → 看图工具整个不存在，GIF 自然也看不到
    // 默认关闭：猜错"模型支持视频"的代价是请求 400，比不启用更糟（同 videoModel 的口径）。
    video: false,
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 思考强度（实际落成各厂商参数由 src/thinking.js 内置方言表负责）：
    //   thinkingEffort off/low/medium/high/xhigh/max —— off=能思考的模型也明确关闭，
    //     其余档位=开启且强度递增（渠道不支持高档时向下就近映射）
    //   thinkingMode  off/auto/on（旧三态，effort 为空时的兼容口径）
    //   thinkingBudget token 数 —— 思考预算，仅 Claude 兼容 / 部分网关生效，0=不指定
    // 目的：防"雷霆大思考"（几千 token 的 reasoning 拖慢且烧钱）或该思考的完全不思考。
    thinkingMode: 'auto',
    thinkingEffort: '',
    // thinkingBudget（思考预算 token 数）有真实读点：src/thinking.js
    // 在 Claude 兼容/部分网关方言下把它落成预算参数。没有 UI 入口（有意为之：
    // 绝大多数渠道不认这个参数），需要时手改 config.json 即可生效。
    thinkingBudget: 0,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表地址由 src/community.js 固定为官网公开表（FIXED_PRICE_FEED_URL），
    // 任何代码都不得再读/写 api.priceRemoteUrl —— 它是已废弃的历史字段，
    // loadConfig 时统一剔除（见 stripObsoleteFields），避免磁盘旧值继续冒充"生效地址"。
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  // providersImported（导入来源标记）与 budget 容器是历史残留死字段（零读点），
  // loadConfig 时由 stripObsoleteFields 一并剔除。
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false,          // true 时图片下载允许内网地址（仅本地测试/自建图床）
    // ── 浏览锁定 ──
    // ── 浏览锁定 ──
    // 把"机器人能访问哪些域名"收成白名单。开启后 fetch 与发图**逐跳**校验
    // （含重定向目标），不在清单内一律拒绝。
    browseLock: {
      enabled: false,
      hosts: [],                  // 允许的域名，如 ['zh.wikipedia.org', 'example.com']（支持子域）
      siteSearchUrl: ''           // 站内搜索模板，如 'https://example.com/search?q={query}'
    }
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    autoReadToken: false,      // 默认关：不主动读取 SnowLuma 的账号目录/令牌文件（改为手动填写）
    // 第二实例默认连自己的 OneBot 端口（3001/3000 + 偏移），
    // 否则两个实例会同时连到主实例的 SnowLuma，消息被处理两遍。
    wsUrl: `ws://127.0.0.1:${3001 + portOffset()}`,
    httpUrl: `http://127.0.0.1:${3000 + portOffset()}`,
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // ── 记忆解释器（qq-memory-studio，独立零依赖目录）──────────────────
  // 解释器由 QQ Agent 用 Electron 自带运行时拉起（用户不用装 Node），
  // 接口经 /api/memory-studio/* 中转（见 src/memory-studio.js）。
  memoryStudio: {
    enabled: true,           // 总开关：关掉后 start 直接拒绝
    dir: '',                 // 解释器目录；留空 = 自动探测 tools/memory-studio 等候选
    port: 7788               // 首选端口；被占用时自动顺延（+1…+9）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    // 系统提示词覆盖（可选）：非空时**整体替换** buildSystemPrompt 的默认行为准则。
    // ⚠️ 高级功能：默认提示词包含安全规则/工具协议/反AI味等关键约束，
    //    覆盖后这些全部失效，需自行在覆盖文本里写明。留空 = 用内置默认提示词。
    // 可用占位符：{botName} {roleText} {participation}
    systemPromptOverride: ''
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 按会话独立人设：{ [群号/QQ号]: { roleText, participation, customRules, systemPromptOverride } }
  // key 是白名单会话的 id（群号或私聊 QQ 号），值是该会话覆盖全局 persona 的字段；
  // 只覆盖写在这里的字段，其余（botName/selfNickname 等账号身份）永远用全局值 ——
  // 名字换了会和 @ 判定、存档里"我"的称呼对不上。
  personaByChat: {},
  // 统一人设（人设页开关）：true = 所有用一套全局人设；false = 人设页展示分会话
  // 独立编辑入口（personaByChat 生效）。运行语义与 UI 一致（personaForChat 在
  // 统一模式下不读 personaByChat）—— 否则统一开关形同虚设：旧分会话条目会
  // 继续静默覆盖全局人设，而 UI 已把编辑入口藏起来了。
  personaUnified: true,
  // 共用段（老架构）：会被拼到所有 useShared=true 的卡前面。
  // 2026-10-24：core 默认清空 —— 不同卡人设不同，core 属于各卡自己；
  // 老配置里残留的 core 会在启动时一次性搬进「内置只读卡」。
  personaShared: { core: '', voice: '' },
  // 新会话（白名单里第一次说话的好友/群）自动分配的人格卡 id；空 = 用内置卡/第一张卡
  personaDefaultId: '',
  // 接入方式（P2 起）：onebot = 现在的 SnowLuma/NapCat；qqbot = 官方 QQ 机器人
  // accounts 是数组，P2 先只用第 1 个，留扩展位；appSecret 会被 GET /api/config 脱敏删除
  transport: {
    active: 'onebot',                 // onebot | qqbot | both
    qqbot: {
      enabled: false,
      intents: 0,                     // 0 = 由适配器按群/单聊事件自动取
      accounts: [
        { name: '', appId: '', appSecret: '', env: 'production', groupMode: 'all' }
      ]
    }
  },
  // 接入白名单（SnowLuma/OneBot：群号 / QQ 号）
  allow: { groups: [], private: [] },
  // 官方机器人白名单（openid，与上面互不影响；官方通道只认这套）
  allowQqbot: { groups: [], private: [] },
  // 未来：QQ 号 ↔ openid 映射（记忆打通用）；现在两套分开存，映射留空
  identityLinks: [],
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 会话级自动重试：整轮运行失败且一条消息都没发出时，自动从头再来几次。
  // 0 = 关闭自动重试（失败会话仍可在会话页手动点「重试」）。
  // ⚠️ 已发出过消息的会话绝不自动重试 —— 重试会导致群里看到两遍同样的话。
  sessionRetryAttempts: 2,
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    // 发送去重窗口（毫秒）：同一会话在该窗口内完全相同的文本只发一次。
    // 防"模型重复调用 send_message / OneBot 超时看似失败但实际已发出、上层重试再发"导致的重复发言。
    // 0 = 关闭去重。默认 8000（8 秒）。
    dedupeWindowMs: 8000
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 活跃模式（chatActive）：1/2/3 档被召唤触发响应后，模型若认为话题值得持续参与，
  // 会在 finish 时带回话题总结 → 该群进入"活跃期"：忽略档位判定必响应，
  // 提示词注入话题锚点，模型每次自判"是否仍在话题上"，偏离则 finish("话题结束") 退出。
  // 让"开始活跃"容易、"停下"由模型自主判断 —— 恰好是档位系统的反向补充。
  chatActive: {
    enabled: false,
    ttlMinutes: 30   // 活跃期最长持续时间（分钟）：到期自动退出，兜住"模型忘了结束"
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // 存储
  storage: {
    messageRetentionDays: 7,   // 消息存档保留天数（0=永久）；只清消息，不碰记忆卡
  },
  privacy: {
    storeMedia: false,         // 预留：true 时额外保留媒体副本
    mediaRetentionHours: 24,   // 图片/文件/语音等媒体引用保留小时数（0 不自动清）
  },
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // 单条消息渲染进提示词的最大字数（超出截断并标注）。历史里可能已经躺着早期存下的
    // 长报告，光靠新逻辑管不到它们，这道上限是兜底。0 = 不限制。
    maxPromptChars: 2000,
    // ── 上下文读取档位（决定哪些消息会触发响应）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定是否响应。
    // 2026-09-25 改版：档位不再决定读取条数 —— 各档统一读 historyCount 条，
    // 档位退化为纯粹的"触发方式开关"（被艾特/关键词/随机/全部）。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全响应
    historyCount: 70,           // 各档统一：响应时随【已读信息】带多少条历史
    historyCountPerChatEnabled: false,   // 是否按群单独设置已读条数
    historyCountByChat: {},     // { chatKey: 条数 }，仅 perChat 开启时生效
    dynamicHistory: {           // 动态上下文条数（按群活跃度分档）
      enabled: true,
      shadow: true,             // 先影子模式：只记录推荐值，不改变实际行为
      windowMinutes: 10,
      hysteresisMinutes: 10,
      min: 20,
      max: 150,
      budgetChars: 4000,
      buckets: [{ maxRate: 3, count: 30 }, { maxRate: 8, count: 70 }, { maxRate: Number.POSITIVE_INFINITY, count: 110 }]
    },
    keywords: [],               // 2 档的关键词表
    randomPercent: 10,          // 3 档：y% 概率
    // ── 提示词锚点（前缀缓存深化，2026-09-25）──
    // 连续触发时，把上一轮发给模型的【记忆】+【已读信息】前缀**原样复用**：
    // 本轮只在其后追加新沉淀的已读条目（"新已读信息"），新增群友的印象放到
    // 未读信息之后的【新加入成员】段 —— 除追加部分外前缀字节不变，命中缓存。
    // 追加条数超过 maxExtraRead 就整体重置（回到标准窗口，重新开始锚定）：
    // 已读信息是按条计费的，无限追加会"为了省钱花更多钱"。
    promptAnchor: {
      enabled: true,
      maxExtraRead: 5           // 相对锚定时的已读条数，最多额外追加几条
    },
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局滑条
    // 静默会话：只存档、只做确定性功能（链接转发、/dsh 命令），**永不调用模型**（0 token）。
    // 写法 'group:123456' / 'private:123456'；裸数字按**群**算（这个开关主要给群用）。
    silentChats: [],
  // 未分配人格卡的会话是否也算静默（v0.5 起的默认规则；关掉 = 只认上面的名单）
  silentWhenUnassigned: true,
    // 分群峰谷（2026-09-18 四象限改版）：unifiedTier=false 且 peakSchedule.enabled 时，
    // 每个群可以有自己的峰谷档位 { [群号]: { peak: 0~100, valley: 0~100 } }。
    // 时段（start/end）全局共享 —— 每群分开拖两个点的档位值即可。
    groupPeakPos: {},           // { [群号]: { peak: 0~100, valley: 0~100 } }，未设置的群跟随全局峰谷双点
    keepSessionFiles: 0,        // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
    // ── 峰谷切换（按时段自动调整响应档位）──
    // 允许用户设定"高峰/低谷"两个时段及各自生效的响应档位（滑条位置 0~100）。
    // 例如：白天上班时间（高峰）设为 1 档仅艾特省 token，晚上（低谷）设为 4 档全响应。
    // 命中某时段时用该时段的档位覆盖全局滑条；都不命中用全局滑条。
    peakSchedule: {
      enabled: false,           // 总开关
      // 高峰时段：start~end（"HH:MM"，跨零点也支持，如 22:00~06:00）
      peak: { start: '09:00', end: '18:00', sliderPos: 10 },   // 高峰档位（默认 1 档仅艾特）
      // 低谷档位（默认 4 档全响应）。**只认 sliderPos**：时段语义是
      // "高峰窗口外一律 = 低谷"（peakWindowActive 只读 peak.start/end），
      // valley.start/end 是旧版死字段，loadConfig 时剔除。
      valley: { sliderPos: 100 }
    }
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 全局屏蔽名单（"上云"）：[QQ号, ...]
  // 与 blocklist 的区别：blocklist 是按群单独屏蔽；globalBlocklist 对**所有群**生效——
  // 一旦某人被加进来，他在任何群里的消息都会被丢弃（含私聊）。
  // 用于"这个人在所有群里都不该再被机器人看到"的场景（如骚扰者、广告号）。
  globalBlocklist: [],
  // 本机豁免名单：无管理密钥时"本机解除全局屏蔽"的持久化记录。
  // 云端名单仍含这些 id（移除需要密钥），但本机用 getGlobalBlocklist() 时扣除它们。
  // 独立字段 —— 5 分钟一次的云端同步会整体覆盖 globalBlocklist，但不会碰这里。
  communityExemptions: [],
  // 指令禁言：群内任何人 @机器人 并发送指定指令后，机器人暂时把响应档位固定为 1 档（仅艾特）。
  // 用于群里太吵时让机器人"闭嘴"，只回应被直接点名。
  commandMute: {
    enabled: true,              // 总开关
    command: '/安静',            // 触发指令（需与 @机器人 同条消息）
    durationMin: 30,            // 禁言时长（分钟），0 = 直到手动解除
    // 多口令：每个口令可以设不同时长（分钟，0 = 永久，需手动解除）
    // [{ id, command: '/睡觉', durationMin: 30 }]；为空时回退到上面的单个 command/durationMin（兼容老配置）
    commands: [],
    releaseCommand: '/起床',     // 解除指令（同样需要与 @机器人 同条消息）
    releaseAdminOnly: false,      // true = 只有管理员能解除；false = 群里任何人都能解除
    // 运行态（不在 UI 编辑）：{ [群号]: 禁言到期时间戳 }
    active: {}
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: ''                             // 专用模型 id（useChatModel=false 时生效）
  },
  // 工具与技能（skill 化开关）
  //
  // ⚠️ 边界（避免"两个开关打架"）：
  //   tools.*  = **工具**层的开关：全局 / 分类 / 单个工具
  //   skills.* = **能力**层的开关：每个 Skill 一个命名空间
  // 最终"能不能用"由 tool-registry.getToolAvailability() 统一计算，
  // 顺序是：tools.enabled → skill 生效 → requires 能力 → 分类 → 单工具 → 运行期依赖。
  // 模块不允许再写自己的 isXxxEnabled 影子开关。
  // ── 转发白名单（三档权限；成员必须先在 allow 白名单里）──────────────
  //   free      = 谁让转都行
  //   limited   = 模型自行判断要不要转（留空 = 没有这一档）
  //   adminOnly = 只有 adminQQ 能让模型转
  forwardRules: {
    free: [],
    limited: [],
    adminOnly: [],
    adminQQ: '',              // 管理员 QQ；空 = 取白名单第一个私聊（部署者）
    adminName: '',            // 部署者称呼；空 = 人设变量 {{owner}} 用「群主」
  },
  // ── 安全模式：写入存档前脱敏（密码/账号/电话等）────────────────────
  //   enabled 默认 true；level 1=内置全拦 2=只用 customText 里的自定义规则
  safeMode: {
    enabled: true,
    level: 1,
    customText: ''
  },
  // ── 静默会话被 @ 时 ──────────────────────────────────────────────
  //   enabled 打开后：静默会话里有人 @ 机器人时按 mode 处理
  //   mode 1 = 最小上下文调一次 API 判断是否"要求转发"（是→放行正常流程；否→回固定话术）
  //   mode 2 = 完全不调 API，一律回固定话术
  silentAt: {
    enabled: false,
    mode: 1,
    replyText: '（这个群我暂时不说话，有事私聊我）'
  },
  // ── 指令消息在上下文里怎么显示 ────────────────────────────────
  //   raw      = 原文照常（默认）
  //   hide     = 完全不进上下文
  //   describe = 换成「用户发来了 /xxx 指令，功能是：…」
  commandContext: {
    mode: 'raw'
  },
  tools: {
    enabled: true,              // 全局开关：false 时所有工具都禁用
    overrides: {},              // { [toolId]: boolean } 单个工具的启用状态
    // 跨会话发送（默认关）：开启后 send_message 支持 targetChatKey，
    // 允许模型按用户指示把消息发到白名单内的其它群/私聊。
    // 这是社交敏感操作（可能被诱导去骚扰别的会话），所以默认只允许当前会话。
    crossChatSend: false,
    categories: {
      messaging: true,          // 消息发送
      sticker: true,            // 表情管理
      query: true,              // 消息查询
      memory: true,             // 记忆系统
      web: true,                // 联网搜索
      knowledge: true,          // 知识库
      media: true,              // 媒体理解
      system: true              // 系统反馈
    }
  },
  // Skill 统一开关：唯一的"能力启停"来源。
  // 形状：{ [skillId]: { enabled: boolean, ...该 Skill 自己的设置 } }
  // 这里只存用户改过的值；默认值来自各 Skill 的 skill.json → settings。
  // 随包内置的 dsh-agent 技能默认禁用（工具不会出现在模型列表）；
  // 想用"机器人自己调 DSH"：技能页启用它 → 设置里调范围/权限
  skills: { 'dsh-agent': { enabled: false } },
  // 扩展热重载：把自定义的插件/skill 目录放进 plugins/ 或 skills/ 后**自动生效**，无需重启。
  // 默认开 —— 这正是"放进去就能用"的体验来源。
  // ⚠️ 安全含义：等价于"任意落地的 JS 会被执行"。共享机器 / 只跑固定版本时建议关掉。
  extensions: {
    hotReload: true
  },
  // 桌面端/控制台
  server: {
    // 端口：QQ_AGENT_PORT 显式覆盖 > 默认 3210 + PROFILE 偏移
    // （第二实例整体 +100，避免和主实例撞端口）
    port: Number(process.env.QQ_AGENT_PORT) || (3210 + portOffset()),
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  // ── DSH 桥（联动本机 DeepSeek Harness）──────────────────────────────────
  // 命中 prefix 的消息**不进大模型**，直接交给 `dsh headless` 执行，结果原样回发 QQ。
  // 默认关闭。开启前请先填 allowedSenderIds —— 否则等于把本机命令执行权交给
  // 所有在白名单群里的人（任务只在 workdir 内可写，需要审批的操作会失败关闭，
  // 但"能在你目录里跑 agent"这件事本身就需要授权）。
  dsh: {
    enabled: false,
    prefix: '/dsh',            // 命令前缀（必须成词：`/dshx` 不算）
    transport: 'headless',     // headless = 每次起一个 dsh 进程；plugin = 走 dsh-qq 插件的常驻会话
    allowedSenderIds: [],      // 允许下指令的 QQ 号；**空 = 谁都不响应**（安全默认）
    workdir: '',               // DSH 任务的工作目录；空 = QQ Agent 自己的目录
    exePath: '',               // DeepSeek Harness.exe；空 = 内置默认路径
    overlayPath: '',           // 模型 overlay（yml）；空 = 仓库根的 dsh-model-overlay.yml
    pluginUrl: '',             // transport=plugin 时的入口；空 = http://127.0.0.1:19387/__dsh-qq/message
    pluginToken: '',           // dsh-qq 插件的 bridgeToken（插件侧留空则这里也留空）
    maxFileBytes: 104857600,   // DSH 主动发文件的大小上限（默认 100MB，0 = 不限制）
    fileRoots: [],             // 允许发送的目录白名单；空 = 不限制（只校验存在/大小）
    timeoutMs: 900000,         // 单次任务超时（毫秒），到点杀进程树
    permissionMode: '',        // '' = 用 DSH 默认（workspace-write）；'danger-full-access' = 完全放开（危险，见文档）
    maxConcurrent: 1,          // 同时执行的 DSH 任务数上限
    sessionMode: 'per-chat',   // per-chat = 每个会话一条上下文；global = 共用；none = 每次新会话
    showProgress: 'private',   // off | private | all：执行中的工具进度提示发到哪
    progressMinGapMs: 8000,    // 进度提示最小间隔
    maxProgress: 6,            // 单个任务最多发几条进度
    maxReplyChars: 0,          // 0 = 不额外截断（发送器仍按 send.hardSplitAt 分片）
    // DSH 的结果**全文照发 QQ**，但进提示词只留这么多字 —— 否则它会被存档、
    // 之后每一轮历史都带着整份长报告，token 白白烧掉。0 = 完全不进上下文。
    resultPromptChars: 200,
    replyPrefix: '',           // 回发答案前面的固定前缀
    extraArgs: [],             // 追加给 dsh headless 的额外参数
    // ── 隐私过滤（实现见 src/privacy.js）────────────────────────────────
    // 白名单会话原样放行；其他任何会话（所有群 + 其他私聊）命中即处理：
    //   密钥/口令/连接串/私钥等高置信秘密 → 整条拒发（fail-closed）
    //   邮箱/手机/身份证/卡号/本机用户名·主机名/用户目录路径/内网 IP → 打码后照发
    //   打码后只剩占位符 → 拒发
    // 覆盖三处出口：桥回传给 QQ 的回复、/api/inbound 主动推送、/api/inbound-file。
    privacy: {
      enabled: true,
      allowedChats: ['private:85946573'],  // 可以收到原样（含隐私）内容的会话；裸 QQ 号按私聊算
      mode: 'redact',                      // redact = 打码后照发；block = 有命中就整条拒发
      blockOnSecrets: true,                // 密钥/口令类永不发（即使 mode=redact）
      blockedReply: '（这条内容含不宜发往该会话的隐私信息，已被隐私过滤拦截）',
      noticeSuffix: false,                 // 打码时是否在末尾附一句"已隐去 N 处"
      logMatches: true,                    // 命中时在日志留痕（只记规则名，不记内容）
      scanFileContents: true,              // 发文件前扫文本类文件内容，命中密钥类就拒发
      maxScanBytes: 2097152,
      extraPatterns: []                    // [{ id, regex, action: 'redact'|'block', replace }]
    }
  },
  // ── QQ 在线状态（在线/请勿打扰…）───────────────────────────────────────
  // 状态码是 QQ 协议里的整数（NapCat 约定）：10 在线 / 30 离开 / 40 隐身 /
  // 50 忙碌 / 60 Q我吧 / 70 请勿打扰。SnowLuma 只实现 set_online_status，
  // 没有 get_online_status，所以"上次是不是我们设的 DND"只能自己记账
  // （data/presence.json），见 src/presence.js。
  presence: {
    enabled: true,
    dndStatus: 70,          // "请勿打扰"的状态码
    onlineStatus: 10,       // "在线"的状态码
    setDndOnShutdown: true, // 优雅退出（托盘退出）时把 DND 的活交给 before-shutdown 钩子
    restoreOnStart: true    // 启动后若记账里是 DND，就改回在线
  },
  ui: {
    // 主题：'light' | 'dark' | 'auto'（auto = 跟随系统偏好）。
    // 2026-10 改版起默认浅色；前端以 localStorage 为准做到即时生效。
    theme: 'light',
    // 启动动画：'once'（默认，每天第一次启动 + 每次更新后第一次启动播一次）/ 'always' / 'off'
    bootAnim: 'once',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000,         // 界面轮询间隔
    // 2026-10 新增：UI 自定义（背景/颜色/字体/侧栏宽度）。
    // 图片本体不放这里（太大），只存类型与参数；上传的位图存在本机 localStorage。
    skin: {
      // opacity = 卡片/面板透明度（100=不透明）; mode = 面板毛玻璃档（none/soft/strong/frost）
      // 默认背景：小鲸鱼（白底插画预设，配 68% 面板透明度让画看得见）
      bg: { type: 'preset', color: '', preset: 'maid', blur: 0, dim: 0, fit: 'cover', opacity: 68, mode: 'none' },
      // auto = 根据背景自动配色（on + prev 记住开启前的颜色 + 浅/深两套调色板）
      auto: { on: false, prev: null, light: null, dark: null, base: '' },
      colors: { accent: '', bg: '', card: '', text: '', tx2: '', line: '' },
      font: { family: '', scale: 1 },
      sidebarW: 0
    }
  }
};

/** 深合并（含 __replace__ 整体替换约定）。导出供 routes.js 的预览端点做"不落盘的临时合并"。 */
export function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    const merged = deepMerge(DEFAULT_CONFIG, stripObsoleteFields(migrateLegacySkills(parsed)));
    // 一次性：把老的共用 core 搬进内置卡（搬完 core 变空），并立即写回配置文件
    try {
      const _p1 = migratePersonaSharedCore(merged);
      const _p2 = migratePersonaOwnerPlaceholder(merged);
      const _p3 = migrateDedupeBuiltinPersona(merged);
      const _p4 = migrateBuiltinUseSharedRules(merged);
      const _p5 = migrateAllowQqbotSplit(merged);
      if (_p1 || _p2 || _p3 || _p4 || _p5) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
      }
    } catch { /* 迁移失败不影响启动，下次再试 */ }
    return merged;
  } catch (error) {
    // ⚠️ 配置文件坏了（手改错/磁盘故障）不能静默回落默认值：
    //   曾经直接返回 DEFAULT，随后任何 updateConfig（比如 5 分钟一次的
    //   云端屏蔽名单同步）都会以默认配置为底整体写回 config.json ——
    //   用户的 Key/白名单/人设被静默抹成出厂值。
    //   现在先把坏文件改名备份（原始数据可手工抢救），再回落默认，
    //   并打 error 日志提醒用户。
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(CONFIG_FILE, `${CONFIG_FILE}.corrupt-${stamp}`);
        console.error(`[config] 配置文件解析失败（${String(error?.message ?? error)}），` +
          `已备份为 config.json.corrupt-${stamp}，本次以默认配置启动。` +
          `请尽快从备份抢救配置，否则下次保存会覆盖全量配置！`);
      }
    } catch (backupError) {
      console.error('[config] 配置文件解析失败且备份失败：', backupError);
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * 旧配置迁移：把历史上散落在各处的"能力开关"收拢进 config.skills。
 *
 * 为什么必须做：社区版/旧版把同一件事的开关放在 api.thinking、tools.knowledgeEnabled
 * 之类的字段里，而新架构只认 config.skills[id].enabled。若不迁移，
 * 用户升级后会出现"UI 显示已开启、实际 Skill 判定为关闭"——正是要消灭的冲突。
 *
 * 规则（表驱动，新增迁移只需加一行）：
 *   旧字段路径 → Skill id，可选值映射函数
 * 迁移是幂等的：只有在 skills[id] 尚未存在时才写入，不会覆盖用户新配置。
 */
const LEGACY_SKILL_MIGRATIONS = [
  // ⚠️ skill 名字必须与 skills/ 或 plugins/ 下的**目录名**完全一致，
  //    目标不存在时迁移会跳过并记日志（migrateLegacySkills 内有校验）。
  // 社区版的思考开关已收编进核心（src/thinking.js），不再迁往任何 Skill：
  // api.thinking: true → thinkingMode 'on'，false → 'off'，由下方专段处理。
  // 旧知识库开关（知识库技能尚未移植，先留位；目标不存在时迁移会跳过并记日志）
  { from: ['tools', 'knowledgeEnabled'], skill: 'knowledge-base', map: (v) => ({ enabled: v !== false }) },
  // 旧视频理解开关
  { from: ['tools', 'videoEnabled'], skill: 'video-frames', map: (v) => ({ enabled: v !== false }) },
  // 旧表情标注开关
  { from: ['tools', 'stickerAnnotate'], skill: 'sticker-annotate', map: (v) => ({ enabled: v !== false }) }
];

/**
 * 把老配置里 personaShared.core 的正文搬进「内置只读人格卡」，然后清空共用 core。
 *
 * 为什么：core 是"所有用共用段的卡都共享的角色底子"，但不同卡往往有完全不同的人设
 * （小鲸鱼 / 别的角色），共用 core 会把它们都染成同一个人。改成 core 归各卡自己，
 * 内置卡（read-only）保留原来那段；其余卡想加就自己写进 variant。
 * 幂等：内置卡 variant 已包含该文本时不重复追加。
 */
/**
 * 迁移：把人格卡里写死的部署者 QQ（历史默认 85946573）换成 {{ownerQQ}} 占位符。
 * 目的：卡可以原样分享给别人部署，谁部署就填谁的白名单，不用改文案。
 * 幂等：已经是 {{ownerQQ}} 的不会再变。
 */
/**
 * 内置卡去重：把 variant 里**标题重复的整段丢掉**（保留第一次出现的）。
 *
 * 背景：2026-10-24 把老的 personaShared.core 追加进内置卡后，追加块里
 * "一、你是谁 / 二、群聊说话铁律…" 与卡片原文重复，末尾还多出一整段。
 * 幂等：标题归一化后比较，重复即丢。
 */
export function migrateDedupeBuiltinPersona(cfg) {
  const cards = Array.isArray(cfg.personas) ? cfg.personas : [];
  const card = cards.find((p) => p && (p.builtin === true || p.id === 'builtin_xiaojingyu'));
  if (!card) return false;
  const text = String(card.variant || '');
  if (!/^## /m.test(text)) return false;
  const blocks = [];
  let cur = { head: '', lines: [] };
  for (const ln of text.split('\n')) {
    const m = /^##\s+(.*)$/.exec(ln);
    if (m) { blocks.push(cur); cur = { head: m[1].trim(), lines: [ln] }; }
    else cur.lines.push(ln);
  }
  blocks.push(cur);
  const norm = (h) => String(h)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[:：].*$/, '')
    .replace(/^[一二三四五六七八九十〇]+、/, '')
    .replace(/\s+/g, '');
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    if (!b.head) { out.push(b.lines.join('\n')); continue; }
    const key = norm(b.head);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b.lines.join('\n'));
  }
  // 「一句话定位」如果被追加到末尾，挪到标题后（读起来更顺）
  const pos = out.findIndex((b) => /^##\s*〇?、?\s*一句话定位/.test(b));
  if (pos > 1) {
    const [blk] = out.splice(pos, 1);
    out.splice(1, 0, blk);
  }
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!next || next === text) return false;
  card.variant = next;
  return true;
}

/**
 * 内置卡瘦身：把「说话规则」类段落交给通用卡（共用段 voice），人格卡只留下
 * 角色特有内容 + 说话例子。
 *
 * 判定：共用段 voice 里已有的段（标题归一化后相同）就内置卡删掉，
 * 然后把内置卡切到 useShared=true / useSharedVoice=true，让它从通用卡拿这些规则。
 * 幂等：没删到东西且开关已开 → 直接返回 false。
 */
export function migrateBuiltinUseSharedRules(cfg) {
  const cards = Array.isArray(cfg.personas) ? cfg.personas : [];
  const card = cards.find((p) => p && (p.builtin === true || p.id === 'builtin_xiaojingyu'));
  const voice = String(cfg?.personaShared?.voice || '');
  if (!card || !voice.trim()) return false;

  const norm = (h) => String(h)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[:：].*$/, '')
    .replace(/^[一二三四五六七八九十〇]+、/, '')
    .replace(/\s+/g, '');
  const sharedHeads = new Set(
    voice.split('\n')
      .map((ln) => /^##\s+(.*)$/.exec(ln))
      .filter(Boolean)
      .map((m) => norm(m[1]))
  );

  const text = String(card.variant || '');
  const blocks = [];
  let cur = { head: '', lines: [] };
  for (const ln of text.split('\n')) {
    const m = /^##\s+(.*)$/.exec(ln);
    if (m) { blocks.push(cur); cur = { head: m[1].trim(), lines: [ln] }; }
    else cur.lines.push(ln);
  }
  blocks.push(cur);

  const kept = blocks.filter((b) => {
    if (!b.head) return true;
    return !sharedHeads.has(norm(b.head));
  });
  const removed = blocks.length - kept.length;

  // 删段后序号会断（一 → 五），重新按顺序编号；「〇」段保持不动
  const nums = ['一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
  let seq = 0;
  const renumbered = kept.map((b) => {
    if (!b.head) return b.lines.join('\n');
    const isZero = /^〇/.test(b.head) || /一句话定位/.test(b.head);
    const body = b.lines.slice(1).join('\n');
    if (isZero) return ['## ' + b.head].concat(body ? [body] : []).join('\n');
    const title = b.head.replace(/^[一二三四五六七八九十〇]+、/, '');
    const num = nums[seq] || String(seq + 1);
    seq += 1;
    return ['## ' + num + '、' + title].concat(body ? [body] : []).join('\n');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  let changed = false;
  // 序号断裂也算“需要改”（例如上一轮只删了段、没重编号）
  if (renumbered && renumbered !== text) { card.variant = renumbered; changed = true; }
  if (card.useShared === false) { card.useShared = true; changed = true; }
  if (card.useSharedVoice === false) { card.useSharedVoice = true; changed = true; }
  return changed;
}

export function migratePersonaOwnerPlaceholder(cfg) {
  const qq = '85946573';
  let changed = false;
  const walk = (obj, key) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && v.includes(qq)) {
        obj[k] = v.split(qq).join('{{ownerQQ}}');
        changed = true;
      } else if (v && typeof v === 'object') {
        walk(v, k);
      }
    }
  };
  if (Array.isArray(cfg.personas)) walk(cfg.personas);
  if (cfg.personaShared && typeof cfg.personaShared === 'object') walk(cfg.personaShared);

  // 再把写死的部署者昵称换成 {{owner}}（只处理常见写法，避免误伤普通单词）
  const nameFix = (str) => String(str)
    .replace(/Call me ACC/g, '{{owner}}')
    .replace(/[“"]ACC[”"]/g, '“{{owner}}”')
    .replace(/\bACC\b(?=[（(，,、。\s])/g, '{{owner}}');
  const walkName = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        const after = nameFix(v);
        if (after !== v) { obj[k] = after; changed = true; }
      } else if (v && typeof v === 'object') walkName(v);
    }
  };
  if (Array.isArray(cfg.personas)) walkName(cfg.personas);
  if (cfg.personaShared && typeof cfg.personaShared === 'object') walkName(cfg.personaShared);

  // 管理员 QQ 如果就是白名单第一个私聊（=部署者），清空让它走派生，谁部署填谁
  try {
    const firstPriv = String((Array.isArray(cfg.allow?.private) ? cfg.allow.private[0] : '') || '')
      .replace(/^private:/i, '').trim();
    const adminQQ = String(cfg.forwardRules?.adminQQ || '').trim();
    if (firstPriv && adminQQ === firstPriv) { cfg.forwardRules.adminQQ = ''; changed = true; }
  } catch { /* 忽略 */ }
  return changed;
}

/**
 * 迁移：早期「最近会话 → 加入白名单」把 openid 写进了 allow（群号那套）。
 * openid 是 32 位十六进制，与数字群号/QQ 号一眼可分：搬到 allowQqbot。
 */
export function migrateAllowQqbotSplit(cfg) {
  const isOpenid = (v) => /^[0-9a-f]{20,}$/i.test(String(v || ''));
  let changed = false;
  const aq = cfg.allowQqbot || (cfg.allowQqbot = { groups: [], private: [] });
  for (const kind of ['groups', 'private']) {
    const list = Array.isArray(cfg.allow?.[kind]) ? cfg.allow[kind] : [];
    const keep = [];
    for (const v of list) {
      if (isOpenid(v)) {
        if (!Array.isArray(aq[kind])) aq[kind] = [];
        if (!aq[kind].includes(v)) aq[kind].push(v);
        changed = true;
      } else keep.push(v);
    }
    if (keep.length !== list.length) cfg.allow[kind] = keep;
  }
  return changed;
}

export function migratePersonaSharedCore(cfg) {
  const shared = cfg && cfg.personaShared;
  const core = shared && typeof shared.core === 'string' ? shared.core.trim() : '';
  if (!core) return false;
  const cards = Array.isArray(cfg.personas) ? cfg.personas : [];
  const builtin = cards.find((p) => p && (p.builtin === true || p.id === 'builtin_xiaojingyu'));
  if (builtin) {
    const variant = String(builtin.variant || '');
    if (!variant.includes(core)) {
      builtin.variant = (variant ? variant + '\n\n' : '') + core;
    }
  }
  shared.core = '';
  return true;
}

export function migrateLegacySkills(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = { ...parsed };
  out.skills = (out.skills && typeof out.skills === 'object' && !Array.isArray(out.skills)) ? { ...out.skills } : {};

  // 社区版的思考开关（api.thinking: boolean）：思考已收编进核心（src/thinking.js），
  // 旧值映射成 thinkingMode（true=on / false=off），不再迁往任何 Skill 命名空间。
  if (out.api && typeof out.api === 'object' && !Array.isArray(out.api) && 'thinking' in out.api) {
    const legacyThinking = out.api.thinking;
    if (out.api.thinkingMode === undefined) {
      out.api = { ...out.api, thinkingMode: legacyThinking === false ? 'off' : 'on' };
    }
    const nextApi = { ...out.api };
    delete nextApi.thinking;
    out.api = nextApi;
  }

  for (const rule of LEGACY_SKILL_MIGRATIONS) {
    const [parent, key] = rule.from;
    const container = out[parent];
    if (!container || typeof container !== 'object') continue;
    if (!(key in container)) continue;
    const legacyValue = container[key];
    // 已有新配置就不动（用户可能已经在新 UI 里改过）
    if (!(rule.skill in out.skills)) {
      out.skills[rule.skill] = { ...rule.map(legacyValue) };
    }
    // 清掉旧字段，避免下次启动重复迁移、也避免模块继续读到旧值
    const nextContainer = { ...container };
    delete nextContainer[key];
    out[parent] = nextContainer;
  }
  return out;
}

/**
 * 剔除**废弃字段**（磁盘/回传 patch 都可能带着的历史残留）。
 * 这些字段已无任何读点，留着只会冒充"生效配置"继续漂移：
 *   · api.stream          —— llm.js 请求体硬编码 stream:false（无 UI、无读点）
 *   · api.priceRemoteUrl  —— 远程价格表地址固定为 src/community.js 的常量
 *   · budget（容器整体）  —— 预算保险丝功能已移除，容器本身也无读点
 *   · store.peakSchedule.valley.start/end —— "高峰外=低谷"语义下无人读
 *     （peakSchedule.valley.sliderPos 保留，peakSchedule.custom.valley 同口径只留 sliderPos）
 *   · providersImported   —— 导入来源标记，零读点
 * 与 stripDerivedFlags 一样在 loadConfig / updateConfig 时调用，删旧键不碰活键。
 */
const OBSOLETE_PATHS = [
  ['api', 'stream'],
  ['api', 'priceRemoteUrl'],
  ['budget'],
  ['providersImported'],
  // 2026-09-25 档位改版：四个分档条数字段废弃，统一为 store.historyCount。
  // 老配置里的存量值会在 loadConfig 时被剔除（读条数走 historyCount / allCount 迁移兜底）。
  ['store', 'atCount'],
  ['store', 'keywordCount'],
  ['store', 'randomCount'],
  ['store', 'allCount'],
  ['store', 'peakSchedule', 'valley', 'start'],
  ['store', 'peakSchedule', 'valley', 'end'],
  ['store', 'peakSchedule', 'custom', 'valley', 'start'],
  ['store', 'peakSchedule', 'custom', 'valley', 'end']
];

export function stripObsoleteFields(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  for (const path of OBSOLETE_PATHS) {
    let cur = node;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const next = cur?.[path[i]];
      if (!next || typeof next !== 'object' || Array.isArray(next)) { ok = false; break; }
      cur = next;
    }
    if (ok && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      delete cur[path[path.length - 1]];
    }
  }
  return node;
}

let currentConfig = null;

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/**
 * 剔除**派生标记**：GET /api/config 的脱敏层会生成 hasXxx / dshProviderKeyPresence
 * 这类"只表示存在性"的字段。前端把它们当成配置的一部分回传时，
 * deepMerge 会把它们真的写进 config.json —— 于是配置文件里混进了派生数据，
 * 且会随密钥增删变得与实际不一致（清了 Key 但 hasKey 仍是 true）。
 */
function stripDerivedFlags(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) stripDerivedFlags(item);
    return node;
  }
  for (const key of Object.keys(node)) {
    // hasApiKey / hasKey / hasAccessToken / hasHttpAccessToken …
    // 只匹配 camelCase 的 has+大写开头，避免误删用户自定义的普通字段。
    if (/^has[A-Z][A-Za-z0-9]*$/.test(key)) { delete node[key]; continue; }
    if (key === 'dshProviderKeyPresence') { delete node[key]; continue; }
    stripDerivedFlags(node[key]);
  }
  return node;
}

/**
 * 数组型密钥容器的脱敏回传保留：patch 里按 id 匹配的条目若**缺少**密钥字段，
 * 从现配置同 id 条目回填 —— 前端脱敏视图回传时密钥天然不在场，不回填就会
 * 在"数组整体替换"的合并语义下静默清空。显式传空串（''）= 真清除，不回填。
 * 目前只有 webSearch.providers 一处数组密钥容器；新增容器时往数组里加路径即可。
 */
function preserveSanitizedSecrets(current, patch) {
  try {
    const cur = current?.webSearch?.providers;
    const next = patch?.webSearch?.providers;
    if (!Array.isArray(cur) || !Array.isArray(next)) return;
    for (const entry of next) {
      if (!entry || typeof entry !== 'object' || entry.id == null) continue;
      // 显式带了 apiKey（含空串 = 真清除）→ 尊重调用方，不回填；
      // 完全没带（脱敏回传的常态）→ 从现配置同 id 条目回填现值。
      if (entry.apiKey !== undefined) continue;
      const stored = cur.find((p) => String(p?.id) === String(entry.id));
      if (stored && String(stored.apiKey || '').trim()) {
        entry.apiKey = stored.apiKey;         // 回填现值，等价于"该条目未动"
      }
    }
  } catch { /* 保留失败不阻塞保存；最坏结果是回到旧行为 */ }
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  const cleanPatch = stripDerivedFlags(structuredClone(patch ?? {}));
  const cleanObsolete = stripObsoleteFields(cleanPatch);
  // ── 脱敏回传的密钥保留（2026-09-19 修"搜索 Key 离开页签就消失"）──
  // 前端拿到的配置是脱敏的（apiKey 被删、hasApiKey 被加）；它把整个配置/区块
  // 回传保存时，密钥字段天然缺失。对**对象型**密钥容器 deepMerge 会保留基底值
  // （webSearch.deepseek.apiKey 没出现在 patch → 沿用现值），但**数组型**容器
  // （webSearch.providers[].apiKey）整体替换 —— 前端回传的数组里没有 apiKey，
  // 一次普通的设置保存就把所有自定义搜索服务的 Key 静默清空（表现为掩码消失、
  // 测试报 invalid API key）。这里在合并前把"patch 条目缺密钥字段"的数组按 id
  // 回填现值；想真清除必须显式传 apiKey: ''（专用清除按钮就是显式空串路径）。
  preserveSanitizedSecrets(getConfig(), cleanObsolete);
  currentConfig = deepMerge(getConfig(), cleanObsolete);
  // 磁盘上可能已经存过历史遗留的派生标记，一并清掉
  stripDerivedFlags(currentConfig);
  stripObsoleteFields(currentConfig);

  // ── 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率 ──
  // 前端只负责上报滑条位置（contextSliderPos），档位和概率一律由这里换算。
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  const posRaw = currentConfig?.store?.contextSliderPos;
  if (posRaw !== undefined && posRaw !== null) {
    const { tier, randomPercent } = sliderToTier(posRaw);
    currentConfig.store.contextTier = tier;
    currentConfig.store.randomPercent = randomPercent;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/**
 * 取某个会话实际生效的人设：全局 persona 被 personaByChat[id] 的同名字段覆盖。
 *
 * 只允许覆盖 roleText / participation / customRules / systemPromptOverride 四个
 * "说话风格"字段；botName / selfNickname 是账号身份，任何会话都不得单独改 ——
 * 换了会与 @ 判定（isAtMe 用昵称/名字匹配）、存档里"我"的称呼全部对不上。
 * 覆盖值一律做字符串 trim（空串视为"未设置"，回落全局值）。
 *
 * ⚠️ personaUnified = true（"为所有的群聊/私聊使用同一个人设"）时，
 *    personaByChat 的条目**不再生效**（统一人设是用户明确表态，遗留的
 *    分会话条目继续覆盖会让"所有会话共用这一套人设"的 UI 承诺落空，
 *    且统一模式下 UI 隐藏了分会话编辑入口，用户无从发现也无处改）。
 *    开关关掉后条目恢复生效 —— 数据不删，只是不再参与合并。
 */
/**
 * 取某个会话的「人格卡」（新系统）。返回：
 *   { assigned, cardId, card, shared }
 * - assigned：该会话是否分配了卡（未分配 = 静默，见 isSilentChat）
 * - card 为空时调用方应回落旧 persona.roleText（回退保险）
 */
export function personaCardForChat(chatKey) {
  const cfg = getConfig();
  const entry = cfg?.personaByChat?.[String(chatKey || '')] || null;
  const cardId = String(entry?.personaId || '').trim();
  const personas = Array.isArray(cfg?.personas) ? cfg.personas : [];
  const card = cardId ? personas.find((p) => p && p.id === cardId) || null : null;
  return { assigned: !!cardId, cardId, card, shared: cfg?.personaShared || {} };
}

/** 用当前消息文本匹配卡片的按需场景段（trigger 是正则/关键词，非法正则跳过）。 */
export function matchPersonaScenarios(card, text) {
  const list = Array.isArray(card?.scenarios) ? card.scenarios : [];
  const s = String(text || '');
  if (!s.trim() || !list.length) return [];
  const out = [];
  for (const sc of list) {
    const trig = String(sc?.trigger || '').trim();
    if (!trig) continue;
    try {
      if (new RegExp(trig, 'i').test(s)) out.push(sc);
    } catch { /* 非法正则忽略，不影响其它段 */ }
  }
  return out;
}

export function personaForChat(chatKey) {
  const base = getConfig().persona || {};
  const [kind, id] = String(chatKey || '').split(':');
  if (!id) return base;
  // 统一人设模式：一律用全局，不看 personaByChat
  if (getConfig().personaUnified !== false) return base;
  const perChat = getConfig().personaByChat || {};
  // 兼容两种键格式：UI 的隐藏 JSON 以 chatKey（group:123）为键保存，
  // 而这里按 id 段（123）查 —— 只认一种格式时保存成功但永不生效
  // （2026-09-17 用户实测踩中：独立人设存了却一直跟随全局）。
  const raw = perChat[String(id)] ?? perChat[String(chatKey)];
  if (!raw || typeof raw !== 'object') return base;
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out = { ...base };
  if (kind === 'group' || kind === 'private') {
    const roleText = pick(raw.roleText);
    const customRules = pick(raw.customRules);
    const systemPromptOverride = pick(raw.systemPromptOverride);
    if (roleText !== undefined) out.roleText = roleText;
    if (customRules !== undefined) out.customRules = customRules;
    if (systemPromptOverride !== undefined) out.systemPromptOverride = systemPromptOverride;
    if (['low', 'medium', 'high'].includes(raw.participation)) out.participation = raw.participation;
  }
  return out;
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 *
 * 峰谷切换：peakSchedule.enabled 时，先按当前时间判定落在高峰/低谷时段，
 * 用该时段的 sliderPos 换算出档位**覆盖**全局滑条（在 unifiedTier / 分群设置之前生效）。
 */
/**
 * 该会话是否"静默"：只存档、不调模型（0 token）。
 * 确定性功能不受影响 —— 链接转发在 ingest 阶段就跑，/dsh 命令由桥认领，都不经过模型。
 * 名单支持 `group:123` / `private:123`；裸数字按**群**算（这个开关主要给群用）。
 * 第二个参数只为可测性存在：不传就读配置。
 */
/**
 * 为什么这个会话是静默的？
 * @returns {'list'|'unassigned'|''} 'list' = 在静默名单里；'unassigned' = 没分配人格卡；'' = 不静默
 */
export function silentReason(chatKey, list = null) {
  const src = Array.isArray(list) ? list : getConfig().store?.silentChats;
  if (!Array.isArray(src) || !src.length) return '';
  const key = String(chatKey || '').trim();
  if (!key) return '';
  const wanted = new Set();
  for (const raw of src) {
    const item = String(raw ?? '').trim();
    if (!item) continue;
    wanted.add(item);
    if (/^\d+$/.test(item)) wanted.add(`group:${item}`);
  }
  if (wanted.has(key)) return 'list';
  if (!Array.isArray(list)) {
    const _c = getConfig();
    if (_c.store?.silentWhenUnassigned === false) return '';
    // 统一人设模式：所有会话共用全局那张卡，本来就不需要逐会话分配 ——
    // 旧逻辑在这里会让"新加的好友/新进的白名单群"一律静默（0 token），
    // 看起来像"加进白名单但机器人不理人"（2026-10-23 用户实测的 bug）。
    if (_c.personaUnified !== false) return '';
    if (!Array.isArray(_c.personas) || !_c.personas.length) return '';
    const _cid = String(_c.personaByChat?.[key]?.personaId || '').trim();
    if (!_cid || !_c.personas.some((p) => p && p.id === _cid)) return 'unassigned';
  }
  return '';
}

/**
 * 新会话自动分配默认人格卡。
 *
 * 背景：没分配卡的会话会静默（不调模型）。新加的好友 / 新拉进白名单的群
 * 默认没有分配记录，于是"加了白名单也不理人"。这里在第一次收到消息时补一张默认卡：
 *   显式默认（config.personaDefaultId）→ 标了 default 的卡 → 内置卡 → 第一张卡
 * 统一人设模式 / 一张卡都没有时不写（那两种情况本来就用全局人设，不需要会话级分配）。
 *
 * @returns {string|null} 实际分配的卡 id（没写则 null）
 */
export function ensurePersonaAssignment(chatKey) {
  const key = String(chatKey || '').trim();
  if (!key) return null;
  const cfg = getConfig();
  if (cfg.personaUnified !== false) return null;
  const cards = Array.isArray(cfg.personas) ? cfg.personas : [];
  if (!cards.length) return null;
  const cur = String(cfg.personaByChat?.[key]?.personaId || '').trim();
  if (cur && cards.some((p) => p && p.id === cur)) return null;   // 已有有效分配
  const explicit = String(cfg.personaDefaultId || '').trim();
  const pick = (explicit && cards.find((p) => p && p.id === explicit))
    || cards.find((p) => p && p.default)
    || cards.find((p) => p && p.builtin)
    || cards[0];
  const cardId = pick && pick.id ? String(pick.id) : '';
  if (!cardId) return null;
  const prev = cfg.personaByChat && typeof cfg.personaByChat === 'object' ? cfg.personaByChat : {};
  try {
    updateConfig({ personaByChat: { ...prev, [key]: { ...(prev[key] || {}), personaId: cardId } } });
  } catch { return null; }
  return cardId;
}

export function isSilentChat(chatKey, list = null) {
  return silentReason(chatKey, list) !== '';
}

export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  // ── 指令禁言：该群被禁言且未到期 → 强制 1 档（仅艾特）──
  const mutedTier = commandMuteTier(chatKey);
  if (mutedTier !== null) {
    return { ...store, contextTier: 1, randomPercent: 0 };
  }
  const [kind, id] = String(chatKey || '').split(':');
  const isGroup = kind === 'group' && !!id;
  const peakOn = store.peakSchedule?.enabled === true;
  const inPeakNow = peakOn && peakWindowActive(store.peakSchedule);

  // ── 四象限（2026-09-18 改版）──
  //   统一 + 峰谷关：全局滑条（contextSliderPos）
  //   统一 + 峰谷开：全局峰谷双点按时段取高峰/低谷
  //   分群 + 峰谷关：群无单独设置 → 全局滑条；有 → groupSliderPos[群]
  //   分群 + 峰谷开：群无单独峰谷 → 全局双点按时段取；有 → groupPeakPos[群] 按时段取
  // 私聊永远跟随"全局"口径（峰谷开时同样受时段影响）。
  let pos = clampSliderPos(store.contextSliderPos);
  if (peakOn) {
    if (isGroup && store.unifiedTier === false) {
      const gp = store.groupPeakPos?.[id];
      pos = gp
        ? clampSliderPos(inPeakNow ? gp.peak : gp.valley)
        : (inPeakNow ? clampSliderPos(store.peakSchedule.peak?.sliderPos) : clampSliderPos(store.peakSchedule.valley?.sliderPos));
    } else {
      pos = inPeakNow
        ? clampSliderPos(store.peakSchedule.peak?.sliderPos)
        : clampSliderPos(store.peakSchedule.valley?.sliderPos);
    }
  } else if (isGroup && store.unifiedTier === false) {
    const gp = store.groupSliderPos?.[id];
    if (gp !== undefined && gp !== null) pos = clampSliderPos(gp);
  }
  const { tier, randomPercent } = sliderToTier(pos);
  // 已读历史条数：可按群覆盖
  let historyCount = Number(store.historyCount) || 70;
  if (store.historyCountPerChatEnabled === true) {
    const hc = Number(store.historyCountByChat?.[chatKey]);
    if (Number.isFinite(hc) && hc > 0) historyCount = hc;
  }
  return { ...store, historyCount, contextSliderPos: pos, contextTier: tier, randomPercent };
}

/**
 * 当前时间是否落在高峰时段内（峰谷判定的第一步，供 storeConfigForChat 复用）。
 */
function peakWindowActive(ps, at = new Date()) {
  const minutes = at.getHours() * 60 + at.getMinutes();
  const s = parseHHMM(ps?.peak?.start);
  const e = parseHHMM(ps?.peak?.end);
  if (s === null || e === null || s === e) return false;
  if (s < e) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e;
}

/**
 * 指令禁言：该群是否处于禁言期（响应档位被强制为 1 档）。
 * @returns {number|null} 强制档位（1）；未禁言/已到期返回 null
 */
export function commandMuteTier(chatKey, at = Date.now()) {
  const cm = getConfig().commandMute;
  if (!cm || cm.enabled !== true) return null;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return null;
  const until = Number(cm.active?.[id]);
  if (!Number.isFinite(until)) return null;
  if (until === 0) return 1;              // 0 = 直到手动解除
  if (at < until) return 1;               // 未到解除时间
  return null;                            // 已到期
}

/**
 * 峰谷切换的核心判定：当前时间落在哪个时段。
 * 2026-09-18 四象限改版后的语义：高峰窗口内 = peak.sliderPos，
 * 窗口外一律 = valley.sliderPos（低谷时段不再单独编辑）。
 * 注意：storeConfigForChat 内联了同一判定（分群峰谷 groupPeakPos 也在那里处理）；
 * 修改时段判定口径时两处必须同步改。
 */
export function resolvePeakSliderPos(store, at = new Date()) {
  const ps = store?.peakSchedule;
  if (!ps || ps.enabled !== true) return null;
  if (peakWindowActive(ps, at)) return clampSliderPos(ps.peak?.sliderPos);
  return clampSliderPos(ps.valley?.sliderPos);
}

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function clampSliderPos(pos) {
  const n = Number(pos);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}
