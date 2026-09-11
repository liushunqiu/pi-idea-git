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

  const STATUS_VARS = {
    A: "added", M: "modified", D: "deleted", R: "renamed", C: "renamed",
    T: "modified", "?": "unversioned", U: "conflict", "!": "ignored",
  };

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
    const root = String(repo?.repo?.root ?? "").replace(/[/\\]+$/, "");
    const workspace = String(repo?.repo?.workspace ?? "").replace(/[/\\]+$/, "");
    if (!filePath) return null;
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
        onSelect: async () => report(await invoke("git/fetch"), t("fetch")),
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
          const result = await invoke("git/push", {
            remote: "origin",
            branch: branch?.head,
            setUpstream: !branch?.upstream,
          });
          report(result, t("push"));
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

  function report(result, action) {
    if (result?.ok) {
      if (result.stdout?.trim()) toast(`${action}: ${firstLine(result.stdout)}`, "info");
      return true;
    }
    toast(`${action}: ${PIG.errorText(result)}`, "error");
    return false;
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
      collapsed: new Set(),
      filter: "",
      changesWidth: 45,
    };

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
    const changesHeader = h("div", { class: "pane-header" });

    const changesWidth = h("div", { class: "commit-changes column" });
    const diffColumn = h("div", { class: "commit-diff column" });
    const divider = h("div", { class: "divider-v draggable", title: "" });

    let branchWidget = null;

    // --------------------------------------------------------- rendering --
    function paintToolbar() {
      PIG.clear(toolbar);
      toolbar.append(branchHolder);
      toolbar.append(h("div", { class: "toolbar-separator" }));
      toolbar.append(iconButton("refresh", tip("refresh", KEYS.refresh), () => refresh()));
      toolbar.append(iconButton("fetch", t("fetch"), async () => {
        const result = await invoke("git/fetch");
        if (report(result, t("fetch"))) await refresh();
      }));
      toolbar.append(iconButton("push", t("push"), async () => {
        const branch = state.repo?.branch;
        const result = await invoke("git/push", {
          remote: "origin",
          branch: branch?.head,
          setUpstream: !branch?.upstream,
        });
        report(result, t("push"));
      }));
      toolbar.append(h("div", { class: "toolbar-separator" }));
      toolbar.append(iconButton("plus", tip("stageFile", KEYS.stage), () => stageSelected(true), { disabled: !canStageSelected() }));
      toolbar.append(iconButton("minus", t("unstageFile"), () => stageSelected(false), { disabled: !canUnstageSelected() }));
      toolbar.append(iconButton("rollback", tip("rollback", KEYS.rollback), rollbackSelected, { disabled: !state.selection }));
      toolbar.append(h("div", { class: "toolbar-spacer" }));
      toolbar.append(h("span", { style: { fontSize: "11px", color: "var(--fg-muted)" }, text: state.repo?.repo?.name ?? "" }));
    }

    function paintChangesHeader() {
      PIG.clear(changesHeader);
      const counts = state.repo
        ? { staged: state.repo.staged.length, unstaged: state.repo.unstaged.length, untracked: state.repo.untracked.length, conflicted: state.repo.conflicted.length }
        : { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
      const total = counts.staged + counts.unstaged + counts.untracked + counts.conflicted;
      changesHeader.append(h("span", { text: t("changes") }));
      changesHeader.append(h("span", { class: "muted", text: total ? `${total}` : "" }));
      changesHeader.append(h("div", { class: "toolbar-spacer" }));
      changesHeader.append(iconButton("minus", t("unstageAllChanges"), async () => {
        const paths = (state.repo?.staged ?? []).map((file) => file.path);
        if (!paths.length) return;
        report(await invoke("git/unstage", { paths }), t("unstageAllChanges"));
        await refresh();
      }, { size: 13 }));
      changesHeader.append(iconButton("plus", t("stageAllChanges"), async () => {
        const paths = [
          ...(state.repo?.unstaged ?? []).map((file) => file.path),
          ...(state.repo?.untracked ?? []).map((file) => file.path),
        ];
        if (!paths.length) return;
        report(await invoke("git/stage", { paths }), t("stageAllChanges"));
        await refresh();
      }, { size: 13 }));
    }

    function fileRow(group, file) {
      const selectionKey = `${group}:${file.path}`;
      const selected = state.selection === selectionKey;
      const { name, directory } = splitPath(file.path);

      const checkbox = h("input", {
        type: "checkbox",
        title: t("includeIntoCommit"),
        checked: group === "staged",
        onclick: (event) => event.stopPropagation(),
        onchange: async (event) => {
          const checked = event.target.checked;
          event.target.disabled = true;
          const channel = checked ? "git/stage" : "git/unstage";
          const result = await invoke(channel, { paths: [file.path] });
          if (!result.ok) toast(PIG.errorText(result), "error");
          await refresh();
        },
      });

      const row = h("div", {
        class: "tree-row",
        role: "option",
        tabindex: "0",
        "aria-selected": selected ? "true" : "false",
        title: file.path,
        onclick: () => select(selectionKey),
        oncontextmenu: (event) => {
          event.preventDefault();
          select(selectionKey);
          fileContextMenu(event.currentTarget, group, file);
        },
      }, [
        h("span", { class: "indent", style: { width: "14px" } }),
        checkbox,
        h("span", { class: "status-cell", style: { color: statusColor(file.status) }, text: file.status === "?" ? "?" : file.status }),
        h("span", { class: "name", style: { color: statusColor(file.status) }, text: name }),
        directory ? h("span", { class: "path", text: directory }) : null,
      ]);
      return row;
    }

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
      let shown = 0;

      for (const group of GROUPS) {
        const files = (state.repo[group.id] ?? []).filter((file) =>
          !filter || file.path.toLowerCase().includes(filter));
        if (!files.length) continue;
        shown += files.length;
        const open = !state.collapsed.has(group.id);
        const header = h("div", {
          class: "group-header",
          onclick: () => {
            if (state.collapsed.has(group.id)) state.collapsed.delete(group.id);
            else state.collapsed.add(group.id);
            paintChanges();
          },
        }, [
          h("span", { class: "disclosure", "data-open": open ? "true" : "false" }, [icon("chevronRight", 11)]),
          h("span", { text: t(group.label) }),
          h("span", { class: "count", text: `${files.length}` }),
        ]);
        if (group.id === "staged" || group.id === "unstaged" || group.id === "untracked") {
          header.append(h("div", { class: "toolbar-spacer" }));
          const allStaged = group.id === "staged";
          header.append(h("button", {
            class: "tiny-button",
            type: "button",
            title: allStaged ? t("unstageAllChanges") : t("stageAllChanges"),
            onclick: async (event) => {
              event.stopPropagation();
              const paths = files.map((file) => file.path);
              const result = await invoke(allStaged ? "git/unstage" : "git/stage", { paths });
              if (!result.ok) toast(PIG.errorText(result), "error");
              await refresh();
            },
          }, [icon(allStaged ? "minus" : "plus", 11)]));
        }
        changesList.append(header);
        if (!open) continue;
        for (const file of files) changesList.append(fileRow(group.id, file));
      }

      if (!shown) {
        changesList.append(h("div", { class: "empty-state" }, [
          h("div", { class: "headline", text: t("noChanges") }),
        ]));
      }
    }

    function paintDiffHeader() {
      PIG.clear(diffHeader);
      if (!state.selection || !state.diff) {
        diffHeader.append(h("span", { class: "muted", text: t("pickFile") }));
        return;
      }
      const [, path] = state.selection.split(":");
      const { name, directory } = splitPath(path);
      diffHeader.append(h("span", { text: name }));
      if (directory) diffHeader.append(h("span", { class: "muted", text: directory }));
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

    function hunkActionsFor(selection, file) {
      const group = selection.split(":")[0];
      const isIndex = group === "staged";
      if (group === "untracked") return [];
      if (state.ignoreWhitespace) return [];
      if (isIndex) {
        return [{
          label: t("unstageHunk"),
          title: t("unstageHunk"),
          onSelect: async (hunk) => {
            const patch = PIG.diff.patchFor({ header: currentHeader(), hunks: [hunk] }, [hunk]);
            report(await invoke("git/apply-patch", { action: "unstage", patch }), t("unstageHunk"));
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
            report(await invoke("git/apply-patch", { action: "stage", patch }), t("stageHunk"));
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
            report(await invoke("git/apply-patch", { action: "discard", patch }), t("discardHunk"));
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
      const group = state.selection ? state.selection.split(":")[0] : null;
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
              report(await invoke("git/apply-patch", { action: checked ? "stage" : "unstage", patch }), t("includeIntoCommit"));
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

    function paintCommit() {
      commitButton.disabled = state.busy || (!state.message.trim() && !state.amend);
      const staged = state.repo?.staged?.length ?? 0;
      const total = staged
        + (state.repo?.unstaged?.length ?? 0)
        + (state.repo?.untracked?.length ?? 0)
        + (state.repo?.conflicted?.length ?? 0);
      const conflicts = state.repo?.conflicted?.length ?? 0;
      PIG.clear(summary);
      if (conflicts) {
        summary.className = "commit-summary warn";
        summary.append(t("conflictNotice"));
      } else if (!staged && !state.amend) {
        summary.className = "commit-summary warn";
        summary.append(t("nothingStaged"));
      } else {
        summary.className = "commit-summary";
        summary.append(PIG.state.locale === "zh-CN"
          ? `将提交 ${staged} / ${total} 个文件`
          : `${staged} of ${total} file${total === 1 ? "" : "s"} will be committed`);
      }
    }

    /**
     * One failing pane must never blank the others — that is exactly how the
     * missing `state.diff` guard used to take the branch widget down with it.
     */
    let reportedFailure = false;
    function paintAll() {
      for (const step of [paintToolbar, paintChangesHeader, paintChanges, paintDiff, paintCommit]) {
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
    function select(selectionKey) {
      state.selection = selectionKey;
      loadDiff().catch((error) => toast(String(error?.message ?? error), "error"));
      paintChanges();
    }

    function canStageSelected() {
      return Boolean(state.selection && state.selection.split(":")[0] !== "staged");
    }

    function canUnstageSelected() {
      return Boolean(state.selection && state.selection.split(":")[0] === "staged");
    }

    function selectedPath() {
      return state.selection ? state.selection.split(":").slice(1).join(":") : null;
    }

    async function stageSelected(staging) {
      const path = selectedPath();
      if (!path) return;
      report(await invoke(staging ? "git/stage" : "git/unstage", { paths: [path] }), staging ? t("stageFile") : t("unstageFile"));
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
      report(await invoke("git/discard", { paths: [path] }), t("rollback"));
      await refresh();
    }

    function fileContextMenu(anchor, group, file) {
      const items = [
        { label: t("showDiff"), onSelect: () => select(`${group}:${file.path}`) },
        { type: "separator" },
      ];
      if (group === "staged") {
        items.push({ label: t("unstageFile"), onSelect: () => stageFile(group, file, false) });
      } else {
        items.push({ label: t("stageFile"), onSelect: () => stageFile(group, file, true) });
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
          report(await invoke("git/discard", { paths: [file.path] }), t("rollback"));
          await refresh();
        },
      });
      const relative = workspaceRelative(file.path, state.repo);
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
      items.push({ label: t("copy") + " " + t("hash"), onSelect: () => PIG.copyText(file.path) });
      popup(anchor, items);
    }

    async function stageFile(group, file, staging) {
      report(await invoke(staging ? "git/stage" : "git/unstage", { paths: [file.path] }), staging ? t("stageFile") : t("unstageFile"));
      await refresh();
    }

    async function loadDiff() {
      if (!state.selection) {
        state.diff = null;
        paintDiff();
        return;
      }
      const [group, ...rest] = state.selection.split(":");
      const path = rest.join(":");
      const mode = group === "staged" ? "index" : "worktree";
      const result = await invoke("git/diff", {
        path,
        mode,
        ignoreWhitespace: state.ignoreWhitespace,
      });
      if (!result.ok) {
        state.diff = { text: "", error: result.message };
        paintDiff();
        diffHost.append(h("div", { class: "banner error" }, [
          h("div", { class: "banner-text" }, [
            h("div", { text: result.message ?? "Diff failed" }),
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
      if (!state.amend && !(state.repo?.staged?.length ?? 0)) {
        toast(t("nothingStaged"), "error");
        return;
      }
      state.busy = true;
      paintCommit();
      const result = await invoke("git/commit", {
        message,
        amend: state.amend,
        signoff: state.signoff,
      });
      state.busy = false;
      if (!result.ok) {
        toast(PIG.errorText(result), "error");
        paintCommit();
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
      toast(firstLine(result.stdout) || t("commit"), "info");

      if (withPush) {
        const branch = state.repo?.branch;
        const pushed = await invoke("git/push", {
          remote: "origin",
          branch: branch?.head,
          setUpstream: !branch?.upstream,
        });
        report(pushed, t("push"));
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
        h("span", { class: "spacer" }),
        h("span", { class: "commit-summary", style: { maxWidth: "40%" }, id: "commit-branch" }),
        h("div", { class: "split-button" }, [commitButton, commitMenuButton]),
      ]),
    ]));

    branchWidget = mountBranchWidget(branchHolder, { onChanged: () => refresh() });

    PIG.bindSplitter(divider, (delta) => {
      const total = root.clientWidth || 1;
      state.changesWidth = Math.max(18, Math.min(75, state.changesWidth + (delta / total) * 100));
      changesWidth.style.width = `${state.changesWidth}%`;
    });

    // ------------------------------------------------------------- refresh --
    async function refresh() {
      const result = await invoke("git/repo");
      if (!result.ok) {
        state.repo = null;
        state.error = result.message ?? t("notARepository");
        paintAll();
        return;
      }
      state.repo = result;
      state.error = null;
      // Drop a selection whose file left the change lists.
      if (state.selection) {
        const [group, ...rest] = state.selection.split(":");
        const path = rest.join(":");
        const stillThere = (result[group] ?? []).some((file) => file.path === path);
        if (!stillThere) state.selection = null;
      }
      if (!state.selection) {
        const first = ["conflicted", "unstaged", "staged", "untracked"]
          .flatMap((group) => (result[group] ?? []).map((file) => `${group}:${file.path}`))[0];
        state.selection = first ?? null;
      }
      paintAll();
      await loadDiff();
    }

    async function loadPrefs() {
      const result = await invoke("git/prefs");
      if (!result.ok) return;
      state.messages = result.prefs?.messages ?? [];
      const ui = result.prefs?.ui ?? {};
      if (typeof ui.commitUnified === "boolean") state.diffUnified = ui.commitUnified;
      if (typeof ui.showWhitespaces === "boolean") state.showWhitespaces = ui.showWhitespaces;
      if (typeof ui.showLineNumbers === "boolean") state.showLineNumbers = ui.showLineNumbers;
    }

    (async () => {
      try {
        await loadPrefs();
        await refresh();
      } catch (error) {
        // Without this the view would fail silently on first paint.
        toast(`IDEA Git: ${error?.message ?? error}`, "error");
      }
    })();

    window.addEventListener("pig:appearance", () => paintAll());
    PIG.watchWorkspace(() => { refresh().catch(() => {}); });

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
