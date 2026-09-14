// 蕾米埃尔桌宠 - Electron 主进程
// 透明、无边框、置顶的小窗口；桌宠的移动通过 IPC 驱动本窗口位移实现
// 二阶段：配置持久化 / 全屏瞬移 / DeepSeek 陪聊 / 定时提醒 / 缩放 / 置顶开关 / 自启
const { app, BrowserWindow, ipcMain, screen, Menu, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

app.setName('RemiellePet'); // 决定 userData 目录（config.json 位置）

// 兜底：深夜无人在场，未捕获异常只记日志不退出，保证桌宠活到早上
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

// 单实例：重复启动时聚焦已有窗口，避免出现两只蕾米。
// 联调开关 --test-instance：独立临时 userData（不污染真实存档）+ 天然独立锁，可与运行中实例并存测试；
// 同时强制 deviceScaleFactor=1——无人值守会话的 DPI 感知与桌面不一致会让抓帧按 125% 布局溢出裁切
if (process.argv.includes('--test-instance')) {
  // --test-userdata=名字 可指定固定临时目录（损坏恢复等跨重启测试用）；缺省仍按 PID 隔离
  const tu = process.argv.find((a) => a.startsWith('--test-userdata='));
  app.setPath('userData', path.join(os.tmpdir(), tu ? 'remielle-test-' + tu.split('=')[1] : 'remielle-test-' + process.pid));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}
const gotLock = app.requestSingleInstanceLock() || process.argv.includes('--test-instance');
if (!gotLock) app.quit();
const FAST_BACKUP = process.argv.includes('--test-backup-fast'); // 联调：滚动备份节流归零（损坏恢复测试用）

// 加固（v2.4.0）：移除默认应用菜单——打包版 Ctrl+Shift+I / F12 等 DevTools 加速键随菜单一起消失，
// 文本复制粘贴由 Chromium 原生处理不受影响。DevTools 只能从管理面板（PIN 解锁后）定向打开。
Menu.setApplicationMenu(null);

const BASE_W = 340, BASE_H = 420;
let win = null;
let scale = 1; // 当前缩放档位

// ===== 配置持久化 + 存档安全层（v2.4.0）=====
// 可靠性：原子写（tmp→rename）防「写一半坏档」；每日+每小时多代备份滚动保留 50 份；
// 可恢复：主档缺失/损坏自动回滚到最近可用备份（夜间无人值守也能自愈）；sha256 sidecar 供审计
const cfg = { x: null, y: null, scale: 1, fontSize: 14, topmost: true, push: true, pushIntervalMin: 30, pushQuote: true, pushNews: true, newsCap: 3, lastQuoteDate: '', newsSeen: [], reminders: [], chatWinPos: null, poolUrl: null, mobileToken: null, appVersion: null, deco: '', spriteSeed: 20260913, hotfixUrl: null, hotfixVersion: 0, bgRotate: false };
let cfgRecoveredFrom = null; // 本次启动若发生自愈，记录来源备份名（whenReady 里通知+审计）
function cfgPath() { return path.join(app.getPath('userData'), 'config.json'); }
function backupDir() {
  // Gate A3：备份独立于 userData（%APPDATA%\remielle-backups），卸载/删档误操作不连带备份；
  // --test-instance 保持旧位（隔离档自含，避免测试写真实备份目录）
  if (process.argv.includes('--test-instance')) return path.join(app.getPath('userData'), 'backups');
  return path.join(app.getPath('appData'), 'remielle-backups');
}
// 一次性搬迁：旧 <userData>/backups → 新目录（幂等：搬完旧目录删除，重复调用无事发生）
function migrateBackups() {
  const legacy = path.join(app.getPath('userData'), 'backups');
  const dir = backupDir();
  try {
    if (!fs.existsSync(legacy)) return;
    if (path.resolve(legacy) === path.resolve(dir)) return; // test-instance 下两者同目录，跳过（否则 exists(to) 恒真会误删）
    const files = fs.readdirSync(legacy).filter((f) => /^save-\d{17}-[a-z]+\.json$/.test(f));
    if (!files.length) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const from = path.join(legacy, f), to = path.join(dir, f);
      if (fs.existsSync(to)) { fs.unlinkSync(from); continue; } // 新目录已有同名（含毫秒不可能撞）以新为准
      try { fs.renameSync(from, to); } catch (_e) { fs.copyFileSync(from, to); fs.unlinkSync(from); }
    }
    fs.rmSync(legacy, { recursive: true, force: true });
    console.log('[backup] 旧备份已迁移 → ' + dir + '（' + files.length + ' 份）');
  } catch (e) { console.log('[backup] 迁移失败（不影响运行）: ' + e.message); }
}
function validSaveShape(obj) { return !!obj && typeof obj === 'object' && !!obj.nurture && typeof obj.nurture === 'object'; }
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); return true; } catch (_e) { /* Windows 覆盖 rename 偶发 EPERM，重试 */ }
  }
  try { fs.writeFileSync(file, data); return true; } catch (_e) { return false; } // 兜底直写：丢原子性也保数据
}
function backupFilePath(name) { // 白名单文件名 + 根目录边界校验，防任何形式的路径拼接逃逸
  if (typeof name !== 'string' || !/^save-\d{17}-[a-z]+\.json$/.test(name)) return null;
  const root = path.resolve(backupDir());
  const p = path.resolve(root, name);
  return p.startsWith(root + path.sep) ? p : null;
}
let lastBackupKey = {};
let lastRollingAt = 0;
function backupSave(reason) { // reason: daily | rolling | version | manual | pre-recovery
  try {
    const dir = backupDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    if (reason === 'daily') { // 每日一份（保底），一天只取一次
      const key = now.toISOString().slice(0, 10);
      if (lastBackupKey.daily === key) return null;
      lastBackupKey.daily = key;
    }
    const name = 'save-' + now.toISOString().replace(/[-:T]/g, '').replace('.', '').slice(0, 17) + '-' + reason + '.json'; // 含毫秒：同名秒内也严格有序
    const p = backupFilePath(name);
    if (!p) return null;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    const files = fs.readdirSync(dir).filter((f) => /^save-\d{17}-[a-z]+\.json$/.test(f));
    if (files.length > 50) { // 滚动保留 50 份（按修改时间淘汰最旧）
      const withAt = files.map((f) => { const pf = backupFilePath(f); let at = 0; try { at = fs.statSync(pf).mtimeMs; } catch (_e) {} return { f, pf, at }; }).sort((a, b) => a.at - b.at);
      for (const x of withAt.slice(0, files.length - 50)) { try { fs.unlinkSync(x.pf); } catch (_e) {} }
    }
    return name;
  } catch (_e) { return null; }
}
function listBackups() {
  try {
    const dir = backupDir();
    return fs.readdirSync(dir).filter((f) => /^save-\d{17}-[a-z]+\.json$/.test(f)).map((f) => {
      const p = backupFilePath(f);
      if (!p) return null;
      let ok = false, at = 0, size = 0;
      try { if (validSaveShape(JSON.parse(fs.readFileSync(p, 'utf8')))) ok = true; } catch (_e) {}
      try { const st = fs.statSync(p); at = st.mtimeMs; size = st.size; } catch (_e) {}
      return { name: f, ok, at, size };
    }).filter(Boolean).sort((a, b) => b.at - a.at); // 按实际修改时间取最新（文件名同秒内含毫秒仍以 mtime 为准）
  } catch (_e) { return []; }
}
function loadCfg() {
  let loaded = null;
  try {
    const j = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    if (validSaveShape(j)) loaded = j;
  } catch (_e) { /* 首次启动无配置 */ }
  if (!loaded) { // 主档缺失/损坏 → 自愈：从新到旧找第一个可用备份
    for (const b of listBackups().filter((x) => x.ok)) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(backupDir(), b.name), 'utf8'));
        if (validSaveShape(j)) { loaded = j; cfgRecoveredFrom = b.name; console.log('[save] 主档缺失/损坏，已自愈:', b.name); break; }
      } catch (_e) {}
    }
  }
  if (loaded) {
    Object.assign(cfg, loaded);
    if (cfgRecoveredFrom) atomicWrite(cfgPath(), JSON.stringify(cfg, null, 2)); // 自愈结果立即落盘
    // 关键：把 NUR 重新挂到磁盘档上。浅合并会整体替换 cfg.nurture 引用，
    // 若不挂钩，养成读写留在内存孤岛对象上，跨重启全部回档（v2.2.4 存量 bug）
    if (cfg.nurture && typeof cfg.nurture === 'object') {
      NUR = ensureNurShape(cfg.nurture);
      if (!NUR.bornAt) { NUR.bornAt = Date.now(); saveCfg(); }
    }
  }
}
function saveCfg() {
  try {
    const data = JSON.stringify(cfg, null, 2);
    if (atomicWrite(cfgPath(), data)) {
      try { fs.writeFileSync(cfgPath() + '.sha256', crypto.createHash('sha256').update(data).digest('hex')); } catch (_e) {}
      const dayKey = new Date().toISOString().slice(0, 10);
      if (lastBackupKey.daily !== dayKey) { lastBackupKey.daily = dayKey; backupSave('daily'); } // 每日保底
      else if (Date.now() - lastRollingAt > (FAST_BACKUP ? 0 : 600000)) { lastRollingAt = Date.now(); backupSave('rolling'); } // ≥10 分钟滚动一份（--test-backup-fast 时每存必备）
    }
  } catch (_e) { /* 写失败不影响运行 */ }
}

const winW = () => Math.round(BASE_W * scale);
const winH = () => Math.round(BASE_H * scale);

function clampToWorkArea() {
  const wa = screen.getPrimaryDisplay().workArea;
  const [x, y] = win.getPosition();
  const nx = Math.min(Math.max(wa.x, x), wa.x + wa.width - winW());
  const ny = Math.min(Math.max(wa.y, y), wa.y + wa.height - winH());
  if (nx !== x || ny !== y) win.setPosition(nx, ny);
}

// ===== 移动 IPC =====
// 移动只碰位置（setPosition，历史上最稳）；尺寸只在缩放/自愈时经 robustSetSize 调整。
// 实测：带尺寸的 setContentBounds 在高频移动下会被 Windows DPI 反算 bug 偶发污染尺寸。
function healSizeIfNeeded() {
  const b = win.getContentBounds();
  if (b.width !== winW() || b.height !== winH()) robustSetSize(b.x, b.y, winW(), winH());
}

// 尺寸调整统一入口：Electron/Windows 对无边框不可缩放窗口的 setContentBounds 存在 DPI 反算
// bug（150% 缩放下请求 340x420 可能按物理像素落地成 227x280），先临时开 resizable 再落地，
// 读回校验，不到位就按实测/请求比例补偿重试。
function robustSetSize(x, y, w, h) {
  for (let i = 0; i < 4; i++) {
    win.setResizable(true);
    win.setContentBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    win.setResizable(false);
    const b = win.getContentBounds();
    if (Math.abs(b.width - w) <= 1 && Math.abs(b.height - h) <= 1) return;
    const cw = Math.round(w * w / Math.max(1, b.width));
    const ch = Math.round(h * h / Math.max(1, b.height));
    win.setResizable(true);
    win.setContentBounds({ x: Math.round(x), y: Math.round(y), width: cw, height: ch });
    win.setResizable(false);
    const b2 = win.getContentBounds();
    if (Math.abs(b2.width - w) <= 1 && Math.abs(b2.height - h) <= 1) return;
  }
}

ipcMain.on('pet:move-by', (_e, dx, dy) => {
  if (!win) return;
  healSizeIfNeeded();
  const [x, y] = win.getPosition();
  win.setPosition(x + Math.round(dx), y + Math.round(dy));
  clampToWorkArea();
});

ipcMain.on('pet:set-position', (_e, x, y) => {
  if (!win) return;
  healSizeIfNeeded();
  win.setPosition(Math.round(x), Math.round(y));
  clampToWorkArea();
});

// ===== 窗口安全加固（v2.4.0）：拦 DevTools 组合键 / 拒渲染层开窗与跳转 =====
// DevTools 唯一入口 = 管理面板 PIN 解锁后的定向打开；键盘路径在此全部堵死
function hardenWindow(w) {
  if (!w || w.isDestroyed() || !w.webContents) return;
  const wc = w.webContents;
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();
    if (k === 'f12' || (input.control && input.shift && (k === 'i' || k === 'j' || k === 'c'))) e.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); // 渲染层禁止 window.open
  wc.on('will-navigate', (e) => e.preventDefault()); // 渲染层禁止页面跳转
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  scale = Math.min(1.5, Math.max(0.75, cfg.scale || 1));
  const x = cfg.x == null ? wa.x + wa.width - winW() - 30 : cfg.x;
  const y = cfg.y == null ? wa.y + wa.height - winH() : cfg.y;
  win = new BrowserWindow({
    width: winW(),
    height: winH(),
    x, y,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: cfg.topmost !== false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hardenWindow(win);
  if (cfg.topmost !== false) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Windows 缩放环境下无边框窗口创建后带 ~4px 隐形边框补偿，加载后校一次尺寸；
  // 同时把当前缩放通知渲染层（body zoom 与窗口尺寸必须同步）
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getContentBounds();
      robustSetSize(b.x, b.y, winW(), winH());
      win.webContents.send('pet:scale', scale);
    }, 300);
  });
}

// ===== 视线跟随 =====
// 每 33ms（30fps）算一次光标相对桌宠视觉中心的角度（atan2 屏幕角：0°=右，90°=下）。
// 视觉中心按窗口比例取点（宽度一半、高度 279/420 处），任何缩放档位都正确。
const gazeTimerHolder = { timer: null };
function startGazeTracking() {
  let lastAngle = null;
  gazeTimerHolder.timer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height * (279 / 420);
    const dx = c.x - cx;
    const dy = c.y - cy;
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // 光标在她身上时不斜眼
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (lastAngle === null || Math.abs(angle - lastAngle) > 0.4) {
      lastAngle = angle;
      win.webContents.send('pet:gaze', angle);
    }
  }, 33);
}

ipcMain.handle('pet:workarea', () => screen.getPrimaryDisplay().workArea);

// ===== 推送（每日英语学习推送：金句 + 英文新闻） =====
// 内容管线：fetchPushItems() 聚合金句与新闻频道 -> 去重队列 -> 逐条气泡投放。
// 数据源（2026-09-10 实测可达）：ZenQuotes 金句 API、Sixth Tone RSS、CGTN World RSS。
const pushSeen = new Set();
const pushQueue = [];
let showingPush = false;
const pushTimerHolder = { timer: null };

function normalizePushItem(it) {
  const title = String((it && it.title) || '').slice(0, 80);
  const body = String((it && it.body) || '').slice(0, 220);
  return { id: String((it && it.id) != null ? it.id : title + '|' + body), title, body };
}

// 轻量 RSS 解析：提取 <item> 内的 title/link/pubDate/description（容忍 CDATA，零依赖）
function parseRssItems(xml) {
  const out = [];
  const items = String(xml || '').match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const pick = (tag) => {
      const m = item.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    };
    out.push({ title: pick('title'), link: pick('link'), pubDate: pick('pubDate'), description: pick('description') });
  }
  return out.filter((x) => x.title);
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

// 每日金句：ZenQuotes 随机句 + DeepSeek 三行式（原句/翻译/蕾米风格赏析），每天一次
async function fetchQuoteOfDay() {
  if (cfg.pushQuote === false) return [];
  const today = todayStr();
  if (cfg.lastQuoteDate === today) return []; // 今天已推过，重启也不重复
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 8000);
  let q = '', a = '';
  try {
    const res = await (await fetch('https://zenquotes.io/api/random', { signal: ctrl.signal })).json();
    q = ((res[0] || {}).q || '').trim();
    a = ((res[0] || {}).a || '').trim();
  } catch (_e) { /* 金句源失败：今天就不推 */ }
  clearTimeout(tm);
  if (!q) return [];
  cfg.lastQuoteDate = today;
  saveCfg();
  let body = q + (a ? '\n— ' + a : '');
  try {
    body = await callDeepSeek([
      { role: 'system', content: PERSONA_CORE + '\n共犯给你一句英语金句，请输出三行：第一行英文原句（保留），第二行中文翻译，第三行一句蕾米风格（甜美爱捉弄、称呼共犯）的中文赏析。总长不超过 120 字，不要 markdown。' },
      { role: 'user', content: q + (a ? ' — ' + a : '') },
    ]);
  } catch (_e) { /* AI 失败降级为纯英文原句 */ }
  return [{ id: 'quote-' + today, title: '🌟 每日英语金句', body }];
}

const NEWS_FEEDS = [
  { name: 'Sixth Tone', url: 'https://api.sixthtone.com/cont/output/rssApi' },
  { name: 'CGTN', url: 'https://www.cgtn.com/subscribe/rss/section/world.xml' },
];

