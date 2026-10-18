import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export async function mergeImageCoverage({
  root,
  evidenceRoot,
  output,
  selection,
  buckets,
  focused,
}) {
  const require = createRequire(path.join(root, "package.json"));
  const { createCoverageMap } = require("istanbul-lib-coverage");
  const { createContext } = require("istanbul-lib-report");
  const reports = require("istanbul-reports");
  const lanes = [
    "image",
    "static",
    "types",
    ...Array.from({ length: 8 }, (_, index) => `unit-${index + 1}`),
    "integration-1",
    "integration-2",
    "vitest-mcp",
    "vitest-ui",
    "ecosystem",
    "protocols",
    "compile-linux",
    "compile-windows",
  ];
  const coverage = createCoverageMap({});
  const nativeFiles = [];
  const vitestFiles = [];
  let mcpFiles, uiFiles;
  for (const lane of lanes) {
    const directory = path.join(evidenceRoot, `image-validation-${lane}`);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"), "utf8"));
    assert.equal(receipt.candidate, selection.candidate, `${lane} candidate mismatch`);
    assert.equal(receipt.workflow, selection.workflow, `${lane} workflow mismatch`);
    assert.equal(receipt.failed, false, `${lane} failed; partial results cannot pass acceptance`);
    assert.equal(receipt.cancelled, false, `${lane} was cancelled`);
    assert.ok(
      receipt.receipts.length > 0 && receipt.receipts.every((item) => item.outcome === "PASS"),
      `${lane} incomplete`
    );
    const cleanup = JSON.parse(fs.readFileSync(path.join(directory, "cleanup.json"), "utf8"));
    assert.equal(cleanup.clean, true, `${lane} cleanup unverified`);
    if (lane === "image" || lane.startsWith("unit-")) {
      nativeFiles.push(
        ...JSON.parse(fs.readFileSync(path.join(directory, "executed-files.json"), "utf8"))
      );
      const input = JSON.parse(
        fs.readFileSync(path.join(directory, "coverage/coverage-final.json"), "utf8")
      );
      const normalized = {};
      for (const entry of Object.values(input)) {
        const relative = path.relative(receipt.root, entry.path);
        assert.ok(
          relative && !relative.startsWith("..") && !path.isAbsolute(relative),
          "Coverage escaped source root"
        );
        const destination = path.join(root, relative);
        normalized[destination] = { ...entry, path: destination };
      }
      coverage.merge(normalized);
    }
    if (lane.startsWith("vitest-")) {
      const executed = JSON.parse(
        fs.readFileSync(path.join(directory, "executed-files.json"), "utf8")
      );
      vitestFiles.push(...executed);
      const listed = JSON.parse(
        fs.readFileSync(path.join(directory, "vitest-files.json"), "utf8")
      ).map((item) => path.relative(receipt.root, item.file).replaceAll("\\", "/"));
      if (lane === "vitest-mcp") mcpFiles = listed;
      else uiFiles = listed;
    }
  }
  assert.equal(nativeFiles.length, new Set(nativeFiles).size, "Native suite executed twice");
  assert.deepEqual(
    nativeFiles.sort(),
    buckets.flatMap((bucket) => bucket.files).sort(),
    "Canonical native inventory incomplete"
  );
  for (const file of focused)
    assert.ok(nativeFiles.includes(file), `Missing image regression: ${file}`);
  assert.equal(vitestFiles.length, new Set(vitestFiles).size, "Vitest suite executed twice");
  assert.deepEqual(
    vitestFiles.sort(),
    [...new Set([...mcpFiles, ...uiFiles])].sort(),
    "Vitest discovery lost a suite"
  );
  fs.mkdirSync(output, { recursive: true });
  const context = createContext({ dir: output, coverageMap: coverage });
  for (const name of ["json-summary", "lcovonly"]) reports.create(name).execute(context);
  const summary = coverage.getCoverageSummary().toJSON();
  for (const metric of ["statements", "lines", "functions", "branches"]) {
    assert.ok(
      summary[metric].total > 0 && summary[metric].pct >= 60,
      `${metric} below required60percent: ${summary[metric].pct}`
    );
  }
  fs.writeFileSync(
    path.join(output, "inventory.json"),
    JSON.stringify({
      candidate: selection.candidate,
      workflow: selection.workflow,
      lanes,
      nativeCount: nativeFiles.length,
      vitestCount: vitestFiles.length,
      summary,
    }),
    "utf8"
  );
  console.log(
    `PASS: ${nativeFiles.length} native files and ${vitestFiles.length} Vitest files accounted for; merged coverage floor verified`
  );
}
