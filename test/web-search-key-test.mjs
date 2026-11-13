#!/usr/bin/env node
// 搜索 Key 的取用顺序（A 方案：搜索专用 → 环境变量 → 对话同款）
// 为什么单独测：这条链一断，模型就会静默失去联网能力（10 月至今 75 次失败就是这么来的）。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve('src/web-search.js')).href);
const { resolveSearchKey, resolveChatKey } = mod;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const cfgBase = () => ({
  api: { provider: 'p1' },
  dshProviderKeys: { p1: 'sk-chat-dsh' },
  providers: [{ id: 'legacy', apiKey: 'sk-chat-legacy' }],
  webSearch: { deepseek: { apiKey: '' } }
});

// 1. 搜索专用 Key 优先
check('搜索专用 Key 优先',
  resolveSearchKey({ ...cfgBase(), webSearch: { deepseek: { apiKey: 'sk-search' } } }, {}).key === 'sk-search');

// 2. 打码值当没填
{
  const r = resolveSearchKey({ ...cfgBase(), webSearch: { deepseek: { apiKey: '******' } } }, { DEEPSEEK_API_KEY: 'sk-env' });
  check('掩码值不当作 Key', r.key === 'sk-env' && r.source === 'env', r.source);
}

// 3. 环境变量次之
{
  const r = resolveSearchKey(cfgBase(), { DEEPSEEK_API_KEY: 'sk-env' });
  check('环境变量可用', r.key === 'sk-env' && r.source === 'env', r.source);
}

// 4. 兜底复用对话 Key（dshProviderKeys）
{
  const r = resolveSearchKey(cfgBase(), {});
  check('复用对话 Key（dshProviderKeys）', r.key === 'sk-chat-dsh' && r.source === 'chat', r.source);
}

// 5. 兼容老结构 providers[].apiKey
{
  const cfg = { api: { provider: 'legacy' }, providers: [{ id: 'legacy', apiKey: 'sk-old' }], webSearch: { deepseek: {} } };
  check('兼容 providers[].apiKey', resolveChatKey(cfg) === 'sk-old');
}

// 6. 最后回落到 api.apiKey
{
  const cfg = { api: { provider: 'nope', apiKey: 'sk-direct' }, dshProviderKeys: {}, providers: [], webSearch: {} };
  check('回落 api.apiKey', resolveChatKey(cfg) === 'sk-direct');
}

// 7. 全都空 → 明确返回空（触发 Bing 回退）
{
  const r = resolveSearchKey({ api: { provider: 'x' }, dshProviderKeys: {}, providers: [], webSearch: {} }, {});
  check('无可用 Key 时返回空', r.key === '' && r.source === '', JSON.stringify(r));
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
