/**
 * Unified-diff parsing and rendering in the IDEA shape.
 *
 * Two rules drive the design:
 *
 *  1. The raw diff lines are kept verbatim. A hunk is staged by handing those
 *     exact lines back to `git apply`, so anything that rewrote them (re-quoting,
 *     re-wrapping, re-ordering) would break stage/unstage/discard.
 *  2. Parsing produces the model once; the unified and side-by-side renderers
 *     are two views of that same model, which is why switching modes never
 *     changes what a hunk contains.
 */
(function (PIG) {
  "use strict";

  const { h, t, tf } = PIG;

  const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

  /** Context lines kept around a change when unchanged fragments collapse. */
  const CONTEXT_LINES = 3;
  /** A context run longer than this collapses; shorter stays fully visible. */
  const COLLAPSE_THRESHOLD = CONTEXT_LINES * 2 + 1;

  const WORDS = /[\w\u4e00-\u9fff]/;

  /** Split a diff into file sections, each holding its header and its hunks. */
  function parse(text) {
    const files = [];
    let file = null;
    let hunk = null;

    const lines = String(text ?? "").split("\n");
    // A trailing newline would otherwise add a phantom empty body line.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        file = { header: [line], hunks: [] };
        files.push(file);
        hunk = null;
        continue;
      }
      if (!file) continue;
      if (line.startsWith("@@")) {
        hunk = { header: line, lines: [], meta: matchHunkHeader(line), oldLine: 0, newLine: 0 };
        file.hunks.push(hunk);
        continue;
      }
      if (hunk) {
        const marker = line.charAt(0);
        const type = marker === "+" ? "insert"
          : marker === "-" ? "delete"
            : marker === "\\" ? "meta"
              : "context";
        hunk.lines.push({ raw: line, type, text: line.length ? line.slice(1) : "" });
      } else {
        file.header.push(line);
      }
    }

    annotate(files);
    return { files };
  }

  function matchHunkHeader(line) {
    const match = HUNK_HEADER.exec(line);
    if (!match) return null;
    return {
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
      section: match[5] ?? "",
    };
  }

  /** Attach 1-based old/new line numbers and whitespace-only change flags. */
  function annotate(files) {
    for (const file of files) {
      for (const hunk of file.hunks) {
        const meta = hunk.meta ?? { oldStart: 1, newStart: 1 };
        let oldLine = meta.oldStart;
        let newLine = meta.newStart;
        for (const line of hunk.lines) {
          if (line.type === "insert") {
            line.newNumber = newLine++;
          } else if (line.type === "delete") {
            line.oldNumber = oldLine++;
          } else if (line.type === "context") {
            line.oldNumber = oldLine++;
            line.newNumber = newLine++;
          }
        }
        markWhitespaceOnly(hunk);
        markSubmodule(hunk);
        pairChanges(hunk);
      }
    }
  }

  /**
   * A delete run followed by an insert run is one "change": pair them so the
   * renderer can highlight the differing middle of each line, and so a pair
   * that differs only in whitespace can be labelled as such.
   */
  function pairChanges(hunk) {
    const lines = hunk.lines;
    let index = 0;
    while (index < lines.length) {
      if (lines[index].type !== "delete") {
        index += 1;
        continue;
      }
      const deletes = [];
      while (index < lines.length && lines[index].type === "delete") deletes.push(lines[index++]);
      const inserts = [];
      while (index < lines.length && lines[index].type === "insert") inserts.push(lines[index++]);
      const pairs = Math.min(deletes.length, inserts.length);
      for (let offset = 0; offset < pairs; offset += 1) {
        const left = deletes[offset];
        const right = inserts[offset];
        const edges = commonEdges(left.text, right.text);
        left.paired = right;
        right.paired = left;
        left.fragment = fragmentRange(left.text, edges);
        right.fragment = fragmentRange(right.text, edges);
      }
    }
  }

  function markWhitespaceOnly(hunk) {
    const deletes = hunk.lines.filter((line) => line.type === "delete");
    const inserts = hunk.lines.filter((line) => line.type === "insert");
    if (!deletes.length || deletes.length !== inserts.length) return;
    const normalise = (value) => value.replace(/\s+/g, " ").trim();
    const same = deletes.every((line, index) => normalise(line.text) === normalise(inserts[index].text));
    if (same) hunk.whitespaceOnly = true;
  }

