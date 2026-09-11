#!/usr/bin/env node
/**
 * Inline the authoring sources into the pages PI-Desktop actually loads.
 *
 * The host loads a view with `loadURL(pathToFileURL(entry))`, i.e. a `file://`
 * URL. Chromium refuses ES module scripts from `file://` (opaque origin), so a
 * multi-file layout with `import` would silently load nothing. The bundled
 * first-party plugins solve this by shipping one large self-contained HTML
 * file; this script produces the same shape from readable sources.
 *
 * Run: node tools/build.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

const CSS = ["src/theme.css", "src/layout.css"];
const JS = ["src/common.js", "src/diff.js", "src/commit-view.js", "src/git-view.js"];

const styles = CSS.map(
  (file) => `/* ---- ${file} ---- */\n${read(file)}`,
).join("\n");
const scripts = JS.map(
  (file) => `/* ================= ${file} ================= */\n${read(file)}`,
).join("\n");

/**
 * @param {{title: string, surface: string, locale: string, shell: string}} options
 *   `surface` tells the runtime which tool window to mount.
 */
function page({ title, surface, locale }) {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="pi-plugin-chrome" content="v3" />
    <title>${title}</title>
    <style>
${styles}
    </style>
  </head>
  <body>
    <div id="app" class="app"></div>
    <script>
window.__PI_IDEA_GIT_SURFACE__ = ${JSON.stringify(surface)};
    </script>
    <script>
(function () {
"use strict";
${scripts}
})();
    </script>
  </body>
</html>
`;
}

const targets = [
  { file: "views/commit.html", title: "Commit", surface: "commit" },
  { file: "views/git.html", title: "Git", surface: "git" },
  { file: "renderer/index.html", title: "IDEA Git", surface: "both" },
];

for (const target of targets) {
  const output = join(root, target.file);
  mkdirSync(dirname(output), { recursive: true });
  const html = page({ title: target.title, surface: target.surface, locale: "en" });
  writeFileSync(output, html, "utf8");
  process.stdout.write(`wrote ${target.file} (${(html.length / 1024).toFixed(1)} KB)\n`);
}
