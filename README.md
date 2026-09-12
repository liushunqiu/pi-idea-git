# IDEA Git —— PI-Desktop 的 IntelliJ IDEA 风格 Git 工具窗口

`local.pi-idea-git` 把 IntelliJ IDEA 的 Git 界面搬进 PI-Desktop：你真的会一直待在里面的那两个
工具窗口、暂存/未暂存分组、按代码块（hunk）暂存、图形化日志与 Console。

这里的每一个 Git 动作都是**真的去调 `git`**，对着真实的索引干活。没有任何功能是在渲染层
假装出来的，所以终端里的 `git status` 永远和面板显示一致。

—— 以下内容按「能看到什么 → 怎么用 → 为什么这样实现 → 怎么改」排列。

| 章节 | 内容 |
| --- | --- |
| 界面与功能 | 两个视图、Changes 区、diff 面板、Log/Console 全部能力表 |
| 快捷键 | 绑定表，以及「焦点在哪决定谁能收到按键」 |
| 与 IDEA 的有意差异 | 哪些地方刻意不照抄 |
| 权限 | 6 项权限各自为什么需要 |
| 工程结构 | 源码布局、为什么必须构建、生成物为什么不能手改 |
| 引擎设计 | 视图如何与 Git 通信、环境补齐、状态与补丁的关键取舍 |
| 一个项目里的多个仓库 | 子模块与嵌套仓库的识别、Root 选择器与其边界 |
| 远端同步 | 推送被拒、分叉、冲突、以及未完成合并的出路 |
| 认证 | 为什么插件不需要凭据，以及唯一做不到的事 |
| 生成提交信息 | 用宿主模型起草，语言/格式/范围如何处理 |
| 配色 | 哪些取自 JetBrains 文档，哪些是刻意的偏离 |
| 测试与工具 | harness / smoke / drive / 决策笔记门禁 |
| 开发与打包 | 加载本地插件、构建、打包含权限扩张的坑 |
| 已知缺口 | 诚实清单：哪些控件无效、哪些能力受限 |
| 记忆与决策笔记 | `.memories/`、`.agents/notes/` 与反向索引 |

## 界面与功能

工作面板里有两个 docked 视图，对应 IDEA 的两个工具窗口：

| 面板 | 对应 IDEA | 内容 |
| --- | --- | --- |
| **提交**（`views/commit.html`） | Commit 工具窗口，`Alt+0` | Changes 区（Staged / Unstaged / Unversioned Files / Merge Conflicts）、选中文件的 diff、带历史的提交信息框、Amend、Sign-off、Commit、Commit and Push |
| **Git**（`views/git.html`） | Git 工具窗口，`Alt+9` | **Log** 页签（分支面板、带图形与引用徽标的提交列表、changed files、commit details）与 **Console** 页签 |

> `Alt+0` / `Alt+9` 是 IDEA 自己的绑定，插件**没有**注册热键（`manifest.json` 里没有
> `keybindings` 段）；这里只是告诉你它们在 IDEA 里对应什么。

命令面板里另有两条命令：`IDEA Git: Open as a separate window`（把两个窗口并到一个标签栏里，
宽屏用，加载 `renderer/index.html`）与 `IDEA Git: Refresh repository`。插件在启动时激活
（`activationEvents: onStartup`）。

### 功能对照表（用 IDEA 自己的说法）

