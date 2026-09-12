# Agent Note: 多仓库统一推送（Push 对话框 + Commit and Push 全推 + 平级仓库）

Status: implemented

日期：2026-09-12
范围：`main.js`（`readRepo` 平级回退 / `discoverRepositories` / `readSubmoduleStatuses` / `readRepoFor` / `git/push` 的 `repoRoot` / 新增 `git/push-statuses` / `git/repo` 的 `siblingMode`）、`src/common.js`（Push 对话框 `openPushDialog` + `pushRepos`、i18n、仓库徽标 `sibling`）、`src/commit-view.js`（工具栏 Push 分流、`commit(withPush)` 逐仓推送、平级聚合、`allRepos`）、`src/git-view.js`（工具栏 Push）、`tools/harness.mjs`（第 15–16 节）、`README.md`（多仓库一节）

## 问题

聚合提交已经能一次提交 N 个仓库（同信息逐仓提交，子模块先、父仓后），但推送仍是一次只推当前仓：`commit(withPush)` 只调一次 `git/push`（当前选中仓），工具栏 Push 也只推当前仓。用户在父仓 + 子模块（以及平级多个独立仓库）下提交了好几个仓库后，必须逐个切换仓库再 Push。

引擎侧另有两个缺口：`git/push` 只走 `withRepo`（不支持 `repoRoot`，不切换就推不了子模块）；`git/submodule-statuses` 只返回脏子模块（干净但 ahead 的仓不出现，Push 对话框无数据来源）。平级布局（工作区本身不是仓库，内有 repoA/repoB）下 `readRepo` 直接 `NO_REPOSITORY`，连仓库列表都出不来。

## 决策

IDEA 式“看到每仓去向、逐仓推送、单仓失败不挡其他仓”，分引擎与视图两层落地，选择器与聚合分组复用现有形态。

### 1. 引擎：`readRepo` 平级回退（`siblingMode`）

`rev-parse --show-toplevel` 失败时不直接 `NO_REPOSITORY`，而用 `scanNestedRepositories(cachedWorkspace)` 找平级仓：有则以仍有效的 `selectedRoot` 或首个仓库为当前仓，返回 `siblingMode: true`（`workspaceRoot` 为工作区文件夹本身）；无命中仍返回 `NO_REPOSITORY`。单仓库与父仓路径零变化。

macOS 路径坑就地修掉：Git 给 `/private/var/…` 而宿主给 `/var/…`，直接 `path.relative` 会算出 `../../../../..`。平级分支的 `rel` 统一走 `workspaceRelativeRoot`（内部已 `realpath`），`readRepoFor` 与 `push-statuses` 复用 discover 给出的 `rel` 而不再重算。

### 2. 引擎：发现与聚合感知平级

- `discoverRepositories` 先判 `workspaceRoot` 是否仓库：是则首项为 root（如前），否则只返回平级仓（无 root 项），`kind` 记 `"sibling"`（父仓模式仍由持有者 index 的 `160000` 判定）。
- `readSubmoduleStatuses` 在 `siblingMode` 下返回除当前仓外所有脏平级仓（`kind: "sibling"`），视图复用同一分组渲染；父仓模式逻辑不变。
- `git/repo` 透出 `siblingMode`，Commit 视图据此在平级模式下必取聚合状态（平级仓的改动从不在当前仓的 status 里出现，不能复用 `hasSubmodule` 判据）。
- `readRepoFor` 透传 `siblingMode`，`rel` 同样走 `realpath` 安全口径。

### 3. 引擎：`git/push` 接受 `repoRoot`，新增 `git/push-statuses`

`git/push` 从 `withRepo` 改走 `withRepoAt`：带 `repoRoot` 即推指定仓（越界拒绝保持），不带时行为与原来一致。新调用一律用 `repoRoot`（旧 `root` 兼容字段保留，但与 `apply-patch` 来源 `root` 同名异义，注释已标明）。

