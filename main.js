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
 * `message` is the short form for a toast; on failure it is built from *both*
 * streams (`gitError`) and `detail` carries the whole of what Git said.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, message?: string, detail?: string|null}>}
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
        message: failure ?? (code === 0 ? undefined : gitError(stdout, stderr, code)),
        // The whole of what Git said, hints included: the toast shows `message`
        // and links here, so nothing Git explained is lost to the six-line cap.
        detail: code === 0 ? undefined : gitDetail(stdout, stderr),
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
 * How many lines of Git's own output the one-line message carries. The toast is
 * small and disappears; `detail` is where the whole thing goes.
 */
const ERROR_LINES = 6;
/** Bounded so a runaway command cannot push megabytes through the bridge. */
const ERROR_DETAIL_CHARS = 4000;

/**
 * Turn a failed command's output into something a person can act on.
 *
 * Both streams are read, because Git does not agree on one: `git push` reports
 * the rejection on **stderr**, while `git merge` — and therefore the second half
 * of `git pull` — reports `CONFLICT` on **stdout**. Reading only stderr, which
 * is what this used to do, turned a conflicted pull into a message that read
 * like a successful fetch log.
 *
 * `hint:` lines are dropped here because they are Git's generic advice, in
 * English; the remedy shown instead is classified by
 * `authHint`/`pushHint`/`pullHint` and worded by the views in the user's own
 * language. They are still in `detail`, which is what the toast links to. When
 * dropping them would leave nothing at all they are kept: the rule is "say
 * something", not "say nothing that came from a hint".
 */
function gitError(stdout, stderr, code) {
  const meaningful = [];
  const hints = [];
  const seen = new Set();
  for (const stream of [stderr, stdout]) {
    for (const raw of String(stream ?? "").split("\n")) {
      const line = raw.trimEnd();
      const key = line.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      (key.startsWith("hint:") ? hints : meaningful).push(line);
    }
  }
  const lines = meaningful.length ? meaningful : hints;
  if (!lines.length) return `git exited with ${code}`;
  return lines.slice(0, ERROR_LINES).join("\n");
}

