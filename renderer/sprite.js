// 小蕾米雪碧图帧播放器
// 素材来自 github.com/HanaAyane/remielle-codex-pet（米哈游官方活动素材的 AI 重绘衍生，非商业同人）
// 图集 spritesheet.webp：1536x2288，8列x11行，每格 192x208
//   行0-8 = 九个动作（idle/running-right/running-left/waving/smug/failed/waiting/working/think）
//   行9-10 = 16 向视线（每行 8 帧，22.5°一帧，顺时针排列）
(function () {
  const CELL_W = 192, CELL_H = 208; // 单帧尺寸（素材坐标）
  const COLS = 8, ROWS_TOTAL = 11;  // 图集网格
  const SCALE = 1.3;                // 显示缩放：192x208 -> 约250x270
  const GAZE_ROW_BASE = 9;          // 16 向视线从第 9 行开始
  // 视线换算：atan2 屏幕角（0°=右，90°=下）转罗盘方位（0°=上，顺时针）需 +90；
  // 实测方向整体偏移时，把 GAZE_ORIGIN 校准成 n*22.5（一帧 = 22.5°）
  const GAZE_BEARING_OFFSET = 90;
  const GAZE_ORIGIN = 0;

  // 动作 -> 行号（来自仓库 manifest.json）
  const ACTION_ROWS = {
    idle: 0,
    'running-right': 1,
    'running-left': 2,
    waving: 3,
    smug: 4,
    failed: 5,
    waiting: 6,
    working: 7,
    think: 8,
  };

  // 组合动作配方表：由已有动作的帧段编排"新动作"，零新素材。
  // segs: [{ act 必须在 ACTION_ROWS 内, fps 帧率(默认8), rev 逆序, times 整段重复, holdMs 尾帧停格 }]
  // cls: 播放期间挂到 body 的变换类（pet.css .act-* keyframes），播完自动摘除
  // ms: 近似总时长（pet.js 的 oneShotUntil 用它让位视线跟随）
  const COMPOSED = {
    curious: { segs: [{ act: 'idle', fps: 6, rev: true }, { act: 'idle', fps: 6 }], ms: 2400 },
    bounce: { segs: [{ act: 'smug', fps: 14, times: 2 }, { act: 'waving', fps: 12 }], cls: 'act-hop', ms: 1000 },
    stretch: { segs: [{ act: 'working', fps: 3 }, { act: 'waiting', fps: 3, holdMs: 300 }], cls: 'act-stretch', ms: 2800 },
    drowsy: { segs: [{ act: 'failed', fps: 3, times: 2 }, { act: 'idle', fps: 4, holdMs: 400 }], cls: 'act-nod', ms: 2800 },
    shy: { segs: [{ act: 'waiting', fps: 4 }, { act: 'failed', fps: 4, holdMs: 500 }], cls: 'act-shy', ms: 2600 },
    clap: { segs: [{ act: 'waving', fps: 14, times: 3 }], cls: 'act-clap', ms: 900 },
  };
  const ACT_CLS = Object.values(COMPOSED).map((r) => r.cls).filter(Boolean);

  let el = null;
  let timer = null;
  let stageEl = null;   // v2.5 图层化：微动变换层（呼吸/漂浮/拖拽弹簧），包裹全部视觉层
  let exprLayer = null; // 表情覆盖层（透明 PNG，无表情时隐藏）
  let decoLayer = null; // 装饰层（节日贴图预留，cfg.deco 驱动）
  let fxLayer = null;   // 粒子层（spawnFx 接口）
  let lastCell = { row: 0, col: 0 }; // 恢复雪碧图状态用（FILE_FRAMES 切换后还原）
  const frameCounts = {}; // 每行实测有效帧数（尾部全透明的格子不算帧）
  const STAGE_ASSETS = { expr: {}, act: {}, deco: {} }; // 注册表：name -> dataURL（主进程扫描 staging/ready 与热更目录后注入）

  function setCell(row, col) {
    lastCell = { row, col };
    el.style.backgroundPosition =
      -col * CELL_W * SCALE + 'px ' + -row * CELL_H * SCALE + 'px';
  }

  function clearActCls() {
    if (ACT_CLS.length) document.body.classList.remove(...ACT_CLS);
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    clearActCls();
  }

  // 播放一个动作。opts: { loop 循环, fps 帧率, durationMs 单次总时长, onEnd 单次播完回调 }
  // 官方给了 waving=700ms / smug=840ms，优先用 durationMs 反推帧间隔
  // FILE_FRAMES 优先：staging/热更下发的独立 PNG 动作帧（act-*），播完自动还原雪碧图
  function play(action, opts) {
    opts = opts || {};
    if (STAGE_ASSETS.act[action]) return playFileFrame(action, opts);
    if (ACTION_ROWS[action] === undefined) {
      if (COMPOSED[action]) return playComposed(action, opts);
      return;
    }
    const row = ACTION_ROWS[action];
    if (!el) return;
    const frames = frameCounts[row] || COLS;
    const total = opts.durationMs || (frames / (opts.fps || 10)) * 1000;
    const interval = Math.max(40, total / frames);
    stop();
    let col = 0;
    let stepped = 0;
    setCell(row, 0);
    const tick = () => {
      stepped++;
      if (!opts.loop && stepped >= frames) {
        setCell(row, frames - 1);
        timer = null;
        if (opts.onEnd) opts.onEnd();
        return;
      }
      col = (col + 1) % frames;
      setCell(row, col);
      timer = setTimeout(tick, interval);
    };
    timer = setTimeout(tick, interval);
  }

  // 组合动作播放器：按配方顺序播各帧段；rev 逆序、times 整段重复、holdMs 尾帧停格；
  // 播放期间挂配方 cls（pet.css 变换），结束/被打断都自动摘除
  function playComposed(name, opts) {
    opts = opts || {};
    const recipe = COMPOSED[name];
    if (!recipe || !el) return;
    stop();
    if (recipe.cls) document.body.classList.add(recipe.cls);
    let segIdx = 0;
    const nextSeg = () => {
      if (segIdx >= recipe.segs.length) {
        timer = null;
        clearActCls();
        if (opts.onEnd) opts.onEnd();
        return;
      }
      const seg = recipe.segs[segIdx++];
      const row = ACTION_ROWS[seg.act];
      const frames = frameCounts[row] || COLS;
      const interval = Math.max(40, 1000 / (seg.fps || 8));
      let order = [];
      for (let c = 0; c < frames; c++) order.push(c);
      if (seg.rev) order.reverse();
      if (seg.times > 1) { const base = order.slice(); for (let t = 1; t < seg.times; t++) order = order.concat(base); }
      let i = 0;
      const step = () => {
        if (i >= order.length) {
          if (seg.holdMs) {
            setCell(row, order[order.length - 1]);
            timer = setTimeout(nextSeg, seg.holdMs);
          } else nextSeg();
          return;
        }
        setCell(row, order[i++]);
        timer = setTimeout(step, interval);
      };
      step();
    };
    nextSeg();
  }

  // 视线跟随：angleDeg 为光标相对桌宠的 atan2 屏幕角（0°=右，90°=下）
  function gaze(angleDeg) {
    if (!el) return;
    const bearing = (angleDeg + GAZE_BEARING_OFFSET + GAZE_ORIGIN + 720) % 360;
    const idx = Math.round(bearing / 22.5) % 16;
    stop();
    setCell(GAZE_ROW_BASE + Math.floor(idx / COLS), idx % COLS);
  }

  // ===== v2.5 图层化：独立 PNG 动作帧 / 表情层 / 装饰层 / 粒子层 =====

  // 独立 PNG 动作帧：切 background-image 播单帧，durationMs 后自动还原雪碧图
  function playFileFrame(name, opts) {
    opts = opts || {};
    const url = STAGE_ASSETS.act[name];
    if (!url || !el) return;
    stop();
    el.style.backgroundImage = 'url("' + url + '")';
    el.style.backgroundSize = '100% 100%';
    el.style.backgroundPosition = '0 0';
    timer = setTimeout(() => {
      el.style.backgroundImage = "url('assets/spritesheet.webp')";
      el.style.backgroundSize = CELL_W * COLS * SCALE + 'px ' + CELL_H * ROWS_TOTAL * SCALE + 'px';
      setCell(lastCell.row, lastCell.col);
      if (opts.onEnd) opts.onEnd();
    }, opts.durationMs || 900);
  }

  // 表情层：透明 PNG 覆盖在身体帧上（同画布同锚点）；name=null/未知 = 隐藏
  function setExpression(name) {
    if (!exprLayer) return;
    const url = name && STAGE_ASSETS.expr[name];
    if (!url) { exprLayer.style.backgroundImage = ''; exprLayer.removeAttribute('data-on'); return; }
    exprLayer.style.backgroundImage = 'url("' + url + '")';
    exprLayer.setAttribute('data-on', '1');
  }

  // 装饰层：cfg.deco 驱动（节日包预留，默认空 = 隐藏）
  function setDeco(name) {
    if (!decoLayer) return;
    const url = name && STAGE_ASSETS.deco[name];
    if (!url) { decoLayer.style.backgroundImage = ''; decoLayer.removeAttribute('data-on'); return; }
    decoLayer.style.backgroundImage = 'url("' + url + '")';
    decoLayer.setAttribute('data-on', '1');
  }

  // 粒子层：spawnFx(type, {x,y,ttl})，type = heart/anger/zzz/question/star
  // 纯 DOM + CSS 动画（transform/opacity），动画结束自动移除，绝不残留
  const FX_GLYPH = { heart: '💗', anger: '💢', zzz: '💤', question: '❓', star: '⭐' };
  function spawnFx(type, opts) {
    opts = opts || {};
    if (!fxLayer) return;
    const d = document.createElement('div');
    d.className = 'fx fx-' + (FX_GLYPH[type] ? type : 'star');
    d.textContent = FX_GLYPH[type] || FX_GLYPH.star;
    d.style.left = (opts.x != null ? opts.x : 42 + Math.random() * 20) + '%';
    d.style.top = (opts.y != null ? opts.y : 26 + Math.random() * 18) + '%';
    fxLayer.appendChild(d);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, opts.ttl || 1400);
  }

  // 主进程扫描 staging/热更目录后注入素材表（缺席科目保持空 = 层隐藏 = 零回归）
  function registerStageAssets(map) {
    map = map || {};
    STAGE_ASSETS.expr = map.expr || {};
    STAGE_ASSETS.act = map.act || {};
    STAGE_ASSETS.deco = map.deco || {};
  }

  // 逐格扫描 alpha 通道，探测每行真实帧数（图集未公开帧数，空格子全透明 = 不存在该帧）
  async function detectFrameCounts() {
    // 走 IPC 读文件再解码：file:// 图片直接画进 canvas 会因跨源污染读不出像素
    const data = await window.pet.readAsset('spritesheet.webp');
    const bmp = await createImageBitmap(new Blob([data], { type: 'image/webp' }));
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    for (let row = 0; row < ROWS_TOTAL; row++) {
      let count = 0;
      for (let col = 0; col < COLS; col++) {
        const px = ctx.getImageData(col * CELL_W, row * CELL_H, CELL_W, CELL_H).data;
        let opaque = 0;
        for (let i = 3; i < px.length; i += 16) if (px[i] > 8) opaque++; // 每 4 像素抽 1 个
        if (opaque > 30) count = col + 1; else break; // 帧从左连续排列
      }
      frameCounts[row] = Math.max(1, count);
    }
  }

  async function mount(host) {
    // v2.5 图层化：#pet-stage 微动变换层（呼吸/漂浮/拖拽弹簧）内含 body/expr/deco/fx 四层；
    // 既有 act-*/swing/sleep 变换仍瞄准 #sprite，嵌套 transform 相乘互不干扰
    stageEl = document.createElement('div');
    stageEl.id = 'pet-stage';
    el = document.createElement('div');
    el.id = 'sprite';
    el.style.width = CELL_W * SCALE + 'px';
    el.style.height = CELL_H * SCALE + 'px';
    el.style.backgroundImage = "url('assets/spritesheet.webp')";
    el.style.backgroundSize = CELL_W * COLS * SCALE + 'px ' + CELL_H * ROWS_TOTAL * SCALE + 'px';
    el.style.backgroundRepeat = 'no-repeat';
    exprLayer = document.createElement('div');
    exprLayer.id = 'pet-expr';
    decoLayer = document.createElement('div');
    decoLayer.id = 'pet-deco';
    fxLayer = document.createElement('div');
    fxLayer.id = 'pet-fx';
    stageEl.appendChild(el);
    stageEl.appendChild(exprLayer);
    stageEl.appendChild(decoLayer);
    stageEl.appendChild(fxLayer);
    host.appendChild(stageEl);
    await detectFrameCounts();
    return frameCounts;
  }

  window.RemielleSprite = {
    mount, play, gaze, stop, ACTION_ROWS, COMPOSED,
    setExpression, setDeco, spawnFx, registerStageAssets,
    get stageEl() { return stageEl; },
  };
})();