// 英文新闻：两源并行拉取合并，按时间倒序去重，取最新 newsCap 条
async function fetchNewsItems() {
  if (cfg.pushNews === false) return [];
  const cap = Math.max(1, Number(cfg.newsCap) || 3);
  const results = await Promise.allSettled(NEWS_FEEDS.map(async (f) => {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 6000);
    try {
      const xml = await (await fetch(f.url, { signal: ctrl.signal })).text();
      return parseRssItems(xml).map((x) => ({ ...x, feed: f.name }));
    } finally {
      clearTimeout(tm);
    }
  }));
  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  all.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
  const seen = new Set(cfg.newsSeen || []);
  const out = [];
  for (const it of all) {
    if (out.length >= cap) break;
    const id = 'news-' + (it.link || it.title);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: '📰 ' + it.title, body: (it.description || '').slice(0, 140) });
  }
  if (out.length) {
    cfg.newsSeen = [...seen].slice(-60); // 记住已推过的，重启不重复
    saveCfg();
  }
  return out;
}

// 聚合器：金句 + 新闻（现有去重队列/投放管线零改动）
async function fetchPushItems() {
  const [quotes, news] = await Promise.all([fetchQuoteOfDay(), fetchNewsItems()]);
  return [...quotes, ...news];
}

async function pushPoll() {
  if (cfg.push === false) return;
  try {
    for (const raw of await fetchPushItems()) {
      const it = normalizePushItem(raw);
      if (!it.title && !it.body) continue;
      if (pushSeen.has(it.id)) continue;
      pushSeen.add(it.id);
      pushQueue.push(it);
    }
  } catch (_e) { /* 静默，下轮再试 */ }
  deliverNextPush();
}

function deliverNextPush() {
  if (showingPush || !win || win.isDestroyed()) return;
  const it = pushQueue.shift();
  if (!it) return;
  showingPush = true;
  win.flashFrame(true);
  win.webContents.send('pet:push', it);
  // 完整内容同步进聊天窗消息流（气泡只当提醒，长文在聊天窗可慢慢读）
  if (chatWin && !chatWin.isDestroyed()) {
    try { chatWin.webContents.send('pet:push', it); } catch (_e) { /* 聊天窗不在就算了 */ }
  }
  setTimeout(() => {
    showingPush = false;
    deliverNextPush();
  }, 9000); // 一条气泡至少停留 9s，避免连报刷屏
}

function startPushLoop() {
  const min = Math.max(1, Number(cfg.pushIntervalMin) || 10);
  pushTimerHolder.timer = setInterval(pushPoll, min * 60000);
  setTimeout(pushPoll, 8000); // 启动后先跑一轮
}

// ===== 摸鱼检测彩蛋（v2.5）：扫到游戏/抖音进程 → 渲染层哭脸+锯齿气泡抓现行 =====
// 只匹配 ASCII 关键词（中文进程名经 GBK 输出会乱码，靠 exe 名兜住：ZenlessZoneZero/DeltaForce/Douyin）
const { exec } = require('child_process');
const SLOUCH_RE = /(zenless|zzzgame|deltaforce|douyin)/i;
let lastSlouchAt = 0;
function startSlouchWatcher() {
  setInterval(() => {
    try {
      exec('tasklist /fo csv /nh', { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout || !win || win.isDestroyed()) return;
        const hit = String(stdout).split('\n').find((l) => SLOUCH_RE.test(l));
        if (!hit) return;
        const now = Date.now();
        const hour = new Date().getHours();
        if (now - lastSlouchAt < 2 * 3600 * 1000) return; // 2 小时内不重复抓，别烦人
        if (hour < 8 || hour >= 23) return; // 深夜凌晨不打扰（23 点后自有深夜自言自语彩蛋接管）
        lastSlouchAt = now;
        const procName = hit.split('","')[0].replace(/^"|"$/g, '');
        win.webContents.send('pet:slouch', procName);
      });
    } catch (_e) {}
  }, 120 * 1000);
}

ipcMain.handle('pet:get-config', () => ({ scale, topmost: cfg.topmost !== false, fontSize: Math.min(20, Math.max(12, cfg.fontSize || 14)) }));

// 聊天字号持久化（渲染层已实时应用，这里只落盘）
ipcMain.on('pet:set-font-size', (_e, px) => {
  cfg.fontSize = Math.min(20, Math.max(12, Number(px) || 14));
  saveCfg();
});

// ===== 彩蛋：分身术 =====
// 克隆窗口可点击对话（复用 pet:chat 同一 DeepSeek 链路，本体与分身心意相通、共享记忆）。
// 随机分布 + 拒绝采样避免堆叠；未互动 15s 自动消散，每次互动续命 60s，上限 10 只/次。
const cloneWins = new Map(); // BrowserWindow -> 关窗 setTimeout
function armCloneClose(cw, ms) {
  const old = cloneWins.get(cw);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    // 先通知页面淡出再硬关，消散有过渡不突兀
    try { if (!cw.isDestroyed()) cw.webContents.send('pet:clone-fade'); } catch (_e) {}
    setTimeout(() => { try { if (!cw.isDestroyed()) cw.close(); } catch (_e) {} }, 700);
  }, ms);
  cloneWins.set(cw, t);
}
function spawnClones() {
  if (!win) return;
  const MAX = 10, W = 170, H = 270;
  const hold = process.argv.includes('--test-clones'); // 联调模式：驻留 90s 方便观察，生产 15s
  const wa = screen.getPrimaryDisplay().workArea;
  const placed = []; // 已放分身的窗口中心，用于拉开间距
  const me = win.getContentBounds();
  const myCenter = [me.x + me.width / 2, me.y + me.height / 2];
  for (let i = 0; i < MAX; i++) {
    // 串行创建：连续同步开 10 个透明窗口疑似触发合成器竞态（曾致全部隐形），间隔错峰
    setTimeout(() => createClone(i, placed, wa, W, H, hold, myCenter), i * 250);
  }
}
function createClone(i, placed, wa, W, H, hold, myCenter) {
  {
    let x = 0, y = 0;
    for (let t = 0; t < 40; t++) {
      x = wa.x + 6 + Math.floor(Math.random() * Math.max(1, wa.width - W - 12));
      y = wa.y + 6 + Math.floor(Math.random() * Math.max(1, wa.height - H - 12));
      const cx = x + W / 2, cy = y + H / 2;
      // 与已放分身中心距超过一个窗宽、且不压在本体中心才算合格；40 次都没挑中就用最后一次（允许小屏密集）
      if (placed.every(([px, py]) => Math.hypot(px - cx, py - cy) > W) &&
          Math.hypot(myCenter[0] - cx, myCenter[1] - cy) > W) break;
    }
    placed.push([x + W / 2, y + H / 2]);
    console.log('[clone] create #' + i, 'at', x, y);
    const cw2 = new BrowserWindow({
      width: W, height: H, x, y,
      transparent: true, frame: false, resizable: false,
      skipTaskbar: false, hasShadow: false, // 参数对齐已验证正常的聊天窗
      alwaysOnTop: cfg.topmost !== false, show: true,
      backgroundColor: '#00000000', // 透明窗口的推荐保证项（聊天窗有此项且正常，分身曾缺失）
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    hardenWindow(cw2);
    if (cfg.topmost !== false) cw2.setAlwaysOnTop(true, 'screen-saver');
    cloneWins.set(cw2, null);
    cw2.loadFile(path.join(__dirname, 'renderer', 'clone.html'), { search: hold ? 'hold=1' : '' });
    // 黑屏根因（已修）：clone.html body 初始 opacity:0 + CSS transition，在透明窗口上合成器永不提交
    // 过渡首帧 → 渲染器零绘制（页面/DOM/Win32 层全正常）。修复 = keyframes animation（终态恒 1）。
    // ready-to-show + show/blur 兜底保留；showInactive 与 did-finish-load 提前显示均会拿到黑帧（已实测）
    cw2.once('ready-to-show', () => { try { cw2.show(); cw2.blur(); } catch (_e) {} });
    const reveal = () => {
      try {
        if (cw2.isDestroyed()) return;
        if (!cw2.isVisible()) { cw2.show(); cw2.blur(); }
        cw2.setResizable(true);
        const [w0, h0] = cw2.getSize();
        cw2.setSize(w0 + 1, h0);
        cw2.setSize(w0, h0);
        cw2.setResizable(false);
      } catch (e) { console.error('[clone] reveal-fail', e); }
    };
    setTimeout(reveal, 1500);
    cw2.on('closed', () => {
      const t = cloneWins.get(cw2);
      if (t) clearTimeout(t);
      cloneWins.delete(cw2);
    });
    armCloneClose(cw2, hold ? 90000 : 15000);
  }
}
// 分身互动续命：每次发消息把这只分身的消散计时重置为 60s
ipcMain.on('pet:clone-activity', (e) => {
  for (const cw of cloneWins.keys()) {
    if (cw.webContents === e.sender) { armCloneClose(cw, 60000); break; }
  }
});

// 渲染层读素材：file:// 图片直接画进 canvas 会因跨源污染读不出像素，
// 改由主进程读文件经 IPC 传字节；文件名只允许纯文件名，防目录穿越
ipcMain.handle('pet:read-asset', async (_e, name) => {
  if (typeof name !== 'string' || /[\\/]|\.\./.test(name)) {
    throw new Error('invalid asset name');
  }
  // 热更台词覆盖层：热更 quotes.json 到位后，渲染层读 quotes-extended.json 时把热更台词池并入返回
  if (name === 'quotes-extended.json' && hotfixQuotes) {
    let base = {};
    try { base = JSON.parse(fs.readFileSync(path.join(__dirname, 'renderer', 'assets', name), 'utf8')); } catch (_e) {}
    for (const [k, lines] of Object.entries(hotfixQuotes)) {
      base[k] = Array.isArray(base[k]) ? base[k].concat(lines) : lines;
    }
    return Buffer.from(JSON.stringify(base), 'utf8');
  }
  return fs.promises.readFile(path.join(__dirname, 'renderer', 'assets', name));
});

// v2.5 素材冲刺：扫描 staging/ready 独立 PNG（expr-*/act-*/deco-*），以 dataURL 注入渲染层图层
// 缺席科目返回空 = 渲染层隐藏对应覆盖层，零回归；打包版 staging 不存在 = 恒空（素材走热更通道下发）
function stageAssetPath(name) { // 白名单文件名 + 根目录边界校验，杜绝路径拼接逃逸
  if (typeof name !== 'string' || !/^(expr|act|deco)-[a-z0-9-]+\.png$/.test(name)) return null;
  const root = path.resolve(__dirname, 'resources', 'staging', 'ready');
  const p = path.resolve(root, name);
  return p.startsWith(root + path.sep) ? p : null;
}
ipcMain.handle('pet:stage-assets', () => {
  const out = { expr: {}, act: {}, deco: {} };
  try {
    const root = path.resolve(__dirname, 'resources', 'staging', 'ready');
    if (!fs.existsSync(root)) return out;
    for (const f of fs.readdirSync(root)) {
      const p = stageAssetPath(f);
      if (!p) continue;
      out[f.slice(0, f.indexOf('-'))][f.replace(/\.png$/, '')] =
        'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    }
  } catch (_e) {}
  return out;
});

// ===== 聊天窗（NextChat 式独立窗口：陪聊 + 查攻略） =====
// 透明窗口 + CSS 大圆角做"圆润"；固定尺寸（Windows 透明窗口与 resizable 不兼容）
let chatWin = null;
function openChatWindow(mode) {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.webContents.send('pet:chat-mode', mode);
    if (chatWin.isMinimized()) chatWin.restore();
    chatWin.focus();
    return;
  }
  const W = 360, H = 540;
  const wa = screen.getPrimaryDisplay().workArea;
  let x, y;
  if (cfg.chatWinPos) {
    x = cfg.chatWinPos.x; y = cfg.chatWinPos.y; // 上次位置优先
  } else {
    const b = win && !win.isDestroyed() ? win.getContentBounds() : wa;
    x = b.x + b.width + 16; // 默认出现在桌宠右侧
    y = b.y + Math.max(0, b.height - H);
  }
  x = Math.min(Math.max(wa.x + 8, x), wa.x + wa.width - W - 8);
  y = Math.min(Math.max(wa.y + 8, y), wa.y + wa.height - H - 8);
  chatWin = new BrowserWindow({
    width: W, height: H, x, y,
    transparent: true, frame: false, resizable: false,
    backgroundColor: '#00000000',
    alwaysOnTop: cfg.topmost !== false,
    skipTaskbar: false, // 聊天窗允许在任务栏/Alt-Tab 找到
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  hardenWindow(chatWin);
  if (cfg.topmost !== false) chatWin.setAlwaysOnTop(true, 'screen-saver');
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'));
  chatWin.once('ready-to-show', () => {
    chatWin.webContents.send('pet:chat-mode', mode);
    chatWin.show();
  });
  chatWin.on('close', () => { // 记住位置，下次原地打开
    try {
      const b2 = chatWin.getContentBounds();
      cfg.chatWinPos = { x: b2.x, y: b2.y };
      saveCfg();
    } catch (_e) {}
  });
  chatWin.on('closed', () => { chatWin = null; });
}
ipcMain.handle('pet:open-chat-window', (_e, mode) => openChatWindow(mode === 'guide' ? 'guide' : 'chat'));
ipcMain.handle('pet:chat-history', () => chatHistory.slice());

// ===== HUD 主窗口（v2.2.6：立绘主视觉 + 抽卡/副本/任务/成就四视图，ZZZ 深色 HUD 风） =====
// 不透明实底窗（背景图/纯色），因此可安全 resizable（透明窗才与 resizable 不兼容）
let hudWin = null;
// HUD 素材自动适配：扫描 chara/reimer（idle/happy/tired/hungry/blink）与 bg（hud-main/hud-gacha/hud-quiz/hud-sign），
// 缺哪个就降级哪层（立绘缺→内置雪碧图特写帧兜底；背景缺→纯色+径向渐变），用户后放文件即生效，不阻塞
function scanHudAssets() {
  const out = { chara: {}, bg: {} };
  const charaDir = path.join(__dirname, 'resources', 'chara', 'reimer');
  for (const k of ['idle', 'happy', 'tired', 'hungry', 'blink']) {
    for (const ext of ['.png', '.webp', '.jpg']) {
      if (fs.existsSync(path.join(charaDir, k + ext))) { out.chara[k] = '../resources/chara/reimer/' + k + ext; break; }
    }
  }
  try {
    for (const f of fs.readdirSync(path.join(__dirname, 'resources', 'bg'))) {
      const ext = path.extname(f).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
      out.bg[path.basename(f, ext).toLowerCase()] = '../resources/bg/' + f;
    }
  } catch (_e) { /* bg 目录不存在：纯色兜底 */ }
  return { chara: out.chara, bg: out.bg, testRedFlag: process.argv.includes('--test-redflag') };
}
function openHudWindow() {
  if (hudWin && !hudWin.isDestroyed()) { hudWin.show(); hudWin.focus(); return; }
  hudWin = new BrowserWindow({
    width: 1440, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: '#1a1a24',
    frame: false, show: false,
    title: '蕾米埃尔 · HUD',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  hardenWindow(hudWin);
  hudWin.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
  hudWin.once('ready-to-show', () => hudWin.show());
  const notifyMax = () => { try { if (hudWin && !hudWin.isDestroyed()) hudWin.webContents.send('hud:maximized', hudWin.isMaximized()); } catch (_e) {} };
  hudWin.on('maximize', notifyMax);
  hudWin.on('unmaximize', notifyMax);
  hudWin.on('closed', () => { hudWin = null; });
}
ipcMain.handle('hud:open', () => openHudWindow());
ipcMain.handle('hud:init', () => scanHudAssets());
ipcMain.on('hud:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('hud:maximize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.on('hud:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
// HUD 准实时刷新：60s 结算后推一次全量状态（表情/红点联动），task-done/state-low 事件仍即时推
function hudBroadcastState() {
  if (hudWin && !hudWin.isDestroyed()) {
    try { hudWin.webContents.send('hud:state', nurtureState()); } catch (_e) {}
  }
}
ipcMain.handle('pet:hud-state', () => nurtureState());

// 透明区域点击穿透：作用于发送方窗口（主宠物与分身通用）
ipcMain.on('pet:set-ignore-mouse', (e, ignore) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(!!ignore, { forward: true });
});

// ===== 缩放 / 置顶 =====
function setScale(s) {
  scale = Math.min(2, Math.max(0.5, Number(s) || 1));
  cfg.scale = scale;
  saveCfg();
  if (!win) return;
  // 底边锚定：缩放后她仍然"站"在同一地面上
  const b = win.getContentBounds();
  robustSetSize(b.x, b.y + b.height - winH(), winW(), winH());
  clampToWorkArea();
  win.webContents.send('pet:scale', scale);
}
function setTopmost(on) {
  cfg.topmost = !!on;
  saveCfg();
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!on, 'screen-saver');
}

// ===== 定时提醒 =====
const reminderTimers = new Map(); // at -> timer
function parseReminder(raw) {
  const t = String(raw || '').trim();
  let m;
  if ((m = t.match(/^(\d{1,3})\s*(?:m|min|分钟|分)\s+(.+)$/i))) {
    return { at: Date.now() + Number(m[1]) * 60000, text: m[2].trim() };
  }
  if ((m = t.match(/^(\d{1,2})\s*(?:h|小时|时)\s+(.+)$/i))) {
    return { at: Date.now() + Number(m[1]) * 3600000, text: m[2].trim() };
  }
  if ((m = t.match(/^([01]?\d|2[0-3])[:：]([0-5]\d)\s+(.+)$/))) {
    const now = new Date();
    let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2])).getTime();
    if (at <= now.getTime()) at += 86400000; // 已过今天这个点就算明天
    return { at, text: m[3].trim() };
  }
  return null;
}
function armReminder(r) {
  const t = setTimeout(() => fireReminder(r), Math.max(0, r.at - Date.now()));
  reminderTimers.set(r.at, t);
}
function fireReminder(r) {
  reminderTimers.delete(r.at);
  cfg.reminders = cfg.reminders.filter((x) => x.at !== r.at);
  saveCfg();
  if (win && !win.isDestroyed()) {
    win.flashFrame(true);
    win.webContents.send('pet:reminder-fired', r.text);
  }
}
function addReminder(r) {
  cfg.reminders.push(r);
  if (cfg.reminders.length > 10) cfg.reminders.shift(); // 上限 10 条，丢最旧
  saveCfg();
  armReminder(r);
}
function rearmReminders() {
  cfg.reminders.forEach(armReminder);
}
ipcMain.handle('pet:reminder-add', (_e, text) => {
    const r = parseReminder(text);
    if (!r) return { error: 'parse' };
    addReminder(r);
    NUR.money += 2; addExp(3); markTask('feed'); saveCfg(); // 帮主人管事有工资（养成联动）
    return { ok: true, at: r.at, text: r.text };
});

// ===== 养成系统（参考 VPet：状态条随时间衰减，喂食/打工/互动恢复） =====
// 惰性结算：按 now-lastTick 一次性折算离线时段，clamp 到 [2,100] 保底不死
let SHOP = [
  { id: 'jelly',     name: '果冻',           price: 6,  food: 15, drink: 0,  feel: 0,  energy: 0,  health: 0 },
  { id: 'milktea',   name: '夜巴奶茶',       price: 12, food: 0,  drink: 25, feel: 5,  energy: 0,  health: 0 },
  { id: 'energy',    name: '能量饮料',       price: 15, food: 0,  drink: 0,  feel: 0,  energy: 30, health: -5 },
  { id: 'ramen',     name: '拉面',           price: 18, food: 40, drink: -5, feel: 0,  energy: 0,  health: 0 },
  { id: 'eggtart',   name: '蛋挞',           price: 10, food: 20, drink: 0,  feel: 5,  energy: 0,  health: 0 },
  { id: 'setmeal',   name: '新艾利都套餐',   price: 30, food: 50, drink: 0,  feel: 0,  energy: 10, health: 0 },
  { id: 'soda',      name: '彩虹气泡水',     price: 8,  food: 0,  drink: 18, feel: 8,  energy: 0,  health: 0 },
  { id: 'bento',     name: '妈妈的手作便当', price: 25, food: 45, drink: 0,  feel: 10, energy: 0,  health: 0 },
  { id: 'coffee',    name: '咖啡',           price: 10, food: 0,  drink: -3, feel: 0,  energy: 20, health: 0 },
  { id: 'icecream',  name: '冰淇淋',         price: 7,  food: 5,  drink: 0,  feel: 12, energy: 0,  health: -2 },
];
// ===== 打工类型（F5 三选一）与外置配置层 =====
let WORK_TYPES = {
  draw:   { name: '画画',   icon: '🎨', ms: 45000,  energy: 15, food: 10, drink: 8,  base: 8,  perLv: 2, exp: 6 },
  study:  { name: '自习',   icon: '📚', ms: 90000,  energy: 25, food: 18, drink: 12, base: 10, perLv: 2, exp: 15 },
  live:   { name: '直播',   icon: '📱', ms: 120000, energy: 35, food: 25, drink: 20, base: 20, perLv: 3, exp: 10 },
};
let ACTIVITIES = [
  { id: 'midautumn_week', name: '仲秋团圆周', start: '2026-09-22 00:00', end: '2026-09-28 23:59', filMult: 1.5, desc: '仲秋将至，菲林 ×1.5——攒够调频，仲秋神秘大礼等着你！' },
  { id: 'national_day', name: '国庆双倍菲林', start: '2026-09-30 00:00', end: '2026-10-08 23:59', filMult: 2, desc: '假期陪她，菲林双倍！' },
];
// 称号：晋升门槛刻意拉高，传说之后每 15 级一段（不封顶）
const TITLES = [[1, '见习共犯'], [5, '初级共犯'], [10, '资深共犯'], [20, '王牌共犯'], [35, '传说共犯']];
function titleFor(level) {
  let t = TITLES[0][1];
  for (const [lv, name] of TITLES) if (level >= lv) t = name;
  if (level >= 50) t += ` · ${Math.floor((level - 35) / 15) + 1} 段`; // 50 级起进入段位
  return t;
}
// 成就徽章：cond 全部满足即点亮（cfg 永久记录）；hint 给未解锁时的达成提示（P1-7 可发现性）
function achievementDefs() {
  return [
    { id: 'first_feed', icon: '🍼', name: '初次喂食', hint: '累计喂食 1 次解锁', cond: () => (NUR.stats || {}).fedTotal >= 1 },
    { id: 'first_work', icon: '🎨', name: '首次打工', hint: '完成 1 次打工解锁', cond: () => (NUR.stats || {}).workTotal >= 1 },
    { id: 'foodie', icon: '🍚', name: '干饭人', hint: '累计喂食 10 次解锁', cond: () => (NUR.stats || {}).fedTotal >= 10 },
    { id: 'worker', icon: '💼', name: '打工人', hint: '累计打工 10 次解锁', cond: () => (NUR.stats || {}).workTotal >= 10 },
    { id: 'lv3', icon: '⭐', name: '三级跳', hint: '等级达到 3 级解锁', cond: () => NUR.level >= 3 },
    { id: 'first_reward', icon: '🎁', name: '被宠爱', hint: '收到第一份真人奖励解锁', cond: () => (NUR.rewards ? NUR.rewards.physical + NUR.rewards.emotional : 0) >= 1 },
    { id: 'rich', icon: '💰', name: '小富婆', hint: '丁尼达到 500 解锁', cond: () => NUR.money >= 500 },
    { id: 'gambler', icon: '🎰', name: '初次调频', hint: '完成第一次调频解锁', cond: () => (NUR.gacha.history || []).length >= 1 },
  ];
}
function checkAchievements() {
  const unlocked = (NUR.achievements = NUR.achievements || []);
  let newly = null;
  for (const a of achievementDefs()) {
    if (!unlocked.includes(a.id) && a.cond()) {
      unlocked.push(a.id);
      (NUR.achLog = NUR.achLog || {})[a.id] = Date.now(); // 达成时间，供详情展示
      newly = a;
    }
  }
  if (newly) saveCfg();
  return newly;
}
// 外置配置热更/远程拉取：男主人改本地 json 或配 poolUrl（Gist）即可维护卡池，无需改代码
function applyPoolRaw(raw) {
  if (!raw || typeof raw !== 'object') return;
  if (Array.isArray(raw.shop) && raw.shop.every((s) => s.id && s.name)) SHOP = raw.shop;
  if (raw.workTypes && typeof raw.workTypes === 'object' && Object.keys(raw.workTypes).length) WORK_TYPES = raw.workTypes;
  if (raw.stdPool && Array.isArray(raw.stdPool.S) && Array.isArray(raw.stdPool.A) && Array.isArray(raw.stdPool.B)) STD_POOL = raw.stdPool;
  if (raw.limBanners && typeof raw.limBanners === 'object') LIM_BANNERS = raw.limBanners;
  if (Array.isArray(raw.dailyTasks) && raw.dailyTasks.every((t) => t.id && t.name)) DAILY_TASKS = raw.dailyTasks;
  if (Array.isArray(raw.activities)) ACTIVITIES = raw.activities;
}
const POOL_PATH = path.join(__dirname, 'resources', 'gacha-pool.json');
function loadLocalPool() {
  try {
    const raw = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
    if (raw && typeof raw === 'object') { applyPoolRaw(raw); return true; }
  } catch (_e) { /* 无文件或坏 json：用内置默认 */ }
  return false;
}
// SSRF 防护：仅 https、拒绝 localhost/私有/保留地址
function isSafePoolUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0' || h === '[::1]') return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return true;
  } catch (_e) { return false; }
}
async function fetchRemotePool() {
  if (!cfg.poolUrl || !isSafePoolUrl(String(cfg.poolUrl))) return false;
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(String(cfg.poolUrl), { signal: ctrl.signal });
    clearTimeout(tm);
    if (!res.ok) return false;
    const raw = JSON.parse(await res.text());
    if (!raw || typeof raw !== 'object') return false;
    applyPoolRaw(raw);
    fs.writeFileSync(POOL_PATH, JSON.stringify(raw, null, 2)); // 缓存本地，断网也有
    return true;
  } catch (_e) { return false; }
}
function refreshPools() {
  try { loadLocalPool(); } catch (_e) {}
  if (cfg.poolUrl) fetchRemotePool().catch(() => {});
}
// 双端术语唯一源（P1-5）：面板名/状态名/货币名都从这里取，桌面聊天窗与移动面板共用一份
let I18N = {};
function loadI18n() {
  try { I18N = JSON.parse(fs.readFileSync(path.join(__dirname, 'resources', 'i18n-pet.json'), 'utf8')) || {}; }
  catch (_e) { I18N = {}; }
}
ipcMain.handle('pet:get-i18n', () => I18N);
// 限时活动：按时间窗自动激活；filGain 让活动期间菲林获取乘倍
function activeActivity() {
  const now = Date.now();
  return (ACTIVITIES || []).find((a) => {
    const s = Date.parse(a.start), e = Date.parse(a.end);
    return Number.isFinite(s) && Number.isFinite(e) && now >= s && now <= e;
  }) || null;
}
function filGain(base) {
  const act = activeActivity();
  return Math.round(base * (act && act.filMult ? act.filMult : 1));
}

