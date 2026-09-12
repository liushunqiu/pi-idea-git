# 提交信息生成：把语言从"推断"改成参数

日期：2026-09-11
状态：implemented
范围：`local.pi-idea-git` 的 `main.js`（`buildSystemPrompt` / `commitStyle` /
`buildCommitContext`）与 `src/commit-view.js`（生成菜单）

## 起因

用户实测：在中文环境里点"生成提交信息"，得到的是英文草稿，而且格式是随手的
一句话，不符合 Git 的书写惯例。

根因在旧提示词的这一句（`main.js` 旧 `COMMIT_SYSTEM`）：

```
Write in the same language as the commit subjects you are given.
```

它把"语言"和"风格"绑成了一个信号。本仓库历史全是英文，于是模型正确地"匹配"
了英文——**但用户的诉求是中文**。这不是模型不听话，是提示词里根本没有表达
"用户要什么语言"的位置。

## 决策

### 1. 语言是参数，不是推断

选项落在生成按钮的 chevron 菜单里（`auto` / 简体中文 / 英文），与模型选择同一
菜单，随 `git/prefs-set` 持久化到插件的 `prefs.json`。

- `auto` = 仓库历史实测语言（旧行为，保留为默认，不惊吓老用户）
- `auto` 且仓库无历史 → 退回**界面语言**（视图每次请求都带 `PIG.state.locale`；
  插件进程拿不到界面语言，只能随请求传）
- 显式 `zh`/`en` → 覆盖仓库历史

### 2. 事实由插件测量，不让模型猜

`commitStyle()` 从最近 40 条**完整提交信息**（`%s%x1f%b%x1e`，控制字符分隔）里
量出三件事并写进用户消息：历史语言、是否使用 `type(scope):` 前缀（≥2 条命中
`/^[a-z][a-z0-9-]*(?:\([^)\n]{1,30}\))?!?: \S/` 即认为该仓库有此惯例）、是否
有人写正文。旧实现只取 `%s`，模型看不到"这个仓库的人写不写正文"。

### 3. 把可量化的硬规则写进提示词

依据 git-commit(1) 的 DISCUSSION、Tim Pope、Chris Beams 七条、Conventional
Commits 1.0.0：subject 与 body 之间空一行；subject 目标 50 字符、硬上限 72，
中文按"一字≈两宽"折算到约 25 字；结尾不加句号；正文说 why 而不是罗列文件；
`BREAKING CHANGE:` 是唯一允许自动追加的 trailer。

### 4. 语言规则必须能压过"匹配仓库"

这是最容易写错的地方：如果提示词里同时存在"匹配仓库语气"和"用中文"，模型会
挑一个。所以中文分支显式写死：

```
The repository's history is in English, but that is not the language of this message:
use Chinese anyway, and use that history only as a model for structure and for how long
a subject runs.
```

并且 type/scope 保留 ASCII（Conventional Commits 中译版的做法），
`feat(登录): 支持短信验证码`。

## Alternatives considered

- **只改一句话，把 "same language" 换成 "Chinese"**：最短路径，但把默认行为
  硬编码成中文，英文仓库用户会突然收到中文草稿；且没解决格式问题。放弃。
- **按界面语言自动选，不加菜单**：用户不用做选择，但会让英文仓库的中文用户
  拿到中文提交——提交历史是团队资产，语言是有共识的，不该被个人界面语言单方面
  改写。保留 `auto` 为默认，把决定权交出去。
- **要求模型遵守 Conventional Commits**：该规范是**可选约定**，本仓库自己就
  不用。无条件要求会给不用的仓库带上 `feat:` 前缀。改为检测后按仓库实际情况
  二选一（`commitStyle().conventional`），两条分支的提示词都验证过。
- **用 `diff --name-only` 列文件**：与 `git status --porcelain` 相比会重复列出
  同时改了 index 与 worktree 的文件。改用 porcelain 去重，并顺带拿到重命名折叠。
- **让模型自己决定要不要正文**：保留（"trivial 时一行即可"），但补了
  `style.bodies` 事实，避免在从不写正文的仓库里生成长篇。
