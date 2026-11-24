// 过时记忆引导文案迁移：只替换固定旧句子，不动用户自己写的内容。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-memguide-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const cfgMod = await import('../src/config.js');
const OLD_A = '- 用 memory_append 记住值得长期保留的人和事：进行中的话题、想说还没说的话、对某位群友的印象。';
const OLD_A2 = '- 用 memory_append 记住值得长期保留的人和事：进行中的话题、想说还没说的话、对对方的印象。';
const OLD_B = '- memory_append 只记真的用得上的：谁话说一半消失、谁答应的事、谁的喜好、你自己想说还没说的话；过时就删。';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  OK  ', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const cfg = {
  persona: { roleText: `开头\n${OLD_A}\n结尾`, customRules: '不要复述私聊' },
  personas: [{ id: 'x', variant: `卡正文\n${OLD_B}\n卡结尾` }],
  personaShared: { core: '', voice: `铁律\n${OLD_A}\n声音` },
  customPersonas: [{ name: '导入模板', text: `模板\n${OLD_A2}\n模板尾` }]
};
const changed = cfgMod.migrateMemoryGuidance(cfg);
check('检测到旧文案并迁移', changed === true);
check('人格 roleText 已替换', !cfg.persona.roleText.includes(OLD_A) && cfg.persona.roleText.includes('只记对群友的长期印象'));
check('卡片 variant 已替换', !cfg.personas[0].variant.includes(OLD_B) && cfg.personas[0].variant.includes('memory_remove'));
check('共用 voice 已替换', !cfg.personaShared.voice.includes(OLD_A) && cfg.personaShared.voice.includes('后台整理会自动生成话题卡'));
check('导入模板（对对方的印象）已替换', !cfg.customPersonas[0].text.includes(OLD_A2) && cfg.customPersonas[0].text.includes('只记对群友的长期印象'));
check('用户自定义内容不动', cfg.persona.customRules === '不要复述私聊' && cfg.persona.roleText.startsWith('开头') && cfg.persona.roleText.endsWith('结尾'));
check('幂等：第二次不再改动', cfgMod.migrateMemoryGuidance(cfg) === false);

const personasSrc = fs.readFileSync(path.join(ROOT, 'src', 'personas.js'), 'utf8');
check('内置模板不再含旧句 A', !personasSrc.includes(OLD_A));
check('内置模板不再含旧句 B', !personasSrc.includes(OLD_B));

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
