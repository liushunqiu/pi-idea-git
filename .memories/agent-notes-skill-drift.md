# Agent Notes：从「影子运行」到接入门禁（`write-notes-like-deepseek`）

## 现状（2026-09-12 已接上）

| 项 | 落点 |
|---|---|
| 门禁 | `node tools/notes.mjs`（两个校验器，**vendored 在 `tools/agent-notes/`**，与上游逐字节一致），已并入 `node tools/harness.mjs` 的 `agent notes` 段 ⇒ 136 条 = 134 条行为回归 + 2 条笔记门禁 |
| 4 篇笔记 | 已合规：`# Agent Note: <标题>` / 空行 / `Status: implemented` / 空行；骨架 `## 问题 → ## 决策 → 自由节 → ## Alternatives considered → ## 后果`。校验器输出 `ok: 4 note(s) verified` |
| 代码反向索引 | 11 处（`main.js` 9 / `src/commit-view.js` 1 / `tools/build.mjs` 1），格式 `// Note: <为什么、放弃了什么> — 见 .agents/notes/…` |
| 流程 | `AGENTS.local.md` 第 14 条 + 全局 `~/.pi/agent/AGENTS.md` 回写门禁行：非平凡改动**动手前先落 `proposed/`**，落地改写 `implemented` 并随代码同一次提交 |
| 装机 | 真身 `~/.agents/skills/write-notes-like-deepseek`（`npx skills add` 的**副本，无 `.git`**）；`~/.pi/agent/skills/`、`~/.claude/skills/` 是**软链** ⇒ 改一处三端生效 |

## 已作废口径（2026-09-12 之前）

- ~~「这个仓库在用这个 skill」~~：**没有**。笔记的确在写，但驱动它的是全局 AGENTS.md 里被抄过去的**路径约定**，运行时（格式规范、校验脚本、门禁）全部丢下 ⇒ skill 本体从不加载，全局日志里它的名字只作为一条**会话标题**出现过。
- 当时的具体账：4 篇 × 6 = **24 条格式错误**；代码反向索引 **0 命中**（笔记只写不读）；只有 `implemented/`，**从无事前留痕**；自带 4 个脚本从未接（无 `package.json`，也确实没接）；最新一篇还是 `??` 未跟踪。

## 防坑（仍然成立）

1. **判断「某 skill 是否真在用」别看产出物长得像**：① 查有没有 Skill 加载记录；② 跑一遍它自带的 verify 脚本；③ 看它规定的门禁（反向索引、同批提交、lifecycle 目录）在不在。
2. **往全局 AGENTS.md 抄 skill 规则时要么整条抄**（含格式与门禁），要么承认只是借了个路径约定 —— 半抄会稳定产出「既像又不像」的中间态，且没人会察觉格式早已跑偏。
3. **校验器报的是整棵树的错**：并行改多篇笔记时，判据是「有没有属于**我这篇**的错误行」（`… | grep "<文件名>"`），不是「进程退出码」。
4. **本机 Node 26 直接执行 `.ts`**（类型剥离默认开）—— `node <skill>/scripts/verify-agent-note-format.ts` 即可，**不需要 tsx、不需要任何 flag**。vendored 副本因此可以零构建接入。
5. **不要改 vendored 副本**：一改就与上游分叉，下次整目录覆盖会把修改静默丢掉。要改就改上游（重同步命令见 `tools/agent-notes/README.md`）。

## 独立复核「改造有没有丢内容」的判据

子代理说「零丢失」不算数，用这两步自己验：

1. **非空行多重集比对**：`git show HEAD:<note>`（未跟踪的用 PI-Desktop 写前快照
   `~/.pi-desktop/review-changes/<sessionId>/<writeId>/before`）对比新版，`comm -23` 期望
   **只少 3 行**（原标题、`## 起因`/`## 目标`、`状态：implemented`）。
2. **段落重排会让整行比对误报**：再用「去掉全部空白后 `grep -qF` 包含性」判据，把
   「换行位置变了」与「真丢事实」分开；最后对关键事实（符号名、参数、数值）逐条 `grep -c`。
