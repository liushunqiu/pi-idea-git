/**
 * IDEA Git — PI-Desktop plugin entry.
 *
 * Architecture
 * ------------
 * `main.js` runs in a dedicated Node process (Electron `utilityProcess`), so it
 * has the real Node API. The work-panel view and the detached panel are
 * sandboxed pages that only get `window.pluginBridge`. The host forwards every
 * channel it does not implement itself to `onPanelInvoke` below, which makes
 * this file the single place where Git actually executes.
 *
 *   view/panel  --pluginBridge.invoke("git/…")-->  host  -->  onPanelInvoke  -->  git
 *
 * Why the Git CLI instead of reading `.git/` through the host file APIs:
 * `.git/` sits on the host's credential refusal list, and porcelain output is
 * the only stable, quoting-safe contract for status, diffs and staging. The
 * process receives a reduced environment (PATH/LANG/TEMP but no HOME), so every
 * invocation restores HOME explicitly — without it Git cannot read the user's
 * global identity or credential helper.
 *
 * Nothing here writes to the repository except when the user asked for it:
 * stage / unstage / discard / commit / branch / stash all map to one explicit
 * Git command, and hunk operations pipe a patch that Git validates itself.
 */

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

/** Host aborts a panel call after 30s; stay under it so the UI gets a message. */
const COMMAND_TIMEOUT_MS = 25_000;
/** Hard cap on one command's stream so a runaway log cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Field/record separators for `git log` — control chars cannot appear in messages. */
const FS_CHAR = "\u001f";
const RS_CHAR = "\u001e";

/**
 * Every command this plugin runs is kept in a small ring buffer. The host's
 * Console tab is meant to show "the results of executing VCS-related
 * commands", and because each work-panel view is its own page, the buffer has
 * to live here rather than in a page's memory.
 */
const CONSOLE_LIMIT = 200;
let consoleEntries = [];
/** Commands whose output is pure plumbing and would only add noise. */
const CONSOLE_QUIET = new Set(["rev-parse", "ls-files", "for-each-ref", "--version"]);

function recordConsole(args, result, cwd) {
  if (CONSOLE_QUIET.has(args[0]) && result.ok) return;
  consoleEntries.push({
    ts: Date.now(),
    cwd,
    command: `git ${args.join(" ")}`,
    ok: result.ok,
    stdout: (result.stdout ?? "").slice(0, 4000),
    stderr: (result.stderr ?? "").slice(0, 4000),
    message: result.message,
    code: result.code,
  });
  if (consoleEntries.length > CONSOLE_LIMIT) {
    consoleEntries = consoleEntries.slice(-CONSOLE_LIMIT);
  }
}

function consoleLog() {
  return consoleEntries;
}

function clearConsoleLog() {
  consoleEntries = [];
}

/**
 * Small persisted state: the commit-message history IDEA keeps behind the
 * clock button, and the view preferences (unified vs side-by-side, graph
 * options). `plugin.getDataPath()` is the plugin's own directory, so this
 * never touches the user's workspace.
 */
let prefsCache = null;
const MAX_MESSAGE_HISTORY = 30;

async function prefsFile() {
  const dir = await pi.plugin.getDataPath();
  return path.join(dir, "prefs.json");
}

async function readPrefs() {
  if (prefsCache) return prefsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(await prefsFile(), "utf8"));
    prefsCache = {
      messages: Array.isArray(parsed?.messages) ? parsed.messages : [],
      ui: parsed?.ui && typeof parsed.ui === "object" ? parsed.ui : {},
    };
  } catch {
    prefsCache = { messages: [], ui: {} };
  }
  return prefsCache;
}

async function writePrefs(prefs) {
  prefsCache = prefs;
  try {
    fs.writeFileSync(await prefsFile(), JSON.stringify(prefs, null, 2), "utf8");
  } catch {
    // Persistence is a convenience; a failure must not break the view.
  }
  return prefs;
}

/** Newest first, de-duplicated, so re-using a message promotes it. */
function rememberMessage(prefs, message) {
  const trimmed = String(message ?? "").trim();
  if (!trimmed) return prefs;
  const messages = [trimmed, ...prefs.messages.filter((value) => value !== trimmed)];
  return { ...prefs, messages: messages.slice(0, MAX_MESSAGE_HISTORY) };
}

// ---------------------------------------------------------------------------
// Locating git
// ---------------------------------------------------------------------------

let gitBinaryCache;

/**
 * Electron started from a desktop launcher inherits a minimal PATH, so a
 * `git` that exists in the user's shell may be invisible here. Probe PATH
 * through the filesystem and then fall back to the usual install locations.
 */
function resolveGitBinary() {
  if (gitBinaryCache !== undefined) return gitBinaryCache;
  const exe = process.platform === "win32" ? "git.exe" : "git";
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files (x86)\\Git\\cmd",
    path.join(os.homedir(), "AppData", "Local", "Programs", "Git", "cmd"),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      gitBinaryCache = candidate;
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  gitBinaryCache = null;
  return null;
}

/**
 * The plugin process gets PATH/LANG/TEMP but never HOME, and Git needs HOME for
 * `~/.gitconfig` (identity, aliases, credential helper). Prompts are disabled
 * because there is no terminal to answer them.
 */
