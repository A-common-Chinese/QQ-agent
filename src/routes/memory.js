// memory 域路由（从 routes.js 拆出，路由体原样保留）。
// 依赖统一从 C 取：C = { ...deps, ...导入的函数, 局部辅助函数 }。
export function memoryRoutes(C) {
  const {
    store,
    memory,
    onebot,
    transport,
    qqbotChats,
    simulateQqbotEvent,
    orchestrator,
    emit,
    log,
    sanitizeConfig,
    readBody,
    memoryStudioStatus,
    memoryStudioStart,
    memoryStudioStop,
    memoryStudioCall,
    memoryStudioCheckUpdate,
    memoryStudioInstall,
    buildUsageSeries,
    fs,
    path,
    getConfig,
    updateConfig,
    chatCompletion,
    parseLegacyCard,
    redactText,
    getSafeModeConfig,
    listCards,
    getPerson,
    getGroup,
    getGeneral,
    updatePerson,
    updateGroup,
    updateGeneral,
    deletePerson,
    prunePersons,
    purgeDeletedBackups,
    listDeletedBackups,
    memoryCardStats,
    listGenerals,
    getGeneralById,
    createGeneral,
    updateGeneralById,
    deleteGeneral,
    listTopics,
    getTopic,
    createTopic,
    updateTopic,
    deleteTopic,
    readChunks,
    readSemanticCards,
    lastAutoCardsAt,
    skillPlacementStatus,
    listLinks,
    listHistory,
    addLink,
    setLinkMode,
    unlink,
    restore,
    listDecisions,
    decisionStats,
    queryDecisions,
    decisionStatus,
    buildCorpus,
    ensureIndex,
    rebuildIndex,
    indexStatus,
    safeFetchBinary,
    browseLockState,
    conn,
    copyAfterUnlink,
    bodyOf,
    deps
  } = C;

  return {
    personaTemplates: [
    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('../personas.js');
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

    ],
    personaCards: [
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
    ],
    genericCards: [
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
    ],
    memoryCards: [
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
    ],
    topics: [
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

    ],
    memoryStudio: [
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
        const { channelLogs: readLogs, CHANNELS: chans } = await import('../channel-log.js');
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
    ],
    memory: [
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

    ],
    archive: [
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

    ],
  };
}
