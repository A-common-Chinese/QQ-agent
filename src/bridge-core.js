// 两座桥（/dsh 与通用 Agent 桥）共用的底座。
//
// 抽取原则：只搬**逻辑完全一致**、且不涉及各自协议细节的部分。
// 不碰的部分：命令解析（前缀/别名各不相同）、runOnce（一个走 asar+ELECTRON_RUN_AS_NODE，
// 一个走通用 CLI 参数模板）、答案提取（--json 事件名不同）。
//
// 抽这三样是因为它们此前在两处逐字重复，改一处忘另一处就会行为分叉：
//   1. 会话状态落盘（原子写）
//   2. @ 前缀剥离
//   3. 会话键（per-chat / global / none）
// 外加 killTree（Windows 上 child.kill() 杀不掉进程树）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';

/**
 * 会话状态存储：一个 basename 一个文件，读坏/读不到都当空对象。
 * 写用「tmp → rename」原子替换：崩在写 tmp 中途时旧文件仍完整。
 *
 * @param {{ basename: string, tag?: string }} opts tag 用于失败日志前缀（如 '[dsh]'）
 */
export function createStateStore({ basename, tag = '[bridge]' }) {
  const file = () => path.join(DATA_DIR, String(basename));

  function load() {
    try {
      const raw = fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function save(state) {
    const target = file();
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, target);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉就算了 */ }
      // 存不下会话 id 只影响"下次能不能续跑"，不影响本轮
      console.warn(`${tag} 会话记录写入失败:`, error?.message ?? error);
    }
  }

  return { file, load, save };
}

/**
 * 剥掉消息开头的 @ 段（最多两层）。
 * 群里下命令通常是「@机器人 /dsh 跑测试」，segmentsToText 会把 @ 渲染成文本，
 * 前缀匹配前必须剥掉，否则 /dsh 永远不命中。
 */
export function stripLeadingAt(text) {
  let out = String(text ?? '').trim();
  for (let i = 0; i < 2; i += 1) {
    const next = out.replace(/^(?:\[@[^\]\n]{0,64}\]|@[^\s]{1,64})\s*/u, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 会话键：none 不记、global 全局一条、per-chat 按会话 */
export function sessionKeyFor(mode, chatKey) {
  const m = String(mode || 'per-chat');
  if (m === 'none') return null;
  return m === 'global' ? '__global__' : chatKey;
}

/**
 * 杀掉整个进程树。
 * Windows 上 child.kill() 只杀父进程，任务超时后残留子进程会继续占端口/文件。
 */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      killer.unref?.();
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* 退化成只杀父进程也比重试好 */
  }
}