function gitEnv() {
  const env = { ...process.env };
  if (!env.HOME) env.HOME = os.homedir();
  if (!env.USERPROFILE) env.USERPROFILE = os.homedir();
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "echo";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.GIT_EDITOR = "true";
  env.GIT_CONFIG_NOSYSTEM = env.GIT_CONFIG_NOSYSTEM ?? "";
  return env;
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

/**
 * Run one Git command and always resolve — never reject — so the UI can render
 * a real error message instead of an opaque bridge failure.
 *
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, message?: string}>}
 */
function runGit(args, options = {}) {
  const binary = resolveGitBinary();
  if (!binary) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      code: null,
      message:
        "Git executable not found. Install Git, or make sure it is on PATH.",
    });
  }
  const cwd = options.cwd || workspacePath();
  if (!cwd) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      code: null,
      message: "No workspace is open.",
    });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        env: gitEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        code: null,
        message: String(error?.message ?? error),
      });
      return;
    }

    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let truncated = false;

    const finish = (code, failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      const result = {
        ok: code === 0,
        stdout,
        stderr,
        code,
        message: failure ?? (code === 0 ? undefined : gitError(stderr, code)),
        truncated,
      };
      recordConsole(args, result, cwd);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(null, `git ${args[0] ?? ""} timed out after ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s`);
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        finish(null, "Git output exceeded the size limit.");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes > MAX_OUTPUT_BYTES) return;
      err.push(chunk);
    });
    child.on("error", (error) => finish(null, String(error?.message ?? error)));
    child.on("close", (code) => finish(code));

    if (options.input !== undefined) {
      child.stdin.on("error", () => {
        // Git exited before reading (e.g. a rejected patch); the close handler
        // reports the real reason.
      });
      child.stdin.end(options.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function firstLine(text) {
  const line = String(text ?? "").trim().split("\n").find((value) => value.trim());
  return line ? line.trim() : "";
}

/**
 * Turn Git's stderr into something a person can act on.
 *
 * `git add` reports the useful detail below a header line: the header says the
 * paths are ignored, and the paths themselves are on the following lines, mixed
 * with `hint:` advice that is rarely what the user needs first. Reporting only
 * the first line — which this used to do — produces "The following paths are
 * ignored by one of your .gitignore files:" and stops, naming nothing.
 */
function gitError(stderr, code) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith("hint:"));
  if (!lines.length) return `git exited with ${code}`;
  return lines.slice(0, 6).join("\n");
}

/**
 * Classify an authentication failure so the views can explain it.
 *
 * The plugin deliberately holds no credentials: it runs the user's own `git`
 * with the user's own `HOME`, so it inherits exactly the credential helpers,
 * `~/.ssh/config` and keys that their terminal uses. That inheritance is the
 * whole design — but it also means that when it is missing, the plugin has no
 * way to ask. Prompts are disabled so a command fails fast rather than hanging
 * with no terminal, which turns "no credential configured" into a dead end
 * whose raw output names no remedy.
 *
 * Returns a stable code, never prose: the wording belongs to the views, which
 * are the only part that knows the user's language.
 */
