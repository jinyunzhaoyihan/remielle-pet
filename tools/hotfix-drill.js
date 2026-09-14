// 热更端到端演练（v2.5.0 Night 1 B5）：本地 http 服务模拟 raw.githubusercontent.com + 客户端四用例
// 用法（bash 平台编排，服务与客户端都必须是 bash 直接子进程——沙箱会掐孙进程的环回网络，勿改成脚本内 spawn）：
//   node tools/hotfix-drill.js scenario 1|2|4     写对应场景仓库到 .hotfix-drill/repo
//   node tools/hotfix-drill.js serve              起本地模拟服务（后台常驻）
//   npm start -- --test-instance --test-userdata=hotfix-drill --test-hotfix-base=http://127.0.0.1:17399 --no-proxy-server --test-quit-after=9000 > .hotfix-drill/outN.txt 2>&1
//   node tools/hotfix-drill.js judge              评四个用例 + 落 docs/hotfix-drill.md
// 用例：①推 3 题新题生效 ②sha256 错→拒绝+保留旧版 ③断网→静默降级 ④schema 不过→报错且不入池
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const REPO_DIR = path.join(ROOT, '.hotfix-drill', 'repo');   // 场景仓库（字面量）
const OUT_DIR = path.join(ROOT, '.hotfix-drill');            // 客户端 stdout 转存处
const USERDATA = path.join(os.tmpdir(), 'remielle-test-hotfix-drill'); // 客户端隔离档（字面量）
const PORT = 17399;

// 演练题目（真实稳定考点，长字段线格式）
const NEW_ITEMS = [
  { id: 9001, difficulty: 2, topic: '中国古代史', question: '西晋的建立者是______。', options: ['司马炎', '司马睿', '司马懿', '司马昭'], answer: 0, explanation: '266 年司马炎逼魏帝禅让建立西晋，定都洛阳；280 年灭吴统一。', source: '演练·仿真' },
  { id: 9002, difficulty: 1, topic: '中国近代史', question: '鸦片战争后清政府签订的第一个不平等条约是______。', options: ['《南京条约》', '《望厦条约》', '《北京条约》', '《辛丑条约》'], answer: 0, explanation: '1842 年《南京条约》是中国近代史上第一个不平等条约，割香港岛给英国。', source: '演练·仿真' },
  { id: 9003, difficulty: 3, topic: '中国近现代史', question: '遵义会议事实上确立了以______为核心的党中央的正确领导。', options: ['毛泽东', '博古', '周恩来', '王明'], answer: 0, explanation: '1935 年遵义会议开始确立以毛泽东为主要代表的马克思主义正确路线在党中央的领导地位。', source: '演练·仿真' },
];
const EXTRA_ITEM = { id: 9004, difficulty: 2, topic: '中国古代史', question: '唐朝的都城位于______。', options: ['长安', '洛阳', '开封', '金陵'], answer: 0, explanation: '唐朝定都长安（今西安），洛阳为东都。', source: '演练·仿真' };

function scenario(n) {
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO_DIR, 'data'), { recursive: true });
  const put = (rel, obj) => fs.writeFileSync(path.join(REPO_DIR, rel), Buffer.from(JSON.stringify(obj)));
  const shaOf = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_DIR, rel))).digest('hex');
  const files = {};
  if (n === 1) {
    put('data/quiz-history.json', { items: NEW_ITEMS });
    files['quiz-history'] = { sha256: shaOf('data/quiz-history.json'), path: 'data/quiz-history.json' };
    put('manifest.json', { version: 1, updatedAt: new Date().toISOString(), files });
  } else if (n === 2) {
    put('data/quiz-history.json', { items: NEW_ITEMS.concat([EXTRA_ITEM]) });
    files['quiz-history'] = { sha256: '0'.repeat(64), path: 'data/quiz-history.json' }; // 故意错 sha
    put('manifest.json', { version: 2, updatedAt: new Date().toISOString(), files });
  } else if (n === 4) {
    const bad = JSON.parse(JSON.stringify(NEW_ITEMS));
    bad[0].explanation = '太短'; // 解析 <10 字 → ajv 拒
    put('data/quiz-history.json', { items: bad });
    files['quiz-history'] = { sha256: shaOf('data/quiz-history.json'), path: 'data/quiz-history.json' };
    put('manifest.json', { version: 2, updatedAt: new Date().toISOString(), files });
  }
  console.log('[scenario ' + n + '] repo 已写入 ' + REPO_DIR);
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = req.url.replace(/^\/+/, '').split('?')[0];
    if (!/^(manifest\.json|data\/[a-z0-9-]+\.json)$/.test(rel)) { res.writeHead(403); res.end('forbidden'); return; }
    const f = path.join(REPO_DIR, rel);
    if (!f.startsWith(REPO_DIR + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    try {
      const buf = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buf);
    } catch (_e) { res.writeHead(404); res.end('not found'); }
  });
  server.listen(PORT, '127.0.0.1', () => console.log('[serve] http://127.0.0.1:' + PORT + ' → ' + REPO_DIR));
}