| 功能 | 位置 | 说明 |
| --- | --- | --- |
| `Staged` / `Unstaged` / `Unversioned Files` / `Merge Conflicts` | 提交 → Changes 区 | 按**目录树**分组，每个文件落在它所属的文件夹下。文件夹的勾选是级联的：勾上会把其下所有文件（含更深层目录）加入索引，取消则整棵子树移出索引。同时有已暂存与未暂存改动的文件会**同时出现在两组里**——Git 自己就是这么报的 |
| 视图选项（齿轮） | 提交 → Changes 头部 | `Group by Directory`（目录树）与平铺模式切换（关掉它就是平铺）、`Compact Middle Directories`（`src/views/app` 合成一行）、`Collapse All`、以及「全部加入索引 / 全部移出索引」两个动作。两个视图选项都会持久化 |
| 过滤变更 | 提交 → Changes 头部 | 把树收窄到匹配的文件、并保留其祖先目录；分组标题显示 `matched/total`。`Esc` 清空 |
| `Commit Message` + 提交信息历史 | 提交 → 底部 | 时钟按钮回放之前写过的信息，最新在前，跨重启保留（本地无历史时给提示，菜单底部有 `Clear All`） |
| `Generate Commit Message` | 提交 → 底部 | 用**宿主自己的模型**起草信息。描述当前选中的文件；没选文件时描述所有已暂存内容；箭头菜单用来挑模型 |
| `Amend`、`Sign-off commit` | 提交 → 底部 | `--amend`、`--signoff` |
| `Commit`、`Commit and Push` | 提交 → 底部 | 拆分按钮；下拉里还有 Amend / Sign-off / 回滚（把已暂存内容全部移出索引） |
| 每个代码块的 `Include into commit` | 提交 → diff 面板 | **局部提交**。每个 hunk 带一个勾选框；切换它时用重建出来的补丁跑 `git apply --cached`（或 `-R`），于是只有被选中的 hunk 进入这次提交 |
| `Stage Hunk` / `Discard Hunk` / `Unstage Hunk` | 提交 → diff 面板 | 鼠标悬停到工作区 diff 的 hunk 头时出现；已暂存 diff 上则是反向的 `Unstage Hunk` |
| hunk 头上的附注 | 提交 → diff 面板 | 纯空白 hunk 标 `· whitespace only`；子模块指针变化标 `· submodule abc1234 → def5678` |
| `Show Diff`、`Rollback`、`Add`/`Remove from index`、`Open File`、`Reveal in File Manager`、`Copy Hash` | 提交 → 文件右键菜单 | `Rollback` 会先确认；它会删除未跟踪文件、还原已跟踪文件 |
| 分支控件（`main ↑2 ↓1`） | 两个工具栏 | 分支名、领先/落后，点开是本地/远端分支列表，点一行即 checkout；`New Branch`、`Fetch`、`Pull`、`Push`、`Force Push (with lease)`、`Stash Changes` 与储藏列表。（分支的**右键动作菜单在 Git 视图的 `Branches` 面板**里，工具栏弹层没有） |
| 仓库控件（`mod · submodule`） | 两个工具栏 | 列出工作区仓库以及嵌套在它里面的每一个仓库——子模块、以及恰好住在这里的克隆——选中它就把整个工具窗口对准那个仓库。只有一个仓库时（单仓库项目）隐藏 |
| `Log`、`Console` | Git → 页签 | Console 显示插件跑过的命令与输出，失败标红，可 `Clear All`（见下方「已知缺口」：探测型命令成功时不记录） |
| 提交图 | Git → Log | 泳道由父提交信息算出；分支尖端黄色、本地分支绿色、远端紫色、标签灰色。自己的提交 subject 加粗，当前分支的行有底色 |
| `Branches` 面板 | Git → Log → 左侧 | `Local branches` / `Remote branches`，点击即 checkout，右键出动作菜单 |
| `Changed Files`、`Commit Details` | Git → Log → 列表下方 | Details 显示哈希、作者、日期、subject 与完整正文 |
| `Graph Options` | Git → 工具栏 | `By commit date` / `Topologically`、`Show First Parent`、`No Merges`、`Show Graph`、各面板开关 |
| 过滤 | Git → 工具栏 | 文本搜索、分支过滤（见「已知缺口」：路径过滤字段目前不参与过滤） |
| 提交动作 | Git → Log → 右键提交 | `Show Diff`、`Copy Revision Number`、`Checkout Revision`、`New Branch from Here`、`New Tag`、`Cherry-Pick`、`Revert`、`Reset Current Branch to Here`（soft/mixed/hard）、`Edit Commit Message`（仅 HEAD） |
| `Side-by-side viewer` / `Unified viewer` | diff 面板头部 | 两者渲染同一份解析好的 hunk |
| `Ignore Differences` → `None` / `Ignore whitespaces` | diff 面板齿轮 | 由 Git 自己实现（`git diff -w`），不是把行藏起来。开着它时**禁用 hunk 暂存**，因为忽略空白的 diff 不是合法补丁 |
| `Show Whitespaces` | diff 面板眼睛图标 | 空格渲染成 `·`，制表符渲染成 `→` |
| `Show Line Numbers` | diff 面板齿轮 / commit diff 浮层头部 | 行号栏。提交视图默认**关**、且这个开关会被记住；commit diff 浮层默认**开**，但每次打开都回到默认（浮层不持久化） |
| `Collapse Unchanged Fragments` | diff 面板 | 长的上下文会折叠成一行可点击的条（`⋮ N 行未修改`）。只在**统一视图**里折叠，并排视图不折 |
| 高亮差异 | diff 面板 | **词级**：行中间变化的部分被标出来，于是 `1.0.0` → `1.1.0` 只标出那一个不同的字符 |
| 提交区状态行 | 提交 → 提交按钮上方 | 三种状态：进行中的操作（带 `Continue`/`Abort`）、冲突提示、`Nothing is staged` 警告，常规时显示「将提交 N / M 个文件」 |
| Console 细节 | Git → Console | 每条命令带 `[hh:mm:ss]` 时间戳、右上角显示条数、独立的 Refresh、空态提示 |
| 工具栏右侧 | 两个工具栏 | 当前仓库/工作区目录名 |

`Ctrl+F5` 的行为——「每个动作之后都刷新」——是内建的：任何写入动作之后都会刷新状态、diff 与列表。

## 快捷键

宿主在主窗口渲染层跑应用自己的快捷键，而插件视图是独立的 `WebContentsView`——所以**焦点在视图里时，宿主收不到按键**。
结论：**凡是按钮广告出来的键，都必须在页内自己绑定**，下面这些就是：

| 动作 | macOS | Windows / Linux |
| --- | --- | --- |
| 刷新 | `⌘R` | `Ctrl+R` |
| 刷新（IDEA 的绑定） | `⌃F5` | `Ctrl+F5` |
| 加入索引 | `⌘⌥A` | `Ctrl+Alt+A` |
| 回滚（先确认） | `⌘⌥Z` | `Ctrl+Alt+Z` |
| Show Diff | `⌘D` | `Ctrl+D` |
| 提交信息（提交视图） | `⌘K` | `Ctrl+K` |
| 搜索日志（Git 视图） | `⌘F` | `Ctrl+F` |
| 关闭对话框 / 菜单 / diff | `Esc` | `Esc` |
| 在提交列表中移动 | `↑` `↓` | `↑` `↓` |

