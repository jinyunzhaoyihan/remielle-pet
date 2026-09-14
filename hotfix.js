// 热更客户端模块（v2.5.0 Night 1 B2）：manifest 拉取 → sha256 → ajv → 结构查重 → 原子落盘（userData/hotfix/）
// 设计要点（docs/PLAN-250.md 技术校正）：
//   - 打包版 resources/ 在 asar 内只读 → 热更数据一律落 userData/hotfix/，运行时 = asar 基础库 + hotfix 覆盖层
//   - 域名白名单仅 raw.githubusercontent.com + https-only（--test-hotfix-base=<url> 仅供本地演练换基址，生产无效）
//   - 10s 超时；全流程 try/catch 任何失败不阻塞主应用启动；失败自动保留/回退旧版（rotate 只在全部校验通过后发生）
//   - cfg.hotfixVersion 单调递增（manifest.version ≤ 当前值直接跳过）
// 线格式（长字段名，与 tools/push-hotfix.js 的转换契约一致）：
//   题目 {id,difficulty,topic,multi?,question,options[4],answer,explanation,source,flagged?}
//   → 内部 {id,d,topic,multi?,q,opts,ans,ex,src,flagged?}（answer 单选 number/多选 number[]）
//   英语文件另含 passages:[{id,source,text}]；quotes:{pools:{key:[...]}}；banners:{activities,limBanners}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_HOST = 'raw.githubusercontent.com';
const DEFAULT_URL = 'https://raw.githubusercontent.com/remielle-pet/remielle-hotfix/main/manifest.json';
const HOTFIX_KEYS = ['quiz-history', 'quiz-politics', 'quiz-english', 'quotes', 'banners']; // 落盘白名单键

let Ajv = null;
try { Ajv = require('ajv'); } catch (_e) { /* ajv 缺席 = 拉取功能降级不可用，但不崩 */ }

let D = null; // 依赖注入：{ app, cfg, saveCfg, atomicWrite, applyHotfix, broadcast }
function initHotfix(deps) { D = deps; }
function hotfixDir() { return path.join(D.app.getPath('userData'), 'hotfix'); }
function logPath() { return path.join(D.app.getPath('userData'), 'hotfix-log.json'); }

// 基址解析：生产 = cfg.hotfixUrl（白名单校验）或默认官方仓库；演练 = --test-hotfix-base 换本地 http 服务
function resolveBase() {
  const tb = process.argv.find((a) => a.startsWith('--test-hotfix-base='));
  if (tb) return { base: tb.split('=')[1].replace(/\/+$/, ''), test: true };
  const url = D.cfg.hotfixUrl || DEFAULT_URL;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) return { base: null, test: false }; // 不合规 = 视作未配置
    return { base: url.replace(/\/+$/, ''), test: false };
  } catch (_e) { return { base: null, test: false }; }
}

async function fetchRaw(url, ms) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ms || 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(tm); }
}

// 线格式 → 内部格式（转换契约见文件头；answer 数组 ⇔ multi:true 结构校验）
function convertItemLong(it) {
  return {
    id: it.id, d: it.difficulty, topic: it.topic,
    q: it.question, opts: it.options,
    ans: it.answer, ex: it.explanation, src: it.source,
    ...(it.multi != null ? { multi: it.multi } : {}),
    ...(it.flagged != null ? { flagged: it.flagged } : {}),
  };
}
function convertKey(key, parsed) {
  if (key === 'quiz-history' || key === 'quiz-politics') {
    return { items: parsed.items.map(convertItemLong) };
  }
  if (key === 'quiz-english') {
    return {
      items: parsed.items.map(convertItemLong),
      passages: (parsed.passages || []).map((p) => ({ id: p.id, src: p.source, text: p.text })),
    };
  }
  if (key === 'quotes') return { pools: parsed.pools };
  if (key === 'banners') return { activities: parsed.activities, limBanners: parsed.limBanners };
  throw new Error('unknown key ' + key);
}

