# Remielle Pet（蕾米埃尔桌宠）

绝区零·蕾米埃尔·丹（Remiel Dan）Q 版桌面宠物 —— Windows 透明置顶 Electron 应用：帧动画桌宠 + AI 陪聊 + 养成 + 考研闯关答题 + 抽卡调频 + 存档云端备份 + 题库热更通道。

> 这是一个把「桌面宠物 × 学习陪伴 × 现实奖励」揉在一起的礼物型项目，开源出来供学习与二次改造。

## 功能一览

- **桌宠本体**：帧动画（雪碧图 alpha 扫描探测帧数）、视线跟随、目标点踱步、瞬移、拖拽弹簧回弹、微动呼吸漂浮、百年沉睡；摸头/连击/深夜台词/躲猫猫/摸鱼检测四彩蛋
- **AI 陪聊**：DeepSeek 流式 SSE + 联网搜索 + 深度思考模式 + 角色知识库注入 + 32 条历史
- **养成**：四状态条衰减、商店喂食、打工三选一、每日任务、升级称号、成就徽章
- **备考闯关**：历史/英语/政治三科（562 题）、每日限量、难度自适应滑窗、周全勤奖励；题库经 validator + ajv + 人工审校三道关
- **抽卡调频**：S/A/B 三级现实奖励凭证（机制对标主流二游：90 硬保底 + 软保底 + 大保底）
- **管理员面板**：PIN（scrypt）+ 存档备份/恢复/导出 + 兑现确认制 + 热更历史
- **热更通道**：题库/台词免重装更新（sha256 → ajv → 结构查重三道关，失败自动回滚，绝不阻塞启动）
- **存档安全**：原子写 + sha256 sidecar + 滚动备份 50 份 + 损坏自愈 + 可选云端备份（私有 GitHub 仓库）
- **HUD 大屏**：立绘舞台 + 仪表盘；**移动面板**：手机扫码只读监控（SSE 实时）
- **定时提醒**、**推送**（金句+新闻）、**开机自启**、**单实例锁**

## 运行

前置：Node.js（含 npm）；AI 陪聊需要环境变量 `DEEPSEEK_API_KEY`。

```bash
npm install            # 安装依赖
npm run get-electron   # 下载 Electron 二进制
npm start              # 启动桌宠
```

**素材自备**：因版权原因（角色形象为《绝区零》官方素材之 AI 重绘衍生，仅限非商业同人使用），本仓库不含雪碧图与立绘。请自行获取 `spritesheet.webp`（8 列 × 11 行，格 192×208）放入 `renderer/assets/`，应用即可正常渲染；也可阅读 `renderer/sprite.js` 适配你自己的角色图集。

## 打包

```bash
npm run icon           # 导出应用图标
npm run dist           # 单文件免安装 exe → dist/
```

## 题库热更通道（维护者）

```bash
node tools/quiz-validate.js          # 题库校验（入库必跑）
node tools/push-hotfix.js            # 生成热更包（manifest+data，dry-run）
node tools/push-hotfix.js --push     # 推送到 GitHub 仓库（需已配 remote）
node tools/hotfix-drill.js serve|scenario N|judge   # 四用例端到端演练
```

客户端触发时机：启动 +3s / 每日 09:00 / 管理面板手动。校验链、回滚与排障详见 `docs/HANDOVER.md`。

## 存档云端备份（可选）

配置环境变量 `GITHUB_TOKEN`（fine-grained，仅授权私有仓 Contents RW）后，管理面板可手动上传/恢复存档到你的**私有**仓库；每日 09:00 自动备份。存档只含养成数据，聊天记录从不落盘。

## 目录结构

见 `docs/HANDOVER.md`（架构速览 + IPC 通道表 + 热更运维）。

## License

代码以 [MIT](LICENSE) 提供。角色形象素材版权归 miHoYo/HoYoverse 所有，本仓库**不包含**任何游戏素材文件；使用本项目衍生的素材内容请遵守官方创作者条例，仅限非商业用途。
