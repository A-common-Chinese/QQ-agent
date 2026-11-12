// system 域路由（从 routes.js 拆出，路由体原样保留）。
// 依赖统一从 C 取：C = { ...deps, ...导入的函数, 局部辅助函数 }。
export function systemRoutes(C) {
  const {
    memory,
    sessions,
    onebot,
    transport,
    qqbotStatus,
    qqbotStats,
    snowlumaInstalled,
    orchestrator,
    emit,
    log,
    localVersion,
    updateCheck,
    updateStatus,
    sanitizeConfig,
    readBody,
    snowlumaDir,
    snowlumaWsPort,
    snowlumaWebuiUrl,
    snowlumaStatus,
    qqPortableStatus,
    fs,
    path,
    spawn,
    getConfig,
    updateConfig,
    deepMergeConfig,
    DATA_DIR,
    estimateCost,
    cacheHitRate,
    modelImageVerdict,
    todayKey,
    logger,
    skillManager,
    runBackup,
    listBackups,
    exportToFile,
    previewImport,
    applyImport,
    buildBundle,
    bundleStats,
    getGlobalBlocklist,
    updateGlobalBlocklist,
    conn,
    bodyOf,
    parseSectionsQuery,
    deps
  } = C;

  return {
    status: [
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
          const { loadConfig } = await import('../config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    ],
    health: [
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

    ],
    config: [
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
        const { buildSystemPrompt } = await import('../prompt.js');
        const { buildToolDefs } = await import('../tools.js');
        const { getToolAvailability } = await import('../tool-registry.js');
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

    // （线上市场已下线：插件/技能只支持本地 zip 导入导出）

    ],
    backup: [
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
    ],
    update: [
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

    ],
    logs: [
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

    ],
  };
}