新增 `git/push-statuses`：对相关仓库（父仓模式为 discover 全量、含干净仓；平级模式为全部平级仓）逐个 `readStatus` + `resolvePushTarget`，返回每仓 `{ rel, root, name, kind, active, branch, pushTarget | pushError }`。只在打开 Push 对话框时调用一次，不进每次刷新路径（O(N) 进程数可接受）。

### 4. 视图：共用 Push 对话框 + `Commit and Push` 全推

逻辑放 `src/common.js`（两视图共用）：`openPushDialog` 按仓列出分支去向（`main → origin/main`）、`↑/↓`、勾选框与行内结果；`Push All` 逐仓调 `git/push`（带 `repoRoot`，`setUpstream` 按该仓 upstream 缺失与否），单仓失败不挡后续，行内显示成功/拒因（复用 `remedyText`），关闭后视图统一 `refresh()`。`pushRepos(targets)` 是同一逐仓推送的无 UI 版，供 `Commit and Push` 复用。

- Commit 工具栏 Push：多仓（`allRepos.length > 1` 或有聚合子模块）时开对话框，单仓保持直推 + toast（单仓外观零变化）。
- `commit(withPush)`：提交成功后把刚才提交的那 N 个仓逐个推出去（子模块先、父仓后，与提交顺序一致），逐仓播报（全成则 `已推送 N 个仓库`，部分失败则逐仓点名 + `已推送 ok/total`）。
- Git 工具栏新增 Push 按钮，同样走对话框（单仓时对话框内只有一行）。
- i18n（en/zh-CN）：对话框标题/副标题、`Push All`、推送中/已推送、计数、无上游/无远端/已是最新、空态与提示、`sibling repository / 平级仓库` 徽标与 hint。

## Alternatives considered

1. **工具栏 Push 保持直推，加“推送全部”菜单项而不做对话框**。否决：用户要的是 IDEA 式“看到每仓去向与结果”，无对话框则 ahead/无 upstream/被拒的仓不可见，失败时仍需逐个排查。
2. **提交时自动把子模块指针暂存进父仓并一次提交/推送**。否决：沿用聚合笔记的结论——gitlink 暂存有语义（决定父仓跟进到哪），自动暂存等于替用户做发布决定；推送更甚（自动发布子模块）。
3. **给 40+ 通道逐个加 `repoRoot` 参数**。否决：沿用嵌套仓库笔记的审计结论——默认当前仓覆盖老调用，只需 `withRepoAt` 的通道支持显式覆盖；Log/分支/储藏仍走选择器。
4. **平级仓库另起“工作区模式”重写选择器与聚合**。否决：复用现有 `selectedRoot` 会话级语义与聚合分组（`kind: "sibling"` 只是新分组），改动面收敛到引擎回退 + 一个新状态通道，比双套 UI 更小。

## 后果

- **收益**：聚合提交后不再“一仓一切一推”——`Commit and Push` 把 N 个仓逐个推出去，工具栏 Push 对话框一次看清每仓去向与结果，单仓失败不挡其他仓；平级文件夹（本身非仓库）也能列仓、聚合、一次推完。
- **收益**：单仓库项目零变化（无对话框、无额外调用，选择器仍隐藏）；老调用不传 `repoRoot` 即原行为。
- **代价**：`git/push-statuses` 打开对话框时 O(N) 进程数（每仓 status + push 目标解析），N 大时打开变慢；缓解是只在打开时调用一次，不进刷新。
- **代价**：`readRepo` 回退改变“非仓库工作区”语义（原来一致 `NO_REPOSITORY`，现部分可用）；若扫描误命中 vendored 仓会把“不是项目”变成“是项目”——缓解是复用现有扫描边界与跳过清单，无命中仍 `NO_REPOSITORY`。
- **代价**：`withRepoAt` 的 `root` 兼容字段与 `apply-patch` 来源 `root` 同名异义仍在，新调用一律用 `repoRoot`，harness 覆盖越界与 `../`。
- **风险**：平级聚合每刷新一次扫描 + 逐脏仓 status；平级仓数通常 < 10，可接受，仓数极多时刷新变慢（与对话框同理，未做分页）。
