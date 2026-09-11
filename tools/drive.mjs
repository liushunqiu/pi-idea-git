#!/usr/bin/env node
/**
 * Drive the plugin's engine directly, without the GUI.
 *
 * The plugin's `main.js` runs in a Node process and answers panel channels
 * through `onPanelInvoke`. A work-panel view reaches it with
 * `pluginBridge.invoke(channel, payload)`; this script reaches the very same
 * function with a stubbed `pi` global, so a flow can be exercised (and
 * regression-tested) without clicking anything.
 *
 * Run it under a reduced environment to be faithful to the real plugin process,
 * which receives only PATH/LANG/TEMP but never HOME:
 *
 *   env -i PATH="$PATH" TMPDIR="$TMPDIR" node tools/drive.mjs /path/to/repo git/repo
 *
 * Usage: node tools/drive.mjs <repo-path> <channel> [json-payload]
 */

import { createRequire } from "node:module";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL("..", import.meta.url));

const [repoArg, channel, payloadArg] = process.argv.slice(2);

if (!repoArg || !channel) {
  process.stderr.write(
    "usage: node tools/drive.mjs <repo-path> <channel> [json-payload]\n"
      + "  e.g. node tools/drive.mjs ~/code/project git/repo\n"
      + "       node tools/drive.mjs ~/code/project git/stage '{\"paths\":[\"a.txt\"]}'\n",
  );
  process.exit(2);
}

const repo = isAbsolute(repoArg) ? repoArg : resolve(process.cwd(), repoArg);

// A minimal stand-in for the host API the plugin expects. Only what the engine
// touches is implemented; the rest throws loudly so a new dependency shows up
// instead of silently returning undefined.
const pi = {
  workspace: {
    get: async () => ({ path: repo, name: basename(repo) }),
  },
  commands: { register: async () => {}, unregister: async () => {} },
  ui: { openPanel: async () => {}, showToast: () => {} },
  plugin: { getDataPath: async () => process.env.TMPDIR ?? "/tmp" },
  events: { on: () => {}, off: () => {} },
};
globalThis.pi = pi;

const plugin = require(resolve(here, "main.js"));

let payload = {};
if (payloadArg) {
  try {
    payload = JSON.parse(payloadArg);
  } catch (error) {
    process.stderr.write(`payload is not valid JSON: ${error.message}\n`);
    process.exit(2);
  }
}

const result = await plugin.onPanelInvoke(channel, payload);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(result?.ok === false ? 1 : 0);
