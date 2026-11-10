// /dsh get_dsh_id / /dsh use 命令回归：解析 + 插件接口调用 + 回发文案
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseDshCommand, createDshBridge } = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-bridge.js')).href);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ', name); } else { fail += 1; console.log('  FAIL', name); }
};

// ── 解析 ──
check('parse get_dsh_id', parseDshCommand('/dsh get_dsh_id')?.kind === 'list');
check('parse id 别名', parseDshCommand('/dsh id')?.kind === 'list');
check('parse list 别名', parseDshCommand('/dsh list')?.kind === 'list');
check('parse use <id>', parseDshCommand('/dsh use session-abc')?.kind === 'use' && parseDshCommand('/dsh use session-abc')?.task === 'session-abc');
check('普通 /dsh 仍是 run', parseDshCommand('/dsh 跑一下测试')?.kind === 'run');
check('use 缺参数不当命令', parseDshCommand('/dsh use')?.kind === 'run');

// ── 模拟插件接口 ──
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  if (String(url).includes('/sessions')) {
    return {
      ok: true,
      json: async () => ({ ok: true, sessions: [
        { id: 'session-aaa', title: '第一个会话', at: 1762000000000, cwd: 'D:\\x' },
        { id: 'session-bbb', title: '第二个会话', at: 1761000000000, cwd: 'D:\\y' }
      ] })
    };
  }
  if (String(url).includes('/use')) {
    const sid = JSON.parse(init.body).sessionId;
    return { ok: true, json: async () => ({ ok: true, sessionId: sid, title: sid === 'session-bbb' ? '第二个会话' : '第一个会话' }) };
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) };
};

const sent = [];
const bridge = createDshBridge({
  getConfig: () => ({
    dsh: {
      enabled: true,
      transport: 'plugin',
      prefix: '/dsh',
      allowedSenderIds: ['10001'],
      pluginUrl: '',
      pluginToken: ''
    }
  }),
  sender: { sendTextBatch: async (chatKey, texts) => { sent.push(texts.join('\n')); } },
  log: () => {}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

bridge.handle('group:1', { text: '/dsh get_dsh_id', senderId: '10001', mid: null });
await sleep(300);
check('列表命令有回发', sent.length === 1);
check('列表显示名称（不铺 id）', sent[0]?.includes('第一个会话') && sent[0]?.includes('第二个会话') && !sent[0]?.includes('session-aaa'));
check('列表含 use 提示', sent[0]?.includes('use 序号'));

sent.length = 0;
bridge.handle('group:1', { text: '/dsh use 1', senderId: '10001', mid: null });
await sleep(300);
check('use 命令有回发', sent.length === 1);
check('use 序号成功（按名称回显）', sent[0]?.includes('已接入：第一个会话'));
check('use 序号解析成 id', calls.some((c) => c.url.includes('/use') && c.body?.sessionId === 'session-aaa'));

sent.length = 0;
bridge.handle('group:1', { text: '/dsh use 第二个', senderId: '10001', mid: null });
await sleep(300);
check('use 名称匹配成功', sent[0]?.includes('已接入：第二个会话'));
check('use 名称解析成 id', calls.some((c) => c.url.includes('/use') && c.body?.sessionId === 'session-bbb'));

sent.length = 0;
bridge.handle('group:1', { text: '/dsh use session-aaa', senderId: '10001', mid: null });
await sleep(300);
check('use 完整 id 仍可用', sent[0]?.includes('已接入：第一个会话'));

sent.length = 0;


sent.length = 0;
bridge.handle('group:1', { text: '/dsh use 1 这条消息来自qq', senderId: '10001', mid: null });
await sleep(300);
check('序号后带多余文字仍可接入', sent[0]?.includes('已接入：第一个会话'));

sent.length = 0;
bridge.handle('group:1', { text: '/dsh use <1>', senderId: '10001', mid: null });
await sleep(300);
check('尖括号占位符 <1> 可识别', sent[0]?.includes('已接入：第一个会话'));

sent.length = 0;
bridge.handle('group:1', { text: '/dsh use <id> 这条消息来自qq', senderId: '10001', mid: null });
await sleep(300);
check('字面占位符 <id> 给出明确提示', sent[0]?.includes('找不到') && sent[0]?.includes('get_dsh_id'));

sent.length = 0;
bridge.handle('group:1', { text: '/dsh get_dsh_id', senderId: '99999', mid: null });
await sleep(300);
check('非白名单仍被拦', sent[0]?.includes('白名单'));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
