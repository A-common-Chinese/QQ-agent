// 更新检查回归：缓存命中的 hasUpdate 必须按"当前版本"重算，前端展示也要再过一遍。
// 背景（2026-10-22 实测）：升到 0.5.7 后，update-check.json 里还留着"按 0.5.6 算出来的
// hasUpdate: true"，后端缓存命中原样返回 → 界面上一直显示"有新版本 0.5.7"。
process.env.QQ_AGENT_NO_AUTOCHECK = '1';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-updcheck-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = DATA;
const { checkForUpdate } = await import('../src/updater.js');
const { compareSemver } = await import('../src/updater.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.error('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const STATE = path.join(DATA, 'update-check.json');
const writeState = (obj) => fs.writeFileSync(STATE, JSON.stringify(obj, null, 1), 'utf8');
const cachedState = (over = {}) => ({
  ok: true, source: 'github', repo: 'x/y', current: '0.5.6', latest: '0.5.7',
  hasUpdate: true, url: 'https://example.invalid', asset: null, checkedAt: Date.now(), ...over
});

// ── 后端：缓存命中时按 current 重算 ──
writeState(cachedState());
let r = await checkForUpdate({ current: '0.5.7' });
check('缓存命中 + 已经是 0.5.7 → hasUpdate=false', r.cached === true && r.hasUpdate === false, JSON.stringify({ cached: r.cached, hasUpdate: r.hasUpdate }));
check('其余字段仍原样返回（latest/url 还在）', r.latest === '0.5.7' && !!r.url);

r = await checkForUpdate({ current: '0.5.6' });
check('缓存命中 + 还是 0.5.6 → hasUpdate=true', r.hasUpdate === true);

r = await checkForUpdate({ current: '0.5.8' });
check('缓存命中 + 比线上还新（0.5.8）→ hasUpdate=false', r.hasUpdate === false);

writeState(cachedState({ latest: '0.6.0' }));
r = await checkForUpdate({ current: '0.5.7' });
check('缓存 latest 更高（0.6.0）→ hasUpdate=true', r.hasUpdate === true);

r = await checkForUpdate({ current: '' });
check('current 未知 → 退回缓存里的 hasUpdate', r.hasUpdate === true);

// ── compareSemver 基线 ──
check('compareSemver：相等返回 0', compareSemver('0.5.7', '0.5.7') === 0);
check('compareSemver：v 前缀忽略', compareSemver('v0.5.8', '0.5.7') > 0);
check('compareSemver：位数不同（0.5 vs 0.5.0）相等', compareSemver('0.5', '0.5.0') === 0);

// ── 前端：展示前的兜底判断必须在 ──
const ui = path.join(import.meta.dirname, '..', 'ui', 'app');
const core = fs.readFileSync(path.join(ui, '00-core.js'), 'utf8');
const feedback = fs.readFileSync(path.join(ui, '10-feedback.js'), 'utf8');
const events = fs.readFileSync(path.join(ui, '07-settings-events.js'), 'utf8');
const render = fs.readFileSync(path.join(ui, '06-settings-render.js'), 'utf8');
check('00-core.js 提供 isNewerVersion()', /function isNewerVersion\(/.test(core));
check('10-feedback.js 用 isNewerVersion 兜底（不再直接信 hasUpdate）', /data\.hasUpdate\s*&&\s*isNewerVersion\(/.test(feedback));
check('07-settings-events.js 手动检查时用 isNewerVersion 兜底', /data\.hasUpdate\s*&&\s*isNewerVersion\(/.test(events));
check('07-settings-events.js 回填详情时用 isNewerVersion 兜底', /d\.hasUpdate\s*&&\s*isNewerVersion\(/.test(events));
check('06-settings-render.js 回填详情时用 isNewerVersion 兜底', /isNewerVersion\(info\.latest, info\.current\)/.test(render));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('');
if (fail) { console.error(`FAILED ${fail} / ${pass + fail}`); process.exit(1); }
console.log(`全部通过（${pass} 项）✅`);
