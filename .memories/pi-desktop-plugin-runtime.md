# PI-Desktop 插件运行时：踩过的坑

来源：2026-09-11 在 `local.pi-idea-git` 上从零实现一个 Git 工具窗口时实测。
每条都是"症状有迷惑性 / 凭直觉会走偏 / 返工成本高"的类型。

## 1. 视图页面用 `file://` 加载，ES module 会被拦

**症状**：多文件拆分的面板打开后白屏，控制台只有一条 CORS/opaque origin 的
模块加载错误；`import` 全部不执行。

**根因**：宿主用 `loadURL(pathToFileURL(entry))` 打开视图，即 `file://`。
Chromium 拒绝从 `file://` 加载 ES module（opaque origin）。
证据：`out/main/index.js` 中 `PluginViewHost.createView` /
`pluginWindow` 的 `loadURL(pathToFileURL(request.htmlPath))`。

**结论**：视图页面必须是自包含的单文件 HTML。官方 `pi.files/views/tree.html`
就是 47KB 全内联，正是这个原因。本项目用 `tools/build.mjs` 从 `src/*` 生成
`views/*.html`，改源码后必须重新构建。

## 2. 面板的未知通道会转发给 `onPanelInvoke`（这是自定义 RPC 的正门）

**症状**：插件想给面板加自定义 API，文档说"没有通用自定义面板 RPC"，看起来
只能使用固定通道。

**实情**：`invokePanelBridge`（`out/main/index.js`）的 `switch` 结尾是
`default: return this.sendToChild(loaded, {t:"call", method:"panel.invoke", payload:{channel}})`
——**任何未在 switch 中列出的通道都会转到插件主进程导出的 `onPanelInvoke(channel, payload)`**，
且不经过权限门禁（跑的是插件自己的代码）。
所以 `pluginBridge.invoke("git/status")` 这种通道名完全可用。

**限制**：宿主对面板调用有 30s 超时（`PLUGIN_PANEL_TIMEOUT_MS = 3e4`），
插件内部要留更小的超时才能返回有用报错。

## 3. 插件主进程是完整 Node 进程，但拿不到 HOME

**实情**：`main.js` 跑在 Electron `utilityProcess` 里，`spawn`/`child_process`
可用，**没有 OS 级沙箱**（官方文档也承认："the separate Node plugin process is
not yet an operating-system capability sandbox"）。
但 `pluginProcessEnv()` 只透传 `PATH / SystemRoot / windir / TEMP / TMP / TMPDIR / LANG`，
**没有 `HOME`**。

**后果**：直接 `execFile("git", ...)` 时 Git 读不到 `~/.gitconfig`（用户身份、
credential helper、别名）。必须自己补 `env.HOME = os.homedir()`。
另外 `GIT_TERMINAL_PROMPT=0` 必须设，否则 push/pull 会挂死在没有终端的地方。

## 3b. 插件进程也拿不到 SSH_AUTH_SOCK——认证必须靠「继承用户环境」

`pluginProcessEnv()` 只透传 `PATH / SystemRoot / windir / TEMP / TMP / TMPDIR / LANG`，
**`SSH_AUTH_SOCK` 不在其中**。而 `gitEnv()` 只是 `{...process.env}`，所以它也无从恢复。

**后果**（实测）：

| 认证方式 | 插件里能否工作 | 原因 |
|---|---|---|
| HTTPS + 凭据助手（osxkeychain / gh / libsecret / manager） | ✅ | 助手是**可执行程序**，git 通过 PATH 调起，读的是钥匙串而非环境变量 |
| SSH + **无口令**密钥 | ✅ | ssh 直接读 `~/.ssh/id_*`（HOME 已补） |
| SSH + macOS 钥匙串口令（`UseKeychain yes`） | ✅ | 口令从钥匙串取，不经 agent |
| SSH + **依赖 ssh-agent** 的密钥 | ❌ | 没有 `SSH_AUTH_SOCK`，ssh 找不到 agent |

