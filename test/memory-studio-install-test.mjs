// 记忆解释器「下载 / 检查更新」的离线回归：
//   · Release JSON → 更新信息（版本比较、资产挑选）
//   · 网页版 zip 解压（剥根目录、跳过 .cmd、禁穿越）
//   · 路由与前端按钮都在（静态断言）
//
// 背景：解释器**不在** QQ Agent 安装包里，控制台要能自己把它取下来。
process.env.QQ_AGENT_NO_AUTOCHECK = '1';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-studio-install-'));
process.env.QQ_AGENT_DATA_DIR = path.join(TMP, 'data');
const { unzipToDirectory } = await import('../src/zip-install.js');
const { parseStudioRelease, pickWebAsset } = await import('../src/memory-studio.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.error('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// ── 造一个最小 zip（store 模式，不压缩；够本项目的解析器用）──
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);          // method 0 = store
    local.writeUInt32LE(0, 14);         // crc32（解析器不校验）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localRec = Buffer.concat([local, nameBuf, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);       // method
    central.writeUInt32LE(0, 16);       // crc
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    locals.push(localRec);
    offset += localRec.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

// ── 1) Release JSON → 更新信息 ──
const release = (tag, assets) => ({
  tag_name: tag, html_url: 'https://github.com/x/y/releases/tag/' + tag,
  body: 'notes', published_at: '2026-10-23T00:00:00Z', assets
});
const webAsset = { name: 'QQ-Memory-Studio-0.3.0-web.zip', size: 56000, digest: 'sha256:abc', browser_download_url: 'https://example/x.zip' };
const exeAsset = { name: 'QQ-Memory-Studio-0.3.0.exe', size: 72_000_000, digest: 'sha256:def', browser_download_url: 'https://example/x.exe' };

let info = parseStudioRelease(release('v0.3.0', [exeAsset, webAsset]), '0.2.0');
check('版本号去掉 v 前缀', info.latest === '0.3.0', info.latest);
check('0.2.0 → 0.3.0 判定有更新', info.hasUpdate === true);
check('挑的是 web zip（不是 exe）', info.asset?.name === 'QQ-Memory-Studio-0.3.0-web.zip', info.asset?.name);
check('资产信息（大小/摘要/直链）都带上', info.asset?.size === 56000 && info.asset?.digest === 'sha256:abc' && info.asset?.url === 'https://example/x.zip');
check('Release 说明被截断带上', info.notes === 'notes');

check('同版本 → 无更新', parseStudioRelease(release('v0.2.0', [webAsset]), '0.2.0').hasUpdate === false);
check('本地比线上新 → 无更新', parseStudioRelease(release('v0.2.0', [webAsset]), '0.2.5').hasUpdate === false);
check('没有 web zip 时退回普通 zip', pickWebAsset([{ name: 'a.exe' }, { name: 'pkg.zip' }])?.name === 'pkg.zip');
check('只有 exe 时不选中（避免把桌面版当网页版装）', pickWebAsset([exeAsset]) === null);
check('空资产不出错', pickWebAsset([]) === null && pickWebAsset(null) === null);

// ── 2) 网页版 zip 解压 ──
const zip = makeZip({
  'QQ-Memory-Studio-0.3.0-web/server.mjs': 'export {}',
  'QQ-Memory-Studio-0.3.0-web/src/merge.mjs': '// merge',
  'QQ-Memory-Studio-0.3.0-web/public/index.html': '<html></html>',
  'QQ-Memory-Studio-0.3.0-web/run.cmd': '@echo off',
  'QQ-Memory-Studio-0.3.0-web/创建桌面快捷方式.cmd': '@echo off'
});
const dest = path.join(TMP, 'installed');
const r = unzipToDirectory(zip, dest);
check('剥掉顶层目录（文件直接落在目标目录）', fs.existsSync(path.join(dest, 'server.mjs')));
check('src/public 也解出来', fs.existsSync(path.join(dest, 'src', 'merge.mjs')) && fs.existsSync(path.join(dest, 'public', 'index.html')));
check('跳过 .cmd（它们是给单独使用的用户的，控制台不需要）', !fs.existsSync(path.join(dest, 'run.cmd')));
check('回报跳过清单', r.skipped.length === 2, JSON.stringify(r.skipped));

// 目录穿越必须拒绝
const evil = makeZip({ 'root/ok.txt': 'x', 'root/../evil.txt': 'pwn' });
let threw = false;
try { unzipToDirectory(evil, path.join(TMP, 'evil')); } catch { threw = true; }
check('拒绝 ../ 目录穿越', threw === true);

// 解压不覆盖已有 data/（解释器的 Key 在这里）
fs.mkdirSync(path.join(dest, 'data'), { recursive: true });
fs.writeFileSync(path.join(dest, 'data', 'config.json'), '{"apiKey":"keep"}');
const zip2 = makeZip({ 'QQ-Memory-Studio-0.3.0-web/server.mjs': 'export const v = 2;' });
unzipToDirectory(zip2, dest);
check('重装不碰 data/config.json', JSON.parse(fs.readFileSync(path.join(dest, 'data', 'config.json'), 'utf8')).apiKey === 'keep');
check('程序文件被覆盖成新版', fs.readFileSync(path.join(dest, 'server.mjs'), 'utf8').includes('v = 2'));

// ── 3) 路由与前端按钮（静态断言）──
const root = path.join(import.meta.dirname, '..');
const routes = fs.readFileSync(path.join(root, 'src', 'routes.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'ui', 'app', '05-memory-settings.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
check('路由：GET /api/memory-studio/update-check', /pattern: '\/api\/memory-studio\/update-check'/.test(routes));
check('路由：POST /api/memory-studio/install', /pattern: '\/api\/memory-studio\/install'/.test(routes));
check('app.js 注入了 checkUpdate / install', /memoryStudioCheckUpdate, memoryStudioInstall/.test(app));
check('前端有「下载并安装解释器」按钮', /data-studio="install"[^>]*>\s*'?\s*\+?\s*\(st\.updateBusy === 'install' \? '正在下载并安装解释器…' : '下载并安装解释器'\)/.test(ui)
  || ui.includes('下载并安装解释器'));
check('前端有「检查更新」按钮', ui.includes('检查更新'));
check('已是最新时不显示"更新到"按钮（条件里要求 hasUpdate）', /st\.update\?\.ok && st\.update\.hasUpdate\s*\?/.test(ui));
check('安装成功后重新检测状态', /await memStudioLoadStatus\(true\);/.test(ui));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('');
if (fail) { console.error(`FAILED ${fail} / ${pass + fail}`); process.exit(1); }
console.log(`全部通过（${pass} 项）✅`);
