# Edit 工具的行号语义坑（2026-09-12 实测）

`default.Edit` 的 `ops` 里行号永远指**当前磁盘文件**，且含义是：

- `PUT N.=M:` = **替换** N–M 行（不是"在 N 处插入"）。想在某行之后插入用 `PUT >N:`，
  之前插入用 `PUT <N:`。把"插入"写成 `PUT N.=N:` 会**吃掉原来那一行**（本次实测：
  i18n 的 `pushing:` 键、`dialog({ title: … })` 两行、Push 对话框副标题各被吃一次，
  每次都是 `node --check` 报 SyntaxError 才发现）。
- 每次成功 Edit 后行号全部漂移：**下一次 Edit 前必须重新 `Read`/`grep` 取号**，
  禁止凭记忆沿用旧号（本次把 `commit()` 的守卫插进 `openCommitMenu()` 里，就是用了
  paintCommit 编辑之前的旧行号）。
- `PUT` 的 body 每行必须以 `+` 开头；`CUT` 末尾不带冒号。`review.additions: 0`
  且 `hunks: []` 时说明操作很可能没按预期生效，立刻 `sed -n` 复查，不要继续。
- 大段替换后固定动作：`node --check <file>` + `sed -n` 看接缝。尾部多出 `]),` /
  `]);` 这类"旧尾巴"是典型症状（`CUT` 掉即可）。
