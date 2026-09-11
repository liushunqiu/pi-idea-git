# IDEA Git — an IntelliJ-IDEA-style Git tool window for PI-Desktop

`local.pi-idea-git` recreates IntelliJ IDEA's Git UI inside PI-Desktop: the two
tool windows you actually live in, the staged/unstaged change lists, hunk-level
staging, the graph log and the Console.

Everything Git does here is a real `git` invocation against a real index. No
feature is faked in the renderer, so `git status` in a terminal always agrees
with what the panel shows.

## What you get

Two docked views in the work panel, mirroring IDEA's two tool windows:

| Surface | IDEA equivalent | Contents |
| --- | --- | --- |
| **Commit** (`views/commit.html`) | Commit tool window, `Alt+0` | Changes area (Staged / Unstaged / Unversioned Files / Merge Conflicts), the selected file's diff, Commit Message with history, Amend, Sign-off, Commit, Commit and Push |
| **Git** (`views/git.html`) | Git tool window, `Alt+9` | **Log** tab (branches pane, commit list with graph and ref badges, changed files, commit details) and **Console** tab |

`IDEA Git: Open as a separate window` from the command palette opens
`renderer/index.html`, which hosts both behind one tab bar for a wide-screen
workflow.

### Feature map, using IDEA's own wording

| Feature | Where | Notes |
| --- | --- | --- |
| `Staged` / `Unstaged` / `Unversioned Files` / `Merge Conflicts` | Commit → Changes area | Checkbox per file. Checking an unstaged file stages it; unchecking a staged file unstages it — IDEA's "include in this commit" mapped onto a real index |
| `Commit Message` + `Commit message history` | Commit → bottom | The clock button replays earlier messages, newest first, persisted across restarts |
| `Generate Commit Message` | Commit → bottom | Drafts the message with the host's own model. Describes the selected file, or everything staged when nothing is selected; the chevron picks which model |
| `Amend`, `Sign-off commit` | Commit → bottom | `--amend`, `--signoff` |
| `Commit`, `Commit and Push` | Commit → bottom | Split button; the dropdown also carries Amend / Sign-off / Move all out of the index |
| `Include into commit` per hunk | Commit → diff pane | **Partial commit.** Each hunk carries a checkbox; toggling it runs `git apply --cached` (or `-R`) with a rebuilt patch, so only the chosen hunks enter the commit |
| `Stage Hunk` / `Discard Hunk` | Commit → diff pane | Hover a hunk header on a worktree diff |
| `Show Diff`, `Rollback`, `Add`/`Remove from index`, `Open File`, `Reveal in File Manager`, `Copy path` | Commit → file context menu | `Rollback` confirms first; it deletes untracked files and restores tracked ones |
| Branch widget (`main ↑2 ↓1`) | both toolbars | Branch, ahead/behind, and a popup with local/remote branches, `New Branch`, `Checkout`, `Fetch`, `Pull`, `Push`, `Stash Changes`, and the stash list |
| `Log`, `Console` | Git → tabs | Console shows every command the plugin ran, with output, failures in red, and `Clear All` |
| Commit graph | Git → Log | Lanes computed from parent information; the branch tip is yellow, local branches green, remote violet, tags grey |
| `Branches` pane | Git → Log → left | `Local branches` / `Remote branches`, checkout on click, actions on right-click |
| `Changed Files`, `Commit Details` | Git → Log → below the list | Details show hash, author, date, subject and the full message body |
| `Graph Options` | Git → toolbar | `By commit date` / `Topologically`, `Show First Parent`, `No Merges`, `Show Graph`, pane toggles |
| Filters | Git → toolbar | Text search, branch filter, path filter |
| Commit actions | Git → Log → right-click a commit | `Show Diff`, `Copy Revision Number`, `Checkout Revision`, `New Branch from Here`, `New Tag`, `Cherry-Pick`, `Revert`, `Reset Current Branch to Here` (soft/mixed/hard), `Edit Commit Message` (HEAD only) |
| `Side-by-side viewer` / `Unified viewer` | diff pane header | Both render the same parsed hunks |
| `Ignore Differences` → `None` / `Ignore whitespaces` | diff pane gear | Implemented by Git itself (`git diff -w`), not by hiding lines. Hunk staging is disabled while it is on, because a whitespace-ignoring diff is not a valid patch |
| `Show Whitespaces` | diff pane eye | Renders `·` for spaces and `→` for tabs |
| `Collapse Unchanged Fragments` | diff pane | Long context runs fold into a clickable row |
| Highlighting differences | diff pane | Word-level: the changed middle of a line is highlighted, so `1.0.0` → `1.1.0` marks the single differing character |

