// 附件桥第 1 步：配置解析（attachments / agentBridges 迁移 / 前缀冲突）+ /dsh 状态展示
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-merge-'));
process.env.QQ_AGENT_DATA_DIR = DATA;

const { resolveAttachmentBridges, enabledAttachmentBridges } = await import(pathToFileURL(path.join(ROOT, 'src', 'bridge-config.js')).href);
const { createDshBridge } = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-bridge.js')).href);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ', name); } else { fail += 1; console.log('  FAIL', name); }
};

// ── 显式 attachments ──
const explicit = resolveAttachmentBridges({
  dsh: { prefix: '/dsh', attachments: [
    { id: 'workbuddy', label: 'WorkBuddy', preset: 'codebuddy', prefix: '/wb', enabled: true, cmd: 'codebuddy' },
    { id: 'codex', label: 'Codex', preset: 'codex', prefix: '/codex', enabled: false, cmd: 'codex' }
  ] },
  agentBridges: [{ id: 'legacy', prefix: '/legacy', enabled: true, cmd: 'x' }]
});
check('显式 attachments 优先于 agentBridges', explicit.attachmentBridges.length === 2 && explicit.migratedFrom === null);
check('source 标记为 dsh.attachments', explicit.attachmentBridges.every((b) => b.source === 'dsh.attachments'));
check('preset 默认值已展开（codebuddy 有 cmd/models）', explicit.attachmentBridges[0].models.length > 0);
check('enabled 为 false 保持 disabled', explicit.attachmentBridges[1].enabled === false);
check('enabledAttachmentBridges 只返回启用项', enabledAttachmentBridges({ dsh: { attachments: [{ id: 'a', prefix: '/a', enabled: true, cmd: 'x' }] } }).length === 1);

// ── 旧 agentBridges 迁移 ──
const legacy = resolveAttachmentBridges({ agentBridges: [{ id: 'wb', label: 'WB', preset: 'codebuddy', prefix: '/wb', enabled: true }] });
check('agentBridges 自动迁移', legacy.attachmentBridges.length === 1 && legacy.migratedFrom === 'agentBridges');
check('迁移项 source 标记', legacy.attachmentBridges[0].source === 'agentBridges');

// ── 前缀冲突 ──
const conflict = resolveAttachmentBridges({ dsh: { prefix: '/dsh', attachments: [
  { id: 'a', prefix: '/dsh', enabled: true, cmd: 'x' },
  { id: 'b', prefix: '/wb', enabled: true, cmd: 'x' },
  { id: 'c', prefix: '/wb', enabled: true, cmd: 'x' }
] } });
check('与 /dsh 冲突被禁用', conflict.attachmentBridges[0].enabled === false && /冲突/.test(conflict.attachmentBridges[0].disabledReason));
check('附件之间重名前缀被禁用', conflict.attachmentBridges[2].enabled === false);
check('无冲突项仍启用', conflict.attachmentBridges[1].enabled === true);
check('前缀不带 / 被禁用', resolveAttachmentBridges({ dsh: { attachments: [{ id: 'x', prefix: 'wb', enabled: true, cmd: 'x' }] } }).attachmentBridges[0].enabled === false);

// ── 附件继承主桥策略 ──
const inherited = resolveAttachmentBridges({
  dsh: {
    prefix: '/dsh', allowedSenderIds: ['10001'], requireMentionInGroup: true,
    timeoutMs: 12345, showProgress: 'all', resultPromptChars: 50,
    attachments: [{ id: 'wb', prefix: '/wb', enabled: true, cmd: 'x' }]
  }
});
const inh = inherited.attachmentBridges[0];
check('继承主桥白名单', JSON.stringify(inh.allowedSenderIds) === JSON.stringify(['10001']));
check('继承群聊 @ 要求', inh.requireMentionInGroup === true);
check('继承超时', inh.timeoutMs === 12345);
check('继承进度设置', inh.showProgress === 'all');
check('继承结果摘要字数', inh.resultPromptChars === 50);
check('标记继承来源', inh.inherited.includes('allowedSenderIds') && inh.inherited.includes('timeoutMs'));

