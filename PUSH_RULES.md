# 推送规则（这个仓库能放什么、不能放什么）

> 代码之外的放行例外只有两个：`README.md`（对外说明）与本文件。改规则之前先读 §6。
> 仓库是公开的：`github.com/Tortoise04/Syu`。匿名访客能看到、能克隆、能搜到历史里的一切。

---

## 1. 一句话规则

**只放代码和模板，不放数据、不放配置、不放密钥、不放人和群的标识。**

判断标准只有一条：**如果这条内容明天出现在别人的搜索结果里，你会不会觉得麻烦？** 会 → 不进仓库。

## 2. 永不入库清单

| 类别 | 具体文件 | 为什么 |
| --- | --- | --- |
| 真实配置 | `config.json` | 里面有主人 QQ、群号、阈值、动作开关 |
| 密钥 | `.env` | DeepSeek API Key、OneBot access_token |
| 运行数据 | `data/`（`state.json`、`violations.jsonl`、`sent.jsonl` 等） | 群号、被处理的人、判定记录 |
| 登录凭证 | `qr/`（二维码图片） | **扫码即登录**，等于账号密码 |
| 原始语料 | `samples/` | 群聊原文、@ 的真实号 |
| 依赖 | `node_modules/` | 体积，且含本地路径 |
| 日志 | `*.log`、`logs/` | 含群号、消息片段、错误栈里的路径 |
| 方案与文档 | 根目录全部 `.md`（`README.md`、本文件除外） | 含群名、真实案例、内部分工 |

## 3. 机制：白名单式 .gitignore

`.gitignore` 的第一行是 `/*`（排除一切），然后逐条 `!` 放行。**新增任何文件都不会被顺手带上去**，必须先显式放行。

改动规则时的两条纪律：

1. **只加行、少删行**：要放行新东西，加一条 `!/路径`，不要去动上面已有的排除。
2. **放行目录前先看里面有什么**：`!/src/` 可以，`!/data/` 不行。

## 4. 词表策略（2026-11-04 起）

真实词表是这个项目里最有价值、也最私人的部分（群规怎么定的、什么词算红线），所以：

- **真实词表只在本机 `config.json` 的 `guard.keywords`**，永不出仓库；
- 仓库里只放两份示例：`keywords.example.json`（词表结构示例，词是占位）与 `config.example.json`（配置模板，关键词节同样是占位）；
- `src/config.ts` 的 `DEFAULT_KEYWORDS` 刻意留空——这样即使有人漏了配置，也不会"默认带着一套别人的词"跑起来；启动时会提示缺词。

**推论**：别人克隆后必须自己填词才能用。这是故意的，不是缺陷。

## 5. 推送前 30 秒自检

```bash
cd Syu

# ① 看这次要提交什么（确认没有 data/ qr/ .env config.json）
git status --short
git diff --cached --stat

# ② 看跟踪清单里有没有不该在的
git ls-files | grep -E '^(config\.json|\.env$|data/|qr/|samples/|.*\.log$)' && echo '❌ 有不该跟踪的文件' || echo '✅ 干净'

# ③ 敏感串扫描（QQ 号 / 群号 / 密钥形态）
git grep -nIE 'sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9._-]{20,}|api[_-]?key\s*[:=]|(OWNER_QQ|GUARD_GROUP_IDS)=\s*[0-9]+' -- . || echo '✅ 无命中'

# ④ 个人标识（用户名 / 本机路径 / 真实 QQ）
git grep -nIE 'Dylan|C:\\\\Users\\\\[A-Za-z]+|1[3-9][0-9]{9}' -- . || echo '✅ 无命中'
```

四条全过再 `git push`。

## 6. 如果已经推错了（补救顺序）

**先止损，再洗历史**——顺序错了等于白干：

1. **先轮换密钥**：`DEEPSEEK_API_KEY`、`ONEBOT_TOKEN` 立刻换新的（旧值已经进过公网，删历史也不算数）。
2. 改本地文件，提交一次正常的修复。
3. 再决定要不要洗历史：
   - 密钥/凭证 → **必须洗**（`git filter-repo --path 文件 --invert-paths`），然后 `git push --force-with-lease`；
   - 只是内容不想公开（例如词表）→ 洗不洗都行，但要知道：**历史里还留着旧版本**，克隆一次就能看到。
4. 洗完通知所有克隆方（包括另一台机器上的同步副本）**重新克隆**，不要 `pull`。

## 7. 例外与变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-04 | 建立本规则；词表从 `config.example.json` 与 `src/config.ts` 默认值里抽出，改为 `keywords.example.json`；`scripts/test-rules.mjs` 里的样本 QQ 换成 `10001`；`src/console/procs.ts` 注释里的本机路径改成 `%APPDATA%` |
| 2026-11-04 | 放行 `README.md`（对外说明，写清用途/上手/配置项，不含群号、QQ 与真实词表）；`.gitignore` 增 `!/README.md`；`scripts/test-state.mjs` 注释里的真实 QQ 去掉 |

要改这份规则，先在这里加一行变更记录再改正文——**规则本身也要留痕**。
