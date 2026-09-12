# 嵌套仓库 / 子模块：一个项目里多个仓库怎么支持（2026-09-12）

用户原话："当前这个插件无法识别在一个仓库下面的子模块仓库。"
当场拍板的口径（**不要再改**）：

1. 形态 = **IDEA 的 Root 下拉**：两个工具窗口顶部一个仓库选择器，
   选中后整个窗口（改动 / 日志 / 分支 / stash / 提交）切到那个仓库。
   明确否决了"只在改动列表里分组显示、不允许切换"和"每个仓库一个视图"。
2. 识别范围 = **`.gitmodules` 声明的子模块 + 任意未被声明的嵌套仓库（目录里有 `.git`）**，
   两者都要。

## 1. 引擎侧的关键事实：只有 `readRepo()` 用默认 cwd

改之前审计过 `main.js` 全部 41 处 `runGit(...)`：**只有 `readRepo()` 里的
`rev-parse --show-toplevel` 依赖默认 cwd（= 工作区路径），其余 40 处全部显式
`{ cwd: repo.root }`**。所以让 `readRepo()` 返回"被选中的仓库"就等于重定向整张
命令表（status/diff/log/stash/commit/apply --cached），不需要给 41 个通道加参数。

**下次再动类似功能，先跑这个审计**：
```bash
grep -c "runGit(" main.js   # 44 次调用 + 1 行定义 = 45
grep -c "cwd:" main.js      # 43：除 readRepo 的探测外全部显式
```
即：调用数 − 1（定义）− 1（故意的默认 cwd）= 显式 cwd 数。

## 2. macOS：路径必须按 `realpath` 比较，字符串前缀比较会静默判错


- `git rev-parse --show-toplevel` 返回**真实路径**：`/private/var/folders/...`；
- 宿主 `pi.workspace.get()` 给的是**用户打开时的路径**：`/var/folders/...`
  （`os.tmpdir()` 也是后者）。

二者指向同一目录，但 `a.startsWith(b + "/")` 判 false。后果不是报错，而是**静默降级**。
最典型的一处是 `src/commit-view.js` 的 `workspaceRelative()`："打开文件 / 在访达中显示"
两项被静默禁用，看起来像功能没做，其实是被路径比较判成"文件在工作区之外"。

所以：
- 引擎侧所有路径比较走 `realPath()` / `samePath()` / `isInside()`（`main.js` 里已就位）；
- 视图**不要自己拼绝对路径**——引擎直接给 `workspacePrefix`（工作区相对前缀，
  按真实路径算好），视图只管拼 `prefix + "/" + filePath`；
- 这条不只影响子模块：任何**符号链接**形式打开的工作区（macOS 上 `/tmp`、`/var`、
  外接盘、`~/Documents` 的 iCloud 链接）在单仓库情况下就会踩到。

## 3. `readDiff` 的"未跟踪文件"兜底会误判干净文件（已修）

旧判据是「`git diff` 输出为空 + 文件存在 ⇒ 用 `--no-index /dev/null <file>`
渲染成整文件新增」。**干净且已跟踪的文件同样满足这两条**，于是选中它会把整个文件
画成新增。切仓库让"陈旧选择"可达（选择记在视图里，路径在两个仓库里都叫 `a.txt`），
从而暴露了它——但它在单仓库下本来就是错的。

现在先跑 `git ls-files --error-unmatch -- <path>` 确认"未跟踪"这个前提，
和 `git/discard` 的判据一致。**教训：兜底分支的前提要问，不要靠"输出为空"推断。**

## 4. 发现规则（写死在代码里，别凭感觉改）

| 项 | 值 | 位置 |
|---|---|---|
| 深度 | `REPO_SCAN_DEPTH = 4`（仓库路径最多 4 段） | `main.js` |
| 目录预算 | `REPO_SCAN_BUDGET = 5000` | 同上 |
| 跳过树 | `.git` / `node_modules` / `vendor` / `Pods` / `.venv` 等依赖·构建·缓存树 | `REPO_SCAN_SKIP` |
| 声明优先 | `.gitmodules` 里的路径**不受上面三条限制**；未 checkout 的不列 | `discoverRepositories` |
| kind 判据 | **持有它的那个仓库的 index** 里是否有 `160000` gitlink（不是 `.gitmodules`） | `submodulePaths` |
| 下钻 | 找到仓库后**继续下钻**（否则"子模块的子模块"永远列不出来） | `scanNestedRepositories` |

## 5. 视图侧与切仓库的硬约定

1. **切仓库必须清掉仓库相对状态**：文件选择、改动过滤词、已渲染 diff、
   changed-files 列表、分支/路径过滤、打开的 commit diff 浮层。两个视图都用
   `loadedRepo`（上次加载的仓库根，`undefined` = 还没加载过）对比来实现，
   **并且在 `onSwitch` 里先清再 reload**（不能只靠刷新后的对比：那期间的按钮还活着）。
   **提交信息框故意不清**——那是用户敲过的字。
2. 仓库芯片在**只有 1 个仓库时隐藏**（`display: none`），单仓库项目的外观
   和改动前完全一致。
3. **`workspacePrefix` 里 `null` 有语义，不能折成 `"."`**：仓库在工作区**之上**
   （工作区是仓库的子目录）时无前缀可用，折成 `"."` 会让"打开文件"去要
   `app/app/f.txt`，或指向工作区里同名的另一个文件。null 必须原样传到视图，
   由视图的回退分支处理。（harness 第 13 节固化）
4. **切仓库的竞态**：`git/select-repo` 立即改状态，视图要等一次刷新（50–200ms）
   才重绘；这期间残留的「Discard Hunk」按 `git apply -R` **写工作树**，会落到新仓库。
   两道防线：视图先清状态再 reload；引擎的 `git/apply-patch` 校验 `payload.root`
   （视图回传 `state.diff.root`），来源不符直接拒并返回 `code: "STALE_REPOSITORY"`。
   **凡是"读出来的东西过一会儿再写回去"的通道，都要带来源标识并校验。**
5. **仓库列表不要随每次刷新重扫**（它会走目录树）：只在挂载、项目切换、打开下拉时读
   （下拉自己会重读，所以不会显示过期的仓库）。
6. **探针的"预期失败"要静默**：`runGit` 有 `quiet` 选项；`.gitmodules` 不存在时
   干脆不 spawn `git config`。否则正常路径会在 Console 标签里显示成失败。

## 6. 验证入口（下次改这块直接照抄）

```bash
node tools/harness.mjs        # 134 条，含第 11–14 节：嵌套仓库全链路、扫描边界、
                              # 子模块的子模块、仓库消失后的回退、diff 兜底、补丁来源校验
node tools/build.mjs && node tools/smoke.mjs commit zh-CN   # 视图渲染（桩 bridge）
```
桩 `pi` 直接驱动引擎的探针脚本在本会话 scratch 里（`probe-repos.mjs` /
`probe-flow.mjs`）：真子模块 + 未声明嵌套仓库的仓库上跑 `git/repos` →
`git/select-repo` → 子模块内 stage/commit → 回父仓库看 gitlink。
视图断言用内置浏览器 CDP 直接读 DOM（芯片文案 / 徽标 / 下拉勾选态 / 切换后更新 /
单仓库隐藏 / 一次刷新不再读仓库列表）。
