# Agent Note: 生成提交信息改按勾选（已暂存）范围

Status: implemented

## 问题

“生成提交信息”没有按已勾选的文件生成：用户勾选了 `bushing-data/BushingDataListView.vue`（勾选=暂存），底部显示“将提交 24 / 151 个文件 · 将用同一提交信息提交 2 个仓库”，生成的却是 `chore: 同步 .ai/works 子模块指针`——描述的是父仓暂存区里的一行 gitlink，而不是要提交的内容。

根因两层：

1. 视图 `draftTarget()` 让“选中（高亮、驱动 diff 面板的那一行）”优先于“已暂存”，而刷新会自动选中第一个文件，所以“全部已暂存”分支几乎不可达——生成描述单个文件，提交却提交全部。
2. 即使走到已暂存分支，引擎 `buildCommitContext` 也只读当前选中仓的 `git diff --cached`。聚合提交（`stagedTargets()`：子模块先、父仓后，同一信息提交 N 个仓）下，子模块内部的已暂存内容对生成不可见；父仓暂存区经常只剩 gitlink 指针变化，模型就只能写出“同步子模块指针”。

## 决策

- 视图（`src/commit-view.js`）：`draftTarget()` 改为“有暂存（即有勾选）就描述全部暂存（`stagedTargets()`，与 Commit 将要提交的集合完全一致），无暂存才回退到选中文件”。`generate()` 据此组包：单仓复用老契约（当前仓空包、子模块带 `repoRoot`，风格从被描述的仓取）；多仓发送 `stagedRoots`；toast 在多仓时追加 `commitMultipleRepos` 计数。
- 引擎（`main.js`）：`buildCommitContext` 新增 `stagedRoots` 分支——校验每个 root 在工作区内且是仓库根后，逐仓取 `git diff --cached`，以 `=== <rel> ===` 分节拼成一个 prompt（截断仍按总 `MAX_PROMPT_PATCH_CHARS`），`scope={kind:"staged",repos:N}`，`files` 按 `rel/path` 聚合；多仓时用户消息加一句“多仓共享同一信息、分节描述、归属单仓的部分点名”。风格仍取当前仓历史（同一信息提交 N 个仓时风格必然折中，取所见仓）。
- 文案（`src/common.js` 中英）：`generateScope` 从“未选中文件时使用全部已暂存内容”改为“基于已勾选/已暂存内容”；`draftedStaged` 改为“已勾选/已暂存内容”，与复选框语义对齐。
- 产物（`views/commit.html`、`views/git.html`、`renderer/index.html`）由 `node tools/build.mjs` 重生成，不手改。

## 验证

- `node --check`（main/src 全过）；`node tools/harness.mjs` 208/208。
- `tools/drive.mjs` 实测（fake model）：父仓+子仓各一个已暂存改动时 `stagedRoots:[parent,sub]` 返回 `scope.repos=2`、`files=[a.txt,sub/b.txt]`，prompt 同时包含两段 diff 且带 `=== sub ===` 分节与多仓说明头；单仓空包仍只含本仓 diff（`files=[a.txt]`）；单文件 `repoRoot` 回退正常；全空返回 `EMPTY_DIFF`（视图映射为 `nothingToDescribe` toast）。
- `node tools/build.mjs` 重生成三产物。

## Alternatives considered

- 保留“选中优先”，只在 tooltip 里说明：用户心智是“勾选=本次提交”，Commit 按钮也按勾选提交；保留现状等于生成与提交范围永远可能不一致，否决。
- 多仓时逐仓调一次模型再拼接：N 次计费与 N 次等待（宿主限流 8 次/分），且合并多条草稿需要第二轮模型调用；单 prompt 聚合一次调用即与提交语义一致，否决多调用。
- 多仓风格逐仓取、逐仓生成：与“同一信息提交 N 个仓”的提交行为矛盾——用户点一次生成、点一次提交得到 N 个仓的同一文本，不可能同时满足 N 种风格；取所见仓并明示，否决逐仓生成。
- 父仓 gitlink diff 过滤掉、只留子模块内部 diff：指针变化在“只提交父仓指针”的场景下是唯一信号，过滤会制造空 prompt；保留并靠分节标注让模型自行权衡。

## 后果

- 收益：生成范围与提交范围一致——有勾选描述勾选（含跨仓聚合），无勾选才描述选中文件；截图中的“勾选 A、描述 B”不再出现；多仓 toast 点名仓数，所见即所得。
- 代价：多仓 prompt 变长（截断上限不变，超长时仍只描述可见部分）；多仓共用同一风格（所见仓历史），子模块自身的 conventional 前缀习惯可能被父仓风格覆盖——这是“同一信息提交 N 仓”固有的折中，已在 prompt 头部明示；`main.js` 增加逐仓 `diff+name-only` 调用（仅多仓生成时）。
