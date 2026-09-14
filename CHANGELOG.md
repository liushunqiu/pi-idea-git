 # Changelog

 ## Unreleased

 - Git 操作补齐（对标 IDEA 日志／分支面板，见
   `.agents/notes/implemented/feature/2026-09-14-git-operations-parity.md`）：
   Branches 面板加 HEAD 行、Tags／Remotes／Stashes 组与 `/` 文件夹折叠；
   分支右键补合并／变基／改名／upstream／删除；提交右键补复制提交信息／与
   HEAD 比较；工具栏补用户／日期／路径服务端过滤、Go to HEAD 与 Fetch＋Pull
   快捷按钮；提交视图分支弹层跟随。`git/log` 支持 author／since／until／
   search／paths；新增 `git/tags`、`git/remotes`、`git/merge`、`git/rebase`、
   `git/branch-delete`、`git/branch-rename`、`git/branch-upstream`、
   `git/tag-delete`、`git/tag-push`、`git/stash-show`、`git/compare`，
   `git/fetch` 支持 `prune`。harness 198 条全绿（新增 34 条行为回归）。
- 远端分支检出改为 IDEA 行为：`git/checkout` 加 `track` 意图位，建本地跟踪分支
  并附着 HEAD（已存在则落到本地同名分支；裸 revision 仍 detach）。harness 206 条全绿。
 

## 0.2.0 — 2026-09-12

首个对外发布版本。发布 ID 为 `io.github.liushunqiu.pi-idea-git`
（开发期曾用 `local.pi-idea-git`；插件数据目录按 ID 隔离，
改名后提交信息历史与视图选项从空开始）。

- 提交 / Git 双工具窗口：Staged / Unstaged / Unversioned Files /
  Merge Conflicts 分组目录树，hunk 级暂存、取消暂存与丢弃，
  图形化 Log、分支面板、储藏与 Console。
- 多仓库聚合：子模块与嵌套仓库统一显示、逐仓提交；
  Push 对话框逐仓显示去向并支持 Push All。
- 远端同步：推送被拒 / 分叉 / 冲突的分类补救说明；
  force push 只允许 `--force-with-lease`。
- 宿主模型生成提交信息：语言菜单（跟随仓库历史 / 简体中文 / English），
  回复落框前强制整形（空行、行宽、项目符号）。
- 在 PI-Desktop 0.14.6 上验证；`engines` 声明 `>= 0.8.0`。

First public release under `io.github.liushunqiu.pi-idea-git`
(renamed from the dev id `local.pi-idea-git`; per-plugin prefs start fresh).
Commit/Git tool windows, multi-repo aggregation, classified push/pull
remedies with lease-only force push, and host-model commit-message drafting.
Verified on PI-Desktop 0.14.6.
