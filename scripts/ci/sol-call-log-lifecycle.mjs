import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Register before fixture-level database teardown; import after each fixture selects its state.
if (process.argv[1]?.endsWith(".test.ts")) {
  const callLogs = () => import(pathToFileURL(path.resolve("src/lib/usage/callLogs.ts")).href);
  test.afterEach(async () => {
    assert.ok(await (await callLogs()).waitForCallLogSaves(5000), "Call-log saves did not settle");
  }, { timeout: 6000 });
  test.after(async () => {
    await (await callLogs()).closeCallLogSaves(5000);
  }, { timeout: 6000 });
}
