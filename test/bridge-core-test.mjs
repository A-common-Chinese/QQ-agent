#!/usr/bin/env node
// bridge-core 的单元测试：两座桥共用的底座，改动会影响 /dsh 与 /wb 两侧，必须守住。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-core-test-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { createStateStore, stripLeadingAt, sessionKeyFor, killTree } =
  await import('../src/bridge-core.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// ── 状态存储 ────────────────────────────────────────────────
{
  const store = createStateStore({ basename: 'core-test.json', tag: '[test]' });
  check('新目录读出来是空对象', JSON.stringify(store.load()) === '{}');

  store.save({ a: { sessionId: 's1' } });
  check('写后能读回', store.load()?.a?.sessionId === 's1');

  store.save({ a: { sessionId: 's2' }, b: {} });
  check('覆盖写生效', store.load()?.a?.sessionId === 's2');

  const leftovers = fs.readdirSync(path.dirname(store.file())).filter((n) => n.endsWith('.tmp'));
  check('写后无 .tmp 残留', leftovers.length === 0, JSON.stringify(leftovers));

  fs.writeFileSync(store.file(), '{"broken":', 'utf8');
  check('坏 JSON 当空对象处理，不抛错', JSON.stringify(store.load()) === '{}');

  fs.writeFileSync(store.file(), '\uFEFF{"bom":1}', 'utf8');
  check('带 BOM 也能读', store.load()?.bom === 1);
}

// ── @ 前缀剥离 ──────────────────────────────────────────────
check('剥 @某人', stripLeadingAt('@张三 /dsh 跑测试') === '/dsh 跑测试');
check('剥 [@某人]', stripLeadingAt('[@张三] /dsh 跑测试') === '/dsh 跑测试');
check('两层 @ 都剥掉', stripLeadingAt('@张三 [@李四] /wb 干活') === '/wb 干活');
check('没 @ 时原样', stripLeadingAt('  /wb 干活  ') === '/wb 干活');
check('空输入不炸', stripLeadingAt(null) === '');

// ── 会话键 ──────────────────────────────────────────────────
check('per-chat 用 chatKey', sessionKeyFor('per-chat', 'private:1') === 'private:1');
check('global 用固定键', sessionKeyFor('global', 'private:1') === '__global__');
check('none 返回 null', sessionKeyFor('none', 'private:1') === null);
check('缺省按 per-chat', sessionKeyFor(undefined, 'group:2') === 'group:2');

// ── killTree 的边界 ─────────────────────────────────────────
check('pid 为 0 不抛错', (() => { try { killTree(0); return true; } catch { return false; } })());

console.log(`\n通过 ${pass}，失败 ${fail}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