/** The untrimmed output, for the details dialog behind an error toast. */
function gitDetail(stdout, stderr) {
  const text = [stderr, stdout]
    .map((stream) => String(stream ?? "").trim())
    .filter(Boolean)
    .join("\n");
  if (!text) return null;
  return text.length > ERROR_DETAIL_CHARS ? `${text.slice(0, ERROR_DETAIL_CHARS)}\n…` : text;
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
function authHint(stdout, stderr) {
  const text = `${stderr ?? ""}\n${stdout ?? ""}`;
  if (!text.trim()) return null;
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

/**
 * Classify a refused push so the views can name the way out.
 *
 * Git prints `! [rejected]` (or `[remote rejected]`) and then the reason in
 * parentheses. Two of those reasons are one situation for the user — someone
 * else moved the branch, and it has to be integrated before it can be pushed
 * again — and the rest are the server saying no outright. Returns a stable
 * code, never prose.
 */
function pushHint(stdout, stderr) {
  const text = `${stderr ?? ""}\n${stdout ?? ""}`;
  if (!/!\s*\[(?:remote )?rejected\]/i.test(text)) return null;
  if (/\((?:fetch first|non-fast-forward|stale info)\)/i.test(text)) return "remote-ahead";
  return "remote-rejected";
}
/**
 * True when `git pull` refused only because no reconcile strategy is
 * configured — the one failure this plugin answers itself, by retrying with
 * `--no-rebase`. Every other refusal is the user's configuration talking, and
 * is reported as it came.
 */
function needsReconcile(stdout, stderr) {
  return /Need to specify how to reconcile divergent branches/i.test(`${stdout ?? ""}\n${stderr ?? ""}`);
}

/**
 * Classify a failed pull.
 *
 * `diverged` is what a user's own `pull.ff = only` says when it refuses a
 * diverged branch. `conflicts` is the other outcome worth naming: Git reports it
 * on stdout, and "there are conflicts to resolve" is the one thing the user must
 * be told, since a pull that half-succeeded otherwise looks like a plain fetch.
 */
function pullHint(stdout, stderr) {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`;
  if (/Need to specify how to reconcile|Not possible to fast-forward/i.test(text)) return "diverged";
  if (/CONFLICT \(|Automatic merge failed|fix conflicts and then commit/i.test(text)) return "conflicts";
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
const STYLE_SAMPLE_COMMITS = 40;
/** The diff is a prompt, not a backup: keep it small enough to stay quick. */
const MAX_PROMPT_PATCH_CHARS = 12_000;

/**
 * The instruction the model follows.
 *
 * "Match the repository" is the obvious rule and the one that used to be here,
 * but it leaves two things to a guess: the language, which then follows training
 * data back to English however Chinese the user is, and the shape of a good
 * message, which the model has seen plenty of but not necessarily in this diff.
 * So the language arrives as a parameter, and the facts `buildCommitContext`
 * measured about the repository (language, subject prefix, body usage) arrive
 * with the request.
 *
 * The prompt is deliberately long. A commit subject is short-lived in attention
 * but permanent in history, and every clause below answers a failure that shows
 * up in real drafts: a code fence, a "commit message:" prefix, a body that
 * restates the diff, an English subject on a Chinese project, a subject that
 * never ends, punctuation half full-width.
 */
function buildSystemPrompt(lang, style) {
  // The history's language and the drafted message's language are two different
  // things, and the model will follow whichever it is told about last. So every
  // branch below states the language the message MUST be written in, then says
  // what the history is for: evidence of tone and structure, never a licence to
  // switch language.
  //
  // This note is keyed on the history being *empty*, not on its language being
  // unmeasurable: a repository whose subjects carry no letters still has a
  // history, and telling the model otherwise would contradict the samples it is
  // shown in the same request.
  const noHistory = style.count === 0;
  const historyNote = noHistory
    ? "This repository has no commit history to follow, so the rules above are the only guidance on how the message reads."
    : null;

  const languageRule = lang === "zh"
    ? [
        "Write the commit message in Simplified Chinese, including the subject and every line of the body.",
        style.language === "zh"
          ? "The repository's own history is Chinese too, so match its tone as well."
          : style.language === "en"
            ? "The repository's history is in English, but that is not the language of this message: use Chinese anyway, and use that history only as a model for structure and for how long a subject runs."
            : historyNote ?? "The repository's history gives no clear signal about wording; follow the rules above.",
        "Use half-width punctuation where characters are ASCII and full-width where they are Chinese: `feat(登录): 支持短信验证码`, not `feat（登录）:支持短信验证码`.",
      ]
    : [
        "Write the commit message in English, including the subject and every line of the body.",
        "Keep the subject in the imperative mood, start it with a capital letter, and do not end it with a full stop.",
        // The same guard the Chinese branch carries, for the same reason: a
        // Chinese history must not drag an explicitly-English draft into
        // Chinese.
        style.language === "zh"
          ? "The repository's history is Chinese, but that is not the language of this message: use English anyway, and use that history only as a model for structure and for how long a subject runs."
          : historyNote ?? "The repository's history gives no clear signal about wording; follow the rules above.",
      ].filter(Boolean);

  const conventional = style.conventional
    ? "This repository prefixes its subjects: `type(scope): description`. Keep that shape, keep the `type` and `scope` in ASCII exactly as the samples spell them, and pick the one type that dominates this change. If the samples use no scope, leave the parentheses out rather than inventing one."
    : "Do not invent a `type:` prefix. Follow the subject shape this repository already uses.";

  // Keyed off the language the message is actually written in, not off the
  // repository's measured history: for a Chinese draft the guidance on line
  // length has to be the Chinese one even when the history was English or empty.
  const bodyStyle = lang === "zh"
    ? "In the body wrap English lines near 72 columns and keep Chinese lines short; write each bullet as one idea rather than one file."
    : "In the body wrap English lines near 72 columns; write each bullet as one idea rather than one file.";

  return [
    "You write a single Git commit message.",
    "Reply with that message and nothing else: no preamble, no explanation, no analysis, no markdown code fences, no `commit message:` label, no surrounding quotes.",
    "First line is the subject; it states what the change does, never what it is.",
    "Keep the subject short: aim for 50 characters and never exceed 72. A Chinese character is about twice as wide as a Latin one, so a Chinese subject stays under about 25 characters, and the subject is a single line — never continue it into the first sentence of the body.",
    "The blank line after the subject is mandatory. Git treats every line up to the first blank line as the title, so a message without it has no body at all — only one enormous subject.",
    "The body says why the change was made and what it makes different from here on: not a file list, not a walk through the diff, not the names of the functions you saw. Write one idea per line, and when the change has several parts give each part its own line.",
    "When the change is thoroughly self-evident, the subject alone is the whole message.",
    bodyStyle,
    "After the body, leave another blank line and then footers, when they apply: `BREAKING CHANGE: <what callers must do>` for a change that is not backward compatible. Do not add any other trailer.",
    "Never mention that you wrote the message, never address the user, and never ask a question.",
    conventional,
    // A worked example beats another rule, and it is the one thing that fixes
    // the failure this prompt kept hitting: the model knew the words "blank
    // line" and still returned subject-then-body with nothing between them.
    // Showing the shape is unambiguous in a way the sentence was not.
    "Reply in exactly this shape, with your own content:",
    "<commit-message>",
    ...(lang === "zh"
      ? [
          style.conventional ? "feat(登录): 支持短信验证码登录" : "支持短信验证码登录",
          "",
          "- 验证码 60 秒内可重发，过期后提示重新获取",
          "- 连续失败三次锁定十分钟，避免被暴力猜解",
          "- 未登录用户仍可用密码登录，行为不变",
        ]
      : [
          style.conventional ? "feat(auth): add SMS code sign-in" : "Add SMS code sign-in",
          "",
          "- Let the code be resent after 60 seconds and say so once it expires",
          "- Lock the account for ten minutes after three failed attempts",
          "- Password sign-in is unchanged for accounts without a phone number",
        ]),
    "</commit-message>",
    ...languageRule,
  ].join("\n");
}

/**
 * Which language the message must be written in. `auto` is not "guess": it is
 * the language the repository's own subjects are written in, measured by
 * `commitStyle`, and it falls back to the view's locale so a brand-new
 * repository still lands in the language the user reads.
 */
function resolveCommitLang(preference, style, locale) {
  if (preference === "zh") return "zh";
  if (preference === "en") return "en";
  if (style.language) return style.language;
  return String(locale ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** Strip the shapes a model adds around a message even when told not to. */
function tidyCommitMessage(raw) {
  let text = String(raw ?? "").trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(commit message|提交信息)\s*[:：]\s*/i, "");
  return text.replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------
// Shaping the message
//
// The model is asked for a shape; this section *enforces* it. Everything here
// answers a defect that shows up in real drafts and that a prompt alone did not
// prevent:
//
//   - the body begins on the line straight after the subject, with no blank
//     line between them. Git takes everything up to the first blank line as the
//     title, so that draft is one enormous subject — the defect a reader
//     reports as "this is not a proper commit message".
//   - the body is one run-on sentence, or three ideas joined by `；`, where one
//     idea per line belongs.
//   - nothing is wrapped: a model does not measure columns, so a Chinese body
//     arrives as a single 150-column line.
//
// None of it rewrites the model's words. It only puts those words where Git
// expects to find them.
// ---------------------------------------------------------------------------

/**
 * Display width, not `String.length`: every terminal and every web Git host
 * renders a CJK glyph two columns wide, which is why the 50/72 rule from
 * git-commit(1) means about 25 Chinese characters rather than 50.
 */
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

function textWidth(value) {
  let width = 0;
  for (const char of String(value ?? "")) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

/** git-commit(1) asks for 50 columns and tools start truncating at 72. */
const SUBJECT_TARGET_WIDTH = 50;
const SUBJECT_MAX_WIDTH = 72;
const BODY_WRAP_WIDTH = 72;

/**
 * Hard-wrap to `limit` columns. Latin breaks at the last space so words survive
 * intact; CJK has no spaces and may break between any two characters, which is
 * what a reader of Chinese expects anyway.
 */
function wrapText(value, limit) {
  const out = [];
  let line = "";
  const flush = () => {
    if (line) out.push(line);
    line = "";
  };
  for (const char of String(value ?? "")) {
    if (char === "\n") {
      flush();
      continue;
    }
    if (!line || textWidth(line) + textWidth(char) <= limit) {
      line += char;
      continue;
    }
    const space = line.lastIndexOf(" ");
    // Only honour a space in the back half of the line: breaking at one far to
    // the left would leave every wrapped line ragged.
    if (space >= limit / 2) {
      out.push(line.slice(0, space));
      line = `${line.slice(space + 1)}${char}`;
    } else {
      flush();
      line = char;
    }
  }
  flush();
  return out;
}

/** A title is never a list item and never ends in punctuation. */
const TITLE_TRIM = /^[-*+\s]+|[\s。．.，,；;：:、]+$/g;

/**
 * Keep the subject a subject. Handed a change with three parts, a model tends to
 * write all three into the first line, which is how a subject ends up past the
 * 72-column ceiling and reads like a paragraph. The overflow moves into the body
 * at a clause boundary rather than being truncated: nothing the model saw in the
 * diff is discarded, it is only put where Git expects it.
 */
function splitSubject(value) {
  const subject = String(value ?? "").replace(TITLE_TRIM, "");
  if (textWidth(subject) <= SUBJECT_MAX_WIDTH) return { subject, rest: [] };

  const boundaries = [];
  const pattern = /[，,；;：:。！？!?]\s*/g;
  let match;
  while ((match = pattern.exec(subject))) boundaries.push(match.index + match[0].length);
  const fitsTarget = boundaries
    .filter((index) => textWidth(subject.slice(0, index)) <= SUBJECT_TARGET_WIDTH)
    .pop();
  const fitsCeiling = boundaries.find((index) => textWidth(subject.slice(0, index)) <= SUBJECT_MAX_WIDTH);
  const cut = fitsTarget ?? fitsCeiling;
  // No boundary fits: the subject is one unbroken phrase, and cutting it would
  // invent a title the model never wrote. Leave it alone.
  if (!cut) return { subject, rest: [] };

  return {
    subject: subject.slice(0, cut).replace(TITLE_TRIM, ""),
    rest: [subject.slice(cut).trim()],
  };
}

/**
 * Chinese punctuation inside Chinese text. Models drift to the ASCII `,` and
 * `;` mid-sentence, which reads as a typo in a commit log. The guard is strictly
 * Han-on-both-sides, so `feat(a,b): 支持` and anything else in ASCII — paths,
 * identifiers, URLs — is left exactly as written.
 */
function normalizeCommitPunctuation(value) {
  return String(value ?? "").replace(
    /([\p{Script=Han}])([,;])(?=[\p{Script=Han}])/gu,
    (match, before, mark) => `${before}${mark === "," ? "，" : "；"}`,
  );
}

/** A body line indented under the bullet above it — the shape wrapping produces. */
const CONTINUATION_LINE = /^[ \t]/;

/**
 * Rejoin a line with the one it was wrapped from. Latin wrapping consumes the
 * space it broke at, so it has to be put back; CJK wrapping breaks between two
 * characters and must not gain one. Asking whether the two ends are ASCII is
 * enough to tell those apart, and it is what makes this function idempotent.
 */
function joinWrapped(previous, next) {
  const needsSpace = /[A-Za-z0-9,;:.)\]"'`]$/.test(previous) && /^[A-Za-z0-9(\["'`]/.test(next);
  return needsSpace ? `${previous} ${next}` : `${previous}${next}`;
}

/** One logical line of the body, rendered into `out` at Git's 72-column width. */
function renderParagraph(out, text) {
  const bullet = /^[-*+]\s+/.exec(text);
  // A semicolon joins separate ideas, and the prompt asked for one idea per
  // line — but only when the line is long enough for that to be the problem:
  // splitting `修复拼写；无行为变化` into two bullets would be noise.
  const clauses = bullet ? [text] : text.split(/[；;]/).map((part) => part.trim()).filter(Boolean);
  if (clauses.length > 1 && textWidth(text) > SUBJECT_TARGET_WIDTH) {
    for (const clause of clauses) {
      // The marker spends two columns, so the text keeps the same right edge.
      wrapText(clause, BODY_WRAP_WIDTH - 2).forEach((line, index) => {
        out.push(index ? `  ${line}` : `- ${line}`);
      });
    }
    return;
  }
  if (bullet) {
    const indent = " ".repeat(bullet[0].length);
    wrapText(text.slice(bullet[0].length), BODY_WRAP_WIDTH - bullet[0].length).forEach((line, index) => {
      out.push(index ? `${indent}${line}` : `${bullet[0]}${line}`);
    });
    return;
  }
  out.push(...wrapText(text, BODY_WRAP_WIDTH));
}

/**
 * The message the user actually receives — shaped here rather than trusted from
 * the model. `subject` is one line; exactly one blank line separates it from the
 * body, even when the model forgot it; the body is wrapped to Git's 72 columns,
 * and semicolon-joined clauses become one bullet each.
 *
 * Idempotent on a well-formed draft, which matters because this runs on every
 * reply and that reply may already be correct: a subject under the ceiling keeps
 * its line, a body already broken into bullets is only re-wrapped (its
 * continuation lines are re-joined first, then wrapped to the same result), and
 * a paragraph with a single clause stays prose.
 */
function formatCommitMessage(raw) {
  const text = normalizeCommitPunctuation(tidyCommitMessage(raw)).replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));

  let index = 0;
  while (index < lines.length && !lines[index].trim()) index++;
  if (index >= lines.length) return "";
  const { subject, rest } = splitSubject(lines[index].trim());
  index++;

  // Fold the body into logical lines. An indented line continues the line above
  // it, which is how this function itself writes a wrapped bullet or sentence; a
  // blank line is a paragraph break and nothing else is.
  const logical = [];
  let pending = null;
  for (const line of lines.slice(index)) {
    if (!line.trim()) {
      if (pending) {
        logical.push(pending);
        pending = null;
      }
      if (logical.length && !logical[logical.length - 1].paragraphBreak) {
        logical.push({ paragraphBreak: true });
      }
      continue;
    }
    if (pending && CONTINUATION_LINE.test(line)) {
      pending = { text: joinWrapped(pending.text, line.trim()) };
      continue;
    }
    if (pending) logical.push(pending);
    pending = { text: line.trim() };
  }
  if (pending) logical.push(pending);
  while (logical.length && logical[logical.length - 1].paragraphBreak) logical.pop();

  const body = [];
  for (const item of [...rest.map((text_) => ({ text: text_ })), ...logical]) {
    if (item.paragraphBreak) {
      // Paragraph breaks the model wrote are preserved, never doubled.
      if (body.length && body[body.length - 1] !== "") body.push("");
      continue;
    }
    renderParagraph(body, item.text);
  }
  while (body.length && body[body.length - 1] === "") body.pop();

  return body.length ? `${subject}\n\n${body.join("\n")}` : subject;
}

/** A subject prefix (`fix(parser)!: …`) — the pattern, not its type names. */
const SUBJECT_PREFIX = /^[a-z][a-z0-9-]*(?:\([^)\n]{1,30}\))?!?: \S/;

/**
 * What the repository's recent history says about how to write here: which
 * language it commits in, whether it prefixes its subjects, and whether anyone
 * writes a body. Read from full messages rather than subjects, because the last
 * two are properties of the whole message.
 *
 * `language` is `null` only when there is nothing to measure — an empty history,
 * or subjects with no letters at all. It used to collapse that case to `"en"`,
 * which made `resolveCommitLang`'s locale fallback dead code: a brand-new
 * repository drafted in English no matter which language the window spoke.
 * "Unknown" is a real answer and has to survive this far for the caller to act
 * on it — but it must stay reserved for that case. A repository that *does*
 * have history has a language, and folding a tie into `null` would hand a
 * Chinese repository to the locale fallback just because its subjects also
 * contain ASCII.
 */
function commitStyle(samples) {
  // A subject with Chinese in it is a Chinese subject, full stop: the two
  // buckets are mutually exclusive rather than both-incrementing. Counting
  // `feat(登录): 支持短信验证码` in *both* buckets (it has CJK and a 3-letter
  // ASCII run) made every subject in a Chinese Conventional-Commits repository
  // cancel out, so the tie-break decided the language instead of the evidence.
  const isChinese = (value) => /[\u3400-\u9fff]/.test(value);
  const chinese = samples.filter((entry) => isChinese(entry.subject)).length;
  const english = samples.filter(
    (entry) => !isChinese(entry.subject) && /[A-Za-z]{3}/.test(entry.subject),
  ).length;
  return {
    // `count` is what callers need to tell "no history" apart from "history I
    // could not classify": `language` is null in both cases, but only the first
    // one lets the prompt say the repository has no history.
    count: samples.length,
    language: chinese || english ? (chinese >= english ? "zh" : "en") : null,
    conventional: samples.filter((entry) => SUBJECT_PREFIX.test(entry.subject)).length >= 2,
    bodies: samples.some((entry) => entry.body),
  };
}

/**
 * Parse `git log --format=%s%x00%b%x1e` into subjects and bodies. The
 * separators are control characters, which no commit message can contain, so
 * this stays a split rather than a regex over user text.
 */
function parseStyleSamples(stdout) {
  return String(stdout ?? "")
    .split(RS_CHAR)
    .map((record) => {
      const [subject, body] = record.split(FS_CHAR);
      return { subject: String(subject ?? "").trim(), body: String(body ?? "").trim() };
    })
    .filter((entry) => entry.subject);
}

/**
 * What the model gets to read: the change, plus what the repository's own
 * history says about how a message is written here. The facts are computed by
 * us and stated in prose; the samples stay as evidence of tone.
 */
async function buildCommitContext(repo, payload) {
  const path = typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : null;
  const mode = payload?.mode === "index" ? "index" : "worktree";

  // The caller passes repository-relative paths; only paths that stay inside
  // the repository are accepted, the same rule the staging channels use.
  if (path && !isSafePath(path)) {
    return { ok: false, code: "BAD_PATH", message: "Unsafe path rejected." };
  }

  const log = await runGit(
    ["log", `-${STYLE_SAMPLE_COMMITS}`, `--pretty=format:%s${FS_CHAR}%b${RS_CHAR}`],
    { cwd: repo.root },
  );
  const samples = log.ok ? parseStyleSamples(log.stdout) : [];
  const style = commitStyle(samples);
  const lang = resolveCommitLang(payload?.lang, style, payload?.locale);

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
    // `status --porcelain` folds a rename into one record and marks a
    // conflicted file once, where `diff --name-only` repeats a path that is
    // changed in both the index and the worktree.
    const names = await runGit(["status", "--porcelain", "--untracked-files=no"], { cwd: repo.root });
    files = names.ok
      ? [...new Set(names.stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean))]
      : [];
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

  const truncated = patch.length > MAX_PROMPT_PATCH_CHARS;
  // State the language the message must be written in, not merely what the
  // history happens to be: when those disagreed (English history, Chinese
  // draft) the old wording restated the history and the model followed *it*.
  // Branch on `style.language` itself, never on the display string derived from
  // it, so rewording a label cannot silently flip which clause is chosen.
  const hasHistory = style.count > 0;
  const historyLanguage = style.language === "zh"
    ? "Chinese"
    : style.language === "en" ? "English" : null;
  const styleLines = [
    // "No history" is a claim about `samples`, so it is gated on `samples`:
    // `language` is also null for an empty history, but a measured history can
    // still have no lettered subjects, and calling that "no history" while the
    // samples are printed below would contradict the same message.
    hasHistory && historyLanguage
      ? `Language of recent commit subjects: ${historyLanguage}.`
      : hasHistory
        ? "Language of recent commit subjects: not determinable from the samples below."
        : "Recent commit subjects: none to measure — this repository has no commit history yet.",
    lang === "zh"
      ? `Write this message in Simplified Chinese${style.language === "en"
          ? " even though the history is English; use that history only for structure and subject length."
          : style.language === "zh" ? ", matching the history." : "."}`
      : `Write this message in English${style.language === "zh"
          ? ", even though the history is Chinese."
          : style.language === "en" ? ", matching the history." : "."}`,
  ];
  const body = [
    "Repository commit style",
    "-----------------------",
    ...styleLines,
    `Subject prefix: ${style.conventional
      ? "recent subjects look like `type(scope): description`; keep that shape."
      : "recent subjects carry no `type:` prefix; do not add one."}`,
    style.bodies
      ? "Recent commits do write bodies; use one when the change needs it."
      : "Recent commits are usually a single line; add a body only when the change genuinely needs one.",
    "",
    "Format the message as:",
    "  subject",
    "  <blank line>",
    "  body, when it helps",
    "",
    samples.length
      ? `Recent commit messages from this repository:\n${samples.map((entry) => entry.subject).join("\n")}`
      : "This repository has no commit history yet.",
    "",
    "Change to describe",
    "------------------",
    "```diff",
    truncated ? patch.slice(0, MAX_PROMPT_PATCH_CHARS) : patch,
    truncated ? "[diff truncated: describe what is visible here, and nothing you cannot see]" : "",
    "```",
  ].filter((line) => line !== "").join("\n");

  // The prompt describes the scope in prose; the caller gets the structure above
  // and phrases it in the user's language.
  return { ok: true, content: body, lang, style, scope, files };
}

