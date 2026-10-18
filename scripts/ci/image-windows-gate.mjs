import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32", "Windows ownership gate only");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.GITHUB_REPOSITORY, "KiaroSama/OmniRoute");
assert.equal(process.env.IMAGE_VALIDATION_LANE, "compile-windows");

// The native owner assigns this process before releasing stdin. No child starts before GO.
await new Promise((resolve, reject) => {
  let input = "";
  const timer = setTimeout(() => finish(new Error("Native ownership admission timed out")), 10000);
  const finish = (error) => {
    clearTimeout(timer);
    process.stdin.off("data", receive);
    process.stdin.off("end", ended);
    process.stdin.pause();
    error ? reject(error) : resolve();
  };
  const receive = (chunk) => {
    input += chunk;
    if (input.length > 8) finish(new Error("Invalid native ownership admission"));
  };
  const ended = () =>
    finish(input.trim() === "GO" ? undefined : new Error("Ownership not admitted"));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", receive);
  process.stdin.once("end", ended);
});

const { imageEnvironment, processSnapshot, runWindowsImageGate, sweepImageProcesses } =
  await import("./image-validation-process.mjs");
const root = fs.realpathSync(process.argv[2]);
const owned = fs.realpathSync(process.env.IMAGE_VALIDATION_ROOT);
const relative = path.relative(path.join(root, ".ci-work"), owned);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
assert.equal(
  processSnapshot().get(String(process.pid))?.membership,
  "owned",
  "Native ownership missing"
);
const tooling = path.dirname(fileURLToPath(import.meta.url));
const { IMAGE_BASELINE, validateImageSelection } = await import("./image-validation-contract.mjs");
const recorded = JSON.parse(fs.readFileSync(path.join(owned, "evidence/selection.json"), "utf8"));
validateImageSelection({
  candidate: process.env.CANDIDATE_SHA,
  actual: recorded.candidate,
  workflow: process.env.VALIDATION_WORKFLOW_SHA,
  admitted: recorded.baseline === IMAGE_BASELINE,
});
assert.equal(recorded.workflow, process.env.VALIDATION_WORKFLOW_SHA);
assert.equal(recorded.lane, "compile-windows");
assert.equal(recorded.platform, "win32");
const expected = JSON.parse(
  fs.readFileSync(path.join(root, "config/ci/toolchain.json"), "utf8")
).npm;
assert.match(expected, /^\d+\.\d+\.\d+$/);
const env = imageEnvironment(root, owned, {
  GITHUB_REPOSITORY: "KiaroSama/OmniRoute",
  CANDIDATE_SHA: process.env.CANDIDATE_SHA,
  VALIDATION_WORKFLOW_SHA: process.env.VALIDATION_WORKFLOW_SHA,
  IMAGE_VALIDATION_LANE: "compile-windows",
  IMAGE_VALIDATION_ROOT: owned,
  ONNXRUNTIME_NODE_INSTALL: "skip",
});
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let sequence = 0;
async function run(name, args, wall, idle) {
  const result = await runWindowsImageGate(process.execPath, args, {
    cwd: root,
    env: { ...env, IMAGE_CHECK_ID: `windows-setup-${++sequence}` },
    logPath: path.join(owned, "evidence", `${name}.log`),
    timeout: wall * 1000,
    idle: idle * 1000,
    signal: controller.signal,
  });
  console.log(result.out.slice(-24000));
  assert.equal(result.code, 0, `Windows ${name} failed`);
  return result;
}
try {
  const bootstrap = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  assert.ok(fs.statSync(bootstrap).isFile(), "setup-node npm bootstrap is unavailable");
  const prefix = path.join(owned, "npm-tooling");
  await run(
    "npm-selection",
    [
      bootstrap,
      "install",
      "--global",
      "--prefix",
      prefix,
      `npm@${expected}`,
      "--no-audit",
      "--no-fund",
    ],
    180,
    120
  );
  env.IMAGE_NPM_CLI = path.join(prefix, "node_modules/npm/bin/npm-cli.js");
  env.NPM_CONFIG_PREFIX = prefix;
  env.PATH = `${prefix}${path.delimiter}${env.PATH}`;
  await run(
    "pinned-npm",
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; import { execFileSync } from "node:child_process"; const actual = execFileSync(process.execPath, [process.argv[1], "--version"], { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); assert.equal(actual, process.argv[2], "Windows selected npm differs from locked toolchain"); console.log(actual);',
      env.IMAGE_NPM_CLI,
      expected,
    ],
    30,
    20
  );
  await run("npm-ci", [env.IMAGE_NPM_CLI, "ci", "--no-audit", "--no-fund"], 600, 120);
  await run("native-install", ["scripts/ci/verify-ci-install.mjs"], 60, 30);
  // Reuse the coordinator in this owned process; do not nest process snapshot monitors.
  Object.assign(process.env, env);
  process.argv[2] = "run";
  await import("./image-validation.mjs");
} finally {
  try {
    await sweepImageProcesses(owned);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
