# 推送/拉取遇到远端冲突时的实际行为（2026-09-12，`tools/drive.mjs` 对临时仓库实测）

问题起点：「插件在 push 时跟远端冲突了会怎么处理？」

**结论（修复前）：没有任何冲突处理。** 它把 `git push` 的失败原样截断后抛给 toast，
且截断规则恰好吃掉了 Git 自己给的解法；更糟的是 pull 这条退路在分叉状态下直接不可用。

> **2026-09-12 已修复**，本文保留为"当时是什么样"的证据。改动与取舍见
> `.agents/notes/implemented/architecture/2026-09-12-remote-sync-conflicts.md`；
> 回归验证在 `$PI_SCRATCH_DIR/harness.js`（53 条断言，全绿）。

## 1. push 失败时报什么：Git 的解法被 `hint:` 过滤掉了

`main.js:314-321` 的 `gitError()`：只读 **stderr**、**丢掉所有以 `hint:` 开头的行**、
取前 6 行；`main.js:250` 是唯一的调用点（`message = gitError(stderr, code)`）。
`main.js:337-349` 的 `authHint()` 只识别 `ssh` / `credentials` 两类，
non-fast-forward 返回 `null` ⇒ 视图侧 `errorText()`（`src/common.js:760`）无附加建议。

实测两次，分别对应"没 fetch 就推"和"fetch 后推"：

```
推送: To ../origin.git
      ! [rejected]        main -> main (fetch first)
      error: failed to push some refs to '../origin.git'

推送: To ../origin.git
      ! [rejected]        main -> main (non-fast-forward)
      error: failed to push some refs to '../origin.git'
```

被丢掉的那几行正是答案：
`hint: use 'git pull' before pushing again` / `hint: See the 'Note about fast-forwards'`。
错误 toast 7 秒后自动消失（`src/common.js:594`）。
全仓库搜不到 `--force` / `--force-with-lease` / `--ff-only` / `rebase` 的调用
（`rebaseOnto`、`inProgress` 两条文案只存在于 `src/common.js` 的 i18n 表，无任何引用＝死字符串）。

## 2. 更隐蔽的一条：界面在 push 前撒谎

`branch.ahead/behind` 来自 `git status --porcelain=v2` 的 `branch.ab`
（`main.js:1098`），即**本地 remote-tracking ref**。插件**从不同步 fetch**
（搜不到 `setInterval`，`git/fetch` 只有两处手动入口），所以：

```
# work 已经本地领先 1 个、真实远端也领先 1 个（未 fetch）
git/repo → branch: { ahead: 1, behind: 0 }     # UI 芯片显示 ↑1，看起来可以直接推
git ls-remote origin main → 7cdfac3（本地 origin/main 仍是 811fb4f）
```

⇒ 芯片上的 ↑1 不预告这次必然被拒。

## 3. pull 不能作为退路：分叉时直接 fatal

`main.js:1660-1687` 里 fetch/push/pull 共用一个分支，`pull` **不带任何
reconcile 参数**。现代 Git（`pull.rebase` 未设置）对分叉分支直接拒绝：

```
From ../origin
 * branch            main       -> FETCH_HEAD
   811fb4f..7cdfac3  main       -> origin/main
fatal: Need to specify how to reconcile divergent branches.
```

而 `git config pull.rebase false  # merge` 那几行建议是 `hint:` ⇒ 同样被过滤。
用户能看到的只有"分叉了 + fatal"，没有任何可执行的下一步，只能去终端。

## 4. 最误导的一条：真出现 merge 冲突时，报错降级成「看起来像成功的 fetch 日志」

如果用户自己在 `~/.gitconfig` 里设了 `pull.rebase`，pull 能跑；一旦真的冲突：

```
stdout: "Auto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\n
         Automatic merge failed; fix conflicts and then commit the result.\n"
stderr: "From ../origin\n * branch            main       -> FETCH_HEAD\n"
message: "From ../origin\n * branch            main       -> FETCH_HEAD"   ← 用户看到的
```

**`git merge`（pull 的第二段）把冲突说明打到 stdout，只有 fetch 阶段打 stderr，
而 `message` 只取 stderr。** 于是 toast 是一段不带任何错误前缀的 fetch 日志，
仓库却已经处于 merge 冲突中。症状与原因完全脱钩——凭直觉排查会先去怀疑视图层或 toast。