- **在提示词里塞完整 diff 的上下文行**：`--no-prefix` 曾被试过又因为 `git apply`
  拒绝而回退，本次仍保留 `--no-prefix`（只用于提示词、不回喂 `git apply`）。
  文件级草稿走 `readDiff()`，仍带 `a/` `b/` 前缀，属已知不一致，未处理。

## 落地与验证

- 提示词注入：`buildSystemPrompt(lang, style)` 返回多行 system 文本；
  `draftCommitMessage` 把 `lang` 一并回传视图。
- 文案：`src/common.js` 新增 `commitLanguage` / `langAuto` / `langChinese` /
  `langEnglish`（en 与 zh-CN 两份）。
- 验证方式：`$PI_SCRATCH_DIR/prompt-probe.mjs`（把 `main.js` 的提交信息段落抽进
  `vm` 沙箱，用**真实 git 输出**喂 `buildCommitContext`，打印模型实际会看到的
  system + user 文本）与 `prompt-probe2.mjs`（文件级草稿、路径校验、两条前缀
  分支）。这两个探针是本次的主要证据来源——单元测试断言不了提示词的措辞。

## 追加修订（2026-09-12）：语言回退曾是死代码

### 症状

空仓库 / 全新仓库 + 中文界面，点"生成提交信息"仍然得到**英文草稿**——违反
上面第 1 条决策里写明的"`auto` 且仓库无历史 → 退回界面语言"。

### 根因

`commitStyle()` 无论有没有样本都返回 `"en"` 或 `"zh"`：

```js
language: english > chinese ? "en" : chinese > 0 ? "zh" : "en",
//                                                   ^^^^^ 空样本落这里
```

于是 `resolveCommitLang()` 里这一行永远命中，**后面的 locale 回退从来不会执行**：

```js
if (style.language) return style.language;   // 恒为真 ⇒ 死代码在下一行
return String(locale ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
```

界面语言其实**一直有传**（`src/commit-view.js` 把 `PIG.state.locale` 放进
`payload.locale`），是插件侧把它丢了。这是纯粹的实现与设计不一致，
不是设计问题——第 1 条决策本身没错。

### 修法

**让"测不出来"作为一个真实答案活到调用方**：`commitStyle()` 无法测量时
`language` 返回 **`null`**（不是 `"en"`）。

```js
language: chinese > english ? "zh" : english > chinese ? "en" : null,
```

`resolveCommitLang()` 一行未改，`if (style.language)` 现在能正确穿透到 locale。
`conventional` / `bodies` 保持基于 `samples` 数组（空数组 ⇒ false），
这样空仓库不会被无端授予 `type:` 前缀或"写正文"的惯例。

### 同时修掉的两处信号矛盾

1. **user message 里那行会把历史语言说成"本条消息的语言"**：
   ```js
   `Language of recent commit subjects: ${style.language === "zh" ? "Chinese" : "English"}`
   ```
   在"英文历史 + 显式中文"下它输出 "English"，而 system prompt 同时要求写中文
   —— 两个相反的信号。现改为先说事实（**有无历史**、历史是什么语言），
   再明确声明本条消息该用哪种语言。
2. **`bodyStyle` 原本依据 `style.language`**（历史语言），应依据 `lang`
   （本条消息实际使用的语言）。中文草稿即便历史是英文，行宽建议也该用中文那条。

### 补上的一处不对称

zh 分支原有"历史是英文也别跟着走"的护栏，en 分支**没有**——于是
"显式英文 + 中文历史"时，模型只看到"历史是中文"却没有任何反向指令。
已为 en 分支补上镜像护栏。

### 验证

- `$PI_SCRATCH_DIR/lang-matrix.mjs`：`preference(3) × history(3) × locale(2)`
  = **18 种组合，0 处矛盾**（逐一检查 system prompt 的语言规则与 user message
  的事实陈述是否互相打架）。
- `$PI_SCRATCH_DIR/lang-probe.mjs`：**24/24**，覆盖空/无字母历史 + 中英界面、
  真历史覆盖界面语言、显式偏好覆盖一切、以及提示词不出现错误的历史声明。
