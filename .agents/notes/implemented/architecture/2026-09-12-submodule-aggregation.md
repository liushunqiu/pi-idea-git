# Agent Note: 子模块改动在 Commit 视图里聚合显示

Status: implemented

日期：2026-09-12
范围：`main.js`（`withRepoAt` / `readRepoFor` / `readSubmoduleStatuses` /
`git/submodule-statuses`，`git/{status,diff,stage,unstage,discard,apply-patch,commit,commit-message}`
接受 `repoRoot`）与 `src/commit-view.js`（聚合分组、对象式 selection、
多仓库提交）、`src/common.js`（新增 i18n）、`README.md`（多仓库一节）

## 问题

用户对照 IDEA 截图反馈：在 IDEA 的 Commit 面板里能看到 `backend` 子模块
内部 15 个待提交文件（含所在分支 `feature/#102448`），而本插件的 Commit
视图里只能看到一行 `M backend（子模块）`，里面的文件"看不到"。

根因是 Git 的事实，不是渲染 bug：父仓库的 `git status` 对子模块只打印
一行 gitlink（`1 .M S.M.. 160000 … backend`，已用 `$PI_SCRATCH_DIR/submod-repro`
实测确认），子模块内部的文件名在父仓库侧根本不存在。2026-09-12 的
nested-repositories 笔记据此做了"一次只看一个仓库 + Root 下拉切换"的决策，
并明确否决了"只在改动列表里分组显示"。但用户反馈证明：**默认停在父仓库时，
子模块的改动对用户是不可见的**——看不到就不会去切换，选择器的存在解决不了
发现问题。IDEA 的行为是聚合（按仓库分组、一次展示），用户要的是这个。

## 决策

保留 Root 选择器（单仓库项目的形态、Log/分支/储藏的按仓切换都不变），在
Commit 视图里补上 IDEA 式的**聚合分组**：父仓库的改动照常显示，其下为每个
"脏"子模块（及内嵌嵌套仓库）各渲染一个带分支名的分组头
（`backend（子模块 · feature/x） [切换到该仓库]`），组内是该子模块自己的
Staged / Unstaged / Unversioned 分组与文件树。旧笔记否决聚合的理由是
"分组只能展示、不能操作"——本次把这个前提拆掉了：操作的路由跟着文件走。

### 1. 引擎：`repoRoot` 显式覆盖，而不是第二个"当前仓库"

`readRepo()` 仍是唯一决定"当前仓库"的地方（`selectedRoot` 会话级、不写
prefs 的约定不变）。新增 `withRepoAt(payload, handler)`：当 payload 带
`repoRoot`（兼容旧字段 `root`）时，用 `readRepoFor()` 把它校验成仓库对象——
必须仍在 `workspaceRoot` 内、且 `resolveRepositoryRoot` 确认是仓库根——否则
拒绝。`git/{status,diff,stage,unstage,discard,commit,commit-message}` 经它
运行；`git/apply-patch` 用 `repoRoot` 定目标、`root` 定补丁来源并保留
`STALE_REPOSITORY` 校验（聚合视图里两者填同一个子模块根，老调用只填
`root` 时行为与原来一致：目标仍是当前选中仓库）。

### 2. 聚合状态只问"脏"的子模块，不做全量遍历

新增 `git/submodule-statuses`：读一次父仓库状态，从中取出带 `submodule`
标记的 gitlink 路径（即有变化的子模块），以及形如 `nested/` 且确能
`resolveRepositoryRoot` 的未跟踪内嵌仓库，对**每一个**跑 `readStatus`。
干净的子模块不查询（没有可展示的内容），所以平时是一次 `status` 的成本，
`backend/frontend/works` 全脏时是 1+3 次——远低于 `git/repos` 的全树遍历，
且不受 `REPO_SCAN_DEPTH` / 跳过清单限制（问的是 index 里已知的路径）。

### 3. 视图：selection 对象化，分组键按仓库隔离

`state.selection` 从 `"staged:a.txt"` 字符串改为
`{ rk, g, p, root }`（仓库键/分组/仓内路径/仓库绝对根，`rk="."` 为当前仓）；
`fileRow/dirRow/treeRows/flatRows/applyInclusion` 全部接受 `ctx` 并透传
`repoRoot`；折叠键从 `dir:staged:src` 改为 `dir:<rk>:staged:src`、
组键为 `<rk>:<staged>`（内存态，不做迁移）；diff 头显示仓库前缀；
hunk 的 stage/unstage/discard 经 `apply-patch` 时 `root` 与 `repoRoot`
同填 diff 来源根。

### 4. 提交：同信息多仓提交，子模块先、父仓库后