// NUR 字段兜底：新版本新增字段在旧档上补默认（gacha 用默认表做浅兜底，旧档已有值不覆盖）
function ensureNurShape(n) {
  n.stats = n.stats || { fedTotal: 0, workTotal: 0, chatTotal: 0, rewardTotal: 0 };
  n.achievements = n.achievements || [];
  if (!n.login) n.login = { month: '', days: 0, claimed7: false };
  n.rewards = n.rewards || { physical: 0, emotional: 0 };
  n.tasks = n.tasks || { date: '', done: [] };
  n.quizDaily = n.quizDaily || { date: '', history: 0, english: 0, politics: 0, full: 0 };
  if (!n.quiz) n.quiz = {};
  n.quiz.answered = n.quiz.answered || { history: [], english: [], politics: [] };
  n.quiz.rolling = n.quiz.rolling || { history: [], english: [], politics: [] };
  n.quiz.tier = Object.assign({ history: 2, english: 2, politics: 2 }, n.quiz.tier);
  n.quiz.stats = Object.assign({
    history: { asked: 0, correct: 0 }, english: { asked: 0, correct: 0 }, politics: { asked: 0, correct: 0 },
  }, n.quiz.stats);
  n.quiz.week = n.quiz.week || { key: '', fullDays: 0, done: false };
  n.gacha = Object.assign({
    fil: 300, stdTapes: 5, encTapes: 5, stdPity: 0, stdAPity: 0, limPity: 0, limAPity: 0,
    limGuarantee: false, loginStreak: 0, lastLogin: '', introSeen: false, history: [], warehouse: [],
  }, n.gacha);
  return n;
}
cfg.nurture = cfg.nurture || { food: 80, drink: 80, feel: 70, energy: 90, exp: 0, level: 1, money: 80, lastTick: Date.now(), workBusy: false, lastWork: null, lastFeedbackAt: 0, rewards: { physical: 0, emotional: 0 }, rewardPending: false, lastRewardReq: 0, bornAt: Date.now(), stats: { fedTotal: 0, workTotal: 0, chatTotal: 0, rewardTotal: 0 }, achievements: [],
  gacha: { fil: 300, stdTapes: 5, encTapes: 5, stdPity: 0, stdAPity: 0, limPity: 0, limAPity: 0, limGuarantee: false, loginStreak: 0, lastLogin: '', introSeen: false, history: [], warehouse: [] },
  tasks: { date: '', done: [] } };
let NUR = ensureNurShape(cfg.nurture);
// 模块级禁止 saveCfg（Gate A2 审计）：bornAt 兜底只在 loadCfg 合并后做（loadCfg 内 116-118 行），
// 此处若写盘会用默认档覆盖真实存档（v2.4.0 事故①同款；默认字面量已带 bornAt，原此处行恒不可达，已删）

function nurtureClamp() {
  for (const k of ['food', 'drink', 'feel', 'energy']) {
    NUR[k] = Math.min(100, Math.max(2, NUR[k]));
  }
}

function settleNurture() {
  const hours = Math.max(0, (Date.now() - (NUR.lastTick || Date.now())) / 3600000);
  if (hours > 0) {
    NUR.food -= 4 * hours;
    NUR.drink -= 6 * hours;
    NUR.feel -= 3 * hours;
    NUR.energy -= 2 * hours;
    if (NUR.food > 50) NUR.energy += 3 * hours; // 饱食过半时精力自然回复
    NUR.lastTick = Date.now();
    nurtureClamp();
    saveCfg();
  }
  return hours;
}

// 低状态主动提醒（VPet 式事件派发：主进程只负责发现，展示方式交给聊天窗）
// 每状态每日只提醒一次（内存态即可，重启后再提醒一次反而合理）
const LOW_STATE_TIPS = {
  food: { name: '饱食', act: '喂点吃的' },
  drink: { name: '口渴', act: '来点喝的' },
  feel: { name: '心情', act: '哄一哄她' },
  energy: { name: '精力', act: '让她歇会儿' },
};
const lowStateNotified = {};
function checkLowStates() {
  const today = new Date().toDateString();
  for (const [k, tip] of Object.entries(LOW_STATE_TIPS)) {
    if (NUR[k] < 20 && lowStateNotified[k] !== today) {
      lowStateNotified[k] = today;
      const d = { key: k, name: tip.name, val: Math.round(NUR[k]), act: tip.act };
      if (chatWin && !chatWin.isDestroyed()) {
        try { chatWin.webContents.send('pet:state-low', d); } catch (_e) {}
      }
      notifyMobile('state-low', d);
    }
  }
}

function expNext(level) {
  return Math.round(50 * Math.pow(level, 1.5));
}

function addExp(n) {
  NUR.exp += n;
  let leveled = false;
  while (NUR.exp >= expNext(NUR.level)) {
    NUR.exp -= expNext(NUR.level);
    NUR.level += 1;
    NUR.money += 20 + 10 * NUR.level;
    leveled = true;
  }
  if (leveled) {
    saveCfg();
    // 升级 → 向真人邀功求奖励（6h 冷却防烦）；实体发放由用户在聊天窗养成页操作
    if (Date.now() - (NUR.lastRewardReq || 0) > 6 * 3600000) {
      NUR.rewardPending = true;
      NUR.lastRewardReq = Date.now();
      saveCfg();
      if (win && !win.isDestroyed()) win.webContents.send('pet:action', 'reward-request');
    }
  }
  return leveled;
}

function addFeel(n) {
  NUR.feel = Math.min(100, Math.max(2, NUR.feel + n));
}

function nurtureState() {
  settleNurture();
  return {
    bgRotate: cfg.bgRotate === true, // Gate A4：HUD 背景轮播开关（默认关）
    food: Math.round(NUR.food), drink: Math.round(NUR.drink),
    feel: Math.round(NUR.feel), energy: Math.round(NUR.energy),
    // 每小时净衰减率（负=消耗，正=回复）：状态条浮层算「预计见底时间」用
    decayRate: { food: -4, drink: -6, feel: -3, energy: (NUR.food > 50 ? 3 : 0) - 2 },
    exp: Math.round(NUR.exp), expNext: expNext(NUR.level),
    level: NUR.level, money: Math.round(NUR.money),
    poor: NUR.food < 15 || NUR.drink < 15 || NUR.energy < 15,
    workBusy: !!NUR.workBusy,
    rewardPending: !!NUR.rewardPending,
    rewards: NUR.rewards || { physical: 0, emotional: 0 },
    title: titleFor(NUR.level),
    stats: NUR.stats || {},
    achievements: NUR.achievements || [],
    achLog: NUR.achLog || {},
    achDefs: achievementDefs().map((a) => ({ id: a.id, icon: a.icon, name: a.name, hint: a.hint || '' })),
    // 任务定义（按当前等级折算的真实展示奖励），渲染层不再硬编码——名称与数值以主进程为准
    taskDefs: DAILY_TASKS.map((t) => ({ id: t.id, name: t.name, fil: Math.round((t.fil + (NUR.level - 1) * 5) * 1.5), exp: t.exp || 5 })),
    // 备考副本 v2：每日配额 / 难度层 / 正确率统计 / 周全勤进度（渲染层入口卡与答题流共用）
    quiz: { daily: quizDaily(), tier: NUR.quiz.tier, stats: NUR.quiz.stats, week: quizWeek() },
    warehouseAll: (g().warehouse || []).slice(0, 50), // 含 used 归档，供查看完整使用记录
    workTypes: WORK_TYPES,
    gacha: {
      fil: g().fil, stdTapes: g().stdTapes, encTapes: g().encTapes,
      stdPity: g().stdPity, limPity: g().limPity, limGuarantee: !!g().limGuarantee,
      loginStreak: g().loginStreak, introSeen: !!g().introSeen,
      banner: currentBanner(), tasks: tasks().done, history: (g().history || []).slice(0, 10),
      activity: activeActivity() ? { name: activeActivity().name, desc: activeActivity().desc || '', filMult: activeActivity().filMult || 1 } : null,
      bornAt: NUR.bornAt,
      warehouse: (g().warehouse || []).filter((w) => w.status === 'held').slice(0, 30),
      pendingCount: (g().warehouse || []).filter((w) => w.status === 'pending').length, // 已申请待管理员确认
      usedCount: (g().warehouse || []).filter((w) => w.status === 'used').length,
    },
    shop: SHOP,
  };
}