function authHint(stderr) {
  const text = String(stderr ?? "");
  if (!text) return null;
  if (/Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository/i.test(text)) {
    return "ssh";
  }
  if (
    /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or token|HTTP 401|401 Unauthorized/i.test(text)
  ) {
    return "credentials";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commit-message drafting
// ---------------------------------------------------------------------------

/**
 * The message is written by the host's own model, through `pi.agent.complete`.
 * The plugin holds no API key and picks no provider: the user's configured
 * models are whatever `pi.models.list()` reports, which is exactly the set they
 * already pay for.
 */

/** Enough history for the model to copy the repository's conventions. */
const STYLE_SAMPLE_COMMITS = 20;
/** The patch is a prompt, not a backup: keep it small enough to stay quick. */
const MAX_PROMPT_PATCH_CHARS = 12_000;

const COMMIT_SYSTEM = [
  "You write Git commit messages.",
  "Reply with the commit message only: no preamble, no explanation, no code fences, no surrounding quotes.",
  "First line: imperative mood, at most 72 characters, no trailing full stop.",
  "If the change needs it, add a blank line and a short body saying why the change was made; do not restate the diff line by line.",
  "Write in the same language as the commit subjects you are given.",
  "When the change is trivial and self-evident, one subject line is enough.",
].join(" ");

/** Strip the shapes a model adds around a message even when told not to. */
function tidyCommitMessage(raw) {
  let text = String(raw ?? "").trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(commit message|提交信息)\s*[:：]\s*/i, "");
  return text.replace(/\s+$/, "");
}

/**
 * What the model gets to read: the change, plus a sample of the repository's
 * own subjects so it can match tone and language instead of inventing a style.
 */
async function buildCommitContext(repo, payload) {
  const path = typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : null;
  const mode = payload?.mode === "index" ? "index" : "worktree";

  // The caller passes repository-relative paths; only paths that stay inside
  // the repository are accepted, the same rule the staging channels use.
  if (path && !isSafePath(path)) {
    return { ok: false, code: "BAD_PATH", message: "Unsafe path rejected." };
  }

  const style = await runGit(
    ["log", `-${STYLE_SAMPLE_COMMITS}`, "--pretty=format:%s"],
    { cwd: repo.root },
  );
  const styleLines = style.ok ? style.stdout.split("\n").filter((line) => line.trim()) : [];

  let patch = "";
  let scope = "";
  let files = [];

  if (path) {
    const diff = await readDiff(repo, path, mode, false);
    if (!diff.ok) return { ok: false, code: "NO_DIFF", message: diff.message ?? "No changes to describe." };
    patch = diff.text;
    scope = { kind: "file", path, mode };
    files = [path];
  } else {
    const diff = await runGit(
      // `--no-prefix` only trims a/ and b/ noise out of the prompt; this text is
      // never fed back to `git apply`.
      ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-prefix", "-U3"],
      { cwd: repo.root },
    );
    if (!diff.ok) return { ok: false, code: "NO_DIFF", message: diff.message ?? "No changes to describe." };
    patch = diff.stdout;
    scope = { kind: "staged" };
    const names = await runGit(["diff", "--cached", "--name-only"], { cwd: repo.root });
    files = names.ok ? names.stdout.split("\n").filter((line) => line.trim()) : [];
  }

  if (!patch.trim()) {
    return {
      ok: false,
      code: "EMPTY_DIFF",
      message: path
        ? `No changes to describe for ${path}.`
        : "Nothing is staged. Stage the change first, or select a file in the Changes list.",
    };
  }

  // The prompt describes the scope in prose; the caller gets the structure above
  // and phrases it in the user's language.
  const scopeLabel = scope.kind === "staged"
    ? "everything currently staged"
    : `${mode === "index" ? "staged" : "working tree"} file ${path}`;

  const truncated = patch.length > MAX_PROMPT_PATCH_CHARS;
  const body = [
    styleLines.length
      ? `Recent commit subjects in this repository, for style and language:\n${styleLines.join("\n")}`
      : "This repository has no commit history yet.",
    "",
    `Changes to describe (${scopeLabel}):`,
    truncated ? patch.slice(0, MAX_PROMPT_PATCH_CHARS) : patch,
    truncated ? "\n[diff truncated]" : "",
  ].join("\n");

  return { ok: true, content: body, scope, files };
}

/**
 * Draft a message for the current selection, or for everything staged when
 * nothing is selected. `text` carries the draft; `message` stays what it is
 * everywhere else in this file — the error text.
 */
async function draftCommitMessage(repo, payload) {
  let models = [];
  try {
    models = await pi.models.list();
  } catch (error) {
    return { ok: false, code: "NO_MODEL", message: String(error?.message ?? error) };
  }
  if (!Array.isArray(models) || !models.length) {
    return {
      ok: false,
      code: "NO_MODEL",
      message: "No model is available. Add an AI provider in Settings → AI providers first.",
    };
  }

  const wanted = String(payload?.modelKey ?? "").trim();
  const model = models.find((row) => row.key === wanted) ?? models[0];

  const context = await buildCommitContext(repo, payload);
  if (!context.ok) return context;

  try {
    const result = await pi.agent.complete({
      modelKey: model.key,
      system: COMMIT_SYSTEM,
      messages: [{ role: "user", content: context.content }],
    });
    const text = tidyCommitMessage(result?.text);
    if (!text) return { ok: false, code: "EMPTY_REPLY", message: "The model returned nothing." };
    return {
      ok: true,
      text,
      modelKey: result?.modelKey ?? model.key,
      scope: context.scope,
      files: context.files,
    };
  } catch (error) {
    // The host reports these as codes; keep them so the view can phrase them.
    return {
      ok: false,
      code: String(error?.code ?? "FAILED"),
      message: String(error?.message ?? error),
    };
  }
}

// ---------------------------------------------------------------------------
// Workspace and repository
// ---------------------------------------------------------------------------

/**
 * The active workspace, kept as a cache that is *always* refreshed before it is
 * trusted.
 *
 * This used to latch on first read, which quietly pinned the plugin to whatever
 * project was open when it first ran: switching projects left the tool window
 * reading (and writing) the previous repository. The host announces switches on
 * `workspace:changed`, and the one host call needed to read the current value is
 * trivially cheap next to spawning `git`, so there is no reason to guess.
 */
let cachedWorkspace = null;

function workspacePath() {
  return cachedWorkspace;
}

async function refreshWorkspace() {
  try {
    const workspace = await pi.workspace.get();
    cachedWorkspace = workspace?.path ?? null;
  } catch {
    cachedWorkspace = null;
  }
  return cachedWorkspace;
}

/**
 * Resolve the repository that contains the workspace. `git rev-parse` already
 * walks up parent directories, so a workspace nested inside a repository still
 * resolves to the right root.
 */
async function readRepo() {
  await refreshWorkspace();
  if (!cachedWorkspace) {
    return { ok: false, code: "NO_WORKSPACE", message: "No workspace is open." };
  }
  const top = await runGit(["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    return {
      ok: false,
      code: "NO_REPOSITORY",
      message: `Not a Git repository: ${cachedWorkspace}`,
    };
  }
  const root = top.stdout.trim();
  const gitDir = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: root });
  return {
    ok: true,
    root,
    name: path.basename(root),
    gitDir: gitDir.ok ? gitDir.stdout.trim() : path.join(root, ".git"),
    workspace: cachedWorkspace,
  };
}

