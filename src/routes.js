// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// 依赖（store/memory/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// 路由 handler 通过闭包取用，避免在 app.js 里反复传参。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR, ROOT } from './config.js';
import { customSearch } from './web-search.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import { refreshPriceFeed, priceFeedStatus, initPriceFeed } from './price-feed.js';
import {
  currentProviders, setProviderKey, testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { setPresence, presenceSummary, restoreIfDnd } from './presence.js';
import { getPrivacyFilter } from './privacy.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { parseLegacyCard } from './persona-import.js';
import { runBackup, listBackups } from './backup.js';
import { installUpdate, cleanUpdateTemp } from './updater.js';
import { analyzeExtension } from './plugin-compat.js';
import { exportToFile, previewImport, applyImport, buildBundle, bundleStats } from './memory-bundle.js';
import { redactText, getSafeModeConfig } from './safe-mode.js';
import { listCards, getPerson, getGroup, getGeneral, updatePerson, updateGroup, updateGeneral, deletePerson, prunePersons, purgeDeletedBackups, listDeletedBackups, stats as memoryCardStats, listGenerals, getGeneralById, createGeneral, updateGeneralById, deleteGeneral, listTopics, getTopic, createTopic, updateTopic, deleteTopic } from './memory-cards.js';
import { readChunks, readSemanticCards, lastAutoCardsAt } from './memory-layers.js';
import { skillPlacementStatus } from './prompt.js';
import { listLinks, listHistory, addLink, setLinkMode, unlink, restore } from './identity-links.js';
import { listDecisions, decisionStats, queryDecisions } from './decision-log.js';
import { decisionStatus, buildCorpus } from './decision-pipeline.js';
import { ensureIndex, rebuildIndex, indexStatus } from './vector-store.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL } from './community.js';
import { listAccounts, removeAccount, loginAccount, publishModule, verifyInstallCodes, installByCode } from './market.js';
import { detectDialect as detectThinkingDialect } from './thinking.js';
import { asTransport } from './transport/index.js';

/**
 * 解析 /api/memory-bundle/json?sections=generals,topics 的栏目选择。
 * 不传 / 传 all / 传 * → null（null = 全选，交给 memory-bundle.normalizeSections）；
 * 支持重复参数（sections=generals&sections=persons）；不认识的名字忽略。
 */
function parseSectionsQuery(searchParams) {
  const names = [];
  for (const value of searchParams.getAll('sections')) {
    for (const part of String(value ?? '').split(',')) {
      const name = part.trim().toLowerCase();
      if (name) names.push(name);
    }
  }
  if (!names.length) return null;
  if (names.includes('all') || names.includes('*')) return null;
  const picked = { generals: false, groups: false, persons: false, topics: false };
  let hit = false;
  for (const name of names) {
    if (name in picked) { picked[name] = true; hit = true; }
  }
  return hit ? picked : null;
}

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  const conn = deps.transport || asTransport({ client: deps.onebot });
  const {
    store, memory, sessions, onebot, transport, qqbotChats, qqbotStatus, qqbotStats, simulateQqbotEvent, snowlumaInstalled, uninstallSnowluma, orchestrator, sender,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver, UPDATE_INFO_URL,
  updateCheck, updateStatus, updateDownload,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    snowlumaDir, snowlumaWsPort, snowlumaWebuiUrl, snowlumaStatus, snowlumaLogs,
    launchSnowluma, stopSnowluma,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    // 记忆解释器桥（src/memory-studio.js）：状态 / 启动 / 停止 / 白名单代理
    // 另：检查更新 / 下载安装（解释器不在安装包里，按需从它自己的 Release 取）
    memoryStudioStatus, memoryStudioStart, memoryStudioStop, memoryStudioCall,
    memoryStudioCheckUpdate, memoryStudioInstall,
    visionScan,
    buildUsageStats, buildUsageBreakdown, buildUsageSeries,
    reloadSkills
  } = deps;

  /** 解绑后把「绑定期间新增」的印象/卡复制到两侧（A 读合并模式可选） */
  function copyAfterUnlink(link) {
    const stats = { impressions: 0, cards: 0 };
    try {
      const cut = Number(link.linkedAt) || 0;
      for (const [from, to] of [[link.onebotKey, link.qqbotKey], [link.qqbotKey, link.onebotKey]]) {
        const members = memory.members(from) || [];
        for (const m of members) {
          for (const e of (m.impressions || [])) {
            if ((Number(e.createdAt) || 0) <= cut) continue;
            memory.append(to, 'memberImpression', e.content, { userId: m.userId, name: m.name });
            stats.impressions += 1;
          }
        }
        const card = getGroup(from);
        if (card && !getGroup(to)) {
          updateGroup(to, {
            name: card.name, summary: card.summary,
            facts: card.facts, topics: card.topics, members: card.members
          });
          stats.cards += 1;
        }
      }
    } catch { /* 忽略 */ }
    return stats;
  }


  // 小工具：读请求体（容错：没 body 当空对象）。
  // 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: skillManager,
      toolsCfg: cfg.tools || {},
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  return [
    // ── 状态 / 数据目录 / 重置 ─────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        // ┚ SnowLuma 运行判定用 WebUI 端口（进程即起即听）。
        // WS 3001 要等账号登录后才监听，用它判"运行中"会把"起了但未登录"
        // 误报成"未运行"（进而触发二次拉起 → 双实例管道冲突）。
        const webuiPort = deps.snowlumaWebuiPort();
        // 两个端口探测并行：串行时最坏 1.6s（各 800ms 超时），/api/status 每次都卡这么久
        const [slRunning, obPortOpen] = await Promise.all([
          deps.isPortOpen('127.0.0.1', webuiPort),
          deps.isPortOpen('127.0.0.1', snowlumaWsPort())
        ]);
        // 诊断：把"连不上"拆成三种用户能看懂的原因（给 UI 就绪度体检用）。
        let onebotDiagnosis = '';
        if (!onebot.connected) {
          if (!slRunning) onebotDiagnosis = 'SnowLuma 未运行：请到 SnowLuma 页签启动';
          else if (!obPortOpen) onebotDiagnosis = 'SnowLuma 已运行但无账号登录：请在 QQ 里完成登录（登录后数秒内会自动连上）';
          else if (String(onebot.lastConnectError || '').includes('401')) onebotDiagnosis = '访问令牌不匹配：正在自动轮换重试，若持续出现请在设置里核对 OneBot 令牌';
          else onebotDiagnosis = onebot.lastConnectError ? `连接失败：${String(onebot.lastConnectError).slice(0, 120)}` : '连接中…';
        }
        return json(res, 200, {
          qqbot: (() => {
            const st = typeof qqbotStatus === 'function' ? (qqbotStatus() || {}) : {};
            const qb = getConfig().transport?.qqbot || {};
            const acc = Array.isArray(qb.accounts) ? qb.accounts[0] || {} : {};
            return {
              connected: st.connected === true,
              error: st.error || '',
              selfNickname: transport && transport.kind === 'qqbot' ? (transport.selfNickname || '') : '',
              received: (typeof qqbotStats === 'function' ? (qqbotStats() || {}).received : 0) || 0,
              lastRecvAt: Number(getConfig().transport?.qqbot?.lastRecvAt || 0),
              activeChats: (typeof qqbotStats === 'function' ? (qqbotStats() || {}).activeChats : 0) || 0,
              configured: Boolean(String(acc.appId || '').trim() && String(acc.appSecret || '').trim()),
              active: String(getConfig().transport?.active || 'onebot')
            };
          })(),
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            installed: (typeof snowlumaInstalled === 'function' ? snowlumaInstalled() : false),
            running: slRunning,
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          qqPortable: await qqPortableStatus(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // QQ_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 QQ Agent 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          onebot.close();

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过 qq-agent.lock —— 那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = await buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || '')),
        remote: { ...priceFeedStatus(), url: FIXED_PRICE_FEED_URL }
      })
    },
    {
      method: 'POST', pattern: '/api/model-prices/refresh',
      handler: async ({ res, json }) => {
        const st = await refreshPriceFeed(FIXED_PRICE_FEED_URL);
        return json(res, 200, {
          ok: st.ok, remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }
    },

    // ── SnowLuma 进程管理 ────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/snowluma/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/snowluma/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: snowlumaLogs.slice(-200) })
    },
    {
      method: 'POST', pattern: '/api/snowluma/uninstall',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        if (body.confirm !== true) return json(res, 400, { ok: false, error: '需要 confirm:true 才会卸载（会删除协议端目录）' });
        if (typeof uninstallSnowluma !== 'function') return json(res, 500, { ok: false, error: '卸载入口未接线' });
        try {
          const r = await uninstallSnowluma();
          return json(res, 200, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/stop',
      handler: async ({ res, json }) => {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-folder',
      handler: async ({ res, json }) => {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-webui',
      handler: async ({ res, json }) => {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }
    },

    // ── 便携 QQ 进程管理 ─────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json }) => json(res, 200, await qqPortableStatus())
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        try {
          const list = await conn.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        try {
          const list = await conn.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const snow = getConfig().snowluma || {};
        if (which === 'ws') return json(res, 200, { token: String(snow.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(snow.httpAccessToken || snow.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // Key 解析顺序（2026-09-20 修 401 高发）：显式明文 > 按 providerId 查该提供商
          // 保存的 Key（dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 旧实现只看顶层 Key —— 多提供商场景下顶层只存"当前选中那个"的 Key，
          // 从其它提供商拉列表就会拿错 Key，全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const pid = String(body.providerId ?? '').trim();
            const p = pid ? currentProviders().find((x) => x.id === pid) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          const result = await testModelChat({ baseUrl, apiKey, model });
          // 「思考方言」由内置方言表识别（原 thinking-adapters 插件收编进核心）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            thinking = detectThinkingDialect({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        const skillContext = {
          skills: skillManager,
          toolsCfg: effective.tools || {},
          visionEnabled: effective.api?.vision !== false
            && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision',
          searchEnabled: effective.webSearch?.enabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' }
        };
        const { buildSystemPrompt } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        return json(res, 200, {
          systemPrompt: buildSystemPrompt({ skillContext }),
          tools
        });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },

    // ── 社区市场：账号 + 发布 + 口令安装（全部代理官网，浏览器不直连）──────
    // 凭据存 data/account.json（不走 config：GET /api/config 会脱敏回传整个配置，
    // 塞进 config 等于自造泄露面）。所有端点失败都返回 502 + 服务器原始文案。
    {
      method: 'GET', pattern: '/api/market/accounts',
      handler: async ({ res, json }) => {
        const accounts = listAccounts().map((a) => ({ username: a.username, savedAt: a.savedAt }));
        return json(res, 200, { ok: true, accounts });
      }
    },
    {
      // 登录 / 注册。mode: login | register。注册三要素：登录 ID + 展示用户名 + 密码。
      // 成功后凭据自动落盘。
      method: 'POST', pattern: '/api/market/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = await loginAccount({
            loginId: String(body?.loginId || ''),
            displayName: String(body?.displayName || ''),
            password: String(body?.password || ''),
            mode: body?.mode === 'register' ? 'register' : 'login'
          });
          return json(res, 200, { ok: true, account: r.account, accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登出（删本地凭据 + 吊销远端 token）
      method: 'POST', pattern: '/api/market/logout',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const username = String(body?.username || '');
        if (!username) return json(res, 400, { ok: false, error: '缺少 username' });
        const accounts = await removeAccount(username);
        return json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      }
    },
    {
      // 发布一个已安装的 skill/plugin 到市场（待审核）。
      // body: { kind: 'skill'|'plugin', id, displayName, description, accountUsername }
      method: 'POST', pattern: '/api/market/publish',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const id = String(body?.id || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
          return json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        }
        const acc = listAccounts().find((a) => a.username === String(body?.accountUsername || ''));
        if (!acc) return json(res, 401, { ok: false, error: '请先选择一个已登录的账号' });
        try {
          const r = await publishModule({
            kind, id,
            displayName: String(body?.displayName || ''),
            description: String(body?.description || ''),
            token: acc.token,
            // 阿里云验证码验签参数：远端市场对发布强制要求（一次性，前端弹出验证后拿到）
            captchaVerifyParam: String(body?.captchaVerifyParam || '')
          });
          return json(res, 200, {
            ok: true, item: r.item || null,
            renamedTo: r.renamedTo || null,
            note: r.note || ''
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会装进 plugins/。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });
        try {
          const r = await installByCode({ code, verified: body?.entry || null });
          // 安装完立即重扫，让新模块马上出现在页签里（热重载 watcher 也行，
          // 但目录删除重建的场景 watcher 会丢事件 —— reload 是唯一可靠路径）
          try { await reloadSkills({ reason: 'market-install' }); } catch { /* 重扫失败不影响安装结果 */ }
          return json(res, 200, { ok: true, kind: r.kind, id: r.id, dir: r.dir });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 skillManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(skillManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        // 兼容性预检：把"在我们这个 fork 里可能跑不起来"的点随列表带出去，UI 直接显示
        const listed = skillManager.list(context).map((s) => {
          try {
            const kind = String(s.kind || (s.dir && /plugins/.test(String(s.dir)) ? 'plugin' : 'skill'));
            // s.dir 是相对路径（如 plugins/xxx），必须基于 ROOT 解析，否则 existsSync 永远失败
            const rel = String(s.dir || '');
            const dir = rel
              ? (path.isAbsolute(rel) ? rel : path.resolve(ROOT, rel))
              : path.join(ROOT, kind === 'plugin' ? 'plugins' : 'skills', String(s.id));
            const r = analyzeExtension(dir, kind);
            return { ...s, compat: { ok: r.ok, warnings: r.warnings, info: r.info } };
          } catch { return { ...s, compat: { ok: true, warnings: [], info: {} } }; }
        });
        return json(res, 200, {
          skills: listed,
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 删除插件/技能：目录移到 data/trash/extensions/<id>-<时间戳>（可恢复），
      // 同时清掉配置段（skills.<id>），最后重扫磁盘。
      method: 'POST', pattern: '/api/skills/delete',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const id = String(body?.id || '').trim();
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        const context = skillRuntimeContext();
        const hit = skillManager.list(context).find((x) => x && x.id === id);
        if (!hit) return json(res, 404, { ok: false, error: '未找到该插件/技能：' + id });
        if (!hit.dir) return json(res, 400, { ok: false, error: '该条目没有可删除的目录（可能是内置）' });
        const abs = path.resolve(ROOT, hit.dir);
        const rel = path.relative(ROOT, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/^(skills|plugins)[/\\]/.test(rel)) {
          return json(res, 400, { ok: false, error: '目录不在 skills/ 或 plugins/ 下，拒绝删除' });
        }
        const trashRoot = path.join(DATA_DIR, 'trash', 'extensions');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = path.join(trashRoot, id + '-' + stamp);
        try {
          fs.mkdirSync(trashRoot, { recursive: true });
          fs.renameSync(abs, trashDir);
        } catch (error) {
          try {
            fs.cpSync(abs, trashDir, { recursive: true });
            fs.rmSync(abs, { recursive: true, force: true });
          } catch (error2) {
            return json(res, 500, { ok: false, error: '删除失败：' + (error2?.message || error?.message || 'unknown') });
          }
        }
        const skillsCfg = getConfig()?.skills || {};
        if (Object.prototype.hasOwnProperty.call(skillsCfg, id)) {
          const next = { ...skillsCfg };
          delete next[id];
          updateConfig({ skills: { __replace__: next } });
        }
        try { await reloadSkills({ reason: 'extension-delete' }); } catch { /* 忽略 */ }
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          id,
          kind: hit.kind || hit.source || '',
          name: hit.name || id,
          trash: path.relative(DATA_DIR, trashDir),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          // ⚠️ 与 settingsView 同一套口径（2026-09-26 审查二轮）：
          //    ① secret 标记；② 字段名命中 /key|token|secret|password|cookie/i 的
          //    字符串字段（web-fetch 的 cookie 没有 secret 标记也属密文）。
          //    收到掩码 '******' 或空串 = "不修改" —— 否则用户只是打开表单点了
          //    保存，Cookie/Key 就被覆盖成六个星号。
          const SECRET_NAME_RE = /key|token|secret|password|cookie/i;
          const isSecretField = (k) => Boolean(schema[k]?.secret)
            || (SECRET_NAME_RE.test(k) && typeof current[k] === 'string');
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            if (isSecretField(k) && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(FIXED_PRICE_FEED_URL);
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizeConfig(next) });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch,
          // 来源标记：属于哪个 Skill（内置工具为 null）—— UI 据此打「skill」标识，
          // 并在所属技能失活时把工具整组隐藏（与提示词口径一致）。
          skillId: t.skillId ?? null
        }));
        return json(res, 200, { tools });
      }
    },

    // ── 自动备份 ────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/backup/run',
      handler: async ({ res, json }) => {
        const r = runBackup({ reason: 'manual', log: () => {} });
        if (!r.ok) return json(res, 400, { ok: false, error: r.error || '备份失败' });
        return json(res, 200, r);
      }
    },
    {
      method: 'GET', pattern: '/api/backup/list',
      handler: async ({ res, json }) => {
        const list = listBackups();
        return json(res, 200, { ok: true, count: list.length, backups: list });
      }
    },
    // ── 人格卡（人设系统重构）────────────────────────────────────────
    {
      // 用模型生成人格卡（阶段 4）：返回结构化卡片，不落盘 —— 前端预览编辑后再 POST /api/personas
      method: 'POST', pattern: '/api/personas/generate',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const desc = String(body?.description || '').trim();
        if (!desc) return json(res, 400, { ok: false, error: '缺少 description（你想要的角色描述）' });
        const cfg = getConfig();
        const genModel = String(cfg?.personaPolicy?.genModel || '').trim();
        const sys = [
          '你是「QQ 群聊机器人人格卡」作者。只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块。',
          'JSON 结构：',
          '{"name":"卡片名","variant":"本卡特有描述(依赖型/害羞型/傲娇型等人格变体，纯文本，200~800字)","examples":[{"user":"群友说的话","bad":"错误的AI式回复","good":"符合人格的正确回复"}],"scenarios":[{"id":"英文字母短id","trigger":"正则或关键词","text":"这个场景下的行为说明"}]}',
          '要求：',
          '1. variant 写"这个人格怎么说话、怎么反应"，不要写通用客服话术；400~800 字；',
          '2. examples 给 3~4 组，覆盖"被问是不是AI""被夸""被怼""冷场"之类；',
          '3. scenarios 给 2~4 段，每段 trigger 必须是一个合法正则（如 "(被夸|好厉害|你真棒)"），text 100~200 字；',
          '4. 全部用简体中文；不要出现"作为一个AI""我无法"这类话；',
          '5. 不要输出 JSON 以外的任何字符。'
        ].join('\n');
        let content = '';
        try {
          const r = await chatCompletion({
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: '角色描述：' + desc }
            ],
            temperature: 0.85,
            maxTokens: 2200,
            ...(genModel ? { overrides: { ...(cfg.api || {}), model: genModel } } : {})
          });
          content = String(r?.message?.content ?? r?.content ?? r?.choices?.[0]?.message?.content ?? r?.text ?? '');
        } catch (error) {
          return json(res, 500, { ok: false, error: '模型调用失败：' + (error?.message || error) });
        }
        // 解析 JSON（容忍 markdown 代码块包裹 / 前后废话）
        let card = null;
        const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
        card = tryParse(content.trim());
        if (!card) {
          const m = content.match(/\{[\s\S]*\}/);
          if (m) card = tryParse(m[0]);
        }
        if (!card || typeof card !== 'object') return json(res, 502, { ok: false, error: '模型没有返回合法 JSON', raw: content.slice(0, 500) });
        // 规范化 + 校验
        const clip = (v, n) => String(v || '').slice(0, n);
        const out = {
          name: clip(card.name, 40) || 'AI 生成卡',
          variant: clip(card.variant, 2000),
          examples: (Array.isArray(card.examples) ? card.examples : []).slice(0, 6).map((e) => ({
            user: clip(e?.user, 80), bad: clip(e?.bad, 200), good: clip(e?.good, 200)
          })).filter((e) => e.user && e.good),
          scenarios: (Array.isArray(card.scenarios) ? card.scenarios : []).slice(0, 6).map((sc, i) => {
            let trig = clip(sc?.trigger, 200);
              try { if (trig) new RegExp(trig); } catch { trig = ''; }  // 非法正则直接丢弃该触发词
            return { id: clip(sc?.id, 40) || ('scn_' + (i + 1)), trigger: trig, text: clip(sc?.text, 400) };
          }).filter((x) => x.text),
          useShared: true
        };
        if (!out.variant) return json(res, 502, { ok: false, error: '生成结果缺少 variant', raw: content.slice(0, 500) });
        return json(res, 200, { ok: true, model: genModel || '(主模型)', card: out });
      }
    },
    {
      // 列出可导入的「原版人格卡」：人格市场下载的 customPersonas + 旧的全局/会话级 roleText
      method: 'GET', pattern: '/api/personas/legacy',
      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const items = [];
        const seen = new Set();
        const push = (name, text, source) => {
          const body = String(text || '').trim();
          if (!body || body.length < 40) return;
          const key = name + '|' + body.slice(0, 80);
          if (seen.has(key)) return;
          seen.add(key);
          const parsed = parseLegacyCard(name, body);
          items.push({
            name,
            source,
            chars: body.length,
            preview: {
              variantChars: parsed.variant.length,
              examples: parsed.examples.length,
              scenarios: parsed.scenarios.length,
              sections: parsed.sections
            },
            text: body
          });
        };
        // ① 人格市场下载的自定义人格（customPersonas）
        const customs = Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [];
        customs.forEach((c, i) => push(String(c?.name || ('自定义人格 ' + (i + 1))), c?.text, 'market/customPersonas'));
        // ② 旧的全局 roleText
        if (cfg?.persona?.roleText) push('全局人设（旧）', cfg.persona.roleText, 'legacy/persona.roleText');
        // ③ 旧的会话级 roleText
        const byChat = cfg.personaByChat || {};
        for (const [k, v] of Object.entries(byChat)) {
          if (v && typeof v === 'object' && v.roleText) push('会话定制 ' + k, v.roleText, 'legacy/personaByChat');
        }
        return json(res, 200, { ok: true, items, count: items.length });
      }
    },
    {
      // 解析一段人格卡文本 → 新结构（不落盘，前端预览用）
      method: 'POST', pattern: '/api/personas/parse',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body?.name || '').trim();
        const text = String(body?.text || '');
        if (!text.trim()) return json(res, 400, { ok: false, error: '缺少 text' });
        const parsed = parseLegacyCard(name, text);
        return json(res, 200, { ok: true, card: parsed });
      }
    },
    {
      // 批量导入：items[{name,text}] → 解析 + 创建
      method: 'POST', pattern: '/api/personas/import',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const items = Array.isArray(body?.items) ? body.items : [];
        if (!items.length) return json(res, 400, { ok: false, error: '缺少 items' });
        const cfg = getConfig();
        const personas = Array.isArray(cfg.personas) ? cfg.personas.slice() : [];
        const created = [];
        for (const it of items) {
          const text = String(it?.text || '');
          if (!text.trim()) continue;
          const parsed = parseLegacyCard(String(it?.name || ''), text);
          const id = 'p_imp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
          const card = {
            id,
            name: parsed.name,
            builtin: false,
            variant: parsed.variant,
            examples: parsed.examples,
            scenarios: parsed.scenarios,
            useShared: false,          // 原版卡是完整卡（自带全部内容），不拼共用段
            meta: { source: 'imported', importedAt: Date.now(), chars: text.length }
          };
          personas.push(card);
          created.push({ id: card.id, name: card.name, variantChars: card.variant.length, examples: card.examples.length, scenarios: card.scenarios.length });
        }
        updateConfig({ personas });
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, created, total: personas.length, config: sanitizeConfig(getConfig()) });
      }
    },
    // ── 通用卡（多张 + 人设卡挂靠）────────────────────────────────
    {
      method: 'GET', pattern: '/api/memory-cards/generals',
      handler: async ({ res, json }) => json(res, 200, { ok: true, generals: listGenerals() })
    },
    {
      method: 'POST', pattern: '/api/memory-cards/generals',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        return json(res, 200, createGeneral(body || {}));
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-cards\/generals\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const card = getGeneralById(match[1]);
        if (!card) return json(res, 404, { ok: false, error: '没有这张通用卡' });
        return json(res, 200, { ok: true, card });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-cards\/generals\/([\w-]+)$/,
      handler: async ({ req, res, json, match }) => {
        const body = await bodyOf(req);
        const r = updateGeneralById(match[1], body || {});
        if (!r.ok) return json(res, 404, { ok: false, error: '没有这张通用卡' });
        return json(res, 200, r);
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-cards\/generals\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const r = deleteGeneral(match[1]);
        if (!r.ok) return json(res, 400, { ok: false, error: r.error === 'global_protected' ? '全局默认卡不能删（先把另一张设为全局）' : '没有这张通用卡' });
        return json(res, 200, r);
      }
    },
    // ── 记忆卡（群聊 / 个人 / 基本事实）────────────────────────────
    {
      method: 'POST', pattern: '/api/memory-cards/batch',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        try {
          const r = orchestrator.startMemoryBatchNow({ force: body.force !== false });
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/memory-cards/batch/status',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ...orchestrator.memoryBatchStatus() })
    },
    {
      method: 'POST', pattern: '/api/memory-cards/auto',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const chatKey = String(body.chatKey || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        try {
          const r = await orchestrator.updateMemoryCardsNow(chatKey);
          return json(res, 200, r);
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/decision/status',
      handler: async ({ res, json, url }) => {
        const chatKey = String(url.searchParams.get('chatKey') || '').trim();
        return json(res, 200, { ok: true, ...decisionStatus(chatKey), stats: decisionStats() });
      }
    },
    {
      method: 'GET', pattern: '/api/decision/logs',
      handler: async ({ res, json, url }) => {
        const limit = Number(url.searchParams.get('limit') || 100);
        const chatKey = String(url.searchParams.get('chatKey') || '').trim();
        const minScore = url.searchParams.get('minScore');
        const maxScore = url.searchParams.get('maxScore');
        if (!chatKey && minScore == null && maxScore == null) return json(res, 200, { ok: true, logs: listDecisions(limit) });
        return json(res, 200, { ok: true, logs: queryDecisions({ chatKey, minScore, maxScore, limit }) });
      }
    },
    {
      method: 'GET', pattern: '/api/decision/export.csv',
      handler: async ({ res }) => {
        const rows = queryDecisions({ limit: 500 });
        const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const head = ['time', 'chatKey', 'score', 'low', 'high', 'highHit', 'action', 'skipped', 'tookMs', 'text', 'top1'];
        const lines = [head.join(',')];
        for (const r of rows) {
          lines.push([
            new Date(Number(r.at) || 0).toISOString(),
            esc(r.chatKey), r.score == null ? '' : r.score,
            r.low == null ? '' : r.low, r.high == null ? '' : r.high,
            r.highHit ? 1 : 0, esc(r.action || ''), esc(r.skipped || ''),
            r.tookMs || '', esc(String(r.text || '').slice(0, 120)),
            esc((r.top && r.top[0] && r.top[0].text) || '')
          ].join(','));
        }
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="decision-log.csv"'
        });
        res.end('\ufeff' + lines.join('\n'));
      }
    },
    {
      method: 'POST', pattern: '/api/decision/reindex',
      handler: async ({ req, res, json }) => {
        const b = await readBody(req).catch(() => ({}));
        const cfg = getConfig();
        const chatKey = String(b.chatKey || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        try {
          const msgs = store.recent(chatKey, { limit: 200 });
          const items = buildCorpus(chatKey, msgs, cfg);
          const r = b.rebuild === false ? await ensureIndex(chatKey, items, cfg) : await rebuildIndex(chatKey, items, cfg);
          return json(res, 200, { ok: true, ...r, status: indexStatus(chatKey) });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e?.message ?? e) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/identity-links',
      handler: async ({ res, json }) => {
        // 官方通道候选：最近收到的会话；OneBot 候选：存档里数字 id 的会话
        const official = [];
        try {
          for (const [key, v] of qqbotChats.entries()) {
            official.push({ key, name: v.nickname || '', lastText: String(v.lastText || '').slice(0, 40), at: v.at || 0 });
          }
        } catch { /* 忽略 */ }
        const onebot = [];
        try {
          for (const key of store.listChats()) {
            const id = String(key).split(':')[1] || '';
            if (!/^\d+$/.test(id)) continue;
            const meta = store.getChatMeta(key) || {};
            onebot.push({ key, name: meta.chatName || '', at: meta.lastTs || 0 });
          }
        } catch { /* 忽略 */ }
        return json(res, 200, { ok: true, links: listLinks(), history: listHistory(), candidates: { official, onebot } });
      }
    },
    {
      method: 'POST', pattern: '/api/identity-links/add',
      handler: async ({ req, res, json }) => {
        const b = await readBody(req).catch(() => ({}));
        const r = addLink({ onebotKey: b.onebotKey, qqbotKey: b.qqbotKey, note: b.note, mode: b.mode });
        return json(res, r.ok ? 200 : 400, r);
      }
    },
    {
      method: 'POST', pattern: '/api/identity-links/mode',
      handler: async ({ req, res, json }) => {
        const b = await readBody(req).catch(() => ({}));
        const r = setLinkMode(String(b.id || ''), String(b.mode || ''));
        return json(res, r.ok ? 200 : 400, r);
      }
    },
    {
      method: 'POST', pattern: '/api/identity-links/unlink-all',
      handler: async ({ req, res, json }) => {
        const b = await readBody(req).catch(() => ({}));
        const ids = listLinks().map((l) => l.id);
        const copiedAll = { impressions: 0, cards: 0 };
        let done = 0;
        let failed = 0;
        for (const id of ids) {
          try {
            const r = unlink(id, { copy: b.copy === true });
            if (!r.ok) { failed += 1; continue; }
            done += 1;
            if (b.copy === true && r.link) {
              const st = copyAfterUnlink(r.link);
              copiedAll.impressions += st.impressions;
              copiedAll.cards += st.cards;
            }
          } catch { failed += 1; }
        }
        return json(res, 200, { ok: true, count: done, failed, copied: copiedAll });
      }
    },
    {
      method: 'POST', pattern: '/api/identity-links/unlink',
      handler: async ({ req, res, json }) => {
        const b = await readBody(req).catch(() => ({}));
        const r = unlink(String(b.id || ''), { copy: b.copy === true });
        if (r.ok && b.copy === true && r.link) r.copied = copyAfterUnlink(r.link);
        return json(res, r.ok ? 200 : 400, r);
      }
    },
    {
      method: 'POST', pattern: '/api/identity-links/restore',
      handler: async ({ req, res, json }) => {
        const b = await readBody(req).catch(() => ({}));
        const r = restore(String(b.id || ''));
        return json(res, r.ok ? 200 : 400, r);
      }
    },
    {
      method: 'GET', pattern: '/api/prompt/skill-placement',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ...skillPlacementStatus() })
    },
    {
      method: 'GET', pattern: '/api/memory-layers',
      handler: async ({ res, json, url }) => {
        const chatKey = String(url.searchParams.get('chatKey') || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 30)));
        const impressions = (memory && typeof memory.query === 'function')
          ? (memory.query(chatKey).memberImpression || [])
          : [];
        return json(res, 200, {
          ok: true,
          chatKey,
          chunks: readChunks(chatKey, limit),
          semanticCards: readSemanticCards(chatKey),
          impressions,
          lastAutoCardsAt: lastAutoCardsAt(chatKey)
        });
      }
    },
    {
      method: 'GET', pattern: '/api/memory-cards',
      handler: async ({ res, json }) => {
        const d = listCards();
        return json(res, 200, { ok: true, ...d, stats: memoryCardStats() });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-cards\/person\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const card = getPerson(match[1]);
        if (!card) return json(res, 404, { ok: false, error: '没有这个人的卡' });
        return json(res, 200, { ok: true, card });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-cards\/group\/(.+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = decodeURIComponent(match[1]);
        const card = getGroup(chatKey);
        if (!card) return json(res, 404, { ok: false, error: '没有这个群的卡' });
        return json(res, 200, { ok: true, card });
      }
    },
    {
      method: 'GET', pattern: '/api/memory-cards/general',
      handler: async ({ res, json }) => json(res, 200, { ok: true, card: getGeneral() })
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-cards\/person\/(\d+)$/,
      handler: async ({ req, res, json, match }) => {
        const body = await bodyOf(req);
        const r = updatePerson(match[1], body || {});
        if (!r.ok) return json(res, 404, { ok: false, error: '没有这个人的卡' });
        return json(res, 200, r);
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-cards\/group\/(.+)$/,
      handler: async ({ req, res, json, match }) => {
        const body = await bodyOf(req);
        const r = updateGroup(decodeURIComponent(match[1]), body || {});
        if (!r.ok) return json(res, 404, { ok: false, error: '没有这个群的卡' });
        return json(res, 200, r);
      }
    },
    {
      method: 'PUT', pattern: '/api/memory-cards/general',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        return json(res, 200, updateGeneral(body || {}));
      }
    },
    {
      method: 'POST', pattern: '/api/memory-cards/backups/purge',
      handler: async ({ req, res, json }) => {
        const b = await readBody(req).catch(() => ({}));
        const days = b.olderThanDays == null ? (getConfig().memoryCards?.backupRetentionDays ?? 30) : Number(b.olderThanDays);
        if (b.listOnly === true) return json(res, 200, { ok: true, backups: listDeletedBackups({ olderThanDays: days }).length, olderThanDays: days });
        return json(res, 200, { ok: true, ...purgeDeletedBackups({ olderThanDays: days, dryRun: b.dryRun !== false }) });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-cards/persons/prune',
      handler: async ({ req, res, json }) => {
        const b = await bodyOf(req).catch(() => ({}));
        const out = prunePersons({
          mode: String(b.mode || 'no-content'),
          olderThanDays: Number(b.olderThanDays) || 30,
          maxMsgs: b.maxMsgs == null ? 1 : Number(b.maxMsgs),
          scope: String(b.scope || 'group') === 'all' ? 'all' : 'group',
          dryRun: b.dryRun !== false,
          qqs: Array.isArray(b.qqs) ? b.qqs : []
        });
        return json(res, 200, { ok: true, ...out });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-cards\/person\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const r = deletePerson(match[1]);
        return json(res, 200, r);
      }
    },
    // ── 话题卡（控制台「记忆 → 本会话」子页签）────────────────────────
    // 文件名 ↔ id 的映射只在 memory-cards.js 内部处理（不是简单 sanitize），
    // 界面/调用方只传 chatKey + id，绝不自己拼文件名 —— 否则会写出重复文件。
    {
      method: 'GET', pattern: '/api/memory-cards/topics',
      handler: async ({ res, url, json }) => {
        const chatKey = String(url?.searchParams?.get('chatKey') || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        return json(res, 200, { ok: true, chatKey, topics: listTopics(chatKey) });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-cards\/topics\/(.+)$/,
      handler: async ({ res, url, json, match }) => {
        const chatKey = String(url?.searchParams?.get('chatKey') || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        const card = getTopic(chatKey, decodeURIComponent(match[1]));
        if (!card) return json(res, 404, { ok: false, error: '没有这张话题卡' });
        return json(res, 200, { ok: true, card });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-cards/topics',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const chatKey = String(body?.chatKey || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        const r = createTopic(chatKey, body || {});
        if (!r.ok) {
          return json(res, 400, {
            ok: false,
            error: r.error === 'exists' ? '同 id 的话题卡已存在' : '会话标识不合法（应为 group:123 / private:456）'
          });
        }
        return json(res, 200, r);
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-cards\/topics\/(.+)$/,
      handler: async ({ req, res, url, json, match }) => {
        const body = await bodyOf(req);
        const chatKey = String(body?.chatKey || url?.searchParams?.get('chatKey') || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        const r = updateTopic(chatKey, decodeURIComponent(match[1]), body || {});
        if (!r.ok) return json(res, 404, { ok: false, error: '没有这张话题卡' });
        return json(res, 200, r);
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-cards\/topics\/(.+)$/,
      handler: async ({ res, url, json, match }) => {
        const chatKey = String(url?.searchParams?.get('chatKey') || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        const r = deleteTopic(chatKey, decodeURIComponent(match[1]));
        if (!r.ok) return json(res, 404, { ok: false, error: '没有这张话题卡' });
        return json(res, 200, r);
      }
    },
    {
      method: 'GET', pattern: '/api/personas',
      handler: async ({ res, json }) => {
        const cfg = getConfig();
        return json(res, 200, {
          personas: Array.isArray(cfg.personas) ? cfg.personas : [],
          shared: cfg.personaShared || {},
          policy: cfg.personaPolicy || {},
          defaultPersonaId: cfg.personaDefault || ''
        });
      }
    },
    {
      method: 'POST', pattern: '/api/personas',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name || '').trim();
        if (!name) return json(res, 400, { ok: false, error: '缺少 name' });
        const cfg = getConfig();
        const personas = Array.isArray(cfg.personas) ? cfg.personas.slice() : [];
        const id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const card = {
          id, name, builtin: false,
          variant: String(body.variant || ''),
          examples: Array.isArray(body.examples) ? body.examples : [],
          scenarios: Array.isArray(body.scenarios) ? body.scenarios : [],
          useShared: body.useShared !== false,
          meta: { source: 'manual', createdAt: Date.now() }
        };
        personas.push(card);
        updateConfig({ personas });
        return json(res, 200, { ok: true, persona: card });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/personas\/([\w-]+)$/,
      handler: async ({ res, json, req, match }) => {
        const id = match && match[1];
        const body = await readBody(req).catch(() => ({}));
        const cfg = getConfig();
        const personas = Array.isArray(cfg.personas) ? cfg.personas.slice() : [];
        const idx = personas.findIndex((p) => p && p.id === id);
        if (idx < 0) return json(res, 404, { ok: false, error: '卡片不存在' });
        if (personas[idx].builtin) return json(res, 403, { ok: false, error: '内置卡只读，不能编辑' });
        personas[idx] = {
          ...personas[idx],
          ...(body.name ? { name: String(body.name) } : {}),
          ...(typeof body.variant === 'string' ? { variant: body.variant } : {}),
          ...(typeof body.generalCardId === 'string' ? { generalCardId: body.generalCardId } : {}),
          ...(Array.isArray(body.examples) ? { examples: body.examples } : {}),
          ...(Array.isArray(body.scenarios) ? { scenarios: body.scenarios } : {}),
          updatedAt: Date.now()
        };
        updateConfig({ personas });
        return json(res, 200, { ok: true, persona: personas[idx] });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/personas\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const id = match && match[1];
        const cfg = getConfig();
        const personas = Array.isArray(cfg.personas) ? cfg.personas.slice() : [];
        const idx = personas.findIndex((p) => p && p.id === id);
        if (idx < 0) return json(res, 404, { ok: false, error: '卡片不存在' });
        if (personas[idx].builtin) return json(res, 403, { ok: false, error: '内置卡只读，不能删除' });
        // 决策 5：允许删除；引用它的会话回落到默认卡（默认卡若也是它或无默认 → 清空=静默）
        const def = String(cfg.personaDefault || '').trim();
        const fallback = def && def !== id ? def : '';
        const byChat = { ...(cfg.personaByChat || {}) };
        let affected = 0;
        for (const k of Object.keys(byChat)) {
          if (byChat[k] && byChat[k].personaId === id) {
            byChat[k] = { ...byChat[k], personaId: fallback };
            affected += 1;
          }
        }
        personas.splice(idx, 1);
        updateConfig({ personas, personaByChat: { __replace__: byChat }, ...(cfg.personaDefault === id ? { personaDefault: fallback } : {}) });
        return json(res, 200, { ok: true, affected, fallback: fallback || '(未设置→这些会话将静默)' });
      }
    },
    {
      method: 'POST', pattern: '/api/safe-mode/test',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const before = String(body.text ?? '');
        const r = redactText(before);
        return json(res, 200, { ok: true, before, after: r.text, hits: r.hits, enabled: r.enabled, level: r.level, cfg: getSafeModeConfig().enabled });
      }
    },
    {
      method: 'GET', pattern: '/api/persona-shared',
      handler: async ({ res, json }) => {
        const box = ensureSharedPresets();
        return json(res, 200, { ok: true, shared: getConfig().personaShared || {}, presets: box });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-shared/presets',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const box = ensureSharedPresets();
        const id = 'sh_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
        const item = {
          id,
          name: String(body.name || '共用段').slice(0, 40),
          core: typeof body.core === 'string' ? body.core : '',
          voice: typeof body.voice === 'string' ? body.voice : '',
          updatedAt: new Date().toISOString()
        };
        const items = [...box.items, item];
        const activate = body.activate !== false;
        const activeId = activate ? id : box.activeId;
        const patch = { personaSharedPresets: { activeId, items } };
        if (activate) patch.personaShared = { ...(getConfig().personaShared || {}), core: item.core, voice: item.voice };
        updateConfig(patch);
        return json(res, 200, { ok: true, item, presets: ensureSharedPresets() });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/persona-shared\/presets\/([\w-]+)$/,
      handler: async ({ res, json, req, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await readBody(req).catch(() => ({}));
        const box = ensureSharedPresets();
        const hit = box.items.find((x) => x.id === id);
        if (!hit) return json(res, 404, { ok: false, error: '没有这份共用段' });
        const next = {
          ...hit,
          ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim().slice(0, 40) } : {}),
          ...(typeof body.core === 'string' ? { core: body.core } : {}),
          ...(typeof body.voice === 'string' ? { voice: body.voice } : {}),
          updatedAt: new Date().toISOString()
        };
        const items = box.items.map((x) => (x.id === id ? next : x));
        const patch = { personaSharedPresets: { activeId: box.activeId, items } };
        if (box.activeId === id) patch.personaShared = { ...(getConfig().personaShared || {}), core: next.core, voice: next.voice };
        updateConfig(patch);
        return json(res, 200, { ok: true, item: next, presets: ensureSharedPresets() });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-shared\/presets\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const box = ensureSharedPresets();
        const hit = box.items.find((x) => x.id === id);
        if (!hit) return json(res, 404, { ok: false, error: '没有这份共用段' });
        const items = box.items.filter((x) => x.id !== id);
        let patch = { personaSharedPresets: { activeId: box.activeId, items } };
        if (box.activeId === id) {
          const fallback = items[0] || null;
          patch = {
            personaSharedPresets: { activeId: fallback ? fallback.id : '', items },
            personaShared: fallback ? { ...(getConfig().personaShared || {}), core: fallback.core || '', voice: fallback.voice || '' } : { core: '', voice: '' }
          };
        }
        updateConfig(patch);
        return json(res, 200, { ok: true, presets: ensureSharedPresets() });
      }
    },
    {
      method: 'POST', pattern: /^\/api\/persona-shared\/presets\/([\w-]+)\/activate$/,
      handler: async ({ res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const box = ensureSharedPresets();
        const hit = box.items.find((x) => x.id === id);
        if (!hit) return json(res, 404, { ok: false, error: '没有这份共用段' });
        updateConfig({
          personaSharedPresets: { activeId: id, items: box.items },
          personaShared: { ...(getConfig().personaShared || {}), core: hit.core || '', voice: hit.voice || '' }
        });
        return json(res, 200, { ok: true, presets: ensureSharedPresets() });
      }
    },
    {
      method: 'PUT', pattern: '/api/persona-shared',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const cur = getConfig().personaShared || {};
        const next = {
          ...cur,
          ...(typeof body.core === 'string' ? { core: body.core } : {}),
          ...(typeof body.voice === 'string' ? { voice: body.voice } : {})
        };
        const box = ensureSharedPresets();
        if (box.activeId) {
          const items = box.items.map((x) => (x.id === box.activeId
            ? { ...x, core: next.core || '', voice: next.voice || '', updatedAt: new Date().toISOString() }
            : x));
          updateConfig({ personaShared: next, personaSharedPresets: { activeId: box.activeId, items } });
        } else {
          updateConfig({ personaShared: next });
        }
        return json(res, 200, { ok: true, shared: next, presets: ensureSharedPresets() });
      }
    },
    {
      method: 'PUT', pattern: '/api/persona-policy',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const cur = getConfig().personaPolicy || {};
        const next = {
          ...cur,
          ...(Array.isArray(body.bannedPhrases) ? { bannedPhrases: body.bannedPhrases } : {}),
          ...(Array.isArray(body.promptOnlyPhrases) ? { promptOnlyPhrases: body.promptOnlyPhrases } : {}),
          ...(typeof body.bannedPhraseMode === 'string' ? { bannedPhraseMode: body.bannedPhraseMode } : {}),
          ...(body.outboundFilter && typeof body.outboundFilter === 'object' ? { outboundFilter: body.outboundFilter } : {})
        };
        updateConfig({ personaPolicy: next });
        return json(res, 200, { ok: true, policy: next });
      }
    },
    {
      method: 'GET', pattern: '/api/persona-assignments',
      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const groups = cfg?.onebot?.allow?.groups || cfg?.allow?.groups || [];
        const privates = cfg?.onebot?.allow?.private || cfg?.allow?.private || [];
        return json(res, 200, {
          assignments: cfg.personaByChat || {},
          defaultPersonaId: cfg.personaDefault || '',
          chats: [...groups.map((g) => 'group:' + g), ...privates.map((p) => 'private:' + p)]
        });
      }
    },
    {
      method: 'PUT', pattern: '/api/persona-assignments',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const chatKey = String(body.chatKey || '').trim();
        const personaId = String(body.personaId || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });
        const cfg = getConfig();
        const byChat = { ...(cfg.personaByChat || {}) };
        if (!personaId) {
          delete byChat[chatKey];
        } else {
          if (!Array.isArray(cfg.personas) || !cfg.personas.some((p) => p && p.id === personaId)) return json(res, 400, { ok: false, error: '卡片不存在' });
          byChat[chatKey] = { ...(byChat[chatKey] || {}), personaId };
        }
        updateConfig({ personaByChat: { __replace__: byChat } });
        return json(res, 200, { ok: true, assignments: byChat });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-assignments/batch',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const chatKeys = Array.isArray(body.chatKeys) ? body.chatKeys.map((x) => String(x).trim()).filter(Boolean) : [];
        const personaId = String(body.personaId || '').trim();
        const cfg = getConfig();
        if (personaId && (!Array.isArray(cfg.personas) || !cfg.personas.some((p) => p && p.id === personaId))) return json(res, 400, { ok: false, error: '卡片不存在' });
        const byChat = { ...(cfg.personaByChat || {}) };
        for (const k of chatKeys) {
          if (!personaId) delete byChat[k];
          else byChat[k] = { ...(byChat[k] || {}), personaId };
        }
        updateConfig({ personaByChat: { __replace__: byChat } });
        return json(res, 200, { ok: true, updated: chatKeys.length, assignments: byChat });
      }
    },
    {
      method: 'PUT', pattern: '/api/persona-default',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const personaId = String(body.personaId || '').trim();
        const cfg = getConfig();
        if (personaId && (!Array.isArray(cfg.personas) || !cfg.personas.some((p) => p && p.id === personaId))) return json(res, 400, { ok: false, error: '卡片不存在' });
        updateConfig({ personaDefault: personaId });
        return json(res, 200, { ok: true, defaultPersonaId: personaId });
      }
    },

    // ── 版本 / 更新 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => json(res, 200, {
        version: localVersion(),
        // Bug 反馈弹窗要把这两个路径附给用户（自己找日志目录太麻烦）
        dataDir: DATA_DIR,
        logDir: path.join(DATA_DIR, 'logs')
      })
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json, url }) => {
        const force = String(url?.searchParams?.get('force') || '') === '1';
        const info = await updateCheck({ force, current: localVersion() });
        return json(res, 200, info);
      }
    },
    {
      // 下载进度（前端轮询）
      method: 'GET', pattern: '/api/update/status',
      handler: async ({ res, json }) => json(res, 200, updateStatus())
    },
    {
      // 期 1：只下载安装包，绝不自动安装
      // 导出：GET 用默认；POST 可带 { sections, since, until, redact }
      method: '*', pattern: '/api/memory-bundle/export',
      handler: async ({ req, res, json }) => {
        let body = {};
        try { if (req.method === 'POST') body = (await bodyOf(req)) || {}; } catch { body = {}; }
        try {
          const r = exportToFile({
            appVersion: localVersion(),
            botName: getConfig()?.persona?.botName || '',
            sections: body?.sections ?? null,
            since: body?.since || null,
            until: body?.until || null,
            redact: body?.redact === true
          });
          return json(res, 200, r);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/memory-bundle/preview',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        let obj = body?.bundle;
        if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return json(res, 200, { ok: false, errors: ['JSON 解析失败'] }); } }
        const opts = { sections: body?.sections ?? null, since: body?.since || null, until: body?.until || null };
        try { return json(res, 200, previewImport(obj, opts)); }
        catch (error) { return json(res, 200, { ok: false, errors: [String(error?.message ?? error)] }); }
      }
    },
    {
      method: 'POST', pattern: '/api/memory-bundle/import',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        let obj = body?.bundle;
        if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return json(res, 200, { ok: false, errors: ['JSON 解析失败'] }); } }
        const mode = body?.mode === 'replace' ? 'replace' : 'merge';
        const opts = { mode, sections: body?.sections ?? null, since: body?.since || null, until: body?.until || null };
        try { return json(res, 200, applyImport(obj, opts)); }
        catch (error) { return json(res, 200, { ok: false, errors: [String(error?.message ?? error)] }); }
      }
    },
    {
      // 「载入当前记忆」：直接把 bundle 回给前端（不落文件）。
      // 现有 /api/memory-bundle/export 只写 data/exports/*.qqmem.json，
      // 而「记忆解释器」需要把当前记忆当场喂给解释器的 /api/bundle/inspect。
      method: 'GET', pattern: '/api/memory-bundle/json',
      handler: async ({ res, json, url }) => {
        try {
          const params = url?.searchParams || new URLSearchParams();
          const bundle = buildBundle({
            appVersion: localVersion(),
            botName: getConfig()?.persona?.botName || '',
            sections: parseSectionsQuery(params),
            since: params.get('since') || null,
            until: params.get('until') || null
          });
          return json(res, 200, { ok: true, bundle, counts: bundle.counts, stats: bundleStats(bundle) });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 记忆解释器（本地 qq-memory-studio 桥）────────────────────────────
    // 解释器本体是独立零依赖目录（server.mjs + src/merge.mjs），模块见
    // src/memory-studio.js，由 app.js 注入 deps。这里只做参数转发 ——
    // 所有失败都由模块兜成 { ok:false, error }，路由层不会 500。
    // 口径：状态/代理一律 200（前端只看 ok）；启动与停止失败用 400
    // （与 /api/snowluma/launch、/api/qq-portable/launch 一致）。
    {
      method: 'GET', pattern: '/api/memory-studio/status',
      handler: async ({ res, json }) => json(res, 200, memoryStudioStatus())
    },
    {
      method: 'POST', pattern: '/api/memory-studio/start',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const wanted = Number(body?.port);
        const result = await memoryStudioStart(Number.isFinite(wanted) && wanted > 0 ? { port: wanted } : {});
        return json(res, result.ok ? 200 : 400, result);
      }
    },
    {
      method: 'POST', pattern: '/api/memory-studio/stop',
      handler: async ({ res, json }) => {
        const result = await memoryStudioStop();
        return json(res, result.ok ? 200 : 400, result);
      }
    },
    {
      method: 'POST', pattern: '/api/memory-studio/call',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const result = await memoryStudioCall({ path: body?.path, method: body?.method, body: body?.body });
        return json(res, 200, result);
      }
    },
    {
      // 解释器有没有新版本（读它自己仓库的最新 Release）
      method: 'GET', pattern: '/api/memory-studio/update-check',
      handler: async ({ res, json }) => json(res, 200, await memoryStudioCheckUpdate())
    },
    {
      // 下载并安装/更新网页版解释器到 <安装根>/tools/memory-studio（不会动它的 data/）
      method: 'POST', pattern: '/api/memory-studio/install',
      handler: async ({ res, json }) => {
        try {
          const result = await memoryStudioInstall();
          return json(res, result.ok ? 200 : 200, result);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 用量页图表：桶 × 序列矩阵（折线/柱状 + 扇形占比）
      method: 'POST', pattern: '/api/usage/series',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const r = await buildUsageSeries({
          range: body && body.range,
          bucket: body && body.bucket,
          seriesBy: body && body.seriesBy,
          metric: body && body.metric
        });
        return json(res, 200, r);
      }
    },
    {
      method: 'GET', pattern: '/api/logs/channel',
      handler: async ({ res, json, url }) => {
        const { channelLogs: readLogs, CHANNELS: chans } = await import('./channel-log.js');
        const ch = String(url.searchParams.get('channel') || 'snowluma');
        const limit = Math.min(400, Math.max(20, Number(url.searchParams.get('limit')) || 200));
        if (!chans.includes(ch)) return json(res, 400, { ok: false, error: 'channel 只能是 snowluma / qqbot' });
        return json(res, 200, { ok: true, channel: ch, logs: readLogs(ch, limit) });
      }
    },
    {
      method: 'GET', pattern: '/api/allow-qqbot',
      handler: async ({ res, json }) => {
        const a = getConfig().allowQqbot || {};
        return json(res, 200, { ok: true, groups: a.groups || [], private: a.private || [] });
      }
    },
    {
      method: 'POST', pattern: '/api/allow-qqbot/remove',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const kind = String(body.kind || '');
        const id = String(body.id || '');
        if (!['groups', 'private'].includes(kind) || !id) return json(res, 400, { ok: false, error: '参数不合法' });
        const a = getConfig().allowQqbot || {};
        const next = { groups: [...(a.groups || [])], private: [...(a.private || [])] };
        next[kind] = next[kind].filter((x) => String(x) !== id);
        updateConfig({ allowQqbot: next });
        return json(res, 200, { ok: true, allowQqbot: next });
      }
    },
    {
      method: 'POST', pattern: '/api/transport/qqbot/simulate',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const cfg = getConfig();
        const g = (cfg.allowQqbot?.groups || [])[0];
        if (!g) return json(res, 400, { ok: false, error: 'allowQqbot 里还没有群 openid' });
        if (typeof simulateQqbotEvent !== 'function') return json(res, 500, { ok: false, error: '模拟入口未接线' });
        const text = String(body.text || '（本地模拟消息）');
        const evt = {
          kind: 'group',
          chatId: String(body.chatId || g),
          messageId: 'SIM-' + Date.now(),
          userId: 'SIM-USER',
          nickname: '本地模拟',
          text,
          atMe: true,
          raw: {}
        };
        try {
          await simulateQqbotEvent(evt);
          return json(res, 200, { ok: true, injected: evt.chatKey || ('group:' + evt.chatId), text });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 接入方式（QQ 接口：OneBot / 官方机器人） ─────────────────────
    {
      method: 'GET', pattern: '/api/transport/qqbot/chats',
      handler: async ({ res, json }) => {
        const list = qqbotChats instanceof Map ? [...qqbotChats.values()] : [];
        list.sort((a, b) => (b.at || 0) - (a.at || 0));
        return json(res, 200, { ok: true, chats: list.slice(0, 30) });
      }
    },
    {
      method: 'POST', pattern: '/api/transport/qqbot/chats/allow',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const kind = String(body.kind || '').trim();
        const id = String(body.id || '').trim();
        if (!['group', 'private'].includes(kind) || !id) return json(res, 400, { ok: false, error: '参数不合法' });
        const cfg = getConfig();
        const allow = { groups: [...(cfg.allowQqbot?.groups || [])], private: [...(cfg.allowQqbot?.private || [])] };
        const key = kind === 'group' ? 'groups' : 'private';
        if (!allow[key].includes(id)) allow[key].push(id);
        updateConfig({ allowQqbot: allow });
        return json(res, 200, { ok: true, allowQqbot: allow });
      }
    },
    {
      method: 'GET', pattern: '/api/transport/status',
      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const tr = cfg.transport || {};
        const qb = tr.qqbot || {};
        const account = Array.isArray(qb.accounts) ? qb.accounts[0] || {} : {};
        return json(res, 200, {
          ok: true,
          active: String(tr.active || 'onebot'),
          onebot: {
            connected: onebot.connected === true,
            wsUrl: String(cfg.snowluma?.wsUrl || ''),
            httpUrl: String(cfg.snowluma?.httpUrl || ''),
            hasToken: Boolean(cfg.snowluma?.accessToken || cfg.snowluma?.httpAccessToken)
          },
          qqbot: {
            configured: Boolean(String(account.appId || '').trim() && String(account.appSecret || '').trim()),
            appId: String(account.appId || ''),
            hasAppSecret: Boolean(String(account.appSecret || '').trim()),
            env: String(account.env || 'production'),
            groupMode: String(account.groupMode || 'all'),
            enabled: qb.enabled === true,
            capabilities: { canPoke: false, canReact: false, canGroupCard: false, canMute: false, canKick: false, markdown: true, media: true }
          }
        });
      }
    },
    {
      method: 'POST', pattern: '/api/transport/active',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const active = String(body.active || '').trim();
        if (!['onebot', 'qqbot', 'both'].includes(active)) return json(res, 400, { ok: false, error: 'active 只能是 onebot / qqbot / both' });
        updateConfig({ transport: { active } });
        return json(res, 200, { ok: true, active, note: '通道切换需要重启应用后生效' });
      }
    },
    {
      method: 'POST', pattern: '/api/transport/qqbot/save',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const cfg = getConfig();
        const qb = cfg.transport?.qqbot || {};
        const old = (Array.isArray(qb.accounts) ? qb.accounts[0] : null) || {};
        const appId = String(body.appId ?? old.appId ?? '').trim();
        const typedSecret = String(body.appSecret ?? '').trim();
        const account = {
          ...old,
          name: String(body.name ?? old.name ?? '').slice(0, 40),
          appId,
          // 空 = 保持原值（前端拿到的是掩码，不覆盖已保存的 Secret）
          appSecret: typedSecret || String(old.appSecret || ''),
          env: ['production', 'sandbox'].includes(String(body.env)) ? String(body.env) : (old.env || 'production'),
          groupMode: ['all', 'at'].includes(String(body.groupMode)) ? String(body.groupMode) : (old.groupMode || 'all')
        };
        if (!appId) return json(res, 400, { ok: false, error: 'AppID 不能为空' });
        updateConfig({ transport: { qqbot: { accounts: [account] } } });
        return json(res, 200, { ok: true, qqbot: { appId, hasAppSecret: Boolean(account.appSecret), env: account.env, groupMode: account.groupMode } });
      }
    },
    {
      method: 'POST', pattern: '/api/transport/qqbot/test',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req).catch(() => ({}));
        const cfg = getConfig();
        const qb = cfg.transport?.qqbot || {};
        const old = (Array.isArray(qb.accounts) ? qb.accounts[0] : null) || {};
        const account = {
          ...old,
          appId: String(body.appId ?? old.appId ?? '').trim(),
          appSecret: String(body.appSecret ?? '').trim() || String(old.appSecret || ''),
          env: String(body.env || old.env || 'production'),
          groupMode: String(body.groupMode || old.groupMode || 'all')
        };
        if (!account.appId || !account.appSecret) return json(res, 400, { ok: false, error: '请先填 AppID 和 AppSecret' });
        const t0 = Date.now();
        try {
          const { QqBotTransport } = await import('./transport/qqbot.js');
          const t = new QqBotTransport({ account });
          const token = await t.token();     // 只验鉴权，不建 WS（避免真连上后与正式实例抢事件）
          return json(res, 200, {
            ok: true,
            latencyMs: Date.now() - t0,
            tokenTail: String(token).slice(-6),
            note: '鉴权通过（AppSecret 有效）'
          });
        } catch (error) {
          return json(res, 200, { ok: false, latencyMs: Date.now() - t0, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/command-mute',
      handler: async ({ res, json }) => {
        const cm = getConfig().commandMute || {};
        const active = Object.entries(cm.active || {}).map(([groupId, until]) => ({ groupId: String(groupId), until: Number(until) || 0 }));
        return json(res, 200, {
          ok: true,
          enabled: cm.enabled !== false,
          command: String(cm.command || ''),
          releaseCommand: String(cm.releaseCommand || ''),
          releaseAdminOnly: cm.releaseAdminOnly === true,
          durationMin: Number(cm.durationMin) || 0,
          active
        });
      }
    },
    {
      method: 'POST', pattern: '/api/command-mute/release',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const active = { ...(getConfig().commandMute?.active || {}) };
        const id = String(body?.groupId || '').trim();
        let removed = 0;
        if (id) {
          if (Object.prototype.hasOwnProperty.call(active, id)) { delete active[id]; removed = 1; }
        } else {
          removed = Object.keys(active).length;
          for (const k of Object.keys(active)) delete active[k];
        }
        updateConfig({ commandMute: { active: { __replace__: active } } });
        return json(res, 200, { ok: true, removed, active });
      }
    },
    {
      method: 'POST', pattern: '/api/update/install',
      handler: async ({ res, json, req }) => {
        const body = await readBody(req).catch(() => ({}));
        const r = await installUpdate({ force: body?.force === true });
        return json(res, 200, r);
      }
    },
    {
      method: 'POST', pattern: '/api/update/clean-temp',
      handler: async ({ res, json }) => json(res, 200, cleanUpdateTemp())
    },
    {
      method: 'POST', pattern: '/api/update/download',
      handler: async ({ res, json }) => {
        try {
          const info = await updateCheck({ force: false, current: localVersion() });
          if (!info?.ok) return json(res, 200, { ok: false, error: info?.error || '检查更新失败' });
          if (!info.hasUpdate) return json(res, 200, { ok: false, error: '已是最新版本', latest: info.latest });
          if (!info.asset?.url) return json(res, 200, { ok: false, error: '这个 Release 没有可下载的安装包资产' });
          const r = await updateDownload(info.asset, info.latest);
          return json(res, 200, { ok: r.ok !== false, error: r.error || '', state: r.state || updateStatus() });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const removed = sessions.clearFinished();
        emit('session-end', { status: 'cleared', removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json }) => {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        await Promise.allSettled(chats.map(async (c) => {
          const key = String(c.key || '');
          const mp = /^private:(\d+)$/.exec(key);
          if (mp) {
            // 私聊：人物卡昵称最准；拿不到再用收到的最后一条消息昵称
            try { c.chatName = String(getPerson(mp[1])?.name || '').trim(); } catch { c.chatName = ''; }
            if (!c.chatName) {
              try { c.chatName = String(store.lastIncomingSenderName(key) || '').trim(); } catch { /* ignore */ }
            }
            return;
          }
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }
    },

    // ── 记忆 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/memory-files',
      handler: async ({ res, json }) => {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey, impressionCount, memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        const seen = new Set(files.map((f) => f.chatKey));
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy] });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-files\/(group|private)_([0-9A-Za-z]+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey) });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-files\/(group|private)_([0-9A-Za-z]+)\/members\/(\d+)$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: match[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_([0-9A-Za-z]+)\/members\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeMember(chatKey, match[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_([0-9A-Za-z]+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeChat(chatKey);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-files/consolidate',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          const force = body.force !== false;
          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) }))
            .catch((error) => emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) }))
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/chats\/(group|private)_([0-9A-Za-z]+)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply, media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          // 下载一律走 safe-fetch：这里的 url 来自请求体（前端/任何本机进程都能构造），
          // 直接 fetch 等于给了一个"让本机去抓内网"的 SSRF 入口。
          const safeToDataUrl = async (rawUrl) => {
            const { buffer, contentType } = await safeFetchBinary(String(rawUrl), 15 * 1024 * 1024, { browseLocked: browseLockState().enabled });
            if (!buffer?.length || buffer.length > 15 * 1024 * 1024) return null;
            const type = String(contentType || 'image/jpeg').split(';')[0].trim();
            if (!/^image\//i.test(type)) return null;
            return `data:${type};base64,${buffer.toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            try {
              const ret = await conn.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              if (!dataUrl && ret?.url) dataUrl = await safeToDataUrl(ret.url);
            } catch { /* 缓存没有 / 地址不可信就走下一条 */ }
            if (!dataUrl && it?.url) {
              try { dataUrl = await safeToDataUrl(it.url); } catch { /* 过期或不可信就放弃 */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 群成员 / 会话控制 ────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/groups\/(\d+)\/members$/,
      handler: async ({ res, json, match }) => {
        try {
          const list = await conn.call('get_group_member_list', { group_id: Number(match[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_([0-9A-Za-z]+)\/wake$/,
      handler: async ({ res, json }) => json(res, 410, { error: '已移除：不触发的消息现在会立即标为已读，无需手动唤醒' })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_([0-9A-Za-z]+)\/test-send$/,
      handler: async ({ req, res, json, match }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        // ⚠️ 白名单闸（2026-09-26 审查二轮）：本端点曾接受任意 group/private id ——
        //   任何通过来源校验的本地进程都能借它向**白名单外**的群/私聊发消息
        //   （绕过 send_to 工具的硬校验，等于给管理端开了一条无白名单的发送通道）。
        //   现在与 app.allowed() 同口径：deny 优先；allow 非空时必须在名单内；
        //   全空时必须显式开 allowAllWhenEmpty。
        const kind = match[1];
        const id = match[2];
        const cfgNow = getConfig();
        const denyList = cfgNow.deny?.[kind] ?? cfgNow.deny?.[`${kind}s`] ?? [];
        if (denyList.map(String).includes(String(id))) {
          return json(res, 403, { error: '该会话在黑名单内，不能发送' });
        }
        const allowList = cfgNow.allow?.[kind] ?? cfgNow.allow?.[`${kind}s`] ?? [];
        const allowed = allowList.length > 0
          ? allowList.map(String).includes(String(id))
          : cfgNow.allowAllWhenEmpty === true;
        if (!allowed) {
          return json(res, 403, { error: '该会话不在白名单内，不能发送（先在设置里加白名单，或开启空白名单放行）' });
        }
        try {
          const chatKey = `${kind}:${id}`;
          const data = await conn.sendText(kind, id, text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      // DSH → QQ 主动推送：dsh-qq 插件的 qq_send 工具打这里。
      // 鉴权走 /api/* 的统一 authorize()（server.token）+ 回环 Host 校验；
      // 业务闸与 app.allowed() 同口径（deny 优先，allow 非空必须在名单内）。
      method: 'POST', pattern: '/api/inbound',
      handler: async ({ req, res, json }) => {
        // 总开关关掉时整条通道下线（等价于"没装过这个改动"）
        if (getConfig().dsh?.enabled !== true) {
          return json(res, 403, { ok: false, error: 'DSH 桥已关闭（设置 → 聊天设置 → DSH 桥）' });
        }
        const body = await bodyOf(req);
        const chatKey = String(body.chat ?? body.chatKey ?? '').trim();
        const text = String(body.text ?? '').trim();
        if (!chatKey || !text) return json(res, 400, { ok: false, error: '缺少 chat 或 text' });
        const m = chatKey.match(/^(group|private):(\d+)$/);
        if (!m) return json(res, 400, { ok: false, error: 'chat 必须是 group:<群号> 或 private:<QQ号>' });
        const kind = m[1];
        const id = m[2];
        const cfgNow = getConfig();
        const denyList = cfgNow.deny?.[kind] ?? cfgNow.deny?.[`${kind}s`] ?? [];
        if (denyList.map(String).includes(id)) return json(res, 403, { ok: false, error: '该会话在黑名单内，不能发送' });
        const allowList = cfgNow.allow?.[kind] ?? cfgNow.allow?.[`${kind}s`] ?? [];
        const allowedNow = allowList.length > 0
          ? allowList.map(String).includes(id)
          : cfgNow.allowAllWhenEmpty === true;
        if (!allowedNow) return json(res, 403, { ok: false, error: '该会话不在白名单内，不能发送' });
        // 隐私闸门：主动推送同样不许把隐私信息发往非白名单会话
        const gate = getPrivacyFilter().filterText(chatKey, text);
        if (!gate.bypass && !gate.ok) {
          return json(res, 403, {
            ok: false,
            error: `隐私过滤拦截（命中 ${gate.blockedBy}）：这条内容不能发往 ${chatKey}`,
            privacy: { blocked: true, rules: gate.hits.map((h) => h.id) }
          });
        }
        try {
          // skipDedupe：主动推送与本轮回复可能一字不差，不能被去重窗口吞掉
          const r = await sender.sendTextBatch(chatKey, [gate.text], { skipDedupe: true });
          emit('chat-update', chatKey);
          return json(res, 200, {
            ok: true,
            messageId: r?.sent?.[0]?.messageId ?? null,
            ...(gate.hits.length ? { privacy: { redacted: gate.hits.map((h) => ({ id: h.id, count: h.count })) } } : {})
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // DSH → QQ 发文件：dsh-qq 插件的 qq_send_file 工具打这里。
      // 闸门与 /api/inbound 完全一致（总开关 / 白名单 / token），额外校验文件本身。
      method: 'POST', pattern: '/api/inbound-file',
      handler: async ({ req, res, json }) => {
        const cfgDsh = getConfig().dsh || {};
        if (cfgDsh.enabled !== true) {
          return json(res, 403, { ok: false, error: 'DSH 桥已关闭（设置 → 聊天设置 → DSH 桥）' });
        }
        const body = await bodyOf(req);
        const chatKey = String(body.chat ?? body.chatKey ?? '').trim();
        const filePath = String(body.path ?? body.file ?? '').trim();
        const wantName = String(body.name ?? '').trim();
        if (!chatKey || !filePath) return json(res, 400, { ok: false, error: '缺少 chat 或 path' });
        const m = chatKey.match(/^(group|private):(\d+)$/);
        if (!m) return json(res, 400, { ok: false, error: 'chat 必须是 group:<群号> 或 private:<QQ号>' });
        const kind = m[1];
        const id = m[2];
        const cfgNow = getConfig();
        const denyList = cfgNow.deny?.[kind] ?? cfgNow.deny?.[`${kind}s`] ?? [];
        if (denyList.map(String).includes(id)) return json(res, 403, { ok: false, error: '该会话在黑名单内，不能发送' });
        const allowList = cfgNow.allow?.[kind] ?? cfgNow.allow?.[`${kind}s`] ?? [];
        const allowedNow = allowList.length > 0
          ? allowList.map(String).includes(id)
          : cfgNow.allowAllWhenEmpty === true;
        if (!allowedNow) return json(res, 403, { ok: false, error: '该会话不在白名单内，不能发送' });

        let st;
        try {
          st = fs.statSync(filePath);
        } catch (error) {
          return json(res, 400, { ok: false, error: `读不到文件：${filePath}（${error?.code ?? error?.message}）` });
        }
        if (!st.isFile()) return json(res, 400, { ok: false, error: '不是普通文件（目录/设备）' });
        const maxBytes = Math.max(0, Number(cfgDsh.maxFileBytes) || 0);
        if (maxBytes > 0 && st.size > maxBytes) {
          return json(res, 413, {
            ok: false,
            error: `文件过大：${(st.size / 1048576).toFixed(1)}MB > 上限 ${(maxBytes / 1048576).toFixed(0)}MB（改 config.dsh.maxFileBytes）`
          });
        }
        // 允许目录闸：只在配置了 dsh.fileRoots 时生效（空 = 不限制）
        const roots = Array.isArray(cfgDsh.fileRoots) ? cfgDsh.fileRoots.map(String).filter(Boolean) : [];
        if (roots.length) {
          const resolved = path.resolve(filePath);
          const inside = roots.some((r) => {
            const root = path.resolve(r);
            return resolved === root || resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep);
          });
          if (!inside) return json(res, 403, { ok: false, error: '文件不在 dsh.fileRoots 允许的目录内' });
        }
        // 隐私闸门：文件名按文本规则处理；文本类文件的内容只做「拒发」级扫描
        // （读不了或不认识的扩展名就只判文件名，不阻断正常发文件）。
        const fileGate = getPrivacyFilter().filterFile(chatKey, filePath);
        if (!fileGate.bypass && !fileGate.ok) {
          const byContent = String(fileGate.blockedBy || '').startsWith('file-content:');
          return json(res, 403, {
            ok: false,
            error: byContent
              ? `隐私过滤拦截：文件内容命中 ${fileGate.blockedBy}，不能发往 ${chatKey}`
              : `隐私过滤拦截（文件名命中 ${fileGate.blockedBy}），不能发往 ${chatKey}`,
            privacy: { blocked: true, rules: fileGate.hits.map((h) => h.id) }
          });
        }
        const safeName = fileGate.bypass ? wantName : (fileGate.safeName || wantName);
        try {
          const r = await sender.sendFile(chatKey, { path: filePath, name: safeName });
          emit('chat-update', chatKey);
          return json(res, 200, {
            ok: true,
            fileId: r.fileId,
            name: r.name,
            bytes: st.size,
            ...(fileGate.hits.length ? { privacy: { redacted: fileGate.hits.map((h) => h.id) } } : {})
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_([0-9A-Za-z]+)\/mark-read$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: true, marked: store.drainUnread(`${match[1]}:${match[2]}`).length })
    },
    {
      // QQ 在线状态：给定时脚本（关闭前设"请勿打扰"）和插件用。
      // GET = 当前记账 + 配置；POST = { status: 'dnd' | 'online' | <协议整数> }，restore:true 按记账恢复。
      method: 'GET', pattern: '/api/presence',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ...presenceSummary() })
    },
    {
      method: 'POST', pattern: '/api/presence',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        if (body?.restore === true) {
          const r = await restoreIfDnd({ source: 'api' });
          return json(res, 200, { ok: true, restore: r });
        }
        try {
          const r = await setPresence(body?.status ?? body?.presence ?? '', { source: 'api' });
          if (!r.ok) return json(res, 400, { ok: false, error: r.error });
          return json(res, 200, { ok: true, status: r.status, ...presenceSummary() });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_([0-9A-Za-z]+)\/clear$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const removed = store.clearChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_([0-9A-Za-z]+)\/mute$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const marked = store.muteUnread(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_([0-9A-Za-z]+)\/delete-messages$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const removed = store.removeByLocalIds(chatKey, ids);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },

    // ── 验证码请求转发（2026-09-26）────────────────────────────────
    // 部分用户机器上 Chromium 渲染层对 *.aliyuncs.com / *.alicdn.com 的请求被
    // 本机安全软件按进程+域名压制（同机 Node 层、系统 curl 均正常），SDK 走不通。
    // 由主进程 Node 层（undici，网络栈独立且实测可达）代为转发。
    // 安全边界（防 SSRF）：目标仅允许 https + aliyuncs/alicdn 两族域名后缀；
    // 不跟随重定向；body 上限 8MB；响应上限 16MB；超时 15s。
    {
      method: '*', pattern: /^\/api\/captcha-forward\/?$/,
      handler: async ({ req, res, json, url }) => {
        const target = String((url && url.searchParams.get('u')) || '');
        let parsed;
        try { parsed = new URL(target); } catch {
          return json(res, 400, { ok: false, error: '缺少或非法的 u 参数' });
        }
        if (parsed.protocol !== 'https:' ||
            !/^[a-zA-Z0-9.-]+\.(aliyuncs\.com|alicdn\.com)$/.test(parsed.hostname)) {
          return json(res, 403, { ok: false, error: `目标不在转发白名单（仅 https 的 aliyuncs/alicdn 域）：${parsed.hostname}` });
        }
        // 读原始 body（POST 等需要；上限 8MB）
        const chunks = [];
        let size = 0;
        try {
          await new Promise((resolve, reject) => {
            req.on('data', (c) => {
              size += c.length;
              if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
              chunks.push(c);
            });
            req.on('end', resolve);
            req.on('error', reject);
          });
        } catch { /* 读失败按空 body 处理 */ }
        const reqBody = Buffer.concat(chunks);

        // 复制请求头（剥掉 hop-by-hop 与本机信息头）
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const kl = k.toLowerCase();
          if (['host', 'cookie', 'connection', 'content-length', 'origin', 'referer',
               'accept-encoding', 'transfer-encoding', 'upgrade', 'expect'].includes(kl)) continue;
          fwdHeaders[k] = v;
        }
        if (reqBody.length && !fwdHeaders['content-type']) fwdHeaders['content-type'] = 'application/octet-stream';

        try {
          const up = await fetch(parsed.href, {
            method: req.method,
            headers: fwdHeaders,
            body: (req.method === 'GET' || req.method === 'HEAD' || reqBody.length === 0) ? undefined : reqBody,
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
          });
          const buf = Buffer.from(await up.arrayBuffer());
          if (buf.length > 16 * 1024 * 1024) {
            return json(res, 502, { ok: false, error: '转发响应过大（>16MB）' });
          }
          const resHeaders = {};
          up.headers.forEach((v, k) => {
            const kl = k.toLowerCase();
            if (['transfer-encoding', 'content-encoding', 'content-length', 'connection', 'keep-alive'].includes(kl)) return;
            resHeaders[k] = v;
          });
          resHeaders['access-control-allow-origin'] = '*';   // 同源请求用不到，留作兜底
          res.writeHead(up.status, resHeaders);
          res.end(buf);
        } catch (e) {
          return json(res, 502, { ok: false, error: `转发失败：${String(e?.cause?.code || e?.message || e).slice(0, 120)}` });
        }
        return undefined;   // 已自行写响应
      }
    },
  ];
}

// 共用段预设：读出来 + 首次自动迁移（老的单份 personaShared → 一份预设）
function ensureSharedPresets() {
  const cfg = getConfig() || {};
  const box = cfg.personaSharedPresets && typeof cfg.personaSharedPresets === 'object' ? cfg.personaSharedPresets : {};
  let items = Array.isArray(box.items) ? box.items.filter((x) => x && x.id) : [];
  let activeId = String(box.activeId || '');
  const shared = cfg.personaShared || {};
  const hasText = String(shared.core || '').trim() || String(shared.voice || '').trim();
  if (!items.length && hasText) {
    const item = {
      id: 'sh_default',
      name: '默认共用段',
      core: String(shared.core || ''),
      voice: String(shared.voice || ''),
      updatedAt: new Date().toISOString()
    };
    items = [item];
    activeId = item.id;
    try { updateConfig({ personaSharedPresets: { activeId, items } }); } catch { /* ignore */ }
  }
  if (activeId && !items.some((x) => x.id === activeId)) activeId = items[0] ? items[0].id : '';
  return { activeId, items };
}
