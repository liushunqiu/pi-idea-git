# Agent Note: Git 工具窗口操作补齐（对标 IDEA 日志/分支面板）

Status: implemented

## 问题

IDEA 的 Git Log 左树（HEAD / 本地 / 远端 / 标签分组 + 按 `/` 折叠）与右键菜单（Checkout / New Branch / Merge / Rebase / Rename / Delete / Set Upstream / Cherry-Pick / Revert / Reset / Tag 推送删除 / Stash Apply-Drop-Show / Remotes / Compare）在截图里清晰可见；本插件此前只有子集：分支菜单只有 Checkout / New Branch from Here / Push / Fetch，`mergeIntoCurrent` / `rebaseOnto` / `deleteBranch` 的 i18n key 已定义但零引用（死文案）；提交菜单无 Copy Message / Compare；标签无分组无删除/推送；储藏只有 Pop；路径过滤框只做本地过滤且实际未参与过滤（README“已知缺口”）；用户/日期无服务端过滤；无 Merge / Rebase 发起通道，无远端列表通道。

## 决策

后端只加正交新通道、老通道签名不动；前端把死文案接活并补分组与菜单：

- 引擎（`main.js`，全部 `cwd: repo.root`，复用 `refArg` / `isBranchNameSafe` / `isSafePath` / `syncOutcome` + 双流报错）：扩展 `git/log`（author / since / until / search / paths），新增 `git/tags`、`git/remotes`、`git/merge`、`git/rebase`、`git/branch-delete`、`git/branch-rename`、`git/branch-upstream`、`git/tag-delete`、`git/tag-push`、`git/stash-show`、`git/compare`，`git/fetch` 加 `prune` 可选。
- 视图（`src/git-view.js` 主战场，`src/commit-view.js` 分支弹层跟随，文案进 `src/common.js` 中英两份）：Branches 面板加 HEAD 行 + Tags / Remotes / Stashes 组 + 按 `/` 的可折叠文件夹；分支右键补 Merge into Current / Rebase Current onto / Rename / Set Upstream / Unset Upstream / Delete（含未完全合并二次确认）/ Copy Name；提交右键补 Copy Message / Compare with HEAD；工具栏补 User（All / Mine only）/ Date（Any time / 24h / Week / Month）/ 路径服务端过滤（450ms debounce）/ Go to HEAD / Fetch + Pull 快捷按钮；提交视图分支弹层跟随补 Merge / Rebase / Rename / Set Upstream / Delete（二级弹层选分支），储藏项从单一 Pop 升级为 Apply / Pop / Drop 小菜单。

## 验证

- `node --check` 全过；`node tools/harness.mjs` 198/198（新增 34 条行为回归覆盖 merge / rebase / 改名 / 删除 / upstream / tag 删推 / stash show / compare / log 过滤 / prune fetch / 远端分支删除）。
- `node tools/build.mjs && node tools/smoke.mjs` commit/git 双视图 zh-CN/en 渲染无异常；`PluginCheck` 仅剩已知的 `clipboard.write` 误报。
- `runGit` / `cwd:` 计数不变式成立（61-1 = 59+1：新增 `runGit` 全部显式带 `cwd: repo.root`）。

## Alternatives considered

- 只补前端菜单、复用现有通道拼参数：分支改名/删除/upstream、merge/rebase 发起在现有通道里拼不出来，硬拼等于在渲染层复刻 Git 语义，否决。
- 一次做到 IDEA 全量（含交互式变基、Compare 任意两提交多选、远端管理写 URL）：变基编辑器与多选比较需要新交互与大块 UI 状态，风险高，拆到后续迭代。
- 后端每个操作独立顶层函数文件：本仓库引擎是单 `main.js` + 通道表，拆文件无收益且破坏“重定向 `readRepo()` 等于重定向全表”的定位约定。

## 后果

- 收益：分支/提交/标签/储藏/远端常用操作在窗口内闭环，路径/用户/日期过滤真正生效，与截图的差距从“缺操作”收敛到“缺高级操作（交互式变基等）”；此前零引用的三个 i18n key 全部接活。
- 代价：`main.js` 通道表 +11，`git-view.js` 分支渲染多出分组逻辑（约 +500 行），harness 全绿时间变长；误操作面变大——Delete / Rebase / Drop / Reset / Hard 一律走 danger 确认框兜底。