/**
 * A submodule change is two bare object names ("Subproject commit <sha>").
 * Git renders it as an ordinary two-line diff, which reads as noise; naming it
 * as a submodule update makes those same two lines meaningful.
 */
const SUBMODULE_LINE = /^Subproject commit ([0-9a-f]{7,40})$/i;

function markSubmodule(hunk) {
  const changed = hunk.lines.filter((line) => line.type === "insert" || line.type === "delete");
  if (!changed.length) return;
  const found = changed.map((line) => SUBMODULE_LINE.exec(line.text)?.[1] ?? null);
  if (found.some((sha) => !sha)) return;
  const from = hunk.lines
    .filter((line) => line.type === "delete")
    .map((line) => SUBMODULE_LINE.exec(line.text)[1])[0] ?? null;
  const to = hunk.lines
    .filter((line) => line.type === "insert")
    .map((line) => SUBMODULE_LINE.exec(line.text)[1])[0] ?? null;
  hunk.submodule = { from, to };
}

  function commonEdges(left, right) {
    const max = Math.min(left.length, right.length);
    let prefix = 0;
    while (prefix < max && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < max - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
      suffix += 1;
    }
    return { prefix, suffix };
  }

  /**
   * Turn the differing middle into a range, widened to word boundaries so the
   * highlight covers a whole token instead of splitting one — IDEA's
   * "Highlighting Differences: Words" behaviour.
   */
  function fragmentRange(text, edges) {
    let start = edges.prefix;
    let end = text.length - edges.suffix;
    if (end <= start) return null;
    while (start > 0 && WORDS.test(text[start - 1]) && WORDS.test(text[start])) start -= 1;
    while (end < text.length && WORDS.test(text[end - 1]) && WORDS.test(text[end])) end += 1;
    if (end <= start) return null;
    return { start, end };
  }

  // ------------------------------------------------------------- patches ---

  /** Rebuild the exact patch text Git must receive for the given hunks. */
  function patchFor(file, hunks) {
    const chosen = hunks && hunks.length ? hunks : file.hunks;
    const body = [];
    for (const hunk of chosen) {
      body.push(hunk.header);
      for (const line of hunk.lines) body.push(line.raw);
    }
    return [...file.header, ...body].join("\n") + "\n";
  }

  // ----------------------------------------------------------- rendering ---

  /** Collapse long context runs into a clickable "n unchanged lines" row. */
  function collapseRuns(hunk) {
    const output = [];
    let index = 0;
    while (index < hunk.lines.length) {
      const line = hunk.lines[index];
      if (line.type !== "context") {
        output.push({ kind: "line", line });
        index += 1;
        continue;
      }
      const run = [];
      while (index < hunk.lines.length && hunk.lines[index].type === "context") {
        run.push(hunk.lines[index++]);
      }
      if (run.length <= COLLAPSE_THRESHOLD) {
        for (const item of run) output.push({ kind: "line", line: item });
        continue;
      }
      for (const item of run.slice(0, CONTEXT_LINES)) output.push({ kind: "line", line: item });
      output.push({ kind: "collapsed", lines: run.slice(CONTEXT_LINES, run.length - CONTEXT_LINES) });
      for (const item of run.slice(run.length - CONTEXT_LINES)) output.push({ kind: "line", line: item });
    }
    return output;
  }

  function sideBySideRows(hunk) {
    const rows = [];
    const lines = hunk.lines;
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (line.type === "delete") {
        const deletes = [];
        while (index < lines.length && lines[index].type === "delete") deletes.push(lines[index++]);
        const inserts = [];
        while (index < lines.length && lines[index].type === "insert") inserts.push(lines[index++]);
        const count = Math.max(deletes.length, inserts.length);
        for (let offset = 0; offset < count; offset += 1) {
          rows.push({ left: deletes[offset] ?? null, right: inserts[offset] ?? null });
        }
        continue;
      }
      if (line.type === "insert") {
        rows.push({ left: null, right: line });
        index += 1;
        continue;
      }
      rows.push({ left: line, right: line });
      index += 1;
    }
    return rows;
  }

  function renderText(text, options) {
    const fragment = options?.fragment;
    if (!options?.showWhitespaces && !fragment) return document.createTextNode(text);

    const holder = document.createDocumentFragment();

    // Without whitespace markers the fragment highlight needs at most three
    // nodes. Building one node per character here was what made a large diff
    // expensive: every changed line turned into thousands of text nodes, and
    // the whole diff is rebuilt from scratch on each render.
    if (!options?.showWhitespaces) {
      const rawStart = Number(fragment.start);
      const rawEnd = Number(fragment.end);
      const start = Math.max(0, Math.min(Number.isFinite(rawStart) ? rawStart : 0, text.length));
      const end = Math.max(start, Math.min(Number.isFinite(rawEnd) ? rawEnd : text.length, text.length));
      if (start > 0) holder.append(document.createTextNode(text.slice(0, start)));
      if (end > start) holder.append(h("span", { class: "fragment", text: text.slice(start, end) }));
      if (end < text.length) holder.append(document.createTextNode(text.slice(end)));
      return holder;
    }

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === " ") {
        holder.append(h("span", { class: "whitespace-mark", text: "·" }));
        continue;
      }
      if (character === "\t") {
        holder.append(h("span", { class: "whitespace-mark", text: "→" }));
        continue;
      }
      if (fragment && index === fragment.start) {
        holder.append(h("span", {
          class: "fragment",
          text: text.slice(fragment.start, fragment.end),
        }));
        index = fragment.end - 1;
        continue;
      }
      holder.append(document.createTextNode(character));
    }
    return holder;
  }

  const SIGN = { insert: "+", delete: "-", context: " ", meta: "\\" };
  const ROW_CLASS = { insert: "inserted", delete: "deleted", context: "context", meta: "context" };

  function lineRow(line, options, side) {
    const gutter = h("span", { class: "gutter-mark" });
    if (line.type === "insert") gutter.style.background = "var(--gutter-added)";
    else if (line.type === "delete") gutter.style.background = "var(--gutter-deleted)";
    else if (line.fragment) gutter.style.background = "var(--gutter-modified)";

    // Unified view carries both numbers, IDEA-style: a deleted line has no new
    // number and an inserted one has no old number, so without the second
    // column half of every change would show a blank gutter.
    const children = [gutter];
    if (options.showLineNumbers) {
      if (side === "unified") {
        children.push(numberCell(line.oldNumber));
        children.push(numberCell(line.newNumber));
      } else {
        children.push(numberCell(side === "left" ? line.oldNumber : line.newNumber));
      }
    }
    children.push(h("span", { class: "sign", text: SIGN[line.type] ?? " " }));
    // Paired lines only highlight the side being shown in side-by-side mode;
    // in unified mode both halves of a change carry their own fragment.
    const fragment = line.type === "context" || line.type === "meta" ? null : line.fragment;
    children.push(h("span", { class: "text" }, [renderText(line.text, { ...options, fragment })]));
    return h("div", { class: `diff-line ${ROW_CLASS[line.type] ?? "context"}` }, children);
  }

  function numberCell(value) {
    return h("span", {
      class: "num",
      text: value === undefined || value === null ? "" : String(value),
    });
  }

  function fillerRow(options) {
    const children = [h("span", { class: "gutter-mark" })];
    if (options.showLineNumbers) children.push(numberCell(null));
    children.push(h("span", { class: "sign" }));
    children.push(h("span", { class: "text" }));
    return h("div", { class: "diff-line context filler" }, children);
  }
  function hunkHeaderRow(file, hunk, options) {
    const children = [];
    const checkbox = options.hunkCheckbox?.(hunk, file);
    if (checkbox) {
      const input = h("input", {
        type: "checkbox",
        title: t("includeIntoCommit"),
        checked: checkbox.checked,
        onchange: (event) => checkbox.onChange(event.target.checked),
      });
      children.push(input);
    }
    const meta = hunk.meta;
    children.push(h("span", {
      text: meta
        ? `@@ -${meta.oldStart}${meta.oldCount === 1 ? "" : `,${meta.oldCount}`} +${meta.newStart}${meta.newCount === 1 ? "" : `,${meta.newCount}`} @@`
        : hunk.header,
    }));
    if (meta?.section) children.push(h("span", { class: "diff-hunk-note", text: meta.section }));
    if (hunk.whitespaceOnly) children.push(h("span", { class: "diff-hunk-note", text: `· ${t("whiteSpaceOnly")}` }));
    if (hunk.submodule) {
      const short = (sha) => (sha ? sha.slice(0, 7) : "—");
      children.push(h("span", {
        class: "diff-hunk-note",
        text: `· ${t("submodule")} ${short(hunk.submodule.from)} → ${short(hunk.submodule.to)}`,
      }));
    }

    const actions = h(options.stageable === false ? "span" : "span", { class: "diff-hunk-actions" });
    for (const action of options.hunkActions ?? []) {
      actions.append(h("button", {
        type: "button",
        title: action.title,
        onclick: () => action.onSelect(hunk, file),
      }, [action.label]));
    }
    if (actions.childNodes.length) children.push(actions);

    return h("div", { class: "diff-hunk-header" }, children);
  }

  function collapsedRow(lines, options) {
    // Whole sentence per locale via tf; `s` feeds the English plural only.
    const node = h("div", {
      class: "diff-collapsed",
      title: t("collapseUnchanged"),
      text: tf("collapsedLines", { count: lines.length, s: lines.length === 1 ? "" : "s" }),
    });
    node.addEventListener("click", () => {
      const replacement = document.createDocumentFragment();
      for (const line of lines) replacement.append(lineRow(line, options, options.side ?? "unified"));
      node.replaceWith(replacement);
    });
    return node;
  }

  /**
   * Render a diff into `container`.
   *
   * TODO: large-diff virtualization is out of scope — rendering stays
   * non-virtualized; a windowed renderer would be a wide change, so huge
   * patches still render in full here.
   *
   * options:
   *   unified          boolean — side-by-side when false
   *   showWhitespaces, showLineNumbers
   *   stageable        boolean — false while a whitespace-ignoring view is active
   *   hunkCheckbox     (hunk, file) => { checked, onChange }
   *   hunkActions      [{ label, title, onSelect(hunk, file) }]
   *   emptyMessage
   */
  function render(container, options) {
    PIG.clear(container);
    const text = options.text ?? "";
    const parsed = parse(text);

    if (!text.trim() || !parsed.files.length) {
      container.append(h("div", { class: "empty-state" }, [
        h("div", { class: "headline", text: options.emptyMessage ?? t("noDiff") }),
      ]));
      return { files: [] };
    }

    if (/^Binary files |^GIT binary patch/m.test(text)) {
      container.append(h("div", { class: "empty-state" }, [
        h("div", { class: "headline", text: t("binaryDiff") }),
      ]));
      return { files: parsed.files };
    }

    const single = parsed.files.length === 1;

    for (const file of parsed.files) {
      const { name, directory } = PIG.splitPath(displayPath(file));
      // A lone file normally needs no header because the caller already names
      // it; a diff viewer that is the whole surface must always say what it is
      // showing, so it opts in.
      if (options.showFileHeader ?? !single) {
        container.append(h("div", { class: "diff-file-header" }, [
          h("span", { class: "name", text: name }),
          directory ? h("span", { class: "path", text: directory }) : null,
        ]));
      }
      for (const hunk of file.hunks) {
        container.append(hunkHeaderRow(file, hunk, options));
        if (options.unified === false) {
          const grid = h("div", { class: "diff-sbs" });
          const left = h("div", { class: "side" });
          const right = h("div", { class: "side" });
          for (const row of sideBySideRows(hunk)) {
            left.append(row.left ? lineRow(row.left, options, "left") : fillerRow({ ...options, side: "left" }));
            right.append(row.right ? lineRow(row.right, options, "right") : fillerRow({ ...options, side: "right" }));
          }
          grid.append(left, h("div", { class: "spacer" }), right);
          container.append(grid);
          continue;
        }
        for (const entry of collapseRuns(hunk)) {
          if (entry.kind === "collapsed") {
            container.append(collapsedRow(entry.lines, options));
            continue;
          }
          container.append(lineRow(entry.line, options, "unified"));
        }
      }
    }
    return { files: parsed.files };
  }

  /** Prefer the `+++` side of the header, falling back to the diff line. */
  function displayPath(file) {
    for (const line of file.header) {
      if (line.startsWith("+++ ")) {
        const value = line.slice(4).split("\t")[0].trim();
        if (value && value !== "/dev/null") return value.replace(/^[ab]\//, "");
      }
    }
    for (const line of file.header) {
      if (line.startsWith("--- ")) {
        const value = line.slice(4).split("\t")[0].trim();
        if (value && value !== "/dev/null") return value.replace(/^[ab]\//, "");
      }
    }
    const first = file.header[0] ?? "";
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(first);
    return match ? match[2] : first;
  }

  Object.assign(PIG, {
    diff: { parse, render, patchFor, displayPath, sideBySideRows, CONTEXT_LINES },
  });
})(window.PIG || (window.PIG = {}));
