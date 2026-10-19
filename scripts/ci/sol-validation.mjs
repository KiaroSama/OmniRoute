import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGateProcess } from "../quality/gate-process.mjs";
import { IMAGE_BASELINE, validateImageSelection } from "./image-validation-contract.mjs";
import {
  imageEnvironment,
  offlineCommand,
  prepareImageState,
  sweepImageProcesses,
} from "./image-validation-process.mjs";

const base = "11bb5f11f6415ca4fe1417c0ca0ed95b25af6678";
const root = process.cwd();
const tooling = path.dirname(fileURLToPath(import.meta.url));
assert.equal(process.env.GITHUB_ACTIONS, "true", "Hosted validation only");
assert.equal(process.env.GITHUB_REPOSITORY, "KiaroSama/OmniRoute", "Owner fork only");
const lane = process.env.IMAGE_VALIDATION_LANE;
assert.ok(["sol-runtime", "sol-static", "sol-types"].includes(lane));
assert.equal(process.platform, "linux", "Focused offline validation requires Linux");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 15000 });
git("merge-base", "--is-ancestor", base, "HEAD");
const selection = validateImageSelection({
  candidate: process.env.CANDIDATE_SHA,
  actual: git("rev-parse", "HEAD").trim(),
  workflow: process.env.VALIDATION_WORKFLOW_SHA,
  admitted: git("merge-base", "--is-ancestor", IMAGE_BASELINE, "HEAD") !== null,
});
const owned = path.resolve(process.env.IMAGE_VALIDATION_ROOT);
const evidence = path.join(owned, "evidence");
const identity = { ...selection, scope: "sol", focusedBase: base, lane, platform: process.platform };
// Preparation runs before npm ci or any candidate-local action/lifecycle script.
const changed = git("diff", "--name-only", base, "HEAD", "--").trim().split("\n");
const files = [
  "open-sse/config/imageRegistryData.ts",
  "open-sse/config/providers/registry/codex/imageModels.ts",
  "open-sse/handlers/imageGeneration.ts",
  "open-sse/handlers/imageGeneration/providers/codexReferences.ts",
  "src/app/api/v1/images/edits/editInput.ts",
  "src/app/api/v1/images/edits/route.ts",
  "tests/unit/codex-sol-original-reference.test.ts",
  "tests/unit/image-registry-gpt56.test.ts",
];
assert.deepEqual(changed, files, "Focused candidate inventory changed; reject before installation");
assert.ok(files.every(file => fs.statSync(file).isFile()), "Focused files must be present");
if (process.argv[2] === "prepare") {
  prepareImageState(root, owned);
  fs.writeFileSync(path.join(evidence, "selection.json"), JSON.stringify(identity) + "\n", "utf8");
} else if (process.argv[2] === "cleanup") {
  await sweepImageProcesses(owned);
} else {
  assert.equal(process.argv[2], "run");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence, "selection.json"), "utf8")), identity);
  const env = imageEnvironment(root, owned);
  const receipts = [];
  let failed = false, cancelled = false, active;
  const cancel = () => { cancelled = true; active?.abort(); };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const save = () => fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify({
    ...identity, root, files, receipts, failed, cancelled, completedAt: new Date().toISOString(),
    limitation: "Focused Sol evidence only; full image matrix, coverage and signed distribution remain separate gates",
  }, null, 2) + "\n", "utf8");
  let sequence = 0;
  async function check(name, args, wall = 120, idle = 60) {
    assert.ok(!cancelled, "Cancelled validation cannot start another child");
    active = new AbortController();
    const childEnv = { ...env, IMAGE_CHECK_ID: `sol-${++sequence}` };
    const command = offlineCommand(process.execPath, args, childEnv);
    const result = await runGateProcess(...command, {
      cwd: root, env: childEnv, timeout: wall * 1000, idle: idle * 1000,
      heartbeatMs: 5000, signal: active.signal,
      logPath: path.join(evidence, `${sequence}-${name}.log`),
      onHeartbeat: ({ elapsedMs, lastOutputAt, bytes }) => {
        console.log(`[sol/${name}] elapsed=${elapsedMs} outputBytes=${bytes}`);
        if (Date.now() - Date.parse(lastOutputAt) > idle * 1000) active.abort();
      },
    });
    active = undefined;
    receipts.push({ name, code: result.code, ...result.receipt });
    failed ||= result.code !== 0;
    save();
    console.log(result.out.slice(-24000));
    return result;
  }
  try {
    const expectedNpm = JSON.parse(fs.readFileSync("config/ci/toolchain.json", "utf8")).npm;
    const actualNpm = execFileSync("npm", ["--version"], {
      cwd: root, env, encoding: "utf8", timeout: 15000, windowsHide: true,
    }).trim();
    assert.equal(actualNpm, expectedNpm, "Pinned npm must survive environment isolation");
    if (lane === "sol-runtime") {
      const suites = [
        "codex-sol-original-reference", "image-registry-gpt56", "image-registry-data-client-safe",
        "image-generation-codex-hosted-background", "codex-images-dedicated-endpoint", "image-edits-multipart-3273",
      ].map(name => `tests/unit/${name}.test.ts`);
      fs.writeFileSync(path.join(evidence, "executed-files.json"), JSON.stringify(suites) + "\n", "utf8");
      for (const file of suites) {
        const lifecycle = ["image-generation-codex-hosted-background", "codex-images-dedicated-endpoint", "image-edits-multipart-3273"]
          .some(name => file.endsWith(`/${name}.test.ts`));
        await check(path.basename(file, ".test.ts"), [
          "--import", "tsx/esm",
          ...(lifecycle ? ["--import", path.join(tooling, "sol-call-log-lifecycle.mjs")] : []),
          "--test", "--test-concurrency=1", "--test-timeout=60000", "--test-reporter=tap", file,
        ], 120, 90);
      }
    } else if (lane === "sol-static") {
      for (const file of files) new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
      await check("format", ["node_modules/prettier/bin/prettier.cjs", "--check", ...files]);
      await check("lint", ["node_modules/eslint/bin/eslint.js", "--suppressions-location", "config/quality/eslint-suppressions.json", "--pass-on-unpruned-suppressions", ...files], 180, 120);
      await check("architecture", ["scripts/quality/measure-boundary.mjs", "--ratchet", "--base-ref", base], 120, 90);
    } else {
      // Preserve actual diagnostics and compare with exact base source, not a new allowance.
      const baseFiles = new Set(git("ls-tree", "-r", "--name-only", base, "--", ...files).trim().split("\n"));
      const originals = Object.fromEntries(files.filter(file => baseFiles.has(file))
        .map(file => [file, git("show", `${base}:${file}`)]));
      assert.equal(Object.keys(originals).length, 4, "Exact baseline source inventory changed");
      const compile = path.join(owned, "compile.mjs");
      fs.writeFileSync(compile, `
import assert from 'node:assert/strict';
import ts from ${JSON.stringify(pathToFileURL(path.join(root, "node_modules/typescript/lib/typescript.js")).href)};
import path from 'node:path';
const root = process.cwd();
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const roots = ${JSON.stringify(files)};
const originals = ${JSON.stringify(originals)};
const declarations = [...parsed.fileNames.filter(file => file.endsWith('.d.ts')), path.join(root, 'open-sse/types.d.ts')];
const options = { ...parsed.options, noCheck: false, noEmit: true, incremental: false };
function compile(baseline) {
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host); let count = 0;
  host.readFile = file => {
    const relative = path.relative(root, file).replaceAll('\\\\', '/');
    const value = baseline && Object.hasOwn(originals, relative) ? originals[relative] : read(file);
    if (++count % 250 === 0) console.log(baseline ? 'Baseline sources:' : 'Candidate sources:', count);
    return value;
  };
  const selected = baseline ? Object.keys(originals) : roots;
  const program = ts.createProgram([...selected.map(file => path.join(root, file)), ...declarations], options, host);
  return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
}
function normalized(diagnostics) {
  return diagnostics.map(d => JSON.stringify({
    file: d.file ? path.relative(root, d.file.fileName).replaceAll('\\\\', '/') : null,
    code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\\n'),
    expression: d.file && d.start !== undefined ? d.file.text.slice(d.start, d.start + (d.length || 0)) : null,
  })).sort();
}
const baseline = compile(true), candidate = compile(false);
console.log(ts.formatDiagnosticsWithColorAndContext(candidate, { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\\n' }));
console.log(JSON.stringify({ typescript: ts.version, baselineDiagnostics: baseline.length, candidateDiagnostics: candidate.length, zeroErrorTypecheck: candidate.length === 0 }));
assert.deepEqual(normalized(candidate), normalized(baseline), 'Focused source introduces a different compiler diagnostic');
console.log('PASS: exact-base diagnostic comparison only; inherited errors are not a zero-error typecheck');
`, "utf8");
      await check("exact-base-diagnostic-comparison", [compile], 300, 120);
    }
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    save();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  process.exitCode = failed ? 1 : 0;
}