const overridden = resolveAttachmentBridges({
  dsh: {
    prefix: '/dsh', allowedSenderIds: ['10001'], requireMentionInGroup: true, timeoutMs: 12345,
    attachments: [{ id: 'wb', prefix: '/wb', enabled: true, cmd: 'x',
      allowedSenderIds: ['20002'], requireMentionInGroup: false, timeoutMs: 15000 }]
  }
}).attachmentBridges[0];
check('显式白名单覆盖主桥', JSON.stringify(overridden.allowedSenderIds) === JSON.stringify(['20002']));
check('显式 @ 策略覆盖主桥', overridden.requireMentionInGroup === false);
check('显式超时覆盖主桥', overridden.timeoutMs === 15000);
check('空白名单仍继承主桥', JSON.stringify(resolveAttachmentBridges({
  dsh: { prefix: '/dsh', allowedSenderIds: ['10001'], attachments: [{ id: 'wb', prefix: '/wb', enabled: true, cmd: 'x', allowedSenderIds: [] }] }
}).attachmentBridges[0].allowedSenderIds) === JSON.stringify(['10001']));

// ── 状态文件合并 + 旧文件迁移 ──
const { createStateStore } = await import(pathToFileURL(path.join(ROOT, 'src', 'bridge-core.js')).href);
fs.writeFileSync(path.join(DATA, 'dsh-sessions.json'), JSON.stringify({ 'group:1': { sessionId: 'dsh-old' } }), 'utf8');
fs.writeFileSync(path.join(DATA, 'agent-bridges.json'), JSON.stringify({ wb: { 'private:1': { sessionId: 'wb-old' } } }), 'utf8');
const dshStore = createStateStore({ basename: 'bridge-state.json', section: 'dsh', legacy: ['dsh-sessions.json'] });
const attachStore = createStateStore({ basename: 'bridge-state.json', section: 'attachments', legacy: ['agent-bridges.json'] });
check('dsh 旧文件自动迁移', dshStore.load()['group:1']?.sessionId === 'dsh-old');
check('附件旧文件自动迁移', attachStore.load().wb?.['private:1']?.sessionId === 'wb-old');
attachStore.save({ wb: { 'private:1': { sessionId: 'wb-new' } } });
const merged = JSON.parse(fs.readFileSync(path.join(DATA, 'bridge-state.json'), 'utf8'));
check('两个 section 共存', merged.dsh?.['group:1']?.sessionId === 'dsh-old' && merged.attachments?.wb?.['private:1']?.sessionId === 'wb-new');
check('旧文件保留（可回滚）', fs.existsSync(path.join(DATA, 'dsh-sessions.json')) && fs.existsSync(path.join(DATA, 'agent-bridges.json')));

// ── /dsh 状态列出附件 ──
const sent = [];
const bridge = createDshBridge({
  getConfig: () => ({ dsh: {
    enabled: true, prefix: '/dsh', transport: 'headless',
    allowedSenderIds: ['1'], requireMentionInGroup: false, workdir: DATA
  } }),
  sender: { sendTextBatch: async (_chat, texts) => { sent.push(texts.join('\n')); } },
  log: () => {},
  getAttachments: () => [
    { id: 'workbuddy', label: 'WorkBuddy', prefix: '/wb', enabled: true },
    { id: 'broken', label: 'Broken', prefix: '/dsh', enabled: false, disabledReason: '前缀 /dsh 与「dsh 主桥」冲突' }
  ]
});
bridge.handle('group:1', { text: '/dsh 状态', senderId: '1', mid: null });
await new Promise((r) => setTimeout(r, 300));
check('/dsh 状态有回发', sent.length >= 1);
check('/dsh 状态列出启用的附件', sent[0]?.includes('WorkBuddy /wb'));
check('/dsh 状态列出禁用的附件与原因', sent[0]?.includes('Broken /dsh') && sent[0]?.includes('冲突'));

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
