// 「安装并重启」更新链路离线回归（2026-10-22）
//
// 为什么要有这个测试：真实点一次「安装并重启」= 杀进程 + 覆盖安装 + 还原数据 + 重启，
// 每跑一次都要拿正在用的机器人当赌注。所以把链路拆成可离线验证的三段：
//   1) findRunnableExe    —— 安装目录里到底哪个 exe 能启动（不能硬编码 "QQ Agent.exe"）
//   2) buildInstallScript —— 生成的 PowerShell 里：按真实 exe 名杀进程、/D 就地安装、
//                            data/ 还原、装完重启、失败也要把旧版拉起来
//   3) 端到端编排         —— 用 .cmd 假安装器代替 NSIS（会像旧卸载器那样"删掉整个安装目录"），
//                            真的把脚本跑一遍，验证备份/还原/启动三步都落地
//
// 运行：node test/update-install-plan.mjs
// 断言口径是"行为"，不是"字符串长啥样"，改文案不会误报。
process.env.QQ_AGENT_NO_AUTOCHECK = '1';   // updater.js 被 import 时会排一次自动检查，测试里要关掉
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-test-'));
process.env.QQ_AGENT_DATA_DIR = path.join(TMP, 'data');   // 必须是 import updater 之前
const {
  findRunnableExe, buildInstallScript, copyTree, writeInstallScript,
  buildLauncherFiles, DATA_SKIP
} = await import('../src/updater.js');
const ROOT_SRC = path.resolve(import.meta.dirname, '..', 'src');

