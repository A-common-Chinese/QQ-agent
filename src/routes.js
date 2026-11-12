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
import { appendAudit, readAudit } from './audit.js';
import { searchFaq, buildFaqContext, faqSystemPrompt, loadFaq } from './faq.js';
import { summaryDynamicHistory } from './dynamic-history.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { parseLegacyCard } from './persona-import.js';
import { runBackup, listBackups } from './backup.js';
import { installUpdate, cleanUpdateTemp } from './updater.js';
import { analyzeExtension } from './plugin-compat.js';
import { unzipToModuleDir, validateZipStructure } from './zip-install.js';
import { zipDirectory } from './zip-write.js';
import { execFileSync } from 'node:child_process';

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
import { detectDialect as detectThinkingDialect } from './thinking.js';
import { asTransport } from './transport/index.js';
import { systemRoutes } from './routes/system.js';
import { modelsRoutes } from './routes/models.js';
import { qqRoutes } from './routes/qq.js';
import { memoryRoutes } from './routes/memory.js';
import { skillsRoutes } from './routes/skills.js';


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

  // 依赖 + 本文件里的辅助函数，一次性交给各域模块（它们各自解构需要的部分）
  const C = {
    deps,          // 路由体里有直接 deps.xxx() 的写法，必须带上原对象
    ...deps,
    conn, copyAfterUnlink, bodyOf, skillRuntimeContext, parseSectionsQuery,
    fs, path, spawn, getConfig, updateConfig, deepMergeConfig, DATA_DIR, ROOT, customSearch, listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate, resolveOfficialPrice, listOfficialPrices, refreshPriceFeed, priceFeedStatus, initPriceFeed, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider, scanModelsVision, visionResults, modelImageVerdict, builtinVisionResults, todayKey, setPresence, presenceSummary, restoreIfDnd, getPrivacyFilter, appendAudit, readAudit, searchFaq, buildFaqContext, faqSystemPrompt, loadFaq, summaryDynamicHistory, logger, skillManager, parseLegacyCard, runBackup, listBackups, installUpdate, cleanUpdateTemp, analyzeExtension, unzipToModuleDir, validateZipStructure, zipDirectory, execFileSync, exportToFile, previewImport, applyImport, buildBundle, bundleStats, redactText, getSafeModeConfig, listCards, getPerson, getGroup, getGeneral, updatePerson, updateGroup, updateGeneral, deletePerson, prunePersons, purgeDeletedBackups, listDeletedBackups, memoryCardStats, listGenerals, getGeneralById, createGeneral, updateGeneralById, deleteGeneral, listTopics, getTopic, createTopic, updateTopic, deleteTopic, readChunks, readSemanticCards, lastAutoCardsAt, skillPlacementStatus, listLinks, listHistory, addLink, setLinkMode, unlink, restore, listDecisions, decisionStats, queryDecisions, decisionStatus, buildCorpus, ensureIndex, rebuildIndex, indexStatus, getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds, availabilityOf, listTools, CATEGORY_META, safeFetchBinary, browseLockState, getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL, detectThinkingDialect, asTransport
  };

  const SYSTEM = systemRoutes(C);
  const MODELS = modelsRoutes(C);
  const QQ = qqRoutes(C);
  const MEMORY = memoryRoutes(C);
  const SKILLS = skillsRoutes(C);

  // 顺序与拆分前完全一致（路由按声明顺序匹配，不能按域重排）
  return [
    ...SYSTEM.status,
    ...MODELS.cost,
    ...MODELS.prices,
    ...QQ.snowluma,
    ...QQ.portableQQ,
    ...SYSTEM.health,
    ...MEMORY.personaTemplates,
    ...MODELS.providers,
    ...MODELS.vision,
    ...MODELS.search,
    ...MODELS.connTest,
    ...SYSTEM.config,
    ...SKILLS.skills,
    ...SYSTEM.backup,
    ...MEMORY.personaCards,
    ...MEMORY.genericCards,
    ...MEMORY.memoryCards,
    ...MEMORY.topics,
    ...SYSTEM.update,
    ...MEMORY.memoryStudio,
    ...QQ.transport,
    ...QQ.modelSession,
    ...MEMORY.memory,
    ...MEMORY.archive,
    ...QQ.members,
    ...SYSTEM.logs,
    ...QQ.captcha,
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
