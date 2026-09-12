#!/usr/bin/env node
/**
 * Build a smoke page for a built view: the real `views/*.html` with a stubbed
 * `window.pluginBridge`, so the rendering of a state that is hard to produce on
 * demand (a conflicted merge, a refused push) can be looked at without a host.
 *
 * Writes `.smoke/<view>.html`. Not part of the plugin: nothing under `.smoke/`
 * is packaged (see .gitignore).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const view = process.argv[2] ?? "commit";
const locale = process.argv[3] ?? "zh-CN";
const source = readFileSync(join(ROOT, "views", `${view}.html`), "utf8");

const STUB = `
<script>
(function () {
  // ---- a repository mid-merge, so the conflict banner and the abort/continue
  // buttons are on screen, plus a push the remote refuses.
  var repo = {
    ok: true,
    repo: { root: "/tmp/demo", name: "demo", workspace: "/tmp/demo" },
    branch: {
      oid: "1111111111111111111111111111111111111111",
      head: "feature/login",
      upstream: "origin/feature/login",
      ahead: 2,
      behind: 1,
      detached: false,
      unborn: false,
    },
    operation: "merge",
    staged: [{ path: "src/app.js", originalPath: null, status: "M", label: "Modified" }],
    unstaged: [{ path: "src/login.js", originalPath: null, status: "M", label: "Modified" }],
    untracked: [{ path: "notes.md", originalPath: null, status: "?", label: "Unversioned" }],
    conflicted: [{ path: "src/session.js", originalPath: null, status: "UU", label: "Both modified" }],
    stashes: [],
    available: true,
    user: "worker",
    version: "git version 2.50.1",
  };

  var PATCH = [
    "diff --git a/src/session.js b/src/session.js",
    "index 1111111..2222222 100644",
    "--- a/src/session.js",
    "+++ b/src/session.js",
    "@@ -1,6 +1,10 @@",
    " export function session(token) {",
    "+<<<<<<< HEAD",
    "+  return { token, scope: 'local' };",
    "+=======",
    "+  return { token, scope: 'remote' };",
    "+>>>>>>> origin/feature/login",
    " }",
  ].join("\\n") + "\\n";

  var REFUSED = {
    ok: false,
    stdout: "",
    stderr: "To https://example.com/demo.git\\n ! [rejected]        feature/login -> feature/login (fetch first)\\n"
      + "error: failed to push some refs to 'https://example.com/demo.git'\\n"
      + "hint: Updates were rejected because the remote contains work that you do not\\n"
      + "hint: have locally. If you want to integrate the remote changes, use\\n"
      + "hint: 'git pull' before pushing again.\\n",
    message: "To https://example.com/demo.git\\n ! [rejected]        feature/login -> feature/login (fetch first)\\n"
      + "error: failed to push some refs to 'https://example.com/demo.git'",
    detail: "To https://example.com/demo.git\\n ! [rejected]        feature/login -> feature/login (fetch first)\\n"
      + "error: failed to push some refs to 'https://example.com/demo.git'\\n"
      + "hint: Updates were rejected because the remote contains work that you do not\\n"
      + "hint: have locally. If you want to integrate the remote changes, use\\n"
      + "hint: 'git pull' before pushing again.\\n"
      + "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    authHint: null,
    pushHint: "remote-ahead",
    pullHint: null,
  };

  var handlers = {};
  window.pluginBridge = {
    invoke: function (channel, payload) {
      var replies = {
        "workspace.get": { ok: true, path: "/tmp/demo", name: "demo" },
        "app.getAppearance": { ok: true, locale: ${JSON.stringify(locale)}, theme: "dark" },
        "git/repo": repo,
        "git/prefs": { ok: true, prefs: { ui: { messages: [], commitModelKey: "" } } },
        "git/console": { ok: true, entries: [] },
        "git/stashes": { ok: true, stashes: [] },
        "git/diff": { ok: true, patch: PATCH, binary: false },
        "git/last-message": { ok: true, message: "" },
        "git/branches": {
          ok: true,
          branches: [
            { name: "feature/login", current: true, remote: false, subject: "Wire up the session" },
            { name: "main", current: false, remote: false, subject: "Release 0.2.0" },
            { name: "origin/feature/login", current: false, remote: true, subject: "Wire up the session" },
          ],
        },
        "git/push": REFUSED,
        "git/fetch": { ok: true, stdout: "" },
        "git/pull": { ok: true, stdout: "" },
        "git/sequencer": { ok: true, stdout: "" },
        "git/models": { ok: true, models: [], preferred: "" },
      };
      return Promise.resolve(replies[channel] ?? { ok: true });
    },
    on: function (event, handler) { (handlers[event] = handlers[event] || []).push(handler); },
    off: function () {},
    emit: function (event) {},
  };
})();
</script>
`;

// The stub has to exist before the view's own script runs: boot is registered
// on DOMContentLoaded, but `window.pluginBridge` is read at IIFE time, and that
// IIFE is the next thing after `<body>` in the built page.
const marker = "<body>";
const output = source.replace(marker, `${marker}${STUB}`);
if (output === source) {
  process.stderr.write(`could not find ${marker} in views/${view}.html\n`);
  process.exit(1);
}
const dir = join(ROOT, ".smoke");
mkdirSync(dir, { recursive: true });
const target = join(dir, `${view}-${locale}.html`);
writeFileSync(target, output, "utf8");
process.stdout.write(`wrote ${relative(ROOT, target)}\n`);
