# Syu · 群聊守卫机器人

一个不烧钱的群聊守卫：**本地规则触发 → 本地小模型粗筛 → 只把可疑消息送云端终审 → 按严重度处置**。

关键词命中不等于定罪。触发只是"叫模型来看"，判不判、动不动手由终审和置信度门槛决定。
目的是省钱、少误伤、给群主减负，而不是给每条消息都过一遍大模型。

> 本仓库只放代码与模板。真实配置、词表、群聊语料、登录凭证都不在里面，规则见 [PUSH_RULES.md](./PUSH_RULES.md)。

---

## 怎么工作

一条群消息进来后分四道：

| 阶段 | 在哪跑 | 干什么 |
| --- | --- | --- |
| 1. 本地规则 | 本机，零成本 | 关键词分档（红线 / 直通云 / 本地确认 / 只记录）＋ 白名单豁免 ＋ 重复与预算控制 |
| 2. 本地粗筛 | 本机 Ollama 小模型 | 把可疑消息判成 clean / suspicious / unknown，挡掉大部分误报 |
| 3. 云端终审 | DeepSeek API | 只看过了粗筛的那一小撮，给出严重度、条款与置信度 |
| 4. 处置 | 按严重度 | 群内提醒 / 私聊证据 / 静默，全部受日预算与冷却时间约束 |

设计取向：**按漏检代价选通道**。漏了会炸群的走 100% 召回，漏了只是氛围差的交给本地粗筛兜底。

## 目录结构

```
src/
  index.ts          入口：加载配置 → 连 OneBot → 派发消息
  config.ts         配置加载与校验（坏配置启动即报错，不静默降级）
  state.ts          预算 / 冷却 / 计数落盘（data/state.json）
  collect.ts        原始事件采集
  inbox.ts          私聊收件箱
  guard/
    rules.ts        关键词分档与归一化匹配
    screen.ts       本地小模型粗筛
    judge.ts        云端终审
    silentSex.ts    涉黄/交易的细分闸门
    action.ts       处置执行（群内 / 私聊 / 静默）
    learn.ts        从群规里学词（受当日上限约束）
    record.ts       判定记录落盘
    pipeline.ts     串起上面几步
  onebot/           OneBot v11 客户端与类型
  console/          本机控制台（127.0.0.1，不对外监听）
scripts/            本地脚本：mock OneBot、假 LLM、各模块自测
```

## 环境要求

- **Node.js ≥ 22.18**：直接用 `node` 跑 `.ts`，不需要编译步骤
- **NapCat**（或任何 OneBot v11 实现），开正向 WebSocket
- **Ollama** ＋ 一个能跑得动的小模型（示例用 `qwen3:8b`）
- **DeepSeek API Key**（只用于终审）

## 快速上手

```bash
npm install
cp .env.example .env                       # 填自己的值
cp config.example.json config.json         # 填自己的词表
npm run check                              # tsc 类型检查
npm start                                  # 起守卫
npm run console                            # 另开一个终端：控制台 http://127.0.0.1:8789
```

**第一步必须先填词表。** 仓库里的 `keywords.example.json` 与 `config.example.json` 全是占位词，
`src/config.ts` 的内置默认同样是空的——这是故意的：谁克隆谁自己定规则，不会"默认带着别人的词"跑起来。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `ONEBOT_WS_URL` | OneBot 正向 WS 地址，如 `ws://127.0.0.1:3002` |
| `ONEBOT_TOKEN` | OneBot access_token；没设就留空 |
| `GUARD_GROUP_IDS` | 要守的群号，逗号分隔；留空启动失败 |
| `GUARD_GROUP_OWNERS` | 群号与群主的绑定（可选），用于按群发证据 |
| `OWNER_QQ` | 主人号：3 级证据私聊 + 紧急总闸 |
| `ADMIN_QQ` | 管理员号（可选）：并入运维名单 |
| `NOTIFY_QQ` | 通知人号（可选）：只收提醒，零权限 |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `MOCK_MODE` | 打印原始事件，调试用；线上必须为 `0` |
| `GUARD_CONFIG_PATH` | 配置文件名，默认 `config.json` |
| `DEEPSEEK_API_KEY` | 终审密钥，只放 `.env`，不要写进 `config.json` |

## 配置结构

`config.example.json` 是完整模板，九节：

| 节 | 内容 |
| --- | --- |
| `guard` | 关键词分档、置信度阈值、日预算、链接白名单、群规原文、涉黄闸门、豁免名单、玩笑白名单 |
| `screen` | 本地小模型：端点、模型名、超时、是否启用 |
| `judge` | 云端终审：端点、模型、maxTokens、超时、采样率 |
| `notify` | 通知开关、全局管理员号、按群通知人 |
| `collect` | 原始事件落盘目录 |
| `inbox` | 私聊收件箱目录 |
| `actions` | `dryRun`（默认 `true`，只记不发）、群内静默、禁言、冷却、每日动作上限 |
| `dataDir` | 预算与状态落盘目录 |
| `console` | 控制台监听地址与端口（默认只听 `127.0.0.1:8789`） |

`actions.dryRun` 默认 `true`：**先观察再动手**，确认无误再改成 `false`。

## 常用脚本

```bash
npm run mock                # 假 OneBot 服务端
npm run smoke               # 冒烟测试
npm run check               # tsc --noEmit
node scripts/test-rules.mjs # 关键词匹配
node scripts/test-state.mjs # 预算 / 状态落盘
node scripts/test-pipeline.mjs
node scripts/test-action.mjs
```

部分测试会读项目根目录的 `config.json`，需要先按“快速上手”准备好一份。
已知问题：`scripts/test-learn.mjs` 的“当日上限”用例用了硬编码日期，跨天后会失败，属测试夹具问题，不影响运行逻辑。

## 隐私边界

这个仓库是公开的，因此代码之外只有两个 `.md`：本文件和 [PUSH_RULES.md](./PUSH_RULES.md)。

**不在仓库里的东西**：`config.json`（真实群号与 QQ）、`.env`（密钥）、`data/`（判定记录）、
`qr/`（登录二维码，扫码即登录）、`samples/`（群聊原文）、真实词表、`node_modules/`、日志。

`.gitignore` 是白名单式的：第一行 `/*` 排除一切，再逐条 `!` 放行，所以新增文件不会被顺手带上去。
改动规则之前，先读 `PUSH_RULES.md` 并在它的变更记录里留一行。
