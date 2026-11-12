#!/usr/bin/env node
// 路由表完整性：拆分后必须仍然「条数够、无重复、handler 都是函数」。
// 拆分时真踩过的坑：模块漏解构 → handler 运行期 500；动态 import 相对路径失效。
// 这里只做结构断言（不启动服务），配合 coverage-http 的行为断言一起用。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const { createRoutes } = await import(pathToFileURL(path.resolve('src/routes.js')).href);
const transportStub = new Proxy({}, { get: () => () => Promise.resolve({}) });
const deps = new Proxy({ transport: transportStub }, { get: (t, k) => (k in t ? t[k] : undefined) });

const routes = createRoutes(deps);
check('路由条数 ≥ 170', routes.length >= 170, String(routes.length));
check('每条都是 {method, pattern, handler}', routes.every((r) => typeof r.method === 'string'
  && (typeof r.pattern === 'string' || r.pattern instanceof RegExp)
  && typeof r.handler === 'function'));

const sig = (r) => `${r.method} ${typeof r.pattern === 'string' ? r.pattern : String(r.pattern)}`;
const seen = new Map();
const dups = [];
for (const r of routes) {
  const k = sig(r);
  if (seen.has(k)) dups.push(k);
  seen.set(k, true);
}
check('没有重复的 method+pattern', dups.length === 0, dups.slice(0, 5).join(' | '));

// 顺序敏感：/api/config 这类精确路径要在同前缀的正则之前被抓到，
// 这里只断言第一个路由是 /api/status（拆分时顺序被打乱过一次）
check('首条仍是 GET /api/status', sig(routes[0]) === 'GET /api/status', sig(routes[0]));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
