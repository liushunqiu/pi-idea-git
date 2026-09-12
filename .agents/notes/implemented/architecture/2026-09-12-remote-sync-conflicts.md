# 远端冲突：把"被拒的推送"当成正常路径

日期：2026-09-12
状态：implemented
范围：`local.pi-idea-git` 的 `main.js`（`gitError` / `pushHint` / `pullHint` /
`pullStrategy` / `resolvePushTarget` / `readOperation` / `git/sequencer` /
`git/{fetch,push,pull}`）与 `src/common.js`、`src/commit-view.js`、`src/git-view.js`

## 起因

用户提问："推送时跟远端冲突了怎么处理？" 实测（`tools/drive.mjs` 对临时仓库）：

1. push 被拒 → 只显示 Git 的三行输出，而 `gitError()` **丢掉所有 `hint:` 行**
   —— 被丢掉的那句正是 "use 'git pull' before pushing again"；
2. `ahead/behind` 取自本地 remote-tracking ref，插件从不同步 fetch，
   所以芯片显示的 `↑1 ↓0` 不预告这次必然被拒；
3. `git pull` **不带任何 reconcile 参数**，现代 Git 对分叉分支直接
   `fatal: Need to specify how to reconcile divergent branches` —— 推送失败后
   唯一被推荐的命令根本跑不起来；
4. 真出现 merge 冲突时（用户自己在 gitconfig 里设了 `pull.rebase`），
   `git merge` 把 `CONFLICT...` 打到 **stdout**，而 `message` 只取 stderr
   ⇒ toast 是一段看起来像成功的 fetch 日志。

结论：不是"冲突处理得不好"，是**没有冲突处理**，而且退路（pull）是断的。

## 决策

### 1. `gitError` 同时读两个流

字段名撒手不管："哪个流更像错误流"是错的判据，**"失败时哪一行能指出下一步"
才是**。现在 stderr 优先、stdout 补后，去重、截 6 行；`hint:` 仍然从短消息里
剔除（换成插件按代码分类、按界面语言措辞的补救说明），但完整输出进 `detail`。

### 2. 完整输出进对话框，不进 toast

340px、12 秒的 toast 装不下 Git 的六行输出加五行 hint，所以
`reportSync()` 在失败时给 toast 加一个"详情"链接，点开是
`detail`（stderr+stdout 全文，含 hint）。**信息不丢，只是分层。**

### 3. 分类，而不是转述

`pushHint(stdout, stderr)` → `remote-ahead`（`fetch first` / `non-fast-forward` /
`stale info`）或 `remote-rejected`（受保护分支、钩子拒绝）；`pullHint` →
`diverged` 或 `conflicts`。引擎只返回稳定代码，文案在 `src/common.js` 的
i18n 表里（en / zh-CN 各一份），因为只有视图知道界面语言 —— 这条沿用
`authHint` 已有的做法。

### 4. `git pull` 原样跑，只在 Git 因"没策略"拒绝时重试一次

第一版实现是自己读 `pull.rebase`/`pull.ff` 再拼参数。**审查推翻了它**：
`branch.<name>.rebase` 在 Git 里的优先级高于 `pull.rebase`，合法取值还有
`merges`/`interactive`，于是那份真值表会静默覆盖用户自己的配置（实测：
只设 `branch.main.rebase=true` 时裸 `git pull` 变基，而插件生成了 merge commit）。

现在：**先原样执行 `git pull`**；只有失败信息命中
`Need to specify how to reconcile divergent branches` 时，才重试一次
`git pull --no-rebase`。判据是"把 Git 自己的优先级规则当成唯一真源"——
用户配置、`pull.ff=only`、`merges`、`interactive` 全都由第一次尝试生效；
插件只回答 Git 拒绝回答的那一个问题。代价只在确实分叉时多一次往返。

