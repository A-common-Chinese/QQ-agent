// skills 域路由（从 routes.js 拆出，路由体原样保留）。
// 依赖统一从 C 取：C = { ...deps, ...导入的函数, 局部辅助函数 }。
export function skillsRoutes(C) {
  const {
    store,
    sessions,
    orchestrator,
    emit,
    sanitizeConfig,
    readBody,
    reloadSkills,
    fs,
    path,
    getConfig,
    updateConfig,
    DATA_DIR,
    ROOT,
    chatCompletion,
    initPriceFeed,
    appendAudit,
    readAudit,
    searchFaq,
    buildFaqContext,
    faqSystemPrompt,
    loadFaq,
    summaryDynamicHistory,
    skillManager,
    analyzeExtension,
    unzipToModuleDir,
    validateZipStructure,
    getSkillConfig,
    setSkillConfig,
    setSkillEnabled,
    listConfiguredSkillIds,
    availabilityOf,
    listTools,
    CATEGORY_META,
    FIXED_PRICE_FEED_URL,
    bodyOf,
    skillRuntimeContext
  } = C;

  return {
    skills: [
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
      // 本地 zip 导入（线上市场下线后的唯一安装入口）
      // body: { kind: 'skill'|'plugin', filename, dataBase64 }
      // 支持三种 zip 结构：根目录直接放文件 / <id>/... / skills|plugins/<id>/...
      method: 'POST', pattern: '/api/skills/import-local',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = String(body?.kind || 'skill') === 'plugin' ? 'plugin' : 'skill';
        const filename = String(body?.filename || 'import.zip');
        const b64 = String(body?.dataBase64 || '');
        if (!b64) return json(res, 400, { ok: false, error: '缺少 dataBase64' });
        if (b64.length > 48 * 1024 * 1024) return json(res, 413, { ok: false, error: '文件太大（解压后上限 32MB）' });
        let buf;
        try { buf = Buffer.from(b64, 'base64'); } catch { return json(res, 400, { ok: false, error: 'dataBase64 解码失败' }); }
        if (!buf.length) return json(res, 400, { ok: false, error: '文件是空的' });
        try {
          const entries = validateZipStructure(buf);
          const names = entries.map((e) => e.name);
          const hasAll = (p) => names.length > 0 && names.every((n) => n.startsWith(p));
          let stripPrefix = '';
          if (hasAll('skills/')) stripPrefix = 'skills/';
          else if (hasAll('plugins/')) stripPrefix = 'plugins/';
          // 目录名：优先清单里的 id，其次文件名
          let preferId = '';
          const manifestName = kind === 'plugin' ? 'plugin.json' : 'skill.json';
          const m = entries.find((e) => e.name.split('/').pop() === manifestName);
          if (m) {
            try { preferId = String(JSON.parse(m.data.toString('utf8')).id || '').trim(); } catch { /* ignore */ }
          }
          if (!preferId) {
            preferId = filename.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'imported';
          }
          const dirName = await unzipToModuleDir(buf, { root: ROOT, type: kind, preferId, stripPrefix });
          let reloaded = null;
          if (typeof reloadSkills === 'function') {
            try { reloaded = await reloadSkills({ reason: 'import-local' }); } catch { /* 安装成功但重扫失败：下次刷新会补上 */ }
          }
          return json(res, 200, {
            ok: true,
            kind,
            dirName,
            path: (kind === 'plugin' ? 'plugins/' : 'skills/') + dirName,
            reloaded: reloaded
              ? { loaded: (reloaded.loaded || []).map((x) => x.id), failed: (reloaded.failed || []).map((x) => ({ id: x.id, error: x.error })) }
              : null
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
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
        const prevSafe = getConfig().safeMode?.enabled;
        const next = updateConfig(patch);
        const nowSafe = next.safeMode?.enabled;
        if (prevSafe !== false && nowSafe === false) appendAudit('safe-mode-off', { via: 'api-config' });
        if (prevSafe === false && nowSafe !== false) appendAudit('safe-mode-on', { via: 'api-config' });
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
      method: 'GET', pattern: '/api/decision/dynamic-history',
      handler: async ({ res, json, url }) => json(res, 200, { ok: true, ...summaryDynamicHistory(Number(url?.searchParams?.get('limit')) || 500) })
    },
    {
      method: 'GET', pattern: '/api/audit',
      handler: async ({ res, json, url }) => json(res, 200, { ok: true, items: readAudit(Number(url?.searchParams?.get('limit')) || 200) })
    },
    {
      // 内置 FAQ 问答（客户端「帮助」模块）：只用 FAQ + 客服提示词，不读写记忆、不经过 QQ
      method: 'POST', pattern: '/api/faq/chat',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const list = Array.isArray(body?.messages) ? body.messages : [];
        const lastUser = [...list].reverse().find((m) => m && m.role === 'user');
        const q = String(lastUser?.content || '').trim().slice(0, 800);
        if (!q) return json(res, 400, { ok: false, error: '缺少问题' });
        const cfg = getConfig();
        if (!cfg.api?.model || !cfg.api?.baseUrl) return json(res, 400, { ok: false, error: '还没有配置模型 API（设置 → 模型）' });
        const items = searchFaq(q, 5);
        const faqInfo = loadFaq();
        const sys = faqSystemPrompt(buildFaqContext(items), faqInfo.version);
        const history = list.slice(-6).map((m) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 2000) }));
        try {
          const resp = await chatCompletion({ messages: [{ role: 'system', content: sys }, ...history], temperature: 0.3, maxTokens: 700 });
          const answer = String(resp?.message?.content ?? resp?.content ?? '').trim();
          if (!answer) return json(res, 502, { ok: false, error: '模型返回空内容' });
          return json(res, 200, { ok: true, answer, matched: items.map((x) => x.id), version: faqInfo.version });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('../tool-registry.js');
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

    ],
  };
}
