# Agent Note: 远端操作的忙碌反馈（工具栏转圈 + 进度小药丸 + Push 逐行进度）

Status: implemented

日期：2026-09-12
范围：`src/theme.css`（spinner / task-pill / push 进度样式）、`src/common.js`（`spinner` / `setButtonBusy` / `withBusy` / `taskPill` / `runWithPill` + Push 对话框逐行进度 + 新增 i18n 第一轮 `committing` / `fetching` / `pulling` / `checkingOut` / `pushingRepo`、第二轮 `stashing` / `unstashing`）、`src/commit-view.js`（工具栏 syncing 含 refresh、提交按钮阶段文案、分支/仓库菜单药丸、sequencer 按钮自转、刷新微暗）、`src/git-view.js`（工具栏 syncing 含 refresh、Log 右键菜单拣选/还原/重置药丸、Log 刷新微暗）、`views/*` + `renderer/index.html`（构建产物）

## 问题

点工具栏 Push / Fetch、分支菜单 Pull / Push、Commit and Push 之后，界面没有任何变化，直到几秒后 toast 出现。用户会以为点击没生效而重复点击（重复 spawn git 进程），push 这种长动作尤其如此：旧的 Push 对话框只在开始时把按钮文字换成"推送中…"，多仓时不知道推到第几个、当前行没有状态。

## 决策

两层反馈，共用一套形态（`src/common.js`，两视图不能对"忙碌"各说各话）：

1. **有按钮可转的，转按钮**：工具栏 refresh / fetch / push 用 `state.syncing`（commit 视图另加 `state.busy` 互斥）记录正在等什么，`paintToolbar` 每次重绘都据此渲染——进行中的按钮加 `.busy` + spinner（CSS 把原图标隐藏，尺寸不变，工具栏不跳），其余同步按钮 disabled 防重复点击。提交按钮按 `busyKind` 显示"提交中…" / "提交并推送中…" + spinner，push 阶段才切文案（`commit-push` 在进 `withPush` 块时设置，而不是提交一开始，避免提交阶段文案超前）。生成按钮忙时把 sparkles 换成 spinner。
2. **没按钮可转的（分支/提交菜单里的 checkout / fetch / pull / push），弹顶部小药丸**：`taskPill(label)` 显示 spinner + 文案，`runWithPill(label, task)` 包住调用，成功闪一下消失、失败多留 2.4s。药丸层 `z-index: 70`（popup 之上、modal 对话框之下），`pointer-events: none` 不挡点击。
3. **Push 对话框逐仓进度**：单仓保持"推送中…"（行内 spinner 已说明是哪个仓，1 个仓的 0%-of-1 进度条是噪音）；多仓时按钮文案为"正在推送 1 / 2…"并随进度更新，副标题下 3px 进度条按仓填充，当前行高亮 + 行内 spinner + "推送中…"，完成的行显示 ✓已推送 / 错误原文。`setButtonBusy` 恢复按钮原始子节点（WeakMap 存原件，不是按字符串重建），关闭按钮在推送中 disabled（原先只有 backdrop/Escape 守卫）。

刷新本身（`refresh()`）加列表微暗（`.is-refreshing`，重叠刷新共用计数器，避免闪烁），慢 reload 读作加载中而不是卡死；Git 视图的 Log 刷新同样包 `refreshInner`（它的 `.commits-pane` 复用同一选择器）。

4. **第二轮：剩下的改工作区动作与刷新按钮**：刷新按钮之前是唯一没转的同步按钮——现在用户点的刷新同样进 `syncing: "refresh"`（只包按钮 handler，不包 `refresh()` 本体，避免每次内部 reload 都闪按钮；键盘 ⌘R 走微暗不转按钮）。分支菜单的新建分支、仓库菜单的储藏/恢复储藏（新增 `stashing` / `unstashing` 文案）、Log 右键菜单的拣选/还原/重置（`--hard` 可重写工作树，必须有等待归属）全部 `runWithPill`；sequencer 的继续/中止有真实按钮，用 `withBusy(button, label)` 让按钮自己转（文案保留防抖动；按钮可能被随后的 `refresh()` 重建，对 detached 节点恢复是无害 no-op）。刻意没包的：tag / amend-message / 单文件 stage / console 刷新——本地瞬时操作，药丸 1.2s 反而是噪音，微暗已覆盖。
## 验证

- `node tools/harness.mjs`：159/159 通过（引擎未动，预期如此）。
- 真实渲染（headless Chrome + CDP + stub bridge，脚本在 `$PI_SCRATCH_DIR/push-ux-check.mjs`）：commit / git 两视图均过——药丸显示/更新/自动消失、图标按钮转圈后图标还原、Push 对话框 2 行打开、推送中 1 行高亮转圈且按钮文案为"正在推送 1 / 2…"、结束后 2 行 ✓已推送、按钮恢复"全部推送"、进度条隐藏且 fill=100%。

## Alternatives considered

- **全局状态栏 / IDEA 式后台任务条**：需要常驻 UI 位置，两个工具窗口都要留槽，且当前耗时操作都是模态等待（push 对话框本就 blocking），任务条的排队/取消能力用不上。先做触发点反馈，任务条以后有真后台任务（如自动 fetch）再加。
- **菜单项内直接转圈**：popup 菜单在 `onSelect` 第一件事就是 `closePopup()`，圈没地方画；药丸是菜单场景唯一放得下反馈的位置。
- **push 用 `withBusy` 包按钮**：对话框按钮文案需要在 1/2 → 2/2 间更新，`withBusy` 是一次性文案，改用 `setButtonBusy` 手动开关 + `paintProgress` 更新文案/进度条。`withBusy` 保留为公共 API 备用。
- **乐观更新 ↑/↓ chip**：push 成功后 chip 本就靠 `refresh()` 重算；`refreshTrackingRefs` 的拒绝后 fetch 逻辑不动，不碰。

## 后果

- 代价：`paintToolbar` 在同步操作期间会被调用 2–3 次（开始/结束各一次，`refresh()` 内再来一次），每次全量重建工具栏 DOM；工具栏节点少，可接受。`refresh()` 包了一层 `refreshInner`（dim 计数器需要 try/finally），多一层调用。
- 收益：所有远端操作都有 1 帧内的视觉确认；重复点击被守卫挡掉，不再 spawn 重复 git 进程；多仓 push 看得到进度，单仓 push 保持安静。
- 约束：新增按钮/菜单若调远端或改工作区，必须三选一——能转按钮用 `syncing` + spinner（含刷新按钮；只包用户点击的 handler，不包 `refresh()` 本体），长在菜单里用 `runWithPill`，行内小按钮用 `withBusy(button, label)`；直接裸调 `invoke` 会回到"点了没反应"。新增 i18n 文案需中英成对（另加 `stashing` / `unstashing`）。有真实按钮但会被随后 `refresh()` 重建时（如 sequencer 行内按钮），`withBusy` 的恢复是无害 no-op，可直接用。
