# Agent Note: 切远端分支的兜底命令把分支名当成了文件路径

Status: implemented

 日期：2026-09-12；2026-09-14 追记：远端检出语义由 detach 改为跟踪分支（见下）。
 范围：`main.js`（`git/checkout` 的 attempt/fallback 同形 + `track` 路径）、`tools/harness.mjs`（第 9 节改写 + 第 16 节追加跟踪检出）、`src/git-view.js` 与 `src/commit-view.js`（远端分支传 `track: true`）

## 问题

点远端分支（如 `origin/main`）的检出，toast 报错 `error: pathspec 'origin/main' did not match any file(s) known to git`——git 把分支名当成了文件名，用户完全看不懂，也不知道该干什么。

完整链条（逐段复现确认）：`git switch origin/main` 本来就不接受远端分支（`fatal: a branch is expected, got remote branch 'origin/main'`，要加 `--detach` 才行）；旧兜底把它翻成 `git checkout origin/main origin/main`，两个位置参数被 git 读成"树 + 文件路径"，于是报 pathspec；更糟的是兜底直接覆盖了 `result`，`switch` 那条真正有用的报错（含 `--detach` 提示，或"本地修改会被覆盖"）被吞掉，用户永远只能看到第二条的乱码。

## 决策

 attempt 与 fallback 按同一形状拼：新建（`switch --create` / `checkout -b`）、带起点（`switch --detach <startPoint>` / `checkout --detach <startPoint>`）、本地分支（`switch <name>` / `checkout <name>`）。2026-09-12 当时 `--detach` 同时修掉了"切远端分支"这条路——直接 detach 成功，不再报错。2026-09-14 用户要的是 IDEA 行为，于是远端分支改走独立的 `track: true` 路径：`switch --track <startPoint>`（兜底 `checkout --track`），先用 `rev-parse --verify refs/remotes/<startPoint>` 复验远端属性（面板桥转发任意通道，视图的分类不能信），拒绝非远端与 `/HEAD` 符号引用；本地同名分支已存在时落到切那个本地分支（正是这次点击的意思），那一步的报错（脏树点名文件）才是可行动的，前一条预料之中的 "already exists" 不再保留；裸 revision（哈希）仍走 `--detach`。两条都失败时保留第一条的错（真因：文件挡路或 `--detach` 提示），兜底只在成功时覆盖。新建分支的兜底是顺手补的（原来 create 路径没有兜底，老 git 上必败；新 git 上两条都报"已存在"，保留第一条，用户所见不变）。

## Alternatives considered

- **视图层拦截远端分支、弹确认框问 detach**：没必要，`checkout --detach` 本来就是切远端分支的标准语义，分支 chip 对 detached 早有显示（`detached @ …`），多一层确认只是噪音。
- **失败时把两条报错拼一起显示**：两条说的是一件事，拼起来是复读；第一条（switch 的）在新 git 上永远更准（它带 hint），老 git 上第一条是"unknown command"反而没用——但老 git 上兜底基本都能成功，走到"两条都失败"时第一条是真因的概率远大。规则就定死：成功覆盖，失败保留第一条。
- **给这类失败加 remedy 中文提示**：脏树挡路时 git 原文（"本地修改将被检出操作覆盖…提交或储藏"）已经把做法说清了，不需要再包一层。

## 后果

- 代价：`switch` 失败的路径固定多花一个 `checkout` 子进程；拼命令多两个三元分支；跟踪检出多一次 `rev-parse` 探测。
- 收益：切远端分支从"必现乱码"变成 2026-09-12 的"直接 detach 成功"，2026-09-14 再变成"建本地跟踪分支并附着 HEAD"（已存在则落到本地同名分支；身在该分支时是无操作成功——`switch` 同分支本就不碰工作树，脏文件挡不住它，真被挡住的场景是身在别处切回来）；真被挡住时看到的是文件名和做法，不再是 pathspec。harness 第 9 节锁死：跟踪检出附着本地分支且对上远端、非远端 `track` 被拒、裸 revision 仍 detach、挡路时报错含文件名且不含 pathspec；第 16 节锁死无本地副本时的建跟踪全链路。`switch <name>` 仍是分支名的唯一形状——`checkout` 类命令禁止出现两个裸位置参数（第二个会被读成 pathspec，这是 git 的固定语义，不是偶然）。
- 约束：以后给"尝试 A、不行换 B"的命令加兜底，必须同形拼、失败保留第一条；`checkout` 类命令禁止出现两个裸位置参数（第二个会被读成 pathspec，这是 git 的固定语义，不是偶然）；视图传的意图位（`track`）引擎必须复验，不得信任。
