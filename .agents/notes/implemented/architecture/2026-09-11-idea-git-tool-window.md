# IDEA Git 工具窗口：实现取舍

日期：2026-09-11
状态：implemented
范围：`local.pi-idea-git`（PI-Desktop 插件）

## 目标

用户明确要求"效果跟 IDEA 里面的 Git 一样"。先做了一次联网规格调研（JetBrains
官方 Help 现行版 + Wayback 旧版快照），把 IDEA 的 Commit 工具窗口（`Alt+0`）、
Git 工具窗口（`Alt+9`）与 diff 查看器的布局、控件原文、快捷键与官方印刷色值
取齐，再照着实现。

## 决策

### 1. 用 Git CLI，而不是解析 `.git/`

宿主文件通道把 `.git/` 放在凭据拒绝清单里，正规路径本来也读不到；而
`git status --porcelain=v2 -z` 是唯一对空格/非 ASCII 路径无歧义、且天然区分
index 与 worktree 的契约。插件主进程是完整 Node 进程，`spawn` 可用。

代价：依赖用户机器上有 `git`（已实现多路径探测），且必须自己修 `HOME`。

### 2. 做成两个 docked view，而不是一个

IDEA 的 Git 能力分布在两个工具窗口（Commit 与 Git）。PI-Desktop 的工作面板
一次只显示一个视图，但可以贡献多个视图并各自带图标——这正好等价于"两个工具
窗口 + 图标"，比挤在一个视图里更接近 IDEA，也让每个视图更简单。

### 3. 分块提交走真实索引

IDEA 在 diff 里给每个 hunk 一个"纳入本次提交"复选框。这里把它映射到真实 Git
索引：勾选 = `git apply --cached`，取消 = `git apply --cached -R`。
行为与 IDEA 一致（取消勾选后该块离开已暂存集合），而且状态永远与
`git status` 一致，不做假象。

### 4. 加一个内联构建步骤

视图用 `file://` 加载，ES module 被 Chromium 拒绝。官方插件因此都是单文件
内联。加了 `tools/build.mjs` 从 `src/*` 生成自包含页面，避免手工复制多份代码。

## Alternatives considered

- **换用官方 `pi.gitlens` 插件**：该插件确实存在（用户曾安装 12 分钟后卸载），
  覆盖面也接近。放弃原因：用户明确要 IDEA 的手感，且已经卸载并搭了
  `pi-idea-git` 脚手架；分块提交的"复选框 = 真实索引"映射是本次的核心差异点，
  现成插件不提供。
- **改 PI-Desktop 内核加 Git API**：需要打补丁到 `app.asar`，升级即失效，
  且宿主明确不提供任意进程 API。放弃。
- **用 `fs` 通道直接读 `.git/index` 与对象**：`.git/` 被硬拒绝，且要自己实现
  index 解析、packfile 解压、diff 算法——巨大工作量换更差的正确性。放弃。
- **只做一个自定义通道 + 前端假装暂存**：无法保证与 `git status` 一致，
  用户一旦在终端操作就会错位。放弃。
- **把 detach 面板也做成独立实现**：改为复用同一份 `src/*`，面板只是多一个
  标签栏，避免三套 UI 分叉。
- **`--no-prefix` 美化 diff 输出**：试过，`git apply` 拒绝补丁
  （`header lacks filename information`）。改为保留默认前缀、在渲染层剥前缀。
- **side-by-side 折行显示**：折行会破坏两栏逐行对齐，改用横向滚动整块网格。
- **窄面板隐藏分支栏**：IDEA 始终显示分支栏，改为收窄到 128px。
- **删除行用灰（JetBrains 官方 `#D7D6D6`）**：实测在绿色新增行旁边读作"变淡"
  而不是"被删除"，用户也明确否掉了。改用柔红 `#f7d2d2`。
- **深色 diff 直接套用官方深色值**：实测底色偏棕、蓝色高亮压在红行上发浑浊，
  用户否掉。改为深色独立调色 + 高亮色跟随行的色相
  （`--diff-fragment-deleted` / `--diff-fragment-inserted`），浅色保留官方蓝。

## 已知近似

- 没有编辑器，提交 diff 用视图内覆盖面板呈现；`Jump to Source` 落地为
  `Open File` / `Reveal in File Manager`。
- 没有 changelist / shelf（IDEA 私有概念，无 Git 对应物）。
- `Edit Commit Message` 只对 tip 可用（改写更早的提交需要 rebase）。
- `Ignore whitespaces` 开启时禁用分块暂存（忽略空白的 diff 不是合法补丁）。
- 未跟踪文件不做分块暂存，只能整文件 `Add`。