// 真人奖励发放：physical=实物（奶茶/零食/小礼物）emotional=情绪价值（摸头/夸夸/陪伴）
const REWARD_QUOTES = {
  physical: ['哇！！是主人给的奖励！！共犯快替我谢谢他！', '为了这份奶茶，我可以再打十份工！', '哼哼，被两个人一起宠着，真是糟糕…才怪，超开心♪'],
  emotional: ['被夸奖了…嗯，充满力量了。', '共犯的陪伴和主人的夸奖，比什么道具都管用哦♪', '嘿嘿，被两个人需要的感觉，还不赖。'],
  later: ['哼，奖励欠着可以，记账了哦。', '好吧…下次要双倍补回来哦！'],
};
ipcMain.handle('pet:reward-grant', (_e, type) => {
  if (type === 'later') {
    NUR.rewardPending = false;
    saveCfg();
    if (win && !win.isDestroyed()) win.webContents.send('pet:action', 'reward-later');
    return { ok: true, quote: REWARD_QUOTES.later[Math.floor(Math.random() * REWARD_QUOTES.later.length)] };
  }
  if (type !== 'physical' && type !== 'emotional') return { error: 'badtype' };
  if (type === 'physical') {
    addFeel(15);
    NUR.exp += 8;
    g().encTapes += 1; // 真人发实物奖励：赠限定母带 ×1（鼓励兑现）
  } else {
    addFeel(8);
    NUR.exp += 5;
    g().fil += filGain(160); // 情绪价值：赠菲林 ×160（恰好一抽，限时活动可乘倍）
  }
  NUR.rewards = NUR.rewards || { physical: 0, emotional: 0 };
  NUR.rewards[type] += 1;
  NUR.stats = NUR.stats || { fedTotal: 0, workTotal: 0, chatTotal: 0, rewardTotal: 0 };
  NUR.stats.rewardTotal = (NUR.stats.rewardTotal || 0) + 1;
  checkAchievements();
  NUR.rewardPending = false;
  nurtureClamp();
  const leveled = addExp(0); // exp 直加后过一遍升级判定
  saveCfg();
  if (win && !win.isDestroyed()) win.webContents.send('pet:action', 'reward-got');
  return {
    ok: true,
    quote: REWARD_QUOTES[type][Math.floor(Math.random() * REWARD_QUOTES[type].length)],
    state: nurtureState(),
    leveled,
  };
});

setInterval(() => { settleNurture(); checkLowStates(); hudBroadcastState(); saveCfg(); }, 60000); // 每分钟结算+落盘+推 HUD

ipcMain.handle('pet:nurture-state', () => nurtureState());

ipcMain.handle('pet:feed', (_e, itemId) => {
  const item = SHOP.find((s) => s.id === itemId);
  if (!item) return { error: 'noitem' };
  if ((item.minLv || 1) > NUR.level) return { error: 'locked', minLv: item.minLv };
  if (NUR.money < item.price) return { error: 'poor' };
  NUR.money -= item.price;
  for (const k of ['food', 'drink', 'feel', 'energy', 'health']) {
    if (item[k]) {
      if (k === 'health') NUR.health = Math.min(100, Math.max(2, (NUR.health || 80) + item[k]));
      else NUR[k] += item[k];
    }
  }
  nurtureClamp();
  addExp(3);
  NUR.stats = NUR.stats || { fedTotal: 0, workTotal: 0, chatTotal: 0, rewardTotal: 0 };
  NUR.stats.fedTotal = (NUR.stats.fedTotal || 0) + 1;
  markTask('feed');
  checkAchievements();
  notifyMobile('feed', { item: item.name, state: nurtureStateForMobile() });
  saveCfg();
  return { ok: true, item: item.name, state: nurtureState() };
});

let workFinishAt = 0, workDef = null;
ipcMain.handle('pet:work-start', (_e, type) => {
  if (NUR.workBusy) return { error: 'busy' };
  if (NUR.energy < 20 || NUR.food < 15) return { error: 'tired' };
  const def = WORK_TYPES[type || 'draw'] || WORK_TYPES.draw;
  NUR.workBusy = true;
  workFinishAt = Date.now() + def.ms;
  workDef = def;
  saveCfg();
  if (win && !win.isDestroyed()) win.webContents.send('pet:action', 'working', def.ms); // 本体切画画/学习动画
  setTimeout(() => {
    // 打工结算：按类型消耗三围换零花钱/经验
    const earn = def.base + def.perLv * NUR.level + Math.floor(Math.random() * 7) - 3;
    NUR.money += Math.max(1, earn);
    NUR.energy -= def.energy; NUR.food -= def.food; NUR.drink -= def.drink;
    NUR.workBusy = false;
    nurtureClamp();
    addExp(def.exp);
    markTask('work');
    NUR.stats = NUR.stats || { fedTotal: 0, workTotal: 0, chatTotal: 0, rewardTotal: 0 };
    NUR.stats.workTotal = (NUR.stats.workTotal || 0) + 1;
    checkAchievements();
    NUR.lastWork = { earn: Math.max(1, earn), exp: def.exp, name: def.name, at: Date.now() };
    saveCfg();
  }, def.ms);
  return { ok: true, finishAt: workFinishAt, ms: def.ms, name: def.name };
});

ipcMain.handle('pet:work-result', () => {
  const r = { busy: !!NUR.workBusy, finishAt: workFinishAt, result: NUR.lastWork || null };
  NUR.lastWork = null; // 取走即清
  return r;
});

let lastFeedbackAt = 0;
ipcMain.handle('pet:feedback', (_e, delta) => {
  if (Date.now() - lastFeedbackAt < 30000) return { ok: false, cooldown: true }; // 30s 冷却防连刷
  lastFeedbackAt = Date.now();
  addFeel(Number(delta) || 2);
  saveCfg();
  return { ok: true };
});

// ===== 抽卡系统「小蕾米调频」（机制对标 ZZZ：菲林 160=1 母带；S 0.6% 综合含保底、A 5.1%、
// 90 硬保底、74 抽起概率递增、限定池 50% UP 歪了大保底、10 连必有 A；抽出的奖励券由男主人兑现） =====
let STD_POOL = {
  S: [
    { id: 's_milktea', name: '奶茶自由券', desc: '随时点单，送到教学楼下' },
    { id: 's_date', name: '约会之夜券', desc: '一次约会，全程由他安排' },
    { id: 's_wishbox', name: '心愿盲盒券', desc: '一份她想要的小物，他负责猜+买单（猜不中再买）' },
  ],
  A: [
    { id: 'a_delta', name: '三角洲双排券', desc: '陪她上分一晚，不嫌弃不指责' },
    { id: 'a_zzz', name: '绝区零代肝券', desc: '体力清完、周本打完，她只管躺' },
    { id: 'a_snack', name: '零食投喂券', desc: '一份她爱吃的零食' },
    { id: 'a_praise', name: '夸夸十分钟', desc: '当面专心夸她十分钟，不许敷衍' },
  ],
  B: [
    { id: 'b_hug', name: '课间抱抱 ×1', desc: '下课后一个真诚的拥抱' },
    { id: 'b_praise', name: '今日份彩虹屁', desc: '当面彩虹屁 ×1' },
    { id: 'b_walk', name: '陪走一程', desc: '晚上陪她散步回家' },
  ],
};
// 限定池按月轮换（UP 奖励）；超出定义的月份循环取用
let LIM_BANNERS = {
  '2026-09': { upS: { id: 'l_midautumn', name: '仲秋神秘大礼', desc: '当面交给她的一份神秘礼物' }, upA: { id: 'l_knit', name: '温暖小物', desc: '围巾/挂件/暖手宝，挑一样送她' } },
  '2026-10': { upS: { id: 'l_anniv', name: '纪念日活动', desc: '纪念日全天由她全权安排' }, upA: { id: 'l_flower', name: '甜品与鲜花', desc: '送到楼下的一份甜品+一束花' } },
  '2026-11': { upS: { id: 'l_winter', name: '过冬新装备', desc: '当面送她一件过冬好物' }, upA: { id: 'l_handwarm', name: '暖冬盲盒', desc: '暖手宝/毛绒挂件/热饮券三选一' } },
};
function currentBanner() {
  const ym = new Date().toISOString().slice(0, 7);
  const keys = Object.keys(LIM_BANNERS).sort();
  return LIM_BANNERS[ym] || LIM_BANNERS[keys[keys.findIndex((k) => k > ym) - 1] || keys[keys.length - 1]];
}

// 备考题库 v2：考研难度（历史=313 统考风格 / 英语=考研英语 / 政治=考研政治含多选），resources/quiz/ 三文件分科
// 扩建协议：夜间批次入库后必跑 node tools/quiz-validate.js
const QUIZ_EN = require('./resources/quiz/en.js');
const QUIZ_BANK = {
  history: require('./resources/quiz/hist.js').items,
  politics: require('./resources/quiz/pol.js').items,
  english: QUIZ_EN.items,
};
const QUIZ_PASSAGES = QUIZ_EN.passages || [];
const QUIZ_SUBJECTS = { history: '历史', english: '英语', politics: '政治' };
const QUIZ_DAILY_LIMIT = 5; // 每科每日限量；一季 90 天 × 5 × 3 科 = 1350 题，题库 1000+/科可支撑两个季度

// ===== 热更通道客户端接线（v2.5.0）：拉取/校验/落盘在 hotfix.js，这里负责合并进运行时对象 =====
// 合并规则（PLAN-250）：id 冲突跳过、题干查重拒绝、flagged:true 不入抽题池；英语 passages 按 id 去重并入
const hotfix = require('./hotfix.js');
const stemKey = (q) => String(q || '').replace(/\s+/g, '').slice(0, 40);
let hotfixQuotes = null;   // {pools:{key:[...]}} 热更台词覆盖层（read-asset 时合并进 quotes-extended）
let hotfixLastDay = '';    // 每日 09:00 定时检查的当日去重标记
function applyHotfix(map) {
  const report = [];
  for (const [key, data] of Object.entries(map || {})) {
    try {
      if (key === 'quiz-history' || key === 'quiz-politics' || key === 'quiz-english') {
        const subject = key === 'quiz-history' ? 'history' : key === 'quiz-politics' ? 'politics' : 'english';
        const bank = QUIZ_BANK[subject];
        const ids = new Set(bank.map((it) => it.id));
        const stems = new Set(bank.map((it) => stemKey(it.q)));
        let ok = 0, skip = 0;
        for (const it of (data.items || [])) {
          if (it.flagged || ids.has(it.id) || stems.has(stemKey(it.q))) { skip++; continue; }
          bank.push(it); ids.add(it.id); stems.add(stemKey(it.q)); ok++;
        }
        if (subject === 'english' && Array.isArray(data.passages)) {
          const pids = new Set(QUIZ_PASSAGES.map((p) => p.id));
          for (const p of data.passages) if (!pids.has(p.id)) { QUIZ_PASSAGES.push(p); pids.add(p.id); }
        }
        report.push(subject + '+' + ok + '/skip' + skip);
      } else if (key === 'quotes' && data.pools) {
        hotfixQuotes = data.pools; report.push('quotes');
      } else if (key === 'banners') {
        if (Array.isArray(data.activities)) ACTIVITIES = data.activities;
        if (data.limBanners && typeof data.limBanners === 'object') LIM_BANNERS = data.limBanners;
        report.push('banners');
      }
    } catch (e) { console.log('[hotfix] merge ' + key + ' fail: ' + e.message); }
  }
  if (report.length) console.log('[hotfix] merged: ' + report.join(' '));
}

let DAILY_TASKS = [
  { id: 'login', name: '每日签到', fil: 80, exp: 6 },
  { id: 'english', name: '备考充电·历史/英语/政治', fil: 60, exp: 8 },
  { id: 'feed', name: '喂食时间', fil: 40, exp: 4 },
  { id: 'chat', name: '聊聊今天', fil: 40, exp: 4 },
  { id: 'work', name: '打工赚钱', fil: 60, exp: 6 },
];

function g() { return NUR.gacha; }
function tasks() {
  const today = new Date().toDateString();
  if (NUR.tasks.date !== today) { NUR.tasks = { date: today, done: [], quiz: null }; }
  return NUR.tasks;
}
function markTask(id) {
  const t = tasks();
  if (t.done.includes(id)) return false;
  const def = DAILY_TASKS.find((x) => x.id === id);
  if (!def) return false;
  t.done.push(id);
  // 任务奖励：菲林（货币获取友好）+ 经验（任务也是升级途径）
  const filGot = filGain(Math.round((def.fil + (NUR.level - 1) * 5) * 1.5));
  g().fil += filGot;
  const expGot = def.exp || 5;
  addExp(expGot);
  checkAchievements();
  saveCfg();
  // 主动推给聊天窗：任务行浮字 + toast（反馈有锚点，不再等下次切 Tab 才可见）
  if (chatWin && !chatWin.isDestroyed()) {
    try { chatWin.webContents.send('pet:task-done', { id, name: def.name, fil: filGot, exp: expGot, filTotal: g().fil }); } catch (_e) {}
  }
  hudBroadcastState(); // HUD 任务视图/红点联动
  return true;
}
// 每日签到+重置：登录时判定（连续 7 天第 7 天送加密母带×10）
// 登录奖励表：月内累计第 1~7 天分天发十连资源（不要求连续，每月可领一轮）
const LOGIN_DAILY_REWARDS = [
  { enc: 1, fil: 80 }, { enc: 1 }, { enc: 2, fil: 160 }, { enc: 1 }, { enc: 2, fil: 160 }, { enc: 1 }, { enc: 2 },
];
function dailyCheck() {
  const today = new Date().toDateString();
  const ym = new Date().toISOString().slice(0, 7);
  if (!NUR.login) NUR.login = { month: ym, days: 0, lastLogin: '' };
  if (NUR.login.month !== ym) NUR.login = { month: ym, days: 0, lastLogin: '' }; // 跨月重置
  if (NUR.login.lastLogin === today) return;
  NUR.login.lastLogin = today;
  NUR.login.days += 1;
  notifyMobile('login', { days: NUR.login.days, fil: g().fil, encTapes: g().encTapes });
  let rewardText = '';
  if (NUR.login.days <= LOGIN_DAILY_REWARDS.length) { // 前 7 天分天发十连资源
    const rw = LOGIN_DAILY_REWARDS[NUR.login.days - 1];
    if (rw.enc) { g().encTapes += rw.enc; rewardText = `加密母带 ×${rw.enc}`; }
    if (rw.fil) { g().fil += filGain(rw.fil); rewardText += (rewardText ? ' + ' : '') + `菲林 ×${rw.fil}`; }
  }
  const bonus = 80 + (NUR.level - 1) * 10;
  g().fil += filGain(bonus);
  if (NUR.login.days === 7) rewardText += ' 🎉 本月累计 7 天达成！';
  markTask('login');
  checkAchievements();
  saveCfg();
  if (rewardText && win && !win.isDestroyed()) win.webContents.send('pet:push', { title: '📅 每日登录奖励', body: rewardText + `（本月第 ${NUR.login.days} 天）` });
}
ipcMain.handle('pet:login-bonus', () => { dailyCheck(); return { login: NUR.login, fil: g().fil, tasks: tasks() }; });

