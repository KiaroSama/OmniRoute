import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runGateProcess } from "../quality/gate-process.mjs";
import {
  IMAGE_BASELINE,
  discoverNativeBuckets,
  partitionNativeFiles,
  selectImageFiles,
  validateImageSelection,
} from "./image-validation-contract.mjs";
import {
  imageEnvironment,
  offlineCommand,
  prepareImageState,
  runWindowsImageGate,
  sweepImageProcesses,
} from "./image-validation-process.mjs";
import { mergeImageCoverage } from "./image-validation-coverage.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "This entry point is hosted-only");
assert.equal(process.env.GITHUB_REPOSITORY, "KiaroSama/OmniRoute", "Owner-fork validation only");
const root = process.cwd();
const tooling = path.dirname(fileURLToPath(import.meta.url));
const initialPath = process.env.PATH;
const selectedNpmCli = process.env.IMAGE_NPM_CLI;
assert.deepEqual(
  fs.readFileSync(path.join(tooling, "image-validation-contract.mjs")),
  fs.readFileSync(path.join(root, "scripts/ci/image-validation-contract.mjs")),
  "Workflow and candidate validation contracts differ"
);
const lane = process.env.IMAGE_VALIDATION_LANE;
assert.match(
  lane ?? "",
  /^(?:image|static|types|unit-[1-8]|integration-[12]|vitest-mcp|vitest-ui|ecosystem|protocols|compile-linux|compile-windows|coverage)$/
);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 15000 });
const selection = validateImageSelection({
  candidate: process.env.CANDIDATE_SHA,
  actual: git("rev-parse", "HEAD").trim(),
  workflow: process.env.VALIDATION_WORKFLOW_SHA,
  admitted:
    execFileSync("git", ["merge-base", "--is-ancestor", IMAGE_BASELINE, "HEAD"], {
      cwd: root,
      timeout: 15000,
    }) !== null,
});
const owned = path.resolve(process.env.IMAGE_VALIDATION_ROOT);
const evidence = path.join(owned, "evidence");
if (process.argv[2] === "prepare") {
  prepareImageState(root, owned);
  fs.writeFileSync(
    path.join(evidence, "selection.json"),
    JSON.stringify({ ...selection, lane, platform: process.platform }) + "\n",
    "utf8"
  );
} else if (process.argv[2] === "cleanup") {
  await sweepImageProcesses(owned);
} else {
  assert.equal(process.argv[2], "run", "Unknown validation operation");
  const recorded = JSON.parse(fs.readFileSync(path.join(evidence, "selection.json"), "utf8"));
  assert.deepEqual(recorded, { ...selection, lane, platform: process.platform });
  const receipts = [];
  let failed = false;
  let cancelled = false;
  const controllers = new Set();
  const cancel = () => {
    cancelled = true;
    for (const controller of controllers) controller.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "receipt.json"),
      JSON.stringify(
        {
          ...recorded,
          root,
          node: process.version,
          receipts,
          failed,
          cancelled,
          completedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  const coverage = path.join(owned, "v8");
  const env = imageEnvironment(root, owned);
  if (selectedNpmCli) {
    assert.ok(path.isAbsolute(selectedNpmCli), "Selected npm entry must be absolute");
    assert.ok(fs.statSync(selectedNpmCli).isFile(), "Selected npm entry is unavailable");
    env.NPM_CONFIG_PREFIX = path.resolve(path.dirname(selectedNpmCli), "../../..");
    env.PATH = `${env.NPM_CONFIG_PREFIX}${path.delimiter}${env.PATH}`;
  }
  Object.keys(process.env).forEach((key) => {
    delete process.env[key];
  });
  Object.assign(process.env, env, {
    GITHUB_REPOSITORY: "KiaroSama/OmniRoute",
    CANDIDATE_SHA: selection.candidate,
    VALIDATION_WORKFLOW_SHA: selection.workflow,
  });
  assert.ok(initialPath, "Runner toolchain PATH is required");
  let sequence = 0;

  function activity(checkId) {
    if (process.platform !== "linux") return "";
    let ticks = 0;
    for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        if (
          pid === String(process.pid) ||
          !fs
            .readFileSync(`/proc/${pid}/environ`)
            .includes(Buffer.from(`IMAGE_CHECK_ID=${checkId}\0`))
        )
          continue;
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
        ticks += Number(fields[11]) + Number(fields[12]);
      } catch (error) {
        if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
      }
    }
    const report = path.join(evidence, "eslint-results.json");
    return `${ticks}:${fs.existsSync(report) ? fs.statSync(report).size : 0}`;
  }

  async function check(name, command, args, wall = 120, idle = 60, extra = {}, offline = true) {
    assert.ok(!cancelled, "Cancelled batch cannot start another check");
    const controller = new AbortController();
    controllers.add(controller);
    const checkId = `${lane}-${++sequence}`;
    const childEnv = { ...env, ...extra, IMAGE_CHECK_ID: checkId };
    const invocation =
      offline && process.platform === "linux"
        ? offlineCommand(command, args, childEnv)
        : [command, args];
    let progressAt = Date.now();
    let previousActivity = activity(checkId);
    let previousOutput;
    const runner = process.platform === "win32" ? runWindowsImageGate : runGateProcess;
    const result = await runner(...invocation, {
      cwd: root,
      env: childEnv,
      timeout: wall * 1000,
      idle: idle * 1000,
      heartbeatMs: 5000,
      logPath: path.join(evidence, `${checkId}-${name}.log`),
      signal: controller.signal,
      onHeartbeat: ({ elapsedMs, lastOutputAt, bytes }) => {
        const current = activity(checkId);
        if (lastOutputAt !== previousOutput || current !== previousActivity)
          progressAt = Date.now();
        previousOutput = lastOutputAt;
        previousActivity = current;
        console.log(
          `[${lane}/${name}] elapsed=${elapsedMs} outputBytes=${bytes} activity=${current}`
        );
        if (Date.now() - progressAt > idle * 1000) controller.abort();
      },
    });
    controllers.delete(controller);
    receipts.push({ name, code: result.code, ...result.receipt });
    failed ||= result.code !== 0;
    save();
    console.log(result.out.slice(-24000));
    return result;
  }
  const node = (name, args, wall, idle, extra, offline) =>
    check(name, process.execPath, args, wall, idle, extra, offline);
  const changed = git("diff", "--name-only", "--diff-filter=ACMR", IMAGE_BASELINE, "HEAD", "--")
    .trim()
    .split("\n");
  const buckets = discoverNativeBuckets(root);
  const focused = selectImageFiles(
    buckets.flatMap((bucket) => bucket.files),
    changed
  );
  const covered = { NODE_V8_COVERAGE: coverage, DATA_DIR: "", OMNIROUTE_PLUGINS_DIR: "" };
  const args = (loader, workers = 2) => [
    "--import",
    "./tests/_setup/imageValidationState.mjs",
    "--import",
    loader,
    "--import",
    "./open-sse/utils/setupPolyfill.ts",
    "--import",
    "./tests/_setup/isolateDataDir.ts",
    "--test",
    "--test-force-exit",
    "--test-timeout=60000",
    `--test-concurrency=${workers}`,
    "--test-reporter=spec",
  ];

  async function nativeFiles(name, files, loader, workers = 2) {
    if (!files.length) return;
    await node(
      name,
      [...args(loader, workers), ...files],
      name === "unit" ? 1200 : 300,
      120,
      covered
    );
  }
  async function compactCoverage() {
    if (
      !fs.existsSync(coverage) ||
      !fs.readdirSync(coverage).some((file) => file.endsWith(".json"))
    ) {
      failed = true;
      throw new Error("Executed native lane did not produce coverage");
    }
    await node(
      "compact-coverage",
      [
        "node_modules/c8/bin/c8.js",
        "report",
        `--temp-directory=${coverage}`,
        `--reports-dir=${path.join(evidence, "coverage")}`,
        "--merge-async",
        "--reporter=json",
        "--reporter=json-summary",
        "--exclude=tests/**",
        "--exclude=**/*.test.*",
      ],
      180,
      90
    );
  }

  try {
    assert.ok(process.platform !== "win32" || selectedNpmCli, "Windows npm entry was not captured");
    const npmVersion = execFileSync(
      selectedNpmCli ? process.execPath : "npm",
      selectedNpmCli ? [selectedNpmCli, "--version"] : ["--version"],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      }
    ).trim();
    const expectedNpm = JSON.parse(
      fs.readFileSync(path.join(root, "config/ci/toolchain.json"), "utf8")
    ).npm;
    assert.equal(npmVersion, expectedNpm, "Pinned npm selection did not run");
    fs.writeFileSync(
      path.join(evidence, "inventory.json"),
      JSON.stringify({
        focused,
        native: buckets,
        selection,
        npm: npmVersion,
      }) + "\n",
      "utf8"
    );
    if (lane === "coverage") {
      const output = path.join(evidence, "coverage");
      await mergeImageCoverage({
        root,
        evidenceRoot: path.join(root, ".ci-work/image-evidence"),
        output,
        selection,
        buckets,
        focused,
      });
      receipts.push({ name: "inventory-and-floor", code: 0, outcome: "PASS" });
      fs.mkdirSync(path.join(root, "coverage"), { recursive: true });
      fs.copyFileSync(
        path.join(output, "coverage-summary.json"),
        path.join(root, "coverage/coverage-summary.json")
      );
      const lintSource = path.join(
        root,
        ".ci-work/image-evidence/image-validation-static/eslint-results.json"
      );
      await node("quality-metrics", ["scripts/quality/collect-metrics.mjs"], 180, 90, {
        ESLINT_RESULTS_JSON: lintSource,
      });
      await node("quality-ratchet", ["scripts/quality/check-quality-ratchet.mjs"], 90, 60);
    } else if (lane === "image") {
      const compilerDir = path.join(root, ".ci-work/image-repair");
      // This runner invokes only the compiler branch, never the legacy sibling-directory cleanup.
      fs.mkdirSync(compilerDir, { recursive: true });
      fs.writeFileSync(
        path.join(compilerDir, "roots.json"),
        JSON.stringify(
          changed.filter(
            (file) => /^(src|open-sse|tests)\//.test(file) && /\.(?:[cm]?[jt]sx?)$/.test(file)
          )
        ),
        "utf8"
      );
      await node(
        "image-production-closure",
        ["scripts/check/image-repair-ci.mjs", "--typecheck"],
        300,
        120
      );
      const lifecycle = new Set([
        "10197-openrouter-image-edits-route",
        "image-combo",
        "image-combo-empty-200-fallback",
        "fal-image-edit",
        "fal-image-generation-default",
        "image-combo-edits-fallback-12547",
        "image-edits-multipart-3273",
        "image-generation-fetch-timeout",
        "image-generation-handler",
        "image-generation-route-auth",
        "image-generation-route",
        "image-generation-resilience",
        "image-generation-proxy",
        "image-generation-n-fanout",
        "image-accounting-adapters",
        "image-usage-accounting",
        "codex-images-dedicated-endpoint",
        "image-generation-size-and-payload-guard",
        "image-routes-combo-edits-3214-3215",
        "image-upscale-error-log",
        "nanobanana-image-handler",
        "t42-image-size-to-aspect-ratio",
      ]);
      fs.writeFileSync(path.join(evidence, "executed-files.json"), JSON.stringify(focused), "utf8");
      for (let index = 0; index < focused.length; index += 2) {
        const results = await Promise.allSettled(
          focused.slice(index, index + 2).map((file) => {
            const preload = lifecycle.has(path.basename(file, ".test.ts"))
              ? ["--import", "./tests/_setup/imageCallLogLifecycle.ts"]
              : [];
            return node(
              `image-${focused.indexOf(file) + 1}`,
              [...args("tsx/esm", 1), ...preload, file],
              120,
              90,
              covered
            );
          })
        );
        const rejected = results.filter((result) => result.status === "rejected");
        if (rejected.length) throw new AggregateError(rejected.map((result) => result.reason));
      }
      await compactCoverage();
    } else if (lane.startsWith("unit-")) {
      const selected = partitionNativeFiles(buckets, focused, Number(lane.slice(5)), 8);
      fs.writeFileSync(
        path.join(evidence, "executed-files.json"),
        JSON.stringify(selected.flatMap((bucket) => bucket.files)),
        "utf8"
      );
      for (const bucket of selected)
        await nativeFiles(
          bucket.name,
          bucket.files,
          bucket.loader,
          bucket.name === "serial" ? 1 : 2
        );
      await compactCoverage();
    } else if (lane === "static") {
      const isolation = await node(
        "namespace-runtime",
        [
          "scripts/check/image-offline-runtime.mjs",
          String(process.getuid()),
          String(process.getgid()),
          ...["pid", "net", "mnt"].map((name) => fs.readlinkSync(`/proc/self/ns/${name}`)),
        ],
        15,
        10
      );
      assert.equal(isolation.code, 0, "Namespace isolation runtime contract failed");
      await node("discovery", ["scripts/check/check-test-discovery.mjs"], 90, 60);
      await node("architecture", ["scripts/quality/measure-boundary.mjs", "--ratchet"], 90, 60);
      await node("lint", ["scripts/quality/run-eslint-json.mjs"], 900, 120, {
        ESLINT_RESULTS_JSON: path.join(evidence, "eslint-results.json"),
      });
      const formatted = changed.filter(
        (file) =>
          /\.(?:[cm]?[jt]sx?|json|md|ya?ml)$/.test(file) && fs.existsSync(path.join(root, file))
      );
      await node(
        "format",
        ["node_modules/prettier/bin/prettier.cjs", "--check", ...formatted],
        180,
        90
      );
      for (const file of formatted)
        new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(root, file)));
    } else if (lane === "types") {
      await node(
        "core",
        [
          "node_modules/typescript/bin/tsc",
          "--pretty",
          "false",
          "-p",
          "tsconfig.typecheck-core.json",
        ],
        300,
        120
      );
      await node(
        "noimplicit",
        [
          "node_modules/typescript/bin/tsc",
          "--pretty",
          "false",
          "-p",
          "tsconfig.typecheck-noimplicit-core.json",
        ],
        300,
        120
      );
    } else if (lane.startsWith("integration-")) {
      const patterns = ["tests/integration/*.test.ts", "tests/integration/combo-matrix/*.test.ts"];
      await node(
        "integration",
        [...args("tsx/esm", 1), `--test-shard=${lane.at(-1)}/2`, ...patterns],
        900,
        120,
        { DATA_DIR: "", OMNIROUTE_PLUGINS_DIR: "" }
      );
    } else if (lane.startsWith("vitest-")) {
      const config = lane === "vitest-mcp" ? "vitest.mcp.config.ts" : "vitest.config.ts";
      const options = [
        "--config",
        config,
        "--maxWorkers=2",
        "--maxConcurrency=2",
        "--testTimeout=5000",
        "--hookTimeout=10000",
      ];
      const vitest = "node_modules/vitest/vitest.mjs";
      const inventoryPath = path.join(evidence, "vitest-files.json");
      const listing = await node(
        "vitest-discovery",
        [vitest, "list", "--filesOnly", `--json=${inventoryPath}`, ...options],
        90,
        60
      );
      assert.equal(listing.code, 0, "Vitest inventory unavailable");
      const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
      const exclusions = [];
      if (lane === "vitest-ui") {
        const mcpPath = path.join(evidence, "mcp-files.json");
        const mcp = await node(
          "mcp-discovery",
          [vitest, "list", "--filesOnly", `--json=${mcpPath}`, "--config", "vitest.mcp.config.ts"],
          90,
          60
        );
        assert.equal(mcp.code, 0, "MCP inventory unavailable");
        const assigned = new Set(
          JSON.parse(fs.readFileSync(mcpPath, "utf8")).map((item) => path.resolve(item.file))
        );
        for (const item of inventory) {
          if (assigned.has(path.resolve(item.file)))
            exclusions.push("--exclude", path.relative(root, item.file).replaceAll("\\", "/"));
        }
      }
      const excluded = new Set(exclusions.filter((_, index) => index % 2 === 1));
      const executed = inventory
        .map((item) => path.relative(root, item.file).replaceAll("\\", "/"))
        .filter((file) => !excluded.has(file));
      assert.ok(executed.length, "Vitest lane must execute a nonempty inventory");
      fs.writeFileSync(
        path.join(evidence, "executed-files.json"),
        JSON.stringify(executed),
        "utf8"
      );
      await node("vitest", [vitest, "run", ...options, ...exclusions], 1200, 120);
    } else if (lane === "ecosystem" || lane === "protocols") {
      await node(
        lane,
        [
          lane === "ecosystem"
            ? "scripts/dev/run-ecosystem-tests.mjs"
            : "scripts/dev/run-protocol-clients-tests.mjs",
        ],
        900,
        120,
        {
          HOST: "127.0.0.1",
          OMNIROUTE_API_KEY: "",
          OMNIROUTE_E2E_BOOTSTRAP_MODE: "open",
        }
      );
    } else if (lane === "compile-linux") {
      await node("backend-intermediate", ["scripts/build/build-next-isolated.mjs"], 900, 180, {
        NODE_ENV: "production",
        OMNIROUTE_BUILD_BACKEND_ONLY: "1",
        OMNIROUTE_USE_TURBOPACK: "0",
        NEXT_DIST_DIR: ".build/next",
        NODE_OPTIONS: "--max-old-space-size=6144",
      });
    } else if (lane === "compile-windows") {
      assert.equal(process.platform, "win32");
      for (const file of focused.filter((file) =>
        /native-(?:codex|antigravity|image)/.test(file)
      )) {
        await node(
          `windows-${focused.indexOf(file) + 1}`,
          [...args("tsx/esm", 1), file],
          120,
          90,
          { DATA_DIR: "", OMNIROUTE_PLUGINS_DIR: "" },
          false
        );
      }
      const swc = path.join(owned, "swc");
      fs.mkdirSync(swc, { recursive: true });
      await node(
        "windows-native-compiler",
        [
          "-e",
          "require('@swc/core').transformSync('const nativeBinding = 1;', { jsc: { target: 'es2022' } });",
        ],
        60,
        45,
        { SWC_NATIVE_BINDING_CACHE: swc },
        false
      );
      await node(
        "windows-intermediate",
        ["scripts/build/build-next-isolated.mjs"],
        1800,
        600,
        {
          NODE_ENV: "production",
          OMNIROUTE_USE_TURBOPACK: "0",
          NEXT_DIST_DIR: ".build/next",
          OMNIROUTE_BUILD_MEMORY_MB: "6144",
          NODE_OPTIONS: "--max-old-space-size=6144",
          GITHUB_SHA: selection.candidate,
          SWC_NATIVE_BINDING_CACHE: swc,
        },
        false
      );
      await node(
        "windows-artifact-validation",
        [
          "--input-type=module",
          "-e",
          'import { verifyImageArtifact } from "./scripts/check/image-artifact.mjs"; await verifyImageArtifact(process.cwd());',
        ],
        120,
        90,
        {},
        false
      );
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
