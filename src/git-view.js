/**
 * The Git tool window — IDEA's `Alt+9` surface, holding the Log and Console
 * tabs. The Log keeps IDEA's panes: branches on the left, commits in the
 * centre, and the changed files plus commit details below the list.
 *
 * IDEA opens a commit's diff in the editor. There is no editor here, so the
 * diff opens in an overlay inside the tool window instead — the same content,
 * the same wording, one click away.
 */
(function (PIG) {
  "use strict";

  const { h, t, invoke, icon, iconButton, toast, popup, dialog } = PIG;

  /**
   * IDEA's Log shortcuts, in the form this surface can honour. The tooltip is
   * rendered from the same spec that is bound, so the two cannot drift apart.
   */
  const KEYS = {
    refresh: { key: "r", mod: true },
    refreshAlt: { key: "F5", ctrl: true },
    find: { key: "f", mod: true },
    showDiff: { key: "d", mod: true },
  };

  function tip(key, spec) {
    return `${t(key)} (${PIG.formatShortcut(spec)})`;
  }

  const ROW_HEIGHT = 34;
  const LANE_WIDTH = 14;
  const LANE_COLORS = ["#4a86c8", "#3fb28a", "#c9a227", "#b06bc0", "#d1743a", "#6aa84f", "#c05555", "#5f7fd4"];
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svg(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  }

  /**
   * Assign each commit a lane. A commit takes the lane already reserved for it
   * (the one a child pushed down), otherwise a free lane; its first parent
   * inherits the lane and extra parents take their own.
   */
  function assignLanes(commits) {
    const lanes = [];
    const rows = [];
    for (const commit of commits) {
      const before = lanes.slice();
      let lane = lanes.indexOf(commit.hash);
      if (lane < 0) {
        lane = lanes.indexOf(null);
        if (lane < 0) {
          lane = lanes.length;
          lanes.push(null);
        }
      }
      lanes[lane] = null;
      const parents = commit.parents ?? [];
      if (parents.length) {
        lanes[lane] = parents[0];
        for (let index = 1; index < parents.length; index += 1) {
          if (lanes.includes(parents[index])) continue;
          const free = lanes.indexOf(null);
          if (free < 0) lanes.push(parents[index]);
          else lanes[free] = parents[index];
        }
      }
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      rows.push({ commit, lane, before, after: lanes.slice() });
    }
    const laneCount = rows.reduce(
      (max, row) => Math.max(max, row.before.length, row.after.length, row.lane + 1),
      1,
    );
    const rowByHash = new Map();
    rows.forEach((row, index) => rowByHash.set(row.commit.hash, { index, lane: row.lane }));
    return { rows, rowByHash, width: Math.max(56, laneCount * LANE_WIDTH + 14) };
  }

  /** IDEA colours the tip by what the commit *is*, not by lane. */
  function dotColor(commit, lane) {
    const refs = commit.refs ?? [];
    if (refs.some((ref) => ref.head)) return "var(--graph-head)";
    if (refs.some((ref) => ref.kind === "branch")) return "var(--graph-local)";
    if (refs.some((ref) => ref.kind === "remote")) return "var(--graph-remote)";
    if (refs.some((ref) => ref.kind === "tag")) return "var(--graph-tag)";
    return LANE_COLORS[lane % LANE_COLORS.length];
  }

  function graphNode(row, layout) {
    const { rowByHash } = layout;
    const group = svg("svg", { width: layout.width, height: ROW_HEIGHT, class: "log-graph-svg" });
    const x = (lane) => 10 + lane * LANE_WIDTH;
    const midY = ROW_HEIGHT / 2;

    const laneIndices = new Set([row.lane]);
    row.before.forEach((value, index) => { if (value) laneIndices.add(index); });
    row.after.forEach((value, index) => { if (value) laneIndices.add(index); });

    for (const lane of laneIndices) {
      const arrives = Boolean(row.before[lane]);
      const continues = Boolean(row.after[lane]);
      if (!arrives && !continues) continue;
      const top = arrives ? 0 : midY;
      const bottom = continues ? ROW_HEIGHT : midY;
      if (bottom <= top) continue;
      group.append(svg("line", {
        x1: x(lane), y1: top, x2: x(lane), y2: bottom,
        stroke: LANE_COLORS[lane % LANE_COLORS.length], "stroke-width": 1.6,
      }));
    }

    for (const parent of row.commit.parents ?? []) {
      const target = rowByHash.get(parent);
      if (!target) continue;
      if (target.lane === row.lane) {
        group.append(svg("line", {
          x1: x(row.lane), y1: midY, x2: x(row.lane), y2: ROW_HEIGHT,
          stroke: LANE_COLORS[row.lane % LANE_COLORS.length], "stroke-width": 1.6,
        }));
        continue;
      }
      group.append(svg("path", {
        d: `M ${x(row.lane)} ${midY} C ${x(row.lane)} ${midY + 9}, ${x(target.lane)} ${ROW_HEIGHT - 9}, ${x(target.lane)} ${ROW_HEIGHT}`,
        fill: "none",
        stroke: LANE_COLORS[target.lane % LANE_COLORS.length],
        "stroke-width": 1.6,
      }));
    }

    group.append(svg("circle", {
      cx: x(row.lane), cy: midY, r: 3.6,
      fill: dotColor(row.commit, row.lane),
      stroke: "var(--panel-bg)", "stroke-width": 1.2,
    }));
    return group;
  }

  function refBadges(commit) {
    return (commit.refs ?? []).map((ref) => {
      const kind = ref.head ? "head" : ref.kind === "tag" ? "tag" : ref.kind === "remote" ? "remote" : "local";
      return h("span", { class: `badge ${kind}`, text: ref.name, title: ref.name });
    });
  }

  /**
   * Only one diff overlay may be open at a time. Every `openDiffOverlay` call
   * used to append another `position: absolute; inset: 0` layer to <body>, and
   * each layer carried a full diff worth of DOM — so the cost of opening the
   * next one grew with the number already left open, which is the shape a
   * steadily climbing renderer CPU takes.
   */
  let activeDiffOverlay = null;

  /** Diff overlay: the stand-in for IDEA's "diff opens in the editor". */
  /**
   * A commit's diff, in IDEA's shape: a header naming the file, the view
   * controls, then the diff itself. It replaces the tool window's content
   * because there is no editor tab to open it into.
   */
  function openDiffOverlay(title, text, repo) {
    // Disposing the previous overlay also drops its keydown listener; leaving
    // it behind would leak one document-level handler per opened diff.
    if (activeDiffOverlay) activeDiffOverlay();

    const view = { unified: true, showWhitespaces: false, showLineNumbers: true };
    const body = h("div", { class: "diff" });
    const header = h("div", { class: "toolbar diff-overlay-header" });
    const overlay = h("div", { class: "diff-overlay", role: "dialog", "aria-label": title });

    const close = () => {
      if (activeDiffOverlay === close) activeDiffOverlay = null;
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };

    function paintDiff() {
      PIG.diff.render(body, {
        text,
        unified: view.unified,
        showWhitespaces: view.showWhitespaces,
        showLineNumbers: view.showLineNumbers,
        showFileHeader: true,
        // A committed change is not something to stage or discard.
        stageable: false,
        hunkActions: [],
      });
    }

    function paintHeader() {
      PIG.clear(header);
      const { name, directory } = PIG.splitPath(title);
      header.append(icon("file", 14));
      header.append(h("span", { class: "diff-overlay-title", text: name }));
      if (directory) header.append(h("span", { class: "diff-overlay-path", text: directory }));
      header.append(h("div", { class: "toolbar-spacer" }));
      header.append(iconButton("columns", t("sideBySide") + " / " + t("unified"), () => {
        view.unified = !view.unified;
        paintDiff();
      }, { size: 14 }));
      header.append(iconButton("eye", t("showWhitespaces"), () => {
        view.showWhitespaces = !view.showWhitespaces;
        paintDiff();
      }, { size: 14 }));
      header.append(iconButton("list", t("showLineNumbers"), () => {
        view.showLineNumbers = !view.showLineNumbers;
        paintDiff();
      }, { size: 14 }));
      header.append(iconButton("close", `${t("close")} (Esc)`, close, { size: 14 }));
    }

    overlay.append(header, body);
    document.body.append(overlay);
    paintHeader();
    paintDiff();
    document.addEventListener("keydown", onKey, true);
    activeDiffOverlay = close;
  }

  function mountLog(root) {
    const state = {
      repo: null,
      commits: [],
      error: null,
      repoPath: null,
      branches: [],
      selection: null,
      changedFiles: [],
      details: null,
      search: "",
      branchFilter: "",
      pathFilter: "",
      showGraph: true,
      firstParent: false,
      noMerges: false,
      topo: false,
      showBranches: true,
      showDetails: true,
      detailHeight: 46,
    };

    const toolbar = h("div", { class: "toolbar" });
    let searchButton = null;
    const branchHolder = h("div", { style: { display: "contents" } });
    const branchWidget = PIG.branchWidget.mount(branchHolder, { onChanged: () => refresh() });
    const listHost = h("div", { class: "scroll", style: { flex: "1 1 auto" } });
    const branchesHost = h("div", { class: "scroll" });
    const branchesPane = h("div", { class: "pane branches-pane column" });
    const changedHost = h("div", { class: "scroll list changed-files" });
    const detailsHost = h("div", { class: "commit-details details-pane" });
    const detailPane = h("div", { class: "log-detail" });
    const commitsPane = h("div", { class: "commits-pane" });
    const splitter = h("div", { class: "splitter-y" });
    const panes = h("div", { class: "log-panes" });

    function paintToolbar() {
      PIG.clear(toolbar);
      toolbar.append(branchHolder);
      toolbar.append(h("div", { class: "toolbar-separator" }));
      toolbar.append(iconButton("refresh", tip("refresh", KEYS.refresh), () => refresh()));
      // Held in a variable so the Find shortcut can open the same popup.
      searchButton = iconButton("search", tip("search", KEYS.find), (event) => {
        const field = h("input", { type: "text", value: state.search, placeholder: t("search") });
        field.addEventListener("input", () => { state.search = field.value; paintList(); });
        popup(event.currentTarget, [{ type: "custom", node: field }], { focus: true });
      });
      toolbar.append(searchButton);
      toolbar.append(iconButton("branch", state.branchFilter || t("allBranches"), (event) => {
        popup(event.currentTarget, [
          { type: "label", label: t("filterByBranch") },
          { label: t("allBranches"), checked: !state.branchFilter, onSelect: () => { state.branchFilter = ""; loadLog(); } },
          ...state.branches.filter((branch) => !branch.remote).map((branch) => ({
            label: branch.name,
            checked: state.branchFilter === branch.name,
            onSelect: () => { state.branchFilter = branch.name; loadLog(); },
          })),
        ]);
      }));
      toolbar.append(iconButton("file", t("filterByPaths"), (event) => {
        const field = h("input", { type: "text", value: state.pathFilter, placeholder: "src/…" });
        field.addEventListener("input", () => { state.pathFilter = field.value; paintList(); });
        popup(event.currentTarget, [
          { type: "label", label: t("filterByPaths") },
          { type: "custom", node: field },
        ], { focus: true });
      }));
      toolbar.append(iconButton("gear", t("graphOptions"), (event) => {
        popup(event.currentTarget, [
          { type: "label", label: t("graphOptions") },
          { label: t("byCommitDate"), checked: !state.topo, onSelect: () => { state.topo = false; loadLog(); } },
          { label: t("topologically"), checked: state.topo, onSelect: () => { state.topo = true; loadLog(); } },
          { type: "separator" },
          { label: t("showFirstParent"), checked: state.firstParent, onSelect: () => { state.firstParent = !state.firstParent; loadLog(); } },
          { label: t("noMerges"), checked: state.noMerges, onSelect: () => { state.noMerges = !state.noMerges; loadLog(); } },
          { type: "separator" },
          { label: t("showGraph"), checked: state.showGraph, onSelect: () => { state.showGraph = !state.showGraph; paintList(); } },
          { label: t("branches"), checked: state.showBranches, onSelect: () => { state.showBranches = !state.showBranches; paintPanes(); } },
          { label: t("showDetails"), checked: state.showDetails, onSelect: () => { state.showDetails = !state.showDetails; paintPanes(); } },
        ]);
      }));
      toolbar.append(h("div", { class: "toolbar-spacer" }));
      toolbar.append(h("div", { class: "toolbar-spacer" }));
      // Name whichever folder is open: the repository root when there is one,
      // otherwise the workspace, so the empty state has something to point at.
      const folder = state.repo?.repo?.name
        ?? (state.repoPath ? state.repoPath.split(/[/\\]/).filter(Boolean).at(-1) : "");
      toolbar.append(h("span", {
        style: { fontSize: "11px", color: "var(--fg-muted)" },
        title: state.repoPath ?? "",
        text: folder ?? "",
      }));
    }

    function visibleCommits() {
      const search = state.search.trim().toLowerCase();
      return state.commits.filter((commit) => {
        if (search && !`${commit.subject} ${commit.short} ${commit.author}`.toLowerCase().includes(search)) return false;
        return true;
      });
    }

    function paintList() {
      PIG.clear(listHost);
      // A workspace that is not a repository (or a missing git binary) has to
      // say so: an empty list reads as "this tool is broken" instead of
      // "there is nothing here to show".
      if (state.error) {
        listHost.append(h("div", { class: "empty-state" }, [
          h("div", { class: "headline", text: t("notARepository") }),
          h("code", { text: state.repoPath ?? "" }),
          h("div", { class: "muted", text: t("repositoryHint") }),
        ]));
        return;
      }
      const commits = visibleCommits();
      if (!commits.length) {
        listHost.append(h("div", { class: "empty-state" }, [
          h("div", { class: "headline", text: t("noCommits") }),
        ]));
        return;
      }
      const layout = assignLanes(commits);
      const headOid = state.repo?.branch?.oid;
      const me = state.repo?.user;

      layout.rows.forEach((row, index) => {
        const commit = row.commit;
        const isHead = Boolean(headOid) && commit.hash === headOid;
        const selected = state.selection === commit.hash;
        const node = h("div", {
          class: `log-row${isHead ? " current-branch" : ""}${me && commit.author === me ? " mine" : ""}`,
          role: "option",
          tabindex: "0",
          "aria-selected": selected ? "true" : "false",
          style: { "--graph-width": state.showGraph ? `${layout.width}px` : "6px" },
          onclick: () => select(commit.hash),
          oncontextmenu: (event) => {
            event.preventDefault();
            select(commit.hash);
            commitContextMenu(event.currentTarget, commit);
          },
        }, [
          state.showGraph ? h("div", { class: "log-graph" }, [graphNode(row, layout)]) : h("div"),
          h("div", { class: "log-body" }, [
            h("div", { class: "log-subject", title: commit.subject, text: commit.subject }),
            h("div", { class: "log-meta-line" }, [
              ...refBadges(commit),
              h("span", { class: "log-author", text: commit.author }),
              h("span", { class: "log-date", text: PIG.relativeTime(commit.timestamp) }),
              h("span", { class: "log-hash", text: commit.short }),
            ]),
          ]),
        ]);

        node.addEventListener("keydown", (event) => {
          const move = (target) => {
            const next = layout.rows[target];
            if (!next) return;
            select(next.commit.hash);
            listHost.children[target]?.focus();
          };
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(commit.hash);
          }
          if (event.key === "ArrowDown") { event.preventDefault(); move(index + 1); }
          if (event.key === "ArrowUp") { event.preventDefault(); move(index - 1); }
        });
        listHost.append(node);
      });
    }

    function paintBranches() {
      PIG.clear(branchesHost);
      const groups = [
        { label: t("localBranches"), items: state.branches.filter((branch) => !branch.remote) },
        { label: t("remoteBranches"), items: state.branches.filter((branch) => branch.remote) },
      ];
      if (!state.showBranches) return;
      for (const group of groups) {
        if (!group.items.length) continue;
        branchesHost.append(h("div", { class: "group-header" }, [
          h("span", { text: group.label }),
          h("span", { class: "count", text: `${group.items.length}` }),
        ]));
        for (const branch of group.items) {
          branchesHost.append(h("div", {
            class: "tree-row",
            tabindex: "0",
            title: branch.subject,
            onclick: () => checkout(branch),
            oncontextmenu: (event) => {
              event.preventDefault();
              popup(event.currentTarget, branchActions(branch));
            },
          }, [
            h("span", { class: "indent", style: { width: "8px" } }),
            branch.current
              ? h("span", { class: "status-cell", style: { color: "var(--graph-head)" }, text: "●" })
              : h("span", { class: "indent", style: { width: "12px" } }),
            h("span", { class: "name", text: branch.name }),
          ]));
        }
      }
    }

    async function checkout(branch) {
      if (branch.current) return;
      const result = await invoke("git/checkout", { name: branch.name, startPoint: branch.remote ? branch.name : undefined });
      toast(result.ok ? `${t("checkout")}: ${branch.name}` : result.message, result.ok ? "info" : "error");
      await refresh();
    }

    function branchActions(branch) {
      return [
        { label: t("checkout"), disabled: branch.current, onSelect: () => checkout(branch) },
        {
          label: t("newBranchFromHere"),
          onSelect: async () => {
            const name = await dialog({
              title: t("newBranchFromHere"),
              message: `${t("newBranch")} @ ${branch.name}`,
              input: { value: "" },
              confirmLabel: t("newBranch"),
            });
            if (!name) return;
            const result = await invoke("git/checkout", { name, create: true, startPoint: branch.name });
            toast(result.ok ? `${t("newBranch")}: ${name}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        { type: "separator" },
        {
          label: t("push"),
          onSelect: async () => {
            const result = await invoke("git/push", {
              remote: "origin",
              branch: state.repo?.branch?.head,
              setUpstream: !state.repo?.branch?.upstream,
            });
            toast(result.ok ? t("push") : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        { label: t("fetch"), onSelect: async () => { await invoke("git/fetch"); await refresh(); } },
      ];
    }

    function paintDetail() {
      PIG.clear(changedHost);
      PIG.clear(detailsHost);
      if (!state.selection) {
        changedHost.append(h("div", { class: "empty-state" }, [h("div", { class: "headline", text: t("changedFiles") })]));
        return;
      }
      for (const file of state.changedFiles) {
        const { name, directory } = PIG.splitPath(file.path);
        changedHost.append(h("div", {
          class: "tree-row",
          tabindex: "0",
          title: file.path,
          onclick: () => openCommitDiff(file.path),
        }, [
          h("span", { class: "indent", style: { width: "8px" } }),
          h("span", { class: "status-cell", style: { color: PIG.statusColor(file.status) }, text: file.status }),
          h("span", { class: "name", text: name }),
          directory ? h("span", { class: "path", text: directory }) : null,
        ]));
      }
      const details = state.details;
      if (!details) return;
      detailsHost.append(h("dl", null, [
        h("dt", { text: t("hash") }), h("dd", { class: "mono", text: details.hash ?? "" }),
        h("dt", { text: t("author") }), h("dd", { text: details.author ? `${details.author} <${details.email ?? ""}>` : "" }),
        h("dt", { text: t("date") }), h("dd", { text: PIG.formatDateTime(details.timestamp) }),
        h("dt", { text: t("subject") }), h("dd", { text: details.subject ?? "" }),
      ]));
      if (details.body) detailsHost.append(h("div", { class: "message-body", text: details.body }));
    }

    function paintPanes() {
      branchesPane.classList.toggle("hidden", !state.showBranches);
      detailPane.classList.toggle("hidden", !state.showDetails);
      splitter.classList.toggle("hidden", !state.showDetails);
    }

    function paintAll() {
      paintToolbar();
      paintBranches();
      paintList();
      paintDetail();
      paintPanes();
    }

    async function openCommitDiff(path) {
      if (!state.selection) return;
      const result = await invoke("git/commit-diff", { hash: state.selection });
      if (!result.ok) {
        toast(PIG.errorText(result), "error");
        return;
      }
      const parsed = PIG.diff.parse(result.text);
      if (path) {
        const single = parsed.files.find((entry) => PIG.diff.displayPath(entry) === path);
        // Fall back to the whole commit if the path is not in the patch.
        if (single) {
          openDiffOverlay(path, PIG.diff.patchFor(single, single.hunks));
          return;
        }
      }
      // No file picked: show the commit in full. Rendering only the first file
      // would quietly hide the rest of a multi-file commit.
      const summary = `${result.meta?.short ?? ""}`
        + (parsed.files.length > 1 ? ` · ${parsed.files.length} ${t("files")}` : "");
      openDiffOverlay(summary.trim() || t("showDiff"), result.text);
    }

    function commitContextMenu(anchor, commit) {
      const isHead = Boolean(state.repo?.branch?.oid) && commit.hash === state.repo.branch.oid;
      popup(anchor, [
        { label: t("showDiff"), onSelect: () => openCommitDiff(null) },
        { label: t("copyRevisionNumber"), onSelect: () => PIG.copyText(commit.hash) },
        { type: "separator" },
        {
          label: t("checkoutRevision"),
          onSelect: async () => {
            const result = await invoke("git/checkout", { name: commit.hash });
            toast(result.ok ? `${t("checkoutRevision")}: ${commit.short}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("newBranchFromHere"),
          onSelect: async () => {
            const name = await dialog({
              title: t("newBranchFromHere"),
              message: `${t("newBranch")} @ ${commit.short}`,
              input: { value: "" },
              confirmLabel: t("newBranch"),
            });
            if (!name) return;
            const result = await invoke("git/checkout", { name, create: true, startPoint: commit.hash });
            toast(result.ok ? `${t("newBranch")}: ${name}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("newTag"),
          onSelect: async () => {
            const name = await dialog({
              title: t("newTag"),
              message: `${t("newTag")} @ ${commit.short}`,
              input: { value: "" },
              confirmLabel: t("newTag"),
            });
            if (!name) return;
            const result = await invoke("git/tag", { name, hash: commit.hash });
            toast(result.ok ? `${t("newTag")}: ${name}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        { type: "separator" },
        {
          label: t("cherryPick"),
          onSelect: async () => {
            const result = await invoke("git/cherry-pick", { hash: commit.hash });
            toast(result.ok ? `${t("cherryPick")}: ${commit.short}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("revert"),
          onSelect: async () => {
            const result = await invoke("git/revert", { hash: commit.hash });
            toast(result.ok ? `${t("revert")}: ${commit.short}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("resetToHere"),
          onSelect: async () => {
            const mode = await dialog({
              title: t("resetToHere"),
              message: `${t("reset")} --mode ${commit.short}`,
              detail: `${t("soft")} | ${t("mixed")} | ${t("hard")}`,
              input: { value: "mixed" },
              confirmLabel: t("reset"),
              danger: true,
            });
            if (!mode) return;
            const result = await invoke("git/reset", { hash: commit.hash, mode: String(mode).trim().toLowerCase() });
            toast(result.ok ? `${t("reset")} --${mode} ${commit.short}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("editCommitMessage"),
          disabled: !isHead,
          title: isHead ? t("editCommitMessage") : `${t("editCommitMessage")} — ${t("head")} only`,
          onSelect: async () => {
            const message = await dialog({
              title: t("editCommitMessage"),
              message: commit.subject,
              input: { value: commit.subject },
              confirmLabel: t("ok"),
            });
            if (!message) return;
            const result = await invoke("git/amend-message", { message });
            toast(result.ok ? t("editCommitMessage") : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
      ]);
    }

    async function select(hash) {
      state.selection = hash;
      paintList();
      const [files, details] = await Promise.all([
        invoke("git/commit-files", { hash }),
        invoke("git/commit-diff", { hash }),
      ]);
      state.changedFiles = files.files ?? [];
      state.details = details.meta ?? null;
      paintDetail();
    }

    async function loadLog() {
      const result = await invoke("git/log", {
        limit: 200,
        branch: state.branchFilter || undefined,
        firstParent: state.firstParent,
        noMerges: state.noMerges,
        topo: state.topo,
      });
      state.commits = result.commits ?? [];
      if (state.selection && !state.commits.some((commit) => commit.hash === state.selection)) {
        state.selection = null;
        state.changedFiles = [];
        state.details = null;
      }
      paintList();
      paintDetail();
      if (!state.selection && state.commits.length) await select(state.commits[0].hash);
    }

    async function loadBranches() {
      const result = await invoke("git/branches");
      state.branches = result.branches ?? [];
      paintBranches();
    }

    async function refresh() {
      const repo = await invoke("git/repo");
      state.repo = repo.ok ? repo : null;
      state.error = repo.ok ? null : (repo.message ?? t("notARepository"));
      state.repoPath = repo.ok ? null : await currentFolder();
      await Promise.all([loadBranches(), loadLog()]);
      branchWidget.update(state.repo);
      paintToolbar();
    }

    /** The folder to name in the "not a repository" message. */
    async function currentFolder() {
      const workspace = await invoke("workspace.get");
      return workspace?.path ?? null;
    }

    branchesPane.append(
      h("div", { class: "pane-header" }, [h("span", { text: t("branches") })]),
      branchesHost,
    );
    detailPane.append(
      h("div", { class: "pane-header" }, [
        h("span", { text: t("changedFiles") }),
        h("div", { class: "toolbar-spacer" }),
        iconButton("diff", tip("showDiff", KEYS.showDiff), () => openCommitDiff(null), { size: 13 }),
      ]),
      changedHost,
      h("div", { class: "pane-header", style: { borderTop: "1px solid var(--border-soft)" } }, [
        h("span", { text: t("commitDetails") }),
      ]),
      detailsHost,
    );
    commitsPane.append(listHost, splitter, detailPane);
    panes.append(branchesPane, h("div", { class: "divider-v" }), commitsPane);
    root.append(toolbar, panes);

    PIG.bindSplitter(splitter, (delta) => {
      const total = commitsPane.clientHeight || 1;
      state.detailHeight = Math.max(18, Math.min(80, state.detailHeight - (delta / total) * 100));
      detailPane.style.height = `${state.detailHeight}%`;
    }, { vertical: true });

    PIG.bindShortcuts([
      { spec: KEYS.refresh, run: () => { refresh().catch(() => {}); } },
      { spec: KEYS.refreshAlt, run: () => { refresh().catch(() => {}); } },
      { spec: KEYS.showDiff, run: () => { if (state.selection) openCommitDiff(null); } },
      { spec: KEYS.find, run: () => { searchButton.click(); } },
      // The app's own accelerators cannot reach this webContents; say so.
      PIG.appShortcutHintBinding(),
    ]);

    PIG.watchWorkspace(() => { refresh().catch(() => {}); });
    refresh().catch((error) => toast(String(error?.message ?? error), "error"));

    return { refresh, selectCommit: select, openCommitDiff };
  }

  function mountConsole(root) {
    const state = { entries: [] };
    const toolbar = h("div", { class: "toolbar" });
    const host = h("div", { class: "console" });

    function paint() {
      PIG.clear(toolbar);
      toolbar.append(iconButton("refresh", tip("refresh", KEYS.refresh), () => refresh()));
      toolbar.append(h("button", {
        class: "bordered",
        type: "button",
        text: t("clearAll"),
        onclick: async () => {
          await invoke("git/console-clear");
          state.entries = [];
          paint();
        },
      }));
      toolbar.append(h("div", { class: "toolbar-spacer" }));
      toolbar.append(h("span", { class: "muted", style: { fontSize: "11px" }, text: `${state.entries.length}` }));

      PIG.clear(host);
      if (!state.entries.length) {
        host.append(h("div", { class: "empty-state" }, [h("div", { class: "headline", text: t("console") })]));
        return;
      }
      for (const entry of state.entries) {
        const node = h("div", { class: "console-entry" }, [
          h("div", { class: "console-cmd" }, [
            h("span", { class: "console-time", text: `[${PIG.formatClock(entry.ts)}] ` }),
            `$ ${entry.command}`,
          ]),
        ]);
        if (entry.stdout?.trim()) node.append(h("pre", { class: "console-out", text: entry.stdout.trimEnd() }));
        if (entry.stderr?.trim()) node.append(h("pre", { class: "console-out failure", text: entry.stderr.trimEnd() }));
        if (!entry.ok && entry.message) node.append(h("pre", { class: "console-out failure", text: entry.message }));
        host.append(node);
      }
      host.scrollTop = host.scrollHeight;
    }

    async function refresh() {
      const result = await invoke("git/console");
      state.entries = result.entries ?? [];
      paint();
    }

    root.append(toolbar, host);
    refresh().catch(() => {});
    return { refresh };
  }

  /** Tabs over Log and Console, which is exactly IDEA's Git tool window. */
  function mountGitWindow(root) {
    const tabs = h("div", { class: "tabs" });
    const logSurface = h("div", { class: "column grow" });
    const consoleSurface = h("div", { class: "column grow hidden" });

    const logView = mountLog(logSurface);
    const consoleView = mountConsole(consoleSurface);

    let active = "log";
    function paintTabs() {
      PIG.clear(tabs);
      for (const tab of [{ id: "log", label: t("log") }, { id: "console", label: t("console") }]) {
        tabs.append(h("button", {
          type: "button",
          role: "tab",
          "aria-selected": active === tab.id ? "true" : "false",
          text: tab.label,
          onclick: () => {
            active = tab.id;
            logSurface.classList.toggle("hidden", active !== "log");
            consoleSurface.classList.toggle("hidden", active !== "console");
            paintTabs();
            if (active === "console") consoleView.refresh();
          },
        }));
      }
    }
    paintTabs();

    root.append(tabs, logSurface, consoleSurface);
    window.addEventListener("pig:appearance", paintTabs);
    return { refresh: () => { logView.refresh(); if (active === "console") consoleView.refresh(); } };
  }

  /** The detached panel hosts both tool windows behind one tab bar. */
  function mountBoth(root) {
    const tabs = h("div", { class: "tabs" });
    const commitSurface = h("div", { class: "column grow" });
    const gitSurface = h("div", { class: "column grow hidden" });
    let active = "commit";

    PIG.commitView.mount(commitSurface);
    mountGitWindow(gitSurface);

    function paintTabs() {
      PIG.clear(tabs);
      // The Git tab holds the Log *and* Console, so labelling it "Log" would
      // collide with the tab inside it.
      for (const tab of [{ id: "commit", label: t("commit") }, { id: "git", label: t("git") }]) {
        tabs.append(h("button", {
          type: "button",
          role: "tab",
          "aria-selected": active === tab.id ? "true" : "false",
          text: tab.label,
          onclick: () => {
            active = tab.id;
            commitSurface.classList.toggle("hidden", active !== "commit");
            gitSurface.classList.toggle("hidden", active !== "git");
            paintTabs();
          },
        }));
      }
    }
    paintTabs();
    root.append(tabs, commitSurface, gitSurface);
    window.addEventListener("pig:appearance", paintTabs);
  }

  function boot() {
    const root = document.getElementById("app");
    if (!root) return;
    PIG.watchAppearance();
    const surface = window.__PI_IDEA_GIT_SURFACE__ ?? "commit";
    if (surface === "git") {
      mountGitWindow(root);
      return;
    }
    if (surface === "commit") {
      PIG.commitView.mount(root);
      return;
    }
    mountBoth(root);
  }

  PIG.gitView = { mount: mountGitWindow, mountLog, mountConsole, assignLanes, openDiffOverlay };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window.PIG || (window.PIG = {}));
