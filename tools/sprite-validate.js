// 素材校验器：staging/ready 独立 PNG 入库前四检查（尺寸/四角透明/命名/体积）
// 用法：node tools/sprite-validate.js  （生图流水线与热更入库后必跑）
// 四检查与 main.js stageAssetPath 白名单、sprite.js CELL_W/CELL_H 保持同一契约：
//   1. 尺寸必须 = 192×208（与雪碧图单帧同画布同锚点，错尺寸会错位）
//   2. 四角 alpha=0（覆盖层叠在身体帧上，角不透明会挡住背景）
//   3. 文件名 ^(expr|act|deco)-[a-z0-9-]+\.png$（main.js 白名单正则，不一致直接不加载）
//   4. 体积 <500KB（dataURL 走 IPC 注入，过大拖慢启动）
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// 目录固定为项目内 staging/ready，不接受外部传入，杜绝路径穿越面
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'resources', 'staging', 'ready');
const CELL_W = 192, CELL_H = 208, MAX_BYTES = 500 * 1024;
const NAME_RE = /^(expr|act|deco)-[a-z0-9-]+\.png$/;
// 文件名硬白名单：天然拒绝路径分隔符/../ 等穿越载体，命名检查另行报告
const BASENAME_RE = /^[a-zA-Z0-9._-]+$/;

let fail = 0, pass = 0;
if (!fs.existsSync(DIR)) {
  console.log('SKIP 目录不存在（暂无素材，属正常）：' + DIR);
  process.exit(0);
}
const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.png') && BASENAME_RE.test(f));
if (!files.length) {
  console.log('SKIP 目录无 PNG（暂无素材，属正常）：' + DIR);
  process.exit(0);
}

for (const f of files) {
  const p = path.join(DIR, f); // DIR 固定在项目内 + f 已过 basename 白名单，路径不可逃逸
  let fileFail = false;
  const bad = (msg) => { if (!fileFail) console.log(`FAIL ${f} ${msg}`); fileFail = true; fail++; };
  if (!NAME_RE.test(f)) { bad('命名不符白名单 ^(expr|act|deco)-[a-z0-9-]+\\.png$'); continue; }
  const buf = fs.readFileSync(p);
  if (buf.length >= MAX_BYTES) bad(`体积 ${(buf.length / 1024).toFixed(0)}KB ≥ 500KB`);
  // PNG 魔数：拦住改扩展名的非 PNG（CogView 偶发返回 jpeg）
  if (buf.readUInt32BE(0) !== 0x89504e47) { bad('PNG 魔数不符（可能是改名的非 PNG 文件）'); continue; }
  let png;
  try { png = PNG.sync.read(buf); } catch (e) { bad('解码失败 ' + e.message); continue; }
  if (png.width !== CELL_W || png.height !== CELL_H) {
    bad(`尺寸 ${png.width}×${png.height} ≠ ${CELL_W}×${CELL_H}`);
    continue; // 尺寸错了，四角坐标无意义
  }
  // 四角 alpha：3×3 邻域取最大值，容忍抗锯齿边缘单像素噪声
  const alphaAt = (x, y) => {
    let a = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const v = png.data[((y + dy) * png.width + (x + dx)) * 4 + 3];
      if (v > a) a = v;
    }
    return a;
  };
  const corners = { 左上: alphaAt(1, 1), 右上: alphaAt(png.width - 2, 1), 左下: alphaAt(1, png.height - 2), 右下: alphaAt(png.width - 2, png.height - 2) };
  const opaque = Object.entries(corners).filter(([, a]) => a > 8);
  if (opaque.length) bad('四角不透明：' + opaque.map(([k, a]) => `${k}=alpha${a}`).join(' '));
  if (!fileFail) { console.log(`PASS ${f}（${(buf.length / 1024).toFixed(0)}KB）`); pass++; }
}

console.log(`\n合计 ${files.length} 个：PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