**推论**：插件**不需要也不应该**自己持有凭据。正确架构是「跑用户自己的 git、
带上用户的 HOME」，于是**自建 GitLab、Gerrit、内部 Gitea 全都零配置可用**——
因为它们和用户终端用的是同一套凭据存储。

**另一个必须做的配套**：插件没有终端，所以要显式禁掉交互提示
（`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`）让它**快速失败而不是挂死**。
但这会把"没配凭据"变成一句看不懂的报错，因此要**把失败分类并给出补救说明**
（本项目 `authHint()` 返回机器码，视图负责本地化文案）。

## 4. `git apply` 与前缀：补丁被拒的迷惑性报错

**症状**：`git apply --cached` 报
`error: git diff header lacks filename information when removing 1 leading pathname component`。

**根因**：为了显示好看用了 `git diff --no-prefix`，产出 `--- file` / `+++ file`；
而 `git apply` 默认 `-p1` 要剥掉一层前缀，没得可剥就报上面这句。

**结论**：保留 Git 默认的 `a/` `b/` 前缀，`git apply` 显式写 `-p1`；
显示时再在渲染层剥前缀。hunk 级暂存要带 `--recount`，否则只选部分 hunk 时
行数对不上。

## 5. 权限变大后：热重载会失败，"重新加载"按钮也不够

这是本插件踩得最久的一个坑，有三层，逐层都不显然。

**第一层：热重载必然失败。** `reloadDevPlugin` 会比对已批准权限，manifest 新增
权限时直接抛
`PERMISSION_DENIED: manifest now requests …; load the plugin again to review`。
旧实例继续运行，新功能不出现。保存文件即触发，所以日志里会反复刷这条。

**第二层：Plugins 页的「重新加载 / Reload」按钮也会用旧权限。**
`pluginReload` 的实现是：

```js
const listed = await host.call("plugins.list");
const plugin = listed.plugins.find((c) => c?.id === id);
await plugins.loadFromPath(plugin.path, plugin.permissions ?? [], { development: true });
```

而 `loadFromPath` 的授权逻辑是 **"传入权限 ∩ 磁盘声明权限"**：

```js
const declared = new Set(resolveFsAccess(manifest).permissions);  // 磁盘上的新 manifest
const granted = grantedPermissions === void 0 ? declared : new Set(
  resolveFsAccess({ permissions: grantedPermissions }).permissions.filter((p) => declared.has(p))
);
```

`plugin.permissions` 来自宿主核心的 `plugins.list`，也就是
`~/.pi-desktop/plugins/registry.json` 里那条**陈旧记录**（只有首次加载时的
权限）。交集的结果就是新权限被静默丢掉：**`plugin.load.success` 照样打印成功，
但 `ui.view` 没被授予，贡献的视图一个都不出现**——没有任何报错，最容易误判成
"加载好了但视图有 bug"。

**第三层：注册表不会自己刷新。** 实测 registry.json 里该插件仍是首次加载时的
`name` / `version` / `permissions`（如 `["ui.panel"]`、`capabilities` 无
`views`），即使用户后来加载过新版 manifest、且 `plugin.load.success` 已出现。
所以 **registry.json 不能当作"当前生效状态"的判据**。

**结论**：widening `permissions` 之后，必须走**「扩展」页右上角 `···` 菜单 →

「加载本地插件」→ 重新选中插件目录**——只有这条路径（`pluginLoadDev` IPC）会让
宿主核心重读 manifest 并走权限复核；卡片上的 `Reload` 按钮和保存触发的热重载都不够。

**按钮在哪儿容易找不到**（实测踩过）：`plugins.loadDev` 的**中文文案是
「加载本地插件」**（不是"加载开发插件"——那个是 onboarding 清单里的 `loadPlugin`，
点了只跳转到扩展页，不触发加载）。而且它在**两个地方**：
① 页面右上角 `···` 菜单（`plugins.moreActions` → `Ns` 列表，键名 `loadDev`），
这一项**始终存在**；
② 已安装列表的**空状态**里（仅当 `o.length === 0`，即一个插件都没装时才渲染）。
装了任意插件后，空状态消失，**只剩 `···` 菜单这一条路**——卡片上是没有的。
成功后的 toast 文案是「本地插件已加载」（`plugins.loadDevDone`）。

