// 开源包导出器：按字面量白名单把项目文件装配进 remielle-pet-public/，导出后做双保险扫描
// 用法：node tools/build-opensource.js   （零参数；白名单/扫描词表都在本文件内，勿从外部传入）
// 安全设计（数据安全优先）：
//   1. 白名单模式——只有明确列出的文件才会进入开源包（黑名单漏带即泄漏，白名单漏带只是少文件）
//   2. 永不进入包内：docs/（内部交接文档）、真实奖励池 gacha-pool.json（只发 example）、
//      素材二进制（spritesheet.webp、bg/、chara/ ——米哈游衍生版权谨慎）、quiz-bank.js（已废弃）、
//      运行时/临时目录（.prc/.hotfix-drill/remielle-hotfix/dist/node_modules/config.json）
//   3. 导出后全包扫描私感词与凭据形态，命中即 FAIL（包保留供排查，进程退出码 1）
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'remielle-pet-public');

// 文件白名单：[源（相对项目根）, 目标（相对开源包根）]，全部字面量
const FILE_MAP = [
  ['main.js', 'main.js'],
  ['hotfix.js', 'hotfix.js'],
  ['preload.js', 'preload.js'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['NOTICE-CREDITS.md', 'NOTICE-CREDITS.md'],
  ['renderer/index.html', 'renderer/index.html'],
  ['renderer/pet.js', 'renderer/pet.js'],
  ['renderer/pet.css', 'renderer/pet.css'],
  ['renderer/sprite.js', 'renderer/sprite.js'],
  ['renderer/character.js', 'renderer/character.js'],
  ['renderer/chat.html', 'renderer/chat.html'],
  ['renderer/clone.html', 'renderer/clone.html'],
  ['renderer/hud.html', 'renderer/hud.html'],
  ['renderer/admin.html', 'renderer/admin.html'],
  ['renderer/assets/animation-triggers.json', 'renderer/assets/animation-triggers.json'],
  ['renderer/assets/manifest.json', 'renderer/assets/manifest.json'],
  ['renderer/assets/pet.json', 'renderer/assets/pet.json'],
  ['renderer/assets/quotes-extended.json', 'renderer/assets/quotes-extended.json'],
  ['resources/gacha-pool.example.json', 'resources/gacha-pool.example.json'],
  ['resources/i18n-pet.json', 'resources/i18n-pet.json'],
  ['resources/lore-remielle.md', 'resources/lore-remielle.md'],
  ['resources/mobile-page.js', 'resources/mobile-page.js'],
  ['resources/quiz/hist.js', 'resources/quiz/hist.js'],
  ['resources/quiz/pol.js', 'resources/quiz/pol.js'],
  ['resources/quiz/en.js', 'resources/quiz/en.js'],
  ['resources/zzz/character-aliases.yaml', 'resources/zzz/character-aliases.yaml'],
  ['resources/zzz/zzz-community.md', 'resources/zzz/zzz-community.md'],
  ['resources/zzz/zzz-gameplay.md', 'resources/zzz/zzz-gameplay.md'],
  ['resources/zzz/zzz-story.md', 'resources/zzz/zzz-story.md'],
  ['resources/zzz/zzz-terms.md', 'resources/zzz/zzz-terms.md'],
  ['resources/opensource/README.md', 'README.md'],
  ['resources/opensource/LICENSE', 'LICENSE'],
  ['tools/quiz-validate.js', 'tools/quiz-validate.js'],
  ['tools/push-hotfix.js', 'tools/push-hotfix.js'],
  ['tools/hotfix-drill.js', 'tools/hotfix-drill.js'],
  ['tools/sprite-validate.js', 'tools/sprite-validate.js'],
  ['tools/save-audit.js', 'tools/save-audit.js'],
  ['tools/kill-drill-server.ps1', 'tools/kill-drill-server.ps1'],
  ['tools/build-opensource.js', 'tools/build-opensource.js'],
  ['scripts/export-icon.js', 'scripts/export-icon.js'],
  ['scripts/gen-quotes.js', 'scripts/gen-quotes.js'],
];

// 私感词表：命中任意即拒绝出包（注意不含「考研」「嘉兴」等题库合法内容词）
const PRIVACY_WORDS = ['淡茹', '缙云', '宿舍楼下', '晚自习', '女朋友', '男朋友'];
// 凭据形态：GitHub PAT / 智谱 key / DeepSeek key 的字面量形态
const CREDENTIAL_RE = /ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9]{16,}/;

