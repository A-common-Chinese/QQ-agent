// 本地 zip 导入：unzipToModuleDir 的 stripPrefix（skills/ 层）与目录名推导
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { zipDirectory } = await import(pathToFileURL(path.join(ROOT, 'src', 'zip-write.js')).href);
const { unzipToModuleDir } = await import(pathToFileURL(path.join(ROOT, 'src', 'zip-install.js')).href);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ', name); } else { fail += 1; console.log('  FAIL', name); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-local-'));
// 源目录：tmp/src/skills/demo/{skill.json,index.js}
const srcSkills = path.join(tmp, 'src', 'skills');
fs.mkdirSync(path.join(srcSkills, 'demo'), { recursive: true });
fs.writeFileSync(path.join(srcSkills, 'demo', 'skill.json'), JSON.stringify({ id: 'demo-skill', name: '演示' }));
fs.writeFileSync(path.join(srcSkills, 'demo', 'index.js'), 'export function setup() {}\n');
const buf = zipDirectory(srcSkills); // 条目前缀 skills/

// 1) 带 skills/ 层：stripPrefix 后落到 <root>/skills/demo
const rootA = path.join(tmp, 'appA');
fs.mkdirSync(rootA, { recursive: true });
const dirA = await unzipToModuleDir(buf, { root: rootA, type: 'skill', preferId: 'demo-skill', stripPrefix: 'skills/' });
check('stripPrefix 后目录名是 demo', dirA === 'demo');
check('skill.json 落到 skills/demo/skill.json', fs.existsSync(path.join(rootA, 'skills', 'demo', 'skill.json')));
check('index.js 落到 skills/demo/index.js', fs.existsSync(path.join(rootA, 'skills', 'demo', 'index.js')));

// 2) 不带 stripPrefix（<id>/ 布局）：zipDirectory 的默认前缀就是 demo 这种目录名
const rootB = path.join(tmp, 'appB');
fs.mkdirSync(rootB, { recursive: true });
const demoDir = path.join(tmp, 'src2', 'demo2');
fs.mkdirSync(demoDir, { recursive: true });
fs.writeFileSync(path.join(demoDir, 'skill.json'), JSON.stringify({ id: 'demo2' }));
const buf2 = zipDirectory(demoDir); // 前缀 demo2/
const dirB = await unzipToModuleDir(buf2, { root: rootB, type: 'skill' });
check('无前缀 zip 目录名取第一段', dirB === 'demo2');
check('文件落到 skills/demo2/skill.json', fs.existsSync(path.join(rootB, 'skills', 'demo2', 'skill.json')));

// 3) 缺前缀时明确报错（防止装错位置）
let threw = false;
try { await unzipToModuleDir(buf2, { root: tmp, type: 'skill', stripPrefix: 'skills/' }); } catch { threw = true; }
check('缺少 skills/ 前缀时报错', threw);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