`Ctrl+F5` behaviour, "refresh after every action", is built in: every mutation
refreshes the status, the diff and the list.

## How it is put together

```
main.js              Node process: the Git engine and the channel router
src/theme.css        IDEA palette + components   ─┐
src/layout.css       layout and responsiveness   ─┤ inlined by
src/common.js        bridge, i18n, icons, popups ─┤ tools/build.mjs into
src/diff.js          unified-diff parse + render ─┤
src/commit-view.js   the Commit tool window      ─┤
src/git-view.js      Log + Console, and the boot ─┘
views/commit.html    generated — do not edit by hand
views/git.html       generated — do not edit by hand
renderer/index.html  generated — both windows behind a tab bar
tools/build.mjs      the inliner (see below)
```

### Why a build step

The host loads a view with `loadURL(pathToFileURL(entry))`, i.e. a `file://`
URL, and Chromium refuses ES module scripts from `file://`. The bundled
first-party plugins work around this by shipping one large self-contained HTML
file each; `tools/build.mjs` produces the same shape from readable sources:

```bash
node tools/build.mjs     # writes views/*.html and renderer/index.html
```

Edit `src/`, run the build, and the running development plugin hot-reloads.
Editing a generated HTML file directly is wasted work — the next build
overwrites it.

### How the view talks to Git

`main.js` runs in a dedicated Node process (Electron `utilityProcess`), so it
has the real Node API and can spawn `git`. The views are sandboxed pages that
only receive `window.pluginBridge`. The host forwards every channel it does not
implement itself to the plugin's exported `onPanelInvoke`, which is what makes
custom channels work:

```
view  --pluginBridge.invoke("git/…")-->  host  -->  onPanelInvoke  -->  git
```

Two environment facts shape the engine:

- The plugin process is handed `PATH`, `LANG` and the temp variables but **not
  `HOME`**, and Git needs `HOME` for `~/.gitconfig` (identity, credential
  helper). Every invocation restores it.
