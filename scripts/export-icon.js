// 导出桌宠图标：把雪碧图第 3 行（挥手）第 0 帧画成 256x256 PNG
// 用法：npm run icon（内部执行 electron scripts/export-icon.js）
// 注意：图片以 data URL 注入页面，绕开 file:// 跨源导致 canvas 污染的问题
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html><body></body></html>'); // 必须先有已加载页面，executeJavaScript 才能执行
  try {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'assets', 'spritesheet.webp'));
    const dataUrl = 'data:image/webp;base64,' + bytes.toString('base64');
    const dataUrlPng = await win.webContents.executeJavaScript(
      `(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(dataUrl)};
        await img.decode();
        // 挥手帧 row3 col0（192x208），先等比放到高 277 再垂直居中裁 256x256
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 3 * 208, 192, 208, 0, 0, 256, 277);
        const out = document.createElement('canvas');
        out.width = 256; out.height = 256;
        const octx = out.getContext('2d');
        octx.drawImage(c, 0, Math.round((277 - 256) / 2), 256, 256, 0, 0, 256, 256);
        return out.toDataURL('image/png');
      })()`
    );
    const outPath = path.join(__dirname, '..', 'build', 'icon.png');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(dataUrlPng.split(',')[1], 'base64'));
    console.log('icon written: ' + outPath);
  } catch (e) {
    console.error('icon export failed: ' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
