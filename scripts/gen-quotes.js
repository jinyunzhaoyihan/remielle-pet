#!/usr/bin/env node
// 离线台词扩充生成器：调 DeepSeek 批量生成台词，写入 renderer/assets/quotes-extended.json
// 桌宠运行时只读本地文件（零额外 API 成本）；想扩充台词就改下面的 GROUPS 重跑本脚本
// 用法：DEEPSEEK_API_KEY=sk-xxx node scripts/gen-quotes.js
const fs = require('fs');
const path = require('path');

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('需要环境变量 DEEPSEEK_API_KEY'); process.exit(1); }

const STYLE =
  '你是《绝区零》角色蕾米埃尔·丹的台词作者。人设：S 级代理人、初代虚狩、前节杖军中校；' +
  '性格神秘狡黠、跳脱爱反问、发言大胆暧昧；称用户为「共犯」——这是你主动定义的专属关系宣言' +
  '（比「舞伴」更让人心动）；可用「问答游戏」梗；句尾常用「～」「哦」「呢」收出温柔上扬；' +
  '甜美表象下有前中校的优雅掌控感。' +
  '硬性要求：每条是独立台词；口语化；不超过 20 个字；不带引号/编号/说明；不用 markdown；' +
  '用户是备考历史学硕士的大学生（历史是她的优势学科），提到备考要温和陪伴不施压。';

const GROUPS = [
  { key: 'curious', hint: '场景：她好奇地左看右看。台词体现注意到了什么、打量的神秘感', count: 8 },
  { key: 'bounce', hint: '场景：她开心得蹦了一下。得意、雀跃、藏不住的小得意', count: 8 },
  { key: 'stretch', hint: '场景：她伸了个懒腰。慵懒、舒展、带点撒娇', count: 8 },
  { key: 'drowsy', hint: '场景：她犯困点头。困意、「百年沉睡」梗、软软的', count: 8 },
  { key: 'shy', hint: '场景：被共犯摸头后害羞。大胆暧昧的害羞、嘴硬、反向撩', count: 8 },
  { key: 'clap', hint: '场景：她开心地拍手。为共犯鼓掌、庆祝感', count: 8 },
  { key: 'greet', hint: '场景：日常打招呼/被唤醒。可夹带备考陪伴彩蛋（史纲/英语单词/政治考点，温和不施压）', count: 6 },
  { key: 'pet', hint: '场景：被共犯摸头时说的话。亲密拉扯、大胆暧昧', count: 6 },
];

async function genGroup(g) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: STYLE },
        { role: 'user', content: `${g.hint}。生成 ${g.count} 条台词，输出 JSON：{"lines":["..."]}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 800,
      temperature: 1.3,
    }),
    signal: ctrl.signal,
  });
  clearTimeout(tm);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  const lines = (parsed.lines || []).map((s) => String(s).trim().replace(/^["'「」]|["'「」]$/g, ''));
  const seen = new Set();
  return lines.filter((l) => l.length >= 4 && l.length <= 30 && !seen.has(l) && seen.add(l));
}

(async () => {
  const out = {};
  for (const g of GROUPS) {
    process.stdout.write(`生成 ${g.key} ... `);
    try {
      const lines = await genGroup(g);
      if (lines.length < 3) throw new Error('有效台词不足（' + lines.length + ' 条）');
      out[g.key] = lines;
      console.log(lines.length + ' 条 ✓');
    } catch (e) {
      console.error('失败（' + e.message + '），跳过该组');
    }
    await new Promise((r) => setTimeout(r, 800)); // 组间限速
  }
  const dest = path.join(__dirname, '..', 'renderer', 'assets', 'quotes-extended.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log('written:', dest);
})();