`git/commit` 本身一次只提交一个仓库（Git 的事实改不了：父仓库的提交永远只
能记录 gitlink 指针）。聚合视图的提交按钮收集"有已暂存文件"的仓库
（`stagedTargets()`，子模块在先、当前仓在后），用同一 message/amend/signoff
逐个调 `git/commit`。子模块提交后它的新 HEAD 在父仓库侧自然变成未暂存的
gitlink 更新，用户再提交一次父仓库即收敛——和在终端里逐仓提交的顺序一致，
不替用户自动暂存指针。`withPush` 只推当前仓（自动推子模块等于替用户发布，
不做）。任一仓失败即停并点名是哪个仓，刷新后状态一致。

### 5. 顺手修：`setAllInclusion` 从不存在

视图选项菜单里的"全部添加到索引 / 全部从索引中移除"调用的
`setAllInclusion` 在代码里根本没有定义（`grep` 全仓零定义），点一次抛一次
`ReferenceError`。本次把它实现为"按当前过滤词、对当前仓 + 全部聚合子模块
各发一次 stage/unstage"。

## 验证

- `node tools/build.mjs`（视图是构建产物）+ `node tools/harness.mjs`：
  136/136 通过（既有行为无回归）。
- `$PI_SCRATCH_DIR/verify-agg.mjs`（真父仓库 + 真子模块，桩 `pi` 直驱引擎，
  14 条）：父仓 gitlink 可见 → `git/submodule-statuses` 列出 `backend` 及
  其内 `a.txt` → `repoRoot` 指向子模块的 diff/stage/commit 全链路 →
  提交后父仓出现新指针 → 越界 `repoRoot` 与 `../` 路径均被拒绝。
- `PluginCheck` 通过（仅 `clipboard.write` 既有误报：视图经面板桥调用，
  检查器只扫 `main.js`）。

## Alternatives considered

1. **只在子模块行上显示文件数 + 点击跳转（不聚合 inline）**。否决：用户要的是
   "像 IDEA 一样看到文件"，计数徽标仍要两次跳转才能看到内容，发现问题只
   解决一半；且跳转后父仓上下文丢失（过滤词、选择、草稿按仓隔离）。
2. **聚合只读，操作仍强制切换仓库**（即旧笔记否决的原方案）。否决的理由不变
   且更强了：用户已经用"看不到"投票，"看得见点不动"会把抱怨换成另一种。
   本次 `repoRoot` 通道让聚合组的操作与切换后完全等价，否决前提已不存在。
3. **提交时自动把子模块新指针暂存进父仓并一次提交**（"一键全收"）。否决：
   父仓的 gitlink 暂存是有语义的（决定父仓历史记录哪个子模块提交），自动暂存
   等于替用户决定"父仓这次要跟进到哪"，且 amend 语义在多仓下无法定义；保持
   "逐仓提交、指针更新可见、再提交父仓"的显式两步。
4. **聚合时重用 `discoverRepositories` 全量遍历 + 缓存**。否决：刷新发生在每次
   stage/commit 之后，全树遍历（5000 目录预算）绑在刷新上不可接受；脏路径
   来自父仓 index，精确且便宜。
5. **把 `repoRoot` 做成所有 40+ 通道的必填参数**。否决：旧笔记的审计结论仍然
   有效——默认行为（无 `repoRoot` ⇒ 当前选中仓）覆盖全部老调用，改动面收敛
   到文件操作类通道；Log/分支/储藏仍走选择器，不需要也不应该被聚合参数污染。

## 后果

- **收益**：默认视图与 IDEA 对齐——`backend` 内的 15 个文件直接可见、可暂存、
  可看 diff、可提交；单仓库项目无任何变化（无子模块时不发额外调用）。
- **收益**：旧"只能展示不能操作"的否决前提被 `repoRoot` 消除后，聚合组与
  切换后的操作完全等价（同一 `readStatus` / 同一 `git add` cwd）。
- **收益**：附带修掉 `setAllInclusion` 未定义（菜单点一次抛一次错）。
- **代价**：提交是"同信息 N 次提交"而非一次提交（Git 的仓库边界决定了只能
  如此）；`withPush` 只推当前仓，子模块需各自推送。
- **代价**：`state.selection` 与折叠键格式变化（内存态，刷新/切换即重建，
  无持久化迁移问题）；`git/repo` 之后最多再多一次 `git/submodule-statuses`
  往返（仅当父仓状态里真有子模块行时）。
- **代价**：sequencer（merge/rebase continue/abort）仍只作用于当前仓——子模块
  内的冲突文件可见、可暂存，但收尾需切换过去；与 Log/分支/储藏的按仓语义一致。
- **风险**：`withRepoAt` 的 `root` 兼容字段与 `apply-patch` 的来源 `root`
  同名但语义不同（目标 vs 来源），已在注释里标明；新调用一律用 `repoRoot`。