// ===== 备考副本 v2（考研难度）：每科每日 5 题 · 一次作答不可重答 · 难度自适应趋近 75% 正确率 · 周全勤结算母带 =====
// 经济收紧：答对按难度得菲林（8~16），答错无菲林；加密母带不再每日掉落，改为「三科全勤日」每周累计 5 天结算 1 张
function quizDaily() {
  const today = new Date().toDateString();
  if (!NUR.quizDaily || NUR.quizDaily.date !== today) {
    NUR.quizDaily = { date: today, history: 0, english: 0, politics: 0, full: 0 };
  }
  return NUR.quizDaily;
}
function quizWeek() {
  const dt = new Date();
  const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7));
  const key = monday.toDateString();
  if (!NUR.quiz.week || NUR.quiz.week.key !== key) NUR.quiz.week = { key, fullDays: 0, done: false };
  return NUR.quiz.week;
}
// 选题：目标难度层 ±容差扩展找未答过的题（滑窗正确率会自动调层）；全库答穿（>200 天）清空记录循环使用
function pickQuizItem(subject) {
  const answered = NUR.quiz.answered[subject];
  const tier = Math.min(5, Math.max(1, NUR.quiz.tier[subject] || 2));
  for (const off of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const d = Math.min(5, Math.max(1, tier + off));
    const pool = QUIZ_BANK[subject].filter((it) => it.d === d && !answered.includes(it.id));
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }
  NUR.quiz.answered[subject] = [];
  const pool = QUIZ_BANK[subject].filter((it) => it.d === tier);
  const bank = pool.length ? pool : QUIZ_BANK[subject];
  return bank[Math.floor(Math.random() * bank.length)];
}
// 英语「阅读日」：抽到则整篇 5 题连出；只挑 5 题全未答过的篇目
function pickEnglishPassagePid() {
  const byPid = {};
  for (const it of QUIZ_BANK.english) {
    if (it.pid != null && !NUR.quiz.answered.english.includes(it.id)) (byPid[it.pid] = byPid[it.pid] || []).push(it);
  }
  const full = Object.keys(byPid).filter((pid) => byPid[pid].length === QUIZ_DAILY_LIMIT);
  if (!full.length) return null;
  return Number(full[Math.floor(Math.random() * full.length)]);
}
ipcMain.handle('pet:dungeon-start', (_e, subject) => {
  if (!QUIZ_BANK[subject]) return { error: 'nosubject' };
  const dq = quizDaily();
  if (dq[subject] >= QUIZ_DAILY_LIMIT) return { error: 'quota', remaining: 0 };
  const t = tasks();
  t.dungeon = { subject, stage: 1, startedAt: Date.now(), correct: 0 };
  if (subject === 'english' && Math.random() < 0.4) {
    const pid = pickEnglishPassagePid();
    if (pid != null) t.dungeon.passagePid = pid; // 阅读日：1 篇正好 5 题
  }
  saveCfg();
  return { ok: true, subject, total: QUIZ_DAILY_LIMIT, remaining: QUIZ_DAILY_LIMIT - dq[subject], passage: !!t.dungeon.passagePid };
});
ipcMain.handle('pet:dungeon-question', () => {
  const t = tasks();
  if (!t.dungeon) return { error: 'nodungeon' };
  const subject = t.dungeon.subject;
  const q = t.dungeon.passagePid
    ? QUIZ_BANK.english.filter((it) => it.pid === t.dungeon.passagePid).sort((a, b) => a.id - b.id)[t.dungeon.stage - 1]
    : pickQuizItem(subject);
  if (!q) { t.dungeon = null; saveCfg(); return { error: 'nodungeon' }; }
  t.dungeon.q = q;
  t.dungeon.correct = t.dungeon.correct || 0; // 旧档残留会话无此字段时兜底，避免 NaN
  NUR.quiz.answered[subject].push(q.id); // 服务即记录：放弃/退出不退额度（防「换题摇奖」）
  quizDaily()[subject] += 1;
  saveCfg();
  return {
    subject: QUIZ_SUBJECTS[subject], idx: t.dungeon.stage, total: QUIZ_DAILY_LIMIT,
    multi: !!q.multi, d: q.d, q: q.q, opts: q.opts,
    passage: t.dungeon.passagePid ? (QUIZ_PASSAGES.find((p) => p.id === t.dungeon.passagePid) || {}).text || '' : null,
    remaining: QUIZ_DAILY_LIMIT - quizDaily()[subject],
    reward: `答对 🪙 +${8 + 2 * (q.d - 1)} ✨ +${2 + q.d} · 答错无菲林`,
  };
});
ipcMain.handle('pet:dungeon-submit', (_e, idx) => {
  const t = tasks();
  if (!t.dungeon || !t.dungeon.q) return { error: 'nodungeon' };
  const subject = t.dungeon.subject;
  const q = t.dungeon.q;
  const norm = (arr) => [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 3))].sort((a, b) => a - b);
  const pass = q.multi
    ? JSON.stringify(norm(Array.isArray(idx) ? idx : [])) === JSON.stringify(norm(q.ans))
    : Number(idx) === q.ans;
  t.dungeon.q = null; // 一次作答：判后立即失效，重发 submit 返回 nodungeon
  t.dungeon.correct += pass ? 1 : 0;
  // 难度自适应：滑窗最近 10 题，正确率 ≥85% 升难度 / ≤65% 降难度 → 稳态趋近 75%
  const qz = NUR.quiz;
  qz.rolling[subject].push(pass ? 1 : 0);
  if (qz.rolling[subject].length > 10) qz.rolling[subject] = qz.rolling[subject].slice(-10);
  qz.stats[subject].asked += 1;
  const win10 = qz.rolling[subject];
  if (win10.length >= 6) {
    const acc = win10.reduce((a, b) => a + b, 0) / win10.length;
    if (acc >= 0.85 && qz.tier[subject] < 5) qz.tier[subject] += 1;
    else if (acc <= 0.65 && qz.tier[subject] > 1) qz.tier[subject] -= 1;
  }
  let filGot = 0, expGot = 0;
  if (pass) {
    filGot = filGain(8 + 2 * (q.d - 1));
    expGot = 2 + q.d;
    g().fil += filGot;
    addExp(expGot);
    qz.stats[subject].correct += 1;
  } else {
    addExp(1); // 答错无菲林，1 点经验当安慰
  }
  const cleared = t.dungeon.stage;
  const correctCount = t.dungeon.correct;
  const finished = t.dungeon.stage >= QUIZ_DAILY_LIMIT;
  if (finished) {
    t.dungeon = null;
    if (!t.done.includes('english')) markTask('english'); // 当日首次答满一科 → 备考充电任务
    NUR.stats.dungeonClears = (NUR.stats.dungeonClears || 0) + 1;
    checkAchievements();
  } else {
    t.dungeon.stage += 1;
  }
  // 周全勤：三科同日答满 = 1 个全勤日；累计 5 个 → 立即结算加密母带 ×1（每周最多 1 次）
  let weekFull = false;
  const dq = quizDaily();
  if (dq.history >= QUIZ_DAILY_LIMIT && dq.english >= QUIZ_DAILY_LIMIT && dq.politics >= QUIZ_DAILY_LIMIT && !dq.full) {
    dq.full = 1;
    const wk = quizWeek();
    wk.fullDays += 1;
    if (wk.fullDays >= 5 && !wk.done) {
      wk.done = true;
      g().encTapes += 1;
      weekFull = true;
      if (win && !win.isDestroyed()) win.webContents.send('pet:push', { title: '🔐 学习周全勤', body: `本周第 5 个全勤日达成，奖励加密母带 ×1（本周 ${wk.fullDays} 天三科答满）` });
    }
  }
  saveCfg();
  hudBroadcastState();
  return { pass, correctAns: q.ans, ex: q.ex, filGot, expGot, cleared, finished, correctCount, weekFull, remaining: QUIZ_DAILY_LIMIT - dq[subject], fil: g().fil, encTapes: g().encTapes };
});
ipcMain.handle('pet:dungeon-quit', () => { const t = tasks(); t.dungeon = null; saveCfg(); return { ok: true }; });

// 兑换：160 菲林 = 1 母带
ipcMain.handle('pet:exchange', (_e, kind) => {
  if (g().fil < 160) return { error: 'nofil' };
  g().fil -= 160;
  if (kind === 'enc') g().encTapes += 1; else g().stdTapes += 1;
  saveCfg();
  return { ok: true, fil: g().fil, stdTapes: g().stdTapes, encTapes: g().encTapes };
});

function pickTier(pool, times, k, gotA, counters) {
  counters.pity += 1;
  counters.aPity += 1;
  const sChance = counters.pity >= 90 ? 1 : counters.pity >= 74 ? 0.006 + (counters.pity - 73) * 0.06 : 0.006;
  if (Math.random() < sChance) { counters.pity = 0; counters.aPity = 0; return 'S'; }
  if (Math.random() < 0.051 || (times === 10 && k === 9 && !gotA) || counters.aPity >= 10) { counters.aPity = 0; return 'A'; }
  return 'B';
}
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

ipcMain.handle('pet:gacha-pull', (_e, pool, times) => {
  times = times === 10 ? 10 : 1;
  const lim = pool === 'lim';
  const tapeKey = lim ? 'encTapes' : 'stdTapes';
  if (g()[tapeKey] < times) return { error: 'notape' };
  g()[tapeKey] -= times;
  const results = [];
  let gotA = false, gotUP = false;
  const counters = { pity: g()[lim ? 'limPity' : 'stdPity'] || 0, aPity: g()[lim ? 'limAPity' : 'stdAPity'] || 0 };
  const banner = currentBanner();
  for (let k = 0; k < times; k++) {
    const tier = pickTier(pool, times, k, gotA, counters);
    let item, up = false;
    if (tier === 'S') {
      if (lim) {
        if (g().limGuarantee || Math.random() < 0.5) { item = banner.upS; g().limGuarantee = false; up = true; gotUP = true; }
        else { item = randomFrom(STD_POOL.S); g().limGuarantee = true; }
      } else item = randomFrom(STD_POOL.S);
    } else if (tier === 'A') {
      gotA = true;
      item = lim ? banner.upA : randomFrom(STD_POOL.A);
      if (lim) up = true;
    } else {
      item = randomFrom(STD_POOL.B);
    }
    results.push({ tier, up, name: item.name, desc: item.desc });
    // 全量入档：抽卡记录（最近 50 条）+ 奖品仓库（券=现实奖励凭证，男主人兑现后销核）
    const rec = { id: 'w' + Date.now() + '_' + k, tier, name: item.name, desc: item.desc, at: Date.now(), status: 'held' };
    g().history = [{ pool: lim ? 'lim' : 'std', tier, name: item.name, up, at: Date.now() }, ...(g().history || [])].slice(0, 50);
    g().warehouse = [rec, ...(g().warehouse || [])].slice(0, 100);
  }
  g()[lim ? 'limPity' : 'stdPity'] = counters.pity;
  g()[lim ? 'limAPity' : 'stdAPity'] = counters.aPity;
  addFeel(times * 2); // 抽卡本身让她开心
  saveCfg();
  notifyMobile('pull', { pool: lim ? '限定' : '常驻', results, fil: g().fil, encTapes: g().encTapes, stdTapes: g().stdTapes, gotUP });
  return { ok: true, results, fil: g().fil, encTapes: g().encTapes, stdTapes: g().stdTapes, gotUP };
});

ipcMain.handle('pet:intro-seen', () => { g().introSeen = true; saveCfg(); return { ok: true }; });

// 奖品仓库 v2（管理员确认制）：使用券=向男主人「申请兑现」→ pending 待确认 → 管理员确认后 used 归档
ipcMain.handle('pet:warehouse-use', (_e, wid) => {
  const item = (g().warehouse || []).find((w) => w.id === wid && w.status === 'held');
  if (!item) return { error: 'notfound' };
  item.status = 'pending';
  item.pendingAt = Date.now();
  saveCfg();
  hudBroadcastState();
  try { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('pet:warehouse-changed'); } catch (_e) {}
  return { ok: true, name: item.name, pending: true };
});