**如何判断到底生效了没**（不靠猜）：

1. 插件日志里出现 `plugin.load.success` **不能**作为依据（见第二层）。
2. 看 `~/.pi-desktop/plugins/registry.json` 里该插件的 `permissions` ——
   若仍是旧的那份，说明 `Reload` 路径生效，视图不会出现。
3. 最直接：视图挂载时会调用被审计的宿主 API（本插件调 `plugin.getDataPath`），
   在 `~/.pi-desktop/logs/app/plugin.log` 里按 pluginId 过滤即可看到；且
   `~/.pi-desktop/plugins/data/<pluginId>/` 会被创建。**没有任何记录 = 视图从未运行。**

## 5b. 应用级快捷键在插件视图获得焦点时全部失效

**症状**：用户在插件视图（docked view）里按 `⌘⇧P`（命令面板）或 `⌘K`（搜索），
**毫无反应**；点一下别处再按就正常。看起来像快捷键坏了或键位设错。

**根因**：宿主把应用自己的快捷键实现为**主窗口渲染层的
`window.addEventListener("keydown", …)`**（`out/renderer/assets/*.js`，几十处）。
而插件的 docked view 是独立的 `WebContentsView`，有自己的 webContents。
**键盘事件只进焦点所在的那个 webContents**，所以焦点在插件视图里时，宿主的
keydown 处理器根本收不到按键。

主进程的 `before-input-event`（`out/main/index.js:54656`）只处理两件事：
Windows 的 `Alt+Space` 启动器 chord 和 F12/Ctrl+Shift+I 开发者工具，
**不转发按键**，所以也指望不上。

**实测到的宿主键位**（`out/renderer/assets/index-DY2OpvIW.js` 的 `KEYBOARD_SHORTCUTS`）：
`openSearch = Mod+K`（**会话搜索**，不是命令面板！）、`openCommandPalette = Mod+Shift+P`、
`openPluginLauncher = Alt+Space`（唯一走 `globalShortcut` 的）、`openSettings = Mod+Comma`、
`toggleSidebar = Mod+B`。

**注意 `Mod+K` 的语义冲突**：宿主拿它当"搜索会话"，而 IDEA 习惯里 `Mod+K` 是提交。
插件视图里绑定 `Mod+K` 会**遮蔽**宿主的搜索（因为宿主的处理器根本收不到事件），
两者靠焦点区分。绑定前先想清楚这一点。

**插件启动器能列到什么**：`pluginLauncher` 的文案是"打开插件 / 输入插件名称、
拼音或拼音首字母"，空状态是"暂无可直接打开面板的插件"——即它只列**声明了
`ui.panel` 的插件**，回车打开的是**独立面板窗口**（不是 docked view）。

**推论**：
- 任何"应用级"快捷键（命令面板 `⌘⇧P`、搜索 `⌘K`、设置 `⌘,`…）在插件视图有焦点时
  都不可用。要触发它们，用户得先点回宿主界面。
- **例外**：`openPluginLauncher`（默认 `Alt+Space`）是用 Electron
  `globalShortcut.register` 注册的（`applyPluginLauncherShortcut`），所以它是真全局，
  插件视图有焦点时也能唤起插件启动器。这是插件视图内唯一可用的"逃生通道"。
- **插件要自己实现它广告的每一个快捷键**。不要把工具提示里的键位当成"宿主会处理"。
  更稳的做法是**提示文案从绑定本身生成**（本项目用 `PIG.formatShortcut(spec)`），
  这样两者不可能对不上。

**顺带一个测试坑**：`keydown` 事件派发到 `window` 时**不会**经过 `document`
（window 是祖先不是后代）。用合成事件测 `document.addEventListener("keydown", …)`
类的处理器（比如模态框的 Esc）会得到假阴性；应当派发到
`document.activeElement ?? document.body` 让它正常冒泡。

## 5c. 工作区路径绝不能长期缓存（本插件实测踩到的真 bug）