提示文案由绑定的同一份规格生成（`PIG.formatShortcut`），所以**不可能出现「写了却按不出」的提示键**——
这是个值得在设计上排除的错误，因为它直到有人去按才会暴露。

代码里还绑了：提交行上 `Enter` / `Space` 选中该提交；对话框里 `Enter` 确认；弹出菜单打开时自动聚焦第一个可选项；
`⌘⇧P` 会弹一句提示（见下）。

### 哪个键在哪里有效

宿主的加速键与插件的绑定住在不同地方，所以「同一个键干什么」取决于焦点在哪。值得精确知道：

| 按键 | 应用内（焦点不在视图里） | 本插件视图内 |
| --- | --- | --- |
| `⌘K` / `Ctrl+K` | 应用的**会话搜索** | **提交视图**：聚焦提交信息框。**Git 视图**：无（应用的搜索在这里够不到） |
| `⌘⇧P` / `Ctrl+Shift+P` | 应用的**命令面板** | 没用——按键到不了应用，所以视图会明确告诉你该去哪（`Alt+Space`） |
| `Alt+Space` | 插件启动器 | **一样可用——它是真正的全局快捷键** |
| `⌘R` / `Ctrl+R` | 重新加载 | 刷新仓库 |
| `⌘D`、`⌘⌥A`、`⌘⌥Z`、`⌘F`、`Esc`、`↑` `↓` | 应用自己的含义 | 插件的含义，见上表 |

所以：**要跑应用级命令（包括 `IDEA Git: Open as a separate window`），按 `Alt+Space`，或者点回应用里用 `⌘⇧P`。**
现在在视图里按 `⌘⇧P` 会弹一句说明，而不是毫无反应。

## 与 IDEA 的有意差异

- **没有编辑器。** IDEA 把 diff 开在编辑器标签页里；这里提交的 diff 开在 Git 工具窗口内的浮层里。
  `Jump to Source` 换成了 `Open File`（交给系统默认程序打开）与 `Reveal in File Manager`。
- **没有 changelist。** IDEA 的 changelist 是 IDE 侧概念，Git 里没有对应物；Staged/Unstaged 的分组取代了它。
  一份工作副本，一份变更集。
- **没有 shelf。** `Stash` 覆盖 Git 原生的那部分场景。
- **并排视图不联动滚动。** 左右两栏作为一个网格一起横向滚动，于是两栏永远在同一个偏移上。
- **`Edit Commit Message` 只对尖端提交开放**，因为改写更早的提交需要 rebase。
- **`Ignore whitespaces` 模式下禁用 hunk 暂存**，未跟踪文件也禁用——忽略空白的 diff、以及对着 `/dev/null` 的 diff，
  都不是 Git 会接受的补丁。整文件的 `Add` 仍然可用。
- **删除行是红色，不是 JetBrains 的灰色**，暗色 diff 配色是调出来的而非照抄的。见「配色」。

## 权限

| 权限 | 为什么 |
| --- | --- |
| `ui.panel` | 独立窗口（`renderer/index.html`） |
| `ui.view` | 两个 docked 视图 |
| `clipboard.write` | `Copy Revision Number`、`Copy Hash` 这类复制动作 |
| `fs.read` | 对变更文件执行 `Open File` 与 `Reveal in File Manager` |
| `models.list` | 生成按钮上的模型选择菜单 |
| `agent.complete` | 用宿主模型起草提交信息 |

`PluginCheck` 会把 `clipboard.write` 与 `fs.read` 报成 unused，因为它只扫 `main.js`；这两个都是从视图经面板桥调的
（`clipboard.writeText` 在 `src/common.js`，`fs.openDefault` / `fs.reveal` 在 `src/commit-view.js`），属误报。

`fs` 的读取范围声明为 `{"root":"workspace","scope":["**"]}`——只读工作区。

**唯一一处插件写工作区的地方**是丢弃未跟踪文件（或还原未跟踪文件的 hunk）：引擎直接 `fs.rmSync` 删文件，
视图侧会先确认。除此之外不碰工作区的文件——所有变更都经过 `git`。
（插件另有一处写盘，写的是它**自己**的数据目录：`prefs.json`，存提交信息历史与视图选项，不落在仓库里。）

## 工程结构

```
main.js              Node 进程：Git 引擎 + 通道路由（约 2600 行）
src/theme.css        IDEA 调色板与组件样式 ─┐
src/layout.css       布局与响应式            ─┤
src/common.js        桥、i18n、图标、弹出菜单 ─┤ tools/build.mjs
src/diff.js          统一 diff 解析与渲染    ─┤ 内联进
src/commit-view.js   提交工具窗口            ─┤
src/git-view.js      Log + Console，以及启动 ─┘
views/commit.html    生成物——不要手改
views/git.html       生成物——不要手改
renderer/index.html  生成物——两个窗口并到一个标签栏
tools/build.mjs      内联器
tools/harness.mjs    引擎回归（真实仓库，136 条断言）
tools/drive.mjs      不开 GUI 直接驱动引擎
tools/smoke.mjs      用桩 bridge 渲染视图到 .smoke/
tools/notes.mjs      决策笔记门禁（+ tools/agent-notes/ 的 vendored 校验器）
manifest.json        清单：视图、命令、权限、engines
```

### 为什么必须有构建步骤

宿主用 `loadURL(pathToFileURL(entry))` 加载视图，也就是 `file://` URL，而 **Chromium 拒绝从 `file://` 加载 ES module**
（不透明源）。官方自带插件是靠「每个视图一个巨大的自包含 HTML」绕过去的；`tools/build.mjs` 从可读的源码产出同样的形状：