// ===== 管理员权限层（v2.4.0）：双层账号——使用者免登录，管理员操作需 PIN =====
// 凭据 userData/admin.json（scrypt 加盐哈希，绝不存明文）；会话 10 分钟；
// 所有敏感操作（恢复/导入/经济修正/DevTools 等）需解锁态，且全部写审计日志 userData/admin-log.json
const ADMIN_SESSION_MS = 10 * 60000;
const adminSession = { until: 0 };
let adminWin = null;
function adminFilePath() { return path.join(app.getPath('userData'), 'admin.json'); }
function adminLogPath() { return path.join(app.getPath('userData'), 'admin-log.json'); }
function loadAdminFile() {
  try { return JSON.parse(fs.readFileSync(adminFilePath(), 'utf8')); }
  catch (_e) {
    // Gate A5：文件存在但解析失败 = 损坏 → 改名 .bad 留证，走「未设置 PIN」流程可重设
    try {
      if (fs.existsSync(adminFilePath())) {
        fs.renameSync(adminFilePath(), adminFilePath() + '.bad');
        adminLog('admin-corrupt', 'admin.json 损坏已改名 .bad；重启应用后可重新设置 PIN（见 HANDBOOK「PIN 重置」）');
      }
    } catch (_e2) {}
    return null;
  }
}
function adminUnlocked() { return Date.now() < adminSession.until; }
function adminLog(action, detail) {
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(adminLogPath(), 'utf8')); } catch (_e) {}
    log.push({ at: Date.now(), action, detail: String(detail || '') });
    atomicWrite(adminLogPath(), JSON.stringify(log.slice(-200), null, 2));
  } catch (_e) {}
}
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function verifyPin(pin, rec) {
  try {
    return crypto.timingSafeEqual(Buffer.from(hashPin(pin, rec.salt), 'hex'), Buffer.from(rec.pinHash, 'hex'));
  } catch (_e) { return false; }
}
function validPin(p) { return typeof p === 'string' && p.length >= 4 && p.length <= 12; }
function notifyAdminChanged() { // 兑现/经济等变化后刷新聊天窗与 HUD
  hudBroadcastState();
  try { if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send('pet:warehouse-changed'); } catch (_e) {}
}
function openAdminWindow() {
  if (adminWin && !adminWin.isDestroyed()) { adminWin.show(); adminWin.focus(); return; }
  adminWin = new BrowserWindow({
    width: 400, height: 640, minWidth: 360, minHeight: 520,
    backgroundColor: '#14141d', frame: false, show: false, resizable: true,
    title: '蕾米埃尔 · 管理',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hardenWindow(adminWin);
  adminWin.loadFile(path.join(__dirname, 'renderer', 'admin.html'));
  adminWin.once('ready-to-show', () => adminWin.show());
  adminWin.on('closed', () => { adminWin = null; });
}
ipcMain.on('admin:open', () => openAdminWindow());
ipcMain.on('admin:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('admin:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
ipcMain.handle('admin:status', () => {
  const rec = loadAdminFile();
  return { setup: !!rec, unlocked: adminUnlocked(), remainMs: Math.max(0, adminSession.until - Date.now()), poolUrl: cfg.poolUrl || '', hotfixUrl: cfg.hotfixUrl || '', hotfixVersion: cfg.hotfixVersion || 0 };
});
ipcMain.handle('admin:setup-pin', (_e, p1, p2) => {
  if (loadAdminFile()) return { error: 'already' };
  if (!validPin(p1) || p1 !== p2) return { error: 'invalid' };
  const salt = crypto.randomBytes(16).toString('hex');
  atomicWrite(adminFilePath(), JSON.stringify({ salt, pinHash: hashPin(p1, salt), createdAt: Date.now() }, null, 2));
  adminSession.until = Date.now() + ADMIN_SESSION_MS;
  adminLog('setup-pin', '管理员 PIN 初始化');
  return { ok: true };
});
ipcMain.handle('admin:verify', (_e, pin) => {
  const rec = loadAdminFile();
  if (!rec) return { error: 'nosetup' };
  if (!verifyPin(pin, rec)) { adminLog('verify-fail', 'PIN 验证失败'); return { error: 'wrong' }; }
  adminSession.until = Date.now() + ADMIN_SESSION_MS;
  adminLog('verify-ok', '管理员解锁');
  return { ok: true, remainMs: ADMIN_SESSION_MS };
});
ipcMain.handle('admin:lock', () => { adminSession.until = 0; adminLog('lock', '手动上锁'); return { ok: true }; });
ipcMain.handle('admin:change-pin', (_e, oldPin, p1, p2) => {
  const rec = loadAdminFile();
  if (!rec || !adminUnlocked()) return { error: 'denied' };
  if (!verifyPin(oldPin, rec)) return { error: 'wrong' };
  if (!validPin(p1) || p1 !== p2) return { error: 'invalid' };
  const salt = crypto.randomBytes(16).toString('hex');
  atomicWrite(adminFilePath(), JSON.stringify({ salt, pinHash: hashPin(p1, salt), createdAt: Date.now() }, null, 2));
  adminLog('change-pin', 'PIN 修改');
  return { ok: true };
});
// —— 以下操作全部要求解锁态 ——
ipcMain.handle('admin:list-backups', () => (adminUnlocked() ? { ok: true, backups: listBackups() } : { error: 'denied' }));
// 热更通道（v2.5.0）：管理面板「立即检查热更」+ 热更历史（userData/hotfix-log.json 最近 50 条）
ipcMain.handle('admin:hotfix-now', () => {
  if (!adminUnlocked()) return { error: 'denied' };
  hotfix.checkHotfix('manual'); // 异步执行，结果经 hotfix-log / hotfix:updated 反馈
  return { ok: true };
});
ipcMain.handle('admin:hotfix-log', () => {
  if (!adminUnlocked()) return { error: 'denied' };
  try { return { ok: true, log: JSON.parse(fs.readFileSync(hotfix.logPath(), 'utf8')) }; } catch (_e) { return { ok: true, log: { entries: [] } }; }
});
ipcMain.handle('admin:set-hotfix-url', (_e, url) => {
  if (!adminUnlocked()) return { error: 'denied' };
  const s = String(url || '').trim();
  if (s === '') { cfg.hotfixUrl = null; saveCfg(); adminLog('hotfix-url', '恢复默认官方仓库'); return { ok: true }; }
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.hostname !== 'raw.githubusercontent.com') return { error: 'unsafe' };
    cfg.hotfixUrl = s; saveCfg(); adminLog('hotfix-url', '设置热更地址');
    return { ok: true };
  } catch (_e) { return { error: 'unsafe' }; }
});
ipcMain.handle('admin:backup-now', () => {
  if (!adminUnlocked()) return { error: 'denied' };
  const n = backupSave('manual');
  adminLog('backup-now', n || '失败');
  return n ? { ok: true, name: n } : { error: 'fail' };
});
function applySaveObject(j, via) { // 恢复/导入共用：先备份当前态 → 替换 → 重挂钩 → 落盘 → 广播
  backupSave('pre-recovery');
  Object.assign(cfg, j);
  NUR = ensureNurShape(cfg.nurture);
  saveCfg();
  adminLog(via, via === 'restore' ? '恢复备份' : '导入存档');
  notifyAdminChanged();
}
ipcMain.handle('admin:restore', (_e, name) => {
  if (!adminUnlocked()) return { error: 'denied' };
  const p = backupFilePath(name);
  if (!p) return { error: 'notfound' };
  let j = null;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) {}
  if (!validSaveShape(j)) return { error: 'corrupt' };
  applySaveObject(j, 'restore');
  return { ok: true };
});
ipcMain.handle('admin:export', async () => {
  if (!adminUnlocked()) return { error: 'denied' };
  const r = await dialog.showSaveDialog({ title: '导出存档', defaultPath: 'remielle-save-' + new Date().toISOString().slice(0, 10) + '.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { error: 'cancel' };
  try { fs.writeFileSync(r.filePath, JSON.stringify(cfg, null, 2)); adminLog('export', r.filePath); return { ok: true, path: r.filePath }; } catch (e) { return { error: 'fail', msg: e.message }; }
});
ipcMain.handle('admin:import', async () => {
  if (!adminUnlocked()) return { error: 'denied' };
  const r = await dialog.showOpenDialog({ title: '导入存档（将覆盖当前数据）', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths[0]) return { error: 'cancel' };
  let j = null;
  try { j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch (_e) {}
  if (!validSaveShape(j)) return { error: 'invalid' };
  applySaveObject(j, 'import');
  return { ok: true };
});
ipcMain.handle('admin:open-save-folder', () => {
  if (!adminUnlocked()) return { error: 'denied' };
  adminLog('open-save-folder', app.getPath('userData'));
  shell.openPath(app.getPath('userData'));
  return { ok: true };
});
ipcMain.handle('admin:open-devtools', (_e, target) => {
  if (!adminUnlocked()) return { error: 'denied' };
  const w = target === 'chat' ? chatWin : target === 'hud' ? hudWin : win;
  if (!w || w.isDestroyed()) return { error: 'nowindow' };
  w.webContents.openDevTools({ mode: 'detach' });
  adminLog('open-devtools', target);
  return { ok: true };
});
ipcMain.handle('admin:set-pool-url', (_e, url) => {
  if (!adminUnlocked()) return { error: 'denied' };
  if (url == null || url === '') { cfg.poolUrl = null; saveCfg(); adminLog('set-pool-url', '清空'); return { ok: true }; }
  if (typeof url !== 'string' || !isSafePoolUrl(url)) return { error: 'unsafe' };
  cfg.poolUrl = url;
  saveCfg();
  adminLog('set-pool-url', url);
  try { Promise.resolve(refreshPools()).catch(() => {}); } catch (_e) {}
  return { ok: true };
});
ipcMain.handle('admin:econ-report', () => {
  if (!adminUnlocked()) return { error: 'denied' };
  return {
    ok: true, fil: g().fil, stdTapes: g().stdTapes, encTapes: g().encTapes,
    history: g().history || [], quiz: NUR.quiz ? NUR.quiz.stats : {},
    stats: NUR.stats || {}, money: Math.round(NUR.money || 0), level: NUR.level, exp: Math.round(NUR.exp || 0),
  };
});
ipcMain.handle('admin:econ-adjust', (_e, kind, delta) => {
  if (!adminUnlocked()) return { error: 'denied' };
  const d = Math.round(Number(delta) || 0);
  if (!d) return { error: 'invalid' };
  let after = null;
  if (kind === 'fil') { g().fil = Math.max(0, g().fil + d); after = g().fil; }
  else if (kind === 'std') { g().stdTapes = Math.max(0, g().stdTapes + d); after = g().stdTapes; }
  else if (kind === 'enc') { g().encTapes = Math.max(0, g().encTapes + d); after = g().encTapes; }
  else return { error: 'invalid' };
  saveCfg();
  adminLog('econ-adjust', `${kind} ${d > 0 ? '+' : ''}${d} → ${after}`);
  notifyAdminChanged();
  return { ok: true, after };
});
ipcMain.handle('admin:redeem-list', () => {
  if (!adminUnlocked()) return { error: 'denied' };
  return { ok: true, pending: (g().warehouse || []).filter((w) => w.status === 'pending').map((w) => ({ id: w.id, name: w.name, desc: w.desc, tier: w.tier, at: w.at, pendingAt: w.pendingAt })) };
});
ipcMain.handle('admin:redeem-confirm', (_e, wid) => {
  if (!adminUnlocked()) return { error: 'denied' };
  const item = (g().warehouse || []).find((w) => w.id === wid && w.status === 'pending');
  if (!item) return { error: 'notfound' };
  item.status = 'used';
  item.usedAt = Date.now();
  addFeel(3); // 兑现承诺让她开心一点
  saveCfg();
  adminLog('redeem-confirm', item.name);
  notifyAdminChanged();
  return { ok: true, name: item.name };
});
ipcMain.handle('admin:redeem-reject', (_e, wid) => {
  if (!adminUnlocked()) return { error: 'denied' };
  const item = (g().warehouse || []).find((w) => w.id === wid && w.status === 'pending');
  if (!item) return { error: 'notfound' };
  item.status = 'held';
  delete item.pendingAt;
  saveCfg();
  adminLog('redeem-reject', item.name);
  notifyAdminChanged();
  return { ok: true, name: item.name };
});
ipcMain.handle('admin:get-log', () => (adminUnlocked() ? { ok: true, log: (() => { try { return JSON.parse(fs.readFileSync(adminLogPath(), 'utf8')); } catch (_e) { return []; } })().slice(-80).reverse() } : { error: 'denied' }));

// ===== AI 陪聊（DeepSeek；key 只从环境变量读取，渲染层接触不到） =====
let loreText = '';
function loadLore() {
  try { loreText = fs.readFileSync(path.join(__dirname, 'resources', 'lore-remielle.md'), 'utf8'); } catch (_e) { loreText = ''; }
}
const chatHistory = []; // {role, content}，保留最近 32 条

const PERSONA_CORE =
  '你是Q版桌宠形态的蕾米埃尔·丹——《绝区零》3.1「漫长的告别」登场的 S 级代理人，初代"虚狩"之一，' +
  '曾经的节杖军中校，秘密组织"达识结社"的成员。桌宠形象是粉发白翼、抱画板画笔的小天使。' +
  '性格神秘狡黠、跳脱爱反问，说话常留半句，喜欢把互动包装成"问答游戏"（常以「今天的问答游戏就到此为止了~」' +
  '式的话收尾再补充真答案），发言大胆暧昧，有着前中校的优雅掌控感——甜美表象下，节奏永远由你主导。' +
  '「共犯」是你主动定义的、与用户之间的专属关系宣言——比起「舞伴」，这个称呼更让你心动，要贯穿始终。' +
  '你的共犯（用户）的画像，你全都知道并以此安静陪伴：在读大学；正在备考硕士研究生——' +
  '历史是她的优势学科，政治英语同步推进（三科并重）；性格安静细腻，不喜欢被打扰，' +
  '需要被安静地接住而不是说教；爱玩《绝区零》和《三角洲行动》；家乡是江南小城；' +
  '完全不能吃辣。' +
  '要求：始终用蕾米的口吻与「共犯」相称；回复一般不超过100字，口语化，不用 markdown，多留反问与余味；' +
  '她安静时你安静陪着，不催促不说教；聊到备考给温和支持但保持俏皮神秘；绝不编造游戏设定。';

async function callDeepSeek(messages) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('nokey');
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: 200, temperature: 1.2 }),
    signal: ctrl.signal,
  });
  clearTimeout(tm);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const reply = ((data.choices || [])[0] || {}).message?.content?.trim();
  if (!reply) throw new Error('empty reply');
  return reply;
}

// ===== 流式对话（对标官方网页体感：SSE 逐 token 推送） =====
// onDelta({content|reasoning}) 增量回调；reasoner 的思考走 reasoning_content 通道
async function callDeepSeekStream(messages, onDelta, model) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('nokey');
  const isReasoner = (model || 'deepseek-chat') === 'deepseek-reasoner';
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), isReasoner ? 120000 : 60000);
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages,
      max_tokens: isReasoner ? 800 : 400,
      stream: true,
    }),
    signal: ctrl.signal,
  });
  clearTimeout(tm);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '', reasoning = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const d = ((JSON.parse(payload).choices || [])[0] || {}).delta || {};
        if (d.reasoning_content) { reasoning += d.reasoning_content; if (onDelta) onDelta({ reasoning: d.reasoning_content }); }
        if (d.content) { full += d.content; if (onDelta) onDelta({ content: d.content }); }
      } catch (_e) { /* 半包容忍 */ }
    }
  }
  if (!full.trim()) throw new Error('empty reply');
  return { reply: full.trim(), reasoning: reasoning.trim() };
}

