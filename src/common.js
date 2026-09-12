/**
 * Shared runtime for both tool windows: host bridge access, the IDEA wording
 * (English原文 + 中文), icons, popups and the small layout primitives.
 *
 * Everything hangs off one namespace because the pages are built by
 * concatenating files into a single classic script — see tools/build.mjs.
 */
(function (PIG) {
  "use strict";

  const bridge = window.pluginBridge;

  // ---------------------------------------------------------------- i18n ---
  // IDEA's own wording is the source of truth for labels, so the English
  // strings double as the documented feature names.
  const STRINGS = {
    en: {
      commit: "Commit",
      commitAndPush: "Commit and Push",
      commitMessage: "Commit Message",
      commitHistory: "Commit message history",
      amend: "Amend",
      signOff: "Sign-off commit",
      runHooks: "Run Git hooks",
      changes: "Changes",
      staged: "Staged",
      unstaged: "Unstaged",
      unversioned: "Unversioned Files",
      conflicts: "Merge Conflicts",
      noChanges: "No changes",
      refresh: "Refresh",
      fetch: "Fetch",
      pull: "Pull",
      push: "Push",
      update: "Update Project",
      rollback: "Rollback",
      showDiff: "Show Diff",
      jumpToSource: "Jump to Source",
      stage: "Add",
      stageFile: "Add to index",
      unstageFile: "Remove from index",
      stageHunk: "Stage Hunk",
      unstageHunk: "Unstage Hunk",
      discardHunk: "Discard Hunk",
      includeIntoCommit: "Include into commit",
      discard: "Discard Changes",
      git: "Git",
      log: "Log",
      console: "Console",
      branches: "Branches",
      localBranches: "Local branches",
      remoteBranches: "Remote branches",
      tags: "Tags",
      changedFiles: "Changed Files",
      commitDetails: "Commit Details",
      graphOptions: "Graph Options",
      byCommitDate: "By commit date",
      topologically: "Topologically",
      showFirstParent: "Show First Parent",
      noMerges: "No Merges",
      showGraph: "Show Graph",
      search: "Search",
      filterByBranch: "Branch",
      filterByUser: "User",
      filterByPaths: "Paths",
      allBranches: "All Branches",
      author: "Author",
      date: "Date",
      hash: "Hash",
      subject: "Subject",
      message: "Message",
      all: "All",
      checkoutRevision: "Checkout Revision",
      newBranchFromHere: "New Branch from Here",
      newTag: "New Tag",
      cherryPick: "Cherry-Pick",
      revert: "Revert",
      resetToHere: "Reset Current Branch to Here",
      editCommitMessage: "Edit Commit Message",
      copyRevisionNumber: "Copy Revision Number",
      compareWithLocal: "Compare with Local",
      showRepository: "Show Repository",
      soft: "Soft",
      mixed: "Mixed",
      hard: "Hard",
      reset: "Reset",
      newBranch: "New Branch",
      checkout: "Checkout",
      mergeIntoCurrent: "Merge into Current",
      rebaseOnto: "Rebase Current onto Selected",
      deleteBranch: "Delete",
      stash: "Stash",
      stashChanges: "Stash Changes",
      unstash: "Unstash",
      dropStash: "Drop",
      applyStash: "Apply Stash",
      stashMessage: "Stash message",
      unified: "Unified viewer",
      sideBySide: "Side-by-side viewer",
      collapseUnchanged: "Collapse Unchanged Fragments",
      ignoreDifferences: "Ignore Differences",
      ignoreNone: "None",
      ignoreTrim: "Trim whitespaces",
      ignoreWhitespace: "Ignore whitespaces",
      ignoreWhitespaceAndEmpty: "Ignore whitespaces and empty lines",
      showWhitespaces: "Show Whitespaces",
      showLineNumbers: "Show Line Numbers",
      previousDifference: "Previous Difference",
      nextDifference: "Next Difference",
      whiteSpaceOnly: "whitespace only",
      binaryDiff: "Binary file — no textual diff",
      noDiff: "No differences",
      clearAll: "Clear All",
      notARepository: "Not a Git repository",
      noWorkspace: "No workspace is open",
      gitMissing: "Git executable not found",
      pickFile: "Select a file to see its diff",
      files: "files",
      selected: "selected",
      nothingStaged: "Nothing is staged",
      inProgress: "Merge or rebase in progress",
      copy: "Copy",
      copied: "Copied",
      cancel: "Cancel",
      ok: "OK",
      close: "Close",
      showDetails: "Show Details",
      viewOptions: "View Options",
      branchLabel: "Branch",
      head: "HEAD",
      uncommitted: "uncommitted changes",
      loading: "Loading…",
      conflictNotice: "Resolve conflicts before committing",
      unversionedNotice: "Unversioned files must be added before they can be committed",
      allChanges: "All Changes",
      flat: "Flat",
      groupByDirectory: "Group by Directory",
      openFile: "Open File",
      revealInFileManager: "Reveal in File Manager",
      stageAllChanges: "Add All to Index",
      unstageAllChanges: "Remove All from Index",
      noCommits: "No commits yet",
      filesChanged: "files changed",
      outgoing: "outgoing commits",
      incoming: "incoming commits",
      diff: "Diff",
      submodule: "submodule",
      authSsh: "Your Git has no credential the plugin can use for this remote. It runs your own git, so configure the remote the same way your terminal does: use an HTTPS URL, or make the key work without ssh-agent (the host does not pass SSH_AUTH_SOCK, so agent-held keys cannot be unlocked). On macOS, `UseKeychain yes` in ~/.ssh/config is enough.",
      authCredentials: "No stored credential for this remote, and there is no terminal here to type one. Push once from a terminal to let your credential helper store it, then retry.",
      generateMessage: "Generate Commit Message",
      generating: "Generating…",
      generateOptions: "Model and options",
      modelLabel: "Model",
      commitLanguage: "Message language",
      langAuto: "Match repository history",
      langChinese: "Simplified Chinese",
      langEnglish: "English",
      noModel: "No AI provider is ready to use. Add one, or sign one in, under Settings → AI providers.",
      modelPermission: "The plugin has not been granted access to your models yet, so it cannot list them. Reload it: Extensions → ··· → Load local plugin, and approve the new permissions.",
      modelPermissionShort: "Cannot list your models — reload to grant access",
      rateLimited: "Too many generations in a row (the host allows 8 per minute). Wait a moment and try again.",
      nothingToDescribe: "Nothing to describe: stage a change, or select a file in the Changes list first.",
      draftTimeout: "The model did not answer in time.",
      replaceDraft: "Replace your draft?",
      replaceDraftBody: "Generating a message overwrites what you have already typed.",
      replace: "Replace",
      draftedStaged: "Commit message drafted from everything staged",
      draftedFile: "Commit message drafted from {{file}}",
      submoduleBadge: "submodule",
      submoduleInside: "This change is inside the submodule {{path}}. The parent repository can only record which commit the submodule points at, so it cannot be committed from here. Switch to the submodule in the repository list (top left), commit there, then come back and stage it here.",
      submoduleStagedHint: "Staged the submodule's commit. Its own uncommitted changes stay inside it and still show as unstaged.",
      repository: "Repository",
      switchRepository: "Switch repository",
      repositoryList: "Repositories",
      nestedRepoBadge: "nested repository",
      nestedRepoHint: "A Git repository that lives inside this one without being a submodule: the parent stores none of its files.",
      appShortcutHint: "The command palette belongs to the app: click back into the main window first, or press Alt+Space for the plugin launcher.",
      dropStashConfirm: "Drop this stash?",
      noMatchingChanges: "No changes match the filter",
      filterChanges: "Filter changes",
      compactMiddleDirs: "Compact Middle Directories",
      collapseAll: "Collapse All",
      includeFolder: "Include this folder into commit",
      unincludeFolder: "Exclude this folder from commit",
      repositoryHint: "Open a folder that is inside a Git repository.",
      remoteAhead: "The remote branch has commits you do not have. Fetch, then Pull, and push again — or, if the local history is the one to keep, use Force Push from the branch menu.",
      pushRejected: "The server refused the push — the branch is probably protected, or a hook rejected it.",
      pullDiverged: "Local and remote have diverged. Merge or rebase, then push.",
      // Not "then commit": a pull that rebases (the user's own `pull.rebase`)
      // stops on conflicts too, and there the finish is Continue. The status
      // line above the commit button knows which one it is; this only has to
      // send the user there.
      pullConflicts: "The pull stopped on conflicts — resolve them in the Changes list, then finish it there.",
      mergeInProgress: "Merging — resolve the conflicts, then commit to finish.",
      rebaseInProgress: "Rebasing — resolve the conflicts, then continue.",
      cherryPickInProgress: "Cherry-picking — resolve the conflicts, then continue.",
      revertInProgress: "Reverting — resolve the conflicts, then continue.",
      abortOperation: "Abort",
      continueOperation: "Continue",
      forcePush: "Force Push (with lease)",
      forcePushTitle: "Overwrite the remote branch?",
      forcePushBody: "This rewrites {{branch}} on {{remote}}: commits that are there and not here are dropped. The lease means it only runs while the remote is still where this window last saw it, so a push from someone else is refused instead of erased.",
      gitOutput: "Git output",
      showDetail: "Show details",
       commitSummary: "{{staged}} of {{total}} file{{s}} will be committed",
       generateScope: "{{action}} · {{lang}} (uses everything staged when no file is selected)",
       collapsedLines: "⋮ {{count}} unchanged line{{s}}",
       copyPath: "Copy Path",
       switchToRepo: "Switch to this repository",
       submoduleGroup: "{{rel}} ({{kind}} · {{branch}})",
       commitMultipleRepos: "Commit {{count}} repositories with the same message",
       submoduleCommitted: "{{rel}} committed",
       siblingRepoBadge: "sibling repository",
       siblingRepoHint: "A repository that sits next to the current one in the same folder, not inside it.",
       pushDialogTitle: "Push",
       pushDialogSubtitle: "Push each repository's commits to its own remote.",
       pushAll: "Push All",
       pushSelected: "Push Selected",
       pushing: "Pushing…",
       pushed: "Pushed",
       pushedRepos: "Pushed {{count}} repositories",
       pushPartial: "Pushed {{ok}} of {{total}} repositories",
       pushNoUpstream: "no upstream",
       pushNoRemote: "no remote to push to",
       pushUpToDate: "up to date",
       pushNothingToPush: "Nothing to push: every repository is up to date.",
       pushDialogHint: "Only the checked repositories are pushed. A failure in one does not stop the others.",
       pushRowPushed: "{{branch}} → {{remote}}/{{branch}}",
       relativeJustNow: "just now",
      relativeMinutesAgo: "{{count}} minute{{s}} ago",
      relativeHoursAgo: "{{count}} hour{{s}} ago",
      relativeDaysAgo: "{{count}} day{{s}} ago",
    },
    "zh-CN": {
      commit: "提交",
      commitAndPush: "提交并推送",
      commitMessage: "提交信息",
      commitHistory: "提交信息历史",
      amend: "修正上一次提交",
      signOff: "签名",
      runHooks: "运行 Git 钩子",
      changes: "变更",
      staged: "已暂存",
      unstaged: "未暂存",
      unversioned: "未纳入版本控制的文件",
      conflicts: "合并冲突",
      noChanges: "没有变更",
      refresh: "刷新",
      fetch: "抓取",
      pull: "拉取",
      push: "推送",
      update: "更新项目",
      rollback: "回滚",
      showDiff: "显示差异",
      jumpToSource: "跳到源文件",
      stage: "添加到索引",
      stageFile: "添加到索引",
      unstageFile: "从索引中移除",
      stageHunk: "暂存该代码块",
      unstageHunk: "取消暂存该代码块",
      discardHunk: "丢弃该代码块",
      includeIntoCommit: "纳入本次提交",
      discard: "丢弃更改",
      git: "Git",
      log: "日志",
      console: "控制台",
      branches: "分支",
      localBranches: "本地分支",
      remoteBranches: "远程分支",
      tags: "标签",
      changedFiles: "变更的文件",
      commitDetails: "提交详情",
      graphOptions: "提交图选项",
      byCommitDate: "按提交时间",
      topologically: "按拓扑顺序",
      showFirstParent: "仅第一条父提交",
      noMerges: "隐藏合并提交",
      showGraph: "显示提交图",
      search: "搜索",
      filterByBranch: "分支",
      filterByUser: "提交者",
      filterByPaths: "路径",
      allBranches: "所有分支",
      author: "作者",
      date: "日期",
      hash: "哈希",
      subject: "说明",
      message: "信息",
      all: "全部",
      checkoutRevision: "检出该修订",
      newBranchFromHere: "从此处新建分支",
      newTag: "新建标签",
      cherryPick: "拣选",
      revert: "反转提交",
      resetToHere: "将当前分支重置到此处",
      editCommitMessage: "修改提交信息",
      copyRevisionNumber: "复制修订号",
      compareWithLocal: "与本地比较",
      showRepository: "显示仓库",
      soft: "Soft",
      mixed: "Mixed",
      hard: "Hard",
      reset: "重置",
      newBranch: "新建分支",
      checkout: "检出",
      mergeIntoCurrent: "合并到当前分支",
      rebaseOnto: "将当前分支变基到此分支",
      deleteBranch: "删除",
      stash: "储藏",
      stashChanges: "储藏更改",
      unstash: "取消储藏",
      dropStash: "删除储藏",
      applyStash: "应用储藏",
      stashMessage: "储藏说明",
      unified: "单栏视图",
      sideBySide: "并排视图",
      collapseUnchanged: "折叠未修改的片段",
      ignoreDifferences: "忽略差异",
      ignoreNone: "不忽略",
      ignoreTrim: "忽略行尾空白",
      ignoreWhitespace: "忽略空白",
      ignoreWhitespaceAndEmpty: "忽略空白与空行",
      showWhitespaces: "显示空白字符",
      showLineNumbers: "显示行号",
      previousDifference: "上一处差异",
      nextDifference: "下一处差异",
      whiteSpaceOnly: "仅空白差异",
      binaryDiff: "二进制文件，无文本差异",
      noDiff: "没有差异",
      clearAll: "全部清空",
      notARepository: "不是 Git 仓库",
      noWorkspace: "没有打开的工作区",
      gitMissing: "找不到 git 可执行文件",
      pickFile: "选择一个文件查看差异",
      files: "个文件",
      selected: "已选择",
      nothingStaged: "暂存区为空",
      inProgress: "正在进行合并或变基",
      copy: "复制",
      copied: "已复制",
      cancel: "取消",
      ok: "确定",
      close: "关闭",
      showDetails: "显示详情",
      viewOptions: "视图选项",
      branchLabel: "分支",
      head: "HEAD",
      uncommitted: "未提交的更改",
      loading: "加载中…",
      conflictNotice: "请先解决冲突再提交",
      unversionedNotice: "未纳入版本控制的文件需要先添加到索引",
      allChanges: "全部更改",
      flat: "平铺",
      groupByDirectory: "按目录分组",
      openFile: "打开文件",
      revealInFileManager: "在文件管理器中显示",
      stageAllChanges: "全部添加到索引",
      unstageAllChanges: "全部从索引中移除",
      noCommits: "暂无提交",
      filesChanged: "个文件有变更",
      outgoing: "待推送的提交",
      incoming: "待拉取的提交",
      submodule: "子模块",
      authSsh: "插件用的就是你自己的 git，但这个远端没有它可用的凭据。请按你终端里的方式配好远端：改用 HTTPS 地址，或让密钥不依赖 ssh-agent（宿主不传递 SSH_AUTH_SOCK，所以放在 agent 里的密钥解不开）。macOS 上在 ~/.ssh/config 里加 `UseKeychain yes` 即可。",
      authCredentials: "这个远端没有已保存的凭据，而这里没有终端可以输入密码。请在终端里手动 push 一次，让凭据助手把它存下来，然后再重试。",
      generateMessage: "生成提交信息",
      generating: "生成中…",
      generateOptions: "模型与选项",
      modelLabel: "模型",
      commitLanguage: "提交信息语言",
      langAuto: "跟随仓库历史",
      langChinese: "简体中文",
      langEnglish: "英文",
      noModel: "没有可用的 AI 服务：请先在「设置 → AI 服务」中添加或登录一个。",
      modelPermission: "插件还没有拿到读取模型的权限，因此列不出模型。请重新加载：扩展页 → 右上角 ··· → 「加载本地插件」，并同意新增的权限。",
      modelPermissionShort: "无法列出模型 — 需重新加载以授权",
      rateLimited: "连续生成次数过多（宿主限制每分钟 8 次）。请稍等片刻再试。",
      nothingToDescribe: "没有可描述的内容：请先暂存改动，或在变更列表里选中一个文件。",
      draftTimeout: "模型未在规定时间内返回。",
      replaceDraft: "替换当前草稿？",
      replaceDraftBody: "生成会覆盖你已经输入的内容。",
      replace: "替换",
      draftedStaged: "已生成提交信息（来源：全部已暂存内容）",
      draftedFile: "已生成提交信息（来源：{{file}}）",
      submoduleBadge: "子模块",
      submoduleInside: "这个改动在子模块 {{path}} 内部。父仓库只能记录子模块指向哪个提交，无法从这里把它提交掉。请在左上角的仓库列表里切换到该子模块，在里面提交，再回到这里暂存。",
      submoduleStagedHint: "已暂存子模块指向的提交。子模块内部未提交的改动仍然留在里面，所以它依旧显示为未暂存。",
      repository: "仓库",
      switchRepository: "切换仓库",
      repositoryList: "仓库列表",
      nestedRepoBadge: "嵌套仓库",
      nestedRepoHint: "这个 Git 仓库位于当前仓库内部，但不是子模块：父仓库不保存它的任何文件。",
      appShortcutHint: "命令面板由宿主提供，需先点回主窗口；或在视图内按 Alt+Space 打开插件启动器。",
      diff: "差异",
      dropStashConfirm: "删除该储藏？",
      noMatchingChanges: "没有匹配的变更",
      filterChanges: "筛选变更",
      includeFolder: "把该文件夹纳入本次提交",
      unincludeFolder: "把该文件夹排除出本次提交",
      compactMiddleDirs: "折叠中间目录",
      collapseAll: "全部折叠",
      repositoryHint: "请打开一个位于 Git 仓库内的文件夹。",
      remoteAhead: "远端分支上有你还没有的提交。请先 Fetch，再 Pull，然后重新推送；若要以本地历史为准，用分支菜单里的「强制推送」。",
      pushRejected: "服务端拒绝了这次推送 — 分支可能受保护，或被钩子拦下。",
      pullDiverged: "本地与远端已分叉：请先合并或变基，再推送。",
      pullConflicts: "拉取因冲突停下 — 请在变更列表里解决冲突，然后在那里收尾。",
      mergeInProgress: "合并进行中 — 解决冲突后提交即可完成",
      rebaseInProgress: "变基进行中 — 解决冲突后点「继续」",
      cherryPickInProgress: "拣选进行中 — 解决冲突后点「继续」",
      revertInProgress: "还原进行中 — 解决冲突后点「继续」",
      abortOperation: "中止",
      continueOperation: "继续",
      forcePush: "强制推送（with lease）",
      forcePushTitle: "覆盖远端分支？",
      forcePushBody: "这会把 {{remote}} 上的 {{branch}} 重写为本地提交：只存在于远端的提交将被丢弃。lease 的含义是只有远端仍停在本窗口上次看到的位置时才执行，因此他人的推送会被拒绝，而不是被覆盖。",
      gitOutput: "Git 输出",
      showDetail: "查看详情",
       commitSummary: "将提交 {{staged}} / {{total}} 个文件",
       generateScope: "{{action}} · {{lang}}（未选中文件时使用全部已暂存内容）",
       collapsedLines: "⋮ {{count}} 行未修改",
       copyPath: "复制路径",
      switchToRepo: "切换到该仓库",
      submoduleGroup: "{{rel}}（{{kind}} · {{branch}}）",
      commitMultipleRepos: "将用同一提交信息提交 {{count}} 个仓库",
      submoduleCommitted: "{{rel}} 已提交",
      siblingRepoBadge: "平级仓库",
      siblingRepoHint: "与当前仓库在同一文件夹下的仓库，不是它的子目录。",
      pushDialogTitle: "推送",
      pushDialogSubtitle: "把每个仓库的提交推送到它自己的远端。",
      pushAll: "全部推送",
      pushSelected: "推送所选",
      pushing: "推送中…",
      pushed: "已推送",
      pushedRepos: "已推送 {{count}} 个仓库",
      pushPartial: "已推送 {{ok}} / {{total}} 个仓库",
      pushNoUpstream: "无上游分支",
      pushNoRemote: "没有可推送的远端",
      pushUpToDate: "已是最新",
      pushNothingToPush: "没有可推送的内容：所有仓库都是最新的。",
      pushDialogHint: "只推送勾选的仓库，其中一个失败不会阻止其他仓库。",
      pushRowPushed: "{{branch}} → {{remote}}/{{branch}}",
      relativeJustNow: "刚刚",
      relativeMinutesAgo: "{{count}} 分钟前",
      relativeHoursAgo: "{{count}} 小时前",
      relativeDaysAgo: "{{count}} 天前",
    },
  };

  const state = { locale: "en", theme: "dark" };

  function resolveLocale(raw) {
    const value = String(raw ?? "").replace("_", "-").toLowerCase();
    if (value.startsWith("zh")) return "zh-CN";
    return "en";
  }

  state.locale = resolveLocale(navigator.language);

  /** Look up IDEA's wording for the active locale, falling back to English. */
  function t(key) {
    const table = STRINGS[state.locale] ?? STRINGS.en;
    return table[key] ?? STRINGS.en[key] ?? key;
  }

  /**
   * Same lookup, with `{{name}}` placeholders filled in. Whole sentences belong
   * in one key: gluing a translation together from fragments is how you get
   * grammar that reads like a machine wrote it.
   */
  function tf(key, vars) {
    return t(key).replace(/\{\{(\w+)\}\}/g, (match, name) => (
      vars && vars[name] !== undefined ? String(vars[name]) : match
    ));
  }

  // -------------------------------------------------------------- bridge ---
  /** Every host call goes through here so a failure is data, never a throw. */
  async function invoke(channel, payload) {
    if (!bridge?.invoke) {
      // Dev-only path (outside PI-Desktop): reuse an existing host-state key
      // rather than a hardcoded English fallback so user copy stays in t().
      return { ok: false, message: t("noWorkspace") };
    }
    try {
      const result = await bridge.invoke(channel, payload ?? {});
      if (!result || typeof result !== "object") {
        // Keep the channel for diagnosis; the prefix is an existing key.
        return { ok: false, message: `${t("gitOutput")}: ${channel}` };
      }
      return result;
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  }

  async function copyText(text) {
    const result = await invoke("clipboard.writeText", { text: String(text ?? "") });
    // Reuse the existing action key; the error level already says it failed.
    toast(result.ok ? t("copied") : result.message ?? t("copy"), result.ok ? "info" : "error");
  }

  // --------------------------------------------------------------- dom ----
  // No `html:` branch: innerHTML with user content is an XSS sink. Build with
  // `text` and element children instead; only static templates may use
  // innerHTML at their own call site, never through h(). Zero `html:` callers.
  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value === true) node.setAttribute(key, "");
        else node.setAttribute(key, String(value));
      }
    }
    for (const child of children ?? []) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Icons are built from primitives rather than opaque path blobs so they stay
  // editable; each entry is a list of [tagName, attributes] children.
  const ICONS = {
    refresh: [["path", { d: "M12.6 8.4a4.6 4.6 0 1 1-1.4-3.4" }], ["path", { d: "M12.6 3.4v2.6h-2.6" }]],
    fetch: [["path", { d: "M8 2.6v7.4" }], ["path", { d: "M5 7.2 8 10.2l3-3" }], ["path", { d: "M3 13.2h10" }]],
    push: [["path", { d: "M8 13.4V6" }], ["path", { d: "M5 8.8 8 5.8l3 3" }], ["path", { d: "M3 2.8h10" }]],
    commit: [["circle", { cx: 8, cy: 8, r: 3.1 }], ["path", { d: "M1.6 8h3.3M11.1 8h3.3" }]],
    branch: [["circle", { cx: 4, cy: 3.6, r: 1.6 }], ["circle", { cx: 4, cy: 12.4, r: 1.6 }], ["circle", { cx: 12, cy: 6.6, r: 1.6 }], ["path", { d: "M4 5.2v5.6" }], ["path", { d: "M4 8.4h4a3.4 3.4 0 0 0 3.4-3.4v-.2" }]],
    rollback: [["path", { d: "M3.4 8.4a4.6 4.6 0 1 0 1.4-3.4" }], ["path", { d: "M3.4 3.4v2.6H6" }]],
    diff: [["rect", { x: 2, y: 2, width: 7.5, height: 12, rx: 1 }], ["path", { d: "M11 5.5h2.2A.8.8 0 0 1 14 6.3v6.4a.8.8 0 0 1-.8.8H11" }]],
    plus: [["path", { d: "M8 3.4v9.2M3.4 8h9.2" }]],
    minus: [["path", { d: "M3.4 8h9.2" }]],
    close: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
    check: [["path", { d: "M3.2 8.6l3.2 3.2 6.4-8" }]],
    gear: [["circle", { cx: 8, cy: 8, r: 2.2 }], ["path", { d: "M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" }]],
    search: [["circle", { cx: 7, cy: 7, r: 4.2 }], ["path", { d: "M10.2 10.2 14 14" }]],
    clock: [["circle", { cx: 8, cy: 8, r: 5.6 }], ["path", { d: "M8 4.6V8l2.6 1.8" }]],
    copy: [["rect", { x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 1.2 }], ["path", { d: "M10.6 5.4V3.6a1.2 1.2 0 0 0-1.2-1.2H3.6a1.2 1.2 0 0 0-1.2 1.2v5.8a1.2 1.2 0 0 0 1.2 1.2h1.8" }]],
    trash: [["path", { d: "M3 4.4h10" }], ["path", { d: "M6.4 4.4V3.2h3.2v1.2" }], ["path", { d: "M4.4 4.4l.6 8.4h6l.6-8.4" }]],
    folder: [["path", { d: "M2 4.4A1.4 1.4 0 0 1 3.4 3h2.4l1.4 1.8h5.4A1.4 1.4 0 0 1 14 6.2v5.4A1.4 1.4 0 0 1 12.6 13H3.4A1.4 1.4 0 0 1 2 11.6z" }]],
    file: [["path", { d: "M4 2h5l3 3v9H4z" }], ["path", { d: "M9 2v3h3" }]],
    list: [["path", { d: "M2.6 4h1.6M2.6 8h1.6M2.6 12h1.6" }], ["path", { d: "M7 4h6.4M7 8h6.4M7 12h6.4" }]],
    tag: [["path", { d: "M2.6 7.4 7.4 2.6h5.2a1 1 0 0 1 1 1v5.2l-4.8 4.8a1 1 0 0 1-1.4 0l-4.8-4.8a1 1 0 0 1 0-1.4z" }], ["circle", { cx: 10.6, cy: 5.4, r: 1 }]],
    external: [["path", { d: "M6.6 3.4H3.4v9.2h9.2V9.4" }], ["path", { d: "M9.4 2.6h4v4" }], ["path", { d: "M13.4 2.6 7.8 8.2" }]],
    columns: [["rect", { x: 2, y: 3, width: 12, height: 10, rx: 1 }], ["path", { d: "M8 3v10" }]],
    collapse: [["path", { d: "M4 6.4 8 2.6l4 3.8" }], ["path", { d: "M4 9.6 8 13.4l4-3.8" }]],
    eye: [["path", { d: "M1.8 8S4.2 4 8 4s6.2 4 6.2 4-2.4 4-6.2 4-6.2-4-6.2-4z" }], ["circle", { cx: 8, cy: 8, r: 1.7 }]],
    more: [["circle", { cx: 8, cy: 3.4, r: 1.1 }], ["circle", { cx: 8, cy: 8, r: 1.1 }], ["circle", { cx: 8, cy: 12.6, r: 1.1 }]],
    chevronRight: [["path", { d: "M6.4 3.6 10.8 8l-4.4 4.4" }]],
    chevronDown: [["path", { d: "M3.6 6.4 8 10.8l4.4-4.4" }]],
    arrowUp: [["path", { d: "M8 13V3.6" }], ["path", { d: "M4.8 6.8 8 3.6l3.2 3.2" }]],
    arrowDown: [["path", { d: "M8 3v9.4" }], ["path", { d: "M4.8 9.2 8 12.4l3.2-3.2" }]],
    warning: [["path", { d: "M8 2.4 14.4 13.6H1.6z" }], ["path", { d: "M8 6.2v3.4" }], ["circle", { cx: 8, cy: 11.6, r: 0.7 }]],
    // Two sparkles: the conventional mark for "let the model draft this".
    sparkles: [["path", { d: "M6.4 2.2 7.7 5.5l3.3 1.3-3.3 1.3L6.4 11.4 5.1 8.1 1.8 6.8l3.3-1.3z" }], ["path", { d: "M12.2 9.6l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" }]],
  };

  function icon(name, size) {
    const parts = ICONS[name] ?? ICONS.file;
    const svg = document.createElementNS(SVG_NS, "svg");
    const dimension = size ?? 16;
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", String(dimension));
    svg.setAttribute("height", String(dimension));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.35");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of parts) {
      const child = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, String(value));
      svg.append(child);
    }
    return svg;
  }

  /** A toolbar button with a tooltip, the IDEA affordance used everywhere. */
  function iconButton(name, title, onClick, options) {
    const button = h("button", {
      class: options?.class ?? "icon",
      type: "button",
      title: options?.shortcut ? `${title} (${options.shortcut})` : title,
      "aria-label": title,
      disabled: options?.disabled,
      onclick: onClick,
    }, [icon(name, options?.size)]);
    return button;
  }

  function textButton(label, title, onClick, options) {
    return h("button", {
      class: options?.class ?? "bordered",
      type: "button",
      title: title ?? label,
      disabled: options?.disabled,
      onclick: onClick,
    }, [label]);
  }

  // ----------------------------------------------------------- shortcuts ---
  /**
   * Keyboard support has to live in the page.
   *
   * The host runs the app's own shortcuts from the *main window's* renderer
   * (`window.addEventListener("keydown", …)`), and a plugin view is a separate
   * `WebContentsView` with its own webContents — so keys pressed while a view
   * has focus never reach the host's handler. Anything a button advertises,
   * therefore, has to be bound here. `format()` exists so a tooltip is derived
   * from the binding and can never advertise a key that does nothing.
   */
  const IS_MAC = /mac/i.test(navigator.userAgent);

  function shortcutKey(event) {
    const key = String(event.key ?? "");
    return key.length === 1 ? key.toLowerCase() : key;
  }

  function matchesShortcut(spec, event) {
    if (shortcutKey(event) !== shortcutKey({ key: spec.key })) return false;
    const primary = IS_MAC ? event.metaKey : event.ctrlKey;
    const secondary = IS_MAC ? event.ctrlKey : event.metaKey;
    if (spec.mod) {
      if (!primary || secondary) return false;
    } else if (spec.ctrl) {
      if (!event.ctrlKey) return false;
    } else if (spec.meta) {
      if (!event.metaKey) return false;
    } else if (primary || secondary) {
      return false;
    }
    if (Boolean(spec.alt) !== event.altKey) return false;
    if (Boolean(spec.shift) !== event.shiftKey) return false;
    return true;
  }

  /** "⌘R" on macOS, "Ctrl+R" elsewhere — the same string the tooltip gets. */
  function formatShortcut(spec) {
    const parts = [];
    if (spec.mod) parts.push(IS_MAC ? "⌘" : "Ctrl");
    if (spec.ctrl) parts.push(IS_MAC ? "⌃" : "Ctrl");
    if (spec.meta) parts.push(IS_MAC ? "⌘" : "Meta");
    if (spec.alt) parts.push(IS_MAC ? "⌥" : "Alt");
    if (spec.shift) parts.push(IS_MAC ? "⇧" : "Shift");
    const key = spec.key.length === 1 ? spec.key.toUpperCase() : spec.key;
    return IS_MAC && parts.length && parts[0].length === 1 ? parts.join("") + key : [...parts, key].join("+");
  }

  /**
   * The app's own accelerators are delivered to the *main window's* renderer, so
   * a focused plugin view never receives them — `⌘⇧P` (command palette) simply
   * does nothing here. Silence is the worst possible answer: it reads as a
   * broken key. Catching it and explaining where to go costs one binding and
   * turns a dead key into directions.
   */
  function appShortcutHintBinding() {
    return {
      spec: { key: "p", mod: true, shift: true },
      run: () => toast(t("appShortcutHint"), "info"),
    };
  }

  /**
   * Bind shortcuts for one surface. `bindings` is `[{ spec, run }]`; the first
   * match wins, and the event is consumed so it cannot double-fire.
   *
   * Typing must win over shortcuts: while focus is in an input/textarea/select
   * or contenteditable, non-Escape bindings are skipped so Ctrl+R etc. stay
   * text. Escape-class bindings still run so a menu or dialog can always close.
   */
  function bindShortcuts(bindings) {
    const handler = (event) => {
      if (event.defaultPrevented) return;
      const inField = Boolean(event.target?.closest?.("input, textarea, select, [contenteditable]"));
      for (const binding of bindings) {
        if (!matchesShortcut(binding.spec, event)) continue;
        const specKey = String(binding.spec?.key ?? "").toLowerCase();
        const isEscape = specKey === "escape" || specKey === "esc";
        if (inField && !isEscape) continue;
        event.preventDefault();
        event.stopPropagation();
        binding.run();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }

  // -------------------------------------------------------------- toasts ---
  let toastLayer = null;

  /**
   * A transient message. Returns the node so a caller can add to it — the sync
   * errors append a link to the full Git output.
   *
   * Long messages are the norm now (Git's own words, then a remedy), and error
   * toasts have to be read before they can be acted on, so they get longer.
   */
  function toast(message, level) {
    const text = String(message ?? "").trim();
    if (!text) return null;
    if (!toastLayer) {
      toastLayer = h("div", { class: "toast-layer" });
      document.body.append(toastLayer);
    }
    const important = level === "error";
    const node = h("div", { class: `toast ${important ? "error" : "info"}`, role: "status" }, [text]);
    toastLayer.append(node);
    window.setTimeout(() => node.remove(), important ? 12_000 : 3600);
    return node;
  }

  // -------------------------------------------------------------- popups ---
  let openPopup = null;

  function closePopup() {
    if (!openPopup) return;
    openPopup.remove();
    openPopup = null;
    document.removeEventListener("pointerdown", onPopupPointerDown, true);
    document.removeEventListener("keydown", onPopupKeyDown, true);
  }

  function onPopupPointerDown(event) {
    if (openPopup && !openPopup.contains(event.target)) closePopup();
  }

  function onPopupKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePopup();
    }
  }

  /**
   * Floating menu anchored to a control. `items` accepts
   * `{ label, shortcut, checked, disabled, onSelect }` entries as well as
   * `{ type: "label" | "separator" | "custom", ... }`.
   */
  function popup(anchor, items, options) {
    closePopup();
    // A missing anchor means the caller read `event.currentTarget` after an
    // await, where it is null. Complain loudly instead of appending a menu that
    // would never be tracked — and therefore never removed.
    if (!anchor || typeof anchor.getBoundingClientRect !== "function") {
      throw new Error("popup() needs a live anchor element; capture it before any await");
    }
    const menu = h("div", { class: "popup", role: "menu" });
    for (const item of items ?? []) {
      if (!item) continue;
      if (item.type === "separator") {
        menu.append(h("div", { class: "popup-separator" }));
        continue;
      }
      if (item.type === "label") {
        menu.append(h("div", { class: "popup-title", text: item.label }));
        continue;
      }
      if (item.type === "custom") {
        menu.append(item.node);
        continue;
      }
      menu.append(
        h("button", {
          type: "button",
          role: "menuitem",
          title: item.title ?? item.label,
          disabled: item.disabled,
          "data-checked": item.checked ? "true" : undefined,
          onclick: () => {
            closePopup();
            item.onSelect?.();
          },
        }, [h("span", { text: item.label }), item.shortcut ? h("span", { class: "shortcut", text: item.shortcut }) : null]),
      );
    }
    document.body.append(menu);
    openPopup = menu;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    const wantBelow = rect.bottom + 4;
    const top = wantBelow + height > window.innerHeight - 6
      ? Math.max(6, rect.top - height - 4)
      : wantBelow;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    if (options?.focus !== false) {
      const first = menu.querySelector("button:not([disabled]), input");
      first?.focus();
    }
    document.addEventListener("pointerdown", onPopupPointerDown, true);
    document.addEventListener("keydown", onPopupKeyDown, true);
    return menu;
  }

  // -------------------------------------------------------- repositories ---
  /**
   * The repository selector — IDEA's "Root" dropdown — for the left of a tool
   * window's toolbar.
   *
   * Submodules, and repositories that merely live inside another repository,
   * are separate Git repositories rather than folders. Every command is scoped
   * to a working directory, so a change inside a submodule cannot be staged,
   * diffed or committed from the parent: the parent can only record *which
   * commit* the submodule points at. Picking one here is what makes it
   * reachable at all.
   *
   * A single-repository project has nothing to choose between, so the chip
   * hides itself and the toolbar keeps the shape it has always had.
   */
  function mountRepoSelector(container, ctx) {
    const chip = h("button", { class: "branch-chip repo-chip", type: "button" });
    container.append(chip);
    let repos = [];

    /** Where the repository sits, relative to the workspace's own repository. */
    function repositoryLabel(entry) {
      if (!entry) return t("repository");
      return entry.rel === "." ? entry.name : entry.rel;
    }

    function kindText(entry) {
      if (entry.kind === "submodule") return t("submoduleBadge");
      if (entry.kind === "sibling") return t("siblingRepoBadge");
      return t("nestedRepoBadge");
    }

    function kindHint(entry) {
      if (entry.kind === "submodule") return t("submoduleBadge");
      if (entry.kind === "sibling") return t("siblingRepoHint");
      return t("nestedRepoHint");
    }

    function paint() {
      PIG.clear(chip);
      chip.style.display = repos.length > 1 ? "" : "none";
      if (repos.length < 2) return;
      const current = repos.find((entry) => entry.active) ?? repos[0];
      chip.append(icon("folder", 13));
      chip.append(h("span", { class: "name", text: repositoryLabel(current) }));
      if (current.kind !== "root") {
        chip.append(h("span", { class: "badge", text: kindText(current) }));
      }
      chip.title = `${t("switchRepository")} — ${current.root}`;
    }

    async function openMenu() {
      // Re-read on open, not only on refresh: a submodule can be added or
      // deinitialised in between, and a menu listing a repository that is no
      // longer there is worse than one extra Git call.
      const result = await invoke("git/repos");
      if (result?.ok) {
        repos = result.repos ?? [];
        paint();
      }
      popup(chip, [
        { type: "label", label: t("repositoryList") },
        ...repos.map((entry) => ({
          label: repositoryLabel(entry),
          title: entry.kind === "root"
            ? entry.root
            : `${entry.root} — ${kindHint(entry)}`,
          checked: entry.active,
          onSelect: async () => {
            if (entry.active) return;
            const switched = await invoke("git/select-repo", { root: entry.root });
            if (!switched?.ok) {
              toast(errorText(switched), "error");
              return;
            }
            // The chip does not wait for the view's reload to say where the tool
            // window points now: the answer to the switch is enough, and the
            // view's own state is the view's business.
            repos = repos.map((candidate) => ({
              ...candidate,
              active: candidate.root === switched.root,
            }));
            paint();
            ctx.onSwitch?.(switched);
          },
        })),
      ]);
    }

    chip.addEventListener("click", () => {
      openMenu().catch((error) => toast(String(error?.message ?? error), "error"));
    });

    return {
      /** Take the list from a `git/repos` answer. */
      update(result) {
        repos = result?.ok ? (result.repos ?? []) : [];
        paint();
      },
    };
  }

  // ------------------------------------------------------------- dialogs ---
  /** A small modal in the IDEA shape: message, then actions. */
  function dialog({ title, message, detail, confirmLabel, cancelLabel, danger, input }) {
    return new Promise((resolve) => {
      const field = input
        ? h("input", { type: "text", value: input.value ?? "", placeholder: input.placeholder ?? "" })
        : null;
      const backdrop = h("div", {
        style: {
          position: "fixed",
          inset: "0",
          zIndex: "80",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "color-mix(in oklab, #000 38%, transparent)",
        },
      });
      const close = (value) => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close(null);
        } else if (event.key === "Enter" && field) {
          event.stopPropagation();
          close(field.value);
        }
      };
      const confirm = h("button", {
        class: danger ? "primary" : "primary",
        type: "button",
        style: danger ? { background: "var(--status-conflict)", borderColor: "var(--status-conflict)" } : undefined,
        onclick: () => close(field ? field.value : true),
      }, [confirmLabel ?? t("ok")]);
      const panel = h("div", {
        class: "popup",
        role: "dialog",
        "aria-modal": "true",
        style: { position: "relative", minWidth: "280px", maxWidth: "420px", padding: "14px", boxShadow: "0 16px 48px rgba(0,0,0,.4)" },
      }, [
        h("div", { style: { fontWeight: "600", marginBottom: "6px" }, text: title ?? "" }),
        message ? h("div", { text: message }) : null,
        detail ? h("div", { class: "dialog-detail", text: detail }) : null,
        field,
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" } }, [
          // `cancelLabel: null` means "nothing to cancel" — a read-only dialog
          // (the full Git output) has one button, not two.
          cancelLabel === null
            ? null
            : h("button", { class: "bordered", type: "button", onclick: () => close(null) }, [cancelLabel ?? t("cancel")]),
          confirm,
        ]),
      ]);
      backdrop.append(panel);
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) close(null);
      });
      document.body.append(backdrop);
      document.addEventListener("keydown", onKey, true);
      (field ?? confirm).focus();
      if (field) field.select();
    });
  }
  // Note: 多仓 Push 对话框与两视图共用——按仓列出分支去向与 ahead，逐仓推送、单仓失败不挡其他仓；Commit and Push 复用同一逐仓推送 — 见 .agents/notes/implemented/architecture/2026-09-12-multi-repo-push.md
  /**
   * IDEA-style Push dialog: one row per repository (branch → remote,
   * ahead/behind, checkbox, per-row result). Pushes the checked rows one by
   * one via `git/push` with `repoRoot`, so no repository switch is needed.
   * Resolves with the per-repo outcomes (or null when closed without pushing).
   */
  async function openPushDialog(options = {}) {
    const loading = await invoke("git/push-statuses");
    if (!loading?.ok) {
      toast(errorText(loading), "error");
      return null;
    }
    const repos = (loading.repos ?? []).slice();
    if (!repos.length) {
      toast(t("notARepository"), "error");
      return null;
    }
    return new Promise((resolve) => {
      const checked = new Map();
      const outcomes = new Map();
      for (const entry of repos) {
        // Default to pushing what can be pushed; repos with no remote stay
        // unchecked but visible, so the reason is seen, not hidden.
        checked.set(entry.root, Boolean(entry.pushTarget));
      }
      const backdrop = h("div", {
        style: {
          position: "fixed",
          inset: "0",
          zIndex: "80",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "color-mix(in oklab, #000 38%, transparent)",
        },
      });
      const rowsHost = h("div", { class: "push-rows", style: { display: "flex", flexDirection: "column", gap: "6px", maxHeight: "320px", overflow: "auto", margin: "10px 0" } });
      const hint = h("div", { class: "muted", style: { fontSize: "11px" }, text: t("pushDialogHint") });
      const pushButton = h("button", { class: "primary", type: "button" }, [t("pushAll")]);
      const closeButton = h("button", { class: "bordered", type: "button" }, [t("close")]);
      let pushing = false;
      let pushedAny = false;
      const close = (value) => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!pushing) close(pushedAny ? [...outcomes.values()] : null);
        }
      };
      function branchText(entry) {
        const head = entry.branch?.head ?? "";
        if (!head) return entry.branch?.detached ? `detached @ ${String(entry.branch?.oid ?? "").slice(0, 8)}` : "";
        if (entry.pushTarget) return tf("pushRowPushed", { branch: head, remote: entry.pushTarget.remote });
        if (!entry.branch?.upstream) return `${head} · ${t("pushNoUpstream")}`;
        return `${head} → ${entry.branch.upstream}`;
      }
      function countsText(entry) {
        const ahead = entry.branch?.ahead ?? 0;
        const behind = entry.branch?.behind ?? 0;
        if (!ahead && !behind) return t("pushUpToDate");
        const parts = [];
        if (ahead) parts.push(`↑${ahead}`);
        if (behind) parts.push(`↓${behind}`);
        return parts.join(" ");
      }
      function paintRows() {
        clear(rowsHost);
        for (const entry of repos) {
          const outcome = outcomes.get(entry.root);
          const box = h("input", { type: "checkbox" });
          box.checked = checked.get(entry.root) === true;
          box.disabled = pushing || !entry.pushTarget;
          box.addEventListener("change", () => { checked.set(entry.root, box.checked); });
          const label = entry.rel === "." ? entry.name : entry.rel;
          const kind = entry.kind === "submodule" ? t("submoduleBadge") : entry.kind === "sibling" ? t("siblingRepoBadge") : entry.kind === "root" ? "" : t("nestedRepoBadge");
          const row = h("div", { class: "push-row", style: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "6px" } }, [
            box,
            h("div", { style: { flex: "1 1 auto", minWidth: "0" } }, [
              h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, [
                h("span", { style: { fontWeight: "600" }, text: label }),
                kind ? h("span", { class: "badge", text: kind }) : null,
                h("span", { class: "muted", style: { fontSize: "11px" }, text: countsText(entry) }),
              ]),
              h("div", { class: "muted", style: { fontSize: "11px" }, text: branchText(entry) }),
              entry.pushError && !entry.pushTarget ? h("div", { style: { fontSize: "11px", color: "var(--status-conflict)" }, text: entry.pushError }) : null,
              outcome ? h("div", { style: { fontSize: "11px", color: outcome.ok ? "var(--status-ok)" : "var(--status-conflict)" }, text: outcome.ok ? t("pushed") : errorText(outcome) }) : null,
            ]),
          ]);
          rowsHost.append(row);
        }
      }
      pushButton.onclick = async () => {
        if (pushing) return;
        const targets = repos.filter((entry) => checked.get(entry.root) && entry.pushTarget);
        if (!targets.length) {
          toast(t("pushNothingToPush"), "info");
          return;
        }
        pushing = true;
        pushButton.disabled = true;
        pushButton.textContent = t("pushing");
        paintRows();
        for (const entry of targets) {
          outcomes.set(entry.root, null);
          paintRows();
          const payload = {};
          // The active repo needs no override; every other row pushes by path.
          if (!entry.active) payload.repoRoot = entry.root;
          else payload.repoRoot = entry.root;
          if (!entry.branch?.upstream) payload.setUpstream = true;
          let result = null;
          try {
            result = await invoke("git/push", payload);
          } catch (error) {
            result = { ok: false, message: String(error?.message ?? error) };
          }
          outcomes.set(entry.root, { ...result, rel: entry.rel, root: entry.root });
          if (result?.ok) {
            pushedAny = true;
            try { await refreshTrackingRefs(result); } catch { /* keep pushing */ }
          }
          paintRows();
        }
        pushing = false;
        pushButton.disabled = false;
        pushButton.textContent = t("pushAll");
        paintRows();
        try { await options.onPushed?.([...outcomes.values()]); } catch { /* view refreshes anyway */ }
      };
      closeButton.onclick = () => { if (!pushing) close(pushedAny ? [...outcomes.values()] : null); };
      const panel = h("div", {
        class: "popup",
        role: "dialog",
        "aria-modal": "true",
        style: { position: "relative", minWidth: "340px", maxWidth: "520px", width: "min(520px, 92vw)", padding: "14px", boxShadow: "0 16px 48px rgba(0,0,0,.4)" },
      }, [
        h("div", { style: { fontWeight: "600", marginBottom: "2px" }, text: t("pushDialogTitle") }),
        h("div", { class: "muted", style: { fontSize: "11px" }, text: t("pushDialogSubtitle") }),
        rowsHost,
        hint,
        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" } }, [
          closeButton,
          pushButton,
        ]),
      ]);
      backdrop.append(panel);
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop && !pushing) close(pushedAny ? [...outcomes.values()] : null);
      });
      document.body.append(backdrop);
      document.addEventListener("keydown", onKey, true);
      paintRows();
      pushButton.focus();
    });
  }
  /** Push several repos with the same options shape as the dialog rows. */
  async function pushRepos(targets) {
    const outcomes = [];
    for (const target of targets ?? []) {
      const payload = {};
      if (target.root) payload.repoRoot = target.root;
      if (target.setUpstream) payload.setUpstream = true;
      let result = null;
      try {
        result = await invoke("git/push", payload);
      } catch (error) {
        result = { ok: false, message: String(error?.message ?? error) };
      }
      outcomes.push({ ...result, rel: target.rk ?? target.rel ?? "", root: target.root ?? null });
      if (result?.ok) {
        try { await refreshTrackingRefs(result); } catch { /* keep pushing */ }
      }
    }
    return outcomes;
  }

  /**
   * The message to show for a failed call: Git's own output plus, when the
   * engine recognised the failure, a line saying what to do about it.
   *
   * The recognised ones are the failures a user cannot guess their way out of:
   * credentials, and the two ways a push or a pull comes back refused. The
   * engine returns a code and never prose, so the wording lives here, in the
   * language the rest of the window is in.
   */
  function errorText(result) {
    const message = String(result?.message ?? "").trim();
    const remedy = remedyText(result);
    // Reuse an existing key; the caller already prefixes the action name.
    if (!remedy) return message || t("gitOutput");
    return message ? `${message}\n\n${remedy}` : remedy;
  }

  /** The classified remedy for a failed call, or "" when there is nothing to add. */
  function remedyText(result) {
    if (result?.authHint === "ssh") return t("authSsh");
    if (result?.authHint === "credentials") return t("authCredentials");
    if (result?.pushHint === "remote-ahead") return t("remoteAhead");
    if (result?.pushHint === "remote-rejected") return t("pushRejected");
    if (result?.pullHint === "diverged") return t("pullDiverged");
    if (result?.pullHint === "conflicts") return t("pullConflicts");
    return "";
  }

  /**
   * Report a fetch/pull/push.
   *
   * Two things made this its own function rather than a `toast` at each call
   * site. A successful push prints nothing on stdout — Git's summary goes to
   * stderr — so "show stdout if there is any" made pushing succeed silently.
   * And a refused push produces six lines of Git in a 340px toast, which is why
   * the error toast now carries a link to the whole of Git's output.
   */
  function reportSync(result, action) {
    if (result?.ok) {
      const line = String(result.stdout ?? "").split("\n").map((value) => value.trim()).find(Boolean);
      toast(line ? `${action}: ${line}` : action, "info");
      return true;
    }
    const node = toast(`${action}: ${errorText(result)}`, "error");
    if (node && result?.detail) {
      node.classList.add("clickable");
      node.append(h("button", {
        class: "toast-link",
        type: "button",
        onclick: () => dialog({
          title: t("gitOutput"),
          detail: result.detail,
          confirmLabel: t("close"),
          cancelLabel: null,
        }),
      }, [t("showDetail")]));
    }
    return false;
  }

  /**
   * A refused push means the remote moved on, so the ↑/↓ chip is stale by
   * definition: it is counting against a remote-tracking ref that predates the
   * refusal. Fetch before the view redraws, or the chip keeps claiming "1
   * outgoing, 0 incoming" right after Git said the opposite.
   *
   * A fetch that fails here is deliberately not reported: the refusal the user
   * has to act on is already on screen, and a second message about the refresh
   * would be noise on top of it. The consequence is only that the chip stays
   * stale, which is where it started.
   */
  async function refreshTrackingRefs(result) {
    if (result?.pushHint !== "remote-ahead") return result;
    // `invoke` resolves with `{ok:false}` rather than throwing, so there is
    // nothing to catch — the result is read and dropped on purpose.
    await invoke("git/fetch");
    return result;
  }


  // ------------------------------------------------------------ splitter ---
  /**
   * Drag handle for a two-pane layout. `apply(delta)` receives the pointer
   * delta in pixels so each caller decides what it resizes.
   */
  function bindSplitter(handle, apply, options) {
    let start = 0;
    let active = false;
    const onMove = (event) => {
      if (!active) return;
      const position = options?.vertical ? event.clientY : event.clientX;
      apply(position - start);
    };
    const onUp = () => {
      if (!active) return;
      active = false;
      handle.classList.remove("active");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
    };
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      active = true;
      start = options?.vertical ? event.clientY : event.clientX;
      handle.classList.add("active");
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // ---------------------------------------------------------- formatting ---
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  function relativeTime(timestamp, now) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const reference = Number.isFinite(now) ? now : Date.now();
    const delta = reference - timestamp;
    // Whole sentences live in STRINGS (see tf): no locale ternary here, and
    // the English plural suffix travels as `s` so zh templates simply ignore it.
    if (delta < 45 * 1000) return t("relativeJustNow");
    if (delta < HOUR) {
      const minutes = Math.max(1, Math.round(delta / MINUTE));
      return tf("relativeMinutesAgo", { count: minutes, s: minutes === 1 ? "" : "s" });
    }
    if (delta < DAY) {
      const hours = Math.round(delta / HOUR);
      return tf("relativeHoursAgo", { count: hours, s: hours === 1 ? "" : "s" });
    }
    if (delta < 30 * DAY) {
      const days = Math.round(delta / DAY);
      return tf("relativeDaysAgo", { count: days, s: days === 1 ? "" : "s" });
    }
    return formatDate(timestamp);
  }

  function formatDate(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function formatDateTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${formatDate(timestamp)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatClock(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /** Split a repo-relative path into a readable directory and base name. */
  function splitPath(filePath) {
    const normalised = String(filePath ?? "").replace(/\\/g, "/");
    const index = normalised.lastIndexOf("/");
    if (index < 0) return { name: normalised, directory: "" };
    return { name: normalised.slice(index + 1), directory: normalised.slice(0, index) };
  }

  function shellQuote(value) {
    const text = String(value ?? "");
    return /^[A-Za-z0-9._\-/]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
  }

  // ----------------------------------------------------------- appearance ---
  // Follow the app's own colour mode. Snapping to the OS palette instead made
  // the panel flash whenever the app and the OS disagreed.
  function applyAppearance(appearance) {
    if (typeof appearance?.locale === "string") state.locale = resolveLocale(appearance.locale);
    const base = appearance?.base;
    const resolved = base === "light" || base === "dark"
      ? base
      : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    state.theme = resolved;
    document.documentElement.dataset.theme = resolved;
    window.dispatchEvent(new CustomEvent("pig:appearance", { detail: { theme: resolved, locale: state.locale } }));
  }

  function watchAppearance() {
    bridge?.on?.("appearance:changed", applyAppearance);
    invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
  }

  /**
   * The host announces project switches on `workspace:changed`. A view that
   * ignored it would keep showing the previous project's repository — which is
   * exactly the bug this exists to prevent.
   *
   * TODO: workspace-stale window refactor is out of scope — a stale-window flag
   * with explicit loading state would beat this coalesce timer, but it touches
   * every refresh path, so it stays a timer for now.
   */
  function watchWorkspace(handler) {
    // `workspace:changed` can arrive in bursts (the host announces a project
    // switch as it settles), and each run costs a multi-process git refresh.
    // Run at most once per window, so the cost tracks elapsed time rather than
    // event count. The first event of a quiet period runs immediately — a switch
    // must not wait out a debounce while the view is still interactive — and a
    // burst collapses into a single catch-up run that renders the final state.
    const COALESCE_MS = 120;
    let lastRunAt = 0;
    let timer = null;
    const fire = () => {
      lastRunAt = Date.now();
      try {
        handler();
      } catch {
        // A failed reload must not take the view down with it.
      }
    };
    bridge?.on?.("workspace:changed", () => {
      if (timer !== null) return; // a catch-up run is already pending
      const since = Date.now() - lastRunAt;
      if (since >= COALESCE_MS) {
        fire();
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        fire();
      }, COALESCE_MS - since);
    });
  }

  // ---------------------------------------------------------------- store ---
  /** Minimal observable so views can re-render on change without a framework. */
  function createStore(initial) {
    let value = initial;
    const listeners = new Set();
    return {
      get: () => value,
      set(next) {
        value = typeof next === "function" ? next(value) : next;
        for (const listener of [...listeners]) listener(value);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  Object.assign(PIG, {
    state,
    t,
    tf,
    invoke,
    copyText,
    h,
    clear,
    icon,
    iconButton,
    textButton,
    toast,
    popup,
    closePopup,
    dialog,
    openPushDialog,
    pushRepos,
    bindSplitter,
    relativeTime,
    formatDate,
    formatDateTime,
    formatClock,
    splitPath,
    shellQuote,
    applyAppearance,
    watchAppearance,
    watchWorkspace,
    createStore,
    isMac: IS_MAC,
    formatShortcut,
    bindShortcuts,
    errorText,
    remedyText,
    reportSync,
    refreshTrackingRefs,
    appShortcutHintBinding,
    // Shared by both tool windows, so the two cannot disagree about which
    // repository they are showing — the same reason the branch chip is shared.
    repoSelector: { mount: mountRepoSelector },
  });
})(window.PIG || (window.PIG = {}));