```bash
node tools/build.mjs     # 写出 views/*.html 与 renderer/index.html
```

改 `src/`，跑构建，正在运行的开发插件会热重载。直接改生成出来的 HTML 是白费力气——下次构建就覆盖了。

> 生成器固定写 `lang="en"`（`tools/build.mjs`），与界面语言无关。只影响无障碍语义与字体回退，不影响显示。

## 引擎设计

### 视图怎么跟 Git 说话

`main.js` 跑在专属 Node 进程里（Electron `utilityProcess`），所以它有真正的 Node API、能起 `git` 进程。
视图是沙箱页面，只拿到 `window.pluginBridge`。宿主自己不实现的通道**全部**转发给插件导出的 `onPanelInvoke`——
这正是自定义通道能工作的原因：

```
视图  --pluginBridge.invoke("git/…")-->  宿主  -->  onPanelInvoke  -->  git
```

`onPanelInvoke` 里一共 **36 个 `git/*` 通道**；不认识的通道会明确回 `Unsupported channel`，而不是静默什么都不做。

### 两个环境事实决定了引擎的形状

- 插件进程只被交给 `PATH`、`LANG` 和临时目录变量，**没有 `HOME`**（Windows 上是 `USERPROFILE`），
  而 Git 需要它来读 `~/.gitconfig`（身份、凭据助手）。所以每次调用都自己补回去。**这是「零配置认证」的实现基础。**
- 没有终端，所以交互式提示被关掉（`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`、`GIT_EDITOR=true`…），
  于是 `push` / `pull` 会**快速、可见地失败**，而不是对着一个没人能输入的密码框永远挂着。

顺带补上的还有 `GIT_OPTIONAL_LOCKS=0`（读操作不拿索引锁）、`GIT_PAGER=cat`、`GIT_CONFIG_NOSYSTEM` 兜底。
`git` 可执行文件在 `PATH` 与一组标准安装路径里找，找不到会给一条明确的错误，而不是让每个动作都莫名失败。

### 命令的执行边界

单条命令 **25 秒**后 SIGKILL——刻意短于宿主的 30 秒面板超时，否则超时会以「面板无响应」的形式出现，
而看不到 Git 到底卡在哪。每条输出流上限 **8 MiB**，超出的部分是巨量日志，不是信息。

### 状态是怎么读的

状态用 `git status --porcelain=v2 -z` 读：`-z` 是唯一能**原样**返回路径的形式，所以空格与非 ASCII 文件名能活下来；
v2 把索引列与工作区列分开，而这两列正好就是界面显示的「已暂存 / 未暂存」。
（只有一处例外：生成提交信息时为了避免重命名被重复描述，另跑了一次 v1 的 `--porcelain`。）

### diff 与补丁

diff 用 Git 默认的 `a/`-`b/` 前缀产出，因为 `git apply` 会剥掉一个前导路径分量——
**给 `git diff` 加 `--no-prefix` 会让 hunk 补丁被拒绝**，这是本仓库的一条硬性约定。
回传给 Git 的补丁是「原始头部 + 被选中的 hunk」，这正是 `--recount` 能接受部分选择的原因。

补丁还带**来源仓库标识**：`git/apply-patch` 会校验 `root`，不符则回 `STALE_REPOSITORY`。
因为 `discard` 会写工作树，一个「读出来、过一会儿再写回去」的通道必须能拒绝来自已切换仓库的旧补丁。

### Console 记什么

Console 是环形缓冲：**最多 200 条**，每条 stdout / stderr 各截到 **4000 字符**。
探测型命令（`rev-parse`、`ls-files`、`for-each-ref`、`config`、`--version` 等）成功时**不记录**——
它们每次刷新都跑，记下来只会把有用的输出冲掉。

### 失败信息是分层的

短消息只保留 6 行，并**剔除 `hint:` 行**——那些行是给终端读者的，界面改用本地化的补救说明；
但如果剔除后会一个字都不剩，就退回保留 hint（规则是「说点什么」，不是「来自 hint 的就一律不说」）。
完整 stdout+stderr 走 `detail` 字段，由 toast 上的「详情」链接打开对话框查看（detail 也有 4000 字符上限，超出加省略号）。

引擎给每一类失败打**稳定的分类码**，由视图本地化成措辞：`authHint`（`ssh` / `credentials`）、
`pushHint`（`remote-ahead` / `remote-rejected`）、`pullHint`（`diverged` / `conflicts`）。
（`needsReconcile` 不是分类码，它是引擎内部用来判断「是否该补一次 `--no-rebase`」的谓词，视图看不到它。）
新增任何失败分支时，别把 Git 的原文丢掉，也别把整段塞进 toast。

### 相对路径与真实路径

路径比较一律按**真实路径**：Git 返回的是真实路径（macOS 上 `/private/var/…`），宿主给的是用户打开时的路径（`/var/…`）。
用字符串前缀比较会把同一个目录判成两个，后果是**静默降级**（「打开文件 / 在访达中显示」被禁用），而不是报错。
视图侧不要自己拼绝对路径，用引擎算好的 `repo.workspacePrefix`（`null` 有语义：仓库在工作区之上，不能折成 `"."`）。

## 一个项目里的多个仓库

