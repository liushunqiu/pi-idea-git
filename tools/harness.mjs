#!/usr/bin/env node
/**
 * Regression harness for the paths that meet a remote: fetch, pull, push, and
 * the conflicted states a pull can leave behind.
 *
 * Drives the real engine (`main.js`) against real repositories — bare remotes on
 * disk, real divergent histories, real conflicts — with a stubbed `pi` global so
 * no host is needed. Every assertion here covers something that was broken or
 * missing before: a push refused by the remote with no remedy shown, a pull that
 * could not run at all on a diverged branch, a conflicted merge with no way out,
 * and the argument/selection rules that keep a push from going somewhere it was
 * never pointed at.
 *
 * Run: node tools/harness.mjs [--keep]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = process.env.PLUGIN_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = mkdtempSync(join(tmpdir(), "pig-harness-"));
const require = createRequire(import.meta.url);

// ------------------------------------------------------------------ runner ---
let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${label}\n`);
    return;
  }
  failures.push(label);
  process.stdout.write(`  FAIL ${label}${detail === undefined ? "" : `\n       ${detail}`}\n`);
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function includes(label, haystack, needle) {
  ok(label, String(haystack ?? "").includes(needle), `${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack ?? "").slice(0, 200))}`);
}

function excludes(label, haystack, needle) {
  ok(label, !String(haystack ?? "").includes(needle), `${JSON.stringify(needle)} unexpectedly in ${JSON.stringify(String(haystack ?? "").slice(0, 200))}`);
}

// --------------------------------------------------------------------- git ---
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function head(dir) {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function subject(dir, reference = "HEAD") {
  return git(dir, ["log", "-1", "--format=%s", reference]).trim();
}

function initRepo(dir, name) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", `${name}@example.com`]);
  git(dir, ["config", "user.name", name]);
  return dir;
}

function bareRepo(base, name) {
  git(base, ["init", "-q", "-b", "main", "--bare", `${name}.git`]);
  return join(base, `${name}.git`);
}

function write(dir, file, text) {
  writeFileSync(join(dir, file), text);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

// ------------------------------------------------------------------- world ---
/**
 * A bare remote with two clones of it, so "someone else pushed" is a real event
 * rather than a renamed ref.
 */
function makeWorld(label) {
  const base = join(ROOT, label);
  mkdirSync(base, { recursive: true });
  const origin = bareRepo(base, "origin");

  const work = initRepo(join(base, "work"), "worker");
  write(work, "f.txt", "base\n");
  write(work, "g.txt", "base\n");
  commitAll(work, "base");
  git(work, ["remote", "add", "origin", "../origin.git"]);
  git(work, ["push", "-q", "-u", "origin", "main"]);

  const other = join(base, "other");
  git(base, ["clone", "-q", "origin.git", "other"]);
  git(other, ["config", "user.email", "other@example.com"]);
  git(other, ["config", "user.name", "other"]);

  return { base, origin, work, other };
}

/** The same file changed on both sides: the later merge has to conflict. */
function diverge(world, options = {}) {
  const { work, other } = world;
  write(work, options.mineFile ?? "f.txt", "mine\n");
  commitAll(work, "mine");
  write(other, options.theirsFile ?? "f.txt", "theirs\n");
  commitAll(other, "theirs");
  git(other, ["push", "-q", "origin", "main"]);
}

// ------------------------------------------------------------------ engine ---
/**
 * The stub is installed once and the workspace it reports is switched, because
 * that is what the real plugin does: one long-lived process told about project
 * switches. Reloading `main.js` on every call would also throw away the module
 * state a refresh is supposed to remember between calls.
 */
let plugin = null;
let currentRepo = null;