/** Every repository-scoped command runs from the repository root. */
async function withRepo(handler) {
  const repo = await readRepo();
  if (!repo.ok) return repo;
  return handler(repo);
}

// ---------------------------------------------------------------------------
// Status parsing (porcelain v2)
// ---------------------------------------------------------------------------

const INDEX_LABELS = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
};

const CONFLICT_LABELS = {
  DD: "Both deleted",
  AU: "Added by us",
  UD: "Deleted by them",
  UA: "Added by them",
  DU: "Deleted by us",
  AA: "Both added",
  UU: "Both modified",
};

function labelFor(code, conflicted) {
  if (conflicted) return CONFLICT_LABELS[code] ?? "Unmerged";
  return INDEX_LABELS[code] ?? code;
}

/**
 * `git status --porcelain=v2 -z` is the only status form that is unambiguous:
 * `-z` suppresses the C-style path quoting, so spaces and non-ASCII paths come
 * back verbatim, and v2 keeps the index and worktree columns apart — which is
 * exactly the staged/unstaged split the UI shows.
 */
async function readStatus(repo) {
  const result = await runGit(
    ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
    { cwd: repo.root },
  );
  if (!result.ok) return result;

  const branch = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false,
  };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];

  const tokens = result.stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^\n/, "");
    if (!token) continue;

    if (token.startsWith("# ")) {
      const header = token.slice(2);
      if (header.startsWith("branch.oid ")) {
        const value = header.slice("branch.oid ".length).trim();
        branch.oid = value;
        // "(initial)" means the branch exists but has no commit yet — an unborn
        // branch, not a detached HEAD. Detachment is reported by branch.head.
        branch.unborn = value === "(initial)";
      } else if (header.startsWith("branch.head ")) {
        const value = header.slice("branch.head ".length).trim();
        branch.head = value === "(detached)" ? null : value;
        if (value === "(detached)") branch.detached = true;
      } else if (header.startsWith("branch.upstream ")) {
        branch.upstream = header.slice("branch.upstream ".length).trim();
      } else if (header.startsWith("branch.ab ")) {
        const match = /\+(\d+)\s+-(\d+)/.exec(header);
        if (match) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = token[0];

    if (kind === "1" || kind === "2") {
      const parts = token.split(" ");
      const xy = parts[1] ?? "..";
      const track = kind === "2" ? parts[8] : "";
      const offset = kind === "2" ? 9 : 8;
      const filePath = parts.slice(offset).join(" ");
      const originalPath =
        kind === "2" ? (tokens[index + 1] ?? "").replace(/^\n/, "") : null;
      if (kind === "2") index += 1;

      const x = xy[0];
      const y = xy[1];
      if (x !== ".") {
        staged.push({
          path: filePath,
          originalPath,
          status: x,
          label: labelFor(x, false),
          score: track ? ` (${Number(track.slice(1))}%)` : "",
        });
      }
      if (y !== ".") {
        unstaged.push({
          path: filePath,
          originalPath,
          status: y,
          label: labelFor(y, false),
        });
      }
      continue;
    }

    if (kind === "u") {
      const parts = token.split(" ");
      const xy = parts[1] ?? "UU";
      const filePath = parts.slice(10).join(" ");
      conflicted.push({
        path: filePath,
        originalPath: null,
        status: xy,
        label: labelFor(xy, true),
      });
      continue;
    }

    if (kind === "?") {
      untracked.push({ path: token.slice(2), originalPath: null, status: "?", label: "Unversioned" });
      continue;
    }
    // kind === "!" (ignored) needs no UI.
  }

  return {
    ok: true,
    // `workspace` lets the views translate repository-relative paths into the
    // workspace-relative form the host's fs channels are scoped to.
    repo: { root: repo.root, name: repo.name, workspace: repo.workspace ?? null },
    branch,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/**
 * Unstaged worktree diff, or the index diff when `mode === "index"`.
 * `--no-ext-diff` keeps a user-configured external diff tool from hijacking the
 * output, and `--no-color` keeps our own renderer authoritative.
 */
async function readDiff(repo, filePath, mode, ignoreWhitespace) {
  if (!filePath) return { ok: false, message: "No file given." };
  const base = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-U3",
    // IDEA's "Ignore whitespaces" view option, implemented by Git itself
    // rather than by hiding lines in the renderer.
    ignoreWhitespace ? "-w" : null,
    mode === "index" ? "--cached" : null,
    "--",
    filePath,
  ].filter((value) => value !== null);

  let result = await runGit(base, { cwd: repo.root });

  // An untracked file has no index entry, so `git diff` prints nothing for it.
  // `--no-index` against /dev/null renders it as a full addition.
  if (
    mode !== "index" &&
    result.ok &&
    !result.stdout.trim() &&
    fs.existsSync(path.resolve(repo.root, filePath))
  ) {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    result = await runGit(
      ["diff", "--no-color", "--no-ext-diff", "-U3", "--no-index", "--", nullDevice, filePath],
      { cwd: repo.root },
    );
  }

  // `git diff --no-index` exits 1 when the files differ: that is success here.
  const ok = result.ok || result.code === 1;
  const text = result.stdout;
  return {
    ok,
    filePath,
    mode,
    text,
    binary: /^Binary files |^GIT binary patch/m.test(text),
    empty: !text.trim(),
    message: ok ? undefined : result.message,
  };
}

/**
 * Split a unified diff into one entry per file, each keeping its exact header
 * lines plus its hunks. Handing the header back verbatim is what lets a
 * hunk patch preserve modes, renames and the pre-image blob.
 */
function splitPatch(text) {
  const files = [];
  let current = null;
  let hunk = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { header: [line], hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk) hunk.lines.push(line);
    else current.header.push(line);
  }
  return files;
}