const pass = [];
const fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  OK   ${name}`); }
  catch (e) { fail.push(name); console.error(`  FAIL ${name}\n       ${e.message}`); }
}
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

// ── 1) 真实 exe 名解析 ────────────────────────────────────────────
await check('findRunnableExe：DSH 版只认 QQ Agent DSH.exe（不碰卸载器）', () => {
  const dir = path.join(TMP, 'inst-a');
  write(path.join(dir, 'QQ Agent DSH.exe'), 'x');
  write(path.join(dir, 'Uninstall QQ Agent DSH.exe'), 'x');
  const found = findRunnableExe(dir);
  assert.equal(path.basename(found), 'QQ Agent DSH.exe');
});

await check('findRunnableExe：正式版名 QQ Agent.exe 也能找到', () => {
  const dir = path.join(TMP, 'inst-b');
  write(path.join(dir, 'QQ Agent.exe'), 'x');
  assert.equal(path.basename(findRunnableExe(dir)), 'QQ Agent.exe');
});

await check('findRunnableExe：目录里没有 exe 时返回空串（交给安装后重新扫描）', () => {
  const dir = path.join(TMP, 'inst-c');
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'resources/app/package.json'), '{}');
  assert.equal(findRunnableExe(dir), '');
});

await check('findRunnableExe：名字带别的 exe（snowluma 那种）不误选', () => {
  const dir = path.join(TMP, 'inst-d');
  write(path.join(dir, 'QQ Agent DSH.exe'), 'x');
  write(path.join(dir, 'snowluma-launcher.exe'), 'x');
  assert.equal(path.basename(findRunnableExe(dir)), 'QQ Agent DSH.exe');
});

// ── 2) 生成的脚本：关键行为都在 ───────────────────────────────────
const INST = path.join(TMP, 'inst e2e');   // 故意带空格：验证 /D 的路径不会被多加引号
const APP = path.join(INST, 'resources', 'app');
const DATA = path.join(TMP, 'data-e2e');
const BACKUP = path.join(TMP, 'backup-e2e');
const RUN_EXE = path.join(INST, 'QQ Agent DSH.exe');
const plan = buildInstallScript({
  installerPath: path.join(BACKUP, 'setup.exe'),
  version: '9.9.9',
  installDir: INST,
  appDir: APP,
  dataDir: DATA,
  runExe: RUN_EXE,
  backupDir: BACKUP
});

await check('生成的脚本：按真实 exe 名杀进程，而不是硬编码 QQ Agent.exe', () => {
  assert.match(plan.script, /taskkill\.exe \/IM \$exeName/);
  assert.ok(plan.script.includes(`$exeName = 'QQ Agent DSH.exe'`), '应使用传入的真实 exe 名');
  assert.ok(!/taskkill[^\n]*"QQ Agent\.exe"/.test(plan.script), '不该再出现硬编码 QQ Agent.exe');
});

await check('生成的脚本：静默安装带 /D 指向原安装目录（否则会装到默认目录）', () => {
  assert.ok(plan.script.includes(`$argStr = "/S /D=" + '${INST}'`), '缺少 /D 就地安装参数');
  assert.ok(/Start-Process[^\n]*-ArgumentList \$argStr -Wait/.test(plan.script), '必须等安装器跑完');
});

await check('生成的脚本：还原 plugins / skills / snowluma 与安装根目录 data', () => {
  assert.match(plan.script, /@\("plugins","skills","snowluma"\)/, '还原清单缺项');
  assert.ok(plan.script.includes('(Join-Path $backup $d)'), '没按清单逐个还原');
  assert.ok(plan.script.includes('(Join-Path $backup "data")'), '漏了 data/');
});

await check('生成的脚本：还原安装根目录的 tools（用户放的工具，如记忆解释器）', () => {
  assert.match(plan.script, /@\("tools"\)/, '还原清单里没有 tools');
  assert.ok(plan.script.includes('(Join-Path $installDir $d)'), 'tools 没还原到安装根目录');
});

await check('生成的脚本：等新版本落位、装完启动、日志落在备份目录', () => {
  assert.ok(plan.script.includes(`$want = '9.9.9'`), '没有校验目标版本');
  assert.ok(plan.script.includes('Start-Process -FilePath $run'), '装完没有启动应用');
  assert.ok(plan.script.includes('install.log'), '日志路径没写进脚本');
  assert.equal(path.basename(plan.logPath), 'install.log');
});

await check('psStr：路径里的单引号被正确转义（不会炸脚本）', () => {
  const p2 = buildInstallScript({
    installerPath: 'C:\\a\\b.exe', version: '1', installDir: "C:\\it's here",
    appDir: APP, dataDir: DATA, runExe: RUN_EXE, backupDir: BACKUP
  });
  assert.ok(p2.script.includes(`'C:\\it''s here'`), '单引号应转成两个');
});

// ── 3) data 备份口径：跳过 updates / electron-user-data ────────────
await check('copyTree：备份 data 时跳过 updates 与 electron-user-data', () => {
  const src = path.join(TMP, 'data-src');
  write(path.join(src, 'sessions', 'a.json'), '{"a":1}');
  write(path.join(src, 'updates', '0.5.2', 'setup.exe'), 'BIG');
  write(path.join(src, 'electron-user-data', 'Cache', 'x.bin'), 'CACHE');
  const dst = path.join(TMP, 'data-dst');
  copyTree(src, dst);
  assert.ok(exists(path.join(dst, 'sessions', 'a.json')), 'sessions 必须备份');
  assert.ok(!exists(path.join(dst, 'updates')), 'updates 不该备份（几十 MB×N 个版本）');
  assert.ok(!exists(path.join(dst, 'electron-user-data')), 'Chromium 缓存不该备份');
});

// copyTree 自己实现递归：fs.cp 的 filter 在 Node 20（Electron 33）与 Node 24 上行为不一致，
// 实测备份因此把 updates/ 与 electron-user-data/ 全拷了。这里断言"只跳过顶层、深层同名不误伤"。
await check('copyTree：只跳顶层 updates/electron-user-data，深层同名目录不误伤', () => {
  const src = path.join(TMP, 'order-src');
  write(path.join(src, 'updates', 'a.txt'), 'x');
  write(path.join(src, 'electron-user-data', 'b.txt'), 'x');
  write(path.join(src, 'sessions', 'updates', 'c.txt'), 'deep');   // 深层同名，必须保留
  write(path.join(src, 'sessions', 'd.json'), 'x');
  const dst = path.join(TMP, 'order-dst');
  copyTree(src, dst);
  assert.equal(exists(path.join(dst, 'updates')), false, '顶层 updates 应跳过');
  assert.equal(exists(path.join(dst, 'electron-user-data')), false, '顶层 electron-user-data 应跳过');
  assert.ok(exists(path.join(dst, 'sessions', 'updates', 'c.txt')), '深层 sessions/updates 不该被误伤');
  assert.ok(exists(path.join(dst, 'sessions', 'd.json')), '普通文件必须复制');
});

// ── 3.5) 启动器：隐藏 VBS + WMI 拉起（spawn 在本机什么都不执行，已实测）──
await check('buildLauncherFiles：生成隐藏 VBS 与 WMI 启动器（带 BOM）', () => {
  const dir = path.join(TMP, 'launch-files');
  const restore = path.join(dir, 'restore.ps1');
  write(restore, '# fake');
  const { vbs, launchPs } = buildLauncherFiles({ restoreScript: restore, backupDir: dir });
  const vbsText = read(vbs);
  assert.match(vbsText, /WScript\.Shell/, 'VBS 应使用 WScript.Shell');
  assert.match(vbsText, /, 0, False/, 'VBS 应隐藏窗口且不等待');
  const psText = read(launchPs);
  assert.match(psText, /Invoke-CimMethod/, '必须用 WMI 创建（父进程变 WmiPrvSE，躲开 taskkill /T）');
  assert.match(psText, /Win32_Process/, '必须走 Win32_Process.Create');
  assert.ok(read(path.join(dir, 'restore.vbs')).includes(restore), 'VBS 里要带还原脚本的绝对路径');
  const head = fs.readFileSync(launchPs);
  assert.equal(head[0], 0xEF, 'launch.ps1 需要 UTF-8 BOM（PS 5.1 否则按 ANSI 解乱）');
});

await check('installUpdate 源码：启动助手后必须确认 install.log 出现，起不来就不装', () => {
  const code = read(path.join(ROOT_SRC, 'updater.js'));
  assert.match(code, /install\.log 未生成/, '缺少"助手没启动"的失败分支');
  assert.match(code, /fs\.rmSync\(logPath/, '启动前要清掉旧日志，否则会误判');
  assert.match(code, /buildLauncherFiles\(/, '必须用可验证的启动器');
});

// ── 4) 端到端编排：假安装器 + 真跑 PowerShell ──────────────────────
// 假安装器模拟"旧卸载器先把 $INSTDIR 整个删掉，再铺新文件"的最坏情况。
await check('端到端：备份 → 杀进程 → 静默安装 → 还原数据 → 重启（假安装器）', async () => {
  // 现场：旧版程序 + snowluma 登录态 + data 会话
  write(path.join(APP, 'package.json'), JSON.stringify({ version: '0.5.4' }));
  write(path.join(APP, 'snowluma', 'config', 'login.json'), '{"uin":123}');
  write(path.join(APP, 'plugins', 'p1.js'), '// plugin');
  write(path.join(DATA, 'config.json'), '{"k":1}');
  write(path.join(DATA, 'sessions', 'chat.json'), '{"m":1}');
  write(path.join(DATA, 'updates', '0.5.2', 'setup.exe'), 'BIG');
  // 用户自己装在安装根目录的工具（这里模拟记忆解释器 + 它自己的配置）
  const TOOLS = path.join(INST, 'tools');
  write(path.join(TOOLS, 'memory-studio', 'server.mjs'), '// interpreter');
  write(path.join(TOOLS, 'memory-studio', 'data', 'config.json'), '{"apiKey":"k"}');
  write(RUN_EXE, 'stub');
  fileExecutable(RUN_EXE);

  // 备份（与 installUpdate 同口径）
  fs.mkdirSync(BACKUP, { recursive: true });
  copyTree(path.join(APP, 'plugins'), path.join(BACKUP, 'plugins'));
  copyTree(path.join(APP, 'snowluma'), path.join(BACKUP, 'snowluma'));
  copyTree(DATA, path.join(BACKUP, 'data'));
  copyTree(TOOLS, path.join(BACKUP, 'tools'));
  assert.ok(exists(path.join(BACKUP, 'data', 'sessions', 'chat.json')), '前置：data 备份应存在');
  assert.ok(exists(path.join(BACKUP, 'tools', 'memory-studio', 'server.mjs')), '前置：tools 备份应存在');

  // 假安装器：记录收到的参数 → 模拟旧卸载器删目录 → 铺入 9.9.9
  const argsFile = path.join(TMP, 'installer-args.txt');
  const newPkg = path.join(TMP, 'new-package.json');
  write(newPkg, JSON.stringify({ version: '9.9.9' }));
  const stub = path.join(BACKUP, 'fake-installer.cmd');
  write(stub, [
    '@echo off',
    `echo %* > "${argsFile}"`,
    `rmdir /s /q "${APP}" 2>nul`,
    `rmdir /s /q "${DATA}" 2>nul`,
    `rmdir /s /q "${INST}\\tools" 2>nul`,
    `mkdir "${APP}" 2>nul`,
    `copy /y "${newPkg}" "${APP}\\package.json" >nul`,
    'exit /b 0',
    ''
  ].join('\r\n'));

  // 假启动器：只留一个"起来了"的痕迹（真应用被我们手动换成 .cmd）
  const launched = path.join(TMP, 'launched.txt');
  const launcher = path.join(INST, 'launch-stub.cmd');
  write(launcher, ['@echo off', `echo launched > "${launched}"`, 'exit /b 0', ''].join('\r\n'));

  const { script, logPath } = buildInstallScript({
    installerPath: stub, version: '9.9.9', installDir: INST,
    appDir: APP, dataDir: DATA, runExe: launcher, backupDir: BACKUP
  });
  const ps1 = path.join(BACKUP, 'restore.ps1');
  writeInstallScript(ps1, script);   // 与生产同一条写盘路径（含 UTF-8 BOM）
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    stdio: 'pipe', timeout: 180000
  });

  // 断言
  assert.ok(exists(argsFile), '安装器没被拉起');
  const gotArgs = read(argsFile).trim();
  assert.ok(gotArgs.includes('/S'), `安装器没收到 /S：${gotArgs}`);
  assert.ok(gotArgs.includes(`/D=${INST}`), `/D 没正确传到安装器（含空格的路径要原样）：${gotArgs}`);
  assert.equal(JSON.parse(read(path.join(APP, 'package.json'))).version, '9.9.9', '新版本没落位');
  assert.ok(exists(path.join(APP, 'snowluma', 'config', 'login.json')), 'snowluma 登录态没还原（QQ 要重登）');
  assert.ok(exists(path.join(APP, 'plugins', 'p1.js')), 'plugins 没还原');
  assert.ok(exists(path.join(DATA, 'sessions', 'chat.json')), 'data 会话没还原（聊天记录/记忆）');
  assert.ok(!exists(path.join(DATA, 'updates')), 'updates 不在备份口径里，不该被还原');
  assert.ok(exists(path.join(TOOLS, 'memory-studio', 'server.mjs')), 'tools/ 里的工具没还原（记忆解释器会被升级删掉）');
  assert.ok(exists(path.join(TOOLS, 'memory-studio', 'data', 'config.json')), 'tools/ 里的配置没还原（解释器的 LLM key 会丢）');
  // 启动是异步的（脚本 Start-Process 后立刻退出），给它最多 10 秒落地
  const deadline = Date.now() + 10000;
  while (!exists(launched) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(exists(launched), '装完没有重新启动应用');
  assert.ok(exists(logPath), '没写安装日志，出问题没法排查');
  assert.match(read(logPath), /结束/);
});

function fileExecutable() { /* Windows 不需要 chmod，占位让断言更清楚 */ }

// ── 汇总 ──────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log('');
console.log(`PASS ${pass.length} / ${pass.length + fail.length}`);
if (fail.length) {
  console.error('FAILED:');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL PASSED');
