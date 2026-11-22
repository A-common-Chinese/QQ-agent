// 指令禁言的管理员判定：adminQQ 为空时要回退 allow.private[0]（部署者）。
// 背景：app.js 以前直接读 forwardRules.adminQQ，空字符串导致 adminOnly 口令
// （/睡觉 等）永远被忽略 —— 用户 @机器人 发 /睡觉 看起来"没生效"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-cmdmute-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const future = Date.now() + 3600_000;
const past = Date.now() - 1000;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  commandMute: { enabled: true, active: { 111: future, 222: past, 333: 0 } }
}), 'utf8');

const cfg = await import('../src/config.js');

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  OK  ', name); } else { fail++; console.log('  FAIL', name); }
};

check('显式 adminQQ 优先生效', cfg.effectiveAdminQQ({ forwardRules: { adminQQ: '10001' }, allow: { private: ['10002'] } }) === '10001');
check('adminQQ 为空 → 回退 allow.private[0]', cfg.effectiveAdminQQ({ forwardRules: { adminQQ: '' }, allow: { private: ['10002', '10003'] } }) === '10002');
check('adminQQ 非法 → 回退 allow.private[0]', cfg.effectiveAdminQQ({ forwardRules: { adminQQ: 'abc' }, allow: { private: ['10002'] } }) === '10002');
check('都没配置 → 空字符串', cfg.effectiveAdminQQ({ forwardRules: {}, allow: { private: [] } }) === '');
check('isMuteAdmin：回退后的管理员能通过', cfg.isMuteAdmin('10002', { forwardRules: { adminQQ: '' }, allow: { private: ['10002'] } }) === true);
check('isMuteAdmin：非管理员被拒', cfg.isMuteAdmin('99999', { forwardRules: { adminQQ: '' }, allow: { private: ['10002'] } }) === false);
check('isMuteAdmin：无管理员配置时一律拒绝', cfg.isMuteAdmin('10002', { forwardRules: {}, allow: { private: [] } }) === false);

check('commandMuteTier：未到期群 → 1 档', cfg.commandMuteTier('group:111') === 1);
check('commandMuteTier：已到期群 → null', cfg.commandMuteTier('group:222') === null);
check('commandMuteTier：永久禁言（0）→ 1 档', cfg.commandMuteTier('group:333') === 1);
check('commandMuteTier：私聊不受影响', cfg.commandMuteTier('private:111') === null);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
