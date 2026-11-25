# Syu · 群聊守卫机器人

一个 QQ 群聊守卫机器人：**本地规则分诊 → 本地小模型粗筛 → 只把需要判定的消息送云端终审 → 按严重度处置**。
核心约束是三个数：云端调用量要压住（预算硬上限）、误伤要压住（置信度门槛 + 冷却 + 豁免）、群主要看得懂（处置文案只写群规条款，不暴露内部代号）。

- 运行时：Node.js >= 22.18（`package.json` 的 `engines`），唯一运行时依赖 `ws`
- 协议端：NapCat（OneBot v11 正向 WebSocket，默认 `ws://127.0.0.1:3002`）
- 本地模型：Ollama（`/api/chat`，示例 `qwen3:8b`）
- 终审：DeepSeek 兼容接口（默认 `deepseek-chat`），Key 只从 `.env` 读
- 管理端：本机控制台 `http://127.0.0.1:8789`（只监听回环）

## 目录

- [它做什么](#它做什么)
- [一条消息的判定顺序](#一条消息的判定顺序)
- [模块地图](#模块地图)
- [数据与落盘](#数据与落盘)
- [配置](#配置)
- [快速上手](#快速上手)
- [脚本与测试](#脚本与测试)
- [文档索引](#文档索引)
- [入库纪律](#入库纪律)
- [已知边界](#已知边界)

## 它做什么

三个通道，按"漏检代价"分工：

| 通道 | 由谁判 | 何时走这条 | 成本 |
|---|---|---|---|
| 直通云 | DeepSeek 终审 | 命中 `redline` / `rules.*` 关键词、命中链接词、或 @机器人举报 | 每次一次云端调用，计入预算 |
| 本地确认 | Ollama 粗筛 → 需要才上云 | 命中 `gated` 词（本地先确认真伪，降低误伤） | 本地算力，命中可疑才花云端钱 |
| 只记录 | 规则层 | 命中 `recordOnly` 词、纯图片消息、粗筛 clean 且未抽中 | 零云端成本，只写 `violations.jsonl` |

关键词命中不等于定罪：命中只是"值得看一眼"，档位、置信度、是否出手全部由终审返回，低于 `thresholds` 的一律降为只记录。词表分四档（`redline` 直通云 / `rules.*` 直通云 / `gated` 本地确认 / `hints` 只作粗筛提示 / `recordOnly` 只记录），另有报警词 `alarm`、`softAlarm` 直通云。真实词表只在本机 `config.json`，仓库里只有 `keywords.example.json` 与 `config.example.json`。

## 一条消息的判定顺序

`src/guard/pipeline.ts` 的 `handleMessage()` 按下面顺序短路，前一步命中就不再往下走：

| # | 判断 | 命中后 |
|---|---|---|
| 1 | 入环形缓冲（最近 30 条，供上下文取证） | 继续 |
| 2 | 豁免名单（自己 / 主人 / 管理员 / 白名单 / 群主 / 群管理员角色） | 直接放过 |
| 3 | 玩笑白名单（`exemptPhrases` 全是套话） | 直接放过 |
| 4 | 「艹」类口头语 | 直接放过 |
| 5 | 词表扫描 → `mustJudge` 命中（`keyword` / `link` 通道） | 取预算 → 送云终审 |
| 6 | 只命中 `gated` 词 | Ollama 本地确认（`think:true`）：可疑才上云，否则 0 档 |
| 7 | 命中 `recordOnly` 词 | 0 档只记录 |
| 8 | 纯图片消息（文本层只剩 `[image]` / `[at:…]`） | 0 档只记录，不识别图片内容 |
| 9 | 粗筛 `suspicious` | 按抽样率抽签，抽中才送云 |
| 10 | 粗筛 `clean` | 按抽样率抽签（默认 0），用于回归取样 |
| 11 | 粗筛 `unknown`（没筛成，绝不当 clean 放行） | 按时间档抽样（0–8 点 0.01，其余 0.05），没抽中记 `degraded` |

命中后到出手之间还有四道闸：预算（全局 / 单群双上限，任一满即不出手，记 `budgetOut`）、置信度门槛（低于阈值只记录）、同群同人 5 分钟冷却、条款封顶 `guard.caps`（照常送云，只压档位）。
抽样用确定性哈希（`sha1(groupId:messageId:salt)` 前 8 位十六进制 / 2^32），同一条消息任何人都能复算出同一个 `roll`，所以记录里的 `sampleRoll` / `sampleRate` 可以离线复核。

@机器人 或引用消息即走举报通道：不受预算与冷却限制，只按人按日计数，上下文取被引消息前后各 5 条（无引用则最近 10 条），终审返回的 `span` 原话片段会进学词流程（`learned-keywords.json`，进 `gated` 档，当日上限 20 条）。

## 模块地图

```
src/
  index.ts            621  装配与生命周期：读配置、建 OneBot 客户端、跑管线、热加载、优雅退出
  config.ts          1249  配置装载与校验（.env + config.json 合并、默认值、类型）
  state.ts            284  当日状态：双预算、冷却、按条款计数、零点换日、串行落盘
  collect.ts          113  原始事件落盘（默认关闭，仅服务器本地）
  inbox.ts            127  主人私聊收件箱（只收原文，不判定）
  log.ts               57  日志
  guard/
    types.ts          163  全部纯类型：RuleId / Severity / Channel / ScreenResult / JudgeResult / Decision / ViolationRecord
    rules.ts          832  词表归一化、扫描与优先级、玩笑白名单、口头语、游戏语境、消息抽取、豁免判定、环形缓冲
    screen.ts         295  Ollama 粗筛（A+B 举证式提示词，空证据一律降 clean）
    judge.ts          373  云端终审：system prompt、群规原文、条款口径、JSON 解析与降级
    pipeline.ts       824  判定主流程（上表 11 步）、预算与冷却闸、记录构造、举报通道
    action.ts         609  处置执行：文案、@提醒/警告、升级、私聊证据包、接收人解析
    level.ts           12  秒杀级判定（哪些判定值得私聊叫醒主人）
    silentSex.ts      135  色情静默闸门（极端文字才在群里出声，其余只私聊）
    learn.ts          225  从举报的 span 学词（挡板：长度、条款、重复、当日上限）
    sample.ts         110  确定性抽样
    record.ts          33  违规记录落盘（violations.jsonl）
    sent.ts            76  实际发出内容落盘（sent.jsonl）
    selftest.ts       400  自检（#test）
  onebot/
    client.ts         263  通用 call、重连、message_id 去重、合并转发获取
    types.ts           87  OneBot v11 事件与消息类型
  console/
    server.ts        1071  控制台 HTTP 服务与全部路由
    procs.ts          373  进程可见性与启停（按 ExecutablePath 前缀匹配，绝不按镜像名杀）
    envFile.ts        238  .env 的名单读写（原子写，只动三行）
    watchdog.ts       407  NapCat 掉线看守（90 秒自动拉起，可解除武装）
    qrArchive.ts      105  二维码归档（保留最近 20 张）
    ui.html          2017  单页控制台（内联 CSS/JS，无构建步骤）
    napcat-console.bat    17  NapCat 启动器（chcp 65001）
```

依赖方向单向：`index` → `guard` / `onebot` / `state` → `types`。`guard` 内部除了 `pipeline` 调 `rules`/`screen`/`judge`/`action`，其余模块互不依赖；`console` 只读 `state`/`config`，不碰 `guard` 的判定逻辑。

## 数据与落盘

| 文件 | 内容 | 是否进仓库 |
|---|---|---|
| `data/state.json` | 当日预算、冷却、按条款计数、粗筛降级标记 | 否 |
| `data/violations.jsonl` | 每条判定一行（含原文 ≤200 字、档位、置信度、理由、命中词、动作） | 否 |
| `data/sent.jsonl` | 实际发出的内容（便于核对机器人说了什么） | 否 |
| `data/learned-keywords.json` / `.jsonl` | 学到的词与审计流水 | 否 |
| `data/console/bot.log`、`data/napcat.log` | 运行日志 | 否 |
| `data/<YYYYMMDD>.jsonl` | 原始事件流（`collect.enabled=true` 时） | 否 |
| 私聊收件箱 | 主人私聊原文（`inbox.enabled=true` 时） | 否 |

状态文件损坏不会让进程崩：`StateStore.init()` 会把它备份成 `state.json.corrupt-<时间>` 再从空态起跑；默认无状态文件时也照常启动，只是预算与冷却退化为内存态。

## 配置

两边分开：`.env` 放连接与名单（含群号、QQ 号），`config.json` 放策略（词表、阈值、预算、端点、文案开关）。

`.env`：

| 变量 | 说明 |
|---|---|
| `ONEBOT_WS_URL` | OneBot v11 正向 WS 地址，默认 `ws://127.0.0.1:3002` |
| `ONEBOT_TOKEN` | NapCat 的 access_token，没设留空 |
| `GUARD_GROUP_IDS` | 守卫的群号，逗号或空格分隔，留空启动失败 |
| `OWNER_QQ` | 主人 QQ，3 级证据私聊接收人，必填 |
| `ADMIN_QQ` | 管理员 QQ，与 `notify.adminQqs` 合并；进运维名单（可发 `#test`），不豁免 |
| `NOTIFY_QQ` | 通知人 QQ，与 `notify.recipients` 合并；只收提醒，零权限 |
| `GUARD_GROUP_OWNERS` | 按群定向接收人，`群号:QQ,QQ;群号:QQ`；未配的群回退全局 `OWNER_QQ` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `MOCK_MODE` | `1` 时打出全部原始事件，线上必须 `0` |
| `GUARD_CONFIG_PATH` | 配置文件路径，默认工程根目录 `config.json` |
| `DEEPSEEK_API_KEY` | 终审密钥，只放 `.env`（`config.json` 会同步到两端） |

`config.json` 十节：`guard`（`keywords` / `thresholds` / `budget` / `linkWhitelist` / `rulesText` / `caps` / `silentSex` / `whitelist` / `exemptPhrases`）、`screen`（`baseUrl` / `model` / `enabled` / `timeoutMs` / `gatedTimeoutMs`）、`judge`（`baseUrl` / `model` / `maxTokens` / `timeoutMs` / `sample`）、`notify`（`enabled` / `adminQqs` / `recipients` / `groupRecipients`）、`collect`、`inbox`、`actions`、`dataDir`、`console`（`enabled` / `host` / `port` / `napcatDir` / `qqPath`）。

`actions.dryRun` 默认 `true`：所有处置只写日志和记录，不发消息。真上线才改 `false`。

## 快速上手

```bash
npm install
cp .env.example .env                    # 填群号、主人 QQ、DeepSeek Key
cp config.example.json config.json      # 填词表、端点、阈值（真实词表不进仓库）
npm run check                           # tsc --noEmit，应为 0 错
npm start                               # 起守卫机器人
npm run console                         # 另一个终端：控制台 http://127.0.0.1:8789
```

不带 NapCat 也能跑通判定链路：

```bash
npm run smoke                           # 假 OneBot 端自测，跑完自退
npm run mock                            # 假 OneBot 端常驻，手工发事件
```

## 脚本与测试

| 命令 | 内容 |
|---|---|
| `npm run check` | `tsc --noEmit` 全量类型检查 |
| `node scripts/test-rules.mjs` | 词表扫描、优先级、白名单、口头语、豁免 |
| `node scripts/test-state.mjs` | 双预算、冷却、计数、换日、损坏恢复 |
| `node scripts/test-pipeline.mjs` | 判定主流程 11 步、抽样、封顶、举报通道 |
| `node scripts/test-action.mjs` | 处置文案、档位、升级规则、秒杀级 |
| `node scripts/test-screen-gate.mjs` | 粗筛证据闸门（空证据降 clean） |
| `node scripts/test-learn.mjs` | 学词挡板与并入 `gated` |
| `node scripts/test-models.mjs` | 端点连通性（需 Ollama / 云端可用） |
| `node scripts/compare-screen.mjs` | 粗筛口径对比 |
| `node scripts/backfill-screen.mjs` | 历史回填粗筛结果 |
| `node scripts/recall-check.mjs` | 召回率抽查（默认读本地样本稿） |

本机实测（2026-11-25，Node v24.19.0）：

| 检查 | 结果 |
|---|---|
| `npm run check` | 0 错（exit 0，无输出） |
| `test-rules` | 全部通过，119 条断言 |
| `test-state` | 全部通过，17 条 |
| `test-pipeline` | 全部 PASS，28 项 |
| `test-action` | 全部通过，30 条 |
| `test-screen-gate` | 全部通过，8 条断言 |
| `test-learn` | 4 条通过、1 条失败（第 3 项"当日上限"，断言用硬编码日期，跨天后失效——夹具问题，不是学词逻辑问题，见[已知边界](#已知边界)） |

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | 文档总索引，分"可公开"与"仅本地"两层 |
| [`docs/architecture.md`](docs/architecture.md) | 架构说明：边界、主链路、数据契约、状态机、降级、控制台、测试矩阵 |
| [`docs/assets/pipeline.html`](docs/assets/pipeline.html) | 主链路图（交互式，可导出 PNG） |
| [`docs/assets/modules.html`](docs/assets/modules.html) | 模块依赖图（交互式，可导出 PNG） |
| `PUSH_RULES.md` | 入库规则：什么能进仓库、推送前自检、推错了怎么补救 |
| `AGENTS.md` | 给服务器 agent 的开工说明与工作区机制 |

以下文件只在本地，含真实群号、真实案例或内部分工，不进仓库也不对外：`守卫机器人方案.md`（设计与历次拍板）、`服务器布置清单.md`、`服务器踩坑.md`、`群聊违规案例样本-20261028.md`、`标定*`、`送云记录*`、`知识库-星穹铁道/`。

## 入库纪律

一句话：**只放代码和模板，不放数据、不放配置、不放密钥、不放人和群的标识。**

`.gitignore` 是白名单式的（第一行 `/*`，再逐条 `!` 放行），新增目录要显式放行并先看里面有什么。推送前跑 `PUSH_RULES.md` §5 的四条自检命令。真实词表只存在于本机 `config.json`，仓库里 `keywords.example.json` 是占位词；`src/config.ts` 的 `DEFAULT_KEYWORDS` 刻意留空——代码里不留可用的真实词表。

`/scripts/test-silent-sex.mjs` 含露骨语料，被单独排除在仓库之外，只能在本地跑。

## 已知边界

- **不识别图片**。纯图片消息在文本层没有可判内容，一律 0 档记录，不做 OCR、不做视觉模型。
- **禁言默认关**。只有 3 级 + 置信度 ≥ 0.9 + 手动开启才可能禁言，`actions` 默认全走 dryRun。
- **单账号单进程**。一个实例守一组群、连一个 NapCat；多实例靠不同 `GUARD_CONFIG_PATH` 与 `dataDir` 隔离。
- **控制台只给本机用**。`isLoopback()` 拦截非回环请求，写操作还要求 `x-syu-console: 1` 请求头，没有鉴权体系、不做远程暴露。
- **`scripts/test-learn.mjs` 第 3 项失败**：断言"当日上限"时用了硬编码日期，跨天后当日计数不为 0，用例会红。修法是让断言跟随 `localDate()`，未改。
- **`.env.example` 未列 `GUARD_GROUP_OWNERS`**：变量本身在代码与 `.env` 里都支持（按群定向接收人），示例文件漏了这条注释。
- **`守卫机器人方案.md` §8 的文件清单已过期**：里面写的 `guard/report.ts`、`actions.ts`、`commands.ts` 并不存在，实际为 `action.ts` / `pipeline.ts` / `level.ts` 等。以本文件和 `docs/architecture.md` 为准。

## 文档一致性

本文件与 `docs/architecture.md` 的事实来源是**当前代码**（行号与函数名对应 2026-11-25 的 `src/`），不是设计稿。设计稿与代码不一致处已在上面"已知边界"里点名。改代码后请同步这两份文档的相关段落。