选 merge 作为那个答案的理由仍是"哪种结果可恢复"：merge 停下来时冲突落在
变更列表里，插件能收尾或中止；`fatal` 则是一条死路。

### 5. 推送目标是分支的 upstream，不是硬编码的 origin

引擎新增 `resolvePushTarget()`：`@{upstream}` 能解出就用它。解不出时分三种情况，
每一种都拒绝替用户猜：跟踪的是**本地**分支（无斜杠）→ 报错说没有远端可推；
unborn 分支 → 报错说还没有提交可推；否则取 `origin`，只有一个远端时取那一个，
**多个远端则报错并列出名字**（`git remote` 是按字典序输出的，"第一个"当年会把
分支发布到字母最靠前的那个远端并顺手绑定 tracking）。`--set-upstream` 仍由视图
按 `!branch.upstream` 发送。

### 6. 强制推送只能是 lease

`payload.forceWithLease` → `--force-with-lease`，**没有裸 `--force` 的入口**。
菜单项只在分支有 upstream 时可用（lease 需要基线），并带一个危险样式的确认框。
实测：同事在窗口没看的时候推了一版 → lease 过期 → 拒绝，远端那个提交没被抹掉。

### 7. 位置参数不能来自调用方的原样拼接

`refArg()` 拒掉 `-` 开头与含空白的 remote/branch。审查证明了这条必要性：
`{remote:"origin", branch:"--force"}` 实际执行的是 `git push origin --force`，
而面板桥会把任何通道转发给 `onPanelInvoke`——边界上"信任入参"等于没有边界。
同级 handler（`git/create-branch`、`git/tag`）本来就有 `startsWith("-")` 的先例。

### 8. 冲突态必须有出口，且出口不能在最需要时消失

第一版用 `conflicted.length > 0` 当探测门槛。**审查推翻了它（blocker）**：
冲突被 `git add` 解决后 porcelain 就不再报 `u` 行，门槛随即失效——而"全部暂存完"
正是 `--continue` 开始能成功的那一刻。实测（rebase 冲突中暂存）：
`REBASE_HEAD` 仍在、`--continue` 能成功，插件却把横幅和按钮一起隐藏了，
等于把仓库留在没有出口的状态。

现在 `readOperation()` 在"有冲突 **或** 上一次探测到操作仍在进行"时才问，
探测到 null 才停；这同时把常态刷新的开销保持为零。

出口本身：`git/sequencer` 只接受那四个名字与 `abort`/`continue` 两个动作（白名单），
`continue` 走 `-c core.editor=true`（没有终端可以编辑提交信息，否则 Git 只会失败），
merge 的 `continue` 直接拒绝——merge 是靠提交收尾的。这条是**被 4 逼出来的**：
让 pull 能跑，就让"插件自己制造一个冲突中的 merge"从不可能变成可能，那就必须
同时提供出口。

## Alternatives considered

- **只把 hint 行留在短消息里**（最小改动）。放弃：Git 的 hint 是英文且冗长，
  六行封顶后仍会盖掉关键行；而分类后的补救说明能本地化、能只留一句。
  折中方案（短消息不带 hint、全文进 `detail`）同时满足了"能读"和"不丢"。
- **toast 里不显示 hint、也不做详情对话框**。放弃：那样被丢掉的信息就真的没了，
  未分类的失败（钩子脚本自己的输出等）将无法自证。
- **push 前自动 fetch**。放弃：把一次用户操作变成两次网络往返，慢网络下有撞上
  宿主 30s 面板超时的风险；改为"被拒后再 fetch"（`refreshTrackingRefs`），
  代价只发生在确实需要它的那条路径上。
- **`pull` 读不到配置时报错让用户去设 `pull.rebase`**。放弃：把一个 Git 版本
  带来的配置负担转嫁给用户，而 merge 是 2.27 之前 `git pull` 自己的行为。
