import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
);

test("unrelated candidate builds cannot replace each other's pending concurrency slot", () => {
  assert.equal(
    workflow.jobs.build.concurrency.group,
    "heavy-build-${{ github.ref == 'refs/heads/main' && 'main' || github.ref }}"
  );
  assert.equal(workflow.jobs.build.concurrency["cancel-in-progress"], false);
});

test("superseded runs cancel only within the same workflow/ref", () => {
  assert.equal(workflow.concurrency.group, "${{ github.workflow }}-${{ github.ref }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});

test("runner isolation still blocks fork code from the self-hosted build slot", () => {
  assert.match(
    workflow.jobs.build["runs-on"],
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
  );
  assert.match(workflow.jobs.build["runs-on"], /\["self-hosted","omni-build"\]/);
  assert.match(workflow.jobs.build["runs-on"], /\|\| 'ubuntu-latest'/);
});

test("the Build job compiles with webpack on every runner", () => {
  // Turbopack no longer fits the .113: measured alone on 2026-10-16 (32 vCPUs, cgroup cap,
  // swap off) the build peaks at 33-37 GB on Next 16.3.5/16.3.6/16.3.8 - more than the
  // 47 GB box can spare next to the other runners - and 16.4.2 needs over 36 GB in the
  // compile phase alone; webpack builds the same tree in 14 GB.
  // See tests/unit/ci-build-bundler-webpack.test.ts.
  const step = workflow.jobs.build.steps.find(
    (item: { run?: string }) => item.run === "npm run build"
  );
  assert.equal(String(step.env.OMNIROUTE_USE_TURBOPACK), "0");
});