async function listModels() {
  let models;
  try {
    models = await pi.models.list();
  } catch (error) {
    return {
      ok: false,
      code: String(error?.code ?? "MODEL_LIST_FAILED"),
      message: String(error?.message ?? error),
      models: [],
    };
  }
  if (!Array.isArray(models) || !models.length) {
    return { ok: false, code: "NO_MODEL", message: "No model is available.", models: [] };
  }
  return { ok: true, models };
}

/**
 * Draft a message for the current selection, or for everything staged when
 * nothing is selected. `text` carries the draft; `message` stays what it is
 * everywhere else in this file — the error text.
 */
async function draftCommitMessage(repo, payload) {
  const listing = await listModels();
  if (!listing.ok) return listing;
  const models = listing.models;

  const wanted = String(payload?.modelKey ?? "").trim();
  const model = models.find((row) => row.key === wanted) ?? models[0];

  const context = await buildCommitContext(repo, payload);
  if (!context.ok) return context;
  const system = buildSystemPrompt(context.lang, context.style);

  try {
    const result = await pi.agent.complete({
      modelKey: model.key,
      system,
      messages: [{ role: "user", content: context.content }],
    });
    // Shaped here, not trusted from the model: see `formatCommitMessage`.
    const text = formatCommitMessage(result?.text);
    if (!text) return { ok: false, code: "EMPTY_REPLY", message: "The model returned nothing." };
    return {
      ok: true,
      text,
      modelKey: result?.modelKey ?? model.key,
      lang: context.lang,
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

/**
 * The refs that say an operation is unfinished. None of them is visible in
 * porcelain output.
 */
const SEQUENCER_REFS = [
  ["MERGE_HEAD", "merge"],
  ["REBASE_HEAD", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/** Which operation is in progress, or null. One command per candidate. */
async function probeOperation(repoRoot) {
  for (const [ref, name] of SEQUENCER_REFS) {
    const result = await runGit(["rev-parse", "-q", "--verify", ref], { cwd: repoRoot });
    if (result.ok && result.stdout.trim()) return name;
  }
  return null;
}

/**
 * The last answer `readOperation` gave, so the probe can stop asking on an
 * ordinary refresh without losing the answer exactly when it matters.
 */
let pendingOperation = { root: null, operation: null };

/**
 * Which unfinished operation left these conflicts behind, if any.
 *
 * The gate is not "there are conflicts". Once every conflicted file has been
 * staged, porcelain v2 simply stops reporting `u` lines — but the merge or
 * rebase is still in progress, and that is precisely the moment Continue starts
 * being able to succeed. Gating on `conflicted` therefore hid the only way out
 * of the state the plugin itself can create. So the probe runs while there are
 * conflicts *or* while it found an operation a moment ago, and stops only when
 * Git agrees the operation is over. A refresh outside both cases pays nothing.
 */
async function readOperation(repoRoot, conflicted) {
  if (pendingOperation.root !== repoRoot) pendingOperation = { root: repoRoot, operation: null };
  if (!conflicted.length && !pendingOperation.operation) return null;
  pendingOperation.operation = await probeOperation(repoRoot);
  return pendingOperation.operation;
}

/**
 * A ref name or remote that came from a caller, checked before it is handed to
 * Git as a positional argument.
 *
 * `git push origin --force` is what a `-`-prefixed value produces, which is the
 * one thing the lease-only rule is supposed to make impossible; the same shape
 * would turn `git fetch` into something else entirely. The views no longer send
 * these fields at all, so this is the engine's own boundary: the panel bridge
 * forwards any channel to `onPanelInvoke`, and a boundary that trusts its input
 * is not a boundary.
 */
function refArg(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.startsWith("-") || /\s/.test(text)) return null;
  return text;
}

/**
 * Where a push should go.
 *
 * The branch's own upstream is the only target that agrees with the ↑/↓ chip:
 * the views used to send `origin` plus the local branch name, which pushed a new
 * branch to `origin` while the chip kept counting against the real upstream.
 * With no upstream there is nothing to agree with, so the fallback stays narrow
 * — `origin`, or the single remote when there is only one — and refuses to guess
 * when there are several. Choosing "the first remote" would be alphabetical
 * order deciding where someone's branch gets published.
 */
async function resolvePushTarget(repoRoot) {
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: repoRoot });
  const name = upstream.ok ? upstream.stdout.trim() : "";
  if (name) {
    const slash = name.indexOf("/");
    // No slash means the branch tracks another *local* branch
    // (`branch.<name>.remote = .`). There is nowhere to push to, and falling
    // back to a remote would publish the branch somewhere it was never pointed.
    if (slash < 1) {
      return { ok: false, message: `This branch tracks the local branch "${name}", so there is no remote to push to.` };
    }
    return { ok: true, remote: name.slice(0, slash), branch: name.slice(slash + 1) };
  }

  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  // An unborn branch makes `rev-parse` print HEAD and exit non-zero: there is no
  // commit to push, and saying so beats Git's "no upstream branch" for a command
  // whose whole point was to set one up.
  if (!head.ok || head.stdout.trim() === "HEAD") {
    return { ok: false, message: "This branch has no commits yet, so there is nothing to push." };
  }
  const branch = head.stdout.trim();

  const remotes = await runGit(["remote"], { cwd: repoRoot });
  const names = remotes.ok ? remotes.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  if (names.includes("origin")) return { ok: true, remote: "origin", branch };
  if (names.length === 1) return { ok: true, remote: names[0], branch };
  if (!names.length) return { ok: false, message: "This repository has no remote to push to." };

  return {
    ok: false,
    message: `"${branch}" has no upstream, and this repository has several remotes (${names.join(", ")}). Set one with \`git push --set-upstream <remote> ${branch}\`.`,
  };
}

/**
 * The sequencer commands this plugin is willing to continue or abort, and
 * nothing else: the name comes back from `readOperation`, and a whitelist keeps
 * a malformed payload from becoming an arbitrary `git` verb.
 */
const SEQUENCER = new Set(["merge", "rebase", "cherry-pick", "revert"]);

/**
 * Shape a network command's outcome for the views.
 *
 * `message` is what a toast can hold; `detail` is everything Git said, hints
 * included, for the dialog behind it; the three hint codes are stable
 * identifiers that the views word in the user's own language.
 */
function syncOutcome(channel, result) {
  if (result.ok) return { ok: true, stdout: result.stdout };
  return {
    ok: false,
    stdout: result.stdout,
    stderr: result.stderr,
    message: result.message,
    detail: gitDetail(result.stdout, result.stderr),
    authHint: authHint(result.stdout, result.stderr),
    pushHint: channel === "git/push" ? pushHint(result.stdout, result.stderr) : null,
    pullHint: channel === "git/pull" ? pullHint(result.stdout, result.stderr) : null,
  };
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
      const sub = parts[2] ?? "N...";
      const track = kind === "2" ? parts[8] : "";
      const offset = kind === "2" ? 9 : 8;
      const filePath = parts.slice(offset).join(" ");
      const originalPath =
        kind === "2" ? (tokens[index + 1] ?? "").replace(/^\n/, "") : null;
      if (kind === "2") index += 1;

      const x = xy[0];
      const y = xy[1];
      // `S<c><m><u>`: a submodule, with C=new commits, M=modified content,
      // U=untracked content. Staging a submodule from the parent repository
      // records which commit it points at; it cannot touch anything inside, so
      // a submodule with dirty content keeps a worktree-side change that no
      // amount of `git add` here will clear.
      const isSubmodule = sub.startsWith("S") || parts[3] === "160000";
      const subState = isSubmodule
        ? { commits: sub[1] === "C", modified: sub[2] === "M", untracked: sub[3] === "U" }
        : null;
      const insideSubmodule = Boolean(subState && (subState.modified || subState.untracked));

      if (x !== ".") {
        staged.push({
          path: filePath,
          originalPath,
          status: x,
          label: labelFor(x, false),
          score: track ? ` (${Number(track.slice(1))}%)` : "",
          submodule: isSubmodule,
          sub: subState,
        });
      }
      if (y !== ".") {
        unstaged.push({
          path: filePath,
          originalPath,
          status: y,
          label: labelFor(y, false),
          submodule: isSubmodule,
          sub: subState,
          // The remaining worktree change lives inside the submodule.
          insideSubmodule,
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

  // A conflicted merge/rebase/cherry-pick cannot be finished from porcelain
  // output alone, and it is the state a conflicted `pull` leaves behind, so it
  // has to reach the views: without it they cannot offer the way out.
  const operation = await readOperation(repo.root, conflicted);

  return {
    ok: true,
    // `workspace` lets the views translate repository-relative paths into the
    // workspace-relative form the host's fs channels are scoped to.
    repo: { root: repo.root, name: repo.name, workspace: repo.workspace ?? null },
    branch,
    operation,
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
  const fields = [
    "%(refname)",
    "%(refname:short)",
    "%(objectname:short)",
    "%(HEAD)",
    "%(upstream:short)",
    "%(committerdate:unix)",
    "%(contents:subject)",
  ].join(FS_CHAR);
  const result = await runGit(
    ["for-each-ref", `--format=${fields}`, "refs/heads", "refs/remotes"],
    { cwd: repo.root },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const branches = result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [ref, name, short, head, upstream, date, subject] = line.split(FS_CHAR);
      return {
        ref,
        name,
        short,
        current: head === "*",
        upstream: upstream || null,
        timestamp: Number(date) * 1000,
        subject: subject ?? "",
        remote: ref.startsWith("refs/remotes/"),
      };
    })
    // Drop the remote's symbolic HEAD (`refs/remotes/origin/HEAD`). The test
    // runs on the full refname because `%(refname:short)` shortens that ref to
    // plain `origin`, which matches no `/HEAD` suffix and used to surface as a
    // phantom local branch named `origin`.
    .filter((branch) => !branch.ref.endsWith("/HEAD"));
  return { ok: true, branches: branches.map(({ ref, ...rest }) => rest) };
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

    case "git/fetch": {
      const remote = refArg(payload.remote);
      const branch = refArg(payload.branch);
      if (remote === null || branch === null) return { ok: false, message: "Invalid remote or branch name." };
      const target = [remote, branch].filter(Boolean);
      return withRepo(async (repo) => {
        // Prompts are disabled, so this fails fast and visibly rather than
        // hanging with no terminal to answer it.
        const result = await runGit(["fetch", ...target], {
          cwd: repo.root,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        return syncOutcome("git/fetch", result);
      });
    }

    case "git/push": {
      const remote = refArg(payload.remote);
      const branch = refArg(payload.branch);
      if (remote === null || branch === null) return { ok: false, message: "Invalid remote or branch name." };
      return withRepo(async (repo) => {
        const target = remote && branch ? { ok: true, remote, branch } : await resolvePushTarget(repo.root);
        if (!target.ok) return target;
        const args = ["push", target.remote, target.branch].filter(Boolean);
        // The views send this whenever the branch has no upstream, so that the
        // first push establishes tracking and the ahead/behind counts start
        // working. It used to be accepted and then ignored.
        if (payload.setUpstream === true) args.push("--set-upstream");
        // Never a bare `--force`: the lease keeps the overwrite conditional on
        // the remote still being where it was when this plugin last saw it, so a
        // push that landed in between is refused instead of erased. `refArg`
        // above is what keeps a caller from smuggling `--force` in as the remote.
        if (payload.forceWithLease === true) args.push("--force-with-lease");
        const result = await runGit(args, { cwd: repo.root, timeoutMs: COMMAND_TIMEOUT_MS });
        return syncOutcome("git/push", result);
      });
    }

    case "git/pull": {
      const remote = refArg(payload.remote);
      const branch = refArg(payload.branch);
      if (remote === null || branch === null) return { ok: false, message: "Invalid remote or branch name." };
      const target = [remote, branch].filter(Boolean);
      return withRepo(async (repo) => {
        // Run it as the user configured it. `git pull` itself knows
        // `branch.<name>.rebase`, `pull.rebase` (including `merges` and
        // `interactive`), `pull.ff` and `pull.rebase=false`; re-deriving any of
        // that here would be a second, worse copy of Git's own precedence rules.
        const first = await runGit(["pull", ...target], { cwd: repo.root, timeoutMs: COMMAND_TIMEOUT_MS });
        if (first.ok || !needsReconcile(first.stdout, first.stderr)) return syncOutcome("git/pull", first);
        // Since 2.27, `git pull` with no strategy configured is a hard fatal on a
        // diverged branch — so the one command a refused push tells you to run
        // could not run at all. Answer that one question, once, by merging: it is
        // what `git pull` did before 2.27 and what IDEA's "Update Project" does
        // by default, and it is the recoverable answer, because a merge that stops
        // on conflicts lands in the Changes list where this plugin can finish or
        // abort it. Every other failure is reported as it came.
        const retry = await runGit(["pull", "--no-rebase", ...target], { cwd: repo.root, timeoutMs: COMMAND_TIMEOUT_MS });
        return syncOutcome("git/pull", retry);
      });
    }

    /**
     * Leave an unfinished merge/rebase/cherry-pick, or move it along.
     *
     * This exists because the plugin's own Pull can stop on conflicts: without
     * it, the plugin could put a repository into a state it had no way to leave
     * — resolving every conflict by hand, and even then needing a terminal to
     * continue a rebase.
     */
    case "git/sequencer": {
      const operation = String(payload.operation ?? "");
      const action = String(payload.action ?? "");
      if (!SEQUENCER.has(operation)) return { ok: false, message: `Unknown operation: ${operation || "(none)"}` };
      if (action !== "abort" && action !== "continue") {
        return { ok: false, message: `Unknown action: ${action || "(none)"}` };
      }
      // A merge is finished by committing it, which the commit button already
      // does; only the sequencer commands have a `--continue` of their own.
      if (action === "continue" && operation === "merge") {
        return { ok: false, message: "A merge is finished by committing it." };
      }
      return withRepo(async (repo) => {
        // `--continue` will open an editor for the commit message. There is no
        // terminal here and stdin is closed, so Git could only fail; setting the
        // editor to `true` accepts the message the operation already recorded,
        // which is what pressing Continue means.
        const prefix = action === "continue" ? ["-c", "core.editor=true"] : [];
        const result = await runGit([...prefix, operation, `--${action}`], { cwd: repo.root });
        return {
          ok: result.ok,
          stdout: result.stdout,
          message: result.ok ? undefined : result.message,
          detail: gitDetail(result.stdout, result.stderr),
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
      const listing = await listModels();
      if (!listing.ok) return listing;
      return { ok: true, models: listing.models, preferred: (await readPrefs()).ui?.commitModelKey ?? "" };
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

/**
 * The workspace listener is rebuilt on every load and released on unload.
 *
 * This host's `pi.events.on` returns nothing (its only `return` is the early
 * guard for a non-function handler), so the unsubscribe handle cannot be relied
 * on — `pi.events.off(event, handler)` is the pairing that actually exists, and
 * it needs the handler reference kept here. A host that does hand back a
 * function is honoured too, since that removes the need for `off`.
 */
let workspaceListenerOff = null;
let workspaceListenerHandler = null;

function detachWorkspaceListener() {
  const off = workspaceListenerOff;
  const handler = workspaceListenerHandler;
  workspaceListenerOff = null;
  workspaceListenerHandler = null;
  try {
    if (typeof off === "function") off();
    else if (handler) pi.events?.off?.("workspace:changed", handler);
  } catch {
    // The host already tore the listener down.
  }
}

/**
 * Idempotent: a second `onLoad` without an intervening `onUnload` must not stack
 * a duplicate handler — one is detached before the next is installed.
 */
function bindWorkspaceListener() {
  detachWorkspaceListener();
  try {
    const handler = () => {
      refreshWorkspace().catch(() => {});
    };
    const off = pi.events?.on?.("workspace:changed", handler);
    workspaceListenerHandler = handler;
    workspaceListenerOff = typeof off === "function" ? off : null;
  } catch {
    // Older host without plugin-process events: readRepo still refreshes.
  }
}

async function onLoad() {
  // The host re-broadcasts workspace switches to plugin processes; tracking them
  // keeps `workspacePath()` honest for any path that does not go through
  // `readRepo()` (which refreshes on its own).
  bindWorkspaceListener();


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
  detachWorkspaceListener();
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