- **自己读 `pull.rebase`/`pull.ff` 再拼参数**（第一版实现）。放弃：那是 Git 优先级
  规则的第二个、更差的副本，会静默覆盖 `branch.<name>.rebase` 与
  `merges`/`interactive`；改为"先原样跑，只在 Git 拒绝回答时补一次 `--no-rebase`"。
- **无 upstream 时按 `git remote` 的第一个（= 字典序第一个）远端推**。放弃：等于让
  字母序决定分支发布到哪里，多远端仓库里这是错的；改为 origin / 唯一远端 / 否则报错。
  - **顺带**：审查提出的 `refArg()` 与"operation 探测不以 `conflicted` 为门槛"都不是
  另立方案，而是把上述决策补成它们声称的样子（"永不裸 force"、"提供出口"）。
- **给 merge 也做 `--continue`**。放弃：`git merge --continue` 语义就是提交，
  而提交按钮已经在了；两个入口做同一件事会让人以为它们不同。
- **继续只给 rebase/cherry-pick 做，abort 都不做**。放弃：会留下"插件能进、
  出不来"的状态。
- **强制推送用裸 `--force`**。放弃：会静默抹掉同事的提交；lease 的失效场景
  （远端已变）恰好正是需要拦住的那个场景。
- **`git/branches` 里带上 remotes 列表供视图自己拼推送目标**。放弃：多一次
  子进程、多一份可能过期的状态，且视图不该知道 Git 的 ref 语法。

## 已知近似

- `pushHint`/`pullHint` 用正则匹配 Git 的输出，Git 改措辞就会漏判。漏判的后果是
  "退回改之前的行为"（显示原文、不发补救说明），不是错误提示。
- `readOperation` 的探测只在"有冲突"或"上次探测到操作仍在进行"时运行，因此
  **插件进程重启后**（热重载、重新打开窗口）一个"冲突已全部解决但操作未结束"的
  rebase 不会被认出来。插件自己没有能停在无冲突状态的命令（交互式 `edit`/`break`
  只能来自终端），所以这条是从终端进来的状态；此时终端也在手边。
- `continue` 用 `core.editor=true` 接受操作已记录的提交信息。想做别的
  （改信息、跳过）仍需终端。
- lease 的基线是本地 remote-tracking ref，因此"没 fetch 就强制推送"会被拒
  ——这是安全侧的错误。
- 无 upstream 且只有一个远端时会直接推上去（`origin` 优先，否则取那唯一一个），
  这是"不猜"的下限而不是用户的选择；有多个远端时插件不替用户挑。

## 验证

- `tools/harness.mjs`：**75 条断言**，全部针对真实仓库（裸远端 + 两个 clone + 真分叉），
  覆盖拒绝分类、消息/详情、芯片从陈旧到刷新、冲突 merge 与中止、**暂存后横幅仍在**、
  用户 `branch.<name>.rebase` 被尊重、推送目标（含多元远端/unborn/本地 upstream 的拒绝）、
  **把 `--force` 塞进位置参数被拒**、lease 不覆盖同事提交、无 merge 时的中止、
  cherry-pick 冲突后 continue。
- 视图走 `tools/smoke.mjs`（桩 bridge）在浏览器里实测：冲突横幅 + 中止按钮、
  被拒 toast 的换行与"详情"链接、详情对话框（含 hint）、强制推送确认框的文案，
  以及 `remedyText` 五个代码在 en / zh-CN 下都有措辞、两表键数相等（178/178）。
- 对抗式代码审查（独立 subagent，只读）一轮，结论 concerns：1 blocker + 3 major
  全部已修（见上），其余 minor/nit 的处理：文案改为不指定收尾动作、
  对话框 detail 改为独立的 `.dialog-detail`（等宽 + `max-height: 45vh` 可滚动）、
  `refreshTrackingRefs` 去掉不可达的 catch 并把"失败即保持陈旧"写成明确取舍、
  harness 从会话 scratch 收进 `tools/`。
