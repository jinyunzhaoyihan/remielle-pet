// 存档审计脚本（v2.4.0）：校验真实存档的完整性 / sha256 / 备份健康度 / 管理员凭据
// 用法：node tools/save-audit.js
// 目录固定为 <用户主目录>\AppData\Roaming\RemiellePet（Electron userData 缺省位），
// 全部路径由固定常量拼装，不读取任何外部输入
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'RemiellePet');
if (!fs.existsSync(dir)) { console.log(`✗ 存档目录不存在: ${dir}`); process.exit(1); }

const cfgPath = path.join(dir, 'config.json');
const shaPath = cfgPath + '.sha256';
const adminPath = path.join(dir, 'admin.json');
const logPath = path.join(dir, 'admin-log.json');
// Gate A3：备份双路径探测——新目录 %APPDATA%\remielle-backups 优先，旧 <userData>/backups 兼容回退
const bakDirNew = path.join(os.homedir(), 'AppData', 'Roaming', 'remielle-backups');
const bakDirOld = path.join(dir, 'backups');
const bakDir = fs.existsSync(bakDirNew) ? bakDirNew : bakDirOld;

let fail = 0;
function validShape(obj) { return !!obj && typeof obj === 'object' && !!obj.nurture && typeof obj.nurture === 'object'; }

console.log(`审计目录: ${dir}\n──────────`);
// 1. 主档
let cfg = null, mainOk = false;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  mainOk = validShape(cfg);
} catch (_e) {}
console.log(`主档 config.json: ${mainOk ? '✓ 可解析且形状合法' : '✗ 缺失/损坏/形状非法'}`);
if (!mainOk) fail++;
if (cfg) {
  const n = cfg.nurture;
  console.log(`  版本戳: ${cfg.appVersion || '（无）'} · 等级 ${n.level} · 菲林 ${n.gacha ? n.gacha.fil : '?'} · 母带 ${n.gacha ? n.gacha.stdTapes + '/' + n.gacha.encTapes : '?'}`);
  if (n.quiz && n.quiz.stats) {
    const s = n.quiz.stats;
    console.log(`  答题: 历史 ${s.history.asked}/${s.history.correct} · 英语 ${s.english.asked}/${s.english.correct} · 政治 ${s.politics.asked}/${s.politics.correct}`);
  }
}
// 2. sha256 sidecar
if (mainOk) {
  try {
    const data = fs.readFileSync(cfgPath);
    const want = fs.readFileSync(shaPath, 'utf8').trim();
    const got = crypto.createHash('sha256').update(data).digest('hex');
    console.log(`完整性校验: ${got === want ? '✓ sha256 匹配' : '⚠ sha256 不匹配（文件被外部修改或写入中断）'}`);
  } catch (_e) { console.log('完整性校验: - 无 sidecar（旧档正常，保存一次后生成）'); }
}
// 3. 备份
let baks = [];
try {
  baks = fs.readdirSync(bakDir).filter((f) => /^save-\d{14}-[a-z]+\.json$/.test(f)).sort().reverse();
} catch (_e) {}
console.log(`备份: ${baks.length} 份（保留上限 50）`);
let okCount = 0;
for (const f of baks.slice(0, 60)) {
  try { if (validShape(JSON.parse(fs.readFileSync(path.join(bakDir, f), 'utf8')))) okCount++; else { console.log(`  ⚠ 损坏不可用: ${f}`); fail++; } } catch (_e) { console.log(`  ⚠ 不可读: ${f}`); fail++; }
}
console.log(`  可用 ${okCount}/${baks.length}${baks.length ? ` · 最新: ${baks[0]}` : ''}`);
if (!baks.length) console.log('  ⚠ 尚无任何备份——建议立即运行一次桌宠或管理员面板「立即备份」');
// 4. 管理员凭据与日志
let admin = null;
try { admin = JSON.parse(fs.readFileSync(adminPath, 'utf8')); } catch (_e) {}
console.log(`管理员凭据: ${admin && admin.pinHash && admin.salt ? '✓ 已设置（scrypt）' : '未设置（管理员功能未启用）'}`);
let logN = 0;
try { logN = JSON.parse(fs.readFileSync(logPath, 'utf8')).length; } catch (_e) {}
console.log(`审计日志: ${logN} 条`);
console.log('──────────');
console.log(fail ? `✗ ${fail} 处问题` : '✓ 审计通过');
process.exit(fail ? 1 : 0);