/**
 * Stage, unstage or discard exactly the hunks the user picked. The patch is
 * rebuilt from the original header + selected hunks; `--recount` lets Git
 * accept it even though the selected subset no longer matches the line counts
 * in the original hunk headers.
 */
async function applyPatch(repo, patch, action) {
  const text = String(patch ?? "");
  if (!text.trim()) return { ok: false, message: "Empty patch." };
  const base = [
    "apply",
    "--recount",
    "--whitespace=nowarn",
    // Diffs are produced with git's default `a/`-`b/` prefixes, so strip one
    // leading component. Stating it keeps the two halves in step.
    "-p1",
    action === "stage" ? "--cached" : null,
    action === "unstage" ? "--cached" : null,
    action === "unstage" || action === "discard" ? "-R" : null,
  ].filter((value) => value !== null);

  const result = await runGit([...base, "-"], { cwd: repo.root, input: text });
  return {
    ok: result.ok,
    message: result.ok ? undefined : result.message,
    stderr: result.stderr,
  };
}

// ---------------------------------------------------------------------------
// Log, branches, stashes
// ---------------------------------------------------------------------------

async function readLog(repo, limit, options = {}) {
  const count = Math.min(Math.max(Number(limit) || 150, 1), 500);
  const format = ["%H", "%P", "%h", "%an", "%at", "%s", "%D"].join(FS_CHAR) + RS_CHAR;
  const branch = String(options.branch ?? "").trim();
  const args = ["log", options.topo ? "--topo-order" : "--date-order", `--max-count=${count}`];
  // Naming a branch replaces `--all`; Git rejects the two together.
  if (branch) {
    if (/[\s~^:?*\[\\]/.test(branch) || branch.startsWith("-")) {
      return { ok: false, message: "Invalid branch filter." };
    }
    args.push(branch);
  } else {
    args.push("--all");
  }
  if (options.firstParent) args.push("--first-parent");
  if (options.noMerges) args.push("--no-merges");
  args.push(`--pretty=format:${format}`);

  const result = await runGit(args, { cwd: repo.root });
  if (!result.ok) {
    // A repository without commits is not an error worth shouting about.
    return { ok: true, commits: [], empty: true, message: result.message };
  }
  const commits = result.stdout
    .split(RS_CHAR)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim())
    .map((record) => {
      const [hash, parents, short, author, at, subject, refs] = record.split(FS_CHAR);
      return {
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        short,
        author,
        timestamp: Number(at) * 1000,
        subject,
        refs: refs
          ? refs
              .split(", ")
              .map((value) => value.trim())
              .filter(Boolean)
              .map(cleanRef)
          : [],
      };
    });
  return { ok: true, commits, empty: commits.length === 0 };
}

/** `%D` yields `HEAD -> main, origin/main, tag: v1`; turn that into typed chips. */
function cleanRef(raw) {
  let value = raw;
  let head = false;
  if (value.startsWith("HEAD -> ")) {
    head = true;
    value = value.slice("HEAD -> ".length);
  } else if (value === "HEAD") {
    return { name: "HEAD", kind: "head", head: true };
  }
  let kind = "branch";
  if (value.startsWith("tag: ")) {
    kind = "tag";
    value = value.slice("tag: ".length);
  } else if (value.includes("/")) {
    kind = "remote";
  }
  return { name: value, kind, head };
}

async function readBranches(repo) {
  const result = await runGit(
    [
      "for-each-ref",
      `--format=%(refname:short)${FS_CHAR}%(objectname:short)${FS_CHAR}%(HEAD)${FS_CHAR}%(upstream:short)${FS_CHAR}%(committerdate:unix)${FS_CHAR}%(contents:subject)`,
      "refs/heads",
      "refs/remotes",
    ],
    { cwd: repo.root },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const branches = result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name, short, head, upstream, date, subject] = line.split(FS_CHAR);
      return {
        name,
        short,
        current: head === "*",
        upstream: upstream || null,
        timestamp: Number(date) * 1000,
        subject: subject ?? "",
        remote: name === "HEAD" || name.includes("/HEAD") || name.includes("/") ,
      };
    })
    // Drop `origin/HEAD` style symbolic rows.
    .filter((branch) => !branch.name.endsWith("/HEAD"));
  return { ok: true, branches };
}

async function readStashes(repo) {
  const result = await runGit(["stash", "list", "--pretty=format:%gd\u001f%gs\u001f%at"], {
    cwd: repo.root,
  });
  if (!result.ok) return { ok: true, stashes: [] };
  const stashes = result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [ref, subject, at] = line.split(FS_CHAR);
      return { ref, subject, timestamp: Number(at) * 1000 };
    });
  return { ok: true, stashes };
}

