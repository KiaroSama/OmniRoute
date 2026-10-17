// Ratchet for the `open-sse → src` boundary (scripts/quality/measure-boundary.mjs).
//
// `quality:boundary` only MEASURED the engine → app coupling. Between 2026-10-10 and
// 2026-10-16 the `open-sse → src` edge count went 745 → 768 with nobody noticing: that
// list is the v4 remediation backlog and it has to stop growing. `--ratchet` now blocks
// when the count exceeds `metrics.boundaryOpenSseToSrc.value` in quality-baseline.json
// (same shape as `check:cycles:ratchet` / `metrics.cycles`).
//
// Every behavioral test runs the real CLI against a synthetic tree (`--root`) and a
// temporary baseline (`--baseline`), so nothing here reads or writes the committed
// config/quality/quality-baseline.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import {
  BOUNDARY_METRIC_KEY,
  evaluateBoundaryRatchet,
  readBaselineBoundaryValue,
} from "../../../scripts/quality/measure-boundary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(ROOT, "scripts/quality/measure-boundary.mjs");
const NOTE = "seeded at the measured value; the ceiling only goes down";

// Two open-sse → src edges (alias + relative), one src → open-sse edge (ignored by the
// ratchet, which only bounds the engine → app direction).
const TREE: Record<string, string> = {
  "open-sse/handlers/chat.ts":
    'import { store } from "@/lib/memory/store";\nexport const x = store;\n',
  "open-sse/services/combo.ts":
    'import { db } from "../../src/lib/db/core";\nexport const y = db;\n',
  "open-sse/utils/logger.ts": "export const log = () => {};\n",
  "src/lib/memory/store.ts":
    'import { log } from "@omniroute/open-sse/utils/logger";\nexport const store = log;\n',
  "src/lib/db/core.ts": "export const db = 1;\n",
};
const MEASURED = 2;

type Spec = { value: number; direction: string; dedicatedGate: boolean; _note?: string };
type Baseline = { _comment?: string; metrics: Record<string, Spec> };

function baselineWith(value?: number): Baseline {
  const metrics: Record<string, Spec> = {
    cycles: { value: 14, direction: "down", dedicatedGate: true },
  };
  if (value !== undefined) {
    metrics[BOUNDARY_METRIC_KEY] = { value, direction: "down", dedicatedGate: true, _note: NOTE };
  }
  return { _comment: "fixture", metrics };
}