**症状**：用户从项目 A 切到项目 B 后，插件的工具窗口仍显示**项目 A** 的仓库，
甚至报"不是 Git 仓库：<项目 A 的路径>"。而宿主侧边栏明明高亮着项目 B。

**根因**：插件主进程里写了 `if (!cachedWorkspace) await refreshWorkspace();`
——**一旦写入就永不刷新**。插件进程的生命周期跨项目切换（docked view 常驻），
于是它被永久钉在"第一次读到的工作区"上。这个 bug 特别隐蔽：单项目使用永远正常。

**正确做法**：每次需要仓库时都重新问一次 `pi.workspace.get()`。一次宿主调用
相对一次 `git` spawn 便宜到可以忽略，没有理由猜。同时接住宿主的通知：

- **视图/面板侧**：`pluginBridge.on("workspace:changed", handler)`
- **插件主进程侧**：`pi.events.on("workspace:changed", handler)`

宿主切工作区时**两条都发**（`setCurrentWorkspacePath`，
`out/main/index.js:53394-53401`）：

```js
broadcastPluginPanelEvent("workspace:changed", payload);   // → pluginBridge.on
plugins.broadcastEvent("workspace:changed", [payload]);    // → pi.events.on（插件进程）
```

`broadcastEvent` 的实现是给每个已加载插件的子进程 `postMessage({t:"event", event, args})`
（`index.js:24939`），插件进程侧由 `handleHostEvent` 分发给 `pi.events.on` 的监听器。

**教训**：任何"宿主状态"都当成可能变化的值；插件进程比它服务的项目活得久。

## 5d. 界面传了、引擎却不接的参数（一类静默失效）

**实例**：四个视图调用点都传 `setUpstream: !branch?.upstream`，但引擎的
`git/push` 分支**只取 `remote` 和 `branch`，把 `setUpstream` 丢掉了**。
后果：新分支首次推送不会建立跟踪，ahead/behind（`↑2 ↓1` 那个芯片）**永远不会出现**，
而且没有任何报错——参数合法、命令成功、只是少了个 `--set-upstream`。

**为什么难发现**：`git push origin main` 在无 upstream 时**也返回成功**，
所以日志里只有成功。只有回头看"为什么 ↑↓ 一直是空的"才会起疑。

**教训**：视图与引擎之间是**无类型校验的 JSON 通道**（`pluginBridge.invoke`
→ `onPanelInvoke`），拼错的键、忘接的键都不会报错。凡是视图传了新参数，
必须同时在引擎的 `switch` 里落地；更好的做法是把通道**契约写在一处**
（本项目 `tools/drive.mjs` 可以直接按通道调用，是验证契约的最短路径）。

## 5e. 报错只取第一行会丢关键信息

**实例**：`git add` 被忽略文件挡住时，stderr 是

```
The following paths are ignored by one of your .gitignore files:
AGENTS.local.md
hint: Use -f if you really want to add them.
```

原来用 `firstLine(stderr)` 当错误信息，于是界面上只显示第一行
——**"以下路径被忽略："然后就没有然后了**，用户根本不知道是哪个文件。
已改为 `gitError()`：丢掉 `hint:` 噪音行，保留前 6 行。

**教训**：不是所有 git 报错都是"一行一个意思"。取错误信息要么取全文，
要么按命令定制，别默认只取首行。

## 5f. DOM 事件里的 `event.currentTarget` 在 `await` 之后是 null

**症状**：每次点击某个按钮都会在页面里**多留一个弹层**（DOM 里堆叠，视觉上只看到
最上面那个，所以完全不像 bug）。点三次就有三个。

**根因**：把 `event` 传进一个 `async` 函数、在 `await` 之后才读
`event.currentTarget` —— **该属性只在事件派发的同步阶段有效，之后是 `null`**。
于是弹出层已经被 `append` 进 DOM，但紧接着用 null 锚点算位置时抛异常，
**登记弹层的赋值语句永远没执行到**，于是它既不在管理列表里、也永远不会被关闭。

