// src/privacy.js（fork 侧）的单元测试：node test/privacy.test.mjs
// 不依赖任何测试框架，断言失败即非零退出。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivacyFilter, normalizeChatKey } from '../src/privacy.js';

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
  } else {
    failures.push(`${name}\n      实际: ${a}\n      期望: ${e}`);
  }
}

const ALLOWED = 'private:85946573';
const OTHER = 'private:103751885';
const GROUP = 'group:759694210';

const filter = createPrivacyFilter({ allowedChats: ['85946573'], mode: 'redact' });

// ── chatKey 归一化 ────────────────────────────────────────────────────────
check('裸 QQ 号 → private:', normalizeChatKey('85946573'), 'private:85946573');
check('已带前缀保持不变', normalizeChatKey('group:123'), 'group:123');

// ── 白名单：一个字都不许动 ────────────────────────────────────────────────
const secret = 'token: abcdef123456 邮箱 a@b.com 手机 13800138000';
check('白名单私聊放行且原样', filter.filterText(ALLOWED, secret), {
  bypass: true, ok: true, text: secret, hits: [], blockedBy: null
});
check('白名单判定', filter.isAllowedChat('85946573'), true);

// ── 非白名单：block 级 ────────────────────────────────────────────────────
for (const [name, text, rule] of [
  ['OpenAI 风格 key', '我的 key 是 sk-abcdefghijklmnopqrstuvwx 请收好', 'openai-key'],
  ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'],
  ['赋值式口令', 'password: hunter2xyz', 'secret-assignment'],
  ['中文赋值式', '密码：abc12345', 'secret-assignment'],
  ['连接串', 'mongodb://user:pw@10.0.0.5:27017/db', 'conn-string'],
  ['私钥块', '-----BEGIN RSA PRIVATE KEY-----', 'private-key']
]) {
  const r = filter.filterText(OTHER, text);
  check(`block: ${name}`, [r.ok, r.bypass, r.blockedBy], [false, false, rule]);
}

// ── 非白名单：redact 级（打码后照发）──────────────────────────────────────
const rEmail = filter.filterText(OTHER, '联系人 zhang.san@example.com 谢谢');
check('redact: 邮箱', [rEmail.ok, rEmail.text], [true, '联系人 [已隐去:邮箱] 谢谢']);

const rMobile = filter.filterText(GROUP, '电话 13800138000 打给我');
check('redact: 手机（群里同样过滤）', [rMobile.ok, rMobile.text], [true, '电话 [已隐去:手机号] 打给我']);

const rPath = filter.filterText(OTHER, '文件在 C:\\Users\\noapi\\dsh-workspace\\note.txt');
check('redact: 用户目录路径', [rPath.ok, rPath.text], [true, '文件在 C:\\Users\\***\\dsh-workspace\\note.txt']);

const home = process.env.USERPROFILE || '';
const user = (process.env.USERNAME || '').toLowerCase();
const rIdent = filter.filterText(OTHER, `用户名 ${process.env.USERNAME} 和主机 ${process.env.COMPUTERNAME}`);
check('redact: 本机用户名/主机名', [rIdent.ok, rIdent.text.includes(process.env.USERNAME), rIdent.text.includes(process.env.COMPUTERNAME)], [true, false, false]);

const rId = filter.filterText(OTHER, '身份证 110101199003071234');
check('redact: 身份证', [rId.ok, rId.text], [true, '身份证 [已隐去:证件号]']);

const rIp = filter.filterText(OTHER, '内网 192.168.1.23 上');
check('redact: IP', [rIp.ok, rIp.text], [true, '内网 [已隐去:IP] 上']);

const rClean = filter.filterText(OTHER, '今天天气不错，代码跑完了');
check('干净文本原样通过', [rClean.ok, rClean.text, rClean.hits.length], [true, '今天天气不错，代码跑完了', 0]);

// 打码后为空 → 拒发
const rOnly = filter.filterText(OTHER, 'zhang.san@example.com');
check('只剩隐私内容 → 拒发', [rOnly.ok, rOnly.blockedBy], [false, 'empty-after-redact']);

// ── mode=block：任何命中都拒发 ────────────────────────────────────────────
const strict = createPrivacyFilter({ allowedChats: [ALLOWED], mode: 'block' });
check('mode=block 邮箱也拒发', strict.filterText(OTHER, 'a@b.com').ok, false);
check('mode=block 白名单仍放行', strict.filterText(ALLOWED, 'a@b.com').ok, true);

// ── blockOnSecrets=false：密钥类降级为打码（不是死开关）────────────────────
const soft = createPrivacyFilter({ allowedChats: [ALLOWED], mode: 'redact', blockOnSecrets: false });
const softResult = soft.filterText(OTHER, 'key 是 sk-abcdefghijklmnopqrstuvwx 请收好');
check('blockOnSecrets=false → 密钥打码而非拒发',
  [softResult.ok, softResult.text.includes('sk-abcdefghijklmnopqrstuvwx'), softResult.blockedBy],
  [true, false, null]);
check('blockOnSecrets=false 时 mode=block 仍拒发',
  createPrivacyFilter({ allowedChats: [ALLOWED], mode: 'block', blockOnSecrets: false })
    .filterText(OTHER, 'sk-abcdefghijklmnopqrstuvwx').ok,
  false);

// ── 额外规则 ──────────────────────────────────────────────────────────────
const custom = createPrivacyFilter({
  allowedChats: [ALLOWED],
  extraPatterns: [{ id: 'project-codename', regex: '夜莺计划', action: 'redact', replace: '[已隐去:代号]' }]
});
check('自定义规则打码', custom.filterText(OTHER, '关于夜莺计划的进展').text, '关于[已隐去:代号]的进展');

// ── 文件检查 ──────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dshqq-privacy-'));
const okFile = join(dir, 'note.txt');
const badFile = join(dir, 'config.env');
writeFileSync(okFile, '这是一份正常笔记\n', 'utf8');
writeFileSync(badFile, 'API_KEY=sk-abcdefghijklmnopqrstuvwx\n', 'utf8');

check('文件：正常文本放行', filter.filterFile(OTHER, okFile).ok, true);
const badResult = filter.filterFile(OTHER, badFile);
check('文件：内容含密钥 → 拒发', [badResult.ok, String(badResult.blockedBy).startsWith('file-content:')], [false, true]);
check('文件：白名单不扫描', filter.filterFile(ALLOWED, badFile).bypass, true);
const weirdName = join(dir, 'noapi-report.txt');
check('文件：文件名里的用户名被打码', filter.filterFile(OTHER, weirdName).safeName.includes(process.env.USERNAME), false);

// ── 策略摘要里不能出现任何秘密 ────────────────────────────────────────────
const described = JSON.stringify(filter.describe());
check('describe() 不含密钥样式', /sk-[A-Za-z0-9]{16,}/.test(described), false);

console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✅');