// ---------------------------------------------------------------------------
// Guarded helpers
// ---------------------------------------------------------------------------

function requirePaths(payload) {
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  return paths.filter((value) => typeof value === "string" && value.length > 0);
}

/**
 * A path is only ever passed to Git as a pathspec after `--`, so it cannot be
 * mistaken for a revision or an option; this check rejects the two shapes that
 * are still dangerous regardless: absolute paths and `..` traversal.
 */
function isSafePath(value) {
  if (typeof value !== "string" || !value) return false;
  if (path.isAbsolute(value)) return false;
  const normalised = value.replace(/\\/g, "/");
  return !normalised.split("/").includes("..");
}

// ---------------------------------------------------------------------------
// Channel router
// ---------------------------------------------------------------------------

/**
 * Every `pluginBridge.invoke("git/…")` from the view or the panel lands here.
 * Unknown methods fail loudly instead of returning undefined.
 */
async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    // -- repository ---------------------------------------------------------
    case "git/repo": {
      const repo = await readRepo();
      if (!repo.ok) return repo;
      const [status, stashes, user] = await Promise.all([
        readStatus(repo),
        readStashes(repo),
        runGit(["config", "--get", "user.name"], { cwd: repo.root }),
      ]);
      if (!status.ok) return status;
      return {
        ...status,
        stashes: stashes.stashes ?? [],
        available: true,
        // Drives the Log's "My Commits" bolding.
        user: user.ok ? user.stdout.trim() : null,
        version: (await runGit(["--version"], { cwd: repo.root })).stdout.trim(),
      };
    }

    case "git/status":
      return withRepo((repo) => readStatus(repo));

    case "git/diff":
      return withRepo((repo) =>
        readDiff(
          repo,
          String(payload.path ?? ""),
          payload.mode === "index" ? "index" : "worktree",
          payload.ignoreWhitespace === true,
        ),
      );

    case "git/log":
      return withRepo((repo) =>
        readLog(repo, payload.limit, {
          branch: payload.branch,
          firstParent: payload.firstParent === true,
          noMerges: payload.noMerges === true,
          topo: payload.topo === true,
        }),
      );

    case "git/commit-diff":
      return withRepo(async (repo) => {
        const hash = String(payload.hash ?? "");
        if (!/^[0-9a-f]{4,64}$/i.test(hash)) return { ok: false, message: "Invalid commit hash." };
        const result = await runGit(
          ["show", "--no-color", "--no-ext-diff", "--format=", "-U3", hash],
          { cwd: repo.root },
        );
        const meta = await runGit(
          ["show", "--no-color", "--no-patch", `--format=%H${FS_CHAR}%h${FS_CHAR}%an${FS_CHAR}%ae${FS_CHAR}%at${FS_CHAR}%s${FS_CHAR}%b`, hash],
          { cwd: repo.root },
        );
        const [full, short, author, email, at, subject, body] = meta.stdout.split(FS_CHAR);
        return {
          ok: result.ok,
          text: result.stdout,
          meta: {
            hash: full,
            short,
            author,
            email,
            timestamp: Number(at) * 1000,
            subject,
            body: (body ?? "").trim(),
          },
          message: result.ok ? undefined : result.message,
        };
      });

    case "git/branches": {
      const branches = await withRepo((repo) => readBranches(repo));
      return branches;
    }

    case "git/stashes":
      return withRepo((repo) => readStashes(repo));

    // -- staging ------------------------------------------------------------
    case "git/stage":
    case "git/unstage": {
      const paths = requirePaths(payload);
      if (!paths.length) return { ok: false, message: "No paths given." };
      if (!paths.every(isSafePath)) return { ok: false, message: "Unsafe path rejected." };
      return withRepo(async (repo) => {
        const staging = channel === "git/stage";
        const args = staging
          ? ["add", "--", ...paths]
          : ["restore", "--staged", "--", ...paths];
        let result = await runGit(args, { cwd: repo.root });
        // `git restore --staged` needs HEAD; in a fresh repository there is none.
        if (!staging && !result.ok) {
          result = await runGit(["rm", "--cached", "-r", "--", ...paths], { cwd: repo.root });
        }
        return { ok: result.ok, message: result.ok ? undefined : result.message };
      });
    }

    case "git/discard": {
      const paths = requirePaths(payload);
      if (!paths.length) return { ok: false, message: "No paths given." };
      if (!paths.every(isSafePath)) return { ok: false, message: "Unsafe path rejected." };
      return withRepo(async (repo) => {
        const tracked = [];
        const removed = [];
        for (const filePath of paths) {
          // An untracked file has no worktree version to restore, so discarding
          // it means deleting the file. Everything else is a worktree restore.
          const check = await runGit(["ls-files", "--error-unmatch", "--", filePath], {
            cwd: repo.root,
          });
          if (check.ok) tracked.push(filePath);
          else removed.push(filePath);
        }
        const messages = [];
        if (tracked.length) {
          const result = await runGit(["restore", "--worktree", "--", ...tracked], {
            cwd: repo.root,
          });
          if (!result.ok) messages.push(result.message);
        }
        for (const filePath of removed) {
          try {
            fs.rmSync(path.resolve(repo.root, filePath), { recursive: true, force: true });
          } catch (error) {
            messages.push(String(error?.message ?? error));
          }
        }
        return { ok: messages.length === 0, message: messages.filter(Boolean).join("; ") || undefined };
      });
    }

    case "git/apply-patch": {
      const action = String(payload.action ?? "");
      if (!["stage", "unstage", "discard"].includes(action)) {
        return { ok: false, message: `Unknown patch action: ${action}` };
      }
      return withRepo((repo) => applyPatch(repo, payload.patch, action));
    }

    // -- committing ---------------------------------------------------------
    case "git/commit": {
      const message = String(payload.message ?? "").trim();
      if (!message && !payload.amend) return { ok: false, message: "Commit message is empty." };
      return withRepo(async (repo) => {
        const args = ["commit"];
        if (payload.amend) args.push("--amend");
        if (message) args.push("-F", "-");
        else args.push("--no-edit");
        if (payload.signoff) args.push("--signoff");
        const result = await runGit(args, { cwd: repo.root, input: message });
        return {
          ok: result.ok,
          stdout: result.stdout,
          message: result.ok ? undefined : result.message,
        };
      });
    }

    case "git/last-message":
      return withRepo(async (repo) => {
        const result = await runGit(["log", "-1", "--pretty=format:%B"], { cwd: repo.root });
        return { ok: result.ok, message: result.ok ? result.stdout.trim() : result.message };
      });

    // -- branches and sync ---------------------------------------------------
    case "git/checkout":
      return withRepo(async (repo) => {
        const name = String(payload.name ?? "").trim();
        const startPoint = String(payload.startPoint ?? "").trim();
        if (!name) return { ok: false, message: "Branch name is required." };
        if (/[\s~^:?*\[\\]/.test(name) || name.startsWith("-")) {
          return { ok: false, message: "Branch name contains invalid characters." };
        }
        const args = payload.create
          ? ["switch", "--create", name, ...(startPoint ? [startPoint] : [])]
          : ["switch", name];
        let result = await runGit(args, { cwd: repo.root });
        if (!result.ok && !payload.create) {
          // Older Git, or switching to a remote-tracking branch.
          result = await runGit(["checkout", ...(startPoint ? [startPoint] : []), name], {
            cwd: repo.root,
          });
        }
        return { ok: result.ok, message: result.ok ? undefined : result.message };
      });

    case "git/create-branch":
      return withRepo(async (repo) => {
        const name = String(payload.name ?? "").trim();
        if (!name) return { ok: false, message: "Branch name is required." };
        if (/[\s~^:?*\[\\]/.test(name) || name.startsWith("-")) {
          return { ok: false, message: "Branch name contains invalid characters." };
        }
        const result = await runGit(["branch", "--", name], { cwd: repo.root });
        return { ok: result.ok, message: result.ok ? undefined : result.message };
      });

    case "git/fetch":
    case "git/push":
    case "git/pull": {
      const remote = String(payload.remote ?? "").trim();
      const branch = String(payload.branch ?? "").trim();
      const target = [remote, branch].filter(Boolean);
      return withRepo(async (repo) => {
        const args = [channel.slice("git/".length), ...target];
        // The views send this whenever the branch has no upstream, so that the
        // first push establishes tracking and the ahead/behind counts start
        // working. It used to be accepted and then ignored.
        if (channel === "git/push" && payload.setUpstream === true) args.push("--set-upstream");
        // Credential prompts are disabled, so these fail fast and visibly rather
        // than hanging with no terminal to answer them.
        const result = await runGit(args, {
          cwd: repo.root,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        return {
          ok: result.ok,
          stdout: result.stdout,
          stderr: result.stderr,
          message: result.ok ? undefined : result.message,
          // Machine-readable so the views can phrase it in the user's language.
          authHint: result.ok ? undefined : authHint(result.stderr),
        };
      });
    }

    case "git/stash": {
      const action = String(payload.action ?? "push");
      return withRepo(async (repo) => {
        let args;
        if (action === "push") {
          args = ["stash", "push", "--include-untracked", "--message", String(payload.message ?? "").trim() || "IDEA Git stash"];
        } else if (action === "pop" || action === "apply") {
          args = ["stash", action, String(payload.ref ?? "")].filter(Boolean);
        } else if (action === "drop") {
          args = ["stash", "drop", String(payload.ref ?? "")].filter(Boolean);
        } else {
          return { ok: false, message: `Unknown stash action: ${action}` };
        }
        const result = await runGit(args, { cwd: repo.root });
        return { ok: result.ok, stdout: result.stdout, message: result.ok ? undefined : result.message };
      });
    }

    // -- misc ---------------------------------------------------------------
    // -- commit message drafting ---------------------------------------------
    case "git/models": {
      try {
        const models = await pi.models.list();
        return { ok: true, models, preferred: (await readPrefs()).ui?.commitModelKey ?? "" };
      } catch (error) {
        return { ok: false, code: "NO_MODEL", message: String(error?.message ?? error), models: [] };
      }
    }

    case "git/commit-message":
      return withRepo((repo) => draftCommitMessage(repo, payload));

    // -- commit-level actions (Log) ------------------------------------------
    case "git/cherry-pick":
    case "git/revert": {
      const hash = String(payload.hash ?? "");
      if (!/^[0-9a-f]{4,64}$/i.test(hash)) return { ok: false, message: "Invalid commit hash." };
      return withRepo(async (repo) => {
        const verb = channel === "git/cherry-pick" ? "cherry-pick" : "revert";
        const result = await runGit([verb, "--no-edit", hash], { cwd: repo.root });
        return {
          ok: result.ok,
          stdout: result.stdout,
          stderr: result.stderr,
          message: result.ok ? undefined : result.message,
        };
      });
    }

    case "git/reset": {
      const hash = String(payload.hash ?? "");
      if (!/^[0-9a-f]{4,64}$/i.test(hash)) return { ok: false, message: "Invalid commit hash." };
      const mode = ["soft", "mixed", "hard", "keep"].includes(payload.mode) ? payload.mode : "mixed";
      return withRepo(async (repo) => {
        const result = await runGit(["reset", `--${mode}`, hash], { cwd: repo.root });
        return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, message: result.ok ? undefined : result.message };
      });
    }

    case "git/tag": {
      const name = String(payload.name ?? "").trim();
      const hash = String(payload.hash ?? "").trim();
      if (!name || /[\s~^:?*\[\\]/.test(name) || name.startsWith("-")) {
        return { ok: false, message: "Invalid tag name." };
      }
      if (hash && !/^[0-9a-f]{4,64}$/i.test(hash)) return { ok: false, message: "Invalid commit hash." };
      return withRepo(async (repo) => {
        const result = await runGit(["tag", name, ...(hash ? [hash] : [])], { cwd: repo.root });
        return { ok: result.ok, message: result.ok ? undefined : result.message };
      });
    }

    /** `--name-status` gives the Changed Files pane its list, one line per file. */
    case "git/commit-files": {
      const hash = String(payload.hash ?? "");
      if (!/^[0-9a-f]{4,64}$/i.test(hash)) return { ok: false, message: "Invalid commit hash." };
      return withRepo(async (repo) => {
        const result = await runGit(
          ["show", "--no-color", "--name-status", "--format=", "--no-renames", hash],
          { cwd: repo.root },
        );
        const files = result.stdout
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            const parts = line.split("\t");
            return { status: (parts[0] ?? "M").charAt(0), path: parts.slice(1).join("\t") };
          })
          .filter((entry) => entry.path);
        return { ok: result.ok, files, message: result.ok ? undefined : result.message };
      });
    }

    /** Rewording is only safe for the tip, which is what the UI offers. */
    case "git/amend-message": {
      const message = String(payload.message ?? "").trim();
      if (!message) return { ok: false, message: "Commit message is empty." };
      return withRepo(async (repo) => {
        const result = await runGit(["commit", "--amend", "-F", "-"], { cwd: repo.root, input: message });
        return { ok: result.ok, message: result.ok ? undefined : result.message };
      });
    }

    // -- preferences --------------------------------------------------------
    case "git/prefs":
      return { ok: true, prefs: await readPrefs() };

    case "git/prefs-set": {
      const current = await readPrefs();
      const uiPatch = payload?.ui && typeof payload.ui === "object" ? payload.ui : {};
      return { ok: true, prefs: await writePrefs({ messages: current.messages, ui: { ...current.ui, ...uiPatch } }) };
    }

    case "git/message-used":
      return { ok: true, prefs: await writePrefs(rememberMessage(await readPrefs(), payload?.message)) };

    // -- console ------------------------------------------------------------
    case "git/console":
      return { ok: true, entries: consoleLog() };

    case "git/console-clear":
      clearConsoleLog();
      return { ok: true };

    case "git/relative-time":
      return { ok: true, now: Date.now() };

    default:
      return { ok: false, message: `Unsupported channel: ${channel}` };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const OPEN_COMMAND = "pi-idea-git.open";
const REFRESH_COMMAND = "pi-idea-git.refresh";

async function onLoad() {
  // The host re-broadcasts workspace switches to plugin processes; tracking them
  // keeps `workspacePath()` honest for any path that does not go through
  // `readRepo()` (which refreshes on its own).
  try {
    pi.events?.on?.("workspace:changed", () => {
      refreshWorkspace().catch(() => {});
    });
  } catch {
    // Older host without plugin-process events: readRepo still refreshes.
  }

  await pi.commands.register({
    id: OPEN_COMMAND,
    title: "IDEA Git: Open as separate window",
    keywords: ["git", "idea", "commit", "diff", "stage"],
    run: async () => {
      await pi.ui.openPanel({ title: "IDEA Git" });
    },
  });

  await pi.commands.register({
    id: REFRESH_COMMAND,
    title: "IDEA Git: Refresh repository",
    keywords: ["git", "refresh"],
    run: async () => {
      await refreshWorkspace();
      const repo = await readRepo();
      await pi.ui.showToast(
        repo.ok ? `Git repository: ${repo.name}` : repo.message,
        repo.ok ? "info" : "error",
      );
    },
  });
}

async function onUnload() {
  gitBinaryCache = undefined;
  try {
    await pi.commands.unregister(OPEN_COMMAND);
  } catch {
    // The host already tore the commands down.
  }
  try {
    await pi.commands.unregister(REFRESH_COMMAND);
  } catch {
    // Same.
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke, refreshWorkspace };
