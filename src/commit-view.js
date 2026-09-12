/**
 * The Commit tool window — IDEA's `Alt+0` surface.
 *
 * Shape, following the official layout: a changes area on top (Staged /
 * Unstaged / Unversioned Files with a checkbox per file), the diff of the
 * selected file below it, and the commit controls pinned to the bottom
 * (Commit Message, Amend, Commit, Commit and Push).
 *
 * The checkbox semantics are IDEA's own: a checkbox means "include in this
 * commit". With a real Git index behind it, checking a worktree change stages
 * it and unchecking a staged change unstages it, which is why partial commits
 * work exactly as they do in the IDE.
 */
(function (PIG) {
  "use strict";

  const { h, t, invoke, icon, iconButton, toast, popup, dialog, splitPath } = PIG;

  /**
   * IDEA's commit shortcuts, in the form this surface can honour. The tooltip is
   * rendered from the same spec that is bound, so the two cannot drift apart.
   */
  const KEYS = {
    refresh: { key: "r", mod: true },
    refreshAlt: { key: "F5", ctrl: true },
    stage: { key: "a", mod: true, alt: true },
    rollback: { key: "z", mod: true, alt: true },
    showDiff: { key: "d", mod: true },
    commitMessage: { key: "k", mod: true },
  };

  function tip(key, spec) {
    return `${t(key)} (${PIG.formatShortcut(spec)})`;
  }

  const GROUPS = [
    { id: "conflicted", label: "conflicts", status: "U" },
    { id: "staged", label: "staged", status: "A" },
    { id: "unstaged", label: "unstaged", status: "M" },
    { id: "untracked", label: "unversioned", status: "?" },
  ];

  /**
   * The banner line for an unfinished operation, by the name the engine reports.
   * Only these four can be in progress: they are the ones `git/sequencer` accepts.
   */
  const OPERATION_KEYS = {
    merge: "mergeInProgress",
    rebase: "rebaseInProgress",
    "cherry-pick": "cherryPickInProgress",
    revert: "revertInProgress",
  };

  const STATUS_VARS = {
    A: "added", M: "modified", D: "deleted", R: "renamed", C: "renamed",
    T: "modified", "?": "unversioned", U: "conflict", "!": "ignored",
  };

  /**
   * Which language a drafted message is written in. A standing choice rather
   * than something the model infers: an English history used to mean English
   * drafts, however Chinese the person reading them was.
   */
  const LANGUAGES = [
    { value: "auto", label: "langAuto" },
    { value: "zh", label: "langChinese" },
    { value: "en", label: "langEnglish" },
  ];

  function languageLabel(value) {
    const option = LANGUAGES.find((row) => row.value === (value ?? "auto")) ?? LANGUAGES[0];
    return t(option.label);
  }
  function statusColor(code) {
    const key = STATUS_VARS[String(code ?? "").charAt(0)] ?? "modified";
    return `var(--status-${key})`;
  }

  /**
   * Git reports paths relative to the repository root, while the host's `fs`
   * channels are scoped to the workspace and resolve relative to it. When the
   * two roots differ the path has to be re-based, and when the file falls
   * outside the workspace the action simply is not offered.
   */
  function workspaceRelative(filePath, repo) {
    if (!filePath) return null;
    // The engine already worked out where the repository sits inside the
    // workspace, as real paths — the two roots can name the same directory with
    // and without a symlinked prefix (`/private/var` against `/var` on macOS),
    // and comparing those two strings here would decide the file is outside the
    // workspace.
    const prefix = repo?.repo?.workspacePrefix;
    if (typeof prefix === "string") {
      return prefix === "." ? filePath : `${prefix}/${filePath}`;
    }
    const root = String(repo?.repo?.root ?? "").replace(/[/\\]+$/, "");
    const workspace = String(repo?.repo?.workspace ?? "").replace(/[/\\]+$/, "");
    if (!root || !workspace || root === workspace) return filePath || null;
    if (root.startsWith(`${workspace}/`) || root.startsWith(`${workspace}\\`)) {
      return `${root.slice(workspace.length + 1)}/${filePath}`;
    }
    if (workspace.startsWith(`${root}/`) || workspace.startsWith(`${root}\\`)) {
      const inner = workspace.slice(root.length + 1);
      if (filePath === inner) return null;
      if (!filePath.startsWith(`${inner}/`)) return null;
      return filePath.slice(inner.length + 1);
    }
    return null;
  }

  // --------------------------------------------------------- change tree ---
  /**
   * The change lists arrive flat and repository-relative — the file name, with
   * its directory demoted to a grey tail the column is usually too narrow to
   * show. Rebuilding those paths as a tree is what answers "which folder does
   * this belong to" without the user having to read a path at all.
   *
   * The tree is per change list (Staged / Unstaged / Unversioned) rather than
   * across all of them: one file can sit in two lists at once, and a folder's
   * checkbox could not then mean one thing.
   */
  function buildChangeTree(files) {
    const root = { name: "", path: "", dirs: new Map(), files: [], total: 0 };
    for (const file of files ?? []) {
      const parts = String(file.path ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
      const name = parts.pop();
      if (!name) continue;
      let node = root;
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        let child = node.dirs.get(part);
        if (!child) {
          child = { name: part, path: prefix, dirs: new Map(), files: [], total: 0 };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.push(file);
    }
    annotate(root);
    return root;
  }

  /** File totals per subtree, so a folder row can say how much it covers. */
  function annotate(node) {
    let total = node.files.length;
    for (const child of node.dirs.values()) total += annotate(child);
    node.total = total;
    return total;
  }

  /** Every file below a directory, its own first. Drives the cascade. */
  function filesUnder(node, out = []) {
    for (const file of node.files) out.push(file);
    for (const child of node.dirs.values()) filesUnder(child, out);
    return out;
  }

  /** Directories before files, both in IDEA's case-insensitive natural order. */
  function treeEntries(node) {
    const dirs = [...node.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }))
      .map((dir) => ({ kind: "dir", dir }));
    const files = [...node.files]
      .sort((a, b) => splitPath(a.path).name.localeCompare(splitPath(b.path).name, undefined, { sensitivity: "base", numeric: true }))
      .map((file) => ({ kind: "file", file }));
    return [...dirs, ...files];
  }

  /**
   * IDEA's "Compact Middle Directories": a chain of folders whose parents hold
   * nothing else is drawn as one row, `src/main/java` instead of three.
   */
  function compactDir(dir, enabled) {
    let node = dir;
    let label = dir.name;
    while (enabled && node.files.length === 0 && node.dirs.size === 1) {
      [node] = node.dirs.values();
      label += `/${node.name}`;
    }
    return { label, node };
  }

  // ------------------------------------------------------------ branches ---
  /**
   * The branch widget IDEA puts in the status bar: current branch, ahead and
   * behind counts, and a popup with the branch actions. Shared by both tool
   * windows so the two never disagree about the repository.
   */
  function mountBranchWidget(container, ctx) {
    const chip = h("button", { class: "branch-chip", type: "button" });
    container.append(chip);
    let repo = null;

    function paint() {
      PIG.clear(chip);
      chip.append(icon("branch", 13));
      const branch = repo?.branch;
      // With no repository there is no branch to name, and "HEAD" would be a
      // lie. Say nothing and let the empty state explain.
      if (!repo) {
        chip.append(h("span", { class: "name muted", text: "—" }));
        chip.title = t("notARepository");
        return;
      }
      const name = branch?.head ?? (branch?.detached ? `detached @ ${String(branch?.oid ?? "").slice(0, 8)}` : t("head"));
      chip.append(h("span", { class: "name", text: name }));
      if (branch?.ahead || branch?.behind) {
        const tracking = h("span", { class: "tracking" });
        if (branch.ahead) {
          tracking.append(h("span", { class: "ahead", title: `${branch.ahead} outgoing` }, [`↑${branch.ahead}`]));
        }
        if (branch.behind) {
          tracking.append(h("span", { class: "behind", title: `${branch.behind} incoming` }, [`↓${branch.behind}`]));
        }
        chip.append(tracking);
      }
      chip.title = branch?.upstream
        ? `${name} → ${branch.upstream}`
        : `${name} — no upstream`;
    }

    async function openMenu() {
      const result = await invoke("git/branches");
      const branches = result.branches ?? [];
      const locals = branches.filter((branch) => !branch.remote);
      const remotes = branches.filter((branch) => branch.remote);
      const branch = repo?.branch;

      const items = [
        { type: "label", label: t("localBranches") },
        ...locals.map((entry) => ({
          label: entry.current ? `${entry.name}  ●` : entry.name,
          title: entry.subject,
          onSelect: async () => {
            if (entry.current) return;
            const checkedOut = await invoke("git/checkout", { name: entry.name });
            report(checkedOut, `${t("checkout")}: ${entry.name}`);
            ctx.onChanged?.();
          },
        })),
      ];
      if (remotes.length) {
        items.push({ type: "separator" });
        items.push({ type: "label", label: t("remoteBranches") });
        for (const entry of remotes.slice(0, 40)) {
          items.push({
            label: entry.name,
            title: entry.subject,
            onSelect: async () => {
              const checkedOut = await invoke("git/checkout", { name: entry.name, startPoint: entry.name });
              report(checkedOut, `${t("checkout")}: ${entry.name}`);
              ctx.onChanged?.();
            },
          });
        }
      }
      items.push({ type: "separator" });
      items.push({
        label: t("newBranch"),
        onSelect: async () => {
          const name = await dialog({
            title: t("newBranch"),
            message: t("newBranch"),
            input: { value: "", placeholder: "feature/…" },
            confirmLabel: t("newBranch"),
          });
          if (!name) return;
          const created = await invoke("git/checkout", { name, create: true });
          report(created, `${t("newBranch")}: ${name}`);
          ctx.onChanged?.();
        },
      });
      items.push({ type: "separator" });
      items.push({
        label: t("fetch"),
        onSelect: async () => {
          report(await invoke("git/fetch"), t("fetch"));
          ctx.onChanged?.();
        },
      });
      items.push({
        label: t("pull"),
        onSelect: async () => {
          const result = await invoke("git/pull");
          report(result, t("pull"));
          ctx.onChanged?.();
        },
      });
      items.push({
        label: t("push"),
        onSelect: async () => {
          // No remote/branch: the engine pushes where the branch actually
          // tracks. Sending `origin` plus the local name pushed a new branch to
          // `origin` for anything tracking elsewhere, while the ↑/↓ chip kept
          // counting against the real upstream.
          const result = await invoke("git/push", { setUpstream: !branch?.upstream });
          report(result, t("push"));
          // A refusal means the remote moved on, so the chip is stale exactly
          // when it matters most.
          await PIG.refreshTrackingRefs(result);
          ctx.onChanged?.();
        },
      });
      items.push({
        label: t("forcePush"),
        // A lease needs a baseline to compare against, so it is only offered
        // once the branch has an upstream at all.
        disabled: !branch?.upstream,
        onSelect: async () => {
          const confirmed = await dialog({
            title: t("forcePushTitle"),
            message: PIG.tf("forcePushBody", {
              // The remote and the branch it holds: `{{branch}}` is the local
              // name, because "origin/feature/x on origin" says it twice.
              branch: branch?.head ?? "",
              remote: String(branch?.upstream ?? "").split("/")[0],
            }),
            confirmLabel: t("forcePush"),
            danger: true,
          });
          if (confirmed === null) return;
          const result = await invoke("git/push", { forceWithLease: true });
          report(result, t("forcePush"));
          await PIG.refreshTrackingRefs(result);
          ctx.onChanged?.();
        },
      });
      items.push({ type: "separator" });
      items.push({
        label: t("stashChanges"),
        disabled: !repo || (!repo.staged.length && !repo.unstaged.length && !repo.untracked.length),
        onSelect: async () => {
          const message = await dialog({
            title: t("stashChanges"),
            message: t("stashMessage"),
            input: { value: "" },
            confirmLabel: t("stash"),
          });
          if (message === null) return;
          report(await invoke("git/stash", { action: "push", message }), t("stash"));
          ctx.onChanged?.();
        },
      });
      const stashes = repo?.stashes ?? [];
      if (stashes.length) {
        items.push({ type: "label", label: t("stash") });
        for (const stash of stashes.slice(0, 10)) {
          items.push({
            label: `${stash.ref}  ${stash.subject ?? ""}`.trim(),
            onSelect: async () => {
              report(await invoke("git/stash", { action: "pop", ref: stash.ref }), t("unstash"));
              ctx.onChanged?.();
            },
          });
        }
      }
      popup(chip, items);
    }

    chip.addEventListener("click", openMenu);

    async function loadRepo() {
      const result = await invoke("git/repo");
      if (result.ok) {
        repo = result;
        paint();
      }
    }

    return {
      update(nextRepo) {
        repo = nextRepo;
        paint();
      },
      refresh: loadRepo,
    };
  }

  /**
   * The one report path for both tool windows. `PIG.reportSync` keeps the
   * boolean contract this file has always used at its call sites, so a caller
   * can still write `if (report(...)) await refresh()`.
   */
  function report(result, action) {
    return PIG.reportSync(result, action);
  }

  function firstLine(value) {
    return String(value ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  }

  // ---------------------------------------------------------- commit view ---
  function mount(root, options) {
     const state = {
       repo: null,
       error: null,
       busy: false,
       selection: null,
       diff: null,
       diffUnified: true,
       showWhitespaces: false,
       showLineNumbers: false,
       ignoreWhitespace: false,
       message: "",
       amend: false,
       signoff: false,
       messages: [],
       // Both keyed by group, because collapsing `src/` in Unversioned must not
       // collapse it in Unstaged too.
       collapsed: new Set(),
       filter: "",
       // IDEA's view options for the changes tree, persisted with the rest.
       groupByDirectory: true,
       compactDirs: true,
       changesWidth: 45,
       generating: false,
       commitModelKey: "",
       // Empty means `auto`; the plugin resolves it against the repository.
       commitLang: "",
      // Aggregated submodule statuses (IDEA-like): each entry is
      // `{ rel, root, name, kind, status }` where `status` is a `readStatus`
      // result for that submodule. The parent's `git status` only prints one
      // gitlink line per submodule, so without this the files changed inside
      // `backend` are invisible while the selector points at the parent.
      // In sibling mode the same slots hold the other sibling repos.
      submodules: [],
      subLoading: false,
      // Last `git/repos` answer: decides whether the toolbar Push opens the
      // multi-repo dialog instead of pushing the current repo directly.
      allRepos: [],
     };

    // The repository chip comes first, as it does in IDEA: which repository —
    // and only then which branch of it.
    const repoHolder = h("div", { style: { display: "contents" } });
    const branchHolder = h("div", { style: { display: "contents" } });
    const toolbar = h("div", { class: "toolbar" });
    const changesList = h("div", { class: "scroll list" });
    const diffHost = h("div", { class: "diff" });
    const diffHeader = h("div", { class: "pane-header" });
    const messageInput = h("textarea", {
      placeholder: t("commitMessage"),
      spellcheck: "false",
      oninput: (event) => { state.message = event.target.value; paintCommit(); },
    });
    const amendBox = h("input", { type: "checkbox", onchange: (event) => { state.amend = event.target.checked; paintCommit(); } });
    const signoffBox = h("input", { type: "checkbox", onchange: (event) => { state.signoff = event.target.checked; } });
    const summary = h("span", { class: "commit-summary" });
    const commitButton = h("button", { class: "primary", type: "button", text: t("commit"), onclick: () => commit(false) });
    // A bordered (not primary) menu half keeps the split button readable while
    // the Commit half is disabled for a missing message.
    const commitMenuButton = h("button", { class: "bordered icon", type: "button", "aria-label": t("commitAndPush"), title: t("commitAndPush"), onclick: openCommitMenu }, [icon("chevronDown", 13)]);
    // Drafting a message takes a round trip, so the control reports its own
    // state rather than leaving the click looking ignored.
    const generateButton = h("button", {
      class: "bordered",
      type: "button",
      onclick: () => { generate().catch(() => {}); },
    }, [icon("sparkles", 13), h("span", { class: "gen-label", text: t("generateMessage") })]);
    const generateMenuButton = h("button", {
      class: "bordered icon",
      type: "button",
      "aria-label": t("generateOptions"),
      // The element is captured here on purpose: `event.currentTarget` is dead
      // by the time the model list has been fetched.
      onclick: (event) => { openGenerateMenu(event.currentTarget).catch(() => {}); },
    }, [icon("chevronDown", 12)]);
    const generateGroup = h("div", { class: "split-button" }, [generateButton, generateMenuButton]);

    const changesHeader = h("div", { class: "pane-header" });

    const changesWidth = h("div", { class: "commit-changes column" });
    const diffColumn = h("div", { class: "commit-diff column" });
    const divider = h("div", { class: "divider-v draggable", title: "" });

    /**
     * The repository this window is showing, as the repository list names it:
     * "." is the workspace's own, anything else sits inside it.
     */
    function repositoryLabel() {
      const entry = state.repo?.repo;
      if (!entry) return "";
      return entry.rel && entry.rel !== "." ? entry.rel : entry.name;
    }
     /**
      * Aggregated-view contexts: the current repo is ".", each dirty submodule
      * is its `rel` (e.g. "backend"). A context carries the absolute root helm
      * actions at, plus the repo object `workspaceRelative` needs for open/reveal.
      */
     function rootCtx() {
       return {
         rk: ".",
         root: state.repo?.repo?.root ?? null,
         label: repositoryLabel(),
         repoObj: state.repo ?? null,
         status: state.repo ?? null,
         kind: "root",
         branch: state.repo?.branch ?? null,
       };
     }
     function subCtx(entry) {
       return {
         rk: entry.rel,
         root: entry.root,
         label: entry.rel,
         repoObj: { repo: entry.status?.repo ?? { root: entry.root } },
         status: entry.status,
         kind: entry.kind ?? "submodule",
         branch: entry.status?.branch ?? null,
       };
     }
     function allCtxs() {
       const out = [];
       if (state.repo) out.push(rootCtx());
       for (const entry of state.submodules ?? []) out.push(subCtx(entry));
       return out;
     }
     function branchNameOf(branch) {
       if (!branch) return "";
       if (branch.head) return branch.head;
       if (branch.detached) return `detached @ ${String(branch.oid ?? "").slice(0, 8)}`;
       return "";
     }
     function countsOf(status) {
       if (!status) return { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
       return {
         staged: status.staged?.length ?? 0,
         unstaged: status.unstaged?.length ?? 0,
         untracked: status.untracked?.length ?? 0,
         conflicted: status.conflicted?.length ?? 0,
       };
     }
     function totalCounts() {
       const total = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
       for (const ctx of allCtxs()) {
         const counts = countsOf(ctx.status);
         total.staged += counts.staged;
         total.unstaged += counts.unstaged;
         total.untracked += counts.untracked;
         total.conflicted += counts.conflicted;
       }
       return total;
     }
     /** Repos with staged files, submodules first so the parent pointer lands last. */
     function stagedTargets() {
       const targets = [];
       for (const entry of state.submodules ?? []) {
         if ((entry.status?.staged?.length ?? 0) > 0) targets.push(subCtx(entry));
       }
       if ((state.repo?.staged?.length ?? 0) > 0) targets.push(rootCtx());
       return targets;
     }
     async function switchToSubmodule(root) {
       const switched = await invoke("git/select-repo", { root });
       if (!switched?.ok) {
         toast(PIG.errorText(switched), "error");
         return;
       }
       forgoRepositoryState();
       paintAll();
       loadRepositories().then(() => refresh()).catch(() => {});
     }

    let branchWidget = null;
    let repoWidget = null;

    // --------------------------------------------------------- rendering --
    function paintToolbar() {
      PIG.clear(toolbar);
      toolbar.append(repoHolder);
      toolbar.append(branchHolder);
      toolbar.append(h("div", { class: "toolbar-separator" }));
      toolbar.append(iconButton("refresh", tip("refresh", KEYS.refresh), () => refresh()));
      toolbar.append(iconButton("fetch", t("fetch"), async () => {
        const result = await invoke("git/fetch");
        if (report(result, t("fetch"))) await refresh();
      }));
      toolbar.append(iconButton("push", t("push"), async () => {
        // Note: 多仓走 Push 对话框（逐仓列出去向与结果），单仓保持直推 — 见 .agents/notes/implemented/architecture/2026-09-12-multi-repo-push.md
        const multi = (state.allRepos?.length ?? 0) > 1 || (state.submodules?.length ?? 0) > 0;
        if (multi) {
          await PIG.openPushDialog({ onPushed: async () => { await refresh(); } });
          await refresh();
          return;
        }
        // The engine resolves the target from the branch's own upstream; see
        // the push item in the branch menu.
        const result = await invoke("git/push", { setUpstream: !state.repo?.branch?.upstream });
        report(result, t("push"));
        await PIG.refreshTrackingRefs(result);
        await refresh();
      }));
      toolbar.append(h("div", { class: "toolbar-separator" }));
      toolbar.append(iconButton("plus", tip("stageFile", KEYS.stage), () => stageSelected(true), { disabled: !canStageSelected() }));
      toolbar.append(iconButton("minus", t("unstageFile"), () => stageSelected(false), { disabled: !canUnstageSelected() }));
      toolbar.append(iconButton("rollback", tip("rollback", KEYS.rollback), rollbackSelected, { disabled: !state.selection }));
      toolbar.append(h("div", { class: "toolbar-spacer" }));
      toolbar.append(
        h("span", {
          style: { fontSize: "11px", color: "var(--fg-muted)" },
          // A nested repository is named by where it sits; its bare basename
          // would not say which one this window is showing.
          text: repositoryLabel(),
        }),
      );
    }

     function paintChangesHeader() {
       PIG.clear(changesHeader);
       const counts = totalCounts();
       const total = counts.staged + counts.unstaged + counts.untracked + counts.conflicted;
       changesHeader.append(h("span", { text: t("changes") }));
       changesHeader.append(h("span", { class: "muted", text: total ? `${total}` : "" }));
       if (state.subLoading) changesHeader.append(h("span", { class: "muted", text: "…" }));
      changesHeader.append(h("div", { class: "toolbar-spacer" }));
      // IDEA puts this search in the changes pane's own title bar: typing is how
      // you find one file among seventy-four, and the tree below narrows to the
      // matches while keeping their folders.
      const field = h("input", {
        type: "search",
        class: "changes-filter",
        value: state.filter,
        placeholder: t("filterChanges"),
        title: t("filterChanges"),
        oninput: (event) => { state.filter = event.target.value; paintChanges(); },
        onkeydown: (event) => {
          if (event.key !== "Escape" || !state.filter) return;
          event.stopPropagation();
          state.filter = "";
          paintChanges();
        },
      });
      changesHeader.append(h("span", { class: "search-field" }, [icon("search", 12), field]));
      changesHeader.append(iconButton("gear", t("viewOptions"), (event) => {
        popup(event.currentTarget, [
          { type: "label", label: t("viewOptions") },
          { label: t("groupByDirectory"), checked: state.groupByDirectory, onSelect: () => setViewOption("groupByDirectory", !state.groupByDirectory) },
          // Only meaningful inside a folder tree.
          { label: t("compactMiddleDirs"), checked: state.compactDirs, disabled: !state.groupByDirectory, onSelect: () => setViewOption("compactDirs", !state.compactDirs) },
          { type: "separator" },
          { label: t("collapseAll"), onSelect: () => { collapseAll(); } },
          { type: "separator" },
          { label: t("stageAllChanges"), onSelect: () => setAllInclusion(true) },
          { label: t("unstageAllChanges"), onSelect: () => setAllInclusion(false) },
        ]);
      }, { size: 13 }));
    }

    function setViewOption(key, value) {
      state[key] = value;
      savePrefs();
      paintChanges();
    }

    /** Collapse every group, repository and folder — IDEA's "Collapse All". */
    function collapseAll() {
      for (const group of GROUPS) state.collapsed.add(`group:${group.id}`);
      for (const ctx of allCtxs()) {
        for (const group of GROUPS) state.collapsed.add(`repo:${group.id}:${ctx.rk}`);
      }
      for (const ctx of allCtxs()) {
        for (const group of GROUPS) {
          for (const file of ctx.status?.[group.id] ?? []) {
            const parts = file.path.split("/");
            parts.pop();
            let prefix = "";
            for (const part of parts) {
              prefix = prefix ? `${prefix}/${part}` : part;
              state.collapsed.add(dirKey(ctx.rk, group.id, prefix));
            }
          }
        }
      }
      paintChanges();
    }

     /**
      * Stage (or unstage) every visible file across the current repo and all
      * aggregated submodules. This fills the view-options menu entries that
      * previously called a function that did not exist.
      */
     async function setAllInclusion(target) {
       const jobs = [];
       const filter = state.filter.trim().toLowerCase();
       for (const ctx of allCtxs()) {
         const want = target ? "staged" : "worktree";
         const paths = [];
         for (const group of GROUPS) {
           if (group.id === "conflicted") continue;
           for (const file of ctx.status?.[group.id] ?? []) {
             if (filter && !file.path.toLowerCase().includes(filter)) continue;
             const stateName = group.id === "staged" ? "staged" : "worktree";
             if (stateName === want) continue;
             paths.push(file.path);
           }
         }
         if (!paths.length) continue;
         const payload = { paths };
         if (ctx.root) payload.repoRoot = ctx.root;
         jobs.push(invoke(target ? "git/stage" : "git/unstage", payload));
       }
       if (!jobs.length) return;
       const results = await Promise.all(jobs);
       const failed = results.find((result) => !result?.ok);
       if (failed) toast(PIG.errorText(failed), "error");
       await refresh();
     }

    /**
     * One checkbox for a set of files. Folder rows pass every file beneath them,
     * which is the cascade: one click includes or excludes a whole subtree.
     *
     * Deliberately binary — no tri-state dash. A dash would mean "partially
     * selected", and that state cannot exist here: a row's group *is* its staged
     * state (Staged ⇔ in the index), so checking any file moves it to the other
     * group rather than leaving a half-checked folder behind. Drawing a dash
     * anyway would be a claim the user could not reconcile with the list. A file
     * that genuinely is half in the index (`MM`: staged, with further unstaged
     * changes) says so with a badge on its own row.
     */
    function rowCheckbox({ checked, title, onToggle }) {
      const box = h("input", { type: "checkbox", title, onclick: (event) => event.stopPropagation() });
      box.checked = checked;
      box.addEventListener("change", async (event) => {
        const next = event.target.checked;
        event.target.disabled = true;
        try {
          await onToggle(next);
        } finally {
          event.target.disabled = false;
        }
      });
      return box;
    }

    /**
     * The checkbox is IDEA's "include into commit", which with a real index
     * behind it means: selected = staged. Reaching `target` therefore means
     * staging what is not in the commit yet and unstaging what is in it and
     * should not be — and leaving alone whatever already matches, because a
     * no-op `git add` still costs a process.
     */
     function applyInclusion(files, target, ctx) {
       const want = target ? "staged" : "worktree";
       const paths = files.filter((file) => file.state !== want).map((file) => file.path);
       if (!paths.length) return Promise.resolve();
       const payload = { paths };
       if (ctx?.root) payload.repoRoot = ctx.root;
       return invoke(target ? "git/stage" : "git/unstage", payload).then(async (result) => {
         if (!result.ok) {
           toast(PIG.errorText(result), "error");
           await refresh();
           return;
         }
         // A folder can hold a submodule. Staging one records the commit it
         // points at and anything dirty inside it stays dirty, so the row comes
         // back unselected even though the call succeeded. Say which of the two
         // happened rather than letting the checkbox look broken.
         // (Submodule inner files render as their own section now, so this
         // branch only fires for the parent's own gitlink row.)
         const stuck = target && (!ctx || ctx.rk === ".") ? files.filter((file) => file.insideSubmodule) : [];
         await refresh();
         if (!stuck.length) return;
         const staged = (state.repo?.staged ?? []).map((entry) => entry.path);
         if (stuck.some((file) => staged.includes(file.path))) toast(t("submoduleStagedHint"), "info");
         else toast(PIG.tf("submoduleInside", { path: stuck[0].path }), "error");
       });
     }

     function isSelected(rk, group, filePath) {
       const sel = state.selection;
       return Boolean(sel) && sel.rk === rk && sel.g === group && sel.p === filePath;
     }
     function fileRow(group, file, depth, fullPath, ctx) {
       const rk = ctx?.rk ?? ".";
       const selected = isSelected(rk, group, file.path);
       const { name } = splitPath(file.path);

       return h("div", {
         class: "tree-row",
         role: "option",
         tabindex: "0",
         "aria-selected": selected ? "true" : "false",
         title: ctx && ctx.rk !== "." ? `${ctx.rk}/${file.path}` : file.path,
         onclick: () => select({ rk, g: group, p: file.path, root: ctx?.root ?? null }),
         oncontextmenu: (event) => {
           event.preventDefault();
           select({ rk, g: group, p: file.path, root: ctx?.root ?? null });
           fileContextMenu(event.currentTarget, group, file, ctx);
         },
       }, [
         h("span", { class: "indent", style: { width: `${depth * 12}px` } }),
         rowCheckbox({
           checked: group === "staged",
           title: t("includeIntoCommit"),
           onToggle: (next) => applyInclusion([{ ...file, state: group === "staged" ? "staged" : "worktree" }], next, ctx),
         }),
         // Same slots as a folder row — disclosure, icon — so the two line up and
         // the status letter sits where a folder's arrow is. Without it every
         // file name would start to the left of the folder it lives in.
         h("span", { class: "indent", style: { width: "10px" } }),
         h("span", { class: "status-cell", style: { color: statusColor(file.status) }, text: file.status }),
         // The directory is the tree now. Repeating it as a grey tail answered
         // "which folder" worse than the hierarchy does, and the narrow column
         // clipped it anyway.
         h("span", { class: "name", style: { color: statusColor(file.status) }, text: name }),
         // No "partly staged" badge. A file with an index change *and* a further
         // worktree change already says so the only way Git says it: the same
         // path is listed here and in the other group, each row carrying its own
         // status letter. Naming that state separately would invent a concept
         // the user cannot see in `git status` or in any other Git client.
         // Inside the tree the folders already answered "where is this", so only
         // the Flat view repeats the path — and there it is essential, because
         // nothing else identifies the file. The column is narrow, so the tail
         // ellipsises and the tooltip keeps the whole path readable.
         fullPath && file.path !== name
           ? h("span", { class: "path", title: fullPath, text: fullPath })
           : null,
         // A submodule deserves a visible mark: its checkbox means something
         // different from every other row's.
         file.submodule
           ? h("span", { class: "badge", text: t("submoduleBadge"), title: submoduleTooltip(file) })
           : null,
       ]);
     }


    /** Why a submodule row behaves differently, in the user's language. */
    function submoduleTooltip(file) {
      if (file.insideSubmodule) return PIG.tf("submoduleInside", { path: file.path });
      return t("submoduleStagedHint");
    }

    /**
     * A folder row: a disclosure arrow, the folder, a count, and a checkbox
     * that reaches every file below it, nested folders included. Checking it
     * stages the whole subtree; unchecking it unstages the whole subtree. That
     * cascade is the interaction a flat list cannot offer.
     *
     * The checkbox stays binary, and its meaning is "everything under here is in
     * the commit": ticked in Staged, cleared in Unstaged. A file that is only
     * half in the index (`MM`) is flagged by the folder carrying a "partly
     * staged" badge rather than by a dash on the box — a dash would read as
     * "some of this folder is selected", which is a state this list cannot
     * represent, because a row's group *is* its staged state.
     */
     function dirKey(rk, group, dirPath) {
       return `dir:${rk}:${group}:${dirPath}`;
     }
     function dirRow(group, dir, depth, label, ctx) {
       const rk = ctx?.rk ?? ".";
       const files = filesUnder(dir);
       const total = files.length;
       const key = dirKey(rk, group, dir.path);
       const open = !state.collapsed.has(key);
       const action = group === "staged" ? t("unincludeFolder") : t("includeFolder");
       return h("div", {
         class: "tree-row dir-row",
         role: "treeitem",
         "aria-expanded": open ? "true" : "false",
         title: ctx && ctx.rk !== "." ? `${ctx.rk}/${dir.path}` : dir.path,
         onclick: () => {
           if (state.collapsed.has(key)) state.collapsed.delete(key);
           else state.collapsed.add(key);
           paintChanges();
         },
       }, [
         h("span", { class: "indent", style: { width: `${depth * 12}px` } }),
         rowCheckbox({
           checked: group === "staged",
           title: action,
           onToggle: (next) => applyInclusion(files, next, ctx),
         }),
         h("span", { class: "disclosure", "data-open": open ? "true" : "false" }, [icon("chevronRight", 11)]),
         h("span", { class: "row-icon" }, [icon("folder", 13)]),
         h("span", { class: "name", text: label }),
         h("span", { class: "count", text: `${total}` }),
       ]);
     }


     /** Depth-first render of one change list. Returns the rows, so the caller
         can append them in one pass. */
     function treeRows(group, node, depth, ctx) {
       const rows = [];
       const rk = ctx?.rk ?? ".";
       for (const entry of treeEntries(node)) {
         if (entry.kind === "file") {
           rows.push(fileRow(group, entry.file, depth, null, ctx));
           continue;
         }
         // A compacted row stands for a chain of folders, so it is the deepest
         // node in that chain that owns the expanded state and the children.
         const { label, node: target } = compactDir(entry.dir, state.compactDirs);
         rows.push(dirRow(group, target, depth, label, ctx));
         if (state.collapsed.has(dirKey(rk, group, target.path))) continue;
         rows.push(...treeRows(group, target, depth + 1, ctx));
       }
       return rows;
     }

     /**
      * The same change list without its folders: IDEA's Flat view. Files are
      * listed by full repository path, which is the whole point of leaving the
      * tree — nothing is identified by position any more.
      */
    function flatRows(group, files, ctx, depth) {
      return [...files]
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true }))
        .map((file) => fileRow(group, file, depth ?? 0, ctx && ctx.rk !== "." ? `${ctx.rk}/${file.path}` : file.path, ctx));
    }

    /**
     * IDEA's colored square per repository. Colors are dealt from the sorted
     * repo list with linear probing, so every visible repo gets a distinct
     * square while a repo keeps its color as long as the repo set is unchanged
     * (a plain hash collides too often with 5 repos on 8 colors).
     */
    const REPO_COLORS = ["#e5534b", "#3fb950", "#ab7df8", "#39c5cf", "#d29922", "#f778ba", "#4a86c8", "#d1743a"];

    function repoColorMap(ctxs) {
      const sorted = [...ctxs].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));
      const used = new Set();
      const map = new Map();
      for (const ctx of sorted) {
        let hash = 0;
        for (const char of String(ctx.rk ?? "")) hash = (hash * 31 + char.charCodeAt(0)) | 0;
        let index = Math.abs(hash) % REPO_COLORS.length;
        while (used.has(index)) index = (index + 1) % REPO_COLORS.length;
        used.add(index);
        map.set(ctx.rk, REPO_COLORS[index]);
      }
      return map;
    }
    function filesForGroup(ctx, statusObj, group, filter) {
      const all = (statusObj?.[group.id] ?? []).map((file) => ({
        ...file,
        // Being in the commit is the same question as being in the index, so
        // the group a row came from is what its checkbox math reads.
        state: group.id === "staged" ? "staged" : "worktree",
      }));
      const matches = (file) => {
        if (!filter) return true;
        if (file.path.toLowerCase().includes(filter)) return true;
        // Typing the submodule name narrows to its files, like IDEA.
        if (ctx.rk !== "." && `${ctx.rk}/${file.path}`.toLowerCase().includes(filter)) return true;
        return false;
      };
      return { all, visible: all.filter(matches) };
    }

    function countText(all, visible) {
      // While filtering, say both numbers: the tree below can only ever
      // account for the matches, and a lone count would look wrong.
      return visible.length === all.length ? `${all.length}` : `${visible.length}/${all.length}`;
    }

    /**
     * One batched stage/unstage across several repos (a group header's
     * checkbox): one git call per repo, a single refresh, then the same
     * submodule-pointer hint the single-repo path shows.
     */
    function applyInclusionForRepos(pairs, target) {
      const jobs = [];
      let rootFiles = [];
      for (const { visible, ctx } of pairs) {
        const want = target ? "staged" : "worktree";
        const paths = visible.filter((file) => file.state !== want).map((file) => file.path);
        if (!paths.length) continue;
        if (!ctx || ctx.rk === ".") rootFiles = rootFiles.concat(visible);
        const payload = { paths };
        if (ctx?.root) payload.repoRoot = ctx.root;
        jobs.push(invoke(target ? "git/stage" : "git/unstage", payload));
      }
      if (!jobs.length) return Promise.resolve();
      return Promise.all(jobs).then(async (results) => {
        const failed = results.find((result) => !result?.ok);
        if (failed) {
          toast(PIG.errorText(failed), "error");
          await refresh();
          return;
        }
        await refresh();
        if (!target || !rootFiles.length) return;
        const stuck = rootFiles.filter((file) => file.insideSubmodule);
        if (!stuck.length) return;
        const staged = (state.repo?.staged ?? []).map((entry) => entry.path);
        if (stuck.some((file) => staged.includes(file.path))) toast(t("submoduleStagedHint"), "info");
        else toast(PIG.tf("submoduleInside", { path: stuck[0].path }), "error");
      });
    }

    /**
     * IDEA's repository row: disclosure, cascade checkbox, color square, name,
     * "N files", branch pill. Clicking expands; right-click switches to that
     * repository (the top-left selector does the same).
     */
    function repoRow(group, ctx, all, visible, color) {
      const rkey = `repo:${group.id}:${ctx.rk}`;
      const open = !state.collapsed.has(rkey);
      const branch = branchNameOf(ctx.branch);
      return h("div", {
        class: "tree-row repo-row",
        role: "treeitem",
        "aria-expanded": open ? "true" : "false",
        title: ctx.rk === "." ? (ctx.repoObj?.repo?.root ?? ctx.label) : ctx.root,
        onclick: () => {
          if (state.collapsed.has(rkey)) state.collapsed.delete(rkey);
          else state.collapsed.add(rkey);
          paintChanges();
        },
        oncontextmenu: (event) => {
          event.preventDefault();
          repoContextMenu(event.currentTarget, ctx);
        },
      }, [
        h("span", { class: "disclosure", "data-open": open ? "true" : "false" }, [icon("chevronRight", 11)]),
        group.id === "conflicted"
          ? h("span", { class: "indent", style: { width: "13px" } })
          : rowCheckbox({
            checked: group.id === "staged",
            title: group.id === "staged" ? t("unstageAllChanges") : t("stageAllChanges"),
            onToggle: (next) => applyInclusion(visible, next, ctx),
          }),
        h("span", { class: "repo-color", style: { background: color ?? "#888888" } }),
        h("span", { class: "name", text: ctx.label }),
        h("span", { class: "muted", text: `${countText(all, visible)} ${t("files")}` }),
        branch ? h("span", { class: "badge", text: branch, title: branch }) : null,
      ]);
    }

    function repoContextMenu(anchor, ctx) {
      if (!ctx || ctx.rk === ".") return;
      popup(anchor, [
        {
          label: t("switchToRepo"),
          title: ctx.root ?? ctx.rk,
          onSelect: () => { switchToSubmodule(ctx.root).catch(() => {}); },
        },
      ]);
    }

    /**
     * IDEA's ordering: each change list groups by repository — the current one
     * sorts among the submodules by name, like haeco-mes-parent between
     * frontend and prototype-design. A single-repo project renders exactly as
     * before, with no repository rows.
     */
    function paintChanges() {
      PIG.clear(changesList);
      if (!state.repo) {
        changesList.append(h("div", { class: "empty-state" }, [
          h("div", { class: "headline", text: state.error ? t("notARepository") : t("loading") }),
          state.error ? h("code", { text: state.error }) : null,
          state.error ? h("div", { class: "muted", text: t("repositoryHint") }) : null,
        ]));
        return;
      }

      const filter = state.filter.trim().toLowerCase();
      const multi = (state.submodules ?? []).length > 0;
      const colorMap = multi ? repoColorMap(allCtxs()) : new Map();
      let groups = 0;

      for (const group of GROUPS) {
        const buckets = [];
        const rctx = rootCtx();
        const rootLists = filesForGroup(rctx, state.repo, group, filter);
        if (rootLists.visible.length) buckets.push({ ctx: rctx, ...rootLists });
        for (const entry of state.submodules ?? []) {
          const ctx = subCtx(entry);
          const lists = filesForGroup(ctx, entry.status, group, filter);
          if (lists.visible.length) buckets.push({ ctx, ...lists });
        }
        if (!buckets.length) continue;
        groups += 1;

        const gkey = `group:${group.id}`;
        const open = !state.collapsed.has(gkey);
        const allTotal = buckets.reduce((total, bucket) => total + bucket.all.length, 0);
        const visTotal = buckets.reduce((total, bucket) => total + bucket.visible.length, 0);
        const header = h("div", {
          class: "group-header",
          onclick: () => {
            if (state.collapsed.has(gkey)) state.collapsed.delete(gkey);
            else state.collapsed.add(gkey);
            paintChanges();
          },
        }, [
          h("span", { class: "disclosure", "data-open": open ? "true" : "false" }, [icon("chevronRight", 11)]),
          h("span", { text: t(group.label) }),
          h("span", {
            class: "count",
            text: visTotal === allTotal ? `${allTotal}` : `${visTotal}/${allTotal}`,
          }),
        ]);

        // Conflicts are not something to include or exclude — they have to be
        // resolved first — so that group gets no checkbox at all.
        if (group.id !== "conflicted") {
          header.append(h("div", { class: "toolbar-spacer" }));
          header.append(rowCheckbox({
            checked: group.id === "staged",
            title: group.id === "staged" ? t("unstageAllChanges") : t("stageAllChanges"),
            onToggle: (next) => applyInclusionForRepos(buckets, next),
          }));
        }
        changesList.append(header);
        if (!open) continue;

        if (!multi) {
          const only = buckets[0];
          if (!state.groupByDirectory) {
            for (const row of flatRows(group.id, only.visible, only.ctx, 0)) changesList.append(row);
          } else {
            for (const row of treeRows(group.id, buildChangeTree(only.visible), 0, only.ctx)) changesList.append(row);
          }
          continue;
        }

        buckets.sort((a, b) => a.ctx.label.localeCompare(b.ctx.label, undefined, { sensitivity: "base", numeric: true }));
        for (const bucket of buckets) {
          changesList.append(repoRow(group, bucket.ctx, bucket.all, bucket.visible, colorMap.get(bucket.ctx.rk)));
          if (state.collapsed.has(`repo:${group.id}:${bucket.ctx.rk}`)) continue;
          if (!state.groupByDirectory) {
            for (const row of flatRows(group.id, bucket.visible, bucket.ctx, 1)) changesList.append(row);
          } else {
            for (const row of treeRows(group.id, buildChangeTree(bucket.visible), 1, bucket.ctx)) changesList.append(row);
          }
        }
      }

      if (!groups) {
        const noFilter = !state.filter.trim();
        changesList.append(h("div", { class: "empty-state" }, [
          h("div", { class: "headline", text: noFilter ? t("noChanges") : t("noMatchingChanges") }),
        ]));
      }
    }

     function paintDiffHeader() {
       PIG.clear(diffHeader);
       if (!state.selection || !state.diff) {
         diffHeader.append(h("span", { class: "muted", text: t("pickFile") }));
         return;
       }
       const sel = state.selection;
       const { name, directory } = splitPath(sel.p);
       if (sel.rk && sel.rk !== ".") diffHeader.append(h("span", { class: "muted", text: sel.rk }));
       diffHeader.append(h("span", { text: name }));
      diffHeader.append(h("div", { class: "toolbar-spacer" }));
      diffHeader.append(iconButton("columns", t("sideBySide") + " / " + t("unified"), () => {
        state.diffUnified = !state.diffUnified;
        paintDiff();
        savePrefs();
      }, { size: 13, class: "icon" }));
      diffHeader.append(iconButton("eye", t("showWhitespaces"), () => {
        state.showWhitespaces = !state.showWhitespaces;
        paintDiff();
      }, { size: 13 }));
      diffHeader.append(iconButton("gear", t("ignoreDifferences"), (event) => {
        popup(event.currentTarget, [
          { type: "label", label: t("ignoreDifferences") },
          { label: t("ignoreNone"), checked: !state.ignoreWhitespace, onSelect: () => setIgnoreWhitespace(false) },
          { label: t("ignoreWhitespace"), checked: state.ignoreWhitespace, onSelect: () => setIgnoreWhitespace(true) },
          { type: "separator" },
          { label: t("showLineNumbers"), checked: state.showLineNumbers, onSelect: () => { state.showLineNumbers = !state.showLineNumbers; paintDiff(); } },
        ]);
      }, { size: 13 }));
    }

     function hunkActionsFor(selection) {
       const group = selection?.g ?? "";
       const isIndex = group === "staged";
      if (isIndex) {
        return [{
          label: t("unstageHunk"),
          title: t("unstageHunk"),
          onSelect: async (hunk) => {
             const patch = PIG.diff.patchFor({ header: currentHeader(), hunks: [hunk] }, [hunk]);
             report(
               await invoke("git/apply-patch", { action: "unstage", patch, root: state.diff?.root, repoRoot: state.diff?.root }),
              t("unstageHunk"),
            );
            await refresh();
          },
        }];
      }
      return [
        {
          label: t("stageHunk"),
          title: t("stageHunk"),
          onSelect: async (hunk) => {
             const patch = PIG.diff.patchFor({ header: currentHeader(), hunks: [hunk] }, [hunk]);
             report(
               await invoke("git/apply-patch", { action: "stage", patch, root: state.diff?.root, repoRoot: state.diff?.root }),
              t("stageHunk"),
            );
            await refresh();
          },
        },
        {
          label: t("discardHunk"),
          title: t("discardHunk"),
          onSelect: async (hunk) => {
            const confirmed = await dialog({
              title: t("discardHunk"),
              message: t("discard"),
              danger: true,
              confirmLabel: t("discard"),
            });
            if (!confirmed) return;
             const patch = PIG.diff.patchFor({ header: currentHeader(), hunks: [hunk] }, [hunk]);
             report(
               await invoke("git/apply-patch", { action: "discard", patch, root: state.diff?.root, repoRoot: state.diff?.root }),
              t("discardHunk"),
            );
            await refresh();
          },
        },
      ];
    }

    function currentHeader() {
      return state.diff?.parsed?.files?.[0]?.header ?? ["diff --git a/x b/x"];
    }

     function paintDiff() {
       paintDiffHeader();
       const group = state.selection ? state.selection.g : null;
       const stageable = group !== "untracked" && !state.ignoreWhitespace;
       const result = PIG.diff.render(diffHost, {
         text: state.diff?.text ?? "",
         unified: state.diffUnified,
         showWhitespaces: state.showWhitespaces,
         showLineNumbers: state.showLineNumbers,
         stageable,
         hunkActions: state.selection ? hunkActionsFor(state.selection) : [],
         hunkCheckbox: state.selection && group !== "untracked" && !state.ignoreWhitespace
           ? (hunk) => ({
             checked: group === "staged",
             onChange: async (checked) => {
               const isIndex = group === "staged";
               if (checked === isIndex) return;
               const patch = PIG.diff.patchFor({ header: currentHeader(), hunks: [hunk] }, [hunk]);
               report(
                 await invoke("git/apply-patch", {
                   action: checked ? "stage" : "unstage",
                   patch,
                   root: state.diff?.root,
                   repoRoot: state.diff?.root,
                 }),
                 t("includeIntoCommit"),
               );
               await refresh();
             },
           })
           : null,
        emptyMessage: state.diff?.binary ? t("binaryDiff") : t("noDiff"),
      });
      // `state.diff` is null while nothing is selected, so the parsed model is
      // only stored back when there really is a diff to attach it to.
      if (state.diff) state.diff.parsed = result;
    }

    /**
     * The commit area's status line. A conflicted repository is the one state
     * this line has to do more than describe: an unresolved merge/rebase/cherry
     * pick can only be left by finishing it or by aborting, and the plugin's own
     * Pull can produce one, so the escape has to be here and not in a terminal.
     */
     function paintCommit() {
       commitButton.disabled = state.busy || (!state.message.trim() && !state.amend);
       const totals = totalCounts();
       const staged = totals.staged;
       const total = totals.staged + totals.unstaged + totals.untracked + totals.conflicted;
       const conflicts = totals.conflicted;
       const operation = state.repo?.operation ?? null;
       PIG.clear(summary);
       if (operation) {
         summary.className = "commit-summary warn";
         summary.append(h("span", { text: t(`${OPERATION_KEYS[operation] ?? "conflictNotice"}`) }));
         // A merge is finished by committing, so it has no "continue"; the
         // sequencer operations do.
         if (operation !== "merge") {
           summary.append(operationButton(t("continueOperation"), operation, "continue"));
         }
         summary.append(operationButton(t("abortOperation"), operation, "abort"));
       } else if (conflicts) {
         summary.className = "commit-summary warn";
         summary.append(t("conflictNotice"));
       } else if (!staged && !state.amend) {
         summary.className = "commit-summary warn";
         summary.append(t("nothingStaged"));
       } else {
         summary.className = "commit-summary";
         // Whole sentence per locale via tf; `s` feeds the English plural only.
         summary.append(PIG.tf("commitSummary", { staged, total, s: total === 1 ? "" : "s" }));
         const targets = stagedTargets();
         if (targets.length > 1) {
           summary.append(h("span", { class: "muted", text: ` · ${PIG.tf("commitMultipleRepos", { count: targets.length })}` }));
         }
       }
     }

    function operationButton(label, operation, action) {
      return h("button", {
        class: "bordered",
        type: "button",
        style: { marginLeft: "8px" },
        text: label,
        onclick: async () => {
          const result = await invoke("git/sequencer", { operation, action });
          report(result, label);
          await refresh();
        },
      });
    }

    /**
     * One failing pane must never blank the others — that is exactly how the
     * missing `state.diff` guard used to take the branch widget down with it.
     */
    let reportedFailure = false;
    function paintGenerate() {
      const busy = state.generating;
      generateButton.disabled = busy;
      generateMenuButton.disabled = busy;
      PIG.clear(generateButton);
      generateButton.append(icon("sparkles", 13));
      generateButton.append(h("span", { class: "gen-label", text: busy ? t("generating") : t("generateMessage") }));
      generateButton.title = PIG.tf("generateScope", { action: t("generateMessage"), lang: languageLabel() });
    }

    /**
     * Which change the draft should describe: the file the user picked, or
     * everything staged when the list has no selection. Reported back to them
     * afterwards so the scope is never a guess.
     */
     function draftTarget() {
       if (state.selection) {
         const sel = state.selection;
         return { path: sel.p, mode: sel.g === "staged" ? "index" : "worktree", group: sel.g, repoRoot: sel.root ?? null };
       }
       return null;
     }

    /**
     * Say what actually went wrong. A permission that was never granted is not
     * the same as having no provider configured, and telling the user to add
     * one they already have sends them the wrong way.
     */
    function draftError(result) {
      const code = String(result?.code ?? "");
      if (code === "PERMISSION_DENIED") return t("modelPermission");
      if (code === "NO_MODEL") return t("noModel");
      if (code === "RATE_LIMITED") return t("rateLimited");
      if (code === "EMPTY_DIFF" || code === "NO_DIFF") return t("nothingToDescribe");
      if (code === "TIMEOUT") return t("draftTimeout");
      return PIG.errorText(result);
    }

    // Note: 界面语言只有视图知道（插件进程拿不到），所以 locale 随每次请求传；语言是 chevron 菜单里的显式选择而不是推断，auto 的历史回退靠引擎返回 null 而不是 "en" — 见 .agents/notes/implemented/architecture/2026-09-11-commit-message-prompt.md
    async function generate() {
      if (state.generating) return;
       const target = draftTarget();
       const payload = target ? { path: target.path, mode: target.mode, ...(target.repoRoot ? { repoRoot: target.repoRoot } : {}) } : {};
      if (state.commitModelKey) payload.modelKey = state.commitModelKey;
      // The plugin process has no idea which language this window speaks, so it
      // travels with the request: `commitLang` is the user's standing choice,
      // `locale` the fallback for a repository with no history to follow.
      payload.lang = state.commitLang;
      payload.locale = PIG.state.locale;

      // Never silently discard something the user typed.
      if (state.message.trim()) {
        const replace = await dialog({
          title: t("replaceDraft"),
          message: t("replaceDraftBody"),
          confirmLabel: t("replace"),
        });
        if (!replace) return;
      }

      state.generating = true;
      paintGenerate();
      const result = await invoke("git/commit-message", payload);
      state.generating = false;
      paintGenerate();

      if (!result.ok) {
        toast(draftError(result), "error");
        return;
      }
      state.message = result.text;
      messageInput.value = result.text;
      paintCommit();
      messageInput.focus();
      const scope = result.scope ?? {};
      toast(
        scope.kind === "file"
          ? PIG.tf("draftedFile", { file: scope.path })
          : PIG.tf("draftedStaged"),
        "info",
      );
    }

    async function openGenerateMenu(anchor) {
      const result = await invoke("git/models");
      const models = Array.isArray(result.models) ? result.models : [];
      const selected = state.commitModelKey || models[0]?.key || "";
      const items = [
        { label: t("generateMessage"), onSelect: () => { generate().catch(() => {}); } },
        { type: "separator" },
        { type: "label", label: t("modelLabel") },
      ];
      if (!models.length) {
        // A menu row needs a label, not a paragraph; the full explanation is a
        // toast away, and the host's own wording stays in the tooltip.
        items.push({
          label: result.code === "PERMISSION_DENIED" ? t("modelPermissionShort") : t("noModel"),
          disabled: true,
          title: result.code === "PERMISSION_DENIED"
            ? `${t("modelPermission")}\n\n${result.message ?? ""}`.trim()
            : (result.message ?? ""),
          onSelect: result.code === "PERMISSION_DENIED"
            ? () => toast(t("modelPermission"), "error")
            : undefined,
        });
      } else {
        for (const model of models.slice(0, 30)) {
          items.push({
            label: model.label ?? model.key,
            title: model.key,
            checked: model.key === selected,
            onSelect: () => {
              state.commitModelKey = model.key;
              savePrefs();
              toast(`${t("modelLabel")}: ${model.label ?? model.key}`, "info");
            },
          });
        }
      }

      // The language is a choice, not a guess — the reason this menu exists is
      // that the model used to answer an English repository in English however
      // Chinese the user was. `auto` follows the history, which is what the
      // prompt was always trying to do, and falls back to the interface.
      items.push(
        { type: "separator" },
        { type: "label", label: t("commitLanguage") },
      );
      for (const option of LANGUAGES) {
        items.push({
          label: t(option.label),
          checked: state.commitLang === option.value,
          onSelect: () => {
            state.commitLang = option.value;
            savePrefs();
            paintGenerate();
          },
        });
      }
      popup(anchor, items);
    }

    function paintAll() {
      for (const step of [paintToolbar, paintChangesHeader, paintChanges, paintDiff, paintCommit, paintGenerate]) {
        try {
          step();
        } catch (error) {
          if (!reportedFailure) {
            reportedFailure = true;
            toast(`IDEA Git: ${error?.message ?? error}`, "error");
          }
        }
      }
      try {
        branchWidget?.update(state.repo);
      } catch {
        // The chip is decoration; never let it break the refresh.
      }
    }

    // ----------------------------------------------------------- actions --
     // ----------------------------------------------------------- actions --
     // `selection` is `{ rk, g, p, root }`: the repo key ("." for the current
     // repo, else the submodule rel), the group, the repo-relative path, and
     // the absolute repo root file actions run in.
     function select(sel) {
       state.selection = sel ? { rk: sel.rk ?? ".", g: sel.g, p: sel.p, root: sel.root ?? null } : null;
       loadDiff().catch((error) => toast(String(error?.message ?? error), "error"));
       paintChanges();
     }

     function canStageSelected() {
       return Boolean(state.selection && state.selection.g !== "staged");
     }

     function canUnstageSelected() {
       return Boolean(state.selection && state.selection.g === "staged");
     }

     function selectedPath() {
       return state.selection ? state.selection.p : null;
     }

     function selectionPayload(extra) {
       return { ...(extra ?? {}), ...(state.selection?.root ? { repoRoot: state.selection.root } : {}) };
     }

     async function stageSelected(staging) {
       const path = selectedPath();
       if (!path) return;
       report(await invoke(staging ? "git/stage" : "git/unstage", selectionPayload({ paths: [path] })), staging ? t("stageFile") : t("unstageFile"));
       await refresh();
     }

     async function rollbackSelected() {
       const path = selectedPath();
       if (!path) return;
       const confirmed = await dialog({
         title: t("rollback"),
         message: `${t("rollback")} ${path}?`,
         detail: t("discard"),
         danger: true,
         confirmLabel: t("rollback"),
       });
       if (!confirmed) return;
       report(await invoke("git/discard", selectionPayload({ paths: [path] })), t("rollback"));
       await refresh();
     }

     function ctxRepoForMenu(ctx) {
       if (ctx?.repoObj) return ctx.repoObj;
       return state.repo;
     }

     function fileContextMenu(anchor, group, file, ctx) {
       const rk = ctx?.rk ?? ".";
       const root = ctx?.root ?? null;
       const at = (extra) => ({ ...(extra ?? {}), ...(root ? { repoRoot: root } : {}) });
       const items = [
         { label: t("showDiff"), onSelect: () => select({ rk, g: group, p: file.path, root }) },
         { type: "separator" },
       ];
       if (group === "staged") {
         items.push({ label: t("unstageFile"), onSelect: () => stageFile(group, file, false, ctx) });
       } else {
         items.push({ label: t("stageFile"), onSelect: () => stageFile(group, file, true, ctx) });
       }
       items.push({
         label: t("rollback"),
         disabled: group === "staged",
         onSelect: async () => {
           const confirmed = await dialog({
             title: t("rollback"),
             message: `${t("rollback")} ${file.path}?`,
             danger: true,
             confirmLabel: t("rollback"),
           });
           if (!confirmed) return;
           report(await invoke("git/discard", at({ paths: [file.path] })), t("rollback"));
           await refresh();
         },
       });
       const relative = workspaceRelative(file.path, ctxRepoForMenu(ctx));
       items.push({ type: "separator" });
       items.push({
         label: t("openFile"),
         disabled: !relative,
         title: relative ? file.path : `${t("openFile")} — ${file.path}`,
         onSelect: () => invoke("fs.openDefault", { path: relative }),
       });
       items.push({
         label: t("revealInFileManager"),
         disabled: !relative,
         onSelect: () => invoke("fs.reveal", { path: relative }),
       });
       // The file itself has no hash to copy; offer HEAD like the Log view does
       // (git-view copyRevisionNumber), and fall back to the path with an honest
       // label when there is no commit yet. No `t("copy") + t("hash")` splicing.
       {
         const headHash = (ctx?.status?.branch?.oid ?? state.repo?.branch?.oid) ?? null;
         if (headHash) items.push({ label: t("copyRevisionNumber"), onSelect: () => PIG.copyText(headHash) });
         else items.push({ label: t("copyPath"), onSelect: () => PIG.copyText(file.path) });
       }
       popup(anchor, items);
     }

     async function stageFile(group, file, staging, ctx) {
       const payload = { paths: [file.path] };
       const root = ctx?.root ?? state.selection?.root ?? null;
       if (root) payload.repoRoot = root;
       report(await invoke(staging ? "git/stage" : "git/unstage", payload), staging ? t("stageFile") : t("unstageFile"));
       await refresh();
     }

     async function loadDiff() {
       if (!state.selection) {
         state.diff = null;
         paintDiff();
         return;
       }
       const sel = state.selection;
       const mode = sel.g === "staged" ? "index" : "worktree";
       const result = await invoke("git/diff", {
         path: sel.p,
         mode,
         ignoreWhitespace: state.ignoreWhitespace,
         ...(sel.root ? { repoRoot: sel.root } : {}),
       });
       if (!result.ok) {
         state.diff = { text: "", error: result.message };
         paintDiff();
         diffHost.append(h("div", { class: "banner error" }, [
           h("div", { class: "banner-text" }, [
             h("div", { text: result.message ?? t("diff") }),
           ]),
         ]));
         return;
       }
       state.diff = result;
       paintDiff();
     }

    function setIgnoreWhitespace(enabled) {
      state.ignoreWhitespace = enabled;
      savePrefs();
      loadDiff().catch(() => {});
    }

    function openCommitMenu(event) {
      popup(event.currentTarget, [
        { label: t("commit"), onSelect: () => commit(false) },
        { label: t("commitAndPush"), onSelect: () => commit(true) },
        { type: "separator" },
        { label: t("amend"), checked: state.amend, onSelect: () => { state.amend = !state.amend; amendBox.checked = state.amend; paintCommit(); } },
        { label: t("signOff"), checked: state.signoff, onSelect: () => { state.signoff = !state.signoff; signoffBox.checked = state.signoff; } },
        { type: "separator" },
        {
          label: t("rollback"),
          onSelect: async () => {
            const paths = (state.repo?.staged ?? []).map((file) => file.path);
            if (!paths.length) return;
            const confirmed = await dialog({
              title: t("rollback"),
              message: `${t("unstageFile")}?`,
              confirmLabel: t("rollback"),
            });
            if (!confirmed) return;
            report(await invoke("git/unstage", { paths }), t("unstageFile"));
            await refresh();
          },
        },
      ]);
    }

     async function commit(withPush) {
       if (state.busy) return;
       const message = state.message.trim();
       if (!message && !state.amend) {
         toast(t("commitMessage"), "error");
         messageInput.focus();
         return;
       }
       // IDEA commits every repository with the same message: submodules first
       // (their new HEADs become the parent's gitlink updates), the current
       // repo last. A parent-only `git commit` can never include the 15 files
       // changed inside `backend` — it only records which commit `backend`
       // points at.
       const targets = stagedTargets();
       if (!state.amend && !targets.length) {
         toast(t("nothingStaged"), "error");
         return;
       }
       if (!targets.length) targets.push(rootCtx());
       state.busy = true;
       paintCommit();
       let failed = null;
       let lastResult = null;
       for (const target of targets) {
         const payload = { message, amend: state.amend, signoff: state.signoff };
         if (target.root) payload.repoRoot = target.root;
         const result = await invoke("git/commit", payload);
         if (!result.ok) {
           failed = { target, result };
           break;
         }
         lastResult = { target, result };
       }
       state.busy = false;
       if (failed) {
         toast(`${failed.target.rk === "." ? "" : `${failed.target.rk}: `}${PIG.errorText(failed.result)}`, "error");
         paintCommit();
         await refresh();
         return;
       }
       if (message) {
         const remembered = await invoke("git/message-used", { message });
         state.messages = remembered.prefs?.messages ?? state.messages;
       }
       state.message = "";
       messageInput.value = "";
       state.amend = false;
       amendBox.checked = false;
       if (targets.length > 1) toast(PIG.tf("commitMultipleRepos", { count: targets.length }), "info");
       else toast(firstLine(lastResult?.result?.stdout) || t("commit"), "info");

      if (withPush) {
        // Note: 聚合提交的 Push 把刚才提交的 N 个仓逐个推出去（子模块先、父仓后），单仓失败点名且不挡后续 — 见 .agents/notes/implemented/architecture/2026-09-12-multi-repo-push.md
        const pushTargets = targets.map((target) => ({
          rk: target.rk,
          root: target.root,
          setUpstream: !target.branch?.upstream,
        }));
        const outcomes = await PIG.pushRepos(pushTargets);
        const okCount = outcomes.filter((o) => o?.ok).length;
        for (const outcome of outcomes) {
          if (!outcome?.ok) {
            toast(`${outcome.rel && outcome.rel !== "." ? `${outcome.rel}: ` : ""}${PIG.errorText(outcome)}`, "error");
          }
        }
        if (okCount === outcomes.length && outcomes.length > 1) toast(PIG.tf("pushedRepos", { count: okCount }), "info");
        else if (okCount !== outcomes.length && outcomes.length > 1) toast(PIG.tf("pushPartial", { ok: okCount, total: outcomes.length }), outcomes.length && okCount ? "info" : "error");
        else if (outcomes.length === 1) report(outcomes[0], t("push"));
      }
       await refresh();
     }

    function openMessageHistory(event) {
      if (!state.messages.length) {
        toast(t("commitHistory"), "info");
        return;
      }
      popup(event.currentTarget, [
        { type: "label", label: t("commitHistory") },
        ...state.messages.slice(0, 20).map((message) => ({
          label: firstLine(message).slice(0, 90),
          title: message,
          onSelect: () => {
            state.message = message;
            messageInput.value = message;
            paintCommit();
            messageInput.focus();
          },
        })),
        { type: "separator" },
        {
          label: t("clearAll"),
          onSelect: async () => {
            await invoke("git/prefs-set", { ui: { messagesCleared: Date.now() } });
            state.messages = [];
          },
        },
      ]);
    }

    // ------------------------------------------------------------- wiring --
    function savePrefs() {
      invoke("git/prefs-set", {
        ui: {
          commitUnified: state.diffUnified,
          showWhitespaces: state.showWhitespaces,
          showLineNumbers: state.showLineNumbers,
          commitLang: state.commitLang,
          commitModelKey: state.commitModelKey,
          groupByDirectory: state.groupByDirectory,
          compactDirs: state.compactDirs,
        },
      }).catch(() => {});
    }

    // -------------------------------------------------------------- shell --
    changesWidth.append(changesHeader, changesList);
    diffColumn.append(diffHeader, diffHost);
    root.append(toolbar);
    root.append(h("div", { class: "commit-view" }, [changesWidth, divider, diffColumn]));
    root.append(h("div", { class: "commit-area" }, [
      h("div", { class: "commit-message-row" }, [
        messageInput,
        h("div", { class: "commit-history" }, [
          iconButton("clock", t("commitHistory"), openMessageHistory, { size: 15 }),
        ]),
      ]),
      h("div", { class: "commit-actions" }, [
        h("label", { class: "check" }, [amendBox, t("amend")]),
        h("label", { class: "check" }, [signoffBox, t("signOff")]),
        summary,
        generateGroup,
        h("span", { class: "spacer" }),
        h("span", { class: "commit-summary", style: { maxWidth: "40%" }, id: "commit-branch" }),
        h("div", { class: "split-button" }, [commitButton, commitMenuButton]),
      ]),
    ]));

    branchWidget = mountBranchWidget(branchHolder, { onChanged: () => refresh() });
    /**
     * Switching repository is a view-wide change, so it drops what the leaving
     * repository owned *before* the reload starts rather than after it ends: a
     * hunk button left in the diff pane stays clickable for the length of a
     * refresh, and a hunk action is a real edit — `discard` writes to the
     * worktree — so it would land in whichever repository is current by then.
     */
    repoWidget = PIG.repoSelector.mount(repoHolder, {
      onSwitch: () => {
        forgoRepositoryState();
        paintAll();
        refresh().catch(() => {});
      },
    });

    PIG.bindSplitter(divider, (delta) => {
      const total = root.clientWidth || 1;
      state.changesWidth = Math.max(18, Math.min(75, state.changesWidth + (delta / total) * 100));
      changesWidth.style.width = `${state.changesWidth}%`;
    });

    // ------------------------------------------------------------- refresh --
    /**
     * Which repository the loaded state belongs to, so a switch can be told
     * apart from an ordinary refresh: a selection, a filter and a rendered diff
     * are all repository-relative, and carrying them across would show — and
     * stage — the wrong file. `undefined` means nothing has been loaded yet.
     */
    let loadedRepo;

     /** Drop everything that describes one repository, and only that one. */
     function forgoRepositoryState() {
       state.selection = null;
       state.diff = null;
       state.filter = "";
       state.submodules = [];
       state.subLoading = false;
       // A commit draft belongs to the repository it was typed against: carrying
       // the message/amend/signoff across would commit one repo's text in another.
       state.message = "";
       state.amend = false;
       state.signoff = false;
       messageInput.value = "";
       amendBox.checked = false;
       signoffBox.checked = false;
     }
     async function refresh() {
       const result = await invoke("git/repo");
       if (!result.ok) {
         state.repo = null;
         state.error = result.message ?? t("notARepository");
         // Nothing is loaded, so nothing repository-relative may stay on screen
         // — and the next repository to load must not be mistaken for the same
         // one continuing.
         forgoRepositoryState();
         loadedRepo = undefined;
         paintAll();
         return state.repo ?? {};
       }
       const repoRoot = result.repo?.root ?? null;
       if (loadedRepo !== undefined && repoRoot !== loadedRepo) forgoRepositoryState();
       loadedRepo = repoRoot;
       state.repo = result;
       state.error = null;
       // Drop a selection whose file left the change lists (root or submodule).
       if (state.selection) {
         const sel = state.selection;
         const list = sel.rk === "." || !sel.rk
           ? (result[sel.g] ?? [])
           : ((state.submodules ?? []).find((entry) => entry.rel === sel.rk)?.status?.[sel.g] ?? []);
         if (!list.some((file) => file.path === sel.p)) state.selection = null;
       }
       // IDEA-like aggregation: the parent only prints one gitlink line per
       // submodule, so fetch dirty submodules' own statuses for the inline
       // sections. Paint first (fast), then fill the sections in.
       paintAll();
      const hasSubmodule = result.siblingMode === true
        || [...(result.staged ?? []), ...(result.unstaged ?? [])].some((file) => file?.submodule)
        // An embedded (non-submodule) repo shows as one untracked dir entry;
        // Git never descends into it, so its inner changes need the same fetch.
        || (result.untracked ?? []).some((file) => String(file?.path ?? "").endsWith("/"));
      if (hasSubmodule) {
        state.subLoading = true;
         paintChangesHeader();
         try {
           const subs = await invoke("git/submodule-statuses");
           state.submodules = subs?.ok ? (subs.submodules ?? []) : [];
         } catch {
           state.submodules = [];
         }
         state.subLoading = false;
       } else {
         state.submodules = [];
         state.subLoading = false;
       }
       if (!state.selection) {
         const firstRoot = ["conflicted", "unstaged", "staged", "untracked"]
           .flatMap((group) => (result[group] ?? []).map((file) => ({ rk: ".", g: group, p: file.path, root: result.repo?.root ?? null })))[0];
         state.selection = firstRoot ?? null;
         if (!state.selection) {
           for (const entry of state.submodules ?? []) {
             const hit = ["conflicted", "unstaged", "staged", "untracked"]
               .flatMap((group) => (entry.status?.[group] ?? []).map((file) => ({ rk: entry.rel, g: group, p: file.path, root: entry.root })))[0];
             if (hit) {
               state.selection = hit;
               break;
             }
           }
         }
       }
       paintAll();
       await loadDiff();
       return result;
     }
     async function loadPrefs() {
       const result = await invoke("git/prefs");
       if (!result.ok) return;
      state.messages = result.prefs?.messages ?? [];
      const ui = result.prefs?.ui ?? {};
      if (typeof ui.commitUnified === "boolean") state.diffUnified = ui.commitUnified;
      if (typeof ui.showWhitespaces === "boolean") state.showWhitespaces = ui.showWhitespaces;
      if (typeof ui.showLineNumbers === "boolean") state.showLineNumbers = ui.showLineNumbers;
      if (typeof ui.commitLang === "string") state.commitLang = ui.commitLang;
      if (typeof ui.commitModelKey === "string") state.commitModelKey = ui.commitModelKey;
      if (typeof ui.groupByDirectory === "boolean") state.groupByDirectory = ui.groupByDirectory;
      if (typeof ui.compactDirs === "boolean") state.compactDirs = ui.compactDirs;
    }

    /**
     * The repository list, read when it can actually have changed — mounting,
     * a project switch, and opening the chip's menu (which re-reads its own) —
     * rather than on every refresh. Finding the nested repositories walks the
     * tree, and a refresh happens after every stage, commit and branch action.
     */
    async function loadRepositories() {
      const result = await invoke("git/repos");
      state.allRepos = result?.ok ? (result.repos ?? []) : [];
      repoWidget.update(result);
    }

    (async () => {
      try {
        await loadPrefs();
        await loadRepositories();
        await refresh();
      } catch (error) {
        // Without this the view would fail silently on first paint.
        toast(`IDEA Git: ${error?.message ?? error}`, "error");
      }
    })();

    window.addEventListener("pig:appearance", () => paintAll());
    PIG.watchWorkspace(() => {
      // A project switch invalidates the list as much as the repository.
      loadRepositories().then(() => refresh()).catch(() => {});
    });

    PIG.bindShortcuts([
      { spec: KEYS.refresh, run: () => { refresh().catch(() => {}); } },
      { spec: KEYS.refreshAlt, run: () => { refresh().catch(() => {}); } },
      { spec: KEYS.stage, run: () => { if (canStageSelected()) stageSelected(true); } },
      { spec: KEYS.rollback, run: () => { if (state.selection) rollbackSelected(); } },
      { spec: KEYS.showDiff, run: () => { loadDiff().catch(() => {}); } },
      { spec: KEYS.commitMessage, run: () => messageInput.focus() },
      // The app's own accelerators cannot reach this webContents; say so.
      PIG.appShortcutHintBinding(),
    ]);

    return { refresh, focusMessage: () => messageInput.focus() };
  }

  PIG.branchWidget = { mount: mountBranchWidget };
  PIG.commitView = { mount };
  PIG.statusColor = statusColor;
})(window.PIG || (window.PIG = {}));