- `$PI_SCRATCH_DIR/user-message-probe.mjs`：**14/14**，直接断言 user message
  的 style 段措辞。

### 教训

**"测不出来"不能被折叠成某个默认值。** `?? "en"` 这种兜底看起来无害，
实际是把一个"未知"状态伪装成"确定是英文"，让下游所有兜底逻辑变成死代码——
而且**没有任何报错**，只有用户能感觉到"我明明选了中文界面"。
凡是"未知"有语义的地方，就让 `null` 流下去。

## 评审抓到的一处**真回归**（我引入的，已修）

我第一版把 `commitStyle` 的平局也判成了 `null`：

```js
language: chinese > english ? "zh" : english > chinese ? "en" : null,  // ✗ 错
```

**两个计数桶不是互斥的**：`feat(登录): 支持短信验证码` 同时含 CJK 和 ≥3 个连续
拉丁字母（`feat`、`docs`），于是**两边各计一次**。中文团队最典型的 Conventional
Commits 写法必然每条都双计 ⇒ 完全平局 ⇒ `language = null` ⇒ 穿透到 locale 回退。

实测（`verify-rv001.mjs`，基线取暂存区版本）：

| 用例 | locale | 修复前 | 我第一版 | 修正后 |
|------|--------|--------|----------|--------|
| 中文 Conventional Commits | zh-CN | zh | zh | zh |
| 中文 Conventional Commits | **en-US** | **zh** | **en** ✗ | **zh** ✓ |

即：中文 CC 仓库 + 英文界面时，默认项 `auto` 从中文退回英文——正是本插件立项要
消除的那类失败，只是换了个触发条件，且同仓库在中文界面下表现正常，很难察觉。

**修法**：让两桶互斥（含 CJK 即算中文 subject，否则才按拉丁字母判英文），
并把 `null` 严格保留给"测不出来"（`chinese || english` 为 0）：

```js
const isChinese = (value) => /[\u3400-\u9fff]/.test(value);
const chinese = samples.filter((e) => isChinese(e.subject)).length;
const english = samples.filter((e) => !isChinese(e.subject) && /[A-Za-z]{3}/.test(e.subject)).length;
language: chinese || english ? (chinese >= english ? "zh" : "en") : null,
```

## 同一轮修掉的另两处（评审 RV-002 / RV-003）

- **RV-002**：`"this repository has no commit history yet"` 原本由 `style.language
  === null` 驱动，而 `null` 有两种成因（真没历史 / 有历史但判不出语言）。于是
  "无字母 subject"的仓库会**同一条消息里**既说"没有历史"、又打印出 40 条历史样本，
  自相矛盾。改为新增 `style.count`（样本数）作为判据，措辞也区分为
  "no commit history yet" vs "no clear signal about wording"。
- **RV-003**：`buildCommitContext` 里曾用 `historyLanguage === "Chinese"`（展示串）
  选分支——一旦本地化或改词就会静默走错分支。改为直接判 `style.language`。

## 教训（更正上一条）

上面写的"凡'未知'有语义就别兜底成具体值"**只说对了一半**。更完整的表述是：

> **"未知"的判据必须与它真正的成因一一对应，而且要检查各成因是否互斥。**

`null` 本身没错，错在把"平局"（可测量！）也算进了"未知"。发布前应当对
**每个**落到 `null` 的路径单独举一个真实仓库例子——本次就是漏了"中文 CC 仓库"
这个再常见不过的形态。

## 追加修订（2026-09-12）：格式不能靠提示词保证

### 症状

用户实际生成出来的提交信息是：

```
将变更列表改为树形展示
目录按树分组、可折叠并按文件夹纳入提交,筛选可快速定位变更;提交信息语言可手动选择,不再跟随历史推断;合并高频工作区刷新并减少差异节点,切换与大差异时不再卡顿。
```

**主句与正文之间没有空行**。Git 把第一个空行之前的**全部**内容当作标题
（git-commit(1)：*"The text up to the first blank line ... is treated as the
commit title"*），所以这条消息在 `git log --oneline` 里是一条**巨长的标题**，
根本没有正文——用户说的"不符合规范"就是指这个。附带三处：正文是一句话
（用 `;` 串起三件事）、整段不折行、中文句子里混着半角 `,` `;`。