function withWorkspace(
  baseline: Baseline | null,
  fn: (ctx: { root: string; baselinePath: string }) => void
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-ratchet-"));
  try {
    const root = path.join(dir, "repo");
    for (const [rel, content] of Object.entries(TREE)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const baselinePath = path.join(dir, "quality-baseline.json");
    if (baseline) fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    fn({ root, baselinePath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function readJson(p: string) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("evaluateBoundaryRatchet: at or below the ceiling passes, above fails, no ceiling is advisory", () => {
  const at = evaluateBoundaryRatchet(768, 768);
  assert.equal(at.status, "ok");
  assert.equal(at.exitCode, 0);
  assert.match(at.message, /RATCHET OK/);
  assert.match(at.message, /768 edges, ceiling 768/);

  assert.equal(evaluateBoundaryRatchet(700, 768).status, "ok");

  const above = evaluateBoundaryRatchet(769, 768);
  assert.equal(above.status, "fail");
  assert.equal(above.exitCode, 1);
  assert.match(above.message, /RATCHET FAIL/);
  assert.match(above.message, /769 edges, ceiling 768/);

  const none = evaluateBoundaryRatchet(769, null);
  assert.equal(none.status, "advisory");
  assert.equal(none.exitCode, 0);
  assert.match(none.message, /advisory/i);
});

test("readBaselineBoundaryValue tolerates a missing file, a missing metric and a non-numeric value", () => {
  withWorkspace(baselineWith(5), ({ baselinePath }) => {
    assert.equal(readBaselineBoundaryValue(baselinePath), 5);
  });
  withWorkspace(baselineWith(), ({ baselinePath }) => {
    assert.equal(readBaselineBoundaryValue(baselinePath), null);
  });
  withWorkspace(null, ({ baselinePath }) => {
    assert.equal(readBaselineBoundaryValue(baselinePath), null);
  });
  const bad = baselineWith(5);
  (bad.metrics[BOUNDARY_METRIC_KEY] as unknown as { value: string }).value = "5";
  withWorkspace(bad, ({ baselinePath }) => {
    assert.equal(readBaselineBoundaryValue(baselinePath), null);
  });
});

test("--ratchet passes when the measured edges equal or stay below the ceiling", () => {
  for (const ceiling of [MEASURED, MEASURED + 3]) {
    withWorkspace(baselineWith(ceiling), ({ root, baselinePath }) => {
      const res = run(["--ratchet", "--root", root, "--baseline", baselinePath]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /\[boundary\] RATCHET OK/);
      assert.match(res.stdout, new RegExp(`${MEASURED} edges, ceiling ${ceiling}`));
    });
  }
});

test("--ratchet fails (exit 1) when open-sse → src edges exceed the ceiling", () => {
  withWorkspace(baselineWith(MEASURED - 1), ({ root, baselinePath }) => {
    const res = run(["--ratchet", "--root", root, "--baseline", baselinePath]);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /\[boundary\] RATCHET FAIL/);
    assert.match(res.stderr, new RegExp(`${MEASURED} edges, ceiling ${MEASURED - 1}`));
    // The failing run must not have touched the baseline.
    assert.equal(readBaselineBoundaryValue(baselinePath), MEASURED - 1);
  });
});

test("--ratchet without a ceiling in the baseline is advisory (exit 0 with a warning)", () => {
  withWorkspace(baselineWith(), ({ root, baselinePath }) => {
    const res = run(["--ratchet", "--root", root, "--baseline", baselinePath]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /\[boundary\] RATCHET ADVISORY/);
    assert.match(res.stderr, new RegExp(`${MEASURED} edges`));
  });
});

test("--update lowers the ceiling to the measured value and keeps the note and the rest of the file", () => {
  withWorkspace(baselineWith(MEASURED + 5), ({ root, baselinePath }) => {
    const res = run(["--update", "--root", root, "--baseline", baselinePath]);
    assert.equal(res.status, 0, res.stderr);
    const after = readJson(baselinePath);
    assert.deepEqual(after.metrics[BOUNDARY_METRIC_KEY], {
      value: MEASURED,
      direction: "down",
      dedicatedGate: true,
      _note: NOTE,
    });
    assert.deepEqual(after.metrics.cycles, { value: 14, direction: "down", dedicatedGate: true });
    assert.equal(after._comment, "fixture");
    assert.ok(fs.readFileSync(baselinePath, "utf8").endsWith("}\n"));
  });
});

test("--update seeds a missing metric as a dedicated down-only gate", () => {
  withWorkspace(baselineWith(), ({ root, baselinePath }) => {
    const res = run(["--update", "--root", root, "--baseline", baselinePath]);
    assert.equal(res.status, 0, res.stderr);
    const spec = readJson(baselinePath).metrics[BOUNDARY_METRIC_KEY];
    assert.equal(spec.value, MEASURED);
    assert.equal(spec.direction, "down");
    assert.equal(spec.dedicatedGate, true);
  });
});

test("--update refuses to RAISE the ceiling (the ratchet only goes down)", () => {
  withWorkspace(baselineWith(MEASURED - 1), ({ root, baselinePath }) => {
    const before = fs.readFileSync(baselinePath, "utf8");
    const res = run(["--update", "--root", root, "--baseline", baselinePath]);
    assert.equal(res.status, 1, res.stdout);
    assert.match(res.stderr, /refus/i);
    assert.equal(fs.readFileSync(baselinePath, "utf8"), before);
  });
});

test("without --ratchet/--update the report is unchanged and nothing is enforced", () => {
  withWorkspace(baselineWith(0), ({ root, baselinePath }) => {
    const md = run(["--root", root, "--baseline", baselinePath]);
    assert.equal(md.status, 0, md.stderr);
    assert.match(md.stdout, /^# src ⇄ open-sse boundary/);
    assert.doesNotMatch(md.stdout + md.stderr, /RATCHET/);

    const json = run(["--json", "--root", root]);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).edges.openSseToSrc, MEASURED);
    assert.equal(readBaselineBoundaryValue(baselinePath), 0);
  });
});

test("the committed baseline declares the boundary ceiling as a dedicated down-only gate", () => {
  const baseline = readJson(path.join(ROOT, "config/quality/quality-baseline.json"));
  const spec = baseline.metrics[BOUNDARY_METRIC_KEY];
  assert.ok(spec, `quality-baseline.json must declare metrics.${BOUNDARY_METRIC_KEY}`);
  assert.equal(typeof spec.value, "number");
  assert.ok(spec.value > 0);
  assert.equal(spec.direction, "down");
  // dedicatedGate keeps check-quality-ratchet.mjs from expecting it in quality-metrics.json.
  assert.equal(spec.dedicatedGate, true);
  assert.equal(typeof spec._note, "string");
});

test("package.json exposes check:boundary (+ :ratchet) and keeps quality:boundary", () => {
  const { scripts } = readJson(path.join(ROOT, "package.json"));
  assert.equal(scripts["check:boundary"], "node scripts/quality/measure-boundary.mjs");
  assert.equal(
    scripts["check:boundary:ratchet"],
    "node scripts/quality/measure-boundary.mjs --ratchet"
  );
  assert.equal(scripts["quality:boundary"], "node scripts/quality/measure-boundary.mjs");
});

type Step = { run?: string; [key: string]: unknown };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

function loadWorkflow(name: string): Workflow {
  return yaml.load(fs.readFileSync(path.join(ROOT, ".github/workflows", name), "utf8")) as Workflow;
}

test("ci.yml lint job runs the blocking boundary ratchet", () => {
  const steps = loadWorkflow("ci.yml").jobs.lint.steps;
  const runs = steps.map((s) => (s.run ?? "").trim());
  assert.ok(
    runs.includes("npm run check:boundary:ratchet"),
    "lint must run check:boundary:ratchet"
  );
  assert.ok(
    runs.indexOf("npm run check:boundary:ratchet") > runs.indexOf("npm run check:cycles:ratchet"),
    "boundary ratchet sits next to the cycles ratchet"
  );
});

test("quality.yml fast-gates lists boundary among the --ratchet gates", () => {
  const steps = loadWorkflow("quality.yml").jobs["fast-gates"].steps;
  const script = steps.map((s) => s.run ?? "").find((r) => r.includes("ratchet_gates=("));
  assert.ok(script, "fast-gates must keep the ratchet_gates loop");
  const body = /ratchet_gates=\(([^)]*)\)/.exec(script)![1];
  const gates = body
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(gates.includes("boundary"), `ratchet_gates = ${gates.join(" ")}`);
  assert.ok(gates.includes("cycles"));
  // The loop calls `npm run check:$g -- --ratchet`, so check:boundary must forward it.
  assert.match(script, /npm run "check:\$g" -- --ratchet/);
});
