// 插件/技能兼容性预检
//
// 目的：装第三方（含官方市场）插件前，先告诉用户"在我们这个 fork 里能不能正常跑"。
// 检查的是**我们改过语义/数据的地方**，不是泛泛的语法检查：
//   1. 读 v0.4 旧记忆库 data/memory/ —— 该目录已归档，功能会静默失效
//   2. import 了核心模块里不存在的导出 —— 调用时会抛错
//   3. apiVersion 与本地 SKILL_API_VERSION 不一致
//   4. 放置类型与内容不符（plugin 没有 providers/hooks / skill 没有 registerTool）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { SKILL_API_VERSION } from './skills/manifest.js';

let exportCache = null;

/** 去掉注释（否则"注释里提到的旧 import"会被当成真 import 报误报） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 本文件内自己声明的名字（自包含兜底实现不该被报"缺导出"） */
function localDecls(code) {
  const set = new Set();
  for (const m of code.matchAll(/(?:^|[^\w.$])(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w.$])(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)) set.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w.$])class\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
  return set;
}

/** 扫描 src/*.js 的导出符号（缓存） */
function localExports() {
  if (exportCache) return exportCache;
  const map = new Map();
  const dir = path.join(ROOT, 'src');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch { files = []; }
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const set = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
    for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
    for (const m of src.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) set.add(name);
      }
    }
    map.set(f, set);
  }
  exportCache = map;
  return map;
}

/** 目录结构识别：kind + 入口文件路径 */
export function locateEntry(dir) {
  const cands = [path.join(dir, 'index.js'), path.join(dir, 'index.mjs')];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * 分析一个插件/技能目录
 * @returns {{ok:boolean, warnings:string[], info:object}}
 */
export function analyzeExtension(dir, kind = 'plugin') {
  const warnings = [];
  const info = {};
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch { /* ignore */ }

  // 1. apiVersion
  const api = Number(manifest.apiVersion);
  info.apiVersion = Number.isFinite(api) ? api : null;
  if (info.apiVersion !== null && info.apiVersion !== SKILL_API_VERSION) {
    warnings.push(`apiVersion 是 ${info.apiVersion}，本地核心是 ${SKILL_API_VERSION} —— 可能无法加载`);
  }

  const entry = locateEntry(dir);
  if (!entry) {
    warnings.push('找不到入口文件（index.js / index.mjs）');
    return { ok: false, warnings, info };
  }
  let src = '';
  try { src = fs.readFileSync(entry, 'utf8'); } catch { src = ''; }
  const code = stripComments(src);   // 只分析真正的代码，注释里提到的东西不算

  // 2. 读旧记忆库
  if (/DATA_DIR\s*,\s*['"`]memory['"`]/.test(src) || /data[\\/]memory(?:[\\/]|['"`])/.test(src)) {
    warnings.push('读取 data/memory/（v0.4 旧记忆库）—— 本 fork 已归档该目录，功能会失效；记忆请改用 data/memory-cards/');
  }

  // 3. import 的核心导出是否存在
  const exportsMap = localExports();
  const local = localDecls(code);
  for (const m of code.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]*src\/([A-Za-z0-9_\-]+)\.js)['"]/g)) {
    const file = m[3] + '.js';
    const have = exportsMap.get(file);
    if (!have) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!have.has(name) && !local.has(name)) warnings.push(`import 了核心模块里不存在的导出：${file} → ${name}（调用时会抛错）`);
    }
  }

  // 4. 放置类型与内容
  const hasProviders = /export\s+(?:const|let|var)\s+providers|export\s*\{[^}]*providers/.test(code);
  const hasHooks = /export\s+(?:const|let|var)\s+hooks|export\s*\{[^}]*hooks/.test(code);
  const regTool = /registerTool\s*\(/.test(code);
  info.kindMatches = true;
  if (kind === 'plugin' && !hasProviders && !hasHooks) {
    warnings.push('放在 plugins/ 但既没 export providers 也没 export hooks —— 通常应放在 skills/ 并 registerTool');
    info.kindMatches = false;
  }
  if (kind === 'skill' && !regTool) {
    warnings.push('放在 skills/ 但没有 registerTool —— 模型看不到任何工具，通常应放在 plugins/');
    info.kindMatches = false;
  }

  info.capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities.length : 0;
  return { ok: warnings.length === 0, warnings, info };
}
