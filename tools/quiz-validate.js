// 题库校验器：结构完整性 / 答案越界 / 题干查重 / 难度分布 / 英语阅读组完整性 + 计数报表
// 用法：node tools/quiz-validate.js   （夜间扩建批次入库后必跑）
const HIST = require('../resources/quiz/hist.js');
const POL = require('../resources/quiz/pol.js');
const EN = require('../resources/quiz/en.js');

let fail = 0;
function check(name, items, { allowMulti = false } = {}) {
  const ids = new Set();
  const stems = new Map();
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let multiCount = 0;
  for (const it of items) {
    const tag = `${name}#${it.id}`;
    if (!Number.isInteger(it.id) || it.id <= 0) { console.log(`FAIL ${tag} id 非法`); fail++; }
    if (ids.has(it.id)) { console.log(`FAIL ${tag} id 重复`); fail++; }
    ids.add(it.id);
    if (!Array.isArray(it.opts) || it.opts.length !== 4) { console.log(`FAIL ${tag} 选项数≠4`); fail++; }
    else if (new Set(it.opts).size !== 4) { console.log(`WARN ${tag} 选项内容重复`); }
    if (allowMulti && it.multi) {
      multiCount++;
      if (!Array.isArray(it.ans) || it.ans.length < 2 || it.ans.length > 4 ||
          it.ans.some((a) => !Number.isInteger(a) || a < 0 || a > 3)) { console.log(`FAIL ${tag} 多选 ans 非法`); fail++; }
    } else if (!Number.isInteger(it.ans) || it.ans < 0 || it.ans > 3) { console.log(`FAIL ${tag} ans 越界`); fail++; }
    if (!it.q || typeof it.q !== 'string') { console.log(`FAIL ${tag} 题干为空`); fail++; }
    if (!it.ex || typeof it.ex !== 'string' || it.ex.length < 6) { console.log(`FAIL ${tag} 解析缺失或过短`); fail++; }
    if (!it.src) { console.log(`FAIL ${tag} 来源缺失`); fail++; }
    if (!Number.isInteger(it.d) || it.d < 1 || it.d > 5) { console.log(`FAIL ${tag} 难度非法`); fail++; }
    else dist[it.d]++;
    const key = (it.q || '').replace(/\s+/g, '').slice(0, 40);
    if (stems.has(key)) { console.log(`FAIL ${tag} 题干前40字与 #${stems.get(key)} 重复`); fail++; }
    else stems.set(key, it.id);
  }
  console.log(`${name}: ${items.length} 题 | 多选 ${multiCount} | 难度 d1-5 = ${dist[1]}/${dist[2]}/${dist[3]}/${dist[4]}/${dist[5]}`);
  return items;
}

const hist = check('history ', HIST.items);
const pol = check('politics', POL.items, { allowMulti: true });
const en = check('english ', EN.items);

// 英语阅读组完整性：pid 引用的篇目必须存在，且每篇正好 5 题
const byPid = {};
for (const it of en) {
  if (it.pid != null) (byPid[it.pid] = byPid[it.pid] || []).push(it);
}
for (const [pid, arr] of Object.entries(byPid)) {
  if (arr.length !== 5) { console.log(`FAIL english passage#${pid} 题数=${arr.length}（应为 5）`); fail++; }
  if (!EN.passages.some((p) => p.id === Number(pid))) { console.log(`FAIL english passage#${pid} 无对应正文`); fail++; }
}
for (const p of EN.passages) {
  if (!p.text || !p.src) { console.log(`FAIL english passage#${p.id} 正文/src 为空`); fail++; }
}
console.log(`english passages: ${EN.passages.length} 篇`);

const total = hist.length + pol.length + en.length;
console.log(`──────────\n合计 ${total} 题（历史 ${hist.length} / 政治 ${pol.length} / 英语 ${en.length}）`);
console.log(fail ? `✗ ${fail} 处问题` : '✓ 全部通过');
process.exit(fail ? 1 : 0);
