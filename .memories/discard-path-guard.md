# discard 路径守卫："." 会删整个仓库（2026-09-12）

`git/discard` 对未跟踪文件走 `fs.rmSync(path.resolve(repo.root, p))`。
`isSafePath(".")` 曾返回 true（非绝对、无 `..` 分段），而 `ls-files --error-unmatch -- "."`
在“无跟踪文件”仓库里 exit=1 → 落入 `removed[]` → `rmSync(repo.root, recursive)` 即删整个项目（含 `.git`）。
2026-09-12 审查发现，修复在 `main.js`：`isSafePath` 拒绝归一化后为 `.`/`""` 的路径，
且 `rmSync` 前用 `samePath(resolved, repo.root)` 二次断言拒绝。

教训：
1. 任何进 `rmSync`/`rm -rf` 的相对路径，必须先 `posix.normalize` 再判 `.`/`""`/`/`，
   注意 `normalize("./")` 仍是 `"./"`（尾斜杠不去掉），要先 strip 尾 `/`。
2. 防御纵深：入口校验 + 执行前 `resolved !== repo.root` 断言，两层都要。
3. `readDiff` 等只读通道也要同等 `isSafePath`（虽只报错不删文件，保持一致免漏）。
