/**
 * Which bundler CI uses when it compiles the app (16/10/2026).
 *
 * A Turbopack production build of this tree needs more memory than our runners can give it.
 * Measured alone on the 32-vCPU/47 GB .113 (cgroup cap, swap off) on 2026-10-16: Next
 * 16.3.5, 16.3.6 and 16.3.8 all peak at 33-37 GB (the Rust compile ~21 GB plus 31
 * static-generation workers at 17-21 GB) and finish in ~25 min; 16.4.2 needs more than
 * 36 GB in the compile phase alone and is OOM-killed, with or without the FS build cache,
 * the Rust React Compiler, or a 4-CPU pin. Next to the three omni-light runners the .113
 * cannot spare 36 GB, so every Build there died since 2026-10-06 (~200 red runs, each
 * swap-thrashing the box for 17-90 min), and the backend-only nightlies (dashboard stubbed)
 * hit the same wall: garak/promptfoo/schemathesis/a11y have not been green since 10-13.
 * The same tree builds with webpack in 14 GB.
 *
 * So every CI step that compiles the app runs webpack (`OMNIROUTE_USE_TURBOPACK: "0"`,
 * the escape hatch documented in docs/reference/ENVIRONMENT.md): the four nightly
 * `build:cli` steps and the ci.yml `Build` job, whose self-hosted branch used to opt into
 * Turbopack. Flip a step back to "1" only with a measurement showing it fits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = path.join(repoRoot, ".github/workflows");

type Step = { name?: string; run?: string; env?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function readWorkflow(name: string): Workflow {
  return load(fs.readFileSync(path.join(workflowDir, name), "utf8")) as Workflow;
}

/** Every step of `name` whose `run` matches `pattern`, tagged "file:job:step". */
function buildSteps(name: string, pattern: RegExp): Array<{ id: string; step: Step }> {
  const out: Array<{ id: string; step: Step }> = [];
  for (const [job, def] of Object.entries(readWorkflow(name).jobs ?? {})) {
    (def.steps ?? []).forEach((step, i) => {
      if (typeof step.run === "string" && pattern.test(step.run)) {
        out.push({ id: `${name}:${job}:${step.name ?? `#${i + 1}`}`, step });
      }
    });
  }
  return out;
}

const NIGHTLIES = [
  "nightly-llm-security.yml",
  "nightly-resilience.yml",
  "nightly-schemathesis.yml",
];

test("the nightly backend-only builds compile with webpack", () => {
  const steps = NIGHTLIES.flatMap((wf) => buildSteps(wf, /npm run build:cli/));
  assert.equal(steps.length, 4, "promptfoo-guard, garak, k6-soak and schemathesis each build once");
  const onTurbopack = steps
    .filter(({ step }) => String(step.env?.OMNIROUTE_USE_TURBOPACK) !== "0")
    .map(({ id }) => id);
  assert.deepEqual(onTurbopack, [], "these steps would run the Turbopack build that OOMs the .113");
});

test("the ci.yml Build job no longer opts into Turbopack on the self-hosted runner", () => {
  const [build] = buildSteps("ci.yml", /^npm run build$/m);
  assert.ok(build, "ci.yml build job runs `npm run build`");
  assert.equal(String(build.step.env?.OMNIROUTE_USE_TURBOPACK), "0");
});