function useWorkspace(repoPath) {
  currentRepo = repoPath;
  if (plugin) return plugin;
  globalThis.pi = {
    workspace: { get: async () => ({ path: currentRepo, name: basename(currentRepo) }) },
    commands: { register: async () => {}, unregister: async () => {} },
    ui: { openPanel: async () => {}, showToast: () => {} },
    plugin: { getDataPath: async () => ROOT },
    events: { on: () => {}, off: () => {} },
    models: { list: async () => [] },
    agent: { complete: async () => ({ text: "" }) },
  };
  plugin = require(join(PLUGIN, "main.js"));
  return plugin;
}

async function call(repoPath, channel, payload) {
  return useWorkspace(repoPath).onPanelInvoke(channel, payload ?? {});
}

// ------------------------------------------------------------------- cases ---
async function main() {
  process.stdout.write(`plugin: ${PLUGIN}\nscratch: ${ROOT}\n`);

  // 1. A push the remote refuses.
  section("push refused by the remote");
  {
    const world = makeWorld("refused");
    diverge(world);
    const pushed = await call(world.work, "git/push");
    eq("push does not report success", pushed.ok, false);
    eq("classified as remote-ahead", pushed.pushHint, "remote-ahead");
    includes("message carries Git's rejection", pushed.message, "! [rejected]");
    includes("message names the command that failed", pushed.message, "failed to push some refs");
    excludes("Git's own hint lines stay out of the short message", pushed.message, "hint:");
    includes("the full output is kept for the details dialog", pushed.detail, "hint: Updates were rejected");

    // The chip counts against a stale remote-tracking ref…
    const stale = await call(world.work, "git/repo");
    eq("before the fetch the chip still claims nothing is incoming", stale.branch.behind, 0);
    eq("and one commit outgoing", stale.branch.ahead, 1);
    // …which the refresh after a refusal is supposed to fix.
    eq("fetch succeeds", (await call(world.work, "git/fetch")).ok, true);
    const honest = await call(world.work, "git/repo");
    eq("after the fetch the chip admits the incoming commit", honest.branch.behind, 1);
  }

  // 2. `git pull` on a diverged branch used to be a hard fatal.
  section("pull on a diverged branch");
  {
    const world = makeWorld("diverged");
    diverge(world, { mineFile: "f.txt", theirsFile: "g.txt" });
    const pulled = await call(world.work, "git/pull");
    eq("pull runs instead of failing on the missing strategy", pulled.ok, true);
    const after = await call(world.work, "git/repo");
    eq("the remote commit is in the history now", after.branch.behind, 0);
    eq("with nothing to resolve", after.conflicted.length, 0);
    eq("in a merge commit", subject(world.work).startsWith("Merge"), true);
  }

  // 3. A pull that stops on conflicts, and the way out of it.
  section("pull that conflicts");
  {
    const world = makeWorld("conflict");
    diverge(world);
    const pulled = await call(world.work, "git/pull");
    eq("the conflicted merge is reported as a failure", pulled.ok, false);
    eq("classified as conflicts", pulled.pullHint, "conflicts");
    includes("the message says CONFLICT, not just the fetch log", pulled.message, "CONFLICT (content)");
    includes("the details dialog has the rest", pulled.detail, "fix conflicts and then commit");

    const state = await call(world.work, "git/repo");
    eq("the conflict reaches the changes list", state.conflicted.length, 1);
    eq("with Git's status for it", state.conflicted[0].status, "UU");
    eq("and the unfinished operation is named", state.operation, "merge");

    const invalid = await call(world.work, "git/sequencer", { operation: "merge", action: "continue" });
    eq("a merge is not continued, it is committed", invalid.ok, false);
    includes("and Git's substitute is explained", invalid.message, "finished by committing");

    const rejected = await call(world.work, "git/sequencer", { operation: "--upload-pack=evil", action: "abort" });
    eq("an unknown operation is refused", rejected.ok, false);

    const aborted = await call(world.work, "git/sequencer", { operation: "merge", action: "abort" });
    eq("abort succeeds", aborted.ok, true);
    const clean = await call(world.work, "git/repo");
    eq("nothing is conflicted afterwards", clean.conflicted.length, 0);
    eq("and no operation is in progress", clean.operation, null);
    eq("the local commit survived the abort", subject(world.work), "mine");
  }

  // 4. Staging the resolution must not hide the way out.
  section("operation stays visible once the conflicts are staged");
  {
    const world = makeWorld("staged-conflict");
    diverge(world);
    await call(world.work, "git/pull");
    const before = await call(world.work, "git/repo");
    eq("the merge is in progress", before.operation, "merge");

    // Resolving a conflict turns its `u` line into an ordinary index line, so
    // porcelain stops mentioning it — while MERGE_HEAD is still there.
    write(world.work, "f.txt", "resolved\n");
    const staged = await call(world.work, "git/stage", { paths: ["f.txt"] });
    eq("the resolution stages", staged.ok, true);
    const after = await call(world.work, "git/repo");
    eq("nothing is reported as conflicted any more", after.conflicted.length, 0);
    eq("but the operation is still named, so Abort stays reachable", after.operation, "merge");

    const aborted = await call(world.work, "git/sequencer", { operation: "merge", action: "abort" });
    eq("and aborting still works", aborted.ok, true);
  }

  // 5. A rebase the user's own configuration asked for stays a rebase.
  section("pull respects the user's own rebase configuration");
  {
    const world = makeWorld("configured-rebase");
    diverge(world, { mineFile: "f.txt", theirsFile: "g.txt" });
    // `branch.<name>.rebase` outranks `pull.rebase`: it is what `git pull` itself
    // consults first, and re-deriving the strategy here used to overwrite it.
    git(world.work, ["config", "branch.main.rebase", "true"]);
    const pulled = await call(world.work, "git/pull");
    eq("the pull succeeds", pulled.ok, true);
    eq("the history stays linear", git(world.work, ["rev-list", "--merges", "--count", "HEAD"]).trim(), "0");
    eq("with the remote commit underneath", subject(world.work, "HEAD^"), "theirs");
  }

  // 6. Where a push goes.
  section("push target");
  {
    const world = makeWorld("target");
    const fork = bareRepo(world.base, "fork");
    git(world.work, ["remote", "add", "fork", "../fork.git"]);
    git(world.work, ["push", "-q", "-u", "fork", "main"]);
    eq(
      "upstream is the other remote",
      git(world.work, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).trim(),
      "fork/main",
    );

    const originBefore = git(world.base, ["--git-dir", "origin.git", "rev-parse", "main"]).trim();
    write(world.work, "g.txt", "to the fork\n");
    commitAll(world.work, "to the fork");
    const pushed = await call(world.work, "git/push", {});
    eq("a push with no explicit target succeeds", pushed.ok, true);
    eq("it went to the tracked remote", git(fork, ["rev-parse", "main"]).trim(), head(world.work));
    eq("and left origin alone", git(world.base, ["--git-dir", "origin.git", "rev-parse", "main"]).trim(), originBefore);
  }

  // 7. A push with no upstream is not sent to a remote chosen by alphabet.
  section("no upstream: narrow fallback, never a guess");
  {
    const base = join(ROOT, "no-upstream");
    mkdirSync(base, { recursive: true });
    const solo = bareRepo(base, "solo");
    const work = initRepo(join(base, "solo-work"), "solo");
    write(work, "f.txt", "base\n");
    commitAll(work, "base");
    git(work, ["remote", "add", "origin", solo]);
    const first = await call(work, "git/push", { setUpstream: true });
    eq("a single remote is used, and tracking is set", first.ok, true);
    eq(
      "tracking points at that remote",
      git(work, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).trim(),
      "origin/main",
    );

    const many = initRepo(join(base, "many-work"), "many");
    write(many, "f.txt", "base\n");
    commitAll(many, "base");
    bareRepo(base, "alpha");
    bareRepo(base, "beta");
    git(many, ["remote", "add", "alpha", "../alpha.git"]);
    git(many, ["remote", "add", "beta", "../beta.git"]);
    const guessed = await call(many, "git/push", { setUpstream: true });
    eq("several remotes and no upstream is refused", guessed.ok, false);
    includes("naming the remotes it will not choose between", guessed.message, "several remotes");
    includes("alpha is listed", guessed.message, "alpha");
    eq("and nothing was pushed", git(base, ["--git-dir", "alpha.git", "for-each-ref"]).trim(), "");

    const local = initRepo(join(base, "local-upstream"), "local");
    write(local, "f.txt", "base\n");
    commitAll(local, "base");
    const upstreamRepo = bareRepo(base, "upstream");
    git(local, ["remote", "add", "origin", upstreamRepo]);
    git(local, ["push", "-q", "-u", "origin", "main"]);
    git(local, ["branch", "other"]);
    git(local, ["config", "branch.main.remote", "."]);
    git(local, ["config", "branch.main.merge", "refs/heads/other"]);
    const localUpstream = await call(local, "git/push", {});
    eq("tracking a local branch is refused rather than redirected", localUpstream.ok, false);
    includes("and says which branch it tracks", localUpstream.message, "tracks the local branch");

    const unborn = initRepo(join(base, "unborn"), "unborn");
    git(unborn, ["remote", "add", "origin", upstreamRepo]);
    const nothing = await call(unborn, "git/push", { setUpstream: true });
    eq("an unborn branch is refused", nothing.ok, false);
    includes("for the reason that is actually true", nothing.message, "no commits yet");
  }

  // 8. Force push is a lease, never a bare force — including through a payload.
  section("force push with lease");
  {
    const world = makeWorld("lease");
    write(world.work, "f.txt", "rewritten\n");
    commitAll(world.work, "rewritten");
    const forced = await call(world.work, "git/push", { forceWithLease: true });
    eq("a lease against a fresh baseline succeeds", forced.ok, true);
    eq("the remote was rewritten", git(world.base, ["--git-dir", "origin.git", "rev-parse", "main"]).trim(), head(world.work));

    // Someone else pushes while this window is not looking.
    git(world.other, ["fetch", "-q", "origin"]);
    git(world.other, ["reset", "-q", "--hard", "origin/main"]);
    write(world.other, "h.txt", "colleague\n");
    commitAll(world.other, "colleague");
    git(world.other, ["push", "-q", "origin", "main"]);
    const colleague = git(world.base, ["--git-dir", "origin.git", "rev-parse", "main"]).trim();

    write(world.work, "f.txt", "local rewrite\n");
    commitAll(world.work, "local rewrite");
    const stale = await call(world.work, "git/push", { forceWithLease: true });
    eq("a stale lease is refused", stale.ok, false);
    eq("and classified like any other refused push", stale.pushHint, "remote-ahead");
    eq("so the colleague's commit is still there", git(world.base, ["--git-dir", "origin.git", "rev-parse", "main"]).trim(), colleague);

    // The remote and the ref are positional arguments, so a caller that sends an
    // option there would be choosing the command.
    const injected = await call(world.work, "git/push", { remote: "origin", branch: "--force" });
    eq("an option dressed as a branch is refused", injected.ok, false);
    includes("with a message that says so", injected.message, "Invalid remote or branch name");
    eq("and the remote is untouched", git(world.base, ["--git-dir", "origin.git", "rev-parse", "main"]).trim(), colleague);

    const injectedFetch = await call(world.work, "git/fetch", { remote: "--upload-pack=evil" });
    eq("an option dressed as a remote is refused too", injectedFetch.ok, false);
  }

  // 9. The shared error path still behaves.
  section("regressions in the shared error path");
  {
    const world = makeWorld("shared");
    write(world.work, ".gitignore", "*.log\n");
    commitAll(world.work, "ignore logs");
    write(world.work, "debug.log", "noise\n");
    const staged = await call(world.work, "git/stage", { paths: ["debug.log"] });
    eq("an ignored path is still refused", staged.ok, false);
    includes("with the header line", staged.message, "ignored by one of your .gitignore files");
    includes("and the file that was refused", staged.message, "debug.log");

    const bad = await call(world.work, "git/fetch", { remote: "does-not-exist" });
    eq("a fetch from a missing remote fails", bad.ok, false);
    ok("and says something", String(bad.message ?? "").length > 0, JSON.stringify(bad.message));

    const clean = await call(world.work, "git/push", {});
    eq("an up-to-date push succeeds", clean.ok, true);
    eq("with nothing on stdout — Git reports success on stderr", String(clean.stdout ?? ""), "");

    const missing = await call(world.work, "git/sequencer", { operation: "merge", action: "abort" });
    eq("aborting a merge that is not in progress fails", missing.ok, false);
    includes("with Git's reason", missing.message, "MERGE_HEAD");
  }

  // 10. A cherry-pick that conflicts can be resolved and continued from here.
  section("cherry-pick conflict");
  {
    const world = makeWorld("cherry");
    git(world.other, ["fetch", "-q", "origin"]);
    git(world.other, ["reset", "-q", "--hard", "origin/main"]);
    write(world.other, "f.txt", "from the other clone\n");
    commitAll(world.other, "theirs");
    git(world.other, ["push", "-q", "origin", "main"]);
    const hash = head(world.other);

    write(world.work, "f.txt", "mine\n");
    commitAll(world.work, "mine");
    // Fetch only: the object has to be here for the pick to be attempted at all,
    // but the branch must stay where it is for the pick to conflict.
    git(world.work, ["fetch", "-q", "origin"]);

    const picked = await call(world.work, "git/cherry-pick", { hash });
    eq("the conflicting cherry-pick fails", picked.ok, false);
    const state = await call(world.work, "git/repo");
    eq("the operation is named", state.operation, "cherry-pick");
    eq("with the conflict to resolve", state.conflicted.length, 1);

    write(world.work, "f.txt", "resolved\n");
    git(world.work, ["add", "f.txt"]);
    const afterStaging = await call(world.work, "git/repo");
    eq("staging keeps the operation named", afterStaging.operation, "cherry-pick");

    const continued = await call(world.work, "git/sequencer", { operation: "cherry-pick", action: "continue" });
    eq("continue succeeds without a terminal to compose the message", continued.ok, true);
    const after = await call(world.work, "git/repo");
    eq("nothing is in progress any more", after.operation, null);
    eq("the pick landed", subject(world.work), "theirs");
  }

  // 11. A repository inside a repository: a submodule, and a clone that is not
  // one. Both are separate repositories, so every command has to be able to
  // point at either — which is what picking one in the repository list does.
  section("nested repositories");
  {
    const base = join(ROOT, "nested");
    mkdirSync(base, { recursive: true });

    // What the submodule points at, with a history of its own.
    const inner = initRepo(join(base, "inner"), "inner");
    write(inner, "pointed.txt", "inner\n");
    commitAll(inner, "inner base");

    const outer = initRepo(join(base, "outer"), "outer");
    write(outer, "base.txt", "base\n");
    commitAll(outer, "base");
    git(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "../inner", "mod"]);
    commitAll(outer, "add submodule");
    write(join(outer, "mod"), "pointed.txt", "changed inside\n");
    git(join(outer, "mod"), ["add", "pointed.txt"]);
    git(join(outer, "mod"), ["commit", "-qm", "inside the submodule"]);

    // A repository that merely lives inside the outer one: no `.gitmodules`
    // entry, no gitlink in the parent's index, nothing the parent stores.
    const vendored = initRepo(join(outer, "vendor-tools"), "vendor");
    write(vendored, "n.txt", "n\n");
    commitAll(vendored, "vendored base");

    const list = await call(outer, "git/repos");
    eq("the workspace's own repository is listed first", list.repos[0].rel, ".");
    eq("as the active one", list.repos[0].active, true);
    eq("the submodule is listed where it sits", list.repos[1].rel, "mod");
    eq("and named a submodule", list.repos[1].kind, "submodule");
    eq("a nested repository without a submodule entry is listed too", list.repos[2].rel, "vendor-tools");
    eq("told apart from a submodule", list.repos[2].kind, "nested");
    eq("with nothing else invented", list.repos.length, 3);
    eq("and nothing picked to begin with", list.active, ".");

    // Picking one redirects every command, not just the list. The path handed
    // over is the raw `mkdtemp` path while Git answers with the real one, so
    // this also covers the comparison that decides "inside the workspace".
    const picked = await call(outer, "git/select-repo", { root: join(outer, "mod") });
    eq("picking the submodule succeeds", picked.ok, true);
    eq("and reports it as the active one", picked.active, "mod");

    const inside = await call(outer, "git/repo");
    eq("the status is the submodule's", inside.repo.rel, "mod");
    eq("which is clean where the parent is not", inside.unstaged.length, 0);
    eq("where the repository sits inside the workspace is computed for the host's fs channels", inside.repo.workspacePrefix, "mod");
    const insideLog = await call(outer, "git/log", { limit: 5 });
    eq("and the log is the submodule's own history", insideLog.commits[0].subject, "inside the submodule");

    // A change made inside it is what the parent could never show as a file.
    write(join(outer, "mod"), "pointed.txt", "edited from the plugin\n");
    const dirty = await call(outer, "git/repo");
    eq("a change inside the submodule is listed here", dirty.unstaged[0].path, "pointed.txt");
    eq("as an ordinary file change, not as a submodule", dirty.unstaged[0].submodule, false);

    write(join(outer, "mod"), "from-here.txt", "written from the plugin\n");
    const stagedInside = await call(outer, "git/stage", { paths: ["from-here.txt", "pointed.txt"] });
    eq("files inside the submodule can be staged from the plugin", stagedInside.ok, true);
    const committedInside = await call(outer, "git/commit", { message: "committed from the plugin" });
    eq("and committed from it", committedInside.ok, true);
    eq("into the submodule's history", subject(join(outer, "mod")), "committed from the plugin");

    await call(outer, "git/select-repo", { root: outer });
    const parent = await call(outer, "git/repo");
    eq("the workspace's own repository is active again", parent.repo.rel, ".");
    eq("and reports the submodule's new commit", parent.unstaged[0].path, "mod");
    eq("as the commit it points at", parent.unstaged[0].sub.commits, true);
    eq("rather than a change it could make itself", parent.unstaged[0].insideSubmodule, false);
    eq("while the nested repository stays one unversioned entry", parent.untracked[0].path, "vendor-tools/");

    // The bridge forwards any path a view sends, so the engine keeps its own
    // boundary: only a repository root inside this workspace may be picked.
    eq("a file is not a repository root", (await call(outer, "git/select-repo", { root: join(outer, "base.txt") })).ok, false);
    eq("and a repository outside the workspace is refused", (await call(outer, "git/select-repo", { root: inner })).ok, false);
    eq("a refusal leaves the current choice alone", (await call(outer, "git/repo")).repo.rel, ".");

    // The plugin process outlives a project switch, so a choice made in one
    // project must not follow the user into the next.
    const elsewhere = initRepo(join(base, "elsewhere"), "elsewhere");
    write(elsewhere, "z.txt", "z\n");
    commitAll(elsewhere, "elsewhere base");
    await call(outer, "git/select-repo", { root: join(outer, "vendor-tools") });
    eq("a nested repository can be the active one", (await call(outer, "git/repo")).repo.rel, "vendor-tools");
    const switched = await call(elsewhere, "git/repo");
    eq("switching project drops the choice", switched.repo.rel, ".");
    eq("and reads the new project's repository", switched.repo.name, "elsewhere");
  }

  // 12. How far the scan looks, and what a declaration overrides.
  section("repository scan bounds");
  {
    const base = join(ROOT, "bounds");
    mkdirSync(base, { recursive: true });

    const inner = initRepo(join(base, "inner"), "inner");
    write(inner, "pointed.txt", "inner\n");
    commitAll(inner, "inner base");

    const outer = initRepo(join(base, "outer"), "outer");
    write(outer, "base.txt", "base\n");
    commitAll(outer, "base");
    // Four levels down: found. One level deeper: past the bound. A dependency
    // tree: not walked at all. Each needs a commit, or `git add -A` in the
    // parent refuses the embedded repository.
    for (const [relative, name] of [["a/b/c/d", "deep"], ["x/y/z/w/v", "past"], ["node_modules/pkg", "dependency"]]) {
      const repository = initRepo(join(outer, relative), name);
      write(repository, "here.txt", `${name}\n`);
      commitAll(repository, `${name} base`);
    }

    const rels = (await call(outer, "git/repos")).repos.map((entry) => entry.rel);
    eq("a repository at the depth limit is found", rels.includes("a/b/c/d"), true);
    eq("one past it is not", rels.includes("x/y/z/w/v"), false);
    eq("and a dependency tree is not walked", rels.includes("node_modules/pkg"), false);

    // `.gitmodules` is a statement about the project, while the scan's bounds
    // are a guess about its size — so a declared submodule is listed either way.
    // `submodule add` stages its own gitlink, so nothing else needs committing.
    git(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "../inner", "x/y/z/w/mod"]);
    const declared = (await call(outer, "git/repos")).repos.find((entry) => entry.rel === "x/y/z/w/mod");
    eq("a declared submodule past the bound is still listed", Boolean(declared), true);
    eq("named as what it is", declared?.kind, "submodule");
    await call(outer, "git/select-repo", { root: outer });
  }

  // 13. A submodule of a submodule, a repository that disappears, and a
  // workspace that is a subdirectory of its own repository.
  section("nested repositories, harder cases");
  {
    const base = join(ROOT, "deeper");
    mkdirSync(base, { recursive: true });

    const inner = initRepo(join(base, "inner"), "inner");
    write(inner, "pointed.txt", "inner\n");
    commitAll(inner, "inner base");

    const outer = initRepo(join(base, "outer"), "outer");
    write(outer, "base.txt", "base\n");
    commitAll(outer, "base");
    git(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "../inner", "mod"]);
    commitAll(outer, "add submodule");
    // A submodule *of* the submodule: the classification question has to be put
    // to `mod`'s index, in `mod`'s terms.
    // The source is named absolutely: a relative one is resolved from the
    // superproject, which here is `mod` itself.
    git(join(outer, "mod"), ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "dep"]);
    commitAll(join(outer, "mod"), "add its own submodule");

    const list = await call(outer, "git/repos");
    const dep = list.repos.find((entry) => entry.rel === "mod/dep");
    eq("a submodule of a submodule is listed", Boolean(dep), true);
    eq("and classified by the repository that holds it", dep?.kind, "submodule");

    // A repository that is taken away between two refreshes: the choice has to
    // become the workspace's own repository again rather than fail.
    const scratch = initRepo(join(outer, "scratch-repo"), "scratch");
    write(scratch, "s.txt", "s\n");
    commitAll(scratch, "scratch base");
    await call(outer, "git/select-repo", { root: scratch });
    eq("a nested repository can be selected", (await call(outer, "git/repo")).repo.rel, "scratch-repo");
    rmSync(join(scratch, ".git"), { recursive: true, force: true });
    const afterRemoval = await call(outer, "git/repo");
    eq("a repository that stops being one falls back to the workspace's", afterRemoval.repo.rel, ".");
    eq("without failing the read", afterRemoval.ok, true);
    rmSync(scratch, { recursive: true, force: true });

    // A workspace *inside* the repository: the repository is then not inside the
    // workspace, and saying it is would send "Open File" to `app/app/f.txt`.
    const nestedWorkspace = join(outer, "app");
    mkdirSync(nestedWorkspace, { recursive: true });
    write(outer, "app/f.txt", "f\n");
    commitAll(outer, "a file under the workspace");
    const insideWorkspace = await call(nestedWorkspace, "git/repo");
    eq("the repository is still found from a subdirectory", insideWorkspace.ok, true);
    eq("as the repository the workspace sits in", insideWorkspace.repo.rel, ".");
    eq("with no workspace-relative prefix, because the file paths are already relative to it", insideWorkspace.repo.workspacePrefix, null);

    const refusedFile = await call(outer, "git/select-repo", { root: join(outer, "base.txt") });
    eq("a file is refused with its reason", refusedFile.ok, false);
    includes("and says what is wrong with it", refusedFile.message, "Not a repository inside this workspace");
    const refusedOutside = await call(outer, "git/select-repo", { root: inner });
    eq("so is a repository that is not the workspace's own", refusedOutside.ok, false);
    includes("with the same reason", refusedOutside.message, "Not a repository inside this workspace");
  }

  // 14. Diffs and patches: an empty diff is not proof of nothing to show, and a
  // patch belongs to the repository it came from.
  section("diffs and patches");
  {
    const base = join(ROOT, "diffs");
    mkdirSync(base, { recursive: true });
    const repo = initRepo(join(base, "work"), "worker");
    write(repo, "tracked.txt", "one\n");
    commitAll(repo, "base");

    // A clean, tracked file: the diff is empty, but the file is not new.
    const clean = await call(repo, "git/diff", { path: "tracked.txt", mode: "worktree" });
    eq("a clean tracked file produces no diff", clean.text.trim(), "");
    excludes("and is not rendered as an addition", clean.text, "new file mode");

    // An untracked file has no index entry to diff against, so it is rendered
    // as a whole-file addition — that is what the fallback is for.
    write(repo, "untracked.txt", "two\n");
    const untracked = await call(repo, "git/diff", { path: "untracked.txt", mode: "worktree" });
    includes("an untracked file is rendered as an addition", untracked.text, "new file mode");
    includes("with its content", untracked.text, "+two");

    write(repo, "tracked.txt", "one\nchanged\n");
    const dirty = await call(repo, "git/diff", { path: "tracked.txt", mode: "worktree" });
    includes("a modified tracked file shows the change", dirty.text, "+changed");
    excludes("and never as an addition", dirty.text, "new file mode");
    eq("while carrying the repository it was read from", dirty.root, realpathSync(repo));

    // A patch is refused once the repository has moved on, rather than applied
    // to whatever repository is current: `discard` writes to the worktree. The
    // patch itself is the forward diff, as `git/diff` hands it over — `discard`
    // applies it in reverse.
    const patch = "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1,2 @@\n one\n+changed\n";
    const stale = await call(join(base, "work"), "git/apply-patch", {
      action: "discard",
      patch,
      root: join(base, "elsewhere"),
    });
    eq("a patch from another repository is refused", stale.ok, false);
    eq("with a code the view can act on", stale.code, "STALE_REPOSITORY");
    includes("and the file is untouched", execFileSync("git", ["diff", "--", "tracked.txt"], { cwd: repo, encoding: "utf8" }), "+changed");
    const applied = await call(repo, "git/apply-patch", { action: "discard", patch, root: repo });
    eq("the same patch applies to the repository it came from", applied.ok, true);
    eq("removing the change", execFileSync("git", ["diff", "--", "tracked.txt"], { cwd: repo, encoding: "utf8" }).trim(), "");
  }

  // ------------------------------------------------------------------ result ---
  const total = passed + failures.length;
  process.stdout.write(`\n${passed}/${total} passed\n`);
  if (failures.length) {
    process.stdout.write(`failed:\n${failures.map((name) => `  - ${name}`).join("\n")}\n`);
  }
  if (!process.argv.includes("--keep")) rmSync(ROOT, { recursive: true, force: true });
  else process.stdout.write(`kept: ${ROOT}\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`harness crashed: ${error?.stack ?? error}\n`);
  process.exit(2);
});