- Prompts are disabled (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`), so `push`
  and `pull` fail fast and visibly instead of hanging with no terminal.

Status is read with `git status --porcelain=v2 -z`: `-z` is the only form that
returns paths verbatim, so spaces and non-ASCII names survive, and v2 keeps the
index and worktree columns apart, which is exactly the staged/unstaged split the
UI shows. Diffs are produced with Git's default `a/`-`b/` prefixes because
`git apply` strips one leading component; the patch sent back for a hunk is the
original header plus the chosen hunks, which is what lets `--recount` accept a
partial selection.

## Permissions

| Permission | Why |
| --- | --- |
| `ui.panel` | the detached window |
| `ui.view` | the two docked views |
| `clipboard.write` | `Copy Revision Number`, copy path |
| `fs.read` | `Open File` and `Reveal in File Manager` for a changed file |
| `models.list` | the model picker on the generate button |
| `agent.complete` | drafting a commit message with the host's model |

`PluginCheck` reports `clipboard.write` and `fs.read` as unused because it only
scans `main.js`; both are called from the views over the panel bridge. The
plugin never writes to the workspace: every file mutation goes through `git`, and
the one place that deletes a file (discarding an untracked file, or reverting an
untracked hunk) asks for confirmation first.

## Generated commit messages

The sparkles button next to the summary drafts the message for you. It asks the
**host's** model through `pi.agent.complete`, so it uses whatever provider,
model and quota you already have configured — the plugin holds no API key and
adds no account.

What it sends is the change itself plus a sample of the repository's recent
commit subjects, so the draft matches the project's own tone and language
rather than an invented one. The diff is capped at 12 000 characters: it is a
prompt, not a backup.

**Scope.** With a file selected in the Changes list it describes *that file*;
with nothing selected it describes *everything staged*. Which one it used is
reported in the toast, so the scope is never a guess. If neither exists it says
so instead of inventing a message.

**The draft is a draft.** It lands in the message field, editable as usual. If
you had already typed something, it asks before replacing it.

Permissions: `models.list` (to offer the model picker) and `agent.complete`
(high risk — it spends your model quota). The host rate-limits this to **8
generations per minute**; the plugin reports that limit rather than retrying
blindly.

## Authentication

**The plugin holds no credentials, and needs none.** It runs the user's own
`git` with the user's own `HOME`, so it inherits exactly the setup their
terminal already uses — the same `~/.gitconfig`, the same credential helpers,
the same `~/.ssh/config` and keys. Whatever authenticates a `git push` in a
shell authenticates it here, on GitHub, on a self-hosted GitLab, or anywhere
else; there is nothing per-host to configure in the plugin.

That inheritance is deliberate. A plugin cannot be trusted with a token, and a
per-host credential form would only ever cover the hosts it knew about.

The one thing the plugin cannot do is *ask*. There is no terminal behind a
tool window, so prompts are disabled (`GIT_TERMINAL_PROMPT=0`,
`GIT_ASKPASS=echo`) and a command fails immediately instead of hanging forever
on a password nobody can type. When that happens the raw Git error is shown
along with what to do about it:

| Failure | What the plugin says |
| --- | --- |
| No stored credential (HTTPS) | run `git push` once in a terminal so the credential helper stores it, then retry |
| `Permission denied (publickey)` | use an HTTPS remote, or make the key work without `ssh-agent` — the host passes no `SSH_AUTH_SOCK`, so agent-held keys cannot be unlocked. On macOS, `UseKeychain yes` in `~/.ssh/config` is enough |

### Setup recipes

**GitHub, HTTPS** — `gh auth login` then `gh auth setup-git` writes the helper
into `~/.gitconfig`. Nothing else needed.

**GitLab (any host), HTTPS** — let Git store it once:

```bash
git config --global credential.helper osxkeychain   # macOS (libsecret on Linux,
                                                    # manager on Windows)
git push            # enter the token once; it is stored from then on
```

A self-hosted GitLab works with no plugin-side configuration at all, because
this is the same credential store your shell uses.

**SSH** — passphrase-less keys, or a passphrase in the macOS keychain
(`UseKeychain yes`), work as-is. Keys that live only in `ssh-agent` do not,
because the host does not hand `SSH_AUTH_SOCK` to a plugin process; use an
HTTPS remote for those, or add the key to the keychain.

> Multi-account setups: the plugin reads whichever account your credential
> helper resolves for that URL, so `credential.<url>.username` and
> `includeIf "gitdir:…"` rules apply exactly as they do in a terminal.

## Colours

Most of the light palette is copied from JetBrains' own documentation: the
inserted row `#c6e4c1`, the modified row `#e9eff9`, the changed-fragment blue
`#c6d7f0`, the pane divider, the editor gutter change bars, and the file-status
colours (`#0a7700` added, `#0032a0` modified, `#993300` unversioned, …). The
remaining UI chrome follows the look of IntelliJ Light and Darcula, where
JetBrains publishes no numbers.

**One deliberate deviation, in both themes:** JetBrains documents the deleted row
as a neutral grey (`#D7D6D6` light). Next to a green insertion that grey reads as
*faded* rather than *removed*, so deletions use a soft red instead — `#f7d2d2`
light, `#452a2e` dark.

**The dark diff palette is tuned rather than copied.** The docs' dark values gave
a brown-leaning row tint, and a steel-blue fragment patch over a dark red row
turns to mud. So dark carries its own values, and the changed-fragment colour
follows the row it sits on: a redder red on deletions, a greener green on
insertions. `--diff-fragment-deleted` / `--diff-fragment-inserted` are the
override points; the light theme leaves them unset and keeps JetBrains' blue.

All of it is CSS variables at the top of `src/theme.css`, so retuning is a
one-line change per value.

## Keyboard

The host runs the app's own shortcuts from the main window's renderer, and a
plugin view is a separate `WebContentsView` — so keys pressed while a view has
focus never reach the host's handler. **Anything a button advertises has to be
bound inside the page**, which is exactly what these are:

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Refresh | `⌘R` | `Ctrl+R` |
| Refresh (IDEA's binding) | `⌃F5` | `Ctrl+F5` |
| Add to index | `⌘⌥A` | `Ctrl+Alt+A` |
| Rollback (asks first) | `⌘⌥Z` | `Ctrl+Alt+Z` |
| Show Diff | `⌘D` | `Ctrl+D` |
| Commit Message (Commit view) | `⌘K` | `Ctrl+K` |
| Search the log (Git view) | `⌘F` | `Ctrl+F` |
| Close a dialog, menu or the diff | `Esc` | `Esc` |
| Move through the commit list | `↑` `↓` | `↑` `↓` |

Tooltips are rendered from the same spec that is bound (`PIG.formatShortcut`), so
a tooltip cannot advertise a key that does nothing — which is a mistake worth
designing out, because it is invisible until a user tries it.

### Where a key works

The host's accelerators and this plugin's bindings live in different places, so
which key does what depends on where focus is. Worth knowing exactly:

| Key | In the app (focus outside a view) | Inside this plugin's view |
| --- | --- | --- |
| `⌘K` / `Ctrl+K` | the app's **session search** | **Commit view:** focuses Commit Message. **Git view:** nothing (the app's search is unreachable here) |
| `⌘⇧P` / `Ctrl+Shift+P` | the app's **command palette** | nothing useful — the key cannot reach the app, so the view explains where to go instead |
| `Alt+Space` | plugin launcher | **same — it is a true global shortcut** |
| `⌘R` / `Ctrl+R` | reload | refresh the repository |
| `⌘D`, `⌘⌥A`, `⌘⌥Z`, `⌘F`, `Esc`, `↑` `↓` | app's own meanings | the plugin's, per the table above |

So: **to run an app-level command (including `IDEA Git: Open as a separate
window`), press `Alt+Space` — or click back into the app and use `⌘⇧P`.**
Pressing `⌘⇧P` inside a view now shows a message saying exactly that, rather than
doing nothing at all.

## Where this deliberately differs from IDEA

- **No editor.** IDEA opens a diff in the editor tab; here a commit's diff opens
  in an overlay inside the Git tool window. `Jump to Source` becomes `Open File`
  (the OS default application) and `Reveal in File Manager`.
- **No changelists.** IDEA's changelists are an IDE-side concept with no Git
  equivalent; the Staged/Unstaged split replaces them. One working copy, one
  change set.
- **No shelf.** `Stash` covers the Git-native case.
- **No synced side-by-side scrolling.** Side by side scrolls horizontally as one
  grid so both panels stay on the same offset.
- **`Edit Commit Message` only for the tip**, since rewording an older commit
  needs a rebase.
- **Hunk staging is disabled in `Ignore whitespaces` mode** and for unversioned
  files — a whitespace-ignoring diff, and a diff against `/dev/null`, are not
  patches Git will accept for those operations. Whole-file `Add` still works.
- **Deleted rows are red, not JetBrains' grey**, and the dark diff palette is
  tuned by eye rather than copied. See *Colours* above.

## Developing

1. Plugins page → **`···` → Load development plugin** → this directory.
2. Edit `src/`, run `node tools/build.mjs`, and the view hot-reloads.
3. `PluginCheck` then `PluginPack` to produce `dist/local.pi-idea-git-0.2.0.piplug`.

### Driving the engine without the GUI

`tools/drive.mjs` calls the same `onPanelInvoke` channels a view calls, with a
stubbed `pi` global, so a flow can be exercised from a terminal or a test script:

```bash
node tools/drive.mjs /path/to/repo git/repo
node tools/drive.mjs /path/to/repo git/stage '{"paths":["src/app.js"]}'
node tools/drive.mjs /path/to/repo git/commit '{"message":"Fix the thing"}'
```

Run it under a reduced environment to match what the real plugin process
actually receives — `PATH`, `LANG` and the temp variables, but **no `HOME`**:

```bash
env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" node tools/drive.mjs . git/repo
```

That is how the engine's push path was verified against a real HTTPS remote
without a credential prompt.

> **Widening `permissions` needs a longer path than the reload button.**
> Saving triggers a hot reload that refuses a manifest asking for more than the
> running instance was granted. The card's **Reload** button is not enough
> either: it intersects the new manifest with the permissions recorded in
> `registry.json`, silently drops whatever is new, and still reports success.
> Only **`···` → Load development plugin** (re-picking the folder) re-reads the
> manifest and re-asks for consent.
The repository notes under `.memories/` and `.agents/notes/` document the
constraints that shaped this plugin; they are plain Markdown and ship with the
package.