// 导出时脱敏替换（源文件不动，只在复制到开源包时生效）：
// 目的=剥离真实城市/院校阶段/性格测试标签等私人语境，保留功能性文案
const SANITIZE = [
  {
    file: 'main.js',
    rules: [
      ['在浙江嘉兴读大学；正在备考历史学硕士研究生——', '在读大学；正在备考硕士研究生——'],
      ['历史是她的优势学科，英语和考研政治同步推进（三科并重）；ISFP，安静细腻，不喜欢被打扰，', '历史是她的优势学科，政治英语同步推进（三科并重）；性格安静细腻，不喜欢被打扰，'],
      ['家乡浙江缙云（仙都、烧饼、黄帝文化）；', '家乡是江南小城；'],
      ['一份送到宿舍楼下的零食', '一份她爱吃的零食'],
      ['晚自习后送她回宿舍楼下', '晚上陪她散步回家'],
    ],
  },
  {
    file: 'resources/lore-remielle.md',
    rules: [
      ['共犯画像：浙江嘉兴在读大学生；备考历史学硕士（历史是优势学科，英语与考研政治同步推进，三科并重；初试 2028 年 12 月——陪她走完这段长路）；ISFP：安静细腻、慢热长情、不喜欢被打扰、情绪低落时需要被安静地接住而非说教；爱玩《绝区零》（常玩）与《三角洲行动》（近期沉迷）；家乡浙江缙云（仙都、烧饼、黄帝文化），乡情浓厚；**完全不能吃辣**——投喂与美食话题一律避开辣。',
       '共犯画像：在读大学生；备考硕士（三科并重）；安静细腻、慢热长情、不喜欢被打扰、情绪低落时需要被安静地接住而非说教；爱玩《绝区零》与《三角洲行动》；完全不能吃辣——投喂与美食话题一律避开辣。'],
      ['嘉兴与缙云（仙都/烧饼/南湖）', '家乡的风景与特产'],
    ],
  },
];

let copied = 0, missing = [];
for (const [src, dest] of FILE_MAP) {
  const from = path.join(ROOT, src);
  const to = path.join(OUT, dest);
  if (!from.startsWith(ROOT + path.sep) || !to.startsWith(OUT + path.sep)) {
    console.log(`FAIL 路径越界：${src}`);
    process.exit(1);
  }
  if (!fs.existsSync(from)) { missing.push(src); continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let content = fs.readFileSync(from, 'utf8');
  const rule = SANITIZE.find((r) => r.file === src);
  if (rule) for (const [fromStr, toStr] of rule.rules) {
    if (!content.includes(fromStr)) { console.log(`FAIL 脱敏规则未命中（源已漂移，先更新 SANITIZE）：${src} ← ${fromStr.slice(0, 24)}…`); process.exit(1); }
    content = content.split(fromStr).join(toStr);
  }
  fs.writeFileSync(to, content);
  copied++;
}
if (missing.length) {
  console.log('FAIL 白名单文件缺失（白名单与实际文件漂移，请修正表后再导出）：');
  for (const m of missing) console.log('  - ' + m);
  process.exit(1);
}
console.log(`[export] 复制 ${copied} 个白名单文件 → ${OUT}`);

// 双保险扫描：全包逐文件查私感词与凭据形态（文本文件按 utf8 读，json 亦为文本）
let hits = [];
function scan(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { scan(p); continue; }
    const text = fs.readFileSync(p, 'utf8');
    for (const w of PRIVACY_WORDS) {
      if (text.includes(w)) hits.push(`${path.relative(OUT, p)} 私感词「${w}」`);
    }
    const cm = text.match(CREDENTIAL_RE);
    if (cm) hits.push(`${path.relative(OUT, p)} 疑似凭据字面量（${cm[0].slice(0, 8)}…）`);
  }
}
scan(OUT);
// 扫描器自身文件里天然包含待检词表，剔除其自检命中后再判定
hits = hits.filter((h) => !h.split(' ')[0].endsWith('build-opensource.js'));
if (hits.length) {
  console.log('FAIL 隐私/凭据扫描未通过：');
  for (const h of hits) console.log('  - ' + h);
  console.log('开源包保留在 ' + OUT + ' 供排查；修复源文件后重跑。');
  process.exit(1);
}
console.log(`[scan] 私感词 ${PRIVACY_WORDS.length} 项 + 凭据形态扫描：全包命中 0`);
console.log(`OK 开源包就绪：${OUT}（${copied} 文件）。后续：git init + 建远端仓库 + 推送（见 PLAN-250 建仓节）。`);