function judge() {
  const out = (n) => { try { return fs.readFileSync(path.join(OUT_DIR, 'out' + n + '.txt'), 'utf8'); } catch (_e) { return ''; } };
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf8')); } catch (_e) { return {}; } })();
  const disk = (() => { try { return JSON.parse(fs.readFileSync(path.join(USERDATA, 'hotfix', 'quiz-history.json'), 'utf8')); } catch (_e) { return null; } })();
  const o1 = out(1), o2 = out(2), o3 = out(3), o4 = out(4);
  const results = [];
  results.push({ id: 1, pass: o1.includes('[hotfix] applied v1') && o1.includes('history+3/skip0') && cfg.hotfixVersion === 1 && !!disk && disk.items.length === 3,
    detail: `推 3 题新题生效（applied=${o1.includes('[hotfix] applied v1')}，merged=${o1.includes('history+3/skip0')}，version=${cfg.hotfixVersion}，落盘题数=${disk && disk.items.length}）` });
  results.push({ id: 2, pass: o2.includes('sha256 不符') && o2.includes('保留旧版') && cfg.hotfixVersion === 1 && !!disk && disk.items.length === 3,
    detail: `sha256 错拒绝（sha256 不符=${o2.includes('sha256 不符')}，版本仍=${cfg.hotfixVersion}，旧版仍 3 题=${!!disk && disk.items.length === 3}）` });
  results.push({ id: 3, pass: !o3.includes('uncaughtException') && cfg.hotfixVersion === 1 && !!disk && disk.items.length === 3,
    detail: `断网静默降级（无崩溃=${!o3.includes('uncaughtException')}，版本与旧数据完好=${cfg.hotfixVersion === 1 && !!disk && disk.items.length === 3}）` });
  results.push({ id: 4, pass: o4.includes('schema 不过') && o4.includes('保留旧版') && cfg.hotfixVersion === 1 && !!disk && disk.items.length === 3,
    detail: `schema 拒收（schema 不过=${o4.includes('schema 不过')}，版本仍=${cfg.hotfixVersion}，瑕疵题未入池=${!!disk && disk.items.length === 3}）` });
  let log = [];
  try { log = JSON.parse(fs.readFileSync(path.join(USERDATA, 'hotfix-log.json'), 'utf8')).entries || []; } catch (_e) {}

  const fail = results.filter((r) => !r.pass);
  const lines = [];
  lines.push('# 热更通道端到端演练报告');
  lines.push('');
  lines.push('- 时间：' + new Date().toISOString());
  lines.push('- 模式：B1 dry-run 路径（gh 未装）——本地 http 服务模拟 raw.githubusercontent.com，客户端经 --test-hotfix-base + --no-proxy-server 指向（生产白名单与系统代理路径不受影响）');
  lines.push('- 覆盖数据：quiz-history 3 题新题（长字段线格式 → 客户端 hotfix.js 三道校验 → 转内部格式落 userData/hotfix/ → applyHotfix 合并进 QUIZ_BANK）');
  lines.push('');
  for (const r of results) lines.push(`- [${r.pass ? '✅ PASS' : '❌ FAIL'}] 用例${r.id}：${r.detail}`);
  lines.push('');
  lines.push('- hotfix-log 记录（客户端侧，最新在前）：');
  for (const e of log.slice(0, 6)) lines.push('  - ' + JSON.stringify(e));
  lines.push('');
  lines.push('结论：' + (fail.length ? `${fail.length} 个用例未过，需修复` : '四用例全过，热更通道可用。Day 1 人工清单 = 浏览器建 remielle-hotfix 仓库 + 管理面板填 manifest 地址 + 首次 push-hotfix --push。'));
  const md = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(ROOT, 'docs', 'hotfix-drill.md'), md);
  console.log(md);
  console.log('报告已写 docs/hotfix-drill.md；' + (fail.length ? '存在失败用例！' : '全部通过。'));
  process.exit(fail.length ? 1 : 0);
}

const [,, cmd, arg] = process.argv;
if (cmd === 'scenario') scenario(Number(arg));
else if (cmd === 'serve') serve();
else if (cmd === 'judge') judge();
else { console.log('用法：node tools/hotfix-drill.js scenario 1|2|4 | serve | judge'); process.exit(1); }