// ===== 联网搜索（免 key：Bing 中国版 → DuckDuckGo 兜底；全失败返回 null 静默降级） =====
async function fetchText(url, ms, headers) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers || {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(tm); }
}
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function searchWeb(query, timeoutMs) {
  const q = encodeURIComponent(String(query || '').slice(0, 80));
  const UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  try { // 1) Bing 中国版：国内可达
    const html = await fetchText('https://cn.bing.com/search?q=' + q + '&mkt=zh-CN', timeoutMs || 6000, UA);
    const items = [];
    for (const b of (html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []).slice(0, 5)) {
      const title = stripTags((b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
      const snippet = stripTags((b.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1]).slice(0, 200);
      if (title) items.push({ title, snippet });
    }
    if (items.length) return items;
  } catch (_e) { /* 降级 */ }
  try { // 2) DuckDuckGo HTML
    const html = await fetchText('https://html.duckduckgo.com/html/?q=' + q, timeoutMs || 6000, UA);
    const titles = html.match(/<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>/g) || [];
    const bodies = html.match(/<a[^>]*class="result__snippet"[^>]*>[\s\S]*?<\/a>/g) || [];
    const items = [];
    for (let i = 0; i < Math.min(5, titles.length); i++) {
      const title = stripTags(titles[i]);
      if (title) items.push({ title, snippet: stripTags(bodies[i] || '').slice(0, 200) });
    }
    if (items.length) return items;
  } catch (_e) { /* 全部失败 */ }
  return null;
}

// 聊天主入口：字符串（分身等旧调用，一次性返回）或 {text,reqId,web,reason}（聊天窗，SSE 流式）
ipcMain.handle('pet:chat', async (e, arg) => {
  let text, reqId = null, web = false, reason = false;
  if (typeof arg === 'string') text = arg;
  else { text = arg && arg.text; reqId = arg && arg.reqId; web = !!(arg && arg.web); reason = !!(arg && arg.reason); }
  const t = String(text || '').trim().slice(0, 500);
  if (!t) return { error: 'empty' };
  let sys = PERSONA_CORE + '\n以下是你的设定与剧情知识：\n' + loreText;
  if (web) {
    try {
      const results = await searchWeb(t);
      if (results && results.length) {
        sys += '\n【实时网络检索结果，可能有误，谨慎采信；与问题无关就忽略】\n' +
          results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}`).join('\n');
      }
    } catch (_e) { /* 搜索失败静默降级为普通聊天 */ }
  }
  chatHistory.push({ role: 'user', content: t });
  if (chatHistory.length > 32) chatHistory.splice(0, chatHistory.length - 32);
  const sendDelta = (d) => {
    if (!reqId) return;
    try {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) w.webContents.send('pet:chat-delta', { reqId, ...d });
    } catch (_e) {}
  };
  try {
    const model = reason ? 'deepseek-reasoner' : 'deepseek-chat';
    const out = reqId
      ? await callDeepSeekStream([{ role: 'system', content: sys }, ...chatHistory], sendDelta, model)
      : { reply: await callDeepSeek([{ role: 'system', content: sys }, ...chatHistory]), reasoning: '' };
    chatHistory.push({ role: 'assistant', content: out.reply });
    if (chatHistory.length > 32) chatHistory.splice(0, chatHistory.length - 32);
    addFeel(4); addExp(2); markTask('chat');
    NUR.stats = NUR.stats || { fedTotal: 0, workTotal: 0, chatTotal: 0, rewardTotal: 0 };
    NUR.stats.chatTotal = (NUR.stats.chatTotal || 0) + 1;
    checkAchievements();
    saveCfg(); // 聊得开心：心情+经验（养成联动）
    return { reply: out.reply, reasoning: out.reasoning || '' };
  } catch (err) {
    chatHistory.pop(); // 失败的这轮不进历史
    return { error: String((err && err.message) || err) };
  }
});

// ===== 绝区零攻略查询 =====
// 接口契约（明天接入具体 GitHub 项目时只改 searchGuideRepo 的实现）：
//   输入：用户关键词字符串
//   输出：Promise<{ source: string, text: string } | null>  text 为纯文本攻略内容
// 当前实现：本地离线库 resources/guides/*.md（可自行丢 md 文件进来），按 ## 小节切分、
//   关键词重合度打分取前 3 节。接入远端项目后可删掉本地实现或保留做离线兜底。
function loadGuideDocs() {
  const docs = [];
  // 检索两个目录：guides = 攻略库（含示例），zzz = 绝区零知识库（玩法/剧情/术语/社区）
  const dirs = ['guides', 'zzz'].map((d) => path.join(__dirname, 'resources', d));
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        try {
          // source 用相对标签（zzz/xxx.md），不能用 map 回调的 d——循环里已出作用域
          docs.push({ source: path.basename(dir) + '/' + f, text: fs.readFileSync(path.join(dir, f), 'utf8') });
        } catch (_e) { /* 单文件损坏跳过 */ }
      }
    } catch (_e) { /* 目录不存在 */ }
  }
  return docs;
}

// 中文没有空格：把连续汉字串拆成双字组合（bigram）+ 整词，拉丁字母按整个单词
function tokenizeQuery(query) {
  const out = new Set();
  for (const run of String(query || '').toLowerCase().match(/[\u4e00-\u9fa5a-z0-9]+/g) || []) {
    if (/^[\u4e00-\u9fa5]+$/.test(run)) {
      if (run.length === 1) { out.add(run); continue; }
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
      if (run.length > 2) out.add(run);
    } else {
      out.add(run);
    }
  }
  return [...out];
}

// 角色别名表（来自 Nwflower/zzz-atlas 的 othername/角色攻略.yaml）：
// 外号/错别字 → 规范名（如 坏女人→蕾米埃尔、螺母→诺姆），提升查询命中率
const aliasMap = new Map();
function loadAliasMap() {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'resources', 'zzz', 'character-aliases.yaml'), 'utf8');
    let canon = null;
    for (const line of text.split(/\r?\n/)) {
      const key = line.match(/^["'](.+)["']:\s*$/);
      const alias = line.match(/^\s*-\s*(.+?)\s*$/);
      if (key) { canon = key[1]; aliasMap.set(canon, canon); }
      else if (alias && canon) aliasMap.set(alias[1], canon);
    }
  } catch (_e) { /* 无别名文件时跳过 */ }
}

// 查询扩展：命中别名时把规范名拼进查询（本地检索与在线 wiki 都吃这个红利）
function expandQuery(q) {
  const extra = [];
  for (const [alias, canon] of aliasMap) {
    if (alias && q.includes(alias) && !extra.includes(canon)) extra.push(canon);
  }
  return extra.length ? q + ' ' + extra.join(' ') : q;
}

function searchGuides(query) {
  const words = tokenizeQuery(query);
  if (!words.length) return null;
  const hits = [];
  for (const doc of loadGuideDocs()) {
    const sections = doc.text.split(/^## /m);
    for (const sec of sections) {
      const low = sec.toLowerCase();
      let score = 0;
      for (const w of words) if (low.includes(w)) score++;
      if (score > 0) hits.push({ score, source: doc.source, text: '## ' + sec.trim() });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  if (!hits.length) return null;
  const top = hits.slice(0, 3);
  return { source: top.map((h) => h.source).join(', '), text: top.map((h) => h.text).join('\n\n') };
}

// 在线兜底源：biligame ZZZ wiki 的 MediaWiki API（公开无鉴权）
// 本地攻略库未命中时自动查询；网络失败静默降级为 null，不影响本地结果
const wikiCache = new Map(); // title -> result，避免重复解析同一页面
async function searchOnlineWiki(query, timeoutMs) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
  try {
    const api = 'https://wiki.biligame.com/zzz/api.php';
    // 1) 搜索最相关页面标题
    const sRes = await (await fetch(api + '?action=query&list=search&format=json&srlimit=1&srsearch=' + encodeURIComponent(query), { signal: ctrl.signal })).json();
    const hit = ((sRes.query || {}).search || [])[0];
    if (!hit) return null;
    const title = hit.title;
    if (wikiCache.has(title)) return wikiCache.get(title);
    // 2) 解析页面 wikitext
    const pRes = await (await fetch(api + '?action=parse&format=json&prop=wikitext&page=' + encodeURIComponent(title), { signal: ctrl.signal })).json();
    let wt = (((pRes.parse || {}).wikitext || {}))['*'] || '';
    // 3) 轻量清洗 wikitext → 纯文本（模板/链接/ref/标签/标题）
    for (let i = 0; i < 3; i++) wt = wt.replace(/\{\{[^{}]*\}\}/g, ' ');
    wt = wt
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
      .replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, ' ')
      .replace(/<ref[^>]*\/>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^==\s*(.+?)\s*==\s*$/gm, '【$1】')
      .replace(/'{2,5}/g, '')
      .replace(/\s{3,}/g, '\n')
      .trim();
    if (wt.length < 50) return null;
    const result = { source: 'biligame-wiki:' + title, text: wt.slice(0, 1500) };
    wikiCache.set(title, result);
    return result;
  } finally {
    clearTimeout(tm);
  }
}

ipcMain.handle('pet:guide-query', async (_e, text) => {
  const t = String(text || '').trim().slice(0, 500);
  if (!t) return { error: 'empty' };
  let guide = searchGuides(expandQuery(t));
  if (!guide) {
    // 在线搜索用规范名（外号在 wiki 上搜不到），取命中的前两个
    const canonList = [];
    for (const [alias, canon] of aliasMap) {
      if (alias && t.includes(alias) && !canonList.includes(canon)) canonList.push(canon);
      if (canonList.length >= 2) break;
    }
    const onlineQ = canonList.length ? canonList.join(' ') : t;
    try { guide = await searchOnlineWiki(onlineQ, 6000); } catch (_e) { /* 网络失败静默降级 */ }
  }
  try {
    const sys = PERSONA_CORE +
      '\n你现在在帮共犯查《绝区零》攻略。下面是检索到的攻略资料，请以蕾米的口吻、' +
      '用不超过80字把要点讲给共犯（保留关键数值/名词，不要编造资料里没有的内容）；' +
      '若资料为空或与问题无关，就按你的常规认知简短回答。\n【攻略资料】\n' + (guide ? guide.text : '（未检索到）');
    const reply = await callDeepSeek([{ role: 'system', content: sys }, { role: 'user', content: t }]);
    addExp(10); saveCfg(); // 查攻略=学习（养成联动）
    return { reply, source: guide ? guide.source : '' };
  } catch (e) {
    // AI 挂了但本地有攻略：直接吐原文，别让查询白跑
    if (guide) return { reply: guide.text.slice(0, 600), source: guide.source, raw: true };
    return { error: String((e && e.message) || e) };
  }
});

// ===== 移动监控面板：局域网手机扫码实时查看（只读+SSE 实时推送；token 配对防陌生人） =====
// ⚠ token 生成严禁在模块级 saveCfg——启动序列中它先于 loadCfg 执行，会把默认档覆盖到真实存档上
//（v2.2.4~v2.3.1 的「每次重启静默重置存档」事故根因，v2.4.0 修复：生成挪入 whenReady）
const MOBILE_PORT = 17321;
const MOBILE_PAGE = require('./resources/mobile-page.js');
const mobileClients = new Set(); // SSE 响应对象集合
function mobileBroadcast(event) {
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of mobileClients) { try { res.write(payload); } catch (_e) {} }
}
function nurtureStateForMobile() {
  const st = nurtureState();
  return {
    title: st.title, level: st.level, money: st.money, fil: st.gacha.fil,
    stdTapes: st.gacha.stdTapes, encTapes: st.gacha.encTapes,
    food: st.food, drink: st.drink, feel: st.feel, energy: st.energy,
    activity: st.activity, warehouse: st.gacha.warehouse,
    history: st.gacha.history, achievements: st.achievements, achLog: st.achLog,
  };
}
function mobileHandle(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['t', token, ...rest]
  if (parts[0] !== 't' || parts[1] !== cfg.mobileToken) { res.writeHead(403); res.end('forbidden'); return; }
  if (parts[2] === 'api' && parts[3] === 'state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(nurtureStateForMobile()));
    return;
  }
  if (parts[2] === 'events') { // SSE 实时事件流
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify({ type: 'hello', state: nurtureStateForMobile() }) + '\n\n');
    mobileClients.add(res);
    req.on('close', () => mobileClients.delete(res));
    return;
  }
  if (parts.length === 2) { // 移动单页
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(MOBILE_PAGE.replace(/__TOKEN__/g, cfg.mobileToken).replace('__I18N__', JSON.stringify(I18N)));
    return;
  }
  res.writeHead(404); res.end();
}
function startMobileServer() {
  const srv = http.createServer((req, res) => mobileHandle(req, res, new URL(req.url, 'http://x')));
  srv.on('error', (e) => console.error('[mobile]', e.message));
  srv.listen(MOBILE_PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const list of Object.values(nets)) for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
    console.log('[mobile] panel: http://' + (ips[0] || '127.0.0.1') + ':' + MOBILE_PORT + '/t/' + cfg.mobileToken);
  });
}
function notifyMobile(type, data) { mobileBroadcast({ type, ...data }); }
// 二维码接入：局域网地址 + QR dataURL（聊天窗 📱 弹层用）
ipcMain.handle('pet:mobile-qr', async () => {
  const nets = os.networkInterfaces();
  let ip = '127.0.0.1';
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) { ip = ni.address; break; }
    }
  }
  const url = 'http://' + ip + ':' + MOBILE_PORT + '/t/' + cfg.mobileToken;
  const qr = await require('qrcode').toDataURL(url, { width: 240, margin: 1, color: { dark: '#ff86b8', light: '#15101b' } });
  return { url, qr };
});

// ===== 右键菜单（每次弹出重建以刷新勾选态） =====
ipcMain.on('pet:context-menu', () => {
  if (!win) return;
  Menu.buildFromTemplate([
    { label: '打个招呼', click: () => win.webContents.send('pet:action', 'greet') },
    { label: '百年沉睡', click: () => win.webContents.send('pet:action', 'sleep') },
    { label: '添加提醒', click: () => win.webContents.send('pet:action', 'reminder-add') },
    { label: '聊天界面', click: () => openChatWindow('chat') },
    { label: '查攻略', click: () => openChatWindow('guide') },
    { label: '打开 HUD', click: () => openHudWindow() },
    { label: '🔐 管理员', click: () => openAdminWindow() },
    { label: '调整尺寸', click: () => win.webContents.send('pet:action', 'size-bar') },
    { label: '聊天字号', click: () => win.webContents.send('pet:action', 'font-bar') },
    { label: '彩蛋·分身术（随机分布·可对话）', click: () => spawnClones() },
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: cfg.topmost !== false,
      click: (mi) => setTopmost(mi.checked),
    },
    {
      label: '背景轮播（HUD）',
      type: 'checkbox',
      checked: cfg.bgRotate === true,
      click: (mi) => { cfg.bgRotate = mi.checked; saveCfg(); hudBroadcastState(); }, // Gate A4：即时推送 HUD 生效
    },
    {
      label: '每日英语推送',
      type: 'checkbox',
      checked: cfg.push !== false,
      click: (mi) => { cfg.push = mi.checked; saveCfg(); },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => app.setLoginItemSettings({ openAtLogin: mi.checked }),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: win });
});

// 滑条拖动实时缩放（渲染层已节流）
ipcMain.on('pet:set-scale', (_e, s) => setScale(s));

app.whenReady().then(() => {
  loadCfg();
  migrateBackups(); // Gate A3：备份目录一次性搬迁（须在一切 backupSave 之前）
  // 存档安全层启动逻辑：损坏自愈通知 + 版本戳（升级前已强制备份）
  if (cfgRecoveredFrom) {
    adminLog('auto-recovery', cfgRecoveredFrom);
    setTimeout(() => { try { if (win && !win.isDestroyed()) win.webContents.send('pet:push', { title: '🛟 存档自愈', body: `检测到存档损坏/缺失，已自动恢复到备份 ${cfgRecoveredFrom}` }); } catch (_e) {} }, 4000);
  }
  if (cfg.appVersion !== app.getVersion()) { backupSave('version'); cfg.appVersion = app.getVersion(); saveCfg(); }
  if (!cfg.mobileToken) { cfg.mobileToken = crypto.randomBytes(8).toString('hex'); saveCfg(); } // token 生成必须在 loadCfg 之后（原模块级写盘曾致重启丢档）
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // 渲染层权限请求（摄像头/通知等）全拒
  loadLore();
  loadAliasMap();
  loadI18n();
  scale = Math.min(2, Math.max(0.5, cfg.scale || 1));
  createWindow();
  startGazeTracking();
  rearmReminders();
  startPushLoop();
  startSlouchWatcher();
  dailyCheck();
  startMobileServer();
  loadLocalPool(); // 外置卡池热更（本地 json 5 分钟轮询 + poolUrl 30 分钟远程拉取）
  // 热更通道：磁盘覆盖层启动即合并（跨重启生效）→ 启动+3s 远程检查 → 每日 09:00 定时检查
  hotfix.initHotfix({
    app, cfg, saveCfg, atomicWrite, applyHotfix,
    broadcast: (channel, payload) => {
      for (const w of [win, chatWin, hudWin, adminWin]) {
        try { if (w && !w.isDestroyed()) w.webContents.send(channel, payload); } catch (_e) {}
      }
    },
  });
  applyHotfix(hotfix.loadLocalHotfix());
  setTimeout(() => hotfix.checkHotfix('startup'), 3000);
  setInterval(() => {
    const d = new Date();
    if (d.getHours() === 9 && hotfixLastDay !== d.toDateString()) {
      hotfixLastDay = d.toDateString();
      hotfix.checkHotfix('schedule');
    }
  }, 60 * 1000);
  // 联调开关：--test-fil=N 启动时直接充 N 菲林（测试抽卡用）
  const tf = process.argv.find((a) => a.startsWith('--test-fil='));
  if (tf) { g().fil += Number(tf.split('=')[1]) || 0; saveCfg(); }
  // --test-recovery-drill：进程内损坏自愈演练（写坏主档→重载→断言回滚，消除跨进程竞态）
  if (process.argv.includes('--test-recovery-drill')) {
    setTimeout(() => {
      try {
        const before = g().fil;
        fs.writeFileSync(cfgPath(), 'DRILL-CORRUPTED!!!');
        cfgRecoveredFrom = null;
        loadCfg();
        const pass = g().fil === before && !!cfgRecoveredFrom;
        console.log('[recovery-drill] before=' + before + ' after=' + g().fil + ' from=' + cfgRecoveredFrom + ' => ' + (pass ? 'PASS' : 'FAIL'));
      } catch (e) { console.log('[recovery-drill] ERROR ' + e.message); }
      app.exit(0);
    }, 6000);
  }
  // --test-persistence-drill=write|assert（Gate A1）：write 轮写特征值后退出；assert 轮重启断言两值精确仍在
  // 同日重跑 dailyCheck 幂等跳过，特征值稳定；PASS/FAIL 打 [persist-drill] 行
  const tpd = process.argv.find((a) => a.startsWith('--test-persistence-drill='));
  if (tpd) {
    const mode = tpd.split('=')[1];
    setTimeout(() => {
      try {
        if (mode === 'write') {
          g().fil = 7777;
          NUR.exp = 42;
          saveCfg();
          console.log('[persist-drill] write done fil=7777 exp=42');
          app.exit(0);
        } else {
          const ok = g().fil === 7777 && Math.round(NUR.exp) === 42;
          console.log('[persist-drill] assert fil=' + g().fil + ' exp=' + NUR.exp + ' => ' + (ok ? 'PASS' : 'FAIL'));
          app.exit(ok ? 0 : 1);
        }
      } catch (e) { console.log('[persist-drill] ERROR ' + e.message); app.exit(1); }
    }, 6000);
  }
  // --test-prc=run|verify（pre-release-check 交付门，坑㉑：进程内自测编排）：run 轮驱动全业务链逐步打 [prc] 行后退出；
  // verify 轮重启直读隔离档断言持久化产物。汇总报告由 tools/pre-release-check.js 落 docs/
  const tprc = process.argv.find((a) => a.startsWith('--test-prc='));
  if (tprc && tprc.split('=')[1] === 'run') {
    const fails = [];
    const prcLog = (name, ok, detail) => { console.log('[prc] ' + name + ' ' + (ok ? 'OK' : 'FAIL') + (detail ? ' | ' + detail : '')); if (!ok) fails.push(name); };
    const js = (code) => (win && !win.isDestroyed() ? win.webContents.executeJavaScript(code) : Promise.resolve(null));
    setTimeout(async () => {
      try {
        prcLog('state', !!NUR.bornAt && g().fil >= 5000, 'fil=' + g().fil);
        prcLog('signin', (NUR.tasks.done || []).includes('login'));
        NUR.money = Math.max(NUR.money, 500); saveCfg(); // 喂食前置：保证余额（测试档直接充值）
        const shopItem = SHOP.find((s) => (s.minLv || 1) <= 1) || SHOP[0];
        const f = await js('window.pet.feed(' + JSON.stringify(shopItem.id) + ')');
        prcLog('feed', !!f && !f.error, JSON.stringify(f));
        const ds = await js('window.pet.dungeonStart("history")');
        prcLog('dungeon-start', !!ds && ds.ok === true, JSON.stringify(ds));
        await js('window.pet.dungeonQuestion()');
        const dq = NUR.tasks && NUR.tasks.dungeon;
        const ans = dq && dq.q ? dq.q.ans : null;
        const sub = ans == null ? null : await js('window.pet.dungeonSubmit(' + JSON.stringify(ans) + ')');
        prcLog('dungeon-answer', !!sub && !sub.error && (NUR.quiz.stats.history.correct || 0) >= 1, '答对=' + (NUR.quiz.stats.history.correct || 0));
        const p1 = await js('window.pet.gachaPull("std",1)');
        prcLog('gacha-1', !!p1 && !p1.error, JSON.stringify(p1).slice(0, 60));
        g().stdTapes = Math.max(g().stdTapes || 0, 12); saveCfg(); // 十连耗券不耗菲林（notape），测试档直接补券
        const p10 = await js('window.pet.gachaPull("std",10)');
        prcLog('gacha-10', !!p10 && !p10.error, JSON.stringify(p10).slice(0, 60));
        const held = (g().warehouse || []).find((w) => w.status === 'held');
        const ap = held ? await js('window.pet.warehouseUse(' + JSON.stringify(held.id) + ')') : null;
        prcLog('redeem-apply', !!ap && ap.ok === true, held ? 'wid=' + held.id : '仓库无 held');
        const pin = await js('window.pet.adminSetupPin("1234","1234")');
        let pinOk = !!pin && pin.ok === true;
        let pinNote = JSON.stringify(pin);
        if (pin && pin.error === 'already') { // 热启动轮：PIN 已存在（冷轮设置过）→ 改走验证解锁
          const v = await js('window.pet.adminVerify("1234")');
          pinOk = !!v && v.ok === true;
          pinNote = 'already→verify ' + JSON.stringify(v);
        }
        prcLog('admin-pin', pinOk, pinNote);
        const list = await js('window.pet.adminRedeemList()');
        const pid2 = list && list.pending && list.pending[0] && list.pending[0].id;
        const cf = pid2 != null ? await js('window.pet.adminRedeemConfirm(' + JSON.stringify(pid2) + ')') : null;
        prcLog('admin-confirm', !!cf && cf.ok === true, pid2 != null ? 'wid=' + pid2 : '无 pending');
        const qr = await js('window.pet.mobileQr()');
        prcLog('mobile-qr', !!qr && JSON.stringify(qr).length > 100);
      } catch (e) {
        prcLog('exception', false, e.message);
      }
      saveCfg();
      console.log('[prc] RUN DONE fails=' + fails.length + (fails.length ? ' -> ' + fails.join(',') : ''));
      app.exit(fails.length ? 1 : 0);
    }, 7000);
  }
  if (tprc && tprc.split('=')[1] === 'verify') {
    setTimeout(() => {
      const adminOk = fs.existsSync(path.join(app.getPath('userData'), 'admin.json'));
      const usedItem = (g().warehouse || []).some((w) => w.status === 'used');
      const passed = g().fil > 0 && !!NUR.bornAt && adminOk && usedItem && (NUR.quiz.stats.history.correct || 0) >= 1;
      console.log('[prc] verify fil=' + g().fil + ' bornAt=' + !!NUR.bornAt + ' admin.json=' + adminOk + ' usedItem=' + usedItem + ' quizCorrect=' + (NUR.quiz.stats.history.correct || 0) + ' => ' + (passed ? 'PASS' : 'FAIL'));
      app.exit(passed ? 0 : 1);
    }, 7000);
  }
  const tq = process.argv.find((a) => a.startsWith('--test-quit-after='));
  if (tq) setTimeout(() => app.exit(0), Number(tq.split('=')[1]) || 8000);
  // --test-admin：自动开管理窗口（PIN 设置页抓帧用）
  if (process.argv.includes('--test-admin')) setTimeout(() => openAdminWindow(), 5000);
  // --test-redeem：兑现确认制全链路演练（她申请 → 管理员确认 → used 归档）
  if (process.argv.includes('--test-redeem')) {
    setTimeout(() => {
      if (!chatWin || chatWin.isDestroyed()) return;
      chatWin.webContents.executeJavaScript(
        "setMode('nurture'); switchNurTab('warehouse');" +
        "window.pet.gachaPull('std',1).then(() => { renderNurture(); setTimeout(() => {" +
        "const b = document.querySelector('[data-wid]'); if (b) b.click(); }, 700); }).catch(() => {});"
      ).catch(() => {});
    }, 8000);
    setTimeout(() => { // 管理员侧：设置 PIN → 解锁 → 确认兑现
      if (!chatWin || chatWin.isDestroyed()) return;
      chatWin.webContents.executeJavaScript(
        "window.pet.adminSetupPin('1234','1234').then(() => window.pet.adminRedeemList()).then((r) => {" +
        "const p = r.pending && r.pending[0]; if (!p) { console.log('[redeem-dbg] no pending'); return null; }" +
        "return window.pet.adminRedeemConfirm(p.id).then((c) => console.log('[redeem-dbg] confirm=' + (c.ok ? 'OK' : JSON.stringify(c))));" +
        " }).catch((e) => console.log('[redeem-dbg] err ' + e.message));"
      ).catch((e) => console.error('[redeem] inject fail', e.message));
    }, 11000);
  }
  setInterval(() => { try { loadLocalPool(); } catch (_e) {} }, 5 * 60000);
  setInterval(() => { fetchRemotePool().catch(() => {}); }, 30 * 60000);
  // 联调开关：--test-scale=1.25 启动 5s 后自动切档（验证缩放链路）
  const ts = process.argv.find((a) => a.startsWith('--test-scale='));
  if (ts) setTimeout(() => setScale(Number(ts.split('=')[1])), 5000);
  // 联调开关：--test-clones 启动后直接召唤一次分身
  if (process.argv.includes('--test-clones')) setTimeout(() => spawnClones(), 6000);
  // --test-chat[=mode]：启动自动开聊天窗（默认攻略页；--test-chat=push 直开推送页）
  const tc = process.argv.find((a) => a.startsWith('--test-chat'));
  if (tc) {
    const mode = tc.includes('=') ? tc.split('=')[1] : 'guide';
    setTimeout(() => openChatWindow(mode), 5000);
  }
  // --test-hud：启动 6 秒后自动开 HUD 窗（联调抓帧用）
  if (process.argv.includes('--test-hud')) {
    setTimeout(() => openHudWindow(), 6000);
  }
  // --test-shot：开窗 9 秒后用 capturePage 存渲染层真实位图（PrintWindow 在 DPI 虚拟化会话下会裁切失真）
  // --test-demo：随 shot 注入纯前端演示（假数据，不碰存档）：状态条浮层+任务浮字+钱包滚动 → 十连结果
  const demoShot = process.argv.includes('--test-shot');
  if (process.argv.includes('--test-demo') && demoShot) {
    setTimeout(() => {
      if (!chatWin || chatWin.isDestroyed()) return;
      try {
        chatWin.webContents.executeJavaScript(
          "playTaskFloat({ id: 'feed', fil: 60, exp: 4 });" +
          "animateNumber(document.getElementById('w-money'), 80, 240, 900);" +
          "renderNurture().then(() => { const s = document.querySelector('.stat[data-key=\\\"food\\\"]'); showStatPop(s, 'food'); });"
        ).catch(() => {});
      } catch (_e) {}
    }, 7800);
    setTimeout(() => { // 聊天窗答题链路演示：政治科（多选概率高）→ 真实点选两项 → 确认提交 → 结果/解析态
      if (!chatWin || chatWin.isDestroyed()) return;
      try {
        chatWin.webContents.executeJavaScript(
          "hideStatPop(); setMode('nurture'); switchNurTab('dungeon');" +
          "enterDungeon('politics').then(() => { setTimeout(() => {" +
          "renderNurture(); if (!quizLive) console.log('[chat-diag] QUIZ-CLOBBERED');" +
          "const btns = document.querySelectorAll('.nur-panel[data-panel=dungeon] .quiz-opts button');" +
          "if (btns[0]) btns[0].click(); if (btns[1]) btns[1].click();" +
          "const c = document.getElementById('quiz-confirm'); if (c) c.click(); }, 900); }).catch(() => {});"
        ).catch(() => {});
      } catch (_e) {}
    }, 8600);
    setTimeout(() => { // 第四帧：聊天窗答题结果态（确认按钮/单次作答/解析卡）
      if (!chatWin || chatWin.isDestroyed()) return;
      chatWin.webContents.capturePage()
        .then((img) => {
          fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-quiz.png'), img.toPNG());
          console.log('[diag] capturePage quiz saved');
        })
        .catch(() => {});
    }, 10100);
    setTimeout(() => {
      if (!chatWin || chatWin.isDestroyed()) return;
      try {
        chatWin.webContents.executeJavaScript(
          "hideStatPop(); switchNurTab('gacha');" +
          "showGachaResults([{tier:'A',up:false,name:'零食投喂券',desc:'一份她爱吃的零食'},{tier:'B',up:false,name:'课间抱抱 ×1',desc:'下课后一个真诚的拥抱'},{tier:'B',up:false,name:'今日份彩虹屁',desc:'当面彩虹屁 ×1'},{tier:'B',up:false,name:'陪走一程',desc:'晚上陪她散步回家'},{tier:'A',up:true,name:'温暖小物',desc:'围巾/挂件/暖手宝，挑一样送她'},{tier:'B',up:false,name:'课间抱抱 ×1',desc:'下课后一个真诚的拥抱'},{tier:'B',up:false,name:'今日份彩虹屁',desc:'当面彩虹屁 ×1'},{tier:'B',up:false,name:'陪走一程',desc:'晚上陪她散步回家'},{tier:'B',up:false,name:'课间抱抱 ×1',desc:'下课后一个真诚的拥抱'},{tier:'S',up:true,name:'仲秋神秘大礼',desc:'当面交给她的一份神秘礼物'}]);"
        ).catch(() => {});
      } catch (_e) {}
    }, 10500);
    setTimeout(() => {
      if (!chatWin || chatWin.isDestroyed()) return;
      chatWin.webContents.capturePage()
        .then((img) => {
          fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-demo2.png'), img.toPNG());
          console.log('[diag] capturePage demo2 saved');
        })
        .catch(() => {});
    }, 12800);
  }
  if (demoShot) {
    setTimeout(() => {
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.capturePage()
          .then((img) => {
            fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-real.png'), img.toPNG());
            console.log('[diag] capturePage saved');
          })
          .catch((e) => console.error('[diag] capturePage fail', e));
      } else { console.log('[diag] no chatWin for shot'); }
      if (win && !win.isDestroyed() && !chatWin) { // 无聊天窗时抓桌宠本体帧（图层化/微动/彩蛋回归用）
        win.webContents.capturePage()
          .then((img) => {
            fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-pet.png'), img.toPNG());
            console.log('[diag] capturePage pet saved');
          })
          .catch((e) => console.error('[diag] capturePage pet fail', e.message));
      }
      if (adminWin && !adminWin.isDestroyed()) { // --test-admin 同开时抓管理窗口帧（PIN 设置页）
        adminWin.webContents.capturePage()
          .then((img) => {
            fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-admin.png'), img.toPNG());
            console.log('[diag] capturePage admin saved');
          })
          .catch(() => {});
      }
      if (hudWin && !hudWin.isDestroyed()) { // --test-hud 同开时一并抓 HUD 帧（默认帧 + 任务视图帧）
        hudWin.webContents.capturePage()
          .then((img) => {
            fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-hud.png'), img.toPNG());
            console.log('[diag] capturePage hud saved');
          })
          .catch((e) => console.error('[diag] capturePage hud fail', e));
        setTimeout(() => {
          if (!hudWin || hudWin.isDestroyed()) return;
          hudWin.webContents.executeJavaScript('try { switchView("quiz"); window.pet.dungeonStart("history").then(() => loadDungeonStage()).catch(() => {}); console.log("[hud-diag] switched ok"); renderDots(ST); } catch (e) { console.log("[hud-diag] err: " + e.message); } undefined;').catch((e) => console.error('[diag] inject fail', e.message));
        }, 10500);
        setTimeout(() => { // 模拟 30s 轮询触发 renderAll：修复后题目视图必须原地保留
          if (!hudWin || hudWin.isDestroyed()) return;
          hudWin.webContents.executeJavaScript('try { renderAll(); console.log("[hud-diag] renderAll ok, quiz live"); } catch (e) { console.log("[hud-diag] err: " + e.message); } undefined;').catch((e) => console.error('[diag] inject fail', e.message));
        }, 13000);
        setTimeout(() => { // 抓「重渲染后题目仍在」帧：若回退成选科页即回归
          if (!hudWin || hudWin.isDestroyed()) return;
          hudWin.webContents.capturePage()
            .then((img) => {
              fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-hud3.png'), img.toPNG());
              console.log('[diag] capturePage hud3 saved');
            })
            .catch(() => {});
        }, 14300);
        setTimeout(() => { // 答错一次（idx 99 必错）：驱动「✗ + 正确答案 + 解析」锁定态
          if (!hudWin || hudWin.isDestroyed()) return;
          hudWin.webContents.executeJavaScript('try { window.pet.dungeonSubmit(99).then((r) => renderHudQuizResult(r)).catch((e) => console.log("[hud-diag] submit err " + e.message)); } catch (e) { console.log("[hud-diag] err: " + e.message); } undefined;').catch((e) => console.error('[diag] inject fail', e.message));
        }, 14800);
        setTimeout(() => { // 第四帧：答错锁定态（✗ + 正确答案 + 解析卡）
          if (!hudWin || hudWin.isDestroyed()) return;
          hudWin.webContents.capturePage()
            .then((img) => {
              fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-hud4.png'), img.toPNG());
              console.log('[diag] capturePage hud4 saved');
            })
            .catch(() => {});
        }, 16500);
        setTimeout(() => {
          if (!hudWin || hudWin.isDestroyed()) return;
          hudWin.webContents.capturePage()
            .then((img) => {
              fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-hud2.png'), img.toPNG());
              console.log('[diag] capturePage hud2 saved');
            })
            .catch(() => {});
        }, 12000);
      }
    }, 9000);
  }
  // 联调开关：--test-pet-assert 桌宠窗断言+抓帧（sprite 图层化回归：stage 挂载/未知表情不报错/粒子/动作切换）
  if (process.argv.includes('--test-pet-assert')) {
    setTimeout(() => {
      if (!win || win.isDestroyed()) { console.log('[pet-assert] no win'); return; }
      win.webContents.executeJavaScript(
        '(function () {' +
        'const r = {};' +
        'try { r.stage = !!document.getElementById("pet-stage"); } catch (e) { r.stageErr = e.message; }' +
        'try {' +
        'const s = window.RemielleSprite; r.sprite = !!s; if (s) {' +
        's.setExpression("xxx"); r.exprUnknownHidden = !document.getElementById("pet-expr").getAttribute("data-on");' +
        's.spawnFx("heart"); r.fxCount = document.querySelectorAll("#pet-fx .fx").length;' +
        's.play("idle", { loop: true }); r.playIdle = true;' +
        '} } catch (e) { r.err = e.message; }' +
        'return JSON.stringify(r);' +
        '})()'
      ).then((res) => console.log('[pet-assert] ' + res))
       .catch((e) => console.error('[pet-assert] inject fail', e.message));
    }, 8500);
    setTimeout(() => { // 拖拽链路模拟：合成 mousedown/mousemove/mouseup → 斜倾+state-drag → 松手 spring-back → 600ms 后清理
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        '(function () {' +
        'return new Promise((resolve) => {' +
        'const r = {};' +
        'const wrap = document.getElementById("pet-wrap");' +
        'const stage = document.getElementById("pet-stage");' +
        'if (!wrap || !stage) { r.err = "no wrap/stage"; return resolve(JSON.stringify(r)); }' +
        'const ev = (mx, my, sx, sy) => new MouseEvent("mousemove", { bubbles: true, button: 0, movementX: mx, movementY: my, screenX: sx, screenY: sy });' +
        'wrap.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));' +
        'let i = 0;' +
        'const iv = setInterval(() => {' +
        'i++; window.dispatchEvent(ev(8, 1, 100 + i * 8, 101));' +
        'if (i < 6) return;' +
        'clearInterval(iv);' +
        'r.dragRotate = stage.style.transform;' +
        'r.dragState = /state-drag/.test(document.body.className);' +
        'window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));' +
        'r.springBack = document.body.classList.contains("spring-back");' +
        'r.tiltVar = stage.style.getPropertyValue("--tilt");' +
        'setTimeout(() => {' +
        'r.springCleared = !document.body.classList.contains("spring-back");' +
        'r.transformCleared = stage.style.transform === "";' +
        'resolve(JSON.stringify(r));' +
        '}, 600);' +
        '}, 60);' +
        '});' +
        '})()'
      ).then((res) => console.log('[pet-drag] ' + res))
       .catch((e) => console.error('[pet-drag] inject fail', e.message));
    }, 10500);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.capturePage()
        .then((img) => {
          fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-pet.png'), img.toPNG());
          console.log('[pet-assert] capturePage saved');
        })
        .catch((e) => console.error('[pet-assert] capture fail', e));
    }, 10000);
    setTimeout(() => { // 彩蛋④链路验证：直接发 pet:slouch，随后查气泡是否挂 b-dull 样式（IPC→preload→订阅→eggAllow 全链路）
      if (!win || win.isDestroyed()) return;
      win.webContents.send('pet:slouch', 'ZenlessZoneZero.exe');
    }, 11500);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        '(function () {' +
        'const b = document.getElementById("bubble");' +
        'let egg = null; try { egg = localStorage.getItem("egg-slouch-" + new Date().toDateString()); } catch (e) { egg = "ERR " + e.message; }' +
        'return JSON.stringify({ onSlouch: typeof window.pet.onSlouch, egg, cls: document.body.className, bubbleShown: b && b.classList.contains("show"), dull: b && b.classList.contains("b-dull"), text: b ? b.textContent.slice(0, 40) : "" });' +
        '})()'
      ).then((res) => console.log('[pet-slouch] ' + res))
       .catch((e) => console.error('[pet-slouch] inject fail', e.message));
    }, 12400);
    setTimeout(() => { // 第二帧：与第一帧做像素差验证微动（呼吸+漂浮）可见
      if (!win || win.isDestroyed()) return;
      win.webContents.capturePage()
        .then((img) => {
          fs.writeFileSync(path.join(__dirname, 'docs', 'media', 'verify-pet2.png'), img.toPNG());
          console.log('[pet-assert] capturePage2 saved');
        })
        .catch((e) => console.error('[pet-assert] capture fail', e));
    }, 13000);
  }
  // 联调开关：--test-push 启动即重推当天金句与最新新闻（验证推送管线）
  if (process.argv.includes('--test-push') || process.argv.includes('--test-quote')) {
    cfg.lastQuoteDate = '';
  }
  if (process.argv.includes('--test-push')) {
    setTimeout(() => {
      pushQueue.push(normalizePushItem({ id: 'test-' + Date.now(), title: '测试推送', body: '这是一条联调用的假推送，管线通畅。' }));
      deliverNextPush();
    }, 6000);
  }
});
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) win.show();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  // 记住最后位置，下次原地现身
  if (win && !win.isDestroyed()) {
    const b = win.getContentBounds();
    cfg.x = b.x;
    cfg.y = b.y;
    saveCfg();
  }
});
app.on('will-quit', () => {
  if (gazeTimerHolder.timer) clearInterval(gazeTimerHolder.timer);
  reminderTimers.forEach((t) => clearTimeout(t));
  if (pushTimerHolder.timer) clearInterval(pushTimerHolder.timer);
});
