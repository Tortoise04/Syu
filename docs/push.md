# 推送通道（本机实测）

这台机器到 GitHub 的可用通道不是默认那条。每开一个新会话就重试一遍三种推法，等于每次都把同一个错重犯一次。本文记录已验证的结论与命令；网络环境变了，重跑第四节的复核命令再改结论。

## 一、结论

| 通道 | 状态 | 额外参数 |
|---|---|---|
| HTTPS `https://github.com/Tortoise04/Syu.git` | 可用，但 Git for Windows 走 schannel，取不到吊销列表，不带参数报 `CRYPT_E_NO_REVOCATION_CHECK` | 两个 `-c`，见第三节 |
| SSH over 443 `ssh://git@ssh.github.com:443/Tortoise04/Syu.git` | 可用，密钥已认证为 `Tortoise04` | 无 |
| SSH over 22 `git@github.com` | 不通：`Connection refused` | 不用 |

以上状态为 2026-11-25 在本机实测，命令见第四节。

## 二、推荐做法：remote 换成 SSH over 443

换一次，之后 `git push` 不带任何参数：

```bash
cd C:\Users\Dylan\Desktop\share\Syu
git remote set-url origin ssh://git@ssh.github.com:443/Tortoise04/Syu.git
git push
```

回滚成 HTTPS：

```bash
git remote set-url origin https://github.com/Tortoise04/Syu.git
```

仓库当前的 remote 就是 SSH over 443。

## 三、留在 HTTPS 时怎么推

```bash
git -c http.schannelCheckRevoke=false -c http.proxy=http://127.0.0.1:7897 push -u origin main
```

- 代理地址取自系统设置 `ProxyServer=127.0.0.1:7897`，端口变了要跟着换。
- 两个 `-c` 只对本次命令生效，不写进任何配置文件。

## 四、复核命令

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 -p 443 git@ssh.github.com
# 期望：Hi Tortoise04! You've successfully authenticated, but GitHub does not provide shell access.

ssh -o BatchMode=yes -o ConnectTimeout=8 -T git@github.com
# 当前期望：Connection refused（22 端口被挡）

curl -sS --ssl-no-revoke --max-time 12 -o /dev/null -w "%{http_code}\n" https://github.com/
# 期望：200

git ls-remote ssh://git@ssh.github.com:443/Tortoise04/Syu.git | head -3
# 期望：列出 refs/heads/main
```

## 五、排错对照

| 现象 | 原因 | 处置 |
|---|---|---|
| `schannel: CRYPT_E_NO_REVOCATION_CHECK` | Git for Windows 走 schannel，代理链路上取不到 OCSP/CRL | 走 SSH over 443，或加 `-c http.schannelCheckRevoke=false` |
| `connect to host github.com port 22: Connection refused` | 本机 22 端口被挡 | 换成 `-p 443 git@ssh.github.com` |
| `Permission denied (publickey)` | 本机没有可用密钥，或密钥没加到 GitHub 账号 | `ssh -T -p 443 git@ssh.github.com` 应当报 `Hi <用户名>` |
| 推送成功但远端文件没变 | 提交在别的分支，或改动没 `git add` / 没 commit | `git status -sb`、`git log --oneline -3` 对照远端 |

## 六、与 `PUSH_RULES.md` 的分工

`PUSH_RULES.md` 管**什么能进仓库**（白名单、自检命令、推错了怎么补救）；本文只管**怎么把它推上去**。推送前那条 30 秒自检仍然按 `PUSH_RULES.md` §5 跑，不要因为换了通道就跳过。
