// qq 域路由（从 routes.js 拆出，路由体原样保留）。
// 依赖统一从 C 取：C = { ...deps, ...导入的函数, 局部辅助函数 }。
export function qqRoutes(C) {
  const {
    store,
    sessions,
    onebot,
    transport,
    qqbotChats,
    uninstallSnowluma,
    orchestrator,
    sender,
    emit,
    localVersion,
    updateCheck,
    updateStatus,
    updateDownload,
    readBody,
    authorize,
    snowlumaDir,
    snowlumaWebuiUrl,
    snowlumaStatus,
    snowlumaLogs,
    launchSnowluma,
    stopSnowluma,
    qqPortableStatus,
    qqPortableLogs,
    launchPortableQQ,
    stopPortableQQ,
    fs,
    path,
    spawn,
    getConfig,
    updateConfig,
    listModels,
    setPresence,
    presenceSummary,
    restoreIfDnd,
    getPrivacyFilter,
    installUpdate,
    cleanUpdateTemp,
    getPerson,
    restore,
    conn,
    bodyOf
  } = C;

  return {
    snowluma: [
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

    ],
    portableQQ: [
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

    ],
    transport: [
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
          const { QqBotTransport } = await import('../transport/qqbot.js');
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

    ],
    modelSession: [
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

    ],
    members: [
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

    ],
    captcha: [
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
    ],
  };
}