一个项目常常不止一个仓库：一个已检出的子模块，或者一个恰好住在另一个仓库里的克隆。它们是**独立的仓库，不是文件夹**——
父仓库只记录子模块*指向哪个提交*——所以父仓库的 `git status` 永远只给一行 gitlink，看不到子模块里面的文件。
Commit 视图因此做成 IDEA 式的**聚合显示**：先按暂存/未暂存/冲突/未跟踪分大类，大类下按**仓库**排——
每个有改动的仓库（父仓库参与字母排序）各占一行"颜色块 + 名 + N 个文件 + 分支徽标"，文件再嵌在行下展开，
暂存、diff、hunk、回滚都直接可用；
提交按钮用同一提交信息逐仓提交（子模块先、父仓库后），父仓库随后出现的指针更新再提交一次即收敛。
`Commit and Push` 把刚才提交的那 N 个仓逐个推出去，不再只推当前仓。
仓库行右键"切换到该仓库"会跳到 Root 选择器的那个仓库（Log/分支/储藏仍按仓库切换查看）。
推送走 IDEA 式的 **Push 对话框**：多仓时工具栏 Push 列出每个仓库的分支去向（`main → origin/main`）、`↑/↓` 与勾选框，
`Push All` 逐仓推送，单个失败不挡其他仓，行内显示成功/拒因；单仓时保持直接推送。Git 视图工具栏同样有 Push 入口。
两个工具栏最左边的仓库控件仍然是切换当前仓库的东西：选中一个，视图背后的每条命令（状态、diff、日志、分支、储藏、提交、hunk 暂存）
就都在它里面跑。

工作区本身不是仓库、但文件夹里并排摆着多个仓库时（`repoA/`、`repoB/`），同样可用：仓库列表列出它们（`sibling repository`
徽标），Commit 视图聚合显示其他平级仓的改动，Push 对话框一次推完。空文件夹（内无仓库）仍报"不是 Git 仓库"。

列表由工作区仓库出发遍历构建，且**遍历是有边界的**：最多 4 层深、最多 5000 个目录，并且不下潜依赖/构建/缓存目录
（`node_modules`、`vendor`、`Pods`、`.venv`… 共 17 个名字，含 `.git`）。
但 `.gitmodules` 里**声明**的路径不受这些边界限制——那里的条目是关于项目的断言，而边界只是对项目规模的猜测。
已声明但未检出的子模块不列出：没有工作树，就没得显示、也没得提交。

两个长得很像的仓库是**按父仓库的索引**区分的，不是按 `.gitmodules`：被父仓库记成 `160000` gitlink 的路径是**子模块**
（在那里暂存等于记录一个提交），其他都是**嵌套仓库**（父仓库不存它的任何文件）。界面上分别打 `submodule` / `nested repository` 徽标。

这个选择属于**打开的那个项目**，不写进 prefs：切项目、或者把目录移走，就退回工作区自己的仓库。

## 远端同步：推送被拒与合并冲突

被拒绝的推送是**常规情况，不是异常**：别人往同一个分支推了东西。Git 会在 stderr 上说明，并在 `hint:` 行里给出补救办法，
这两者都读——短消息里是 Git 自己那几行，上面那句分类好的补救说明是插件的：

| 失败 | 插件怎么说 |
| --- | --- |
| 推送被拒（`fetch first`、`non-fast-forward`、`stale info`） | 远端有你没有的提交——先 Fetch，再 Pull，然后重新推送；如果该保留的是本地历史，用 Force Push |
| 推送被拒（`protected branch`、钩子） | 服务器拒绝了它；分支大概是受保护的 |
| 拉取卡在冲突上 | 在 Changes 区里解决，然后提交 |
| 分叉且 `pull.ff = only` | 先 merge 或 rebase，再推送 |
| 没有存下来的凭据（HTTPS） | 在终端里跑一次 `git push` 让凭据助手存下来，再重试 |
| `Permission denied (publickey)` | 换成 HTTPS 远端，或者让密钥不依赖 `ssh-agent`——宿主不传 `SSH_AUTH_SOCK` |

三条引擎决策撑起这套行为：

- **两个流都读。** `git push` 把拒绝写在 stderr，但 `git merge`（也就是 `git pull` 的后半段）把 `CONFLICT` 写在 stdout。
  只读 stderr 会把一次冲突的 pull 渲染成一段「看起来像成功的 fetch 日志」。
  **判据是「失败时哪一行能指出下一步」，不是「哪个流更像错误流」。**
- **`git pull` 按配置跑，只在 Git 自己因缺策略而拒绝时重试一次。** 自从 2.27，在分叉分支上裸跑 `git pull` 是硬失败
  （`fatal: Need to specify how to reconcile divergent branches`）——于是被拒的推送让你跑的那条命令自己跑不起来。
  只有这一个失败会被 `--no-rebase`（merge）重试一次，其余结果都是 Git 的。
  这里不做策略推导，所以 `branch.<name>.rebase`、`pull.rebase = merges|interactive`、`pull.ff = only` 全部照常生效——
  它们是被**第一次尝试**读到的，而不是被一份更差的 Git 优先级规则副本读到的。
- **Force push 只能是 lease，不能是裸 force。** `--force-with-lease` 是插件唯一能发出的 force：如果远端已经不在这个窗口
  上次看到的位置，它就会被拒绝，于是同事的推送永远不会被抹掉。远端与 ref 是位置参数，所以交给 Git 之前会先校验——
  `git push origin --force` 正是「未校验的 `-` 开头取值」会产出的东西。

