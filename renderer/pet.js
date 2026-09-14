// 行为状态机：appear 出场 → idle 待机 ⇄ walk 踱步（目标点制）/ teleport 瞬移（全屏 2D）
//              ↘ 45s 无交互 → sleep 百年沉睡（点击唤醒）
//              鼠标：单击=摸头，双击=聊天输入条，按住拖动=被拎起；移入=挥手；右键=菜单
// 形象：官方衍生素材雪碧图帧动画（见 sprite.js 与 NOTICE-CREDITS.md）
(function () {
  const body = document.body;
  const stage = document.getElementById('stage');
  const petWrap = document.getElementById('pet-wrap');
  const bubble = document.getElementById('bubble');
  const uiLayer = document.getElementById('ui-layer');
  const chatBar = document.getElementById('chat-bar');
  const chatInput = document.getElementById('chat-input');
  const sizeBar = document.getElementById('size-bar');
  const sizeRange = document.getElementById('size-range');
  const sizeValue = document.getElementById('size-value');
  const fontBar = document.getElementById('font-bar');
  const fontRange = document.getElementById('font-range');
  const fontValue = document.getElementById('font-value');
  const sprite = window.RemielleSprite;

  // 兜底：渲染层未捕获异常只记日志，绝不让任何一次报错打断行为状态机
  window.addEventListener('error', (e) => console.error('[renderer error]', e.message));
  window.addEventListener('unhandledrejection', (e) => console.error('[renderer rejection]', e.reason));

  // ===== 台词库（角色语气：甜美从容、爱捉弄、称呼「共犯」） =====
  // ===== 台词库（强化人设：神秘狡黠跳脱、共犯宣言、问答游戏梗、大胆暧昧的拉扯） =====
  const QUOTES = {
    appear: [
      '嗯哼哼，调频成功——你的专属共犯，上线♪',
      '久等了。今晚的演出，主角依然是我们俩。',
      '发现了吗？每次重逢，我都比上一次更想出现。',
    ],
    greet: [
      '嗯？有事要吩咐，还是…单纯想见我？',
      '今日问答游戏：你想我了吧？——答对了，不用谢。',
      '别紧张，共犯。好戏才刚开场。',
      '又见面了。你看，我从不失约。',
      '史纲背到哪了？——开玩笑，想聊随时叫我。',
      '呼呼，今天也来见我了吗。',
    ],
    pet: [
      '哎呀~这么喜欢我吗，共犯？',
      '摸头可不在契约范围内哦♪……算了，对共犯特许。',
      '嗯哼，算是认可你的表现了。',
      '再摸的话……羽毛要被你弄乱了啦。',
      '嗯~这里的羽毛，只许共犯一个人摸。',
    ],
    drag: [
      '哎呀共犯，这么心急要去哪呀？',
      '绑架共犯一条……这罪名，我们平分。',
      '放肆～不过，我不讨厌这份勇气哦？',
      '放下我……才怪。再拎一会儿也行。',
    ],
    sleepZzz: 'Zzz…（百年沉睡·第 101 年，梦里也有共犯）',
    teleport: [
      '瞬移可是高阶技能哦，羡慕吗？',
      '嗯，这里的角度不错，就这里了♪',
      '隐身呼吸法，学起来～',
      '别到处找啦，我在这儿呢。',
    ],
    draw: [
      '让我稍微画两笔～',
      '下一笔要画什么呢…',
      '共犯想当模特的话，要收费的哦♪',
      '画好了也不给你看，先吊吊胃口。',
    ],
    poor: [
      '肚子好饿…共犯，画不动了啦…',
      '喉咙干干的…想喝夜巴奶茶…',
      '唔…没力气了，先让我垫垫肚子嘛…',
    ],
    reward: [
      '谢谢主人给的奖励！共犯也要加油哦♪',
      '哇…是真正的奖励，不是画饼！开心！',
      '嘿嘿，被两个人宠着的感觉，还不赖。',
    ],
    'reward-later': [
      '哼，奖励欠着可以，记账了哦。',
      '好吧…下次要双倍补回来哦！',
    ],
    wake: [
      '……醒了？还是说，这正是我期待的重逢呢～',
      '呼嗯……这一觉，刚好睡了一百年。',
      '早安，共犯。做梦梦到我了吗？',
      '百年好短呀，梦还没做完呢。',
    ],
    slouch: [ // 彩蛋④ 摸鱼检测被抓现行的台词（b-dull 锯齿灰调样式）
      '呜……共犯居然背着我在摸鱼，说好一起学习的……',
      '被抓到了哦，摸鱼的小共犯~（眼泪汪汪）',
      '再、再玩下去我可要记在小本本上了！',
      '呜哇，游戏比我好玩吗……（趴倒）',
    ],
  };

  const lastPick = {};
  function pick(key) {
    const arr = QUOTES[key];
    let i = Math.floor(Math.random() * arr.length);
    if (arr.length > 1 && i === lastPick[key]) i = (i + 1) % arr.length;
    lastPick[key] = i;
    return arr[i];
  }

  // 台词条目兼容两种形态：字符串（普通样式）或 {t, s}（s = excited/quiet/dull 情绪样式）
  // 存量 58 条台词保持字符串不动；新增台词才用对象形式打标签
  function bubblePart(v) {
    return typeof v === 'object' && v ? v : { t: String(v), s: '' };
  }
  function applyBubbleStyle(style) {
    bubble.classList.remove('b-excited', 'b-quiet', 'b-dull');
    if (style) bubble.classList.add('b-' + style);
  }

  // ===== 工具 =====
  const timers = new Set();
  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  }
  function clearTimer(t) {
    if (timers.delete(t)) { clearTimeout(t); clearInterval(t); }
  }
  const rand = (a, b) => a + Math.random() * (b - a);

  let state = 'appear';
  let SCALE = 1; // 当前缩放档位（viewport 始终 = 窗口 DIP，stage 内部靠 zoom）
  let cfgFontSize = 14; // UI 层字号（独立于模型缩放）
  let sleepTimer = null;
  let idleTimer = null;
  let walkTimer = null;
  let bubbleTimer = null;
  let typeTimer = null;
  let petClickTimer = null;
  let ignoreMouse = null;
  let oneShotUntil = 0;
  let gazeResumeTimer = null;
  let lastWaveAt = 0;
  let chatBusy = false;
  let petStage = null;   // v2.5 微动/弹簧变换层（sprite.mount 后存在）
  let dragTilt = 0;      // 拖拽弹簧：按水平速度累积的倾斜角（±8°）

  function setState(s) {
    state = s;
    body.className = 'state-' + s;
  }

  function playIdle() {
    sprite.play('idle', { loop: true, fps: 8 });
  }

  // 播一个单次动作，结束后回待机循环
  // 组合动作（sprite.COMPOSED）自带时长（ms），不受外部 durationMs 干扰
  function playOnce(action, durationMs) {
    const composed = sprite.COMPOSED && sprite.COMPOSED[action];
    const ms = composed ? composed.ms : durationMs;
    oneShotUntil = Date.now() + ms + 80;
    sprite.play(action, {
      durationMs: composed ? undefined : durationMs,
      onEnd: () => { if (state === 'idle') playIdle(); },
    });
  }

  function showBubble(text, keepOpen) {
    clearInterval(typeTimer);
    clearTimeout(bubbleTimer);
    const v = bubblePart(text);
    applyBubbleStyle(v.s);
    bubble.textContent = v.t;
    bubble.classList.remove('hidden');
    bubble.classList.add('show');
    if (!keepOpen) {
      bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 3200);
    }
  }

  // 打字机逐字气泡（AI 回复/推送用）；opts.push=true 时用推送紧凑可读样式，opts.style 挂情绪变体
  function showBubbleTyped(text, holdMs, opts) {
    opts = opts || {};
    clearInterval(typeTimer);
    clearTimeout(bubbleTimer);
    bubble.classList.toggle('push', !!opts.push);
    applyBubbleStyle(opts.style || '');
    bubble.textContent = '';
    bubble.classList.remove('hidden');
    bubble.classList.add('show');
    let i = 0;
    typeTimer = setInterval(() => {
      i++;
      bubble.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(typeTimer);
        // 显示时长按文本长度自适应（推送长文多停留）
        bubbleTimer = setTimeout(() => bubble.classList.remove('show'),
          holdMs || Math.min(16000, 4500 + text.length * 55) || 4500);
      }
    }, 30);
  }

  function hideBubble() {
    clearInterval(typeTimer);
    clearTimeout(bubbleTimer);
    bubble.classList.remove('show');
  }

  function scheduleIdle() {
    clearTimer(idleTimer);
    clearTimer(sleepTimer);
    idleTimer = later(nextAction, rand(8000, 16000));
    sleepTimer = later(enterSleep, 45000);
  }

  function enterIdle() {
    if (state === 'sleep') return;
    setState('idle');
    playIdle();
    scheduleIdle();
    scheduleIdleFlavor();
  }

  // 输入条是否开着（开着时暂停自主行动，也不让视线乱飘）
  function anyBarOpen() {
    return chatBar.classList.contains('show') || sizeBar.classList.contains('show') || fontBar.classList.contains('show');
  }

  // 待机小动作：画画/端详 + 帧重组新动作（好奇/伸懒腰/犯困），避免只会干站着
  let flavorTimer = null;
  function scheduleIdleFlavor() {
    clearTimer(flavorTimer);
    flavorTimer = later(() => {
      if (state !== 'idle' || Date.now() < oneShotUntil) return;
      // v2.5 彩蛋② 深夜自言自语：23:00-02:00 偶发困倦表情+Zzz 粒子+小声虚线气泡（每日上限 5 次）
      const hr = new Date().getHours();
      if ((hr >= 23 || hr < 2) && Math.random() < 0.2 && eggAllow('night')) {
        sprite.setExpression('sleepy');
        sprite.spawnFx('zzz', { x: 62, y: 14 });
        showBubble({ t: 'Zzz…共犯还没睡吗…也要早点休息哦…', s: 'quiet' });
        later(() => sprite.setExpression(null), 4200);
        scheduleIdleFlavor();
        return;
      }
      const r = Math.random();
      if (r < 0.35) {
        playOnce('working', rand(4000, 8000)); // 低头画画 4~8s
        if (Math.random() < 0.4) showBubble(pick('draw'));
      } else if (r < 0.5) {
        playOnce('think', rand(2500, 4500)); // 举板端详
      } else if (r < 0.65) {
        playOnce('curious'); // 好奇张望（帧重组）
        if (Math.random() < 0.4) showBubble(pick('curious'));
      } else if (r < 0.75) {
        playOnce('stretch'); // 伸懒腰（帧重组）
        if (Math.random() < 0.3) showBubble(pick('stretch'));
      } else if (r < 0.8) {
        playOnce('drowsy'); // 犯困点头（帧重组）
        if (Math.random() < 0.35) showBubble(pick('drowsy'));
      }
    }, rand(6000, 14000));
  }

  function nextAction() {
    if (state !== 'idle') return;
    if (anyBarOpen()) { scheduleIdle(); return; } // 输入条开着时保持安静等待
    const r = Math.random();
    if (r < 0.3) teleport();
    else if (r < 0.75) walk();
    // 剩下 25% 原地待机，下一轮再决策
  }

  // 目标点制踱步：起步前有短暂犹豫，行走缓入缓出，告别匀速机械步
  async function walk() {
    const wa = await window.pet.workarea();
    if (state !== 'idle') return;
    const margin = 20;
    const minX = wa.x + margin;
    const maxX = wa.x + wa.width - window.innerWidth - margin;
    if (maxX - minX < 40) return; // 窗口几乎占满宽度就不走了
    let target = minX + Math.random() * (maxX - minX);
    if (Math.abs(target - window.screenX) < 200) {
      // 目标离自己太近就没意思了：直接去屏幕另一头
      target = window.screenX > (minX + maxX) / 2 ? minX + 40 : maxX - 40;
    }
    // 起步前的犹豫（保持待机帧），让动作有个"决定"的过程
    later(() => {
      if (state !== 'idle') return;
      setState('walk');
      const dir = target >= window.screenX ? 1 : -1;
      sprite.play(dir > 0 ? 'running-right' : 'running-left', { loop: true, fps: 10 });
      let elapsed = 0;
      walkTimer = later(function tick() {
        elapsed += 16;
        const remain = Math.abs(target - window.screenX);
        // 60Hz 逐帧小步进（旧 46ms/步仅 22fps，肉眼可见顿挫）；缓入缓出曲线与总速度同旧版
        const speed = Math.max(0.25, Math.min(1.6, elapsed / 31, remain / 9));
        window.pet.moveBy(dir * speed, 0);
        if (remain <= 2) { enterIdle(); return; }
        walkTimer = later(tick, 16);
      }, 0);
      later(() => {
        if (state === 'walk') { clearTimer(walkTimer); enterIdle(); }
      }, 22000);
    }, rand(250, 700));
  }

  // 全屏 2D 瞬移（蕾米的招牌）：60% 落地面带，40% 落工作区任意位置（含屏幕上部）
  async function teleport() {
    if (state === 'sleep' || state === 'drag') return;
    const wa = await window.pet.workarea();
    petWrap.style.opacity = '0';
    later(async () => {
      const groundY = wa.y + wa.height - window.innerHeight;
      let tx, ty;
      if (Math.random() < 0.6) {
        ty = groundY;
      } else {
        ty = wa.y + 20 + Math.random() * Math.max(1, groundY - wa.y - 20);
      }
      tx = wa.x + Math.random() * Math.max(1, wa.width - window.innerWidth);
      window.pet.setPosition(tx, ty);
      later(() => {
        petWrap.style.opacity = '';
        enterIdle();
        if (Math.random() < 0.3) showBubble(pick('teleport')); // 落地偶尔来一句，惊喜感
      }, 160);
    }, 160);
  }

  function enterSleep() {
    if (state === 'sleep' || state === 'drag') return;
    clearTimer(walkTimer);
    closeChat();
    setState('sleep');
    sprite.play('failed', { loop: true, fps: 3 }); // 垂头姿势 + 慢速播放当打盹
    showBubble(QUOTES.sleepZzz, true);
  }

  function wake() {
    hideBubble();
    setState('idle');
    showBubble(pick('wake'));
    playOnce('smug', 840);
    scheduleIdle();
  }

  // ===== 出场序列（缩放浮现，无转场特效） =====
  function appear() {
    body.classList.add('reveal');
    oneShotUntil = Date.now() + 780;
    sprite.play('waving', {
      durationMs: 700,
      onEnd: () => { if (state === 'appear') playIdle(); },
    });
    later(() => showBubble(pick('appear')), 1100);
    later(enterIdle, 4300);
  }

  // ===== 提醒输入条（聊天已迁往独立聊天窗，这里只负责「添加提醒」） =====
  function openChat() {
    if (state === 'sleep' || chatBusy) return;
    sizeBar.classList.remove('show');
    barOpenAt = Date.now();
    chatInput.placeholder = '例如：30m 喝水 或 14:30 开会';
    chatBar.classList.add('show');
    setTimeout(() => chatInput.focus(), 60);
  }
  function closeChat() {
    chatBar.classList.remove('show');
    chatInput.blur();
    sizeBar.classList.remove('show'); // 几条互斥
    fontBar.classList.remove('show');
  }

  // ===== 尺寸滑条 =====
  let sizeThrottle = 0;
  let barOpenAt = 0;
  function openSizeBar() {
    if (state === 'sleep' || chatBusy) return;
    chatBar.classList.remove('show');
    chatInput.blur();
    barOpenAt = Date.now();
    sizeRange.value = SCALE;
    sizeValue.textContent = Number(SCALE).toFixed(2) + 'x';
    sizeBar.classList.add('show');
  }
  sizeRange.addEventListener('input', () => {
    const s = Number(sizeRange.value);
    sizeValue.textContent = s.toFixed(2) + 'x';
    const now = Date.now();
    if (now - sizeThrottle > 180) { // 拖动时节流，避免密集改窗口
      sizeThrottle = now;
      window.pet.setScale(s);
    }
  });
  sizeRange.addEventListener('change', () => {
    window.pet.setScale(Number(sizeRange.value)); // 松手最终提交
  });
  sizeRange.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') sizeBar.classList.remove('show');
  });

  // ===== 字号滑条（不随模型缩放，独立持久化） =====
  let fontThrottle = 0;
  function openFontBar() {
    if (state === 'sleep' || chatBusy) return;
    closeChat();
    sizeBar.classList.remove('show');
    fontRange.value = cfgFontSize;
    fontValue.textContent = cfgFontSize + 'px';
    fontBar.classList.add('show');
  }
  fontRange.addEventListener('input', () => {
    const px = Number(fontRange.value);
    fontValue.textContent = px + 'px';
    uiLayer.style.fontSize = px + 'px'; // 实时预览
    const now = Date.now();
    if (now - fontThrottle > 250) { fontThrottle = now; window.pet.setFontSize(px); }
  });
  fontRange.addEventListener('change', () => {
    window.pet.setFontSize(Number(fontRange.value)); // 松手最终提交
  });
  fontRange.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fontBar.classList.remove('show');
  });
  document.getElementById('font-close').addEventListener('click', () => fontBar.classList.remove('show'));

  // ✕ 按钮：无论有没有输入都能直接关掉
  document.getElementById('chat-close').addEventListener('click', closeChat);
  document.getElementById('size-close').addEventListener('click', () => sizeBar.classList.remove('show'));

  // 失焦自动收起（点击桌宠其他部位或别的窗口时；稍延迟避免误关）
  chatInput.addEventListener('blur', () => {
    later(() => {
      if (document.activeElement !== chatInput) closeChat();
    }, 180);
  });
  sizeRange.addEventListener('blur', () => {
    later(() => {
      if (document.activeElement !== sizeRange) sizeBar.classList.remove('show');
    }, 180);
  });

  // 兜底看门狗：这个透明窗口的 focus/blur 事件不可靠（实测可能是空操作），
  // 输入条开着但 90 秒无输入且没在等回复 → 自动收起，绝不吊死在屏幕上
  later(function barSweep() {
    if (chatBar.classList.contains('show') && !chatBusy && !chatInput.value &&
        Date.now() - barOpenAt > 90000) {
      closeChat();
    }
    if (sizeBar.classList.contains('show') && Date.now() - barOpenAt > 90000) {
      sizeBar.classList.remove('show');
    }
    later(barSweep, 1000);
  }, 5000);
  chatInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { closeChat(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = chatInput.value.trim();
    if (!t) { closeChat(); return; } // 空输入按 Enter = 收起输入条
    if (chatBusy) return;
    chatInput.value = '';
    const r = await window.pet.reminderAdd(t);
    if (r.error) {
      showBubble('没看懂时间呢…试试「30m 喝水」或「14:30 开会」');
    } else {
      const mins = Math.max(1, Math.round((r.at - Date.now()) / 60000));
      showBubble('好的，共犯，' + mins + ' 分钟后记得哦♪');
      playOnce('waving', 700);
    }
    closeChat();
  });

  // ===== 鼠标交互 =====
  let panning = false;
  let moved = 0;

  function doPet() {
    closeChat(); // 摸头时顺手收起输入条
    setState('idle');
    scheduleIdle();
    clickComboTick(); // v2.5 彩蛋：快速连击暴走（含每日上限）
    window.pet.feedback(2); // 摸头=心情+2（养成联动，30s 冷却在主进程）
    const shy = Math.random() < 0.3; // 帧重组：偶尔害羞遮脸
    if (shy) showBubble(pick('shy'));
    else if (poorMode && Math.random() < 0.5) showBubble(pick('poor'));
    else showBubble(pick('pet'));
    playOnce(shy ? 'shy' : 'smug', 840);
  }

  // ===== v2.5 彩蛋① 快速连击暴走：2.5s 内连点 6/8/10 次递进表情，第 10 次怒气符号+屏幕微抖 =====
  // 每日完整触发上限 5 次（eggAllow 记账），超过保持普通摸头——稀缺才有惊喜感
  let comboCount = 0, comboAt = 0;
  function eggAllow(key) {
    try {
      const k = 'egg-' + key + '-' + new Date().toDateString();
      const n = Number(localStorage.getItem(k) || 0);
      if (n >= 5) return false;
      localStorage.setItem(k, String(n + 1));
      return true;
    } catch (_e) { return Math.random() < 0.5; }
  }
  function clickComboTick() {
    const now = Date.now();
    if (now - comboAt > 2500) comboCount = 0;
    comboAt = now;
    comboCount++;
    if (comboCount < 6 || !eggAllow('rage')) return;
    const stage = comboCount >= 10 ? 3 : comboCount >= 8 ? 2 : 1;
    sprite.setExpression(['surprise', 'shy', 'angry'][stage - 1]);
    if (stage >= 2) showBubble({ t: stage === 3 ? '够了哦，共犯……再点真的要生气了！' : '点、点什么呢……', s: 'excited' });
    if (stage === 3) {
      sprite.spawnFx('anger', { x: 56, y: 16 });
      document.body.classList.add('shake-screen');
      setTimeout(() => document.body.classList.remove('shake-screen'), 450);
      later(() => sprite.setExpression(null), 2600);
      comboCount = 0;
    }
  }

  petWrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (state === 'sleep') { wake(); return; }
    if (state === 'appear') return;
    panning = true;
    moved = 0;
    clearTimer(idleTimer);
    clearTimer(sleepTimer);
    e.preventDefault();
  });

  // 单击（非拖动）= 摸头；延迟 260ms 确认不是双击
  window.addEventListener('mouseup', () => {
    if (!panning) return;
    panning = false;
    if (state === 'drag') {
      if (petStage) { // v2.5 拖拽弹簧：松手 squash-stretch 回弹（倾斜起点由拖拽速度决定）
        petStage.style.setProperty('--tilt', dragTilt.toFixed(2) + 'deg');
        petStage.style.transform = '';
      }
      dragTilt = 0;
      enterIdle(); // setState 会重写 body.className，spring-back 必须挂在其后，否则同帧被抹掉
      if (petStage) {
        document.body.classList.add('spring-back');
        setTimeout(() => document.body.classList.remove('spring-back'), 460);
      }
    } else if (moved <= 8 && (state === 'idle' || state === 'walk')) {
      clearTimer(walkTimer); // 别让摸头期间还在滑步
      setState('idle');
      scheduleIdle();
      clearTimer(petClickTimer);
      petClickTimer = later(doPet, 260);
    }
  });

  // 双击 = 得意庆祝（偶尔蹦跳）+ 打开聊天窗（对齐作者 double_click → 庆祝的映射）
  petWrap.addEventListener('dblclick', () => {
    clearTimer(petClickTimer);
    clearTimer(walkTimer);
    if (state === 'sleep' || state === 'appear') return;
    setState('idle');
    scheduleIdle();
    const bouncy = Math.random() < 0.3; // 帧重组：偶尔蹦跳
    playOnce(bouncy ? 'bounce' : 'smug', 840);
    if (bouncy) showBubble(pick('bounce'));
    window.pet.openChatWindow('chat');
  });

  // 鼠标移入 = 挥手打招呼（对齐作者 pointer_enter 映射，冷却 10s）
  // v2.5 彩蛋③ 鼠标躲猫猫：快速逼近 → 歪头帧+蹦跳跳开（每日上限，缓慢移动仍正常挥手）
  let lastMouse = { x: 0, y: 0, t: 0 };
  window.addEventListener('mousemove', (e) => {
    const now = Date.now();
    const dt = now - lastMouse.t;
    if (dt > 0 && dt < 200) {
      lastMouse.v = Math.hypot(e.screenX - lastMouse.x, e.screenY - lastMouse.y) / dt;
    }
    lastMouse = { x: e.screenX, y: e.screenY, t: now, v: lastMouse.v };
  });
  petWrap.addEventListener('mouseenter', () => {
    if (state !== 'idle' || Date.now() < oneShotUntil) return;
    if (lastMouse.v > 1.1 && eggAllow('dodge')) { // 快速逼近：歪头+蹦跳跳开
      playOnce('act-tilt-1', 900);
      later(() => { if (state === 'idle') playOnce('bounce'); }, 950);
      return;
    }
    if (Date.now() - lastWaveAt < 10000) return;
    lastWaveAt = Date.now();
    playOnce('waving', 700);
  });

  window.addEventListener('mousemove', (e) => {
    // 拖拽：窗口跟随鼠标（movement 累计量用于区分点击）
    if (panning && (state === 'idle' || state === 'walk' || state === 'drag')) {
      moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (moved > 8 && state !== 'drag') {
        setState('drag');
        sprite.play('waiting', { loop: true, fps: 6 }); // 歪头等待脸
        showBubble(pick('drag'));
      }
      if (state === 'drag') {
        window.pet.moveBy(e.movementX, e.movementY);
        if (petStage) { // v2.5 拖拽弹簧：按水平速度方向倾斜（transform-only，无 layout 动画）
          dragTilt = Math.max(-8, Math.min(8, dragTilt * 0.82 + e.movementX * 0.5));
          petStage.style.transform = 'rotate(' + dragTilt.toFixed(2) + 'deg)';
        }
      }
    }
    // 透明区域放行点击给桌面（输入条也算桌宠区域，否则没法点）
    const over = !!(e.target && e.target.closest && e.target.closest('#pet-wrap, #chat-bar, #size-bar, #font-bar'));
    if (over !== ignoreMouse) {
      ignoreMouse = over;
      window.pet.setIgnoreMouse(!over);
    }
  });

  petWrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.pet.contextMenu();
  });

  // ===== 右键菜单动作 =====
  window.pet.onAction((action, ms) => {
    if (action === 'greet') {
      if (state === 'sleep') {
        wake();
        later(() => showBubble(pick('greet')), 3400);
      } else {
        setState('idle');
        scheduleIdle();
        showBubble(pick('greet'));
        playOnce('waving', 700);
      }
    } else if (action === 'sleep') {
      if (state !== 'sleep') enterSleep();
    } else if (action === 'working') {
      // 养成·打工：聊天窗发起，本体切画画/学习动画（时长由类型决定）
      clearTimer(idleTimer); clearTimer(sleepTimer); clearTimer(walkTimer);
      closeChat();
      setState('idle');
      sprite.play('working', { loop: true, fps: 6 });
      showBubble(pick('draw'), true);
      later(() => { if (state !== 'sleep') { playIdle(); scheduleIdle(); } }, (ms || 45000) + 1000);
    } else if (action === 'reward-request') {
      // 养成·真人奖励：升级后提醒发放人（男主人）发奖励，发放入口在聊天窗养成页
      if (state === 'sleep') wake();
      showBubble('升级啦♪ 快让男主人发奖励呀，共犯～', true);
      playOnce('waving', 700);
    } else if (action === 'reward-got') {
      setState('idle');
      showBubble(pick('reward'));
      playOnce('smug', 840);
    } else if (action === 'reward-later') {
      showBubble(pick('reward-later'));
      playOnce('failed', 700);
    } else if (action === 'reminder-add') {
      openChat();
    } else if (action === 'chat-window') {
      window.pet.openChatWindow('chat');
    } else if (action === 'guide') {
      window.pet.openChatWindow('guide');
    } else if (action === 'size-bar') {
      openSizeBar();
    } else if (action === 'font-bar') {
      openFontBar();
    }
  });

  // ===== 提醒到点 =====
  window.pet.onReminderFired((text) => {
    if (state === 'sleep') wake();
    showBubble('⏰ 共犯，' + text, false);
    playOnce('smug', 840);
  });

  // ===== 推送（气泡只当提醒，完整内容进聊天窗消息流；帧重组：拍手庆祝） =====
  window.pet.onPush((it) => {
    if (state === 'sleep') wake();
    showBubbleTyped(it.title + (it.body ? '\n' + it.body : ''), 0, { push: true });
    playOnce('clap');
  });

  // ===== 彩蛋④ 摸鱼检测（主进程扫到游戏/抖音进程抓现行）：哭脸+锯齿灰调气泡（b-dull 首个使用方） =====
  window.pet.onSlouch((procName) => {
    if (!eggAllow('slouch')) return; // 每日上限 5 次，与主进程 2h 节流双保险
    if (state === 'sleep') wake();
    showBubbleTyped(pick('slouch') + (procName ? `\n（${procName}）` : ''), 0, { style: 'dull' });
    sprite.setExpression('cry');
    later(() => sprite.setExpression(null), 4200);
  });

  // ===== 视线跟随（仅待机时；单次动作期间让位） =====
  window.pet.onGaze((angle) => {
    if (state !== 'idle' || Date.now() < oneShotUntil || chatBar.classList.contains('show')) return;
    sprite.gaze(angle);
    clearTimeout(gazeResumeTimer);
    gazeResumeTimer = setTimeout(() => {
      if (state === 'idle' && Date.now() >= oneShotUntil) playIdle();
    }, 2500);
  });

  // ===== 启动 =====
  let poorMode = false; // 养成联动：饿了/渴了/没电了 → 概率说委屈台词
  function refreshPoor() {
    window.pet.nurtureState().then((s) => { poorMode = !!s.poor; }).catch(() => {});
  }
  refreshPoor();
  setInterval(refreshPoor, 60000);
  window.pet.getConfig().then((c) => {
    SCALE = Math.min(2, Math.max(0.5, c.scale || 1));
    stage.style.zoom = SCALE; // #stage 固定 340x420 基础尺寸，zoom 负责整体缩放
    cfgFontSize = Math.min(20, Math.max(12, c.fontSize || 14));
    uiLayer.style.fontSize = cfgFontSize + 'px';
  }).catch(() => {});
  window.pet.onScale((s) => {
    SCALE = s;
    stage.style.zoom = s;
  });
  sprite
    .mount(petWrap)
    .then(async () => {
      petStage = document.getElementById('pet-stage');
      // v2.5 素材注册：主进程扫描 staging/ready（后续加热更目录），缺席=表情/动作层隐藏=零回归
      try {
        const sa = await window.pet.stageAssets();
        sprite.registerStageAssets(sa || {});
      } catch (_e) { /* 扫描失败也照常运行 */ }
      // 合并 DeepSeek 离线生成的扩充台词（scripts/gen-quotes.js 产物）；
      // 文件缺失/坏 JSON 静默回退内置台词，绝不阻塞出场
      try {
        const data = await window.pet.readAsset('quotes-extended.json');
        const ext = JSON.parse(new TextDecoder().decode(data));
        for (const [k, lines] of Object.entries(ext)) {
          if (!Array.isArray(lines) || !lines.length) continue;
          QUOTES[k] = QUOTES[k] ? QUOTES[k].concat(lines) : lines;
        }
      } catch (_e) { /* 无扩充文件也照常运行 */ }
      appear();
    })
    .catch((err) => {
      bubble.classList.remove('hidden');
      bubble.textContent = '素材加载失败：' + (err && err.message ? err.message : err);
      bubble.classList.add('show');
    });
})();
