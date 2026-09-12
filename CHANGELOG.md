# Changelog

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
