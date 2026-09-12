# 发布就绪检查（2026-09-12 实测）

结论：`PluginCheck` 能过、`PluginPack` 能打出包，核心 Git 功能在别人机器上能直接跑；
但以当前仓库状态发市场，别人拿到的包是 2.2MB 开发杂物包，且 `local.` ID 发不出去。
下面三条都是凭直觉会走偏的坑。

## 1. PluginPack 把 gitignored 文件也打进包，且不认 `.piplugignore`

- 实测：`PluginPack` 打出 `local.pi-idea-git-0.2.0.piplug`（2.1MB，46 个文件）。
  解包可见 `.smoke/`（约 700KB，`board.html` + 三个渲染快照）、`.memories/`、
  `.agents/notes/`、`tools/`、`src/`（与 `views/*.html` 重复的内容）、
  `AGENTS.local.md`、`.workflow/`、`.gitignore` 全在包里。
- `.smoke/` 明明在 `.gitignore` 里，照样被打进去；随后加了 `.piplugignore`
 （`.smoke/`、`.memories/`、`.agents/`、`tools/` 等）再跑 `PluginCheck`，
  文件数从 46 变成 47（多出来的就是 `.piplugignore` 本身）——**排除规则不生效**。
- 对照：内置插件（`pi.files`、`pi.browser`）只发 `main.js` + `manifest.json` +
  `views/`（`pi.advisor` 外加 `renderer/` + `skills/`）。官方示例包 22～110KB，
  我们 2.2MB 差了一个数量级。
- 后果：**不要直接发布 `dist/` 里打出的包**。发布前要么等上游支持排除规则，
  要么用单独的发布目录/分支只留运行时文件
 （`main.js`、`manifest.json`、`views/`、`renderer/`、`README.md` + 必要的 LICENSE）。
- 验证后已删除实验用的 `.piplugignore` 与 `dist/`，工作区是干净的。

## 2. `local.pi-idea-git` 这个 ID 发不到市场上

- 市场现有 ID 形如 `demo.hello`、`pi.bianqian`、`io.github.xxx.xxx`，
  `local.` 是开发命名空间，发布前必须改名（如 `io.github.<你>.pi-idea-git`），
  `author: "local"` 也要换成真实作者。
- 改名的代价：`prefs.json`（提交信息历史 30 条 + 视图选项）存在
  `pi.plugin.getDataPath()` 下，而该目录是**按插件 ID 隔离**的——改名后
  老用户的历史与选项不会迁移（可接受，但要在 changelog 里说一句）。
- 改名后记得重跑构建与 `PluginCheck`，并用「加载本地插件」重装验证
 （`Reload` 按钮对权限/清单变更会静默丢东西，见本仓第 3 条约定）。

## 3. 市场要的东西仓库里还没有

- 缺 `LICENSE`、`CHANGELOG`/版本 changelog、市场元数据
 （`categories`、`homepage`、`repository`、`safety_notes`）。
- `safety_notes` 必须写清四件事（安装 consent 时用户只看到权限名，看不到这些）：
  1. `agent.complete` 会花用户自己的模型额度（宿主限流 8 次/分）；
  2. 丢弃未跟踪文件走 Node 侧 `fs.rmSync` 直删（视图侧先确认），安装页只写
     “只读工作区”会让人误以为插件不删文件；
  3. `fs.read` 范围是整个工作区（`**`）；
  4. 依赖 `ssh-agent` 的密钥用不了（宿主不传 `SSH_AUTH_SOCK`），HTTPS 零配置。
- `clipboard.write` 的 `permission.unused` 警告是误报：
  调用在 `src/common.js:513` 经面板桥发起（`invoke("clipboard.writeText",…)`），
  `PluginCheck` 只扫 `main.js` 所以看不到。`fs.read` 同理
  （`fs.openDefault`/`fs.reveal` 在 `src/commit-view.js`）。保留声明即可。

## 4. 别人装完即用的四个前提（功能层面实测为真）

- 零 `npm` 依赖：无 `package.json`，`main.js` 只 `require("node:…")`
 （`child_process`/`os`/`path`/`fs`），换机器不用 `npm install`。
- 要机器上有 `git`：`resolveGitBinary()` 查 `PATH` + `/usr/bin`、
  `/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin`、
  `C:\Program Files\Git\cmd` 等，找不到给明确报错而非静默失败。
  隐含要求 `git >= 2.23`（用了 `restore`），`porcelain=v2 -z` 要现代 Git。
- `HOME`/`USERPROFILE` 用 `os.homedir()` 回填（`main.js:184-185`），
  所以 `~/.gitconfig`、凭据助手、`~/.ssh/config` 都能继承；提示类 env
 （`GIT_TERMINAL_PROMPT=0` 等）保证无终端时快速失败而非挂起。
- `engines.piDesktop >= 0.8.0`，实测宿主 0.14.6。AI 生成按钮无模型/无额度时
  走 `NO_MODEL`/`RATE_LIMITED`/`PERMISSION_DENIED` 文案降级，不影响核心提交流程。

## 跟进（2026-09-12）：已落地

- ID 已改为 `io.github.liushunqiu.pi-idea-git`，`author` 为 `liushunqiu`
  （`manifest.json`）；代码与 `src/` 里无其他 `local.` 引用。
- 市场字段已按官方社区插件（`io.github.muzimu217.session-import`，
  取自其 GitHub 上的 `manifest.json`）的形状补齐：`homepage`、`repository`、
  `i18n.en/zh-CN`（名称/描述/`safetyNotes`）、`categories`
 （`developer-tools`、`productivity`）、`changelog`、顶层 `safetyNotes`。
- 新增 `LICENSE`（MIT）、`CHANGELOG.md`（0.2.0）。
- 发布瘦身：新增 `tools/make-publish-dir.mjs`，只把 8 个运行时文件组装到
  `dist-publish/<id>/`（已进 `.gitignore`）；实测该目录 `PluginCheck` 通过、
  `PluginPack` 产出 8 文件 / 926KB（之前根目录直打是 46 文件 / 2.1MB）。
  `clipboard.write` 的 `permission.unused` 警告仍在，系已知误报（见上）。
