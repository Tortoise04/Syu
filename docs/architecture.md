# Syu 架构说明

本文说明群聊守卫机器人 Syu 的运行边界、判定链路、模块职责、数据契约与降级路径。
事实来源是当前代码（`src/`，2026-11-25），不是设计稿；设计与代码不一致处集中在[第 14 节](#14-文档与代码的已知偏差)点名。

- 读者：接手维护的人、评估这套东西要不要上自己群的人。
- 不含：真实群号、真实 QQ、真实词表、真实群聊原文、任何密钥。文中出现的都是占位。

## 1. 范围

Syu 做一件事：**在 QQ 群里按群规判断某条消息该不该处置，并按档位出手**，同时把云端调用量压在硬预算内。

不做的事，写在代码里也写在本文里：

| 不做 | 位置 / 原因 |
|---|---|
| 不识别图片内容 | `pipeline.ts` 判纯图后直接 0 档记录，无 OCR、无视觉模型 |
| 不主动禁言 | `actions` 默认 dryRun；禁言需 3 级 + 置信度 ≥ 0.9 + 手动开启 |
| 不做远程管理 | 控制台只听回环，`isLoopback()` 拦非本机请求 |
| 不按镜像名杀进程 | `procs.ts` 只按 `ExecutablePath` 前缀匹配 `napcatDir` / `qqPath` |
| 不在仓库放真实词表 | `PUSH_RULES.md` §4；`config.ts` 的 `DEFAULT_KEYWORDS` 留空 |

## 2. 部署形态

全栈跑在一台 Windows 机器上（带独显，本地模型与机器人同机），另一台笔记本只做开发与管理端，两边用 Syncthing 双向同步工程目录。

```
┌──────────────── 服务器（Windows） ────────────────┐
│  QQ(NT) ←→ NapCat ──WS 3002──→ Syu 主进程          │
│                              │                    │
│                              ├─→ Ollama 127.0.0.1:11434（粗筛）
│                              └─→ DeepSeek API（终审）
│  控制台 127.0.0.1:8789（同机浏览器）                │
└───────────────────────────────────────────────────┘
        ▲ Syncthing（代码与文档双向同步）
        ▼
┌──────────────── 笔记本（开发/管理） ───────────────┐
│  编辑代码、改文档、远程看日志；不跑模型、不连 QQ     │
└───────────────────────────────────────────────────┘
```

端口分工：`3001` 是同机另一个机器人（Dyu）的 NapCat，`3002` 是本机器人的 NapCat 正向 WS，`8789` 是控制台。三个端口都在代码与 `.env.example` 注释里对得上。

三个外部依赖都可替换：NapCat 换成任何 OneBot v11 实现；Ollama 换成任何 `/api/chat` 兼容端点；DeepSeek 换成任何 OpenAI 兼容 `/chat/completions`。换端点只改 `config.json` 的 `screen.baseUrl` / `judge.baseUrl`。

## 3. 主链路

一条群消息从进来到出手，只有一条主干，中间全是短路闸。

```
OneBot 事件
   │  onebot/client.ts：message_id 去重、按群过滤
   ▼
index.handle() → runPipeline()
   │
   ├─ 非消息事件？ ──→ 举报事件？ ──→ handleReport()（不受预算/冷却限制）
   │
   ▼
pipeline.handleMessage()
   1 push 环形缓冲（最近 30 条）
   2 豁免名单 ────────────────→ 放过
   3 玩笑白名单（全是套话） ──→ 放过
   4 「艹」类口头语 ─────────→ 放过
   5 词表扫描 mustJudge ─────→ 取预算 ─→ 终审
   6 命中 gated ──→ Ollama 本地确认 ─→ 可疑才终审，否则 0 档
   7 命中 recordOnly ───────→ 0 档记录
   8 纯图片 ───────────────→ 0 档记录
   9 粗筛 suspicious ──→ 抽签 ─→ 中：取预算→终审；不中：0 档
  10 粗筛 clean ────────→ 抽签（默认 0）
  11 粗筛 unknown ──────→ 抽签（时间档）→ 不中：0 档 + degraded
   ▼
终审结果 → 条款封顶 caps → 置信度门槛 → 冷却 → 四档动作
   │
   ├─ record.ts → violations.jsonl（先落盘，落盘失败不影响处置）
   ├─ action.ts → 群里提醒/警告 / 私聊证据包
   ├─ sent.ts   → sent.jsonl（实际发出的内容）
   └─ level.ts  → instantKill 才私聊叫醒主人
```

"先落盘再动手"：记录是证据动作，写失败只报错不阻断；处置是外发动作，失败会回落到"在群里 @主人"的兜底文案。

## 4. 模块与依赖

| 层 | 模块 | 职责 | 对外契约 |
|---|---|---|---|
| 装配 | `index.ts` | 读配置、建客户端、启动日志、热加载、信号退出 | 无（进程入口） |
| 配置 | `config.ts` | `.env` + `config.json` 合并、默认值、校验、`loadConsoleConfig` | `GuardConfig` / `ConsoleConfig` |
| 状态 | `state.ts` | 双预算、冷却、按条款计数、换日、容错落盘 | `StateStore` |
| 判定 | `guard/rules.ts` | 归一化、词表扫描与优先级、白名单、豁免、环形缓冲 | `scan()` / `isExempt()` / `RingBuffer` |
| 判定 | `guard/screen.ts` | Ollama 粗筛、举证式提示词、证据闸门 | `screener.screen()` → `ScreenResult` |
| 判定 | `guard/judge.ts` | 云端终审、system prompt、JSON 解析与降级 | `judge.judge()` → `JudgeResult` |
| 判定 | `guard/pipeline.ts` | 主流程、四道闸、记录构造、举报通道 | `handleMessage()` / `handleReport()` |
| 判定 | `guard/level.ts` | 秒杀级（要不要私聊叫醒主人） | `instantKill()` |
| 判定 | `guard/silentSex.ts` | 色情条款的静默闸门 | 分"群里出声"与"只私聊" |
| 判定 | `guard/learn.ts` | 从 `span` 学词、挡板与审计 | `recordLearned()` |
| 判定 | `guard/sample.ts` | 确定性抽样 | `drawSample()` / `describeDraw()` |
| 落盘 | `guard/record.ts` `guard/sent.ts` `collect.ts` `inbox.ts` | 违规记录 / 发出内容 / 原始流 / 私聊收件 | 各自 append |
| 协议 | `onebot/client.ts` | 通用 `call<T>`、重连、去重、合并转发 | `OneBotClient` |
| 管理 | `console/*` | HTTP 服务、进程启停、`.env` 读写、看守、二维码归档、单页 UI | 回环 + `x-syu-console` 头 |

依赖方向单向，没有循环：

```
index ─→ config, state, onebot, guard/pipeline, collect, inbox, console?（否）
guard/pipeline ─→ rules, screen, judge, action, level, sample, record, sent, learn, silentSex, types
console/server ─→ state(只读 snapshot), config, procs, envFile, watchdog, qrArchive
```

`console` 不 import 任何 `guard` 模块——管理面看不到判定实现，只能读状态文件与日志。这条边界是刻意的：控制台改不了一条判定的结果。

## 5. 数据契约

全部类型在 `guard/types.ts`（163 行，纯类型无逻辑）：

| 类型 | 关键字段 | 用途 |
|---|---|---|
| `RuleId` | `REDLINE` / `R3`–`R11` / `OTHER` | 条款枚举，对外文案由 `action.ruleLabel()` 翻译成人话 |
| `Severity` | `0`–`3` | 四档 |
| `Channel` | `keyword` / `link` / `screen` / `gated` / `report` / `sample` | 这条判定从哪条路进来，用于统计与复盘 |
| `ScreenResult` | `verdict`(`clean`/`suspicious`/`unknown`) `rule` `score` `evidence` `reason` `degraded` | 本地粗筛结果；`unknown` 表示"没筛成"，**不许当 clean 放行** |
| `ContextItem` | `messageId` `userId` `nickname` `time` `text` `images` `isTarget` | 送终审的上下文条目，`text` 已归一化，图片位置留 `[image]` |
| `KeywordHit` | `rule` `word` `kind` `mustJudge` | `kind` ∈ `redline`/`rule`/`link`/`flood`/`alarm`/`hint`/`gated` |
| `JudgeInput` | `channel` `target` `context` `rulesText` `keywordHits` | 云端输入 |
| `JudgeResult` | `severity` `confidence` `reason` `rule` `extraRules` `span` `degraded` | 云端输出；`span` 是原话片段，供学词 |
| `Decision` | `channel` `rule` `severity` `confidence` `action` `hits` `degraded` `cooledDown` `escalatedToThree` | 内部决策，`action` ∈ `none`/`remind`/`warn`/`escalate`/`mute`/`notify` |
| `ViolationRecord` | 见下 | 落盘的一行 |

`ViolationRecord` 的字段就是 `violations.jsonl` 的一行（`text` 截到 200 字）：

```
ts groupId userId nickname messageId channel text rule extraRules severity confidence
reason keywords action cooledDown degraded [sampled sampleRoll sampleRate]
[hintRule screenScore screenEvidence screenReason] [span] [sentText]
```

方括号里是可选的证据字段：抽样三联（`sampled`/`sampleRoll`/`sampleRate`）让任何人都能用 `sample.ts` 的算法离线复算"这条该不该送云"；`hintRule`/`screenScore`/`screenEvidence`/`screenReason` 记录粗筛当时说了什么，用于之后调提示词；`span` 是举报通道拿到的原话片段。

`sent.jsonl` 单独一份：记录实际发出去的文案。判定记录回答"为什么这么判"，`sent.jsonl` 回答"机器人到底在群里说了什么"——群主投诉的时候要先能看后者。

## 6. 状态与预算语义

`StateStore` 管四样东西：当日预算、冷却表、按条款计数、粗筛降级标记。语义有三条值得记住：

1. **双预算是原子的**。`takeBudget(groupId)` 先查全局 `budget.total >= budget.daily`，再查单群 `used >= (groupDaily[groupId] ?? budget.perGroup)`，任一满就返回 `false` 且两边都不加。不会出现"全局没满但单群被扣了"的半截状态。
2. **换日只换日期**。`rolloverIfNeeded()` 比对 `localDate(now)` 与快照的 `date`，不同就整体重置为当日空态（预算归零、计数清空、冷却保留与否按实现），并在下一次落盘时写回。所有读写入口（`snapshot` / `takeBudget` / `isCooling` / `bumpDailyCount` / `dailyCount` / `bumpRejectReport`）都会先调它，所以跨零点不需要定时器。
3. **落盘串行且容错**。`persist()` 用 promise `chain` 串起来，避免两次写交错出半截 JSON。`init()` 读不到文件就从空态起跑并新建；读到坏 JSON 就把原文件 `quarantine` 成备份再空态起跑。**状态丢了不影响判定正确性，只影响预算与冷却**——所以 `index.ts` 里 `StateStore` 建失败也继续跑。

计数的 key 是 `${groupId}:${rule}:${date}`，与快照的 `counters` 一起落盘，因此"当日同群同条款第 2 次升 3 档"这条规则在重启后依然成立。

## 7. 抽样与降级

三条通道都可能需要"抽样才送云"，抽样必须可复算，否则事后无法解释为什么某条没送。

```
sampleRoll(key) = parseInt(sha1(`${groupId}:${messageId}:${SALT}`).slice(0,8), 16) / 2^32
```

- `SALT = 'syu-sample-v1'`。`messageId` 缺失或为负（`#test` 造的）时退化成 `sha1(groupId:userId:time:text:salt)`，仍然确定性。
- 抽样率：`suspicious` 默认 1（全送），`clean` 默认 0，`unknown` 未配时按时间档——0–8 点 0.01，其余 0.05。
- 抽中的判定把 `roll` / `rate` 写进记录与非 JSON 文案（`describeDraw()` 输出"抽样 roll=0.1234 < rate=0.05，已抽中送云"），人可以拿记录里的三个数直接复算。
- 测试通过 `drawSample(..., override)` 注入随机数，所以老用例"unknown + random 0.99/0.01"的语义不变。

降级路径（任何一条断了都要留下痕迹，不能静默当成"没事"）：

| 故障 | 表现 | 落点 |
|---|---|---|
| Ollama 不可用 / 超时 | `ScreenResult.verdict='unknown'`、`degraded=true` | 按时间档抽样，没抽中记 0 档 + `degraded`，`state.screenDegraded` 置位 |
| Ollama 回了可疑但没有证据 | `applyEvidenceGate` 把 `suspicious` 降为 `clean` | 证据为空不许定可疑，避免"模型幻觉推动处置" |
| 云端不可达 / 超时 | `JudgeResult.degraded=true`，`severity=0`、`confidence=0`、`rule='OTHER'` | 0 档记录，`reason` 写明降级原因 |
| 云端返回非 JSON 或字段缺失 | `parseJudgeOutput()` 返回 `null` → 同上默认值 | 同上；`raw` 保留原文便于对照 |
| 状态文件损坏 | `init()` 备份后空态 | 预算与冷却退化为内存态，进程继续 |

置信度门槛与出手同口径（2026-11-13 起）：低于 `guard.thresholds` 的判定只记录、不出手。所以**降级不会导致误伤**，代价是漏检——这个取舍是有意的。

## 8. 处置模型

四档，档位由终审给，会被 `guard.caps` 压顶（照常送云，只压档位，例如某条款封 0 档就永远只记录）：

| 档 | 动作 | 落地形态 |
|---|---|---|
| 0 | 只记录 | 写 `violations.jsonl`，群里一个字不发 |
| 1 | @提醒 | 群里回复该消息，附条款名 |
| 2 | @警告 | 群里回复并点名条款；同日同群同条款第 2 次自动升 3 档（`escalatedToThree`） |
| 3 | 升级 | 私聊管理员 + 主人，附证据包（原文、上下文、命中的条款与理由） |

三道附加闸：

- **冷却**：同群同人 5 分钟（`COOLDOWN_MS`），冷却中的判定不进群，仍记录且标 `cooledDown`。
- **静默闸门**（`silentSex.ts`）：色情类条款（R7 / REDLINE）只有"极端"文字才在群里出声，其余群里一字不发、私聊照发。七组判据：交易、招嫖、站点、猥亵、长篇、导流、换脸；未成年/恋童、口嗨绕词、新闻讨论只走私聊。词表在 `guard.silentSex.extreme`，站点与长篇两组是谓词判定，词表留空。
- **秒杀级**（`level.ts`）：只有 `REDLINE`、`R11`（开盒人肉）、以及 R3 的**真 3 档**（不是被次数规则抬上来的）才私聊叫醒主人。被"第 2 次升 3 档"抬上去的 R4 辱骂、R7 色情不算秒杀，不私聊、不发证据包。

接收人解析顺序：`GUARD_GROUP_OWNERS` 里该群的定向接收人 → 全局 `OWNER_QQ`；管理员 = `ADMIN_QQ` ∪ `config.notify.adminQqs`；通知人 = `NOTIFY_QQ` ∪ `config.notify.recipients`，通知人零权限（不进运维名单、不豁免、不收私聊收件箱）。

文案层：`action.ruleLabel()` 把 `R3`–`R11` 翻成"群规第 N 条「…」"，`REDLINE` 翻成"红线条款（违禁内容）"，`OTHER` 翻成"群规通用条款"。群里不出现内部条款代号。

## 9. 学词闭环

举报通道是唯一能"从群友那里学到新词"的入口：

```
@机器人 / 引用消息 → handleReport() → 终审返回 span（原话片段，截 40 字）
   → recordLearned()：归一化到 15 字、去 @ 占位符
   → 挡板：<2 字 / 纯数字 / 条款不在 R3–R11 / 已在词表 / 今天已学 / 今天满 20 → 不收
   → learned-keywords.json（进 gated 档，不直通云）
   → learned-keywords.jsonl（审计：谁在什么时候学了什么）
```

学来的词落 `gated` 而不是 `redline`：新词先让本地模型确认，避免一条恶意举报把词塞进直通云表、白烧预算。学词文件被热加载监听，写入后 1 秒内生效，`#test reload` 可手动触发。当日上限 20 条防止刷量。

## 10. 控制台

独立进程（`node src/console/server.ts`），不是主进程的一部分——主进程崩了控制台还能启停它。

| 约束 | 实现 |
|---|---|
| 只听本机 | `isLoopback(req)` 不通过即 403 `只允许本机访问` |
| 写操作要标记头 | 所有 `POST /api/*` 必须带 `x-syu-console: 1`，否则 403 `缺少 x-syu-console 头` |
| 串行 | 全局 `busy` 锁，同一时刻只跑一个作业 |
| 不杀错进程 | 只按 `ExecutablePath` 前缀匹配 `napcatDir` / `qqPath`，绝不 `taskkill /IM QQ.exe` |
| 停止不被反拉 | `napcat/stop` 与 `bot/stop` 先 `watchdog.setArmed(false)`，否则 90 秒后看守把刚停的又拉起来 |
| 二维码不外泄 | `qrArchive.ts` 只保留最近 20 张，5 秒轮询归档；扫码即等于登录 |

路由：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/`、`/index.html` | 单页控制台（`no-store`，读 `ui.html`） |
| GET | `/api/state` `/api/groups` `/api/config` `/api/params` | 状态、群列表、配置、可调参数 |
| GET | `/api/messages` `/api/conversations` `/api/feed` | 消息、会话、动态流 |
| GET | `/api/qrcode` `/api/logs` | 二维码、日志尾 |
| POST | `/api/params` `/api/config` | 参数与配置写回（`.env` 原子写：`.env.tmp` → rename，只动 `GUARD_GROUP_IDS` / `OWNER_QQ` / `GUARD_GROUP_OWNERS` 三行） |
| POST | `/api/napcat/{start,stop,restart}` `/api/bot/{start,stop,restart}` `/api/watchdog/{arm,disarm}` | 作业 |

未定义动作返回 404 `没有这个动作：<action>`。看门狗：NapCat 掉线 90 秒自动拉起，`armed` 可解除。

## 11. 配置与热加载

`index.ts` 的 `startConfigWatcher()` 盯三个文件：`config.json`、`.env`、`data/learned-keywords.json`。变化后 900ms 防抖调 `reloadConfig(reason)`，只替换纯数据（词表、阈值、预算、端点、规则原文、caps、白名单、接收人），不重建连接。需要重启才生效的：`ONEBOT_WS_URL`、`ONEBOT_TOKEN`、`dataDir`。手动触发：`#test reload`。

这个设计让"改阈值、补词表"不必断线重连 QQ——改词表是最高频的运维动作，断线重连会丢消息。

## 12. 观测

四条证据链，各回答一个问题：

| 去处 | 回答 |
|---|---|
| `data/violations.jsonl` | 为什么这么判（档位、置信度、理由、命中词、抽样 roll） |
| `data/sent.jsonl` | 机器人到底说了什么（原文） |
| `data/console/bot.log` / `napcat.log` | 进程层发生了什么（启动参数、降级、重连、错误） |
| `data/<YYYYMMDD>.jsonl`（`collect`） | 原始事件长什么样（含原文与群号，仅服务器本地） |

启动日志一次性打全当前姿态：dryRun 开关、守卫群数、抽样率、采集开关、`#test` 运维名单、收件箱、条款封顶、按群定向接收人、热加载状态。出问题先看这一屏。

## 13. 测试矩阵

测试都是 `node` 直接跑的脚本，无框架、无 mock 库，自带断言。实测（2026-11-25，Node v24.19.0）：

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `npm run check` | 全量类型检查 | 0 错 |
| `scripts/test-rules.mjs` | 归一化、四档优先级、玩笑白名单、口头语、游戏语境、豁免 | 119 条断言全过 |
| `scripts/test-state.mjs` | 双预算原子性、冷却、计数 key、换日、损坏恢复、`GUARD_GROUP_OWNERS` 解析 | 17 条全过 |
| `scripts/test-pipeline.mjs` | 11 步主流程、抽样、封顶、举报通道与 `span` 落记录 | 28 项全过 |
| `scripts/test-action.mjs` | 文案、档位、升级规则、秒杀级边界 | 30 条全过 |
| `scripts/test-screen-gate.mjs` | 证据闸门（空证据降 `clean`） | 8 条断言全过 |
| `scripts/test-learn.mjs` | 学词挡板、重复、并入 `gated` | 4 过 1 失败（见下） |

已知失败（唯一一条）：`test-learn` 第 3 项"当日上限"。夹具把 20 条审计行的时间戳写成固定值 `2026-11-02T09:40:00+08:00`（脚本第 31 行 `TS`），而 `recordLearned()` 只统计 `localDate(now)` 当天的审计行（`learn.ts` 第 153/192 行），跨天后当天计数为 0，于是"应该被上限拦住"的那次收词仍然成功，断言失败。这是夹具与时间耦合，不是学词逻辑缺陷。修法：夹具时间戳改用当天，或断言传 `now` 覆盖。

## 14. 文档与代码的已知偏差

| 偏差 | 现状 |
|---|---|
| `守卫机器人方案.md` §8 的文件清单 | 列了 `guard/report.ts`、`actions.ts`、`commands.ts`，实际不存在；实际为 `action.ts` / `pipeline.ts` / `level.ts` / `sample.ts` / `sent.ts` / `selftest.ts` / `types.ts` |
| 方案文档的状态头 | 仍写"方案已定，未写任何代码"，实际已到 M3 并在服务器上跑 |
| 方案文档里的测试条数 | 97 / 17 / 25 / 22 / 8，已被本文实测数字取代 |
| `.env.example` | 未列 `GUARD_GROUP_OWNERS`，代码与 `.env` 都支持 |
| `控制台设计规范.md` | 被方案文档引用，但已不在工作区 |

改代码后请同步第 5、7、13 节对应的段落；本文与本仓库 `README.md` 的口径要一致。

## 15. 设计取舍

| 取舍 | 为什么这么选 | 代价 |
|---|---|---|
| 三通道而不是全量上云 | 云端按条计费，群聊里 95% 以上是正常闲聊 | 词表漏词的消息只能靠抽样碰运气 |
| `unknown` 不当 `clean` | 粗筛失败与"确认干净"是两件事，混同会静默放行 | 抽样量比"当 clean"高，多花一点预算 |
| 预算硬上限 + 双口径 | 单日总花费可预测，单个活跃群不会吃掉全部配额 | 预算耗尽后可疑消息只记录，要等零点 |
| 记录原文 ≤200 字 | 复盘需要原话，脱敏后仍需可比对 | 记录本身含敏感内容，只能放服务器本地 |
| 词表分四档 | 直通云只留给漏检代价最高的词，其余先本地确认 | 运维要理解四档区别，词表维护成本上升 |
| 确定性抽样 | 事后能复算，争议可仲裁 | 同一条消息永远同一个结果，抽样偏差不随机游走 |
| 控制台只听回环 | 无鉴权体系也能安全 | 只能同机用，远程要另想办法 |
| 学词进 `gated` | 防恶意举报刷词表 | 新词第一次出现仍要靠本地模型，慢一步 |

## 16. 扩展点

- **换模型**：`config.json` 的 `screen.baseUrl` / `screen.model` 与 `judge.baseUrl` / `judge.model`，无需改代码。
- **换协议端**：任何 OneBot v11 正向 WS 实现，改 `ONEBOT_WS_URL`。
- **多实例**：不同 `GUARD_CONFIG_PATH` + 不同 `dataDir` + 不同端口，互不干扰。
- **加条款**：`RuleId` 加枚举 → `action.RULE_TITLES` 加人话 → `rulesText` 加原文 → 词表加词 → 测试补断言。
- **加处置档**：`Severity` 与 `actionOf()` 一起改，注意 `caps` 与 `instantKill` 的边界要跟着复核。