对照 `git cherry-pick <hash>` 冲突：`error: could not apply <hash>` 在 stderr 里，
所以能显示出来 ⇒ 说明这不是"冲突都不显示"，而是"取决于 Git 把哪段打到哪个流"。
凡是 merge 家族（pull / merge / rebase / revert 的部分路径）都踩这个形状。

## 5. 冲突态本身：能救，但没有 UI

`git/repo` 会把冲突文件正确列进 `conflicted`（`status: "UU"`, `label: "Both modified"`），
且实测这条恢复链路是通的：**外部编辑器改文件 → 插件 stage → 插件 commit → push 成功**。
但没有 abort / skip / 选边（ours/theirs）/ continue 任何入口，也没有"冲突进行中"的状态条。

## 6. 顺带两个与"冲突"无关但同一处的缺陷

- **push 成功没有成功反馈**（Commit 视图路径）：`report()`（`src/commit-view.js:331`）
  仅在 `result.stdout` 非空时 toast，而成功的 push 把摘要打 **stderr**
  （`Everything up-to-date` / `7cdfac3..1899122  main -> main`）⇒ stdout 为空 ⇒ 静默。
  Git 工具窗口那条路径写的是 `toast(result.ok ? t("push") : …)`（`src/git-view.js:469`）没这问题。
- **push 目标是硬编码**：三处调用都传 `remote: "origin"` + `branch: head`
  （`src/commit-view.js:271/431/1256`、`src/git-view.js:462`），不从 `branch.upstream`
  反推。若 upstream 是 `upstream/main` 或名字不同的远端分支，会往 `origin <本地名>` 推，
  而 ↑↓ 仍按 upstream 统计——两者说的不是同一件事。

## 修复（2026-09-12 已实施）

1. `gitError()` 改为同时读 stdout+stderr（`git push` 的拒绝在 stderr，`git merge`
   的 `CONFLICT` 在 stdout，只读一个流必漏），短消息里仍剔除 `hint:`，但全文进新字段
   `detail`，由 toast 的「详情」链接打开对话框 —— 信息分层而不是丢弃。
2. 新增 `pushHint()` → `remote-ahead` / `remote-rejected`，`pullHint()` →
   `diverged` / `conflicts`；文案按界面语言由 `PIG.remedyText()` 追加到错误消息后面。
3. `pull` 现在**先原样执行**，只在失败信息命中 `Need to specify how to reconcile
   divergent branches` 时重试一次 `--no-rebase`（第一版自己读配置拼参数，被审查
   推翻：会覆盖 `branch.<name>.rebase` 与 `merges`/`interactive`）。
4. 被拒后视图自动 fetch（`PIG.refreshTrackingRefs`），芯片不再撒谎。
5. push 成功也 toast（此前 `report()` 只在 stdout 非空时 toast，而成功的 push 把
   摘要打 stderr ⇒ 静默）；push 目标改为由引擎从 `@{upstream}` 解析。
6. 附带修掉第 6 节的两个缺陷，并新增 `git/sequencer`（abort/continue，白名单）
   让冲突中的 merge/rebase/cherry-pick 在视图内可退出。

7. 推送目标不再猜：无 upstream 时取 `origin` / 唯一远端，多元远端或跟踪本地分支
   或 unborn 分支都直接报错；`remote`/`branch` 入参过 `refArg()` 白名单（否则
   `branch: "--force"` 会真的执行 `git push origin --force`）。
8. 冲突横幅的探测门槛改为"有冲突**或**上次探测到操作仍在进行"——暂存完冲突后
   porcelain 不再报 `u` 行，用 `conflicted.length` 当门槛会让出口在最需要的
   时刻消失（审查发现的 blocker）。

## 教训

**「错误信息为空/看起来正常」和「操作失败」是两个独立故障，报错管线必须同时看
stdout 和 stderr。**
`gitError(stderr)` 这种"只取一个流"的写法在 push 上恰好能工作（push 把拒绝写 stderr），
所以就通过了验证；直到 merge 家族命令在同一个入口上暴露出来。
偏要写"取一个流"时，判据应该是"失败时哪一行能指出下一步"，而不是"哪个流名更像错误流"。
