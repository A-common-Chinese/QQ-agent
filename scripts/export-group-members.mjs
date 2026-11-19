#!/usr/bin/env node
// 导出群成员名单（人工逐个私聊用）：合并「群目录里有内容的卡」+「persons 里的空卡」
import fs from 'node:fs';
import path from 'node:path';

const DATA = 'C:/Users/noapi/AppData/Local/Programs/QQ Agent DSH/data';
const GID = '324518538';
const CHAT_KEY = `group:${GID}`;
const SRC_GROUP = path.join(DATA, 'memory-cards', `group_${GID}`);
const SRC_PERSONS = path.join(DATA, 'memory-cards', 'persons');
const OUT = `C:/Users/noapi/Desktop/${GID}-成员名单`;
fs.mkdirSync(OUT, { recursive: true });

const fmtDate = (s) => {
  const d = s ? new Date(s) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const map = new Map(); // qq -> row

// A. 群目录：有印象/事实的卡（信息最全）
for (const f of fs.readdirSync(SRC_GROUP).filter((x) => x.startsWith('person_') && x.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(SRC_GROUP, f), 'utf8'));
  const qq = String(j.id || j.qq || f.replace(/^person_|\.json$/g, '')).replace('person:', '');
  if (!qq) continue;
  map.set(qq, {
    qq,
    name: String(j.name || '').trim() || '(无昵称)',
    msgs: Number(j.stats?.msgs) || 0,
    last: fmtDate(j.stats?.lastSeen),
    summary: String(j.summary || '').trim(),
    topics: (j.facts || []).slice(0, 2).map((x) => String(x).replace(/\s+/g, ' ').trim()).join('；'),
    empty: false
  });
}

// B. persons 全库：补上"空卡"（只出现过、没整理过内容）
for (const f of fs.readdirSync(SRC_PERSONS).filter((x) => x.endsWith('.json'))) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(SRC_PERSONS, f), 'utf8')); } catch { continue; }
  const g = (j.groups || []).find((x) => (x.chatKey || x) === CHAT_KEY);
  if (!g) continue;
  const qq = String(j.qq || j.id || f.replace(/\.json$/, '')).replace('person:', '');
  if (!qq || map.has(qq)) continue;
  const empty = !String(j.summary || '').trim() || String(j.summary).trim() === '（暂无印象）';
  map.set(qq, {
    qq,
    name: String(j.name || '').trim() || '(无昵称)',
    msgs: Number(g.msgs) || 0,
    last: fmtDate(g.lastSeen || j.meta?.lastSeen),
    summary: empty ? '' : String(j.summary).trim(),
    topics: (j.facts || []).slice(0, 2).map((x) => String(x).replace(/\s+/g, ' ').trim()).join('；'),
    empty
  });
}

const rows = [...map.values()].sort((a, b) => b.msgs - a.msgs || a.name.localeCompare(b.name, 'zh'));
const kind = (r) => (r.empty && r.msgs <= 1 ? '空卡' : r.msgs >= 20 ? '活跃' : r.msgs >= 5 ? '偶尔' : '冒泡');

// ── CSV ──
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = ['序号,QQ号,昵称,类型,发言条数,最后发言,印象摘要,常聊话题']
  .concat(rows.map((r, i) => [i + 1, r.qq, r.name, kind(r), r.msgs, r.last, r.summary, r.topics].map(esc).join(',')))
  .join('\r\n');
fs.writeFileSync(path.join(OUT, '成员名单.csv'), '\uFEFF' + csv, 'utf8');

// ── Markdown ──
const md = [];
md.push(`# 群 ${GID} 成员名单（共 ${rows.length} 人）`);
md.push('');
md.push('> 按发言条数排序。**空卡**=只在群里出现过一次、还没有印象记录的人，可按 QQ 直接搜。');
md.push('');
for (const t of ['活跃', '偶尔', '冒泡', '空卡']) {
  const list = rows.filter((r) => kind(r) === t);
  if (!list.length) continue;
  md.push(`## ${t}（${list.length} 人）`);
  md.push('');
  md.push('| # | QQ | 昵称 | 发言 | 最后发言 | 印象 / 话题 |');
  md.push('|---|---|---|---|---|---|');
  list.forEach((r) => {
    const note = [r.summary, r.topics].filter(Boolean).join('；').replace(/\|/g, '/') || '—';
    md.push(`| ${rows.indexOf(r) + 1} | ${r.qq} | ${r.name.replace(/\|/g, '/')} | ${r.msgs} | ${r.last} | ${note} |`);
  });
  md.push('');
}
fs.writeFileSync(path.join(OUT, '成员名单.md'), md.join('\n'), 'utf8');

const by = (t) => rows.filter((r) => kind(r) === t).length;
console.log('导出完成：', OUT);
console.log(`合计 ${rows.length} 人 | 活跃 ${by('活跃')} / 偶尔 ${by('偶尔')} / 冒泡 ${by('冒泡')} / 空卡 ${by('空卡')}`);
