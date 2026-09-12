# Agent Note 校验脚本（vendored）

这里的三个脚本来自 [`write-notes-like-deepseek`](https://github.com/czm15053/write-notes-like-deepseek)
skill，**逐字节复制、未做任何修改** —— 这样 `node tools/notes.mjs` 与
`node tools/harness.mjs` 不依赖本机是否装了那个 skill，也能在 CI 里跑。

| 文件 | 作用 |
|------|------|
| `agent-note-tree.ts` | 笔记树解析：定位 `.agents/notes`、判定 lifecycle、共用给下面两个脚本 |
| `verify-agent-note-tree.ts` | 校验 `{lifecycle}/{class}/yyyy-mm-dd-topic.md` 路径合法、禁止 `INDEX.md`、笔记内相对 Markdown 链接必须指向真实文件 |
| `verify-agent-note-format.ts` | 校验头块（`# Agent Note:` / `Status: <lifecycle>`）、首节必须是 `## Problem` 或 `## 问题`、必选节（`Decision` / `Alternatives considered` / `Consequences`）、且 `implemented` 里禁止提案口吻标题 |

## 重同步

上游更新后整目录覆盖即可（脚本是 `.ts`，本机 Node 26 直接执行类型剥离，
**不需要 tsx、不需要构建**）：

```sh
cp ~/.agents/skills/write-notes-like-deepseek/scripts/{agent-note-tree,verify-agent-note-format,verify-agent-note-tree}.ts tools/agent-notes/
diff -r ~/.agents/skills/write-notes-like-deepseek/scripts tools/agent-notes
# ↑ 应只报 build-board.ts / archive-agent-note.ts / import-dsh-notes.ts 三个未收录项
```

**不要在这里改脚本**：一改就与上游分叉，下次整目录覆盖会把你的修改静默丢掉。要改就改上游。

## 为什么只收这三个

`build-board.ts`（生成决策看板 `board.html`）、`archive-agent-note.ts`（归档被取代的笔记）、
`import-dsh-notes.ts` 都是按需使用的运维脚本，不属于每次提交都要跑的门禁，需要时直接从
skill 目录执行 `node <skill>/scripts/<script>.ts` 即可。