**推送推到哪里，由分支追踪关系决定**，不是 `origin` + 本地分支名。这两者只在分支追踪同一处时才一致——
一旦分支追踪别处，旧行为就会把新分支推到 `origin`，而 ↑/↓ 标签还在对着真正的 upstream 计数。
完全没有 upstream 时回退范围很窄：`origin`，或者只有一个远端时就用它。
有多个远端又没 upstream 时无从推断，于是拒绝推送并列出远端列表，而不是把分支发布到排序第一个的名字上去。
首次推送可以直接建立追踪（追加 `--set-upstream`）。
另外两种会明确拒绝的情况：分支追踪的是一个**本地分支**（名字里没有 `/`），以及**尚无提交**的分支。

### 离开一个未完成的合并

冲突的 `pull` 会把仓库留在合并中间，于是提交按钮上方的状态行会写出**进行中的操作**并带上它的出口：
四个操作都有 **Abort**，只有序列类的三个（cherry-pick / revert / rebase）有 **Continue**。
merge **不进这个列表**：它没有需要继续的半成品状态，一次合并是靠**提交**来结束的——所以插件不给它 Continue
（顺带说明：`git merge --continue` 在终端里是存在的，只是这里用不上，因此不提供）。
Continue 用 `core.editor=true` 跑，因为没有终端可以写提交信息，否则 Git 只会失败——用的是该操作已经记录好的那条信息。

这行在**冲突被暂存之后**仍然保留操作名，这才是重点：解决冲突会把 `u` 行变成普通索引行，
于是 porcelain 不再提它——而「把所有冲突都暂存了」正是 `--continue` 开始能够成功的时刻。
把检查限制在「有冲突时」会藏起来插件自己创造的那个状态的唯一出口，所以探针在**有冲突 _或_ 刚才发现过操作**时都运行。

不认识的操作名不会被运行：引擎只接受它能报出的那四个名字，所以一个畸形的载荷不会变成一个任意的 `git` 动词。

### 配置配方

**GitHub，HTTPS** —— `gh auth login` 然后 `gh auth setup-git` 会把助手写进 `~/.gitconfig`。不需要别的。

**GitLab（任意主机），HTTPS** —— 让 Git 存一次：

```bash
git config --global credential.helper osxkeychain   # macOS（Linux 用 libsecret，
                                                    # Windows 用 manager）
git push            # 输一次 token，此后都会被存下来
```

自建 GitLab **不需要任何插件侧配置**，因为用的就是你 shell 用的那个凭据库。

**SSH** —— 无口令的密钥、或者口令存在 macOS 钥匙串里（`UseKeychain yes`）的密钥，可以直接用。
只活在 `ssh-agent` 里的密钥不行，因为宿主不会把 `SSH_AUTH_SOCK` 交给插件进程；这类情况请用 HTTPS 远端，或把密钥加进钥匙串。

> 多账号配置：插件读的是你的凭据助手为该 URL 解析出的那个账号，所以
> `credential.<url>.username` 和 `includeIf "gitdir:…"` 的规则在这里和终端里一样生效。

## 认证

**插件不持有任何凭据，也不需要。** 它跑的是用户自己的 `git`、带的是用户自己的 `HOME`，
于是它继承的正是终端已经在用的那套东西：同一个 `~/.gitconfig`、同一个凭据助手、同一份 `~/.ssh/config` 与密钥。
shell 里什么能认证一次 `git push`，这里就能，在 GitHub、自建 GitLab 或任何别的地方——**没有任何按主机配置的东西**。

这种继承是刻意的。插件不该被托付 token，而一份「按主机填凭据」的表单也只能覆盖它认识的那些主机。

插件唯一做不到的事是**提问**。工具窗口背后没有终端，所以提示被关掉，命令会立刻失败，而不是永远挂在一个没人能输入的密码上。
发生这种情况时，原始的 Git 错误会连同「该怎么办」一起显示（见上一节的表）。

## 生成提交信息

提交信息框旁边的闪光按钮会替你起草信息。它通过 `pi.agent.complete` 找**宿主**的模型，
所以用的就是你**已经**配好的 provider、模型与额度——插件不持有 API key，也不新增任何账号。

它发出去的是三样东西：变更本身、仓库近期提交的**subject 与正文样本**，以及这份样本测出来的东西——
提交语言、subject 是否带 `type(scope):` 前缀、有没有人写正文。样本取**最近 40 条**提交。
diff 截断在 **12 000 字符**：这是提示词，不是备份。

**语言。** 由闪光按钮旁的箭头菜单决定，因为「照着仓库写」不是一条语言策略：
一份全英文的历史会让中文读者也拿到英文草稿。选项是
**跟随仓库历史**（默认：用实测语言，没有历史时回退到界面语言）、**简体中文**、**English**。
无论哪种，`type` 与 `scope` 都保持 ASCII，就像 Conventional Commits 的各种语言译本做的那样——
`feat(登录): 支持短信验证码`。

提示词按 Git 自己的惯例（git-commit(1)、Tim Pope、Chris Beams、Conventional Commits 1.0.0）写明硬性规则：
subject 后一个空行、目标 50 字符上限 72（中文约 25 字，因为 CJK 字形大致是两倍宽）、
结尾不加句号、英文 subject 用祈使句、正文说 **why** 而不是复述 diff、
`BREAKING CHANGE:` 是唯一允许它自行追加的 trailer。

