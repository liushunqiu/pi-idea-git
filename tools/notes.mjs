#!/usr/bin/env node
/**
 * Agent Note gate: `.agents/notes/` holds the decisions the code cannot carry —
 * why this shape, and what it displaced. A note nobody can find, or one whose
 * head block drifted, is a note the next reader (human or agent) will not trust,
 * so the shape is enforced rather than agreed on.
 *
 * Two independent checks, both vendored under `tools/agent-notes/` so this runs
 * whether or not the skill is installed on the machine:
 *   verify-agent-note-tree.ts   — lifecycle/class/filename layout, relative links
 *   verify-agent-note-format.ts — head block, `Status:`, required sections, voice
 *
 * Run: node tools/notes.mjs   (also asserted by `node tools/harness.mjs`)
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS = ["verify-agent-note-tree.ts", "verify-agent-note-format.ts"];

/**
 * Run both checks against the working tree.
 * @returns {{script: string, ok: boolean, output: string}[]}
 */
export function verifyNotes() {
  return CHECKS.map((script) => {
    const file = join(ROOT, "tools", "agent-notes", script);
    try {
      // Node strips the type annotations itself: no tsx, no build step.
      const output = execFileSync(process.execPath, [file], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return { script, ok: true, output };
    } catch (error) {
      const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim() || String(error?.message ?? error);
      return { script, ok: false, output };
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const results = verifyNotes();
  for (const { script, ok: verified, output } of results) {
    process.stdout.write(`${verified ? "ok  " : "FAIL"} ${script}\n`);
    if (!verified) process.stdout.write(`${output.replace(/^/gm, "       ")}\n`);
  }
  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(
    failed ? `\n${failed}/${results.length} agent-note check(s) failed\n` : `\nagent notes ok (${results.length} check(s))\n`,
  );
  process.exit(failed ? 1 : 0);
}
