// 热更推送工具（v2.5.0 Night 1 B3）：内部短字段题库 → 热更长字段线格式 → 三道校验 → data/*.json + manifest.json
// 用法：node tools/push-hotfix.js [--set-version=N] [--push]
//   默认 dry-run = 只写本地 remielle-hotfix/ 仓库目录，不做任何 git 操作；--push 才 git add/commit/push
// 转换契约（与 hotfix.js 文件头一致）：
//   内部 {id,d,topic,multi?,q,opts[4],ans,ex,src,flagged?}
//   ↔ 线格式 {id,difficulty,topic,multi?,question,options[4],answer,explanation,source,flagged?}
//   （answer 单选 number / 多选 number[]；multi 归一为 boolean，仅多选携带）
//   英语 passages:[{id,src,text}] ↔ [{id,source,text}] 整体转换
// 仓库布局：<项目根>/remielle-hotfix/{manifest.json, data/quiz-history.json, ...}；gh 就位后 push 即上线
// 安全：子进程一律 execFileSync 参数列表形式 + 字面量命令名（不经 shell，版本号永不拼进命令字符串）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { validateKey, dedupCheck } = require('../hotfix.js');

const ROOT = path.resolve(__dirname, '..');
const REPO_DIR = path.join(ROOT, 'remielle-hotfix'); // 仓库目录固定（字面量），不接受 argv 传路径
const MANIFEST = path.join(REPO_DIR, 'manifest.json');
const DATA_DIR = path.join(REPO_DIR, 'data');

// 科目 → 内部来源与线格式键名（字面量表）
const SOURCES = {
  'quiz-history': () => ({ items: require('../resources/quiz/hist.js').items }),
  'quiz-politics': () => ({ items: require('../resources/quiz/pol.js').items }),
  'quiz-english': () => { const m = require('../resources/quiz/en.js'); return { items: m.items, passages: m.passages || [] }; },
};

function toLongItem(it, defaultTopic) {
  return {
    id: it.id,
    difficulty: it.d,
    topic: it.topic || defaultTopic,
    ...(it.multi ? { multi: true } : {}),
    question: it.q,
    options: it.opts,
    answer: it.ans,
    explanation: it.ex,
    source: it.src || '未标注',
    ...(it.flagged ? { flagged: true } : {}),
  };
}

function main() {
  const args = process.argv.slice(2);
  const setVersion = (() => { const a = args.find((x) => x.startsWith('--set-version=')); return a ? Number(a.split('=')[1]) : null; })();
  const doPush = args.includes('--push');

  // 0) 本地基础库先过内部校验器（全绿才有资格推送）
  console.log('[push] 运行 quiz-validate（基础库门槛）…');
  execFileSync('node', ['tools/quiz-validate.js'], { cwd: ROOT, stdio: 'inherit' });

  // 1) 转换 + 校验（ajv schema 与客户端同一份：hotfix.validateKey）
  const files = {};
  for (const [key, load] of Object.entries(SOURCES)) {
    const internal = load();
    const wire = { items: internal.items.map((it) => toLongItem(it, key === 'quiz-english' ? '考研英语' : '综合')) };
    if (internal.passages) wire.passages = internal.passages.map((p) => ({ id: p.id, source: p.src || '未标注', text: p.text }));
    validateKey(key, wire);
    dedupCheck(wire.items, key);
    files[key] = wire;
    console.log(`[push] ${key}: ${wire.items.length} 题${wire.passages ? ` + ${wire.passages.length} 篇阅读` : ''} 校验过`);
  }
  const quotesPath = path.join(ROOT, 'renderer', 'assets', 'quotes-extended.json');
  if (fs.existsSync(quotesPath)) {
    const pools = JSON.parse(fs.readFileSync(quotesPath, 'utf8'));
    if (pools && typeof pools === 'object' && Object.keys(pools).length) {
      validateKey('quotes', { pools });
      files.quotes = { pools };
      console.log(`[push] quotes: ${Object.keys(pools).length} 个台词池 校验过`);
    }
  }

  // 2) 版本号：现 manifest +1 或 --set-version 指定；拒绝倒退
  let version = 1;
  let prevVersion = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    prevVersion = Number(prev.version) || 0;
    version = prevVersion + 1;
  } catch (_e) { /* 首版 */ }
  if (setVersion != null) {
    if (setVersion < prevVersion) throw new Error(`版本倒退 ${setVersion} < ${prevVersion}，拒绝`);
    version = setVersion;
  }

  // 3) 落盘 data/*.json（紧凑序列化保证 sha256 稳定）+ manifest
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const manifestFiles = {};
  for (const [key, wire] of Object.entries(files)) {
    const buf = Buffer.from(JSON.stringify(wire), 'utf8');
    fs.writeFileSync(path.join(DATA_DIR, key + '.json'), buf);
    manifestFiles[key] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), path: 'data/' + key + '.json' };
  }
  const manifest = { version, updatedAt: new Date().toISOString(), files: manifestFiles };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`[push] manifest v${version} 写入 ${MANIFEST}（${Object.keys(manifestFiles).length} 个数据文件）`);

  // 4) git 推送（仅 --push；dry-run 到此为止）。参数列表形式，不经 shell
  if (doPush) {
    if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
      console.log('[push] 目录还不是 git 仓库。Day 1 人工清单：浏览器建 GitHub 仓库 remielle-hotfix 后在此目录 git init + remote add origin + push。');
      process.exit(1);
    }
    const git = (gitArgs) => execFileSync('git', gitArgs, { cwd: REPO_DIR, stdio: 'inherit' });
    git(['add', '-A']);
    git(['commit', '-m', 'hotfix v' + version]);
    git(['push']);
    console.log('[push] 已推送 v' + version);
  } else {
    console.log('[push] dry-run 完成：只写了本地目录，未 git 操作（--push 可推送）');
  }
}

try { main(); } catch (e) { console.error('PUSH FAIL ' + e.message); process.exit(1); }