**形状是被强制的，不是被请求的。** 提示词不能是格式的最后一道防线，因为要命的那个失败对写提示词的人是隐形的：
Git 把**第一个空行之前的每一行**都当成标题，所以一个把正文紧贴在 subject 下面的回复**根本没有正文**——
它是一个巨大的 subject，而这正是读者口中的「提交信息不规范」。所以回复在进入信息框之前会过一遍 `formatCommitMessage`：

- 先剥掉 ``` 代码围栏和 `commit message:` / `提交信息:` 这类前缀（模型很爱加）；
- 保证 subject 是单行，并且无论模型怎么排，后面都恰好一个空行；
- 过长的 subject 会把尾巴**在从句边界**挪进正文，而不是截断，于是模型从 diff 里读到的信息不会丢；
- 把正文折到 Git 的 72 列，CJK 字形按终端那样算两列；
- 把分号串起来的从句拆成「一个想法一条」的项目符号；
- 当 `,` `;` 夹在中文字符之间时规范成 `，` `；`——而 ASCII 原样保留，所以 `feat(a,b): …` 不会被碰。

它不改写任何措辞，而且是**幂等**的：形状已经正确的草稿会原样通过。

**范围。** Changes 列表里有选中的文件时，它描述*那个文件*；没选中时描述*所有已暂存内容*。
用了哪一种会在提示条里说明，所以范围永远不是猜的。两者都不存在时它会直说，而不是编一条信息出来。

**草稿就是草稿。** 它落在信息框里，可以照常编辑。如果你已经写了内容，它会先问一句再替换。

权限是 `models.list`（提供模型菜单）与 `agent.complete`（高风险——会花你的模型额度）。
宿主把这件事限流到**每分钟 8 次**；插件把这个限制报出来，而不是盲目重试。

## 配色

浅色配色大部分抄自 JetBrains 自己的文档：新增行 `#c6e4c1`、修改行 `#e9eff9`、变化片段蓝 `#c6d7f0`、
面板分隔线、编辑器边栏的变更条，以及文件状态色（新增 `#0a7700`、修改 `#0032a0`、未版本控制 `#993300` 等）。
余下的界面饰件照着 IntelliJ Light 与 Darcula 的样子来，那些地方 JetBrains 没有公布数值。

**一个刻意的偏离，两套主题都有：** JetBrains 把删除行记成一个中性灰（浅色 `#D7D6D6`）。
紧挨着绿色的新增，那个灰读起来像*褪色*而不是*被删掉*，所以删除用柔和的红色——浅色 `#f7d2d2`，暗色 `#452a2e`。

**暗色 diff 配色是调出来的，不是抄的。** 文档里的暗色值给出一种偏棕的行底色，而一块钢蓝色的片段补丁压在暗红行上会变成一团泥。
所以暗色带自己的一套值，而且变化片段的颜色跟着它所在的行走：删除行上更红，新增行上更绿。
`--diff-fragment-deleted` / `--diff-fragment-inserted` 是两个覆盖点（只在暗色主题里定义）；浅色主题不设它们，保留 JetBrains 的蓝。

主题切换走 `document.documentElement.dataset.theme`，由 `app.getAppearance` 初始化、并订阅 `appearance:changed` 跟随宿主。
全部都在 `src/theme.css` 顶部的 CSS 变量里，所以重新调一处就是改一行。

## 测试与工具

### 引擎回归

`tools/harness.mjs` 对着**当场造出来的真实仓库**驱动引擎——一个裸远端、一个直接初始化的工作副本加一个真正的 `git clone`、
一次真实的双人分叉、一个内含子模块的子模块——
并断言那些「拒绝」所依赖的行为：分类、消息、详情、先陈旧再 fetch 的 ahead/behind 标签、冲突的合并及其出口、
一次推送落到哪里（以及被拒绝落到哪里）、陈旧的 lease 永远不会覆盖同事的工作；
最后几段还包括：嵌套在另一个仓库里的仓库会被列出、可以被选中、可以在里面提交、扫描能看多远、
`.gitmodules` 的声明能推翻什么，以及一份来自「视图已经离开的仓库」的补丁会被拒绝而不是被应用。

```bash
node tools/harness.mjs        # 实测输出：136/136 passed，全部对着真实 git
node tools/harness.mjs --keep # 保留临时仓库，便于事后翻看
```

`PLUGIN_DIR` 可以把 harness 指向另一份检出。

### 决策笔记门禁

`.agents/notes/` 下的笔记承载「代码本身带不动的决定」——为什么是这个形状，以及它换掉了什么。
一篇没人能找到的笔记、或者头块漂移了的笔记，是下一个读者（人或 agent）不会信任的笔记，
所以形状是**强制**的而不是约定俗成的：

```bash
node tools/notes.mjs        # 两项校验：目录/分类/相对链接 + 头块/Status/必需章节
```

两个校验器逐字节 vendored 在 `tools/agent-notes/` 下，所以**无论机器上装没装那个 skill 都能跑**；
它们也由 `node tools/harness.mjs` 一起断言（136 条里有 2 条来自这里）。
本机 Node 26 能直接执行 `.ts`，不需要 tsx 或任何 flag。

### 不开 GUI 驱动引擎

`tools/drive.mjs` 调用的是视图调用**同一批** `onPanelInvoke` 通道，只是给了个桩 `pi` 全局，
所以一条流程可以从终端或测试脚本里跑通：

