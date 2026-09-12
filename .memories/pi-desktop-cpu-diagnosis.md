# PI-Desktop 渲染进程 CPU 持续高占用的排查方法（2026-09-12）

## 症状

风扇常转、机身发烫。`ps` 头号消费者是 PI-Desktop 自己的一个
`Helper (Renderer)` 进程（实测 pid 16064，`--renderer-client-id=9`）：

| 指标 | 实测值 |
|------|--------|
| 单核占用 | 47 分钟内稳定 ~51%（区间 9%~143%，锯齿状） |
| 累计 CPU | 47 分钟墙钟烧掉 23.8 分钟 CPU 时间 |
| RSS | 854MB ↔ 1.2GB **剧烈振荡**（不是单调泄漏） |
| VM 区域数 | **17,843**（正常渲染进程数百） |
| malloc 堆 | 仅 242KB，`leaks` 报 0 |

同时 `GPU process` ~15-25%、`WindowServer` ~40-50%（累计 2319 分钟）。

## 关键排查手法（可复用）

**排查顺序：先做减法，别先读代码。** 本次走了 5 步，第 3 步就把范围砍到只剩一个进程：

1. **`ps -Ao pid,ppid,pcpu,rss,etime,args` 定位进程**，并用
   `--renderer-client-id=N` 区分是哪个 WebContents。
2. **`sample <pid> 6 -file <scratch>/s.txt`**：本次输出不可靠（Electron 私有
   构建符号全被符号化成无关的 v8 内部函数名），**不要据此下结论**。
3. **⭐ 静默窗口实验（最有价值的一步）**：后台起采样器，每 2 秒记录
   `pcpu` + `rss` + **git 子进程数**，然后自己做 90 秒完全不产生输出的等待。
   实测结果：**git 子进程采样 45×10 次全为 0，而 CPU 均值 62%、峰值 136%**。
   → 一次性排除"定时调 git / 子进程风暴 / 轮询拉取"整类假设。
   这一步的价值在于：把"猜测原因"变成"排除原因"。
4. **`vmmap -summary` + `leaks`**：看 RSS 是**振荡**还是**单调增长**。
   振荡 + VM 区域数上万 = 大量 DOM/布局对象反复分配回收；
   单调增长才是经典 JS 泄漏。本次 `leaks` 报 0 泄漏，说明不是 JS 堆泄漏。
5. **`vpmmap`/`lsof` 区分进程归属**：`lsof +D <Partitions/pi-plugin-*>` 看分区
   谁在持有；`partitions/<name>/GPUCache/*` 的 mtime 可判断哪个插件视图仍活跃。

## 结论与混杂因素（重要）

**已证实的**：该渲染进程的高占用**与 git 子进程无关**（第 3 步）。
插件代码里确实存在能产生这种模式的缺陷（见下）。

**未能干净分离的**：
- 00:38:38 日志出现 `plugin disabled local.pi-idea-git`，此前 47 分钟该进程稳定
  ~51%，此后 8 小时降到 1.44%（降幅 97%）——看似强证据。
- **但同一时刻两个 agent 会话也恰好都转为空闲**（6c738cca 的最后工具调用在
  00:58，此后再无输出）。所以"降幅 97%"无法区分是**停用插件**的功劳，还是
  **会话空闲**的功劳。这是个真实的混杂（confound），别当成因果证据。
- 同理，90 秒静默窗口期间另一个会话（6c738cca）正在高频输出工具结果，
  无法排除"聊天渲染器在烧"这一竞争假设。

**要干净定性，须做对照实验**（本次没做）：
在**没有其它会话活动**的前提下，单独启用/停用插件，对**同一 PID** 测
`ps -o time=` 的增量 ÷ 墙钟。只有 A/B 两段的会话活动都为零，差值才归因于插件。

## 代码里确实存在的缺陷（无论上面归因如何，都值得修）

1. **`src/git-view.js:154-211` `openDiffOverlay` 没有单例守卫**
   —— 每次调用都往 `document.body` 追加一个 `position:absolute; inset:0` 的
   全屏 `.diff-overlay`；只有 Esc/点关闭才 `remove()`。对比 `popup()` 第一行就
   `closePopup()`。叠加 N 层全屏层 = N 份合成成本。
2. **`src/diff.js:257-283` `renderText` 对插入/删除行逐字符建 Text 节点**
   —— `lineRow`（`diff.js:309-310`）对所有非 context 行传入 `fragment`，
   于是 `for (index < text.length)` 每字符一个节点；开 `Show Whitespaces`
   时升级成每字符一个 `<span>`。再配 `render()` 里的 `PIG.clear()` 全量重建，
   单次 diff 可达数十万节点。
3. **`src/commit-view.js:469-470` 同一个 `field` 被 append 两次**
   —— 复制粘贴残留，留下一个空的 `.search-field`；第二次 append 把节点从第一个
   span 移走，不是复制。纯 bug，非 CPU 主因。
4. **`pointermove` 无节流且读写交错**（`src/common.js:782-807` 分发，
   回调里 `commit-view.js:1373-1377` 先 `root.clientWidth` 读、
   再 `style.width` 写；`git-view.js:702-706` 同型）→ 拖分隔条时强制同步布局。