**为什么难查**：异常被 `onclick` 里的 `.catch(() => {})` 吞掉，控制台干净；
`window.addEventListener("error")` 也收不到（是 Promise 拒绝，不是错误事件）。

**两条教训**：
1. 调用方：**在 `await` 之前把元素取出来**（`onclick: (e) => fn(e.currentTarget)`），
   不要把 `event` 带进异步函数。
2. 被调用方：**先登记、再做可能抛异常的事**；并在入口校验锚点，坏锚点就明确报错，
   而不是留下一个永远关不掉的孤儿节点。改了 `popup()` 的顺序后这类泄漏就不可能再发生。

## 5g. 用宿主模型生成文本：`agent.complete`

插件**不需要也不该持有 API key**。要生成文本时用宿主的模型：

```js
const models = await pi.models.list();          // 需要 models.list 权限
// [{ key: "providerId/modelId", label, providerName, ... }]
const { text, modelKey, usage } = await pi.agent.complete({
  modelKey,                                     // 必填，必须含 "/"
  system: "...",                                // 可选，≤32 KiB
  messages: [{ role: "user", content: "..." }], // 合计 ≤200k 字符
  // thinkingLevel, includeSessionContext（后者还需 session.read 且在工具执行中）
});
```

要点：`agent.complete` 是**高风险权限**；宿主限流 **8 次 / 60 秒**
（`MAX_COMPLETES_PER_WINDOW`），超时 90 秒；`includeSessionContext` 只有
"正在执行工具"时可用，面板里拿不到会话上下文。官方 `pi.advisor` 插件是现成范例。

## 5h. 别把不同的失败合并成同一句用户提示

**实例**：生成提交信息时提示「没有可用模型。请先在设置里添加服务」，但用户明明配了
很多模型。真因是**权限从未授上**——日志里写得明明白白：

```
{"pluginId":"local.pi-idea-git","api":"models.list","ok":false,"errorCode":"PERMISSION_DENIED"}
```

而我的代码是：

```js
try { models = await pi.models.list(); }
catch (error) { return { ok: false, code: "NO_MODEL", message: ... }; }   // ← 吞掉了 code
if (!models.length) return { ok: false, code: "NO_MODEL", message: "No model..." };
```

**两种完全不同的故障被压成同一个 `NO_MODEL`**，视图再把它渲染成"去添加服务"。
用户于是被指去修一个根本没坏的东西——**比不报错更糟**。

**正确做法**：
1. **保留宿主给的错误码**（`error.code`，插件进程侧由 `settle()` 从
   `message.error.code` 灌入），不要统一成自己的码。
2. 引擎返回结构化的码/字段，**视图负责措辞**——不同码给不同出路。
3. 兜底时也要把**原始报错**留在可达的地方（本项目放在菜单项 tooltip），
   便于事后定位。

**推论（通用）**：任何 `catch` 都要问一句"这里是不是把 A 故障说成了 B 故障"。
把"权限不足""没配置""远端不可达"合并成一句笼统提示，就是在制造误导。

## 5i. 子模块：勾选后"自动取消勾选"（我的 UI 设计缺陷）

**症状**：未暂存分组里勾选子模块（如 `frontend`），过一会儿**自己变回未勾选**。

**复现与真因**（实测两种情形）：

| 子模块状态 | 暂存前 status | `git add` 后 | 界面 |
|---|---|---|---|
| 只有新提交、内部干净 | `.M SC..` | `M. S...` | 行**移到**已暂存 ✅ |
| **内部有未提交改动** | `.M SCM.` | **`MM S.M.`** | 行**同时留在两处**，未暂存那行被重建为未勾选 ❌ |

**根因**：`git add` 在父仓库**只能记录子模块指向哪个提交**，动不了子模块内部。
于是工作区那一列（Y）的 `M` 永远消不掉 ⇒ 该行每次都重新出现在未暂存分组、
且因 `group === "staged"` 为假而**渲染成未勾选**。用户看到的就是"自动取消"。

