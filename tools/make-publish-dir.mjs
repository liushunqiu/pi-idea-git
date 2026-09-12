#!/usr/bin/env node
/**
 * Assemble a clean publish directory with only the files PI-Desktop needs
 * at runtime.
 *
 * `PluginPack` ships everything under the packed directory except `.git`
 * (it does not read `.gitignore`, and there is no exclude file — verified
 * 2026-09-12: packing the repo root produced a 2.1 MB / 46-file archive
 * containing `.smoke/`, `.memories/`, `tools/`, `src/` and friends).
 * So releases are packed from the directory this script builds, never from
 * the repo root:
 *
 *   node tools/build.mjs && node tools/make-publish-dir.mjs
 *   # then PluginCheck + PluginPack on dist-publish/<plugin-id>/
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const RUNTIME_FILES = [
  "manifest.json",
  "main.js",
  "views/commit.html",
  "views/git.html",
  "renderer/index.html",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];

const out = join(root, "dist-publish", manifest.id);
rmSync(out, { recursive: true, force: true });

let total = 0;
for (const file of RUNTIME_FILES) {
  const src = join(root, file);
  const dest = join(out, file);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  total += statSync(dest).size;
  process.stdout.write(`staged ${file}\n`);
}
process.stdout.write(`publish dir: ${out} (${RUNTIME_FILES.length} files, ${(total / 1024).toFixed(1)} KB)\n`);
