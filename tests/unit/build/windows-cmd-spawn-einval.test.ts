import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBuildTool } from "../../../scripts/build/buildToolRunner.mjs";
import { rebuildInvocation } from "../../../scripts/dev/ensure-native-sqlite.mjs";

// Since the CVE-2024-27980 hardening, Node refuses to spawn a `.cmd`/`.bat` without a
// shell and throws EINVAL. Three typecheck gates spawned `npx.cmd` that way, so on
// Windows they crashed before running tsc, and `ensure-native-sqlite` spawned
// `npm.cmd` that way, so its rebuild always reported failure there.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const TYPECHECK_GATES = [
  "scripts/check/check-api-typecheck.mjs",
  "scripts/check/check-dashboard-typecheck.mjs",
  "scripts/check/check-open-sse-typecheck.mjs",
];

test("typecheck gates run tsc through runBuildTool, never a bare npx.cmd", () => {
  for (const rel of TYPECHECK_GATES) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /"npx\.cmd"/, `${rel} still spawns npx.cmd`);
    assert.match(src, /runBuildTool\(\s*"typescript",\s*"tsc",/, `${rel} must use runBuildTool`);
  }
});

test("runBuildTool returns the tool's stdout so the gates can parse tsc output", () => {
  const out = runBuildTool("typescript", "tsc", ["--version"], { encoding: "utf8" });
  assert.match(String(out), /^Version \d+\.\d+/);
});

test("ensure-native-sqlite spawns npm.cmd through the shell on win32", () => {
  const win = rebuildInvocation("win32");
  assert.equal(win.shell, true, "npm.cmd without a shell is EINVAL on Windows");
  assert.equal(win.file, "npm.cmd rebuild better-sqlite3");
  assert.deepEqual(win.args, [], "a shell command with an args array trips DEP0190");

  assert.deepEqual(rebuildInvocation("linux"), {
    file: "npm",
    args: ["rebuild", "better-sqlite3"],
    shell: false,
  });
});
