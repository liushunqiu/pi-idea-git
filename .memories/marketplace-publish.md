# 向 vastsa/pi-desktop-plugins 上架的实战坑位

2026-09-14 首发 `io.github.liushunqiu.pi-idea-git@0.3.0`，PR vastsa/pi-desktop-plugins#47。
官方 CONTRIBUTING 只说了 pack → audit → rebuild → test → PR，下面是文档里没有、踩了才知道的。

## 1. panel-chrome 测试是硬门槛（最容易挂）

`tests/panel-chrome.test.mjs` 第一个用例遍历**所有** `plugins/*/manifest.json` 中带
`manifest.ui.panel` 的插件（注意：只看 `ui.panel`，`contributes.views` 的 docked 视图不看），
要求 panel HTML 同时含 4 样东西：

- `<meta name="pi-plugin-chrome" content="v3" />`
- `PI-Desktop owns exactly a transparent 46px drag band`（或 `a 46px drag band`）
- `three-button … window-control capsule`（正则跨行）
- `var(--pi-plugin-titlebar-height, 46px)`

缺一个就挂。标准写法抄 `plugins/pi.todo/renderer/index.html` 头部那段 HTML 注释即可。
**并且**该用例断言 panel 插件总数（当时是 `18`），加一个带 `ui.panel` 的插件必须把计数 +1，
否则修了注释也照样红。我们的修法：注释写进生成模板 `tools/build.mjs` 的 `page()` 里
（产物 `views/*.html`/`renderer/index.html` 禁止手改），重跑 `build.mjs` + `make-publish-dir.mjs`。

## 2. 上架只拷运行时文件，不要整仓拷

`scripts/pack_plugin.py` 会把 `plugins/<id>/` 下除 `.git/node_modules/.DS_Store`
外的**所有文件**打进 `.piplug`。我们本仓有 `tools//src//.smoke//.memories/`，
整仓拷过去包就脏了。做法：只拷 `manifest.json/main.js/views/*.html/renderer/index.html/
README.md/LICENSE/CHANGELOG.md` 这 8 个（即 `dist-publish/<id>/` 的内容，不含 `dist/*.piplug`）。

## 3. 目录名必须等于 manifest.id

`pack_plugin.py` 校验 `manifest.id == 目录名`，含 `/` 直接拒。社区插件用反向域名
（`io.github.<user>.<name>`），和 `muzimu217` 的 `session-import` 同规范。

## 4. catalog.json 禁止手改，url 是相对路径

`packages/<id>-<version>.piplug` 必须存在才 `rebuild_catalog.py` 成功；
`url` 字段生成的是 `packages/xxx.piplug` 相对路径（客户端自己拼 raw 地址），
`shasum/sizeBytes/publishedAt` 自动算。PR 里 `catalog.json` 是生成物，一起提交即可。

## 5. 每个新插件要自带测试文件

仓规矩：加插件/改 manifest 必须配测试断言**精确权限列表 + 版本**。
仿 `tests/session-import.test.mjs` 写 `tests/pi-idea-git.test.mjs`：
manifest 身份/权限/i18n safetyNotes/ui 双语标题/views+commands、
`require(main.js)` 导出 `onLoad/onUnload/onPanelInvoke`、
`spawn(binary, args, …)` 且无 `shell: true`、视图产物自包含。

## 6. 安全审计 0 blocker 不等于过审

`security_audit.py --check-packages` 对 git 插件一定报 manual-review 信号
（process execution / native executable / credential / destructive / clipboard），
10 个左右正常。PR 描述里要附能力/数据流矩阵：
只对工作区仓库根跑系统 git、无网络、无遥测、不碰 API Key、
删未跟踪文件有确认框、提交信息走宿主模型额度。high-risk 合并要两个 maintainer 审批。

## 7. 网络与 fork 流程

`raw.githubusercontent.com` 在本机超时，但 `api.github.com` 与 `git clone` 可用
（fork 克隆一次成功；直接 clone 上游曾超时）。流程：
`gh repo fork vastsa/pi-desktop-plugins --clone=false` →
clone 自己 fork 到 `$PI_SCRATCH_DIR`（别污染工作区）→ 改完 push fork →
`gh pr create --repo vastsa/pi-desktop-plugins`。
commit 用英文 `feat(<id>): …`（仓规范）；顺手把 README.md / README.zh-CN.md
社区表各加一行，否则合了也搜不到。

## 8. 本仓联动

`aa2203a fix(构建)`：构建模板加 v3 chrome 注释。以后改面板文案/样式只改
`src/*` + `tools/build.mjs`，产物重生成，不要手改三份 HTML。