**关键**：`git status --porcelain=v2` 的 `1`/`2` 记录里有个 `<sub>` 字段
（4 字符，`S<c><m><u>`）：
- `S` = 是子模块（非子模块是 `N...`）
- `c` = `C` 表示子模块有**新提交**（HEAD 与父仓库记录不一致）
- `m` = `M` 表示子模块有**已跟踪内容的改动**
- `u` = `U` 表示子模块有**未跟踪内容**

`m` 或 `u` 为真时，改动落在子模块**内部**，父仓库永远无法从这里清掉它。

**修法（两条一起）**：
1. 引擎解析 `<sub>`，给条目加 `submodule` / `sub{commits,modified,untracked}` /
   未暂存侧的 `insideSubmodule`。
2. UI：子模块行加**可见徽标**（含解释性 tooltip）；勾选后**根据实际结果**解释——
   若 gitlink 暂存上了就说明"内部改动仍留在子模块里"，若连 gitlink 都没动就报错并
   让用户去子模块内提交。

**通用教训**：**别提供注定失败的控件却不解释**。一个"点了会自己弹回去"的复选框，
比一个禁用状态加一句原因要糟得多——用户会以为程序坏了。

## 6. `.git/` 在凭据拒绝清单里

宿主 fs 通道的硬拒绝列表包含 `.git/`、`.env*`、`.ssh/`、`.aws/`、`*.pem`。
所以**不要走 fs 通道读仓库**，一切经由 `git` CLI（也顺带拿到了标准的
porcelain 契约）。

## 7. `git status --porcelain=v2 -z` 的解析要点

- `-z` 下**每一段（含 `# branch.*` 头）都以 NUL 结尾**，不是 LF。
- `-z` 会关闭 C 风格路径转义，空格与中文路径原样返回——这是唯一安全的形式。
- `2`（rename/copy）记录：`score` 在 **parts[8]**，路径在 **parts[9] 起**，
  **原路径是下一个 NUL 段**，不是同一段里的 tab 分隔（无 `-z` 时才是 tab）。
- `1` 记录路径从 parts[8] 起，`u` 从 parts[10] 起。

## 8. 排查插件是否加载成功，看日志

`~/.pi-desktop/logs/app/plugin.log` 里有
`{"pluginId":"…","api":"plugin.load.success"}` / `plugin.reload.error` / `plugin.unload`。
用户插件目录是 `~/.pi-desktop/plugins/`（`registry.json` / `installed/` /
`disabled/` / `market/catalog.json`）。

## 9. 视图能收到的事件只有三个

`appearance:changed`、`workspace:changed`、`browser:state`。没有动态改标题、
徽标或自我激活自己视图的通道——view 的标题只来自 manifest。
`contributes.views[].icon` 必须在白名单里，否则渲染成字母占位（25 个 token，
含 `branch` / `list-checks` / `diff` / `pull-request`）。
`contributes.commands[].title` **只接受纯字符串**（不能给本地化对象），
而 `contributes.views[].title` 和 `ui.title` 接受本地化对象。

## 本机 gitignore 会影响所有仓库（提交前必看）

`~/.config/git/ignore` 里有：

```
**/.claude/settings.local.json
AGENTS.local.md
*.local.md
```

**注意 `AGENTS.local.md` 是被单独列出的，所以它在本机任何仓库里都不会被提交**，
`git add -A` 会静默跳过它（只有显式 `git add AGENTS.local.md` 才报错）。
在别的机器上（没有这条全局规则）它反而会进仓库——**同名文件的行为因机器而异**。
如果希望它随仓库走，需要在仓库自己的 `.gitignore` 里用 `!AGENTS.local.md` 反选。

## 本项目已发布到 GitHub

仓库：<https://github.com/liushunqiu/pi-idea-git>（**public**，2026-09-11 建立并公开）。
默认分支 `main`。若需改回私有：
`gh repo edit liushunqiu/pi-idea-git --visibility private --accept-visibility-change-consequences`。

`.gitattributes` 把 `views/*.html` 与 `renderer/*.html` 标成
`linguist-generated` + `linguist-detectable=false`：它们是 `tools/build.mjs` 的产物，
字节数比全部源码加起来还大，不标的话 GitHub 会把仓库语言误判成 HTML。
