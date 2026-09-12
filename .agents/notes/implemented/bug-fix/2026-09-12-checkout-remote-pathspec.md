# Agent Note: 切远端分支的兜底命令把分支名当成了文件路径

Status: implemented

日期：2026-09-12
范围：`main.js`（`git/checkout` 的 attempt/fallback 同形）、`tools/harness.mjs`（第 9 节追加 5 条）

## 问题

点远端分支（如 `origin/main`）的检出，toast 报错 `error: pathspec 'origin/main' did not match any file(s) known to git`——git 把分支名当成了文件名，用户完全看不懂，也不知道该干什么。

完整链条（逐段复现确认）：`git switch origin/main` 本来就不接受远端分支（`fatal: a branch is expected, got remote branch 'origin/main'`，要加 `--detach` 才行）；旧兜底把它翻成 `git checkout origin/main origin/main`，两个位置参数被 git 读成"树 + 文件路径"，于是报 pathspec；更糟的是兜底直接覆盖了 `result`，`switch` 那条真正有用的报错（含 `--detach` 提示，或"本地修改会被覆盖"）被吞掉，用户永远只能看到第二条的乱码。

## 决策

attempt 与 fallback 按同一形状拼：新建（`switch --create` / `checkout -b`）、带起点（`switch --detach <startPoint>` / `checkout --detach <startPoint>`）、本地分支（`switch <name>` / `checkout <name>`）。`--detach` 同时修掉了"切远端分支"这条路——现在直接 detach 成功，不再报错。两条都失败时保留第一条的错（真因：文件挡路或 `--detach` 提示），兜底只在成功时覆盖。新建分支的兜底是顺手补的（原来 create 路径没有兜底，老 git 上必败；新 git 上两条都报"已存在"，保留第一条，用户所见不变）。

## Alternatives considered

- **视图层拦截远端分支、弹确认框问 detach**：没必要，`checkout --detach` 本来就是切远端分支的标准语义，分支 chip 对 detached 早有显示（`detached @ …`），多一层确认只是噪音。
- **失败时把两条报错拼一起显示**：两条说的是一件事，拼起来是复读；第一条（switch 的）在新 git 上永远更准（它带 hint），老 git 上第一条是"unknown command"反而没用——但老 git 上兜底基本都能成功，走到"两条都失败"时第一条是真因的概率远大。规则就定死：成功覆盖，失败保留第一条。
- **给这类失败加 remedy 中文提示**：脏树挡路时 git 原文（"本地修改将被检出操作覆盖…提交或储藏"）已经把做法说清了，不需要再包一层。

## 后果

- 代价：`switch` 失败的路径固定多花一个 `checkout` 子进程；拼命令多两个三元分支。
- 收益：切远端分支从"必现乱码"变成"直接 detach 成功"；真被挡住时看到的是文件名和做法，不再是 pathspec。harness 第 9 节锁死两条：detach 成功且 HEAD 对上远端、挡路时报错含文件名且不含 pathspec。
- 约束：以后给"尝试 A、不行换 B"的命令加兜底，必须同形拼、失败保留第一条；`checkout` 类命令禁止出现两个裸位置参数（第二个会被读成 pathspec，这是 git 的固定语义，不是偶然）。