5. **`main.js:1506-1516` 注册的 `pi.events.on` 在 `onUnload`（1542-1554）
   从未解绑** —— 全仓库 `events.off`/`removeListener` 0 命中。本仓库
   `plugin.log` 记录到 **253 次 `development plugin reloaded`**（开发期改文件即
   热重载）。若宿主不随 reload 丢弃旧 handler，每次 reload 累加一个，
   每个 `workspace:changed` 触发 N 次刷新。
6. **`renderer/index.html` 的 `mountBoth` 同时挂载两个视图**
   （`src/git-view.js:811-818`）→ `pig:appearance` 有 3 个监听者、
   `workspace:changed` 有 2 个；而 `src/common.js:891-899` 的 `watchWorkspace`
   回调里直接 `refresh()`，**无 debounce/coalescing**。
7. **`main.js` 的 `runGit` 无并发去重、无缓存**（`main.js:190-298`）——
   每次调用都真 spawn。而 `git/repo`（`main.js:1142-1159`）内部要跑
   `rev-parse` ×2 + `status --porcelain=v2 -z --untracked-files=all` +
   `stash list` + `config user.name` + `--version` ≈ 5-6 个进程；
   两个视图各拉一次 ≈ 12 个进程。

## 反直觉点（下次别再踩）

- **`sample` 的符号不可信**：Electron 发布版的 `sample` 会把栈符号化成
  一串无关的 v8 内部函数（`CompilationDependencies::DependencyOffTheRecord`
  之类），看起来像"V8 编译器在狂跑"，其实是采样符号泄漏。**别据此定位热点。**
- **`leaks` 报 0 ≠ 没问题**：PartitionAlloc 区域 `leaks` 读不到
  （`Can't examine target process's malloc zone PartitionAlloc_*`），
  渲染进程的真实大头在 PartitionAlloc / Blink 堆，不在 malloc 区。
- **RSS 振荡比 RSS 增长更值得注意**：单调增长是泄漏；**锯齿状大幅振荡**
  是"分配→回收"churn，通常源于反复全量重建 DOM。
- **热重载会污染归因**：开发期每次存盘都触发 reload，日志里
  `plugin.load.success` / `reload.success` 会盖过真实线索，
  必须按"每分钟事件数"聚合看**风暴**，而不是只看单条。
- 这个仓库的 `AGENTS.local.md` 被 `~/.config/git/ignore` 忽略，
  `git add -A` 不会带上它（要显式 `git add`）。

## 修复记录（2026-09-12）

已改 5 处（只动 `src/` 与 `main.js`，产物由 `node tools/build.mjs` 重生成）：

| # | 位置 | 改动 |
|---|------|------|
| 1 | `src/git-view.js` | `openDiffOverlay` 加模块级 `activeDiffOverlay` 单例守卫，入口先 dispose 上一个 |
| 2 | `src/diff.js` | `renderText` 热路径改为「前缀文本 / `.fragment` span / 后缀文本」三分支 |
| 3 | `src/commit-view.js` | 删掉重复的 `search-field` append |
| 4 | `src/common.js` | `watchWorkspace` 加 120ms coalesce（上限 1000ms 防饿死） |
| 5 | `main.js` | `bindWorkspaceListener()` / `detachWorkspaceListener()`，`onUnload` 解绑、`onLoad` 幂等 |

### 验证（可复跑）

- `rendertext-equiv.mjs`：**132/132** 等价（可见文本 + 高亮区段逐一比对）；
  **热路径节点数降 84.6%**（1165 → 179），whitespace 路径 0 变化（本就必需逐字符）。
- `overlay-singleton.mjs`：**9/9**，连开 4 个只留 1 层，keydown 监听器净数恒为 1。
- `lifecycle-v2.mjs`：**10/10**，覆盖宿主「返回 / 不返回」unsubscribe 句柄两种形态；
  10 次重载后存活监听器 = 0。
- `fragment-bounds.mjs`：`fragmentRange` 在 **93,274** 个真实区间上
  **0 个非整数 / 0 个越界 / 0 个空区间** ⇒ 新代码的夹取分支实际不可达。
- 引擎回归：`git/repo|status|log|branches|stashes|console|prefs` 全 `ok=true`。
- 构建幂等；三个产物仅 `title` + `surface` 两行不同（设计如此）。

### 顺带挖出的旧代码隐藏缺陷（重要）

`renderText` 的旧逐字符循环在 `fragment = {start:0, end:0}` 时**死循环**：
`index === fragment.start` 成立 → `index = end - 1 = -1` → 循环末尾 `+1` 又回到 0，
永久原地打转，每轮还 append 一个空 span ⇒ **节点无限增长直到 OOM**。
实测用 5000 节点预算就能触发。另有：`fragment.end = NaN` 时旧代码会把整行文本
**截断**成 `"a"`（数据丢失）。新实现两个都修好了（夹取 + `Number.isFinite`）。
真实数据不会走到（`fragmentRange` 保证合法），但这是实打实的潜在炸弹。

### 归因提醒（未做）

修复后仍**没有**做那个干净的 A/B 对照实验（无其它会话活动时单独启停插件，
对同一 PID 测 `ps -o time=` 增量）。所以「插件是 CPU 元凶」依然只是**高度可疑**，
不是已证事实。上面 5 处是确凿的缺陷，但修复效果需要用那个实验来度量。