```bash
node tools/drive.mjs /path/to/repo git/repo
node tools/drive.mjs /path/to/repo git/stage '{"paths":["src/app.js"]}'
node tools/drive.mjs /path/to/repo git/commit '{"message":"Fix the thing"}'
```

用**削减过的环境**跑它，才和真实插件进程拿到的东西一致——`PATH`、`LANG` 和临时变量，但**没有 `HOME`**：

```bash
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node tools/drive.mjs . git/repo
```

这么跑等于复现了真实插件进程的环境，所以推送路径也能在**不加终端**的情况下对着任意远端试——
（注意 harness 里全部远端都是本地裸仓，没有真的往 HTTPS 远端推过；要验证真实托管，请自己挑一个远端跑上面这条命令。）

模型相关的两个通道有桩：`PIG_FAKE_MODELS`（值 `denied` 会返回 `PERMISSION_DENIED`）、
`PIG_FAKE_COMPLETE`（`RATE_LIMITED` / `error:…`）、`PIG_SHOW_PROMPT=1` 会把真正发出去的提示词打出来。

### 没有宿主也能看视图

`tools/smoke.mjs` 把构建好的视图配上桩 `window.pluginBridge` 写到 `.smoke/`，
于是那些难以按需制造的状态（仓库卡在合并中、一次被远端拒绝的推送、一个已检出的子模块作为当前仓库）可以渲染出来看：

```bash
node tools/build.mjs && node tools/smoke.mjs commit zh-CN
```

视图名与语言都是位置参数（产物是 `.smoke/<视图>-<语言>.html`）。桩在工具里，不在插件里，`.smoke/` 已 gitignore。

## 开发与打包

1. 扩展页右上角 **`···` → 「加载本地插件」** → 选这个目录。
2. 改 `src/`，跑 `node tools/build.mjs`，视图会热重载。
3. `PluginCheck` 然后 `PluginPack`，产出 `dist/local.pi-idea-git-0.2.0.piplug`。

质量底线（改完代码过一遍）：`node --check` 每个 `src/*.js`、`PluginCheck` 无 error、`node tools/harness.mjs` 全绿。

> **扩大 `permissions` 需要比「Reload」按钮更长的路径。**
> 保存触发的热重载会拒绝一个「要的权限多于运行实例已获批的」清单。卡片上的 **Reload** 按钮也不够：
> 它把新清单与 `registry.json` 里记录的权限求交集，**静默丢掉新增的那些，却照样报告成功**。
> 只有 **`···` → 「加载本地插件」**（重新选一次目录）会重读清单并重新征求同意。

宿主版本要求写在同一份清单里：`engines.piDesktop >= 0.8.0`。

## 已知缺口

诚实清单——这些是当前实现里确实存在、且用户可能撞上的限制：

- **Git 工具栏的路径过滤字段目前不影响结果**：它会被写进状态，但提交列表只按文本搜索过滤。分支过滤与文本搜索是有效的。
- **Console 不是「每条命令都记」**：探测型命令成功时不记录（见「引擎设计」），失败时 short/detail 都有长度上限。
- **hunk 级操作的适用面**：`Ignore whitespaces` 打开时禁用，未跟踪文件禁用（整文件 `Add` 仍可用）。
- **`Edit Commit Message` 只对 HEAD 开放**。
- **Commit 视图文件菜单的复制项**：有提交时显示「Copy Revision Number」并复制 HEAD（与 Log 视图一致），尚无提交时显示「复制路径/Copy Path」并复制文件路径。
- **两处「回滚」同名不同义**：提交下拉里的「回滚」把已暂存内容移出索引（`git/unstage`），文件右键里的「回滚」会**丢弃改动**（`git/discard`，未跟踪文件直接删除）。同名，但危险等级不同——按下去之前先看它问的是什么。
- **生成的 HTML 固定 `lang="en"`**，与界面语言无关。
- **执行边界**：单条命令 25 秒后被杀；Console 只留最近 200 条、日志一次最多取 500 条、错误详情与 Console 的每条输出都截到 4000 字符——这些截断是静默的。唯一会**报出来**的是 stdout 超过 8 MiB：那条命令被杀死并报 `Git output exceeded the size limit.`（stderr 超限则是静默停止收集）。
- **宿主超时**：任何一次面板调用超过 30 秒，都会以宿主侧超时的形式失败；引擎的 25 秒上限就是为了让失败先发生在 Git 这一侧。
- **测试不覆盖真实宿主**：harness 与 smoke 用的是桩，`PluginCheck` 只看 `main.js`（于是视图经桥调用的权限被误报为 unused）。

## 记忆与决策笔记

仓库里两类笔记都是纯 Markdown，随包一起走：

- `.memories/` —— 排查过程与运行时事实（插件运行时约束、渲染进程 CPU 诊断法、宿主 API 事实、
  push/pull 冲突、嵌套仓库、笔记 skill 漂移）。
- `.agents/notes/implemented/architecture/` —— 四篇落地决策笔记：为什么用 Git CLI 而不是解析 `.git/`、
  为什么做成两个 docked view、为什么加构建步骤、变更列表为什么改成目录树；
  提交信息提示词为什么把语言做成显式参数；远端冲突为什么必须读两个流、为什么只能有 `--force-with-lease`；
  为什么仓库列表是会话级的、以及 `kind` 为什么由 gitlink 判定。

核心代码入口留了一行 `// Note: <为什么这样做、放弃了什么> — 见 .agents/notes/…`，刻意不逐行标；
决定被取代时，这些注释就是要同步的代码清单。
