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
  // TODO: LANE_COLORS theming is out of scope — these fixed hues stay as-is;
  // moving them into theme.css variables would touch every graph painter.
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
      tags: [],
      remotes: [],
      stashes: [],
      selection: null,
      changedFiles: [],
      details: null,
      search: "",
      branchFilter: "",
      pathFilter: "",
      userFilter: "",
      sinceFilter: "",
      collapsed: Object.create(null),
      showGraph: true,
      firstParent: false,
      noMerges: false,
      topo: false,
      showBranches: true,
      showDetails: true,
      detailHeight: 46,
      // What the toolbar is waiting on (null | "refresh" | "push" | "fetch" | "pull"): the active
      // button spins, the others go disabled.
      syncing: null,
    };
    // Path-filter reloads are debounced: each keystroke is cheap locally but a
    // `git log` process is not.
    let pathTimer = null;

    const toolbar = h("div", { class: "toolbar" });
    let searchButton = null;
    // The repository chip first, then the branch: which repository, and only
    // then which branch of it.
    const repoHolder = h("div", { style: { display: "contents" } });
    /**
     * A switch drops what the leaving repository owned *before* the reload
     * starts: the commit list and its context menus stay live during a refresh,
     * and they name revisions of a repository the window has already left.
     */
    const repoWidget = PIG.repoSelector.mount(repoHolder, {
      onSwitch: () => {
        forgoRepositoryState();
        paintList();
        paintDetail();
        refresh().catch(() => {});
      },
    });
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

    /** 按钮文案："" → 全部，"me" → 只看我的，具名 → 名字本身。 */
    function userFilterLabel() {
      if (state.userFilter === "me") return t("mineOnly");
      return state.userFilter || t("all");
    }

    function userFilterButton() {
      const button = PIG.textButton(
        `${t("filterByUser")}: ${userFilterLabel()}`,
        state.userFilter && state.userFilter !== "me"
          ? `${t("filterByUser")}: ${state.userFilter}`
          : t("filterByUser"),
        (event) => openUserFilterMenu(event.currentTarget),
        { class: "bordered user-filter" },
      );
      // 选中的名字可能很长：截断保住工具栏，其余分支/日期按钮不动。
      button.style.maxWidth = "240px";
      button.style.overflow = "hidden";
      button.style.textOverflow = "ellipsis";
      button.style.whiteSpace = "nowrap";
      return button;
    }

    /**
     * 切过滤先重画工具栏再拉日志：按钮文案本身就是选中态的反馈，
     * 只调 loadLog 的话文案会停在旧值直到下次整刷（分支/日期按钮同病，
     * 但那是既有行为不在本次范围）。
     */
    function applyUserFilter(value) {
      state.userFilter = value;
      paintToolbar();
      loadLog();
    }


    /**
     * IDEA 式的提交者菜单：全部 / 只看我的 / 最近提交者（带提交数）/ 手输。
     * 名单来自 `git/authors`（近 2000 条提交聚合，取前 20）；手输按名字或
     * 邮箱走服务端 `--author` 过滤，回车即用，名单之外的人也能滤。
     */
    async function openUserFilterMenu(anchor) {
      let authors = [];
      try {
        const result = await invoke("git/authors", { limit: 20 });
        if (result?.ok) authors = result.authors ?? [];
      } catch {
        authors = [];
      }
      // 工具栏每次刷新都会重建按钮，await 期间按钮可能已被替换——按标记类
      // 找回活的按钮，找不到才放弃（下次点击自然有活锚点）。
      const live = anchor?.isConnected ? anchor : toolbar.querySelector(".user-filter");
      if (!live) return;
      const listed = authors.filter((entry) => entry?.name);
      const items = [
        { type: "label", label: t("filterByUser") },
        { label: t("all"), checked: !state.userFilter, onSelect: () => applyUserFilter("") },
        {
          label: t("mineOnly"),
          title: state.repo?.user ? `${t("mineOnly")} — ${state.repo.user}` : t("mineOnly"),
          checked: state.userFilter === "me",
          onSelect: () => applyUserFilter("me"),
        },
      ];
      if (listed.length || (state.userFilter && state.userFilter !== "me")) {
        items.push({ type: "separator" }, { type: "label", label: t("recentUsers") });
        // 当前手输值不在名单里时单独给一行带勾，避免“选了却看不见选中态”。
        if (state.userFilter && state.userFilter !== "me" && !listed.some((entry) => entry.name === state.userFilter)) {
          items.push({ label: state.userFilter, checked: true, onSelect: () => applyUserFilter(state.userFilter) });
        }
        for (const entry of listed) {
          items.push({
            label: entry.name,
            shortcut: entry.count > 1 ? `${entry.count}` : undefined,
            title: entry.email ? `${entry.name} <${entry.email}>` : entry.name,
            checked: state.userFilter === entry.name,
            onSelect: () => applyUserFilter(entry.name),
          });
        }
      }
      const field = h("input", {
        type: "text",
        value: state.userFilter && state.userFilter !== "me" ? state.userFilter : "",
        placeholder: t("filterUserPlaceholder"),
      });
      field.addEventListener("keydown", (keyEvent) => {
        if (keyEvent.key !== "Enter") return;
        PIG.closePopup();
        applyUserFilter(field.value.trim());
      });
      items.push({ type: "separator" }, { type: "custom", node: field });
      try {
        popup(live, items, { focus: true });
      } catch {
        // 解析与打开之间工具栏又重建了：这次放弃，下次点击即是活锚点。
      }
    }

    function paintToolbar() {
      PIG.clear(toolbar);
      toolbar.append(repoHolder);
      toolbar.append(branchHolder);
      toolbar.append(h("div", { class: "toolbar-separator" }));
      const syncDisabled = Boolean(state.syncing);
      const syncButton = (name, title, kind, onClick) => {
        const button = iconButton(name, title, onClick, { disabled: syncDisabled });
        if (state.syncing === kind) {
          button.classList.add("busy");
          button.append(PIG.spinner(false));
        }
        return button;
      };
      toolbar.append(syncButton("refresh", tip("refresh", KEYS.refresh), "refresh", async () => {
        if (state.syncing) return;
        state.syncing = "refresh";
        paintToolbar();
        try {
          await refresh();
        } finally {
          state.syncing = null;
          paintToolbar();
        }
      }));
      toolbar.append(syncButton("push", t("push"), "push", async () => {
        if (state.syncing) return;
        // Note: Git 视图的 Push 同样走多仓对话框，单仓时对话框内只有一行 — 见 .agents/notes/implemented/architecture/2026-09-12-multi-repo-push.md
        state.syncing = "push";
        paintToolbar();
        try {
          await PIG.openPushDialog({ onPushed: async () => { await refresh(); } });
          await refresh();
        } finally {
          state.syncing = null;
          paintToolbar();
        }
      }));
      toolbar.append(syncButton("fetch", t("fetch"), "fetch", async () => {
        if (state.syncing) return;
        state.syncing = "fetch";
        paintToolbar();
        try {
          PIG.reportSync(await PIG.runWithPill(t("fetching"), () => invoke("git/fetch")), t("fetch"));
          await refresh();
        } finally {
          state.syncing = null;
          paintToolbar();
        }
      }));
      toolbar.append(syncButton("arrowDown", t("pull"), "pull", async () => {
        if (state.syncing) return;
        state.syncing = "pull";
        paintToolbar();
        try {
          const result = await PIG.runWithPill(t("pulling"), () => invoke("git/pull"));
          PIG.reportSync(result, t("pull"));
          await refresh();
        } finally {
          state.syncing = null;
          paintToolbar();
        }
      }));
      toolbar.append(iconButton("arrowUp", t("goToHead"), (event) => {
        const head = state.repo?.branch?.oid;
        if (!head) return;
        select(head).then(() => {
          const node = listHost.querySelector(".log-row.current-branch");
          node?.scrollIntoView({ block: "center" });
          node?.focus();
        }).catch(() => {});
      }));
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
      // Note: 提交者过滤抄 IDEA 的三段式——全部 / 只看我的 / 最近提交者名单 + 手输（名字或邮箱回车即滤），"me" 按仓库自身 user.name 解析所以跟仓走，具名作者是仓相关的、切仓时丢掉 — 见 .agents/notes/implemented/feature/2026-09-14-git-log-user-filter.md
      toolbar.append(userFilterButton());
      toolbar.append(PIG.textButton(
        `${t("date")}: ${state.sinceFilter === "day" ? t("lastDay") : state.sinceFilter === "week" ? t("lastWeek") : state.sinceFilter === "month" ? t("lastMonth") : t("anyTime")}`,
        t("date"),
        (event) => {
          popup(event.currentTarget, [
            { type: "label", label: t("date") },
            { label: t("anyTime"), checked: !state.sinceFilter, onSelect: () => { state.sinceFilter = ""; loadLog(); } },
            { label: t("lastDay"), checked: state.sinceFilter === "day", onSelect: () => { state.sinceFilter = "day"; loadLog(); } },
            { label: t("lastWeek"), checked: state.sinceFilter === "week", onSelect: () => { state.sinceFilter = "week"; loadLog(); } },
            { label: t("lastMonth"), checked: state.sinceFilter === "month", onSelect: () => { state.sinceFilter = "month"; loadLog(); } },
          ]);
        },
      ));
      toolbar.append(iconButton("file", state.pathFilter || t("filterByPaths"), (event) => {
        const field = h("input", { type: "text", value: state.pathFilter, placeholder: "src/…" });
        field.addEventListener("input", () => {
          state.pathFilter = field.value;
          if (pathTimer !== null) window.clearTimeout(pathTimer);
          // Note: 路径过滤走服务端 `git log -- <path>` 而非本地隐藏行——本地过滤会把有路径的提交也藏掉，且与分支/用户过滤语义不一致 — 见 .agents/notes/implemented/feature/2026-09-14-git-operations-parity.md
          pathTimer = window.setTimeout(() => { pathTimer = null; loadLog(); }, 450);
        });
        field.addEventListener("keydown", (keyEvent) => {
          if (keyEvent.key === "Enter") {
            if (pathTimer !== null) { window.clearTimeout(pathTimer); pathTimer = null; }
            loadLog();
          }
        });
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
      if (!state.showBranches) return;
      paintHeadRow();
      paintBranchGroup(t("localBranches"), state.branches.filter((branch) => !branch.remote), "local");
      paintBranchGroup(t("remoteBranches"), state.branches.filter((branch) => branch.remote), "remote");
      paintTagGroup();
      paintRemoteGroup();
      paintStashGroup();
    }

    /** IDEA pins HEAD above Local — the revision the window is standing on. */
    function paintHeadRow() {
      const branch = state.repo?.branch;
      if (!branch) return;
      const name = branch.head ?? (branch.detached ? `detached @ ${String(branch.oid ?? "").slice(0, 8)}` : t("head"));
      branchesHost.append(h("div", {
        class: "tree-row",
        tabindex: "0",
        title: `${t("head")}: ${name}`,
        onclick: () => {
          if (branch.oid) select(branch.oid).catch(() => {});
        },
        oncontextmenu: (event) => {
          event.preventDefault();
          const head = state.commits.find((commit) => commit.hash === branch.oid);
          if (head) commitContextMenu(event.currentTarget, head);
        },
      }, [
        h("span", { class: "status-cell", style: { color: "var(--graph-head)" }, text: "◆" }),
        h("span", { class: "name", text: `HEAD (${name})` }),
      ]));
    }

    /** IDEA folds `feature/*` into one expandable node — same here, per group. */
    function folderOf(remote, name) {
      const parts = String(name).split("/");
      if (parts.length < 2) return "";
      return remote ? parts[0] : parts.slice(0, -1).join("/");
    }

    function leafOf(remote, name) {
      const parts = String(name).split("/");
      if (parts.length < 2) return name;
      return remote ? parts.slice(1).join("/") : parts[parts.length - 1];
    }

    function paintBranchGroup(label, items, key) {
      if (!items.length) return;
      branchesHost.append(h("div", { class: "group-header" }, [
        h("span", { text: label }),
        h("span", { class: "count", text: `${items.length}` }),
      ]));
      const folders = new Map();
      const loose = [];
      for (const branch of items) {
        const folder = folderOf(branch.remote, branch.name);
        if (folder) {
          if (!folders.has(folder)) folders.set(folder, []);
          folders.get(folder).push(branch);
        } else {
          loose.push(branch);
        }
      }
      for (const folder of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
        const id = `${key}:${folder}`;
        const collapsed = Boolean(state.collapsed[id]);
        const rows = folders.get(folder);
        const header = h("div", {
          class: "tree-row",
          tabindex: "0",
          title: folder,
          onclick: () => { state.collapsed[id] = !state.collapsed[id]; paintBranches(); },
        }, [
          h("span", { class: "indent", style: { width: "8px" } }),
          icon(collapsed ? "chevronRight" : "chevronDown", 12),
          icon("folder", 13),
          h("span", { class: "name", text: folder }),
          h("span", { class: "count", text: `${rows.length}` }),
        ]);
        header.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            state.collapsed[id] = !state.collapsed[id];
            paintBranches();
          }
        });
        branchesHost.append(header);
        if (collapsed) continue;
        for (const branch of rows) branchesHost.append(branchRow(branch, leafOf(branch.remote, branch.name), 24));
      }
      for (const branch of loose) branchesHost.append(branchRow(branch, branch.name, 8));
    }

    function branchRow(branch, leaf, indent) {
      const row = h("div", {
        class: "tree-row",
        tabindex: "0",
        title: `${branch.name}${branch.upstream ? ` → ${branch.upstream}` : ""}${branch.subject ? `\n${branch.subject}` : ""}`,
        onclick: () => checkout(branch),
        oncontextmenu: (event) => {
          event.preventDefault();
          popup(event.currentTarget, branchActions(branch));
        },
      }, [
        h("span", { class: "indent", style: { width: `${indent}px` } }),
        branch.current
          ? h("span", { class: "status-cell", style: { color: "var(--graph-head)" }, text: "●" })
          : h("span", { class: "indent", style: { width: "12px" } }),
        h("span", { class: "name", text: leaf, title: branch.name }),
      ]);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          checkout(branch);
        }
      });
      return row;
    }

    function paintTagGroup() {
      if (!state.tags.length) return;
      branchesHost.append(h("div", { class: "group-header" }, [
        h("span", { text: t("tags") }),
        h("span", { class: "count", text: `${state.tags.length}` }),
      ]));
      for (const tag of state.tags) {
        const active = state.branchFilter === tag.name;
        const row = h("div", {
          class: "tree-row",
          tabindex: "0",
          title: `${tag.name}${tag.subject ? `\n${tag.subject}` : ""}`,
          onclick: () => {
            state.branchFilter = active ? "" : tag.name;
            loadLog();
          },
          oncontextmenu: (event) => {
            event.preventDefault();
            popup(event.currentTarget, tagActions(tag));
          },
        }, [
          h("span", { class: "indent", style: { width: "8px" } }),
          active
            ? h("span", { class: "status-cell", style: { color: "var(--graph-head)" }, text: "●" })
            : icon("tag", 12),
          h("span", { class: "name", text: tag.name }),
          tag.short ? h("span", { class: "path", text: tag.short }) : null,
        ]);
        branchesHost.append(row);
      }
    }

    function paintRemoteGroup() {
      if (!state.remotes.length) return;
      branchesHost.append(h("div", { class: "group-header" }, [
        h("span", { text: t("remotes") }),
        h("span", { class: "count", text: `${state.remotes.length}` }),
      ]));
      for (const remote of state.remotes) {
        const url = remote.fetch ?? remote.push ?? "";
        const row = h("div", {
          class: "tree-row",
          tabindex: "0",
          title: url || remote.name,
          onclick: (event) => popup(event.currentTarget, remoteActions(remote)),
          oncontextmenu: (event) => {
            event.preventDefault();
            popup(event.currentTarget, remoteActions(remote));
          },
        }, [
          h("span", { class: "indent", style: { width: "8px" } }),
          icon("branch", 12),
          h("span", { class: "name", text: remote.name }),
          url ? h("span", { class: "path", text: url }) : null,
        ]);
        branchesHost.append(row);
      }
    }

    function paintStashGroup() {
      if (!state.stashes.length) return;
      branchesHost.append(h("div", { class: "group-header" }, [
        h("span", { text: t("stashes") }),
        h("span", { class: "count", text: `${state.stashes.length}` }),
      ]));
      for (const stash of state.stashes) {
        const row = h("div", {
          class: "tree-row",
          tabindex: "0",
          title: `${stash.ref}${stash.subject ? `\n${stash.subject}` : ""}`,
          onclick: () => showStashDiff(stash),
          oncontextmenu: (event) => {
            event.preventDefault();
            popup(event.currentTarget, stashActions(stash));
          },
        }, [
          h("span", { class: "indent", style: { width: "8px" } }),
          h("span", { class: "status-cell", text: "≡" }),
          h("span", { class: "name", text: stash.subject || stash.ref }),
          h("span", { class: "path", text: PIG.relativeTime(stash.timestamp) }),
        ]);
        branchesHost.append(row);
      }
    }

    async function showStashDiff(stash) {
      const result = await invoke("git/stash-show", { ref: stash.ref });
      if (!result.ok) {
        toast(PIG.errorText(result), "error");
        return;
      }
      if (!String(result.text ?? "").trim()) {
        toast(t("noDiff"), "info");
        return;
      }
      openDiffOverlay(`${stash.ref} ${stash.subject ?? ""}`.trim(), result.text);
    }

    function tagActions(tag) {
      return [
        {
          label: t("newBranchFromHere"),
          onSelect: async () => {
            const name = await dialog({
              title: t("newBranchFromHere"),
              message: `${t("newBranch")} @ ${tag.name}`,
              input: { value: "" },
              confirmLabel: t("newBranch"),
            });
            if (!name) return;
            const result = await PIG.runWithPill(t("checkingOut"), () => invoke("git/checkout", { name, create: true, startPoint: tag.name }));
            toast(result.ok ? `${t("newBranch")}: ${name}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("pushTag"),
          onSelect: async () => {
            const result = await PIG.runWithPill(t("pushing"), () => invoke("git/tag-push", { name: tag.name }));
            PIG.reportSync(result, t("pushTag"));
            await refresh();
          },
        },
        { label: t("copy"), onSelect: () => PIG.copyText(tag.name) },
        { type: "separator" },
        {
          label: t("deleteTag"),
          onSelect: async () => {
            const confirmed = await dialog({
              title: t("deleteTagTitle"),
              message: tag.name,
              confirmLabel: t("deleteTag"),
              danger: true,
            });
            if (!confirmed) return;
            const result = await invoke("git/tag-delete", { name: tag.name });
            toast(result.ok ? `${t("deleteTag")}: ${tag.name}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
      ];
    }

    function remoteActions(remote) {
      return [
        {
          label: t("fetch"),
          onSelect: async () => {
            PIG.reportSync(await PIG.runWithPill(t("fetching"), () => invoke("git/fetch", { remote: remote.name })), t("fetch"));
            await refresh();
          },
        },
        {
          label: `${t("fetch")} (${t("prune")})`,
          onSelect: async () => {
            PIG.reportSync(await PIG.runWithPill(t("fetching"), () => invoke("git/fetch", { remote: remote.name, prune: true })), t("fetch"));
            await refresh();
          },
        },
        { label: t("copy"), onSelect: () => PIG.copyText(remote.fetch ?? remote.push ?? remote.name) },
      ];
    }

    function stashActions(stash) {
      return [
        { label: t("showStash"), onSelect: () => showStashDiff(stash) },
        {
          label: t("applyStash"),
          onSelect: async () => {
            const result = await PIG.runWithPill(t("unstashing"), () => invoke("git/stash", { action: "apply", ref: stash.ref }));
            toast(result.ok ? `${t("applyStash")}: ${stash.ref}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("unstash"),
          onSelect: async () => {
            const result = await PIG.runWithPill(t("unstashing"), () => invoke("git/stash", { action: "pop", ref: stash.ref }));
            toast(result.ok ? `${t("unstash")}: ${stash.ref}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        { type: "separator" },
        {
          label: t("dropStash"),
          onSelect: async () => {
            const confirmed = await dialog({
              title: t("dropStashConfirm"),
              message: `${stash.ref}  ${stash.subject ?? ""}`.trim(),
              confirmLabel: t("dropStash"),
              danger: true,
            });
            if (!confirmed) return;
            const result = await invoke("git/stash", { action: "drop", ref: stash.ref });
            toast(result.ok ? `${t("dropStash")}: ${stash.ref}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
      ];
    }

    async function checkout(branch) {
      if (branch.current) return;
      const result = await PIG.runWithPill(t("checkingOut"), () => invoke("git/checkout", { name: branch.name, startPoint: branch.remote ? branch.name : undefined, track: branch.remote ? true : undefined }));
      toast(result.ok ? `${t("checkout")}: ${branch.name}` : result.message, result.ok ? "info" : "error");
      await refresh();
    }

    function branchActions(branch) {
      // Note: 死文案接活——mergeIntoCurrent/rebaseOnto/deleteBranch 的 key 早就存在但零引用，本次把菜单真正挂上去 — 见 .agents/notes/implemented/feature/2026-09-14-git-operations-parity.md
      const items = [
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
            const result = await PIG.runWithPill(t("checkingOut"), () => invoke("git/checkout", { name, create: true, startPoint: branch.name }));
            toast(result.ok ? `${t("newBranch")}: ${name}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        { type: "separator" },
        {
          label: t("mergeIntoCurrent"),
          disabled: branch.current,
          onSelect: async () => {
            const confirmed = await dialog({
              title: t("mergeTitle"),
              message: `${branch.name} → ${state.repo?.branch?.head ?? t("head")}`,
              confirmLabel: t("merge"),
            });
            if (!confirmed) return;
            const result = await PIG.runWithPill(t("merge"), () => invoke("git/merge", { ref: branch.name }));
            if (result.ok) {
              toast(`${t("merge")}: ${branch.name}`, "info");
            } else {
              const text = String(result.message ?? "");
              const conflicted = /CONFLICT|Automatic merge failed|fix conflicts/i.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}\n${text}`);
              toast(`${t("merge")}: ${text}${conflicted ? `\n\n${t("mergeConflicts")}` : ""}`, "error");
            }
            await refresh();
          },
        },
        {
          label: t("rebaseOnto"),
          disabled: branch.current,
          onSelect: async () => {
            const confirmed = await dialog({
              title: t("rebaseTitle"),
              message: `${state.repo?.branch?.head ?? t("head")} → ${branch.name}`,
              confirmLabel: t("rebase"),
              danger: true,
            });
            if (!confirmed) return;
            const result = await PIG.runWithPill(t("rebase"), () => invoke("git/rebase", { ref: branch.name }));
            if (result.ok) {
              toast(`${t("rebase")}: ${branch.name}`, "info");
            } else {
              const text = String(result.message ?? "");
              const conflicted = /CONFLICT|could not apply|fix conflicts/i.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}\n${text}`);
              toast(`${t("rebase")}: ${text}${conflicted ? `\n\n${t("rebaseConflicts")}` : ""}`, "error");
            }
            await refresh();
          },
        },
        { type: "separator" },
      ];
      if (!branch.remote) {
        items.push(
          {
            label: t("renameBranch"),
            onSelect: async () => {
              const name = await dialog({
                title: t("renameTitle"),
                message: branch.name,
                input: { value: branch.name },
                confirmLabel: t("renameBranch"),
              });
              if (!name || name === branch.name) return;
              const result = await invoke("git/branch-rename", { old: branch.name, new: name });
              toast(result.ok ? `${t("renameBranch")}: ${name}` : result.message, result.ok ? "info" : "error");
              await refresh();
            },
          },
          {
            label: t("setUpstream"),
            onSelect: async () => {
              const upstream = await dialog({
                title: t("setUpstreamTitle"),
                message: branch.name,
                input: { value: branch.upstream ?? "" },
                confirmLabel: t("setUpstream"),
              });
              if (!upstream) return;
              const result = await invoke("git/branch-upstream", { name: branch.name, upstream });
              toast(result.ok ? `${t("setUpstream")}: ${upstream}` : result.message, result.ok ? "info" : "error");
              await refresh();
            },
          },
        );
        if (branch.upstream) {
          items.push({
            label: t("unsetUpstream"),
            onSelect: async () => {
              const result = await invoke("git/branch-upstream", { name: branch.name, unset: true });
              toast(result.ok ? t("unsetUpstream") : result.message, result.ok ? "info" : "error");
              await refresh();
            },
          });
        }
      }
      items.push(
        {
          label: t("deleteBranch"),
          disabled: branch.current,
          onSelect: async () => {
            const confirmed = await dialog({
              title: t("deleteBranchTitle"),
              message: branch.remote ? `${branch.name} (${t("remoteBranches")})` : branch.name,
              confirmLabel: t("deleteBranch"),
              danger: true,
            });
            if (!confirmed) return;
            const payload = branch.remote
              ? { name: branch.name, remote: branch.name.split("/")[0] }
              : { name: branch.name };
            let result = await invoke("git/branch-delete", payload);
            if (!result.ok && /not fully merged/i.test(String(result.message ?? ""))) {
              const force = await dialog({
                title: t("deleteBranchTitle"),
                message: result.message,
                confirmLabel: t("deleteBranch"),
                danger: true,
              });
              if (force) result = await invoke("git/branch-delete", { ...payload, force: true });
            }
            toast(result.ok ? `${t("deleteBranch")}: ${branch.name}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        { label: t("copyBranchName"), onSelect: () => PIG.copyText(branch.name) },
        { type: "separator" },
        {
          label: t("push"),
          onSelect: async () => {
            // No remote/branch: this menu belongs to the Log, where the item is
            // about the checked-out branch. The engine pushes where that branch
            // tracks instead of assuming `origin`.
            const result = await PIG.runWithPill(t("pushing"), () => invoke("git/push", { setUpstream: !state.repo?.branch?.upstream }));
            PIG.reportSync(result, t("push"));
            await PIG.refreshTrackingRefs(result);
            await refresh();
          },
        },
        {
          label: t("fetch"),
          onSelect: async () => {
            PIG.reportSync(await PIG.runWithPill(t("fetching"), () => invoke("git/fetch")), t("fetch"));
            await refresh();
          },
        },
      );
      return items;
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
        {
          label: t("copyMessage"),
          onSelect: () => {
            const body = state.selection === commit.hash && state.details?.hash === commit.hash
              ? String(state.details.body ?? "").trim()
              : "";
            PIG.copyText(body ? `${commit.subject}\n\n${body}` : commit.subject);
          },
        },
        {
          label: t("compareWithHead"),
          onSelect: async () => {
            const result = await invoke("git/compare", { a: "HEAD", b: commit.hash });
            if (!result.ok) {
              toast(PIG.errorText(result), "error");
              return;
            }
            if (!String(result.text ?? "").trim()) {
              toast(t("noDiff"), "info");
              return;
            }
            openDiffOverlay(`${t("compareWithHead")}: HEAD ↔ ${commit.short}`, result.text);
          },
        },
        { type: "separator" },
        {
          label: t("checkoutRevision"),
          onSelect: async () => {
            const result = await PIG.runWithPill(t("checkingOut"), () => invoke("git/checkout", { name: commit.hash }));
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
            const result = await PIG.runWithPill(t("checkingOut"), () => invoke("git/checkout", { name, create: true, startPoint: commit.hash }));
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
            const result = await PIG.runWithPill(t("cherryPick"), () => invoke("git/cherry-pick", { hash: commit.hash }));
            toast(result.ok ? `${t("cherryPick")}: ${commit.short}` : result.message, result.ok ? "info" : "error");
            await refresh();
          },
        },
        {
          label: t("revert"),
          onSelect: async () => {
            const result = await PIG.runWithPill(t("revert"), () => invoke("git/revert", { hash: commit.hash }));
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
            const result = await PIG.runWithPill(t("reset"), () => invoke("git/reset", { hash: commit.hash, mode: String(mode).trim().toLowerCase() }));
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
      const since = state.sinceFilter === "day" ? "1 day ago"
        : state.sinceFilter === "week" ? "1 week ago"
        : state.sinceFilter === "month" ? "1 month ago"
        : undefined;
      // Note: 具名作者直传服务端 `--author`（名字或邮箱都可），与 "me" 解析后的 user.name 走同一条路 — 见 main.js readLog
      const author = state.userFilter === "me"
        ? (state.repo?.user ?? undefined)
        : (state.userFilter.trim() ? state.userFilter.trim() : undefined);
      const paths = state.pathFilter.trim() ? [state.pathFilter.trim()] : undefined;
      const result = await invoke("git/log", {
        limit: 200,
        branch: state.branchFilter || undefined,
        firstParent: state.firstParent,
        noMerges: state.noMerges,
        topo: state.topo,
        author,
        since,
        paths,
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

    async function loadRefs() {
      const [branches, tags, remotes, stashes] = await Promise.all([
        invoke("git/branches"),
        invoke("git/tags"),
        invoke("git/remotes"),
        invoke("git/stashes"),
      ]);
      state.branches = branches.branches ?? [];
      state.tags = tags.tags ?? [];
      state.remotes = remotes.remotes ?? [];
      state.stashes = stashes.stashes ?? [];
      paintBranches();
    }
    /**

     * Which repository the loaded state belongs to. A commit selection, the
     * branch and path filters and the changed-file list are all
     * repository-relative, so a switch has to clear them rather than let them
     * keep describing the previous repository's history. `undefined` means
     * nothing has been loaded yet.
     */
    let loadedRepo;

    /** Drop everything that describes one repository, and only that one. */
    function forgoRepositoryState() {
      state.selection = null;
      state.changedFiles = [];
      state.details = null;
      state.commits = [];
      state.search = "";
      state.branchFilter = "";
      state.pathFilter = "";
      // A named author belongs to the repository just left; "me" re-resolves
      // against the new repository's own config, so only the named one is dropped.
      if (state.userFilter && state.userFilter !== "me") state.userFilter = "";
      state.tags = [];
      state.remotes = [];
      state.stashes = [];
      // A commit diff belongs to the commit it came from, and its actions name a
      // revision the new repository may not even have.
      activeDiffOverlay?.();
    }

    // Same dim-while-reloading contract as the Commit view: overlapping
    // refreshes share one counter so the list stays dimmed until the last one
    // settles instead of flashing mid-flight.
    let refreshDepth = 0;
    function setRefreshing(on) {
      refreshDepth = Math.max(0, refreshDepth + (on ? 1 : -1));
      root.classList.toggle("is-refreshing", refreshDepth > 0);
    }
    async function refresh() {
      setRefreshing(true);
      try {
        return await refreshInner();
      } finally {
        setRefreshing(false);
      }
    }
    async function refreshInner() {
      const repo = await invoke("git/repo");
      const repoRoot = repo.ok ? (repo.repo?.root ?? null) : null;
      if (loadedRepo !== undefined && repoRoot !== loadedRepo) forgoRepositoryState();
      loadedRepo = repoRoot;
      state.repo = repo.ok ? repo : null;
      state.error = repo.ok ? null : (repo.message ?? t("notARepository"));
      state.repoPath = repo.ok ? null : await currentFolder();
      await Promise.all([loadRefs(), loadLog()]);
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

    /**
     * The repository list, read when it can actually have changed — mounting, a
     * project switch, and opening the chip's menu, which re-reads its own —
     * rather than on every refresh. Building it walks the tree, and the Log
     * refreshes after every branch action.
     */
    async function loadRepositories() {
      repoWidget.update(await invoke("git/repos"));
    }

    PIG.watchWorkspace(() => {
      loadRepositories().then(() => refresh()).catch(() => {});
    });
    loadRepositories()
      .then(() => refresh())
      .catch((error) => toast(String(error?.message ?? error), "error"));

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