### 判断

提示词里**本来就有**"After the subject, leave a blank line and then the body"
这一句，模型仍然没照做。说明这类失败不是"规则没写"，而是：

> 提示词能提高模型做对的概率，但不能保证格式；凡是**机械可判**的格式
> （空行、折行、标点、行长上限），都应该由代码在模型输出之后强制成立。

特别是"缺空行"这种后果**不可见**——消息框里看着像两段，实际是一条标题，
只有提交后 `git log` 才暴露。既然用户看不见，就更不能交给概率。

### 决策：加 `formatCommitMessage(raw)`，做确定性重整

只搬动模型自己的字，不改写措辞：

1. **保证空行**：subject 取第一行，其后恒定一个空行，模型写没写都一样。
2. **超长标题不截断，下沉**：>72 列时在子句边界（`，,；;：:。！？`）切开，
   优先让 subject ≤50 列；切不动（整句无标点）就原样保留，绝不编造标题。
3. **正文按 72 列硬折行**，并且**按显示宽度**计算——CJK 字形占 2 列，
   这正是 50/72 规则对应"约 25 个汉字"的原因（`textWidth`）。
4. **`；`/`;` 串起来的子句拆成每行一个 `- ` 项目符号**，但仅当该行 >50 列，
   否则 `修复拼写；无行为变化` 被拆开是噪音。
5. **中文之间的 `,` `;` 归一成 `，` `；`**，判据是"两侧都是汉字"，
   所以 `feat(a,b): 支持` 与任何路径/标识符不受影响。

### 两个必须自己踩出来的坑

- **幂等性**：第一版对每个段落无条件补空行，结果连续的项目符号之间被插了空行
  （`formatCommitMessage` 每次生成都跑，草稿已经正确时会被改坏）。改为**只在
  输入真有空行处**断段。
- **折行续行**：折出来的续行若被当作新段落，第二次处理就会重复折行。解法是
  "行首有缩进 ⇒ 续行"，读回时先合并再折；合并时**拉丁文要补回被吃掉的空格，
  CJK 不能补**，判据是断口两端是否 ASCII（`joinWrapped`）。

两个坑都是 `$PI_SCRATCH_DIR/format-probe.mjs` 的不变量检查（幂等、恒有空行、
行宽 ≤72、标题无尾标点）抓出来的——**给纯函数写不变量断言，比读代码快**。

### Alternatives considered

- **只把提示词再写重一点**（加大写、加"THIS IS MANDATORY"）：试过了，第一版
  提示词里已经有这句规则，模型照样不遵守。放弃。
- **让视图侧兜底**（在 `src/commit-view.js` 里整理）：格式是提交信息的属性，
  不是某个视图的属性；插件进程是唯一所有调用都经过的地方，放这里两个视图
  （Commit 与 Git 面板）自动一致。
- **超长标题直接截断到 50 列**：会丢内容，而且截断点常常落在词中间。下沉到
  正文既守住规范又不丢信息。
- **正文一律改成项目符号**：会改写模型的行文结构，超出"排版"的边界。
  只在 `；` 已经充当分隔符时拆。
- **用 `string.length` 算行宽**：中文会被少算一半，50/72 变成 100/144 列，
  等于规则失效。必须按显示宽度算。

### 验证

- `$PI_SCRATCH_DIR/format-probe.mjs`：10 个用例（用户那条原文、同一句压成一行、
  已规范的草稿、带 ``` 围栏与 "Commit message:" 前缀、结尾句号、英文草稿、
  已带项目符号、只有标题、中文里混半角标点、`feat(a,b)`）全部通过不变量：
  恒有空行、行宽 ≤72、标题无尾标点、**幂等**。
- 回归 harness 51/51 通过（临时仓库 fixture）。
- 提示词同步加了**填好的示例**（`<commit-message>…</commit-message>`，按语言
  与是否 CC 惯例分支）——第一版只有规则，模型知道"blank line"这个词却仍不写。