// 结构查重：批内 id 唯一 + 题干（去空白前 40 字）去重 + answer/multi 配对；跨批次查重在 main 的 applyHotfix 里对基础库做
function dedupCheck(items, label) {
  const ids = new Set(), stems = new Set();
  for (const it of items) {
    if (ids.has(it.id)) throw new Error(label + ' id 重复: ' + it.id);
    ids.add(it.id);
    const stem = String(it.question || '').replace(/\s+/g, '').slice(0, 40);
    if (stems.has(stem)) throw new Error(label + ' 题干重复: ' + stem);
    stems.add(stem);
    if (Array.isArray(it.answer) && !it.multi) throw new Error(label + ' id=' + it.id + ' answer 为数组但缺 multi:true');
    if (typeof it.answer === 'number' && it.multi) throw new Error(label + ' id=' + it.id + ' multi:true 但 answer 非数组');
  }
}

// ajv 校验（按 key 编译缓存；ajv 缺席 = 直接判失败，宁可不用热更也不放脏数据）
const COMPILED = {};
function validateKey(key, parsed) {
  if (!Ajv) throw new Error('ajv 不可用');
  if (!COMPILED[key]) {
    const ansUnion = {
      oneOf: [
        { type: 'integer', minimum: 0, maximum: 3 },
        { type: 'array', items: { type: 'integer', minimum: 0, maximum: 3 }, minItems: 2, maxItems: 4 },
      ],
    };
    const itemLong = {
      type: 'object',
      required: ['id', 'difficulty', 'topic', 'question', 'options', 'answer', 'explanation', 'source'],
      properties: {
        id: { type: 'integer', minimum: 1 },
        difficulty: { type: 'integer', minimum: 1, maximum: 5 },
        topic: { type: 'string', minLength: 1 },
        multi: { type: 'boolean' },
        question: { type: 'string', minLength: 6 },
        options: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 4, maxItems: 4 },
        answer: ansUnion,
        explanation: { type: 'string', minLength: 10 },
        source: { type: 'string', minLength: 2 },
        flagged: { type: 'boolean' },
      },
      additionalProperties: false,
    };
    let schema;
    if (key === 'quiz-history' || key === 'quiz-politics') schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: itemLong } }, additionalProperties: false };
    else if (key === 'quiz-english') schema = {
      type: 'object', required: ['items', 'passages'],
      properties: {
        items: { type: 'array', items: itemLong },
        passages: { type: 'array', items: { type: 'object', required: ['id', 'source', 'text'], properties: { id: { type: 'integer' }, source: { type: 'string' }, text: { type: 'string', minLength: 50 } }, additionalProperties: false } },
      },
      additionalProperties: false,
    };
    else if (key === 'quotes') schema = { type: 'object', required: ['pools'], properties: { pools: { type: 'object', minProperties: 1, additionalProperties: { type: 'array', minItems: 1 } } }, additionalProperties: false };
    else if (key === 'banners') schema = { type: 'object', properties: { activities: { type: 'array' }, limBanners: { type: 'object' } }, additionalProperties: false, anyOf: [{ required: ['activities'] }, { required: ['limBanners'] }] };
    else throw new Error('unknown key ' + key);
    COMPILED[key] = new Ajv({ allErrors: true }).compile(schema);
  }
  const ok = COMPILED[key](parsed);
  if (!ok) throw new Error(key + ' schema 不过: ' + JSON.stringify(COMPILED[key].errors).slice(0, 400));
}

// 落盘：先 rotate（.json→.v1→.v2→.v3 删最旧）再原子写新档——只在全部校验通过后调用 = 天然回滚语义
function keyFile(key) {
  if (!HOTFIX_KEYS.includes(key)) throw new Error('key 越权: ' + key);
  return path.join(hotfixDir(), key + '.json');
}
function rotateAndWrite(key, internalObj) {
  const f = keyFile(key);
  fs.mkdirSync(hotfixDir(), { recursive: true });
  for (let i = 3; i >= 1; i--) {
    const from = f + (i === 1 ? '' : '.v' + (i - 1));
    const to = f + '.v' + i;
    try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch (_e) {}
  }
  D.atomicWrite(f, JSON.stringify(internalObj));
}

