// 移动监控单页：手机浏览器打开的只读面板（ZZZ 粉深色，实时 SSE）。
// __TOKEN__ 由服务端替换为配对令牌；__I18N__ 注入双端术语表（resources/i18n-pet.json，P1-5）。
module.exports = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>蕾米 · 移动监控</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: "Microsoft YaHei", sans-serif; background: radial-gradient(120% 90% at 20% 0%, #241631 0%, #15101b 60%); color: #ffe3f0; min-height: 100vh; padding: 16px 14px 40px; }
h1 { font-size: 17px; color: #ff9ec7; margin-bottom: 4px; }
.sub { font-size: 12px; color: rgba(255,227,240,0.6); margin-bottom: 14px; }
.card { background: rgba(255,134,184,0.06); border: 1px solid rgba(255,134,184,0.22); border-radius: 14px; padding: 12px 14px; margin-bottom: 12px; }
.wallet { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.wallet span { font-size: 13px; color: #ffd76e; background: rgba(255,215,110,0.08); border: 1px solid rgba(255,215,110,0.3); border-radius: 999px; padding: 3px 12px; }
.stat { margin-bottom: 9px; }
.stat .lab { display: flex; justify-content: space-between; font-size: 12px; color: rgba(255,227,240,0.7); margin-bottom: 4px; }
.bar { height: 12px; background: rgba(255,134,184,0.12); border-radius: 6px; overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 6px; transition: width 0.6s; }
.bar i.low { background: linear-gradient(90deg,#ff4d4d,#ff8a8a) !important; animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: 0.55; } }
h2 { font-size: 14px; color: #ff9ec7; margin: 16px 0 8px; }
.evt { padding: 9px 12px; border-radius: 10px; background: rgba(255,134,184,0.07); border: 1px solid rgba(255,134,184,0.2); margin-bottom: 7px; font-size: 14px; line-height: 1.55; animation: slide 0.3s ease; }
@keyframes slide { from { opacity: 0; transform: translateY(8px); } }
.evt .t { color: #ffd76e; font-weight: bold; }
.evt .time { font-size: 11px; color: rgba(255,227,240,0.55); text-align: right; margin-top: 3px; }
.empty { text-align: center; color: rgba(255,227,240,0.55); font-size: 14px; padding: 20px 0; }
.wrow { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(255,134,184,0.07); margin-bottom: 6px; font-size: 14px; }
.wrow .tag { margin-left: auto; font-size: 11px; padding: 2px 10px; border-radius: 999px; flex: none; }
.wrow .tag.held { background: rgba(125,255,138,0.12); color: #7dff8a; border: 1px solid rgba(125,255,138,0.3); }
.wrow .tag.used { background: rgba(255,255,255,0.06); color: rgba(255,227,240,0.6); border: 1px solid rgba(255,255,255,0.1); }
.live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #7dff8a; margin-right: 5px; animation: pulse 1.2s infinite; }
.off { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #ff8a8a; margin-right: 5px; }
</style>
</head>
<body>
<h1>🎀 蕾米埃尔 · 移动监控</h1>
<div class="sub"><span id="conn" class="live"></span>实时连接 · 只读监控面板</div>

<div class="card">
  <div class="wallet">
    <span>🪙 菲林 <b id="fil">-</b></span>
    <span>🎞 原装母带 <b id="std">-</b></span>
    <span>🔐 加密母带 <b id="enc">-</b></span>
    <span>💰 丁尼 <b id="money">-</b></span>
  </div>
  <div class="stat"><div class="lab"><span>🍚 饱食</span><span id="food-n">-</span></div><div class="bar"><i id="food" style="width:0;background:linear-gradient(90deg,#ff9a5a,#ffb88a)"></i></div></div>
  <div class="stat"><div class="lab"><span>🥤 口渴</span><span id="drink-n">-</span></div><div class="bar"><i id="drink" style="width:0;background:linear-gradient(90deg,#5ac8ff,#8ad8ff)"></i></div></div>
  <div class="stat"><div class="lab"><span>💗 心情</span><span id="feel-n">-</span></div><div class="bar"><i id="feel" style="width:0;background:linear-gradient(90deg,#ff5ad2,#ff9ade)"></i></div></div>
  <div class="stat"><div class="lab"><span>⚡ 精力</span><span id="energy-n">-</span></div><div class="bar"><i id="energy" style="width:0;background:linear-gradient(90deg,#7dff8a,#b8ffbf)"></i></div></div>
</div>

<h2>⚡ 实时事件流</h2>
<div id="events"><div class="empty">等待事件…（抽卡/投喂/登录都会出现在这里）</div></div>

<h2>📦 奖品仓库</h2>
<div id="warehouse"><div class="empty">还没有奖品，去调频抽一发？</div></div>

<script>
const I18N = __I18N__ || {};
function tt(k, fb) { return I18N[k] || fb; }
const token = location.pathname.split('/')[2];
const es = new EventSource('/t/' + token + '/events');
const connEl = document.getElementById('conn');
es.onopen = () => { connEl.className = 'live'; };
es.onerror = () => { connEl.className = 'off'; };
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function pad(v) { return String(v).padStart(2, '0'); }
function now() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function renderState(st) {
  document.getElementById('fil').textContent = st.fil;
  document.getElementById('std').textContent = st.stdTapes;
  document.getElementById('enc').textContent = st.encTapes;
  document.getElementById('money').textContent = st.money;
  for (const k of ['food', 'drink', 'feel', 'energy']) {
    const v = Math.round(st[k]);
    document.getElementById(k).style.width = v + '%';
    document.getElementById(k).className = v < 20 ? 'low' : '';
    document.getElementById(k + '-n').textContent = v + '/100';
  }
  renderWarehouse(st.warehouse || []);
}
function renderWarehouse(list) {
  const el = document.getElementById('warehouse');
  if (!list.length) { el.innerHTML = '<div class="empty">' + tt('warehouse.empty', '还没有奖品，去调频抽一发？') + '</div>'; return; }
  el.innerHTML = list.map(w =>
    '<div class="wrow"><span>' + esc(w.name) + '</span><span class="tag ' + w.status + '">' +
    (w.status === 'held' ? tt('warehouse.held', '持有') : tt('warehouse.used', '已兑现')) + '</span></div>').join('');
}
function addEvent(icon, html) {
  const box = document.getElementById('events');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const d = document.createElement('div');
  d.className = 'evt';
  d.innerHTML = '<span class="t">' + icon + '</span>' + html + '<div class="time">' + now() + '</div>';
  box.prepend(d);
  while (box.children.length > 40) box.lastChild.remove();
}
es.addEventListener('message', (e) => {
  try {
    const d = JSON.parse(e.data);
    if (d.type === 'hello') { renderState(d.state); return; }
    if (d.type === 'pull') {
      const ups = (d.results || []).filter((r) => r.up).map((r) => r.name);
      addEvent('🎰', (d.pool || '') + '抽卡：' + (d.results || []).length + ' 连' + (d.gotUP ? '（出 UP ' + ups.join('、') + '！）' : ''));
      if (d.state) renderState(d.state);
    } else if (d.type === 'feed') {
      addEvent('🍼', '投喂了 ' + esc(d.item || ''));
      if (d.state) renderState(d.state);
    } else if (d.type === 'login') {
      addEvent('📅', '每日登录（本月第 ' + d.days + ' 天）');
    } else if (d.type === 'state-low') {
      addEvent('⚠️', esc((d.name || '') + '只剩 ' + d.val + '，' + (d.act || '要照顾一下') + '！'));
    }
  } catch (_) {}
});
function loadState() {
  fetch('/t/' + token + '/api/state').then((r) => r.json()).then((st) => {
    renderState(st);
    const box = document.getElementById('events');
    (st.history || []).slice(0, 10).reverse().forEach((h) => {
      addEvent(h.pool === 'lim' ? '🎰✨' : '🎰', h.tier + ' · ' + esc(h.name) + (h.up ? ' ★UP' : ''));
    });
  }).catch(() => {});
}
loadState();
</script>
</body>
</html>`;