// 启动/回退时从磁盘读已落盘热更（主档坏 → 回退 .v1 → .v2 → .v3，全坏 = 该键放弃）
function loadLocalHotfix() {
  const out = {};
  for (const key of HOTFIX_KEYS) {
    const f = keyFile(key);
    for (const cand of [f, f + '.v1', f + '.v2', f + '.v3']) {
      try {
        if (!fs.existsSync(cand)) continue;
        out[key] = JSON.parse(fs.readFileSync(cand, 'utf8'));
        break;
      } catch (_e) { /* 试上一代 */ }
    }
  }
  return out;
}

function appendLog(entry) {
  try {
    let log = { entries: [] };
    try { log = JSON.parse(fs.readFileSync(logPath(), 'utf8')); } catch (_e) {}
    if (!Array.isArray(log.entries)) log.entries = [];
    log.entries.unshift({ at: Date.now(), ...entry });
    log.entries = log.entries.slice(0, 50);
    D.atomicWrite(logPath(), JSON.stringify(log, null, 2));
  } catch (_e) { /* 日志失败不影响主流程 */ }
}

// 主入口：reason ∈ startup/schedule/manual；任何异常只记日志，绝不向上抛（不阻塞启动）
async function checkHotfix(reason) {
  try {
    const { base, test } = resolveBase();
    if (!base) { appendLog({ reason, ok: false, detail: '未配置合规热更地址' }); return; }
    const manifestBuf = await fetchRaw(base + '/manifest.json');
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    if (!manifest || !Number.isInteger(manifest.version) || typeof manifest.files !== 'object') throw new Error('manifest 结构坏');
    if (manifest.version <= (D.cfg.hotfixVersion || 0)) { appendLog({ reason, ok: true, detail: 'skip 版本不新 v' + manifest.version }); return; }
    const converted = {};
    for (const [key, meta] of Object.entries(manifest.files || {})) {
      if (!HOTFIX_KEYS.includes(key)) throw new Error('manifest 出现越权键 ' + key);
      if (typeof meta.path !== 'string' || !/^data\/[a-z0-9-]+\.json$/.test(meta.path)) throw new Error(key + ' path 不合规');
      const buf = await fetchRaw(base + '/' + meta.path);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (sha !== meta.sha256) throw new Error(key + ' sha256 不符（期望 ' + String(meta.sha256).slice(0, 12) + '… 实得 ' + sha.slice(0, 12) + '…）');
      const parsed = JSON.parse(buf.toString('utf8'));
      validateKey(key, parsed);
      if (parsed.items) dedupCheck(parsed.items, key);
      converted[key] = convertKey(key, parsed);
    }
    for (const [key, obj] of Object.entries(converted)) rotateAndWrite(key, obj);
    D.cfg.hotfixVersion = manifest.version;
    D.saveCfg();
    D.applyHotfix(converted);
    D.broadcast('hotfix:updated', { version: manifest.version });
    appendLog({ reason, ok: true, version: manifest.version, keys: Object.keys(converted) });
    console.log('[hotfix] applied v' + manifest.version + ' keys=' + Object.keys(converted).join(','));
  } catch (e) {
    const cause = e && e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
    appendLog({ reason, ok: false, detail: String(e.message + cause).slice(0, 200) });
    console.log('[hotfix] ' + reason + ' 失败（保留旧版）: ' + e.message + cause);
    try { D.applyHotfix(loadLocalHotfix()); } catch (_e2) {}
  }
}

module.exports = { initHotfix, checkHotfix, loadLocalHotfix, convertItemLong, validateKey, dedupCheck, logPath, HOTFIX_KEYS };
